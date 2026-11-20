import { getRun, resumeHook } from "workflow/api";

import { cancelRunAds } from "@/lib/ads/render";

import { activeRunFor } from "./run";
import { unauthorized } from "@/lib/supabase/auth";

/**
 * Interrupts an agent run (the user sent a message, or pressed stop).
 * Resumes the run's cancel hook, which aborts the agent; the run still saves
 * what it said so far. If the run has no hook to resume (it already ended,
 * or hasn't reached it yet), a hard cancel is the backstop. Ads the run was
 * still making are cancelled too (their fal jobs and rows), so none is left
 * loading; whatever those jobs return later is thrown away.
 */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/chat/[runId]">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id, runId } = await ctx.params;
  const target = await activeRunFor(id, runId);
  if (!target) return Response.json({ cancelled: false, reason: "no active run" });
  const ads = await cancelRunAds(id, target).catch((error) => {
    console.error("[agent] cancelling the run's ads failed", error);
    return 0;
  });
  try {
    await resumeHook(`agent-cancel:${target}`, { reason: "user" });
    return Response.json({ cancelled: true, mode: "soft", ads });
  } catch {
    try {
      await getRun(target).cancel();
      return Response.json({ cancelled: true, mode: "hard", ads });
    } catch (error) {
      console.error("[agent] cancelling run failed", error);
      return Response.json({ cancelled: false }, { status: 500 });
    }
  }
}
