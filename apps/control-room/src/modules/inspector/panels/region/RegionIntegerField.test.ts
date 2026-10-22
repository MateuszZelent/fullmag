import { describe, expect, it } from "vitest";

import { parseRegionIntegerText } from "./RegionIntegerField";

describe("region integer field parsing", () => {
  it("keeps empty and incomplete decimal or exponent text uncommittable", () => {
    for (const text of ["", "+", "-", ".", "1e", "1e+"]) {
      expect(parseRegionIntegerText(text)).toMatchObject({
        ok: false,
        status: "incomplete",
      });
    }
  });

  it("accepts finite integer values including signed decimal and exponent forms", () => {
    expect(parseRegionIntegerText("0")).toEqual({ ok: true, value: 0 });
    expect(parseRegionIntegerText("-2")).toEqual({ ok: true, value: -2 });
    expect(parseRegionIntegerText("+2.0e1")).toEqual({ ok: true, value: 20 });
  });

  it("rejects non-integers, units, hexadecimal, and non-finite values", () => {
    for (const text of ["1.5", "1 nm", "0x10", "Infinity", "1e309"]) {
      expect(parseRegionIntegerText(text)).toMatchObject({
        ok: false,
        status: "invalid",
      });
    }
  });

  it("enforces mesh order minimum without restricting ordinary priorities", () => {
    expect(parseRegionIntegerText("0", 1)).toMatchObject({
      ok: false,
      status: "invalid",
    });
    expect(parseRegionIntegerText("1", 1)).toEqual({ ok: true, value: 1 });
    expect(parseRegionIntegerText("-2")).toEqual({ ok: true, value: -2 });
  });
});
