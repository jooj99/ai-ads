import Image from "next/image";

import { StartCampaignForm } from "@/components/campaigns/start-campaign-form";
import balloons from "@/public/brand/ploy-balloons.webp";

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 p-6 md:p-10">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-5xl leading-none uppercase md:text-6xl">
          Start Ployin&apos;
        </h1>
        <p className="max-w-xl text-muted-foreground">
          Paste your store&apos;s URL to start a campaign. Ploy learns your branding, compiles your
          products, and creates ads for you.
        </p>
      </div>

      <StartCampaignForm />

      {/* Ploy's inflatable wordmark, from the foot of ploy.ai, fills the space below. */}
      <div className="pointer-events-none mt-auto flex justify-center" aria-hidden="true">
        <Image
          src={balloons}
          alt=""
          priority
          sizes="(min-width: 1024px) 768px, 100vw"
          className="-my-[8%] w-full max-w-3xl select-none"
        />
      </div>
    </div>
  );
}
