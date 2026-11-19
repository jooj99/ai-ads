import { getRun, resumeHook } from "workflow/api";

import { activeRunFor } from "./run";
import { unauthorized } from "@/lib/supabase/auth";

/**
 * Interrupts an agent run (the user sent a message, or pressed stop).
 * Resumes the run's cancel hook, which aborts the agent; the run still saves
 * what it said so far. If the run has no hook to resume (it already ended,
 * or hasn't reached it yet), a hard cancel is the backstop.
 */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/chat/[runId]">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id, runId } = await ctx.params;
  const target = await activeRunFor(id, runId);
  if (!target) return Response.json({ cancelled: false, reason: "no active run" });
  try {
    await resumeHook(`agent-cancel:${target}`, { reason: "user" });
    return Response.json({ cancelled: true, mode: "soft" });
  } catch {
    try {
      await getRun(target).cancel();
      return Response.json({ cancelled: true, mode: "hard" });
    } catch (error) {
      console.error("[agent] cancelling run failed", error);
      return Response.json({ cancelled: false }, { status: 500 });
    }
  }
}
