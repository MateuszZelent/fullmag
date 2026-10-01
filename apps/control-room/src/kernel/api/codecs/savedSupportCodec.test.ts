import { describe, expect, it } from "vitest";
import { decodeSavedSupport, savedSupportByteLimit, savedSupportNodeIsActive } from "./savedSupportCodec";

async function fixture() {
  const buffer = new ArrayBuffer(26);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set([70, 77, 83, 80]);
  view.setUint16(4, 1, true);
  view.setBigUint64(8, BigInt(9), true);
  view.setBigUint64(16, BigInt(2), true);
  new Uint8Array(buffer, 24).set([5, 1]);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  return { buffer, expected: { nodeCount: "9", byteLength: "26", sha256 } };
}

describe("saved FEM support integrity", () => {
  it("keeps canonical-node support separate from constraint masks", async () => {
    const { buffer, expected } = await fixture();
    const support = await decodeSavedSupport(buffer, expected);
    expect([0, 1, 2, 8].map((node) => savedSupportNodeIsActive(support, node))).toEqual([true, false, true, true]);
    expect(() => savedSupportNodeIsActive(support, 9)).toThrow();
  });
  it("rejects altered bytes and nonzero padding even with matching SHA", async () => {
    const { buffer, expected } = await fixture();
    new Uint8Array(buffer)[24] = 4;
    await expect(decodeSavedSupport(buffer, expected)).rejects.toThrow(/checksum/);
    const padding = await fixture();
    new Uint8Array(padding.buffer)[25] = 3;
    const paddingHash = await crypto.subtle.digest("SHA-256", padding.buffer);
    padding.expected.sha256 = Array.from(new Uint8Array(paddingHash), (value) => value.toString(16).padStart(2, "0")).join("");
    await expect(decodeSavedSupport(padding.buffer, padding.expected)).rejects.toThrow(/padding/);
  });
  it("rejects foreign extent, noncanonical counters and oversized budgets", async () => {
    const { buffer, expected } = await fixture();
    await expect(decodeSavedSupport(buffer, { ...expected, nodeCount: "10" })).rejects.toThrow(/header/);
    expect(() => savedSupportByteLimit({ ...expected, nodeCount: "09" })).toThrow();
    expect(() => savedSupportByteLimit({ ...expected, nodeCount: "18446744073709551615" })).toThrow();
  });
});
