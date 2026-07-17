import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = process.cwd();
const stylesRoot = path.join(appRoot, "src/design/styles");
const locallyScopedCssVars = new Set([
  "--depth",
  "--fm-mesh-build-progress",
  "--fm-refresh-progress",
  "--pct",
  "--radix-accordion-content-height",
  "--radix-select-content-available-height",
  "--radix-select-trigger-width",
]);

function readAppFile(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8");
}

describe("control-room design styles", () => {
  it("keeps app/globals.css as an import-only entrypoint", () => {
    const globalsCss = readAppFile("app/globals.css").trim();

    const statements = globalsCss.split("\n").filter(Boolean);
    expect(statements.length).toBeGreaterThan(20);
    expect(statements.every((statement) => statement.startsWith("@import "))).toBe(true);
    expect(statements[0]).toBe('@import "tailwindcss";');
    expect(globalsCss).toContain('inspector-visualization.css" layer(fm-modules)');
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
      globalsCss.indexOf('@import "tailwindcss";'),
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
