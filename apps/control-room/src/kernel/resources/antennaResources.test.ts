import { describe, expect, it } from "vitest";

import type { AntennaSourceSpectrumResource, BinaryResourceResult } from "../api/apiTypes";

import {
  antennaSpectrumPayloadEtag,
  requireMatchingAntennaPayloadRevision,
} from "./antennaResources";

describe("antenna source-spectrum payload identity", () => {
  const spectrum = {
    session_id: "session-1",
    session_epoch: "epoch-2",
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
      '"antenna-source-spectrum-payload:session-1:epoch-2:spectrum-3:power:sha256:manifest-4:sha256:power-8"',
    );
    expect(antennaSpectrumPayloadEtag(
      { ...spectrum, content_digest: "sha256:new-manifest" }, "power",
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
