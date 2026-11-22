import "server-only";

import type { AdIssue } from "@/lib/ads/verify";

/**
 * The check-and-repair loop for a new ad, with no dependencies of its own,
 * so it runs both in-process (lib/ads/generate.ts) and inside the ad's own
 * durable workflow run, where each phase is its own retried step
 * (workflows/ads.ts): a draft, then a check, then up to MAX_REPAIRS repair
 * rounds, then the finish. Each round is one edit that fixes every problem
 * the last check found at once, the way a comment edit works: a copy of the
 * ad with a numbered dashed box around each problem (fixAd in verify.ts).
 * Then the result is checked again and kept only if it's better. A version
 * whose check sees leftover marks (a copied box or number) is never kept
 * over one without: it scores as worse than any number of other problems.
 */

export const MAX_REPAIRS = 2;

export type AdCheck = { checked: boolean; issues: AdIssue[]; stalled?: boolean };

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
  /** The check never answered, so the ad wasn't checked (shown on the ad). */
  stalled?: boolean;
};

export type AdPhases<Job, Result> = {
  start: () => Promise<{ result: Result } | { job: Job; draftPath: string }>;
  check: (job: Job, path: string) => Promise<AdCheck>;
  /** One edit fixing these problems: the edited copy's path, or a result to end with (stopped), or neither (the edit failed). */
  repair: (job: Job, path: string, issues: AdIssue[], round: number) => Promise<{ path?: string; result?: Result }>;
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
    let repaired: { path?: string; result?: Result } = {};
    try {
      repaired = await repair(job, best.path, best.issues, round);
    } catch (error) {
      console.error(`[ads] repair round ${round} failed`, error);
    }
    if (repaired.result !== undefined) return repaired.result;
    if (!repaired.path) continue; // the edit failed: the next round tries again from the best so far
    const again = await safeCheck(job, repaired.path);
    if (!again.checked) break; // can't tell if it's better: keep what was checked
    if (score(again.issues) < score(best.issues)) best = { path: repaired.path, issues: again.issues };
  }
  return finish(job, best.path, {
    checked: first.checked,
    first: first.issues,
    rounds,
    fixed: best.path !== draftPath,
    remaining: best.issues,
    ...(first.stalled && { stalled: true }),
  });
}

/**
 * How bad a version is, for choosing between them. A leftover mark (part of
 * the location map the repair drew into the ad) outweighs everything, so a
 * version with one is never kept over a version without. Wrong text (a
 * headline drawn twice, a misspelled button) outweighs any likely mix of
 * logo and product problems: a repair that fixes two of those but repeats
 * the headline is worse, not better. Every other problem counts one.
 */
function score(issues: AdIssue[]): number {
  return issues.reduce((sum, i) => sum + (i.kind === "artifact" ? 100 : i.kind === "copy" ? 10 : 1), 0);
}
