import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(appRoot, path), "utf8");

describe("Inspector design-system reference contract", () => {
  it("loads a top-level Tailwind bridge over Fullmag tokens", () => {
    const globals = read("app/globals.css");
    const bridge = read("src/design/styles/tailwind-theme.css");

    expect(globals).toContain(
      '@import "../src/design/styles/tailwind-theme.css";',
    );
    expect(bridge).toContain("@theme inline");
    expect(bridge).toContain("--color-fm-panel: var(--fm-bg-panel)");
    expect(bridge).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it("keeps the reference overview free of nested card sections", () => {
    const overview = read(
      "src/modules/inspector/panels/ObjectVisualizationOverview.tsx",
    );

    expect(overview).toContain("InspectorGroup");
    expect(overview).toContain("InspectorMetricStrip");
    expect(overview).not.toContain("InspectorSection");
    expect(overview).not.toMatch(/<(?:img|canvas)\b/i);
  });

  it("keeps Visualization family CSS domain-specific", () => {
    const css = read("src/design/styles/inspector-visualization.css");

    expect(css).not.toMatch(
      /\.fm-(?:inspector-section|inspector-input|inspector-select|tabs-trigger|button)\b/,
    );
  });

  it("uses shared controls for the reference composition", () => {
    const targetSections = read(
      "src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx",
    );

    expect(targetSections).toContain("SegmentedControl");
    expect(targetSections).toContain("InspectorPropertyRow");
    expect(targetSections).not.toContain("fm-inspector-segmented");
  });
});
