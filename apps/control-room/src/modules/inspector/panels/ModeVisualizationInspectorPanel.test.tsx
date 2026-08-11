import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import type { FrequencyDomainFieldResource } from "@/kernel/api/apiTypes";

import {
  buildModeFieldDiagnosticRows,
} from "./ModeVisualizationInspectorPanel";
import { resolveInspectorPanel } from "../inspectorRegistry";

const executeMock = vi.fn(() => Promise.resolve());
const queuePatchMock = vi.fn();

const mockKernel = {
  commands: {
    execute: executeMock,
    register: () => () => {},
  },
  bus: {
    emit: () => {},
    on: () => () => {},
  },
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
    subscribe: () => () => {},
    read: () => null,
  },
  selection: {
    get: () => null,
    set: () => {},
  },
  visualizationSync: {
    queuePatch: queuePatchMock,
    subscribe: () => () => {},
    getSnapshot: () => ({ version: 1 }),
  },
  visualization: {
    queuePatch: queuePatchMock,
    subscribe: () => () => {},
    getSnapshot: () => ({ version: 1, defaults: {}, overrides: {} }),
  },
  visualizationDebug: new VisualizationDebugController(),
} as unknown as KernelApi;

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    status: "ready",
    data: {
      colormap: "viridis",
      quantity: {
        colormap: "inferno",
      },
    },
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainEigenModeFieldMetaResource: () => ({
    data: null,
    status: "idle",
  }),
  useFrequencyDomainResponseFieldMetaResource: () => ({
    data: null,
    status: "idle",
  }),
}));

describe("ModeVisualizationInspectorPanel", () => {
  function renderModeOwner(
    kind:
      | "object.mode_visualization"
      | "object.mode_visualization.group"
      | "object.mode_visualization.field"
      | "object.mode_visualization.view",
    overrides: Record<string, unknown> = {},
  ): string {
    const contribution = resolveInspectorPanel({ kind });
    if (!contribution) throw new Error(`Missing route for ${kind}`);
    const Component = contribution.component;
    const ref = {
      type: "mode-visualization",
      objectId: "object-123",
      source: "eigen-mode",
      fieldId: "field-eigen-456",
      sampleIndex: 2,
      modeIndex: 5,
      view: "phase_rotated_real",
      kind,
      nodeId: `test-node:${kind}`,
      visualizationTargetId: "mode:object-123:eigen-mode:field-eigen-456",
      ...overrides,
    };

    return renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        <Component
          selection={{
            kind,
            label: kind.endsWith(".group") ? "Eigenmodes" : "Eigenmode 5",
            nodeId: `test-node:${kind}`,
            objectId: "object-123",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref: ref as any,
            moduleSource: "study",
          }}
        />
      </KernelContext.Provider>,
    );
  }

  it("routes overview, group, field, and view to distinct semantic owners", () => {
    const overview = renderModeOwner("object.mode_visualization");
    const group = renderModeOwner("object.mode_visualization.group");
    const field = renderModeOwner("object.mode_visualization.field");
    const view = renderModeOwner("object.mode_visualization.view");

    expect(overview).toContain(
      'data-inspector-owner="mode-visualization.overview"',
    );
    expect(overview).toContain("Mode family");
    expect(overview).not.toContain("Mode field view");

    expect(group).toContain(
      'data-inspector-owner="mode-visualization.group"',
    );
    expect(group).toContain("Available fields");
    expect(group).not.toContain("Mode field view");

    expect(field).toContain(
      'data-inspector-owner="mode-visualization.field"',
    );
    expect(field).toContain("Resource key");
    expect(field).not.toContain("Mode field view");

    expect(view).toContain(
      'data-inspector-owner="mode-visualization.view"',
    );
    expect(view).toContain("Mode field view");
    expect(view).toContain("Display passes");
  });

  it("renders empty state when no target is selected", () => {
    const contribution = resolveInspectorPanel({ kind: "object.mode_visualization" });
    if (!contribution) throw new Error("Missing mode visualization overview route");
    const Component = contribution.component;
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        <Component
          selection={{
            kind: "object.mode_visualization",
            label: "Mode Vis",
            nodeId: "test-node",
            objectId: null,
            ref: null,
            moduleSource: "study",
          }}
        />
      </KernelContext.Provider>
    );

    expect(html).toContain("No mode visualization target selected.");
  });

  it("renders target fields for eigen-mode source", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = {
      type: "mode-visualization",
      objectId: "object-123",
      source: "eigen-mode",
      fieldId: "field-eigen-456",
      sampleIndex: 2,
      modeIndex: 5,
      view: "phase_rotated_real",
      kind: "object.mode_visualization.view",
      nodeId: "test-node",
      visualizationTargetId: "mode:object-123:eigen-mode:field-eigen-456",
    };

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        {(() => {
          const Component = resolveInspectorPanel({
            kind: "object.mode_visualization.view",
          })?.component;
          if (!Component) throw new Error("Missing mode visualization view route");
          return <Component
          selection={{
            kind: "object.mode_visualization.view",
            label: "Eigenmode 5",
            nodeId: "test-node",
            objectId: "object-123",
            ref,
            moduleSource: "study",
          }}
          />;
        })()}
      </KernelContext.Provider>
    );

    expect(html).toContain("object-123");
    expect(html).toContain("Eigenmode");
    expect(html).toContain("sample 2, mode 5");
    expect(html).toContain("field-eigen-456");
    expect(html).toContain("Phase-rotated real");
    expect(html).toContain("Mode vector field diagnostics");
    expect(html).toContain("Field info");
  });

  it("renders target fields for frequency-response source", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = {
      type: "mode-visualization",
      objectId: "object-789",
      source: "frequency-response",
      fieldId: "field-resp-999",
      frequencyIndex: 4,
      view: "amplitude",
      kind: "object.mode_visualization.view",
      nodeId: "test-node",
      visualizationTargetId: "mode:object-789:frequency-response:field-resp-999",
    };

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        {(() => {
          const Component = resolveInspectorPanel({
            kind: "object.mode_visualization.view",
          })?.component;
          if (!Component) throw new Error("Missing mode visualization view route");
          return <Component
          selection={{
            kind: "object.mode_visualization.view",
            label: "Driven Point 4",
            nodeId: "test-node",
            objectId: "object-789",
            ref,
            moduleSource: "study",
          }}
          />;
        })()}
      </KernelContext.Provider>
    );

    expect(html).toContain("object-789");
    expect(html).toContain("Driven response");
    expect(html).toContain("frequency 4");
    expect(html).toContain("field-resp-999");
    expect(html).toContain("Complex (abs)");
  });

  it("builds vector field diagnostics from frequency-domain field metadata", () => {
    const rows = buildModeFieldDiagnosticRows({
      meta: {
        artifact_path: "response/field_meta/frequency_0004.json",
        available_views: ["phase_rotated_real", "real", "imag", "abs"],
        binary_layout: "complex_f64_pairs_little_endian",
        complex_pair_count: 3000,
        component_basis: "global_xyz",
        component_count: 3,
        components: ["x", "y", "z"],
        default_phase_rad: 0,
        default_view: "phase_rotated_real",
        field_id: "analysis:frequency-response:field-0004",
        payload_encoding: "f64_interleaved_real_imag_xyz",
        payload_value_count: 6000,
        quantity: "delta_m",
        resource_key: "data/fields/analysis:frequency-response:field-0004",
        schema_version: "frequency_domain_field.v1",
        source_family: "frequency-response",
        status: "ready",
        storage_format: "zarr",
        tangent_complex_pair_count: 2000,
        tangent_component_basis: "local_tangent_frame",
        tangent_component_count: 2,
        tangent_components: ["tangent_e1", "tangent_e2"],
        tangent_field_payload_path: "response/tangent/frequency_0004.bin",
        tangent_payload_value_count: 4000,
        tangent_value_kind: "complex_tangent_vector",
        value_kind: "complex_spatial_vector",
        zarr_array_path: "field",
        zarr_chunk_shape: [512, 6],
        zarr_dtype: "<f8",
        zarr_shape: [1000, 6],
        zarr_store_path: "response/field_payloads/frequency_0004.zarr",
        stats: {
          max: 2.5,
          mean: 0.25,
          min: -1.5,
          rms: 0.75,
        },
      } as FrequencyDomainFieldResource,
      metaStatus: "ready",
      target: {
        fieldId: "analysis:frequency-response:field-0004",
        source: "frequency-response",
      },
    });

    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Meta status", value: "ready" },
        { label: "Component count", value: "3" },
        { label: "Inferred nodes", value: "1,000" },
        { label: "Complex pairs", value: "3,000" },
        { label: "Payload values", value: "6,000" },
        { label: "Min", value: "-1.500000e+0" },
        { label: "Max", value: "2.500000e+0" },
        { label: "Zarr shape", value: "1000 x 6" },
        { label: "Tangent pairs", value: "2,000" },
      ]),
    );
  });
});
