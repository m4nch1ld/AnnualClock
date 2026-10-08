/**
 * Channel-independent wording for each notification, plus channel renderers
 * (email HTML/text, in-app, Teams Adaptive Card). Pure functions.
 */
import { formatDate, formatDateRange } from "../i18n";
import { esc, layout, type RenderedEmail } from "./templates";
import type { DeliveryContext, DigestItem } from "./types";

export interface Wording {
  subject: string;
  headline: string;
  lines: string[];
}

function whenText(days: number | null): string {
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${days} days`;
  if (days === -1) return "1 day ago";
  return `${-days} days ago`;
}

export function wording(ctx: DeliveryContext): Wording {
  const { intent, clock, activity } = ctx;
  const title = activity?.title ?? "";
  const dept = clock?.name ?? "";
  const dates = intent.occurrenceDate ? formatDateRange(intent.occurrenceDate, intent.endDate ?? null) : "";
  switch (intent.kind) {
    case "reminder":
    case "snooze": {
      const w = whenText(ctx.daysRemaining);
      return {
        subject: `${title} – due ${w} (${dates})`,
        headline: `${title}`,
        lines: [
          `${intent.kind === "snooze" ? "Snoozed reminder: " : ""}Due ${w}: ${dates}`,
          `Clock: ${dept}`,
          ...(ctx.ownerName ? [`Owner: ${ctx.ownerName}`] : []),
        ],
      };
    }
    case "escalation": {
      const late = ctx.daysRemaining !== null ? -ctx.daysRemaining : intent.offsetDays ?? 0;
      return {
        subject: `OVERDUE: ${title} (${dept}) – ${late} day${late === 1 ? "" : "s"} past due`,
        headline: `Overdue: ${title}`,
        lines: [
          `Was due ${formatDate(intent.dueDate ?? intent.occurrenceDate!)} and is not marked done (${late} day${late === 1 ? "" : "s"} overdue).`,
          `Clock: ${dept}`,
          ...(ctx.ownerName ? [`Owner: ${ctx.ownerName}`] : []),
          "You receive this escalation as a clock admin or member of General management.",
        ],
      };
    }
    case "test":
      return {
        subject: `Test notification – ${dept} annual clock`,
        headline: "Test notification",
        lines: [`This is a test from the ${dept} annual clock. If you can read this, notifications reach you on this channel.`],
      };
    case "digest":
      return {
        subject: `Your annual clock: next 30 days${ctx.digest?.overdue.length ? ` · ${ctx.digest.overdue.length} overdue` : ""}`,
        headline: "Weekly digest",
        lines: [],
      };
  }
}

export function renderEmail(ctx: DeliveryContext): RenderedEmail {
  if (ctx.intent.kind === "digest") return renderDigestEmail(ctx);
  const w = wording(ctx);
  const buttons = [
    { label: "Open in clock", url: ctx.links.open, primary: !ctx.links.done },
    ...(ctx.links.done ? [{ label: "Mark done", url: ctx.links.done, primary: true }] : []),
    ...(ctx.links.snooze ? [{ label: "Snooze", url: ctx.links.snooze }] : []),
  ].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const badge =
    ctx.intent.kind === "escalation"
      ? `<p style="margin:0 0 12px"><span style="display:inline-block;background:#FDECEA;color:#B42318;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600">OVERDUE</span></p>`
      : ctx.daysRemaining !== null
        ? `<p style="margin:0 0 12px"><span style="display:inline-block;background:#E6F4EA;color:#26645F;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600">${esc(whenText(ctx.daysRemaining).toUpperCase())}</span></p>`
        : "";
  const body = `${badge}${w.lines.map((l) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.5">${esc(l)}</p>`).join("")}${
    ctx.activity?.description ? `<p style="margin:12px 0 0;font-size:13px;color:#515B65;line-height:1.5">${esc(ctx.activity.description.slice(0, 400))}</p>` : ""
  }`;
  return {
    subject: w.subject,
    html: layout({
      preheader: w.lines[0] ?? w.subject,
      heading: w.headline,
      bodyHtml: body,
      buttons,
      footer: `ESL Annual Clock · ${esc(ctx.clock?.name ?? "")}. <a href="${esc(ctx.links.settings)}" style="color:#515B65">Notification settings</a>`,
    }),
    text: [
      w.headline,
      "",
      ...w.lines,
      "",
      `Open in clock: ${ctx.links.open}`,
      ...(ctx.links.done ? [`Mark done: ${ctx.links.done}`] : []),
      ...(ctx.links.snooze ? [`Snooze: ${ctx.links.snooze}`] : []),
      "",
      `Notification settings: ${ctx.links.settings}`,
    ].join("\n"),
  };
}

function digestRows(items: DigestItem[], base: string) {
  return items
    .map(
      (i) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #EEF2F5;font-size:13px;white-space:nowrap;color:${i.overdue ? "#B42318" : "#515B65"}">${esc(formatDateRange(i.date, i.endDate))}</td>
<td style="padding:6px 8px;border-bottom:1px solid #EEF2F5;font-size:13px"><a href="${esc(`${base}/clocks/${i.clockSlug}?year=${i.date.slice(0, 4)}&focus=${i.activityId}:${i.date}`)}" style="color:#212529;text-decoration:none">${esc(i.title)}</a></td>
<td style="padding:6px 8px;border-bottom:1px solid #EEF2F5;font-size:12px;color:#515B65">${esc(i.clockName)}</td></tr>`,
    )
    .join("");
}

function renderDigestEmail(ctx: DeliveryContext): RenderedEmail {
  const d = ctx.digest!;
  const base = ctx.links.open.replace(/\/clocks.*$/, "");
  const w = wording(ctx);
  const section = (title: string, items: DigestItem[], empty: string) =>
    `<h2 style="margin:18px 0 6px;font-size:15px;font-weight:600">${esc(title)}</h2>${
      items.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${digestRows(items, base)}</table>`
        : `<p style="margin:0;font-size:13px;color:#515B65">${esc(empty)}</p>`
    }`;
  const html = layout({
    preheader: `${d.upcoming.length} upcoming, ${d.overdue.length} overdue`,
    heading: `Your clocks: ${formatDate(d.from)} – ${formatDate(d.to)}`,
    bodyHtml: section(`Overdue (${d.overdue.length})`, d.overdue, "Nothing overdue.") + section(`Next 30 days (${d.upcoming.length})`, d.upcoming, "Nothing scheduled."),
    buttons: [{ label: "Open Annual Clock", url: `${base}/clocks`, primary: true }],
    footer: `Weekly digest. <a href="${esc(ctx.links.settings)}" style="color:#515B65">Turn off or change settings</a>`,
  });
  const line = (i: DigestItem) => `- ${formatDateRange(i.date, i.endDate)}  ${i.title} (${i.clockName})`;
  return {
    subject: w.subject,
    html,
    text: [`Overdue (${d.overdue.length})`, ...d.overdue.map(line), "", `Next 30 days (${d.upcoming.length})`, ...d.upcoming.map(line), "", `${base}/clocks`].join("\n"),
  };
}

export function renderInApp(ctx: DeliveryContext) {
  const w = wording(ctx);
  return { title: w.headline, body: w.lines.slice(0, 2).join(" · "), link: ctx.links.open.replace(/^https?:\/\/[^/]+/, "") };
}

/** Adaptive Card for Teams incoming webhooks / Workflows ("Post to a channel when a webhook request is received"). */
export function renderTeamsCard(ctx: DeliveryContext) {
  const w = wording(ctx);
  const overdue = ctx.intent.kind === "escalation";
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: `${ctx.clock?.name ?? ""} · Annual Clock`, size: "Small", isSubtle: true, wrap: true },
            { type: "TextBlock", text: w.headline, weight: "Bolder", size: "Medium", color: overdue ? "Attention" : "Default", wrap: true },
            ...w.lines.map((l) => ({ type: "TextBlock", text: l, wrap: true, spacing: "Small" })),
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open in clock", url: ctx.links.open }],
        },
      },
    ],
  };
}
