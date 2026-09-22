import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Design-system typography (UI/UX pass): a single self-hosted professional
// sans-serif, exposed as --font-inter and consumed by globals.css's
// --font-sans. Not brand-specific — just the platform's default type, same
// as Navy/Gold is the default *color* theme (reseller_branding can't
// override fonts today, only colors/logo — see docs/RESELLER_HIERARCHY.md).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "AI Calling Agent",
  description: "Multi-tenant AI voice calling platform — dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
