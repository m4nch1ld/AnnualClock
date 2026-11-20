/**
 * Row-Level Security on SQL Server / Azure SQL — proves the authorization rules in
 * docs/authorization.md against the real migrations and the app's own withUser()/withService().
 * Runs when TEST_DATABASE_URL is set (always in CI). See tests/db/harness.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hasTestDb, setupTestDb, step, teardownTestDb } from "./harness";

type Db = Awaited<ReturnType<typeof setupTestDb>>;

const U = {
  superAdmin: "00000000-0000-0000-0000-000000000001",
  envDirector: "00000000-0000-0000-0000-000000000002", // admin Environmental, editor Safety
  gm: "00000000-0000-0000-0000-000000000003", // all_clocks_viewer
  crewEditor: "00000000-0000-0000-0000-000000000004", // editor Crewing
  viewer: "00000000-0000-0000-0000-000000000005", // viewer Environmental
  outsider: "00000000-0000-0000-0000-000000000006", // no memberships
  deactivated: "00000000-0000-0000-0000-000000000007", // admin Environmental, but inactive
  unknown: "00000000-0000-0000-0000-0000000000ff", // no profile at all (anonymous)
};
const C = {
  env: "10000000-0000-0000-0000-000000000001",
  safety: "10000000-0000-0000-0000-000000000002",
  crewing: "10000000-0000-0000-0000-000000000003",
};
const R = {
  env: "20000000-0000-0000-0000-000000000001",
  safety: "20000000-0000-0000-0000-000000000002",
  crewing: "20000000-0000-0000-0000-000000000003",
};
const A = {
  env: "30000000-0000-0000-0000-000000000001",
  safety: "30000000-0000-0000-0000-000000000002",
  crewing: "30000000-0000-0000-0000-000000000003",
};

const DENIED = /permission denied|row-level security/i;

describe.skipIf(!hasTestDb)("SQL Server row-level security", () => {
  let db: Db;
  let S: string;
  const count = async (userId: string, sql: string, params: unknown[] = []) =>
    (await db.withUser(userId, (tx) => tx.one<{ n: number }>(sql, params)))!.n;
  const asUser = <T>(userId: string, fn: Parameters<Db["withUser"]>[1]) => db.withUser(userId, fn) as Promise<T>;

  beforeAll(async () => {
    db = await setupTestDb();
    S = db.S;
    step("seeding fixtures");
    await db.withService((tx) =>
      tx.exec(`
        INSERT INTO ${S}.profiles (id, email, global_role, all_clocks_viewer, is_active) VALUES
          ('${U.superAdmin}', 'sa@x.test', N'super_admin', 0, 1),
          ('${U.envDirector}', 'env@x.test', N'user', 0, 1),
          ('${U.gm}', 'gm@x.test', N'user', 1, 1),
          ('${U.crewEditor}', 'crew@x.test', N'user', 0, 1),
          ('${U.viewer}', 'viewer@x.test', N'user', 0, 1),
          ('${U.outsider}', 'out@x.test', N'user', 0, 1),
          ('${U.deactivated}', 'gone@x.test', N'user', 0, 0);
        INSERT INTO ${S}.clocks (id, name, slug) VALUES
          ('${C.env}', N'Environmental', N'environmental'),
          ('${C.safety}', N'Safety', N'safety'),
          ('${C.crewing}', N'Crewing', N'crewing');
        INSERT INTO ${S}.rings (id, clock_id, name) VALUES
          ('${R.env}', '${C.env}', N'Regulatory'),
          ('${R.safety}', '${C.safety}', N'Drills'),
          ('${R.crewing}', '${C.crewing}', N'Certificates');
        INSERT INTO ${S}.clock_members (clock_id, user_id, role) VALUES
          ('${C.env}', '${U.envDirector}', N'admin'),
          ('${C.safety}', '${U.envDirector}', N'editor'),
          ('${C.crewing}', '${U.crewEditor}', N'editor'),
          ('${C.env}', '${U.viewer}', N'viewer'),
          ('${C.env}', '${U.deactivated}', N'admin');
        INSERT INTO ${S}.activities (id, clock_id, ring_id, title, start_date) VALUES
          ('${A.env}', '${C.env}', '${R.env}', N'EUA verification due', '2026-03-31'),
          ('${A.safety}', '${C.safety}', '${R.safety}', N'Fire drill', '2026-05-01'),
          ('${A.crewing}', '${C.crewing}', '${R.crewing}', N'STCW renewals', '2026-06-01');
        INSERT INTO ${S}.clock_secrets (clock_id, teams_webhook_url) VALUES ('${C.env}', N'https://example.test/hook');`),
    );
    step("fixtures seeded");
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  }, 60_000);

  describe("clock isolation", () => {
    test("a user without membership cannot read another clock's data", async () => {
      const u = U.crewEditor;
      expect(await count(u, `SELECT count(*) AS n FROM ${S}.clocks WHERE id = $1`, [C.safety])).toBe(0);
      expect(await count(u, `SELECT count(*) AS n FROM ${S}.activities WHERE clock_id = $1`, [C.safety])).toBe(0);
      expect(await count(u, `SELECT count(*) AS n FROM ${S}.rings WHERE clock_id = $1`, [C.safety])).toBe(0);
      expect(await count(u, `SELECT count(*) AS n FROM ${S}.clock_members WHERE clock_id = $1`, [C.safety])).toBe(0);
      expect(await count(u, `SELECT count(*) AS n FROM ${S}.activities WHERE clock_id = $1`, [C.crewing])).toBe(1);
    });

    test("a user without membership cannot write to another clock", async () => {
      await expect(
        asUser(U.crewEditor, (tx) =>
          tx.exec(`INSERT INTO ${S}.activities (clock_id, ring_id, title, start_date) VALUES ($1, $2, N'x', '2026-01-01')`, [C.safety, R.safety]),
        ),
      ).rejects.toThrow(DENIED);
      // invisible rows are not updatable at all
      const n = await asUser<number>(U.crewEditor, (tx) => tx.exec(`UPDATE ${S}.activities SET title = N'hacked' WHERE id = $1`, [A.safety]));
      expect(n).toBe(0);
    });

    test("an outsider sees no clocks at all", async () => {
      expect(await count(U.outsider, `SELECT count(*) AS n FROM ${S}.clocks`)).toBe(0);
      expect(await count(U.outsider, `SELECT count(*) AS n FROM ${S}.activities`)).toBe(0);
    });

    test("without a valid user context nothing is visible", async () => {
      expect(await count(U.unknown, `SELECT count(*) AS n FROM ${S}.activities`)).toBe(0);
      expect(await count(U.unknown, `SELECT count(*) AS n FROM ${S}.profiles`)).toBe(0);
    });

    test("deactivated users lose all access", async () => {
      expect(await count(U.deactivated, `SELECT count(*) AS n FROM ${S}.clocks`)).toBe(0);
      expect(await count(U.deactivated, `SELECT count(*) AS n FROM ${S}.activities`)).toBe(0);
    });

    test("one user's context never leaks into the next transaction", async () => {
      expect(await count(U.envDirector, `SELECT count(*) AS n FROM ${S}.clocks`)).toBe(2);
      expect(await count(U.outsider, `SELECT count(*) AS n FROM ${S}.clocks`)).toBe(0);
      expect(await count(U.crewEditor, `SELECT count(*) AS n FROM ${S}.clocks`)).toBe(1);
    });
  });

  describe("roles within a clock", () => {
    test("viewers can read but cannot write", async () => {
      expect(await count(U.viewer, `SELECT count(*) AS n FROM ${S}.activities WHERE clock_id = $1`, [C.env])).toBe(1);
      await expect(asUser(U.viewer, (tx) => tx.exec(`UPDATE ${S}.activities SET title = N'x' WHERE id = $1`, [A.env]))).rejects.toThrow(DENIED);
      await expect(
        asUser(U.viewer, (tx) =>
          tx.exec(
            `INSERT INTO ${S}.activity_occurrences_state (activity_id, clock_id, occurrence_date, status) VALUES ($1, $2, '2026-03-31', N'done')`,
            [A.env, C.env],
          ),
        ),
      ).rejects.toThrow(DENIED);
      await expect(
        asUser(U.viewer, (tx) =>
          tx.exec(`INSERT INTO ${S}.activities (clock_id, ring_id, title, start_date) VALUES ($1, $2, N'x', '2026-01-01')`, [C.env, R.env]),
        ),
      ).rejects.toThrow(DENIED);
    });

    test("editors can write activities", async () => {
      const n = await asUser<number>(U.envDirector, (tx) => tx.exec(`UPDATE ${S}.activities SET description = N'ok' WHERE id = $1`, [A.safety]));
      expect(n).toBe(1);
    });

    test("editors cannot change membership", async () => {
      await expect(
        asUser(U.envDirector, (tx) =>
          tx.exec(`INSERT INTO ${S}.clock_members (clock_id, user_id, role) VALUES ($1, $2, N'viewer')`, [C.safety, U.outsider]),
        ),
      ).rejects.toThrow(DENIED);
      await expect(
        asUser(U.envDirector, (tx) =>
          tx.exec(`UPDATE ${S}.clock_members SET role = N'admin' WHERE clock_id = $1 AND user_id = $2`, [C.safety, U.envDirector]),
        ),
      ).rejects.toThrow(DENIED);
      await expect(asUser(U.crewEditor, (tx) => tx.exec(`DELETE FROM ${S}.clock_members WHERE clock_id = $1`, [C.crewing]))).rejects.toThrow(DENIED);
    });

    test("clock admins can manage membership of their own clock only", async () => {
      const n = await asUser<number>(U.envDirector, (tx) =>
        tx.exec(`INSERT INTO ${S}.clock_members (clock_id, user_id, role) VALUES ($1, $2, N'viewer')`, [C.env, U.outsider]),
      );
      expect(n).toBe(1);
      await db.withService((tx) => tx.exec(`DELETE FROM ${S}.clock_members WHERE clock_id = $1 AND user_id = $2`, [C.env, U.outsider]));
    });

    test("an activity cannot be placed on another clock's ring", async () => {
      await expect(
        asUser(U.envDirector, (tx) =>
          tx.exec(`INSERT INTO ${S}.activities (clock_id, ring_id, title, start_date) VALUES ($1, $2, N'x', '2026-01-01')`, [C.env, R.crewing]),
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe("general management", () => {
    test("can read all clocks", async () => {
      expect(await count(U.gm, `SELECT count(*) AS n FROM ${S}.clocks`)).toBe(3);
      expect(await count(U.gm, `SELECT count(*) AS n FROM ${S}.activities`)).toBe(3);
    });

    test("cannot write", async () => {
      await expect(asUser(U.gm, (tx) => tx.exec(`UPDATE ${S}.activities SET title = N'x'`))).rejects.toThrow(DENIED);
      await expect(asUser(U.gm, (tx) => tx.exec(`UPDATE ${S}.clocks SET name = N'x'`))).rejects.toThrow(DENIED);
      await expect(
        asUser(U.gm, (tx) =>
          tx.exec(`INSERT INTO ${S}.activities (clock_id, ring_id, title, start_date) VALUES ($1, $2, N'x', '2026-01-01')`, [C.env, R.env]),
        ),
      ).rejects.toThrow(DENIED);
    });
  });

  describe("privileged data", () => {
    test("Teams webhook secrets are not readable by any signed-in user", async () => {
      for (const u of [U.envDirector, U.superAdmin, U.gm]) {
        expect(await count(u, `SELECT count(*) AS n FROM ${S}.clock_secrets`)).toBe(0);
      }
      const svc = await db.withService((tx) => tx.one<{ n: number }>(`SELECT count(*) AS n FROM ${S}.clock_secrets`));
      expect(svc!.n).toBe(1);
    });

    test("users cannot escalate their own global role or General management flag", async () => {
      await expect(
        asUser(U.viewer, (tx) => tx.exec(`UPDATE ${S}.profiles SET global_role = N'super_admin' WHERE id = $1`, [U.viewer])),
      ).rejects.toThrow(DENIED);
      await expect(asUser(U.viewer, (tx) => tx.exec(`UPDATE ${S}.profiles SET all_clocks_viewer = 1 WHERE id = $1`, [U.viewer]))).rejects.toThrow(
        DENIED,
      );
      expect(await asUser<number>(U.viewer, (tx) => tx.exec(`UPDATE ${S}.profiles SET full_name = N'Vera Viewer' WHERE id = $1`, [U.viewer]))).toBe(1);
      // and cannot edit someone else's profile
      await expect(asUser(U.viewer, (tx) => tx.exec(`UPDATE ${S}.profiles SET full_name = N'x' WHERE id = $1`, [U.gm]))).rejects.toThrow(DENIED);
    });

    test("in-app notifications are private and only read_at can be changed", async () => {
      await db.withService((tx) => tx.exec(`INSERT INTO ${S}.in_app_notifications (user_id, kind, title) VALUES ($1, N'reminder', N'hi')`, [U.viewer]));
      expect(await count(U.envDirector, `SELECT count(*) AS n FROM ${S}.in_app_notifications`)).toBe(0);
      expect(await count(U.viewer, `SELECT count(*) AS n FROM ${S}.in_app_notifications`)).toBe(1);
      expect(await asUser<number>(U.viewer, (tx) => tx.exec(`UPDATE ${S}.in_app_notifications SET read_at = sysdatetimeoffset()`))).toBe(1);
      await expect(asUser(U.viewer, (tx) => tx.exec(`UPDATE ${S}.in_app_notifications SET title = N'x'`))).rejects.toThrow(DENIED);
      await expect(
        asUser(U.viewer, (tx) => tx.exec(`INSERT INTO ${S}.in_app_notifications (user_id, kind, title) VALUES ($1, N'x', N'x')`, [U.viewer])),
      ).rejects.toThrow(DENIED);
    });

    test("ICS tokens can only be created for readable clocks", async () => {
      await expect(
        asUser(U.crewEditor, (tx) => tx.exec(`INSERT INTO ${S}.ics_tokens (user_id, clock_id, token_hash) VALUES ($1, $2, N'h1')`, [U.crewEditor, C.safety])),
      ).rejects.toThrow(DENIED);
      expect(
        await asUser<number>(U.crewEditor, (tx) =>
          tx.exec(`INSERT INTO ${S}.ics_tokens (user_id, clock_id, token_hash) VALUES ($1, $2, N'h2')`, [U.crewEditor, C.crewing]),
        ),
      ).toBe(1);
    });

    test("job runs are visible to super admins only", async () => {
      await db.withService((tx) => tx.exec(`INSERT INTO ${S}.job_runs (job) VALUES (N'notifications')`));
      expect(await count(U.superAdmin, `SELECT count(*) AS n FROM ${S}.job_runs`)).toBe(1);
      expect(await count(U.envDirector, `SELECT count(*) AS n FROM ${S}.job_runs`)).toBe(0);
    });
  });

  describe("calendar links", () => {
    test("users see only their own links and cannot write them directly", async () => {
      await db.withService((tx) =>
        tx.exec(
          `INSERT INTO ${S}.calendar_links (user_id, activity_id, scope, uid) VALUES ($1, $2, N'series', N'uid-1'), ($3, $2, N'series', N'uid-2')`,
          [U.envDirector, A.env, U.viewer],
        ),
      );
      expect(await count(U.envDirector, `SELECT count(*) AS n FROM ${S}.calendar_links`)).toBe(1);
      await expect(
        asUser(U.viewer, (tx) => tx.exec(`INSERT INTO ${S}.calendar_links (user_id, activity_id, scope, uid) VALUES ($1, $2, N'series', N'x')`, [U.viewer, A.env])),
      ).rejects.toThrow(DENIED);
    });

    test("only one active link per user, activity and occurrence", async () => {
      await expect(
        db.withService((tx) =>
          tx.exec(`INSERT INTO ${S}.calendar_links (user_id, activity_id, scope, uid) VALUES ($1, $2, N'series', N'uid-3')`, [U.envDirector, A.env]),
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("audit log", () => {
    test("changes are recorded with the acting user and before/after snapshots", async () => {
      await asUser(U.envDirector, (tx) => tx.exec(`UPDATE ${S}.activities SET title = N'EUA verification' WHERE id = $1`, [A.env]));
      const row = await db.withService((tx) =>
        tx.one<{ actor_id: string; before_title: string; after_title: string }>(
          `SELECT TOP (1) actor_id, JSON_VALUE(diff, '$.before.title') AS before_title, JSON_VALUE(diff, '$.after.title') AS after_title
           FROM ${S}.audit_log WHERE entity = N'activities' AND entity_id = $1 AND action = N'update' ORDER BY id DESC`,
          [A.env],
        ),
      );
      expect(row).toMatchObject({ actor_id: U.envDirector, before_title: "EUA verification due", after_title: "EUA verification" });
    });

    test("users cannot read the audit log of a clock they cannot edit, nor write to it", async () => {
      expect(await count(U.crewEditor, `SELECT count(*) AS n FROM ${S}.audit_log WHERE clock_id = $1`, [C.env])).toBe(0);
      expect(await count(U.viewer, `SELECT count(*) AS n FROM ${S}.audit_log WHERE clock_id = $1`, [C.env])).toBe(0);
      expect(await count(U.envDirector, `SELECT count(*) AS n FROM ${S}.audit_log WHERE clock_id = $1`, [C.env])).toBeGreaterThan(0);
      await expect(
        asUser(U.envDirector, (tx) => tx.exec(`INSERT INTO ${S}.audit_log (clock_id, entity, action) VALUES ($1, N'x', N'forged')`, [C.env])),
      ).rejects.toThrow(DENIED);
    });
  });

  describe("notification log idempotency", () => {
    test("the same occurrence + reminder + recipient + channel can only be logged once (NULLs compare equal)", async () => {
      const ins = `INSERT INTO ${S}.notification_log (activity_id, occurrence_date, reminder_key, recipient_id, channel)
                   VALUES ($1, '2026-03-31', N'reminder:-14', $2, $3)`;
      await db.withService((tx) => tx.exec(ins, [A.env, U.envDirector, "email"]));
      await expect(db.withService((tx) => tx.exec(ins, [A.env, U.envDirector, "email"]))).rejects.toMatchObject({ code: "23505" });
      await db.withService((tx) => tx.exec(ins, [A.env, null, "teams"]));
      await expect(db.withService((tx) => tx.exec(ins, [A.env, null, "teams"]))).rejects.toMatchObject({ code: "23505" });
    });

    test("notification log is written by the server only; recipients read their own entries", async () => {
      await expect(
        asUser(U.envDirector, (tx) =>
          tx.exec(`INSERT INTO ${S}.notification_log (reminder_key, recipient_id, channel) VALUES (N'x', $1, N'email')`, [U.envDirector]),
        ),
      ).rejects.toThrow(DENIED);
      expect(await count(U.envDirector, `SELECT count(*) AS n FROM ${S}.notification_log WHERE recipient_id = $1`, [U.envDirector])).toBe(1);
      expect(await count(U.crewEditor, `SELECT count(*) AS n FROM ${S}.notification_log`)).toBe(0);
    });
  });

  describe("data round-trip through lib/db", () => {
    test("dates, times, ids, bits and JSON columns come back in the app's formats", async () => {
      await db.withService((tx) =>
        tx.exec(`UPDATE ${S}.activities SET start_time = '08:30', tags = $2, reminder_offsets = $3, links = $4 WHERE id = $1`, [
          A.crewing,
          ["STCW", "crew"],
          [30, 7],
          [{ label: "Doc", url: "https://example.test" }],
        ]),
      );
      const a = await db.withService((tx) =>
        tx.one<Record<string, unknown>>(`SELECT id, start_date, start_time, all_day, tags, reminder_offsets, links, created_at FROM ${S}.activities WHERE id = $1`, [
          A.crewing,
        ]),
      );
      expect(a).toMatchObject({
        id: A.crewing,
        start_date: "2026-06-01",
        start_time: "08:30",
        all_day: true,
        tags: ["STCW", "crew"],
        reminder_offsets: [30, 7],
        links: [{ label: "Doc", url: "https://example.test" }],
      });
      expect(String(a!.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
