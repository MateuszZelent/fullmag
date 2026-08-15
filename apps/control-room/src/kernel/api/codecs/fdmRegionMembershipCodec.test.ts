import { describe, expect, it, vi } from "vitest";

import {
  decodeFdmRegionMembership,
  FMRM_INACTIVE_REGION_ID,
  FMRM_HEADER_LEN,
  validateFdmNativeLayerRegionMembershipContract,
  validateFdmRegionMembershipContract,
} from "./index";
import { sha256HexBytes } from "./fdmRegionMembershipCodec";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmNativeLayerRegionMembershipResource,
  FdmRegionMembershipResource,
} from "../apiTypes";

function makeBuffer(
  version = 1,
  kind = 1,
  regionIds = [1, 1, 2, 0],
  gridFingerprint = "0".repeat(64),
  legendCount = 2,
): ArrayBuffer {
  const buffer = new ArrayBuffer(FMRM_HEADER_LEN + 4 * 4);
  const view = new DataView(buffer);
  for (const [index, value] of [..."FMRM"].entries()) {
    view.setUint8(index, value.charCodeAt(0));
  }
  view.setUint8(4, version);
  view.setUint8(5, kind);
  view.setUint32(8, 2, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 4, true);
  view.setUint32(24, legendCount, true);
  for (let index = 0; index < 32; index += 1) {
    view.setUint8(28 + index, Number.parseInt(gridFingerprint.slice(index * 2, index * 2 + 2), 16));
  }
  regionIds.forEach((regionId, index) => {
    view.setUint32(FMRM_HEADER_LEN + index * 4, regionId, true);
  });
  return buffer;
}

async function sha256MembershipIds(regionIds: readonly number[]): Promise<string> {
  const bytes = new Uint8Array(regionIds.length * Uint32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  regionIds.forEach((value, index) => {
    view.setUint32(index * Uint32Array.BYTES_PER_ELEMENT, value, true);
  });
  return `sha256:${await sha256HexBytes(bytes)}`;
}

async function sha256Legend(
  regionLegend: FdmNativeLayerRegionMembershipResource["region_legend"],
): Promise<string> {
  return `sha256:${await sha256HexBytes(
    new TextEncoder().encode(JSON.stringify(regionLegend)),
  )}`;
}

const domain: DomainMetaResource = {
  bounds: { min: [0, 0, 0], max: [2, 2, 1] },
  coordinate_system: "cartesian",
  counts: { cells: 4 },
  dimension: 3,
  discretization: "fdm",
  domain_id: "domain:fdm",
  generation_id: "generation-7",
  grid: { origin: [0, 0, 0], shape: [2, 2, 1], spacing: [1, 1, 1] },
  units: { length: "m" },
};

const descriptor: FdmRegionMembershipResource = {
  binary_path: "mesh/fdm_region_membership.v2.bin",
  cell_count: 4,
  cell_m: [1, 1, 1],
  counts: [2, 2, 1],
  domain_generation_id: "generation-7",
  encoding: "FMRM:u32_membership_le",
  freshness: "current",
  grid_fingerprint: "0".repeat(64),
  mesh_revision: 8,
  origin_m: [0, 0, 0],
  region_legend: [
    { numeric_id: 1, object_id: "body", region_id: "body:core", priority: 0 },
    { numeric_id: 2, object_id: "body", region_id: "body:edge", priority: 1 },
  ],
  region_legend_fingerprint:
    "sha256:ec212c4d1737eb80fe4614587aa83ebcf2b38158c9c554568dbb4d71a51bd080",
  region_membership_revision: 9,
  schema_version: "fdm_region_membership.v2",
};

const nativeMaskHash =
  "sha256:5fc6c8102806fb0edd20e2969414cbb77b43e88ff04c0396d0d3c7b331cb6b70";
const nativeDescriptor: FdmNativeLayerRegionMembershipResource = {
  binary_path:
    "/v2/sessions/current/data/domain/fdm-multilayer-layers/layer%3Abottom/region-membership",
  cell_count: 4,
  cell_m: [1, 1, 1],
  counts: [2, 2, 1],
  domain_generation_id: "generation-7",
  encoding: "FMRM:u32_membership_le",
  freshness: "current",
  grid_fingerprint: `sha256:${"0".repeat(64)}`,
  layer_id: "layer:bottom",
  magnet_name: "bottom",
  object_id: "body",
  object_ids: ["body"],
  origin_m: [0, 0, 0],
  region_legend: descriptor.region_legend,
  region_legend_fingerprint: descriptor.region_legend_fingerprint!,
  region_membership_revision: 9,
  schema_version: "fdm_multilayer_region_membership.v1",
};
const nativeLayout = {
  available: true,
  backend: "fdm_multilayer",
  domain_generation_id: "generation-7",
  execution_revision: 4,
  layout_revision: 17,
  observation_revision: 9,
  schema_version: "fdm-multilayer-layout.v1",
  layers: [{
    active_cell_count: 3,
    active_mask_present: true,
    available_material_quantities: ["mat_ms"],
    convolution_cell_size: [1, 1, 1],
    convolution_grid: [2, 2, 1],
    inactive_cell_count: 1,
    layer_id: "layer:bottom",
    magnet_name: "bottom",
    native_cell_size: [1, 1, 1],
    native_grid: [2, 2, 1],
    native_grid_fingerprint: `sha256:${"0".repeat(64)}`,
    native_origin: [0, 0, 0],
    object_id: "body",
    region_legend_hash: descriptor.region_legend_fingerprint,
    region_mask_hash: nativeMaskHash,
    region_membership_available: true,
    region_membership_generation_id: `sha256:${"8".repeat(64)}`,
    region_membership_ref: nativeDescriptor.binary_path,
    region_membership_revision: 9,
    transfer_kind: "identity",
  }],
  airbox: {
    carrier_available: false,
    h_demag_available: false,
    h_eff_available: false,
  },
} as FdmMultilayerLayoutResource;

describe("FMRM codec", () => {
  it("decodes grid identity and numeric region IDs", () => {
    const decoded = decodeFdmRegionMembership(makeBuffer());
    expect(decoded.counts).toEqual([2, 2, 1]);
    expect(decoded.cellCount).toBe(4);
    expect(decoded.legendCount).toBe(2);
    expect(decoded.semanticStatus).toBe("legacy-ambiguous");
    expect([...decoded.regionIds]).toEqual([1, 1, 2, 0]);
    expect(decoded.gridFingerprint).toBe("0".repeat(64));
  });

  it("decodes the backend FMRM v2 active-unassigned and inactive sentinels", () => {
    const decoded = decodeFdmRegionMembership(
      makeBuffer(2, 2, [FMRM_INACTIVE_REGION_ID, 0, 2, 1]),
    );

    expect(decoded.formatVersion).toBe(2);
    expect(decoded.payloadKind).toBe(2);
    expect(decoded.semanticStatus).toBe("canonical");
    expect([...decoded.regionIds]).toEqual([
      FMRM_INACTIVE_REGION_ID,
      0,
      2,
      1,
    ]);
  });

  it("rejects malformed payload lengths", () => {
    expect(() => decodeFdmRegionMembership(makeBuffer().slice(0, 65))).toThrow(
      /cell count mismatch|buffer size mismatch/,
    );
  });

  it("accepts a current FMRM only when binary, descriptor, legend, and domain identities agree", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(decoded, descriptor, domain, {
        expectedGenerationId: "generation-7",
      }),
    ).resolves.toMatchObject({
      generationId: "generation-7",
      gridFingerprint: "0".repeat(64),
      legendFingerprint: descriptor.region_legend_fingerprint,
      status: "ready",
    });
  });

  it("validates native-layer FMRM against its layer-local descriptor and payload hash", async () => {
    const decoded = decodeFdmRegionMembership(
      makeBuffer(2, 2, [1, FMRM_INACTIVE_REGION_ID, 2, 0]),
    );

    await expect(
      validateFdmNativeLayerRegionMembershipContract(
        decoded,
        nativeDescriptor,
        nativeLayout,
        nativeLayout.layers[0]!,
      ),
    ).resolves.toMatchObject({
      generationId: nativeLayout.layers[0]!.region_membership_generation_id,
      layerId: "layer:bottom",
      status: "ready",
    });
    await expect(
      validateFdmNativeLayerRegionMembershipContract(
        decoded,
        { ...nativeDescriptor, layer_id: "layer:top" },
        nativeLayout,
        nativeLayout.layers[0]!,
      ),
    ).resolves.toEqual({ reason: "layer-identity-mismatch", status: "incompatible" });
  });

  it("accepts arbitrary unique positive region IDs in a native-layer FMRM legend", async () => {
    const regionIds = [7, FMRM_INACTIVE_REGION_ID, 11, 0];
    const regionLegend = [
      { ...descriptor.region_legend[0]!, numeric_id: 7 },
      { ...descriptor.region_legend[1]!, numeric_id: 11 },
    ];
    const regionLegendHash = await sha256Legend(regionLegend);
    const regionMaskHash = await sha256MembershipIds(regionIds);
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2, regionIds));
    const layer = {
      ...nativeLayout.layers[0]!,
      region_legend_hash: regionLegendHash,
      region_mask_hash: regionMaskHash,
    };

    await expect(
      validateFdmNativeLayerRegionMembershipContract(
        decoded,
        {
          ...nativeDescriptor,
          region_legend: regionLegend,
          region_legend_fingerprint: regionLegendHash,
        },
        { ...nativeLayout, layers: [layer] },
        layer,
      ),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects native-layer object IDs and legend entries owned by another layer", async () => {
    const regionIds = [1, FMRM_INACTIVE_REGION_ID, 2, 0];
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2, regionIds));
    const foreignLegend = [
      descriptor.region_legend[0]!,
      { ...descriptor.region_legend[1]!, object_id: "body:foreign" },
    ];
    const foreignLegendHash = await sha256Legend(foreignLegend);
    const layer = {
      ...nativeLayout.layers[0]!,
      region_legend_hash: foreignLegendHash,
    };

    await expect(
      validateFdmNativeLayerRegionMembershipContract(
        decoded,
        { ...nativeDescriptor, object_ids: ["body", "body:foreign"] },
        nativeLayout,
        nativeLayout.layers[0]!,
      ),
    ).resolves.toEqual({ reason: "layer-identity-mismatch", status: "incompatible" });
    await expect(
      validateFdmNativeLayerRegionMembershipContract(
        decoded,
        {
          ...nativeDescriptor,
          object_ids: ["body", "body:foreign"],
          region_legend: foreignLegend,
          region_legend_fingerprint: foreignLegendHash,
        },
        { ...nativeLayout, layers: [layer] },
        layer,
      ),
    ).resolves.toEqual({ reason: "layer-identity-mismatch", status: "incompatible" });
  });

  it("validates a canonical legend when the HTTP page has no WebCrypto subtle API", async () => {
    vi.stubGlobal("crypto", {});

    try {
      await expect(
        validateFdmRegionMembershipContract(
          decodeFdmRegionMembership(makeBuffer(2, 2)),
          descriptor,
          domain,
        ),
      ).resolves.toMatchObject({ status: "ready" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects stale and generation-mismatched membership explicitly", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, freshness: "stale" },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "stale-descriptor", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(decoded, descriptor, domain, {
        expectedGenerationId: "generation-8",
      }),
    ).resolves.toMatchObject({ reason: "generation-mismatch", status: "incompatible" });
  });

  it("rejects a descriptor from another domain generation even when its grid is unchanged", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, domain_generation_id: "generation-6" },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "generation-mismatch", status: "incompatible" });
  });

  it("rejects grid and legend identity mismatches instead of exposing partial membership", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(
        { ...decoded, gridFingerprint: "1".repeat(64) },
        descriptor,
        domain,
      ),
    ).resolves.toMatchObject({ reason: "grid-fingerprint-mismatch", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(
        { ...decoded, legendCount: 1 },
        descriptor,
        domain,
      ),
    ).resolves.toMatchObject({ reason: "legend-count-mismatch", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, region_legend_fingerprint: `sha256:${"f".repeat(64)}` },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "legend-fingerprint-mismatch", status: "incompatible" });
  });

  it("rejects descriptor geometry that does not match the active structured grid", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, counts: [4, 1, 1] },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "grid-shape-mismatch", status: "incompatible" });
  });

  it("rejects duplicate legend IDs and binary membership IDs absent from the legend", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        {
          ...descriptor,
          region_legend: [descriptor.region_legend[0]!, descriptor.region_legend[0]!],
        },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "duplicate-legend-id", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(
        { ...decoded, regionIds: new Uint32Array([1, 1, 9, 0]) },
        descriptor,
        domain,
      ),
    ).resolves.toMatchObject({ reason: "unknown-region-id", status: "incompatible" });
  });

  it("accepts a canonical active-unassigned mask when there is no legend to fingerprint", async () => {
    const decoded = decodeFdmRegionMembership(
      makeBuffer(2, 2, [0, 0, FMRM_INACTIVE_REGION_ID, 0], "0".repeat(64), 0),
    );

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, region_legend: [], region_legend_fingerprint: null },
        domain,
      ),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps legacy ambiguous FMRM diagnostics fail-closed", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer());

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        {
          ...descriptor,
          region_legend_fingerprint: null,
          schema_version: "fdm_region_membership.v1",
        },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "legacy-ambiguous", status: "incompatible" });
  });

  it("rejects descriptor schema or encoding that disagrees with canonical FMRM v2", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, schema_version: "fdm_region_membership.v1" },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "descriptor-encoding-mismatch", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        { ...descriptor, encoding: "FMRM:u32_le" },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "descriptor-encoding-mismatch", status: "incompatible" });
  });

  it("rejects legend entries that claim reserved active-unassigned or inactive IDs", async () => {
    const decoded = decodeFdmRegionMembership(makeBuffer(2, 2));

    for (const numericId of [0, FMRM_INACTIVE_REGION_ID]) {
      await expect(
        validateFdmRegionMembershipContract(
          decoded,
          {
            ...descriptor,
            region_legend: [
              { ...descriptor.region_legend[0]!, numeric_id: numericId },
              descriptor.region_legend[1]!,
            ],
          },
          domain,
        ),
      ).resolves.toMatchObject({ reason: "reserved-legend-id", status: "incompatible" });
    }
  });

  it("rejects non-contiguous numeric IDs and invalid authored legend identities", async () => {
    const decoded = decodeFdmRegionMembership(
      makeBuffer(2, 2, [1, 1, 3, 0]),
    );

    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        {
          ...descriptor,
          region_legend: [
            descriptor.region_legend[0]!,
            { ...descriptor.region_legend[1]!, numeric_id: 3 },
          ],
        },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "noncontiguous-legend-id", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        {
          ...descriptor,
          region_legend: [
            { ...descriptor.region_legend[0]!, object_id: "" },
            descriptor.region_legend[1]!,
          ],
        },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "invalid-legend-identity", status: "incompatible" });
    await expect(
      validateFdmRegionMembershipContract(
        decoded,
        {
          ...descriptor,
          region_legend: [
            descriptor.region_legend[0]!,
            {
              ...descriptor.region_legend[1]!,
              object_id: descriptor.region_legend[0]!.object_id,
              region_id: descriptor.region_legend[0]!.region_id,
            },
          ],
        },
        domain,
      ),
    ).resolves.toMatchObject({ reason: "duplicate-legend-identity", status: "incompatible" });
  });
});
