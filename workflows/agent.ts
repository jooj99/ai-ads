import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type Tool } from "ai";
import { createHook, getWorkflowMetadata, getWritable } from "workflow";
import { start } from "workflow/api";

import { GATEWAY_CACHING } from "@/lib/ai-caching";
import type { EditAdInput } from "@/lib/ads/edit";
import type { GenerateAdInput } from "@/lib/ads/generate";
import {
  PAUSE_TOOLS,
  agentToolSpecs,
  researchToolSpecs,
  type AgentUIMessage,
} from "@/lib/agent/tools";
import {
  adPrepare,
  adStartFailed,
  beginResearchRun,
  editPrepare,
  ensureBrandVisuals,
  executeServerTool,
  finishResearchRun,
  loadAgentSetup,
  prepareModelMessages,
  saveRunThread,
} from "@/lib/agent/workflow-steps";
import { adRun, editRun } from "@/workflows/ads";

/**
 * The ad agent as durable Vercel Workflow runs. Each run survives the page
 * closing, function timeouts and server restarts; each server tool call is a
 * checkpointed, retried step (lib/agent/workflow-steps.ts). The browser
 * streams a run's output and can reconnect to it at any time.
 *
 * - `researchRun`: started by Start Campaign / Research again. The agent
 *   follows the research skill, calling each research step as a tool, and
 *   ends by proposing headlines.
 * - `agentTurn`: one chat turn (a message, or a submitted choice card).
 *
 * A run ends when the model stops or calls a pause tool (`chooseProducts`,
 * `proposeIdeas`), which has no server code: the page answers it (products
 * picked in the Products tab, ideas ticked on the card), and that answer
 * starts the next turn. The user can interrupt a run: the cancel route
 * resumes the run's cancel hook, which aborts the agent; whatever it said so
 * far is still saved.
 */

/** Research steps that cost something per chat turn; free reads don't count. */
const MAX_RESEARCH_CALLS = 8;
const FREE_RESEARCH_TOOLS = new Set(["getCatalog", "researchStatus", "listSiteLinks"]);
/** Each ad or edit is a paid image (about a minute each); a turn makes at most this many. */
const MAX_ADS_PER_TURN = 6;

export async function researchRun(campaignId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const thread = await beginResearchRun(campaignId, workflowRunId);
  try {
    return await runAgent(campaignId, workflowRunId, thread, "research");
  } finally {
    await ensureBrandVisuals(campaignId);
    await finishResearchRun(campaignId, workflowRunId);
  }
}

export async function agentTurn(campaignId: string, messages: AgentUIMessage[]) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  return runAgent(campaignId, workflowRunId, messages, "chat");
}

async function runAgent(
  campaignId: string,
  runId: string,
  messages: AgentUIMessage[],
  mode: "chat" | "research",
) {
  const setup = await loadAgentSetup(
    campaignId,
    mode,
    justSubmitted(messages),
    justChosen(messages),
  );

  // Interrupts: DELETE /api/campaigns/<id>/chat/<runId> resumes this hook.
  using cancelHook = createHook<{ reason: string }>({ token: `agent-cancel:${runId}` });
  const controller = new AbortController();
  void cancelHook.then(() => controller.abort());

  // Every tool but the choice card runs on the server, as its own step. A
  // new ad or an edit is prepared here (a few seconds) and then made by its
  // own run (workflows/ads.ts): the turn doesn't wait for the image.
  const tools: Record<string, Tool> = {};
  for (const [name, spec] of Object.entries(agentToolSpecs)) {
    if (name === "proposeHeadlines") continue; // the old headline card: old threads only
    tools[name] = PAUSE_TOOLS.has(name)
      ? spec
      : name === "generateAd"
        ? {
            ...spec,
            execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
              const prepared = await adPrepare(
                campaignId,
                runId,
                input as GenerateAdInput,
                toolCallId,
              );
              if ("result" in prepared) return prepared.result;
              const { number, headline, adId } = prepared.job;
              try {
                await start(adRun, [prepared]);
              } catch (error) {
                const reason = `its run couldn't start (${startError(error)})`;
                await adStartFailed(campaignId, adId, reason);
                return {
                  ok: false,
                  summary: `Couldn't make Ad ${number} for “${headline}”: ${reason}. It can be tried again.`,
                };
              }
              return {
                ok: true,
                started: true,
                summary: `Started Ad ${number} for “${headline}”. It's being made on its own (about a minute) and appears in the chat and the Ads tab when it's ready, with any fixes or warnings.`,
              };
            },
          }
        : name === "editAd"
          ? {
              ...spec,
              execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
                const prepared = await editPrepare(
                  campaignId,
                  runId,
                  input as EditAdInput,
                  toolCallId,
                );
                if ("result" in prepared) return prepared.result;
                try {
                  await start(editRun, [prepared.job]);
                } catch (error) {
                  const reason = `its run couldn't start (${startError(error)})`;
                  await adStartFailed(campaignId, prepared.job.adId, reason);
                  return {
                    ok: false,
                    summary: `Couldn't edit Ad ${prepared.job.parent.number}: ${reason}. It can be tried again.`,
                  };
                }
                return {
                  ok: true,
                  started: true,
                  summary: `Started the edit of Ad ${prepared.job.parent.number}. It's being made on its own (about a minute) and appears in the chat and the Ads tab when it's ready, with what changed.`,
                };
              },
            }
          : {
              ...spec,
              execute: (input: unknown, { toolCallId }: { toolCallId: string }) =>
                executeServerTool(name, campaignId, runId, input, toolCallId),
            };
  }
  const costly = Object.keys(researchToolSpecs).filter((n) => !FREE_RESEARCH_TOOLS.has(n));

  const agent = new WorkflowAgent({ model: setup.model, instructions: setup.instructions, tools });
  const last = messages.at(-1);
  // However the turn ends, what the agent said is saved and the campaign's
  // active run is cleared, so a failed turn isn't replayed on every reload.
  // A failure adds a line saying the reply stopped and why, then the run
  // still fails (the chat shows the error with Try again).
  let failure: string | undefined;
  try {
    const result = await agent.stream({
      // Attached images get signed URLs the model can fetch (a step: it signs with our key).
      messages: await convertToModelMessages(await prepareModelMessages(campaignId, messages), {
        ignoreIncompleteToolCalls: true,
      }),
      writable: getWritable<ModelCallStreamPart>(),
      abortSignal: controller.signal,
      // Tool definitions, instructions and the thread so far repeat on every
      // step of a turn: the Gateway caches them (lib/ai-caching.ts).
      providerOptions: GATEWAY_CACHING,
      // A model call that stalls fails instead of leaving the chat on
      // "Thinking…" until the function is killed: the first output within a
      // minute, no minute of silence mid-reply, three minutes per call at most.
      timeout: AGENT_TIMEOUT,
      stopWhen: isStepCount(mode === "research" ? 40 : 12),
      prepareStep: ({ steps }) => {
        // A chat turn has per-turn budgets for research and ads; a research run is bounded
        // by its step limit and works through the skill's checklist. (Forcing a
        // tool call each step isn't supported by this model via the Gateway.)
        if (mode === "research") return {};
        const calls = steps.flatMap((s) => s.toolCalls);
        const research = calls.filter((c) => costly.includes(c.toolName)).length;
        const ads = calls.filter(
          (c) => c.toolName === "generateAd" || c.toolName === "editAd",
        ).length;
        let active = Object.keys(tools);
        if (research >= MAX_RESEARCH_CALLS) active = active.filter((n) => !costly.includes(n));
        if (ads >= MAX_ADS_PER_TURN)
          active = active.filter((n) => n !== "generateAd" && n !== "editAd");
        return active.length < Object.keys(tools).length ? { activeTools: active } : {};
      },
    });

    // A model call that fails or times out while streaming doesn't reject
    // stream(): it comes back as result.error, or (a timeout) as a turn with
    // no steps and finishReason "other". The run would end as if it had
    // finished, with the chat silent. Unless the user stopped the turn, it's
    // a failure: the run fails and the chat says why, with Try again.
    if (
      !controller.signal.aborted &&
      (result.error || result.steps.length === 0 || result.finishReason === "other" || result.finishReason === "error")
    ) {
      throw result.error ?? new ModelNoReplyError();
    }
    return { finishReason: result.finishReason, aborted: controller.signal.aborted };
  } catch (error) {
    failure = agentFailure(error);
    throw error;
  } finally {
    await saveRunThread(campaignId, runId, last?.role === "assistant" ? last : null, failure);
  }
}

/** A model call ended without a reply or an error of its own (a timeout while streaming). */
class ModelNoReplyError extends Error {
  constructor() {
    super("the AI model didn't respond in time");
    this.name = "ModelNoReplyError";
  }
}

/** A failed start() in words. */
function startError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120) || "unknown error";
}

/** Time limits on the agent's model calls (see the `timeout` option above). */
const AGENT_TIMEOUT = { firstChunkMs: 60_000, chunkMs: 60_000, stepMs: 180_000 };

/** Why a turn failed, in words for the saved thread. */
function agentFailure(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError" || name === "ModelNoReplyError") {
    return "the AI model didn't respond in time";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/credit balance|insufficient_funds/i.test(message)) return "the AI service is out of credits";
  return message.split("\n")[0].slice(0, 160) || "the AI model returned an error";
}

/** The products the user just picked on the product card (their notes are written before this turn). */
function justChosen(messages: AgentUIMessage[]): string[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  return last.parts.flatMap((part) =>
    part.type === "tool-chooseProducts" && part.state === "output-available"
      ? part.output.productIds
      : [],
  );
}

/**
 * The headlines the user just saved from the card the agent was waiting on
 * (a picked idea's headline + CTA, or an old headline card's picks); the
 * instructions list them apart so the model doesn't read them as duplicates
 * it offered.
 */
function justSubmitted(messages: AgentUIMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  return last.parts.flatMap((part) =>
    part.type === "tool-proposeIdeas" && part.state === "output-available"
      ? part.output.picked.map(({ headline, cta }) => ({ headline, cta }))
      : part.type === "tool-proposeHeadlines" && part.state === "output-available"
        ? part.output.picked
        : [],
  );
}
