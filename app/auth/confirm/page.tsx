import { redirect } from "next/navigation";
import { auth } from "@/lib/server/auth";
import { safeNext } from "@/lib/server/safe-redirect";
import { withService } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export const metadata = { title: "Sign in" };

/**
 * Email links land here. Sign-in happens on an explicit POST (button), not on
 * GET, so mail scanners (e.g. Outlook Safe Links) cannot consume the one-time token.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; code?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);

  async function complete(form: FormData) {
    "use server";
    const params = new URLSearchParams();
    const th = form.get("token_hash");
    const code = form.get("code");
    if (typeof th === "string" && th) params.set("token_hash", th);
    if (typeof code === "string" && code) params.set("code", code);
    const user = await auth.completeSignIn(params);
    if (!user) redirect("/login?error=link");
    const active = await withService((tx) =>
      tx.one<{ is_active: boolean }>(`select is_active from profiles where id = $1`, [user.id]),
    );
    if (!active?.is_active) {
      await auth.signOut();
      redirect("/login?error=inactive");
    }
    redirect(safeNext(String(form.get("next") ?? "")));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="accent-bar mb-2 text-xl">{t("login.confirmTitle")}</h1>
        <p className="mb-4 text-sm text-muted">{t("login.confirmIntro")}</p>
        <form action={complete}>
          <input type="hidden" name="token_hash" value={sp.token_hash ?? ""} />
          <input type="hidden" name="code" value={sp.code ?? ""} />
          <input type="hidden" name="next" value={next} />
          <Button type="submit" className="w-full">
            {t("login.confirmButton")}
          </Button>
        </form>
      </Card>
    </main>
  );
}
