import { CampaignGone } from "@/components/campaigns/campaign-gone";

/** A campaign link with no campaign behind it (deleted, or a wrong id). */
export default function CampaignNotFound() {
  return <CampaignGone />;
}
