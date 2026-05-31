import type { Metadata } from "next";
import Script from "next/script";
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
      <body>
        <Script
          id="fullmag-temporary-viewport-3d-diagnostic-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
window.__FULLMAG_CONFIG__ = {
  ...(window.__FULLMAG_CONFIG__ || {}),
  disablePerformanceDiagnostics: false,
  disableViewport3DCanvasLifecycleProbe: false,
  disableViewport3DOverlayLayers: false,
  disableViewport3DDimensionFrame: false,
  disableViewport3DDimensionFrameLabels: false,
  disableViewport3DDimensionFrameLines: false,
  disableViewport3DDimensionFrameMajorLines: false,
  disableViewport3DDimensionFrameMinorLines: false,
  disableViewport3DSceneLayers: false,
  disableViewport3DFdmCuboidLayer: false,
  disableViewport3DAirboxLayer: false,
  disableViewport3DPrimitiveObjectLayer: false,
  disableViewport3DTopologyMeshLayer: false,
  disableViewport3DMeshSizeHighlightLayer: false,
  disableViewport3DOrientationHud: false,
  disableViewport3DPostProcessing: false,
};
`,
          }}
        />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
