import "server-only";
import { after } from "next/server";
import { calendar } from "@/lib/calendar";
import { newUid } from "@/lib/calendar/sync";

export interface CalendarChange {
  /** activities whose calendar links must be re-synced */
  activityIds: string[];
  /** series shifted by N days: move occurrence links along before syncing */
  shift?: { activityId: string; days: number };
  /** series split ("this and future"): users who had the series get the new series too */
  split?: { fromId: string; toId: string };
}

/**
 * Re-sync personal calendar entries after the response is sent (so the user
 * does not wait for email/Graph). Failures are stored on the link and retried
 * by the scheduler.
 */
export function syncCalendarAfter(change: CalendarChange | null) {
  if (!change) return;
  after(async () => {
    try {
      const repo = calendar.repo();
      if (change.shift) await repo.shiftOccurrenceLinks(change.shift.activityId, change.shift.days);
      if (change.split) await repo.copySeriesLinks(change.split.fromId, change.split.toId, () => newUid());
      for (const id of new Set(change.activityIds)) await calendar.syncActivity(id);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", job: "calendar", msg: "calendar sync after change failed", error: String(e) }));
    }
  });
}

/** Re-sync every active link of a user and/or clock (access removed, user deactivated, clock archived). */
export function syncCalendarLinksWhere(filter: { userId?: string; clockId?: string }) {
  after(async () => {
    try {
      const { withService } = await import("@/lib/db");
      const ids = await withService((tx) =>
        tx.query<{ activity_id: string }>(
          `select distinct l.activity_id from calendar_links l join activities a on a.id = l.activity_id
           where l.status = 'active' and ($1::uuid is null or l.user_id = $1) and ($2::uuid is null or a.clock_id = $2)`,
          [filter.userId ?? null, filter.clockId ?? null],
        ),
      );
      for (const { activity_id } of ids) await calendar.syncActivity(activity_id);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", job: "calendar", msg: "calendar resync failed", error: String(e) }));
    }
  });
}
