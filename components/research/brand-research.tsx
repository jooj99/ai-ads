"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleIcon,
  Link2Icon,
  Loader2Icon,
  SquareIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrandKitView } from "@/components/research/brand-kit-view";
import { StageStepper } from "@/components/research/stage-stepper";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  STEP_ORDER,
  type BrandKit,
  type ResearchNotice,
  type ResearchStep,
  type ResearchUIMessage,
  type StepStatus,
} from "@/lib/research/types";
import { cn } from "@/lib/utils";

const EXAMPLES = ["loopycases.com", "allbirds.com", "glossier.com"];

const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  pending: CircleIcon,
  running: Loader2Icon,
  done: CheckCircle2Icon,
  warning: AlertTriangleIcon,
  error: XCircleIcon,
};

/** Reads the latest research run out of the streamed UI message. */
function useResearchState(messages: ResearchUIMessage[]) {
  return useMemo(() => {
    const message = messages.findLast((m) => m.role === "assistant");
    const steps = new Map<string, ResearchStep>();
    let kit: BrandKit | undefined;
    let notice: ResearchNotice | undefined;
    for (const part of message?.parts ?? []) {
      if (part.type === "data-step") steps.set(part.data.id, part.data);
      if (part.type === "data-brandKit") kit = part.data;
      if (part.type === "data-notice") notice = part.data;
    }
    return {
      steps: STEP_ORDER.map((id) => steps.get(id)).filter((s): s is ResearchStep => Boolean(s)),
      kit,
      notice,
    };
  }, [messages]);
}

export function BrandResearch() {
  const [url, setUrl] = useState("");
  const [researchedUrl, setResearchedUrl] = useState<string>();
  const [stepsOpen, setStepsOpen] = useState(true);

  const { messages, setMessages, sendMessage, status, stop, error } = useChat<ResearchUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/research" }),
  });
  const { steps, kit, notice } = useResearchState(messages);

  const running = status === "submitted" || status === "streaming";
  const fatal = notice?.level === "error" && !kit?.name;
  // Complete only when the analysis itself succeeded; a failed analysis is "partly complete".
  const insights = steps.find((s) => s.id === "insights");
  const researchDone =
    !running && !error && (insights?.status === "done" || insights?.status === "warning");
  const detect = steps.find((s) => s.id === "detect");

  function research(target: string) {
    const value = target.trim();
    if (!value || running) return;
    setUrl(value);
    setResearchedUrl(value);
    setStepsOpen(true);
    setMessages([]); // one research run at a time; a new URL starts fresh
    void sendMessage({ text: value });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    research(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1. Start with a store URL</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Link2Icon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                aria-label="Store URL"
                placeholder="https://yourstore.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={running}
                className="h-11 rounded-full pl-10 text-base md:text-sm"
              />
            </div>
            {running ? (
              <Button type="button" size="lg" variant="outline" className="h-11 px-5" onClick={() => stop()}>
                <SquareIcon className="size-3.5 fill-current" />
                Stop
              </Button>
            ) : (
              <Button type="submit" size="lg" className="h-11 px-5" disabled={!url.trim()}>
                Research brand
                <ArrowRightIcon />
              </Button>
            )}
          </form>

          {detect?.status === "done" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2Icon className="size-4 text-foreground" />
              {detect.detail}
            </p>
          ) : !researchedUrl ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Try</span>
              {EXAMPLES.map((example) => (
                <Button
                  key={example}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => research(example)}
                >
                  {example}
                </Button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <StageStepper researchDone={researchDone} />

      {researchedUrl ? (
        <section className="flex flex-col gap-4" aria-live="polite">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">
              2.{" "}
              {running ? (
                <Shimmer as="span">{`Researching ${kit?.domain ?? researchedUrl}…`}</Shimmer>
              ) : researchDone ? (
                "Brand research complete"
              ) : (
                "Brand research"
              )}
            </h2>
            {researchDone && <CheckCircle2Icon className="size-6 shrink-0" aria-label="Complete" />}
          </div>

          {steps.length > 0 && (
            <Card className="py-4">
              <CardContent>
                <ChainOfThought open={stepsOpen || running} onOpenChange={setStepsOpen}>
                  <ChainOfThoughtHeader>
                    {running ? "Research steps" : `Research steps (${steps.filter((s) => s.status === "done").length}/${STEP_ORDER.length} complete)`}
                  </ChainOfThoughtHeader>
                  <ChainOfThoughtContent>
                    {steps.map((step) => (
                      <ChainOfThoughtStep
                        key={step.id}
                        icon={STATUS_ICON[step.status]}
                        label={step.label}
                        description={step.detail}
                        status={step.status === "running" ? "active" : step.status === "pending" ? "pending" : "complete"}
                        className={cn(
                          step.status === "running" && "[&>div:first-child>svg]:animate-spin",
                          step.status === "warning" && "[&>div:first-child>svg]:text-brand-orange",
                          step.status === "error" && "[&>div:first-child>svg]:text-destructive",
                        )}
                      />
                    ))}
                  </ChainOfThoughtContent>
                </ChainOfThought>
              </CardContent>
            </Card>
          )}

          {notice && (
            <Alert variant={notice.level === "error" ? "destructive" : "default"}>
              {notice.level === "error" ? <XCircleIcon /> : <AlertTriangleIcon />}
              <AlertTitle>{notice.level === "error" ? "Research couldn't finish" : "Partly complete"}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <p>{notice.message}</p>
                {!running && (
                  <Button size="sm" variant="outline" onClick={() => research(researchedUrl)}>
                    Try again
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>Connection lost</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <p>The research request failed before it finished.</p>
                <Button size="sm" variant="outline" onClick={() => research(researchedUrl)}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {kit && !fatal && <BrandKitView kit={kit} pending={running} />}
        </section>
      ) : null}
    </div>
  );
}
