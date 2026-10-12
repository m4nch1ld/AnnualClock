import "server-only";
import { withUser } from "@/lib/db";
import { getActivities, getOccurrenceStates, getRings, listPeople } from "@/lib/data/clocks";
import { makeDate, todayInZone } from "@/lib/dates";
import type { Clock } from "@/lib/domain";
import type { WorkspaceData } from "@/components/clock/types";
import { canEdit, isAdmin, roleIn, type Session } from "./session";

export function parseYear(raw: string | undefined, fallback: number) {
  const y = Number(raw);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : fallback;
}

/** Load everything the workspace needs for the given clocks and year (RLS-filtered). */
export async function loadWorkspace(
  session: Session,
  clocks: Clock[],
  year: number,
  mode: WorkspaceData["mode"],
): Promise<WorkspaceData> {
  const uid = session.profile.id;
  const today = todayInZone(session.profile.timezone);
  const clockIds = clocks.map((c) => c.id);
  return withUser(uid, async (tx) => {
    // One transaction = one connection: queries run sequentially.
    const rings = await getRings(tx, clockIds);
    const activities = await getActivities(tx, clockIds);
    const people = await listPeople(tx);
    const members = await tx.query<{ clock_id: string; user_id: string }>(
      `select clock_id, user_id from clock_members where clock_id = any($1)`,
      [clockIds],
    );
    // States for occurrences that can overlap the year (periods may start in the previous year).
    const states = await getOccurrenceStates(
      tx,
      activities.map((a) => a.id),
      makeDate(year - 1, 1, 1),
      makeDate(year, 12, 31),
    );
    const calendarLinks = await tx.query<WorkspaceData["calendarLinks"][number]>(
      `select activity_id, scope, occurrence_date, (last_error is not null) as pending from calendar_links where user_id = $1 and status = 'active' and activity_id = any($2)`,
      [uid, activities.map((a) => a.id)],
    );
    const memberIds: Record<string, string[]> = {};
    for (const m of members) (memberIds[m.clock_id] ??= []).push(m.user_id);
    const perms: WorkspaceData["perms"] = {};
    for (const c of clocks) {
      const r = roleIn(session, c.id);
      perms[c.id] = { canEdit: canEdit(r), isAdmin: isAdmin(r) };
    }
    return { mode, year, today, clocks, rings, activities, states, people, memberIds, perms, currentUserId: uid, calendarLinks };
  });
}
