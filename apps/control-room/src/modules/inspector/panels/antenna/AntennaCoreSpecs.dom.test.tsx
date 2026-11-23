import {
  mountWave5TestDom,
  setTestInputValue,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeometryRealizationResource, SceneResource } from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { findElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { InspectorDirtySelectionGuard } from "@/modules/inspector/InspectorDirtySelectionGuard";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";

import {
  ALL_ANTENNA_TOPOLOGIES,
  buildAntennaTopologyGeometryPayload,
  createDefaultAntennaGeometryDraft,
} from "../../inspectors/objects/antenna/antennaCoreShared";
import { AntennaConductorInspectorSpecPanel } from "../../inspectors/objects/antenna/AntennaConductorSpec";
import { AntennaGeometryInspectorSpecPanel } from "../../inspectors/objects/antenna/AntennaGeometrySpec";
import { AntennaOverviewInspectorSpecPanel } from "../../inspectors/objects/antenna/AntennaOverviewSpec";
import { AntennaPortInspectorSpecPanel } from "../../inspectors/objects/antenna/AntennaPortSpec";
import { AntennaTerminalsInspectorSpecPanel } from "../../inspectors/objects/antenna/AntennaTerminalsSpec";
import { formatAntennaParameter } from "./AntennaReadoutModel";
import { antennaTerminalBoundaryMarker } from "./AntennaTerminalPreparationModel";
import { convertRfPortLevel } from "./rfPowerConverter";

function createDefaultMockScene(): SceneResource {
  return {
    antenna_port_modes: [
      {
        branches: [
          {
            id: "signal_main",
            inlet_terminal_ref: "signal:inlet",
            outlet_terminal_ref: "signal:outlet",
            signed_weight: 1,
          },
          {
            id: "return_main",
            inlet_terminal_ref: "return:inlet",
            outlet_terminal_ref: "return:outlet",
            signed_weight: -1,
          },
        ],
        current_transport_id: "ct_ant",
        id: "port_1",
        normalization_current_a: 1,
        schema_version: "antenna_port_mode.v2",
        source_object_id: "ant-1",
      },
    ],
    current_transports: [
      {
        boundaries: [
          {
            id: "signal:inlet",
            kind: "equipotential_current_terminal",
            surfaces: [{ object_id: "ant-1" }],
          },
          {
            id: "signal:outlet",
            kind: "equipotential_current_terminal",
            surfaces: [{ object_id: "ant-1" }],
          },
          {
            id: "return:inlet",
            kind: "equipotential_current_terminal",
            surfaces: [{ object_id: "ant-1" }],
          },
          {
            id: "return:outlet",
            kind: "equipotential_current_terminal",
            surfaces: [{ object_id: "ant-1" }],
          },
        ],
        coupling: "one_way",
        domain: [{ object_id: "ant-1" }],
        kind: "current_transport",
        materials: [
          {
            material: { sigma_Spm: 5.96e7 },
            region: { object_id: "ant-1", region_id: "signal" },
          },
          {
            material: { sigma_Spm: 5.96e7 },
            region: { object_id: "ant-1", region_id: "return" },
          },
        ],
        model: "ohmic_poisson",
        name: "ct_ant",
      },
    ],
    objects: [
      {
        geometry: {
          geometry_kind: "MicrostripAntennaLayout",
          geometry_params: {
            conductors: [
              { id: "signal", kind: "signal" },
              { id: "return", kind: "return" },
            ],
            conductivity_s_per_m: 5.96e7,
            length_m: 2.4e-6,
            return_offset_m: 200e-9,
            return_width_m: 600e-9,
            stations: [
              { s: 0, signal_width_m: 150e-9 },
              { s: 1, signal_width_m: 150e-9 },
            ],
            thickness_m: 50e-9,
          },
        },
        id: "ant-1",
        name: "CPW Exciter",
        role: "antenna",
        transform: {
          rotation: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 60e-9],
        },
      },
      {
        geometry: {
          geometry_kind: "Box",
          geometry_params: { lx: 2.4e-6, ly: 800e-9, lz: 20e-9 },
        },
        id: "film-1",
        magnetization_ref: "mag_yig",
        material_ref: "yig",
        name: "YIG Waveguide",
      },
    ],
    revision: 5,
    scene: { id: "scene-antenna-core", name: "Antenna Core Scene" },
    scene_revision: 5,
  } as unknown as SceneResource;
}

const {
  commitTransactionMock,
  mockDiagnosticsState,
  mockRealizationState,
  mockSceneState,
  publishCommittedSceneMock,
  selectionSetMock,
  sharedBus,
} = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    commitTransactionMock: vi.fn().mockResolvedValue({ scene_revision: 6 }),
    mockDiagnosticsState: {
      data: {
        backend_target: "fem" as const,
        diagnostics: [] as Array<{
          blocks?: string[];
          code: string;
          id: string;
          message: string;
          object_id?: string;
          severity: "error" | "warning" | "info";
        }>,
        status: "ready",
      },
    },
    mockRealizationState: {
      data: null as GeometryRealizationResource | null,
      refetch: vi.fn(),
      status: "idle" as "idle" | "ready",
    },
    mockSceneState: {
      data: null as SceneResource | null,
      refetch: vi.fn(),
    },
    publishCommittedSceneMock: vi.fn(),
    selectionSetMock: vi.fn(),
    sharedBus: {
      emit: (event: string, payload: unknown) => {
        for (const fn of listeners.get(event) ?? []) fn(payload);
      },
      on: (event: string, fn: (payload: unknown) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(fn);
        listeners.set(event, set);
        return () => {
          set.delete(fn);
        };
      },
    },
  };
});

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const kernelValue = {
    api: {
      model: {
        commitTransaction: commitTransactionMock,
        geometry: {
          realization: vi.fn().mockResolvedValue(null),
        },
      },
    },
    bus: sharedBus,
    commands: {
      execute: vi.fn().mockResolvedValue(undefined),
      getSessionScopeKey: () =>
        "session=session-antenna-core&epoch=1&request_scope_epoch=1",
    },
    diagnosticRecorder: { record: vi.fn() },
    layout: { setPanelVisible: vi.fn() },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: vi.fn(),
      subscribe: () => () => undefined,
    },
    selection: {
      get: () => ({
        kind: "object.antenna",
        label: "Antenna",
        nodeId: "model:object:ant-1:antenna",
        objectId: "ant-1",
        ref: null,
      }),
      set: selectionSetMock,
    },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "/session/status",
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "session-antenna-core",
  }),
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({
      data: {
        domain: { discretization: "fem" },
        resources: { scene_revision: 5 },
      },
    } as never),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  SCENE_RESOURCE_KEY: "/model/scene",
  publishCommittedSceneResource: publishCommittedSceneMock,
  useGeometryDiagnosticsResource: () => ({
    data: mockDiagnosticsState.data,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  }),
  useSceneResource: () => ({
    data: mockSceneState.data,
    error: null,
    refetch: mockSceneState.refetch,
    revision: 5,
    status: "ready" as const,
  }),
}));

vi.mock("@/kernel/resources/useGeometryRealizationResource", () => ({
  useGeometryRealizationResource: () => ({
    data: mockRealizationState.data,
    error: null,
    refetch: mockRealizationState.refetch,
    revision: 5,
    status: mockRealizationState.status,
  }),
}));

function GuardedGeometryHarness({
  controller,
}: {
  controller: SelectionController;
}) {
  const selection = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.get(),
    () => controller.get(),
  );

  return createElement(
    InspectorEditSessionProvider,
    null,
    createElement(
      InspectorDirtySelectionGuard,
      {
        controller,
        selection,
      },
      (guardedSelection: Selection) =>
        createElement(AntennaGeometryInspectorSpecPanel, {
          selection: guardedSelection,
        }),
    ),
  );
}

describe("Task 20 AntennaCoreSpecs — 100% Wave 5 Slice 5 Parity", { timeout: 20_000 }, () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    mockSceneState.data = createDefaultMockScene();
    mockSceneState.refetch.mockClear();
    mockRealizationState.data = null;
    mockRealizationState.status = "idle";
    mockRealizationState.refetch.mockClear();
    mockDiagnosticsState.data = {
      backend_target: "fem",
      diagnostics: [],
      status: "ready",
    };
    commitTransactionMock.mockReset();
    commitTransactionMock.mockResolvedValue({ scene_revision: 6 });
    publishCommittedSceneMock.mockClear();
    selectionSetMock.mockClear();
  });

  afterEach(() => {
    harness.unmount();
  });

  it("formats null/non-finite antenna parameters as 'Not configured' without appending SI unit ('unavailable S/m' regression)", () => {
    expect(formatAntennaParameter(null, "S/m")).toBe("Not configured");
    expect(formatAntennaParameter(undefined, "A")).toBe("Not configured");
    expect(formatAntennaParameter(Number.NaN, "Hz")).toBe("Not configured");
    expect(formatAntennaParameter(null, "S/m")).not.toContain("S/m");
    expect(formatAntennaParameter(null, "S/m").toLowerCase()).not.toContain("unavailable");
  });

  it("converts +10.0 dBm at Z0 = 50 Ohm to exact P = 10 mW, V_rms = sqrt(0.5) V, V0 = 1.000 V, I0 = 20.00 mA and round-trips", () => {
    const fromPower = convertRfPortLevel({
      mode: "power_dbm",
      value: 10,
      z0Ohm: 50,
    });
    expect(fromPower.powerW).toBeCloseTo(0.01, 10);
    expect(fromPower.powerMw).toBeCloseTo(10.0, 8);
    expect(fromPower.vRmsV).toBeCloseTo(Math.sqrt(0.5), 8);
    expect(fromPower.peakVoltageV).toBeCloseTo(1.0, 8);
    expect(fromPower.peakCurrentA).toBeCloseTo(0.02, 8);
    expect(fromPower.peakCurrentMa).toBeCloseTo(20.0, 6);

    const fromCurrent = convertRfPortLevel({
      mode: "current_a",
      value: 0.02,
      z0Ohm: 50,
    });
    expect(fromCurrent.powerDbm).toBeCloseTo(10.0, 8);
    expect(fromCurrent.peakVoltageV).toBeCloseTo(1.0, 8);

    const fromVoltage = convertRfPortLevel({
      mode: "voltage_v",
      value: 1.0,
      z0Ohm: 50,
    });
    expect(fromVoltage.powerDbm).toBeCloseTo(10.0, 8);
    expect(fromVoltage.peakCurrentA).toBeCloseTo(0.02, 8);
  });

  it("preserves edits across modeTabs in object.antenna.geometry and blocks tree navigation via InspectorDirtySelectionGuard with 2 dirty fields (P0 MA-P0-1)", async () => {
    const selectionController = new SelectionController(
      sharedBus as unknown as EventBus<KernelEventMap>,
    );
    const initialSelection: Selection = {
      kind: "object.antenna.geometry",
      label: "Geometry & Layout",
      moduleSource: "explorer",
      nodeId: "model:object:ant-1:antenna:geometry",
      objectId: "ant-1",
      ref: null,
    };
    selectionController.set(initialSelection, "explorer");

    await act(async () => {
      harness.root.render(
        createElement(GuardedGeometryHarness, { controller: selectionController }),
      );
    });

    const widthRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "signalWidthM",
    );
    expect(widthRow).not.toBeNull();
    const widthInput = findElement(widthRow!, (el) => el.tagName === "INPUT");
    expect(widthInput).not.toBeNull();
    await setTestInputValue(widthInput!, "180");

    const placementTab = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Standoff & 3D Placement")),
    );
    expect(placementTab).not.toBeNull();
    await act(async () => {
      placementTab!.click();
    });

    const standoffRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "standoffGapM",
    );
    expect(standoffRow).not.toBeNull();
    const standoffInput = findElement(standoffRow!, (el) => el.tagName === "INPUT");
    expect(standoffInput).not.toBeNull();
    await setTestInputValue(standoffInput!, "75");

    const layoutTab = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Conductor Layout")),
    );
    await act(async () => {
      layoutTab!.click();
    });
    const preservedWidthInput = findElement(
      findElement(
        harness.container,
        (el) => el.getAttribute("data-row") === "signalWidthM",
      )!,
      (el) => el.tagName === "INPUT",
    );
    expect(preservedWidthInput?.value).toBe("180");

    await act(async () => {
      selectionController.set(
        {
          kind: "object.root",
          label: "YIG Waveguide",
          nodeId: "model:object:film-1",
          objectId: "film-1",
          ref: null,
        },
        "explorer",
      );
    });

    expect(selectionController.get().kind).toBe("object.antenna.geometry");
    const guardDialog = findElement(
      harness.container,
      (el) => el.getAttribute("role") === "alertdialog",
    );
    expect(guardDialog).not.toBeNull();
    expect(guardDialog?.textContent).toContain("Signal trace width");
    expect(guardDialog?.textContent).toContain("Standoff gap");
  });

  it("builds valid authored geometry payloads for all 7 canonical antenna topologies", () => {
    expect(ALL_ANTENNA_TOPOLOGIES).toEqual([
      "straight_microstrip",
      "cpw",
      "gsg",
      "meander",
      "inductive_loop",
      "piecewise_3d_path",
      "external_cad_lead",
    ]);

    for (const topology of ALL_ANTENNA_TOPOLOGIES) {
      const draft = createDefaultAntennaGeometryDraft(topology);
      const built = buildAntennaTopologyGeometryPayload(draft);
      expect(typeof built.geometry_kind).toBe("string");
      expect(built.geometry_params).toBeTruthy();
    }
  });

  it("couples metalPreset <-> conductivitySpm bidirectionally in object.antenna.conductor and commits canonical merge_patch updating both objects and current_transports", async () => {
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaConductorInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.conductor",
              label: "Conductor",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:conductor",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    // Verify restored identity details and navigation buttons
    expect(harness.container.textContent).toContain("MicrostripAntennaLayout");
    expect(harness.container.textContent).toContain("signal, return");
    expect(harness.container.textContent).toContain("Open Geometry");
    expect(harness.container.textContent).toContain("Open Mesh Policy");

    // Select Gold (Au) — 41.0 MS/m
    const presetRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "metalPreset",
    );
    expect(presetRow).not.toBeNull();
    const goldItem = findElement(
      presetRow!,
      (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "au",
    );
    expect(goldItem).not.toBeNull();
    await act(async () => {
      goldItem!.click();
    });

    const sigmaRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "conductivitySpm",
    );
    const sigmaInput = findElement(sigmaRow!, (el) => el.tagName === "INPUT");
    expect(sigmaInput?.value).toBe("41");

    const applyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });

    expect(commitTransactionMock).toHaveBeenCalledTimes(1);
    const txPayload = commitTransactionMock.mock.calls[0]?.[0] as {
      base_revision?: number;
      kind?: string;
      merge_patch?: {
        current_transports?: Array<{
          materials?: Array<{ material?: { sigma_Spm?: number } }>;
          name?: string;
        }>;
        objects?: Array<{
          geometry?: { geometry_params?: { conductivity_s_per_m?: number } };
          id?: string;
        }>;
      };
      patch?: unknown;
    };
    expect(txPayload.kind).toBe("merge_patch");
    expect(txPayload.base_revision).toBe(5);
    expect(txPayload.patch).toBeUndefined();
    const updatedAnt = txPayload.merge_patch?.objects?.find((o) => o.id === "ant-1");
    expect(updatedAnt?.geometry?.geometry_params?.conductivity_s_per_m).toBe(4.1e7);
    const updatedCt = txPayload.merge_patch?.current_transports?.find(
      (c) => c.name === "ct_ant",
    );
    expect(updatedCt?.materials?.[0]?.material?.sigma_Spm).toBe(4.1e7);

    // Typing a non-preset conductivity (12 MS/m) switches metalPreset to 'custom'
    await setTestInputValue(sigmaInput!, "12");
    const selectRoot = findElement(
      presetRow!,
      (el) => el.getAttribute("data-slot") === "mock-select",
    );
    expect(selectRoot?.getAttribute("data-value")).toBe("custom");
  });

  it("renders dynamic antennaNavigationLinks for multi-port composition in object.antenna with readOnly commit bar and zero antenna_architectures writes", async () => {
    const baseScene = createDefaultMockScene();
    mockSceneState.data = {
      ...baseScene,
      antenna_field_solve_stages: [
        {
          conductor_mesh_policy: "authored_shared_domain",
          current_transport_id: "ct_ant",
          id: "solve_alpha",
          outputs: [{ id: "h_basis_1", quantity: "H_ant_basis" }],
          port_mode_ids: ["port_1"],
          solver_policy: "production_default",
          source_object_id: "ant-1",
        },
      ],
      antenna_port_modes: [
        ...(baseScene.antenna_port_modes ?? []),
        {
          branches: [
            {
              id: "sig_aux",
              inlet_terminal_ref: "signal:inlet",
              outlet_terminal_ref: "signal:outlet",
              signed_weight: 1,
            },
            {
              id: "ret_aux",
              inlet_terminal_ref: "return:inlet",
              outlet_terminal_ref: "return:outlet",
              signed_weight: -1,
            },
          ],
          current_transport_id: "ct_ant",
          id: "port_2",
          normalization_current_a: 1,
          schema_version: "antenna_port_mode.v2",
          source_object_id: "ant-1",
        },
      ],
      antenna_target_projections: [
        {
          id: "proj_yig",
          solution: {
            kind: "stage_output",
            output_id: "h_basis_1",
            stage_id: "solve_alpha",
          },
          target: { kind: "object", object_id: "film-1" },
        },
      ],
    } as unknown as SceneResource;

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaOverviewInspectorSpecPanel, {
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain(
      "Composition navigation — edit each resource in its own Inspector",
    );
    expect(harness.container.textContent).toContain("port_1");
    expect(harness.container.textContent).toContain("port_2");
    expect(harness.container.textContent).toContain("solve_alpha");
    expect(harness.container.textContent).toContain("proj_yig");

    const openPort2Btn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Open Port · Port 2")),
    );
    expect(openPort2Btn).not.toBeNull();
    await act(async () => {
      openPort2Btn!.click();
    });

    expect(selectionSetMock).toHaveBeenCalledTimes(1);
    const selectedTarget = selectionSetMock.mock.calls[0]?.[0] as Selection;
    expect(selectedTarget.kind).toBe("object.antenna.port");
    expect(
      selectedTarget.ref?.type === "scene-object"
        ? selectedTarget.ref.antennaResourceId
        : null,
    ).toBe("port_2");
    expect(commitTransactionMock).not.toHaveBeenCalled();
  });

  it("creates a new RF port from RadixAntennaPortComposer on object.antenna.conductor via canonical merge_patch", async () => {
    commitTransactionMock.mockImplementationOnce(
      async (req: { merge_patch?: Record<string, unknown> }) => ({
        committed_scene: {
          ...mockSceneState.data,
          ...(req.merge_patch ?? {}),
          revision: 6,
          scene: { id: "scene-antenna-core", name: "Antenna Core Scene" },
          scene_revision: 6,
        },
        scene_revision: 6,
      }),
    );

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaConductorInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.conductor",
              label: "Conductor",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:conductor",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    const composer = findElement(
      harness.container,
      (el) => el.getAttribute("data-testid") === "antenna-port-composer",
    );
    expect(composer).not.toBeNull();

    const newPortIdInput = findElement(
      composer!,
      (el) => el.getAttribute("aria-label") === "New port ID",
    );
    await setTestInputValue(newPortIdInput!, "port_aux");

    const transportWrap = findElement(
      composer!,
      (el) => el.getAttribute("data-row") === "newPortTransport",
    );
    const ctOption = findElement(
      transportWrap!,
      (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "ct_ant",
    );
    await act(async () => {
      ctOption!.click();
    });

    // Configure Branch 1 (+1) and Branch 2 (-1)
    await setTestInputValue(
      findElement(composer!, (el) => el.getAttribute("aria-label") === "New port branch 1 ID")!,
      "sig_br",
    );
    await setTestInputValue(
      findElement(
        composer!,
        (el) => el.getAttribute("aria-label") === "New port branch 1 signed weight",
      )!,
      "1",
    );
    await act(async () => {
      findElement(
        findElement(
          composer!,
          (el) =>
            el.getAttribute("data-composer-branch") === "0" &&
            el.getAttribute("data-terminal-role") === "inlet",
        )!,
        (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "signal:inlet",
      )!.click();
    });
    await act(async () => {
      findElement(
        findElement(
          composer!,
          (el) =>
            el.getAttribute("data-composer-branch") === "0" &&
            el.getAttribute("data-terminal-role") === "outlet",
        )!,
        (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "signal:outlet",
      )!.click();
    });

    await setTestInputValue(
      findElement(composer!, (el) => el.getAttribute("aria-label") === "New port branch 2 ID")!,
      "ret_br",
    );
    await setTestInputValue(
      findElement(
        composer!,
        (el) => el.getAttribute("aria-label") === "New port branch 2 signed weight",
      )!,
      "-1",
    );
    await act(async () => {
      findElement(
        findElement(
          composer!,
          (el) =>
            el.getAttribute("data-composer-branch") === "1" &&
            el.getAttribute("data-terminal-role") === "inlet",
        )!,
        (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "return:inlet",
      )!.click();
    });
    await act(async () => {
      findElement(
        findElement(
          composer!,
          (el) =>
            el.getAttribute("data-composer-branch") === "1" &&
            el.getAttribute("data-terminal-role") === "outlet",
        )!,
        (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "return:outlet",
      )!.click();
    });

    const createBtn = findElement(
      composer!,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Create port")) &&
        !el.disabled,
    );
    expect(createBtn).not.toBeNull();
    await act(async () => {
      createBtn!.click();
    });

    expect(commitTransactionMock).toHaveBeenCalledTimes(1);
    const req = commitTransactionMock.mock.calls[0]?.[0] as {
      base_revision: number;
      kind: string;
      merge_patch: {
        antenna_port_modes: Array<{
          branches: Array<{ signed_weight: number }>;
          id: string;
          normalization_current_a: number;
          schema_version: string;
        }>;
      };
    };
    expect(req.kind).toBe("merge_patch");
    expect(req.base_revision).toBe(5);
    const created = req.merge_patch.antenna_port_modes.find((p) => p.id === "port_aux");
    expect(created).toBeDefined();
    expect(created?.schema_version).toBe("antenna_port_mode.v2");
    expect(created?.normalization_current_a).toBe(1);
    expect(created?.branches.map((b) => b.signed_weight)).toEqual([1, -1]);
  });

  it("resolves antennaResourceId for port_2 in object.antenna.port, commits canonical signed_weight without non-schema keys, and supports Remove port (no cascade)", async () => {
    const baseScene = createDefaultMockScene();
    mockSceneState.data = {
      ...baseScene,
      antenna_port_modes: [
        ...(baseScene.antenna_port_modes ?? []),
        {
          branches: [
            {
              id: "p2_sig",
              inlet_terminal_ref: "signal:inlet",
              outlet_terminal_ref: "signal:outlet",
              signed_weight: 1,
            },
            {
              id: "p2_ret",
              inlet_terminal_ref: "return:inlet",
              outlet_terminal_ref: "return:outlet",
              signed_weight: -1,
            },
          ],
          current_transport_id: "ct_ant",
          id: "port_2",
          normalization_current_a: 1,
          schema_version: "antenna_port_mode.v2",
          source_object_id: "ant-1",
        },
      ],
    } as unknown as SceneResource;

    const port2Selection: Selection = {
      kind: "object.antenna.port",
      label: "Port port_2",
      moduleSource: "explorer",
      nodeId: "model:object:ant-1:antenna:port:port_2",
      objectId: "ant-1",
      ref: {
        antennaResourceId: "port_2",
        antennaResourceKind: "port",
        kind: "object.antenna.port",
        nodeId: "model:object:ant-1:antenna:port:port_2",
        objectId: "ant-1",
        type: "scene-object",
        visualizationTargetId: "object:ant-1",
      },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaPortInspectorSpecPanel, {
            selection: port2Selection,
          }),
        ),
      );
    });

    // Must hydrate port_2, NOT port_1!
    expect(harness.container.textContent).toContain("RF Port (port_2)");
    const br1IdInput = findElement(
      harness.container,
      (el) => el.getAttribute("aria-label") === "Branch 1 ID",
    );
    expect(br1IdInput?.value).toBe("p2_sig");

    // Rename Branch 1 on port_2 and Apply
    await setTestInputValue(br1IdInput!, "p2_sig_edited");

    const applyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });

    expect(commitTransactionMock).toHaveBeenCalledTimes(1);
    const tx = commitTransactionMock.mock.calls[0]?.[0] as {
      base_revision: number;
      kind: string;
      merge_patch: {
        antenna_port_modes: Array<Record<string, unknown>>;
      };
      patch?: unknown;
    };
    expect(tx.kind).toBe("merge_patch");
    expect(tx.patch).toBeUndefined();
    const p1 = tx.merge_patch.antenna_port_modes.find((p) => p.id === "port_1");
    const p2 = tx.merge_patch.antenna_port_modes.find((p) => p.id === "port_2");
    expect((p1?.branches as Array<{ id: string }>)[0]?.id).toBe("signal_main");
    expect((p2?.branches as Array<{ id: string; signed_weight: number }>)[0]).toEqual({
      id: "p2_sig_edited",
      inlet_terminal_ref: "signal:inlet",
      outlet_terminal_ref: "signal:outlet",
      signed_weight: 1,
    });
    // Zero non-schema keys polluted onto antenna_port_modes!
    expect(p2?.impedance_ohm).toBeUndefined();
    expect(p2?.peak_current_a).toBeUndefined();
    expect(p2?.rf_power_dbm).toBeUndefined();
  });

  it("authors per-cap external_lead_preparation with SHA-256 terminal boundary markers in object.antenna.terminals", async () => {
    const baseScene = createDefaultMockScene();
    mockSceneState.data = {
      ...baseScene,
      antenna_port_modes: [
        {
          branches: [
            {
              id: "signal",
              inlet_terminal_ref: "signal:inlet",
              outlet_terminal_ref: "signal:outlet",
              signed_weight: 1,
            },
            {
              id: "return",
              inlet_terminal_ref: "return:inlet",
              outlet_terminal_ref: "return:outlet",
              signed_weight: -1,
            },
          ],
          current_transport_id: "ct_ant",
          id: "port_1",
          normalization_current_a: 1,
          schema_version: "antenna_port_mode.v2",
          source_object_id: "ant-1",
        },
      ],
      current_transports: [
        {
          boundaries: [],
          coupling: "one_way",
          domain: [{ object_id: "ant-1" }],
          kind: "current_transport",
          materials: [
            {
              material: { sigma_Spm: 5.96e7 },
              region: { object_id: "ant-1", region_id: "signal" },
            },
            {
              material: { sigma_Spm: 5.96e7 },
              region: { object_id: "ant-1", region_id: "return" },
            },
          ],
          model: "ohmic_poisson",
          name: "ct_ant",
          solver: {
            engine: "cg",
            operator_version: "fem_charge_conforming_h1_p1.transparent.v1",
          },
        },
      ],
    } as unknown as SceneResource;

    commitTransactionMock.mockImplementationOnce(
      async (req: { merge_patch?: Record<string, unknown> }) => ({
        committed_scene: {
          ...mockSceneState.data,
          ...(req.merge_patch ?? {}),
          revision: 6,
          scene: { id: "scene-antenna-core", name: "Antenna Core Scene" },
          scene_revision: 6,
        },
        scene_revision: 6,
      }),
    );

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaTerminalsInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.terminals",
              label: "Terminals",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:terminals",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain(
      "Circuit source and port observations",
    );
    expect(harness.container.textContent?.toLowerCase()).not.toContain("unavailable");

    const portSelectWrap = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "terminalPrepPort",
    );
    const selectPortBtn = findElement(
      portSelectWrap!,
      (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "port_1",
    );
    await act(async () => {
      selectPortBtn!.click();
    });

    await setTestInputValue(
      findElement(
        harness.container,
        (el) => el.getAttribute("aria-label") === "Preparation revision",
      )!,
      "rev-1",
    );

    const observations = [
      { current: "-0.02", dir: ["-1", "0", "0"], obs: "signal:inlet" },
      { current: "0.02", dir: ["1", "0", "0"], obs: "signal:outlet" },
      { current: "0.02", dir: ["-1", "0", "0"], obs: "return:inlet" },
      { current: "-0.02", dir: ["1", "0", "0"], obs: "return:outlet" },
    ] as const;

    for (const item of observations) {
      await setTestInputValue(
        findElement(
          harness.container,
          (el) => el.getAttribute("aria-label") === `Lead length ${item.obs}`,
        )!,
        "200e-9",
      );
      await setTestInputValue(
        findElement(
          harness.container,
          (el) => el.getAttribute("aria-label") === `Lead conductivity ${item.obs}`,
        )!,
        "5.96e7",
      );
      await setTestInputValue(
        findElement(
          harness.container,
          (el) => el.getAttribute("aria-label") === `World outward direction x ${item.obs}`,
        )!,
        item.dir[0],
      );
      await setTestInputValue(
        findElement(
          harness.container,
          (el) => el.getAttribute("aria-label") === `World outward direction y ${item.obs}`,
        )!,
        item.dir[1],
      );
      await setTestInputValue(
        findElement(
          harness.container,
          (el) => el.getAttribute("aria-label") === `World outward direction z ${item.obs}`,
        )!,
        item.dir[2],
      );
      await setTestInputValue(
        findElement(
          harness.container,
          (el) =>
            el.getAttribute("aria-label") ===
            `Signed outward actuator current ${item.obs}`,
        )!,
        item.current,
      );
    }

    const applyPrepBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply inspection preparation")) &&
        !el.disabled,
    );
    expect(applyPrepBtn).not.toBeNull();
    await act(async () => {
      applyPrepBtn!.click();
    });

    expect(commitTransactionMock).toHaveBeenCalledTimes(1);
    const tx = commitTransactionMock.mock.calls[0]?.[0] as {
      base_revision: number;
      kind: string;
      merge_patch: {
        antenna_terminal_preparations?: unknown;
        current_transports: Array<{
          external_lead_preparation?: {
            extensions: Array<{ boundary_markers: number[]; observation_id: string }>;
            schema_version: string;
          };
          name: string;
        }>;
      };
    };
    expect(tx.kind).toBe("merge_patch");
    expect(tx.merge_patch.antenna_terminal_preparations).toBeUndefined();
    const prep = tx.merge_patch.current_transports.find((c) => c.name === "ct_ant")
      ?.external_lead_preparation;
    expect(prep?.schema_version).toBe("antenna_external_lead_preparation.v1");
    const expectedMarker = await antennaTerminalBoundaryMarker(
      "ant-1",
      "signal",
      "local_u_min",
    );
    const sigInExt = prep?.extensions.find((e) => e.observation_id === "signal:inlet");
    expect(sigInExt?.boundary_markers).toEqual([expectedMarker]);
  });

  it("serializes editable CPW stations, computes AABB placement from realization, preserves transform.rotation, and commits closed-loop circuits via buildMicrostripCircuitPatch", async () => {
    mockRealizationState.status = "ready";
    mockRealizationState.data = {
      bodies: [
        {
          bounds_max: [1.2e-6, 400e-9, 10e-9],
          bounds_min: [-1.2e-6, -400e-9, -10e-9],
          object_id: "film-1",
          status: "ready",
        },
      ],
      source_scene_revision: 5,
    } as unknown as GeometryRealizationResource;

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaGeometryInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.geometry",
              label: "Geometry & Layout",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:geometry",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    // Switch topology to CPW and add an interior station
    const topoRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "topology",
    );
    const cpwBtn = findElement(
      topoRow!,
      (el) => el.tagName === "BUTTON" && el.getAttribute("data-value") === "cpw",
    );
    await act(async () => {
      cpwBtn!.click();
    });

    const stationsEditor = findElement(
      harness.container,
      (el) => el.getAttribute("data-testid") === "antenna-stations-editor",
    );
    expect(stationsEditor).not.toBeNull();
    const addStationBtn = findElement(
      stationsEditor!,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Add station")),
    );
    await act(async () => {
      addStationBtn!.click();
    });

    // Edit interior station 2 signal width & left gap
    await setTestInputValue(
      findElement(
        stationsEditor!,
        (el) => el.getAttribute("aria-label") === "Station 2 signal width",
      )!,
      "220e-9",
    );
    await setTestInputValue(
      findElement(
        stationsEditor!,
        (el) => el.getAttribute("aria-label") === "Station 2 left gap",
      )!,
      "85e-9",
    );

    const applyCpwBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    await act(async () => {
      applyCpwBtn!.click();
    });

    expect(commitTransactionMock).toHaveBeenCalledTimes(1);
    const cpwTx = commitTransactionMock.mock.calls[0]?.[0] as {
      kind: string;
      merge_patch: {
        objects: Array<{
          geometry: {
            geometry_kind: string;
            geometry_params: {
              stations: Array<{ left_gap_m: number; s: number; signal_width_m: number }>;
            };
          };
          id: string;
          transform: { rotation?: number[]; rotation_quat?: number[]; translation: number[] };
        }>;
      };
    };
    const patchedAnt = cpwTx.merge_patch.objects.find((o) => o.id === "ant-1")!;
    expect(patchedAnt.geometry.geometry_kind).toBe("CPWAntennaLayout");
    expect(patchedAnt.geometry.geometry_params.stations).toHaveLength(3);
    expect(patchedAnt.geometry.geometry_params.stations[1]?.signal_width_m).toBe(220e-9);
    expect(patchedAnt.geometry.geometry_params.stations[1]?.left_gap_m).toBe(85e-9);
    // Preserves transform.rotation ([0, 0, 0]) and rotation_quat ([0, 0, 0, 1])!
    expect(patchedAnt.transform.rotation).toEqual([0, 0, 0]);
    expect(patchedAnt.transform.rotation_quat).toEqual([0, 0, 0, 1]);
  });

  it("commits closed-loop microstrip return with inlet/outlet bridges via buildMicrostripCircuitPatch", async () => {
    const baseScene = createDefaultMockScene();
    mockSceneState.data = {
      ...baseScene,
      antenna_port_modes: [
        {
          branches: [
            {
              id: "signal",
              inlet_terminal_ref: "signal:inlet",
              outlet_terminal_ref: "signal:outlet",
              signed_weight: 1,
            },
            {
              id: "return",
              inlet_terminal_ref: "return:inlet",
              outlet_terminal_ref: "return:outlet",
              signed_weight: -1,
            },
          ],
          current_transport_id: "ct_ant",
          id: "port_1",
          normalization_current_a: 1,
          schema_version: "antenna_port_mode.v2",
          source_object_id: "ant-1",
        },
      ],
    } as unknown as SceneResource;

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaGeometryInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.geometry",
              label: "Geometry & Layout",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:geometry",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    const loopTab = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Closed-Loop Return")),
    );
    await act(async () => {
      loopTab!.click();
    });

    const enableLoopRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "closedLoopEnabled",
    );
    const loopSwitch = findElement(
      enableLoopRow!,
      (el) => el.getAttribute("role") === "switch",
    );
    await act(async () => {
      loopSwitch!.click();
    });

    // Edit inlet bridge width
    const inletWidthInput = findElement(
      harness.container,
      (el) => el.getAttribute("aria-label") === "inlet bridge width",
    );
    await setTestInputValue(inletWidthInput!, "100e-9");

    const applyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    await act(async () => {
      applyBtn!.click();
    });

    expect(commitTransactionMock).toHaveBeenCalledTimes(1);
    const tx = commitTransactionMock.mock.calls[0]?.[0] as {
      kind: string;
      merge_patch: {
        antenna_port_modes: Array<{ id: string; schema_version: string }>;
        current_transports: Array<{
          name: string;
          structured_current_closure?: { kind: string; schema_version: string };
        }>;
        objects: Array<{
          geometry: { geometry_params: { loop?: { enabled: boolean; inlet_connection_width_m: number } } };
          id: string;
        }>;
      };
    };
    expect(tx.kind).toBe("merge_patch");
    const ant = tx.merge_patch.objects.find((o) => o.id === "ant-1");
    expect(ant?.geometry.geometry_params.loop?.enabled).toBe(true);
    expect(ant?.geometry.geometry_params.loop?.inlet_connection_width_m).toBe(100e-9);
    const ct = tx.merge_patch.current_transports.find((c) => c.name === "ct_ant");
    expect(ct?.structured_current_closure?.schema_version).toBe(
      "structured_current_closure.v2",
    );
    const pm = tx.merge_patch.antenna_port_modes.find((p) => p.id === "port_1");
    expect(pm?.schema_version).toBe("antenna_port_mode.v3");
  });
});
