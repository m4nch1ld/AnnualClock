import Image from "next/image";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";
import { demoLoginAction } from "./actions";
import { getSession } from "@/lib/server/session";
import { safeNext } from "@/lib/server/safe-redirect";
import { withService } from "@/lib/db";
import { env } from "@/lib/env";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await getSession()) redirect(next);
  const demoUsers = env().DEMO_LOGIN_ENABLED
    ? await withService((tx) =>
        tx.query<{ email: string; full_name: string }>(
          `select email, full_name from profiles where is_demo and is_active order by created_at`,
        ),
      )
    : [];

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-md space-y-4">
        <Card className="p-6">
          <div className="mb-6 flex items-center gap-3">
            <Image src="/brand/esl-horizontal.png" alt="ESL Shipping" width={132} height={40} priority />
            <span className="border-l border-border pl-3 text-sm text-muted">{t("app.name")}</span>
          </div>
          <h1 className="accent-bar mb-2 text-xl">{t("login.title")}</h1>
          <p className="mb-4 text-sm text-muted">{t("login.intro")}</p>
          {sp.error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-soft p-2 text-sm text-danger">
              {t("login.failed")}
            </p>
          )}
          <LoginForm next={next} />
          <p className="mt-4 text-xs text-muted">{t("login.entraNote")}</p>
        </Card>
        {demoUsers.length > 0 && (
          <Card className="p-4">
            <h2 className="text-sm font-medium">{t("login.demoTitle")}</h2>
            <p className="mb-3 text-xs text-muted">{t("login.demoIntro")}</p>
            <ul className="grid gap-2">
              {demoUsers.map((u) => (
                <li key={u.email}>
                  <form action={demoLoginAction}>
                    <input type="hidden" name="email" value={u.email} />
                    <input type="hidden" name="next" value={next} />
                    <button
                      type="submit"
                      className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-canvas"
                    >
                      <span className="block font-medium">{u.full_name}</span>
                      <span className="block text-xs text-muted">{u.email}</span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </main>
  );
}
