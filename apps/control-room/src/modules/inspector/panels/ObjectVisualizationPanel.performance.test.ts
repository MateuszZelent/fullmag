import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource =
  readFileSync(join(process.cwd(), "src/modules/inspector/panels/ObjectVisualizationPanel.tsx"), "utf8") +
  readFileSync(join(process.cwd(), "src/modules/inspector/panels/ObjectVisualizationHelpers.ts"), "utf8") +
  readFileSync(join(process.cwd(), "src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx"), "utf8");

describe("ObjectVisualizationPanel performance contracts", () => {
  it("stages range-field commits until interaction boundaries", () => {
    expect(panelSource).toContain("pendingValueRef");
    expect(panelSource).toContain("queuedDraftValueRef");
    expect(panelSource).toContain("window.requestAnimationFrame");
    expect(panelSource).toContain("window.cancelAnimationFrame");
    expect(panelSource).not.toContain("window.setTimeout(");
    expect(panelSource).toContain("onPointerUp={flushDraft}");
    expect(panelSource).toContain("onPointerCancel={flushDraft}");
    expect(panelSource).toContain("onKeyUp={flushDraft}");
    expect(panelSource).toContain("onBlur={flushDraft}");
  });

  it("uses the field catalog resource instead of session status field revisions", () => {
    expect(panelSource).toContain("useFieldCatalogResource");
    expect(panelSource).toContain("fieldCatalogRequested");
    expect(panelSource).toContain("shouldLoadObjectVisualizationFieldCatalog");
    expect(panelSource).toContain("fieldCatalog");
    expect(panelSource).not.toContain("status?.resources.field_revision");
    expect(panelSource).not.toContain("status?.resources.fields_revision");
  });

  it("selects only the session status fields needed for mesh manifest gating", () => {
    expect(panelSource).toContain("useSessionStatusSelector");
    expect(panelSource).toContain("selectObjectVisualizationManifestStatus");
    expect(panelSource).toContain("objectVisualizationManifestStatusEquals");
    expect(panelSource).toContain("shouldLoadRuntimeMeshManifest(Boolean(target), manifestStatus)");
    expect(panelSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(panelSource).not.toContain("sessionStatus.data");
  });

  it("selects only visualization overrides relevant to the inspected target", () => {
    expect(panelSource).toContain("useObjectVisualizationController");
    expect(panelSource).toContain("useObjectVisualizationSelector");
    expect(panelSource).toContain("selectObjectVisualizationPanelSnapshot");
    expect(panelSource).toContain("objectVisualizationPanelSnapshotEquals");
    expect(panelSource).not.toContain("useObjectVisualizationRegistry()");
  });

  it("keeps ordinary visualization controls independent from opt-in Debug demand", () => {
    expect(panelSource).not.toContain("useVisualizationDebugSnapshots");
    expect(panelSource).not.toContain("kernel.visualizationDebug.request");
    expect(panelSource).not.toContain("VisualizationDebugSnapshot");
  });

  it("uses a revision-bounded local target patch while remote visualization state is pending", () => {
    expect(panelSource).toContain("visualization.patchTargetPending(");
    expect(panelSource).toContain("visualizationState.rawData?.revision");
  });

  it("labels and keeps viewport-only rendering preferences out of pending backend transactions", () => {
    expect(panelSource).toContain("visualization.patchViewportPreferences(");
    expect(panelSource).toContain("viewportPreferencesPatch");
    expect(panelSource).toContain("This viewport only");
  });

  it("disables every pass control while a target is hidden but preserves Visible and reset", () => {
    expect(panelSource).toContain("const passControlsDisabled = pending || !settings?.visible;");
    expect(panelSource).toContain("label=\"Visible\"");
    expect(panelSource).toContain("disabled={pending}");
    expect(panelSource).toContain("resetLabel={visualizationResetActionLabel(target.kind)}");
    expect(panelSource).toContain("disabled={pending}");
  });

  it("renders target quantity selection inside the visualization inspector", () => {
    expect(panelSource).toContain("VisualizationQuantitySection");
    expect(panelSource).toContain('label="Quantity source"');
    expect(panelSource).toContain("quantitySourcePatch(settings, event.target.value)");
    expect(panelSource).toContain("onFieldCatalogRequest()");
  });

  it("keeps target controls from patching the active analysis overlay", () => {
    expect(panelSource).not.toContain("settingsWithAnalysisField");
    expect(panelSource).not.toContain("analysisFieldOverlay.update");
    expect(panelSource).not.toContain("analysisAppearancePatchFromVisualizationPatch");
  });

  it("can propagate object visualization edits to child region targets", () => {
    expect(panelSource).toContain("resolveObjectChildRegionVisualizationTargets");
    expect(panelSource).toContain("patchChildRegions");
    expect(panelSource).toContain("Apply edits to child regions");
    expect(panelSource).toContain("patchTargets");
    expect(panelSource).toContain("Clear child region overrides");
    expect(panelSource).toContain("resetChildRegionTargets");
  });

  it("renders the airbox synthetic vector developer toggle locally", () => {
    expect(panelSource).toContain('label="Dev fallback +Z"');
    expect(panelSource).toContain("airboxSyntheticVectorsEnabled");
    expect(panelSource).toContain("visualization.patchViewportPreferences(resolvedTarget, localPatch)");
  });

  it("does not promise per-part persistence for object-owned surface vector toggles", () => {
    expect(panelSource).toContain('aria-label="Object target vector visibility"');
    expect(panelSource).toContain(">Object surfaces<");
    expect(panelSource).not.toContain("Per-part vector visibility");
  });

  it("shows the canonical selected target beside every surface-vector action", () => {
    expect(panelSource).toContain("resolveSelectedTargetVectorMeshPartRows");
    expect(panelSource).toContain("fm-visualization-part-toggle__target");
    expect(panelSource).toContain("part.actionTargetLabel");
  });

  it("renders scalar colormap controls in the visualization inspector", () => {
    expect(panelSource).toContain("resolveSurfaceColorSourceItems(settings.activeQuantityId)");
    expect(panelSource).toContain("ScalarColorbarControl");
    expect(panelSource).toContain("useFieldMetaResource");
    expect(panelSource).toContain("shouldShowSurfaceFieldColorbar");
    expect(panelSource).toContain("surfaceColorSourceFieldMetaComponent");
    expect(panelSource).toContain("component: colorbarComponent ?? null");
    expect(panelSource).toContain("SCALAR_COLOR_PALETTE_ITEMS.map");
    expect(panelSource).toContain("scalarColorPalettePatch(event.target.value)");
    expect(panelSource).toContain("formatScalarColorbarValue");
    expect(panelSource).toContain("fieldMeta.data?.stats");
    expect(panelSource).not.toContain(">min<");
    expect(panelSource).not.toContain(">max<");
    expect(panelSource).not.toContain("colormap: scalarColorPalette");
    expect(panelSource).not.toContain("delete remotePatch.scalarColorPalette");
  });
});
