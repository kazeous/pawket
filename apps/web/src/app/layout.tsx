import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/chivo/600.css";
import "@fontsource/chivo/700.css";
import "@fontsource/chivo/800.css";
import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pawket",
  description: "Pawket — không gian làm việc cho nhà sáng tạo.",
  referrer: "strict-origin-when-cross-origin",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
