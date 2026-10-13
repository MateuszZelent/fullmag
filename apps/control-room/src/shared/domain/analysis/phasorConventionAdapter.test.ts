import { describe, expect, it } from "vitest";
import {
  floquetPhaseAdapter,
  phasorAdapter,
} from "./phasorConventionAdapter";

describe("phasorConventionAdapter", () => {
  describe("phasorAdapter", () => {
    it("handles exp_i_omega_t correctly", () => {
      const result = phasorAdapter("exp_i_omega_t");
      expect(result.decayRateSign).toBe(1);
      expect(result.phaseAnimationDirection).toBe(1);
    });

    it("maps the published positive alias to the same decay and animation signs", () => {
      expect(phasorAdapter("exp_plus_i_omega_t")).toEqual(phasorAdapter("exp_i_omega_t"));
    });

    it("handles exp_minus_i_omega_t correctly", () => {
      const result = phasorAdapter("exp_minus_i_omega_t");
      expect(result.decayRateSign).toBe(-1);
      expect(result.phaseAnimationDirection).toBe(-1);
    });
  });

  describe("floquetPhaseAdapter", () => {
    it("handles dst_equals_src_exp_minus_i_k_dot_delta_r correctly", () => {
      const result = floquetPhaseAdapter("dst_equals_src_exp_minus_i_k_dot_delta_r");
      expect(result.spatialPhaseSign).toBe(-1);
    });

    it("handles dst_equals_src_exp_plus_i_k_dot_delta_r correctly", () => {
      const result = floquetPhaseAdapter("dst_equals_src_exp_plus_i_k_dot_delta_r");
      expect(result.spatialPhaseSign).toBe(1);
    });
  });
});
