/*
 * GPU CUDA RK LLG RHS dispatch module header.
 *
 * Declares the fused LLG RHS launch used by the RK RHS runtime after H_eff has
 * been assembled. LLG kernel wrappers remain in gpu/cuda/integrators/llg.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_llg_rhs(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
