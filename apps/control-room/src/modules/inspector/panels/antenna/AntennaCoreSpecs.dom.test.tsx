import {
  mountWave5TestDom,
  setTestInputValue,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { InspectorDirtySelectionGuard } from "@/modules/inspector/InspectorDirtySelectionGuard";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";

import { formatAntennaParameter } from "./AntennaReadoutModel";
import {
  AntennaConductorInspectorSpecPanel,
  AntennaGeometryInspectorSpecPanel,
  buildAntennaTopologyGeometryPayload,
  createDefaultAntennaGeometryDraft,
  ALL_ANTENNA_TOPOLOGIES,
} from "./AntennaCoreSpecs";
import { convertRfPortLevel } from "./rfPowerConverter";

const { commitTransactionMock, sharedBus } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    commitTransactionMock: vi.fn().mockResolvedValue({}),
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
    selection: { set: vi.fn() },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
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

vi.mock("@/kernel/resources/geometryLifecycleResources", () => {
  const ready = <T,>(data: T) => ({
    data,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  });
  return {
    SCENE_RESOURCE_KEY: "/model/scene",
    useSceneResource: () =>
      ready({
        antenna_port_modes: [
          {
            branches: [
              {
                id: "signal_main",
                inlet_terminal_ref: "signal:inlet",
                outlet_terminal_ref: "signal:outlet",
                weight: 1,
              },
            ],
            current_transport_id: "ct_ant",
            id: "port_1",
            source_object_id: "ant-1",
          },
        ],
        current_transports: [
          {
            coupling: "one_way",
            domain: [{ object_id: "ant-1" }],
            kind: "current_transport",
            materials: [
              {
                material: { sigma_Spm: 5.96e7 },
                region: { object_id: "ant-1", region_id: "signal" },
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
            transform: {
              rotation: [0, 0, 0],
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
            material_ref: "yig",
            name: "YIG Waveguide",
          },
        ],
        revision: 5,
        scene_revision: 5,
      }),
  };
});

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

describe("Task 20 AntennaCoreSpecs, P0 geometry dirty guard across 7 topologies, RF converter & readout", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    commitTransactionMock.mockClear();
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

    // 1. Edit signal trace width w on 'Conductor Layout' tab (default nm: 150 -> 180)
    const widthRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "signalWidthM",
    );
    expect(widthRow).not.toBeNull();
    const widthInput = findElement(widthRow!, (el) => el.tagName === "INPUT");
    expect(widthInput).not.toBeNull();
    await setTestInputValue(widthInput!, "180");

    // 2. Switch to 'Standoff & 3D Placement' tab and edit standoff z (gap -> 75 nm)
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

    // 3. Switch back to 'Conductor Layout' and confirm signalWidthM edit (180) was preserved!
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

    // 4. Attempt to click another Explorer node -> DirtySelectionGuard intercepts and opens AlertDialog!
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

  it("couples metalPreset <-> conductivitySpm bidirectionally in object.antenna.conductor and commits updated conductivity", async () => {
    commitTransactionMock.mockClear();

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

    // Select Gold (Au) — 41.0 MS/m from Radix Select mock option button
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

    // Conductivity input (displayed in MS/m) updates to 41 and Apply commits 4.1e7 S/m
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
      patch?: { objects?: Array<{ id?: string; geometry?: { geometry_params?: { conductivity_s_per_m?: number } } }> };
    };
    const updatedAnt = txPayload.patch?.objects?.find((o) => o.id === "ant-1");
    expect(updatedAnt?.geometry?.geometry_params?.conductivity_s_per_m).toBe(4.1e7);

    // Typing a non-preset conductivity (12 MS/m) switches metalPreset to 'custom'
    await setTestInputValue(sigmaInput!, "12");
    const selectRoot = findElement(
      presetRow!,
      (el) => el.getAttribute("data-slot") === "mock-select",
    );
    expect(selectRoot?.getAttribute("data-value")).toBe("custom");
  });
});
