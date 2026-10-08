import { describe, expect, it } from "vitest";

import type { AntennaFieldSolutionResource, AntennaSourceSpectrumResource, BinaryResourceResult } from "../api/apiTypes";

import {
  antennaSpectrumPayloadEtag,
  antennaFieldPayloadEtag,
  requireMatchingAntennaPayloadRevision,
} from "./antennaResources";

describe("antenna source-spectrum payload identity", () => {
  const spectrum = {
    session_id: "session-1",
    session_epoch: "epoch-2",
    request_scope_epoch: "instance-1:7",
    output_id: "spectrum-3",
    content_digest: "sha256:manifest-4",
    payloads: {
      k_u_rad_per_m: { sha256: "sha256:ku-5" },
      k_v_rad_per_m: { sha256: "sha256:kv-6" },
      amplitudes_re_im: { sha256: "sha256:amplitudes-7" },
      power: { sha256: "sha256:power-8" },
    },
  } as AntennaSourceSpectrumResource;

  it("reconstructs the strong ETag from the selected manifest and payload", () => {
    expect(antennaSpectrumPayloadEtag(spectrum, "power")).toBe(
      '"antenna-source-spectrum-payload:session-1:epoch-2:instance-1:7:spectrum-3:power:sha256:manifest-4:sha256:power-8"',
    );
    expect(antennaSpectrumPayloadEtag(
      { ...spectrum, content_digest: "sha256:new-manifest" }, "power",
    )).not.toBe(antennaSpectrumPayloadEtag(spectrum, "power"));
    expect(antennaSpectrumPayloadEtag(
      { ...spectrum, request_scope_epoch: "instance-1:8" }, "power",
    )).not.toBe(antennaSpectrumPayloadEtag(spectrum, "power"));
  });

  it("rejects a payload fetched from another manifest revision", () => {
    const currentEtag = antennaSpectrumPayloadEtag(spectrum, "power");
    const stale: BinaryResourceResult<ArrayBuffer> = {
      data: new ArrayBuffer(8),
      byteLength: 8,
      etag: '"antenna-source-spectrum-payload:older"',
      status: "ready",
    };
    expect(() => requireMatchingAntennaPayloadRevision(stale, currentEtag)).toThrow(
      /does not match selected manifest/,
    );
    expect(requireMatchingAntennaPayloadRevision({ ...stale, etag: currentEtag }, currentEtag))
      .toEqual({ ...stale, etag: currentEtag });
  });
});

describe("antenna field-solution payload identity", () => {
  const solution = {
    session_id: "session-1",
    session_epoch: "epoch-2",
    request_scope_epoch: "instance-1:7",
    solution_id: "solution-3",
    content_digest: "sha256:manifest-4",
    sample_positions: { sha256: "sha256:positions-5" },
    bases: [{
      port_mode_id: "port-1",
      magnetic_field_per_ampere: { sha256: "sha256:field-6" },
    }],
  } as AntennaFieldSolutionResource;

  it("binds the selected port and manifest revision to the binary ETag", () => {
    expect(antennaFieldPayloadEtag(solution, "magnetic_field_per_ampere", "port-1")).toBe(
      '"antenna-field-payload:session-1:epoch-2:instance-1:7:solution-3:magnetic_field_per_ampere:port-1:sha256:manifest-4:sha256:field-6"',
    );
    expect(antennaFieldPayloadEtag(solution, "sample_positions")).toContain(
      ":sample_positions::sha256:manifest-4:sha256:positions-5",
    );
    expect(() => antennaFieldPayloadEtag(solution, "magnetic_field_per_ampere", "unknown"))
      .toThrow(/no selected binary payload/);
    expect(antennaFieldPayloadEtag(
      { ...solution, request_scope_epoch: "instance-1:8" }, "sample_positions",
    )).not.toBe(antennaFieldPayloadEtag(solution, "sample_positions"));
  });
});
