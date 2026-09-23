#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <vector>

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepceps.h>
#endif

namespace fullmag::fem::frequency_domain {
namespace {

bool finite_nonzero_k(const ModalEigenRequest &request) noexcept
{
    const double *values = request.operator_request.k_vector_rad_m;
    const int length = request.operator_request.k_vector_len;
    const bool use_embedded_vector =
        (values == nullptr || length <= 0) && request.has_floquet_k_vector;
    if (use_embedded_vector) {
        values = request.floquet_k_vector_rad_per_m;
    }
    const int effective_length = use_embedded_vector ? 3 : length;
    if (values == nullptr || effective_length != 3) {
        return false;
    }
    bool nonzero = false;
    for (int index = 0; index < effective_length; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
        nonzero = nonzero || std::abs(values[index]) > 0.0;
    }
    return nonzero;
}

bool floquet_k_payload_is_consistent(const ModalEigenRequest &request) noexcept
{
    if (!request.has_floquet_k_vector) {
        return true;
    }
    const double *operator_values = request.operator_request.k_vector_rad_m;
    const int operator_length = request.operator_request.k_vector_len;
    if (operator_values == nullptr && operator_length <= 0) {
        return true;
    }
    if (operator_values == nullptr || operator_length != 3) {
        return false;
    }
    for (int index = 0; index < 3; ++index) {
        if (!std::isfinite(operator_values[index]) ||
            operator_values[index] != request.floquet_k_vector_rad_per_m[index]) {
            return false;
        }
    }
    return true;
}

bool has_floquet_payload_marker(const ModalEigenRequest &request) noexcept
{
    const char *diagnostics = request.operator_request.operator_diagnostics_json;
    if (diagnostics == nullptr) {
        return false;
    }
    if (request.floquet_shared_domain_operator != nullptr) {
        return std::strstr(
                   diagnostics,
                   "\"payload_kind\":\"certified_shared_domain\"") != nullptr;
    }
    return std::strstr(
               diagnostics,
               "\"payload_kind\":\"bloch_floquet_tangent_operator\"") != nullptr;
}

SLEPcTinyGyrotropicModalEigenResult validation_failure(const char *reason) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    result.status = "validation_error";
    result.unsupported_reason = reason != nullptr ? reason : "invalid_floquet_modal_request";
    return result;
}

bool sparse_view_is_valid(const CsrMatrixView &view) noexcept
{
    if (view.row_count == 0 || view.column_count == 0 ||
        view.row_count != view.column_count || view.row_count ==
            std::numeric_limits<std::uint64_t>::max() ||
        view.row_offsets == nullptr ||
        view.row_offsets_len != view.row_count + 1u ||
        view.column_indices == nullptr || view.values == nullptr ||
        view.column_indices_len != view.values_len ||
        view.row_offsets[0] != 0u ||
        view.row_offsets[view.row_count] != view.values_len) {
        return false;
    }
    for (std::uint64_t row = 0; row < view.row_count; ++row) {
        if (view.row_offsets[row] > view.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < view.values_len; ++entry) {
        if (view.column_indices[entry] >= view.column_count ||
            !std::isfinite(view.values[entry])) {
            return false;
        }
    }
    return true;
}

bool complex_sparse_view_is_valid(
    const PoissonAirboxSharedDomainComplexCsrMatrix *view) noexcept
{
    if (view == nullptr || view->row_count == 0u || view->column_count == 0u ||
        view->row_count == std::numeric_limits<std::uint64_t>::max() ||
        view->row_count > std::numeric_limits<std::size_t>::max() ||
        view->row_offsets.size() !=
            static_cast<std::size_t>(view->row_count + 1u) ||
        view->column_indices.size() != view->values.size() ||
        view->row_offsets.empty() || view->row_offsets.front() != 0u ||
        view->row_offsets.back() != view->values.size()) {
        return false;
    }
    for (std::uint64_t row = 0u; row < view->row_count; ++row) {
        if (view->row_offsets[static_cast<std::size_t>(row)] >
            view->row_offsets[static_cast<std::size_t>(row + 1u)]) {
            return false;
        }
    }
    for (std::size_t index = 0u; index < view->values.size(); ++index) {
        const auto value = view->values[index];
        if (view->column_indices[index] >= view->column_count ||
            !std::isfinite(value.real()) || !std::isfinite(value.imag())) {
            return false;
        }
    }
    return true;
}

bool floquet_shared_operator_is_valid(
    const FloquetSharedDomainSparseModalOperator *operator_view,
    int spectral_dimension) noexcept
{
    if (operator_view == nullptr || operator_view->q_complex_dof_count == 0u ||
        operator_view->phi_dof_count == 0u ||
        operator_view->q_complex_dof_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2) ||
        operator_view->phi_dof_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2) ||
        (spectral_dimension !=
             static_cast<int>(operator_view->q_complex_dof_count) &&
         spectral_dimension !=
             static_cast<int>(2u * operator_view->q_complex_dof_count)) ||
        !complex_sparse_view_is_valid(operator_view->a_qq) ||
        !complex_sparse_view_is_valid(operator_view->b_qq) ||
        !complex_sparse_view_is_valid(operator_view->p) ||
        !complex_sparse_view_is_valid(operator_view->a_qphi) ||
        !complex_sparse_view_is_valid(operator_view->a_phiq)) {
        return false;
    }
    const std::uint64_t q = operator_view->q_complex_dof_count;
    const std::uint64_t phi = operator_view->phi_dof_count;
    return operator_view->a_qq->row_count == q &&
        operator_view->a_qq->column_count == q &&
        operator_view->b_qq->row_count == q &&
        operator_view->b_qq->column_count == q &&
        operator_view->p->row_count == phi &&
        operator_view->p->column_count == phi &&
        operator_view->a_qphi->row_count == q &&
        operator_view->a_qphi->column_count == phi &&
        operator_view->a_phiq->row_count == phi &&
        operator_view->a_phiq->column_count == q;
}

bool dense_matrix_payload_is_valid(
    const double *values,
    std::uint64_t value_count,
    int dimension) noexcept
{
    if (values == nullptr || dimension <= 0) {
        return false;
    }
    const std::uint64_t n = static_cast<std::uint64_t>(dimension);
    if (n > std::numeric_limits<std::uint64_t>::max() / n ||
        value_count != n * n) {
        return false;
    }
    for (std::uint64_t index = 0; index < value_count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

bool frequency_window_is_valid(
    const SLEPcTinyGyrotropicModalEigenRequest &request,
    bool *out_has_window) noexcept
{
    if (out_has_window == nullptr ||
        !std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !std::isfinite(request.target_frequency_hz) ||
        request.frequency_min_hz < 0.0 ||
        request.frequency_max_hz < 0.0 ||
        request.target_frequency_hz < 0.0) {
        return false;
    }
    const bool no_window = request.frequency_min_hz == 0.0 &&
        request.frequency_max_hz == 0.0;
    if (!no_window &&
        !(request.frequency_max_hz > request.frequency_min_hz)) {
        return false;
    }
    *out_has_window = !no_window;
    return true;
}

bool frequency_window_is_valid(
    const SLEPcSparseGyrotropicModalEigenRequest &request,
    bool *out_has_window) noexcept
{
    if (out_has_window == nullptr ||
        !std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !std::isfinite(request.target_frequency_hz) ||
        request.frequency_min_hz < 0.0 ||
        request.frequency_max_hz < 0.0 ||
        request.target_frequency_hz < 0.0) {
        return false;
    }
    const bool no_window = request.frequency_min_hz == 0.0 &&
        request.frequency_max_hz == 0.0;
    if (!no_window &&
        !(request.frequency_max_hz > request.frequency_min_hz)) {
        return false;
    }
    *out_has_window = !no_window;
    return true;
}

using Complex = std::complex<double>;

std::vector<Complex> complex_csr_matvec(
    const PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    const std::vector<Complex> &x)
{
    std::vector<Complex> result(static_cast<std::size_t>(matrix.row_count), Complex{});
    if (matrix.column_count != x.size()) {
        return {};
    }
    for (std::uint64_t row = 0u; row < matrix.row_count; ++row) {
        Complex value{};
        for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
             entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            value += matrix.values[entry] *
                x[static_cast<std::size_t>(matrix.column_indices[entry])];
        }
        result[static_cast<std::size_t>(row)] = value;
    }
    return result;
}

double complex_vector_norm(const std::vector<Complex> &values) noexcept
{
    long double sum = 0.0L;
    for (const Complex value : values) {
        sum += static_cast<long double>(std::norm(value));
    }
    const double norm = std::sqrt(static_cast<double>(sum));
    return std::isfinite(norm) ? norm : std::numeric_limits<double>::infinity();
}

std::vector<Complex> physical_complex_vector_from_split(
    const std::vector<Complex> &split,
    std::uint64_t physical_count)
{
    if (physical_count == 0u ||
        split.size() != static_cast<std::size_t>(2u * physical_count)) {
        return {};
    }
    std::vector<Complex> result(static_cast<std::size_t>(physical_count), Complex{});
    for (std::uint64_t index = 0u; index < physical_count; ++index) {
        result[static_cast<std::size_t>(index)] =
            split[static_cast<std::size_t>(index)] +
            Complex(0.0, 1.0) *
                split[static_cast<std::size_t>(physical_count + index)];
    }
    return result;
}

double floquet_magnetic_residual(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const std::vector<Complex> &q,
    const std::vector<Complex> &phi,
    Complex lambda) noexcept
{
    const std::vector<Complex> a_qq_q = complex_csr_matvec(*operator_view.a_qq, q);
    const std::vector<Complex> a_qphi_phi =
        complex_csr_matvec(*operator_view.a_qphi, phi);
    const std::vector<Complex> b_q = complex_csr_matvec(*operator_view.b_qq, q);
    if (a_qq_q.size() != q.size() || a_qphi_phi.size() != q.size() ||
        b_q.size() != q.size()) {
        return std::numeric_limits<double>::infinity();
    }
    std::vector<Complex> residual(q.size(), Complex{});
    double denominator = 0.0;
    for (std::size_t index = 0u; index < q.size(); ++index) {
        residual[index] = a_qq_q[index] + a_qphi_phi[index] - lambda * b_q[index];
    }
    denominator = complex_vector_norm(a_qq_q) + complex_vector_norm(a_qphi_phi) +
        std::abs(lambda) * complex_vector_norm(b_q);
    return complex_vector_norm(residual) /
        (denominator + std::numeric_limits<double>::min());
}

double floquet_potential_residual(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const std::vector<Complex> &q,
    const std::vector<Complex> &phi) noexcept
{
    const std::vector<Complex> p_phi = complex_csr_matvec(*operator_view.p, phi);
    const std::vector<Complex> a_phiq_q = complex_csr_matvec(*operator_view.a_phiq, q);
    if (p_phi.size() != phi.size() || a_phiq_q.size() != phi.size()) {
        return std::numeric_limits<double>::infinity();
    }
    std::vector<Complex> residual(phi.size(), Complex{});
    for (std::size_t index = 0u; index < phi.size(); ++index) {
        residual[index] = p_phi[index] + a_phiq_q[index];
    }
    return complex_vector_norm(residual) /
        (complex_vector_norm(p_phi) + complex_vector_norm(a_phiq_q) +
         std::numeric_limits<double>::min());
}

#if FULLMAG_FEM_WITH_SLEPC

#if defined(PETSC_USE_COMPLEX)
// The modal production contract uses a real PETSc build and performs the
// complex Floquet algebra in a real split.  A complex PETSc build would make
// the pair-vector interpretation ambiguous, so fail explicitly.
#endif

struct NativeFloquetMatShellContext {
    Mat a_qq = nullptr;
    Mat rotated_a_qq = nullptr;
    Mat a_qphi = nullptr;
    Mat a_phiq = nullptr;
    Mat p = nullptr;
    KSP p_ksp = nullptr;
    Vec phi_rhs = nullptr;
    Vec phi_solution = nullptr;
    Vec feedback = nullptr;
    Vec q_physical_real = nullptr;
    Vec q_physical_imag = nullptr;
    PetscInt q_split_count = 0;
    PetscInt q_complex_count = 0;
    PetscInt phi_split_count = 0;
    int phase_sign = 1;
    char error_message[256]{};
};

std::mutex &native_floquet_solver_mutex()
{
    static std::mutex mutex;
    return mutex;
}

void copy_native_floquet_error(
    NativeFloquetMatShellContext *context,
    const char *message) noexcept
{
    if (context == nullptr) {
        return;
    }
    std::strncpy(
        context->error_message,
        message != nullptr ? message : "",
        sizeof(context->error_message) - 1u);
    context->error_message[sizeof(context->error_message) - 1u] = '\0';
}

bool create_real_split_matrix(
    const PoissonAirboxSharedDomainComplexCsrMatrix &source,
    Mat *out_matrix,
    int rotation_sign = 0)
{
    if (out_matrix == nullptr || source.row_count == 0u || source.column_count == 0u ||
        (rotation_sign != -1 && rotation_sign != 0 && rotation_sign != 1) ||
        source.row_count > static_cast<std::uint64_t>(
            std::numeric_limits<PetscInt>::max() / 2) ||
        source.column_count > static_cast<std::uint64_t>(
            std::numeric_limits<PetscInt>::max() / 2) ||
        source.row_offsets.size() != static_cast<std::size_t>(source.row_count + 1u)) {
        return false;
    }
    const PetscInt rows = static_cast<PetscInt>(2u * source.row_count);
    const PetscInt columns = static_cast<PetscInt>(2u * source.column_count);
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(rows), 0);
    for (std::uint64_t row = 0u; row < source.row_count; ++row) {
        const std::uint64_t nnz =
            source.row_offsets[static_cast<std::size_t>(row + 1u)] -
            source.row_offsets[static_cast<std::size_t>(row)];
        if (nnz > static_cast<std::uint64_t>(
                std::numeric_limits<PetscInt>::max() / 2)) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(2u * nnz);
        row_nonzeros[static_cast<std::size_t>(source.row_count + row)] =
            static_cast<PetscInt>(2u * nnz);
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            rows,
            columns,
            0,
            row_nonzeros.data(),
            out_matrix) != 0) {
        return false;
    }
    if (MatSetOption(*out_matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    const PetscInt column_base = static_cast<PetscInt>(source.column_count);
    const PetscInt row_base = static_cast<PetscInt>(source.row_count);
    for (std::uint64_t row = 0u; row < source.row_count; ++row) {
        for (std::uint32_t entry = source.row_offsets[static_cast<std::size_t>(row)];
             entry < source.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            const auto value = source.values[entry];
            const double block_real = rotation_sign == 0
                ? value.real()
                : static_cast<double>(rotation_sign) * value.imag();
            const double block_imag = rotation_sign == 0
                ? value.imag()
                : -static_cast<double>(rotation_sign) * value.real();
            const PetscInt petsc_row = static_cast<PetscInt>(row);
            const PetscInt petsc_column =
                static_cast<PetscInt>(source.column_indices[entry]);
            if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
                MatDestroy(out_matrix);
                return false;
            }
            if (block_real != 0.0 &&
                (MatSetValue(
                     *out_matrix,
                     petsc_row,
                     petsc_column,
                     static_cast<PetscScalar>(block_real),
                     ADD_VALUES) != 0 ||
                 MatSetValue(
                     *out_matrix,
                     petsc_row + row_base,
                     petsc_column + column_base,
                     static_cast<PetscScalar>(block_real),
                     ADD_VALUES) != 0)) {
                MatDestroy(out_matrix);
                return false;
            }
            if (block_imag != 0.0 &&
                (MatSetValue(
                     *out_matrix,
                     petsc_row,
                     petsc_column + column_base,
                     static_cast<PetscScalar>(-block_imag),
                     ADD_VALUES) != 0 ||
                 MatSetValue(
                     *out_matrix,
                     petsc_row + row_base,
                     petsc_column,
                     static_cast<PetscScalar>(block_imag),
                     ADD_VALUES) != 0)) {
                MatDestroy(out_matrix);
                return false;
            }
        }
    }
    if (MatAssemblyBegin(*out_matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*out_matrix, MAT_FINAL_ASSEMBLY) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    return true;
}

// The shifted operator is a real-frequency rotation of the magnetic block
// minus sigma times the gyrotropic block. Keep this sparse matrix separate
// from the MatShell used for the exact Schur action: it is the preconditioner
// only, while the shell still performs the scalar-field feedback solve.
bool create_native_floquet_shifted_preconditioner(
    Mat rotated_a_qq,
    Mat gyrotropic,
    PetscScalar shift,
    Mat *out_matrix)
{
    if (rotated_a_qq == nullptr || gyrotropic == nullptr || out_matrix == nullptr) {
        return false;
    }
    *out_matrix = nullptr;
    if (MatDuplicate(rotated_a_qq, MAT_COPY_VALUES, out_matrix) != 0 ||
        MatAXPY(
            *out_matrix,
            static_cast<PetscScalar>(-shift),
            gyrotropic,
            DIFFERENT_NONZERO_PATTERN) != 0 ||
        // The real-frequency rotation can leave a zero diagonal in the
        // magnetic block.  PETSc's sparse LU requires every row to have a
        // diagonal slot, even when its value is zero.  Insert zero-valued
        // structural entries without changing the preconditioner values.
        MatSetOption(*out_matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0 ||
        MatSetOption(*out_matrix, MAT_IGNORE_ZERO_ENTRIES, PETSC_FALSE) != 0) {
        if (*out_matrix != nullptr) {
            MatDestroy(out_matrix);
        }
        return false;
    }
    PetscInt row_begin = 0;
    PetscInt row_end = 0;
    if (MatGetOwnershipRange(*out_matrix, &row_begin, &row_end) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    for (PetscInt row = row_begin; row < row_end; ++row) {
        if (MatSetValue(*out_matrix, row, row, static_cast<PetscScalar>(0.0), ADD_VALUES) != 0) {
            MatDestroy(out_matrix);
            return false;
        }
    }
    if (MatAssemblyBegin(*out_matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*out_matrix, MAT_FINAL_ASSEMBLY) != 0) {
        if (*out_matrix != nullptr) {
            MatDestroy(out_matrix);
        }
        return false;
    }
    return true;
}

PetscErrorCode native_floquet_matmult(Mat matrix, Vec x, Vec y)
{
    void *raw_context = nullptr;
    if (MatShellGetContext(matrix, &raw_context) != 0 || raw_context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *context = static_cast<NativeFloquetMatShellContext *>(raw_context);
    PetscInt size = 0;
    if (VecGetSize(x, &size) != 0 || size != context->q_split_count) {
        copy_native_floquet_error(context, "Floquet MatShell q dimensions do not match");
        return PETSC_ERR_ARG_SIZ;
    }
    if (MatMult(context->a_phiq, x, context->phi_rhs) != 0 ||
        VecScale(context->phi_rhs, static_cast<PetscScalar>(-1.0)) != 0 ||
        KSPSolve(context->p_ksp, context->phi_rhs, context->phi_solution) != 0) {
        copy_native_floquet_error(context, "Floquet MatShell scalar Schur solve failed");
        return PETSC_ERR_NOT_CONVERGED;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(context->p_ksp, &reason) != 0 || reason < 0) {
        copy_native_floquet_error(context, "Floquet MatShell scalar Schur solve did not converge");
        return PETSC_ERR_NOT_CONVERGED;
    }
    if (MatMult(context->a_qq, x, y) != 0 ||
        MatMult(context->a_qphi, context->phi_solution, context->feedback) != 0 ||
        VecAXPY(y, static_cast<PetscScalar>(1.0), context->feedback) != 0 ||
        VecCopy(y, context->feedback) != 0) {
        copy_native_floquet_error(context, "Floquet MatShell magnetic Schur action failed");
        return PETSC_ERR_LIB;
    }
    const PetscScalar *sum_values = nullptr;
    PetscScalar *rotated_values = nullptr;
    if (VecGetArrayRead(context->feedback, &sum_values) != 0 ||
        VecGetArray(y, &rotated_values) != 0) {
        if (sum_values != nullptr) {
            VecRestoreArrayRead(context->feedback, &sum_values);
        }
        if (rotated_values != nullptr) {
            VecRestoreArray(y, &rotated_values);
        }
        copy_native_floquet_error(context, "Floquet MatShell rotation workspace failed");
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < context->q_complex_count; ++index) {
        const PetscScalar real_part = sum_values[index];
        const PetscScalar imaginary_part =
            sum_values[context->q_complex_count + index];
        rotated_values[index] = static_cast<PetscScalar>(context->phase_sign) *
            imaginary_part;
        rotated_values[context->q_complex_count + index] =
            -static_cast<PetscScalar>(context->phase_sign) * real_part;
    }
    VecRestoreArrayRead(context->feedback, &sum_values);
    VecRestoreArray(y, &rotated_values);
    return 0;
}

void destroy_native_floquet_context(NativeFloquetMatShellContext *context) noexcept
{
    if (context == nullptr) {
        return;
    }
    if (context->feedback != nullptr) {
        VecDestroy(&context->feedback);
    }
    if (context->q_physical_imag != nullptr) {
        VecDestroy(&context->q_physical_imag);
    }
    if (context->q_physical_real != nullptr) {
        VecDestroy(&context->q_physical_real);
    }
    if (context->phi_solution != nullptr) {
        VecDestroy(&context->phi_solution);
    }
    if (context->phi_rhs != nullptr) {
        VecDestroy(&context->phi_rhs);
    }
    if (context->p_ksp != nullptr) {
        KSPDestroy(&context->p_ksp);
    }
    if (context->p != nullptr) {
        MatDestroy(&context->p);
    }
    if (context->rotated_a_qq != nullptr) {
        MatDestroy(&context->rotated_a_qq);
    }
    if (context->a_phiq != nullptr) {
        MatDestroy(&context->a_phiq);
    }
    if (context->a_qphi != nullptr) {
        MatDestroy(&context->a_qphi);
    }
    if (context->a_qq != nullptr) {
        MatDestroy(&context->a_qq);
    }
}

bool solve_native_floquet_phi_for_vector(
    NativeFloquetMatShellContext *context,
    Vec q,
    std::vector<double> &out_phi)
{
    if (context == nullptr || q == nullptr ||
        MatMult(context->a_phiq, q, context->phi_rhs) != 0 ||
        VecScale(context->phi_rhs, static_cast<PetscScalar>(-1.0)) != 0 ||
        KSPSolve(context->p_ksp, context->phi_rhs, context->phi_solution) != 0) {
        return false;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(context->p_ksp, &reason) != 0 || reason < 0) {
        return false;
    }
    const PetscScalar *values = nullptr;
    if (VecGetArrayRead(context->phi_solution, &values) != 0) {
        return false;
    }
    out_phi.resize(static_cast<std::size_t>(context->phi_split_count));
    for (PetscInt index = 0; index < context->phi_split_count; ++index) {
        out_phi[static_cast<std::size_t>(index)] =
            static_cast<double>(PetscRealPart(values[index]));
    }
    VecRestoreArrayRead(context->phi_solution, &values);
    return true;
}

bool solve_native_floquet_phi_for_physical_mode(
    NativeFloquetMatShellContext *context,
    Vec xr,
    Vec xi,
    std::vector<Complex> &out_phi)
{
    if (context == nullptr || xr == nullptr || xi == nullptr ||
        context->q_physical_real == nullptr || context->q_physical_imag == nullptr ||
        context->q_complex_count <= 0) {
        return false;
    }
    PetscInt real_size = 0;
    PetscInt imag_size = 0;
    if (VecGetSize(xr, &real_size) != 0 || VecGetSize(xi, &imag_size) != 0 ||
        real_size != context->q_split_count || imag_size != context->q_split_count) {
        return false;
    }

    const PetscScalar *real_values = nullptr;
    const PetscScalar *imag_values = nullptr;
    PetscScalar *q_real_values = nullptr;
    PetscScalar *q_imag_values = nullptr;
    const PetscInt q_count = context->q_complex_count;
    if (VecGetArrayRead(xr, &real_values) != 0 ||
        VecGetArrayRead(xi, &imag_values) != 0 ||
        VecGetArray(context->q_physical_real, &q_real_values) != 0 ||
        VecGetArray(context->q_physical_imag, &q_imag_values) != 0) {
        if (real_values != nullptr) {
            VecRestoreArrayRead(xr, &real_values);
        }
        if (imag_values != nullptr) {
            VecRestoreArrayRead(xi, &imag_values);
        }
        if (q_real_values != nullptr) {
            VecRestoreArray(context->q_physical_real, &q_real_values);
        }
        if (q_imag_values != nullptr) {
            VecRestoreArray(context->q_physical_imag, &q_imag_values);
        }
        return false;
    }
    for (PetscInt index = 0; index < q_count; ++index) {
        // EPS stores a (possibly complex) eigenvector of the real-split
        // rotated pencil as x = x_r + i*x_i.  The physical q is obtained by
        // collapsing the two split blocks, q = x[0:q] + i*x[q:2q].
        const PetscScalar physical_real =
            real_values[index] - imag_values[q_count + index];
        const PetscScalar physical_imag =
            imag_values[index] + real_values[q_count + index];
        q_real_values[index] = physical_real;
        q_real_values[q_count + index] = physical_imag;
        q_imag_values[index] = 0.0;
        q_imag_values[q_count + index] = 0.0;
    }
    VecRestoreArrayRead(xr, &real_values);
    VecRestoreArrayRead(xi, &imag_values);
    VecRestoreArray(context->q_physical_real, &q_real_values);
    VecRestoreArray(context->q_physical_imag, &q_imag_values);

    std::vector<double> phi_split;
    if (!solve_native_floquet_phi_for_vector(
            context, context->q_physical_real, phi_split) ||
        phi_split.size() != static_cast<std::size_t>(context->phi_split_count) ||
        context->phi_split_count % 2 != 0) {
        return false;
    }
    const PetscInt phi_count = context->phi_split_count / 2;
    out_phi.resize(static_cast<std::size_t>(phi_count));
    for (PetscInt index = 0; index < phi_count; ++index) {
        // q_physical_real carries the complete real split [Re(q), Im(q)].
        // Solving that split system once produces [Re(phi), Im(phi)] for the
        // same physical complex q.  Solving separate real and imaginary
        // right-hand sides would erase the phase of q before the Poisson
        // reconstruction and is incorrect for genuine nonzero-k modes.
        out_phi[static_cast<std::size_t>(index)] = Complex(
            phi_split[static_cast<std::size_t>(index)],
            phi_split[static_cast<std::size_t>(phi_count + index)]);
    }
    return true;
}

bool copy_native_floquet_eigenvector(
    Vec xr,
    Vec xi,
    PetscInt size,
    std::vector<Complex> &out)
{
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
        return false;
    }
    out.resize(static_cast<std::size_t>(size));
    for (PetscInt index = 0; index < size; ++index) {
        out[static_cast<std::size_t>(index)] = Complex(
            static_cast<double>(PetscRealPart(real_values[index])),
            static_cast<double>(PetscRealPart(imag_values[index])));
    }
    VecRestoreArrayRead(xr, &real_values);
    VecRestoreArrayRead(xi, &imag_values);
    return true;
}

#endif

} // namespace

FloquetModalSolverAdmission admit_floquet_modal_request(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept
{
    FloquetModalSolverAdmission admission{};
    if (!frequency_window_is_valid(spectral_request, &admission.frequency_window)) {
        admission.reason = "floquet_modal_requires_valid_frequency_window";
        return admission;
    }
    admission.dynamic_demag_k = request.operator_request.include_demag != 0;
    if (request.execution_target == ModalExecutionTarget::production_gpu) {
        admission.reason = "floquet_modal_gpu_lane_not_owned_by_cpu_solver";
        return admission;
    }
    if (request.operator_request.spin_wave_bc_kind == nullptr ||
        std::strcmp(request.operator_request.spin_wave_bc_kind, "floquet") != 0) {
        admission.reason = "floquet_modal_requires_floquet_boundary";
        return admission;
    }
    if (!floquet_k_payload_is_consistent(request)) {
        admission.reason = "floquet_modal_k_vector_payload_mismatch";
        return admission;
    }
    if (!finite_nonzero_k(request)) {
        admission.reason = "floquet_modal_requires_finite_nonzero_three_vector";
        return admission;
    }
    admission.nonzero_k = true;
    if (request.floquet_periodic_pair_count == 0u ||
        request.floquet_periodic_pairs == nullptr) {
        admission.reason = "floquet_modal_requires_periodic_pair_payload";
        return admission;
    }
    if (!has_floquet_payload_marker(request)) {
        admission.reason = "floquet_modal_requires_bloch_floquet_operator_payload";
        return admission;
    }
    if (request.operator_request.include_demag != 0) {
        if (request.dynamic_demag_k_tangent_matrix_row_major == nullptr ||
            request.dynamic_demag_k_tangent_matrix_value_count == 0u) {
            admission.reason = "floquet_modal_requires_dynamic_demag_k_payload";
            return admission;
        }
        if (!dense_matrix_payload_is_valid(
                request.dynamic_demag_k_tangent_matrix_row_major,
                request.dynamic_demag_k_tangent_matrix_value_count,
                spectral_request.tangent_dof_count)) {
            admission.reason =
                "floquet_modal_requires_finite_square_dynamic_demag_k_payload";
            return admission;
        }
    }
    if (spectral_request.tangent_dof_count <= 0 ||
        spectral_request.stiffness_matrix_row_major == nullptr ||
        spectral_request.gyrotropic_matrix_row_major == nullptr) {
        admission.reason = "floquet_modal_requires_realified_spectral_operator";
        return admission;
    }
    admission.accepted = true;
    admission.reason = "accepted_floquet_cpu_slepc";
    return admission;
}

FloquetModalSolverAdmission admit_floquet_modal_sparse_request(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    FloquetModalSolverAdmission admission{};
    if (!frequency_window_is_valid(spectral_request, &admission.frequency_window)) {
        admission.reason = "floquet_modal_requires_valid_frequency_window";
        return admission;
    }
    if (request.execution_target == ModalExecutionTarget::production_gpu) {
        admission.reason = "floquet_modal_gpu_lane_not_owned_by_cpu_solver";
        return admission;
    }
    if (request.operator_request.spin_wave_bc_kind == nullptr ||
        std::strcmp(request.operator_request.spin_wave_bc_kind, "floquet") != 0) {
        admission.reason = "floquet_modal_requires_floquet_boundary";
        return admission;
    }
    if (!floquet_k_payload_is_consistent(request)) {
        admission.reason = "floquet_modal_k_vector_payload_mismatch";
        return admission;
    }
    if (!finite_nonzero_k(request)) {
        admission.reason = "floquet_modal_requires_finite_nonzero_three_vector";
        return admission;
    }
    admission.nonzero_k = true;
    if (request.floquet_periodic_pair_count == 0u ||
        request.floquet_periodic_pairs == nullptr) {
        admission.reason = "floquet_modal_requires_periodic_pair_payload";
        return admission;
    }
    if (!has_floquet_payload_marker(request)) {
        admission.reason = "floquet_modal_requires_bloch_floquet_operator_payload";
        return admission;
    }
    if (request.operator_request.include_demag != 0) {
        admission.dynamic_demag_k = true;
        if (spectral_request.floquet_shared_domain_operator == nullptr) {
            admission.reason =
                "floquet_sparse_modal_requires_shared_domain_sparse_owner";
            return admission;
        }
    }
    if (spectral_request.tangent_dof_count <= 0) {
        admission.reason = "floquet_modal_requires_realified_sparse_operator";
        return admission;
    }
    if (spectral_request.floquet_shared_domain_operator != nullptr) {
        if (!floquet_shared_operator_is_valid(
                spectral_request.floquet_shared_domain_operator,
                spectral_request.tangent_dof_count)) {
            admission.reason =
                "floquet_modal_shared_domain_sparse_operator_is_invalid";
            return admission;
        }
    } else if (!sparse_view_is_valid(spectral_request.stiffness_csr) ||
               !sparse_view_is_valid(spectral_request.gyrotropic_csr) ||
               spectral_request.stiffness_csr.row_count !=
                   static_cast<std::uint64_t>(spectral_request.tangent_dof_count) ||
               spectral_request.gyrotropic_csr.row_count !=
                   static_cast<std::uint64_t>(spectral_request.tangent_dof_count)) {
            admission.reason = "floquet_modal_requires_realified_sparse_operator";
            return admission;
    }
    admission.accepted = true;
    admission.reason = "accepted_floquet_cpu_sparse_slepc";
    return admission;
}

SLEPcTinyGyrotropicModalEigenResult solve_floquet_modal_spectrum(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept
{
    const FloquetModalSolverAdmission admission =
        admit_floquet_modal_request(request, spectral_request);
    if (!admission.accepted) {
        return validation_failure(admission.reason);
    }
    return solve_slepc_tiny_gyrotropic_modal_eigen(spectral_request);
}

SLEPcTinyGyrotropicModalEigenResult solve_floquet_modal_sparse_spectrum(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    const FloquetModalSolverAdmission admission =
        admit_floquet_modal_sparse_request(request, spectral_request);
    if (!admission.accepted) {
        return validation_failure(admission.reason);
    }
    if (spectral_request.floquet_shared_domain_operator != nullptr) {
        return solve_floquet_shared_domain_sparse_modal_spectrum(
            *spectral_request.floquet_shared_domain_operator,
            spectral_request);
    }
    return solve_slepc_sparse_gyrotropic_modal_eigen(spectral_request);
}

SLEPcTinyGyrotropicModalEigenResult
solve_floquet_shared_domain_sparse_modal_spectrum(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    result.solver_adapter = "floquet_airbox_cpu_schur_slepc";
    result.eps_type = "krylovschur";
    result.problem_type = "gnhep";
    result.spectral_transform = "shift_invert";
    result.which_eigenpairs = "target_magnitude";
    result.ksp_type = "gmres";
    result.pc_type = "lu";
    result.factorization_package = "petsc_default_lu";
    result.poisson_ksp_type = "preonly";
    result.poisson_pc_type = "lu";
    result.poisson_factorization_package = "petsc_default_lu";
    result.poisson_iteration_semantics =
        "preonly_factorization_no_iterative_convergence";
    result.nullspace_policy = "nonzero_k_invertible_poisson";
    result.unsupported_reason = "";

    const int advertised_dimension = spectral_request.tangent_dof_count;
    if (!floquet_shared_operator_is_valid(&operator_view, advertised_dimension)) {
        result.status = "validation_error";
        result.unsupported_reason = "invalid_shared_domain_floquet_sparse_operator";
        return result;
    }

#if !FULLMAG_FEM_WITH_SLEPC
    (void)operator_view;
    (void)spectral_request;
    result.unsupported_reason = "slepc_not_available";
    return result;
#elif defined(PETSC_USE_COMPLEX)
    (void)operator_view;
    (void)spectral_request;
    result.unsupported_reason = "floquet_shared_domain_requires_real_petsc_split";
    return result;
#else
    const std::lock_guard<std::mutex> lock(native_floquet_solver_mutex());

    PetscBool slepc_initialized = PETSC_FALSE;
    if (SlepcInitialized(&slepc_initialized) != 0 ||
        (!slepc_initialized && SlepcInitializeNoArguments() != 0)) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_initialization_failed";
        return result;
    }

    NativeFloquetMatShellContext context{};
    context.phase_sign = spectral_request.phase_convention ==
        FrequencyDomainPhaseConvention::exp_i_omega_t ? 1 : -1;
    context.q_complex_count = static_cast<PetscInt>(
        operator_view.q_complex_dof_count);
    context.q_split_count = static_cast<PetscInt>(
        2u * operator_view.q_complex_dof_count);
    context.phi_split_count = static_cast<PetscInt>(
        2u * operator_view.phi_dof_count);
    Mat shell = nullptr;
    Mat gyrotropic = nullptr;
    Mat shifted_preconditioner = nullptr;
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    auto destroy_all = [&]() noexcept {
        if (xr != nullptr) {
            VecDestroy(&xr);
        }
        if (xi != nullptr) {
            VecDestroy(&xi);
        }
        if (eps != nullptr) {
            EPSDestroy(&eps);
        }
        if (shell != nullptr) {
            MatDestroy(&shell);
        }
        if (gyrotropic != nullptr) {
            MatDestroy(&gyrotropic);
        }
        if (shifted_preconditioner != nullptr) {
            MatDestroy(&shifted_preconditioner);
        }
        destroy_native_floquet_context(&context);
    };

    if (!create_real_split_matrix(*operator_view.a_qq, &context.a_qq) ||
        !create_real_split_matrix(
            *operator_view.a_qq,
            &context.rotated_a_qq,
            context.phase_sign) ||
        !create_real_split_matrix(*operator_view.a_qphi, &context.a_qphi) ||
        !create_real_split_matrix(*operator_view.a_phiq, &context.a_phiq) ||
        !create_real_split_matrix(*operator_view.p, &context.p) ||
        !create_real_split_matrix(*operator_view.b_qq, &gyrotropic)) {
        result.status = "solve_error";
        result.unsupported_reason = "petsc_floquet_sparse_matrix_creation_failed";
        destroy_all();
        return result;
    }
    if (KSPCreate(PETSC_COMM_SELF, &context.p_ksp) != 0 ||
        KSPSetOperators(context.p_ksp, context.p, context.p) != 0 ||
        KSPSetType(context.p_ksp, KSPPREONLY) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_poisson_ksp_creation_failed";
        destroy_all();
        return result;
    }
    const PetscReal poisson_ksp_rtol = std::max(
        static_cast<PetscReal>(1.0e-13),
        std::min(
            static_cast<PetscReal>(1.0e-10),
            static_cast<PetscReal>(1.0e-3 * std::max(
                spectral_request.residual_tolerance,
                1.0e-10))));
    // Keep both KSP layers explicit.  PETSC_DEFAULT is part of the selected
    // PETSc policy here; query the resolved value below instead of reporting
    // a guessed zero or introducing a hidden absolute-tolerance constant.
    const PetscInt requested_linear_iterations =
        spectral_request.max_linear_iterations > 0
            ? static_cast<PetscInt>(spectral_request.max_linear_iterations)
            : PETSC_DEFAULT;
    PC poisson_pc = nullptr;
    if (KSPGetPC(context.p_ksp, &poisson_pc) != 0 ||
        PCSetType(poisson_pc, PCLU) != 0 ||
        PCFactorSetShiftType(poisson_pc, MAT_SHIFT_NONZERO) != 0 ||
        KSPSetTolerances(
            context.p_ksp,
            poisson_ksp_rtol,
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            requested_linear_iterations) != 0 ||
        KSPSetErrorIfNotConverged(context.p_ksp, PETSC_TRUE) != 0 ||
        KSPSetUp(context.p_ksp) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.phi_split_count, &context.phi_rhs) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.phi_split_count, &context.phi_solution) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.q_split_count, &context.feedback) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.q_split_count, &context.q_physical_real) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.q_split_count, &context.q_physical_imag) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_poisson_ksp_setup_failed";
        destroy_all();
        return result;
    }
    PetscReal poisson_actual_rtol = 0.0;
    PetscReal poisson_actual_atol = 0.0;
    PetscReal poisson_actual_dtol = 0.0;
    PetscInt poisson_actual_max_iterations = 0;
    if (KSPGetTolerances(
            context.p_ksp,
            &poisson_actual_rtol,
            &poisson_actual_atol,
            &poisson_actual_dtol,
            &poisson_actual_max_iterations) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_poisson_ksp_tolerance_query_failed";
        destroy_all();
        return result;
    }
    (void)poisson_actual_dtol;
    result.poisson_ksp_rtol = static_cast<double>(poisson_actual_rtol);
    result.poisson_ksp_atol = static_cast<double>(poisson_actual_atol);
    result.poisson_ksp_max_iterations = poisson_actual_max_iterations > 0
        ? static_cast<int>(poisson_actual_max_iterations)
        : 0;
    if (MatCreateShell(
            PETSC_COMM_SELF,
            context.q_split_count,
            context.q_split_count,
            context.q_split_count,
            context.q_split_count,
            &context,
            &shell) != 0 ||
        MatShellSetOperation(
            shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(native_floquet_matmult)) != 0 ||
        EPSCreate(PETSC_COMM_SELF, &eps) != 0 ||
        EPSSetOperators(eps, shell, gyrotropic) != 0 ||
        EPSSetProblemType(eps, EPS_GNHEP) != 0 ||
        EPSSetType(eps, EPSKRYLOVSCHUR) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_configuration_failed";
        destroy_all();
        return result;
    }
    const PetscInt split_dimension = context.q_split_count;
    const PetscInt requested_pairs = std::max<PetscInt>(
        1,
        static_cast<PetscInt>(std::max(1, spectral_request.requested_mode_count) * 2));
    const PetscInt nev = std::min<PetscInt>(
        std::max<PetscInt>(1, split_dimension - 1), requested_pairs);
    ST spectral_transform = nullptr;
    KSP shifted_ksp = nullptr;
    PC shifted_pc = nullptr;
    const PetscReal eigen_tolerance = static_cast<PetscReal>(
        spectral_request.residual_tolerance > 0.0
            ? spectral_request.residual_tolerance
            : 1.0e-10);
    const PetscReal target_shift = static_cast<PetscReal>(
        omega_rad_s_from_frequency_hz(
            std::max(0.0, spectral_request.target_frequency_hz)));
    const PetscReal shifted_ksp_tolerance = std::max(
        static_cast<PetscReal>(1.0e-13),
        std::min(static_cast<PetscReal>(1.0e-8),
                 static_cast<PetscReal>(1.0e-3 * eigen_tolerance)));
    const PetscInt max_outer = spectral_request.max_outer_iterations > 0
        ? static_cast<PetscInt>(spectral_request.max_outer_iterations)
        : PETSC_DEFAULT;
    if (EPSSetDimensions(eps, nev, PETSC_DEFAULT, PETSC_DEFAULT) != 0 ||
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) != 0 ||
        EPSSetTarget(eps, static_cast<PetscScalar>(target_shift)) != 0 ||
        EPSSetTrueResidual(eps, PETSC_TRUE) != 0 ||
        EPSSetTolerances(eps, eigen_tolerance, max_outer) != 0 ||
        EPSGetST(eps, &spectral_transform) != 0 ||
        STSetType(spectral_transform, STSINVERT) != 0 ||
        // Keep the generalized shift-invert action matrix-free.  With the
        // default COPY mode PETSc tries to materialize shell - sigma*B;
        // the explicit rotated magnetic block below is only its safe
        // preconditioner and must not become the eigensolver operator.
        STSetMatMode(spectral_transform, ST_MATMODE_SHELL) != 0 ||
        STSetShift(spectral_transform, static_cast<PetscScalar>(target_shift)) != 0 ||
        !create_native_floquet_shifted_preconditioner(
            context.rotated_a_qq,
            gyrotropic,
            static_cast<PetscScalar>(target_shift),
            &shifted_preconditioner) ||
        // The explicit magnetic shifted pencil keeps the matrix-free Schur
        // action as the operator while giving GMRES a factored, nonzero
        // shifted block. A Jacobi diagonal is invalid here because the
        // real-frequency rotation puts the magnetic and gyrotropic terms in
        // off-diagonal real-split slots.
        STSetPreconditionerMat(spectral_transform, shifted_preconditioner) != 0 ||
        STGetKSP(spectral_transform, &shifted_ksp) != 0 ||
        KSPSetType(shifted_ksp, KSPGMRES) != 0 ||
        KSPGetPC(shifted_ksp, &shifted_pc) != 0 ||
        PCSetType(shifted_pc, PCLU) != 0 ||
        PCFactorReorderForNonzeroDiagonal(shifted_pc, 1.0e-12) != 0 ||
        PCFactorSetShiftType(shifted_pc, MAT_SHIFT_NONE) != 0 ||
        KSPSetTolerances(
            shifted_ksp,
            shifted_ksp_tolerance,
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            requested_linear_iterations) != 0 ||
        KSPSetErrorIfNotConverged(shifted_ksp, PETSC_TRUE) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, split_dimension, &xr) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, split_dimension, &xi) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_configuration_failed";
        destroy_all();
        return result;
    }
    PetscReal shifted_actual_rtol = 0.0;
    PetscReal shifted_actual_atol = 0.0;
    PetscReal shifted_actual_dtol = 0.0;
    PetscInt shifted_actual_max_iterations = 0;
    if (KSPGetTolerances(
            shifted_ksp,
            &shifted_actual_rtol,
            &shifted_actual_atol,
            &shifted_actual_dtol,
            &shifted_actual_max_iterations) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_shifted_ksp_tolerance_query_failed";
        destroy_all();
        return result;
    }
    (void)shifted_actual_dtol;
    result.ksp_rtol = static_cast<double>(shifted_actual_rtol);
    result.ksp_atol = static_cast<double>(shifted_actual_atol);
    result.ksp_max_iterations = shifted_actual_max_iterations > 0
        ? static_cast<int>(shifted_actual_max_iterations)
        : 0;

    if (EPSSolve(eps) != 0) {
        result.status = "solve_error";
        result.unsupported_reason =
            context.error_message[0] != '\0'
                ? "floquet_matshell_action_failed"
                : "floquet_slepc_solve_failed";
        destroy_all();
        return result;
    }

    // EPSGetIterationNumber/EPSGetConverged require PetscInt lvalues.  The
    // result fields are intentionally ABI-sized ints, so retrieve the values
    // again through local variables before candidate filtering.
    PetscInt outer_iterations = 0;
    PetscInt converged_eigenpair_count = 0;
    if (EPSGetIterationNumber(eps, &outer_iterations) != 0 ||
        EPSGetConverged(eps, &converged_eigenpair_count) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_convergence_query_failed";
        destroy_all();
        return result;
    }
    result.outer_iterations = static_cast<int>(outer_iterations);
    result.converged_eigenpair_count = static_cast<int>(converged_eigenpair_count);

    struct Candidate {
        SLEPcModalAcceptedMode mode{};
        double target_distance = 0.0;
    };
    std::vector<Candidate> candidates;
    candidates.reserve(static_cast<std::size_t>(
        std::max(1, spectral_request.requested_mode_count)));
    bool saw_positive_frequency = false;
    bool saw_window_candidate = false;
    bool saw_residual_rejection = false;
    bool saw_phi_failure = false;
    const bool filter_window = spectral_request.frequency_max_hz >
        spectral_request.frequency_min_hz && spectral_request.frequency_max_hz > 0.0;
    const double target_omega = omega_rad_s_from_frequency_hz(
        std::max(0.0, spectral_request.target_frequency_hz));
    for (PetscInt index = 0; index < converged_eigenpair_count; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal eps_residual = 0.0;
        if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != 0 ||
            EPSComputeError(eps, index, EPS_ERROR_RELATIVE, &eps_residual) != 0) {
            continue;
        }
        const double rotated_omega = static_cast<double>(PetscRealPart(kr));
        const double rotated_imaginary = static_cast<double>(PetscRealPart(ki));
        if (!std::isfinite(rotated_omega) || !std::isfinite(rotated_imaginary) ||
            std::abs(rotated_imaginary) >
                std::max(1.0e-8, 10.0 * static_cast<double>(eigen_tolerance)) *
                    std::max(1.0, std::abs(rotated_omega))) {
            continue;
        }
        // The native operator is rotated to the real-frequency pencil
        // (-i*phase_sign*A)q = omega*Bq.  Convert the real EPS value back to
        // the canonical descriptor eigenvalue lambda=i*phase_sign*omega
        // before applying the original residual and frequency map.
        const double lambda_real = 0.0;
        const double lambda_imag =
            static_cast<double>(context.phase_sign) * rotated_omega;
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda_real, lambda_imag},
            spectral_request.phase_convention);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        saw_positive_frequency = true;
        if (filter_window &&
            (kinematics.frequency_hz < spectral_request.frequency_min_hz ||
             kinematics.frequency_hz > spectral_request.frequency_max_hz)) {
            continue;
        }
        saw_window_candidate = true;
        std::vector<Complex> split_eigenvector;
        if (!copy_native_floquet_eigenvector(xr, xi, split_dimension, split_eigenvector)) {
            continue;
        }
        const std::vector<Complex> q = physical_complex_vector_from_split(
            split_eigenvector,
            operator_view.q_complex_dof_count);
        const double q_norm = complex_vector_norm(q);
        if (q.size() != static_cast<std::size_t>(operator_view.q_complex_dof_count) ||
            !std::isfinite(q_norm) ||
            !(q_norm > std::numeric_limits<double>::epsilon())) {
            continue;
        }
        std::vector<Complex> phi;
        if (!solve_native_floquet_phi_for_physical_mode(&context, xr, xi, phi)) {
            saw_phi_failure = true;
            continue;
        }
        const Complex lambda(lambda_real, lambda_imag);
        const double magnetic_residual = floquet_magnetic_residual(
            operator_view, q, phi, lambda);
        const double potential_residual = floquet_potential_residual(
            operator_view, q, phi);
        const double residual = std::max({
            static_cast<double>(eps_residual),
            magnetic_residual,
            potential_residual});
        if (!std::isfinite(residual) || residual > eigen_tolerance) {
            saw_residual_rejection = true;
            continue;
        }
        Candidate candidate{};
        // The native Schur residuals certify the reduced original complex
        // blocks.  Boundary seams, frame constraints, and the pre-Schur
        // reconstruction are intentionally outside this operator's scope;
        // keep the physical q/phi payload available without claiming a full
        // descriptor certificate.
        candidate.mode.floquet_descriptor_certified = false;
        candidate.mode.floquet_magnetic_residual = magnetic_residual;
        candidate.mode.floquet_potential_residual = potential_residual;
        candidate.mode.floquet_potential_real_split = std::move(phi);
        candidate.mode.eigenpair_index = static_cast<int>(index);
        candidate.mode.lambda_real = lambda_real;
        candidate.mode.lambda_imag = lambda_imag;
        candidate.mode.frequency_hz = kinematics.frequency_hz;
        candidate.mode.relative_residual = residual;
        candidate.mode.mode_vector = q;
        candidate.mode.floquet_mode_vector_physical_complex = true;
        candidate.target_distance =
            std::abs(kinematics.omega_rad_s - target_omega);
        candidates.push_back(std::move(candidate));
    }
    destroy_all();

    if (candidates.empty()) {
        result.status = "solve_error";
        if (!saw_positive_frequency) {
            result.unsupported_reason = "no_positive_frequency_eigenpair";
        } else if (filter_window && !saw_window_candidate) {
            result.unsupported_reason = "no_positive_frequency_eigenpair_in_window";
        } else if (saw_phi_failure) {
            result.unsupported_reason = "floquet_potential_reconstruction_failed";
        } else if (saw_residual_rejection) {
            result.unsupported_reason = "floquet_original_descriptor_residual_not_met";
        } else {
            result.unsupported_reason = "no_accepted_positive_frequency_mode";
        }
        return result;
    }
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const Candidate &left, const Candidate &right) {
            if (left.target_distance == right.target_distance) {
                return left.mode.frequency_hz < right.mode.frequency_hz;
            }
            return left.target_distance < right.target_distance;
        });
    const std::size_t accepted_limit = std::min<std::size_t>(
        candidates.size(),
        static_cast<std::size_t>(std::max(1, spectral_request.requested_mode_count)));
    candidates.resize(accepted_limit);
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const Candidate &left, const Candidate &right) {
            return left.mode.frequency_hz < right.mode.frequency_hz;
        });
    result.accepted_modes.reserve(candidates.size());
    for (std::size_t index = 0u; index < candidates.size(); ++index) {
        candidates[index].mode.positive_frequency_pair_index = static_cast<int>(index);
        result.max_relative_residual = std::max(
            result.max_relative_residual,
            candidates[index].mode.relative_residual);
        result.accepted_modes.push_back(std::move(candidates[index].mode));
    }
    result.accepted_mode_count = static_cast<int>(result.accepted_modes.size());
    const SLEPcModalAcceptedMode &first = result.accepted_modes.front();
    result.selected_eigenpair_index = first.eigenpair_index;
    result.lambda_real = first.lambda_real;
    result.lambda_imag = first.lambda_imag;
    result.frequency_hz = first.frequency_hz;
    result.relative_residual = first.relative_residual;
    result.ok = true;
    result.status = "ok";
    return result;
#endif
}

const char *floquet_modal_solver_model() noexcept
{
    return "floquet_real_frequency_slepc";
}

} // namespace fullmag::fem::frequency_domain
