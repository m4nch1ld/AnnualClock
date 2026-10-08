import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Boots an in-process Postgres (PGlite) with a minimal Supabase-compatible
 * shim (roles + auth.uid()) and applies every migration in supabase/migrations.
 * Lets RLS tests run without Docker or a hosted project.
 */
export async function createTestDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

/** Run `fn` as the given user (or anon when userId is null) inside a transaction. */
export async function asUser<T>(
  db: PGlite,
  userId: string | null,
  fn: (q: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${userId ? "authenticated" : "anon"}`);
    if (userId) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    return fn(async (sql, params) => (await tx.query(sql, params)).rows as never);
  });
}
