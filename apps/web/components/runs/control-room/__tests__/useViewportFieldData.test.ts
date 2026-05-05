import { describe, expect, it } from "vitest";

import { resolveSelectedLiveField } from "../hooks/useViewportFieldData";

describe("resolveSelectedLiveField", () => {
  it("does not reuse stale binary cache frames when the transport key changed", () => {
    const staleBinaryFrame = {
      key: "m:old",
      quantityId: "m",
      values: new Float64Array([9, 9, 9]),
      nComp: 3,
      grid: [1, 1, 1],
    } as const;

    const result = resolveSelectedLiveField({
      activeQuantityId: "m",
      fieldMap: { m: null },
      selectedScopedBinaryFieldFrame: null,
      scopedFieldTransportKey: null,
      selectedFieldTopologyMismatch: false,
      selectedBinaryFieldFrame: staleBinaryFrame,
      selectedFieldTransportKey: "m:new",
    });

    expect(result).toBeNull();
  });

  it("uses a matching binary frame when it matches the current transport key", () => {
    const freshBinaryValues = new Float64Array([1, 2, 3]);
    const freshBinaryFrame = {
      key: "m:new",
      quantityId: "m",
      values: freshBinaryValues,
      nComp: 3,
      grid: [1, 1, 1],
    } as const;

    const result = resolveSelectedLiveField({
      activeQuantityId: "m",
      fieldMap: { m: null },
      selectedScopedBinaryFieldFrame: null,
      scopedFieldTransportKey: null,
      selectedFieldTopologyMismatch: false,
      selectedBinaryFieldFrame: freshBinaryFrame,
      selectedFieldTransportKey: "m:new",
    });

    expect(result).toBe(freshBinaryValues);
  });

  it("prefers scoped binary frame when scoped transport key matches", () => {
    const scopedValues = new Float64Array([4, 5, 6]);
    const scopedFrame = {
      key: "m:scoped",
      quantityId: "m",
      values: scopedValues,
      nComp: 3,
      grid: [1, 1, 1],
      activeMask: null,
      scopes: [],
    } as const;

    const result = resolveSelectedLiveField({
      activeQuantityId: "m",
      fieldMap: { m: new Float64Array([7, 8, 9]) },
      selectedScopedBinaryFieldFrame: scopedFrame as any,
      scopedFieldTransportKey: "m:scoped",
      selectedFieldTopologyMismatch: false,
      selectedBinaryFieldFrame: null,
      selectedFieldTransportKey: null,
    });

    expect(result).toBe(scopedValues);
  });
});
