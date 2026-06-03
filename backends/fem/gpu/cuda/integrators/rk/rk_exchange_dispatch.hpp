/*
 * GPU CUDA RK exchange dispatch module header.
 *
 * Declares the device-resident legacy sparse exchange dispatch used by the RK
 * RHS runtime. RHS orchestration remains in rk_rhs_runtime.cu; exchange
 * operator assembly and upload remain outside the RK stepper.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

bool gpu_rk_compute_legacy_sparse_exchange(
    FemGpuState &gpu,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason);

} // namespace fullmag::fem
#endif
