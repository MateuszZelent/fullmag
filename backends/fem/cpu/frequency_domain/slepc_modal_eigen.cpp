#include "cpu/frequency_domain/slepc_modal_eigen.hpp"
#include "frequency_domain/mode_kinematics.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <mutex>

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepceps.h>
#endif

namespace fullmag::fem::frequency_domain {

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace {

struct SLEPcModeCandidate {
    SLEPcModalAcceptedMode mode{};
    double target_distance = 0.0;
};

#if FULLMAG_FEM_WITH_SLEPC
std::mutex &slepc_modal_solver_mutex()
{
    static std::mutex mutex;
    return mutex;
}

void destroy_slepc_modal_objects(
    EPS *eps,
    Vec *xr,
    Vec *xi,
    Mat *stiffness,
    Mat *gyrotropic,
    Mat *rotated_stiffness = nullptr,
    Mat *rotated_gyrotropic = nullptr)
{
    if (xr != nullptr && *xr != nullptr) {
        VecDestroy(xr);
    }
    if (xi != nullptr && *xi != nullptr) {
        VecDestroy(xi);
    }
    if (eps != nullptr && *eps != nullptr) {
        EPSDestroy(eps);
    }
    if (stiffness != nullptr && *stiffness != nullptr) {
        MatDestroy(stiffness);
    }
    if (gyrotropic != nullptr && *gyrotropic != nullptr) {
        MatDestroy(gyrotropic);
    }
    if (rotated_stiffness != nullptr && *rotated_stiffness != nullptr) {
        MatDestroy(rotated_stiffness);
    }
    if (rotated_gyrotropic != nullptr && *rotated_gyrotropic != nullptr) {
        MatDestroy(rotated_gyrotropic);
    }
}

std::vector<std::complex<double>> copy_slepc_eigenvector(Vec xr, Vec xi, int size)
{
    std::vector<std::complex<double>> vector;
    if (xr == nullptr || xi == nullptr || size <= 0) {
        return vector;
    }

    const PetscScalar *real_values = nullptr;
    const PetscScalar *imag_values = nullptr;
    if (VecGetArrayRead(xr, &real_values) != 0 ||
        VecGetArrayRead(xi, &imag_values) != 0) {
        if (real_values != nullptr) {
            VecRestoreArrayRead(xr, &real_values);
        }
        if (imag_values != nullptr) {
            VecRestoreArrayRead(xi, &imag_values);
        }
        return vector;
    }

    vector.reserve(static_cast<std::size_t>(size));
    for (int index = 0; index < size; ++index) {
        const double real = static_cast<double>(PetscRealPart(real_values[index]));
#if defined(PETSC_USE_COMPLEX)
        const double imag = static_cast<double>(PetscImaginaryPart(real_values[index]));
#else
        const double imag = static_cast<double>(PetscRealPart(imag_values[index]));
#endif
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            vector.clear();
            break;
        }
        vector.emplace_back(real, imag);
    }

    VecRestoreArrayRead(xr, &real_values);
    VecRestoreArrayRead(xi, &imag_values);
    return vector;
}

bool set_dense_matrix_entries(
    Mat matrix,
    int size,
    const double *row_major_values)
{
    for (int row = 0; row < size; ++row) {
        for (int col = 0; col < size; ++col) {
            const PetscScalar value =
                static_cast<PetscScalar>(row_major_values[row * size + col]);
            if (MatSetValue(matrix, row, col, value, INSERT_VALUES) != 0) {
                return false;
            }
        }
    }
    return MatAssemblyBegin(matrix, MAT_FINAL_ASSEMBLY) == 0 &&
           MatAssemblyEnd(matrix, MAT_FINAL_ASSEMBLY) == 0;
}

bool create_sequential_dense_matrix(
    int size,
    const double *row_major_values,
    Mat *matrix)
{
    if (MatCreateSeqDense(PETSC_COMM_SELF, size, size, nullptr, matrix) != 0) {
        return false;
    }
    return set_dense_matrix_entries(*matrix, size, row_major_values);
}

bool ensure_slepc_initialized(
    SLEPcTinyGyrotropicModalEigenResult *result)
{
    PetscBool slepc_initialized = PETSC_FALSE;
    if (SlepcInitialized(&slepc_initialized) != 0) {
        result->status = "solve_error";
        result->unsupported_reason = "slepc_initialization_query_failed";
        return false;
    }
    if (!slepc_initialized && SlepcInitializeNoArguments() != 0) {
        result->status = "solve_error";
        result->unsupported_reason = "slepc_initialization_failed";
        return false;
    }
    return true;
}

bool create_sequential_sparse_matrix_from_csr(
    const CsrMatrixView &view,
    Mat *matrix)
{
    if (view.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        view.column_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        view.values_len > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
        return false;
    }
    const PetscInt rows = static_cast<PetscInt>(view.row_count);
    const PetscInt columns = static_cast<PetscInt>(view.column_count);
    std::vector<PetscInt> row_nonzeros;
    row_nonzeros.reserve(static_cast<std::size_t>(rows));
    for (PetscInt row = 0; row < rows; ++row) {
        const std::uint32_t row_begin = view.row_offsets[row];
        const std::uint32_t row_end = view.row_offsets[row + 1];
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
        const std::uint32_t row_begin = view.row_offsets[row];
        const std::uint32_t row_end = view.row_offsets[row + 1];
        for (std::uint32_t entry = row_begin; entry < row_end; ++entry) {
            const PetscInt column =
                static_cast<PetscInt>(view.column_indices[entry]);
            const PetscScalar value =
                static_cast<PetscScalar>(view.values[entry]);
            if (MatSetValue(matrix[0], row, column, value, INSERT_VALUES) != 0) {
                return false;
            }
        }
    }
    return MatAssemblyBegin(matrix[0], MAT_FINAL_ASSEMBLY) == 0 &&
           MatAssemblyEnd(matrix[0], MAT_FINAL_ASSEMBLY) == 0;
}

bool create_real_frequency_rotated_pencil(
    Mat stiffness,
    Mat gyrotropic,
    Mat *rotated_stiffness,
    Mat *rotated_gyrotropic,
    PetscInt *base_size)
{
    if (stiffness == nullptr || gyrotropic == nullptr ||
        rotated_stiffness == nullptr || rotated_gyrotropic == nullptr ||
        base_size == nullptr) {
        return false;
    }
    PetscInt stiffness_rows = 0;
    PetscInt stiffness_columns = 0;
    PetscInt gyrotropic_rows = 0;
    PetscInt gyrotropic_columns = 0;
    if (MatGetSize(stiffness, &stiffness_rows, &stiffness_columns) != 0 ||
        MatGetSize(gyrotropic, &gyrotropic_rows, &gyrotropic_columns) != 0 ||
        stiffness_rows <= 0 || stiffness_rows != stiffness_columns ||
        gyrotropic_rows != stiffness_rows || gyrotropic_columns != stiffness_columns ||
        stiffness_rows > std::numeric_limits<PetscInt>::max() / 2) {
        return false;
    }
    const PetscInt doubled_size = 2 * stiffness_rows;
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF, doubled_size, doubled_size, 0, nullptr,
            rotated_stiffness) != 0 ||
        MatCreateSeqAIJ(
            PETSC_COMM_SELF, doubled_size, doubled_size, 0, nullptr,
            rotated_gyrotropic) != 0) {
        if (*rotated_stiffness != nullptr) {
            MatDestroy(rotated_stiffness);
        }
        if (*rotated_gyrotropic != nullptr) {
            MatDestroy(rotated_gyrotropic);
        }
        return false;
    }
    MatSetOption(*rotated_stiffness, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE);
    MatSetOption(*rotated_gyrotropic, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE);

    auto copy_rows = [&](Mat source, Mat destination, bool rotate_gyrotropic) {
        for (PetscInt row = 0; row < stiffness_rows; ++row) {
            PetscInt entry_count = 0;
            const PetscInt *columns = nullptr;
            const PetscScalar *values = nullptr;
            if (MatGetRow(source, row, &entry_count, &columns, &values) != 0) {
                return false;
            }
            bool valid = true;
            for (PetscInt entry = 0; entry < entry_count; ++entry) {
                const PetscInt column = columns[entry];
                const double value = static_cast<double>(PetscRealPart(values[entry]));
                const double scalar_imaginary =
                    static_cast<double>(PetscImaginaryPart(values[entry]));
                if (column < 0 || column >= stiffness_rows ||
                    !std::isfinite(value) ||
                    !std::isfinite(scalar_imaginary) ||
                    std::abs(scalar_imaginary) >
                        1.0e-14 * std::max(1.0, std::abs(value))) {
                    valid = false;
                    break;
                }
                if (!rotate_gyrotropic) {
                    valid =
                        MatSetValue(destination, row, column,
                                    static_cast<PetscScalar>(value), ADD_VALUES) == 0 &&
                        MatSetValue(destination, row + stiffness_rows,
                                    column + stiffness_rows,
                                    static_cast<PetscScalar>(value), ADD_VALUES) == 0;
                } else {
                    // R(iG) = [[0, -G], [G, 0]] for A x = i*omega*G x.
                    valid =
                        MatSetValue(destination, row, column + stiffness_rows,
                                    static_cast<PetscScalar>(-value), ADD_VALUES) == 0 &&
                        MatSetValue(destination, row + stiffness_rows, column,
                                    static_cast<PetscScalar>(value), ADD_VALUES) == 0;
                }
                if (!valid) {
                    break;
                }
            }
            const PetscErrorCode restore_error =
                MatRestoreRow(source, row, &entry_count, &columns, &values);
            if (restore_error != 0 || !valid) {
                return false;
            }
        }
        return true;
    };

    if (!copy_rows(stiffness, *rotated_stiffness, false) ||
        !copy_rows(gyrotropic, *rotated_gyrotropic, true) ||
        MatAssemblyBegin(*rotated_stiffness, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*rotated_stiffness, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyBegin(*rotated_gyrotropic, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*rotated_gyrotropic, MAT_FINAL_ASSEMBLY) != 0) {
        MatDestroy(rotated_stiffness);
        MatDestroy(rotated_gyrotropic);
        return false;
    }
    // The caller allocates PETSc vectors and reconstructs the complex mode
    // from the full real-split pencil.  Report the dimension of that pencil,
    // not the dimension of one input block; returning `stiffness_rows` here
    // makes every production request fail the subsequent 2x size contract
    // before SLEPc is even configured.
    *base_size = doubled_size;
    return true;
}

double petsc_eigenvalue_real_part(PetscScalar kr)
{
    return static_cast<double>(PetscRealPart(kr));
}

double petsc_eigenvalue_imaginary_part(PetscScalar kr, PetscScalar ki)
{
    const double scalar_imaginary = static_cast<double>(PetscImaginaryPart(kr));
    if (std::abs(scalar_imaginary) > 0.0) {
        return scalar_imaginary;
    }
    return static_cast<double>(PetscRealPart(ki));
}
#endif

int requested_positive_mode_count(const SLEPcTinyGyrotropicModalEigenRequest &request)
{
    return std::max(1, request.requested_mode_count);
}

bool has_frequency_window(const SLEPcTinyGyrotropicModalEigenRequest &request)
{
    return std::isfinite(request.frequency_min_hz) &&
        std::isfinite(request.frequency_max_hz) &&
        request.frequency_max_hz > request.frequency_min_hz &&
        request.frequency_max_hz > 0.0;
}

#if FULLMAG_FEM_WITH_SLEPC
SLEPcTinyGyrotropicModalEigenResult
solve_slepc_gyrotropic_modal_eigen_with_matrices(
    const SLEPcTinyGyrotropicModalEigenRequest &request,
    Mat stiffness,
    Mat gyrotropic) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    Mat rotated_stiffness = nullptr;
    Mat rotated_gyrotropic = nullptr;
    PetscInt rotated_size = 0;
    if (!create_real_frequency_rotated_pencil(
            stiffness,
            gyrotropic,
            &rotated_stiffness,
            &rotated_gyrotropic,
            &rotated_size)) {
        result.status = "solve_error";
        result.unsupported_reason = "real_frequency_rotated_pencil_creation_failed";
        return result;
    }
    const int size = request.tangent_dof_count;
    if (rotated_size != static_cast<PetscInt>(2) * static_cast<PetscInt>(size)) {
        result.status = "solve_error";
        result.unsupported_reason = "real_frequency_rotated_pencil_size_mismatch";
        destroy_slepc_modal_objects(
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            &rotated_stiffness,
            &rotated_gyrotropic);
        return result;
    }

    ST spectral_transform = nullptr;
    const double target_angular_frequency =
        omega_rad_s_from_frequency_hz(std::max(0.0, request.target_frequency_hz));
    const PetscInt max_iterations =
        request.max_outer_iterations > 0 ? request.max_outer_iterations : PETSC_DEFAULT;
    const PetscInt max_linear_iterations =
        request.max_linear_iterations > 0 ? request.max_linear_iterations : PETSC_DEFAULT;
    const PetscReal tolerance =
        request.residual_tolerance > 0.0 ? request.residual_tolerance : 1.0e-10;
    const PetscReal ksp_rtol = std::min(0.01 * tolerance, 1.0e-10);
    const PetscReal ksp_atol = 1.0e-14;
    const PetscInt requested_positive_modes =
        static_cast<PetscInt>(requested_positive_mode_count(request));
    const PetscInt requested_split_modes =
        requested_positive_modes > rotated_size / 2
            ? rotated_size
            : 2 * requested_positive_modes;
    const PetscInt requested_eigenpair_count = std::min<PetscInt>(
        rotated_size,
        std::max<PetscInt>(1, requested_split_modes));
    const double target_shift = request.phase_convention ==
            FrequencyDomainPhaseConvention::exp_minus_i_omega_t
        ? -target_angular_frequency
        : target_angular_frequency;

    // At Gamma the real-split pencil can contain physically harmless
    // near-zero pivots. PETSc's default LU policy treats a pivot at its
    // machine tolerance as fatal and retries every frequency subwindow.
    // The FEM matrices carry powers of metres and can therefore be many
    // orders below one in SI units. Scale both sides of the generalized
    // pencil by one common, norm-derived factor before LU. This preserves
    // every generalized eigenvalue and relative residual while keeping the
    // factorization shift numerically meaningful. SLEPc still evaluates
    // residuals against this equivalently scaled pencil before a mode is
    // accepted; no frequency-specific absolute shift is introduced.
    PetscReal stiffness_norm = 0.0;
    PetscReal gyrotropic_norm = 0.0;
    if (MatNorm(rotated_stiffness, NORM_INFINITY, &stiffness_norm) != 0 ||
        MatNorm(rotated_gyrotropic, NORM_INFINITY, &gyrotropic_norm) != 0 ||
        !std::isfinite(static_cast<double>(stiffness_norm)) ||
        !std::isfinite(static_cast<double>(gyrotropic_norm))) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_norm_failed";
        destroy_slepc_modal_objects(
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            &rotated_stiffness,
            &rotated_gyrotropic);
        return result;
    }
    const PetscReal raw_operator_scale =
        stiffness_norm +
        std::abs(static_cast<PetscReal>(target_shift)) * gyrotropic_norm;
    if (!(raw_operator_scale > 0.0) ||
        !std::isfinite(static_cast<double>(raw_operator_scale))) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_zero_scale";
        destroy_slepc_modal_objects(
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            &rotated_stiffness,
            &rotated_gyrotropic);
        return result;
    }
    const PetscReal operator_normalization_scale = 1.0 / raw_operator_scale;
    if (!std::isfinite(static_cast<double>(operator_normalization_scale)) ||
        operator_normalization_scale <= 0.0 ||
        MatScale(rotated_stiffness, operator_normalization_scale) != 0 ||
        MatScale(rotated_gyrotropic, operator_normalization_scale) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_normalization_failed";
        destroy_slepc_modal_objects(
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            &rotated_stiffness,
            &rotated_gyrotropic);
        return result;
    }
    result.operator_normalization_scale =
        static_cast<double>(operator_normalization_scale);
    constexpr PetscReal kFactorizationShiftRelativeScale = 1.0e-12;
    constexpr PetscReal kFactorizationShiftAbsoluteFloor = 1.0e-14;
    const PetscReal normalized_operator_scale =
        stiffness_norm * operator_normalization_scale +
        std::abs(static_cast<PetscReal>(target_shift)) * gyrotropic_norm *
            operator_normalization_scale;
    const PetscReal factorization_shift = std::max<PetscReal>(
        kFactorizationShiftAbsoluteFloor,
        kFactorizationShiftRelativeScale * normalized_operator_scale);
    result.factorization_shift_amount = static_cast<double>(factorization_shift);

    bool configured =
        EPSCreate(PETSC_COMM_SELF, &eps) == 0 &&
        EPSSetOperators(eps, rotated_stiffness, rotated_gyrotropic) == 0 &&
        EPSSetProblemType(eps, EPS_GNHEP) == 0 &&
        EPSSetType(eps, EPSKRYLOVSCHUR) == 0 &&
        EPSSetDimensions(eps, requested_eigenpair_count, PETSC_DEFAULT, PETSC_DEFAULT) == 0 &&
        EPSGetST(eps, &spectral_transform) == 0 &&
        STSetType(spectral_transform, STSINVERT) == 0 &&
        STSetShift(spectral_transform, static_cast<PetscScalar>(target_shift)) == 0 &&
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) == 0 &&
        EPSSetTarget(eps, static_cast<PetscScalar>(target_shift)) == 0 &&
        EPSSetTolerances(eps, tolerance, max_iterations) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, rotated_size, &xr) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, rotated_size, &xi) == 0;
    KSP ksp = nullptr;
    PC pc = nullptr;
    configured =
        configured &&
        STGetKSP(spectral_transform, &ksp) == 0 &&
        KSPSetType(ksp, KSPPREONLY) == 0 &&
        KSPGetPC(ksp, &pc) == 0 &&
        PCSetType(pc, PCLU) == 0 &&
        PCFactorSetShiftType(pc, MAT_SHIFT_NONZERO) == 0 &&
        PCFactorSetShiftAmount(pc, factorization_shift) == 0 &&
        KSPSetTolerances(
            ksp,
            ksp_rtol,
            ksp_atol,
            PETSC_DEFAULT,
            max_linear_iterations) == 0 &&
        KSPSetErrorIfNotConverged(ksp, PETSC_TRUE) == 0;
    if (!configured) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_configuration_failed";
        destroy_slepc_modal_objects(
            &eps,
            &xr,
            &xi,
            nullptr,
            nullptr,
            &rotated_stiffness,
            &rotated_gyrotropic);
        return result;
    }
    result.ksp_rtol = static_cast<double>(ksp_rtol);
    result.ksp_atol = static_cast<double>(ksp_atol);
    PetscReal resolved_eps_tolerance = 0.0;
    PetscInt resolved_eps_max_iterations = 0;
    if (EPSGetTolerances(eps, &resolved_eps_tolerance, &resolved_eps_max_iterations) == 0) {
        result.max_outer_iterations = static_cast<int>(
            std::max<PetscInt>(0, resolved_eps_max_iterations));
    }
    PetscReal resolved_ksp_rtol = 0.0;
    PetscReal resolved_ksp_atol = 0.0;
    PetscReal resolved_ksp_dtol = 0.0;
    PetscInt resolved_ksp_max_iterations = 0;
    if (KSPGetTolerances(
            ksp,
            &resolved_ksp_rtol,
            &resolved_ksp_atol,
            &resolved_ksp_dtol,
            &resolved_ksp_max_iterations) == 0) {
        result.ksp_rtol = static_cast<double>(resolved_ksp_rtol);
        result.ksp_atol = static_cast<double>(resolved_ksp_atol);
        result.ksp_max_iterations = static_cast<int>(
            std::max<PetscInt>(0, resolved_ksp_max_iterations));
    }

    PetscInt outer_iterations = 0;
    PetscInt linear_iterations = 0;
    PetscReal ksp_final_residual = 0.0;
    PetscInt converged_eigenpair_count = 0;
    if (EPSSolve(eps) != 0 ||
        EPSGetIterationNumber(eps, &outer_iterations) != 0 ||
        EPSGetConverged(eps, &converged_eigenpair_count) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solve_failed";
        destroy_slepc_modal_objects(
            &eps,
            &xr,
            &xi,
            nullptr,
            nullptr,
            &rotated_stiffness,
            &rotated_gyrotropic);
        return result;
    }
    result.outer_iterations = static_cast<int>(outer_iterations);
    result.converged_eigenpair_count = static_cast<int>(converged_eigenpair_count);
    if (KSPGetIterationNumber(ksp, &linear_iterations) == 0) {
        result.linear_iterations_total = static_cast<int>(linear_iterations);
    }
    if (KSPGetResidualNorm(ksp, &ksp_final_residual) == 0 &&
        std::isfinite(static_cast<double>(ksp_final_residual))) {
        result.ksp_final_residual = static_cast<double>(ksp_final_residual);
    }

    std::vector<SLEPcModeCandidate> accepted_candidates;
    accepted_candidates.reserve(static_cast<std::size_t>(requested_positive_mode_count(request)));
    bool saw_positive_frequency = false;
    bool saw_frequency_window_candidate = false;
    bool saw_residual_rejection = false;
    bool saw_non_real_rotated_eigenvalue = false;
    const bool filter_frequency_window = has_frequency_window(request);
    for (int index = 0; index < result.converged_eigenpair_count; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal relative_residual = 0.0;
        if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != 0 ||
            EPSComputeError(eps, index, EPS_ERROR_RELATIVE, &relative_residual) != 0) {
            continue;
        }
        // The rotated pencil has real eigenvalue omega.  Reconstruct the
        // physical gyrotropic eigenvalue as lambda = i*omega before applying
        // the phase-convention mapping; never treat omega as lambda.real.
        const double rotated_omega = petsc_eigenvalue_real_part(kr);
        const double rotated_imaginary = petsc_eigenvalue_imaginary_part(kr, ki);
        if (!std::isfinite(rotated_omega) || !std::isfinite(rotated_imaginary) ||
            std::abs(rotated_imaginary) >
                1.0e-8 * std::max(1.0, std::abs(rotated_omega))) {
            saw_non_real_rotated_eigenvalue = true;
            ++result.non_real_rotated_eigenvalue_count;
            continue;
        }
        const double lambda_real = 0.0;
        const double lambda_imag = rotated_omega;
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda_real, lambda_imag},
            request.phase_convention);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        saw_positive_frequency = true;
        ++result.positive_frequency_candidate_count;
        if (result.positive_frequency_candidate_count == 1) {
            result.min_candidate_frequency_hz = kinematics.frequency_hz;
            result.max_candidate_frequency_hz = kinematics.frequency_hz;
        } else {
            result.min_candidate_frequency_hz = std::min(
                result.min_candidate_frequency_hz,
                kinematics.frequency_hz);
            result.max_candidate_frequency_hz = std::max(
                result.max_candidate_frequency_hz,
                kinematics.frequency_hz);
        }
        if (filter_frequency_window &&
            (kinematics.frequency_hz < request.frequency_min_hz ||
             kinematics.frequency_hz > request.frequency_max_hz)) {
            continue;
        }
        saw_frequency_window_candidate = true;
        ++result.frequency_window_candidate_count;
        result.max_candidate_relative_residual = std::max(
            result.max_candidate_relative_residual,
            static_cast<double>(relative_residual));
        if (static_cast<double>(relative_residual) > static_cast<double>(tolerance)) {
            saw_residual_rejection = true;
            ++result.residual_rejection_count;
            continue;
        }
        SLEPcModeCandidate candidate{};
        candidate.mode.eigenpair_index = index;
        candidate.mode.lambda_real = lambda_real;
        candidate.mode.lambda_imag = lambda_imag;
        candidate.mode.frequency_hz = kinematics.frequency_hz;
        candidate.mode.relative_residual = static_cast<double>(relative_residual);
        const std::vector<std::complex<double>> rotated_mode =
            copy_slepc_eigenvector(xr, xi, static_cast<int>(rotated_size));
        if (rotated_mode.size() != static_cast<std::size_t>(rotated_size)) {
            continue;
        }
        candidate.mode.mode_vector.resize(static_cast<std::size_t>(size));
        for (int component = 0; component < size; ++component) {
            candidate.mode.mode_vector[static_cast<std::size_t>(component)] =
                rotated_mode[static_cast<std::size_t>(component)] +
                std::complex<double>(0.0, 1.0) *
                    rotated_mode[static_cast<std::size_t>(size + component)];
        }
        if (candidate.mode.mode_vector.size() != static_cast<std::size_t>(size)) {
            continue;
        }
        candidate.target_distance =
            std::abs(kinematics.omega_rad_s - target_angular_frequency);
        accepted_candidates.push_back(candidate);
    }

    destroy_slepc_modal_objects(
        &eps,
        &xr,
        &xi,
        nullptr,
        nullptr,
        &rotated_stiffness,
        &rotated_gyrotropic);

    if (accepted_candidates.empty()) {
        result.status = "solve_error";
        if (!saw_positive_frequency) {
            result.unsupported_reason = "no_positive_frequency_eigenpair";
        } else if (filter_frequency_window && !saw_frequency_window_candidate) {
            result.unsupported_reason = "no_positive_frequency_eigenpair_in_window";
        } else if (saw_residual_rejection) {
            result.unsupported_reason = "residual_tolerance_not_met";
        } else if (saw_non_real_rotated_eigenvalue) {
            result.unsupported_reason = "rotated_eigenvalue_not_real";
        } else {
            result.unsupported_reason = "no_accepted_positive_frequency_mode";
        }
        return result;
    }
    std::sort(
        accepted_candidates.begin(),
        accepted_candidates.end(),
        [](const SLEPcModeCandidate &lhs, const SLEPcModeCandidate &rhs) {
            if (lhs.target_distance == rhs.target_distance) {
                return lhs.mode.frequency_hz < rhs.mode.frequency_hz;
            }
            return lhs.target_distance < rhs.target_distance;
        });
    const std::size_t accepted_limit = std::min<std::size_t>(
        accepted_candidates.size(),
        static_cast<std::size_t>(requested_positive_mode_count(request)));
    accepted_candidates.resize(accepted_limit);
    std::sort(
        accepted_candidates.begin(),
        accepted_candidates.end(),
        [](const SLEPcModeCandidate &lhs, const SLEPcModeCandidate &rhs) {
            return lhs.mode.frequency_hz < rhs.mode.frequency_hz;
        });

    result.accepted_modes.reserve(accepted_candidates.size());
    for (std::size_t index = 0; index < accepted_candidates.size(); ++index) {
        SLEPcModalAcceptedMode mode = accepted_candidates[index].mode;
        mode.positive_frequency_pair_index = static_cast<int>(index);
        result.max_relative_residual = std::max(
            result.max_relative_residual,
            mode.relative_residual);
        result.accepted_modes.push_back(mode);
    }
    result.accepted_mode_count = static_cast<int>(result.accepted_modes.size());
    const SLEPcModalAcceptedMode &first_mode = result.accepted_modes.front();
    result.selected_eigenpair_index = first_mode.eigenpair_index;
    result.lambda_real = first_mode.lambda_real;
    result.lambda_imag = first_mode.lambda_imag;
    result.frequency_hz = first_mode.frequency_hz;
    result.relative_residual = first_mode.relative_residual;

    result.ok = true;
    result.status = "ok";
    return result;
}
#endif

} // namespace

SLEPcModalEigenAdapterStatus slepc_modal_eigen_adapter_status() noexcept
{
    SLEPcModalEigenAdapterStatus status{};
    status.slepc_available = FULLMAG_FEM_WITH_SLEPC != 0;
    if (status.slepc_available) {
        status.solver_adapter_status = "shift_invert_real_frequency_rotated_available";
        status.unavailable_message =
            "native FEM modal_eigen production CPU solver requires an MFEM modal operator payload; SLEPc shift-invert adapter is available for the macrospin contract proof";
        status.unsupported_reason = "mfem_modal_operator_payload_missing";
        status.eps_type = "krylovschur";
        status.problem_type = "gnhep";
        status.which_eigenpairs = "target_magnitude";
        status.ksp_type = "preonly";
        status.pc_type = "lu";
        status.factorization_package = "petsc_lu_shift_nonzero";
        status.factorization_shift_policy =
            "positive_relative_operator_norm_amount";
        status.nullspace_policy = "none";
        status.linear_tolerance_policy =
            "ksp_rtol=min(0.01*eigen_residual_tolerance,1e-10);ksp_atol=1e-14";
        status.algebraic_form = "real_frequency_rotated_gyrotropic_generalized";
        status.positive_frequency_filter =
            "select_positive_frequency_mode(map_eigenvalue(lambda, phase_convention), exclude_zero_frequency)";
        status.eigenvalue_to_frequency = "map_eigenvalue(lambda, phase)";
    } else {
        status.solver_adapter_status = "unavailable";
        status.unavailable_message =
            "native FEM modal_eigen production CPU solver requires PETSc/SLEPc, but fullmag_fem was built without SLEPc support";
        status.unsupported_reason = "slepc_not_available";
    }
    return status;
}

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_tiny_gyrotropic_modal_eigen(
    const SLEPcTinyGyrotropicModalEigenRequest &request) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};

    if (request.tangent_dof_count <= 0 ||
        request.stiffness_matrix_row_major == nullptr ||
        request.gyrotropic_matrix_row_major == nullptr) {
        result.status = "validation_error";
        result.unsupported_reason = "invalid_tiny_modal_request";
        return result;
    }

#if !FULLMAG_FEM_WITH_SLEPC
    (void)request;
    result.unsupported_reason = "slepc_not_available";
    return result;
#else
    const std::lock_guard<std::mutex> lock(slepc_modal_solver_mutex());
    if (!ensure_slepc_initialized(&result)) {
        return result;
    }

    Mat stiffness = nullptr;
    Mat gyrotropic = nullptr;
    const int size = request.tangent_dof_count;

    if (!create_sequential_dense_matrix(size, request.stiffness_matrix_row_major, &stiffness) ||
        !create_sequential_dense_matrix(size, request.gyrotropic_matrix_row_major, &gyrotropic)) {
        result.status = "solve_error";
        result.unsupported_reason = "petsc_matrix_creation_failed";
        destroy_slepc_modal_objects(nullptr, nullptr, nullptr, &stiffness, &gyrotropic);
        return result;
    }

    result = solve_slepc_gyrotropic_modal_eigen_with_matrices(
        request,
        stiffness,
        gyrotropic);
    destroy_slepc_modal_objects(nullptr, nullptr, nullptr, &stiffness, &gyrotropic);
    return result;
#endif
}

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_sparse_gyrotropic_modal_eigen(
    const SLEPcSparseGyrotropicModalEigenRequest &request) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};

    if (request.tangent_dof_count <= 0 ||
        request.stiffness_csr.row_count != static_cast<std::uint64_t>(request.tangent_dof_count) ||
        request.stiffness_csr.column_count != static_cast<std::uint64_t>(request.tangent_dof_count) ||
        request.gyrotropic_csr.row_count != request.stiffness_csr.row_count ||
        request.gyrotropic_csr.column_count != request.stiffness_csr.column_count) {
        result.status = "validation_error";
        result.unsupported_reason = "invalid_sparse_modal_request";
        return result;
    }

#if !FULLMAG_FEM_WITH_SLEPC
    (void)request;
    result.unsupported_reason = "slepc_not_available";
    return result;
#else
    const std::lock_guard<std::mutex> lock(slepc_modal_solver_mutex());
    if (!ensure_slepc_initialized(&result)) {
        return result;
    }

    Mat stiffness = nullptr;
    Mat gyrotropic = nullptr;
    if (!create_sequential_sparse_matrix_from_csr(request.stiffness_csr, &stiffness) ||
        !create_sequential_sparse_matrix_from_csr(request.gyrotropic_csr, &gyrotropic)) {
        result.status = "solve_error";
        result.unsupported_reason = "petsc_sparse_matrix_creation_failed";
        destroy_slepc_modal_objects(nullptr, nullptr, nullptr, &stiffness, &gyrotropic);
        return result;
    }

    SLEPcTinyGyrotropicModalEigenRequest solve_request{};
    solve_request.tangent_dof_count = request.tangent_dof_count;
    solve_request.requested_mode_count = request.requested_mode_count;
    solve_request.target_frequency_hz = request.target_frequency_hz;
    solve_request.frequency_min_hz = request.frequency_min_hz;
    solve_request.frequency_max_hz = request.frequency_max_hz;
    solve_request.residual_tolerance = request.residual_tolerance;
    solve_request.max_outer_iterations = request.max_outer_iterations;
    solve_request.max_linear_iterations = request.max_linear_iterations;
    solve_request.phase_convention = request.phase_convention;
    result = solve_slepc_gyrotropic_modal_eigen_with_matrices(
        solve_request,
        stiffness,
        gyrotropic);
    destroy_slepc_modal_objects(nullptr, nullptr, nullptr, &stiffness, &gyrotropic);
    return result;
#endif
}

} // namespace fullmag::fem::frequency_domain
