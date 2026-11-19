import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

import { activeRunFor } from "../run";

/**
 * Reconnects to an agent run's stream, replaying it from the start and then
 * following it live. `runId` is the run's id, or the campaign id itself,
 * meaning "the campaign's active run" (how a page that just loaded resumes
 * research it didn't start). `startIndex` skips UI chunks the client has.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/campaigns/[id]/chat/[runId]/stream">) {
  const { id, runId } = await ctx.params;
  const target = await activeRunFor(id, runId);
  if (!target) return new Response(null, { status: 204 });

  const startIndex = Number(new URL(req.url).searchParams.get("startIndex") ?? "0");
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    return Response.json({ error: "startIndex must be a non-negative integer" }, { status: 400 });
  }
  const readable = getRun(target)
    .getReadable({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: startIndex }));
  return createUIMessageStreamResponse({ stream: readable, headers: { "x-workflow-run-id": target } });
}
