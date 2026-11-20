import type { AdIssue } from "@/lib/ads/verify";

/**
 * The check-and-repair loop for a new ad, with no dependencies of its own,
 * so it runs both in-process (lib/ads/generate.ts) and inside the agent's
 * durable workflow, where each phase is its own retried step
 * (workflows/agent.ts): a draft, then a check, then up to MAX_REPAIRS
 * repair rounds, then the finish (the real logo placed, stored). A round
 * takes the best version so far and chains one focused edit per problem
 * (each with that problem's box; at most MAX_EDITS_PER_ROUND), then checks
 * the result once; it's kept only if it has fewer problems. Each phase and
 * each edit fits a single step's time limit; the loop as a whole can take
 * several minutes.
 */

export const MAX_REPAIRS = 1;
/** Problems fixed per round, each with its own edit (the rest wait for the next round). */
export const MAX_EDITS_PER_ROUND = 4;

export type AdCheck = { checked: boolean; issues: AdIssue[] };

/** What the check found, saved on the ad (campaign_ads.verification). */
export type AdVerification = {
  checked: boolean;
  /** Problems in the first draft. */
  first: AdIssue[];
  /** Repair rounds run (0–MAX_REPAIRS). */
  rounds: number;
  /** True when a repaired version replaced the first draft. */
  fixed: boolean;
  /** Problems in the version that was kept. */
  remaining: AdIssue[];
};

export type AdPhases<Job, Result> = {
  start: () => Promise<{ result: Result } | { job: Job; draftPath: string }>;
  check: (job: Job, path: string) => Promise<AdCheck>;
  /** One edit for one problem: the edited copy's path, or a result to end with (stopped), or neither (that edit failed). */
  repair: (job: Job, path: string, issue: AdIssue, round: number, edit: number) => Promise<{ path?: string; result?: Result }>;
  finish: (job: Job, path: string, verification: AdVerification) => Promise<Result>;
};

export async function runAdFlow<Job, Result>(phases: AdPhases<Job, Result>): Promise<Result> {
  // Called as plain functions, never as `phases.check(…)`: in the workflow
  // each phase is a step, and a method call would hand the step `this` (this
  // object, functions and all) to serialize with its arguments.
  const { start, check, repair, finish } = phases;
  // A step that fails outright (its retries used up) mustn't sink the ad: a
  // failed check counts as unchecked and a failed repair round is skipped.
  const safeCheck = async (job: Job, path: string): Promise<AdCheck> => {
    try {
      return await check(job, path);
    } catch (error) {
      console.error("[ads] the check failed", error);
      return { checked: false, issues: [] };
    }
  };

  const started = await start();
  if ("result" in started) return started.result;
  const { job, draftPath } = started;

  const first = await safeCheck(job, draftPath);
  let best = { path: draftPath, issues: first.issues };
  let rounds = 0;
  for (let round = 1; round <= MAX_REPAIRS && best.issues.length > 0; round++) {
    rounds = round;
    // One edit per problem, each on the previous edit's result.
    let path = best.path;
    let edited = false;
    for (const [i, issue] of best.issues.slice(0, MAX_EDITS_PER_ROUND).entries()) {
      let repaired: { path?: string; result?: Result } = {};
      try {
        repaired = await repair(job, path, issue, round, i + 1);
      } catch (error) {
        console.error(`[ads] repair ${round}.${i + 1} failed`, error);
      }
      if (repaired.result !== undefined) return repaired.result;
      if (repaired.path) {
        path = repaired.path;
        edited = true;
      }
    }
    if (!edited) continue;
    const again = await safeCheck(job, path);
    if (again.checked && again.issues.length < best.issues.length) best = { path, issues: again.issues };
  }
  return finish(job, best.path, {
    checked: first.checked,
    first: first.issues,
    rounds,
    fixed: best.path !== draftPath,
    remaining: best.issues,
  });
}
