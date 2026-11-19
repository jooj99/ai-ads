"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { PloyAdsLogo, PloyMark } from "@/components/ploy-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { footerNav, mainNav, navItemFor, type NavItem } from "@/lib/nav";

// Active tab is an ink pill with white text, echoing ploy.ai's primary buttons.
const navButtonClass =
  "h-9 rounded-full px-3 font-medium text-sidebar-foreground/80 data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground data-active:hover:bg-sidebar-primary data-active:hover:text-sidebar-primary-foreground";

function NavLinks({ items, activeHref }: { items: NavItem[]; activeHref?: string }) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu className="gap-1">
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton
            asChild
            isActive={item.href === activeHref}
            tooltip={item.title}
            className={navButtonClass}
          >
            <Link href={item.href} onClick={() => isMobile && setOpenMobile(false)}>
              <item.icon />
              <span>{item.title}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/**
 * Reading the URL is request-time data under Cache Components, so the
 * highlighted links render inside <Suspense>; the fallback is the same links
 * without a highlight, so the prerendered shell never shows an empty sidebar.
 */
function ActiveNavLinks({ items }: { items: NavItem[] }) {
  const activeHref = navItemFor(usePathname())?.href;
  return <NavLinks items={items} activeHref={activeHref} />;
}

function Nav({ items }: { items: NavItem[] }) {
  return (
    <Suspense fallback={<NavLinks items={items} />}>
      <ActiveNavLinks items={items} />
    </Suspense>
  );
}

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip="Ploy Ads"
              className="hover:bg-transparent active:bg-transparent"
            >
              <Link href="/" aria-label="Ploy Ads home">
                {/* Collapsed to icons: just the "p" tile. */}
                <PloyMark className="hidden group-data-[collapsible=icon]:flex" />
                <PloyAdsLogo className="pl-1.5 group-data-[collapsible=icon]:hidden" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <Nav items={mainNav} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <Nav items={footerNav} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
