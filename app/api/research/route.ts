import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

import { runResearch } from "@/lib/research/pipeline";
import type { ResearchUIMessage } from "@/lib/research/types";

// Firecrawl renders the page and the model reads the whole catalog; allow up to two minutes.
export const maxDuration = 120;

/**
 * POST { messages } from useChat. The last user message's text is the store
 * URL; the response is a UI message stream of `data-step`, `data-brandKit`
 * and `data-notice` parts that the client renders as they arrive.
 */
export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages?: ResearchUIMessage[] };
  const lastUser = messages?.findLast((m) => m.role === "user");
  const input =
    lastUser?.parts.find((p) => p.type === "text")?.text.slice(0, 2_000) ?? "";

  const stream = createUIMessageStream<ResearchUIMessage>({
    async execute({ writer }) {
      writer.write({ type: "start" });
      await runResearch(input, {
        step: (step) => writer.write({ type: "data-step", id: step.id, data: step }),
        kit: (kit) => writer.write({ type: "data-brandKit", id: "brand-kit", data: kit }),
        notice: (notice) =>
          writer.write({ type: "data-notice", id: "notice", data: notice }),
      });
      writer.write({ type: "finish" });
    },
    onError: (error) => {
      console.error("[research] stream failed", error);
      return "Research failed unexpectedly. Please try again.";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
