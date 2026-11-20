"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/supabase/auth";

import {
  addAdComment,
  addHeadline,
  deleteAd,
  deleteAdComment,
  reviewAdComment,
  deleteCampaign,
  listAds,
  listHeadlines,
  removeHeadline,
  renameCampaign,
  updateKitStyle,
  type AdComment,
  type SavedAd,
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
  await requireUser();
  const parsed = z.object({ campaignId: id, name: z.string().trim().min(1).max(80) }).safeParse({
    campaignId,
    name,
  });
  if (!parsed.success) return { ok: false, error: "Names need 1 to 80 characters." };
  return run(() => renameCampaign(parsed.data.campaignId, parsed.data.name), "Couldn't rename the campaign.");
}

export async function deleteCampaignAction(campaignId: string): Promise<ActionResult> {
  await requireUser();
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
  await requireUser();
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
  await requireUser();
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
  await requireUser();
  const parsed = z.object({ campaignId: id, headline: copy }).safeParse({ campaignId, headline });
  if (!parsed.success) return { ok: false, error: "Unknown headline." };
  return run(
    () => removeHeadline(parsed.data.campaignId, parsed.data.headline),
    "Couldn't remove that headline.",
  );
}

/** Re-reads the saved headlines (after the agent saved or removed some in chat). */
export async function listHeadlinesAction(campaignId: string): Promise<SavedHeadline[] | null> {
  await requireUser();
  if (!id.safeParse(campaignId).success) return null;
  try {
    return await listHeadlines(campaignId);
  } catch (error) {
    console.error("[campaigns] listing headlines failed", error);
    return null;
  }
}

/** Re-reads the campaign's ads (after the agent made some in chat). */
export async function listAdsAction(campaignId: string): Promise<SavedAd[] | null> {
  await requireUser();
  if (!id.safeParse(campaignId).success) return null;
  try {
    return await listAds(campaignId);
  } catch (error) {
    console.error("[campaigns] listing ads failed", error);
    return null;
  }
}

/** Deletes one version of an ad, or the whole ad (every version). */
export async function deleteAdAction(
  campaignId: string,
  adId: string,
  scope: "version" | "ad",
): Promise<ActionResult> {
  await requireUser();
  if (!id.safeParse(campaignId).success || !id.safeParse(adId).success) return { ok: false, error: "Unknown ad." };
  return run(async () => void (await deleteAd(campaignId, adId, scope === "ad" ? "ad" : "version")), "Couldn't delete that ad.");
}

const fraction = z.number().min(0).max(1);

/** Pins a comment to a spot on an ad (x/y as fractions of its width/height). */
export async function addAdCommentAction(
  campaignId: string,
  adId: string,
  comment: { x: number; y: number; body: string },
): Promise<{ ok: true; comment: AdComment } | { ok: false; error: string }> {
  await requireUser();
  const parsed = z
    .object({ campaignId: id, adId: id, x: fraction, y: fraction, body: z.string().trim().min(1).max(500) })
    .safeParse({ campaignId, adId, ...comment });
  if (!parsed.success) return { ok: false, error: "Comments need 1 to 500 characters." };
  try {
    const { campaignId: cid, adId: aid, ...rest } = parsed.data;
    return { ok: true, comment: await addAdComment(cid, aid, rest) };
  } catch (error) {
    console.error("[campaigns] adding a comment failed", error);
    return { ok: false, error: "Couldn't save that comment." };
  }
}

export async function deleteAdCommentAction(campaignId: string, commentId: string): Promise<ActionResult> {
  await requireUser();
  if (!id.safeParse(campaignId).success || !id.safeParse(commentId).success) return { ok: false, error: "Unknown comment." };
  return run(() => deleteAdComment(campaignId, commentId), "Couldn't delete that comment.");
}

/** "Was it resolved?" for a comment an edit applied: yes resolves it, no re-opens it on the newest version. */
export async function reviewAdCommentAction(campaignId: string, commentId: string, resolved: boolean): Promise<ActionResult> {
  await requireUser();
  if (!id.safeParse(campaignId).success || !id.safeParse(commentId).success) return { ok: false, error: "Unknown comment." };
  return run(() => reviewAdComment(campaignId, commentId, resolved === true), "Couldn't save that answer.");
}
