// ── GPU CUDA Oersted kernels source contract ──────────────────────────
// This source owns scaled Oersted H_oe field-add kernels and CUDA wrappers.
// It does not own RK orchestration, Context construction, plan import,
// exchange, demag, Zeeman, anisotropy, DMI, STT, thermal, magnetoelastic, or
// C ABI entrypoints.

#include "gpu/cuda/interactions/oersted/oersted_kernels.hpp"

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void add_scaled_field_inplace_kernel(
    const double *__restrict__ h_add,
    double *__restrict__ h_accum,
    double scale,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        h_accum[i] += scale * h_add[i];
    }
}

void fullmag_cuda_add_scaled_field_inplace(
    const double *h_add,
    double *h_accum,
    double scale,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    add_scaled_field_inplace_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_add,
        h_accum,
        scale,
        N);
}

} // namespace fullmag::fem
