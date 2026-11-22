/**
 * Supabase Realtime broadcast channels for live updates. The server (secret
 * key) sends; signed-in browsers subscribe. Broadcasts never touch the
 * database tables, which stay locked behind RLS.
 *
 * Every channel is private: joining one is checked against RLS on
 * `realtime.messages` (supabase/migrations/…_private_realtime.sql), which
 * lets signed-in users receive and nobody but the server send. The
 * publishable key ships in every browser, so a public channel would let
 * anyone read campaign names and progress, or post fake updates to open pages.
 */

/** Options every channel is opened with, on the server and in the browser. */
export const CHANNEL = { config: { private: true } } as const;

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
  /** campaignTopic: the campaign was deleted (an open page shows it's gone). */
  deleted: "deleted",
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
