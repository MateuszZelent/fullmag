#include "frequency_domain/operator_contract.hpp"
#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "frequency_domain/equilibrium_state.hpp"

#include <cmath>
#include <cstring>
#include <limits>

namespace fullmag::fem::frequency_domain {

namespace {

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

void copy_text(char *out, std::size_t out_size, const char *value) noexcept
{
    if (out == nullptr || out_size == 0) {
        return;
    }
    const char *source = value != nullptr ? value : "";
    std::strncpy(out, source, out_size - 1);
    out[out_size - 1] = '\0';
}

bool has_valid_tangent_shape(std::uint64_t node_count, std::uint64_t tangent_dof_count) noexcept
{
    return node_count > 0 &&
        node_count <= std::numeric_limits<std::uint64_t>::max() / 2 &&
        tangent_dof_count == node_count * 2;
}

} // namespace

FrequencyDomainStatus validate_frequency_domain_operator_request(
    const FrequencyDomainOperatorRequest &request,
    FrequencyDomainOperatorValidationDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = FrequencyDomainOperatorValidationDiagnostics{};
        out_diagnostics->node_count = request.node_count;
        out_diagnostics->tangent_dof_count = request.tangent_dof_count;
        out_diagnostics->alpha = request.alpha;
        out_diagnostics->gamma0 = request.gamma0;
    }

    if (!has_valid_tangent_shape(request.node_count, request.tangent_dof_count)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "operator request requires 2 tangent DOFs per node");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!(request.alpha >= 0.0) || !std::isfinite(request.alpha)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "operator request alpha must be finite and non-negative");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!(request.gamma0 > 0.0) || !std::isfinite(request.gamma0)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "operator request gamma0 must be finite and positive");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (request.demag_kind == FrequencyDomainDemagKind::dynamic_k) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "dynamic-k demag is not implemented for frequency-domain FEM");
        }
        return FrequencyDomainStatus::unavailable;
    }
    if (request.boundary_kind == FrequencyDomainBoundaryKind::floquet_bloch &&
        request.demag_kind != FrequencyDomainDemagKind::none) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "Floquet demag requires dynamic-k demag support");
        }
        return FrequencyDomainStatus::unavailable;
    }
    if (request.strict_gpu) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "frequency-domain FEM GPU operator is not implemented");
        }
        return FrequencyDomainStatus::unavailable;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus validate_driven_frequency_response_request(
    const DrivenFrequencyResponseRequest &request,
    FrequencyDomainSolveRequestDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = FrequencyDomainSolveRequestDiagnostics{};
        out_diagnostics->study_kind = FrequencyDomainStudyKind::driven_frequency_response;
        out_diagnostics->frequency_count = request.frequency_count;
    }

    FrequencyDomainOperatorValidationDiagnostics operator_diagnostics{};
    const FrequencyDomainStatus operator_status =
        validate_frequency_domain_operator_request(request.operator_request, &operator_diagnostics);
    if (operator_status != FrequencyDomainStatus::ok) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, operator_diagnostics.error_message);
        }
        return operator_status;
    }

    if (request.frequency_count == 0 || request.frequencies_hz == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "driven response requires at least one frequency");
        }
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t invalid_frequency_count = 0;
    for (std::uint64_t frequency_index = 0; frequency_index < request.frequency_count; ++frequency_index) {
        const double frequency_hz = request.frequencies_hz[frequency_index];
        if (!(frequency_hz > 0.0) || !std::isfinite(frequency_hz)) {
            ++invalid_frequency_count;
        }
    }
    if (invalid_frequency_count > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->invalid_frequency_count = invalid_frequency_count;
            copy_error(out_diagnostics->error_message, "driven response frequency values must be finite and positive");
        }
        return FrequencyDomainStatus::validation_error;
    }

    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus validate_modal_dynamic_matrix_request(
    const ModalDynamicMatrixRequest &request,
    FrequencyDomainSolveRequestDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = FrequencyDomainSolveRequestDiagnostics{};
        out_diagnostics->study_kind = FrequencyDomainStudyKind::modal_dynamic_matrix;
        out_diagnostics->mode_count = request.mode_count;
    }

    FrequencyDomainOperatorValidationDiagnostics operator_diagnostics{};
    const FrequencyDomainStatus operator_status =
        validate_frequency_domain_operator_request(request.operator_request, &operator_diagnostics);
    if (operator_status != FrequencyDomainStatus::ok) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, operator_diagnostics.error_message);
        }
        return operator_status;
    }

    if (request.mode_count == 0) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "modal dynamic matrix request requires at least one mode");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (request.target_frequency_hz < 0.0 || !std::isfinite(request.target_frequency_hz)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "modal target frequency must be finite and non-negative");
        }
        return FrequencyDomainStatus::validation_error;
    }

    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus build_linearized_llg_operator_diagnostics(
    const MfemOperatorContextDescriptor &descriptor,
    const EquilibriumStateDiagnostics &equilibrium_diagnostics,
    const char *demag_realization,
    LinearizedLlgOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_diagnostics = LinearizedLlgOperatorDiagnostics{};
    out_diagnostics->active_node_count = descriptor.node_count;
    out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
    out_diagnostics->exchange_enabled = descriptor.exchange_enabled;
    out_diagnostics->zeeman_enabled = descriptor.zeeman_enabled;
    out_diagnostics->uniaxial_anisotropy_enabled = descriptor.uniaxial_anisotropy_enabled;
    out_diagnostics->dmi_enabled = descriptor.dmi_enabled;
    out_diagnostics->demag_enabled = descriptor.demag_enabled;
    out_diagnostics->equilibrium_norm_error_max_abs =
        equilibrium_diagnostics.max_norm_error;
    out_diagnostics->equilibrium_residual_max_abs =
        equilibrium_diagnostics.max_m_cross_h_abs;
    out_diagnostics->equilibrium_residual_rms =
        equilibrium_diagnostics.rms_m_cross_h_abs;
    copy_text(out_diagnostics->frequency_units, sizeof(out_diagnostics->frequency_units), "Hz");
    copy_text(
        out_diagnostics->angular_frequency_units,
        sizeof(out_diagnostics->angular_frequency_units),
        "rad/s");
    copy_text(out_diagnostics->field_units, sizeof(out_diagnostics->field_units), "A_per_m");
    copy_text(
        out_diagnostics->demag_realization,
        sizeof(out_diagnostics->demag_realization),
        demag_realization != nullptr && demag_realization[0] != '\0' ? demag_realization : "none");

    if (!has_valid_tangent_shape(descriptor.node_count, descriptor.tangent_dof_count)) {
        copy_error(
            out_diagnostics->error_message,
            "operator diagnostics require 2 tangent DOFs per active node");
        return FrequencyDomainStatus::validation_error;
    }
    if (equilibrium_diagnostics.node_count != descriptor.node_count) {
        copy_error(
            out_diagnostics->error_message,
            "operator diagnostics equilibrium node count must match active nodes");
        return FrequencyDomainStatus::validation_error;
    }
    if (!std::isfinite(equilibrium_diagnostics.max_norm_error) ||
        !std::isfinite(equilibrium_diagnostics.max_m_cross_h_abs) ||
        !std::isfinite(equilibrium_diagnostics.rms_m_cross_h_abs)) {
        copy_error(
            out_diagnostics->error_message,
            "operator diagnostics require finite equilibrium residual diagnostics");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
