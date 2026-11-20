import "server-only";

import { supabase } from "@/lib/supabase/server";

/**
 * Sends a Realtime broadcast from the server (secret key). Never throws.
 *
 * The server client never signs in, so its Realtime connection has no access
 * token until one is set; broadcasts sent without one get a 202 from
 * Realtime but are never delivered to subscribers. `setAuth()` with no
 * argument takes the token from supabase-js's callback, which is the secret
 * key when there's no session, before every send.
 */
export async function broadcast(topic: string, event: string, payload: object): Promise<void> {
  try {
    const client = supabase();
    await client.realtime.setAuth();
    const result = await client.channel(topic).httpSend(event, payload);
    if (!result.success) console.error(`[realtime] ${event} on ${topic} wasn't accepted`, result);
  } catch (error) {
    console.error(`[realtime] ${event} on ${topic} failed`, error);
  }
}
