/*
 * GPU CUDA projected-gradient BB relaxation kernels source contract.
 *
 * Owns device-resident kernels for projected-gradient BB building blocks:
 * tangent-gradient projection from H_eff, FEM lumped-mass metric reductions,
 * and normalized nodal-sphere retraction. It does not own Armijo scheduling,
 * scalar readback policy, effective-field generation, C ABI dispatch, or CPU
 * MFEM relaxation algorithms.
 */

#include "gpu/cuda/relaxation/pgbb_kernels.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <math_constants.h>

#include <cmath>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

__device__ bool active_node(const uint8_t *mask, int i)
{
    return mask[i] != 0u;
}

__device__ double node_weight(const double *lumped_mass, int i)
{
    return lumped_mass[i];
}

__device__ double block_reduce_sum(double value)
{
    __shared__ double shared[kBlockSize];
    const int lane = threadIdx.x;
    shared[lane] = value;
    __syncthreads();
    for (int stride = kBlockSize / 2; stride > 0; stride >>= 1) {
        if (lane < stride) {
            shared[lane] += shared[lane + stride];
        }
        __syncthreads();
    }
    return shared[0];
}

__device__ void block_reduce_pair_sum(double x, double y, double &sum_x, double &sum_y)
{
    __shared__ double shared_x[kBlockSize];
    __shared__ double shared_y[kBlockSize];
    const int lane = threadIdx.x;
    shared_x[lane] = x;
    shared_y[lane] = y;
    __syncthreads();
    for (int stride = kBlockSize / 2; stride > 0; stride >>= 1) {
        if (lane < stride) {
            shared_x[lane] += shared_x[lane + stride];
            shared_y[lane] += shared_y[lane + stride];
        }
        __syncthreads();
    }
    sum_x = shared_x[0];
    sum_y = shared_y[0];
}

__device__ void block_reduce_triple_sum(
    double x,
    double y,
    double z,
    double &sum_x,
    double &sum_y,
    double &sum_z)
{
    __shared__ double shared_x[kBlockSize];
    __shared__ double shared_y[kBlockSize];
    __shared__ double shared_z[kBlockSize];
    const int lane = threadIdx.x;
    shared_x[lane] = x;
    shared_y[lane] = y;
    shared_z[lane] = z;
    __syncthreads();
    for (int stride = kBlockSize / 2; stride > 0; stride >>= 1) {
        if (lane < stride) {
            shared_x[lane] += shared_x[lane + stride];
            shared_y[lane] += shared_y[lane + stride];
            shared_z[lane] += shared_z[lane + stride];
        }
        __syncthreads();
    }
    sum_x = shared_x[0];
    sum_y = shared_y[0];
    sum_z = shared_z[0];
}

__global__ void tangent_gradient_norm_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *gx,
    double *gy,
    double *gz,
    double *block_norm_sq,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        const double mdoth = mx[i] * hx[i] + my[i] * hy[i] + mz[i] * hz[i];
        const double tx = hx[i] - mdoth * mx[i];
        const double ty = hy[i] - mdoth * my[i];
        const double tz = hz[i] - mdoth * mz[i];
        const double grad_x = -tx;
        const double grad_y = -ty;
        const double grad_z = -tz;
        gx[i] = grad_x;
        gy[i] = grad_y;
        gz[i] = grad_z;
        local = node_weight(lumped_mass, i) *
            (grad_x * grad_x + grad_y * grad_y + grad_z * grad_z);
    } else if (i < n) {
        gx[i] = 0.0;
        gy[i] = 0.0;
        gz[i] = 0.0;
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_norm_sq[blockIdx.x] = sum;
    }
}

__global__ void metric_dot_kernel(
    const double *ax,
    const double *ay,
    const double *az,
    const double *bx,
    const double *by,
    const double *bz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_dot,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        local = node_weight(lumped_mass, i) *
            (ax[i] * bx[i] + ay[i] * by[i] + az[i] * bz[i]);
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_dot[blockIdx.x] = sum;
    }
}

__global__ void retract_field_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *dx,
    const double *dy,
    const double *dz,
    const uint8_t *magnetic_node_mask,
    double step_size,
    double *out_x,
    double *out_y,
    double *out_z,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    if (!active_node(magnetic_node_mask, i)) {
        out_x[i] = mx[i];
        out_y[i] = my[i];
        out_z[i] = mz[i];
        return;
    }

    const double x = mx[i] + step_size * dx[i];
    const double y = my[i] + step_size * dy[i];
    const double z = mz[i] + step_size * dz[i];
    const double norm = sqrt(x * x + y * y + z * z);
    if (!isfinite(norm) || norm <= 0.0) {
        out_x[i] = CUDART_NAN;
        out_y[i] = CUDART_NAN;
        out_z[i] = CUDART_NAN;
        return;
    }
    const double inv = 1.0 / norm;
    out_x[i] = x * inv;
    out_y[i] = y * inv;
    out_z[i] = z * inv;
}

__global__ void project_static_periodic_field_kernel(
    double *x,
    double *y,
    double *z,
    const uint32_t *periodic_representative_nodes,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    uint32_t representative = periodic_representative_nodes[i];
    int periodic_representative_root_guard = 0;
    while (representative < static_cast<uint32_t>(n) &&
           periodic_representative_nodes[representative] != representative &&
           periodic_representative_root_guard < n) {
        representative = periodic_representative_nodes[representative];
        ++periodic_representative_root_guard;
    }
    if (representative >= static_cast<uint32_t>(n) ||
        periodic_representative_root_guard >= n ||
        representative == static_cast<uint32_t>(i)) {
        return;
    }
    x[i] = x[representative];
    y[i] = y[representative];
    z[i] = z[representative];
}

__global__ void bb_curvature_kernel(
    const double *previous_mx,
    const double *previous_my,
    const double *previous_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double curvature_scale,
    double *block_s_dot_s,
    double *block_s_dot_y,
    double *block_y_dot_y,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double ss = 0.0;
    double sy = 0.0;
    double yy = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        const double sx = (trial_mx[i] - previous_mx[i]) * curvature_scale;
        const double sy_comp = (trial_my[i] - previous_my[i]) * curvature_scale;
        const double sz = (trial_mz[i] - previous_mz[i]) * curvature_scale;
        const double yx = (trial_gx[i] - previous_gx[i]) * curvature_scale;
        const double yy_comp = (trial_gy[i] - previous_gy[i]) * curvature_scale;
        const double yz = (trial_gz[i] - previous_gz[i]) * curvature_scale;
        const double w = node_weight(lumped_mass, i);
        ss = w * (sx * sx + sy_comp * sy_comp + sz * sz);
        sy = w * (sx * yx + sy_comp * yy_comp + sz * yz);
        yy = w * (yx * yx + yy_comp * yy_comp + yz * yz);
    }

    const double ss_sum = block_reduce_sum(ss);
    const double sy_sum = block_reduce_sum(sy);
    const double yy_sum = block_reduce_sum(yy);
    if (threadIdx.x == 0) {
        block_s_dot_s[blockIdx.x] = ss_sum;
        block_s_dot_y[blockIdx.x] = sy_sum;
        block_y_dot_y[blockIdx.x] = yy_sum;
    }
}

__global__ void ncg_prepare_direction_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *gx,
    const double *gy,
    const double *gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool direction_valid,
    double *px,
    double *py,
    double *pz,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_p_dot_g = 0.0;
    double local_direction_norm_sq = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double dx = -gx[i];
        double dy = -gy[i];
        double dz = -gz[i];
        if (direction_valid) {
            const double mdotp = mx[i] * px[i] + my[i] * py[i] + mz[i] * pz[i];
            dx = px[i] - mdotp * mx[i];
            dy = py[i] - mdotp * my[i];
            dz = pz[i] - mdotp * mz[i];
        }
        px[i] = dx;
        py[i] = dy;
        pz[i] = dz;
        const double weight = node_weight(lumped_mass, i);
        local_p_dot_g = weight * (dx * gx[i] + dy * gy[i] + dz * gz[i]);
        local_direction_norm_sq = weight * (dx * dx + dy * dy + dz * dz);
    } else if (i < n) {
        px[i] = 0.0;
        py[i] = 0.0;
        pz[i] = 0.0;
    }
    double p_dot_g_sum = 0.0;
    double direction_norm_sum = 0.0;
    block_reduce_pair_sum(
        local_p_dot_g,
        local_direction_norm_sq,
        p_dot_g_sum,
        direction_norm_sum);
    if (threadIdx.x == 0) {
        block_p_dot_g[blockIdx.x] = p_dot_g_sum;
        block_direction_norm_sq[blockIdx.x] = direction_norm_sum;
    }
}

__global__ void ncg_pr_plus_numerator_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_numerator,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        const double mdotg =
            mx[i] * previous_gx[i] + my[i] * previous_gy[i] + mz[i] * previous_gz[i];
        const double transported_x = previous_gx[i] - mdotg * mx[i];
        const double transported_y = previous_gy[i] - mdotg * my[i];
        const double transported_z = previous_gz[i] - mdotg * mz[i];
        const double zx = trial_gx[i] - transported_x;
        const double zy = trial_gy[i] - transported_y;
        const double zz = trial_gz[i] - transported_z;
        local = node_weight(lumped_mass, i) *
            (trial_gx[i] * zx + trial_gy[i] * zy + trial_gz[i] * zz);
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_numerator[blockIdx.x] = sum;
    }
}

__global__ void ncg_gradient_norm_and_pr_plus_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *trial_gx,
    double *trial_gy,
    double *trial_gz,
    double *block_norm_sq,
    double *block_numerator,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_norm = 0.0;
    double local_numerator = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        const double mdoth = mx[i] * hx[i] + my[i] * hy[i] + mz[i] * hz[i];
        const double tx = hx[i] - mdoth * mx[i];
        const double ty = hy[i] - mdoth * my[i];
        const double tz = hz[i] - mdoth * mz[i];
        const double gx = -tx;
        const double gy = -ty;
        const double gz = -tz;
        trial_gx[i] = gx;
        trial_gy[i] = gy;
        trial_gz[i] = gz;

        const double weight = node_weight(lumped_mass, i);
        local_norm = weight * (gx * gx + gy * gy + gz * gz);

        const double mdot_prev_g =
            mx[i] * previous_gx[i] + my[i] * previous_gy[i] + mz[i] * previous_gz[i];
        const double transported_x = previous_gx[i] - mdot_prev_g * mx[i];
        const double transported_y = previous_gy[i] - mdot_prev_g * my[i];
        const double transported_z = previous_gz[i] - mdot_prev_g * mz[i];
        local_numerator = weight *
            (gx * (gx - transported_x) +
             gy * (gy - transported_y) +
             gz * (gz - transported_z));
    } else if (i < n) {
        trial_gx[i] = 0.0;
        trial_gy[i] = 0.0;
        trial_gz[i] = 0.0;
    }
    double norm_sum = 0.0;
    double numerator_sum = 0.0;
    block_reduce_pair_sum(local_norm, local_numerator, norm_sum, numerator_sum);
    if (threadIdx.x == 0) {
        block_norm_sq[blockIdx.x] = norm_sum;
        block_numerator[blockIdx.x] = numerator_sum;
    }
}

__global__ void ncg_gradient_direction_and_norm_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool direction_valid,
    double *gx,
    double *gy,
    double *gz,
    double *px,
    double *py,
    double *pz,
    double *block_gradient_norm_sq,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_gradient_norm = 0.0;
    double local_p_dot_g = 0.0;
    double local_direction_norm_sq = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        const double mdoth = mx[i] * hx[i] + my[i] * hy[i] + mz[i] * hz[i];
        const double tx = hx[i] - mdoth * mx[i];
        const double ty = hy[i] - mdoth * my[i];
        const double tz = hz[i] - mdoth * mz[i];
        const double grad_x = -tx;
        const double grad_y = -ty;
        const double grad_z = -tz;
        gx[i] = grad_x;
        gy[i] = grad_y;
        gz[i] = grad_z;

        double dir_x = -grad_x;
        double dir_y = -grad_y;
        double dir_z = -grad_z;
        if (direction_valid) {
            const double mdotp = mx[i] * px[i] + my[i] * py[i] + mz[i] * pz[i];
            dir_x = px[i] - mdotp * mx[i];
            dir_y = py[i] - mdotp * my[i];
            dir_z = pz[i] - mdotp * mz[i];
        }
        px[i] = dir_x;
        py[i] = dir_y;
        pz[i] = dir_z;

        const double weight = node_weight(lumped_mass, i);
        local_gradient_norm =
            weight * (grad_x * grad_x + grad_y * grad_y + grad_z * grad_z);
        local_p_dot_g =
            weight * (dir_x * grad_x + dir_y * grad_y + dir_z * grad_z);
        local_direction_norm_sq =
            weight * (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z);
    } else if (i < n) {
        gx[i] = 0.0;
        gy[i] = 0.0;
        gz[i] = 0.0;
        px[i] = 0.0;
        py[i] = 0.0;
        pz[i] = 0.0;
    }
    double gradient_norm_sum = 0.0;
    double p_dot_g_sum = 0.0;
    double direction_norm_sum = 0.0;
    block_reduce_triple_sum(
        local_gradient_norm,
        local_p_dot_g,
        local_direction_norm_sq,
        gradient_norm_sum,
        p_dot_g_sum,
        direction_norm_sum);
    if (threadIdx.x == 0) {
        block_gradient_norm_sq[blockIdx.x] = gradient_norm_sum;
        block_p_dot_g[blockIdx.x] = p_dot_g_sum;
        block_direction_norm_sq[blockIdx.x] = direction_norm_sum;
    }
}

__global__ void ncg_update_direction_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *previous_px,
    const double *previous_py,
    const double *previous_pz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double beta,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double transported_x = 0.0;
        double transported_y = 0.0;
        double transported_z = 0.0;
        if (beta != 0.0) {
            const double mdotp =
                mx[i] * previous_px[i] + my[i] * previous_py[i] + mz[i] * previous_pz[i];
            transported_x = previous_px[i] - mdotp * mx[i];
            transported_y = previous_py[i] - mdotp * my[i];
            transported_z = previous_pz[i] - mdotp * mz[i];
        }
        const double px = -trial_gx[i] + beta * transported_x;
        const double py = -trial_gy[i] + beta * transported_y;
        const double pz = -trial_gz[i] + beta * transported_z;
        next_px[i] = px;
        next_py[i] = py;
        next_pz[i] = pz;
        local = node_weight(lumped_mass, i) *
            (px * trial_gx[i] + py * trial_gy[i] + pz * trial_gz[i]);
    } else if (i < n) {
        next_px[i] = 0.0;
        next_py[i] = 0.0;
        next_pz[i] = 0.0;
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_p_dot_g[blockIdx.x] = sum;
    }
}

__global__ void ncg_update_direction_from_reduced_pr_plus_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *previous_px,
    const double *previous_py,
    const double *previous_pz,
    const double *accepted_gradient_norm_sq_scalar,
    const double *pr_plus_numerator_scalar,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double previous_gradient_norm_sq,
    double gradient_floor,
    bool previous_direction_valid,
    bool restart_step,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n)
{
    const double accepted_gradient_norm_sq = accepted_gradient_norm_sq_scalar[0];
    const double pr_plus_numerator = pr_plus_numerator_scalar[0];
    double beta = 0.0;
    if (previous_direction_valid &&
        !restart_step &&
        previous_gradient_norm_sq > gradient_floor &&
        isfinite(accepted_gradient_norm_sq) &&
        accepted_gradient_norm_sq >= 0.0 &&
        isfinite(pr_plus_numerator)) {
        beta = fmax(0.0, pr_plus_numerator / previous_gradient_norm_sq);
    }

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double transported_x = 0.0;
        double transported_y = 0.0;
        double transported_z = 0.0;
        if (beta != 0.0) {
            const double mdotp =
                mx[i] * previous_px[i] + my[i] * previous_py[i] + mz[i] * previous_pz[i];
            transported_x = previous_px[i] - mdotp * mx[i];
            transported_y = previous_py[i] - mdotp * my[i];
            transported_z = previous_pz[i] - mdotp * mz[i];
        }
        const double px = -trial_gx[i] + beta * transported_x;
        const double py = -trial_gy[i] + beta * transported_y;
        const double pz = -trial_gz[i] + beta * transported_z;
        next_px[i] = px;
        next_py[i] = py;
        next_pz[i] = pz;
        local = node_weight(lumped_mass, i) *
            (px * trial_gx[i] + py * trial_gy[i] + pz * trial_gz[i]);
    } else if (i < n) {
        next_px[i] = 0.0;
        next_py[i] = 0.0;
        next_pz[i] = 0.0;
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_p_dot_g[blockIdx.x] = sum;
    }
}

__global__ void ncg_reset_direction_if_not_descent_kernel(
    const double *gx,
    const double *gy,
    const double *gz,
    const double *p_dot_g_scalar,
    const uint8_t *magnetic_node_mask,
    double *px,
    double *py,
    double *pz,
    int n)
{
    const double p_dot_g = p_dot_g_scalar[0];
    if (isfinite(p_dot_g) && p_dot_g < 0.0) {
        return;
    }

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    if (!active_node(magnetic_node_mask, i)) {
        px[i] = 0.0;
        py[i] = 0.0;
        pz[i] = 0.0;
        return;
    }
    px[i] = -gx[i];
    py[i] = -gy[i];
    pz[i] = -gz[i];
}

} // namespace

void fullmag_cuda_relax_tangent_gradient_and_norm_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *gx,
    double *gy,
    double *gz,
    double *block_norm_sq,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    tangent_gradient_norm_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        hx,
        hy,
        hz,
        lumped_mass,
        magnetic_node_mask,
        gx,
        gy,
        gz,
        block_norm_sq,
        n);
}

void fullmag_cuda_relax_metric_dot_blocks(
    const double *ax,
    const double *ay,
    const double *az,
    const double *bx,
    const double *by,
    const double *bz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_dot,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    metric_dot_kernel<<<blocks, kBlockSize, 0, stream>>>(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        lumped_mass,
        magnetic_node_mask,
        block_dot,
        n);
}

void fullmag_cuda_relax_retract_field(
    const double *mx,
    const double *my,
    const double *mz,
    const double *dx,
    const double *dy,
    const double *dz,
    const uint8_t *magnetic_node_mask,
    double step_size,
    double *out_x,
    double *out_y,
    double *out_z,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    retract_field_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        dx,
        dy,
        dz,
        magnetic_node_mask,
        step_size,
        out_x,
        out_y,
        out_z,
        n);
}

void fullmag_cuda_relax_project_static_periodic_field(
    double *x,
    double *y,
    double *z,
    const uint32_t *periodic_representative_nodes,
    int n,
    cudaStream_t stream)
{
    if (n <= 0 || periodic_representative_nodes == nullptr) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    project_static_periodic_field_kernel<<<blocks, kBlockSize, 0, stream>>>(
        x,
        y,
        z,
        periodic_representative_nodes,
        n);
}

void fullmag_cuda_relax_bb_curvature_blocks(
    const double *previous_mx,
    const double *previous_my,
    const double *previous_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double curvature_scale,
    double *block_s_dot_s,
    double *block_s_dot_y,
    double *block_y_dot_y,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    bb_curvature_kernel<<<blocks, kBlockSize, 0, stream>>>(
        previous_mx,
        previous_my,
        previous_mz,
        trial_mx,
        trial_my,
        trial_mz,
        previous_gx,
        previous_gy,
        previous_gz,
        trial_gx,
        trial_gy,
        trial_gz,
        lumped_mass,
        magnetic_node_mask,
        curvature_scale,
        block_s_dot_s,
        block_s_dot_y,
        block_y_dot_y,
        n);
}

void fullmag_cuda_relax_ncg_prepare_direction_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *gx,
    const double *gy,
    const double *gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool direction_valid,
    double *px,
    double *py,
    double *pz,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_prepare_direction_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        gx,
        gy,
        gz,
        lumped_mass,
        magnetic_node_mask,
        direction_valid,
        px,
        py,
        pz,
        block_p_dot_g,
        block_direction_norm_sq,
        n);
}

void fullmag_cuda_relax_ncg_pr_plus_numerator_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_numerator,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_pr_plus_numerator_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        previous_gx,
        previous_gy,
        previous_gz,
        trial_gx,
        trial_gy,
        trial_gz,
        lumped_mass,
        magnetic_node_mask,
        block_numerator,
        n);
}

void fullmag_cuda_relax_ncg_gradient_norm_and_pr_plus_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *trial_gx,
    double *trial_gy,
    double *trial_gz,
    double *block_norm_sq,
    double *block_numerator,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_gradient_norm_and_pr_plus_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        hx,
        hy,
        hz,
        previous_gx,
        previous_gy,
        previous_gz,
        lumped_mass,
        magnetic_node_mask,
        trial_gx,
        trial_gy,
        trial_gz,
        block_norm_sq,
        block_numerator,
        n);
}

void fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool direction_valid,
    double *gx,
    double *gy,
    double *gz,
    double *px,
    double *py,
    double *pz,
    double *block_gradient_norm_sq,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_gradient_direction_and_norm_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        hx,
        hy,
        hz,
        lumped_mass,
        magnetic_node_mask,
        direction_valid,
        gx,
        gy,
        gz,
        px,
        py,
        pz,
        block_gradient_norm_sq,
        block_p_dot_g,
        block_direction_norm_sq,
        n);
}

void fullmag_cuda_relax_ncg_update_direction_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *previous_px,
    const double *previous_py,
    const double *previous_pz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double beta,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_update_direction_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        trial_gx,
        trial_gy,
        trial_gz,
        previous_px,
        previous_py,
        previous_pz,
        lumped_mass,
        magnetic_node_mask,
        beta,
        next_px,
        next_py,
        next_pz,
        block_p_dot_g,
        n);
}

void fullmag_cuda_relax_ncg_update_direction_from_reduced_pr_plus(
    const double *mx,
    const double *my,
    const double *mz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *previous_px,
    const double *previous_py,
    const double *previous_pz,
    const double *accepted_gradient_norm_sq_scalar,
    const double *pr_plus_numerator_scalar,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double previous_gradient_norm_sq,
    double gradient_floor,
    bool previous_direction_valid,
    bool restart_step,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_update_direction_from_reduced_pr_plus_kernel<<<blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        trial_gx,
        trial_gy,
        trial_gz,
        previous_px,
        previous_py,
        previous_pz,
        accepted_gradient_norm_sq_scalar,
        pr_plus_numerator_scalar,
        lumped_mass,
        magnetic_node_mask,
        previous_gradient_norm_sq,
        gradient_floor,
        previous_direction_valid,
        restart_step,
        next_px,
        next_py,
        next_pz,
        block_p_dot_g,
        n);
}

void fullmag_cuda_relax_ncg_reset_direction_if_not_descent(
    const double *gx,
    const double *gy,
    const double *gz,
    const double *p_dot_g_scalar,
    const uint8_t *magnetic_node_mask,
    double *px,
    double *py,
    double *pz,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    ncg_reset_direction_if_not_descent_kernel<<<blocks, kBlockSize, 0, stream>>>(
        gx,
        gy,
        gz,
        p_dot_g_scalar,
        magnetic_node_mask,
        px,
        py,
        pz,
        n);
}

} // namespace fullmag::fem
#endif
