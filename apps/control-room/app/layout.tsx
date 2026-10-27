import type { Metadata } from "next";
import "./globals.css";

import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_PREFERENCE,
  THEME_BOOTSTRAP_SCRIPT,
} from "@/design/theme/themePreference";
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
    <html
      lang="en"
      data-theme={DEFAULT_THEME_MODE}
      data-theme-preference={DEFAULT_THEME_PREFERENCE}
      suppressHydrationWarning
    >
      <head>
        <script
          id="fm-theme-prepaint"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
        <link
          rel="preload"
          href="/fonts/InterVariable-v4.1.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body suppressHydrationWarning>
        <a href="#fm-main-content" className="fm-skip-link">
          Skip to main content
        </a>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
