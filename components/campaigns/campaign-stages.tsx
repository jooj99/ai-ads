import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const STAGES = ["Research", "Headline", "Generate", "Review"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Where the campaign is in the URL → ads loop, as pills: done stages get a
 * check, the current one is the ink pill. Generate and Review aren't built yet.
 */
export function CampaignStages({ current, className }: { current: Stage; className?: string }) {
  const at = STAGES.indexOf(current);
  return (
    <ol className={cn("flex items-center gap-1", className)} aria-label="Campaign progress">
      {STAGES.map((stage, i) => (
        <li
          key={stage}
          aria-current={i === at ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium",
            i === at && "bg-foreground text-background",
            i < at && "text-foreground",
            i > at && "text-muted-foreground",
          )}
        >
          {i < at && <CheckIcon className="size-3.5" />}
          {stage}
        </li>
      ))}
    </ol>
  );
}
