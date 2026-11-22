import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import {
  buildPhysicsFirstResultsTree,
  physicsFirstResultsSnapshotFromResources,
} from "@/modules/explorer/builders/resultsExplorerNodes";

const testMocks = vi.hoisted(() => ({
  hysteresisPointsStageIds: [] as Array<string | undefined>,
  postprocessingDefinitions: [] as Array<Record<string, unknown>>,
  responseSweepData: null as Record<string, unknown> | null,
  sceneData: null as Record<string, unknown> | null,
}));

vi.mock("@/kernel/resources/analysisResultResources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/analysisResultResources")>();
  return {
    ...actual,
    useAnalysisResultDatasetManifestResource: () => ({
      data: null,
      error: null,
      revision: null,
      status: "idle" as const,
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return {
    ...actual,
    useSceneResource: (opts?: { enabled?: boolean }) => ({
      data: opts?.enabled === false ? null : testMocks.sceneData,
      error: null,
      refetch: vi.fn(),
      revision: testMocks.sceneData ? 1 : null,
      sessionScopeKey: "sess:scene",
      status:
        testMocks.sceneData && opts?.enabled !== false
          ? ("ready" as const)
          : ("idle" as const),
    }),
  };
});

vi.mock("@/kernel/resources/postprocessingDefinitionResources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/postprocessingDefinitionResources")>();
  return {
    ...actual,
    usePostprocessingDefinitionsResource: () => ({
      data: {
        count: testMocks.postprocessingDefinitions.length,
        definitions: testMocks.postprocessingDefinitions,
        scene_revision: 14,
      },
      status: "ready" as const,
    }),
  };
});

vi.mock("@/kernel/resources/observationFrameResources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/observationFrameResources")>();
  return {
    ...actual,
    useObservationFrameListResource: () => ({
      data: { frames: [] },
      status: "ready" as const,
    }),
    useObservationFrameResource: () => ({
      data: {
        accepted_state_ref: {
          generation: { accepted_revision: 5, runtime_epoch: 2 },
          id: {
            accepted_step: 42,
            clock_digest: "sha256:clock42",
            domain_digest: "sha256:domain42",
            plan_digest: "sha256:plan42",
            run_id: "run-9",
            stage_id: "run_1",
            state_digest: "sha256:frame42",
          },
        },
        adapter_id: "fdm-cuda",
        attempt_id: "attempt-1",
        frame_id: "frame-42",
        grid_cells: [64, 64, 4],
        magnetization_href: "/data/observation-frames/frame-42/magnetization",
        ownership_epoch: 1,
        quantity_ids: ["m", "B_eff"],
        run_id: "run-9",
        schema_version: "observation-frame.v1",
        stage_id: "run_1",
        state_codec_id: "zarr_v3",
        state_codec_version: "1.0",
        status: "complete",
        task_id: "task-1",
      },
      status: "ready" as const,
    }),
  };
});

vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/studyRuntimeResources")>();
  return {
    ...actual,
    useFrequencyDomainManifestResource: () =>
      testMocks.responseSweepData
        ? {
            data: {
              result_manifest: {
                payload: {
                  drive: { identity: "rf_drive", kind: "magnetic_rf" },
                  observables: [
                    { identity: "chi_yy", kind: "response_amplitude", unit: "A/m" },
                  ],
                },
                status: "ready" as const,
              },
            },
            status: "ready" as const,
          }
        : { data: null, status: "idle" as const },
    useFrequencyDomainResponseCancelRequestedResource: () => ({
      data: null,
      status: "idle" as const,
    }),
    useFrequencyDomainResponseProgressResource: () => ({
      data: null,
      status: "idle" as const,
    }),
    useFrequencyDomainResponseSweepResource: () =>
      testMocks.responseSweepData
        ? {
            data: testMocks.responseSweepData,
            status: "ready" as const,
          }
        : { data: null, status: "idle" as const },
    useHysteresisPointsResource: (
      stageId: string | undefined,
      opts?: { enabled?: boolean },
    ) => {
      if (opts?.enabled !== false) {
        testMocks.hysteresisPointsStageIds.push(stageId);
      }
      return {
        data: {
          points: [
            {
              adaptive_inserted: false,
              branch_id: "descending",
              field_value_mT: 50,
              m_avg: [0.98, 0.19, 0],
              m_ip: 0.998,
              m_oop: 0,
              m_parallel: 0.98,
              point_id: 0,
              protocol_role: "major",
              settle_status: "converged",
              snapshot_id: "snap_0",
              snapshot_resource_ref: "data/snapshots/snap_0",
              snapshot_storage_reason: "pinned",
              snapshot_storage_status: "available",
              status: "completed",
              terminal_settle_reason: "torque_below_threshold",
              warning_count: 0,
            },
            {
              adaptive_inserted: false,
              branch_id: "descending",
              field_value_mT: -35.5,
              m_avg: [-0.25, 0.96, 0.01],
              m_ip: 0.992,
              m_oop: 0.01,
              m_parallel: -0.25,
              point_id: 7,
              protocol_role: "coercive",
              settle_status: "converged",
              snapshot_id: "snap_7",
              snapshot_resource_ref: "data/snapshots/snap_7",
              snapshot_storage_reason: "pinned",
              snapshot_storage_status: "available",
              status: "completed",
              terminal_settle_reason: "torque_below_threshold",
              warning_count: 1,
            },
          ],
          revision: "rev-7",
        },
        revision: "rev-7",
        status: "ready" as const,
      };
    },
    useHysteresisProgressResource: () => ({
      data: null,
      revision: null,
      status: "idle" as const,
    }),
    useHysteresisSettleTraceResource: () => ({
      data: [],
      status: "ready" as const,
    }),
  };
});

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-alert-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => <div role="alertdialog">{children}</div>,
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Action: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  Cancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{ value?: string; onValueChange?: (next: string) => void }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
    Trigger: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return (
        <button
          aria-selected={ctx.value === value}
          role="tab"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    Content: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return ctx.value === value ? <div role="tabpanel">{children}</div> : null;
    },
  };
});

vi.mock("@radix-ui/react-collapsible", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{ open?: boolean; onOpenChange?: (next: boolean) => void }>({});
  return {
    Root: ({
      children,
      open = true,
      onOpenChange,
      ...rest
    }: {
      children?: ReactNode;
      open?: boolean;
      onOpenChange?: (next: boolean) => void;
    }) => (
      <Ctx.Provider value={{ open, onOpenChange }}>
        <div data-open={String(open)} {...rest}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button type="button" onClick={() => ctx.onOpenChange?.(!ctx.open)} {...rest}>
          {children}
        </button>
      );
    },
    Content: ({ children }: { children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return ctx.open ? <div>{children}</div> : null;
    },
  };
});

vi.mock("@radix-ui/react-select", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{ value?: string; onValueChange?: (next: string) => void }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </Ctx.Provider>
    ),
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: ({ placeholder }: { placeholder?: string }) => {
      const ctx = React.useContext(Ctx);
      return <span>{ctx.value || placeholder || ""}</span>;
    },
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => (
      <button type="button" {...rest}>{children}</button>
    ),
    Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Item: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button role="option" aria-selected={false} type="button" onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
    ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Separator: () => <hr />,
    ScrollUpButton: () => null,
    ScrollDownButton: () => null,
  };
});

vi.mock("@radix-ui/react-switch", () => ({
  Root: ({
    checked,
    disabled,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
  }) => (
    <button
      aria-checked={Boolean(checked)}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
  Thumb: () => <span />,
}));

vi.mock("@radix-ui/react-slider", () => ({
  Root: ({
    value,
    onValueChange,
    ...rest
  }: {
    value?: number[];
    onValueChange?: (next: number[]) => void;
  }) => (
    <div
      data-slot="mock-slider"
      data-value={String(value?.[0] ?? 0)}
      onClick={() => onValueChange?.([90])}
      {...rest}
    />
  ),
  Track: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Range: () => <div />,
  Thumb: () => <div />,
}));

vi.mock("echarts", () => ({
  init: () => ({
    on: vi.fn(),
    off: vi.fn(),
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import {
  DispersionRelationResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DynamicsResultTemplateInspector,
  ResonanceDrivenFitsResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceKittelFitResultInspector,
  ResonanceModalFieldSweepResultInspector,
  ResonanceModalModeResultInspector,
  resolveSelectedDispersionPoint,
} from "./ResonanceAndDispersionSpecs";
import {
  computeDerivedMetricsFromPoints,
  HysteresisDatasetResultInspector,
  HysteresisPointResultInspector,
  HysteresisRootResultInspector,
  resolveHysteresisPointId,
  resolveHysteresisStageId,
} from "./HysteresisResultSpecs";
import {
  AnalysisViewsOverviewInspector,
  DerivedValuesOverviewInspector,
  ExportDefinitionInspector,
  FieldQuantityTemplateInspectorPanel,
  ObservationFrameTemplateInspectorPanel,
  PinnedVisualizationsTemplateInspectorPanel,
  TableDefinitionInspector,
} from "./PostprocessingAndPlaybackSpecs";

let restoreDom: (() => void) | null = null;

afterEach(() => {
  testMocks.responseSweepData = null;
  testMocks.sceneData = null;
  restoreDom?.();
  restoreDom = null;
});

function makeSelection(
  kind: string,
  extraRef: Record<string, unknown> = {},
): Selection {
  return {
    kind,
    label: kind,
    moduleSource: "explorer",
    nodeId: `node:${kind}`,
    objectId: null,
    ref: {
      kind,
      nodeId: `node:${kind}`,
      type: "frequency-domain",
      ...extraRef,
    } as Selection["ref"],
  };
}

describe("Task 24 — Physics-First Results, 2x Dispersion P0 fixes, 3D harmonic phase animation, and postprocessing", () => {
  it("fixes Dispersion P0 #1: selecting (k_i, f_{i,n}) on results.dispersion.modal.relation keeps canonical kind and displays kx, f, vg", async () => {
    const samplePoints = [
      {
        branchId: "branch_0",
        displayModeIndex: 1,
        frequencyHz: 8.4e9,
        linewidthHz: 4.2e7,
        modeFieldId: "mode_0",
        modeFieldResourceKey: "data/fields/mode_0",
        modeId: "m0",
        overlap: 0.99,
        pathS: 0,
        rawModeIndex: 0,
        relativeError: null,
        residualNorm: 1e-8,
        sampleId: "s0",
        sampleIndex: 0,
        sampleLabel: "Gamma",
        validationGeometry: null,
        wavevectorKf: [0, 0, 0] as const,
      },
      {
        branchId: "branch_0",
        displayModeIndex: 1,
        frequencyHz: 10.9e9,
        linewidthHz: 4.8e7,
        modeFieldId: "mode_1",
        modeFieldResourceKey: "data/fields/mode_1",
        modeId: "m1",
        overlap: 0.98,
        pathS: 5e6,
        rawModeIndex: 0,
        relativeError: null,
        residualNorm: 1.2e-8,
        sampleId: "s1",
        sampleIndex: 1,
        sampleLabel: "X",
        validationGeometry: null,
        wavevectorKf: [5e6, 0, 0] as const,
      },
    ];

    const matched = resolveSelectedDispersionPoint(
      makeSelection("results.dispersion.modal.relation", {
        modeIndex: 0,
        sampleIndex: 1,
      }),
      samplePoints,
    );
    expect(matched?.sampleIndex).toBe(1);
    expect(matched?.frequencyHz).toBe(10.9e9);

    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [sel, setSel] = useState<Selection>(() =>
        makeSelection("results.dispersion.modal.relation"),
      );
      return (
        <DispersionRelationResultInspector
          selection={sel}
          testDispersionPoints={samplePoints}
          onSelectDispersionSelection={(next) =>
            setSel({ ...next, moduleSource: "inspector" })
          }
        />
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });

    const pointBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.getAttribute("aria-label") ?? "").includes("Select dispersion point sample 1"),
    );
    expect(pointBtn).not.toBeNull();
    await act(async () => {
      pointBtn!.click();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("10.9");
    expect(text).toContain("Group velocity");
    expect(text.toLowerCase()).not.toContain("unknown");

    await act(async () => {
      root.unmount();
    });
  });

  it("fixes Dispersion P0 #2: wires responseMap in resultsExplorerNodes unlocking response_map and field_at_k", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 9, run_id: "run-disp" },
      dispersion: {
        path_metadata: {
          sampling: {
            kind: "path",
            points: [
              { k_vector: [0, 0, 0], label: "Gamma" },
              { k_vector: [1e7, 0, 0], label: "X" },
            ],
            samples_per_segment: [8],
          },
        },
        status: "ready",
      },
      manifest: {
        result_manifest: {
          payload: {
            drive: { identity: "rf_drive_1", kind: "magnetic_rf" },
            equilibrium_identity: "eq-1",
            observables: [{ identity: "chi_yy", kind: "susceptibility", unit: "1" }],
            requested_execution: { boundary_context: "floquet_periodic" },
            revision: "r9",
            stage_id: "resp_k",
            stage_label: "Driven k-map",
            study_product: "driven_response",
          },
          status: "ready",
        },
      },
      responseMap: {
        payload: { points: [{ frequency_hz: 9e9, k_rad_per_m: 1e6 }] },
        status: "ready",
      },
      responseSweep: {
        payload: {
          points: [
            {
              amplitude: 0.42,
              field_id: "rf_field_0",
              frequency_hz: 9e9,
              frequency_index: 0,
              observable_id: "chi_yy",
            },
          ],
        },
        status: "ready",
      },
    });

    expect(adapted.snapshot.entries[0]?.products.responseMap).toBe(true);
    const tree = buildPhysicsFirstResultsTree(adapted.snapshot);
    const allKinds: string[] = [];
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        allKinds.push(n.kind);
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    expect(allKinds).toContain("results.dispersion.driven.response_map");
    expect(allKinds).toContain("results.dispersion.driven.field_at_k");
  });

  it("animates 3D mode phase locally with 0 HTTP fetches and renders U2/U9-U11/postprocessing without 'unknown'", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const phaseSpy = vi.fn();
    await act(async () => {
      root.render(
        <ResonanceModalModeResultInspector
          selection={makeSelection("results.resonance.modal.mode")}
          onPhaseChangeDeg={phaseSpy}
        />,
      );
    });

    const slider = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "mock-slider",
    );
    expect(slider).not.toBeNull();
    await act(async () => {
      slider!.click();
    });
    expect(phaseSpy).toHaveBeenCalledWith(90);
    expect(fetchSpy).not.toHaveBeenCalled();

    for (const [Panel, kind] of [
      [ResonanceModalFieldSweepResultInspector, "results.resonance.modal.field_sweep"],
      [ResonanceDrivenFitsResultInspector, "results.resonance.driven.fits"],
      [ResonanceKittelFitResultInspector, "results.resonance.kittel_fit"],
      [AnalysisViewsOverviewInspector, "results.analysis_views.root"],
      [DerivedValuesOverviewInspector, "results.derived_values.root"],
      [FieldQuantityTemplateInspectorPanel, "results.field_quantity"],
      [PinnedVisualizationsTemplateInspectorPanel, "results.pinned_visualizations.root"],
    ] as const) {
      await act(async () => {
        root.render(<Panel selection={makeSelection(kind)} />);
      });
      const content = (container.textContent ?? "").toLowerCase();
      expect(content).not.toContain("unknown");
      expect(findElements(container, (el) => el.tagName === "SELECT")).toEqual([]);
    }

    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  });

  it("preserves full Wave 6 Results parity for Hysteresis commands/stageId, Pinned Visualizations fail-closed & Open, Observation Frame provenance, and legacy FFT/DSF redirects", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const executeSpy = vi.fn().mockResolvedValue({ status: "completed" });
    const selectionSetSpy = vi.fn();
    const mockKernel = {
      commands: {
        execute: executeSpy,
        getSessionScopeKey: () => "sess:1",
        refresh: vi.fn(),
      },
      layout: {
        get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
        setActiveViewportMainModule: vi.fn(),
      },
      resources: {
        getSnapshot: () => ({ data: { session_epoch: "ep-1", session_id: "sess-1" }, status: "ready" }),
        subscribe: () => () => undefined,
      },
      selection: {
        clear: vi.fn(),
        get: () => ({
          kind: "results.hysteresis.point",
          label: "Point 7",
          moduleSource: "explorer",
          nodeId: "results:hysteresis:custom_hyst_stage:point:7",
          objectId: null,
          ref: {
            nodeId: "results:hysteresis:custom_hyst_stage:point:7",
            pointId: 7,
            snapshotId: "snap_7",
            stageId: "custom_hyst_stage",
            type: "hysteresis-snapshot",
          },
        }),
        set: selectionSetSpy,
        subscribe: () => () => undefined,
      },
    } as unknown as KernelApi;

    // 1. HysteresisRootResultInspector uses analysisStageId and never hardcodes "hysteresis_1"
    testMocks.hysteresisPointsStageIds = [];
    const rootSel: Selection = {
      kind: "results.hysteresis.root",
      label: "Hysteresis",
      moduleSource: "explorer",
      nodeId: "results:run-1:hysteresis",
      objectId: null,
      ref: {
        analysisRunId: "run-1",
        analysisStageId: "stage_major_loop",
        kind: "results.hysteresis.root",
        nodeId: "results:run-1:hysteresis",
        type: "frequency-domain",
      },
    };
    expect(resolveHysteresisStageId(rootSel)).toBe("stage_major_loop");

    await act(async () => {
      root.render(
        <KernelContext.Provider value={mockKernel}>
          <HysteresisRootResultInspector selection={rootSel} />
        </KernelContext.Provider>,
      );
    });
    expect(testMocks.hysteresisPointsStageIds).toContain("stage_major_loop");
    expect(testMocks.hysteresisPointsStageIds).not.toContain("hysteresis_1");

    // 2. HysteresisPointResultInspector dispatches full Load in 3D payload + Use as Initial + Return to Live + M_avg
    const pointSel: Selection = {
      kind: "results.hysteresis.point",
      label: "Point #7",
      moduleSource: "explorer",
      nodeId: "results:hysteresis:custom_hyst_stage:point:7",
      objectId: null,
      ref: {
        nodeId: "results:hysteresis:custom_hyst_stage:point:7",
        pointId: 7,
        stageId: "custom_hyst_stage",
        stageIndex: 0,
        type: "study-stage",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={mockKernel}>
          <HysteresisPointResultInspector selection={pointSel} />
        </KernelContext.Provider>,
      );
    });
    const ptText = container.textContent ?? "";
    expect(ptText).toContain("-0.250000, 0.960000, 0.010000");
    expect(ptText).toContain("torque_below_threshold");

    const load3dBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Load Snapshot in 3D",
    );
    expect(load3dBtn).not.toBeNull();
    await act(async () => {
      load3dBtn!.click();
    });
    expect(executeSpy).toHaveBeenCalledWith(
      "hysteresis.load-point-in-3d",
      expect.anything(),
      expect.objectContaining({
        fieldVal: -35.5,
        mVal: -0.25,
        pointId: 7,
        snapshotId: "snap_7",
        snapshotStorageStatus: "available",
        stageId: "custom_hyst_stage",
      }),
    );

    const initBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Use as Initial State",
    );
    expect(initBtn).not.toBeNull();
    await act(async () => {
      initBtn!.click();
    });
    expect(executeSpy).toHaveBeenCalledWith(
      "hysteresis.use-point-as-initial-state",
      expect.anything(),
      expect.objectContaining({ snapshotId: "snap_7", stageId: "custom_hyst_stage" }),
    );

    // 3. PinnedVisualizationsTemplateInspectorPanel filters by run/module, fails closed on ownerless leaf, and wires Open
    testMocks.postprocessingDefinitions = [
      {
        data_ref: {
          dataset_id: "ds-disp",
          dataset_revision: "rev-1",
          field_id: "field-k4-m2",
          item_id: "mode-0002",
          run_id: "run-1",
          sample_id: "sample-0004",
          stage_id: "eig_k",
        },
        definition_id: "pin-1",
        definition_schema: "analysis.dispersion.mode_visualization.v1",
        label: "Pinned Acoustic Mode",
        module_id: "analysis.dispersion",
        module_version: "0.1.0",
        node_kind: "analysis.dispersion.mode_visualization",
        revision: 1,
        settings: {},
      },
      {
        data_ref: {
          dataset_id: "ds-other",
          dataset_revision: "rev-1",
          field_id: "field-other",
          run_id: "run-2",
        },
        definition_id: "pin-other-run",
        definition_schema: "analysis.dispersion.mode_visualization.v1",
        label: "Other Run Pin",
        module_id: "analysis.dispersion",
        module_version: "0.1.0",
        node_kind: "analysis.dispersion.mode_visualization",
        revision: 1,
        settings: {},
      },
    ];

    const groupSel: Selection = {
      kind: "results.pinned_visualizations.root",
      label: "Pinned visualizations",
      moduleSource: "explorer",
      nodeId: "results:run-1:dispersion:pinned",
      objectId: null,
      ref: {
        kind: "results.pinned_visualizations.root",
        moduleId: "analysis.dispersion",
        nodeId: "results:run-1:dispersion:pinned",
        runId: "run-1",
        type: "analysis-pinned-group",
      },
    };
    await act(async () => {
      root.render(
        <KernelContext.Provider value={mockKernel}>
          <PinnedVisualizationsTemplateInspectorPanel selection={groupSel} />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Pinned Acoustic Mode");
    expect(container.textContent ?? "").not.toContain("Other Run Pin");

    const openPinBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Open Pinned Acoustic Mode",
    );
    expect(openPinBtn).not.toBeNull();
    await act(async () => {
      openPinBtn!.click();
    });
    expect(selectionSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "results.dispersion.modal.mode_at_k",
        ref: expect.objectContaining({
          analysisRunId: "run-1",
          datasetId: "ds-disp",
          fieldId: "field-k4-m2",
          modeIndex: 2,
          sampleIndex: 4,
        }),
      }),
      "inspector",
    );

    // Unpublished pinned leaf fails closed
    await act(async () => {
      root.render(
        <KernelContext.Provider value={mockKernel}>
          <PinnedVisualizationsTemplateInspectorPanel
            selection={{
              kind: "results.pinned_visualizations.root",
              label: "Missing Pin",
              moduleSource: "explorer",
              nodeId: "results:run-1:dispersion:pinned:missing-pin",
              objectId: null,
              ref: null,
            }}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain(
      "The pinned field is not published by this run",
    );
    expect(container.textContent ?? "").not.toContain("Pinned Acoustic Mode");

    // 4. ObservationFrameTemplateInspectorPanel renders provenance & codec without fake focus-selection
    executeSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={mockKernel}>
          <ObservationFrameTemplateInspectorPanel
            selection={{
              kind: "results.observation_frame",
              label: "frame-42",
              moduleSource: "explorer",
              nodeId: "results:observation-frame:frame-42",
              objectId: null,
              ref: {
                acceptedRevision: 5,
                acceptedStep: 42,
                adapterId: "fdm-cuda",
                frameId: "frame-42",
                nodeId: "results:observation-frame:frame-42",
                runId: "run-9",
                runtimeEpoch: 2,
                stageId: "run_1",
                stateDigest: "sha256:frame42",
                type: "observation-frame",
              },
            }}
          />
        </KernelContext.Provider>,
      );
    });
    const obsText = container.textContent ?? "";
    expect(obsText).toContain("sha256:frame42");
    expect(obsText).toContain("zarr_v3 1.0");
    expect(obsText).toContain("fdm-cuda");

    // 5. Redirected legacy time-domain spectral_feature & dsf_point preserve full provenance
    await act(async () => {
      root.render(
        <DynamicsResultTemplateInspector
          selection={{
            kind: "results.dynamics.root",
            label: "legacy:gamma:peak:7",
            moduleSource: "explorer",
            nodeId: "analysis:legacy:time-domain:gamma",
            objectId: null,
            ref: {
              frequencyHz: 12.5e9,
              frequencyIndex: 7,
              kind: "results.time_domain.spectral_feature",
              nodeId: "analysis:legacy:time-domain:gamma",
              pointId: "legacy:gamma:peak:7",
              sampleId: "gamma-sample-0",
              type: "frequency-domain",
            },
          }}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("legacy:gamma:peak:7");
    expect(container.textContent ?? "").toContain("1.250000e+10 Hz");

    await act(async () => {
      root.render(
        <DispersionResponseFieldAtKResultInspector
          selection={{
            kind: "results.dispersion.driven.field_at_k",
            label: "legacy:dsf:point:3",
            moduleSource: "explorer",
            nodeId: "analysis:legacy:time-domain:dsf",
            objectId: null,
            ref: {
              frequencyHz: 9.2e9,
              frequencyIndex: 3,
              kContextKind: "path",
              kPathCoordinateRadPerM: 2.5e7,
              kind: "results.time_domain.dsf_point",
              nodeId: "analysis:legacy:time-domain:dsf",
              pointId: "legacy:dsf:point:3",
              sampleId: "dsf-sample-3",
              type: "frequency-domain",
            },
          }}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("legacy:dsf:point:3");
    expect(container.textContent ?? "").toContain("2.500000e+7 rad/m");
    expect(container.textContent ?? "").toContain("Not published; keep this selection legacy/partial");

    await act(async () => {
      root.unmount();
    });
  });

  it("verifies status facets, postprocessing readiness states, zero-crossing hysteresis metrics, scene stage fallback, and continuation command", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    // 1. Driven spectrum surfaces status facets (stale/running/partial) and contractGap truthfully
    await act(async () => {
      root.render(
        <ResonanceDrivenSpectrumResultInspector
          selection={makeSelection("results.resonance.driven.spectrum", {
            availability: "partial",
            contractGap: "Drive observable evidence is incomplete.",
            executionState: "running",
            resourceRef: "artifact-revision:response-r3",
            resourceState: "stale",
            studyProduct: "driven_response",
          })}
        />,
      );
    });
    const spectrumHtml = container.innerHTML;
    expect(spectrumHtml).toContain(">stale<");
    expect(spectrumHtml).toContain(">running<");
    expect(spectrumHtml).toContain(">partial<");
    expect(spectrumHtml).toContain("Drive observable evidence is incomplete.");

    // 2. Postprocessing definitions render Table/Export semantics and never publish stale/error/unavailable owners
    await act(async () => {
      root.render(
        <TableDefinitionInspector
          selection={{
            kind: "results.tables.definition",
            label: "energy",
            moduleSource: "explorer",
            nodeId: "results:run:run-7:results.tables.definition",
            objectId: null,
            ref: {
              catalogRevision: 12,
              contractGap: null,
              definitionKind: "table",
              freshness: "fresh",
              kind: "results.tables.definition",
              nodeId: "results:run:run-7:results.tables.definition",
              ownerId: "energy",
              ownerKind: "table",
              ownerReadiness: "available-ready",
              ownerResourceRevision: 8,
              ownerSchemaRevision: 3,
              resourceRef: "table:energy",
              scope: "definition",
              type: "postprocessing",
            },
          }}
        />,
      );
    });
    expect(container.innerHTML).toContain("Table ID");
    expect(container.innerHTML).toContain("Schema revision");

    for (const ownerReadiness of ["loading", "stale", "error", "unavailable"] as const) {
      await act(async () => {
        root.render(
          <ExportDefinitionInspector
            selection={{
              kind: "results.exports.definition",
              label: "energy.csv",
              moduleSource: "explorer",
              nodeId: "results:run:run-7:results.exports.definition",
              objectId: null,
              ref: {
                catalogRevision: "artifacts:17",
                contractGap: "Artifact catalog is not current.",
                definitionKind: "export",
                freshness: ownerReadiness === "stale" ? "stale" : "unknown",
                kind: "results.exports.definition",
                nodeId: "results:run:run-7:results.exports.definition",
                ownerId: "run-7/energy.csv",
                ownerKind: "artifact",
                ownerReadiness,
                ownerResourceRevision: "artifacts:17",
                ownerSchemaRevision: null,
                resourceRef: "artifact:run-7/energy.csv",
                scope: "definition",
                type: "postprocessing",
              },
            }}
          />,
        );
      });
      expect(container.innerHTML).toContain(`>${ownerReadiness}<`);
      expect(container.innerHTML).not.toContain(">published<");
    }

    // 3. Zero-crossing interpolation for remanence (M_r^+, M_r^-), coercivity, H_eb, loop area & susceptibility
    const { metrics } = computeDerivedMetricsFromPoints([
      {
        adaptive_inserted: false,
        branch_id: "descending",
        field_value_mT: 20,
        m_ip: 0.9,
        m_oop: 0,
        m_parallel: 0.9,
        point_id: 0,
        status: "completed",
      },
      {
        adaptive_inserted: false,
        branch_id: "descending",
        field_value_mT: -20,
        m_ip: 0.5,
        m_oop: 0,
        m_parallel: -0.3,
        point_id: 1,
        status: "completed",
      },
      {
        adaptive_inserted: false,
        branch_id: "ascending",
        field_value_mT: 20,
        m_ip: 0.9,
        m_oop: 0,
        m_parallel: 0.9,
        point_id: 2,
        status: "completed",
      },
    ]);
    expect(metrics).not.toBeNull();
    expect(metrics?.M_r_plus).toBeCloseTo(0.3, 5);
    expect(metrics?.H_c).not.toBeNull();
    expect(metrics?.max_differential_susceptibility).toBeGreaterThan(0);

    // 4. Scene hysteresis stage fallback via useSceneResource (no kernel.resources.getSnapshot) & Continue to Next Stage command
    testMocks.hysteresisPointsStageIds = [];
    testMocks.sceneData = {
      study: {
        stages: [{ id: "scene_hyst_stage", kind: "hysteresis" }],
      },
    };
    const bareHystSelection: Selection = {
      kind: "results.hysteresis.root",
      label: "Hysteresis",
      moduleSource: "explorer",
      nodeId: "results:run-1:hysteresis",
      objectId: null,
      ref: null,
    };
    const executeSpy = vi.fn().mockResolvedValue({ status: "completed" });
    const setActiveViewportMainModuleSpy = vi.fn();
    const setFocusedSlotSpy = vi.fn();
    const selectionSetSpy = vi.fn();
    const sceneKernel = {
      commands: {
        execute: executeSpy,
        getSessionScopeKey: () => "sess:scene",
        refresh: vi.fn(),
      },
      layout: {
        get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
        setActiveViewportMainModule: setActiveViewportMainModuleSpy,
        setFocusedSlot: setFocusedSlotSpy,
      },
      resources: {
        invalidate: vi.fn(),
        subscribe: () => () => undefined,
      },
      selection: {
        clear: vi.fn(),
        get: () => bareHystSelection,
        set: selectionSetSpy,
        subscribe: () => () => undefined,
      },
    } as unknown as KernelApi;

    expect(resolveHysteresisStageId(bareHystSelection, testMocks.sceneData)).toBe(
      "scene_hyst_stage",
    );

    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <HysteresisRootResultInspector selection={bareHystSelection} />
        </KernelContext.Provider>,
      );
    });
    expect(testMocks.hysteresisPointsStageIds).toContain("scene_hyst_stage");
    const continueBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Continue to next stage",
    );
    expect(continueBtn).not.toBeNull();
    await act(async () => {
      continueBtn!.click();
    });
    expect(executeSpy).toHaveBeenCalledWith(
      "hysteresis.continue-to-next-stage",
      expect.anything(),
      { stageId: "scene_hyst_stage" },
    );

    // 5. Hysteresis point resolution via ref.hysteresisPointId: 0 and :point:<id> nodeId enables all 5 actions
    const hystPointZeroSelection: Selection = {
      kind: "results.hysteresis.point",
      label: "Point #0 (50.00 mT)",
      moduleSource: "inspector",
      nodeId: "results:hysteresis:hyst_1:point:0",
      objectId: null,
      ref: {
        hysteresisPointId: 0,
        kind: "study.stage.hysteresis",
        nodeId: "results:hysteresis:hyst_1:point:0",
        stageId: "hyst_1",
        stageIndex: 0,
        type: "study-stage",
      },
    };
    expect(resolveHysteresisPointId(hystPointZeroSelection, "hyst_1")).toBe(0);
    expect(
      resolveHysteresisPointId(
        { ...hystPointZeroSelection, ref: null },
        "hyst_1",
      ),
    ).toBe(0);

    executeSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <HysteresisPointResultInspector selection={hystPointZeroSelection} />
        </KernelContext.Provider>,
      );
    });
    for (const label of [
      "Load Snapshot in 3D",
      "Use as Initial State",
      "Compare point in chart",
      "Bookmark point",
      "Export point CSV",
    ]) {
      const btn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === label,
      ) as HTMLButtonElement | null;
      expect(btn, `expected enabled button ${label}`).not.toBeNull();
      expect(btn!.disabled, `expected ${label} to be enabled`).toBe(false);
    }
    const loadPt0Btn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Load Snapshot in 3D",
    );
    await act(async () => {
      loadPt0Btn!.click();
    });
    expect(executeSpy).toHaveBeenCalledWith(
      "hysteresis.load-point-in-3d",
      expect.anything(),
      expect.objectContaining({
        pointId: 0,
        snapshotId: "snap_0",
        stageId: "hyst_1",
      }),
    );

    // 6. Open in Analysis switches viewport-main to canonical "analysis-plots" and focuses "viewport-main"
    setActiveViewportMainModuleSpy.mockClear();
    setFocusedSlotSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <HysteresisDatasetResultInspector
            selection={{
              kind: "results.hysteresis.dataset",
              label: "Major Loop Dataset",
              moduleSource: "explorer",
              nodeId: "results:hysteresis:hyst_1:dataset",
              objectId: null,
              ref: null,
            }}
          />
        </KernelContext.Provider>,
      );
    });
    const hystOpenAnalysisBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Open in Analysis"),
    );
    expect(hystOpenAnalysisBtn).not.toBeNull();
    await act(async () => {
      hystOpenAnalysisBtn!.click();
    });
    expect(setActiveViewportMainModuleSpy).toHaveBeenCalledWith("analysis-plots");
    expect(setActiveViewportMainModuleSpy).not.toHaveBeenCalledWith("analysis");
    expect(setFocusedSlotSpy).toHaveBeenCalledWith("viewport-main");

    setActiveViewportMainModuleSpy.mockClear();
    setFocusedSlotSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <AnalysisViewsOverviewInspector
            selection={makeSelection("results.analysis_views.root")}
          />
        </KernelContext.Provider>,
      );
    });
    const postOpenAnalysisBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Open in Analysis"),
    );
    expect(postOpenAnalysisBtn).not.toBeNull();
    await act(async () => {
      postOpenAnalysisBtn!.click();
    });
    expect(setActiveViewportMainModuleSpy).toHaveBeenCalledWith("analysis-plots");
    expect(setActiveViewportMainModuleSpy).not.toHaveBeenCalledWith("analysis");
    expect(setFocusedSlotSpy).toHaveBeenCalledWith("viewport-main");

    // 7. Driven spectrum filtered observable chart wires onSelectPoint and onPlotPoint
    testMocks.responseSweepData = {
      payload: {
        points: [
          {
            amplitude: 0.85,
            field_id: "analysis:frequency-response:frequency-0002",
            frequency_hz: 11.2e9,
            frequency_index: 2,
            observable_id: "chi_yy",
            phase_rad: 0.4,
          },
        ],
      },
      status: "ready",
    };
    selectionSetSpy.mockClear();
    executeSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <ResonanceDrivenSpectrumResultInspector
            selection={makeSelection("results.resonance.driven.spectrum", {
              analysisRunId: "run-fmr",
              analysisStageId: "freq_resp_1",
            })}
          />
        </KernelContext.Provider>,
      );
    });
    const ampOptionBtn = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "option" &&
        (el.textContent ?? "").trim() === "Amplitude",
    );
    expect(ampOptionBtn).not.toBeNull();
    await act(async () => {
      ampOptionBtn!.click();
    });
    const selectRespBtns = findElements(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.getAttribute("aria-label") ?? "").startsWith("Select response point 2"),
    );
    expect(selectRespBtns.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      selectRespBtns[0]!.click();
    });
    expect(selectionSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "results.frequency_response.frequency_point",
        ref: expect.objectContaining({
          analysisRunId: "run-fmr",
          analysisStageId: "freq_resp_1",
          fieldId: "analysis:frequency-response:frequency-0002",
          frequencyIndex: 2,
          observableId: "chi_yy",
        }),
      }),
      "inspector",
    );
    const loadRespBtns = findElements(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.getAttribute("aria-label") ?? "").startsWith("Load response field 2"),
    );
    expect(loadRespBtns.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      loadRespBtns[0]!.click();
    });
    expect(executeSpy).toHaveBeenCalledWith(
      "analysis.frequency-response.plot-response-field-3d",
      expect.anything(),
      expect.objectContaining({
        fieldId: "analysis:frequency-response:frequency-0002",
        frequencyIndex: 2,
        source: "frequency-response",
      }),
    );

    // 8. Driven response pins under analysis.resonance & analysis.dispersion dispatch plot-response-field-3d and navigate to driven kinds
    testMocks.postprocessingDefinitions = [
      {
        data_ref: {
          dataset_id: "ds-fmr-driven",
          dataset_revision: "rev-2",
          field_id: "analysis:frequency-response:frequency-0003",
          run_id: "run-1",
        },
        definition_id: "pin-driven-res",
        definition_schema: "analysis.resonance.mode_visualization.v1",
        label: "Pinned Driven Resonance",
        module_id: "analysis.resonance",
        module_version: "0.1.0",
        node_kind: "analysis.resonance.mode_visualization",
        revision: 1,
        settings: {},
      },
      {
        data_ref: {
          dataset_id: "ds-disp-driven",
          dataset_revision: "rev-2",
          field_id: "analysis:frequency-response:frequency-0005",
          run_id: "run-1",
          sample_id: "sample-0002",
        },
        definition_id: "pin-driven-disp",
        definition_schema: "analysis.dispersion.mode_visualization.v1",
        label: "Pinned Driven Dispersion",
        module_id: "analysis.dispersion",
        module_version: "0.1.0",
        node_kind: "analysis.dispersion.mode_visualization",
        revision: 1,
        settings: {},
      },
    ];
    executeSpy.mockClear();
    selectionSetSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <PinnedVisualizationsTemplateInspectorPanel
            selection={{
              kind: "results.pinned_visualizations.root",
              label: "Pinned visualizations",
              moduleSource: "explorer",
              nodeId: "results:run-1:resonance:pinned",
              objectId: null,
              ref: {
                kind: "results.pinned_visualizations.root",
                moduleId: "analysis.resonance",
                nodeId: "results:run-1:resonance:pinned",
                runId: "run-1",
                type: "analysis-pinned-group",
              },
            }}
          />
        </KernelContext.Provider>,
      );
    });
    const activateResPinBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("aria-label") === "Activate Pinned Driven Resonance in 3D",
    );
    expect(activateResPinBtn).not.toBeNull();
    await act(async () => {
      activateResPinBtn!.click();
    });
    expect(executeSpy).toHaveBeenCalledWith(
      "analysis.frequency-response.plot-response-field-3d",
      expect.anything(),
      expect.objectContaining({
        fieldId: "analysis:frequency-response:frequency-0003",
        frequencyIndex: 3,
        source: "frequency-response",
      }),
    );
    const openResPinBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("aria-label") === "Open Pinned Driven Resonance",
    );
    expect(openResPinBtn).not.toBeNull();
    await act(async () => {
      openResPinBtn!.click();
    });
    expect(selectionSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "results.resonance.driven.field",
        ref: expect.objectContaining({
          fieldId: "analysis:frequency-response:frequency-0003",
          frequencyIndex: 3,
          source: "frequency-response",
        }),
      }),
      "inspector",
    );

    selectionSetSpy.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={sceneKernel}>
          <PinnedVisualizationsTemplateInspectorPanel
            selection={{
              kind: "results.pinned_visualizations.root",
              label: "Pinned visualizations",
              moduleSource: "explorer",
              nodeId: "results:run-1:dispersion:pinned",
              objectId: null,
              ref: {
                kind: "results.pinned_visualizations.root",
                moduleId: "analysis.dispersion",
                nodeId: "results:run-1:dispersion:pinned",
                runId: "run-1",
                type: "analysis-pinned-group",
              },
            }}
          />
        </KernelContext.Provider>,
      );
    });
    const openDispPinBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("aria-label") === "Open Pinned Driven Dispersion",
    );
    expect(openDispPinBtn).not.toBeNull();
    await act(async () => {
      openDispPinBtn!.click();
    });
    expect(selectionSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "results.dispersion.driven.field_at_k",
        ref: expect.objectContaining({
          fieldId: "analysis:frequency-response:frequency-0005",
          frequencyIndex: 5,
          sampleIndex: 2,
          source: "frequency-response",
        }),
      }),
      "inspector",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
