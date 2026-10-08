/** Occurrence state writes, shared by server actions and the email action-link endpoint. */
import type { Tx } from "@/lib/db";
import type { Activity } from "@/lib/domain";

export async function applyOccurrenceStatus(
  tx: Tx,
  input: { activity_id: string; occurrence_date: string; status: Activity["status"] },
  uid: string,
) {
  const done = input.status === "done";
  await tx.query(
    `insert into activity_occurrences_state (activity_id, occurrence_date, status, completed_at, completed_by, updated_by)
     values ($1, $2, $3, case when $4 then now() end, case when $4 then $5::uuid end, $5)
     on conflict (activity_id, occurrence_date) do update set status = excluded.status,
       completed_at = excluded.completed_at, completed_by = excluded.completed_by, updated_by = excluded.updated_by`,
    [input.activity_id, input.occurrence_date, input.status, done, uid],
  );
  // One-off activities mirror the status on the activity itself.
  await tx.query(
    `update activities set status = $2, completed_at = case when $3 then now() end, completed_by = case when $3 then $4::uuid end,
       updated_by = $4 where id = $1 and rrule is null and start_date = $5`,
    [input.activity_id, input.status, done, uid, input.occurrence_date],
  );
}

export async function applySnooze(tx: Tx, input: { activity_id: string; occurrence_date: string; until: string }, uid: string) {
  await tx.query(
    `insert into activity_occurrences_state (activity_id, occurrence_date, status, snoozed_until, updated_by)
     values ($1, $2, 'planned', $3, $4)
     on conflict (activity_id, occurrence_date) do update set snoozed_until = excluded.snoozed_until, updated_by = excluded.updated_by`,
    [input.activity_id, input.occurrence_date, input.until, uid],
  );
}

