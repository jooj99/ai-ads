import {
  HouseIcon,
  ImagesIcon,
  MegaphoneIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

/** Primary workspace sections, shown at the top of the sidebar. */
export const mainNav: NavItem[] = [
  { title: "Home", href: "/", icon: HouseIcon },
  { title: "Campaigns", href: "/campaigns", icon: MegaphoneIcon },
  { title: "Assets", href: "/assets", icon: ImagesIcon },
];

/** Secondary sections, pinned to the bottom of the sidebar. */
export const footerNav: NavItem[] = [
  { title: "Settings", href: "/settings", icon: SettingsIcon },
];

/** The nav item that owns a pathname, so nested routes keep their tab active. */
export function navItemFor(pathname: string): NavItem | undefined {
  return [...mainNav, ...footerNav].find((item) =>
    item.href === "/"
      ? pathname === "/"
      : pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
