/**
 * Server-side configuration, validated once. Never import from client components.
 * All variables are documented in .env.example.
 */
import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Azure SQL: either a connection string, or host + name with Entra workload-identity sign-in (lib/db)
  DATABASE_URL: z.string().optional(),
  DATABASE_HOST: z.string().optional(),
  DATABASE_NAME: z.string().optional(),
  DATABASE_SCHEMA: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  APP_TOKEN_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("ESL Annual Clock <onboarding@resend.dev>"),
  /** If set, every outgoing email goes to this address instead (demo/staging safety net). */
  EMAIL_REDIRECT_TO: z.string().optional(),
  /** 'resend' (default when RESEND_API_KEY is set) or 'console' (log only). */
  EMAIL_PROVIDER: z.enum(["resend", "smtp", "console"]).optional(),
  /** Enables the one-click demo user switcher on the login page. Never enable in production. */
  DEMO_LOGIN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  DEFAULT_TIMEZONE: z.string().default("Europe/Helsinki"),
}).refine((e) => !!e.DATABASE_URL || (!!e.DATABASE_HOST && !!e.DATABASE_NAME), {
  message: "Set DATABASE_URL, or DATABASE_HOST and DATABASE_NAME",
  path: ["DATABASE_URL"],
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}
