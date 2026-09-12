#pragma once

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kPoissonAirboxSchurMatShellCertificationAbiVersion = 1;

struct PoissonAirboxSchurMatShellCertificateKey {
    std::uint64_t mesh_signature = 0;
    std::uint64_t material_signature = 0;
    std::uint64_t m0_signature = 0;
    std::uint64_t h_eff0_signature = 0;
    std::uint64_t static_demag_signature = 0;
    std::uint64_t boundary_signature = 0;
    std::uint64_t k_signature = 0;
    std::uint64_t gauge_signature = 0;
    std::uint64_t operator_signature = 0;
};

struct PoissonAirboxSchurMatShellCertificationResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_phi_dof_count = 0;

    double schur_apply_relative_error = 0.0;
    double schur_eigen_residual_relative = 0.0;
    double full_residual_reconstruction_relative_error = 0.0;
    double poisson_constraint_relative_residual = 0.0;
    double gauge_mean_abs = 0.0;
    double full_sparse_reference_frequency_hz = 0.0;
    double schur_frequency_hz = 0.0;
    double full_sparse_reference_relative_frequency_error = 0.0;

    bool created_petsc_matshell = false;
    bool reused_mean_zero_poisson_setup = false;
    bool schur_certified = false;
    bool full_sparse_reference_certified = false;
    bool full_residual_certified = false;

    PoissonAirboxSchurMatShellCertificateKey certificate_key{};
    char certificate_key_json[2048]{};
    char diagnostics_json[8192]{};
};

FrequencyDomainStatus certify_poisson_airbox_schur_matshell_cpu(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxSchurMatShellCertificationResult *out_result) noexcept;

// Production shared-domain K0 lane.  The scalar Poisson block is eliminated
// through a persistent PETSc factorization and SLEPc operates on the
// real-frequency-rotated Schur pencil.  Synthetic/dense certification remains
// owned by certify_poisson_airbox_schur_matshell_cpu().
FrequencyDomainStatus solve_poisson_airbox_modal_eigen_cpu_schur(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
