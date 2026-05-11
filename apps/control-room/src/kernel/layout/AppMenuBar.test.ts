import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const headerCss = readFileSync(
  join(process.cwd(), "src/design/styles/header.css"),
  "utf8",
);

describe("AppMenuBar CSS contract", () => {
  it("defines all required fm-header classes", () => {
    expect(headerCss).toContain(".fm-header");
    expect(headerCss).toContain(".fm-header__brand");
    expect(headerCss).toContain(".fm-header__logo");
    expect(headerCss).toContain(".fm-header__title");
    expect(headerCss).toContain(".fm-header__nav");
    expect(headerCss).toContain(".fm-header__nav-item");
    expect(headerCss).toContain(".fm-header__action-btn");
    expect(headerCss).toContain(".fm-header__session-indicator");
    expect(headerCss).toContain(".fm-header__session-dot");
    expect(headerCss).toContain("-webkit-app-region: drag");
  });

  it("uses only fm-prefixed classes and token variables, no hardcoded colors", () => {
    // All class selectors should use fm- prefix
    const classSelectors = headerCss.match(/\.[a-z][a-z0-9_-]*/g) || [];
    for (const selector of classSelectors) {
      expect(selector).toMatch(/^\.fm-/);
    }

    // Should use token variables, not hardcoded colors
    expect(headerCss).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
