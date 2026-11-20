/**
 * Ad copy rules shared by the server and the browser. Ads never show emojis:
 * they're stripped from headlines and CTAs wherever copy is saved, shown on
 * an idea card or sent to the image model. ©, ® and ™ count as pictographs
 * in Unicode but are part of brand names ("StoptheDrop®"), so they stay.
 */
const EMOJI = /(?![©®™])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** The copy without emojis, spaces tidied. */
export function withoutEmoji(text: string): string {
  return text.replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();
}
