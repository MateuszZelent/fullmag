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
  "--radix-popover-content-available-height",
  "--radix-select-content-available-height",
  "--radix-select-trigger-width",
  "--scroll-width",
  "--truncated",
]);

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function readAppFile(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

function extractThemeBlock(themeCss: string, selector: string): string {
  const start = themeCss.indexOf(`${selector} {`);
  expect(start, `Missing block ${selector} in theme.css`).toBeGreaterThanOrEqual(0);
  return themeCss.slice(start, themeCss.indexOf("\n}", start));
}

function parseTokenDeclarations(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/^\s*(--fm-[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/gm)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

function parseColor(raw: string): Rgba {
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hexMatch) {
    const digits = hexMatch[1]!;
    const expanded =
      digits.length === 3
        ? digits
            .split("")
            .map((char) => char + char)
            .join("")
        : digits;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16) / 255,
      g: Number.parseInt(expanded.slice(2, 4), 16) / 255,
      b: Number.parseInt(expanded.slice(4, 6), 16) / 255,
      a: 1,
    };
  }

  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i.exec(
      raw,
    );
  if (rgbMatch) {
    const rawAlpha = rgbMatch[4];
    const alpha =
      rawAlpha === undefined
        ? 1
        : rawAlpha.endsWith("%")
          ? Number.parseFloat(rawAlpha) / 100
          : Number.parseFloat(rawAlpha);
    return {
      r: Number.parseFloat(rgbMatch[1]!) / 255,
      g: Number.parseFloat(rgbMatch[2]!) / 255,
      b: Number.parseFloat(rgbMatch[3]!) / 255,
      a: alpha,
    };
  }

  throw new Error(`Unsupported CSS color format in WCAG verification: "${raw}"`);
}

function resolveTokenColor(
  tokens: Map<string, string>,
  tokenName: string,
  visited = new Set<string>(),
): Rgba {
  if (visited.has(tokenName)) {
    throw new Error(`Circular token alias detected for ${tokenName}`);
  }
  visited.add(tokenName);
  const raw = tokens.get(tokenName);
  if (!raw) throw new Error(`Missing token ${tokenName} in theme.css`);
  const alias = /^var\(\s*(--fm-[a-zA-Z0-9_-]+)\s*\)$/.exec(raw);
  if (alias?.[1]) return resolveTokenColor(tokens, alias[1], visited);
  return parseColor(raw);
}

function compositeOver(foreground: Rgba, backdrop: Rgba): Rgba {
  const alpha = foreground.a;
  if (alpha >= 1) return { r: foreground.r, g: foreground.g, b: foreground.b, a: 1 };
  return {
    r: foreground.r * alpha + backdrop.r * (1 - alpha),
    g: foreground.g * alpha + backdrop.g * (1 - alpha),
    b: foreground.b * alpha + backdrop.b * (1 - alpha),
    a: 1,
  };
}

function relativeLuminance(color: Rgba): number {
  const linearize = (channel: number) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linearize(color.r) +
    0.7152 * linearize(color.g) +
    0.0722 * linearize(color.b)
  );
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fgOpaque = compositeOver(foreground, background);
  const l1 = relativeLuminance(fgOpaque);
  const l2 = relativeLuminance(background);
  const [light, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}

describe("control-room design styles", () => {
  it("keeps app/globals.css as an explicit @layer entrypoint with bounded Tailwind sources", () => {
    const globalsCss = readAppFile("app/globals.css").trim();

    const statements = globalsCss.split("\n").filter(Boolean);
    expect(statements.length).toBeGreaterThan(20);
    expect(
      statements.every(
        (statement) =>
          statement.startsWith("@layer ") ||
          statement.startsWith("@import ") ||
          statement.startsWith("@source "),
      ),
    ).toBe(true);
    expect(statements.slice(0, 6)).toEqual([
      "@layer fm-tokens, theme, fm-base, base, fm-primitives, fm-components, components, fm-modules, utilities;",
      '@import "../src/design/styles/fonts.css" layer(fm-tokens);',
      '@import "tailwindcss" source(none);',
      '@source "./**/*.{html,js,cjs,mjs,ts,cts,mts,jsx,tsx,md,mdx,json,css,mx3,vue,svelte}";',
      '@source "../src/**/*.{html,js,cjs,mjs,ts,cts,mts,jsx,tsx,md,mdx,json,css,mx3,vue,svelte}";',
      '@import "../src/design/styles/tailwind-theme.css";',
    ]);
    expect(globalsCss).toContain('start-screen.tokens.css" layer(fm-tokens)');
    expect(globalsCss).toContain('inspector.css" layer(fm-components)');
    expect(globalsCss).toContain('inspector-widgets.css" layer(fm-modules)');
    expect(globalsCss).toContain('start-screen.css" layer(fm-modules)');
    expect(globalsCss).toContain('start-compute.css" layer(fm-modules)');
    expect(globalsCss).not.toContain("components/index.css");
  });

  it("loads the bundled UI, monospaced, and STIX Two Text physics symbol fonts from local assets", () => {
    const fontsCss = readAppFile("src/design/styles/fonts.css");
    const manifest = JSON.parse(readAppFile("public/fonts/manifest.json")) as {
      assets: Array<{ path: string }>;
    };
    const interFont = path.join(appRoot, "public/fonts/InterVariable-v4.1.woff2");
    const jetBrainsMonoFont = path.join(
      appRoot,
      "public/fonts/JetBrainsMono-Variable-v2.304.ttf",
    );
    const stixItalicFont = path.join(appRoot, "public/fonts/STIXTwoText-Italic.woff2");
    const stixRegularFont = path.join(appRoot, "public/fonts/STIXTwoText-Regular.woff2");

    expect(fontsCss).toContain('font-family: "Inter";');
    expect(fontsCss).toContain('font-family: "JetBrains Mono";');
    expect(fontsCss).toContain('font-family: "STIX Two Text";');
    expect(fontsCss).toContain('src: url("/fonts/InterVariable-v4.1.woff2")');
    expect(fontsCss).toContain('src: url("/fonts/JetBrainsMono-Variable-v2.304.ttf")');
    expect(fontsCss).toContain('src: url("/fonts/STIXTwoText-Italic.woff2") format("woff2");');
    expect(fontsCss).toContain('src: url("/fonts/STIXTwoText-Regular.woff2") format("woff2");');
    expect(fontsCss.match(/font-display: swap;/g)).toHaveLength(4);
    expect(existsSync(interFont)).toBe(true);
    expect(existsSync(jetBrainsMonoFont)).toBe(true);
    expect(existsSync(stixItalicFont)).toBe(true);
    expect(existsSync(stixRegularFont)).toBe(true);
    expect(manifest.assets.map((asset) => asset.path)).toEqual(
      expect.arrayContaining([
        "STIXTwoText-Italic.woff2",
        "STIXTwoText-Regular.woff2",
        "LICENSE-STIXTwoText-OFL.txt",
      ]),
    );
  });

  it("defines light and dark themes through central fm tokens", () => {
    const tokensCss = readAppFile("src/design/styles/tokens.css");
    const themeCss = readAppFile("src/design/styles/theme.css");

    expect(tokensCss).toContain("--fm-bg-app");
    expect(tokensCss).toContain("--fm-font-ui");
    expect(tokensCss).toContain("--fm-text-xs: 12px;");
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
    expect(bridgeCss).toContain("--color-fm-control-border: var(--fm-border-control);");
    expect(bridgeCss).toContain("--color-fm-accent-text: var(--fm-accent-text);");
    expect(bridgeCss).toContain("--color-fm-info-text: var(--fm-info-text);");
    expect(bridgeCss).toContain("--color-fm-live-text: var(--fm-live-text);");
    expect(bridgeCss).toContain("--color-fm-stale-text: var(--fm-stale-text);");
    expect(bridgeCss).toContain("--color-fm-axis-x: var(--fm-axis-x);");
    expect(bridgeCss).toContain("--color-fm-axis-y: var(--fm-axis-y);");
    expect(bridgeCss).toContain("--color-fm-axis-z: var(--fm-axis-z);");
    expect(bridgeCss).toContain(
      "--spacing-fm-control-sm: var(--fm-control-height-sm);",
    );
    expect(bridgeCss).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it("maps dark and light themes to WCAG AA calibrated Catppuccin Mocha and Latte", () => {
    const themeCss = readAppFile("src/design/styles/theme.css");

    expect(themeCss).toContain("--fm-bg-app: #0d0d16;");
    expect(themeCss).toContain("--fm-bg-viewport: #0b0b13;");
    expect(themeCss).toContain("--fm-text-primary: #cdd6f4;");
    expect(themeCss).toContain("--fm-accent: #89b4fa;");
    expect(themeCss).toContain("--fm-info: #89dceb;");
    expect(themeCss).toContain("--fm-text-on-accent: #11111b;");
    expect(themeCss).toContain("--fm-bg-app: #e9ecf3;");
    expect(themeCss).toContain("--fm-bg-viewport: #dde2ec;");
    expect(themeCss).toContain("--fm-text-primary: #4c4f69;");
    expect(themeCss).toContain("--fm-accent: #1e66f5;");
    expect(themeCss).toContain("--fm-info: #0284c7;");
    expect(themeCss).toContain("--fm-text-on-accent: #ffffff;");
  });

  it("verifies_wcag_21_aa_luminance_ratios_across_mocha_and_latte_surfaces", () => {
    const themeCss = readAppFile("src/design/styles/theme.css");
    const themeEntries = [
      { name: "mocha", tokens: parseTokenDeclarations(extractThemeBlock(themeCss, '[data-theme="dark"]')) },
      { name: "latte", tokens: parseTokenDeclarations(extractThemeBlock(themeCss, '[data-theme="light"]')) },
    ] as const;

    const textTokens = [
      "--fm-text-primary",
      "--fm-text-secondary",
      "--fm-text-tertiary",
      "--fm-accent-text",
      "--fm-success-text",
      "--fm-warning-text",
      "--fm-danger-text",
      "--fm-info-text",
      "--fm-live-text",
      "--fm-stale-text",
      "--fm-degraded-text",
      "--fm-hue-geometry-text",
      "--fm-hue-material-text",
      "--fm-hue-physics-text",
      "--fm-hue-study-text",
      "--fm-hue-visualization-text",
      "--fm-hue-mesh-text",
      "--fm-hue-definition-text",
    ] as const;

    const uiBoundaryAndAccentTokens = [
      "--fm-border-control",
      "--fm-border-strong",
      "--fm-accent",
      "--fm-success",
      "--fm-warning",
      "--fm-danger",
      "--fm-info",
      "--fm-live",
      "--fm-stale",
      "--fm-degraded",
      "--fm-hue-geometry",
      "--fm-hue-material",
      "--fm-hue-physics",
      "--fm-hue-study",
      "--fm-hue-visualization",
      "--fm-hue-mesh",
      "--fm-hue-definition",
    ] as const;

    for (const { name, tokens } of themeEntries) {
      const panel = resolveTokenColor(tokens, "--fm-bg-panel");
      const field = compositeOver(resolveTokenColor(tokens, "--fm-field-bg"), panel);
      const raised = compositeOver(resolveTokenColor(tokens, "--fm-raised-bg"), panel);
      const selected = resolveTokenColor(tokens, "--fm-bg-selected");
      const accent = resolveTokenColor(tokens, "--fm-accent");

      // WCAG 1.4.3 AA (>= 4.50:1) for all semantic & domain text tokens across core surfaces.
      for (const token of textTokens) {
        const fg = resolveTokenColor(tokens, token);
        for (const [surfaceName, surface] of [
          ["panel", panel],
          ["field", field],
          ["raised", raised],
          ["selected", selected],
        ] as const) {
          const ratio = contrastRatio(fg, surface);
          expect(
            ratio,
            `${name} ${token} on ${surfaceName} must clear 4.50:1 (got ${ratio.toFixed(2)}:1)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      // On-accent button text and checked switch thumb must clear 4.50:1 against --fm-accent.
      for (const token of ["--fm-text-on-accent", "--fm-switch-thumb"] as const) {
        const ratio = contrastRatio(resolveTokenColor(tokens, token), accent);
        expect(
          ratio,
          `${name} ${token} on --fm-accent must clear 4.50:1 (got ${ratio.toFixed(2)}:1)`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // Vector3 x/y/z prefixes inside recessed fields must clear 4.50:1.
      for (const token of ["--fm-axis-x", "--fm-axis-y", "--fm-axis-z"] as const) {
        const ratio = contrastRatio(resolveTokenColor(tokens, token), field);
        expect(
          ratio,
          `${name} ${token} on field must clear 4.50:1 (got ${ratio.toFixed(2)}:1)`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // WCAG 1.4.11 Non-text AA (>= 3.00:1) for control boundaries, icons, and domain accents.
      for (const token of uiBoundaryAndAccentTokens) {
        const fg = resolveTokenColor(tokens, token);
        for (const [surfaceName, surface] of [
          ["panel", panel],
          ["field", field],
          ["raised", raised],
        ] as const) {
          const ratio = contrastRatio(fg, surface);
          expect(
            ratio,
            `${name} ${token} on ${surfaceName} must clear 3.00:1 (got ${ratio.toFixed(2)}:1)`,
          ).toBeGreaterThanOrEqual(3.0);
        }
      }
    }
  });

  it("defines the 2026-11 glass visual language in both themes", () => {
    const tokensCss = readAppFile("src/design/styles/tokens.css");
    const themeCss = readAppFile("src/design/styles/theme.css");
    const bridgeCss = readAppFile("src/design/styles/tailwind-theme.css");

    for (const token of [
      "--fm-elevation-sm:",
      "--fm-elevation-md:",
      "--fm-elevation-lg:",
      "--fm-radius-field: 10px;",
      "--fm-radius-section: 16px;",
      "--fm-radius-panel: 22px;",
      "--fm-radius-window: 28px;",
      "--fm-glass-backdrop:",
      "--fm-ease-out-soft:",
      "--fm-font-symbol:",
    ]) {
      expect(tokensCss).toContain(token);
    }
    const themed = [
      "--fm-glass-bg:",
      "--fm-glass-strong:",
      "--fm-glass-line:",
      "--fm-glass-highlight:",
      "--fm-field-bg:",
      "--fm-raised-bg:",
      "--fm-border-control:",
      "--fm-switch-thumb:",
      "--fm-hue-geometry:",
      "--fm-hue-geometry-text:",
      "--fm-hue-material:",
      "--fm-hue-material-text:",
      "--fm-hue-physics:",
      "--fm-hue-physics-text:",
      "--fm-hue-study:",
      "--fm-hue-study-text:",
      "--fm-hue-visualization:",
      "--fm-hue-visualization-text:",
      "--fm-hue-mesh:",
      "--fm-hue-mesh-text:",
      "--fm-hue-definition:",
      "--fm-hue-definition-text:",
    ];
    for (const block of [
      extractThemeBlock(themeCss, '[data-theme="dark"]'),
      extractThemeBlock(themeCss, '[data-theme="light"]'),
    ]) {
      for (const token of themed) expect(block).toContain(token);
    }
    // Light fields are recessed, never bright white; the selected option is.
    expect(extractThemeBlock(themeCss, '[data-theme="light"]')).not.toMatch(
      /--fm-field-bg:\s*#fff/i,
    );
    expect(themeCss).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*--fm-glass-backdrop: none;/,
    );
    expect(bridgeCss).toContain("--color-fm-glass: var(--fm-glass-bg);");
    expect(bridgeCss).toContain("--shadow-fm-elevation-md: var(--fm-elevation-md);");
    expect(bridgeCss).toContain("--radius-fm-panel: var(--fm-radius-panel);");
  });

  it("provides the consolidated inspector-widgets.css contract for Waves 3-6", () => {
    const widgetsCss = readAppFile("src/design/styles/inspector-widgets.css");

    const requiredWidgetClasses = [
      "fm-region-precedence-list",
      "fm-region-precedence-card",
      "fm-region-precedence-card__rank",
      "fm-region-precedence-card__swatch",
      "fm-region-precedence-card__body",
      "fm-region-precedence-card__title",
      "fm-region-precedence-card__meta",
      "fm-region-precedence-card__pill",
      "fm-math-equation",
      "fm-math-equation__caption",
      "fm-math-equation__terms",
      "fm-math-equation__term",
      "fm-mesh-lex-guard",
      "fm-mesh-lex-guard__header",
      "fm-mesh-lex-guard__ratio",
      "fm-mesh-lex-guard__meter",
      "fm-mesh-lex-guard__fill",
      "fm-mesh-gate-list",
      "fm-mesh-gate-row",
      "fm-mesh-gate-row__label",
      "fm-mesh-gate-row__value",
      "fm-mesh-gate-row__threshold",
      "fm-fdm-neighbor-grid",
      "fm-fdm-neighbor-cell",
      "fm-fdm-neighbor-cell__dir",
      "fm-fdm-neighbor-cell__coord",
      "fm-pipeline-strip",
      "fm-pipeline-step",
      "fm-pipeline-step__dot",
      "fm-stage-drag-handle",
      "fm-colormap-bar",
      "fm-colormap-bar__ramp",
      "fm-colormap-bar__limit",
      "fm-field-layer-list",
      "fm-field-layer-row",
      "fm-field-layer-row__label",
      "fm-field-layer-row__meta",
      "fm-scientific-echart",
      "fm-scientific-echart__canvas",
      "fm-scientific-echart__status",
    ];

    for (const className of requiredWidgetClasses) {
      expect(widgetsCss).toContain(`.${className}`);
    }
    expect(widgetsCss).toContain('[data-status="pass"]');
    expect(widgetsCss).toContain('[data-status="warn"]');
    expect(widgetsCss).toContain('[data-status="failed"]');
    expect(widgetsCss).toContain("@container inspector (min-width: 22rem)");
    expect(widgetsCss).not.toContain("!important");
    expect(widgetsCss).not.toContain("text-transform: uppercase");
    expect(widgetsCss).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it("enforces base intrinsic-size animation, .fm-sym, focus rings, and zero embed !important", () => {
    const baseCss = readAppFile("src/design/styles/base.css");
    const startComputeCss = readAppFile("src/design/styles/start-compute.css");
    const startScreenCss = readAppFile("src/design/styles/start-screen.css");
    const registryCss = readAppFile("src/design/styles/registry-inspector.css");
    const embedFallback = readAppFile("src/design/styles/docsEmbedFallback.ts");

    expect(baseCss).toContain("interpolate-size: allow-keywords;");
    expect(baseCss).toContain(".fm-sym");
    expect(baseCss).toContain("font-family: var(--fm-font-symbol);");
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(startComputeCss).toMatch(
      /\.fm-start-env__meter\s*\{[^}]*border:\s*1px solid var\(--fm-border-control\);[^}]*background:\s*var\(--fm-field-bg\);/,
    );
    expect(startScreenCss).not.toContain("outline: 2px solid var(--fm-focus-ring);");
    expect(startScreenCss).toContain("background: var(--fm-glass-bg);");
    expect(registryCss).toContain("100dvw");
    expect(registryCss).toContain("color: var(--fm-success-text);");
    expect(registryCss).toContain("color: var(--fm-info-text);");
    expect(registryCss).toContain("color: var(--fm-warning-text);");
    expect(embedFallback).not.toContain("!important");
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
    expect(themeCss).toContain("--fm-text-on-accent: #11111b;");
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
        defined.add(match[1]!);
      }
      for (const match of css.matchAll(/@property\s+(--[a-zA-Z0-9_-]+)/g)) {
        defined.add(match[1]!);
      }
      for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
        used.add(match[1]!);
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
