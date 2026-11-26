// ── GPU CUDA sparse CSR DMI kernels source contract ───────────────────
// This source owns deterministic row-wise CSR DMI field/energy SpMV, periodic
// class-reduced P^T D P CSR DMI field/energy SpMV + lift, and double-double
// compensated polarized energy increment kernels for arbitrary H1 P1 meshes
// (tet4, prism6, mixed). It does not own MFEM CSR assembly, upload/teardown,
// RK orchestration, or C ABI entrypoints.

#include "gpu/cuda/interactions/dmi/dmi_csr_kernels.hpp"

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/relaxation/double_double.cuh"

#include <cub/cub.cuh>

#include <cfloat>
#include <cmath>
#include <cstdint>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;
constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
constexpr double kTinyDevice = 1.0e-300;

template <bool ComputeEnergy>
struct DmiCsrEnergyBlockReducer {
    __device__ __forceinline__ static void reduce(
        double local_energy,
        double *energy_block_sums)
    {
        (void)local_energy;
        (void)energy_block_sums;
    }
};

template <>
struct DmiCsrEnergyBlockReducer<true> {
    __device__ __forceinline__ static void reduce(
        double local_energy,
        double *energy_block_sums)
    {
        typedef cub::BlockReduce<double, kBlockSize> BlockReduce;
        __shared__ typename BlockReduce::TempStorage temp_storage;
        const double block_sum = BlockReduce(temp_storage).Sum(local_energy);
        if (threadIdx.x == 0) {
            energy_block_sums[blockIdx.x] = block_sum;
        }
    }
};

template <bool ComputeEnergy>
__global__ void dmi_csr_field_energy_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_dx,
    const double *__restrict__ csr_dy,
    const double *__restrict__ csr_dz,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_dmi_x,
    double *__restrict__ h_dmi_y,
    double *__restrict__ h_dmi_z,
    double *__restrict__ energy_block_sums,
    double uniform_ms,
    int node_count)
{
    // No early return before cub::BlockReduce: all threads in every block
    // participate unconditionally in block-wide energy reduction.
    const int node = blockIdx.x * blockDim.x + threadIdx.x;
    double local_energy = 0.0;
    if (node < node_count) {
        double rx = 0.0;
        double ry = 0.0;
        double rz = 0.0;
        if (csr_row_offsets != nullptr) {
            const uint32_t begin = csr_row_offsets[node];
            const uint32_t end = csr_row_offsets[node + 1];
            for (uint32_t p = begin; p < end; ++p) {
                const uint32_t col = csr_col_indices[p];
                const double dx = csr_dx[p];
                const double dy = csr_dy[p];
                const double dz = csr_dz[p];
                const double mjx = mx[col];
                const double mjy = my[col];
                const double mjz = mz[col];
                // R_i += d_ij x m_j
                rx = fma(dy, mjz, fma(-dz, mjy, rx));
                ry = fma(dz, mjx, fma(-dx, mjz, ry));
                rz = fma(dx, mjy, fma(-dy, mjx, rz));
            }
        }
        const bool is_mag = (magnetic_node_mask == nullptr) || (magnetic_node_mask[node] != 0u);
        const double mass = lumped_mass != nullptr ? lumped_mass[node] : 0.0;
        const double ms_i = ms != nullptr ? ms[node] : uniform_ms;
        if (is_mag && mass > 0.0 && ms_i > 0.0) {
            const double inv_projection_mass = -1.0 / (kMu0 * ms_i * mass + kTinyDevice);
            h_dmi_x[node] = rx * inv_projection_mass;
            h_dmi_y[node] = ry * inv_projection_mass;
            h_dmi_z[node] = rz * inv_projection_mass;
        } else {
            h_dmi_x[node] = 0.0;
            h_dmi_y[node] = 0.0;
            h_dmi_z[node] = 0.0;
        }
        if (ComputeEnergy) {
            local_energy = 0.5 * (mx[node] * rx + my[node] * ry + mz[node] * rz);
        }
    }

    DmiCsrEnergyBlockReducer<ComputeEnergy>::reduce(local_energy, energy_block_sums);
}

template <bool ComputeEnergy>
__global__ void dmi_csr_periodic_residual_energy_kernel(
    const uint32_t *__restrict__ reduced_row_offsets,
    const uint32_t *__restrict__ reduced_col_indices,
    const double *__restrict__ reduced_dx,
    const double *__restrict__ reduced_dy,
    const double *__restrict__ reduced_dz,
    const uint32_t *__restrict__ periodic_reduced_representative_nodes,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ reduced_rx,
    double *__restrict__ reduced_ry,
    double *__restrict__ reduced_rz,
    double *__restrict__ energy_block_sums,
    int reduced_row_count)
{
    // No early return before cub::BlockReduce: all threads in every block
    // participate unconditionally in block-wide energy reduction.
    const int reduced = blockIdx.x * blockDim.x + threadIdx.x;
    double local_energy = 0.0;
    if (reduced < reduced_row_count) {
        double rx = 0.0;
        double ry = 0.0;
        double rz = 0.0;
        if (reduced_row_offsets != nullptr) {
            const uint32_t begin = reduced_row_offsets[reduced];
            const uint32_t end = reduced_row_offsets[reduced + 1];
            for (uint32_t p = begin; p < end; ++p) {
                const uint32_t col_reduced = reduced_col_indices[p];
                const uint32_t col_node = periodic_reduced_representative_nodes[col_reduced];
                const double dx = reduced_dx[p];
                const double dy = reduced_dy[p];
                const double dz = reduced_dz[p];
                const double mjx = mx[col_node];
                const double mjy = my[col_node];
                const double mjz = mz[col_node];
                rx = fma(dy, mjz, fma(-dz, mjy, rx));
                ry = fma(dz, mjx, fma(-dx, mjz, ry));
                rz = fma(dx, mjy, fma(-dy, mjx, rz));
            }
        }
        reduced_rx[reduced] = rx;
        reduced_ry[reduced] = ry;
        reduced_rz[reduced] = rz;
        if (ComputeEnergy) {
            const uint32_t rep_node = periodic_reduced_representative_nodes[reduced];
            local_energy = 0.5 * (mx[rep_node] * rx + my[rep_node] * ry + mz[rep_node] * rz);
        }
    }

    DmiCsrEnergyBlockReducer<ComputeEnergy>::reduce(local_energy, energy_block_sums);
}

__global__ void dmi_csr_lift_periodic_field_kernel(
    const double *__restrict__ reduced_mass,
    const uint32_t *__restrict__ periodic_reduced_node,
    const double *__restrict__ ms,
    const uint8_t *__restrict__ magnetic_node_mask,
    const double *__restrict__ reduced_rx,
    const double *__restrict__ reduced_ry,
    const double *__restrict__ reduced_rz,
    double *__restrict__ h_dmi_x,
    double *__restrict__ h_dmi_y,
    double *__restrict__ h_dmi_z,
    double uniform_ms,
    int node_count)
{
    const int node = blockIdx.x * blockDim.x + threadIdx.x;
    if (node >= node_count) {
        return;
    }
    const bool is_mag = (magnetic_node_mask == nullptr) || (magnetic_node_mask[node] != 0u);
    if (!is_mag) {
        h_dmi_x[node] = 0.0;
        h_dmi_y[node] = 0.0;
        h_dmi_z[node] = 0.0;
        return;
    }
    const uint32_t reduced = periodic_reduced_node[node];
    const double mass = reduced_mass[reduced];
    const double ms_i = ms != nullptr ? ms[node] : uniform_ms;
    if (mass > 0.0 && ms_i > 0.0) {
        const double inv_projection_mass = -1.0 / (kMu0 * ms_i * mass + kTinyDevice);
        h_dmi_x[node] = reduced_rx[reduced] * inv_projection_mass;
        h_dmi_y[node] = reduced_ry[reduced] * inv_projection_mass;
        h_dmi_z[node] = reduced_rz[reduced] * inv_projection_mass;
    } else {
        h_dmi_x[node] = 0.0;
        h_dmi_y[node] = 0.0;
        h_dmi_z[node] = 0.0;
    }
}

__global__ void dmi_csr_energy_difference_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_dx,
    const double *__restrict__ csr_dy,
    const double *__restrict__ csr_dz,
    const double *__restrict__ m0x,
    const double *__restrict__ m0y,
    const double *__restrict__ m0z,
    const double *__restrict__ m1x,
    const double *__restrict__ m1y,
    const double *__restrict__ m1z,
    const uint32_t *__restrict__ periodic_reduced_representative_nodes,
    double *__restrict__ delta_block_sums,
    double *__restrict__ absolute_block_sums,
    int row_count)
{
    // No early return before cub::BlockReduce: all threads in every block
    // participate unconditionally in both block-wide reductions.
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    gpu_relax_dd::Value local_delta_dd{0.0, 0.0};
    double local_abs = 0.0;
    if (row < row_count && csr_row_offsets != nullptr) {
        const uint32_t i = periodic_reduced_representative_nodes != nullptr
            ? periodic_reduced_representative_nodes[row]
            : static_cast<uint32_t>(row);
        const double m0ix = m0x[i];
        const double m0iy = m0y[i];
        const double m0iz = m0z[i];
        const double m1ix = m1x[i];
        const double m1iy = m1y[i];
        const double m1iz = m1z[i];

        const gpu_relax_dd::Value sx = gpu_relax_dd::two_sum(m1ix, m0ix);
        const gpu_relax_dd::Value sy = gpu_relax_dd::two_sum(m1iy, m0iy);
        const gpu_relax_dd::Value sz = gpu_relax_dd::two_sum(m1iz, m0iz);

        const double abs_m_i_x = fabs(m0ix) + fabs(m1ix);
        const double abs_m_i_y = fabs(m0iy) + fabs(m1iy);
        const double abs_m_i_z = fabs(m0iz) + fabs(m1iz);

        const uint32_t begin = csr_row_offsets[row];
        const uint32_t end = csr_row_offsets[row + 1];
        for (uint32_t p = begin; p < end; ++p) {
            const uint32_t raw_col = csr_col_indices[p];
            const uint32_t j = periodic_reduced_representative_nodes != nullptr
                ? periodic_reduced_representative_nodes[raw_col]
                : raw_col;
            const double dx = csr_dx[p];
            const double dy = csr_dy[p];
            const double dz = csr_dz[p];

            const double m0jx = m0x[j];
            const double m0jy = m0y[j];
            const double m0jz = m0z[j];
            const double m1jx = m1x[j];
            const double m1jy = m1y[j];
            const double m1jz = m1z[j];

            const gpu_relax_dd::Value qx = gpu_relax_dd::two_diff(m1jx, m0jx);
            const gpu_relax_dd::Value qy = gpu_relax_dd::two_diff(m1jy, m0jy);
            const gpu_relax_dd::Value qz = gpu_relax_dd::two_diff(m1jz, m0jz);

            // Polarized increment: 0.5 * s_i . (d_ij x q_j)
            const gpu_relax_dd::Value t0 =
                gpu_relax_dd::scale(gpu_relax_dd::multiply(sx, qz), 0.5 * dy);
            const gpu_relax_dd::Value t1 =
                gpu_relax_dd::scale(gpu_relax_dd::multiply(sx, qy), -0.5 * dz);
            const gpu_relax_dd::Value t2 =
                gpu_relax_dd::scale(gpu_relax_dd::multiply(sy, qx), 0.5 * dz);
            const gpu_relax_dd::Value t3 =
                gpu_relax_dd::scale(gpu_relax_dd::multiply(sy, qz), -0.5 * dx);
            const gpu_relax_dd::Value t4 =
                gpu_relax_dd::scale(gpu_relax_dd::multiply(sz, qy), 0.5 * dx);
            const gpu_relax_dd::Value t5 =
                gpu_relax_dd::scale(gpu_relax_dd::multiply(sz, qx), -0.5 * dy);

            local_delta_dd = gpu_relax_dd::add(local_delta_dd, t0);
            local_delta_dd = gpu_relax_dd::add(local_delta_dd, t1);
            local_delta_dd = gpu_relax_dd::add(local_delta_dd, t2);
            local_delta_dd = gpu_relax_dd::add(local_delta_dd, t3);
            local_delta_dd = gpu_relax_dd::add(local_delta_dd, t4);
            local_delta_dd = gpu_relax_dd::add(local_delta_dd, t5);

            // Conservative pre-cancellation scale plus DBL_EPSILON operand-scale
            // floor so S_abs stays conservative even when m1 ~= -m0 (s_i ~= 0).
            const double abs_m_j_x = fabs(m0jx) + fabs(m1jx);
            const double abs_m_j_y = fabs(m0jy) + fabs(m1jy);
            const double abs_m_j_z = fabs(m0jz) + fabs(m1jz);
            const double operand_scale = 0.5 * (
                fabs(dy) * (abs_m_i_x * abs_m_j_z + abs_m_i_z * abs_m_j_x) +
                fabs(dz) * (abs_m_i_x * abs_m_j_y + abs_m_i_y * abs_m_j_x) +
                fabs(dx) * (abs_m_i_y * abs_m_j_z + abs_m_i_z * abs_m_j_y));

            local_abs +=
                gpu_relax_dd::magnitude(t0) +
                gpu_relax_dd::magnitude(t1) +
                gpu_relax_dd::magnitude(t2) +
                gpu_relax_dd::magnitude(t3) +
                gpu_relax_dd::magnitude(t4) +
                gpu_relax_dd::magnitude(t5) +
                DBL_EPSILON * operand_scale;
        }
    }

    const double local_delta = gpu_relax_dd::rounded(local_delta_dd);
    typedef cub::BlockReduce<double, kBlockSize> BlockReduce;
    __shared__ typename BlockReduce::TempStorage delta_storage;
    __shared__ typename BlockReduce::TempStorage absolute_storage;
    const double block_delta = BlockReduce(delta_storage).Sum(local_delta);
    const double block_abs = BlockReduce(absolute_storage).Sum(local_abs);
    if (threadIdx.x == 0) {
        delta_block_sums[blockIdx.x] = block_delta;
        absolute_block_sums[blockIdx.x] = block_abs;
    }
}

} // namespace

void fullmag_cuda_dmi_csr_field_energy(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_dx,
    const double *csr_dy,
    const double *csr_dz,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_block_sums,
    double uniform_ms,
    int node_count,
    cudaStream_t stream)
{
    if (node_count <= 0) {
        return;
    }
    const int num_blocks = (node_count + kBlockSize - 1) / kBlockSize;
    if (energy_block_sums != nullptr) {
        dmi_csr_field_energy_kernel<true><<<num_blocks, kBlockSize, 0, stream>>>(
            csr_row_offsets,
            csr_col_indices,
            csr_dx,
            csr_dy,
            csr_dz,
            mx,
            my,
            mz,
            ms,
            lumped_mass,
            magnetic_node_mask,
            h_dmi_x,
            h_dmi_y,
            h_dmi_z,
            energy_block_sums,
            uniform_ms,
            node_count);
    } else {
        dmi_csr_field_energy_kernel<false><<<num_blocks, kBlockSize, 0, stream>>>(
            csr_row_offsets,
            csr_col_indices,
            csr_dx,
            csr_dy,
            csr_dz,
            mx,
            my,
            mz,
            ms,
            lumped_mass,
            magnetic_node_mask,
            h_dmi_x,
            h_dmi_y,
            h_dmi_z,
            nullptr,
            uniform_ms,
            node_count);
    }
}

void fullmag_cuda_dmi_csr_periodic_field_energy(
    const uint32_t *reduced_row_offsets,
    const uint32_t *reduced_col_indices,
    const double *reduced_dx,
    const double *reduced_dy,
    const double *reduced_dz,
    const double *reduced_mass,
    const uint32_t *periodic_reduced_node,
    const uint32_t *periodic_reduced_representative_nodes,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const uint8_t *magnetic_node_mask,
    double *reduced_rx,
    double *reduced_ry,
    double *reduced_rz,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_block_sums,
    double uniform_ms,
    int reduced_row_count,
    int node_count,
    cudaStream_t stream)
{
    if (reduced_row_count <= 0 || node_count <= 0) {
        return;
    }
    const int reduced_blocks = (reduced_row_count + kBlockSize - 1) / kBlockSize;
    if (energy_block_sums != nullptr) {
        dmi_csr_periodic_residual_energy_kernel<true><<<reduced_blocks, kBlockSize, 0, stream>>>(
            reduced_row_offsets,
            reduced_col_indices,
            reduced_dx,
            reduced_dy,
            reduced_dz,
            periodic_reduced_representative_nodes,
            mx,
            my,
            mz,
            reduced_rx,
            reduced_ry,
            reduced_rz,
            energy_block_sums,
            reduced_row_count);
    } else {
        dmi_csr_periodic_residual_energy_kernel<false><<<reduced_blocks, kBlockSize, 0, stream>>>(
            reduced_row_offsets,
            reduced_col_indices,
            reduced_dx,
            reduced_dy,
            reduced_dz,
            periodic_reduced_representative_nodes,
            mx,
            my,
            mz,
            reduced_rx,
            reduced_ry,
            reduced_rz,
            nullptr,
            reduced_row_count);
    }
    const int node_blocks = (node_count + kBlockSize - 1) / kBlockSize;
    dmi_csr_lift_periodic_field_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
        reduced_mass,
        periodic_reduced_node,
        ms,
        magnetic_node_mask,
        reduced_rx,
        reduced_ry,
        reduced_rz,
        h_dmi_x,
        h_dmi_y,
        h_dmi_z,
        uniform_ms,
        node_count);
}

void fullmag_cuda_dmi_csr_energy_difference(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_dx,
    const double *csr_dy,
    const double *csr_dz,
    const double *m0x,
    const double *m0y,
    const double *m0z,
    const double *m1x,
    const double *m1y,
    const double *m1z,
    double *delta_block_sums,
    double *absolute_block_sums,
    int row_count,
    cudaStream_t stream,
    const uint32_t *periodic_reduced_representative_nodes)
{
    if (row_count <= 0) {
        return;
    }
    const int num_blocks = (row_count + kBlockSize - 1) / kBlockSize;
    dmi_csr_energy_difference_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_dx,
        csr_dy,
        csr_dz,
        m0x,
        m0y,
        m0z,
        m1x,
        m1y,
        m1z,
        periodic_reduced_representative_nodes,
        delta_block_sums,
        absolute_block_sums,
        row_count);
}

} // namespace fullmag::fem
#endif
