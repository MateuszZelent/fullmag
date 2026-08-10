import { describe, expect, it } from "vitest";

import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";

import { resolveFdmMultilayerAirboxTarget } from "./fdmMultilayerAirboxTarget";

const validLayout = {
  airbox: {
    carrier_available: true,
    carrier_fingerprint:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    cell_size_m: [2e-9, 3e-9, 4e-9],
    cells: [5, 4, 3],
    h_demag_available: true,
    h_eff_available: false,
    origin_m: [-4e-9, -6e-9, -8e-9],
    sample_count: 60,
    target_only: true,
    value_count: 180,
  },
  available: true,
  backend: "fdm_multilayer",
  domain_generation_id: "generation-7",
  execution_revision: 3,
  layers: [],
  layout_revision: 5,
  observation_revision: 6,
  schema_version: "fdm-multilayer-layout.v1",
} satisfies FdmMultilayerLayoutResource;

describe("resolveFdmMultilayerAirboxTarget", () => {
  it("accepts a target carrier bound to a concrete generation", () => {
    expect(resolveFdmMultilayerAirboxTarget(validLayout)).toMatchObject({
      cells: [5, 4, 3],
      carrierFingerprint:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      sampleCount: 60,
      valueCount: 180,
    });
  });

  it.each(["", "   ", "\t", " generation-7", "generation-7 ", null, 7, { malformed: true }])(
    "fails closed for malformed domain generation %j",
    (domainGenerationId) => {
      expect(
        resolveFdmMultilayerAirboxTarget({
          ...validLayout,
          domain_generation_id: domainGenerationId as never,
        }),
      ).toBeNull();
    },
  );
});
