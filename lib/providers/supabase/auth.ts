import "server-only";
import type { AuthProvider, AuthUser } from "../auth";
import { supabaseServer } from "./clients";
import { generateSignInTokenHash } from "./admin-identity";
import { getEmailProvider } from "../email";
import { renderSignInEmail } from "@/lib/notifications/templates";

export const supabaseAuthProvider: AuthProvider = {
  async getCurrentUser(): Promise<AuthUser | null> {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.getClaims();
    if (error || !data?.claims?.sub) return null;
    return { id: data.claims.sub, email: String(data.claims.email ?? "") };
  },

  async sendSignInLink(email, redirectTo) {
    // Links are delivered through our own EmailProvider (branded, not subject to
    // Supabase's built-in SMTP limits). Unknown emails silently get nothing.
    const tokenHash = await generateSignInTokenHash(email);
    if (!tokenHash) return;
    const url = new URL(redirectTo);
    url.searchParams.set("token_hash", tokenHash);
    url.searchParams.set("type", "magiclink");
    await getEmailProvider().send({ to: email, ...renderSignInEmail({ url: url.toString(), email }) });
  },

  async completeSignIn(params) {
    const sb = await supabaseServer();
    const tokenHash = params.get("token_hash");
    const code = params.get("code");
    if (tokenHash) {
      const { data, error } = await sb.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
      if (error || !data.user) return null;
      return { id: data.user.id, email: data.user.email ?? "" };
    }
    if (code) {
      const { data, error } = await sb.auth.exchangeCodeForSession(code);
      if (error || !data.user) return null;
      return { id: data.user.id, email: data.user.email ?? "" };
    }
    return null;
  },

  async signOut() {
    const sb = await supabaseServer();
    await sb.auth.signOut();
  },
};

/** Demo-only: sign in as an existing user without an email round-trip. */
export async function createDemoSession(email: string): Promise<AuthUser | null> {
  const tokenHash = await generateSignInTokenHash(email);
  if (!tokenHash) return null;
  return supabaseAuthProvider.completeSignIn(new URLSearchParams({ token_hash: tokenHash }));
}
