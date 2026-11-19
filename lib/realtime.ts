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
  /** CAMPAIGNS_TOPIC: a campaign's status, name, logo or current step changed. */
  changed: "changed",
} as const;

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
