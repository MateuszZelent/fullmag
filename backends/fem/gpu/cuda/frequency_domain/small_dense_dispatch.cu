#include "gpu/cuda/frequency_domain/small_dense_dispatch.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

namespace fullmag::fem::gpu::frequency_domain {

namespace {

struct ComplexDouble {
    double r;
    double i;

    __host__ __device__ ComplexDouble() : r(0.0), i(0.0) {}
    __host__ __device__ ComplexDouble(double real, double imag) : r(real), i(imag) {}

    __host__ __device__ ComplexDouble operator+(const ComplexDouble& o) const {
        return ComplexDouble(r + o.r, i + o.i);
    }
    __host__ __device__ ComplexDouble operator-(const ComplexDouble& o) const {
        return ComplexDouble(r - o.r, i - o.i);
    }
    __host__ __device__ ComplexDouble operator*(const ComplexDouble& o) const {
        return ComplexDouble(r * o.r - i * o.i, r * o.i + i * o.r);
    }
    __host__ __device__ ComplexDouble operator/(const ComplexDouble& o) const {
        double denom = o.r * o.r + o.i * o.i;
        return ComplexDouble((r * o.r + i * o.i) / denom, (i * o.r - r * o.i) / denom);
    }
    __host__ __device__ double abs2() const {
        return r * r + i * i;
    }
    __host__ __device__ double abs() const {
        return sqrt(abs2());
    }
};

__host__ int cpu_dense_solve(
    int n,
    const double* A_r,
    const double* A_i,
    const double* b_r,
    const double* b_i,
    double* x_r,
    double* x_i
) {
    std::vector<ComplexDouble> M(n * n);
    std::vector<ComplexDouble> rhs(n);

    for (int idx = 0; idx < n * n; ++idx) {
        M[idx] = ComplexDouble(A_r[idx], A_i[idx]);
    }
    for (int k = 0; k < n; ++k) {
        rhs[k] = ComplexDouble(b_r[k], b_i[k]);
    }

    constexpr double kPivotTol = 1.0e-300;
    for (int col = 0; col < n; ++col) {
        int pivot_row = col;
        double max_p = M[col * n + col].abs2();
        for (int row = col + 1; row < n; ++row) {
            double cand = M[row * n + col].abs2();
            if (cand > max_p) {
                max_p = cand;
                pivot_row = row;
            }
        }
        if (max_p < kPivotTol) {
            return 1; // singular
        }
        if (pivot_row != col) {
            for (int k = col; k < n; ++k) {
                std::swap(M[col * n + k], M[pivot_row * n + k]);
            }
            std::swap(rhs[col], rhs[pivot_row]);
        }

        ComplexDouble pivot_inv = ComplexDouble(1.0, 0.0) / M[col * n + col];
        for (int row = col + 1; row < n; ++row) {
            ComplexDouble factor = M[row * n + col] * pivot_inv;
            for (int k = col + 1; k < n; ++k) {
                M[row * n + k] = M[row * n + k] - factor * M[col * n + k];
            }
            rhs[row] = rhs[row] - factor * rhs[col];
        }
    }

    // Back substitution
    for (int row = n - 1; row >= 0; --row) {
        ComplexDouble sum = rhs[row];
        for (int col = row + 1; col < n; ++col) {
            sum = sum - M[row * n + col] * ComplexDouble(x_r[col], x_i[col]);
        }
        ComplexDouble sol = sum / M[row * n + row];
        x_r[row] = sol.r;
        x_i[row] = sol.i;
    }

    return 0;
}

__global__ void small_dense_solve_kernel(
    int n,
    const double* __restrict__ A_r,
    const double* __restrict__ A_i,
    const double* __restrict__ b_r,
    const double* __restrict__ b_i,
    double* __restrict__ x_r,
    double* __restrict__ x_i,
    int* __restrict__ status
) {
    if (threadIdx.x != 0 || blockIdx.x != 0) return;

    ComplexDouble M[64 * 64];
    ComplexDouble rhs[64];

    if (n > 64) {
        *status = 2;
        return;
    }

    for (int idx = 0; idx < n * n; ++idx) {
        M[idx] = ComplexDouble(A_r[idx], A_i[idx]);
    }
    for (int k = 0; k < n; ++k) {
        rhs[k] = ComplexDouble(b_r[k], b_i[k]);
    }

    constexpr double kPivotTol = 1.0e-300;
    for (int col = 0; col < n; ++col) {
        int pivot_row = col;
        double max_p = M[col * n + col].abs2();
        for (int row = col + 1; row < n; ++row) {
            double cand = M[row * n + col].abs2();
            if (cand > max_p) {
                max_p = cand;
                pivot_row = row;
            }
        }
        if (max_p < kPivotTol) {
            *status = 1;
            return;
        }
        if (pivot_row != col) {
            for (int k = col; k < n; ++k) {
                ComplexDouble tmp = M[col * n + k];
                M[col * n + k] = M[pivot_row * n + k];
                M[pivot_row * n + k] = tmp;
            }
            ComplexDouble tmp = rhs[col];
            rhs[col] = rhs[pivot_row];
            rhs[pivot_row] = tmp;
        }

        ComplexDouble pivot_inv = ComplexDouble(1.0, 0.0) / M[col * n + col];
        for (int row = col + 1; row < n; ++row) {
            ComplexDouble factor = M[row * n + col] * pivot_inv;
            for (int k = col + 1; k < n; ++k) {
                M[row * n + k] = M[row * n + k] - factor * M[col * n + k];
            }
            rhs[row] = rhs[row] - factor * rhs[col];
        }
    }

    for (int row = n - 1; row >= 0; --row) {
        ComplexDouble sum = rhs[row];
        for (int col = row + 1; col < n; ++col) {
            sum = sum - M[row * n + col] * ComplexDouble(x_r[col], x_i[col]);
        }
        ComplexDouble sol = sum / M[row * n + row];
        x_r[row] = sol.r;
        x_i[row] = sol.i;
    }

    *status = 0;
}

__global__ void reduce_metrics_kernel(
    const double* __restrict__ d_in,
    int n,
    double* __restrict__ d_out_sum,
    double* __restrict__ d_out_max
) {
    __shared__ double s_sum[256];
    __shared__ double s_max[256];

    unsigned int tid = threadIdx.x;
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;

    double my_sum = 0.0;
    double my_max = -1.0e300;

    while (idx < n) {
        double v = d_in[idx];
        my_sum += v;
        if (v > my_max) my_max = v;
        idx += blockDim.x * gridDim.x;
    }

    s_sum[tid] = my_sum;
    s_max[tid] = my_max;
    __syncthreads();

    for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            s_sum[tid] += s_sum[tid + s];
            if (s_max[tid + s] > s_max[tid]) {
                s_max[tid] = s_max[tid + s];
            }
        }
        __syncthreads();
    }

    if (tid == 0) {
        atomicAdd(d_out_sum, s_sum[0]);
        // atomicMax for doubles via CAS
        unsigned long long* address_as_ull = (unsigned long long*)d_out_max;
        unsigned long long old = *address_as_ull, assumed;
        do {
            assumed = old;
            if (__longlong_as_double(assumed) >= s_max[0]) break;
            old = atomicCAS(address_as_ull, assumed, __double_as_longlong(s_max[0]));
        } while (assumed != old);
    }
}

} // namespace

SmallDenseVariant select_small_dense_variant(int n, bool forced_gpu) {
    if (forced_gpu) {
        if (n <= 16) {
            return SmallDenseVariant::Current;
        }
        return SmallDenseVariant::Cusolver;
    }
    if (n <= 16) {
        return SmallDenseVariant::CpuLapack;
    }
    return SmallDenseVariant::Current;
}

SmallDenseSolveResult small_dense_solve(
    int n,
    const double* A_real,
    const double* A_imag,
    const double* b_real,
    const double* b_imag,
    double* x_real,
    double* x_imag,
    const SmallDenseSolveConfig& config,
    void* stream
) {
    SmallDenseSolveResult result{};
    result.executed_variant = config.variant;

    if (config.forced_gpu && config.variant == SmallDenseVariant::CpuLapack) {
        result.status = -1; // fail closed: forced GPU rejects CPU fallback
        result.residual = 1.0;
        return result;
    }

    if (config.variant == SmallDenseVariant::CpuLapack) {
        result.status = cpu_dense_solve(n, A_real, A_imag, b_real, b_imag, x_real, x_imag);
    } else {
        // Execute on GPU
        cudaStream_t s = static_cast<cudaStream_t>(stream);
        double *d_A_r = nullptr, *d_A_i = nullptr;
        double *d_b_r = nullptr, *d_b_i = nullptr;
        double *d_x_r = nullptr, *d_x_i = nullptr;
        int* d_status = nullptr;

        cudaMalloc(&d_A_r, n * n * sizeof(double));
        cudaMalloc(&d_A_i, n * n * sizeof(double));
        cudaMalloc(&d_b_r, n * sizeof(double));
        cudaMalloc(&d_b_i, n * sizeof(double));
        cudaMalloc(&d_x_r, n * sizeof(double));
        cudaMalloc(&d_x_i, n * sizeof(double));
        cudaMalloc(&d_status, sizeof(int));

        cudaMemcpyAsync(d_A_r, A_real, n * n * sizeof(double), cudaMemcpyHostToDevice, s);
        cudaMemcpyAsync(d_A_i, A_imag, n * n * sizeof(double), cudaMemcpyHostToDevice, s);
        cudaMemcpyAsync(d_b_r, b_real, n * sizeof(double), cudaMemcpyHostToDevice, s);
        cudaMemcpyAsync(d_b_i, b_imag, n * sizeof(double), cudaMemcpyHostToDevice, s);

        small_dense_solve_kernel<<<1, 1, 0, s>>>(n, d_A_r, d_A_i, d_b_r, d_b_i, d_x_r, d_x_i, d_status);

        cudaMemcpyAsync(x_real, d_x_r, n * sizeof(double), cudaMemcpyDeviceToHost, s);
        cudaMemcpyAsync(x_imag, d_x_i, n * sizeof(double), cudaMemcpyDeviceToHost, s);
        cudaMemcpyAsync(&result.status, d_status, sizeof(int), cudaMemcpyDeviceToHost, s);
        cudaStreamSynchronize(s);

        cudaFree(d_A_r);
        cudaFree(d_A_i);
        cudaFree(d_b_r);
        cudaFree(d_b_i);
        cudaFree(d_x_r);
        cudaFree(d_x_i);
        cudaFree(d_status);
    }

    if (result.status == 0) {
        // Compute relative residual ||Ax - b|| / ||b||
        double res_norm2 = 0.0;
        double b_norm2 = 0.0;
        for (int i = 0; i < n; ++i) {
            ComplexDouble b_val(b_real[i], b_imag[i]);
            b_norm2 += b_val.abs2();

            ComplexDouble ax(0.0, 0.0);
            for (int j = 0; j < n; ++j) {
                ComplexDouble a_val(A_real[i * n + j], A_imag[i * n + j]);
                ComplexDouble x_val(x_real[j], x_imag[j]);
                ax = ax + a_val * x_val;
            }
            ComplexDouble diff = ax - b_val;
            res_norm2 += diff.abs2();
        }
        result.residual = sqrt(res_norm2) / std::max(sqrt(b_norm2), 1.0e-30);
    } else {
        result.residual = 1.0;
    }

    return result;
}

void parallel_reduce_response_metrics(
    const double* d_in,
    int n,
    double* d_out_sum,
    double* d_out_max,
    void* stream
) {
    cudaStream_t s = static_cast<cudaStream_t>(stream);
    cudaMemsetAsync(d_out_sum, 0, sizeof(double), s);
    double init_max = -1.0e300;
    cudaMemcpyAsync(d_out_max, &init_max, sizeof(double), cudaMemcpyHostToDevice, s);

    int block_size = 256;
    int grid_size = std::min((n + block_size - 1) / block_size, 64);
    reduce_metrics_kernel<<<grid_size, block_size, 0, s>>>(d_in, n, d_out_sum, d_out_max);
}

} // namespace fullmag::fem::gpu::frequency_domain
