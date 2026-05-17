#include "cpu/mfem/interactions/thermal_brown_sigma.hpp"

#include <cmath>

namespace fullmag::fem {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;
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
