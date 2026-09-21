import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Calling Agent",
  description: "Multi-tenant AI voice calling platform — dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
