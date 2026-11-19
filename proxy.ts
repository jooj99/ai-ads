import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every page and API request (see `matcher`):
 * 1. refreshes the Supabase Auth session, writing renewed cookies onto both
 *    the request (so this render sees them) and the response;
 * 2. turns signed-out visitors away: pages redirect to /login?next=<path>,
 *    API routes get a 401. /login itself is open, and redirects home when
 *    already signed in.
 *
 * Without the public Supabase env vars nobody can sign in, so everything but
 * /login is closed (fail closed, never open).
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isLogin = pathname === "/login";
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  let signedIn = false;
  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list, headers) {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
          // Responses that set auth cookies must never be cached.
          for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
        },
      },
    });
    // Verifies the JWT; refreshes an expired session via setAll above.
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  }

  if (isLogin) return signedIn ? redirectKeepingCookies(request, response, "/") : response;
  if (signedIn) return response;

  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return redirectKeepingCookies(request, response, login);
}

function redirectKeepingCookies(request: NextRequest, from: NextResponse, to: string | URL) {
  const redirect = NextResponse.redirect(new URL(to, request.url));
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: [
    // Everything except Next's assets, images in /public, and the Workflow
    // runtime's own endpoints (it calls them server-to-server, unsigned-in).
    "/((?!_next/static|_next/image|\\.well-known/workflow|favicon\\.ico|brand/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
