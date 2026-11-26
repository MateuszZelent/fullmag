/*
 * CUDA kernels for GPU cuDSS frequency-domain driven response.
 *
 * Owns:
 * 1. Fast per-frequency update of the 4*N_m_eff diagonal mass/damping entries
 *    in the Ruiz-scaled complex CSR values array (zero H2D matrix copies).
 * 2. Independent unscaled residual certification on GPU without duplicating
 *    the CSR matrix, using overflow/underflow-safe Blue/LAPACK ScaledNorm
 *    block reductions for both magnetic (r_q, f, q) and Poisson
 *    (r_phi, R_{phi q} q, P delta_phi, delta_phi) norms plus unscaled output
 *    x = D_c y and non-finite detection.
 */

#include <cub/cub.cuh>
#include <cuda_runtime.h>

#include <cmath>
#include <cstddef>
#include <cstdint>

namespace fullmag::fem::frequency_domain::detail {

namespace {

constexpr int kDrivenResponseCudssBlockSize = 256;
constexpr int kDrivenResponseNormMaxBlocks = 256;

static_assert(
    kDrivenResponseNormMaxBlocks <= kDrivenResponseCudssBlockSize,
    "Finalization block size must cover every partial reduction block");

struct ScaledNorm {
    double scale;
    double sum_squares;
};

struct DrivenResponseNormBundle {
    ScaledNorm r_q;
    ScaledNorm f;
    ScaledNorm q;
    ScaledNorm r_phi;
    ScaledNorm r_phi_q;
    ScaledNorm p_delta_phi;
    ScaledNorm delta_phi;
    int nonfinite;
};

struct MergeScaledNorm {
    __device__ __forceinline__ ScaledNorm operator()(ScaledNorm a, ScaledNorm b) const
    {
        if (!isfinite(a.scale)) {
            return isnan(b.scale) ? b : a;
        }
        if (!isfinite(b.scale)) {
            return b;
        }
        if (a.scale < b.scale) {
            const ScaledNorm tmp = a;
            a = b;
            b = tmp;
        }
        if (b.scale != 0.0) {
            const double ratio = b.scale / a.scale;
            a.sum_squares += b.sum_squares * (ratio * ratio);
        }
        return a;
    }
};

struct MergeDrivenResponseNormBundle {
    __device__ __forceinline__ DrivenResponseNormBundle operator()(
        const DrivenResponseNormBundle &a,
        const DrivenResponseNormBundle &b) const
    {
        const MergeScaledNorm merge;
        DrivenResponseNormBundle out;
        out.r_q = merge(a.r_q, b.r_q);
        out.f = merge(a.f, b.f);
        out.q = merge(a.q, b.q);
        out.r_phi = merge(a.r_phi, b.r_phi);
        out.r_phi_q = merge(a.r_phi_q, b.r_phi_q);
        out.p_delta_phi = merge(a.p_delta_phi, b.p_delta_phi);
        out.delta_phi = merge(a.delta_phi, b.delta_phi);
        out.nonfinite = (a.nonfinite != 0 || b.nonfinite != 0) ? 1 : 0;
        return out;
    }
};

__device__ __forceinline__ ScaledNorm accumulate_scaled_norm(
    ScaledNorm current,
    double value,
    const MergeScaledNorm &merge)
{
    const double magnitude = fabs(value);
    if (!isfinite(magnitude)) {
        if (isnan(current.scale)) {
            return current;
        }
        return {magnitude, 1.0};
    }
    if (magnitude == 0.0) {
        return current;
    }
    return merge(current, {magnitude, 1.0});
}

__device__ __forceinline__ ScaledNorm accumulate_complex_scaled_norm(
    ScaledNorm current,
    double2 value,
    const MergeScaledNorm &merge)
{
    current = accumulate_scaled_norm(current, value.x, merge);
    current = accumulate_scaled_norm(current, value.y, merge);
    return current;
}

__device__ __forceinline__ double finalize_scaled_norm(const ScaledNorm &reduced)
{
    if (!isfinite(reduced.scale)) {
        return reduced.scale;
    }
    if (reduced.scale == 0.0) {
        return 0.0;
    }
    return reduced.scale * sqrt(reduced.sum_squares);
}

__device__ __forceinline__ DrivenResponseNormBundle zero_norm_bundle()
{
    DrivenResponseNormBundle bundle{};
    bundle.r_q = {0.0, 0.0};
    bundle.f = {0.0, 0.0};
    bundle.q = {0.0, 0.0};
    bundle.r_phi = {0.0, 0.0};
    bundle.r_phi_q = {0.0, 0.0};
    bundle.p_delta_phi = {0.0, 0.0};
    bundle.delta_phi = {0.0, 0.0};
    bundle.nonfinite = 0;
    return bundle;
}

__global__ void driven_response_update_omega_entries_kernel(
    const std::uint32_t *__restrict__ slot_csr_indices,
    const double2 *__restrict__ slot_base_values,
    const double *__restrict__ slot_omega_imag_coeffs,
    double omega,
    double2 *__restrict__ csr_values,
    std::uint32_t slot_count)
{
    const std::uint32_t tid =
        static_cast<std::uint32_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (tid >= slot_count) {
        return;
    }
    const std::uint32_t csr_index = slot_csr_indices[tid];
    const double2 base = slot_base_values[tid];
    const double coeff = slot_omega_imag_coeffs[tid];
    csr_values[csr_index] = make_double2(base.x, base.y - omega * coeff);
}

__global__ void driven_response_unscaled_residual_norm_kernel(
    const std::uint32_t *__restrict__ row_ptr,
    const std::uint32_t *__restrict__ col_indices,
    const double2 *__restrict__ scaled_csr_values,
    const double *__restrict__ row_scale,
    const double *__restrict__ col_scale,
    const double2 *__restrict__ b_unscaled,
    const double2 *__restrict__ b_scaled,
    const double2 *__restrict__ y_scaled,
    std::uint32_t n_q,
    std::uint32_t n_aug,
    double2 *__restrict__ x_unscaled,
    DrivenResponseNormBundle *__restrict__ block_partials)
{
    DrivenResponseNormBundle local = zero_norm_bundle();
    const MergeScaledNorm merge;
    const std::uint32_t stride =
        static_cast<std::uint32_t>(gridDim.x) * static_cast<std::uint32_t>(blockDim.x);

    for (std::uint32_t row =
             static_cast<std::uint32_t>(blockIdx.x) * blockDim.x + threadIdx.x;
         row < n_aug;
         row += stride) {
        const double dc = col_scale[row];
        const double2 yi = y_scaled[row];
        const double2 xi = make_double2(dc * yi.x, dc * yi.y);
        x_unscaled[row] = xi;
        if (!isfinite(xi.x) || !isfinite(xi.y)) {
            local.nonfinite = 1;
        }

        const double dr = row_scale[row];
        const std::uint32_t begin = row_ptr[row];
        const std::uint32_t end = row_ptr[row + 1u];

        if (row < n_q) {
            double2 zy = make_double2(0.0, 0.0);
            for (std::uint32_t idx = begin; idx < end; ++idx) {
                const std::uint32_t col = col_indices[idx];
                const double2 a = scaled_csr_values[idx];
                const double2 y_col = y_scaled[col];
                zy.x += a.x * y_col.x - a.y * y_col.y;
                zy.y += a.x * y_col.y + a.y * y_col.x;
            }
            const double2 bs = b_scaled[row];
            const double2 r_q = make_double2((zy.x - bs.x) / dr, (zy.y - bs.y) / dr);
            const double2 f_u = b_unscaled[row];
            if (!isfinite(r_q.x) || !isfinite(r_q.y)) {
                local.nonfinite = 1;
            }
            local.r_q = accumulate_complex_scaled_norm(local.r_q, r_q, merge);
            local.f = accumulate_complex_scaled_norm(local.f, f_u, merge);
            local.q = accumulate_complex_scaled_norm(local.q, xi, merge);
        } else {
            double2 sum_q = make_double2(0.0, 0.0);
            double2 sum_p = make_double2(0.0, 0.0);
            for (std::uint32_t idx = begin; idx < end; ++idx) {
                const std::uint32_t col = col_indices[idx];
                const double2 a = scaled_csr_values[idx];
                const double2 y_col = y_scaled[col];
                const double re = a.x * y_col.x - a.y * y_col.y;
                const double im = a.x * y_col.y + a.y * y_col.x;
                if (col < n_q) {
                    sum_q.x += re;
                    sum_q.y += im;
                } else {
                    sum_p.x += re;
                    sum_p.y += im;
                }
            }
            const double2 r_phi = make_double2(
                (sum_q.x + sum_p.x) / dr,
                (sum_q.y + sum_p.y) / dr);
            const double2 term_rq = make_double2(sum_q.x / dr, sum_q.y / dr);
            const double2 term_p = make_double2(sum_p.x / dr, sum_p.y / dr);
            if (!isfinite(r_phi.x) || !isfinite(r_phi.y)) {
                local.nonfinite = 1;
            }
            local.r_phi = accumulate_complex_scaled_norm(local.r_phi, r_phi, merge);
            local.r_phi_q = accumulate_complex_scaled_norm(local.r_phi_q, term_rq, merge);
            local.p_delta_phi =
                accumulate_complex_scaled_norm(local.p_delta_phi, term_p, merge);
            local.delta_phi = accumulate_complex_scaled_norm(local.delta_phi, xi, merge);
        }
    }

    using BlockReduce =
        cub::BlockReduce<DrivenResponseNormBundle, kDrivenResponseCudssBlockSize>;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const DrivenResponseNormBundle reduced =
        BlockReduce(temp_storage).Reduce(local, MergeDrivenResponseNormBundle());
    if (threadIdx.x == 0) {
        block_partials[blockIdx.x] = reduced;
    }
}

__global__ void driven_response_unscaled_residual_finalize_kernel(
    const DrivenResponseNormBundle *__restrict__ block_partials,
    int num_blocks,
    double *__restrict__ out_norms)
{
    const DrivenResponseNormBundle local =
        (threadIdx.x < num_blocks) ? block_partials[threadIdx.x] : zero_norm_bundle();
    using BlockReduce =
        cub::BlockReduce<DrivenResponseNormBundle, kDrivenResponseCudssBlockSize>;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const DrivenResponseNormBundle reduced =
        BlockReduce(temp_storage).Reduce(local, MergeDrivenResponseNormBundle());
    if (threadIdx.x == 0) {
        out_norms[0] = finalize_scaled_norm(reduced.r_q);
        out_norms[1] = finalize_scaled_norm(reduced.f);
        out_norms[2] = finalize_scaled_norm(reduced.q);
        out_norms[3] = finalize_scaled_norm(reduced.r_phi);
        out_norms[4] = finalize_scaled_norm(reduced.r_phi_q);
        out_norms[5] = finalize_scaled_norm(reduced.p_delta_phi);
        out_norms[6] = finalize_scaled_norm(reduced.delta_phi);
        out_norms[7] = reduced.nonfinite != 0 ? 1.0 : 0.0;
    }
}

} // namespace

std::size_t driven_response_norm_partials_bytes() noexcept
{
    return static_cast<std::size_t>(kDrivenResponseNormMaxBlocks) *
        sizeof(DrivenResponseNormBundle);
}

cudaError_t launch_driven_response_update_omega_entries(
    const std::uint32_t *d_slot_csr_indices,
    const double2 *d_slot_base_values,
    const double *d_slot_omega_imag_coeffs,
    double omega,
    double2 *d_csr_values,
    std::uint32_t slot_count,
    cudaStream_t stream) noexcept
{
    if (slot_count == 0u) {
        return cudaSuccess;
    }
    if (d_slot_csr_indices == nullptr ||
        d_slot_base_values == nullptr ||
        d_slot_omega_imag_coeffs == nullptr ||
        d_csr_values == nullptr) {
        return cudaErrorInvalidValue;
    }
    const int blocks = static_cast<int>(
        (static_cast<std::uint64_t>(slot_count) + kDrivenResponseCudssBlockSize - 1u) /
        kDrivenResponseCudssBlockSize);
    driven_response_update_omega_entries_kernel<<<
        blocks, kDrivenResponseCudssBlockSize, 0, stream>>>(
        d_slot_csr_indices,
        d_slot_base_values,
        d_slot_omega_imag_coeffs,
        omega,
        d_csr_values,
        slot_count);
    return cudaGetLastError();
}

cudaError_t launch_driven_response_unscaled_residual_cert(
    const std::uint32_t *d_row_ptr,
    const std::uint32_t *d_col_indices,
    const double2 *d_scaled_csr_values,
    const double *d_row_scale,
    const double *d_col_scale,
    const double2 *d_b_unscaled,
    const double2 *d_b_scaled,
    const double2 *d_y_scaled,
    std::uint32_t n_q,
    std::uint32_t n_aug,
    double2 *d_x_unscaled,
    void *d_block_partials,
    double *d_out_norms,
    cudaStream_t stream) noexcept
{
    if (d_row_ptr == nullptr ||
        d_col_indices == nullptr ||
        d_scaled_csr_values == nullptr ||
        d_row_scale == nullptr ||
        d_col_scale == nullptr ||
        d_b_unscaled == nullptr ||
        d_b_scaled == nullptr ||
        d_y_scaled == nullptr ||
        d_x_unscaled == nullptr ||
        d_block_partials == nullptr ||
        d_out_norms == nullptr ||
        n_aug == 0u ||
        n_q > n_aug) {
        return cudaErrorInvalidValue;
    }
    const std::uint64_t blocks_needed =
        (static_cast<std::uint64_t>(n_aug) + kDrivenResponseCudssBlockSize - 1u) /
        kDrivenResponseCudssBlockSize;
    const int num_blocks = blocks_needed < 1u
        ? 1
        : (blocks_needed > static_cast<std::uint64_t>(kDrivenResponseNormMaxBlocks)
               ? kDrivenResponseNormMaxBlocks
               : static_cast<int>(blocks_needed));
    auto *partials = static_cast<DrivenResponseNormBundle *>(d_block_partials);

    driven_response_unscaled_residual_norm_kernel<<<
        num_blocks, kDrivenResponseCudssBlockSize, 0, stream>>>(
        d_row_ptr,
        d_col_indices,
        d_scaled_csr_values,
        d_row_scale,
        d_col_scale,
        d_b_unscaled,
        d_b_scaled,
        d_y_scaled,
        n_q,
        n_aug,
        d_x_unscaled,
        partials);
    const cudaError_t first_status = cudaGetLastError();
    if (first_status != cudaSuccess) {
        return first_status;
    }

    driven_response_unscaled_residual_finalize_kernel<<<
        1, kDrivenResponseCudssBlockSize, 0, stream>>>(
        partials,
        num_blocks,
        d_out_norms);
    return cudaGetLastError();
}

} // namespace fullmag::fem::frequency_domain::detail
