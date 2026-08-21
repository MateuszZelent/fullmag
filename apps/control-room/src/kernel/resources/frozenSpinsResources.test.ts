import { describe, expect, it } from "vitest";

import { DATA_FROZEN_SPINS_RESOLVED_MASK_PATH } from "../api/apiPaths";

import {
  decodeFrozenSpinsMask,
  frozenSpinsDefinitionResourceKey,
  frozenSpinsMaskIdFromResource,
  frozenSpinsMaskResourceKey,
} from "./frozenSpinsResources";

function fmsk(bits: readonly boolean[]): ArrayBuffer {
  const bytes = new Uint8Array(64 + Math.ceil(bits.length / 8));
  bytes.set([0x46, 0x4d, 0x53, 0x4b, 1, 1]);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, BigInt(bits.length), true);
  view.setBigUint64(16, BigInt(7), true);
  view.setBigUint64(24, BigInt(11), true);
  bytes.fill(0xab, 32, 64);
  bits.forEach((frozen, index) => {
    if (frozen) bytes[64 + Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  return bytes.buffer;
}

describe("frozenSpinsResources", () => {
  it("builds encoded canonical resource identities", () => {
    expect(frozenSpinsDefinitionResourceKey("edge/a")).toContain("edge%2Fa");
    expect(frozenSpinsMaskResourceKey("mask/a")).toContain("mask%2Fa");
    expect(
      frozenSpinsMaskIdFromResource(
        DATA_FROZEN_SPINS_RESOLVED_MASK_PATH.replace("{mask_id}", "mask%2Fa"),
      ),
    ).toBe("mask/a");
    expect(frozenSpinsMaskIdFromResource("/unrelated/mask-a")).toBeNull();
  });

  it("decodes the versioned LSB-first FMSK payload", () => {
    const decoded = decodeFrozenSpinsMask(
      fmsk([true, false, true, false, false, false, false, false, true]),
    );
    expect([...decoded.frozenIndices]).toEqual([0, 2, 8]);
    expect(decoded).toMatchObject({
      bitCount: 9,
      sceneRevision: 7,
      sourceStateRevision: 11,
    });
    expect(decoded.maskSha256).toBe(`sha256:${"ab".repeat(32)}`);
  });

  it("fails closed on malformed binary payloads", () => {
    expect(() => decodeFrozenSpinsMask(new Uint8Array(64).buffer)).toThrow(
      /magic/,
    );
    expect(() => decodeFrozenSpinsMask(fmsk([true]).slice(0, 64))).toThrow(
      /length/,
    );
  });
});
