"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { lastAssistantMessageIsCompleteWithToolCalls, type FileUIPart } from "ai";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PenLineIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  addAdCommentAction,
  deleteAdAction,
  deleteAdCommentAction,
  dismissAdIssueAction,
  updateAdCommentAction,
  reviewAdCommentAction,
  listAdsAction,
  listHeadlinesAction,
  removeHeadlineAction,
  saveHeadlineAction,
  updateKitStyleAction,
} from "@/app/campaigns/actions";
import { AdStudio, type NewComment, type PendingAd } from "@/components/campaigns/ad-studio";
import { CampaignChat, type HeadlineControls } from "@/components/campaigns/campaign-chat";
import { CampaignTitle } from "@/components/campaigns/campaign-title";
import { DeleteCampaignDialog } from "@/components/campaigns/delete-campaign-button";
import { WriteOwnForm, type ChoiceSubmission } from "@/components/campaigns/headline-choice";
import { CampaignGone } from "@/components/campaigns/campaign-gone";
import { ChatStart } from "@/components/campaigns/chat-start";
import { BrandKitView, ProductPicks } from "@/components/research/brand-kit-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AdIdea, AgentUIMessage, CampaignCopy } from "@/lib/agent/tools";
import { KIT_TOOL_PARTS, kickoffText, pendingChoice, sameCopy } from "@/lib/agent/ui";
import type { AdComment, Campaign, SavedAd, SavedHeadline } from "@/lib/campaigns";
import { campaignTopic, CHANNEL, EVENTS } from "@/lib/realtime";
import type { BrandKit, CatalogItem } from "@/lib/research/types";
import { browserSupabase, subscribeSignedIn } from "@/lib/supabase/browser";

/** The user's edits to the researched kit: removed colors/fonts, audience tags. */
type KitEdits = Partial<Pick<BrandKit, "colors" | "fonts" | "audience">>;

/** Without Realtime (public env vars missing), re-read a running campaign this often. */
const POLL_MS = 3_000;

/**
 * The campaign's Realtime channel:
 *
 * - `finished`: a research run finished, so the page re-reads the campaign.
 *   The run's own progress reaches the page through its stream (the chat);
 *   this covers runs the page isn't following (started in another tab), or
 *   polling when Realtime isn't configured.
 * - `ads`: an ad started, finished, failed or went away (`onAds` re-reads
 *   them), so a finished ad shows at once.
 * - `ad_stage`: what an ad being made is doing now (`onAdStage`).
 * - `deleted`: the campaign was deleted elsewhere (`onDeleted`).
 *
 * Returns whether Realtime is on.
 */
function useCampaignChannel(
  campaignId: string,
  running: boolean,
  {
    onAds,
    onAdStage,
    onDeleted,
  }: { onAds: () => void; onAdStage: (id: string, stage: string) => void; onDeleted: () => void },
): boolean {
  const router = useRouter();
  const realtime = useRef(browserSupabase());
  const ads = useEffectEvent(onAds);
  const stage = useEffectEvent(onAdStage);
  const deleted = useEffectEvent(onDeleted);

  useEffect(() => {
    const client = realtime.current;
    if (!client) return;
    const channel = client
      .channel(campaignTopic(campaignId), CHANNEL)
      .on("broadcast", { event: EVENTS.finished }, () => router.refresh())
      .on("broadcast", { event: EVENTS.ads }, () => ads())
      .on("broadcast", { event: EVENTS.deleted }, () => deleted())
      .on("broadcast", { event: EVENTS.adStage }, ({ payload }) => {
        const { id, stage: text } = (payload ?? {}) as { id?: string; stage?: string };
        if (id && text) stage(id, text);
      });
    // Next keeps this page alive (unsubscribed) while you're elsewhere, so
    // it missed whatever finished meanwhile: re-read on every (re)subscribe.
    return subscribeSignedIn(client, channel, (state) => {
      if (state === "SUBSCRIBED") ads();
    });
  }, [campaignId, router]);

  useEffect(() => {
    if (realtime.current || !running) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, router]);

  // eslint-disable-next-line react-hooks/refs -- set once on mount, never changes
  return Boolean(realtime.current);
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
  savedAds,
}: {
  campaign: Campaign;
  /** The saved run says "researching" but has gone quiet for 5+ minutes. */
  stale: boolean;
  savedKit: BrandKit | null;
  savedMessages: AgentUIMessage[];
  savedHeadlines: SavedHeadline[];
  savedAds: SavedAd[];
}) {
  const router = useRouter();

  // ---- Research (a durable agent run, followed in the chat) ----
  const running = campaign.status === "researching" && !stale;
  const realtimeOn = useCampaignChannel(campaign.id, running, {
    onAds: () => void syncAds(),
    onAdStage: (id, stage) => setAds((list) => list.map((a) => (a.id === id && a.status === "generating" ? { ...a, stage } : a))),
    onDeleted: () => setGone(true),
  });
  // Deleted while open (another tab): the page says so instead of failing on every action.
  const [gone, setGone] = useState(false);
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
        const { opening, runId: started } = (await res.json()) as { opening?: AgentUIMessage; runId?: string };
        setEdits({});
        const next = !opening || messages.some((m) => m.id === opening.id) ? messages : [...messages, opening];
        setMessages(next);
        if (started) {
          runBase.current.set(started, next);
          runId.current = started;
          replayTarget.current = started;
        }
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
  // Card answers already sent to the agent (by tool call id): each is sent once.
  const autoSent = useRef(new Set<string>());
  // The chat as it was before each run's reply (the messages it was sent, or
  // what was showing when we started following it). A replay restores this
  // first, so it replaces the reply instead of adding a second copy.
  const runBase = useRef(new Map<string, AgentUIMessage[]>());
  // Runs whose stream reached its end here: nothing left to follow.
  const endedRuns = useRef(new Set<string>());
  // The run a replay follows; null means "the campaign's active run".
  const replayTarget = useRef<string | null>(null);
  const chatApi = `/api/campaigns/${campaign.id}/chat`;
  // The transport's callbacks read and set these refs when a request runs,
  // never during render; the compiler can't tell (react-hooks/refs).
  const [transport] = useState(
    // eslint-disable-next-line react-hooks/refs
    () =>
      new WorkflowChatTransport<AgentUIMessage>({
        api: chatApi,
        fetch: quietFetch,
        onChatSendMessage: (response, options) => {
          runId.current = response.headers.get("x-workflow-run-id");
          if (runId.current) runBase.current.set(runId.current, [...options.messages]);
        },
        // A replay (resumeStream) asks for the chat id, i.e. "the active run":
        // name the exact run instead. Reconnects after a send already do.
        prepareReconnectToStreamRequest: ({ api }) => ({
          api:
            replayTarget.current && api === `${chatApi}/${encodeURIComponent(campaign.id)}/stream`
              ? `${chatApi}/${encodeURIComponent(replayTarget.current)}/stream`
              : api,
        }),
        onChatEnd: () => {
          if (runId.current) {
            endedRuns.current.add(runId.current);
            runBase.current.delete(runId.current);
          }
          runId.current = null;
        },
      }),
  );
  const activeRun = Boolean(campaign.agentRunId && !campaign.agentRunId.startsWith("starting-"));
  const chat = useChat<AgentUIMessage>({
    id: campaign.id,
    messages: savedMessages,
    transport,
    // When the user answers a card (a tool output), send it to the agent, once.
    // The same answer stays "complete" after the turn it started, so if that
    // turn failed (the AI service down, say) this would resend it forever.
    sendAutomaticallyWhen: ({ messages: all }) => {
      if (!lastAssistantMessageIsCompleteWithToolCalls({ messages: all })) return false;
      const last = all.at(-1);
      const answer = last?.parts.findLast((p) => "toolCallId" in p && "state" in p && p.state === "output-available");
      const key = answer && "toolCallId" in answer ? answer.toolCallId : last?.id;
      if (!key || autoSent.current.has(key)) return false;
      autoSent.current.add(key);
      return true;
    },
    // The agent can change headlines and the brand kit in chat; pick those
    // changes up when its reply finishes.
    onFinish: ({ message }) => {
      void syncHeadlines();
      if (message.parts.some((p) => p.type === "tool-generateAd" || p.type === "tool-editAd" || p.type === "tool-deleteAd")) {
        void syncAds();
      }
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

  // Follow a run that isn't streaming here: one already going when the page
  // loads (research from Start Campaign, a turn from before a reload), or the
  // one this page was following when you navigated away. With Cache
  // Components, Next keeps this page's state while you're elsewhere but runs
  // its effect clean-ups, and useChat's clean-up stops the stream; coming back
  // runs the effects again. A resume replays the whole run as a new message,
  // so the chat goes back to how it was before the run first (runBase) and
  // the replay takes the reply's place. (useChat's own `resume` option would
  // add the replay next to the copy already showing: every tool call twice.)
  // It runs again when the status settles: on coming back, the page first
  // renders the status from before it was hidden ("streaming"), then "ready".
  const loadedRun = activeRun ? campaign.agentRunId : null;
  const followRun = useEffectEvent(() => {
    const run = runId.current ?? loadedRun;
    if (!run || endedRuns.current.has(run) || status !== "ready") return;
    const base = runBase.current.get(run);
    if (base) setMessages(base);
    else runBase.current.set(run, [...messages]);
    // Refs, changed in this effect only: the compiler thinks they're frozen
    // because the transport captured them (react-hooks/immutability).
    // eslint-disable-next-line react-hooks/immutability
    runId.current = run;
    // eslint-disable-next-line react-hooks/immutability
    replayTarget.current = run;
    void resumeStream();
  });
  useEffect(() => {
    followRun();
  }, [loadedRun, status]);

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
    const run = runId.current;
    // Stopped on purpose: mark it ended first, so the follow effect (which
    // runs as soon as the status settles) doesn't re-attach to the run while
    // it's still being cancelled, and doesn't replay it when the page is
    // shown again.
    if (run) {
      endedRuns.current.add(run);
      runBase.current.delete(run);
    }
    // The reply stops here at once; the run is cancelled on the server alongside.
    await Promise.all([
      fetch(`${chatApi}/${run ?? campaign.id}`, { method: "DELETE" }).catch(() => undefined),
      stop(),
    ]);
    // eslint-disable-next-line react-hooks/immutability -- a ref, changed in this handler
    if (run && runId.current === run) runId.current = null;
    // The stop cancelled any ads that run was making; drop their placeholders.
    void syncAds();
  }

  // ---- Saved headlines (any number, from any card, or written by the user) ----
  const [headlines, setHeadlines] = useState(savedHeadlines);
  const [headlineError, setHeadlineError] = useState<string>();

  async function syncHeadlines() {
    const fresh = await listHeadlinesAction(campaign.id);
    if (fresh) setHeadlines(fresh);
  }

  // ---- Generated ads (made by the agent's generateAd tool, edited by editAd) ----
  const [ads, setAds] = useState(savedAds);
  const [adError, setAdError] = useState<string>();

  async function syncAds() {
    const fresh = await listAdsAction(campaign.id);
    if (fresh) setAds(fresh);
  }

  // While ads are being made, re-read them every 30s (every 5s without
  // Realtime, which otherwise tells the page when one finishes): the server
  // marks ads that can't finish any more (their run died, or 10+ minutes) as
  // failed, so a dead one turns into a failed ad with Try again instead of
  // loading forever.
  const generating = ads.some((a) => a.status === "generating");
  const pollAds = useEffectEvent(() => void syncAds());
  useEffect(() => {
    if (!generating) return;
    if (!realtimeOn) pollAds(); // coming back to the page: catch up at once
    const timer = setInterval(pollAds, realtimeOn ? 30_000 : 5_000);
    return () => clearInterval(timer);
  }, [generating, realtimeOn]);

  /**
   * Try again on a failed ad. A new ad goes back to the agent, which remakes
   * it with the same idea, copy and products (`generateAd`'s `retryOf`), in
   * its place and with its number. A failed edit is removed, then the edit is
   * asked for again: the comments it was applying are still open on the
   * version it edited, otherwise its instruction is sent again.
   */
  function retryAd(ad: SavedAd) {
    if (!ad.parentId) {
      void send(`Try Ad ${ad.number} “${ad.headline}” again (ad ${ad.id}).`);
      return;
    }
    const base = ads.find((a) => a.id === ad.parentId);
    deleteAd(ad, "version");
    const open = base?.comments.filter((c) => c.status === "open").length ?? 0;
    if (base && open) {
      void send(`Apply my ${open === 1 ? "comment" : `${open} comments`} to Ad ${base.number} “${base.headline}” (ad ${base.id}).`);
    } else {
      void send(`Make that edit to Ad ${ad.number} again (ad ${ad.parentId}): ${ad.instruction ?? "the same change as before"}`);
    }
  }

  /**
   * Deletes one version, or the whole ad (every version sharing its number):
   * gone from the page at once (the studio has already animated it out), and
   * deleted on the server in the background. If that fails, it comes back
   * with an error.
   */
  function deleteAd(ad: SavedAd, scope: "version" | "ad") {
    setAdError(undefined);
    setAds((list) => list.filter((a) => (scope === "ad" ? a.number !== ad.number : a.id !== ad.id)));
    void deleteAdAction(campaign.id, ad.id, scope).then((result) => {
      if (!result.ok) {
        setAdError(result.error);
        void syncAds();
      }
    });
  }

  /** Pins a comment on an ad; it shows once saved. */
  async function addComment(ad: SavedAd, comment: NewComment) {
    setAdError(undefined);
    const result = await addAdCommentAction(campaign.id, ad.id, comment);
    if (!result.ok) {
      setAdError(result.error);
      return false;
    }
    setAds((list) => list.map((a) => (a.id === ad.id ? { ...a, comments: [...a.comments, result.comment] } : a)));
    return true;
  }

  async function deleteComment(ad: SavedAd, comment: AdComment) {
    setAdError(undefined);
    setAds((list) =>
      list.map((a) => (a.id === ad.id ? { ...a, comments: a.comments.filter((c) => c.id !== comment.id) } : a)),
    );
    // Deleted in the background; if that fails, the comment comes back.
    void deleteAdCommentAction(campaign.id, comment.id).then((result) => {
      if (!result.ok) {
        setAdError(result.error);
        void syncAds();
      }
    });
  }

  /**
   * Dismisses one warning on an ad version (a remaining problem, or the
   * not-checked note as "unchecked"): it goes at once, is saved in the
   * background, and comes back if that fails.
   */
  function dismissIssue(ad: SavedAd, issue: string) {
    setAdError(undefined);
    setAds((list) =>
      list.map((a) =>
        a.id !== ad.id
          ? a
          : issue === "unchecked"
            ? { ...a, unchecked: null }
            : { ...a, issues: a.issues.filter((i) => i !== issue) },
      ),
    );
    void dismissAdIssueAction(campaign.id, ad.id, issue).then((result) => {
      if (!result.ok) {
        setAdError(result.error);
        void syncAds();
      }
    });
  }

  /** Rewrites an open comment: shown at once, saved, and restored if the save fails. */
  async function editComment(ad: SavedAd, comment: AdComment, body: string) {
    setAdError(undefined);
    const swap = (text: string) =>
      setAds((list) =>
        list.map((a) =>
          a.id === ad.id
            ? { ...a, comments: a.comments.map((c) => (c.id === comment.id ? { ...c, body: text } : c)) }
            : a,
        ),
      );
    swap(body);
    const result = await updateAdCommentAction(campaign.id, comment.id, body);
    if (!result.ok) {
      swap(comment.body);
      setAdError(result.error);
    }
    return result.ok;
  }

  /**
   * "Was it resolved?" Yes: the comment leaves the page at once (its pin has
   * already shrunk away) and is deleted in the background; if that fails, it
   * comes back with an error. No: it's re-opened on the ad's newest version.
   */
  async function reviewComment(comment: AdComment, resolved: boolean) {
    setAdError(undefined);
    if (resolved) {
      setAds((list) =>
        list.map((a) => ({
          ...a,
          comments: a.comments.filter((c) => c.id !== comment.id),
          appliedComments: a.appliedComments.filter((c) => c.id !== comment.id),
        })),
      );
      void reviewAdCommentAction(campaign.id, comment.id, true).then((result) => {
        if (!result.ok) {
          setAdError(result.error);
          void syncAds();
        }
      });
      return;
    }
    const result = await reviewAdCommentAction(campaign.id, comment.id, false);
    if (!result.ok) setAdError(result.error);
    await syncAds();
  }

  // Ads the agent is making or editing in the reply streaming now, and
  // re-reading the list each time one finishes, so the tab fills in live.
  const adParts = (messages.at(-1)?.role === "assistant" ? messages.at(-1)!.parts : []).filter(
    (p) => p.type === "tool-generateAd" || p.type === "tool-editAd" || p.type === "tool-deleteAd",
  );
  const replying = status === "streaming" || status === "submitted";
  const pendingAds: PendingAd[] = replying
    ? adParts.flatMap((p) =>
        p.type === "tool-generateAd" && p.state === "input-available"
          ? [{ key: p.toolCallId, headline: p.input.headline, cta: p.input.cta }]
          : [],
      )
    : [];
  const editingAds = replying
    ? adParts.flatMap((p) => (p.type === "tool-editAd" && p.state === "input-available" ? [p.input.adId] : []))
    : [];
  const adsDone = adParts.filter((p) => p.state === "output-available").length;

  // The ads are the workspace's main view: open on them once there are any,
  // and switch to them when the agent starts making or editing one.
  const [tab, setTab] = useState(savedAds.length ? "ads" : "brand");
  const adsStarted = pendingAds.length + editingAds.length;
  const [seenStarted, setSeenStarted] = useState(adsStarted);
  if (adsStarted !== seenStarted) {
    setSeenStarted(adsStarted);
    if (adsStarted > seenStarted) setTab("ads");
  }
  useEffect(() => {
    if (adsDone) void syncAds();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read only when another ad finishes
  }, [adsDone]);

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

  // ---- Picking products (the agent's chooseProducts question) ----
  // The Products tab turns into a picker while the agent waits on one; it
  // opens by itself once per question, and again from the chat's button.
  const [picking, setPicking] = useState<{ toolCallId: string; question: string; selected: string[] }>();
  const pending = pendingChoice(messages);
  const askedProducts = pending?.type === "tool-chooseProducts" && pending.state === "input-available" ? pending : null;
  // A new question opens the picker; an answered one (here or in the chat) closes it.
  const askedId = askedProducts?.toolCallId;
  const [seenAsk, setSeenAsk] = useState<string | undefined>(undefined);
  if (askedId !== seenAsk) {
    setSeenAsk(askedId);
    setPicking(askedProducts ? { toolCallId: askedProducts.toolCallId, question: askedProducts.input.question, selected: [] } : undefined);
    if (askedProducts) setTab("products");
  }

  function pickProducts(toolCallId: string) {
    if (askedProducts?.toolCallId === toolCallId) {
      setPicking((p) => p ?? { toolCallId, question: askedProducts.input.question, selected: [] });
    }
    setTab("products");
  }

  function submitProducts() {
    if (!picking) return;
    const catalog = kit?.catalog ?? [];
    const titles = picking.selected.map((id) => catalog.find((p) => p.id === id)?.title ?? id);
    void addToolOutput({
      tool: "chooseProducts",
      toolCallId: picking.toolCallId,
      output: { productIds: picking.selected, titles, chosenBy: "user" },
    });
    setPicking(undefined);
  }

  /**
   * "Let Ploy choose": up to 5 of research's hero picks that have a photo,
   * one per type in the grouping's order before a second from any type, so
   * the ideas cover the range.
   */
  function letPloyChoose(toolCallId: string) {
    const heroes = (kit?.products ?? []).filter((p) => p.images.length);
    const order = kit?.productTypes.map((t) => t.name) ?? [];
    const groups = new Map<string, typeof heroes>();
    for (const p of heroes) groups.set(p.typeName ?? "", [...(groups.get(p.typeName ?? "") ?? []), p]);
    const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
    const lists = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([, list]) => list);
    const chosen: typeof heroes = [];
    for (let i = 0; chosen.length < 5 && lists.some((l) => l[i]); i++) {
      for (const list of lists) if (list[i] && chosen.length < 5) chosen.push(list[i]);
    }
    void addToolOutput({
      tool: "chooseProducts",
      toolCallId,
      output: { productIds: chosen.map((p) => p.id), titles: chosen.map((p) => p.title), chosenBy: "ploy" },
    });
    setPicking(undefined);
  }

  /** "Type a product or send a link": closes the picker and puts the cursor in the chat. */
  const [chatFocus, setChatFocus] = useState(0);
  function typeProducts() {
    setPicking(undefined);
    setChatFocus((n) => n + 1);
  }

  /**
   * Generating from an idea card: save each picked idea's headline + CTA
   * (the headlines list), then tell the agent. If it's waiting on this card
   * the picks are the tool's output and it resumes; for an older card they
   * go as a message (interrupting a reply in progress, like any message).
   */
  async function generateIdeas(toolCallId: string, live: boolean, picked: AdIdea[]) {
    setHeadlineError(undefined);
    const results = await Promise.all(
      picked.map((i) => saveHeadlineAction(campaign.id, { headline: i.headline, cta: i.cta, source: "agent", proposalId: toolCallId })),
    );
    await syncHeadlines();
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) {
      setHeadlineError(failed.error);
      return false;
    }
    if (live) {
      void addToolOutput({ tool: "proposeIdeas", toolCallId, output: { picked } });
    } else {
      await send(`Make these ideas from an earlier set: ${picked.map((i) => `"${i.title}" ("${i.headline}")`).join(", ")}.`);
    }
    return true;
  }

  const headlineControls: HeadlineControls = {
    saved: headlines,
    onSubmit: submitChoice,
    products: kit?.catalog ?? [],
    onGenerate: generateIdeas,
    onPickProducts: pickProducts,
    onLetPloyChoose: letPloyChoose,
    onTypeProducts: typeProducts,
  };

  /** Sending while the agent is working (a reply, or research) interrupts it first. */
  async function send(text: string, files?: FileUIPart[]) {
    if (status === "submitted" || status === "streaming") await interrupt();
    void sendMessage(files?.length ? { text, files } : { text });
  }

  const waiting = pendingChoice(messages);

  // The chat is always open: during research, a message interrupts the run
  // and the agent carries on from what it has.
  const inputDisabledReason = undefined;

  const [deleteOpen, setDeleteOpen] = useState(false);
  const name = campaign.name === campaign.domain && kit?.name ? kit.name : campaign.name;

  if (gone) return <CampaignGone deleted />;

  return (
    // The tabs' root wraps the page so their buttons can sit in the header
    // while their content fills the panel on the right.
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-0 md:h-[calc(100svh-4.5rem)]">
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
        {waiting && <Badge className="bg-brand-yellow text-foreground">Waiting on you</Badge>}
        <TabsList className="h-8 rounded-full bg-transparent p-0">
          {[
            ["brand", "Brand kit"],
            ["products", kit?.offering === "services" ? "Services" : "Products"],
            ["ads", "Ads"],
          ].map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-8 rounded-full px-3.5 data-active:bg-foreground data-active:text-background data-active:shadow-none data-active:hover:text-background"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Campaign actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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

      {/* Wide screens: the panel (ads, brand kit, products) on the left, the
          chat on the right. Phones stack them, chat first. */}
      <div className="grid min-h-0 flex-1 md:grid-cols-[1fr_minmax(20rem,26rem)] md:grid-rows-[minmax(0,1fr)]">
        <section
          aria-label="Chat with the ad agent"
          className="flex h-[75svh] min-h-0 flex-col border-b md:order-2 md:h-auto md:border-b-0 md:border-l"
        >
          <CampaignChat
            messages={messages}
            ads={ads}
            focusRequest={chatFocus}
            status={status}
            error={error}
            inputDisabledReason={inputDisabledReason}
            campaignId={campaign.id}
            onSend={(text, files) => void send(text, files)}
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

        <section aria-label="Campaign" className="min-h-0 overflow-y-auto bg-muted/60 md:order-1">
          <div className="@container flex flex-col gap-4 p-4 md:p-6">
            {(startError || editError) && (
              <p className="rounded-xl border border-destructive/40 bg-background p-3 text-sm">
                {startError ?? editError}
              </p>
            )}

            <TabsContent value="brand" className="flex flex-col gap-4">
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
              {(researchDone || headlines.length > 0) && (
                <HeadlinesCard
                  headlines={headlines}
                  error={headlineError}
                  waiting={Boolean(waiting)}
                  researchDone={researchDone}
                  onRemove={(h) => void changeHeadline(h, false)}
                  onWrite={(copy) => changeHeadline({ ...copy, source: "user", proposalId: null }, true)}
                />
              )}
            </TabsContent>
            <TabsContent value="products">
              {kit && hasKit ? (
                <ProductPicks
                  kit={kit}
                  pending={running}
                  select={
                    picking && {
                      selected: picking.selected,
                      onToggle: (id) =>
                        setPicking((p) =>
                          p && { ...p, selected: p.selected.includes(id) ? p.selected.filter((x) => x !== id) : [...p.selected, id] },
                        ),
                      onSubmit: submitProducts,
                    }
                  }
                />
              ) : (
                <PanelPlaceholder running={running} />
              )}
            </TabsContent>
            <TabsContent value="ads">
              <AdsPanel
                ads={ads}
                pendingAds={pendingAds}
                editingAds={editingAds}
                brand={name}
                products={kit?.catalog ?? []}
                adError={adError}
                onDeleteAd={deleteAd}
                onAddComment={addComment}
                onDeleteComment={(ad, c) => void deleteComment(ad, c)}
                onDismissIssue={dismissIssue}
                onStart={researchDone ? () => void send(kickoffText(campaign.domain)) : undefined}
                onEditComment={editComment}
                onReview={reviewComment}
                onApply={(ad, count) =>
                  void send(
                    `Apply my ${count === 1 ? "comment" : `${count} comments`} to Ad ${ad.number} “${ad.headline}” (ad ${ad.id}).`,
                  )
                }
                onRetry={retryAd}
              />
            </TabsContent>
          </div>
        </section>
      </div>
    </Tabs>
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
 * fetch for the chat transport. Leaving the page (or interrupting) aborts the
 * stream on purpose, while the run carries on on the server; a plain fetch
 * then errors mid-read and the transport logs "BodyStreamBuffer was
 * aborted". Here an aborted read just ends the stream instead.
 */
async function quietFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const signal = init?.signal;
  if (!response.body || !signal) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (signal.aborted) controller.close();
        else controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The Ads tab: the ad studio (ads, versions, pinned comments). */
function AdsPanel({
  ads,
  pendingAds,
  editingAds,
  brand,
  products,
  adError,
  onDeleteAd,
  onAddComment,
  onDeleteComment,
  onDismissIssue,
  onStart,
  onEditComment,
  onApply,
  onReview,
  onRetry,
}: {
  ads: SavedAd[];
  pendingAds: PendingAd[];
  editingAds: string[];
  brand: string;
  products: CatalogItem[];
  adError?: string;
  onDeleteAd: (ad: SavedAd, scope: "version" | "ad") => void;
  onAddComment: (ad: SavedAd, comment: NewComment) => Promise<boolean>;
  onDeleteComment: (ad: SavedAd, comment: AdComment) => void;
  onDismissIssue: (ad: SavedAd, issue: string) => void;
  onStart?: () => void;
  onEditComment: (ad: SavedAd, comment: AdComment, body: string) => Promise<boolean>;
  onApply: (ad: SavedAd, count: number) => void;
  onReview: (comment: AdComment, resolved: boolean) => Promise<void>;
  onRetry: (ad: SavedAd) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {adError && <p className="text-sm text-destructive">{adError}</p>}
      <AdStudio
        ads={ads}
        pending={pendingAds}
        editing={editingAds}
        brand={brand}
        products={products}
        onDelete={onDeleteAd}
        onAddComment={onAddComment}
        onDeleteComment={onDeleteComment}
        onDismissIssue={onDismissIssue}
        onStart={onStart}
        onEditComment={onEditComment}
        onApply={onApply}
        onReview={onReview}
        onRetry={onRetry}
      />
    </div>
  );
}

/**
 * The saved headlines (each becomes an ad), in the Brand kit tab, with
 * remove and write-your-own. Picks from the chat's cards land here too.
 */
function HeadlinesCard({
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
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>
          Headlines{headlines.length > 0 && <span className="font-normal text-muted-foreground"> · {headlines.length}</span>}
        </CardTitle>
        {researchDone && !writing && (
          <Button size="sm" variant="ghost" className="-my-1 text-muted-foreground" onClick={() => setWriting(true)}>
            <PenLineIcon />
            Write your own
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
              ? "Pick the ideas you like on the card in the chat: their headlines are saved here."
              : researchDone
                ? "The headlines of the ideas you pick are saved here. Ask the agent for ad ideas in the chat, or write your own."
                : "Once research finishes, the agent pitches ad ideas in the chat; the headlines you pick are saved here."}
          </p>
        )}
        {writing && <WriteOwnForm onSubmit={onWrite} onCancel={() => setWriting(false)} />}
      </CardContent>
    </Card>
  );
}
