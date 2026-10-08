"use client";

import { useActionState } from "react";
import { sendLinkAction, type LoginState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { t } from "@/lib/i18n";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendLinkAction, { status: "idle" });
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <div>
        <Label htmlFor="email">{t("login.email")}</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="firstname.lastname@eslshipping.com" />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("common.loading") : t("login.submit")}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {state.status === "sent" && <span className="text-success">{t("login.sent")}</span>}
        {state.status === "error" && <span className="text-danger">{t("login.invalid")}</span>}
      </p>
    </form>
  );
}
