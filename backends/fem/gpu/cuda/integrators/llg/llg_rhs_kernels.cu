// ── GPU CUDA LLG RHS kernels source contract ──────────────────────────
// This source owns exported FEM CUDA wrappers for the fused LLG RHS and
// per-block RHS max reductions. It does not own RK orchestration, AoS/SoA
// transfer wrappers, Context construction, MFEM runtime lifecycle, interaction
// physics, or C ABI entrypoints.

#include "gpu/cuda/integrators/llg/llg_rhs_kernels.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

// ── LLG RHS fused kernel ──────────────────────────────────────────────
// Computes dm/dt = -gamma_bar (p m x H + alpha m x (m x H)) per node.
// p=0 when pure damping relaxation disables precession.
// Also stores per-block max |dm/dt| for later device-side reduction.
__global__ void llg_rhs_fused_kernel(
    const double *__restrict__ mx, const double *__restrict__ my, const double *__restrict__ mz,
    const double *__restrict__ hx, const double *__restrict__ hy, const double *__restrict__ hz,
    double *__restrict__ dmx, double *__restrict__ dmy, double *__restrict__ dmz,
    double *__restrict__ block_max_rhs,
    const double *__restrict__ alpha_field,
    double gamma, double uniform_alpha,
    bool use_alpha_field,
    bool precession_enabled,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;

    double local_norm = 0.0;

    if (i < N) {
        const double lmx = mx[i], lmy = my[i], lmz = mz[i];
        const double lhx = hx[i], lhy = hy[i], lhz = hz[i];
        const double alpha = use_alpha_field ? alpha_field[i] : uniform_alpha;
        const double gamma_bar = gamma / (1.0 + alpha * alpha);

        // p = m x H
        const double px = lmy * lhz - lmz * lhy;
        const double py = lmz * lhx - lmx * lhz;
        const double pz = lmx * lhy - lmy * lhx;

        // d = m x p = m x (m x H)
        const double dx = lmy * pz - lmz * py;
        const double dy = lmz * px - lmx * pz;
        const double dz = lmx * py - lmy * px;

        const double precession_scale = precession_enabled ? 1.0 : 0.0;
        const double rx = -gamma_bar * (precession_scale * px + alpha * dx);
        const double ry = -gamma_bar * (precession_scale * py + alpha * dy);
        const double rz = -gamma_bar * (precession_scale * pz + alpha * dz);

        dmx[i] = rx;
        dmy[i] = ry;
        dmz[i] = rz;

        if (block_max_rhs != nullptr) {
            local_norm = sqrt(rx * rx + ry * ry + rz * rz);
        }
    }

    if (block_max_rhs == nullptr) {
        return;
    }
    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    double block_max = BlockReduce(temp_storage).Reduce(local_norm, cub::Max());

    if (threadIdx.x == 0 && block_max_rhs != nullptr) {
        block_max_rhs[blockIdx.x] = block_max;
    }
}

void fullmag_cuda_llg_rhs_fused(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    double *dmx, double *dmy, double *dmz,
    double *block_max_rhs,
    const double *alpha_field,
    double gamma, double alpha,
    bool use_alpha_field,
    bool precession_enabled,
    int N, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    llg_rhs_fused_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, hx, hy, hz, dmx, dmy, dmz,
        block_max_rhs, alpha_field, gamma, alpha, use_alpha_field, precession_enabled, N);
}

} // namespace fullmag::fem
