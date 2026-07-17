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
    expect(css).not.toMatch(/(?:min-)?height:\s*2[0-8]px/);
    expect(css).not.toMatch(/gap:\s*[12]px(?:;|\s)/);
    expect(css.match(/^\.fm-inspector\s*\{/gm)).toHaveLength(1);
    expect(css.match(/^\.fm-inspector__header\s*\{/gm)).toHaveLength(1);
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

  it("does not replace canonical frequency-response values with instructional prose", () => {
    const responseSection = readFileSync(
      join(inspectorRoot, "panels/FrequencyDomainResponseSection.tsx"),
      "utf8",
    );

    expect(responseSection).not.toContain("finite A/m component");
    expect(responseSection).not.toContain("generated unless an explicit list is set");
  });

  it("routes regional field-drive drafts through the shared Inspector action bar", () => {
    const fieldDrivePanel = readFileSync(
      join(inspectorRoot, "panels/RegionalFieldDrivePanel.tsx"),
      "utf8",
    );

    expect(fieldDrivePanel).toContain("useRegisterInspectorEditSession");
    expect(fieldDrivePanel).not.toContain("Save drive");
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
    expect(stageRouter).toContain('useRegisterInspectorEditSession(\n    "staged"');
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
    const source = filesBelow(join(appRoot, "src"), /\.tsx?$/)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
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

    expect(classes.filter((className) => !source.includes(className) && !dynamicClasses.has(className))).toEqual([]);
  });
});
