import { getWorkflowMetadata } from "workflow";

import { runAdFlow } from "@/lib/ads/flow";
import type { AdDraftJob } from "@/lib/ads/generate";
import type { EditJob } from "@/lib/ads/edit";
import { adCheck, adDraft, adFinish, adRepair, editMake } from "@/lib/agent/workflow-steps";

/**
 * Each new ad and each edit runs as its own durable workflow run, started by
 * the agent's generateAd / editAd tool once the ad is prepared and recorded
 * (lib/agent/workflow-steps.ts). The agent's turn doesn't wait for them: they
 * finish independently, the ad's row carries their progress (stage, status),
 * and the chat and studio follow it live. One failing doesn't touch the
 * others, and a new chat turn doesn't stop them; the ad's Stop button does
 * (cancelAd). The run's id is recorded on the ad, so the stale-ad sweep knows
 * when it has ended.
 */

export async function adRun(prepared: AdDraftJob) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  return runAdFlow({
    start: () => adDraft(prepared, workflowRunId),
    check: adCheck,
    repair: adRepair,
    finish: adFinish,
  });
}

export async function editRun(job: EditJob) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  return editMake(job, workflowRunId);
}
