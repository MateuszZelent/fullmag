#include "frequency_domain/modal_gpu_krylov.hpp"

#include "frequency_domain/mode_kinematics.hpp"
#include "gpu/cuda/runtime/hypre_device_policy.hpp"

#include <petscdevice.h>
#include <petscksp.h>
#include <slepceps.h>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <string>
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

void publish_hypre_device_policy(
    const HypreDevicePolicySnapshot &snapshot,
    PoissonAirboxModalEigenResult *result) noexcept
{
    if (result == nullptr) {
        return;
    }
    result->hypre_device_policy_observed = true;
    result->hypre_device_policy_configured = snapshot.configured;
    result->hypre_memory_location_device = snapshot.memory_location_device;
    result->hypre_execution_policy_device = snapshot.execution_policy_device;
    result->hypre_vendor_sptrans_enabled = snapshot.vendor_sptrans_enabled;
    result->hypre_vendor_spmv_enabled = snapshot.vendor_spmv_enabled;
    result->hypre_vendor_spgemm_enabled = snapshot.vendor_spgemm_enabled;
    result->hypre_first_error_code = snapshot.first_error_code;
    copy_message(
        result->hypre_failure_reason,
        sizeof(result->hypre_failure_reason),
        snapshot.failure_reason.c_str());
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
    Mat b_qq = nullptr;
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
    HypreDevicePolicySnapshot hypre_device_policy{};
    bool convergence_callback_installed = false;
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

std::uint64_t next_solve_control_generation() noexcept
{
    static std::uint64_t generation = 0u;
    return ++generation;
}

struct GpuSolveControl {
    // PETSc/SLEPc keep this address in persistent callback registrations.  The
    // current request's callable state is copied in only while the synchronous
    // solve is active and is cleared before the request returns.
    PoissonAirboxEigenBlockProblem callback_problem{};
    std::uint64_t generation = 0u;
    std::uint32_t monitor_iteration_count = 0;
    std::uint32_t last_converged_count = 0;
    double last_error_estimate = 0.0;
    bool armed = false;
    bool cancel_poll_enabled = false;
    bool progress_enabled = false;
    bool cancellation_observed = false;

    void arm(const PoissonAirboxEigenBlockProblem &problem) noexcept
    {
        callback_problem = PoissonAirboxEigenBlockProblem{};
        callback_problem.residual_tolerance = problem.residual_tolerance;
        callback_problem.max_outer_iterations = problem.max_outer_iterations;
        callback_problem.max_linear_iterations = problem.max_linear_iterations;
        callback_problem.cancel_user_data = problem.cancel_user_data;
        callback_problem.cancel_requested = problem.cancel_requested;
        callback_problem.progress_user_data = problem.progress_user_data;
        callback_problem.progress_callback = problem.progress_callback;
        generation = next_solve_control_generation();
        monitor_iteration_count = 0u;
        last_converged_count = 0u;
        last_error_estimate = 0.0;
        cancellation_observed = false;
        cancel_poll_enabled = problem.cancel_requested != nullptr;
        progress_enabled = problem.progress_callback != nullptr;
        armed = true;
    }

    void disarm() noexcept
    {
        armed = false;
        cancel_poll_enabled = false;
        progress_enabled = false;
        callback_problem = PoissonAirboxEigenBlockProblem{};
    }
};

struct GpuSolveControlArm {
    GpuSolveControl *control = nullptr;

    ~GpuSolveControlArm()
    {
        if (control != nullptr) {
            control->disarm();
        }
    }
};

struct GpuKspConvergenceContext {
    GpuSolveControl *solve_control = nullptr;
    void *default_context = nullptr;
};

PetscErrorCode gpu_modal_ksp_convergence_test(
    KSP,
    PetscInt,
    PetscReal,
    KSPConvergedReason *,
    void *);

PetscErrorCode destroy_gpu_modal_ksp_convergence_context(void **raw_context)
{
    PetscFunctionBeginUser;
    if (raw_context == nullptr || *raw_context == nullptr) {
        PetscFunctionReturn(PETSC_SUCCESS);
    }
    auto *context = static_cast<GpuKspConvergenceContext *>(*raw_context);
    PetscCall(KSPConvergedDefaultDestroy(&context->default_context));
    delete context;
    *raw_context = nullptr;
    PetscFunctionReturn(PETSC_SUCCESS);
}

PetscErrorCode install_gpu_modal_ksp_convergence_test(
    KSP ksp,
    GpuSolveControl *solve_control)
{
    PetscFunctionBeginUser;
    PetscCheck(ksp != nullptr && solve_control != nullptr,
               PETSC_COMM_SELF,
               PETSC_ERR_ARG_NULL,
               "missing GPU modal KSP convergence installation input");
    auto *context = new (std::nothrow) GpuKspConvergenceContext{};
    PetscCheck(context != nullptr,
               PETSC_COMM_SELF,
               PETSC_ERR_MEM,
               "failed to allocate GPU modal KSP convergence context");
    context->solve_control = solve_control;
    PetscErrorCode status = KSPConvergedDefaultCreate(&context->default_context);
    if (status == PETSC_SUCCESS) {
        status = KSPSetConvergenceTest(
            ksp,
            gpu_modal_ksp_convergence_test,
            context,
            destroy_gpu_modal_ksp_convergence_context);
    }
    if (status != PETSC_SUCCESS) {
        const PetscErrorCode destroy_status =
            destroy_gpu_modal_ksp_convergence_context(
                reinterpret_cast<void **>(&context));
        PetscFunctionReturn(
            status != PETSC_SUCCESS ? status : destroy_status);
    }
    PetscFunctionReturn(PETSC_SUCCESS);
}

bool gpu_modal_cancel_requested(const GpuSolveControl &control) noexcept
{
    return control.armed && control.cancel_poll_enabled &&
        poisson_airbox_modal_cancel_requested(control.callback_problem);
}

void gpu_modal_emit_progress(
    const GpuSolveControl &control,
    const char *solver_phase,
    std::uint32_t outer_iteration,
    std::uint32_t candidate_mode_count,
    std::uint32_t linear_iteration,
    double residual_relative,
    const char *stop_reason = nullptr) noexcept
{
    if (!control.armed || !control.progress_enabled) {
        return;
    }
    poisson_airbox_modal_emit_progress(
        control.callback_problem,
        solver_phase,
        "production_gpu",
        outer_iteration,
        candidate_mode_count,
        0,
        linear_iteration,
        residual_relative,
        stop_reason);
}

PetscErrorCode gpu_modal_ksp_convergence_test(
    KSP ksp,
    PetscInt iteration,
    PetscReal residual_norm,
    KSPConvergedReason *reason,
    void *raw_control)
{
    PetscFunctionBeginUser;
    auto *context = static_cast<GpuKspConvergenceContext *>(raw_control);
    PetscCheck(context != nullptr && context->solve_control != nullptr &&
                   context->default_context != nullptr,
               PETSC_COMM_SELF, PETSC_ERR_ARG_NULL,
               "missing GPU modal solve control");
    GpuSolveControl *control = context->solve_control;
    if (gpu_modal_cancel_requested(*control)) {
        if (reason != nullptr) {
            *reason = KSP_DIVERGED_USER;
        }
        gpu_modal_emit_progress(
            *control,
            "cancelling_shift_invert",
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            0,
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            static_cast<double>(residual_norm),
            "cancel_requested");
        PetscFunctionReturn(PETSC_SUCCESS);
    }
    PetscCall(KSPConvergedDefault(
        ksp, iteration, residual_norm, reason, context->default_context));
    gpu_modal_emit_progress(
        *control,
        "solving_shift_invert",
        static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
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
    auto *control = static_cast<GpuSolveControl *>(raw_control);
    PetscCheck(control != nullptr,
               PETSC_COMM_SELF,
               PETSC_ERR_ARG_NULL,
               "missing GPU modal EPS monitor context");
    if (!control->armed) {
        PetscFunctionReturn(PETSC_SUCCESS);
    }
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
    gpu_modal_emit_progress(
        *control,
        "solving_eigensystem",
        control->monitor_iteration_count,
        control->last_converged_count,
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
    auto *control = static_cast<GpuSolveControl *>(raw_control);
    PetscCheck(control != nullptr && reason != nullptr,
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
    if (gpu_modal_cancel_requested(*control)) {
        control->cancellation_observed = true;
        *reason = EPS_CONVERGED_USER;
        gpu_modal_emit_progress(
            *control,
            "cancelling_eigensystem",
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            static_cast<std::uint32_t>(std::max<PetscInt>(0, converged)),
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
    context->convergence_callback_installed = false;
    if (context->poisson) MatDestroy(&context->poisson);
    if (context->a_phiq) MatDestroy(&context->a_phiq);
    if (context->a_qphi) MatDestroy(&context->a_qphi);
    if (context->b_qq) MatDestroy(&context->b_qq);
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
    if (!problem.validation_only_adapter) {
        context->hypre_device_policy = configure_hypre_cuda_device_policy();
        if (!hypre_cuda_device_policy_is_available(context->hypre_device_policy)) {
            copy_message(
                context->error_message,
                sizeof(context->error_message),
                context->hypre_device_policy.failure_reason.empty()
                    ? kHypreCudaDevicePolicyUnavailable
                    : context->hypre_device_policy.failure_reason.c_str());
            return false;
        }
    }
    if (!create_cuda_csr_matrix(
            problem.A_qq,
            &context->a_qq,
            &context->setup_h2d_transfer_count) ||
        !create_cuda_csr_matrix(
            problem.B_qq,
            &context->b_qq,
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
        KSPSetType(
            context->poisson_ksp,
            problem.validation_only_adapter ? KSPPREONLY : KSPCG) != PETSC_SUCCESS ||
        KSPGetPC(context->poisson_ksp, &pc) != PETSC_SUCCESS ||
        (problem.validation_only_adapter
             ? PCSetType(pc, PCILU) != PETSC_SUCCESS ||
                 PCFactorSetMatSolverType(pc, MATSOLVERCUSPARSE) != PETSC_SUCCESS
             : PCSetType(pc, PCHYPRE) != PETSC_SUCCESS ||
                 PCHYPRESetType(pc, "boomeramg") != PETSC_SUCCESS) ||
        KSPSetTolerances(
            context->poisson_ksp,
            inner_linear_tolerance(problem.residual_tolerance),
            1.0e-50,
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
    // KSPSolve may converge immediately for a zero or tiny right-hand side.
    // Never let that path expose phi from the preceding persistent solve.
    PetscCall(VecSet(context->phi_solution, 0.0));
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

struct GpuOperatorIdentity {
    std::string mesh_generation_identity;
    std::string equilibrium_digest;
    std::string bias_field_sample_signature;
    std::string boundary_gauge_digest;
    std::string operator_input_digest;
    std::uint64_t validation_content_signature = 0u;
    std::uint64_t aggregate = 0u;
    bool canonical_shared_domain_identity = false;
};

struct GpuSolverObjectIds {
    PetscObjectId shell = 0;
    PetscObjectId mass = 0;
    PetscObjectId preconditioner = 0;
    PetscObjectId eps = 0;
    PetscObjectId st = 0;
    PetscObjectId ksp = 0;
    PetscObjectId pc = 0;
    PetscObjectId basis = 0;
    PetscObjectId xr = 0;
    PetscObjectId xi = 0;
    PetscObjectId residual_workspace = 0;
    bool valid = false;
};

struct GpuSolverState {
    Mat shell = nullptr;
    Mat mass = nullptr;
    Mat preconditioner = nullptr;
    Mat materialized_operator = nullptr;
    EPS eps = nullptr;
    ST st = nullptr;
    KSP st_ksp = nullptr;
    PC st_pc = nullptr;
    BV basis = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    PetscInt dimension = 0;
    PetscInt nev_capacity = 0;
    PetscInt ncv_capacity = 0;
    double mass_scale = 1.0;
    double angular_frequency_scale = 1.0;
    double operator_scale = 1.0;
    double target_eigenvalue = 0.0;
    double target_omega = 0.0;
    std::uint64_t generation = 0u;
    GpuSolverObjectIds last_successful_object_ids{};
    bool exact_shifted_preconditioner = false;
    bool materialized_eigensolver_operator = false;
    bool convergence_callbacks_installed = false;
    bool ready = false;
};

struct GpuPersistenceSnapshot {
    std::uint64_t operator_context_generation = 0u;
    std::uint64_t solver_context_generation = 0u;
    std::uint64_t solve_control_generation = 0u;
    std::uint32_t reuse_mask = 0u;
    const char *invalidation_reason = "not_started";
    bool operator_context_reused = false;
    bool solver_context_reused = false;
    bool public_petsc_object_ids_reused = false;
    bool persistence_verified = false;
};

constexpr std::uint32_t kReuseShell = 1u << 0u;
constexpr std::uint32_t kReuseMass = 1u << 1u;
constexpr std::uint32_t kReusePreconditioner = 1u << 2u;
constexpr std::uint32_t kReuseEps = 1u << 3u;
constexpr std::uint32_t kReuseSt = 1u << 4u;
constexpr std::uint32_t kReuseKsp = 1u << 5u;
constexpr std::uint32_t kReusePc = 1u << 6u;
constexpr std::uint32_t kReuseBasis = 1u << 7u;
constexpr std::uint32_t kReuseSolutionVectors = 1u << 8u;
constexpr std::uint32_t kReuseResidualWorkspace = 1u << 9u;

GpuPersistenceSnapshot &latest_persistence_snapshot() noexcept
{
    static GpuPersistenceSnapshot snapshot{};
    return snapshot;
}

std::uint64_t next_operator_context_generation() noexcept
{
    static std::uint64_t generation = 0u;
    return ++generation;
}

std::uint64_t next_solver_context_generation() noexcept
{
    static std::uint64_t generation = 0u;
    return ++generation;
}

void destroy_gpu_solver_state(GpuSolverState *state) noexcept
{
    if (state == nullptr) {
        return;
    }
    state->basis = nullptr;
    state->st_pc = nullptr;
    state->st_ksp = nullptr;
    state->st = nullptr;
    if (state->xi) VecDestroy(&state->xi);
    if (state->xr) VecDestroy(&state->xr);
    if (state->eps) EPSDestroy(&state->eps);
    if (state->materialized_operator) MatDestroy(&state->materialized_operator);
    if (state->preconditioner) MatDestroy(&state->preconditioner);
    if (state->mass) MatDestroy(&state->mass);
    if (state->shell) MatDestroy(&state->shell);
    *state = GpuSolverState{};
}

struct GpuPersistentContext {
    GpuSolveControl solve_control{};
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
    GpuSolverState solver{};
    GpuOperatorIdentity identity{};
    std::uint64_t operator_signature = 0;
    std::uint64_t operator_generation = 0u;
};

bool capture_gpu_solver_object_ids(
    const GpuPersistentContext &persistent,
    GpuSolverObjectIds *ids) noexcept
{
    const GpuSolverState &state = persistent.solver;
    if (ids == nullptr || state.shell == nullptr || state.mass == nullptr ||
        state.preconditioner == nullptr || state.eps == nullptr ||
        state.st == nullptr || state.st_ksp == nullptr || state.st_pc == nullptr ||
        state.basis == nullptr || state.xr == nullptr || state.xi == nullptr ||
        persistent.residual_workspace.a_qq_real == nullptr) {
        return false;
    }
    GpuSolverObjectIds captured{};
    const bool ok =
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.shell), &captured.shell) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.mass), &captured.mass) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.preconditioner),
            &captured.preconditioner) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.eps), &captured.eps) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.st), &captured.st) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.st_ksp), &captured.ksp) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.st_pc), &captured.pc) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.basis), &captured.basis) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.xr), &captured.xr) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(state.xi), &captured.xi) == PETSC_SUCCESS &&
        PetscObjectGetId(
            reinterpret_cast<PetscObject>(
                persistent.residual_workspace.a_qq_real),
            &captured.residual_workspace) == PETSC_SUCCESS;
    if (!ok) {
        return false;
    }
    captured.valid = true;
    *ids = captured;
    return true;
}

std::uint32_t gpu_solver_object_reuse_mask(
    const GpuSolverObjectIds &previous,
    const GpuSolverObjectIds &current) noexcept
{
    if (!previous.valid || !current.valid) {
        return 0u;
    }
    std::uint32_t mask = 0u;
    if (previous.shell == current.shell) mask |= kReuseShell;
    if (previous.mass == current.mass) mask |= kReuseMass;
    if (previous.preconditioner == current.preconditioner) {
        mask |= kReusePreconditioner;
    }
    if (previous.eps == current.eps) mask |= kReuseEps;
    if (previous.st == current.st) mask |= kReuseSt;
    if (previous.ksp == current.ksp) mask |= kReuseKsp;
    if (previous.pc == current.pc) mask |= kReusePc;
    if (previous.basis == current.basis) mask |= kReuseBasis;
    if (previous.xr == current.xr && previous.xi == current.xi) {
        mask |= kReuseSolutionVectors;
    }
    if (previous.residual_workspace == current.residual_workspace) {
        mask |= kReuseResidualWorkspace;
    }
    return mask;
}

bool same_gpu_solver_object_graph(
    const GpuSolverObjectIds &previous,
    const GpuSolverObjectIds &current) noexcept
{
    return previous.valid && current.valid &&
        previous.shell == current.shell &&
        previous.mass == current.mass &&
        previous.preconditioner == current.preconditioner &&
        previous.eps == current.eps &&
        previous.st == current.st &&
        previous.ksp == current.ksp &&
        previous.pc == current.pc &&
        previous.basis == current.basis &&
        previous.xr == current.xr &&
        previous.xi == current.xi &&
        previous.residual_workspace == current.residual_workspace;
}

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

std::uint64_t fnv1a_string(std::uint64_t hash, const char *value) noexcept
{
    const bool present = value != nullptr;
    hash = fnv1a_value(hash, present);
    return present ? fnv1a_update(hash, value, std::strlen(value)) : hash;
}

std::uint64_t fnv1a_csr_structure(
    std::uint64_t hash,
    const CsrMatrixView &matrix) noexcept
{
    hash = fnv1a_value(hash, matrix.row_count);
    hash = fnv1a_value(hash, matrix.column_count);
    hash = fnv1a_update(
        hash,
        matrix.row_offsets,
        static_cast<std::size_t>(matrix.row_offsets_len) * sizeof(matrix.row_offsets[0]));
    return fnv1a_update(
        hash,
        matrix.column_indices,
        static_cast<std::size_t>(matrix.column_indices_len) * sizeof(matrix.column_indices[0]));
}

std::uint64_t fnv1a_csr_values(
    std::uint64_t hash,
    const CsrMatrixView &matrix) noexcept
{
    return fnv1a_update(
        hash,
        matrix.values,
        static_cast<std::size_t>(matrix.values_len) * sizeof(matrix.values[0]));
}

GpuOperatorIdentity modal_operator_identity(
    const PoissonAirboxEigenBlockProblem &problem)
{
    constexpr std::uint64_t kFnvOffset = 1469598103934665603ull;
    GpuOperatorIdentity identity{};
    const auto present = [](const char *value) noexcept {
        return value != nullptr && value[0] != '\0';
    };
    identity.canonical_shared_domain_identity =
        present(problem.mesh_generation_identity) &&
        present(problem.equilibrium_digest) &&
        present(problem.bias_field_sample_signature) &&
        present(problem.boundary_gauge_digest) &&
        present(problem.operator_input_digest);
    if (identity.canonical_shared_domain_identity) {
        identity.mesh_generation_identity = problem.mesh_generation_identity;
        identity.equilibrium_digest = problem.equilibrium_digest;
        identity.bias_field_sample_signature = problem.bias_field_sample_signature;
        identity.boundary_gauge_digest = problem.boundary_gauge_digest;
        identity.operator_input_digest = problem.operator_input_digest;
        identity.aggregate = fnv1a_string(
            kFnvOffset, identity.mesh_generation_identity.c_str());
        identity.aggregate = fnv1a_string(
            identity.aggregate, identity.equilibrium_digest.c_str());
        identity.aggregate = fnv1a_string(
            identity.aggregate, identity.bias_field_sample_signature.c_str());
        identity.aggregate = fnv1a_string(
            identity.aggregate, identity.boundary_gauge_digest.c_str());
        identity.aggregate = fnv1a_string(
            identity.aggregate, identity.operator_input_digest.c_str());
        return identity;
    }

    const bool validation_content_identity =
        problem.validation_only_adapter &&
        string_equals(problem.assembly_kind, "synthetic_algebraic_oracle");
    if (!validation_content_identity) {
        return identity;
    }

    std::uint64_t signature = fnv1a_value(kFnvOffset, problem.q_dof_count);
    signature = fnv1a_value(signature, problem.phi_dof_count);
    const CsrMatrixView blocks[] = {
        problem.A_qq,
        problem.A_qphi,
        problem.A_phiq,
        problem.A_phiphi,
        problem.B_qq,
    };
    for (const CsrMatrixView &block : blocks) {
        signature = fnv1a_csr_structure(signature, block);
        signature = fnv1a_csr_values(signature, block);
    }
    signature = fnv1a_value(signature, problem.phi_mean_weights_count);
    const bool phi_mean_weights_present = problem.phi_mean_weights != nullptr;
    signature = fnv1a_value(signature, phi_mean_weights_present);
    if (phi_mean_weights_present) {
        signature = fnv1a_update(
            signature,
            problem.phi_mean_weights,
            static_cast<std::size_t>(problem.phi_mean_weights_count) * sizeof(double));
    }
    signature = fnv1a_string(signature, problem.outer_boundary_kind);
    signature = fnv1a_value(signature, problem.robin_beta);
    signature = fnv1a_string(signature, problem.gauge_policy);
    signature = fnv1a_string(signature, problem.gauge_reason);
    signature = fnv1a_string(signature, problem.assembly_kind);
    signature = fnv1a_string(signature, problem.demag_kind);
    signature = fnv1a_string(signature, problem.phasor_convention);
    signature = fnv1a_string(signature, problem.eigenvalue_convention);
    signature = fnv1a_string(
        signature, problem.periodic_mesh_certificate_schema);
    signature = fnv1a_value(signature, problem.magnetic_pair_count);
    signature = fnv1a_value(signature, problem.airbox_pair_count);
    signature = fnv1a_value(signature, problem.production_shared_domain);
    signature = fnv1a_value(signature, problem.validation_only_adapter);
    const std::size_t scalar_size = sizeof(PetscScalar);
    const std::size_t real_size = sizeof(PetscReal);
    const int real_digits = std::numeric_limits<PetscReal>::digits;
#if defined(PETSC_USE_COMPLEX)
    constexpr bool complex_scalar = true;
#else
    constexpr bool complex_scalar = false;
#endif
    signature = fnv1a_value(signature, scalar_size);
    signature = fnv1a_value(signature, real_size);
    signature = fnv1a_value(signature, real_digits);
    signature = fnv1a_value(signature, complex_scalar);
    identity.validation_content_signature = signature;
    identity.aggregate = signature;
    return identity;
}

bool same_operator_identity(
    const GpuOperatorIdentity &left,
    const GpuOperatorIdentity &right) noexcept
{
    if (left.canonical_shared_domain_identity !=
        right.canonical_shared_domain_identity) {
        return false;
    }
    if (!left.canonical_shared_domain_identity) {
        return left.validation_content_signature ==
            right.validation_content_signature;
    }
    return left.mesh_generation_identity == right.mesh_generation_identity &&
        left.equilibrium_digest == right.equilibrium_digest &&
        left.bias_field_sample_signature == right.bias_field_sample_signature &&
        left.boundary_gauge_digest == right.boundary_gauge_digest &&
        left.operator_input_digest == right.operator_input_digest;
}

const char *operator_invalidation_reason(
    const GpuOperatorIdentity &cached,
    const GpuOperatorIdentity &requested) noexcept
{
    if (cached.canonical_shared_domain_identity !=
        requested.canonical_shared_domain_identity) {
        return "canonical_operator_identity_binding_changed";
    }
    if (!cached.canonical_shared_domain_identity) {
        return "validation_operator_content_changed";
    }
    if (cached.mesh_generation_identity != requested.mesh_generation_identity) {
        return "mesh_generation_identity_changed";
    }
    if (cached.equilibrium_digest != requested.equilibrium_digest) {
        return "equilibrium_identity_changed";
    }
    if (cached.bias_field_sample_signature !=
        requested.bias_field_sample_signature) {
        return "bias_identity_changed";
    }
    if (cached.boundary_gauge_digest != requested.boundary_gauge_digest) {
        return "boundary_gauge_identity_changed";
    }
    if (cached.operator_input_digest != requested.operator_input_digest) {
        return "operator_input_identity_changed";
    }
    return "canonical_operator_identity_changed";
}

std::uint64_t modal_operator_signature(
    const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    return modal_operator_identity(problem).aggregate;
}

void destroy_cached_gpu_context() noexcept
{
    auto *context = cached_gpu_context();
    if (context == nullptr) {
        return;
    }
    context->solve_control.disarm();
    destroy_gpu_solver_state(&context->solver);
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
    bool *reused,
    const char **invalidation_reason) noexcept
{
    if (reused != nullptr) {
        *reused = false;
    }
    if (invalidation_reason != nullptr) {
        *invalidation_reason = "cold_start";
    }
    const GpuOperatorIdentity identity = modal_operator_identity(problem);
    const std::uint64_t signature = identity.aggregate;
    auto *cached = cached_gpu_context();
    if (cached != nullptr && same_operator_identity(cached->identity, identity)) {
        if (reused != nullptr) {
            *reused = true;
        }
        if (invalidation_reason != nullptr) {
            *invalidation_reason = "none";
        }
        return cached;
    }
    if (cached != nullptr) {
        if (invalidation_reason != nullptr) {
            *invalidation_reason = operator_invalidation_reason(cached->identity, identity);
        }
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
    created->identity = identity;
    created->operator_signature = signature;
    created->operator_generation = next_operator_context_generation();
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

PetscInt requested_gpu_nev(
    const PoissonAirboxEigenBlockProblem &problem,
    PetscInt dimension) noexcept
{
    const std::uint64_t requested =
        4u * static_cast<std::uint64_t>(
            std::max<std::uint32_t>(1u, problem.requested_mode_count));
    const PetscInt maximum_nev = dimension - 2;
    return static_cast<PetscInt>(std::min<std::uint64_t>(
        static_cast<std::uint64_t>(maximum_nev),
        requested));
}

bool create_gpu_solver_state(
    const PoissonAirboxEigenBlockProblem &problem,
    GpuPersistentContext *persistent,
    PetscInt dimension,
    double mass_scale,
    double angular_frequency_scale,
    double operator_scale,
    double target_omega,
    double target_eigenvalue,
    std::uint64_t *setup_h2d_transfer_count)
{
    if (persistent == nullptr) {
        return false;
    }
    GpuSolverState &state = persistent->solver;
    destroy_gpu_solver_state(&state);
    persistent->split.operator_scale = operator_scale;
    const PetscInt nev = requested_gpu_nev(problem, dimension);
    const PetscInt solver_nev = problem.validation_only_adapter ? dimension : nev;
    state.dimension = dimension;
    state.nev_capacity = solver_nev;
    state.ncv_capacity = problem.validation_only_adapter
        ? dimension
        : std::min(
              dimension,
              std::max<PetscInt>(nev + 1, 2 * nev));
    state.mass_scale = mass_scale;
    state.angular_frequency_scale = angular_frequency_scale;
    state.operator_scale = operator_scale;
    state.target_omega = target_omega;
    state.target_eigenvalue = target_eigenvalue;

    bool configured =
        MatCreateShell(
            PETSC_COMM_SELF,
            dimension,
            dimension,
            dimension,
            dimension,
            &persistent->split,
            &state.shell) == PETSC_SUCCESS &&
        MatShellSetVecType(state.shell, VECCUDA) == PETSC_SUCCESS &&
        MatShellSetOperation(
            state.shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(split_schur_matmult)) == PETSC_SUCCESS &&
        MatSetUp(state.shell) == PETSC_SUCCESS &&
        create_split_mass_cuda(
            problem.B_qq,
            mass_scale,
            &state.mass,
            setup_h2d_transfer_count);
    if (!configured) {
        destroy_gpu_solver_state(&state);
        return false;
    }

    state.exact_shifted_preconditioner =
        problem.validation_only_adapter &&
        create_materialized_shifted_operator_cuda(
            state.shell,
            state.mass,
            dimension,
            target_eigenvalue,
            &state.preconditioner,
            &state.materialized_operator);
    state.materialized_eigensolver_operator =
        problem.validation_only_adapter && state.exact_shifted_preconditioner;
    if (!state.exact_shifted_preconditioner &&
        !create_hypre_shift_preconditioner_cuda(
            problem.A_qq,
            problem.B_qq,
            target_omega,
            operator_scale,
            &state.preconditioner)) {
        destroy_gpu_solver_state(&state);
        return false;
    }

    configured =
        EPSCreate(PETSC_COMM_SELF, &state.eps) == PETSC_SUCCESS &&
        EPSSetOperators(
            state.eps,
            state.materialized_eigensolver_operator
                ? state.materialized_operator
                : state.shell,
            state.mass) == PETSC_SUCCESS &&
        EPSSetProblemType(state.eps, EPS_GNHEP) == PETSC_SUCCESS &&
        EPSSetType(
            state.eps,
            problem.validation_only_adapter ? EPSLAPACK : EPSKRYLOVSCHUR) == PETSC_SUCCESS &&
        EPSSetTrueResidual(state.eps, PETSC_TRUE) == PETSC_SUCCESS &&
        EPSSetDimensions(
            state.eps, solver_nev, state.ncv_capacity, PETSC_DEFAULT) == PETSC_SUCCESS &&
        EPSSetWhichEigenpairs(state.eps, EPS_TARGET_MAGNITUDE) == PETSC_SUCCESS &&
        EPSSetTarget(state.eps, target_eigenvalue) == PETSC_SUCCESS &&
        EPSSetTolerances(
            state.eps,
            transformed_eigensolver_tolerance(problem.residual_tolerance),
            std::max<PetscInt>(
                128, static_cast<PetscInt>(problem.max_outer_iterations))) == PETSC_SUCCESS &&
        EPSGetST(state.eps, &state.st) == PETSC_SUCCESS &&
        STSetType(
            state.st,
            problem.validation_only_adapter ? STSHIFT : STSINVERT) == PETSC_SUCCESS &&
        STSetShift(state.st, target_eigenvalue) == PETSC_SUCCESS &&
        (problem.validation_only_adapter ||
         STSetPreconditionerMat(state.st, state.preconditioner) == PETSC_SUCCESS) &&
        STGetKSP(state.st, &state.st_ksp) == PETSC_SUCCESS &&
        KSPSetType(
            state.st_ksp,
            problem.validation_only_adapter ? KSPPREONLY : KSPGMRES) == PETSC_SUCCESS &&
        (problem.validation_only_adapter ||
         (KSPGMRESSetRestart(
              state.st_ksp, std::min<PetscInt>(dimension, 128)) == PETSC_SUCCESS &&
          KSPGMRESSetCGSRefinementType(
              state.st_ksp, KSP_GMRES_CGS_REFINE_ALWAYS) == PETSC_SUCCESS)) &&
        KSPGetPC(state.st_ksp, &state.st_pc) == PETSC_SUCCESS &&
        KSPSetTolerances(
            state.st_ksp,
            inner_linear_tolerance(problem.residual_tolerance),
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            std::max<PetscInt>(
                512, static_cast<PetscInt>(problem.max_linear_iterations))) == PETSC_SUCCESS &&
        KSPSetErrorIfNotConverged(state.st_ksp, PETSC_TRUE) == PETSC_SUCCESS &&
        EPSSetStoppingTestFunction(
            state.eps,
            gpu_modal_eps_stopping_test,
            &persistent->solve_control,
            nullptr) == PETSC_SUCCESS &&
        EPSSetStoppingTest(state.eps, EPS_STOP_USER) == PETSC_SUCCESS &&
        EPSMonitorSet(
            state.eps,
            gpu_modal_eps_monitor,
            &persistent->solve_control,
            nullptr) == PETSC_SUCCESS &&
        create_cuda_vector(dimension, &state.xr) == PETSC_SUCCESS &&
        create_cuda_vector(dimension, &state.xi) == PETSC_SUCCESS;
    if (configured) {
        configured = state.exact_shifted_preconditioner
            ? PCSetType(state.st_pc, PCILU) == PETSC_SUCCESS &&
                PCFactorSetMatSolverType(
                    state.st_pc, MATSOLVERCUSPARSE) == PETSC_SUCCESS
            : PCSetType(state.st_pc, PCHYPRE) == PETSC_SUCCESS &&
                PCHYPRESetType(state.st_pc, "boomeramg") == PETSC_SUCCESS;
    }
    if (!configured) {
        destroy_gpu_solver_state(&state);
        return false;
    }
    state.generation = next_solver_context_generation();
    state.ready = true;
    return true;
}

bool configure_gpu_solver_request(
    const PoissonAirboxEigenBlockProblem &problem,
    GpuPersistentContext *persistent)
{
    if (persistent == nullptr || !persistent->solver.ready) {
        return false;
    }
    GpuSolverState &state = persistent->solver;
    const PetscInt nev = requested_gpu_nev(problem, state.dimension);
    const PetscInt solver_nev = problem.validation_only_adapter
        ? state.dimension
        : nev;
    bool configured = solver_nev <= state.nev_capacity &&
        // EPSSetDimensions explicitly returns a solved EPS to INITIAL without
        // destroying the persistent EPS/ST/KSP/BV graph when capacities stay
        // unchanged.
        EPSSetDimensions(
            state.eps, solver_nev, state.ncv_capacity, PETSC_DEFAULT) == PETSC_SUCCESS &&
        EPSSetTolerances(
            state.eps,
            transformed_eigensolver_tolerance(problem.residual_tolerance),
            std::max<PetscInt>(
                128, static_cast<PetscInt>(problem.max_outer_iterations))) == PETSC_SUCCESS &&
        KSPSetTolerances(
            state.st_ksp,
            inner_linear_tolerance(problem.residual_tolerance),
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            std::max<PetscInt>(
                512, static_cast<PetscInt>(problem.max_linear_iterations))) == PETSC_SUCCESS &&
        KSPSetTolerances(
            persistent->schur.poisson_ksp,
            inner_linear_tolerance(problem.residual_tolerance),
            1.0e-50,
            PETSC_DEFAULT,
            std::max<PetscInt>(
                256, static_cast<PetscInt>(problem.max_linear_iterations))) == PETSC_SUCCESS;
    const bool apply_options =
        std::getenv("FULLMAG_FEM_GPU_K0_PETSC_OPTIONS") != nullptr;
    if (configured && apply_options) {
        configured =
            KSPSetFromOptions(state.st_ksp) == PETSC_SUCCESS &&
            KSPSetFromOptions(persistent->schur.poisson_ksp) == PETSC_SUCCESS;
    }
    if (configured &&
        (apply_options || !state.convergence_callbacks_installed)) {
        configured =
            install_gpu_modal_ksp_convergence_test(
                state.st_ksp, &persistent->solve_control) == PETSC_SUCCESS;
        state.convergence_callbacks_installed = configured;
    }
    if (configured &&
        (apply_options ||
         !persistent->schur.convergence_callback_installed)) {
        configured =
            install_gpu_modal_ksp_convergence_test(
                persistent->schur.poisson_ksp,
                &persistent->solve_control) == PETSC_SUCCESS;
        persistent->schur.convergence_callback_installed = configured;
    }
    return configured;
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
    const GpuPersistenceSnapshot &persistence = latest_persistence_snapshot();
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
        "\"window_certificate\":%s,"
        "\"window_subwindow_count\":%u,"
        "\"window_completed_subwindow_count\":%u,"
        "\"window_failed_subwindow_count\":%u,"
        "\"window_empty_subwindow_count\":%u,"
        "\"window_complete\":%s,"
        "\"window_failed_subwindow\":%s,"
        "\"window_cancelled\":%s,"
        "\"stop_reason\":\"%s\","
        "\"persistent_solver_context\":%s,"
        "\"persistent_context_verified\":%s,"
        "\"operator_context_reused\":%s,"
        "\"solver_context_reused\":%s,"
        "\"public_petsc_object_ids_reused\":%s,"
        "\"persistence_verified\":%s,"
        "\"operator_context_generation\":%llu,"
        "\"solver_context_generation\":%llu,"
        "\"solve_control_generation\":%llu,"
        "\"reuse_mask\":\"0x%08x\","
        "\"invalidation_reason\":\"%s\","
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
        result->window_certificate_json[0] != '\0'
            ? result->window_certificate_json
            : "{}",
        result->window_subwindow_count,
        result->window_completed_subwindow_count,
        result->window_failed_subwindow_count,
        result->window_empty_subwindow_count,
        result->window_complete ? "true" : "false",
        result->window_failed_subwindow ? "true" : "false",
        result->window_cancelled ? "true" : "false",
        result->stop_reason[0] != '\0' ? result->stop_reason : "unknown",
        persistence.persistence_verified ? "true" : "false",
        persistence.persistence_verified ? "true" : "false",
        persistence.operator_context_reused ? "true" : "false",
        persistence.solver_context_reused ? "true" : "false",
        persistence.public_petsc_object_ids_reused ? "true" : "false",
        persistence.persistence_verified ? "true" : "false",
        static_cast<unsigned long long>(persistence.operator_context_generation),
        static_cast<unsigned long long>(persistence.solver_context_generation),
        static_cast<unsigned long long>(persistence.solve_control_generation),
        persistence.reuse_mask,
        persistence.invalidation_reason,
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
    const auto present = [](const char *value) noexcept {
        return value != nullptr && value[0] != '\0';
    };
    const bool canonical_identity_complete =
        present(problem.mesh_generation_identity) &&
        present(problem.equilibrium_digest) &&
        present(problem.bias_field_sample_signature) &&
        present(problem.boundary_gauge_digest) &&
        present(problem.operator_input_digest);
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
    if (production_scope && !canonical_identity_complete) {
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_canonical_identity_incomplete";
        }
    } else if (!valid_requested_count) {
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
    if ((production_scope && !canonical_identity_complete) ||
        !valid_requested_count || !valid_target || !valid_conventions ||
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
    const GpuPersistenceSnapshot &persistence = latest_persistence_snapshot();
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
    const bool modal_solver_device_resident =
        production_implication && result.device_residency_verified;
    const char *spectral_transform = validation_only
        ? "bounded_full_spectrum_shift"
        : "shift_invert";
    const char *eigensolver = validation_only
        ? "slepc_lapack"
        : "slepc_krylovschur";
    const char *poisson_solver = validation_only
        ? "preonly_cuda_ilu"
        : "cg_hypre_boomeramg";
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
        "\"solver_context_reused\":%s,"
        "\"public_petsc_object_ids_reused\":%s,"
        "\"persistence_verified\":%s,"
        "\"operator_context_generation\":%llu,"
        "\"solver_context_generation\":%llu,"
        "\"solve_control_generation\":%llu,"
        "\"reuse_mask\":\"0x%08x\","
        "\"invalidation_reason\":\"%s\","
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
        "\"poisson_solver\":\"%s\","
        "\"spectral_transform\":\"%s\","
        "\"eigensolver\":\"%s\","
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
        "\"window_subwindow_count\":%u,"
        "\"window_completed_subwindow_count\":%u,"
        "\"window_failed_subwindow_count\":%u,"
        "\"window_empty_subwindow_count\":%u,"
        "\"stop_reason\":\"%s\","
        "\"window_certificate\":%s,"
        "\"executed_subwindows\":%s,"
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
        persistence.persistence_verified ? "true" : "false",
        persistence.persistence_verified ? "true" : "false",
        persistence.operator_context_reused ? "true" : "false",
        persistence.solver_context_reused ? "true" : "false",
        persistence.public_petsc_object_ids_reused ? "true" : "false",
        persistence.persistence_verified ? "true" : "false",
        static_cast<unsigned long long>(persistence.operator_context_generation),
        static_cast<unsigned long long>(persistence.solver_context_generation),
        static_cast<unsigned long long>(persistence.solve_control_generation),
        persistence.reuse_mask,
        persistence.invalidation_reason,
        result.operator_context_signature,
        modal_solver_device_resident ? "true" : "false",
        result.device_residency_verified ? "true" : "false",
        result.device_residency_verified ? "true" : "false",
        matrix_type != nullptr ? matrix_type : "",
        vector_type != nullptr ? vector_type : "",
        basis_type != nullptr ? basis_type : "",
        eigensolver_operator_kind != nullptr ? eigensolver_operator_kind : "",
        poisson_pc_type != nullptr ? poisson_pc_type : "",
        shift_pc_type != nullptr ? shift_pc_type : "",
        poisson_solver,
        spectral_transform,
        eigensolver,
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
        result.window_subwindow_count,
        result.window_completed_subwindow_count,
        result.window_failed_subwindow_count,
        result.window_empty_subwindow_count,
        result.stop_reason[0] != '\0' ? result.stop_reason : "unknown",
        result.window_certificate_json[0] != '\0'
            ? result.window_certificate_json
            : "{}",
        result.executed_subwindows_json[0] != '\0'
            ? result.executed_subwindows_json
            : "[]",
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

FrequencyDomainStatus solve_gpu_frequency_window(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    struct WindowCandidate {
        PoissonAirboxModalEigenResult::AcceptedMode mode{};
        PoissonAirboxModalEigenResult source{};
        std::uint32_t pass_index = 0u;
    };
    struct WindowTotals {
        std::uint64_t converged = 0u;
        std::uint64_t finite = 0u;
        std::uint64_t positive = 0u;
        std::uint64_t residual = 0u;
        std::uint64_t reconstructed = 0u;
        std::uint64_t accepted = 0u;
        std::uint64_t iterations = 0u;
        std::uint64_t setup_h2d = 0u;
        std::uint64_t final_d2h = 0u;
        std::uint64_t hot_loop_allocations = 0u;
        std::uint64_t hot_loop_h2d_bytes = 0u;
        std::uint64_t hot_loop_d2h_bytes = 0u;
        std::uint64_t operator_applies = 0u;
        std::uint64_t poisson_solves = 0u;
        std::uint64_t poisson_iterations = 0u;
        std::uint64_t shift_iterations = 0u;
        std::uint32_t eps_monitor_iterations = 0u;
        std::int32_t eps_reason = 0;
        bool eps_reason_available = false;
        bool eps_cancellation_observed = false;
        bool device_residency_observed = false;
        bool device_residency_verified = true;
        bool persistent_context_verified = false;
        bool operator_context_reused = false;
        bool hypre_policy_observed = false;
        bool hypre_policy_configured = true;
        bool hypre_memory_location_device = true;
        bool hypre_execution_policy_device = true;
        bool hypre_vendor_sptrans_enabled = true;
        bool hypre_vendor_spmv_enabled = true;
        bool hypre_vendor_spgemm_enabled = true;
        int hypre_first_error_code = 0;
        std::string hypre_failure_reason{};
    } totals{};
    constexpr std::uint32_t base_subwindow_count = 16u;
    constexpr std::uint32_t refinement_partition_count = 32u;
    constexpr std::uint32_t refinement_subwindow_count =
        refinement_partition_count + 2u;
    constexpr std::uint32_t pass_count = 2u;
    constexpr double cluster_frequency_relative_tolerance = 1.0e-8;
    constexpr double cluster_frequency_absolute_tolerance_hz = 1.0;
    constexpr double subspace_overlap_threshold = 1.0 - 1.0e-6;
    const std::uint64_t split_dimension = 2u * problem.q_dof_count;
    const std::uint64_t maximum_nev = split_dimension >= 4u
        ? split_dimension - 2u
        : 0u;
    const auto resolved_nev = [maximum_nev](std::uint32_t requested_count) {
        return std::min<std::uint64_t>(
            maximum_nev,
            4u * static_cast<std::uint64_t>(requested_count));
    };
    if (problem.requested_mode_count >
            std::numeric_limits<std::uint32_t>::max() / 4u ||
        maximum_nev == 0u) {
        copy_message(
            out_result->stop_reason,
            sizeof(out_result->stop_reason),
            "gpu_k0_requested_mode_count_invalid");
        return fail(
            out_result,
            FrequencyDomainStatus::validation_error,
            "GPU K0 frequency window cannot form a guarded nev",
            out_result->stop_reason);
    }
    const std::uint32_t refined_requested_mode_count =
        2u * problem.requested_mode_count;
    const std::uint64_t requested_nev = resolved_nev(problem.requested_mode_count);
    const std::uint64_t refined_nev = resolved_nev(refined_requested_mode_count);
    const bool refined_nev_increased = refined_nev > requested_nev;
    std::array<std::uint32_t, pass_count> pass_planned_subwindow_count{
        base_subwindow_count,
        refinement_subwindow_count};
    std::array<std::uint32_t, pass_count> pass_completed_subwindow_count{};
    std::array<std::uint32_t, pass_count> pass_failed_subwindow_count{};
    std::array<bool, pass_count> pass_cancelled{};
    std::vector<WindowCandidate> candidates;
    candidates.reserve(
        static_cast<std::size_t>(problem.requested_mode_count) * 4u);
    bool window_interrupted = false;
    bool window_failed = false;
    std::uint32_t empty_subwindow_count = 0u;
    char executed_subwindows[sizeof(out_result->executed_subwindows_json)]{};
    std::size_t executed_subwindows_size = 1u;
    executed_subwindows[0] = '[';
    bool schedule_complete = true;
    auto append_schedule = [&](const char *format, auto... values) {
        if (!schedule_complete ||
            executed_subwindows_size >= sizeof(executed_subwindows)) {
            schedule_complete = false;
            return;
        }
        const int written = std::snprintf(
            executed_subwindows + executed_subwindows_size,
            sizeof(executed_subwindows) - executed_subwindows_size,
            format,
            values...);
        if (written < 0 ||
            static_cast<std::size_t>(written) >=
                sizeof(executed_subwindows) - executed_subwindows_size) {
            schedule_complete = false;
            return;
        }
        executed_subwindows_size += static_cast<std::size_t>(written);
    };
    const auto accumulate = [&](const PoissonAirboxModalEigenResult &result) {
        totals.converged += result.converged_eigenpair_count;
        totals.finite += result.finite_real_eigenpair_count;
        totals.positive += result.positive_frequency_eigenpair_count;
        totals.residual += result.action_residual_evaluated_count;
        totals.reconstructed += result.reconstructed_mode_count;
        totals.accepted += result.full_residual_accepted_count;
        totals.iterations += result.outer_iterations;
        totals.setup_h2d += result.setup_h2d_transfer_count;
        totals.final_d2h += result.final_d2h_transfer_count;
        totals.hot_loop_allocations += result.hot_loop_allocations;
        totals.hot_loop_h2d_bytes += result.hot_loop_h2d_bytes;
        totals.hot_loop_d2h_bytes += result.hot_loop_d2h_bytes;
        totals.operator_applies += result.operator_apply_count;
        totals.poisson_solves += result.poisson_solve_count;
        totals.poisson_iterations += result.poisson_iteration_count;
        totals.shift_iterations += result.shift_linear_iteration_count;
        totals.eps_monitor_iterations = std::max(
            totals.eps_monitor_iterations,
            result.eps_monitor_iteration_count);
        totals.eps_reason = result.eps_converged_reason;
        totals.eps_reason_available =
            totals.eps_reason_available || result.eps_reason_available;
        totals.eps_cancellation_observed =
            totals.eps_cancellation_observed || result.eps_cancellation_observed;
        totals.persistent_context_verified =
            totals.persistent_context_verified || result.persistent_context_verified;
        totals.operator_context_reused =
            totals.operator_context_reused || result.operator_context_reused;
        if (result.hypre_device_policy_observed) {
            totals.hypre_policy_observed = true;
            totals.hypre_policy_configured =
                totals.hypre_policy_configured && result.hypre_device_policy_configured;
            totals.hypre_memory_location_device =
                totals.hypre_memory_location_device && result.hypre_memory_location_device;
            totals.hypre_execution_policy_device =
                totals.hypre_execution_policy_device && result.hypre_execution_policy_device;
            totals.hypre_vendor_sptrans_enabled =
                totals.hypre_vendor_sptrans_enabled && result.hypre_vendor_sptrans_enabled;
            totals.hypre_vendor_spmv_enabled =
                totals.hypre_vendor_spmv_enabled && result.hypre_vendor_spmv_enabled;
            totals.hypre_vendor_spgemm_enabled =
                totals.hypre_vendor_spgemm_enabled && result.hypre_vendor_spgemm_enabled;
            if (totals.hypre_first_error_code == 0 && result.hypre_first_error_code != 0) {
                totals.hypre_first_error_code = result.hypre_first_error_code;
                totals.hypre_failure_reason = result.hypre_failure_reason;
            }
        }
    };
    const auto q_duplicate = [&](const WindowCandidate &existing,
                                 const PoissonAirboxModalEigenResult::AcceptedMode &mode,
                                 std::uint32_t pass_index) {
        if (existing.pass_index != pass_index ||
            existing.mode.full_vector.size() <
                static_cast<std::size_t>(problem.q_dof_count) ||
            mode.full_vector.size() <
                static_cast<std::size_t>(problem.q_dof_count)) {
            return false;
        }
        const double frequency_scale = std::max(
            std::abs(existing.mode.frequency_hz),
            std::abs(mode.frequency_hz));
        const double frequency_tolerance_hz = std::max(
            cluster_frequency_absolute_tolerance_hz,
            cluster_frequency_relative_tolerance * frequency_scale);
        if (std::abs(existing.mode.frequency_hz - mode.frequency_hz) >
            frequency_tolerance_hz) {
            return false;
        }
        Complex overlap = 0.0;
        double existing_norm = 0.0;
        double candidate_norm = 0.0;
        for (std::size_t component = 0;
             component < static_cast<std::size_t>(problem.q_dof_count);
             ++component) {
            overlap += std::conj(existing.mode.full_vector[component]) *
                mode.full_vector[component];
            existing_norm += std::norm(existing.mode.full_vector[component]);
            candidate_norm += std::norm(mode.full_vector[component]);
        }
        return std::abs(overlap) /
            (std::sqrt(existing_norm * candidate_norm) + 1.0e-300) >=
            1.0 - 1.0e-6;
    };
    const double window_width =
        problem.frequency_max_hz - problem.frequency_min_hz;
    const double refinement_spacing =
        window_width / static_cast<double>(refinement_partition_count);
    const double refinement_first_shift_hz =
        problem.frequency_min_hz - 0.5 * refinement_spacing;
    const double refinement_last_shift_hz =
        problem.frequency_max_hz + 0.5 * refinement_spacing;
    const double lower_coverage_margin_hz =
        problem.frequency_min_hz - refinement_first_shift_hz;
    const double upper_coverage_margin_hz =
        refinement_last_shift_hz - problem.frequency_max_hz;
    for (std::uint32_t pass_index = 0u;
         pass_index < pass_count && !window_interrupted;
         ++pass_index) {
        if (poisson_airbox_modal_cancel_requested(problem)) {
            window_interrupted = true;
            pass_cancelled[pass_index] = true;
            break;
        }
        for (std::uint32_t subwindow_index = 0u;
             subwindow_index < pass_planned_subwindow_count[pass_index];
             ++subwindow_index) {
            poisson_airbox_modal_emit_progress(
                problem,
                pass_index == 0u
                    ? "frequency_window_base_subwindow"
                    : "frequency_window_refinement_subwindow",
                "production_gpu",
                subwindow_index,
                0u,
                0u,
                0u,
                0.0);
            if (poisson_airbox_modal_cancel_requested(problem)) {
                window_interrupted = true;
                pass_cancelled[pass_index] = true;
                break;
            }
            PoissonAirboxEigenBlockProblem shifted = problem;
            shifted.target_kind = "nearest_frequency";
            shifted.target_frequency_hz = pass_index == 0u
                ? problem.frequency_min_hz +
                    (static_cast<double>(subwindow_index) + 0.5) *
                        window_width /
                        static_cast<double>(base_subwindow_count)
                : problem.frequency_min_hz +
                    (static_cast<double>(subwindow_index) - 0.5) *
                        refinement_spacing;
            shifted.frequency_min_hz = 0.0;
            shifted.frequency_max_hz = 0.0;
            shifted.requested_mode_count = pass_index == 0u
                ? problem.requested_mode_count
                : refined_requested_mode_count;
            PoissonAirboxModalEigenResult shifted_result{};
            const FrequencyDomainStatus shifted_status =
                solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
                    shifted,
                    &shifted_result);
            accumulate(shifted_result);
            std::vector<const PoissonAirboxModalEigenResult::AcceptedMode *>
                in_window_modes;
            in_window_modes.reserve(shifted_result.accepted_modes.size());
            for (const auto &mode : shifted_result.accepted_modes) {
                if (mode.frequency_hz >= problem.frequency_min_hz &&
                    mode.frequency_hz <= problem.frequency_max_hz) {
                    in_window_modes.push_back(&mode);
                }
            }
            append_schedule(
                "%s{\"pass\":\"%s\",\"subwindow_index\":%u,"
                "\"shift_frequency_hz\":%.17g,\"requested_nev\":%llu,"
                "\"status\":\"%s\",\"converged_eigenpair_count\":%u,"
                "\"candidate_mode_count\":%u,"
                "\"candidate_mode_count_kind\":\"raw_ritz_in_window\","
                "\"raw_ritz_in_window_count\":%u,"
                "\"action_residual_evaluated_count\":%u,"
                "\"reconstructed_mode_count\":%u,"
                "\"full_residual_accepted_count\":%u,"
                "\"accepted_mode_count\":%zu,"
                "\"stop_reason\":\"%s\",\"accepted_frequencies_hz\":[",
                pass_index == 0u && subwindow_index == 0u ? "" : ",",
                pass_index == 0u ? "base" : "refinement",
                subwindow_index,
                shifted.target_frequency_hz,
                static_cast<unsigned long long>(
                    pass_index == 0u ? requested_nev : refined_nev),
                shifted_status == FrequencyDomainStatus::ok ? "ok" : "failed",
                shifted_result.converged_eigenpair_count,
                shifted_result.raw_ritz_in_window_count,
                shifted_result.raw_ritz_in_window_count,
                shifted_result.action_residual_evaluated_count,
                shifted_result.reconstructed_mode_count,
                shifted_result.full_residual_accepted_count,
                in_window_modes.size(),
                shifted_result.stop_reason[0] != '\0'
                    ? shifted_result.stop_reason
                    : (shifted_status == FrequencyDomainStatus::ok
                           ? "converged"
                           : "subwindow_failed"));
            for (std::size_t mode_index = 0u;
                 mode_index < in_window_modes.size();
                 ++mode_index) {
                append_schedule(
                    "%s%.17g",
                    mode_index == 0u ? "" : ",",
                    in_window_modes[mode_index]->frequency_hz);
            }
            append_schedule("%s", "]}");
            if (shifted_status != FrequencyDomainStatus::ok) {
                if (shifted_status == FrequencyDomainStatus::interrupted) {
                    window_interrupted = true;
                    pass_cancelled[pass_index] = true;
                    totals.eps_cancellation_observed = true;
                    break;
                }
                window_failed = true;
                ++pass_failed_subwindow_count[pass_index];
                continue;
            }
            ++pass_completed_subwindow_count[pass_index];
            totals.device_residency_observed = true;
            totals.device_residency_verified =
                totals.device_residency_verified &&
                shifted_result.device_residency_verified;
            if (in_window_modes.empty()) {
                ++empty_subwindow_count;
            }
            for (const auto &mode : shifted_result.accepted_modes) {
                if (mode.frequency_hz < problem.frequency_min_hz ||
                    mode.frequency_hz > problem.frequency_max_hz) {
                    continue;
                }
                const bool duplicate = std::any_of(
                    candidates.begin(),
                    candidates.end(),
                    [&](const WindowCandidate &existing) {
                        return q_duplicate(existing, mode, pass_index);
                    });
                if (!duplicate) {
                    candidates.push_back(WindowCandidate{
                        mode,
                        shifted_result,
                        pass_index});
                }
            }
            if (poisson_airbox_modal_cancel_requested(problem)) {
                window_interrupted = true;
                pass_cancelled[pass_index] = true;
                break;
            }
        }
        if (pass_index == 0u &&
            pass_completed_subwindow_count[0] == base_subwindow_count &&
            pass_failed_subwindow_count[0] == 0u) {
            poisson_airbox_modal_emit_progress(
                problem,
                "frequency_window_base_complete",
                "production_gpu",
                base_subwindow_count,
                static_cast<std::uint32_t>(candidates.size()),
                0u,
                0u,
                0.0);
            if (poisson_airbox_modal_cancel_requested(problem)) {
                window_interrupted = true;
                pass_cancelled[1] = true;
            }
        }
    }
    append_schedule("%s", "]");
    if (!schedule_complete) {
        window_failed = true;
        std::snprintf(
            executed_subwindows,
            sizeof(executed_subwindows),
            "[{\"status\":\"diagnostics_truncated\"}]");
    }
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const WindowCandidate &left, const WindowCandidate &right) {
            if (left.pass_index != right.pass_index) {
                return left.pass_index < right.pass_index;
            }
            return left.mode.frequency_hz < right.mode.frequency_hz;
        });

    struct WindowCluster {
        double frequency_sum_hz = 0.0;
        std::size_t frequency_sample_count = 0u;
        std::vector<std::size_t> independent_candidate_indices{};
        std::vector<std::vector<Complex>> orthonormal_basis{};

        double frequency_hz() const noexcept
        {
            return frequency_sample_count > 0u
                ? frequency_sum_hz /
                    static_cast<double>(frequency_sample_count)
                : 0.0;
        }
    };
    const auto frequencies_match = [&](double left_hz, double right_hz) {
        const double tolerance_hz = std::max(
            cluster_frequency_absolute_tolerance_hz,
            cluster_frequency_relative_tolerance *
                std::max(std::abs(left_hz), std::abs(right_hz)));
        return std::abs(left_hz - right_hz) <= tolerance_hz;
    };
    const auto build_clusters = [&](std::uint32_t pass_index) {
        std::vector<WindowCluster> clusters;
        for (std::size_t candidate_index = 0u;
             candidate_index < candidates.size();
             ++candidate_index) {
            const WindowCandidate &candidate = candidates[candidate_index];
            if (candidate.pass_index != pass_index ||
                candidate.mode.full_vector.size() <
                    static_cast<std::size_t>(problem.q_dof_count)) {
                continue;
            }
            if (clusters.empty() ||
                !frequencies_match(
                    clusters.back().frequency_hz(),
                    candidate.mode.frequency_hz)) {
                clusters.emplace_back();
            }
            WindowCluster &cluster = clusters.back();
            cluster.frequency_sum_hz += candidate.mode.frequency_hz;
            ++cluster.frequency_sample_count;
            std::vector<Complex> vector(
                candidate.mode.full_vector.begin(),
                candidate.mode.full_vector.begin() +
                    static_cast<std::ptrdiff_t>(problem.q_dof_count));
            for (int orthogonalization_pass = 0;
                 orthogonalization_pass < 2;
                 ++orthogonalization_pass) {
                for (const auto &basis_vector : cluster.orthonormal_basis) {
                    Complex projection = 0.0;
                    for (std::size_t component = 0u;
                         component < vector.size();
                         ++component) {
                        projection += std::conj(basis_vector[component]) *
                            vector[component];
                    }
                    for (std::size_t component = 0u;
                         component < vector.size();
                         ++component) {
                        vector[component] -=
                            projection * basis_vector[component];
                    }
                }
            }
            double norm_squared = 0.0;
            for (const Complex value : vector) {
                norm_squared += std::norm(value);
            }
            const double norm = std::sqrt(norm_squared);
            if (!(norm > 1.0e-8) || !std::isfinite(norm)) {
                continue;
            }
            for (Complex &value : vector) {
                value /= norm;
            }
            cluster.orthonormal_basis.push_back(std::move(vector));
            cluster.independent_candidate_indices.push_back(candidate_index);
        }
        return clusters;
    };
    const std::vector<WindowCluster> base_clusters = build_clusters(0u);
    const std::vector<WindowCluster> refinement_clusters = build_clusters(1u);
    struct ClusterSelection {
        std::vector<std::size_t> cluster_indices{};
        std::size_t covered_mode_count = 0u;
        std::size_t split_cluster_index =
            std::numeric_limits<std::size_t>::max();
        bool complete = false;
        bool splits_cluster = false;
    };
    const std::size_t requested_mode_count = static_cast<std::size_t>(
        problem.requested_mode_count);
    const auto select_clusters = [requested_mode_count](
        const std::vector<WindowCluster> &clusters) {
        ClusterSelection selection{};
        for (std::size_t cluster_index = 0u;
             cluster_index < clusters.size();
             ++cluster_index) {
            const std::size_t rank =
                clusters[cluster_index].orthonormal_basis.size();
            if (rank == 0u) {
                continue;
            }
            if (selection.covered_mode_count + rank > requested_mode_count) {
                selection.splits_cluster = true;
                selection.split_cluster_index = cluster_index;
                break;
            }
            selection.cluster_indices.push_back(cluster_index);
            selection.covered_mode_count += rank;
            if (selection.covered_mode_count == requested_mode_count) {
                selection.complete = true;
                break;
            }
        }
        return selection;
    };
    const ClusterSelection base_selection = select_clusters(base_clusters);
    const ClusterSelection refinement_selection =
        select_clusters(refinement_clusters);
    const bool base_pass_complete =
        pass_completed_subwindow_count[0] == pass_planned_subwindow_count[0] &&
        pass_failed_subwindow_count[0] == 0u &&
        !pass_cancelled[0];
    const bool refinement_pass_complete =
        pass_completed_subwindow_count[1] == pass_planned_subwindow_count[1] &&
        pass_failed_subwindow_count[1] == 0u &&
        !pass_cancelled[1];
    const bool coverage_margins_positive =
        std::isfinite(lower_coverage_margin_hz) &&
        std::isfinite(upper_coverage_margin_hz) &&
        lower_coverage_margin_hz > 0.0 &&
        upper_coverage_margin_hz > 0.0;
    bool refinement_disagreement = false;
    const char *perturbation_result = "stable";
    double min_subspace_overlap = 1.0;
    if (!refined_nev_increased) {
        refinement_disagreement = true;
        perturbation_result = "refined_nev_not_greater";
    } else if (base_selection.splits_cluster ||
               refinement_selection.splits_cluster) {
        refinement_disagreement = true;
        perturbation_result = "requested_count_splits_cluster";
        min_subspace_overlap = 0.0;
    } else if (base_selection.complete && refinement_selection.complete) {
        if (base_selection.cluster_indices.size() !=
            refinement_selection.cluster_indices.size()) {
            refinement_disagreement = true;
            perturbation_result = "cluster_count_mismatch";
        } else {
            for (std::size_t selected_cluster = 0u;
                 selected_cluster < base_selection.cluster_indices.size();
                 ++selected_cluster) {
                const WindowCluster &base_cluster = base_clusters[
                    base_selection.cluster_indices[selected_cluster]];
                const WindowCluster &refinement_cluster = refinement_clusters[
                    refinement_selection.cluster_indices[selected_cluster]];
                const std::size_t base_rank =
                    base_cluster.orthonormal_basis.size();
                const std::size_t refinement_rank =
                    refinement_cluster.orthonormal_basis.size();
                if (!frequencies_match(
                        base_cluster.frequency_hz(),
                        refinement_cluster.frequency_hz())) {
                    refinement_disagreement = true;
                    perturbation_result = "cluster_frequency_mismatch";
                    break;
                }
                if (base_rank == 0u || base_rank != refinement_rank) {
                    refinement_disagreement = true;
                    perturbation_result = "cluster_rank_mismatch";
                    break;
                }
                double squared_overlap_sum = 0.0;
                for (const auto &base_vector : base_cluster.orthonormal_basis) {
                    for (const auto &refinement_vector :
                         refinement_cluster.orthonormal_basis) {
                        Complex overlap = 0.0;
                        for (std::size_t component = 0u;
                             component < base_vector.size();
                             ++component) {
                            overlap += std::conj(base_vector[component]) *
                                refinement_vector[component];
                        }
                        squared_overlap_sum += std::norm(overlap);
                    }
                }
                const double subspace_overlap = std::sqrt(std::max(
                    0.0,
                    squared_overlap_sum /
                        static_cast<double>(base_rank)));
                min_subspace_overlap = std::min(
                    min_subspace_overlap,
                    std::min(1.0, subspace_overlap));
                if (!std::isfinite(subspace_overlap) ||
                    subspace_overlap < subspace_overlap_threshold) {
                    refinement_disagreement = true;
                    perturbation_result = "invariant_subspace_mismatch";
                    break;
                }
            }
        }
    } else {
        min_subspace_overlap = 0.0;
        if (base_selection.complete != refinement_selection.complete ||
            base_selection.covered_mode_count !=
                refinement_selection.covered_mode_count) {
            refinement_disagreement = true;
            perturbation_result = "cluster_coverage_mismatch";
        } else {
            perturbation_result = "insufficient_requested_mode_coverage";
        }
    }
    if (!coverage_margins_positive && !refinement_disagreement) {
        refinement_disagreement = true;
        perturbation_result = "nonpositive_coverage_margin";
    }
    if (window_interrupted) {
        perturbation_result = "cancelled";
        min_subspace_overlap = 0.0;
    } else if (window_failed || !base_pass_complete ||
               !refinement_pass_complete) {
        perturbation_result = "pass_incomplete";
        min_subspace_overlap = 0.0;
    }

    std::vector<WindowCandidate> selected_base_candidates;
    for (const std::size_t cluster_index : base_selection.cluster_indices) {
        for (const std::size_t candidate_index :
             base_clusters[cluster_index].independent_candidate_indices) {
            selected_base_candidates.push_back(candidates[candidate_index]);
        }
    }
    if (!base_selection.complete || base_selection.splits_cluster) {
        selected_base_candidates.clear();
    }
    char cluster_frequencies_json[2048] = "[]";
    char cluster_ranks_json[1024] = "[]";
    bool cluster_json_complete = true;
    const std::vector<WindowCluster> *reported_clusters = &base_clusters;
    const std::vector<std::size_t> *reported_cluster_indices =
        &base_selection.cluster_indices;
    std::vector<std::size_t> split_cluster_indices;
    if (base_selection.splits_cluster &&
        base_selection.split_cluster_index < base_clusters.size()) {
        split_cluster_indices.push_back(base_selection.split_cluster_index);
        reported_cluster_indices = &split_cluster_indices;
    } else if (refinement_selection.splits_cluster &&
               refinement_selection.split_cluster_index < refinement_clusters.size()) {
        split_cluster_indices.push_back(refinement_selection.split_cluster_index);
        reported_clusters = &refinement_clusters;
        reported_cluster_indices = &split_cluster_indices;
    }
    std::size_t frequencies_size = 1u;
    std::size_t ranks_size = 1u;
    cluster_frequencies_json[0] = '[';
    cluster_ranks_json[0] = '[';
    for (std::size_t index = 0u;
         index < reported_cluster_indices->size();
         ++index) {
        const WindowCluster &cluster =
            (*reported_clusters)[(*reported_cluster_indices)[index]];
        const int frequency_written = std::snprintf(
            cluster_frequencies_json + frequencies_size,
            sizeof(cluster_frequencies_json) - frequencies_size,
            "%s%.17g",
            index == 0u ? "" : ",",
            cluster.frequency_hz());
        const int rank_written = std::snprintf(
            cluster_ranks_json + ranks_size,
            sizeof(cluster_ranks_json) - ranks_size,
            "%s%zu",
            index == 0u ? "" : ",",
            cluster.orthonormal_basis.size());
        if (frequency_written < 0 || rank_written < 0 ||
            static_cast<std::size_t>(frequency_written) >=
                sizeof(cluster_frequencies_json) - frequencies_size ||
            static_cast<std::size_t>(rank_written) >=
                sizeof(cluster_ranks_json) - ranks_size) {
            cluster_json_complete = false;
            break;
        }
        frequencies_size += static_cast<std::size_t>(frequency_written);
        ranks_size += static_cast<std::size_t>(rank_written);
    }
    if (cluster_json_complete) {
        cluster_json_complete =
            std::snprintf(
                cluster_frequencies_json + frequencies_size,
                sizeof(cluster_frequencies_json) - frequencies_size,
                "]") == 1 &&
            std::snprintf(
                cluster_ranks_json + ranks_size,
                sizeof(cluster_ranks_json) - ranks_size,
                "]") == 1;
    }
    if (!cluster_json_complete) {
        window_failed = true;
        std::snprintf(
            cluster_frequencies_json,
            sizeof(cluster_frequencies_json),
            "[]");
        std::snprintf(
            cluster_ranks_json,
            sizeof(cluster_ranks_json),
            "[]");
    }

    PoissonAirboxModalEigenResult aggregate{};
    if (!selected_base_candidates.empty()) {
        aggregate = selected_base_candidates.front().source;
    } else if (!candidates.empty()) {
        aggregate = candidates.front().source;
    } else {
        aggregate.q_dof_count = problem.q_dof_count;
        aggregate.phi_dof_count = problem.phi_dof_count;
        aggregate.augmented_dof_count =
            problem.q_dof_count + problem.phi_dof_count;
        aggregate.magnetic_pair_count = problem.magnetic_pair_count;
        aggregate.airbox_pair_count = problem.airbox_pair_count;
    }
    aggregate.accepted_modes.clear();
    for (const WindowCandidate &candidate : selected_base_candidates) {
        aggregate.accepted_modes.push_back(candidate.mode);
    }
    aggregate.accepted_mode_count = static_cast<std::uint32_t>(
        aggregate.accepted_modes.size());
    if (!aggregate.accepted_modes.empty()) {
        const auto &selected = aggregate.accepted_modes.front();
        aggregate.selected_eigenpair_index = selected.eigenpair_index;
        aggregate.eigenvalue_real = selected.eigenvalue_real;
        aggregate.eigenvalue_imag = selected.eigenvalue_imag;
        aggregate.omega_rad_s = selected.omega_rad_s;
        aggregate.frequency_hz = selected.frequency_hz;
        aggregate.eigen_residual_relative = selected.relative_residual;
        aggregate.slepc_reported_backward_error =
            selected.slepc_reported_backward_error;
        aggregate.full_residual_reconstruction_relative_error =
            selected.full_residual_reconstruction_relative_error;
        aggregate.reconstructed_full_descriptor_backward_error =
            selected.full_residual_reconstruction_relative_error;
        aggregate.magnetic_block_backward_error =
            selected.magnetic_block_backward_error;
        aggregate.poisson_block_backward_error =
            selected.poisson_block_backward_error;
        aggregate.gauge_constraint_backward_error =
            selected.gauge_constraint_backward_error;
        aggregate.magnetic_residual_l2 = selected.magnetic_residual_l2;
        aggregate.poisson_residual_l2 = selected.poisson_residual_l2;
        aggregate.gauge_residual_abs = selected.gauge_residual_abs;
        aggregate.gauge_mean_abs = selected.gauge_mean_abs;
        aggregate.positive_frequency_branch_found = true;
        aggregate.full_residual_certified = std::all_of(
            aggregate.accepted_modes.begin(),
            aggregate.accepted_modes.end(),
            [&](const auto &mode) {
                return mode.relative_residual <= problem.residual_tolerance;
            });
    } else {
        aggregate.positive_frequency_branch_found = false;
        aggregate.full_residual_certified = false;
    }
    const auto bounded_u32 = [](std::uint64_t value) {
        return static_cast<std::uint32_t>(std::min<std::uint64_t>(
            value,
            std::numeric_limits<std::uint32_t>::max()));
    };
    aggregate.converged_eigenpair_count = bounded_u32(totals.converged);
    aggregate.finite_real_eigenpair_count = bounded_u32(totals.finite);
    aggregate.positive_frequency_eigenpair_count = bounded_u32(totals.positive);
    aggregate.action_residual_evaluated_count = bounded_u32(totals.residual);
    aggregate.reconstructed_mode_count = bounded_u32(totals.reconstructed);
    aggregate.full_residual_accepted_count = bounded_u32(totals.accepted);
    aggregate.outer_iterations = bounded_u32(totals.iterations);
    aggregate.setup_h2d_transfer_count = totals.setup_h2d;
    aggregate.final_d2h_transfer_count = totals.final_d2h;
    aggregate.hot_loop_allocations = totals.hot_loop_allocations;
    aggregate.hot_loop_h2d_bytes = totals.hot_loop_h2d_bytes;
    aggregate.hot_loop_d2h_bytes = totals.hot_loop_d2h_bytes;
    aggregate.operator_apply_count = totals.operator_applies;
    aggregate.poisson_solve_count = totals.poisson_solves;
    aggregate.poisson_iteration_count = totals.poisson_iterations;
    aggregate.shift_linear_iteration_count = totals.shift_iterations;
    aggregate.eps_monitor_iteration_count = totals.eps_monitor_iterations;
    aggregate.eps_converged_reason = totals.eps_reason;
    aggregate.eps_reason_available = totals.eps_reason_available;
    aggregate.eps_cancellation_observed =
        totals.eps_cancellation_observed || window_interrupted;
    aggregate.device_residency_verified =
        totals.device_residency_observed && totals.device_residency_verified;
    aggregate.persistent_context_verified = totals.persistent_context_verified;
    aggregate.operator_context_reused = totals.operator_context_reused;
    aggregate.hypre_device_policy_observed = totals.hypre_policy_observed;
    aggregate.hypre_device_policy_configured =
        totals.hypre_policy_observed && totals.hypre_policy_configured;
    aggregate.hypre_memory_location_device =
        totals.hypre_policy_observed && totals.hypre_memory_location_device;
    aggregate.hypre_execution_policy_device =
        totals.hypre_policy_observed && totals.hypre_execution_policy_device;
    aggregate.hypre_vendor_sptrans_enabled =
        totals.hypre_policy_observed && totals.hypre_vendor_sptrans_enabled;
    aggregate.hypre_vendor_spmv_enabled =
        totals.hypre_policy_observed && totals.hypre_vendor_spmv_enabled;
    aggregate.hypre_vendor_spgemm_enabled =
        totals.hypre_policy_observed && totals.hypre_vendor_spgemm_enabled;
    aggregate.hypre_first_error_code = totals.hypre_first_error_code;
    copy_message(
        aggregate.hypre_failure_reason,
        sizeof(aggregate.hypre_failure_reason),
        totals.hypre_failure_reason.c_str());
    aggregate.window_subwindow_count =
        base_subwindow_count + refinement_subwindow_count;
    aggregate.window_completed_subwindow_count =
        pass_completed_subwindow_count[0] +
        pass_completed_subwindow_count[1];
    aggregate.window_failed_subwindow_count =
        pass_failed_subwindow_count[0] +
        pass_failed_subwindow_count[1];
    aggregate.window_empty_subwindow_count = empty_subwindow_count;
    aggregate.window_failed_subwindow = window_failed;
    aggregate.window_cancelled = window_interrupted;
    const bool mode_coverage_complete =
        base_selection.complete && refinement_selection.complete;
    aggregate.window_complete =
        !window_failed && !window_interrupted &&
        base_pass_complete && refinement_pass_complete &&
        mode_coverage_complete && !refinement_disagreement &&
        coverage_margins_positive && cluster_json_complete &&
        schedule_complete;
    const auto pass_state = [&](std::uint32_t pass_index) {
        if (pass_cancelled[pass_index]) {
            return "cancelled";
        }
        if (pass_failed_subwindow_count[pass_index] > 0u) {
            return "failed";
        }
        if (pass_completed_subwindow_count[pass_index] ==
            pass_planned_subwindow_count[pass_index]) {
            return "completed";
        }
        return pass_completed_subwindow_count[pass_index] == 0u
            ? "not_run"
            : "incomplete";
    };
    const char *window_stop_reason = aggregate.window_complete
        ? "window_complete"
        : (window_interrupted
               ? "cancel_requested"
               : (!schedule_complete || !cluster_json_complete
                      ? "frequency_window_certificate_truncated"
                      : (window_failed || !base_pass_complete ||
                                 !refinement_pass_complete
                             ? "frequency_window_subwindow_failed"
                             : (refinement_disagreement
                                    ? "frequency_window_refinement_disagreement"
                                    : "frequency_window_incomplete_mode_coverage"))));
    copy_message(
        aggregate.stop_reason,
        sizeof(aggregate.stop_reason),
        window_stop_reason);
    copy_message(
        aggregate.eps_stop_reason,
        sizeof(aggregate.eps_stop_reason),
        window_stop_reason);
    copy_message(
        aggregate.executed_subwindows_json,
        sizeof(aggregate.executed_subwindows_json),
        executed_subwindows);
    const char *certificate_status = aggregate.window_complete
        ? "certified"
        : (window_failed ? "failed" : "not_certified");
    const int certificate_written = std::snprintf(
        aggregate.window_certificate_json,
        sizeof(aggregate.window_certificate_json),
        "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
        "\"status\":\"%s\","
        "\"method\":\"shift_nev_refinement_subspace_v1\","
        "\"requested_min_hz\":%.17g,\"requested_max_hz\":%.17g,"
        "\"requested_mode_count\":%u,\"requested_nev\":%llu,"
        "\"refined_requested_mode_count\":%u,\"refined_nev\":%llu,"
        "\"discovered_mode_count\":%zu,\"accepted_mode_count\":%u,"
        "\"base_schedule\":{\"state\":\"%s\","
        "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
        "\"failed_subwindow_count\":%u,\"cancelled\":%s,"
        "\"first_shift_hz\":%.17g,\"last_shift_hz\":%.17g},"
        "\"refinement_schedule\":{\"state\":\"%s\","
        "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
        "\"failed_subwindow_count\":%u,\"cancelled\":%s,"
        "\"first_shift_hz\":%.17g,\"last_shift_hz\":%.17g},"
        "\"accepted_cluster_frequencies_hz\":%s,\"cluster_ranks\":%s,"
        "\"coverage_margins_hz\":{\"lower\":%.17g,\"upper\":%.17g},"
        "\"min_subspace_overlap\":%.17g,"
        "\"subspace_overlap_threshold\":%.17g,"
        "\"perturbation_result\":\"%s\","
        "\"base_schedule_summary_ref\":\"executed_subwindows_json#pass=base\","
        "\"refinement_schedule_summary_ref\":\"executed_subwindows_json#pass=refinement\","
        "\"stop_reason\":\"%s\"}",
        certificate_status,
        problem.frequency_min_hz,
        problem.frequency_max_hz,
        problem.requested_mode_count,
        static_cast<unsigned long long>(requested_nev),
        refined_requested_mode_count,
        static_cast<unsigned long long>(refined_nev),
        candidates.size(),
        aggregate.accepted_mode_count,
        pass_state(0u),
        pass_planned_subwindow_count[0],
        pass_completed_subwindow_count[0],
        pass_failed_subwindow_count[0],
        pass_cancelled[0] ? "true" : "false",
        problem.frequency_min_hz +
            0.5 * window_width / static_cast<double>(base_subwindow_count),
        problem.frequency_max_hz -
            0.5 * window_width / static_cast<double>(base_subwindow_count),
        pass_state(1u),
        pass_planned_subwindow_count[1],
        pass_completed_subwindow_count[1],
        pass_failed_subwindow_count[1],
        pass_cancelled[1] ? "true" : "false",
        refinement_first_shift_hz,
        refinement_last_shift_hz,
        cluster_frequencies_json,
        cluster_ranks_json,
        lower_coverage_margin_hz,
        upper_coverage_margin_hz,
        min_subspace_overlap,
        subspace_overlap_threshold,
        perturbation_result,
        window_stop_reason);
    const bool certificate_complete =
        schedule_complete && cluster_json_complete &&
        certificate_written > 0 &&
        static_cast<std::size_t>(certificate_written) <
            sizeof(aggregate.window_certificate_json);
    if (!certificate_complete) {
        aggregate.window_complete = false;
        aggregate.window_failed_subwindow = true;
        copy_message(
            aggregate.stop_reason,
            sizeof(aggregate.stop_reason),
            "frequency_window_certificate_truncated");
        copy_message(
            aggregate.eps_stop_reason,
            sizeof(aggregate.eps_stop_reason),
            aggregate.stop_reason);
        std::snprintf(
            aggregate.window_certificate_json,
            sizeof(aggregate.window_certificate_json),
            "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
            "\"status\":\"failed\","
            "\"method\":\"shift_nev_refinement_subspace_v1\","
            "\"truncated\":true,"
            "\"perturbation_result\":\"certificate_truncated\","
            "\"stop_reason\":\"frequency_window_certificate_truncated\"}");
    }
    aggregate.status = aggregate.window_complete
        ? FrequencyDomainStatus::ok
        : (window_interrupted
               ? FrequencyDomainStatus::interrupted
               : FrequencyDomainStatus::solve_error);
    copy_message(
        aggregate.error_message,
        sizeof(aggregate.error_message),
        aggregate.window_complete
            ? ""
            : (window_interrupted
                   ? "GPU K0 frequency window was cancelled"
                   : "GPU K0 frequency window was not certified"));
    const bool validation_only = problem.validation_only_adapter;
    write_success_diagnostics(
        problem,
        aggregate,
        "seqaijcusparse",
        "seqcuda",
        "seqcuda",
        validation_only ? "ilu" : "hypre",
        validation_only ? "none" : "hypre",
        validation_only
            ? "materialized_schur_cuda"
            : "matrix_free_schur_cuda",
        &aggregate);
    *out_result = std::move(aggregate);
    return out_result->status;
}

} // namespace

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    latest_persistence_snapshot() = GpuPersistenceSnapshot{};
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
        return solve_gpu_frequency_window(problem, out_result);
    }
    const std::lock_guard<std::mutex> lock(gpu_slepc_mutex());
    if (!ensure_slepc_initialized(out_result->error_message)) {
        return fail(
            out_result,
            FrequencyDomainStatus::unavailable,
            out_result->error_message,
            "slepc_cuda_initialization_failed");
    }
    if (!problem.validation_only_adapter) {
        const HypreDevicePolicySnapshot hypre_policy =
            configure_hypre_cuda_device_policy();
        publish_hypre_device_policy(hypre_policy, out_result);
        if (!hypre_cuda_device_policy_is_available(hypre_policy)) {
            return fail(
                out_result,
                FrequencyDomainStatus::unavailable,
                "GPU K0 HYPRE CUDA device policy is unavailable",
                kHypreCudaDevicePolicyUnavailable);
        }
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
    EPS eps = nullptr;
    KSP st_ksp = nullptr;
    PC st_pc = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    bool materialized_shifted_operator = false;
    auto cleanup = []() noexcept {};
    GpuSolveControlArm solve_control_arm{};

    try {
        bool context_reused = false;
        const char *invalidation_reason = "cold_start";
        persistent = acquire_cached_gpu_context(
            problem, &context_reused, &invalidation_reason);
        if (persistent == nullptr) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::operator_error,
                "GPU K0 PETSc CUDA Schur context setup failed",
                "gpu_schur_context_setup_failed");
        }
        persistent->solve_control.arm(problem);
        solve_control_arm.control = &persistent->solve_control;
        GpuPersistenceSnapshot &persistence = latest_persistence_snapshot();
        persistence.operator_context_generation = persistent->operator_generation;
        persistence.solve_control_generation = persistent->solve_control.generation;
        persistence.operator_context_reused = context_reused;
        persistence.invalidation_reason = invalidation_reason;
        persistence.reuse_mask = context_reused ? kReuseResidualWorkspace : 0u;
        schur = &persistent->schur;
        if (!problem.validation_only_adapter) {
            publish_hypre_device_policy(schur->hypre_device_policy, out_result);
        }
        split = &persistent->split;
        operator_apply_before = schur->operator_apply_count;
        poisson_solve_before = schur->poisson_solve_count;
        poisson_iteration_before = schur->poisson_iteration_count;
        // An identical operator identity reuses all five uploaded CSR blocks.
        // Solver-only rebuilds account separately for a new split-mass upload.
        out_result->setup_h2d_transfer_count = context_reused
            ? 0u
            : schur->setup_h2d_transfer_count;
        const PetscInt base = schur->q_count;
        const PetscInt dimension = 2 * base;
        const double target_omega =
            2.0 * 3.14159265358979323846264338327950288 * problem.target_frequency_hz;
        const double mass_norm = csr_infinity_norm(problem.B_qq);
        const double operator_norm = csr_infinity_norm(problem.A_qq);
        const double angular_frequency_scale = std::max(
            1.0, operator_norm / std::max(mass_norm, 1.0e-300));
        if (!std::isfinite(mass_norm) || mass_norm <= 0.0 ||
            !std::isfinite(operator_norm) ||
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
        const PetscInt nev = requested_gpu_nev(problem, dimension);
        bool solver_reused = persistent->solver.ready;
        const bool target_reconfigured = solver_reused &&
            (persistent->solver.target_omega != target_omega ||
             persistent->solver.target_eigenvalue != target_eigenvalue);
        if (solver_reused &&
            (persistent->solver.dimension != dimension ||
             nev > persistent->solver.nev_capacity ||
             persistent->solver.mass_scale != mass_scale ||
             persistent->solver.angular_frequency_scale != angular_frequency_scale ||
             persistent->solver.operator_scale != operator_scale ||
             target_reconfigured)) {
            destroy_gpu_solver_state(&persistent->solver);
            solver_reused = false;
            if (persistence.invalidation_reason == nullptr ||
                string_equals(persistence.invalidation_reason, "none")) {
                persistence.invalidation_reason = target_reconfigured
                    ? "target_reconfigured"
                    : "solver_capacity_changed";
            }
        }
        const GpuSolverObjectIds previous_successful_object_ids =
            solver_reused
                ? persistent->solver.last_successful_object_ids
                : GpuSolverObjectIds{};
        if (!persistent->solver.ready &&
            !create_gpu_solver_state(
                problem,
                persistent,
                dimension,
                mass_scale,
                angular_frequency_scale,
                operator_scale,
                target_omega,
                target_eigenvalue,
                &out_result->setup_h2d_transfer_count)) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 SLEPc CUDA solver configuration failed",
                "gpu_slepc_configuration_failed");
        }
        if (!configure_gpu_solver_request(problem, persistent)) {
            destroy_gpu_solver_state(&persistent->solver);
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 persistent SLEPc state reconfiguration failed",
                "gpu_slepc_reconfiguration_failed");
        }
        ST configured_st = nullptr;
        KSP configured_st_ksp = nullptr;
        PC configured_st_pc = nullptr;
        BV configured_basis = nullptr;
        if (EPSGetST(persistent->solver.eps, &configured_st) != PETSC_SUCCESS ||
            STGetKSP(configured_st, &configured_st_ksp) != PETSC_SUCCESS ||
            KSPGetPC(configured_st_ksp, &configured_st_pc) != PETSC_SUCCESS ||
            EPSGetBV(persistent->solver.eps, &configured_basis) != PETSC_SUCCESS) {
            destroy_gpu_solver_state(&persistent->solver);
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 persistent SLEPc object graph inspection failed",
                "gpu_slepc_persistence_inspection_failed");
        }
        persistent->solver.st = configured_st;
        persistent->solver.st_ksp = configured_st_ksp;
        persistent->solver.st_pc = configured_st_pc;
        persistent->solver.basis = configured_basis;
        persistence.solver_context_generation = persistent->solver.generation;
        persistence.solver_context_reused = solver_reused;
        persistence.persistence_verified = false;
        out_result->operator_context_reused = persistence.operator_context_reused;
        out_result->persistent_context_verified = false;

        GpuSolverState &solver = persistent->solver;
        shell = solver.shell;
        mass = solver.mass;
        eps = solver.eps;
        st_ksp = solver.st_ksp;
        st_pc = solver.st_pc;
        xr = solver.xr;
        xi = solver.xi;
        materialized_shifted_operator = solver.materialized_eigensolver_operator;
        std::snprintf(
            out_result->shifted_preconditioner_kind,
            sizeof(out_result->shifted_preconditioner_kind),
            "%s",
            materialized_shifted_operator
                ? "materialized_shifted_schur_cuda"
                : "magnetic_shift_preconditioner_cuda");
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
        if (PetscPushErrorHandler(PetscReturnErrorHandler, nullptr) != PETSC_SUCCESS) {
            destroy_gpu_solver_state(&persistent->solver);
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 PETSc error handler installation failed",
                "gpu_slepc_error_handler_failed");
        }
        const PetscErrorCode eps_solve_status =
            std::getenv("FULLMAG_N3_W2_FOCUSED") != nullptr &&
                std::getenv("FULLMAG_N3_W2_TEST_EPSSOLVE_ERROR") != nullptr
            ? PETSC_ERR_USER
            : EPSSolve(eps);
        const bool solve_interrupted = persistent->solve_control.cancellation_observed ||
            poisson_airbox_modal_cancel_requested(problem);
        if (eps_solve_status != PETSC_SUCCESS) {
            persistence.solver_context_reused = false;
            persistence.persistence_verified = false;
            persistence.reuse_mask = 0u;
            persistence.invalidation_reason = "eps_solve_failed";
            out_result->persistent_context_verified = false;
            out_result->eps_reason_available = false;
            out_result->eps_cancellation_observed = solve_interrupted;
            std::snprintf(
                out_result->eps_stop_reason,
                sizeof(out_result->eps_stop_reason),
                "%s",
                solve_interrupted ? "cancel_requested" : "gpu_slepc_solve_failed");
            destroy_gpu_solver_state(&persistent->solver);
            const PetscErrorCode pop_status = PetscPopErrorHandler();
            cleanup();
            return fail(
                out_result,
                solve_interrupted
                    ? FrequencyDomainStatus::interrupted
                    : FrequencyDomainStatus::solve_error,
                pop_status != PETSC_SUCCESS
                    ? "GPU K0 PETSc error handler restoration failed"
                    : solve_interrupted
                        ? "GPU K0 SLEPc CUDA solve was cancelled"
                        : "GPU K0 SLEPc CUDA solve failed",
                pop_status != PETSC_SUCCESS
                    ? "gpu_slepc_error_handler_failed"
                    : solve_interrupted
                        ? "cancel_requested"
                        : "gpu_slepc_solve_failed");
        }
        if (PetscPopErrorHandler() != PETSC_SUCCESS) {
            destroy_gpu_solver_state(&persistent->solver);
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 PETSc error handler restoration failed",
                "gpu_slepc_error_handler_failed");
        }
        const PetscErrorCode iteration_status = EPSGetIterationNumber(eps, &iterations);
        const PetscErrorCode converged_status = EPSGetConverged(eps, &converged);
        const PetscErrorCode reason_status = EPSGetConvergedReason(eps, &eps_reason);
        out_result->eps_reason_available = reason_status == PETSC_SUCCESS;
        out_result->eps_converged_reason = static_cast<std::int32_t>(eps_reason);
        out_result->eps_cancellation_observed = solve_interrupted;
        out_result->eps_monitor_iteration_count =
            persistent->solve_control.monitor_iteration_count;
        std::snprintf(
            out_result->eps_stop_reason,
            sizeof(out_result->eps_stop_reason),
            "%s",
            gpu_eps_reason_name(eps_reason, solve_interrupted));
        if (iteration_status != PETSC_SUCCESS ||
            converged_status != PETSC_SUCCESS ||
            reason_status != PETSC_SUCCESS ||
            (!solve_interrupted && eps_reason <= EPS_CONVERGED_ITERATING)) {
            persistence.persistence_verified = false;
            out_result->persistent_context_verified = false;
            destroy_gpu_solver_state(&persistent->solver);
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
        configured_st = nullptr;
        configured_st_ksp = nullptr;
        configured_st_pc = nullptr;
        configured_basis = nullptr;
        if (EPSGetST(persistent->solver.eps, &configured_st) != PETSC_SUCCESS ||
            STGetKSP(configured_st, &configured_st_ksp) != PETSC_SUCCESS ||
            KSPGetPC(configured_st_ksp, &configured_st_pc) != PETSC_SUCCESS ||
            EPSGetBV(persistent->solver.eps, &configured_basis) != PETSC_SUCCESS) {
            persistence.persistence_verified = false;
            out_result->persistent_context_verified = false;
            destroy_gpu_solver_state(&persistent->solver);
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 post-solve SLEPc object graph inspection failed",
                "gpu_slepc_persistence_inspection_failed");
        }
        persistent->solver.st = configured_st;
        persistent->solver.st_ksp = configured_st_ksp;
        persistent->solver.st_pc = configured_st_pc;
        persistent->solver.basis = configured_basis;
        GpuSolverObjectIds current_object_ids{};
        if (!capture_gpu_solver_object_ids(*persistent, &current_object_ids)) {
            persistence.persistence_verified = false;
            out_result->persistent_context_verified = false;
            destroy_gpu_solver_state(&persistent->solver);
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 PETSc object identity evidence capture failed",
                "gpu_slepc_persistence_evidence_failed");
        }
        persistence.reuse_mask = gpu_solver_object_reuse_mask(
            previous_successful_object_ids, current_object_ids);
        persistence.public_petsc_object_ids_reused =
            persistence.operator_context_reused &&
            persistence.solver_context_reused &&
            same_gpu_solver_object_graph(
                previous_successful_object_ids, current_object_ids);
        // Public PetscObject identities do not prove that PETSc/SLEPc made no
        // internal EPSSolve allocations.  Leave the stronger claim false until
        // hot-loop object creation is measured directly.
        persistence.persistence_verified = false;
        out_result->persistent_context_verified = false;
        persistent->solver.last_successful_object_ids = current_object_ids;
        out_result->outer_iterations = static_cast<std::uint32_t>(std::max<PetscInt>(0, iterations));
        out_result->converged_eigenpair_count =
            static_cast<std::uint32_t>(std::max<PetscInt>(0, converged));
        PetscInt shift_linear_iterations = 0;
        if (st_ksp != nullptr &&
            KSPGetTotalIterations(st_ksp, &shift_linear_iterations) == PETSC_SUCCESS) {
            out_result->shift_linear_iteration_count = static_cast<std::uint64_t>(
                std::max<PetscInt>(0, shift_linear_iterations));
        }

        // Preserve converged Ritz pairs on cancellation without ever rebinding
        // a persistent PETSc callback to request-local storage.
        if (solve_interrupted) {
            persistent->solve_control.cancel_poll_enabled = false;
            persistent->solve_control.progress_enabled = false;
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

        struct DeviceComplexBasisVector {
            Vec real = nullptr;
            Vec imag = nullptr;
            double frequency_hz = 0.0;

            DeviceComplexBasisVector() = default;
            DeviceComplexBasisVector(const DeviceComplexBasisVector &) = delete;
            DeviceComplexBasisVector &operator=(const DeviceComplexBasisVector &) = delete;
            DeviceComplexBasisVector(DeviceComplexBasisVector &&other) noexcept
                : real(other.real), imag(other.imag), frequency_hz(other.frequency_hz)
            {
                other.real = nullptr;
                other.imag = nullptr;
            }
            DeviceComplexBasisVector &operator=(DeviceComplexBasisVector &&other) noexcept
            {
                if (this != &other) {
                    if (real != nullptr) VecDestroy(&real);
                    if (imag != nullptr) VecDestroy(&imag);
                    real = other.real;
                    imag = other.imag;
                    frequency_hz = other.frequency_hz;
                    other.real = nullptr;
                    other.imag = nullptr;
                }
                return *this;
            }
            ~DeviceComplexBasisVector()
            {
                if (real != nullptr) VecDestroy(&real);
                if (imag != nullptr) VecDestroy(&imag);
            }
        };
        std::vector<DeviceComplexBasisVector> selected_basis;
        std::vector<Candidate> independent_candidates;
        selected_basis.reserve(problem.requested_mode_count);
        independent_candidates.reserve(problem.requested_mode_count);
        for (const Candidate &candidate : candidates) {
            PetscScalar candidate_kr = 0.0;
            PetscScalar candidate_ki = 0.0;
            if (EPSGetEigenpair(
                    eps,
                    candidate.index,
                    &candidate_kr,
                    &candidate_ki,
                    xr,
                    xi) != PETSC_SUCCESS ||
                scatter_split_input(split, xr) != PETSC_SUCCESS) {
                cleanup();
                return fail(
                    out_result,
                    FrequencyDomainStatus::solve_error,
                    "GPU K0 physical-mode rank selection failed",
                    "gpu_mode_rank_selection_failed");
            }
            for (const DeviceComplexBasisVector &basis : selected_basis) {
                const double frequency_tolerance_hz = std::max(
                    1.0,
                    1.0e-8 * std::max(
                        std::abs(candidate.frequency),
                        std::abs(basis.frequency_hz)));
                if (std::abs(candidate.frequency - basis.frequency_hz) >
                    frequency_tolerance_hz) {
                    continue;
                }
                PetscScalar real_real = 0.0;
                PetscScalar imag_imag = 0.0;
                PetscScalar real_imag = 0.0;
                PetscScalar imag_real = 0.0;
                if (VecDot(basis.real, split->q_real, &real_real) != PETSC_SUCCESS ||
                    VecDot(basis.imag, split->q_imag, &imag_imag) != PETSC_SUCCESS ||
                    VecDot(basis.real, split->q_imag, &real_imag) != PETSC_SUCCESS ||
                    VecDot(basis.imag, split->q_real, &imag_real) != PETSC_SUCCESS) {
                    cleanup();
                    return fail(
                        out_result,
                        FrequencyDomainStatus::solve_error,
                        "GPU K0 physical-mode overlap evaluation failed",
                        "gpu_mode_rank_selection_failed");
                }
                const PetscScalar projection_real = real_real + imag_imag;
                const PetscScalar projection_imag = real_imag - imag_real;
                if (VecAXPY(split->q_real, -projection_real, basis.real) != PETSC_SUCCESS ||
                    VecAXPY(split->q_real, projection_imag, basis.imag) != PETSC_SUCCESS ||
                    VecAXPY(split->q_imag, -projection_real, basis.imag) != PETSC_SUCCESS ||
                    VecAXPY(split->q_imag, -projection_imag, basis.real) != PETSC_SUCCESS) {
                    cleanup();
                    return fail(
                        out_result,
                        FrequencyDomainStatus::solve_error,
                        "GPU K0 physical-mode orthogonalization failed",
                        "gpu_mode_rank_selection_failed");
                }
            }
            PetscReal q_real_norm = 0.0;
            PetscReal q_imag_norm = 0.0;
            if (VecNorm(split->q_real, NORM_2, &q_real_norm) != PETSC_SUCCESS ||
                VecNorm(split->q_imag, NORM_2, &q_imag_norm) != PETSC_SUCCESS) {
                cleanup();
                return fail(
                    out_result,
                    FrequencyDomainStatus::solve_error,
                    "GPU K0 physical-mode norm evaluation failed",
                    "gpu_mode_rank_selection_failed");
            }
            const double q_norm = std::hypot(
                static_cast<double>(q_real_norm),
                static_cast<double>(q_imag_norm));
            if (!(q_norm > 1.0e-8) || !std::isfinite(q_norm)) {
                continue;
            }
            DeviceComplexBasisVector basis{};
            basis.frequency_hz = candidate.frequency;
            if (VecDuplicate(split->q_real, &basis.real) != PETSC_SUCCESS ||
                VecDuplicate(split->q_imag, &basis.imag) != PETSC_SUCCESS ||
                VecCopy(split->q_real, basis.real) != PETSC_SUCCESS ||
                VecCopy(split->q_imag, basis.imag) != PETSC_SUCCESS ||
                VecScale(basis.real, 1.0 / q_norm) != PETSC_SUCCESS ||
                VecScale(basis.imag, 1.0 / q_norm) != PETSC_SUCCESS) {
                cleanup();
                return fail(
                    out_result,
                    FrequencyDomainStatus::solve_error,
                    "GPU K0 physical-mode basis construction failed",
                    "gpu_mode_rank_selection_failed");
            }
            selected_basis.push_back(std::move(basis));
            independent_candidates.push_back(candidate);
            if (independent_candidates.size() >= problem.requested_mode_count) {
                break;
            }
        }
        candidates = std::move(independent_candidates);
        if (candidates.empty()) {
            cleanup();
            return fail(
                out_result,
                FrequencyDomainStatus::solve_error,
                "GPU K0 found no independent physical mode",
                "gpu_no_independent_physical_mode");
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
        if (EPSGetBV(eps, &basis) == PETSC_SUCCESS) {
            solver.basis = basis;
        }
        if (basis != nullptr &&
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
