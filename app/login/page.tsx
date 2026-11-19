import type { Metadata } from "next";
import { Suspense } from "react";

import { SignInForm } from "@/components/sign-in-form";
import { PloyAdsLogo } from "@/components/ploy-logo";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 bg-muted p-6">
      <PloyAdsLogo />
      {/* The form reads ?next= (request-time), so it renders inside Suspense. */}
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
