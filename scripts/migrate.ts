/**
 * Minimal, portable migration runner: applies supabase/migrations/*.sql in
 * filename order against DATABASE_URL, each in its own transaction, tracked in
 * public.schema_migrations. Works the same against Azure Database for PostgreSQL.
 * (`supabase db push` is an equivalent alternative on Supabase.)
 */
import "./load-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`create table if not exists public.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    await client.query(`alter table public.schema_migrations enable row level security`);
    const applied = new Set(
      (await client.query<{ name: string }>(`select name from public.schema_migrations`)).rows.map((r) => r.name),
    );
    const dir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      process.stdout.write(`applying ${file} ... `);
      await client.query("begin");
      try {
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query(`insert into public.schema_migrations (name) values ($1)`, [file]);
        await client.query("commit");
        console.log("ok");
        count++;
      } catch (e) {
        await client.query("rollback");
        console.log("FAILED");
        throw e;
      }
    }
    console.log(count ? `${count} migration(s) applied` : "database is up to date");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
