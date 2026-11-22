import "server-only";

import type { BrandKit, CatalogItem } from "@/lib/research/types";
import type { IdeaDirection } from "@/lib/agent/tools";
import { withoutEmoji } from "@/lib/copy";

/**
 * Turns the brand kit, one headline and the chosen hero products into the
 * input for Nano Banana Pro edit (fal-ai/nano-banana-pro/edit):
 *
 * - `imageUrls`: the products' real photos (and the logo when it's a raster
 *   image). The model edits from these, so the ad shows the actual product.
 * - `systemPrompt`: the standing rules for every ad (real products only,
 *   exact copy, 9:16 safe zones).
 * - `prompt`: this ad's brief as JSON (the idea's creative direction when
 *   the ad comes from one, headline, CTA, the store's link (placed where it
 *   fits the design), products by image number, colors,
 *   fonts, voice), so each brand fact is a labeled field rather than prose
 *   the model might blur.
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
  /** The picked idea this ad makes: its concept, scene and what it shows off. */
  idea?: IdeaDirection;
  /** The brand's own graphics (lib/ads/brand-assets.ts), for a brand-graphic visual. */
  brandGraphics?: { url: string; description: string }[];
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
{{PRODUCT_RULES}}
- Never invent anything the brand sells or shows: no made-up products, packaging, devices, app screens, dashboards, charts, maps or data. Every product, screen or interface in the ad must come from the attached photos, shown as it is. For a service or software brand, a screen may only be one of the attached screenshots, unchanged; if none is attached, show people, places or the outcome of the service instead of an interface.
- Render the headline and the call-to-action exactly as given, spelled exactly, each once. The headline is the most prominent text. The call-to-action is a clear button. The brand's link appears once, spelled exactly as given, placed wherever it sits most naturally in the design (inside the button, next to or under it, or elsewhere in the layout), styled to belong to the ad and legible. Add no other words, prices, discounts, claims or slogans, and no emojis or icon symbols anywhere in the image, except the brand name or logo and that link.
{{LOGO_RULE}}
- Brand color swatches are solid squares of the exact brand colors. Use those exact colors, each where the brief assigns it (match the swatch, not a similar shade). The swatches are references only: never draw them.
- Images marked as references from the user are guides they supplied: use each exactly as its note says (add that object, match that style, use that background). They don't replace the product photos unless the note says so.
- Set type in the style of the brand fonts listed (match their weight, width and feel).
- Keep all text inside the safe zone: nothing in the top 14% or bottom 20% of the frame, and at least 6% from the sides.
- Match the brand's voice in the art direction. One clear focal point, high contrast, legible on a phone at a glance.{{STYLE_RULES}}`;

/** How the product appears: shown exactly (with free staging), or not at all (its images are only a style reference). */
const PRODUCT_RULES = {
  shown: `- The attached product photos show the brand's real products. Feature those exact products: keep their shape, colors, materials, prints and any logos on them, and every part where it is and as it attaches (a loop, strap, grip, handle or button stays in the same place and form). Never invent a product, change its design, or add products that aren't in the photos.
- Each hero product's how_it_works says what it is, its parts and how they attach, how it's used and what it never has. Those are facts: draw every part as described and stage the product only in its described use; never add what "never" lists.
- Staging is free: any setting, person, pose, angle, props, light and mood the concept calls for. The product is held, worn, placed or used the way its photos and how_it_works show it working, with only the parts it really has, as they are. Be bold and specific: a real moment, not a catalog shot, unless the concept asks for one.`,
  product_graphic: `- The attached product photos show the brand's real products. Feature those exact products: keep their shape, colors, materials, prints and any logos on them, and every part where it is and as it attaches. Never invent a product, change its design, or add products that aren't in the photos. Each hero product's how_it_works lists its parts, its use and what it never has: those are facts.
- Around the real product, use the attached brand graphics as supporting elements: lift their 3D shapes, objects, patterns or illustrations into a backdrop, a frame or props around the product, as they look in those images (you may scale, rotate, crop and arrange them). They never cover, replace or change the product, and they're never turned into a product, logo, device or interface. Never copy their text, screenshots, layout or backgrounds.
- Staging is free otherwise: setting, angle, light and mood as the concept calls for.`,
  brand_graphic: `- This ad doesn't show the product. Its one visual element comes from the attached brand graphics (the brand's own art from its website): lift the 3D shapes, objects or illustrations out of them and place one to three of them large, clean and well lit on the background, as they look in those images (you may scale, rotate, crop and arrange them). Never copy the text, screenshots, layout or backgrounds of those images, and never turn a graphic into a logo, product, device or interface.`,
  none: `- This ad doesn't show the product or any picture: it's typographic. The headline, the logo, the button and the brand colors carry it, with at most a simple shape or color block.`,
};

/** The logo rule: reproduce the real one, or (when there's no usable logo file) a plain wordmark. */
const LOGO_RULES = {
  real: `- The attached brand logo is the real logo: reproduce it exactly as in its image (same shape, letterforms, colors and proportions), small and legible. Never invent, restyle or simplify it, and don't add a separate wordmark it doesn't have. Its image may sit on a plain white or black background added for visibility: that background isn't part of the logo, so don't draw a box or panel behind it.`,
  wordmark: `- No logo image is attached: set the brand name as a small, plain wordmark in the brand font. Never invent a logo mark, and never make one out of any other image.`,
};

export type AdVisual = "product" | "product_graphic" | "brand_graphic" | "none";

/** Whether this visual shows the real product (and needs its photos). */
export function showsProduct(visual: AdVisual): boolean {
  return visual === "product" || visual === "product_graphic";
}

/** Whether this visual uses the brand's graphics (kit.visuals). */
export function usesGraphics(visual: AdVisual): boolean {
  return visual === "brand_graphic" || visual === "product_graphic";
}

/** A minimal ad: a clean graphic layout instead of a photographed scene. */
const MINIMAL_RULES = `

This ad is minimal: a clean, confident graphic layout, not a photographed scene.
- Background: a plain or softly graded color from the brand palette (light or dark), lots of empty space.
- Logo small at the top. The headline very large and bold in the brand font, left-aligned or centered, the clear hero of the ad. The call-to-action as a clean button (a pill or a full-width bar near the bottom).
- At most one visual element, as the art direction says: the product cleanly cut out on the background, or one abstract graphic in the brand's visual style (3D shapes, a pattern, a simple illustration). No people, rooms, props or clutter unless the direction asks for them.
- Calm, premium and modern: think a top software brand's launch ad.`;

/** The standing rules for this ad's style, and whether the product is shown. */
export function adSystemPrompt(style: "scene" | "minimal" = "scene", visual: AdVisual = "product", hasLogo = true) {
  return AD_SYSTEM_PROMPT.replace("{{PRODUCT_RULES}}", visual === "product" ? PRODUCT_RULES.shown : PRODUCT_RULES[visual])
    .replace("{{LOGO_RULE}}", hasLogo ? LOGO_RULES.real : LOGO_RULES.wordmark)
    .replace("{{STYLE_RULES}}", style === "minimal" ? MINIMAL_RULES : "");
}

/** An idea's visual: its own field, or (older ideas) product shown or not. */
export function ideaVisual(idea?: IdeaDirection): AdVisual {
  return idea?.visual ?? (idea?.showProduct === false ? "brand_graphic" : "product");
}

export { withoutEmoji };

/** The link shown on the ad: the store's bare domain ("loopycases.com"), short enough to read on a phone. */
export function adLink(kit: Pick<BrandKit, "domain">): string | undefined {
  const host = kit.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return host || undefined;
}

/**
 * The brand font the link is set in: the body font (small text reads best in
 * it), else the first one listed. Display faces stay for the headline.
 */
function adLinkFont(kit: Pick<BrandKit, "fonts">): string | undefined {
  const fonts = kit.fonts ?? [];
  return (fonts.find((f) => /body|text|paragraph/i.test(f.role)) ?? fonts[0])?.family;
}

export function buildAdBrief({
  kit,
  headline,
  cta,
  products,
  logoUrl,
  swatches = [],
  references = [],
  idea,
  brandGraphics = [],
}: AdBriefInput): AdBrief {
  const style = idea?.style ?? "scene";
  // With no brand graphics to send, a brand-graphic ad falls back to type
  // only, and a product + graphic ad to the product alone.
  const wanted = ideaVisual(idea);
  const visual: AdVisual = brandGraphics.length
    ? wanted
    : wanted === "brand_graphic"
      ? "none"
      : wanted === "product_graphic"
        ? "product"
        : wanted;
  const showProduct = showsProduct(visual);
  // Ads never show emojis, even if the saved copy has some.
  headline = withoutEmoji(headline);
  cta = withoutEmoji(cta);
  const imageUrls: string[] = [];
  // Product photos only when the product is shown (on a software brand's pages
  // they're often customer logos and headshots, not anything to put in an ad).
  const productEntries = (showProduct ? products : []).map((product) => {
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
      ...(product.notes && {
        how_it_works: {
          what: product.notes.what,
          parts: product.notes.parts,
          use: product.notes.use,
          never: product.notes.never,
        },
      }),
      photos: photos.map((n) => `image ${n}`),
    };
  });
  // Then the logo, the user's references and the color swatches, while
  // there's room (the swatch colors are also named by hex in the brief).
  const add = (url: string) => (imageUrls.length < MAX_IMAGES ? `image ${imageUrls.push(url)}` : undefined);
  const graphicImages =
    usesGraphics(visual)
      ? brandGraphics.flatMap((g) => {
          const image = add(g.url);
          return image ? [{ image, description: g.description }] : [];
        })
      : [];
  const logoImage = logoUrl ? add(logoUrl) : undefined;
  const referenceEntries = references.flatMap((r) => {
    const image = add(r.url);
    return image ? [{ image, use: r.use }] : [];
  });
  const swatchImage = new Map(swatches.map((s) => [s.hex, add(s.url)]));

  const brand = kit.name ?? kit.domain;
  const link = adLink(kit);
  const linkFont = adLinkFont(kit);
  const brief = {
    format: "Full-screen 9:16 portrait image ad for mobile social feeds and stories, full-bleed, no borders or device frames.",
    ...(idea && {
      creative_direction: {
        style,
        visual,
        idea: idea.pitch ?? idea.concept,
        art_direction: idea.direction ?? idea.scene,
        ...(idea.showsOff && { shows_off: idea.showsOff }),
        note:
          visual === "product"
            ? "Make this concept as directed. The products stay exactly as in their photos."
            : visual === "product_graphic"
              ? "Make this concept as directed. The products stay exactly as in their photos; the attached brand graphics surround them as supporting elements."
              : visual === "brand_graphic"
              ? "Make this concept as directed. The product doesn't appear: the visual is lifted from the attached brand graphics."
              : "Make this concept as directed: typographic, no product and no picture.",
      },
    }),
    brand: {
      name: brand,
      ...(kit.tagline && { tagline: kit.tagline }),
      ...(kit.valueProposition && { value_proposition: clip(kit.valueProposition, 400) }),
      ...(logoImage && { logo: logoImage }),
    },
    headline: { text: headline, render: "Exactly this text, once, as the largest type." },
    call_to_action: { text: cta, render: "Exactly this text, once, as a button." },
    ...(link && {
      link: {
        text: link,
        ...(linkFont && { font: linkFont }),
        render: `Exactly this text, once, where it fits the design best: inside the button with the call-to-action, next to or under it, or elsewhere in the layout. ${
          linkFont
            ? `Set it in ${linkFont}, the brand font listed under typography (match its letterforms, weight and feel; never a generic default font), in a brand color`
            : "Set it in the brand's type and colors"
        }, secondary to the headline and legible on a phone.`,
      },
    }),
    ...(kit.offering === "services" && {
      services_note:
        "This brand sells a service, not physical goods. The attached photos are real screenshots or photos of the service: show them unchanged. Do not draw any other screen, dashboard, app interface, chart or data, and do not invent a physical product.",
    }),
    ...(showProduct
      ? { hero_products: productEntries }
      : { about: products.map((p) => p.title).join(", ") }),
    ...(graphicImages.length && { brand_graphics: graphicImages.map((g) => `${g.image}: ${g.description}`) }),
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
    ...graphicImages.map(
      (g) =>
        `${g.image}: a ${brand} brand graphic, ${g.description} (lift its shapes or objects for the ad's visual; ignore any text or layout in it)`,
    ),
    ...(logoImage ? [`${logoImage}: the ${brand} logo (the real one; reproduce it exactly)`] : []),
    ...referenceEntries.map((r) => `${r.image}: a reference from the user (${r.use})`),
    ...swatches.flatMap((s) => {
      const image = swatchImage.get(s.hex);
      return image ? [`${image}: brand color swatch ${s.hex} (${s.role}), a solid square of that exact color`] : [];
    }),
  ];

  const prompt = `${idea ? `Make the ad concept "${idea.title}" described by this brief.` : "Create the ad described by this brief."} Attached images, in order:
${imageList.map((line) => `- ${line}`).join("\n")}

Brief (JSON):
${JSON.stringify(brief, null, 2)}

Only the headline and the call-to-action appear as text (plus the brand name or logo). Prices and sample lines are context, not copy.`;

  return { systemPrompt: adSystemPrompt(style, visual, Boolean(logoImage)), prompt, imageUrls };
}

function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
