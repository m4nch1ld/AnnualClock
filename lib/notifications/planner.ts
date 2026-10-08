/**
 * Pure notification planner: given the data and a send-time window, decide
 * which (occurrence, reminder, recipient, channel) deliveries are due.
 * No I/O — fully unit-testable.
 */
import { TZDate } from "@date-fns/tz";
import { addDays, isoWeek, todayInZone, toUTCDate, type ISODate } from "../dates";
import { buildOccurrences, isClosed, reminderOffsets, type Occurrence } from "../domain";
import type { ChannelId, ClockInfo, NotificationIntent, PlannerInput, PrefInfo, UserInfo } from "./types";

const USER_CHANNELS: ChannelId[] = ["email", "in_app"];
const DEFAULT_PREF: Omit<PrefInfo, "user_id" | "clock_id"> = {
  enabled: true,
  channels: ["email", "in_app"],
  subscribe_all: false,
  delivery: "individual",
};

/** The instant at which local time `hhmm` occurs on `date` in `timeZone` (DST-aware). */
export function zonedInstant(date: ISODate, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, timeZone).getTime());
}

/** Largest reminder offset / escalation offset used, to size the occurrence range. */
function horizon(input: PlannerInput) {
  let maxReminder = 0;
  for (const c of input.clocks) maxReminder = Math.max(maxReminder, ...c.default_reminder_offsets, 0);
  for (const a of input.activities) maxReminder = Math.max(maxReminder, ...(a.reminder_offsets ?? []), 0);
  let maxEscalation = 0;
  for (const c of input.clocks) maxEscalation = Math.max(maxEscalation, ...(c.escalation_config?.offsets_days ?? []), 0);
  return { maxReminder, maxEscalation };
}

export function occurrenceRange(input: Pick<PlannerInput, "now" | "windowStart" | "timeZone">, maxReminder: number, maxEscalation: number) {
  const from = addDays(todayInZone(input.timeZone, input.windowStart), -maxEscalation - 1);
  const to = addDays(todayInZone(input.timeZone, input.now), maxReminder + 1);
  return { from, to };
}

export function planNotifications(input: PlannerInput): NotificationIntent[] {
  const { now, windowStart, timeZone } = input;
  const inWindow = (t: Date) => t.getTime() > windowStart.getTime() && t.getTime() <= now.getTime();
  const { maxReminder, maxEscalation } = horizon(input);
  const { from, to } = occurrenceRange(input, maxReminder, maxEscalation);
  const today = todayInZone(timeZone, now);

  const users = new Map(input.users.map((u) => [u.id, u]));
  const clocks = new Map(input.clocks.map((c) => [c.id, c]));
  const prefs = new Map(input.prefs.map((p) => [`${p.user_id}:${p.clock_id}`, p]));
  const roles = new Map(input.members.map((m) => [`${m.user_id}:${m.clock_id}`, m.role]));
  const gmUsers = input.users.filter((u) => u.is_active && u.all_clocks_viewer);

  const prefOf = (userId: string, clockId: string): PrefInfo => prefs.get(`${userId}:${clockId}`) ?? { user_id: userId, clock_id: clockId, ...DEFAULT_PREF };
  const canRead = (u: UserInfo, clockId: string) =>
    u.is_active && (u.global_role === "super_admin" || u.all_clocks_viewer || roles.has(`${u.id}:${clockId}`));
  const canAct = (u: UserInfo, clockId: string) => {
    const r = roles.get(`${u.id}:${clockId}`);
    return u.global_role === "super_admin" || r === "editor" || r === "admin";
  };

  const out: NotificationIntent[] = [];
  const occurrences = buildOccurrences(
    input.activities.filter((a) => a.status !== "cancelled"),
    input.states,
    from,
    to,
    today,
  );

  // Recipients for reminders: owner, assignees, and members subscribed to the whole clock.
  const reminderRecipients = (o: Occurrence): UserInfo[] => {
    const ids = new Set<string>();
    if (o.activity.owner_id) ids.add(o.activity.owner_id);
    for (const id of o.activity.assignee_ids) ids.add(id);
    for (const m of input.members) {
      if (m.clock_id === o.activity.clock_id && prefOf(m.user_id, m.clock_id).subscribe_all) ids.add(m.user_id);
    }
    return [...ids]
      .map((id) => users.get(id))
      .filter((u): u is UserInfo => !!u && canRead(u, o.activity.clock_id) && prefOf(u.id, o.activity.clock_id).enabled);
  };

  const pushUserIntents = (
    base: Omit<NotificationIntent, "channel" | "recipientId" | "canAct">,
    recipients: UserInfo[],
    opts: { respectDigest: boolean },
  ) => {
    for (const u of recipients) {
      const p = prefOf(u.id, base.clockId!);
      for (const ch of USER_CHANNELS) {
        if (!p.channels.includes(ch)) continue;
        if (ch === "email" && opts.respectDigest && p.delivery === "digest") continue;
        out.push({ ...base, channel: ch, recipientId: u.id, canAct: canAct(u, base.clockId!) });
      }
    }
  };

  const pushTeams = (base: Omit<NotificationIntent, "channel" | "recipientId" | "canAct">, clock: ClockInfo) => {
    if (clock.teams_enabled && clock.has_teams_webhook) out.push({ ...base, channel: "teams", recipientId: null, canAct: false });
  };

  for (const o of occurrences) {
    if (isClosed(o.status)) continue;
    const clock = clocks.get(o.activity.clock_id);
    if (!clock) continue;
    const sendTime = clock.default_send_time || "08:00";
    const common = {
      clockId: clock.id,
      activityId: o.activity.id,
      occurrenceDate: o.date,
      endDate: o.endDate,
      dueDate: o.dueDate,
    };

    // 1) Reminders N days before the occurrence date (suppressed while snoozed).
    for (const d of reminderOffsets(o.activity, clock)) {
      const sendDate = addDays(o.date, -d);
      if (o.snoozedUntil && sendDate < o.snoozedUntil) continue;
      const at = zonedInstant(sendDate, sendTime, timeZone);
      if (!inWindow(at)) continue;
      const base = { ...common, kind: "reminder" as const, key: `reminder:-${d}`, sendAt: at.toISOString(), offsetDays: d };
      pushUserIntents(base, reminderRecipients(o), { respectDigest: true });
      pushTeams(base, clock);
    }

    // 2) Snoozed: one reminder on the snooze date.
    if (o.snoozedUntil && o.snoozedUntil <= o.dueDate) {
      const at = zonedInstant(o.snoozedUntil, sendTime, timeZone);
      if (inWindow(at)) {
        const base = { ...common, kind: "snooze" as const, key: `snooze:${o.snoozedUntil}`, sendAt: at.toISOString() };
        pushUserIntents(base, reminderRecipients(o), { respectDigest: false });
      }
    }

    // 3) Escalation after the due date if still not done.
    const esc = clock.escalation_config;
    if (esc?.enabled) {
      for (const e of [...new Set(esc.offsets_days)].filter((n) => Number.isInteger(n) && n > 0)) {
        const at = zonedInstant(addDays(o.dueDate, e), sendTime, timeZone);
        if (!inWindow(at)) continue;
        const recipients = new Map<string, UserInfo>();
        if (esc.notify_admins) {
          for (const m of input.members) {
            const u = users.get(m.user_id);
            if (m.clock_id === clock.id && m.role === "admin" && u?.is_active) recipients.set(u.id, u);
          }
        }
        if (esc.notify_general_management) for (const u of gmUsers) recipients.set(u.id, u);
        const base = { ...common, kind: "escalation" as const, key: `escalation:+${e}`, sendAt: at.toISOString(), offsetDays: e };
        // Escalations always go out individually (email + in-app), regardless of digest/opt-out.
        for (const u of recipients.values()) {
          for (const ch of USER_CHANNELS) out.push({ ...base, channel: ch, recipientId: u.id, canAct: canAct(u, clock.id) });
        }
        pushTeams(base, clock);
      }
    }
  }

  // 4) Weekly digest on Monday at the digest send time.
  const mondays = mondaysBetween(todayInZone(timeZone, windowStart), today);
  for (const monday of mondays) {
    const at = zonedInstant(monday, input.digestSendTime, timeZone);
    if (!inWindow(at)) continue;
    const w = isoWeek(monday);
    for (const u of input.users) {
      if (!u.is_active || !u.weekly_digest) continue;
      out.push({
        kind: "digest",
        key: `digest:${w.year}-W${String(w.week).padStart(2, "0")}`,
        channel: "email",
        clockId: null,
        activityId: null,
        occurrenceDate: monday,
        recipientId: u.id,
        sendAt: at.toISOString(),
      });
    }
  }

  return out;
}

function mondaysBetween(from: ISODate, to: ISODate): ISODate[] {
  const res: ISODate[] = [];
  let d = from;
  while ((toUTCDate(d).getUTCDay() + 6) % 7 !== 0) d = addDays(d, 1);
  for (; d <= to; d = addDays(d, 7)) res.push(d);
  return res;
}
