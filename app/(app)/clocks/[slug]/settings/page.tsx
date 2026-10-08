import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, roleIn } from "@/lib/server/session";
import { withService, withUser } from "@/lib/db";
import { getClockBySlug, getRings, listMembers } from "@/lib/data/clocks";
import { Card } from "@/components/ui/card";
import { GeneralForm, RingsEditor, MembersEditor, NotificationSettingsForm, ImportForm } from "./forms";

export const metadata = { title: "Clock settings" };

export default async function ClockSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, session] = await Promise.all([params, requireSession()]);
  const uid = session.profile.id;
  const clock = await withUser(uid, (tx) => getClockBySlug(tx, slug));
  if (!clock) notFound();
  if (roleIn(session, clock.id) !== "admin") notFound();

  const data = await withUser(uid, async (tx) => {
    const rings = await getRings(tx, [clock.id]);
    const members = await listMembers(tx, clock.id);
    const log = await tx.query<{ id: string; reminder_key: string; channel: string; status: string; error: string | null; created_at: string; title: string | null; recipient: string | null; occurrence_date: string | null }>(
      `select l.id, l.reminder_key, l.channel, l.status, l.error, l.created_at, a.title, coalesce(p.full_name, p.email) as recipient, l.occurrence_date
       from notification_log l left join activities a on a.id = l.activity_id left join profiles p on p.id = l.recipient_id
       where l.clock_id = $1 order by l.created_at desc limit 50`,
      [clock.id],
    );
    const audit = await tx.query<{ id: number; entity: string; action: string; created_at: string; actor: string | null; title: string | null }>(
      `select l.id, l.entity, l.action, l.created_at, coalesce(p.full_name, p.email) as actor,
         coalesce(l.diff ->> 'title', (l.diff -> 'title' ->> 'to'), (l.diff ->> 'name'), a.title) as title
       from audit_log l left join profiles p on p.id = l.actor_id left join activities a on a.id = l.entity_id
       where l.clock_id = $1 order by l.created_at desc limit 50`,
      [clock.id],
    );
    return { rings, members, log, audit };
  });
  const hasWebhook = await withService((tx) =>
    tx.one<{ ok: boolean }>(`select coalesce(teams_webhook_url, '') <> '' as ok from clock_secrets where clock_id = $1`, [clock.id]),
  );

  const fmt = (s: string) => new Date(s).toLocaleString("en-GB", { timeZone: "Europe/Helsinki" });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/clocks/${clock.slug}`} className="text-sm text-primary hover:underline">
          ← {clock.name}
        </Link>
        <h1 className="accent-bar w-full text-2xl">{clock.name}: settings</h1>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">General</h2>
        <GeneralForm clock={clock} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-lg">Rings</h2>
        <p className="mb-3 text-sm text-muted">The first ring is drawn outermost. Hidden rings are off by default in the wheel.</p>
        <RingsEditor clockId={clock.id} rings={data.rings} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-lg">Members</h2>
        <p className="mb-3 text-sm text-muted">
          Viewers can read, editors can add and change activities, admins also manage settings and members. General management can read every
          clock without being a member.
        </p>
        <MembersEditor clockId={clock.id} members={data.members} currentUserId={uid} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Notifications</h2>
        <NotificationSettingsForm clock={clock} hasWebhook={!!hasWebhook?.ok} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-lg">Import & export</h2>
        <p className="mb-3 text-sm text-muted">
          Export all activities as CSV, or import activities from CSV (same columns as the export) or an .ics calendar file. Imports create new
          activities; existing ones are not changed.
        </p>
        <div className="mb-4 flex gap-3 text-sm">
          <a href={`/api/clocks/${clock.slug}/export`} className="text-primary underline">
            Download CSV
          </a>
        </div>
        <ImportForm clockId={clock.id} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Recent notifications</h2>
        {data.log.length === 0 ? (
          <p className="text-sm text-muted">Nothing sent yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Activity</th>
                  <th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium">To</th>
                  <th className="py-1 pr-3 font-medium">Channel</th>
                  <th className="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.log.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(l.created_at)}</td>
                    <td className="py-1.5 pr-3">
                      {l.title ?? "—"}
                      {l.occurrence_date && <span className="text-xs text-muted"> ({l.occurrence_date})</span>}
                    </td>
                    <td className="py-1.5 pr-3">{l.reminder_key.replace(/:.*/, "")}</td>
                    <td className="py-1.5 pr-3">{l.recipient ?? "channel"}</td>
                    <td className="py-1.5 pr-3">{l.channel}</td>
                    <td className={`py-1.5 ${l.status === "failed" ? "text-danger" : ""}`} title={l.error ?? undefined}>
                      {l.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Audit log</h2>
        <ol className="space-y-1 text-sm">
          {data.audit.map((a) => (
            <li key={a.id}>
              <span className="text-muted">{fmt(a.created_at)}</span> <strong className="font-medium">{a.actor ?? "System"}</strong> {a.action.replace("_", " ")}{" "}
              {a.entity.replace(/_/g, " ")}
              {a.title && <> “{a.title}”</>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
