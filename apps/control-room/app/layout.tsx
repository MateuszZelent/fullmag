import type { Metadata } from "next";
import "./globals.css";

import { DEFAULT_THEME_MODE } from "@/design/theme/themePreference";
import { ThemeProvider } from "@/design/theme/ThemeProvider";

export const metadata: Metadata = {
  title: "Fullmag Control Room",
  description: "Modular Fullmag frontend v2 control room for web and desktop.",
  icons: {
    icon: "/brand/fullmag-logo-vector.svg",
    shortcut: "/brand/fullmag-logo-vector.svg",
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
        <a href="#fm-main-content" className="fm-skip-link">
          Skip to main content
        </a>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
