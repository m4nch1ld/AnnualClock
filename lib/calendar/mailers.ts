/**
 * InviteMailer implementations.
 *
 * Outlook only treats a message as a meeting request when the iCalendar data is a
 * `text/calendar; method=REQUEST` alternative body part — a plain .ics attachment
 * is shown as a file. Nodemailer's `icalEvent` produces the correct MIME
 * structure, so SMTP is the preferred transport:
 *   - Resend:  SMTP_HOST=smtp.resend.com SMTP_PORT=465 SMTP_USER=resend SMTP_PASS=<RESEND_API_KEY>
 *   - Azure Communication Services: SMTP_HOST=smtp.azurecomm.net SMTP_PORT=587 (Entra app credentials)
 */
import nodemailer from "nodemailer";
import type { EmailProvider } from "../providers/email";
import type { InviteMailer } from "./ics-invite";

export class SmtpInviteMailer implements InviteMailer {
  readonly name = "smtp";
  private transport;
  constructor(
    opts: { host: string; port: number; user?: string; pass?: string },
    private from: string,
    private redirectTo?: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  async sendInvite(msg: Parameters<InviteMailer["sendInvite"]>[0]) {
    const redirected = this.redirectTo && this.redirectTo.toLowerCase() !== msg.to.toLowerCase();
    await this.transport.sendMail({
      from: this.from,
      to: redirected ? this.redirectTo : msg.to,
      subject: redirected ? `[to ${msg.to}] ${msg.subject}` : msg.subject,
      text: msg.text,
      html: msg.html,
      icalEvent: { method: msg.method, filename: "invite.ics", content: msg.ics },
    });
  }
}

/**
 * Fallback when no SMTP is configured: sends through the regular EmailProvider
 * with the .ics as an attachment. Fine for Gmail/Apple; Outlook may show it as
 * an attachment the user opens and saves (no automatic updates). Console
 * provider just logs.
 */
export class EmailProviderInviteMailer implements InviteMailer {
  readonly name: string;
  constructor(private email: EmailProvider) {
    this.name = `email:${email.name}`;
  }
  async sendInvite(msg: Parameters<InviteMailer["sendInvite"]>[0]) {
    await this.email.send({
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: [{ filename: "invite.ics", content: msg.ics, contentType: `text/calendar; charset=utf-8; method=${msg.method}` }],
    });
  }
}
