#include "cpu/frequency_domain/slepc_modal_eigen.hpp"
#include "frequency_domain/mode_kinematics.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <utility>

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepceps.h>
#endif

namespace fullmag::fem::frequency_domain {

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace {

#if FULLMAG_FEM_WITH_SLEPC
std::mutex &slepc_modal_solver_mutex()
{
    static std::mutex mutex;
    return mutex;
}

struct QuarantinedSlepcModalGraph {
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    Mat stiffness = nullptr;
    Mat gyrotropic = nullptr;
    Mat rotated_stiffness = nullptr;
    Mat rotated_gyrotropic = nullptr;
    QuarantinedSlepcModalGraph *next = nullptr;
};

QuarantinedSlepcModalGraph *&slepc_modal_quarantine_head()
{
    // Deliberately retain this list for process lifetime. It stores opaque
    // handles only; no PETSc calls are made from static destruction.
    static QuarantinedSlepcModalGraph *head = nullptr;
    return head;
}

void quarantine_slepc_modal_objects(
    EPS eps,
    Vec xr,
    Vec xi,
    Mat stiffness,
    Mat gyrotropic,
    Mat rotated_stiffness = nullptr,
    Mat rotated_gyrotropic = nullptr) noexcept
{
    if (eps == nullptr && xr == nullptr && xi == nullptr && stiffness == nullptr &&
        gyrotropic == nullptr && rotated_stiffness == nullptr &&
        rotated_gyrotropic == nullptr) {
        return;
    }
    auto *entry = new (std::nothrow) QuarantinedSlepcModalGraph{
        eps,
        xr,
        xi,
        stiffness,
        gyrotropic,
        rotated_stiffness,
        rotated_gyrotropic,
        nullptr};
    if (entry == nullptr) {
        // Do not attempt cleanup on allocation failure. The live PETSc
        // objects remain allocated and cannot be reached for a later retry.
        return;
    }
    entry->next = slepc_modal_quarantine_head();
    slepc_modal_quarantine_head() = entry;
}

struct SlepcDestroyFailureContext {
    EPS *eps = nullptr;
    Vec *xr = nullptr;
    Vec *xi = nullptr;
    Mat *stiffness = nullptr;
    Mat *gyrotropic = nullptr;
    Mat *rotated_stiffness = nullptr;
    Mat *rotated_gyrotropic = nullptr;
    Mat retained_stiffness = nullptr;
    Mat retained_gyrotropic = nullptr;
};

void quarantine_failed_slepc_destroy_sequence(void *context)
{
    const auto *handles = static_cast<const SlepcDestroyFailureContext *>(context);
    if (handles == nullptr) {
        return;
    }
    quarantine_slepc_modal_objects(
        handles->eps != nullptr ? *handles->eps : nullptr,
        handles->xr != nullptr ? *handles->xr : nullptr,
        handles->xi != nullptr ? *handles->xi : nullptr,
        handles->stiffness != nullptr && *handles->stiffness != nullptr
            ? *handles->stiffness : handles->retained_stiffness,
        handles->gyrotropic != nullptr && *handles->gyrotropic != nullptr
            ? *handles->gyrotropic : handles->retained_gyrotropic,
        handles->rotated_stiffness != nullptr ? *handles->rotated_stiffness : nullptr,
        handles->rotated_gyrotropic != nullptr ? *handles->rotated_gyrotropic : nullptr);
}

bool destroy_slepc_vec(void *context)
{
    auto *handle = static_cast<Vec *>(context);
    if (handle == nullptr || *handle == nullptr) {
        return true;
    }
    if (VecDestroy(handle) != 0) {
        return false;
    }
    *handle = nullptr;
    return true;
}

bool destroy_slepc_eps(void *context)
{
    auto *handle = static_cast<EPS *>(context);
    if (handle == nullptr || *handle == nullptr) {
        return true;
    }
    if (EPSDestroy(handle) != 0) {
        return false;
    }
    *handle = nullptr;
    return true;
}

bool destroy_slepc_mat(void *context)
{
    auto *handle = static_cast<Mat *>(context);
    if (handle == nullptr || *handle == nullptr) {
        return true;
    }
    if (MatDestroy(handle) != 0) {
        return false;
    }
    *handle = nullptr;
    return true;
}

bool destroy_slepc_modal_objects(
    EPS *eps,
    Vec *xr,
    Vec *xi,
    Mat *stiffness,
    Mat *gyrotropic,
    Mat *rotated_stiffness = nullptr,
    Mat *rotated_gyrotropic = nullptr,
    Mat retained_stiffness = nullptr,
    Mat retained_gyrotropic = nullptr) noexcept
{
    SlepcDestroyFailureContext failure_context{
        eps, xr, xi, stiffness, gyrotropic, rotated_stiffness,
        rotated_gyrotropic, retained_stiffness, retained_gyrotropic};
    const SLEPcModalDestroyOperation operations[] = {
        {xr, destroy_slepc_vec},
        {xi, destroy_slepc_vec},
        {eps, destroy_slepc_eps},
        {stiffness, destroy_slepc_mat},
        {gyrotropic, destroy_slepc_mat},
        {rotated_stiffness, destroy_slepc_mat},
        {rotated_gyrotropic, destroy_slepc_mat},
    };
    return run_slepc_modal_destroy_sequence(
        operations,
        sizeof(operations) / sizeof(operations[0]),
        quarantine_failed_slepc_destroy_sequence,
        &failure_context);
}

void mark_slepc_graph_quarantined(
    SLEPcTinyGyrotropicModalEigenResult *result,
    const char *reason) noexcept
{
    if (result == nullptr) {
        return;
    }
    result->ok = false;
    result->status = "solve_error";
    result->unsupported_reason = reason;
    result->slepc_graph_quarantined = true;
    result->accepted_modes.clear();
    result->accepted_mode_count = 0;
    result->selected_eigenpair_index = -1;
    result->lambda_real = std::numeric_limits<double>::quiet_NaN();
    result->lambda_imag = std::numeric_limits<double>::quiet_NaN();
    result->frequency_hz = std::numeric_limits<double>::quiet_NaN();
    result->relative_residual = std::numeric_limits<double>::quiet_NaN();
}

std::vector<std::complex<double>> copy_slepc_eigenvector(
    Vec xr,
    Vec xi,
    int size,
    bool *query_failed)
{
    std::vector<std::complex<double>> vector;
    if (query_failed != nullptr) {
        *query_failed = false;
    }
    if (xr == nullptr || xi == nullptr || size <= 0) {
        return vector;
    }

    const PetscScalar *real_values = nullptr;
    const PetscScalar *imag_values = nullptr;
    bool graph_healthy = true;
    // If one array operation fails, leave any already-acquired view attached
    // to the quarantined graph rather than making another PETSc call.
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return VecGetArrayRead(xr, &real_values) == 0; })) {
        if (query_failed != nullptr) {
            *query_failed = true;
        }
        return vector;
    }
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return VecGetArrayRead(xi, &imag_values) == 0; })) {
        if (query_failed != nullptr) {
            *query_failed = true;
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

    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return VecRestoreArrayRead(xr, &real_values) == 0; })) {
        vector.clear();
        if (query_failed != nullptr) {
            *query_failed = true;
        }
        return vector;
    }
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return VecRestoreArrayRead(xi, &imag_values) == 0; })) {
        vector.clear();
        if (query_failed != nullptr) {
            *query_failed = true;
        }
    }
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
    PetscInt *base_size,
    bool *graph_quarantined,
    bool *cleanup_failed)
{
    if (stiffness == nullptr || gyrotropic == nullptr ||
        rotated_stiffness == nullptr || rotated_gyrotropic == nullptr ||
        base_size == nullptr || graph_quarantined == nullptr ||
        cleanup_failed == nullptr) {
        return false;
    }
    *graph_quarantined = false;
    *cleanup_failed = false;
    PetscInt stiffness_rows = 0;
    PetscInt stiffness_columns = 0;
    PetscInt gyrotropic_rows = 0;
    PetscInt gyrotropic_columns = 0;
    if (MatGetSize(stiffness, &stiffness_rows, &stiffness_columns) != 0) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic);
        *graph_quarantined = true;
        return false;
    }
    if (MatGetSize(gyrotropic, &gyrotropic_rows, &gyrotropic_columns) != 0) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic);
        *graph_quarantined = true;
        return false;
    }
    if (stiffness_rows <= 0 || stiffness_rows != stiffness_columns ||
        gyrotropic_rows != stiffness_rows || gyrotropic_columns != stiffness_columns ||
        stiffness_rows > std::numeric_limits<PetscInt>::max() / 2) {
        return false;
    }
    const PetscInt doubled_size = 2 * stiffness_rows;
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF, doubled_size, doubled_size, 0, nullptr,
            rotated_stiffness) != 0) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic,
            *rotated_stiffness, *rotated_gyrotropic);
        *graph_quarantined = true;
        return false;
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF, doubled_size, doubled_size, 0, nullptr,
            rotated_gyrotropic) != 0) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic,
            *rotated_stiffness, *rotated_gyrotropic);
        *graph_quarantined = true;
        return false;
    }
    if (MatSetOption(*rotated_stiffness, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0 ||
        MatSetOption(*rotated_gyrotropic, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic,
            *rotated_stiffness, *rotated_gyrotropic);
        *graph_quarantined = true;
        return false;
    }

    bool row_api_failed = false;
    const auto set_rotated_value = [&](Mat destination,
                                       PetscInt row,
                                       PetscInt column,
                                       PetscScalar value) {
        if (MatSetValue(destination, row, column, value, ADD_VALUES) != 0) {
            row_api_failed = true;
            return false;
        }
        return true;
    };
    auto copy_rows = [&](Mat source, Mat destination, bool rotate_gyrotropic) {
        for (PetscInt row = 0; row < stiffness_rows; ++row) {
            PetscInt entry_count = 0;
            const PetscInt *columns = nullptr;
            const PetscScalar *values = nullptr;
            if (MatGetRow(source, row, &entry_count, &columns, &values) != 0) {
                row_api_failed = true;
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
                        set_rotated_value(
                            destination, row, column,
                            static_cast<PetscScalar>(value)) &&
                        set_rotated_value(
                            destination, row + stiffness_rows,
                            column + stiffness_rows,
                            static_cast<PetscScalar>(value));
                } else {
                    // R(iG) = [[0, -G], [G, 0]] for A x = i*omega*G x.
                    valid =
                        set_rotated_value(
                            destination, row, column + stiffness_rows,
                            static_cast<PetscScalar>(-value)) &&
                        set_rotated_value(
                            destination, row + stiffness_rows, column,
                            static_cast<PetscScalar>(value));
                }
                if (!valid) {
                    break;
                }
            }
            if (row_api_failed) {
                // The partially written pencil and borrowed row remain in
                // the quarantined graph; do not call PETSc again after the
                // failed matrix operation.
                return false;
            }
            const PetscErrorCode restore_error =
                MatRestoreRow(source, row, &entry_count, &columns, &values);
            if (restore_error != 0) {
                row_api_failed = true;
                return false;
            }
            if (!valid) {
                return false;
            }
        }
        return true;
    };

    // SeqAIJ symbolic LU needs structural diagonal entries even when the
    // physical real-split pencil has exact zero diagonal values. ADD_VALUES
    // keeps the existing assembly mode and leaves the operator unchanged.
    const auto insert_zero_diagonal = [&](Mat destination) {
        for (PetscInt row = 0; row < doubled_size; ++row) {
            if (!set_rotated_value(
                    destination, row, row, static_cast<PetscScalar>(0.0))) {
                return false;
            }
        }
        return true;
    };
    const bool rows_copied = insert_zero_diagonal(*rotated_stiffness) &&
        insert_zero_diagonal(*rotated_gyrotropic) &&
        copy_rows(stiffness, *rotated_stiffness, false) &&
        copy_rows(gyrotropic, *rotated_gyrotropic, true);
    if (!rows_copied && row_api_failed) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic,
            *rotated_stiffness, *rotated_gyrotropic);
        *graph_quarantined = true;
        return false;
    }
    if (!rows_copied) {
        if (!destroy_slepc_modal_objects(
                nullptr, nullptr, nullptr, nullptr, nullptr,
                rotated_stiffness, rotated_gyrotropic)) {
            *graph_quarantined = true;
            *cleanup_failed = true;
        }
        return false;
    }
    if (MatAssemblyBegin(*rotated_stiffness, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*rotated_stiffness, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyBegin(*rotated_gyrotropic, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*rotated_gyrotropic, MAT_FINAL_ASSEMBLY) != 0) {
        quarantine_slepc_modal_objects(
            nullptr, nullptr, nullptr, stiffness, gyrotropic,
            *rotated_stiffness, *rotated_gyrotropic);
        *graph_quarantined = true;
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

struct SLEPcMassCsrEntry {
    std::uint32_t row = 0;
    std::uint32_t column = 0;
    double value = 0.0;
};

bool mass_entries_match_to_roundoff(double left, double right)
{
    const double scale = std::max(std::abs(left), std::abs(right));
    return std::abs(left - right) <=
        64.0 * std::numeric_limits<double>::epsilon() * scale;
}

bool dense_tangent_mass_is_symmetric_finite(
    const double *mass,
    std::size_t dimension)
{
    if (mass == nullptr || dimension == 0 ||
        dimension > std::numeric_limits<std::size_t>::max() / dimension) {
        return false;
    }
    const std::size_t value_count = dimension * dimension;
    for (std::size_t index = 0; index < value_count; ++index) {
        if (!std::isfinite(mass[index])) {
            return false;
        }
    }
    for (std::size_t row = 0; row < dimension; ++row) {
        if (!(mass[row * dimension + row] > 0.0)) {
            return false;
        }
        for (std::size_t column = row + 1; column < dimension; ++column) {
            if (!mass_entries_match_to_roundoff(
                    mass[row * dimension + column],
                    mass[column * dimension + row])) {
                return false;
            }
        }
    }
    return true;
}

bool csr_tangent_mass_is_symmetric_finite(
    const CsrMatrixView &mass,
    std::size_t dimension)
{
    if (dimension == 0 ||
        mass.row_count != dimension || mass.column_count != dimension ||
        mass.row_offsets == nullptr ||
        mass.row_offsets_len != mass.row_count + 1u ||
        mass.column_indices_len != mass.values_len ||
        mass.values_len == 0 ||
        mass.values_len > std::numeric_limits<std::uint32_t>::max() ||
        (mass.values_len > 0 &&
         (mass.column_indices == nullptr || mass.values == nullptr)) ||
        mass.row_offsets[0] != 0u ||
        mass.row_offsets[mass.row_count] != mass.values_len) {
        return false;
    }

    std::vector<SLEPcMassCsrEntry> entries;
    try {
        entries.reserve(static_cast<std::size_t>(mass.values_len));
        for (std::size_t row = 0; row < dimension; ++row) {
            const std::uint32_t row_begin = mass.row_offsets[row];
            const std::uint32_t row_end = mass.row_offsets[row + 1u];
            if (row_begin > row_end || row_end > mass.values_len) {
                return false;
            }
            for (std::uint32_t entry = row_begin; entry < row_end; ++entry) {
                const std::uint32_t column = mass.column_indices[entry];
                const double value = mass.values[entry];
                if (column >= dimension || !std::isfinite(value)) {
                    return false;
                }
                entries.push_back(SLEPcMassCsrEntry{
                    static_cast<std::uint32_t>(row), column, value});
            }
        }
    } catch (...) {
        return false;
    }
    std::sort(
        entries.begin(),
        entries.end(),
        [](const SLEPcMassCsrEntry &left, const SLEPcMassCsrEntry &right) {
            return left.row < right.row ||
                (left.row == right.row && left.column < right.column);
        });

    std::vector<SLEPcMassCsrEntry> coalesced;
    try {
        coalesced.reserve(entries.size());
        for (const SLEPcMassCsrEntry &entry : entries) {
            if (!coalesced.empty() &&
                coalesced.back().row == entry.row &&
                coalesced.back().column == entry.column) {
                coalesced.back().value += entry.value;
                if (!std::isfinite(coalesced.back().value)) {
                    return false;
                }
            } else {
                coalesced.push_back(entry);
            }
        }
    } catch (...) {
        return false;
    }

    std::vector<double> diagonal;
    try {
        diagonal.assign(dimension, 0.0);
    } catch (...) {
        return false;
    }
    for (const SLEPcMassCsrEntry &entry : coalesced) {
        if (entry.row == entry.column) {
            diagonal[entry.row] = entry.value;
        }
        const auto reverse = std::lower_bound(
            coalesced.begin(),
            coalesced.end(),
            std::pair<std::uint32_t, std::uint32_t>{entry.column, entry.row},
            [](const SLEPcMassCsrEntry &candidate,
               const std::pair<std::uint32_t, std::uint32_t> &key) {
                return candidate.row < key.first ||
                    (candidate.row == key.first && candidate.column < key.second);
            });
        const double reverse_value = reverse != coalesced.end() &&
                reverse->row == entry.column &&
                reverse->column == entry.row
            ? reverse->value
            : 0.0;
        if (!mass_entries_match_to_roundoff(entry.value, reverse_value)) {
            return false;
        }
    }
    for (double value : diagonal) {
        if (!(value > 0.0)) {
            return false;
        }
    }
    return true;
}

bool prepare_slepc_tangent_mass_action_internal(
    int tangent_dof_count,
    const double *dense_mass_row_major,
    const CsrMatrixView &csr_mass,
    SLEPcTangentMassActionContext *out_context)
{
    if (out_context == nullptr || tangent_dof_count <= 0) {
        return false;
    }
    const bool has_dense_mass = dense_mass_row_major != nullptr;
    const bool csr_mass_declared = csr_mass.row_count != 0 ||
        csr_mass.column_count != 0 || csr_mass.row_offsets != nullptr ||
        csr_mass.row_offsets_len != 0 || csr_mass.column_indices != nullptr ||
        csr_mass.column_indices_len != 0 || csr_mass.values != nullptr ||
        csr_mass.values_len != 0;
    if (has_dense_mass == csr_mass_declared) {
        return false;
    }

    const std::size_t dimension =
        static_cast<std::size_t>(tangent_dof_count);
    SLEPcTangentMassActionContext context{};
    context.dimension = dimension;
    if (has_dense_mass) {
        if (!dense_tangent_mass_is_symmetric_finite(
                dense_mass_row_major, dimension)) {
            return false;
        }
        context.dense_row_major = dense_mass_row_major;
    } else {
        if (!csr_tangent_mass_is_symmetric_finite(csr_mass, dimension)) {
            return false;
        }
        context.csr = csr_mass;
        context.sparse = true;
    }
    context.validated = true;
    *out_context = context;
    return true;
}

bool csr_matrix_views_match(
    const CsrMatrixView &left,
    const CsrMatrixView &right)
{
    return left.row_count == right.row_count &&
        left.column_count == right.column_count &&
        left.row_offsets == right.row_offsets &&
        left.row_offsets_len == right.row_offsets_len &&
        left.column_indices == right.column_indices &&
        left.column_indices_len == right.column_indices_len &&
        left.values == right.values &&
        left.values_len == right.values_len;
}

bool tangent_mass_context_matches_request(
    const SLEPcTangentMassActionContext &context,
    const SLEPcTinyGyrotropicModalEigenRequest &request)
{
    if (!context.validated ||
        context.dimension != static_cast<std::size_t>(
            std::max(0, request.tangent_dof_count))) {
        return false;
    }
    if (context.sparse) {
        return request.tangent_mass_matrix_row_major == nullptr &&
            csr_matrix_views_match(context.csr, request.tangent_mass_csr);
    }
    const CsrMatrixView empty_csr{};
    return request.tangent_mass_matrix_row_major == context.dense_row_major &&
        csr_matrix_views_match(empty_csr, request.tangent_mass_csr);
}

bool apply_slepc_tangent_mass_action(
    const void *raw_context,
    const std::complex<double> *input,
    std::complex<double> *output,
    std::size_t dof_count)
{
    if (raw_context == nullptr || input == nullptr || output == nullptr) {
        return false;
    }
    const auto *context =
        static_cast<const SLEPcTangentMassActionContext *>(raw_context);
    if (!context->validated || context->dimension != dof_count || dof_count == 0) {
        return false;
    }
    std::fill(output, output + dof_count, std::complex<double>{0.0, 0.0});
    if (!context->sparse) {
        if (context->dense_row_major == nullptr ||
            dof_count > std::numeric_limits<std::size_t>::max() / dof_count) {
            return false;
        }
        for (std::size_t row = 0; row < dof_count; ++row) {
            for (std::size_t column = 0; column < dof_count; ++column) {
                output[row] +=
                    context->dense_row_major[row * dof_count + column] *
                    input[column];
            }
        }
        return true;
    }

    const CsrMatrixView &mass = context->csr;
    for (std::size_t row = 0; row < dof_count; ++row) {
        const std::uint32_t row_begin = mass.row_offsets[row];
        const std::uint32_t row_end = mass.row_offsets[row + 1u];
        for (std::uint32_t entry = row_begin; entry < row_end; ++entry) {
            output[row] += mass.values[entry] *
                input[mass.column_indices[entry]];
        }
    }
    return true;
}

#if FULLMAG_FEM_WITH_SLEPC
SLEPcTinyGyrotropicModalEigenResult solve_slepc_gyrotropic_modal_eigen_attempt(
    const SLEPcTinyGyrotropicModalEigenRequest &request,
    Mat stiffness,
    Mat gyrotropic,
    const SLEPcTangentMassActionContext &mass_action_context,
    PetscInt attempt_nev,
    PetscInt attempt_ncv,
    PetscInt attempt_mpd,
    PetscInt attempt_max_iterations) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    Mat rotated_stiffness = nullptr;
    Mat rotated_gyrotropic = nullptr;
    const auto cleanup_attempt_graph = [&]() {
        if (destroy_slepc_modal_objects(
                &eps,
                &xr,
                &xi,
                nullptr,
                nullptr,
                &rotated_stiffness,
                &rotated_gyrotropic,
                stiffness,
                gyrotropic)) {
            return true;
        }
        mark_slepc_graph_quarantined(&result, "slepc_cleanup_failed");
        return false;
    };
    const auto quarantine_attempt_graph = [&](const char *reason) {
        quarantine_slepc_modal_objects(
            eps,
            xr,
            xi,
            stiffness,
            gyrotropic,
            rotated_stiffness,
            rotated_gyrotropic);
        mark_slepc_graph_quarantined(&result, reason);
    };
    PetscInt rotated_size = 0;
    bool creation_graph_quarantined = false;
    bool creation_cleanup_failed = false;
    if (!create_real_frequency_rotated_pencil(
            stiffness,
            gyrotropic,
            &rotated_stiffness,
            &rotated_gyrotropic,
            &rotated_size,
            &creation_graph_quarantined,
            &creation_cleanup_failed)) {
        result.status = "solve_error";
        result.unsupported_reason = creation_cleanup_failed
            ? "slepc_cleanup_failed"
            : "real_frequency_rotated_pencil_creation_failed";
        if (creation_graph_quarantined) {
            quarantine_slepc_modal_objects(
                nullptr, nullptr, nullptr, stiffness, gyrotropic);
            result.slepc_graph_quarantined = true;
            return result;
        }
        if (rotated_stiffness != nullptr || rotated_gyrotropic != nullptr) {
            if (!cleanup_attempt_graph()) {
                return result;
            }
        }
        return result;
    }
    const int size = request.tangent_dof_count;
    if (rotated_size != static_cast<PetscInt>(2) * static_cast<PetscInt>(size)) {
        result.status = "solve_error";
        result.unsupported_reason = "real_frequency_rotated_pencil_size_mismatch";
        if (!cleanup_attempt_graph()) {
            return result;
        }
        return result;
    }

    ST spectral_transform = nullptr;
    const double target_angular_frequency =
        omega_rad_s_from_frequency_hz(std::max(0.0, request.target_frequency_hz));
    const PetscInt max_iterations = attempt_max_iterations > 0
        ? attempt_max_iterations
        : PETSC_DEFAULT;
    const PetscInt max_linear_iterations =
        request.max_linear_iterations > 0 ? request.max_linear_iterations : PETSC_DEFAULT;
    const PetscReal tolerance =
        request.residual_tolerance > 0.0 ? request.residual_tolerance : 1.0e-10;
    const PetscReal ksp_rtol = std::min(0.01 * tolerance, 1.0e-10);
    const PetscReal ksp_atol = 1.0e-14;
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
    if (MatNorm(rotated_stiffness, NORM_INFINITY, &stiffness_norm) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_norm_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (MatNorm(rotated_gyrotropic, NORM_INFINITY, &gyrotropic_norm) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_norm_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (!std::isfinite(static_cast<double>(stiffness_norm)) ||
        !std::isfinite(static_cast<double>(gyrotropic_norm))) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_norm_failed";
        if (!cleanup_attempt_graph()) {
            return result;
        }
        return result;
    }
    const PetscReal raw_operator_scale =
        stiffness_norm +
        std::abs(static_cast<PetscReal>(target_shift)) * gyrotropic_norm;
    if (!(raw_operator_scale > 0.0) ||
        !std::isfinite(static_cast<double>(raw_operator_scale))) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_zero_scale";
        if (!cleanup_attempt_graph()) {
            return result;
        }
        return result;
    }
    const PetscReal operator_normalization_scale = 1.0 / raw_operator_scale;
    if (!std::isfinite(static_cast<double>(operator_normalization_scale)) ||
        operator_normalization_scale <= 0.0) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_normalization_failed";
        if (!cleanup_attempt_graph()) {
            return result;
        }
        return result;
    }
    if (MatScale(rotated_stiffness, operator_normalization_scale) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_normalization_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (MatScale(rotated_gyrotropic, operator_normalization_scale) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "modal_operator_normalization_failed";
        quarantine_attempt_graph(result.unsupported_reason);
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

    const bool configured =
        EPSCreate(PETSC_COMM_SELF, &eps) == 0 &&
        EPSSetOperators(eps, rotated_stiffness, rotated_gyrotropic) == 0 &&
        EPSSetProblemType(eps, EPS_GNHEP) == 0 &&
        EPSSetType(eps, EPSKRYLOVSCHUR) == 0 &&
        EPSSetDimensions(eps, attempt_nev, attempt_ncv, attempt_mpd) == 0 &&
        EPSGetST(eps, &spectral_transform) == 0 &&
        STSetType(spectral_transform, STSINVERT) == 0 &&
        STSetShift(spectral_transform, static_cast<PetscScalar>(target_shift)) == 0 &&
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) == 0 &&
        EPSSetTarget(eps, static_cast<PetscScalar>(target_shift)) == 0 &&
        EPSSetTolerances(eps, tolerance, max_iterations) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, rotated_size, &xr) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, rotated_size, &xi) == 0;
    if (!configured) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_configuration_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    KSP ksp = nullptr;
    PC pc = nullptr;
    const bool ksp_configured =
        STGetKSP(spectral_transform, &ksp) == 0 &&
        KSPSetType(ksp, KSPPREONLY) == 0 &&
        KSPGetPC(ksp, &pc) == 0 &&
        PCSetType(pc, PCLU) == 0 &&
        // Let PETSc reorder for nonzero pivots without perturbing operator values.
        PCFactorReorderForNonzeroDiagonal(pc, PETSC_DECIDE) == 0 &&
        PCFactorSetShiftType(pc, MAT_SHIFT_NONZERO) == 0 &&
        PCFactorSetShiftAmount(pc, factorization_shift) == 0 &&
        KSPSetTolerances(
            ksp,
            ksp_rtol,
            ksp_atol,
            PETSC_DEFAULT,
            max_linear_iterations) == 0 &&
        KSPSetErrorIfNotConverged(ksp, PETSC_TRUE) == 0;
    if (!ksp_configured) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_configuration_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (EPSSetUp(eps) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_configuration_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    result.ksp_rtol = static_cast<double>(ksp_rtol);
    result.ksp_atol = static_cast<double>(ksp_atol);
    bool graph_healthy = true;
    PetscInt resolved_nev = 0;
    PetscInt resolved_ncv = 0;
    PetscInt resolved_mpd = 0;
    PetscReal resolved_eps_tolerance = 0.0;
    PetscInt resolved_eps_max_iterations = 0;
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() {
                return EPSGetDimensions(
                           eps, &resolved_nev, &resolved_ncv, &resolved_mpd) == 0;
            })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_dimension_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() {
                return EPSGetTolerances(
                           eps,
                           &resolved_eps_tolerance,
                           &resolved_eps_max_iterations) == 0;
            })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_dimension_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (resolved_nev != attempt_nev ||
        resolved_ncv <= 0 || resolved_mpd <= 0 ||
        resolved_eps_max_iterations <= 0 ||
        !std::isfinite(static_cast<double>(resolved_eps_tolerance)) ||
        resolved_eps_tolerance != tolerance ||
        (attempt_ncv > 0 && resolved_ncv != attempt_ncv) ||
        (attempt_mpd > 0 && resolved_mpd != attempt_mpd) ||
        (attempt_max_iterations > 0 &&
         resolved_eps_max_iterations != attempt_max_iterations)) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solver_dimension_query_failed";
        if (!cleanup_attempt_graph()) {
            return result;
        }
        return result;
    }
    result.eps_dimensions_available = true;
    result.eps_nev = static_cast<int>(resolved_nev);
    result.eps_ncv = static_cast<int>(resolved_ncv);
    result.eps_mpd = static_cast<int>(resolved_mpd);
    result.max_outer_iterations = static_cast<int>(
        std::min<PetscInt>(resolved_eps_max_iterations,
                           std::numeric_limits<int>::max()));
    result.eps_iteration_budget_available = true;
    PetscReal resolved_ksp_rtol = 0.0;
    PetscReal resolved_ksp_atol = 0.0;
    PetscReal resolved_ksp_dtol = 0.0;
    PetscInt resolved_ksp_max_iterations = 0;
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() {
                return KSPGetTolerances(
                           ksp,
                           &resolved_ksp_rtol,
                           &resolved_ksp_atol,
                           &resolved_ksp_dtol,
                           &resolved_ksp_max_iterations) == 0;
            })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_ksp_tolerance_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    result.ksp_rtol = static_cast<double>(resolved_ksp_rtol);
    result.ksp_atol = static_cast<double>(resolved_ksp_atol);
    result.ksp_max_iterations = static_cast<int>(
        std::max<PetscInt>(0, resolved_ksp_max_iterations));

    PetscInt outer_iterations = 0;
    PetscInt linear_iterations = 0;
    PetscReal ksp_final_residual = 0.0;
    PetscInt converged_eigenpair_count = 0;
    EPSConvergedReason converged_reason = EPS_CONVERGED_ITERATING;
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return EPSSolve(eps) == 0; })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_solve_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return EPSGetIterationNumber(eps, &outer_iterations) == 0; })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_iteration_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return EPSGetConverged(eps, &converged_eigenpair_count) == 0; })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_converged_count_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return EPSGetConvergedReason(eps, &converged_reason) == 0; })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_converged_reason_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    result.eps_converged_reason_available = true;
    result.eps_converged_reason = static_cast<int>(converged_reason);
    result.eps_solved_attempt_count = 1;
    result.eps_cumulative_iterations_available = true;
    result.outer_iterations = static_cast<int>(outer_iterations);
    result.converged_eigenpair_count = static_cast<int>(converged_eigenpair_count);
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return KSPGetIterationNumber(ksp, &linear_iterations) == 0; })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_ksp_iteration_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    result.linear_iterations_total = static_cast<int>(linear_iterations);
    if (!run_slepc_modal_graph_operation(
            &graph_healthy,
            [&]() { return KSPGetResidualNorm(ksp, &ksp_final_residual) == 0; })) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_ksp_residual_query_failed";
        quarantine_attempt_graph(result.unsupported_reason);
        return result;
    }
    if (std::isfinite(static_cast<double>(ksp_final_residual))) {
        result.ksp_final_residual = static_cast<double>(ksp_final_residual);
    }

    std::vector<SLEPcModalAcceptedMode> accepted_candidates;
    accepted_candidates.reserve(static_cast<std::size_t>(
        requested_positive_mode_count(request)));
    bool saw_positive_frequency = false;
    bool saw_frequency_window_candidate = false;
    bool saw_residual_rejection = false;
    bool saw_non_real_rotated_eigenvalue = false;
    const bool filter_frequency_window = has_frequency_window(request);
    for (int index = 0; index < result.converged_eigenpair_count; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal relative_residual = 0.0;
        if (!run_slepc_modal_graph_operation(
                &graph_healthy,
                [&]() { return EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) == 0; })) {
            result.status = "solve_error";
            result.unsupported_reason = "slepc_eigenpair_query_failed";
            quarantine_attempt_graph(result.unsupported_reason);
            return result;
        }
        if (!run_slepc_modal_graph_operation(
                &graph_healthy,
                [&]() {
                    return EPSComputeError(
                               eps, index, EPS_ERROR_RELATIVE,
                               &relative_residual) == 0;
                })) {
            result.status = "solve_error";
            result.unsupported_reason = "slepc_eigenpair_error_query_failed";
            quarantine_attempt_graph(result.unsupported_reason);
            return result;
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
        SLEPcModalAcceptedMode candidate{};
        candidate.eigenpair_index = index;
        candidate.lambda_real = lambda_real;
        candidate.lambda_imag = lambda_imag;
        candidate.frequency_hz = kinematics.frequency_hz;
        candidate.relative_residual = static_cast<double>(relative_residual);
        bool vector_query_failed = false;
        const std::vector<std::complex<double>> rotated_mode =
            copy_slepc_eigenvector(
                xr,
                xi,
                static_cast<int>(rotated_size),
                &vector_query_failed);
        if (vector_query_failed) {
            result.status = "solve_error";
            result.unsupported_reason = "slepc_eigenvector_query_failed";
            quarantine_attempt_graph(result.unsupported_reason);
            return result;
        }
        if (rotated_mode.size() != static_cast<std::size_t>(rotated_size)) {
            continue;
        }
        candidate.mode_vector.resize(static_cast<std::size_t>(size));
        for (int component = 0; component < size; ++component) {
            candidate.mode_vector[static_cast<std::size_t>(component)] =
                rotated_mode[static_cast<std::size_t>(component)] +
                std::complex<double>(0.0, 1.0) *
                    rotated_mode[static_cast<std::size_t>(size + component)];
        }
        if (candidate.mode_vector.size() != static_cast<std::size_t>(size)) {
            continue;
        }
        accepted_candidates.push_back(std::move(candidate));
    }

    if (!cleanup_attempt_graph()) {
        return result;
    }

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
    const SLEPcModalCandidateFinalization finalization =
        finalize_slepc_modal_candidates_with_mass(
            accepted_candidates,
            static_cast<std::size_t>(request.tangent_dof_count),
            apply_slepc_tangent_mass_action,
            &mass_action_context,
            kSLEPcModalDedupFrequencyRelativeTolerance,
            kSLEPcModalDedupFrequencyAbsoluteToleranceHz,
            kSLEPcModalDedupOverlapThreshold,
            request.target_frequency_hz,
            request.requested_mode_count,
            SLEPcModalCandidateSelection::nearest_target);
    if (!finalization.success) {
        result.status = "solve_error";
        result.unsupported_reason =
            finalization.deduplication_status == ModalDeduplicationStatus::invalid_metric
                ? "invalid_tangent_mass_metric"
                : finalization.deduplication_status ==
                        ModalDeduplicationStatus::mass_action_failed
                    ? "tangent_mass_action_failed"
                    : "modal_candidate_finalization_failed";
        return result;
    }
    result.accepted_modes = finalization.accepted_modes;
    for (const SLEPcModalAcceptedMode &mode : result.accepted_modes) {
        result.max_relative_residual = std::max(
            result.max_relative_residual,
            mode.relative_residual);
    }
    result.accepted_mode_count = static_cast<int>(result.accepted_modes.size());
    result.eps_attempt_count = 1;
    result.eps_finalized_attempt_number = 1;
    result.eps_initial_nev = result.eps_nev;
    result.eps_finalized_nev = result.eps_nev;
    result.eps_unique_certified_mode_count = static_cast<int>(std::min<std::size_t>(
        finalization.unique_candidate_count_before_cap,
        static_cast<std::size_t>(std::numeric_limits<int>::max())));
    if (result.accepted_modes.empty()) {
        result.status = "solve_error";
        result.unsupported_reason = "no_accepted_positive_frequency_mode";
        return result;
    }
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

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_gyrotropic_modal_eigen_with_matrices(
    const SLEPcTinyGyrotropicModalEigenRequest &request,
    Mat stiffness,
    Mat gyrotropic) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    SLEPcTangentMassActionContext local_mass_action_context{};
    const SLEPcTangentMassActionContext *mass_action_context =
        request.tangent_mass_action_context;
    if (mass_action_context == nullptr) {
        if (!prepare_slepc_tangent_mass_action_internal(
                request.tangent_dof_count,
                request.tangent_mass_matrix_row_major,
                request.tangent_mass_csr,
                &local_mass_action_context)) {
            result.status = "validation_error";
            result.unsupported_reason = "missing_or_invalid_modal_tangent_mass";
            return result;
        }
        mass_action_context = &local_mass_action_context;
    } else if (!tangent_mass_context_matches_request(
                   *mass_action_context, request)) {
        result.status = "validation_error";
        result.unsupported_reason = "modal_tangent_mass_context_mismatch";
        return result;
    }
    if (request.tangent_dof_count <= 0 ||
        static_cast<PetscInt>(request.tangent_dof_count) >
            std::numeric_limits<PetscInt>::max() / 2) {
        result.status = "validation_error";
        result.unsupported_reason = "invalid_tangent_dof_count";
        return result;
    }

    const PetscInt split_dimension =
        static_cast<PetscInt>(2) * request.tangent_dof_count;
    const PetscInt requested_positive_modes = static_cast<PetscInt>(
        requested_positive_mode_count(request));
    const PetscInt requested_split_modes =
        requested_positive_modes > split_dimension / 2
            ? split_dimension
            : static_cast<PetscInt>(2 * requested_positive_modes);
    // Krylov-Schur needs at least one search direction beyond NEV. Keep the
    // first request inside the absolute real-split dimension bound; the
    // resolved NCV/MPD bounds are applied after the first EPS setup.
    const PetscInt initial_nev = std::min<PetscInt>(
        split_dimension - 1,
        std::max<PetscInt>(1, requested_split_modes));
    PetscInt current_nev = initial_nev;
    PetscInt initial_ncv = PETSC_DEFAULT;
    PetscInt initial_mpd = PETSC_DEFAULT;
    PetscInt total_outer_iteration_budget = 0;
    PetscInt cumulative_outer_iterations = 0;
    int solved_attempt_count = 0;
    int attempt_count = 0;
    PetscInt attempt_max_iterations = request.max_outer_iterations > 0
        ? static_cast<PetscInt>(request.max_outer_iterations)
        : PETSC_DEFAULT;

    for (;;) {
        ++attempt_count;
        SLEPcTinyGyrotropicModalEigenResult attempt =
            solve_slepc_gyrotropic_modal_eigen_attempt(
                request,
                stiffness,
                gyrotropic,
                *mass_action_context,
                current_nev,
                initial_ncv,
                initial_mpd,
                attempt_max_iterations);
        attempt.eps_attempt_count = attempt_count;
        attempt.eps_initial_nev = static_cast<int>(initial_nev);
        if (attempt_count > 1) {
            attempt.eps_initial_ncv = static_cast<int>(initial_ncv);
            attempt.eps_initial_mpd = static_cast<int>(initial_mpd);
        }
        attempt.eps_solved_attempt_count = solved_attempt_count +
            (attempt.eps_solved_attempt_count > 0 ? 1 : 0);
        if (attempt.slepc_graph_quarantined) {
            attempt.ok = false;
            attempt.status = "solve_error";
            attempt.accepted_modes.clear();
            attempt.accepted_mode_count = 0;
            return attempt;
        }
        if (!attempt.eps_cumulative_iterations_available) {
            attempt.outer_iterations = static_cast<int>(
                std::min<PetscInt>(cumulative_outer_iterations,
                                   std::numeric_limits<int>::max()));
            attempt.eps_iteration_budget_available =
                total_outer_iteration_budget > 0;
            attempt.max_outer_iterations = static_cast<int>(
                std::min<PetscInt>(total_outer_iteration_budget,
                                   std::numeric_limits<int>::max()));
            return attempt;
        }
        solved_attempt_count = attempt.eps_solved_attempt_count;

        if (attempt_count == 1) {
            if (attempt.max_outer_iterations <= 0 ||
                !attempt.eps_dimensions_available ||
                attempt.eps_ncv <= 0 || attempt.eps_mpd <= 0) {
                attempt.ok = false;
                attempt.status = "solve_error";
                attempt.unsupported_reason = "slepc_refill_limits_unavailable";
                return attempt;
            }
            total_outer_iteration_budget = attempt.max_outer_iterations;
            initial_ncv = attempt.eps_ncv;
            initial_mpd = attempt.eps_mpd;
            attempt.eps_initial_ncv = static_cast<int>(initial_ncv);
            attempt.eps_initial_mpd = static_cast<int>(initial_mpd);
        } else if (attempt.eps_ncv != initial_ncv ||
                   attempt.eps_mpd != initial_mpd ||
                   attempt.max_outer_iterations != attempt_max_iterations) {
            attempt.ok = false;
            attempt.status = "solve_error";
            attempt.unsupported_reason = "slepc_refill_policy_changed";
            return attempt;
        }

        const PetscInt attempt_iterations = attempt.outer_iterations;
        if (attempt_iterations < 0 ||
            cumulative_outer_iterations > total_outer_iteration_budget ||
            attempt_iterations >
                total_outer_iteration_budget - cumulative_outer_iterations) {
            attempt.ok = false;
            attempt.status = "solve_error";
            attempt.unsupported_reason = "slepc_refill_iteration_budget_exceeded";
            attempt.eps_cumulative_iterations_available = false;
            return attempt;
        }
        cumulative_outer_iterations += attempt_iterations;
        attempt.outer_iterations = static_cast<int>(std::min<PetscInt>(
            cumulative_outer_iterations,
            std::numeric_limits<int>::max()));
        attempt.max_outer_iterations = static_cast<int>(std::min<PetscInt>(
            total_outer_iteration_budget,
            std::numeric_limits<int>::max()));
        attempt.eps_cumulative_iterations_available = true;
        attempt.eps_iteration_budget_available = true;
        if (attempt.eps_finalized_attempt_number > 0) {
            attempt.eps_finalized_attempt_number = attempt_count;
            attempt.eps_finalized_nev = attempt.eps_nev;
        }

        const int accepted_count = attempt.accepted_mode_count;
        const int requested_count = requested_positive_mode_count(request);
        const bool candidate_pool_available =
            attempt.frequency_window_candidate_count > 0 ||
            attempt.residual_rejection_count > 0;
        const bool eps_converged = attempt.eps_converged_reason_available &&
            attempt.eps_converged_reason > 0 &&
            attempt.eps_converged_reason != EPS_CONVERGED_USER;
        const bool budget_exhausted =
            attempt.eps_converged_reason == EPS_DIVERGED_ITS ||
            cumulative_outer_iterations >= total_outer_iteration_budget;
        attempt.eps_outer_iteration_budget_exhausted = budget_exhausted;
        const PetscInt legal_nev_cap = split_dimension > 1 &&
                initial_ncv > 1 && initial_mpd > 0
            ? std::min<PetscInt>(
                split_dimension - 1,
                std::min<PetscInt>(initial_ncv - 1, initial_mpd))
            : 0;
        const bool dimension_exhausted = current_nev >= legal_nev_cap;

        if (attempt.ok && accepted_count >= requested_count && eps_converged) {
            attempt.status = "ok";
            attempt.unsupported_reason = "";
            return attempt;
        }
        if (attempt.eps_converged_reason_available &&
            attempt.eps_converged_reason < 0 &&
            attempt.eps_converged_reason != EPS_DIVERGED_ITS) {
            attempt.ok = false;
            attempt.status = "solve_error";
            attempt.unsupported_reason = "slepc_eps_stopped_without_convergence";
            return attempt;
        }

        const char *attempt_failure_reason =
            attempt.unsupported_reason != nullptr
                ? attempt.unsupported_reason : "";
        if (std::strcmp(attempt_failure_reason, "invalid_tangent_mass_metric") == 0 ||
            std::strcmp(attempt_failure_reason, "tangent_mass_action_failed") == 0 ||
            std::strcmp(attempt_failure_reason, "modal_candidate_finalization_failed") == 0) {
            // A failed declared metric/finalizer is not evidence that more
            // eigenpairs could repair the candidate pool. Never retry it.
            return attempt;
        }

        if (candidate_pool_available && accepted_count < requested_count &&
            eps_converged && !budget_exhausted && !dimension_exhausted) {
            const PetscInt next_nev = current_nev > legal_nev_cap / 2
                ? legal_nev_cap
                : static_cast<PetscInt>(2 * current_nev);
            if (next_nev > current_nev &&
                next_nev <= legal_nev_cap &&
                next_nev < initial_ncv &&
                next_nev <= initial_mpd &&
                next_nev < split_dimension) {
                current_nev = next_nev;
                attempt_max_iterations = total_outer_iteration_budget -
                    cumulative_outer_iterations;
                continue;
            }
        }

        if (accepted_count == 0 && !candidate_pool_available) {
            return attempt;
        }

        attempt.ok = false;
        attempt.status = "partial";
        attempt.unsupported_reason = budget_exhausted
            ? "slepc_modal_nev_refill_outer_iteration_budget_exhausted"
            : dimension_exhausted
                ? "slepc_modal_nev_refill_dimension_limit_reached"
                : "slepc_modal_nev_refill_insufficient_certified_modes";
        return attempt;
    }
}
#endif

bool finite_modal_value(const std::complex<double> &value)
{
    return std::isfinite(value.real()) && std::isfinite(value.imag());
}

ModalDeduplicationStatus validate_slepc_candidate_mass_gram(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t dimension,
    ModalMassAction mass_action,
    const void *mass_action_context)
{
    const std::size_t candidate_count = candidates.size();
    if (dimension == 0 || mass_action == nullptr ||
        (candidate_count != 0 &&
         candidate_count > std::numeric_limits<std::size_t>::max() /
             candidate_count)) {
        return ModalDeduplicationStatus::invalid_parameters;
    }
    if (candidate_count == 0) {
        return ModalDeduplicationStatus::success;
    }

    struct NormalizedMassCandidate {
        std::vector<std::complex<double>> mode;
        std::vector<std::complex<double>> mass_applied_mode;
    };
    std::vector<NormalizedMassCandidate> normalized;
    normalized.reserve(candidate_count);
    for (const SLEPcModalAcceptedMode &candidate : candidates) {
        if (!std::isfinite(candidate.frequency_hz) ||
            !std::isfinite(candidate.relative_residual) ||
            candidate.relative_residual < 0.0 ||
            candidate.mode_vector.size() != dimension) {
            return ModalDeduplicationStatus::invalid_candidate;
        }

        double input_scale = 0.0;
        for (const std::complex<double> &value : candidate.mode_vector) {
            if (!finite_modal_value(value)) {
                return ModalDeduplicationStatus::invalid_candidate;
            }
            input_scale = std::max(
                input_scale,
                std::max(std::abs(value.real()), std::abs(value.imag())));
        }
        if (!(input_scale > 0.0) || !std::isfinite(input_scale)) {
            return ModalDeduplicationStatus::invalid_candidate;
        }

        std::vector<std::complex<double>> scaled_mode(dimension);
        std::vector<std::complex<double>> scaled_mass_applied(
            dimension,
            std::complex<double>{std::numeric_limits<double>::quiet_NaN(),
                                 std::numeric_limits<double>::quiet_NaN()});
        for (std::size_t index = 0; index < dimension; ++index) {
            scaled_mode[index] = candidate.mode_vector[index] / input_scale;
        }
        if (!mass_action(
                mass_action_context,
                scaled_mode.data(),
                scaled_mass_applied.data(),
                dimension)) {
            return ModalDeduplicationStatus::mass_action_failed;
        }

        std::complex<double> self_product{0.0, 0.0};
        double absolute_term_sum = 0.0;
        for (std::size_t index = 0; index < dimension; ++index) {
            if (!finite_modal_value(scaled_mass_applied[index])) {
                return ModalDeduplicationStatus::invalid_metric;
            }
            const std::complex<double> term =
                std::conj(scaled_mode[index]) * scaled_mass_applied[index];
            if (!finite_modal_value(term)) {
                return ModalDeduplicationStatus::invalid_metric;
            }
            self_product += term;
            absolute_term_sum += std::abs(term);
            if (!finite_modal_value(self_product) ||
                !std::isfinite(absolute_term_sum)) {
                return ModalDeduplicationStatus::invalid_metric;
            }
        }
        const double dot_tolerance =
            64.0 * std::numeric_limits<double>::epsilon() *
            static_cast<double>(std::max<std::size_t>(1, dimension));
        const double self_scale =
            std::max(std::abs(self_product.real()), absolute_term_sum);
        if (!(self_product.real() > 0.0) ||
            !std::isfinite(self_product.real()) ||
            std::abs(self_product.imag()) > dot_tolerance * self_scale) {
            return ModalDeduplicationStatus::invalid_metric;
        }
        const double mass_norm = std::sqrt(self_product.real());
        if (!(mass_norm > 0.0) || !std::isfinite(mass_norm)) {
            return ModalDeduplicationStatus::invalid_metric;
        }

        NormalizedMassCandidate normalized_candidate{};
        normalized_candidate.mode.resize(dimension);
        normalized_candidate.mass_applied_mode.resize(dimension);
        for (std::size_t index = 0; index < dimension; ++index) {
            normalized_candidate.mode[index] = scaled_mode[index] / mass_norm;
            normalized_candidate.mass_applied_mode[index] =
                scaled_mass_applied[index] / mass_norm;
            if (!finite_modal_value(normalized_candidate.mode[index]) ||
                !finite_modal_value(normalized_candidate.mass_applied_mode[index])) {
                return ModalDeduplicationStatus::invalid_metric;
            }
        }
        normalized.push_back(std::move(normalized_candidate));
    }

    std::vector<std::complex<double>> gram(candidate_count * candidate_count);
    for (std::size_t row = 0; row < candidate_count; ++row) {
        for (std::size_t column = 0; column < candidate_count; ++column) {
            std::complex<double> value{0.0, 0.0};
            for (std::size_t index = 0; index < dimension; ++index) {
                value += std::conj(normalized[row].mode[index]) *
                    normalized[column].mass_applied_mode[index];
                if (!finite_modal_value(value)) {
                    return ModalDeduplicationStatus::invalid_metric;
                }
            }
            gram[row * candidate_count + column] = value;
        }
    }

    const double hermitian_tolerance =
        64.0 * std::numeric_limits<double>::epsilon() *
        static_cast<double>(std::max({std::size_t{1}, dimension, candidate_count}));
    for (std::size_t row = 0; row < candidate_count; ++row) {
        std::complex<double> &diagonal = gram[row * candidate_count + row];
        if (!finite_modal_value(diagonal) ||
            std::abs(diagonal.real() - 1.0) > hermitian_tolerance ||
            std::abs(diagonal.imag()) > hermitian_tolerance) {
            return ModalDeduplicationStatus::invalid_metric;
        }
        diagonal = {1.0, 0.0};
        for (std::size_t column = row + 1; column < candidate_count; ++column) {
            const std::complex<double> upper =
                gram[row * candidate_count + column];
            const std::complex<double> lower_conjugate = std::conj(
                gram[column * candidate_count + row]);
            if (!finite_modal_value(upper) ||
                !finite_modal_value(lower_conjugate) ||
                std::abs(upper - lower_conjugate) > hermitian_tolerance) {
                return ModalDeduplicationStatus::invalid_metric;
            }
            const std::complex<double> symmetric =
                0.5 * upper + 0.5 * lower_conjugate;
            const double overlap = std::abs(symmetric);
            if (!std::isfinite(overlap) ||
                overlap > 1.0 + hermitian_tolerance) {
                return ModalDeduplicationStatus::invalid_metric;
            }
            gram[row * candidate_count + column] = symmetric;
            gram[column * candidate_count + row] = std::conj(symmetric);
        }
    }

    // Pivoted Cholesky is applied only to the small normalized candidate Gram
    // matrix. Its tolerance is dimensionless and scales with candidate count;
    // a zero pivot is accepted only when its residual row is also roundoff.
    const double psd_tolerance =
        64.0 * std::numeric_limits<double>::epsilon() *
        static_cast<double>(std::max<std::size_t>(1, candidate_count));
    for (std::size_t pivot_index = 0; pivot_index < candidate_count; ++pivot_index) {
        std::size_t pivot_row = pivot_index;
        double largest_diagonal = -std::numeric_limits<double>::infinity();
        for (std::size_t row = pivot_index; row < candidate_count; ++row) {
            const std::complex<double> diagonal =
                gram[row * candidate_count + row];
            if (!finite_modal_value(diagonal) ||
                std::abs(diagonal.imag()) > psd_tolerance ||
                diagonal.real() < -psd_tolerance) {
                return ModalDeduplicationStatus::invalid_metric;
            }
            if (diagonal.real() > largest_diagonal) {
                largest_diagonal = diagonal.real();
                pivot_row = row;
            }
        }
        if (largest_diagonal <= psd_tolerance) {
            for (std::size_t row = pivot_index; row < candidate_count; ++row) {
                for (std::size_t column = pivot_index;
                     column < candidate_count; ++column) {
                    if (std::abs(gram[row * candidate_count + column]) >
                        psd_tolerance) {
                        return ModalDeduplicationStatus::invalid_metric;
                    }
                }
            }
            return ModalDeduplicationStatus::success;
        }

        if (pivot_row != pivot_index) {
            for (std::size_t column = 0; column < candidate_count; ++column) {
                std::swap(
                    gram[pivot_index * candidate_count + column],
                    gram[pivot_row * candidate_count + column]);
            }
            for (std::size_t row = 0; row < candidate_count; ++row) {
                std::swap(
                    gram[row * candidate_count + pivot_index],
                    gram[row * candidate_count + pivot_row]);
            }
        }

        const double pivot = gram[pivot_index * candidate_count + pivot_index].real();
        if (!(pivot > psd_tolerance) || !std::isfinite(pivot)) {
            return ModalDeduplicationStatus::invalid_metric;
        }
        const double pivot_sqrt = std::sqrt(pivot);
        std::vector<std::complex<double>> factor(candidate_count);
        for (std::size_t row = pivot_index + 1; row < candidate_count; ++row) {
            factor[row] = gram[row * candidate_count + pivot_index] / pivot_sqrt;
            if (!finite_modal_value(factor[row])) {
                return ModalDeduplicationStatus::invalid_metric;
            }
        }
        for (std::size_t row = pivot_index + 1; row < candidate_count; ++row) {
            for (std::size_t column = row; column < candidate_count; ++column) {
                std::complex<double> residual =
                    gram[row * candidate_count + column] -
                    factor[row] * std::conj(factor[column]);
                if (!finite_modal_value(residual)) {
                    return ModalDeduplicationStatus::invalid_metric;
                }
                if (row == column) {
                    if (std::abs(residual.imag()) > psd_tolerance) {
                        return ModalDeduplicationStatus::invalid_metric;
                    }
                    residual = {residual.real(), 0.0};
                }
                gram[row * candidate_count + column] = residual;
                gram[column * candidate_count + row] = std::conj(residual);
            }
        }
    }
    return ModalDeduplicationStatus::success;
}

} // namespace

bool run_slepc_modal_destroy_sequence(
    const SLEPcModalDestroyOperation *operations,
    std::size_t operation_count,
    SLEPcModalDestroyFailureHandler on_failure,
    void *failure_context) noexcept
{
    if (operation_count > 0 && operations == nullptr) {
        if (on_failure != nullptr) {
            on_failure(failure_context);
        }
        return false;
    }
    for (std::size_t index = 0; index < operation_count; ++index) {
        const SLEPcModalDestroyOperation &operation = operations[index];
        if (operation.destroy == nullptr || !operation.destroy(operation.context)) {
            if (on_failure != nullptr) {
                on_failure(failure_context);
            }
            return false;
        }
    }
    return true;
}

bool create_slepc_tangent_mass_action_context(
    int tangent_dof_count,
    const double *dense_mass_row_major,
    const CsrMatrixView &csr_mass,
    SLEPcTangentMassActionContext *out_context) noexcept
{
    return prepare_slepc_tangent_mass_action_internal(
        tangent_dof_count,
        dense_mass_row_major,
        csr_mass,
        out_context);
}

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_mass(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t tangent_dof_count,
    ModalMassAction mass_action,
    const void *mass_action_context,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept
{
    SLEPcModalCandidateFinalization result{};
    if (tangent_dof_count == 0 ||
        candidates.size() > static_cast<std::size_t>(
            std::numeric_limits<int>::max()) ||
        (selection == SLEPcModalCandidateSelection::nearest_target &&
         !std::isfinite(target_frequency_hz))) {
        result.deduplication_status = ModalDeduplicationStatus::invalid_parameters;
        return result;
    }

    try {
        const ModalDeduplicationStatus gram_status =
            validate_slepc_candidate_mass_gram(
                candidates,
                tangent_dof_count,
                mass_action,
                mass_action_context);
        if (gram_status != ModalDeduplicationStatus::success) {
            result.deduplication_status = gram_status;
            return result;
        }

        std::vector<ModalCandidate> comparison_candidates;
        comparison_candidates.reserve(candidates.size());
        for (std::size_t index = 0; index < candidates.size(); ++index) {
            const SLEPcModalAcceptedMode &mode = candidates[index];
            ModalCandidate candidate{};
            candidate.frequency_hz = mode.frequency_hz;
            candidate.relative_residual = mode.relative_residual;
            candidate.source_index = static_cast<int>(index);
            candidate.mode = mode.mode_vector;
            comparison_candidates.push_back(std::move(candidate));
        }

        ModalDeduplicationResult deduplicated =
            deduplicate_modes_by_frequency_and_overlap_with_mass_action(
                comparison_candidates,
                tangent_dof_count,
                mass_action,
                mass_action_context,
                frequency_relative_tolerance,
                frequency_absolute_tolerance_hz,
                overlap_threshold);
        result.deduplication_status = deduplicated.status;
        if (deduplicated.status != ModalDeduplicationStatus::success) {
            return result;
        }

        result.accepted_modes.reserve(deduplicated.modes.size());
        for (const ModalCandidate &candidate : deduplicated.modes) {
            if (candidate.source_index < 0 ||
                static_cast<std::size_t>(candidate.source_index) >= candidates.size()) {
                result.accepted_modes.clear();
                result.deduplication_status = ModalDeduplicationStatus::invalid_candidate;
                return result;
            }
            result.accepted_modes.push_back(
                candidates[static_cast<std::size_t>(candidate.source_index)]);
        }

        const auto presentation_order = [](const SLEPcModalAcceptedMode &left,
                                           const SLEPcModalAcceptedMode &right) {
            if (left.frequency_hz != right.frequency_hz) {
                return left.frequency_hz < right.frequency_hz;
            }
            if (left.relative_residual != right.relative_residual) {
                return left.relative_residual < right.relative_residual;
            }
            return left.eigenpair_index < right.eigenpair_index;
        };
        if (selection == SLEPcModalCandidateSelection::nearest_target) {
            std::stable_sort(
                result.accepted_modes.begin(),
                result.accepted_modes.end(),
                [target_frequency_hz, &presentation_order](
                    const SLEPcModalAcceptedMode &left,
                    const SLEPcModalAcceptedMode &right) {
                    const double left_distance =
                        std::abs(left.frequency_hz - target_frequency_hz);
                    const double right_distance =
                        std::abs(right.frequency_hz - target_frequency_hz);
                    if (left_distance != right_distance) {
                        return left_distance < right_distance;
                    }
                    return presentation_order(left, right);
                });
        } else if (selection == SLEPcModalCandidateSelection::lowest_frequency) {
            std::stable_sort(
                result.accepted_modes.begin(),
                result.accepted_modes.end(),
                presentation_order);
        } else {
            result.accepted_modes.clear();
            result.deduplication_status = ModalDeduplicationStatus::invalid_parameters;
            return result;
        }

        const std::size_t requested_limit = static_cast<std::size_t>(
            std::max(1, requested_mode_count));
        result.unique_candidate_count_before_cap = result.accepted_modes.size();
        result.truncated_by_requested_count =
            result.unique_candidate_count_before_cap > requested_limit;
        if (result.accepted_modes.size() > requested_limit) {
            result.accepted_modes.resize(requested_limit);
        }
        std::stable_sort(
            result.accepted_modes.begin(),
            result.accepted_modes.end(),
            presentation_order);
        for (std::size_t index = 0; index < result.accepted_modes.size(); ++index) {
            result.accepted_modes[index].positive_frequency_pair_index =
                static_cast<int>(index);
        }
        result.success = true;
        return result;
    } catch (...) {
        result.accepted_modes.clear();
        result.success = false;
        result.deduplication_status = ModalDeduplicationStatus::invalid_parameters;
        return result;
    }
}

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_context(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    const SLEPcTangentMassActionContext &mass_action_context,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept
{
    SLEPcModalCandidateFinalization invalid{};
    invalid.deduplication_status = ModalDeduplicationStatus::invalid_metric;
    if (!mass_action_context.validated || mass_action_context.dimension == 0) {
        return invalid;
    }
    return finalize_slepc_modal_candidates_with_mass(
        candidates,
        mass_action_context.dimension,
        apply_slepc_tangent_mass_action,
        &mass_action_context,
        frequency_relative_tolerance,
        frequency_absolute_tolerance_hz,
        overlap_threshold,
        target_frequency_hz,
        requested_mode_count,
        selection);
}

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_dense_mass(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t tangent_dof_count,
    const double *mass_matrix_row_major,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept
{
    SLEPcModalCandidateFinalization invalid{};
    invalid.deduplication_status = ModalDeduplicationStatus::invalid_metric;
    if (tangent_dof_count > static_cast<std::size_t>(
            std::numeric_limits<int>::max())) {
        return invalid;
    }
    SLEPcTinyGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = static_cast<int>(tangent_dof_count);
    request.tangent_mass_matrix_row_major = mass_matrix_row_major;
    SLEPcTangentMassActionContext mass_context{};
    if (!prepare_slepc_tangent_mass_action_internal(
            request.tangent_dof_count,
            request.tangent_mass_matrix_row_major,
            request.tangent_mass_csr,
            &mass_context)) {
        return invalid;
    }
    return finalize_slepc_modal_candidates_with_context(
        candidates,
        mass_context,
        frequency_relative_tolerance,
        frequency_absolute_tolerance_hz,
        overlap_threshold,
        target_frequency_hz,
        requested_mode_count,
        selection);
}

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_csr_mass(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t tangent_dof_count,
    const CsrMatrixView &mass_csr,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept
{
    SLEPcModalCandidateFinalization invalid{};
    invalid.deduplication_status = ModalDeduplicationStatus::invalid_metric;
    if (tangent_dof_count > static_cast<std::size_t>(
            std::numeric_limits<int>::max())) {
        return invalid;
    }
    SLEPcTinyGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = static_cast<int>(tangent_dof_count);
    request.tangent_mass_csr = mass_csr;
    SLEPcTangentMassActionContext mass_context{};
    if (!prepare_slepc_tangent_mass_action_internal(
            request.tangent_dof_count,
            request.tangent_mass_matrix_row_major,
            request.tangent_mass_csr,
            &mass_context)) {
        return invalid;
    }
    return finalize_slepc_modal_candidates_with_context(
        candidates,
        mass_context,
        frequency_relative_tolerance,
        frequency_absolute_tolerance_hz,
        overlap_threshold,
        target_frequency_hz,
        requested_mode_count,
        selection);
}

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
        if (!destroy_slepc_modal_objects(
                nullptr, nullptr, nullptr, &stiffness, &gyrotropic)) {
            mark_slepc_graph_quarantined(&result, "slepc_cleanup_failed");
        }
        return result;
    }

    result = solve_slepc_gyrotropic_modal_eigen_with_matrices(
        request,
        stiffness,
        gyrotropic);
    if (!result.slepc_graph_quarantined &&
        !destroy_slepc_modal_objects(
                   nullptr, nullptr, nullptr, &stiffness, &gyrotropic)) {
        mark_slepc_graph_quarantined(&result, "slepc_cleanup_failed");
    }
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
        if (!destroy_slepc_modal_objects(
                nullptr, nullptr, nullptr, &stiffness, &gyrotropic)) {
            mark_slepc_graph_quarantined(&result, "slepc_cleanup_failed");
        }
        return result;
    }

    SLEPcTinyGyrotropicModalEigenRequest solve_request{};
    solve_request.tangent_dof_count = request.tangent_dof_count;
    solve_request.requested_mode_count = request.requested_mode_count;
    solve_request.tangent_mass_csr = request.tangent_mass_csr;
    solve_request.tangent_mass_action_context =
        request.tangent_mass_action_context;
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
    if (!result.slepc_graph_quarantined &&
        !destroy_slepc_modal_objects(
                   nullptr, nullptr, nullptr, &stiffness, &gyrotropic)) {
        mark_slepc_graph_quarantined(&result, "slepc_cleanup_failed");
    }
    return result;
#endif
}

} // namespace fullmag::fem::frequency_domain
