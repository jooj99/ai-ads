import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { LiveCampaignGrid } from "@/components/campaigns/live-campaign-grid";
import { NewCampaignDialog } from "@/components/campaigns/new-campaign-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { listCampaigns } from "@/lib/campaigns";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = { title: "Campaigns" };

export default function CampaignsPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 p-6 md:p-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-5xl leading-none uppercase md:text-6xl">Campaigns</h1>
          <p className="max-w-xl text-muted-foreground">
            Each campaign starts from a store URL and holds its brand kit, products and ads.
          </p>
        </div>
        <NewCampaignDialog />
      </div>
      <Suspense fallback={<ListSkeleton />}>
        <CampaignList />
      </Suspense>
    </div>
  );
}

async function CampaignList() {
  await connection(); // always read fresh from the database, never at build time
  await requireUser(); // the proxy checks too; data reads never rely on it alone
  let campaigns: Awaited<ReturnType<typeof listCampaigns>>;
  try {
    campaigns = await listCampaigns();
  } catch (error) {
    console.error("[campaigns] list failed", error);
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Campaigns couldn&apos;t be loaded right now. Refresh to try again.
        </CardContent>
      </Card>
    );
  }

  return <LiveCampaignGrid campaigns={campaigns} />;
}

function ListSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-32 rounded-xl" />
      ))}
    </div>
  );
}
