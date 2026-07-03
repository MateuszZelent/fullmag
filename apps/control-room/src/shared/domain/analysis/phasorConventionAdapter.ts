export type PhasorConvention = "exp_i_omega_t" | "exp_minus_i_omega_t";
export type FloquetSpatialConvention =
  | "dst_equals_src_exp_minus_i_k_dot_delta_r"
  | "dst_equals_src_exp_plus_i_k_dot_delta_r";

export interface PhasorAdapterResult {
  decayRateSign: 1 | -1;
  phaseAnimationDirection: 1 | -1;
}

export interface FloquetPhaseAdapterResult {
  spatialPhaseSign: 1 | -1;
}

export function phasorAdapter(convention: PhasorConvention): PhasorAdapterResult {
  if (convention === "exp_i_omega_t") {
    return {
      decayRateSign: 1,
      phaseAnimationDirection: 1,
    };
  } else {
    return {
      decayRateSign: -1,
      phaseAnimationDirection: -1,
    };
  }
}

export function floquetPhaseAdapter(
  convention: FloquetSpatialConvention,
): FloquetPhaseAdapterResult {
  if (convention === "dst_equals_src_exp_minus_i_k_dot_delta_r") {
    return {
      spatialPhaseSign: -1,
    };
  } else {
    return {
      spatialPhaseSign: 1,
    };
  }
}
