/**
 * Regression test for the role/ownership rules.
 *
 * Run against a SCRATCH database — it writes and then deletes fixture rows, so
 * it refuses to touch the one in DATABASE_URL:
 *
 *   ACCESS_TEST_DATABASE_URL=postgresql://... npx tsx scripts/test-access.ts
 *
 * The database must already have the migrations applied.
 */
process.env.DATABASE_URL = process.env.ACCESS_TEST_DATABASE_URL ?? "";
if (!process.env.DATABASE_URL) {
  console.error(
    "ACCESS_TEST_DATABASE_URL is not set.\n" +
      "This test writes fixture rows, so point it at a scratch database — never a real one.",
  );
  process.exit(1);
}

import { closePool, execute, maybeOne, one, query } from "../src/lib/db";
import { getDataSource, listDataSources, listTasks, listWorkflows } from "../src/lib/queries";
import { canAccessSource, resolveAudioSource, resolveOwnedRow, type Viewer } from "../src/lib/auth/access";
import { asRole, assignableRoles, canAssignRole, type Role } from "../src/lib/auth/roles";

// Everything this test creates carries the tag, and only tagged rows are removed.
const TAG = "acl-test-" + process.pid;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === e) return console.log(`PASS  ${label}`);
  failures++;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

const viewer = (userId: string, viewAll: boolean): Viewer =>
  ({ userId, viewAll, role: viewAll ? "admin" : "member" }) as Viewer;

async function seedUser(name: string, role: Role) {
  return one<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`,
    [`${name}.${TAG}@example.invalid`, role],
  );
}

async function seedSource(name: string, createdBy: string | null) {
  return one<{ id: string }>(
    `insert into data_sources (name, created_by) values ($1, $2) returning id`,
    [`${TAG}/${name}`, createdBy],
  );
}

async function cleanup() {
  // Sessions, messages, workflows and tasks cascade from the data source.
  await execute(`delete from data_sources where name like $1`, [`${TAG}/%`]);
  await execute(`delete from users where email like $1`, [`%.${TAG}@example.invalid`]);
}

async function main() {
  // The single-owner index only bites when an owner exists; a scratch database
  // may have none, so supply one (tagged, so cleanup takes it away again).
  if (!(await maybeOne<{ id: string }>(`select id from users where role = 'owner'`))) {
    await seedUser("owner", "owner");
  }

  const alice = viewer((await seedUser("alice", "member")).id, false);
  const bob = viewer((await seedUser("bob", "member")).id, false);
  const admin = viewer((await seedUser("carol", "admin")).id, true);

  const aliceSource = (await seedSource("alice-source", alice.userId)).id;
  const bobSource = (await seedSource("bob-source", bob.userId)).id;
  // A source whose creator was deleted: created_by is null (on delete set null).
  const orphan = (await seedSource("orphan", null)).id;

  const aliceTask = await one<{ id: string }>(
    `insert into analysis_tasks (data_source_id, name) values ($1, $2) returning id`,
    [aliceSource, `${TAG}/alice-task`],
  );
  await execute(`insert into analysis_tasks (data_source_id, name) values ($1, $2)`, [
    bobSource,
    `${TAG}/bob-task`,
  ]);
  const aliceWorkflow = await one<{ id: string }>(
    `insert into workflows (data_source_id, name) values ($1, $2) returning id`,
    [aliceSource, `${TAG}/alice-workflow`],
  );

  const session = await one<{ id: string }>(
    `insert into sessions (data_source_id, session_key) values ($1, $2) returning id`,
    [aliceSource, `${TAG}-session`],
  );
  const audioPath = `${TAG}/alice/one.wav`;
  await execute(
    `insert into messages (data_source_id, session_id, seq, role, content, audio_path)
     values ($1, $2, 1, 'user', '"hi"'::jsonb, $3)`,
    [aliceSource, session.id, audioPath],
  );

  // Only this test's rows, so a shared scratch database stays readable.
  const mine = (rows: { name: string }[]) =>
    rows
      .map((r) => r.name)
      .filter((n) => n.startsWith(`${TAG}/`))
      .map((n) => n.slice(TAG.length + 1))
      .sort();

  console.log("\n-- list scoping: a member sees only what they created --");
  check("alice's sources", mine(await listDataSources(alice.userId)), ["alice-source"]);
  check("bob's sources", mine(await listDataSources(bob.userId)), ["bob-source"]);
  check("admin's sources (unscoped)", mine(await listDataSources(null)), [
    "alice-source",
    "bob-source",
    "orphan",
  ]);
  check("alice's tasks", mine(await listTasks(alice.userId, 200)), ["alice-task"]);
  check("admin's tasks", mine(await listTasks(null, 200)), ["alice-task", "bob-task"]);
  check("alice's workflows", mine(await listWorkflows(alice.userId)), ["alice-workflow"]);
  check("bob sees none of alice's workflows", mine(await listWorkflows(bob.userId)), []);

  console.log("\n-- getDataSource --");
  check("bob reads his own", Boolean(await getDataSource(bobSource, bob.userId)), true);
  check("alice cannot read bob's", await getDataSource(bobSource, alice.userId), null);
  check("admin reads bob's", Boolean(await getDataSource(bobSource, null)), true);

  console.log("\n-- canAccessSource --");
  check("the creator", await canAccessSource(alice, aliceSource), true);
  check("another member", await canAccessSource(bob, aliceSource), false);
  check("an admin", await canAccessSource(admin, aliceSource), true);
  check("an orphaned source is admin-only", await canAccessSource(alice, orphan), false);
  check("an admin reaches the orphan", await canAccessSource(admin, orphan), true);
  check("an id that does not exist", await canAccessSource(admin, NIL_UUID), false);

  console.log("\n-- resolveOwnedRow: a child row is reachable only through its source --");
  check("alice resolves her task", await resolveOwnedRow(alice, "analysis_tasks", aliceTask.id), aliceSource);
  check("bob cannot resolve it", await resolveOwnedRow(bob, "analysis_tasks", aliceTask.id), null);
  check("the admin can", await resolveOwnedRow(admin, "analysis_tasks", aliceTask.id), aliceSource);
  check("bob cannot resolve her workflow", await resolveOwnedRow(bob, "workflows", aliceWorkflow.id), null);
  check("a missing id yields null, not a throw", await resolveOwnedRow(admin, "analysis_tasks", NIL_UUID), null);

  console.log("\n-- resolveAudioSource: what guards /api/audio --");
  check("alice may be signed her own audio", await resolveAudioSource(alice, audioPath), aliceSource);
  check("bob may not, even holding the exact path", await resolveAudioSource(bob, audioPath), null);
  check("the admin may", await resolveAudioSource(admin, audioPath), aliceSource);
  check("a path no message stores is refused", await resolveAudioSource(admin, `${TAG}/../secrets`), null);

  console.log("\n-- role assignment --");
  const owner = { id: "o", role: asRole("owner") };
  const adminActor = { id: "a", role: asRole("admin") };
  const memberActor = { id: "m", role: asRole("member") };
  check("owner hands out admin/member/none", assignableRoles("owner"), ["admin", "member", "none"]);
  check("admin hands out member/none", assignableRoles("admin"), ["member", "none"]);
  check("member hands out nothing", assignableRoles("member"), []);
  check("owner promotes a member to admin", canAssignRole(owner, { id: "m", role: "member" }, "admin"), true);
  check("admin cannot promote to admin", canAssignRole(adminActor, { id: "m", role: "member" }, "admin"), false);
  check("admin activates a none", canAssignRole(adminActor, { id: "n", role: "none" }, "member"), true);
  check("admin cannot demote a peer", canAssignRole(adminActor, { id: "a2", role: "admin" }, "member"), false);
  check("owner can demote an admin", canAssignRole(owner, { id: "a2", role: "admin" }, "member"), true);
  check("the owner is untouchable", canAssignRole(adminActor, { id: "o", role: "owner" }, "member"), false);
  check("ownership is not transferable", canAssignRole(owner, { id: "m", role: "member" }, "owner"), false);
  check("nobody changes their own role", canAssignRole(adminActor, { id: "a", role: "admin" }, "member"), false);
  check("a member assigns nothing", canAssignRole(memberActor, { id: "n", role: "none" }, "member"), false);
  check("an unknown role degrades to none", asRole("superadmin"), "none");

  console.log("\n-- database constraints --");
  const rejects = async (label: string, sql: string, params: unknown[]) => {
    try {
      await query(sql, params);
      check(label, "accepted", "rejected");
    } catch {
      check(label, "rejected", "rejected");
    }
  };
  await rejects("a second owner is rejected", `update users set role = 'owner' where id = $1`, [
    alice.userId,
  ]);
  await rejects("an unknown role is rejected", `update users set role = 'superadmin' where id = $1`, [
    alice.userId,
  ]);
  const fresh = await one<{ role: string }>(
    `insert into users (email, password_hash) values ($1, 'x') returning role`,
    [`fresh.${TAG}@example.invalid`],
  );
  check("a new account defaults to no access", fresh.role, "none");
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup failed:", e));
    await closePool();
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  });
