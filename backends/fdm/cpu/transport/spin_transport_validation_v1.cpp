#include "spin_transport_validation_v1.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace fullmag::fdm::cpu::transport::spin::v1::detail {

Vector3 direct_she_source(std::size_t normal_axis,
                          Vector3 electric_field_v_per_m,
                          double theta_sigma_s_per_m) {
    Vector3 result{};
    if (normal_axis >= 3) {
        return result;
    }
    const std::size_t first = (normal_axis + 1) % 3;
    const std::size_t second = (normal_axis + 2) % 3;
    result[first] = -theta_sigma_s_per_m * electric_field_v_per_m[second];
    result[second] = theta_sigma_s_per_m * electric_field_v_per_m[first];
    return result;
}

LocalResidualGateSummary evaluate_local_residual_gate(
    const std::vector<Vector3> &residual_a_per_m3,
    const std::vector<double> &local_scale_a_per_m3,
    double relative_tolerance,
    double absolute_tolerance_a_per_m3) {
    LocalResidualGateSummary result;
    if (residual_a_per_m3.size() != local_scale_a_per_m3.size() ||
        !std::isfinite(relative_tolerance) || relative_tolerance < 0.0 ||
        !std::isfinite(absolute_tolerance_a_per_m3) ||
        absolute_tolerance_a_per_m3 < 0.0) {
        return result;
    }
    result.accepted = true;
    for (std::size_t cell = 0; cell < residual_a_per_m3.size(); ++cell) {
        if (!std::isfinite(local_scale_a_per_m3[cell]) ||
            local_scale_a_per_m3[cell] < 0.0) {
            result.accepted = false;
            continue;
        }
        const double tolerance = absolute_tolerance_a_per_m3 +
                                 relative_tolerance * local_scale_a_per_m3[cell];
        result.max_local_residual_tolerance_a_per_m3 =
            std::max(result.max_local_residual_tolerance_a_per_m3, tolerance);
        for (double component : residual_a_per_m3[cell]) {
            if (!std::isfinite(component)) {
                result.accepted = false;
                result.max_relative_local_residual =
                    std::numeric_limits<double>::infinity();
                continue;
            }
            if (std::abs(component) > tolerance) {
                result.accepted = false;
            }
            const double ratio = tolerance > 0.0
                                     ? std::abs(component) / tolerance
                                     : (component == 0.0
                                            ? 0.0
                                            : std::numeric_limits<double>::infinity());
            result.max_relative_local_residual =
                std::max(result.max_relative_local_residual, ratio);
        }
    }
    return result;
}

} // namespace fullmag::fdm::cpu::transport::spin::v1::detail
