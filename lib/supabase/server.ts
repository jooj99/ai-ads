import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Server-only Supabase client using the secret key. Every table has RLS
 * enabled with no policies, so the database is reachable only from here,
 * never with the public key in the browser. (Single demo user; no auth yet.)
 */
export function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase isn't configured: set SUPABASE_URL and SUPABASE_SECRET_KEY.");
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
