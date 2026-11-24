import {
  mountWave5TestDom,
  setTestInputValue,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElements,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  capturedChartOptions: [] as Array<{
    ariaLabel: string;
    option: Record<string, unknown>;
  }>,
  commitTransaction: vi.fn().mockResolvedValue({ scene_revision: 7 }),
  createFieldDrive: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("createFieldDrive");
    return {};
  }),
  createMaskFieldDrive: vi.fn().mockImplementation(async () => {
    mocks.callOrder.push("createMaskFieldDrive");
    return {};
  }),
  executeCommand: vi.fn().mockResolvedValue({ status: "completed" }),
  invalidateResource: vi.fn(),
  payloadStatus: "ready" as "ready" | "pending",
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
  sceneData: null as Record<string, unknown> | null,
  selectSet: vi.fn(),
  setAntennaFieldIntent: vi.fn(),
  setArtifactFieldSelection: vi.fn(),
  vizIntent: null as Record<string, unknown> | null,
}));

vi.mock("@/shared/charts/ScientificEChart", () => ({
  minMaxFinite: (values: ArrayLike<number>) => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]!;
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min <= max ? { max, min } : null;
  },
  ScientificEChart: ({
    ariaLabel,
    optionBuilder,
  }: {
    ariaLabel: string;
    optionBuilder: (palette: Record<string, unknown>) => Record<string, unknown>;
  }) => {
    const option = optionBuilder({
      accent: "var(--fm-accent)",
      borderSubtle: "var(--fm-border)",
      danger: "var(--fm-danger)",
      fieldBackground: "var(--fm-bg-field)",
      fontFamilyMono: "monospace",
      fontFamilySans: "sans-serif",
      fontSize: 12,
      info: "var(--fm-info)",
      panelBackground: "var(--fm-bg-panel)",
      success: "var(--fm-success)",
      textMuted: "var(--fm-text-muted)",
      textPrimary: "var(--fm-text)",
      textSecondary: "var(--fm-text-secondary)",
      tooltipBackground: "var(--fm-bg-elevated)",
      warning: "var(--fm-warning)",
    });
    mocks.capturedChartOptions.push({ ariaLabel, option });
    return (
      <div
        aria-label={ariaLabel}
        data-echarts-canvas="true"
        data-slot="scientific-echart"
        role="img"
      />
    );
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        commitTransaction: mocks.commitTransaction,
        createFieldDrive: mocks.createFieldDrive,
        createMaskFieldDrive: mocks.createMaskFieldDrive,
        readyAntennaTerms: mocks.readyAntennaTerms,
        replaceFieldDrive: mocks.replaceFieldDrive,
        replaceMaskFieldDrive: mocks.replaceMaskFieldDrive,
        scene: vi.fn().mockImplementation(async () => mocks.sceneData),
      },
      resourceCacheScope: "scope-w5-ant",
    },
    authoringHistory: {
      getGeneration: () => 1,
      record: vi.fn(),
    },
    commands: {
      disabledReason: () => null,
      execute: mocks.executeCommand,
      getSessionScopeKey: () => "scope-w5-ant",
      getVersion: () => 0,
      isEnabled: () => true,
      subscribe: () => () => undefined,
    },
    layout: {
      openSavedResults: vi.fn(),
    },
    resources: {
      invalidate: mocks.invalidateResource,
      invalidatePrefix: vi.fn(),
    },
    selection: {
      get: () => null,
      set: mocks.selectSet,
    },
    visualizationSync: {
      getSnapshot: () => ({ inflightPatch: null, pendingPatch: null }),
      subscribe: () => () => undefined,
    },
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "/api/v2/session",
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: 1,
    sessionEpoch: 1,
    sessionId: "sess-w5-ant",
  }),
}));

vi.mock(
  "@/kernel/resources/sessionResourceIdentity",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/resources/sessionResourceIdentity")
    >();
    return {
      ...actual,
      sessionRequestScopeKey: () => "scope-w5-ant",
    };
  },
);

vi.mock(
  "@/kernel/resources/geometryLifecycleResources",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/resources/geometryLifecycleResources")
    >();
    return {
      ...actual,
      publishCommittedSceneResource: vi.fn(),
      SCENE_RESOURCE_KEY: "/api/v2/model/scene",
      useSceneResource: () => ({
        data: mocks.sceneData,
        error: null,
        refetch: vi.fn(),
        refreshError: null,
        sessionScopeKey: "scope-w5-ant",
        status: "ready",
      }),
    };
  },
);

vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/studyRuntimeResources")
  >();
  return {
    ...actual,
    useStageExecutionResource: () => ({
      data: { run_id: "run-1", stages: [] },
      error: null,
      refreshError: null,
      status: "ready",
    }),
  };
});

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: {
      clip: { axis: "z", enabled: false, invert: false, position_percent: 50 },
    },
    error: null,
    isPending: false,
    mutate: vi.fn(),
    optimisticData: {
      clip: { axis: "z", enabled: false, invert: false, position_percent: 50 },
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/visualization/useObjectVisualization", () => ({
  useObjectVisualizationController: () => ({
    fitToView: vi.fn(),
    resetCamera: vi.fn(),
    setAntennaFieldIntent: mocks.setAntennaFieldIntent,
    setArtifactFieldSelection: mocks.setArtifactFieldSelection,
    setCameraPreset: vi.fn(),
  }),
  useObjectVisualizationSelector: (
    selector: (snapshot: Record<string, unknown>) => unknown,
  ) =>
    selector({
      antennaFieldDisplayStatus: null,
      antennaFieldIntent: mocks.vizIntent,
      artifactFieldSelection: null,
    }),
}));

vi.mock("@/kernel/resources/antennaResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/antennaResources")
  >();
  const makeSpectrumBuffer = (kind: string) => {
    if (kind === "k_u_rad_per_m" || kind === "k_v_rad_per_m") {
      const axis = new Float64Array(64);
      for (let i = 0; i < 64; i += 1) {
        axis[i] = -3.2e7 + (6.4e7 * i) / 63;
      }
      return axis.buffer;
    }
    if (kind === "amplitudes_re_im") {
      const amps = new Float64Array(2 * 64 * 64);
      for (let i = 0; i < 64 * 64; i += 1) {
        amps[2 * i] = (i % 64) * 1e-3;
        amps[2 * i + 1] = Math.floor(i / 64) * 0.5e-3;
      }
      return amps.buffer;
    }
    const power = new Float64Array(64 * 64);
    for (let i = 0; i < power.length; i += 1) {
      power[i] = Math.sin(i * 0.05) ** 2;
    }
    return power.buffer;
  };
  return {
    ...actual,
    antennaSpectrumPayloadEtag: (
      _spec: unknown,
      kind: "k_u_rad_per_m" | "k_v_rad_per_m" | "amplitudes_re_im" | "power",
    ) => `etag-${kind}`,
    useAntennaExternalLeadInspectionPayloadResource: () => ({
      data: null,
      error: null,
      status: "idle",
    }),
    useAntennaExternalLeadInspectionResource: () => ({
      data: null,
      error: null,
      refreshError: null,
      status: "idle",
    }),
    useAntennaFieldSolutionPayloadResource: () => ({
      data: null,
      error: null,
      status: "idle",
    }),
    useAntennaFieldSolutionResource: () => ({
      data: {
        asset_id: "sol-asset-1",
        bases: [
          {
            current_density_per_ampere: {
              byte_length: 24,
              content_digest: "sha256:j",
              dtype: "float64",
              encoding: "float64_le",
              shape: [1, 3],
              unit: "A/m^2/A",
              uri: "/j",
              value_count: 3,
            },
            electric_potential_per_ampere: {
              byte_length: 8,
              content_digest: "sha256:v",
              dtype: "float64",
              encoding: "float64_le",
              shape: [1],
              unit: "V/A",
              uri: "/v",
              value_count: 1,
            },
            magnetic_field_per_ampere: {
              byte_length: 24,
              content_digest: "sha256:h",
              dtype: "float64",
              encoding: "float64_le",
              shape: [1, 3],
              unit: "A/m/A",
              uri: "/h",
              value_count: 3,
            },
            port_mode_id: "ant-1:port:common",
          },
        ],
        conductor_mesh_digest: "sha256:cmesh",
        content_digest: "sha256:sol1",
        current_transport_id: "ant-1:current",
        field_sampling_domain: { kind: "global" },
        geometry_revision: "rev-6",
        material_revision: "rev-6",
        mesh_digest: "sha256:mesh1",
        model: "quasistatic_conduction_biot_savart3d",
        oersted_realization: "direct_tetra_quadrature",
        port_mode_ids: ["ant-1:port:common"],
        quantity: "H_ant_basis",
        request_scope_epoch: 1,
        session_epoch: 1,
        session_id: "sess-w5-ant",
        solution_id: "ant-1:field-solution",
        source_object_id: "ant-1",
        stage_id: "solve-1",
        status: "ready",
      },
      error: null,
      status: "ready",
    }),
    useAntennaInspectionDisplayResource: () => ({
      data: null,
      error: null,
      refreshError: null,
      status: "idle",
    }),
    useAntennaSourceSpectrumPayloadResource: (
      _id: string | null,
      kind: string,
    ) => ({
      data:
        mocks.payloadStatus === "ready"
          ? {
              data: makeSpectrumBuffer(kind),
              etag: `etag-${kind}`,
              status: "ready",
            }
          : null,
      error: null,
      status: mocks.payloadStatus,
    }),
    useAntennaSourceSpectrumResource: () => ({
      data: {
        amplitude_unit: "A",
        component: "x",
        component_labels: ["x"],
        content_digest: "sha256:spec1",
        k_u_count: 64,
        k_v_count: 64,
        normalization: "integral_si",
        output_id: "spec-out-1",
        payloads: {
          amplitudes_re_im: {
            byte_length: 2 * 64 * 64 * 8,
            content_digest: "sha256:amp",
            dtype: "float64",
            encoding: "float64_le",
            shape: [1, 64, 64, 2],
            unit: "A",
            uri: "/amp",
            value_count: 2 * 64 * 64,
          },
          k_u_rad_per_m: {
            byte_length: 64 * 8,
            content_digest: "sha256:ku",
            dtype: "float64",
            encoding: "float64_le",
            shape: [64],
            unit: "rad/m",
            uri: "/ku",
            value_count: 64,
          },
          k_v_rad_per_m: {
            byte_length: 64 * 8,
            content_digest: "sha256:kv",
            dtype: "float64",
            encoding: "float64_le",
            shape: [64],
            unit: "rad/m",
            uri: "/kv",
            value_count: 64,
          },
          power: {
            byte_length: 64 * 64 * 8,
            content_digest: "sha256:pow",
            dtype: "float64",
            encoding: "float64_le",
            shape: [64, 64],
            unit: "A^2",
            uri: "/pow",
            value_count: 64 * 64,
          },
        },
        request_id: "spec-1",
        sampling: {
          extent_u_m: 3.2e-6,
          extent_v_m: 3.2e-6,
          sample_count_u: 64,
          sample_count_v: 64,
        },
        solution_content_digest: "sha256:sol1",
        status: "ready",
        transform: "spatial_fft",
        wave_vector_unit: "rad/m",
        window: "hann",
      },
      error: null,
      status: "ready",
    }),
    useAntennaStageOutputCatalogResource: () => ({
      data: {
        outputs: [
          {
            asset_id: "sol-asset-1",
            content_digest: "sha256:sol1",
            output_id: "ant-1:field-solution",
            quantity: "H_ant_basis",
            solution_ref: {
              asset_id: "sol-asset-1",
              content_digest: "sha256:sol1",
              output_id: "ant-1:field-solution",
              stage_id: "solve-1",
            },
          },
        ],
        request_scope_epoch: 1,
        session_epoch: 1,
        session_id: "sess-w5-ant",
        stage_id: "solve-1",
        stage_revision: 1,
        status: "ready",
      },
      error: null,
      status: "ready",
    }),
  };
});

import {
  AntennaDriveInspectorSpecPanel,
  AntennaProjectionInspectorSpecPanel,
  AntennaRegionalMaskInspectorSpecPanel,
  AntennaSolutionInspectorSpecPanel,
  AntennaSpectrumInspectorSpecPanel,
  AntennaVisualizationInspectorSpecPanel,
} from "../../inspectors/objects/antenna";

function buildBaseScene(): Record<string, unknown> {
  return {
    antenna_field_solve_stages: [
      {
        conductor_mesh_policy: "shared_domain_conforming",
        conservative_current_view_ref: "ant-1:current:rt0",
        current_transport_id: "ant-1:current",
        field_sampling_domain: { kind: "global" },
        id: "solve-1",
        model: "quasistatic_conduction_biot_savart3d",
        oersted_realization: "direct_tetra_quadrature",
        outputs: [{ id: "ant-1:field-solution", quantity: "H_ant_basis" }],
        port_mode_ids: ["ant-1:port:common"],
        solver_policy: "fem_cpu_double_reference",
        source_object_id: "ant-1",
        target_refs: [{ kind: "object", object_id: "film-1" }],
      },
      {
        conductor_mesh_policy: "independent_object",
        conservative_current_view_ref: "ant-1:current:rt0",
        current_transport_id: "ant-1:current",
        field_sampling_domain: { kind: "object", object_id: "film-2" },
        id: "solve-2",
        model: "quasistatic_conduction_biot_savart3d",
        oersted_realization: "direct_tetra_quadrature",
        outputs: [{ id: "ant-1:field-solution-2", quantity: "H_ant_basis" }],
        port_mode_ids: ["ant-1:port:common"],
        solver_policy: "production_default",
        source_object_id: "ant-1",
        target_refs: [{ kind: "object", object_id: "film-2" }],
      },
    ],
    antenna_port_modes: [
      {
        branches: [
          {
            id: "signal",
            inlet_terminal_ref: "sig_in",
            outlet_terminal_ref: "sig_out",
            signed_weight: 1,
          },
          {
            id: "return",
            inlet_terminal_ref: "ret_in",
            outlet_terminal_ref: "ret_out",
            signed_weight: -1,
          },
        ],
        current_transport_id: "ant-1:current",
        id: "ant-1:port:common",
        name: "Common Mode",
        normalization: {
          kind: "source_cut_rt0",
          orientation: "minus_outward",
          source_cut_ref: "source_cut",
        },
        normalization_current_a: 1,
        schema_version: "antenna_port_mode.v3",
        source_object_id: "ant-1",
      },
    ],
    antenna_spectrum_requests: [
      {
        component: "x",
        id: "spec-1",
        normalization: "integral_si",
        output_id: "spec-out-1",
        sampling_plane: {
          axis_u: [1, 0, 0],
          axis_v: [0, 1, 0],
          extent_u_m: 3.2e-6,
          extent_v_m: 3.2e-6,
          interpolation: "fem_element",
          origin_m: [0, 0, 0],
          outside_policy: "error",
          sample_count_u: 64,
          sample_count_v: 64,
        },
        solution_ref: {
          kind: "stage_output",
          output_id: "ant-1:field-solution",
          stage_id: "solve-1",
        },
        target: { kind: "object", object_id: "film-1" },
        transform: "spatial_fft",
        window: "hann",
      },
      {
        component: "u",
        id: "spec-2",
        normalization: "unitary_discrete",
        output_id: "spec-out-2",
        sampling_plane: {
          axis_u: [1, 0, 0],
          axis_v: [0, 1, 0],
          extent_u_m: 6.4e-6,
          extent_v_m: 6.4e-6,
          interpolation: "fem_element",
          origin_m: [0, 0, 10e-9],
          outside_policy: "zero",
          sample_count_u: 64,
          sample_count_v: 64,
        },
        solution_ref: {
          kind: "stage_output",
          output_id: "ant-1:field-solution-2",
          stage_id: "solve-2",
        },
        target: { kind: "object", object_id: "film-2" },
        transform: "spatial_fft",
        window: "blackman",
      },
    ],
    antenna_target_projections: [
      {
        id: "proj-1",
        output_id: "proj-1:out",
        solution: {
          kind: "stage_output",
          output_id: "ant-1:field-solution",
          stage_id: "solve-1",
        },
        target: { kind: "object", object_id: "film-1" },
      },
      {
        id: "proj-2",
        output_id: "proj-2:out",
        solution: {
          kind: "stage_output",
          output_id: "ant-1:field-solution-2",
          stage_id: "solve-2",
        },
        target: { kind: "object", object_id: "film-2" },
      },
    ],
    current_transports: [
      {
        boundaries: [],
        conservative_current_source: {
          closure: {
            kind: "closed_geometry",
            source_cuts: [{ id: "source_cut" }],
          },
          id: "ant-1:current:rt0",
          kind: "closed_geometry_potential_jump",
          material_parts: [
            { part_id: "signal" },
            { part_id: "return" },
            { part_id: "inlet" },
            { part_id: "outlet" },
          ],
          mesh_object_id: "ant-1",
          method: "mixed_hybrid_rt0",
          object_id: "ant-1",
          schema_version: "conservative_current_source.v2",
          terminal_observations: [
            { id: "sig_in", part_id: "signal", selector: "local_u_min" },
            { id: "sig_out", part_id: "signal", selector: "local_u_max" },
            { id: "ret_in", part_id: "return", selector: "local_u_min" },
            { id: "ret_out", part_id: "return", selector: "local_u_max" },
          ],
        },
        coupling: "one_way",
        domain: [{ kind: "object", object_id: "ant-1" }],
        enabled: true,
        formulation: "steady_ohmic_conduction",
        gauge: "zero_mean",
        kind: "current_transport",
        materials: [
          {
            material: { kind: "isotropic", sigma_Spm: 5.8e7 },
            target: { kind: "object", object_id: "ant-1" },
          },
        ],
        mode: "static",
        model: "ohmic_poisson",
        name: "ant-1:current",
        solver: {
          engine: "cg",
          linear: { max_iterations: 2000, relative_tolerance: 1e-10 },
        },
      },
    ],
    field_drives: { drives: [], mask_drives: [] },
    mask_field_drives: [],
    objects: [
      {
        geometry: {
          geometry_kind: "MicrostripAntennaLayout",
          geometry_params: {
            conductivity_s_per_m: 5.8e7,
            length_m: 10e-6,
            return_offset_m: 2e-6,
            return_width_m: 1e-6,
            signal_width_stations: [
              { s: 0, width_m: 1e-6 },
              { s: 1, width_m: 1e-6 },
            ],
            thickness_m: 100e-9,
          },
        },
        id: "ant-1",
        name: "CPW Antenna",
        role: "antenna",
      },
      { id: "film-1", name: "YIG Waveguide", role: "magnetic" },
      { id: "film-2", name: "Py Strip", role: "magnetic" },
    ],
    revision: 6,
    scene: { id: "scene-w5-ant" },
    solved_antenna_drives: [
      {
        activation: { kind: "all_time_evolution" },
        bandwidth_declaration: null,
        id: "drive-1",
        name: "CW 8 GHz Drive",
        peak_current_a: 0.02,
        port_mode_id: "ant-1:port:common",
        projection_ref: "proj-1",
        time_origin: "stage_local",
        waveform: {
          frequency_hz: 8e9,
          kind: "sinusoidal",
          offset: 0,
          phase_rad: 0,
        },
      },
      {
        activation: { kind: "all_time_evolution" },
        bandwidth_declaration: null,
        id: "drive-2",
        name: "Broadband Sinc Drive",
        peak_current_a: 0.05,
        port_mode_id: "ant-1:port:common",
        projection_ref: "proj-2",
        time_origin: "absolute",
        waveform: {
          amplitude: 1,
          cutoff_hz: 24e9,
          kind: "sinc_pulse",
          t0: 4e-11,
        },
      },
    ],
    study: {
      stages: [
        { enabled: true, id: "run-main", kind: "run", name: "Main LLG Run" },
      ],
    },
  };
}

function assertDesignHygiene(container: TestElement): void {
  const rawControls = findElements(
    container,
    (el) =>
      (el.tagName === "INPUT" &&
        el.getAttribute("data-slot") !== "input" &&
        el.getAttribute("data-slot") !== "input-group-control" &&
        el.getAttribute("type") !== "hidden") ||
      el.tagName === "SELECT" ||
      el.tagName === "TEXTAREA",
  );
  expect(
    rawControls.map(
      (el) =>
        `${el.tagName}[slot=${el.getAttribute("data-slot") ?? ""},type=${el.getAttribute("type") ?? ""},aria=${el.getAttribute("aria-label") ?? ""}]`,
    ),
  ).toEqual([]);
  const titledElements = findElements(
    container,
    (el) => el.getAttribute("title") !== null,
  );
  expect(
    titledElements.map(
      (el) => `${el.tagName}[title=${el.getAttribute("title") ?? ""}]`,
    ),
  ).toEqual([]);
  expect(container.textContent?.toLowerCase() ?? "").not.toMatch(
    /\b(?:unknown|unavailable)\b/,
  );
}

describe("Wave 5 AntennaExcitationAndVizSpecs 100% Feature-Parity Suite", () => {
  let harness: MountedWave5TestDom;

  async function renderPanel(element: ReactNode): Promise<void> {
    await act(async () => {
      harness.root.render(
        createElement(InspectorEditSessionProvider, null, element),
      );
    });
  }

  beforeEach(() => {
    harness = mountWave5TestDom();
    mocks.callOrder.length = 0;
    mocks.capturedChartOptions.length = 0;
    mocks.payloadStatus = "ready";
    mocks.vizIntent = null;
    mocks.commitTransaction.mockClear();
    mocks.createFieldDrive.mockClear();
    mocks.replaceFieldDrive.mockClear();
    mocks.createMaskFieldDrive.mockClear();
    mocks.replaceMaskFieldDrive.mockClear();
    mocks.readyAntennaTerms.mockClear();
    mocks.executeCommand.mockClear();
    mocks.setAntennaFieldIntent.mockClear();
    mocks.sceneData = buildBaseScene();
  });

  afterEach(() => {
    harness.unmount();
  });

  it("renders a 64x64 wavevector spectrum on ScientificEChart with real k_u, k_v, amplitudes_re_im, 1D cuts, complex sample table & JSON export (0 fake Gaussian)", async () => {
    await renderPanel(
      <AntennaSpectrumInspectorSpecPanel
        selection={{
          kind: "object.antenna.spectrum",
          label: "Spectrum",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:spectrum:spec-2",
          objectId: "ant-1",
          ref: {
            antennaResourceId: "spec-2",
            antennaResourceKind: "spectrum",
            kind: "object.antenna.spectrum",
            nodeId: "model:object:ant-1:antenna:spectrum:spec-2",
            objectId: "ant-1",
            type: "scene-object",
            visualizationTargetId: "object:ant-1",
          },
        }}
      />,
    );

    assertDesignHygiene(harness.container);
    expect(harness.container.textContent).toContain("spec-2");
    expect(harness.container.textContent).toContain("H_u");
    expect(harness.container.textContent).toContain(
      "Export full spectrum (JSON)",
    );
    expect(harness.container.textContent).toContain(
      "Complex source amplitudes at selected sample",
    );

    const echartsCanvases = findElements(
      harness.container,
      (el) => el.getAttribute("data-echarts-canvas") === "true",
    );
    expect(echartsCanvases.length).toBeGreaterThanOrEqual(3);

    const heatmapOption = mocks.capturedChartOptions.find((entry) =>
      entry.ariaLabel.includes("2D wavevector excitation spectrum"),
    );
    expect(heatmapOption).toBeDefined();
    const series = heatmapOption?.option.series as Array<{
      data?: unknown[];
      type?: string;
    }>;
    expect(
      series.some((s) => s.type === "heatmap" && s.data?.length === 4096),
    ).toBe(true);

    // When binary FFT payload is not materialized yet, zero fake Gaussian is synthesized
    mocks.capturedChartOptions.length = 0;
    mocks.payloadStatus = "pending";
    await renderPanel(
      <AntennaSpectrumInspectorSpecPanel
        selection={{
          kind: "object.antenna.spectrum",
          label: "Spectrum",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:spectrum:spec-1",
          objectId: "ant-1",
          ref: null,
        }}
      />,
    );
    expect(harness.container.textContent).toContain(
      "No published binary FFT payload is materialized",
    );
    expect(
      mocks.capturedChartOptions.some((entry) =>
        entry.ariaLabel.includes("2D wavevector excitation spectrum"),
      ),
    ).toBe(false);
  });

  it("enables Apply immediately on mount in missing mode and sends valid OpenAPI v2 payloads for regional & polarized gaussian_k_source drives", async () => {
    await renderPanel(
      <AntennaRegionalMaskInspectorSpecPanel
        selection={{
          kind: "object.antenna.regional",
          label: "Regional Mask",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:regional",
          objectId: "ant-1",
          ref: null,
        }}
      />,
    );

    assertDesignHygiene(harness.container);

    const findApplyButton = (): TestElement | undefined =>
      findElements(
        harness.container,
        (el) =>
          el.tagName === "BUTTON" &&
          Boolean(el.textContent?.includes("Apply")) &&
          !el.disabled,
      )[0];

    const applyBtnOnMount = findApplyButton();
    expect(applyBtnOnMount).toBeDefined();
    expect(applyBtnOnMount?.disabled).toBe(false);

    // 1. Default uniform_mask -> creates RegionalFieldDriveResource
    await act(async () => {
      applyBtnOnMount!.click();
    });
    expect(mocks.createFieldDrive).toHaveBeenCalledTimes(1);
    expect(mocks.createFieldDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        base_revision: 6,
        drive: expect.objectContaining({
          amplitude_B_T: 2e-3,
          direction: [0, 1, 0],
          enabled: true,
          id: "ant-1:H_ant",
          kind: "regional",
          spatial_profile: {
            envelope: { kind: "uniform" },
            kind: "geometry_mask",
            object_id: "ant-1",
          },
          waveform: expect.objectContaining({
            frequency_hz: 6e9,
            kind: "sinusoidal",
          }),
        }),
      }),
      { sessionScopeKey: "scope-w5-ant" },
    );

    // 2. Sinc grating exposes Center wavevector k₀
    const sincGratingSeg = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("data-slot") === "segmented-control-item" &&
        Boolean(el.textContent?.includes("Sinc Grating")),
    )[0];
    expect(sincGratingSeg).toBeDefined();
    await act(async () => {
      sincGratingSeg!.click();
    });
    expect(
      findElements(
        harness.container,
        (el) => el.getAttribute("data-row") === "centerWavevectorRadPerUm",
      ).length,
    ).toBeGreaterThan(0);

    // 3. Gaussian k-Source calls readyAntennaTerms then createMaskFieldDrive with polarized terms
    mocks.callOrder.length = 0;
    const gaussianSeg = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("data-slot") === "segmented-control-item" &&
        Boolean(el.textContent?.includes("Gaussian k-Source")),
    )[0];
    await act(async () => {
      gaussianSeg!.click();
    });

    await act(async () => {
      findApplyButton()!.click();
    });

    expect(mocks.readyAntennaTerms).toHaveBeenCalledTimes(1);
    expect(mocks.readyAntennaTerms).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          amplitude: 2e-3,
          frequency: 6e9,
        }),
        function: "fullmag.antennas.gaussian_k_source",
      }),
      { sessionScopeKey: "scope-w5-ant" },
    );
    expect(mocks.createMaskFieldDrive).toHaveBeenCalledTimes(1);
    const maskCallArg = mocks.createMaskFieldDrive.mock.calls[0]?.[0] as {
      drive: {
        frame: string;
        schema_version: string;
        terms: Array<{
          mask: {
            function: { parameters: Array<{ name: string; value: number }> };
          };
        }>;
      };
    };
    expect(maskCallArg.drive.frame).toBe("local");
    expect(maskCallArg.drive.schema_version).toBe("mask_field_drive.v1");
    expect(maskCallArg.drive.terms[0]?.mask.function.parameters).toEqual(
      expect.arrayContaining([
        { name: "px", value: 0 },
        { name: "py", value: 1 },
        { name: "pz", value: 0 },
      ]),
    );
    expect(mocks.callOrder).toEqual([
      "readyAntennaTerms",
      "createMaskFieldDrive",
    ]);
  });

  it("preserves constant & sinc_pulse regional waveforms and migrates legacy prescribed_zeeman_mask via merge_patch", async () => {
    mocks.sceneData = {
      ...buildBaseScene(),
      field_drives: {
        drives: [
          {
            activation: { kind: "all_time_evolution" },
            amplitude_B_T: 0.004,
            direction: [1, 0, 0],
            enabled: true,
            id: "ant-1:H_ant",
            kind: "regional",
            name: "Sinc Antenna",
            spatial_profile: {
              envelope: { kind: "uniform" },
              kind: "geometry_mask",
              object_id: "ant-1",
            },
            target: { kind: "global" },
            time_origin: "stage_local",
            waveform: {
              amplitude: 1,
              cutoff_hz: 18e9,
              kind: "sinc_pulse",
              t0: 3e-11,
            },
          },
        ],
        mask_drives: [],
      },
    };

    await renderPanel(
      <AntennaRegionalMaskInspectorSpecPanel
        selection={{
          kind: "object.antenna.regional",
          label: "Regional Mask",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:regional",
          objectId: "ant-1",
          ref: null,
        }}
      />,
    );

    const switchBtn = findElements(
      harness.container,
      (el) => el.getAttribute("role") === "switch",
    )[0];
    await act(async () => {
      switchBtn!.click();
    });
    const applyBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    )[0];
    await act(async () => {
      applyBtn!.click();
    });
    expect(mocks.replaceFieldDrive).toHaveBeenCalledWith(
      "ant-1:H_ant",
      expect.objectContaining({
        drive: expect.objectContaining({
          enabled: false,
          waveform: {
            amplitude: 1,
            cutoff_hz: 18e9,
            kind: "sinc_pulse",
            t0: 3e-11,
          },
        }),
      }),
      { sessionScopeKey: "scope-w5-ant" },
    );

    // Legacy prescribed_zeeman_mask detection & atomic migration
    mocks.sceneData = {
      ...buildBaseScene(),
      current_modules: {
        modules: [
          {
            B: 0.005,
            direction: [0, 0, 1],
            id: "legacy-mod-1",
            kind: "antenna_field_source",
            model: "prescribed_zeeman_mask",
            object: "ant-1",
            waveform: { kind: "constant" },
          },
        ],
      },
      field_drives: { drives: [], mask_drives: [] },
    };
    await renderPanel(
      <AntennaRegionalMaskInspectorSpecPanel
        selection={{
          kind: "object.antenna.regional",
          label: "Regional Mask",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:regional",
          objectId: "ant-1",
          ref: null,
        }}
      />,
    );
    expect(harness.container.textContent).toContain("Migration required");
    const migrateBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Migrate and Apply")),
    )[0];
    expect(migrateBtn).toBeDefined();
    await act(async () => {
      migrateBtn!.click();
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        base_revision: 6,
        kind: "merge_patch",
        merge_patch: expect.objectContaining({
          current_modules: { modules: [] },
          field_drives: expect.objectContaining({
            drives: expect.arrayContaining([
              expect.objectContaining({
                amplitude_B_T: 0.005,
                direction: [0, 0, 1],
                waveform: { kind: "constant" },
              }),
            ]),
          }),
        }),
      }),
      { sessionScopeKey: "scope-w5-ant" },
    );
  });

  it("resolves object.antenna.solution by selection.ref.antennaResourceId, hosts all 3 composers, and commits canonical merge_patch", async () => {
    await renderPanel(
      <AntennaSolutionInspectorSpecPanel
        selection={{
          kind: "object.antenna.solution",
          label: "Field Solve 2",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:solution:solve-2",
          objectId: "ant-1",
          ref: {
            antennaResourceId: "solve-2",
            antennaResourceKind: "solution",
            kind: "object.antenna.solution",
            nodeId: "model:object:ant-1:antenna:solution:solve-2",
            objectId: "ant-1",
            type: "scene-object",
            visualizationTargetId: "object:ant-1",
          },
        }}
      />,
    );

    assertDesignHygiene(harness.container);
    expect(harness.container.textContent).toContain("solve-2");

    expect(
      findElements(
        harness.container,
        (el) =>
          el.getAttribute("data-testid") === "antenna-study-stage-composer",
      ),
    ).toHaveLength(1);
    expect(
      findElements(
        harness.container,
        (el) =>
          el.getAttribute("data-testid") === "antenna-projection-composer",
      ),
    ).toHaveLength(1);
    expect(
      findElements(
        harness.container,
        (el) => el.getAttribute("data-testid") === "antenna-spectrum-composer",
      ),
    ).toHaveLength(1);

    const solveHeaderBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Solve antenna visualization")),
    )[0];
    expect(solveHeaderBtn).toBeDefined();
    await act(async () => {
      solveHeaderBtn!.click();
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "study.add-antenna-field-solve-stage",
      expect.objectContaining({
        input: expect.objectContaining({
          objectId: "ant-1",
          stageId: "solve-2",
        }),
      }),
    );

    const tolRow = findElements(
      harness.container,
      (el) => el.getAttribute("data-row") === "relativeTolerance",
    )[0];
    const tolInput = findElements(tolRow!, (el) => el.tagName === "INPUT")[0];
    await setTestInputValue(tolInput!, "1e-12");

    const targetsRow = findElements(
      harness.container,
      (el) => el.getAttribute("data-row") === "targetKeys",
    )[0];
    expect(targetsRow).toBeDefined();
    const yigToggle = findElements(
      targetsRow!,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("YIG Waveguide")),
    )[0];
    await act(async () => {
      yigToggle!.click();
    });

    const applyBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    )[0];
    await act(async () => {
      applyBtn!.click();
    });

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    const txArg = mocks.commitTransaction.mock.calls[0]?.[0] as {
      base_revision: number;
      kind: string;
      merge_patch: Record<string, unknown>;
      patch?: unknown;
    };
    expect(txArg.kind).toBe("merge_patch");
    expect(txArg.patch).toBeUndefined();
    const patchedStages = txArg.merge_patch
      .antenna_field_solve_stages as Array<Record<string, unknown>>;
    const updatedSolve2 = patchedStages.find((s) => s.id === "solve-2")!;
    expect(updatedSolve2.field_sampling_domain).toEqual({
      kind: "object",
      object_id: "film-2",
    });
    expect(updatedSolve2.linear_solver).toBeUndefined();
    expect(updatedSolve2.sampling_domain).toBeUndefined();
  });

  it("resolves projection & drive by selection.ref.antennaResourceId and commits canonical merge_patch schemas", async () => {
    await renderPanel(
      <AntennaProjectionInspectorSpecPanel
        selection={{
          kind: "object.antenna.projection",
          label: "Projection 2",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:projection:proj-2",
          objectId: "ant-1",
          ref: {
            antennaResourceId: "proj-2",
            antennaResourceKind: "projection",
            kind: "object.antenna.projection",
            nodeId: "model:object:ant-1:antenna:projection:proj-2",
            objectId: "ant-1",
            type: "scene-object",
            visualizationTargetId: "object:ant-1",
          },
        }}
      />,
    );
    assertDesignHygiene(harness.container);
    expect(harness.container.textContent).toContain("proj-2");
    expect(harness.container.textContent).toContain("Py Strip");

    const yigTargetItem = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.getAttribute("data-value")?.includes('"film-1"')),
    )[0];
    await act(async () => {
      yigTargetItem!.click();
    });
    const projApplyBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    )[0];
    await act(async () => {
      projApplyBtn!.click();
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        base_revision: 6,
        kind: "merge_patch",
        merge_patch: expect.objectContaining({
          antenna_target_projections: expect.arrayContaining([
            expect.objectContaining({
              id: "proj-2",
              target: { kind: "object", object_id: "film-1" },
            }),
          ]),
        }),
      }),
      { sessionScopeKey: "scope-w5-ant" },
    );

    // Drive 2 (Sinc pulse)
    mocks.commitTransaction.mockClear();
    await renderPanel(
      <AntennaDriveInspectorSpecPanel
        selection={{
          kind: "object.antenna.drive",
          label: "Drive 2",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:drive:drive-2",
          objectId: "ant-1",
          ref: {
            antennaResourceId: "drive-2",
            antennaResourceKind: "drive",
            kind: "object.antenna.drive",
            nodeId: "model:object:ant-1:antenna:drive:drive-2",
            objectId: "ant-1",
            type: "scene-object",
            visualizationTargetId: "object:ant-1",
          },
        }}
      />,
    );
    assertDesignHygiene(harness.container);
    expect(harness.container.textContent).toContain("50 Ω RF power equivalent");
    expect(
      findElements(
        harness.container,
        (el) => el.getAttribute("data-testid") === "antenna-drive-preview",
      ),
    ).toHaveLength(1);

    const nameRow = findElements(
      harness.container,
      (el) => el.getAttribute("data-row") === "name",
    )[0];
    const nameInput = findElements(nameRow!, (el) => el.tagName === "INPUT")[0];
    expect(nameInput?.value).toBe("Broadband Sinc Drive");
    await setTestInputValue(nameInput!, "Updated Sinc Drive");

    const driveApplyBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    )[0];
    await act(async () => {
      driveApplyBtn!.click();
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        base_revision: 6,
        kind: "merge_patch",
        merge_patch: {
          solved_antenna_drives: expect.arrayContaining([
            expect.objectContaining({
              id: "drive-2",
              name: "Updated Sinc Drive",
              time_origin: "absolute",
              waveform: {
                amplitude: 1,
                cutoff_hz: 24e9,
                kind: "sinc_pulse",
                t0: 4e-11,
              },
            }),
          ]),
        },
      }),
      { sessionScopeKey: "scope-w5-ant" },
    );
  });

  it("wires object.antenna.visualization to live ObjectVisualizationController, color range, vectors, clipping & camera", async () => {
    await renderPanel(
      <AntennaVisualizationInspectorSpecPanel
        selection={{
          kind: "object.antenna.visualization",
          label: "CPW Antenna",
          moduleSource: "explorer",
          nodeId: "model:object:ant-1:antenna:visualization",
          objectId: "ant-1",
          ref: null,
        }}
      />,
    );

    assertDesignHygiene(harness.container);
    expect(harness.container.textContent).toContain("Result representation");
    expect(harness.container.textContent).toContain(
      "Antenna visualization solve",
    );
    expect(harness.container.textContent).toContain("Render Mode");
    expect(harness.container.textContent).toContain("Antenna quantity");
    expect(harness.container.textContent).toContain("Port mode");
    expect(harness.container.textContent).toContain("Apply color range");
    expect(harness.container.textContent).toContain("Vector occlusion");

    const pointsPassBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.trim() === "Points"),
    )[0];
    expect(pointsPassBtn?.disabled).toBe(false);
    await act(async () => {
      pointsPassBtn!.click();
    });
    expect(mocks.setAntennaFieldIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "basis",
        points: true,
        portModeId: "ant-1:port:common",
        quantity: "magnetic_field_per_ampere",
        solutionId: "ant-1:field-solution",
        sourceObjectId: "ant-1",
        stageId: "solve-1",
      }),
    );
  });
});
