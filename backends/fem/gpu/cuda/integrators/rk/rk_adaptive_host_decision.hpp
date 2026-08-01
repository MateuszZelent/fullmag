/*
 * GPU-host adaptive scalar decision adapter.
 *
 * This CUDA-free header exposes only the host-control scalar realization of
 * the backend-neutral adaptive decision contract. Device state, CUDA runtime,
 * Context mutation, and reject restoration remain in rk_adaptive_runtime.hpp.
 */
#pragma once

#include "core/adaptive_step_decision.hpp"

namespace fullmag::fem {

adaptive::AdaptiveStepDecision gpu_host_adaptive_step_decision(
    const adaptive::AdaptiveStepPolicy &policy,
    const adaptive::AdaptiveStepInput &input);

} // namespace fullmag::fem
