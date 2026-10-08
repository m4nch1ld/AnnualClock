/**
 * Database access. Plain `pg`, portable to any PostgreSQL (Supabase, Azure).
 *
 * - withUser(): runs as the `authenticated` role with the user's id in the
 *   JWT-claim setting, so Row Level Security is enforced exactly as tested.
 * - withService(): trusted server code (scheduler, token endpoints, super-admin
 *   operations). Bypasses RLS — callers must authorize first.
 */
import pg from "pg";

export type Row = Record<string, unknown>;
export interface Tx {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

// Return DATE columns as 'YYYY-MM-DD' strings, never JS Dates (avoids TZ shifts).
pg.types.setTypeParser(1082, (v: string) => v);
// TIMESTAMPTZ as ISO-8601 strings (serialisable to client components unchanged).
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());

const globalForPool = globalThis as unknown as { __eslPool?: pg.Pool };

function pool(): pg.Pool {
  if (!globalForPool.__eslPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPool.__eslPool = new pg.Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
    });
  }
  return globalForPool.__eslPool;
}

function wrap(client: pg.PoolClient): Tx {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await client.query(sql, params as unknown[])).rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      return (await client.query(sql, params as unknown[])).rows[0] as T | undefined;
    },
  };
}

async function inTransaction<T>(setup: (c: pg.PoolClient) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await setup(client);
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async (c) => {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  }, fn);
}

export function withService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async () => {}, fn);
}

export async function closePool() {
  await globalForPool.__eslPool?.end();
  globalForPool.__eslPool = undefined;
}
