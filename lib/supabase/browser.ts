"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Browser Supabase client with the publishable key, used only to subscribe to
 * Realtime broadcasts. It can't read or write tables: RLS has no policies on
 * them. It picks up the signed-in session from the auth cookies (@supabase/ssr
 * keeps them readable by the page for this) and keeps the token fresh, so it
 * can join the private channels, which only signed-in users may receive on
 * (lib/realtime.ts). Returns null when the public env vars are missing, so
 * pages still work (without live updates).
 */
export function browserSupabase(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  client = createBrowserClient(url, key);
  return client;
}

/**
 * Subscribes to a private channel once the client holds the signed-in user's
 * token. The client reads the session from the cookies asynchronously, and a
 * join sent before that goes out signed-out, which a private channel refuses
 * (the page would then get no live updates). Returns the cleanup.
 */
export function subscribeSignedIn(
  client: SupabaseClient,
  channel: RealtimeChannel,
  onState?: Parameters<RealtimeChannel["subscribe"]>[0],
): () => void {
  let active = true;
  void client.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (active) channel.subscribe(onState);
    });
  return () => {
    active = false;
    void client.removeChannel(channel);
  };
}
