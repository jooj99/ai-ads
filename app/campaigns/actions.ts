"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  addHeadline,
  deleteCampaign,
  listHeadlines,
  removeHeadline,
  renameCampaign,
  updateKitStyle,
  type SavedHeadline,
} from "@/lib/campaigns";

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
// Font files keep their stored URL, which must point at this app's font route.
const fontFile = z.object({
  weight: z.number().int().min(1).max(1000),
  style: z.enum(["normal", "italic"]),
  source: z.string().url().max(2000),
  url: z.string().regex(/^\/api\/campaigns\/[0-9a-f-]{36}\/fonts\/[\w.-]+$/).optional(),
});
const fonts = z
  .array(
    z.object({
      family: z.string().min(1).max(80),
      role: z.string().max(40),
      files: z.array(fontFile).max(4).optional(),
    }),
  )
  .max(8);
const audience = z.object({
  summary: z.string().max(1000).optional(),
  segments: z.array(z.string().trim().min(1).max(40)).max(12),
});

/** Saves the brand kit's colors/fonts after the user removes some, or edited audience tags. */
export async function updateKitStyleAction(
  campaignId: string,
  style: { colors?: unknown; fonts?: unknown; audience?: unknown },
): Promise<ActionResult> {
  const parsed = z
    .object({
      campaignId: id,
      colors: colors.optional(),
      fonts: fonts.optional(),
      audience: audience.optional(),
    })
    .safeParse({ campaignId, ...style });
  if (!parsed.success) return { ok: false, error: "That change couldn't be saved." };
  const { campaignId: cid, ...rest } = parsed.data;
  return run(() => updateKitStyle(cid, rest), "Couldn't save the brand kit change.");
}

const copy = z.object({
  headline: z.string().trim().min(1).max(80),
  cta: z.string().trim().min(1).max(30),
});

/** Saves a headline the user picked from the agent's options or wrote themselves. */
export async function saveHeadlineAction(
  campaignId: string,
  headline: { headline: string; cta: string; source: "agent" | "user"; proposalId: string | null },
): Promise<ActionResult> {
  const parsed = z
    .object({
      campaignId: id,
      headline: copy.extend({
        source: z.enum(["agent", "user"]),
        proposalId: z.string().max(100).nullable(),
      }),
    })
    .safeParse({ campaignId, headline });
  if (!parsed.success) {
    return { ok: false, error: "Headlines need 1–80 characters and a CTA of 1–30." };
  }
  return run(
    () => addHeadline(parsed.data.campaignId, parsed.data.headline),
    "Couldn't save that headline.",
  );
}

export async function removeHeadlineAction(
  campaignId: string,
  headline: { headline: string; cta: string },
): Promise<ActionResult> {
  const parsed = z.object({ campaignId: id, headline: copy }).safeParse({ campaignId, headline });
  if (!parsed.success) return { ok: false, error: "Unknown headline." };
  return run(
    () => removeHeadline(parsed.data.campaignId, parsed.data.headline),
    "Couldn't remove that headline.",
  );
}

/** Re-reads the saved headlines (after the agent saved or removed some in chat). */
export async function listHeadlinesAction(campaignId: string): Promise<SavedHeadline[] | null> {
  if (!id.safeParse(campaignId).success) return null;
  try {
    return await listHeadlines(campaignId);
  } catch (error) {
    console.error("[campaigns] listing headlines failed", error);
    return null;
  }
}
