import type { BrandColor, BrandFont } from "./types";
import { absoluteUrl, isPublicHttpUrl } from "./url";

/**
 * Reads brand signals straight out of a page's HTML and CSS. This backs up
 * Firecrawl's brand extractor: it runs on Firecrawl's rendered HTML when we
 * have it (so bot-protected sites still work) or on HTML we fetch ourselves,
 * and fills in whatever the extractor missed.
 */

export type LogoCandidate = {
  url: string;
  /** Where it was found, shown to the user, e.g. "CSS mask". */
  via: string;
  /** Confidence; 5 or more counts as a real logo rather than an icon or photo. */
  score: number;
};

export const REAL_LOGO_SCORE = 5;

export type HtmlSignals = {
  title?: string;
  /** The page's og:image. */
  shareImage?: string;
  description?: string;
  siteName?: string;
  logos: LogoCandidate[];
  colors: BrandColor[];
  fonts: BrandFont[];
  /** Real names for internal font aliases, from @font-face file names. */
  fontAliases: Map<string, string>;
  text: string;
  links: string[];
};

const UA = "Mozilla/5.0 (compatible; PloyAdsResearch/1.0)";
export const MAX_STYLESHEETS = 4;
const MAX_CSS_BYTES = 800_000;

/** Header icons share the logo's techniques (masks, inline SVG); these words mark them. */
const ICON_WORDS =
  /\b(icon|cart|bag|basket|search|profile|account|user|sign-?in|login|favou?rites?|wishlist|heart|menu|hamburger|close|arrow|chevron|caret|play|pause|facebook|instagram|twitter|tiktok|youtube|pinterest|linkedin|social|star|rating|check)\b/i;
const LOGO_WORDS = /logo|wordmark|brand-?mark/i;

/** Fetches the page HTML directly (the fallback when Firecrawl is unavailable). */
export async function fetchHtml(url: URL): Promise<{ html: string; base: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`The site returned ${res.status}`);
  return { html: (await res.text()).slice(0, 3_000_000), base: res.url };
}

/** Extracts signals from the HTML plus up to four of its linked stylesheets. */
export async function collectHtmlSignals(
  html: string,
  base: string,
  sheets?: Stylesheet[],
): Promise<HtmlSignals> {
  const css = (sheets ?? (await fetchStylesheets(html, base))).map((s) => s.css).join("\n");
  return extractHtmlSignals(html, base, css);
}

/** A stylesheet and the URL it came from (relative url()s resolve against it). */
export type Stylesheet = { href: string; css: string };

/** How many stylesheets to read when looking for @font-face rules (big sites split CSS into dozens). */
export const MAX_FONT_STYLESHEETS = 40;
const MAX_IMPORTS = 10;
const FETCH_CONCURRENCY = 8;

/**
 * A browser's user agent and headers for fetching a site's own assets. Some
 * CDNs refuse requests that don't look like a page loading its stylesheets
 * or fonts (apple.com answers a bare request for its font CSS with a 404).
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function assetHeaders(kind: "style" | "font", url: string, referer: string): Record<string, string> {
  const site = (u: string) => new URL(u).hostname.split(".").slice(-2).join(".");
  return {
    "user-agent": BROWSER_UA,
    accept: kind === "style" ? "text/css,*/*;q=0.1" : "font/woff2,font/woff,*/*;q=0.1",
    "accept-language": "en-US,en;q=0.9",
    referer,
    ...(kind === "font" && { origin: new URL(referer).origin }),
    "sec-fetch-dest": kind,
    "sec-fetch-mode": kind === "style" ? "no-cors" : "cors",
    "sec-fetch-site":
      new URL(url).origin === new URL(referer).origin ? "same-origin" : site(url) === site(referer) ? "same-site" : "cross-site",
  };
}

/** Stylesheets that are mostly fonts (a font service, a fonts.css), read first. */
function fontish(href: string) {
  return /font|typekit|typography|typeface/i.test(href);
}

/**
 * The page's stylesheets, fetched like a browser would. The first `limit`
 * (the site's own first, in page order), plus any font stylesheets beyond
 * that, plus what they @import. Missing or blocked sheets are skipped.
 */
export async function fetchStylesheets(html: string, base: string, limit = MAX_STYLESHEETS): Promise<Stylesheet[]> {
  const host = new URL(base).hostname.replace(/^www\./, "");
  const hrefs = unique(
    [...html.matchAll(/<link\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => /rel=["']?stylesheet/i.test(tag) || /as=["']?style/i.test(tag))
      .map((tag) => absoluteUrl(attr(tag, "href"), base))
      .filter((href): href is string => Boolean(href) && isPublicHttpUrl(href!)),
  );
  // Prefer the site's own stylesheets over third-party widgets.
  hrefs.sort((a, b) => Number(!sameSite(a, host)) - Number(!sameSite(b, host)));
  const chosen = [...hrefs.slice(0, limit), ...hrefs.slice(limit).filter(fontish).slice(0, 5)];

  const get = async (href: string, referer: string): Promise<Stylesheet | null> => {
    try {
      const res = await fetch(href, { headers: assetHeaders("style", href, referer), signal: AbortSignal.timeout(6_000) });
      if (!res.ok) return null;
      return { href: res.url || href, css: (await res.text()).slice(0, MAX_CSS_BYTES) };
    } catch {
      return null;
    }
  };
  const sheets = (await mapLimit(chosen, FETCH_CONCURRENCY, (href) => get(href, base))).filter(
    (s): s is Stylesheet => s !== null,
  );

  // One level of @import (font services are often imported: Typekit, Google Fonts).
  const seen = new Set([...chosen, ...sheets.map((s) => s.href)]);
  const imports = unique(
    sheets.flatMap((sheet) =>
      [...sheet.css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi)].map((m) =>
        absoluteUrl(m[1], sheet.href),
      ),
    ),
  )
    .filter((href) => isPublicHttpUrl(href) && !seen.has(href))
    .slice(0, MAX_IMPORTS);
  const imported = (await mapLimit(imports, FETCH_CONCURRENCY, (href) => get(href, base))).filter(
    (s): s is Stylesheet => s !== null,
  );
  return [...sheets, ...imported];
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Pure extraction, separated from fetching so it can be tested on fixtures. */
export function extractHtmlSignals(html: string, base: string, externalCss = ""): HtmlSignals {
  const origin = new URL(base).origin;
  const siteName = decode(
    metaContent(html, "og:site_name") ?? metaContent(html, "application-name"),
  );
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n");
  const allCss = `${inlineCss}\n${externalCss}`;

  const isHomeLink = (context: string) =>
    new RegExp(`href=["'](?:/|${escapeRegExp(origin)}/?)["']`, "i").test(context);
  const namesBrand = (context: string) =>
    LOGO_WORDS.test(context) ||
    (siteName
      ? new RegExp(`aria-label=["']${escapeRegExp(siteName)}["']`, "i").test(context)
      : false);

  const logos: LogoCandidate[] = [];
  const add = (raw: string | undefined, via: string, score: number) => {
    const url = raw?.startsWith("data:image/svg") ? raw : absoluteUrl(decode(raw), base);
    if (url) logos.push({ url, via, score });
  };

  // 1. Structured data: the site's own declaration of its logo.
  const ld =
    html.match(/"logo"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/"logo"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/)?.[1];
  add(ld, "structured data", 10);

  // 2. <img> tags that call themselves a logo.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src =
      attr(tag, "src") ?? attr(tag, "data-src") ?? parseSrcset(decode(attr(tag, "srcset")))[0];
    if (!src) continue;
    const context = html.slice(Math.max(0, m.index - 400), m.index);
    const inSrc = LOGO_WORDS.test(src);
    const inAttrs = LOGO_WORDS.test(tag.replace(src, ""));
    const isAlt = siteName ? attr(tag, "alt")?.toLowerCase() === siteName.toLowerCase() : false;
    if (!inSrc && !inAttrs && !isAlt) continue;
    let score = inSrc ? 8 : 7;
    if (isHomeLink(context) || /<header\b/i.test(context)) score += 2;
    if (ICON_WORDS.test(src) && !inSrc) score -= 8;
    add(src, "logo image", score);
  }

  // 3. CSS masks and backgrounds: logos drawn as `mask-image: url(logo.svg)`
  //    (recolorable) or as background images, inline or in stylesheets.
  const cssImage =
    /(-webkit-mask(?:-image)?|mask(?:-image)?|background(?:-image)?)\s*:\s*[^;{}]*?url\(\s*(?:&quot;|["'])?([^"')&]+(?:&amp;[^"')&]+)*)(?:&quot;|["'])?\s*\)/gi;
  const scoreCssImage = (kind: string, url: string, context: string, home: boolean) => {
    const isMask = /mask/i.test(kind);
    let score = isMask ? 2 : 0;
    if (LOGO_WORDS.test(url)) score += 6;
    if (namesBrand(context)) score += 4;
    if (home) score += 3;
    if (!LOGO_WORDS.test(url) && (ICON_WORDS.test(url) || ICON_WORDS.test(context))) score -= 8;
    return { score, via: isMask ? "CSS mask" : "CSS background" };
  };
  // Inline styles: the context is the surrounding markup (the element and its link).
  for (const m of html.matchAll(cssImage)) {
    const context = html.slice(Math.max(0, m.index - 400), m.index + 80);
    const { score, via } = scoreCssImage(m[1], m[2], context, isHomeLink(context));
    if (score >= REAL_LOGO_SCORE) add(m[2], via, score);
  }
  // Stylesheets: the context is the rule's selector, e.g. `.header__logo`.
  for (const m of externalCss.matchAll(cssImage)) {
    const selector = externalCss.slice(0, m.index).split("}").pop()?.split("{")[0] ?? "";
    const { score, via } = scoreCssImage(m[1], m[2], selector, false);
    if (score >= REAL_LOGO_SCORE) add(m[2], via, score);
  }

  // 4. Inline <svg> logos, kept as data URIs.
  for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
    const svg = m[0];
    if (svg.length > 60_000 || /<use\b/i.test(svg) || !/<path\b/i.test(svg)) continue;
    const openTag = svg.slice(0, svg.indexOf(">") + 1);
    const context = html.slice(Math.max(0, m.index - 300), m.index) + openTag;
    if (!namesBrand(context) || ICON_WORDS.test(openTag)) continue;
    const withNs = /xmlns=/.test(openTag)
      ? svg
      : svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    add(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`,
      "inline SVG",
      isHomeLink(context) ? 9 : 6,
    );
  }

  // 5. Icons and the share image: weak fallbacks, never preferred over a logo.
  const touchIcon = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .find((tag) => /rel=["']?apple-touch-icon/i.test(tag));
  add(touchIcon ? attr(touchIcon, "href") : undefined, "app icon", 2);
  add(metaContent(html, "og:image"), "share image", 0);

  const fontAliases = fontFaceAliases(allCss);

  return {
    title: decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()),
    description: decode(metaContent(html, "og:description") ?? metaContent(html, "description")),
    shareImage: absoluteUrl(decode(metaContent(html, "og:image")), base),
    siteName,
    logos: rankLogos(logos),
    colors: colorsFromCss(allCss, html),
    fonts: fontsFromCss(allCss, html, fontAliases),
    fontAliases,
    text: textContent(html),
    links: unique(
      [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)/gi)].map((m) =>
        absoluteUrl(decode(m[1]), base),
      ),
    ),
  };
}

/** Dedupes by URL (keeping the best score) and sorts best first. */
export function rankLogos(candidates: LogoCandidate[]): LogoCandidate[] {
  const best = new Map<string, LogoCandidate>();
  for (const c of candidates) {
    const prev = best.get(c.url);
    if (!prev || c.score > prev.score) best.set(c.url, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Last resort when no logo was found: check where sites conventionally keep
 * one. Only real image responses count (SPAs answer every path with HTML).
 */
const CONVENTIONAL_LOGO_PATHS = [
  "/logo.svg",
  "/logo.png",
  "/assets/logo.svg",
  "/assets/logo.png",
  "/images/logo.svg",
  "/images/logo.png",
  "/img/logo.svg",
  "/img/logo.png",
  "/static/logo.svg",
  "/static/logo.png",
  "/assets/images/logo.svg",
  "/assets/images/logo.png",
];

export async function probeLogoPaths(origin: string): Promise<LogoCandidate | null> {
  const checks = await Promise.all(
    CONVENTIONAL_LOGO_PATHS.map(async (path) => {
      try {
        const res = await fetch(new URL(path, origin), {
          method: "HEAD",
          headers: { "user-agent": UA },
          signal: AbortSignal.timeout(5_000),
        });
        return res.ok && res.headers.get("content-type")?.startsWith("image/") ? res.url : null;
      } catch {
        return null;
      }
    }),
  );
  const index = checks.findIndex(Boolean);
  return index === -1
    ? null
    : { url: checks[index]!, via: CONVENTIONAL_LOGO_PATHS[index], score: REAL_LOGO_SCORE };
}

// --- fonts ------------------------------------------------------------------

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
]);

/** First real family in a CSS font stack: `"Exo2", sans-serif` → `Exo2`. */
export function cleanFontFamily(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const part of stack.split(",")) {
    const family = part
      .replace(/["']|!important/g, "")
      .replace(/\s+Fallback$/i, "")
      .trim();
    const lower = family.toLowerCase();
    if (!family || GENERIC_FONTS.has(lower) || lower.startsWith("var(")) continue;
    if (/icon|awesome|symbol|emoji/i.test(family)) continue;
    return family;
  }
  return undefined;
}

/** Build-tool aliases like `__Inter_6a4b1f` or `fontAbcSocial` that no human would recognize. */
export function looksInternalFont(family: string): boolean {
  return /^__/.test(family) || /^font[A-Z]/.test(family) || /_[0-9a-f]{5,}$/i.test(family);
}

/** Maps each @font-face family to a readable name taken from its font file. */
function fontFaceAliases(css: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const family = cleanFontFamily(block[1].match(/font-family\s*:\s*([^;]+)/i)?.[1]);
    const file = block[1].match(/url\(\s*["']?([^"')]+)/i)?.[1];
    if (!family || !file || aliases.has(family)) continue;
    const name = fontNameFromFile(file);
    if (name) aliases.set(family, name);
  }
  return aliases;
}

function fontNameFromFile(file: string): string | undefined {
  const stem = decodeURIComponent(file.split("?")[0].split("/").pop() ?? "")
    .replace(/\.(woff2?|ttf|otf|eot)$/i, "")
    .replace(
      /[-_.]?(thin|extralight|light|regular|book|medium|semibold|bold|extrabold|black|italic|variable|vf|wght|latin|subset|webfont|[0-9a-f]{6,})+$/gi,
      "",
    );
  if (stem.length < 3 || /^[0-9a-f-]+$/i.test(stem)) return undefined; // hashed file names
  return splitWords(stem);
}

/** A display name for an internal alias, from @font-face when possible. */
export function readableFontName(family: string, aliases: Map<string, string>): string {
  if (!looksInternalFont(family)) return family;
  const fromFile = aliases.get(family);
  if (fromFile) return fromFile;
  const stripped = family
    .replace(/^_+/, "")
    .replace(/_[0-9a-f]{5,}$/i, "")
    .replace(/^font(?=[A-Z])/, "");
  return splitWords(stripped) || family;
}

function splitWords(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function fontsFromCss(css: string, html: string, aliases: Map<string, string>): BrandFont[] {
  const declared = [
    ...`${css}\n${html}`.matchAll(/font-family\s*:\s*([^;}{"]+(?:"[^"]*"[^;}{"]*)*)/gi),
  ]
    .map((m) => cleanFontFamily(m[1]))
    .filter((f): f is string => Boolean(f));
  // Families with an @font-face are the brand's own fonts; rank them first.
  const ranked = mostFrequent(declared, 10).sort(
    (a, b) => Number(aliases.has(b)) - Number(aliases.has(a)),
  );
  const seen = new Set<string>();
  const fonts: BrandFont[] = [];
  for (const family of ranked) {
    const name = readableFontName(family, aliases);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    fonts.push({ family: name, role: fonts.length === 0 ? "Primary" : "Secondary" });
    if (fonts.length === 2) break;
  }
  return fonts;
}

// --- colors -----------------------------------------------------------------

const COLOR_VAR_ROLES: [RegExp, string][] = [
  [/primary|brand/, "Primary"],
  [/secondary/, "Secondary"],
  [/accent|highlight/, "Accent"],
];

function colorsFromCss(css: string, html: string): BrandColor[] {
  const colors: BrandColor[] = [];
  const seen = new Set<string>();
  const push = (hex: string | undefined, role: string) => {
    if (hex && !seen.has(hex) && colors.length < 6) {
      seen.add(hex);
      colors.push({ hex, role });
    }
  };

  // Design tokens like --color-primary: #1050d0 say what each color is for.
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/gi)) {
    const role = COLOR_VAR_ROLES.find(([pattern]) => pattern.test(m[1].toLowerCase()))?.[1];
    if (role) push(toHex(m[2]), role);
  }
  push(toHex(metaContent(html, "theme-color")), "Theme");

  // Then the most-used non-neutral colors.
  const used = [...css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)]
    .map((m) => toHex(m[0]))
    .filter((hex): hex is string => Boolean(hex) && !isNeutral(hex!));
  for (const hex of mostFrequent(used, 6)) push(hex, "Accent");
  return colors;
}

function isNeutral(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 12; // greys, black, white
}

/** Normalizes #rgb, #rrggbb(aa) and rgb()/rgba() to uppercase #RRGGBB. */
export function toHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.slice(0, 6);
    return `#${full.toUpperCase()}`;
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] ? parseFloat(rgb[4]) / (rgb[4].endsWith("%") ? 100 : 1) : 1;
    if (alpha < 0.5) return undefined;
    return `#${rgb
      .slice(1, 4)
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }
  return undefined;
}

// --- helpers ----------------------------------------------------------------

function metaContent(html: string, key: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase() === key)
      return attr(tag, "content");
  }
  return undefined;
}

function attr(tag: string, name: string): string | undefined {
  return tag
    .match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    ?.slice(1)
    .find((v) => v !== undefined);
}

function textContent(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return stripTags(body).slice(0, 20_000);
}

function stripTags(html: string): string {
  return (
    decode(
      html.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "),
    ) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A page's photos from markup: the share image, then every <img> and
 * <picture><source> (largest srcset entry), in page order. Fragments of
 * broken srcset splits are dropped.
 */
export function imagesFromHtml(html: string, base: string): string[] {
  const og = absoluteUrl(decode(metaContent(html, "og:image")), base);
  const tags = [...html.matchAll(/<(?:img|source)\b[^>]*>/gi)].map((m) => {
    const tag = m[0];
    const best = parseSrcset(decode(attr(tag, "srcset") ?? attr(tag, "data-srcset")))[0];
    return absoluteUrl(best ?? decode(attr(tag, "src") ?? attr(tag, "data-src")), base);
  });
  return unique([og, ...tags]).filter((src) => !isImageFragment(src, base));
}

/**
 * srcset → candidate URLs, largest first. Candidates are separated by a comma
 * plus whitespace ("a.jpg 1x, b.jpg 2x") or a comma right after a descriptor
 * ("a.jpg 600w,b.jpg 1200w"). Never split on other commas: image CDNs put
 * them inside URLs (static.nike.com/a/images/c_limit,w_318,f_auto/…).
 */
export function parseSrcset(srcset: string | undefined): string[] {
  if (!srcset) return [];
  return srcset
    .split(/,\s+/)
    .flatMap((piece) => piece.split(/(?<=\s\d+(?:\.\d+)?[wx]),/))
    .map((entry) => {
      const [url, descriptor = ""] = entry.trim().split(/\s+/);
      const n = parseFloat(descriptor) || 0;
      return { url, size: descriptor.endsWith("x") ? n * 1_000 : n };
    })
    .filter((c) => c.url)
    .sort((a, b) => b.size - a.size)
    .map((c) => c.url);
}

/**
 * True for the debris of a srcset split on commas inside a CDN URL: a piece
 * like "fl_layer_apply/…/SHOE.png" resolved against the page, giving
 * www.nike.com/w/fl_layer_apply/… — a page URL, not an image. Firecrawl's
 * own `images` list contains these, so every image list is checked.
 */
export function isImageFragment(src: string, pageUrl: string): boolean {
  try {
    const url = new URL(src);
    if (url.hostname !== new URL(pageUrl).hostname) return false;
    return url.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 3)
      .some((segment) => segment.includes(",") || /^[a-z]{1,3}_[\w.:-]+$/i.test(segment));
  } catch {
    return true;
  }
}

// --- navbar and footer ------------------------------------------------------

export type LayoutLink = { text: string; url: string; area: "nav" | "footer" };

export type LayoutSections = {
  /** The navbar's link labels, e.g. "Eyeglasses · Sunglasses · Contacts · Eye exams". */
  navigation: string;
  /** The footer's text: policies, guarantees, secondary categories, contact. */
  footer: string;
  links: LayoutLink[];
};

const MAX_SECTION_CHARS = 3_000;

/**
 * The navbar and footer carry what main-content extraction drops: the full
 * category list (what the brand sells), guarantees and policies, and service
 * pages. Read from `<header>`/`<nav>` and `<footer>`.
 */
export function extractLayoutSections(html: string, base: string): LayoutSections {
  const blocks = (tag: string) =>
    [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"))].map((m) => m[0]);
  const navHtml = [...blocks("header"), ...blocks("nav")].join("\n");
  // First <footer> to the last </footer>, so nested footers stay whole.
  const footerHtml = html.match(/<footer\b[^>]*>[\s\S]*<\/footer>/i)?.[0] ?? "";

  const linksIn = (fragment: string, area: LayoutLink["area"]): LayoutLink[] =>
    [...fragment.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap((m) => {
      const url = absoluteUrl(decode(attr(m[1], "href")), base);
      const text = stripTags(m[2]) || decode(attr(m[1], "aria-label")) || "";
      return url && text.length > 0 && text.length <= 60 ? [{ text, url, area }] : [];
    });

  const seen = new Set<string>();
  const links = [...linksIn(navHtml, "nav"), ...linksIn(footerHtml, "footer")].filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  const navTexts = [...new Set(links.filter((l) => l.area === "nav").map((l) => l.text))];
  return {
    navigation: (navTexts.length ? navTexts.join(" · ") : stripTags(navHtml)).slice(
      0,
      MAX_SECTION_CHARS,
    ),
    footer: stripTags(footerHtml).slice(0, MAX_SECTION_CHARS),
    links,
  };
}

function decode(value: string | undefined): string | undefined {
  return value
    ?.replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function sameSite(link: string, host: string): boolean {
  try {
    return new URL(link).hostname.replace(/^www\./, "").endsWith(host);
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique<T>(values: (T | undefined | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

function mostFrequent(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([v]) => v);
}

// --- font files ---------------------------------------------------------------

type ParsedFontFace = {
  family: string;
  weight: [number, number];
  style: "normal" | "italic";
  url: string;
  /** The other formats listed for the same face, best first. */
  alternates: string[];
  /** Where it was declared (the stylesheet, or the page for inline styles). */
  from: string;
  latin: boolean;
};

/** Preferred font formats, best first; EOT and SVG fonts are skipped. */
const FONT_FORMATS = ["woff2", "woff", "truetype", "opentype"];

/**
 * The site's own font files for each brand font, from the @font-face rules in
 * its inline styles and stylesheets. For each font: a regular (closest to
 * 400) and a bold (closest to 700) upright file, preferring WOFF2 and the
 * Latin subset. Names are matched loosely ("Exo 2" = "Exo2"), including
 * internal aliases resolved through their file names.
 */
export function fontFilesFor(
  fonts: BrandFont[],
  html: string,
  base: string,
  sheets: Stylesheet[],
): BrandFont[] {
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const faces = [
    ...parseFontFaces(inline, base),
    ...sheets.flatMap((sheet) => parseFontFaces(sheet.css, sheet.href)),
  ];
  const aliases = fontFaceAliases([inline, ...sheets.map((s) => s.css)].join("\n"));
  const key = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "");

  return fonts.map((font) => {
    const own = faces.filter(
      (f) =>
        f.style === "normal" &&
        (key(f.family) === key(font.family) || key(readableFontName(f.family, aliases)) === key(font.family)),
    );
    if (!own.length) return font;
    const pick = (weight: number) =>
      [...own].sort(
        (a, b) =>
          distance(a.weight, weight) - distance(b.weight, weight) || Number(b.latin) - Number(a.latin),
      )[0];
    const regular = pick(400);
    const bold = pick(700);
    const files = [regular, bold]
      .filter((f, i, all) => all.findIndex((x) => x.url === f.url) === i)
      .map((f) => ({
        weight: f === regular ? clampWeight(400, f.weight) : clampWeight(700, f.weight),
        style: "normal" as const,
        source: f.url,
        referer: f.from,
        ...(f.alternates.length && { alternates: f.alternates }),
      }));
    return { ...font, files };
  });
}

function parseFontFaces(css: string, base: string): ParsedFontFace[] {
  const faces: ParsedFontFace[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = block[1];
    const family = cleanFontFamily(body.match(/font-family\s*:\s*([^;]+)/i)?.[1]);
    const src = body.match(/(?:^|;)\s*src\s*:\s*([^;]+)/i)?.[1];
    if (!family || !src) continue;
    // src lists alternatives: url(a.woff2) format("woff2"), url(a.woff) format("woff")
    const options = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/gi)]
      .map((m) => ({ url: m[1], format: (m[2] ?? formatFromUrl(m[1])).toLowerCase() }))
      .filter((o) => FONT_FORMATS.includes(o.format) && !o.url.startsWith("data:"))
      .sort((a, b) => FONT_FORMATS.indexOf(a.format) - FONT_FORMATS.indexOf(b.format));
    const urls = options
      .map((o) => absoluteUrl(o.url, base))
      .filter((u): u is string => Boolean(u) && isPublicHttpUrl(u!));
    const url = urls[0];
    if (!url) continue;
    const weights = (body.match(/font-weight\s*:\s*([^;]+)/i)?.[1] ?? "400")
      .trim()
      .split(/\s+/)
      .map((w) => (w === "normal" ? 400 : w === "bold" ? 700 : Number(w)))
      .filter((w) => Number.isFinite(w));
    const range = body.match(/unicode-range\s*:\s*([^;]+)/i)?.[1];
    faces.push({
      family,
      weight: [weights[0] ?? 400, weights[1] ?? weights[0] ?? 400],
      style: /font-style\s*:\s*(italic|oblique)/i.test(body) ? "italic" : "normal",
      url,
      alternates: urls.slice(1),
      from: base,
      // No range means the whole font; otherwise it should cover basic Latin.
      latin: !range || coversLatin(range),
    });
  }
  return faces;
}

/**
 * Whether a unicode-range includes basic Latin letters (checks "A", U+0041).
 * Handles single points, ranges and wildcards: "U+0000-00FF", "U+20-7E", "U+??".
 */
function coversLatin(range: string): boolean {
  return range.split(",").some((token) => {
    const m = token.trim().match(/^U\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i);
    if (!m) return false;
    const lo = parseInt(m[1].replace(/\?/g, "0"), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "f"), 16);
    return lo <= 0x41 && 0x41 <= hi;
  });
}

function formatFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : (ext ?? "");
}

function distance([min, max]: [number, number], weight: number) {
  return weight < min ? min - weight : weight > max ? weight - max : 0;
}

/** The weight a file renders `want` at: inside a variable range, `want` itself. */
function clampWeight(want: number, [min, max]: [number, number]) {
  return Math.min(Math.max(want, min), max);
}
