import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { CampaignResearch } from "@/components/campaigns/campaign-research";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCampaignResearch } from "@/lib/campaigns";

export const metadata: Metadata = { title: "Campaign" };

export default function CampaignPage({ params }: PageProps<"/campaigns/[id]">) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 md:p-10">
      {/* Outside Suspense, so it's part of the static shell and shows instantly. */}
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 w-fit text-muted-foreground">
        <Link href="/campaigns">
          <ArrowLeftIcon />
          All campaigns
        </Link>
      </Button>
      {/* The campaign is read per request, so it streams in behind a skeleton. */}
      <Suspense fallback={<CampaignSkeleton />}>
        <Campaign params={params} />
      </Suspense>
    </div>
  );
}

async function Campaign({ params }: { params: PageProps<"/campaigns/[id]">["params"] }) {
  await connection(); // always read fresh from the database, never at build time
  const { id } = await params;
  let research: Awaited<ReturnType<typeof getCampaignResearch>>;
  try {
    research = await getCampaignResearch(id);
  } catch (error) {
    console.error("[campaigns] load failed", error);
    return (
      <p className="text-sm text-muted-foreground">
        This campaign couldn&apos;t be loaded right now. Refresh to try again.
      </p>
    );
  }
  if (!research) notFound();

  return (
    <CampaignResearch
      key={research.campaign.id}
      campaign={research.campaign}
      savedKit={research.kit}
      savedSteps={research.steps}
      savedNotice={research.notice}
    />
  );
}

function CampaignSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-14 w-72" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
