#include "cpu/frequency_domain/mfem_linearized_operator.hpp"
#include "frequency_domain/canonical_digest.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {
void add_doubles(CanonicalDigestBuilder *digest, const char *name, const double *values, std::uint64_t count) {
    digest->add_u64(std::string(name) + ".count", count);
    for (std::uint64_t i = 0; i < count; ++i) digest->add_double(std::string(name) + "[" + std::to_string(i) + "]", values == nullptr ? 0.0 : values[i]);
}
}

std::string mfem_linearized_pencil_dependency_digest(
    const MfemLinearizedPencilDependency &dependency)
{
    CanonicalDigestBuilder digest("mfem_linearized_jvp_dependencies.v2");
    const auto &d = dependency.descriptor;
    digest.add_u64("descriptor.node_count", d.node_count); digest.add_u64("descriptor.element_count", d.element_count);
    digest.add_u64("descriptor.element_node_count", d.element_node_count); digest.add_u64("descriptor.full_dof_count", d.full_dof_count);
    digest.add_u64("descriptor.tangent_dof_count", d.tangent_dof_count); digest.add_u64("descriptor.material_region_count", d.material_region_count);
    digest.add_u64("descriptor.boundary_kind", static_cast<std::uint64_t>(d.boundary_kind)); digest.add_u64("descriptor.demag_kind", static_cast<std::uint64_t>(d.demag_kind));
    digest.add_u64("descriptor.exchange_enabled", d.exchange_enabled); digest.add_u64("descriptor.zeeman_enabled", d.zeeman_enabled); digest.add_u64("descriptor.uniaxial_anisotropy_enabled", d.uniaxial_anisotropy_enabled);
    digest.add_u64("descriptor.dmi_enabled", d.dmi_enabled); digest.add_u64("descriptor.demag_enabled", d.demag_enabled); digest.add_u64("descriptor.mfem_mesh_available", d.mfem_mesh_available); digest.add_u64("descriptor.periodic_reduced_mesh", d.periodic_reduced_mesh);
    const auto &l = dependency.layout;
    digest.add_u64("layout.node_count", l.node_count); digest.add_u64("layout.full_dof_count", l.full_dof_count); digest.add_u64("layout.tangent_dof_count", l.tangent_dof_count); digest.add_u64("layout.full_components_per_node", l.full_components_per_node); digest.add_u64("layout.tangent_components_per_node", l.tangent_components_per_node); digest.add_u64("layout.tangent_stride", l.tangent_stride); digest.add_u64("layout.e1_component_offset", l.e1_component_offset); digest.add_u64("layout.e2_component_offset", l.e2_component_offset);
    for (std::uint64_t i = 0; i < d.node_count; ++i) { const auto &n = dependency.nodes[i]; for (int j = 0; j < 3; ++j) { const std::string p = "node[" + std::to_string(i) + "]"; digest.add_double(p + ".m[" + std::to_string(j) + "]", n.m[j]); digest.add_double(p + ".e1[" + std::to_string(j) + "]", n.e1[j]); digest.add_double(p + ".e2[" + std::to_string(j) + "]", n.e2[j]); } }
    digest.add_u64("exchange_edge_count", dependency.exchange_edge_count);
    for (std::uint64_t i = 0; i < dependency.exchange_edge_count; ++i) { const auto &e = dependency.exchange_edges[i]; const std::string p = "exchange[" + std::to_string(i) + "]"; digest.add_u64(p + ".kind", static_cast<std::uint64_t>(e.kind)); digest.add_u64(p + ".node_i", e.node_i); digest.add_u64(p + ".node_j", e.node_j); digest.add_double(p + ".stiffness", e.stiffness); }
    add_doubles(&digest, "h_ext_a_per_m", dependency.h_ext_a_per_m, dependency.h_ext_value_count); add_doubles(&digest, "uniaxial_anisotropy_axis", dependency.uniaxial_anisotropy_axis, dependency.uniaxial_anisotropy_axis_value_count); digest.add_double("uniaxial_anisotropy_field_a_per_m", dependency.uniaxial_anisotropy_field_a_per_m); add_doubles(&digest, "alpha_per_node", dependency.alpha_per_node, dependency.alpha_value_count); digest.add_double("gamma0_m_per_a_s", dependency.gamma0); digest.add_double("alpha", dependency.alpha);
    digest.add_u64("dmi_element_count", dependency.dmi_element_count);
    for (std::uint64_t i = 0; i < dependency.dmi_element_count; ++i) { const auto &e = dependency.dmi_elements[i]; const std::string p = "dmi[" + std::to_string(i) + "]"; digest.add_u64(p + ".kind", static_cast<std::uint64_t>(e.kind)); for (int j = 0; j < 4; ++j) { digest.add_u64(p + ".node[" + std::to_string(j) + "]", e.node_indices[j]); digest.add_double(p + ".shape[" + std::to_string(j) + "]", e.shape[j]); for (int k = 0; k < 3; ++k) digest.add_double(p + ".grad[" + std::to_string(j) + "][" + std::to_string(k) + "]", e.grad_shape[j][k]); } digest.add_double(p + ".weight", e.weight); digest.add_double(p + ".d", e.d); for (int j = 0; j < 3; ++j) digest.add_double(p + ".normal[" + std::to_string(j) + "]", e.normal[j]); }
    add_doubles(&digest, "dmi_lumped_mass", dependency.dmi_lumped_mass, dependency.dmi_lumped_mass_value_count); add_doubles(&digest, "dmi_ms_field", dependency.dmi_ms_field, dependency.dmi_ms_field_value_count); digest.add_double("dmi_uniform_ms", dependency.dmi_uniform_ms); add_doubles(&digest, "demag_tangent_matrix", dependency.demag_tangent_matrix_row_major, dependency.demag_tangent_matrix_value_count); digest.add_string("demag_provider_signature", dependency.demag_provider_signature == nullptr ? "" : dependency.demag_provider_signature);
    digest.add_u64("static_periodic_node_pair_count", dependency.static_periodic_node_pair_count); for (std::uint64_t i = 0; i < dependency.static_periodic_node_pair_count * 2; ++i) digest.add_u64("static_periodic_node_pairs[" + std::to_string(i) + "]", dependency.static_periodic_node_pairs[i]); digest.add_u64("periodic_airbox", dependency.periodic_airbox);
    return digest.sha256_hex();
}

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

void zero_buffer(double *buffer, std::uint64_t count) noexcept
{
    if (buffer != nullptr) {
        std::fill(buffer, buffer + count, 0.0);
    }
}

double max_abs_buffer(const double *buffer, std::uint64_t count) noexcept
{
    double max_abs_value = 0.0;
    for (std::uint64_t index = 0; index < count; ++index) {
        max_abs_value = std::max(max_abs_value, std::abs(buffer[index]));
    }
    return max_abs_value;
}

} // namespace

FrequencyDomainStatus apply_mfem_linearized_cpu_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *exchange_edges,
    std::uint64_t exchange_edge_count,
    const double h_ext_a_per_m[3],
    const double uniaxial_anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    const double *alpha_per_node,
    double gamma0,
    double alpha,
    const MfemLinearizedOperatorWorkspace &workspace,
    const double *tangent_in,
    double *out_stiffness_rhs_tangent,
    double *out_mass_tangent,
    MfemLinearizedOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = MfemLinearizedOperatorDiagnostics{};
        out_diagnostics->node_count = descriptor.node_count;
        out_diagnostics->tangent_dof_count = descriptor.tangent_dof_count;
        out_diagnostics->exchange_edge_count = exchange_edge_count;
        out_diagnostics->gamma0 = gamma0;
        out_diagnostics->alpha = alpha;
    }

    if (!layout_matches_descriptor(descriptor, layout)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator layout does not match descriptor");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (nodes == nullptr ||
        tangent_in == nullptr ||
        out_stiffness_rhs_tangent == nullptr ||
        out_mass_tangent == nullptr ||
        workspace.effective_field_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires tangent frame and workspace buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!descriptor.exchange_enabled &&
        !descriptor.zeeman_enabled &&
        !descriptor.uniaxial_anisotropy_enabled &&
        !descriptor.dmi_enabled &&
        !descriptor.demag_enabled) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires at least one field term");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.demag_enabled &&
        descriptor.demag_kind != FrequencyDomainDemagKind::none &&
        workspace.demag_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized demag requires assembled dynamic demag tangent payload");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.exchange_enabled &&
        (workspace.exchange_tangent == nullptr ||
            exchange_edges == nullptr ||
            exchange_edge_count == 0)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires exchange workspace and edges");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.zeeman_enabled &&
        (workspace.zeeman_tangent == nullptr ||
            workspace.zeeman_blocks == nullptr ||
            h_ext_a_per_m == nullptr)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires Zeeman workspace and field");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.uniaxial_anisotropy_enabled &&
        (workspace.uniaxial_anisotropy_tangent == nullptr ||
            workspace.uniaxial_anisotropy_blocks == nullptr ||
            uniaxial_anisotropy_axis == nullptr ||
            !std::isfinite(uniaxial_anisotropy_field_a_per_m))) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires uniaxial anisotropy workspace and finite field");
        }
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_dmi_element_operator =
        workspace.dmi_elements != nullptr ||
        workspace.dmi_element_count != 0 ||
        workspace.dmi_lumped_mass != nullptr ||
        workspace.dmi_delta_xyz != nullptr ||
        workspace.dmi_residual_xyz != nullptr ||
        workspace.dmi_field_xyz != nullptr;
    if (descriptor.dmi_enabled && workspace.dmi_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires DMI output workspace");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.dmi_enabled &&
        has_dmi_element_operator &&
        (workspace.dmi_elements == nullptr ||
            workspace.dmi_element_count == 0 ||
            workspace.dmi_lumped_mass == nullptr ||
            workspace.dmi_delta_xyz == nullptr ||
            workspace.dmi_residual_xyz == nullptr ||
            workspace.dmi_field_xyz == nullptr)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires complete DMI element workspace");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.dmi_enabled && !has_dmi_element_operator && workspace.dmi_blocks == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "MFEM linearized operator requires DMI blocks or element data");
        }
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t tangent_dof_count = descriptor.tangent_dof_count;
    zero_buffer(workspace.exchange_tangent, tangent_dof_count);
    zero_buffer(workspace.zeeman_tangent, tangent_dof_count);
    zero_buffer(workspace.uniaxial_anisotropy_tangent, tangent_dof_count);
    zero_buffer(workspace.dmi_tangent, tangent_dof_count);
    zero_buffer(workspace.effective_field_tangent, tangent_dof_count);

    if (descriptor.exchange_enabled) {
        MfemExchangeOperatorDiagnostics exchange_diagnostics{};
        const FrequencyDomainStatus status = apply_mfem_exchange_operator(
            descriptor,
            layout,
            nodes,
            exchange_edges,
            exchange_edge_count,
            tangent_in,
            workspace.exchange_tangent,
            &exchange_diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, exchange_diagnostics.error_message);
            }
            return status;
        }
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_exchange_field = exchange_diagnostics.max_abs_output;
        }
    }

    if (descriptor.zeeman_enabled) {
        MfemZeemanOperatorDiagnostics zeeman_diagnostics{};
        const FrequencyDomainStatus status = apply_mfem_zeeman_operator(
            descriptor,
            layout,
            nodes,
            h_ext_a_per_m,
            workspace.zeeman_blocks,
            tangent_in,
            workspace.zeeman_tangent,
            &zeeman_diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, zeeman_diagnostics.error_message);
            }
            return status;
        }
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_zeeman_field = zeeman_diagnostics.max_abs_output;
        }
    }

    if (descriptor.uniaxial_anisotropy_enabled) {
        UniaxialAnisotropyTangentOperatorDiagnostics anisotropy_diagnostics{};
        FrequencyDomainStatus status = build_uniaxial_anisotropy_tangent_blocks(
            nodes,
            uniaxial_anisotropy_axis,
            uniaxial_anisotropy_field_a_per_m,
            descriptor.node_count,
            workspace.uniaxial_anisotropy_blocks,
            &anisotropy_diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, anisotropy_diagnostics.error_message);
            }
            return status;
        }
        TangentOperatorDiagnostics operator_diagnostics{};
        status = apply_tangent_nodewise_operator(
            workspace.uniaxial_anisotropy_blocks,
            tangent_in,
            TangentWorkspaceShape{
                descriptor.node_count,
                descriptor.full_dof_count,
                descriptor.tangent_dof_count,
            },
            workspace.uniaxial_anisotropy_tangent,
            &operator_diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, operator_diagnostics.error_message);
            }
            return status;
        }
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_uniaxial_anisotropy_field =
                operator_diagnostics.max_abs_output;
        }
    }

    if (descriptor.dmi_enabled) {
        MfemDmiOperatorDiagnostics dmi_diagnostics{};
        const FrequencyDomainStatus status = has_dmi_element_operator ?
            apply_mfem_dmi_element_tangent_operator(
                descriptor,
                layout,
                nodes,
                workspace.dmi_elements,
                workspace.dmi_element_count,
                workspace.dmi_lumped_mass,
                workspace.dmi_ms_field,
                workspace.dmi_uniform_ms,
                tangent_in,
                workspace.dmi_delta_xyz,
                workspace.dmi_residual_xyz,
                workspace.dmi_field_xyz,
                workspace.dmi_tangent,
                &dmi_diagnostics) :
            apply_mfem_dmi_operator(
                descriptor,
                layout,
                workspace.dmi_blocks,
                tangent_in,
                workspace.dmi_tangent,
                &dmi_diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, dmi_diagnostics.error_message);
            }
            return status;
        }
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_dmi_field = dmi_diagnostics.max_abs_output;
        }
    }

    for (std::uint64_t dof = 0; dof < tangent_dof_count; ++dof) {
        const double exchange_value = descriptor.exchange_enabled ? workspace.exchange_tangent[dof] : 0.0;
        const double zeeman_value = descriptor.zeeman_enabled ? workspace.zeeman_tangent[dof] : 0.0;
        const double anisotropy_value = descriptor.uniaxial_anisotropy_enabled ?
            workspace.uniaxial_anisotropy_tangent[dof] :
            0.0;
        const double dmi_value = descriptor.dmi_enabled ? workspace.dmi_tangent[dof] : 0.0;
        const double demag_value =
            descriptor.demag_enabled && workspace.demag_tangent != nullptr ?
            workspace.demag_tangent[dof] :
            0.0;
        workspace.effective_field_tangent[dof] =
            exchange_value + zeeman_value + anisotropy_value + dmi_value + demag_value;
    }

    TangentPrecessionDiagnostics precession_diagnostics{};
    FrequencyDomainStatus status = apply_tangent_precession_operator(
        nodes,
        workspace.effective_field_tangent,
        TangentWorkspaceShape{
            descriptor.node_count,
            descriptor.full_dof_count,
            descriptor.tangent_dof_count,
        },
        gamma0,
        out_stiffness_rhs_tangent,
        &precession_diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, precession_diagnostics.error_message);
        }
        return status;
    }

    TangentFrequencyMassDiagnostics mass_diagnostics{};
    status = apply_tangent_frequency_mass_operator(
        nodes,
        tangent_in,
        TangentWorkspaceShape{
            descriptor.node_count,
            descriptor.full_dof_count,
            descriptor.tangent_dof_count,
        },
        alpha,
        alpha_per_node,
        out_mass_tangent,
        &mass_diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, mass_diagnostics.error_message);
        }
        return status;
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_effective_field = max_abs_buffer(workspace.effective_field_tangent, tangent_dof_count);
        out_diagnostics->max_abs_demag_field =
            descriptor.demag_enabled && workspace.demag_tangent != nullptr ?
            max_abs_buffer(workspace.demag_tangent, tangent_dof_count) :
            0.0;
        out_diagnostics->max_abs_stiffness_rhs = precession_diagnostics.max_abs_rhs;
        out_diagnostics->max_abs_mass_rhs = mass_diagnostics.max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_linearized_cpu_pencil(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *exchange_edges,
    std::uint64_t exchange_edge_count,
    const double h_ext_a_per_m[3],
    const double uniaxial_anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    const double *alpha_per_node,
    double gamma0,
    double alpha,
    const MfemLinearizedOperatorWorkspace &workspace,
    const double *tangent_in,
    double *out_l_tangent,
    double *out_b_alpha_tangent,
    MfemLinearizedOperatorDiagnostics *out_diagnostics) noexcept
{
    const FrequencyDomainStatus status = apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        nodes,
        exchange_edges,
        exchange_edge_count,
        h_ext_a_per_m,
        uniaxial_anisotropy_axis,
        uniaxial_anisotropy_field_a_per_m,
        alpha_per_node,
        gamma0,
        alpha,
        workspace,
        tangent_in,
        out_l_tangent,
        out_b_alpha_tangent,
        out_diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    for (std::uint64_t dof = 0; dof < descriptor.tangent_dof_count; ++dof) {
        out_l_tangent[dof] = -out_l_tangent[dof];
        out_b_alpha_tangent[dof] = -out_b_alpha_tangent[dof];
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
