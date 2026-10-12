import { describe, expect, test } from "vitest";
import { buildInviteIcs } from "@/lib/calendar/ics-invite";
import { graphEventBody, rruleToGraphRecurrence } from "@/lib/calendar/graph";
import { addLink, removeLink, retryFailed, syncActivity, type CalendarDeps } from "@/lib/calendar/sync";
import type { ActivitySyncContext, CalendarEvent, CalendarLink, CalendarProvider, CalendarRepository } from "@/lib/calendar/types";

const EV: CalendarEvent = {
  uid: "u-1@annual-clock.eslshipping",
  sequence: 2,
  summary: "EUA verification due · Environmental",
  description: "Environmental annual clock · Audits & verification",
  start: "2027-03-31",
  end: "2027-03-31",
  rrule: "FREQ=YEARLY",
  url: "https://clock.test/clocks/environmental",
  organizer: { email: "clock@esl.test", name: "ESL Annual Clock" },
  attendee: { email: "emma@esl.test", name: "Emma, Director" },
};

describe("iCalendar invitations", () => {
  test("REQUEST is an all-day, free, no-RSVP meeting request with a stable UID and sequence", () => {
    const ics = buildInviteIcs(EV, "REQUEST", new Date("2026-10-12T00:00:00Z"));
    for (const line of [
      "METHOD:REQUEST",
      "UID:u-1@annual-clock.eslshipping",
      "SEQUENCE:2",
      "DTSTART;VALUE=DATE:20270331",
      "DTEND;VALUE=DATE:20270401",
      "RRULE:FREQ=YEARLY",
      "STATUS:CONFIRMED",
      "TRANSP:TRANSPARENT",
      "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
      'ORGANIZER;CN="ESL Annual Clock":mailto:clock@esl.test',
    ]) {
      expect(ics).toContain(line);
    }
    expect(ics).toMatch(/ATTENDEE;CN="Emma\, Director";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:emma@esl.test|ATTENDEE;CN="Emma, Director"/);
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  test("CANCEL marks the event cancelled", () => {
    const ics = buildInviteIcs(EV, "CANCEL");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
  });

  test("PUBLISH (download) has no organizer/attendee", () => {
    const ics = buildInviteIcs(EV, "PUBLISH");
    expect(ics).not.toContain("ORGANIZER");
    expect(ics).not.toContain("ATTENDEE");
  });
});

describe("Graph recurrence mapping", () => {
  test("presets", () => {
    expect(rruleToGraphRecurrence("FREQ=YEARLY", "2027-03-31")).toEqual({
      pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 31, month: 3 },
      range: { type: "noEnd", startDate: "2027-03-31" },
    });
    expect(rruleToGraphRecurrence("FREQ=MONTHLY;INTERVAL=3", "2026-01-15")?.pattern).toEqual({ type: "absoluteMonthly", interval: 3, dayOfMonth: 15 });
    expect(rruleToGraphRecurrence("FREQ=WEEKLY", "2026-10-12")?.pattern).toEqual({
      type: "weekly",
      interval: 1,
      daysOfWeek: ["monday"],
      firstDayOfWeek: "monday",
    });
    expect(rruleToGraphRecurrence("FREQ=MONTHLY;BYDAY=-1FR", "2026-01-30")?.pattern).toEqual({
      type: "relativeMonthly",
      interval: 1,
      daysOfWeek: ["friday"],
      index: "last",
    });
    expect(rruleToGraphRecurrence("FREQ=YEARLY;UNTIL=20290101T000000Z", "2027-03-31")?.range).toEqual({
      type: "endDate",
      startDate: "2027-03-31",
      endDate: "2029-01-01",
    });
  });

  test("unsupported rules return null and graph body refuses them", () => {
    expect(rruleToGraphRecurrence("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-31")).toBeNull();
    expect(() => graphEventBody({ ...EV, rrule: "FREQ=MONTHLY;BYMONTHDAY=-1" })).toThrow();
  });

  test("all-day, free, exclusive end", () => {
    const b = graphEventBody({ ...EV, rrule: null });
    expect(b).toMatchObject({ isAllDay: true, showAs: "free", start: { dateTime: "2027-03-31T00:00:00" }, end: { dateTime: "2027-04-01T00:00:00" } });
  });
});

// ---------------------------------------------------------------------------
// Sync lifecycle with in-memory repository and a recording provider
// ---------------------------------------------------------------------------
type Act = NonNullable<ActivitySyncContext["activity"]>;

function setup() {
  const activity: Act = {
    id: "a1",
    title: "EUA verification due",
    description: null,
    type: "deadline",
    start_date: "2026-03-31",
    end_date: null,
    rrule: "FREQ=YEARLY",
    status: "planned",
    deleted: false,
    clock_id: "c1",
    clock_name: "Environmental",
    clock_slug: "environmental",
    ring_name: "Audits & verification",
  };
  const state = { activity: activity as Act | null, canRead: true };
  const links: CalendarLink[] = [];
  let n = 0;
  const repo: CalendarRepository = {
    async loadActivityContext() {
      return {
        activity: state.activity ? { ...state.activity } : null,
        links: links
          .filter((l) => l.status === "active")
          .map((l) => ({ ...l, user_email: "emma@esl.test", user_name: "Emma", user_can_read: state.canRead })),
      };
    },
    async findActiveLink(u, a, occ) {
      return links.find((l) => l.user_id === u && l.activity_id === a && l.occurrence_date === occ && l.status === "active") ?? null;
    },
    async insertLink(l) {
      const row: CalendarLink = { ...l, id: `l${++n}`, status: "active", last_error: null, content_hash: null, external_id: null, sequence: 0 };
      links.push(row);
      return row;
    },
    async updateLink(id, patch) {
      const l = links.find((x) => x.id === id)!;
      const { synced, ...rest } = patch;
      void synced;
      Object.assign(l, rest);
    },
    async copySeriesLinks() {},
    async shiftOccurrenceLinks() {},
    async activityIdsWithFailedLinks() {
      return [...new Set(links.filter((l) => l.status === "active" && l.last_error).map((l) => l.activity_id))];
    },
  };
  const sent: Array<{ op: "upsert" | "cancel"; seq: number; start: string; isNew?: boolean }> = [];
  let failNext = false;
  const provider: CalendarProvider = {
    id: "ics_invite",
    async upsert(_l, ev, isNew) {
      if (failNext) {
        failNext = false;
        throw new Error("smtp down");
      }
      sent.push({ op: "upsert", seq: ev.sequence, start: ev.start, isNew });
      return {};
    },
    async cancel(_l, ev) {
      sent.push({ op: "cancel", seq: ev.sequence, start: ev.start });
    },
  };
  const deps: CalendarDeps = { repo, provider, baseUrl: "https://clock.test", organizer: { email: "clock@esl.test", name: "ESL Annual Clock" }, log: () => {} };
  return { deps, state, links, sent, fail: () => (failNext = true) };
}

describe("calendar sync", () => {
  test("add → invite; unrelated change → nothing; date change → update with higher SEQUENCE; delete → cancel", async () => {
    const { deps, state, links, sent } = setup();
    expect(await addLink(deps, { userId: "u1", activityId: "a1", scope: "series", occurrenceDate: null })).toMatchObject({ ok: true });
    expect(sent).toEqual([{ op: "upsert", seq: 0, start: "2026-03-31", isNew: true }]);

    // adding again is a no-op
    await addLink(deps, { userId: "u1", activityId: "a1", scope: "series", occurrenceDate: null });
    expect(sent).toHaveLength(1);

    // status change only (e.g. completed) does not touch the calendar
    state.activity!.status = "in_progress";
    expect((await syncActivity(deps, "a1")).unchanged).toBe(1);

    state.activity!.start_date = "2026-04-02";
    await syncActivity(deps, "a1");
    expect(sent[1]).toEqual({ op: "upsert", seq: 1, start: "2026-04-02", isNew: false });

    state.activity!.deleted = true;
    await syncActivity(deps, "a1");
    expect(sent[2]).toMatchObject({ op: "cancel", seq: 2 });
    expect(links[0].status).toBe("removed");
  });

  test("single occurrence link is cancelled when that occurrence disappears", async () => {
    const { deps, state, sent, links } = setup();
    await addLink(deps, { userId: "u1", activityId: "a1", scope: "occurrence", occurrenceDate: "2027-03-31" });
    expect(sent[0]).toMatchObject({ op: "upsert", start: "2027-03-31" });
    state.activity!.rrule = "FREQ=YEARLY;UNTIL=20261231T000000Z"; // series ends before that occurrence
    await syncActivity(deps, "a1");
    expect(sent[1].op).toBe("cancel");
    expect(links[0].status).toBe("removed");
  });

  test("losing access to the clock removes the entry", async () => {
    const { deps, state, sent } = setup();
    await addLink(deps, { userId: "u1", activityId: "a1", scope: "series", occurrenceDate: null });
    state.canRead = false;
    await syncActivity(deps, "a1");
    expect(sent.at(-1)?.op).toBe("cancel");
  });

  test("failures are recorded and retried by the scheduler", async () => {
    const { deps, links, sent, fail } = setup();
    fail();
    const r = await addLink(deps, { userId: "u1", activityId: "a1", scope: "series", occurrenceDate: null });
    expect(r.ok).toBe(false);
    expect(links[0].last_error).toBe("smtp down");
    const retry = await retryFailed(deps);
    expect(retry.created).toBe(1);
    expect(links[0].last_error).toBeNull();
    expect(sent).toHaveLength(1);
  });

  test("user removes it: cancel sent once, link removed", async () => {
    const { deps, links, sent } = setup();
    await addLink(deps, { userId: "u1", activityId: "a1", scope: "series", occurrenceDate: null });
    await removeLink(deps, { userId: "u1", activityId: "a1", occurrenceDate: null });
    expect(sent.map((s) => s.op)).toEqual(["upsert", "cancel"]);
    expect(links[0].status).toBe("removed");
    // can be added again later with a fresh link
    await addLink(deps, { userId: "u1", activityId: "a1", scope: "series", occurrenceDate: null });
    expect(links.filter((l) => l.status === "active")).toHaveLength(1);
  });
});
