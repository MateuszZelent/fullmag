import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALL_TAB_CONTENT } from "./ribbonContributions";
import { buildRibbonTabContent } from "./ribbonContributions";
import { resolveRibbonIconColor } from "./RibbonGroupsRow";
import { RIBBON_TABS } from "./ribbonTypes";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";

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

  it("normalizes legacy utility icon colors to design tokens", () => {
    expect(resolveRibbonIconColor("text-emerald-400")).toBe("var(--fm-success)");
    expect(resolveRibbonIconColor("text-sky-300")).toBe("var(--fm-accent)");
    expect(resolveRibbonIconColor("text-muted-foreground")).toBe(
      "var(--fm-text-muted)",
    );
    expect(resolveRibbonIconColor("var(--fm-warning)")).toBe("var(--fm-warning)");
  });

  it("resolves every contributed action icon color", () => {
    const unresolved = Object.values(ALL_TAB_CONTENT).flatMap((content) =>
      content.groups.flatMap((group) =>
        group.actions
          .filter((action) => action.iconColor && !resolveRibbonIconColor(action.iconColor))
          .map((action) => `${content.tabId}/${group.id}/${action.id}`),
      ),
    );

    expect(unresolved).toEqual([]);
  });

  it("keeps ribbon labels bounded inside fixed action geometry", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/design/styles/ribbon.css"),
      "utf8",
    );

    expect(source).toContain("--fm-ribbon-action-width");
    expect(source).toContain("-webkit-line-clamp: 2");
    expect(source).toContain("overflow-wrap: anywhere");
    expect(source).toContain(".fm-ribbon-group::before");
  });

  it("enables selected display controls from the object visualization registry", () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      selection: {
        kind: "object.visualization",
        label: "Free layer",
        moduleSource: "test",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const visibilityNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:visible",
    );

    expect(renderAction?.disabled).toBe(false);
    expect(visibilityNode).toMatchObject({
      checked: true,
      disabled: false,
    });
  });
});
