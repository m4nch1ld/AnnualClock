import { describe, expect, test } from "vitest";
import { buildIcs } from "@/lib/ics";
import { activitiesToCsv, csvToRecords, parseCsv, parseIcsEvents } from "@/lib/import-export";
import { buildOccurrences, type Activity } from "@/lib/domain";

const act: Activity = {
  id: "11111111-1111-4111-8111-111111111111",
  clock_id: "c",
  ring_id: "r",
  title: "EUA submission; surrender, due",
  description: "Line 1\nLine 2",
  type: "period",
  start_date: "2026-12-14",
  end_date: "2027-01-08",
  all_day: true,
  start_time: null,
  end_time: null,
  rrule: "FREQ=YEARLY",
  owner_id: "o",
  status: "planned",
  predecessor_id: null,
  reminder_offsets: [30, 7],
  tags: ["EU ETS"],
  links: [{ label: "Registry", url: "https://example.org/x" }],
  assignee_ids: [],
};

describe("ICS", () => {
  test("all-day events with exclusive DTEND, escaped text, folded lines", () => {
    const occ = buildOccurrences([act], [], "2026-01-01", "2026-12-31", "2026-10-08");
    const ics = buildIcs({
      calendarName: "Annual Clock – Environmental",
      events: occ.map((o) => ({ occ: o, clockName: "Environmental", ringName: "Regulatory", url: "https://clock.test/x" })),
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261214");
    expect(ics).toContain("DTEND;VALUE=DATE:20270109");
    expect(ics).toContain("SUMMARY:EUA submission\\; surrender\\, due [Environmental]");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  });

  test("ICS import round trip", () => {
    const occ = buildOccurrences([{ ...act, rrule: null }], [], "2026-01-01", "2027-12-31", "2026-10-08");
    const ics = buildIcs({ calendarName: "x", events: occ.map((o) => ({ occ: o, clockName: "Env", ringName: "R", url: "https://u" })) });
    const ev = parseIcsEvents(ics);
    expect(ev).toEqual([
      expect.objectContaining({ title: "EUA submission; surrender, due [Env]", start_date: "2026-12-14", end_date: "2027-01-08" }),
    ]);
  });
});

describe("CSV", () => {
  test("export/import round trip with quotes, separators and formula neutralisation", () => {
    const csv = activitiesToCsv([{ ...act, title: '=HYPERLINK("x")' }], [{ id: "r", clock_id: "c", name: "Regulatory", color: "#000000", position: 0, hidden: false }], () => "owner@x.test");
    const recs = csvToRecords(csv);
    expect(recs[0].title).toBe('=HYPERLINK("x")');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(recs[0].ring).toBe("Regulatory");
    expect(recs[0].reminder_offsets).toBe("30;7");
    expect(recs[0].description).toBe("Line 1\nLine 2");
    expect(recs[0].links).toBe("Registry|https://example.org/x");
  });

  test("semicolon-delimited CSV (Excel, Finnish locale)", () => {
    expect(parseCsv("title;start_date\nA;2026-01-01\n")).toEqual([
      ["title", "start_date"],
      ["A", "2026-01-01"],
    ]);
  });
});
