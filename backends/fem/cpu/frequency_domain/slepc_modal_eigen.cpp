#include "cpu/frequency_domain/slepc_modal_eigen.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <mutex>

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepc/slepceps.h>
#endif

namespace fullmag::fem::frequency_domain {

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

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

void destroy_slepc_modal_objects(EPS *eps, Vec *xr, Vec *xi, Mat *stiffness, Mat *gyrotropic)
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
    const int size = request.tangent_dof_count;

    ST spectral_transform = nullptr;
    const double target_angular_frequency =
        std::max(0.0, request.target_frequency_hz) * kTwoPi;
    const PetscInt max_iterations =
        request.max_outer_iterations > 0 ? request.max_outer_iterations : PETSC_DEFAULT;
    const PetscInt max_linear_iterations =
        request.max_linear_iterations > 0 ? request.max_linear_iterations : PETSC_DEFAULT;
    const PetscReal tolerance =
        request.residual_tolerance > 0.0 ? request.residual_tolerance : 1.0e-10;
    const PetscReal ksp_rtol = std::min(0.01 * tolerance, 1.0e-10);
    const PetscReal ksp_atol = 1.0e-14;
    const PetscInt requested_eigenpair_count = std::min<PetscInt>(
        size,
        std::max<PetscInt>(
            1,
            static_cast<PetscInt>(requested_positive_mode_count(request) * 2)));

    bool configured =
        EPSCreate(PETSC_COMM_SELF, &eps) == 0 &&
        EPSSetOperators(eps, stiffness, gyrotropic) == 0 &&
        EPSSetProblemType(eps, EPS_GNHEP) == 0 &&
        EPSSetType(eps, EPSKRYLOVSCHUR) == 0 &&
        EPSSetDimensions(eps, requested_eigenpair_count, PETSC_DEFAULT, PETSC_DEFAULT) == 0 &&
        EPSGetST(eps, &spectral_transform) == 0 &&
        STSetType(spectral_transform, STSINVERT) == 0 &&
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) == 0 &&
        EPSSetTarget(eps, static_cast<PetscScalar>(target_angular_frequency)) == 0 &&
        EPSSetTolerances(eps, tolerance, max_iterations) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, size, &xr) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, size, &xi) == 0;
    KSP ksp = nullptr;
    PC pc = nullptr;
    configured =
        configured &&
        STGetKSP(spectral_transform, &ksp) == 0 &&
        KSPSetType(ksp, KSPPREONLY) == 0 &&
        KSPGetPC(ksp, &pc) == 0 &&
        PCSetType(pc, PCLU) == 0 &&
        KSPSetTolerances(
            ksp,
            ksp_rtol,
            ksp_atol,
            PETSC_DEFAULT,
            max_linear_iterations) == 0;
    if (!configured) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_configuration_failed";
        destroy_slepc_modal_objects(&eps, &xr, &xi, nullptr, nullptr);
        return result;
    }
    result.ksp_rtol = static_cast<double>(ksp_rtol);
    result.ksp_atol = static_cast<double>(ksp_atol);
    result.ksp_max_iterations = request.max_linear_iterations > 0 ?
        request.max_linear_iterations :
        0;

    PetscInt outer_iterations = 0;
    PetscInt linear_iterations = 0;
    PetscReal ksp_final_residual = 0.0;
    PetscInt converged_eigenpair_count = 0;
    if (EPSSolve(eps) != 0 ||
        EPSGetIterationNumber(eps, &outer_iterations) != 0 ||
        EPSGetConverged(eps, &converged_eigenpair_count) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solve_failed";
        destroy_slepc_modal_objects(&eps, &xr, &xi, nullptr, nullptr);
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
    const bool filter_frequency_window = has_frequency_window(request);
    for (int index = 0; index < result.converged_eigenpair_count; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal relative_residual = 0.0;
        if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != 0 ||
            EPSComputeError(eps, index, EPS_ERROR_RELATIVE, &relative_residual) != 0) {
            continue;
        }
        const double lambda_real = petsc_eigenvalue_real_part(kr);
        const double lambda_imag = petsc_eigenvalue_imaginary_part(kr, ki);
        if (lambda_imag <= 0.0) {
            continue;
        }
        saw_positive_frequency = true;
        const double frequency_hz = lambda_imag / kTwoPi;
        if (filter_frequency_window &&
            (frequency_hz < request.frequency_min_hz ||
             frequency_hz > request.frequency_max_hz)) {
            continue;
        }
        saw_frequency_window_candidate = true;
        if (static_cast<double>(relative_residual) > static_cast<double>(tolerance)) {
            saw_residual_rejection = true;
            continue;
        }
        SLEPcModeCandidate candidate{};
        candidate.mode.eigenpair_index = index;
        candidate.mode.lambda_real = lambda_real;
        candidate.mode.lambda_imag = lambda_imag;
        candidate.mode.frequency_hz = frequency_hz;
        candidate.mode.relative_residual = static_cast<double>(relative_residual);
        candidate.mode.mode_vector = copy_slepc_eigenvector(xr, xi, size);
        if (candidate.mode.mode_vector.size() != static_cast<std::size_t>(size)) {
            continue;
        }
        candidate.target_distance = std::abs(lambda_imag - target_angular_frequency);
        accepted_candidates.push_back(candidate);
    }

    destroy_slepc_modal_objects(&eps, &xr, &xi, nullptr, nullptr);

    if (accepted_candidates.empty()) {
        result.status = "solve_error";
        if (!saw_positive_frequency) {
            result.unsupported_reason = "no_positive_frequency_eigenpair";
        } else if (filter_frequency_window && !saw_frequency_window_candidate) {
            result.unsupported_reason = "no_positive_frequency_eigenpair_in_window";
        } else if (saw_residual_rejection) {
            result.unsupported_reason = "residual_tolerance_not_met";
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
        status.solver_adapter_status = "shift_invert_macrospin_available";
        status.unavailable_message =
            "native FEM modal_eigen production CPU solver requires an MFEM modal operator payload; SLEPc shift-invert adapter is available for the macrospin contract proof";
        status.unsupported_reason = "mfem_modal_operator_payload_missing";
        status.eps_type = "krylovschur";
        status.problem_type = "gnhep";
        status.which_eigenpairs = "target_magnitude";
        status.ksp_type = "preonly";
        status.pc_type = "lu";
        status.factorization_package = "petsc_lu";
        status.nullspace_policy = "none";
        status.linear_tolerance_policy =
            "ksp_rtol=min(0.01*eigen_residual_tolerance,1e-10);ksp_atol=1e-14";
        status.algebraic_form = "gyrotropic_generalized";
        status.positive_frequency_filter = "imag(lambda) > 0";
        status.eigenvalue_to_frequency = "frequency_hz = imag(lambda)/(2*pi)";
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
    result = solve_slepc_gyrotropic_modal_eigen_with_matrices(
        solve_request,
        stiffness,
        gyrotropic);
    destroy_slepc_modal_objects(nullptr, nullptr, nullptr, &stiffness, &gyrotropic);
    return result;
#endif
}

} // namespace fullmag::fem::frequency_domain
