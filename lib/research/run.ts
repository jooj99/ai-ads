import "server-only";

import { getCampaign, saveProgress, saveResearch } from "@/lib/campaigns";
import {
  CAMPAIGNS_TOPIC,
  campaignTopic,
  EVENTS,
  type CampaignChange,
  type ProgressPayload,
} from "@/lib/realtime";
import { supabase } from "@/lib/supabase/server";

import { runResearch } from "./pipeline";
import { STEP_ORDER, type BrandKit, type ResearchNotice, type ResearchStep } from "./types";

const BROADCAST_EVERY_MS = 300;
const SAVE_EVERY_MS = 1_500;

/**
 * Runs research for a campaign that has already been claimed (claimResearch),
 * independent of any open page: it's started from a server action or route
 * with `after()`, so closing or leaving the page doesn't stop it.
 *
 * As it goes it (1) broadcasts the run's state on the campaign's Realtime
 * channel for its page, (2) broadcasts headline changes (status, name, logo,
 * current step) for the Campaigns list, and (3) saves progress to the
 * database, so a reload shows where the run is. The final result is saved
 * with retries, then a "finished" broadcast tells pages to reload it.
 */
export async function runClaimedResearch(campaignId: string): Promise<void> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return;

  const steps = new Map<string, ResearchStep>();
  let kit: BrandKit | null = null;
  let notice: ResearchNotice | null = null;
  const orderedSteps = () =>
    STEP_ORDER.map((id) => steps.get(id)).filter((s): s is ResearchStep => Boolean(s));

  const channel = supabase().channel(campaignTopic(campaignId));
  const list = supabase().channel(CAMPAIGNS_TOPIC);

  // Broadcasts are separate HTTP requests and can land out of order, so each
  // carries a sequence number (progress) or timestamp (headline) that clients
  // use to ignore stale ones.
  let seq = 0;
  const sendProgress = throttle(BROADCAST_EVERY_MS, () => {
    const payload: ProgressPayload = {
      seq: ++seq,
      steps: orderedSteps(),
      kit: kit ? { ...kit, catalog: undefined } : null,
      notice,
    };
    return channel.httpSend(EVENTS.progress, payload);
  });
  const persist = throttle(SAVE_EVERY_MS, () =>
    saveProgress(campaignId, { kit, steps: orderedSteps(), notice }),
  );

  let lastHeadline = "";
  let lastStep: string | undefined;
  const sendHeadline = (status: CampaignChange["status"]) => {
    // Steps overlap; between them nothing is "running", so keep the last label.
    lastStep = orderedSteps().find((s) => s.status === "running")?.label ?? lastStep;
    const change: CampaignChange = {
      id: campaignId,
      status,
      // Only a campaign still on its default name (the domain) adopts the brand name.
      name: campaign.name === campaign.domain ? kit?.name : undefined,
      logo: kit?.logo,
      step: status === "researching" ? lastStep : undefined,
      at: new Date().toISOString(),
    };
    const key = JSON.stringify({ ...change, at: undefined });
    if (key === lastHeadline) return;
    lastHeadline = key;
    void list.httpSend(EVENTS.changed, change).catch(logBroadcastError);
  };

  sendHeadline("researching");
  try {
    await runResearch(campaign.sourceUrl, {
      step: (step) => {
        steps.set(step.id, step);
        sendProgress.now();
        persist.soon();
        sendHeadline("researching");
      },
      kit: (next) => {
        kit = next;
        sendProgress.soon();
        persist.soon();
        sendHeadline("researching");
      },
      notice: (next) => {
        notice = next;
        sendProgress.now();
      },
    });
  } catch (error) {
    console.error("[research] run crashed", error);
    notice = { level: "error", message: "Research failed unexpectedly. Please try again." };
  }

  await sendProgress.flush();
  persist.cancel();

  const failed = !kit || notice?.level === "error";
  const status = failed ? "research_failed" : "ready";
  try {
    await withRetry(() =>
      saveResearch(campaignId, { kit, steps: orderedSteps(), notice, status }),
    );
  } catch (error) {
    // The campaign stays "researching"; after 5 quiet minutes it can be re-run.
    console.error("[research] saving the result failed", error);
  }
  sendHeadline(status);
  await channel.httpSend(EVENTS.finished, { status }).catch(logBroadcastError);
}

/**
 * Leading + trailing throttle: `now()` runs immediately (and resets the
 * window), `soon()` runs at most once per window, `flush()` runs anything
 * pending and waits for it. Errors are logged, never thrown into the run.
 */
function throttle(ms: number, fn: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let inFlight: Promise<unknown> = Promise.resolve();
  const run = () => {
    timer = null;
    last = Date.now();
    inFlight = fn().catch(logBroadcastError);
    return inFlight;
  };
  return {
    now() {
      if (timer) clearTimeout(timer);
      void run();
    },
    soon() {
      if (timer) return;
      const wait = Math.max(0, ms - (Date.now() - last));
      timer = setTimeout(run, wait);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        await run();
      } else {
        await inFlight;
      }
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

function logBroadcastError(error: unknown) {
  console.error("[research] realtime/progress update failed", error);
}
