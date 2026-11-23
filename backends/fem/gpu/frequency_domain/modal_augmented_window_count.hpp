#pragma once

#include <optional>

namespace fullmag::fem::frequency_domain {

struct PoissonAirboxEigenBlockProblem;

namespace gpu {

struct AugmentedWindowCount {
    int negative_at_origin;
    int negative_at_lower;
    int negative_at_upper;
};

std::optional<AugmentedWindowCount> count_open_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale, double mass_scale,
    double angular_frequency_scale, double mu0, double lower_hz, double upper_hz, const char **failure);

} // namespace gpu
} // namespace fullmag::fem::frequency_domain
