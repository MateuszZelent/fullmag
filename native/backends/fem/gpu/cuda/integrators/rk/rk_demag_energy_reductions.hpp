/*
 * GPU CUDA RK demag final energy reductions module header.
 *
 * Declares final demag and Robin boundary energy reductions used by the
 * device-resident RK stats path. Generic energy reduction orchestration
 * remains in rk_energy_reductions.hpp/.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_final_demag_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
