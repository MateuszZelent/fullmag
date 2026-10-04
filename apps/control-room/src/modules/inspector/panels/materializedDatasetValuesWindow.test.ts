import { describe, expect, it } from "vitest";

import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";

import { savedFieldValuesWindow } from "./materializedDatasetValuesWindow";

const coverage: MaterializedDatasetResource["field"]["coverage"] = {
  total_elements: "9007199254740993", component_count: "3", dtype: "f64",
  endian: "little", total_bytes: "216172782113783832", chunk_count: "1",
};

describe("saved field numeric window admission", () => {
  it("preserves total element counters beyond Number precision", () => {
    expect(savedFieldValuesWindow(coverage)).toEqual({ pageSize: BigInt(32), total: BigInt("9007199254740993") });
  });
  it("reduces element count to fit all components and refuses oversized elements", () => {
    expect(savedFieldValuesWindow({ ...coverage, component_count: "4096" })?.pageSize).toBe(BigInt(2));
    expect(savedFieldValuesWindow({ ...coverage, component_count: "8193" })).toBeNull();
  });
  it("rejects malformed counters without throwing during render", () => {
    for (const value of ["", "NaN", "0", "-1", "01", "1.5", "18446744073709551616", "9".repeat(1000)]) {
      expect(savedFieldValuesWindow({ ...coverage, component_count: value })).toBeNull();
      expect(savedFieldValuesWindow({ ...coverage, total_elements: value })).toBeNull();
    }
  });
  it("does not reinterpret integer storage as floating-point values", () => {
    expect(savedFieldValuesWindow({ ...coverage, dtype: "i32" })).toBeNull();
  });
});
