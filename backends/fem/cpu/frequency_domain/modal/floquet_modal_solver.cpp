#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"

#include <cmath>
#include <cstring>
#include <limits>

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

bool has_floquet_payload_marker(const ModalEigenRequest &request) noexcept
{
    const char *diagnostics = request.operator_request.operator_diagnostics_json;
    return diagnostics != nullptr &&
        std::strstr(
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

} // namespace

FloquetModalSolverAdmission admit_floquet_modal_request(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept
{
    FloquetModalSolverAdmission admission{};
    admission.frequency_window = spectral_request.frequency_max_hz >
        spectral_request.frequency_min_hz;
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
    admission.frequency_window = spectral_request.frequency_max_hz >
        spectral_request.frequency_min_hz;
    if (request.execution_target == ModalExecutionTarget::production_gpu) {
        admission.reason = "floquet_modal_gpu_lane_not_owned_by_cpu_solver";
        return admission;
    }
    if (request.operator_request.spin_wave_bc_kind == nullptr ||
        std::strcmp(request.operator_request.spin_wave_bc_kind, "floquet") != 0) {
        admission.reason = "floquet_modal_requires_floquet_boundary";
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
        admission.reason =
            "floquet_sparse_modal_requires_dense_dynamic_demag_owner";
        return admission;
    }
    if (spectral_request.tangent_dof_count <= 0 ||
        !sparse_view_is_valid(spectral_request.stiffness_csr) ||
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
    return solve_slepc_sparse_gyrotropic_modal_eigen(spectral_request);
}

const char *floquet_modal_solver_model() noexcept
{
    return "floquet_real_frequency_slepc";
}

} // namespace fullmag::fem::frequency_domain
