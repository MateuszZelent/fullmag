import { describe, expect, it } from "vitest";
import { parseSelectionNumber, parseSelectionVector } from "./selectionNumericInput";

describe("selection numeric input", () => {
  it.each(["", " ", "-", ".", "1e", "1e-"])("retains incomplete scalar %j", (text) => {
    expect(parseSelectionNumber(text)).toMatchObject({ ok: false, status: "incomplete" });
  });
  it.each(["Infinity", "NaN", "1e999", "0x10", "2x"])("rejects invalid scalar %j", (text) => {
    expect(parseSelectionNumber(text)).toMatchObject({ ok: false, status: "invalid" });
  });
  it("preserves explicit zero and scientific notation with bounds", () => {
    expect(parseSelectionNumber("0", 0)).toEqual({ ok: true, value: 0 });
    expect(parseSelectionNumber("-2.5e-9")).toEqual({ ok: true, value: -2.5e-9 });
    expect(parseSelectionNumber("-1", 0)).toMatchObject({ ok: false });
    expect(parseSelectionNumber("2", 0, 1)).toMatchObject({ ok: false });
  });
  it.each(["1, ,3", "x,2,3", "1,2", "1,2,3,4", "1,Infinity,3"])("never drops or coerces vector components in %j", (text) => {
    expect(parseSelectionVector(text, 3)).toMatchObject({ ok: false });
  });
  it("requires three vector and four quaternion components", () => {
    expect(parseSelectionVector("0, -2e-9, 3", 3)).toEqual({ ok: true, value: [0, -2e-9, 3] });
    expect(parseSelectionVector("0,0,0,1", 4)).toEqual({ ok: true, value: [0, 0, 0, 1] });
    expect(parseSelectionVector("0,0,1", 4)).toMatchObject({ ok: false });
  });
});
