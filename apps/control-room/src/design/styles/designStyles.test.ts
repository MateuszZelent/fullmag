import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = process.cwd();

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
        '@import "../src/design/styles/header.css";',
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
});
