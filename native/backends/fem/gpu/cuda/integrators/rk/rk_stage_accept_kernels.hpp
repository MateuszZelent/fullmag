/*
 * GPU CUDA RK stage accept kernels compatibility header.
 *
 * Includes low-level per-integrator accepted-state update kernel modules used
 * by device-resident explicit RK stage sequences. Step orchestration remains in
 * rk_step.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_bs23_accept_kernel.hpp"
#include "gpu/cuda/integrators/rk/rk_dp54_accept_kernel.hpp"
#include "gpu/cuda/integrators/rk/rk_heun_accept_kernel.hpp"
#include "gpu/cuda/integrators/rk/rk_rk4_accept_kernel.hpp"
#endif
