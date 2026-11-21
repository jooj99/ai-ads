"use client";

import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { StartCampaignFields } from "@/components/campaigns/start-campaign-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * "New campaign" without leaving the page: a dialog with the same URL form
 * as Home. Starting one redirects to the new campaign. The field takes focus
 * when the dialog opens (Radix focuses the first focusable element).
 */
export function NewCampaignDialog({ children }: { children?: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {children ?? (
          <Button>
            New campaign
            <ArrowRightIcon />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="gap-5 p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Paste your website URL</DialogTitle>
          <DialogDescription>
            Ploy learns your branding, compiles your products, and creates ads for you.
          </DialogDescription>
        </DialogHeader>
        <StartCampaignFields />
      </DialogContent>
    </Dialog>
  );
}
