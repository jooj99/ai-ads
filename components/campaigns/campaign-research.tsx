"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RotateCwIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { updateKitStyleAction } from "@/app/campaigns/actions";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { CampaignTitle } from "@/components/campaigns/campaign-title";
import { DeleteCampaignButton } from "@/components/campaigns/delete-campaign-button";
import { BrandKitView } from "@/components/research/brand-kit-view";
import { StageStepper } from "@/components/research/stage-stepper";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Campaign } from "@/lib/campaigns";
import { campaignTopic, EVENTS, type ProgressPayload } from "@/lib/realtime";
import {
  STEP_LABELS,
  STEP_ORDER,
  type BrandKit,
  type ResearchNotice,
  type ResearchStep,
  type StepStatus,
} from "@/lib/research/types";
import { browserSupabase } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";

const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  pending: CircleIcon,
  running: Loader2Icon,
  done: CheckCircle2Icon,
  warning: AlertTriangleIcon,
  error: XCircleIcon,
};

/** Shown before the first progress broadcast of a run arrives. */
const STARTING: ProgressPayload = {
  seq: 0,
  steps: STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: "pending" })),
  kit: null,
  notice: null,
};

/** Without Realtime (public env vars missing), refresh saved progress this often. */
const POLL_MS = 3_000;

/**
 * Follows a campaign's research run over Supabase Realtime. `live` holds the
 * latest broadcast while a run is going; when the run finishes the page
 * re-reads the saved result (with the full catalog) from the server and
 * drops `live` in the same transition, so nothing flickers.
 */
function useResearchRun(campaignId: string, running: boolean) {
  const router = useRouter();
  const [live, setLive] = useState<ProgressPayload | null>(null);
  const [, startTransition] = useTransition();
  const realtime = useRef(browserSupabase());

  useEffect(() => {
    const client = realtime.current;
    if (!client) return;
    const channel = client
      .channel(campaignTopic(campaignId))
      .on("broadcast", { event: EVENTS.progress }, ({ payload }) => {
        const next = payload as ProgressPayload;
        // Broadcasts can arrive out of order; never step back to an older one.
        setLive((current) => (current && current.seq > next.seq ? current : next));
      })
      .on("broadcast", { event: EVENTS.finished }, () => {
        startTransition(() => {
          router.refresh();
          setLive(null);
        });
      })
      .subscribe((status) => {
        // Catch up on anything saved before the subscription was ready.
        if (status === "SUBSCRIBED") router.refresh();
      });
    return () => {
      void client.removeChannel(channel);
    };
  }, [campaignId, router]);

  // Graceful fallback: no Realtime config means polling the saved progress.
  useEffect(() => {
    if (realtime.current || !running) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, router]);

  return { live, setLive };
}

/**
 * A campaign's research. Runs happen in the background on the server
 * (started by Start Campaign or "Research again"), so leaving the page never
 * stops them; this page shows saved progress and follows the live run.
 */
export function CampaignResearch({
  campaign,
  stale,
  savedKit,
  savedSteps,
  savedNotice,
}: {
  campaign: Campaign;
  /** The saved run says "researching" but has gone quiet for 5+ minutes. */
  stale: boolean;
  savedKit: BrandKit | null;
  savedSteps: ResearchStep[];
  savedNotice: ResearchNotice | null;
}) {
  const runningOnServer = campaign.status === "researching" && !stale;
  const { live, setLive } = useResearchRun(campaign.id, runningOnServer);
  const running = live !== null || runningOnServer;

  const [stepsOpen, setStepsOpen] = useState(!savedKit);
  const [startError, setStartError] = useState<string>();
  const [starting, setStarting] = useState(false);

  const steps = live?.steps.length ? live.steps : savedSteps.length ? savedSteps : running ? STARTING.steps : [];
  const researchedKit = (live ? live.kit : savedKit) ?? undefined;
  // The user's removals of colors/fonts, applied on top of the researched kit
  // until the next research run replaces it.
  const [edits, setEdits] = useState<{ colors?: BrandKit["colors"]; fonts?: BrandKit["fonts"] }>({});
  const [editError, setEditError] = useState<string>();
  const kit = researchedKit && !running ? { ...researchedKit, ...edits } : researchedKit;
  const notice = (live ? live.notice : savedNotice) ?? undefined;
  const fatal = notice?.level === "error" && !kit?.name;
  const insights = steps.find((s) => s.id === "insights");
  // Complete only when the analysis itself succeeded; a failed analysis is "partly complete".
  const researchDone = !running && (insights?.status === "done" || insights?.status === "warning");

  function saveStyle(change: { colors?: BrandKit["colors"]; fonts?: BrandKit["fonts"] }) {
    const previous = edits;
    setEdits((current) => ({ ...current, ...change }));
    setEditError(undefined);
    void updateKitStyleAction(campaign.id, change).then((result) => {
      if (!result.ok) {
        setEdits(previous);
        setEditError(result.error);
      }
    });
  }

  async function research() {
    if (running || starting) return;
    setStarting(true);
    setStartError(undefined);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/research`, { method: "POST" });
      if (res.status === 409) {
        setStartError("Research is already running for this campaign.");
      } else if (!res.ok) {
        setStartError("Couldn't start research. Try again in a moment.");
      } else {
        setEdits({});
        setStepsOpen(true);
        setLive(STARTING); // until the first broadcast arrives
      }
    } catch {
      setStartError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <CampaignTitle
            campaignId={campaign.id}
            // Research renames a campaign that still has its default name.
            name={campaign.name === campaign.domain && kit?.name ? kit.name : campaign.name}
          />
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
        <div className="flex items-center gap-1">
          <DeleteCampaignButton campaignId={campaign.id} name={campaign.name} goToList />
          <Button variant="outline" onClick={research} disabled={running || starting}>
            {running || starting ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
            {running ? "Researching…" : kit ? "Research again" : "Start research"}
          </Button>
        </div>
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

        {running && (
          <p className="-mt-2 text-sm text-muted-foreground">
            Research runs in the background. You can leave this page; it keeps going and updates
            live.
          </p>
        )}

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

        {stale && !live && (
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>Research stopped before it finished</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>The last run went quiet for over 5 minutes and was most likely interrupted.</p>
              <Button size="sm" variant="outline" onClick={research} disabled={starting}>
                Restart research
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {notice && !running && (
          <Alert variant={notice.level === "error" ? "destructive" : "default"}>
            {notice.level === "error" ? <XCircleIcon /> : <AlertTriangleIcon />}
            <AlertTitle>
              {notice.level === "error" ? "Research couldn't finish" : "Partly complete"}
            </AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>{notice.message}</p>
              <Button size="sm" variant="outline" onClick={research} disabled={starting}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {startError && (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertTitle>{startError}</AlertTitle>
          </Alert>
        )}

        {!kit && !running && !notice && !stale && (
          <Card>
            <CardContent className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                Research hasn&apos;t run for this campaign yet.
              </p>
              <Button onClick={research} disabled={starting}>
                Start research
              </Button>
            </CardContent>
          </Card>
        )}

        {editError && (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertTitle>{editError}</AlertTitle>
          </Alert>
        )}

        {kit && !fatal && (
          <BrandKitView
            kit={kit}
            pending={running}
            onRemoveColor={(hex) => saveStyle({ colors: kit.colors.filter((c) => c.hex !== hex) })}
            onRemoveFont={(family) =>
              saveStyle({ fonts: kit.fonts.filter((f) => f.family !== family) })
            }
          />
        )}
      </section>
    </div>
  );
}
