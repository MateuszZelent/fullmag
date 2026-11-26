#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#if FULLMAG_FEM_CUDSS_POISSON_ENABLED && FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
#define FULLMAG_DEMAG_CUDSS_ACTIVE 1
#include <cuda_runtime.h>
#include <cudss.h>
#include <mfem.hpp>
#else
#define FULLMAG_DEMAG_CUDSS_ACTIVE 0
#endif

namespace fullmag::fem {

namespace {

constexpr const char *kCudssUnavailable =
    "cuDSS GPU demag direct solve requires a FEM GPU build with cuDSS";
constexpr uint64_t kBytesPerMiB = UINT64_C(1024) * 1024;
constexpr uint64_t kMinimumBudgetMarginBytes = UINT64_C(512) * kBytesPerMiB;

std::string trim_ascii(const char *raw)
{
    if (raw == nullptr) {
        return {};
    }
    const char *begin = raw;
    while (*begin != '\0' && std::isspace(static_cast<unsigned char>(*begin)) != 0) {
        ++begin;
    }
    const char *end = begin;
    while (*end != '\0') {
        ++end;
    }
    while (end > begin && std::isspace(static_cast<unsigned char>(*(end - 1))) != 0) {
        --end;
    }
    return std::string(begin, end);
}

std::string to_lower_ascii(std::string value)
{
    for (char &c : value) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return value;
}

std::string format_bytes(uint64_t bytes)
{
    char text[96];
    std::snprintf(text, sizeof(text), "%.2f GiB (%llu bytes)",
                  static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0),
                  static_cast<unsigned long long>(bytes));
    return text;
}

bool parse_positive_uint64_env(
    const char *env_name,
    const char *raw_value,
    const char *unit_label,
    bool &has_value,
    uint64_t &parsed_out,
    std::string &error)
{
    has_value = false;
    parsed_out = 0;
    const std::string trimmed = trim_ascii(raw_value);
    if (trimmed.empty()) {
        return true;
    }
    const bool digits_only = std::all_of(trimmed.begin(), trimmed.end(), [](char c) {
        return std::isdigit(static_cast<unsigned char>(c)) != 0;
    });
    errno = 0;
    char *endptr = nullptr;
    const unsigned long long parsed =
        digits_only ? std::strtoull(trimmed.c_str(), &endptr, 10) : 0;
    if (!digits_only || endptr == nullptr || *endptr != '\0' || errno == ERANGE ||
        parsed == 0 || parsed > std::numeric_limits<uint64_t>::max()) {
        error = std::string(env_name) + " must be a positive integer number of " + unit_label +
                ", got '" + raw_value + "'";
        return false;
    }
    has_value = true;
    parsed_out = static_cast<uint64_t>(parsed);
    return true;
}

bool validate_strategy_enum(GpuDemagSolverStrategy strategy, std::string &error)
{
    switch (strategy) {
    case GpuDemagSolverStrategy::Auto:
    case GpuDemagSolverStrategy::CgAmg:
    case GpuDemagSolverStrategy::Cudss:
        return true;
    default:
        error = "unsupported GPU demag solver strategy enum value " +
                std::to_string(static_cast<uint32_t>(strategy));
        return false;
    }
}

} // namespace

bool demag_gpu_direct_solver_requested()
{
    const std::string value = to_lower_ascii(trim_ascii(std::getenv(kDemagGpuDirectSolverEnv)));
    return value == "cudss";
}

bool resolve_demag_gpu_solver_strategy(
    GpuDemagSolverStrategy requested,
    const char *env_value,
    GpuDemagSolverStrategy &effective,
    std::string &error)
{
    if (!validate_strategy_enum(requested, error)) {
        return false;
    }
    const std::string value = to_lower_ascii(trim_ascii(env_value));
    if (value.empty()) {
        effective = requested;
        return true;
    }
    if (value == "auto") {
        effective = GpuDemagSolverStrategy::Auto;
        return true;
    }
    if (value == "cudss") {
        effective = GpuDemagSolverStrategy::Cudss;
        return true;
    }
    if (value == "cg_amg" || value == "hypre" || value == "off") {
        effective = GpuDemagSolverStrategy::CgAmg;
        return true;
    }
    error = std::string(kDemagGpuDirectSolverEnv) +
            " must be one of 'auto', 'cg_amg', 'hypre', 'off', or 'cudss', got '" +
            env_value + "'";
    return false;
}

bool resolve_demag_cudss_device_budget(
    uint64_t free_bytes,
    uint64_t total_bytes,
    const char *cap_value,
    GpuDemagCudssDeviceBudget &budget,
    std::string &error)
{
    return resolve_demag_cudss_device_budget(
        free_bytes, total_bytes, cap_value, nullptr, budget, error);
}

bool resolve_demag_cudss_device_budget(
    uint64_t free_bytes,
    uint64_t total_bytes,
    const char *cap_bytes_value,
    const char *cap_mib_value,
    GpuDemagCudssDeviceBudget &budget,
    std::string &error)
{
    budget = GpuDemagCudssDeviceBudget{};
    budget.free_bytes = free_bytes;
    budget.total_bytes = total_bytes;
    budget.margin_bytes = std::max(kMinimumBudgetMarginBytes, total_bytes / 20);
    budget.budget_bytes = free_bytes > budget.margin_bytes ? free_bytes - budget.margin_bytes : 0;

    bool has_bytes_cap = false;
    uint64_t bytes_cap = 0;
    if (!parse_positive_uint64_env(
            kDemagCudssDeviceBudgetCapEnv, cap_bytes_value, "bytes",
            has_bytes_cap, bytes_cap, error)) {
        return false;
    }

    bool has_mib_cap = false;
    uint64_t mib_value = 0;
    if (!parse_positive_uint64_env(
            kDemagCudssMaxVramMibEnv, cap_mib_value, "MiB",
            has_mib_cap, mib_value, error)) {
        return false;
    }

    uint64_t mib_cap_bytes = 0;
    if (has_mib_cap) {
        if (mib_value > std::numeric_limits<uint64_t>::max() / kBytesPerMiB) {
            error = std::string(kDemagCudssMaxVramMibEnv) +
                    " overflows uint64 byte conversion, got '" + cap_mib_value + "'";
            return false;
        }
        mib_cap_bytes = mib_value * kBytesPerMiB;
    }

    if (has_bytes_cap && has_mib_cap) {
        budget.cap_bytes = std::min(bytes_cap, mib_cap_bytes);
    } else if (has_bytes_cap) {
        budget.cap_bytes = bytes_cap;
    } else if (has_mib_cap) {
        budget.cap_bytes = mib_cap_bytes;
    }
    if (budget.cap_bytes != 0) {
        budget.budget_bytes = std::min(budget.budget_bytes, budget.cap_bytes);
    }
    return true;
}

bool check_demag_cudss_factor_fits(
    int64_t estimated_device_peak_bytes,
    const GpuDemagCudssDeviceBudget &budget,
    int64_t rows,
    int64_t estimated_factor_nnz,
    std::string &error)
{
    if (estimated_device_peak_bytes <= 0) {
        error = "cuDSS Poisson demag memory preflight got no device peak estimate "
                "(CUDSS_DATA_MEMORY_ESTIMATES[1] = " +
                std::to_string(estimated_device_peak_bytes) +
                "); the factorization was not started";
        return false;
    }
    if (static_cast<uint64_t>(estimated_device_peak_bytes) <= budget.budget_bytes) {
        return true;
    }
    error = "cuDSS Poisson demag factorization needs an estimated device peak of " +
            format_bytes(static_cast<uint64_t>(estimated_device_peak_bytes)) +
            ", above the device budget of " + format_bytes(budget.budget_bytes) +
            " (free device memory after analysis " + format_bytes(budget.free_bytes) +
            " minus a margin of " + format_bytes(budget.margin_bytes);
    if (budget.cap_bytes != 0) {
        error += ", capped by " + std::string(kDemagCudssDeviceBudgetCapEnv) + "/" +
                 std::string(kDemagCudssMaxVramMibEnv) + "=" +
                 std::to_string(budget.cap_bytes);
    }
    error += "); rows=" + std::to_string(rows) + ", estimated factor nonzeros=" +
             (estimated_factor_nnz >= 0 ? std::to_string(estimated_factor_nnz)
                                        : std::string("unavailable")) +
             ". The factorization was not started. Use gpu_strategy='auto' or 'cg_amg' "
             "to run the HYPRE Krylov solver.";
    return false;
}

#if FULLMAG_DEMAG_CUDSS_ACTIVE

struct GpuDemagCudssDirectSolver {
    cudssHandle_t handle = nullptr;
    cudssConfig_t config = nullptr;
    cudssData_t data = nullptr;
    cudssMatrix_t matrix = nullptr;
    cudssMatrix_t rhs = nullptr;
    cudssMatrix_t solution = nullptr;
    int32_t *d_offsets = nullptr;
    int32_t *d_columns = nullptr;
    double *d_values = nullptr;
    // Two placeholder vectors bind the dense descriptors during analysis and
    // factorization; each solve rebinds them to the caller's buffers.
    double *d_placeholder = nullptr;
    int64_t rows = 0;

    GpuDemagCudssDirectSolver() = default;
    GpuDemagCudssDirectSolver(const GpuDemagCudssDirectSolver &) = delete;
    GpuDemagCudssDirectSolver &operator=(const GpuDemagCudssDirectSolver &) = delete;

    ~GpuDemagCudssDirectSolver()
    {
        if (data != nullptr && handle != nullptr) {
            cudssDataDestroy(handle, data);
        }
        for (cudssMatrix_t descriptor : {matrix, rhs, solution}) {
            if (descriptor != nullptr) {
                cudssMatrixDestroy(descriptor);
            }
        }
        if (config != nullptr) {
            cudssConfigDestroy(config);
        }
        if (handle != nullptr) {
            cudssDestroy(handle);
        }
        cudaFree(d_offsets);
        cudaFree(d_columns);
        cudaFree(d_values);
        cudaFree(d_placeholder);
    }
};

namespace {

struct LowerCsr {
    std::vector<int32_t> offsets;
    std::vector<int32_t> columns;
    std::vector<double> values;
};

// Keeps the lower triangle of each row, sorted by column, summing duplicates.
bool lower_triangle_csr(const mfem::SparseMatrix &matrix, LowerCsr &out, std::string &error)
{
    const int n = matrix.Height();
    if (n <= 0 || matrix.Width() != n) {
        error = "cuDSS Poisson demag requires a square, non-empty Poisson matrix";
        return false;
    }
    const int *row_start = matrix.HostReadI();
    const int *column = matrix.HostReadJ();
    const double *value = matrix.HostReadData();
    if (row_start == nullptr || column == nullptr || value == nullptr) {
        error = "cuDSS Poisson demag requires a finalized CSR Poisson matrix";
        return false;
    }
    out.offsets.assign(static_cast<size_t>(n) + 1, 0);
    out.columns.clear();
    out.values.clear();
    out.columns.reserve(static_cast<size_t>(row_start[n]) / 2 + n);
    out.values.reserve(static_cast<size_t>(row_start[n]) / 2 + n);
    std::vector<std::pair<int, double>> row;
    for (int i = 0; i < n; ++i) {
        row.clear();
        for (int p = row_start[i]; p < row_start[i + 1]; ++p) {
            const int j = column[p];
            if (j < 0 || j >= n) {
                error = "cuDSS Poisson demag found a column index out of range in row " +
                        std::to_string(i);
                return false;
            }
            if (j <= i) {
                row.emplace_back(j, value[p]);
            }
        }
        std::sort(row.begin(), row.end(),
                  [](const auto &a, const auto &b) { return a.first < b.first; });
        bool has_positive_diagonal = false;
        for (size_t k = 0; k < row.size(); ++k) {
            if (k > 0 && row[k].first == row[k - 1].first) {
                out.values.back() += row[k].second;
            } else {
                out.columns.push_back(row[k].first);
                out.values.push_back(row[k].second);
            }
        }
        if (!out.columns.empty() && out.columns.back() == i && out.values.back() > 0.0) {
            has_positive_diagonal = true;
        }
        if (!has_positive_diagonal) {
            error = "cuDSS Poisson demag requires a positive diagonal entry in row " +
                    std::to_string(i);
            return false;
        }
        if (out.columns.size() > static_cast<size_t>(INT32_MAX)) {
            error = "cuDSS Poisson demag lower triangle exceeds 32-bit CSR indexing";
            return false;
        }
        out.offsets[static_cast<size_t>(i) + 1] = static_cast<int32_t>(out.columns.size());
    }
    return true;
}

bool cuda_step(cudaError_t status, const char *what, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string("cuDSS Poisson demag ") + what + " failed: " + cudaGetErrorString(status);
    return false;
}

bool cudss_step(cudssStatus_t status, const char *what, std::string &error)
{
    if (status == CUDSS_STATUS_SUCCESS) {
        return true;
    }
    error = std::string("cuDSS Poisson demag ") + what + " failed with cuDSS status " +
            std::to_string(static_cast<int>(status));
    return false;
}

double milliseconds_since(std::chrono::steady_clock::time_point start)
{
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start)
        .count();
}

enum class AnalyzeStatus {
    Ok,
    MemoryEstimateUnavailable,
    HardError,
};

struct AnalyzedCudssSystem {
    std::shared_ptr<GpuDemagCudssDirectSolver> solver;
    GpuDemagCudssDirectStats stats{};
    int64_t estimated_factor_nnz = -1;
    uint64_t analysis_device_bytes = 0;
};

AnalyzeStatus analyze_demag_cudss_system(
    const mfem::SparseMatrix &matrix,
    AnalyzedCudssSystem &out,
    std::string &error)
{
    out = AnalyzedCudssSystem{};
    LowerCsr csr;
    if (!lower_triangle_csr(matrix, csr, error)) {
        return AnalyzeStatus::HardError;
    }
    const int64_t n = static_cast<int64_t>(csr.offsets.size()) - 1;
    const int64_t nnz = static_cast<int64_t>(csr.columns.size());
    out.stats.rows = n;
    out.stats.lower_nnz = nnz;

    size_t free_before = 0;
    size_t total = 0;
    if (!cuda_step(cudaDeviceSynchronize(), "pre-setup synchronize", error) ||
        !cuda_step(cudaMemGetInfo(&free_before, &total), "memory query", error)) {
        return AnalyzeStatus::HardError;
    }

    auto owned = std::make_shared<GpuDemagCudssDirectSolver>();
    owned->rows = n;
    if (!cuda_step(cudaMalloc(reinterpret_cast<void **>(&owned->d_offsets),
                              csr.offsets.size() * sizeof(int32_t)), "CSR offsets allocation", error) ||
        !cuda_step(cudaMalloc(reinterpret_cast<void **>(&owned->d_columns),
                              csr.columns.size() * sizeof(int32_t)), "CSR columns allocation", error) ||
        !cuda_step(cudaMalloc(reinterpret_cast<void **>(&owned->d_values),
                              csr.values.size() * sizeof(double)), "CSR values allocation", error) ||
        !cuda_step(cudaMalloc(reinterpret_cast<void **>(&owned->d_placeholder),
                              static_cast<size_t>(2 * n) * sizeof(double)), "placeholder allocation", error) ||
        !cuda_step(cudaMemcpy(owned->d_offsets, csr.offsets.data(),
                              csr.offsets.size() * sizeof(int32_t), cudaMemcpyHostToDevice),
                   "CSR offsets upload", error) ||
        !cuda_step(cudaMemcpy(owned->d_columns, csr.columns.data(),
                              csr.columns.size() * sizeof(int32_t), cudaMemcpyHostToDevice),
                   "CSR columns upload", error) ||
        !cuda_step(cudaMemcpy(owned->d_values, csr.values.data(),
                              csr.values.size() * sizeof(double), cudaMemcpyHostToDevice),
                   "CSR values upload", error) ||
        !cuda_step(cudaMemset(owned->d_placeholder, 0, static_cast<size_t>(2 * n) * sizeof(double)),
                   "placeholder clear", error)) {
        return AnalyzeStatus::HardError;
    }

    if (!cudss_step(cudssCreate(&owned->handle), "handle creation", error) ||
        !cudss_step(cudssConfigCreate(&owned->config), "config creation", error) ||
        !cudss_step(cudssDataCreate(owned->handle, &owned->data), "data creation", error) ||
        !cudss_step(cudssMatrixCreateCsr(&owned->matrix, n, n, nnz, owned->d_offsets, nullptr,
                                         owned->d_columns, owned->d_values, CUDSS_R_32I, CUDSS_R_32I,
                                         CUDSS_R_64F, CUDSS_MTYPE_SPD, CUDSS_MVIEW_LOWER,
                                         CUDSS_BASE_ZERO),
                    "matrix descriptor", error) ||
        !cudss_step(cudssMatrixCreateDn(&owned->rhs, n, 1, n, owned->d_placeholder, CUDSS_R_64F,
                                        CUDSS_LAYOUT_COL_MAJOR),
                    "right-hand side descriptor", error) ||
        !cudss_step(cudssMatrixCreateDn(&owned->solution, n, 1, n, owned->d_placeholder + n,
                                        CUDSS_R_64F, CUDSS_LAYOUT_COL_MAJOR),
                    "solution descriptor", error)) {
        return AnalyzeStatus::HardError;
    }

    auto phase_start = std::chrono::steady_clock::now();
    if (!cudss_step(cudssExecute(owned->handle, CUDSS_PHASE_ANALYSIS, owned->config, owned->data,
                                 owned->matrix, owned->solution, owned->rhs),
                    "analysis", error) ||
        !cuda_step(cudaDeviceSynchronize(), "analysis synchronize", error)) {
        return AnalyzeStatus::HardError;
    }
    out.stats.analysis_ms = milliseconds_since(phase_start);

    size_t free_after_analysis = 0;
    if (!cuda_step(cudaMemGetInfo(&free_after_analysis, &total), "memory query", error)) {
        return AnalyzeStatus::HardError;
    }
    out.analysis_device_bytes =
        free_before > free_after_analysis ? static_cast<uint64_t>(free_before - free_after_analysis) : 0;

    // Memory preflight (docs/physics/0997, eq-direct-memory-budget). Under WDDM
    // an allocation beyond dedicated memory is paged to host memory instead of
    // failing, so the factorization runs only when the estimated device peak
    // fits the budget. In cuDSS 0.8 entries 0/1 are the device stable/peak bytes.
    size_t written = 0;
    int64_t memory_estimates[16] = {0};
    if (!cudss_step(cudssDataGet(owned->handle, owned->data, CUDSS_DATA_MEMORY_ESTIMATES,
                                 memory_estimates, sizeof(memory_estimates), &written),
                    "memory estimate query", error)) {
        error += "; the factorization was not started";
        return AnalyzeStatus::MemoryEstimateUnavailable;
    }
    out.stats.estimated_device_stable_bytes = memory_estimates[0];
    out.stats.estimated_device_peak_bytes = memory_estimates[1];
    if (out.stats.estimated_device_peak_bytes <= 0) {
        error = "cuDSS Poisson demag memory preflight got no device peak estimate "
                "(CUDSS_DATA_MEMORY_ESTIMATES[1] = " +
                std::to_string(out.stats.estimated_device_peak_bytes) +
                "); the factorization was not started";
        return AnalyzeStatus::MemoryEstimateUnavailable;
    }

    int64_t estimated_factor_nnz = -1;
    if (cudssDataGet(owned->handle, owned->data, CUDSS_DATA_LU_NNZ, &estimated_factor_nnz,
                     sizeof(estimated_factor_nnz), &written) != CUDSS_STATUS_SUCCESS) {
        estimated_factor_nnz = -1;
    }
    out.estimated_factor_nnz = estimated_factor_nnz;
    out.solver = std::move(owned);
    return AnalyzeStatus::Ok;
}

bool factorize_analyzed_cudss_system(
    AnalyzedCudssSystem &analyzed,
    std::shared_ptr<GpuDemagCudssDirectSolver> &solver,
    GpuDemagCudssDirectStats &stats,
    std::string &error)
{
    solver.reset();
    auto &owned = analyzed.solver;
    if (owned == nullptr) {
        error = "cuDSS Poisson demag factorization requires an analyzed solver handle";
        return false;
    }

    size_t free_before_factor = 0;
    size_t free_after_factor = 0;
    size_t total = 0;
    if (!cuda_step(cudaMemGetInfo(&free_before_factor, &total), "memory query", error)) {
        stats = analyzed.stats;
        owned.reset();
        return false;
    }

    analyzed.stats.factorization_started = true;
    const auto phase_start = std::chrono::steady_clock::now();
    if (!cudss_step(cudssExecute(owned->handle, CUDSS_PHASE_FACTORIZATION, owned->config,
                                 owned->data, owned->matrix, owned->solution, owned->rhs),
                    "factorization", error) ||
        !cuda_step(cudaDeviceSynchronize(), "factorization synchronize", error)) {
        stats = analyzed.stats;
        owned.reset();
        return false;
    }
    analyzed.stats.factorization_ms = milliseconds_since(phase_start);

    size_t written = 0;
    int info = -1;
    if (!cudss_step(cudssDataGet(owned->handle, owned->data, CUDSS_DATA_INFO, &info, sizeof(info),
                                 &written),
                    "factorization status query", error)) {
        stats = analyzed.stats;
        owned.reset();
        return false;
    }
    if (info != 0) {
        error = "cuDSS Poisson demag factorization reported info=" + std::to_string(info) +
                ": the Poisson matrix is not symmetric positive definite";
        stats = analyzed.stats;
        owned.reset();
        return false;
    }
    int64_t factor_nnz = -1;
    if (cudssDataGet(owned->handle, owned->data, CUDSS_DATA_LU_NNZ, &factor_nnz,
                     sizeof(factor_nnz), &written) != CUDSS_STATUS_SUCCESS) {
        factor_nnz = -1;
    }
    if (!cuda_step(cudaMemGetInfo(&free_after_factor, &total), "memory query", error)) {
        stats = analyzed.stats;
        owned.reset();
        return false;
    }

    const uint64_t factor_delta =
        free_before_factor > free_after_factor
            ? static_cast<uint64_t>(free_before_factor - free_after_factor)
            : 0;
    analyzed.stats.factor_nnz = factor_nnz;
    analyzed.stats.device_bytes = analyzed.analysis_device_bytes + factor_delta;
    stats = analyzed.stats;
    solver = std::move(owned);
    return true;
}

void append_analysis_time(std::string &error, double analysis_ms)
{
    char analysis_time[64];
    std::snprintf(analysis_time, sizeof(analysis_time), " Analysis took %.1f s.",
                  analysis_ms / 1000.0);
    error += analysis_time;
}

} // namespace

#else

struct GpuDemagCudssDirectSolver {};

#endif

bool create_demag_cudss_direct_solver(
    const mfem::SparseMatrix &matrix,
    std::shared_ptr<GpuDemagCudssDirectSolver> &solver,
    GpuDemagCudssDirectStats &stats,
    std::string &error)
{
    solver.reset();
    stats = GpuDemagCudssDirectStats{};
#if FULLMAG_DEMAG_CUDSS_ACTIVE
    const char *bytes_cap = std::getenv(kDemagCudssDeviceBudgetCapEnv);
    const char *mib_cap = std::getenv(kDemagCudssMaxVramMibEnv);
    GpuDemagCudssDeviceBudget syntax_budget{};
    if (!resolve_demag_cudss_device_budget(0, 0, bytes_cap, mib_cap, syntax_budget, error)) {
        return false;
    }

    AnalyzedCudssSystem analyzed;
    const AnalyzeStatus status = analyze_demag_cudss_system(matrix, analyzed, error);
    if (status != AnalyzeStatus::Ok) {
        stats = analyzed.stats;
        if (status == AnalyzeStatus::MemoryEstimateUnavailable) {
            append_analysis_time(error, stats.analysis_ms);
        }
        return false;
    }

    size_t free_after_analysis = 0;
    size_t total = 0;
    if (!cuda_step(cudaMemGetInfo(&free_after_analysis, &total), "memory query", error) ||
        !resolve_demag_cudss_device_budget(
            static_cast<uint64_t>(free_after_analysis), static_cast<uint64_t>(total),
            bytes_cap, mib_cap, analyzed.stats.budget, error) ||
        !check_demag_cudss_factor_fits(analyzed.stats.estimated_device_peak_bytes,
                                       analyzed.stats.budget, analyzed.stats.rows,
                                       analyzed.estimated_factor_nnz, error)) {
        stats = analyzed.stats;
        analyzed.solver.reset();
        append_analysis_time(error, stats.analysis_ms);
        return false;
    }

    return factorize_analyzed_cudss_system(analyzed, solver, stats, error);
#else
    (void)matrix;
    error = kCudssUnavailable;
    return false;
#endif
}

bool try_initialize_demag_cudss_direct(
    GpuDemagSolverStrategy requested_strategy,
    const mfem::SparseMatrix &matrix,
    std::shared_ptr<GpuDemagCudssDirectSolver> &solver,
    GpuDemagCudssDirectStats &stats,
    GpuDemagCudssResolution &resolution,
    std::string &error)
{
    solver.reset();
    stats = GpuDemagCudssDirectStats{};
    resolution = GpuDemagCudssResolution{};
    resolution.requested_strategy = requested_strategy;

    GpuDemagSolverStrategy effective = GpuDemagSolverStrategy::Auto;
    if (!resolve_demag_gpu_solver_strategy(
            requested_strategy, std::getenv(kDemagGpuDirectSolverEnv), effective, error)) {
        return false;
    }
    resolution.effective_strategy = effective;

    // Malformed VRAM caps always fail closed, regardless of strategy or build.
    const char *bytes_cap = std::getenv(kDemagCudssDeviceBudgetCapEnv);
    const char *mib_cap = std::getenv(kDemagCudssMaxVramMibEnv);
    GpuDemagCudssDeviceBudget syntax_budget{};
    if (!resolve_demag_cudss_device_budget(0, 0, bytes_cap, mib_cap, syntax_budget, error)) {
        return false;
    }

    if (effective == GpuDemagSolverStrategy::CgAmg) {
        return true;
    }

#if FULLMAG_DEMAG_CUDSS_ACTIVE
    AnalyzedCudssSystem analyzed;
    std::string analyze_error;
    const AnalyzeStatus status = analyze_demag_cudss_system(matrix, analyzed, analyze_error);
    if (status == AnalyzeStatus::HardError) {
        stats = analyzed.stats;
        error = std::move(analyze_error);
        return false;
    }
    if (status == AnalyzeStatus::MemoryEstimateUnavailable) {
        analyzed.solver.reset();
        stats = analyzed.stats;
        resolution.estimated_device_peak_bytes = stats.estimated_device_peak_bytes;
        if (effective == GpuDemagSolverStrategy::Auto) {
            resolution.fallback_reason = GpuDemagFallbackReason::CudssMemoryEstimateUnavailable;
            error.clear();
            return true;
        }
        append_analysis_time(analyze_error, stats.analysis_ms);
        error = std::move(analyze_error);
        return false;
    }

    size_t free_after_analysis = 0;
    size_t total = 0;
    if (!cuda_step(cudaMemGetInfo(&free_after_analysis, &total), "memory query", error) ||
        !resolve_demag_cudss_device_budget(
            static_cast<uint64_t>(free_after_analysis), static_cast<uint64_t>(total),
            bytes_cap, mib_cap, analyzed.stats.budget, error)) {
        stats = analyzed.stats;
        analyzed.solver.reset();
        return false;
    }

    resolution.estimated_device_peak_bytes = analyzed.stats.estimated_device_peak_bytes;
    resolution.device_budget_bytes = analyzed.stats.budget.budget_bytes;

    std::string fit_error;
    if (!check_demag_cudss_factor_fits(
            analyzed.stats.estimated_device_peak_bytes, analyzed.stats.budget,
            analyzed.stats.rows, analyzed.estimated_factor_nnz, fit_error)) {
        analyzed.solver.reset();
        stats = analyzed.stats;
        if (effective == GpuDemagSolverStrategy::Auto) {
            resolution.fallback_reason = GpuDemagFallbackReason::CudssFactorExceedsVramBudget;
            error.clear();
            return true;
        }
        append_analysis_time(fit_error, stats.analysis_ms);
        error = std::move(fit_error);
        return false;
    }

    // Factorization failures (including CUDSS_DATA_INFO != 0 for non-SPD /
    // singular 3D pure-Neumann matrices) always fail closed even under Auto.
    if (!factorize_analyzed_cudss_system(analyzed, solver, stats, error)) {
        return false;
    }

    resolution.resolved_direct = true;
    resolution.fallback_reason = GpuDemagFallbackReason::None;
    resolution.factor_nnz = stats.factor_nnz;
    resolution.factor_device_bytes = stats.device_bytes;
    return true;
#else
    (void)matrix;
    if (effective == GpuDemagSolverStrategy::Cudss) {
        error = kCudssUnavailable;
        return false;
    }
    resolution.fallback_reason = GpuDemagFallbackReason::CudssUnavailable;
    error.clear();
    return true;
#endif
}

bool try_initialize_fem_bem_cudss_pair(
    GpuDemagSolverStrategy requested_strategy,
    const mfem::SparseMatrix &u1_matrix,
    const mfem::SparseMatrix &u2_matrix,
    std::shared_ptr<GpuDemagCudssDirectSolver> &u1_solver,
    std::shared_ptr<GpuDemagCudssDirectSolver> &u2_solver,
    GpuDemagCudssDirectStats &u1_stats,
    GpuDemagCudssDirectStats &u2_stats,
    GpuDemagCudssResolution &resolution,
    std::string &error)
{
    u1_solver.reset();
    u2_solver.reset();
    u1_stats = GpuDemagCudssDirectStats{};
    u2_stats = GpuDemagCudssDirectStats{};
    resolution = GpuDemagCudssResolution{};
    resolution.requested_strategy = requested_strategy;

    GpuDemagSolverStrategy effective = GpuDemagSolverStrategy::Auto;
    if (!resolve_demag_gpu_solver_strategy(
            requested_strategy, std::getenv(kDemagGpuDirectSolverEnv), effective, error)) {
        return false;
    }
    resolution.effective_strategy = effective;

    // Malformed VRAM caps always fail closed, regardless of strategy or build.
    const char *bytes_cap = std::getenv(kDemagCudssDeviceBudgetCapEnv);
    const char *mib_cap = std::getenv(kDemagCudssMaxVramMibEnv);
    GpuDemagCudssDeviceBudget syntax_budget{};
    if (!resolve_demag_cudss_device_budget(0, 0, bytes_cap, mib_cap, syntax_budget, error)) {
        return false;
    }

    if (effective == GpuDemagSolverStrategy::CgAmg) {
        return true;
    }

#if FULLMAG_DEMAG_CUDSS_ACTIVE
    AnalyzedCudssSystem u1_analyzed;
    std::string analyze_error;
    const AnalyzeStatus u1_status = analyze_demag_cudss_system(u1_matrix, u1_analyzed, analyze_error);
    if (u1_status == AnalyzeStatus::HardError) {
        u1_stats = u1_analyzed.stats;
        error = std::move(analyze_error);
        return false;
    }
    if (u1_status == AnalyzeStatus::MemoryEstimateUnavailable) {
        u1_analyzed.solver.reset();
        u1_stats = u1_analyzed.stats;
        resolution.estimated_device_peak_bytes = u1_stats.estimated_device_peak_bytes;
        if (effective == GpuDemagSolverStrategy::Auto) {
            resolution.fallback_reason = GpuDemagFallbackReason::CudssMemoryEstimateUnavailable;
            error.clear();
            return true;
        }
        append_analysis_time(analyze_error, u1_stats.analysis_ms);
        error = std::move(analyze_error);
        return false;
    }

    AnalyzedCudssSystem u2_analyzed;
    const AnalyzeStatus u2_status = analyze_demag_cudss_system(u2_matrix, u2_analyzed, analyze_error);
    if (u2_status == AnalyzeStatus::HardError) {
        u1_analyzed.solver.reset();
        u2_analyzed.solver.reset();
        u1_stats = u1_analyzed.stats;
        u2_stats = u2_analyzed.stats;
        error = std::move(analyze_error);
        return false;
    }
    if (u2_status == AnalyzeStatus::MemoryEstimateUnavailable) {
        u1_analyzed.solver.reset();
        u2_analyzed.solver.reset();
        u1_stats = u1_analyzed.stats;
        u2_stats = u2_analyzed.stats;
        resolution.estimated_device_peak_bytes = u2_stats.estimated_device_peak_bytes;
        if (effective == GpuDemagSolverStrategy::Auto) {
            resolution.fallback_reason = GpuDemagFallbackReason::CudssMemoryEstimateUnavailable;
            error.clear();
            return true;
        }
        append_analysis_time(analyze_error, u1_stats.analysis_ms + u2_stats.analysis_ms);
        error = std::move(analyze_error);
        return false;
    }

    size_t free_after_analysis = 0;
    size_t total = 0;
    GpuDemagCudssDeviceBudget budget{};
    if (!cuda_step(cudaMemGetInfo(&free_after_analysis, &total), "memory query", error) ||
        !resolve_demag_cudss_device_budget(
            static_cast<uint64_t>(free_after_analysis), static_cast<uint64_t>(total),
            bytes_cap, mib_cap, budget, error)) {
        u1_analyzed.solver.reset();
        u2_analyzed.solver.reset();
        u1_stats = u1_analyzed.stats;
        u2_stats = u2_analyzed.stats;
        return false;
    }
    u1_analyzed.stats.budget = budget;
    u2_analyzed.stats.budget = budget;

    // Combined sequential peak: max(peak_1, stable_1 + peak_2) <= budget.
    const uint64_t peak_1 = static_cast<uint64_t>(u1_analyzed.stats.estimated_device_peak_bytes);
    const uint64_t stable_1 = u1_analyzed.stats.estimated_device_stable_bytes > 0
        ? static_cast<uint64_t>(u1_analyzed.stats.estimated_device_stable_bytes)
        : 0u;
    const uint64_t peak_2 = static_cast<uint64_t>(u2_analyzed.stats.estimated_device_peak_bytes);
    const uint64_t second_stage_peak =
        (stable_1 > std::numeric_limits<uint64_t>::max() - peak_2)
            ? std::numeric_limits<uint64_t>::max()
            : stable_1 + peak_2;
    const uint64_t combined_peak = std::max(peak_1, second_stage_peak);
    const int64_t combined_peak_i64 =
        combined_peak > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())
            ? std::numeric_limits<int64_t>::max()
            : static_cast<int64_t>(combined_peak);
    const int64_t combined_rows = u1_analyzed.stats.rows + u2_analyzed.stats.rows;
    const int64_t combined_est_nnz =
        (u1_analyzed.estimated_factor_nnz >= 0 && u2_analyzed.estimated_factor_nnz >= 0)
            ? (u1_analyzed.estimated_factor_nnz + u2_analyzed.estimated_factor_nnz)
            : -1;

    resolution.estimated_device_peak_bytes = combined_peak_i64;
    resolution.device_budget_bytes = budget.budget_bytes;

    std::string fit_error;
    if (!check_demag_cudss_factor_fits(
            combined_peak_i64, budget, combined_rows, combined_est_nnz, fit_error)) {
        u1_analyzed.solver.reset();
        u2_analyzed.solver.reset();
        u1_stats = u1_analyzed.stats;
        u2_stats = u2_analyzed.stats;
        if (effective == GpuDemagSolverStrategy::Auto) {
            resolution.fallback_reason = GpuDemagFallbackReason::CudssFactorExceedsVramBudget;
            error.clear();
            return true;
        }
        append_analysis_time(fit_error, u1_stats.analysis_ms + u2_stats.analysis_ms);
        error = std::move(fit_error);
        return false;
    }

    // Factorize atomically: if u2 fails after u1 succeeds, destroy u1_solver
    // immediately so FEM/BEM never leaves a partial direct-solver pair.
    if (!factorize_analyzed_cudss_system(u1_analyzed, u1_solver, u1_stats, error)) {
        u2_analyzed.solver.reset();
        u2_stats = u2_analyzed.stats;
        u1_solver.reset();
        return false;
    }
    if (!factorize_analyzed_cudss_system(u2_analyzed, u2_solver, u2_stats, error)) {
        u1_solver.reset();
        u2_solver.reset();
        return false;
    }

    resolution.resolved_direct = true;
    resolution.fallback_reason = GpuDemagFallbackReason::None;
    resolution.factor_nnz =
        (u1_stats.factor_nnz >= 0 && u2_stats.factor_nnz >= 0)
            ? (u1_stats.factor_nnz + u2_stats.factor_nnz)
            : -1;
    resolution.factor_device_bytes = u1_stats.device_bytes + u2_stats.device_bytes;
    return true;
#else
    (void)u1_matrix;
    (void)u2_matrix;
    if (effective == GpuDemagSolverStrategy::Cudss) {
        error = kCudssUnavailable;
        return false;
    }
    resolution.fallback_reason = GpuDemagFallbackReason::CudssUnavailable;
    error.clear();
    return true;
#endif
}

bool solve_demag_cudss_direct(
    GpuDemagCudssDirectSolver &solver,
    void *raw_stream,
    const double *rhs,
    double *solution,
    std::string &error)
{
    if (rhs == nullptr || solution == nullptr) {
        error = "cuDSS Poisson demag solve requires device right-hand side and solution buffers";
        return false;
    }
#if FULLMAG_DEMAG_CUDSS_ACTIVE
    return cudss_step(cudssSetStream(solver.handle, static_cast<cudaStream_t>(raw_stream)),
                      "stream binding", error) &&
           cudss_step(cudssMatrixSetValues(solver.rhs, rhs), "right-hand side binding", error) &&
           cudss_step(cudssMatrixSetValues(solver.solution, solution), "solution binding", error) &&
           cudss_step(cudssExecute(solver.handle, CUDSS_PHASE_SOLVE, solver.config, solver.data,
                                   solver.matrix, solver.solution, solver.rhs),
                      "solve", error);
#else
    (void)solver;
    (void)raw_stream;
    error = kCudssUnavailable;
    return false;
#endif
}

} // namespace fullmag::fem
