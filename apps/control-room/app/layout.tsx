import type { Metadata } from "next";
import "./globals.css";

import { DEFAULT_THEME_MODE } from "@/design/theme/themePreference";
import { ThemeProvider } from "@/design/theme/ThemeProvider";

export const metadata: Metadata = {
  title: "Fullmag Control Room",
  description: "Modular Fullmag frontend v2 control room for web and desktop.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme={DEFAULT_THEME_MODE} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
