import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CrossSectionDraft } from "@/kernel/workspace/crossSectionWorkspace";

import { CrossSectionDraftEditor } from "./CrossSectionDraftEditor";

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        planarMonitors: {
          list: vi.fn(),
        },
      },
    },
    layout: {
      setActiveViewportMainModule: vi.fn(),
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    selection: {
      set: vi.fn(),
    },
    resources: {
      getRevision: vi.fn(() => 0),
      subscribe: vi.fn(() => () => undefined),
    },
    visualizationSync: {
      queuePatch: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { planar: { source: { kind: "default" } } },
  }),
}));

const draft: CrossSectionDraft = {
  colorScale: "viridis",
  edgeWidth: 1.5,
  filterExpression: "quality < 0.3",
  frameExtent: "universe",
  id: "draft",
  includeWireframe: true,
  metric: "skewness",
  name: "Draft Cross-Section",
  plane: "xy",
  positionPercent: 50,
  rotationDegrees: 0,
  shrinkFactor: 0.8,
};
const crossSectionDraftEditorSourceUrl = new URL(
  "./CrossSectionDraftEditor.tsx",
  import.meta.url,
);

describe("CrossSectionDraftEditor", () => {
  it("renders the editable cut-frame controls without exposing unsupported frame geometry as active choices", () => {
    const html = renderToStaticMarkup(<CrossSectionDraftEditor draft={draft} />);

    expect(html).toContain("Cut Frame");
    expect(html).toContain("Draft Cross-Section");
    expect(html).toContain("Universe");
    expect(html).toContain('disabled="" value="magnetic_domain"');
    expect(html).toContain('disabled="" value="object_bounds"');
    expect(html).toContain('disabled="" value="custom"');
    expect(html).toContain('aria-label="Rotation"');
    expect(html).toContain('max="180"');
    expect(html).toContain('min="-180"');
    expect(html).not.toContain('aria-label="Rotation" disabled=""');
    expect(html).toContain("Apply monitor");
  });

  it("keeps draft frame edits local and selects a committed monitor through planar state", () => {
    const source = readFileSync(crossSectionDraftEditorSourceUrl, "utf8");

    expect(source).toContain("updateCrossSectionDraft(patch);");
    expect(source).toContain(
      'planar: { source: { kind: "monitor", monitor_id: monitor.id } }',
    );
    expect(source).not.toContain("fieldMapStore");
    expect(source).not.toContain("crossSectionVisualizationPatchFromDraft");
  });
});
