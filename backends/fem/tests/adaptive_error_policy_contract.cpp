#include "gpu/cuda/integrators/rk/adaptive_error_policy.hpp"

#include <cstdlib>

namespace {
void check(bool condition)
{
    if (!condition) {
        std::abort();
    }
}
}

int main()
{
    using fullmag::fem::AdaptiveErrorEvaluationMode;
    using fullmag::fem::resolve_adaptive_error_evaluation_mode;
    check(resolve_adaptive_error_evaluation_mode(false, false) ==
          AdaptiveErrorEvaluationMode::ErrorOnly);
    check(resolve_adaptive_error_evaluation_mode(true, false) ==
          AdaptiveErrorEvaluationMode::ErrorAndNorm);
    check(resolve_adaptive_error_evaluation_mode(false, true) ==
          AdaptiveErrorEvaluationMode::ErrorAndRotation);
    check(resolve_adaptive_error_evaluation_mode(true, true) ==
          AdaptiveErrorEvaluationMode::ErrorNormAndRotation);
    return 0;
}
