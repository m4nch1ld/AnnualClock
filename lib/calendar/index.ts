/**
 * Composition root for personal calendar sync ("Add to my Outlook").
 *
 * CALENDAR_PROVIDER=ics_invite (default) — iCalendar invitations by email:
 *   SMTP_HOST/PORT/USER/PASS set → proper Outlook meeting requests via SMTP (recommended)
 *   otherwise                    → .ics attachment through the regular EmailProvider
 * CALENDAR_PROVIDER=graph — Microsoft Graph; requires a GraphTokenSource (Entra ID sign-in),
 *   see docs/azure-migration.md. Throws until one is registered with setGraphTokenSource().
 */
import { getEmailProvider } from "../providers/email";
import { GraphCalendarProvider, type GraphTokenSource } from "./graph";
import { IcsInviteProvider } from "./ics-invite";
import { EmailProviderInviteMailer, SmtpInviteMailer } from "./mailers";
import { createPgCalendarRepository } from "./pg-repository";
import { addLink, removeLink, retryFailed, syncActivity, type CalendarDeps } from "./sync";
import type { CalendarProvider } from "./types";

export * from "./types";
export { buildInviteIcs } from "./ics-invite";

let graphTokens: GraphTokenSource | undefined;
/** Register the Entra/Graph token source (Azure deployment). */
export function setGraphTokenSource(src: GraphTokenSource) {
  graphTokens = src;
}

function addressOf(from: string) {
  return from.match(/<([^>]+)>/)?.[1] ?? from.trim();
}

function createProvider(): CalendarProvider {
  const choice = process.env.CALENDAR_PROVIDER ?? "ics_invite";
  if (choice === "graph") {
    if (!graphTokens) throw new Error("CALENDAR_PROVIDER=graph but no Graph token source is registered");
    return new GraphCalendarProvider(graphTokens);
  }
  const from = process.env.EMAIL_FROM ?? "ESL Annual Clock <onboarding@resend.dev>";
  const mailer = process.env.SMTP_HOST
    ? new SmtpInviteMailer(
        { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 465), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        from,
        process.env.EMAIL_REDIRECT_TO || undefined,
      )
    : new EmailProviderInviteMailer(getEmailProvider());
  return new IcsInviteProvider(mailer);
}

let deps: CalendarDeps | undefined;
export function defaultCalendarDeps(): CalendarDeps {
  if (!deps) {
    const from = process.env.EMAIL_FROM ?? "ESL Annual Clock <onboarding@resend.dev>";
    deps = {
      repo: createPgCalendarRepository(),
      provider: createProvider(),
      baseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
      organizer: { email: process.env.CALENDAR_ORGANIZER_EMAIL ?? addressOf(from), name: "ESL Annual Clock" },
    };
  }
  return deps;
}

export const calendar = {
  add: (input: Parameters<typeof addLink>[1]) => addLink(defaultCalendarDeps(), input),
  remove: (input: Parameters<typeof removeLink>[1]) => removeLink(defaultCalendarDeps(), input),
  syncActivity: (activityId: string) => syncActivity(defaultCalendarDeps(), activityId),
  retryFailed: () => retryFailed(defaultCalendarDeps()),
  repo: () => defaultCalendarDeps().repo,
};
