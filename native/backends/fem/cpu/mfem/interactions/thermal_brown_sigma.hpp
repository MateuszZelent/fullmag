#pragma once

namespace fullmag::fem {

/*
 * Compute the Brown thermal-field standard deviation for one FEM node.
 *
 * The returned value is an H-field amplitude in A/m:
 *
 *   sigma_i = sqrt(2 alpha_i kB T /
 *                  (gamma0_i mu0 Ms_i V_i dt)),
 *   gamma0_i = gamma_mu0 (1 + alpha_i^2).
 *
 * The gyromagnetic_ratio argument is the bare gamma_mu0 used by the LLG RHS,
 * not gamma_bar = gamma_mu0 / (1 + alpha_i^2).
 *
 * Invalid, disabled, or non-positive inputs return zero. This module owns only
 * the physical sigma formula; RNG sampling and H_eff addition live elsewhere.
 * It does not sample RNG state or add H_therm to H_eff.
 */
double thermal_brown_sigma(
    double temperature,
    double damping,
    double gyromagnetic_ratio,
    double saturation_magnetisation,
    double node_volume,
    double dt_seconds);

} // namespace fullmag::fem
