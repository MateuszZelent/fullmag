import { existsSync, readFileSync, readdirSync } from "node:fs";
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

    expect(tokens).toContain("--fm-control-height-compact: 28px");
    expect(tokens).toContain("--fm-field-row-min-height: 28px");
    expect(tokens).toContain("--fm-slider-hit-height: 28px");
    expect(tokens).toContain("--fm-font-size-control: 12px");
    expect(tokens).toContain("--fm-font-size-field-label: 12px");
    expect(tokens).toContain("--fm-font-size-help: 11px");
    expect(tokens).toContain("--fm-radius-input: 7px");
    expect(tokens).toContain("--fm-radius-segment: 8px");
    expect(tokens).toContain("--fm-radius-disclosure: 10px");
    expect(tokens).toContain("--fm-shadow-control:");
    expect(tokens).toContain("--fm-shadow-control-inset:");
    expect(segmented).toContain('data-slot="segmented-control"');
    expect(segmented).toContain('data-slot="segmented-control-item"');
    expect(segmented).not.toContain("border-r");
  });

  it("wraps owned action controls and keeps feedback below them in narrow Inspectors", () => {
    const inspector = read("src/design/styles/inspector.css");
    const footer = read("src/modules/inspector/InspectorFooter.tsx");

    expect(inspector).toMatch(/\.fm-inspector__action-bar\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
    expect(inspector).toMatch(/\.fm-inspector__action-controls\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
    expect(inspector).toMatch(
      /@container inspector \(max-width: 24\.375rem\)\s*\{[\s\S]*?\.fm-inspector__action-controls\s*>\s*button\s*\{\s*flex:\s*1 1 auto;\s*\}/,
    );
    expect(inspector).toMatch(
      /\.fm-inspector__action-bar\s*\{[\s\S]*?padding:\s*var\(--fm-space-2\)/,
    );
    expect(footer).toContain('className="fm-inspector__action-controls"');
    expect(footer).toContain('className="fm-inspector__action-reason"');
  });

  it("contains wide scientific content inside the Inspector shell", () => {
    const inspector = read("src/design/styles/inspector.css");

    expect(inspector).toMatch(
      /\.fm-inspector\s*\{[\s\S]*?min-width: 0;[\s\S]*?overflow: hidden;/,
    );
  });

  it("keeps the reference overview free of nested card sections", () => {
    const overview = read(
      "src/modules/inspector/panels/ObjectVisualizationOverview.tsx",
    );

    expect(overview).toContain("InspectorOverviewFrame");
    expect(overview).not.toContain("InspectorSection");
    expect(overview).not.toMatch(/<(?:img|canvas)\b/i);
  });

  it("keeps Visualization family CSS domain-specific", () => {
    const css = read("src/design/styles/inspector-visualization.css");

    expect(css).not.toMatch(
      /\.fm-(?:inspector-section|inspector-input|inspector-select|tabs-trigger|button)\b/,
    );
  });

  it("owns narrow metric-strip breakpoints in the shared overview frame", () => {
    const shared = read("src/design/styles/inspector-visualization.css");
    const physics = read("src/design/styles/inspector-physics.css");

    expect(shared).toContain("@container (max-width: 420px)");
    expect(shared).toContain(
      '.fm-inspector-overview-frame .fm-inspector-metric-strip[data-count="4"]',
    );
    expect(shared).toContain("@container (max-width: 260px)");
    expect(physics).not.toContain(
      '.fm-physics-inspector-overview .fm-inspector-metric-strip[data-count="4"]',
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
    expect(targetSections).toContain("renderModeDisplayPatch");
    expect(targetSections).toContain('ariaLabel: "Toggle target visibility"');
    expect(targetSections).toContain('ariaLabel: "Toggle target bounds"');
    expect(targetSections).not.toContain('aria-label="Toggle surface shading"');
  });

  it.each([
    "ObjectGeneralPanel.tsx",
    "RegionalFieldDrivePanel.tsx",
    "AntennaObjectPanel.tsx",
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

  it.each([
    "inspectors/objects/material/ObjectMaterialSpec.tsx",
    "inspectors/objects/geometry/ObjectGeometrySpec.tsx",
    "panels/magnetic-texture/MagneticTextureInspectorPanel.tsx",
    "inspectors/objects/physics/PhysicsModuleSpec.tsx",
    "inspectors/objects/physics/DemagAndCouplingSpecs.tsx",
    "inspectors/objects/regions/RegionsRootSpec.tsx",
    "inspectors/objects/regions/RegionDetailSpec.tsx",
    "inspectors/objects/regions/RegionMagneticParametersSpec.tsx",
    "inspectors/objects/regions/RegionMeshSpec.tsx",
    "inspectors/universe/UniverseAndAirboxSpec.tsx",
    "inspectors/universe/AirboxMeshOverviewSpec.tsx",
    "inspectors/universe/AirboxMeshSizingSpecs.tsx",
    "inspectors/universe/AirboxMeshBuildSpec.tsx",
    "inspectors/universe/AirboxMeshQualityGatesSpec.tsx",
    "inspectors/universe/AirboxMeshStatisticsSpec.tsx",
    "inspectors/universe/AirboxMeshTopologySpec.tsx",
    "inspectors/universe/BoundaryFaceSpecs.tsx",
    "inspectors/mesh/MeshRootSpec.tsx",
    "inspectors/mesh/MeshQualitySpec.tsx",
    "inspectors/mesh/MeshBuildHistorySpec.tsx",
    "inspectors/study/stages/RelaxStageSpec.tsx",
    "inspectors/study/stages/RunStageSpec.tsx",
    "inspectors/study/stages/EigenmodesStageSpec.tsx",
    "inspectors/study/stages/FrequencyResponseStageSpec.tsx",
    "inspectors/visualizations/Visualizations2DRootSpec.tsx",
    "inspectors/visualizations/AnalysisChartSpecs.tsx",
  ])("keeps canonical spec %s free of legacy InspectorSection and Accordion wrappers", (relPath) => {
    const panel = read(`src/modules/inspector/${relPath}`);

    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toMatch(/import\s+\{\s*InspectorSection\s*\}/);
    expect(panel).not.toContain("fm-inspector-section");
    expect(panel).not.toContain("<Accordion");
  });

  it("keeps object extensions independent from legacy Accordion sections", () => {
    const extensions = read(
      "src/modules/inspector/extensions/ObjectExtensionsSection.tsx",
    );

    expect(extensions).toContain("InspectorGroup");
    expect(extensions).not.toMatch(/<\/?InspectorSection\b/);
    expect(extensions).not.toContain('value="extensions"');
  });

  it("keeps MeshResourceView on compact Inspector groups", () => {
    const view = read("src/modules/inspector/panels/MeshResourceView.tsx");

    expect(view).toContain("InspectorGroup");
    expect(view).not.toMatch(/<\/?InspectorSection\b/);
    expect(view).not.toContain("defaultCollapsed");
  });

  it("keeps the delegated Study surface and pipeline on compact groups", () => {
    const study = read("src/modules/inspector/panels/StudyInspectorPanel.tsx");
    const studySections = read(
      "src/modules/inspector/panels/StudyInspectorSections.tsx",
    );
    const executionProfile = read(
      "src/modules/inspector/panels/StudyExecutionProfileSection.tsx",
    );
    const pipeline = read(
      "src/modules/inspector/panels/StudyPipelineSection.tsx",
    );

    for (const section of [
      "StudyRuntimeSection",
      "StudySelectedStageSection",
      "StudyBoundarySection",
      "StudyRecoverySection",
      "StudyHistorySection",
      "StudyExecutionProfileSection",
    ]) {
      expect(study).toContain("<" + section);
    }
    expect(study).not.toMatch(/<\/?InspectorSection\b/);
    expect(study).not.toContain("<Accordion");

    for (const [source, section] of [
      [studySections, "StudyRuntimeSection"],
      [studySections, "StudySelectedStageSection"],
      [studySections, "StudyBoundarySection"],
      [studySections, "StudyRecoverySection"],
      [studySections, "StudyHistorySection"],
      [executionProfile, "StudyExecutionProfileEditor"],
    ] as const) {
      const start = source.indexOf("function " + section);
      expect(start, section + " is present").toBeGreaterThanOrEqual(0);
      const nextFunction = [
        source.indexOf("\nfunction ", start + 1),
        source.indexOf("\nexport function ", start + 1),
      ]
        .filter((index) => index !== -1)
        .sort((left, right) => left - right)[0] ?? -1;
      const implementation = source.slice(
        start,
        nextFunction === -1 ? undefined : nextFunction,
      );
      expect(implementation, section).toContain("<InspectorGroup");
      expect(implementation, section).not.toMatch(/<\/?InspectorSection\b/);
    }

    expect(studySections).not.toContain("<Accordion");
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

  it("builds the mode visualization Inspector from the object visualization Inspector", () => {
    // ADR 0054 / spec 32 §12: one Inspector style for the whole tree; a mode is a
    // quantity on the magnetic object, not a second visualization panel.
    const overview = read("src/modules/inspector/panels/mode-visualization/ModeVisualizationOverviewPanel.tsx");
    const modeSections = read("src/modules/inspector/panels/ModeVisualizationInspectorPanel.tsx");

    expect(overview).toContain("<VisualizationTargetInspectorPanel");
    expect(modeSections).not.toMatch(/<FrequencyDomainModeDisplayControls/);
    expect(modeSections).toContain('variant="nav"');
    expect(modeSections).not.toMatch(/<select/);
  });

  it.each([
    "ObjectVisualizationPanel.tsx",
    "ModeVisualizationInspectorPanel.tsx",
    "frequency-domain/FmrPeakInspector.tsx",
    "../inspectors/results/frequency-domain/FrequencyDomainOverviewSpecs.tsx",
    "../inspectors/results/frequency-domain/FrequencyDomainEigenSpecs.tsx",
    "../inspectors/results/frequency-domain/FrequencyDomainFmrSpecs.tsx",
    "../inspectors/results/frequency-domain/FrequencyDomainComparisonSpec.tsx",
    "../inspectors/results/frequency-domain/FrequencyDomainResourceSpecs.tsx",
  ])("keeps results panel %s on compact groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/${fileName}`);

    expect(panel).toContain("InspectorGroup");
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toMatch(/import\s+\{\s*InspectorSection\s*\}/);
  });

  it.each([
    "PlaceholderPanel.tsx",
    "visualization-debug/VisualizationDebugPanel.tsx",
    "../extensions/topological-charge/TopologicalChargeExtensionPanel.tsx",
  ])("keeps remaining Inspector surface %s on compact groups", (fileName) => {
    const panel = read(`src/modules/inspector/panels/${fileName}`);

    if (fileName === "PlaceholderPanel.tsx") {
      expect(panel).toContain("InspectorTemplate");
    } else {
      expect(panel).toContain("InspectorGroup");
    }
    expect(panel).not.toMatch(/<\/?InspectorSection\b/);
    expect(panel).not.toMatch(/import\s+\{\s*InspectorSection\s*\}/);
  });

  it("removes the obsolete primitives/InspectorSection compatibility layer while keeping canonical template sections", () => {
    const inspectorCss = read("src/design/styles/inspector.css");
    const studyCss = read("src/design/styles/inspector-study.css");

    expect(
      existsSync(
        join(
          appRoot,
          "src/modules/inspector/primitives/InspectorSection.tsx",
        ),
      ),
    ).toBe(false);
    expect(inspectorCss).toContain('.fm-inspector-section[data-state="open"]');
    expect(studyCss).not.toContain(".fm-inspector-section");
  });

  it("enforces the One Golden Persistence Law (max-1 primary button, CommitBar-only) across Geometry inspectors", () => {
    const geometryDir = "src/modules/inspector/inspectors/objects/geometry";
    const productionFiles = readdirSync(join(appRoot, geometryDir)).filter(
      (fileName) =>
        /\.(?:ts|tsx)$/.test(fileName) &&
        !fileName.includes(".test.") &&
        !fileName.includes(".spec."),
    );

    expect(productionFiles.length).toBeGreaterThan(0);
    for (const fileName of productionFiles) {
      const source = read(`${geometryDir}/${fileName}`);
      expect(
        source,
        `${fileName} must not render non-CommitBar variant="primary" buttons`,
      ).not.toMatch(/variant\s*=\s*["']primary["']|\?\s*["']primary["']/);
    }

    const arraySection = read(`${geometryDir}/Array3DLatticeTableSection.tsx`);
    expect(arraySection).not.toContain("Apply Array 3D");
    expect(arraySection).not.toContain("applyArray3DTransaction");

    const objectSpec = read(`${geometryDir}/ObjectGeometrySpec.tsx`);
    expect(objectSpec).toContain('label: "Geometry"');
    expect(objectSpec).toContain('label: "Placement"');
    expect(objectSpec).not.toContain('label: "Boolean CSG"');
    expect(objectSpec).not.toContain("geometry-revision-conflict-actions");
    expect(objectSpec).not.toContain("geometry-object-danger-actions");
    expect(objectSpec).toContain("deleteAction:");

    const transformSections = read(`${geometryDir}/GeometryTransformSections.tsx`);
    expect(transformSections).not.toContain('id: "geometry-csg"');

    const nodeSpec = read(`${geometryDir}/GeometryNodeInspectorSpec.tsx`);
    expect(nodeSpec).toContain("Modifier local transform");
    expect(nodeSpec).toContain("commitGeometryStackTransaction");

    const booleanSection = read(`${geometryDir}/BooleanNodeSection.tsx`);
    expect(booleanSection).toContain("DropdownMenu");
    expect(booleanSection).toContain("commitGeometryStackTransaction");
  });
});
