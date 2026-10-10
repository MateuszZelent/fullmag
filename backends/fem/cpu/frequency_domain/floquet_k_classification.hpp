#pragma once

#include <array>
#include <cmath>

namespace fullmag::fem::frequency_domain::floquet_k {

enum class Classification {
    invalid,
    gamma,
    nonzero,
};

inline constexpr double kGammaAdmissionThresholdRadPerM = 1.0e-12;

inline Classification classify_components(const double *components, int component_count) noexcept
{
    if (components == nullptr || component_count != 3) {
        return Classification::invalid;
    }

    bool has_component_above_gamma_threshold = false;
    for (int index = 0; index < 3; ++index) {
        const double component = components[index];
        if (!std::isfinite(component)) {
            return Classification::invalid;
        }
        has_component_above_gamma_threshold =
            has_component_above_gamma_threshold ||
            std::abs(component) > kGammaAdmissionThresholdRadPerM;
    }

    return has_component_above_gamma_threshold
        ? Classification::nonzero
        : Classification::gamma;
}

inline Classification classify(const std::array<double, 3> &components) noexcept
{
    return classify_components(components.data(), static_cast<int>(components.size()));
}

} // namespace fullmag::fem::frequency_domain::floquet_k