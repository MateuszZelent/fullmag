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
constexpr int kMaximumIterations = 512;
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
template<int Count>
__device__ void reduce(
    cooperative_groups::grid_group grid, const double (&local)[Count],
    double *blocks, double *result)
{
    __shared__ double values[Count][kThreads];
    const int thread = threadIdx.x;
    for (int c = 0; c < Count; ++c) { values[c][thread] = local[c]; }
    __syncthreads();
    for (int width = kThreads / 2; width > 0; width /= 2) {
        if (thread < width) {
            for (int c = 0; c < Count; ++c) {
                values[c][thread] += values[c][thread + width];
            }
        }
        __syncthreads();
    }
    if (thread == 0) {
        for (int c = 0; c < Count; ++c) {
            blocks[c * gridDim.x + blockIdx.x] = values[c][0];
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

__global__ void exchange_mass_pcg(
    GpuBbPcgDevice w, FemGpuComponentField gradient,
    FemGpuComponentField solution, int n, double weight)
{
    auto grid = cooperative_groups::this_grid();
    const int rank = static_cast<int>(grid.thread_rank());
    const int stride = static_cast<int>(grid.size());
    auto &s = *w.result;
    if (rank == 0) { s = {}; }
    grid.sync();
    for (int row = rank; row < n; row += stride) {
        const double d = diagonal(w.regularized_mass, row) +
            weight * diagonal(w.stiffness, row);
        if (!isfinite(d) || d <= 0.0) { atomicExch(&s.status, 3); }
        w.inverse_diagonal[row] = 1.0 / d;
    }
    double initial[4] = {};
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n, row = index % n;
        const double b = action(w.mass, row, component(gradient, c));
        if (!isfinite(b)) { atomicExch(&s.status, 3); }
        if (b != 0.0) { atomicOr(&s.nonzero_rhs_mask, 1u << c); }
        component(w.rhs, c)[row] = b;
        component(w.residual, c)[row] = b;
        component(solution, c)[row] = 0.0;
    }
    grid.sync();
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n, row = index % n;
        const double b = component(w.rhs, c)[row];
        const double z = b * w.inverse_diagonal[row];
        component(w.search, c)[row] = z;
        initial[c] += b * b;
        initial[3] += b * z;
    }
    // Use a separate reduction buffer, never reinterpret the struct layout.
    double *reduced = w.block_sums + 4 * gridDim.x;
    reduce(grid, initial, w.block_sums, reduced);
    if (rank == 0) {
        for (int c = 0; c < 3; ++c) {
            s.rhs_norm_squared[c] = reduced[c];
            if (!isfinite(reduced[c]) || reduced[c] < 0.0 ||
                ((s.nonzero_rhs_mask & (1u << c)) != 0 &&
                 reduced[c] * kInternalRelativeTolerance * kInternalRelativeTolerance == 0.0)) {
                s.status = 3;
            }
        }
        s.rho = reduced[3];
        if (!isfinite(s.rho) || s.rho < 0.0) { s.status = 3; }
        if (s.rho == 0.0 && s.nonzero_rhs_mask != 0u) { s.status = 3; }
        if (s.rho == 0.0 && s.status == 0) { s.status = 1; }
    }
    grid.sync();

    while (s.status == 0 && s.iterations < kMaximumIterations) {
        double denominator[1] = {};
        for (int index = rank; index < 3 * n; index += stride) {
            const int c = index / n, row = index % n;
            const double *p = component(w.search, c);
            const double ap = action(w.regularized_mass, row, p) +
                weight * action(w.stiffness, row, p);
            component(w.applied, c)[row] = ap;
            denominator[0] += p[row] * ap;
        }
        reduce(grid, denominator, w.block_sums, reduced);
        if (rank == 0) {
            s.denominator = reduced[0];
            if (!isfinite(s.denominator) || s.denominator <= 0.0) { s.status = 4; }
            else {
                s.alpha = s.rho / s.denominator;
                if (!isfinite(s.alpha)) { s.status = 3; }
            }
        }
        grid.sync();
        if (s.status != 0) { break; }
        double residuals[4] = {};
        for (int index = rank; index < 3 * n; index += stride) {
            const int c = index / n, row = index % n;
            component(solution, c)[row] += s.alpha * component(w.search, c)[row];
            const double r = component(w.residual, c)[row] -
                s.alpha * component(w.applied, c)[row];
            component(w.residual, c)[row] = r;
            residuals[c] += r * r;
            residuals[3] += r * r * w.inverse_diagonal[row];
        }
        reduce(grid, residuals, w.block_sums, reduced);
        if (rank == 0) {
            ++s.iterations;
            bool converged = true;
            for (int c = 0; c < 3; ++c) {
                const double limit = kInternalRelativeTolerance * kInternalRelativeTolerance * s.rhs_norm_squared[c];
                if (!isfinite(reduced[c])) { s.status = 3; }
                converged = converged && reduced[c] <= limit;
            }
            if (converged && s.status == 0) { s.status = 1; }
            s.beta = reduced[3] / s.rho;
            s.rho = reduced[3];
            if (!isfinite(s.beta) || !isfinite(s.rho)) { s.status = 3; }
        }
        grid.sync();
        if (s.status != 0) { break; }
        for (int index = rank; index < 3 * n; index += stride) {
            const int c = index / n, row = index % n;
            component(w.search, c)[row] =
                component(w.residual, c)[row] * w.inverse_diagonal[row] +
                s.beta * component(w.search, c)[row];
        }
        grid.sync();
    }
    if (rank == 0 && s.status == 0) { s.status = 2; }
    grid.sync();
    // A fresh A*x-b action certifies the true linear residual. This is a
    // different certificate from the untouched Poisson-demag certificate.
    double certificate[3] = {};
    for (int index = rank; index < 3 * n; index += stride) {
        const int c = index / n, row = index % n;
        const double *x = component(solution, c);
        const double residual = action(w.regularized_mass, row, x) +
            weight * action(w.stiffness, row, x) - component(w.rhs, c)[row];
        certificate[c] += residual * residual;
    }
    reduce(grid, certificate, w.block_sums, reduced);
    if (rank == 0) {
        for (int c = 0; c < 3; ++c) {
            s.residual_norm_squared[c] = reduced[c];
            const double limit = kCertificateRelativeTolerance * kCertificateRelativeTolerance * s.rhs_norm_squared[c];
            if (s.status == 1 && (!isfinite(reduced[c]) || reduced[c] > limit)) {
                s.status = 5;
            }
        }
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
