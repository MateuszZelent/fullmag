#include "cpu/mfem/interactions/oersted/vector_potential.hpp"

#include "cpu/mfem/runtime/hypre_host_policy.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#if defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI
#define FULLMAG_OEF2_DISABLE_MPI 1
#else
#define FULLMAG_OEF2_DISABLE_MPI 0
#endif

#if defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK && \
    defined(MFEM_USE_MPI) && !FULLMAG_OEF2_DISABLE_MPI
#define FULLMAG_OEF2_HAS_MPI 1
#include "cpu/mfem/runtime/mpi_init.hpp"
#include <mpi.h>
#else
#define FULLMAG_OEF2_HAS_MPI 0
#endif

#if defined(FULLMAG_FEM_WITH_SLEPC) && FULLMAG_FEM_WITH_SLEPC && \
    !FULLMAG_OEF2_DISABLE_MPI
#define FULLMAG_OEF2_HAS_PETSC 1
#else
#define FULLMAG_OEF2_HAS_PETSC 0
#endif

#if FULLMAG_OEF2_HAS_MPI && defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace fullmag::fem::oersted {
namespace {

using SteadyClock = std::chrono::steady_clock;
using fullmag::fem::multiphysics::SparseCpuBackendPolicy;
using fullmag::fem::multiphysics::SparseExecutionTarget;
using fullmag::fem::multiphysics::SparseLinearSolver;
using fullmag::fem::multiphysics::SparseMatrixKind;
using fullmag::fem::multiphysics::SparseSolveConfig;
using fullmag::fem::multiphysics::assemble_equilibrated_saddle_point_csr;
using fullmag::fem::multiphysics::compute_saddle_point_equilibration_beta;

double elapsed_ms(SteadyClock::time_point start) noexcept
{
    return std::chrono::duration<double, std::milli>(SteadyClock::now() - start).count();
}

void require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::invalid_argument(message);
    }
}

int euler_characteristic(const mfem::Mesh &mesh)
{
    return mesh.GetNV() - mesh.GetNEdges() + mesh.GetNFaces() - mesh.GetNE();
}

void validate_options(
    const VectorPotentialOptions &options,
    const mfem::Mesh &mesh,
    const fullmag::fem::transport::ConservativeCurrentView &source)
{
    require(options.boundary_gauge_variant == "tangential_A_h1_0.v1",
        "OE-F2 only implements the baseline tangential_A_h1_0.v1 gauge");
    require(std::isfinite(options.mu0_si) && options.mu0_si > 0.0,
        "OE-F2 mu0 must be finite and positive");
    require(std::isfinite(options.relative_tolerance) &&
            options.relative_tolerance > 0.0,
        "OE-F2 relative tolerance must be finite and positive");
    require(options.maximum_nd_dofs > 0 && options.maximum_h1_dofs > 0,
        "OE-F2 DOF limits must be positive");
    require(options.execution_target == SparseExecutionTarget::Cpu ||
            options.execution_target == SparseExecutionTarget::GpuCudss,
        "OE-F2 received an unsupported SparseExecutionTarget");
    require(options.cpu_backend == SparseCpuBackendPolicy::Auto ||
            options.cpu_backend == SparseCpuBackendPolicy::PetscMumps ||
            options.cpu_backend == SparseCpuBackendPolicy::Hypre ||
            options.cpu_backend == SparseCpuBackendPolicy::MfemSerial,
        "OE-F2 received an unsupported SparseCpuBackendPolicy");
    require(source.space().GetMesh() == &mesh,
        "OE-F2 source view and airbox must use the same mesh");
    require(mesh.Dimension() == 3,
        "OE-F2 exact-sequence baseline requires a three-dimensional mesh");
    require(euler_characteristic(mesh) == 1,
        "OE-F2 topology certificate rejected a nontrivial harmonic domain");
    require(source.field().FESpace() != nullptr &&
            source.field().FESpace()->FEColl() != nullptr &&
            source.field().FESpace()->FEColl()->Name() ==
                std::string("RT_3D_P0"),
        "OE-F2 requires the certified RT0 current view");
}

struct MeshBounds {
    std::array<double, 3> min_xyz{0.0, 0.0, 0.0};
    double diameter = 0.0;
};

MeshBounds compute_mesh_bounds(const mfem::Mesh &mesh)
{
    const int nv = mesh.GetNV();
    require(nv > 0, "OE-F2 mesh has no vertices");
    std::array<double, 3> min_xyz{
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity()};
    std::array<double, 3> max_xyz{
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity()};
    for (int v = 0; v < nv; ++v) {
        const double *coord = mesh.GetVertex(v);
        for (int d = 0; d < 3; ++d) {
            require(std::isfinite(coord[d]), "OE-F2 mesh vertex coordinate is non-finite");
            min_xyz[static_cast<std::size_t>(d)] =
                std::min(min_xyz[static_cast<std::size_t>(d)], coord[d]);
            max_xyz[static_cast<std::size_t>(d)] =
                std::max(max_xyz[static_cast<std::size_t>(d)], coord[d]);
        }
    }
    const double dx = max_xyz[0] - min_xyz[0];
    const double dy = max_xyz[1] - min_xyz[1];
    const double dz = max_xyz[2] - min_xyz[2];
    const double diameter = std::sqrt(dx * dx + dy * dy + dz * dz);
    require(std::isfinite(diameter) && diameter > 0.0,
        "OE-F2 mesh bounding diameter must be finite and positive");
    return MeshBounds{min_xyz, diameter};
}

// Extract interior submatrix in O(nnz) with canonical sorted, duplicate-free CSR.
mfem::SparseMatrix extract_submatrix_csr(
    const mfem::SparseMatrix &source,
    const std::vector<int> &row_int_to_full,
    const std::vector<int> &col_full_to_int,
    int out_ncols,
    double scale = 1.0)
{
    require(source.Finalized(), "OE-F2 submatrix extraction requires a finalized CSR matrix");
    const int out_nrows = static_cast<int>(row_int_to_full.size());
    require(out_nrows > 0 && out_ncols > 0,
        "OE-F2 submatrix extraction requires non-empty dimensions");

    const int *src_i = source.HostReadI();
    const int *src_j = source.HostReadJ();
    const double *src_a = source.HostReadData();

    auto row_offsets = std::make_unique<int[]>(static_cast<std::size_t>(out_nrows) + 1u);
    std::vector<int> cols;
    std::vector<double> vals;
    cols.reserve(static_cast<std::size_t>(src_i[source.Height()]));
    vals.reserve(static_cast<std::size_t>(src_i[source.Height()]));

    std::vector<std::pair<int, double>> row_buf;
    row_offsets[0] = 0;
    for (int r = 0; r < out_nrows; ++r) {
        const int full_r = row_int_to_full[static_cast<std::size_t>(r)];
        row_buf.clear();
        for (int p = src_i[full_r]; p < src_i[full_r + 1]; ++p) {
            const int mapped_c = col_full_to_int[static_cast<std::size_t>(src_j[p])];
            if (mapped_c >= 0) {
                row_buf.emplace_back(mapped_c, scale * src_a[p]);
            }
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
            throw std::overflow_error("OE-F2 interior CSR nnz overflows 32-bit int");
        }
        row_offsets[static_cast<std::size_t>(r) + 1u] = static_cast<int>(cols.size());
    }

    const std::size_t alloc_nnz = std::max<std::size_t>(1u, cols.size());
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
        out_nrows,
        out_ncols,
        true,
        true,
        true);
}

// Single-pass O(nnz) essential-row/col elimination with canonical sorted CSR.
// If `diag_on_elim != 0.0` (square symmetric blocks), writes `diag_on_elim` on
// eliminated rows; otherwise eliminated rows are left empty.
mfem::SparseMatrix build_eliminated_csr(
    const mfem::SparseMatrix &source,
    const std::vector<bool> &row_elim_mask,
    const std::vector<bool> &col_elim_mask,
    double diag_on_elim,
    double scale = 1.0)
{
    require(source.Finalized(), "OE-F2 CSR elimination requires a finalized matrix");
    const int nrows = source.Height();
    const int ncols = source.Width();
    require(static_cast<int>(row_elim_mask.size()) == nrows &&
            static_cast<int>(col_elim_mask.size()) == ncols,
        "OE-F2 CSR elimination mask size mismatch");
    if (diag_on_elim != 0.0) {
        require(nrows == ncols, "OE-F2 diagonal imposition requires a square matrix");
    }

    const int *src_i = source.HostReadI();
    const int *src_j = source.HostReadJ();
    const double *src_a = source.HostReadData();

    auto row_offsets = std::make_unique<int[]>(static_cast<std::size_t>(nrows) + 1u);
    std::vector<int> cols;
    std::vector<double> vals;
    cols.reserve(static_cast<std::size_t>(src_i[nrows]));
    vals.reserve(static_cast<std::size_t>(src_i[nrows]));

    std::vector<std::pair<int, double>> row_buf;
    row_offsets[0] = 0;
    for (int r = 0; r < nrows; ++r) {
        if (row_elim_mask[static_cast<std::size_t>(r)]) {
            if (diag_on_elim != 0.0) {
                cols.push_back(r);
                vals.push_back(diag_on_elim);
            }
        } else {
            row_buf.clear();
            for (int p = src_i[r]; p < src_i[r + 1]; ++p) {
                const int c = src_j[p];
                if (!col_elim_mask[static_cast<std::size_t>(c)]) {
                    row_buf.emplace_back(c, scale * src_a[p]);
                }
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
        }
        if (cols.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            throw std::overflow_error("OE-F2 eliminated CSR nnz overflows 32-bit int");
        }
        row_offsets[static_cast<std::size_t>(r) + 1u] = static_cast<int>(cols.size());
    }

    const std::size_t alloc_nnz = std::max<std::size_t>(1u, cols.size());
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

// Sparse diagonal matrix with 1.0 on essential H1 boundary DOFs and 0.0 in the interior.
// Keeps the full-space (1,1) saddle-point block non-singular on Gamma_{H1} for MINRES.
mfem::SparseMatrix build_boundary_identity_csr(
    int size,
    const std::vector<bool> &essential_mask)
{
    require(size > 0 && static_cast<int>(essential_mask.size()) == size,
        "OE-F2 boundary identity mask size mismatch");
    auto row_offsets = std::make_unique<int[]>(static_cast<std::size_t>(size) + 1u);
    std::vector<int> cols;
    std::vector<double> vals;
    cols.reserve(static_cast<std::size_t>(size));
    vals.reserve(static_cast<std::size_t>(size));

    row_offsets[0] = 0;
    for (int r = 0; r < size; ++r) {
        if (essential_mask[static_cast<std::size_t>(r)]) {
            cols.push_back(r);
            vals.push_back(1.0);
        }
        row_offsets[static_cast<std::size_t>(r) + 1u] = static_cast<int>(cols.size());
    }

    const std::size_t alloc_nnz = std::max<std::size_t>(1u, cols.size());
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
        size,
        size,
        true,
        true,
        true);
}

// Compute r = b - A_block * x in extended precision (long double) in O(nnz).
bool compute_equilibrated_block_residual_ld(
    const mfem::SparseMatrix &k_curl_elim,
    const mfem::SparseMatrix &g_beta_elim,
    const std::vector<bool> &essential_h1_mask,
    const mfem::Vector &sol_block,
    const mfem::Vector &rhs_block,
    mfem::Vector &residual_out,
    long double &res_norm_out,
    long double &rhs_norm_out)
{
    const int nd_dofs = k_curl_elim.Height();
    const int h1_dofs = g_beta_elim.Width();
    const int total = nd_dofs + h1_dofs;
    const double *x = sol_block.HostRead();
    const double *b = rhs_block.HostRead();
    for (int i = 0; i < total; ++i) {
        if (!std::isfinite(x[i])) {
            res_norm_out = std::numeric_limits<long double>::infinity();
            rhs_norm_out = 0.0L;
            return false;
        }
    }

    const int *ki = k_curl_elim.HostReadI();
    const int *kj = k_curl_elim.HostReadJ();
    const double *ka = k_curl_elim.HostReadData();

    const int *gi = g_beta_elim.HostReadI();
    const int *gj = g_beta_elim.HostReadJ();
    const double *ga = g_beta_elim.HostReadData();

    residual_out.SetSize(total);
    double *res_p = residual_out.HostWrite();

    std::vector<long double> gt_a(static_cast<std::size_t>(h1_dofs), 0.0L);
    long double res_sq = 0.0L;
    long double rhs_sq = 0.0L;

    for (int r = 0; r < nd_dofs; ++r) {
        long double ax = 0.0L;
        for (int p = ki[r]; p < ki[r + 1]; ++p) {
            ax += static_cast<long double>(ka[p]) * static_cast<long double>(x[kj[p]]);
        }
        const long double a_r = static_cast<long double>(x[r]);
        for (int p = gi[r]; p < gi[r + 1]; ++p) {
            const int c = gj[p];
            const long double g_val = static_cast<long double>(ga[p]);
            ax += g_val * static_cast<long double>(x[nd_dofs + c]);
            gt_a[static_cast<std::size_t>(c)] += g_val * a_r;
        }
        const long double b_r = static_cast<long double>(b[r]);
        const long double diff = b_r - ax;
        res_p[r] = static_cast<double>(diff);
        res_sq += diff * diff;
        rhs_sq += b_r * b_r;
    }

    for (int c = 0; c < h1_dofs; ++c) {
        long double row_val = gt_a[static_cast<std::size_t>(c)];
        if (essential_h1_mask[static_cast<std::size_t>(c)]) {
            row_val += static_cast<long double>(x[nd_dofs + c]);
        }
        const long double b_c = static_cast<long double>(b[nd_dofs + c]);
        const long double diff = b_c - row_val;
        res_p[nd_dofs + c] = static_cast<double>(diff);
        res_sq += diff * diff;
        rhs_sq += b_c * b_c;
    }

    res_norm_out = std::sqrt(res_sq);
    rhs_norm_out = std::sqrt(rhs_sq);
    return std::isfinite(static_cast<double>(res_norm_out));
}

struct LinearSolveOutcome {
    std::string resolved_solver;
    int iterations = 0;
    double solve_ms = 0.0;
};

// Solve equilibrated full-size saddle-point block system with MINRES + SPD
// block-diagonal preconditioner and up to 2 long-double refinement passes.
void run_minres_with_refinement(
    const mfem::BlockOperator &saddle_op,
    const mfem::Solver &preconditioner,
    const mfem::SparseMatrix &k_curl_elim,
    const mfem::SparseMatrix &g_beta_elim,
    const std::vector<bool> &essential_h1_mask,
    const mfem::Vector &rhs_block,
    mfem::Vector &sol_block,
    double relative_tolerance,
    int max_iterations,
    int &total_iterations)
{
    const int total = rhs_block.Size();
    sol_block.SetSize(total);
    sol_block = 0.0;
    total_iterations = 0;

    if (rhs_block.Norml2() == 0.0) {
        return;
    }

    const double internal_rtol = std::clamp(0.01 * relative_tolerance, 1.0e-14, 1.0e-13);
    mfem::MINRESSolver minres;
    minres.iterative_mode = false;
    minres.SetRelTol(internal_rtol);
    minres.SetAbsTol(0.0);
    minres.SetMaxIter(max_iterations);
    minres.SetPrintLevel(0);
    minres.SetOperator(saddle_op);
    minres.SetPreconditioner(const_cast<mfem::Solver &>(preconditioner));
    minres.Mult(rhs_block, sol_block);
    total_iterations += minres.GetNumIterations();

    mfem::Vector res_vec(total);
    long double res_norm = 0.0L;
    long double rhs_norm = 0.0L;
    if (!compute_equilibrated_block_residual_ld(
            k_curl_elim, g_beta_elim, essential_h1_mask,
            sol_block, rhs_block, res_vec, res_norm, rhs_norm)) {
        return;
    }

    const long double target_res =
        static_cast<long double>(std::min(0.1 * relative_tolerance, 1.0e-11)) * rhs_norm;
    mfem::Vector dx(total);
    mfem::Vector candidate(total);
    for (int sweep = 0; sweep < 2 && res_norm > target_res; ++sweep) {
        dx = 0.0;
        minres.Mult(res_vec, dx);
        total_iterations += minres.GetNumIterations();

        const double *cur = sol_block.HostRead();
        const double *delta = dx.HostRead();
        double *cand = candidate.HostWrite();
        for (int i = 0; i < total; ++i) {
            cand[i] = cur[i] + delta[i];
        }

        mfem::Vector next_res_vec(total);
        long double next_res_norm = 0.0L;
        long double next_rhs_norm = 0.0L;
        if (compute_equilibrated_block_residual_ld(
                k_curl_elim, g_beta_elim, essential_h1_mask,
                candidate, rhs_block, next_res_vec, next_res_norm, next_rhs_norm) &&
            next_res_norm < res_norm) {
            sol_block = candidate;
            res_vec = next_res_vec;
            res_norm = next_res_norm;
        } else {
            break;
        }
    }
}

#if FULLMAG_OEF2_HAS_MPI
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

// Strictly SPD preconditioner M_0 = alpha_A * D_int * P^T * B_AMS * P * D_int + D_bdr
// where P is the signed edge bijection between serial nd_space and 1-rank ParMesh
// par_nd_space (exact even when ParMesh renumbers vertices/edges).
class ScaledHypreAmsPreconditioner final : public mfem::Solver {
public:
    ScaledHypreAmsPreconditioner(
        MPI_Comm comm,
        int nd_dofs,
        const mfem::HypreAMS &ams,
        const std::vector<bool> &essential_mask,
        const std::vector<int> &par_to_ser,
        const std::vector<int> &par_sign,
        double interior_scale)
        : mfem::Solver(nd_dofs),
          ams_(ams),
          essential_mask_(essential_mask),
          par_to_ser_(par_to_ser),
          par_sign_(par_sign),
          interior_scale_(interior_scale),
          row_starts_{0, static_cast<HYPRE_BigInt>(nd_dofs)},
          b_par_(comm, static_cast<HYPRE_BigInt>(nd_dofs), row_starts_),
          y_par_(comm, static_cast<HYPRE_BigInt>(nd_dofs), row_starts_)
    {}

    void SetOperator(const mfem::Operator &) override {}

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        const double *xp = x.HostRead();
        double *bp = b_par_.HostWrite();
        double *yp_par = y_par_.HostWrite();
        for (int p = 0; p < height; ++p) {
            const int s = par_to_ser_[static_cast<std::size_t>(p)];
            bp[p] = essential_mask_[static_cast<std::size_t>(s)]
                ? 0.0
                : (static_cast<double>(par_sign_[static_cast<std::size_t>(p)]) * xp[s]);
            yp_par[p] = 0.0;
        }
        ams_.Mult(b_par_, y_par_);
        const double *out_par = y_par_.HostRead();
        double *yp = y.HostWrite();
        for (int p = 0; p < height; ++p) {
            const int s = par_to_ser_[static_cast<std::size_t>(p)];
            if (essential_mask_[static_cast<std::size_t>(s)]) {
                yp[s] = xp[s];
            } else {
                yp[s] = interior_scale_ *
                    static_cast<double>(par_sign_[static_cast<std::size_t>(p)]) *
                    out_par[p];
            }
        }
    }

private:
    const mfem::HypreAMS &ams_;
    const std::vector<bool> &essential_mask_;
    const std::vector<int> &par_to_ser_;
    const std::vector<int> &par_sign_;
    double interior_scale_ = 1.0;
    HYPRE_BigInt row_starts_[2];
    mutable mfem::HypreParVector b_par_;
    mutable mfem::HypreParVector y_par_;
};

// Strictly SPD preconditioner M_1 = alpha_p * D_int * B_AMG * D_int + D_bdr.
class ScaledHypreAmgPreconditioner final : public mfem::Solver {
public:
    ScaledHypreAmgPreconditioner(
        MPI_Comm comm,
        int h1_dofs,
        const mfem::HypreBoomerAMG &amg,
        const std::vector<bool> &essential_mask,
        double interior_scale)
        : mfem::Solver(h1_dofs),
          amg_(amg),
          essential_mask_(essential_mask),
          interior_scale_(interior_scale),
          row_starts_{0, static_cast<HYPRE_BigInt>(h1_dofs)},
          b_par_(comm, static_cast<HYPRE_BigInt>(h1_dofs), row_starts_),
          y_par_(comm, static_cast<HYPRE_BigInt>(h1_dofs), row_starts_)
    {}

    void SetOperator(const mfem::Operator &) override {}

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        const double *xp = x.HostRead();
        double *bp = b_par_.HostWrite();
        double *yp_par = y_par_.HostWrite();
        for (int i = 0; i < height; ++i) {
            bp[i] = essential_mask_[static_cast<std::size_t>(i)] ? 0.0 : xp[i];
            yp_par[i] = 0.0;
        }
        amg_.Mult(b_par_, y_par_);
        const double *out_par = y_par_.HostRead();
        double *yp = y.HostWrite();
        for (int i = 0; i < height; ++i) {
            yp[i] = essential_mask_[static_cast<std::size_t>(i)]
                ? xp[i]
                : (interior_scale_ * out_par[i]);
        }
    }

private:
    const mfem::HypreBoomerAMG &amg_;
    const std::vector<bool> &essential_mask_;
    double interior_scale_ = 1.0;
    HYPRE_BigInt row_starts_[2];
    mutable mfem::HypreParVector b_par_;
    mutable mfem::HypreParVector y_par_;
};

// Build signed ND DOF bijection between 1-rank ParMesh space and serial nd_space.
bool build_nd_par_to_ser_map(
    const mfem::Mesh &ser_mesh,
    const mfem::ParMesh &par_mesh,
    const mfem::FiniteElementSpace &ser_nd,
    const mfem::ParFiniteElementSpace &par_nd,
    const MeshBounds &bounds,
    bool scaled_par_coords,
    std::vector<int> &par_to_ser,
    std::vector<int> &par_sign,
    std::string &reason)
{
    const int nd_dofs = ser_nd.GetVSize();
    if (par_mesh.GetNE() != ser_mesh.GetNE() ||
        par_nd.GetVSize() != nd_dofs ||
        par_nd.GetTrueVSize() != nd_dofs) {
        reason = "1-rank ParMesh ND space dimensions do not match serial ND space";
        return false;
    }

    par_to_ser.assign(static_cast<std::size_t>(nd_dofs), -1);
    par_sign.assign(static_cast<std::size_t>(nd_dofs), 0);
    std::vector<bool> ser_seen(static_cast<std::size_t>(nd_dofs), false);

    mfem::Array<int> ser_verts;
    mfem::Array<int> par_verts;
    mfem::Array<int> ser_dofs;
    mfem::Array<int> par_dofs;
    for (int e = 0; e < ser_mesh.GetNE(); ++e) {
        ser_mesh.GetElementVertices(e, ser_verts);
        par_mesh.GetElementVertices(e, par_verts);
        if (ser_verts.Size() != par_verts.Size()) {
            reason = "ParMesh element vertex count mismatch";
            return false;
        }
        for (int k = 0; k < ser_verts.Size(); ++k) {
            const double *sv = ser_mesh.GetVertex(ser_verts[k]);
            const double *pv = par_mesh.GetVertex(par_verts[k]);
            for (int d = 0; d < 3; ++d) {
                const double expected = scaled_par_coords
                    ? ((sv[d] - bounds.min_xyz[static_cast<std::size_t>(d)]) / bounds.diameter)
                    : sv[d];
                const double tol = scaled_par_coords ? 1.0e-11 : (1.0e-11 * bounds.diameter);
                if (std::abs(pv[d] - expected) > tol) {
                    reason = "ParMesh element local vertex ordering does not match serial mesh";
                    return false;
                }
            }
        }

        ser_nd.GetElementDofs(e, ser_dofs);
        par_nd.GetElementDofs(e, par_dofs);
        if (ser_dofs.Size() != par_dofs.Size()) {
            reason = "ParMesh element ND DOF count mismatch";
            return false;
        }
        for (int k = 0; k < ser_dofs.Size(); ++k) {
            const int s_raw = ser_dofs[k];
            const int p_raw = par_dofs[k];
            const int s_sign = (s_raw < 0) ? -1 : 1;
            const int p_sign = (p_raw < 0) ? -1 : 1;
            const int s_idx = (s_raw < 0) ? (-1 - s_raw) : s_raw;
            const int p_idx = (p_raw < 0) ? (-1 - p_raw) : p_raw;
            if (s_idx < 0 || s_idx >= nd_dofs || p_idx < 0 || p_idx >= nd_dofs) {
                reason = "ParMesh ND DOF index out of bounds";
                return false;
            }
            const int rel_sign = s_sign * p_sign;
            if (par_to_ser[static_cast<std::size_t>(p_idx)] == -1) {
                par_to_ser[static_cast<std::size_t>(p_idx)] = s_idx;
                par_sign[static_cast<std::size_t>(p_idx)] = rel_sign;
                ser_seen[static_cast<std::size_t>(s_idx)] = true;
            } else if (par_to_ser[static_cast<std::size_t>(p_idx)] != s_idx ||
                       par_sign[static_cast<std::size_t>(p_idx)] != rel_sign) {
                reason = "Inconsistent signed ND DOF mapping between serial and ParMesh";
                return false;
            }
        }
    }

    for (int i = 0; i < nd_dofs; ++i) {
        if (par_to_ser[static_cast<std::size_t>(i)] < 0 ||
            !ser_seen[static_cast<std::size_t>(i)]) {
            reason = "Incomplete ND DOF bijection between serial and ParMesh";
            return false;
        }
    }
    return true;
}

bool try_solve_saddle_point_hypre_ams(
    const mfem::Mesh &mesh,
    const MeshBounds &bounds,
    const mfem::ND_FECollection &nd_fec,
    const mfem::FiniteElementSpace &nd_space,
    mfem::FiniteElementSpace &h1_space,
    const mfem::SparseMatrix &curl_matrix,
    const mfem::SparseMatrix &gradient_matrix,
    const mfem::Vector &current_load,
    const std::vector<bool> &essential_nd_mask,
    const std::vector<bool> &essential_h1_mask,
    double mu0_si,
    double beta,
    double relative_tolerance,
    mfem::Vector &a_dofs,
    mfem::Vector &p_dofs,
    LinearSolveOutcome &outcome,
    std::string &reason)
{
    const auto start = SteadyClock::now();

    int mpi_initialized = 0;
    MPI_Initialized(&mpi_initialized);
    if (mpi_initialized == 0 && !can_initialize_openmpi_singleton()) {
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
    MPI_Comm comm = fullmag::fem::fullmag_serial_comm();

    const int nd_dofs = nd_space.GetVSize();
    const int h1_dofs = h1_space.GetVSize();
    const double diameter = bounds.diameter;
    // h-independent Poincaré-Friedrichs shift gamma = 1 / (mu0 * L^2):
    // keeps solenoidal eigenvalues of (K_curl + gamma*M_ND)^{-1} K_curl in
    // [C_P/(C_P+1), 1) uniformly in h, L, and mu0, and exact Schur eigenvalues +/-1.
    const double gamma = 1.0 / (mu0_si * diameter * diameter);
    if (!std::isfinite(gamma) || gamma <= 0.0) {
        reason = "OE-F2 Tier-2 AMS shift gamma is not finite and positive";
        return false;
    }

    // Build 1-rank ParMesh with explicit zero partition (MFEM_USE_METIS=NO).
    // Rescaling straight mesh coordinates by 1/L puts all AMS coordinates and
    // Galerkin operators at O(1) even for nanometer domains (L = 1e-7 m), with
    // exact covariant identity: hat(P_A) = (mu0 * L) * (K_curl + gamma * M_ND).
    mfem::Mesh mesh_copy(mesh);
    const bool scaled_par_coords = (mesh_copy.GetNodes() == nullptr);
    if (scaled_par_coords) {
        for (int v = 0; v < mesh_copy.GetNV(); ++v) {
            double *coord = mesh_copy.GetVertex(v);
            for (int d = 0; d < 3; ++d) {
                coord[d] = (coord[d] - bounds.min_xyz[static_cast<std::size_t>(d)]) / diameter;
            }
        }
    }

    std::vector<int> part(static_cast<std::size_t>(mesh_copy.GetNE()), 0);
    mfem::ParMesh pmesh(comm, mesh_copy, part.data());
    mfem::ParFiniteElementSpace par_nd_space(&pmesh, const_cast<mfem::ND_FECollection *>(&nd_fec));

    std::vector<int> nd_par_to_ser;
    std::vector<int> nd_par_sign;
    if (!build_nd_par_to_ser_map(
            mesh, pmesh, nd_space, par_nd_space, bounds, scaled_par_coords,
            nd_par_to_ser, nd_par_sign, reason)) {
        return false;
    }

    mfem::Array<int> par_ess_nd;
    par_ess_nd.Reserve(nd_dofs);
    for (int p = 0; p < nd_dofs; ++p) {
        if (essential_nd_mask[static_cast<std::size_t>(nd_par_to_ser[static_cast<std::size_t>(p)])]) {
            par_ess_nd.Append(p);
        }
    }

    mfem::ConstantCoefficient curl_coeff(scaled_par_coords ? 1.0 : diameter);
    mfem::ConstantCoefficient mass_coeff(scaled_par_coords ? 1.0 : (1.0 / diameter));
    mfem::ParBilinearForm p_a_form(&par_nd_space);
    p_a_form.AddDomainIntegrator(new mfem::CurlCurlIntegrator(curl_coeff));
    p_a_form.AddDomainIntegrator(new mfem::VectorFEMassIntegrator(mass_coeff));
    p_a_form.Assemble();

    mfem::OperatorPtr p_a_op;
    p_a_form.FormSystemMatrix(par_ess_nd, p_a_op);
    auto *hypre_p_a = p_a_op.As<mfem::HypreParMatrix>();
    if (hypre_p_a == nullptr || hypre_p_a->Height() != nd_dofs || hypre_p_a->Width() != nd_dofs) {
        reason = "OE-F2 Tier-2 ParBilinearForm did not produce a matching HypreParMatrix";
        return false;
    }

    mfem::HypreAMS hypre_ams(*hypre_p_a, &par_nd_space);
    hypre_ams.SetPrintLevel(0);

    // Dimensionless H1 Laplacian tilde(L_H1) = (1 / L) * L_H1 so interior entries
    // are O(h/L) ~ O(1) and decoupled boundary diagonals are 1.0.
    mfem::ConstantCoefficient inv_diam_coeff(1.0 / diameter);
    mfem::BilinearForm h1_lap_form(&h1_space);
    h1_lap_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(inv_diam_coeff));
    h1_lap_form.Assemble();
    h1_lap_form.Finalize();

    mfem::SparseMatrix h1_lap_elim = build_eliminated_csr(
        h1_lap_form.SpMat(), essential_h1_mask, essential_h1_mask, 1.0, 1.0);
    h1_lap_elim.HostReadI();
    h1_lap_elim.HostReadJ();
    h1_lap_elim.HostReadData();

    HYPRE_BigInt h1_row_starts[2] = {0, static_cast<HYPRE_BigInt>(h1_dofs)};
    mfem::HypreParMatrix hypre_h1_lap(
        comm,
        static_cast<HYPRE_BigInt>(h1_dofs),
        h1_row_starts,
        &h1_lap_elim);
    mfem::HypreBoomerAMG hypre_amg(hypre_h1_lap);
    hypre_amg.SetPrintLevel(0);
    hypre_amg.SetMaxIter(1);
    hypre_amg.SetTol(0.0);

    // Full-space symmetric equilibrated saddle-point block operator with
    // diagonal 1.0 on Gamma_{ND} in (0,0) and h1_bdr_identity (1.0 on Gamma_{H1})
    // in (1,1) so boundary rows are non-singular and decoupled from interior.
    mfem::SparseMatrix k_curl_elim = build_eliminated_csr(
        curl_matrix, essential_nd_mask, essential_nd_mask, 1.0, 1.0);
    mfem::SparseMatrix g_beta_elim = build_eliminated_csr(
        gradient_matrix, essential_nd_mask, essential_h1_mask, 0.0, beta);
    mfem::SparseMatrix h1_bdr_identity = build_boundary_identity_csr(
        h1_dofs, essential_h1_mask);

    mfem::Array<int> block_offsets(3);
    block_offsets[0] = 0;
    block_offsets[1] = nd_dofs;
    block_offsets[2] = nd_dofs + h1_dofs;

    mfem::TransposeOperator g_beta_t(&g_beta_elim);
    mfem::BlockOperator saddle_op(block_offsets);
    saddle_op.SetDiagonalBlock(0, &k_curl_elim);
    saddle_op.SetBlock(0, 1, &g_beta_elim);
    saddle_op.SetBlock(1, 0, &g_beta_t);
    saddle_op.SetDiagonalBlock(1, &h1_bdr_identity);

    const double alpha_a = mu0_si * diameter;
    const double alpha_p = (gamma / beta) / (beta * diameter);
    if (!std::isfinite(alpha_a) || alpha_a <= 0.0 ||
        !std::isfinite(alpha_p) || alpha_p <= 0.0) {
        reason = "OE-F2 Tier-2 preconditioner scaling is not finite and positive";
        return false;
    }

    ScaledHypreAmsPreconditioner ams_precond(
        comm, nd_dofs, hypre_ams, essential_nd_mask,
        nd_par_to_ser, nd_par_sign, alpha_a);
    ScaledHypreAmgPreconditioner amg_precond(
        comm, h1_dofs, hypre_amg, essential_h1_mask, alpha_p);

    mfem::BlockDiagonalPreconditioner block_precond(block_offsets);
    block_precond.SetDiagonalBlock(0, &ams_precond);
    block_precond.SetDiagonalBlock(1, &amg_precond);

    mfem::Vector rhs_block(nd_dofs + h1_dofs);
    rhs_block = 0.0;
    for (int dof = 0; dof < nd_dofs; ++dof) {
        if (!essential_nd_mask[static_cast<std::size_t>(dof)]) {
            rhs_block[dof] = current_load[dof];
        }
    }

    mfem::Vector sol_block(nd_dofs + h1_dofs);
    int total_iterations = 0;
    run_minres_with_refinement(
        saddle_op, block_precond, k_curl_elim, g_beta_elim, essential_h1_mask,
        rhs_block, sol_block, relative_tolerance, 2000, total_iterations);

    a_dofs.SetSize(nd_dofs);
    p_dofs.SetSize(h1_dofs);
    for (int dof = 0; dof < nd_dofs; ++dof) {
        a_dofs[dof] = essential_nd_mask[static_cast<std::size_t>(dof)] ? 0.0 : sol_block[dof];
    }
    for (int dof = 0; dof < h1_dofs; ++dof) {
        p_dofs[dof] = essential_h1_mask[static_cast<std::size_t>(dof)]
            ? 0.0
            : (beta * sol_block[nd_dofs + dof]);
    }

    outcome.resolved_solver = "hypre_ams_boomeramg_minres";
    outcome.iterations = total_iterations;
    outcome.solve_ms = elapsed_ms(start);
    return true;
}
#endif // FULLMAG_OEF2_HAS_MPI

// Strictly SPD block preconditioner for Tier-3 serial MINRES (TSan / non-MPI).
class ScaledSerialGsPreconditioner final : public mfem::Solver {
public:
    ScaledSerialGsPreconditioner(
        const mfem::SparseMatrix &matrix,
        const std::vector<bool> &essential_mask,
        double interior_scale)
        : mfem::Solver(matrix.Height()),
          gs_(matrix, 0, 1),
          essential_mask_(essential_mask),
          interior_scale_(interior_scale),
          tmp_in_(matrix.Height()),
          tmp_out_(matrix.Height())
    {}

    void SetOperator(const mfem::Operator &) override {}

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        const double *xp = x.HostRead();
        double *in_p = tmp_in_.HostWrite();
        for (int i = 0; i < height; ++i) {
            in_p[i] = essential_mask_[static_cast<std::size_t>(i)] ? 0.0 : xp[i];
        }
        tmp_out_ = 0.0;
        gs_.Mult(tmp_in_, tmp_out_);
        const double *out_p = tmp_out_.HostRead();
        double *yp = y.HostWrite();
        for (int i = 0; i < height; ++i) {
            yp[i] = essential_mask_[static_cast<std::size_t>(i)]
                ? xp[i]
                : (interior_scale_ * out_p[i]);
        }
    }

private:
    mfem::GSSmoother gs_;
    const std::vector<bool> &essential_mask_;
    double interior_scale_ = 1.0;
    mutable mfem::Vector tmp_in_;
    mutable mfem::Vector tmp_out_;
};

void solve_saddle_point_mfem_serial(
    const MeshBounds &bounds,
    mfem::FiniteElementSpace &nd_space,
    mfem::FiniteElementSpace &h1_space,
    const mfem::SparseMatrix &curl_matrix,
    const mfem::SparseMatrix &gradient_matrix,
    const mfem::Vector &current_load,
    const std::vector<bool> &essential_nd_mask,
    const std::vector<bool> &essential_h1_mask,
    double mu0_si,
    double beta,
    double relative_tolerance,
    mfem::Vector &a_dofs,
    mfem::Vector &p_dofs,
    LinearSolveOutcome &outcome)
{
    const auto start = SteadyClock::now();
    const int nd_dofs = nd_space.GetVSize();
    const int h1_dofs = h1_space.GetVSize();
    const double diameter = bounds.diameter;
    const double gamma = 1.0 / (mu0_si * diameter * diameter);
    require(std::isfinite(gamma) && gamma > 0.0,
        "OE-F2 Tier-3 shift gamma must be finite and positive");

    mfem::ConstantCoefficient curl_coeff(diameter);
    mfem::ConstantCoefficient mass_coeff(1.0 / diameter);
    mfem::BilinearForm p_a_form(&nd_space);
    p_a_form.AddDomainIntegrator(new mfem::CurlCurlIntegrator(curl_coeff));
    p_a_form.AddDomainIntegrator(new mfem::VectorFEMassIntegrator(mass_coeff));
    p_a_form.Assemble();
    p_a_form.Finalize();
    mfem::SparseMatrix p_a_elim = build_eliminated_csr(
        p_a_form.SpMat(), essential_nd_mask, essential_nd_mask, 1.0, 1.0);

    mfem::ConstantCoefficient inv_diam_coeff(1.0 / diameter);
    mfem::BilinearForm h1_lap_form(&h1_space);
    h1_lap_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(inv_diam_coeff));
    h1_lap_form.Assemble();
    h1_lap_form.Finalize();
    mfem::SparseMatrix h1_lap_elim = build_eliminated_csr(
        h1_lap_form.SpMat(), essential_h1_mask, essential_h1_mask, 1.0, 1.0);

    mfem::SparseMatrix k_curl_elim = build_eliminated_csr(
        curl_matrix, essential_nd_mask, essential_nd_mask, 1.0, 1.0);
    mfem::SparseMatrix g_beta_elim = build_eliminated_csr(
        gradient_matrix, essential_nd_mask, essential_h1_mask, 0.0, beta);
    mfem::SparseMatrix h1_bdr_identity = build_boundary_identity_csr(
        h1_dofs, essential_h1_mask);

    mfem::Array<int> block_offsets(3);
    block_offsets[0] = 0;
    block_offsets[1] = nd_dofs;
    block_offsets[2] = nd_dofs + h1_dofs;

    mfem::TransposeOperator g_beta_t(&g_beta_elim);
    mfem::BlockOperator saddle_op(block_offsets);
    saddle_op.SetDiagonalBlock(0, &k_curl_elim);
    saddle_op.SetBlock(0, 1, &g_beta_elim);
    saddle_op.SetBlock(1, 0, &g_beta_t);
    saddle_op.SetDiagonalBlock(1, &h1_bdr_identity);

    const double alpha_a = mu0_si * diameter;
    const double alpha_p = (gamma / beta) / (beta * diameter);
    ScaledSerialGsPreconditioner p_a_gs(p_a_elim, essential_nd_mask, alpha_a);
    ScaledSerialGsPreconditioner p_h1_gs(h1_lap_elim, essential_h1_mask, alpha_p);

    mfem::BlockDiagonalPreconditioner block_precond(block_offsets);
    block_precond.SetDiagonalBlock(0, &p_a_gs);
    block_precond.SetDiagonalBlock(1, &p_h1_gs);

    mfem::Vector rhs_block(nd_dofs + h1_dofs);
    rhs_block = 0.0;
    for (int dof = 0; dof < nd_dofs; ++dof) {
        if (!essential_nd_mask[static_cast<std::size_t>(dof)]) {
            rhs_block[dof] = current_load[dof];
        }
    }

    const int max_iters = std::min(200000, std::max(4000, (nd_dofs + h1_dofs) * 4));
    mfem::Vector sol_block(nd_dofs + h1_dofs);
    int total_iterations = 0;
    run_minres_with_refinement(
        saddle_op, block_precond, k_curl_elim, g_beta_elim, essential_h1_mask,
        rhs_block, sol_block, relative_tolerance, max_iters, total_iterations);

    a_dofs.SetSize(nd_dofs);
    p_dofs.SetSize(h1_dofs);
    for (int dof = 0; dof < nd_dofs; ++dof) {
        a_dofs[dof] = essential_nd_mask[static_cast<std::size_t>(dof)] ? 0.0 : sol_block[dof];
    }
    for (int dof = 0; dof < h1_dofs; ++dof) {
        p_dofs[dof] = essential_h1_mask[static_cast<std::size_t>(dof)]
            ? 0.0
            : (beta * sol_block[nd_dofs + dof]);
    }

    outcome.resolved_solver = "mfem_block_gs_minres";
    outcome.iterations = total_iterations;
    outcome.solve_ms = elapsed_ms(start);
}

bool solve_saddle_point_direct_equilibrated(
    const mfem::SparseMatrix &k_curl_int,
    const mfem::SparseMatrix &g_int,
    const std::vector<int> &nd_int_to_full,
    const std::vector<int> &h1_int_to_full,
    const mfem::Vector &current_load,
    int nd_dofs,
    int h1_dofs,
    double beta,
    double relative_tolerance,
    SparseExecutionTarget execution_target,
    SparseCpuBackendPolicy cpu_backend,
    bool allow_failure_return,
    mfem::Vector &a_dofs,
    mfem::Vector &p_dofs,
    LinearSolveOutcome &outcome)
{
    const auto start = SteadyClock::now();
    const int n_nd_int = static_cast<int>(nd_int_to_full.size());
    const int n_h1_int = static_cast<int>(h1_int_to_full.size());
    const mfem::SparseMatrix saddle_beta =
        assemble_equilibrated_saddle_point_csr(k_curl_int, g_int, beta);

    SparseSolveConfig cfg;
    cfg.kind = SparseMatrixKind::SymmetricIndefinite;
    cfg.execution_target = execution_target;
    cfg.cpu_backend = cpu_backend;
    cfg.relative_tolerance = std::clamp(0.1 * relative_tolerance, 1.0e-13, 1.0e-12);
    cfg.absolute_tolerance = 0.0;
    cfg.maximum_iterations = 2000;
    cfg.max_refinement_sweeps = 2;

    std::unique_ptr<SparseLinearSolver> solver;
    if (allow_failure_return) {
        try {
            solver = std::make_unique<SparseLinearSolver>(saddle_beta, cfg);
        } catch (const std::runtime_error &) {
            return false;
        }
    } else {
        solver = std::make_unique<SparseLinearSolver>(saddle_beta, cfg);
    }

    mfem::Vector rhs_int(n_nd_int + n_h1_int);
    rhs_int = 0.0;
    for (int i = 0; i < n_nd_int; ++i) {
        rhs_int[i] = current_load[nd_int_to_full[static_cast<std::size_t>(i)]];
    }

    mfem::Vector sol_int(n_nd_int + n_h1_int);
    const auto stats = solver->solve(rhs_int, sol_int, 0.0);
    if (!stats.converged) {
        if (allow_failure_return) {
            return false;
        }
        std::ostringstream message;
        message.setf(std::ios::scientific);
        message.precision(17);
        message << "OE-F2 sparse direct equilibrated solver (" << stats.resolved_solver
                << ") did not converge: rel_res=" << stats.independent_relative_residual;
        throw std::runtime_error(message.str());
    }

    a_dofs.SetSize(nd_dofs);
    a_dofs = 0.0;
    for (int i = 0; i < n_nd_int; ++i) {
        a_dofs[nd_int_to_full[static_cast<std::size_t>(i)]] = sol_int[i];
    }

    p_dofs.SetSize(h1_dofs);
    p_dofs = 0.0;
    for (int j = 0; j < n_h1_int; ++j) {
        p_dofs[h1_int_to_full[static_cast<std::size_t>(j)]] = beta * sol_int[n_nd_int + j];
    }

    outcome.resolved_solver = stats.resolved_solver;
    outcome.iterations = stats.iterations;
    outcome.solve_ms = elapsed_ms(start);
    return true;
}

std::vector<double> project_compatible_h_to_nodes(
    const mfem::Mesh &mesh,
    const mfem::FiniteElementSpace &rt_space,
    const mfem::Vector &compatible_h,
    const mfem::H1_FECollection &h1_fec,
    double mesh_diameter,
    double relative_tolerance,
    SparseExecutionTarget execution_target,
    SparseCpuBackendPolicy cpu_backend,
    double &maximum_residual)
{
    mfem::GridFunction rt_h(const_cast<mfem::FiniteElementSpace *>(&rt_space));
    require(rt_h.Size() == compatible_h.Size(),
        "OE-F2 compatible H coefficient count does not match RT0 space");
    rt_h = compatible_h;

    mfem::FiniteElementSpace scalar_space(
        const_cast<mfem::Mesh *>(&mesh), &h1_fec, 1,
        mfem::Ordering::byNODES);
    const int scalar_dofs = scalar_space.GetVSize();
    require(scalar_dofs == mesh.GetNV(),
        "OE-F2 nodal projection requires a P1 H1 space with one DOF per vertex");

    // Scale M_H1 and RHS by L^{-3} so the SPD mass matrix entries stay O(1)
    // across nanometer and macroscopic meshes while solving the exact same system.
    const double vol_scale = mesh_diameter * mesh_diameter * mesh_diameter;
    require(std::isfinite(vol_scale) && vol_scale > 0.0,
        "OE-F2 mesh volume scale must be finite and positive");
    const double inv_vol_scale = 1.0 / vol_scale;

    mfem::ConstantCoefficient mass_scale_coeff(inv_vol_scale);
    mfem::BilinearForm mass(&scalar_space);
    mass.AddDomainIntegrator(new mfem::MassIntegrator(mass_scale_coeff));
    mass.Assemble();
    mass.Finalize();

    // Single-pass element/quadrature assembly for all three Cartesian RHS vectors.
    std::array<mfem::Vector, 3> rhs_components;
    for (int c = 0; c < 3; ++c) {
        rhs_components[static_cast<std::size_t>(c)].SetSize(scalar_dofs);
        rhs_components[static_cast<std::size_t>(c)] = 0.0;
    }

    mfem::Array<int> element_dofs;
    mfem::Vector shape;
    mfem::Vector h_value(3);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        const mfem::FiniteElement *fe = scalar_space.GetFE(element);
        mfem::ElementTransformation *tr =
            const_cast<mfem::Mesh &>(mesh).GetElementTransformation(element);
        scalar_space.GetElementDofs(element, element_dofs);
        const int nd = fe->GetDof();
        shape.SetSize(nd);
        const int order = std::max(2, 2 * fe->GetOrder() + tr->OrderW());
        const mfem::IntegrationRule &ir = mfem::IntRules.Get(fe->GetGeomType(), order);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            tr->SetIntPoint(&ip);
            const double weight = tr->Weight() * ip.weight * inv_vol_scale;
            fe->CalcShape(ip, shape);
            rt_h.GetVectorValue(*tr, ip, h_value);
            for (int c = 0; c < 3; ++c) {
                const double comp = h_value[c];
                require(std::isfinite(comp),
                    "OE-F2 compatible H field is non-finite during nodal projection");
                const double scaled = comp * weight;
                mfem::Vector &rhs_c = rhs_components[static_cast<std::size_t>(c)];
                for (int local = 0; local < nd; ++local) {
                    const int dof = element_dofs[local];
                    require(dof >= 0 && dof < scalar_dofs,
                        "OE-F2 H1 element DOF index is out of bounds");
                    rhs_c[dof] += shape[local] * scaled;
                }
            }
        }
    }

    // Factor-once sparse SPD solver reused across all three Cartesian components.
    SparseSolveConfig mass_config;
    mass_config.kind = SparseMatrixKind::Spd;
    mass_config.execution_target = execution_target;
    mass_config.cpu_backend = cpu_backend;
    mass_config.relative_tolerance = std::clamp(0.1 * relative_tolerance, 1.0e-13, 1.0e-12);
    mass_config.absolute_tolerance = 0.0;
    mass_config.maximum_iterations = std::min(20000, std::max(2000, scalar_dofs * 2));
    mass_config.max_refinement_sweeps = 2;

    SparseLinearSolver mass_solver(mass.SpMat(), mass_config);

    mfem::Vector solution(scalar_dofs);
    mfem::Vector residual(scalar_dofs);
    std::vector<double> nodal(static_cast<std::size_t>(scalar_dofs) * 3u, 0.0);
    maximum_residual = 0.0;
    for (int component = 0; component < 3; ++component) {
        const mfem::Vector &rhs = rhs_components[static_cast<std::size_t>(component)];
        solution = 0.0;
        const auto stats = mass_solver.solve(rhs, solution, 0.0);
        if (!stats.converged) {
            std::ostringstream message;
            message.setf(std::ios::scientific);
            message.precision(17);
            message << "OE-F2 nodal H1 projection solver (" << stats.resolved_solver
                    << ") did not converge: rel_res=" << stats.independent_relative_residual;
            throw std::invalid_argument(message.str());
        }
        mass.Mult(solution, residual);
        residual -= rhs;
        const double scaled_res_norm = residual.Norml2();
        const double scaled_rhs_norm = rhs.Norml2();
        const double unscaled_res_norm = scaled_res_norm * vol_scale;
        const double unscaled_rhs_norm = scaled_rhs_norm * vol_scale;
        const double residual_scale = std::max(1.0, unscaled_rhs_norm);
        if (!(std::isfinite(unscaled_res_norm) &&
                unscaled_res_norm <= relative_tolerance * residual_scale)) {
            std::ostringstream message;
            message.setf(std::ios::scientific);
            message.precision(17);
            message << "OE-F2 nodal H1 projection residual exceeds the declared tolerance: "
                    << unscaled_res_norm << " > "
                    << relative_tolerance * residual_scale;
            throw std::invalid_argument(message.str());
        }
        maximum_residual = std::max(maximum_residual, unscaled_res_norm / residual_scale);
        for (int node = 0; node < scalar_dofs; ++node) {
            nodal[static_cast<std::size_t>(node) * 3u +
                static_cast<std::size_t>(component)] = solution[node];
        }
    }
    for (double value : nodal) {
        require(std::isfinite(value),
            "OE-F2 nodal H1 projection produced a non-finite value");
    }
    return nodal;
}

} // namespace

VectorPotentialResult VectorPotentialSolver::Evaluate(
    const fullmag::fem::transport::ConservativeCurrentView &source,
    const VectorPotentialOptions &options)
{
    const mfem::Mesh &mesh = *source.space().GetMesh();
    validate_options(options, mesh, source);
    const MeshBounds bounds = compute_mesh_bounds(mesh);

    mfem::ND_FECollection nd_fec(1, 3);
    mfem::H1_FECollection h1_fec(1, 3);
    mfem::FiniteElementSpace nd_space(
        const_cast<mfem::Mesh *>(&mesh), &nd_fec);
    mfem::FiniteElementSpace h1_space(
        const_cast<mfem::Mesh *>(&mesh), &h1_fec);
    const int nd_dofs = nd_space.GetVSize();
    const int h1_dofs = h1_space.GetVSize();
    require(nd_dofs > 0 && h1_dofs > 0,
        "OE-F2 assembled an empty exact-sequence space");
    require(nd_dofs <= options.maximum_nd_dofs,
        "OE-F2 ND system exceeds the bounded CPU reference size");
    require(h1_dofs <= options.maximum_h1_dofs,
        "OE-F2 H1 system exceeds the bounded CPU reference size");
    require(nd_dofs <= std::numeric_limits<int>::max() - h1_dofs,
        "OE-F2 mixed system dimension overflows 32-bit int");
    const int block_size = nd_dofs + h1_dofs;

    mfem::ConstantCoefficient inverse_mu0(1.0 / options.mu0_si);
    mfem::BilinearForm curl_form(&nd_space);
    curl_form.AddDomainIntegrator(
        new mfem::CurlCurlIntegrator(inverse_mu0));
    curl_form.Assemble();
    curl_form.Finalize();

    mfem::MixedBilinearForm gradient_form(&h1_space, &nd_space);
    gradient_form.AddDomainIntegrator(
        new mfem::MixedVectorGradientIntegrator());
    gradient_form.Assemble();
    gradient_form.Finalize();

    mfem::VectorGridFunctionCoefficient current_coefficient(&source.field());
    mfem::LinearForm current_load(&nd_space);
    current_load.AddDomainIntegrator(
        new mfem::VectorFEDomainLFIntegrator(current_coefficient));
    current_load.Assemble();

    const mfem::SparseMatrix &curl_matrix = curl_form.SpMat();
    const mfem::SparseMatrix &gradient_matrix = gradient_form.SpMat();
    require(curl_matrix.Height() == nd_dofs &&
            curl_matrix.Width() == nd_dofs,
        "OE-F2 curl block has an unexpected dimension");
    require(gradient_matrix.Height() == nd_dofs &&
            gradient_matrix.Width() == h1_dofs,
        "OE-F2 gradient block has an unexpected dimension");

    mfem::Array<int> essential_nd;
    mfem::Array<int> essential_h1;
    nd_space.GetBoundaryTrueDofs(essential_nd);
    h1_space.GetBoundaryTrueDofs(essential_h1);

    std::vector<bool> essential_nd_mask(static_cast<std::size_t>(nd_dofs), false);
    std::vector<bool> essential_h1_mask(static_cast<std::size_t>(h1_dofs), false);
    for (int index = 0; index < essential_nd.Size(); ++index) {
        const int dof = essential_nd[index];
        require(dof >= 0 && dof < nd_dofs, "OE-F2 essential ND DOF is out of range");
        essential_nd_mask[static_cast<std::size_t>(dof)] = true;
    }
    for (int index = 0; index < essential_h1.Size(); ++index) {
        const int dof = essential_h1[index];
        require(dof >= 0 && dof < h1_dofs, "OE-F2 essential H1 DOF is out of range");
        essential_h1_mask[static_cast<std::size_t>(dof)] = true;
    }

    std::vector<int> nd_full_to_int(static_cast<std::size_t>(nd_dofs), -1);
    std::vector<int> nd_int_to_full;
    nd_int_to_full.reserve(static_cast<std::size_t>(nd_dofs));
    for (int dof = 0; dof < nd_dofs; ++dof) {
        if (!essential_nd_mask[static_cast<std::size_t>(dof)]) {
            nd_full_to_int[static_cast<std::size_t>(dof)] =
                static_cast<int>(nd_int_to_full.size());
            nd_int_to_full.push_back(dof);
        }
    }

    std::vector<int> h1_full_to_int(static_cast<std::size_t>(h1_dofs), -1);
    std::vector<int> h1_int_to_full;
    h1_int_to_full.reserve(static_cast<std::size_t>(h1_dofs));
    for (int dof = 0; dof < h1_dofs; ++dof) {
        if (!essential_h1_mask[static_cast<std::size_t>(dof)]) {
            h1_full_to_int[static_cast<std::size_t>(dof)] =
                static_cast<int>(h1_int_to_full.size());
            h1_int_to_full.push_back(dof);
        }
    }

    const int n_nd_int = static_cast<int>(nd_int_to_full.size());
    const int n_h1_int = static_cast<int>(h1_int_to_full.size());

    mfem::Vector a_dofs(nd_dofs);
    mfem::Vector p_dofs(h1_dofs);
    a_dofs = 0.0;
    p_dofs = 0.0;
    LinearSolveOutcome linear_outcome{};

    if (n_nd_int == 0) {
        // Every ND edge lies on the essential boundary; A == 0, p == 0 identically.
        linear_outcome.resolved_solver = "trivial_zero_interior";
        linear_outcome.iterations = 0;
        linear_outcome.solve_ms = 0.0;
    } else if (n_h1_int == 0) {
        // Coarse mesh with no interior H1 vertices: no gradient nullspace modes,
        // so K_curl_int is strictly SPD and p == 0 identically.
        const auto start = SteadyClock::now();
        const double alpha_a = options.mu0_si * bounds.diameter;
        const mfem::SparseMatrix k_scaled = extract_submatrix_csr(
            curl_matrix, nd_int_to_full, nd_full_to_int, n_nd_int, alpha_a);
        mfem::Vector f_scaled(n_nd_int);
        for (int i = 0; i < n_nd_int; ++i) {
            f_scaled[i] = alpha_a * current_load[nd_int_to_full[static_cast<std::size_t>(i)]];
        }

        SparseSolveConfig spd_cfg;
        spd_cfg.kind = SparseMatrixKind::Spd;
        spd_cfg.execution_target = options.execution_target;
        spd_cfg.cpu_backend = options.cpu_backend;
        spd_cfg.relative_tolerance =
            std::clamp(0.1 * options.relative_tolerance, 1.0e-13, 1.0e-12);
        spd_cfg.absolute_tolerance = 0.0;
        spd_cfg.maximum_iterations = std::min(100000, std::max(2000, n_nd_int * 4));
        spd_cfg.max_refinement_sweeps = 2;

        SparseLinearSolver spd_solver(k_scaled, spd_cfg);
        mfem::Vector a_int(n_nd_int);
        const auto stats = spd_solver.solve(f_scaled, a_int, 0.0);
        if (!stats.converged) {
            std::ostringstream message;
            message.setf(std::ios::scientific);
            message.precision(17);
            message << "OE-F2 SPD interior curl solve (" << stats.resolved_solver
                    << ") did not converge: rel_res=" << stats.independent_relative_residual;
            throw std::runtime_error(message.str());
        }
        for (int i = 0; i < n_nd_int; ++i) {
            a_dofs[nd_int_to_full[static_cast<std::size_t>(i)]] = a_int[i];
        }
        linear_outcome.resolved_solver = stats.resolved_solver;
        linear_outcome.iterations = stats.iterations;
        linear_outcome.solve_ms = elapsed_ms(start);
    } else {
        // Genuine mixed saddle-point solve on interior (n_nd_int > 0, n_h1_int > 0)
        // with symmetric block equilibration beta = d_K / g_rms.
        const mfem::SparseMatrix k_curl_int = extract_submatrix_csr(
            curl_matrix, nd_int_to_full, nd_full_to_int, n_nd_int, 1.0);
        const mfem::SparseMatrix g_int = extract_submatrix_csr(
            gradient_matrix, nd_int_to_full, h1_full_to_int, n_h1_int, 1.0);
        const double beta = compute_saddle_point_equilibration_beta(k_curl_int, g_int);

        if (options.execution_target == SparseExecutionTarget::GpuCudss) {
            solve_saddle_point_direct_equilibrated(
                k_curl_int, g_int, nd_int_to_full, h1_int_to_full, current_load,
                nd_dofs, h1_dofs, beta, options.relative_tolerance,
                SparseExecutionTarget::GpuCudss, options.cpu_backend,
                /*allow_failure_return=*/false, a_dofs, p_dofs, linear_outcome);
        } else {
            switch (options.cpu_backend) {
            case SparseCpuBackendPolicy::PetscMumps:
                solve_saddle_point_direct_equilibrated(
                    k_curl_int, g_int, nd_int_to_full, h1_int_to_full, current_load,
                    nd_dofs, h1_dofs, beta, options.relative_tolerance,
                    SparseExecutionTarget::Cpu, SparseCpuBackendPolicy::PetscMumps,
                    /*allow_failure_return=*/false, a_dofs, p_dofs, linear_outcome);
                break;
            case SparseCpuBackendPolicy::Hypre: {
#if FULLMAG_OEF2_HAS_MPI
                std::string hypre_reason;
                if (!try_solve_saddle_point_hypre_ams(
                        mesh, bounds, nd_fec, nd_space, h1_space,
                        curl_matrix, gradient_matrix, current_load,
                        essential_nd_mask, essential_h1_mask,
                        options.mu0_si, beta, options.relative_tolerance,
                        a_dofs, p_dofs, linear_outcome, hypre_reason)) {
                    throw std::runtime_error(
                        "OE-F2 explicit Hypre AMS+BoomerAMG backend unavailable: " +
                        hypre_reason);
                }
                break;
#else
                throw std::runtime_error(
                    "OE-F2 explicit Hypre AMS+BoomerAMG backend unavailable "
                    "(MFEM_USE_MPI off or FULLMAG_OET0_DISABLE_MPI=1)");
#endif
            }
            case SparseCpuBackendPolicy::MfemSerial:
                solve_saddle_point_mfem_serial(
                    bounds, nd_space, h1_space, curl_matrix, gradient_matrix,
                    current_load, essential_nd_mask, essential_h1_mask,
                    options.mu0_si, beta, options.relative_tolerance,
                    a_dofs, p_dofs, linear_outcome);
                break;
            case SparseCpuBackendPolicy::Auto: {
                bool solved = false;
#if FULLMAG_OEF2_HAS_PETSC
                solved = solve_saddle_point_direct_equilibrated(
                    k_curl_int, g_int, nd_int_to_full, h1_int_to_full, current_load,
                    nd_dofs, h1_dofs, beta, options.relative_tolerance,
                    SparseExecutionTarget::Cpu, SparseCpuBackendPolicy::PetscMumps,
                    /*allow_failure_return=*/true, a_dofs, p_dofs, linear_outcome);
#endif
#if FULLMAG_OEF2_HAS_MPI
                if (!solved) {
                    std::string hypre_reason;
                    solved = try_solve_saddle_point_hypre_ams(
                        mesh, bounds, nd_fec, nd_space, h1_space,
                        curl_matrix, gradient_matrix, current_load,
                        essential_nd_mask, essential_h1_mask,
                        options.mu0_si, beta, options.relative_tolerance,
                        a_dofs, p_dofs, linear_outcome, hypre_reason);
                }
#endif
                if (!solved) {
                    solve_saddle_point_mfem_serial(
                        bounds, nd_space, h1_space, curl_matrix, gradient_matrix,
                        current_load, essential_nd_mask, essential_h1_mask,
                        options.mu0_si, beta, options.relative_tolerance,
                        a_dofs, p_dofs, linear_outcome);
                }
                break;
            }
            }
        }
    }

    for (int index = 0; index < nd_dofs; ++index) {
        require(std::isfinite(a_dofs[index]),
            "OE-F2 mixed solve produced a non-finite A coefficient");
    }
    for (int index = 0; index < h1_dofs; ++index) {
        require(std::isfinite(p_dofs[index]),
            "OE-F2 mixed solve produced a non-finite gauge coefficient");
    }

    // Recompute the physical weak-form residual blocks in O(nnz) using the
    // unmodified curl and gradient matrices so diagnostics stay tied to the
    // actual weak form rather than algebraic boundary-condition rows.
    mfem::Vector first_block(nd_dofs);
    curl_matrix.Mult(a_dofs, first_block);
    gradient_matrix.AddMult(p_dofs, first_block);
    first_block -= current_load;
    for (int row = 0; row < nd_dofs; ++row) {
        if (essential_nd_mask[static_cast<std::size_t>(row)]) {
            first_block[row] = 0.0;
        }
    }

    mfem::Vector constraint_block(h1_dofs);
    gradient_matrix.MultTranspose(a_dofs, constraint_block);
    for (int row = 0; row < h1_dofs; ++row) {
        if (essential_h1_mask[static_cast<std::size_t>(row)]) {
            constraint_block[row] = 0.0;
        }
    }

    mfem::RT_FECollection rt_fec(0, 3);
    mfem::FiniteElementSpace rt_space(
        const_cast<mfem::Mesh *>(&mesh), &rt_fec);
    mfem::DiscreteLinearOperator curl_to_rt(&nd_space, &rt_space);
    curl_to_rt.AddDomainInterpolator(new mfem::CurlInterpolator());
    curl_to_rt.Assemble();
    curl_to_rt.Finalize();
    mfem::Vector compatible_b(rt_space.GetVSize());
    curl_to_rt.Mult(a_dofs, compatible_b);

    mfem::L2_FECollection l2_fec(0, 3);
    mfem::FiniteElementSpace l2_space(
        const_cast<mfem::Mesh *>(&mesh), &l2_fec);
    mfem::DiscreteLinearOperator divergence(&rt_space, &l2_space);
    divergence.AddDomainInterpolator(new mfem::DivergenceInterpolator());
    divergence.Assemble();
    divergence.Finalize();
    mfem::Vector divergence_values(l2_space.GetVSize());
    divergence.Mult(compatible_b, divergence_values);

    VectorPotentialResult result;
    result.a_dofs_t_m.assign(a_dofs.GetData(), a_dofs.GetData() + nd_dofs);
    result.gauge_dofs_apm.assign(p_dofs.GetData(), p_dofs.GetData() + h1_dofs);
    result.compatible_b_dofs_t.assign(compatible_b.GetData(),
        compatible_b.GetData() + compatible_b.Size());
    result.compatible_h_dofs_apm.resize(static_cast<std::size_t>(compatible_b.Size()));
    mfem::Vector compatible_h(compatible_b.Size());
    for (int index = 0; index < compatible_b.Size(); ++index) {
        const double h_val = compatible_b[index] / options.mu0_si;
        result.compatible_h_dofs_apm[static_cast<std::size_t>(index)] = h_val;
        compatible_h[index] = h_val;
    }

    double nodal_projection_residual = 0.0;
    const auto projection_start = SteadyClock::now();
    result.nodal_h_xyz_apm = project_compatible_h_to_nodes(
        mesh, rt_space, compatible_h, h1_fec, bounds.diameter,
        std::max(options.relative_tolerance, 1.0e-12),
        options.execution_target, options.cpu_backend,
        nodal_projection_residual);
    const double nodal_projection_ms = elapsed_ms(projection_start);

    result.diagnostics.nd_dofs = nd_dofs;
    result.diagnostics.h1_dofs = h1_dofs;
    result.diagnostics.block_size = block_size;
    result.diagnostics.harmonic_count = 0;
    result.diagnostics.essential_nd_dof_count = essential_nd.Size();
    result.diagnostics.essential_h1_dof_count = essential_h1.Size();
    result.diagnostics.first_block_residual = first_block.Norml2();
    result.diagnostics.constraint_residual = constraint_block.Norml2();
    result.diagnostics.weak_ampere_residual = first_block.Norml2();
    result.diagnostics.compatible_divergence_residual = divergence_values.Norml2();
    result.diagnostics.source_pairing_norm = current_load.Norml2();
    result.diagnostics.nodal_projection_residual = nodal_projection_residual;
    result.diagnostics.resolved_linear_solver = linear_outcome.resolved_solver;
    result.diagnostics.linear_iterations = linear_outcome.iterations;
    result.diagnostics.linear_solve_ms = linear_outcome.solve_ms;
    result.diagnostics.nodal_projection_ms = nodal_projection_ms;
    result.operator_version = operator_version;
    result.source_view_identity_digest = source.identity().view_identity_digest;
    result.boundary_gauge_variant = options.boundary_gauge_variant;

    const double scale = std::max(1.0, result.diagnostics.source_pairing_norm);
    const double tolerance = std::max(
        options.relative_tolerance * scale,
        128.0 * std::numeric_limits<double>::epsilon() * scale);
    require(result.diagnostics.first_block_residual <= tolerance,
        "OE-F2 first-block residual exceeds the declared tolerance");
    require(result.diagnostics.constraint_residual <= tolerance,
        "OE-F2 B^T A constraint residual exceeds the declared tolerance");
    require(result.diagnostics.compatible_divergence_residual <= tolerance,
        "OE-F2 compatible RT0 divergence exceeds the declared tolerance");
    return result;
}

} // namespace fullmag::fem::oersted
