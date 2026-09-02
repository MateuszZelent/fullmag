// ── GPU CUDA RK adaptive-error kernels source contract ────────────────
// This source owns embedded Runge-Kutta adaptive error block reductions and
// CUDA wrappers. It does not own RK step orchestration, Context construction,
// physics interactions, device-wide reductions, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/adaptive_error_kernels.hpp"

#include <cfloat>
#include <cmath>
#include <cub/cub.cuh>
#include <math_constants.h>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void adaptive_error_norm_blocks_kernel(
    const double *__restrict__ old_mx, const double *__restrict__ old_my, const double *__restrict__ old_mz,
    const double *__restrict__ new_mx, const double *__restrict__ new_my, const double *__restrict__ new_mz,
    const uint8_t *__restrict__ magnetic_node_mask,
    const double *__restrict__ k0x, const double *__restrict__ k0y, const double *__restrict__ k0z,
    const double *__restrict__ k1x, const double *__restrict__ k1y, const double *__restrict__ k1z,
    const double *__restrict__ k2x, const double *__restrict__ k2y, const double *__restrict__ k2z,
    const double *__restrict__ k3x, const double *__restrict__ k3y, const double *__restrict__ k3z,
    const double *__restrict__ k4x, const double *__restrict__ k4y, const double *__restrict__ k4z,
    const double *__restrict__ k5x, const double *__restrict__ k5y, const double *__restrict__ k5z,
    const double *__restrict__ k6x, const double *__restrict__ k6y, const double *__restrict__ k6z,
    double b_hi0, double b_hi1, double b_hi2, double b_hi3,
    double b_hi4, double b_hi5, double b_hi6,
    double b_lo0, double b_lo1, double b_lo2, double b_lo3,
    double b_lo4, double b_lo5, double b_lo6,
    double dt, double adaptive_atol, double adaptive_rtol,
    bool has_norm_tolerance, double norm_tolerance,
    bool has_max_spin_rotation, double max_spin_rotation_cos,
    double *__restrict__ block_max_scaled_error,
    double *__restrict__ block_max_norm_defect,
    double *__restrict__ block_max_spin_rotation,
    int stages,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_max = 0.0;
    double local_norm_defect = 0.0;
    double local_spin_cosine = 1.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double c0 = stages > 0 ? b_hi0 - b_lo0 : 0.0;
        const double c1 = stages > 1 ? b_hi1 - b_lo1 : 0.0;
        const double c2 = stages > 2 ? b_hi2 - b_lo2 : 0.0;
        const double c3 = stages > 3 ? b_hi3 - b_lo3 : 0.0;
        const double c4 = stages > 4 ? b_hi4 - b_lo4 : 0.0;
        const double c5 = stages > 5 ? b_hi5 - b_lo5 : 0.0;
        const double c6 = stages > 6 ? b_hi6 - b_lo6 : 0.0;

        double err_x = c0 * k0x[i];
        double err_y = c0 * k0y[i];
        double err_z = c0 * k0z[i];
        if (stages > 1) {
            err_x += c1 * k1x[i];
            err_y += c1 * k1y[i];
            err_z += c1 * k1z[i];
        }
        if (stages > 2) {
            err_x += c2 * k2x[i];
            err_y += c2 * k2y[i];
            err_z += c2 * k2z[i];
        }
        if (stages > 3) {
            err_x += c3 * k3x[i];
            err_y += c3 * k3y[i];
            err_z += c3 * k3z[i];
        }
        if (stages > 4) {
            err_x += c4 * k4x[i];
            err_y += c4 * k4y[i];
            err_z += c4 * k4z[i];
        }
        if (stages > 5) {
            err_x += c5 * k5x[i];
            err_y += c5 * k5y[i];
            err_z += c5 * k5z[i];
        }
        if (stages > 6) {
            err_x += c6 * k6x[i];
            err_y += c6 * k6y[i];
            err_z += c6 * k6z[i];
        }
        err_x *= dt;
        err_y *= dt;
        err_z *= dt;

        const double error_norm = sqrt(err_x * err_x + err_y * err_y + err_z * err_z);
        const double old_state_norm = sqrt(
            old_mx[i] * old_mx[i] + old_my[i] * old_my[i] + old_mz[i] * old_mz[i]);
        const double high_order_state_norm = sqrt(
            new_mx[i] * new_mx[i] + new_my[i] * new_my[i] + new_mz[i] * new_mz[i]);
        const double scale = adaptive_atol + adaptive_rtol *
            fmax(old_state_norm, high_order_state_norm);
        if (!isfinite(error_norm) || !isfinite(old_state_norm) ||
            !isfinite(high_order_state_norm) || !isfinite(scale) || scale <= 0.0 ||
            old_state_norm < DBL_MIN || high_order_state_norm < DBL_MIN) {
            local_max = CUDART_INF;
        } else {
            local_max = error_norm / scale;
            local_norm_defect = fabs(high_order_state_norm - 1.0);
            const double normalized_dot = fmin(1.0, fmax(-1.0,
                ((old_mx[i] * new_mx[i] + old_my[i] * new_my[i] +
                  old_mz[i] * new_mz[i]) / old_state_norm) /
                high_order_state_norm));
            local_spin_cosine = normalized_dot;
            if (has_norm_tolerance) {
                local_max = fmax(local_max, local_norm_defect / norm_tolerance);
            }
            if (has_max_spin_rotation) {
                // Compare cos(theta) directly. The angle is reconstructed
                // once after the block reduction, never per node.
                if (normalized_dot < max_spin_rotation_cos) {
                    local_max = CUDART_INF;
                }
            }
        }
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage error_storage;
    __shared__ typename BlockReduce::TempStorage norm_storage;
    __shared__ typename BlockReduce::TempStorage rotation_storage;
    const double block_max = BlockReduce(error_storage).Reduce(local_max, cub::Max());
    const double block_norm_defect = BlockReduce(norm_storage).Reduce(local_norm_defect, cub::Max());
    const double block_spin_rotation = BlockReduce(rotation_storage).Reduce(local_spin_cosine, cub::Min());
    if (threadIdx.x == 0) {
        block_max_scaled_error[blockIdx.x] = block_max;
        block_max_norm_defect[blockIdx.x] = block_norm_defect;
        block_max_spin_rotation[blockIdx.x] = block_spin_rotation;
    }
}

void fullmag_cuda_adaptive_error_norm_blocks(
    const double *old_mx, const double *old_my, const double *old_mz,
    const double *new_mx, const double *new_my, const double *new_mz,
    const uint8_t *magnetic_node_mask,
    const double *k0x, const double *k0y, const double *k0z,
    const double *k1x, const double *k1y, const double *k1z,
    const double *k2x, const double *k2y, const double *k2z,
    const double *k3x, const double *k3y, const double *k3z,
    const double *k4x, const double *k4y, const double *k4z,
    const double *k5x, const double *k5y, const double *k5z,
    const double *k6x, const double *k6y, const double *k6z,
    double b_hi0, double b_hi1, double b_hi2, double b_hi3,
    double b_hi4, double b_hi5, double b_hi6,
    double b_lo0, double b_lo1, double b_lo2, double b_lo3,
    double b_lo4, double b_lo5, double b_lo6,
    double dt, double adaptive_atol, double adaptive_rtol,
    bool has_norm_tolerance, double norm_tolerance,
    bool has_max_spin_rotation, double max_spin_rotation,
    double *block_max_scaled_error,
    double *block_max_norm_defect,
    double *block_max_spin_rotation,
    int stages,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    adaptive_error_norm_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        old_mx, old_my, old_mz,
        new_mx, new_my, new_mz,
        magnetic_node_mask,
        k0x, k0y, k0z,
        k1x, k1y, k1z,
        k2x, k2y, k2z,
        k3x, k3y, k3z,
        k4x, k4y, k4z,
        k5x, k5y, k5z,
        k6x, k6y, k6z,
        b_hi0, b_hi1, b_hi2, b_hi3, b_hi4, b_hi5, b_hi6,
        b_lo0, b_lo1, b_lo2, b_lo3, b_lo4, b_lo5, b_lo6,
        dt, adaptive_atol, adaptive_rtol,
        has_norm_tolerance, norm_tolerance,
        has_max_spin_rotation,
        has_max_spin_rotation ? cos(max_spin_rotation) : -1.0,
        block_max_scaled_error,
        block_max_norm_defect,
        block_max_spin_rotation,
        stages,
        N);
}

__global__ void finalize_spin_rotation_kernel(double *__restrict__ value)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        const double cosine = fmin(1.0, fmax(-1.0, value[0]));
        value[0] = acos(cosine);
    }
}

__global__ void merge_spin_rotation_error_kernel(
    double *__restrict__ error_norm,
    const double *__restrict__ max_spin_rotation,
    double max_spin_rotation_limit)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        const double rotation = max_spin_rotation[0];
        const double ratio = rotation / max_spin_rotation_limit;
        error_norm[0] = fmax(error_norm[0], ratio);
    }
}

void fullmag_cuda_finalize_spin_rotation(
    double *reduced_min_cosine,
    cudaStream_t stream)
{
    finalize_spin_rotation_kernel<<<1, 1, 0, stream>>>(reduced_min_cosine);
}

void fullmag_cuda_merge_spin_rotation_error(
    double *error_norm,
    const double *max_spin_rotation,
    double max_spin_rotation_limit,
    cudaStream_t stream)
{
    merge_spin_rotation_error_kernel<<<1, 1, 0, stream>>>(
        error_norm,
        max_spin_rotation,
        max_spin_rotation_limit);
}

} // namespace fullmag::fem
