// Creates (or resets the password of) the app's single demo user in Supabase
// Auth, already confirmed so it can sign in at once. Run with:
//   npm run demo-user
// Reads SUPABASE_URL + SUPABASE_SECRET_KEY (admin API) and DEMO_USER_EMAIL +
// DEMO_USER_PASSWORD from .env.local / .env.development.local. Never prints
// the password.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.DEMO_USER_EMAIL;
const password = process.env.DEMO_USER_PASSWORD;

const missing = Object.entries({ SUPABASE_URL: url, SUPABASE_SECRET_KEY: key, DEMO_USER_EMAIL: email, DEMO_USER_PASSWORD: password })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;

const { data: list, error: listError } = await admin.listUsers({ perPage: 1000 });
if (listError) throw listError;
const existing = list.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());

if (existing) {
  const { error } = await admin.updateUserById(existing.id, { password, email_confirm: true });
  if (error) throw error;
  console.log(`Updated the demo user ${email} (password reset to DEMO_USER_PASSWORD).`);
} else {
  const { error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  console.log(`Created the demo user ${email}.`);
}
console.log(`Auth users in this project: ${list.users.length + (existing ? 0 : 1)}`);
