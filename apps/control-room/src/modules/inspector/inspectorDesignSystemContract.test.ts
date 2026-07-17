import { readFileSync, readdirSync } from "node:fs";
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
    "GeometryObjectPanel.tsx",
    "ObjectMagneticTexturePanel.tsx",
    "PhysicsInteractionPanel.tsx",
    "RegionalFieldDrivePanel.tsx",
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
    if (fileName === "RegionalFieldDrivePanel.tsx") {
      expect(panel).not.toMatch(/<(?:label|input|select|textarea)\b/);
    }
  });

  it("keeps object extensions independent from legacy Accordion sections", () => {
    const extensions = read(
      "src/modules/inspector/extensions/ObjectExtensionsSection.tsx",
    );

    expect(extensions).toContain("InspectorGroup");
    expect(extensions).not.toMatch(/<\/?InspectorSection\b/);
    expect(extensions).not.toContain('value="extensions"');
  });

  it("keeps migrated mesh policy sections on compact Inspector groups", () => {
    const meshPolicy = read(
      "src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx",
    );

    expect(meshPolicy).toContain("InspectorGroup");
    expect(meshPolicy).not.toMatch(/<\/?InspectorSection\b/);
    expect(meshPolicy).not.toContain("<Accordion");
    expect(meshPolicy).not.toContain("defaultCollapsed");
  });

  it.each([
    "RegionsListPanel.tsx",
    "region/ObjectRegionOverviewPanel.tsx",
    "region/ObjectRegionGeometryPanel.tsx",
    "region/ObjectRegionMeshPanel.tsx",
    "region/ObjectRegionNestedRegionsPanel.tsx",
    "region/ObjectRegionMagneticParametersPanel.tsx",
    "region/ObjectRegionTexturePanel.tsx",
    "region/ObjectRegionDiagnosticsPanel.tsx",
    "region/shared.tsx",
  ])("keeps migrated %s region UI on compact Inspector groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/${fileName}`);

    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toMatch(/import\s+\{\s*InspectorSection\s*\}/);
    expect(panel).not.toContain("<Accordion");
    expect(panel).not.toContain("defaultCollapsed");
  });

  it.each([
    "AirboxOverviewPanel.tsx",
    "AirboxMeshOverviewPanel.tsx",
    "AirboxMeshParametersPanel.tsx",
    "AirboxMeshBuildPanel.tsx",
    "AirboxMeshQualityGatesPanel.tsx",
    "AirboxMeshStatisticsPanel.tsx",
    "AirboxMeshTopologyPanel.tsx",
  ])("keeps migrated airbox/%s on compact Inspector groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/airbox/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toContain("<Accordion");
    expect(panel).not.toContain("defaultCollapsed");
  });

  it.each([
    "MeshResourceView.tsx",
    "mesh-details/MeshOverviewSection.tsx",
    "mesh-details/MeshBuildPipelineSection.tsx",
    "mesh-details/MeshBuildHistorySection.tsx",
    "mesh-details/MeshPolicyComparisonSection.tsx",
    "mesh-details/MeshQualityGatesSection.tsx",
    "mesh-details/MeshRealizedSizeFieldsSection.tsx",
    "mesh-details/MeshViewportDeliverySection.tsx",
    "mesh-details/MeshEditorCapabilitiesSection.tsx",
  ])("keeps migrated %s mesh details on compact Inspector groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toContain("defaultCollapsed");
  });

  it("keeps the mesh details surface independent from a legacy Accordion", () => {
    const panel = read("src/modules/inspector/panels/MeshDetailsPanel.tsx");

    expect(panel).not.toContain("<Accordion");
  });

  it("uses compact groups in the shared Study stage frame", () => {
    const frame = read(
      "src/modules/inspector/panels/stages/StageInspectorFrame.tsx",
    );
    const router = read(
      "src/modules/inspector/panels/StudyStageInspectorRouter.tsx",
    );

    expect(frame).toContain("InspectorGroup");
    expect(frame).not.toMatch(/<\/?InspectorSection\b/);
    expect(router).not.toContain("<Accordion");
  });

  it.each([
    "RelaxStageInspector.tsx",
    "SaveStateStageInspector.tsx",
    "ChangeDeviceStageInspector.tsx",
    "UnsupportedStageInspector.tsx",
  ])("keeps stages/%s on compact Inspector groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/stages/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
  });

  it.each([
    "RunStageInspector.tsx",
    "AutosaveStageInspector.tsx",
    "TableAutosaveStageInspector.tsx",
    "FftResponseStageInspector.tsx",
    "AddFieldDriveStageInspector.tsx",
    "FrequencyDomainCalculationModeSection.tsx",
  ])("keeps stages/%s controls on compact Inspector groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/stages/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
  });

  it.each([
    "EigenmodesStageInspector.tsx",
    "FrequencyResponseStageInspector.tsx",
  ])("keeps stages/%s frequency-domain UI on compact groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/stages/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
  });

  it("keeps the main Study surface and pipeline on compact groups", () => {
    const study = read("src/modules/inspector/panels/StudyInspectorPanel.tsx");
    const pipeline = read(
      "src/modules/inspector/panels/StudyPipelineSection.tsx",
    );

    expect(study).toContain("InspectorGroup");
    expect(study).not.toMatch(/<\/?InspectorSection\b/);
    expect(study).not.toContain("<Accordion");
    expect(pipeline).toContain("InspectorGroup");
    expect(pipeline).not.toMatch(/<\/?InspectorSection\b/);
  });

  it("keeps every hysteresis stage inspector on compact groups", () => {
    const directory = "src/modules/inspector/panels/stages/hysteresis";
    const panels = readdirSync(join(appRoot, directory)).filter((fileName) =>
      fileName.endsWith("Inspector.tsx"),
    );

    expect(panels.length).toBeGreaterThan(0);
    for (const fileName of panels) {
      const panel = read(`${directory}/${fileName}`);
      expect(panel, fileName).toContain("InspectorGroup");
      expect(panel, fileName).not.toMatch(/<\/?InspectorSection\b/);
      expect(panel, fileName).not.toMatch(
        /import\s+\{\s*InspectorSection\s*\}/,
      );
    }
  });

  it.each([
    "ObjectVisualizationPanel.tsx",
    "ChartInspectorPanel.tsx",
    "FrequencyDomainEigenSection.tsx",
    "FrequencyDomainResponseSection.tsx",
    "ModeVisualizationInspectorPanel.tsx",
    "frequency-domain/FmrPeakInspector.tsx",
  ])("keeps results panel %s on compact groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toMatch(/import\s+\{\s*InspectorSection\s*\}/);
  });
});
