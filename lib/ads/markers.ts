import "server-only";

import sharp from "sharp";

/**
 * Draws numbered pins on an ad, one per comment, at the spots the user
 * clicked. The edit sends this marked-up copy next to the clean ad so the
 * model can see exactly where each requested change applies (a position in
 * words alone is vague). The model is told never to draw the pins.
 */
export async function drawMarkers(image: Uint8Array, pins: { n: number; x: number; y: number }[]): Promise<Buffer> {
  const { width = 1080, height = 1920 } = await sharp(image).metadata();
  const r = Math.round(width * 0.032);
  const circles = pins
    .map(({ n, x, y }) => {
      const cx = Math.round(x * width);
      const cy = Math.round(y * height);
      return `<g>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.9}" fill="none" stroke="#FF2D55" stroke-width="${Math.max(3, r * 0.16)}" />
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#FF2D55" stroke="#FFFFFF" stroke-width="${Math.max(2, r * 0.14)}" />
  <text x="${cx}" y="${cy}" dy="0.36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(r * 1.15)}" fill="#FFFFFF">${n}</text>
</g>`;
    })
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${circles}</svg>`;
  return sharp(image)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
