/*
 * GPU CUDA RK exchange final energy reductions module header.
 *
 * Declares final legacy sparse exchange energy reductions used by the
 * device-resident RK stats path. Generic energy reduction orchestration
 * remains in rk_energy_reductions.hpp/.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_final_exchange_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
