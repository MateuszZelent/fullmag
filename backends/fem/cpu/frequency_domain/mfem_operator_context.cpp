#include "cpu/frequency_domain/mfem_operator_context.hpp"

#include <cstring>

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

bool element_indices_are_in_range(const MfemOperatorContextRequest &request) noexcept
{
    const std::uint64_t index_count = request.element_count * request.element_node_count;
    for (std::uint64_t index = 0; index < index_count; ++index) {
        if (request.elements[index] >= request.node_count) {
            return false;
        }
    }
    return true;
}

} // namespace

FrequencyDomainStatus build_mfem_operator_context_descriptor(
    const MfemOperatorContextRequest &request,
    MfemOperatorContextDescriptor *out_descriptor,
    MfemOperatorContextDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemOperatorContextDiagnostics{};
        out_diagnostics->node_count = request.node_count;
        out_diagnostics->element_count = request.element_count;
        out_diagnostics->tangent_dof_count = request.operator_request.tangent_dof_count;
        out_diagnostics->material_region_count = request.material_region_count;
        out_diagnostics->mfem_mesh_available = request.has_mfem_mesh;
    }
    if (out_descriptor != nullptr) {
        *out_descriptor = MfemOperatorContextDescriptor{};
    }
    if (out_descriptor == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM operator context requires output descriptor");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (request.node_count == 0 || request.element_count == 0 || request.element_node_count < 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM operator context requires non-empty mesh topology");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (request.nodes_xyz == nullptr || request.elements == nullptr || request.tangent_nodes == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM operator context requires mesh and tangent buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (request.material_region_count == 0) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM operator context requires material regions");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!element_indices_are_in_range(request)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM operator context has out-of-range element node index");
        }
        return FrequencyDomainStatus::validation_error;
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
    if (request.operator_request.node_count != request.node_count) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM operator context node count does not match operator request");
        }
        return FrequencyDomainStatus::validation_error;
    }

    out_descriptor->node_count = request.node_count;
    out_descriptor->element_count = request.element_count;
    out_descriptor->element_node_count = request.element_node_count;
    out_descriptor->full_dof_count = request.node_count * 3;
    out_descriptor->tangent_dof_count = request.operator_request.tangent_dof_count;
    out_descriptor->material_region_count = request.material_region_count;
    out_descriptor->boundary_kind = request.operator_request.boundary_kind;
    out_descriptor->demag_kind = request.operator_request.demag_kind;
    out_descriptor->exchange_enabled = request.operator_request.include_exchange;
    out_descriptor->zeeman_enabled = request.operator_request.include_zeeman;
    out_descriptor->demag_enabled = request.operator_request.demag_kind != FrequencyDomainDemagKind::none;
    out_descriptor->mfem_mesh_available = request.has_mfem_mesh;
    out_descriptor->periodic_reduced_mesh = request.periodic_reduced_mesh;
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
