import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { Badge, Card } from "@/components/ui/card";
import { ClockAdminRow, CreateClockForm, InviteUserForm, JobButtons, UserRow } from "./forms";

export const metadata = { title: "Administration" };

export default async function AdminPage() {
  const session = await requireSession();
  if (!session.isSuperAdmin) notFound();
  const data = await withUser(session.profile.id, async (tx) => {
    const users = await tx.query<{
      id: string;
      email: string;
      full_name: string | null;
      global_role: "user" | "super_admin";
      all_clocks_viewer: boolean;
      is_active: boolean;
      is_demo: boolean;
      clocks: string | null;
    }>(
      `select p.id, p.email, p.full_name, p.global_role, p.all_clocks_viewer, p.is_active, p.is_demo,
         (select string_agg(c.name || ' (' || m.role || ')', ', ' order by c.position) from clock_members m join clocks c on c.id = m.clock_id where m.user_id = p.id) as clocks
       from profiles p order by p.is_active desc, coalesce(p.full_name, p.email)`,
    );
    const clocks = await tx.query<{ id: string; name: string; slug: string; color: string; archived_at: string | null; members: number; activities: number }>(
      `select c.id, c.name, c.slug, c.color, c.archived_at,
         (select count(*)::int from clock_members m where m.clock_id = c.id) as members,
         (select count(*)::int from activities a where a.clock_id = c.id and a.deleted_at is null) as activities
       from clocks c order by c.archived_at nulls first, c.position, c.name`,
    );
    const runs = await tx.query<{ id: string; status: string; dry_run: boolean; started_at: string; finished_at: string | null; window_start: string | null; window_end: string | null; stats: Record<string, number>; error: string | null }>(
      `select id, status, dry_run, started_at, finished_at, window_start, window_end, stats, error from job_runs order by started_at desc limit 15`,
    );
    return { users, clocks, runs };
  });
  const lastOk = data.runs.find((r) => r.status === "success" && !r.dry_run);
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("en-GB", { timeZone: "Europe/Helsinki" }) : "—");
  const stale = !lastOk || Date.now() - Date.parse(lastOk.started_at) > 26 * 3600_000;

  return (
    <div className="space-y-6">
      <h1 className="accent-bar text-2xl">Administration</h1>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg">Notification job</h2>
          {stale ? <Badge tone="danger">No successful run in the last 26 h</Badge> : <Badge tone="success">Healthy</Badge>}
        </div>
        <p className="mb-3 text-sm text-muted">
          Last successful run: {fmt(lastOk?.started_at ?? null)}
          {lastOk && ` · sent ${lastOk.stats.sent ?? 0}, failed ${lastOk.stats.failed ?? 0}, already sent ${lastOk.stats.alreadySent ?? 0}`}
        </p>
        <JobButtons />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Started</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Window</th>
                <th className="py-1 pr-3 font-medium">Planned</th>
                <th className="py-1 pr-3 font-medium">Sent</th>
                <th className="py-1 pr-3 font-medium">Failed</th>
                <th className="py-1 pr-3 font-medium">Already sent</th>
                <th className="py-1 font-medium">Retried</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="border-t border-border" title={r.error ?? undefined}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(r.started_at)}</td>
                  <td className={`py-1.5 pr-3 ${r.status === "failed" ? "text-danger" : ""}`}>
                    {r.status}
                    {r.dry_run && " (dry run)"}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-xs text-muted">
                    {fmt(r.window_start)} → {fmt(r.window_end)}
                  </td>
                  <td className="py-1.5 pr-3">{r.stats.planned ?? "—"}</td>
                  <td className="py-1.5 pr-3">{r.stats.sent ?? "—"}</td>
                  <td className="py-1.5 pr-3">{r.stats.failed ?? "—"}</td>
                  <td className="py-1.5 pr-3">{r.stats.alreadySent ?? "—"}</td>
                  <td className="py-1.5">{r.stats.retried ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Users</h2>
        <InviteUserForm />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">User</th>
                <th className="py-1 pr-3 font-medium">Clocks</th>
                <th className="py-1 pr-3 font-medium">General management</th>
                <th className="py-1 pr-3 font-medium">Super admin</th>
                <th className="py-1 font-medium">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <UserRow key={u.id} user={u} self={u.id === session.profile.id} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Clocks</h2>
        <ul className="mb-4 divide-y divide-border">
          {data.clocks.map((c) => (
            <ClockAdminRow key={c.id} clock={c} />
          ))}
        </ul>
        <CreateClockForm />
        <p className="mt-3 text-xs text-muted">
          Manage rings, members and notification rules in each clock&apos;s settings, e.g.{" "}
          <Link className="text-primary underline" href={`/clocks/${data.clocks[0]?.slug ?? ""}/settings`}>
            {data.clocks[0]?.name}
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
