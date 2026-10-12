/**
 * Keeps users' personal calendar entries in line with the clock.
 *
 *  addLink()       user clicks "Add to my Outlook"   → invite / Graph create
 *  removeLink()    user clicks "Remove"              → cancel / Graph delete
 *  syncActivity()  after any change to an activity   → update (only if content changed) or cancel
 *                  (deleted, cancelled, occurrence gone, user lost access)
 *  retryFailed()   from the scheduler                → re-sync links whose last attempt failed
 */
import { createHash, randomUUID } from "node:crypto";
import { addDays, diffDays, todayInZone, type ISODate } from "../dates";
import { expandOccurrences } from "../recurrence";
import type { ActivitySyncContext, CalendarEvent, CalendarLink, CalendarProvider, CalendarRepository, LinkScope } from "./types";

export interface CalendarDeps {
  repo: CalendarRepository;
  provider: CalendarProvider;
  baseUrl: string;
  organizer: { email: string; name: string };
  log?: (e: Record<string, unknown>) => void;
}

type Ctx = NonNullable<ActivitySyncContext["activity"]>;
type LinkWithUser = ActivitySyncContext["links"][number];

const defaultLog = (e: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), job: "calendar", ...e }));

export const newUid = () => `${randomUUID()}@annual-clock.eslshipping`;

/** Dates for a link, or null if the occurrence no longer exists. */
export function linkDates(a: Pick<Ctx, "start_date" | "end_date" | "rrule">, link: Pick<CalendarLink, "scope" | "occurrence_date">) {
  const duration = a.end_date ? diffDays(a.start_date, a.end_date) : 0;
  if (link.scope === "series") return { start: a.start_date, end: a.end_date ?? a.start_date, rrule: a.rrule };
  const occ = link.occurrence_date!;
  const exists = expandOccurrences(a, occ, occ).some((o) => o.date === occ);
  return exists ? { start: occ, end: addDays(occ, duration), rrule: null } : null;
}

export function buildEvent(deps: Pick<CalendarDeps, "baseUrl" | "organizer">, a: Ctx, link: LinkWithUser): CalendarEvent | null {
  const dates = linkDates(a, link);
  if (!dates) return null;
  const base = deps.baseUrl.replace(/\/$/, "");
  const focus = link.scope === "occurrence" ? link.occurrence_date! : dates.start;
  return {
    uid: link.uid,
    sequence: link.sequence,
    summary: `${a.title} · ${a.clock_name}`,
    description: [
      `${a.clock_name} annual clock · ${a.ring_name}`,
      ...(a.description ? ["", a.description] : []),
      "",
      "Kept up to date by ESL Annual Clock — changes in the clock update or remove this event. Reminders arrive by email.",
    ].join("\n"),
    start: dates.start,
    end: dates.end,
    rrule: dates.rrule,
    url: `${base}/clocks/${a.clock_slug}?year=${focus.slice(0, 4)}&focus=${a.id}:${focus}`,
    organizer: deps.organizer,
    attendee: { email: link.user_email, name: link.user_name ?? link.user_email },
  };
}

export function contentHash(ev: CalendarEvent): string {
  const { summary, description, start, end, rrule, url } = ev;
  return createHash("sha256").update(JSON.stringify({ summary, description, start, end, rrule, url })).digest("hex").slice(0, 32);
}

/** Minimal event used to cancel when the activity or occurrence is gone. */
function cancelEvent(deps: Pick<CalendarDeps, "baseUrl" | "organizer">, a: Ctx | null, link: LinkWithUser): CalendarEvent {
  const start = link.occurrence_date ?? a?.start_date ?? todayInZone();
  return {
    uid: link.uid,
    sequence: link.sequence + 1,
    summary: a ? `${a.title} · ${a.clock_name}` : "Annual Clock activity",
    description: "Removed in ESL Annual Clock.",
    start,
    end: start,
    rrule: link.scope === "series" ? (a?.rrule ?? null) : null,
    url: `${deps.baseUrl.replace(/\/$/, "")}/clocks`,
    organizer: deps.organizer,
    attendee: { email: link.user_email, name: link.user_name ?? link.user_email },
  };
}

export interface SyncResult {
  created: number;
  updated: number;
  cancelled: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

export async function syncActivity(deps: CalendarDeps, activityId: string, onlyLinkId?: string): Promise<SyncResult> {
  const log = deps.log ?? defaultLog;
  const res: SyncResult = { created: 0, updated: 0, cancelled: 0, unchanged: 0, failed: 0, errors: [] };
  const ctx = await deps.repo.loadActivityContext(activityId);
  const a = ctx.activity;
  for (const link of ctx.links) {
    if (onlyLinkId && link.id !== onlyLinkId) continue;
    const alive = !!a && !a.deleted && a.status !== "cancelled" && link.user_can_read;
    const ev = alive ? buildEvent(deps, a!, link) : null;
    try {
      if (!ev) {
        // Never delivered → nothing to cancel in the user's calendar.
        if (link.content_hash) await deps.provider.cancel(link, cancelEvent(deps, a, link));
        await deps.repo.updateLink(link.id, { status: "removed", sequence: link.sequence + 1, last_error: null, synced: true });
        res.cancelled++;
        log({ level: "info", msg: "calendar link cancelled", linkId: link.id, activityId });
        continue;
      }
      const hash = contentHash(ev);
      if (hash === link.content_hash && !link.last_error) {
        res.unchanged++;
        continue;
      }
      const isNew = !link.content_hash;
      const sequence = isNew ? link.sequence : link.sequence + 1;
      const out = await deps.provider.upsert(link, { ...ev, sequence }, isNew);
      await deps.repo.updateLink(link.id, {
        sequence,
        content_hash: hash,
        external_id: out.externalId ?? link.external_id,
        last_error: null,
        synced: true,
      });
      if (isNew) res.created++;
      else res.updated++;
      log({ level: "info", msg: isNew ? "calendar event created" : "calendar event updated", linkId: link.id, activityId, sequence });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await deps.repo.updateLink(link.id, { last_error: error.slice(0, 1000) });
      res.failed++;
      res.errors.push(error);
      log({ level: "warn", msg: "calendar sync failed", linkId: link.id, activityId, error });
    }
  }
  return res;
}

export async function addLink(
  deps: CalendarDeps,
  input: { userId: string; activityId: string; scope: LinkScope; occurrenceDate: ISODate | null },
): Promise<{ ok: true; linkId: string } | { ok: false; error: string }> {
  const occ = input.scope === "occurrence" ? input.occurrenceDate : null;
  let link = await deps.repo.findActiveLink(input.userId, input.activityId, occ);
  if (!link) {
    link = await deps.repo.insertLink({
      user_id: input.userId,
      activity_id: input.activityId,
      scope: input.scope,
      occurrence_date: occ,
      provider: deps.provider.id,
      uid: newUid(),
    });
  }
  const r = await syncActivity(deps, input.activityId, link.id);
  if (r.failed) return { ok: false, error: r.errors[0] ?? "Could not add to calendar" };
  return { ok: true, linkId: link.id };
}

export async function removeLink(deps: CalendarDeps, input: { userId: string; activityId: string; occurrenceDate: ISODate | null }) {
  const link = await deps.repo.findActiveLink(input.userId, input.activityId, input.occurrenceDate);
  if (!link) return { ok: true as const };
  const ctx = await deps.repo.loadActivityContext(input.activityId);
  const full = ctx.links.find((l) => l.id === link.id);
  try {
    if (full && full.content_hash) await deps.provider.cancel(full, cancelEvent(deps, ctx.activity, full));
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
  await deps.repo.updateLink(link.id, { status: "removed", sequence: link.sequence + 1, last_error: null, synced: true });
  return { ok: true as const };
}

/** Called from the scheduler: retry links whose last sync failed. */
export async function retryFailed(deps: CalendarDeps, limit = 50) {
  const ids = await deps.repo.activityIdsWithFailedLinks(limit);
  const total: SyncResult = { created: 0, updated: 0, cancelled: 0, unchanged: 0, failed: 0, errors: [] };
  for (const id of ids) {
    const r = await syncActivity(deps, id);
    for (const k of ["created", "updated", "cancelled", "unchanged", "failed"] as const) total[k] += r[k];
  }
  return { activities: ids.length, ...total, errors: undefined };
}
