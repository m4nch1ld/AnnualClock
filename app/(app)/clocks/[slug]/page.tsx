import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, roleIn } from "@/lib/server/session";
import { loadWorkspace, parseYear } from "@/lib/server/workspace";
import { withUser } from "@/lib/db";
import { getClockBySlug } from "@/lib/data/clocks";
import { todayInZone, yearOf } from "@/lib/dates";
import { t } from "@/lib/i18n";
import { ClockWorkspace } from "@/components/clock/workspace";
import { Badge } from "@/components/ui/card";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()) };
}

export default async function ClockPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const [{ slug }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  const clock = await withUser(session.profile.id, (tx) => getClockBySlug(tx, slug));
  // RLS returns nothing for clocks the user cannot read: indistinguishable from "not found".
  if (!clock) notFound();
  const year = parseYear(sp.year, yearOf(todayInZone(session.profile.timezone)));
  const data = await loadWorkspace(session, [clock], year, "single");
  const role = roleIn(session, clock.id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="size-4 rounded-full" style={{ background: clock.color }} aria-hidden />
        <h1 className="text-2xl">{clock.name}</h1>
        {role && <Badge>{role === "reader" ? t("clocks.readOnly") : t(`roles.${role}`)}</Badge>}
        <div className="ml-auto flex gap-3 text-sm">
          <a href={`/api/clocks/${clock.slug}/export`} className="text-primary hover:underline">
            {t("clock.exportCsv")}
          </a>
          {role === "admin" && (
            <Link href={`/clocks/${clock.slug}/settings`} className="text-primary hover:underline">
              {t("clock.settings")}
            </Link>
          )}
        </div>
      </div>
      <ClockWorkspace key={`${clock.id}-${year}`} data={data} />
    </div>
  );
}
