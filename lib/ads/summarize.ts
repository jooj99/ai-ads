import "server-only";

import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { GATEWAY_CACHING } from "@/lib/ai-caching";

/**
 * Describes what an edit actually changed, by looking at the ad before and
 * after (not by repeating the requests: the model may have done more, less,
 * or something different). The result is a few short past-tense bullets the
 * version shows as its "Changes" and the agent reports back. A small vision
 * model does it; override with EDIT_SUMMARY_MODEL. Never throws: [] when it
 * can't tell.
 */

export const EDIT_SUMMARY_MODEL =
  process.env.EDIT_SUMMARY_MODEL ?? process.env.OFFERING_MODEL ?? "anthropic/claude-haiku-5.5";

const schema = z.object({
  changes: z
    .array(z.string())
    .max(4)
    .describe(
      "What visibly changed from image 1 to image 2, one item per change, most important first. Past tense, at most about 10 words each, specific (what and where), e.g. 'Removed the dried flowers on the left' or 'Turned the CTA button black with white text'. Empty if nothing visible changed.",
    ),
});

/** Shrinks an ad for the model: enough to see what changed, a fraction of the bytes. */
async function small(image: Uint8Array) {
  return sharp(image).resize(768, 768, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
}

export async function summarizeEdit(input: {
  before: Uint8Array;
  after: Uint8Array;
  /** What was asked for (pinned comments, the agent's instruction), as context. */
  requests: string[];
}): Promise<string[]> {
  try {
    const [before, after] = await Promise.all([small(input.before), small(input.after)]);
    const { output } = await generateText({
      model: EDIT_SUMMARY_MODEL,
      providerOptions: GATEWAY_CACHING,
      instructions:
        "You compare two versions of an image ad and list what changed. Describe only differences you can see between them; ignore tiny rendering differences. Don't restate the requests: if one wasn't done, leave it out; if something else changed, include it.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Image 1: the ad before the edit." },
            { type: "file", data: before, mediaType: "image/jpeg" },
            { type: "text", text: "Image 2: the ad after the edit." },
            { type: "file", data: after, mediaType: "image/jpeg" },
            {
              type: "text",
              text: `What was asked for (context only):\n${input.requests.map((r) => `- ${r}`).join("\n") || "- (nothing specific)"}\n\nList what changed from image 1 to image 2.`,
            },
          ],
        },
      ],
      output: Output.object({ schema }),
    });
    return output.changes.map((c) => c.trim()).filter(Boolean).slice(0, 4);
  } catch (error) {
    console.error("[ads] summarizing the edit failed", error);
    return [];
  }
}
