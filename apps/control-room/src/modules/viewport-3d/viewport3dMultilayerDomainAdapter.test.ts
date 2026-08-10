import { describe, expect, it } from "vitest";

import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";

import {
  adaptFdmMultilayerAirboxDomain,
  adaptFdmMultilayerNativeLayerDomains,
  resolveFdmMultilayerAirboxFieldAvailability,
} from "./viewport3dDomainAdapter";

const layout = {
  schema_version: "fdm-multilayer-layout.v1",
  domain_generation_id: "domain-1",
  available: true,
  unavailable_reason: null,
  backend: "fdm_multilayer",
  layout_revision: 3,
  observation_revision: 4,
  execution_revision: 5,
  layout_fingerprint: "sha256:layout",
  strategy: "multilayer_convolution",
  requested_mode: "auto",
  resolved_mode: "three_d",
  common_transform_layout: {
    shape: [16, 12, 8],
    cell_size: [1e-9, 1e-9, 1e-9],
    origin: [0, 0, 0],
    fft_shape: [32, 24, 16],
    is_physical_mesh: false,
    provenance: "planner.grid_certificate;fft-scratch-only",
  },
  layers: [
    {
      layer_id: "layer:a",
      object_id: "object:a",
      magnet_name: "bottom",
      native_grid: [8, 8, 1],
      native_cell_size: [1e-9, 1e-9, 2e-9],
      native_origin: [0, 0, -2e-9],
      native_grid_fingerprint: "sha256:native-a",
      convolution_grid: [16, 12, 8],
      convolution_cell_size: [1e-9, 1e-9, 1e-9],
      transfer_kind: "push_pull",
      active_mask_present: false,
      active_cell_count: 64,
      inactive_cell_count: 0,
      mask_provenance: null,
    },
    {
      layer_id: "layer:b",
      object_id: "object:b",
      magnet_name: "top",
      native_grid: [12, 8, 2],
      native_cell_size: [0.5e-9, 0.5e-9, 2e-9],
      native_origin: [0, 0, 0],
      native_grid_fingerprint: "sha256:native-b",
      convolution_grid: [16, 12, 8],
      convolution_cell_size: [1e-9, 1e-9, 1e-9],
      transfer_kind: "push_pull",
      active_mask_present: true,
      active_cell_count: 160,
      inactive_cell_count: 32,
      mask_provenance: "execution_plan.layers.native_active_mask",
    },
  ],
  airbox: {
    carrier_available: false,
    h_demag_available: true,
    h_eff_available: false,
    h_eff_unavailable_reason: "airbox_heff_not_available_v1",
  },
} satisfies FdmMultilayerLayoutResource;

describe("FDM multilayer viewport domain adapter", () => {
  it("renders each native layer as a separate physical carrier", () => {
    const domains = adaptFdmMultilayerNativeLayerDomains(layout, 10_000);
    expect(domains).toHaveLength(2);
    expect(domains.map((domain) => domain.layerId)).toEqual(["layer:a", "layer:b"]);
    expect(domains[0].kind).toBe("fdm-native-layer");
    expect(domains[0].activeCellCount).toBe(64);
    expect(domains[1].inactiveCellCount).toBe(32);
    expect(domains[0].origin[2]).toBe(-2e-9);
    expect(domains[1].shape).toEqual([12, 8, 2]);
  });

  it("does not synthesize a common-grid or airbox carrier", () => {
    const unavailable = adaptFdmMultilayerNativeLayerDomains(
      { ...layout, available: false },
      10_000,
    );
    expect(unavailable).toEqual([]);
    expect(resolveFdmMultilayerAirboxFieldAvailability(layout)).toEqual({
      hDemagAvailable: true,
      hEffAvailable: false,
      reason: "airbox_heff_not_available_v1",
    });
  });

  it("adapts only a validated target-only Airbox carrier, never the common FFT grid", () => {
    const targetOnly = adaptFdmMultilayerAirboxDomain(
      {
        ...layout,
        airbox: {
          carrier_available: true,
          carrier_fingerprint:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          cell_size_m: [2e-9, 3e-9, 4e-9],
          cells: [5, 4, 3],
          h_demag_available: true,
          h_eff_available: false,
          h_eff_unavailable_reason: "airbox_heff_not_available_v1",
          origin_m: [-4e-9, -6e-9, -8e-9],
          sample_count: 60,
          target_only: true,
          value_count: 180,
        },
      },
      10_000,
    );

    expect(targetOnly).toMatchObject({
      carrierFingerprint:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      kind: "fdm-multilayer-airbox",
      origin: [-4e-9, -6e-9, -8e-9],
      shape: [5, 4, 3],
      spacing: [2e-9, 3e-9, 4e-9],
      totalCells: 60,
    });
    expect(targetOnly?.bounds?.center).toEqual([
      expect.closeTo(1e-9, 20),
      0,
      expect.closeTo(-2e-9, 20),
    ]);
    expect(targetOnly?.bounds?.size).toEqual([
      expect.closeTo(10e-9, 20),
      expect.closeTo(12e-9, 20),
      expect.closeTo(12e-9, 20),
    ]);
    expect(targetOnly?.shape).not.toEqual(layout.common_transform_layout.shape);
  });

  it.each([
    ["absent", { ...layout, airbox: { ...layout.airbox, carrier_available: false } }],
    [
      "stale or incomplete",
      {
        ...layout,
        airbox: {
          carrier_available: true,
          carrier_fingerprint: "sha256:stale",
          cell_size_m: [1e-9, 1e-9, 1e-9],
          cells: [2, 2, 1],
          h_demag_available: true,
          h_eff_available: false,
          origin_m: [0, 0, 0],
          sample_count: 3,
          target_only: true,
          value_count: 9,
        },
      },
    ],
    [
      "H_eff advertised",
      {
        ...layout,
        airbox: { ...layout.airbox, h_eff_available: true },
      },
    ],
  ] as const)("fails closed for %s Airbox carrier", (_label, candidate) => {
    expect(
      adaptFdmMultilayerAirboxDomain(
        candidate as FdmMultilayerLayoutResource,
        10_000,
      ),
    ).toBeNull();
  });

  it.each(["", "   ", null, 7, { malformed: true }])(
    "fails closed for malformed Airbox domain generation %j",
    (domainGenerationId) => {
      expect(
        adaptFdmMultilayerAirboxDomain(
          {
            ...layout,
            domain_generation_id: domainGenerationId as never,
            airbox: {
              carrier_available: true,
              carrier_fingerprint:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              cell_size_m: [2e-9, 3e-9, 4e-9],
              cells: [5, 4, 3],
              h_demag_available: true,
              h_eff_available: false,
              h_eff_unavailable_reason: "airbox_heff_not_available_v1",
              origin_m: [-4e-9, -6e-9, -8e-9],
              sample_count: 60,
              target_only: true,
              value_count: 180,
            },
          } as FdmMultilayerLayoutResource,
          10_000,
        ),
      ).toBeNull();
    },
  );
});
