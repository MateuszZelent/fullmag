/*
 * GPU CUDA RK magnetoelastic local field module header.
 *
 * Declares prescribed-strain magnetoelastic field generation used by the
 * device-resident RK RHS local-field path. Generic local-field orchestration
 * remains in rk_local_fields.hpp/.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_magnetoelastic_field_contribution(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
