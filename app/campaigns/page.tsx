import type { Metadata } from "next";
import { MegaphoneIcon } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = { title: "Campaigns" };

export default function CampaignsPage() {
  return (
    <PagePlaceholder
      title="Campaigns"
      description="Group generated ads by goal and product, then review, iterate on, and approve each variant."
      icon={MegaphoneIcon}
      sections={["Drafts", "In review", "Approved"]}
    />
  );
}
