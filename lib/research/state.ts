import "server-only";

import { kitRow } from "@/lib/campaigns";
import { supabase } from "@/lib/supabase/server";

import type { BrandKit, CatalogItem, Product, ProductType, SelectedProduct } from "./types";

/**
 * Research's saved state, shared by every research step, whoever runs it.
 *
 * A step opens a `ResearchSession`, reads what earlier steps stored
 * (snapshots of what was read, the kit, the catalog), and writes through it.
 * Two rules hold for every write:
 *
 * - **Edits win.** Fields the user or agent changed are listed in
 *   `brand_kits.edited`; a write by research skips them. A write by the
 *   agent or user marks its fields as edited.
 * - **Merge, don't replace.** Products are keyed by their source id. A
 *   research re-run replaces only what research added; items the agent or
 *   user added stay.
 */

export type Actor = "research" | "agent" | "user";
export type SnapshotKind = "page" | "shopify" | "links";

/** A catalog item with its grouping and who added it. */
export type CatalogEntry = Product & {
  typeName?: string;
  isHero?: boolean;
  reason?: string;
  features?: string[];
  origin: Actor;
};

/** Edit-tracking names for kit fields; nested ones are dotted. */
export type KitField =
  | "name"
  | "tagline"
  | "logo"
  | "colors"
  | "fonts"
  | "offering"
  | "valueProposition"
  | "audience.summary"
  | "audience.segments"
  | "voice.summary"
  | "voice.traits"
  | "voice.sampleLine"
  | "productTypes";

/** What a kit patch may set; `audience`/`voice` merge field by field. */
export type KitPatch = Partial<
  Pick<
    BrandKit,
    | "name"
    | "tagline"
    | "platform"
    | "logo"
    | "logoCandidates"
    | "colors"
    | "fonts"
    | "offering"
    | "offeringReason"
    | "valueProposition"
    | "catalogSize"
  >
> & {
  audience?: Partial<NonNullable<BrandKit["audience"]>>;
  voice?: Partial<NonNullable<BrandKit["voice"]>>;
};

const SIMPLE_FIELDS: Partial<Record<keyof KitPatch, KitField>> = {
  name: "name",
  tagline: "tagline",
  logo: "logo",
  logoCandidates: "logo",
  colors: "colors",
  fonts: "fonts",
  offering: "offering",
  offeringReason: "offering",
  valueProposition: "valueProposition",
};

type ProductRow = {
  source_id: string;
  title: string;
  url: string;
  price: string | null;
  type_name: string | null;
  description: string | null;
  reason: string | null;
  features: string[] | null;
  images: string[] | null;
  is_hero: boolean;
  listed_type: string | null;
  tags: string[] | null;
  origin: Actor;
  position: number;
};

/** Kit fields → the brand_kits columns they're saved in. */
const KIT_COLUMNS: Record<string, string[]> = {
  name: ["name"],
  tagline: ["tagline"],
  platform: ["platform"],
  offering: ["offering"],
  offeringReason: ["offering_reason"],
  logo: ["logo_url"],
  logoCandidates: ["logo_candidates"],
  colors: ["colors"],
  fonts: ["fonts"],
  valueProposition: ["value_proposition"],
  audience: ["audience"],
  voice: ["voice"],
  productTypes: ["product_types"],
  catalogSize: ["catalog_size"],
  productsPickedBy: ["products_picked_by"],
};

export class ResearchSession {
  /**
   * Kit fields changed in this session. Saves write only these, so steps
   * running in parallel (each with its own session) never overwrite each
   * other's results with a stale copy of the whole kit.
   */
  private readonly dirty = new Set<string>();
  private exists = false;

  private constructor(
    readonly campaignId: string,
    readonly by: Actor,
    public kit: BrandKit,
    readonly edited: Set<string>,
    public catalog: CatalogEntry[],
    private readonly force: boolean,
    private readonly onChange?: (kit: BrandKit) => void,
  ) {}

  /** Loads the campaign's kit and catalog (or a fresh kit before the first run). */
  static async open(
    campaignId: string,
    {
      by,
      force = false,
      onChange,
    }: {
      by: Actor;
      /** Research may overwrite edited fields (only when the user explicitly asked to reset them). */
      force?: boolean;
      onChange?: (kit: BrandKit) => void;
    },
  ): Promise<ResearchSession> {
    const db = supabase();
    const [campaign, kitRes, productsRes] = await Promise.all([
      db.from("campaigns").select("source_url, domain").eq("id", campaignId).single(),
      db.from("brand_kits").select("*").eq("campaign_id", campaignId).maybeSingle(),
      db.from("campaign_products").select("*").eq("campaign_id", campaignId).order("position"),
    ]);
    if (campaign.error) throw campaign.error;
    if (kitRes.error) throw kitRes.error;
    if (productsRes.error) throw productsRes.error;
    const k = kitRes.data;
    const kit: BrandKit = {
      sourceUrl: campaign.data.source_url,
      domain: campaign.data.domain,
      platform: k?.platform ?? undefined,
      offering: k?.offering ?? undefined,
      offeringReason: k?.offering_reason ?? undefined,
      name: k?.name ?? undefined,
      tagline: k?.tagline ?? undefined,
      logo: k?.logo_url ?? undefined,
      logoCandidates: k?.logo_candidates ?? [],
      colors: k?.colors ?? [],
      fonts: k?.fonts ?? [],
      valueProposition: k?.value_proposition ?? undefined,
      audience: k?.audience ?? undefined,
      voice: k?.voice ?? undefined,
      catalogSize: k?.catalog_size ?? undefined,
      productTypes: k?.product_types ?? [],
      productsPickedBy: k?.products_picked_by ?? undefined,
      products: [],
    };
    const catalog = ((productsRes.data ?? []) as ProductRow[]).map(fromRow);
    const session = new ResearchSession(campaignId, by, kit, new Set(k?.edited ?? []), catalog, force, onChange);
    session.exists = Boolean(k);
    session.syncKitProducts();
    return session;
  }

  /** Whether this session may write a field (research never overwrites edits). */
  canWrite(field: KitField): boolean {
    return this.by !== "research" || this.force || !this.edited.has(field);
  }

  /** After a write: agent/user writes mark the field edited; a forced research write unmarks it. */
  private markWritten(field: KitField) {
    if (this.by !== "research") this.edited.add(field);
    else if (this.force) this.edited.delete(field);
    else return;
    this.dirty.add("edited");
  }

  // --- snapshots -------------------------------------------------------------

  async getSnapshot<T>(kind: SnapshotKind, key: string): Promise<T | null> {
    const { data, error } = await supabase()
      .from("research_snapshots")
      .select("data")
      .eq("campaign_id", this.campaignId)
      .eq("kind", kind)
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    return (data?.data as T) ?? null;
  }

  async putSnapshot(kind: SnapshotKind, key: string, data: unknown): Promise<void> {
    const { error } = await supabase()
      .from("research_snapshots")
      .upsert({ campaign_id: this.campaignId, kind, key, data, fetched_at: new Date().toISOString() });
    if (error) throw error;
  }

  /** Keys of the snapshots of one kind, newest first (e.g. every page read). */
  async snapshotKeys(kind: SnapshotKind): Promise<string[]> {
    const { data, error } = await supabase()
      .from("research_snapshots")
      .select("key")
      .eq("campaign_id", this.campaignId)
      .eq("kind", kind)
      .order("fetched_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => r.key);
  }

  // --- the kit ---------------------------------------------------------------

  /**
   * Applies a patch in memory (skipping edited fields when research writes)
   * and reports which fields changed. Call `saveKit()` to persist.
   */
  patchKit(patch: KitPatch): KitField[] {
    const changed: KitField[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof KitPatch, unknown][]) {
      if (value === undefined || key === "audience" || key === "voice") continue;
      const field = SIMPLE_FIELDS[key];
      if (field && !this.canWrite(field)) continue;
      (this.kit as Record<string, unknown>)[key] = value;
      this.dirty.add(key);
      if (field) changed.push(field);
    }
    if (patch.audience) {
      const next = { ...this.kit.audience };
      if (patch.audience.summary !== undefined && this.canWrite("audience.summary")) {
        next.summary = patch.audience.summary;
        changed.push("audience.summary");
        this.dirty.add("audience");
      }
      if (patch.audience.segments !== undefined && this.canWrite("audience.segments")) {
        next.segments = patch.audience.segments;
        changed.push("audience.segments");
        this.dirty.add("audience");
      }
      this.kit.audience = next;
    }
    if (patch.voice) {
      const next = { ...this.kit.voice };
      for (const [key, field] of [
        ["summary", "voice.summary"],
        ["traits", "voice.traits"],
        ["sampleLine", "voice.sampleLine"],
      ] as const) {
        if (patch.voice[key] !== undefined && this.canWrite(field)) {
          (next as Record<string, unknown>)[key] = patch.voice[key];
          changed.push(field);
          this.dirty.add("voice");
        }
      }
      this.kit.voice = next;
    }
    for (const f of changed) this.markWritten(f);
    if (changed.length) this.notify();
    return [...new Set(changed)];
  }

  /**
   * Saves the kit fields this session changed (and the edited list). The
   * first save of a campaign's kit writes the whole row.
   */
  async saveKit(): Promise<void> {
    const row: Record<string, unknown> = kitRow(this.campaignId, this.kit);
    const columns = this.exists
      ? Object.fromEntries(
          [...this.dirty].flatMap((field) => (KIT_COLUMNS[field] ?? []).map((c) => [c, row[c]])),
        )
      : row;
    const { error } = await supabase()
      .from("brand_kits")
      .upsert({
        ...columns,
        campaign_id: this.campaignId,
        ...(!this.exists || this.dirty.has("edited") ? { edited: [...this.edited] } : {}),
        updated_at: new Date().toISOString(),
      });
    if (error) throw error;
    this.exists = true;
    this.dirty.clear();
  }

  // --- the catalog -----------------------------------------------------------

  /**
   * Merges items into the catalog by source id. Scraped fields (title, url,
   * price, photos, listed type, tags) refresh; grouping and hero picks stay.
   * In "add" mode an item keeps its earlier photos if the new read found none.
   * "replace" also drops research-added items that aren't in `items` (the
   * agent's and user's stay). Returns how many were added and removed.
   */
  mergeProducts(items: Product[], mode: "add" | "replace"): { added: number; removed: number } {
    const incomingIds = new Set(items.map((p) => p.id));
    const incomingPages = new Set(items.map((p) => pageKey(p.url)));
    const before = this.catalog.length;
    let kept = this.catalog;
    if (mode === "replace") {
      kept = kept.filter(
        (e) => e.origin !== "research" || incomingIds.has(e.id) || incomingPages.has(pageKey(e.url)),
      );
    }
    const removed = before - kept.length;
    const byId = new Map(kept.map((e) => [e.id, e]));
    // The same item can arrive under another id (a Shopify id vs. its product
    // page's URL, with or without www), so match on the page URL too.
    const byUrl = new Map(kept.map((e) => [pageKey(e.url), e.id]));
    let added = 0;
    for (const item of items) {
      const knownId = byId.has(item.id) ? item.id : byUrl.get(pageKey(item.url));
      const p = knownId ? { ...item, id: knownId } : item;
      const existing = knownId ? byId.get(knownId) : undefined;
      if (existing) {
        // A full re-read is the truth about photos (it already dropped logos
        // and shared images); only an "add" keeps photos found earlier.
        const images = mode === "replace" || p.images.length ? p.images : existing.images;
        byId.set(p.id, { ...existing, ...p, images });
      } else {
        byId.set(p.id, { ...p, origin: this.by });
        added++;
      }
    }
    this.catalog = [...byId.values()];
    this.kit.catalogSize = this.catalog.length;
    this.dirty.add("catalogSize");
    this.syncKitProducts();
    this.notify();
    return { added, removed };
  }

  /** Removes items by id; returns how many were removed. */
  removeProducts(ids: string[]): number {
    const drop = new Set(ids);
    const before = this.catalog.length;
    this.catalog = this.catalog.filter((e) => !drop.has(e.id));
    this.kit.catalogSize = this.catalog.length;
    this.dirty.add("catalogSize");
    this.syncKitProducts();
    this.notify();
    return before - this.catalog.length;
  }

  /**
   * Sets the catalog's grouping: the types, which type each item belongs to,
   * and the hero picks with their reasons and features. Skipped when research
   * writes over a grouping the user or agent made. Returns false if skipped.
   */
  setGrouping(grouping: {
    types: ProductType[];
    typeOf: Map<string, string>;
    heroes: { id: string; typeName: string; reason?: string; features?: string[] }[];
    pickedBy: BrandKit["productsPickedBy"];
  }): boolean {
    if (!this.canWrite("productTypes")) return false;
    const heroes = new Map(grouping.heroes.map((h) => [h.id, h]));
    this.kit.productTypes = grouping.types;
    this.kit.productsPickedBy = grouping.pickedBy;
    this.dirty.add("productTypes").add("productsPickedBy");
    this.catalog = this.catalog.map((e) => {
      const hero = heroes.get(e.id);
      return {
        ...e,
        typeName: hero?.typeName ?? grouping.typeOf.get(e.id) ?? e.typeName,
        isHero: Boolean(hero),
        reason: hero?.reason,
        features: hero?.features ?? [],
      };
    });
    this.markWritten("productTypes");
    this.syncKitProducts();
    this.notify();
    return true;
  }

  /** Replaces photos for specific items, by item id. */
  setPhotos(byId: Map<string, string[]>): void {
    this.catalog = this.catalog.map((e) => (byId.has(e.id) ? { ...e, images: byId.get(e.id)! } : e));
    this.syncKitProducts();
    this.notify();
  }

  /** Saves every catalog row (upsert by source id) and deletes rows no longer in the catalog. */
  async saveCatalog(): Promise<void> {
    const db = supabase();
    const rows = this.catalog.map((e, position) => toRow(this.campaignId, e, position));
    const { data: existing, error: listError } = await db
      .from("campaign_products")
      .select("source_id")
      .eq("campaign_id", this.campaignId);
    if (listError) throw listError;
    const keep = new Set(rows.map((r) => r.source_id));
    const stale = (existing ?? []).map((r) => r.source_id).filter((id) => !keep.has(id));
    for (let i = 0; i < stale.length; i += 200) {
      const { error } = await db
        .from("campaign_products")
        .delete()
        .eq("campaign_id", this.campaignId)
        .in("source_id", stale.slice(i, i + 200));
      if (error) throw error;
    }
    for (let i = 0; i < rows.length; i += 250) {
      const { error } = await db
        .from("campaign_products")
        .upsert(rows.slice(i, i + 250), { onConflict: "campaign_id,source_id" });
      if (error) throw error;
    }
  }

  // --- helpers ---------------------------------------------------------------

  /** Keeps `kit.products` (heroes) and `kit.catalog` in step with the catalog. */
  private syncKitProducts() {
    this.kit.products = this.catalog
      .filter((e) => e.isHero)
      .map(
        (e): SelectedProduct => ({
          id: e.id,
          title: e.title,
          url: e.url,
          price: e.price,
          productType: e.productType,
          tags: e.tags,
          description: e.description,
          images: e.images,
          reason: e.reason,
          features: e.features ?? [],
          typeName: e.typeName,
        }),
      );
    this.kit.catalog = this.catalog.map(
      (e): CatalogItem => ({
        id: e.id,
        title: e.title,
        url: e.url,
        price: e.price,
        productType: e.productType,
        description: e.description?.slice(0, 200),
        images: e.images.slice(0, 4),
        typeName: e.typeName,
        isHero: e.isHero,
      }),
    );
  }

  private notify() {
    this.onChange?.(structuredClone(this.kit));
  }
}

/** A page's identity for matching: host without www, path without trailing slash or query. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/$/, "").toLowerCase()}`;
  } catch {
    return url;
  }
}

function fromRow(row: ProductRow): CatalogEntry {
  return {
    id: row.source_id,
    title: row.title,
    url: row.url,
    price: row.price ?? undefined,
    productType: row.listed_type ?? undefined,
    tags: row.tags ?? [],
    description: row.description ?? undefined,
    images: row.images ?? [],
    typeName: row.type_name ?? undefined,
    isHero: row.is_hero,
    reason: row.reason ?? undefined,
    features: row.features ?? [],
    origin: row.origin ?? "research",
  };
}

function toRow(campaignId: string, e: CatalogEntry, position: number) {
  return {
    campaign_id: campaignId,
    position,
    source_id: e.id,
    title: e.title,
    url: e.url,
    price: e.price ?? null,
    type_name: e.typeName ?? null,
    description: e.description ?? null,
    reason: e.reason ?? null,
    features: e.features ?? [],
    images: e.images,
    is_hero: Boolean(e.isHero),
    listed_type: e.productType ?? null,
    tags: e.tags ?? [],
    origin: e.origin,
  };
}
