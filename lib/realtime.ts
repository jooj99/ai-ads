/**
 * Supabase Realtime broadcast channels for research news. The server
 * (secret key) sends; browsers (publishable key) subscribe. Broadcasts never
 * touch the database tables, which stay locked behind RLS.
 *
 * These are public channels: anyone with the publishable key and a campaign
 * id could listen. Fine for a single-user demo; with auth, switch to private
 * channels authorized by RLS on realtime.messages.
 */

/** Every campaign's headline changes, for the Campaigns list. */
export const CAMPAIGNS_TOPIC = "campaigns";
/** One campaign's page: told when a research run finishes. */
export const campaignTopic = (id: string) => `campaign:${id}`;

export const EVENTS = {
  /** campaignTopic: a research run ended and its result is saved. */
  finished: "finished",
  /** CAMPAIGNS_TOPIC: a campaign's status, name, logo, current step or ads in progress changed. */
  changed: "changed",
  /** campaignTopic: an ad started, finished, failed or went away (re-read the ads). */
  ads: "ads",
  /** campaignTopic: what an ad being made is doing now, `{ id, stage }`. */
  adStage: "ad_stage",
} as const;

/** Ads in progress for a campaign: new ones being made, and edits being made. */
/** Ads in progress (making new ones, editing), and how many finished ads the campaign has. */
export type AdActivity = { making: number; editing: number; total: number };

export type CampaignChange = {
  id: string;
  /** Left out by ad-activity broadcasts, which don't change the research status. */
  status?: "researching" | "research_failed" | "ready";
  /** Ads in progress, sent whenever one starts or ends. */
  ads?: AdActivity;
  name?: string;
  logo?: string;
  /** Label of the step running now, e.g. "Loading products". */
  step?: string;
  /** ISO time, so clients can ignore changes older than what they've loaded. */
  at: string;
};
