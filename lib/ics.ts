/**
 * iCalendar (RFC 5545) feed generation. Occurrences are expanded server-side
 * (rather than emitting RRULEs) so per-occurrence completion shows up and
 * Outlook / Google / Apple all render identically.
 */
import { addDays, type ISODate } from "./dates";
import type { Occurrence } from "./domain";

export interface IcsEvent {
  occ: Occurrence;
  clockName: string;
  ringName: string;
  url: string;
}

const escText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

/** Fold lines to 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, "utf8");
    if (curLen + len > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const dateValue = (d: ISODate) => d.replace(/-/g, "");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function buildIcs(opts: { calendarName: string; events: IcsEvent[]; now?: Date }): string {
  const now = opts.now ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ESL Shipping//Annual Clock//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escText(opts.calendarName)}`,
    "X-WR-TIMEZONE:Europe/Helsinki",
    "REFRESH-INTERVAL;VALUE=DURATION:PT4H",
    "X-PUBLISHED-TTL:PT4H",
  ];
  for (const e of opts.events) {
    const o = e.occ;
    const a = o.activity;
    const done = o.status === "done";
    const prefix = done ? "✓ " : o.overdue ? "⚠ " : "";
    const end = addDays(o.endDate ?? o.date, 1); // DTEND is exclusive for all-day events
    const desc = [
      `${e.clockName} · ${e.ringName}`,
      done ? "Status: done" : o.overdue ? "Status: OVERDUE" : `Status: ${o.status.replace("_", " ")}`,
      a.description ?? "",
      e.url,
    ]
      .filter(Boolean)
      .join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${a.id}-${dateValue(o.date)}@annual-clock.eslshipping`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${dateValue(o.date)}`,
      `DTEND;VALUE=DATE:${dateValue(end)}`,
      `SUMMARY:${escText(`${prefix}${a.title} [${e.clockName}]`)}`,
      `DESCRIPTION:${escText(desc)}`,
      `URL:${e.url}`,
      `CATEGORIES:${escText(e.clockName)}`,
      `STATUS:${o.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
