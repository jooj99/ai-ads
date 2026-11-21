"use client";

import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  RotateCcwIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { thumbnail } from "@/components/research/brand-kit-view";
import { sameCopy } from "@/lib/agent/tools";
import { adPreviewUrl } from "@/lib/ads/preview-url";
import type { AdComment, SavedAd } from "@/lib/campaigns";
import type { CatalogItem } from "@/lib/research/types";
import { cn } from "@/lib/utils";

/** A new ad the agent is making right now (its generateAd call hasn't returned). */
export type PendingAd = { key: string; headline: string; cta: string; stage?: string | null };

/** One ad: every version sharing its number, oldest first. */
type Ad = { number: number; versions: SavedAd[] };

/**
 * The Ads tab: the campaign's ads as the center of the workspace, sized to
 * fit the panel without scrolling.
 *
 * - Left: a rail of every ad by number ("Ad 3", its newest version), plus
 *   ads being made. The numbers are what the user and agent call them.
 * - Middle: the selected ad, as large as the space allows. Clicking a spot
 *   on the newest version pins a numbered comment there (saved as fractions
 *   of the image, so pins stay put at any size).
 * - Right: its versions (each edit adds one under the same number), the
 *   comments with Apply (the agent makes the next version from them), and
 *   open / download / delete version / delete ad.
 */
export function AdStudio({
  ads,
  pending,
  editing,
  brand,
  products,
  onDelete,
  onAddComment,
  onDeleteComment,
  onDismissIssue,
  onStart,
  onEditComment,
  onApply,
  onReview,
  onRetry,
}: {
  ads: SavedAd[];
  pending: PendingAd[];
  /** Ad versions the agent is editing right now (editAd calls in flight). */
  editing: string[];
  brand: string;
  /** The campaign's catalog, to show the products each ad was made with. */
  products: CatalogItem[];
  onDelete: (ad: SavedAd, scope: "version" | "ad") => void;
  onAddComment: (ad: SavedAd, comment: NewComment) => Promise<boolean>;
  onDeleteComment: (ad: SavedAd, comment: AdComment) => void;
  /** Dismisses one warning on a version: a remaining problem's text, or "unchecked". */
  onDismissIssue: (ad: SavedAd, issue: string) => void;
  /** Starts the products → ideas → ads flow in the chat, from the empty state (once research is done). */
  onStart?: () => void;
  /** Rewrites an open comment's text; resolves true once saved. */
  onEditComment: (
    ad: SavedAd,
    comment: AdComment,
    body: string,
  ) => Promise<boolean>;
  onApply: (ad: SavedAd, count: number) => void;
  /** The answer to "was it resolved?" for a comment an edit applied. */
  onReview: (comment: AdComment, resolved: boolean) => Promise<void>;
  /** Makes a failed ad, or a failed version, again. */
  onRetry: (ad: SavedAd) => void;
}) {
  // Being made. The server turns rows that can't finish any more (their run
  // died, or 10+ minutes) into failed ones (`expireStaleAds`), and the page
  // re-reads the ads while any are generating.
  const live = (ad: SavedAd) => ad.status === "generating";

  const all = groupByNumber(ads);
  // New ads being made: an ad whose only version is still generating, plus
  // calls the chat shows before their row exists.
  const making: PendingAd[] = [
    ...all
      .filter((a) => a.versions.every(live))
      .map((a) => ({
        key: `n${a.number}`,
        headline: a.versions[0].headline,
        cta: a.versions[0].cta,
        stage: a.versions[0].stage,
      })),
    // A call whose ad already exists (being made, or finished while the tool
    // call is still wrapping up) has no placeholder of its own.
    ...pending.filter((p) => !ads.some((a) => a.toolCallId === p.key || (live(a) && sameCopy(a, p)))),
  ];
  // A failed ad being retried (a call for the same copy is running) leaves
  // the rail now: the retry takes its place and its number.
  const retrying = (a: Ad) =>
    a.versions.every((v) => v.status === "failed") &&
    pending.some((p) => p.key !== a.versions[0].toolCallId && sameCopy(a.versions[0], p));
  const shown = all.filter((a) => !a.versions.every(live) && !retrying(a));

  // Selection: an ad by number, and optionally an older version. A pick of an
  // older version lapses when the ad gains a version (show the new one).
  const [pick, setPick] = useState<{
    number: number;
    version?: string;
    count?: number;
  }>();
  const ad = shown.find((a) => a.number === pick?.number) ?? shown.at(-1);
  // Versions as the user sees them: an edit still being made isn't one yet.
  const versions = ad ? ad.versions.filter((v) => !live(v)) : [];
  const newest =
    versions.findLast((v) => v.status === "ready") ?? versions.at(-1);
  const chosen =
    ad &&
    pick?.number === ad.number &&
    pick.version &&
    pick.count === versions.length
      ? versions.find((v) => v.id === pick.version)
      : undefined;
  const version = chosen ?? newest;
  const inEdit = ad
    ? ad.versions.some(
        (v) => editing.includes(v.id) || (live(v) && Boolean(v.parentId)),
      )
    : false;

  // Deleting an ad, from its ⋯ menu in the rail (confirmed first). On
  // confirm it shrinks away at once and the delete finishes in the
  // background; comments deleted from the panel do the same.
  const [confirm, setConfirm] = useState<{ target: SavedAd; number: number }>();
  const [leavingAds, setLeavingAds] = useState<number[]>([]);
  const [leavingComments, setLeavingComments] = useState<string[]>([]);
  function askDelete(a: Ad) {
    setConfirm({ target: a.versions.at(-1)!, number: a.number });
  }
  function removeAd(target: SavedAd, number: number) {
    setLeavingAds((l) => [...l, number]);
    setTimeout(() => {
      onDelete(target, "ad");
      setLeavingAds((l) => l.filter((n) => n !== number));
    }, LEAVE_MS);
  }
  function removeComment(on: SavedAd, comment: AdComment) {
    setLeavingComments((l) => [...l, comment.id]);
    setTimeout(() => {
      onDeleteComment(on, comment);
      setLeavingComments((l) => l.filter((id) => id !== comment.id));
    }, LEAVE_MS);
  }
  const adLeaving = ad ? leavingAds.includes(ad.number) : false;

  if (!shown.length && !making.length) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-foreground/15 px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-background">
          <ImageIcon className="size-5" />
        </span>
        <p className="font-medium">No ads yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick the products to advertise and the ideas you like in the chat, and
          the agent makes a 9:16 ad from each idea, built on your product photos.
          Then click a spot or drag a box on an ad to comment, and apply your
          comments to get a new version.
        </p>
        {onStart && (
          <Button className="mt-1" onClick={onStart}>
            <SparklesIcon />
            Pick products for ads
          </Button>
        )}
      </div>
    );
  }

  return (
    // Fills the panel's height on wide panels: rail | ad | details, no page scroll.
    // --fixed is the width the rail, details and gaps take; the ad gets the rest.
    <div className="flex flex-col gap-4 [--studio-h:calc(100svh-11.5rem)] @lg:h-(--studio-h) @lg:flex-row @lg:gap-3 @lg:[--fixed:18.5rem] @3xl:gap-5 @3xl:[--fixed:24rem]">
      <AdRail
        ads={shown}
        making={making}
        selected={ad?.number}
        busy={(a) =>
          a.versions.some(
            (v) => editing.includes(v.id) || (live(v) && Boolean(v.parentId)),
          )
        }
        onSelect={(number) => setPick({ number })}
        leaving={(a) => leavingAds.includes(a.number)}
        onDelete={askDelete}
      />

      {ad && version ? (
        <>
          <AdCanvas
            key={version.id}
            ad={version}
            number={ad.number}
            canComment={
              version.id === newest?.id && version.status === "ready" && !inEdit
            }
            editing={inEdit}
            editStage={ad.versions.find((v) => live(v) && v.parentId)?.stage}
            nextVersion={versions.length + 1}
            onAddComment={(c) => onAddComment(version, c)}
            versionLabel={(id) => {
              const i = versions.findIndex((v) => v.id === id);
              return i >= 0 ? `v${i + 1}` : "a newer version";
            }}
            onReview={onReview}
            leavingComments={leavingComments}
            fading={adLeaving}
            onRemoveComment={(c) => removeComment(version, c)}
            onEditComment={(c, body) => onEditComment(version, c, body)}
            onRetry={() => onRetry(version)}
          />
          <AdDetails
            number={ad.number}
            ad={version}
            versions={versions}
            isNewest={version.id === newest?.id}
            editing={inEdit}
            brand={brand}
            products={products}
            onPickVersion={(id) =>
              setPick({
                number: ad.number,
                version: id,
                count: versions.length,
              })
            }
            onDeleteComment={(c) => removeComment(version, c)}
            onDismissIssue={(issue) => onDismissIssue(version, issue)}
            onApply={(count) => onApply(version, count)}
            leavingComments={leavingComments}
            fading={adLeaving}
          />
        </>
      ) : null}

      <AlertDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Ad {confirm?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the ad and all its versions, with their comments. It
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirm) removeAd(confirm.target, confirm.number);
                setConfirm(undefined);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- the rail of ads ---------------------------------------------------------------

function AdRail({
  ads,
  making,
  selected,
  busy,
  onSelect,
  leaving,
  onDelete,
}: {
  ads: Ad[];
  making: PendingAd[];
  selected?: number;
  busy: (a: Ad) => boolean;
  onSelect: (number: number) => void;
  /** Ads being deleted: they shrink away before they're removed. */
  leaving: (a: Ad) => boolean;
  onDelete: (a: Ad) => void;
}) {
  return (
    <ul
      aria-label="Ads"
      // The scrollbar gets its own strip (right padding when it's a column,
      // bottom padding when it's a row), so it never sits on the thumbnails:
      // overlay scrollbars (macOS) draw inside the padding.
      className="-mx-1 flex shrink-0 gap-3 overflow-x-auto px-1 pt-1 pb-3.5 [scrollbar-width:thin] @lg:mx-0 @lg:w-[4.75rem] @lg:flex-col @lg:overflow-x-visible @lg:overflow-y-auto @lg:py-1 @lg:pr-3.5 @lg:pl-1 @3xl:w-[6rem]"
    >
      {/* Ad 1 at the top, in number order; ads being made come last (they get the next numbers). */}
      {ads.map((a) => {
        const top =
          a.versions.findLast((v) => v.status === "ready") ??
          a.versions.at(-1)!;
        const count = a.versions.filter((v) => v.status === "ready").length;
        const open = top.comments.filter((c) => c.status === "open").length;
        const isSelected = a.number === selected;
        return (
          <li
            key={a.number}
            className={cn(
              "group/ad relative shrink-0 transition-[scale,opacity] duration-200 ease-in",
              leaving(a) && "pointer-events-none scale-75 opacity-0",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(a.number)}
              aria-pressed={isSelected}
              aria-label={`Ad ${a.number}: ${top.headline}`}
              title={top.headline}
              className="group flex w-16 flex-col items-center gap-1.5 @lg:w-full"
            >
              <span
                className={cn(
                  "relative block aspect-[9/16] w-full overflow-hidden rounded-lg bg-background ring-1 ring-foreground/10 transition",
                  isSelected
                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-muted"
                    : "opacity-80 group-hover:opacity-100",
                )}
              >
                {top.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={adPreviewUrl(top.imageUrl)}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <AlertTriangleIcon className="absolute inset-0 m-auto size-4 text-brand-orange" />
                )}
                {busy(a) && (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2Icon className="size-4 animate-spin" />
                  </span>
                )}
                {open > 0 && (
                  <span className="absolute top-1 left-1 flex size-4 items-center justify-center rounded-full bg-[#FF2D55] text-[10px] font-bold text-white">
                    {open}
                  </span>
                )}
                {((top.issues?.length ?? 0) > 0 || top.unchecked) && top.imageUrl && (
                  <span
                    title={top.unchecked ? "Not checked: the automatic check didn't respond" : "Still not right after the automatic fixes"}
                    className="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded-full bg-brand-orange text-white shadow-sm"
                  >
                    <AlertTriangleIcon className="size-2.5" />
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-[11px] leading-none font-semibold",
                  !isSelected && "text-muted-foreground",
                )}
              >
                Ad {a.number}
                {count > 1 && <span className="font-normal"> · v{count}</span>}
              </span>
            </button>
            {/* The ad's menu: on hover, and always on the selected ad and on touch screens. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More for Ad ${a.number}`}
                  className={cn(
                    "absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-opacity data-[state=open]:opacity-100 md:opacity-0 md:group-hover/ad:opacity-100 md:focus-visible:opacity-100",
                    isSelected && "md:opacity-100",
                  )}
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy(a)}
                  onSelect={() => onDelete(a)}
                >
                  <Trash2Icon />
                  Delete Ad {a.number}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
      {making.map((p) => (
        <li
          key={p.key}
          className="shrink-0"
          title={`Making “${p.headline}”${p.stage ? `: ${p.stage}` : ""}`}
        >
          <div className="flex aspect-[9/16] w-16 items-center justify-center rounded-lg bg-background ring-1 ring-foreground/10 @lg:w-full">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          </div>
          <p className="mt-1 text-center text-[11px] text-muted-foreground">
            New
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---- the big ad, with pins --------------------------------------------------------

function AdCanvas({
  ad,
  number,
  canComment,
  editing,
  editStage,
  nextVersion,
  versionLabel,
  onReview,
  onAddComment,
  leavingComments,
  fading,
  onRemoveComment,
  onEditComment,
  onRetry,
}: {
  ad: SavedAd;
  number: number;
  canComment: boolean;
  editing: boolean;
  /** What the edit in progress is doing now ("Applying 2 comments"). */
  editStage?: string | null;
  nextVersion: number;
  /** Comments being deleted: their pins shrink away first. */
  leavingComments: string[];
  /** The ad is being deleted: it fades out. */
  fading: boolean;
  /** Resolves or deletes an open comment (it shrinks away, then goes). */
  onRemoveComment: (comment: AdComment) => void;
  /** Rewrites an open comment; resolves true once saved. */
  onEditComment: (comment: AdComment, body: string) => Promise<boolean>;
  /** Makes this failed ad (or version) again. */
  onRetry: () => void;
  /** "v3" for a version id of this ad. */
  versionLabel: (id: string) => string;
  onReview: (comment: AdComment, resolved: boolean) => Promise<void>;
  onAddComment: (comment: NewComment) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Spot>();
  // A drag in progress: where it started and where the pointer is, as fractions.
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number }>();
  const open = ad.comments.filter((c) => c.status === "open");
  // Pinned on this version, applied by a later edit, and still waiting for
  // "was it resolved?". Answered ones are done: resolved ones are deleted, and
  // unresolved ones live on as the copy re-opened on the newest version.
  const made = ad.comments.filter((c) => c.status === "applied");

  // Press to pin a comment to a spot; drag to box an area and comment on all of it.
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return {
      x: clamp((e.clientX - rect.left) / rect.width),
      y: clamp((e.clientY - rect.top) / rect.height),
    };
  };
  function startDrag(e: PointerEvent<HTMLDivElement>) {
    if (
      !canComment ||
      e.button !== 0 ||
      (e.target as HTMLElement).closest("[data-pin],[data-draft]")
    )
      return;
    const p = at(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }
  function moveDrag(e: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const p = at(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }
  function endDrag() {
    if (!drag) return;
    setDrag(undefined);
    const box = dragBox(drag);
    setDraft(box ?? { x: drag.x0, y: drag.y0 });
  }
  const live = drag ? dragBox(drag) : undefined;

  // Beside the rail and details, the ad is as tall as the studio, unless the
  // width left over (100cqw minus --fixed) runs out first.
  const size =
    "aspect-[9/16] w-full max-w-sm @lg:h-[min(var(--studio-h),calc((100cqw-var(--fixed))*16/9))] @lg:w-auto @lg:max-w-none";

  return (
    <div
      className={cn(
        "flex shrink-0 justify-center transition-opacity duration-200 @lg:block",
        fading && "opacity-0",
      )}
    >
      {ad.status === "ready" && ad.imageUrl ? (
        <div
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => setDrag(undefined)}
          title={
            canComment
              ? "Click a spot to comment there, or drag a box over an area"
              : undefined
          }
          className={cn(
            "relative touch-none overflow-visible rounded-xl bg-background shadow-sm ring-1 ring-foreground/10 select-none",
            size,
            canComment && "cursor-crosshair",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={adPreviewUrl(ad.imageUrl)}
            alt={`Ad ${number}: ${ad.headline}`}
            width={ad.width ?? 1152}
            height={ad.height ?? 2048}
            draggable={false}
            className="size-full rounded-xl object-cover"
          />
          {made.map((c) => (
            <ReviewPin
              key={c.id}
              comment={c}
              kind="made"
              onReview={onReview}
              note={
                <p className="text-xs text-muted-foreground">
                  Applied in{" "}
                  {c.appliedAdId
                    ? versionLabel(c.appliedAdId)
                    : "a later version"}
                  {c.status === "unresolved" ? ", not resolved" : ""}.
                </p>
              }
            />
          ))}
          {/* Comments the edit that made this version applied: was each resolved? */}
          {ad.appliedComments
            .filter((c) => c.status === "applied")
            .map((c) => (
              <ReviewPin key={c.id} comment={c} onReview={onReview} />
            ))}
          {open.map((c, i) => (
            <Pin
              key={c.id}
              comment={c}
              kind="open"
              label={i + 1}
              leaving={leavingComments.includes(c.id)}
              onEdit={editing ? undefined : (body) => onEditComment(c, body)}
              // Either way it goes: ✓ means it's dealt with, ✕ that it's not wanted.
              actions={
                <CheckOrX
                  disabled={editing}
                  checkLabel="Mark resolved"
                  xLabel="Delete comment"
                  onCheck={async () => onRemoveComment(c)}
                  onX={async () => onRemoveComment(c)}
                />
              }
            />
          ))}
          {live && <BoxOutline spot={live} className="border-[#FF2D55]" />}
          {draft && (
            <DraftComment
              key={`${draft.x},${draft.y},${draft.w ?? ""}`}
              at={draft}
              n={open.length + 1}
              onCancel={() => setDraft(undefined)}
              onSave={async (body) => {
                const saving = draft;
                const ok = await onAddComment({
                  x: saving.x,
                  y: saving.y,
                  ...(saving.w && saving.h && { w: saving.w, h: saving.h }),
                  body,
                });
                // Only this draft closes: a spot clicked while it saved stays open.
                if (ok) setDraft((d) => (d === saving ? undefined : d));
                return ok;
              }}
            />
          )}
          {editing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-background/70 backdrop-blur-[2px]">
              <Loader2Icon className="size-5 animate-spin" />
              <Shimmer
                as="p"
                className="text-sm font-medium"
              >{`Making v${nextVersion} of Ad ${number}…`}</Shimmer>
              {editStage && (
                <p className="px-6 text-center text-xs text-muted-foreground">{editStage}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-xl bg-background p-6 text-center ring-1 ring-foreground/10",
            size,
          )}
        >
          <AlertTriangleIcon className="size-5 text-brand-orange" />
          <p className="text-sm text-muted-foreground">
            {ad.error ??
              (ad.status === "generating"
                ? "This version didn't finish."
                : "This ad couldn't be made.")}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCcwIcon />
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Where a comment goes: a spot (a pin) or an area (a box, `w`/`h`), centered on x/y, as fractions of the ad. */
type Spot = { x: number; y: number; w?: number | null; h?: number | null };

/** A new comment from the studio: its spot or box, and its text. */
export type NewComment = { x: number; y: number; w?: number; h?: number; body: string };

/** Drags shorter than this (as a fraction of the ad, either way) are a click: a pin. */
const MIN_BOX = 0.03;

/** The box a drag makes (centered, with its size), or undefined while it's still a click. */
function dragBox(d: { x0: number; y0: number; x1: number; y1: number }): Spot | undefined {
  const w = Math.abs(d.x1 - d.x0);
  const h = Math.abs(d.y1 - d.y0);
  if (w < MIN_BOX && h < MIN_BOX) return undefined;
  return {
    x: (d.x0 + d.x1) / 2,
    y: (d.y0 + d.y1) / 2,
    w: Math.max(w, MIN_BOX),
    h: Math.max(h, MIN_BOX),
  };
}

/** Where a comment's number sits: its spot, or a box's top-left corner. */
function anchorOf(spot: Spot): { x: number; y: number } {
  return spot.w && spot.h
    ? { x: spot.x - spot.w / 2, y: spot.y - spot.h / 2 }
    : { x: spot.x, y: spot.y };
}

/** A box comment's area on the ad: a dashed outline (solid while its card is open). */
function BoxOutline({ spot, className }: { spot: Spot; className?: string }) {
  if (!spot.w || !spot.h) return null;
  return (
    <span
      aria-hidden
      style={{
        left: `${(spot.x - spot.w / 2) * 100}%`,
        top: `${(spot.y - spot.h / 2) * 100}%`,
        width: `${spot.w * 100}%`,
        height: `${spot.h * 100}%`,
      }}
      className={cn(
        "pointer-events-none absolute rounded-md border-2 border-dashed transition-opacity duration-200",
        className,
      )}
    />
  );
}

type PinKind = "open" | "made" | "review" | "unresolved";

const BOX_STYLE: Record<PinKind, string> = {
  open: "border-[#FF2D55] bg-[#FF2D55]/5",
  made: "border-foreground/50",
  review: "border-brand-yellow",
  unresolved: "border-foreground/50",
};

const PIN_STYLE: Record<PinKind, string> = {
  open: "bg-[#FF2D55] text-white",
  made: "bg-foreground/60 text-white",
  review: "bg-brand-yellow text-foreground",
  unresolved: "bg-foreground/60 text-white",
};

/**
 * A comment's pin on the ad. Hovering (or focusing) it shows the comment in
 * a card, with whatever else applies (the resolved question, its status).
 */
function Pin({
  comment,
  kind,
  label,
  leaving,
  actions,
  onEdit,
  children,
}: {
  comment: AdComment;
  kind: PinKind;
  label?: ReactNode;
  /** Buttons on the right of the card, on the comment's line (✓ / ✕). */
  actions?: ReactNode;
  /** Shrinks and fades the pin out (and closes its card), e.g. once resolved. */
  leaving?: boolean;
  /** When given, the card has a ✎ that turns the comment into a text box; resolves true once saved. */
  onEdit?: (body: string) => Promise<boolean>;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Editing keeps the card open even when the pointer leaves it.
  const [editing, setEditing] = useState(false);
  const anchor = anchorOf(comment);
  const icon =
    label ??
    (kind === "review" ? (
      <CircleHelpIcon className="size-3.5" />
    ) : kind === "unresolved" ? (
      <RotateCcwIcon className="size-3" />
    ) : (
      <CheckIcon className="size-3" />
    ));
  return (
    <>
    {comment.w && comment.h ? (
      <BoxOutline
        spot={comment}
        className={cn(
          BOX_STYLE[kind],
          (open || editing) && "border-solid",
          leaving && "opacity-0",
        )}
      />
    ) : null}
    <HoverCard
      open={(open || editing) && !leaving}
      onOpenChange={setOpen}
      openDelay={80}
      closeDelay={150}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-pin
          aria-label={comment.body}
          style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
          className={cn(
            "absolute flex size-6 -translate-x-1/2 -translate-y-1/2 cursor-default items-center justify-center rounded-full text-xs font-bold shadow-md ring-2 ring-white transition-[scale,opacity] duration-200 ease-in",
            PIN_STYLE[kind],
            leaving && "pointer-events-none scale-0 opacity-0",
          )}
        >
          {icon}
        </button>
      </HoverCardTrigger>
      {/* data-pin: clicks in the card mustn't place a new comment (React events bubble out of portals). */}
      <HoverCardContent
        data-pin
        side="right"
        align="center"
        className="flex w-auto max-w-72 items-center gap-3 py-1.5 pr-1.5 pl-3"
      >
        {editing && onEdit ? (
          <EditComment
            initial={comment.body}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              const ok = await onEdit(body);
              if (ok) setEditing(false);
              return ok;
            }}
          />
        ) : (
          <>
            <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
              <p className="text-sm leading-snug break-words">{comment.body}</p>
              {children}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {onEdit && (
                <button
                  type="button"
                  aria-label="Edit comment"
                  title="Edit comment"
                  onClick={() => setEditing(true)}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground ring-1 ring-foreground/15 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <PencilIcon className="size-3" />
                </button>
              )}
              {actions}
            </div>
          </>
        )}
      </HoverCardContent>
    </HoverCard>
    </>
  );
}

/** A comment's text as an editable box in its card: Enter saves, Shift+Enter is a new line, Escape cancels. */
function EditComment({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  async function save() {
    const text = body.trim();
    if (!text || saving) return;
    if (text === initial) return onCancel();
    setSaving(true);
    if (!(await onSave(text))) setSaving(false);
  }
  return (
    <div className="flex w-64 flex-col gap-1.5 py-1">
      <Textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
        maxLength={500}
        rows={2}
        className="min-h-0 resize-none text-sm"
      />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={() => void save()}
          disabled={!body.trim() || saving}
        >
          {saving && <Loader2Icon className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

/** How long a resolved or deleted pin, comment or ad takes to shrink away (their duration-200). */
const LEAVE_MS = 200;

/**
 * A comment the edit that made this version applied, asking whether it was
 * resolved. Yes: the pin shrinks away at once, and the comment is deleted
 * in the background. No: it's re-opened on the newest version.
 */
function ReviewPin({
  comment,
  onReview,
  kind,
  note,
}: {
  comment: AdComment;
  onReview: (comment: AdComment, resolved: boolean) => Promise<void>;
  /** "made" on the version it was pinned on; otherwise by its status. */
  kind?: PinKind;
  note?: ReactNode;
}) {
  const [leaving, setLeaving] = useState(false);
  return (
    <Pin
      comment={comment}
      kind={kind ?? (comment.status === "applied" ? "review" : "unresolved")}
      leaving={leaving}
      actions={
        comment.status === "applied" ? (
          <CheckOrX
            checkLabel="Yes, resolved"
            xLabel="No, not resolved"
            onCheck={async () => {
              setLeaving(true);
              await new Promise((r) => setTimeout(r, LEAVE_MS));
              await onReview(comment, true);
            }}
            onX={() => onReview(comment, false)}
          />
        ) : undefined
      }
    >
      {note}
      {comment.status === "unresolved" ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <RotateCcwIcon className="size-3" /> Not resolved: reopened on the
          newest version.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Was it resolved?</p>
      )}
    </Pin>
  );
}

/** A comment's two answers in its hover card: ✕ and ✓. */
function CheckOrX({
  checkLabel,
  xLabel,
  disabled,
  onCheck,
  onX,
}: {
  checkLabel: string;
  xLabel: string;
  disabled?: boolean;
  onCheck: () => Promise<void>;
  onX: () => Promise<void>;
}) {
  const [saving, setSaving] = useState<"check" | "x">();
  const run = async (which: "check" | "x") => {
    setSaving(which);
    await (which === "check" ? onCheck() : onX());
    setSaving(undefined);
  };
  const button =
    "flex size-6 items-center justify-center rounded-full ring-1 ring-foreground/15 transition-colors disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label={xLabel}
        title={xLabel}
        disabled={disabled || saving !== undefined}
        onClick={() => void run("x")}
        className={cn(
          button,
          "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
        )}
      >
        {saving === "x" ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <XIcon className="size-3" />
        )}
      </button>
      <button
        type="button"
        aria-label={checkLabel}
        title={checkLabel}
        disabled={disabled || saving !== undefined}
        onClick={() => void run("check")}
        className={cn(
          button,
          "bg-foreground text-background ring-foreground hover:bg-emerald-600 hover:ring-emerald-600",
        )}
      >
        <CheckIcon className="size-3" />
      </button>
    </div>
  );
}

/** The comment box for a spot just clicked or an area just boxed: Enter saves, Escape cancels. */
function DraftComment({
  at: spot,
  n,
  onSave,
  onCancel,
}: {
  at: Spot;
  n: number;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  async function save() {
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);
    const ok = await onSave(text);
    if (!ok) setSaving(false);
  }

  // The number sits at the spot, or a box's top-left corner; the card opens
  // below the box (or pin), or above it near the bottom, so it stays on the ad.
  const at = anchorOf(spot);
  const bottom = spot.h ? spot.y + spot.h / 2 : spot.y;
  const up = bottom > 0.6;
  const cardY = up ? at.y : bottom;
  return (
    <>
      <BoxOutline spot={spot} className="border-[#FF2D55] bg-[#FF2D55]/5" />
      <span
        data-draft
        style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
        className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#FF2D55] text-xs font-bold text-white shadow-md ring-2 ring-white"
      >
        {n}
      </span>
      <div
        data-draft
        style={{
          // Centered on the pin, but kept inside the ad's edges.
          left: `clamp(8px, calc(${(spot.w ? spot.x : at.x) * 100}% - 8rem), calc(100% - 16rem - 8px))`,
          top: `calc(${cardY * 100}% ${up ? "- 20px" : "+ 20px"})`,
          transform: up ? "translateY(-100%)" : undefined,
        }}
        className="absolute z-10 flex w-64 max-w-[calc(100%-16px)] cursor-default flex-col gap-2 rounded-xl bg-background p-2.5 shadow-lg ring-1 ring-foreground/10"
      >
        <Textarea
          ref={ref}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
          }}
          maxLength={500}
          rows={2}
          placeholder="What should change here?"
          className="min-h-0 resize-none text-sm"
        />
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!body.trim() || saving}
          >
            {saving && <Loader2Icon className="animate-spin" />}
            Comment
          </Button>
        </div>
      </div>
    </>
  );
}

// ---- details beside the ad -----------------------------------------------------------

function AdDetails({
  number,
  ad,
  versions,
  isNewest,
  editing,
  brand,
  products,
  onPickVersion,
  onDeleteComment,
  onDismissIssue,
  onApply,
  leavingComments,
  fading,
}: {
  number: number;
  ad: SavedAd;
  versions: SavedAd[];
  isNewest: boolean;
  editing: boolean;
  brand: string;
  products: CatalogItem[];
  onPickVersion: (id: string) => void;
  onDeleteComment: (c: AdComment) => void;
  onDismissIssue: (issue: string) => void;
  onApply: (count: number) => void;
  leavingComments: string[];
  fading: boolean;
}) {
  const open = ad.comments.filter((c) => c.status === "open");
  // Pinned here, applied by a later edit (resolved ones are gone).
  const applied = ad.comments.filter((c) => c.status === "applied");
  const v = versions.indexOf(ad) + 1;

  return (
    // It scrolls, which clips anything drawn outside its box: the padding keeps
    // card borders and button outlines at its edges visible.
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-4 transition-opacity duration-200 @lg:h-full @lg:w-52 @lg:shrink-0 @lg:overflow-y-auto @lg:py-0.5 @lg:pr-1 @lg:pl-1.5 @3xl:w-64",
        fading && "opacity-0",
      )}
    >
      <div className="flex flex-col gap-2">
        <div className="flex min-h-7 items-center justify-between gap-2">
          {/* The campaign title's display face, at its header size. */}
          <h2 className="font-display text-2xl leading-none uppercase [text-box:trim-both_cap_alphabetic]">
            Ad {number}
          </h2>
          {versions.length > 1 && (
            <VersionSwitcher
              ad={ad}
              versions={versions}
              onPick={onPickVersion}
            />
          )}
        </div>
        <p className="text-lg leading-snug font-semibold">{ad.headline}</p>
      </div>

      {(ad.issues?.length ?? 0) > 0 && (
        <AdIssues issues={ad.issues} rounds={ad.fixRounds} onDismiss={onDismissIssue} />
      )}
      {ad.unchecked && ad.status === "ready" && (
        <AdUnchecked note={ad.unchecked} onDismiss={() => onDismissIssue("unchecked")} />
      )}

      {versions.length > 1 && (ad.changes?.length || ad.instruction) && (
        <ChangesBox
          key={ad.id}
          changes={ad.changes?.length ? ad.changes : changeList(ad.instruction ?? "")}
        />
      )}

      <div className="flex flex-col gap-2 rounded-xl bg-background p-3 ring-1 ring-foreground/10">
        <p className="text-sm font-medium">Comments</p>
        {open.length ? (
          <ol className="flex flex-col gap-1.5">
            {open.map((c, i) => (
              <li
                key={c.id}
                className={cn(
                  "group flex origin-left items-start gap-2 text-xs transition-[scale,opacity] duration-200 ease-in",
                  leavingComments.includes(c.id) &&
                    "pointer-events-none scale-90 opacity-0",
                )}
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#FF2D55] text-[11px] font-bold text-white">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 leading-snug break-words">
                  {c.body}
                </span>
                {isNewest && !editing && (
                  <button
                    type="button"
                    onClick={() => onDeleteComment(c)}
                    aria-label="Delete comment"
                    className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            {isNewest
              ? "Click a spot on the ad to say what should change there, or drag a box over an area to comment on all of it."
              : "Comments go on the newest version."}
          </p>
        )}
        {applied.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {applied.length} applied in a later version:{" "}
            {applied.map((c) => `“${c.body}”`).join(", ")}
          </p>
        )}
        {isNewest && (
          <Button
            className="mt-1"
            disabled={!open.length || editing}
            onClick={() => onApply(open.length)}
          >
            {editing ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SparklesIcon />
            )}
            {editing
              ? "Making a new version…"
              : open.length
                ? `Apply ${open.length} comment${open.length === 1 ? "" : "s"}`
                : "Apply comments"}
          </Button>
        )}
      </div>

      {ad.imageUrl && (
        <div className="flex flex-wrap gap-1.5">
          <Button asChild size="sm" variant="outline">
            <a href={ad.imageUrl} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Preview
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={ad.imageUrl} download={fileName(brand, number, v)}>
              <DownloadIcon />
              Download
            </a>
          </Button>
        </div>
      )}

      <AdProducts ids={ad.productIds} products={products} />
    </div>
  );
}

/**
 * What the automatic check still found wrong with this version after its
 * repair rounds, so it's never mistaken for a clean ad.
 */
function AdIssues({
  issues,
  rounds,
  onDismiss,
}: {
  issues: string[];
  rounds: number;
  /** Dismisses one warning (the user has checked it, or doesn't mind it). */
  onDismiss: (issue: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-brand-orange/10 p-3 ring-1 ring-brand-orange/30">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <AlertTriangleIcon className="size-4 shrink-0 text-brand-orange" />
        {rounds ? `Still not right after ${rounds} ${rounds === 1 ? "fix" : "fixes"}` : "Not quite right"}
      </p>
      <ul className="flex flex-col gap-1">
        {issues.map((issue) => (
          <li key={issue} className="group/issue flex items-start gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-current" />
            <span className="flex-1">{issue}</span>
            <DismissButton onClick={() => onDismiss(issue)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The check never answered, so this version wasn't checked: said plainly, never mistaken for a clean ad. */
function AdUnchecked({ note, onDismiss }: { note: string; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-brand-orange/10 p-3 ring-1 ring-brand-orange/30">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <AlertTriangleIcon className="size-4 shrink-0 text-brand-orange" />
        <span className="flex-1">Not checked</span>
        <DismissButton onClick={onDismiss} />
      </p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** A warning's ✕: dismisses that one warning. */
function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Dismiss this warning"
      title="Dismiss"
      onClick={onClick}
      className="-mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
    >
      <XIcon className="size-3" />
    </button>
  );
}

/**
 * The products the ad was made with (its version's `product_ids`, matched
 * to the catalog): a photo, the name and price, each linking to its page.
 */
function AdProducts({ ids, products }: { ids: string[]; products: CatalogItem[] }) {
  if (!ids.length) return null;
  const items = ids.map((id) => ({ id, item: products.find((p) => p.id === id) }));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        {items.length === 1 ? "Product in this ad" : "Products in this ad"}
      </p>
      <ul className="flex flex-col gap-2">
        {items.map(({ id, item }) => (
          <li key={id}>
            {item ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-lg p-1 -m-1 transition-colors hover:bg-muted"
              >
                <ProductThumb item={item} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm leading-snug group-hover:underline">{item.title}</span>
                  {(item.price || item.typeName) && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {[item.price, item.typeName].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </a>
            ) : (
              <span className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="size-12 shrink-0 rounded-md bg-muted" />
                No longer in the catalog
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProductThumb({ item }: { item: CatalogItem }) {
  const [broken, setBroken] = useState(false);
  const image = item.images[0];
  return image && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={thumbnail(image, 160)}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="size-12 shrink-0 rounded-md bg-muted object-cover ring-1 ring-foreground/10"
    />
  ) : (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted font-display text-lg uppercase ring-1 ring-foreground/10">
      {item.title.slice(0, 1)}
    </span>
  );
}

/**
 * Which version is on screen, as one compact control however many there are:
 * arrows step to the previous / next version, and the middle opens a
 * scrolling list of every version with what it changed.
 */
function VersionSwitcher({
  ad,
  versions,
  onPick,
}: {
  ad: SavedAd;
  versions: SavedAd[];
  onPick: (id: string) => void;
}) {
  const i = versions.indexOf(ad);
  const step =
    "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35";
  return (
    <div className="flex items-center rounded-full bg-background ring-1 ring-foreground/15">
      <button
        type="button"
        className={step}
        disabled={i <= 0}
        onClick={() => onPick(versions[i - 1].id)}
        aria-label="Previous version"
      >
        <ChevronLeftIcon className="size-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-7 items-center gap-1 px-1 text-xs font-medium tabular-nums hover:text-foreground"
            aria-label="Choose a version"
          >
            v{i + 1}
            <span className="font-normal text-muted-foreground">
              of {versions.length}
            </span>
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-80 w-64 overflow-y-auto"
        >
          {[...versions].reverse().map((x) => {
            const n = versions.indexOf(x) + 1;
            return (
              <DropdownMenuItem
                key={x.id}
                onSelect={() => onPick(x.id)}
                className="items-start gap-2 py-2"
              >
                <span className="w-7 shrink-0 pt-px text-xs font-semibold tabular-nums">
                  v{n}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-xs">
                    {x.parentId
                      ? (x.instruction
                          ?.split("\n")[0]
                          .replace(/^\d+\.\s*/, "") ?? "Edited")
                      : "Original"}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] text-muted-foreground",
                      x.status === "failed" && "text-destructive",
                    )}
                  >
                    {x.status === "failed"
                      ? "Failed"
                      : n === versions.length
                        ? "Latest"
                        : new Date(x.createdAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                  </span>
                </span>
                {x.id === ad.id && (
                  <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        className={step}
        disabled={i >= versions.length - 1}
        onClick={() => onPick(versions[i + 1].id)}
        aria-label="Next version"
      >
        <ChevronRightIcon className="size-3.5" />
      </button>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------------------

/**
 * What this version's edit changed, as a dropdown in the same box as the
 * comments: collapsed it's a single rounded row ("Changes · 3" and a
 * chevron), open it lists each change. Starts collapsed for each version.
 */
function ChangesBox({ changes }: { changes: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl bg-background ring-1 ring-foreground/10"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-xl p-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-foreground/30">
        <span>Changes</span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 px-3 pb-3">
          {changes.map((change, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
              <span className="mt-[0.35rem] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0 flex-1 leading-snug break-words">{change}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Fallback "Changes" for versions made before edits were summarized: what
 * was asked for, stored one per line ("1. …", "2. …", then any note).
 */
function changeList(instruction: string): string[] {
  return instruction
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

/** Groups versions into ads by their shared number, oldest version first; ads in number order. */
function groupByNumber(ads: SavedAd[]): Ad[] {
  const groups = new Map<number, SavedAd[]>();
  for (const ad of ads)
    groups.set(ad.number, [...(groups.get(ad.number) ?? []), ad]);
  return [...groups.entries()]
    .map(([number, versions]) => ({
      number,
      versions: versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) => a.number - b.number);
}

/** e.g. "loopy-cases-ad-3-v2.png" */
function fileName(brand: string, number: number, version: number) {
  const slug = brand
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "ad"}-ad-${number}${version > 1 ? `-v${version}` : ""}.png`;
}
