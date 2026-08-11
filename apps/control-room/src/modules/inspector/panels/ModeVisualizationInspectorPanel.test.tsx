import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { KernelApi } from "@/kernel/types";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import { ANALYSIS_FIELD_OVERLAY_COMMANDS } from "@/kernel/visualization/analysisFieldOverlayCommandContributions";
import type { FrequencyDomainFieldResource } from "@/kernel/api/apiTypes";

import {
  buildModeFieldDiagnosticRows,
} from "./ModeVisualizationInspectorPanel";
import { resolveInspectorPanel } from "../inspectorRegistry";
import { buildModeVisualizationBreadcrumbs } from "./mode-visualization/ModeVisualizationBreadcrumbs";
import { ModeVisualizationPhaseControl } from "./mode-visualization/ModeVisualizationViewPanel";

const metadataCalls = vi.hoisted(() => ({ eigen: 0, response: 0 }));
const executeMock = vi.fn(() => Promise.resolve({ status: "success" }));
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
  analysisFieldOverlay: new AnalysisFieldOverlayController(),
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
  useFrequencyDomainEigenModeFieldMetaResource: () => {
    metadataCalls.eigen += 1;
    return { data: null, status: "idle" };
  },
  useFrequencyDomainResponseFieldMetaResource: () => {
    metadataCalls.response += 1;
    return { data: null, status: "idle" };
  },
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

  it("renders a navigable object and mode breadcrumb for every mode owner", () => {
    for (const kind of [
      "object.mode_visualization",
      "object.mode_visualization.group",
      "object.mode_visualization.field",
      "object.mode_visualization.view",
    ] as const) {
      const html = renderModeOwner(kind);
      expect(html).toContain('aria-label="Mode visualization path"');
      expect(html).toContain(">Object 123</button>");
      expect(html).toContain("Mode visualization");
      if (kind !== "object.mode_visualization") {
        expect(html).toContain(">Mode visualization</button>");
      }
    }
  });

  it("preserves canonical object and mode selection refs in breadcrumbs", () => {
    const selection = {
      kind: "object.mode_visualization.group",
      label: "Eigenmodes",
      moduleSource: "study",
      nodeId: "model:object:film:visualization:mode-visualization:eigen",
      objectId: "film",
      ref: {
        fieldId: "field-a",
        fieldIds: ["field-a", "field-b"],
        kind: "object.mode_visualization.group",
        nodeId: "model:object:film:visualization:mode-visualization:eigen",
        objectId: "film",
        source: "eigen-mode",
        type: "mode-visualization",
        visualizationTargetId: "mode:film:eigen-mode:field-a",
      },
    } as const;

    const [object, mode, current] = buildModeVisualizationBreadcrumbs(selection);
    expect(object?.selection).toMatchObject({
      kind: "object.root",
      nodeId: "model:object:film",
      objectId: "film",
      ref: {
        kind: "object.root",
        type: "scene-object",
        visualizationTargetId: "object:film",
      },
    });
    expect(mode?.selection).toMatchObject({
      kind: "object.mode_visualization",
      nodeId: "model:object:film:visualization:mode-visualization",
      objectId: "film",
      ref: {
        fieldId: "field-a",
        kind: "object.mode_visualization",
        source: "eigen-mode",
        type: "mode-visualization",
      },
    });
    expect(mode?.selection.ref).not.toHaveProperty("fieldIds");
    expect(current).toMatchObject({ current: true, label: "Eigenmodes" });
  });

  it("renders the complete canonical field list for a mode group", () => {
    const html = renderModeOwner("object.mode_visualization.group", {
      fieldIds: [
        "analysis:eigen:sample-0000:mode-0002",
        "analysis:eigen:sample-0000:mode-0003",
        "analysis:eigen:sample-0001:mode-0000",
      ],
    });

    expect(html).toContain("analysis:eigen:sample-0000:mode-0002");
    expect(html).toContain("analysis:eigen:sample-0000:mode-0003");
    expect(html).toContain("analysis:eigen:sample-0001:mode-0000");
    expect(html).not.toContain("Representative published field");
  });

  it("keeps metadata requests in the field owner and out of the view owner", () => {
    metadataCalls.eigen = 0;
    metadataCalls.response = 0;

    renderModeOwner("object.mode_visualization.field");
    renderModeOwner("object.mode_visualization.view");

    expect(metadataCalls).toEqual({ eigen: 1, response: 1 });
  });

  it("keeps the view owner limited to view controls and overlay activation", () => {
    const html = renderModeOwner("object.mode_visualization.view");

    expect(html).toContain("Mode field view");
    expect(html).toContain("Display passes");
    expect(html).not.toContain("Mode vector field diagnostics");
    expect(html).not.toContain("Field info");
    expect(html).not.toContain("Resource key");
    expect(html).not.toContain("Published field");
  });

  it("renders an interactive phase control instead of a static command default", () => {
    const html = renderModeOwner("object.mode_visualization.view");

    expect(html).toContain('aria-label="Mode visualization phase"');
    expect(html).not.toContain("0 rad command default");
  });

  it.each([
    ["eigen-mode", "analysis.eigen.set-mode-3d-phase"],
    ["frequency-response", "analysis.frequency-domain.set-3d-phase"],
  ] as const)(
    "executes the %s phase command with phaseRad and updates the overlay",
    async (source, commandId) => {
      const panelModule = await import("./ModeVisualizationInspectorPanel");
      const executePhase = (
        panelModule as unknown as {
          executeModeVisualizationPhase?: (options: {
            kernel: KernelApi;
            sourceDetail: string;
            target: { source: "eigen-mode" | "frequency-response" };
            phaseRad: number;
          }) => Promise<{ status: string }>;
        }
      ).executeModeVisualizationPhase;

      expect(executePhase).toBeTypeOf("function");
      if (!executePhase) return;

      const overlay = new AnalysisFieldOverlayController();
      overlay.set({
        fieldId: "field-mode-123",
        label: "Mode 5",
        query: { phase_rad: 0, view: "phase_rotated_real" },
        source,
        visualizationPhaseRad: 0,
      });
      const commands = new CommandRegistry();
      for (const command of ANALYSIS_FIELD_OVERLAY_COMMANDS) {
        if (command.id === commandId) commands.register(command);
      }

      const phaseKernel = {
        ...mockKernel,
        analysisFieldOverlay: overlay,
        commands,
      } as unknown as KernelApi;
      const result = await executePhase({
        kernel: phaseKernel,
        sourceDetail: "Mode visualization phase test",
        target: { source },
        phaseRad: 1.25,
      });

      expect(result.status).toBe("completed");
      expect(overlay.getSnapshot()).toMatchObject({
        source,
        visualizationPhaseRad: 1.25,
      });
      const phaseHtml = renderToStaticMarkup(
        <ModeVisualizationPhaseControl
          disabled={false}
          onChange={() => undefined}
          onSetPhase={() => undefined}
          phaseRad={String(overlay.getSnapshot()?.visualizationPhaseRad ?? 0)}
        />,
      );
      expect(phaseHtml).toContain('aria-label="Mode visualization phase"');
      expect(phaseHtml).toContain('value="1.25"');
    },
  );

  it("executes the canonical mode overlay command through the view action", async () => {
    const panelModule = await import("./ModeVisualizationInspectorPanel");
    expect(panelModule).toHaveProperty("executeModeVisualizationActivation");
    const executeActivation = (
      panelModule as unknown as {
        executeModeVisualizationActivation: (options: {
          kernel: KernelApi;
          label: string;
          sourceDetail: string;
          target: {
            fieldId: string;
            objectId: string;
            source: "eigen-mode";
          };
          view: string;
        }) => Promise<unknown>;
      }
    ).executeModeVisualizationActivation;
    executeMock.mockClear();

    await executeActivation({
      kernel: mockKernel,
      label: "Eigenmode 5",
      sourceDetail: "Mode visualization test",
      target: {
        fieldId: "field-eigen-456",
        objectId: "object-123",
        source: "eigen-mode",
      },
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
        label: "Eigenmode 5",
        source: "eigen-mode",
        view: "real",
      }),
    );
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

  it("renders eigen-mode resource metadata only in the field owner", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = {
      type: "mode-visualization",
      objectId: "object-123",
      source: "eigen-mode",
      fieldId: "field-eigen-456",
      sampleIndex: 2,
      modeIndex: 5,
      view: "phase_rotated_real",
      kind: "object.mode_visualization.field",
      nodeId: "test-node",
      visualizationTargetId: "mode:object-123:eigen-mode:field-eigen-456",
    };

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        {(() => {
          const Component = resolveInspectorPanel({
            kind: "object.mode_visualization.field",
          })?.component;
          if (!Component) throw new Error("Missing mode visualization field route");
          return <Component
          selection={{
            kind: "object.mode_visualization.field",
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

    expect(html).toContain("Field resource");
    expect(html).toContain("Requested field");
    expect(html).toContain("field-eigen-456");
    expect(html).toContain("eigen-mode");
    expect(html).not.toContain("Display passes");
  });

  it("renders response resource metadata only in the field owner", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = {
      type: "mode-visualization",
      objectId: "object-789",
      source: "frequency-response",
      fieldId: "field-resp-999",
      frequencyIndex: 4,
      view: "amplitude",
      kind: "object.mode_visualization.field",
      nodeId: "test-node",
      visualizationTargetId: "mode:object-789:frequency-response:field-resp-999",
    };

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={mockKernel}>
        {(() => {
          const Component = resolveInspectorPanel({
            kind: "object.mode_visualization.field",
          })?.component;
          if (!Component) throw new Error("Missing mode visualization field route");
          return <Component
          selection={{
            kind: "object.mode_visualization.field",
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

    expect(html).toContain("Field resource");
    expect(html).toContain("Requested field");
    expect(html).toContain("field-resp-999");
    expect(html).toContain("frequency-response");
    expect(html).not.toContain("Display passes");
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
