/** The research pipeline's stages, in display order. */
export type StepId = "detect" | "brand" | "offering" | "catalog" | "insights";
export type StepStatus = "pending" | "running" | "done" | "warning" | "error";

export type ResearchStep = {
  id: StepId;
  label: string;
  status: StepStatus;
  /** One-line outcome, e.g. "Shopify store detected" or why a step degraded. */
  detail?: string;
};

/** Whether the business sells physical goods or services; decides how the catalog is found. */
export type Offering = "goods" | "services";

/**
 * A product (or, for service businesses, a service) as it exists on the site.
 * Images are always the site's own.
 */
export type Product = {
  /** Stable key: the Shopify product id, or the product URL on other sites. */
  id: string;
  title: string;
  url: string;
  price?: string;
  productType?: string;
  tags?: string[];
  description?: string;
  images: string[];
};

/** A product the agent picked for ads, with features drawn from its listing. */
export type SelectedProduct = Product & {
  reason?: string;
  features: string[];
  /** The product type this pick represents, e.g. "Sunglasses". */
  typeName?: string;
};

/** One of up to 10 groups the catalog is organized into for ads. */
export type ProductType = { name: string; summary?: string };

/** Any catalog item, tagged with its type; heroes are also in `products`. */
export type CatalogItem = Product & {
  typeName?: string;
  isHero?: boolean;
  /** Who added it: research, or the agent or user on request. */
  origin?: "research" | "agent" | "user";
};

export type BrandColor = { hex: string; role: string };
/**
 * One font file for a brand font, scraped from the site's @font-face rules.
 * `source` is where the site serves it; once research copies it into our
 * storage, `url` is where we serve it (`/api/campaigns/<id>/fonts/<file>`).
 */
export type FontFile = { weight: number; style: "normal" | "italic"; source: string; url?: string };

export type BrandFont = {
  family: string;
  role: string;
  /** The site's own files for this font (regular and bold), when it serves them. */
  files?: FontFile[];
};

/**
 * Everything research learns about a brand. Scraped facts (logo, colors,
 * fonts, products and their images) come straight from the site; the copy
 * fields (value proposition, audience, voice) are inferred by the model.
 */
export type BrandKit = {
  sourceUrl: string;
  domain: string;
  platform?: "shopify" | "website";
  name?: string;
  tagline?: string;
  logo?: string;
  logoCandidates: string[];
  colors: BrandColor[];
  fonts: BrandFont[];
  valueProposition?: string;
  audience?: { summary?: string; segments?: string[] };
  voice?: { summary?: string; traits?: string[]; sampleLine?: string };
  offering?: Offering;
  /** One line on why the business was classified as goods or services. */
  offeringReason?: string;
  /** How many products (or services) the site lists in total. */
  catalogSize?: number;
  /** At most 10 types spanning the whole catalog, in advertising priority. */
  productTypes: ProductType[];
  /** Hero picks, each tagged with its `typeName`. */
  products: SelectedProduct[];
  /** The whole catalog (heroes included), each tagged with a type. Arrives at the end of research. */
  catalog?: CatalogItem[];
  /** "ai" when the model chose the products; "default" when it couldn't and we fell back. */
  productsPickedBy?: "ai" | "default";
  /** Fields the user or agent edited (research re-runs leave these alone), e.g. "colors". */
  edited?: string[];
};

export type ResearchNotice = {
  level: "error" | "warning";
  message: string;
};

export const STEP_LABELS: Record<StepId, string> = {
  detect: "Reading the store",
  brand: "Extracting logo, colors and fonts",
  offering: "Checking whether it sells goods or services",
  catalog: "Loading products",
  insights: "Finding the value prop, audience and voice",
};

export const STEP_ORDER: StepId[] = ["detect", "brand", "offering", "catalog", "insights"];

/** The most product types the selection is organized into. */
export const MAX_PRODUCT_TYPES = 10;
