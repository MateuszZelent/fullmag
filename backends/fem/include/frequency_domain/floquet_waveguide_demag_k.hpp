#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

/*
 * Dense validation provider for the translationally invariant 2.5D
 * waveguide representation.  The supplied real blocks are weak-form
 * operators on one transverse section:
 *
 *   P(k) = K_perp + k^2 M,
 *   A_qphi(k) = A_qphi_perp + i k A_qphi_axial,
 *   A_phiq(k) = A_phiq_perp + i k A_phiq_axial.
 *
 * The sign of the axial source belongs to A_phiq_axial.  For the convention
 * exp(-i k z), the Maxwell/magnetostatic source term is -i k delta M_z;
 * callers therefore provide that sign explicitly instead of relying on a
 * hidden convention in this provider.  The returned real-split matrix is
 * -A_qphi(k) P(k)^-1 A_phiq(k) in [Re(q), Im(q)] coordinates.
 *
 * This is a bounded algebraic oracle.  It deliberately does not claim to
 * assemble a transverse MFEM mesh, choose an exterior boundary, or qualify
 * the open-boundary/padding convergence required by production waveguides.
 */
enum class FloquetWaveguideDemagKGaugePolicy : std::uint32_t {
    require_invertible = 0,
    pin_first_dof = 1,
};

struct FloquetWaveguideDemagKProblem {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;

    const double *k_perp_row_major = nullptr;
    const double *mass_row_major = nullptr;
    const double *a_qphi_perp_row_major = nullptr;
    const double *a_qphi_axial_row_major = nullptr;
    const double *a_phiq_perp_row_major = nullptr;
    const double *a_phiq_axial_row_major = nullptr;

    double k_rad_per_m = 0.0;
    FloquetWaveguideDemagKGaugePolicy gauge_policy =
        FloquetWaveguideDemagKGaugePolicy::require_invertible;
    double pivot_tolerance = 1.0e-14;
    std::uint64_t workspace_budget_bytes = 256u * 1024u * 1024u;
};

struct FloquetWaveguideDemagKDiagnostics {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    double k_rad_per_m = 0.0;
    double k_squared = 0.0;
    double max_pivot_abs = 0.0;
    double max_schur_abs = 0.0;
    double max_hermitian_residual = 0.0;
    char error_message[192]{};
};

FrequencyDomainStatus build_floquet_waveguide_demag_k_real_split(
    const FloquetWaveguideDemagKProblem &problem,
    double *out_real_split_row_major,
    std::uint64_t out_value_count,
    FloquetWaveguideDemagKDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
