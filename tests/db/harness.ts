import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Boots an in-process Postgres (PGlite), applies supabase/bootstrap/plain-postgres.sql
 * (the same bootstrap used on Azure) and every migration in supabase/migrations.
 * Lets RLS tests run without Docker or a hosted project.
 */
export async function createTestDb() {
  const db = new PGlite();
  // Same bootstrap the Azure / plain-Postgres deployment uses (roles, auth.uid(), default grants).
  await db.exec(readFileSync(join(process.cwd(), "supabase", "bootstrap", "plain-postgres.sql"), "utf8"));
  // Test-only: the service role bypasses RLS like Supabase's.
  await db.exec("alter role service_role bypassrls");
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
