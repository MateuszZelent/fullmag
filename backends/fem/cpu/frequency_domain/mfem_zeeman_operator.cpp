#include "cpu/frequency_domain/mfem_zeeman_operator.hpp"

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

bool layout_matches_descriptor(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout) noexcept
{
    return layout.node_count == descriptor.node_count &&
        layout.full_dof_count == descriptor.full_dof_count &&
        layout.tangent_dof_count == descriptor.tangent_dof_count &&
        layout.tangent_components_per_node == 2 &&
        layout.tangent_stride == 2;
}

} // namespace

FrequencyDomainStatus apply_mfem_zeeman_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const double h_ext_a_per_m[3],
    TangentOperatorLocalBlock *workspace_blocks,
    const double *tangent_in,
    double *out_tangent,
    MfemZeemanOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemZeemanOperatorDiagnostics{};
        out_diagnostics->node_count = descriptor.node_count;
        out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
    }
    if (!descriptor.zeeman_enabled) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM Zeeman operator is disabled by descriptor");
        }
        return FrequencyDomainStatus::unavailable;
    }
    if (!layout_matches_descriptor(descriptor, layout)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM Zeeman operator layout does not match descriptor");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (nodes == nullptr ||
        h_ext_a_per_m == nullptr ||
        workspace_blocks == nullptr ||
        tangent_in == nullptr ||
        out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM Zeeman operator requires tangent frame, field, and buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }

    ZeemanTangentOperatorDiagnostics zeeman_diagnostics{};
    FrequencyDomainStatus status = build_zeeman_tangent_blocks(
        nodes,
        h_ext_a_per_m,
        descriptor.node_count,
        workspace_blocks,
        &zeeman_diagnostics);
    if (status == FrequencyDomainStatus::ok) {
        TangentOperatorDiagnostics operator_diagnostics{};
        status = apply_tangent_nodewise_operator(
            workspace_blocks,
            tangent_in,
            TangentWorkspaceShape{
                descriptor.node_count,
                descriptor.full_dof_count,
                descriptor.tangent_dof_count,
            },
            out_tangent,
            &operator_diagnostics);
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_output = operator_diagnostics.max_abs_output;
            if (status != FrequencyDomainStatus::ok) {
                copy_error(out_diagnostics->error_message, operator_diagnostics.error_message);
            }
        }
    } else if (out_diagnostics != nullptr) {
        copy_error(out_diagnostics->error_message, zeeman_diagnostics.error_message);
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_parallel_field_abs = zeeman_diagnostics.max_parallel_field_abs;
        out_diagnostics->max_transverse_field_abs = zeeman_diagnostics.max_transverse_field_abs;
    }
    return status;
}

} // namespace fullmag::fem::frequency_domain
