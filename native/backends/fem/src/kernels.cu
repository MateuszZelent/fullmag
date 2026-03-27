// ── S11: Fused CUDA kernels for LLG integration ───────────────────────
// Provides GPU-resident kernels for:
//   - LLG RHS (cross-product + damping + block-max reduction)
//   - Vector normalization
//   - Effective field accumulation (h_eff = h_ex + h_demag + h_ext)
// All kernels operate on AOS-3 layout: contiguous [x,y,z] per node.

#include "kernels.h"

#include <cfloat>
#include <cub/cub.cuh>

namespace fullmag::fem {

// ── LLG RHS fused kernel ──────────────────────────────────────────────
// Computes dm/dt = -γ̄ (m×H + α m×(m×H)) per node.
// Also stores per-block max |dm/dt| for later device-side reduction.

__global__ void llg_rhs_fused_kernel(
    const double *__restrict__ mx, const double *__restrict__ my, const double *__restrict__ mz,
    const double *__restrict__ hx, const double *__restrict__ hy, const double *__restrict__ hz,
    double *__restrict__ dmx, double *__restrict__ dmy, double *__restrict__ dmz,
    double *__restrict__ block_max_rhs,
    double gamma_bar, double alpha,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;

    double local_norm = 0.0;

    if (i < N) {
        const double lmx = mx[i], lmy = my[i], lmz = mz[i];
        const double lhx = hx[i], lhy = hy[i], lhz = hz[i];

        // p = m × H
        const double px = lmy * lhz - lmz * lhy;
        const double py = lmz * lhx - lmx * lhz;
        const double pz = lmx * lhy - lmy * lhx;

        // d = m × p = m × (m × H)
        const double dx = lmy * pz - lmz * py;
        const double dy = lmz * px - lmx * pz;
        const double dz = lmx * py - lmy * px;

        const double rx = -gamma_bar * (px + alpha * dx);
        const double ry = -gamma_bar * (py + alpha * dy);
        const double rz = -gamma_bar * (pz + alpha * dz);

        dmx[i] = rx;
        dmy[i] = ry;
        dmz[i] = rz;

        local_norm = sqrt(rx * rx + ry * ry + rz * rz);
    }

    // Block-level max reduction using CUB
    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    double block_max = BlockReduce(temp_storage).Reduce(local_norm, cub::Max());

    if (threadIdx.x == 0 && block_max_rhs != nullptr) {
        block_max_rhs[blockIdx.x] = block_max;
    }
}

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

// ── C interface implementations ───────────────────────────────────────

static constexpr int kBlockSize = 256;

void fullmag_cuda_llg_rhs_fused(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    double *dmx, double *dmy, double *dmz,
    double *block_max_rhs,
    double gamma, double alpha,
    int N, cudaStream_t stream)
{
    const double gamma_bar = gamma / (1.0 + alpha * alpha);
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    llg_rhs_fused_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, hx, hy, hz, dmx, dmy, dmz,
        block_max_rhs, gamma_bar, alpha, N);
}

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

void fullmag_cuda_device_max(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream)
{
    if (temp_storage == nullptr) {
        cub::DeviceReduce::Max(nullptr, temp_storage_bytes, data, result, N, stream);
        return;
    }
    cub::DeviceReduce::Max(temp_storage, temp_storage_bytes, data, result, N, stream);
}

} // namespace fullmag::fem
