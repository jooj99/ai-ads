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

/**
 * Ploy's wordmark, the exact paths of the inline SVG in ploy.ai's header
 * (`data-el="ploy-logo"`), drawn in `currentColor`.
 */
export function PloyWordmark({ className }: { className?: string }) {
  return (
    // Sized with !important: the sidebar's menu button shrinks any svg inside it to 16px.
    <svg
      viewBox="0 0 65 24"
      className={cn("h-8! w-[87px]! shrink-0", className)}
      fill="currentColor"
      role="img"
      aria-label="Ploy"
    >
      <path d="M12.8046 4.90723C24.2214 4.73166 24.2187 19.2689 12.8046 19.0928C6.05132 18.9304 5.26692 15.2347 5.26175 15.21H5.02791L5.48491 24H0V5.33301H5.48491C5.48002 5.3759 5.01708 8.79697 5.02015 8.79004H5.26175C5.26015 8.78125 6.04293 5.0646 12.8046 4.90723Z" />
      <path d="M54.9888 12.8008L58.9019 5.33301H65L55.1751 24H49.1041L52.0596 18.374L44.8709 5.33301H51.0486L54.9888 12.8008Z" />
      <path d="M37.6376 4.90723C42.7763 4.90724 46.1836 7.73329 46.1836 12C46.1836 16.2667 42.7763 19.0928 37.6376 19.0928C32.4988 19.0928 29.0905 16.2666 29.0905 12C29.0905 7.73347 32.4988 4.90723 37.6376 4.90723Z" />
      <path d="M27.9097 18.667H22.5315V0H27.9097V18.667Z" />
    </svg>
  );
}

/** The app's logo: Ploy's wordmark followed by an ink "Ads" pill in Ploy's yellow. */
export function PloyAdsLogo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-foreground", className)}>
      <PloyWordmark />
      {/* Proportions from the reference lockup: ~3/4 the wordmark's height. */}
      <span className="rounded-full bg-foreground px-3 py-[3px] text-[13px] leading-[18px] font-bold text-brand-yellow">
        Ads
      </span>
    </span>
  );
}
