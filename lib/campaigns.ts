import "server-only";

import type { AgentUIMessage } from "@/lib/agent/tools";
import type {
  BrandColor,
  BrandFont,
  BrandKit,
  CatalogItem,
  ResearchNotice,
  ResearchStep,
  SelectedProduct,
} from "@/lib/research/types";
import { adActivity } from "@/lib/ads/activity";
import { expireStaleAds } from "@/lib/ads/expire";
import { adImageUrl, deleteAdFiles } from "@/lib/ads/store";
import type { AdActivity } from "@/lib/realtime";
import { deleteFontFiles } from "@/lib/research/font-store";
import { deleteUploads } from "@/lib/uploads";
import { supabase } from "@/lib/supabase/server";

export type CampaignStatus = "researching" | "research_failed" | "ready";

export type Campaign = {
  id: string;
  name: string;
  sourceUrl: string;
  domain: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  /** When the current (or last) research run started; null before the first. */
  researchStartedAt: string | null;
  /** The durable agent run working on the campaign right now (research or a chat turn), if any. */
  agentRunId: string | null;
};

export type CampaignSummary = Campaign & {
  /** Label of the research step running now, while researching. */
  step?: string;
  logo?: string;
  offering?: "goods" | "services";
  /** Ads being made or edited right now. */
  ads: AdActivity;
  /** When `ads` was counted (server time): a live broadcast only wins if it's newer. */
  adsAt: string;
};

export type CampaignResearch = {
  campaign: Campaign;
  kit: BrandKit | null;
  steps: ResearchStep[];
  notice: ResearchNotice | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CampaignRow = {
  id: string;
  name: string;
  source_url: string;
  domain: string;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
  research_started_at: string | null;
  agent_run_id: string | null;
};

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.source_url,
    domain: row.domain,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    researchStartedAt: row.research_started_at,
    agentRunId: row.agent_run_id,
  };
}

export async function createCampaign(url: URL): Promise<Campaign> {
  const domain = url.hostname.replace(/^www\./, "");
  const { data, error } = await supabase()
    .from("campaigns")
    .insert({ name: domain, source_url: url.href, domain })
    .select()
    .single<CampaignRow>();
  if (error) throw error;
  return toCampaign(data);
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  // One round trip, not three: the list, the ad counts (for every campaign; the
  // table is small) and the stale-ad sweep (ads that can't finish any more
  // aren't "Making…") run at the same time.
  const adsAt = new Date().toISOString();
  const noActivity = new Map<string, AdActivity>();
  const activityRead = Promise.all([expireStaleAds(), adActivity().catch(() => noActivity)]);
  const { data, error } = await supabase()
    .from("campaigns")
    .select("*, brand_kits(logo_url, offering, research_steps)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const [expired, readActivity] = await activityRead;
  // The sweep rarely finds anything; when it does, count again without those ads.
  const activity = expired ? await adActivity().catch(() => noActivity) : readActivity;
  return (data ?? []).map((row) => {
    const kit = row.brand_kits as {
      logo_url: string | null;
      offering: string | null;
      research_steps: ResearchStep[] | null;
    } | null;
    return {
      ...toCampaign(row as CampaignRow),
      step:
        row.status === "researching"
          ? kit?.research_steps?.find((s) => s.status === "running")?.label
          : undefined,
      logo: kit?.logo_url ?? undefined,
      offering: (kit?.offering as CampaignSummary["offering"]) ?? undefined,
      ads: activity.get(row.id as string) ?? { making: 0, editing: 0, total: 0 },
      adsAt,
    };
  });
}

/** The campaign with its last research run, or null if it doesn't exist. */
export async function getCampaignResearch(id: string): Promise<CampaignResearch | null> {
  if (!UUID.test(id)) return null;
  const db = supabase();
  const [campaign, kit, products] = await Promise.all([
    db.from("campaigns").select("*").eq("id", id).maybeSingle<CampaignRow>(),
    db.from("brand_kits").select("*").eq("campaign_id", id).maybeSingle(),
    db.from("campaign_products").select("*").eq("campaign_id", id).order("position"),
  ]);
  if (campaign.error) throw campaign.error;
  if (!campaign.data) return null;
  if (kit.error) throw kit.error;
  if (products.error) throw products.error;

  const c = toCampaign(campaign.data);
  const k = kit.data;
  return {
    campaign: c,
    kit: k
      ? {
          sourceUrl: c.sourceUrl,
          domain: c.domain,
          platform: k.platform ?? undefined,
          offering: k.offering ?? undefined,
          offeringReason: k.offering_reason ?? undefined,
          name: k.name ?? undefined,
          tagline: k.tagline ?? undefined,
          logo: k.logo_url ?? undefined,
          logoCandidates: k.logo_candidates ?? [],
          visuals: k.visuals ?? [],
          colors: k.colors ?? [],
          fonts: k.fonts ?? [],
          valueProposition: k.value_proposition ?? undefined,
          audience: k.audience ?? undefined,
          voice: k.voice ?? undefined,
          catalogSize: k.catalog_size ?? undefined,
          productTypes: k.product_types ?? [],
          productsPickedBy: k.products_picked_by ?? undefined,
          edited: k.edited ?? [],
          products: (products.data ?? [])
            .filter((p) => p.is_hero)
            .map(
              (p): SelectedProduct => ({
                id: p.source_id,
                title: p.title,
                url: p.url,
                price: p.price ?? undefined,
                productType: p.listed_type ?? undefined,
                tags: p.tags ?? [],
                typeName: p.type_name ?? undefined,
                description: p.description ?? undefined,
                reason: p.reason ?? undefined,
                features: p.features ?? [],
                images: p.images ?? [],
              }),
            ),
          catalog: (products.data ?? []).map(
            (p): CatalogItem => ({
              id: p.source_id,
              title: p.title,
              url: p.url,
              price: p.price ?? undefined,
              productType: p.listed_type ?? undefined,
              typeName: p.type_name ?? undefined,
              description: p.description ?? undefined,
              images: p.images ?? [],
              isHero: p.is_hero,
              origin: p.origin ?? "research",
            }),
          ),
        }
      : null,
    steps: k?.research_steps ?? [],
    notice: k?.research_notice ?? null,
  };
}

export function kitRow(campaignId: string, kit: BrandKit) {
  return {
    campaign_id: campaignId,
    name: kit.name ?? null,
    tagline: kit.tagline ?? null,
    platform: kit.platform ?? null,
    offering: kit.offering ?? null,
    offering_reason: kit.offeringReason ?? null,
    logo_url: kit.logo ?? null,
    logo_candidates: kit.logoCandidates,
    visuals: kit.visuals ?? [],
    colors: kit.colors,
    fonts: kit.fonts,
    value_proposition: kit.valueProposition ?? null,
    audience: kit.audience ?? null,
    voice: kit.voice ?? null,
    product_types: kit.productTypes,
    catalog_size: kit.catalogSize ?? null,
    products_picked_by: kit.productsPickedBy ?? null,
  };
}

/**
 * Claims the campaign for a research run (see claim_research in the
 * migrations). False means a run is already in progress.
 */
export async function claimResearch(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { data, error } = await supabase().rpc("claim_research", { p_campaign_id: id });
  if (error) throw error;
  return data === true;
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabase()
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle<CampaignRow>();
  if (error) throw error;
  return data ? toCampaign(data) : null;
}

export async function setCampaignStatus(id: string, status: CampaignStatus): Promise<void> {
  const { error } = await supabase()
    .from("campaigns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Gives the campaign the brand's name, but only while it still has its
 * default name (the domain), so a name the user chose is never overwritten.
 */
export async function adoptBrandName(id: string, name: string, domain: string): Promise<void> {
  const { error } = await supabase().from("campaigns").update({ name }).eq("id", id).eq("name", domain);
  if (error) throw error;
}

export async function renameCampaign(id: string, name: string): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const { error } = await supabase()
    .from("campaigns")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Deletes the campaign; its brand kit and products go with it (on delete cascade). */
export async function deleteCampaign(id: string): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const { error } = await supabase().from("campaigns").delete().eq("id", id);
  if (error) throw error;
  // Storage isn't covered by the cascade; a failure here only leaves orphaned files.
  await deleteFontFiles(id).catch((e) => console.error("[campaigns] deleting font files failed", e));
  await deleteAdFiles(id).catch((e) => console.error("[campaigns] deleting ad files failed", e));
  await deleteUploads(id).catch((e) => console.error("[campaigns] deleting chat uploads failed", e));
}

/** The brand kit fields the user (in the panel) or the agent (in chat) can edit. */
export type EditableKit = Pick<BrandKit, "tagline" | "valueProposition" | "audience" | "voice" | "colors" | "fonts">;

/** The editable part of a campaign's brand kit, or null before research saved one. */
export async function getEditableKit(id: string): Promise<EditableKit | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabase()
    .from("brand_kits")
    .select("tagline, value_proposition, audience, voice, colors, fonts")
    .eq("campaign_id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    tagline: data.tagline ?? undefined,
    valueProposition: data.value_proposition ?? undefined,
    audience: data.audience ?? undefined,
    voice: data.voice ?? undefined,
    colors: data.colors ?? [],
    fonts: data.fonts ?? [],
  };
}

/**
 * Saves edits to the brand kit; only the fields given change. `fields` names
 * what the user or agent edited (see `KitField` in lib/research/state.ts);
 * they're added to `brand_kits.edited`, so research re-runs leave them alone.
 */
export async function updateKit(id: string, patch: Partial<EditableKit>, fields: string[]): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const db = supabase();
  const { data: current, error: readError } = await db
    .from("brand_kits")
    .select("edited")
    .eq("campaign_id", id)
    .maybeSingle();
  if (readError) throw readError;
  const columns: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    edited: [...new Set([...(current?.edited ?? []), ...fields])],
  };
  // A field left undefined is left alone (never cleared).
  if (patch.tagline !== undefined) columns.tagline = patch.tagline;
  if (patch.valueProposition !== undefined) columns.value_proposition = patch.valueProposition;
  if (patch.audience !== undefined) columns.audience = patch.audience;
  if (patch.voice !== undefined) columns.voice = patch.voice;
  if (patch.colors !== undefined) columns.colors = patch.colors;
  if (patch.fonts !== undefined) columns.fonts = patch.fonts;
  const { error } = await db.from("brand_kits").update(columns).eq("campaign_id", id);
  if (error) throw error;
}

/** Saves user edits from the panel: removed colors/fonts, edited audience tags. */
export async function updateKitStyle(
  id: string,
  style: { colors?: BrandColor[]; fonts?: BrandFont[]; audience?: BrandKit["audience"] },
): Promise<void> {
  const fields = [
    style.colors && "colors",
    style.fonts && "fonts",
    style.audience && "audience.segments",
  ].filter((f): f is string => Boolean(f));
  await updateKit(id, style, fields);
}

/** The campaign's chat with the ad agent, as AI SDK UI messages. */
export async function getChat(id: string): Promise<AgentUIMessage[]> {
  if (!UUID.test(id)) return [];
  const { data, error } = await supabase()
    .from("campaign_chats")
    .select("messages")
    .eq("campaign_id", id)
    .maybeSingle<{ messages: AgentUIMessage[] }>();
  if (error) throw error;
  return data?.messages ?? [];
}

export async function saveChat(id: string, messages: AgentUIMessage[]): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const { error } = await supabase()
    .from("campaign_chats")
    .upsert({ campaign_id: id, messages, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/** A headline + CTA the user saved for the campaign's ads. */
export type SavedHeadline = {
  headline: string;
  cta: string;
  /** "agent" when picked from the agent's options, "user" when written by the user. */
  source: "agent" | "user";
  /** The proposeHeadlines tool call it was picked or written under, if any. */
  proposalId: string | null;
};

/** The campaign's saved headlines, oldest first. */
export async function listHeadlines(id: string): Promise<SavedHeadline[]> {
  if (!UUID.test(id)) return [];
  const { data, error } = await supabase()
    .from("campaign_headlines")
    .select("headline, cta, source, proposal_id")
    .eq("campaign_id", id)
    .order("created_at");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    headline: row.headline,
    cta: row.cta,
    source: row.source,
    proposalId: row.proposal_id,
  }));
}

/** Saves a headline; saving the same headline and CTA again changes nothing. */
export async function addHeadline(id: string, h: SavedHeadline): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const { error } = await supabase()
    .from("campaign_headlines")
    .upsert(
      { campaign_id: id, headline: h.headline, cta: h.cta, source: h.source, proposal_id: h.proposalId },
      { onConflict: "campaign_id,headline,cta", ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function removeHeadline(id: string, h: { headline: string; cta: string }): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const { error } = await supabase()
    .from("campaign_headlines")
    .delete()
    .eq("campaign_id", id)
    .eq("headline", h.headline)
    .eq("cta", h.cta);
  if (error) throw error;
}

/** A comment pinned to a spot on an ad: x/y are fractions of its width/height. */
export type AdComment = {
  id: string;
  x: number;
  y: number;
  body: string;
  /** open → applied (by an edit) → resolved or unresolved (the user's answer). */
  status: "open" | "applied" | "resolved" | "unresolved";
  /** The version an edit applied it in. */
  appliedAdId: string | null;
  createdAt: string;
};

/** A generated ad as the app shows it. `imageUrl` is our own route, never fal's. */
export type SavedAd = {
  id: string;
  /** The ad's number in the campaign ("Ad 3"); every version of an ad shares it. */
  number: number;
  /** The version this one was edited from; null for an original. */
  parentId: string | null;
  /** The feedback this version applied, for edits. */
  instruction: string | null;
  /** For edits: how much of the ad outside the pins still looks as before (0–100). */
  retained: number | null;
  /** For edits: what visibly changed (bullets from comparing before and after). */
  changes: string[] | null;
  comments: AdComment[];
  /** Comments (pinned on an earlier version) that the edit making this version applied: what to review here. */
  appliedComments: AdComment[];
  headline: string;
  cta: string;
  productIds: string[];
  status: "generating" | "ready" | "failed";
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  error: string | null;
  createdAt: string;
  /** The agent tool call that made it, so the studio can tell a running call's ad from the call's placeholder. */
  toolCallId: string | null;
  /** Problems the check still found after its repair rounds (shown beside the ad); empty when it passed or wasn't checked. */
  issues: string[];
  /** Repair rounds the check ran on it (0–3). */
  fixRounds: number;
  /** The picked idea it was made from, if any. */
  idea: { title: string; concept: string } | null;
  /** While generating: what it's doing now ("Fixing the logo (round 1 of 3)"). */
  stage: string | null;
};

/**
 * The campaign's ads, with ads that can't finish any more marked failed
 * (`expireStaleAds`). The sweep and the read run at the same time; in the rare
 * case the sweep changed something, the ads are read again.
 */
export async function listCurrentAds(id: string): Promise<SavedAd[]> {
  const [expired, ads] = await Promise.all([expireStaleAds(id), listAds(id)]);
  return expired ? listAds(id) : ads;
}

/** The campaign's ads, newest first. */
export async function listAds(id: string): Promise<SavedAd[]> {
  if (!UUID.test(id)) return [];
  const { data, error } = await supabase()
    .from("campaign_ads")
    .select(
      "id, number, parent_id, instruction, retained, changes, headline, cta, product_ids, status, image_path, width, height, error, created_at, tool_call_id, verification, idea, stage, ad_comments!ad_comments_ad_id_fkey(id, x, y, body, status, applied_ad_id, created_at), applied:ad_comments!ad_comments_applied_ad_id_fkey(id, x, y, body, status, applied_ad_id, created_at)",
    )
    .eq("campaign_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    number: row.number ?? 0,
    parentId: row.parent_id,
    instruction: row.instruction,
    retained: row.retained,
    changes: row.changes,
    comments: toComments(row.ad_comments),
    appliedComments: toComments(row.applied),
    headline: row.headline,
    cta: row.cta,
    productIds: row.product_ids ?? [],
    status: row.status,
    imageUrl: row.image_path ? adImageUrl(id, row.image_path) : null,
    width: row.width,
    height: row.height,
    error: row.error,
    createdAt: row.created_at,
    toolCallId: row.tool_call_id ?? null,
    stage: row.status === "generating" ? (row.stage ?? null) : null,
    issues: ((row.verification as { remaining?: { problem?: string }[] } | null)?.remaining ?? []).flatMap((i) =>
      i.problem ? [i.problem] : [],
    ),
    fixRounds: (row.verification as { rounds?: number } | null)?.rounds ?? 0,
    idea: (row.idea as { title?: string } | null)?.title
      ? {
          title: (row.idea as { title: string }).title,
          concept: (row.idea as { pitch?: string; concept?: string }).pitch ?? (row.idea as { concept?: string }).concept ?? "",
        }
      : null,
  }));
}

/** Deletes one ad and its image. */
/**
 * Deletes one version of an ad, or (`scope: "ad"`) the whole ad: every
 * version sharing its number. Their images go too; their comments cascade.
 * Returns what was deleted, for the agent's summary.
 */
export async function deleteAd(
  id: string,
  adId: string,
  scope: "version" | "ad" = "version",
): Promise<{ number: number; versions: number }> {
  if (!UUID.test(id) || !UUID.test(adId)) throw new Error("Unknown ad");
  const db = supabase();
  const { data: ad, error: findError } = await db
    .from("campaign_ads")
    .select("number")
    .eq("campaign_id", id)
    .eq("id", adId)
    .maybeSingle();
  if (findError) throw findError;
  if (!ad) throw new Error("Unknown ad");
  let query = db.from("campaign_ads").delete().eq("campaign_id", id);
  query = scope === "ad" && ad.number != null ? query.eq("number", ad.number) : query.eq("id", adId);
  const { data, error } = await query.select("image_path");
  if (error) throw error;
  const names = (data ?? []).flatMap((r) => (r.image_path ? [r.image_path.split("/").pop()!] : []));
  if (names.length) await deleteAdFiles(id, names).catch((e) => console.error("[campaigns] deleting ad files failed", e));
  return { number: ad.number ?? 0, versions: data?.length ?? 0 };
}

type CommentRow = {
  id: string;
  x: number;
  y: number;
  body: string;
  /** open → applied (by an edit) → resolved or unresolved (the user's answer). */
  status: "open" | "applied" | "resolved" | "unresolved";
  applied_ad_id: string | null;
  created_at: string;
};

/** Pins a comment to a spot on one of the campaign's ads. */
export async function addAdComment(
  id: string,
  adId: string,
  comment: { x: number; y: number; body: string },
): Promise<AdComment> {
  if (!UUID.test(id) || !UUID.test(adId)) throw new Error("Unknown ad");
  const { data, error } = await supabase()
    .from("ad_comments")
    .insert({ campaign_id: id, ad_id: adId, ...comment })
    .select("id, x, y, body, status, applied_ad_id, created_at")
    .single<CommentRow>();
  if (error) throw error;
  return {
    id: data.id,
    x: data.x,
    y: data.y,
    body: data.body,
    status: data.status,
    appliedAdId: data.applied_ad_id,
    createdAt: data.created_at,
  };
}

export async function deleteAdComment(id: string, commentId: string): Promise<void> {
  if (!UUID.test(id) || !UUID.test(commentId)) throw new Error("Unknown comment");
  const { error } = await supabase().from("ad_comments").delete().eq("campaign_id", id).eq("id", commentId);
  if (error) throw error;
}

function toComments(rows: unknown): AdComment[] {
  return ((rows ?? []) as CommentRow[])
    .map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      body: c.body,
      status: c.status,
      appliedAdId: c.applied_ad_id,
      createdAt: c.created_at,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The user's answer to "was it resolved?" for a comment an edit applied.
 * Yes: it's done, so it's deleted. No: it's marked unresolved and re-opened
 * as a new open comment at the same spot on the ad's newest version, ready
 * to apply again.
 */
export async function reviewAdComment(id: string, commentId: string, resolved: boolean): Promise<void> {
  if (!UUID.test(id) || !UUID.test(commentId)) throw new Error("Unknown comment");
  const db = supabase();
  const { data: comment, error } = await db
    .from("ad_comments")
    .select("id, x, y, body, status, applied_ad_id")
    .eq("campaign_id", id)
    .eq("id", commentId)
    .maybeSingle();
  if (error) throw error;
  if (!comment || comment.status !== "applied") throw new Error("That comment isn't waiting for review.");
  if (resolved) {
    const { error: deleteError } = await db.from("ad_comments").delete().eq("id", commentId);
    if (deleteError) throw deleteError;
    return;
  }
  const reviewed = { status: resolved ? "resolved" : "unresolved", reviewed_at: new Date().toISOString() };
  const { error: updateError } = await db.from("ad_comments").update(reviewed).eq("id", commentId);
  if (updateError) throw updateError;
  if (resolved || !comment.applied_ad_id) return;

  const { data: version } = await db.from("campaign_ads").select("number").eq("id", comment.applied_ad_id).maybeSingle();
  const { data: newest } = await db
    .from("campaign_ads")
    .select("id")
    .eq("campaign_id", id)
    .eq("number", version?.number ?? -1)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error: insertError } = await db.from("ad_comments").insert({
    campaign_id: id,
    ad_id: newest?.id ?? comment.applied_ad_id,
    x: comment.x,
    y: comment.y,
    body: comment.body,
  });
  if (insertError) throw insertError;
}

/** Rewrites an open comment (applied ones are history and can't change). */
export async function updateAdComment(id: string, commentId: string, body: string): Promise<void> {
  if (!UUID.test(id) || !UUID.test(commentId)) throw new Error("Unknown comment");
  const { data, error } = await supabase()
    .from("ad_comments")
    .update({ body })
    .eq("campaign_id", id)
    .eq("id", commentId)
    .eq("status", "open")
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("That comment can't be edited any more.");
}
