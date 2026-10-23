import { describe, expect, it } from "vitest";

import { parsePlanarNumberText } from "./planarNumberModel";

describe("parsePlanarNumberText", () => {
  it("accepts finite decimal and exponent notation", () => {
    expect(parsePlanarNumberText("-1.25e+2")).toEqual({ ok: true, value: -125 });
    expect(parsePlanarNumberText(".5")).toEqual({ ok: true, value: 0.5 });
    expect(parsePlanarNumberText("1.")).toEqual({ ok: true, value: 1 });
  });

  it.each(["", "+", "-", ".", "+.", "1e", "1e+", "1e-"])(
    "preserves incomplete input %j",
    (text) => {
      expect(parsePlanarNumberText(text)).toMatchObject({
        ok: false,
        status: "incomplete",
      });
    },
  );

  it.each(["0x10", "12 kg", "1,5", "Infinity", "NaN", "1e999"])(
    "rejects non-decimal or non-finite input %j",
    (text) => {
      expect(parsePlanarNumberText(text)).toMatchObject({
        ok: false,
        status: "invalid",
      });
    },
  );

  it("keeps inclusive zero and enforces inclusive/exclusive bounds", () => {
    expect(parsePlanarNumberText("0", { minimum: 0 })).toEqual({
      ok: true,
      value: 0,
    });
    expect(parsePlanarNumberText("0", { minimum: 0, minimumExclusive: true })).toMatchObject({
      ok: false,
      status: "invalid",
    });
    expect(parsePlanarNumberText("2", { minimum: 0, maximum: 1 })).toMatchObject({
      ok: false,
      status: "invalid",
    });
  });

  it("enforces integer input without rounding", () => {
    expect(parsePlanarNumberText("16", { integer: true, minimum: 16 })).toEqual({
      ok: true,
      value: 16,
    });
    expect(parsePlanarNumberText("16.5", { integer: true })).toMatchObject({
      ok: false,
      status: "invalid",
    });
  });
});
