/*
 * GPU CUDA RK effective field accumulation module header.
 *
 * Declares H_eff accumulation for the device-resident RK RHS. Interaction
 * field generation and direct torque RHS terms remain in their owning modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_accumulate_effective_field(
    Context &ctx,
    cudaStream_t stream,
    int n,
    const char *base_label,
    std::string &reason);

} // namespace fullmag::fem
#endif
