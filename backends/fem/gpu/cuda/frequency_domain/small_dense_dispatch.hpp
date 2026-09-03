#pragma once

#include <cstddef>

namespace fullmag::fem::gpu::frequency_domain {

enum class SmallDenseVariant {
    Current = 0,
    CpuLapack = 1,
    MfemBatched = 2,
    Cusolver = 3
};

struct SmallDenseSolveConfig {
    SmallDenseVariant variant{SmallDenseVariant::Current};
    bool forced_gpu{false};
};

struct SmallDenseSolveResult {
    SmallDenseVariant executed_variant{SmallDenseVariant::Current};
    int status{0}; // 0 = success, -1 = fail-closed / illegal CPU fallback, >0 = numerical error
    double residual{0.0};
};

SmallDenseVariant select_small_dense_variant(int n, bool forced_gpu);

SmallDenseSolveResult small_dense_solve(
    int n,
    const double* A_real,
    const double* A_imag,
    const double* b_real,
    const double* b_imag,
    double* x_real,
    double* x_imag,
    const SmallDenseSolveConfig& config,
    void* stream = nullptr
);

void parallel_reduce_response_metrics(
    const double* d_in,
    int n,
    double* d_out_sum,
    double* d_out_max,
    void* stream = nullptr
);

} // namespace fullmag::fem::gpu::frequency_domain
