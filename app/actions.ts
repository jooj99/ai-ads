"use server";

import { redirect } from "next/navigation";

import { createCampaign } from "@/lib/campaigns";
import { normalizeStoreUrl, ResearchInputError } from "@/lib/research/url";

export type StartCampaignState = { error?: string; url?: string };

/**
 * Home's "Start Campaign": validate the URL, create the campaign, and send the
 * user to its page, where research starts on arrival.
 */
export async function startCampaign(
  _previous: StartCampaignState,
  formData: FormData,
): Promise<StartCampaignState> {
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
    id = (await createCampaign(url)).id;
  } catch (error) {
    console.error("[campaigns] create failed", error);
    return { url: input, error: "Couldn't create the campaign. Try again in a moment." };
  }

  redirect(`/campaigns/${id}`);
}
