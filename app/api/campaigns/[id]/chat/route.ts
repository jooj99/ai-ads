import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, TypeValidationError, validateUIMessages } from "ai";
import { start } from "workflow/api";

import { withRunFailure } from "@/lib/agent/run-failure";
import { PAUSE_TOOLS, agentToolSpecs, type AgentUIMessage } from "@/lib/agent/tools";
import { getCampaign, getChat, saveChat } from "@/lib/campaigns";
import { supabase } from "@/lib/supabase/server";
import { uploadName } from "@/lib/uploads";
import { agentTurn } from "@/workflows/agent";
import { unauthorized } from "@/lib/supabase/auth";

/**
 * Starts one chat turn of the ad agent as a durable workflow run
 * (workflows/agent.ts) and streams it back. The client (useChat with
 * WorkflowChatTransport) sends the whole thread; it's validated, cleaned of
 * anything an interruption left half-done, and saved before the run starts.
 * The run saves its own reply when it ends, even if the page has closed.
 * The `x-workflow-run-id` header lets the client reconnect to the run
 * (GET ./<runId>/stream) and interrupt it (DELETE ./<runId>).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[id]/chat">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id } = await ctx.params;
  const campaign = await getCampaign(id).catch((error) => {
    console.error("[agent] loading the campaign failed", error);
    return undefined;
  });
  if (campaign === undefined) return Response.json({ error: "Couldn't load the campaign." }, { status: 503 });
  if (!campaign) return Response.json({ error: "Campaign not found." }, { status: 404 });

  let messages: AgentUIMessage[];
  let trigger: string | undefined;
  try {
    const body = (await req.json()) as { messages?: unknown; trigger?: string };
    trigger = body.trigger;
    messages = await validateUIMessages<AgentUIMessage>({
      messages: withoutInterruptedParts(body.messages),
      tools: agentToolSpecs,
    });
  } catch (error) {
    if (!(error instanceof TypeValidationError)) console.error("[agent] bad request", error);
    return Response.json({ error: "That message couldn't be read." }, { status: 400 });
  }
  messages = closeUnansweredChoices(onlyOwnUploads(messages, id));

  // A tab that's behind (it loaded before another tab's reply was saved, or a
  // duplicate first send) would overwrite the newer thread; turn it away.
  // Continuing from a card keeps the count (the output joins the agent's
  // message) and a retry drops the failed reply, so only shorter sends are stale.
  const saved = await getChat(id).catch(() => []);
  if (trigger !== "regenerate-message" && messages.length < saved.length) {
    return Response.json(
      { error: "This chat changed in another tab. Reload the page to continue." },
      { status: 409 },
    );
  }

  // Take over the campaign before saving: an earlier run that was just
  // interrupted only saves its reply while it's still the active run, and
  // this thread already includes what the user saw of that reply.
  const db = supabase();
  await db.from("campaigns").update({ agent_run_id: `starting-${crypto.randomUUID()}` }).eq("id", id);
  // The thread as the user sees it now, so a reload mid-run shows it; the
  // run adds its reply when it ends.
  await saveChat(id, messages);
  const run = await start(agentTurn, [id, messages]);
  await db.from("campaigns").update({ agent_run_id: run.runId }).eq("id", id);

  return createUIMessageStreamResponse({
    stream: withRunFailure(run.runId, run.readable.pipeThrough(createModelCallToUIChunkTransform())),
    headers: { "x-workflow-run-id": run.runId },
  });
}

/**
 * When the user interrupts the agent (sends while it's replying), the stopped
 * reply can end mid tool call: arguments still streaming, or a server tool
 * that never returned. Those parts can't be validated or sent to the model,
 * so they're dropped (and an assistant message left empty with them).
 * Unanswered questions (the pause tools) are kept; closeUnansweredChoices handles them.
 * A tool call that appears twice (a run replayed into a chat that already
 * showed it) keeps only its first copy: the model rejects repeated call ids.
 */
function withoutInterruptedParts(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const seenCalls = new Set<string>();
  return raw
    .map((message) => {
      if (!message || typeof message !== "object" || !Array.isArray(message.parts)) return message;
      const parts = (message.parts as { type?: string; state?: string; toolCallId?: string }[]).filter((part) => {
        if (typeof part.type !== "string" || !part.type.startsWith("tool-")) return true;
        if (part.state === "input-streaming" || (part.state === "input-available" && !PAUSE_TOOLS.has(part.type.slice(5)))) {
          return false;
        }
        if (!part.toolCallId) return true;
        if (seenCalls.has(part.toolCallId)) return false;
        seenCalls.add(part.toolCallId);
        return true;
      });
      return { ...message, parts };
    })
    .filter(
      (message) =>
        !message ||
        message.role !== "assistant" ||
        (message.parts as { type: string }[]).some((p) => p.type !== "step-start"),
    );
}


/**
 * A question the user moved past (they replied in chat instead of picking
 * products or ideas) has no tool result, which the model API rejects. Record
 * it as an empty answer so the model knows they replied in chat; headlines
 * they saved from a card are in its instructions.
 */
function closeUnansweredChoices(messages: AgentUIMessage[]): AgentUIMessage[] {
  return messages.map((message, i) => {
    if (message.role !== "assistant" || i === messages.length - 1) return message;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type === "tool-chooseProducts" && part.state === "input-available") {
          return { ...part, state: "output-available" as const, output: { productIds: [], titles: [] } };
        }
        if ((part.type === "tool-proposeIdeas" || part.type === "tool-proposeHeadlines") && part.state === "input-available") {
          return { ...part, state: "output-available" as const, output: { picked: [] } };
        }
        return part;
      }),
    };
  });
}

/**
 * Attached images must be this campaign's own uploads (stored first by
 * POST /api/campaigns/<id>/uploads, referenced by our URL). Anything else,
 * like inline base64 or an outside URL, is dropped so threads stay small and
 * the agent only ever sees images the user put here.
 */
function onlyOwnUploads(messages: AgentUIMessage[], campaignId: string): AgentUIMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.parts.some((p) => p.type === "file")
      ? {
          ...m,
          parts: m.parts.filter(
            (p) => p.type !== "file" || (p.mediaType.startsWith("image/") && uploadName(campaignId, p.url) !== null),
          ),
        }
      : m,
  );
}
