import type { UIMessage } from "ai";

/** The research pipeline's stages, in display order. */
export type StepId = "detect" | "brand" | "catalog" | "insights";
export type StepStatus = "pending" | "running" | "done" | "warning" | "error";

export type ResearchStep = {
  id: StepId;
  label: string;
  status: StepStatus;
  /** One-line outcome, e.g. "Shopify store detected" or why a step degraded. */
  detail?: string;
};

/** A product as it exists on the store. Images are always the store's own. */
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
};

export type BrandColor = { hex: string; role: string };
export type BrandFont = { family: string; role: string };

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
  /** How many products the store lists in total. */
  catalogSize?: number;
  products: SelectedProduct[];
  /** "ai" when the model chose the products; "default" when it couldn't and we fell back. */
  productsPickedBy?: "ai" | "default";
};

export type ResearchNotice = {
  level: "error" | "warning";
  message: string;
};

/** The UI message streamed by /api/research: data parts only, no chat text. */
export type ResearchUIMessage = UIMessage<
  never,
  {
    step: ResearchStep;
    brandKit: BrandKit;
    notice: ResearchNotice;
  }
>;

export const STEP_LABELS: Record<StepId, string> = {
  detect: "Reading the store",
  brand: "Extracting logo, colors and fonts",
  catalog: "Loading products",
  insights: "Finding the value prop, audience and voice",
};

export const STEP_ORDER: StepId[] = ["detect", "brand", "catalog", "insights"];
