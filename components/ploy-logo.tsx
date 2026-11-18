import { cn } from "@/lib/utils";

/**
 * Ploy's mark: the "p" from the ploy.ai wordmark, white on an ink tile,
 * matching the site's favicon.
 */
export function PloyMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground",
        className,
      )}
    >
      <svg
        viewBox="0 4.9 21.5 19.1"
        className="h-3.5 w-auto translate-x-px"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12.8046 4.90723C24.2214 4.73166 24.2187 19.2689 12.8046 19.0928C6.05132 18.9304 5.26692 15.2347 5.26175 15.21H5.02791L5.48491 24H0V5.33301H5.48491C5.48002 5.3759 5.01708 8.79697 5.02015 8.79004H5.26175C5.26015 8.78125 6.04293 5.0646 12.8046 4.90723Z" />
      </svg>
    </span>
  );
}
