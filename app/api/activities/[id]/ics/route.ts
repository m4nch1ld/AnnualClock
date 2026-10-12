import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { ACTIVITY_SELECT } from "@/lib/data/clocks";
import { buildInviteIcs } from "@/lib/calendar";
import { buildEvent } from "@/lib/calendar/sync";
import { isISODate } from "@/lib/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fallback "Download .ics": a one-off calendar file (METHOD:PUBLISH) for the activity
 * or one occurrence. Static copy — not updated later (use "Add to my Outlook" for that).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await params;
  const occ = req.nextUrl.searchParams.get("occ");
  if (!/^[0-9a-f-]{36}$/i.test(id) || (occ && !isISODate(occ))) return new NextResponse("Bad request", { status: 400 });

  const a = await withUser(session.profile.id, (tx) =>
    tx.one<{ id: string; title: string; description: string | null; type: string; start_date: string; end_date: string | null; rrule: string | null; status: string; clock_id: string; clock_name: string; clock_slug: string; ring_name: string }>(
      `select x.*, c.name as clock_name, c.slug as clock_slug, r.name as ring_name
       from (${ACTIVITY_SELECT} where a.id = $1 and a.deleted_at is null) x
       join clocks c on c.id = x.clock_id join rings r on r.id = x.ring_id`,
      [id],
    ),
  );
  if (!a) return new NextResponse("Not found", { status: 404 });
  const scope = occ && a.rrule ? "occurrence" : "series";
  const ev = buildEvent(
    { baseUrl: process.env.APP_BASE_URL ?? req.nextUrl.origin, organizer: { email: "noreply@annual-clock", name: "ESL Annual Clock" } },
    { ...a, deleted: false },
    {
      id: "download",
      user_id: session.profile.id,
      activity_id: a.id,
      scope,
      occurrence_date: scope === "occurrence" ? occ : null,
      provider: "ics_invite",
      uid: `${a.id}${scope === "occurrence" ? `-${occ}` : ""}@annual-clock.eslshipping`,
      external_id: null,
      sequence: 0,
      content_hash: null,
      status: "active",
      last_error: null,
      user_email: session.profile.email,
      user_name: session.profile.full_name,
      user_can_read: true,
    },
  );
  if (!ev) return new NextResponse("Occurrence not found", { status: 404 });
  const safe = a.title.replace(/[^\w\- ]+/g, "").slice(0, 60).trim() || "activity";
  return new NextResponse(buildInviteIcs(ev, "PUBLISH"), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${safe}.ics"`,
      "cache-control": "no-store",
    },
  });
}
