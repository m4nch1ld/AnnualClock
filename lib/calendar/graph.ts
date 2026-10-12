/**
 * Microsoft Graph calendar provider (target for the Azure / Entra ID deployment).
 *
 * Creates the event directly in the user's own Outlook calendar — no email
 * round-trip — and updates / deletes it via the stored Graph event id.
 *
 * Requirements (see docs/azure-migration.md → "Calendar"):
 *  - Users sign in with Entra ID; the app holds a delegated token with
 *    `Calendars.ReadWrite` + `offline_access` (refresh token stored server-side,
 *    encrypted) so background syncs (an activity moved by someone else) work.
 *  - `GraphTokenSource.getToken(userId)` returns a valid access token for that user.
 *
 * Not wired up in the prototype (CALENDAR_PROVIDER defaults to "ics_invite").
 */
import * as rruleNs from "rrule";
import { addDays, toUTCDate, fromUTCDate } from "../dates";
import type { CalendarEvent, CalendarLink, CalendarProvider } from "./types";

const rrule = ((rruleNs as unknown as { default?: typeof rruleNs }).default ?? rruleNs) as typeof rruleNs;

export interface GraphTokenSource {
  getToken(userId: string): Promise<string>;
}

type GraphRecurrence = {
  pattern: Record<string, unknown>;
  range: Record<string, unknown>;
};

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const INDEX = ["first", "second", "third", "fourth"];

/**
 * Convert an RRULE body to a Graph `patternedRecurrence`. Returns null for rules
 * Graph cannot express (callers then offer single-occurrence links instead).
 */
export function rruleToGraphRecurrence(body: string, start: string): GraphRecurrence | null {
  let o;
  try {
    o = rrule.RRule.parseString(body);
  } catch {
    return null;
  }
  const s = toUTCDate(start);
  const interval = o.interval ?? 1;
  const freq = rrule.RRule.FREQUENCIES[o.freq as number];
  const byday = (Array.isArray(o.byweekday) ? o.byweekday : o.byweekday != null ? [o.byweekday] : []) as Array<number | { weekday: number; n?: number }>;
  const days = byday.map((w) => WEEKDAYS[typeof w === "number" ? w : w.weekday]);
  const bymonthday = Array.isArray(o.bymonthday) ? o.bymonthday : o.bymonthday != null ? [o.bymonthday] : [];
  const bymonth = Array.isArray(o.bymonth) ? o.bymonth : o.bymonth != null ? [o.bymonth] : [];
  if (bymonthday.some((x) => x < 0) || bymonthday.length > 1 || bymonth.length > 1) return null;

  let pattern: Record<string, unknown>;
  switch (freq) {
    case "DAILY":
      pattern = { type: "daily", interval };
      break;
    case "WEEKLY":
      pattern = {
        type: "weekly",
        interval,
        daysOfWeek: days.length ? days : [WEEKDAYS[(s.getUTCDay() + 6) % 7]],
        firstDayOfWeek: "monday",
      };
      break;
    case "MONTHLY": {
      const rel = byday.find((w) => typeof w !== "number" && w.n);
      if (rel && typeof rel !== "number") {
        const n = rel.n!;
        if (n !== -1 && (n < 1 || n > 4)) return null;
        pattern = { type: "relativeMonthly", interval, daysOfWeek: [WEEKDAYS[rel.weekday]], index: n === -1 ? "last" : INDEX[n - 1] };
      } else {
        pattern = { type: "absoluteMonthly", interval, dayOfMonth: bymonthday[0] ?? s.getUTCDate() };
      }
      break;
    }
    case "YEARLY":
      pattern = { type: "absoluteYearly", interval, dayOfMonth: bymonthday[0] ?? s.getUTCDate(), month: bymonth[0] ?? s.getUTCMonth() + 1 };
      break;
    default:
      return null;
  }
  const range: Record<string, unknown> = o.until
    ? { type: "endDate", startDate: start, endDate: fromUTCDate(o.until) }
    : o.count
      ? { type: "numbered", startDate: start, numberOfOccurrences: o.count }
      : { type: "noEnd", startDate: start };
  return { pattern, range };
}

export function graphEventBody(ev: CalendarEvent, timeZone = "Europe/Helsinki") {
  const recurrence = ev.rrule ? rruleToGraphRecurrence(ev.rrule, ev.start) : null;
  if (ev.rrule && !recurrence) throw new Error("This repeat rule cannot be represented in Outlook; add a single occurrence instead.");
  return {
    subject: ev.summary,
    body: { contentType: "text", content: `${ev.description}\n\n${ev.url}` },
    start: { dateTime: `${ev.start}T00:00:00`, timeZone },
    end: { dateTime: `${addDays(ev.end, 1)}T00:00:00`, timeZone },
    isAllDay: true,
    showAs: "free",
    isReminderOn: false,
    categories: ["Annual Clock"],
    recurrence,
  };
}

export class GraphCalendarProvider implements CalendarProvider {
  readonly id = "graph" as const;
  constructor(
    private tokens: GraphTokenSource,
    private fetchImpl: typeof fetch = fetch,
    private base = "https://graph.microsoft.com/v1.0",
  ) {}

  private async call(userId: string, method: string, path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.tokens.getToken(userId)}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (method === "DELETE" && res.status === 404) return null; // already gone
    if (!res.ok) throw new Error(`Graph ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : ((await res.json()) as { id?: string });
  }

  async upsert(link: CalendarLink, ev: CalendarEvent) {
    const body = graphEventBody(ev);
    if (link.external_id) {
      await this.call(link.user_id, "PATCH", `/me/events/${encodeURIComponent(link.external_id)}`, body);
      return { externalId: link.external_id };
    }
    // transactionId makes event creation idempotent if a retry happens after a timeout.
    const created = await this.call(link.user_id, "POST", "/me/events", { ...body, transactionId: link.uid });
    return { externalId: created?.id ?? null };
  }

  async cancel(link: CalendarLink) {
    if (!link.external_id) return;
    await this.call(link.user_id, "DELETE", `/me/events/${encodeURIComponent(link.external_id)}`);
  }
}
