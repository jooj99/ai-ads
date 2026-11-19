import "server-only";

import {
  editBrandTextSpec,
  editColorsSpec,
  editFontsSpec,
  editTagsSpec,
} from "@/lib/agent/tools";
import { getEditableKit, updateKit, type EditableKit } from "@/lib/campaigns";

type Result = { ok: boolean; summary: string };

/**
 * The agent's brand kit tools for one campaign, with their server-side
 * `execute`. Each reads the current kit (so several edits in one turn build
 * on each other), changes only what it was asked to, saves, and returns a
 * one-line summary for the chat. Failures come back as `ok: false` for the
 * model to report, never as thrown errors.
 */
export function kitTools(campaignId: string) {
  async function edit(
    change: (kit: EditableKit) => { patch: Partial<EditableKit>; summary: string; fields: string[] },
  ): Promise<Result> {
    try {
      const kit = await getEditableKit(campaignId);
      if (!kit) return { ok: false, summary: "There's no brand kit yet; research has to finish first." };
      const { patch, summary, fields } = change(kit);
      // The fields are marked edited, so research re-runs won't overwrite them.
      if (Object.keys(patch).length) await updateKit(campaignId, patch, fields);
      return { ok: true, summary };
    } catch (error) {
      console.error("[agent] brand kit edit failed", error);
      return { ok: false, summary: "Couldn't save that brand kit change." };
    }
  }

  return {
    editBrandText: {
      ...editBrandTextSpec,
      execute: ({ field, text }: { field: string; text: string }) =>
        edit((kit) => {
          const value = text.trim();
          switch (field) {
            case "tagline":
              return { patch: { tagline: value }, summary: "Updated the tagline", fields: ["tagline"] };
            case "valueProposition":
              return {
                patch: { valueProposition: value },
                summary: "Updated the value proposition",
                fields: ["valueProposition"],
              };
            case "audienceDescription":
              return {
                patch: { audience: { ...kit.audience, summary: value } },
                summary: "Updated the audience description",
                fields: ["audience.summary"],
              };
            case "voiceDescription":
              return {
                patch: { voice: { ...kit.voice, summary: value } },
                summary: "Updated the voice description",
                fields: ["voice.summary"],
              };
            default:
              return {
                patch: { voice: { ...kit.voice, sampleLine: value } },
                summary: "Updated the sample line",
                fields: ["voice.sampleLine"],
              };
          }
        }),
    },

    editTags: {
      ...editTagsSpec,
      execute: ({ list, add = [], remove = [] }: { list: "audience" | "voiceTraits"; add?: string[]; remove?: string[] }) =>
        edit((kit) => {
          const current = (list === "audience" ? kit.audience?.segments : kit.voice?.traits) ?? [];
          const { next, added, removed } = editList(current, add, remove, (s) => s.toLowerCase());
          const patch: Partial<EditableKit> =
            list === "audience"
              ? { audience: { ...kit.audience, segments: next } }
              : { voice: { ...kit.voice, traits: next } };
          const noun = list === "audience" ? "audience tag" : "voice trait";
          return {
            patch,
            summary: describe(noun, added, removed),
            fields: [list === "audience" ? "audience.segments" : "voice.traits"],
          };
        }),
    },

    editColors: {
      ...editColorsSpec,
      execute: ({ add = [], remove = [] }: { add?: { hex: string; role: string }[]; remove?: string[] }) =>
        edit((kit) => {
          const hexKey = (hex: string) => hex.trim().toUpperCase();
          const removing = new Set(remove.map(hexKey));
          const kept = kit.colors.filter((c) => !removing.has(hexKey(c.hex)));
          const removed = kit.colors.filter((c) => removing.has(hexKey(c.hex))).map((c) => c.hex);
          const fresh = add
            .map((c) => ({ hex: hexKey(c.hex), role: c.role.trim() }))
            .filter((c, i, all) => !kept.some((k) => hexKey(k.hex) === c.hex) && all.findIndex((x) => x.hex === c.hex) === i);
          return {
            patch: { colors: [...kept, ...fresh].slice(0, 12) },
            summary: describe("color", fresh.map((c) => c.hex), removed),
            fields: ["colors"],
          };
        }),
    },

    editFonts: {
      ...editFontsSpec,
      execute: ({ add = [], remove = [] }: { add?: { family: string; role: string }[]; remove?: string[] }) =>
        edit((kit) => {
          const key = (family: string) => family.trim().toLowerCase();
          const removing = new Set(remove.map(key));
          const kept = kit.fonts.filter((f) => !removing.has(key(f.family)));
          const removed = kit.fonts.filter((f) => removing.has(key(f.family))).map((f) => f.family);
          const fresh = add
            .map((f) => ({ family: f.family.trim(), role: f.role.trim() }))
            .filter((f, i, all) => !kept.some((k) => key(k.family) === key(f.family)) && all.findIndex((x) => key(x.family) === key(f.family)) === i);
          return {
            patch: { fonts: [...kept, ...fresh].slice(0, 8) },
            summary: describe("font", fresh.map((f) => f.family), removed),
            fields: ["fonts"],
          };
        }),
    },
  };
}

/** Removes then adds (case-insensitively, without duplicates), keeping order. */
function editList(current: string[], add: string[], remove: string[], key: (s: string) => string) {
  const removing = new Set(remove.map((s) => key(s.trim())));
  const kept = current.filter((s) => !removing.has(key(s)));
  const removed = current.filter((s) => removing.has(key(s)));
  const added: string[] = [];
  for (const raw of add) {
    const tag = raw.trim();
    if (tag && ![...kept, ...added].some((s) => key(s) === key(tag))) added.push(tag);
  }
  return { next: [...kept, ...added].slice(0, 12), added, removed };
}

function describe(noun: string, added: string[], removed: string[]) {
  const parts = [
    added.length ? `added ${noun}${added.length === 1 ? "" : "s"} ${added.join(", ")}` : "",
    removed.length ? `removed ${removed.join(", ")}` : "",
  ].filter(Boolean);
  if (!parts.length) return `No ${noun} changes were needed`;
  const line = parts.join("; ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
