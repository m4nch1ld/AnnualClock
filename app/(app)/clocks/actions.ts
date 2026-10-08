"use server";

/**
 * Activity mutations. Every write runs through withUser(), so Postgres RLS is
 * the authority on who may change what; input is validated with Zod first.
 */
import { z } from "zod";
import { requireSession } from "@/lib/server/session";
import { withUser, type Tx } from "@/lib/db";
import { getActivity } from "@/lib/data/clocks";
import { addDays, diffDays } from "@/lib/dates";
import { endSeriesBefore } from "@/lib/recurrence";
import { activityInput, moveInput, occurrenceStatusInput, snoozeInput, uuid } from "@/lib/validation";
import type { Activity } from "@/lib/domain";
import { applyOccurrenceStatus, applySnooze } from "@/lib/server/occurrences";

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
    `select user_id from clock_members where clock_id = $1 and user_id = any($2)`,
    [clockId, ids],
  );
  if (rows.length !== new Set(ids).size) throw new z.ZodError([{ code: "custom", path: ["owner_id"], message: "Owner and assignees must be members of the clock", input: ids }]);
}

async function setAssignees(tx: Tx, activityId: string, ids: string[]) {
  await tx.query(`delete from activity_assignees where activity_id = $1 and not (user_id = any($2))`, [activityId, ids]);
  for (const id of new Set(ids)) {
    await tx.query(`insert into activity_assignees (activity_id, user_id) values ($1, $2) on conflict do nothing`, [activityId, id]);
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
  const row = await tx.one<{ id: string }>(
    `insert into activities (clock_id, ring_id, title, description, type, start_date, end_date, all_day, start_time, end_time,
       rrule, owner_id, status, predecessor_id, reminder_offsets, tags, links, series_parent_id, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) returning id`,
    [
      clockId, f.ring_id, f.title, f.description, f.type, f.start_date, f.end_date, f.all_day, f.start_time, f.end_time,
      f.rrule, f.owner_id, f.status, f.predecessor_id, f.reminder_offsets, f.tags, JSON.stringify(f.links), seriesParent, uid,
    ],
  );
  return row!.id;
}

async function updateActivity(tx: Tx, id: string, f: Fields, uid: string) {
  const rows = await tx.query(
    `update activities set ring_id=$2, title=$3, description=$4, type=$5, start_date=$6, end_date=$7, all_day=$8,
       start_time=$9, end_time=$10, rrule=$11, owner_id=$12, status=$13, predecessor_id=$14, reminder_offsets=$15,
       tags=$16, links=$17, updated_by=$18
     where id = $1 and deleted_at is null returning id`,
    [
      id, f.ring_id, f.title, f.description, f.type, f.start_date, f.end_date, f.all_day, f.start_time, f.end_time,
      f.rrule, f.owner_id, f.status, f.predecessor_id, f.reminder_offsets, f.tags, JSON.stringify(f.links), uid,
    ],
  );
  if (!rows.length) throw Object.assign(new Error("row-level security: not updatable"), { code: "42501" });
}

/**
 * Split a recurring series at `fromDate`: the original ends the day before, a
 * new series (with `fields`) continues. Future per-occurrence state moves along.
 */
async function splitSeries(tx: Tx, existing: Activity, fromDate: string, fields: Fields, assignees: string[], uid: string) {
  await tx.query(`update activities set rrule = $2, updated_by = $3 where id = $1`, [
    existing.id,
    endSeriesBefore(existing.rrule!, fromDate),
    uid,
  ]);
  const newId = await insertActivity(tx, existing.clock_id, fields, uid, existing.id);
  await setAssignees(tx, newId, assignees);
  await tx.query(
    `update activity_occurrences_state set activity_id = $2, updated_by = $3 where activity_id = $1 and occurrence_date >= $4`,
    [existing.id, newId, uid, fromDate],
  );
  // successors of the old series now follow the new one
  await tx.query(`update activities set predecessor_id = $2, updated_by = $3 where predecessor_id = $1 and clock_id = $4`, [
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
    return await withUser(uid, async (tx) => {
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
          return { ok: true, id } as const;
        }
        // "all": the form shows the chosen occurrence's dates; shift the whole series by the same delta.
        const delta = diffDays(a.occurrence_date, a.start_date);
        const duration = fields.end_date ? diffDays(a.start_date, fields.end_date) : null;
        fields.start_date = addDays(existing.start_date, delta);
        fields.end_date = duration === null ? null : addDays(fields.start_date, duration);
      }
      await updateActivity(tx, a.id, fields, uid);
      await setAssignees(tx, a.id, a.assignee_ids);
      return { ok: true, id: a.id } as const;
    });
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
    return await withUser(uid, async (tx) => {
      const existing = await getActivity(tx, m.activity_id);
      if (!existing) return { ok: false, error: "Activity not found." } as const;
      const duration = m.new_end ? diffDays(m.new_start, m.new_end) : null;
      if (existing.rrule && m.scope === "future" && m.occurrence_date > existing.start_date) {
        const { assignee_ids, ...rest } = existing;
        const fields: Fields = { ...rest, start_date: m.new_start, end_date: m.new_end, links: existing.links };
        const id = await splitSeries(tx, existing, m.occurrence_date, fields, assignee_ids, uid);
        return { ok: true, id } as const;
      }
      const start = existing.rrule ? addDays(existing.start_date, diffDays(m.occurrence_date, m.new_start)) : m.new_start;
      const end = duration === null ? null : addDays(start, duration);
      const rows = await tx.query(
        `update activities set start_date = $2, end_date = $3, updated_by = $4 where id = $1 and deleted_at is null returning id`,
        [m.activity_id, start, end, uid],
      );
      if (!rows.length) return { ok: false, error: "You do not have permission to do that." } as const;
      return { ok: true, id: m.activity_id } as const;
    });
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
    const rows = await withUser(session.profile.id, (tx) =>
      tx.query(`update activities set deleted_at = now(), updated_by = $2 where id = $1 and deleted_at is null returning id`, [
        aid,
        session.profile.id,
      ]),
    );
    return rows.length ? { ok: true } : { ok: false, error: "You do not have permission to do that." };
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
    tx.query<{ id: number; action: string; entity: string; actor: string | null; created_at: string; diff: Record<string, unknown> }>(
      `select l.id, l.action, l.entity, coalesce(p.full_name, p.email) as actor, l.created_at::text, l.diff
       from audit_log l left join profiles p on p.id = l.actor_id
       where l.entity_id = $1 order by l.created_at desc, l.id desc limit 50`,
      [aid],
    ),
  );
  const ignore = new Set(["updated_by", "updated_at", "created_at", "id", "created_by", "clock_id", "is_demo"]);
  return rows.map((r) => {
    const fields = r.action === "update" ? Object.keys(r.diff).filter((k) => !ignore.has(k)) : [];
    let summary: string | null = null;
    if (r.entity === "activity_occurrences_state") {
      const d = r.diff as Record<string, unknown>;
      const status = (d.status as { to?: string })?.to ?? (d.status as string | undefined);
      const occ = (d.occurrence_date as string | undefined) ?? "";
      const snooze = (d.snoozed_until as { to?: string })?.to ?? (d.snoozed_until as string | undefined);
      summary = snooze ? `Snoozed until ${snooze}` : status ? `Occurrence ${occ} → ${status}`.trim() : null;
    }
    if (r.entity === "activity_assignees") summary = r.action === "insert" ? "Assignee added" : "Assignee removed";
    return { id: r.id, action: r.action, entity: r.entity, actor: r.actor, created_at: r.created_at, fields, summary };
  });
}
