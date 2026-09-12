import { describe, expect, it } from "vitest";

import { buildFieldFrameEnvelopeFromRuntimeState, type EnvelopeAdapterInput } from "../envelopeAdapter";
import type { CapabilityMap } from "@/src/api/types";

function makeCapabilities(overrides: Partial<CapabilityMap> = {}): CapabilityMap {
  return {
    structured_grid: true,
    explicit_topology: false,
    binary_fields: true,
    cell_fields: true,
    node_fields: false,
    scalar_history: true,
    eigen_modes: false,
    gpu_telemetry: false,
    preview_2d: true,
    preview_3d: true,
    algorithms_available: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<EnvelopeAdapterInput> = {}): EnvelopeAdapterInput {
  return {
    sessionId: "session-1",
    runId: "run-1",
    liveState: {
      status: "running",
      updated_at_unix_ms: Date.now(),
      step: 42,
      time: 1e-10,
      dt: 1e-13,
      e_ex: 0,
      e_demag: 0,
      e_ext: 0,
      e_ani: 0,
      e_dmi: 0,
      e_total: 0,
      max_dm_dt: 0,
      max_h_eff: 0,
      max_h_demag: 0,
      wall_time_ns: 0,
      grid: [32, 32, 1] as [number, number, number],
      preview_grid: null,
      preview_data_points_count: null,
      preview_max_points: null,
      preview_auto_downscaled: false,
      preview_auto_downscale_message: null,
      fem_mesh: null,
      magnetization: null,
      finished: false,
    },
    femMesh: null,
    preview: null,
    stepUpdateV2: null,
    domainCapabilities: null,
    fallbackFemDiscretization: false,
    quantityId: "m",
    ...overrides,
  };
}

describe("buildFieldFrameEnvelopeFromRuntimeState", () => {
  it("returns null when sessionId is missing", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(makeInput({ sessionId: null }));
    expect(result).toBeNull();
  });

  it("returns null when runId is missing", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(makeInput({ runId: null }));
    expect(result).toBeNull();
  });

  it("returns null when both liveState and stepUpdateV2 are null", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(
      makeInput({ liveState: null, stepUpdateV2: null }),
    );
    expect(result).toBeNull();
  });

  it("builds envelope from liveState for FDM", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(makeInput());
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-1");
    expect(result!.runId).toBe("run-1");
    expect(result!.sourceStep).toBe(42);
    expect(result!.location).toBe("grid_cell");
    expect(result!.quantityId).toBe("m");
    expect(result!.domain).toBe("magnetic_only");
    expect(result!.backendEpoch).toBe(0);
  });

  it("uses mesh generation id from femMesh for FEM", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(
      makeInput({
        domainCapabilities: makeCapabilities({
          structured_grid: false,
          explicit_topology: true,
          cell_fields: false,
          node_fields: true,
        }),
        fallbackFemDiscretization: false,
        femMesh: {
          nodes: [],
          elements: [],
          boundary_faces: [],
          generation_id: "gen-42",
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.meshGenerationId).toBe("gen-42");
    expect(result!.location).toBe("node");
  });

  it("falls back to mesh_id when generation_id is absent", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(
      makeInput({
        domainCapabilities: makeCapabilities({
          structured_grid: false,
          explicit_topology: true,
          cell_fields: false,
          node_fields: true,
        }),
        fallbackFemDiscretization: false,
        femMesh: {
          nodes: [],
          elements: [],
          boundary_faces: [],
          mesh_id: "mesh-99",
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.meshGenerationId).toBe("mesh-99");
  });

  it("falls back to legacy discretization boolean when capabilities are unavailable", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(
      makeInput({
        domainCapabilities: null,
        fallbackFemDiscretization: true,
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.location).toBe("node");
  });

  it("prefers stepUpdateV2 diagnostics over liveState", () => {
    const result = buildFieldFrameEnvelopeFromRuntimeState(
      makeInput({
        stepUpdateV2: {
          diagnostics: {
            step: 100,
            time: 5e-10,
            dt: 2e-13,
            wall_time_ns: 1000,
          },
          scalars: {
            step: 100,
            time: 5e-10,
            mx: 0,
            my: 0,
            mz: 1,
            e_ex: 0,
            e_demag: 0,
            e_ext: 0,
            e_ani: 0,
            e_dmi: 0,
            e_total: 0,
            max_dm_dt: 0,
            max_h_eff: 0,
            max_h_demag: 0,
          },
          frames: [],
          finished: false,
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.sourceStep).toBe(100);
    expect(result!.sourceTime).toBe(5e-10);
  });
});
