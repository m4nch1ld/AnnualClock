/**
 * Recurrence: activities store an RRULE body (no DTSTART), e.g. "FREQ=YEARLY".
 * Occurrences are expanded in code for the requested range only.
 */
import * as rruleNs from "rrule";
import { addDays, diffDays, fromUTCDate, toUTCDate, type ISODate } from "./dates";

// rrule ships CommonJS; normalise the import for both bundlers and plain Node.
const rrule = ((rruleNs as unknown as { default?: typeof rruleNs }).default ?? rruleNs) as typeof rruleNs;

export type RecurrenceKind = "none" | "yearly" | "quarterly" | "monthly" | "weekly" | "custom";

export const RECURRENCE_PRESETS: Record<Exclude<RecurrenceKind, "none" | "custom">, string> = {
  yearly: "FREQ=YEARLY",
  quarterly: "FREQ=MONTHLY;INTERVAL=3",
  monthly: "FREQ=MONTHLY",
  weekly: "FREQ=WEEKLY",
};

const ALLOWED_FREQ = new Set(["YEARLY", "MONTHLY", "WEEKLY", "DAILY"]);
const MAX_OCCURRENCES = 2000;

/** Normalise and validate a user-supplied RRULE body. Returns null if invalid. */
export function normalizeRRule(input: string | null | undefined): string | null {
  if (!input) return null;
  let body = input.trim();
  if (body.toUpperCase().startsWith("RRULE:")) body = body.slice(6);
  if (!body || /DTSTART|\n|\r/i.test(body)) return null;
  try {
    const opts = rrule.RRule.parseString(body);
    const freqName = rrule.RRule.FREQUENCIES[opts.freq as number];
    if (!freqName || !ALLOWED_FREQ.has(freqName)) return null;
    return rrule.RRule.optionsToString(opts).replace(/^RRULE:/, "");
  } catch {
    return null;
  }
}

export function recurrenceKindOf(rrule: string | null | undefined): RecurrenceKind {
  if (!rrule) return "none";
  for (const [k, v] of Object.entries(RECURRENCE_PRESETS)) if (v === rrule) return k as RecurrenceKind;
  return "custom";
}

export function rruleForKind(kind: RecurrenceKind, custom?: string | null): string | null {
  if (kind === "none") return null;
  if (kind === "custom") return normalizeRRule(custom);
  return RECURRENCE_PRESETS[kind];
}

export function describeRRule(body: string | null | undefined): string {
  if (!body) return "Does not repeat";
  try {
    return rrule.rrulestr(body, { dtstart: new Date(Date.UTC(2026, 0, 1)) }).toText();
  } catch {
    return body;
  }
}

/** Set UNTIL on a series so it ends the day before `date` (used to split a series). */
export function endSeriesBefore(body: string, date: ISODate): string {
  const opts = rrule.RRule.parseString(body);
  delete opts.count;
  opts.until = toUTCDate(addDays(date, -1));
  return rrule.RRule.optionsToString(opts).replace(/^RRULE:/, "");
}

export interface RecurringSource {
  start_date: ISODate;
  end_date: ISODate | null;
  rrule: string | null;
}

export interface ExpandedOccurrence {
  /** occurrence start date (also the identity of the occurrence) */
  date: ISODate;
  /** occurrence end date for periods, else null */
  endDate: ISODate | null;
}

/**
 * Expand occurrences that overlap [from, to] (inclusive).
 * Periods keep their duration; an occurrence starting before `from` but ending
 * inside the range is included (e.g. a Dec–Jan period at the year boundary).
 */
export function expandOccurrences(src: RecurringSource, from: ISODate, to: ISODate): ExpandedOccurrence[] {
  const duration = src.end_date ? Math.max(0, diffDays(src.start_date, src.end_date)) : 0;
  const mk = (date: ISODate): ExpandedOccurrence => ({
    date,
    endDate: src.end_date ? addDays(date, duration) : null,
  });
  const overlaps = (o: ExpandedOccurrence) => o.date <= to && (o.endDate ?? o.date) >= from;

  if (!src.rrule) {
    const o = mk(src.start_date);
    return overlaps(o) ? [o] : [];
  }
  let rule: InstanceType<typeof rrule.RRule> | ReturnType<typeof rrule.rrulestr>;
  try {
    rule = rrule.rrulestr(src.rrule, { dtstart: toUTCDate(src.start_date) });
  } catch {
    const o = mk(src.start_date);
    return overlaps(o) ? [o] : [];
  }
  const out: ExpandedOccurrence[] = [];
  const searchFrom = toUTCDate(addDays(from, -duration));
  const searchTo = toUTCDate(to);
  rule.between(searchFrom, searchTo, true, (d) => {
    out.push(mk(fromUTCDate(d)));
    return out.length < MAX_OCCURRENCES;
  });
  return out.filter(overlaps);
}
