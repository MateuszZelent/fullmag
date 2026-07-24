// ── GPU CUDA exchange kernels source contract ─────────────────────────
// This source owns legacy sparse exchange CUDA wrapper implementations. It
// does not own exchange readiness planning, MFEM exchange assembly, CPU
// fallback exchange, RK step orchestration, local interaction kernels, or C ABI
// entrypoints.

#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/relaxation/double_double.cuh"

#include <cub/cub.cuh>

#include <cfloat>
#include <cmath>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

struct ExchangeDoubleDouble {
    double hi;
    double lo;
};

__device__ __forceinline__ ExchangeDoubleDouble exchange_two_sum(double a, double b)
{
    const double hi = a + b;
    const double b_virtual = hi - a;
    const double lo = (a - (hi - b_virtual)) + (b - b_virtual);
    return {hi, lo};
}

__device__ __forceinline__ ExchangeDoubleDouble exchange_two_diff(double a, double b)
{
    const double hi = a - b;
    const double b_virtual = a - hi;
    const double lo = (a - (hi + b_virtual)) + (b_virtual - b);
    return {hi, lo};
}

__device__ __forceinline__ ExchangeDoubleDouble exchange_dd_add(
    ExchangeDoubleDouble a,
    ExchangeDoubleDouble b)
{
    const ExchangeDoubleDouble sum = exchange_two_sum(a.hi, b.hi);
    const ExchangeDoubleDouble correction =
        exchange_two_sum(sum.lo, a.lo + b.lo);
    const ExchangeDoubleDouble normalized =
        exchange_two_sum(sum.hi, correction.hi);
    return {normalized.hi, normalized.lo + correction.lo};
}

__device__ __forceinline__ ExchangeDoubleDouble exchange_dd_sub(
    ExchangeDoubleDouble a,
    ExchangeDoubleDouble b)
{
    return exchange_dd_add(a, {-b.hi, -b.lo});
}

__device__ __forceinline__ ExchangeDoubleDouble exchange_dd_mul(
    ExchangeDoubleDouble a,
    ExchangeDoubleDouble b)
{
    const double product = a.hi * b.hi;
    const double product_error = fma(a.hi, b.hi, -product);
    const double correction =
        product_error + a.hi * b.lo + a.lo * b.hi + a.lo * b.lo;
    return exchange_two_sum(product, correction);
}

__device__ __forceinline__ ExchangeDoubleDouble exchange_dd_scale(
    ExchangeDoubleDouble value,
    double scale)
{
    const double product = value.hi * scale;
    const double correction =
        fma(value.hi, scale, -product) + value.lo * scale;
    return exchange_two_sum(product, correction);
}

__device__ __forceinline__ ExchangeDoubleDouble exchange_polarized_edge_term(
    double m0_row,
    double m1_row,
    double m0_col,
    double m1_col,
    double edge_weight)
{
    const ExchangeDoubleDouble row_difference = exchange_two_diff(m1_row, m0_row);
    const ExchangeDoubleDouble col_difference = exchange_two_diff(m1_col, m0_col);
    const ExchangeDoubleDouble row_sum = exchange_two_sum(m1_row, m0_row);
    const ExchangeDoubleDouble col_sum = exchange_two_sum(m1_col, m0_col);
    return exchange_dd_scale(
        exchange_dd_mul(
            exchange_dd_sub(row_difference, col_difference),
            exchange_dd_sub(row_sum, col_sum)),
        edge_weight);
}

__device__ __forceinline__ double exchange_polarized_operand_scale(
    double m0_row,
    double m1_row,
    double m0_col,
    double m1_col)
{
    const ExchangeDoubleDouble change_difference = exchange_dd_sub(
        exchange_two_diff(m1_row, m0_row),
        exchange_two_diff(m1_col, m0_col));
    const ExchangeDoubleDouble endpoint_sum_difference = exchange_dd_sub(
        exchange_two_sum(m1_row, m0_row),
        exchange_two_sum(m1_col, m0_col));
    return (fabs(change_difference.hi) + fabs(change_difference.lo)) *
        (fabs(endpoint_sum_difference.hi) +
         fabs(endpoint_sum_difference.lo));
}

__global__ void legacy_sparse_exchange_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ m_component,
    const double *__restrict__ ms,
    const double *__restrict__ inv_lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_component,
    int rows)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_component[row] = 0.0;
        return;
    }

    const double ms_i = ms[row];
    const double inv_mass = inv_lumped_mass[row];
    if (ms_i <= 0.0 || inv_mass <= 0.0) {
        h_component[row] = 0.0;
        return;
    }

    gpu_relax_dd::Value km{0.0, 0.0};
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        const uint32_t col = csr_col_indices[cursor];
        if (col != static_cast<uint32_t>(row)) {
            km = gpu_relax_dd::add(
                km,
                gpu_relax_dd::scale(
                    gpu_relax_dd::two_diff(
                        m_component[col], m_component[row]),
                    csr_values[cursor]));
        }
    }
    h_component[row] =
        -(2.0 / (kMu0 * ms_i)) * gpu_relax_dd::rounded(km) * inv_mass;
}

__global__ void legacy_sparse_exchange_energy_blocks_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ block_sums,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (row < rows) {
        const uint32_t begin = csr_row_offsets[row];
        const uint32_t end = csr_row_offsets[row + 1];
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            const uint32_t col = csr_col_indices[cursor];
            if (col == static_cast<uint32_t>(row)) {
                continue;
            }
            const double value = csr_values[cursor];
            const double dx = mx[row] - mx[col];
            const double dy = my[row] - my[col];
            const double dz = mz[row] - mz[col];
            local += -0.5 * value *
                (dx * dx + dy * dy + dz * dz);
        }
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void legacy_sparse_exchange_difference_blocks_kernel(
    const uint32_t *rows, const uint32_t *cols, const double *values,
    const double *m0x, const double *m0y, const double *m0z,
    const double *m1x, const double *m1y, const double *m1z,
    double *block_sums, double *block_absolute_terms, int n)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    double local_absolute = 0.0;
    if (row < n) {
        for (uint32_t p = rows[row]; p < rows[row + 1]; ++p) {
            const uint32_t col = cols[p];
            if (col == static_cast<uint32_t>(row)) {
                continue;
            }
            const double a = values[p];
            const double edge_weight = -0.5 * a;
            const ExchangeDoubleDouble term_x_dd = exchange_polarized_edge_term(
                m0x[row], m1x[row], m0x[col], m1x[col], edge_weight);
            const ExchangeDoubleDouble term_y_dd = exchange_polarized_edge_term(
                m0y[row], m1y[row], m0y[col], m1y[col], edge_weight);
            const ExchangeDoubleDouble term_z_dd = exchange_polarized_edge_term(
                m0z[row], m1z[row], m0z[col], m1z[col], edge_weight);
            const double term_x = term_x_dd.hi + term_x_dd.lo;
            const double term_y = term_y_dd.hi + term_y_dd.lo;
            const double term_z = term_z_dd.hi + term_z_dd.lo;
            local += term_x + term_y + term_z;
            const double input_scale_x = exchange_polarized_operand_scale(
                m0x[row], m1x[row], m0x[col], m1x[col]);
            const double input_scale_y = exchange_polarized_operand_scale(
                m0y[row], m1y[row], m0y[col], m1y[col]);
            const double input_scale_z = exchange_polarized_operand_scale(
                m0z[row], m1z[row], m0z[col], m1z[col]);
            local_absolute +=
                fabs(term_x_dd.hi) + fabs(term_x_dd.lo) +
                fabs(term_y_dd.hi) + fabs(term_y_dd.lo) +
                fabs(term_z_dd.hi) + fabs(term_z_dd.lo) +
                DBL_EPSILON * fabs(edge_weight) *
                    (input_scale_x + input_scale_y + input_scale_z);
        }
    }
    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage delta_storage;
    __shared__ typename BlockReduce::TempStorage absolute_storage;
    const double sum = BlockReduce(delta_storage).Sum(local);
    const double absolute_sum =
        BlockReduce(absolute_storage).Sum(local_absolute);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = sum;
        block_absolute_terms[blockIdx.x] = absolute_sum;
    }
}

__global__ void periodic_legacy_sparse_exchange_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ m_component,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint32_t *__restrict__ periodic_reduced_node,
    const uint32_t *__restrict__ periodic_representative_nodes,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_component,
    int rows)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_component[row] = 0.0;
        return;
    }

    const uint32_t reduced = periodic_reduced_node[row];
    const uint32_t representative = periodic_representative_nodes[row];
    if (representative >= static_cast<uint32_t>(rows)) {
        h_component[row] = 0.0;
        return;
    }

    double reduced_km = 0.0;
    double reduced_mass = 0.0;
    for (int source_row = 0; source_row < rows; ++source_row) {
        if (periodic_reduced_node[source_row] != reduced) {
            continue;
        }
        reduced_mass += lumped_mass[source_row];
        double km = 0.0;
        const uint32_t begin = csr_row_offsets[source_row];
        const uint32_t end = csr_row_offsets[source_row + 1];
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            const uint32_t col = csr_col_indices[cursor];
            if (col != static_cast<uint32_t>(source_row)) {
                km += csr_values[cursor] *
                    (m_component[col] - m_component[source_row]);
            }
        }
        reduced_km += km;
    }

    const double ms_i = ms[representative];
    if (ms_i <= 0.0 || reduced_mass <= 0.0) {
        h_component[row] = 0.0;
        return;
    }
    h_component[row] = -(2.0 / (kMu0 * ms_i)) * reduced_km / reduced_mass;
}

void fullmag_cuda_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *m_component,
    const double *ms,
    const double *inv_lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    legacy_sparse_exchange_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        m_component,
        ms,
        inv_lumped_mass,
        magnetic_node_mask,
        h_component,
        rows);
}

void fullmag_cuda_periodic_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *m_component,
    const double *ms,
    const double *lumped_mass,
    const uint32_t *periodic_reduced_node,
    const uint32_t *periodic_representative_nodes,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    periodic_legacy_sparse_exchange_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        m_component,
        ms,
        lumped_mass,
        periodic_reduced_node,
        periodic_representative_nodes,
        magnetic_node_mask,
        h_component,
        rows);
}

void fullmag_cuda_legacy_sparse_exchange_energy_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *mx,
    const double *my,
    const double *mz,
    double *block_sums,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    legacy_sparse_exchange_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        mx,
        my,
        mz,
        block_sums,
        rows);
}

void fullmag_cuda_legacy_sparse_exchange_difference_blocks(
    const uint32_t *rows, const uint32_t *cols, const double *values,
    const double *m0x, const double *m0y, const double *m0z,
    const double *m1x, const double *m1y, const double *m1z,
    double *blocks, double *block_absolute_terms, int n, cudaStream_t stream)
{
    legacy_sparse_exchange_difference_blocks_kernel<<<(n + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        rows, cols, values, m0x, m0y, m0z, m1x, m1y, m1z,
        blocks, block_absolute_terms, n);
}

} // namespace fullmag::fem
