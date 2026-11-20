"use server";

/**
 * Activity mutations. Every write runs through withUser(), so Postgres RLS is
 * the authority on who may change what; input is validated with Zod first.
 */
import { z } from "zod";
import { requireSession } from "@/lib/server/session";
import { randomUUID } from "node:crypto";
import { S, withUser, type Tx } from "@/lib/db";
import { getActivity, inJson } from "@/lib/data/clocks";
import { addDays, diffDays } from "@/lib/dates";
import { endSeriesBefore } from "@/lib/recurrence";
import { activityInput, moveInput, occurrenceStatusInput, snoozeInput, uuid } from "@/lib/validation";
import type { Activity } from "@/lib/domain";
import { applyOccurrenceStatus, applySnooze } from "@/lib/server/occurrences";
import { syncCalendarAfter, type CalendarChange } from "@/lib/server/calendar-hooks";

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

function fail(e: unknown): ActionResult {
  if (e instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of e.issues) fieldErrors[issue.path.join(".") || "_"] = issue.message;
    return { ok: false, error: "Please check the highlighted fields.", fieldErrors };
  }
  const err = e as { code?: string; message?: string };
  if (err.code === "42501" || /row-level security/.test(err.message ?? "")) {
    return { ok: false, error: "You do not have permission to do that." };
  }
  if (err.code === "23503") return { ok: false, error: "The ring, owner or predecessor is not valid for this clock." };
  console.error(JSON.stringify({ level: "error", msg: "activity action failed", error: String(err.message ?? e) }));
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function assertMembers(tx: Tx, clockId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx.query<{ user_id: string }>(
    `select user_id from ${S}.clock_members where clock_id = $1 and user_id in ${inJson("$2")}`,
    [clockId, ids],
  );
  if (rows.length !== new Set(ids).size) throw new z.ZodError([{ code: "custom", path: ["owner_id"], message: "Owner and assignees must be members of the clock", input: ids }]);
}

async function setAssignees(tx: Tx, activityId: string, ids: string[]) {
  await tx.exec(`delete from ${S}.activity_assignees where activity_id = $1 and user_id not in ${inJson("$2")}`, [activityId, ids]);
  for (const id of new Set(ids)) {
    await tx.exec(
      `insert into ${S}.activity_assignees (activity_id, clock_id, user_id)
       select a.id, a.clock_id, $2 from ${S}.activities a
       where a.id = $1 and not exists (select 1 from ${S}.activity_assignees x where x.activity_id = $1 and x.user_id = $2)`,
      [activityId, id],
    );
  }
}

type Fields = {
  ring_id: string;
  title: string;
  description: string | null;
  type: Activity["type"];
  start_date: string;
  end_date: string | null;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  rrule: string | null;
  owner_id: string | null;
  status: Activity["status"];
  predecessor_id: string | null;
  reminder_offsets: number[] | null;
  tags: string[];
  links: Array<{ label?: string; url: string }>;
};

async function insertActivity(tx: Tx, clockId: string, f: Fields, uid: string, seriesParent: string | null = null) {
  const id = randomUUID();
  await tx.exec(
    `insert into ${S}.activities (id, clock_id, ring_id, title, description, type, start_date, end_date, all_day, start_time, end_time,
       rrule, owner_id, status, predecessor_id, reminder_offsets, tags, links, series_parent_id, created_by, updated_by)
     values ($20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
    [
      clockId, f.ring_id, f.title, f.description, f.type, f.start_date, f.end_date, f.all_day, f.start_time, f.end_time,
      f.rrule, f.owner_id, f.status, f.predecessor_id, f.reminder_offsets, f.tags, JSON.stringify(f.links), seriesParent, uid, id,
    ],
  );
  return id;
}

async function updateActivity(tx: Tx, id: string, f: Fields, uid: string) {
  const n = await tx.exec(
    `update ${S}.activities set ring_id=$2, title=$3, description=$4, type=$5, start_date=$6, end_date=$7, all_day=$8,
       start_time=$9, end_time=$10, rrule=$11, owner_id=$12, status=$13, predecessor_id=$14, reminder_offsets=$15,
       tags=$16, links=$17, updated_by=$18, updated_at=sysdatetimeoffset()
     where id = $1 and deleted_at is null`,
    [
      id, f.ring_id, f.title, f.description, f.type, f.start_date, f.end_date, f.all_day, f.start_time, f.end_time,
      f.rrule, f.owner_id, f.status, f.predecessor_id, f.reminder_offsets, f.tags, JSON.stringify(f.links), uid,
    ],
  );
  if (!n) throw Object.assign(new Error("row-level security: not updatable"), { code: "42501" });
}

/**
 * Split a recurring series at `fromDate`: the original ends the day before, a
 * new series (with `fields`) continues. Future per-occurrence state moves along.
 */
async function splitSeries(tx: Tx, existing: Activity, fromDate: string, fields: Fields, assignees: string[], uid: string) {
  await tx.exec(`update ${S}.activities set rrule = $2, updated_by = $3, updated_at = sysdatetimeoffset() where id = $1`, [
    existing.id,
    endSeriesBefore(existing.rrule!, fromDate),
    uid,
  ]);
  const newId = await insertActivity(tx, existing.clock_id, fields, uid, existing.id);
  await setAssignees(tx, newId, assignees);
  await tx.exec(
    `update ${S}.activity_occurrences_state set activity_id = $2, updated_by = $3, updated_at = sysdatetimeoffset()
     where activity_id = $1 and occurrence_date >= $4`,
    [existing.id, newId, uid, fromDate],
  );
  // successors of the old series now follow the new one
  await tx.exec(`update ${S}.activities set predecessor_id = $2, updated_by = $3, updated_at = sysdatetimeoffset() where predecessor_id = $1 and clock_id = $4`, [
    existing.id,
    newId,
    uid,
    existing.clock_id,
  ]);
  return newId;
}

export async function saveActivity(raw: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const uid = session.profile.id;
    const a = activityInput.parse(raw);
    const fields: Fields = {
      ring_id: a.ring_id,
      title: a.title,
      description: a.description,
      type: a.type,
      start_date: a.start_date,
      end_date: a.type === "period" ? a.end_date : a.end_date && a.end_date !== a.start_date ? a.end_date : null,
      all_day: a.all_day,
      start_time: a.all_day ? null : a.start_time,
      end_time: a.all_day ? null : a.end_time,
      rrule: a.rrule,
      owner_id: a.owner_id,
      status: a.status,
      predecessor_id: a.predecessor_id,
      reminder_offsets: a.reminder_offsets,
      tags: a.tags,
      links: a.links,
    };
    let change: CalendarChange | null = null;
    const result = await withUser(uid, async (tx) => {
      await assertMembers(tx, a.clock_id, [...(a.owner_id ? [a.owner_id] : []), ...a.assignee_ids]);
      if (!a.id) {
        const id = await insertActivity(tx, a.clock_id, fields, uid);
        await setAssignees(tx, id, a.assignee_ids);
        return { ok: true, id } as const;
      }
      const existing = await getActivity(tx, a.id);
      if (!existing || existing.clock_id !== a.clock_id) return { ok: false, error: "Activity not found." } as const;

      if (existing.rrule && a.occurrence_date) {
        if (a.scope === "future" && a.occurrence_date > existing.start_date) {
          const id = await splitSeries(tx, existing, a.occurrence_date, fields, a.assignee_ids, uid);
          change = { activityIds: [existing.id, id], split: { fromId: existing.id, toId: id } };
          return { ok: true, id } as const;
        }
        // "all": the form shows the chosen occurrence's dates; shift the whole series by the same delta.
        const delta = diffDays(a.occurrence_date, a.start_date);
        const duration = fields.end_date ? diffDays(a.start_date, fields.end_date) : null;
        fields.start_date = addDays(existing.start_date, delta);
        fields.end_date = duration === null ? null : addDays(fields.start_date, duration);
        if (delta) change = { activityIds: [a.id], shift: { activityId: a.id, days: delta } };
      }
      await updateActivity(tx, a.id, fields, uid);
      await setAssignees(tx, a.id, a.assignee_ids);
      change ??= { activityIds: [a.id] };
      return { ok: true, id: a.id } as const;
    });
    if (result.ok) syncCalendarAfter(change);
    return result;
  } catch (e) {
    return fail(e);
  }
}

/** Drag on the wheel: move/resize an occurrence (whole series, or this and future). */
export async function moveActivity(raw: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const uid = session.profile.id;
    const m = moveInput.parse(raw);
    if (m.new_end && m.new_end < m.new_start) return { ok: false, error: "End date must be on or after start date." };
    let change: CalendarChange | null = null;
    const result = await withUser(uid, async (tx) => {
      const existing = await getActivity(tx, m.activity_id);
      if (!existing) return { ok: false, error: "Activity not found." } as const;
      const duration = m.new_end ? diffDays(m.new_start, m.new_end) : null;
      if (existing.rrule && m.scope === "future" && m.occurrence_date > existing.start_date) {
        const { assignee_ids, ...rest } = existing;
        const fields: Fields = { ...rest, start_date: m.new_start, end_date: m.new_end, links: existing.links };
        const id = await splitSeries(tx, existing, m.occurrence_date, fields, assignee_ids, uid);
        change = { activityIds: [existing.id, id], split: { fromId: existing.id, toId: id } };
        return { ok: true, id } as const;
      }
      const start = existing.rrule ? addDays(existing.start_date, diffDays(m.occurrence_date, m.new_start)) : m.new_start;
      const end = duration === null ? null : addDays(start, duration);
      const n = await tx.exec(
        `update ${S}.activities set start_date = $2, end_date = $3, updated_by = $4, updated_at = sysdatetimeoffset()
         where id = $1 and deleted_at is null`,
        [m.activity_id, start, end, uid],
      );
      if (!n) return { ok: false, error: "You do not have permission to do that." } as const;
      const shift = diffDays(existing.start_date, start);
      change = { activityIds: [m.activity_id], ...(existing.rrule && shift ? { shift: { activityId: m.activity_id, days: shift } } : {}) };
      return { ok: true, id: m.activity_id } as const;
    });
    if (result.ok) syncCalendarAfter(change);
    return result;
  } catch (e) {
    return fail(e);
  }
}

/** Complete / reopen / cancel a single occurrence (series stays untouched). */
export async function setOccurrenceStatus(raw: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const input = occurrenceStatusInput.parse(raw);
    await withUser(session.profile.id, (tx) => applyOccurrenceStatus(tx, input, session.profile.id));
    syncCalendarAfter({ activityIds: [input.activity_id] });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function snoozeOccurrence(raw: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const input = snoozeInput.parse(raw);
    await withUser(session.profile.id, (tx) => applySnooze(tx, input, session.profile.id));
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteActivity(id: string): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const aid = uuid.parse(id);
    const n = await withUser(session.profile.id, (tx) =>
      tx.exec(
        `update ${S}.activities set deleted_at = sysdatetimeoffset(), updated_by = $2, updated_at = sysdatetimeoffset()
         where id = $1 and deleted_at is null`,
        [aid, session.profile.id],
      ),
    );
    if (!n) return { ok: false, error: "You do not have permission to do that." };
    syncCalendarAfter({ activityIds: [aid] }); // sends cancellations
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export interface HistoryEntry {
  id: number;
  action: string;
  entity: string;
  actor: string | null;
  created_at: string;
  fields: string[];
  summary: string | null;
}

export async function getActivityHistory(id: string): Promise<HistoryEntry[]> {
  const session = await requireSession();
  const aid = uuid.parse(id);
  const rows = await withUser(session.profile.id, (tx) =>
    tx.query<{ id: number; action: string; entity: string; actor: string | null; created_at: string; diff: AuditDiff }>(
      `select top (50) l.id, l.action, l.entity, coalesce(p.full_name, p.email) as actor, l.created_at, l.diff
       from ${S}.audit_log l left join ${S}.profiles p on p.id = l.actor_id
       where l.entity_id = $1 order by l.created_at desc, l.id desc`,
      [aid],
    ),
  );
  return rows.map(toHistoryEntry).filter((h): h is HistoryEntry => h !== null);
}

type AuditRow = Record<string, unknown>;
type AuditDiff = { before?: AuditRow | null; after?: AuditRow | null };
const IGNORED_FIELDS = new Set(["updated_by", "updated_at", "created_at", "id", "created_by", "clock_id", "is_demo", "completed_at", "completed_by"]);

/** Turn an audit row ({before, after} snapshots) into a readable history entry; null for no-op updates. */
function toHistoryEntry(r: { id: number; action: string; entity: string; actor: string | null; created_at: string; diff: AuditDiff }): HistoryEntry | null {
  const before = r.diff?.before ?? {};
  const after = r.diff?.after ?? {};
  const changed = Object.keys({ ...before, ...after }).filter(
    (k) => !IGNORED_FIELDS.has(k) && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  let summary: string | null = null;
  if (r.entity === "activity_occurrences_state") {
    const occ = String(after.occurrence_date ?? before.occurrence_date ?? "");
    if (changed.includes("snoozed_until") && after.snoozed_until) summary = `Snoozed until ${after.snoozed_until}`;
    else if (changed.includes("status") || r.action === "insert") summary = `Occurrence ${occ} → ${after.status ?? before.status}`;
    else if (r.action === "update") return null;
  } else if (r.entity === "activity_assignees") {
    summary = r.action === "insert" ? "Assignee added" : "Assignee removed";
  } else if (r.action === "update" && changed.length === 0) {
    return null;
  }
  return { id: r.id, action: r.action, entity: r.entity, actor: r.actor, created_at: r.created_at, fields: r.action === "update" ? changed : [], summary };
}

// ---------------------------------------------------------------------------
// "Add to my Outlook"
// ---------------------------------------------------------------------------
const calendarInput = z.object({
  activity_id: uuid,
  scope: z.enum(["series", "occurrence"]),
  occurrence_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

/** Put an activity (all occurrences) or one occurrence into the user's own calendar. Anyone who can read the clock may. */
export async function addToMyCalendar(raw: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const p = calendarInput.parse(raw);
    const a = await withUser(session.profile.id, (tx) => getActivity(tx, p.activity_id)); // RLS: must be readable
    if (!a) return { ok: false, error: "Activity not found." };
    const scope = a.rrule ? p.scope : "series";
    if (scope === "occurrence" && !p.occurrence_date) return { ok: false, error: "Missing occurrence date." };
    const { calendar } = await import("@/lib/calendar");
    const r = await calendar.add({
      userId: session.profile.id,
      activityId: a.id,
      scope,
      occurrenceDate: scope === "occurrence" ? p.occurrence_date : null,
    });
    // Provider details are logged server-side (job: calendar); the link stays queued and is retried by the scheduler.
    return r.ok ? { ok: true, id: r.linkId } : { ok: false, error: "The calendar invitation could not be delivered right now. It will be retried automatically." };
  } catch (e) {
    return fail(e);
  }
}

export async function removeFromMyCalendar(raw: unknown): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const p = calendarInput.parse(raw);
    const { calendar } = await import("@/lib/calendar");
    const r = await calendar.remove({ userId: session.profile.id, activityId: p.activity_id, occurrenceDate: p.scope === "occurrence" ? p.occurrence_date : null });
    if (!r.ok) console.error(JSON.stringify({ level: "warn", job: "calendar", msg: "remove failed", error: r.error }));
    return r.ok ? { ok: true } : { ok: false, error: "Could not remove it from your calendar right now. Please try again later." };
  } catch (e) {
    return fail(e);
  }
}
