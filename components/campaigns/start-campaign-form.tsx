"use client";

import { AlertCircleIcon, ArrowRightIcon, Link2Icon, Loader2Icon } from "lucide-react";
import { useActionState, useRef } from "react";

import { startCampaign, type StartCampaignState } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const EXAMPLES = ["loopycases.com", "warbyparker.com", "waxcenter.com"];

export function StartCampaignForm() {
  const [state, formAction, pending] = useActionState<StartCampaignState, FormData>(
    startCampaign,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function tryExample(example: string) {
    if (!inputRef.current || pending) return;
    inputRef.current.value = example;
    formRef.current?.requestSubmit();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Start with a store URL</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form ref={formRef} action={formAction} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Link2Icon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              name="url"
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              required
              aria-label="Store URL"
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "start-campaign-error" : undefined}
              placeholder="https://yourstore.com"
              defaultValue={state.url}
              disabled={pending}
              className="h-11 rounded-full pl-10 text-base md:text-sm"
            />
          </div>
          <Button type="submit" size="lg" className="h-11 px-5" disabled={pending}>
            {pending ? (
              <>
                <Loader2Icon className="animate-spin" />
                Starting…
              </>
            ) : (
              <>
                Start Campaign
                <ArrowRightIcon />
              </>
            )}
          </Button>
        </form>

        {state.error ? (
          <p id="start-campaign-error" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            {state.error}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Try</span>
            {EXAMPLES.map((example) => (
              <Button
                key={example}
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => tryExample(example)}
              >
                {example}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
