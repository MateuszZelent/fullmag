import { describe, expect, it } from "vitest";
import { formatModeWavevector, modeResultLabel } from "./modeResultPresentation";

describe("physical mode labels", () => {
  it("distinguishes Gamma, both signs and a general vector", () => {
    expect(formatModeWavevector([0, 0, 0])).toBe("Γ · k = 0");
    expect(formatModeWavevector([0, -5e6, 0])).toBe("kᵧ = -5 rad/µm");
    expect(formatModeWavevector([0, 5e6, 0])).toBe("kᵧ = +5 rad/µm");
    expect(formatModeWavevector([1e6, -2e6, 3e6])).toBe("k = (1, -2, 3) rad/µm");
    expect(formatModeWavevector([0, 0, 3e6])).toBe("kz = +3 rad/µm");
  });
  it("does not turn missing or tiny k into Gamma", () => {
    for (const k of [null, [], [0, null, 0], [0, Infinity, 0]]) expect(formatModeWavevector(k)).toBe("Wavevector not published");
    expect(formatModeWavevector([0, 1e-10, 0])).not.toContain("Γ");
  });
  it("keeps physical frequency in the human label", () => {
    expect(modeResultLabel([0, -5e6, 0], 10.310201976e9)).toBe("kᵧ = -5 rad/µm · 10.31 GHz");
  });
});
