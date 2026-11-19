import type { Metadata } from "next";
import { Anton, Geist, Geist_Mono } from "next/font/google";

import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Condensed display face standing in for Ploy's FK Screamer headlines.
const anton = Anton({
  variable: "--font-anton",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Ploy", template: "%s · Ploy" },
  description: "Portrait ad creatives from your store",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${anton.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* The app shell (sidebar + header) lives in app/(app)/layout.tsx; /login has none. */}
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
