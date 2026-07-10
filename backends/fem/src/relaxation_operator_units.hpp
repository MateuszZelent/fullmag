#pragma once

namespace fullmag::fem::relaxation {

inline constexpr double kVacuumPermeabilityHPerM = 1.25663706212e-6;

inline double exchange_hessian_scale_from_step_m_per_a(double step_m_per_a)
{
    return step_m_per_a * (2.0 / kVacuumPermeabilityHPerM);
}

inline double local_field_curvature_operator_entry(
    double step_m_per_a,
    double saturation_magnetisation_a_per_m,
    double nodal_volume_m3,
    double field_curvature_a_per_m)
{
    return step_m_per_a * kVacuumPermeabilityHPerM *
        saturation_magnetisation_a_per_m * nodal_volume_m3 *
        field_curvature_a_per_m;
}

} // namespace fullmag::fem::relaxation
