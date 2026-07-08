#include "cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.hpp"

#include "cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <vector>

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#endif

namespace fullmag::fem::frequency_domain {

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

void copy_error(CpuSparseDirectSolveResult *result, const char *message) noexcept
{
    if (result == nullptr) {
        return;
    }
    std::strncpy(result->error_message, message, sizeof(result->error_message) - 1);
    result->error_message[sizeof(result->error_message) - 1] = '\0';
}

bool square_count_matches(std::uint64_t n, std::uint64_t count) noexcept
{
    return n <= std::numeric_limits<std::uint64_t>::max() / n && count == n * n;
}

bool finite_values(const double *values, std::uint64_t count) noexcept
{
    if (values == nullptr) {
        return false;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

FrequencyDomainStatus validate_problem(
    const CpuSparseDirectRealSplitProblem &problem,
    CpuSparseDirectSolveResult *result) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    if (n == 0 ||
        !std::isfinite(problem.frequency_hz) ||
        !(problem.frequency_hz > 0.0) ||
        !std::isfinite(problem.angular_frequency_sign) ||
        problem.angular_frequency_sign == 0.0) {
        copy_error(result, "CPU sparse/direct real-split problem requires positive finite dimensions and frequency");
        return FrequencyDomainStatus::validation_error;
    }
    if (!square_count_matches(n, problem.stiffness_value_count) ||
        !square_count_matches(n, problem.mass_value_count) ||
        !finite_values(problem.stiffness_matrix_row_major, problem.stiffness_value_count) ||
        !finite_values(problem.mass_matrix_row_major, problem.mass_value_count)) {
        copy_error(result, "CPU sparse/direct real-split problem requires finite square stiffness and mass matrices");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.drive_real_count != n ||
        problem.drive_imag_count != n ||
        !finite_values(problem.drive_real, problem.drive_real_count) ||
        !finite_values(problem.drive_imag, problem.drive_imag_count)) {
        copy_error(result, "CPU sparse/direct real-split problem requires finite real and imaginary drive vectors");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.out_response_real == nullptr ||
        problem.out_response_imag == nullptr ||
        problem.response_capacity < n) {
        copy_error(result, "CPU sparse/direct real-split problem requires response output buffers");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

void compute_true_residual(
    const CpuSparseDirectRealSplitProblem &problem,
    CpuSparseDirectSolveResult *result) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    const double omega = problem.angular_frequency_sign * kTwoPi * problem.frequency_hz;
    double residual_l2_squared = 0.0;
    double rhs_l2_squared = 0.0;
    for (std::uint64_t row = 0; row < n; ++row) {
        const double drive_real = problem.drive_real[row];
        const double drive_imag = problem.drive_imag[row];
        double residual_real = -drive_real;
        double residual_imag = -drive_imag;
        rhs_l2_squared += drive_real * drive_real + drive_imag * drive_imag;
        for (std::uint64_t column = 0; column < n; ++column) {
            const double stiffness =
                problem.stiffness_matrix_row_major[row * n + column];
            const double omega_mass =
                omega * problem.mass_matrix_row_major[row * n + column];
            const double solution_real = problem.out_response_real[column];
            const double solution_imag = problem.out_response_imag[column];
            residual_real += stiffness * solution_real + omega_mass * solution_imag;
            residual_imag += stiffness * solution_imag - omega_mass * solution_real;
        }
        residual_l2_squared += residual_real * residual_real + residual_imag * residual_imag;
    }
    result->residual_l2_norm = std::sqrt(residual_l2_squared);
    result->relative_residual_l2_norm =
        rhs_l2_squared > 0.0 ?
        result->residual_l2_norm / std::sqrt(rhs_l2_squared) :
        result->residual_l2_norm;
}

#if FULLMAG_FEM_WITH_SLEPC
std::mutex &petsc_sparse_direct_mutex()
{
    static std::mutex mutex;
    return mutex;
}

bool ensure_petsc_initialized(CpuSparseDirectSolveResult *result) noexcept
{
    PetscBool initialized = PETSC_FALSE;
    if (PetscInitialized(&initialized) != 0) {
        copy_error(result, "PETSc initialization query failed");
        return false;
    }
    if (!initialized && PetscInitializeNoArguments() != 0) {
        copy_error(result, "PETSc initialization failed");
        return false;
    }
    return true;
}

void destroy_petsc_objects(Mat *matrix, Vec *rhs, Vec *solution, KSP *ksp) noexcept
{
    if (ksp != nullptr && *ksp != nullptr) {
        KSPDestroy(ksp);
    }
    if (solution != nullptr && *solution != nullptr) {
        VecDestroy(solution);
    }
    if (rhs != nullptr && *rhs != nullptr) {
        VecDestroy(rhs);
    }
    if (matrix != nullptr && *matrix != nullptr) {
        MatDestroy(matrix);
    }
}

bool create_petsc_matrix_from_csr(
    const RealSplitCsrMatrix &csr,
    Mat *matrix) noexcept
{
    if (csr.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        csr.column_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        csr.values.size() > static_cast<std::size_t>(std::numeric_limits<PetscInt>::max())) {
        return false;
    }
    const PetscInt rows = static_cast<PetscInt>(csr.row_count);
    const PetscInt columns = static_cast<PetscInt>(csr.column_count);
    std::vector<PetscInt> row_nonzeros;
    row_nonzeros.reserve(static_cast<std::size_t>(rows));
    for (PetscInt row = 0; row < rows; ++row) {
        const std::uint32_t row_begin = csr.row_offsets[static_cast<std::size_t>(row)];
        const std::uint32_t row_end = csr.row_offsets[static_cast<std::size_t>(row + 1)];
        row_nonzeros.push_back(static_cast<PetscInt>(row_end - row_begin));
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            rows,
            columns,
            0,
            row_nonzeros.data(),
            matrix) != 0) {
        return false;
    }
    for (PetscInt row = 0; row < rows; ++row) {
        const std::uint32_t row_begin = csr.row_offsets[static_cast<std::size_t>(row)];
        const std::uint32_t row_end = csr.row_offsets[static_cast<std::size_t>(row + 1)];
        for (std::uint32_t entry = row_begin; entry < row_end; ++entry) {
            const PetscInt column =
                static_cast<PetscInt>(csr.column_indices[entry]);
            const PetscScalar value =
                static_cast<PetscScalar>(csr.values[entry]);
            if (MatSetValue(*matrix, row, column, value, INSERT_VALUES) != 0) {
                return false;
            }
        }
    }
    return MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) == 0;
}

bool create_petsc_rhs_and_solution(
    const CpuSparseDirectRealSplitProblem &problem,
    Vec *rhs,
    Vec *solution) noexcept
{
    const PetscInt n = static_cast<PetscInt>(problem.tangent_dof_count);
    const PetscInt block_size = static_cast<PetscInt>(2 * problem.tangent_dof_count);
    if (VecCreateSeq(PETSC_COMM_SELF, block_size, rhs) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, block_size, solution) != 0) {
        return false;
    }
    for (PetscInt row = 0; row < n; ++row) {
        const PetscScalar real_value = static_cast<PetscScalar>(problem.drive_real[row]);
        const PetscScalar imag_value = static_cast<PetscScalar>(problem.drive_imag[row]);
        if (VecSetValue(*rhs, row, real_value, INSERT_VALUES) != 0 ||
            VecSetValue(*rhs, row + n, imag_value, INSERT_VALUES) != 0) {
            return false;
        }
    }
    return VecAssemblyBegin(*rhs) == 0 &&
        VecAssemblyEnd(*rhs) == 0 &&
        VecSet(*solution, 0.0) == 0;
}

bool copy_solution_from_petsc(
    Vec solution,
    CpuSparseDirectRealSplitProblem problem) noexcept
{
    const PetscScalar *values = nullptr;
    if (VecGetArrayRead(solution, &values) != 0 || values == nullptr) {
        return false;
    }
    const std::uint64_t n = problem.tangent_dof_count;
    bool ok = true;
    for (std::uint64_t index = 0; index < n; ++index) {
        const double real = static_cast<double>(PetscRealPart(values[index]));
        const double imag = static_cast<double>(PetscRealPart(values[index + n]));
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            ok = false;
            break;
        }
        problem.out_response_real[index] = real;
        problem.out_response_imag[index] = imag;
    }
    VecRestoreArrayRead(solution, &values);
    return ok;
}
#endif

} // namespace

FrequencyDomainStatus solve_cpu_sparse_direct_real_split(
    const CpuSparseDirectRealSplitProblem &problem,
    CpuSparseDirectSolveResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = CpuSparseDirectSolveResult{};
    const FrequencyDomainStatus validation_status = validate_problem(problem, out_result);
    if (validation_status != FrequencyDomainStatus::ok) {
        return validation_status;
    }

    char csr_error[128]{};
    RealSplitCsrMatrix csr{};
    const FrequencyDomainStatus csr_status = assemble_real_split_csr(
        RealSplitCsrOperator{
            problem.tangent_dof_count,
            problem.angular_frequency_sign * kTwoPi * problem.frequency_hz,
            problem.stiffness_matrix_row_major,
            problem.stiffness_value_count,
            problem.mass_matrix_row_major,
            problem.mass_value_count,
        },
        &csr,
        csr_error);
    if (csr_status != FrequencyDomainStatus::ok) {
        copy_error(out_result, csr_error);
        return csr_status;
    }
    out_result->nnz = static_cast<std::uint64_t>(csr.values.size());

#if !FULLMAG_FEM_WITH_SLEPC
    copy_error(
        out_result,
        "PETSc sparse/direct solver is unavailable; build with FULLMAG_FEM_WITH_SLEPC");
    return FrequencyDomainStatus::unavailable;
#else
    std::lock_guard<std::mutex> lock(petsc_sparse_direct_mutex());
    if (!ensure_petsc_initialized(out_result)) {
        return FrequencyDomainStatus::solve_error;
    }

    Mat matrix = nullptr;
    Vec rhs = nullptr;
    Vec solution = nullptr;
    KSP ksp = nullptr;
    PC pc = nullptr;
    if (!create_petsc_matrix_from_csr(csr, &matrix) ||
        !create_petsc_rhs_and_solution(problem, &rhs, &solution) ||
        KSPCreate(PETSC_COMM_SELF, &ksp) != 0 ||
        KSPSetOperators(ksp, matrix, matrix) != 0 ||
        KSPSetType(ksp, KSPPREONLY) != 0 ||
        KSPGetPC(ksp, &pc) != 0 ||
        PCSetType(pc, PCLU) != 0 ||
        KSPSolve(ksp, rhs, solution) != 0) {
        destroy_petsc_objects(&matrix, &rhs, &solution, &ksp);
        copy_error(out_result, "PETSc KSPPREONLY/PCLU sparse direct solve failed");
        return FrequencyDomainStatus::solve_error;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(ksp, &reason) != 0 || reason < 0) {
        destroy_petsc_objects(&matrix, &rhs, &solution, &ksp);
        copy_error(out_result, "PETSc KSPPREONLY/PCLU sparse direct solve did not converge");
        return FrequencyDomainStatus::solve_error;
    }
    if (!copy_solution_from_petsc(solution, problem)) {
        destroy_petsc_objects(&matrix, &rhs, &solution, &ksp);
        copy_error(out_result, "PETSc sparse direct solution contains non-finite values");
        return FrequencyDomainStatus::solve_error;
    }
    destroy_petsc_objects(&matrix, &rhs, &solution, &ksp);
    out_result->solver_package = "petsc";
    out_result->linear_solver = "ksppreonly_pclu";
    compute_true_residual(problem, out_result);
    if (!std::isfinite(out_result->residual_l2_norm) ||
        !std::isfinite(out_result->relative_residual_l2_norm)) {
        copy_error(out_result, "CPU sparse/direct true residual is non-finite");
        return FrequencyDomainStatus::solve_error;
    }
    return FrequencyDomainStatus::ok;
#endif
}

} // namespace fullmag::fem::frequency_domain
