import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { getActivities, getClockBySlug, getRings, listPeople } from "@/lib/data/clocks";
import { activitiesToCsv } from "@/lib/import-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CSV export of a clock's activities (RLS: anyone who can read the clock). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const { slug } = await params;
  const out = await withUser(session.profile.id, async (tx) => {
    const clock = await getClockBySlug(tx, slug);
    if (!clock) return null;
    const rings = await getRings(tx, [clock.id]);
    const activities = await getActivities(tx, [clock.id]);
    const people = await listPeople(tx);
    const email = new Map(people.map((p) => [p.id, p.email]));
    return { clock, csv: activitiesToCsv(activities, rings, (id) => (id ? (email.get(id) ?? "") : "")) };
  });
  if (!out) return new NextResponse("Not found", { status: 404 });
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(out.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="annual-clock-${out.clock.slug}-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
