import "server-only";

import type { UIMessageChunk } from "ai";
import { getRun } from "workflow/api";

/**
 * Ends a run's UI stream with an `error` chunk when the run failed, so the
 * chat shows why (with Try again) instead of the reply just stopping. A run
 * that dies at its first model call (the AI Gateway out of credits, say)
 * otherwise ends with no new output, and the page can't tell it apart from
 * a finished turn.
 */
export function withRunFailure(runId: string, stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      async flush(controller) {
        const reason = await failureOf(runId);
        if (reason) controller.enqueue({ type: "error", errorText: reason });
      },
    }),
  );
}

/** Why the run failed, in words for the chat; null if it didn't (or can't be told). */
async function failureOf(runId: string): Promise<string | null> {
  try {
    const run = getRun(runId);
    // The stream can close a moment before the run is marked failed.
    let status = await run.status;
    for (let i = 0; i < 10 && (status === "running" || status === "pending"); i++) {
      await new Promise((r) => setTimeout(r, 200));
      status = await run.status;
    }
    if (status !== "failed") return null;
    const message = await run.returnValue.then(
      () => "",
      (error: unknown) => (error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error)),
    );
    if (/credit balance|insufficient_funds/i.test(message)) {
      return "The AI service (Vercel AI Gateway) is out of credits, so the agent can't reply. Add credits to the Gateway, then press Try again.";
    }
    const detail = message.split("\n")[0].replace(/^.*failed after \d+ retries: /, "").slice(0, 200);
    return `The agent stopped with an error${detail ? `: ${detail}` : "."}`;
  } catch {
    return null;
  }
}
