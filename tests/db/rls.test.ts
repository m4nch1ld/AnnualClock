import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createTestDb } from "./harness";

// Fixed ids keep the assertions readable.
const U = {
  superAdmin: "00000000-0000-0000-0000-000000000001",
  envDirector: "00000000-0000-0000-0000-000000000002", // admin Environmental, editor Safety
  gm: "00000000-0000-0000-0000-000000000003", // all_clocks_viewer
  crewEditor: "00000000-0000-0000-0000-000000000004", // editor Crewing
  viewer: "00000000-0000-0000-0000-000000000005", // viewer Environmental
  outsider: "00000000-0000-0000-0000-000000000006", // no memberships
  deactivated: "00000000-0000-0000-0000-000000000007", // admin Environmental, but inactive
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

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`
    insert into profiles (id, email, global_role, all_clocks_viewer, is_active) values
      ('${U.superAdmin}', 'sa@x.test', 'super_admin', false, true),
      ('${U.envDirector}', 'env@x.test', 'user', false, true),
      ('${U.gm}', 'gm@x.test', 'user', true, true),
      ('${U.crewEditor}', 'crew@x.test', 'user', false, true),
      ('${U.viewer}', 'viewer@x.test', 'user', false, true),
      ('${U.outsider}', 'out@x.test', 'user', false, true),
      ('${U.deactivated}', 'gone@x.test', 'user', false, false);
    insert into clocks (id, name, slug) values
      ('${C.env}', 'Environmental', 'environmental'),
      ('${C.safety}', 'Safety', 'safety'),
      ('${C.crewing}', 'Crewing', 'crewing');
    insert into rings (id, clock_id, name) values
      ('${R.env}', '${C.env}', 'Regulatory'),
      ('${R.safety}', '${C.safety}', 'Drills'),
      ('${R.crewing}', '${C.crewing}', 'Certificates');
    insert into clock_members (clock_id, user_id, role) values
      ('${C.env}', '${U.envDirector}', 'admin'),
      ('${C.safety}', '${U.envDirector}', 'editor'),
      ('${C.crewing}', '${U.crewEditor}', 'editor'),
      ('${C.env}', '${U.viewer}', 'viewer'),
      ('${C.env}', '${U.deactivated}', 'admin');
    insert into activities (id, clock_id, ring_id, title, start_date) values
      ('${A.env}', '${C.env}', '${R.env}', 'EUA verification due', '2026-03-31'),
      ('${A.safety}', '${C.safety}', '${R.safety}', 'Fire drill', '2026-05-01'),
      ('${A.crewing}', '${C.crewing}', '${R.crewing}', 'STCW renewals', '2026-06-01');
    insert into clock_secrets (clock_id, teams_webhook_url) values ('${C.env}', 'https://example.test/hook');
  `);
});

const count = (rows: Array<{ n: number }>) => rows[0].n;

describe("clock isolation", () => {
  test("a user without membership cannot read another clock's data", async () => {
    await asUser(db, U.crewEditor, async (q) => {
      expect(count(await q(`select count(*)::int n from clocks where id = $1`, [C.safety]))).toBe(0);
      expect(count(await q(`select count(*)::int n from activities where clock_id = $1`, [C.safety]))).toBe(0);
      expect(count(await q(`select count(*)::int n from rings where clock_id = $1`, [C.safety]))).toBe(0);
      expect(count(await q(`select count(*)::int n from clock_members where clock_id = $1`, [C.safety]))).toBe(0);
      // but sees own clock
      expect(count(await q(`select count(*)::int n from activities where clock_id = $1`, [C.crewing]))).toBe(1);
    });
  });

  test("a user without membership cannot write to another clock", async () => {
    await expect(
      asUser(db, U.crewEditor, (q) =>
        q(`insert into activities (clock_id, ring_id, title, start_date) values ($1, $2, 'x', '2026-01-01')`, [
          C.safety,
          R.safety,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await asUser(db, U.crewEditor, (q) =>
      q(`update activities set title = 'hacked' where id = $1 returning id`, [A.safety]),
    );
    expect(updated).toHaveLength(0);
  });

  test("an outsider sees no clocks at all", async () => {
    await asUser(db, U.outsider, async (q) => {
      expect(count(await q(`select count(*)::int n from clocks`))).toBe(0);
      expect(count(await q(`select count(*)::int n from activities`))).toBe(0);
    });
  });

  test("anonymous users have no access", async () => {
    await expect(asUser(db, null, (q) => q(`select * from activities`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, null, (q) => q(`select * from profiles`))).rejects.toThrow(/permission denied/);
  });

  test("deactivated users lose all access", async () => {
    await asUser(db, U.deactivated, async (q) => {
      expect(count(await q(`select count(*)::int n from clocks`))).toBe(0);
      expect(count(await q(`select count(*)::int n from activities`))).toBe(0);
    });
  });
});

describe("roles within a clock", () => {
  test("viewers can read but cannot write", async () => {
    await asUser(db, U.viewer, async (q) => {
      expect(count(await q(`select count(*)::int n from activities where clock_id = $1`, [C.env]))).toBe(1);
      expect(await q(`update activities set title = 'x' where id = $1 returning id`, [A.env])).toHaveLength(0);
    });
    await expect(
      asUser(db, U.viewer, (q) =>
        q(`insert into activity_occurrences_state (activity_id, occurrence_date, status) values ($1, '2026-03-31', 'done')`, [
          A.env,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(db, U.viewer, (q) =>
        q(`insert into activities (clock_id, ring_id, title, start_date) values ($1, $2, 'x', '2026-01-01')`, [C.env, R.env]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test("editors can write activities", async () => {
    const rows = await asUser(db, U.envDirector, (q) =>
      q(`update activities set description = 'ok' where id = $1 returning id`, [A.safety]),
    );
    expect(rows).toHaveLength(1);
  });

  test("editors cannot change membership", async () => {
    // envDirector is only editor in Safety
    await expect(
      asUser(db, U.envDirector, (q) =>
        q(`insert into clock_members (clock_id, user_id, role) values ($1, $2, 'viewer')`, [C.safety, U.outsider]),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await asUser(db, U.envDirector, (q) =>
      q(`update clock_members set role = 'admin' where clock_id = $1 and user_id = $2 returning id`, [
        C.safety,
        U.envDirector,
      ]),
    );
    expect(upd).toHaveLength(0);
    const del = await asUser(db, U.crewEditor, (q) =>
      q(`delete from clock_members where clock_id = $1 returning id`, [C.crewing]),
    );
    expect(del).toHaveLength(0);
  });

  test("clock admins can manage membership of their own clock only", async () => {
    const rows = await asUser(db, U.envDirector, (q) =>
      q(`insert into clock_members (clock_id, user_id, role) values ($1, $2, 'viewer') returning id`, [
        C.env,
        U.outsider,
      ]),
    );
    expect(rows).toHaveLength(1);
    await db.query(`delete from clock_members where clock_id = $1 and user_id = $2`, [C.env, U.outsider]);
  });

  test("editors cannot place an activity on another clock's ring", async () => {
    await expect(
      asUser(db, U.envDirector, (q) =>
        q(`insert into activities (clock_id, ring_id, title, start_date) values ($1, $2, 'x', '2026-01-01')`, [
          C.env,
          R.crewing,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("general management", () => {
  test("can read all clocks", async () => {
    await asUser(db, U.gm, async (q) => {
      expect(count(await q(`select count(*)::int n from clocks`))).toBe(3);
      expect(count(await q(`select count(*)::int n from activities`))).toBe(3);
    });
  });

  test("cannot write", async () => {
    await asUser(db, U.gm, async (q) => {
      expect(await q(`update activities set title = 'x' returning id`)).toHaveLength(0);
      expect(await q(`update clocks set name = 'x' returning id`)).toHaveLength(0);
    });
    await expect(
      asUser(db, U.gm, (q) =>
        q(`insert into activities (clock_id, ring_id, title, start_date) values ($1, $2, 'x', '2026-01-01')`, [C.env, R.env]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("privileged data", () => {
  test("Teams webhook secrets are not readable by any signed-in user", async () => {
    for (const u of [U.envDirector, U.superAdmin, U.gm]) {
      await asUser(db, u, async (q) => {
        expect(count(await q(`select count(*)::int n from clock_secrets`))).toBe(0);
      });
    }
  });

  test("users cannot escalate their own global role or GM flag", async () => {
    await expect(
      asUser(db, U.viewer, (q) => q(`update profiles set global_role = 'super_admin' where id = $1`, [U.viewer])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, U.viewer, (q) => q(`update profiles set all_clocks_viewer = true where id = $1`, [U.viewer])),
    ).rejects.toThrow(/permission denied/);
    const ok = await asUser(db, U.viewer, (q) =>
      q(`update profiles set full_name = 'Vera Viewer' where id = $1 returning id`, [U.viewer]),
    );
    expect(ok).toHaveLength(1);
  });

  test("in-app notifications are private to the recipient", async () => {
    await db.query(`insert into in_app_notifications (user_id, kind, title) values ($1, 'reminder', 'hi')`, [U.viewer]);
    await asUser(db, U.envDirector, async (q) => {
      expect(count(await q(`select count(*)::int n from in_app_notifications`))).toBe(0);
    });
    await asUser(db, U.viewer, async (q) => {
      expect(count(await q(`select count(*)::int n from in_app_notifications`))).toBe(1);
    });
  });

  test("ICS tokens can only be created for readable clocks", async () => {
    await expect(
      asUser(db, U.crewEditor, (q) =>
        q(`insert into ics_tokens (user_id, clock_id, token_hash) values ($1, $2, 'h1')`, [U.crewEditor, C.safety]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("calendar links", () => {
  test("users see only their own calendar links and cannot write them directly", async () => {
    await db.query(
      `insert into calendar_links (user_id, activity_id, scope, uid) values ($1, $2, 'series', 'uid-1'), ($3, $2, 'series', 'uid-2')`,
      [U.envDirector, A.env, U.viewer],
    );
    await asUser(db, U.envDirector, async (q) => {
      expect(count(await q(`select count(*)::int n from calendar_links`))).toBe(1);
    });
    await expect(
      asUser(db, U.viewer, (q) => q(`insert into calendar_links (user_id, activity_id, scope, uid) values ($1, $2, 'series', 'x')`, [U.viewer, A.env])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("audit log", () => {
  test("changes are recorded with the acting user", async () => {
    await asUser(db, U.envDirector, (q) => q(`update activities set title = 'EUA verification' where id = $1`, [A.env]));
    const rows = await db.query<{ actor_id: string; action: string; diff: Record<string, unknown> }>(
      `select actor_id, action, diff from audit_log where entity = 'activities' and entity_id = $1 and action = 'update'`,
      [A.env],
    );
    expect(rows.rows.at(-1)?.actor_id).toBe(U.envDirector);
    expect(rows.rows.at(-1)?.diff).toHaveProperty("title");
  });

  test("viewers of another clock cannot read its audit log", async () => {
    await asUser(db, U.crewEditor, async (q) => {
      expect(count(await q(`select count(*)::int n from audit_log where clock_id = $1`, [C.env]))).toBe(0);
    });
  });
});

describe("notification log idempotency", () => {
  test("the same occurrence + reminder + recipient + channel can only be logged once", async () => {
    const ins = `insert into notification_log (activity_id, occurrence_date, reminder_key, recipient_id, channel)
                 values ($1, '2026-03-31', 'reminder:-14', $2, 'email') on conflict do nothing returning id`;
    expect((await db.query(ins, [A.env, U.envDirector])).rows).toHaveLength(1);
    expect((await db.query(ins, [A.env, U.envDirector])).rows).toHaveLength(0);
    // channel-level entries (no recipient) are deduplicated too
    const teams = `insert into notification_log (activity_id, occurrence_date, reminder_key, recipient_id, channel)
                   values ($1, '2026-03-31', 'reminder:-14', null, 'teams') on conflict do nothing returning id`;
    expect((await db.query(teams, [A.env])).rows).toHaveLength(1);
    expect((await db.query(teams, [A.env])).rows).toHaveLength(0);
  });
});
