#include "gpu/cuda/frequency_domain/small_dense_dispatch.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

void check(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void test_small_dense_solve_sizes()
{
    using namespace fullmag::fem::gpu::frequency_domain;

    const int test_sizes[] = {8, 16, 32, 64};

    for (int n : test_sizes) {
        std::vector<double> A_real(n * n, 0.0);
        std::vector<double> A_imag(n * n, 0.0);
        std::vector<double> b_real(n, 0.0);
        std::vector<double> b_imag(n, 0.0);
        std::vector<double> x_ref_real(n, 0.0);
        std::vector<double> x_ref_imag(n, 0.0);
        std::vector<double> x_gpu_real(n, 0.0);
        std::vector<double> x_gpu_imag(n, 0.0);

        for (int i = 0; i < n; ++i) {
            A_real[i * n + i] = 10.0 + static_cast<double>(i);
            A_imag[i * n + i] = 2.0;
            for (int j = 0; j < n; ++j) {
                if (i != j) {
                    A_real[i * n + j] = 0.1 / (1.0 + std::abs(i - j));
                    A_imag[i * n + j] = 0.05 / (1.0 + std::abs(i - j));
                }
            }
            b_real[i] = 1.0 + static_cast<double>(i % 3);
            b_imag[i] = 0.5 - static_cast<double>(i % 2);
        }

        SmallDenseSolveConfig cpu_config{SmallDenseVariant::CpuLapack, false};
        auto cpu_result = small_dense_solve(
            n,
            A_real.data(), A_imag.data(),
            b_real.data(), b_imag.data(),
            x_ref_real.data(), x_ref_imag.data(),
            cpu_config
        );
        check(cpu_result.status == 0, "CPU oracle solve must succeed");
        check(cpu_result.residual < 1.0e-10, "CPU oracle residual must be below 1e-10");

        SmallDenseSolveConfig gpu_config{SmallDenseVariant::Current, true};
        auto gpu_result = small_dense_solve(
            n,
            A_real.data(), A_imag.data(),
            b_real.data(), b_imag.data(),
            x_gpu_real.data(), x_gpu_imag.data(),
            gpu_config
        );
        check(gpu_result.status == 0, "GPU Current solve must succeed");
        check(gpu_result.residual < 1.0e-10, "GPU Current residual must be below 1e-10");

        double max_err = 0.0;
        for (int i = 0; i < n; ++i) {
            double diff_r = std::abs(x_gpu_real[i] - x_ref_real[i]);
            double diff_i = std::abs(x_gpu_imag[i] - x_ref_imag[i]);
            if (diff_r > max_err) max_err = diff_r;
            if (diff_i > max_err) max_err = diff_i;
        }
        check(max_err < 1.0e-9, "GPU solution must match CPU oracle within 1e-9");
    }
}

void test_forced_gpu_fail_closed()
{
    using namespace fullmag::fem::gpu::frequency_domain;

    const int n = 8;
    std::vector<double> A(n * n, 1.0);
    std::vector<double> b(n, 1.0);
    std::vector<double> x(n, 0.0);

    SmallDenseSolveConfig forced_gpu_cpu_lapack{SmallDenseVariant::CpuLapack, true};
    auto result = small_dense_solve(
        n,
        A.data(), A.data(),
        b.data(), b.data(),
        x.data(), x.data(),
        forced_gpu_cpu_lapack
    );
    check(result.status == -1, "Forced strict GPU must fail closed when CpuLapack requested");
}

void test_variant_selection_policy()
{
    using namespace fullmag::fem::gpu::frequency_domain;

    check(select_small_dense_variant(8, true) != SmallDenseVariant::CpuLapack,
          "select_small_dense_variant with forced_gpu must never choose CpuLapack");
    check(select_small_dense_variant(64, true) != SmallDenseVariant::CpuLapack,
          "select_small_dense_variant with forced_gpu must never choose CpuLapack");
}

void test_parallel_metrics_reduction()
{
    using namespace fullmag::fem::gpu::frequency_domain;

    const int n = 1024;
    std::vector<double> h_in(n);
    double expected_sum = 0.0;
    double expected_max = -1.0e300;

    for (int i = 0; i < n; ++i) {
        h_in[i] = std::sin(static_cast<double>(i) * 0.05) + 1.5;
        expected_sum += h_in[i];
        if (h_in[i] > expected_max) {
            expected_max = h_in[i];
        }
    }

    double *d_in = nullptr, *d_sum = nullptr, *d_max = nullptr;
    check(cudaMalloc(&d_in, n * sizeof(double)) == cudaSuccess, "cudaMalloc d_in");
    check(cudaMalloc(&d_sum, sizeof(double)) == cudaSuccess, "cudaMalloc d_sum");
    check(cudaMalloc(&d_max, sizeof(double)) == cudaSuccess, "cudaMalloc d_max");

    check(cudaMemcpy(d_in, h_in.data(), n * sizeof(double), cudaMemcpyHostToDevice) == cudaSuccess,
          "cudaMemcpy h_in to d_in");

    parallel_reduce_response_metrics(d_in, n, d_sum, d_max, nullptr);
    check(cudaDeviceSynchronize() == cudaSuccess, "cudaDeviceSynchronize after reduction");

    double h_sum = 0.0, h_max = 0.0;
    check(cudaMemcpy(&h_sum, d_sum, sizeof(double), cudaMemcpyDeviceToHost) == cudaSuccess,
          "cudaMemcpy d_sum");
    check(cudaMemcpy(&h_max, d_max, sizeof(double), cudaMemcpyDeviceToHost) == cudaSuccess,
          "cudaMemcpy d_max");

    cudaFree(d_in);
    cudaFree(d_sum);
    cudaFree(d_max);

    check(std::abs(h_sum - expected_sum) / expected_sum < 1.0e-12,
          "Parallel sum reduction must match CPU reference");
    check(std::abs(h_max - expected_max) < 1.0e-12,
          "Parallel max reduction must match CPU reference");
}

} // namespace

int main()
{
    test_small_dense_solve_sizes();
    test_forced_gpu_fail_closed();
    test_variant_selection_policy();
    test_parallel_metrics_reduction();

    std::printf("gpu_small_dense_contract: all tests passed\n");
    return 0;
}
