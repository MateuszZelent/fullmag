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

  it("defines the compact Inspector geometry contract", () => {
    const tokens = read("src/design/styles/tokens.css");
    const segmented = read("src/shared/ui/SegmentedControl.tsx");

    expect(tokens).toContain("--fm-control-height-compact: 26px");
    expect(tokens).toContain("--fm-slider-hit-height: 28px");
    expect(tokens).toContain("--fm-radius-input: 7px");
    expect(tokens).toContain("--fm-radius-segment: 8px");
    expect(tokens).toContain("--fm-radius-disclosure: 10px");
    expect(tokens).toContain("--fm-shadow-control:");
    expect(tokens).toContain("--fm-shadow-control-inset:");
    expect(segmented).toContain('data-slot="segmented-control"');
    expect(segmented).toContain('data-slot="segmented-control-item"');
    expect(segmented).not.toContain("border-r");
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
    expect(targetSections).toContain("<Slider");
    expect(targetSections).toContain("<Switch");
    expect(targetSections).not.toContain("fm-inspector-segmented");
    expect(targetSections).not.toContain("fm-radio-group");
    expect(targetSections).not.toContain("fm-visualization-range");
    expect(targetSections).not.toContain("Airbox visualization diagnostic");
    expect(targetSections).not.toContain("setAirboxDiagnosticOpen");
    expect(targetSections).not.toContain('label="Surface"');
    expect(targetSections).not.toContain('label="Wireframe"');
    expect(targetSections).not.toContain('label="Points"');
    expect(targetSections).toContain('{ label: "Off", value: "off" }');
  });

  it.each([
    "ObjectMaterialPanel.tsx",
    "ObjectGeneralPanel.tsx",
    "AntennaObjectPanel.tsx",
    "CouplingInspectorPanel.tsx",
    "CrossSectionInspectorPanel.tsx",
    "CrossSectionSettingsEditor.tsx",
  ])("keeps migrated %s authoring on compact Inspector groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toMatch(/import\s+\{\s*InspectorSection\s*\}/);
    expect(panel).not.toContain("fm-inspector-section");
  });

  it("keeps object extensions independent from legacy Accordion sections", () => {
    const extensions = read(
      "src/modules/inspector/extensions/ObjectExtensionsSection.tsx",
    );

    expect(extensions).toContain("InspectorGroup");
    expect(extensions).not.toMatch(/<\/?InspectorSection\b/);
    expect(extensions).not.toContain('value="extensions"');
  });
});
