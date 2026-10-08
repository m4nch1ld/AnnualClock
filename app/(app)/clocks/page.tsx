import Link from "next/link";
import { requireSession, roleIn } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { getActivities, getOccurrenceStates, listClocks } from "@/lib/data/clocks";
import { buildOccurrences } from "@/lib/domain";
import { addDays, todayInZone } from "@/lib/dates";
import { formatDate, t } from "@/lib/i18n";
import { Badge, Card } from "@/components/ui/card";

export const metadata = { title: "Clocks" };

export default async function ClocksPage() {
  const session = await requireSession();
  const today = todayInZone(session.profile.timezone);
  const from = addDays(today, -60);
  const to = addDays(today, 30);

  const data = await withUser(session.profile.id, async (tx) => {
    const clocks = await listClocks(tx);
    const activities = await getActivities(tx, clocks.map((c) => c.id));
    const states = await getOccurrenceStates(tx, activities.map((a) => a.id), from, to);
    return { clocks, activities, states };
  });
  const occ = buildOccurrences(data.activities, data.states, from, to, today);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="accent-bar text-2xl">{t("clocks.title")}</h1>
        {data.clocks.length > 1 && (
          <Link href="/overview" className="text-sm text-primary underline-offset-4 hover:underline">
            {session.isAllClocksViewer || session.isSuperAdmin ? t("clocks.allDepartments") : t("nav.overview")} →
          </Link>
        )}
      </div>
      {data.clocks.length === 0 && <p className="text-muted">{t("clocks.empty")}</p>}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.clocks.map((c) => {
          const mine = occ.filter((o) => o.activity.clock_id === c.id);
          const overdue = mine.filter((o) => o.overdue);
          const upcoming = mine.filter((o) => o.date >= today && o.date <= to && o.status !== "done" && o.status !== "cancelled");
          const role = roleIn(session, c.id);
          return (
            <li key={c.id}>
              <Card className="flex h-full flex-col overflow-hidden">
                <div className="h-1.5" style={{ background: c.color }} aria-hidden />
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-lg">
                      <Link href={`/clocks/${c.slug}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </h2>
                    {role && (
                      <Badge tone={role === "admin" ? "primary" : "neutral"}>
                        {role === "reader" ? t("clocks.readOnly") : t(`roles.${role}`)}
                      </Badge>
                    )}
                  </div>
                  {c.description && <p className="text-sm text-muted">{c.description}</p>}
                  <div className="flex flex-wrap gap-2">
                    {overdue.length > 0 && <Badge tone="danger">{t("clocks.overdue", { count: overdue.length })}</Badge>}
                  </div>
                  <div>
                    <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{t("clocks.upcoming")}</h3>
                    {upcoming.length === 0 ? (
                      <p className="text-sm text-muted">—</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {upcoming.slice(0, 4).map((o) => (
                          <li key={o.key} className="flex justify-between gap-2">
                            <span className="truncate">{o.activity.title}</span>
                            <span className="shrink-0 text-muted">{formatDate(o.date)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Link
                    href={`/clocks/${c.slug}`}
                    className="mt-auto self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-canvas"
                  >
                    {t("clocks.open")} {c.name}
                  </Link>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
