#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
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

bool demag_gpu_direct_solver_requested()
{
    const char *raw = std::getenv("FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER");
    if (raw == nullptr) {
        return false;
    }
    std::string value;
    for (const char *c = raw; *c != '\0'; ++c) {
        if (!std::isspace(static_cast<unsigned char>(*c))) {
            value.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(*c))));
        }
    }
    return value == "cudss";
}

namespace {
constexpr const char *kCudssUnavailable =
    "FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss requires a FEM GPU build with cuDSS";
} // namespace

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
    LowerCsr csr;
    if (!lower_triangle_csr(matrix, csr, error)) {
        return false;
    }
    const int64_t n = static_cast<int64_t>(csr.offsets.size()) - 1;
    const int64_t nnz = static_cast<int64_t>(csr.columns.size());

    size_t free_before = 0;
    size_t free_after = 0;
    size_t total = 0;
    if (!cuda_step(cudaDeviceSynchronize(), "pre-setup synchronize", error) ||
        !cuda_step(cudaMemGetInfo(&free_before, &total), "memory query", error)) {
        return false;
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
        return false;
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
        return false;
    }

    auto phase_start = std::chrono::steady_clock::now();
    if (!cudss_step(cudssExecute(owned->handle, CUDSS_PHASE_ANALYSIS, owned->config, owned->data,
                                 owned->matrix, owned->solution, owned->rhs),
                    "analysis", error) ||
        !cuda_step(cudaDeviceSynchronize(), "analysis synchronize", error)) {
        return false;
    }
    stats.analysis_ms = milliseconds_since(phase_start);

    phase_start = std::chrono::steady_clock::now();
    if (!cudss_step(cudssExecute(owned->handle, CUDSS_PHASE_FACTORIZATION, owned->config,
                                 owned->data, owned->matrix, owned->solution, owned->rhs),
                    "factorization", error) ||
        !cuda_step(cudaDeviceSynchronize(), "factorization synchronize", error)) {
        return false;
    }
    stats.factorization_ms = milliseconds_since(phase_start);

    int info = -1;
    size_t written = 0;
    if (!cudss_step(cudssDataGet(owned->handle, owned->data, CUDSS_DATA_INFO, &info, sizeof(info),
                                 &written),
                    "factorization status query", error)) {
        return false;
    }
    if (info != 0) {
        error = "cuDSS Poisson demag factorization reported info=" + std::to_string(info) +
                ": the Poisson matrix is not symmetric positive definite";
        return false;
    }
    int64_t factor_nnz = -1;
    if (cudssDataGet(owned->handle, owned->data, CUDSS_DATA_LU_NNZ, &factor_nnz,
                     sizeof(factor_nnz), &written) != CUDSS_STATUS_SUCCESS) {
        factor_nnz = -1;
    }
    if (!cuda_step(cudaMemGetInfo(&free_after, &total), "memory query", error)) {
        return false;
    }

    stats.rows = n;
    stats.lower_nnz = nnz;
    stats.factor_nnz = factor_nnz;
    stats.device_bytes = free_before > free_after ? static_cast<uint64_t>(free_before - free_after) : 0;
    solver = std::move(owned);
    return true;
#else
    (void)matrix;
    error = kCudssUnavailable;
    return false;
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
