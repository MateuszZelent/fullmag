#pragma once

#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include <cstddef>
#include <vector>

namespace fullmag::fdm::cpu::transport::spin::v1::detail {

struct LocalResidualGateSummary {
    bool accepted = false;
    double max_local_residual_tolerance_a_per_m3 = 0.0;
    double max_relative_local_residual = 0.0;
};

Vector3 direct_she_source(std::size_t normal_axis,
                          Vector3 electric_field_v_per_m,
                          double theta_sigma_s_per_m);

LocalResidualGateSummary evaluate_local_residual_gate(
    const std::vector<Vector3> &residual_a_per_m3,
    const std::vector<double> &local_scale_a_per_m3,
    double relative_tolerance,
    double absolute_tolerance_a_per_m3);

} // namespace fullmag::fdm::cpu::transport::spin::v1::detail
