import { randomUUID } from "node:crypto";
import { act, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-slider", () => ({
  Root: ({
    children,
    onValueChange,
    onValueCommit: _onValueCommit,
    value,
    ...rest
  }: {
    children?: ReactNode;
    onValueChange?: (next: number[]) => void;
    onValueCommit?: (next: number[]) => void;
    value?: number[];
  }) => (
    <div
      data-slot="mock-slider"
      data-value={String(value?.[0] ?? 0)}
      onClick={() => onValueChange?.([50])}
      {...rest}
    >
      {children}
    </div>
  ),
  Track: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Range: () => <div />,
  Thumb: () => <div />,
}));

import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import type { QuantityCatalogResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";
import {
  Viewport3DExportPanelOutlet,
  Viewport3DInspectorOutlet,
} from "@/modules/viewport-3d/components/Viewport3DInspectorOutlet";
import { Viewport3DSettingsContent } from "@/modules/viewport-3d/components/Viewport3DSettingsContent";
import { getViewport3DInspectorSnapshot } from "@/modules/viewport-3d/viewport3dInspectorState";

import {
  AirboxVisualizationDebugTemplatePanel,
  AirboxVisualizationTemplatePanel,
  MeshPartVisualizationDebugTemplatePanel,
  MeshPartVisualizationTemplatePanel,
  ModeVisualizationTemplatePanel,
  ObjectRegionVisualizationDebugTemplatePanel,
  ObjectRegionVisualizationTemplatePanel,
  ObjectVisualizationDebugTemplatePanel,
  ObjectVisualizationTemplatePanel,
} from "./TargetVisualizationSpecs";

function createFullParityKernel(options?: {
  antennaObjectId?: string;
}): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const layout = new LayoutController(bus);
  const execute = vi.fn(async () => ({ status: "completed" as const }));
  const queuePatch = vi.fn(() => ({ transactionId: "tx-parity" }));
  const realtimeSnapshot = Object.freeze({
    disrupted: false,
    status: "connected" as const,
  });
  const syncSnapshot = Object.freeze({
    inflightTargetIds: [] as readonly string[],
    pendingTargetIds: [] as readonly string[],
    version: 0,
  });

  return {
    analysisFieldOverlay: new AnalysisFieldOverlayController(),
    api: {
      resourceCacheScope: randomUUID(),
      analysis: {
        eigen: {
          modeFieldMeta: async () => ({
            available_views: ["phase_rotated_real", "abs", "real", "imag", "phase"],
            component_count: 3,
            components: ["x", "y", "z"],
            default_phase_rad: 0,
            default_view: "phase_rotated_real",
            resource_key: "eigen-mode-resource",
            value_kind: "complex_vector",
          }),
        },
        frequencyDomain: {
          eigenSpectrum: async () => ({
            modes: [],
            schema_version: "2.0.0",
          }),
          manifest: async () => ({
            capabilities: {},
            eigenmodes: { status: "ready", study_kind: "eigenmodes" },
            schema_version: "1.0.0",
          }),
        },
        frequencyResponse: {
          responseFieldMeta: async () => null,
        },
      },
      data: {
        fields: {
          availability: async () => ({
            carrier_id: "part:film-top",
            generation: "gen-1",
            materialized: true,
            pending: false,
            quantity_id: "m",
            reason_code: null,
            revision: 3,
            scope_id: "film",
            scope_kind: "object",
            state: "ready",
            supported: true,
            target_id: "object:film",
          }),
          catalog: async () => ({
            domain_generation_id: "gen-1",
            quantities: [
              {
                available: true,
                components: 3,
                domain: "magnetic_only",
                domain_generation_id: "gen-1",
                field_revision: 3,
                kind: "vector_field",
                label: "Magnetization",
                location: "cell",
                materialization_wall_time_ns: 0,
                materialized_at_unix_ms: 1,
                quantity_id: "m",
                source_revision: 3,
                source_step: 1,
                spatial: true,
                stale_by_steps: 0,
                state: "complete",
                ui_exposed: true,
                unit: "A/m",
              },
            ],
            revision: 3,
          }),
          meta: async () => ({
            components: 3,
            domain_generation_id: "gen-1",
            field_revision: 3,
            kind: "vector",
            label: "Magnetization",
            location: "node",
            quantity_id: "m",
            stats: { max: 1, mean: 0, min: -1 },
            unit: "A/m",
          }),
        },
        meshRegionMembership: async () => ({
          cell_count: 16,
          element_indices: [0, 1],
          node_indices: [0, 1, 2, 3],
          owner_object_id: "film",
          part_ids: ["part:film-top"],
          region_id: "core",
          revision: 1,
        }),
        meshRegionMemberships: async () => ({
          cell_count: 16,
          object_id: "film",
          region_id: "core",
          revision: 1,
        }),
        quantities: {
          catalog: async (): Promise<QuantityCatalogResource> => ({
            quantities: [
              {
                capability_state: "available",
                description: "Normalized magnetization",
                domain: "magnetic",
                id: "m",
                interactive_preview: true,
                label: "Magnetization",
                location: "node",
                materializable: true,
                materialization_state: "materialized",
                n_comp: 3,
                normalization_hint: "none",
                publication_state: "interactive",
                renderable: true,
                requestable: true,
                shape: "vector",
                solver_capability: "available",
                supports_export: true,
                supports_history: true,
                supports_preview_2d: true,
                supports_preview_3d: true,
                unit: "1",
              },
            ],
            schema_version: "2.0.0",
          }),
        },
      },
      meshing: {
        sharedDomain: {
          manifest: async () => ({
            mesh_parts: [
              {
                carrier_kind: "surface",
                id: "part:film-top",
                label: "Top surface",
                node_count: 64,
                object_id: "film",
              },
              {
                carrier_kind: "surface",
                id: "part:film-bottom",
                label: "Bottom surface",
                node_count: 64,
                object_id: "film",
              },
            ],
            regions: [{ id: "core", object_id: "film" }],
            topology_fingerprint: "topo-1",
          }),
        },
      },
      model: {
        scene: async () => ({
          antenna_field_solve_stages: options?.antennaObjectId
            ? [{ id: "ant-stage-1", source_object_id: options.antennaObjectId }]
            : [],
          objects: [
            { id: "film", role: "magnet" },
            ...(options?.antennaObjectId
              ? [{ id: options.antennaObjectId, role: "antenna" }]
              : []),
          ],
          revision: 4,
        }),
      },
      sessions: {
        current: {
          status: async () => ({
            capabilities: { explicit_topology: true },
            domain: { discretization: "fem", generation_id: "gen-1" },
            resources: { domain_generation_id: 1, mesh_revision: 2 },
            session: {
              request_scope_epoch: "req-1",
              session_epoch: "ep-1",
              session_id: "sess-parity",
            },
          }),
        },
        list: async () => ({
          schema_version: "2.0.0",
          sessions: [{ current: true, session_id: "sess-parity" }],
        }),
      },
      simulation: {
        solver: {
          status: async () => ({
            can_accept_commands: true,
            is_busy: false,
            revision: 1,
            run_id: null,
            runtime_state: "idle",
            runtime_status_code: "idle",
            runtime_status_kind: "idle",
            session_status: "ready",
            stage_kind: null,
            warnings: [],
          }),
        },
        stages: {
          execution: async () => ({ runs: [], stages: [] }),
        },
      },
      visualization: {
        acks: async () => ({ entries: [], revision: 1 }),
        state: async () => ({
          overrides: [],
          planar: null,
          revision: 2,
          targets: {
            airbox: { scope: "airbox", scope_id: "airbox" },
            objects: [
              { scope: "object", scope_id: "film" },
              ...(options?.antennaObjectId
                ? [{ scope: "object" as const, scope_id: options.antennaObjectId }]
                : []),
            ],
            parts: [
              { scope: "part", scope_id: "part:film-top" },
              { scope: "part", scope_id: "part:film-bottom" },
            ],
            regions: [{ scope: "region", scope_id: "region:film:core" }],
          },
        }),
      },
    },
    bus,
    cameraRegistry: { observeRemoteState: vi.fn() },
    commands: {
      execute,
      get: () => undefined,
      getSessionScopeKey: () => "sess-parity:ep-1",
      getVersion: () => 0,
      isEnabled: () => true,
      register: () => () => undefined,
      subscribe: () => () => undefined,
    },
    diagnosticRecorder: { record: vi.fn() },
    diagnostics: new RequestDiagnosticsController(),
    layout,
    realtimeConnection: {
      getSnapshot: () => realtimeSnapshot,
      subscribe: () => () => undefined,
    },
    resources,
    selection: {
      clear: vi.fn(),
      get: () => ({
        kind: null,
        label: null,
        moduleSource: "explorer",
        nodeId: null,
        objectId: null,
        ref: null,
      }),
      set: vi.fn(),
      subscribe: () => () => undefined,
    },
    visualization: new ObjectVisualizationController(),
    visualizationDebug: new VisualizationDebugController(),
    visualizationSync: {
      applyOptimisticState: (v: unknown) => v,
      getSnapshot: () => syncSnapshot,
      observeRemoteState: vi.fn(),
      queuePatch,
      setSessionScopeKey: vi.fn(),
      subscribe: () => () => undefined,
    },
  } as unknown as KernelApi;
}

function makePartDebugSnapshot(partTargetId: string): VisualizationDebugSnapshot {
  const vectorPath = DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m");
  const resourceKey = `${vectorPath}?component=full&scope_kind=part&scope_id=${encodeURIComponent(partTargetId)}`;
  return {
    capturedAtMs: 5_000,
    carriers: [
      {
        cache: {
          byteLength: 48,
          entryState: "ready",
          etag: '"part-etag"',
          fieldCacheByteLength: 48,
          fieldCacheEntryCount: 1,
          fieldCacheMaxBytes: 1024,
          retainCount: 1,
        },
        carrierId: partTargetId,
        carrierRole: "magnetic",
        memory: [],
        payload: {
          component: null,
          dtype: "float32",
          formatVersion: 3,
          grid: [4, 1, 1],
          indexing: "explicit_node_indices",
          nComp: 3,
          nodeIndexCount: 4,
          pointCount: 4,
          quantityId: "m",
          scopeId: partTargetId,
          scopeKind: "part",
          valueCount: 12,
        },
        render: {
          adoption: {
            frameCommitId: "frame-part-1",
            surface: {
              adoptedAtMs: 50,
              adoptedFieldBufferId: "buf-part-1",
              adoptedResourceKey: resourceKey,
              adoptedScalarBufferKey: "scal-part-1",
              adoptionSequence: 1,
            },
            vector: {
              adoptedAtMs: null,
              adoptedFieldBufferId: null,
              adoptedResourceKey: null,
              adoptedVectorBuildKey: null,
              adoptedVectorItemCount: null,
              adoptionSequence: null,
            },
          },
          fieldBufferState: "ready",
          requestedFieldBufferId: "buf-part-1",
          requestedPasses: ["surface"],
          surface: {
            bufferKey: "scal-part-1",
            colorMode: "full",
            degradation: null,
            projectionMode: "magnitude",
            scalarByteLength: 16,
          },
          vectors: {
            buildKey: null,
            degradation: null,
            segmentByteLength: null,
            segmentCount: null,
          },
        },
        request: { plannerRequestId: "plan-part-1", resourceKey },
        revisions: {
          domainGenerationId: "gen-1",
          fieldRevision: "3",
          meshTopologyHash: "topo-1",
          topologyRevision: "2",
          visualizationRevision: "2",
        },
        samples: [
          {
            componentValues: [0, 0, 1],
            magnitude: 1,
            nodeIndex: 2,
            pointIndex: 0,
          },
        ],
        scanState: "complete",
        statistics: [],
      },
    ],
    disposition: "ready",
    issues: [],
    sharedMemory: [],
    target: {
      carrierIds: [partTargetId],
      id: partTargetId,
      kind: "object",
      label: "Film volume",
    },
    version: 1,
    viewport: {
      contextLost: false,
      drawingBuffer: [800, 600],
      frameCommitId: "frame-part-1",
      frameCommittedAtMs: 4_990,
      viewportId: "viewport-primary",
    },
  };
}

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

async function flushAsync(container?: { textContent: string | null }) {
  for (let i = 0; i < 80; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (
      container &&
      i >= 3 &&
      !container.textContent?.includes("Resolving visualization owner") &&
      !container.textContent?.includes("Resourceloading")
    ) {
      break;
    }
    if (!container && i >= 12) {
      break;
    }
  }
}

describe("Wave 6 Target Visualization & 3D Viewport Parity (#157 / #173)", () => {
  it("hosts full real Object, Antenna, Region, MeshPart, Airbox, and Mode visualization panels inside InspectorTemplate", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      dom.restore();
    };

    const kernel = createFullParityKernel({ antennaObjectId: "ant1" });
    const objectSel: Selection = {
      kind: "object.visualization",
      label: "Film",
      moduleSource: "explorer",
      nodeId: "model:object:film:visualization",
      objectId: "film",
      ref: {
        kind: "object.visualization",
        nodeId: "model:object:film:visualization",
        objectId: "film",
        type: "scene-object",
        visualizationTargetId: "object:film",
      },
    };

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ObjectVisualizationTemplatePanel selection={objectSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);

    // Canonical InspectorTemplate root + real ObjectVisualizationPanel controls
    const inspectorRoot = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-root",
    );
    expect(inspectorRoot?.getAttribute("data-domain")).toBe("visualization");
    expect(inspectorRoot?.getAttribute("data-inspector-owner")).toBe(
      "object.visualization",
    );
    expect(container.textContent).toContain("Surface Coloring");
    expect(container.textContent).toContain("Vectors");
    expect(container.textContent).toContain("Clipping");
    expect(container.textContent).toContain("Camera");
    expect(container.textContent).toContain("Diagnostics & overrides");

    // Antenna object delegates to AntennaVisualizationView (#173 §1)
    const antennaSel: Selection = {
      kind: "object.visualization",
      label: "Antenna 1",
      moduleSource: "explorer",
      nodeId: "model:object:ant1:visualization",
      objectId: "ant1",
      ref: {
        kind: "object.visualization",
        nodeId: "model:object:ant1:visualization",
        objectId: "ant1",
        type: "scene-object",
        visualizationTargetId: "object:ant1",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ObjectVisualizationTemplatePanel selection={antennaSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);
    expect(
      findElement(
        container,
        (el) => el.getAttribute("data-antenna-visualization-root") !== null,
      ),
    ).not.toBeNull();

    // Region visualization route
    const regionSel: Selection = {
      kind: "object.region.visualization",
      label: "Core region",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions:core:visualization",
      objectId: "film",
      ref: {
        kind: "object.region.visualization",
        nodeId: "model:object:film:regions:core:visualization",
        objectId: "film",
        regionId: "core",
        type: "scene-object",
        visualizationTargetId: "region:film:core",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ObjectRegionVisualizationTemplatePanel selection={regionSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);
    expect(
      findElement(
        container,
        (el) => el.getAttribute("data-slot") === "inspector-root",
      )?.getAttribute("data-inspector-owner"),
    ).toBe("object.region.visualization");
    expect(container.textContent).toContain("Surface Coloring");

    // Mesh-part visualization route
    const partSel: Selection = {
      kind: "mesh-part",
      label: "Top surface",
      moduleSource: "explorer",
      nodeId: "resources:mesh:part:part:film-top",
      objectId: "film",
      ref: {
        carrierPartId: "part:film-top",
        kind: "mesh-part",
        nodeId: "resources:mesh:part:part:film-top",
        objectId: "film",
        type: "mesh-part",
        visualizationTargetId: "part:film-top",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MeshPartVisualizationTemplatePanel selection={partSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);
    expect(
      findElement(
        container,
        (el) => el.getAttribute("data-slot") === "inspector-root",
      )?.getAttribute("data-inspector-owner"),
    ).toBe("mesh-part.visualization");

    // Airbox visualization route
    const airboxSel: Selection = {
      kind: "airbox.visualization",
      label: "Airbox",
      moduleSource: "explorer",
      nodeId: "model:airbox:visualization",
      objectId: null,
      ref: {
        kind: "airbox.visualization",
        nodeId: "model:airbox:visualization",
        type: "airbox",
        visualizationTargetId: "airbox",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <AirboxVisualizationTemplatePanel selection={airboxSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);
    expect(container.textContent).toContain("Universe sampling domain");

    // Mode visualization route (real complex representation + phase transport)
    const modeSel: Selection = {
      kind: "object.mode_visualization",
      label: "Eigenmode 2",
      moduleSource: "results",
      nodeId: "model:object:film:visualization:mode-visualization",
      objectId: "film",
      ref: {
        fieldId: "eigen-2",
        kind: "object.mode_visualization",
        modeIndex: 2,
        nodeId: "model:object:film:visualization:mode-visualization",
        objectId: "film",
        sampleIndex: 0,
        source: "eigen-mode",
        type: "mode-visualization",
        view: "phase_rotated_real",
        visualizationTargetId: "mode:film:eigen-mode:eigen-2",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ModeVisualizationTemplatePanel selection={modeSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);
    expect(container.textContent).toContain("Complex representation");
    expect(container.textContent).toContain("Phase & animation");
    expect(
      findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Mode visualization phase slider",
      ),
    ).not.toBeNull();
    expect(
      findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Play mode phase animation",
      ),
    ).not.toBeNull();

    // Eigen modes collection visualization redirect (#173 §1)
    const eigenCollectionSel: Selection = {
      kind: "results.eigen.modes.visualization",
      label: "Eigen Modes Visualization",
      moduleSource: "results",
      nodeId: "results:eigen:modes:visualization",
      objectId: "film",
      ref: {
        kind: "results.eigen.modes.visualization",
        nodeId: "results:eigen:modes:visualization",
        type: "frequency-domain",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ModeVisualizationTemplatePanel selection={eigenCollectionSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);
    expect(container.textContent).toContain("Eigen Modes Visualization");
    expect(container.textContent).toContain("Surface Coloring");
  }, 20_000);

  it("supports all 4 VisualizationDebugTemplatePanel routes including mesh.part.visualization.debug sample table & evidence actions", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      dom.restore();
    };

    const kernel = createFullParityKernel();
    const publisher = kernel.visualizationDebug.registerPublisher("viewport-primary");
    kernel.visualizationDebug.commit(
      publisher,
      "part:film-top",
      makePartDebugSnapshot("part:film-top"),
    );

    const meshDebugSel: Selection = {
      kind: "mesh.part.visualization.debug",
      label: "Top surface debug",
      moduleSource: "explorer",
      nodeId: "resources:mesh:part:film-top:debug",
      objectId: "film",
      ref: {
        carrierPartId: "part:film-top",
        kind: "mesh.part.visualization.debug",
        nodeId: "resources:mesh:part:film-top:debug",
        objectId: "film",
        type: "mesh-part",
        visualizationTargetId: "part:film-top",
      },
    };

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MeshPartVisualizationDebugTemplatePanel selection={meshDebugSel} />
        </KernelContext.Provider>,
      );
    });
    await flushAsync(container);

    expect(container.textContent).toContain("Mesh Part Visualization Debug");
    expect(container.textContent).toContain("Sample values");
    expect(container.textContent).toContain("Evidence export");
    expect(
      findElement(container, (el) => el.getAttribute("aria-label") === "Copy log"),
    ).not.toBeNull();
    expect(
      findElement(container, (el) => el.getAttribute("aria-label") === "Export JSON"),
    ).not.toBeNull();

    // Verify the remaining 3 debug owners render inside InspectorTemplate
    for (const [Panel, sel, owner] of [
      [
        ObjectVisualizationDebugTemplatePanel,
        {
          kind: "object.visualization.debug",
          label: "Object debug",
          moduleSource: "explorer",
          nodeId: "model:object:film:visualization:debug",
          objectId: "film",
          ref: {
            kind: "object.visualization.debug",
            nodeId: "model:object:film:visualization:debug",
            objectId: "film",
            type: "scene-object",
            visualizationTargetId: "object:film",
          },
        } as Selection,
        "object.visualization.debug",
      ],
      [
        ObjectRegionVisualizationDebugTemplatePanel,
        {
          kind: "object.region.visualization.debug",
          label: "Region debug",
          moduleSource: "explorer",
          nodeId: "model:object:film:regions:core:visualization:debug",
          objectId: "film",
          ref: {
            kind: "object.region.visualization.debug",
            nodeId: "model:object:film:regions:core:visualization:debug",
            objectId: "film",
            regionId: "core",
            type: "scene-object",
            visualizationTargetId: "region:film:core",
          },
        } as Selection,
        "object.region.visualization.debug",
      ],
      [
        AirboxVisualizationDebugTemplatePanel,
        {
          kind: "airbox.visualization.debug",
          label: "Airbox debug",
          moduleSource: "explorer",
          nodeId: "model:airbox:visualization:debug",
          objectId: null,
          ref: {
            kind: "airbox.visualization.debug",
            nodeId: "model:airbox:visualization:debug",
            type: "airbox",
            visualizationTargetId: "airbox",
          },
        } as Selection,
        "airbox.visualization.debug",
      ],
    ] as const) {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Panel selection={sel} />
          </KernelContext.Provider>,
        );
      });
      await flushAsync(container);
      expect(
        findElement(
          container,
          (el) => el.getAttribute("data-slot") === "inspector-root",
        )?.getAttribute("data-inspector-owner"),
      ).toBe(owner);
      if (owner === "airbox.visualization.debug") {
        expect(
          findElements(
            container,
            (el) => el.getAttribute("data-slot") === "inspector-identity",
          ),
        ).toHaveLength(1);
        expect(
          findElements(container, (el) =>
            (el.getAttribute("class") ?? "").includes("fm-airbox-inspector-identity"),
          ),
        ).toHaveLength(0);
      }
    }
  });

  it("renders honest EmptyState placeholders in Viewport3DInspectorOutlet and 8-slot .fm-inspector classes on Viewport3DSettingsContent", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      dom.restore();
    };

    await act(async () => {
      root.render(
        <div>
          <Viewport3DInspectorOutlet />
          <Viewport3DExportPanelOutlet />
        </div>,
      );
    });

    // Zero fake sliders/inputs when 3D viewport is not mounted
    expect(findElements(container, (el) => el.tagName === "INPUT")).toEqual([]);
    expect(container.textContent).toContain(
      "Open the 3D viewport to adjust its camera, appearance, and render quality.",
    );
    expect(container.textContent).toContain(
      "Open the 3D viewport to export a PNG image or 3D model.",
    );

    const host = getViewport3DInspectorSnapshot().host;
    expect(host).not.toBeNull();

    // Portal real Viewport3DSettingsContent into registered host
    await act(async () => {
      root.render(
        <div>
          <Viewport3DInspectorOutlet />
          {host
            ? createPortal(
                <Viewport3DSettingsContent
                  activeSection="view"
                  cameraContent={<p>Live camera controls</p>}
                  onCommand={() => undefined}
                  onSectionChange={() => undefined}
                />,
                host,
              )
            : null}
        </div>,
      );
    });

    const settingsMarkup = renderToStaticMarkup(
      <Viewport3DSettingsContent
        activeSection="view"
        cameraContent={<p>Live camera controls</p>}
        onCommand={() => undefined}
        onSectionChange={() => undefined}
      />,
    );
    expect(settingsMarkup).toContain('aria-label="3D View Settings"');
    expect(settingsMarkup).toContain('data-slot="inspector-root"');
    expect(settingsMarkup).toContain('data-domain="visualization"');
    expect(settingsMarkup).toContain("fm-inspector__header");
    expect(settingsMarkup).toContain("fm-inspector__identity");
    expect(settingsMarkup).toContain("fm-inspector__tabs");
    expect(settingsMarkup).toContain("fm-inspector__body");
    expect(settingsMarkup).toContain("fm-inspector__footer");
    expect(settingsMarkup).toContain("Live camera controls");
  });
});
