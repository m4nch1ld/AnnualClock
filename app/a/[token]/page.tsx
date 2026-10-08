import Link from "next/link";
import { verifyActionToken } from "@/lib/tokens";
import { withService, withUser } from "@/lib/db";
import { env } from "@/lib/env";
import { addDays, todayInZone } from "@/lib/dates";
import { formatDate, formatDateRange } from "@/lib/i18n";
import { clientIp, rateLimit } from "@/lib/server/rate-limit";
import { applyOccurrenceStatus, applySnooze } from "@/lib/server/occurrences";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

/**
 * Landing page for "Mark done" / "Snooze" links in notification emails.
 * GET only displays (mail scanners prefetch links); changes happen on POST.
 * Works without a session: the signed, expiring token identifies the recipient,
 * and the write still runs through RLS as that user.
 */
export default async function ActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const ip = await clientIp();
  if (!(await rateLimit(`action:ip:${ip}`, 60, 600))) return <Shell title="Too many requests">Please try again in a few minutes.</Shell>;

  const v = verifyActionToken(token, env().APP_TOKEN_SECRET);
  if (!v.ok) {
    return (
      <Shell title={v.reason === "expired" ? "This link has expired" : "Invalid link"}>
        Open the clock to update the activity. <Link href="/clocks" className="text-primary underline">Go to Annual Clock</Link>
      </Shell>
    );
  }
  const p = v.payload;
  const info = await withService((tx) =>
    tx.one<{ title: string; clock_name: string; clock_slug: string; end_date: string | null; start_date: string; user_active: boolean; status: string | null; snoozed_until: string | null }>(
      `select a.title, c.name as clock_name, c.slug as clock_slug, a.end_date, a.start_date,
         (select is_active from profiles where id = $3) as user_active,
         s.status, s.snoozed_until
       from activities a join clocks c on c.id = a.clock_id
       left join activity_occurrences_state s on s.activity_id = a.id and s.occurrence_date = $2
       where a.id = $1 and a.deleted_at is null`,
      [p.aid, p.occ, p.uid],
    ),
  );
  if (!info || !info.user_active) return <Shell title="Activity not available">The activity was removed or your access has ended.</Shell>;

  const today = todayInZone();
  const duration = info.end_date ? Math.round((Date.parse(info.end_date) - Date.parse(info.start_date)) / 86400000) : 0;
  const occEnd = info.end_date ? addDays(p.occ, duration) : null;
  const openHref = `/clocks/${info.clock_slug}?year=${p.occ.slice(0, 4)}&focus=${p.aid}:${p.occ}`;

  async function markDone() {
    "use server";
    const vv = verifyActionToken(token, env().APP_TOKEN_SECRET);
    if (!vv.ok) return;
    const ok = await runAs(vv.payload.uid, (tx) =>
      applyOccurrenceStatus(tx, { activity_id: vv.payload.aid, occurrence_date: vv.payload.occ, status: "done" }, vv.payload.uid),
    );
    const { redirect } = await import("next/navigation");
    redirect(`/a/${token}?result=${ok ? "done" : "denied"}`);
  }

  async function snooze(form: FormData) {
    "use server";
    const vv = verifyActionToken(token, env().APP_TOKEN_SECRET);
    if (!vv.ok) return;
    const days = Math.min(30, Math.max(1, Number(form.get("days")) || 1));
    const until = addDays(todayInZone(), days);
    const ok = await runAs(vv.payload.uid, (tx) =>
      applySnooze(tx, { activity_id: vv.payload.aid, occurrence_date: vv.payload.occ, until }, vv.payload.uid),
    );
    const { redirect } = await import("next/navigation");
    redirect(`/a/${token}?result=${ok ? `snoozed:${until}` : "denied"}`);
  }

  const done = info.status === "done" || sp.result === "done";
  return (
    <Shell title={info.title}>
      <p className="text-sm text-muted">
        {info.clock_name} · {formatDateRange(p.occ, occEnd)}
      </p>
      {sp.result === "denied" && (
        <p role="alert" className="rounded-md bg-danger-soft p-2 text-sm text-danger">
          You do not have permission to change this activity. Ask an editor of the clock.
        </p>
      )}
      {sp.result?.startsWith("snoozed:") && (
        <p role="status" className="rounded-md bg-success-soft p-2 text-sm text-success">
          Reminders snoozed until {formatDate(sp.result.slice(8))}.
        </p>
      )}
      {done ? (
        <p role="status" className="rounded-md bg-success-soft p-2 text-sm text-success">
          ✓ This occurrence is marked done. No further reminders or escalations will be sent for it.
        </p>
      ) : (
        <div className="space-y-3">
          {p.act === "done" && (
            <form action={markDone}>
              <Button type="submit" size="lg" className="w-full">
                ✓ Mark done
              </Button>
            </form>
          )}
          <form action={snooze} className="flex items-center gap-2">
            <label htmlFor="days" className="text-sm">
              Snooze for
            </label>
            <select id="days" name="days" defaultValue="3" className="h-9 rounded-md border border-border px-2 text-sm">
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
            </select>
            <Button type="submit" variant="outline">
              Snooze
            </Button>
          </form>
          {p.act === "snooze" && (
            <form action={markDone}>
              <Button type="submit" variant="link" className="px-0">
                Mark done instead
              </Button>
            </form>
          )}
          {info.snoozed_until && info.snoozed_until >= today && (
            <p className="text-xs text-muted">Currently snoozed until {formatDate(info.snoozed_until)}.</p>
          )}
        </div>
      )}
      <Link href={openHref} className="inline-block text-sm text-primary underline">
        Open in clock
      </Link>
    </Shell>
  );
}

/** Run a write as the token's user so RLS decides; returns false if not permitted. */
async function runAs(uid: string, fn: Parameters<typeof withUser>[1]) {
  try {
    await withUser(uid, fn);
    return true;
  } catch (e) {
    if (/row-level security|permission denied/i.test(String((e as Error).message))) return false;
    throw e;
  }
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-md space-y-4 p-6">
        <p className="text-xs uppercase tracking-wide text-muted">ESL Shipping · Annual Clock</p>
        <h1 className="accent-bar text-xl">{title}</h1>
        {children}
      </Card>
    </main>
  );
}
