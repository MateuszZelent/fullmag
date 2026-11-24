/*
 * Memory preflight of the opt-in cuDSS Poisson demag solve
 * (docs/physics/0997, eq-direct-memory-budget).
 *
 * The budget arithmetic runs everywhere. With a cuDSS build the contract also
 * factors a small SPD matrix within the budget, checks one solve, and shows that
 * a 1-byte budget cap rejects the same matrix after analysis, before the
 * factorization starts.
 */

#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#if FULLMAG_FEM_CUDSS_POISSON_ENABLED
#include <cuda_runtime.h>
#include <mfem.hpp>
#endif

namespace {

using namespace fullmag::fem;

constexpr uint64_t kMiB = UINT64_C(1024) * 1024;
constexpr uint64_t kGiB = kMiB * 1024;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool contains(const std::string &text, const char *needle)
{
    return text.find(needle) != std::string::npos;
}

void budget_keeps_the_larger_margin_and_only_lowers_with_a_cap()
{
    GpuDemagCudssDeviceBudget budget;
    std::string error;
    // 8 GiB device: 5 % is 409.6 MiB, so the 512 MiB floor applies.
    check(resolve_demag_cudss_device_budget(6 * kGiB, 8 * kGiB, nullptr, budget, error),
          "uncapped budget must resolve");
    check(budget.margin_bytes == 512 * kMiB, "8 GiB device must keep the 512 MiB margin");
    check(budget.budget_bytes == 6 * kGiB - 512 * kMiB, "budget must be free minus margin");
    check(budget.cap_bytes == 0, "no cap must be recorded without the variable");

    // 80 GiB device: 5 % (4 GiB) exceeds the floor.
    check(resolve_demag_cudss_device_budget(70 * kGiB, 80 * kGiB, nullptr, budget, error),
          "large-device budget must resolve");
    check(budget.margin_bytes == 4 * kGiB, "large device must keep 5 % of its memory");
    check(budget.budget_bytes == 66 * kGiB, "large-device budget mismatch");

    check(resolve_demag_cudss_device_budget(256 * kMiB, 8 * kGiB, nullptr, budget, error),
          "free memory below the margin must still resolve");
    check(budget.budget_bytes == 0, "free memory below the margin must leave no budget");

    check(resolve_demag_cudss_device_budget(6 * kGiB, 8 * kGiB, " 4096 ", budget, error),
          "a positive cap must resolve");
    check(budget.cap_bytes == 4096 && budget.budget_bytes == 4096, "cap must lower the budget");
    check(resolve_demag_cudss_device_budget(6 * kGiB, 8 * kGiB, "999999999999999", budget, error),
          "a cap above the budget must resolve");
    check(budget.budget_bytes == 6 * kGiB - 512 * kMiB, "a cap must never raise the budget");
    check(resolve_demag_cudss_device_budget(6 * kGiB, 8 * kGiB, "", budget, error) &&
              budget.cap_bytes == 0,
          "an empty cap variable must count as unset");

    for (const char *invalid : {"0", "-1", "1e9", "12 MiB", "99999999999999999999999"}) {
        error.clear();
        check(!resolve_demag_cudss_device_budget(6 * kGiB, 8 * kGiB, invalid, budget, error),
              "a malformed cap must fail closed");
        check(contains(error, kDemagCudssDeviceBudgetCapEnv),
              "a malformed cap error must name the variable");
    }
}

void factor_fit_check_names_the_estimate_and_the_budget()
{
    GpuDemagCudssDeviceBudget budget;
    std::string error;
    check(resolve_demag_cudss_device_budget(6 * kGiB, 8 * kGiB, nullptr, budget, error),
          "budget must resolve");
    check(check_demag_cudss_factor_fits(static_cast<int64_t>(budget.budget_bytes), budget,
                                        100, 1000, error),
          "a peak equal to the budget must fit");
    error.clear();
    check(!check_demag_cudss_factor_fits(static_cast<int64_t>(budget.budget_bytes) + 1, budget,
                                         4082076, INT64_C(7430000000), error),
          "a peak above the budget must be rejected");
    check(contains(error, "estimated device peak of") && contains(error, "device budget of") &&
              contains(error, "rows=4082076") &&
              contains(error, "estimated factor nonzeros=7430000000") &&
              contains(error, "factorization was not started"),
          "the rejection must name the estimate, the budget, the size and the outcome");
    error.clear();
    check(!check_demag_cudss_factor_fits(0, budget, 100, -1, error) &&
              contains(error, "no device peak estimate"),
          "a missing estimate must fail closed");
}

#if FULLMAG_FEM_CUDSS_POISSON_ENABLED

// Tridiagonal 1D Dirichlet Laplacian: symmetric positive definite.
std::unique_ptr<mfem::SparseMatrix> laplacian(int n)
{
    auto matrix = std::make_unique<mfem::SparseMatrix>(n, n);
    for (int i = 0; i < n; ++i) {
        matrix->Add(i, i, 2.0);
        if (i > 0) {
            matrix->Add(i, i - 1, -1.0);
        }
        if (i + 1 < n) {
            matrix->Add(i, i + 1, -1.0);
        }
    }
    matrix->Finalize();
    return matrix;
}

void in_budget_factor_solves_and_capped_budget_rejects_after_analysis()
{
    constexpr int n = 200;
    const auto matrix = laplacian(n);
    check(unsetenv(kDemagCudssDeviceBudgetCapEnv) == 0, "cap variable must be clearable");

    std::shared_ptr<GpuDemagCudssDirectSolver> solver;
    GpuDemagCudssDirectStats stats;
    std::string error;
    check(create_demag_cudss_direct_solver(*matrix, solver, stats, error),
          ("in-budget factorization must succeed: " + error).c_str());
    check(solver != nullptr, "in-budget factorization must return a solver");
    check(stats.estimated_device_peak_bytes > 0, "cuDSS must report a device peak estimate");
    check(static_cast<uint64_t>(stats.estimated_device_peak_bytes) <= stats.budget.budget_bytes,
          "in-budget factor must fit its budget");
    check(stats.factorization_started && stats.factorization_ms > 0.0,
          "in-budget factorization must run");
    check(stats.rows == n, "stats must record the rows");

    // x_true = 1..n, b = K x_true; the solve must reproduce x_true.
    std::vector<double> x_true(n);
    for (int i = 0; i < n; ++i) {
        x_true[static_cast<size_t>(i)] = 1.0 + i;
    }
    std::vector<double> b(n, 0.0);
    {
        mfem::Vector x_vector(x_true.data(), n);
        mfem::Vector b_vector(b.data(), n);
        matrix->Mult(x_vector, b_vector);
    }
    double *d_b = nullptr;
    double *d_x = nullptr;
    check(cudaMalloc(reinterpret_cast<void **>(&d_b), n * sizeof(double)) == cudaSuccess &&
              cudaMalloc(reinterpret_cast<void **>(&d_x), n * sizeof(double)) == cudaSuccess,
          "device vectors must allocate");
    check(cudaMemcpy(d_b, b.data(), n * sizeof(double), cudaMemcpyHostToDevice) == cudaSuccess,
          "right-hand side must upload");
    check(solve_demag_cudss_direct(*solver, nullptr, d_b, d_x, error),
          ("direct solve must succeed: " + error).c_str());
    std::vector<double> x(n, 0.0);
    check(cudaDeviceSynchronize() == cudaSuccess &&
              cudaMemcpy(x.data(), d_x, n * sizeof(double), cudaMemcpyDeviceToHost) ==
                  cudaSuccess,
          "solution must download");
    cudaFree(d_b);
    cudaFree(d_x);
    double max_error = 0.0;
    for (int i = 0; i < n; ++i) {
        max_error = std::fmax(max_error, std::fabs(x[static_cast<size_t>(i)] -
                                                   x_true[static_cast<size_t>(i)]));
    }
    check(max_error < 1.0e-9, "direct solve must reproduce the exact solution");
    std::printf("in-budget factor: rows=%lld peak_estimate=%lld budget=%llu max_error=%.3e\n",
                static_cast<long long>(stats.rows),
                static_cast<long long>(stats.estimated_device_peak_bytes),
                static_cast<unsigned long long>(stats.budget.budget_bytes), max_error);
    solver.reset();

    check(setenv(kDemagCudssDeviceBudgetCapEnv, "1", 1) == 0, "cap variable must be settable");
    GpuDemagCudssDirectStats rejected;
    error.clear();
    check(!create_demag_cudss_direct_solver(*matrix, solver, rejected, error),
          "a factor above the capped budget must be rejected");
    check(solver == nullptr, "a rejected factor must not return a solver");
    check(rejected.analysis_ms > 0.0, "the rejection must come after the analysis");
    check(!rejected.factorization_started && rejected.factorization_ms == 0.0,
          "the rejection must come before the factorization");
    check(rejected.budget.cap_bytes == 1 && rejected.budget.budget_bytes == 1,
          "the cap must set a 1-byte budget");
    check(contains(error, "estimated device peak of") && contains(error, "device budget of") &&
              contains(error, "capped by") && contains(error, "factorization was not started"),
          "the over-budget error must name the estimate, the budget and the cap");
    std::printf("over-budget request: %s\n", error.c_str());
    check(unsetenv(kDemagCudssDeviceBudgetCapEnv) == 0, "cap variable must be clearable");
}

#endif

} // namespace

int main()
{
    budget_keeps_the_larger_margin_and_only_lowers_with_a_cap();
    factor_fit_check_names_the_estimate_and_the_budget();
#if FULLMAG_FEM_CUDSS_POISSON_ENABLED
    in_budget_factor_solves_and_capped_budget_rejects_after_analysis();
#else
    std::printf("SKIP: cuDSS factorization part needs a FEM GPU build with cuDSS\n");
#endif
    std::printf("FEM cuDSS Poisson budget contract PASS\n");
    return 0;
}
