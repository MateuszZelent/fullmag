/*
 * reductions_fp64.cu — GPU-side scalar reductions for FDM CUDA backends.
 *
 * Provides device reductions for:
 *   - max |v| diagnostics
 *   - exchange energy
 *   - demag energy
 *   - external-field energy
 *
 * Results are accumulated in fp64 and only a single scalar is copied back to
 * the host for each observable, removing the old whole-field host round-trip.
 */

#include "context.hpp"
#include "adaptive_controller.cuh"
#include <cuda_runtime.h>
#include <math_constants.h>
#include <cmath>
#include <limits>
#include <math_constants.h>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

static constexpr double MU0 = 4.0 * M_PI * 1e-7;
static constexpr int REDUCTION_BLOCK_SIZE = 256;

template <typename T>
__device__ __forceinline__ double to_f64(T value) {
    return static_cast<double>(value);
}

__device__ __forceinline__ int pbc_neighbor_index(
    int coord, int dim, int stride, int idx, int delta, int periodic)
{
    int nc = coord + delta;
    if (periodic && dim > 1) {
        if (nc < 0) nc = dim - 1;
        if (nc >= dim) nc = 0;
        return idx + (nc - coord) * stride;
    }
    if (nc < 0 || nc >= dim) return idx;
    return idx + delta * stride;
}

__global__ void reduce_sum_blocks_kernel(const double *input, double *output, uint64_t n) {
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t global = static_cast<uint64_t>(blockIdx.x) * blockDim.x * 2ULL + threadIdx.x;

    double sum = 0.0;
    if (global < n) {
        sum += input[global];
    }
    uint64_t other = global + blockDim.x;
    if (other < n) {
        sum += input[other];
    }

    shared[threadIdx.x] = sum;
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (threadIdx.x < stride) {
            shared[threadIdx.x] += shared[threadIdx.x + stride];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        output[blockIdx.x] = shared[0];
    }
}

__global__ void reduce_max_blocks_kernel(const double *input, double *output, uint64_t n) {
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t global = static_cast<uint64_t>(blockIdx.x) * blockDim.x * 2ULL + threadIdx.x;

    double local_max = -1.0e300;
    if (global < n) {
        local_max = input[global];
    }
    uint64_t other = global + blockDim.x;
    if (other < n) {
        local_max = fmax(local_max, input[other]);
    }

    shared[threadIdx.x] = local_max;
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (threadIdx.x < stride) {
            shared[threadIdx.x] = fmax(shared[threadIdx.x], shared[threadIdx.x + stride]);
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        output[blockIdx.x] = shared[0];
    }
}

__global__ void reduce_max_metric_triplet_blocks_kernel(
    const double *input,
    double *output,
    uint64_t n,
    uint64_t metric_stride)
{
    __shared__ double shared[3][REDUCTION_BLOCK_SIZE];
    const uint64_t global =
        static_cast<uint64_t>(blockIdx.x) * blockDim.x * 2ULL + threadIdx.x;
    const uint64_t other = global + blockDim.x;

    for (int metric = 0; metric < 3; ++metric) {
        const double *metric_input = input + metric * metric_stride;
        double local_max = -1.0e300;
        if (global < n) local_max = metric_input[global];
        if (other < n) local_max = fmax(local_max, metric_input[other]);
        shared[metric][threadIdx.x] = local_max;
    }
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (threadIdx.x < stride) {
            for (int metric = 0; metric < 3; ++metric) {
                shared[metric][threadIdx.x] = fmax(
                    shared[metric][threadIdx.x],
                    shared[metric][threadIdx.x + stride]);
            }
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        for (int metric = 0; metric < 3; ++metric) {
            output[metric * metric_stride + blockIdx.x] = shared[metric][0];
        }
    }
}

__global__ void adaptive_error_policy_kernel(
    const double *max_error_sq,
    const double *max_norm_defect,
    const double *max_spin_rotation,
    AdaptiveDeviceControl *policy_out,
    fullmag_fdm_adaptive_attempt_v1 *attempt_trace,
    double dt,
    double adaptive_dt_min,
    double adaptive_dt_max,
    double adaptive_safety,
    double adaptive_growth_limit,
    double adaptive_shrink_limit,
    double exponent,
    int order_est,
    int canonical_controller,
    double previous_error,
    int has_previous_error,
    uint32_t rejected_attempts,
    int force_retry)
{
    const double input_previous_error = previous_error;
    const uint32_t input_has_previous_error = has_previous_error != 0 ? 1U : 0U;
    evaluate_adaptive_error_policy_device(
        max_error_sq != nullptr ? max_error_sq[0] : 0.0,
        policy_out,
        attempt_trace,
        dt,
        adaptive_dt_min,
        adaptive_dt_max,
        adaptive_safety,
        adaptive_growth_limit,
        adaptive_shrink_limit,
        exponent,
        order_est,
        canonical_controller,
        previous_error,
        has_previous_error,
        rejected_attempts,
        force_retry);
    policy_out->decision_input_previous_error = input_previous_error;
    policy_out->decision_input_has_previous_error = input_has_previous_error;
    policy_out->last_max_norm_defect =
        max_norm_defect != nullptr ? max_norm_defect[0] : 0.0;
    policy_out->last_max_spin_rotation_radians =
        max_spin_rotation != nullptr ? max_spin_rotation[0] : 0.0;
    if (rejected_attempts == 0) {
        policy_out->max_attempt_error = policy_out->error;
        policy_out->max_attempt_norm_defect = policy_out->last_max_norm_defect;
        policy_out->max_attempt_spin_rotation_radians =
            policy_out->last_max_spin_rotation_radians;
    } else {
        policy_out->max_attempt_error = fmax(
            policy_out->max_attempt_error,
            policy_out->error);
        policy_out->max_attempt_norm_defect = fmax(
            policy_out->max_attempt_norm_defect,
            policy_out->last_max_norm_defect);
        policy_out->max_attempt_spin_rotation_radians = fmax(
            policy_out->max_attempt_spin_rotation_radians,
            policy_out->last_max_spin_rotation_radians);
    }
}

__global__ void adaptive_error_policy_loop_kernel(
    const double *max_error_sq,
    const double *max_norm_defect,
    const double *max_spin_rotation,
    AdaptiveDeviceControl *control,
    fullmag_fdm_adaptive_attempt_v1 *attempt_trace,
    double adaptive_dt_min,
    double adaptive_dt_max,
    double adaptive_safety,
    double adaptive_growth_limit,
    double adaptive_shrink_limit,
    double exponent,
    int order_est,
    int canonical_controller,
    cudaGraphConditionalHandle loop_handle)
{
    const uint32_t attempt = control->next_rejected_attempts;
    const double input_previous_error = control->previous_error;
    const uint32_t input_has_previous_error = control->has_previous_error;
    evaluate_adaptive_error_policy_loop_device(
        max_error_sq != nullptr ? max_error_sq[0] : 0.0,
        control,
        attempt_trace,
        adaptive_dt_min,
        adaptive_dt_max,
        adaptive_safety,
        adaptive_growth_limit,
        adaptive_shrink_limit,
        exponent,
        order_est,
        canonical_controller,
        0,
        loop_handle);
    control->decision_input_previous_error = input_previous_error;
    control->decision_input_has_previous_error = input_has_previous_error;
    control->last_max_norm_defect =
        max_norm_defect != nullptr ? max_norm_defect[0] : 0.0;
    control->last_max_spin_rotation_radians =
        max_spin_rotation != nullptr ? max_spin_rotation[0] : 0.0;
    if (attempt == 0) {
        control->max_attempt_error = control->error;
        control->max_attempt_norm_defect = control->last_max_norm_defect;
        control->max_attempt_spin_rotation_radians =
            control->last_max_spin_rotation_radians;
    } else {
        control->max_attempt_error = fmax(
            control->max_attempt_error,
            control->error);
        control->max_attempt_norm_defect = fmax(
            control->max_attempt_norm_defect,
            control->last_max_norm_defect);
        control->max_attempt_spin_rotation_radians = fmax(
            control->max_attempt_spin_rotation_radians,
            control->last_max_spin_rotation_radians);
    }
}

static const char *adaptive_device_reason_id(uint32_t reason) {
    switch (reason) {
        case ADAPTIVE_DEVICE_REASON_WITHIN_TOLERANCE: return "within_tolerance";
        case ADAPTIVE_DEVICE_REASON_ERROR_ABOVE_TOLERANCE: return "error_above_tolerance";
        case ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED: return "dt_min_exhausted";
        case ADAPTIVE_DEVICE_REASON_INVALID_TIMESTEP: return "invalid_timestep";
        case ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR: return "invalid_current_error";
        case ADAPTIVE_DEVICE_REASON_INVALID_PREVIOUS_ERROR: return "invalid_previous_error";
        case ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED: return "retry_limit_exhausted";
        default: return "invalid_decision_reason";
    }
}

template <typename Scalar>
__global__ void vector_max_norm_blocks_kernel(
    const Scalar *vx,
    const Scalar *vy,
    const Scalar *vz,
    double *block_out,
    uint64_t n)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double local_max = 0.0;
    for (; idx < n; idx += stride) {
        double x = to_f64(vx[idx]);
        double y = to_f64(vy[idx]);
        double z = to_f64(vz[idx]);
        double norm_sq = x * x + y * y + z * z;
        local_max = fmax(local_max, norm_sq);
    }

    shared[threadIdx.x] = local_max;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] = fmax(shared[threadIdx.x], shared[threadIdx.x + offset]);
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

template <typename Scalar>
__global__ void exchange_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const uint8_t *active_mask,
    const uint32_t *region_mask,
    const double *exchange_lut,
    const double *volume_fraction,
    double *block_out,
    int nx,
    int ny,
    int nz,
    int has_active_mask,
    int has_region_mask,
    int has_volume_fraction,
    int max_regions,
    double a_times_v,
    double cell_volume,
    double inv_dx2,
    double inv_dy2,
    double inv_dz2,
    int periodic_x,
    int periodic_y,
    int periodic_z)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < total; idx += stride) {
        if (has_active_mask && active_mask[idx] == 0) {
            continue;
        }
        // Per-cell effective volume: V_i = φ_i × dx×dy×dz
        const double phi_i = has_volume_fraction ? volume_fraction[idx] : 1.0;
        if (phi_i <= 0.0) continue;
        const double v_i = phi_i * cell_volume;

        uint32_t center_region = has_region_mask ? region_mask[idx] : 0u;
        int z = static_cast<int>(idx / (static_cast<uint64_t>(ny) * nx));
        int rem = static_cast<int>(idx - static_cast<uint64_t>(z) * ny * nx);
        int y = rem / nx;
        int x = rem - y * nx;

        double cx = to_f64(mx[idx]);
        double cy = to_f64(my[idx]);
        double cz = to_f64(mz[idx]);

        if (x + 1 < nx || (periodic_x && nx > 1)) {
            uint64_t ni = (x + 1 < nx)
                ? idx + 1
                : idx + 1 - static_cast<uint64_t>(nx);
            if (!has_active_mask || active_mask[ni] != 0) {
                const double phi_j = has_volume_fraction ? volume_fraction[ni] : 1.0;
                if (phi_j > 0.0) {
                    double coeff = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]] * v_i
                        : a_times_v * phi_i;
                    double dx_ = to_f64(mx[ni]) - cx;
                    double dy_ = to_f64(my[ni]) - cy;
                    double dz_ = to_f64(mz[ni]) - cz;
                    energy += coeff * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dx2;
                }
            }
        }
        if (y + 1 < ny || (periodic_y && ny > 1)) {
            uint64_t ni = (y + 1 < ny)
                ? idx + nx
                : idx + static_cast<uint64_t>(nx) - static_cast<uint64_t>(ny) * nx;
            if (!has_active_mask || active_mask[ni] != 0) {
                const double phi_j = has_volume_fraction ? volume_fraction[ni] : 1.0;
                if (phi_j > 0.0) {
                    double coeff = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]] * v_i
                        : a_times_v * phi_i;
                    double dx_ = to_f64(mx[ni]) - cx;
                    double dy_ = to_f64(my[ni]) - cy;
                    double dz_ = to_f64(mz[ni]) - cz;
                    energy += coeff * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dy2;
                }
            }
        }
        if (z + 1 < nz || (periodic_z && nz > 1)) {
            uint64_t layer = static_cast<uint64_t>(nx) * ny;
            uint64_t ni = (z + 1 < nz)
                ? idx + layer
                : idx + layer - static_cast<uint64_t>(nz) * layer;
            if (!has_active_mask || active_mask[ni] != 0) {
                const double phi_j = has_volume_fraction ? volume_fraction[ni] : 1.0;
                if (phi_j > 0.0) {
                    double coeff = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]] * v_i
                        : a_times_v * phi_i;
                    double dx_ = to_f64(mx[ni]) - cx;
                    double dy_ = to_f64(my[ni]) - cy;
                    double dz_ = to_f64(mz[ni]) - cz;
                    energy += coeff * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dz2;
                }
            }
        }

    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

/*
 * T0 exchange energy kernel — face-link weighted.
 *
 * Uses the same discretization as exchange_t0_fp64.cu field kernel:
 *   E_pair = A_ij × f_d × V_eff_i × |m_j - m_i|² / Δd²
 * where f_d is the face_link fraction for the given direction.
 */
template <typename Scalar>
__global__ void exchange_energy_t0_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const uint8_t *active_mask,
    const uint32_t *region_mask,
    const double *exchange_lut,
    const double *volume_fraction,
    const double *face_xp,
    const double *face_xm,
    const double *face_yp,
    const double *face_ym,
    const double *face_zp,
    const double *face_zm,
    double *block_out,
    int nx,
    int ny,
    int nz,
    int has_active_mask,
    int has_region_mask,
    int max_regions,
    double A_uniform,
    double cell_volume,
    double phi_floor,
    double inv_dx2,
    double inv_dy2,
    double inv_dz2)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < total; idx += stride) {
        if (has_active_mask && active_mask[idx] == 0) continue;

        const double phi_i = volume_fraction[idx];
        if (phi_i <= 0.0) continue;
        const double phi_eff = (phi_i > phi_floor) ? phi_i : phi_floor;
        const double v_eff = phi_eff * cell_volume;

        uint32_t center_region = has_region_mask ? region_mask[idx] : 0u;
        int z = static_cast<int>(idx / (static_cast<uint64_t>(ny) * nx));
        int rem = static_cast<int>(idx - static_cast<uint64_t>(z) * ny * nx);
        int y = rem / nx;
        int x = rem - y * nx;

        double cx = to_f64(mx[idx]);
        double cy = to_f64(my[idx]);
        double cz = to_f64(mz[idx]);

        // +x neighbor
        if (x + 1 < nx) {
            const double f = face_xp[idx];
            if (f > 0.0) {
                uint64_t ni = idx + 1;
                if (!has_active_mask || active_mask[ni] != 0) {
                    double A_ij = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]]
                        : A_uniform;
                    double dmx = to_f64(mx[ni]) - cx;
                    double dmy = to_f64(my[ni]) - cy;
                    double dmz = to_f64(mz[ni]) - cz;
                    energy += A_ij * f * v_eff * (dmx*dmx + dmy*dmy + dmz*dmz) * inv_dx2;
                }
            }
        }
        // +y neighbor
        if (y + 1 < ny) {
            const double f = face_yp[idx];
            if (f > 0.0) {
                uint64_t ni = idx + nx;
                if (!has_active_mask || active_mask[ni] != 0) {
                    double A_ij = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]]
                        : A_uniform;
                    double dmx = to_f64(mx[ni]) - cx;
                    double dmy = to_f64(my[ni]) - cy;
                    double dmz = to_f64(mz[ni]) - cz;
                    energy += A_ij * f * v_eff * (dmx*dmx + dmy*dmy + dmz*dmz) * inv_dy2;
                }
            }
        }
        // +z neighbor
        if (z + 1 < nz) {
            const double f = face_zp[idx];
            if (f > 0.0) {
                uint64_t ni = idx + static_cast<uint64_t>(nx) * ny;
                if (!has_active_mask || active_mask[ni] != 0) {
                    double A_ij = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]]
                        : A_uniform;
                    double dmx = to_f64(mx[ni]) - cx;
                    double dmy = to_f64(my[ni]) - cy;
                    double dmz = to_f64(mz[ni]) - cz;
                    energy += A_ij * f * v_eff * (dmx*dmx + dmy*dmy + dmz*dmz) * inv_dz2;
                }
            }
        }
    }

    shared[threadIdx.x] = energy;
    __syncthreads();
    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) shared[threadIdx.x] += shared[threadIdx.x + offset];
        __syncthreads();
    }
    if (threadIdx.x == 0) block_out[blockIdx.x] = shared[0];
}

/*
 * T1 exchange energy kernel — delta-corrected (ECB/García stencil).
 *
 * Uses the same discretization as exchange_t1_fp64.cu field kernel:
 *   E_pair = A_ij × V_eff_i × 2 × |m_j - m_i|² / [Δd × (Δd + δ_opp)]
 * where δ_opp is the intersection distance toward the opposite boundary.
 */
template <typename Scalar>
__global__ void exchange_energy_t1_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const uint8_t *active_mask,
    const uint32_t *region_mask,
    const double *exchange_lut,
    const double *volume_fraction,
    const double *d_delta_xp,
    const double *d_delta_xm,
    const double *d_delta_yp,
    const double *d_delta_ym,
    const double *d_delta_zp,
    const double *d_delta_zm,
    double *block_out,
    int nx,
    int ny,
    int nz,
    int has_active_mask,
    int has_region_mask,
    int max_regions,
    double A_uniform,
    double cell_volume,
    double dx,
    double dy,
    double dz,
    double delta_min,
    double phi_floor)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < total; idx += stride) {
        if (has_active_mask && active_mask[idx] == 0) continue;

        const double phi_i = volume_fraction[idx];
        if (phi_i <= 0.0) continue;
        const double phi_eff = (phi_i > phi_floor) ? phi_i : phi_floor;
        const double v_eff = phi_eff * cell_volume;

        uint32_t center_region = has_region_mask ? region_mask[idx] : 0u;
        int z = static_cast<int>(idx / (static_cast<uint64_t>(ny) * nx));
        int rem = static_cast<int>(idx - static_cast<uint64_t>(z) * ny * nx);
        int y = rem / nx;
        int x = rem - y * nx;

        double cx = to_f64(mx[idx]);
        double cy = to_f64(my[idx]);
        double cz = to_f64(mz[idx]);

        // ── X axis ──
        const double dxm = fmax(d_delta_xm[idx], delta_min);
        const double dxp = fmax(d_delta_xp[idx], delta_min);

        // +x neighbor: denominator = dx × (dx + δ_xm)  [opposite side delta]
        if (x + 1 < nx && dxp > 0.0) {
            uint64_t ni = idx + 1;
            const double mn_x = to_f64(mx[ni]), mn_y = to_f64(my[ni]), mn_z = to_f64(mz[ni]);
            if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
                if (!has_active_mask || active_mask[ni] != 0) {
                    double A_ij = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]]
                        : A_uniform;
                    double denom = dx * (dx + dxm);
                    double dmx = mn_x - cx, dmy = mn_y - cy, dmz = mn_z - cz;
                    energy += A_ij * v_eff * 2.0 / denom * (dmx*dmx + dmy*dmy + dmz*dmz);
                }
            }
        }

        // ── Y axis ──
        const double dym = fmax(d_delta_ym[idx], delta_min);
        const double dyp = fmax(d_delta_yp[idx], delta_min);

        if (y + 1 < ny && dyp > 0.0) {
            uint64_t ni = idx + nx;
            const double mn_x = to_f64(mx[ni]), mn_y = to_f64(my[ni]), mn_z = to_f64(mz[ni]);
            if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
                if (!has_active_mask || active_mask[ni] != 0) {
                    double A_ij = has_region_mask
                        ? exchange_lut[center_region * max_regions + region_mask[ni]]
                        : A_uniform;
                    double denom = dy * (dy + dym);
                    double dmx = mn_x - cx, dmy = mn_y - cy, dmz = mn_z - cz;
                    energy += A_ij * v_eff * 2.0 / denom * (dmx*dmx + dmy*dmy + dmz*dmz);
                }
            }
        }

        // ── Z axis (3D only) ──
        if (nz > 1) {
            const double dzm = fmax(d_delta_zm[idx], delta_min);
            const double dzp = fmax(d_delta_zp[idx], delta_min);

            if (z + 1 < nz && dzp > 0.0) {
                uint64_t ni = idx + static_cast<uint64_t>(nx) * ny;
                const double mn_x = to_f64(mx[ni]), mn_y = to_f64(my[ni]), mn_z = to_f64(mz[ni]);
                if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
                    if (!has_active_mask || active_mask[ni] != 0) {
                        double A_ij = has_region_mask
                            ? exchange_lut[center_region * max_regions + region_mask[ni]]
                            : A_uniform;
                        double denom = dz * (dz + dzm);
                        double dmx = mn_x - cx, dmy = mn_y - cy, dmz = mn_z - cz;
                        energy += A_ij * v_eff * 2.0 / denom * (dmx*dmx + dmy*dmy + dmz*dmz);
                    }
                }
            }
        }
    }

    shared[threadIdx.x] = energy;
    __syncthreads();
    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) shared[threadIdx.x] += shared[threadIdx.x + offset];
        __syncthreads();
    }
    if (threadIdx.x == 0) block_out[blockIdx.x] = shared[0];
}

template <typename Scalar>
__global__ void demag_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const Scalar *hx,
    const Scalar *hy,
    const Scalar *hz,
    const double *volume_fraction,
    double *block_out,
    uint64_t n,
    int has_volume_fraction,
    double coeff)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < n; idx += stride) {
        // Per-cell volume weighting: E_demag_i = -½ μ₀ Ms φ_i V_cell (m · H_demag)
        const double phi_i = has_volume_fraction ? volume_fraction[idx] : 1.0;
        double mdoth = to_f64(mx[idx]) * to_f64(hx[idx])
            + to_f64(my[idx]) * to_f64(hy[idx])
            + to_f64(mz[idx]) * to_f64(hz[idx]);
        energy += coeff * phi_i * mdoth;
    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

template <typename Scalar>
__global__ void external_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const double *volume_fraction,
    double *block_out,
    uint64_t n,
    int has_volume_fraction,
    double coeff,
    double hx,
    double hy,
    double hz,
    const Scalar *oe_x,
    const Scalar *oe_y,
    const Scalar *oe_z,
    double oe_scale)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < n; idx += stride) {
        const double phi_i = has_volume_fraction ? volume_fraction[idx] : 1.0;
        double field_x = hx;
        double field_y = hy;
        double field_z = hz;
        if (oe_x != nullptr) {
            field_x += oe_scale * to_f64(oe_x[idx]);
            field_y += oe_scale * to_f64(oe_y[idx]);
            field_z += oe_scale * to_f64(oe_z[idx]);
        }
        double mdoth =
            to_f64(mx[idx]) * field_x + to_f64(my[idx]) * field_y + to_f64(mz[idx]) * field_z;
        energy += coeff * phi_i * mdoth;
    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}
template <typename Scalar>
__global__ void uniaxial_anisotropy_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const double *volume_fraction,
    double *block_out,
    uint64_t n,
    int has_volume_fraction,
    double coeff,
    double Ku1,
    double Ku2,
    double ux,
    double uy,
    double uz,
    const double *ku1_field,
    const double *ku2_field)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < n; idx += stride) {
        const double phi_i = has_volume_fraction ? volume_fraction[idx] : 1.0;
        double ku1_val = ku1_field ? ku1_field[idx] : Ku1;
        double ku2_val = ku2_field ? ku2_field[idx] : Ku2;
        double m_dot_u = to_f64(mx[idx]) * ux + to_f64(my[idx]) * uy + to_f64(mz[idx]) * uz;
        double m_dot_u_sq = m_dot_u * m_dot_u;
        energy += coeff * phi_i * (ku1_val * m_dot_u_sq + ku2_val * m_dot_u_sq * m_dot_u_sq);
    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}
static uint64_t launch_grid_for(uint64_t n) {
    uint64_t blocks = (n + REDUCTION_BLOCK_SIZE - 1) / REDUCTION_BLOCK_SIZE;
    if (blocks == 0) {
        blocks = 1;
    }
    if (blocks > 4096) {
        blocks = 4096;
    }
    return blocks;
}

static double finalize_sum_reduction(Context &ctx, double *device_values, uint64_t n) {
    uint64_t current = n;
    while (current > 1) {
        uint64_t blocks = (current + REDUCTION_BLOCK_SIZE * 2 - 1) / (REDUCTION_BLOCK_SIZE * 2);
        reduce_sum_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            device_values,
            device_values,
            current);
        current = blocks;
    }
    double result = 0.0;
    if (cudaMemcpy(&result, device_values, sizeof(double), cudaMemcpyDeviceToHost) ==
            cudaSuccess) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_REDUCTION);
        if (fullmag_fdm_solver_phase_active(*ctx.execution_receipt)) {
            fullmag_fdm_record_control_scalar_d2h(ctx, sizeof(double));
            fullmag_fdm_record_control_scalar_host_sync(ctx);
        }
    }
    return result;
}

static double finalize_max_reduction(Context &ctx, double *device_values, uint64_t n) {
    uint64_t current = n;
    while (current > 1) {
        uint64_t blocks = (current + REDUCTION_BLOCK_SIZE * 2 - 1) / (REDUCTION_BLOCK_SIZE * 2);
        reduce_max_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            device_values,
            device_values,
            current);
        current = blocks;
    }
    double result = 0.0;
    if (cudaMemcpy(&result, device_values, sizeof(double), cudaMemcpyDeviceToHost) ==
            cudaSuccess) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_REDUCTION);
        if (fullmag_fdm_solver_phase_active(*ctx.execution_receipt)) {
            fullmag_fdm_record_control_scalar_d2h(ctx, sizeof(double));
            fullmag_fdm_record_control_scalar_host_sync(ctx);
        }
    }
    return result;
}

double reduce_max_scalar_sqrt(Context &ctx, double *device_values, uint64_t n) {
    if (device_values == nullptr || n == 0) {
        return 0.0;
    }
    if (!context_begin_compute_stream_work(ctx, "reduce_max_scalar_sqrt")) {
        return 0.0;
    }
    cudaStream_t stream = context_compute_stream(ctx);

    double *src = device_values;
    double *dst = ctx.reduction_scratch_aux;
    uint64_t current = n;
    while (current > 1) {
        uint64_t blocks = (current + REDUCTION_BLOCK_SIZE * 2 - 1) / (REDUCTION_BLOCK_SIZE * 2);
        reduce_max_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE, 0, stream>>>(
            src,
            dst,
            current);
        current = blocks;
        double *tmp = src;
        src = dst;
        dst = tmp;
    }

    double max_value = 0.0;
    cudaError_t err = cudaMemcpyAsync(&max_value, src, sizeof(double), cudaMemcpyDeviceToHost, stream);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpyAsync(reduce_max_scalar_sqrt)", err);
        context_end_compute_stream_work(ctx, "reduce_max_scalar_sqrt");
        return 0.0;
    }
    err = cudaStreamSynchronize(stream);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaStreamSynchronize(reduce_max_scalar_sqrt)", err);
        context_end_compute_stream_work(ctx, "reduce_max_scalar_sqrt");
        return 0.0;
    }
    fullmag_fdm_record_control_scalar_d2h(ctx, sizeof(double));
    fullmag_fdm_record_control_scalar_host_sync(ctx);
    if (!context_end_compute_stream_work(ctx, "reduce_max_scalar_sqrt")) {
        return 0.0;
    }
    return max_value > 0.0 ? std::sqrt(max_value) : 0.0;
}

AdaptiveErrorPolicy reduce_adaptive_error_policy(
    Context &ctx,
    double *device_values,
    uint64_t n,
    uint64_t metric_stride,
    double dt,
    double exponent)
{
    AdaptiveErrorPolicy policy{};
    policy.dt_candidate = ctx.adaptive_dt_max;
    policy.accepted = 1;
    if (device_values == nullptr || n == 0 || ctx.adaptive_policy_scratch == nullptr) {
        return policy;
    }
    if (!context_begin_compute_stream_work(ctx, "reduce_adaptive_error_policy")) {
        return policy;
    }
    cudaStream_t stream = context_compute_stream(ctx);

    double *src = device_values;
    double *dst = ctx.reduction_scratch_aux;
    uint64_t current = n;
    while (current > 1) {
        uint64_t blocks = (current + REDUCTION_BLOCK_SIZE * 2 - 1) / (REDUCTION_BLOCK_SIZE * 2);
        reduce_max_metric_triplet_blocks_kernel<<<
            static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE, 0, stream>>>(
            src, dst, current, metric_stride);
        current = blocks;
        double *tmp = src;
        src = dst;
        dst = tmp;
    }

    const int force_retry = ctx.gpu_transport_test_force_adaptive_retry ? 1 : 0;
    ctx.gpu_transport_test_force_adaptive_retry = false;
    const int order_est = exponent == 0.2 ? 4 : 2;
    adaptive_error_policy_kernel<<<1, 1, 0, stream>>>(
        src,
        src + metric_stride,
        src + 2 * metric_stride,
        ctx.adaptive_policy_scratch,
        ctx.adaptive_attempt_trace_device,
        dt,
        ctx.adaptive_dt_min,
        ctx.adaptive_dt_max,
        ctx.adaptive_safety,
        ctx.adaptive_growth_limit,
        ctx.adaptive_shrink_limit,
        exponent,
        order_est,
        ctx.adaptive_canonical_controller ? 1 : 0,
        ctx.adaptive_previous_error,
        ctx.adaptive_has_previous_error ? 1 : 0,
        ctx.adaptive_rejected_attempts,
        force_retry);

    AdaptiveDeviceControl host_control{};
    cudaError_t err = cudaMemcpyAsync(
        &host_control, ctx.adaptive_policy_scratch, sizeof(host_control),
        cudaMemcpyDeviceToHost, stream);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpyAsync(reduce_adaptive_error_policy)", err);
        context_end_compute_stream_work(ctx, "reduce_adaptive_error_policy");
        return policy;
    }
    err = cudaStreamSynchronize(stream);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaStreamSynchronize(reduce_adaptive_error_policy)", err);
        context_end_compute_stream_work(ctx, "reduce_adaptive_error_policy");
        return policy;
    }
    fullmag_fdm_record_control_scalar_d2h(ctx, sizeof(host_control));
    fullmag_fdm_record_control_scalar_host_sync(ctx);
    if (!context_end_compute_stream_work(ctx, "reduce_adaptive_error_policy")) {
        return policy;
    }
    fullmag_fdm_note_operator_device_execution(
        ctx, FULLMAG_FDM_OPERATOR_REDUCTION);
    policy.error = host_control.error;
    policy.dt_candidate = host_control.dt_candidate;
    policy.ratio = host_control.ratio;
    policy.accepted = host_control.decision == ADAPTIVE_DEVICE_DECISION_ACCEPTED ? 1 : 0;
    policy.dt_min_exhausted =
        host_control.reason == ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED;
    policy.failed = host_control.decision == ADAPTIVE_DEVICE_DECISION_FAILED;
    policy.reason = host_control.reason;
    policy.rejected_attempts = host_control.next_rejected_attempts;
    ctx.adaptive_rejected_attempts = host_control.next_rejected_attempts;
    if (host_control.decision == ADAPTIVE_DEVICE_DECISION_ACCEPTED ||
        host_control.decision == ADAPTIVE_DEVICE_DECISION_FAILED) {
        ctx.adaptive_attempt_trace_count = host_control.attempt_index + 1;
    }
    if (policy.accepted && ctx.adaptive_canonical_controller) {
        ctx.adaptive_has_previous_error = host_control.has_previous_error != 0;
        ctx.adaptive_previous_error = host_control.previous_error;
    }
    if (host_control.decision == ADAPTIVE_DEVICE_DECISION_FAILED &&
        !policy.dt_min_exhausted) {
        ctx.last_error = adaptive_device_reason_id(host_control.reason);
    }
    if (host_control.decision != ADAPTIVE_DEVICE_DECISION_RETRY) {
        context_record_adaptive_numerics_terminal(
            ctx, host_control, order_est);
    }
    return policy;
}

bool enqueue_adaptive_error_policy_device_loop(
    Context &ctx,
    double *device_values,
    uint64_t n,
    uint64_t metric_stride,
    double exponent,
    cudaGraphConditionalHandle loop_handle)
{
    if (device_values == nullptr || n == 0 ||
        ctx.adaptive_policy_scratch == nullptr) {
        ctx.last_error = "adaptive_device_loop_scratch_unavailable";
        return false;
    }
    if (!context_begin_compute_stream_work(
            ctx, "enqueue_adaptive_error_policy_device_loop")) {
        return false;
    }
    cudaStream_t stream = context_compute_stream(ctx);
    double *src = device_values;
    double *dst = ctx.reduction_scratch_aux;
    uint64_t current = n;
    while (current > 1) {
        const uint64_t blocks =
            (current + REDUCTION_BLOCK_SIZE * 2 - 1) /
            (REDUCTION_BLOCK_SIZE * 2);
        reduce_max_metric_triplet_blocks_kernel<<<
            static_cast<unsigned int>(blocks),
            REDUCTION_BLOCK_SIZE,
            0,
            stream>>>(src, dst, current, metric_stride);
        current = blocks;
        double *temporary = src;
        src = dst;
        dst = temporary;
    }
    const int order_est = exponent == 0.2 ? 4 : 2;
    adaptive_error_policy_loop_kernel<<<1, 1, 0, stream>>>(
        src,
        src + metric_stride,
        src + 2 * metric_stride,
        ctx.adaptive_policy_scratch,
        ctx.adaptive_attempt_trace_device,
        ctx.adaptive_dt_min,
        ctx.adaptive_dt_max,
        ctx.adaptive_safety,
        ctx.adaptive_growth_limit,
        ctx.adaptive_shrink_limit,
        exponent,
        order_est,
        ctx.adaptive_canonical_controller ? 1 : 0,
        loop_handle);
    const cudaError_t launch_error = cudaGetLastError();
    if (launch_error != cudaSuccess) {
        set_cuda_error(
            ctx,
            "adaptive_error_policy_loop_kernel",
            launch_error);
        context_end_compute_stream_work(
            ctx, "enqueue_adaptive_error_policy_device_loop");
        return false;
    }
    if (!context_end_compute_stream_work(
            ctx, "enqueue_adaptive_error_policy_device_loop")) {
        return false;
    }
    fullmag_fdm_note_operator_device_execution(
        ctx, FULLMAG_FDM_OPERATOR_REDUCTION);
    return true;
}

double reduce_max_norm_fp64(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n) {
    uint64_t blocks = launch_grid_for(n);
    vector_max_norm_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(vx),
        static_cast<const double *>(vy),
        static_cast<const double *>(vz),
        ctx.reduction_scratch,
        n);
    double max_norm_sq = finalize_max_reduction(ctx, ctx.reduction_scratch, blocks);
    return std::sqrt(max_norm_sq);
}

double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n) {
    uint64_t blocks = launch_grid_for(n);
    vector_max_norm_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(vx),
        static_cast<const float *>(vy),
        static_cast<const float *>(vz),
        ctx.reduction_scratch,
        n);
    double max_norm_sq = finalize_max_reduction(ctx, ctx.reduction_scratch, blocks);
    return std::sqrt(max_norm_sq);
}

// ── max |a × b| (fused cross-product max-norm reduction) ──

template <typename Scalar>
__global__ void cross_max_norm_blocks_kernel(
    const Scalar *ax, const Scalar *ay, const Scalar *az,
    const Scalar *bx, const Scalar *by, const Scalar *bz,
    double *block_out,
    uint64_t n)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double local_max = 0.0;
    for (; idx < n; idx += stride) {
        double a0 = to_f64(ax[idx]), a1 = to_f64(ay[idx]), a2 = to_f64(az[idx]);
        double b0 = to_f64(bx[idx]), b1 = to_f64(by[idx]), b2 = to_f64(bz[idx]);
        double cx = a1 * b2 - a2 * b1;
        double cy = a2 * b0 - a0 * b2;
        double cz = a0 * b1 - a1 * b0;
        double norm_sq = cx * cx + cy * cy + cz * cz;
        local_max = fmax(local_max, norm_sq);
    }

    shared[threadIdx.x] = local_max;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] = fmax(shared[threadIdx.x], shared[threadIdx.x + offset]);
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

double reduce_max_cross_norm_fp64(Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz,
    uint64_t n) {
    uint64_t blocks = launch_grid_for(n);
    cross_max_norm_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ax), static_cast<const double *>(ay), static_cast<const double *>(az),
        static_cast<const double *>(bx), static_cast<const double *>(by), static_cast<const double *>(bz),
        ctx.reduction_scratch, n);
    double max_norm_sq = finalize_max_reduction(ctx, ctx.reduction_scratch, blocks);
    return std::sqrt(max_norm_sq);
}

double reduce_max_cross_norm_fp32(Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz,
    uint64_t n) {
    uint64_t blocks = launch_grid_for(n);
    cross_max_norm_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ax), static_cast<const float *>(ay), static_cast<const float *>(az),
        static_cast<const float *>(bx), static_cast<const float *>(by), static_cast<const float *>(bz),
        ctx.reduction_scratch, n);
    double max_norm_sq = finalize_max_reduction(ctx, ctx.reduction_scratch, blocks);
    return std::sqrt(max_norm_sq);
}

// Helper: dispatch exchange energy reduction to the correct kernel tier.
template <typename Scalar>
static double reduce_exchange_energy_dispatch(Context &ctx) {
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double cell_volume = ctx.dx * ctx.dy * ctx.dz;

    if (ctx.boundary_tier >= 2 && ctx.delta_xp != nullptr) {
        // T1 (full boundary correction) — delta-corrected energy
        exchange_energy_t1_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            static_cast<const Scalar *>(ctx.m.x),
            static_cast<const Scalar *>(ctx.m.y),
            static_cast<const Scalar *>(ctx.m.z),
            ctx.active_mask,
            ctx.region_mask,
            ctx.exchange_lut,
            ctx.volume_fraction,
            ctx.delta_xp, ctx.delta_xm,
            ctx.delta_yp, ctx.delta_ym,
            ctx.delta_zp, ctx.delta_zm,
            ctx.reduction_scratch,
            static_cast<int>(ctx.nx),
            static_cast<int>(ctx.ny),
            static_cast<int>(ctx.nz),
            ctx.has_active_mask ? 1 : 0,
            ctx.has_region_mask ? 1 : 0,
            FULLMAG_FDM_MAX_EXCHANGE_REGIONS,
            ctx.A,
            cell_volume,
            ctx.dx, ctx.dy, ctx.dz,
            ctx.delta_min,
            ctx.phi_floor);
    } else if (ctx.boundary_tier >= 1 && ctx.face_link_xp != nullptr) {
        // T0 (volume boundary correction) — face-link weighted energy
        exchange_energy_t0_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            static_cast<const Scalar *>(ctx.m.x),
            static_cast<const Scalar *>(ctx.m.y),
            static_cast<const Scalar *>(ctx.m.z),
            ctx.active_mask,
            ctx.region_mask,
            ctx.exchange_lut,
            ctx.volume_fraction,
            ctx.face_link_xp, ctx.face_link_xm,
            ctx.face_link_yp, ctx.face_link_ym,
            ctx.face_link_zp, ctx.face_link_zm,
            ctx.reduction_scratch,
            static_cast<int>(ctx.nx),
            static_cast<int>(ctx.ny),
            static_cast<int>(ctx.nz),
            ctx.has_active_mask ? 1 : 0,
            ctx.has_region_mask ? 1 : 0,
            FULLMAG_FDM_MAX_EXCHANGE_REGIONS,
            ctx.A,
            cell_volume,
            ctx.phi_floor,
            1.0 / (ctx.dx * ctx.dx),
            1.0 / (ctx.dy * ctx.dy),
            1.0 / (ctx.dz * ctx.dz));
    } else {
        // Legacy (no boundary correction)
        int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
        exchange_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            static_cast<const Scalar *>(ctx.m.x),
            static_cast<const Scalar *>(ctx.m.y),
            static_cast<const Scalar *>(ctx.m.z),
            ctx.active_mask,
            ctx.region_mask,
            ctx.exchange_lut,
            ctx.volume_fraction,
            ctx.reduction_scratch,
            static_cast<int>(ctx.nx),
            static_cast<int>(ctx.ny),
            static_cast<int>(ctx.nz),
            ctx.has_active_mask ? 1 : 0,
            ctx.has_region_mask ? 1 : 0,
            has_vf,
            FULLMAG_FDM_MAX_EXCHANGE_REGIONS,
            ctx.A * cell_volume,
            cell_volume,
            1.0 / (ctx.dx * ctx.dx),
            1.0 / (ctx.dy * ctx.dy),
            1.0 / (ctx.dz * ctx.dz),
            ctx.periodic_x ? 1 : 0,
            ctx.periodic_y ? 1 : 0,
            ctx.periodic_z ? 1 : 0);
    }
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_exchange_energy_fp64(Context &ctx) {
    return reduce_exchange_energy_dispatch<double>(ctx);
}

double reduce_exchange_energy_fp32(Context &ctx) {
    return reduce_exchange_energy_dispatch<float>(ctx);
}

double reduce_demag_energy_fp64(Context &ctx) {
    if (!ctx.enable_demag) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = -0.5 * MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    demag_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        static_cast<const double *>(ctx.h_demag.x),
        static_cast<const double *>(ctx.h_demag.y),
        static_cast<const double *>(ctx.h_demag.z),
        ctx.volume_fraction,
        ctx.reduction_scratch,
        ctx.cell_count,
        has_vf,
        coeff);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_demag_energy_fp32(Context &ctx) {
    if (!ctx.enable_demag) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = -0.5 * MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    demag_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        static_cast<const float *>(ctx.h_demag.x),
        static_cast<const float *>(ctx.h_demag.y),
        static_cast<const float *>(ctx.h_demag.z),
        ctx.volume_fraction,
        ctx.reduction_scratch,
        ctx.cell_count,
        has_vf,
        coeff);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_external_energy_fp64(Context &ctx) {
    if (!ctx.has_external_field && !ctx.has_oersted_field) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    double coeff = -MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    const auto *oe_x = ctx.has_oersted_field ? static_cast<const double *>(ctx.h_oe_static.x) : nullptr;
    const auto *oe_y = ctx.has_oersted_field ? static_cast<const double *>(ctx.h_oe_static.y) : nullptr;
    const auto *oe_z = ctx.has_oersted_field ? static_cast<const double *>(ctx.h_oe_static.z) : nullptr;
    external_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        ctx.volume_fraction,
        ctx.reduction_scratch,
        ctx.cell_count,
        has_vf,
        coeff,
        ctx.external_field[0],
        ctx.external_field[1],
        ctx.external_field[2],
        oe_x,
        oe_y,
        oe_z,
        ctx.has_static_external_field_profile ? 1.0 : oersted_field_scale(ctx, ctx.current_time));
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_external_energy_fp32(Context &ctx) {
    if (!ctx.has_external_field && !ctx.has_oersted_field) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    double coeff = -MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    const auto *oe_x = ctx.has_oersted_field ? static_cast<const float *>(ctx.h_oe_static.x) : nullptr;
    const auto *oe_y = ctx.has_oersted_field ? static_cast<const float *>(ctx.h_oe_static.y) : nullptr;
    const auto *oe_z = ctx.has_oersted_field ? static_cast<const float *>(ctx.h_oe_static.z) : nullptr;
    external_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.volume_fraction,
        ctx.reduction_scratch,
        ctx.cell_count,
        has_vf,
        coeff,
        ctx.external_field[0],
        ctx.external_field[1],
        ctx.external_field[2],
        oe_x,
        oe_y,
        oe_z,
        ctx.has_static_external_field_profile ? 1.0 : oersted_field_scale(ctx, ctx.current_time));
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_uniaxial_anisotropy_energy_fp64(Context &ctx) {
    if (!ctx.has_uniaxial_anisotropy) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    double coeff = -1.0 * ctx.dx * ctx.dy * ctx.dz;  // Energy is -Ku1*(m.u)^2 ...
    uniaxial_anisotropy_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        ctx.volume_fraction,
        ctx.reduction_scratch,
        ctx.cell_count,
        has_vf,
        coeff,
        ctx.Ku1,
        ctx.Ku2,
        ctx.anisU[0],
        ctx.anisU[1],
        ctx.anisU[2],
        ctx.ku1_field,
        ctx.ku2_field);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_uniaxial_anisotropy_energy_fp32(Context &ctx) {
    if (!ctx.has_uniaxial_anisotropy) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    double coeff = -1.0 * ctx.dx * ctx.dy * ctx.dz;
    uniaxial_anisotropy_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.volume_fraction,
        ctx.reduction_scratch,
        ctx.cell_count,
        has_vf,
        coeff,
        ctx.Ku1,
        ctx.Ku2,
        ctx.anisU[0],
        ctx.anisU[1],
        ctx.anisU[2],
        ctx.ku1_field,
        ctx.ku2_field);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

// --- Cubic anisotropy energy kernel ---
template <typename Scalar>
__global__ void cubic_anisotropy_energy_blocks_kernel(
    const Scalar *mx, const Scalar *my, const Scalar *mz,
    const double *volume_fraction, double *block_out, uint64_t n,
    int has_volume_fraction, double coeff,
    double Kc1, double Kc2, double Kc3,
    double c1x, double c1y, double c1z,
    double c2x, double c2y, double c2z,
    const double *kc1_field, const double *kc2_field, const double *kc3_field)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    // c3 = c1 × c2
    double c3x = c1y * c2z - c1z * c2y;
    double c3y = c1z * c2x - c1x * c2z;
    double c3z = c1x * c2y - c1y * c2x;

    double energy = 0.0;
    for (; idx < n; idx += stride) {
        const double phi_i = has_volume_fraction ? volume_fraction[idx] : 1.0;
        double kc1_val = kc1_field ? kc1_field[idx] : Kc1;
        double kc2_val = kc2_field ? kc2_field[idx] : Kc2;
        double kc3_val = kc3_field ? kc3_field[idx] : Kc3;
        double mmx = to_f64(mx[idx]), mmy = to_f64(my[idx]), mmz = to_f64(mz[idx]);
        double m1 = mmx * c1x + mmy * c1y + mmz * c1z;
        double m2 = mmx * c2x + mmy * c2y + mmz * c2z;
        double m3 = mmx * c3x + mmy * c3y + mmz * c3z;
        double m1sq = m1 * m1, m2sq = m2 * m2, m3sq = m3 * m3;
        double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
        energy += coeff * phi_i * (kc1_val * sigma + kc2_val * m1sq * m2sq * m3sq + kc3_val * sigma * sigma);
    }

    shared[threadIdx.x] = energy;
    __syncthreads();
    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) shared[threadIdx.x] += shared[threadIdx.x + offset];
        __syncthreads();
    }
    if (threadIdx.x == 0) block_out[blockIdx.x] = shared[0];
}

// --- DMI energy kernel (interfacial + bulk) ---
template <typename Scalar>
__global__ void dmi_energy_blocks_kernel(
    const Scalar *mx, const Scalar *my, const Scalar *mz,
    double *block_out, uint64_t n, double coeff,
    int has_interfacial, int has_bulk,
    double D_int, double D_bulk,
    int nx, int ny, int nz,
    int periodic_x, int periodic_y, int periodic_z,
    double inv_2dx, double inv_2dy, double inv_2dz,
    double exchange_stiffness,
    const uint8_t *active_mask, int has_active_mask)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t gidx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; gidx < n; gidx += stride) {
        if (has_active_mask && active_mask[gidx] == 0) continue;

        int idx = static_cast<int>(gidx);
        int iz = idx / (ny * nx);
        int rem = idx - iz * ny * nx;
        int iy = rem / nx;
        int ix = rem - iy * nx;

        int xm = pbc_neighbor_index(ix, nx, 1, idx, -1, periodic_x);
        int xp = pbc_neighbor_index(ix, nx, 1, idx, 1, periodic_x);
        int ym = pbc_neighbor_index(iy, ny, nx, idx, -1, periodic_y);
        int yp = pbc_neighbor_index(iy, ny, nx, idx, 1, periodic_y);
        int zm = pbc_neighbor_index(iz, nz, nx * ny, idx, -1, periodic_z);
        int zp = pbc_neighbor_index(iz, nz, nx * ny, idx, 1, periodic_z);

        if (has_active_mask) {
            if (active_mask[xm] == 0) xm = idx;
            if (active_mask[xp] == 0) xp = idx;
            if (active_mask[ym] == 0) ym = idx;
            if (active_mask[yp] == 0) yp = idx;
            if (active_mask[zm] == 0) zm = idx;
            if (active_mask[zp] == 0) zp = idx;
        }

        double mmx = to_f64(mx[idx]), mmy = to_f64(my[idx]), mmz = to_f64(mz[idx]);

        const bool missing_xm = !periodic_x && ix == 0;
        const bool missing_xp = !periodic_x && ix == nx - 1;
        const bool missing_ym = !periodic_y && iy == 0;
        const bool missing_yp = !periodic_y && iy == ny - 1;
        double mxm = to_f64(mx[xm]), mym = to_f64(my[xm]), mzm = to_f64(mz[xm]);
        double mxp = to_f64(mx[xp]), myp = to_f64(my[xp]), mzp = to_f64(mz[xp]);
        double mxym = to_f64(mx[ym]), myym = to_f64(my[ym]), mzym = to_f64(mz[ym]);
        double mxyP = to_f64(mx[yp]), myyP = to_f64(my[yp]), mzyP = to_f64(mz[yp]);
        if (has_interfacial && exchange_stiffness > 0.0) {
            const double d_over_2a = D_int / (2.0 * exchange_stiffness);
            const double dx_cell = 1.0 / (2.0 * inv_2dx);
            const double dy_cell = 1.0 / (2.0 * inv_2dy);
            if (missing_xm) {
                mxm = mmx + dx_cell * d_over_2a * mmz;
                mzm = mmz - dx_cell * d_over_2a * mmx;
            }
            if (missing_xp) {
                mxp = mmx - dx_cell * d_over_2a * mmz;
                mzp = mmz + dx_cell * d_over_2a * mmx;
            }
            if (missing_ym) {
                myym = mmy + dy_cell * d_over_2a * mmz;
                mzym = mmz - dy_cell * d_over_2a * mmy;
            }
            if (missing_yp) {
                myyP = mmy - dy_cell * d_over_2a * mmz;
                mzyP = mmz + dy_cell * d_over_2a * mmy;
            }
        }

        if (has_interfacial) {
            // E_dmi = D * [mz(dmx/dx + dmy/dy) - mx*dmz/dx - my*dmz/dy] * V
            double dmx_dx = (mxp - mxm) * inv_2dx;
            double dmy_dy = (myyP - myym) * inv_2dy;
            double dmz_dx = (mzp - mzm) * inv_2dx;
            double dmz_dy = (mzyP - mzym) * inv_2dy;
            energy += coeff * D_int * (mmz * (dmx_dx + dmy_dy) - mmx * dmz_dx - mmy * dmz_dy);
        }

        if (has_bulk) {
            // E_bulk = D * m · (curl m) * V
            double dmz_dy = (to_f64(mz[yp]) - to_f64(mz[ym])) * inv_2dy;
            double dmy_dz = (to_f64(my[zp]) - to_f64(my[zm])) * inv_2dz;
            double dmx_dz = (to_f64(mx[zp]) - to_f64(mx[zm])) * inv_2dz;
            double dmz_dx = (to_f64(mz[xp]) - to_f64(mz[xm])) * inv_2dx;
            double dmy_dx = (to_f64(my[xp]) - to_f64(my[xm])) * inv_2dx;
            double dmx_dy = (to_f64(mx[yp]) - to_f64(mx[ym])) * inv_2dy;
            double curl_x = dmz_dy - dmy_dz;
            double curl_y = dmx_dz - dmz_dx;
            double curl_z = dmy_dx - dmx_dy;
            energy += coeff * D_bulk * (mmx * curl_x + mmy * curl_y + mmz * curl_z);
        }
    }

    shared[threadIdx.x] = energy;
    __syncthreads();
    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) shared[threadIdx.x] += shared[threadIdx.x + offset];
        __syncthreads();
    }
    if (threadIdx.x == 0) block_out[blockIdx.x] = shared[0];
}

double reduce_cubic_anisotropy_energy_fp64(Context &ctx) {
    if (!ctx.has_cubic_anisotropy) return 0.0;
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    double coeff = ctx.dx * ctx.dy * ctx.dz;
    cubic_anisotropy_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        ctx.volume_fraction, ctx.reduction_scratch, ctx.cell_count, has_vf, coeff,
        ctx.Kc1, ctx.Kc2, ctx.Kc3,
        ctx.cubic_axis1[0], ctx.cubic_axis1[1], ctx.cubic_axis1[2],
        ctx.cubic_axis2[0], ctx.cubic_axis2[1], ctx.cubic_axis2[2],
        ctx.kc1_field, ctx.kc2_field, ctx.kc3_field);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_cubic_anisotropy_energy_fp32(Context &ctx) {
    if (!ctx.has_cubic_anisotropy) return 0.0;
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    int has_vf = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    double coeff = ctx.dx * ctx.dy * ctx.dz;
    cubic_anisotropy_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.volume_fraction, ctx.reduction_scratch, ctx.cell_count, has_vf, coeff,
        ctx.Kc1, ctx.Kc2, ctx.Kc3,
        ctx.cubic_axis1[0], ctx.cubic_axis1[1], ctx.cubic_axis1[2],
        ctx.cubic_axis2[0], ctx.cubic_axis2[1], ctx.cubic_axis2[2],
        ctx.kc1_field, ctx.kc2_field, ctx.kc3_field);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_dmi_energy_fp64(Context &ctx) {
    if (!ctx.has_interfacial_dmi && !ctx.has_bulk_dmi) return 0.0;
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = ctx.dx * ctx.dy * ctx.dz;
    dmi_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        ctx.reduction_scratch, ctx.cell_count, coeff,
        ctx.has_interfacial_dmi ? 1 : 0, ctx.has_bulk_dmi ? 1 : 0,
        ctx.D_interfacial, ctx.D_bulk,
        static_cast<int>(ctx.nx), static_cast<int>(ctx.ny), static_cast<int>(ctx.nz),
        ctx.periodic_x ? 1 : 0, ctx.periodic_y ? 1 : 0, ctx.periodic_z ? 1 : 0,
        0.5 / ctx.dx, 0.5 / ctx.dy, 0.5 / ctx.dz,
        ctx.A,
        ctx.active_mask, ctx.has_active_mask ? 1 : 0);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

double reduce_dmi_energy_fp32(Context &ctx) {
    if (!ctx.has_interfacial_dmi && !ctx.has_bulk_dmi) return 0.0;
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = ctx.dx * ctx.dy * ctx.dz;
    dmi_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.reduction_scratch, ctx.cell_count, coeff,
        ctx.has_interfacial_dmi ? 1 : 0, ctx.has_bulk_dmi ? 1 : 0,
        ctx.D_interfacial, ctx.D_bulk,
        static_cast<int>(ctx.nx), static_cast<int>(ctx.ny), static_cast<int>(ctx.nz),
        ctx.periodic_x ? 1 : 0, ctx.periodic_y ? 1 : 0, ctx.periodic_z ? 1 : 0,
        0.5 / ctx.dx, 0.5 / ctx.dy, 0.5 / ctx.dz,
        ctx.A,
        ctx.active_mask, ctx.has_active_mask ? 1 : 0);
    return finalize_sum_reduction(ctx, ctx.reduction_scratch, blocks);
}

} // namespace fdm
} // namespace fullmag
