"use client";

/* eslint-disable @next/next/no-img-element -- campaign logos come from each store's own CDN. */

import { Loader2Icon, MegaphoneIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DeleteCampaignButton } from "@/components/campaigns/delete-campaign-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CampaignStatus, CampaignSummary } from "@/lib/campaigns";
import { CAMPAIGNS_TOPIC, EVENTS, type CampaignChange } from "@/lib/realtime";
import { browserSupabase } from "@/lib/supabase/browser";

const STATUS_LABEL: Record<CampaignStatus, string> = {
  researching: "Researching",
  research_failed: "Research failed",
  ready: "Brand kit ready",
};

/** Server re-reads (new campaigns, finished runs) at most this often. */
const REFRESH_EVERY_MS = 1_000;

/**
 * The campaign cards, updated live over Supabase Realtime: a running
 * campaign's status, current step, name and logo change in place as research
 * broadcasts them. New campaigns and finished runs trigger a server re-read
 * (for product counts and anything not in the broadcast).
 */
export function LiveCampaignGrid({ campaigns }: { campaigns: CampaignSummary[] }) {
  const router = useRouter();
  const [changes, setChanges] = useState<Record<string, CampaignChange>>({});
  const lastRefresh = useRef(0);
  // Ids already loaded; a broadcast about any other id means a new campaign.
  const known = useRef(new Set<string>());
  useEffect(() => {
    known.current = new Set(campaigns.map((c) => c.id));
  }, [campaigns]);

  useEffect(() => {
    const client = browserSupabase();
    if (!client) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (pending) return;
      const wait = Math.max(0, REFRESH_EVERY_MS - (Date.now() - lastRefresh.current));
      pending = setTimeout(() => {
        pending = null;
        lastRefresh.current = Date.now();
        router.refresh();
      }, wait);
    };
    const channel = client
      .channel(CAMPAIGNS_TOPIC)
      .on("broadcast", { event: EVENTS.changed }, ({ payload }) => {
        const change = payload as CampaignChange;
        // Broadcasts can arrive out of order; keep the newest per campaign.
        setChanges((current) =>
          current[change.id] && current[change.id].at >= change.at
            ? current
            : { ...current, [change.id]: change },
        );
        if (!known.current.has(change.id) || change.status !== "researching") refreshSoon();
      })
      .subscribe();
    return () => {
      if (pending) clearTimeout(pending);
      void client.removeChannel(channel);
    };
  }, [router]);

  // A broadcast wins over the loaded row only if it's newer.
  const shown = campaigns.map((c) => {
    const change = changes[c.id];
    if (!change || change.at <= c.updatedAt) return c;
    return {
      ...c,
      status: change.status,
      name: change.name ?? c.name,
      logo: change.logo ?? c.logo,
      step: change.status === "researching" ? (change.step ?? c.step) : undefined,
    };
  });

  if (shown.length === 0) {
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
      {shown.map((c) => (
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
              <Badge
                variant={c.status === "ready" ? "secondary" : "outline"}
                className="max-w-[65%] gap-1.5"
              >
                {c.status === "researching" && <Loader2Icon className="size-3 animate-spin" />}
                <span className="truncate">
                  {c.status === "researching" && c.step ? c.step : STATUS_LABEL[c.status]}
                </span>
              </Badge>
              <span className="shrink-0 text-xs text-muted-foreground">
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
