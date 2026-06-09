import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/ObjectVisualizationPanel.tsx"),
  "utf8",
);

describe("ObjectVisualizationPanel performance contracts", () => {
  it("stages range-field commits until interaction boundaries", () => {
    expect(panelSource).toContain("pendingValueRef");
    expect(panelSource).toContain("setDraftOverride(nextValue)");
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

  it("renders target quantity selection inside the visualization inspector", () => {
    expect(panelSource).toContain("VisualizationQuantitySection");
    expect(panelSource).toContain('label="Quantity source"');
    expect(panelSource).toContain("quantitySourcePatch(settings, event.target.value)");
    expect(panelSource).toContain("onFieldCatalogRequest()");
  });
});
