#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <complex>
#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

// The scalar-potential block is assembled in the Bloch/Floquet coordinates
// before this contract is called.  This provider owns only the algebraic
// elimination
//
//     D(k) = -A_qphi(k) P(k)^-1 A_phiq(k),
//
// and its real-split representation consumed by the modal ABI.  It is a
// bounded dense oracle for small validation problems; production mesh
// assembly and scalable factorization remain separate owners.
enum class FloquetDynamicDemagKGaugePolicy : std::uint32_t {
    require_invertible = 0,
    pin_first_dof = 1,
};

struct FloquetDynamicDemagKProblem {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    const std::complex<double> *a_qphi_row_major = nullptr;
    std::uint64_t a_qphi_value_count = 0;
    const std::complex<double> *p_row_major = nullptr;
    std::uint64_t p_value_count = 0;
    const std::complex<double> *a_phiq_row_major = nullptr;
    std::uint64_t a_phiq_value_count = 0;
    double k_rad_per_m[3] = {0.0, 0.0, 0.0};
    FloquetDynamicDemagKGaugePolicy gauge_policy =
        FloquetDynamicDemagKGaugePolicy::require_invertible;
    double pivot_tolerance = 1.0e-14;
    std::uint64_t workspace_budget_bytes = 256ull * 1024ull * 1024ull;
};

inline constexpr double kFloquetPotentialResidualTolerance = 1.0e-8;

struct FloquetDynamicDemagKDiagnostics {
    bool potential_solve_certified = false;
    std::uint64_t certified_rhs_count = 0;
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    double k_norm_rad_per_m = 0.0;
    double max_abs_pivot = 0.0;
    // Maximum infinity-norm relative residual of P(k) x = b over all
    // magnetic right-hand sides, including the original pinned equation.
    // This is the reduced scalar-potential block
    // residual; it is not the residual of the full modal pencil.
    double max_relative_potential_solve_residual = 0.0;
    double max_abs_schur_entry = 0.0;
    double max_abs_hermitian_residual = 0.0;
    char error_message[192] = "";
};

// Owned original reduced blocks retained beyond Schur assembly.
struct FloquetPotentialReconstruction {
    std::uint64_t q_count = 0;
    std::uint64_t phi_count = 0;
    FloquetDynamicDemagKGaugePolicy gauge_policy =
        FloquetDynamicDemagKGaugePolicy::require_invertible;
    std::vector<std::complex<double>> p, a_phiq, a_qphi;
    // Borrowed original magnetic operator; caller owns it through the solve.
    const double *magnetic_stiffness_real_split = nullptr;
};

struct FloquetReconstructedPotential {
    bool certified = false;
    double relative_residual = 0.0;
    std::vector<std::complex<double>> phi;
};

// Reconstruct phi = -P^-1 A_phiq q in complex reduced coordinates.
// Includes the original pinned equation in its residual, if any.
FrequencyDomainStatus reconstruct_floquet_potential(
    const FloquetPotentialReconstruction &blocks,
    const std::vector<std::complex<double>> &q,
    FloquetReconstructedPotential *result) noexcept;


struct FloquetModalResidual {
    bool certified = false;
    double magnetic_relative_residual = 0.0;
    double potential_relative_residual = 0.0;
    std::vector<std::complex<double>> potential_real_split;
};
// Checks the original constrained algebraic descriptor, not geometric BC
// or continuum/mesh convergence. z and potential use the doubled real layout.
FrequencyDomainStatus certify_floquet_realified_mode(
    const FloquetPotentialReconstruction &blocks,
    const double *magnetic_stiffness, const double *gyrotropic,
    const std::vector<std::complex<double>> &z, std::complex<double> lambda,
    FloquetModalResidual *result) noexcept;

// `out_real_split_row_major` uses [Re(q), Im(q)] ordering and the standard
// realification [[Re D, -Im D], [Im D, Re D]].  The output is the dynamic
// demag contribution only; callers add it to the magnetic Hessian once.
FrequencyDomainStatus build_floquet_dynamic_demag_k_real_split(
    const FloquetDynamicDemagKProblem &problem,
    double *out_real_split_row_major,
    std::uint64_t out_value_count,
    FloquetDynamicDemagKDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
