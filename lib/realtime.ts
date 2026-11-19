import type { BrandKit, ResearchNotice, ResearchStep } from "@/lib/research/types";

/**
 * Supabase Realtime broadcast channels for research progress. The server
 * (secret key) sends; browsers (publishable key) subscribe. Broadcasts never
 * touch the database tables, which stay locked behind RLS.
 *
 * These are public channels: anyone with the publishable key and a campaign
 * id could listen. Fine for a single-user demo; with auth, switch to private
 * channels authorized by RLS on realtime.messages.
 */

/** Every campaign's headline changes, for the Campaigns list. */
export const CAMPAIGNS_TOPIC = "campaigns";
/** One campaign's full research progress, for its page. */
export const campaignTopic = (id: string) => `campaign:${id}`;

export const EVENTS = {
  /** campaignTopic: the run's current state. */
  progress: "progress",
  /** campaignTopic: the run ended and its result is saved. */
  finished: "finished",
  /** CAMPAIGNS_TOPIC: a campaign's status, name, logo or current step changed. */
  changed: "changed",
} as const;

export type ProgressPayload = {
  /** Increases with every broadcast of a run; broadcasts can arrive out of order. */
  seq: number;
  steps: ResearchStep[];
  /** The kit so far, without the full catalog (that's read from the database at the end). */
  kit: BrandKit | null;
  notice: ResearchNotice | null;
};

export type CampaignChange = {
  id: string;
  status: "researching" | "research_failed" | "ready";
  name?: string;
  logo?: string;
  /** Label of the step running now, e.g. "Loading products". */
  step?: string;
  /** ISO time, so clients can ignore changes older than what they've loaded. */
  at: string;
};
