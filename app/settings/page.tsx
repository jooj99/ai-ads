import type { Metadata } from "next";
import { SettingsIcon } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      description="Your brand kit (logo, colors, voice) and workspace preferences."
      icon={SettingsIcon}
      sections={["Brand kit", "Store connection", "Workspace"]}
    />
  );
}
