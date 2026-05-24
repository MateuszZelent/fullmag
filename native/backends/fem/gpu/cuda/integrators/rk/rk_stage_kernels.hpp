/*
 * GPU CUDA RK stage kernels module header.
 *
 * Compatibility umbrella for low-level predictor and accept kernels used by
 * the device-resident explicit RK stepper. Step orchestration remains in
 * rk_step.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_stage_accept_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp"
#endif
