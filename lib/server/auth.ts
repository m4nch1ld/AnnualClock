/** Selects the active AuthProvider. Swap here for Entra ID. */
import "server-only";
import type { AuthProvider } from "@/lib/providers/auth";
import { supabaseAuthProvider } from "@/lib/providers/supabase/auth";

export const auth: AuthProvider = supabaseAuthProvider;
