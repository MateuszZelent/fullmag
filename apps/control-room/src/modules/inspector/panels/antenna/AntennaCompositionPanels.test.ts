import { describe, expect, it } from "vitest";

import type { AntennaFieldSolutionResource, AntennaSourceSpectrumResource, AntennaStageOutputCatalogResource, SceneResource } from "@/kernel/api/apiTypes";

import { antennaWaveformBandwidthValue } from "./AntennaCompositionModel";
import { antennaFieldSolutionIdentityStatus, antennaSpectrumIdentityStatus, resolveAntennaRuntimeIds } from "./AntennaCompositionRuntime";

function sceneFixture(): SceneResource {
  return {
    antenna_field_solve_stages: [
      {
        id: "solve-1",
        outputs: [
          { id: "h-ant-output", quantity: "H_ant_basis" },
        ],
      },
    ],
    antenna_spectrum_requests: [
      {
        id: "spectrum-1",
        output_id: "spectrum-output",
        solution_ref: { kind: "stage_output", output_id: "h-ant-output", stage_id: "solve-1" },
      },
    ],
    antenna_target_projections: [
      {
        id: "projection-1",
        solution: { kind: "stage_output", output_id: "h-ant-output", stage_id: "solve-1" },
      },
    ],
    solved_antenna_drives: [
      { id: "drive-1", projection_ref: "projection-1" },
    ],
  } as unknown as SceneResource;
}

describe("resolveAntennaRuntimeIds", () => {
  it("resolves a solve-stage node to its published H_ant output", () => {
    expect(resolveAntennaRuntimeIds("solution", "solve-1", sceneFixture())).toEqual({
      solutionId: "h-ant-output",
      spectrumOutputId: null,
      spectrumRequestId: null,
      stageId: "solve-1",
      publishedRef: null,
    });
  });

  it("resolves spectrum and drive nodes through their authored references", () => {
    const scene = sceneFixture();
    expect(resolveAntennaRuntimeIds("spectrum", "spectrum-1", scene)).toEqual({
      solutionId: "h-ant-output",
      spectrumOutputId: "spectrum-output",
      spectrumRequestId: "spectrum-1",
      stageId: "solve-1",
      publishedRef: null,
    });
    expect(resolveAntennaRuntimeIds("drive", "drive-1", scene)).toEqual({
      solutionId: "h-ant-output",
      spectrumOutputId: null,
      spectrumRequestId: null,
      stageId: "solve-1",
      publishedRef: null,
    });
  });

  it("fails closed when a published output is not present", () => {
    expect(resolveAntennaRuntimeIds("solution", "missing", sceneFixture())).toEqual({
      solutionId: null,
      spectrumOutputId: null,
      spectrumRequestId: null,
      stageId: null,
      publishedRef: null,
    });
  });

  it("does not request a stage catalog for an imported resolved asset", () => {
    const scene = sceneFixture() as unknown as {
      antenna_target_projections: Array<{ solution: Record<string, string> }>;
      antenna_spectrum_requests: Array<{ solution_ref: Record<string, string> }>;
    };
    const published = {
      kind: "resolved_asset",
      stage_id: "solve-1",
      output_id: "h-ant-output",
      asset_id: "asset-1",
      content_digest: "sha256:valid",
    };
    scene.antenna_target_projections[0].solution = published;
    scene.antenna_spectrum_requests[0].solution_ref = published;
    expect(resolveAntennaRuntimeIds("projection", "projection-1", scene as unknown as SceneResource).stageId).toBeNull();
    expect(resolveAntennaRuntimeIds("drive", "drive-1", scene as unknown as SceneResource).stageId).toBeNull();
    expect(resolveAntennaRuntimeIds("spectrum", "spectrum-1", scene as unknown as SceneResource).stageId).toBeNull();
    expect(resolveAntennaRuntimeIds("projection", "projection-1", scene as unknown as SceneResource).publishedRef).toEqual({
      assetId: "asset-1", contentDigest: "sha256:valid", stageId: "solve-1",
    });
  });
});

describe("antennaFieldSolutionIdentityStatus", () => {
  const field = {
    asset_id: "asset-1",
    content_digest: "sha256:valid",
    quantity: "H_ant_basis",
    solution_id: "h-ant-output",
    stage_id: "solve-1",
    status: "ready",
    session_id: "session-1",
    session_epoch: "epoch-1",
    request_scope_epoch: "instance-1:7",
  } as AntennaFieldSolutionResource;
  const catalog = {
    stage_id: "solve-1",
    status: "ready",
    session_id: "session-1",
    session_epoch: "epoch-1",
    request_scope_epoch: "instance-1:7",
    outputs: [{
      output_id: "h-ant-output",
      solution_ref: {
        stage_id: "solve-1", output_id: "h-ant-output",
        asset_id: "asset-1", content_digest: "sha256:valid",
      },
    }],
  } as AntennaStageOutputCatalogResource;

  it("requires matching catalog identity for a symbolic stage output", () => {
    const ids = resolveAntennaRuntimeIds("projection", "projection-1", sceneFixture());
    expect(antennaFieldSolutionIdentityStatus(ids, { status: "ready", data: field }, { status: "ready", data: catalog })).toBe("ready");
    expect(antennaFieldSolutionIdentityStatus(ids, { status: "ready", data: field }, { status: "loading", data: null })).toBe("awaiting stage catalog");
    expect(antennaFieldSolutionIdentityStatus(ids, { status: "ready", data: field }, {
      status: "ready", data: { ...catalog, session_epoch: "other-epoch" },
    })).toBe("identity mismatch");
    expect(antennaFieldSolutionIdentityStatus(ids, { status: "ready", data: field }, {
      status: "ready", data: { ...catalog, request_scope_epoch: "instance-1:8" },
    })).toBe("identity mismatch");
    expect(antennaFieldSolutionIdentityStatus(ids, { status: "ready", data: field }, {
      status: "ready", data: { ...catalog, outputs: [{ ...catalog.outputs[0], solution_ref: { ...catalog.outputs[0].solution_ref, asset_id: "other-asset" } }] },
    })).toBe("identity mismatch");
  });

  it("requires matching asset and digest for an imported reference", () => {
    const ids = {
      solutionId: "h-ant-output", spectrumOutputId: null, spectrumRequestId: null, stageId: null,
      publishedRef: { assetId: "asset-1", contentDigest: "sha256:valid", stageId: "solve-1" },
    };
    expect(antennaFieldSolutionIdentityStatus(ids, { status: "ready", data: field }, { status: "idle", data: null })).toBe("ready");
    expect(antennaFieldSolutionIdentityStatus(ids, {
      status: "ready", data: { ...field, content_digest: "sha256:other" },
    }, { status: "idle", data: null })).toBe("identity mismatch");
  });
});

describe("antennaSpectrumIdentityStatus", () => {
  const spectrum = {
    output_id: "spectrum-output",
    request_id: "spectrum-1",
    solution_id: "h-ant-output",
    solution_content_digest: "sha256:valid",
    session_id: "session-1",
    session_epoch: "epoch-1",
    request_scope_epoch: "instance-1:7",
    sampling: { solution_id: "h-ant-output" },
  } as AntennaSourceSpectrumResource;
  const catalog = {
    stage_id: "solve-1", status: "ready", session_id: "session-1", session_epoch: "epoch-1",
    request_scope_epoch: "instance-1:7",
    outputs: [{
      output_id: "h-ant-output",
      solution_ref: { stage_id: "solve-1", content_digest: "sha256:valid" },
    }],
  } as AntennaStageOutputCatalogResource;

  it("requires the same source digest and session as the symbolic solve", () => {
    const ids = resolveAntennaRuntimeIds("spectrum", "spectrum-1", sceneFixture());
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: spectrum }, { status: "ready", data: catalog })).toBe("ready");
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: spectrum }, { status: "loading", data: null })).toBe("awaiting stage catalog");
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: { ...spectrum, solution_content_digest: "sha256:other" } }, { status: "ready", data: catalog })).toBe("identity mismatch");
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: spectrum }, { status: "ready", data: { ...catalog, session_epoch: "other" } })).toBe("identity mismatch");
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: spectrum }, { status: "ready", data: { ...catalog, request_scope_epoch: "instance-1:8" } })).toBe("identity mismatch");
  });

  it("checks the imported field digest without requesting a stage catalog", () => {
    const ids = {
      ...resolveAntennaRuntimeIds("spectrum", "spectrum-1", sceneFixture()),
      stageId: null,
      publishedRef: { assetId: "asset-1", contentDigest: "sha256:valid", stageId: "solve-1" },
    };
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: spectrum }, { status: "idle", data: null })).toBe("ready");
    expect(antennaSpectrumIdentityStatus(ids, { status: "ready", data: { ...spectrum, request_id: "other" } }, { status: "idle", data: null })).toBe("identity mismatch");
  });
});

describe("antennaWaveformBandwidthValue", () => {
  it("renders a declared finite upper band", () => {
    expect(antennaWaveformBandwidthValue({ f_max_hz: 6e9 })).toBe(
      "6.0000e+9 Hz",
    );
  });

  it("does not invent a band for an absent or invalid declaration", () => {
    expect(antennaWaveformBandwidthValue(undefined)).toBe("not declared");
    expect(antennaWaveformBandwidthValue({ f_max_hz: Number.NaN })).toBe(
      "invalid declaration",
    );
  });
});
