import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "../../..");
const stylesRoot = join(appRoot, "src/design/styles");
const inspectorRoot = join(appRoot, "src/modules/inspector");

function filesBelow(root: string, extension: RegExp): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesBelow(path, extension);
    return extension.test(entry.name) ? [path] : [];
  });
}

describe("Inspector visual contract", () => {
  it("keeps inspector styles token-only and above the compact control floor", () => {
    const css = readdirSync(stylesRoot)
      .filter((name) => /^inspector.*\.css$/.test(name))
      .map((name) => readFileSync(join(stylesRoot, name), "utf8"))
      .join("\n");

    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/(?:min-)?height:\s*2[0-5]px/);
    expect(css).not.toMatch(/gap:\s*[12]px(?:;|\s)/);
    expect(css.match(/^\.fm-inspector\s*\{/gm)).toHaveLength(1);
    expect(css.match(/^\.fm-inspector__header\s*\{/gm)).toHaveLength(1);
  });

  it("draws one section card style with the domain hue and flat nested groups", () => {
    const css = readdirSync(stylesRoot)
      .filter((name) => /^inspector.*\.css$/.test(name))
      .map((name) => readFileSync(join(stylesRoot, name), "utf8"))
      .join("\n")
      .replace(/\r\n/g, "\n");

    expect(css).toMatch(/^\.fm-inspector-group\s*\{[^}]*border-radius: var\(--fm-radius-section\);[^}]*background: var\(--fm-section-bg\);/m);
    expect(css).toMatch(/\.fm-inspector-group \.fm-inspector-group\s*\{[^}]*border: 0;[^}]*background: transparent;/);
    expect(css).toMatch(/\.fm-inspector-group__icon\s*\{[^}]*\}[\s\S]*color: var\(--fm-inspector-hue, var\(--fm-accent\)\);/);
    expect(css).toMatch(/\.fm-inspector\s*\{\n  --fm-inspector-hue: var\(--fm-hue-geometry\);/);
    // The former nav rows with circular icons and the icon box are gone.
    expect(css).not.toContain("fm-inspector-group-nav");
    expect(css).not.toContain("fm-inspector-group-icon-box");
  });

  it("keeps Inspector fields and readouts readable and tokenized", () => {
    const css = readdirSync(stylesRoot)
      .filter((name) => /^inspector.*\.css$/.test(name))
      .map((name) => readFileSync(join(stylesRoot, name), "utf8"))
      .join("\n");
    const tokens = readFileSync(join(stylesRoot, "tokens.css"), "utf8");

    expect(tokens).toMatch(/--fm-inspector-control-height:\s*35px;/);
    expect(tokens).toMatch(/--fm-inspector-control-radius:\s*var\(--fm-radius-field\);/);
    expect(tokens).toMatch(/--fm-inspector-control-font-size:\s*13px;/);
    expect(css).toContain("height: var(--fm-inspector-control-height)");
    expect(css).toContain("border-radius: var(--fm-inspector-control-radius)");
    expect(css).toContain("font-size: var(--fm-inspector-control-font-size)");
    expect(css).toContain(".fm-inspector-form-field--inline:has(.fm-inspector-checkbox)");
    expect(css).toContain(".fm-inspector-vector3-item .fm-inspector-input");
    expect(css).toContain(".fm-select-trigger[aria-invalid=\"true\"]");
    expect(css).toContain(".fm-select-trigger:disabled");
    expect(css).toContain("[data-slot=\"inspector-property-row\"][data-layout=\"inline\"]:has(");
    expect(css).toContain(".fm-inspector-field-row__value");
    expect(css).toContain("[data-slot=\"inspector-group-heading\"] h3");
    expect(css).toContain("fm-inspector-vector3-item:has(.fm-inspector-input[aria-invalid=\"true\"])");
  });

  it("does not embed preview media in the Inspector module", () => {
    const source = filesBelow(inspectorRoot, /\.tsx?$/)
      .filter((path) => !/\.test\.tsx?$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/<(?:img|canvas)\b/i);
    expect(source).not.toMatch(/viewport[- ]?(?:thumbnail|screenshot)/i);
  });

  it("keeps inactive Inspector tabs demand-driven", () => {
    const source = filesBelow(inspectorRoot, /\.tsx?$/)
      .filter((path) => !/\.test\.tsx?$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toContain("<TabsContent forceMount");
  });

  it("scopes edit sessions to the active Inspector provider", () => {
    const editSession = readFileSync(
      join(inspectorRoot, "InspectorEditSession.tsx"),
      "utf8",
    );
    const inspectorModule = readFileSync(
      join(inspectorRoot, "InspectorModule.tsx"),
      "utf8",
    );

    expect(editSession).toContain("InspectorEditSessionContext");
    expect(editSession).toContain("createInspectorEditSessionStore");
    expect(editSession).toContain("Object.freeze");
    expect(inspectorModule).toContain("InspectorEditSessionProvider");
  });

  it("routes regional field-drive drafts through the shared Inspector action bar", () => {
    const fieldDrivePanel = readFileSync(
      join(inspectorRoot, "panels/RegionalFieldDrivePanel.tsx"),
      "utf8",
    );

    expect(fieldDrivePanel).toContain("useRegisterInspectorEditSession");
    expect(fieldDrivePanel).not.toContain("Save drive");
  });

  it("routes STT/SOT/SHE authoring drafts through the shared Inspector action bar", () => {
    const authoringPanels = [
      "TransportAuthoringInspector.tsx",
      "SpinAuthoringInspector.tsx",
      "SpinInterfaceInspector.tsx",
    ].map((name) => readFileSync(join(inspectorRoot, "panels", name), "utf8"));
    const interactionPanel = readFileSync(
      join(inspectorRoot, "panels/PhysicsInteractionPanel.tsx"),
      "utf8",
    );
    const overview = readFileSync(
      join(inspectorRoot, "panels/PhysicsInspectorOverview.tsx"),
      "utf8",
    );

    for (const source of authoringPanels) {
      expect(source).toContain("useRegisterInspectorEditSession");
    }
    expect(interactionPanel).toContain("editSession={{");
    expect(overview).toContain("PhysicsInspectorEditSessionBridge");
  });

  it("routes Study drafts through the shared Inspector action bar", () => {
    const studyPanel = readFileSync(
      join(inspectorRoot, "panels/StudyInspectorPanel.tsx"),
      "utf8",
    );
    const stageRouter = readFileSync(
      join(inspectorRoot, "panels/StudyStageInspectorRouter.tsx"),
      "utf8",
    );

    expect(studyPanel).toContain("useRegisterInspectorEditSession");
    expect(studyPanel).toContain('type: "revertStageDrafts"');
    expect(stageRouter).toContain("useRegisterInspectorEditSession");
    expect(stageRouter).toMatch(/useRegisterInspectorEditSession\(\s*"staged"/);
  });

  it("keeps visualization Reset relative to the applied target baseline", () => {
    const visualizationPanel = readFileSync(
      join(inspectorRoot, "panels/ObjectVisualizationPanel.tsx"),
      "utf8",
    );

    expect(visualizationPanel).toContain("ObjectVisualizationAppliedBaseline");
    expect(visualizationPanel).toContain("visualizationDirty");
    expect(visualizationPanel).toContain("restoreAppliedBaseline");
  });

  it("keeps migrated Visualization composition out of compatibility cards", () => {
    const overview = readFileSync(
      join(
        inspectorRoot,
        "panels/ObjectVisualizationOverview.tsx",
      ),
      "utf8",
    );
    const targetSections = readFileSync(
      join(
        inspectorRoot,
        "panels/ObjectVisualizationTargetSection.tsx",
      ),
      "utf8",
    );
    const visualizationCss = readFileSync(
      join(stylesRoot, "inspector-visualization.css"),
      "utf8",
    );
    const tailwindTheme = readFileSync(
      join(stylesRoot, "tailwind-theme.css"),
      "utf8",
    );

    expect(overview).not.toContain("InspectorSection");
    expect(overview).not.toContain("fm-inspector-section");
    expect(targetSections).not.toContain("fm-inspector-segmented");
    expect(visualizationCss).not.toMatch(
      /\.fm-(?:inspector-section|inspector-input|inspector-select|tabs-trigger|button)\b/,
    );
    expect(tailwindTheme).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it("keeps every retained Inspector CSS class reachable from source", () => {
    const css = readdirSync(stylesRoot)
      .filter((name) => /^inspector.*\.css$/.test(name))
      .map((name) => readFileSync(join(stylesRoot, name), "utf8"))
      .join("\n");
    const referencedClasses = new Set<string>();
    for (const path of filesBelow(join(appRoot, "src"), /\.tsx?$/)) {
      const content = readFileSync(path, "utf8");
      for (const match of content.matchAll(/\bfm-[\w-]+/g)) {
        referencedClasses.add(match[0]);
      }
    }
    const classes = [...new Set(
      (css.match(/\.fm-[\w-]+/g) ?? []).map((value) => value.slice(1)),
    )];
    const dynamicClasses = new Set([
      ...Array.from({ length: 8 }, (_, index) => `fm-region-card__dot--${index}`),
      "fm-sampling-plan--ready",
      "fm-sampling-plan--warning",
      "fm-sinc-preview__message--preview_only",
      "fm-sinc-preview__message--unavailable",
    ]);

    expect(classes.filter((className) => !referencedClasses.has(className) && !dynamicClasses.has(className))).toEqual([]);
  });

  it("enforces the canonical 8-slot InspectorTemplate @container inspector queries and 7 domain hues", () => {
    const inspectorCss = readFileSync(join(stylesRoot, "inspector.css"), "utf8");

    expect(inspectorCss).toContain("container: inspector / inline-size;");
    expect(inspectorCss).toContain("@container inspector (min-width: 22rem)");
    expect(inspectorCss).toContain("@container inspector (min-width: 26rem)");
    expect(inspectorCss).toContain("@container inspector (min-width: 30rem)");
    for (const domain of [
      "geometry",
      "material",
      "physics",
      "study",
      "visualization",
      "mesh",
      "definition",
    ]) {
      expect(inspectorCss).toContain(`.fm-inspector[data-domain="${domain}"]`);
    }
    expect(inspectorCss).not.toContain("!important");
    expect(inspectorCss).not.toContain("text-transform: uppercase");
    expect(inspectorCss).not.toMatch(/@media\s*\(\s*max-width:/i);
  });
});
