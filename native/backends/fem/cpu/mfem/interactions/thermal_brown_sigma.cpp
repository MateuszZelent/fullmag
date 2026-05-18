/*
 * Brown thermal sigma source contract.
 *
 * This source owns the Brown thermal-field standard-deviation formula and its
 * invalid-input zero policy. Its gyromagnetic_ratio input is the bare gamma_mu0,
 * not gamma_bar. It does not sample RNG state or add H_therm to H_eff.
 */
#include "cpu/mfem/interactions/thermal_brown_sigma.hpp"

#include "fem_common.hpp"

#include <cmath>

namespace fullmag::fem {
namespace {

constexpr double kB = 1.380649e-23;

} // namespace

double thermal_brown_sigma(
    double temperature,
    double damping,
    double gyromagnetic_ratio,
    double saturation_magnetisation,
    double node_volume,
    double dt_seconds)
{
    if (!(temperature > 0.0) ||
        !(damping > 0.0) ||
        !(gyromagnetic_ratio > 0.0) ||
        !(saturation_magnetisation > 0.0) ||
        !(node_volume > 0.0) ||
        !(dt_seconds > 0.0)) {
        return 0.0;
    }

    const double gamma0 = gyromagnetic_ratio * (1.0 + damping * damping);
    return std::sqrt(
        2.0 * damping * kB * temperature /
        (gamma0 * kMu0 * saturation_magnetisation * node_volume * dt_seconds));
}

} // namespace fullmag::fem
