// ── GPU CUDA anisotropy kernels source contract ───────────────────────
// This source owns local uniaxial and cubic anisotropy field/energy kernels
// and CUDA wrappers. It does not own RK orchestration, Context construction,
// plan import, exchange, demag, DMI, STT, thermal, magnetoelastic, or C ABI
// entrypoints.

#include "gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void uniaxial_anisotropy_field_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ ku,
    const double *__restrict__ ku2,
    const double *__restrict__ axis_x_field,
    const double *__restrict__ axis_y_field,
    const double *__restrict__ axis_z_field,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_ani_x,
    double *__restrict__ h_ani_y,
    double *__restrict__ h_ani_z,
    double *__restrict__ block_sums,
    double uniform_ku,
    double uniform_ku2,
    double axis_x,
    double axis_y,
    double axis_z,
    bool use_ku_field,
    bool use_ku2_field,
    bool use_axis_field,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double ku_i = use_ku_field ? ku[i] : uniform_ku;
        const double ku2_i = use_ku2_field ? ku2[i] : uniform_ku2;
        const double ux = use_axis_field ? axis_x_field[i] : axis_x;
        const double uy = use_axis_field ? axis_y_field[i] : axis_y;
        const double uz = use_axis_field ? axis_z_field[i] : axis_z;
        const double m_dot_u = mx[i] * ux + my[i] * uy + mz[i] * uz;
        const double m_dot_u2 = m_dot_u * m_dot_u;
        double hx = 0.0;
        double hy = 0.0;
        double hz = 0.0;
        if (ms_i > 0.0) {
            const double prefactor = 2.0 * ku_i / (kMu0 * ms_i);
            const double prefactor2 = 4.0 * ku2_i / (kMu0 * ms_i);
            const double coeff = prefactor * m_dot_u + prefactor2 * m_dot_u * m_dot_u2;
            hx = coeff * ux;
            hy = coeff * uy;
            hz = coeff * uz;
        }
        h_ani_x[i] = hx;
        h_ani_y[i] = hy;
        h_ani_z[i] = hz;
        local = (-ku_i * m_dot_u2 - ku2_i * m_dot_u2 * m_dot_u2) * lumped_mass[i];
    } else if (i < N) {
        h_ani_x[i] = 0.0;
        h_ani_y[i] = 0.0;
        h_ani_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void cubic_anisotropy_field_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ kc1,
    const double *__restrict__ kc2,
    const double *__restrict__ kc3,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_cubic_x,
    double *__restrict__ h_cubic_y,
    double *__restrict__ h_cubic_z,
    double *__restrict__ block_sums,
    double uniform_kc1,
    double uniform_kc2,
    double uniform_kc3,
    double c1x,
    double c1y,
    double c1z,
    double c2x,
    double c2y,
    double c2z,
    bool use_kc1_field,
    bool use_kc2_field,
    bool use_kc3_field,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const double c3x = c1y * c2z - c1z * c2y;
    const double c3y = c1z * c2x - c1x * c2z;
    const double c3z = c1x * c2y - c1y * c2x;
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double kc1_i = use_kc1_field ? kc1[i] : uniform_kc1;
        const double kc2_i = use_kc2_field ? kc2[i] : uniform_kc2;
        const double kc3_i = use_kc3_field ? kc3[i] : uniform_kc3;
        const double m1 = mx[i] * c1x + my[i] * c1y + mz[i] * c1z;
        const double m2 = mx[i] * c2x + my[i] * c2y + mz[i] * c2z;
        const double m3 = mx[i] * c3x + my[i] * c3y + mz[i] * c3z;
        const double m1sq = m1 * m1;
        const double m2sq = m2 * m2;
        const double m3sq = m3 * m3;
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

        double hx = 0.0;
        double hy = 0.0;
        double hz = 0.0;
        if (ms_i > 0.0) {
            const double inv_mu0_ms = 1.0 / (kMu0 * ms_i);
            const double pf1 = -2.0 * kc1_i * inv_mu0_ms;
            const double pf2 = -2.0 * kc2_i * inv_mu0_ms;
            const double pf3 = -4.0 * kc3_i * inv_mu0_ms;
            double g1 = pf1 * m1 * (m2sq + m3sq);
            double g2 = pf1 * m2 * (m1sq + m3sq);
            double g3 = pf1 * m3 * (m1sq + m2sq);
            if (kc2_i != 0.0) {
                g1 += pf2 * m1 * m2sq * m3sq;
                g2 += pf2 * m1sq * m2 * m3sq;
                g3 += pf2 * m1sq * m2sq * m3;
            }
            if (kc3_i != 0.0) {
                g1 += pf3 * sigma * m1 * (m2sq + m3sq);
                g2 += pf3 * sigma * m2 * (m1sq + m3sq);
                g3 += pf3 * sigma * m3 * (m1sq + m2sq);
            }
            hx = g1 * c1x + g2 * c2x + g3 * c3x;
            hy = g1 * c1y + g2 * c2y + g3 * c3y;
            hz = g1 * c1z + g2 * c2z + g3 * c3z;
        }
        h_cubic_x[i] = hx;
        h_cubic_y[i] = hy;
        h_cubic_z[i] = hz;
        local =
            (kc1_i * sigma + kc2_i * m1sq * m2sq * m3sq + kc3_i * sigma * sigma) *
            lumped_mass[i];
    } else if (i < N) {
        h_cubic_x[i] = 0.0;
        h_cubic_y[i] = 0.0;
        h_cubic_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

void fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *ku,
    const double *ku2,
    const double *axis_x_field,
    const double *axis_y_field,
    const double *axis_z_field,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_ani_x,
    double *h_ani_y,
    double *h_ani_z,
    double *block_sums,
    double uniform_ku,
    double uniform_ku2,
    double axis_x,
    double axis_y,
    double axis_z,
    bool use_ku_field,
    bool use_ku2_field,
    bool use_axis_field,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    uniaxial_anisotropy_field_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        ku,
        ku2,
        axis_x_field,
        axis_y_field,
        axis_z_field,
        lumped_mass,
        magnetic_node_mask,
        h_ani_x,
        h_ani_y,
        h_ani_z,
        block_sums,
        uniform_ku,
        uniform_ku2,
        axis_x,
        axis_y,
        axis_z,
        use_ku_field,
        use_ku2_field,
        use_axis_field,
        N);
}

void fullmag_cuda_cubic_anisotropy_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *kc1,
    const double *kc2,
    const double *kc3,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_cubic_x,
    double *h_cubic_y,
    double *h_cubic_z,
    double *block_sums,
    double uniform_kc1,
    double uniform_kc2,
    double uniform_kc3,
    double c1x,
    double c1y,
    double c1z,
    double c2x,
    double c2y,
    double c2z,
    bool use_kc1_field,
    bool use_kc2_field,
    bool use_kc3_field,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    cubic_anisotropy_field_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        kc1,
        kc2,
        kc3,
        lumped_mass,
        magnetic_node_mask,
        h_cubic_x,
        h_cubic_y,
        h_cubic_z,
        block_sums,
        uniform_kc1,
        uniform_kc2,
        uniform_kc3,
        c1x,
        c1y,
        c1z,
        c2x,
        c2y,
        c2z,
        use_kc1_field,
        use_kc2_field,
        use_kc3_field,
        N);
}

} // namespace fullmag::fem
