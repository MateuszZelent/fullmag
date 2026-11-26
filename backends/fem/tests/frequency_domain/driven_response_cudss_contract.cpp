/*
 * GPU cuDSS frequency-domain driven response contract test.
 *
 * Phase 0 compiling skeleton registered in CTest; full TDD tests for Track 3
 * (sweep parity, ess_tdofs zeroing, divergence-free residual floor, VRAM budget
 * guard, singular resonance hard error, periodic_airbox_k0 lifting/recovery)
 * are implemented by Track 3 in Phase 1.
 */

#include "gpu/frequency_domain/driven_response_cudss.hpp"

int main()
{
    fullmag::fem::frequency_domain::DrivenFrequencyResponseSolveRequest request{};
    request.gpu_direct_policy =
        fullmag::fem::frequency_domain::DrivenFrequencyResponseGpuDirectPolicy::Disabled;
    fullmag::fem::frequency_domain::DrivenResponseCudssOutcome outcome{};
    const auto status =
        fullmag::fem::frequency_domain::solve_driven_response_gpu_cudss(
            request,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            &outcome);
    return (status == fullmag::fem::frequency_domain::FrequencyDomainStatus::ok &&
            !outcome.used_cudss && outcome.fallback_to_krylov)
        ? 0
        : 1;
}
