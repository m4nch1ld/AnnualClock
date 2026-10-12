/**
 * iCalendar invitation provider: the event is delivered as a meeting request
 * email (METHOD:REQUEST). Outlook adds it to the recipient's own calendar and
 * applies later REQUESTs (same UID, higher SEQUENCE) as updates and CANCELs as
 * removals. All-day, shown as Free, no RSVP replies requested.
 */
import { addDays } from "../dates";
import type { CalendarEvent, CalendarLink, CalendarProvider } from "./types";

export type InviteMethod = "REQUEST" | "CANCEL" | "PUBLISH";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const d = (iso: string) => iso.replace(/-/g, "");
const stamp = (t: Date) => t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** CN parameter values must be quoted if they contain : ; , */
const cn = (s: string) => `"${s.replace(/"/g, "'")}"`;

function fold(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const l = Buffer.byteLength(ch, "utf8");
    if (len + l > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += l;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export function buildInviteIcs(ev: CalendarEvent, method: InviteMethod, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ESL Shipping//Annual Clock//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `SEQUENCE:${ev.sequence}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${d(ev.start)}`,
    `DTEND;VALUE=DATE:${d(addDays(ev.end, 1))}`,
    ...(ev.rrule ? [`RRULE:${ev.rrule}`] : []),
    `SUMMARY:${esc(ev.summary)}`,
    `DESCRIPTION:${esc(ev.description)}`,
    `URL:${ev.url}`,
    ...(method === "PUBLISH"
      ? []
      : [
          `ORGANIZER;CN=${cn(ev.organizer.name)}:mailto:${ev.organizer.email}`,
          `ATTENDEE;CN=${cn(ev.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${method === "CANCEL" ? "DECLINED" : "NEEDS-ACTION"};RSVP=FALSE:mailto:${ev.attendee.email}`,
        ]),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:TRANSPARENT",
    "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
    "X-MICROSOFT-CDO-INTENDEDSTATUS:FREE",
    "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
    "X-MICROSOFT-DISALLOW-COUNTER:TRUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Sends an invitation email whose calendar part Outlook recognises as a meeting request. */
export interface InviteMailer {
  readonly name: string;
  sendInvite(msg: { to: string; subject: string; text: string; html: string; ics: string; method: Exclude<InviteMethod, "PUBLISH"> }): Promise<void>;
}

export class IcsInviteProvider implements CalendarProvider {
  readonly id = "ics_invite" as const;
  constructor(private mailer: InviteMailer) {}

  async upsert(_link: CalendarLink, ev: CalendarEvent, isNew: boolean) {
    const verb = isNew ? "Added to your calendar" : "Updated in your calendar";
    await this.mailer.sendInvite({
      to: ev.attendee.email,
      subject: `${isNew ? "" : "Updated: "}${ev.summary}`,
      text: `${verb}: ${ev.summary}\n\n${ev.description}`,
      html: inviteHtml(verb, ev),
      ics: buildInviteIcs(ev, "REQUEST"),
      method: "REQUEST",
    });
    return {};
  }

  async cancel(_link: CalendarLink, ev: CalendarEvent) {
    await this.mailer.sendInvite({
      to: ev.attendee.email,
      subject: `Removed: ${ev.summary}`,
      text: `Removed from your calendar: ${ev.summary}\n${ev.url}`,
      html: inviteHtml("Removed from your calendar", ev),
      ics: buildInviteIcs(ev, "CANCEL"),
      method: "CANCEL",
    });
  }
}

function inviteHtml(verb: string, ev: CalendarEvent) {
  const h = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#212529">
<p style="margin:0 0 4px;color:#515B65;font-size:12px">ESL ANNUAL CLOCK</p>
<p style="margin:0 0 8px"><strong>${h(verb)}:</strong> ${h(ev.summary)}</p>
<p style="margin:0 0 12px;white-space:pre-line">${h(ev.description)}</p>
<p style="margin:0"><a href="${h(ev.url)}" style="color:#26645F">Open in Annual Clock</a></p></div>`;
}
