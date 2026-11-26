/*
 * GPU cuDSS direct solver for frequency-domain driven response.
 *
 * Phase 0 compiling seam stub (unconditionally compiled into fullmag_fem so
 * non-MFEM / no-CUDA builds link cleanly; full implementation owned by
 * Track 3 in Phase 1).
 */

#include "gpu/frequency_domain/driven_response_cudss.hpp"

namespace fullmag::fem::frequency_domain {

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
    DrivenResponseCudssOutcome *out_outcome) noexcept
{
    (void)drive_real;
    (void)drive_imag;
    (void)out_response_real;
    (void)out_response_imag;
    (void)out_residual_l2;
    (void)out_relative_residual_l2;
    (void)out_delta_phi_full_real_opt;
    (void)out_delta_phi_full_imag_opt;
    (void)out_h_demag_real_opt;
    (void)out_h_demag_imag_opt;

    DrivenResponseCudssOutcome outcome{};
    if (request.gpu_direct_policy == DrivenFrequencyResponseGpuDirectPolicy::Disabled) {
        outcome.status = FrequencyDomainStatus::ok;
        outcome.used_cudss = false;
        outcome.fallback_to_krylov = true;
        outcome.fallback_reason = "policy_disabled";
        if (out_outcome != nullptr) {
            *out_outcome = outcome;
        }
        return outcome.status;
    }

#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
    const char *reason = "cudss_driven_response_not_implemented_phase0";
#else
    const char *reason = "cudss_unavailable";
#endif

    if (request.gpu_direct_policy == DrivenFrequencyResponseGpuDirectPolicy::Required) {
        outcome.status = FrequencyDomainStatus::unavailable;
        outcome.used_cudss = false;
        outcome.fallback_to_krylov = false;
        outcome.fallback_reason = reason;
        outcome.error_message =
            "GPU cuDSS driven-response direct solver is unavailable for this build";
    } else {
        outcome.status = FrequencyDomainStatus::ok;
        outcome.used_cudss = false;
        outcome.fallback_to_krylov = true;
        outcome.fallback_reason = reason;
    }

    if (out_outcome != nullptr) {
        *out_outcome = outcome;
    }
    return outcome.status;
}

} // namespace fullmag::fem::frequency_domain
