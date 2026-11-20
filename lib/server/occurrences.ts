/** Occurrence state writes, shared by server actions and the email action-link endpoint. */
import { S, type Tx } from "@/lib/db";
import type { Activity } from "@/lib/domain";

/** Resolve the activity's clock (RLS: must be visible to the caller) or fail with "permission denied". */
const CLOCK_OF = `
DECLARE @clock uniqueidentifier = (SELECT clock_id FROM ${S}.activities WHERE id = $1);
IF @clock IS NULL THROW 50001, N'permission denied: activity not found', 1;`;

export async function applyOccurrenceStatus(
  tx: Tx,
  input: { activity_id: string; occurrence_date: string; status: Activity["status"] },
  uid: string,
) {
  const done = input.status === "done";
  await tx.exec(
    `${CLOCK_OF}
     UPDATE ${S}.activity_occurrences_state WITH (UPDLOCK, HOLDLOCK)
       SET status = $3, completed_at = CASE WHEN $4 = 1 THEN sysdatetimeoffset() END,
           completed_by = CASE WHEN $4 = 1 THEN $5 END, updated_by = $5, updated_at = sysdatetimeoffset()
       WHERE activity_id = $1 AND occurrence_date = $2;
     IF @@ROWCOUNT = 0
       INSERT INTO ${S}.activity_occurrences_state (activity_id, clock_id, occurrence_date, status, completed_at, completed_by, updated_by)
       VALUES ($1, @clock, $2, $3, CASE WHEN $4 = 1 THEN sysdatetimeoffset() END, CASE WHEN $4 = 1 THEN $5 END, $5);`,
    [input.activity_id, input.occurrence_date, input.status, done, uid],
  );
  // One-off activities mirror the status on the activity itself.
  await tx.exec(
    `UPDATE ${S}.activities SET status = $2, completed_at = CASE WHEN $3 = 1 THEN sysdatetimeoffset() END,
       completed_by = CASE WHEN $3 = 1 THEN $4 END, updated_by = $4, updated_at = sysdatetimeoffset()
     WHERE id = $1 AND rrule IS NULL AND start_date = $5`,
    [input.activity_id, input.status, done, uid, input.occurrence_date],
  );
}

export async function applySnooze(tx: Tx, input: { activity_id: string; occurrence_date: string; until: string }, uid: string) {
  await tx.exec(
    `${CLOCK_OF}
     UPDATE ${S}.activity_occurrences_state WITH (UPDLOCK, HOLDLOCK)
       SET snoozed_until = $3, updated_by = $4, updated_at = sysdatetimeoffset()
       WHERE activity_id = $1 AND occurrence_date = $2;
     IF @@ROWCOUNT = 0
       INSERT INTO ${S}.activity_occurrences_state (activity_id, clock_id, occurrence_date, status, snoozed_until, updated_by)
       VALUES ($1, @clock, $2, N'planned', $3, $4);`,
    [input.activity_id, input.occurrence_date, input.until, uid],
  );
}
