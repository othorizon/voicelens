/**
 * Migration runner. Applies every db/migrations/*.sql file that this database
 * has not seen yet, in filename order, each inside its own transaction.
 *
 * Run: npm run db:migrate            (reads DATABASE_URL from .env.local)
 *      npm run db:migrate -- --dry   (list what would run, change nothing)
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "migrations");

async function main() {
  const dry = process.argv.includes("--dry");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (!files.length) {
    console.log("no migrations found");
    return;
  }

  const client = new Client({
    connectionString,
    ...(/[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)
      ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === "true" } }
      : {}),
  });
  await client.connect();

  try {
    await client.query(`
      create table if not exists _migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from _migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    let ran = 0;
    for (const name of files) {
      const sql = readFileSync(join(MIGRATIONS, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      const previous = applied.get(name);

      if (previous) {
        if (previous !== checksum) {
          // Editing an applied migration silently desyncs environments; a new
          // file is always the right fix.
          throw new Error(
            `${name} was already applied but its contents changed (${previous} -> ${checksum}). ` +
              `Add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      if (dry) {
        console.log(`would apply ${name}`);
        ran++;
        continue;
      }

      console.log(`applying ${name} ...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into _migrations (name, checksum) values ($1, $2)", [name, checksum]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`${name} failed: ${(err as Error).message}`);
      }
      ran++;
    }

    console.log(ran ? `${dry ? "pending" : "applied"}: ${ran} migration(s)` : "database is up to date");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
