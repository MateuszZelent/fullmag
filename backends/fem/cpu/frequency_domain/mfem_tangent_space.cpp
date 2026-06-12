#include "cpu/frequency_domain/mfem_tangent_space.hpp"

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

} // namespace

FrequencyDomainStatus build_mfem_tangent_space_layout(
    const MfemOperatorContextDescriptor &descriptor,
    MfemTangentSpaceLayout *out_layout,
    MfemTangentSpaceDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemTangentSpaceDiagnostics{};
        out_diagnostics->node_count = descriptor.node_count;
        out_diagnostics->full_dof_count = descriptor.full_dof_count;
        out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
    }
    if (out_layout != nullptr) {
        *out_layout = MfemTangentSpaceLayout{};
    }
    if (out_layout == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM tangent space requires output layout");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!descriptor.mfem_mesh_available || descriptor.node_count == 0) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM tangent space requires an available non-empty mesh");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.full_dof_count != descriptor.node_count * 3) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM tangent space full DOF count must be 3 per node");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.tangent_dof_count != descriptor.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM tangent space tangent DOF count must be 2 per node");
        }
        return FrequencyDomainStatus::validation_error;
    }

    out_layout->node_count = descriptor.node_count;
    out_layout->full_dof_count = descriptor.full_dof_count;
    out_layout->tangent_dof_count = descriptor.tangent_dof_count;
    out_layout->full_components_per_node = 3;
    out_layout->tangent_components_per_node = 2;
    out_layout->tangent_stride = 2;
    out_layout->e1_component_offset = 0;
    out_layout->e2_component_offset = 1;
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
