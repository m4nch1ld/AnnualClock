/**
 * Database access — Azure SQL Database / SQL Server 2022+ via `mssql` (tedious).
 *
 * - withUser(userId): loads the user's flags and clock roles and puts them in the
 *   connection's SESSION_CONTEXT, so Row-Level Security (database/migrations/0002_security.sql)
 *   enforces every rule — exactly as tested in tests/db/rls.test.ts.
 * - withService(): trusted server code (scheduler, token endpoints, super-admin operations).
 *   Sets app_service = 1, which the RLS predicates allow. Callers must authorize first.
 *
 * Query API: positional parameters `$1, $2, …` (converted to @p1…). Arrays/objects are sent as
 * JSON strings — read lists in SQL with `(select value from openjson($1))`.
 * Results are normalised: uniqueidentifier → lowercase string, date → 'YYYY-MM-DD',
 * datetimeoffset → ISO string, time → 'HH:MM', JSON columns (JSON_COLUMNS) → parsed.
 * One transaction = one connection: never run queries on the same tx in parallel.
 * Tables with triggers cannot use OUTPUT without INTO — use rowsAffected / app-generated ids.
 */
import sql from "mssql";

export type Row = Record<string, unknown>;
export interface Tx {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(text: string, params?: unknown[]): Promise<T | undefined>;
  /** Run a statement and return the number of affected rows (last statement). */
  exec(text: string, params?: unknown[]): Promise<number>;
}

/** The app's schema (shared database: every object lives in it). */
export const SCHEMA = (() => {
  const s = process.env.DATABASE_SCHEMA || "annual_clock";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s)) throw new Error(`Invalid DATABASE_SCHEMA: ${s}`);
  return s;
})();
/** Quoted schema prefix for SQL text: `${S}.clocks` */
export const S = `[${SCHEMA}]`;

/** Columns stored as JSON text; parsed on read. Writing arrays/objects is automatic. */
export const JSON_COLUMNS = new Set([
  "links",
  "escalation_config",
  "diff",
  "payload",
  "stats",
  "tags",
  "reminder_offsets",
  "default_reminder_offsets",
  "channels",
  "assignee_ids",
]);

export function connectionConfig(): sql.config | string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL; // ADO.NET style: Server=…;Database=…;User Id=…;Password=…;Encrypt=true
  const server = process.env.DATABASE_HOST;
  const database = process.env.DATABASE_NAME;
  if (!server || !database) throw new Error("Set DATABASE_URL, or DATABASE_HOST + DATABASE_NAME (Entra auth)");
  // Azure: sign in as the workload identity (managed identity) with an Entra token — no passwords.
  return {
    server,
    database,
    port: Number(process.env.DATABASE_PORT ?? 1433),
    options: { encrypt: true, trustServerCertificate: false },
    authentication: {
      type: "azure-active-directory-default",
      options: { clientId: process.env.AZURE_CLIENT_ID },
    },
  } as sql.config;
}

const globalForPool = globalThis as unknown as { __eslPool?: Promise<sql.ConnectionPool> };

function pool(): Promise<sql.ConnectionPool> {
  if (!globalForPool.__eslPool) {
    const cfg = connectionConfig();
    const max = Number(process.env.DATABASE_POOL_MAX ?? 5);
    const p =
      typeof cfg === "string"
        ? new sql.ConnectionPool(cfg)
        : new sql.ConnectionPool({ ...cfg, pool: { max, min: 0, idleTimeoutMillis: 10_000 }, connectionTimeout: 15_000, requestTimeout: 30_000 });
    globalForPool.__eslPool = p.connect().catch((e) => {
      globalForPool.__eslPool = undefined;
      throw e;
    });
  }
  return globalForPool.__eslPool;
}

// ---------------------------------------------------------------------------
// parameters and results
// ---------------------------------------------------------------------------
function bind(req: sql.Request, params: unknown[]) {
  params.forEach((v, i) => {
    const name = `p${i + 1}`;
    if (v === null || v === undefined) req.input(name, sql.NVarChar(sql.MAX), null);
    else if (typeof v === "boolean") req.input(name, sql.Bit, v);
    else if (typeof v === "number") req.input(name, Number.isInteger(v) ? sql.Int : sql.Float, v);
    else if (v instanceof Date) req.input(name, sql.DateTimeOffset(3), v);
    else if (typeof v === "object") req.input(name, sql.NVarChar(sql.MAX), JSON.stringify(v));
    else req.input(name, sql.NVarChar(sql.MAX), String(v));
  });
}

const toParams = (text: string) => text.replace(/\$(\d+)/g, (_, n) => `@p${n}`);

const pad = (n: number) => String(n).padStart(2, "0");

type ColumnMeta = { type?: unknown };

function normalise(rows: Row[], columns: Record<string, ColumnMeta> | undefined): Row[] {
  if (!rows.length) return rows;
  const kinds: Record<string, "uuid" | "date" | "instant" | "time" | "json" | "bigint"> = {};
  for (const [name, meta] of Object.entries(columns ?? {})) {
    const t = meta.type;
    if (t === sql.UniqueIdentifier) kinds[name] = "uuid";
    else if (t === sql.Date) kinds[name] = "date";
    else if (t === sql.DateTimeOffset || t === sql.DateTime2 || t === sql.DateTime || t === sql.SmallDateTime) kinds[name] = "instant";
    else if (t === sql.Time) kinds[name] = "time";
    else if (t === sql.BigInt) kinds[name] = "bigint";
    if (JSON_COLUMNS.has(name)) kinds[name] = "json";
  }
  for (const r of rows) {
    for (const [k, kind] of Object.entries(kinds)) {
      const v = r[k];
      if (v === null || v === undefined) continue;
      switch (kind) {
        case "uuid":
          r[k] = String(v).toLowerCase();
          break;
        case "date":
          r[k] = (v as Date).toISOString().slice(0, 10);
          break;
        case "instant":
          r[k] = (v as Date).toISOString();
          break;
        case "time": {
          const d = v as Date;
          r[k] = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
          break;
        }
        case "bigint":
          r[k] = Number(v);
          break;
        case "json":
          if (typeof v === "string") r[k] = v === "" ? null : JSON.parse(v);
          break;
      }
    }
  }
  return rows;
}

/** Map SQL Server error numbers to the Postgres-style codes the app checks. */
function mapError(e: unknown): never {
  const err = e as { number?: number; message?: string; code?: string; originalError?: { info?: { number?: number } } };
  const num = err.number ?? err.originalError?.info?.number;
  const msg = err.message ?? String(e);
  let code: string | undefined;
  if (num === 2627 || num === 2601) code = "23505";
  else if (num === 547) code = /FOREIGN KEY/i.test(msg) ? "23503" : "23514";
  else if (num === 33504 || num === 50001) code = "42501";
  if (code) {
    const wrapped = new Error(code === "42501" ? `permission denied (row-level security): ${msg}` : msg) as Error & { code: string; number?: number };
    wrapped.code = code;
    wrapped.number = num;
    throw wrapped;
  }
  throw e;
}

function wrap(t: sql.Transaction): Tx {
  const run = async (text: string, params: unknown[] = []) => {
    const req = new sql.Request(t);
    bind(req, params);
    try {
      return await req.query(toParams(text));
    } catch (e) {
      mapError(e);
    }
  };
  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = await run(text, params);
      return normalise((r.recordset ?? []) as Row[], (r.recordset as unknown as { columns?: Record<string, ColumnMeta> })?.columns) as T[];
    },
    async one<T>(text: string, params?: unknown[]) {
      const r = await run(text, params);
      return normalise((r.recordset ?? []) as Row[], (r.recordset as unknown as { columns?: Record<string, ColumnMeta> })?.columns)[0] as T | undefined;
    },
    async exec(text: string, params?: unknown[]) {
      const r = await run(text, params);
      return r.rowsAffected.at(-1) ?? 0;
    },
  };
}

async function inTransaction<T>(setup: string, setupParams: unknown[], fn: (tx: Tx) => Promise<T>): Promise<T> {
  const t = new sql.Transaction(await pool());
  await t.begin();
  try {
    const tx = wrap(t);
    await tx.query(setup, setupParams);
    const result = await fn(tx);
    await t.commit();
    return result;
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

/** Sets the RLS session context for a user (flags and roles read in the same transaction). */
const USER_CONTEXT = `
EXEC sp_set_session_context N'app_service', 1;
DECLARE @uid uniqueidentifier = TRY_CAST(@p1 AS uniqueidentifier);
DECLARE @active bit = 0, @flags nvarchar(10) = N'';
SELECT @active = is_active,
       @flags = CONCAT(CASE WHEN global_role = N'super_admin' THEN N'S' ELSE N'' END, CASE WHEN all_clocks_viewer = 1 THEN N'G' ELSE N'' END)
FROM ${S}.profiles WHERE id = @uid;
DECLARE @roles nvarchar(4000) = N'{' + COALESCE((
  SELECT CAST(STRING_AGG(CAST(N'"' + LOWER(CONVERT(nvarchar(36), m.clock_id)) + N'":"' + LEFT(m.role, 1) + N'"' AS nvarchar(max)), N',') AS nvarchar(4000))
  FROM ${S}.clock_members m WHERE m.user_id = @uid), N'') + N'}';
IF ISNULL(@active, 0) = 0 BEGIN SET @uid = NULL; SET @flags = N''; SET @roles = N'{}'; END;
DECLARE @uids nvarchar(36) = LOWER(CONVERT(nvarchar(36), @uid));
EXEC sp_set_session_context N'user_id', @uids;
EXEC sp_set_session_context N'user_flags', @flags;
EXEC sp_set_session_context N'clock_roles', @roles;
EXEC sp_set_session_context N'app_service', 0;`;

const SERVICE_CONTEXT = `
EXEC sp_set_session_context N'user_id', NULL;
EXEC sp_set_session_context N'user_flags', N'';
EXEC sp_set_session_context N'clock_roles', NULL;
EXEC sp_set_session_context N'app_service', 1;`;

export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(USER_CONTEXT, [userId], fn);
}

export function withService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(SERVICE_CONTEXT, [], fn);
}

export async function closePool() {
  const p = globalForPool.__eslPool;
  globalForPool.__eslPool = undefined;
  if (p) await (await p).close();
}
