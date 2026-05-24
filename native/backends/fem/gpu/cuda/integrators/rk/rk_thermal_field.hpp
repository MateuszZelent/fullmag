/*
 * GPU CUDA RK thermal local field module header.
 *
 * Declares deterministic Brown thermal field generation used by the
 * device-resident RK RHS local-field path. Generic local-field orchestration
 * remains in rk_local_fields.hpp/.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_thermal_field_contribution(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
