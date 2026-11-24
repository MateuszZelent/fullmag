#include "cudss_solver.hpp"

#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <new>
#include <string>

#if defined(FULLMAG_FDM_CUDSS_ENABLED) && FULLMAG_FDM_CUDSS_ENABLED
#define FULLMAG_FDM_CHARGE_CUDSS_ACTIVE 1
#include <cudss.h>
#else
#define FULLMAG_FDM_CHARGE_CUDSS_ACTIVE 0
#endif

namespace fullmag::fdm::gpu::transport::charge {

namespace {

#if !FULLMAG_FDM_CHARGE_CUDSS_ACTIVE
constexpr const char *kCudssUnavailable =
    "FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss requires an FDM GPU build with cuDSS";
#endif
constexpr uint64_t kMinimumBudgetMarginBytes = UINT64_C(512) * 1024 * 1024;

std::string format_bytes(uint64_t bytes) {
    char text[96];
    std::snprintf(text, sizeof(text), "%.2f GiB (%llu bytes)",
                  static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0),
                  static_cast<unsigned long long>(bytes));
    return text;
}

#if FULLMAG_FDM_CHARGE_CUDSS_ACTIVE
bool cuda_step(cudaError_t status, const char *what, std::string &error) {
    if (status == cudaSuccess) return true;
    error = std::string("cuDSS charge solver ") + what + " failed: " +
            cudaGetErrorString(status);
    return false;
}

bool cudss_step(cudssStatus_t status, const char *what, std::string &error) {
    if (status == CUDSS_STATUS_SUCCESS) return true;
    error = std::string("cuDSS charge solver ") + what +
            " failed with cuDSS status " + std::to_string(static_cast<int>(status));
    return false;
}

double milliseconds_since(std::chrono::steady_clock::time_point start) {
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now() - start)
        .count();
}
#endif

} // namespace

bool charge_cudss_direct_requested() noexcept {
    const char *raw = std::getenv(kChargeCudssEnv);
    if (raw == nullptr) return false;
    try {
        std::string value;
        for (const char *c = raw; *c != '\0'; ++c) {
            if (!std::isspace(static_cast<unsigned char>(*c))) {
                value.push_back(
                    static_cast<char>(std::tolower(static_cast<unsigned char>(*c))));
            }
        }
        return value == "cudss";
    } catch (...) {
        return false;
    }
}

bool charge_cudss_compiled() noexcept {
    return FULLMAG_FDM_CHARGE_CUDSS_ACTIVE != 0;
}

bool resolve_charge_cudss_device_budget(
    uint64_t free_bytes,
    uint64_t total_bytes,
    const char *cap_value,
    uint64_t allocator_remaining_bytes,
    CudssDeviceBudget &budget,
    std::string &error) {
    budget = CudssDeviceBudget{};
    budget.free_bytes = free_bytes;
    budget.total_bytes = total_bytes;
    budget.margin_bytes = std::max(kMinimumBudgetMarginBytes, total_bytes / 20);
    budget.budget_bytes =
        free_bytes > budget.margin_bytes ? free_bytes - budget.margin_bytes : 0;
    if (allocator_remaining_bytes != 0) {
        budget.allocator_cap_bytes = allocator_remaining_bytes;
        budget.budget_bytes = std::min(budget.budget_bytes, allocator_remaining_bytes);
    }
    std::string cap;
    if (cap_value != nullptr) {
        for (const char *c = cap_value; *c != '\0'; ++c) {
            if (!std::isspace(static_cast<unsigned char>(*c))) {
                cap.push_back(*c);
            }
        }
    }
    if (cap.empty()) return true;
    const bool digits_only = std::all_of(cap.begin(), cap.end(), [](char c) {
        return std::isdigit(static_cast<unsigned char>(c)) != 0;
    });
    errno = 0;
    const unsigned long long parsed =
        digits_only ? std::strtoull(cap.c_str(), nullptr, 10) : 0;
    if (!digits_only || errno == ERANGE || parsed == 0) {
        error = std::string(kChargeCudssDeviceBudgetCapEnv) +
                " must be a positive integer number of bytes, got '" + cap_value + "'";
        return false;
    }
    budget.cap_bytes = static_cast<uint64_t>(parsed);
    budget.budget_bytes = std::min(budget.budget_bytes, budget.cap_bytes);
    return true;
}

bool check_charge_cudss_factor_fits(
    int64_t estimated_device_peak_bytes,
    const CudssDeviceBudget &budget,
    int64_t rows,
    int64_t estimated_factor_nnz,
    std::string &error) {
    if (estimated_device_peak_bytes <= 0) {
        error = "cuDSS charge memory preflight got no device peak estimate "
                "(CUDSS_DATA_MEMORY_ESTIMATES[1] = " +
                std::to_string(estimated_device_peak_bytes) +
                "); the factorization was not started";
        return false;
    }
    if (static_cast<uint64_t>(estimated_device_peak_bytes) <= budget.budget_bytes) {
        return true;
    }
    error = "cuDSS charge factorization needs an estimated device peak of " +
            format_bytes(static_cast<uint64_t>(estimated_device_peak_bytes)) +
            ", above the device budget of " + format_bytes(budget.budget_bytes) +
            " (free device memory after analysis " + format_bytes(budget.free_bytes) +
            " minus a margin of " + format_bytes(budget.margin_bytes);
    if (budget.allocator_cap_bytes != 0) {
        error += ", allocator remaining cap " + format_bytes(budget.allocator_cap_bytes);
    }
    if (budget.cap_bytes != 0) {
        error += ", capped by " + std::string(kChargeCudssDeviceBudgetCapEnv) + "=" +
                 std::to_string(budget.cap_bytes);
    }
    error += "); rows=" + std::to_string(rows) + ", estimated factor nonzeros=" +
             (estimated_factor_nnz >= 0 ? std::to_string(estimated_factor_nnz)
                                        : std::string("unavailable")) +
             ". The factorization was not started. Unset " +
             std::string(kChargeCudssEnv) + " to use the default PCG/AMG solve.";
    return false;
}

#if FULLMAG_FDM_CHARGE_CUDSS_ACTIVE

struct CudssDirectSolver {
    cudssHandle_t handle = nullptr;
    cudssConfig_t config = nullptr;
    cudssData_t data = nullptr;
    cudssMatrix_t matrix = nullptr;
    cudssMatrix_t rhs = nullptr;
    cudssMatrix_t solution = nullptr;
    int32_t *d_offsets = nullptr;
    int32_t *d_columns = nullptr;
    double *d_values = nullptr;
    double *d_placeholder = nullptr;
    int64_t rows = 0;
    uint64_t owned_bytes = 0;
    bool owns_csr = false;

    CudssDirectSolver() = default;
    CudssDirectSolver(const CudssDirectSolver &) = delete;
    CudssDirectSolver &operator=(const CudssDirectSolver &) = delete;

    ~CudssDirectSolver() {
        if (data != nullptr && handle != nullptr) {
            (void)cudssDataDestroy(handle, data);
        }
        for (cudssMatrix_t descriptor : {matrix, rhs, solution}) {
            if (descriptor != nullptr) {
                (void)cudssMatrixDestroy(descriptor);
            }
        }
        if (config != nullptr) {
            (void)cudssConfigDestroy(config);
        }
        if (handle != nullptr) {
            (void)cudssDestroy(handle);
        }
        if (d_placeholder != nullptr) (void)cudaFree(d_placeholder);
        if (owns_csr) {
            if (d_offsets != nullptr) (void)cudaFree(d_offsets);
            if (d_columns != nullptr) (void)cudaFree(d_columns);
            if (d_values != nullptr) (void)cudaFree(d_values);
        }
    }
};

#else

struct CudssDirectSolver {
    uint64_t owned_bytes = 0;
};

#endif

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
    std::string &error) noexcept {
    try {
        if (out_solver == nullptr || out_stats == nullptr) {
            error = "cuDSS charge solver output arguments must be non-null";
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        *out_solver = nullptr;
        *out_stats = CudssDirectStats{};
#if FULLMAG_FDM_CHARGE_CUDSS_ACTIVE
        if (rows <= 0 || lower_nnz <= 0 || rows > INT32_MAX || lower_nnz > INT32_MAX ||
            d_offsets == nullptr || d_columns == nullptr || d_values == nullptr) {
            error = "cuDSS charge solver requires a non-empty 32-bit device CSR matrix";
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        out_stats->rows = rows;
        out_stats->lower_nnz = lower_nnz;

        size_t free_before = 0;
        size_t total = 0;
        if (!cuda_step(cudaStreamSynchronize(stream), "pre-setup synchronize", error) ||
            !cuda_step(cudaMemGetInfo(&free_before, &total), "memory query", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }

        std::unique_ptr<CudssDirectSolver> owned(new CudssDirectSolver());
        owned->rows = rows;
        owned->d_offsets = d_offsets;
        owned->d_columns = d_columns;
        owned->d_values = d_values;
        owned->owns_csr = false; // Transferred only on success.

        const uint64_t placeholder_bytes =
            static_cast<uint64_t>(2) * static_cast<uint64_t>(rows) * sizeof(double);
        if (cudaMalloc(reinterpret_cast<void **>(&owned->d_placeholder),
                       static_cast<size_t>(placeholder_bytes)) != cudaSuccess) {
            error = "cuDSS charge solver placeholder device allocation failed";
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
        }
        if (!cuda_step(cudaMemsetAsync(owned->d_placeholder, 0,
                                       static_cast<size_t>(placeholder_bytes), stream),
                       "placeholder clear", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }

        if (!cudss_step(cudssCreate(&owned->handle), "handle creation", error) ||
            !cudss_step(cudssSetStream(owned->handle, stream), "stream binding", error) ||
            !cudss_step(cudssConfigCreate(&owned->config), "config creation", error) ||
            !cudss_step(cudssDataCreate(owned->handle, &owned->data), "data creation", error) ||
            !cudss_step(cudssMatrixCreateCsr(
                            &owned->matrix, rows, rows, lower_nnz,
                            owned->d_offsets, nullptr, owned->d_columns, owned->d_values,
                            CUDSS_R_32I, CUDSS_R_32I, CUDSS_R_64F,
                            CUDSS_MTYPE_SPD, CUDSS_MVIEW_LOWER, CUDSS_BASE_ZERO),
                        "matrix descriptor", error) ||
            !cudss_step(cudssMatrixCreateDn(
                            &owned->rhs, rows, 1, rows, owned->d_placeholder,
                            CUDSS_R_64F, CUDSS_LAYOUT_COL_MAJOR),
                        "right-hand side descriptor", error) ||
            !cudss_step(cudssMatrixCreateDn(
                            &owned->solution, rows, 1, rows, owned->d_placeholder + rows,
                            CUDSS_R_64F, CUDSS_LAYOUT_COL_MAJOR),
                        "solution descriptor", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }

        auto phase_start = std::chrono::steady_clock::now();
        if (!cudss_step(cudssExecute(owned->handle, CUDSS_PHASE_ANALYSIS,
                                     owned->config, owned->data,
                                     owned->matrix, owned->solution, owned->rhs),
                        "analysis", error) ||
            !cuda_step(cudaStreamSynchronize(stream), "analysis synchronize", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        out_stats->analysis_ms = milliseconds_since(phase_start);

        size_t written = 0;
        int64_t memory_estimates[16] = {0};
        if (!cudss_step(cudssDataGet(owned->handle, owned->data,
                                     CUDSS_DATA_MEMORY_ESTIMATES,
                                     memory_estimates, sizeof(memory_estimates), &written),
                        "memory estimate query", error)) {
            error += "; the factorization was not started";
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        out_stats->estimated_device_stable_bytes = memory_estimates[0];
        out_stats->estimated_device_peak_bytes = memory_estimates[1];

        int64_t estimated_factor_nnz = -1;
        if (cudssDataGet(owned->handle, owned->data, CUDSS_DATA_LU_NNZ,
                         &estimated_factor_nnz, sizeof(estimated_factor_nnz),
                         &written) != CUDSS_STATUS_SUCCESS) {
            estimated_factor_nnz = -1;
        }

        size_t free_after_analysis = 0;
        if (!cuda_step(cudaMemGetInfo(&free_after_analysis, &total),
                       "post-analysis memory query", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        if (!resolve_charge_cudss_device_budget(
                static_cast<uint64_t>(free_after_analysis),
                static_cast<uint64_t>(total),
                std::getenv(kChargeCudssDeviceBudgetCapEnv),
                allocator_remaining_bytes,
                out_stats->budget,
                error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        if (!check_charge_cudss_factor_fits(
                out_stats->estimated_device_peak_bytes,
                out_stats->budget,
                rows,
                estimated_factor_nnz,
                error)) {
            char analysis_time[64];
            std::snprintf(analysis_time, sizeof(analysis_time), " Analysis took %.3f ms.",
                          out_stats->analysis_ms);
            error += analysis_time;
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
        }

        out_stats->factorization_started = true;
        phase_start = std::chrono::steady_clock::now();
        if (!cudss_step(cudssExecute(owned->handle, CUDSS_PHASE_FACTORIZATION,
                                     owned->config, owned->data,
                                     owned->matrix, owned->solution, owned->rhs),
                        "factorization", error) ||
            !cuda_step(cudaStreamSynchronize(stream), "factorization synchronize", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        out_stats->factorization_ms = milliseconds_since(phase_start);

        int info = -1;
        if (!cudss_step(cudssDataGet(owned->handle, owned->data, CUDSS_DATA_INFO,
                                     &info, sizeof(info), &written),
                        "factorization status query", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        if (info != 0) {
            error = "cuDSS charge factorization reported info=" + std::to_string(info) +
                    ": the charge matrix is not symmetric positive definite";
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_NONCONVERGED;
        }

        int64_t factor_nnz = -1;
        if (cudssDataGet(owned->handle, owned->data, CUDSS_DATA_LU_NNZ,
                         &factor_nnz, sizeof(factor_nnz), &written) != CUDSS_STATUS_SUCCESS) {
            factor_nnz = -1;
        }
        size_t free_after = 0;
        if (!cuda_step(cudaMemGetInfo(&free_after, &total),
                       "post-factorization memory query", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }

        const uint64_t csr_bytes =
            (static_cast<uint64_t>(rows) + 1) * sizeof(int32_t) +
            static_cast<uint64_t>(lower_nnz) * (sizeof(int32_t) + sizeof(double));
        const uint64_t measured_delta =
            free_before > free_after ? static_cast<uint64_t>(free_before - free_after) : 0;
        out_stats->factor_nnz = factor_nnz;
        out_stats->device_bytes = csr_bytes + std::max(measured_delta, placeholder_bytes);
        owned->owned_bytes = out_stats->device_bytes;
        owned->owns_csr = true;
        *out_solver = owned.release();
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
#else
        (void)rows;
        (void)lower_nnz;
        (void)d_offsets;
        (void)d_columns;
        (void)d_values;
        (void)stream;
        (void)allocator_remaining_bytes;
        error = kCudssUnavailable;
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
#endif
    } catch (const std::bad_alloc &) {
        error = "cuDSS charge solver host allocation failed";
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    } catch (...) {
        error = "cuDSS charge solver encountered an unexpected error";
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
}

uint32_t solve_charge_cudss_direct(
    CudssDirectSolver *solver,
    cudaStream_t stream,
    const double *d_rhs,
    double *d_solution,
    std::string &error) noexcept {
    try {
        if (solver == nullptr || d_rhs == nullptr || d_solution == nullptr) {
            error = "cuDSS charge solve requires valid solver and device buffers";
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
        }
#if FULLMAG_FDM_CHARGE_CUDSS_ACTIVE
        if (!cudss_step(cudssSetStream(solver->handle, stream), "stream binding", error) ||
            !cudss_step(cudssMatrixSetValues(solver->rhs, const_cast<double *>(d_rhs)),
                        "right-hand side binding", error) ||
            !cudss_step(cudssMatrixSetValues(solver->solution, d_solution),
                        "solution binding", error) ||
            !cudss_step(cudssExecute(solver->handle, CUDSS_PHASE_SOLVE,
                                     solver->config, solver->data,
                                     solver->matrix, solver->solution, solver->rhs),
                        "solve", error)) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
#else
        (void)stream;
        error = kCudssUnavailable;
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
#endif
    } catch (...) {
        error = "cuDSS charge solve encountered an unexpected error";
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
}

void destroy_charge_cudss_direct_solver(CudssDirectSolver *solver) noexcept {
    delete solver;
}

uint64_t charge_cudss_owned_bytes(const CudssDirectSolver *solver) noexcept {
    return solver != nullptr ? solver->owned_bytes : 0;
}

} // namespace fullmag::fdm::gpu::transport::charge
