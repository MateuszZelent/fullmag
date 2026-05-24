/*
 * GPU CUDA RK scalar readback module header.
 *
 * Declares audited device-to-host scalar reads used by the device-resident RK
 * stepper. Component-field copies remain in rk_component_copy.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <cstddef>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_read_scalar_result(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double &value,
    std::string &reason);

bool gpu_rk_read_scalar_results(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double *values,
    size_t count,
    std::string &reason);

} // namespace fullmag::fem
#endif
