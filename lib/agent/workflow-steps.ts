import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { generateId, readUIMessageStream } from "ai";
import { getRun } from "workflow/api";

import { AGENT_MODEL, buildInstructions, serverTools } from "@/lib/agent/server-tools";
import { openResearchThread } from "@/lib/agent/research-thread";
import type { AgentUIMessage } from "@/lib/agent/tools";
import { getCampaign, getCampaignResearch, getChat, saveChat } from "@/lib/campaigns";
import { broadcast } from "@/lib/broadcast";
import { CAMPAIGNS_TOPIC, campaignTopic, EVENTS, type CampaignChange } from "@/lib/realtime";
import { supabase } from "@/lib/supabase/server";
import { signUploads, uploadName } from "@/lib/uploads";
import { logoImage } from "@/lib/ads/brand-assets";
import { inlineIfLocal, isLocalUrl } from "@/lib/reachable";
import { ResearchSession } from "@/lib/research/state";
import { findBrandVisuals } from "@/lib/research/steps";
import { ensureProductNotes, storeContext } from "@/lib/research/product-notes";
import type { AdVerification } from "@/lib/ads/flow";
import {
  checkDraft,
  draftAd,
  finishAd,
  prepareAd,
  repairDraft,
  type AdDraftJob,
  type AdJob,
  type GenerateAdInput,
} from "@/lib/ads/generate";
import { prepareEdit, runEdit, type EditAdInput, type EditJob } from "@/lib/ads/edit";
import { broadcastAdActivity } from "@/lib/ads/activity";
import { failAdRow } from "@/lib/ads/render";
import type { AdIssue } from "@/lib/ads/verify";

/**
 * The durable agent's steps (see workflows/agent.ts). Each function marked
 * "use step" runs as one checkpointed, retried workflow step, so each must be
 * safe to run again: they read and upsert by id. Their arguments and results
 * are plain JSON.
 */

// --- ads and edits, each in its own run ------------------------------------
// The agent prepares an ad or edit inside its turn (a few seconds: checks the
// request, builds the brief, records "Ad N") and starts a separate workflow
// run that makes it (workflows/ads.ts). The turn doesn't wait for the image,
// so the reply comes at once, each ad finishes on its own, and the user can
// keep chatting or edit a finished ad meanwhile. A new ad's run is one step
// per phase (draft, check, each repair edit, finish), so a crash resumes
// where it was.

export async function adPrepare(campaignId: string, agentRunId: string, input: GenerateAdInput, toolCallId: string) {
  "use step";
  return prepareAd(campaignId, input, { toolCallId, runId: agentRunId });
}

export async function adDraft(prepared: AdDraftJob, runId: string) {
  "use step";
  return draftAd(prepared, runId);
}

export async function editPrepare(campaignId: string, agentRunId: string, input: EditAdInput, toolCallId: string) {
  "use step";
  return prepareEdit(campaignId, input, { toolCallId, runId: agentRunId });
}

/**
 * The run that would make a prepared ad or edit couldn't start: its row is
 * marked failed with the reason at once (instead of "Making…" until the
 * 10-minute sweep), and the Campaigns list and the page hear about it.
 */
export async function adStartFailed(campaignId: string, adId: string, reason: string) {
  "use step";
  await failAdRow(adId, reason);
  await broadcastAdActivity(campaignId);
}

export async function editMake(job: EditJob, runId: string) {
  "use step";
  return runEdit(job, runId);
}

export async function adCheck(job: AdJob, path: string) {
  "use step";
  return checkDraft(job, path);
}

export async function adRepair(job: AdJob, path: string, issues: AdIssue[], round: number) {
  "use step";
  return repairDraft(job, path, issues, round);
}

export async function adFinish(job: AdJob, path: string, verification: AdVerification) {
  "use step";
  return finishAd(job, path, verification);
}

/** Live labels for the Campaigns grid while a research run calls each tool. */
const STEP_LABELS: Record<string, string> = {
  detectPlatform: "Reading the store",
  readSite: "Extracting logo, colors and fonts",
  classifyOffering: "Checking goods or services",
  setOffering: "Checking goods or services",
  listSiteLinks: "Choosing pages to read",
  findOfferingPages: "Choosing pages to read",
  loadCatalog: "Loading products",
  writeBrandInsights: "Writing the brand insights",
  groupCatalog: "Grouping the catalog",
  setProductTypes: "Grouping the catalog",
  findPhotos: "Finding photos",
  findBrandVisuals: "Finding brand graphics",
  researchStatus: "Checking research",
  chooseProducts: "Choosing products",
  proposeIdeas: "Writing ad ideas",
};

/** The model and instructions for a run (instructions need the database, so they're built in a step). */
export async function loadAgentSetup(
  campaignId: string,
  mode: "chat" | "research",
  submitted: { headline: string; cta: string }[],
  chosen: string[] = [],
): Promise<{ model: string; instructions: string }> {
  "use step";
  // Products just picked on the card: write their notes (how each works)
  // first, so the ideas the agent writes next stage them correctly.
  if (chosen.length) {
    const kit = (await getCampaignResearch(campaignId))?.kit;
    const picked = (kit?.catalog ?? []).filter((p) => chosen.includes(p.id));
    if (picked.length && kit) await ensureProductNotes(campaignId, picked, storeContext(kit)).catch(() => undefined);
  }
  return { model: AGENT_MODEL, instructions: await buildInstructions(campaignId, mode, submitted) };
}

/** How many of the latest attached images the model sees; older ones are named but not re-sent. */
const MAX_VISIBLE_UPLOADS = 6;

/**
 * Gets a thread ready for the model: images the user attached point at our
 * private route, which the model provider can't fetch, so each becomes a
 * one-hour signed URL, followed by a line naming its reference id (what the
 * agent passes to generateAd / editAd to use it in an ad). Only the latest
 * MAX_VISIBLE_UPLOADS are sent as images; older ones stay as their names.
 * The saved thread keeps our own URLs.
 */
export async function prepareModelMessages(campaignId: string, messages: AgentUIMessage[]): Promise<AgentUIMessage[]> {
  "use step";
  const names = messages.flatMap((m) =>
    m.role === "user" ? m.parts.flatMap((p) => (p.type === "file" ? [uploadName(campaignId, p.url)] : [])) : [],
  );
  const visible = new Set(names.filter((n): n is string => Boolean(n)).slice(-MAX_VISIBLE_UPLOADS));
  const [signed, logo] = await Promise.all([
    signUploads(campaignId, [...visible]).catch((error) => {
      console.error("[agent] signing uploads failed", error);
      return new Map<string, string>();
    }),
    // The agent sees the real logo, so it can judge requests about it.
    // (Local dev: inline, since the model provider can't fetch 127.0.0.1.)
    getCampaignResearch(campaignId)
      .then((r) => logoImage(campaignId, r?.kit?.logo))
      .then(async (l) => (l ? { ...l, url: await inlineIfLocal(l.url) } : null))
      .catch(() => null),
  ]);
  const local = [...signed.entries()].filter(([, url]) => isLocalUrl(url));
  for (const [name, url] of local) signed.set(name, await inlineIfLocal(url).catch(() => url));
  const withLogo = (m: AgentUIMessage, i: number): AgentUIMessage =>
    logo && i === messages.findIndex((x) => x.role === "user")
      ? {
          ...m,
          parts: [
            { type: "file", mediaType: "image/png", url: logo.url, filename: "brand-logo.png" },
            { type: "text", text: "(The brand's real logo, from the brand kit. For reference; the user didn't attach it.)" },
            ...m.parts,
          ],
        }
      : m;
  if (!names.length) return messages.map(withLogo);
  return messages.map(withLogo).map((m) =>
    m.role !== "user"
      ? m
      : {
          ...m,
          parts: m.parts.flatMap((p): AgentUIMessage["parts"] => {
            if (p.type !== "file") return [p];
            const name = uploadName(campaignId, p.url);
            // Not a chat upload: the brand logo added above (the chat route
            // drops any other file part before a run starts).
            if (!name) return p.url.startsWith("https://") || p.url.startsWith("data:") ? [p] : [];
            const url = signed.get(name);
            if (!url || !visible.has(name)) {
              return [{ type: "text" as const, text: `(An earlier image the user attached, ref "${name}", not shown again.)` }];
            }
            return [
              { ...p, url },
              { type: "text" as const, text: `(Image attached by the user, ref "${name}".)` },
            ];
          }),
        },
  );
}

/**
 * Runs one server tool call. During a research run it also refreshes the
 * run's heartbeat (claim_research treats a quiet run as dead after 5 minutes)
 * and tells the Campaigns grid which step is running.
 */
export async function executeServerTool(
  name: string,
  campaignId: string,
  runId: string,
  input: unknown,
  toolCallId?: string,
): Promise<unknown> {
  "use step";
  const campaign = await getCampaign(campaignId);
  if (campaign?.status === "researching" && campaign.agentRunId === runId) {
    const now = new Date().toISOString();
    await supabase()
      .from("campaigns")
      .update({ research_started_at: now })
      .eq("id", campaignId)
      .eq("agent_run_id", runId);
    if (STEP_LABELS[name]) await broadcastChange({ id: campaignId, status: "researching", step: STEP_LABELS[name] });
  }
  const run = serverTools(campaignId, runId)[name];
  if (!run) return { ok: false, summary: `Unknown tool ${name}` };
  return run(input as never, { toolCallId, runId });
}

/**
 * Opens a research run: marks it as the campaign's active run and adds the
 * opening request to the thread ("Make ads for <domain>" for a new campaign,
 * "Research <domain> again" otherwise). Returns the thread for the agent.
 */
export async function beginResearchRun(campaignId: string, runId: string): Promise<AgentUIMessage[]> {
  "use step";
  // Usually already done by whoever started the run; idempotent either way.
  const thread = await openResearchThread(campaignId, runId);
  await broadcastChange({ id: campaignId, status: "researching", step: "Starting research" });
  return thread;
}

/**
 * Saves what a run said into the thread: its reply is rebuilt from the run's
 * own durable stream. A run that continues the last assistant message (a
 * submitted choice card) replaces it; otherwise the reply is appended. If a
 * newer run has taken over (the user sent a message mid-run, and that turn
 * saved its own copy of the thread), nothing is saved.
 */
export async function saveRunThread(
  campaignId: string,
  runId: string,
  continuing: AgentUIMessage | null,
  /** Why the turn failed, if it did: saved as a closing line so the thread says the reply stopped. */
  failure?: string,
): Promise<void> {
  "use step";
  const chunks = getRun(runId)
    .getReadable<ModelCallStreamPart>({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform());
  let reply: AgentUIMessage | undefined;
  for await (const message of readUIMessageStream<AgentUIMessage>({
    message: continuing ?? undefined,
    stream: chunks,
    onError: (error) => console.error("[agent] rebuilding the reply failed", error),
  })) {
    reply = message;
  }

  const campaign = await getCampaign(campaignId);
  if (campaign?.agentRunId !== runId) return; // a newer turn owns the thread now
  if (failure) {
    const note = { type: "text" as const, text: `(This reply stopped early: ${failure}. Send a message to try again.)` };
    reply = reply
      ? { ...reply, parts: [...reply.parts, note] }
      : { id: continuing?.id ?? `msg-${generateId()}`, role: "assistant", parts: [...(continuing?.parts ?? []), note] };
  }
  if (reply && reply.parts.length) {
    reply = { ...reply, id: continuing?.id ?? (reply.id || `msg-${generateId()}`) };
    const thread = await getChat(campaignId);
    const at = thread.findIndex((m) => m.id === reply!.id);
    await saveChat(campaignId, at === -1 ? [...thread, reply] : thread.map((m, i) => (i === at ? reply! : m)));
  }
  await supabase().from("campaigns").update({ agent_run_id: null }).eq("id", campaignId).eq("agent_run_id", runId);
}

/** Closes a research run: the campaign's status, and the news for the grid and the open page. */
/**
 * Every research run ends with the brand's own graphics looked for: if the
 * agent didn't call findBrandVisuals and the kit has none, this does. Ideas
 * with a brand graphic depend on them, so it isn't left to the agent's
 * judgment. Never throws.
 */
export async function ensureBrandVisuals(campaignId: string): Promise<void> {
  "use step";
  try {
    const session = await ResearchSession.open(campaignId, { by: "research", force: false });
    if (session.kit.visuals?.length) return;
    const result = await findBrandVisuals({ session, fc: null });
    console.log(`[agent] brand visuals: ${result.summary}`);
  } catch (error) {
    // A missing homepage read, a blocked site: research carries on without them.
    console.error("[agent] finding brand visuals failed", error);
  }
}

export async function finishResearchRun(campaignId: string, runId: string): Promise<void> {
  "use step";
  const research = await getCampaignResearch(campaignId);
  const ok = Boolean(research?.kit && (research.kit.name || research.kit.catalog?.length));
  const status = ok ? "ready" : "research_failed";
  const db = supabase();
  await db
    .from("campaigns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("status", "researching");
  await db.from("campaigns").update({ agent_run_id: null }).eq("id", campaignId).eq("agent_run_id", runId);
  await broadcastChange({ id: campaignId, status, name: research?.kit?.name, logo: research?.kit?.logo });
  await broadcast(campaignTopic(campaignId), EVENTS.finished, { status });
}

async function broadcastChange(change: Omit<CampaignChange, "at">) {
  await broadcast(CAMPAIGNS_TOPIC, EVENTS.changed, { ...change, at: new Date().toISOString() });
}
