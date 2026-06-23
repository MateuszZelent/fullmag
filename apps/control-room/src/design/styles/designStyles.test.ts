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
]);

function readAppFile(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8");
}

describe("control-room design styles", () => {
  it("keeps app/globals.css as an import-only entrypoint", () => {
    const globalsCss = readAppFile("app/globals.css").trim();

    expect(globalsCss).toBe(
      [
        '@import "tailwindcss";',
        '@import "../src/design/styles/tokens.css";',
        '@import "../src/design/styles/theme.css";',
        '@import "../src/design/styles/base.css";',
        '@import "../src/design/styles/layout.css";',
        '@import "../src/design/styles/slots.css";',
        '@import "../src/design/styles/dropdown.css";',
        '@import "../src/design/styles/dialog.css";',
        '@import "../src/design/styles/accordion.css";',
        '@import "../src/design/styles/context-menu.css";',
        '@import "../src/design/styles/tabs.css";',
        '@import "../src/design/styles/command.css";',
        '@import "../src/design/styles/header.css";',
        '@import "../src/design/styles/ribbon.css";',
        '@import "../src/design/styles/explorer.css";',
        '@import "../src/design/styles/inspector.css";',
        '@import "../src/design/styles/viewport-3d.css";',
        '@import "../src/design/styles/cross-section-image.css";',
        '@import "../src/design/styles/analysis-plots.css";',
        '@import "../src/design/styles/footer.css";',
        '@import "../src/design/styles/command-palette.css";',
        '@import "../src/design/styles/registry-inspector.css";',
        '@import "../src/design/styles/thread-manager.css";',
        '@import "../src/design/styles/diagnostic-recorder.css";',
        '@import "../src/design/styles/material-library.css";',
      ].join("\n"),
    );
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
