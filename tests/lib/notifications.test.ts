import { describe, expect, test } from "vitest";
import { planNotifications, zonedInstant } from "@/lib/notifications/planner";
import { runNotificationJob } from "@/lib/notifications/job";
import { renderEmail } from "@/lib/notifications/messages";
import { verifyActionToken } from "@/lib/tokens";
import {
  intentKey,
  type ClockInfo,
  type DeliveryContext,
  type NotificationChannel,
  type NotificationIntent,
  type NotificationRepository,
  type PlannerData,
  type UserInfo,
} from "@/lib/notifications/types";
import type { Activity, OccurrenceState } from "@/lib/domain";

const TZ = "Europe/Helsinki";
const SECRET = "x".repeat(40);

const user = (id: string, extra: Partial<UserInfo> = {}): UserInfo => ({
  id,
  email: `${id}@x.test`,
  full_name: id,
  locale: "en",
  is_active: true,
  all_clocks_viewer: false,
  global_role: "user",
  weekly_digest: false,
  ...extra,
});

const ENV: ClockInfo = {
  id: "clock-env",
  name: "Environmental",
  slug: "environmental",
  color: "#138538",
  description: null,
  default_reminder_offsets: [30, 14, 7, 1],
  escalation_config: { enabled: true, offsets_days: [1, 7], notify_admins: true, notify_general_management: true },
  default_send_time: "08:00",
  teams_enabled: false,
  is_general_management: false,
  position: 0,
  has_teams_webhook: false,
};

const activity = (extra: Partial<Activity> = {}): Activity => ({
  id: "a0000000-0000-4000-8000-000000000001",
  clock_id: ENV.id,
  ring_id: "ring-1",
  title: "EUA verification due",
  description: null,
  type: "deadline",
  start_date: "2026-03-31",
  end_date: null,
  all_day: true,
  start_time: null,
  end_time: null,
  rrule: "FREQ=YEARLY",
  owner_id: "d0000000-0000-4000-8000-000000000001",
  status: "planned",
  predecessor_id: null,
  reminder_offsets: [30, 14, 7, 1],
  tags: [],
  links: [],
  assignee_ids: [],
  ...extra,
});

function baseData(overrides: Partial<PlannerData> = {}): PlannerData {
  return {
    clocks: [ENV],
    activities: [activity()],
    states: [],
    members: [
      { clock_id: ENV.id, user_id: "d0000000-0000-4000-8000-000000000001", role: "admin" },
      { clock_id: ENV.id, user_id: "team", role: "editor" },
      { clock_id: ENV.id, user_id: "viewer", role: "viewer" },
    ],
    prefs: [{ user_id: "team", clock_id: ENV.id, enabled: true, channels: ["email", "in_app"], subscribe_all: true, delivery: "individual" }],
    users: [user("d0000000-0000-4000-8000-000000000001"), user("team"), user("viewer"), user("gm", { all_clocks_viewer: true }), user("outsider")],
    ...overrides,
  };
}

const plan = (data: PlannerData, windowStart: string, now: string) =>
  planNotifications({ ...data, now: new Date(now), windowStart: new Date(windowStart), timeZone: TZ, digestSendTime: "08:00" });

describe("zonedInstant (Helsinki, DST-aware)", () => {
  test("winter: 08:00 EET = 06:00Z", () => {
    expect(zonedInstant("2027-03-01", "08:00", TZ).toISOString()).toBe("2027-03-01T06:00:00.000Z");
  });
  test("summer: 08:00 EEST = 05:00Z", () => {
    expect(zonedInstant("2027-03-30", "08:00", TZ).toISOString()).toBe("2027-03-30T05:00:00.000Z");
  });
  test("DST switch day (last Sunday of March)", () => {
    expect(zonedInstant("2027-03-28", "08:00", TZ).toISOString()).toBe("2027-03-28T05:00:00.000Z");
  });
});

describe("planner", () => {
  test("30-day reminder for next year's EUA occurrence goes to owner and subscribed team, email + in-app", () => {
    // 2027-03-31 - 30 days = 2027-03-01 08:00 Helsinki = 06:00Z
    const intents = plan(baseData(), "2027-03-01T00:00:00Z", "2027-03-01T12:00:00Z");
    expect(intents.map((i) => `${i.key}|${i.recipientId}|${i.channel}|${i.occurrenceDate}`).sort()).toEqual([
      "reminder:-30|d0000000-0000-4000-8000-000000000001|email|2027-03-31",
      "reminder:-30|d0000000-0000-4000-8000-000000000001|in_app|2027-03-31",
      "reminder:-30|team|email|2027-03-31",
      "reminder:-30|team|in_app|2027-03-31",
    ]);
    expect(intents.every((i) => i.canAct)).toBe(true);
  });

  test("nothing is sent before the configured local send time", () => {
    expect(plan(baseData(), "2027-03-01T00:00:00Z", "2027-03-01T05:59:00Z")).toHaveLength(0);
  });

  test("all four offsets fire on their days", () => {
    const days = ["2027-03-01", "2027-03-17", "2027-03-24", "2027-03-30"];
    const keys = days.flatMap((d) => plan(baseData(), `${d}T00:00:00Z`, `${d}T23:00:00Z`).map((i) => i.key));
    expect([...new Set(keys)]).toEqual(["reminder:-30", "reminder:-14", "reminder:-7", "reminder:-1"]);
  });

  test("completed occurrence: no reminders and no escalation for that occurrence only", () => {
    const done: OccurrenceState = {
      activity_id: "a0000000-0000-4000-8000-000000000001",
      occurrence_date: "2027-03-31",
      status: "done",
      completed_at: "2027-03-02T10:00:00Z",
      completed_by: "d0000000-0000-4000-8000-000000000001",
      snoozed_until: null,
    };
    const data = baseData({ states: [done] });
    expect(plan(data, "2027-03-17T00:00:00Z", "2027-03-17T23:00:00Z")).toHaveLength(0); // -14
    expect(plan(data, "2027-04-01T00:00:00Z", "2027-04-01T23:00:00Z")).toHaveLength(0); // escalation +1
    // the following year's occurrence still reminds
    expect(plan(data, "2028-03-01T00:00:00Z", "2028-03-01T23:00:00Z").length).toBeGreaterThan(0);
  });

  test("escalation at +1 and +7 days to clock admins and General management", () => {
    const e1 = plan(baseData(), "2027-04-01T00:00:00Z", "2027-04-01T23:00:00Z");
    expect(e1.filter((i) => i.channel === "email").map((i) => `${i.key}|${i.recipientId}`).sort()).toEqual([
      "escalation:+1|d0000000-0000-4000-8000-000000000001",
      "escalation:+1|gm",
    ]);
    const e7 = plan(baseData(), "2027-04-07T00:00:00Z", "2027-04-07T23:00:00Z");
    expect(new Set(e7.map((i) => i.key))).toEqual(new Set(["escalation:+7"]));
    // GM cannot act (read-only), admin can
    expect(e1.find((i) => i.recipientId === "gm")?.canAct).toBe(false);
    expect(e1.find((i) => i.recipientId === "d0000000-0000-4000-8000-000000000001")?.canAct).toBe(true);
  });

  test("escalation can be disabled per clock", () => {
    const data = baseData({ clocks: [{ ...ENV, escalation_config: { ...ENV.escalation_config, enabled: false } }] });
    expect(plan(data, "2027-04-01T00:00:00Z", "2027-04-01T23:00:00Z")).toHaveLength(0);
  });

  test("snooze suppresses earlier reminders and sends one on the snooze date", () => {
    const snoozed: OccurrenceState = {
      activity_id: "a0000000-0000-4000-8000-000000000001",
      occurrence_date: "2027-03-31",
      status: "planned",
      completed_at: null,
      completed_by: null,
      snoozed_until: "2027-03-26",
    };
    const data = baseData({ states: [snoozed] });
    expect(plan(data, "2027-03-24T00:00:00Z", "2027-03-24T23:00:00Z")).toHaveLength(0); // -7 suppressed
    expect(plan(data, "2027-03-26T00:00:00Z", "2027-03-26T23:00:00Z").map((i) => i.key)).toContain("snooze:2027-03-26");
    expect(plan(data, "2027-03-30T00:00:00Z", "2027-03-30T23:00:00Z").map((i) => i.key)).toContain("reminder:-1");
  });

  test("users who opted out, deactivated users and non-members get nothing", () => {
    const data = baseData({
      prefs: [{ user_id: "team", clock_id: ENV.id, enabled: false, channels: ["email"], subscribe_all: true, delivery: "individual" }],
      users: [user("d0000000-0000-4000-8000-000000000001", { is_active: false }), user("team"), user("gm", { all_clocks_viewer: true })],
    });
    expect(plan(data, "2027-03-01T00:00:00Z", "2027-03-01T23:00:00Z")).toHaveLength(0);
  });

  test("digest delivery: no individual reminder emails (in-app still), escalations still email", () => {
    const data = baseData({
      prefs: [{ user_id: "d0000000-0000-4000-8000-000000000001", clock_id: ENV.id, enabled: true, channels: ["email", "in_app"], subscribe_all: false, delivery: "digest" }],
    });
    const r = plan(data, "2027-03-01T00:00:00Z", "2027-03-01T23:00:00Z").filter((i) => i.recipientId === "d0000000-0000-4000-8000-000000000001");
    expect(r.map((i) => i.channel)).toEqual(["in_app"]);
    const e = plan(data, "2027-04-01T00:00:00Z", "2027-04-01T23:00:00Z").filter((i) => i.recipientId === "d0000000-0000-4000-8000-000000000001");
    expect(e.map((i) => i.channel).sort()).toEqual(["email", "in_app"]);
  });

  test("Teams channel gets one clock-level post when configured", () => {
    const data = baseData({ clocks: [{ ...ENV, teams_enabled: true, has_teams_webhook: true }] });
    const teams = plan(data, "2027-03-01T00:00:00Z", "2027-03-01T23:00:00Z").filter((i) => i.channel === "teams");
    expect(teams).toHaveLength(1);
    expect(teams[0].recipientId).toBeNull();
  });

  test("weekly digest on Monday morning for users who enabled it", () => {
    const data = baseData({ users: [user("d0000000-0000-4000-8000-000000000001", { weekly_digest: true }), user("team")] });
    // 2027-03-01 is a Monday
    const d = plan(data, "2027-03-01T00:00:00Z", "2027-03-01T23:00:00Z").filter((i) => i.kind === "digest");
    expect(d).toEqual([expect.objectContaining({ recipientId: "d0000000-0000-4000-8000-000000000001", key: "digest:2027-W09", channel: "email" })]);
  });
});

// ---------------------------------------------------------------------------
// Job: idempotency, retries, tolerant window
// ---------------------------------------------------------------------------
function memoryRepo(data: PlannerData) {
  const log = new Map<string, { id: string; intent: NotificationIntent; status: string; attempts: number; next: Date | null }>();
  const runs: Array<{ id: string; status: string; windowEnd?: Date }> = [];
  const inApp: unknown[] = [];
  let n = 0;
  const repo: NotificationRepository = {
    async startRun() {
      const last = [...runs].reverse().find((r) => r.status === "success" && r.windowEnd);
      const id = `run-${runs.length + 1}`;
      runs.push({ id, status: "running" });
      return { runId: id, lastWindowEnd: last?.windowEnd ?? null };
    },
    async finishRun(id, r) {
      const run = runs.find((x) => x.id === id)!;
      run.status = r.status;
      run.windowEnd = r.windowEnd;
    },
    async loadPlannerData() {
      return data;
    },
    async claim(intent) {
      const k = intentKey(intent);
      if (log.has(k)) return null;
      const id = `log-${++n}`;
      log.set(k, { id, intent, status: "pending", attempts: 0, next: null });
      return { id };
    },
    async existing(intents) {
      return new Set(intents.map(intentKey).filter((k) => log.has(k)));
    },
    async markSent(id) {
      for (const e of log.values()) if (e.id === id) Object.assign(e, { status: "sent", attempts: e.attempts + 1 });
    },
    async markFailed(id, _err, attempts, next) {
      for (const e of log.values()) if (e.id === id) Object.assign(e, { status: "failed", attempts, next });
    },
    async markSkipped(id) {
      for (const e of log.values()) if (e.id === id) e.status = "skipped";
    },
    async loadRetryable(now, max) {
      return [...log.values()]
        .filter((e) => e.status === "failed" && e.attempts < max && e.next && e.next <= now)
        .map((e) => ({ id: e.id, attempts: e.attempts, intent: e.intent }));
    },
    async insertInApp(x) {
      inApp.push(x);
    },
    async getTeamsWebhook() {
      return null;
    },
    async digestItems() {
      return { upcoming: [], overdue: [] };
    },
  };
  return { repo, log, runs, inApp };
}

function recordingChannel(id: "email" | "in_app", failTimes = 0) {
  const sent: DeliveryContext[] = [];
  let failures = 0;
  const ch: NotificationChannel = {
    id,
    async send(ctx) {
      if (failures < failTimes) {
        failures++;
        throw new Error("provider down");
      }
      sent.push(ctx);
    },
  };
  return { ch, sent };
}

describe("notification job", () => {
  test("running the job twice in a row sends nothing the second time", async () => {
    const { repo } = memoryRepo(baseData());
    const email = recordingChannel("email");
    const inApp = recordingChannel("in_app");
    const deps = { repo, channels: { email: email.ch, in_app: inApp.ch }, tokenSecret: SECRET, baseUrl: "https://clock.test", log: () => {} };
    const now = new Date("2027-03-01T07:00:00Z");
    const first = await runNotificationJob(deps, { now, initialLookbackHours: 24 });
    expect(first.sent).toBe(4);
    expect(email.sent).toHaveLength(2);

    const second = await runNotificationJob(deps, { now: new Date("2027-03-01T07:05:00Z") });
    expect(second.sent).toBe(0);
    expect(email.sent).toHaveLength(2);

    // Even a full overlapping re-run of the same window sends nothing.
    const third = await runNotificationJob(deps, { now, initialLookbackHours: 48 });
    expect(third.sent).toBe(0);
  });

  test("tolerant to missed runs: catches up on everything since the last success", async () => {
    const { repo } = memoryRepo(baseData());
    const email = recordingChannel("email");
    const deps = { repo, channels: { email: email.ch }, tokenSecret: SECRET, baseUrl: "https://clock.test", log: () => {} };
    await runNotificationJob(deps, { now: new Date("2027-03-16T07:00:00Z") });
    // no run for a week; -14 (17th) and -7 (24th) both due by the 24th
    await runNotificationJob(deps, { now: new Date("2027-03-24T07:00:00Z") });
    expect(email.sent.map((c) => c.intent.key)).toEqual(["reminder:-14", "reminder:-14", "reminder:-7", "reminder:-7"]);
  });

  test("failed sends are retried with backoff and never duplicated", async () => {
    const { repo, log } = memoryRepo(baseData({ prefs: [], members: [{ clock_id: ENV.id, user_id: "d0000000-0000-4000-8000-000000000001", role: "admin" }] }));
    const email = recordingChannel("email", 1);
    const deps = { repo, channels: { email: email.ch }, tokenSecret: SECRET, baseUrl: "https://clock.test", log: () => {} };
    const r1 = await runNotificationJob(deps, { now: new Date("2027-03-01T07:00:00Z") });
    expect(r1.failed).toBe(1);
    // too early for retry (backoff 10 min)
    const r2 = await runNotificationJob(deps, { now: new Date("2027-03-01T07:05:00Z") });
    expect(r2.retried).toBe(0);
    const r3 = await runNotificationJob(deps, { now: new Date("2027-03-01T07:20:00Z") });
    expect(r3.retried).toBe(1);
    expect(r3.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect([...log.values()].filter((e) => e.intent.channel === "email").every((e) => e.status === "sent")).toBe(true);
  });

  test("dry run sends and claims nothing", async () => {
    const { repo, log } = memoryRepo(baseData());
    const email = recordingChannel("email");
    const deps = { repo, channels: { email: email.ch }, tokenSecret: SECRET, baseUrl: "https://clock.test", log: () => {} };
    const r = await runNotificationJob(deps, { now: new Date("2027-03-01T07:00:00Z"), dryRun: true });
    expect(r.preview?.filter((p) => p.status === "would_send").length).toBe(4);
    expect(email.sent).toHaveLength(0);
    expect(log.size).toBe(0);
  });

  test("reminder email contains signed, expiring mark-done link for the right occurrence and recipient", async () => {
    const { repo } = memoryRepo(baseData());
    const email = recordingChannel("email");
    const deps = { repo, channels: { email: email.ch }, tokenSecret: SECRET, baseUrl: "https://clock.test", log: () => {} };
    await runNotificationJob(deps, { now: new Date("2027-03-01T07:00:00Z") });
    const ctx = email.sent.find((c) => c.recipient?.id === "d0000000-0000-4000-8000-000000000001")!;
    const msg = renderEmail(ctx);
    expect(msg.subject).toContain("EUA verification due");
    expect(msg.subject).toContain("in 30 days");
    expect(msg.html).toContain("Mark done");
    expect(msg.html).toContain("Environmental");
    const token = ctx.links.done!.split("/a/")[1];
    const v = verifyActionToken(token, SECRET, Date.parse("2027-03-02T00:00:00Z"));
    expect(v.ok && v.payload).toMatchObject({ act: "done", aid: "a0000000-0000-4000-8000-000000000001", occ: "2027-03-31", uid: "d0000000-0000-4000-8000-000000000001" });
    expect(verifyActionToken(token, "y".repeat(40)).ok).toBe(false);
    expect(verifyActionToken(token, SECRET, Date.parse("2027-06-01T00:00:00Z"))).toEqual({ ok: false, reason: "expired" });
  });
});
