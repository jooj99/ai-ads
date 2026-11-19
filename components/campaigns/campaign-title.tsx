"use client";

import { PencilIcon } from "lucide-react";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";

import { renameCampaignAction } from "@/app/campaigns/actions";
import { cn } from "@/lib/utils";

const SIZES = {
  page: {
    title: "font-display text-5xl leading-none uppercase md:text-6xl",
    // Hover/edit padding, offset by negative margins so the text stays aligned.
    box: "-mx-3 -my-1.5 px-3 py-1.5",
    input: "w-[calc(100%+1.5rem)]",
    pencil: "ml-3 size-6 -translate-y-1",
  },
  header: {
    // The display face's line box is much taller than its capitals, which
    // pushes them off-center next to icons; trim it to cap height so the
    // title centers in the bar like everything else.
    title: "font-display text-2xl leading-none uppercase [text-box:trim-both_cap_alphabetic]",
    box: "-mx-2 -my-1 px-2 py-1.5",
    input: "w-[calc(100%+1rem)]",
    pencil: "ml-2 size-3.5",
  },
};

/**
 * The campaign's name; click it to rename. Enter or clicking away saves,
 * Escape cancels. The new name shows immediately and rolls back if the save
 * fails.
 */
export function CampaignTitle({
  campaignId,
  name,
  size = "page",
}: {
  campaignId: string;
  name: string;
  /** "header" for the compact campaign workspace bar. */
  size?: keyof typeof SIZES;
}) {
  const TITLE = SIZES[size].title;
  const [current, setCurrent] = useState(name);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, startSaving] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Research can rename a campaign that still has its default name; follow it.
  const [prevName, setPrevName] = useState(name);
  if (name !== prevName) {
    setPrevName(name);
    if (!editing) setCurrent(name);
  }

  function save() {
    const next = inputRef.current?.value.trim() ?? "";
    setEditing(false);
    if (!next || next === current) return;
    const previous = current;
    setCurrent(next);
    setError(undefined);
    startSaving(async () => {
      const result = await renameCampaignAction(campaignId, next);
      if (!result.ok) {
        setCurrent(previous);
        setError(result.error);
      }
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") save();
    if (event.key === "Escape") setEditing(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          defaultValue={current}
          maxLength={80}
          aria-label="Campaign name"
          onBlur={save}
          onKeyDown={onKeyDown}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            TITLE,
            // Same padding and offset as the button, so the text doesn't jump.
            SIZES[size].box,
            SIZES[size].input,
            "min-w-0 rounded-lg bg-muted outline-none ring-2 ring-ring/40",
          )}
        />
      ) : (
        <h1 className="flex min-w-0">
          {/* Inline layout: the name wraps only between words (a flex item that
              may shrink can break mid-word), and the pencil follows the last
              word inside the padded hover area. The negative margin keeps the
              text aligned with the content below. */}
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Click to rename"
            className={cn(
              TITLE,
              SIZES[size].box,
              "group max-w-[calc(100%+1.5rem)] rounded-lg text-left break-words hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
              saving && "opacity-60",
            )}
          >
            {current}
            <PencilIcon
              aria-hidden="true"
              className={cn(
                SIZES[size].pencil,
                "inline-block align-middle opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60",
              )}
            />
            <span className="sr-only">Rename campaign</span>
          </button>
        </h1>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
