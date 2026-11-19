import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { generateId, readUIMessageStream } from "ai";
import { getRun } from "workflow/api";

import { AGENT_MODEL, buildInstructions, serverTools } from "@/lib/agent/server-tools";
import { openResearchThread } from "@/lib/agent/research-thread";
import type { AgentUIMessage } from "@/lib/agent/tools";
import { getCampaign, getCampaignResearch, getChat, saveChat } from "@/lib/campaigns";
import { CAMPAIGNS_TOPIC, campaignTopic, EVENTS, type CampaignChange } from "@/lib/realtime";
import { supabase } from "@/lib/supabase/server";

/**
 * The durable agent's steps (see workflows/agent.ts). Each function marked
 * "use step" runs as one checkpointed, retried workflow step, so each must be
 * safe to run again: they read and upsert by id. Their arguments and results
 * are plain JSON.
 */

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
  researchStatus: "Checking research",
  proposeHeadlines: "Writing headlines",
};

/** The model and instructions for a run (instructions need the database, so they're built in a step). */
export async function loadAgentSetup(
  campaignId: string,
  mode: "chat" | "research",
  submitted: { headline: string; cta: string }[],
): Promise<{ model: string; instructions: string }> {
  "use step";
  return { model: AGENT_MODEL, instructions: await buildInstructions(campaignId, mode, submitted) };
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
  return run(input as never);
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
  if (reply && reply.parts.length) {
    reply = { ...reply, id: continuing?.id ?? (reply.id || `msg-${generateId()}`) };
    const thread = await getChat(campaignId);
    const at = thread.findIndex((m) => m.id === reply!.id);
    await saveChat(campaignId, at === -1 ? [...thread, reply] : thread.map((m, i) => (i === at ? reply! : m)));
  }
  await supabase().from("campaigns").update({ agent_run_id: null }).eq("id", campaignId).eq("agent_run_id", runId);
}

/** Closes a research run: the campaign's status, and the news for the grid and the open page. */
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
  await db
    .channel(campaignTopic(campaignId))
    .httpSend(EVENTS.finished, { status })
    .catch((error) => console.error("[agent] finished broadcast failed", error));
}

async function broadcastChange(change: Omit<CampaignChange, "at">) {
  await supabase()
    .channel(CAMPAIGNS_TOPIC)
    .httpSend(EVENTS.changed, { ...change, at: new Date().toISOString() })
    .catch((error) => console.error("[agent] campaigns broadcast failed", error));
}
