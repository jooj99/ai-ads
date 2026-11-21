import "server-only";

import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";

import { GATEWAY_CACHING } from "@/lib/ai-caching";
import { withStallRetry } from "@/lib/ai-retry";
import { saveProductNotes } from "@/lib/campaigns";
import { RESEARCH_MODEL } from "@/lib/research/insights";
import type { CatalogItem, ProductNotes } from "@/lib/research/types";
import { isPublicHttpUrl } from "@/lib/research/url";
import { publicFetch } from "@/lib/research/public-fetch";

/**
 * Product notes: a vision model looks at a product's own photos and its
 * description once and writes down what it is, its parts (what each looks
 * like, where it sits, how it attaches), how it's used, and what it doesn't
 * have. Image models otherwise guess from a photo or two: they reinvent
 * parts and stage the product in ways it can't work. The notes go into the
 * ad brief (lib/ads/brief.ts), the idea playbook (through the agent's
 * catalog list) and the ad check (lib/ads/verify.ts).
 *
 * Written the first time a product is needed (chosen for ideas, or put in an
 * ad), saved on its catalog row, and written again only when its first photo
 * changes. Never throws: a product without notes is used as before.
 */

/** Photos shown to the model per product. */
const PHOTOS = 4;
/** Products written at a time. */
const CONCURRENCY = 3;

const notesSchema = z.object({
  what: z.string().describe("What the product is, in one plain sentence."),
  parts: z
    .array(z.string())
    .max(8)
    .describe(
      "Each visible part, one per entry: what it looks like (shape, material, color or print, size relative to the rest), where it sits and how it attaches. Only parts the photos show.",
    ),
  use: z
    .string()
    .describe(
      "How it's held, worn, attached or used, as the photos and description show it: which part the hand or body touches, what goes where. If the photos don't show it in use, the plainest use the description supports.",
    ),
  never: z
    .array(z.string())
    .max(6)
    .describe(
      "Things an image model might wrongly add or do with this product that the photos rule out: parts it doesn't have, shapes or attachments it doesn't use, ways it isn't used. Concrete, one per entry.",
    ),
});

/** What the store is, so a product is read as what this store sells (a strap from a phone-case shop is a phone strap). */
export type StoreContext = { brand: string; sells?: string };

export async function writeProductNotes(product: CatalogItem, store?: StoreContext): Promise<ProductNotes | null> {
  const urls = product.images.filter(isPublicHttpUrl).slice(0, PHOTOS);
  if (!urls.length) return null;
  try {
    const photos = (await Promise.all(urls.map(photo))).filter((p): p is Uint8Array => p !== null);
    if (!photos.length) return null;
    const { output } = await withStallRetry("the product notes", (abortSignal) =>
      generateText({
        model: RESEARCH_MODEL,
        providerOptions: GATEWAY_CACHING,
        abortSignal,
        maxRetries: 0,
        instructions:
          "You describe a product exactly as its own photos show it, for an image model that will put it in ads and a checker that compares ads with it. Be concrete and physical. Never guess a part or a use the photos, description and store don't support; when something isn't clear, say so plainly rather than inventing.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  store ? `Store: ${store.brand}${store.sells ? `. ${store.sells.slice(0, 400)}` : ""}` : "",
                  `Product: ${product.title}`,
                  product.typeName ?? product.productType ? `Type: ${product.typeName ?? product.productType}` : "",
                  product.productType && product.typeName && product.productType !== product.typeName
                    ? `Listed as: ${product.productType}`
                    : "",
                  product.tags?.length ? `Tags: ${product.tags.slice(0, 12).join(", ")}` : "",
                  product.description ? `Description: ${product.description.slice(0, 1200)}` : "No description.",
                  `Its photos follow (${photos.length}).`,
                  "Read it as something this store sells, used with what the store sells. If the photos and text don't show how it's used or attached, say exactly that in use, and don't invent a different kind of product or use.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
              ...photos.map((data) => ({ type: "file" as const, data, mediaType: "image/jpeg" })),
            ],
          },
        ],
        output: Output.object({ schema: notesSchema }),
      }),
    );
    return { ...output, from: product.images[0] };
  } catch (error) {
    console.error(`[research] writing notes for ${product.title} failed`, error);
    return null;
  }
}

/**
 * Notes for these products, writing (and saving) any that are missing or
 * were read from other photos. Returns the products with their notes.
 */
export async function ensureProductNotes(
  campaignId: string,
  products: CatalogItem[],
  store?: StoreContext,
): Promise<CatalogItem[]> {
  const stale = products.filter((p) => p.images.length && (!p.notes || p.notes.from !== p.images[0]));
  if (!stale.length) return products;
  const written = new Map<string, ProductNotes>();
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    await Promise.all(
      stale.slice(i, i + CONCURRENCY).map(async (p) => {
        const notes = await writeProductNotes(p, store);
        if (!notes) return;
        written.set(p.id, notes);
        await saveProductNotes(campaignId, p.id, notes).catch((error) =>
          console.error(`[research] saving notes for ${p.title} failed`, error),
        );
      }),
    );
  }
  return products.map((p) => (written.has(p.id) ? { ...p, notes: written.get(p.id) } : p));
}

/** The notes as lines for a prompt: "what — parts — use — never". */
export function notesText(p: { title: string; notes?: ProductNotes }): string | undefined {
  const n = p.notes;
  if (!n) return undefined;
  return [
    `${p.title}: ${n.what}`,
    n.parts.length ? `Parts: ${n.parts.join("; ")}.` : "",
    `Use: ${n.use}`,
    n.never.length ? `Never: ${n.never.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function photo(url: string): Promise<Uint8Array | null> {
  try {
    const res = await publicFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return new Uint8Array(
      await sharp(bytes).resize(768, 768, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer(),
    );
  } catch {
    return null;
  }
}

/** The store context for notes, from the brand kit. */
export function storeContext(kit: { name?: string; domain: string; valueProposition?: string; offeringReason?: string }): StoreContext {
  return { brand: kit.name ?? kit.domain, sells: kit.offeringReason ?? kit.valueProposition };
}
