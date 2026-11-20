"use client";

import type { ChatStatus, FileUIPart } from "ai";
import { AlertTriangleIcon, BookOpenIcon, CheckIcon, Loader2Icon, RotateCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  ACCEPTED_IMAGES,
  AttachButton,
  AttachmentPreviews,
  MAX_ATTACHMENTS,
  MAX_PICK_BYTES,
  uploadAttachments,
} from "@/components/campaigns/chat-attachments";
import { HeadlineChoice, type ChoiceSubmission } from "@/components/campaigns/headline-choice";
import { Button } from "@/components/ui/button";
import { InputGroupAddon } from "@/components/ui/input-group";
import { RESEARCH_TOOL_PARTS, type AgentUIMessage } from "@/lib/agent/tools";
import type { SavedHeadline } from "@/lib/campaigns";

/** What the choice cards need: the saved headlines and how to submit a card. */
export type HeadlineControls = {
  saved: SavedHeadline[];
  /** Saves the card's changes and sends them to the agent; `live` when it's waiting on this card. */
  onSubmit: (toolCallId: string, live: boolean, submission: ChoiceSubmission) => Promise<boolean>;
};

/**
 * The chat pane: the conversation (the opening request, the agent's research
 * run and every turn after it), or `intro` while there is none, and the input.
 *
 * The input stays open while the agent replies: sending then interrupts the
 * reply (the caller stops it first). The submit button only acts as Stop when
 * there's nothing typed.
 */
export function CampaignChat({
  campaignId,
  intro,
  messages,
  status,
  error,
  inputDisabledReason,
  headlines,
  onSend,
  onStop,
  onRetry,
}: {
  campaignId: string;
  /** Shown while the conversation is empty. */
  intro: ReactNode;
  messages: AgentUIMessage[];
  status: ChatStatus;
  error?: Error;
  /** Why the input is off right now (research running or failed), if it is. */
  inputDisabledReason?: string;
  headlines: HeadlineControls;
  /** Sends a message; `files` are attached images, already uploaded (our own URLs). */
  onSend: (text: string, files?: FileUIPart[]) => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const [hasText, setHasText] = useState(false);
  const [attachError, setAttachError] = useState<string>();
  const busy = status === "submitted" || status === "streaming";
  const last = messages.at(-1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0" initial="instant">
        <ConversationContent className="gap-6 px-4 py-5 md:px-5">
          {messages.length === 0 && intro}

          {messages.map((message) => {
            if (message.role === "user") return <UserBubble key={message.id} message={message} />;
            const current = message === last && busy;
            return (
              <Message key={message.id} from="assistant" className="max-w-full">
                <MessageContent className="w-full gap-3">
                  {message.parts.map((part, i) => {
                    const key = `${message.id}-${i}`;
                    switch (part.type) {
                      case "text":
                        return part.text ? <MessageResponse key={key}>{part.text}</MessageResponse> : null;
                      case "tool-proposeHeadlines":
                        const live = message === last && !busy && part.state === "input-available";
                        return (
                          <HeadlineChoice
                            key={part.toolCallId}
                            part={part}
                            live={live}
                            streaming={current}
                            saved={headlines.saved}
                            onSubmit={(submission) => headlines.onSubmit(part.toolCallId, live, submission)}
                          />
                        );
                      case "tool-saveHeadline":
                      case "tool-removeHeadline":
                        return part.state === "output-available" ? (
                          <p key={part.toolCallId} className="flex items-center gap-2 text-muted-foreground">
                            <CheckIcon className="size-4 shrink-0" />
                            {toolLine(part)}
                          </p>
                        ) : current ? (
                          <Shimmer key={part.toolCallId} as="p">
                            Updating your headlines…
                          </Shimmer>
                        ) : null;
                      case "tool-editBrandText":
                      case "tool-editTags":
                      case "tool-editColors":
                      case "tool-editFonts":
                        return part.state === "output-available" ? (
                          <p key={part.toolCallId} className="flex items-center gap-2 text-muted-foreground">
                            {part.output.ok ? (
                              <CheckIcon className="size-4 shrink-0" />
                            ) : (
                              <XIcon className="size-4 shrink-0 text-destructive" />
                            )}
                            {part.output.summary}
                          </p>
                        ) : current ? (
                          <Shimmer key={part.toolCallId} as="p">
                            Updating the brand kit…
                          </Shimmer>
                        ) : null;
                      case "tool-deleteAd":
                        return part.state === "output-available" ? (
                          <p key={part.toolCallId} className="flex items-center gap-2 text-muted-foreground">
                            {part.output.ok ? (
                              <Trash2Icon className="size-4 shrink-0" />
                            ) : (
                              <XIcon className="size-4 shrink-0 text-destructive" />
                            )}
                            {part.output.summary}
                          </p>
                        ) : null;
                      case "tool-generateAd":
                      case "tool-editAd":
                        return <AdRow key={part.toolCallId} part={part} live={current} />;
                      case "tool-readSkill":
                        return part.state === "output-available" ? (
                          <p key={part.toolCallId} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <BookOpenIcon className="size-3.5 shrink-0" />
                            {part.output.ok ? `Read the ${part.input.name} playbook` : part.output.body}
                          </p>
                        ) : null;
                      default:
                        return RESEARCH_TOOL_PARTS.has(part.type) && "toolCallId" in part ? (
                          <ResearchStepRow key={part.toolCallId} part={part as ResearchPart} live={current} />
                        ) : null;
                    }
                  })}
                </MessageContent>
              </Message>
            );
          })}

          {status === "submitted" && (
            <Shimmer as="p" className="text-sm">
              Thinking…
            </Shimmer>
          )}

          {error && (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 p-3 text-sm">
              <p>{error.message || "The agent couldn't reply just now."}</p>
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RotateCwIcon />
                Try again
              </Button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t p-3 md:p-4">
        {attachError && <p className="mb-2 text-sm text-destructive">{attachError}</p>}
        <PromptInput
          accept={ACCEPTED_IMAGES}
          multiple
          maxFiles={MAX_ATTACHMENTS}
          maxFileSize={MAX_PICK_BYTES}
          onError={(e) =>
            setAttachError(
              e.code === "accept"
                ? "Only PNG, JPEG and WebP images can be attached."
                : e.code === "max_files"
                  ? `Up to ${MAX_ATTACHMENTS} images per message.`
                  : "That image is too large.",
            )
          }
          onSubmit={async ({ text, files }) => {
            if (!text.trim() && !files.length) return;
            setAttachError(undefined);
            let uploaded: FileUIPart[] = [];
            if (files.length) {
              try {
                uploaded = await uploadAttachments(campaignId, files);
              } catch (error) {
                setAttachError(error instanceof Error ? error.message : "An image couldn't be uploaded.");
                throw error; // keeps the text and images in the input to retry
              }
            }
            onSend(text.trim(), uploaded);
            setHasText(false);
          }}
          // The group only auto-sizes when the textarea is its direct child; here
          // it's wrapped (PromptInputBody), so set it explicitly.
          className="[&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:flex-wrap [&_[data-slot=input-group]]:rounded-[1.25rem]"
        >
          <AttachmentPreviews />
          <PromptInputBody>
            {/* One line to start; grows with the message (field-sizing:
                content) up to max-h-48, then scrolls. */}
            <PromptInputTextarea
              rows={1}
              placeholder={inputDisabledReason ?? (busy ? "Type to interrupt the agent" : "Reply or steer the agent")}
              disabled={Boolean(inputDisabledReason)}
              onChange={(e) => setHasText(e.currentTarget.value.trim().length > 0)}
              className="min-h-0 py-2.5 pl-1"
            />
          </PromptInputBody>
          <InputGroupAddon align="inline-start" className="self-end pb-1.5 pl-1.5">
            <AttachButton disabled={Boolean(inputDisabledReason)} />
          </InputGroupAddon>
          {/* Inline at the right, pinned to the bottom as the box grows. */}
          <InputGroupAddon align="inline-end" className="self-end pb-1.5">
            <PromptInputSubmit
              // With text typed, the button sends (interrupting a reply);
              // with nothing typed during a reply, it stops the reply.
              status={hasText ? "ready" : status}
              onStop={onStop}
              // Never disabled just for being empty: a disabled button greys the
              // whole input group. Empty sends are ignored in onSubmit.
              disabled={Boolean(inputDisabledReason)}
              className="rounded-full"
            />
          </InputGroupAddon>
        </PromptInput>
      </div>
    </div>
  );
}

function toolLine(
  part: Extract<AgentUIMessage["parts"][number], { type: "tool-saveHeadline" | "tool-removeHeadline" }>,
) {
  if (part.state !== "output-available") return "";
  if (part.type === "tool-saveHeadline") {
    return part.output.saved
      ? `Saved “${part.input.headline}” · ${part.input.cta}`
      : "Couldn't save that headline";
  }
  return part.output.removed ? `Removed “${part.input.headline}”` : "Couldn't remove that headline";
}

/** The user's message: any attached images (click to open), then the text. */
function UserBubble({ message }: { message: AgentUIMessage }) {
  const text = textOf(message);
  const images = message.parts.filter((p) => p.type === "file" && p.mediaType.startsWith("image/"));
  return (
    <Message from="user">
      <div className="ml-auto flex max-w-full flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((p, i) =>
              p.type === "file" ? (
                <a key={i} href={p.url} target="_blank" rel="noreferrer" title={p.filename}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.filename ?? "Attached image"}
                    className="h-28 max-w-48 rounded-xl object-cover ring-1 ring-foreground/10"
                  />
                </a>
              ) : null,
            )}
          </div>
        )}
        {text && <MessageContent className="group-[.is-user]:rounded-2xl">{text}</MessageContent>}
      </div>
    </Message>
  );
}

function textOf(message: AgentUIMessage) {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** What the agent is doing with each research tool, for the step row while it runs. */
const RESEARCH_LABELS: Record<string, string> = {
  researchStatus: "Checking what research has done",
  getCatalog: "Looking through the catalog",
  detectPlatform: "Checking the platform",
  readSite: "Reading the site",
  classifyOffering: "Deciding goods or services",
  setOffering: "Setting goods or services",
  listSiteLinks: "Listing the site's links",
  findOfferingPages: "Choosing which pages to read",
  loadCatalog: "Loading the catalog",
  removeProducts: "Removing items",
  writeBrandInsights: "Writing the value proposition, audience and voice",
  groupCatalog: "Grouping the catalog and picking heroes",
  setProductTypes: "Setting the types and heroes",
  findPhotos: "Finding photos",
};

type ResearchPart = {
  type: string;
  toolCallId: string;
  state: string;
  input?: { url?: string; guidance?: string };
  output?: { ok: boolean; summary: string };
};

/**
 * One research tool call in the thread, styled like the research steps: a
 * spinner while it runs (with the page or direction it was given), then the
 * step's one-line summary with a check, or a warning when it degraded.
 */
function ResearchStepRow({ part, live }: { part: ResearchPart; live: boolean }) {
  const name = part.type.replace(/^tool-/, "");
  const label = RESEARCH_LABELS[name] ?? name;
  if (part.state === "output-available" && part.output) {
    return (
      <p className="flex items-start gap-2 text-muted-foreground">
        {part.output.ok ? (
          <CheckIcon className="mt-0.5 size-4 shrink-0" />
        ) : (
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-brand-orange" />
        )}
        <span>{part.output.summary}</span>
      </p>
    );
  }
  if (!live) return null; // interrupted before it finished
  const detail = part.input?.url
    ? new URL(part.input.url).pathname
    : part.input?.guidance
      ? `“${part.input.guidance}”`
      : "";
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <Loader2Icon className="size-4 shrink-0 animate-spin" />
      <Shimmer as="span">{`${label}${detail ? ` · ${detail}` : ""}…`}</Shimmer>
    </p>
  );
}

type AdPart = Extract<AgentUIMessage["parts"][number], { type: "tool-generateAd" | "tool-editAd" }>;

/**
 * One generateAd or editAd call: a spinner while fal makes it (about
 * a minute), then a small thumbnail with the summary, or why it failed. The
 * Ads tab holds the full-size ads.
 */
function AdRow({ part, live }: { part: AdPart; live: boolean }) {
  if (part.state === "output-available") {
    const { ok, summary, ad } = part.output;
    return (
      <div className="flex items-start gap-3 text-muted-foreground">
        {ok && ad ? (
          <a href={ad.url} target="_blank" rel="noreferrer" className="shrink-0" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ad.url}
              alt={`Ad: ${ad.headline}`}
              className="aspect-[9/16] w-16 rounded-md object-cover ring-1 ring-foreground/10"
            />
          </a>
        ) : (
          <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <span className="pt-0.5">{summary}</span>
      </div>
    );
  }
  if (!live || part.state === "output-error") return null; // interrupted before it finished
  const headline = part.type === "tool-generateAd" ? part.input?.headline : undefined;
  const text =
    part.type === "tool-editAd"
      ? "Making a new version of the ad…"
      : headline
        ? `Making the ad for “${headline}”…`
        : "Making an ad…";
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <Loader2Icon className="size-4 shrink-0 animate-spin" />
      <Shimmer as="span">{text}</Shimmer>
    </p>
  );
}
