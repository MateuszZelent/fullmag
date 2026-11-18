#pragma once

// Exact shift-invert action for the real-split K0 Schur pencil (note 0830,
// eq-poisson-airbox-augmented-shift).  The shifted Schur operator
//
//   S_sigma = s * blockdiag(S, S) - sigma * m_s * J(B_qq),
//   S = A_qq - A_qphi P_g^{-1} A_phiq,
//
// is the q-block Schur complement of the sparse augmented matrix
//
//   K_sigma = [[ s*A_qq^R + c*J(B_qq),  s*A_qphi^R ],
//              [ A_phiq^R,              P_g^R      ]],   c = sigma * m_s,
//
// so S_sigma^{-1} r is the q-block of K_sigma^{-1} [r; 0].  One sparse LU
// (MUMPS with METIS ordering) per shift replaces the magnetic-only shifted
// preconditioner, whose missing demag feedback forced long GMRES runs.

#if FULLMAG_FEM_WITH_SLEPC

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"

#include <petscksp.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

#if defined(PETSC_HAVE_MUMPS)
inline constexpr bool kAugmentedShiftSolverAvailable = true;
#else
inline constexpr bool kAugmentedShiftSolverAvailable = false;
#endif

struct AugmentedShiftSolver {
    Mat matrix = nullptr;
    KSP ksp = nullptr;
    Vec rhs = nullptr;
    Vec solution = nullptr;
    PetscInt split_q_count = 0;
    PetscInt dimension = 0;
    std::uint64_t apply_count = 0;
    std::uint64_t factor_nonzeros = 0;
};

inline void destroy_augmented_shift_solver(AugmentedShiftSolver *solver) noexcept
{
    if (solver == nullptr) {
        return;
    }
    if (solver->solution != nullptr) {
        VecDestroy(&solver->solution);
    }
    if (solver->rhs != nullptr) {
        VecDestroy(&solver->rhs);
    }
    if (solver->ksp != nullptr) {
        KSPDestroy(&solver->ksp);
    }
    if (solver->matrix != nullptr) {
        MatDestroy(&solver->matrix);
    }
    solver->split_q_count = 0;
    solver->dimension = 0;
}

struct AugmentedShiftSolverDeleter {
    void operator()(AugmentedShiftSolver *solver) const noexcept
    {
        destroy_augmented_shift_solver(solver);
        delete solver;
    }
};

// The exact augmented solve is the default whenever PETSc provides MUMPS.
// FULLMAG_K0_AUGMENTED_SHIFT=0 keeps the magnetic-only preconditioner for an
// A/B measurement on the same build; any other value keeps the default.
inline bool augmented_shift_solver_enabled() noexcept
{
    if (!kAugmentedShiftSolverAvailable) {
        return false;
    }
    const char *value = std::getenv("FULLMAG_K0_AUGMENTED_SHIFT");
    return value == nullptr || std::strcmp(value, "0") != 0;
}

// Floquet k != 0 counterpart; FULLMAG_FLOQUET_AUGMENTED_SHIFT=0 keeps the
// magnetic-only shifted preconditioner for an A/B measurement.
inline bool floquet_augmented_shift_solver_enabled() noexcept
{
    if (!kAugmentedShiftSolverAvailable) {
        return false;
    }
    const char *value = std::getenv("FULLMAG_FLOQUET_AUGMENTED_SHIFT");
    return value == nullptr || std::strcmp(value, "0") != 0;
}

namespace augmented_shift_detail {

inline std::uint64_t csr_row_count(const CsrMatrixView &matrix, std::uint64_t row) noexcept
{
    return static_cast<std::uint64_t>(matrix.row_offsets[row + 1u]) -
        static_cast<std::uint64_t>(matrix.row_offsets[row]);
}

inline void append_csr_row(
    const CsrMatrixView &matrix,
    std::uint64_t row,
    PetscInt column_offset,
    double scale,
    std::vector<PetscInt> *columns,
    std::vector<PetscScalar> *values)
{
    for (std::uint32_t entry = matrix.row_offsets[row];
         entry < matrix.row_offsets[row + 1u];
         ++entry) {
        columns->push_back(
            column_offset + static_cast<PetscInt>(matrix.column_indices[entry]));
        values->push_back(static_cast<PetscScalar>(scale * matrix.values[entry]));
    }
}

inline bool csr_shape_matches(
    const CsrMatrixView &matrix,
    std::uint64_t rows,
    std::uint64_t columns) noexcept
{
    return matrix.row_count == rows && matrix.column_count == columns &&
        matrix.row_offsets != nullptr &&
        (matrix.row_offsets[rows] == 0u ||
         (matrix.column_indices != nullptr && matrix.values != nullptr));
}

inline bool factor_augmented_shift_matrix(PetscInt split_q_count, AugmentedShiftSolver *out);

}  // namespace augmented_shift_detail

// Assemble and factor K_sigma.  Returns false (with all resources released)
// when MUMPS is unavailable or the assembly/factorization fails, so the
// caller keeps the existing magnetic-only preconditioner.
inline bool create_augmented_shift_solver(
    const PoissonAirboxEigenBlockProblem &problem,
    bool gauge_augmented,
    double operator_scale,
    double shifted_mass_coefficient,
    AugmentedShiftSolver *out)
{
    namespace detail = augmented_shift_detail;
    if (out == nullptr || !kAugmentedShiftSolverAvailable) {
        return false;
    }
    destroy_augmented_shift_solver(out);
    const std::uint64_t q = problem.q_dof_count;
    const std::uint64_t phi = problem.phi_dof_count;
    const std::uint64_t phi_augmented = phi + (gauge_augmented ? 1u : 0u);
    const std::uint64_t dimension = 2u * (q + phi_augmented);
    if (q == 0u || phi == 0u ||
        dimension > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        !std::isfinite(operator_scale) || operator_scale <= 0.0 ||
        !std::isfinite(shifted_mass_coefficient) ||
        !detail::csr_shape_matches(problem.A_qq, q, q) ||
        !detail::csr_shape_matches(problem.B_qq, q, q) ||
        !detail::csr_shape_matches(problem.A_qphi, q, phi) ||
        !detail::csr_shape_matches(problem.A_phiq, phi, q) ||
        !detail::csr_shape_matches(problem.A_phiphi, phi, phi) ||
        (gauge_augmented &&
         (problem.phi_mean_weights == nullptr || problem.phi_mean_weights_count != phi))) {
        return false;
    }

    const PetscInt q_count = static_cast<PetscInt>(q);
    const PetscInt phi_block = static_cast<PetscInt>(phi_augmented);
    const PetscInt q_imag = q_count;
    const PetscInt phi_real = 2 * q_count;
    const PetscInt phi_imag = 2 * q_count + phi_block;
    const PetscInt rows = static_cast<PetscInt>(dimension);

    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(rows), 0);
    for (std::uint64_t row = 0; row < q; ++row) {
        const std::uint64_t count = detail::csr_row_count(problem.A_qq, row) +
            detail::csr_row_count(problem.B_qq, row) +
            detail::csr_row_count(problem.A_qphi, row);
        if (count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(count);
        row_nonzeros[static_cast<std::size_t>(q_imag + static_cast<PetscInt>(row))] =
            static_cast<PetscInt>(count);
    }
    for (std::uint64_t row = 0; row < phi; ++row) {
        const std::uint64_t count = detail::csr_row_count(problem.A_phiq, row) +
            detail::csr_row_count(problem.A_phiphi, row) + (gauge_augmented ? 1u : 0u);
        if (count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(phi_real + static_cast<PetscInt>(row))] =
            static_cast<PetscInt>(count);
        row_nonzeros[static_cast<std::size_t>(phi_imag + static_cast<PetscInt>(row))] =
            static_cast<PetscInt>(count);
    }
    if (gauge_augmented) {
        // Mean-zero gauge row: weights against phi plus a structural zero
        // diagonal (MUMPS pivots past it).
        const PetscInt count = static_cast<PetscInt>(phi + 1u);
        row_nonzeros[static_cast<std::size_t>(phi_real + static_cast<PetscInt>(phi))] = count;
        row_nonzeros[static_cast<std::size_t>(phi_imag + static_cast<PetscInt>(phi))] = count;
    }

    Mat matrix = nullptr;
    if (MatCreateSeqAIJ(PETSC_COMM_SELF, rows, rows, 0, row_nonzeros.data(), &matrix) != 0) {
        return false;
    }
    out->matrix = matrix;
    if (MatSetOption(matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        destroy_augmented_shift_solver(out);
        return false;
    }

    std::vector<PetscInt> columns;
    std::vector<PetscScalar> values;
    auto insert_row = [&](PetscInt row) noexcept {
        return columns.empty() ||
            MatSetValues(
                matrix, 1, &row,
                static_cast<PetscInt>(columns.size()), columns.data(),
                values.data(), ADD_VALUES) == 0;
    };
    const double c = shifted_mass_coefficient;
    for (std::uint64_t row = 0; row < q; ++row) {
        // Real rows: s*A_qq q_r + c*B q_i + s*A_qphi phi_r.
        columns.clear();
        values.clear();
        detail::append_csr_row(problem.A_qq, row, 0, operator_scale, &columns, &values);
        detail::append_csr_row(problem.B_qq, row, q_imag, c, &columns, &values);
        detail::append_csr_row(problem.A_qphi, row, phi_real, operator_scale, &columns, &values);
        if (!insert_row(static_cast<PetscInt>(row))) {
            destroy_augmented_shift_solver(out);
            return false;
        }
        // Imaginary rows: -c*B q_r + s*A_qq q_i + s*A_qphi phi_i.
        columns.clear();
        values.clear();
        detail::append_csr_row(problem.B_qq, row, 0, -c, &columns, &values);
        detail::append_csr_row(problem.A_qq, row, q_imag, operator_scale, &columns, &values);
        detail::append_csr_row(problem.A_qphi, row, phi_imag, operator_scale, &columns, &values);
        if (!insert_row(q_imag + static_cast<PetscInt>(row))) {
            destroy_augmented_shift_solver(out);
            return false;
        }
    }
    for (int part = 0; part < 2; ++part) {
        const PetscInt q_offset = part == 0 ? 0 : q_imag;
        const PetscInt phi_offset = part == 0 ? phi_real : phi_imag;
        for (std::uint64_t row = 0; row < phi; ++row) {
            // Poisson rows: A_phiq q + P phi (+ w eta).
            columns.clear();
            values.clear();
            detail::append_csr_row(problem.A_phiq, row, q_offset, 1.0, &columns, &values);
            detail::append_csr_row(problem.A_phiphi, row, phi_offset, 1.0, &columns, &values);
            if (gauge_augmented) {
                columns.push_back(phi_offset + static_cast<PetscInt>(phi));
                values.push_back(static_cast<PetscScalar>(problem.phi_mean_weights[row]));
            }
            if (!insert_row(phi_offset + static_cast<PetscInt>(row))) {
                destroy_augmented_shift_solver(out);
                return false;
            }
        }
        if (gauge_augmented) {
            columns.clear();
            values.clear();
            for (std::uint64_t column = 0; column < phi; ++column) {
                columns.push_back(phi_offset + static_cast<PetscInt>(column));
                values.push_back(static_cast<PetscScalar>(problem.phi_mean_weights[column]));
            }
            columns.push_back(phi_offset + static_cast<PetscInt>(phi));
            values.push_back(static_cast<PetscScalar>(0.0));
            if (!insert_row(phi_offset + static_cast<PetscInt>(phi))) {
                destroy_augmented_shift_solver(out);
                return false;
            }
        }
    }
    if (MatAssemblyBegin(matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(matrix, MAT_FINAL_ASSEMBLY) != 0) {
        destroy_augmented_shift_solver(out);
        return false;
    }

    return augmented_shift_detail::factor_augmented_shift_matrix(2 * q_count, out);
}

namespace augmented_shift_detail {

// Factor out->matrix (already assembled, owned by `out`) with MUMPS and
// allocate the solve vectors.  On failure every resource is released.
inline bool factor_augmented_shift_matrix(PetscInt split_q_count, AugmentedShiftSolver *out)
{
    if (out == nullptr || out->matrix == nullptr) {
        return false;
    }
    Mat matrix = out->matrix;
    PetscInt rows = 0;
    PetscInt columns = 0;
    if (MatGetSize(matrix, &rows, &columns) != 0 || rows != columns ||
        split_q_count <= 0 || split_q_count >= rows) {
        destroy_augmented_shift_solver(out);
        return false;
    }
#if defined(PETSC_HAVE_MUMPS)
    PC pc = nullptr;
    // A failed factorization (for example MUMPS workspace exhaustion) is an
    // expected, recoverable outcome here: suppress PETSc's error traceback and
    // let the caller fall back to the magnetic-only preconditioner.
    PetscPushErrorHandler(PetscReturnErrorHandler, nullptr);
    bool factored =
        KSPCreate(PETSC_COMM_SELF, &out->ksp) == 0 &&
        KSPSetOperators(out->ksp, matrix, matrix) == 0 &&
        KSPSetType(out->ksp, KSPPREONLY) == 0 &&
        KSPGetPC(out->ksp, &pc) == 0 &&
        PCSetType(pc, PCLU) == 0 &&
        PCFactorSetMatSolverType(pc, MATSOLVERMUMPS) == 0 &&
        PCFactorSetUpMatSolverType(pc) == 0;
    Mat factor = nullptr;
    if (factored) {
        factored = PCFactorGetMatrix(pc, &factor) == 0;
    }
#if defined(PETSC_HAVE_METIS)
    if (factored) {
        factored = MatMumpsSetIcntl(factor, 7, 5) == 0;
    }
#endif
    if (factored) {
        // Extra workspace headroom for delayed pivots of the indefinite,
        // gyrotropic system (default 20%).
        factored = MatMumpsSetIcntl(factor, 14, 50) == 0 &&
            KSPSetErrorIfNotConverged(out->ksp, PETSC_TRUE) == 0 &&
            KSPSetUp(out->ksp) == 0;
    }
    if (factored) {
        PetscInt factor_entries = 0;
        if (MatMumpsGetInfog(factor, 29, &factor_entries) == 0 && factor_entries > 0) {
            out->factor_nonzeros = static_cast<std::uint64_t>(factor_entries);
        }
    }
    PetscPopErrorHandler();
    if (!factored ||
        VecCreateSeq(PETSC_COMM_SELF, rows, &out->rhs) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, rows, &out->solution) != 0) {
        destroy_augmented_shift_solver(out);
        return false;
    }
    out->split_q_count = split_q_count;
    out->dimension = rows;
    out->apply_count = 0;
    return true;
#else
    destroy_augmented_shift_solver(out);
    return false;
#endif
}

}  // namespace augmented_shift_detail

// Assemble K = [[top_left, top_right], [bottom_left, bottom_right]] from
// existing sequential AIJ blocks (borrowed, unchanged) and factor it.  Used by
// the Floquet lane, whose operator blocks already exist as PETSc matrices.
inline bool create_augmented_shift_solver_from_blocks(
    Mat top_left,
    Mat top_right,
    Mat bottom_left,
    Mat bottom_right,
    AugmentedShiftSolver *out)
{
    if (out == nullptr || !kAugmentedShiftSolverAvailable || top_left == nullptr ||
        top_right == nullptr || bottom_left == nullptr || bottom_right == nullptr) {
        return false;
    }
    destroy_augmented_shift_solver(out);
    PetscInt q_rows = 0, q_columns = 0, phi_rows = 0, phi_columns = 0;
    PetscInt tr_rows = 0, tr_columns = 0, bl_rows = 0, bl_columns = 0;
    if (MatGetSize(top_left, &q_rows, &q_columns) != 0 ||
        MatGetSize(bottom_right, &phi_rows, &phi_columns) != 0 ||
        MatGetSize(top_right, &tr_rows, &tr_columns) != 0 ||
        MatGetSize(bottom_left, &bl_rows, &bl_columns) != 0 ||
        q_rows != q_columns || phi_rows != phi_columns || q_rows <= 0 || phi_rows <= 0 ||
        tr_rows != q_rows || tr_columns != phi_rows ||
        bl_rows != phi_rows || bl_columns != q_rows) {
        return false;
    }
    Mat blocks[4] = {top_left, top_right, bottom_left, bottom_right};
    Mat nest = nullptr;
    if (MatCreateNest(PETSC_COMM_SELF, 2, nullptr, 2, nullptr, blocks, &nest) != 0) {
        return false;
    }
    const PetscErrorCode convert_error =
        MatConvert(nest, MATAIJ, MAT_INITIAL_MATRIX, &out->matrix);
    MatDestroy(&nest);
    if (convert_error != 0 || out->matrix == nullptr) {
        destroy_augmented_shift_solver(out);
        return false;
    }
    return augmented_shift_detail::factor_augmented_shift_matrix(q_rows, out);
}

// y = S_sigma^{-1} r: the q-block of K_sigma^{-1} [r; 0].
inline PetscErrorCode apply_augmented_shift_solver(AugmentedShiftSolver *solver, Vec r, Vec y)
{
    if (solver == nullptr || solver->ksp == nullptr || r == nullptr || y == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    PetscInt size = 0;
    if (VecGetSize(r, &size) != 0 || size != solver->split_q_count) {
        return PETSC_ERR_ARG_SIZ;
    }
    const PetscScalar *input = nullptr;
    PetscScalar *rhs = nullptr;
    if (VecGetArrayRead(r, &input) != 0) {
        return PETSC_ERR_LIB;
    }
    if (VecGetArray(solver->rhs, &rhs) != 0) {
        VecRestoreArrayRead(r, &input);
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < solver->split_q_count; ++index) {
        rhs[index] = input[index];
    }
    for (PetscInt index = solver->split_q_count; index < solver->dimension; ++index) {
        rhs[index] = static_cast<PetscScalar>(0.0);
    }
    VecRestoreArray(solver->rhs, &rhs);
    VecRestoreArrayRead(r, &input);
    if (KSPSolve(solver->ksp, solver->rhs, solver->solution) != 0) {
        return PETSC_ERR_NOT_CONVERGED;
    }
    ++solver->apply_count;
    const PetscScalar *solution = nullptr;
    PetscScalar *output = nullptr;
    if (VecGetArrayRead(solver->solution, &solution) != 0) {
        return PETSC_ERR_LIB;
    }
    if (VecGetArray(y, &output) != 0) {
        VecRestoreArrayRead(solver->solution, &solution);
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < solver->split_q_count; ++index) {
        output[index] = solution[index];
    }
    VecRestoreArray(y, &output);
    VecRestoreArrayRead(solver->solution, &solution);
    return 0;
}

inline PetscErrorCode augmented_shift_pc_apply(PC pc, Vec x, Vec y)
{
    void *raw = nullptr;
    if (PCShellGetContext(pc, &raw) != 0 || raw == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    return apply_augmented_shift_solver(static_cast<AugmentedShiftSolver *>(raw), x, y);
}

// Install the exact augmented solve as the shift-invert preconditioner.  The
// caller keeps ownership of `solver` and must keep it alive while `pc` can be
// applied (including when an EPS is intentionally leaked after a failed solve).
inline PetscErrorCode configure_augmented_shift_pc(PC pc, AugmentedShiftSolver *solver)
{
    PetscErrorCode error = PCSetType(pc, PCSHELL);
    if (error == 0) {
        error = PCShellSetContext(pc, solver);
    }
    if (error == 0) {
        error = PCShellSetApply(pc, augmented_shift_pc_apply);
    }
    if (error == 0) {
        error = PCShellSetName(pc, "k0_augmented_exact_shift_mumps");
    }
    return error;
}

}  // namespace fullmag::fem::frequency_domain

#endif  // FULLMAG_FEM_WITH_SLEPC
