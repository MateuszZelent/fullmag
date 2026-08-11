import { describe, expect, it } from "vitest";

import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";
import { DATA_DOMAIN_FDM_MULTILAYER_LAYER_ACTIVE_MASK_PATH } from "@/kernel/api/apiPaths";

import {
  adaptFdmMultilayerAirboxDomain,
  adaptFdmMultilayerNativeLayerDomains,
  resolveFdmNativeLayerActiveMaskForRendering,
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
      native_grid_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      native_grid_fingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      convolution_grid: [16, 12, 8],
      convolution_cell_size: [1e-9, 1e-9, 1e-9],
      transfer_kind: "push_pull",
      active_mask_present: true,
      active_cell_count: 160,
      inactive_cell_count: 32,
      active_mask_hash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mask_ref:
        DATA_DOMAIN_FDM_MULTILAYER_LAYER_ACTIVE_MASK_PATH.replace(
          "{layer_id}",
          encodeURIComponent("layer:b"),
        ),
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

  it("fails closed for malformed mask declarations and inconsistent counts", () => {
    expect(
      adaptFdmMultilayerNativeLayerDomains(
        {
          ...layout,
          layers: [
            {
              ...layout.layers[1],
              active_cell_count: 192,
              inactive_cell_count: 0,
              active_mask_hash: null,
              mask_ref: null,
            },
          ],
        },
        10_000,
      ),
    ).toEqual([]);
    expect(
      adaptFdmMultilayerNativeLayerDomains(
        {
          ...layout,
          layers: [
            {
              ...layout.layers[0],
              active_cell_count: 63,
              inactive_cell_count: 1,
            },
          ],
        },
        10_000,
      ),
    ).toEqual([]);
  });

  it("requires a compatible materialized FMBM even when a declared mask is dense", () => {
    const maskedDenseLayer = {
      ...layout.layers[1],
      active_cell_count: 192,
      inactive_cell_count: 0,
    };
    const [domain] = adaptFdmMultilayerNativeLayerDomains(
      {
        ...layout,
        layers: [maskedDenseLayer],
      },
      10_000,
    );
    expect(domain).toBeDefined();
    expect(
      resolveFdmNativeLayerActiveMaskForRendering(
        domain!,
        layout.layout_revision,
        maskedDenseLayer,
        null,
      ),
    ).toBeNull();
    const decoded = {
      activeMask: new Uint8Array(192).fill(1),
      cellCount: 192,
      gridFingerprint: "c".repeat(64),
      layoutRevision: layout.layout_revision,
      maskHash: "b".repeat(64),
      packedMask: new Uint8Array(24).fill(0xff),
      shape: [12, 8, 2] as [number, number, number],
    };
    expect(
      resolveFdmNativeLayerActiveMaskForRendering(
        domain!,
        layout.layout_revision,
        maskedDenseLayer,
        decoded,
      ),
    ).toBe(decoded.activeMask);
    expect(
      resolveFdmNativeLayerActiveMaskForRendering(
        domain!,
        layout.layout_revision + 1,
        maskedDenseLayer,
        decoded,
      ),
    ).toBeNull();
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
