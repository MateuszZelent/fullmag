import { describe, expect, it } from "vitest";

import type { FdmMultilayerLayoutResource } from "../apiTypes";
import {
  decodeFdmMultilayerActiveMask,
  FMBM_HEADER_LEN,
  validateFdmMultilayerActiveMaskContract,
} from "./fdmMultilayerActiveMaskCodec";

const GRID_FINGERPRINT = "1".repeat(64);
const MASK_HASH = "9d1e0e2d9459d06523ad13e28a4093c2316baafe7aec5b25f30eba2e113599c4";

function makeBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(FMBM_HEADER_LEN + 1);
  const view = new DataView(buffer);
  for (const [index, value] of [..."FMBM"].entries()) {
    view.setUint8(index, value.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, 2, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 4, true);
  view.setUint32(24, 1, true);
  view.setBigUint64(28, BigInt(17), true);
  for (let index = 0; index < 32; index += 1) {
    view.setUint8(36 + index, 0x11);
    view.setUint8(
      68 + index,
      Number.parseInt(MASK_HASH.slice(index * 2, index * 2 + 2), 16),
    );
  }
  view.setUint8(FMBM_HEADER_LEN, 0b0000_1101);
  return buffer;
}

const layout = {
  available: true,
  backend: "fdm_multilayer",
  domain_generation_id: "generation-7",
  execution_revision: 4,
  layout_revision: 17,
  observation_revision: 0,
  schema_version: "fdm-multilayer-layout.v1",
  common_transform_layout: null,
  layers: [{
    active_cell_count: 3,
    active_mask_hash: `sha256:${MASK_HASH}`,
    active_mask_present: true,
    convolution_cell_size: [1, 1, 1],
    convolution_grid: [2, 2, 1],
    inactive_cell_count: 1,
    layer_id: "layer:bottom",
    magnet_name: "bottom",
    mask_ref: "/v2/sessions/current/data/domain/fdm-multilayer-layers/layer%3Abottom/active-mask",
    native_cell_size: [1, 1, 1],
    native_grid: [2, 2, 1],
    native_grid_fingerprint: `sha256:${GRID_FINGERPRINT}`,
    native_origin: [0, 0, 0],
    object_id: "bottom",
    transfer_kind: "identity",
  }],
  airbox: {
    carrier_available: false,
    h_demag_available: false,
    h_eff_available: false,
  },
} as FdmMultilayerLayoutResource;

describe("FMBM v1 codec", () => {
  it("decodes the bit-packed z/y/x active mask", () => {
    const decoded = decodeFdmMultilayerActiveMask(makeBuffer());

    expect(decoded.shape).toEqual([2, 2, 1]);
    expect(decoded.cellCount).toBe(4);
    expect(decoded.layoutRevision).toBe(17);
    expect(decoded.gridFingerprint).toBe(GRID_FINGERPRINT);
    expect(decoded.maskHash).toBe(MASK_HASH);
    expect([...decoded.activeMask]).toEqual([1, 0, 1, 1]);
  });

  it("accepts the rounded JSON representation of an unsigned 64-bit layout revision", async () => {
    const buffer = makeBuffer();
    const view = new DataView(buffer);
    const revision = BigInt("17920054460318964829");
    view.setBigUint64(28, revision, true);
    const decoded = decodeFdmMultilayerActiveMask(buffer);

    expect(decoded.layoutRevision).toBe(Number(revision));
    await expect(
      validateFdmMultilayerActiveMaskContract(
        decoded,
        { ...layout, layout_revision: Number(revision) },
        layout.layers[0]!,
      ),
    ).resolves.toEqual({ status: "ready" });
  });

  it("rejects malformed payload sizes", () => {
    expect(() => decodeFdmMultilayerActiveMask(makeBuffer().slice(0, FMBM_HEADER_LEN))).toThrow(
      /payload size mismatch/,
    );
  });

  it("fails closed when layout identity or counts disagree", async () => {
    const decoded = decodeFdmMultilayerActiveMask(makeBuffer());
    const layer = layout.layers[0]!;

    await expect(validateFdmMultilayerActiveMaskContract(decoded, layout, layer)).resolves.toEqual({
      status: "ready",
    });
    await expect(
      validateFdmMultilayerActiveMaskContract(
        { ...decoded, layoutRevision: 18 },
        layout,
        layer,
      ),
    ).resolves.toEqual({ reason: "layout-revision-mismatch", status: "incompatible" });
    await expect(
      validateFdmMultilayerActiveMaskContract(
        { ...decoded, activeMask: new Uint8Array([1, 0, 0, 0]) },
        layout,
        layer,
      ),
    ).resolves.toEqual({ reason: "active-cell-count-mismatch", status: "incompatible" });
  });
});
