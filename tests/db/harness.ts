/**
 * SQL Server test harness. Needs a real SQL Server 2022+ / Azure SQL:
 *   TEST_DATABASE_URL="Server=localhost,1433;Database=master;User Id=sa;Password=...;Encrypt=true;TrustServerCertificate=true"
 * CI starts one as a service container (.github/workflows/ci.yml). Without TEST_DATABASE_URL
 * the database suites are skipped (in-process substitutes cannot prove SQL Server RLS).
 *
 * Each run creates a throwaway database, applies database/migrations with the real runner,
 * and points lib/db at it — so tests exercise exactly the code path the app uses.
 */
import sql from "mssql";

export const TEST_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = !!TEST_URL;

let dbName: string | undefined;

export async function setupTestDb() {
  if (!TEST_URL) throw new Error("TEST_DATABASE_URL not set");
  dbName = `annual_clock_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const master = await new sql.ConnectionPool(TEST_URL).connect();
  await master.request().batch(`CREATE DATABASE [${dbName}]`);
  await master.close();
  const url = /Database=[^;]*/i.test(TEST_URL) ? TEST_URL.replace(/Database=[^;]*/i, `Database=${dbName}`) : `${TEST_URL};Database=${dbName}`;
  process.env.DATABASE_URL = url;
  delete process.env.DATABASE_SCHEMA; // default schema: annual_clock
  const { migrate } = await import("../../scripts/migrate");
  await migrate(url, () => {});
  return await import("../../lib/db");
}

export async function teardownTestDb() {
  const db = await import("../../lib/db");
  await db.closePool();
  if (!TEST_URL || !dbName) return;
  const master = await new sql.ConnectionPool(TEST_URL).connect();
  await master.request().batch(`ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${dbName}];`);
  await master.close();
}
