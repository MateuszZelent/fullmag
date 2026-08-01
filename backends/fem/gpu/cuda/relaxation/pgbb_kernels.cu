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
#include "gpu/cuda/relaxation/double_double.cuh"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <math_constants.h>

#include <cfloat>
#include <cmath>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;
constexpr double kMu0 = 4.0e-7 * CUDART_PI;

__device__ bool active_node(const uint8_t *mask, int i)
{
    return mask[i] != 0u;
}

__device__ double node_weight(const double *lumped_mass, int i)
{
    return lumped_mass[i];
}

__device__ bool project_node_tangent(
    double mx,
    double my,
    double mz,
    double vx,
    double vy,
    double vz,
    double &px,
    double &py,
    double &pz)
{
    using gpu_relax_dd::Value;
    const Value norm_sq_dd = gpu_relax_dd::dot3(mx, my, mz, mx, my, mz);
    const double norm_sq = gpu_relax_dd::rounded(norm_sq_dd);
    if (!isfinite(norm_sq) || norm_sq <= 0.0) {
        px = CUDART_NAN;
        py = CUDART_NAN;
        pz = CUDART_NAN;
        return false;
    }
    const double scale = gpu_relax_dd::rounded(
        gpu_relax_dd::dot3(mx, my, mz, vx, vy, vz)) / norm_sq;
    px = gpu_relax_dd::rounded(gpu_relax_dd::subtract(
        Value{vx, 0.0}, gpu_relax_dd::two_product(scale, mx)));
    py = gpu_relax_dd::rounded(gpu_relax_dd::subtract(
        Value{vy, 0.0}, gpu_relax_dd::two_product(scale, my)));
    pz = gpu_relax_dd::rounded(gpu_relax_dd::subtract(
        Value{vz, 0.0}, gpu_relax_dd::two_product(scale, mz)));
    const double residual = gpu_relax_dd::rounded(
        gpu_relax_dd::dot3(mx, my, mz, px, py, pz));
    const double correction = residual / norm_sq;
    px = gpu_relax_dd::rounded(gpu_relax_dd::subtract(
        Value{px, 0.0}, gpu_relax_dd::two_product(correction, mx)));
    py = gpu_relax_dd::rounded(gpu_relax_dd::subtract(
        Value{py, 0.0}, gpu_relax_dd::two_product(correction, my)));
    pz = gpu_relax_dd::rounded(gpu_relax_dd::subtract(
        Value{pz, 0.0}, gpu_relax_dd::two_product(correction, mz)));
    return isfinite(px) && isfinite(py) && isfinite(pz);
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

__device__ void block_reduce_quad_sum(
    double x,
    double y,
    double z,
    double w,
    double &sum_x,
    double &sum_y,
    double &sum_z,
    double &sum_w)
{
    __shared__ double shared_x[kBlockSize];
    __shared__ double shared_y[kBlockSize];
    __shared__ double shared_z[kBlockSize];
    __shared__ double shared_w[kBlockSize];
    const int lane = threadIdx.x;
    shared_x[lane] = x;
    shared_y[lane] = y;
    shared_z[lane] = z;
    shared_w[lane] = w;
    __syncthreads();
    for (int stride = kBlockSize / 2; stride > 0; stride >>= 1) {
        if (lane < stride) {
            shared_x[lane] += shared_x[lane + stride];
            shared_y[lane] += shared_y[lane + stride];
            shared_z[lane] += shared_z[lane + stride];
            shared_w[lane] += shared_w[lane + stride];
        }
        __syncthreads();
    }
    sum_x = shared_x[0];
    sum_y = shared_y[0];
    sum_z = shared_z[0];
    sum_w = shared_w[0];
}

__device__ gpu_relax_dd::Value cubic_energy_density_dd(
    double mx, double my, double mz,
    double kc1, double kc2, double kc3,
    double c1x, double c1y, double c1z,
    double c2x, double c2y, double c2z,
    double c3x, double c3y, double c3z)
{
    using gpu_relax_dd::Value;
    const Value q1 = gpu_relax_dd::dot3(mx, my, mz, c1x, c1y, c1z);
    const Value q2 = gpu_relax_dd::dot3(mx, my, mz, c2x, c2y, c2z);
    const Value q3 = gpu_relax_dd::dot3(mx, my, mz, c3x, c3y, c3z);
    const Value q1sq = gpu_relax_dd::multiply(q1, q1);
    const Value q2sq = gpu_relax_dd::multiply(q2, q2);
    const Value q3sq = gpu_relax_dd::multiply(q3, q3);
    const Value q1q2 = gpu_relax_dd::multiply(q1sq, q2sq);
    const Value q2q3 = gpu_relax_dd::multiply(q2sq, q3sq);
    const Value q1q3 = gpu_relax_dd::multiply(q1sq, q3sq);
    const Value sigma = gpu_relax_dd::add(
        gpu_relax_dd::add(q1q2, q2q3), q1q3);
    return gpu_relax_dd::add(
        gpu_relax_dd::add(
            gpu_relax_dd::scale(sigma, kc1),
            gpu_relax_dd::scale(gpu_relax_dd::multiply(q1q2, q3sq), kc2)),
        gpu_relax_dd::scale(gpu_relax_dd::multiply(sigma, sigma), kc3));
}

__global__ void direct_energy_difference_kernel(
    const double *current_mx, const double *current_my, const double *current_mz,
    const double *trial_mx, const double *trial_my, const double *trial_mz,
    const double *current_hx, const double *current_hy, const double *current_hz,
    const double *trial_hx, const double *trial_hy, const double *trial_hz,
    const double *h_ext_x, const double *h_ext_y, const double *h_ext_z,
    const double *ms, const double *ku, const double *ku2,
    const double *kc1, const double *kc2, const double *kc3,
    const double *axis_x, const double *axis_y, const double *axis_z,
    const double *lumped_mass, const uint8_t *mask,
    bool demag_enabled,
    bool external_enabled,
    bool uniaxial_enabled,
    bool cubic_enabled,
    double uniform_ku, double uniform_ku2, bool use_ku_field, bool use_ku2_field,
    double uniform_kc1, double uniform_kc2, double uniform_kc3,
    double c1x, double c1y, double c1z,
    double c2x, double c2y, double c2z,
    bool use_kc1_field, bool use_kc2_field, bool use_kc3_field,
    double *block_delta, double *block_absolute,
    double *block_demag_delta, double *block_demag_absolute, int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double delta = 0.0;
    double demag = 0.0;
    double demag_absolute = 0.0;
    double local_absolute = 0.0;
    if (i < n && active_node(mask, i)) {
        using gpu_relax_dd::Value;
        const Value dx = gpu_relax_dd::two_diff(trial_mx[i], current_mx[i]);
        const Value dy = gpu_relax_dd::two_diff(trial_my[i], current_my[i]);
        const Value dz = gpu_relax_dd::two_diff(trial_mz[i], current_mz[i]);
        const double volume = lumped_mass[i];
        const double demag_weight = demag_enabled
            ? -0.5 * kMu0 * ms[i] * volume
            : 0.0;
        const Value demag_x_dd = gpu_relax_dd::scale(
            gpu_relax_dd::multiply(
                dx, gpu_relax_dd::two_sum(current_hx[i], trial_hx[i])),
            demag_weight);
        const Value demag_y_dd = gpu_relax_dd::scale(
            gpu_relax_dd::multiply(
                dy, gpu_relax_dd::two_sum(current_hy[i], trial_hy[i])),
            demag_weight);
        const Value demag_z_dd = gpu_relax_dd::scale(
            gpu_relax_dd::multiply(
                dz, gpu_relax_dd::two_sum(current_hz[i], trial_hz[i])),
            demag_weight);
        const Value demag_dd = gpu_relax_dd::add(
            gpu_relax_dd::add(demag_x_dd, demag_y_dd), demag_z_dd);
        demag = gpu_relax_dd::rounded(demag_dd);
        demag_absolute =
            gpu_relax_dd::magnitude(demag_x_dd) +
            gpu_relax_dd::magnitude(demag_y_dd) +
            gpu_relax_dd::magnitude(demag_z_dd);

        const double zeeman_weight = external_enabled
            ? -kMu0 * ms[i] * volume
            : 0.0;
        const Value zeeman_x_dd = gpu_relax_dd::scale(
            gpu_relax_dd::scale(dx, h_ext_x[i]), zeeman_weight);
        const Value zeeman_y_dd = gpu_relax_dd::scale(
            gpu_relax_dd::scale(dy, h_ext_y[i]), zeeman_weight);
        const Value zeeman_z_dd = gpu_relax_dd::scale(
            gpu_relax_dd::scale(dz, h_ext_z[i]), zeeman_weight);
        const Value zeeman_dd = gpu_relax_dd::add(
            gpu_relax_dd::add(zeeman_x_dd, zeeman_y_dd), zeeman_z_dd);
        const Value q0 = gpu_relax_dd::dot3(
            current_mx[i], current_my[i], current_mz[i],
            axis_x[i], axis_y[i], axis_z[i]);
        const Value q1 = gpu_relax_dd::dot3(
            trial_mx[i], trial_my[i], trial_mz[i],
            axis_x[i], axis_y[i], axis_z[i]);
        const Value q0sq = gpu_relax_dd::multiply(q0, q0);
        const Value q1sq = gpu_relax_dd::multiply(q1, q1);
        const Value quadratic_difference_dd = gpu_relax_dd::multiply(
            gpu_relax_dd::subtract(q1, q0), gpu_relax_dd::add(q1, q0));
        const Value quartic_difference_dd = gpu_relax_dd::multiply(
            quadratic_difference_dd, gpu_relax_dd::add(q1sq, q0sq));
        const double ku_i = use_ku_field ? ku[i] : uniform_ku;
        const double ku2_i = use_ku2_field ? ku2[i] : uniform_ku2;
        const Value anisotropy_ku_dd = uniaxial_enabled
            ? gpu_relax_dd::scale(quadratic_difference_dd, -volume * ku_i)
            : Value{0.0, 0.0};
        const Value anisotropy_ku2_dd = uniaxial_enabled
            ? gpu_relax_dd::scale(quartic_difference_dd, -volume * ku2_i)
            : Value{0.0, 0.0};
        const Value anisotropy_dd =
            gpu_relax_dd::add(anisotropy_ku_dd, anisotropy_ku2_dd);
        const double c3x = c1y * c2z - c1z * c2y;
        const double c3y = c1z * c2x - c1x * c2z;
        const double c3z = c1x * c2y - c1y * c2x;
        const double kc1_i = use_kc1_field ? kc1[i] : uniform_kc1;
        const double kc2_i = use_kc2_field ? kc2[i] : uniform_kc2;
        const double kc3_i = use_kc3_field ? kc3[i] : uniform_kc3;
        const Value cubic_base_dd = cubic_enabled
            ? cubic_energy_density_dd(
                  current_mx[i], current_my[i], current_mz[i],
                  kc1_i, kc2_i, kc3_i,
                  c1x, c1y, c1z, c2x, c2y, c2z, c3x, c3y, c3z)
            : Value{0.0, 0.0};
        const Value cubic_trial_dd = cubic_enabled
            ? cubic_energy_density_dd(
                  trial_mx[i], trial_my[i], trial_mz[i],
                  kc1_i, kc2_i, kc3_i,
                  c1x, c1y, c1z, c2x, c2y, c2z, c3x, c3y, c3z)
            : Value{0.0, 0.0};
        const Value cubic_delta_dd = gpu_relax_dd::scale(
            gpu_relax_dd::subtract(cubic_trial_dd, cubic_base_dd), volume);
        delta = gpu_relax_dd::rounded(gpu_relax_dd::add(
            gpu_relax_dd::add(
                gpu_relax_dd::add(demag_dd, zeeman_dd), anisotropy_dd),
            cubic_delta_dd));
        const double demag_scale = fabs(demag_weight) * (
            (fabs(trial_mx[i]) + fabs(current_mx[i])) *
                (fabs(current_hx[i]) + fabs(trial_hx[i])) +
            (fabs(trial_my[i]) + fabs(current_my[i])) *
                (fabs(current_hy[i]) + fabs(trial_hy[i])) +
            (fabs(trial_mz[i]) + fabs(current_mz[i])) *
                (fabs(current_hz[i]) + fabs(trial_hz[i])));
        const double zeeman_scale = fabs(zeeman_weight) * (
            (fabs(trial_mx[i]) + fabs(current_mx[i])) * fabs(h_ext_x[i]) +
            (fabs(trial_my[i]) + fabs(current_my[i])) * fabs(h_ext_y[i]) +
            (fabs(trial_mz[i]) + fabs(current_mz[i])) * fabs(h_ext_z[i]));
        const double q_difference_scale =
            gpu_relax_dd::magnitude(gpu_relax_dd::subtract(q1, q0));
        const double q_sum_scale =
            gpu_relax_dd::magnitude(gpu_relax_dd::add(q1, q0));
        const double quadratic_scale = q_difference_scale * q_sum_scale;
        const double quartic_scale = quadratic_scale *
            (gpu_relax_dd::magnitude(q1sq) +
             gpu_relax_dd::magnitude(q0sq));
        const double anisotropy_scale = uniaxial_enabled
            ? fabs(volume) *
                (fabs(ku_i) * quadratic_scale +
                 fabs(ku2_i) * quartic_scale)
            : 0.0;
        const double cubic_scale = cubic_enabled
            ? fabs(volume) * (
                  gpu_relax_dd::magnitude(cubic_base_dd) +
                  gpu_relax_dd::magnitude(cubic_trial_dd))
            : 0.0;
        demag_absolute += DBL_EPSILON * demag_scale;
        local_absolute =
            demag_absolute +
            gpu_relax_dd::magnitude(zeeman_x_dd) +
            gpu_relax_dd::magnitude(zeeman_y_dd) +
            gpu_relax_dd::magnitude(zeeman_z_dd) +
            gpu_relax_dd::magnitude(anisotropy_ku_dd) +
            gpu_relax_dd::magnitude(anisotropy_ku2_dd) +
            gpu_relax_dd::magnitude(cubic_delta_dd) +
            DBL_EPSILON * (zeeman_scale + anisotropy_scale + cubic_scale);
    }
    double sum_delta = 0.0;
    double sum_absolute = 0.0;
    double sum_demag_delta = 0.0;
    double sum_demag_absolute = 0.0;
    block_reduce_quad_sum(
        delta,
        local_absolute,
        demag,
        demag_absolute,
        sum_delta,
        sum_absolute,
        sum_demag_delta,
        sum_demag_absolute);
    if (threadIdx.x == 0) {
        block_delta[blockIdx.x] = sum_delta;
        block_absolute[blockIdx.x] = sum_absolute;
        block_demag_delta[blockIdx.x] = sum_demag_delta;
        block_demag_absolute[blockIdx.x] = sum_demag_absolute;
    }
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
        double tx = 0.0;
        double ty = 0.0;
        double tz = 0.0;
        project_node_tangent(
            mx[i], my[i], mz[i], hx[i], hy[i], hz[i], tx, ty, tz);
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

__global__ void energy_weighted_dot_kernel(
    const double *ax, const double *ay, const double *az,
    const double *bx, const double *by, const double *bz,
    const double *ms, const double *lumped_mass,
    const uint8_t *magnetic_node_mask, double *block_dot, int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        local = kMu0 * ms[i] * node_weight(lumped_mass, i) *
            (ax[i] * bx[i] + ay[i] * by[i] + az[i] * bz[i]);
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_dot[blockIdx.x] = sum;
    }
}

__global__ void representable_chord_energy_linear_increment_kernel(
    const double *current_mx,
    const double *current_my,
    const double *current_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    const double *current_h_eff_x,
    const double *current_h_eff_y,
    const double *current_h_eff_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_increment,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        const double dx = trial_mx[i] - current_mx[i];
        const double dy = trial_my[i] - current_my[i];
        const double dz = trial_mz[i] - current_mz[i];
        local = -kMu0 * ms[i] * node_weight(lumped_mass, i) *
            (current_h_eff_x[i] * dx +
             current_h_eff_y[i] * dy +
             current_h_eff_z[i] * dz);
    }
    const double sum = block_reduce_sum(local);
    if (threadIdx.x == 0) {
        block_increment[blockIdx.x] = sum;
    }
}

__global__ void pgbb_current_metrics_finite_flags_kernel(
    const double *energy_terms,
    int energy_term_count,
    const double *gradient_norm_sq,
    const double *projected_gradient_norm_sq,
    double *finite_flags)
{
    bool energy_finite = true;
    for (int slot = 0; slot < energy_term_count; ++slot) {
        energy_finite = energy_finite && isfinite(energy_terms[slot]);
    }
    finite_flags[0] = energy_finite ? 1.0 : 0.0;
    finite_flags[1] =
        isfinite(gradient_norm_sq[0]) && gradient_norm_sq[0] >= 0.0
            ? 1.0
            : 0.0;
    finite_flags[2] =
        isfinite(projected_gradient_norm_sq[0]) &&
            projected_gradient_norm_sq[0] >= 0.0
            ? 1.0
            : 0.0;
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

__global__ void active_state_change_count_kernel(
    const double *current_x,
    const double *current_y,
    const double *current_z,
    const double *trial_x,
    const double *trial_y,
    const double *trial_z,
    const uint8_t *magnetic_node_mask,
    double *block_changed_active_nodes,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double changed = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        changed =
                __double_as_longlong(current_x[i]) != __double_as_longlong(trial_x[i]) ||
                __double_as_longlong(current_y[i]) != __double_as_longlong(trial_y[i]) ||
                __double_as_longlong(current_z[i]) != __double_as_longlong(trial_z[i])
            ? 1.0
            : 0.0;
    }
    const double sum = block_reduce_sum(changed);
    if (threadIdx.x == 0) {
        block_changed_active_nodes[blockIdx.x] = sum;
    }
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
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
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
        const double raw_sx = trial_mx[i] - previous_mx[i];
        const double raw_sy = trial_my[i] - previous_my[i];
        const double raw_sz = trial_mz[i] - previous_mz[i];
        double sx = 0.0;
        double sy_comp = 0.0;
        double sz = 0.0;
        project_node_tangent(
            trial_mx[i], trial_my[i], trial_mz[i],
            raw_sx, raw_sy, raw_sz, sx, sy_comp, sz);

        double transported_previous_gx = 0.0;
        double transported_previous_gy = 0.0;
        double transported_previous_gz = 0.0;
        project_node_tangent(
            trial_mx[i], trial_my[i], trial_mz[i],
            previous_gx[i], previous_gy[i], previous_gz[i],
            transported_previous_gx,
            transported_previous_gy,
            transported_previous_gz);
        const double yx = trial_gx[i] - transported_previous_gx;
        const double yy_comp = trial_gy[i] - transported_previous_gy;
        const double yz = trial_gz[i] - transported_previous_gz;
        const double energy_weight = kMu0 * ms[i] * node_weight(lumped_mass, i);
        ss = energy_weight * (sx * sx + sy_comp * sy_comp + sz * sz);
        sy = energy_weight * (sx * yx + sy_comp * yy_comp + sz * yz);
        yy = energy_weight * (yx * yx + yy_comp * yy_comp + yz * yz);
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
    const double *ms,
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
            project_node_tangent(
                mx[i], my[i], mz[i], px[i], py[i], pz[i], dx, dy, dz);
        }
        px[i] = dx;
        py[i] = dy;
        pz[i] = dz;
        const double weight = node_weight(lumped_mass, i);
        local_p_dot_g = kMu0 * ms[i] * weight * (dx * gx[i] + dy * gy[i] + dz * gz[i]);
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
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_numerator,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double transported_x = 0.0;
        double transported_y = 0.0;
        double transported_z = 0.0;
        project_node_tangent(
            mx[i], my[i], mz[i],
            previous_gx[i], previous_gy[i], previous_gz[i],
            transported_x, transported_y, transported_z);
        const double zx = trial_gx[i] - transported_x;
        const double zy = trial_gy[i] - transported_y;
        const double zz = trial_gz[i] - transported_z;
        local = kMu0 * ms[i] * node_weight(lumped_mass, i) *
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
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *trial_gx,
    double *trial_gy,
    double *trial_gz,
    double *block_norm_sq,
    double *block_previous_energy_norm_sq,
    double *block_numerator,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_norm = 0.0;
    double local_previous_energy_norm = 0.0;
    double local_numerator = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double tx = 0.0;
        double ty = 0.0;
        double tz = 0.0;
        project_node_tangent(
            mx[i], my[i], mz[i], hx[i], hy[i], hz[i], tx, ty, tz);
        const double gx = -tx;
        const double gy = -ty;
        const double gz = -tz;
        trial_gx[i] = gx;
        trial_gy[i] = gy;
        trial_gz[i] = gz;

        const double volume_weight = node_weight(lumped_mass, i);
        const double energy_weight = kMu0 * ms[i] * volume_weight;
        local_norm = volume_weight * (gx * gx + gy * gy + gz * gz);
        local_previous_energy_norm = energy_weight *
            (previous_gx[i] * previous_gx[i] +
             previous_gy[i] * previous_gy[i] +
             previous_gz[i] * previous_gz[i]);

        double transported_x = 0.0;
        double transported_y = 0.0;
        double transported_z = 0.0;
        project_node_tangent(
            mx[i], my[i], mz[i],
            previous_gx[i], previous_gy[i], previous_gz[i],
            transported_x, transported_y, transported_z);
        local_numerator = energy_weight *
            (gx * (gx - transported_x) +
             gy * (gy - transported_y) +
             gz * (gz - transported_z));
    } else if (i < n) {
        trial_gx[i] = 0.0;
        trial_gy[i] = 0.0;
        trial_gz[i] = 0.0;
    }
    double norm_sum = 0.0;
    double previous_energy_norm_sum = 0.0;
    double numerator_sum = 0.0;
    block_reduce_triple_sum(
        local_norm,
        local_previous_energy_norm,
        local_numerator,
        norm_sum,
        previous_energy_norm_sum,
        numerator_sum);
    if (threadIdx.x == 0) {
        block_norm_sq[blockIdx.x] = norm_sum;
        block_previous_energy_norm_sq[blockIdx.x] = previous_energy_norm_sum;
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
    const double *ms,
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
    double *block_gradient_energy_norm_sq,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_gradient_norm = 0.0;
    double local_gradient_energy_norm = 0.0;
    double local_p_dot_g = 0.0;
    double local_direction_norm_sq = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double tx = 0.0;
        double ty = 0.0;
        double tz = 0.0;
        project_node_tangent(
            mx[i], my[i], mz[i], hx[i], hy[i], hz[i], tx, ty, tz);
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
            project_node_tangent(
                mx[i], my[i], mz[i],
                px[i], py[i], pz[i], dir_x, dir_y, dir_z);
        }
        px[i] = dir_x;
        py[i] = dir_y;
        pz[i] = dir_z;

        const double weight = node_weight(lumped_mass, i);
        local_gradient_norm =
            weight * (grad_x * grad_x + grad_y * grad_y + grad_z * grad_z);
        local_gradient_energy_norm =
            kMu0 * ms[i] * local_gradient_norm;
        local_p_dot_g =
            kMu0 * ms[i] * weight * (dir_x * grad_x + dir_y * grad_y + dir_z * grad_z);
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
    double gradient_energy_norm_sum = 0.0;
    double p_dot_g_sum = 0.0;
    double direction_norm_sum = 0.0;
    block_reduce_pair_sum(
        local_gradient_norm,
        local_gradient_energy_norm,
        gradient_norm_sum,
        gradient_energy_norm_sum);
    block_reduce_pair_sum(
        local_p_dot_g,
        local_direction_norm_sq,
        p_dot_g_sum,
        direction_norm_sum);
    if (threadIdx.x == 0) {
        block_gradient_norm_sq[blockIdx.x] = gradient_norm_sum;
        block_gradient_energy_norm_sq[blockIdx.x] = gradient_energy_norm_sum;
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
    const double *ms,
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
            project_node_tangent(
                mx[i], my[i], mz[i],
                previous_px[i], previous_py[i], previous_pz[i],
                transported_x, transported_y, transported_z);
        }
        const double px = -trial_gx[i] + beta * transported_x;
        const double py = -trial_gy[i] + beta * transported_y;
        const double pz = -trial_gz[i] + beta * transported_z;
        next_px[i] = px;
        next_py[i] = py;
        next_pz[i] = pz;
        local = kMu0 * ms[i] * node_weight(lumped_mass, i) *
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
    const double *previous_gradient_energy_norm_sq_scalar,
    const double *pr_plus_numerator_scalar,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double relative_roundoff_bound,
    bool previous_direction_valid,
    bool restart_step,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n)
{
    const double previous_gradient_energy_norm_sq =
        previous_gradient_energy_norm_sq_scalar[0];
    const double pr_plus_numerator = pr_plus_numerator_scalar[0];
    double beta = 0.0;
    if (previous_direction_valid &&
        !restart_step &&
        previous_gradient_energy_norm_sq >
            relative_roundoff_bound * previous_gradient_energy_norm_sq &&
        isfinite(previous_gradient_energy_norm_sq) &&
        isfinite(pr_plus_numerator)) {
        beta = fmax(0.0, pr_plus_numerator / previous_gradient_energy_norm_sq);
    }

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < n && active_node(magnetic_node_mask, i)) {
        double transported_x = 0.0;
        double transported_y = 0.0;
        double transported_z = 0.0;
        if (beta != 0.0) {
            project_node_tangent(
                mx[i], my[i], mz[i],
                previous_px[i], previous_py[i], previous_pz[i],
                transported_x, transported_y, transported_z);
        }
        const double px = -trial_gx[i] + beta * transported_x;
        const double py = -trial_gy[i] + beta * transported_y;
        const double pz = -trial_gz[i] + beta * transported_z;
        next_px[i] = px;
        next_py[i] = py;
        next_pz[i] = pz;
        local = kMu0 * ms[i] * node_weight(lumped_mass, i) *
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

void fullmag_cuda_relax_energy_weighted_dot_blocks(
    const double *ax, const double *ay, const double *az,
    const double *bx, const double *by, const double *bz,
    const double *ms, const double *lumped_mass,
    const uint8_t *magnetic_node_mask, double *block_dot, int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    energy_weighted_dot_kernel<<<blocks, kBlockSize, 0, stream>>>(
        ax, ay, az, bx, by, bz, ms, lumped_mass, magnetic_node_mask, block_dot, n);
}

void fullmag_cuda_relax_representable_chord_energy_linear_increment_blocks(
    const double *current_mx,
    const double *current_my,
    const double *current_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    const double *current_h_eff_x,
    const double *current_h_eff_y,
    const double *current_h_eff_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_increment,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    representable_chord_energy_linear_increment_kernel<<<blocks, kBlockSize, 0, stream>>>(
        current_mx, current_my, current_mz,
        trial_mx, trial_my, trial_mz,
        current_h_eff_x, current_h_eff_y, current_h_eff_z,
        ms, lumped_mass, magnetic_node_mask, block_increment, n);
}

void fullmag_cuda_relax_pgbb_current_metrics_finite_flags(
    const double *energy_terms,
    int energy_term_count,
    const double *gradient_norm_sq,
    const double *projected_gradient_norm_sq,
    double *finite_flags,
    cudaStream_t stream)
{
    pgbb_current_metrics_finite_flags_kernel<<<1, 1, 0, stream>>>(
        energy_terms,
        energy_term_count,
        gradient_norm_sq,
        projected_gradient_norm_sq,
        finite_flags);
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

void fullmag_cuda_relax_active_state_change_blocks(
    const double *current_x,
    const double *current_y,
    const double *current_z,
    const double *trial_x,
    const double *trial_y,
    const double *trial_z,
    const uint8_t *magnetic_node_mask,
    double *block_changed_active_nodes,
    int n,
    cudaStream_t stream)
{
    if (n <= 0) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    active_state_change_count_kernel<<<blocks, kBlockSize, 0, stream>>>(
        current_x,
        current_y,
        current_z,
        trial_x,
        trial_y,
        trial_z,
        magnetic_node_mask,
        block_changed_active_nodes,
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

void fullmag_cuda_relax_direct_energy_difference_blocks(
    const double *current_mx, const double *current_my, const double *current_mz,
    const double *trial_mx, const double *trial_my, const double *trial_mz,
    const double *current_h_demag_x, const double *current_h_demag_y, const double *current_h_demag_z,
    const double *trial_h_demag_x, const double *trial_h_demag_y, const double *trial_h_demag_z,
    const double *h_ext_x, const double *h_ext_y, const double *h_ext_z,
    const double *ms, const double *ku, const double *ku2,
    const double *kc1, const double *kc2, const double *kc3,
    const double *axis_x, const double *axis_y, const double *axis_z,
    const double *lumped_mass, const uint8_t *magnetic_node_mask,
    bool demag_enabled,
    bool external_enabled,
    bool uniaxial_enabled,
    bool cubic_enabled,
    double uniform_ku, double uniform_ku2, bool use_ku_field, bool use_ku2_field,
    double uniform_kc1, double uniform_kc2, double uniform_kc3,
    double c1x, double c1y, double c1z,
    double c2x, double c2y, double c2z,
    bool use_kc1_field, bool use_kc2_field, bool use_kc3_field,
    double *block_delta_energy, double *block_absolute_terms,
    double *block_demag_delta, double *block_demag_absolute,
    int n, cudaStream_t stream)
{
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    direct_energy_difference_kernel<<<blocks, kBlockSize, 0, stream>>>(
        current_mx, current_my, current_mz, trial_mx, trial_my, trial_mz,
        current_h_demag_x, current_h_demag_y, current_h_demag_z,
        trial_h_demag_x, trial_h_demag_y, trial_h_demag_z,
        h_ext_x, h_ext_y, h_ext_z, ms, ku, ku2, kc1, kc2, kc3,
        axis_x, axis_y, axis_z,
        lumped_mass, magnetic_node_mask, demag_enabled, external_enabled,
        uniaxial_enabled, cubic_enabled,
        uniform_ku, uniform_ku2, use_ku_field, use_ku2_field,
        uniform_kc1, uniform_kc2, uniform_kc3,
        c1x, c1y, c1z, c2x, c2y, c2z,
        use_kc1_field, use_kc2_field, use_kc3_field,
        block_delta_energy, block_absolute_terms,
        block_demag_delta, block_demag_absolute, n);
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
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
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
        ms,
        lumped_mass,
        magnetic_node_mask,
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
    const double *ms,
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
        ms,
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
    const double *ms,
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
        ms,
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
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *trial_gx,
    double *trial_gy,
    double *trial_gz,
    double *block_norm_sq,
    double *block_previous_energy_norm_sq,
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
        ms,
        lumped_mass,
        magnetic_node_mask,
        trial_gx,
        trial_gy,
        trial_gz,
        block_norm_sq,
        block_previous_energy_norm_sq,
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
    const double *ms,
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
    double *block_gradient_energy_norm_sq,
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
        ms,
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
        block_gradient_energy_norm_sq,
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
    const double *ms,
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
        ms,
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
    const double *previous_gradient_energy_norm_sq_scalar,
    const double *pr_plus_numerator_scalar,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double relative_roundoff_bound,
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
        previous_gradient_energy_norm_sq_scalar,
        pr_plus_numerator_scalar,
        ms,
        lumped_mass,
        magnetic_node_mask,
        relative_roundoff_bound,
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
