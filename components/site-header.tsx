"use client";

import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { navItemFor } from "@/lib/nav";

function PageTitle() {
  return <span className="text-sm font-medium">{navItemFor(usePathname())?.title}</span>;
}

export function SiteHeader() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator
        orientation="vertical"
        className="mr-1 data-vertical:h-4 data-vertical:self-center"
      />
      {/* The URL is request-time data; the title streams in with it. */}
      <Suspense>
        <PageTitle />
      </Suspense>
    </header>
  );
}
