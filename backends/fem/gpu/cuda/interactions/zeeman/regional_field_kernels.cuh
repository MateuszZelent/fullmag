#pragma once

#include "gpu/cuda/fields/field_buffer_state.hpp"
#include <string>
#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

struct Context;

bool gpu_regional_field_drive_upload(Context &ctx, std::string &error);
void gpu_regional_field_drive_destroy(FemGpuFieldBufferDeviceState &fields);

#if FULLMAG_HAS_CUDA_RUNTIME
bool gpu_regional_field_drive_materialize_and_accumulate(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    double evaluation_time_s,
    bool accumulate_into_h_eff,
    std::string &error);
#endif

} // namespace fullmag::fem
