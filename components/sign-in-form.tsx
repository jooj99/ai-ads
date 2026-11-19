"use client";

import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { signIn, type SignInState } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForm() {
  const next = useSearchParams().get("next") ?? "/";
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signIn, {});

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-lg">Sign in</CardTitle>
        <CardDescription>Use the demo account&apos;s email and password.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              defaultValue={state.email}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={pending}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "sign-in-error" : undefined}
            />
          </div>
          {state.error ? (
            <p id="sign-in-error" role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircleIcon className="size-4 shrink-0" />
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
