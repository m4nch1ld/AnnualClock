/**
 * Email abstraction. Resend for the prototype; Azure Communication Services
 * Email later (implement EmailProvider in one new file and select it here).
 */
import { Resend } from "resend";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
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
    });
    if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
    return { id: data?.id };
  }
}

/** Logs instead of sending (local development without an API key). */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  async send(msg: EmailMessage) {
    console.log(JSON.stringify({ level: "info", msg: "email (console provider)", to: msg.to, subject: msg.subject }));
    console.log(msg.text);
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
  const choice = process.env.EMAIL_PROVIDER ?? (key ? "resend" : "console");
  let p: EmailProvider =
    choice === "resend" && key
      ? new ResendEmailProvider(key, process.env.EMAIL_FROM ?? "ESL Annual Clock <onboarding@resend.dev>")
      : new ConsoleEmailProvider();
  if (process.env.EMAIL_REDIRECT_TO) p = new RedirectingEmailProvider(p, process.env.EMAIL_REDIRECT_TO);
  provider = p;
  return p;
}

/** Test hook */
export function setEmailProvider(p: EmailProvider | undefined) {
  provider = p;
}
