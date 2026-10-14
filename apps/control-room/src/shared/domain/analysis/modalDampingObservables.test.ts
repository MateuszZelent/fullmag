import { describe, expect, it } from "vitest";

import { modalDampingObservables, resolveModalPhasorConvention } from "./modalDampingObservables";

describe("modalDampingObservables", () => {
  it.each([
    ["exp_i_omega_t", 2],
    ["exp_minus_i_omega_t", -2],
  ] as const)(
    "maps %s eigenfrequency imaginary part to positive decay",
    (phaseConvention, imaginaryFrequencyHz) => {
      const result = modalDampingObservables(
        10,
        imaginaryFrequencyHz,
        phaseConvention,
      );
      expect(result).toMatchObject({
        decayRateHz: 2,
        stability: "decaying",
        linewidthFwhmHz: 4,
        qualityFactor: 2.5,
      });
      expect(result.lifetimeSeconds).toBeCloseTo(1 / (4 * Math.PI), 15);
    },
  );

  it.each([2, -2, 0, -0])("preserves every observable for the published positive alias (%s)", (imaginaryHz) => {
    expect(modalDampingObservables(10, imaginaryHz, "exp_plus_i_omega_t")).toEqual(
      modalDampingObservables(10, imaginaryHz, "exp_i_omega_t"),
    );
  });

  it("retains signed growth without producing linewidth, Q, or lifetime", () => {
    expect(modalDampingObservables(10, -2, "exp_i_omega_t")).toEqual({
      decayRateHz: -2,
      stability: "growing",
      linewidthFwhmHz: null,
      qualityFactor: null,
      lifetimeSeconds: null,
    });
  });

  it("keeps non-oscillating decay and lifetime without resonance observables", () => {
    const result = modalDampingObservables(0, 2, "exp_i_omega_t");
    expect(result).toMatchObject({
      decayRateHz: 2,
      stability: "decaying",
      linewidthFwhmHz: null,
      qualityFactor: null,
    });
    expect(result.lifetimeSeconds).toBeCloseTo(1 / (4 * Math.PI), 15);
  });

  it("reports an undamped oscillator with zero linewidth and unavailable Q", () => {
    expect(modalDampingObservables(-10, 0, "exp_minus_i_omega_t")).toEqual({
      decayRateHz: 0,
      stability: "undamped",
      linewidthFwhmHz: 0,
      qualityFactor: null,
      lifetimeSeconds: null,
    });
  });

  it.each([
    ["exp_i_omega_t", 0],
    ["exp_i_omega_t", -0],
    ["exp_minus_i_omega_t", 0],
    ["exp_minus_i_omega_t", -0],
  ] as const)("canonicalizes undamped zero for %s and %s", (phasor, zero) => {
    const result = modalDampingObservables(10, zero, phasor);
    expect(result.decayRateHz).toBe(0);
    expect(result.linewidthFwhmHz).toBe(0);
    expect(result.stability).toBe("undamped");
    expect(result.qualityFactor).toBeNull();
    expect(result.lifetimeSeconds).toBeNull();
  });

  it("makes missing, unknown, and nonfinite inputs unavailable", () => {
    const unavailable = {
      decayRateHz: null,
      stability: "not available",
      linewidthFwhmHz: null,
      qualityFactor: null,
      lifetimeSeconds: null,
    };
    const expectUnavailable = (
      realFrequencyHz: number | null,
      imaginaryFrequencyHz: number | null,
      phaseConvention: string | null,
    ) => {
      expect(
        modalDampingObservables(
          realFrequencyHz,
          imaginaryFrequencyHz,
          phaseConvention,
        ),
      ).toEqual(unavailable);
    };

    expectUnavailable(null, 2, "exp_i_omega_t");
    expectUnavailable(10, null, "exp_i_omega_t");
    expectUnavailable(10, 2, null);
    expectUnavailable(10, 2, "exp(-i omega t)");
    expectUnavailable(10, 2, "exp_i_omega_t_extra");
    expectUnavailable(Number.NaN, 2, "exp_i_omega_t");
    expectUnavailable(Number.POSITIVE_INFINITY, 2, "exp_i_omega_t");
    expectUnavailable(10, Number.POSITIVE_INFINITY, "exp_i_omega_t");
    expectUnavailable(10, Number.NEGATIVE_INFINITY, "exp_minus_i_omega_t");
  });

  it("keeps finite lifetime while unavailable overflowed linewidth and Q stay null", () => {
    const largeDecay = modalDampingObservables(
      10,
      Number.MAX_VALUE,
      "exp_i_omega_t",
    );
    expect(largeDecay.decayRateHz).toBe(Number.MAX_VALUE);
    expect(largeDecay.stability).toBe("decaying");
    expect(largeDecay.linewidthFwhmHz).toBeNull();
    expect(largeDecay.qualityFactor).toBeNull();
    expect(largeDecay.lifetimeSeconds).toBeGreaterThan(0);
    expect(Number.isFinite(largeDecay.lifetimeSeconds)).toBe(true);

    const overflowingQuality = modalDampingObservables(
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      "exp_i_omega_t",
    );
    expect(overflowingQuality.linewidthFwhmHz).toBe(2 * Number.MIN_VALUE);
    expect(overflowingQuality.qualityFactor).toBeNull();
    expect(overflowingQuality.lifetimeSeconds).toBeNull();
  });
});

describe("selected modal phasor provenance", () => {
  it("computes decay for a positive-alias mode in a mixed sweep", () => {
    const convention = resolveModalPhasorConvention(
      { phasor_convention: "exp_plus_i_omega_t" }, { phase_convention: "mixed" },
    );
    expect(modalDampingObservables(10, 2, convention)).toMatchObject({
      stability: "decaying", decayRateHz: 2, linewidthFwhmHz: 4, qualityFactor: 2.5,
    });
  });
  it("keeps the selected negative convention even when the manifest is positive", () => {
    const convention = resolveModalPhasorConvention(
      { metadata: { phasor_convention: "exp_minus_i_omega_t" } },
      { phase_convention: "exp_i_omega_t" },
    );
    expect(modalDampingObservables(10, 2, convention)).toMatchObject({
      stability: "growing", decayRateHz: -2, linewidthFwhmHz: null,
    });
  });
  it.each([null, false, "unknown", "not_applicable_real_reference"])(
    "does not replace explicit unsupported mode convention %s with a manifest sign",
    (phasor_convention) => {
      const convention = resolveModalPhasorConvention(
        { phasor_convention }, { phase_convention: "exp_i_omega_t" },
      );
      expect(modalDampingObservables(10, 2, convention).stability).toBe("not available");
    },
  );
  it("preserves the legacy homogeneous manifest without inventing a mixed sign", () => {
    expect(resolveModalPhasorConvention({}, { phase_convention: "exp_plus_i_omega_t" }))
      .toBe("exp_plus_i_omega_t");
    expect(resolveModalPhasorConvention(null, { phase_convention: "mixed" })).toBeNull();
  });
});
