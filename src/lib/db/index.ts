import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

/**
 * PostgreSQL access for both the web app and the background worker.
 *
 * Type parsers are pinned so rows keep the shapes the rest of the codebase
 * already expects: timestamps arrive as ISO strings (they are passed straight
 * to `Date.parse`, `.slice(0, 10)` and `String(...)` in the UI) and bigint
 * counts arrive as numbers.
 */

const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;
const INT8 = 20;

// Postgres writes offsets as `+00`, which `new Date()` rejects, so the driver's
// own date parser does the parsing and we only reformat its result.
function isoParser(oid: number, assumeUtc: boolean): (v: string) => string {
  const parse = types.getTypeParser(oid) as (v: string) => unknown;
  return (value: string) => {
    if (value === null) return value;
    const parsed = parse(assumeUtc ? `${value}+00` : value);
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : value;
  };
}

// `timestamp without time zone` would otherwise be read as local time; this
// schema only ever stores UTC.
types.setTypeParser(TIMESTAMP, isoParser(TIMESTAMPTZ, true));
types.setTypeParser(TIMESTAMPTZ, isoParser(TIMESTAMPTZ, false));
types.setTypeParser(INT8, (v) => (v === null ? null : Number(v)) as unknown as string);

function makePool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }
  // The worker runs long jobs with its own concurrency, the web app serves many
  // short requests; each process sizes its pool separately.
  const max = Number(process.env.DATABASE_POOL_MAX ?? (process.env.VOICELENS_ROLE === "worker" ? 8 : 10));
  return new Pool({
    connectionString,
    max: Number.isFinite(max) && max > 0 ? max : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed Postgres (Aliyun RDS/PolarDB, Supabase, RDS) terminates plaintext
    // connections; `?sslmode=require` in the URL turns this on.
    ...(/[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)
      ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === "true" } }
      : {}),
  });
}

// Next.js reloads modules in dev; without a global the pool would leak a new
// set of connections on every edit.
const globalForPool = globalThis as unknown as { __voicelensPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.__voicelensPool) {
    globalForPool.__voicelensPool = makePool();
    globalForPool.__voicelensPool.on("error", (err) => {
      console.error("[db] idle client error", err.message);
    });
  }
  return globalForPool.__voicelensPool;
}

export type Executor = Pool | PoolClient;

/** Run a parameterized statement and return every row. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  exec: Executor = pool(),
): Promise<T[]> {
  const res = await exec.query<T>(text, params as never[]);
  return res.rows;
}

/** First row, or null when the statement matched nothing. */
export async function maybeOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  exec: Executor = pool(),
): Promise<T | null> {
  const rows = await query<T>(text, params, exec);
  return rows[0] ?? null;
}

/** First row, throwing when the statement matched nothing. */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  exec: Executor = pool(),
): Promise<T> {
  const row = await maybeOne<T>(text, params, exec);
  if (!row) throw new Error("expected exactly one row, got none");
  return row;
}

/** Single scalar from the first row and first column. */
export async function scalar<T>(
  text: string,
  params: unknown[] = [],
  exec: Executor = pool(),
): Promise<T | null> {
  const rows = await query(text, params, exec);
  if (!rows.length) return null;
  const first = rows[0] as Record<string, unknown>;
  const key = Object.keys(first)[0];
  return (first[key] ?? null) as T | null;
}

/** Row count for a `count(*)` style statement. */
export async function count(text: string, params: unknown[] = [], exec: Executor = pool()): Promise<number> {
  const n = await scalar<number | string>(text, params, exec);
  return Number(n ?? 0);
}

/** Number of rows the statement affected. */
export async function execute(text: string, params: unknown[] = [], exec: Executor = pool()): Promise<number> {
  const res = await exec.query(text, params as never[]);
  return res.rowCount ?? 0;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is already broken; releasing it is all we can do.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Call one of the schema's helper functions and return its jsonb payload. */
export async function callJson<T>(fn: string, params: unknown[], exec: Executor = pool()): Promise<T | null> {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  return (await scalar<T>(`select ${fn}(${placeholders}) as value`, params, exec)) ?? null;
}

export async function closePool(): Promise<void> {
  const existing = globalForPool.__voicelensPool;
  if (!existing) return;
  globalForPool.__voicelensPool = undefined;
  await existing.end();
}
