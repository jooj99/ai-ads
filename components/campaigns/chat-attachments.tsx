"use client";

import type { FileUIPart } from "ai";
import { ImagePlusIcon, XIcon } from "lucide-react";

import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { InputGroupButton } from "@/components/ui/input-group";

/** What the chat accepts: the formats Nano Banana and the model both read. */
export const ACCEPTED_IMAGES = "image/png,image/jpeg,image/webp";
export const MAX_ATTACHMENTS = 4;
/** Bigger files are fine to pick; they're shrunk before upload. */
export const MAX_PICK_BYTES = 25 * 1024 * 1024;

/** Longest side an attached image is uploaded at; enough for the image model as a reference. */
const MAX_SIDE = 2048;
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;

/** The paperclip: opens the file picker (paste and drop work too). */
export function AttachButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <InputGroupButton
      type="button"
      size="icon-sm"
      variant="ghost"
      className="rounded-full text-muted-foreground"
      aria-label="Attach images"
      title="Attach images (or paste / drop them)"
      disabled={disabled || attachments.files.length >= MAX_ATTACHMENTS}
      onClick={() => attachments.openFileDialog()}
    >
      <ImagePlusIcon />
    </InputGroupButton>
  );
}

/** Thumbnails of the images about to be sent, each removable. */
export function AttachmentPreviews() {
  const attachments = usePromptInputAttachments();
  if (!attachments.files.length) return null;
  return (
    // Its own row above the text: the input group wraps (see campaign-chat.tsx).
    <div className="order-first flex w-full basis-full flex-wrap gap-2 px-3 pt-3">
      {attachments.files.map((file) => (
        <div key={file.id} className="group relative size-14 overflow-hidden rounded-lg ring-1 ring-foreground/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={file.url} alt={file.filename ?? "Attached image"} className="size-full object-cover" />
          <button
            type="button"
            onClick={() => attachments.remove(file.id)}
            aria-label={`Remove ${file.filename ?? "image"}`}
            className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Uploads the images picked in the input (data URLs from PromptInput) to
 * the campaign's private uploads, shrinking big ones first, and returns the
 * file parts to send: our own URL instead of base64. Throws with a message
 * the chat can show.
 */
export async function uploadAttachments(campaignId: string, files: FileUIPart[]): Promise<FileUIPart[]> {
  return Promise.all(
    files.map(async (file) => {
      const blob = await shrink(await (await fetch(file.url)).blob());
      const form = new FormData();
      form.append("file", blob, file.filename ?? "image");
      const res = await fetch(`/api/campaigns/${campaignId}/uploads`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as FileUIPart & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "An image couldn't be uploaded.");
      return { type: "file", mediaType: body.mediaType, url: body.url, filename: body.filename };
    }),
  );
}

/** Scales an image down to MAX_SIDE (as WebP, which keeps transparency) when it's larger than needed. */
async function shrink(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && blob.size <= MAX_UPLOAD_BYTES) {
    bitmap.close();
    return blob;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image couldn't be read."))), "image/webp", 0.9),
  );
}
