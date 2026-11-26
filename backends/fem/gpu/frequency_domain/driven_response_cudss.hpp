#pragma once

/*
 * GPU cuDSS direct solver module header for frequency-domain driven response.
 *
 * Performs one-time symbolic analysis and Ruiz equilibration across an RF
 * frequency sweep, updating only the 4*N_m diagonal frequency entries on GPU
 * per frequency point and certifying unscaled residuals for both magnetic and
 * Poisson blocks.
 */

#include "frequency_domain/driven_response_solver.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem::frequency_domain {

struct DrivenResponseCudssOutcome {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    bool used_cudss = false;
    bool fallback_to_krylov = false;
    std::string fallback_reason;
    std::uint64_t symbolic_analysis_count = 0;
    std::uint64_t numeric_factorization_count = 0;
    std::uint64_t estimated_peak_device_bytes = 0;
    std::uint64_t device_budget_bytes = 0;
    double max_magnetic_relative_residual_l2 = 0.0;
    double max_poisson_relative_residual_l2 = 0.0;
    std::uint64_t completed_frequency_count = 0;
    std::string error_message;
};

FrequencyDomainStatus solve_driven_response_gpu_cudss(
    const DrivenFrequencyResponseSolveRequest &request,
    const double *drive_real,
    const double *drive_imag,
    double *out_response_real,
    double *out_response_imag,
    double *out_residual_l2,
    double *out_relative_residual_l2,
    double *out_delta_phi_full_real_opt,
    double *out_delta_phi_full_imag_opt,
    double *out_h_demag_real_opt,
    double *out_h_demag_imag_opt,
    DrivenResponseCudssOutcome *out_outcome) noexcept;

} // namespace fullmag::fem::frequency_domain
