import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALL_TAB_CONTENT } from "./ribbonContributions";
import { RIBBON_TABS } from "./ribbonTypes";

describe("ribbon structure", () => {
  it("defines visible content and dropdown structure for every ribbon tab", () => {
    for (const tab of RIBBON_TABS) {
      const content = ALL_TAB_CONTENT[tab.id];

      expect(content, tab.id).toBeDefined();
      expect(content.groups.length, tab.id).toBeGreaterThan(0);
      expect(
        content.groups.some((group) =>
          group.actions.some((action) => action.menu && action.menu.length > 0),
        ),
        tab.id,
      ).toBe(true);
    }
  });

  it("keeps ribbon visual tokens theme-driven instead of hardcoded", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/ribbon/ribbonContributions.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(source).toContain("var(--fm-accent)");
  });
});
