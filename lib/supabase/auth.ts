import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Supabase Auth for the app's single demo user (email + password).
 *
 * The session lives in cookies set by @supabase/ssr. This client uses the
 * publishable key, so it can sign in and read the session but still can't
 * touch tables (RLS has no policies); data access stays on the secret-key
 * client in ./server.ts. Auth only decides who may use the app.
 *
 * `proxy.ts` refreshes the session and turns signed-out visitors away on every
 * request; pages, route handlers and server actions check again with
 * `currentUser()` / `requireUser()` so nothing relies on the proxy alone.
 */

export type AppUser = { id: string; email: string | null };

export function authEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
}

/** A per-request auth client reading and writing the session cookies. */
export async function authClient() {
  const env = authEnv();
  if (!env) throw new Error("Auth isn't configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  const store = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        // Server components can't set cookies; the proxy already refreshed
        // the session for this request, so skipping the write there is safe.
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {}
      },
    },
  });
}

/**
 * The signed-in user, or null. `getClaims()` verifies the session's JWT
 * (against the project's signing keys), so a forged cookie doesn't pass.
 */
export async function currentUser(): Promise<AppUser | null> {
  if (!authEnv()) return null;
  const { data, error } = await (await authClient()).auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return { id: data.claims.sub, email: typeof data.claims.email === "string" ? data.claims.email : null };
}

/** For pages and server actions: the user, or a redirect to sign in. */
export async function requireUser(): Promise<AppUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** For route handlers: a 401 response when signed out, else null. */
export async function unauthorized(): Promise<Response | null> {
  return (await currentUser()) ? null : Response.json({ error: "Sign in to continue." }, { status: 401 });
}
