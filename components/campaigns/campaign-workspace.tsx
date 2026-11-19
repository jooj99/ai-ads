"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  ImageIcon,
  MoreHorizontalIcon,
  PenLineIcon,
  RotateCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  listHeadlinesAction,
  removeHeadlineAction,
  saveHeadlineAction,
  updateKitStyleAction,
} from "@/app/campaigns/actions";
import { CampaignChat, type HeadlineControls } from "@/components/campaigns/campaign-chat";
import { CampaignStages, type Stage } from "@/components/campaigns/campaign-stages";
import { CampaignTitle } from "@/components/campaigns/campaign-title";
import { DeleteCampaignDialog } from "@/components/campaigns/delete-campaign-button";
import { WriteOwnForm, type ChoiceSubmission } from "@/components/campaigns/headline-choice";
import { ChatStart } from "@/components/campaigns/chat-start";
import { BrandKitView, ProductPicks } from "@/components/research/brand-kit-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  KIT_TOOL_PARTS,
  kickoffText,
  pendingChoice,
  sameCopy,
  type AgentUIMessage,
  type CampaignCopy,
} from "@/lib/agent/tools";
import type { Campaign, SavedHeadline } from "@/lib/campaigns";
import { campaignTopic, EVENTS } from "@/lib/realtime";
import type { BrandKit } from "@/lib/research/types";
import { browserSupabase } from "@/lib/supabase/browser";

/** The user's edits to the researched kit: removed colors/fonts, audience tags. */
type KitEdits = Partial<Pick<BrandKit, "colors" | "fonts" | "audience">>;

/** Without Realtime (public env vars missing), re-read a running campaign this often. */
const POLL_MS = 3_000;

/**
 * Re-reads the campaign when a research run finishes. The run's own progress
 * reaches the page through its stream (the chat); this covers runs the page
 * isn't following (started in another tab) via the `finished` broadcast, or
 * polling when Realtime isn't configured.
 */
function useResearchFinished(campaignId: string, running: boolean) {
  const router = useRouter();
  const realtime = useRef(browserSupabase());

  useEffect(() => {
    const client = realtime.current;
    if (!client) return;
    const channel = client
      .channel(campaignTopic(campaignId))
      .on("broadcast", { event: EVENTS.finished }, () => router.refresh())
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [campaignId, router]);

  useEffect(() => {
    if (realtime.current || !running) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, router]);
}

/**
 * A campaign as a chat with the ad agent (left) beside what it has produced
 * (right: brand kit, products, ads). Research runs in the background on the
 * server; when it's done the agent proposes headlines and waits for the
 * user's pick, and feedback typed in chat steers the next set.
 */
export function CampaignWorkspace({
  campaign,
  stale,
  savedKit,
  savedMessages,
  savedHeadlines,
}: {
  campaign: Campaign;
  /** The saved run says "researching" but has gone quiet for 5+ minutes. */
  stale: boolean;
  savedKit: BrandKit | null;
  savedMessages: AgentUIMessage[];
  savedHeadlines: SavedHeadline[];
}) {
  const router = useRouter();

  // ---- Research (a durable agent run, followed in the chat) ----
  const running = campaign.status === "researching" && !stale;
  useResearchFinished(campaign.id, running);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();

  const researchedKit = savedKit ?? undefined;
  // The user's edits (removed colors/fonts, audience tags), applied on top of
  // the researched kit until the next research run replaces it.
  const [edits, setEdits] = useState<KitEdits>({});
  const [editError, setEditError] = useState<string>();
  // After the agent edits the kit, the page re-reads it; the panel edits are
  // already saved by then, so they're dropped in favor of the fresh kit.
  const [reloadKit, setReloadKit] = useState(false);
  const [kitSeen, setKitSeen] = useState(savedKit);
  if (savedKit !== kitSeen) {
    setKitSeen(savedKit);
    if (reloadKit) {
      setReloadKit(false);
      setEdits({});
    }
  }
  // Panel edits show as edited at once (the server records them as it saves).
  const editedNow = [
    edits.colors && "colors",
    edits.fonts && "fonts",
    edits.audience && "audience.segments",
  ].filter((f): f is string => Boolean(f));
  const kit = researchedKit
    ? { ...researchedKit, ...edits, edited: [...new Set([...(researchedKit.edited ?? []), ...editedNow])] }
    : undefined;
  const hasKit = Boolean(kit?.name || kit?.catalog?.length);
  const researchDone = !running && hasKit;

  async function research() {
    if (running || starting) return;
    setStarting(true);
    setStartError(undefined);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/research`, { method: "POST" });
      if (res.status === 409) setStartError("Research is already running for this campaign.");
      else if (!res.ok) setStartError("Couldn't start research. Try again in a moment.");
      else {
        // The agent researches as a durable run: show its opening message and
        // follow the run's stream in the chat.
        const { opening } = (await res.json()) as { opening?: AgentUIMessage };
        setEdits({});
        if (opening) setMessages((current) => (current.some((m) => m.id === opening.id) ? current : [...current, opening]));
        router.refresh();
        void resumeStream();
      }
    } catch {
      setStartError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setStarting(false);
    }
  }

  function saveStyle(change: KitEdits) {
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

  // ---- The agent chat ----
  // Each turn is a durable workflow run; the transport remembers the run it's
  // following (x-workflow-run-id) so an interrupt can cancel it, and
  // reconnects if the stream drops.
  const runId = useRef<string | null>(null);
  const chatApi = `/api/campaigns/${campaign.id}/chat`;
  const [transport] = useState(
    () =>
      new WorkflowChatTransport<AgentUIMessage>({
        api: chatApi,
        onChatSendMessage: (response) => {
          runId.current = response.headers.get("x-workflow-run-id");
        },
        onChatEnd: () => {
          runId.current = null;
        },
      }),
  );
  // A run already going when the page loads (research started by Start
  // Campaign, or a turn from before a reload): replay and follow it.
  const activeRun = Boolean(campaign.agentRunId && !campaign.agentRunId.startsWith("starting-"));
  const chat = useChat<AgentUIMessage>({
    id: campaign.id,
    messages: savedMessages,
    transport,
    resume: activeRun,
    // When the user continues from a choice card (a tool output), send it to the agent.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    // The agent can change headlines and the brand kit in chat; pick those
    // changes up when its reply finishes.
    onFinish: ({ message }) => {
      void syncHeadlines();
      if (message.parts.some((p) => KIT_TOOL_PARTS.has(p.type))) {
        setReloadKit(true);
        router.refresh();
      }
    },
  });
  const {
    messages,
    status,
    sendMessage,
    setMessages,
    resumeStream,
    addToolOutput,
    stop,
    regenerate,
    error,
    clearError,
  } = chat;

  // While a run is going, reload the kit and catalog as its research and kit
  // tools finish (at most every 1.5s), so the panel fills in live.
  const toolResults = messages.at(-1)?.parts.filter(
    (p) => KIT_TOOL_PARTS.has(p.type) && "state" in p && p.state === "output-available",
  ).length;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!toolResults || (status !== "streaming" && status !== "submitted")) return;
    const wait = Math.max(0, 1_500 - (Date.now() - lastRefresh.current));
    const timer = setTimeout(() => {
      lastRefresh.current = Date.now();
      setReloadKit(true);
      router.refresh();
    }, wait);
    return () => clearTimeout(timer);
  }, [toolResults, status, router]);

  /** Stops the run on the server (its reply so far is saved), then the stream here. */
  async function interrupt() {
    await fetch(`${chatApi}/${runId.current ?? campaign.id}`, { method: "DELETE" }).catch(() => undefined);
    await stop();
  }

  // ---- Saved headlines (any number, from any card, or written by the user) ----
  const [headlines, setHeadlines] = useState(savedHeadlines);
  const [headlineError, setHeadlineError] = useState<string>();

  async function syncHeadlines() {
    const fresh = await listHeadlinesAction(campaign.id);
    if (fresh) setHeadlines(fresh);
  }

  /** Saves or removes a headline, showing the change at once and undoing it if the save fails. */
  async function changeHeadline(h: SavedHeadline, on: boolean): Promise<boolean> {
    setHeadlineError(undefined);
    setHeadlines((list) => (on ? [...list.filter((x) => !sameCopy(x, h)), h] : list.filter((x) => !sameCopy(x, h))));
    const result = on
      ? await saveHeadlineAction(campaign.id, h)
      : await removeHeadlineAction(campaign.id, h);
    if (!result.ok) {
      setHeadlineError(result.error);
      await syncHeadlines();
    }
    return result.ok;
  }

  /**
   * Submitting a choice card: save what was ticked, drop what was unticked,
   * then tell the agent. If it's waiting on this card, the picks are the
   * tool's output and it resumes; for an older card they go as a message
   * (interrupting a reply in progress, like any message).
   */
  async function submitChoice(toolCallId: string, live: boolean, choice: ChoiceSubmission) {
    setHeadlineError(undefined);
    const results = await Promise.all([
      ...choice.add.map((h) => saveHeadlineAction(campaign.id, { ...h, proposalId: toolCallId })),
      ...choice.remove.map((h) => removeHeadlineAction(campaign.id, h)),
    ]);
    await syncHeadlines();
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) {
      setHeadlineError(failed.error);
      return false;
    }
    if (live) {
      void addToolOutput({
        tool: "proposeHeadlines",
        toolCallId,
        output: { picked: choice.picked, removed: choice.remove.length ? choice.remove : undefined },
      });
    } else {
      const list = (items: CampaignCopy[]) => items.map((h) => `"${h.headline}" (${h.cta})`).join(", ");
      const lines = [
        choice.picked.length ? `Headlines from an earlier set: ${list(choice.picked)}.` : "",
        choice.remove.length ? `Removed: ${list(choice.remove)}.` : "",
      ].filter(Boolean);
      await send(lines.join(" ") || "I cleared my picks from an earlier set.");
    }
    return true;
  }

  const headlineControls: HeadlineControls = { saved: headlines, onSubmit: submitChoice };

  /** Sending while the agent is working (a reply, or research) interrupts it first. */
  async function send(text: string) {
    if (status === "submitted" || status === "streaming") await interrupt();
    void sendMessage({ text });
  }

  const waiting = pendingChoice(messages);
  const stage: Stage = !researchDone ? "Research" : headlines.length ? "Generate" : "Headline";

  // The chat is always open: during research, a message interrupts the run
  // and the agent carries on from what it has.
  const inputDisabledReason = undefined;

  const [deleteOpen, setDeleteOpen] = useState(false);
  const name = campaign.name === campaign.domain && kit?.name ? kit.name : campaign.name;

  return (
    <div className="flex flex-col md:h-[calc(100svh-4.5rem)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5 md:px-4">
        <Button asChild variant="ghost" size="icon-sm" aria-label="All campaigns">
          <Link href="/campaigns">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-x-3 gap-y-1.5 max-sm:flex-col max-sm:items-start">
          <CampaignTitle campaignId={campaign.id} name={name} size="header" />
          <a
            href={campaign.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {campaign.domain}
            <ExternalLinkIcon className="size-3" />
          </a>
        </div>
        <CampaignStages current={stage} className="hidden lg:flex" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Campaign actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void research()} disabled={running || starting}>
              <RotateCwIcon />
              Research again
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2Icon />
              Delete campaign
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DeleteCampaignDialog
          campaignId={campaign.id}
          name={name}
          goToList
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      </header>

      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(20rem,26rem)_1fr] md:grid-rows-[minmax(0,1fr)]">
        <section
          aria-label="Chat with the ad agent"
          className="flex h-[75svh] min-h-0 flex-col border-b md:h-auto md:border-r md:border-b-0"
        >
          <CampaignChat
            messages={messages}
            status={status}
            error={error}
            inputDisabledReason={inputDisabledReason}
            onSend={(text) => void send(text)}
            headlines={headlineControls}
            onStop={() => void interrupt()}
            onRetry={() => {
              clearError();
              void regenerate();
            }}
            intro={
              <ChatStart
                domain={campaign.domain}
                running={running || activeRun}
                stale={stale}
                hasKit={hasKit}
                starting={starting}
                onResearch={() => void research()}
                onStartChat={() => void sendMessage({ text: kickoffText(campaign.domain) })}
              />
            }
          />
        </section>

        <section aria-label="Campaign" className="min-h-0 overflow-y-auto bg-muted/60">
          <Tabs defaultValue="brand" className="@container gap-4 p-4 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList className="h-9 rounded-full bg-transparent p-0">
                {[
                  ["brand", "Brand kit"],
                  ["products", kit?.offering === "services" ? "Services" : "Products"],
                  ["ads", "Ads"],
                ].map(([value, label]) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="h-9 rounded-full px-4 data-active:bg-foreground data-active:text-background data-active:shadow-none data-active:hover:text-background"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {waiting && <Badge className="bg-brand-yellow text-foreground">Waiting on you</Badge>}
            </div>

            {(startError || editError) && (
              <p className="rounded-xl border border-destructive/40 bg-background p-3 text-sm">
                {startError ?? editError}
              </p>
            )}

            <TabsContent value="brand">
              {kit && hasKit ? (
                <BrandKitView
                  kit={kit}
                  pending={running}
                  onRemoveColor={(hex) => saveStyle({ colors: kit.colors.filter((c) => c.hex !== hex) })}
                  onRemoveFont={(family) => saveStyle({ fonts: kit.fonts.filter((f) => f.family !== family) })}
                  onAudienceChange={(segments) => saveStyle({ audience: { ...kit.audience, segments } })}
                />
              ) : (
                <PanelPlaceholder running={running} />
              )}
            </TabsContent>
            <TabsContent value="products">
              {kit && hasKit ? <ProductPicks kit={kit} pending={running} /> : <PanelPlaceholder running={running} />}
            </TabsContent>
            <TabsContent value="ads">
              <AdsPanel
                headlines={headlines}
                error={headlineError}
                waiting={Boolean(waiting)}
                researchDone={researchDone}
                onRemove={(h) => void changeHeadline(h, false)}
                onWrite={(copy) => changeHeadline({ ...copy, source: "user", proposalId: null }, true)}
              />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}

function PanelPlaceholder({ running }: { running: boolean }) {
  if (running) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full rounded-xl bg-background" />
        <div className="grid gap-4 @2xl:grid-cols-3">
          <Skeleton className="h-32 rounded-xl bg-background" />
          <Skeleton className="h-32 rounded-xl bg-background" />
          <Skeleton className="h-32 rounded-xl bg-background" />
        </div>
      </div>
    );
  }
  return (
    <p className="rounded-xl bg-background p-6 text-sm text-muted-foreground">
      Nothing here yet. Research fills this in; you can restart it from the chat.
    </p>
  );
}

/**
 * The Ads tab. Generation isn't built yet, so for now it shows the headlines
 * the user saved (each becomes an ad variant), with remove and write-your-own.
 */
function AdsPanel({
  headlines,
  error,
  waiting,
  researchDone,
  onRemove,
  onWrite,
}: {
  headlines: SavedHeadline[];
  error?: string;
  waiting: boolean;
  researchDone: boolean;
  onRemove: (h: SavedHeadline) => void;
  onWrite: (copy: CampaignCopy) => Promise<boolean>;
}) {
  const [writing, setWriting] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl bg-background p-5 ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">
            Headlines{headlines.length > 0 && <span className="text-muted-foreground"> · {headlines.length}</span>}
          </p>
          {researchDone && !writing && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setWriting(true)}>
              <PenLineIcon />
              Write your own
            </Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {headlines.length > 0 ? (
          <ul className="flex flex-col divide-y">
            {headlines.map((h) => (
              <li key={`${h.headline}-${h.cta}`} className="group flex items-center gap-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-sm font-medium leading-snug">{h.headline}</span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">
                      {h.cta}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {h.source === "user" ? "Written by you" : "From the agent"}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(h)}
                  aria-label={`Remove ${h.headline}`}
                  title="Remove"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {waiting
              ? "Tick the headlines you like in the chat, as many as you want."
              : researchDone
                ? "Ask the agent for headline options in the chat, or write your own."
                : "Once research finishes, the agent suggests headlines in the chat."}
          </p>
        )}
        {writing && <WriteOwnForm onSubmit={onWrite} onCancel={() => setWriting(false)} />}
      </div>
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-foreground/15 px-6 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-background">
          <ImageIcon className="size-5" />
        </span>
        <p className="font-medium">No ads yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Each saved headline becomes a 9:16 ad built on your product photos. Generating is the
          next step being built.
        </p>
      </div>
    </div>
  );
}
