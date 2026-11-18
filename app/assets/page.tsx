import type { Metadata } from "next";
import { ImagesIcon } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = { title: "Assets" };

export default function AssetsPage() {
  return (
    <PagePlaceholder
      title="Assets"
      description="Product photos pulled from your store and the finished ad images, all in one library."
      icon={ImagesIcon}
      sections={["Product photos", "Generated ads", "Brand files"]}
    />
  );
}
