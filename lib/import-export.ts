/**
 * CSV export/import of activities (also the migration path to other systems)
 * and a minimal ICS (VEVENT) importer. Pure functions.
 */
import { addDays, isISODate, type ISODate } from "./dates";
import type { Activity, Ring } from "./domain";

export const CSV_COLUMNS = [
  "id",
  "title",
  "description",
  "ring",
  "type",
  "start_date",
  "end_date",
  "all_day",
  "start_time",
  "end_time",
  "rrule",
  "status",
  "owner_email",
  "assignee_emails",
  "reminder_offsets",
  "tags",
  "links",
  "predecessor_title",
] as const;
export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>;

function csvCell(v: string): string {
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function activitiesToCsv(
  activities: Activity[],
  rings: Ring[],
  emailOf: (id: string | null) => string,
): string {
  const ringName = new Map(rings.map((r) => [r.id, r.name]));
  const titleOf = new Map(activities.map((a) => [a.id, a.title]));
  const rows = activities.map((a): CsvRow => ({
    id: a.id,
    title: a.title,
    description: a.description ?? "",
    ring: ringName.get(a.ring_id) ?? "",
    type: a.type,
    start_date: a.start_date,
    end_date: a.end_date ?? "",
    all_day: String(a.all_day),
    start_time: a.start_time ?? "",
    end_time: a.end_time ?? "",
    rrule: a.rrule ?? "",
    status: a.status,
    owner_email: emailOf(a.owner_id),
    assignee_emails: a.assignee_ids.map(emailOf).join(";"),
    reminder_offsets: a.reminder_offsets?.join(";") ?? "",
    tags: a.tags.join(";"),
    links: a.links.map((l) => (l.label ? `${l.label}|${l.url}` : l.url)).join(";"),
    predecessor_title: a.predecessor_id ? (titleOf.get(a.predecessor_id) ?? "") : "",
  }));
  return "﻿" + [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** RFC 4180 CSV parser (handles quotes, escaped quotes, CRLF, BOM). Accepts , or ; delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export function csvToRecords(text: string): Array<Partial<CsvRow>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? "").replace(/^'(?=[=+\-@])/, "").trim()])));
}

export interface ImportedEvent {
  title: string;
  description: string | null;
  start_date: ISODate;
  end_date: ISODate | null;
  rrule: string | null;
}

/** Minimal VEVENT importer: SUMMARY, DESCRIPTION, DTSTART, DTEND, RRULE. */
export function parseIcsEvents(text: string): ImportedEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: ImportedEvent[] = [];
  let cur: Record<string, string> | null = null;
  const unesc = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  const toDate = (v: string | undefined): ISODate | null => {
    const m = v?.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      const start = toDate(cur.DTSTART);
      if (start && isISODate(start) && cur.SUMMARY) {
        let end = toDate(cur.DTEND);
        const allDay = /^\d{8}$/.test(cur.DTSTART ?? "");
        if (end && allDay) end = addDays(end, -1); // DTEND is exclusive for all-day events
        out.push({
          title: unesc(cur.SUMMARY).slice(0, 200),
          description: cur.DESCRIPTION ? unesc(cur.DESCRIPTION).slice(0, 5000) : null,
          start_date: start,
          end_date: end && end > start ? end : null,
          rrule: cur.RRULE ?? null,
        });
      }
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const name = line.slice(0, idx).split(";")[0].toUpperCase();
        cur[name] = line.slice(idx + 1);
      }
    }
  }
  return out;
}
