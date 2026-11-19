"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { deleteCampaign, renameCampaign, updateKitStyle } from "@/lib/campaigns";

export type ActionResult = { ok: true } | { ok: false; error: string };

const id = z.string().uuid();

async function run(work: () => Promise<void>, failure: string): Promise<ActionResult> {
  try {
    await work();
    revalidatePath("/campaigns");
    return { ok: true };
  } catch (error) {
    console.error(`[campaigns] ${failure}`, error);
    return { ok: false, error: failure };
  }
}

export async function renameCampaignAction(campaignId: string, name: string): Promise<ActionResult> {
  const parsed = z.object({ campaignId: id, name: z.string().trim().min(1).max(80) }).safeParse({
    campaignId,
    name,
  });
  if (!parsed.success) return { ok: false, error: "Names need 1 to 80 characters." };
  return run(() => renameCampaign(parsed.data.campaignId, parsed.data.name), "Couldn't rename the campaign.");
}

export async function deleteCampaignAction(campaignId: string): Promise<ActionResult> {
  if (!id.safeParse(campaignId).success) return { ok: false, error: "Unknown campaign." };
  return run(() => deleteCampaign(campaignId), "Couldn't delete the campaign.");
}

const colors = z.array(z.object({ hex: z.string().regex(/^#[0-9A-F]{6}$/i), role: z.string().max(40) })).max(12);
const fonts = z.array(z.object({ family: z.string().min(1).max(80), role: z.string().max(40) })).max(8);

/** Saves the brand kit's colors and/or fonts after the user removes some. */
export async function updateKitStyleAction(
  campaignId: string,
  style: { colors?: unknown; fonts?: unknown },
): Promise<ActionResult> {
  const parsed = z
    .object({ campaignId: id, colors: colors.optional(), fonts: fonts.optional() })
    .safeParse({ campaignId, ...style });
  if (!parsed.success) return { ok: false, error: "That change couldn't be saved." };
  const { campaignId: cid, ...rest } = parsed.data;
  return run(() => updateKitStyle(cid, rest), "Couldn't save the brand kit change.");
}
