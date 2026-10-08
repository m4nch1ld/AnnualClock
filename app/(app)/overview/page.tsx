import Link from "next/link";
import { requireSession } from "@/lib/server/session";
import { loadWorkspace, parseYear } from "@/lib/server/workspace";
import { withUser } from "@/lib/db";
import { listClocks } from "@/lib/data/clocks";
import { todayInZone, yearOf } from "@/lib/dates";
import { t } from "@/lib/i18n";
import { ClockWorkspace } from "@/components/clock/workspace";
import { cn } from "@/lib/utils";

export const metadata = { title: "Overview" };

/** Multi-clock overlay: one band per clock on a single wheel. */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ year?: string; clocks?: string }> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const all = await withUser(session.profile.id, (tx) => listClocks(tx));
  const requested = sp.clocks ? new Set(sp.clocks.split(",")) : null;
  const shown = requested ? all.filter((c) => requested.has(c.slug)) : all;
  const year = parseYear(sp.year, yearOf(todayInZone(session.profile.timezone)));
  const data = await loadWorkspace(session, shown, year, "overlay");

  const toggleHref = (slug: string) => {
    const cur = new Set(shown.map((c) => c.slug));
    if (cur.has(slug)) cur.delete(slug);
    else cur.add(slug);
    const list = all.filter((c) => cur.has(c.slug)).map((c) => c.slug);
    const q = new URLSearchParams({ year: String(year) });
    if (list.length && list.length !== all.length) q.set("clocks", list.join(","));
    return `/overview?${q.toString()}`;
  };

  return (
    <div className="space-y-4">
      <h1 className="accent-bar text-2xl">
        {session.isAllClocksViewer || session.isSuperAdmin ? t("clocks.allDepartments") : t("nav.overview")}
      </h1>
      <nav aria-label={t("clock.clocksShown")} className="flex flex-wrap gap-2">
        {all.map((c) => {
          const on = shown.some((s) => s.id === c.id);
          return (
            <Link
              key={c.id}
              href={toggleHref(c.slug)}
              aria-pressed={on}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm",
                on ? "border-transparent text-white" : "border-border bg-surface text-muted",
              )}
              style={on ? { background: c.color } : undefined}
            >
              {on ? "✓" : "+"} {c.name}
            </Link>
          );
        })}
      </nav>
      <ClockWorkspace key={`${shown.map((c) => c.id).join()}-${year}`} data={data} />
    </div>
  );
}
