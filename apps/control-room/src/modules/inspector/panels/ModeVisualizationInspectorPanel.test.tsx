import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainEigenModeFieldMetaResource: () => ({ data: null, status: "idle" }),
  useFrequencyDomainResponseFieldMetaResource: () => ({ data: null, status: "idle" }),
}));

import { resolveInspectorPanel } from "../inspectorRegistry";
import { executeModeVisualizationActivation } from "./ModeVisualizationInspectorPanel";
import {
  analysisFieldViewOptions,
  modeFieldComponentOptions,
  selectedField3DPlotStatus,
} from "./frequency-domain/FrequencyDomainHelpers";
import { buildModeVisualizationBreadcrumbs } from "./mode-visualization/ModeVisualizationBreadcrumbs";

const executeMock = vi.fn(() => Promise.resolve({ status: "success" }));

const mockKernel = {
  commands: {
    execute: executeMock,
    get: () => undefined,
    register: () => () => {},
  },
  bus: { emit: () => {}, on: () => () => {} },
  layout: {
    get: () => ({
      activeViewportMainModuleId: "viewport-3d",
      lastSpatialViewportMainModuleId: "viewport-3d",
    }),
    setActiveViewportMainModule: () => {},
    subscribe: () => () => {},
  },
  resources: {
    getRevision: () => 0,
    read: () => null,
    subscribe: () => () => {},
  },
  selection: { get: () => null, set: () => {} },
  analysisFieldOverlay: new AnalysisFieldOverlayController(),
  visualizationSync: {
    getSnapshot: () => ({ version: 1 }),
    queuePatch: () => {},
    subscribe: () => () => {},
  },
  visualization: {
    getSnapshot: () => ({ defaults: {}, overrides: {}, version: 1 }),
    queuePatch: () => {},
    subscribe: () => () => {},
  },
  visualizationDebug: new VisualizationDebugController(),
} as unknown as KernelApi;

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { colormap: "viridis", quantity: { colormap: "inferno" } },
    status: "ready",
  }),
}));

function modeSelection() {
  return {
    kind: "object.mode_visualization",
    label: "Eigenmode 5",
    moduleSource: "results",
    nodeId: "model:object:film:visualization:mode-visualization",
    objectId: "film",
    ref: {
      fieldId: "field-eigen-456",
      kind: "object.mode_visualization" as const,
      modeIndex: 5,
      nodeId: "model:object:film:visualization:mode-visualization",
      objectId: "film",
      sampleIndex: 2,
      source: "eigen-mode" as const,
      type: "mode-visualization" as const,
      view: "phase_rotated_real",
      visualizationTargetId:
        "mode:film:eigen-mode:field-eigen-456" as const,
    },
  };
}

describe("ModeVisualizationInspectorPanel", () => {
  it("keeps one canonical mode-visualization owner with view controls", () => {
    const contribution = resolveInspectorPanel({ kind: "object.mode_visualization" });
    if (!contribution) throw new Error("Missing mode visualization route");
    const Component = contribution.component;
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        <Component selection={modeSelection()} />
      </KernelContext.Provider>,
    );

    expect(html).toContain('data-inspector-owner="mode-visualization.overview"');
    expect(html).toContain("Mode field view");
    expect(html).toContain("Display passes");
    expect(html).toContain('aria-label="Mode visualization phase slider"');
    expect(html).toContain('aria-label="Play mode phase animation"');
    expect(html).toContain('aria-label="Mode visualization path"');
  });

  it("preserves the canonical root ref in its breadcrumb", () => {
    const selection = modeSelection();
    const [object, mode] = buildModeVisualizationBreadcrumbs(selection);

    expect(object?.selection).toMatchObject({
      kind: "object.root",
      objectId: "film",
      ref: { type: "scene-object", visualizationTargetId: "object:film" },
    });
    expect(mode).toMatchObject({
      current: true,
      selection: { kind: "object.mode_visualization", ref: selection.ref },
    });
  });

  it("executes the canonical overlay command through the root view action", async () => {
    executeMock.mockClear();

    await executeModeVisualizationActivation({
      kernel: mockKernel,
      label: "Eigenmode 5",
      sourceDetail: "Mode visualization test",
      target: { fieldId: "field-eigen-456", source: "eigen-mode" },
      view: "real",
    });

    expect(executeMock).toHaveBeenCalledWith(
      "analysis.eigen.plot-mode-3d",
      expect.objectContaining({
        source: "inspector",
        sourceDetail: "Mode visualization test",
      }),
      expect.objectContaining({
        fieldId: "field-eigen-456",
        source: "eigen-mode",
        view: "real",
      }),
    );
  });

  it("uses field metadata views as the canonical capability list", () => {
    expect(analysisFieldViewOptions(
      ["complex", "real", "imag", "phase_rotated_real", "real"],
      "phase_rotated_real",
    )).toEqual(["phase_rotated_real", "abs", "real", "imag"]);
  });

  it("derives mode components from ready field metadata", () => {
    expect(modeFieldComponentOptions({
      components: ["x", "z"],
      component_count: 3,
    })).toEqual([
      { label: "|delta m|", value: "magnitude" },
      { label: "delta m_x", value: "component_x" },
      { label: "delta m_z", value: "component_z" },
    ]);
    expect(selectedField3DPlotStatus({
      component_basis: "local_tangent_frame",
      component_count: 2,
      resource_key: "field-resource",
      value_kind: "complex_tangent_vector",
    })).toContain("reconstruction");
  });

  it("reports unavailable field metadata instead of implying 3D support", () => {
    const contribution = resolveInspectorPanel({ kind: "object.mode_visualization" });
    if (!contribution) throw new Error("Missing mode visualization route");
    const Component = contribution.component;
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        <Component selection={modeSelection()} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Mode field metadata is not available");
    expect(html).toContain('aria-label="Mode visualization 3D view"');
    expect(html).toContain('disabled=""');
  });

  it("renders an empty state without a target ref", () => {
    const contribution = resolveInspectorPanel({ kind: "object.mode_visualization" });
    if (!contribution) throw new Error("Missing mode visualization route");
    const Component = contribution.component;
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        <Component
          selection={{
            kind: "object.mode_visualization",
            label: "Mode visualization",
            moduleSource: "results",
            nodeId: "test-node",
            objectId: null,
            ref: null,
          }}
        />
      </KernelContext.Provider>,
    );

    expect(html).toContain("No mode visualization target selected.");
  });
});
