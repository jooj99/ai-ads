"use client";

import { PencilIcon } from "lucide-react";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";

import { renameCampaignAction } from "@/app/campaigns/actions";
import { cn } from "@/lib/utils";

const TITLE = "font-display text-5xl leading-none uppercase md:text-6xl";

/**
 * The campaign's name; click it to rename. Enter or clicking away saves,
 * Escape cancels. The new name shows immediately and rolls back if the save
 * fails.
 */
export function CampaignTitle({ campaignId, name }: { campaignId: string; name: string }) {
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
            "-mx-3 -my-1.5 w-[calc(100%+1.5rem)] min-w-0 rounded-lg bg-muted px-3 py-1.5 outline-none ring-2 ring-ring/40",
          )}
        />
      ) : (
        <h1 className="min-w-0">
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
              "group -mx-3 -my-1.5 max-w-[calc(100%+1.5rem)] rounded-lg px-3 py-1.5 text-left break-words hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
              saving && "opacity-60",
            )}
          >
            {current}
            <PencilIcon
              aria-hidden="true"
              className="ml-3 inline-block size-6 -translate-y-1 align-middle opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
            />
            <span className="sr-only">Rename campaign</span>
          </button>
        </h1>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
