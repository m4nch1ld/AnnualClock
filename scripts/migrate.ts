/**
 * Portable migration runner for Azure SQL Database / SQL Server.
 * Applies database/migrations/*.sql in filename order, each file in its own transaction,
 * tracked in <schema>.schema_migrations. Files are split into batches on lines containing
 * only `GO` (like sqlcmd) and `$(SCHEMA)` is replaced with DATABASE_SCHEMA (default annual_clock).
 *
 * Connection: DATABASE_MIGRATION_URL, else DATABASE_URL, else DATABASE_HOST + DATABASE_NAME with Entra auth.
 */
import "./load-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sql from "mssql";
import { SCHEMA, connectionConfig } from "../lib/db";

/** True when every non-empty line is a `--` comment (such batches are skipped). */
const isCommentOnly = (batch: string) =>
  batch.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("--"));

/**
 * Split a migration file into batches on `GO` lines and substitute $(SCHEMA).
 * Line-based on purpose: an earlier regex backtracked exponentially on comment lines
 * full of dashes ("-- -----") and froze the runner.
 */
export function splitBatches(text: string, schema: string = SCHEMA): string[] {
  return text
    .replace(/\$\(SCHEMA\)/g, schema)
    .split(/^[ \t]*GO[ \t]*;?[ \t]*$/im)
    .map((b) => b.trim())
    .filter((b) => b && !isCommentOnly(b));
}

export async function migrate(config: string | sql.config = process.env.DATABASE_MIGRATION_URL || connectionConfig(), log = console.log) {
  const pool = await new sql.ConnectionPool(config as sql.config).connect();
  try {
    await pool.request().batch(`
      IF SCHEMA_ID(N'${SCHEMA}') IS NULL EXEC(N'CREATE SCHEMA [${SCHEMA}]');
      IF OBJECT_ID(N'[${SCHEMA}].schema_migrations') IS NULL
        CREATE TABLE [${SCHEMA}].schema_migrations (name nvarchar(200) NOT NULL PRIMARY KEY, applied_at datetimeoffset(3) NOT NULL DEFAULT sysdatetimeoffset());`);
    const applied = new Set(
      (await pool.request().query<{ name: string }>(`SELECT name FROM [${SCHEMA}].schema_migrations`)).recordset.map((r) => r.name),
    );
    const dir = join(process.cwd(), "database", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const t = new sql.Transaction(pool);
      await t.begin();
      try {
        // data migrations run as trusted service code (RLS allows app_service = 1)
        await new sql.Request(t).batch(`EXEC sp_set_session_context N'app_service', 1;`);
        for (const batch of splitBatches(readFileSync(join(dir, file), "utf8"))) await new sql.Request(t).batch(batch);
        await new sql.Request(t).input("n", sql.NVarChar(200), file).query(`INSERT INTO [${SCHEMA}].schema_migrations (name) VALUES (@n)`);
        await t.commit();
        log(`applied ${file}`);
        count++;
      } catch (e) {
        await t.rollback().catch(() => {});
        log(`FAILED ${file}`);
        throw e;
      }
    }
    log(count ? `${count} migration(s) applied to schema ${SCHEMA}` : `schema ${SCHEMA} is up to date`);
  } finally {
    await pool.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/migrate.ts")) {
  migrate().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
