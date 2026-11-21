#pragma once
#include "gpu/cuda/reductions/object_average_state.hpp"
#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
namespace fullmag::fem {
void gpu_object_average_component_blocks(
    const GpuObjectAverageRecord *records, uint64_t count,
    const double *mx, const double *my, const double *mz,
    bool dg0, int component, double *blocks, int block_count, cudaStream_t stream);
void gpu_object_average_accumulate_chunk(double *result, cudaStream_t stream);
}
#endif
