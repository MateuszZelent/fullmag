#include "cpu/frequency_domain/mfem_dmi_operator.hpp"

#include "dmi_weak_residual.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

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

double max_abs_buffer(const double *buffer, std::uint64_t count) noexcept
{
    double max_abs_value = 0.0;
    if (buffer == nullptr) {
        return max_abs_value;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        max_abs_value = std::max(max_abs_value, std::abs(buffer[index]));
    }
    return max_abs_value;
}

bool element_indices_are_in_range(
    const MfemDmiElementTangentData &element,
    std::uint64_t node_count) noexcept
{
    for (std::uint64_t local_node = 0; local_node < 4; ++local_node) {
        if (element.node_indices[local_node] >= node_count) {
            return false;
        }
    }
    return true;
}

bool element_geometry_is_finite(const MfemDmiElementTangentData &element) noexcept
{
    for (std::uint64_t local_node = 0; local_node < 4; ++local_node) {
        if (!std::isfinite(element.shape[local_node])) {
            return false;
        }
        for (int dir = 0; dir < 3; ++dir) {
            if (!std::isfinite(element.grad_shape[local_node][dir])) {
                return false;
            }
        }
    }
    if (element.kind == MfemDmiInteractionKind::interfacial) {
        return std::isfinite(element.normal[0]) &&
            std::isfinite(element.normal[1]) &&
            std::isfinite(element.normal[2]);
    }
    return true;
}

bool element_kind_is_supported(MfemDmiInteractionKind kind) noexcept
{
    return kind == MfemDmiInteractionKind::interfacial ||
        kind == MfemDmiInteractionKind::bulk;
}

} // namespace

FrequencyDomainStatus apply_mfem_dmi_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentOperatorLocalBlock *dmi_blocks,
    const double *tangent_in,
    double *out_tangent,
    MfemDmiOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemDmiOperatorDiagnostics{};
        out_diagnostics->node_count = descriptor.node_count;
        out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
    }
    if (!descriptor.dmi_enabled) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI operator is disabled by descriptor");
        }
        return FrequencyDomainStatus::unavailable;
    }
    if (!layout_matches_descriptor(descriptor, layout)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI operator layout does not match descriptor");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (dmi_blocks == nullptr || tangent_in == nullptr || out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI operator requires tangent DMI blocks and buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    for (std::uint64_t node_index = 0; node_index < descriptor.node_count; ++node_index) {
        if (dmi_blocks[node_index].kind != FrequencyDomainOperatorTermKind::dmi) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "MFEM DMI operator requires DMI tangent blocks");
            }
            return FrequencyDomainStatus::validation_error;
        }
    }

    TangentOperatorDiagnostics operator_diagnostics{};
    const FrequencyDomainStatus status = apply_tangent_nodewise_operator(
        dmi_blocks,
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
    return status;
}

FrequencyDomainStatus apply_mfem_dmi_element_tangent_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const MfemDmiElementTangentData *elements,
    std::uint64_t element_count,
    const double *lumped_mass,
    const double *ms_field,
    double uniform_ms,
    const double *tangent_in,
    double *workspace_delta_xyz,
    double *workspace_residual_xyz,
    double *workspace_field_xyz,
    double *out_tangent,
    MfemDmiOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemDmiOperatorDiagnostics{};
        out_diagnostics->node_count = descriptor.node_count;
        out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
        out_diagnostics->element_count = element_count;
    }
    if (!descriptor.dmi_enabled) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator is disabled by descriptor");
        }
        return FrequencyDomainStatus::unavailable;
    }
    if (!layout_matches_descriptor(descriptor, layout)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator layout does not match descriptor");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.element_node_count != 4) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator requires tetrahedral elements");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (nodes == nullptr ||
        elements == nullptr ||
        element_count == 0 ||
        lumped_mass == nullptr ||
        tangent_in == nullptr ||
        workspace_delta_xyz == nullptr ||
        workspace_residual_xyz == nullptr ||
        workspace_field_xyz == nullptr ||
        out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator requires element data and workspace buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!std::isfinite(uniform_ms) || uniform_ms <= 0.0) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator requires positive uniform Ms");
        }
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t node_count = descriptor.node_count;
    const std::uint64_t full_dof_count = descriptor.full_dof_count;
    const std::uint64_t tangent_dof_count = descriptor.tangent_dof_count;
    std::fill(workspace_delta_xyz, workspace_delta_xyz + full_dof_count, 0.0);
    std::fill(workspace_residual_xyz, workspace_residual_xyz + full_dof_count, 0.0);
    std::fill(workspace_field_xyz, workspace_field_xyz + full_dof_count, 0.0);
    std::fill(out_tangent, out_tangent + tangent_dof_count, 0.0);

    lift_tangent_to_full(nodes, tangent_in, node_count, workspace_delta_xyz);

    for (std::uint64_t element_index = 0; element_index < element_count; ++element_index) {
        const MfemDmiElementTangentData &element = elements[element_index];
        if (!element_indices_are_in_range(element, node_count)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator has out-of-range node index");
            }
            return FrequencyDomainStatus::validation_error;
        }
        if (!element_kind_is_supported(element.kind)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator requires supported DMI interaction kind");
            }
            return FrequencyDomainStatus::validation_error;
        }
        if (!std::isfinite(element.weight) || element.weight == 0.0 || !std::isfinite(element.d)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator requires finite element weight and D");
            }
            return FrequencyDomainStatus::validation_error;
        }
        if (!element_geometry_is_finite(element)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "MFEM DMI element tangent operator requires finite shape, gradient, and normal data");
            }
            return FrequencyDomainStatus::validation_error;
        }

        double delta_q[3]{};
        double grad_delta[3][3]{};
        for (std::uint64_t local_node = 0; local_node < 4; ++local_node) {
            const std::uint64_t node_index = element.node_indices[local_node];
            const double *delta = workspace_delta_xyz + node_index * 3;
            for (int comp = 0; comp < 3; ++comp) {
                delta_q[comp] += element.shape[local_node] * delta[comp];
                for (int dir = 0; dir < 3; ++dir) {
                    grad_delta[comp][dir] += delta[comp] * element.grad_shape[local_node][dir];
                }
            }
        }

        for (std::uint64_t local_node = 0; local_node < 4; ++local_node) {
            fullmag::fem::DmiElementData data{};
            for (int comp = 0; comp < 3; ++comp) {
                data.m_q[comp] = delta_q[comp];
                for (int dir = 0; dir < 3; ++dir) {
                    data.grad_m[comp][dir] = grad_delta[comp][dir];
                }
            }
            data.shape = element.shape[local_node];
            data.weight = element.weight;
            for (int dir = 0; dir < 3; ++dir) {
                data.grad_shape[dir] = element.grad_shape[local_node][dir];
            }

            double residual[3]{};
            if (element.kind == MfemDmiInteractionKind::interfacial) {
                fullmag::fem::dmi_accumulate_interfacial_residual(
                    data,
                    element.normal,
                    element.d,
                    residual);
            } else {
                fullmag::fem::dmi_accumulate_bulk_residual(data, element.d, residual);
            }

            const std::uint64_t node_index = element.node_indices[local_node];
            double *out_residual = workspace_residual_xyz + node_index * 3;
            for (int comp = 0; comp < 3; ++comp) {
                out_residual[comp] += residual[comp];
            }
        }
    }

    std::string projection_error;
    if (!fullmag::fem::dmi_project_lumped_field(
            workspace_residual_xyz,
            lumped_mass,
            ms_field,
            node_count,
            uniform_ms,
            workspace_field_xyz,
            projection_error)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, projection_error.c_str());
        }
        return FrequencyDomainStatus::validation_error;
    }

    project_full_to_tangent(nodes, workspace_field_xyz, node_count, out_tangent);
    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_residual = max_abs_buffer(workspace_residual_xyz, full_dof_count);
        out_diagnostics->max_abs_full_field = max_abs_buffer(workspace_field_xyz, full_dof_count);
        out_diagnostics->max_abs_output = max_abs_buffer(out_tangent, tangent_dof_count);
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
