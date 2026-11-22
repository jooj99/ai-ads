import "server-only";

import Firecrawl, { type BrandingProfile } from "@mendable/firecrawl-js";

import { noteFirecrawlError } from "@/lib/research/firecrawl-errors";
import {
  cleanFontFamily,
  collectHtmlSignals,
  fetchStylesheets,
  fontFilesFor,
  MAX_FONT_STYLESHEETS,
  MAX_STYLESHEETS,
  extractLayoutSections,
  fetchHtml,
  looksInternalFont,
  probeLogoPaths,
  rankLogos,
  readableFontName,
  REAL_LOGO_SCORE,
  toHex,
  type HtmlSignals,
  type LayoutLink,
  type LogoCandidate,
} from "./html-signals";
import type { BrandColor, BrandFont } from "./types";
import { absoluteUrl } from "./url";

/** What one homepage read yields, whichever way it was read. */
export type PageResearch = {
  /** "firecrawl" when the brand extractor ran; "html" when only our own HTML read worked. */
  source: "firecrawl" | "html";
  title?: string;
  description?: string;
  siteName?: string;
  logo?: string;
  /** Where the chosen logo came from, e.g. "brand extractor", "CSS mask" or "/assets/logo.png". */
  logoVia?: string;
  /** The homepage's og:image: the site-wide share picture, never one item's photo. */
  shareImage?: string;
  /** False when the best we have is a favicon or share image. */
  hasRealLogo: boolean;
  logoCandidates: string[];
  colors: BrandColor[];
  fonts: BrandFont[];
  /** Gaps in the brand extractor's result that the HTML read filled, e.g. "logo (CSS mask)". */
  filled: string[];
  /** Page copy for the model to read: markdown from Firecrawl, plain text otherwise. */
  content: string;
  /** Navbar link labels: the brand's own category list. */
  navigation: string;
  /** Footer text: guarantees, policies, secondary categories, contact. */
  footer: string;
  /** Labeled navbar and footer links, used to find category and service pages. */
  layoutLinks: LayoutLink[];
  links: string[];
  /** Firecrawl's own read of tone and personality, passed to the model as a hint. */
  styleHints?: string;
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export function firecrawlClient(): Firecrawl | null {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  return apiKey ? new Firecrawl({ apiKey }) : null;
}

type FirecrawlRead = {
  base: string;
  shareImage?: string;
  title?: string;
  description?: string;
  siteName?: string;
  logos: LogoCandidate[];
  colors: BrandColor[];
  fonts: BrandFont[];
  markdown: string;
  links: string[];
  rawHtml?: string;
  styleHints?: string;
};

/**
 * Homepage → brand identity. Firecrawl's brand extractor goes first. When it
 * leaves gaps (no real logo, under two colors, missing or unreadable fonts),
 * the HTML extractor reads the page itself: Firecrawl's rendered HTML when we
 * have it (bot-protected sites block plain fetches), otherwise HTML we fetch.
 * If there is still no logo, conventional paths like /assets/logo.png are
 * checked last.
 */
export async function researchPage(fc: Firecrawl | null, url: URL): Promise<PageResearch | null> {
  let read: FirecrawlRead | null = null;
  if (fc) {
    try {
      read = await scrapeWithFirecrawl(fc, url);
    } catch (error) {
      console.error("[research] firecrawl scrape failed", error);
    }
  }

  // The full HTML: Firecrawl's render when we have it, otherwise our own fetch.
  let html = read?.rawHtml;
  let base = read?.base ?? url.href;
  if (!html) {
    try {
      ({ html, base } = await fetchHtml(url));
    } catch (error) {
      console.error("[research] html fetch failed", error);
    }
  }

  // The site's stylesheets: always read now, for its @font-face files (and
  // for the HTML extractor below when the brand extractor left gaps).
  // Up to MAX_FONT_STYLESHEETS for fonts (a site's @font-face rules can sit
  // deep in a long list); colors and logos still read only the first few.
  const fontSheets = html
    ? await fetchStylesheets(html, base, MAX_FONT_STYLESHEETS).catch((error) => {
        console.error("[research] stylesheet fetch failed", error);
        return [];
      })
    : [];
  // Colors and logos read the first few, as before (more CSS adds noise there).
  const sheets = fontSheets.slice(0, MAX_STYLESHEETS);

  let signals: HtmlSignals | null = null;
  if (html && (!read || brandGaps(read).length > 0)) {
    try {
      signals = await collectHtmlSignals(html, base, sheets);
    } catch (error) {
      console.error("[research] html extraction failed", error);
    }
  }
  if (!read && !signals) return null;

  const layout = html
    ? extractLayoutSections(html, base)
    : { navigation: "", footer: "", links: [] };

  const filled: string[] = [];

  let logos = rankLogos([...(read?.logos ?? []), ...(signals?.logos ?? [])]);
  if ((logos[0]?.score ?? 0) < REAL_LOGO_SCORE) {
    const probed = await probeLogoPaths(new URL(read?.base ?? url.href).origin);
    if (probed) logos = rankLogos([probed, ...logos]);
  }
  const top = logos[0];
  const hasRealLogo = (top?.score ?? 0) >= REAL_LOGO_SCORE;
  if (read && hasRealLogo && top.via !== "brand extractor") filled.push(`logo (${top.via})`);

  let colors = read?.colors ?? [];
  if (colors.length < 2 && signals?.colors.length) {
    const seen = new Set(colors.map((c) => c.hex));
    colors = [...colors, ...signals.colors.filter((c) => !seen.has(c.hex))].slice(0, 6);
    if (read) filled.push("colors (stylesheets)");
  }

  const aliases = signals?.fontAliases ?? new Map<string, string>();
  let fonts = dedupeFonts(
    (read?.fonts ?? []).map((f) => ({ ...f, family: readableFontName(f.family, aliases) })),
  );
  if (read?.fonts.some((f) => looksInternalFont(f.family))) filled.push("font names (@font-face)");
  if (fonts.length === 0 && signals?.fonts.length) {
    fonts = signals.fonts;
    if (read) filled.push("fonts (stylesheets)");
  }
  // Attach the site's own font files, so previews (and ads) can use the real
  // face even when Google Fonts doesn't have it.
  if (html) fonts = fontFilesFor(fonts, html, base, fontSheets);

  return {
    source: read ? "firecrawl" : "html",
    shareImage: read?.shareImage ?? signals?.shareImage,
    title: read?.title ?? signals?.title,
    description: read?.description ?? signals?.description,
    siteName: read?.siteName ?? signals?.siteName,
    logo: top?.url,
    logoVia: top?.via,
    hasRealLogo,
    logoCandidates: logos.slice(0, 6).map((l) => l.url),
    colors,
    fonts,
    filled,
    content: read?.markdown || signals?.text || "",
    navigation: layout.navigation,
    footer: layout.footer,
    layoutLinks: layout.links,
    links: read?.links.length ? read.links : (signals?.links ?? []),
    styleHints: read?.styleHints,
  };
}

function brandGaps(read: FirecrawlRead): string[] {
  const gaps: string[] = [];
  if (!read.logos.some((l) => l.score >= REAL_LOGO_SCORE)) gaps.push("logo");
  if (read.colors.length < 2) gaps.push("colors");
  if (read.fonts.length === 0 || read.fonts.some((f) => looksInternalFont(f.family)))
    gaps.push("fonts");
  return gaps;
}

/**
 * Reads the homepage with Firecrawl: markdown for the copy, `branding` for
 * logo, colors and fonts from the rendered page, links for finding product
 * pages, and the rendered HTML for the HTML extractor. Cached copies up to a
 * day old are fine.
 */
async function scrapeWithFirecrawl(fc: Firecrawl, url: URL): Promise<FirecrawlRead> {
  const doc = await withRateLimitRetry(() =>
    fc.scrape(url.href, {
      formats: ["markdown", "branding", "links", "rawHtml"],
      // Keep the navbar and footer: category lists, guarantees and service
      // links live there, and main-content extraction would drop them.
      onlyMainContent: false,
      maxAge: DAY_MS,
      timeout: 60_000,
    }),
  );
  const base = doc.metadata?.sourceURL ?? url.href;
  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  const branding = doc.branding;

  // The extractor sometimes returns a favicon as "the logo"; score those as
  // icons so the HTML extractor gets a chance to find the real one.
  const isFavicon = (u: string) => /favicon|\.ico(\?|$)/i.test(u);
  const logos: LogoCandidate[] = [];
  for (const raw of [branding?.logo, branding?.images?.logo]) {
    const u = absoluteUrl(raw, base);
    if (u)
      logos.push({
        url: u,
        via: isFavicon(u) ? "favicon" : "brand extractor",
        score: isFavicon(u) ? 1 : 9,
      });
  }
  const favicon = absoluteUrl(branding?.images?.favicon ?? str(meta.favicon), base);
  if (favicon) logos.push({ url: favicon, via: "favicon", score: 1 });
  const ogImage = absoluteUrl(branding?.images?.ogImage ?? str(meta.ogImage), base);
  if (ogImage) logos.push({ url: ogImage, via: "share image", score: 0 });
  const shareImage = ogImage;

  return {
    base,
    shareImage,
    title: str(meta.title),
    description: str(meta.description) ?? str(meta.ogDescription),
    siteName: branding?.brandName ?? str(meta.ogSiteName),
    logos,
    colors: colorsFromBranding(branding),
    fonts: fontsFromBranding(branding),
    markdown: doc.markdown ?? "",
    links: doc.links ?? [],
    rawHtml: doc.rawHtml,
    styleHints: styleHintsFromBranding(branding),
  };
}

/**
 * Firecrawl's free plan allows roughly 15 requests a minute. When it says to
 * retry within a few seconds, wait once and retry; longer waits fall through
 * to the caller's fallback instead of stalling the research.
 */
export async function withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const err = error as { status?: number; details?: { retry_after_seconds?: number } };
    const wait = err.details?.retry_after_seconds;
    if (err.status !== 429 || wait === undefined || wait > 10) {
      noteFirecrawlError(error); // out of credits or rate limited: the step's summary says so
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
    return call().catch((retryError: unknown) => {
      noteFirecrawlError(retryError);
      throw retryError;
    });
  }
}

function dedupeFonts(fonts: BrandFont[]): BrandFont[] {
  const seen = new Set<string>();
  return fonts.filter((f) => {
    const key = f.family.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- branding helpers -------------------------------------------------------

const COLOR_ROLES: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  background: "Background",
  textPrimary: "Text",
  textSecondary: "Muted text",
  link: "Link",
};

function colorsFromBranding(branding?: BrandingProfile): BrandColor[] {
  const seen = new Set<string>();
  const colors: BrandColor[] = [];
  for (const [key, role] of Object.entries(COLOR_ROLES)) {
    const hex = toHex(branding?.colors?.[key]);
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      colors.push({ hex, role });
    }
  }
  return colors.slice(0, 6);
}

function fontsFromBranding(branding?: BrandingProfile): BrandFont[] {
  const families = branding?.typography?.fontFamilies;
  const entries: [string | undefined, string][] = [
    [families?.heading, "Headings"],
    [families?.primary, "Body"],
    ...(branding?.fonts ?? []).map((f): [string, string] => [f.family, "Also used"]),
  ];

  const seen = new Set<string>();
  const fonts: BrandFont[] = [];
  for (const [raw, role] of entries) {
    const family = cleanFontFamily(raw);
    if (family && !seen.has(family.toLowerCase())) {
      seen.add(family.toLowerCase());
      fonts.push({ family, role });
    }
  }
  return fonts.slice(0, 3);
}

function styleHintsFromBranding(branding?: BrandingProfile): string | undefined {
  if (!branding) return undefined;
  const hints = [
    branding.personality &&
      `personality: ${branding.personality.tone}, ${branding.personality.energy} energy, audience "${branding.personality.targetAudience}"`,
    branding.tone?.voice && `voice: ${branding.tone.voice}`,
    branding.colorScheme && `color scheme: ${branding.colorScheme}`,
  ].filter(Boolean);
  return hints.length ? hints.join("; ") : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
