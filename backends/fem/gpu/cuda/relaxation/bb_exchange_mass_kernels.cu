#include "gpu/cuda/relaxation/bb_exchange_mass_kernels.hpp"
#if FULLMAG_HAS_CUDA_RUNTIME
#include <cooperative_groups.h>
#include <cmath>
#include <algorithm>

namespace fullmag::fem {
namespace {
constexpr int kThreads = 256;
// Bound a cooperative launch rather than allowing a pathological system to
// monopolize the device for the CPU oracle's 20,000-iteration ceiling.
// A limit hit is an explicit failure, never acceptance or a CPU fallback.
constexpr int kMaximumIterations = 2048;
constexpr double kInternalRelativeTolerance = 1e-10;
constexpr double kCertificateRelativeTolerance = 1e-8;

__device__ double *component(FemGpuComponentField f, int c)
{ return c == 0 ? f.x : (c == 1 ? f.y : f.z); }

__device__ double action(GpuBbCsr a, int row, const double *x)
{
    double sum = 0.0;
    for (int j = a.rows[row]; j < a.rows[row + 1]; ++j) {
        sum += a.values[j] * x[a.columns[j]];
    }
    return sum;
}

__device__ double action_diag_scaled(
    GpuBbCsr a, int row, const double *x, const double *inv_sqrt_d)
{
    double sum = 0.0;
    for (int j = a.rows[row]; j < a.rows[row + 1]; ++j) {
        const int col = a.columns[j];
        sum += a.values[j] * (x[col] * inv_sqrt_d[col]);
    }
    return sum;
}

// Divide z[col] by sigma BEFORE multiplying by a.values[j] so sub-5 nm SI mass
// entries (~2e-20 A m^2) paired with tiny planar gradients (~1e-285 A/m) never
// underflow into IEEE-754 subnormals before scaling.
__device__ double action_div_sigma(
    GpuBbCsr a, int row, const double *z, double sigma)
{
    double sum = 0.0;
    for (int j = a.rows[row]; j < a.rows[row + 1]; ++j) {
        sum += a.values[j] * (z[a.columns[j]] / sigma);
    }
    return sum;
}

__device__ double diagonal(GpuBbCsr a, int row)
{
    double result = 0.0;
    for (int j = a.rows[row]; j < a.rows[row + 1]; ++j) {
        if (a.columns[j] == row) { result += a.values[j]; }
    }
    return result;
}

// A fixed-order second reduction avoids inter-block atomic summation order.
// Every block participates, including blocks without active nodes.
// All template instantiations share one caller-owned 12 KiB shmem[6][kThreads]
// buffer to preserve cooperative SM occupancy.
template<int Count>
__device__ void reduce_sum(
    cooperative_groups::grid_group grid, const double (&local)[Count],
    double *blocks, double *result, double (&shmem)[6][kThreads])
{
    static_assert(Count >= 1 && Count <= 6, "reduce_sum supports 1..6 slots");
    const int thread = threadIdx.x;
    for (int c = 0; c < Count; ++c) { shmem[c][thread] = local[c]; }
    __syncthreads();
    for (int width = kThreads / 2; width > 0; width /= 2) {
        if (thread < width) {
            for (int c = 0; c < Count; ++c) {
                shmem[c][thread] += shmem[c][thread + width];
            }
        }
        __syncthreads();
    }
    if (thread == 0) {
        for (int c = 0; c < Count; ++c) {
            blocks[c * gridDim.x + blockIdx.x] = shmem[c][0];
        }
    }
    grid.sync();
    if (grid.thread_rank() == 0) {
        for (int c = 0; c < Count; ++c) {
            double sum = 0.0, correction = 0.0;
            for (int b = 0; b < gridDim.x; ++b) {
                const double y = blocks[c * gridDim.x + b] - correction;
                const double next = sum + y;
                correction = (next - sum) - y;
                sum = next;
            }
            result[c] = sum;
        }
    }
    grid.sync();
}

template<int Count>
__device__ void reduce_max(
    cooperative_groups::grid_group grid, const double (&local)[Count],
    double *blocks, double *result, double (&shmem)[6][kThreads])
{
    static_assert(Count >= 1 && Count <= 6, "reduce_max supports 1..6 slots");
    const int thread = threadIdx.x;
    for (int c = 0; c < Count; ++c) { shmem[c][thread] = local[c]; }
    __syncthreads();
    for (int width = kThreads / 2; width > 0; width /= 2) {
        if (thread < width) {
            for (int c = 0; c < Count; ++c) {
                const double a = shmem[c][thread];
                const double b = shmem[c][thread + width];
                shmem[c][thread] = (isnan(a) || isnan(b)) ? (a + b) : fmax(a, b);
            }
        }
        __syncthreads();
    }
    if (thread == 0) {
        for (int c = 0; c < Count; ++c) {
            blocks[c * gridDim.x + blockIdx.x] = shmem[c][0];
        }
    }
    grid.sync();
    if (grid.thread_rank() == 0) {
        for (int c = 0; c < Count; ++c) {
            double max_value = 0.0;
            for (int b = 0; b < gridDim.x; ++b) {
                const double v = blocks[c * gridDim.x + b];
                max_value = (isnan(max_value) || isnan(v)) ? (max_value + v) : fmax(max_value, v);
            }
            result[c] = max_value;
        }
    }
    grid.sync();
}

__global__ void exchange_mass_pcg(
    GpuBbPcgDevice w, FemGpuComponentField gradient,
    FemGpuComponentField solution, int n, double weight)
{
    __shared__ double shmem[6][kThreads];
    auto grid = cooperative_groups::this_grid();
    const int rank = static_cast<int>(grid.thread_rank());
    const int stride = static_cast<int>(grid.size());
    auto &s = *w.result;
    if (rank == 0) { s = {}; }
    grid.sync();

    // Use a separate reduction buffer, never reinterpret the struct layout.
    double *reduced = w.block_sums + 6 * gridDim.x;

    // Pass 0a: symmetric diagonal scaling D^{-1/2}, RHS b_c = M_Ms * g_c,
    // sigma_c = max_i |b_{c,i}|, and collective validity check (never bypass grid.sync).
    double pass0_max[4] = {0.0, 0.0, 0.0, 0.0};
    if (!isfinite(weight) || weight < 0.0) {
        pass0_max[3] = 1.0;
    }
    for (int row = rank; row < n; row += stride) {
        const double d = diagonal(w.regularized_mass, row) +
            weight * diagonal(w.stiffness, row);
        if (!isfinite(d) || d <= 0.0) {
            pass0_max[3] = 1.0;
            w.inv_sqrt_diagonal[row] = 0.0;
        } else {
            const double inv_sqrt_d = rsqrt(d);
            if (!isfinite(inv_sqrt_d) || inv_sqrt_d <= 0.0) {
                pass0_max[3] = 1.0;
                w.inv_sqrt_diagonal[row] = 0.0;
            } else {
                w.inv_sqrt_diagonal[row] = inv_sqrt_d;
            }
        }
    }
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n, row = index % n;
        const double b = action(w.mass, row, component(gradient, c));
        if (!isfinite(b)) {
            pass0_max[3] = 1.0;
            component(w.rhs, c)[row] = 0.0;
        } else {
            component(w.rhs, c)[row] = b;
            pass0_max[c] = fmax(pass0_max[c], fabs(b));
        }
        component(solution, c)[row] = 0.0;
    }
    reduce_max<4>(grid, pass0_max, w.block_sums, reduced, shmem);
    if (rank == 0) {
        const bool pass0_invalid = !isfinite(reduced[3]) || reduced[3] != 0.0;
        for (int c = 0; c < 3; ++c) {
            const double sigma = reduced[c];
            if (pass0_invalid || !isfinite(sigma) || sigma < 0.0) {
                s.sigma[c] = 0.0;
                s.component_status[c] = 3;
            } else if (sigma == 0.0) {
                s.sigma[c] = 0.0;
                s.component_status[c] = 1;
                s.component_iterations[c] = 0;
                s.scaled_rhs_norm_squared[c] = 0.0;
                s.scaled_residual_norm_squared[c] = 0.0;
            } else {
                s.sigma[c] = sigma;
                s.component_status[c] = 0;
            }
        }
        if (pass0_invalid) { s.status = 3; }
    }
    grid.sync();

    // Pass 0b: b_tilde_c = D^{-1/2} (b_c / sigma_c) and tau_tilde_c = max_i |b_tilde_{c,i}|.
    double tau_max[4] = {0.0, 0.0, 0.0, 0.0};
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n;
        if (s.component_status[c] != 0) { continue; }
        const int row = index % n;
        const double b_over_sigma = component(w.rhs, c)[row] / s.sigma[c];
        const double b_tilde = b_over_sigma * w.inv_sqrt_diagonal[row];
        if (!isfinite(b_over_sigma) || !isfinite(b_tilde)) {
            tau_max[3] = 1.0;
            component(w.residual, c)[row] = 0.0;
        } else {
            component(w.residual, c)[row] = b_tilde;
            tau_max[c] = fmax(tau_max[c], fabs(b_tilde));
        }
    }
    reduce_max<4>(grid, tau_max, w.block_sums, reduced, shmem);
    if (rank == 0) {
        const bool tau_invalid = !isfinite(reduced[3]) || reduced[3] != 0.0;
        for (int c = 0; c < 3; ++c) {
            if (s.component_status[c] != 0) { continue; }
            const double tau = reduced[c];
            if (tau_invalid || !isfinite(tau) || tau <= 0.0) {
                s.tau_tilde[c] = 0.0;
                s.component_status[c] = 3;
            } else {
                s.tau_tilde[c] = tau;
            }
        }
    }
    grid.sync();

    // Pass 0c: r_hat_c = p_hat_c = b_tilde_c / tau_tilde_c, ensuring
    // 1 <= ||r_hat_c||_2^2 <= n and 1 <= ||b_c / sigma_c||_2^2 <= n.
    double init_sums[6] = {};
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n;
        if (s.component_status[c] != 0) { continue; }
        const int row = index % n;
        const double b_over_sigma = component(w.rhs, c)[row] / s.sigma[c];
        const double r_hat = component(w.residual, c)[row] / s.tau_tilde[c];
        component(w.residual, c)[row] = r_hat;
        component(w.search, c)[row] = r_hat;
        init_sums[c] += b_over_sigma * b_over_sigma;
        init_sums[3 + c] += r_hat * r_hat;
    }
    reduce_sum<6>(grid, init_sums, w.block_sums, reduced, shmem);
    if (rank == 0) {
        for (int c = 0; c < 3; ++c) {
            if (s.component_status[c] != 0) { continue; }
            s.scaled_rhs_norm_squared[c] = reduced[c];
            s.rho[c] = reduced[3 + c];
            if (!isfinite(s.scaled_rhs_norm_squared[c]) ||
                s.scaled_rhs_norm_squared[c] <= 0.0 ||
                !isfinite(s.rho[c]) || s.rho[c] <= 0.0) {
                s.component_status[c] = 3;
            }
        }
    }
    grid.sync();

    // Independent 3-component D^{-1/2}-scaled PCG loop.
    int iter = 0;
    while (iter < kMaximumIterations &&
           (s.component_status[0] == 0 ||
            s.component_status[1] == 0 ||
            s.component_status[2] == 0)) {
        int active_c[3];
        int active_count = 0;
        for (int c = 0; c < 3; ++c) {
            if (s.component_status[c] == 0) { active_c[active_count++] = c; }
        }
        double denom[3] = {0.0, 0.0, 0.0};
        for (int index = rank; index < active_count * n; index += stride) {
            const int c = active_c[index / n];
            const int row = index % n;
            const double *p = component(w.search, c);
            const double ap_raw =
                action_diag_scaled(w.regularized_mass, row, p, w.inv_sqrt_diagonal) +
                weight * action_diag_scaled(w.stiffness, row, p, w.inv_sqrt_diagonal);
            const double ap = w.inv_sqrt_diagonal[row] * ap_raw;
            component(w.applied, c)[row] = ap;
            denom[c] += p[row] * ap;
        }
        reduce_sum<3>(grid, denom, w.block_sums, reduced, shmem);
        if (rank == 0) {
            for (int c = 0; c < 3; ++c) {
                if (s.component_status[c] != 0) { continue; }
                s.denominator[c] = reduced[c];
                if (!isfinite(s.denominator[c]) || s.denominator[c] <= 0.0) {
                    s.component_status[c] = 4;
                } else {
                    s.alpha[c] = s.rho[c] / s.denominator[c];
                    if (!isfinite(s.alpha[c])) {
                        s.component_status[c] = 3;
                    }
                }
            }
        }
        grid.sync();

        active_count = 0;
        for (int c = 0; c < 3; ++c) {
            if (s.component_status[c] == 0) { active_c[active_count++] = c; }
        }
        if (active_count == 0) { break; }

        double step_sums[6] = {};
        for (int index = rank; index < active_count * n; index += stride) {
            const int c = active_c[index / n];
            const int row = index % n;
            const double alpha = s.alpha[c];
            component(solution, c)[row] += alpha * component(w.search, c)[row];
            const double r_hat = component(w.residual, c)[row] -
                alpha * component(w.applied, c)[row];
            component(w.residual, c)[row] = r_hat;
            if (r_hat != 0.0) {
                const double r_phys = (s.tau_tilde[c] / w.inv_sqrt_diagonal[row]) * r_hat;
                step_sums[c] += r_phys * r_phys;
            }
            step_sums[3 + c] += r_hat * r_hat;
        }
        reduce_sum<6>(grid, step_sums, w.block_sums, reduced, shmem);
        if (rank == 0) {
            int max_iter = s.iterations;
            for (int c = 0; c < 3; ++c) {
                if (s.component_status[c] != 0) { continue; }
                ++s.component_iterations[c];
                if (s.component_iterations[c] > max_iter) {
                    max_iter = s.component_iterations[c];
                }
                const double phys_res_sq = reduced[c];
                const double rho_next = reduced[3 + c];
                const double limit =
                    kInternalRelativeTolerance * kInternalRelativeTolerance *
                    s.scaled_rhs_norm_squared[c];
                if (!isfinite(phys_res_sq) || phys_res_sq < 0.0 ||
                    !isfinite(rho_next) || rho_next < 0.0) {
                    s.component_status[c] = 3;
                } else if (phys_res_sq <= limit) {
                    s.component_status[c] = 1;
                } else if (s.rho[c] <= 0.0 || rho_next <= 0.0) {
                    s.component_status[c] = 3;
                } else {
                    s.beta[c] = rho_next / s.rho[c];
                    s.rho[c] = rho_next;
                    if (!isfinite(s.beta[c]) || !isfinite(s.rho[c])) {
                        s.component_status[c] = 3;
                    }
                }
            }
            s.iterations = max_iter;
        }
        grid.sync();

        ++iter;
        active_count = 0;
        for (int c = 0; c < 3; ++c) {
            if (s.component_status[c] == 0) { active_c[active_count++] = c; }
        }
        if (active_count == 0 || iter >= kMaximumIterations) { break; }

        for (int index = rank; index < active_count * n; index += stride) {
            const int c = active_c[index / n];
            const int row = index % n;
            component(w.search, c)[row] =
                component(w.residual, c)[row] +
                s.beta[c] * component(w.search, c)[row];
        }
        grid.sync();
    }

    if (rank == 0) {
        for (int c = 0; c < 3; ++c) {
            if (s.component_status[c] == 0) { s.component_status[c] = 2; }
        }
    }
    grid.sync();

    // Recover physical z_c = sigma_c * (tau_tilde_c * inv_sqrt_d) * x_hat_c.
    double recovery_invalid[3] = {0.0, 0.0, 0.0};
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n;
        if (s.sigma[c] <= 0.0 || s.component_status[c] == 3) { continue; }
        const int row = index % n;
        const double x_hat = component(solution, c)[row];
        const double z_val =
            (s.sigma[c] * (s.tau_tilde[c] * w.inv_sqrt_diagonal[row])) * x_hat;
        if (!isfinite(z_val)) {
            recovery_invalid[c] = 1.0;
            component(solution, c)[row] = 0.0;
        } else {
            component(solution, c)[row] = z_val;
        }
    }
    reduce_max<3>(grid, recovery_invalid, w.block_sums, reduced, shmem);
    if (rank == 0) {
        for (int c = 0; c < 3; ++c) {
            if (!isfinite(reduced[c]) || reduced[c] != 0.0) {
                s.component_status[c] = 3;
            }
        }
    }
    grid.sync();

    // A fresh A*(z_c/sigma_c) - (b_c/sigma_c) action certifies the true linear
    // residual independently of the CG recurrence and without subnormal underflow.
    // This is a different certificate from the untouched Poisson-demag certificate.
    double certificate[3] = {0.0, 0.0, 0.0};
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n;
        if (s.sigma[c] <= 0.0) { continue; }
        const int row = index % n;
        const double *z = component(solution, c);
        const double sigma = s.sigma[c];
        const double residual =
            action_div_sigma(w.regularized_mass, row, z, sigma) +
            weight * action_div_sigma(w.stiffness, row, z, sigma) -
            (component(w.rhs, c)[row] / sigma);
        certificate[c] += residual * residual;
    }
    reduce_sum<3>(grid, certificate, w.block_sums, reduced, shmem);
    if (rank == 0) {
        for (int c = 0; c < 3; ++c) {
            if (s.sigma[c] <= 0.0) {
                s.scaled_residual_norm_squared[c] = 0.0;
                continue;
            }
            s.scaled_residual_norm_squared[c] = reduced[c];
            const double limit =
                kCertificateRelativeTolerance * kCertificateRelativeTolerance *
                s.scaled_rhs_norm_squared[c];
            if (s.component_status[c] == 1 &&
                (!isfinite(reduced[c]) || reduced[c] < 0.0 || reduced[c] > limit)) {
                s.component_status[c] = 5;
            }
        }
        int aggregated_status = 1;
        for (int c = 0; c < 3; ++c) {
            const int cs = s.component_status[c];
            if (cs == 3) {
                aggregated_status = 3;
                break;
            }
            if (cs == 4 && aggregated_status != 3) {
                aggregated_status = 4;
            } else if (cs == 2 && aggregated_status != 3 && aggregated_status != 4) {
                aggregated_status = 2;
            } else if (cs == 5 && aggregated_status == 1) {
                aggregated_status = 5;
            } else if (cs != 1 && aggregated_status == 1) {
                aggregated_status = 3;
            }
        }
        if (s.status == 3) { aggregated_status = 3; }
        s.status = aggregated_status;
    }
}
} // namespace

cudaError_t gpu_bb_pcg_grid_size(int n, int &blocks)
{
    blocks = 0;
    int device = 0, supported = 0, multiprocessors = 0, per_sm = 0;
    cudaError_t status = cudaGetDevice(&device);
    if (status != cudaSuccess) { return status; }
    status = cudaDeviceGetAttribute(&supported, cudaDevAttrCooperativeLaunch, device);
    if (status != cudaSuccess) { return status; }
    if (!supported) { return cudaErrorNotSupported; }
    status = cudaDeviceGetAttribute(&multiprocessors, cudaDevAttrMultiProcessorCount, device);
    if (status != cudaSuccess) { return status; }
    status = cudaOccupancyMaxActiveBlocksPerMultiprocessor(&per_sm, exchange_mass_pcg, kThreads, 0);
    if (status != cudaSuccess) { return status; }
    if (n <= 0 || per_sm <= 0) { return cudaErrorInvalidConfiguration; }
    blocks = std::min((3 * n + kThreads - 1) / kThreads, multiprocessors * per_sm);
    return cudaSuccess;
}

cudaError_t gpu_bb_pcg_launch(
    const GpuBbPcgDevice &workspace, const FemGpuComponentField &gradient,
    const FemGpuComponentField &solution, int n, int blocks, double weight,
    cudaStream_t stream)
{
    // CUDA runtime copies all argument values during the launch call.
    auto w = workspace;
    auto g = gradient;
    auto x = solution;
    void *arguments[] = {&w, &g, &x, &n, &weight};
    return cudaLaunchCooperativeKernel(
        reinterpret_cast<void *>(exchange_mass_pcg), dim3(blocks), dim3(kThreads),
        arguments, 0, stream);
}
} // namespace fullmag::fem
#endif
