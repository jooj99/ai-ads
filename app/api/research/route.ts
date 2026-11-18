import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

import { saveResearch, setCampaignStatus } from "@/lib/campaigns";
import { runResearch } from "@/lib/research/pipeline";
import {
  STEP_ORDER,
  type BrandKit,
  type ResearchNotice,
  type ResearchStep,
  type ResearchUIMessage,
} from "@/lib/research/types";

// Firecrawl renders pages and the model reads the whole catalog; allow up to two minutes.
export const maxDuration = 120;

/**
 * POST { messages, campaignId } from useChat. The last user message's text
 * is the store URL. The response streams `data-step`, `data-brandKit` and
 * `data-notice` parts as research runs; when it ends, the final state is
 * saved to the campaign so a reload shows it without researching again.
 */
export async function POST(req: Request) {
  const { messages, campaignId } = (await req.json()) as {
    messages?: ResearchUIMessage[];
    campaignId?: string;
  };
  const lastUser = messages?.findLast((m) => m.role === "user");
  const input = lastUser?.parts.find((p) => p.type === "text")?.text.slice(0, 2_000) ?? "";

  const stream = createUIMessageStream<ResearchUIMessage>({
    async execute({ writer }) {
      writer.write({ type: "start" });

      const steps = new Map<string, ResearchStep>();
      let kit: BrandKit | null = null;
      let notice: ResearchNotice | null = null;

      if (campaignId) await setCampaignStatus(campaignId, "researching").catch(logSaveError);

      await runResearch(input, {
        step: (step) => {
          steps.set(step.id, step);
          writer.write({ type: "data-step", id: step.id, data: step });
        },
        kit: (next) => {
          kit = next;
          writer.write({ type: "data-brandKit", id: "brand-kit", data: next });
        },
        notice: (next) => {
          notice = next;
          writer.write({ type: "data-notice", id: "notice", data: next });
        },
      });

      if (campaignId) {
        const finalKit = kit as BrandKit | null;
        const failed = !finalKit || (notice as ResearchNotice | null)?.level === "error";
        // A run costs ~20–80s of scraping and model calls; don't lose it to a
        // network blip. If every attempt fails the campaign stays "researching",
        // and opening it again re-runs research.
        await withRetry(() =>
          saveResearch(campaignId, {
            kit: finalKit,
            steps: STEP_ORDER.map((id) => steps.get(id)).filter((s): s is ResearchStep => Boolean(s)),
            notice,
            status: failed ? "research_failed" : "ready",
          }),
        ).catch(logSaveError);
      }

      writer.write({ type: "finish" });
    },
    onError: (error) => {
      console.error("[research] stream failed", error);
      return "Research failed unexpectedly. Please try again.";
    },
  });

  return createUIMessageStreamResponse({ stream });
}

async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

function logSaveError(error: unknown) {
  console.error("[research] saving to the campaign failed", error);
}
