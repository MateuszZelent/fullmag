#include "gpu/cuda/reductions/object_average_kernels.hpp"
#include <cmath>
#include <limits>

namespace fullmag::fem {
namespace {
__global__ void component_blocks(
    const GpuObjectAverageRecord *records, uint64_t count,
    const double *mx, const double *my, const double *mz,
    bool dg0, int component, double *blocks)
{
    __shared__ double sums[256];
    double value = 0.0;
    const double *field = component == 0 ? mx : (component == 1 ? my : mz);
    for (uint64_t index = blockIdx.x * 256ull + threadIdx.x;
         index < count; index += gridDim.x * 256ull) {
        const auto &record = records[index];
        if (component == 3) {
            bool finite = true;
            if (dg0) {
                for (uint32_t local = 0; local < record.count; ++local) {
                    const auto node = record.nodes[local];
                    finite = finite && isfinite(mx[node]) && isfinite(my[node]) && isfinite(mz[node]);
                }
            }
            value += finite ? record.weight : nan("");
        } else {
            const double nodal_weight = record.count == 4 ? record.weight / 4.0 : record.weight;
            for (uint32_t local = 0; local < record.count; ++local) {
                value += nodal_weight * field[record.nodes[local]];
            }
        }
    }
    sums[threadIdx.x] = value;
    __syncthreads();
    for (int stride = 128; stride > 0; stride /= 2) {
        if (threadIdx.x < stride) { sums[threadIdx.x] += sums[threadIdx.x + stride]; }
        __syncthreads();
    }
    if (threadIdx.x == 0) { blocks[blockIdx.x] = sums[0]; }
}
__global__ void accumulate_chunk(double *result)
{
    for (int component = 0; component < 4; ++component) { result[component] += result[4 + component]; }
}
}
void gpu_object_average_component_blocks(
    const GpuObjectAverageRecord *records, uint64_t count,
    const double *mx, const double *my, const double *mz,
    bool dg0, int component, double *blocks, int block_count, cudaStream_t stream)
{
    component_blocks<<<block_count, 256, 0, stream>>>(
        records, count, mx, my, mz, dg0, component, blocks);
}
void gpu_object_average_accumulate_chunk(double *result, cudaStream_t stream)
{
    accumulate_chunk<<<1, 1, 0, stream>>>(result);
}
}
