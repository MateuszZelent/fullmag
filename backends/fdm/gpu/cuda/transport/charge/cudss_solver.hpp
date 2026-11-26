#pragma once

/*
 * Opt-in factor-once cuDSS direct Cholesky realization for the FDM GPU M1
 * charge transport linear system (-div(sigma grad V) = s).
 *
 * Disabled by default; enabled only when
 * FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss is set and the target was built
 * with FULLMAG_FDM_CUDSS_ENABLED=1. Device-memory preflight mirrors PR #550's
 * CUDSS_DATA_MEMORY_ESTIMATES budget gate before factorization starts.
 */

#include <cuda_runtime_api.h>

#include <cstdint>
#include <string>

namespace fullmag::fdm::gpu::transport::charge {

struct CudssDeviceBudget {
    uint64_t free_bytes = 0;
    uint64_t total_bytes = 0;
    uint64_t margin_bytes = 0;
    uint64_t cap_bytes = 0;
    uint64_t allocator_cap_bytes = 0;
    uint64_t budget_bytes = 0;
};

struct CudssDirectStats {
    int64_t rows = 0;
    int64_t lower_nnz = 0;
    int64_t factor_nnz = 0;
    int64_t estimated_device_stable_bytes = 0;
    int64_t estimated_device_peak_bytes = 0;
    uint64_t device_bytes = 0;
    double analysis_ms = 0.0;
    double factorization_ms = 0.0;
    CudssDeviceBudget budget{};
    bool factorization_started = false;
};

struct CudssDirectSolver;

inline constexpr const char *kChargeCudssEnv =
    "FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER";
inline constexpr const char *kChargeCudssDeviceBudgetCapEnv =
    "FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES";

// True when FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss (trimmed, ASCII lowercase).
bool charge_cudss_direct_requested() noexcept;

// True when compiled with FULLMAG_FDM_CUDSS_ENABLED=1.
bool charge_cudss_compiled() noexcept;

// Evaluates the cuDSS factorization device-memory budget:
//   margin = max(512 MiB, total / 20)
//   budget = min(max(free - margin, 0), env_cap, allocator_remaining_bytes)
bool resolve_charge_cudss_device_budget(
    uint64_t free_bytes,
    uint64_t total_bytes,
    const char *cap_value,
    uint64_t allocator_remaining_bytes,
    CudssDeviceBudget &budget,
    std::string &error);

// Fails closed when estimated_device_peak_bytes <= 0 or exceeds budget.budget_bytes.
bool check_charge_cudss_factor_fits(
    int64_t estimated_device_peak_bytes,
    const CudssDeviceBudget &budget,
    int64_t rows,
    int64_t estimated_factor_nnz,
    std::string &error);

// Analyzes, memory-preflights, and Cholesky-factors a device-resident
// lower-triangle SPD CSR matrix. On FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
// ownership of d_offsets/d_columns/d_values transfers to *out_solver; on any
// failure, the caller retains ownership of those three pointers.
uint32_t create_charge_cudss_direct_solver(
    int64_t rows,
    int64_t lower_nnz,
    int32_t *d_offsets,
    int32_t *d_columns,
    double *d_values,
    cudaStream_t stream,
    uint64_t allocator_remaining_bytes,
    CudssDirectSolver **out_solver,
    CudssDirectStats *out_stats,
    std::string &error) noexcept;

// Enqueues CUDSS_PHASE_SOLVE on `stream` with device-resident rhs & solution.
uint32_t solve_charge_cudss_direct(
    CudssDirectSolver *solver,
    cudaStream_t stream,
    const double *d_rhs,
    double *d_solution,
    std::string &error) noexcept;

// Destroys cuDSS handles and all owned device arrays (safe on nullptr).
void destroy_charge_cudss_direct_solver(CudssDirectSolver *solver) noexcept;

// Returns tracked device bytes owned by the solver (CSR + placeholder + factor).
uint64_t charge_cudss_owned_bytes(const CudssDirectSolver *solver) noexcept;

} // namespace fullmag::fdm::gpu::transport::charge
