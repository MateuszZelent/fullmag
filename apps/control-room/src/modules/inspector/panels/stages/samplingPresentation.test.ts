import { describe, expect, it } from "vitest";

import { formatEditableNumber, formatEngineering } from "./samplingPresentation";

describe("formatEngineering", () => {
  it("uses concise SI prefixes for time, frequency, and field values", () => {
    expect(formatEngineering(50e-12, "s")).toBe("50 ps");
    expect(formatEngineering(40e9, "Hz")).toBe("40 GHz");
    expect(formatEngineering(1e-3, "T")).toBe("1 mT");
  });

  it("uses scientific notation outside the supported SI prefix range", () => {
    expect(formatEngineering(1e-18, "s")).toBe("1.000e-18 s");
  });

  it("keeps SI input values concise and directly editable", () => {
    expect(formatEditableNumber(5e9)).toBe("5e9");
    expect(formatEditableNumber(50e-12)).toBe("5e-11");
    expect(formatEditableNumber(0.02)).toBe("0.02");
  });
});
