"use server";

import { redirect } from "next/navigation";
import { start } from "workflow/api";

import { claimResearch, createCampaign } from "@/lib/campaigns";
import { CAMPAIGNS_TOPIC, EVENTS, type CampaignChange } from "@/lib/realtime";
import { supabase } from "@/lib/supabase/server";
import { normalizeStoreUrl, ResearchInputError } from "@/lib/research/url";
import { requireUser } from "@/lib/supabase/auth";
import { researchRun } from "@/workflows/agent";
import { openResearchThread } from "@/lib/agent/research-thread";

export type StartCampaignState = { error?: string; url?: string };

/**
 * Home's "Start Campaign": validate the URL, create the campaign, start its
 * research in the background, and send the user to its page. Research keeps
 * running if they leave; pages follow it over Supabase Realtime.
 */
export async function startCampaign(
  _previous: StartCampaignState,
  formData: FormData,
): Promise<StartCampaignState> {
  await requireUser();
  const input = String(formData.get("url") ?? "").slice(0, 2_000);

  let url: URL;
  try {
    url = normalizeStoreUrl(input);
  } catch (error) {
    return {
      url: input,
      error: error instanceof ResearchInputError ? error.message : "That URL couldn't be read.",
    };
  }

  let id: string;
  try {
    const campaign = await createCampaign(url);
    id = campaign.id;
    // Research is a durable agent run (workflows/agent.ts): it keeps going
    // if the user leaves, and the page reconnects to it.
    if (await claimResearch(id)) {
      const run = await start(researchRun, [id]);
      await openResearchThread(id, run.runId); // so the page can follow the run at once
    }
    // Lets an open Campaigns list show the new campaign right away.
    const change: CampaignChange = {
      id,
      status: "researching",
      name: campaign.name,
      at: new Date().toISOString(),
    };
    void supabase().channel(CAMPAIGNS_TOPIC).httpSend(EVENTS.changed, change).catch(() => {});
  } catch (error) {
    console.error("[campaigns] create failed", error);
    return { url: input, error: "Couldn't create the campaign. Try again in a moment." };
  }

  redirect(`/campaigns/${id}`);
}
