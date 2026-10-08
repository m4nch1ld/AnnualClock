/**
 * Identity administration via the Supabase Auth admin API. No Next.js imports,
 * so scripts (seed) can use it too.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function admin(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function findUserIdByEmail(client: SupabaseClient, email: string): Promise<string | null> {
  const target = email.toLowerCase();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Create (or find) an auth identity for the email, without sending any email. */
export async function ensureIdentity(email: string): Promise<{ id: string }> {
  const client = admin();
  const { data, error } = await client.auth.admin.createUser({ email, email_confirm: true });
  if (!error && data.user) return { id: data.user.id };
  const existing = await findUserIdByEmail(client, email);
  if (existing) return { id: existing };
  throw error ?? new Error(`Could not create identity for ${email}`);
}

/**
 * Generate a one-time sign-in token for an EXISTING identity. Returns null if the
 * email has no identity (we never self-register users).
 */
export async function generateSignInTokenHash(email: string): Promise<string | null> {
  const client = admin();
  const { data, error } = await client.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) return null;
  return data.properties.hashed_token;
}
