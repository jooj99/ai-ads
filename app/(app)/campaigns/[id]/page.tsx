import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { CampaignWorkspace } from "@/components/campaigns/campaign-workspace";
import { Skeleton } from "@/components/ui/skeleton";
import { expireStaleAds } from "@/lib/ads/expire";
import { getCampaignResearch, getChat, listAds, listHeadlines } from "@/lib/campaigns";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = { title: "Campaign" };

export default function CampaignPage({ params }: PageProps<"/campaigns/[id]">) {
  return (
    // The campaign is read per request, so it streams in behind a skeleton.
    <Suspense fallback={<CampaignSkeleton />}>
      <Campaign params={params} />
    </Suspense>
  );
}

async function Campaign({ params }: { params: PageProps<"/campaigns/[id]">["params"] }) {
  await connection(); // always read fresh from the database, never at build time
  await requireUser(); // the proxy checks too; data reads never rely on it alone
  const { id } = await params;
  let research: Awaited<ReturnType<typeof getCampaignResearch>>;
  let messages: Awaited<ReturnType<typeof getChat>>;
  let headlines: Awaited<ReturnType<typeof listHeadlines>>;
  let ads: Awaited<ReturnType<typeof listAds>>;
  try {
    [research, messages, headlines, ads] = await Promise.all([
      getCampaignResearch(id),
      getChat(id),
      listHeadlines(id),
      // Ads that can't finish any more (their run died, or 10+ minutes) show as failed.
      expireStaleAds(id).then(() => listAds(id)),
    ]);
  } catch (error) {
    console.error("[campaigns] load failed", error);
    return (
      <p className="p-6 text-sm text-muted-foreground md:p-10">
        This campaign couldn&apos;t be loaded right now. Refresh to try again.
      </p>
    );
  }
  if (!research) notFound();

  return (
    <CampaignWorkspace
      key={research.campaign.id}
      campaign={research.campaign}
      stale={isStale(research.campaign.status, research.campaign.researchStartedAt)}
      savedKit={research.kit}
      savedMessages={messages}
      savedHeadlines={headlines}
      savedAds={ads}
    />
  );
}

/** A run that hasn't saved progress for 5 minutes died (claim_research uses the same rule). */
function isStale(status: string, heartbeat: string | null): boolean {
  if (status !== "researching" || !heartbeat) return false;
  return Date.now() - new Date(heartbeat).getTime() > 5 * 60_000;
}

function CampaignSkeleton() {
  return (
    <div className="flex flex-col md:h-[calc(100svh-4.5rem)]">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Skeleton className="size-7 rounded-full" />
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="grid flex-1 md:grid-cols-[1fr_minmax(20rem,26rem)]">
        <div className="flex flex-col gap-4 p-5 md:order-2 md:border-l">
          <Skeleton className="ml-auto h-10 w-48 rounded-2xl" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
        <div className="flex flex-col gap-4 bg-muted/60 p-6 md:order-1">
          <Skeleton className="h-9 w-64 rounded-full bg-background" />
          <Skeleton className="h-40 w-full rounded-xl bg-background" />
        </div>
      </div>
    </div>
  );
}
