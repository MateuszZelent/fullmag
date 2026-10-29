import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = process.cwd();
const stylesRoot = path.join(appRoot, "src/design/styles");
const locallyScopedCssVars = new Set([
  "--depth",
  "--fm-results-navigator-depth",
  "--fm-mesh-build-progress",
  "--fm-planar-aspect",
  "--fm-refresh-progress",
  "--pct",
  "--radix-accordion-content-height",
  "--radix-select-content-available-height",
  "--radix-select-trigger-width",
]);

function readAppFile(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

describe("control-room design styles", () => {
  it("keeps app/globals.css as a CSS entrypoint with bounded Tailwind sources", () => {
    const globalsCss = readAppFile("app/globals.css").trim();

    const statements = globalsCss.split("\n").filter(Boolean);
    expect(statements.length).toBeGreaterThan(20);
    expect(
      statements.every(
        (statement) =>
          statement.startsWith("@import ") || statement.startsWith("@source "),
      ),
    ).toBe(true);
    expect(statements.slice(0, 4)).toEqual([
      '@import "../src/design/styles/fonts.css";',
      '@import "tailwindcss" source(none);',
      '@source "./**/*.{html,js,cjs,mjs,ts,cts,mts,jsx,tsx,md,mdx,json,css,mx3,vue,svelte}";',
      '@source "../src/**/*.{html,js,cjs,mjs,ts,cts,mts,jsx,tsx,md,mdx,json,css,mx3,vue,svelte}";',
    ]);
    expect(globalsCss).toContain('inspector-visualization.css" layer(fm-modules)');
  });

  it("loads the bundled UI and monospaced variable fonts from local assets", () => {
    const fontsCss = readAppFile("src/design/styles/fonts.css");
    const interFont = path.join(appRoot, "public/fonts/InterVariable-v4.1.woff2");
    const jetBrainsMonoFont = path.join(
      appRoot,
      "public/fonts/JetBrainsMono-Variable-v2.304.ttf",
    );

    expect(fontsCss).toContain('font-family: "Inter";');
    expect(fontsCss).toContain('font-family: "JetBrains Mono";');
    expect(fontsCss).toContain('src: url("/fonts/InterVariable-v4.1.woff2")');
    expect(fontsCss).toContain('src: url("/fonts/JetBrainsMono-Variable-v2.304.ttf")');
    expect(fontsCss.match(/font-display: swap;/g)).toHaveLength(2);
    expect(existsSync(interFont)).toBe(true);
    expect(existsSync(jetBrainsMonoFont)).toBe(true);
  });

  it("defines light and dark themes through central fm tokens", () => {
    const tokensCss = readAppFile("src/design/styles/tokens.css");
    const themeCss = readAppFile("src/design/styles/theme.css");

    expect(tokensCss).toContain("--fm-bg-app");
    expect(tokensCss).toContain("--fm-font-ui");
    expect(themeCss).toContain('[data-theme="dark"]');
    expect(themeCss).toContain('[data-theme="light"]');
    expect(themeCss).not.toContain("--background");
  });

  it("bridges canonical Fullmag tokens into Tailwind without palette copies", () => {
    const globalsCss = readAppFile("app/globals.css");
    const bridgeCss = readAppFile("src/design/styles/tailwind-theme.css");

    expect(globalsCss.indexOf('tailwind-theme.css"')).toBeGreaterThan(
      globalsCss.indexOf('@import "tailwindcss" source(none);'),
    );
    expect(globalsCss.indexOf('tailwind-theme.css"')).toBeLessThan(
      globalsCss.indexOf('tokens.css"'),
    );
    expect(bridgeCss).toContain("@theme inline");
    expect(bridgeCss).toContain("--color-fm-panel: var(--fm-bg-panel);");
    expect(bridgeCss).toContain(
      "--spacing-fm-control-sm: var(--fm-control-height-sm);",
    );
    expect(bridgeCss).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it("maps dark and light themes to Catppuccin Mocha and Latte", () => {
    const themeCss = readAppFile("src/design/styles/theme.css");

    expect(themeCss).toContain("--fm-bg-app: #1e1e2e;");
    expect(themeCss).toContain("--fm-bg-viewport: #11111b;");
    expect(themeCss).toContain("--fm-text-primary: #cdd6f4;");
    expect(themeCss).toContain("--fm-accent: #89b4fa;");
    expect(themeCss).toContain("--fm-info: #89dceb;");
    expect(themeCss).toContain("--fm-bg-app: #eff1f5;");
    expect(themeCss).toContain("--fm-bg-viewport: #dce0e8;");
    expect(themeCss).toContain("--fm-text-primary: #4c4f69;");
    expect(themeCss).toContain("--fm-accent: #1e66f5;");
    expect(themeCss).toContain("--fm-info: #04a5e5;");
  });

  it("keeps raw palette values out of the start-screen token layer", () => {
    const startTokens = readAppFile("src/design/styles/start-screen.tokens.css")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Colours resolve through theme.css; only comments may quote hex values.
    expect(startTokens).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(startTokens).toContain("--fm-start-meta: var(--fm-text-tertiary);");
  });

  it("keeps motion tokens concrete and action text theme-aware", () => {
    const tokensCss = readAppFile("src/design/styles/tokens.css");
    const themeCss = readAppFile("src/design/styles/theme.css");
    const primitivesCss = readAppFile("src/design/styles/primitives.css");

    expect(tokensCss).toContain("--fm-duration-instant: 80ms;");
    expect(tokensCss).toContain("--fm-duration-fast: 120ms;");
    expect(tokensCss).toContain("--fm-duration-normal: 180ms;");
    expect(tokensCss).toContain("--fm-duration-moderate: 240ms;");
    expect(tokensCss).toContain("--fm-duration-slow: 360ms;");
    expect(tokensCss).toContain("--fm-duration-loading: 1000ms;");
    expect(tokensCss).not.toMatch(
      /(--fm-duration-(?:instant|fast|normal|moderate|slow|loading)):\s*var\(\1\)/,
    );
    expect(themeCss).toContain("--fm-text-on-accent: #1e1e2e;");
    expect(themeCss).toContain("--fm-text-on-accent: #ffffff;");
    expect(primitivesCss).toMatch(
      /\.fm-button--primary\s*\{[^}]*color: var\(--fm-text-on-accent\);/,
    );
    expect(primitivesCss).toMatch(
      /\.fm-button--primary:hover[^\{]*\{[^}]*color: var\(--fm-text-on-accent\);/,
    );
    expect(primitivesCss).not.toMatch(
      /\.fm-button--primary[^\{]*\{[^}]*!important/,
    );
    expect(primitivesCss).not.toMatch(
      /\.fm-button--primary[^\{]*\{[^}]*color:\s*white\b/,
    );
  });

  it("keeps Explorer semantic icon colors in the Catppuccin token system", () => {
    const explorerCss = readAppFile("src/design/styles/explorer.css");
    const themeCss = readAppFile("src/design/styles/theme.css");

    expect(explorerCss).not.toMatch(/color:\s*#[\da-f]{3,8}\b/i);
    expect(explorerCss).toContain("--fm-explorer-icon-results");
    expect(themeCss).toContain("--fm-explorer-icon-results:");
    expect(themeCss).toContain('[data-theme="light"]');
  });

  it("styles resource failures as bounded danger notifications", () => {
    const notificationsCss = readAppFile(
      "src/design/styles/dialog-notifications.css",
    );

    expect(notificationsCss).toContain(
      '.fm-notifications__toast[data-kind="error"]',
    );
    expect(notificationsCss).toContain("var(--fm-danger)");
    expect(notificationsCss).toContain("max-height:");
    expect(notificationsCss).toContain("overflow-y: auto;");
  });

  it("keeps Inspector select indicators token-aware", () => {
    const inspectorCss = readAppFile("src/design/styles/inspector.css");

    expect(inspectorCss).toContain("--fm-text-muted");
    expect(inspectorCss).not.toContain("data:image/svg+xml");
    expect(inspectorCss).not.toContain("%23");
  });

  it("keeps footer tab content inside the resizable dock height", () => {
    const footerCss = readAppFile("src/design/styles/footer.css");
    const footerModule = readAppFile("src/modules/footer/FooterModule.tsx");

    expect(footerCss).toContain(
      ".fm-footer__content {\n  display: flex;",
    );
    expect(footerCss).toContain(".fm-footer__log-content > .fm-footer-log");
    expect(footerCss).toContain("flex: 1 1 auto;");
    expect(footerModule).toContain(
      "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
    );
    expect(footerModule).toContain("[&>*]:h-full");
  });

  it("keeps ribbon action status dot and menu chevron in separate corners", () => {
    const ribbonCss = readAppFile("src/design/styles/ribbon.css");

    expect(ribbonCss).toMatch(
      /\.fm-ribbon-action__status\s*\{[^}]*top:\s*4px;[^}]*left:\s*5px;/,
    );
    expect(ribbonCss).toMatch(
      /\.fm-ribbon-action__chevron\s*\{[^}]*top:\s*3px;[^}]*right:\s*3px;/,
    );
  });

  it("spaces status bar dot and adjacent engine/method pills", () => {
    const slotsCss = readAppFile("src/design/styles/slots.css");

    expect(slotsCss).toMatch(
      /\.fm-status-bar__dot\s*\{[^}]*margin-inline-end:\s*var\(--fm-space-1\);/,
    );
    expect(slotsCss).toContain(".fm-status-bar__engine + .fm-status-bar__engine");
    expect(slotsCss).toContain(
      ".fm-status-bar__compute-cta + .fm-status-bar__engine",
    );
  });

  it("defines every shared CSS custom property used by design styles", () => {
    const defined = new Set<string>();
    const used = new Set<string>();

    for (const filePath of listCssFiles(stylesRoot)) {
      const css = readFileSync(filePath, "utf8");
      for (const match of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
        defined.add(match[1]);
      }
      for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
        used.add(match[1]);
      }
    }

    const missing = [...used]
      .filter((name) => !defined.has(name) && !locallyScopedCssVars.has(name))
      .sort();

    expect(missing).toEqual([]);
  });
});

function listCssFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const filePath = path.join(directory, entry);
      if (statSync(filePath).isDirectory()) return listCssFiles(filePath);
      return filePath.endsWith(".css") ? [filePath] : [];
    })
    .sort();
}
