/*
 * GPU CUDA RK Oersted field accumulation module header.
 *
 * Declares scaled Oersted contribution accumulation into H_eff for the
 * device-resident RK RHS. Generic H_eff composition remains in
 * rk_effective_field.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_accumulate_oersted_field(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
