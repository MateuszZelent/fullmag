import {
  mountWave5TestDom,
  setTestInputValue,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import { resolveScientificChartPalette } from "@/shared/charts/ScientificEChart";

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  commitTransaction: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("commitTransaction");
    return {};
  }),
  createFieldDrive: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("createFieldDrive");
    return {};
  }),
  createMaskFieldDrive: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("createMaskFieldDrive");
    return {};
  }),
  readyAntennaTerms: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("readyAntennaTerms");
    return { terms: [] };
  }),
  replaceFieldDrive: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("replaceFieldDrive");
    return {};
  }),
  replaceMaskFieldDrive: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("replaceMaskFieldDrive");
    return {};
  }),
  sceneFieldDrivesOverride: null as unknown,
  capturedOptions: [] as unknown[],
}));

vi.mock("@/shared/charts/ScientificEChart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/charts/ScientificEChart")>();
  return {
    ...actual,
    ScientificEChart: ({
      ariaLabel,
      optionBuilder,
    }: {
      ariaLabel: string;
      optionBuilder: (palette: ReturnType<typeof actual.resolveScientificChartPalette>) => unknown;
    }) => {
      const opt = optionBuilder(actual.resolveScientificChartPalette(null));
      mocks.capturedOptions.push(opt);
      return createElement("div", {
        "aria-label": ariaLabel,
        "data-slot": "scientific-echart",
      });
    },
  };
});

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const kernelValue = {
    api: {
      model: {
        commitTransaction: mocks.commitTransaction,
        createFieldDrive: mocks.createFieldDrive,
        createMaskFieldDrive: mocks.createMaskFieldDrive,
        fieldDrives: vi.fn().mockResolvedValue({ drives: [], scene_revision: 6 }),
        maskFieldDrives: vi.fn().mockResolvedValue({ drives: [], scene_revision: 6 }),
        readyAntennaTerms: mocks.readyAntennaTerms,
        readyAntennas: vi.fn().mockResolvedValue({ antennas: [] }),
        replaceFieldDrive: mocks.replaceFieldDrive,
        replaceMaskFieldDrive: mocks.replaceMaskFieldDrive,
      },
    },
    bus: { emit: vi.fn(), on: () => () => undefined },
    commands: { execute: vi.fn().mockResolvedValue(undefined) },
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
    sessionId: "session-antenna-exc",
  }),
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({
      data: {
        domain: { discretization: "fem" },
        resources: { scene_revision: 6 },
      },
    } as never),
}));

vi.mock("@/kernel/resources/antennaResources", () => {
  const ready = <T,>(data: T) => ({
    data,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  });

  // Build 64x64 synthetic Float64 spectrum buffer
  const values = new Float64Array(64 * 64);
  for (let iy = 0; iy < 64; iy += 1) {
    for (let ix = 0; ix < 64; ix += 1) {
      const dx = ix - 32;
      const dy = iy - 32;
      values[iy * 64 + ix] = Math.exp(-(dx * dx + dy * dy) / 50);
    }
  }

  return {
    antennaSpectrumPayloadEtag: () => '"etag-spec-64"',
    useAntennaFieldSolutionResource: () =>
      ready({
        asset_id: "sol-asset-1",
        bases: [{ port_mode_id: "port_1" }],
        content_digest: "sha256:sol1",
        quantity: "H_ant_basis",
        solution_id: "sol-1",
        stage_id: "solve-1",
        status: "ready",
      }),
    useAntennaSourceSpectrumPayloadResource: () =>
      ready({
        byteLength: values.byteLength,
        data: values.buffer,
        etag: '"etag-spec-64"',
        status: "ready" as const,
      }),
    useAntennaSourceSpectrumResource: () =>
      ready({
        component: "x",
        content_digest: "sha256:spec64",
        normalization: "integral_si",
        output_id: "spec-out-1",
        payloads: {
          magnitude: { sha256: "0".repeat(64) },
        },
        port_mode_id: "port_1",
        request_id: "spec-req-1",
        sampling: {
          extent_u_m: 3.2e-6,
          extent_v_m: 3.2e-6,
          sample_count_u: 64,
          sample_count_v: 64,
        },
        solution_id: "sol-1",
        source_object_id: "ant-1",
      }),
    useAntennaStageOutputCatalogResource: () => ready(null),
  };
});

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
        antenna_field_solve_stages: [
          {
            current_transport_id: "ct_ant",
            id: "solve-1",
            oersted_realization: "direct_tetra_quadrature",
            outputs: [{ id: "sol-1", quantity: "H_ant_basis" }],
            relative_tolerance: 1e-10,
            source_object_id: "ant-1",
            target_refs: [{ kind: "object", object_id: "film-1" }],
          },
        ],
        antenna_port_modes: [{ id: "port_1", source_object_id: "ant-1" }],
        antenna_spectrum_requests: [
          {
            component: "x",
            id: "spec-req-1",
            normalization: "integral_si",
            output_id: "spec-out-1",
            port_mode_id: "port_1",
            sampling_plane: {
              extent_u_m: 3.2e-6,
              extent_v_m: 3.2e-6,
              sample_count_u: 64,
              sample_count_v: 64,
            },
            solution_ref: {
              kind: "stage_output",
              output_id: "sol-1",
              stage_id: "solve-1",
            },
          },
        ],
        antenna_target_projections: [
          {
            id: "proj-1",
            solution: {
              kind: "stage_output",
              output_id: "sol-1",
              stage_id: "solve-1",
            },
          },
        ],
        field_drives: mocks.sceneFieldDrivesOverride ?? { drives: [] },
        mask_field_drives: { drives: [], scene_revision: 6 },
        objects: [
          { id: "ant-1", name: "CPW Exciter" },
          { id: "film-1", material_ref: "yig", name: "YIG Waveguide" },
          { id: "film-2", material_ref: "permalloy", name: "Py Strip" },
        ],
        revision: 6,
        scene_revision: 6,
        solved_antenna_drives: [
          {
            frequency_hz: 8e9,
            id: "drive-1",
            peak_current_a: 0.015,
            projection_ref: "proj-1",
            waveform_kind: "sine",
          },
        ],
      }),
  };
});

import {
  AntennaRegionalMaskInspectorSpecPanel,
  AntennaSolutionInspectorSpecPanel,
  AntennaSpectrumInspectorSpecPanel,
} from "./AntennaExcitationAndVizSpecs";

describe("Task 21 AntennaExcitationAndVizSpecs: ECharts 64x64 heatmap, gaussian_k_source ready-antennas/terms & single-session solution", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    mocks.callOrder.length = 0;
    mocks.capturedOptions.length = 0;
    mocks.sceneFieldDrivesOverride = null;
    mocks.commitTransaction.mockClear();
    mocks.createFieldDrive.mockClear();
    mocks.replaceFieldDrive.mockClear();
    mocks.createMaskFieldDrive.mockClear();
    mocks.replaceMaskFieldDrive.mockClear();
    mocks.readyAntennaTerms.mockClear();
    void resolveScientificChartPalette;
  });

  afterEach(() => {
    harness.unmount();
  });

  it("renders a 64x64 wavevector spectrum on ScientificEChart canvas with 0 .fm-antenna-heatmap__cell DOM spans", async () => {
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaSpectrumInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.spectrum",
              label: "Spectrum 1",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:spectrum:spec-req-1",
              objectId: "ant-1",
              ref: { spectrumId: "spec-req-1" } as never,
            },
          }),
        ),
      );
    });

    const charts = findElements(
      harness.container,
      (el) => el.getAttribute("data-slot") === "scientific-echart",
    );
    expect(charts.length).toBeGreaterThanOrEqual(1);

    const legacyDomCells = findElements(harness.container, (el) =>
      el.className.includes("fm-antenna-heatmap__cell"),
    );
    expect(legacyDomCells).toHaveLength(0);

    const heatmapOption = mocks.capturedOptions.find((opt) => {
      const rec = opt as { series?: Array<{ type?: string; data?: unknown[] }> };
      return rec.series?.some((s) => s.type === "heatmap" && s.data?.length === 4096);
    });
    expect(heatmapOption).toBeDefined();
  });

  it("enables Apply immediately on mount in missing mode and sends valid OpenAPI v2 payloads for regional & gaussian_k_source drives", async () => {
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaRegionalMaskInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.regional",
              label: "Regional Field Mask",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:regional",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    // 1. Apply is enabled immediately on mount in missing mode BEFORE any user edit!
    const initialApplyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    expect(initialApplyBtn).not.toBeNull();
    await act(async () => {
      initialApplyBtn!.click();
    });

    expect(mocks.createFieldDrive).toHaveBeenCalledTimes(1);
    expect(mocks.createFieldDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        base_revision: 6,
        drive: expect.objectContaining({
          amplitude_B_T: 0.002,
          direction: [0, 1, 0],
          kind: "regional",
          spatial_profile: {
            envelope: { kind: "uniform" },
            kind: "geometry_mask",
            object_id: "ant-1",
          },
          target: { kind: "global" },
          time_origin: "stage_local",
          waveform: expect.objectContaining({
            frequency_hz: 6e9,
            kind: "sinusoidal",
          }),
        }),
      }),
      expect.any(Object),
    );

    // 2. Select gaussian_k_source spatial profile -> calls readyAntennaTerms then createMaskFieldDrive
    mocks.callOrder.length = 0;
    const gaussianBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Gaussian k-Source")),
    );
    expect(gaussianBtn).not.toBeNull();
    await act(async () => {
      gaussianBtn!.click();
    });

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

    expect(mocks.readyAntennaTerms).toHaveBeenCalledTimes(1);
    expect(mocks.readyAntennaTerms).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          amplitude: 0.002,
          frequency: 6e9,
          sigma_x: expect.any(Number),
          wavelength: expect.any(Number),
        }),
        function: "fullmag.antennas.gaussian_k_source",
      }),
      expect.any(Object),
    );
    expect(mocks.createMaskFieldDrive).toHaveBeenCalledTimes(1);
    expect(mocks.createMaskFieldDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        base_revision: 6,
        drive: expect.objectContaining({
          frame: "local",
          schema_version: "mask_field_drive.v1",
          target: { kind: "object", object_id: "ant-1" },
          time_origin: "stage_local",
        }),
      }),
      expect.any(Object),
    );
    expect(mocks.callOrder).toEqual(["readyAntennaTerms", "createMaskFieldDrive"]);
  });

  it("detects canonical regional drive inside scene.field_drives.drives and calls replaceFieldDrive on edit", async () => {
    mocks.sceneFieldDrivesOverride = {
      drives: [
        {
          activation: { kind: "all_time_evolution" },
          amplitude_B_T: 0.003,
          direction: [0, 1, 0],
          enabled: true,
          id: "ant-1:H_ant",
          kind: "regional",
          name: "ant-1:H_ant",
          spatial_profile: {
            envelope: { kind: "uniform" },
            kind: "geometry_mask",
            object_id: "ant-1",
          },
          target: { kind: "global" },
          time_origin: "stage_local",
          waveform: { frequency_hz: 5e9, kind: "sinusoidal", offset: 0, phase_rad: 0 },
        },
      ],
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaRegionalMaskInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.regional",
              label: "Regional Field Mask",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:regional:existing",
              objectId: "ant-1",
              ref: null,
            },
          }),
        ),
      );
    });

    // In existing mode, Apply starts disabled until an edit is made
    const disabledApply = findElement(
      harness.container,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    expect(disabledApply?.disabled).toBe(true);

    const b0Row = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "peakFieldT",
    );
    const b0Input = findElement(b0Row!, (el) => el.tagName === "INPUT");
    await setTestInputValue(b0Input!, "5");

    const enabledApply = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    expect(enabledApply).not.toBeNull();
    await act(async () => {
      enabledApply!.click();
    });

    expect(mocks.replaceFieldDrive).toHaveBeenCalledTimes(1);
    expect(mocks.replaceFieldDrive).toHaveBeenCalledWith(
      "ant-1:H_ant",
      expect.objectContaining({
        base_revision: 6,
        drive: expect.objectContaining({
          amplitude_B_T: 0.005,
          id: "ant-1:H_ant",
          kind: "regional",
        }),
      }),
      expect.any(Object),
    );
  });

  it("commits simultaneous solver tolerance and target destination edits in one single Apply click in object.antenna.solution", async () => {
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AntennaSolutionInspectorSpecPanel, {
            selection: {
              kind: "object.antenna.solution",
              label: "Field Solution",
              moduleSource: "explorer",
              nodeId: "model:object:ant-1:antenna:solution:solve-1",
              objectId: "ant-1",
              ref: { stageId: "solve-1" } as never,
            },
          }),
        ),
      );
    });

    // 1. Edit solver relative tolerance
    const tolRow = findElement(
      harness.container,
      (el) => el.getAttribute("data-row") === "relativeTolerance",
    );
    expect(tolRow).not.toBeNull();
    const tolInput = findElement(tolRow!, (el) => el.tagName === "INPUT");
    await setTestInputValue(tolInput!, "1e-12");

    // 2. Toggle second destination target ('Py Strip') in the same view
    const targetToggle = findElement(
      harness.container,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Py Strip")),
    );
    expect(targetToggle).not.toBeNull();
    await act(async () => {
      targetToggle!.click();
    });

    // 3. Click single Apply button
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

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
  });
});
