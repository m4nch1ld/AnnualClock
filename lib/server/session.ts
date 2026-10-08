import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { withService, withUser } from "@/lib/db";
import type { ClockRole } from "@/lib/domain";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  locale: string;
  timezone: string;
  global_role: "user" | "super_admin";
  all_clocks_viewer: boolean;
  is_active: boolean;
  weekly_digest: boolean;
}

export interface Membership {
  clock_id: string;
  slug: string;
  name: string;
  color: string;
  role: ClockRole;
}

export interface Session {
  profile: Profile;
  memberships: Membership[];
  isSuperAdmin: boolean;
  isAllClocksViewer: boolean;
}

/** The current user's session (cached per request), or null. */
export const getSession = cache(async (): Promise<Session | null> => {
  const user = await auth.getCurrentUser();
  if (!user) return null;
  const profile = await withService((tx) =>
    tx.one<Profile>(
      `select id, email, full_name, locale, timezone, global_role, all_clocks_viewer, is_active, weekly_digest
       from profiles where id = $1`,
      [user.id],
    ),
  );
  if (!profile || !profile.is_active) return null;
  const memberships = await withUser(user.id, (tx) =>
    tx.query<Membership>(
      `select m.clock_id, c.slug, c.name, c.color, m.role
       from clock_members m join clocks c on c.id = m.clock_id
       where m.user_id = $1 and c.archived_at is null order by c.position, c.name`,
      [user.id],
    ),
  );
  return {
    profile,
    memberships,
    isSuperAdmin: profile.global_role === "super_admin",
    isAllClocksViewer: profile.all_clocks_viewer,
  };
});

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Effective role in a clock for UI purposes (RLS is the real enforcement). */
export function roleIn(session: Session, clockId: string): ClockRole | "reader" | null {
  if (session.isSuperAdmin) return "admin";
  const m = session.memberships.find((x) => x.clock_id === clockId);
  if (m) return m.role;
  return session.isAllClocksViewer ? "reader" : null;
}

export const canEdit = (r: ReturnType<typeof roleIn>) => r === "editor" || r === "admin";
export const isAdmin = (r: ReturnType<typeof roleIn>) => r === "admin";
