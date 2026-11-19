import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type Tool } from "ai";
import { createHook, getWorkflowMetadata, getWritable } from "workflow";

import { agentToolSpecs, researchToolSpecs, type AgentUIMessage } from "@/lib/agent/tools";
import {
  beginResearchRun,
  executeServerTool,
  finishResearchRun,
  loadAgentSetup,
  saveRunThread,
} from "@/lib/agent/workflow-steps";

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
 * A run ends when the model stops or calls `proposeHeadlines`, which has no
 * server code: the choice card in the browser answers it, and that answer
 * starts the next turn. The user can interrupt a run: the cancel route
 * resumes the run's cancel hook, which aborts the agent; whatever it said so
 * far is still saved.
 */

/** Research steps that cost something per chat turn; free reads don't count. */
const MAX_RESEARCH_CALLS = 8;
const FREE_RESEARCH_TOOLS = new Set(["getCatalog", "researchStatus", "listSiteLinks"]);

export async function researchRun(campaignId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const thread = await beginResearchRun(campaignId, workflowRunId);
  try {
    return await runAgent(campaignId, workflowRunId, thread, "research");
  } finally {
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
  const setup = await loadAgentSetup(campaignId, mode, justSubmitted(messages));

  // Interrupts: DELETE /api/campaigns/<id>/chat/<runId> resumes this hook.
  using cancelHook = createHook<{ reason: string }>({ token: `agent-cancel:${runId}` });
  const controller = new AbortController();
  void cancelHook.then(() => controller.abort());

  // Every tool but the choice card runs on the server, as its own step.
  const tools: Record<string, Tool> = {};
  for (const [name, spec] of Object.entries(agentToolSpecs)) {
    tools[name] =
      name === "proposeHeadlines"
        ? spec
        : { ...spec, execute: (input: unknown) => executeServerTool(name, campaignId, runId, input) };
  }
  const costly = Object.keys(researchToolSpecs).filter((n) => !FREE_RESEARCH_TOOLS.has(n));
  const others = Object.keys(tools).filter((n) => !costly.includes(n));

  const agent = new WorkflowAgent({ model: setup.model, instructions: setup.instructions, tools });
  const result = await agent.stream({
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    writable: getWritable<ModelCallStreamPart>(),
    abortSignal: controller.signal,
    stopWhen: isStepCount(mode === "research" ? 40 : 12),
    prepareStep: ({ steps }) => {
      // A chat turn has a per-turn research budget; a research run is bounded
      // by its step limit and works through the skill's checklist. (Forcing a
      // tool call each step isn't supported by this model via the Gateway.)
      if (mode === "research") return {};
      const calls = steps.flatMap((s) => s.toolCalls).filter((c) => costly.includes(c.toolName)).length;
      return calls >= MAX_RESEARCH_CALLS ? { activeTools: others } : {};
    },
  });

  const last = messages.at(-1);
  await saveRunThread(campaignId, runId, last?.role === "assistant" ? last : null);
  return { finishReason: result.finishReason, aborted: controller.signal.aborted };
}

/**
 * The headlines the user just submitted from the card the agent was waiting
 * on; the instructions list them apart so the model doesn't read them as
 * duplicates it offered.
 */
function justSubmitted(messages: AgentUIMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  return last.parts.flatMap((part) =>
    part.type === "tool-proposeHeadlines" && part.state === "output-available" ? part.output.picked : [],
  );
}
