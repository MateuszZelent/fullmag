#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool rk_step_inject_failure(
    Context &ctx,
    RkStepFailurePoint point,
    std::string &error)
{
    auto &injection = ctx.stepper.failure_injection;
    if (injection.next != point) {
        return false;
    }
    injection.next = RkStepFailurePoint::None;
    injection.injected_count += 1;
    switch (point) {
        case RkStepFailurePoint::AfterCandidateMagnetization:
            error = "injected RK failure after candidate magnetization";
            break;
        case RkStepFailurePoint::DuringFinalFieldRefresh:
            error = "injected RK failure during final field refresh";
            break;
        case RkStepFailurePoint::DuringFinalStatistics:
            error = "injected RK failure during final statistics";
            break;
        case RkStepFailurePoint::None:
            return false;
    }
    return true;
}

} // namespace fullmag::fem
