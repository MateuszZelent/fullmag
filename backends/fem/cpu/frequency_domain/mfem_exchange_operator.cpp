#include "cpu/frequency_domain/mfem_exchange_operator.hpp"

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

FrequencyDomainStatus apply_mfem_exchange_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    double *out_tangent,
    MfemExchangeOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemExchangeOperatorDiagnostics{};
        out_diagnostics->node_count = descriptor.node_count;
        out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
        out_diagnostics->edge_count = edge_count;
    }
    if (!descriptor.exchange_enabled) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM exchange operator is disabled by descriptor");
        }
        return FrequencyDomainStatus::unavailable;
    }
    if (!layout_matches_descriptor(descriptor, layout)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM exchange operator layout does not match descriptor");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if ((edge_count > 0 && edges == nullptr) || edge_count == 0) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM exchange operator requires exchange edges");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (tangent_in == nullptr || out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM exchange operator requires tangent buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }

    TangentEdgeOperatorDiagnostics edge_diagnostics{};
    const FrequencyDomainStatus status = apply_tangent_edge_operator(
        edges,
        edge_count,
        tangent_in,
        TangentWorkspaceShape{
            descriptor.node_count,
            descriptor.full_dof_count,
            descriptor.tangent_dof_count,
        },
        out_tangent,
        &edge_diagnostics);
    if (out_diagnostics != nullptr) {
        out_diagnostics->invalid_edge_count = edge_diagnostics.invalid_edge_count;
        out_diagnostics->max_abs_output = edge_diagnostics.max_abs_output;
        if (status != FrequencyDomainStatus::ok) {
            copy_error(out_diagnostics->error_message, edge_diagnostics.error_message);
        }
    }
    return status;
}

} // namespace fullmag::fem::frequency_domain
