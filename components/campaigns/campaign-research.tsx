"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RotateCwIcon,
  SquareIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import { Card, CardContent } from "@/components/ui/card";
import type { Campaign } from "@/lib/campaigns";
import {
  STEP_ORDER,
  type BrandKit,
  type ResearchNotice,
  type ResearchStep,
  type ResearchUIMessage,
  type StepStatus,
} from "@/lib/research/types";
import { cn } from "@/lib/utils";

const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  pending: CircleIcon,
  running: Loader2Icon,
  done: CheckCircle2Icon,
  warning: AlertTriangleIcon,
  error: XCircleIcon,
};

/** Reads the live research run out of the streamed UI message. */
function useLiveResearch(messages: ResearchUIMessage[]) {
  return useMemo(() => {
    const message = messages.findLast((m) => m.role === "assistant");
    if (!message) return null;
    const steps = new Map<string, ResearchStep>();
    let kit: BrandKit | undefined;
    let notice: ResearchNotice | undefined;
    for (const part of message.parts) {
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

/**
 * A campaign's research. A new campaign starts researching on arrival; the
 * server saves the result to Supabase when the run finishes, so reloading
 * shows the saved kit instead of researching again.
 */
export function CampaignResearch({
  campaign,
  savedKit,
  savedSteps,
  savedNotice,
}: {
  campaign: Campaign;
  savedKit: BrandKit | null;
  savedSteps: ResearchStep[];
  savedNotice: ResearchNotice | null;
}) {
  const [stepsOpen, setStepsOpen] = useState(!savedKit);
  const { messages, setMessages, sendMessage, status, stop, error } = useChat<ResearchUIMessage>({
    transport: new DefaultChatTransport({
      api: "/api/research",
      body: { campaignId: campaign.id },
    }),
  });
  const live = useLiveResearch(messages);

  const running = status === "submitted" || status === "streaming";
  const steps = live?.steps ?? savedSteps;
  const kit = live ? live.kit : (savedKit ?? undefined);
  const notice = live ? live.notice : (savedNotice ?? undefined);
  const fatal = notice?.level === "error" && !kit?.name;
  const insights = steps.find((s) => s.id === "insights");
  // Complete only when the analysis itself succeeded; a failed analysis is "partly complete".
  const researchDone =
    !running && !error && (insights?.status === "done" || insights?.status === "warning");

  function research() {
    if (running) return;
    setStepsOpen(true);
    setMessages([]);
    void sendMessage({ text: campaign.sourceUrl });
  }

  // A fresh campaign (nothing saved yet) starts researching as soon as it opens.
  // useChat stops its request when it unmounts, and React's dev double-mount
  // unmounts once, so the start is scheduled and cancelled in cleanup: only
  // the mount that stays sends it. Once it's sent, status leaves "ready".
  const idle = status === "ready" && messages.length === 0;
  useEffect(() => {
    if (!idle || savedKit || campaign.status !== "researching") return;
    const start = setTimeout(() => void sendMessage({ text: campaign.sourceUrl }), 0);
    return () => clearTimeout(start);
  }, [idle, campaign.sourceUrl, campaign.status, savedKit, sendMessage]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="truncate font-display text-5xl leading-none uppercase md:text-6xl">
            {kit?.name ?? campaign.name}
          </h1>
          <a
            href={campaign.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            {campaign.domain}
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </div>
        {running ? (
          <Button variant="outline" onClick={() => stop()}>
            <SquareIcon className="size-3.5 fill-current" />
            Stop
          </Button>
        ) : (
          <Button variant="outline" onClick={research}>
            <RotateCwIcon />
            {kit ? "Research again" : "Start research"}
          </Button>
        )}
      </div>

      <StageStepper researchDone={researchDone} />

      <section className="flex flex-col gap-4" aria-live="polite">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">
            {running ? (
              <Shimmer as="span">{`Researching ${campaign.domain}…`}</Shimmer>
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
                  {running
                    ? "Research steps"
                    : `Research steps (${steps.filter((s) => s.status === "done").length}/${STEP_ORDER.length} complete)`}
                </ChainOfThoughtHeader>
                <ChainOfThoughtContent>
                  {steps.map((step) => (
                    <ChainOfThoughtStep
                      key={step.id}
                      icon={STATUS_ICON[step.status]}
                      label={step.label}
                      description={step.detail}
                      status={
                        step.status === "running"
                          ? "active"
                          : step.status === "pending"
                            ? "pending"
                            : "complete"
                      }
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
            <AlertTitle>
              {notice.level === "error" ? "Research couldn't finish" : "Partly complete"}
            </AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>{notice.message}</p>
              {!running && (
                <Button size="sm" variant="outline" onClick={research}>
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
              <Button size="sm" variant="outline" onClick={research}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!kit && !running && !notice && !error && (
          <Card>
            <CardContent className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                Research hasn&apos;t run for this campaign yet.
              </p>
              <Button onClick={research}>Start research</Button>
            </CardContent>
          </Card>
        )}

        {kit && !fatal && <BrandKitView kit={kit} pending={running} />}
      </section>
    </div>
  );
}
