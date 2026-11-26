#include "gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.hpp"

#include <cuda_runtime.h>
#include <math_constants.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace fullmag::fem::oersted {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr int kFarFieldBlockSize = 128;
constexpr std::size_t kMaxCpuMaskBatchBytes = 64u * 1024u * 1024u;
constexpr std::size_t kMaxGridBlocksPerLaunch = 65535u;

bool check_cuda(cudaError_t status, const char *context, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string("direct tetrahedral Oersted CUDA error in ") + context +
        ": " + cudaGetErrorString(status);
    return false;
}

template <typename T>
class CudaDeviceBuffer {
public:
    CudaDeviceBuffer() = default;
    ~CudaDeviceBuffer() { reset(); }

    CudaDeviceBuffer(const CudaDeviceBuffer &) = delete;
    CudaDeviceBuffer &operator=(const CudaDeviceBuffer &) = delete;

    void reset()
    {
        if (ptr_ != nullptr) {
            (void)cudaFree(ptr_);
            ptr_ = nullptr;
            count_ = 0;
        }
    }

    bool allocate(std::size_t count, const char *context, std::string &error)
    {
        reset();
        if (count == 0) {
            return true;
        }
        if (count > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
            error = std::string("direct tetrahedral Oersted CUDA allocation overflow in ") +
                context;
            return false;
        }
        T *raw = nullptr;
        if (!check_cuda(cudaMalloc(reinterpret_cast<void **>(&raw), count * sizeof(T)),
                context, error)) {
            return false;
        }
        ptr_ = raw;
        count_ = count;
        return true;
    }

    bool upload(const T *host_data, std::size_t count, const char *context, std::string &error)
    {
        if (!allocate(count, context, error)) {
            return false;
        }
        if (count == 0) {
            return true;
        }
        return check_cuda(
            cudaMemcpy(ptr_, host_data, count * sizeof(T), cudaMemcpyHostToDevice),
            context, error);
    }

    T *get() const noexcept { return ptr_; }

private:
    T *ptr_ = nullptr;
    std::size_t count_ = 0;
};

struct DoubleDouble {
    double hi;
    double lo;
};

__device__ __forceinline__ DoubleDouble two_sum(double a, double b)
{
    const double s = __dadd_rn(a, b);
    const double bb = __dsub_rn(s, a);
    const double err = __dadd_rn(__dsub_rn(a, __dsub_rn(s, bb)), __dsub_rn(b, bb));
    return {s, err};
}

__device__ __forceinline__ DoubleDouble quick_two_sum(double a, double b)
{
    const double s = __dadd_rn(a, b);
    const double err = __dsub_rn(b, __dsub_rn(s, a));
    return {s, err};
}

__device__ __forceinline__ DoubleDouble two_prod(double a, double b)
{
    const double p = __dmul_rn(a, b);
    const double err = __fma_rn(a, b, -p);
    return {p, err};
}

__device__ __forceinline__ DoubleDouble dd_add(DoubleDouble a, DoubleDouble b)
{
    const DoubleDouble s = two_sum(a.hi, b.hi);
    const DoubleDouble t = two_sum(a.lo, b.lo);
    const DoubleDouble c = quick_two_sum(s.hi, __dadd_rn(s.lo, t.hi));
    return quick_two_sum(c.hi, __dadd_rn(c.lo, t.lo));
}

__device__ __forceinline__ DoubleDouble dd_add_d(DoubleDouble a, double b)
{
    const DoubleDouble s = two_sum(a.hi, b);
    return quick_two_sum(s.hi, __dadd_rn(s.lo, a.lo));
}

__device__ __forceinline__ double dd_to_double_upward(DoubleDouble x)
{
    const double sum = __dadd_rn(x.hi, x.lo);
    const double rem = __dsub_rn(x.lo, __dsub_rn(sum, x.hi));
    if (rem > 0.0 && isfinite(sum)) {
        return nextafter(sum, CUDART_INF);
    }
    return sum;
}

__device__ __forceinline__ bool eval_rt0_current_dd(
    const double vx[4],
    const double vy[4],
    const double vz[4],
    const double coeff[4],
    double abs_det,
    double px,
    double py,
    double pz,
    double &jx,
    double &jy,
    double &jz)
{
    DoubleDouble sx{0.0, 0.0};
    DoubleDouble sy{0.0, 0.0};
    DoubleDouble sz{0.0, 0.0};
    #pragma unroll
    for (int k = 0; k < 4; ++k) {
        const DoubleDouble dx = two_sum(px, -vx[k]);
        const DoubleDouble dy = two_sum(py, -vy[k]);
        const DoubleDouble dz = two_sum(pz, -vz[k]);
        sx = dd_add(sx, two_prod(coeff[k], dx.hi));
        sx = dd_add_d(sx, __dmul_rn(coeff[k], dx.lo));
        sy = dd_add(sy, two_prod(coeff[k], dy.hi));
        sy = dd_add_d(sy, __dmul_rn(coeff[k], dy.lo));
        sz = dd_add(sz, two_prod(coeff[k], dz.hi));
        sz = dd_add_d(sz, __dmul_rn(coeff[k], dz.lo));
    }
    const double sx_sum = __dadd_rn(sx.hi, sx.lo);
    const double sy_sum = __dadd_rn(sy.hi, sy.lo);
    const double sz_sum = __dadd_rn(sz.hi, sz.lo);
    jx = sx_sum / abs_det;
    jy = sy_sum / abs_det;
    jz = sz_sum / abs_det;
    const bool ok_x = isfinite(jx) && ((sx.hi == 0.0 && sx.lo == 0.0) || jx != 0.0);
    const bool ok_y = isfinite(jy) && ((sy.hi == 0.0 && sy.lo == 0.0) || jy != 0.0);
    const bool ok_z = isfinite(jz) && ((sz.hi == 0.0 && sz.lo == 0.0) || jz != 0.0);
    return ok_x && ok_y && ok_z;
}

__device__ __forceinline__ bool eval_tet_rule_dd(
    const double vx[4],
    const double vy[4],
    const double vz[4],
    const double coeff[4],
    double abs_det,
    double tx,
    double ty,
    double tz,
    const double *__restrict__ rule_xyzw,
    int npts,
    DoubleDouble &out_hx,
    DoubleDouble &out_hy,
    DoubleDouble &out_hz,
    DoubleDouble &out_wn)
{
    const double e1x = vx[1] - vx[0];
    const double e1y = vy[1] - vy[0];
    const double e1z = vz[1] - vz[0];
    const double e2x = vx[2] - vx[0];
    const double e2y = vy[2] - vy[0];
    const double e2z = vz[2] - vz[0];
    const double e3x = vx[3] - vx[0];
    const double e3y = vy[3] - vy[0];
    const double e3z = vz[3] - vz[0];

    DoubleDouble hx{0.0, 0.0};
    DoubleDouble hy{0.0, 0.0};
    DoubleDouble hz{0.0, 0.0};
    DoubleDouble wn{0.0, 0.0};

    for (int p = 0; p < npts; ++p) {
        const double b1 = __ldg(&rule_xyzw[4 * p + 0]);
        const double b2 = __ldg(&rule_xyzw[4 * p + 1]);
        const double b3 = __ldg(&rule_xyzw[4 * p + 2]);
        const double rw = __ldg(&rule_xyzw[4 * p + 3]);

        const double px = vx[0] + (e1x * b1 + (e2x * b2 + e3x * b3));
        const double py = vy[0] + (e1y * b1 + (e2y * b2 + e3y * b3));
        const double pz = vz[0] + (e1z * b1 + (e2z * b2 + e3z * b3));

        const double dx = tx - px;
        const double dy = ty - py;
        const double dz = tz - pz;
        const double dist = norm3d(dx, dy, dz);
        if (!(isfinite(dist) && dist > 0.0)) {
            return false;
        }
        const double denom = 4.0 * kPi * dist * dist * dist;
        const double inv_denom = 1.0 / denom;
        if (!(isfinite(denom) && denom > 0.0 && isfinite(inv_denom) && inv_denom > 0.0)) {
            return false;
        }

        double jx = 0.0, jy = 0.0, jz = 0.0;
        if (!eval_rt0_current_dd(vx, vy, vz, coeff, abs_det, px, py, pz, jx, jy, jz)) {
            return false;
        }

        const double cx = jy * dz - jz * dy;
        const double cy = jz * dx - jx * dz;
        const double cz = jx * dy - jy * dx;
        const double w = abs_det * rw;

        const double term_x = (cx * inv_denom) * w;
        const double term_y = (cy * inv_denom) * w;
        const double term_z = (cz * inv_denom) * w;
        const double mag = norm3d(term_x, term_y, term_z);
        if (!isfinite(mag)) {
            return false;
        }

        hx = dd_add_d(hx, term_x);
        hy = dd_add_d(hy, term_y);
        hz = dd_add_d(hz, term_z);
        wn = dd_add_d(wn, mag);
    }

    const double fx = __dadd_rn(hx.hi, hx.lo);
    const double fy = __dadd_rn(hy.hi, hy.lo);
    const double fz = __dadd_rn(hz.hi, hz.lo);
    const double fw = __dadd_rn(wn.hi, wn.lo);
    const bool ok =
        isfinite(fx) && ((hx.hi == 0.0 && hx.lo == 0.0) || fx != 0.0) &&
        isfinite(fy) && ((hy.hi == 0.0 && hy.lo == 0.0) || fy != 0.0) &&
        isfinite(fz) && ((hz.hi == 0.0 && hz.lo == 0.0) || fz != 0.0) &&
        isfinite(fw) && fw >= 0.0;
    if (!ok) {
        return false;
    }

    out_hx = hx;
    out_hy = hy;
    out_hz = hz;
    out_wn = wn;
    return true;
}

struct GpuSourceDeviceViews {
    const double *vertex_x;
    const double *vertex_y;
    const double *vertex_z;
    const double *signed_coefficients_a;
    const double *center_x;
    const double *center_y;
    const double *center_z;
    const double *bounding_radius;
    const double *abs_det;
    std::size_t source_count;
};

__global__ void direct_tetra_root_farfield_kernel(
    GpuSourceDeviceViews src,
    const double *__restrict__ d_target_xyz,
    std::size_t batch_target_count,
    const double *__restrict__ d_low_rule_xyzw,
    int low_npts,
    const double *__restrict__ d_high_rule_xyzw,
    int high_npts,
    double near_radius_factor,
    double relative_tolerance,
    double absolute_tolerance_apm,
    std::size_t words_per_target,
    double *__restrict__ d_far_h_xyz,
    double *__restrict__ d_far_error_sum,
    double *__restrict__ d_far_weighted_norm_sum,
    double *__restrict__ d_far_max_pair_error,
    std::uint64_t *__restrict__ d_far_pair_count,
    std::uint64_t *__restrict__ d_far_kernel_evals,
    std::uint32_t *__restrict__ d_cpu_mask,
    std::uint8_t *__restrict__ d_target_full_cpu)
{
    const std::size_t local_target = static_cast<std::size_t>(blockIdx.x);
    if (local_target >= batch_target_count) {
        return;
    }
    const int tid = static_cast<int>(threadIdx.x);
    const int lane = tid & 31;
    const int warp_id = tid >> 5;

    const double tx = __ldg(&d_target_xyz[3u * local_target + 0u]);
    const double ty = __ldg(&d_target_xyz[3u * local_target + 1u]);
    const double tz = __ldg(&d_target_xyz[3u * local_target + 2u]);

    __shared__ DoubleDouble sh_hx[kFarFieldBlockSize];
    __shared__ DoubleDouble sh_hy[kFarFieldBlockSize];
    __shared__ DoubleDouble sh_hz[kFarFieldBlockSize];
    __shared__ double sh_err[kFarFieldBlockSize];
    __shared__ DoubleDouble sh_wn[kFarFieldBlockSize];
    __shared__ std::uint8_t sh_accepted[kFarFieldBlockSize];

    DoubleDouble acc_hx{0.0, 0.0};
    DoubleDouble acc_hy{0.0, 0.0};
    DoubleDouble acc_hz{0.0, 0.0};
    DoubleDouble acc_err{0.0, 0.0};
    DoubleDouble acc_wn{0.0, 0.0};
    double max_pair_err = 0.0;
    std::uint64_t accepted_pairs = 0;

    const double inv_source_count = 1.0 / static_cast<double>(src.source_count);
    const double per_pair_atol = absolute_tolerance_apm * inv_source_count;

    for (std::size_t tile_base = 0; tile_base < src.source_count;
            tile_base += static_cast<std::size_t>(kFarFieldBlockSize)) {
        const std::size_t s = tile_base + static_cast<std::size_t>(tid);
        const bool active = (s < src.source_count);

        std::uint8_t needs_cpu = 0;
        std::uint8_t accepted = 0;
        DoubleDouble pair_hx{0.0, 0.0};
        DoubleDouble pair_hy{0.0, 0.0};
        DoubleDouble pair_hz{0.0, 0.0};
        DoubleDouble pair_wn{0.0, 0.0};
        double pair_err = 0.0;

        if (active) {
            const double cx = __ldg(&src.center_x[s]);
            const double cy = __ldg(&src.center_y[s]);
            const double cz = __ldg(&src.center_z[s]);
            const double radius = __ldg(&src.bounding_radius[s]);
            const double abs_det = __ldg(&src.abs_det[s]);
            const double dc = norm3d(tx - cx, ty - cy, tz - cz);

            if (!(isfinite(dc) && isfinite(radius) && radius > 0.0 &&
                    isfinite(abs_det) && abs_det > 0.0 &&
                    dc > near_radius_factor * radius)) {
                needs_cpu = 1;
            } else {
                double vx[4], vy[4], vz[4], coeff[4];
                #pragma unroll
                for (int k = 0; k < 4; ++k) {
                    const std::size_t idx = static_cast<std::size_t>(k) * src.source_count + s;
                    vx[k] = __ldg(&src.vertex_x[idx]);
                    vy[k] = __ldg(&src.vertex_y[idx]);
                    vz[k] = __ldg(&src.vertex_z[idx]);
                    coeff[k] = __ldg(&src.signed_coefficients_a[idx]);
                }

                DoubleDouble lo_hx{0.0, 0.0}, lo_hy{0.0, 0.0}, lo_hz{0.0, 0.0}, lo_wn{0.0, 0.0};
                DoubleDouble hi_hx{0.0, 0.0}, hi_hy{0.0, 0.0}, hi_hz{0.0, 0.0}, hi_wn{0.0, 0.0};
                const bool lo_ok = eval_tet_rule_dd(
                    vx, vy, vz, coeff, abs_det, tx, ty, tz,
                    d_low_rule_xyzw, low_npts, lo_hx, lo_hy, lo_hz, lo_wn);
                const bool hi_ok = lo_ok && eval_tet_rule_dd(
                    vx, vy, vz, coeff, abs_det, tx, ty, tz,
                    d_high_rule_xyzw, high_npts, hi_hx, hi_hy, hi_hz, hi_wn);

                if (!hi_ok) {
                    needs_cpu = 1;
                } else {
                    const double hi_x = __dadd_rn(hi_hx.hi, hi_hx.lo);
                    const double hi_y = __dadd_rn(hi_hy.hi, hi_hy.lo);
                    const double hi_z = __dadd_rn(hi_hz.hi, hi_hz.lo);
                    const double lo_x = __dadd_rn(lo_hx.hi, lo_hx.lo);
                    const double lo_y = __dadd_rn(lo_hy.hi, lo_hy.lo);
                    const double lo_z = __dadd_rn(lo_hz.hi, lo_hz.lo);
                    const double err = norm3d(hi_x - lo_x, hi_y - lo_y, hi_z - lo_z);
                    const double hi_norm = norm3d(hi_x, hi_y, hi_z);
                    const DoubleDouble wn = dd_add_d(dd_add(lo_wn, hi_wn), hi_norm);
                    const double pair_hint = 0.25 * fma(relative_tolerance, hi_norm, per_pair_atol);

                    if (isfinite(err) && err >= 0.0 &&
                            isfinite(hi_norm) &&
                            isfinite(wn.hi) && isfinite(wn.lo) && wn.hi >= 0.0 &&
                            isfinite(pair_hint) && err <= pair_hint) {
                        accepted = 1;
                        pair_hx = hi_hx;
                        pair_hy = hi_hy;
                        pair_hz = hi_hz;
                        pair_err = err;
                        pair_wn = wn;
                    } else {
                        needs_cpu = 1;
                    }
                }
            }
        }

        const unsigned int warp_mask = __ballot_sync(0xffffffffu, active && (needs_cpu != 0));
        const std::size_t word_idx = (tile_base >> 5) + static_cast<std::size_t>(warp_id);
        if (lane == 0 && word_idx < words_per_target) {
            d_cpu_mask[local_target * words_per_target + word_idx] =
                static_cast<std::uint32_t>(warp_mask);
        }

        sh_hx[tid] = pair_hx;
        sh_hy[tid] = pair_hy;
        sh_hz[tid] = pair_hz;
        sh_err[tid] = pair_err;
        sh_wn[tid] = pair_wn;
        sh_accepted[tid] = accepted;
        __syncthreads();

        // Deterministic ascending source-index accumulation in 106-bit DoubleDouble.
        if (tid == 0) {
            const std::size_t remaining = src.source_count - tile_base;
            const int tile_len = remaining < static_cast<std::size_t>(kFarFieldBlockSize)
                ? static_cast<int>(remaining)
                : kFarFieldBlockSize;
            for (int i = 0; i < tile_len; ++i) {
                if (sh_accepted[i] != 0) {
                    acc_hx = dd_add(acc_hx, sh_hx[i]);
                    acc_hy = dd_add(acc_hy, sh_hy[i]);
                    acc_hz = dd_add(acc_hz, sh_hz[i]);
                    acc_err = dd_add_d(acc_err, sh_err[i]);
                    acc_wn = dd_add(acc_wn, sh_wn[i]);
                    if (sh_err[i] > max_pair_err) {
                        max_pair_err = sh_err[i];
                    }
                    ++accepted_pairs;
                }
            }
        }
        __syncthreads();
    }

    if (tid == 0) {
        const double out_hx = __dadd_rn(acc_hx.hi, acc_hx.lo);
        const double out_hy = __dadd_rn(acc_hy.hi, acc_hy.lo);
        const double out_hz = __dadd_rn(acc_hz.hi, acc_hz.lo);
        const double out_err = dd_to_double_upward(acc_err);
        const double out_wn = dd_to_double_upward(acc_wn);
        const bool ok =
            isfinite(out_hx) && isfinite(out_hy) && isfinite(out_hz) &&
            isfinite(out_err) && out_err >= 0.0 &&
            isfinite(out_wn) && out_wn >= 0.0 &&
            isfinite(max_pair_err) && max_pair_err >= 0.0;
        if (ok) {
            d_far_h_xyz[3u * local_target + 0u] = out_hx;
            d_far_h_xyz[3u * local_target + 1u] = out_hy;
            d_far_h_xyz[3u * local_target + 2u] = out_hz;
            d_far_error_sum[local_target] = out_err;
            d_far_weighted_norm_sum[local_target] = out_wn;
            d_far_max_pair_error[local_target] = max_pair_err;
            d_far_pair_count[local_target] = accepted_pairs;
            d_far_kernel_evals[local_target] = accepted_pairs *
                static_cast<std::uint64_t>(low_npts + high_npts);
            d_target_full_cpu[local_target] = 0;
        } else {
            d_far_h_xyz[3u * local_target + 0u] = 0.0;
            d_far_h_xyz[3u * local_target + 1u] = 0.0;
            d_far_h_xyz[3u * local_target + 2u] = 0.0;
            d_far_error_sum[local_target] = 0.0;
            d_far_weighted_norm_sum[local_target] = 0.0;
            d_far_max_pair_error[local_target] = 0.0;
            d_far_pair_count[local_target] = 0;
            d_far_kernel_evals[local_target] = 0;
            d_target_full_cpu[local_target] = 1;
        }
    }
}

bool validate_host_inputs(
    const GpuDirectTetraSourceHostData &sources,
    const double *target_xyz,
    std::size_t target_count,
    const double *low_rule_xyzw,
    int low_npts,
    const double *high_rule_xyzw,
    int high_npts,
    double near_radius_factor,
    double relative_tolerance,
    double absolute_tolerance_apm,
    std::string &error)
{
    const std::size_t n = sources.source_count;
    if (n > static_cast<std::size_t>(std::numeric_limits<std::uint32_t>::max())) {
        error = "direct tetrahedral Oersted CUDA source count exceeds uint32 range";
        return false;
    }
    if (sources.vertex_x.size() != 4u * n ||
            sources.vertex_y.size() != 4u * n ||
            sources.vertex_z.size() != 4u * n ||
            sources.signed_coefficients_a.size() != 4u * n ||
            sources.center_x.size() != n ||
            sources.center_y.size() != n ||
            sources.center_z.size() != n ||
            sources.bounding_radius.size() != n ||
            sources.volume.size() != n ||
            sources.abs_det.size() != n) {
        error = "direct tetrahedral Oersted CUDA source SoA host buffers have inconsistent sizes";
        return false;
    }
    if (target_count > 0 && target_xyz == nullptr) {
        error = "direct tetrahedral Oersted CUDA target buffer is null";
        return false;
    }
    if (low_npts <= 0 || high_npts <= 0 ||
            low_rule_xyzw == nullptr || high_rule_xyzw == nullptr) {
        error = "direct tetrahedral Oersted CUDA quadrature rule buffers are invalid";
        return false;
    }
    if (!(std::isfinite(near_radius_factor) && near_radius_factor >= 1.0 &&
            std::isfinite(relative_tolerance) && relative_tolerance >= 0.0 &&
            std::isfinite(absolute_tolerance_apm) && absolute_tolerance_apm >= 0.0)) {
        error = "direct tetrahedral Oersted CUDA tolerances or near-radius factor are invalid";
        return false;
    }
    return true;
}

} // namespace

bool fullmag_cuda_direct_tetra_evaluate_root_farfield(
    const GpuDirectTetraSourceHostData &sources,
    const double *target_xyz,
    std::size_t target_count,
    const double *low_rule_xyzw,
    int low_npts,
    const double *high_rule_xyzw,
    int high_npts,
    double near_radius_factor,
    double relative_tolerance,
    double absolute_tolerance_apm,
    GpuDirectTetraTargetResult &out,
    std::string &error)
{
    out = GpuDirectTetraTargetResult{};
    error.clear();

    if (!validate_host_inputs(sources, target_xyz, target_count,
            low_rule_xyzw, low_npts, high_rule_xyzw, high_npts,
            near_radius_factor, relative_tolerance, absolute_tolerance_apm, error)) {
        return false;
    }

    int device_count = 0;
    const cudaError_t dev_status = cudaGetDeviceCount(&device_count);
    if (dev_status != cudaSuccess || device_count <= 0) {
        error = dev_status != cudaSuccess
            ? std::string("direct tetrahedral Oersted CUDA device query failed: ") +
                cudaGetErrorString(dev_status)
            : "direct tetrahedral Oersted GPU hybrid policy found no CUDA device";
        return false;
    }

    out.far_h_xyz_apm.assign(3u * target_count, 0.0);
    out.far_error_sum_apm.assign(target_count, 0.0);
    out.far_weighted_norm_sum_apm.assign(target_count, 0.0);
    out.far_max_pair_error_apm.assign(target_count, 0.0);
    out.far_pair_count.assign(target_count, 0);
    out.far_kernel_evaluations.assign(target_count, 0);
    out.cpu_pair_offsets.assign(target_count + 1u, 0);
    out.target_requires_full_cpu_fallback.assign(target_count, 0);

    if (target_count == 0 || sources.source_count == 0) {
        return true;
    }

    CudaDeviceBuffer<double> d_vx, d_vy, d_vz, d_coeff;
    CudaDeviceBuffer<double> d_cx, d_cy, d_cz, d_radius, d_abs_det;
    CudaDeviceBuffer<double> d_low_rule, d_high_rule;

    if (!d_vx.upload(sources.vertex_x.data(), sources.vertex_x.size(), "vertex_x", error) ||
            !d_vy.upload(sources.vertex_y.data(), sources.vertex_y.size(), "vertex_y", error) ||
            !d_vz.upload(sources.vertex_z.data(), sources.vertex_z.size(), "vertex_z", error) ||
            !d_coeff.upload(sources.signed_coefficients_a.data(),
                sources.signed_coefficients_a.size(), "signed_coefficients_a", error) ||
            !d_cx.upload(sources.center_x.data(), sources.center_x.size(), "center_x", error) ||
            !d_cy.upload(sources.center_y.data(), sources.center_y.size(), "center_y", error) ||
            !d_cz.upload(sources.center_z.data(), sources.center_z.size(), "center_z", error) ||
            !d_radius.upload(sources.bounding_radius.data(),
                sources.bounding_radius.size(), "bounding_radius", error) ||
            !d_abs_det.upload(sources.abs_det.data(), sources.abs_det.size(), "abs_det", error) ||
            !d_low_rule.upload(low_rule_xyzw,
                static_cast<std::size_t>(low_npts) * 4u, "low_rule", error) ||
            !d_high_rule.upload(high_rule_xyzw,
                static_cast<std::size_t>(high_npts) * 4u, "high_rule", error)) {
        return false;
    }

    const GpuSourceDeviceViews src_views{
        d_vx.get(), d_vy.get(), d_vz.get(), d_coeff.get(),
        d_cx.get(), d_cy.get(), d_cz.get(), d_radius.get(), d_abs_det.get(),
        sources.source_count};

    const std::size_t words_per_target = (sources.source_count + 31u) / 32u;
    const std::size_t mask_bytes_per_target = words_per_target * sizeof(std::uint32_t);
    const std::size_t max_batch_by_mask = std::max<std::size_t>(
        1u, kMaxCpuMaskBatchBytes / std::max<std::size_t>(1u, mask_bytes_per_target));
    const std::size_t max_batch = std::min<std::size_t>(
        target_count, std::min<std::size_t>(kMaxGridBlocksPerLaunch, max_batch_by_mask));

    CudaDeviceBuffer<double> d_targets;
    CudaDeviceBuffer<double> d_far_h_xyz, d_far_error_sum, d_far_wn_sum, d_far_max_err;
    CudaDeviceBuffer<std::uint64_t> d_far_pair_count, d_far_kernel_evals;
    CudaDeviceBuffer<std::uint32_t> d_cpu_mask;
    CudaDeviceBuffer<std::uint8_t> d_target_full_cpu;

    if (!d_targets.allocate(3u * max_batch, "targets", error) ||
            !d_far_h_xyz.allocate(3u * max_batch, "far_h_xyz", error) ||
            !d_far_error_sum.allocate(max_batch, "far_error_sum", error) ||
            !d_far_wn_sum.allocate(max_batch, "far_weighted_norm_sum", error) ||
            !d_far_max_err.allocate(max_batch, "far_max_pair_error", error) ||
            !d_far_pair_count.allocate(max_batch, "far_pair_count", error) ||
            !d_far_kernel_evals.allocate(max_batch, "far_kernel_evals", error) ||
            !d_cpu_mask.allocate(max_batch * words_per_target, "cpu_mask", error) ||
            !d_target_full_cpu.allocate(max_batch, "target_full_cpu", error)) {
        return false;
    }

    std::vector<std::uint32_t> h_cpu_mask(max_batch * words_per_target);

    for (std::size_t target_offset = 0; target_offset < target_count;
            target_offset += max_batch) {
        const std::size_t batch_count = std::min(max_batch, target_count - target_offset);

        if (!check_cuda(
                cudaMemcpy(d_targets.get(), target_xyz + 3u * target_offset,
                    3u * batch_count * sizeof(double), cudaMemcpyHostToDevice),
                "upload target batch", error)) {
            return false;
        }

        direct_tetra_root_farfield_kernel<<<
            static_cast<unsigned int>(batch_count),
            static_cast<unsigned int>(kFarFieldBlockSize)>>>(
                src_views,
                d_targets.get(),
                batch_count,
                d_low_rule.get(),
                low_npts,
                d_high_rule.get(),
                high_npts,
                near_radius_factor,
                relative_tolerance,
                absolute_tolerance_apm,
                words_per_target,
                d_far_h_xyz.get(),
                d_far_error_sum.get(),
                d_far_wn_sum.get(),
                d_far_max_err.get(),
                d_far_pair_count.get(),
                d_far_kernel_evals.get(),
                d_cpu_mask.get(),
                d_target_full_cpu.get());

        if (!check_cuda(cudaGetLastError(), "launch direct_tetra_root_farfield_kernel", error) ||
                !check_cuda(cudaDeviceSynchronize(), "synchronize direct_tetra_root_farfield_kernel", error)) {
            return false;
        }

        if (!check_cuda(
                cudaMemcpy(out.far_h_xyz_apm.data() + 3u * target_offset,
                    d_far_h_xyz.get(), 3u * batch_count * sizeof(double),
                    cudaMemcpyDeviceToHost), "download far_h_xyz", error) ||
                !check_cuda(
                    cudaMemcpy(out.far_error_sum_apm.data() + target_offset,
                        d_far_error_sum.get(), batch_count * sizeof(double),
                        cudaMemcpyDeviceToHost), "download far_error_sum", error) ||
                !check_cuda(
                    cudaMemcpy(out.far_weighted_norm_sum_apm.data() + target_offset,
                        d_far_wn_sum.get(), batch_count * sizeof(double),
                        cudaMemcpyDeviceToHost), "download far_weighted_norm_sum", error) ||
                !check_cuda(
                    cudaMemcpy(out.far_max_pair_error_apm.data() + target_offset,
                        d_far_max_err.get(), batch_count * sizeof(double),
                        cudaMemcpyDeviceToHost), "download far_max_pair_error", error) ||
                !check_cuda(
                    cudaMemcpy(out.far_pair_count.data() + target_offset,
                        d_far_pair_count.get(), batch_count * sizeof(std::uint64_t),
                        cudaMemcpyDeviceToHost), "download far_pair_count", error) ||
                !check_cuda(
                    cudaMemcpy(out.far_kernel_evaluations.data() + target_offset,
                        d_far_kernel_evals.get(), batch_count * sizeof(std::uint64_t),
                        cudaMemcpyDeviceToHost), "download far_kernel_evaluations", error) ||
                !check_cuda(
                    cudaMemcpy(out.target_requires_full_cpu_fallback.data() + target_offset,
                        d_target_full_cpu.get(), batch_count * sizeof(std::uint8_t),
                        cudaMemcpyDeviceToHost), "download target_full_cpu", error) ||
                !check_cuda(
                    cudaMemcpy(h_cpu_mask.data(),
                        d_cpu_mask.get(),
                        batch_count * words_per_target * sizeof(std::uint32_t),
                        cudaMemcpyDeviceToHost), "download cpu_mask", error)) {
            return false;
        }

        for (std::size_t local_t = 0; local_t < batch_count; ++local_t) {
            const std::size_t global_t = target_offset + local_t;
            if (out.target_requires_full_cpu_fallback[global_t] == 0) {
                const std::uint32_t *row_mask =
                    h_cpu_mask.data() + local_t * words_per_target;
                for (std::size_t word = 0; word < words_per_target; ++word) {
                    std::uint32_t bits = row_mask[word];
                    if (bits == 0u) {
                        continue;
                    }
                    const std::size_t base_s = word * 32u;
                    while (bits != 0u) {
                        const std::uint32_t lsb = bits & (~bits + 1u);
                        int bit = 0;
                        std::uint32_t shifted = lsb;
                        while ((shifted & 1u) == 0u) {
                            shifted >>= 1u;
                            ++bit;
                        }
                        const std::size_t s = base_s + static_cast<std::size_t>(bit);
                        if (s < sources.source_count) {
                            out.cpu_pair_sources.push_back(static_cast<std::uint32_t>(s));
                        }
                        bits &= (bits - 1u);
                    }
                }
            }
            out.cpu_pair_offsets[global_t + 1u] =
                static_cast<std::uint64_t>(out.cpu_pair_sources.size());
        }
    }

    return true;
}

} // namespace fullmag::fem::oersted
