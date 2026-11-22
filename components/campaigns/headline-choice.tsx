"use client";

import { CheckIcon, Loader2Icon, PenLineIcon, PlusIcon, SendIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentUIMessage, CampaignCopy } from "@/lib/agent/tools";
import { sameCopy } from "@/lib/agent/ui";
import type { SavedHeadline } from "@/lib/campaigns";
import { cn } from "@/lib/utils";

type ProposePart = Extract<AgentUIMessage["parts"][number], { type: "tool-proposeHeadlines" }>;

/** What submitting a card changes, and what the agent is told. */
export type ChoiceSubmission = {
  /** Newly ticked rows to save (agent options, or headlines the user wrote). */
  add: (CampaignCopy & { source: "agent" | "user" })[];
  /** Previously saved rows the user unticked. */
  remove: CampaignCopy[];
  /** Every row ticked on the card after submitting. */
  picked: CampaignCopy[];
};

const keyOf = (c: CampaignCopy) => `${c.headline.trim().toLowerCase()}\u0000${c.cta.trim().toLowerCase()}`;

/**
 * The agent's headline options, rendered from its `proposeHeadlines` tool
 * call. Ticking options and writing your own only change the card's local
 * selection; Submit saves it to the campaign and sends it to the agent. The
 * card starts from what's already saved, so any card (old or new) can be
 * re-opened, changed and submitted again.
 */
export function HeadlineChoice({
  part,
  live,
  streaming,
  saved,
  onSubmit,
}: {
  part: ProposePart;
  /** The agent is paused on this card, waiting for the user. */
  live: boolean;
  /** The agent is still writing this card's options. */
  streaming: boolean;
  /** Every headline saved for the campaign. */
  saved: SavedHeadline[];
  onSubmit: (submission: ChoiceSubmission) => Promise<boolean>;
}) {
  // Ticks the user changed since the last submit, by row; everything else
  // shows what's saved.
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  // Headlines written on this card that haven't been submitted yet.
  const [drafts, setDrafts] = useState<CampaignCopy[]>([]);
  const [writing, setWriting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (part.state === "input-streaming") {
    return streaming ? (
      <Shimmer as="p" className="text-sm">
        Writing headline options…
      </Shimmer>
    ) : null;
  }
  if (part.state !== "input-available" && part.state !== "output-available") return null;

  const { question, options } = part.input;
  const proposalId = part.toolCallId;
  const isSaved = (copy: CampaignCopy) => saved.some((s) => sameCopy(s, copy));
  const writtenHere = saved.filter(
    (s) => s.proposalId === proposalId && s.source === "user" && !options.some((o) => sameCopy(o, s)),
  );
  const rows = [
    ...options.map((o) => ({ headline: o.headline, cta: o.cta, note: o.angle, mine: false })),
    ...writtenHere.map((w) => ({ headline: w.headline, cta: w.cta, note: "Written by you", mine: true })),
    ...drafts
      .filter((d) => !writtenHere.some((w) => sameCopy(w, d)))
      .map((d) => ({ headline: d.headline, cta: d.cta, note: "Written by you", mine: true })),
  ];
  const checked = (row: CampaignCopy) => ticks[keyOf(row)] ?? isSaved(row);
  const add = rows
    .filter((r) => checked(r) && !isSaved(r))
    .map((r) => ({ headline: r.headline, cta: r.cta, source: r.mine ? ("user" as const) : ("agent" as const) }));
  const remove = rows.filter((r) => !checked(r) && isSaved(r)).map(({ headline, cta }) => ({ headline, cta }));
  const picked = rows.filter(checked).map(({ headline, cta }) => ({ headline, cta }));
  const dirty = add.length > 0 || remove.length > 0;
  const savedCount = rows.filter(isSaved).length;

  async function submit() {
    setSubmitting(true);
    const ok = await onSubmit({ add, remove, picked });
    setSubmitting(false);
    if (ok) {
      setTicks({});
      setDrafts([]);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-background p-3">
      <div className="flex items-start justify-between gap-2 px-1 pt-1">
        <p className="text-sm font-medium">{question}</p>
        {live && <Badge className="shrink-0 bg-brand-yellow text-foreground">Waiting on you</Badge>}
      </div>

      <ul className="flex flex-col gap-2" aria-label="Headline options">
        {rows.map((row, i) => {
          const on = checked(row);
          return (
            <li key={`${keyOf(row)}-${i}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => setTicks((t) => ({ ...t, [keyOf(row)]: !on }))}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:border-foreground/40",
                  on ? "border-foreground bg-muted/40" : "border-border",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                    on ? "border-foreground bg-foreground text-background" : "border-foreground/30",
                  )}
                >
                  {on && <CheckIcon className="size-3" strokeWidth={3} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-sm font-medium leading-snug">{row.headline}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">
                      {row.cta}
                    </span>
                    <span className="text-xs text-muted-foreground">{row.note}</span>
                    {isSaved(row) && (
                      <span className="text-xs text-muted-foreground">· Saved</span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {writing ? (
        <WriteOwnForm
          submitLabel="Add to selection"
          onCancel={() => setWriting(false)}
          onSubmit={async (copy) => {
            if (!rows.some((r) => sameCopy(r, copy))) setDrafts((d) => [...d, copy]);
            setTicks((t) => ({ ...t, [keyOf(copy)]: true }));
            setWriting(false);
            return true;
          }}
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          onClick={() => setWriting(true)}
        >
          <PenLineIcon />
          Write your own
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
        <p className="text-xs text-muted-foreground">
          {dirty
            ? `${picked.length} selected · submit to save and send to the agent`
            : savedCount
              ? `${savedCount} saved from here · change and resubmit any time`
              : "Select as many as you like, then submit."}
        </p>
        <Button size="sm" disabled={!dirty || submitting} onClick={() => void submit()}>
          {submitting ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
          Submit
        </Button>
      </div>
    </div>
  );
}

/** A headline + CTA the user writes themselves. Used on choice cards and in the Ads tab. */
export function WriteOwnForm({
  onSubmit,
  onCancel,
  submitLabel = "Add",
}: {
  onSubmit: (copy: CampaignCopy) => Promise<boolean>;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [headline, setHeadline] = useState("");
  const [cta, setCta] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!headline.trim() || saving) return;
    setSaving(true);
    const ok = await onSubmit({ headline: headline.trim(), cta: cta.trim() || "Shop now" });
    setSaving(false);
    if (ok) {
      setHeadline("");
      setCta("");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
      <Input
        autoFocus
        value={headline}
        onChange={(e) => setHeadline(e.target.value)}
        maxLength={80}
        placeholder="Your headline"
        aria-label="Headline"
      />
      <div className="flex gap-2">
        <Input
          value={cta}
          onChange={(e) => setCta(e.target.value)}
          maxLength={30}
          placeholder="Button text (Shop now)"
          aria-label="Call to action"
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={!headline.trim() || saving}>
          <PlusIcon />
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
