"use client";

import { AlertTriangleIcon, Loader2Icon, MessageSquarePlusIcon, SearchIcon } from "lucide-react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";

/**
 * What an empty chat shows. New campaigns never see it: their research run
 * opens the thread. It covers campaigns researched before research became
 * the agent's run (they have a kit but no conversation yet), runs that died,
 * and campaigns whose research never produced a kit.
 */
export function ChatStart({
  domain,
  running,
  stale,
  hasKit,
  starting,
  onResearch,
  onStartChat,
}: {
  domain: string;
  /** A research run is going but its thread hasn't loaded yet. */
  running: boolean;
  /** The last run went quiet for 5+ minutes without finishing. */
  stale: boolean;
  hasKit: boolean;
  starting: boolean;
  onResearch: () => void;
  onStartChat: () => void;
}) {
  if (running) {
    return (
      <Shimmer as="p" className="text-sm">
        {`Starting research on ${domain}…`}
      </Shimmer>
    );
  }

  const [icon, text, action] = stale
    ? [
        <AlertTriangleIcon key="i" className="mt-0.5 size-4 shrink-0 text-brand-orange" />,
        "The last research run stopped before it finished.",
        { label: "Restart research", run: onResearch, Icon: SearchIcon },
      ]
    : hasKit
      ? [
          <MessageSquarePlusIcon key="i" className="mt-0.5 size-4 shrink-0" />,
          `Research on ${domain} is done. Ask the agent for headline ideas, or tell it what you want.`,
          { label: "Get headline ideas", run: onStartChat, Icon: MessageSquarePlusIcon },
        ]
      : [
          <SearchIcon key="i" className="mt-0.5 size-4 shrink-0" />,
          `Research hasn't produced a brand kit for ${domain} yet.`,
          { label: "Start research", run: onResearch, Icon: SearchIcon },
        ];

  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border bg-background p-4 text-sm">
      <p className="flex gap-2">
        {icon}
        <span>{text}</span>
      </p>
      <Button size="sm" variant={hasKit && !stale ? "default" : "outline"} onClick={action.run} disabled={starting}>
        {starting ? <Loader2Icon className="animate-spin" /> : <action.Icon />}
        {action.label}
      </Button>
    </div>
  );
}
