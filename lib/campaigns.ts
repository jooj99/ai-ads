import "server-only";

import type {
  BrandColor,
  BrandFont,
  BrandKit,
  CatalogItem,
  ResearchNotice,
  ResearchStep,
  SelectedProduct,
} from "@/lib/research/types";
import { supabase } from "@/lib/supabase/server";

export type CampaignStatus = "researching" | "research_failed" | "ready";

export type Campaign = {
  id: string;
  name: string;
  sourceUrl: string;
  domain: string;
  status: CampaignStatus;
  createdAt: string;
};

export type CampaignSummary = Campaign & {
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
};

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.source_url,
    domain: row.domain,
    status: row.status,
    createdAt: row.created_at,
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
    .select("*, brand_kits(logo_url, offering), campaign_products(count)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((row) => {
    const kit = row.brand_kits as { logo_url: string | null; offering: string | null } | null;
    const counted = row.campaign_products as { count: number }[] | null;
    return {
      ...toCampaign(row as CampaignRow),
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
          products: (products.data ?? [])
            .filter((p) => p.is_hero)
            .map(
              (p): SelectedProduct => ({
                id: p.source_id,
                title: p.title,
                url: p.url,
                price: p.price ?? undefined,
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
              typeName: p.type_name ?? undefined,
              description: p.description ?? undefined,
              images: p.images ?? [],
              isHero: p.is_hero,
            }),
          ),
        }
      : null,
    steps: k?.research_steps ?? [],
    notice: k?.research_notice ?? null,
  };
}

export async function setCampaignStatus(id: string, status: CampaignStatus): Promise<void> {
  const { error } = await supabase()
    .from("campaigns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Stores a finished research run: the brand kit, its hero products (replacing
 * the previous run's), and the campaign's status and display name.
 */
export async function saveResearch(
  id: string,
  {
    kit,
    steps,
    notice,
    status,
  }: { kit: BrandKit | null; steps: ResearchStep[]; notice: ResearchNotice | null; status: CampaignStatus },
): Promise<void> {
  const db = supabase();
  const now = new Date().toISOString();

  if (kit) {
    const { error: kitError } = await db.from("brand_kits").upsert({
      campaign_id: id,
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
      research_steps: steps,
      research_notice: notice,
      updated_at: now,
    });
    if (kitError) throw kitError;

    // The whole catalog: hero picks first (with their features and reason),
    // then every other item, each tagged with its type.
    const heroIds = new Set(kit.products.map((p) => p.id));
    const rows = [
      ...kit.products.map((p) => ({
        source_id: p.id,
        title: p.title,
        url: p.url,
        price: p.price ?? null,
        type_name: p.typeName ?? null,
        description: p.description ?? null,
        reason: p.reason ?? null,
        features: p.features,
        images: p.images,
        is_hero: true,
      })),
      ...(kit.catalog ?? [])
        .filter((p) => !heroIds.has(p.id))
        .map((p) => ({
          source_id: p.id,
          title: p.title,
          url: p.url,
          price: p.price ?? null,
          type_name: p.typeName ?? null,
          description: p.description ?? null,
          reason: null,
          features: [],
          images: p.images,
          is_hero: false,
        })),
    ].map((row, position) => ({ ...row, campaign_id: id, position }));

    const { error: clearError } = await db.from("campaign_products").delete().eq("campaign_id", id);
    if (clearError) throw clearError;
    for (let i = 0; i < rows.length; i += 250) {
      const { error: productsError } = await db
        .from("campaign_products")
        .insert(rows.slice(i, i + 250));
      if (productsError) throw productsError;
    }
  }

  const { error } = await db
    .from("campaigns")
    .update({ status, updated_at: now })
    .eq("id", id);
  if (error) throw error;

  // Adopt the brand's name only while the campaign still has its default
  // name (the domain), so a name the user chose is never overwritten.
  if (kit?.name) {
    const { error: nameError } = await db
      .from("campaigns")
      .update({ name: kit.name })
      .eq("id", id)
      .eq("name", kit.domain);
    if (nameError) throw nameError;
  }
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
}

/** Saves user edits to the brand kit's colors and fonts. */
export async function updateKitStyle(
  id: string,
  style: { colors?: BrandColor[]; fonts?: BrandFont[] },
): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown campaign");
  const { error } = await supabase()
    .from("brand_kits")
    .update({ ...style, updated_at: new Date().toISOString() })
    .eq("campaign_id", id);
  if (error) throw error;
}
