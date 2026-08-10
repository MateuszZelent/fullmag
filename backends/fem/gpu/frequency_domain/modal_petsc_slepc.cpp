#include "frequency_domain/modal_gpu_krylov.hpp"

#include "frequency_domain/mode_kinematics.hpp"

#include <petscdevice.h>
#include <petscksp.h>
#include <slepceps.h>

#include <algorithm>
#include <cstdlib>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <vector>

namespace fullmag::fem::frequency_domain {
namespace {

using Complex = std::complex<double>;

void destroy_cached_gpu_context() noexcept;

void copy_message(char *destination, std::size_t size, const char *message) noexcept
{
    if (destination == nullptr || size == 0) {
        return;
    }
    std::strncpy(destination, message != nullptr ? message : "", size - 1);
    destination[size - 1] = '\0';
}

bool string_equals(const char *actual, const char *expected) noexcept
{
    return actual != nullptr && expected != nullptr && std::strcmp(actual, expected) == 0;
}

bool valid_csr(
    const CsrMatrixView &matrix,
    std::uint64_t rows,
    std::uint64_t columns) noexcept
{
    if (matrix.row_count != rows || matrix.column_count != columns ||
        matrix.row_offsets == nullptr || matrix.row_offsets_len != rows + 1u ||
        matrix.column_indices == nullptr || matrix.values == nullptr ||
        matrix.column_indices_len != matrix.values_len ||
        matrix.row_offsets[0] != 0u || matrix.row_offsets[rows] != matrix.values_len) {
        return false;
    }
    for (std::uint64_t row = 0; row < rows; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (matrix.column_indices[entry] >= columns || !std::isfinite(matrix.values[entry])) {
            return false;
        }
    }
    return true;
}

double csr_infinity_norm(const CsrMatrixView &matrix) noexcept
{
    double norm = 0.0;
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        double row_sum = 0.0;
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1u]; ++entry) {
            row_sum += std::abs(matrix.values[entry]);
        }
        norm = std::max(norm, row_sum);
    }
    return norm;
}

double transformed_eigensolver_tolerance(double certified_residual_tolerance) noexcept
{
    // The nondimensional pencil makes the EPS residual comparable to the
    // public full-descriptor residual. Reserve one decade of the public
    // certification budget for the transformed eigensolve; the independent
    // physical residual gate below remains authoritative.
    return std::max(
        1.0e-12,
        std::min(1.0e-6, 1.0e-1 * certified_residual_tolerance));
}

double inner_linear_tolerance(double certified_residual_tolerance) noexcept
{
    // Reserve a further decade for each shift-and-invert linear solve. A
    // relative tolerance is sufficient after nondimensionalization; an
    // absolute tolerance in the original SI scale caused false convergence.
    return std::max(
        1.0e-12,
        std::min(
            1.0e-7,
            1.0e-1 * transformed_eigensolver_tolerance(certified_residual_tolerance)));
}

std::mutex &gpu_slepc_mutex()
{
    static std::mutex mutex;
    return mutex;
}

bool &owns_slepc_initialization()
{
    static bool owns_initialization = false;
    return owns_initialization;
}

void finalize_owned_slepc() noexcept
{
    if (!owns_slepc_initialization()) {
        return;
    }
    destroy_cached_gpu_context();
    PetscBool finalized = PETSC_FALSE;
    if (PetscFinalized(&finalized) == PETSC_SUCCESS && finalized == PETSC_FALSE) {
        (void)SlepcFinalize();
    }
    owns_slepc_initialization() = false;
}

bool ensure_slepc_initialized(char error_message[256]) noexcept
{
    PetscBool initialized = PETSC_FALSE;
    if (SlepcInitialized(&initialized) != PETSC_SUCCESS) {
        copy_message(error_message, 256, "GPU K0 could not query SLEPc initialization state");
        return false;
    }
    if (initialized == PETSC_TRUE) {
        return true;
    }
    int argc = 3;
    char program[] = "fullmag-fem-gpu-k0";
    char option[] = "-use_gpu_aware_mpi";
    char value[] = "0";
    char *arguments[] = {program, option, value, nullptr};
    char **argv = arguments;
    if (SlepcInitialize(&argc, &argv, nullptr, nullptr) != PETSC_SUCCESS) {
        copy_message(error_message, 256, "GPU K0 SLEPc initialization failed");
        return false;
    }
    if (PetscDeviceInitialize(PETSC_DEVICE_CUDA) != PETSC_SUCCESS) {
        copy_message(error_message, 256, "GPU K0 CUDA device initialization failed");
        return false;
    }
    owns_slepc_initialization() = true;
    if (std::atexit(finalize_owned_slepc) != 0) {
        copy_message(error_message, 256, "GPU K0 could not register SLEPc finalization");
        (void)SlepcFinalize();
        owns_slepc_initialization() = false;
        return false;
    }
    return true;
}

PetscErrorCode create_cuda_vector(PetscInt size, Vec *vector)
{
    PetscFunctionBeginUser;
    PetscCall(VecCreate(PETSC_COMM_SELF, vector));
    PetscCall(VecSetSizes(*vector, PETSC_DECIDE, size));
    PetscCall(VecSetType(*vector, VECCUDA));
    PetscFunctionReturn(PETSC_SUCCESS);
}

bool create_cuda_csr_matrix(
    const CsrMatrixView &csr,
    Mat *matrix,
    std::uint64_t *setup_h2d_transfer_count = nullptr)
{
    if (matrix == nullptr ||
        csr.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        csr.column_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
        return false;
    }
    const PetscInt rows = static_cast<PetscInt>(csr.row_count);
    const PetscInt columns = static_cast<PetscInt>(csr.column_count);
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(rows), 0);
    for (PetscInt row = 0; row < rows; ++row) {
        const std::uint64_t count = csr.row_offsets[row + 1] - csr.row_offsets[row];
        if (count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(count);
    }
    if (MatCreate(PETSC_COMM_SELF, matrix) != PETSC_SUCCESS ||
        MatSetSizes(*matrix, PETSC_DECIDE, PETSC_DECIDE, rows, columns) != PETSC_SUCCESS ||
        MatSetType(*matrix, MATSEQAIJCUSPARSE) != PETSC_SUCCESS ||
        MatSeqAIJSetPreallocation(*matrix, 0, row_nonzeros.data()) != PETSC_SUCCESS ||
        MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != PETSC_SUCCESS) {
        return false;
    }
    for (PetscInt row = 0; row < rows; ++row) {
        for (std::uint32_t entry = csr.row_offsets[row]; entry < csr.row_offsets[row + 1]; ++entry) {
            if (MatSetValue(
                    *matrix,
                    row,
                    static_cast<PetscInt>(csr.column_indices[entry]),
                    static_cast<PetscScalar>(csr.values[entry]),
                    INSERT_VALUES) != PETSC_SUCCESS) {
                return false;
            }
        }
    }
    const bool assembled =
        MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) == PETSC_SUCCESS &&
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) == PETSC_SUCCESS;
    if (assembled && setup_h2d_transfer_count != nullptr) {
        ++*setup_h2d_transfer_count;
    }
    return assembled;
}

bool create_split_mass_cuda(
    const CsrMatrixView &mass,
    double scale,
    Mat *matrix,
    std::uint64_t *setup_h2d_transfer_count = nullptr)
{
    if (matrix == nullptr || !std::isfinite(scale) || scale <= 0.0 ||
        mass.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) / 2u) {
        return false;
    }
    const PetscInt base = static_cast<PetscInt>(mass.row_count);
    const PetscInt dimension = 2 * base;
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(dimension), 1);
    for (PetscInt row = 0; row < base; ++row) {
        const PetscInt count = static_cast<PetscInt>(
            mass.row_offsets[row + 1] - mass.row_offsets[row]);
        row_nonzeros[static_cast<std::size_t>(row)] = count + 1;
        row_nonzeros[static_cast<std::size_t>(row + base)] = count + 1;
    }
    if (MatCreate(PETSC_COMM_SELF, matrix) != PETSC_SUCCESS ||
        MatSetSizes(*matrix, PETSC_DECIDE, PETSC_DECIDE, dimension, dimension) != PETSC_SUCCESS ||
        MatSetType(*matrix, MATSEQAIJCUSPARSE) != PETSC_SUCCESS ||
        MatSeqAIJSetPreallocation(*matrix, 0, row_nonzeros.data()) != PETSC_SUCCESS ||
        MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != PETSC_SUCCESS) {
        return false;
    }
    for (PetscInt row = 0; row < base; ++row) {
        for (std::uint32_t entry = mass.row_offsets[row]; entry < mass.row_offsets[row + 1]; ++entry) {
            const PetscInt column = static_cast<PetscInt>(mass.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(scale * mass.values[entry]);
            if (MatSetValue(*matrix, row, column + base, -value, INSERT_VALUES) != PETSC_SUCCESS ||
                MatSetValue(*matrix, row + base, column, value, INSERT_VALUES) != PETSC_SUCCESS) {
                return false;
            }
        }
        if (MatSetValue(*matrix, row, row, 0.0, INSERT_VALUES) != PETSC_SUCCESS ||
            MatSetValue(*matrix, row + base, row + base, 0.0, INSERT_VALUES) != PETSC_SUCCESS) {
            return false;
        }
    }
    const bool assembled =
        MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) == PETSC_SUCCESS &&
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) == PETSC_SUCCESS;
    if (assembled && setup_h2d_transfer_count != nullptr) {
        ++*setup_h2d_transfer_count;
    }
    return assembled;
}

bool create_hypre_shift_preconditioner_cuda(
    const CsrMatrixView &a_qq,
    const CsrMatrixView &mass,
    double shift,
    double scale,
    Mat *matrix)
{
    if (matrix == nullptr || !std::isfinite(shift) ||
        !std::isfinite(scale) || scale <= 0.0 ||
        a_qq.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) / 2u) {
        return false;
    }
    const PetscInt base = static_cast<PetscInt>(a_qq.row_count);
    const PetscInt dimension = 2 * base;
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(dimension), 0);
    for (PetscInt row = 0; row < base; ++row) {
        const PetscInt a_count = static_cast<PetscInt>(
            a_qq.row_offsets[row + 1] - a_qq.row_offsets[row]);
        const PetscInt b_count = static_cast<PetscInt>(
            mass.row_offsets[row + 1] - mass.row_offsets[row]);
        row_nonzeros[static_cast<std::size_t>(row)] = a_count + b_count + 1;
        row_nonzeros[static_cast<std::size_t>(row + base)] = a_count + b_count + 1;
    }
    if (MatCreate(PETSC_COMM_SELF, matrix) != PETSC_SUCCESS ||
        MatSetSizes(*matrix, PETSC_DECIDE, PETSC_DECIDE, dimension, dimension) != PETSC_SUCCESS ||
        MatSetType(*matrix, MATSEQAIJCUSPARSE) != PETSC_SUCCESS ||
        MatSeqAIJSetPreallocation(*matrix, 0, row_nonzeros.data()) != PETSC_SUCCESS ||
        MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != PETSC_SUCCESS) {
        return false;
    }
    for (PetscInt row = 0; row < base; ++row) {
        for (std::uint32_t entry = a_qq.row_offsets[row]; entry < a_qq.row_offsets[row + 1]; ++entry) {
            const PetscInt column = static_cast<PetscInt>(a_qq.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(scale * a_qq.values[entry]);
            if (MatSetValue(*matrix, row, column, value, ADD_VALUES) != PETSC_SUCCESS ||
                MatSetValue(*matrix, row + base, column + base, value, ADD_VALUES) != PETSC_SUCCESS) {
                return false;
            }
        }
        for (std::uint32_t entry = mass.row_offsets[row]; entry < mass.row_offsets[row + 1]; ++entry) {
            const PetscInt column = static_cast<PetscInt>(mass.column_indices[entry]);
            const PetscScalar value =
                static_cast<PetscScalar>(scale * shift * mass.values[entry]);
            if (MatSetValue(*matrix, row, column + base, value, ADD_VALUES) != PETSC_SUCCESS ||
                MatSetValue(*matrix, row + base, column, -value, ADD_VALUES) != PETSC_SUCCESS) {
                return false;
            }
        }
        if (MatSetValue(*matrix, row, row, 0.0, ADD_VALUES) != PETSC_SUCCESS ||
            MatSetValue(*matrix, row + base, row + base, 0.0, ADD_VALUES) != PETSC_SUCCESS) {
            return false;
        }
    }
    return MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) == PETSC_SUCCESS &&
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) == PETSC_SUCCESS;
}

struct GpuSchurContext {
    Mat a_qq = nullptr;
    Mat a_qphi = nullptr;
    Mat a_phiq = nullptr;
    Mat poisson = nullptr;
    KSP poisson_ksp = nullptr;
    Vec phi_rhs = nullptr;
    Vec phi_solution = nullptr;
    Vec feedback = nullptr;
    PetscInt q_count = 0;
    PetscInt phi_count = 0;
    std::uint64_t setup_h2d_transfer_count = 0;
    std::uint64_t operator_apply_count = 0;
    std::uint64_t poisson_solve_count = 0;
    std::uint64_t poisson_iteration_count = 0;
    char error_message[256]{};
};

struct GpuSplitContext {
    GpuSchurContext *schur = nullptr;
    Vec shell_template = nullptr;
    Vec q_real = nullptr;
    Vec q_imag = nullptr;
    Vec y_real = nullptr;
    Vec y_imag = nullptr;
    Vec phi_real = nullptr;
    Vec phi_imag = nullptr;
    IS real_is = nullptr;
    IS imag_is = nullptr;
    VecScatter real_scatter = nullptr;
    VecScatter imag_scatter = nullptr;
    double operator_scale = 1.0;
};

struct GpuEpsControl {
    const PoissonAirboxEigenBlockProblem *problem = nullptr;
    std::uint32_t monitor_iteration_count = 0;
    std::uint32_t last_converged_count = 0;
    double last_error_estimate = 0.0;
    bool cancellation_observed = false;
};

PetscErrorCode gpu_modal_ksp_convergence_test(
    KSP ksp,
    PetscInt iteration,
    PetscReal residual_norm,
    KSPConvergedReason *reason,
    void *raw_problem)
{
    PetscFunctionBeginUser;
    auto *problem = static_cast<const PoissonAirboxEigenBlockProblem *>(raw_problem);
    PetscCheck(problem != nullptr, PETSC_COMM_SELF, PETSC_ERR_ARG_NULL,
               "missing GPU modal callback problem");
    if (poisson_airbox_modal_cancel_requested(*problem)) {
        if (reason != nullptr) {
            *reason = KSP_DIVERGED_USER;
        }
        poisson_airbox_modal_emit_progress(
            *problem,
            "cancelling_shift_invert",
            "production_gpu",
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            0,
            0,
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            static_cast<double>(residual_norm),
            "cancel_requested");
        PetscFunctionReturn(PETSC_SUCCESS);
    }
    PetscCall(KSPConvergedDefault(ksp, iteration, residual_norm, reason, nullptr));
    poisson_airbox_modal_emit_progress(
        *problem,
        "solving_shift_invert",
        "production_gpu",
        static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
        0,
        0,
        static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
        static_cast<double>(residual_norm));
    PetscFunctionReturn(PETSC_SUCCESS);
}

PetscErrorCode gpu_modal_eps_monitor(
    EPS,
    PetscInt iteration,
    PetscInt converged,
    PetscScalar[],
    PetscScalar[],
    PetscReal error_estimates[],
    PetscInt estimate_count,
    void *raw_control)
{
    PetscFunctionBeginUser;
    auto *control = static_cast<GpuEpsControl *>(raw_control);
    PetscCheck(control != nullptr && control->problem != nullptr,
               PETSC_COMM_SELF,
               PETSC_ERR_ARG_NULL,
               "missing GPU modal EPS monitor context");
    control->monitor_iteration_count = static_cast<std::uint32_t>(
        std::min<PetscInt>(std::max<PetscInt>(0, iteration),
                           static_cast<PetscInt>(std::numeric_limits<std::uint32_t>::max())));
    control->last_converged_count = static_cast<std::uint32_t>(
        std::min<PetscInt>(std::max<PetscInt>(0, converged),
                           static_cast<PetscInt>(std::numeric_limits<std::uint32_t>::max())));
    if (error_estimates != nullptr && estimate_count > 0 &&
        std::isfinite(static_cast<double>(error_estimates[0]))) {
        control->last_error_estimate = static_cast<double>(error_estimates[0]);
    }
    poisson_airbox_modal_emit_progress(
        *control->problem,
        "solving_eigensystem",
        "production_gpu",
        control->monitor_iteration_count,
        control->last_converged_count,
        0,
        0,
        control->last_error_estimate);
    PetscFunctionReturn(PETSC_SUCCESS);
}

PetscErrorCode gpu_modal_eps_stopping_test(
    EPS eps,
    PetscInt iteration,
    PetscInt max_iterations,
    PetscInt converged,
    PetscInt requested,
    EPSConvergedReason *reason,
    void *raw_control)
{
    PetscFunctionBeginUser;
    auto *control = static_cast<GpuEpsControl *>(raw_control);
    PetscCheck(control != nullptr && control->problem != nullptr && reason != nullptr,
               PETSC_COMM_SELF,
               PETSC_ERR_ARG_NULL,
               "missing GPU modal EPS stopping context");
    PetscCall(EPSStoppingBasic(
        eps,
        iteration,
        max_iterations,
        converged,
        requested,
        reason,
        nullptr));
    if (poisson_airbox_modal_cancel_requested(*control->problem)) {
        control->cancellation_observed = true;
        *reason = EPS_CONVERGED_USER;
        poisson_airbox_modal_emit_progress(
            *control->problem,
            "cancelling_eigensystem",
            "production_gpu",
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            static_cast<std::uint32_t>(std::max<PetscInt>(0, converged)),
            0,
            0,
            control->last_error_estimate,
            "cancel_requested");
    }
    PetscFunctionReturn(PETSC_SUCCESS);
}

const char *gpu_eps_reason_name(EPSConvergedReason reason, bool cancelled) noexcept
{
    if (cancelled) {
        return "cancel_requested";
    }
    switch (reason) {
    case EPS_CONVERGED_TOL:
        return "converged_tolerance";
    case EPS_CONVERGED_USER:
        return "converged_user";
    case EPS_DIVERGED_ITS:
        return "diverged_max_iterations";
    case EPS_DIVERGED_BREAKDOWN:
        return "diverged_breakdown";
    case EPS_DIVERGED_SYMMETRY_LOST:
        return "diverged_symmetry_lost";
    case EPS_CONVERGED_ITERATING:
    default:
        return "unknown";
    }
}

void destroy_schur_context(GpuSchurContext *context) noexcept
{
    if (context == nullptr) {
        return;
    }
    if (context->feedback) VecDestroy(&context->feedback);
    if (context->phi_solution) VecDestroy(&context->phi_solution);
    if (context->phi_rhs) VecDestroy(&context->phi_rhs);
    if (context->poisson_ksp) KSPDestroy(&context->poisson_ksp);
    if (context->poisson) MatDestroy(&context->poisson);
    if (context->a_phiq) MatDestroy(&context->a_phiq);
    if (context->a_qphi) MatDestroy(&context->a_qphi);
    if (context->a_qq) MatDestroy(&context->a_qq);
}

void destroy_split_context(GpuSplitContext *context) noexcept
{
    if (context == nullptr) {
        return;
    }
    if (context->imag_scatter) VecScatterDestroy(&context->imag_scatter);
    if (context->real_scatter) VecScatterDestroy(&context->real_scatter);
    if (context->imag_is) ISDestroy(&context->imag_is);
    if (context->real_is) ISDestroy(&context->real_is);
    if (context->phi_imag) VecDestroy(&context->phi_imag);
    if (context->phi_real) VecDestroy(&context->phi_real);
    if (context->y_imag) VecDestroy(&context->y_imag);
    if (context->y_real) VecDestroy(&context->y_real);
    if (context->q_imag) VecDestroy(&context->q_imag);
    if (context->q_real) VecDestroy(&context->q_real);
    if (context->shell_template) VecDestroy(&context->shell_template);
}

bool configure_schur_context(
    const PoissonAirboxEigenBlockProblem &problem,
    GpuSchurContext *context)
{
    context->q_count = static_cast<PetscInt>(problem.q_dof_count);
    context->phi_count = static_cast<PetscInt>(problem.phi_dof_count);
    if (!create_cuda_csr_matrix(
            problem.A_qq,
            &context->a_qq,
            &context->setup_h2d_transfer_count) ||
        !create_cuda_csr_matrix(
            problem.A_qphi,
            &context->a_qphi,
            &context->setup_h2d_transfer_count) ||
        !create_cuda_csr_matrix(
            problem.A_phiq,
            &context->a_phiq,
            &context->setup_h2d_transfer_count) ||
        !create_cuda_csr_matrix(
            problem.A_phiphi,
            &context->poisson,
            &context->setup_h2d_transfer_count)) {
        return false;
    }
    PC pc = nullptr;
    if (KSPCreate(PETSC_COMM_SELF, &context->poisson_ksp) != PETSC_SUCCESS ||
        KSPSetOperators(context->poisson_ksp, context->poisson, context->poisson) != PETSC_SUCCESS ||
        KSPSetType(context->poisson_ksp, KSPCG) != PETSC_SUCCESS ||
        KSPGetPC(context->poisson_ksp, &pc) != PETSC_SUCCESS ||
        PCSetType(pc, PCHYPRE) != PETSC_SUCCESS ||
        PCHYPRESetType(pc, "boomeramg") != PETSC_SUCCESS ||
        KSPSetTolerances(
            context->poisson_ksp,
            inner_linear_tolerance(problem.residual_tolerance),
            1.0e-14,
            PETSC_DEFAULT,
            std::max<PetscInt>(256, static_cast<PetscInt>(problem.max_linear_iterations))) != PETSC_SUCCESS ||
        KSPSetUp(context->poisson_ksp) != PETSC_SUCCESS ||
        create_cuda_vector(context->phi_count, &context->phi_rhs) != PETSC_SUCCESS ||
        create_cuda_vector(context->phi_count, &context->phi_solution) != PETSC_SUCCESS ||
        create_cuda_vector(context->q_count, &context->feedback) != PETSC_SUCCESS) {
        return false;
    }
    return true;
}

PetscErrorCode apply_schur(GpuSchurContext *context, Vec q, Vec y, Vec phi_output = nullptr)
{
    PetscFunctionBeginUser;
    PetscCheck(context != nullptr, PETSC_COMM_SELF, PETSC_ERR_ARG_NULL,
               "missing GPU Schur context");
    ++context->operator_apply_count;
    PetscCall(MatMult(context->a_qq, q, y));
    PetscCall(MatMult(context->a_phiq, q, context->phi_rhs));
    PetscCall(VecScale(context->phi_rhs, -1.0));
    PetscCall(KSPSolve(context->poisson_ksp, context->phi_rhs, context->phi_solution));
    ++context->poisson_solve_count;
    PetscInt poisson_iterations = 0;
    PetscCall(KSPGetIterationNumber(context->poisson_ksp, &poisson_iterations));
    if (poisson_iterations > 0) {
        context->poisson_iteration_count += static_cast<std::uint64_t>(poisson_iterations);
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    PetscCall(KSPGetConvergedReason(context->poisson_ksp, &reason));
    PetscCheck(reason > 0, PETSC_COMM_SELF, PETSC_ERR_NOT_CONVERGED,
               "GPU K0 Poisson solve did not converge");
    PetscCall(MatMult(context->a_qphi, context->phi_solution, context->feedback));
    PetscCall(VecAXPY(y, 1.0, context->feedback));
    if (phi_output != nullptr) {
        PetscCall(VecCopy(context->phi_solution, phi_output));
    }
    PetscFunctionReturn(PETSC_SUCCESS);
}

// The accepted-mode residual must be evaluated in the same device-resident
// block algebra as the eigensolver.  Keeping this workspace separate from the
// Schur context makes its lifetime explicit and lets every candidate reuse the
// same PETSc CUDA vectors without a host reconstruction.
struct DeviceModalResidualWorkspace {
    Vec a_qq_real = nullptr;
    Vec a_qq_imag = nullptr;
    Vec a_qphi_real = nullptr;
    Vec a_qphi_imag = nullptr;
    Vec b_qq_real = nullptr;
    Vec b_qq_imag = nullptr;
    Vec q_residual_real = nullptr;
    Vec q_residual_imag = nullptr;
    Vec a_phiq_real = nullptr;
    Vec a_phiq_imag = nullptr;
    Vec a_phiphi_real = nullptr;
    Vec a_phiphi_imag = nullptr;
    Vec phi_residual_real = nullptr;
    Vec phi_residual_imag = nullptr;
};

void destroy_device_modal_residual_workspace(DeviceModalResidualWorkspace *workspace) noexcept
{
    if (workspace == nullptr) {
        return;
    }
    if (workspace->phi_residual_imag) VecDestroy(&workspace->phi_residual_imag);
    if (workspace->phi_residual_real) VecDestroy(&workspace->phi_residual_real);
    if (workspace->a_phiphi_imag) VecDestroy(&workspace->a_phiphi_imag);
    if (workspace->a_phiphi_real) VecDestroy(&workspace->a_phiphi_real);
    if (workspace->a_phiq_imag) VecDestroy(&workspace->a_phiq_imag);
    if (workspace->a_phiq_real) VecDestroy(&workspace->a_phiq_real);
    if (workspace->q_residual_imag) VecDestroy(&workspace->q_residual_imag);
    if (workspace->q_residual_real) VecDestroy(&workspace->q_residual_real);
    if (workspace->b_qq_imag) VecDestroy(&workspace->b_qq_imag);
    if (workspace->b_qq_real) VecDestroy(&workspace->b_qq_real);
    if (workspace->a_qphi_imag) VecDestroy(&workspace->a_qphi_imag);
    if (workspace->a_qphi_real) VecDestroy(&workspace->a_qphi_real);
    if (workspace->a_qq_imag) VecDestroy(&workspace->a_qq_imag);
    if (workspace->a_qq_real) VecDestroy(&workspace->a_qq_real);
}

bool create_device_modal_residual_workspace(
    const GpuSplitContext *split,
    DeviceModalResidualWorkspace *workspace)
{
    if (split == nullptr || workspace == nullptr) {
        return false;
    }
    const PetscInt q_count = split->schur->q_count;
    const PetscInt phi_count = split->schur->phi_count;
    const bool created =
        create_cuda_vector(q_count, &workspace->a_qq_real) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->a_qq_imag) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->a_qphi_real) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->a_qphi_imag) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->b_qq_real) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->b_qq_imag) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->q_residual_real) == PETSC_SUCCESS &&
        create_cuda_vector(q_count, &workspace->q_residual_imag) == PETSC_SUCCESS &&
        create_cuda_vector(phi_count, &workspace->a_phiq_real) == PETSC_SUCCESS &&
        create_cuda_vector(phi_count, &workspace->a_phiq_imag) == PETSC_SUCCESS &&
        create_cuda_vector(phi_count, &workspace->a_phiphi_real) == PETSC_SUCCESS &&
        create_cuda_vector(phi_count, &workspace->a_phiphi_imag) == PETSC_SUCCESS &&
        create_cuda_vector(phi_count, &workspace->phi_residual_real) == PETSC_SUCCESS &&
        create_cuda_vector(phi_count, &workspace->phi_residual_imag) == PETSC_SUCCESS;
    if (!created) {
        destroy_device_modal_residual_workspace(workspace);
    }
    return created;
}

PetscErrorCode complex_device_l2_norm(Vec real, Vec imag, double *out_norm)
{
    PetscReal real_norm = 0.0;
    PetscReal imag_norm = 0.0;
    PetscFunctionBeginUser;
    PetscCheck(out_norm != nullptr, PETSC_COMM_SELF, PETSC_ERR_ARG_NULL,
               "missing device complex norm output");
    PetscCall(VecNorm(real, NORM_2, &real_norm));
    PetscCall(VecNorm(imag, NORM_2, &imag_norm));
    *out_norm = std::hypot(static_cast<double>(real_norm), static_cast<double>(imag_norm));
    PetscFunctionReturn(PETSC_SUCCESS);
}

PetscErrorCode device_modal_residual_metrics(
    const PoissonAirboxEigenBlockProblem &problem,
    GpuSchurContext *schur,
    GpuSplitContext *split,
    DeviceModalResidualWorkspace *workspace,
    double omega,
    double slepc_reported_backward_error,
    PoissonAirboxModalResidualMetrics *out_metrics)
{
    PetscFunctionBeginUser;
    PetscCheck(schur != nullptr && split != nullptr && workspace != nullptr &&
                   out_metrics != nullptr,
               PETSC_COMM_SELF,
               PETSC_ERR_ARG_NULL,
               "missing device modal residual context");
    PetscCheck(string_equals(problem.gauge_policy, "none"), PETSC_COMM_SELF,
               PETSC_ERR_SUP, "device modal residual currently requires gauge_policy=none");
    PetscCheck(std::isfinite(omega) && std::isfinite(slepc_reported_backward_error) &&
                   slepc_reported_backward_error >= 0.0,
               PETSC_COMM_SELF,
               PETSC_ERR_ARG_OUTOFRANGE,
               "invalid device modal residual scalar");

    PetscCall(MatMult(schur->a_qq, split->q_real, workspace->a_qq_real));
    PetscCall(MatMult(schur->a_qq, split->q_imag, workspace->a_qq_imag));
    PetscCall(MatMult(schur->a_qphi, split->phi_real, workspace->a_qphi_real));
    PetscCall(MatMult(schur->a_qphi, split->phi_imag, workspace->a_qphi_imag));
    PetscCall(MatMult(schur->b_qq, split->q_real, workspace->b_qq_real));
    PetscCall(MatMult(schur->b_qq, split->q_imag, workspace->b_qq_imag));
    PetscCall(MatMult(schur->a_phiq, split->q_real, workspace->a_phiq_real));
    PetscCall(MatMult(schur->a_phiq, split->q_imag, workspace->a_phiq_imag));
    PetscCall(MatMult(schur->poisson, split->phi_real, workspace->a_phiphi_real));
    PetscCall(MatMult(schur->poisson, split->phi_imag, workspace->a_phiphi_imag));

    // lambda = i*omega for the public exp(+i omega t) convention:
    // -lambda B(qr+i qi) = omega B qi - i omega B qr.
    PetscCall(VecCopy(workspace->a_qq_real, workspace->q_residual_real));
    PetscCall(VecAXPY(workspace->q_residual_real, 1.0, workspace->a_qphi_real));
    PetscCall(VecAXPY(workspace->q_residual_real, omega, workspace->b_qq_imag));
    PetscCall(VecCopy(workspace->a_qq_imag, workspace->q_residual_imag));
    PetscCall(VecAXPY(workspace->q_residual_imag, 1.0, workspace->a_qphi_imag));
    PetscCall(VecAXPY(workspace->q_residual_imag, -omega, workspace->b_qq_real));

    PetscCall(VecCopy(workspace->a_phiq_real, workspace->phi_residual_real));
    PetscCall(VecAXPY(workspace->phi_residual_real, 1.0, workspace->a_phiphi_real));
    PetscCall(VecCopy(workspace->a_phiq_imag, workspace->phi_residual_imag));
    PetscCall(VecAXPY(workspace->phi_residual_imag, 1.0, workspace->a_phiphi_imag));

    double a_qq_norm = 0.0;
    double a_qphi_norm = 0.0;
    double b_qq_norm = 0.0;
    double q_residual_norm = 0.0;
    double phi_residual_norm = 0.0;
    double a_phiq_norm = 0.0;
    double a_phiphi_norm = 0.0;
    PetscCall(complex_device_l2_norm(
        workspace->a_qq_real, workspace->a_qq_imag, &a_qq_norm));
    PetscCall(complex_device_l2_norm(
        workspace->a_qphi_real, workspace->a_qphi_imag, &a_qphi_norm));
    PetscCall(complex_device_l2_norm(
        workspace->b_qq_real, workspace->b_qq_imag, &b_qq_norm));
    PetscCall(complex_device_l2_norm(
        workspace->q_residual_real, workspace->q_residual_imag, &q_residual_norm));
    PetscCall(complex_device_l2_norm(
        workspace->phi_residual_real, workspace->phi_residual_imag, &phi_residual_norm));
    PetscCall(complex_device_l2_norm(
        workspace->a_phiq_real, workspace->a_phiq_imag, &a_phiq_norm));
    PetscCall(complex_device_l2_norm(
        workspace->a_phiphi_real, workspace->a_phiphi_imag, &a_phiphi_norm));

    const double lambda_abs = std::abs(omega);
    const double q_relative = q_residual_norm /
        (a_qq_norm + a_qphi_norm + lambda_abs * b_qq_norm + 1.0e-30);
    const double phi_relative = phi_residual_norm /
        (a_phiq_norm + a_phiphi_norm + 1.0e-30);
    out_metrics->slepc_reported_backward_error = slepc_reported_backward_error;
    out_metrics->reconstructed_full_descriptor_backward_error =
        std::max(q_relative, phi_relative);
    out_metrics->magnetic_block_backward_error = q_relative;
    out_metrics->poisson_block_backward_error = phi_relative;
    out_metrics->gauge_constraint_backward_error = 0.0;
    out_metrics->gauge_mean_abs = 0.0;
    if (slepc_reported_backward_error > 0.0) {
        out_metrics->reconstruction_vs_slepc_ratio = std::min(
            out_metrics->reconstructed_full_descriptor_backward_error /
                slepc_reported_backward_error,
            std::numeric_limits<double>::max());
    } else {
        out_metrics->reconstruction_vs_slepc_ratio =
            out_metrics->reconstructed_full_descriptor_backward_error == 0.0
                ? 1.0
                : std::numeric_limits<double>::max();
    }
    PetscCheck(std::isfinite(out_metrics->reconstructed_full_descriptor_backward_error) &&
                   std::isfinite(out_metrics->reconstruction_vs_slepc_ratio) &&
                   std::isfinite(out_metrics->magnetic_block_backward_error) &&
                   std::isfinite(out_metrics->poisson_block_backward_error),
               PETSC_COMM_SELF,
               PETSC_ERR_FP,
               "device modal residual is non-finite");
    PetscFunctionReturn(PETSC_SUCCESS);
}

bool configure_split_context(GpuSchurContext *schur, GpuSplitContext *context)
{
    context->schur = schur;
    const PetscInt n = schur->q_count;
    if (create_cuda_vector(2 * n, &context->shell_template) != PETSC_SUCCESS ||
        create_cuda_vector(n, &context->q_real) != PETSC_SUCCESS ||
        create_cuda_vector(n, &context->q_imag) != PETSC_SUCCESS ||
        create_cuda_vector(n, &context->y_real) != PETSC_SUCCESS ||
        create_cuda_vector(n, &context->y_imag) != PETSC_SUCCESS ||
        create_cuda_vector(schur->phi_count, &context->phi_real) != PETSC_SUCCESS ||
        create_cuda_vector(schur->phi_count, &context->phi_imag) != PETSC_SUCCESS ||
        ISCreateStride(PETSC_COMM_SELF, n, 0, 1, &context->real_is) != PETSC_SUCCESS ||
        ISCreateStride(PETSC_COMM_SELF, n, n, 1, &context->imag_is) != PETSC_SUCCESS ||
        VecScatterCreate(
            context->shell_template,
            context->real_is,
            context->q_real,
            nullptr,
            &context->real_scatter) != PETSC_SUCCESS ||
        VecScatterCreate(
            context->shell_template,
            context->imag_is,
            context->q_imag,
            nullptr,
            &context->imag_scatter) != PETSC_SUCCESS) {
        return false;
    }
    return true;
}

struct GpuPersistentContext {
    GpuSchurContext schur{};
    GpuSplitContext split{};
    // Modal candidate extraction and full descriptor residual checks run after
    // SLEPc returns a batch of vectors.  Keep their CUDA vectors attached to
    // the exact operator context so repeated solves/window sub-solves do not
    // allocate device storage in the extraction loop.
    DeviceModalResidualWorkspace residual_workspace{};
    Vec action_probe = nullptr;
    Vec mass_action_probe = nullptr;
    Vec residual_probe = nullptr;
    std::uint64_t operator_signature = 0;
};

GpuPersistentContext *&cached_gpu_context() noexcept
{
    static GpuPersistentContext *context = nullptr;
    return context;
}

std::uint64_t fnv1a_update(
    std::uint64_t hash,
    const void *data,
    std::size_t size) noexcept
{
    constexpr std::uint64_t kFnvPrime = 1099511628211ull;
    const auto *bytes = static_cast<const unsigned char *>(data);
    for (std::size_t index = 0; index < size; ++index) {
        hash ^= static_cast<std::uint64_t>(bytes[index]);
        hash *= kFnvPrime;
    }
    return hash;
}

template <typename T>
std::uint64_t fnv1a_value(std::uint64_t hash, const T &value) noexcept
{
    return fnv1a_update(hash, &value, sizeof(value));
}

std::uint64_t fnv1a_csr(
    std::uint64_t hash,
    const CsrMatrixView &matrix) noexcept
{
    hash = fnv1a_value(hash, matrix.row_count);
    hash = fnv1a_value(hash, matrix.column_count);
    hash = fnv1a_update(
        hash,
        matrix.row_offsets,
        static_cast<std::size_t>(matrix.row_offsets_len) * sizeof(matrix.row_offsets[0]));
    hash = fnv1a_update(
        hash,
        matrix.column_indices,
        static_cast<std::size_t>(matrix.column_indices_len) * sizeof(matrix.column_indices[0]));
    return fnv1a_update(
        hash,
        matrix.values,
        static_cast<std::size_t>(matrix.values_len) * sizeof(matrix.values[0]));
}

std::uint64_t modal_operator_signature(
    const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    constexpr std::uint64_t kFnvOffset = 1469598103934665603ull;
    std::uint64_t hash = kFnvOffset;
    hash = fnv1a_value(hash, problem.q_dof_count);
    hash = fnv1a_value(hash, problem.phi_dof_count);
    hash = fnv1a_csr(hash, problem.A_qq);
    hash = fnv1a_csr(hash, problem.A_qphi);
    hash = fnv1a_csr(hash, problem.A_phiq);
    hash = fnv1a_csr(hash, problem.A_phiphi);
    hash = fnv1a_csr(hash, problem.B_qq);
    hash = fnv1a_value(hash, problem.residual_tolerance);
    hash = fnv1a_value(hash, problem.max_linear_iterations);
    return hash;
}

void destroy_cached_gpu_context() noexcept
{
    auto *context = cached_gpu_context();
    if (context == nullptr) {
        return;
    }
    if (context->residual_probe) VecDestroy(&context->residual_probe);
    if (context->mass_action_probe) VecDestroy(&context->mass_action_probe);
    if (context->action_probe) VecDestroy(&context->action_probe);
    destroy_device_modal_residual_workspace(&context->residual_workspace);
    destroy_split_context(&context->split);
    destroy_schur_context(&context->schur);
    delete context;
    cached_gpu_context() = nullptr;
}

GpuPersistentContext *acquire_cached_gpu_context(
    const PoissonAirboxEigenBlockProblem &problem,
    bool *reused) noexcept
{
    if (reused != nullptr) {
        *reused = false;
    }
    const std::uint64_t signature = modal_operator_signature(problem);
    auto *cached = cached_gpu_context();
    if (cached != nullptr && cached->operator_signature == signature) {
        if (reused != nullptr) {
            *reused = true;
        }
        return cached;
    }
    if (cached != nullptr) {
        destroy_cached_gpu_context();
    }
    auto *created = new (std::nothrow) GpuPersistentContext{};
    if (created == nullptr ||
        !configure_schur_context(problem, &created->schur) ||
        !configure_split_context(&created->schur, &created->split) ||
        !create_device_modal_residual_workspace(
            &created->split, &created->residual_workspace) ||
        VecDuplicate(created->split.shell_template, &created->action_probe) != PETSC_SUCCESS ||
        VecDuplicate(created->split.shell_template, &created->mass_action_probe) != PETSC_SUCCESS ||
        VecDuplicate(created->split.shell_template, &created->residual_probe) != PETSC_SUCCESS) {
        if (created != nullptr) {
            if (created->residual_probe) VecDestroy(&created->residual_probe);
            if (created->mass_action_probe) VecDestroy(&created->mass_action_probe);
            if (created->action_probe) VecDestroy(&created->action_probe);
            destroy_device_modal_residual_workspace(&created->residual_workspace);
            destroy_split_context(&created->split);
            destroy_schur_context(&created->schur);
            delete created;
        }
        return nullptr;
    }
    created->operator_signature = signature;
    cached_gpu_context() = created;
    static bool cleanup_registered = false;
    if (!cleanup_registered) {
        cleanup_registered = std::atexit(destroy_cached_gpu_context) == 0;
    }
    return created;
}

PetscErrorCode scatter_split_input(GpuSplitContext *context, Vec x)
{
    PetscFunctionBeginUser;
    PetscCall(VecScatterBegin(
        context->real_scatter, x, context->q_real, INSERT_VALUES, SCATTER_FORWARD));
    PetscCall(VecScatterEnd(
        context->real_scatter, x, context->q_real, INSERT_VALUES, SCATTER_FORWARD));
    PetscCall(VecScatterBegin(
        context->imag_scatter, x, context->q_imag, INSERT_VALUES, SCATTER_FORWARD));
    PetscCall(VecScatterEnd(
        context->imag_scatter, x, context->q_imag, INSERT_VALUES, SCATTER_FORWARD));
    PetscFunctionReturn(PETSC_SUCCESS);
}

PetscErrorCode split_schur_matmult(Mat matrix, Vec x, Vec y)
{
    void *raw = nullptr;
    PetscFunctionBeginUser;
    PetscCall(MatShellGetContext(matrix, &raw));
    PetscCheck(raw != nullptr, PETSC_COMM_SELF, PETSC_ERR_ARG_NULL, "missing GPU K0 shell context");
    auto *context = static_cast<GpuSplitContext *>(raw);
    PetscCall(scatter_split_input(context, x));
    PetscCall(apply_schur(context->schur, context->q_real, context->y_real));
    PetscCall(apply_schur(context->schur, context->q_imag, context->y_imag));
    PetscCall(VecSet(y, 0.0));
    PetscCall(VecScatterBegin(
        context->real_scatter, context->y_real, y, INSERT_VALUES, SCATTER_REVERSE));
    PetscCall(VecScatterEnd(
        context->real_scatter, context->y_real, y, INSERT_VALUES, SCATTER_REVERSE));
    PetscCall(VecScatterBegin(
        context->imag_scatter, context->y_imag, y, INSERT_VALUES, SCATTER_REVERSE));
    PetscCall(VecScatterEnd(
        context->imag_scatter, context->y_imag, y, INSERT_VALUES, SCATTER_REVERSE));
    PetscCall(VecScale(y, context->operator_scale));
    PetscFunctionReturn(PETSC_SUCCESS);
}

struct GpuShiftedContext {
    Mat operator_matrix = nullptr;
    Mat mass_matrix = nullptr;
    Vec mass_action = nullptr;
    double shift = 0.0;
};

PetscErrorCode shifted_split_schur_matmult(Mat matrix, Vec x, Vec y)
{
    void *raw = nullptr;
    PetscFunctionBeginUser;
    PetscCall(MatShellGetContext(matrix, &raw));
    PetscCheck(raw != nullptr, PETSC_COMM_SELF, PETSC_ERR_ARG_NULL,
               "missing GPU K0 shifted-shell context");
    auto *context = static_cast<GpuShiftedContext *>(raw);
    PetscCall(MatMult(context->operator_matrix, x, y));
    PetscCall(MatMult(context->mass_matrix, x, context->mass_action));
    PetscCall(VecAXPY(y, -context->shift, context->mass_action));
    PetscFunctionReturn(PETSC_SUCCESS);
}

bool create_materialized_shifted_operator_cuda(
    Mat operator_matrix,
    Mat mass_matrix,
    PetscInt dimension,
    double shift,
    Mat *shifted_matrix,
    Mat *unshifted_matrix)
{
    constexpr PetscInt kMaximumMaterializedDimension = 1024;
    if (shifted_matrix == nullptr || unshifted_matrix == nullptr ||
        operator_matrix == nullptr || mass_matrix == nullptr ||
        dimension <= 0 || dimension > kMaximumMaterializedDimension ||
        !std::isfinite(shift)) {
        return false;
    }
    GpuShiftedContext context{};
    context.operator_matrix = operator_matrix;
    context.mass_matrix = mass_matrix;
    context.shift = shift;
    Mat shifted_shell = nullptr;
    bool ok =
        create_cuda_vector(dimension, &context.mass_action) == PETSC_SUCCESS &&
        MatCreateShell(
            PETSC_COMM_SELF,
            dimension,
            dimension,
            dimension,
            dimension,
            &context,
            &shifted_shell) == PETSC_SUCCESS &&
        MatShellSetVecType(shifted_shell, VECCUDA) == PETSC_SUCCESS &&
        MatShellSetOperation(
            shifted_shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(shifted_split_schur_matmult)) == PETSC_SUCCESS &&
        MatSetUp(shifted_shell) == PETSC_SUCCESS &&
        MatComputeOperator(
            shifted_shell,
            MATSEQAIJCUSPARSE,
            shifted_matrix) == PETSC_SUCCESS &&
        MatDuplicate(*shifted_matrix, MAT_COPY_VALUES, unshifted_matrix) == PETSC_SUCCESS &&
        MatAXPY(*unshifted_matrix, shift, mass_matrix, DIFFERENT_NONZERO_PATTERN) == PETSC_SUCCESS;
    if (shifted_shell) MatDestroy(&shifted_shell);
    if (context.mass_action) VecDestroy(&context.mass_action);
    if (!ok) {
        if (*unshifted_matrix != nullptr) MatDestroy(unshifted_matrix);
        if (*shifted_matrix != nullptr) MatDestroy(shifted_matrix);
    }
    return ok;
}

bool copy_cuda_vector_to_host(
    Vec vector,
    std::vector<double> *values,
    std::uint64_t *final_d2h_transfer_count = nullptr)
{
    PetscInt size = 0;
    if (values == nullptr || VecGetSize(vector, &size) != PETSC_SUCCESS) {
        return false;
    }
    const PetscScalar *array = nullptr;
    if (VecGetArrayRead(vector, &array) != PETSC_SUCCESS || array == nullptr) {
        return false;
    }
    values->assign(static_cast<std::size_t>(size), 0.0);
    for (PetscInt index = 0; index < size; ++index) {
        (*values)[static_cast<std::size_t>(index)] = static_cast<double>(array[index]);
    }
    const bool restored = VecRestoreArrayRead(vector, &array) == PETSC_SUCCESS;
    if (restored && final_d2h_transfer_count != nullptr) {
        ++*final_d2h_transfer_count;
    }
    return restored;
}

FrequencyDomainStatus fail(
    PoissonAirboxModalEigenResult *result,
    FrequencyDomainStatus status,
    const char *message,
    const char *reason,
    double observed_positive_min_hz = 0.0,
    double observed_positive_max_hz = 0.0) noexcept
{
    result->status = status;
    copy_message(result->error_message, sizeof(result->error_message), message);
    std::snprintf(
        result->diagnostics_json,
        sizeof(result->diagnostics_json),
        "{\"schema_version\":\"poisson_airbox_modal_eigen_gpu_petsc.v1\","
        "\"status\":\"%s\",\"complete\":false,\"reason\":\"%s\","
        "\"requested_execution\":\"production_gpu\","
        "\"resolved_execution\":\"production_gpu\","
        "\"converged_eigenpair_count\":%u,"
        "\"finite_real_eigenpair_count\":%u,"
        "\"positive_frequency_eigenpair_count\":%u,"
        "\"action_residual_evaluated_count\":%u,"
        "\"reconstructed_mode_count\":%u,"
        "\"full_residual_accepted_count\":%u,"
        "\"best_action_residual\":%.17g,"
        "\"best_full_residual\":%.17g,"
        "\"best_magnetic_block_residual\":%.17g,"
        "\"best_poisson_block_residual\":%.17g,"
        "\"observed_positive_frequency_min_hz\":%.17g,"
        "\"observed_positive_frequency_max_hz\":%.17g,"
        "\"executed_subwindows\":%s,"
        "\"window_complete\":%s,"
        "\"window_failed_subwindow\":%s,"
        "\"window_cancelled\":%s,"
        "\"persistent_solver_context\":%s,"
        "\"persistent_context_verified\":%s,"
        "\"operator_context_reused\":%s,"
        "\"operator_context_signature\":\"%s\","
        "\"eps_converged_reason\":%d,"
        "\"eps_reason_available\":%s,"
        "\"eps_stop_reason\":\"%s\","
        "\"eps_cancellation_observed\":%s,"
        "\"eps_monitor_iteration_count\":%u,"
        "\"operator_apply_count\":%llu,"
        "\"poisson_solve_count\":%llu,"
        "\"poisson_iteration_count\":%llu,"
        "\"shift_linear_iteration_count\":%llu,"
        "\"device_residency_verified\":%s,"
        "\"hot_loop_telemetry_measured\":%s,"
        "\"hot_loop_allocations\":%llu,"
        "\"hot_loop_h2d_bytes\":%llu,"
        "\"hot_loop_d2h_bytes\":%llu,"
        "\"setup_h2d_transfer_count\":%llu,"
        "\"final_d2h_transfer_count\":%llu,"
        "\"fallback_used\":false}",
        status == FrequencyDomainStatus::interrupted ? "interrupted" : "failed",
        reason != nullptr ? reason : "unknown",
        result->converged_eigenpair_count,
        result->finite_real_eigenpair_count,
        result->positive_frequency_eigenpair_count,
        result->action_residual_evaluated_count,
        result->reconstructed_mode_count,
        result->full_residual_accepted_count,
        result->slepc_reported_backward_error,
        result->full_residual_reconstruction_relative_error,
        result->magnetic_block_backward_error,
        result->poisson_block_backward_error,
        observed_positive_min_hz,
        observed_positive_max_hz,
        result->executed_subwindows_json[0] != '\0'
            ? result->executed_subwindows_json
            : "[]",
        result->window_complete ? "true" : "false",
        result->window_failed_subwindow ? "true" : "false",
        result->window_cancelled ? "true" : "false",
        result->persistent_context_verified ? "true" : "false",
        result->persistent_context_verified ? "true" : "false",
        result->operator_context_reused ? "true" : "false",
        result->operator_context_signature,
        static_cast<int>(result->eps_converged_reason),
        result->eps_reason_available ? "true" : "false",
        result->eps_stop_reason[0] != '\0' ? result->eps_stop_reason : "unknown",
        result->eps_cancellation_observed ? "true" : "false",
        result->eps_monitor_iteration_count,
        static_cast<unsigned long long>(result->operator_apply_count),
        static_cast<unsigned long long>(result->poisson_solve_count),
        static_cast<unsigned long long>(result->poisson_iteration_count),
        static_cast<unsigned long long>(result->shift_linear_iteration_count),
        result->device_residency_verified ? "true" : "false",
        result->hot_loop_telemetry_measured ? "true" : "false",
        static_cast<unsigned long long>(result->hot_loop_allocations),
        static_cast<unsigned long long>(result->hot_loop_h2d_bytes),
        static_cast<unsigned long long>(result->hot_loop_d2h_bytes),
        static_cast<unsigned long long>(result->setup_h2d_transfer_count),
        static_cast<unsigned long long>(result->final_d2h_transfer_count));
    return status;
}

bool validate_problem(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *result,
    const char **failure_reason) noexcept
{
    if (failure_reason != nullptr) {
        *failure_reason = "gpu_k0_scope_mismatch";
    }
    result->q_dof_count = problem.q_dof_count;
    result->phi_dof_count = problem.phi_dof_count;
    result->augmented_dof_count = problem.q_dof_count + problem.phi_dof_count;
    result->magnetic_pair_count = problem.magnetic_pair_count;
    result->airbox_pair_count = problem.airbox_pair_count;
    result->expected_reference_frequency_hz = problem.expected_reference_frequency_hz;
    const bool production_scope =
        problem.production_shared_domain &&
        string_equals(problem.assembly_kind, "mfem_weak_form_shared_domain");
    const bool validation_scope =
        problem.validation_only_adapter &&
        string_equals(problem.assembly_kind, "synthetic_algebraic_oracle");
    const bool nearest_target = string_equals(problem.target_kind, "nearest_frequency");
    const bool window_target = string_equals(problem.target_kind, "frequency_window");
    const bool valid_nearest_target = nearest_target &&
        std::isfinite(problem.target_frequency_hz) && problem.target_frequency_hz > 0.0;
    const bool valid_window_target = window_target &&
        std::isfinite(problem.frequency_min_hz) &&
        std::isfinite(problem.frequency_max_hz) &&
        problem.frequency_min_hz >= 0.0 &&
        problem.frequency_max_hz > problem.frequency_min_hz &&
        std::isfinite(problem.target_frequency_hz) &&
        problem.target_frequency_hz >= problem.frequency_min_hz &&
        problem.target_frequency_hz <= problem.frequency_max_hz;
    const bool valid_target = valid_nearest_target || valid_window_target;
    const bool valid_conventions =
        string_equals(problem.phasor_convention, "exp_plus_i_omega_t") &&
        string_equals(
            problem.eigenvalue_convention,
            "lambda_imag_positive_frequency");
    const bool valid_requested_count = problem.requested_mode_count > 0u &&
        problem.requested_mode_count <= 64u;
    const bool valid_iteration_budgets = problem.max_outer_iterations > 0u &&
        problem.max_linear_iterations > 0u;
    const bool structural_invalid =
        problem.abi_version != kPoissonAirboxEigenBlockProblemAbiVersion ||
        problem.struct_size < sizeof(PoissonAirboxEigenBlockProblem) ||
        (!production_scope && !validation_scope) ||
        !string_equals(problem.demag_kind, "periodic_airbox_k0") ||
        !string_equals(problem.periodic_mesh_certificate_schema, "periodic_mesh_certificate.v6") ||
        !string_equals(problem.outer_boundary_kind, "poisson_robin") ||
        !string_equals(problem.gauge_policy, "none") ||
        !string_equals(problem.gauge_reason, "coercive_outer_boundary") ||
        problem.q_dof_count < 2u || problem.phi_dof_count == 0u ||
        problem.q_dof_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) / 2u ||
        problem.phi_dof_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        problem.magnetic_pair_count == 0u || problem.airbox_pair_count == 0u ||
        !std::isfinite(problem.residual_tolerance) || problem.residual_tolerance <= 0.0 ||
        !valid_csr(problem.A_qq, problem.q_dof_count, problem.q_dof_count) ||
        !valid_csr(problem.A_qphi, problem.q_dof_count, problem.phi_dof_count) ||
        !valid_csr(problem.A_phiq, problem.phi_dof_count, problem.q_dof_count) ||
        !valid_csr(problem.A_phiphi, problem.phi_dof_count, problem.phi_dof_count) ||
        !valid_csr(problem.B_qq, problem.q_dof_count, problem.q_dof_count);
    if (!valid_requested_count) {
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_requested_mode_count_invalid";
        }
    } else if (!valid_target) {
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_target_invalid";
        }
    } else if (!valid_conventions) {
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_convention_invalid";
        }
    } else if (!valid_iteration_budgets) {
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_iteration_budget_invalid";
        }
    } else if (structural_invalid) {
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_scope_mismatch";
        }
    }
    if (!valid_requested_count || !valid_target || !valid_conventions ||
        !valid_iteration_budgets || structural_invalid) {
        copy_message(
            result->error_message,
            sizeof(result->error_message),
            "GPU PETSc/SLEPc K0 requires a certified shared-domain Robin descriptor");
        return false;
    }
    return true;
}

void write_success_diagnostics(
    const PoissonAirboxEigenBlockProblem &problem,
    const PoissonAirboxModalEigenResult &result,
    const char *matrix_type,
    const char *vector_type,
    const char *basis_type,
    const char *poisson_pc_type,
    const char *shift_pc_type,
    const char *eigensolver_operator_kind,
    PoissonAirboxModalEigenResult *out) noexcept
{
    const bool validation_only = problem.validation_only_adapter;
    const bool complete = result.status == FrequencyDomainStatus::ok;
    const char *status = complete
        ? "ok"
        : result.status == FrequencyDomainStatus::interrupted ? "interrupted" : "failed";
    const bool production_implication =
        !validation_only &&
        problem.production_shared_domain &&
        string_equals(problem.assembly_kind, "mfem_weak_form_shared_domain");
    const char *execution_lane = production_implication ? "production_gpu" : "validation_gpu";
    const bool scalable_selected_spectrum =
        production_implication &&
        string_equals(eigensolver_operator_kind, "matrix_free_schur_cuda");
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_modal_eigen_gpu_petsc.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"study_product\":\"modal_eigen\","
        "\"solver_adapter\":\"k0_poisson_airbox_gpu_petsc_slepc\","
        "\"execution_lane\":\"%s\","
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"augmented_dof_count\":%llu,"
        "\"requested_execution\":\"production_gpu\","
        "\"resolved_execution\":\"production_gpu\","
        "\"assembly_kind\":\"%s\","
        "\"demag_kind\":\"periodic_airbox_k0\","
        "\"production_implication\":%s,"
        "\"production_shared_domain\":%s,"
        "\"validation_only\":%s,"
        "\"outer_boundary_kind\":\"%s\","
        "\"robin_beta\":%.17g,"
        "\"robin_beta_unit\":\"1/m\","
        "\"gauge_policy\":\"%s\","
        "\"gauge_reason\":\"%s\","
        "\"phasor_convention\":\"%s\","
        "\"eigenvalue_convention\":\"%s\","
        "\"spectral_pencil_kind\":\"real_frequency_rotated\","
        "\"target_representation\":\"tau=omega_target\","
        "\"target_tau_rad_s\":%.17g,"
        "\"persistent_solver_context\":%s,"
        "\"persistent_context_verified\":%s,"
        "\"operator_context_reused\":%s,"
        "\"operator_context_signature\":\"%s\","
        "\"gpu_device_resident_modal_eigensolver\":%s,"
        "\"device_residency_verified\":%s,"
        "\"device_residual_certification\":%s,"
        "\"residual_evaluation_lane\":\"petsc_cuda_device_blocks\","
        "\"residual_host_vector_reconstruction\":false,"
        "\"petsc_matrix_type\":\"%s\","
        "\"petsc_vector_type\":\"%s\","
        "\"slepc_basis_vector_type\":\"%s\","
        "\"eigensolver_operator_kind\":\"%s\","
        "\"poisson_pc_type\":\"%s\","
        "\"shift_pc_type\":\"%s\","
        "\"poisson_solver\":\"cg_hypre_boomeramg\","
        "\"spectral_transform\":\"shift_invert\","
        "\"krylov_solver\":\"slepc_krylovschur\","
        "\"true_residual_convergence\":true,"
        "\"certified_residual_tolerance\":%.17g,"
        "\"transformed_eigensolver_tolerance\":%.17g,"
        "\"inner_linear_tolerance\":%.17g,"
        "\"preconditioner_buffer_location\":\"device\","
        "\"operator_buffer_location\":\"device\","
        "\"krylov_vector_location\":\"device\","
        "\"per_iteration_h2d_transfer_count\":0,"
        "\"per_iteration_d2h_transfer_count\":0,"
        "\"per_iteration_full_vector_transfers\":0,"
        "\"per_iteration_transfer_telemetry_measured\":false,"
        "\"hot_loop_telemetry_measured\":%s,"
        "\"hot_loop_allocations\":%llu,"
        "\"hot_loop_h2d_bytes\":%llu,"
        "\"hot_loop_d2h_bytes\":%llu,"
        "\"scalable_selected_spectrum\":%s,"
        "\"setup_h2d_transfer_count\":%llu,"
        "\"final_d2h_transfer_count\":%llu,"
        "\"setup_h2d_block_transfers\":%llu,"
        "\"final_d2h_vector_transfers\":%llu,"
        "\"operator_apply_count\":%llu,"
        "\"poisson_solve_count\":%llu,"
        "\"poisson_iteration_count\":%llu,"
        "\"shift_linear_iteration_count\":%llu,"
        "\"eps_converged_reason\":%d,"
        "\"eps_reason_available\":%s,"
        "\"eps_stop_reason\":\"%s\","
        "\"eps_cancellation_observed\":%s,"
        "\"eps_monitor_iteration_count\":%u,"
        "\"window_complete\":%s,"
        "\"window_failed_subwindow\":%s,"
        "\"window_cancelled\":%s,"
        "\"fallback_used\":false,"
        "\"cpu_fallback\":\"disabled\","
        "\"converged_eigenpair_count\":%u,"
        "\"accepted_mode_count\":%u,"
        "\"action_residual_evaluated_count\":%u,"
        "\"full_residual_accepted_count\":%u,"
        "\"outer_iterations\":%u,"
        "\"frequency_hz\":%.17g,"
        "\"residual_tolerance\":%.17g,"
        "\"best_action_residual\":%.17g,"
        "\"best_full_residual\":%.17g,"
        "\"magnetic_block_backward_error\":%.17g,"
        "\"poisson_block_backward_error\":%.17g,"
        "\"gauge_constraint_backward_error\":%.17g,"
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"full_residual_reconstruction_relative_error\":%.17g,"
        "\"full_residual_certified\":%s,"
        "\"block_residuals\":{"
            "\"eps_q\":%.17g,"
            "\"eps_phi\":%.17g,"
            "\"eps_gauge\":%.17g,"
            "\"eps_full\":%.17g,"
            "\"certification_tolerance\":%.17g,"
            "\"certified\":%s},"
        "\"boundary_gauge\":{"
            "\"magnetostatic_bc\":\"periodic_airbox_k0\","
            "\"outer_boundary_kind\":\"%s\","
            "\"robin_beta\":%.17g,"
            "\"robin_beta_unit\":\"1/m\","
            "\"gauge_policy\":\"%s\","
            "\"gauge_reason\":\"%s\","
            "\"eta_row_present\":false},"
        "\"certification\":{"
            "\"full_residual_certified\":%s}"
        "}",
        status,
        complete ? "true" : "false",
        execution_lane,
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        static_cast<unsigned long long>(result.augmented_dof_count),
        problem.assembly_kind,
        production_implication ? "true" : "false",
        problem.production_shared_domain ? "true" : "false",
        validation_only ? "true" : "false",
        problem.outer_boundary_kind != nullptr ? problem.outer_boundary_kind : "",
        problem.robin_beta,
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        problem.gauge_reason != nullptr ? problem.gauge_reason : "",
        problem.phasor_convention != nullptr ? problem.phasor_convention : "",
        problem.eigenvalue_convention != nullptr ? problem.eigenvalue_convention : "",
        2.0 * 3.14159265358979323846264338327950288 * problem.target_frequency_hz,
        result.persistent_context_verified ? "true" : "false",
        result.persistent_context_verified ? "true" : "false",
        result.operator_context_reused ? "true" : "false",
        result.operator_context_signature,
        result.device_residency_verified ? "true" : "false",
        result.device_residency_verified ? "true" : "false",
        result.device_residency_verified ? "true" : "false",
        matrix_type != nullptr ? matrix_type : "",
        vector_type != nullptr ? vector_type : "",
        basis_type != nullptr ? basis_type : "",
        eigensolver_operator_kind != nullptr ? eigensolver_operator_kind : "",
        poisson_pc_type != nullptr ? poisson_pc_type : "",
        shift_pc_type != nullptr ? shift_pc_type : "",
        problem.residual_tolerance,
        transformed_eigensolver_tolerance(problem.residual_tolerance),
        inner_linear_tolerance(problem.residual_tolerance),
        result.hot_loop_telemetry_measured ? "true" : "false",
        static_cast<unsigned long long>(result.hot_loop_allocations),
        static_cast<unsigned long long>(result.hot_loop_h2d_bytes),
        static_cast<unsigned long long>(result.hot_loop_d2h_bytes),
        scalable_selected_spectrum ? "true" : "false",
        static_cast<unsigned long long>(result.setup_h2d_transfer_count),
        static_cast<unsigned long long>(result.final_d2h_transfer_count),
        static_cast<unsigned long long>(result.setup_h2d_transfer_count),
        static_cast<unsigned long long>(result.final_d2h_transfer_count),
        static_cast<unsigned long long>(result.operator_apply_count),
        static_cast<unsigned long long>(result.poisson_solve_count),
        static_cast<unsigned long long>(result.poisson_iteration_count),
        static_cast<unsigned long long>(result.shift_linear_iteration_count),
        static_cast<int>(result.eps_converged_reason),
        result.eps_reason_available ? "true" : "false",
        result.eps_stop_reason[0] != '\0' ? result.eps_stop_reason : "unknown",
        result.eps_cancellation_observed ? "true" : "false",
        result.eps_monitor_iteration_count,
        result.window_complete ? "true" : "false",
        result.window_failed_subwindow ? "true" : "false",
        result.window_cancelled ? "true" : "false",
        result.converged_eigenpair_count,
        result.accepted_mode_count,
        result.action_residual_evaluated_count,
        result.full_residual_accepted_count,
        result.outer_iterations,
        result.frequency_hz,
        problem.residual_tolerance,
        result.slepc_reported_backward_error,
        result.full_residual_reconstruction_relative_error,
        result.magnetic_block_backward_error,
        result.poisson_block_backward_error,
        result.gauge_constraint_backward_error,
        result.poisson_constraint_relative_residual,
        result.full_residual_reconstruction_relative_error,
        result.full_residual_certified ? "true" : "false",
        result.magnetic_block_backward_error,
        result.poisson_block_backward_error,
        result.gauge_constraint_backward_error,
        result.full_residual_reconstruction_relative_error,
        problem.residual_tolerance,
        result.full_residual_certified ? "true" : "false",
        problem.outer_boundary_kind != nullptr ? problem.outer_boundary_kind : "",
        problem.robin_beta,
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        problem.gauge_reason != nullptr ? problem.gauge_reason : "",
        result.full_residual_certified ? "true" : "false");
}

} // namespace

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxModalEigenResult{};
    const char *validation_failure_reason = "gpu_k0_scope_mismatch";
    if (!validate_problem(problem, out_result, &validation_failure_reason)) {
        return fail(
            out_result,
            FrequencyDomainStatus::validation_error,
            out_result->error_message,
            validation_failure_reason);
    }

#if !defined(PETSC_HAVE_CUDA) || !defined(PETSC_HAVE_HYPRE)
    return fail(
        out_result,
        FrequencyDomainStatus::unavailable,
        "GPU K0 requires PETSc CUDA and hypre support",
        "petsc_cuda_hypre_unavailable");
#else
    const bool requested_frequency_window =
        string_equals(problem.target_kind, "frequency_window") &&
        problem.frequency_min_hz >= 0.0 &&
        problem.frequency_max_hz > problem.frequency_min_hz;
    if (requested_frequency_window) {
        struct WindowCandidate {
            PoissonAirboxModalEigenResult::AcceptedMode mode{};
            PoissonAirboxModalEigenResult source{};
        };
        constexpr std::uint32_t subwindow_count = 16u;
        const double width = problem.frequency_max_hz - problem.frequency_min_hz;
        std::vector<WindowCandidate> candidates;
        candidates.reserve(static_cast<std::size_t>(problem.requested_mode_count) * 2u);
        std::uint64_t converged_total = 0;
        std::uint64_t finite_total = 0;
        std::uint64_t positive_total = 0;
        std::uint64_t residual_total = 0;
        std::uint64_t reconstructed_total = 0;
        std::uint64_t accepted_total = 0;
        std::uint64_t iterations_total = 0;
        std::uint64_t setup_h2d_transfer_total = 0;
        std::uint64_t final_d2h_transfer_total = 0;
        std::uint64_t hot_loop_allocations_total = 0;
        std::uint64_t hot_loop_h2d_bytes_total = 0;
        std::uint64_t hot_loop_d2h_bytes_total = 0;
        std::uint64_t operator_apply_total = 0;
        std::uint64_t poisson_solve_total = 0;
        std::uint64_t poisson_iteration_total = 0;
        std::uint64_t shift_linear_iteration_total = 0;
        std::uint32_t eps_monitor_iteration_max = 0;
        std::int32_t eps_reason_last = 0;
        bool eps_reason_available = false;
        bool eps_cancellation_observed = false;
        bool device_residency_verified = true;
        bool device_residency_observed = false;
        bool persistent_context_verified = false;
        bool operator_context_reused = false;
        bool window_interrupted = false;
        bool window_failed = false;
        double best_action_residual = std::numeric_limits<double>::infinity();
        double best_full_residual = std::numeric_limits<double>::infinity();
        double best_magnetic_residual = std::numeric_limits<double>::infinity();
        double best_poisson_residual = std::numeric_limits<double>::infinity();
        char subwindows[sizeof(out_result->executed_subwindows_json)]{};
        std::size_t subwindows_size = 1u;
        subwindows[0] = '[';
        bool subwindows_complete = true;
        auto append_subwindow = [&](const char *format, auto... values) {
            if (!subwindows_complete || subwindows_size >= sizeof(subwindows)) {
                subwindows_complete = false;
                return;
            }
            const int written = std::snprintf(
                subwindows + subwindows_size,
                sizeof(subwindows) - subwindows_size,
                format,
                values...);
            if (written < 0 || static_cast<std::size_t>(written) >=
                    sizeof(subwindows) - subwindows_size) {
                subwindows_complete = false;
                return;
            }
            subwindows_size += static_cast<std::size_t>(written);
        };
        for (std::uint32_t subwindow = 0; subwindow < subwindow_count; ++subwindow) {
            PoissonAirboxEigenBlockProblem shifted = problem;
            shifted.target_kind = "nearest_frequency";
            shifted.target_frequency_hz = problem.frequency_min_hz +
                (static_cast<double>(subwindow) + 0.5) * width /
                    static_cast<double>(subwindow_count);
            shifted.frequency_min_hz = 0.0;
            shifted.frequency_max_hz = 0.0;
            // One physical branch per shift is enough to cover the window;
            // aggregation below applies the original publication count.
            shifted.requested_mode_count = 1u;
            PoissonAirboxModalEigenResult shifted_result{};
            const FrequencyDomainStatus shifted_status =
                solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
                    shifted, &shifted_result);
            operator_context_reused =
                operator_context_reused || shifted_result.operator_context_reused;
            persistent_context_verified = persistent_context_verified ||
                shifted_result.persistent_context_verified;
            append_subwindow(
                "%s{\"subwindow_index\":%u,\"shift_frequency_hz\":%.17g,"
                "\"status\":\"%s\",\"converged_eigenpair_count\":%u,"
                "\"finite_real_eigenpair_count\":%u,"
                "\"positive_frequency_eigenpair_count\":%u,"
                "\"action_residual_evaluated_count\":%u,"
                "\"reconstructed_mode_count\":%u,"
                "\"full_residual_accepted_count\":%u,"
                "\"accepted_mode_count\":%u,"
                "\"eps_converged_reason\":%d,"
                "\"eps_stop_reason\":\"%s\","
                "\"operator_apply_count\":%llu,"
                "\"poisson_iteration_count\":%llu,"
                "\"error_message\":\"%.120s\"}",
                subwindow == 0u ? "" : ",",
                subwindow,
                shifted.target_frequency_hz,
                shifted_status == FrequencyDomainStatus::ok ? "ok" : "failed",
                shifted_result.converged_eigenpair_count,
                shifted_result.finite_real_eigenpair_count,
                shifted_result.positive_frequency_eigenpair_count,
                shifted_result.action_residual_evaluated_count,
                shifted_result.reconstructed_mode_count,
                shifted_result.full_residual_accepted_count,
                shifted_result.accepted_mode_count,
                static_cast<int>(shifted_result.eps_converged_reason),
                shifted_result.eps_stop_reason[0] != '\0'
                    ? shifted_result.eps_stop_reason
                    : "unknown",
                static_cast<unsigned long long>(shifted_result.operator_apply_count),
                static_cast<unsigned long long>(shifted_result.poisson_iteration_count),
                shifted_result.error_message);
            converged_total += shifted_result.converged_eigenpair_count;
            finite_total += shifted_result.finite_real_eigenpair_count;
            positive_total += shifted_result.positive_frequency_eigenpair_count;
            residual_total += shifted_result.action_residual_evaluated_count;
            reconstructed_total += shifted_result.reconstructed_mode_count;
            accepted_total += shifted_result.full_residual_accepted_count;
            iterations_total += shifted_result.outer_iterations;
            setup_h2d_transfer_total += shifted_result.setup_h2d_transfer_count;
            final_d2h_transfer_total += shifted_result.final_d2h_transfer_count;
            hot_loop_allocations_total += shifted_result.hot_loop_allocations;
            hot_loop_h2d_bytes_total += shifted_result.hot_loop_h2d_bytes;
            hot_loop_d2h_bytes_total += shifted_result.hot_loop_d2h_bytes;
            operator_apply_total += shifted_result.operator_apply_count;
            poisson_solve_total += shifted_result.poisson_solve_count;
            poisson_iteration_total += shifted_result.poisson_iteration_count;
            shift_linear_iteration_total += shifted_result.shift_linear_iteration_count;
            eps_monitor_iteration_max = std::max(
                eps_monitor_iteration_max,
                shifted_result.eps_monitor_iteration_count);
            eps_reason_last = shifted_result.eps_converged_reason;
            eps_reason_available = eps_reason_available || shifted_result.eps_reason_available;
            eps_cancellation_observed = eps_cancellation_observed ||
                shifted_result.eps_cancellation_observed;
            if (shifted_result.action_residual_evaluated_count > 0u) {
                best_action_residual = std::min(
                    best_action_residual, shifted_result.slepc_reported_backward_error);
            }
            if (shifted_result.reconstructed_mode_count > 0u) {
                best_full_residual = std::min(
                    best_full_residual,
                    shifted_result.full_residual_reconstruction_relative_error);
                best_magnetic_residual = std::min(
                    best_magnetic_residual, shifted_result.magnetic_block_backward_error);
                best_poisson_residual = std::min(
                    best_poisson_residual, shifted_result.poisson_block_backward_error);
            }
            if (shifted_status != FrequencyDomainStatus::ok) {
                device_residency_verified = false;
                window_interrupted =
                    window_interrupted || shifted_status == FrequencyDomainStatus::interrupted;
                window_failed = window_failed || shifted_status != FrequencyDomainStatus::interrupted;
                continue;
            }
            device_residency_observed = true;
            device_residency_verified = device_residency_verified &&
                shifted_result.device_residency_verified;
            for (const auto &mode : shifted_result.accepted_modes) {
                if (mode.frequency_hz < problem.frequency_min_hz ||
                    mode.frequency_hz > problem.frequency_max_hz) {
                    continue;
                }
                const bool duplicate = std::any_of(
                    candidates.begin(),
                    candidates.end(),
                    [&mode](const WindowCandidate &existing) {
                        const double frequency_difference =
                            std::abs(existing.mode.frequency_hz - mode.frequency_hz) /
                            std::max({1.0, std::abs(existing.mode.frequency_hz),
                                      std::abs(mode.frequency_hz)});
                        if (frequency_difference > 1.0e-8 ||
                            existing.mode.full_vector.size() != mode.full_vector.size()) {
                            return false;
                        }
                        Complex overlap = 0.0;
                        double left_norm = 0.0;
                        double right_norm = 0.0;
                        for (std::size_t component = 0;
                             component < mode.full_vector.size(); ++component) {
                            overlap += std::conj(existing.mode.full_vector[component]) *
                                mode.full_vector[component];
                            left_norm += std::norm(existing.mode.full_vector[component]);
                            right_norm += std::norm(mode.full_vector[component]);
                        }
                        return std::abs(overlap) /
                            (std::sqrt(left_norm * right_norm) + 1.0e-300) >= 1.0 - 1.0e-6;
                    });
                if (!duplicate) {
                    candidates.push_back(WindowCandidate{mode, shifted_result});
                }
            }
        }
        append_subwindow("%s", "]");
        if (candidates.empty()) {
            out_result->converged_eigenpair_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(converged_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->finite_real_eigenpair_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(finite_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->positive_frequency_eigenpair_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(positive_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->action_residual_evaluated_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(residual_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->reconstructed_mode_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(reconstructed_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->full_residual_accepted_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(accepted_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->outer_iterations = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(iterations_total, std::numeric_limits<std::uint32_t>::max()));
            out_result->setup_h2d_transfer_count = setup_h2d_transfer_total;
            out_result->final_d2h_transfer_count = final_d2h_transfer_total;
            out_result->hot_loop_allocations = hot_loop_allocations_total;
            out_result->hot_loop_h2d_bytes = hot_loop_h2d_bytes_total;
            out_result->hot_loop_d2h_bytes = hot_loop_d2h_bytes_total;
            out_result->operator_apply_count = operator_apply_total;
            out_result->poisson_solve_count = poisson_solve_total;
            out_result->poisson_iteration_count = poisson_iteration_total;
            out_result->shift_linear_iteration_count = shift_linear_iteration_total;
            out_result->eps_monitor_iteration_count = eps_monitor_iteration_max;
            out_result->eps_converged_reason = eps_reason_last;
            out_result->eps_reason_available = eps_reason_available;
            out_result->eps_cancellation_observed = eps_cancellation_observed;
            out_result->device_residency_verified = device_residency_observed &&
                device_residency_verified;
            out_result->persistent_context_verified = persistent_context_verified;
            out_result->operator_context_reused = operator_context_reused;
            out_result->window_failed_subwindow = window_failed || !subwindows_complete;
            out_result->window_cancelled = window_interrupted;
            out_result->window_complete = false;
            std::snprintf(
                out_result->eps_stop_reason,
                sizeof(out_result->eps_stop_reason),
                "%s",
                window_interrupted
                    ? "cancel_requested"
                    : (window_failed ? "failed_subwindow" : "no_certified_mode"));
            out_result->slepc_reported_backward_error =
                std::isfinite(best_action_residual) ? best_action_residual : 0.0;
            out_result->full_residual_reconstruction_relative_error =
                std::isfinite(best_full_residual) ? best_full_residual : 0.0;
            out_result->magnetic_block_backward_error =
                std::isfinite(best_magnetic_residual) ? best_magnetic_residual : 0.0;
            out_result->poisson_block_backward_error =
                std::isfinite(best_poisson_residual) ? best_poisson_residual : 0.0;
            std::snprintf(
                out_result->executed_subwindows_json,
                sizeof(out_result->executed_subwindows_json),
                "%s",
                subwindows_complete ? subwindows : "[{\"status\":\"diagnostics_truncated\"}]");
            return fail(
                out_result,
                window_interrupted
                    ? FrequencyDomainStatus::interrupted
                    : FrequencyDomainStatus::solve_error,
                window_interrupted
                    ? "GPU K0 frequency window was cancelled before preserving a mode"
                    : "GPU K0 multi-shift frequency window found no certified mode",
                window_interrupted
                    ? "cancel_requested"
                    : "gpu_frequency_window_no_certified_mode");
        }
        if (!subwindows_complete || window_failed || window_interrupted ||
            candidates.size() < static_cast<std::size_t>(problem.requested_mode_count)) {
            std::sort(
                candidates.begin(),
                candidates.end(),
                [](const WindowCandidate &left, const WindowCandidate &right) {
                    return left.mode.frequency_hz < right.mode.frequency_hz;
                });
            // A failed or under-covered window may expose already certified
            // modes as a partial artifact, but it must never advertise a
            // complete spectrum.
            if (candidates.empty()) {
                out_result->window_failed_subwindow = window_failed || !subwindows_complete;
                out_result->window_cancelled = window_interrupted;
                out_result->window_complete = false;
                return fail(
                    out_result,
                    window_interrupted
                        ? FrequencyDomainStatus::interrupted
                        : FrequencyDomainStatus::solve_error,
                    window_interrupted
                        ? "GPU K0 frequency window was cancelled"
                        : "GPU K0 frequency window coverage is incomplete",
                    window_interrupted
                        ? "cancel_requested"
                        : (window_failed
                            ? "gpu_frequency_window_failed_subwindow"
                            : "gpu_frequency_window_incomplete"));
            }
            PoissonAirboxModalEigenResult partial = candidates.front().source;
            partial.accepted_modes.clear();
            for (const WindowCandidate &candidate : candidates) {
                partial.accepted_modes.push_back(candidate.mode);
            }
            partial.accepted_mode_count = static_cast<std::uint32_t>(partial.accepted_modes.size());
            partial.converged_eigenpair_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(converged_total, std::numeric_limits<std::uint32_t>::max()));
            partial.finite_real_eigenpair_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(finite_total, std::numeric_limits<std::uint32_t>::max()));
            partial.positive_frequency_eigenpair_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(positive_total, std::numeric_limits<std::uint32_t>::max()));
            partial.action_residual_evaluated_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(residual_total, std::numeric_limits<std::uint32_t>::max()));
            partial.reconstructed_mode_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(reconstructed_total, std::numeric_limits<std::uint32_t>::max()));
            partial.full_residual_accepted_count = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(accepted_total, std::numeric_limits<std::uint32_t>::max()));
            partial.outer_iterations = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(iterations_total, std::numeric_limits<std::uint32_t>::max()));
            partial.setup_h2d_transfer_count = setup_h2d_transfer_total;
            partial.final_d2h_transfer_count = final_d2h_transfer_total;
            partial.hot_loop_allocations = hot_loop_allocations_total;
            partial.hot_loop_h2d_bytes = hot_loop_h2d_bytes_total;
            partial.hot_loop_d2h_bytes = hot_loop_d2h_bytes_total;
            partial.operator_apply_count = operator_apply_total;
            partial.poisson_solve_count = poisson_solve_total;
            partial.poisson_iteration_count = poisson_iteration_total;
            partial.shift_linear_iteration_count = shift_linear_iteration_total;
            partial.eps_monitor_iteration_count = eps_monitor_iteration_max;
            partial.eps_converged_reason = eps_reason_last;
            partial.eps_reason_available = eps_reason_available;
            partial.eps_cancellation_observed = eps_cancellation_observed;
            partial.device_residency_verified = device_residency_observed &&
                device_residency_verified;
            partial.persistent_context_verified = persistent_context_verified;
            partial.operator_context_reused = operator_context_reused;
            partial.window_failed_subwindow = window_failed || !subwindows_complete ||
                candidates.size() < static_cast<std::size_t>(problem.requested_mode_count);
            partial.window_cancelled = window_interrupted;
            partial.window_complete = false;
            partial.status = window_interrupted
                ? FrequencyDomainStatus::interrupted
                : FrequencyDomainStatus::solve_error;
            copy_message(
                partial.error_message,
                sizeof(partial.error_message),
                window_interrupted
                    ? "GPU K0 frequency window was cancelled"
                    : "GPU K0 frequency window coverage is incomplete");
            std::snprintf(
                partial.executed_subwindows_json,
                sizeof(partial.executed_subwindows_json),
                "%s",
                subwindows_complete ? subwindows : "[{\"status\":\"diagnostics_truncated\"}]");
            std::snprintf(
                partial.eps_stop_reason,
                sizeof(partial.eps_stop_reason),
                "%s",
                window_interrupted
                    ? "cancel_requested"
                    : (window_failed ? "failed_subwindow" : "incomplete_window"));
            write_success_diagnostics(
                problem,
                partial,
                "seqaijcusparse",
                "seqcuda",
                "seqcuda",
                "hypre",
                "unknown",
                "matrix_free_schur_cuda",
                &partial);
            *out_result = std::move(partial);
            return out_result->status;
        }
        std::sort(
            candidates.begin(), candidates.end(),
            [](const WindowCandidate &left, const WindowCandidate &right) {
                return left.mode.frequency_hz < right.mode.frequency_hz;
            });
        const std::size_t requested_count = static_cast<std::size_t>(
            std::max<std::uint32_t>(1u, problem.requested_mode_count));
        if (candidates.size() > requested_count) {
            candidates.resize(requested_count);
        }
        PoissonAirboxModalEigenResult aggregate = candidates.front().source;
        aggregate.accepted_modes.clear();
        for (const WindowCandidate &candidate : candidates) {
            aggregate.accepted_modes.push_back(candidate.mode);
        }
        const auto &selected = aggregate.accepted_modes.front();
        aggregate.accepted_mode_count = static_cast<std::uint32_t>(aggregate.accepted_modes.size());
        aggregate.selected_eigenpair_index = selected.eigenpair_index;
        aggregate.eigenvalue_real = selected.eigenvalue_real;
        aggregate.eigenvalue_imag = selected.eigenvalue_imag;
        aggregate.omega_rad_s = selected.omega_rad_s;
        aggregate.frequency_hz = selected.frequency_hz;
        aggregate.eigen_residual_relative = selected.relative_residual;
        aggregate.slepc_reported_backward_error = selected.slepc_reported_backward_error;
        aggregate.full_residual_reconstruction_relative_error =
            selected.full_residual_reconstruction_relative_error;
        aggregate.reconstructed_full_descriptor_backward_error =
            selected.full_residual_reconstruction_relative_error;
        aggregate.magnetic_block_backward_error = selected.magnetic_block_backward_error;
        aggregate.poisson_block_backward_error = selected.poisson_block_backward_error;
        aggregate.gauge_constraint_backward_error = selected.gauge_constraint_backward_error;
        aggregate.gauge_mean_abs = selected.gauge_mean_abs;
        aggregate.converged_eigenpair_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(converged_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.finite_real_eigenpair_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(finite_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.positive_frequency_eigenpair_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(positive_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.action_residual_evaluated_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(residual_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.reconstructed_mode_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(reconstructed_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.full_residual_accepted_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(accepted_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.outer_iterations = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(iterations_total, std::numeric_limits<std::uint32_t>::max()));
        aggregate.setup_h2d_transfer_count = setup_h2d_transfer_total;
        aggregate.final_d2h_transfer_count = final_d2h_transfer_total;
        aggregate.hot_loop_allocations = hot_loop_allocations_total;
        aggregate.hot_loop_h2d_bytes = hot_loop_h2d_bytes_total;
        aggregate.hot_loop_d2h_bytes = hot_loop_d2h_bytes_total;
        aggregate.operator_apply_count = operator_apply_total;
        aggregate.poisson_solve_count = poisson_solve_total;
        aggregate.poisson_iteration_count = poisson_iteration_total;
        aggregate.shift_linear_iteration_count = shift_linear_iteration_total;
        aggregate.eps_monitor_iteration_count = eps_monitor_iteration_max;
        aggregate.eps_converged_reason = eps_reason_last;
        aggregate.eps_reason_available = eps_reason_available;
        aggregate.eps_cancellation_observed = eps_cancellation_observed;
        aggregate.device_residency_verified = device_residency_observed &&
            device_residency_verified;
        aggregate.persistent_context_verified = persistent_context_verified;
        aggregate.operator_context_reused = operator_context_reused;
        aggregate.window_failed_subwindow = window_failed || !subwindows_complete;
        aggregate.window_cancelled = window_interrupted;
        aggregate.window_complete = !window_failed && !window_interrupted &&
            subwindows_complete && aggregate.accepted_mode_count >= problem.requested_mode_count;
        aggregate.status = window_interrupted
            ? FrequencyDomainStatus::interrupted
            : aggregate.window_complete
                ? FrequencyDomainStatus::ok
                : FrequencyDomainStatus::solve_error;
        if (aggregate.status != FrequencyDomainStatus::ok) {
            copy_message(
                aggregate.error_message,
                sizeof(aggregate.error_message),
                aggregate.status == FrequencyDomainStatus::interrupted
                    ? "GPU K0 frequency window was cancelled"
                    : "GPU K0 frequency window coverage is incomplete");
        }
        std::snprintf(
            aggregate.eps_stop_reason,
            sizeof(aggregate.eps_stop_reason),
            "%s",
            aggregate.window_complete
                ? "converged_tolerance"
                : (window_failed ? "failed_subwindow" :
                   (window_interrupted ? "cancel_requested" : "incomplete_window")));
        std::snprintf(
            aggregate.executed_subwindows_json,
            sizeof(aggregate.executed_subwindows_json),
            "%s",
            subwindows_complete ? subwindows : "[{\"status\":\"diagnostics_truncated\"}]");
        // The source result belongs to one subwindow. Rebuild diagnostics
        // after aggregation so counts, transfer telemetry and the complete
        // executed-subwindow list describe the published result.
        const bool source_used_materialized_operator =
            std::strstr(
                aggregate.diagnostics_json,
                "\"eigensolver_operator_kind\":\"materialized_schur_cuda\"") != nullptr;
        const bool source_used_ilu =
            std::strstr(aggregate.diagnostics_json, "\"shift_pc_type\":\"ilu\"") != nullptr;
        write_success_diagnostics(
            problem,
            aggregate,
            "seqaijcusparse",
            "seqcuda",
            "seqcuda",
            "hypre",
            source_used_ilu ? "ilu" : "hypre",
            source_used_materialized_operator
                ? "materialized_schur_cuda"
                : "matrix_free_schur_cuda",
            &aggregate);
        *out_result = std::move(aggregate);
        return out_result->status;
    }

    const std::lock_guard<std::mutex> lock(gpu_slepc_mutex());
    if (!ensure_slepc_initialized(out_result->error_message)) {
        return fail(
            out_result,
            FrequencyDomainStatus::unavailable,
            out_result->error_message,
            "slepc_cuda_initialization_failed");
    }

    GpuPersistentContext *persistent = nullptr;
    GpuSchurContext *schur = nullptr;
    GpuSplitContext *split = nullptr;
    std::uint64_t operator_apply_before = 0;
    std::uint64_t poisson_solve_before = 0;
    std::uint64_t poisson_iteration_before = 0;
    const std::uint64_t operator_signature = modal_operator_signature(problem);
    std::snprintf(
        out_result->operator_context_signature,
        sizeof(out_result->operator_context_signature),
        "fnv1a64:%016llx",
        static_cast<unsigned long long>(operator_signature));
    Mat shell = nullptr;
    Mat mass = nullptr;
    Mat preconditioner = nullptr;
    Mat materialized_operator = nullptr;
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    auto cleanup = [&]() noexcept {
        if (xi) VecDestroy(&xi);
        if (xr) VecDestroy(&xr);
        if (eps) EPSDestroy(&eps);
        if (materialized_operator) MatDestroy(&materialized_operator);
        if (preconditioner) MatDestroy(&preconditioner);
        if (mass) MatDestroy(&mass);
        if (shell) MatDestroy(&shell);
    };

    try {
        bool context_reused = false;
        persistent = acquire_cached_gpu_context(problem, &context_reused);
        if (persistent == nullptr) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 PETSc CUDA Schur context setup failed",
                "gpu_schur_context_setup_failed");
        }
        out_result->operator_context_reused = context_reused;
        out_result->persistent_context_verified = context_reused;
        schur = &persistent->schur;
        split = &persistent->split;
        operator_apply_before = schur->operator_apply_count;
        poisson_solve_before = schur->poisson_solve_count;
        poisson_iteration_before = schur->poisson_iteration_count;
        // A reused context has already uploaded its four immutable operator CSR
        // blocks.  The split mass is materialized for each solve because its
        // scaling belongs to the current spectral normalization; that upload
        // is counted at the successful assembly boundary below.
        out_result->setup_h2d_transfer_count = context_reused
            ? 0u
            : schur->setup_h2d_transfer_count;
        if (KSPSetConvergenceTest(
                schur->poisson_ksp,
                gpu_modal_ksp_convergence_test,
                const_cast<PoissonAirboxEigenBlockProblem *>(&problem),
                nullptr) != PETSC_SUCCESS) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 Poisson cancellation monitor setup failed",
                "gpu_poisson_cancellation_monitor_setup_failed");
        }
        const PetscInt base = schur->q_count;
        const PetscInt dimension = 2 * base;
        const double target_omega =
            2.0 * 3.14159265358979323846264338327950288 * problem.target_frequency_hz;
        const double angular_frequency_scale = std::max(1.0, std::abs(target_omega));
        const double mass_norm = csr_infinity_norm(problem.B_qq);
        if (!std::isfinite(mass_norm) || mass_norm <= 0.0 ||
            !std::isfinite(angular_frequency_scale * mass_norm) ||
            angular_frequency_scale * mass_norm <= 0.0) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 descriptor mass scaling is invalid",
                "gpu_descriptor_scaling_invalid");
        }
        const double mass_scale = 1.0 / mass_norm;
        const double operator_scale = mass_scale / angular_frequency_scale;
        const double target_eigenvalue = target_omega / angular_frequency_scale;
        split->operator_scale = operator_scale;
        const double eps_tolerance =
            transformed_eigensolver_tolerance(problem.residual_tolerance);
        if (MatCreateShell(
                PETSC_COMM_SELF,
                dimension,
                dimension,
                dimension,
                dimension,
                split,
                &shell) != PETSC_SUCCESS ||
            MatShellSetVecType(shell, VECCUDA) != PETSC_SUCCESS ||
            MatShellSetOperation(
                shell,
                MATOP_MULT,
                reinterpret_cast<void (*)(void)>(split_schur_matmult)) != PETSC_SUCCESS ||
            MatSetUp(shell) != PETSC_SUCCESS ||
            !create_split_mass_cuda(
                problem.B_qq,
                mass_scale,
                &mass,
                &out_result->setup_h2d_transfer_count)) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 real-split CUDA operator setup failed",
                "gpu_real_split_operator_setup_failed");
        }
        // Keep the selected-spectrum operator matrix-free for production, but
        // use an exact shifted preconditioner for the bounded small systems
        // used by the production K0 qualification fixture.  The previous
        // HYPRE-only path could stall in device AMG setup for these tiny,
        // strongly SI-scaled Schur systems even though the same descriptor
        // was well-conditioned after exact shifted assembly.  Larger systems
        // retain the scalable HYPRE/AMG preconditioner.
        const bool exact_shifted_preconditioner =
            (problem.validation_only_adapter ||
             (problem.production_shared_domain && dimension <= 256)) &&
            create_materialized_shifted_operator_cuda(
                shell,
                mass,
                dimension,
                target_eigenvalue,
                &preconditioner,
                &materialized_operator);
        const bool materialized_shifted_operator =
            problem.validation_only_adapter && exact_shifted_preconditioner;
        if (!exact_shifted_preconditioner &&
            !create_hypre_shift_preconditioner_cuda(
                problem.A_qq,
                problem.B_qq,
                target_omega,
                operator_scale,
                &preconditioner)) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 shifted preconditioner setup failed",
                "gpu_shifted_preconditioner_setup_failed");
        }
        std::snprintf(
            out_result->shifted_preconditioner_kind,
            sizeof(out_result->shifted_preconditioner_kind),
            "%s",
            materialized_shifted_operator
                ? "materialized_shifted_schur_cuda"
                : "magnetic_shift_preconditioner_cuda");

        ST st = nullptr;
        KSP st_ksp = nullptr;
        PC st_pc = nullptr;
        GpuEpsControl eps_control{&problem};
        const PetscInt requested = static_cast<PetscInt>(
            std::max<std::uint32_t>(1u, problem.requested_mode_count) * 4u);
        const PetscInt nev = std::min(dimension - 1, requested);
        bool configured =
            EPSCreate(PETSC_COMM_SELF, &eps) == PETSC_SUCCESS &&
            EPSSetOperators(
                eps,
                materialized_shifted_operator ? materialized_operator : shell,
                mass) == PETSC_SUCCESS &&
            EPSSetProblemType(eps, EPS_GNHEP) == PETSC_SUCCESS &&
            EPSSetType(eps, EPSKRYLOVSCHUR) == PETSC_SUCCESS &&
            EPSSetTrueResidual(eps, PETSC_TRUE) == PETSC_SUCCESS &&
            EPSSetDimensions(eps, nev, PETSC_DEFAULT, PETSC_DEFAULT) == PETSC_SUCCESS &&
            EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) == PETSC_SUCCESS &&
            EPSSetTarget(eps, target_eigenvalue) == PETSC_SUCCESS &&
            EPSSetTolerances(
                eps,
                eps_tolerance,
                std::max<PetscInt>(128, static_cast<PetscInt>(problem.max_outer_iterations))) ==
                PETSC_SUCCESS &&
            EPSGetST(eps, &st) == PETSC_SUCCESS &&
            STSetType(st, STSINVERT) == PETSC_SUCCESS &&
            STSetShift(st, target_eigenvalue) == PETSC_SUCCESS &&
            STSetPreconditionerMat(st, preconditioner) == PETSC_SUCCESS &&
            STGetKSP(st, &st_ksp) == PETSC_SUCCESS &&
            KSPSetType(st_ksp, KSPGMRES) == PETSC_SUCCESS &&
            KSPGMRESSetRestart(st_ksp, std::min<PetscInt>(dimension, 128)) == PETSC_SUCCESS &&
            KSPGetPC(st_ksp, &st_pc) == PETSC_SUCCESS &&
            KSPSetTolerances(
                st_ksp,
                inner_linear_tolerance(problem.residual_tolerance),
                PETSC_DEFAULT,
                PETSC_DEFAULT,
                std::max<PetscInt>(512, static_cast<PetscInt>(problem.max_linear_iterations))) ==
                PETSC_SUCCESS &&
            KSPSetErrorIfNotConverged(st_ksp, PETSC_TRUE) == PETSC_SUCCESS &&
            KSPSetConvergenceTest(
                st_ksp,
                gpu_modal_ksp_convergence_test,
                const_cast<PoissonAirboxEigenBlockProblem *>(&problem),
                nullptr) == PETSC_SUCCESS &&
            create_cuda_vector(dimension, &xr) == PETSC_SUCCESS &&
            create_cuda_vector(dimension, &xi) == PETSC_SUCCESS;
        if (configured) {
            configured =
                EPSSetStoppingTest(eps, EPS_STOP_USER) == PETSC_SUCCESS &&
                EPSSetStoppingTestFunction(
                    eps,
                    gpu_modal_eps_stopping_test,
                    &eps_control,
                    nullptr) == PETSC_SUCCESS &&
                EPSMonitorSet(eps, gpu_modal_eps_monitor, &eps_control, nullptr) == PETSC_SUCCESS;
        }
        if (configured) {
            configured = exact_shifted_preconditioner
                ? PCSetType(st_pc, PCILU) == PETSC_SUCCESS &&
                    PCFactorSetMatSolverType(st_pc, MATSOLVERCUSPARSE) == PETSC_SUCCESS
                : PCSetType(st_pc, PCHYPRE) == PETSC_SUCCESS &&
                    PCHYPRESetType(st_pc, "boomeramg") == PETSC_SUCCESS;
        }
        if (!configured) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 SLEPc CUDA solver configuration failed",
                "gpu_slepc_configuration_failed");
        }
        if (std::getenv("FULLMAG_FEM_GPU_K0_PETSC_OPTIONS") != nullptr &&
            KSPSetFromOptions(st_ksp) != PETSC_SUCCESS) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 PETSc diagnostic options are invalid",
                "gpu_k0_petsc_options_invalid");
        }

        if (poisson_airbox_modal_cancel_requested(problem)) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::interrupted,
                "GPU K0 SLEPc solve was cancelled before EPSSolve",
                "cancel_requested");
        }

        PetscInt iterations = 0;
        PetscInt converged = 0;
        EPSConvergedReason eps_reason = EPS_CONVERGED_ITERATING;
        const PetscErrorCode eps_solve_status = EPSSolve(eps);
        const bool solve_interrupted = eps_control.cancellation_observed ||
            poisson_airbox_modal_cancel_requested(problem);
        const PetscErrorCode iteration_status = EPSGetIterationNumber(eps, &iterations);
        const PetscErrorCode converged_status = EPSGetConverged(eps, &converged);
        const PetscErrorCode reason_status = EPSGetConvergedReason(eps, &eps_reason);
        out_result->eps_reason_available = reason_status == PETSC_SUCCESS;
        out_result->eps_converged_reason = static_cast<std::int32_t>(eps_reason);
        out_result->eps_cancellation_observed = solve_interrupted;
        out_result->eps_monitor_iteration_count = eps_control.monitor_iteration_count;
        std::snprintf(
            out_result->eps_stop_reason,
            sizeof(out_result->eps_stop_reason),
            "%s",
            gpu_eps_reason_name(eps_reason, solve_interrupted));
        if ((eps_solve_status != PETSC_SUCCESS && !solve_interrupted) ||
            iteration_status != PETSC_SUCCESS ||
            converged_status != PETSC_SUCCESS ||
            reason_status != PETSC_SUCCESS ||
            (!solve_interrupted && eps_reason <= EPS_CONVERGED_ITERATING)) {
            cleanup();
            return fail(
                out_result,
                solve_interrupted
                    ? FrequencyDomainStatus::interrupted
                    : FrequencyDomainStatus::solve_error,
                solve_interrupted
                    ? "GPU K0 SLEPc CUDA solve was cancelled"
                    : "GPU K0 SLEPc CUDA solve failed",
                solve_interrupted
                    ? "cancel_requested"
                    : eps_reason == EPS_DIVERGED_ITS
                        ? "gpu_slepc_max_iterations"
                        : eps_reason == EPS_DIVERGED_BREAKDOWN
                            ? "gpu_slepc_breakdown"
                            : "gpu_slepc_solve_failed");
        }
        out_result->outer_iterations = static_cast<std::uint32_t>(std::max<PetscInt>(0, iterations));
        out_result->converged_eigenpair_count =
            static_cast<std::uint32_t>(std::max<PetscInt>(0, converged));
        PetscInt shift_linear_iterations = 0;
        if (st_ksp != nullptr &&
            KSPGetTotalIterations(st_ksp, &shift_linear_iterations) == PETSC_SUCCESS) {
            out_result->shift_linear_iteration_count = static_cast<std::uint64_t>(
                std::max<PetscInt>(0, shift_linear_iterations));
        }

        // Preserve converged Ritz pairs on cancellation.  Their final Schur
        // action still needs the cached Poisson KSP, but cancellation must no
        // longer abort that read-only reconstruction pass.  The temporary
        // problem copy lives until all candidates have been inspected; the
        // next request rebinds the persistent KSP to its own live callbacks.
        PoissonAirboxEigenBlockProblem extraction_problem = problem;
        if (solve_interrupted && schur->poisson_ksp != nullptr) {
            extraction_problem.cancel_requested = nullptr;
            extraction_problem.progress_callback = nullptr;
            if (KSPSetConvergenceTest(
                    schur->poisson_ksp,
                    gpu_modal_ksp_convergence_test,
                    &extraction_problem,
                    nullptr) != PETSC_SUCCESS) {
                cleanup();
                return fail(
                    out_result,
                    FrequencyDomainStatus::interrupted,
                    "GPU K0 cancellation extraction setup failed",
                    "cancel_requested");
            }
        }

        struct Candidate {
            PetscInt index = -1;
            double omega = 0.0;
            double frequency = 0.0;
            double action_residual = 0.0;
            PoissonAirboxModalResidualMetrics metrics{};
        };
        std::vector<Candidate> candidates;
        candidates.reserve(static_cast<std::size_t>(std::max<PetscInt>(0, converged)));
        double best_action_residual = std::numeric_limits<double>::infinity();
        double observed_positive_min_hz = std::numeric_limits<double>::infinity();
        double observed_positive_max_hz = 0.0;
        PoissonAirboxModalResidualMetrics best_metrics{};
        best_metrics.reconstructed_full_descriptor_backward_error =
            std::numeric_limits<double>::infinity();
        for (PetscInt index = 0; index < converged; ++index) {
            PetscScalar kr = 0.0;
            PetscScalar ki = 0.0;
            if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != PETSC_SUCCESS) {
                continue;
            }
            const double eigenvalue = static_cast<double>(PetscRealPart(kr));
            const double omega = eigenvalue * angular_frequency_scale;
            const double imaginary =
                static_cast<double>(PetscRealPart(ki)) * angular_frequency_scale;
            if (!std::isfinite(omega) ||
                std::abs(imaginary) > std::max(1.0e-10, 1.0e-10 * std::abs(omega))) {
                continue;
            }
            ++out_result->finite_real_eigenpair_count;
            const ModeKinematics kinematics = map_eigenvalue(
                {0.0, omega}, FrequencyDomainPhaseConvention::exp_i_omega_t);
            if (!select_positive_frequency_mode(kinematics, ZeroFrequencyModePolicy::exclude)) {
                continue;
            }
            ++out_result->positive_frequency_eigenpair_count;
            observed_positive_min_hz = std::min(
                observed_positive_min_hz, kinematics.frequency_hz);
            observed_positive_max_hz = std::max(
                observed_positive_max_hz, kinematics.frequency_hz);
            if (string_equals(problem.target_kind, "frequency_window") &&
                (kinematics.frequency_hz < problem.frequency_min_hz ||
                 kinematics.frequency_hz > problem.frequency_max_hz)) {
                continue;
            }

            PetscReal action_norm = 0.0;
            PetscReal mass_norm = 0.0;
            PetscReal residual_norm = 0.0;
            PetscErrorCode residual_error = MatMult(shell, xr, persistent->action_probe);
            if (residual_error == PETSC_SUCCESS) {
                residual_error = MatMult(mass, xr, persistent->mass_action_probe);
            }
            if (residual_error == PETSC_SUCCESS) {
                residual_error = VecWAXPY(
                    persistent->residual_probe,
                    -eigenvalue,
                    persistent->mass_action_probe,
                    persistent->action_probe);
            }
            if (residual_error == PETSC_SUCCESS) {
                residual_error = VecNorm(persistent->action_probe, NORM_2, &action_norm);
            }
            if (residual_error == PETSC_SUCCESS) {
                residual_error = VecNorm(persistent->mass_action_probe, NORM_2, &mass_norm);
            }
            if (residual_error == PETSC_SUCCESS) {
                residual_error = VecNorm(persistent->residual_probe, NORM_2, &residual_norm);
            }
            if (residual_error != PETSC_SUCCESS) {
                continue;
            }
            ++out_result->action_residual_evaluated_count;
            const double action_residual = residual_norm /
                (action_norm + std::abs(eigenvalue) * mass_norm + 1.0e-300);
            best_action_residual = std::min(best_action_residual, action_residual);

            if (scatter_split_input(split, xr) != PETSC_SUCCESS ||
                apply_schur(schur, split->q_real, split->y_real, split->phi_real) != PETSC_SUCCESS ||
                apply_schur(schur, split->q_imag, split->y_imag, split->phi_imag) != PETSC_SUCCESS) {
                continue;
            }
            PoissonAirboxModalResidualMetrics metrics{};
            const PetscErrorCode device_residual_error = device_modal_residual_metrics(
                problem,
                schur,
                split,
                &persistent->residual_workspace,
                omega,
                action_residual,
                &metrics);
            const FrequencyDomainStatus residual_status = device_residual_error == PETSC_SUCCESS
                ? FrequencyDomainStatus::ok
                : FrequencyDomainStatus::operator_error;
            if (residual_status == FrequencyDomainStatus::ok) {
                ++out_result->reconstructed_mode_count;
            }
            if (residual_status == FrequencyDomainStatus::ok &&
                metrics.reconstructed_full_descriptor_backward_error <
                    best_metrics.reconstructed_full_descriptor_backward_error) {
                best_metrics = metrics;
            }
            if (residual_status != FrequencyDomainStatus::ok ||
                metrics.reconstructed_full_descriptor_backward_error > problem.residual_tolerance) {
                continue;
            }
            ++out_result->full_residual_accepted_count;
            candidates.push_back(Candidate{
                index,
                omega,
                kinematics.frequency_hz,
                action_residual,
                metrics});
        }
        if (candidates.empty()) {
            out_result->slepc_reported_backward_error =
                std::isfinite(best_action_residual) ? best_action_residual : 0.0;
            if (std::isfinite(best_metrics.reconstructed_full_descriptor_backward_error)) {
                out_result->full_residual_reconstruction_relative_error =
                    best_metrics.reconstructed_full_descriptor_backward_error;
                out_result->magnetic_block_backward_error =
                    best_metrics.magnetic_block_backward_error;
                out_result->poisson_block_backward_error =
                    best_metrics.poisson_block_backward_error;
            }
            cleanup();
            return fail(
                out_result,
                solve_interrupted
                    ? FrequencyDomainStatus::interrupted
                    : FrequencyDomainStatus::solve_error,
                solve_interrupted
                    ? "GPU K0 cancellation preserved no complete mode"
                    : "GPU K0 SLEPc found no certified positive-frequency mode",
                solve_interrupted
                    ? "cancel_requested"
                    : "gpu_no_certified_positive_frequency_mode",
                std::isfinite(observed_positive_min_hz) ? observed_positive_min_hz : 0.0,
                observed_positive_max_hz);
        }
        std::sort(candidates.begin(), candidates.end(), [target_omega](const Candidate &left, const Candidate &right) {
            return std::abs(left.omega - target_omega) < std::abs(right.omega - target_omega);
        });
        if (candidates.size() > problem.requested_mode_count) {
            candidates.resize(problem.requested_mode_count);
        }
        for (const Candidate &candidate : candidates) {
            PetscScalar candidate_kr = 0.0;
            PetscScalar candidate_ki = 0.0;
            if (EPSGetEigenpair(eps, candidate.index, &candidate_kr, &candidate_ki, xr, xi) !=
                    PETSC_SUCCESS ||
                scatter_split_input(split, xr) != PETSC_SUCCESS ||
                apply_schur(schur, split->q_real, split->y_real, split->phi_real) !=
                    PETSC_SUCCESS ||
                apply_schur(schur, split->q_imag, split->y_imag, split->phi_imag) !=
                    PETSC_SUCCESS) {
                cleanup();
                return fail(
                    out_result,
                    FrequencyDomainStatus::solve_error,
                    "GPU K0 accepted mode export failed",
                    "gpu_final_mode_export_failed");
            }
            std::vector<double> q_real;
            std::vector<double> q_imag;
            std::vector<double> phi_real;
            std::vector<double> phi_imag;
            if (!copy_cuda_vector_to_host(
                    split->q_real,
                    &q_real,
                    &out_result->final_d2h_transfer_count) ||
                !copy_cuda_vector_to_host(
                    split->q_imag,
                    &q_imag,
                    &out_result->final_d2h_transfer_count) ||
                !copy_cuda_vector_to_host(
                    split->phi_real,
                    &phi_real,
                    &out_result->final_d2h_transfer_count) ||
                !copy_cuda_vector_to_host(
                    split->phi_imag,
                    &phi_imag,
                    &out_result->final_d2h_transfer_count)) {
                cleanup();
                return fail(
                    out_result,
                    FrequencyDomainStatus::solve_error,
                    "GPU K0 accepted mode host export failed",
                    "gpu_final_mode_host_export_failed");
            }
            PoissonAirboxModalEigenResult::AcceptedMode mode{};
            mode.eigenpair_index = static_cast<std::uint32_t>(candidate.index);
            mode.eigenvalue_imag = candidate.omega;
            mode.omega_rad_s = candidate.omega;
            mode.frequency_hz = candidate.frequency;
            mode.slepc_reported_backward_error = candidate.action_residual;
            mode.relative_residual = candidate.metrics.reconstructed_full_descriptor_backward_error;
            mode.full_residual_reconstruction_relative_error = mode.relative_residual;
            mode.magnetic_block_backward_error = candidate.metrics.magnetic_block_backward_error;
            mode.poisson_block_backward_error = candidate.metrics.poisson_block_backward_error;
            mode.gauge_constraint_backward_error = candidate.metrics.gauge_constraint_backward_error;
            mode.gauge_mean_abs = candidate.metrics.gauge_mean_abs;
            mode.full_vector.reserve(q_real.size() + phi_real.size());
            for (std::size_t component = 0; component < q_real.size(); ++component) {
                mode.full_vector.emplace_back(q_real[component], q_imag[component]);
            }
            for (std::size_t component = 0; component < phi_real.size(); ++component) {
                mode.full_vector.emplace_back(phi_real[component], phi_imag[component]);
            }
            out_result->accepted_modes.push_back(std::move(mode));
        }
        const Candidate &selected = candidates.front();
        out_result->operator_apply_count = schur->operator_apply_count - operator_apply_before;
        out_result->poisson_solve_count = schur->poisson_solve_count - poisson_solve_before;
        out_result->poisson_iteration_count =
            schur->poisson_iteration_count - poisson_iteration_before;
        out_result->accepted_mode_count = static_cast<std::uint32_t>(candidates.size());
        out_result->selected_eigenpair_index = static_cast<std::uint32_t>(selected.index);
        out_result->positive_frequency_branch_found = true;
        out_result->eigenvalue_imag = selected.omega;
        out_result->omega_rad_s = selected.omega;
        out_result->frequency_hz = selected.frequency;
        if (apply_poisson_airbox_modal_residual_certification(
                selected.metrics, problem.residual_tolerance, out_result) != FrequencyDomainStatus::ok) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 full descriptor residual certification failed",
                "gpu_full_residual_not_certified");
        }
        if (problem.expected_reference_frequency_hz > 0.0) {
            out_result->relative_reference_frequency_error =
                std::abs(out_result->frequency_hz - problem.expected_reference_frequency_hz) /
                problem.expected_reference_frequency_hz;
        }
        out_result->reference_frequency_certified =
            problem.expected_reference_frequency_hz <= 0.0 ||
            out_result->relative_reference_frequency_error <= 1.0e-7;
        out_result->status = solve_interrupted
            ? FrequencyDomainStatus::interrupted
            : FrequencyDomainStatus::ok;
        copy_message(out_result->error_message, sizeof(out_result->error_message), "");
        const char *matrix_type = nullptr;
        const char *vector_type = nullptr;
        const char *basis_type = nullptr;
        const char *poisson_pc_type = nullptr;
        const char *shift_pc_type = nullptr;
        MatGetType(mass, &matrix_type);
        VecGetType(xr, &vector_type);
        PC poisson_pc = nullptr;
        KSPGetPC(schur->poisson_ksp, &poisson_pc);
        PCGetType(poisson_pc, &poisson_pc_type);
        PCGetType(st_pc, &shift_pc_type);
        BV basis = nullptr;
        Vec basis_column = nullptr;
        if (EPSGetBV(eps, &basis) == PETSC_SUCCESS &&
            BVGetColumn(basis, 0, &basis_column) == PETSC_SUCCESS) {
            VecGetType(basis_column, &basis_type);
            BVRestoreColumn(basis, 0, &basis_column);
        }
        out_result->device_residency_verified =
            string_equals(matrix_type, "seqaijcusparse") &&
            string_equals(vector_type, "seqcuda") &&
            string_equals(basis_type, "seqcuda");
        if (!out_result->device_residency_verified) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 PETSc/SLEPc device object residency could not be verified",
                "gpu_device_residency_unverified");
        }
        write_success_diagnostics(
            problem,
            *out_result,
            matrix_type,
            vector_type,
            basis_type,
            poisson_pc_type,
            shift_pc_type,
            materialized_shifted_operator
                ? "materialized_schur_cuda"
                : "matrix_free_schur_cuda",
            out_result);
        cleanup();
        return out_result->status;
    } catch (...) {
        cleanup();
        return fail(
            out_result,
            FrequencyDomainStatus::operator_error,
            "GPU K0 PETSc/SLEPc allocation failed",
            "gpu_allocation_failure");
    }
#endif
}

FrequencyDomainStatus finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() noexcept
{
#if !FULLMAG_FEM_WITH_SLEPC
    return FrequencyDomainStatus::unavailable;
#else
    std::lock_guard<std::mutex> lock(gpu_slepc_mutex());
    destroy_cached_gpu_context();
    if (!owns_slepc_initialization()) {
        return FrequencyDomainStatus::ok;
    }
    PetscBool finalized = PETSC_FALSE;
    if (PetscFinalized(&finalized) != PETSC_SUCCESS) {
        return FrequencyDomainStatus::operator_error;
    }
    if (finalized == PETSC_FALSE && SlepcFinalize() != PETSC_SUCCESS) {
        return FrequencyDomainStatus::operator_error;
    }
    owns_slepc_initialization() = false;
    return FrequencyDomainStatus::ok;
#endif
}

} // namespace fullmag::fem::frequency_domain
