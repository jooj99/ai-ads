"use client";

/* eslint-disable @next/next/no-img-element -- product photos come from each store's CDN. */

import { CheckIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { thumbnail } from "@/components/research/brand-kit-view";
import type { AdIdea, AgentUIMessage } from "@/lib/agent/tools";
import type { SavedHeadline } from "@/lib/campaigns";
import type { CatalogItem } from "@/lib/research/types";
import { withoutEmoji } from "@/lib/copy";
import { cn } from "@/lib/utils";

type IdeasPart = Extract<AgentUIMessage["parts"][number], { type: "tool-proposeIdeas" }>;

/**
 * The agent's creative ad ideas, rendered from its `proposeIdeas` tool call:
 * one card per idea with what the ad shows and shows off, its headline and
 * CTA, and the products it features. Ticking ideas is a local selection
 * until Generate, which saves their headlines and sends them to the agent
 * (as the tool's output when it's waiting on this card, else as a message).
 * Ideas already sent from this card show as made; any card can send more.
 */
export function IdeaChoice({
  part,
  live,
  streaming,
  products,
  saved,
  onGenerate,
}: {
  part: IdeasPart;
  /** The saved headlines: an idea whose headline was saved from this card has been made. */
  saved: SavedHeadline[];
  /** The agent is paused on this card, waiting for the user. */
  live: boolean;
  /** The agent is still writing this card's ideas. */
  streaming: boolean;
  /** The campaign's catalog, for the product thumbnails. */
  products: CatalogItem[];
  onGenerate: (picked: AdIdea[]) => Promise<boolean>;
}) {
  const [ticked, setTicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  // Ideas sent from this card (as its output, or from this session as a message).
  const [sentHere, setSentHere] = useState<string[]>([]);

  if (part.state === "input-streaming") {
    return streaming ? (
      <Shimmer as="p" className="text-sm">
        Coming up with ad ideas…
      </Shimmer>
    ) : null;
  }
  if (part.state !== "input-available" && part.state !== "output-available") return null;

  // Ads never show emojis, so the card (and what it saves and sends) doesn't either.
  const ideas = part.input.ideas.map((i) => ({ ...i, headline: withoutEmoji(i.headline), cta: withoutEmoji(i.cta) }));
  const made = new Set([
    ...(part.state === "output-available" ? part.output.picked.map((i) => i.title) : []),
    ...sentHere,
    // Made from this card in an earlier visit (sent as a message from an older card).
    ...ideas
      .filter((i) => saved.some((h) => h.proposalId === part.toolCallId && h.headline === i.headline && h.cta === i.cta))
      .map((i) => i.title),
  ]);
  const picked = ideas.filter((i) => ticked.includes(i.title) && !made.has(i.title));

  // "Generate all": every idea on the card not made yet.
  const rest = ideas.filter((i) => !made.has(i.title));

  async function generate(which: typeof ideas) {
    setSending(true);
    const ok = await onGenerate(which);
    setSending(false);
    if (ok) {
      setSentHere((s) => [...s, ...which.map((i) => i.title)]);
      setTicked([]);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-background p-3">
      <div className="flex items-start justify-between gap-2 px-1 pt-1">
        <p className="text-sm font-medium">Pick the ideas to make into ads</p>
        {live && <Badge className="shrink-0 bg-brand-yellow text-foreground">Waiting on you</Badge>}
      </div>

      <ul className="grid gap-2 @xl:grid-cols-2" aria-label="Ad ideas">
        {ideas.map((idea) => {
          const on = ticked.includes(idea.title);
          const done = made.has(idea.title);
          const items = idea.productIds.flatMap((id) => products.filter((p) => p.id === id));
          return (
            <li key={idea.title}>
              {/* A made idea can't be picked again: it already has its ad. */}
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={done}
                onClick={() =>
                  setTicked((t) => (t.includes(idea.title) ? t.filter((x) => x !== idea.title) : [...t, idea.title]))
                }
                className={cn(
                  "flex h-full w-full flex-col gap-2.5 rounded-lg border p-3 text-left transition-colors",
                  done ? "cursor-default opacity-55" : "hover:border-foreground/40",
                  on ? "border-foreground bg-muted/40" : "border-border",
                )}
              >
                <span className="flex items-start gap-2.5">
                  {!done && (
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                        on ? "border-foreground bg-foreground text-background" : "border-foreground/30",
                      )}
                    >
                      {on && <CheckIcon className="size-3" strokeWidth={3} />}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{idea.title}</span>
                  {done && (
                    <Badge variant="secondary" className="shrink-0 font-normal">
                      Made
                    </Badge>
                  )}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="font-normal">
                    {idea.style === "minimal" ? "Minimal" : "Scene"}
                  </Badge>
                  {(idea.visual === "brand_graphic" || (!idea.visual && idea.showProduct === false)) && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      Brand graphic
                    </Badge>
                  )}
                  {idea.visual === "product_graphic" && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      Product + brand graphic
                    </Badge>
                  )}
                  {idea.visual === "none" && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      Type only
                    </Badge>
                  )}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {idea.pitch ?? [idea.concept, idea.scene].filter(Boolean).join(" ")}
                </span>
                <span className="mt-auto flex flex-col gap-2 border-t pt-2.5">
                  <span className="text-sm font-medium leading-snug">“{idea.headline}”</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">
                      {idea.cta}
                    </span>
                    {items.map((p) => (
                      <span key={p.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {p.images[0] && (
                          <img
                            src={thumbnail(p.images[0], 80)}
                            alt=""
                            className="size-5 rounded object-cover ring-1 ring-foreground/10"
                          />
                        )}
                        {p.title}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
        <p className="text-xs text-muted-foreground">
          {picked.length
            ? `${picked.length} selected · each becomes one ad`
            : made.size
              ? `${made.size} made from here · pick more any time`
              : "Select the ideas you like, then generate."}
        </p>
        <div className="flex flex-wrap gap-2">
          {rest.length > 1 && (
            <Button size="sm" variant="outline" disabled={sending} onClick={() => void generate(rest)}>
              Generate all {rest.length}
            </Button>
          )}
          <Button size="sm" disabled={!picked.length || sending} onClick={() => void generate(picked)}>
            {sending ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {picked.length > 1 ? `Generate ${picked.length} selected` : "Generate selected"}
          </Button>
        </div>
      </div>
    </div>
  );
}
