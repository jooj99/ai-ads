import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Firecrawl problems the user should hear about. Research steps degrade
 * quietly when a page read fails (plain HTML instead, a page skipped), so
 * running out of Firecrawl credits used to look like "No products could be
 * loaded" or "failed unexpectedly". Every Firecrawl call goes through
 * `withRateLimitRetry` (lib/research/page.ts), which records a credits or
 * rate-limit error here; the research tool wrapper (lib/agent/research-tools.ts)
 * watches each step and adds a plain note to its summary.
 */
export type FirecrawlProblem = "credits" | "rate";

const watching = new AsyncLocalStorage<Set<FirecrawlProblem>>();

/** What a Firecrawl error means for the user, or null for an ordinary failure. */
export function firecrawlProblem(error: unknown): FirecrawlProblem | null {
  const e = error as { status?: number; statusCode?: number; message?: string; code?: string } | null;
  const status = e?.status ?? e?.statusCode;
  const text = `${e?.message ?? ""} ${e?.code ?? ""}`;
  if (status === 402 || /insufficient credits|payment required|out of credits|credit limit/i.test(text)) return "credits";
  if (status === 429 || /rate limit/i.test(text)) return "rate";
  return null;
}

/** Records a Firecrawl error in the step being watched, if it's one the user should hear about. */
export function noteFirecrawlError(error: unknown): void {
  const problem = firecrawlProblem(error);
  if (problem) watching.getStore()?.add(problem);
}

/** Runs a research step, collecting the Firecrawl problems it ran into. */
export async function watchFirecrawl<T>(work: () => Promise<T>): Promise<{ result: T; problems: Set<FirecrawlProblem> }> {
  const problems = new Set<FirecrawlProblem>();
  const result = await watching.run(problems, work);
  return { result, problems };
}

/** A note for the step's summary, or "" when there was no problem. */
export function firecrawlNote(problems: Set<FirecrawlProblem>): string {
  if (problems.has("credits")) {
    return " Firecrawl (the page reader) is out of credits, so some pages couldn't be read: add credits in Firecrawl, or wait for its monthly reset, then try again.";
  }
  if (problems.has("rate")) {
    return " Firecrawl (the page reader) hit its rate limit, so some pages were skipped: wait a minute, then try again.";
  }
  return "";
}
