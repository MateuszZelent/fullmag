// ── GPU CUDA magnetoelastic kernels source contract ───────────────────
// This source owns prescribed-strain magnetoelastic field/energy CUDA kernels
// and wrappers. It does not own RK orchestration, Context construction, plan
// import, exchange, demag, DMI, STT, thermal, or C ABI entrypoints.

#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"

#include <cstddef>
#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void magnetoelastic_field_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    const double *__restrict__ per_node_strain_voigt,
    double *__restrict__ h_mel_x,
    double *__restrict__ h_mel_y,
    double *__restrict__ h_mel_z,
    double *__restrict__ block_sums,
    double b1,
    double b2,
    double e11,
    double e22,
    double e33,
    double tensor_e23,
    double tensor_e13,
    double tensor_e12,
    bool use_per_node_strain,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double lmx = mx[i];
        const double lmy = my[i];
        const double lmz = mz[i];
        if (use_per_node_strain) {
            // Voigt input uses engineering shear [e11,e22,e33,2e23,2e13,2e12].
            const double *eps = per_node_strain_voigt + static_cast<size_t>(i) * 6u;
            e11 = eps[0];
            e22 = eps[1];
            e33 = eps[2];
            tensor_e23 = eps[3] * 0.5;
            tensor_e13 = eps[4] * 0.5;
            tensor_e12 = eps[5] * 0.5;
        }
        double hx = 0.0;
        double hy = 0.0;
        double hz = 0.0;
        if (ms_i > 0.0) {
            const double inv_mu0_ms = -1.0 / (kMu0 * ms_i);
            hx = inv_mu0_ms * (2.0 * b1 * lmx * e11 + 2.0 * b2 * (lmy * tensor_e12 + lmz * tensor_e13));
            hy = inv_mu0_ms * (2.0 * b1 * lmy * e22 + 2.0 * b2 * (lmx * tensor_e12 + lmz * tensor_e23));
            hz = inv_mu0_ms * (2.0 * b1 * lmz * e33 + 2.0 * b2 * (lmx * tensor_e13 + lmy * tensor_e23));
        }
        h_mel_x[i] = hx;
        h_mel_y[i] = hy;
        h_mel_z[i] = hz;
        const double energy_density =
            b1 * (lmx * lmx * e11 + lmy * lmy * e22 + lmz * lmz * e33) +
            2.0 * b2 * (lmx * lmy * tensor_e12 + lmx * lmz * tensor_e13 + lmy * lmz * tensor_e23);
        local = energy_density * lumped_mass[i];
    } else if (i < N) {
        h_mel_x[i] = 0.0;
        h_mel_y[i] = 0.0;
        h_mel_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

void fullmag_cuda_magnetoelastic_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    const double *per_node_strain_voigt,
    double *h_mel_x,
    double *h_mel_y,
    double *h_mel_z,
    double *block_sums,
    double b1,
    double b2,
    double e11,
    double e22,
    double e33,
    double tensor_e23,
    double tensor_e13,
    double tensor_e12,
    bool use_per_node_strain,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    magnetoelastic_field_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        lumped_mass,
        magnetic_node_mask,
        per_node_strain_voigt,
        h_mel_x,
        h_mel_y,
        h_mel_z,
        block_sums,
        b1,
        b2,
        e11,
        e22,
        e33,
        tensor_e23,
        tensor_e13,
        tensor_e12,
        use_per_node_strain,
        N);
}

} // namespace fullmag::fem
