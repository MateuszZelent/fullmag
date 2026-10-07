import { describe, expect, it } from "vitest";

import type { AntennaFieldSolutionResource } from "@/kernel/api/apiTypes";

import {
  decodeFieldBasisPreview,
  fieldBasisPreviewCount,
  fieldBasisSamplingDomain,
  MAX_FIELD_BASIS_PREVIEW_SAMPLES,
  selectedFieldBasisPort,
} from "./AntennaFieldBasisPreviewModel";

const solution = {
  sample_positions: {
    layout: "sample_xyz_interleaved",
    scalar_type: "float64_le",
    unit: "m",
    value_count: 30,
  },
  bases: [{
    magnetic_field_per_ampere: {
      layout: "sample_xyz_interleaved",
      scalar_type: "float64_le",
      unit: "A/m/A",
      value_count: 30,
    },
  }],
} as AntennaFieldSolutionResource;

function encoded(values: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * 8);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return buffer;
}

describe("bounded antenna field basis preview", () => {
  it("reports the authored sampling domain and keeps legacy provenance explicit", () => {
    expect(fieldBasisSamplingDomain(solution)).toBe("Unrecorded (legacy asset)");
    const carrier = {
      carrier_kind: "fem_mesh_asset:magnet", location: "node",
      topology_digest: `sha256:${"4".repeat(64)}`,
    };
    expect(fieldBasisSamplingDomain({ ...solution, sample_carrier: {
      ...carrier, domain: { kind: "object", object_id: "magnet" },
    } })).toBe("Object: magnet");
    expect(fieldBasisSamplingDomain({ ...solution, sample_carrier: {
      ...carrier, domain: { kind: "global" },
    } })).toBe("Global domain");
    expect(fieldBasisSamplingDomain({ ...solution, sample_carrier: {
      ...carrier, domain: { kind: "region", object_id: "magnet", region_id: "film" },
    } })).toBe("Region: magnet/film");
  });
  it("falls back to a port in the new solution after the selected antenna changes", () => {
    const first = { ...solution, bases: [{ ...solution.bases[0], port_mode_id: "port-a" }] };
    const second = { ...solution, bases: [{ ...solution.bases[0], port_mode_id: "port-b" }] };
    expect(selectedFieldBasisPort(first, "port-a")).toBe("port-a");
    expect(selectedFieldBasisPort(second, "port-a")).toBe("port-b");
    expect(selectedFieldBasisPort({ ...solution, bases: [] }, "port-a")).toBe("");
  });

  it("limits the request to eight complete vectors without relabeling H as B", () => {
    expect(fieldBasisPreviewCount(solution, solution.bases[0])).toBe(MAX_FIELD_BASIS_PREVIEW_SAMPLES);
    const samples = decodeFieldBasisPreview(
      encoded([1e-9, 2e-9, 3e-9, 4e-9, 5e-9, 6e-9]),
      encoded([1, -2, 3, 4, -5, 6]),
      2,
    );
    expect(samples).toEqual([
      { positionM: [1e-9, 2e-9, 3e-9], fieldApmPerA: [1, -2, 3] },
      { positionM: [4e-9, 5e-9, 6e-9], fieldApmPerA: [4, -5, 6] },
    ]);
  });

  it("rejects incompatible carriers, truncated ranges and non-finite values", () => {
    expect(() => fieldBasisPreviewCount(
      { ...solution, sample_positions: { ...solution.sample_positions, unit: "mm" } },
      solution.bases[0],
    )).toThrow(/incompatible/);
    expect(() => decodeFieldBasisPreview(encoded([1, 2, 3]), encoded([4, 5]), 1))
      .toThrow(/byte range/);
    expect(() => decodeFieldBasisPreview(encoded([1, 2, 3]), encoded([4, Number.NaN, 6]), 1))
      .toThrow(/non-finite/);
  });
});
