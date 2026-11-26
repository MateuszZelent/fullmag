#pragma once

#include <cstddef>
#include <map>
#include <optional>

namespace fullmag::fem::frequency_domain {

struct PoissonAirboxEigenBlockProblem;

namespace gpu {

struct AugmentedWindowCount {
    int negative_at_origin;
    int negative_at_lower;
    int negative_at_upper;
};

struct FloquetAirboxAugmentedPencilView;

// A single solve may reuse certified, unperturbed probes of the same pencil.
struct AugmentedWindowInertiaCache {
    std::map<double, int> negative_by_scaled_shift;
    std::size_t reused_probes = 0;
};

std::optional<AugmentedWindowCount> count_open_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale, double mass_scale,
    double angular_frequency_scale, double mu0, double lower_hz, double upper_hz,
    AugmentedWindowInertiaCache &inertia_cache, const char **failure);

std::optional<AugmentedWindowCount> count_floquet_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale, double mass_scale, double angular_frequency_scale, double mu0,
    double lower_hz, double upper_hz,
    AugmentedWindowInertiaCache &inertia_cache, const char **failure);

} // namespace gpu

} // namespace fullmag::fem::frequency_domain
