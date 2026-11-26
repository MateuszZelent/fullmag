#include "cpu/mfem/common/sparse_linear_solver.hpp"

#include "core/petsc_slepc_runtime.hpp"
#include "cpu/mfem/runtime/hypre_host_policy.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#if defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI
#define FULLMAG_MULTIPHYSICS_DISABLE_MPI 1
#else
#define FULLMAG_MULTIPHYSICS_DISABLE_MPI 0
#endif

#if defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK && \
    defined(MFEM_USE_MPI) && !FULLMAG_MULTIPHYSICS_DISABLE_MPI
#define FULLMAG_MULTIPHYSICS_HAS_MPI 1
#include "cpu/mfem/runtime/mpi_init.hpp"
#include <mpi.h>
#else
#define FULLMAG_MULTIPHYSICS_HAS_MPI 0
#endif

#if defined(FULLMAG_FEM_WITH_SLEPC) && FULLMAG_FEM_WITH_SLEPC && \
    !FULLMAG_MULTIPHYSICS_DISABLE_MPI
#define FULLMAG_MULTIPHYSICS_HAS_PETSC 1
#include <petscksp.h>
#else
#define FULLMAG_MULTIPHYSICS_HAS_PETSC 0
#endif

#if (FULLMAG_MULTIPHYSICS_HAS_MPI || FULLMAG_MULTIPHYSICS_HAS_PETSC) && defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

#if defined(FULLMAG_FEM_CUDSS_POISSON_ENABLED) && FULLMAG_FEM_CUDSS_POISSON_ENABLED && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#define FULLMAG_MULTIPHYSICS_HAS_CUDSS 1
#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"
#include <cuda_runtime.h>
#include <cudss.h>
#else
#define FULLMAG_MULTIPHYSICS_HAS_CUDSS 0
#endif

namespace fullmag::fem::multiphysics {

namespace {

using SteadyClock = std::chrono::steady_clock;

double elapsed_ms(SteadyClock::time_point start) noexcept
{
    return std::chrono::duration<double, std::milli>(SteadyClock::now() - start).count();
}

#if FULLMAG_MULTIPHYSICS_HAS_MPI || FULLMAG_MULTIPHYSICS_HAS_PETSC
bool can_initialize_openmpi_singleton() noexcept
{
#if defined(__unix__)
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        ::close(fd);
        return true;
    }
    return false;
#else
    return true;
#endif
}
#endif

// Build a clean, sorted-column, duplicate-free finalized CSR copy of `source`.
mfem::SparseMatrix make_canonical_csr_copy(const mfem::SparseMatrix &source)
{
    if (!source.Finalized()) {
        throw std::invalid_argument(
            "SparseLinearSolver requires a finalized mfem::SparseMatrix");
    }
    const int nrows = source.Height();
    const int ncols = source.Width();
    if (nrows <= 0 || ncols <= 0) {
        throw std::invalid_argument(
            "SparseLinearSolver requires a non-empty sparse matrix");
    }
    const int *src_i = source.HostReadI();
    const int *src_j = source.HostReadJ();
    const double *src_a = source.HostReadData();
    if (src_i == nullptr || src_j == nullptr || src_a == nullptr) {
        throw std::invalid_argument(
            "SparseLinearSolver requires readable host CSR arrays");
    }

    const int src_nnz = src_i[nrows];
    if (src_nnz < 0) {
        throw std::invalid_argument("SparseLinearSolver received negative CSR nnz");
    }

    auto row_offsets = std::make_unique<int[]>(static_cast<std::size_t>(nrows) + 1);
    std::vector<int> cols;
    std::vector<double> vals;
    cols.reserve(static_cast<std::size_t>(src_nnz));
    vals.reserve(static_cast<std::size_t>(src_nnz));

    std::vector<std::pair<int, double>> row_buf;
    row_offsets[0] = 0;
    for (int r = 0; r < nrows; ++r) {
        const int begin = src_i[r];
        const int end = src_i[r + 1];
        if (begin < 0 || end < begin || end > src_nnz) {
            throw std::invalid_argument(
                "SparseLinearSolver found malformed CSR row bounds");
        }
        row_buf.clear();
        row_buf.reserve(static_cast<std::size_t>(end - begin));
        for (int p = begin; p < end; ++p) {
            const int c = src_j[p];
            const double v = src_a[p];
            if (c < 0 || c >= ncols) {
                throw std::invalid_argument(
                    "SparseLinearSolver found out-of-range column index");
            }
            if (!std::isfinite(v)) {
                throw std::invalid_argument(
                    "SparseLinearSolver found non-finite matrix entry");
            }
            row_buf.emplace_back(c, v);
        }
        std::sort(row_buf.begin(), row_buf.end(),
                  [](const auto &lhs, const auto &rhs) { return lhs.first < rhs.first; });
        for (std::size_t k = 0; k < row_buf.size(); ++k) {
            if (k > 0 && row_buf[k].first == row_buf[k - 1].first) {
                vals.back() += row_buf[k].second;
            } else {
                cols.push_back(row_buf[k].first);
                vals.push_back(row_buf[k].second);
            }
        }
        if (cols.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            throw std::overflow_error("SparseLinearSolver CSR nnz exceeds 32-bit int");
        }
        row_offsets[static_cast<std::size_t>(r) + 1] = static_cast<int>(cols.size());
    }

    const std::size_t alloc_nnz = std::max<std::size_t>(1, cols.size());
    auto col_indices = std::make_unique<int[]>(alloc_nnz);
    auto values = std::make_unique<double[]>(alloc_nnz);
    if (!cols.empty()) {
        std::copy(cols.begin(), cols.end(), col_indices.get());
        std::copy(vals.begin(), vals.end(), values.get());
    } else {
        col_indices[0] = 0;
        values[0] = 0.0;
    }

    return mfem::SparseMatrix(
        row_offsets.release(),
        col_indices.release(),
        values.release(),
        nrows,
        ncols,
        true,
        true,
        true);
}

bool has_all_nonzero_diagonal(const mfem::SparseMatrix &matrix) noexcept
{
    const int n = matrix.Height();
    const int *row_ptr = matrix.HostReadI();
    const int *col_idx = matrix.HostReadJ();
    const double *data = matrix.HostReadData();
    if (row_ptr == nullptr || col_idx == nullptr || data == nullptr) {
        return false;
    }
    for (int i = 0; i < n; ++i) {
        bool found = false;
        for (int p = row_ptr[i]; p < row_ptr[i + 1]; ++p) {
            if (col_idx[p] == i) {
                if (std::abs(data[p]) > 0.0) {
                    found = true;
                }
                break;
            }
        }
        if (!found) {
            return false;
        }
    }
    return true;
}

// Compute residual r = b - A * x in extended precision (long double), along with
// ||r||_2 and ||b||_2. Returns false if solution contains non-finite entries.
bool compute_extended_residual(
    const mfem::SparseMatrix &matrix,
    const mfem::Vector &solution,
    const mfem::Vector &rhs,
    std::vector<double> *residual_out,
    long double &res_norm_out,
    long double &rhs_norm_out)
{
    const int nrows = matrix.Height();
    const int ncols = matrix.Width();
    if (nrows != rhs.Size() || ncols != solution.Size() || !matrix.Finalized()) {
        res_norm_out = std::numeric_limits<long double>::infinity();
        rhs_norm_out = 0.0L;
        return false;
    }

    const double *x_ptr = solution.HostRead();
    const double *b_ptr = rhs.HostRead();
    for (int j = 0; j < ncols; ++j) {
        if (!std::isfinite(x_ptr[j])) {
            res_norm_out = std::numeric_limits<long double>::infinity();
            rhs_norm_out = 0.0L;
            return false;
        }
    }

    const int *row_ptr = matrix.HostReadI();
    const int *col_idx = matrix.HostReadJ();
    const double *data = matrix.HostReadData();

    if (residual_out != nullptr) {
        residual_out->resize(static_cast<std::size_t>(nrows));
    }

    long double res_sq = 0.0L;
    long double rhs_sq = 0.0L;
    for (int i = 0; i < nrows; ++i) {
        long double ax_i = 0.0L;
        for (int p = row_ptr[i]; p < row_ptr[i + 1]; ++p) {
            ax_i += static_cast<long double>(data[p]) *
                    static_cast<long double>(x_ptr[col_idx[p]]);
        }
        const long double b_i = static_cast<long double>(b_ptr[i]);
        const long double r_i = b_i - ax_i;
        res_sq += r_i * r_i;
        rhs_sq += b_i * b_i;
        if (residual_out != nullptr) {
            (*residual_out)[static_cast<std::size_t>(i)] = static_cast<double>(r_i);
        }
    }
    res_norm_out = std::sqrt(res_sq);
    rhs_norm_out = std::sqrt(rhs_sq);
    return std::isfinite(static_cast<double>(res_norm_out));
}

double relative_residual_from_norms(
    long double res_norm,
    long double rhs_norm,
    double denominator_floor) noexcept
{
    if (!std::isfinite(static_cast<double>(res_norm))) {
        return std::numeric_limits<double>::infinity();
    }
    const long double floor_ld =
        (std::isfinite(denominator_floor) && denominator_floor >= 0.0)
            ? static_cast<long double>(denominator_floor)
            : 0.0L;
    const long double denom = std::max(floor_ld, rhs_norm);
    if (denom <= 0.0L) {
        return res_norm == 0.0L ? 0.0 : std::numeric_limits<double>::infinity();
    }
    return static_cast<double>(res_norm / denom);
}

bool residual_satisfies_tolerance(
    double rel_res,
    long double abs_res,
    const SparseSolveConfig &config) noexcept
{
    if (!std::isfinite(rel_res)) {
        return false;
    }
    if (rel_res <= config.relative_tolerance) {
        return true;
    }
    if (config.absolute_tolerance > 0.0 &&
        static_cast<double>(abs_res) <= config.absolute_tolerance) {
        return true;
    }
    return false;
}

// Strictly SPD diagonal preconditioner |A_{ii}|^{-1} (falling back to 1.0 on
// zero diagonals so MINRES/GMRES never divide by zero on saddle-point blocks).
class SafeAbsDiagPreconditioner final : public mfem::Solver {
public:
    explicit SafeAbsDiagPreconditioner(const mfem::SparseMatrix &matrix)
        : mfem::Solver(matrix.Height()), inv_diag_(static_cast<std::size_t>(matrix.Height()), 1.0)
    {
        const int n = matrix.Height();
        const int *row_ptr = matrix.HostReadI();
        const int *col_idx = matrix.HostReadJ();
        const double *data = matrix.HostReadData();
        for (int i = 0; i < n; ++i) {
            double diag = 0.0;
            for (int p = row_ptr[i]; p < row_ptr[i + 1]; ++p) {
                if (col_idx[p] == i) {
                    diag = std::abs(data[p]);
                    break;
                }
            }
            inv_diag_[static_cast<std::size_t>(i)] = (diag > 1.0e-30) ? (1.0 / diag) : 1.0;
        }
    }

    void SetOperator(const mfem::Operator &) override {}

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        const double *xp = x.HostRead();
        double *yp = y.HostWrite();
        for (int i = 0; i < height; ++i) {
            yp[i] = inv_diag_[static_cast<std::size_t>(i)] * xp[i];
        }
    }

private:
    std::vector<double> inv_diag_;
};

#if FULLMAG_MULTIPHYSICS_HAS_MPI
// Block-diagonal BoomerAMG preconditioner for coupled systems stored in
// mfem::Ordering::byNODES with `d` scalar components (e.g., 3 for spin, 4 for
// reciprocal charge+spin). Each diagonal block A_{cc} is an n x n scalar
// diffusion-reaction operator on H^1.
class BlockDiagonalBoomerAmgPreconditioner final : public mfem::Solver {
public:
    BlockDiagonalBoomerAmgPreconditioner(
        const mfem::SparseMatrix &matrix,
        int component_count)
        : mfem::Solver(matrix.Height()),
          component_count_(component_count),
          block_size_(matrix.Height() / component_count)
    {
        block_row_starts_[0] = 0;
        block_row_starts_[1] = static_cast<HYPRE_BigInt>(block_size_);

        const int *row_ptr = matrix.HostReadI();
        const int *col_idx = matrix.HostReadJ();
        const double *data = matrix.HostReadData();

        blocks_.reserve(static_cast<std::size_t>(component_count_));
        hypre_blocks_.reserve(static_cast<std::size_t>(component_count_));
        amgs_.reserve(static_cast<std::size_t>(component_count_));

        for (int c = 0; c < component_count_; ++c) {
            const int offset = c * block_size_;
            const int end_offset = offset + block_size_;

            auto bi = std::make_unique<int[]>(static_cast<std::size_t>(block_size_) + 1);
            std::vector<int> bj;
            std::vector<double> ba;
            bi[0] = 0;
            for (int local_r = 0; local_r < block_size_; ++local_r) {
                const int r = offset + local_r;
                bool has_diag = false;
                for (int p = row_ptr[r]; p < row_ptr[r + 1]; ++p) {
                    const int col = col_idx[p];
                    if (col >= offset && col < end_offset) {
                        const int local_c = col - offset;
                        bj.push_back(local_c);
                        ba.push_back(data[p]);
                        if (local_c == local_r && std::abs(data[p]) > 0.0) {
                            has_diag = true;
                        }
                    }
                }
                if (!has_diag) {
                    valid_ = false;
                    return;
                }
                bi[static_cast<std::size_t>(local_r) + 1] = static_cast<int>(bj.size());
            }

            const std::size_t alloc_nnz = std::max<std::size_t>(1, bj.size());
            auto bj_arr = std::make_unique<int[]>(alloc_nnz);
            auto ba_arr = std::make_unique<double[]>(alloc_nnz);
            if (!bj.empty()) {
                std::copy(bj.begin(), bj.end(), bj_arr.get());
                std::copy(ba.begin(), ba.end(), ba_arr.get());
            } else {
                bj_arr[0] = 0;
                ba_arr[0] = 0.0;
            }

            auto block_mat = std::make_unique<mfem::SparseMatrix>(
                bi.release(),
                bj_arr.release(),
                ba_arr.release(),
                block_size_,
                block_size_,
                true,
                true,
                true);
            block_mat->HostReadI();
            block_mat->HostReadJ();
            block_mat->HostReadData();

            auto hypre_block = std::make_unique<mfem::HypreParMatrix>(
                fullmag::fem::fullmag_serial_comm(),
                static_cast<HYPRE_BigInt>(block_size_),
                block_row_starts_,
                block_mat.get());
            auto amg = std::make_unique<mfem::HypreBoomerAMG>(*hypre_block);
            amg->SetPrintLevel(0);
            amg->SetMaxIter(1);
            amg->SetTol(0.0);

            blocks_.push_back(std::move(block_mat));
            hypre_blocks_.push_back(std::move(hypre_block));
            amgs_.push_back(std::move(amg));
        }
        valid_ = true;
    }

    bool valid() const noexcept { return valid_; }

    void SetOperator(const mfem::Operator &) override {}

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        const double *xp = x.HostRead();
        double *yp = y.HostWrite();
        mfem::HypreParVector b_c(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(block_size_),
            const_cast<HYPRE_BigInt *>(block_row_starts_));
        mfem::HypreParVector y_c(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(block_size_),
            const_cast<HYPRE_BigInt *>(block_row_starts_));

        for (int c = 0; c < component_count_; ++c) {
            const int offset = c * block_size_;
            double *bp = b_c.HostWrite();
            double *sp = y_c.HostWrite();
            for (int i = 0; i < block_size_; ++i) {
                bp[i] = xp[offset + i];
                sp[i] = 0.0;
            }
            amgs_[static_cast<std::size_t>(c)]->Mult(b_c, y_c);
            const double *out_p = y_c.HostRead();
            for (int i = 0; i < block_size_; ++i) {
                yp[offset + i] = out_p[i];
            }
        }
    }

private:
    int component_count_ = 1;
    int block_size_ = 0;
    HYPRE_BigInt block_row_starts_[2] = {0, 0};
    std::vector<std::unique_ptr<mfem::SparseMatrix>> blocks_;
    std::vector<std::unique_ptr<mfem::HypreParMatrix>> hypre_blocks_;
    std::vector<std::unique_ptr<mfem::HypreBoomerAMG>> amgs_;
    bool valid_ = false;
};
#endif // FULLMAG_MULTIPHYSICS_HAS_MPI

#if FULLMAG_MULTIPHYSICS_HAS_CUDSS
bool cuda_check(cudaError_t status, const char *what, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string("SparseLinearSolver cuDSS ") + what + " failed: " +
            cudaGetErrorString(status);
    return false;
}

bool cudss_check(cudssStatus_t status, const char *what, std::string &error)
{
    if (status == CUDSS_STATUS_SUCCESS) {
        return true;
    }
    error = std::string("SparseLinearSolver cuDSS ") + what +
            " failed with status " + std::to_string(static_cast<int>(status));
    return false;
}
#endif

} // namespace

struct SparseLinearSolver::Impl {
    enum class ActiveBackend {
        PetscDirect,
        HypreSpd,
        HypreNonsymmetric,
        HypreIndefinite,
        MfemSerial,
        GpuCudss,
    };

    SparseSolveConfig config;
    mfem::SparseMatrix matrix_copy;
    int n = 0;
    bool all_nonzero_diag = false;
    ActiveBackend backend = ActiveBackend::MfemSerial;
    std::string resolved_solver;
    double setup_ms = 0.0;
    mutable std::mutex solve_mutex;

#if FULLMAG_MULTIPHYSICS_HAS_PETSC
    bool petsc_registered = false;
    Mat petsc_mat = nullptr;
    KSP petsc_ksp = nullptr;
    Vec petsc_rhs = nullptr;
    Vec petsc_sol = nullptr;
#endif

#if FULLMAG_MULTIPHYSICS_HAS_MPI
    HYPRE_BigInt hypre_row_starts[2] = {0, 0};
    std::unique_ptr<mfem::HypreParMatrix> hypre_mat;
    std::unique_ptr<mfem::HypreBoomerAMG> hypre_amg;
    std::unique_ptr<mfem::HyprePCG> hypre_pcg;
    std::unique_ptr<BlockDiagonalBoomerAmgPreconditioner> block_amg;
#if defined(MFEM_HYPRE_VERSION) && MFEM_HYPRE_VERSION >= 21800
    mutable std::unique_ptr<mfem::HypreILU> hypre_ilu;
#endif
    mutable std::unique_ptr<mfem::HypreGMRES> hypre_gmres;
#endif

#if FULLMAG_MULTIPHYSICS_HAS_CUDSS
    cudssHandle_t cudss_handle = nullptr;
    cudssConfig_t cudss_config = nullptr;
    cudssData_t cudss_data = nullptr;
    cudssMatrix_t cudss_matrix = nullptr;
    cudssMatrix_t cudss_rhs = nullptr;
    cudssMatrix_t cudss_sol = nullptr;
    std::int32_t *d_offsets = nullptr;
    std::int32_t *d_columns = nullptr;
    double *d_values = nullptr;
    double *d_rhs = nullptr;
    double *d_sol = nullptr;
    double cudss_matrix_scale = 1.0;
#endif

    Impl(const mfem::SparseMatrix &source, const SparseSolveConfig &cfg)
        : config(cfg),
          matrix_copy(make_canonical_csr_copy(source)),
          n(matrix_copy.Height())
    {
        if (matrix_copy.Width() != n) {
            throw std::invalid_argument(
                "SparseLinearSolver requires a square sparse matrix");
        }
        // Settle host pointers before any concurrent const solve() calls.
        matrix_copy.HostReadI();
        matrix_copy.HostReadJ();
        matrix_copy.HostReadData();
        all_nonzero_diag = has_all_nonzero_diagonal(matrix_copy);

        const auto start = SteadyClock::now();
        if (config.execution_target == SparseExecutionTarget::GpuCudss) {
            init_gpu_cudss();
            setup_ms = elapsed_ms(start);
            return;
        }
        if (config.execution_target != SparseExecutionTarget::Cpu) {
            throw std::invalid_argument(
                "SparseLinearSolver received unsupported SparseExecutionTarget");
        }

        switch (config.cpu_backend) {
        case SparseCpuBackendPolicy::Auto: {
            std::string reason;
            if (try_init_petsc(reason)) {
                setup_ms = elapsed_ms(start);
                return;
            }
            if (try_init_hypre(reason)) {
                setup_ms = elapsed_ms(start);
                return;
            }
            init_mfem_serial();
            setup_ms = elapsed_ms(start);
            return;
        }
        case SparseCpuBackendPolicy::PetscMumps: {
            std::string reason;
            if (!try_init_petsc(reason)) {
                throw std::runtime_error(
                    "SparseLinearSolver explicit PetscMumps backend unavailable: " + reason);
            }
            setup_ms = elapsed_ms(start);
            return;
        }
        case SparseCpuBackendPolicy::Hypre: {
            std::string reason;
            if (!try_init_hypre(reason)) {
                throw std::runtime_error(
                    "SparseLinearSolver explicit Hypre backend unavailable: " + reason);
            }
            setup_ms = elapsed_ms(start);
            return;
        }
        case SparseCpuBackendPolicy::MfemSerial:
            init_mfem_serial();
            setup_ms = elapsed_ms(start);
            return;
        default:
            throw std::invalid_argument(
                "SparseLinearSolver received unsupported SparseCpuBackendPolicy");
        }
    }

    ~Impl()
    {
#if FULLMAG_MULTIPHYSICS_HAS_PETSC
        if (petsc_registered) {
            std::lock_guard<std::mutex> lock(
                fullmag::fem::runtime::petsc_slepc_process_mutex());
            PetscBool finalized = PETSC_FALSE;
            if (PetscFinalized(&finalized) == 0 && finalized == PETSC_FALSE) {
                destroy_petsc_objects_locked();
            } else {
                petsc_ksp = nullptr;
                petsc_rhs = nullptr;
                petsc_sol = nullptr;
                petsc_mat = nullptr;
            }
            fullmag::fem::runtime::unregister_petsc_slepc_live_cpu_graph_locked();
            petsc_registered = false;
        }
#endif
#if FULLMAG_MULTIPHYSICS_HAS_CUDSS
        destroy_cudss_objects();
#endif
    }

#if FULLMAG_MULTIPHYSICS_HAS_PETSC
    void destroy_petsc_objects_locked() noexcept
    {
        if (petsc_ksp != nullptr) {
            KSPDestroy(&petsc_ksp);
        }
        if (petsc_rhs != nullptr) {
            VecDestroy(&petsc_rhs);
        }
        if (petsc_sol != nullptr) {
            VecDestroy(&petsc_sol);
        }
        if (petsc_mat != nullptr) {
            MatDestroy(&petsc_mat);
        }
    }
#endif

#if FULLMAG_MULTIPHYSICS_HAS_CUDSS
    void destroy_cudss_objects() noexcept
    {
        if (cudss_data != nullptr && cudss_handle != nullptr) {
            cudssDataDestroy(cudss_handle, cudss_data);
            cudss_data = nullptr;
        }
        for (cudssMatrix_t *desc : {&cudss_matrix, &cudss_rhs, &cudss_sol}) {
            if (*desc != nullptr) {
                cudssMatrixDestroy(*desc);
                *desc = nullptr;
            }
        }
        if (cudss_config != nullptr) {
            cudssConfigDestroy(cudss_config);
            cudss_config = nullptr;
        }
        if (cudss_handle != nullptr) {
            cudssDestroy(cudss_handle);
            cudss_handle = nullptr;
        }
        if (d_offsets != nullptr) {
            cudaFree(d_offsets);
            d_offsets = nullptr;
        }
        if (d_columns != nullptr) {
            cudaFree(d_columns);
            d_columns = nullptr;
        }
        if (d_values != nullptr) {
            cudaFree(d_values);
            d_values = nullptr;
        }
        if (d_rhs != nullptr) {
            cudaFree(d_rhs);
            d_rhs = nullptr;
        }
        if (d_sol != nullptr) {
            cudaFree(d_sol);
            d_sol = nullptr;
        }
    }
#endif

    bool try_init_petsc(std::string &reason)
    {
#if FULLMAG_MULTIPHYSICS_HAS_PETSC
        std::lock_guard<std::mutex> lock(
            fullmag::fem::runtime::petsc_slepc_process_mutex());
        if (fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
            reason = "PETSc runtime is quarantined as unsafe";
            return false;
        }

        PetscBool finalized = PETSC_FALSE;
        if (PetscFinalized(&finalized) != 0 || finalized == PETSC_TRUE) {
            reason = "PETSc runtime is finalized and cannot be reinitialized";
            return false;
        }

        PetscBool initialized = PETSC_FALSE;
        if (PetscInitialized(&initialized) != 0) {
            reason = "PetscInitialized query failed";
            return false;
        }

        if (initialized == PETSC_FALSE) {
#if FULLMAG_MULTIPHYSICS_HAS_MPI
            int mpi_initialized = 0;
            MPI_Initialized(&mpi_initialized);
            if (mpi_initialized != 0) {
                int world_size = 1;
                MPI_Comm_size(MPI_COMM_WORLD, &world_size);
                if (world_size > 1) {
                    reason = "MPI_COMM_WORLD size > 1 and PETSc is not initialized "
                             "(refusing collective PetscInitializeNoArguments)";
                    return false;
                }
            } else {
                if (!can_initialize_openmpi_singleton()) {
                    reason = "OpenMPI singleton socket creation is unavailable";
                    return false;
                }
                fullmag::fem::ensure_mpi_initialized();
            }
#else
            if (!can_initialize_openmpi_singleton()) {
                reason = "OpenMPI singleton socket creation is unavailable";
                return false;
            }
#endif
            if (PetscInitializeNoArguments() != 0) {
                reason = "PetscInitializeNoArguments failed";
                return false;
            }
        }

        const int *row_ptr = matrix_copy.HostReadI();
        const int *col_idx = matrix_copy.HostReadJ();
        const double *data = matrix_copy.HostReadData();

        std::vector<PetscInt> nnz_per_row(static_cast<std::size_t>(n), 0);
        for (int i = 0; i < n; ++i) {
            nnz_per_row[static_cast<std::size_t>(i)] =
                static_cast<PetscInt>(row_ptr[i + 1] - row_ptr[i]);
        }

        PetscPushErrorHandler(PetscReturnErrorHandler, nullptr);
        bool ok = MatCreateSeqAIJ(
                      PETSC_COMM_SELF,
                      static_cast<PetscInt>(n),
                      static_cast<PetscInt>(n),
                      0,
                      nnz_per_row.data(),
                      &petsc_mat) == 0 &&
                  MatSetOption(petsc_mat, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_TRUE) == 0;

        std::vector<PetscInt> row_cols;
        std::vector<PetscScalar> row_vals;
        for (int i = 0; ok && i < n; ++i) {
            const int begin = row_ptr[i];
            const int end = row_ptr[i + 1];
            const int count = end - begin;
            if (count == 0) {
                continue;
            }
            row_cols.resize(static_cast<std::size_t>(count));
            row_vals.resize(static_cast<std::size_t>(count));
            for (int k = 0; k < count; ++k) {
                row_cols[static_cast<std::size_t>(k)] = static_cast<PetscInt>(col_idx[begin + k]);
                row_vals[static_cast<std::size_t>(k)] = static_cast<PetscScalar>(data[begin + k]);
            }
            const PetscInt row_i = static_cast<PetscInt>(i);
            ok = MatSetValues(
                     petsc_mat,
                     1,
                     &row_i,
                     static_cast<PetscInt>(count),
                     row_cols.data(),
                     row_vals.data(),
                     INSERT_VALUES) == 0;
        }
        if (ok) {
            ok = MatAssemblyBegin(petsc_mat, MAT_FINAL_ASSEMBLY) == 0 &&
                 MatAssemblyEnd(petsc_mat, MAT_FINAL_ASSEMBLY) == 0;
        }

        auto setup_ksp = [&](bool try_cholesky, std::string &solver_label) -> bool {
            if (petsc_ksp != nullptr) {
                KSPDestroy(&petsc_ksp);
            }
            PC pc = nullptr;
            bool step_ok =
                KSPCreate(PETSC_COMM_SELF, &petsc_ksp) == 0 &&
                KSPSetOperators(petsc_ksp, petsc_mat, petsc_mat) == 0 &&
                KSPSetType(petsc_ksp, KSPPREONLY) == 0 &&
                KSPGetPC(petsc_ksp, &pc) == 0;
            if (!step_ok) {
                return false;
            }
            if (try_cholesky) {
                MatSetOption(petsc_mat, MAT_SYMMETRIC, PETSC_TRUE);
                MatSetOption(petsc_mat, MAT_SPD, PETSC_TRUE);
                step_ok = PCSetType(pc, PCCHOLESKY) == 0;
            } else {
                MatSetOption(petsc_mat, MAT_SPD, PETSC_FALSE);
                step_ok = PCSetType(pc, PCLU) == 0;
            }
            if (!step_ok) {
                return false;
            }
#if defined(PETSC_HAVE_MUMPS)
            step_ok = PCFactorSetMatSolverType(pc, MATSOLVERMUMPS) == 0 &&
                      PCFactorSetUpMatSolverType(pc) == 0;
            Mat factor = nullptr;
            if (step_ok) {
                step_ok = PCFactorGetMatrix(pc, &factor) == 0;
            }
#if defined(PETSC_HAVE_METIS)
            if (step_ok) {
                step_ok = MatMumpsSetIcntl(factor, 7, 5) == 0;
            }
            solver_label = try_cholesky ? "petsc_mumps_cholesky_metis" : "petsc_mumps_lu_metis";
#else
            solver_label = try_cholesky ? "petsc_mumps_cholesky" : "petsc_mumps_lu";
#endif
            if (step_ok) {
                step_ok = MatMumpsSetIcntl(factor, 14, 50) == 0;
            }
#else
            solver_label = try_cholesky ? "petsc_default_cholesky" : "petsc_default_lu";
            if (!try_cholesky && config.kind != SparseMatrixKind::SymmetricIndefinite) {
                PCFactorSetShiftType(pc, MAT_SHIFT_NONZERO);
            }
#endif
            if (step_ok) {
                step_ok = KSPSetErrorIfNotConverged(petsc_ksp, PETSC_TRUE) == 0 &&
                          KSPSetUp(petsc_ksp) == 0;
            }
            return step_ok;
        };

        std::string label;
        bool factored = false;
        if (ok) {
            if (config.kind == SparseMatrixKind::Spd) {
                factored = setup_ksp(true, label);
                if (!factored) {
                    factored = setup_ksp(false, label);
                }
            } else {
                factored = setup_ksp(false, label);
            }
        }
        if (factored) {
            factored = VecCreateSeq(PETSC_COMM_SELF, static_cast<PetscInt>(n), &petsc_rhs) == 0 &&
                       VecCreateSeq(PETSC_COMM_SELF, static_cast<PetscInt>(n), &petsc_sol) == 0;
        }
        PetscPopErrorHandler();

        if (!factored) {
            destroy_petsc_objects_locked();
            reason = "PETSc/MUMPS factorization setup failed";
            return false;
        }

        fullmag::fem::runtime::register_petsc_slepc_live_cpu_graph_locked();
        petsc_registered = true;
        backend = ActiveBackend::PetscDirect;
        resolved_solver = std::move(label);
        return true;
#else
        reason = "PETSc/MUMPS is not enabled in this build (FULLMAG_FEM_WITH_SLEPC=0 or MPI disabled)";
        return false;
#endif
    }

    bool try_init_hypre(std::string &reason)
    {
#if FULLMAG_MULTIPHYSICS_HAS_MPI
        if (!can_initialize_openmpi_singleton()) {
            reason = "OpenMPI singleton socket creation is unavailable";
            return false;
        }
        std::string policy_error;
        if (!fullmag::fem::configure_hypre_host_policy(policy_error)) {
            reason = policy_error;
            return false;
        }
        const auto snapshot = fullmag::fem::current_hypre_host_policy();
        if (!snapshot.memory_location_host || !snapshot.execution_policy_host) {
            reason = std::string("HYPRE runtime is bound to device policy (memory=") +
                     fullmag::fem::hypre_memory_location_name(snapshot) +
                     ", exec=" + fullmag::fem::hypre_execution_policy_name(snapshot) + ")";
            return false;
        }

        fullmag::fem::ensure_mpi_initialized();
        hypre_row_starts[0] = 0;
        hypre_row_starts[1] = static_cast<HYPRE_BigInt>(n);
        hypre_mat = std::make_unique<mfem::HypreParMatrix>(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(n),
            hypre_row_starts,
            &matrix_copy);

        const double internal_rtol = std::max(1.0e-15, 0.1 * config.relative_tolerance);
        const double internal_atol =
            config.absolute_tolerance > 0.0 ? 0.1 * config.absolute_tolerance : 0.0;

        if (config.kind == SparseMatrixKind::Spd) {
            hypre_amg = std::make_unique<mfem::HypreBoomerAMG>(*hypre_mat);
            hypre_amg->SetPrintLevel(0);

            hypre_pcg = std::make_unique<mfem::HyprePCG>(fullmag::fem::fullmag_serial_comm());
            hypre_pcg->iterative_mode = false;
            hypre_pcg->SetTol(internal_rtol);
            if (internal_atol > 0.0) {
                hypre_pcg->SetAbsTol(internal_atol);
            }
            hypre_pcg->SetMaxIter(config.maximum_iterations);
            hypre_pcg->SetPrintLevel(0);
            hypre_pcg->SetOperator(*hypre_mat);
            hypre_pcg->SetPreconditioner(*hypre_amg);

            backend = ActiveBackend::HypreSpd;
            resolved_solver = "hypre_boomeramg_pcg";
            return true;
        }

        if (config.kind == SparseMatrixKind::GeneralNonsymmetric) {
            if (config.by_nodes_component_count >= 1 &&
                n % config.by_nodes_component_count == 0) {
                auto candidate = std::make_unique<BlockDiagonalBoomerAmgPreconditioner>(
                    matrix_copy, config.by_nodes_component_count);
                if (candidate->valid()) {
                    block_amg = std::move(candidate);
                }
            }
            backend = ActiveBackend::HypreNonsymmetric;
            resolved_solver =
                block_amg != nullptr ? "hypre_block_amg_gmres" : "hypre_ilu_gmres";
            return true;
        }

        // SymmetricIndefinite on Tier 2 (physics-specific AMS/Schur solvers live
        // in OE-F2 and OE-T0; here we provide a zero-diagonal-safe MINRES +
        // optional ILU escalation).
        backend = ActiveBackend::HypreIndefinite;
        resolved_solver = "hypre_minres_absdiag";
        return true;
#else
        reason = "HYPRE/MPI is not enabled in this build (MFEM_USE_MPI off or FULLMAG_OET0_DISABLE_MPI=1)";
        return false;
#endif
    }

    void init_mfem_serial()
    {
        backend = ActiveBackend::MfemSerial;
        switch (config.kind) {
        case SparseMatrixKind::Spd:
            resolved_solver = all_nonzero_diag ? "mfem_gs_pcg" : "mfem_absdiag_pcg";
            break;
        case SparseMatrixKind::GeneralNonsymmetric:
            resolved_solver = all_nonzero_diag ? "mfem_gs_gmres" : "mfem_absdiag_gmres";
            break;
        case SparseMatrixKind::SymmetricIndefinite:
            resolved_solver = "mfem_absdiag_minres";
            break;
        }
    }

    void init_gpu_cudss()
    {
#if FULLMAG_MULTIPHYSICS_HAS_CUDSS
        const char *bytes_cap = std::getenv(fullmag::fem::kDemagCudssDeviceBudgetCapEnv);
        const char *mib_cap = std::getenv(fullmag::fem::kDemagCudssMaxVramMibEnv);
        fullmag::fem::GpuDemagCudssDeviceBudget syntax_budget{};
        std::string err;
        if (!fullmag::fem::resolve_demag_cudss_device_budget(
                0, 0, bytes_cap, mib_cap, syntax_budget, err)) {
            throw std::runtime_error(err);
        }

        const bool lower_only = config.kind == SparseMatrixKind::Spd;
        const int *row_ptr = matrix_copy.HostReadI();
        const int *col_idx = matrix_copy.HostReadJ();
        const double *data = matrix_copy.HostReadData();

        std::vector<std::int32_t> offsets(static_cast<std::size_t>(n) + 1, 0);
        std::vector<std::int32_t> columns;
        std::vector<double> values;
        columns.reserve(static_cast<std::size_t>(row_ptr[n]));
        values.reserve(static_cast<std::size_t>(row_ptr[n]));

        for (int i = 0; i < n; ++i) {
            bool has_pos_diag = false;
            for (int p = row_ptr[i]; p < row_ptr[i + 1]; ++p) {
                const int j = col_idx[p];
                if (lower_only && j > i) {
                    continue;
                }
                columns.push_back(static_cast<std::int32_t>(j));
                values.push_back(data[p]);
                if (j == i && data[p] > 0.0) {
                    has_pos_diag = true;
                }
            }
            if (config.kind == SparseMatrixKind::Spd && !has_pos_diag) {
                throw std::runtime_error(
                    "SparseLinearSolver cuDSS SPD requires a positive diagonal entry in row " +
                    std::to_string(i));
            }
            if (columns.size() > static_cast<std::size_t>(std::numeric_limits<std::int32_t>::max())) {
                throw std::overflow_error(
                    "SparseLinearSolver cuDSS CSR nnz exceeds 32-bit int");
            }
            offsets[static_cast<std::size_t>(i) + 1] = static_cast<std::int32_t>(columns.size());
        }

        const std::int64_t nnz = static_cast<std::int64_t>(columns.size());
        const std::size_t alloc_nnz = std::max<std::size_t>(1, columns.size());

        // Scalar-normalize uploaded CSR entries by max |A_ij| so extreme physical
        // scales (e.g., 1e+14 or 1e-21 in nanometer domains) remain well-scaled
        // for cuDSS pivot selection; solve_gpu_cudss divides RHS by the same scalar.
        double max_abs_value = 0.0;
        for (double v : values) {
            max_abs_value = std::max(max_abs_value, std::abs(v));
        }
        cudss_matrix_scale =
            (std::isfinite(max_abs_value) && max_abs_value > 0.0) ? max_abs_value : 1.0;
        if (cudss_matrix_scale != 1.0) {
            const double inv_scale = 1.0 / cudss_matrix_scale;
            for (double &v : values) {
                v *= inv_scale;
            }
        }

        auto fail = [&](const std::string &message) {
            destroy_cudss_objects();
            throw std::runtime_error(message);
        };

        if (!cuda_check(cudaDeviceSynchronize(), "pre-setup synchronize", err) ||
            !cuda_check(cudaMalloc(reinterpret_cast<void **>(&d_offsets),
                                   offsets.size() * sizeof(std::int32_t)),
                        "offsets allocation", err) ||
            !cuda_check(cudaMalloc(reinterpret_cast<void **>(&d_columns),
                                   alloc_nnz * sizeof(std::int32_t)),
                        "columns allocation", err) ||
            !cuda_check(cudaMalloc(reinterpret_cast<void **>(&d_values),
                                   alloc_nnz * sizeof(double)),
                        "values allocation", err) ||
            !cuda_check(cudaMalloc(reinterpret_cast<void **>(&d_rhs),
                                   static_cast<std::size_t>(n) * sizeof(double)),
                        "rhs allocation", err) ||
            !cuda_check(cudaMalloc(reinterpret_cast<void **>(&d_sol),
                                   static_cast<std::size_t>(n) * sizeof(double)),
                        "solution allocation", err) ||
            !cuda_check(cudaMemcpy(d_offsets, offsets.data(),
                                   offsets.size() * sizeof(std::int32_t),
                                   cudaMemcpyHostToDevice),
                        "offsets upload", err) ||
            (nnz > 0 &&
             !cuda_check(cudaMemcpy(d_columns, columns.data(),
                                    static_cast<std::size_t>(nnz) * sizeof(std::int32_t),
                                    cudaMemcpyHostToDevice),
                         "columns upload", err)) ||
            (nnz > 0 &&
             !cuda_check(cudaMemcpy(d_values, values.data(),
                                    static_cast<std::size_t>(nnz) * sizeof(double),
                                    cudaMemcpyHostToDevice),
                         "values upload", err)) ||
            !cuda_check(cudaMemset(d_rhs, 0, static_cast<std::size_t>(n) * sizeof(double)),
                        "rhs clear", err) ||
            !cuda_check(cudaMemset(d_sol, 0, static_cast<std::size_t>(n) * sizeof(double)),
                        "solution clear", err)) {
            fail(err);
        }

        cudssMatrixType_t mtype = CUDSS_MTYPE_SPD;
        cudssMatrixViewType_t mview = CUDSS_MVIEW_LOWER;
        std::string label = "cuda_cudss_spd";
        if (config.kind == SparseMatrixKind::SymmetricIndefinite) {
            // Route saddle-point matrices (which have structural zeros on the
            // bottom-right diagonal) through full-CSR LU with pivoting, matching
            // Tier-1 PETSc/MUMPS PCLU and avoiding symmetric zero-pivot failures.
            mtype = CUDSS_MTYPE_GENERAL;
            mview = CUDSS_MVIEW_FULL;
            label = "cuda_cudss_sym_lu";
        } else if (config.kind == SparseMatrixKind::GeneralNonsymmetric) {
            mtype = CUDSS_MTYPE_GENERAL;
            mview = CUDSS_MVIEW_FULL;
            label = "cuda_cudss_lu";
        }

        if (!cudss_check(cudssCreate(&cudss_handle), "handle creation", err) ||
            !cudss_check(cudssConfigCreate(&cudss_config), "config creation", err) ||
            !cudss_check(cudssDataCreate(cudss_handle, &cudss_data), "data creation", err)) {
            fail(err);
        }

        if (config.kind == SparseMatrixKind::SymmetricIndefinite ||
            config.kind == SparseMatrixKind::GeneralNonsymmetric) {
            // Configure scaled pivot epsilon and device iterative refinement so
            // zero-diagonal saddle-point and nonsymmetric matrices solve to full
            // FP64 precision under cuDSS 0.8 static pivoting.
            const auto pivot_eps_alg = CUDSS_PIVOT_EPSILON_ALG_SCALED;
            const int ir_n_steps = 5;
            const double ir_tol = 1.0e-15;
            if (!cudss_check(
                    cudssConfigSet(
                        cudss_config, CUDSS_CONFIG_PIVOT_EPSILON_ALG,
                        &pivot_eps_alg, sizeof(pivot_eps_alg)),
                    "pivot epsilon algorithm configuration", err) ||
                !cudss_check(
                    cudssConfigSet(
                        cudss_config, CUDSS_CONFIG_IR_N_STEPS,
                        &ir_n_steps, sizeof(ir_n_steps)),
                    "iterative refinement step configuration", err) ||
                !cudss_check(
                    cudssConfigSet(
                        cudss_config, CUDSS_CONFIG_IR_TOL,
                        &ir_tol, sizeof(ir_tol)),
                    "iterative refinement tolerance configuration", err)) {
                fail(err);
            }
        }

        if (!cudss_check(cudssMatrixCreateCsr(
                             &cudss_matrix,
                             static_cast<std::int64_t>(n),
                             static_cast<std::int64_t>(n),
                             nnz,
                             d_offsets,
                             nullptr,
                             d_columns,
                             d_values,
                             CUDSS_R_32I,
                             CUDSS_R_32I,
                             CUDSS_R_64F,
                             mtype,
                             mview,
                             CUDSS_BASE_ZERO),
                         "matrix descriptor", err) ||
            !cudss_check(cudssMatrixCreateDn(
                             &cudss_rhs,
                             static_cast<std::int64_t>(n),
                             1,
                             static_cast<std::int64_t>(n),
                             d_rhs,
                             CUDSS_R_64F,
                             CUDSS_LAYOUT_COL_MAJOR),
                         "rhs descriptor", err) ||
            !cudss_check(cudssMatrixCreateDn(
                             &cudss_sol,
                             static_cast<std::int64_t>(n),
                             1,
                             static_cast<std::int64_t>(n),
                             d_sol,
                             CUDSS_R_64F,
                             CUDSS_LAYOUT_COL_MAJOR),
                         "solution descriptor", err)) {
            fail(err);
        }

        if (!cudss_check(cudssExecute(cudss_handle, CUDSS_PHASE_ANALYSIS, cudss_config,
                                      cudss_data, cudss_matrix, cudss_sol, cudss_rhs),
                         "analysis", err) ||
            !cuda_check(cudaDeviceSynchronize(), "analysis synchronize", err)) {
            fail(err);
        }

        std::size_t written = 0;
        std::int64_t memory_estimates[16] = {0};
        if (!cudss_check(cudssDataGet(cudss_handle, cudss_data, CUDSS_DATA_MEMORY_ESTIMATES,
                                      memory_estimates, sizeof(memory_estimates), &written),
                         "memory estimate query", err)) {
            fail(err);
        }
        const std::int64_t estimated_peak_bytes = memory_estimates[1];
        std::int64_t estimated_factor_nnz = -1;
        if (cudssDataGet(cudss_handle, cudss_data, CUDSS_DATA_LU_NNZ,
                         &estimated_factor_nnz, sizeof(estimated_factor_nnz),
                         &written) != CUDSS_STATUS_SUCCESS) {
            estimated_factor_nnz = -1;
        }

        std::size_t free_after_analysis = 0;
        std::size_t total_bytes = 0;
        fullmag::fem::GpuDemagCudssDeviceBudget budget{};
        if (!cuda_check(cudaMemGetInfo(&free_after_analysis, &total_bytes),
                        "memory query", err) ||
            !fullmag::fem::resolve_demag_cudss_device_budget(
                static_cast<std::uint64_t>(free_after_analysis),
                static_cast<std::uint64_t>(total_bytes),
                bytes_cap,
                mib_cap,
                budget,
                err) ||
            !fullmag::fem::check_demag_cudss_factor_fits(
                estimated_peak_bytes,
                budget,
                static_cast<std::int64_t>(n),
                estimated_factor_nnz,
                err)) {
            fail(err);
        }

        if (!cudss_check(cudssExecute(cudss_handle, CUDSS_PHASE_FACTORIZATION, cudss_config,
                                      cudss_data, cudss_matrix, cudss_sol, cudss_rhs),
                         "factorization", err) ||
            !cuda_check(cudaDeviceSynchronize(), "factorization synchronize", err)) {
            fail(err);
        }

        int info = -1;
        if (!cudss_check(cudssDataGet(cudss_handle, cudss_data, CUDSS_DATA_INFO,
                                      &info, sizeof(info), &written),
                         "factorization info query", err)) {
            fail(err);
        }
        if (info != 0) {
            fail("SparseLinearSolver cuDSS factorization reported CUDSS_DATA_INFO=" +
                 std::to_string(info) + " (singular or incompatible matrix; no CPU fallback)");
        }

        std::int64_t npivots_raw = 0;
        std::size_t npivots_written = 0;
        if (cudssDataGet(cudss_handle, cudss_data, CUDSS_DATA_NPIVOTS,
                         &npivots_raw, sizeof(npivots_raw), &npivots_written) ==
            CUDSS_STATUS_SUCCESS) {
            std::int64_t npivots = 0;
            if (npivots_written == sizeof(std::int32_t)) {
                std::int32_t np32 = 0;
                std::memcpy(&np32, &npivots_raw, sizeof(np32));
                npivots = static_cast<std::int64_t>(np32);
            } else {
                npivots = npivots_raw;
            }
            if (npivots > 0) {
                // Static pivoting perturbed diagonal entries (expected on zero-diagonal
                // saddle-point matrices, but also produced for genuinely singular matrices
                // under CUDSS_MTYPE_GENERAL). Run one deterministic probe solve and verify
                // the independent unpreconditioned residual against the original CSR matrix.
                mfem::Vector probe_rhs(n);
                std::vector<double> scaled_probe_rhs(static_cast<std::size_t>(n), 0.0);
                const double inv_scale = 1.0 / cudss_matrix_scale;
                for (int i = 0; i < n; ++i) {
                    const double v = std::sin(0.73 * static_cast<double>(i + 1));
                    probe_rhs[i] = v;
                    scaled_probe_rhs[static_cast<std::size_t>(i)] = v * inv_scale;
                }
                mfem::Vector probe_sol(n);
                if (!cuda_check(cudaMemcpy(d_rhs, scaled_probe_rhs.data(),
                                           static_cast<std::size_t>(n) * sizeof(double),
                                           cudaMemcpyHostToDevice),
                                "probe rhs upload", err) ||
                    !cudss_check(cudssMatrixSetValues(cudss_rhs, d_rhs),
                                 "probe rhs binding", err) ||
                    !cudss_check(cudssMatrixSetValues(cudss_sol, d_sol),
                                 "probe solution binding", err) ||
                    !cudss_check(cudssExecute(cudss_handle, CUDSS_PHASE_SOLVE, cudss_config,
                                              cudss_data, cudss_matrix, cudss_sol, cudss_rhs),
                                 "probe solve", err) ||
                    !cuda_check(cudaDeviceSynchronize(), "probe solve synchronize", err) ||
                    !cuda_check(cudaMemcpy(probe_sol.HostWrite(), d_sol,
                                           static_cast<std::size_t>(n) * sizeof(double),
                                           cudaMemcpyDeviceToHost),
                                "probe solution download", err)) {
                    fail(err);
                }
                long double probe_res = 0.0L;
                long double probe_rhs_norm = 0.0L;
                const bool probe_ok = compute_extended_residual(
                    matrix_copy, probe_sol, probe_rhs, nullptr, probe_res, probe_rhs_norm);
                const double probe_rel =
                    probe_ok ? relative_residual_from_norms(probe_res, probe_rhs_norm, 0.0)
                             : std::numeric_limits<double>::infinity();
                if (!std::isfinite(probe_rel) || probe_rel > 1.0e-6) {
                    fail("SparseLinearSolver cuDSS factorization detected singular or "
                         "numerically unstable matrix after " + std::to_string(npivots) +
                         " perturbed pivots (probe relative residual=" +
                         std::to_string(probe_rel) + "; no CPU fallback)");
                }
            }
        }

        backend = ActiveBackend::GpuCudss;
        resolved_solver = std::move(label);
#else
        throw std::runtime_error(
            "SparseLinearSolver GpuCudss requires a FEM GPU build with cuDSS and CUDA runtime "
            "(no silent CPU fallback)");
#endif
    }

    SparseSolveStats solve_petsc(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        SteadyClock::time_point start) const
    {
        SparseSolveStats stats{};
        stats.resolved_solver = resolved_solver;
        stats.setup_ms = setup_ms;
#if FULLMAG_MULTIPHYSICS_HAS_PETSC
        std::lock_guard<std::mutex> lock(
            fullmag::fem::runtime::petsc_slepc_process_mutex());
        if (fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
            throw std::runtime_error("PETSc runtime is quarantined as unsafe during solve");
        }
        PetscBool finalized = PETSC_FALSE;
        if (PetscFinalized(&finalized) != 0 || finalized == PETSC_TRUE) {
            throw std::runtime_error("PETSc runtime was finalized before solve");
        }

        auto run_single_solve = [&](const double *rhs_data, double *sol_data) -> bool {
            PetscScalar *petsc_b = nullptr;
            if (VecGetArray(petsc_rhs, &petsc_b) != 0) {
                return false;
            }
            for (int i = 0; i < n; ++i) {
                petsc_b[i] = static_cast<PetscScalar>(rhs_data[i]);
            }
            if (VecRestoreArray(petsc_rhs, &petsc_b) != 0) {
                return false;
            }
            if (KSPSolve(petsc_ksp, petsc_rhs, petsc_sol) != 0) {
                return false;
            }
            const PetscScalar *petsc_x = nullptr;
            if (VecGetArrayRead(petsc_sol, &petsc_x) != 0) {
                return false;
            }
            for (int i = 0; i < n; ++i) {
                sol_data[i] = static_cast<double>(PetscRealPart(petsc_x[i]));
            }
            if (VecRestoreArrayRead(petsc_sol, &petsc_x) != 0) {
                return false;
            }
            return true;
        };

        PetscPushErrorHandler(PetscReturnErrorHandler, nullptr);
        const bool ok = run_single_solve(rhs.HostRead(), solution.HostWrite());
        if (!ok) {
            PetscPopErrorHandler();
            stats.converged = false;
            stats.iterations = 1;
            stats.solve_ms = elapsed_ms(start);
            return stats;
        }

        std::vector<double> residual_vec;
        long double res_norm = 0.0L;
        long double rhs_norm = 0.0L;
        compute_extended_residual(matrix_copy, solution, rhs, &residual_vec, res_norm, rhs_norm);
        double rel_res = relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);

        std::vector<double> correction(static_cast<std::size_t>(n), 0.0);
        mfem::Vector candidate(n);
        int sweeps = 0;
        while (sweeps < config.max_refinement_sweeps &&
               !residual_satisfies_tolerance(rel_res, res_norm, config)) {
            if (!run_single_solve(residual_vec.data(), correction.data())) {
                break;
            }
            const double *cur = solution.HostRead();
            double *cand = candidate.HostWrite();
            for (int i = 0; i < n; ++i) {
                cand[i] = cur[i] + correction[static_cast<std::size_t>(i)];
            }
            std::vector<double> next_residual;
            long double next_res_norm = 0.0L;
            long double next_rhs_norm = 0.0L;
            if (!compute_extended_residual(
                    matrix_copy, candidate, rhs, &next_residual, next_res_norm, next_rhs_norm)) {
                break;
            }
            const double next_rel =
                relative_residual_from_norms(next_res_norm, next_rhs_norm, denominator_floor);
            if (next_rel < rel_res) {
                solution = candidate;
                residual_vec = std::move(next_residual);
                res_norm = next_res_norm;
                rel_res = next_rel;
                ++sweeps;
            } else {
                break;
            }
        }
        PetscPopErrorHandler();

        stats.iterations = 1 + sweeps;
        stats.refinement_sweeps = sweeps;
        stats.independent_relative_residual = rel_res;
        stats.converged = residual_satisfies_tolerance(rel_res, res_norm, config);
        stats.solve_ms = elapsed_ms(start);
        return stats;
#else
        (void)rhs;
        (void)solution;
        (void)denominator_floor;
        (void)start;
        throw std::logic_error("solve_petsc called without PETSc support");
#endif
    }

    SparseSolveStats solve_hypre_spd(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        SteadyClock::time_point start) const
    {
        SparseSolveStats stats{};
        stats.resolved_solver = resolved_solver;
        stats.setup_ms = setup_ms;
#if FULLMAG_MULTIPHYSICS_HAS_MPI
        std::lock_guard<std::mutex> lock(solve_mutex);
        mfem::HypreParVector b_par(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(n),
            const_cast<HYPRE_BigInt *>(hypre_row_starts));
        mfem::HypreParVector x_par(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(n),
            const_cast<HYPRE_BigInt *>(hypre_row_starts));
        const double *rhs_host = rhs.HostRead();
        double *b_host = b_par.HostWrite();
        double *x_host = x_par.HostWrite();
        for (int i = 0; i < n; ++i) {
            b_host[i] = rhs_host[i];
            x_host[i] = 0.0;
        }
        hypre_pcg->Mult(b_par, x_par);
        int iterations = 0;
        hypre_pcg->GetNumIterations(iterations);
        const double *solved_host = x_par.HostRead();
        double *sol_host = solution.HostWrite();
        for (int i = 0; i < n; ++i) {
            sol_host[i] = solved_host[i];
        }

        long double res_norm = 0.0L;
        long double rhs_norm = 0.0L;
        compute_extended_residual(matrix_copy, solution, rhs, nullptr, res_norm, rhs_norm);
        const double rel_res =
            relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);

        stats.iterations = iterations;
        stats.independent_relative_residual = rel_res;
        stats.converged = residual_satisfies_tolerance(rel_res, res_norm, config);
        stats.solve_ms = elapsed_ms(start);
        return stats;
#else
        (void)rhs;
        (void)solution;
        (void)denominator_floor;
        (void)start;
        throw std::logic_error("solve_hypre_spd called without MPI/HYPRE");
#endif
    }

#if FULLMAG_MULTIPHYSICS_HAS_MPI
    bool try_hypre_ilu_gmres_locked(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        int &iterations_out,
        double &rel_res_out,
        long double &abs_res_out) const
    {
#if defined(MFEM_HYPRE_VERSION) && MFEM_HYPRE_VERSION >= 21800
        if (!all_nonzero_diag) {
            return false;
        }
        const double internal_rtol = std::max(1.0e-15, 0.1 * config.relative_tolerance);
        const double internal_atol =
            config.absolute_tolerance > 0.0 ? 0.1 * config.absolute_tolerance : 0.0;
        if (hypre_ilu == nullptr) {
            hypre_ilu = std::make_unique<mfem::HypreILU>();
            hypre_ilu->SetType(0);
            hypre_ilu->SetLevelOfFill(1);
            hypre_ilu->SetPrintLevel(0);
            hypre_ilu->SetOperator(*hypre_mat);

            hypre_gmres = std::make_unique<mfem::HypreGMRES>(fullmag::fem::fullmag_serial_comm());
            hypre_gmres->iterative_mode = false;
            hypre_gmres->SetTol(internal_rtol);
            if (internal_atol > 0.0) {
                hypre_gmres->SetAbsTol(internal_atol);
            }
            hypre_gmres->SetMaxIter(config.maximum_iterations);
            hypre_gmres->SetKDim(config.gmres_kdim);
            hypre_gmres->SetPrintLevel(0);
            hypre_gmres->SetOperator(*hypre_mat);
            hypre_gmres->SetPreconditioner(*hypre_ilu);
        }

        mfem::HypreParVector b_par(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(n),
            const_cast<HYPRE_BigInt *>(hypre_row_starts));
        mfem::HypreParVector x_par(
            fullmag::fem::fullmag_serial_comm(),
            static_cast<HYPRE_BigInt>(n),
            const_cast<HYPRE_BigInt *>(hypre_row_starts));
        const double *rhs_host = rhs.HostRead();
        double *b_host = b_par.HostWrite();
        double *x_host = x_par.HostWrite();
        for (int i = 0; i < n; ++i) {
            b_host[i] = rhs_host[i];
            x_host[i] = 0.0;
        }
        hypre_gmres->Mult(b_par, x_par);
        int iterations = 0;
        hypre_gmres->GetNumIterations(iterations);
        const double *solved_host = x_par.HostRead();
        double *sol_host = solution.HostWrite();
        for (int i = 0; i < n; ++i) {
            sol_host[i] = solved_host[i];
        }

        long double res_norm = 0.0L;
        long double rhs_norm = 0.0L;
        compute_extended_residual(matrix_copy, solution, rhs, nullptr, res_norm, rhs_norm);
        iterations_out = iterations;
        abs_res_out = res_norm;
        rel_res_out = relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);
        return true;
#else
        (void)rhs;
        (void)solution;
        (void)denominator_floor;
        (void)iterations_out;
        (void)rel_res_out;
        (void)abs_res_out;
        return false;
#endif
    }
#endif

    SparseSolveStats solve_hypre_nonsymmetric(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        SteadyClock::time_point start) const
    {
        SparseSolveStats stats{};
        stats.resolved_solver = resolved_solver;
        stats.setup_ms = setup_ms;
#if FULLMAG_MULTIPHYSICS_HAS_MPI
        std::lock_guard<std::mutex> lock(solve_mutex);
        const double internal_rtol = std::max(1.0e-15, 0.1 * config.relative_tolerance);
        const double internal_atol =
            config.absolute_tolerance > 0.0 ? 0.1 * config.absolute_tolerance : 0.0;

        double best_rel = std::numeric_limits<double>::infinity();
        long double best_abs = std::numeric_limits<long double>::infinity();
        int best_iters = 0;
        std::string used_solver = resolved_solver;

        if (block_amg != nullptr) {
            mfem::GMRESSolver gmres;
            gmres.SetKDim(config.gmres_kdim);
            gmres.SetRelTol(internal_rtol);
            gmres.SetAbsTol(internal_atol);
            gmres.SetMaxIter(config.maximum_iterations);
            gmres.SetPrintLevel(0);
            gmres.SetOperator(matrix_copy);
            gmres.SetPreconditioner(*block_amg);
            solution = 0.0;
            gmres.Mult(rhs, solution);

            long double res_norm = 0.0L;
            long double rhs_norm = 0.0L;
            compute_extended_residual(matrix_copy, solution, rhs, nullptr, res_norm, rhs_norm);
            best_abs = res_norm;
            best_rel = relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);
            best_iters = gmres.GetNumIterations();
            used_solver = "hypre_block_amg_gmres";

            if (residual_satisfies_tolerance(best_rel, best_abs, config)) {
                stats.converged = true;
                stats.iterations = best_iters;
                stats.independent_relative_residual = best_rel;
                stats.resolved_solver = used_solver;
                stats.solve_ms = elapsed_ms(start);
                return stats;
            }
        }

        // Deterministic escalation within Tier 2 to HypreILU(1) + HypreGMRES.
        mfem::Vector ilu_sol(n);
        ilu_sol = 0.0;
        int ilu_iters = 0;
        double ilu_rel = std::numeric_limits<double>::infinity();
        long double ilu_abs = std::numeric_limits<long double>::infinity();
        if (try_hypre_ilu_gmres_locked(
                rhs, ilu_sol, denominator_floor, ilu_iters, ilu_rel, ilu_abs) &&
            ilu_rel < best_rel) {
            solution = ilu_sol;
            best_rel = ilu_rel;
            best_abs = ilu_abs;
            best_iters = ilu_iters;
            used_solver = "hypre_ilu_gmres";
        }

        stats.converged = residual_satisfies_tolerance(best_rel, best_abs, config);
        stats.iterations = best_iters;
        stats.independent_relative_residual = best_rel;
        stats.resolved_solver = used_solver;
        stats.solve_ms = elapsed_ms(start);
        return stats;
#else
        (void)rhs;
        (void)solution;
        (void)denominator_floor;
        (void)start;
        throw std::logic_error("solve_hypre_nonsymmetric called without MPI/HYPRE");
#endif
    }

    SparseSolveStats solve_hypre_indefinite(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        SteadyClock::time_point start) const
    {
        SparseSolveStats stats = solve_mfem_serial(rhs, solution, denominator_floor, start);
        stats.resolved_solver = "hypre_minres_absdiag";
#if FULLMAG_MULTIPHYSICS_HAS_MPI
        if (!stats.converged && all_nonzero_diag) {
            std::lock_guard<std::mutex> lock(solve_mutex);
            mfem::Vector ilu_sol(n);
            ilu_sol = 0.0;
            int ilu_iters = 0;
            double ilu_rel = std::numeric_limits<double>::infinity();
            long double ilu_abs = std::numeric_limits<long double>::infinity();
            if (try_hypre_ilu_gmres_locked(
                    rhs, ilu_sol, denominator_floor, ilu_iters, ilu_rel, ilu_abs) &&
                ilu_rel < stats.independent_relative_residual) {
                solution = ilu_sol;
                stats.iterations = ilu_iters;
                stats.independent_relative_residual = ilu_rel;
                stats.converged = residual_satisfies_tolerance(ilu_rel, ilu_abs, config);
                stats.resolved_solver = "hypre_ilu_gmres";
            }
        }
#endif
        stats.solve_ms = elapsed_ms(start);
        return stats;
    }

    SparseSolveStats solve_mfem_serial(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        SteadyClock::time_point start) const
    {
        SparseSolveStats stats{};
        stats.resolved_solver = resolved_solver;
        stats.setup_ms = setup_ms;

        const double internal_rtol = std::max(1.0e-15, 0.1 * config.relative_tolerance);
        const double internal_atol =
            config.absolute_tolerance > 0.0 ? 0.1 * config.absolute_tolerance : 0.0;
        solution = 0.0;

        int iterations = 0;
        if (config.kind == SparseMatrixKind::Spd) {
            mfem::CGSolver cg;
            cg.SetRelTol(internal_rtol);
            cg.SetAbsTol(internal_atol);
            cg.SetMaxIter(config.maximum_iterations);
            cg.SetPrintLevel(0);
            cg.SetOperator(matrix_copy);
            if (all_nonzero_diag) {
                mfem::GSSmoother gs(matrix_copy);
                cg.SetPreconditioner(gs);
                cg.Mult(rhs, solution);
            } else {
                SafeAbsDiagPreconditioner diag(matrix_copy);
                cg.SetPreconditioner(diag);
                cg.Mult(rhs, solution);
            }
            iterations = cg.GetNumIterations();
        } else if (config.kind == SparseMatrixKind::GeneralNonsymmetric) {
            mfem::GMRESSolver gmres;
            gmres.SetKDim(config.gmres_kdim);
            gmres.SetRelTol(internal_rtol);
            gmres.SetAbsTol(internal_atol);
            gmres.SetMaxIter(config.maximum_iterations);
            gmres.SetPrintLevel(0);
            gmres.SetOperator(matrix_copy);
            if (all_nonzero_diag) {
                mfem::GSSmoother gs(matrix_copy);
                gmres.SetPreconditioner(gs);
                gmres.Mult(rhs, solution);
            } else {
                SafeAbsDiagPreconditioner diag(matrix_copy);
                gmres.SetPreconditioner(diag);
                gmres.Mult(rhs, solution);
            }
            iterations = gmres.GetNumIterations();
        } else {
            mfem::MINRESSolver minres;
            minres.SetRelTol(internal_rtol);
            minres.SetAbsTol(internal_atol);
            minres.SetMaxIter(config.maximum_iterations);
            minres.SetPrintLevel(0);
            minres.SetOperator(matrix_copy);
            SafeAbsDiagPreconditioner diag(matrix_copy);
            minres.SetPreconditioner(diag);
            minres.Mult(rhs, solution);
            iterations = minres.GetNumIterations();
        }

        long double res_norm = 0.0L;
        long double rhs_norm = 0.0L;
        compute_extended_residual(matrix_copy, solution, rhs, nullptr, res_norm, rhs_norm);
        const double rel_res =
            relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);

        stats.iterations = iterations;
        stats.independent_relative_residual = rel_res;
        stats.converged = residual_satisfies_tolerance(rel_res, res_norm, config);
        stats.solve_ms = elapsed_ms(start);
        return stats;
    }

    SparseSolveStats solve_gpu_cudss(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor,
        SteadyClock::time_point start) const
    {
        SparseSolveStats stats{};
        stats.resolved_solver = resolved_solver;
        stats.setup_ms = setup_ms;
#if FULLMAG_MULTIPHYSICS_HAS_CUDSS
        std::lock_guard<std::mutex> lock(solve_mutex);
        std::string err;

        std::vector<double> scaled_rhs(static_cast<std::size_t>(n), 0.0);
        const double inv_scale = 1.0 / cudss_matrix_scale;
        auto run_single_solve = [&](const double *rhs_host, double *sol_host) -> void {
            const double *upload_ptr = rhs_host;
            if (cudss_matrix_scale != 1.0) {
                for (int i = 0; i < n; ++i) {
                    scaled_rhs[static_cast<std::size_t>(i)] = rhs_host[i] * inv_scale;
                }
                upload_ptr = scaled_rhs.data();
            }
            if (!cuda_check(cudaMemcpy(d_rhs, upload_ptr,
                                       static_cast<std::size_t>(n) * sizeof(double),
                                       cudaMemcpyHostToDevice),
                            "rhs upload", err) ||
                !cudss_check(cudssMatrixSetValues(cudss_rhs, d_rhs),
                             "rhs binding", err) ||
                !cudss_check(cudssMatrixSetValues(cudss_sol, d_sol),
                             "solution binding", err) ||
                !cudss_check(cudssExecute(cudss_handle, CUDSS_PHASE_SOLVE, cudss_config,
                                          cudss_data, cudss_matrix, cudss_sol, cudss_rhs),
                             "solve", err) ||
                !cuda_check(cudaDeviceSynchronize(), "solve synchronize", err) ||
                !cuda_check(cudaMemcpy(sol_host, d_sol,
                                       static_cast<std::size_t>(n) * sizeof(double),
                                       cudaMemcpyDeviceToHost),
                            "solution download", err)) {
                throw std::runtime_error(err);
            }
        };

        run_single_solve(rhs.HostRead(), solution.HostWrite());

        std::vector<double> residual_vec;
        long double res_norm = 0.0L;
        long double rhs_norm = 0.0L;
        compute_extended_residual(matrix_copy, solution, rhs, &residual_vec, res_norm, rhs_norm);
        double rel_res = relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);

        std::vector<double> correction(static_cast<std::size_t>(n), 0.0);
        mfem::Vector candidate(n);
        int sweeps = 0;
        while (sweeps < config.max_refinement_sweeps &&
               !residual_satisfies_tolerance(rel_res, res_norm, config)) {
            run_single_solve(residual_vec.data(), correction.data());
            const double *cur = solution.HostRead();
            double *cand = candidate.HostWrite();
            for (int i = 0; i < n; ++i) {
                cand[i] = cur[i] + correction[static_cast<std::size_t>(i)];
            }
            std::vector<double> next_residual;
            long double next_res_norm = 0.0L;
            long double next_rhs_norm = 0.0L;
            if (!compute_extended_residual(
                    matrix_copy, candidate, rhs, &next_residual, next_res_norm, next_rhs_norm)) {
                break;
            }
            const double next_rel =
                relative_residual_from_norms(next_res_norm, next_rhs_norm, denominator_floor);
            if (next_rel < rel_res) {
                solution = candidate;
                residual_vec = std::move(next_residual);
                res_norm = next_res_norm;
                rel_res = next_rel;
                ++sweeps;
            } else {
                break;
            }
        }

        stats.iterations = 1 + sweeps;
        stats.refinement_sweeps = sweeps;
        stats.independent_relative_residual = rel_res;
        stats.converged = residual_satisfies_tolerance(rel_res, res_norm, config);
        stats.solve_ms = elapsed_ms(start);
        return stats;
#else
        (void)rhs;
        (void)solution;
        (void)denominator_floor;
        (void)start;
        throw std::runtime_error(
            "SparseLinearSolver GpuCudss requires a FEM GPU build with cuDSS and CUDA runtime");
#endif
    }
};

SparseLinearSolver::SparseLinearSolver(
    const mfem::SparseMatrix &matrix,
    const SparseSolveConfig &config)
{
    if (!std::isfinite(config.relative_tolerance) || config.relative_tolerance < 0.0) {
        throw std::invalid_argument(
            "SparseLinearSolver relative_tolerance must be finite and non-negative");
    }
    if (!std::isfinite(config.absolute_tolerance) || config.absolute_tolerance < 0.0) {
        throw std::invalid_argument(
            "SparseLinearSolver absolute_tolerance must be finite and non-negative");
    }
    if (config.maximum_iterations <= 0) {
        throw std::invalid_argument(
            "SparseLinearSolver maximum_iterations must be positive");
    }
    if (config.gmres_kdim <= 0) {
        throw std::invalid_argument(
            "SparseLinearSolver gmres_kdim must be positive");
    }
    if (config.by_nodes_component_count <= 0) {
        throw std::invalid_argument(
            "SparseLinearSolver by_nodes_component_count must be positive");
    }
    if (config.max_refinement_sweeps < 0) {
        throw std::invalid_argument(
            "SparseLinearSolver max_refinement_sweeps must be non-negative");
    }
    impl_ = std::make_unique<Impl>(matrix, config);
}

SparseLinearSolver::~SparseLinearSolver() = default;

SparseSolveStats SparseLinearSolver::solve(
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    double denominator_floor) const
{
    const auto start = SteadyClock::now();
    if (rhs.Size() != impl_->n) {
        throw std::invalid_argument(
            "SparseLinearSolver::solve right-hand side size mismatch");
    }
    const double *rhs_ptr = rhs.HostRead();
    long double rhs_sq = 0.0L;
    for (int i = 0; i < impl_->n; ++i) {
        if (!std::isfinite(rhs_ptr[i])) {
            throw std::invalid_argument(
                "SparseLinearSolver::solve right-hand side contains non-finite values");
        }
        const long double v = static_cast<long double>(rhs_ptr[i]);
        rhs_sq += v * v;
    }

    solution.SetSize(impl_->n);
    solution = 0.0;
    if (rhs_sq == 0.0L) {
        SparseSolveStats stats{};
        stats.converged = true;
        stats.iterations = 0;
        stats.refinement_sweeps = 0;
        stats.independent_relative_residual = 0.0;
        stats.resolved_solver = impl_->resolved_solver;
        stats.setup_ms = impl_->setup_ms;
        stats.solve_ms = elapsed_ms(start);
        return stats;
    }

    switch (impl_->backend) {
    case Impl::ActiveBackend::PetscDirect:
        return impl_->solve_petsc(rhs, solution, denominator_floor, start);
    case Impl::ActiveBackend::HypreSpd:
        return impl_->solve_hypre_spd(rhs, solution, denominator_floor, start);
    case Impl::ActiveBackend::HypreNonsymmetric:
        return impl_->solve_hypre_nonsymmetric(rhs, solution, denominator_floor, start);
    case Impl::ActiveBackend::HypreIndefinite:
        return impl_->solve_hypre_indefinite(rhs, solution, denominator_floor, start);
    case Impl::ActiveBackend::MfemSerial:
        return impl_->solve_mfem_serial(rhs, solution, denominator_floor, start);
    case Impl::ActiveBackend::GpuCudss:
        return impl_->solve_gpu_cudss(rhs, solution, denominator_floor, start);
    }
    throw std::logic_error("SparseLinearSolver reached unknown backend state");
}

const std::string &SparseLinearSolver::resolved_solver() const noexcept
{
    return impl_->resolved_solver;
}

double SparseLinearSolver::setup_ms() const noexcept
{
    return impl_->setup_ms;
}

double compute_saddle_point_equilibration_beta(
    const mfem::SparseMatrix &top_left,
    const mfem::SparseMatrix &top_right)
{
    if (!top_left.Finalized() || !top_right.Finalized()) {
        throw std::invalid_argument(
            "compute_saddle_point_equilibration_beta requires finalized CSR matrices");
    }
    const int n_a = top_left.Height();
    if (n_a <= 0 || top_left.Width() != n_a || top_right.Height() != n_a) {
        throw std::invalid_argument(
            "compute_saddle_point_equilibration_beta dimension mismatch");
    }

    const int *a_i = top_left.HostReadI();
    const int *a_j = top_left.HostReadJ();
    const double *a_v = top_left.HostReadData();
    long double diag_sum = 0.0L;
    std::size_t diag_count = 0;
    long double a_sq_sum = 0.0L;
    std::size_t a_nz_count = 0;
    for (int i = 0; i < n_a; ++i) {
        for (int p = a_i[i]; p < a_i[i + 1]; ++p) {
            const long double v = static_cast<long double>(a_v[p]);
            if (a_j[p] == i && v != 0.0L) {
                diag_sum += std::abs(v);
                ++diag_count;
            }
            if (v != 0.0L) {
                a_sq_sum += v * v;
                ++a_nz_count;
            }
        }
    }

    const long double a_scale =
        diag_count > 0
            ? (diag_sum / static_cast<long double>(diag_count))
            : (a_nz_count > 0 ? std::sqrt(a_sq_sum / static_cast<long double>(a_nz_count)) : 1.0L);

    const int *b_i = top_right.HostReadI();
    const double *b_v = top_right.HostReadData();
    const int b_nnz = b_i[n_a];
    long double b_sq_sum = 0.0L;
    std::size_t b_nz_count = 0;
    for (int p = 0; p < b_nnz; ++p) {
        const long double v = static_cast<long double>(b_v[p]);
        if (v != 0.0L) {
            b_sq_sum += v * v;
            ++b_nz_count;
        }
    }
    if (b_nz_count == 0) {
        return 1.0;
    }

    const long double b_rms = std::sqrt(b_sq_sum / static_cast<long double>(b_nz_count));
    if (b_rms <= 0.0L || a_scale <= 0.0L) {
        return 1.0;
    }

    const double beta = static_cast<double>(a_scale / b_rms);
    if (!std::isfinite(beta) || beta <= 0.0) {
        return 1.0;
    }
    return std::clamp(beta, 1.0e-100, 1.0e100);
}

mfem::SparseMatrix assemble_equilibrated_saddle_point_csr(
    const mfem::SparseMatrix &top_left,
    const mfem::SparseMatrix &top_right,
    double beta)
{
    if (!top_left.Finalized() || !top_right.Finalized()) {
        throw std::invalid_argument(
            "assemble_equilibrated_saddle_point_csr requires finalized CSR matrices");
    }
    if (!std::isfinite(beta) || beta <= 0.0) {
        throw std::invalid_argument(
            "assemble_equilibrated_saddle_point_csr requires finite positive beta");
    }
    const int n_a = top_left.Height();
    const int n_b = top_right.Width();
    if (n_a <= 0 || top_left.Width() != n_a || top_right.Height() != n_a || n_b < 0) {
        throw std::invalid_argument(
            "assemble_equilibrated_saddle_point_csr block dimension mismatch");
    }
    if (n_a > std::numeric_limits<int>::max() - n_b) {
        throw std::overflow_error(
            "assemble_equilibrated_saddle_point_csr total dimension overflows int");
    }
    const int total_dim = n_a + n_b;

    const int *a_i = top_left.HostReadI();
    const int *a_j = top_left.HostReadJ();
    const double *a_v = top_left.HostReadData();

    const int *b_i = top_right.HostReadI();
    const int *b_j = top_right.HostReadJ();
    const double *b_v = top_right.HostReadData();

    // Build CSR transpose B^T (n_b x n_a) in O(nnz(B)) with ascending column order.
    std::vector<int> bt_offsets(static_cast<std::size_t>(n_b) + 1, 0);
    for (int r = 0; r < n_a; ++r) {
        for (int p = b_i[r]; p < b_i[r + 1]; ++p) {
            const int c = b_j[p];
            if (c < 0 || c >= n_b) {
                throw std::invalid_argument(
                    "assemble_equilibrated_saddle_point_csr out-of-range column in B");
            }
            ++bt_offsets[static_cast<std::size_t>(c) + 1];
        }
    }
    for (int c = 0; c < n_b; ++c) {
        bt_offsets[static_cast<std::size_t>(c) + 1] += bt_offsets[static_cast<std::size_t>(c)];
    }
    const int b_nnz = bt_offsets[static_cast<std::size_t>(n_b)];
    std::vector<int> bt_cols(static_cast<std::size_t>(b_nnz));
    std::vector<double> bt_vals(static_cast<std::size_t>(b_nnz));
    std::vector<int> bt_cursor = bt_offsets;
    for (int r = 0; r < n_a; ++r) {
        for (int p = b_i[r]; p < b_i[r + 1]; ++p) {
            const int c = b_j[p];
            const int dst = bt_cursor[static_cast<std::size_t>(c)]++;
            bt_cols[static_cast<std::size_t>(dst)] = r;
            bt_vals[static_cast<std::size_t>(dst)] = beta * b_v[p];
        }
    }

    auto row_offsets = std::make_unique<int[]>(static_cast<std::size_t>(total_dim) + 1);
    std::vector<int> cols;
    std::vector<double> vals;
    const std::size_t reserve_nnz =
        static_cast<std::size_t>(a_i[n_a]) + 2u * static_cast<std::size_t>(b_nnz);
    cols.reserve(reserve_nnz);
    vals.reserve(reserve_nnz);

    std::vector<std::pair<int, double>> row_buf;
    auto append_sorted_merged = [&](std::vector<std::pair<int, double>> &entries) {
        std::sort(entries.begin(), entries.end(),
                  [](const auto &lhs, const auto &rhs) { return lhs.first < rhs.first; });
        for (std::size_t k = 0; k < entries.size(); ++k) {
            if (k > 0 && entries[k].first == entries[k - 1].first) {
                vals.back() += entries[k].second;
            } else {
                cols.push_back(entries[k].first);
                vals.push_back(entries[k].second);
            }
        }
    };

    row_offsets[0] = 0;
    for (int r = 0; r < n_a; ++r) {
        row_buf.clear();
        for (int p = a_i[r]; p < a_i[r + 1]; ++p) {
            row_buf.emplace_back(a_j[p], a_v[p]);
        }
        append_sorted_merged(row_buf);

        row_buf.clear();
        for (int p = b_i[r]; p < b_i[r + 1]; ++p) {
            row_buf.emplace_back(n_a + b_j[p], beta * b_v[p]);
        }
        append_sorted_merged(row_buf);

        if (cols.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            throw std::overflow_error(
                "assemble_equilibrated_saddle_point_csr nnz overflows int");
        }
        row_offsets[static_cast<std::size_t>(r) + 1] = static_cast<int>(cols.size());
    }

    for (int k = 0; k < n_b; ++k) {
        const int begin = bt_offsets[static_cast<std::size_t>(k)];
        const int end = bt_offsets[static_cast<std::size_t>(k) + 1];
        for (int p = begin; p < end; ++p) {
            const int c = bt_cols[static_cast<std::size_t>(p)];
            const double v = bt_vals[static_cast<std::size_t>(p)];
            if (p > begin && c == bt_cols[static_cast<std::size_t>(p) - 1]) {
                vals.back() += v;
            } else {
                cols.push_back(c);
                vals.push_back(v);
            }
        }
        if (cols.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            throw std::overflow_error(
                "assemble_equilibrated_saddle_point_csr nnz overflows int");
        }
        row_offsets[static_cast<std::size_t>(n_a + k) + 1] = static_cast<int>(cols.size());
    }

    const std::size_t alloc_nnz = std::max<std::size_t>(1, cols.size());
    auto col_indices = std::make_unique<int[]>(alloc_nnz);
    auto values = std::make_unique<double[]>(alloc_nnz);
    if (!cols.empty()) {
        std::copy(cols.begin(), cols.end(), col_indices.get());
        std::copy(vals.begin(), vals.end(), values.get());
    } else {
        col_indices[0] = 0;
        values[0] = 0.0;
    }

    return mfem::SparseMatrix(
        row_offsets.release(),
        col_indices.release(),
        values.release(),
        total_dim,
        total_dim,
        true,
        true,
        true);
}

double sparse_independent_relative_residual(
    const mfem::SparseMatrix &matrix,
    const mfem::Vector &solution,
    const mfem::Vector &rhs,
    double denominator_floor)
{
    long double res_norm = 0.0L;
    long double rhs_norm = 0.0L;
    if (!compute_extended_residual(matrix, solution, rhs, nullptr, res_norm, rhs_norm)) {
        return std::numeric_limits<double>::infinity();
    }
    return relative_residual_from_norms(res_norm, rhs_norm, denominator_floor);
}

} // namespace fullmag::fem::multiphysics
