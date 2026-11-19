"use client";

import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteCampaignAction } from "@/app/campaigns/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Deletes a campaign after confirmation. On a campaign's own page it returns
 * to the list; on the list the server action's revalidation refreshes it.
 */
export function DeleteCampaignButton({
  campaignId,
  name,
  compact = false,
  goToList = false,
  className,
}: {
  campaignId: string;
  name: string;
  /** Icon-only, for campaign cards. */
  compact?: boolean;
  goToList?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, startDeleting] = useTransition();

  function confirm(event: React.MouseEvent) {
    event.preventDefault(); // keep the dialog open until the delete finishes
    setError(undefined);
    startDeleting(async () => {
      const result = await deleteCampaignAction(campaignId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (goToList) router.push("/campaigns");
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {compact ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${name}`}
            className={cn("text-muted-foreground hover:text-destructive", className)}
          >
            <Trash2Icon />
          </Button>
        ) : (
          <Button variant="ghost" className={cn("text-muted-foreground hover:text-destructive", className)}>
            <Trash2Icon />
            Delete
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the campaign with its brand kit and products. It can&apos;t be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting && <Loader2Icon className="animate-spin" />}
            Delete campaign
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
