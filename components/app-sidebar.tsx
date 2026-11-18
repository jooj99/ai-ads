"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { PloyMark } from "@/components/ploy-logo";
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
            <Link
              href={item.href}
              onClick={() => isMobile && setOpenMobile(false)}
            >
              <item.icon />
              <span>{item.title}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const activeHref = navItemFor(pathname)?.href;

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
              <Link href="/">
                <PloyMark />
                <span className="text-lg font-semibold tracking-tight">
                  Ploy Ads
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <NavLinks items={mainNav} activeHref={activeHref} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavLinks items={footerNav} activeHref={activeHref} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
