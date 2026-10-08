/**
 * Authentication abstraction. The prototype uses Supabase Auth (email magic
 * link); production swaps in Microsoft Entra ID (OIDC) by implementing this
 * interface in one new file. Nothing else in the app talks to the IdP.
 */
export interface AuthUser {
  /** Stable subject id; becomes profiles.id. (Entra: the user's object id.) */
  id: string;
  email: string;
}

export interface AuthProvider {
  /** The signed-in user for the current request, or null. */
  getCurrentUser(): Promise<AuthUser | null>;
  /** Start passwordless sign-in (magic link). */
  sendSignInLink(email: string, redirectTo: string): Promise<void>;
  /** Complete sign-in from the callback (code exchange). */
  completeSignIn(params: URLSearchParams): Promise<AuthUser | null>;
  signOut(): Promise<void>;
}

/** Server-side identity administration (invite, provisioning). */
export interface IdentityAdmin {
  /** Ensure an identity exists for the email and send it an invitation link. Returns its id. */
  inviteUser(email: string, redirectTo: string): Promise<{ id: string }>;
  /** Create (or find) an identity without sending email (seeding, provisioning). */
  ensureUser(email: string): Promise<{ id: string }>;
  /** Demo only: sign in as a user without email (requires DEMO_LOGIN_ENABLED). */
  createDemoSession?(email: string): Promise<void>;
}
