import type { BrandKit, CatalogItem } from "@/lib/research/types";

/**
 * Turns the brand kit, one headline and the chosen hero products into the
 * input for Nano Banana Pro edit (fal-ai/nano-banana-pro/edit):
 *
 * - `imageUrls`: the products' real photos (and the logo when it's a raster
 *   image). The model edits from these, so the ad shows the actual product.
 * - `systemPrompt`: the standing rules for every ad (real products only,
 *   exact copy, 9:16 safe zones).
 * - `prompt`: this ad's brief as JSON (headline, CTA, products by image
 *   number, colors, fonts, voice), so each brand fact is a labeled field
 *   rather than prose the model might blur.
 *
 * Everything here is scraped or edited brand data; nothing is invented.
 */

export type AdBriefInput = {
  kit: BrandKit;
  headline: string;
  cta: string;
  products: CatalogItem[];
  /** The brand logo as a PNG fal can fetch (see brand-assets.ts). */
  logoUrl?: string;
  /** A solid square per brand color, with its hex, role and what it's for. */
  swatches?: { url: string; hex: string; role: string; use: string }[];
  /** Images the user attached in chat, as fetchable URLs, with how to use each. */
  references?: { url: string; use: string }[];
};

export type AdBrief = {
  systemPrompt: string;
  prompt: string;
  imageUrls: string[];
};

/** Photos per product and in total; the model accepts up to 14 images in all. */
const PHOTOS_PER_PRODUCT = 2;
const MAX_PRODUCT_PHOTOS = 6;
const MAX_IMAGES = 14;

export const AD_SYSTEM_PROMPT = `You are a senior performance-marketing art director. You make finished, ready-to-run full-screen 9:16 portrait image ads for mobile social feeds and stories.

Rules for every ad:
- The attached product photos show the brand's real products. Feature those exact products: keep their shape, colors, materials, prints and any logos on them, and every part where it is and as it attaches (a loop, strap, grip, handle or button stays in the same place and form). Show them held or used the way the photos show them working. Never invent a product, change its design, or add products that aren't in the photos. You may restage them (new background, lighting, angle, hands holding them, props) as long as the product itself is unchanged.
- Never invent anything the brand sells or shows: no made-up products, packaging, devices, app screens, dashboards, charts, maps or data. Every product, screen or interface in the ad must come from the attached photos, shown as it is. For a service or software brand, a screen may only be one of the attached screenshots, unchanged; if none is attached, show people, places or the outcome of the service instead of an interface.
- Render the headline and the call-to-action exactly as given, spelled exactly, each once. The headline is the most prominent text. The call-to-action is a clear button. Add no other words, prices, discounts, claims or slogans, except the brand name or logo.
- The attached brand logo is the real logo: reproduce it exactly as in its image (same shape, letterforms, colors and proportions), small and legible. Never invent, restyle or simplify it, and don't add a separate wordmark it doesn't have. Its image may sit on a plain white or black background added for visibility: that background isn't part of the logo, so don't draw a box or panel behind it.
- Brand color swatches are solid squares of the exact brand colors. Use those exact colors, each where the brief assigns it (match the swatch, not a similar shade). The swatches are references only: never draw them.
- Images marked as references from the user are guides they supplied: use each exactly as its note says (add that object, match that style, use that background). They don't replace the product photos unless the note says so.
- Set type in the style of the brand fonts listed (match their weight, width and feel).
- Keep all text inside the safe zone: nothing in the top 14% or bottom 20% of the frame, and at least 6% from the sides.
- Match the brand's voice in the art direction. One clear focal point, high contrast, legible on a phone at a glance.`;

export function buildAdBrief({
  kit,
  headline,
  cta,
  products,
  logoUrl,
  swatches = [],
  references = [],
}: AdBriefInput): AdBrief {
  const imageUrls: string[] = [];
  const productEntries = products.map((product) => {
    const photos: number[] = [];
    for (const url of product.images.slice(0, PHOTOS_PER_PRODUCT)) {
      if (imageUrls.length >= MAX_PRODUCT_PHOTOS || imageUrls.includes(url)) continue;
      imageUrls.push(url);
      photos.push(imageUrls.length); // 1-based, as the model sees them
    }
    return {
      name: product.title,
      ...(product.typeName && { type: product.typeName }),
      ...(product.price && { price_for_reference_only: product.price }),
      ...(product.description && { description: clip(product.description, 280) }),
      photos: photos.map((n) => `image ${n}`),
    };
  });
  // Then the logo, the user's references and the color swatches, while
  // there's room (the swatch colors are also named by hex in the brief).
  const add = (url: string) => (imageUrls.length < MAX_IMAGES ? `image ${imageUrls.push(url)}` : undefined);
  const logoImage = logoUrl ? add(logoUrl) : undefined;
  const referenceEntries = references.flatMap((r) => {
    const image = add(r.url);
    return image ? [{ image, use: r.use }] : [];
  });
  const swatchImage = new Map(swatches.map((s) => [s.hex, add(s.url)]));

  const brand = kit.name ?? kit.domain;
  const brief = {
    format: "Full-screen 9:16 portrait image ad for mobile social feeds and stories, full-bleed, no borders or device frames.",
    brand: {
      name: brand,
      ...(kit.tagline && { tagline: kit.tagline }),
      ...(kit.valueProposition && { value_proposition: clip(kit.valueProposition, 400) }),
      ...(logoImage && { logo: logoImage }),
    },
    headline: { text: headline, render: "Exactly this text, once, as the largest type." },
    call_to_action: { text: cta, render: "Exactly this text, once, as a button." },
    ...(kit.offering === "services" && {
      services_note:
        "This brand sells a service, not physical goods. The attached photos are real screenshots or photos of the service: show them unchanged. Do not draw any other screen, dashboard, app interface, chart or data, and do not invent a physical product.",
    }),
    hero_products: productEntries,
    // Each color assigned to a job, with its swatch image when one was sent.
    colors: kit.colors.map((c) => {
      const swatch = swatches.find((s) => s.hex === c.hex.toUpperCase());
      return {
        hex: c.hex.toUpperCase(),
        role: c.role,
        ...(swatch && { use_for: swatch.use }),
        ...(swatch && swatchImage.get(swatch.hex) && { swatch: swatchImage.get(swatch.hex) }),
      };
    }),
    typography: kit.fonts.map((f) => ({ font_family: f.family, role: f.role })),
    voice: {
      ...(kit.voice?.traits?.length && { traits: kit.voice.traits }),
      ...(kit.voice?.summary && { description: clip(kit.voice.summary, 300) }),
      ...(kit.voice?.sampleLine && { sample_line_for_tone_only: kit.voice.sampleLine }),
    },
    ...(kit.audience?.segments?.length && { audience: kit.audience.segments }),
    ...(referenceEntries.length && { user_references: referenceEntries }),
  };

  const imageList = [
    ...productEntries.flatMap((p) => p.photos.map((img) => `${img}: product photo of ${p.name}`)),
    ...(logoImage ? [`${logoImage}: the ${brand} logo (the real one; reproduce it exactly)`] : []),
    ...referenceEntries.map((r) => `${r.image}: a reference from the user (${r.use})`),
    ...swatches.flatMap((s) => {
      const image = swatchImage.get(s.hex);
      return image ? [`${image}: brand color swatch ${s.hex} (${s.role}), a solid square of that exact color`] : [];
    }),
  ];

  const prompt = `Create the ad described by this brief. Attached images, in order:
${imageList.map((line) => `- ${line}`).join("\n")}

Brief (JSON):
${JSON.stringify(brief, null, 2)}

Only the headline and the call-to-action appear as text (plus the brand name or logo). Prices and sample lines are context, not copy.`;

  return { systemPrompt: AD_SYSTEM_PROMPT, prompt, imageUrls };
}

function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
