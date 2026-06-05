/*
 * GPU CUDA RK total energy reduction module header.
 *
 * Declares the device-side aggregation from already-reduced per-term energy
 * slots into the scalar used by direct minimizer control decisions.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_total_energy_scalar(
    Context &ctx,
    cudaStream_t stream,
    double *output,
    std::string &reason);

} // namespace fullmag::fem
#endif
