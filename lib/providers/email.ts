/**
 * Email abstraction. Resend for the prototype; Azure Communication Services
 * Email later (implement EmailProvider in one new file and select it here).
 */
import { Resend } from "resend";
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id?: string }>;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  private client: Resend;
  constructor(
    apiKey: string,
    private from: string,
  ) {
    this.client = new Resend(apiKey);
  }
  async send(msg: EmailMessage) {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, "utf8"), contentType: a.contentType })),
    });
    if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
    return { id: data?.id };
  }
}

/**
 * Generic SMTP (nodemailer). Use for Azure Communication Services Email
 * (smtp.azurecomm.net:587) or Resend SMTP — no vendor SDK needed.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transport;
  constructor(
    opts: { host: string; port: number; user?: string; pass?: string },
    private from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  async send(msg: EmailMessage) {
    const info = await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { id: info.messageId };
  }
}

/** Logs instead of sending (local development without an API key). */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  async send(msg: EmailMessage) {
    console.log(JSON.stringify({ level: "info", msg: "email (console provider)", to: msg.to, subject: msg.subject }));
    console.log(msg.text);
    for (const a of msg.attachments ?? []) console.log(`--- attachment ${a.filename} (${a.contentType ?? ""}) ---\n${a.content}`);
    return {};
  }
}

/**
 * Redirects every message to one address (demo / staging safety net), keeping
 * the original recipient visible in the subject.
 */
export class RedirectingEmailProvider implements EmailProvider {
  readonly name: string;
  constructor(
    private inner: EmailProvider,
    private redirectTo: string,
  ) {
    this.name = `${inner.name}+redirect`;
  }
  send(msg: EmailMessage) {
    if (msg.to.toLowerCase() === this.redirectTo.toLowerCase()) return this.inner.send(msg);
    return this.inner.send({ ...msg, to: this.redirectTo, subject: `[to ${msg.to}] ${msg.subject}` });
  }
}

let provider: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (provider) return provider;
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "ESL Annual Clock <onboarding@resend.dev>";
  const choice = process.env.EMAIL_PROVIDER ?? (key ? "resend" : "console");
  let p: EmailProvider =
    choice === "smtp" && process.env.SMTP_HOST
      ? new SmtpEmailProvider(
          { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          from,
        )
      : choice === "resend" && key
        ? new ResendEmailProvider(key, from)
        : new ConsoleEmailProvider();
  if (process.env.EMAIL_REDIRECT_TO) p = new RedirectingEmailProvider(p, process.env.EMAIL_REDIRECT_TO);
  provider = p;
  return p;
}

/** Test hook */
export function setEmailProvider(p: EmailProvider | undefined) {
  provider = p;
}
