"use client";

/* eslint-disable @next/next/no-img-element -- campaign logos come from each store's own CDN. */

import { Loader2Icon, MegaphoneIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DeleteCampaignButton } from "@/components/campaigns/delete-campaign-button";
import { NewCampaignDialog } from "@/components/campaigns/new-campaign-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CampaignStatus, CampaignSummary } from "@/lib/campaigns";
import { CAMPAIGNS_TOPIC, CHANNEL, EVENTS, type AdActivity, type CampaignChange } from "@/lib/realtime";
import { browserSupabase, subscribeSignedIn } from "@/lib/supabase/browser";

const STATUS_LABEL: Record<CampaignStatus, string> = {
  researching: "Researching",
  research_failed: "Research failed",
  ready: "Brand kit ready",
};

/**
 * Covers the clicked card with a spinner until the campaign page takes over
 * (when its page wasn't prefetched yet), so the click answers at once. Always
 * rendered and faded in, so the card never shifts.
 */
function OpeningOverlay() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/70 transition-opacity duration-150 ${
        pending ? "opacity-100" : "opacity-0"
      }`}
    >
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
    </span>
  );
}

/** Server re-reads (new campaigns, finished runs) at most this often. */
const REFRESH_EVERY_MS = 1_000;

/**
 * The campaign cards, updated live over Supabase Realtime: a running
 * campaign's status, current step, name and logo change in place as research
 * broadcasts them, and so does the count of ads being made or edited. New
 * campaigns and finished runs trigger a server re-read.
 */
export function LiveCampaignGrid({ campaigns }: { campaigns: CampaignSummary[] }) {
  const router = useRouter();
  const [changes, setChanges] = useState<Record<string, CampaignChange>>({});
  // Ads in progress per campaign, from their own broadcasts (kept apart so
  // they never overwrite a research change, and vice versa).
  const [adChanges, setAdChanges] = useState<Record<string, { ads: AdActivity; at: string }>>({});
  const lastRefresh = useRef(0);

  // Load the campaign page's code while the list is idle, so opening a
  // campaign doesn't wait to download it (~340 KB) after the click.
  useEffect(() => {
    const warm = () => void import("@/components/campaigns/campaign-workspace").catch(() => {});
    if ("requestIdleCallback" in window) {
      const handle = requestIdleCallback(warm, { timeout: 3000 });
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(warm, 1500);
    return () => clearTimeout(timer);
  }, []);
  const subscribedBefore = useRef(false);
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
      .channel(CAMPAIGNS_TOPIC, CHANNEL)
      .on("broadcast", { event: EVENTS.changed }, ({ payload }) => {
        const change = payload as CampaignChange;
        if (change.ads) {
          const ads = change.ads;
          setAdChanges((current) =>
            current[change.id] && current[change.id].at >= change.at
              ? current
              : { ...current, [change.id]: { ads, at: change.at } },
          );
        }
        if (!change.status) return; // an ad-activity broadcast only
        // Broadcasts can arrive out of order; keep the newest per campaign.
        setChanges((current) =>
          current[change.id] && current[change.id].at >= change.at
            ? current
            : { ...current, [change.id]: change },
        );
        if (!known.current.has(change.id) || change.status !== "researching") refreshSoon();
      });
    const unsubscribe = subscribeSignedIn(client, channel, (state) => {
      // Subscribed again after being away (this page stays alive, without
      // its subscription, while you're on a campaign): re-read what was missed.
      if (state !== "SUBSCRIBED") return;
      if (subscribedBefore.current) refreshSoon();
      subscribedBefore.current = true;
    });
    return () => {
      if (pending) clearTimeout(pending);
      unsubscribe();
    };
  }, [router]);

  // A broadcast wins over the loaded row only if it's newer.
  const shown = campaigns.map((c) => {
    const change = changes[c.id];
    // Ad counts: a broadcast only beats the server's count if it came later.
    // (This page is kept alive, unsubscribed, while you're on a campaign, so
    // an old "Making 3 ads" broadcast must not outlive the ads it was about.)
    const live = adChanges[c.id];
    const ads = live && live.at > c.adsAt ? live.ads : c.ads;
    if (!change?.status || change.at <= c.updatedAt) return { ...c, ads };
    return {
      ...c,
      ads,
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
            Paste a store URL and the agent will research the brand and pick the products to
            advertise.
          </p>
          <NewCampaignDialog>
            <Button className="mt-2">Start a campaign</Button>
          </NewCampaignDialog>
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((c) => (
        <li key={c.id} className="group relative">
          <Link
            href={`/campaigns/${c.id}`}
            className="group relative flex h-full flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/25 active:ring-foreground/40"
          >
            <OpeningOverlay />
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
              {(() => {
                // Research comes first; after it, ads being made or edited.
                const working = c.status !== "researching" && c.ads.making + c.ads.editing > 0;
                const busy = c.status === "researching" || working;
                return (
                  <Badge variant={busy || c.status !== "ready" ? "outline" : "secondary"} className="max-w-[75%] gap-1.5">
                    {busy && <Loader2Icon className="size-3 animate-spin" />}
                    <span className="truncate">
                      {working
                        ? adsLabel(c.ads)
                        : c.status === "researching" && c.step
                          ? c.step
                          : STATUS_LABEL[c.status]}
                    </span>
                  </Badge>
                );
              })()}
              <span className="shrink-0 text-xs text-muted-foreground">
                {c.ads.total ? `${c.ads.total} ad${c.ads.total === 1 ? "" : "s"}` : "No ads yet"}
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

/** "Making 2 ads…", "Editing an ad…", or "Making 1 ad · editing 1…". */
function adsLabel({ making, editing }: AdActivity) {
  const make = `${making} ad${making === 1 ? "" : "s"}`;
  if (making && editing) return `Making ${make} · editing ${editing}…`;
  if (making) return `Making ${make}…`;
  return `Editing ${editing === 1 ? "an ad" : `${editing} ads`}…`;
}
