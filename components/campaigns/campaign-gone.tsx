import { ArrowLeftIcon, FolderXIcon, PlusIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * What a campaign link shows when there's no campaign behind it: it was
 * deleted (here, in another tab, or before the link was opened) or the link
 * is wrong. Used by the page's not-found and by the workspace when its
 * campaign is deleted while it's open.
 */
export function CampaignGone({ deleted = false }: { deleted?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center md:p-10">
      <span className="flex size-14 items-center justify-center rounded-full bg-background ring-1 ring-foreground/10">
        <FolderXIcon className="size-6 text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl leading-none uppercase md:text-5xl">
          {deleted ? "Campaign deleted" : "Campaign not found"}
        </h1>
        <p className="max-w-md text-muted-foreground">
          {deleted
            ? "This campaign was just deleted, along with its brand kit, ads and chat."
            : "This campaign isn't available. It may have been deleted, or the link is wrong."}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline">
          <Link href="/campaigns">
            <ArrowLeftIcon />
            All campaigns
          </Link>
        </Button>
        <Button asChild>
          <Link href="/">
            <PlusIcon />
            Start a campaign
          </Link>
        </Button>
      </div>
    </div>
  );
}
