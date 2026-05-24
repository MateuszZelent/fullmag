/*
 * GPU CUDA RK device I/O module header.
 *
 * Declares audited device scalar reads and component-field copy helpers used
 * by the device-resident RK stepper. RK orchestration remains in rk_step.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>
#include <vector>

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

bool gpu_rk_copy_component_device(
    const FemGpuComponentField &src,
    FemGpuComponentField &dst,
    uint64_t node_count,
    cudaStream_t stream,
    const char *operation,
    std::string &reason);

bool gpu_rk_download_component_device_to_aos(
    Context &ctx,
    const FemGpuComponentField &src,
    std::vector<double> &out_xyz,
    cudaStream_t stream,
    const char *operation,
    std::string &reason);

} // namespace fullmag::fem
#endif
