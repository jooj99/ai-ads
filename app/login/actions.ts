"use server";

import { redirect } from "next/navigation";

import { authClient, authEnv } from "@/lib/supabase/auth";

export type SignInState = { error?: string; email?: string };

/** Only same-site paths, so `?next=` can't send anyone off-site. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** Email + password sign-in; the session cookies are set on this response. */
export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password.", email };
  if (!authEnv()) return { error: "Sign-in isn't configured on this deployment.", email };

  const { error } = await (await authClient()).auth.signInWithPassword({ email, password });
  if (error) {
    // Supabase says "Invalid login credentials" for both a wrong email and a
    // wrong password; keep it that way rather than revealing which.
    const message = error.status === 400 ? "That email and password don't match." : "Sign-in failed. Try again in a moment.";
    if (error.status !== 400) console.error("[auth] sign-in failed", error.message);
    return { error: message, email };
  }
  redirect(safeNext(form.get("next")));
}

export async function signOut(): Promise<void> {
  if (authEnv()) await (await authClient()).auth.signOut();
  redirect("/login");
}
