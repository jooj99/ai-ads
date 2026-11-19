import { connection } from "next/server";

import { currentUser } from "@/lib/supabase/auth";

import { AccountMenuButton } from "./account-menu-button";

/** The sidebar's account row: who's signed in, and Sign out. */
export async function AccountMenu() {
  await connection(); // per-request: the session cookie, and auth checks that read the clock
  const user = await currentUser();
  if (!user) return null;
  return <AccountMenuButton email={user.email ?? "Signed in"} />;
}
