// ── GPU CUDA kernels source contract ───────────────────────────────────
// This source owns exported FEM CUDA field kernel implementations. It does not own Context construction, GPU RK planning, GPU RK step orchestration, AoS/SoA transfer wrappers, device-wide reductions, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints.
//
// ── S11: CUDA kernels for shared vector field operations ──────────────
// Provides GPU-resident kernels for:
//   - Vector normalization
//   - Effective field accumulation (h_eff = h_ex + h_demag + h_ext)
// All kernels operate on SoA (Structure-of-Arrays) layout:
// separate contiguous arrays for x, y, z components.

#include "gpu/cuda/kernels/kernels.hpp"

namespace fullmag::fem {

// ── Normalize unit vectors ────────────────────────────────────────────
__global__ void normalize_unit_vectors_kernel(
    double *__restrict__ mx, double *__restrict__ my, double *__restrict__ mz,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        const double x = mx[i], y = my[i], z = mz[i];
        const double norm = sqrt(x * x + y * y + z * z);
        if (norm > 0.0) {
            const double inv = 1.0 / norm;
            mx[i] = x * inv;
            my[i] = y * inv;
            mz[i] = z * inv;
        }
    }
}

// ── Effective field accumulation ──────────────────────────────────────
// h_eff = h_ex + h_demag + h_ext (component-wise, SOA layout)
__global__ void accumulate_heff_kernel(
    const double *__restrict__ h_ex,
    const double *__restrict__ h_demag,
    const double *__restrict__ h_ext,
    double *__restrict__ h_eff,
    int N,
    bool has_ext)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        double val = h_ex[i] + h_demag[i];
        if (has_ext) {
            val += h_ext[i];
        }
        h_eff[i] = val;
    }
}

__global__ void zero_indexed_values_kernel(
    double *__restrict__ values,
    const uint32_t *__restrict__ indices,
    int count)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < count) {
        values[indices[i]] = 0.0;
    }
}

__global__ void add_field_inplace_kernel(
    const double *__restrict__ h_add,
    double *__restrict__ h_accum,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        h_accum[i] += h_add[i];
    }
}

// ── C interface implementations ───────────────────────────────────────

static constexpr int kBlockSize = 256;

void fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    int N, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    normalize_unit_vectors_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, N);
}

void fullmag_cuda_accumulate_heff(
    const double *h_ex, const double *h_demag, const double *h_ext,
    double *h_eff,
    int N, bool has_ext, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    accumulate_heff_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_ex, h_demag, h_ext, h_eff, N, has_ext);
}

void fullmag_cuda_zero_indexed_values(
    double *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream)
{
    if (count <= 0) {
        return;
    }
    const int num_blocks = (count + kBlockSize - 1) / kBlockSize;
    zero_indexed_values_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        values,
        indices,
        count);
}

void fullmag_cuda_add_field_inplace(
    const double *h_add,
    double *h_accum,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    add_field_inplace_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_add,
        h_accum,
        N);
}

} // namespace fullmag::fem
