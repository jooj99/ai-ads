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
import { deleteFontFiles } from "@/lib/research/font-store";
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
  productCount: number;
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
  const { data, error } = await supabase()
    .from("campaigns")
    .select("*, brand_kits(logo_url, offering, research_steps), campaign_products(count)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((row) => {
    const kit = row.brand_kits as {
      logo_url: string | null;
      offering: string | null;
      research_steps: ResearchStep[] | null;
    } | null;
    const counted = row.campaign_products as { count: number }[] | null;
    return {
      ...toCampaign(row as CampaignRow),
      step:
        row.status === "researching"
          ? kit?.research_steps?.find((s) => s.status === "running")?.label
          : undefined,
      logo: kit?.logo_url ?? undefined,
      offering: (kit?.offering as CampaignSummary["offering"]) ?? undefined,
      productCount: counted?.[0]?.count ?? 0,
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
