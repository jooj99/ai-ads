/* eslint-disable @next/next/no-img-element -- campaign logos come from each store's own CDN. */

import { ArrowRightIcon, MegaphoneIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { DeleteCampaignButton } from "@/components/campaigns/delete-campaign-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { listCampaigns, type CampaignStatus } from "@/lib/campaigns";

export const metadata: Metadata = { title: "Campaigns" };

const STATUS_LABEL: Record<CampaignStatus, string> = {
  researching: "Researching",
  research_failed: "Research failed",
  ready: "Brand kit ready",
};

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
        <Button asChild>
          <Link href="/">
            New campaign
            <ArrowRightIcon />
          </Link>
        </Button>
      </div>
      <Suspense fallback={<ListSkeleton />}>
        <CampaignList />
      </Suspense>
    </div>
  );
}

async function CampaignList() {
  await connection(); // always read fresh from the database, never at build time
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

  if (campaigns.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted">
            <MegaphoneIcon className="size-5" />
          </span>
          <p className="font-medium">No campaigns yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Paste a store URL on Home and the agent will research the brand and pick the products
            to advertise.
          </p>
          <Button asChild className="mt-2">
            <Link href="/">Start a campaign</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const dates = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {campaigns.map((c) => (
        <li key={c.id} className="group relative">
          <Link
            href={`/campaigns/${c.id}`}
            className="group flex h-full flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/25"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white p-1.5 ring-1 ring-foreground/10">
                {c.logo ? (
                  <img src={c.logo} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="font-display text-xl uppercase">{c.name.slice(0, 1)}</span>
                )}
              </span>
              <div className="min-w-0 pr-8">
                <p className="truncate font-medium">{c.name}</p>
                <p className="truncate text-sm text-muted-foreground">{c.domain}</p>
              </div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2">
              <Badge variant={c.status === "ready" ? "secondary" : "outline"}>
                {STATUS_LABEL[c.status]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {c.productCount > 0 &&
                  `${c.productCount} ${c.offering === "services" ? "services" : "products"} · `}
                {dates.format(new Date(c.createdAt))}
              </span>
            </div>
          </Link>
          {/* Outside the link so it never opens the campaign. */}
          <DeleteCampaignButton
            campaignId={c.id}
            name={c.name}
            compact
            className="absolute top-3 right-3 bg-card md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          />
        </li>
      ))}
    </ul>
  );
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
