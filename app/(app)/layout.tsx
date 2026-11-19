import { Suspense } from "react";

import { AccountMenu } from "@/components/account-menu";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/** The signed-in app shell: sidebar (with the account menu) and header. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SidebarProvider>
      <AppSidebar
        account={
          // Reads the session cookie (request-time), so it streams in.
          <Suspense fallback={null}>
            <AccountMenu />
          </Suspense>
        }
      />
      <SidebarInset>
        <SiteHeader />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
