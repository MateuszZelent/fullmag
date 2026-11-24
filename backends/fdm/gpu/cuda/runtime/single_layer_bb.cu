/*
 * single_layer_bb.cu — Device-resident single-layer projected-gradient
 * Barzilai-Borwein (PG-BB) vector algebra and fused scalar reductions.
 *
 * Supports both FP64 and FP32 state storage with FP64 reduction accumulators.
 * The host owns Armijo/BB scalar control; no full vector fields cross PCIe
 * inside the PGBB hot loop.
 */

#include "context.hpp"
#include "../interactions/regional_field_drive.cuh"

#include <cuda_runtime.h>

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdint>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

namespace {

constexpr int BLOCK_SIZE = 128;
constexpr uint64_t MAX_REDUCTION_BLOCKS = 4096ULL;
constexpr int SCALAR_COUNT = static_cast<int>(FULLMAG_FDM_SINGLE_LAYER_BB_SCALAR_COUNT_V1);
constexpr double MU0 = 4.0 * kFullmagPi * 1e-7;

static_assert(SCALAR_COUNT == 22, "single-layer BB scalar pack layout mismatch");

struct Vec3 {
    double x;
    double y;
    double z;
};

__device__ __forceinline__ double dot3(Vec3 a, Vec3 b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

__device__ __forceinline__ Vec3 add3(Vec3 a, Vec3 b) {
    return {a.x + b.x, a.y + b.y, a.z + b.z};
}

__device__ __forceinline__ Vec3 sub3(Vec3 a, Vec3 b) {
    return {a.x - b.x, a.y - b.y, a.z - b.z};
}

__device__ __forceinline__ Vec3 scale3(Vec3 a, double s) {
    return {a.x * s, a.y * s, a.z * s};
}

__device__ __forceinline__ bool is_finite3(Vec3 v) {
    return isfinite(v.x) && isfinite(v.y) && isfinite(v.z);
}

__device__ __forceinline__ double length3(Vec3 v) {
    return sqrt(dot3(v, v));
}

__device__ __forceinline__ Vec3 tangent_proj(Vec3 m, Vec3 a) {
    const double mm = dot3(m, m);
    if (mm <= DBL_MIN) {
        return {0.0, 0.0, 0.0};
    }
    return sub3(a, scale3(m, dot3(m, a) / mm));
}

template <typename Scalar>
__device__ __forceinline__ Vec3 read_vec(DeviceVectorField field, uint64_t idx) {
    return {
        static_cast<double>(static_cast<const Scalar *>(field.x)[idx]),
        static_cast<double>(static_cast<const Scalar *>(field.y)[idx]),
        static_cast<double>(static_cast<const Scalar *>(field.z)[idx]),
    };
}

template <typename Scalar>
__device__ __forceinline__ void write_vec(DeviceVectorField field, uint64_t idx, Vec3 v) {
    static_cast<Scalar *>(field.x)[idx] = static_cast<Scalar>(v.x);
    static_cast<Scalar *>(field.y)[idx] = static_cast<Scalar>(v.y);
    static_cast<Scalar *>(field.z)[idx] = static_cast<Scalar>(v.z);
}

template <typename Scalar>
__device__ __forceinline__ double unit_norm_sq_tolerance();

template <>
__device__ __forceinline__ double unit_norm_sq_tolerance<double>() {
    return 1e-10;
}

template <>
__device__ __forceinline__ double unit_norm_sq_tolerance<float>() {
    return 1e-5;
}

__device__ __forceinline__ bool is_max_metric(int k) {
    return k >= 7 && k <= 10;
}

__device__ __forceinline__ uint64_t pbc_neighbor_u64(
    int coord,
    int dim,
    uint64_t stride,
    uint64_t idx,
    int delta,
    int periodic)
{
    int nc = coord + delta;
    if (periodic && dim > 1) {
        if (nc < 0) nc = dim - 1;
        if (nc >= dim) nc = 0;
        const int64_t shift = static_cast<int64_t>(nc - coord) * static_cast<int64_t>(stride);
        return static_cast<uint64_t>(static_cast<int64_t>(idx) + shift);
    }
    if (nc < 0 || nc >= dim) {
        return idx;
    }
    const int64_t shift = static_cast<int64_t>(delta) * static_cast<int64_t>(stride);
    return static_cast<uint64_t>(static_cast<int64_t>(idx) + shift);
}

struct SingleLayerBbMetricsParams {
    DeviceVectorField m;
    DeviceVectorField h_eff;
    DeviceVectorField h_demag;
    DeviceVectorField pre_step_m;
    DeviceVectorField g_old;
    DeviceVectorField h_eff_old;
    DeviceVectorField h_oe_static;
    const uint8_t *active_mask;
    const double *ms_field;
    const double *volume_fraction;
    const double *exchange_face_xp;
    const double *exchange_face_yp;
    const double *exchange_face_zp;
    const double *face_link_xp;
    const double *face_link_yp;
    const double *face_link_zp;
    const double *ku1_field;
    const double *ku2_field;
    const double *kc1_field;
    const double *kc2_field;
    const double *kc3_field;
    const void *regional_drive_x;
    const void *regional_drive_y;
    const void *regional_drive_z;
    const RegionalFieldDriveParams *regional_drive_params;
    const double *regional_drive_points;
    RegionalFieldDriveHostMultipliers regional_drive_host;
    uint32_t regional_drive_count;
    uint64_t cell_count;
    int nx;
    int ny;
    int nz;
    int periodic_x;
    int periodic_y;
    int periodic_z;
    int enable_exchange;
    int has_exchange_faces;
    int use_t0_exchange;
    int enable_demag;
    int has_external_energy;
    int has_external_profile;
    int has_uniaxial_anisotropy;
    int has_cubic_anisotropy;
    int has_interfacial_dmi;
    int has_rotated_interfacial_dmi;
    int has_bulk_dmi;
    int has_magnetoelastic;
    int has_volume_fraction;
    int has_history;
    double Ms;
    double A;
    double cell_volume;
    double inv_dx2;
    double inv_dy2;
    double inv_dz2;
    double inv_2dx;
    double inv_2dy;
    double inv_2dz;
    Vec3 external_field;
    double oe_scale;
    double evaluation_time_s;
    double Ku1;
    double Ku2;
    Vec3 anisU;
    double Kc1;
    double Kc2;
    double Kc3;
    Vec3 cubic_c1;
    Vec3 cubic_c2;
    Vec3 cubic_c3;
    double D_interfacial;
    double D_rotated_interfacial;
    double D_bulk;
    double mel_b1;
    double mel_b2;
    double e11;
    double e22;
    double e33;
    double e23;
    double e13;
    double e12;
};

template <typename Scalar>
__global__ void capture_state_kernel(
    DeviceVectorField m,
    DeviceVectorField h_eff,
    DeviceVectorField pre_step_m,
    DeviceVectorField g_old,
    DeviceVectorField h_eff_old,
    const uint8_t *active_mask,
    uint64_t cell_count)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;
    for (; idx < cell_count; idx += stride) {
        const bool active = !active_mask || active_mask[idx] != 0;
        if (active) {
            const Vec3 mv = read_vec<Scalar>(m, idx);
            const Vec3 hv = read_vec<Scalar>(h_eff, idx);
            const Vec3 gv = scale3(tangent_proj(mv, hv), -1.0);
            static_cast<Scalar *>(pre_step_m.x)[idx] = static_cast<const Scalar *>(m.x)[idx];
            static_cast<Scalar *>(pre_step_m.y)[idx] = static_cast<const Scalar *>(m.y)[idx];
            static_cast<Scalar *>(pre_step_m.z)[idx] = static_cast<const Scalar *>(m.z)[idx];
            write_vec<Scalar>(g_old, idx, gv);
            static_cast<Scalar *>(h_eff_old.x)[idx] = static_cast<const Scalar *>(h_eff.x)[idx];
            static_cast<Scalar *>(h_eff_old.y)[idx] = static_cast<const Scalar *>(h_eff.y)[idx];
            static_cast<Scalar *>(h_eff_old.z)[idx] = static_cast<const Scalar *>(h_eff.z)[idx];
        } else {
            const Scalar zero = static_cast<Scalar>(0.0);
            static_cast<Scalar *>(pre_step_m.x)[idx] = zero;
            static_cast<Scalar *>(pre_step_m.y)[idx] = zero;
            static_cast<Scalar *>(pre_step_m.z)[idx] = zero;
            static_cast<Scalar *>(g_old.x)[idx] = zero;
            static_cast<Scalar *>(g_old.y)[idx] = zero;
            static_cast<Scalar *>(g_old.z)[idx] = zero;
            static_cast<Scalar *>(h_eff_old.x)[idx] = zero;
            static_cast<Scalar *>(h_eff_old.y)[idx] = zero;
            static_cast<Scalar *>(h_eff_old.z)[idx] = zero;
        }
    }
}

template <typename Scalar>
__global__ void restore_state_kernel(
    DeviceVectorField m,
    DeviceVectorField pre_step_m,
    uint64_t cell_count)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;
    for (; idx < cell_count; idx += stride) {
        static_cast<Scalar *>(m.x)[idx] = static_cast<const Scalar *>(pre_step_m.x)[idx];
        static_cast<Scalar *>(m.y)[idx] = static_cast<const Scalar *>(pre_step_m.y)[idx];
        static_cast<Scalar *>(m.z)[idx] = static_cast<const Scalar *>(pre_step_m.z)[idx];
    }
}

template <typename Scalar>
__global__ void trial_retract_kernel(
    DeviceVectorField m,
    DeviceVectorField pre_step_m,
    DeviceVectorField g_old,
    const uint8_t *active_mask,
    uint64_t cell_count,
    double lambda,
    double *partials,
    uint64_t blocks)
{
    __shared__ double shared_changed[BLOCK_SIZE];
    __shared__ double shared_invalid[BLOCK_SIZE];

    double changed = 0.0;
    double invalid = 0.0;

    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;
    for (; idx < cell_count; idx += stride) {
        const Scalar ox = static_cast<const Scalar *>(pre_step_m.x)[idx];
        const Scalar oy = static_cast<const Scalar *>(pre_step_m.y)[idx];
        const Scalar oz = static_cast<const Scalar *>(pre_step_m.z)[idx];

        Scalar tx = static_cast<Scalar>(0.0);
        Scalar ty = static_cast<Scalar>(0.0);
        Scalar tz = static_cast<Scalar>(0.0);

        if (!active_mask || active_mask[idx] != 0) {
            const Vec3 old_v = {
                static_cast<double>(ox),
                static_cast<double>(oy),
                static_cast<double>(oz),
            };
            const Vec3 g = read_vec<Scalar>(g_old, idx);
            const Vec3 raw = sub3(old_v, scale3(g, lambda));
            const double n2 = dot3(raw, raw);
            if (!is_finite3(raw) || !isfinite(n2) || n2 <= DBL_MIN) {
                invalid += 1.0;
                tx = ox;
                ty = oy;
                tz = oz;
            } else {
                const double inv = 1.0 / sqrt(n2);
                tx = static_cast<Scalar>(raw.x * inv);
                ty = static_cast<Scalar>(raw.y * inv);
                tz = static_cast<Scalar>(raw.z * inv);
            }
        }

        static_cast<Scalar *>(m.x)[idx] = tx;
        static_cast<Scalar *>(m.y)[idx] = ty;
        static_cast<Scalar *>(m.z)[idx] = tz;

        if (tx != ox || ty != oy || tz != oz) {
            changed += 1.0;
        }
    }

    shared_changed[threadIdx.x] = changed;
    shared_invalid[threadIdx.x] = invalid;
    __syncthreads();

    for (int offset = BLOCK_SIZE / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared_changed[threadIdx.x] += shared_changed[threadIdx.x + offset];
            shared_invalid[threadIdx.x] += shared_invalid[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        partials[0ULL * blocks + blockIdx.x] = shared_changed[0];
        partials[1ULL * blocks + blockIdx.x] = shared_invalid[0];
    }
}

__global__ void finish_two_sums_kernel(
    const double *partials,
    double *out_scalars,
    uint64_t blocks)
{
    __shared__ double shared[BLOCK_SIZE];
    const int k = static_cast<int>(blockIdx.x);
    double v = 0.0;
    for (uint64_t i = threadIdx.x; i < blocks; i += BLOCK_SIZE) {
        v += partials[static_cast<uint64_t>(k) * blocks + i];
    }
    shared[threadIdx.x] = v;
    __syncthreads();
    for (int offset = BLOCK_SIZE / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }
    if (threadIdx.x == 0) {
        out_scalars[k] = shared[0];
    }
}

template <typename Scalar>
__global__ void evaluate_metrics_kernel(
    SingleLayerBbMetricsParams p,
    double *partials,
    uint64_t blocks)
{
    __shared__ double shared[SCALAR_COUNT][BLOCK_SIZE];
    double v[SCALAR_COUNT];
    for (int k = 0; k < SCALAR_COUNT; ++k) {
        v[k] = 0.0;
    }

    const double norm_tol = unit_norm_sq_tolerance<Scalar>();
    const uint64_t xy_stride = static_cast<uint64_t>(p.nx) * static_cast<uint64_t>(p.ny);
    const bool has_any_dmi =
        p.has_interfacial_dmi || p.has_rotated_interfacial_dmi || p.has_bulk_dmi;
    const bool need_coords = (p.enable_exchange != 0) || has_any_dmi;
    const double a_times_v = p.A * p.cell_volume;

    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;
    for (; idx < p.cell_count; idx += stride) {
        const Vec3 m = read_vec<Scalar>(p.m, idx);
        const Vec3 h = read_vec<Scalar>(p.h_eff, idx);
        const bool active = !p.active_mask || p.active_mask[idx] != 0;
        const Vec3 g = active ? scale3(tangent_proj(m, h), -1.0) : Vec3{0.0, 0.0, 0.0};

        const double mm = dot3(m, m);
        if (!is_finite3(m) || !is_finite3(h) || !is_finite3(g) ||
            (active ? fabs(mm - 1.0) > norm_tol : mm != 0.0)) {
            v[21] += 1.0;
        }

        if (!active) {
            continue;
        }

        const double phi_i = p.has_volume_fraction ? p.volume_fraction[idx] : 1.0;
        const double ms_i = p.ms_field ? p.ms_field[idx] : p.Ms;
        const double vol_i = p.cell_volume * phi_i;

        int ix = 0, iy = 0, iz = 0;
        if (need_coords) {
            iz = static_cast<int>(idx / xy_stride);
            const uint64_t rem = idx - static_cast<uint64_t>(iz) * xy_stride;
            iy = static_cast<int>(rem / static_cast<uint64_t>(p.nx));
            ix = static_cast<int>(rem - static_cast<uint64_t>(iy) * static_cast<uint64_t>(p.nx));
        }

        // [0] Exchange energy (matches exchange_energy_blocks_kernel / T0 exactly).
        if (p.enable_exchange && phi_i > 0.0) {
            if (p.use_t0_exchange) {
                if (ix + 1 < p.nx) {
                    const double f = p.face_link_xp[idx];
                    if (f > 0.0) {
                        const uint64_t ni = idx + 1ULL;
                        if ((!p.active_mask || p.active_mask[ni] != 0) &&
                            p.volume_fraction[ni] > 0.0) {
                            const double a_ij = p.exchange_face_xp ? p.exchange_face_xp[idx] : p.A;
                            const Vec3 dm = sub3(read_vec<Scalar>(p.m, ni), m);
                            v[0] += a_ij * f * p.cell_volume * dot3(dm, dm) * p.inv_dx2;
                        }
                    }
                }
                if (iy + 1 < p.ny) {
                    const double f = p.face_link_yp[idx];
                    if (f > 0.0) {
                        const uint64_t ni = idx + static_cast<uint64_t>(p.nx);
                        if ((!p.active_mask || p.active_mask[ni] != 0) &&
                            p.volume_fraction[ni] > 0.0) {
                            const double a_ij = p.exchange_face_yp ? p.exchange_face_yp[idx] : p.A;
                            const Vec3 dm = sub3(read_vec<Scalar>(p.m, ni), m);
                            v[0] += a_ij * f * p.cell_volume * dot3(dm, dm) * p.inv_dy2;
                        }
                    }
                }
                if (iz + 1 < p.nz) {
                    const double f = p.face_link_zp[idx];
                    if (f > 0.0) {
                        const uint64_t ni = idx + xy_stride;
                        if ((!p.active_mask || p.active_mask[ni] != 0) &&
                            p.volume_fraction[ni] > 0.0) {
                            const double a_ij = p.exchange_face_zp ? p.exchange_face_zp[idx] : p.A;
                            const Vec3 dm = sub3(read_vec<Scalar>(p.m, ni), m);
                            v[0] += a_ij * f * p.cell_volume * dot3(dm, dm) * p.inv_dz2;
                        }
                    }
                }
            } else {
                if (ix + 1 < p.nx || (p.periodic_x && p.nx > 1)) {
                    const uint64_t ni = (ix + 1 < p.nx)
                        ? idx + 1ULL
                        : idx + 1ULL - static_cast<uint64_t>(p.nx);
                    if (!p.active_mask || p.active_mask[ni] != 0) {
                        const double phi_j = p.has_volume_fraction ? p.volume_fraction[ni] : 1.0;
                        if (phi_j > 0.0) {
                            const double phi_pair = 0.5 * (phi_i + phi_j);
                            const double coeff = p.has_exchange_faces
                                ? p.exchange_face_xp[idx] * phi_pair * p.cell_volume
                                : a_times_v * phi_pair;
                            const Vec3 dm = sub3(read_vec<Scalar>(p.m, ni), m);
                            v[0] += coeff * dot3(dm, dm) * p.inv_dx2;
                        }
                    }
                }
                if (iy + 1 < p.ny || (p.periodic_y && p.ny > 1)) {
                    const uint64_t ni = (iy + 1 < p.ny)
                        ? idx + static_cast<uint64_t>(p.nx)
                        : idx + static_cast<uint64_t>(p.nx) - xy_stride;
                    if (!p.active_mask || p.active_mask[ni] != 0) {
                        const double phi_j = p.has_volume_fraction ? p.volume_fraction[ni] : 1.0;
                        if (phi_j > 0.0) {
                            const double phi_pair = 0.5 * (phi_i + phi_j);
                            const double coeff = p.has_exchange_faces
                                ? p.exchange_face_yp[idx] * phi_pair * p.cell_volume
                                : a_times_v * phi_pair;
                            const Vec3 dm = sub3(read_vec<Scalar>(p.m, ni), m);
                            v[0] += coeff * dot3(dm, dm) * p.inv_dy2;
                        }
                    }
                }
                if (iz + 1 < p.nz || (p.periodic_z && p.nz > 1)) {
                    const uint64_t ni = (iz + 1 < p.nz)
                        ? idx + xy_stride
                        : idx + xy_stride - static_cast<uint64_t>(p.nz) * xy_stride;
                    if (!p.active_mask || p.active_mask[ni] != 0) {
                        const double phi_j = p.has_volume_fraction ? p.volume_fraction[ni] : 1.0;
                        if (phi_j > 0.0) {
                            const double phi_pair = 0.5 * (phi_i + phi_j);
                            const double coeff = p.has_exchange_faces
                                ? p.exchange_face_zp[idx] * phi_pair * p.cell_volume
                                : a_times_v * phi_pair;
                            const Vec3 dm = sub3(read_vec<Scalar>(p.m, ni), m);
                            v[0] += coeff * dot3(dm, dm) * p.inv_dz2;
                        }
                    }
                }
            }
        }

        // [1] Demag energy and [9] max |H_demag|.
        if (p.enable_demag) {
            const Vec3 hd = read_vec<Scalar>(p.h_demag, idx);
            v[1] += -0.5 * MU0 * ms_i * vol_i * dot3(m, hd);
            v[9] = fmax(v[9], length3(hd));
        }

        // [2] External + static external profile / Oersted + regional drive energy.
        if (p.has_external_energy) {
            Vec3 hext = p.external_field;
            if (p.has_external_profile) {
                hext = add3(hext, scale3(read_vec<Scalar>(p.h_oe_static, idx), p.oe_scale));
            }
            if (p.regional_drive_count != 0) {
                hext.x += regional_field_drive_component(
                    static_cast<const Scalar *>(p.regional_drive_x),
                    p.regional_drive_params,
                    p.regional_drive_points,
                    p.regional_drive_host,
                    p.regional_drive_count,
                    p.cell_count,
                    idx,
                    p.evaluation_time_s);
                hext.y += regional_field_drive_component(
                    static_cast<const Scalar *>(p.regional_drive_y),
                    p.regional_drive_params,
                    p.regional_drive_points,
                    p.regional_drive_host,
                    p.regional_drive_count,
                    p.cell_count,
                    idx,
                    p.evaluation_time_s);
                hext.z += regional_field_drive_component(
                    static_cast<const Scalar *>(p.regional_drive_z),
                    p.regional_drive_params,
                    p.regional_drive_points,
                    p.regional_drive_host,
                    p.regional_drive_count,
                    p.cell_count,
                    idx,
                    p.evaluation_time_s);
            }
            v[2] += -MU0 * ms_i * vol_i * dot3(m, hext);
        }

        // [3] Uniaxial anisotropy energy.
        if (p.has_uniaxial_anisotropy) {
            const double ku1 = p.ku1_field ? p.ku1_field[idx] : p.Ku1;
            const double ku2 = p.ku2_field ? p.ku2_field[idx] : p.Ku2;
            const double mu = dot3(m, p.anisU);
            const double mu2 = mu * mu;
            v[3] += -vol_i * (ku1 * mu2 + ku2 * mu2 * mu2);
        }

        // [4] Cubic anisotropy energy.
        if (p.has_cubic_anisotropy) {
            const double kc1 = p.kc1_field ? p.kc1_field[idx] : p.Kc1;
            const double kc2 = p.kc2_field ? p.kc2_field[idx] : p.Kc2;
            const double kc3 = p.kc3_field ? p.kc3_field[idx] : p.Kc3;
            const double m1 = dot3(m, p.cubic_c1);
            const double m2 = dot3(m, p.cubic_c2);
            const double m3 = dot3(m, p.cubic_c3);
            const double m1s = m1 * m1;
            const double m2s = m2 * m2;
            const double m3s = m3 * m3;
            const double sigma = m1s * m2s + m2s * m3s + m1s * m3s;
            v[4] += vol_i * (kc1 * sigma + kc2 * m1s * m2s * m3s + kc3 * sigma * sigma);
        }

        // [5] DMI energy (matches dmi_energy_blocks_kernel exactly).
        if (has_any_dmi) {
            uint64_t xm = pbc_neighbor_u64(ix, p.nx, 1ULL, idx, -1, p.periodic_x);
            uint64_t xp = pbc_neighbor_u64(ix, p.nx, 1ULL, idx, +1, p.periodic_x);
            uint64_t ym = pbc_neighbor_u64(iy, p.ny, static_cast<uint64_t>(p.nx), idx, -1, p.periodic_y);
            uint64_t yp = pbc_neighbor_u64(iy, p.ny, static_cast<uint64_t>(p.nx), idx, +1, p.periodic_y);
            uint64_t zm = pbc_neighbor_u64(iz, p.nz, xy_stride, idx, -1, p.periodic_z);
            uint64_t zp = pbc_neighbor_u64(iz, p.nz, xy_stride, idx, +1, p.periodic_z);
            if (p.active_mask) {
                if (p.active_mask[xm] == 0) xm = idx;
                if (p.active_mask[xp] == 0) xp = idx;
                if (p.active_mask[ym] == 0) ym = idx;
                if (p.active_mask[yp] == 0) yp = idx;
                if (p.active_mask[zm] == 0) zm = idx;
                if (p.active_mask[zp] == 0) zp = idx;
            }
            const Vec3 m_xm = read_vec<Scalar>(p.m, xm);
            const Vec3 m_xp = read_vec<Scalar>(p.m, xp);
            const Vec3 m_ym = read_vec<Scalar>(p.m, ym);
            const Vec3 m_yp = read_vec<Scalar>(p.m, yp);

            if (p.has_interfacial_dmi) {
                const double dmx_dx = (m_xp.x - m_xm.x) * p.inv_2dx;
                const double dmy_dy = (m_yp.y - m_ym.y) * p.inv_2dy;
                const double dmz_dx = (m_xp.z - m_xm.z) * p.inv_2dx;
                const double dmz_dy = (m_yp.z - m_ym.z) * p.inv_2dy;
                v[5] += p.cell_volume * p.D_interfacial *
                    (m.z * (dmx_dx + dmy_dy) - m.x * dmz_dx - m.y * dmz_dy);
            }
            if (p.has_rotated_interfacial_dmi) {
                const double sx = 2.0 * p.cell_volume * p.inv_2dx;
                const double sy = 2.0 * p.cell_volume * p.inv_2dy;
                if ((p.periodic_x || ix + 1 < p.nx) &&
                    (!p.active_mask || p.active_mask[xp] != 0)) {
                    v[5] += p.D_rotated_interfacial * sx *
                        (0.5 * (m.z + m_xp.z) * (m_xp.x - m.x) -
                         0.5 * (m.x + m_xp.x) * (m_xp.z - m.z));
                }
                if ((p.periodic_y || iy + 1 < p.ny) &&
                    (!p.active_mask || p.active_mask[yp] != 0)) {
                    v[5] += p.D_rotated_interfacial * sy *
                        (0.5 * (m.x + m_yp.x) * (m_yp.y - m.y) -
                         0.5 * (m.y + m_yp.y) * (m_yp.x - m.x));
                }
            }
            if (p.has_bulk_dmi) {
                const Vec3 m_zm = read_vec<Scalar>(p.m, zm);
                const Vec3 m_zp = read_vec<Scalar>(p.m, zp);
                const double dmz_dy = (m_yp.z - m_ym.z) * p.inv_2dy;
                const double dmy_dz = (m_zp.y - m_zm.y) * p.inv_2dz;
                const double dmx_dz = (m_zp.x - m_zm.x) * p.inv_2dz;
                const double dmz_dx = (m_xp.z - m_xm.z) * p.inv_2dx;
                const double dmy_dx = (m_xp.y - m_xm.y) * p.inv_2dx;
                const double dmx_dy = (m_yp.x - m_ym.x) * p.inv_2dy;
                const double curl_x = dmz_dy - dmy_dz;
                const double curl_y = dmx_dz - dmz_dx;
                const double curl_z = dmy_dx - dmx_dy;
                v[5] += p.cell_volume * p.D_bulk *
                    (m.x * curl_x + m.y * curl_y + m.z * curl_z);
            }
        }

        // [6] Magnetoelastic energy.
        if (p.has_magnetoelastic) {
            const double density =
                p.mel_b1 * (m.x * m.x * p.e11 + m.y * m.y * p.e22 + m.z * m.z * p.e33) +
                2.0 * p.mel_b2 * (m.x * m.y * p.e12 + m.x * m.z * p.e13 + m.y * m.z * p.e23);
            v[6] += vol_i * density;
        }

        // [7..8, 10] Maxima over active domain.
        const Vec3 cross = {
            m.y * h.z - m.z * h.y,
            m.z * h.x - m.x * h.z,
            m.x * h.y - m.y * h.x,
        };
        v[7] = fmax(v[7], length3(cross));
        v[8] = fmax(v[8], length3(h));
        v[10] = fmax(v[10], length3(g));

        // [11..14] Moment-weighted or arithmetic average <m>.
        if (p.ms_field) {
            if (isfinite(ms_i) && ms_i > 0.0) {
                v[11] += ms_i * m.x;
                v[12] += ms_i * m.y;
                v[13] += ms_i * m.z;
                v[14] += ms_i;
            }
        } else {
            v[11] += m.x;
            v[12] += m.y;
            v[13] += m.z;
            v[14] += 1.0;
        }

        // [15..19] Physical energy-metric inner products and BB secant terms.
        if (isfinite(ms_i) && ms_i > 0.0 && isfinite(vol_i) && vol_i > 0.0) {
            const double w = MU0 * ms_i * vol_i;
            v[15] += w * dot3(g, g);
            if (p.has_history) {
                const Vec3 old_m = read_vec<Scalar>(p.pre_step_m, idx);
                const Vec3 old_g = read_vec<Scalar>(p.g_old, idx);
                const Vec3 old_h = read_vec<Scalar>(p.h_eff_old, idx);
                const Vec3 chord = sub3(m, old_m);
                v[16] += -w * dot3(old_h, chord);
                const Vec3 s = tangent_proj(m, chord);
                const Vec3 y = sub3(g, tangent_proj(m, old_g));
                v[17] += w * dot3(s, s);
                v[18] += w * dot3(s, y);
                v[19] += w * dot3(y, y);
            }
        }

        // [20] Changed cell count relative to accepted state (in storage precision).
        if (p.has_history) {
            const Scalar mx_now = static_cast<const Scalar *>(p.m.x)[idx];
            const Scalar my_now = static_cast<const Scalar *>(p.m.y)[idx];
            const Scalar mz_now = static_cast<const Scalar *>(p.m.z)[idx];
            const Scalar mx_old = static_cast<const Scalar *>(p.pre_step_m.x)[idx];
            const Scalar my_old = static_cast<const Scalar *>(p.pre_step_m.y)[idx];
            const Scalar mz_old = static_cast<const Scalar *>(p.pre_step_m.z)[idx];
            if (mx_now != mx_old || my_now != my_old || mz_now != mz_old) {
                v[20] += 1.0;
            }
        }
    }

    for (int k = 0; k < SCALAR_COUNT; ++k) {
        shared[k][threadIdx.x] = v[k];
    }
    __syncthreads();

    for (int offset = BLOCK_SIZE / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            for (int k = 0; k < SCALAR_COUNT; ++k) {
                shared[k][threadIdx.x] = is_max_metric(k)
                    ? fmax(shared[k][threadIdx.x], shared[k][threadIdx.x + offset])
                    : shared[k][threadIdx.x] + shared[k][threadIdx.x + offset];
            }
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        for (int k = 0; k < SCALAR_COUNT; ++k) {
            partials[static_cast<uint64_t>(k) * blocks + blockIdx.x] = shared[k][0];
        }
    }
}

__global__ void finish_metrics_kernel(
    const double *partials,
    double *out_scalars,
    uint64_t blocks)
{
    __shared__ double shared[BLOCK_SIZE];
    const int k = static_cast<int>(blockIdx.x);
    double v = 0.0;
    for (uint64_t i = threadIdx.x; i < blocks; i += BLOCK_SIZE) {
        const double x = partials[static_cast<uint64_t>(k) * blocks + i];
        v = is_max_metric(k) ? fmax(v, x) : v + x;
    }
    shared[threadIdx.x] = v;
    __syncthreads();
    for (int offset = BLOCK_SIZE / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] = is_max_metric(k)
                ? fmax(shared[threadIdx.x], shared[threadIdx.x + offset])
                : shared[threadIdx.x] + shared[threadIdx.x + offset];
        }
        __syncthreads();
    }
    if (threadIdx.x == 0) {
        out_scalars[k] = shared[0];
    }
}

uint64_t reduction_blocks_for(uint64_t cell_count) {
    uint64_t blocks = (cell_count + BLOCK_SIZE - 1ULL) / BLOCK_SIZE;
    if (blocks == 0) blocks = 1;
    return std::min<uint64_t>(blocks, MAX_REDUCTION_BLOCKS);
}

bool ensure_single_layer_bb_scratch(Context &ctx, uint64_t blocks) {
    const bool setup_extension =
        ctx.single_layer_bb_partials == nullptr || ctx.single_layer_bb_scalars == nullptr;
    if (ctx.single_layer_bb_partials == nullptr) {
        const cudaError_t err = context_gpu_workspace_cuda_malloc(
            ctx,
            &ctx.single_layer_bb_partials,
            blocks * static_cast<uint64_t>(SCALAR_COUNT) * sizeof(double));
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "allocate single-layer BB partials", err);
            return false;
        }
        ctx.single_layer_bb_partial_capacity = blocks;
    }
    if (ctx.single_layer_bb_scalars == nullptr) {
        const cudaError_t err = context_gpu_workspace_cuda_malloc(
            ctx,
            &ctx.single_layer_bb_scalars,
            static_cast<uint64_t>(SCALAR_COUNT) * sizeof(double));
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "allocate single-layer BB scalars", err);
            return false;
        }
    }
    if (setup_extension) {
        context_mark_gpu_workspace_setup_complete(ctx);
    }
    if (blocks > ctx.single_layer_bb_partial_capacity) {
        ctx.last_error = "resident single-layer BB workspace shape changed";
        return false;
    }
    return true;
}

void invalidate_single_layer_bb_state(Context &ctx) {
    ctx.single_layer_bb_evaluation_valid = false;
    ctx.fsal_valid = false;
    ctx.fsal_pending = false;
    ctx.accepted_step_pending = false;
    ++ctx.accepted_state_revision;
    ctx.abm_startup = 0;
    ctx.abm_last_dt = 0.0;
    context_invalidate_observables(ctx);
}

SingleLayerBbMetricsParams make_metrics_params(Context &ctx) {
    SingleLayerBbMetricsParams p{};
    p.m = ctx.m;
    p.h_eff = ctx.work;
    p.h_demag = ctx.h_demag;
    p.pre_step_m = ctx.gpu_transport_pre_step_m;
    p.g_old = ctx.k1;
    p.h_eff_old = ctx.tmp;
    p.h_oe_static = ctx.h_oe_static;
    p.active_mask = ctx.has_active_mask ? ctx.active_mask : nullptr;
    p.ms_field = ctx.ms_field;
    p.volume_fraction = ctx.volume_fraction;
    p.exchange_face_xp = ctx.exchange_face_xp;
    p.exchange_face_yp = ctx.exchange_face_yp;
    p.exchange_face_zp = ctx.exchange_face_zp;
    p.face_link_xp = ctx.face_link_xp;
    p.face_link_yp = ctx.face_link_yp;
    p.face_link_zp = ctx.face_link_zp;
    p.ku1_field = ctx.ku1_field;
    p.ku2_field = ctx.ku2_field;
    p.kc1_field = ctx.kc1_field;
    p.kc2_field = ctx.kc2_field;
    p.kc3_field = ctx.kc3_field;
    p.regional_drive_x = ctx.regional_field_drive_x;
    p.regional_drive_y = ctx.regional_field_drive_y;
    p.regional_drive_z = ctx.regional_field_drive_z;
    p.regional_drive_params = ctx.regional_field_drive_params;
    p.regional_drive_points = ctx.regional_field_drive_points;
    p.evaluation_time_s =
        ctx.accepted_step_pending ? ctx.pending_time : ctx.current_time;
    p.regional_drive_host =
        context_regional_field_drive_host_multipliers(ctx, p.evaluation_time_s);
    p.regional_drive_count = ctx.regional_field_drive_count;
    p.cell_count = ctx.cell_count;
    p.nx = static_cast<int>(ctx.nx);
    p.ny = static_cast<int>(ctx.ny);
    p.nz = static_cast<int>(ctx.nz);
    p.periodic_x = ctx.periodic_x ? 1 : 0;
    p.periodic_y = ctx.periodic_y ? 1 : 0;
    p.periodic_z = ctx.periodic_z ? 1 : 0;
    p.enable_exchange = ctx.enable_exchange ? 1 : 0;
    p.has_exchange_faces = (ctx.has_exchange_faces &&
        ctx.exchange_face_xp != nullptr &&
        ctx.exchange_face_yp != nullptr &&
        ctx.exchange_face_zp != nullptr) ? 1 : 0;
    p.use_t0_exchange = (ctx.boundary_tier >= 1 &&
        ctx.volume_fraction != nullptr &&
        ctx.face_link_xp != nullptr &&
        ctx.face_link_yp != nullptr &&
        ctx.face_link_zp != nullptr) ? 1 : 0;
    p.enable_demag = (ctx.enable_demag &&
        ctx.h_demag.x != nullptr &&
        ctx.h_demag.y != nullptr &&
        ctx.h_demag.z != nullptr) ? 1 : 0;
    const bool has_profile =
        (ctx.has_static_external_field_profile || ctx.has_oersted_field) &&
        ctx.h_oe_static.x != nullptr &&
        ctx.h_oe_static.y != nullptr &&
        ctx.h_oe_static.z != nullptr;
    p.has_external_profile = has_profile ? 1 : 0;
    p.has_external_energy =
        (ctx.has_external_field || has_profile || ctx.regional_field_drive_count != 0) ? 1 : 0;
    p.has_uniaxial_anisotropy = ctx.has_uniaxial_anisotropy ? 1 : 0;
    p.has_cubic_anisotropy = ctx.has_cubic_anisotropy ? 1 : 0;
    p.has_interfacial_dmi = ctx.has_interfacial_dmi ? 1 : 0;
    p.has_rotated_interfacial_dmi = ctx.has_rotated_interfacial_dmi ? 1 : 0;
    p.has_bulk_dmi = ctx.has_bulk_dmi ? 1 : 0;
    p.has_magnetoelastic = ctx.has_magnetoelastic ? 1 : 0;
    p.has_volume_fraction = (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0;
    p.has_history = ctx.single_layer_bb_history_valid ? 1 : 0;
    p.Ms = ctx.Ms;
    p.A = ctx.A;
    p.cell_volume = ctx.dx * ctx.dy * ctx.dz;
    p.inv_dx2 = 1.0 / (ctx.dx * ctx.dx);
    p.inv_dy2 = 1.0 / (ctx.dy * ctx.dy);
    p.inv_dz2 = 1.0 / (ctx.dz * ctx.dz);
    p.inv_2dx = 0.5 / ctx.dx;
    p.inv_2dy = 0.5 / ctx.dy;
    p.inv_2dz = 0.5 / ctx.dz;
    p.external_field = {
        ctx.external_field[0],
        ctx.external_field[1],
        ctx.external_field[2],
    };
    p.oe_scale = ctx.has_static_external_field_profile
        ? 1.0
        : oersted_field_scale(ctx, p.evaluation_time_s);
    p.Ku1 = ctx.Ku1;
    p.Ku2 = ctx.Ku2;
    p.anisU = {ctx.anisU[0], ctx.anisU[1], ctx.anisU[2]};
    p.Kc1 = ctx.Kc1;
    p.Kc2 = ctx.Kc2;
    p.Kc3 = ctx.Kc3;
    p.cubic_c1 = {ctx.cubic_axis1[0], ctx.cubic_axis1[1], ctx.cubic_axis1[2]};
    p.cubic_c2 = {ctx.cubic_axis2[0], ctx.cubic_axis2[1], ctx.cubic_axis2[2]};
    p.cubic_c3 = {
        p.cubic_c1.y * p.cubic_c2.z - p.cubic_c1.z * p.cubic_c2.y,
        p.cubic_c1.z * p.cubic_c2.x - p.cubic_c1.x * p.cubic_c2.z,
        p.cubic_c1.x * p.cubic_c2.y - p.cubic_c1.y * p.cubic_c2.x,
    };
    p.D_interfacial = ctx.D_interfacial;
    p.D_rotated_interfacial = ctx.D_rotated_interfacial;
    p.D_bulk = ctx.D_bulk;
    p.mel_b1 = ctx.mel_b1;
    p.mel_b2 = ctx.mel_b2;
    p.e11 = ctx.mel_strain[0];
    p.e22 = ctx.mel_strain[1];
    p.e33 = ctx.mel_strain[2];
    p.e23 = 0.5 * ctx.mel_strain[3];
    p.e13 = 0.5 * ctx.mel_strain[4];
    p.e12 = 0.5 * ctx.mel_strain[5];
    return p;
}

template <typename Scalar>
bool run_single_layer_bb_typed(
    Context &ctx,
    uint32_t op,
    double lambda,
    double *out,
    uint64_t count)
{
    const cudaStream_t stream = context_orchestration_stream(ctx);
    const uint64_t blocks = reduction_blocks_for(ctx.cell_count);
    const unsigned int grid_blocks = static_cast<unsigned int>(blocks);

    if (op == FULLMAG_FDM_SINGLE_LAYER_BB_OP_CAPTURE) {
        if (!ctx.single_layer_bb_evaluation_valid) {
            ctx.last_error = "resident single-layer BB capture requires a fresh evaluated state";
            return false;
        }
        capture_state_kernel<Scalar><<<grid_blocks, BLOCK_SIZE, 0, stream>>>(
            ctx.m,
            ctx.work,
            ctx.gpu_transport_pre_step_m,
            ctx.k1,
            ctx.tmp,
            ctx.has_active_mask ? ctx.active_mask : nullptr,
            ctx.cell_count);
        const cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "resident single-layer BB capture", err);
            return false;
        }
        ctx.single_layer_bb_history_valid = true;
        return true;
    }

    if (op == FULLMAG_FDM_SINGLE_LAYER_BB_OP_RESTORE) {
        if (!ctx.single_layer_bb_history_valid) {
            ctx.last_error = "resident single-layer BB restore has no accepted state";
            return false;
        }
        invalidate_single_layer_bb_state(ctx);
        restore_state_kernel<Scalar><<<grid_blocks, BLOCK_SIZE, 0, stream>>>(
            ctx.m,
            ctx.gpu_transport_pre_step_m,
            ctx.cell_count);
        const cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "resident single-layer BB restore", err);
            return false;
        }
        return true;
    }

    if (op == FULLMAG_FDM_SINGLE_LAYER_BB_OP_TRIAL) {
        if (!ctx.single_layer_bb_history_valid) {
            ctx.last_error = "resident single-layer BB trial has no accepted state";
            return false;
        }
        if (!std::isfinite(lambda) || lambda <= 0.0) {
            ctx.last_error = "resident single-layer BB trial requires a positive finite step";
            return false;
        }
        if (!ensure_single_layer_bb_scratch(ctx, blocks)) {
            return false;
        }
        invalidate_single_layer_bb_state(ctx);
        trial_retract_kernel<Scalar><<<grid_blocks, BLOCK_SIZE, 0, stream>>>(
            ctx.m,
            ctx.gpu_transport_pre_step_m,
            ctx.k1,
            ctx.has_active_mask ? ctx.active_mask : nullptr,
            ctx.cell_count,
            lambda,
            ctx.single_layer_bb_partials,
            blocks);
        finish_two_sums_kernel<<<2U, BLOCK_SIZE, 0, stream>>>(
            ctx.single_layer_bb_partials,
            ctx.single_layer_bb_scalars,
            blocks);

        double trial_status[2] = {0.0, 0.0};
        cudaError_t err = cudaGetLastError();
        if (err == cudaSuccess) {
            err = fullmag_fdm_receipt_cuda_memcpy_async(
                ctx,
                trial_status,
                ctx.single_layer_bb_scalars,
                sizeof(trial_status),
                cudaMemcpyDeviceToHost,
                stream);
        }
        if (err == cudaSuccess) {
            err = cudaStreamSynchronize(stream);
        }
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "resident single-layer BB trial reduction", err);
            return false;
        }
        for (uint64_t k = 0; k < count; ++k) {
            out[k] = 0.0;
        }
        out[20] = trial_status[0];
        out[21] = trial_status[1];
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_REDUCTION);
        fullmag_fdm_record_control_scalar_d2h(ctx, sizeof(trial_status));
        fullmag_fdm_record_control_scalar_host_sync(ctx);
        return true;
    }

    // op == FULLMAG_FDM_SINGLE_LAYER_BB_OP_EVALUATE (0)
    ctx.single_layer_bb_evaluation_valid = false;
    if (ctx.temperature > 0.0) {
        context_invalidate_observables(ctx);
    }
    if (!context_ensure_observable_fields(ctx, OBSERVABLE_ENDPOINT_CORE_FIELDS)) {
        return false;
    }
    if (!ensure_single_layer_bb_scratch(ctx, blocks)) {
        return false;
    }

    const SingleLayerBbMetricsParams params = make_metrics_params(ctx);
    evaluate_metrics_kernel<Scalar><<<grid_blocks, BLOCK_SIZE, 0, stream>>>(
        params,
        ctx.single_layer_bb_partials,
        blocks);
    finish_metrics_kernel<<<static_cast<unsigned int>(SCALAR_COUNT), BLOCK_SIZE, 0, stream>>>(
        ctx.single_layer_bb_partials,
        ctx.single_layer_bb_scalars,
        blocks);

    cudaError_t err = cudaGetLastError();
    const size_t copy_bytes = static_cast<size_t>(SCALAR_COUNT) * sizeof(double);
    if (err == cudaSuccess) {
        err = fullmag_fdm_receipt_cuda_memcpy_async(
            ctx,
            out,
            ctx.single_layer_bb_scalars,
            copy_bytes,
            cudaMemcpyDeviceToHost,
            stream);
    }
    if (err == cudaSuccess) {
        err = cudaStreamSynchronize(stream);
    }
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "resident single-layer BB scalar reduction", err);
        return false;
    }
    ++ctx.endpoint_field_cache.energy_reduction_count;
    fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_REDUCTION);
    fullmag_fdm_record_control_scalar_d2h(ctx, copy_bytes);
    fullmag_fdm_record_control_scalar_host_sync(ctx);
    ctx.single_layer_bb_evaluation_valid = true;
    return true;
}

} // namespace

bool context_single_layer_bb(
    Context &ctx,
    uint32_t op,
    double lambda,
    double *out,
    uint64_t count)
{
    if (ctx.has_multilayer_plan_v2 || ctx.cell_count == 0) {
        ctx.last_error = "resident single-layer BB requires a non-empty single-grid context";
        return false;
    }
    if (op > FULLMAG_FDM_SINGLE_LAYER_BB_OP_RESTORE) {
        ctx.last_error = "resident single-layer BB operation out of range";
        return false;
    }
    const bool needs_output =
        op == FULLMAG_FDM_SINGLE_LAYER_BB_OP_EVALUATE ||
        op == FULLMAG_FDM_SINGLE_LAYER_BB_OP_TRIAL;
    if (needs_output && (out == nullptr || count != FULLMAG_FDM_SINGLE_LAYER_BB_SCALAR_COUNT_V1)) {
        ctx.last_error = "resident single-layer BB scalar count mismatch";
        return false;
    }
    if (ctx.boundary_tier >= 2 && ctx.delta_xp != nullptr) {
        ctx.last_error = "resident single-layer BB does not support T1 delta boundary exchange";
        return false;
    }
    if (!ctx.m.x || !ctx.m.y || !ctx.m.z ||
        !ctx.work.x || !ctx.work.y || !ctx.work.z ||
        !ctx.gpu_transport_pre_step_m.x || !ctx.gpu_transport_pre_step_m.y ||
        !ctx.gpu_transport_pre_step_m.z ||
        !ctx.k1.x || !ctx.k1.y || !ctx.k1.z ||
        !ctx.tmp.x || !ctx.tmp.y || !ctx.tmp.z) {
        ctx.last_error = "resident single-layer BB requires allocated device workspace fields";
        return false;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        return run_single_layer_bb_typed<double>(ctx, op, lambda, out, count);
    }
    return run_single_layer_bb_typed<float>(ctx, op, lambda, out, count);
}

} // namespace fdm
} // namespace fullmag
