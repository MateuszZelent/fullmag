/*
 * Standalone C ABI adapter for M1 steady charge/spin transport.
 *
 * This file owns descriptor validation, MFEM mesh/material/BC import, field
 * export and diagnostic serialization. It deliberately does not use Context,
 * mfem_bridge.cpp or the time-domain backend lifecycle.
 */

#include "fullmag_fem.h"
#include <cstddef>
#include <cstdio>

#if FULLMAG_HAS_MFEM_STACK
#include "cpu/mfem/transport/steady_transport.hpp"
#include "cpu/mfem/transport/conservative_current_view.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.hpp"
#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"
#include "cpu/mfem/interactions/oersted/vector_potential.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstring>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>
#endif

namespace {

#if INTPTR_MAX == INT64_MAX
static_assert(sizeof(fullmag_fem_direct_oersted_target_record_v1) == 96);
static_assert(alignof(fullmag_fem_direct_oersted_target_record_v1) == 8);
static_assert(offsetof(fullmag_fem_direct_oersted_target_record_v1, final_leaf_count) == 72);
static_assert(sizeof(fullmag_fem_direct_oersted_snapshot_result_v1) == 896);
static_assert(alignof(fullmag_fem_direct_oersted_snapshot_result_v1) == 8);
static_assert(offsetof(fullmag_fem_direct_oersted_snapshot_result_v1, target_records) == 16);
static_assert(offsetof(fullmag_fem_direct_oersted_snapshot_result_v1, schema_version) == 152);
static_assert(offsetof(fullmag_fem_direct_oersted_snapshot_result_v1, source_view_identity_digest) == 568);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_terminal_v1) == 32);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_interface_v1) == 104);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_request_v1) == 360);
static_assert(alignof(fullmag_fem_accepted_terminal_charge_request_v1) == 8);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_request_v1, mesh) == 24);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_request_v1, stable_vertex_identities) == 256);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_request_v1, maximum_iterations) == 352);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_result_v1) == 656);
static_assert(alignof(fullmag_fem_accepted_terminal_charge_result_v1) == 8);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_result_v1, canonical_payload) == 16);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_result_v1, content_sha256) == 328);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_result_v1, error_message) == 393);
static_assert(sizeof(fullmag_fem_accepted_external_lead_boundary_v1) == 40);
static_assert(offsetof(fullmag_fem_accepted_external_lead_boundary_v1, circuit_id) == 32);
static_assert(sizeof(fullmag_fem_accepted_external_lead_branch_v1) == 32);
static_assert(sizeof(fullmag_fem_accepted_external_lead_request_v1) == 496);
static_assert(alignof(fullmag_fem_accepted_external_lead_request_v1) == 8);
static_assert(offsetof(fullmag_fem_accepted_external_lead_request_v1, charge) == 16);
static_assert(offsetof(fullmag_fem_accepted_external_lead_request_v1, closure_revision) == 376);
static_assert(offsetof(fullmag_fem_accepted_external_lead_request_v1, target_xyz_m) == 448);
static_assert(offsetof(fullmag_fem_accepted_external_lead_request_v1, base_quadrature_order) == 464);
static_assert(offsetof(fullmag_fem_accepted_external_lead_request_v1, maximum_source_target_pairs) == 488);
static_assert(sizeof(fullmag_fem_accepted_external_lead_result_v1) == 656);
static_assert(alignof(fullmag_fem_accepted_external_lead_result_v1) == 8);
static_assert(offsetof(fullmag_fem_accepted_external_lead_result_v1, canonical_payload) == 16);
static_assert(offsetof(fullmag_fem_accepted_external_lead_result_v1, content_sha256) == 328);
static_assert(offsetof(fullmag_fem_accepted_external_lead_result_v1, error_message) == 393);
#endif

void set_error(fullmag_fem_accepted_terminal_charge_result_v1 *result, const char *message)
{
    if (result == nullptr || result->struct_size < sizeof(*result)) return;
    result->canonical_payload_len = 0;
    result->digest_schema[0] = '\0';
    result->operator_version[0] = '\0';
    result->layout_fingerprint[0] = '\0';
    result->content_sha256[0] = '\0';
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
}

void set_error(fullmag_fem_accepted_external_lead_result_v1 *result, const char *message)
{
    if (result == nullptr || result->struct_size < sizeof(*result)) return;
    result->canonical_payload_len = 0;
    result->digest_schema[0] = '\0';
    result->operator_version[0] = '\0';
    result->layout_fingerprint[0] = '\0';
    result->content_sha256[0] = '\0';
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
}

void set_error(fullmag_fem_steady_transport_result_v1 *result, const char *message)
{
    if (result == nullptr) {
        return;
    }
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
    result->diagnostics_json[0] = '\0';
}

void set_error(fullmag_fem_charge_transport_result_v1 *result, const char *message)
{
    if (result == nullptr) {
        return;
    }
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
    result->diagnostics_json[0] = '\0';
    result->electric_potential_v_len = 0;
    result->charge_current_density_xyz_apm2_len = 0;
    result->charge_converged = 0;
    result->charge_iterations = 0;
    result->charge_relative_residual = 0.0;
    result->net_boundary_current_a = 0.0;
    for (double &component : result->current_density_volume_average_apm2) {
        component = 0.0;
    }
}

void set_error(fullmag_fem_charge_transport_result_v3 *result, const char *message)
{
    if (result == nullptr) {
        return;
    }
    set_error(&result->base, message);
    result->terminal_voltages_v_len = 0;
    result->measured_outward_currents_a_len = 0;
    result->gauge_terminal_indices_len = 0;
}

void set_error(fullmag_fem_steady_transport_rt0_result_v1 *result, const char *message)
{
    if (result == nullptr) {
        return;
    }
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
    result->diagnostics_json[0] = '\0';
    result->converged = 0;
    result->rt0_dof_values_len = 0;
    result->canonical_face_records_len = 0;
    result->max_element_divergence_a = 0.0;
    result->max_internal_face_jump_a = 0.0;
    result->net_outer_flux_a = 0.0;
    result->electrode_balance_relative = 0.0;
    result->max_closure_interface_mismatch_a = 0.0;
    result->scaled_kkt_residual = 0.0;
    result->correction_norm_mw = 0.0;
    result->operator_version[0] = '\0';
    result->fe_space[0] = '\0';
    result->flux_unit[0] = '\0';
    result->canonical_face_digest[0] = '\0';
    result->balance_certificate_digest[0] = '\0';
    result->view_identity_digest[0] = '\0';
}

void set_error(
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *result,
    const char *message)
{
    if (result == nullptr) {
        return;
    }
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
    result->diagnostics_json[0] = '\0';
    result->h_xyz_apm_len = 0;
    result->source_target_pairs = 0;
    result->refined_pairs = 0;
    result->unconverged_pair_count = 0;
    result->maximum_pair_error_apm = 0.0;
    result->operator_version[0] = '\0';
    result->source_view_identity_digest[0] = '\0';
    set_error(&result->rt0, message);
}

void set_error(
    fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1 *result,
    const char *message)
{
    if (result == nullptr) {
        return;
    }
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
    result->diagnostics_json[0] = '\0';
    result->converged = 0;
    result->a_dofs_t_m_len = 0;
    result->gauge_dofs_apm_len = 0;
    result->compatible_b_dofs_t_len = 0;
    result->compatible_h_dofs_apm_len = 0;
    result->nodal_h_xyz_apm_len = 0;
    result->harmonic_count = 0;
    result->essential_nd_dof_count = 0;
    result->essential_h1_dof_count = 0;
    result->first_block_residual = 0.0;
    result->constraint_residual = 0.0;
    result->weak_ampere_residual = 0.0;
    result->compatible_divergence_residual = 0.0;
    result->source_pairing_norm = 0.0;
    result->operator_version[0] = '\0';
    result->source_view_identity_digest[0] = '\0';
    result->boundary_gauge_variant[0] = '\0';
    set_error(&result->rt0, message);
}

void set_error(
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *result,
    const char *message)
{
    if (result == nullptr || result->struct_size < sizeof(*result)) return;
    result->electric_potential_v_len = 0;
    result->stable_vertex_ids_len = 0;
    result->vertex_xyz_m_len = 0;
    result->stable_vertex_id_version[0] = '\0';
    result->source_view_identity_digest[0] = '\0';
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
}

void set_error(
    fullmag_fem_direct_oersted_snapshot_result_v1 *result,
    const char *message)
{
    if (result == nullptr || result->struct_size < sizeof(*result)) return;
    result->target_records_len = 0;
    result->source_target_pairs = 0;
    result->refined_pairs = 0;
    result->unconverged_pair_count = 0;
    result->maximum_pair_error_apm = 0.0;
    result->kernel_evaluations = 0;
    result->ledger_leaf_visits = 0;
    result->base_quadrature_order = 0;
    result->maximum_subdivision_depth = 0;
    result->absolute_tolerance_apm = 0.0;
    result->relative_tolerance = 0.0;
    result->relative_scale_floor_apm = 0.0;
    result->maximum_source_target_pairs = 0;
    result->maximum_final_leaves_per_target = 0;
    result->maximum_kernel_evaluations = 0;
    result->maximum_ledger_leaf_visits = 0;
    result->schema_version[0] = '\0';
    result->operator_version[0] = '\0';
    result->quadrature_scope[0] = '\0';
    result->estimated_error_policy[0] = '\0';
    result->roundoff_indicator_policy[0] = '\0';
    result->source_view_identity_digest[0] = '\0';
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
}

template <typename Result, typename Solve>
int call_with_charge_snapshot(Result *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *snapshot,
    Solve solve)
{
    if (snapshot == nullptr ||
        snapshot->abi_version != FULLMAG_FEM_STEADY_TRANSPORT_RT0_CHARGE_SNAPSHOT_ABI_VERSION ||
        snapshot->struct_size != sizeof(*snapshot) || snapshot->reserved_flags != 0) {
        const char *message = "RT0 charge snapshot result ABI header mismatch";
        if (result == nullptr || result->struct_size >= sizeof(*result)) {
            set_error(result, message);
        }
        set_error(snapshot, message);
        return FULLMAG_FEM_ERR_INVALID;
    }
    set_error(snapshot, "");
    if (result != nullptr && result->struct_size < sizeof(*result)) {
        set_error(snapshot, "RT0 result ABI size is smaller than its layout");
        return FULLMAG_FEM_ERR_INVALID;
    }
    const int status = solve();
    if (status != FULLMAG_FEM_OK) {
        set_error(snapshot, result != nullptr ? result->error_message
            : "RT0 charge snapshot requires a non-null result");
    }
    return status;
}

#if FULLMAG_HAS_MFEM_STACK

constexpr const char *kConstitutiveVersion =
    "transport_constitutive.one_way.fullmag.v1";
constexpr const char *kOperatorVersion =
    "fem_charge_spin_conforming_h1_p1.transparent.v1";
constexpr const char *kM2ConstitutiveVersion =
    "transport_constitutive.reciprocal.fullmag.v1";
constexpr const char *kM2OperatorVersion =
    "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
constexpr const char *kPhysicalResidualVersion =
    "transport_balance_integrated_l2.v1";
constexpr const char *kChargeConstitutiveVersion =
    FULLMAG_FEM_CHARGE_TRANSPORT_CONSTITUTIVE_VERSION;
constexpr const char *kChargeOperatorVersion =
    FULLMAG_FEM_CHARGE_TRANSPORT_OPERATOR_VERSION;
constexpr const char *kChargePhysicalResidualVersion =
    FULLMAG_FEM_CHARGE_TRANSPORT_PHYSICAL_RESIDUAL_VERSION;

bool equals(const char *actual, const char *expected)
{
    return actual != nullptr && std::strcmp(actual, expected) == 0;
}

template <typename T>
bool pointer_matches_count(const T *pointer, uint64_t count)
{
    return (count == 0 && pointer == nullptr) || (count > 0 && pointer != nullptr);
}

struct MeshView {
    uint64_t n_nodes = 0;
    uint64_t n_elements = 0;
    std::vector<uint32_t> elements;
    std::vector<uint32_t> boundary_faces;
    std::vector<uint32_t> boundary_markers;
};

MeshView make_mesh_view(
    const fullmag_fem_mesh_desc &descriptor,
    bool include_periodic_seam_facets = false)
{
    if (descriptor.abi_version != FULLMAG_FEM_MESH_DESC_ABI_VERSION ||
        descriptor.struct_size != sizeof(fullmag_fem_mesh_desc)) {
        throw std::invalid_argument("steady transport mesh descriptor ABI mismatch");
    }
    if (descriptor.nodes_xyz_len == 0 || descriptor.nodes_xyz == nullptr ||
        descriptor.nodes_xyz_len % 3u != 0u) {
        throw std::invalid_argument("steady transport requires xyz coordinates for every node");
    }
    if (descriptor.cell_types_len == 0 || descriptor.cell_types == nullptr ||
        descriptor.cell_offsets == nullptr ||
        descriptor.cell_offsets_len != descriptor.cell_types_len + 1u ||
        descriptor.cell_nodes == nullptr || descriptor.cell_nodes_len == 0u) {
        throw std::invalid_argument("steady transport requires a typed CSR cell mesh");
    }
    if (descriptor.facet_types == nullptr || descriptor.facet_roles == nullptr ||
        descriptor.facet_offsets == nullptr || descriptor.facet_markers == nullptr ||
        descriptor.facet_offsets_len != descriptor.facet_types_len + 1u ||
        descriptor.facet_roles_len != descriptor.facet_types_len ||
        descriptor.facet_markers_len != descriptor.facet_types_len ||
        descriptor.facet_nodes == nullptr || descriptor.facet_nodes_len == 0u) {
        throw std::invalid_argument("steady transport requires typed facet topology and markers");
    }

    MeshView view;
    view.n_nodes = descriptor.nodes_xyz_len / 3u;
    view.n_elements = descriptor.cell_types_len;
    view.elements.reserve(static_cast<size_t>(view.n_elements) * 4u);
    for (uint64_t element = 0; element < view.n_elements; ++element) {
        if (descriptor.cell_types[element] != FULLMAG_FEM_CELL_TET4) {
            throw std::domain_error("FEM steady transport currently requires tetrahedral cells");
        }
        const uint64_t begin = descriptor.cell_offsets[element];
        const uint64_t end = descriptor.cell_offsets[element + 1u];
        if (end < begin || end - begin != 4u || end > descriptor.cell_nodes_len) {
            throw std::invalid_argument("tetrahedral cell CSR offsets are invalid");
        }
        for (uint64_t local = begin; local < end; ++local) {
            const uint32_t node = descriptor.cell_nodes[local];
            if (node >= view.n_nodes) {
                throw std::invalid_argument("tetrahedron references a node outside the mesh");
            }
            view.elements.push_back(node);
        }
    }

    for (uint64_t facet = 0; facet < descriptor.facet_types_len; ++facet) {
        const uint32_t facet_role = descriptor.facet_roles[facet];
        if (facet_role != FULLMAG_FEM_FACET_ROLE_EXTERIOR &&
            !(include_periodic_seam_facets &&
                facet_role == FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM)) {
            continue;
        }
        if (descriptor.facet_types[facet] != FULLMAG_FEM_FACET_TRI3) {
            throw std::domain_error("FEM steady transport currently requires triangular exterior facets");
        }
        const uint64_t begin = descriptor.facet_offsets[facet];
        const uint64_t end = descriptor.facet_offsets[facet + 1u];
        if (end < begin || end - begin != 3u || end > descriptor.facet_nodes_len) {
            throw std::invalid_argument("exterior facet CSR offsets are invalid");
        }
        const uint32_t marker = descriptor.facet_markers[facet];
        if (marker == 0u) {
            throw std::invalid_argument("MFEM boundary attributes must be positive");
        }
        for (uint64_t local = begin; local < end; ++local) {
            const uint32_t node = descriptor.facet_nodes[local];
            if (node >= view.n_nodes) {
                throw std::invalid_argument("boundary triangle references a node outside the mesh");
            }
            view.boundary_faces.push_back(node);
        }
        view.boundary_markers.push_back(marker);
    }
    if (view.boundary_markers.empty()) {
        throw std::invalid_argument("steady transport requires explicit exterior triangular facets");
    }
    return view;
}

void validate_request_header(
    const fullmag_fem_steady_transport_request_v1 &request,
    const fullmag_fem_steady_transport_result_v1 &result)
{
    if (request.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport request abi_version must be 1");
    }
    if (request.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("steady transport request struct_size mismatch");
    }
    if (result.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport result abi_version must be 1");
    }
    if (result.struct_size != sizeof(fullmag_fem_steady_transport_result_v1)) {
        throw std::invalid_argument("steady transport result struct_size mismatch");
    }
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error(
            "FEM steady spin transport GPU is unavailable; strict requests cannot fall back to CPU");
    }
    if (request.execution_lane != FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE) {
        throw std::invalid_argument("unknown FEM steady transport execution lane");
    }
    if (request.interface_model == FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1) {
        throw std::domain_error(
            "mixing/SML transport requires the unavailable broken-H1 mortar realization");
    }
    if (request.interface_model !=
        FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1) {
        throw std::invalid_argument("unknown FEM steady transport interface model");
    }
    if (request.reserved_flags != 0 || result.reserved_flags != 0) {
        throw std::invalid_argument("steady transport reserved_flags must be zero");
    }
}

void validate_request(
    const fullmag_fem_steady_transport_request_v1 &request,
    const fullmag_fem_steady_transport_result_v1 &result,
    const MeshView &mesh,
    const char *expected_constitutive_version = kConstitutiveVersion,
    const char *expected_operator_version = kOperatorVersion)
{
    validate_request_header(request, result);
    if (request.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport request abi_version must be 1");
    }
    if (request.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("steady transport request struct_size mismatch");
    }
    if (result.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport result abi_version must be 1");
    }
    if (result.struct_size != sizeof(fullmag_fem_steady_transport_result_v1)) {
        throw std::invalid_argument("steady transport result struct_size mismatch");
    }
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error(
            "FEM steady spin transport GPU is unavailable; strict requests cannot fall back to CPU");
    }
    if (request.execution_lane != FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE) {
        throw std::invalid_argument("unknown FEM steady transport execution lane");
    }
    if (request.interface_model == FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1) {
        throw std::domain_error(
            "mixing/SML transport requires the unavailable broken-H1 mortar realization");
    }
    if (request.interface_model !=
        FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1) {
        throw std::invalid_argument("unknown FEM steady transport interface model");
    }
    if (!equals(request.constitutive_version, expected_constitutive_version) ||
        !equals(request.operator_version, expected_operator_version) ||
        !equals(request.physical_residual_version, kPhysicalResidualVersion)) {
        throw std::invalid_argument(
            "unsupported FEM steady transport constitutive/operator/residual version");
    }
    if (request.reserved_flags != 0 || result.reserved_flags != 0) {
        throw std::invalid_argument("steady transport reserved_flags must be zero");
    }
    if (request.mesh.periodic_node_pairs != nullptr ||
        request.mesh.periodic_node_pairs_len != 0 ||
        request.mesh.periodic_boundary_pair_markers != nullptr ||
        request.mesh.periodic_boundary_pair_markers_len != 0) {
        throw std::domain_error("PeriodicSpin is not implemented by the FEM conforming-H1 M1 oracle");
    }
    if (!pointer_matches_count(
            request.charge_conductivity_spm_per_element,
            request.charge_conductivity_spm_per_element_len) ||
        request.charge_conductivity_spm_per_element_len != mesh.n_elements) {
        throw std::invalid_argument("charge conductivity must contain one value per tetrahedron");
    }
    if (request.magnetization_xyz == nullptr ||
        request.magnetization_xyz_len != static_cast<uint64_t>(mesh.n_nodes) * 3u) {
        throw std::invalid_argument("magnetization_xyz length must equal 3*n_nodes");
    }
    if (!pointer_matches_count(
            request.charge_dirichlet_boundary_attributes,
            request.charge_dirichlet_count) ||
        !pointer_matches_count(request.charge_dirichlet_values_v, request.charge_dirichlet_count)) {
        throw std::invalid_argument("charge Dirichlet attributes and values must have equal presence");
    }
    if (!pointer_matches_count(
            request.spin_dirichlet_boundary_attributes,
            request.spin_dirichlet_count) ||
        (request.spin_dirichlet_count > 0 && request.spin_dirichlet_values_v == nullptr)) {
        throw std::invalid_argument("spin Dirichlet attributes require three values per attribute");
    }
    if (request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE &&
        request.charge_dirichlet_count == 0) {
        throw std::invalid_argument("boundary-reference charge gauge requires an electrode");
    }
    if (request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL &&
        request.charge_dirichlet_count != 0) {
        throw std::invalid_argument("zero-mean charge gauge conflicts with fixed-potential electrodes");
    }
    if (request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE &&
        request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL) {
        throw std::invalid_argument("unknown steady transport charge gauge");
    }
    if (request.absolute_tolerance != 0.0) {
        throw std::domain_error(
            "FEM M1 steady transport absolute_tolerance is not implemented; use zero");
    }

    const uint64_t nodes = mesh.n_nodes;
    const auto require_output = [](const double *pointer, uint64_t actual, uint64_t expected,
                                   const char *label) {
        if (pointer == nullptr || actual < expected) {
            throw std::invalid_argument(label);
        }
    };
    require_output(result.electric_potential_v, result.electric_potential_v_len, nodes,
        "electric_potential_v output capacity is smaller than n_nodes");
    require_output(result.charge_current_density_xyz_apm2,
        result.charge_current_density_xyz_apm2_len, 3u * nodes,
        "charge current output capacity is smaller than 3*n_nodes");
    require_output(result.spin_potential_xyz_v, result.spin_potential_xyz_v_len, 3u * nodes,
        "spin potential output capacity is smaller than 3*n_nodes");
    require_output(result.spin_current_tensor_row_major_qia_apm2,
        result.spin_current_tensor_row_major_qia_apm2_len, 9u * nodes,
        "spin current tensor output capacity is smaller than 9*n_nodes");
    require_output(result.torque_xyz_per_s, result.torque_xyz_len, 3u * nodes,
        "transport torque output capacity is smaller than 3*n_nodes");

    for (uint64_t i = 0; i < 3u * nodes; ++i) {
        if (!std::isfinite(request.magnetization_xyz[i])) {
            throw std::invalid_argument("magnetization_xyz must be finite");
        }
    }
    for (uint64_t i = 0; i < mesh.n_elements; ++i) {
        const double sigma = request.charge_conductivity_spm_per_element[i];
        if (!(std::isfinite(sigma) && sigma > 0.0)) {
            throw std::invalid_argument("charge conductivity must be finite and positive");
        }
    }
}

void validate_charge_request_header(
    const fullmag_fem_charge_transport_request_v1 &request,
    const fullmag_fem_charge_transport_result_v1 &result)
{
    if (request.abi_version != FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION ||
        request.struct_size != sizeof(fullmag_fem_charge_transport_request_v1)) {
        throw std::invalid_argument("charge transport request ABI header mismatch");
    }
    if (result.abi_version != FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION ||
        result.struct_size != sizeof(fullmag_fem_charge_transport_result_v1)) {
        throw std::invalid_argument("charge transport result ABI header mismatch");
    }
    if (request.reserved_flags != 0 || result.reserved_flags != 0) {
        throw std::invalid_argument("charge transport reserved_flags must be zero");
    }
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error(
            "FEM charge transport GPU is unavailable; strict requests cannot fall back to CPU");
    }
    if (request.execution_lane != FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE) {
        throw std::invalid_argument("unknown FEM charge transport execution lane");
    }
}

void validate_charge_request(
    const fullmag_fem_charge_transport_request_v1 &request,
    const fullmag_fem_charge_transport_result_v1 &result,
    const MeshView &mesh,
    bool prescribed_terminal_currents = false)
{
    validate_charge_request_header(request, result);
    if (!equals(request.constitutive_version, kChargeConstitutiveVersion) ||
        !equals(request.operator_version, kChargeOperatorVersion) ||
        !equals(request.physical_residual_version, kChargePhysicalResidualVersion)) {
        throw std::invalid_argument(
            "unsupported FEM charge transport constitutive/operator/residual version");
    }
    if (request.mesh.periodic_node_pairs != nullptr ||
        request.mesh.periodic_node_pairs_len != 0 ||
        request.mesh.periodic_boundary_pair_markers != nullptr ||
        request.mesh.periodic_boundary_pair_markers_len != 0) {
        throw std::domain_error(
            "periodic charge transport requires a separately versioned realization");
    }
    if (!pointer_matches_count(
            request.charge_conductivity_spm_per_element,
            request.charge_conductivity_spm_per_element_len) ||
        request.charge_conductivity_spm_per_element_len != mesh.n_elements) {
        throw std::invalid_argument(
            "charge conductivity must contain one value per tetrahedron");
    }
    if (!pointer_matches_count(
            request.dirichlet_boundary_attributes,
            request.dirichlet_boundary_count) ||
        !pointer_matches_count(
            request.dirichlet_boundary_values_v,
            request.dirichlet_boundary_count)) {
        throw std::invalid_argument(
            "charge Dirichlet attributes and values must have equal presence");
    }
    if (!prescribed_terminal_currents &&
        request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE &&
        request.dirichlet_boundary_count == 0) {
        throw std::invalid_argument(
            "boundary-reference charge gauge requires an electrode");
    }
    if (request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL &&
        request.dirichlet_boundary_count != 0) {
        throw std::invalid_argument(
            "zero-mean charge gauge conflicts with fixed-potential electrodes");
    }
    if (request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE &&
        request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL) {
        throw std::invalid_argument("unknown FEM charge transport gauge");
    }
    if (!(std::isfinite(request.relative_tolerance) &&
            request.relative_tolerance > 0.0 && request.relative_tolerance < 1.0)) {
        throw std::invalid_argument(
            "charge transport relative_tolerance must be finite and lie in (0, 1)");
    }
    if (request.absolute_tolerance != 0.0) {
        throw std::domain_error(
            "FEM charge transport absolute_tolerance is not implemented; use zero");
    }
    if (request.maximum_iterations == 0 ||
        request.maximum_iterations > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
        throw std::invalid_argument(
            "charge transport maximum_iterations must fit a positive int");
    }
    if (result.electric_potential_v == nullptr ||
        result.electric_potential_v_capacity < mesh.n_nodes) {
        throw std::invalid_argument(
            "electric_potential_v output capacity is smaller than n_nodes");
    }
    if (result.charge_current_density_xyz_apm2 == nullptr ||
        result.charge_current_density_xyz_apm2_capacity < 3u * mesh.n_nodes) {
        throw std::invalid_argument(
            "charge current output capacity is smaller than 3*n_nodes");
    }
    for (uint64_t i = 0; i < mesh.n_elements; ++i) {
        const double sigma = request.charge_conductivity_spm_per_element[i];
        if (!(std::isfinite(sigma) && sigma > 0.0)) {
            throw std::invalid_argument(
                "charge conductivity must be finite and positive");
        }
    }
}

std::unique_ptr<mfem::Mesh> import_mesh(
    const fullmag_fem_mesh_desc &descriptor,
    const MeshView &view,
    bool accepted_geometry_preflight = false)
{
    auto mesh = std::make_unique<mfem::Mesh>(
        3,
        static_cast<int>(view.n_nodes),
        static_cast<int>(view.n_elements),
        static_cast<int>(view.boundary_markers.size()),
        3);
    for (uint32_t node = 0; node < view.n_nodes; ++node) {
        mesh->AddVertex(descriptor.nodes_xyz + static_cast<size_t>(node) * 3u);
    }
    for (uint32_t element = 0; element < view.n_elements; ++element) {
        const uint32_t *indices = view.elements.data() + static_cast<size_t>(element) * 4u;
        int tetrahedron[4];
        for (int local = 0; local < 4; ++local) {
            tetrahedron[local] = static_cast<int>(indices[local]);
        }
        // Legacy material coefficients index unique attributes. The accepted
        // scalar workflow indexes ElementNo and preserves explicit markers.
        const int attribute = accepted_geometry_preflight && descriptor.cell_markers_len != 0
            ? static_cast<int>(descriptor.cell_markers[element]) : static_cast<int>(element + 1u);
        mesh->AddTet(tetrahedron, attribute);
    }
    for (uint32_t boundary = 0; boundary < view.boundary_markers.size(); ++boundary) {
        const uint32_t *indices = view.boundary_faces.data() + static_cast<size_t>(boundary) * 3u;
        int triangle[3];
        for (int local = 0; local < 3; ++local) {
            triangle[local] = static_cast<int>(indices[local]);
        }
        const uint32_t attribute = view.boundary_markers[boundary];
        mesh->AddBdrTriangle(triangle, static_cast<int>(attribute));
    }
    if (accepted_geometry_preflight) {
        fullmag::fem::transport::validate_terminal_current_mesh(*mesh);
    }
    mesh->FinalizeTopology();
    mesh->Finalize(false, true);
    return mesh;
}

using Rt0FaceKey = std::array<std::uint64_t, 3>;

void rt0_require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::invalid_argument(message);
    }
}

std::string rt0_string(const char *value, const char *name, bool allow_empty = false)
{
    rt0_require(value != nullptr, std::string(name) + " must not be null");
    const std::size_t length = std::strlen(value);
    rt0_require(length <= 4096, std::string(name) + " exceeds the ABI string limit");
    if (!allow_empty) {
        rt0_require(length != 0, std::string(name) + " must not be empty");
    }
    return std::string(value, length);
}

Rt0FaceKey rt0_sorted_face_key(const std::uint64_t *vertices)
{
    rt0_require(vertices != nullptr, "RT0 face vertex IDs must not be null");
    Rt0FaceKey key{vertices[0], vertices[1], vertices[2]};
    std::sort(key.begin(), key.end());
    rt0_require(key[0] != 0 && key[0] < key[1] && key[1] < key[2],
        "RT0 stable face vertex IDs must be nonzero and strictly increasing");
    return key;
}

Rt0FaceKey rt0_mesh_boundary_key(
    const mfem::Mesh &mesh,
    const fullmag::fem::transport::StableMeshVertexIdentities &ids,
    int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary, vertices);
    rt0_require(vertices.Size() == 3, "RT0 boundary face must be triangular");
    std::uint64_t stable[3]{};
    for (int local = 0; local < 3; ++local) {
        rt0_require(vertices[local] >= 0 &&
                static_cast<std::size_t>(vertices[local]) < ids.local_to_stable.size(),
            "RT0 boundary face references an unknown stable vertex");
        stable[local] = ids.local_to_stable.at(static_cast<std::size_t>(vertices[local]));
    }
    return rt0_sorted_face_key(stable);
}

fullmag::fem::transport::StableMeshVertexIdentities rt0_stable_ids(
    const fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1 &descriptor,
    const MeshView &mesh)
{
    fullmag::fem::transport::StableMeshVertexIdentities ids;
    ids.version = rt0_string(descriptor.version, "stable vertex identity version");
    rt0_require(descriptor.local_to_stable_vertex_ids != nullptr &&
            descriptor.local_to_stable_vertex_ids_len == mesh.n_nodes,
        "stable vertex identity count must equal mesh vertex count");
    ids.local_to_stable.assign(
        descriptor.local_to_stable_vertex_ids,
        descriptor.local_to_stable_vertex_ids + descriptor.local_to_stable_vertex_ids_len);
    std::set<std::uint64_t> unique;
    for (const auto value : ids.local_to_stable) {
        rt0_require(value != 0 && unique.insert(value).second,
            "stable vertex identities must be nonzero and unique");
    }
    return ids;
}

std::string accepted_charge_string(const char *value, const char *name)
{
    rt0_require(value != nullptr, std::string(name) + " must not be null");
    std::size_t length = 0;
    while (length <= 4096 && value[length] != '\0') ++length;
    rt0_require(length != 0 && length <= 4096,
        std::string(name) + " must be nonempty and at most 4096 bytes");
    return std::string(value, length);
}

MeshView validate_accepted_charge_input_mesh(const fullmag_fem_mesh_desc &mesh)
{
    const std::uint64_t maximum_elements = fullmag::fem::transport::ConservativeConstraintRank::kMaximumRows;
    rt0_require(mesh.abi_version == FULLMAG_FEM_MESH_DESC_ABI_VERSION &&
            mesh.struct_size == sizeof(mesh), "accepted charge mesh ABI mismatch");
    rt0_require(mesh.cell_types_len > 0 && mesh.cell_types_len <= maximum_elements &&
            mesh.nodes_xyz_len > 0 && mesh.nodes_xyz_len % 3 == 0 &&
            mesh.nodes_xyz_len / 3 <= 4 * mesh.cell_types_len &&
            mesh.facet_types_len > 0 && mesh.facet_types_len <= 4 * mesh.cell_types_len,
        "accepted charge mesh counts exceed bounded tetrahedral support");
    rt0_require(mesh.cell_nodes_len == 4 * mesh.cell_types_len &&
            mesh.facet_nodes_len == 3 * mesh.facet_types_len,
        "accepted charge mesh requires complete tet4/tri3 CSR");
    const auto optional_count = [](const auto *pointer, std::uint64_t length, std::uint64_t expected) {
        return pointer_matches_count(pointer, length) && (length == 0 || length == expected);
    };
    rt0_require(optional_count(mesh.cell_markers, mesh.cell_markers_len, mesh.cell_types_len) &&
            optional_count(mesh.cell_global_ordinals, mesh.cell_global_ordinals_len, mesh.cell_types_len) &&
            optional_count(mesh.facet_global_ordinals, mesh.facet_global_ordinals_len, mesh.facet_types_len),
        "accepted charge optional mesh arrays have inconsistent pointer/count");
    if (mesh.periodic_node_pairs != nullptr || mesh.periodic_node_pairs_len != 0 ||
        mesh.periodic_boundary_pair_markers != nullptr || mesh.periodic_boundary_pair_markers_len != 0) {
        throw std::domain_error("accepted terminal charge does not support periodic mesh metadata");
    }
    rt0_require(mesh.facet_roles != nullptr && mesh.facet_roles_len == mesh.facet_types_len,
        "accepted charge facet role pointer/count is invalid");
    for (std::uint64_t facet = 0; facet < mesh.facet_roles_len; ++facet) {
        if (mesh.facet_roles[facet] == FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM) {
            throw std::domain_error("accepted terminal charge does not support periodic seams");
        }
    }
    // Existing importer checks the remaining required pointers and CSR ranges.
    auto view = make_mesh_view(mesh);
    rt0_require(mesh.cell_offsets[0] == 0 && mesh.cell_offsets[mesh.cell_types_len] == mesh.cell_nodes_len &&
            mesh.facet_offsets[0] == 0 && mesh.facet_offsets[mesh.facet_types_len] == mesh.facet_nodes_len,
        "accepted charge CSR must start at zero and consume the full node arrays");
    for (std::uint64_t index = 0; index < mesh.nodes_xyz_len; ++index) {
        rt0_require(std::isfinite(mesh.nodes_xyz[index]), "accepted charge coordinates must be finite");
    }
    for (std::uint64_t index = 0; index < mesh.cell_markers_len; ++index) {
        rt0_require(mesh.cell_markers[index] > 0 && mesh.cell_markers[index] <= static_cast<std::uint32_t>(INT_MAX),
            "accepted charge cell markers must be positive and representable");
    }
    using LocalFace = std::array<std::uint32_t, 3>;
    std::map<LocalFace, unsigned> incidence;
    for (std::uint64_t element = 0; element < view.n_elements; ++element) {
        const auto *vertices = view.elements.data() + 4 * element;
        std::array<std::uint32_t, 4> unique{vertices[0], vertices[1], vertices[2], vertices[3]};
        std::sort(unique.begin(), unique.end());
        rt0_require(std::adjacent_find(unique.begin(), unique.end()) == unique.end(),
            "accepted charge tetrahedron repeats a vertex");
        for (unsigned opposite = 0; opposite < 4; ++opposite) {
            LocalFace key{};
            unsigned corner = 0;
            for (unsigned local = 0; local < 4; ++local) if (local != opposite) key[corner++] = vertices[local];
            std::sort(key.begin(), key.end());
            rt0_require(++incidence[key] <= 2, "accepted charge mesh has nonmanifold face incidence");
        }
    }
    std::set<LocalFace> declared, exterior;
    for (std::uint64_t facet = 0; facet < mesh.facet_types_len; ++facet) {
        const auto role = mesh.facet_roles[facet];
        if (role == FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM) {
            throw std::domain_error("accepted terminal charge does not support periodic seams");
        }
        rt0_require(role == FULLMAG_FEM_FACET_ROLE_EXTERIOR || role == FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE,
            "accepted charge facet has an unknown role");
        const auto begin = mesh.facet_offsets[facet], end = mesh.facet_offsets[facet + 1];
        rt0_require(mesh.facet_types[facet] == FULLMAG_FEM_FACET_TRI3 && end >= begin &&
                end - begin == 3 && end <= mesh.facet_nodes_len,
            "accepted charge facet CSR is not triangular");
        LocalFace key{};
        for (unsigned corner = 0; corner < 3; ++corner) {
            key[corner] = mesh.facet_nodes[begin + corner];
            rt0_require(key[corner] < view.n_nodes, "accepted charge facet references an unknown node");
        }
        std::sort(key.begin(), key.end());
        rt0_require(declared.insert(key).second && incidence.count(key) == 1,
            "accepted charge facet is repeated or not an actual tetrahedral face");
        if (role == FULLMAG_FEM_FACET_ROLE_EXTERIOR) {
            rt0_require(incidence.at(key) == 1 && mesh.facet_markers[facet] > 0 &&
                    mesh.facet_markers[facet] <= static_cast<std::uint32_t>(INT_MAX),
                "accepted charge exterior facet is interior or has an invalid marker");
            exterior.insert(key);
        } else {
            rt0_require(incidence.at(key) == 2, "accepted charge material interface must be an interior face");
        }
    }
    for (const auto &[key, count] : incidence) {
        if (count == 1) rt0_require(exterior.count(key) == 1,
            "accepted charge exterior boundary is incomplete");
    }
    return view;
}

void copy_rt0_text(char *destination, std::size_t capacity, const std::string &value, const char *name);

struct ResolvedAcceptedChargeRequest {
    std::unique_ptr<mfem::Mesh> mesh;
    fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest charge;
};

ResolvedAcceptedChargeRequest resolve_accepted_charge_request(
    const fullmag_fem_accepted_terminal_charge_request_v1 &request)
{
    rt0_require(request.abi_version == FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION &&
            request.struct_size == sizeof(request) && request.reserved_flags == 0,
        "accepted terminal charge ABI header mismatch");
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error("accepted terminal charge requires CPU/double; GPU has no silent fallback");
    }
    rt0_require(request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE &&
            request.reserved_execution == 0 && request.reserved_solver == 0,
        "accepted terminal charge execution/solver header is invalid");
    rt0_require(request.maximum_iterations > 0 && request.maximum_iterations <= static_cast<std::uint32_t>(INT_MAX) &&
            std::isfinite(request.absolute_jump_tolerance_v) && request.absolute_jump_tolerance_v >= 0 &&
            std::isfinite(request.relative_jump_tolerance) && request.relative_jump_tolerance >= 0 &&
            std::isfinite(request.algebraic_relative_tolerance) && request.algebraic_relative_tolerance > 0 &&
            request.algebraic_relative_tolerance < 1,
        "accepted terminal charge solver policy is invalid");
    const auto view = validate_accepted_charge_input_mesh(request.mesh);
    rt0_require(request.conductivity_spm_per_element != nullptr &&
            request.conductivity_spm_per_element_len == view.n_elements,
        "accepted terminal charge conductivity count must equal element count");
    rt0_require(request.terminals != nullptr && request.terminal_count > 0 &&
            request.terminal_count <= view.boundary_markers.size() &&
            pointer_matches_count(request.interfaces, request.interface_count) &&
            request.interface_count <= view.boundary_markers.size() / 2,
        "accepted terminal charge terminal/interface pointer/count is invalid");
    (void)accepted_charge_string(request.stable_vertex_identities.version, "stable vertex version");
    fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest charge;
    charge.stable_vertex_identities = rt0_stable_ids(request.stable_vertex_identities, view);
    charge.conductivity_spm_per_element.assign(request.conductivity_spm_per_element,
        request.conductivity_spm_per_element + request.conductivity_spm_per_element_len);
    charge.absolute_jump_tolerance_v = request.absolute_jump_tolerance_v;
    charge.relative_jump_tolerance = request.relative_jump_tolerance;
    charge.algebraic_relative_tolerance = request.algebraic_relative_tolerance;
    charge.maximum_iterations = static_cast<int>(request.maximum_iterations);
    std::uint64_t terminal_faces = 0;
    for (std::uint64_t index = 0; index < request.terminal_count; ++index) {
        const auto &input = request.terminals[index];
        rt0_require(input.boundary_face_vertex_ids != nullptr && input.face_count > 0 &&
                input.face_count <= view.boundary_markers.size() - terminal_faces &&
                std::isfinite(input.requested_outward_current_a),
            "accepted terminal charge face pointer/count or current is invalid");
        terminal_faces += input.face_count;
        fullmag::fem::antenna_field_solve::ResolvedChargeTerminal terminal;
        terminal.id = accepted_charge_string(input.id, "terminal ID");
        terminal.requested_outward_current_a = input.requested_outward_current_a;
        for (std::uint64_t face = 0; face < input.face_count; ++face) {
            terminal.boundary_face_vertex_ids.push_back({input.boundary_face_vertex_ids[3 * face],
                input.boundary_face_vertex_ids[3 * face + 1], input.boundary_face_vertex_ids[3 * face + 2]});
        }
        charge.terminals.push_back(std::move(terminal));
    }
    for (std::uint64_t index = 0; index < request.interface_count; ++index) {
        const auto &input = request.interfaces[index];
        fullmag::fem::transport::Rt0InterfaceFacePair pair;
        pair.id = accepted_charge_string(input.id, "interface ID");
        for (unsigned corner = 0; corner < 3; ++corner) {
            pair.first_face_vertex_ids[corner] = input.first_face_vertex_ids[corner];
            pair.second_face_vertex_ids[corner] = input.second_face_vertex_ids[corner];
            for (unsigned side = 0; side < 2; ++side) pair.vertex_pairs[corner][side] = input.vertex_pairs[corner][side];
        }
        charge.interface_pairs.push_back(std::move(pair));
    }
    auto mesh = import_mesh(request.mesh, view, true);
    charge.mesh = mesh.get();
    return {std::move(mesh), std::move(charge)};
}

int solve_accepted_terminal_charge(const fullmag_fem_accepted_terminal_charge_request_v1 &request,
    fullmag_fem_accepted_terminal_charge_result_v1 &result)
{
    static_assert(fullmag::fem::antenna_field_solve::AcceptedTerminalChargeSource::maximum_digest_preimage_bytes ==
        FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_MAX_PAYLOAD_BYTES, "accepted charge payload limits differ");
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error("accepted terminal charge requires CPU/double; GPU has no silent fallback");
    }
    rt0_require(result.canonical_payload != nullptr && result.canonical_payload_capacity > 0 &&
            result.canonical_payload_capacity <= FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_MAX_PAYLOAD_BYTES,
        "accepted terminal charge payload pointer/capacity is invalid");
    const auto resolved = resolve_accepted_charge_request(request);
    const auto source = fullmag::fem::antenna_field_solve::solve_accepted_terminal_charge_source(resolved.charge);
    const auto &payload = source->canonical_content_bytes();
    rt0_require(!payload.empty() && payload.size() <= result.canonical_payload_capacity,
        "accepted terminal charge payload capacity is insufficient");
    rt0_require(source->content_digest().size() == 64, "accepted terminal charge digest is invalid");
    copy_rt0_text(result.digest_schema, sizeof(result.digest_schema), source->digest_schema, "digest schema");
    copy_rt0_text(result.operator_version, sizeof(result.operator_version), source->operator_version, "operator version");
    copy_rt0_text(result.layout_fingerprint, sizeof(result.layout_fingerprint),
        FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_LAYOUT_FINGERPRINT, "accepted charge ABI fingerprint");
    copy_rt0_text(result.content_sha256, sizeof(result.content_sha256), source->content_digest(), "content digest");
    std::copy(payload.begin(), payload.end(), result.canonical_payload);
    result.canonical_payload_len = payload.size();
    result.error_message[0] = '\0';
    return FULLMAG_FEM_OK;
}

int solve_accepted_external_lead(const fullmag_fem_accepted_external_lead_request_v1 &request,
    fullmag_fem_accepted_external_lead_result_v1 &result)
{
    namespace workflow = fullmag::fem::antenna_field_solve;
    static_assert(workflow::AcceptedTerminalChargeSource::maximum_digest_preimage_bytes ==
        FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES, "external lead bundle payload limits differ");
    rt0_require(request.charge.abi_version == FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION &&
            request.charge.struct_size == sizeof(request.charge) && request.charge.reserved_flags == 0,
        "external lead bundle nested charge ABI header mismatch");
    if (request.charge.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error("accepted external lead bundle requires CPU/double; GPU has no silent fallback");
    }
    rt0_require(result.canonical_payload != nullptr && result.canonical_payload_capacity > 0 &&
            result.canonical_payload_capacity <= FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES,
        "external lead bundle payload pointer/capacity is invalid");
    rt0_require(request.base_quadrature_order >= 2 && request.base_quadrature_order <= 16 &&
            request.maximum_subdivision_depth >= 0 && request.maximum_subdivision_depth <= 6 &&
            std::isfinite(request.absolute_tolerance_apm) && request.absolute_tolerance_apm >= 0 &&
            std::isfinite(request.relative_tolerance) && request.relative_tolerance >= 0 &&
            request.maximum_source_target_pairs > 0 && request.maximum_source_target_pairs <= 1'000'000 &&
            pointer_matches_count(request.target_xyz_m, request.target_count) &&
            request.target_count <= request.maximum_source_target_pairs,
        "external lead bundle quadrature policy or target pointer/count is invalid");
    // Each ordered target contributes 252 bytes before the fixed field/bundle headers.
    rt0_require(request.target_count <= FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES / 252,
        "external lead bundle target record exceeds its preflight budget");
    const auto resolved = resolve_accepted_charge_request(request.charge);
    const auto vertices = static_cast<std::uint64_t>(resolved.mesh->GetNV());
    const auto boundary_count = static_cast<std::uint64_t>(resolved.mesh->GetNBE());
    rt0_require(request.device_vertex_ids != nullptr && request.lead_vertex_ids != nullptr &&
            request.device_vertex_count > 0 && request.device_vertex_count <= vertices &&
            request.lead_vertex_count > 0 && request.lead_vertex_count == vertices - request.device_vertex_count,
        "external lead bundle partition pointer/count is invalid");
    rt0_require(request.boundary_faces != nullptr && request.boundary_face_count == boundary_count &&
            request.branches != nullptr && request.branch_count > 0 &&
            request.branch_count <= resolved.charge.interface_pairs.size(),
        "external lead bundle boundary/branch pointer/count is invalid");
    rt0_require(request.target_count == 0 || static_cast<std::uint64_t>(resolved.mesh->GetNE()) <=
            request.maximum_source_target_pairs / request.target_count,
        "external lead bundle exceeds its source-target pair budget");
    workflow::AcceptedExternalLeadSourceRequest closure;
    closure.closure_revision = accepted_charge_string(request.closure_revision, "closure revision");
    closure.device_vertex_ids.assign(request.device_vertex_ids,
        request.device_vertex_ids + request.device_vertex_count);
    closure.lead_vertex_ids.assign(request.lead_vertex_ids, request.lead_vertex_ids + request.lead_vertex_count);
    for (std::uint64_t index = 0; index < request.boundary_face_count; ++index) {
        const auto &input = request.boundary_faces[index];
        rt0_require(input.reserved == 0 && input.role >= FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_BOUNDARY_INSULATING &&
                input.role <= FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_BOUNDARY_DEVICE_INTERFACE,
            "external lead bundle boundary header is invalid");
        workflow::ExternalLeadSourceBoundaryFace face;
        std::copy(std::begin(input.vertex_ids), std::end(input.vertex_ids), face.vertex_ids.begin());
        face.role = static_cast<workflow::ExternalLeadSourceBoundaryRole>(input.role);
        if (face.role == workflow::ExternalLeadSourceBoundaryRole::Insulating) {
            rt0_require(input.circuit_id == nullptr || input.circuit_id[0] == '\0',
                "external lead insulating face must have an empty circuit ID");
        } else {
            face.circuit_id = accepted_charge_string(input.circuit_id, "boundary circuit ID");
        }
        closure.boundary_faces.push_back(std::move(face));
    }
    std::uint64_t observed_pairs = 0;
    for (std::uint64_t index = 0; index < request.branch_count; ++index) {
        const auto &input = request.branches[index];
        rt0_require(input.interface_pair_ids != nullptr && input.interface_pair_count > 0 &&
                input.interface_pair_count <= resolved.charge.interface_pairs.size() - observed_pairs &&
                std::isfinite(input.requested_device_outward_current_a),
            "external lead bundle branch pointer/count or current is invalid");
        observed_pairs += input.interface_pair_count;
        workflow::ExternalLeadBranchObservation branch;
        branch.id = accepted_charge_string(input.id, "device branch ID");
        branch.requested_device_outward_current_a = input.requested_device_outward_current_a;
        for (std::uint64_t pair = 0; pair < input.interface_pair_count; ++pair) {
            branch.interface_pair_ids.push_back(accepted_charge_string(input.interface_pair_ids[pair], "branch pair ID"));
        }
        closure.branch_observations.push_back(std::move(branch));
    }
    rt0_require(observed_pairs == resolved.charge.interface_pairs.size(),
        "external lead bundle must observe every interface exactly once");
    std::vector<std::array<double, 3>> targets;
    targets.reserve(static_cast<std::size_t>(request.target_count));
    for (std::uint64_t target = 0; target < request.target_count; ++target) {
        std::array<double, 3> point{};
        for (unsigned component = 0; component < 3; ++component) {
            point[component] = request.target_xyz_m[3 * target + component];
            rt0_require(std::isfinite(point[component]), "external lead bundle target must be finite");
        }
        targets.push_back(point);
    }
    fullmag::fem::oersted::DirectTetraQuadratureOptions options;
    options.base_quadrature_order = request.base_quadrature_order;
    options.maximum_subdivision_depth = request.maximum_subdivision_depth;
    options.absolute_tolerance_apm = request.absolute_tolerance_apm;
    options.relative_tolerance = request.relative_tolerance;
    options.maximum_source_target_pairs = request.maximum_source_target_pairs;
    const auto bundle = workflow::solve_accepted_external_lead_bundle(resolved.charge, std::move(closure), targets, options);
    rt0_require(!bundle.canonical_content_bytes.empty() &&
            bundle.canonical_content_bytes.size() <= result.canonical_payload_capacity && bundle.content_digest.size() == 64,
        "external lead bundle payload capacity is insufficient or digest is invalid");
    copy_rt0_text(result.digest_schema, sizeof(result.digest_schema), bundle.digest_schema, "bundle digest schema");
    copy_rt0_text(result.operator_version, sizeof(result.operator_version), bundle.operator_version, "bundle operator version");
    copy_rt0_text(result.layout_fingerprint, sizeof(result.layout_fingerprint),
        FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_LAYOUT_FINGERPRINT, "external lead ABI fingerprint");
    copy_rt0_text(result.content_sha256, sizeof(result.content_sha256), bundle.content_digest, "bundle content digest");
    std::copy(bundle.canonical_content_bytes.begin(), bundle.canonical_content_bytes.end(), result.canonical_payload);
    result.canonical_payload_len = bundle.canonical_content_bytes.size();
    result.error_message[0] = '\0';
    return FULLMAG_FEM_OK;
}

std::vector<fullmag::fem::transport::ConservativeCurrentBoundaryFace>
rt0_boundary_roles(
    const mfem::Mesh &mesh,
    const fullmag::fem::transport::StableMeshVertexIdentities &ids,
    const fullmag_fem_steady_transport_rt0_boundary_face_v1 *records,
    std::uint64_t record_count)
{
    rt0_require(records != nullptr && record_count ==
            static_cast<std::uint64_t>(mesh.GetNBE()),
        "RT0 boundary classification must cover every mesh boundary face exactly once");
    std::map<Rt0FaceKey, fullmag_fem_steady_transport_rt0_boundary_face_v1> authored;
    for (std::uint64_t index = 0; index < record_count; ++index) {
        const auto key = rt0_sorted_face_key(records[index].face_vertex_ids);
        rt0_require(authored.emplace(key, records[index]).second,
            "RT0 boundary classification contains duplicate stable face IDs");
    }
    std::vector<fullmag::fem::transport::ConservativeCurrentBoundaryFace> result;
    result.reserve(static_cast<std::size_t>(mesh.GetNBE()));
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        const auto key = rt0_mesh_boundary_key(mesh, ids, boundary);
        const auto found = authored.find(key);
        rt0_require(found != authored.end(),
            "RT0 boundary classification is missing a mesh face");
        fullmag::fem::transport::ConservativeCurrentBoundaryFace role;
        role.boundary_element = boundary;
        switch (found->second.role) {
        case FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_INSULATING_OUTER:
            role.role = fullmag::fem::transport::ConservativeCurrentBoundaryRole::InsulatingOuter;
            role.circuit_id = found->second.circuit_id == nullptr
                ? std::string()
                : rt0_string(found->second.circuit_id,
                    "insulating boundary circuit ID", true);
            rt0_require(role.circuit_id.empty(),
                "insulating RT0 boundary must not carry a circuit ID");
            break;
        case FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_SOURCE_CUT:
            role.role = fullmag::fem::transport::ConservativeCurrentBoundaryRole::SourceCut;
            role.circuit_id = rt0_string(found->second.circuit_id,
                "source-cut circuit ID");
            break;
        case FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_CLOSURE_INTERFACE:
            role.role = fullmag::fem::transport::ConservativeCurrentBoundaryRole::ClosureInterface;
            role.circuit_id = rt0_string(found->second.circuit_id,
                "closure-interface circuit ID");
            break;
        default:
            throw std::invalid_argument("unknown RT0 boundary role");
        }
        result.push_back(std::move(role));
    }
    return result;
}

fullmag::fem::transport::ConservativeCurrentIdentityInput rt0_identity(
    const fullmag_fem_steady_transport_rt0_identity_v1 &descriptor)
{
    fullmag::fem::transport::ConservativeCurrentIdentityInput identity;
    identity.source_module_id = rt0_string(descriptor.source_module_id,
        "source module ID");
    identity.source_state_revision = rt0_string(descriptor.source_state_revision,
        "source state revision");
    identity.source_field_digest = rt0_string(descriptor.source_field_digest,
        "source field digest");
    rt0_string(descriptor.conductivity_digest, "conductivity digest");
    identity.mesh_revision = rt0_string(descriptor.mesh_revision,
        "mesh revision");
    identity.topology_revision = rt0_string(descriptor.topology_revision,
        "topology revision");
    identity.geometry_digest = rt0_string(descriptor.geometry_digest,
        "geometry digest");
    identity.envelope_revision = rt0_string(descriptor.envelope_revision,
        "envelope revision");
    identity.envelope_digest = rt0_string(descriptor.envelope_digest,
        "envelope digest");
    identity.evaluated_envelope_multiplier = descriptor.evaluated_envelope_multiplier;
    identity.evaluation_time_s = descriptor.evaluation_time_s;
    identity.stage_identity = descriptor.stage_identity;
    return identity;
}

fullmag::fem::transport::ConservativeCurrentPins rt0_pins(
    const fullmag_fem_steady_transport_rt0_identity_v1 &descriptor)
{
    fullmag::fem::transport::ConservativeCurrentPins pins;
    pins.required_source_state_revision = rt0_string(
        descriptor.source_state_revision, "required source state revision");
    pins.required_source_field_digest = rt0_string(
        descriptor.source_field_digest, "required source field digest");
    pins.required_mesh_revision = rt0_string(
        descriptor.mesh_revision, "required mesh revision");
    pins.required_topology_revision = rt0_string(
        descriptor.topology_revision, "required topology revision");
    return pins;
}

fullmag::fem::transport::ClosedGeometryCurrentClosure rt0_closed_closure(
    const fullmag_fem_steady_transport_rt0_closed_geometry_closure_v1 &descriptor)
{
    fullmag::fem::transport::ClosedGeometryCurrentClosure closure;
    closure.operator_version = rt0_string(descriptor.operator_version,
        "closed-geometry closure operator version");
    closure.revision = rt0_string(descriptor.revision,
        "closed-geometry closure revision");
    closure.digest = rt0_string(descriptor.digest,
        "closed-geometry closure digest");
    rt0_require(descriptor.source_cuts != nullptr && descriptor.source_cut_count > 0,
        "closed-geometry closure requires source cuts");
    closure.source_cuts.reserve(static_cast<std::size_t>(descriptor.source_cut_count));
    for (std::uint64_t index = 0; index < descriptor.source_cut_count; ++index) {
        const auto &input = descriptor.source_cuts[index];
        fullmag::fem::transport::PeriodicCurrentSourceCut cut;
        cut.id = rt0_string(input.id, "source-cut ID");
        for (int component = 0; component < 3; ++component) {
            cut.translation_m[component] = input.translation_m[component];
        }
        cut.potential_drop_v = input.potential_drop_v;
        rt0_require(input.face_pairs != nullptr && input.face_pair_count > 0,
            "source cut requires paired boundary faces");
        cut.face_pairs.reserve(static_cast<std::size_t>(input.face_pair_count));
        for (std::uint64_t pair_index = 0; pair_index < input.face_pair_count;
                ++pair_index) {
            const auto &pair = input.face_pairs[pair_index];
            fullmag::fem::transport::PeriodicCurrentSourceCutFacePair converted;
            converted.minus_face_vertex_ids = rt0_sorted_face_key(
                pair.minus_face_vertex_ids);
            converted.plus_face_vertex_ids = rt0_sorted_face_key(
                pair.plus_face_vertex_ids);
            cut.face_pairs.push_back(converted);
        }
        closure.source_cuts.push_back(std::move(cut));
    }
    return closure;
}

std::vector<std::array<std::uint64_t, 3>> rt0_face_keys(
    const std::uint64_t *vertices,
    std::uint64_t face_count,
    const char *name)
{
    rt0_require(vertices != nullptr && face_count > 0,
        std::string(name) + " must contain at least one face");
    std::vector<std::array<std::uint64_t, 3>> result;
    result.reserve(static_cast<std::size_t>(face_count));
    for (std::uint64_t index = 0; index < face_count; ++index) {
        result.push_back(rt0_sorted_face_key(vertices + index * 3u));
    }
    return result;
}

fullmag::fem::transport::ExternalLeadExtensionCurrentClosure rt0_external_closure(
    const fullmag_fem_steady_transport_rt0_external_lead_closure_v1 &descriptor,
    std::unique_ptr<mfem::Mesh> &lead_mesh,
    std::unique_ptr<mfem::PWConstCoefficient> &lead_conductivity,
    mfem::Vector &lead_conductivity_values,
    const MeshView &lead_mesh_view)
{
    fullmag::fem::transport::ExternalLeadExtensionCurrentClosure closure;
    closure.operator_version = rt0_string(descriptor.operator_version,
        "external-lead closure operator version");
    closure.revision = rt0_string(descriptor.revision,
        "external-lead closure revision");
    closure.digest = rt0_string(descriptor.digest,
        "external-lead closure digest");
    closure.drive_id = rt0_string(descriptor.drive_id,
        "external-lead drive ID");
    closure.outer_electrode_potential_drop_v =
        descriptor.outer_electrode_potential_drop_v;
    closure.lead_vertex_identities = rt0_stable_ids(
        descriptor.lead_stable_vertex_identities, lead_mesh_view);
    closure.lead_conductivity_digest = rt0_string(
        descriptor.lead_conductivity_digest, "lead conductivity digest");
    rt0_require(descriptor.interface_pairs != nullptr &&
            descriptor.interface_pair_count > 0,
        "external-lead closure requires interface pairs");
    closure.interface_pairs.reserve(
        static_cast<std::size_t>(descriptor.interface_pair_count));
    for (std::uint64_t index = 0; index < descriptor.interface_pair_count; ++index) {
        const auto &input = descriptor.interface_pairs[index];
        fullmag::fem::transport::ExternalLeadInterfacePair pair;
        pair.transport_face_vertex_ids = rt0_sorted_face_key(
            input.transport_face_vertex_ids);
        pair.lead_face_vertex_ids = rt0_sorted_face_key(
            input.lead_face_vertex_ids);
        closure.interface_pairs.push_back(pair);
    }
    closure.minus_outer_electrode_faces = rt0_face_keys(
        descriptor.minus_outer_electrode_face_vertex_ids,
        descriptor.minus_outer_electrode_face_count,
        "minus outer electrode faces");
    closure.plus_outer_electrode_faces = rt0_face_keys(
        descriptor.plus_outer_electrode_face_vertex_ids,
        descriptor.plus_outer_electrode_face_count,
        "plus outer electrode faces");

    rt0_require(descriptor.lead_conductivity_spm_per_element != nullptr &&
            descriptor.lead_conductivity_spm_per_element_len == lead_mesh_view.n_elements,
        "lead conductivity must contain one value per tetrahedron");
    lead_conductivity_values.SetSize(static_cast<int>(lead_mesh_view.n_elements));
    for (std::uint64_t index = 0; index < lead_mesh_view.n_elements; ++index) {
        const double value = descriptor.lead_conductivity_spm_per_element[index];
        rt0_require(std::isfinite(value) && value > 0.0,
            "lead conductivity must be finite and positive");
        lead_conductivity_values[static_cast<int>(index)] = value;
    }
    lead_conductivity = std::make_unique<mfem::PWConstCoefficient>(
        lead_conductivity_values);
    closure.lead_mesh = lead_mesh.get();
    closure.lead_conductivity = lead_conductivity.get();
    return closure;
}

class BoundaryScalarCoefficient final : public mfem::Coefficient {
public:
    BoundaryScalarCoefficient(const uint32_t *attributes, const double *values, uint64_t count)
    {
        for (uint64_t i = 0; i < count; ++i) {
            if (attributes[i] == 0 || !std::isfinite(values[i])) {
                throw std::invalid_argument("charge boundary attributes must be positive and finite");
            }
            entries_.push_back({attributes[i], values[i]});
        }
    }

    double Eval(mfem::ElementTransformation &transformation,
                const mfem::IntegrationPoint &) override
    {
        for (const auto &entry : entries_) {
            if (static_cast<uint32_t>(transformation.Attribute) == entry.first) {
                return entry.second;
            }
        }
        return 0.0;
    }

private:
    std::vector<std::pair<uint32_t, double>> entries_;
};

class BoundaryVectorCoefficient final : public mfem::VectorCoefficient {
public:
    BoundaryVectorCoefficient(const uint32_t *attributes, const double *values, uint64_t count)
        : mfem::VectorCoefficient(3)
    {
        for (uint64_t i = 0; i < count; ++i) {
            if (attributes[i] == 0) {
                throw std::invalid_argument("spin boundary attributes must be positive");
            }
            std::array<double, 3> value{};
            for (int component = 0; component < 3; ++component) {
                value[component] = values[3u * i + static_cast<uint64_t>(component)];
                if (!std::isfinite(value[component])) {
                    throw std::invalid_argument("spin boundary potential must be finite");
                }
            }
            entries_.push_back({attributes[i], value});
        }
    }

    void Eval(mfem::Vector &value, mfem::ElementTransformation &transformation,
              const mfem::IntegrationPoint &) override
    {
        value.SetSize(3);
        value = 0.0;
        for (const auto &entry : entries_) {
            if (static_cast<uint32_t>(transformation.Attribute) == entry.first) {
                for (int component = 0; component < 3; ++component) {
                    value[component] = entry.second[component];
                }
                return;
            }
        }
    }

private:
    std::vector<std::pair<uint32_t, std::array<double, 3>>> entries_;
};

mfem::Array<int> boundary_marker(
    const mfem::Mesh &mesh,
    const uint32_t *attributes,
    uint64_t count)
{
    mfem::Array<int> marker(mesh.bdr_attributes.Max());
    marker = 0;
    for (uint64_t i = 0; i < count; ++i) {
        if (attributes[i] == 0 || attributes[i] > static_cast<uint32_t>(marker.Size())) {
            throw std::invalid_argument("boundary attribute is not present in the MFEM mesh");
        }
        marker[static_cast<int>(attributes[i] - 1u)] = 1;
    }
    return marker;
}

void copy_scalar(const mfem::GridFunction &field, double *output, uint64_t node_count)
{
    if (field.Size() != static_cast<int>(node_count)) {
        throw std::runtime_error("scalar P1 field DOF count does not equal n_nodes");
    }
    std::copy(field.GetData(), field.GetData() + node_count, output);
}

void copy_by_vdim(
    const mfem::GridFunction &field,
    int components,
    double *output,
    uint64_t node_count)
{
    if (field.Size() != static_cast<int>(node_count) * components) {
        throw std::runtime_error("vector P1 field DOF count does not equal components*n_nodes");
    }
    const double *data = field.GetData();
    for (uint64_t node = 0; node < node_count; ++node) {
        for (int component = 0; component < components; ++component) {
            output[node * static_cast<uint64_t>(components) + static_cast<uint64_t>(component)] =
                data[static_cast<uint64_t>(component) * node_count + node];
        }
    }
}

int solve(
    const fullmag_fem_steady_transport_request_v1 &request,
    fullmag_fem_steady_transport_result_v1 &result)
{
    validate_request_header(request, result);
    const MeshView mesh_view = make_mesh_view(request.mesh);
    validate_request(request, result, mesh_view);
    auto mesh = import_mesh(request.mesh, mesh_view);

    mfem::Vector conductivity_values(static_cast<int>(mesh_view.n_elements));
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        conductivity_values[static_cast<int>(i)] = request.charge_conductivity_spm_per_element[i];
    }
    mfem::PWConstCoefficient conductivity(conductivity_values);

    mfem::H1_FECollection magnetization_collection(1, 3);
    mfem::FiniteElementSpace magnetization_space(
        mesh.get(), &magnetization_collection, 3, mfem::Ordering::byNODES);
    if (magnetization_space.GetNDofs() != static_cast<int>(mesh_view.n_nodes)) {
        throw std::runtime_error("magnetization P1 space DOF count does not equal n_nodes");
    }
    mfem::GridFunction magnetization_grid(&magnetization_space);
    for (uint64_t node = 0; node < mesh_view.n_nodes; ++node) {
        for (int component = 0; component < 3; ++component) {
            magnetization_grid[component * static_cast<int>(mesh_view.n_nodes) +
                static_cast<int>(node)] =
                request.magnetization_xyz[3u * node + static_cast<uint64_t>(component)];
        }
    }
    mfem::VectorGridFunctionCoefficient magnetization(&magnetization_grid);

    fullmag::fem::transport::SteadyTransportParameters parameters;
    parameters.sigma_s_spm = request.sigma_s_spm;
    parameters.polarization_p = request.polarization_p;
    parameters.theta_sh = request.theta_sh;
    parameters.lambda_sf_m = request.lambda_sf_m;
    parameters.lambda_j_m = request.has_lambda_j != 0
        ? request.lambda_j_m : std::numeric_limits<double>::infinity();
    parameters.lambda_phi_m = request.has_lambda_phi != 0
        ? request.lambda_phi_m : std::numeric_limits<double>::infinity();
    parameters.gamma_e_per_ts = request.gamma_e_per_ts;
    parameters.saturation_magnetization_apm = request.saturation_magnetization_apm;
    parameters.relative_tolerance = request.relative_tolerance;
    parameters.maximum_iterations = static_cast<int>(request.maximum_iterations);

    fullmag::fem::transport::SteadyTransportOracle oracle(
        *mesh, conductivity, magnetization, parameters);
    const auto charge_marker = boundary_marker(
        *mesh,
        request.charge_dirichlet_boundary_attributes,
        request.charge_dirichlet_count);
    BoundaryScalarCoefficient charge_boundary(
        request.charge_dirichlet_boundary_attributes,
        request.charge_dirichlet_values_v,
        request.charge_dirichlet_count);
    const auto charge_gauge =
        request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL
            ? fullmag::fem::transport::ChargeGauge::ZeroMeanPotential
            : fullmag::fem::transport::ChargeGauge::BoundaryReference;
    const auto charge = oracle.solve_charge(charge_marker, charge_boundary, charge_gauge);
    if (!charge.converged) {
        throw std::runtime_error("FEM steady transport charge solve did not converge");
    }

    const auto spin_marker = boundary_marker(
        *mesh,
        request.spin_dirichlet_boundary_attributes,
        request.spin_dirichlet_count);
    std::unique_ptr<BoundaryVectorCoefficient> spin_boundary;
    if (request.spin_dirichlet_count > 0) {
        spin_boundary = std::make_unique<BoundaryVectorCoefficient>(
            request.spin_dirichlet_boundary_attributes,
            request.spin_dirichlet_values_v,
            request.spin_dirichlet_count);
    }
    const auto spin = oracle.solve_spin(spin_marker, spin_boundary.get());
    if (!spin.converged) {
        throw std::runtime_error("FEM steady transport spin solve did not converge");
    }

    const uint64_t nodes = mesh_view.n_nodes;
    copy_scalar(oracle.electric_potential(), result.electric_potential_v, nodes);
    copy_by_vdim(oracle.charge_current_density(), 3,
        result.charge_current_density_xyz_apm2, nodes);
    copy_by_vdim(oracle.spin_potential(), 3, result.spin_potential_xyz_v, nodes);
    copy_by_vdim(oracle.spin_current_tensor(), 9,
        result.spin_current_tensor_row_major_qia_apm2, nodes);
    copy_by_vdim(oracle.transport_torque(), 3, result.torque_xyz_per_s, nodes);

    result.charge_converged = charge.converged ? 1 : 0;
    result.charge_iterations = static_cast<uint32_t>(charge.iterations);
    result.charge_relative_residual = charge.relative_residual;
    result.net_boundary_current_a = charge.net_boundary_current_a;
    result.spin_converged = spin.converged ? 1 : 0;
    result.spin_iterations = static_cast<uint32_t>(spin.iterations);
    result.spin_relative_residual = spin.relative_residual;
    result.torque_l2_per_s = spin.torque_l2_per_s;
    for (int component = 0; component < 3; ++component) {
        result.current_density_volume_average_apm2[component] =
            charge.current_density_volume_average_apm2[component];
        result.boundary_spin_flux_a[component] = spin.boundary_spin_flux_a[component];
        result.reaction_integral_a[component] = spin.reaction_integral_a[component];
        result.angular_momentum_balance_apm2[component] =
            spin.angular_momentum_balance_apm2[component];
        result.torque_volume_average_per_s[component] =
            spin.torque_volume_average_per_s[component];
    }
    result.error_message[0] = '\0';
    std::snprintf(
        result.diagnostics_json,
        sizeof(result.diagnostics_json),
        "{\"schema_version\":\"fem_steady_transport_diagnostics.v1\","
        "\"constitutive_version\":\"%s\",\"operator_version\":\"%s\","
        "\"physical_residual_version\":\"%s\",\"execution_lane\":\"fem_cpu_double\","
        "\"interface_model\":\"transparent_conforming_h1\","
        "\"charge_converged\":true,\"charge_iterations\":%u,"
        "\"charge_relative_residual\":%.17g,\"net_boundary_current_A\":%.17g,"
        "\"spin_converged\":true,\"spin_iterations\":%u,"
        "\"spin_relative_residual\":%.17g,\"torque_l2_per_s\":%.17g}",
        kConstitutiveVersion,
        kOperatorVersion,
        kPhysicalResidualVersion,
        result.charge_iterations,
        result.charge_relative_residual,
        result.net_boundary_current_a,
        result.spin_iterations,
        result.spin_relative_residual,
        result.torque_l2_per_s);
    return FULLMAG_FEM_OK;
}

void validate_disjoint_charge_terminal_nodes(
    const fullmag_fem_charge_transport_request_v1 &request,
    const MeshView &mesh)
{
    std::map<uint32_t, uint64_t> terminal_by_attribute;
    for (uint64_t index = 0; index < request.dirichlet_boundary_count; ++index) {
        if (!terminal_by_attribute.emplace(
                request.dirichlet_boundary_attributes[index], index).second) {
            throw std::invalid_argument("charge terminal attributes must be unique");
        }
    }
    std::vector<int64_t> terminal_by_node(mesh.n_nodes, -1);
    for (std::size_t face = 0; face < mesh.boundary_markers.size(); ++face) {
        const auto terminal = terminal_by_attribute.find(mesh.boundary_markers[face]);
        if (terminal == terminal_by_attribute.end()) {
            continue;
        }
        for (std::size_t local = 0; local < 3; ++local) {
            const auto node = mesh.boundary_faces[3 * face + local];
            auto &owner = terminal_by_node[node];
            if (owner >= 0 && owner != static_cast<int64_t>(terminal->second)) {
                throw std::invalid_argument(
                    "charge terminal boundaries share an H1 node");
            }
            owner = static_cast<int64_t>(terminal->second);
        }
    }
}

int solve_charge(
    const fullmag_fem_charge_transport_request_v1 &request,
    fullmag_fem_charge_transport_result_v1 &result,
    double *dirichlet_boundary_currents_a = nullptr,
    uint64_t dirichlet_boundary_currents_a_capacity = 0,
    uint64_t *dirichlet_boundary_currents_a_len = nullptr,
    const fullmag_fem_charge_transport_request_v3 *current_request = nullptr,
    fullmag_fem_charge_transport_result_v3 *current_result = nullptr)
{
    validate_charge_request_header(request, result);
    const MeshView mesh_view = make_mesh_view(request.mesh);
    const bool prescribed_currents = current_request != nullptr;
    if (prescribed_currents != (current_result != nullptr)) {
        throw std::invalid_argument("terminal-current request and result must be supplied together");
    }
    validate_charge_request(request, result, mesh_view, prescribed_currents);
    if (dirichlet_boundary_currents_a_len != nullptr) {
        validate_disjoint_charge_terminal_nodes(request, mesh_view);
    }
    std::vector<std::vector<int>> terminal_groups;
    std::vector<double> requested_currents;
    if (prescribed_currents) {
        if (request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE ||
            request.dirichlet_boundary_count != 0 ||
            current_request->terminal_count == 0 ||
            current_request->terminal_count > static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
            current_request->terminal_attribute_offsets_len != current_request->terminal_count + 1 ||
            current_request->terminal_attribute_offsets == nullptr ||
            !pointer_matches_count(current_request->terminal_boundary_attributes,
                current_request->terminal_boundary_attributes_len) ||
            current_request->requested_outward_currents_a == nullptr ||
            current_result->terminal_voltages_v == nullptr ||
            current_result->terminal_voltages_v_capacity < current_request->terminal_count ||
            current_result->measured_outward_currents_a == nullptr ||
            current_result->measured_outward_currents_a_capacity < current_request->terminal_count ||
            current_result->gauge_terminal_indices == nullptr ||
            current_result->gauge_terminal_indices_capacity < current_request->terminal_count) {
            throw std::invalid_argument("terminal-current ABI inputs or output capacities are invalid");
        }
        const auto *offsets = current_request->terminal_attribute_offsets;
        if (offsets[0] != 0 ||
            offsets[current_request->terminal_count] !=
                current_request->terminal_boundary_attributes_len) {
            throw std::invalid_argument("terminal attribute offsets do not cover the input");
        }
        for (uint64_t terminal = 0; terminal < current_request->terminal_count; ++terminal) {
            if (offsets[terminal] >= offsets[terminal + 1] ||
                offsets[terminal + 1] > current_request->terminal_boundary_attributes_len) {
                throw std::invalid_argument("terminal attribute offsets are not strictly increasing");
            }
            std::vector<int> group;
            for (uint64_t index = offsets[terminal]; index < offsets[terminal + 1]; ++index) {
                const uint32_t attribute = current_request->terminal_boundary_attributes[index];
                if (attribute == 0 || attribute > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
                    throw std::invalid_argument("terminal boundary attribute is invalid");
                }
                group.push_back(static_cast<int>(attribute));
            }
            terminal_groups.push_back(std::move(group));
            requested_currents.push_back(
                current_request->requested_outward_currents_a[terminal]);
        }
    }
    auto mesh = import_mesh(request.mesh, mesh_view);

    mfem::Vector conductivity_values(static_cast<int>(mesh_view.n_elements));
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        conductivity_values[static_cast<int>(i)] =
            request.charge_conductivity_spm_per_element[i];
    }
    mfem::PWConstCoefficient conductivity(conductivity_values);

    // The one-way charge projection is J=-sigma*grad(V) and does not read
    // magnetization.  Keep a zero coefficient here so any accidental future
    // spin/magnetoresistive evaluation fails loudly instead of manufacturing
    // a synthetic magnetic state for a metallic conductor.
    mfem::Vector no_magnetization(3);
    no_magnetization = 0.0;
    mfem::VectorConstantCoefficient magnetization(no_magnetization);
    fullmag::fem::transport::SteadyTransportParameters parameters;
    parameters.relative_tolerance = request.relative_tolerance;
    parameters.maximum_iterations = static_cast<int>(request.maximum_iterations);

    fullmag::fem::transport::SteadyTransportOracle oracle(
        *mesh, conductivity, magnetization, parameters);
    const auto charge_marker = boundary_marker(
        *mesh,
        request.dirichlet_boundary_attributes,
        request.dirichlet_boundary_count);
    BoundaryScalarCoefficient charge_boundary(
        request.dirichlet_boundary_attributes,
        request.dirichlet_boundary_values_v,
        request.dirichlet_boundary_count);
    const auto charge_gauge =
        request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL
            ? fullmag::fem::transport::ChargeGauge::ZeroMeanPotential
            : fullmag::fem::transport::ChargeGauge::BoundaryReference;
    fullmag::fem::transport::ChargeTerminalCurrentSolution current_solution;
    fullmag::fem::transport::ChargeSolveDiagnostics diagnostics;
    if (prescribed_currents) {
        current_solution = oracle.solve_charge_terminal_currents(
            terminal_groups, requested_currents);
        diagnostics = current_solution.diagnostics;
    } else {
        diagnostics = oracle.solve_charge(charge_marker, charge_boundary, charge_gauge);
    }
    if (!diagnostics.converged) {
        throw std::runtime_error("FEM charge transport solve did not converge");
    }
    if (dirichlet_boundary_currents_a_len != nullptr) {
        if (dirichlet_boundary_currents_a_capacity < request.dirichlet_boundary_count ||
            (request.dirichlet_boundary_count != 0 && dirichlet_boundary_currents_a == nullptr)) {
            throw std::invalid_argument(
                "charge transport terminal-current result capacity is too small");
        }
        for (uint64_t index = 0; index < request.dirichlet_boundary_count; ++index) {
            dirichlet_boundary_currents_a[index] = oracle.boundary_weak_current_a(
                static_cast<int>(request.dirichlet_boundary_attributes[index]));
        }
        *dirichlet_boundary_currents_a_len = request.dirichlet_boundary_count;
    }
    copy_scalar(
        oracle.electric_potential(), result.electric_potential_v, mesh_view.n_nodes);
    copy_by_vdim(
        oracle.charge_current_density(),
        3,
        result.charge_current_density_xyz_apm2,
        mesh_view.n_nodes);
    result.electric_potential_v_len = mesh_view.n_nodes;
    result.charge_current_density_xyz_apm2_len = 3u * mesh_view.n_nodes;
    result.charge_converged = diagnostics.converged ? 1 : 0;
    result.charge_iterations = static_cast<uint32_t>(diagnostics.iterations);
    result.charge_relative_residual = diagnostics.relative_residual;
    result.net_boundary_current_a = diagnostics.net_boundary_current_a;
    for (int component = 0; component < 3; ++component) {
        result.current_density_volume_average_apm2[component] =
            diagnostics.current_density_volume_average_apm2[component];
    }
    result.error_message[0] = '\0';
    std::snprintf(
        result.diagnostics_json,
        sizeof(result.diagnostics_json),
        "{\"schema_version\":\"fem_charge_transport_diagnostics.v1\"," \
        "\"constitutive_version\":\"%s\",\"operator_version\":\"%s\"," \
        "\"physical_residual_version\":\"%s\"," \
        "\"execution_lane\":\"fem_cpu_double\"," \
        "\"charge_converged\":true,\"charge_iterations\":%u," \
        "\"charge_relative_residual\":%.17g," \
        "\"net_boundary_current_A\":%.17g," \
        "\"current_density_volume_average_Apm2\":[%.17g,%.17g,%.17g]}",
        kChargeConstitutiveVersion,
        kChargeOperatorVersion,
        kChargePhysicalResidualVersion,
        result.charge_iterations,
        result.charge_relative_residual,
        result.net_boundary_current_a,
        result.current_density_volume_average_apm2[0],
        result.current_density_volume_average_apm2[1],
        result.current_density_volume_average_apm2[2]);
    if (prescribed_currents) {
        for (uint64_t terminal = 0; terminal < current_request->terminal_count; ++terminal) {
            current_result->terminal_voltages_v[terminal] =
                current_solution.terminal_voltage_v[static_cast<std::size_t>(terminal)];
            current_result->measured_outward_currents_a[terminal] =
                current_solution.measured_outward_current_a[static_cast<std::size_t>(terminal)];
        }
        for (std::size_t index = 0; index < current_solution.gauge_terminal_indices.size(); ++index) {
            current_result->gauge_terminal_indices[index] =
                static_cast<uint32_t>(current_solution.gauge_terminal_indices[index]);
        }
        current_result->terminal_voltages_v_len = current_request->terminal_count;
        current_result->measured_outward_currents_a_len = current_request->terminal_count;
        current_result->gauge_terminal_indices_len =
            current_solution.gauge_terminal_indices.size();
        std::snprintf(
            result.diagnostics_json,
            sizeof(result.diagnostics_json),
            "{\"schema_version\":\"fem_charge_terminal_current_diagnostics.v3\","
            "\"operator_version\":\"%s\",\"execution_lane\":\"fem_cpu_double\","
            "\"terminal_count\":%llu,\"gauge_component_count\":%llu,"
            "\"charge_converged\":true,\"charge_relative_residual\":%.17g}",
            kChargeOperatorVersion,
            static_cast<unsigned long long>(current_request->terminal_count),
            static_cast<unsigned long long>(current_solution.gauge_terminal_indices.size()),
            result.charge_relative_residual);
    }
    return FULLMAG_FEM_OK;
}

int solve_m2(
    const fullmag_fem_steady_transport_m2_request_v1 &request,
    fullmag_fem_steady_transport_result_v1 &result)
{
    const auto &base = request.base;
    if (base.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
        base.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("steady transport M2 base ABI header mismatch");
    }
    const MeshView mesh_view = make_mesh_view(base.mesh);
    validate_request(
        base, result, mesh_view, kM2ConstitutiveVersion, kM2OperatorVersion);
    if (!(std::isfinite(request.sigma_parallel_spm) && request.sigma_parallel_spm > 0.0) ||
        !(std::isfinite(request.sigma_perpendicular_spm) &&
            request.sigma_perpendicular_spm > 0.0) ||
        !std::isfinite(request.sigma_ahe_spm)) {
        throw std::invalid_argument("reciprocal charge conductivities must be finite and positive");
    }
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        const double sigma = base.charge_conductivity_spm_per_element[i];
        const double minimum_charge_conductivity = std::min(
            request.sigma_parallel_spm, request.sigma_perpendicular_spm);
        if (!(minimum_charge_conductivity * base.sigma_s_spm -
                base.polarization_p * base.polarization_p * sigma * sigma > 0.0)) {
            throw std::invalid_argument("reciprocal spin material violates the positive Schur complement");
        }
    }
    auto mesh = import_mesh(base.mesh, mesh_view);

    mfem::Vector conductivity_values(static_cast<int>(mesh_view.n_elements));
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        conductivity_values[static_cast<int>(i)] =
            base.charge_conductivity_spm_per_element[i];
    }
    mfem::PWConstCoefficient conductivity(conductivity_values);

    mfem::H1_FECollection magnetization_collection(1, 3);
    mfem::FiniteElementSpace magnetization_space(
        mesh.get(), &magnetization_collection, 3, mfem::Ordering::byNODES);
    if (magnetization_space.GetNDofs() != static_cast<int>(mesh_view.n_nodes)) {
        throw std::runtime_error("magnetization P1 space DOF count does not equal n_nodes");
    }
    mfem::GridFunction magnetization_grid(&magnetization_space);
    for (uint64_t node = 0; node < mesh_view.n_nodes; ++node) {
        for (int component = 0; component < 3; ++component) {
            magnetization_grid[component * static_cast<int>(mesh_view.n_nodes) +
                static_cast<int>(node)] =
                base.magnetization_xyz[3u * node + static_cast<uint64_t>(component)];
        }
    }
    mfem::VectorGridFunctionCoefficient magnetization(&magnetization_grid);

    fullmag::fem::transport::SteadyTransportParameters parameters;
    parameters.constitutive_model =
        fullmag::fem::transport::TransportConstitutiveModel::Reciprocal;
    parameters.sigma_s_spm = base.sigma_s_spm;
    parameters.sigma_parallel_spm = request.sigma_parallel_spm;
    parameters.sigma_perpendicular_spm = request.sigma_perpendicular_spm;
    parameters.sigma_ahe_spm = request.sigma_ahe_spm;
    parameters.polarization_p = base.polarization_p;
    parameters.theta_sh = base.theta_sh;
    parameters.lambda_sf_m = base.lambda_sf_m;
    parameters.lambda_j_m = base.has_lambda_j != 0
        ? base.lambda_j_m : std::numeric_limits<double>::infinity();
    parameters.lambda_phi_m = base.has_lambda_phi != 0
        ? base.lambda_phi_m : std::numeric_limits<double>::infinity();
    parameters.gamma_e_per_ts = base.gamma_e_per_ts;
    parameters.saturation_magnetization_apm = base.saturation_magnetization_apm;
    parameters.relative_tolerance = base.relative_tolerance;
    parameters.maximum_iterations = static_cast<int>(base.maximum_iterations);

    fullmag::fem::transport::SteadyTransportOracle oracle(
        *mesh, conductivity, magnetization, parameters);
    const auto charge_marker = boundary_marker(
        *mesh, base.charge_dirichlet_boundary_attributes, base.charge_dirichlet_count);
    BoundaryScalarCoefficient charge_boundary(
        base.charge_dirichlet_boundary_attributes,
        base.charge_dirichlet_values_v,
        base.charge_dirichlet_count);
    if (base.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL) {
        throw std::domain_error("reciprocal FEM reference lane requires a Dirichlet charge reference");
    }
    const auto spin_marker = boundary_marker(
        *mesh, base.spin_dirichlet_boundary_attributes, base.spin_dirichlet_count);
    std::unique_ptr<BoundaryVectorCoefficient> spin_boundary;
    if (base.spin_dirichlet_count > 0) {
        spin_boundary = std::make_unique<BoundaryVectorCoefficient>(
            base.spin_dirichlet_boundary_attributes,
            base.spin_dirichlet_values_v,
            base.spin_dirichlet_count);
    }
    const auto diagnostics = oracle.solve_reciprocal(
        charge_marker, charge_boundary, spin_marker, spin_boundary.get(),
        fullmag::fem::transport::ChargeGauge::BoundaryReference);
    if (!diagnostics.charge.converged || !diagnostics.spin.converged) {
        throw std::runtime_error("FEM reciprocal steady transport solve did not converge");
    }

    const uint64_t nodes = mesh_view.n_nodes;
    copy_scalar(oracle.electric_potential(), result.electric_potential_v, nodes);
    copy_by_vdim(oracle.charge_current_density(), 3,
        result.charge_current_density_xyz_apm2, nodes);
    copy_by_vdim(oracle.spin_potential(), 3, result.spin_potential_xyz_v, nodes);
    copy_by_vdim(oracle.spin_current_tensor(), 9,
        result.spin_current_tensor_row_major_qia_apm2, nodes);
    copy_by_vdim(oracle.transport_torque(), 3, result.torque_xyz_per_s, nodes);

    result.charge_converged = diagnostics.charge.converged ? 1 : 0;
    result.charge_iterations = static_cast<uint32_t>(diagnostics.charge.iterations);
    result.charge_relative_residual = diagnostics.charge.relative_residual;
    result.net_boundary_current_a = diagnostics.charge.net_boundary_current_a;
    result.spin_converged = diagnostics.spin.converged ? 1 : 0;
    result.spin_iterations = static_cast<uint32_t>(diagnostics.spin.iterations);
    result.spin_relative_residual = diagnostics.spin.relative_residual;
    result.torque_l2_per_s = diagnostics.spin.torque_l2_per_s;
    for (int component = 0; component < 3; ++component) {
        result.current_density_volume_average_apm2[component] =
            diagnostics.charge.current_density_volume_average_apm2[component];
        result.boundary_spin_flux_a[component] = diagnostics.spin.boundary_spin_flux_a[component];
        result.reaction_integral_a[component] = diagnostics.spin.reaction_integral_a[component];
        result.angular_momentum_balance_apm2[component] =
            diagnostics.spin.angular_momentum_balance_apm2[component];
        result.torque_volume_average_per_s[component] =
            diagnostics.spin.torque_volume_average_per_s[component];
    }
    result.error_message[0] = '\0';
    std::snprintf(
        result.diagnostics_json,
        sizeof(result.diagnostics_json),
        "{\"schema_version\":\"fem_steady_transport_diagnostics.v1\","
        "\"constitutive_version\":\"%s\",\"operator_version\":\"%s\","
        "\"physical_residual_version\":\"%s\",\"execution_lane\":\"fem_cpu_double\","
        "\"interface_model\":\"transparent_conforming_h1\",\"constitutive_model\":\"reciprocal_m2\","
        "\"charge_converged\":true,\"charge_iterations\":%u,"
        "\"charge_relative_residual\":%.17g,\"spin_converged\":true,\"spin_iterations\":%u,"
        "\"spin_relative_residual\":%.17g,\"torque_l2_per_s\":%.17g}",
        kM2ConstitutiveVersion,
        kM2OperatorVersion,
        kPhysicalResidualVersion,
        result.charge_iterations,
        result.charge_relative_residual,
        result.spin_iterations,
        result.spin_relative_residual,
        result.torque_l2_per_s);
    return FULLMAG_FEM_OK;
}

void validate_rt0_header(
    const fullmag_fem_steady_transport_rt0_request_v1 &request,
    const fullmag_fem_steady_transport_rt0_result_v1 &result)
{
    if (request.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION) {
        throw std::invalid_argument("RT0 transport request abi_version must be 1");
    }
    if (request.struct_size != sizeof(fullmag_fem_steady_transport_rt0_request_v1)) {
        throw std::invalid_argument("RT0 transport request struct_size mismatch");
    }
    if (result.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION) {
        throw std::invalid_argument("RT0 transport result abi_version must be 1");
    }
    if (result.struct_size != sizeof(fullmag_fem_steady_transport_rt0_result_v1)) {
        throw std::invalid_argument("RT0 transport result struct_size mismatch");
    }
    if (request.reserved_flags != 0 || request.reserved_closure != 0 ||
        result.reserved_flags != 0) {
        throw std::invalid_argument("RT0 transport reserved_flags must be zero");
    }
    if (request.base.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
        request.base.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("RT0 transport base ABI header mismatch");
    }
    if (request.base.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error(
            "FEM conservative RT0 transport GPU is unavailable; strict requests cannot fall back to CPU");
    }
    if (request.base.execution_lane != FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE) {
        throw std::invalid_argument("unknown FEM conservative RT0 execution lane");
    }
    if (request.closure_kind !=
            FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_CLOSED_GEOMETRY &&
        request.closure_kind !=
            FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_EXTERNAL_LEAD) {
        throw std::invalid_argument("unknown FEM conservative RT0 closure kind");
    }
    if (request.closure_kind ==
            FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_CLOSED_GEOMETRY) {
        if (request.closed_geometry == nullptr || request.external_lead != nullptr) {
            throw std::invalid_argument(
                "closed-geometry RT0 request requires exactly one closure descriptor");
        }
    } else if (request.external_lead == nullptr || request.closed_geometry != nullptr) {
        throw std::invalid_argument(
            "external-lead RT0 request requires exactly one closure descriptor");
    }
    if (request.reference_mpi_gather_broadcast != 0 &&
        request.reference_mpi_gather_broadcast != 1) {
        throw std::invalid_argument("RT0 MPI reference flag must be zero or one");
    }
    if (!(std::isfinite(request.algebraic_relative_tolerance) &&
            request.algebraic_relative_tolerance > 0.0 &&
            request.algebraic_relative_tolerance < 1.0) ||
        !(std::isfinite(request.physical_relative_gate) &&
            request.physical_relative_gate > 0.0) ||
        !(std::isfinite(request.physical_absolute_gate_a) &&
            request.physical_absolute_gate_a > 0.0)) {
        throw std::invalid_argument("RT0 transport tolerances are invalid");
    }
}

void copy_rt0_text(char *destination, std::size_t capacity,
    const std::string &value, const char *name)
{
    if (value.size() >= capacity) {
        throw std::invalid_argument(std::string(name) + " exceeds result buffer capacity");
    }
    std::memset(destination, 0, capacity);
    std::memcpy(destination, value.data(), value.size());
}

int solve_rt0(
    const fullmag_fem_steady_transport_rt0_request_v1 &request,
    fullmag_fem_steady_transport_rt0_result_v1 &result,
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *oersted_result = nullptr,
    const fullmag_fem_steady_transport_rt0_oersted_request_v1 *oersted_request = nullptr,
    fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1
        *vector_potential_result = nullptr,
    const fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1
        *vector_potential_request = nullptr,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1
        *charge_snapshot = nullptr,
    fullmag_fem_direct_oersted_snapshot_result_v1
        *quadrature_snapshot = nullptr)
{
    validate_rt0_header(request, result);
    const MeshView device_mesh_view = make_mesh_view(request.base.mesh, true);
    rt0_require(request.base.charge_conductivity_spm_per_element != nullptr &&
            request.base.charge_conductivity_spm_per_element_len ==
                device_mesh_view.n_elements,
        "RT0 source conductivity must contain one value per device tetrahedron");

    auto device_mesh = import_mesh(request.base.mesh, device_mesh_view);
    auto stable_ids = rt0_stable_ids(request.stable_vertex_identities,
        device_mesh_view);
    auto boundary_roles = rt0_boundary_roles(*device_mesh, stable_ids,
        request.boundary_faces, request.boundary_face_count);
    const auto identity = rt0_identity(request.identity);
    const auto pins = rt0_pins(request.pins);
    const std::string conductivity_digest = rt0_string(
        request.identity.conductivity_digest, "conductivity digest");

    mfem::Vector conductivity_values(static_cast<int>(device_mesh_view.n_elements));
    for (std::uint64_t index = 0; index < device_mesh_view.n_elements; ++index) {
        const double value = request.base.charge_conductivity_spm_per_element[index];
        rt0_require(std::isfinite(value) && value > 0.0,
            "RT0 source conductivity must be finite and positive");
        conductivity_values[static_cast<int>(index)] = value;
    }
    mfem::PWConstCoefficient conductivity(conductivity_values);

    fullmag::fem::transport::ConservativeCurrentBuildRequest build;
    build.mesh = device_mesh.get();
    build.conductivity = &conductivity;
    build.stable_vertex_identities = stable_ids;
    build.boundary_faces = boundary_roles;
    build.identity = identity;
    build.pins = pins;
    build.algebraic_relative_tolerance = request.algebraic_relative_tolerance;
    build.physical_relative_gate = request.physical_relative_gate;
    build.physical_absolute_gate_a = request.physical_absolute_gate_a;
    build.reference_mpi_gather_broadcast =
        request.reference_mpi_gather_broadcast != 0;

    std::shared_ptr<const fullmag::fem::transport::PeriodicChargePotentialSnapshot>
        periodic_snapshot;
    std::unique_ptr<mfem::Mesh> lead_mesh;
    std::unique_ptr<mfem::PWConstCoefficient> lead_conductivity;
    mfem::Vector lead_conductivity_values;
    fullmag::fem::transport::ClosedGeometryCurrentClosure closed_closure;
    fullmag::fem::transport::ExternalLeadExtensionCurrentClosure external_closure;

    if (request.closure_kind ==
            FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_CLOSED_GEOMETRY) {
        closed_closure = rt0_closed_closure(*request.closed_geometry);
        rt0_require(closed_closure.source_cuts.size() == 1,
            "public RT0 closed-geometry source currently requires exactly one source cut");
        const auto &cut = closed_closure.source_cuts.front();
        fullmag::fem::transport::PeriodicChargePotentialSolveRequest periodic;
        periodic.mesh = device_mesh.get();
        periodic.conductivity = &conductivity;
        periodic.stable_vertex_identities = stable_ids;
        periodic.boundary_faces = boundary_roles;
        periodic.source_cut = cut;
        periodic.operator_version = "fem_charge_h1_periodic_jump.v1";
        periodic.source_module_id = identity.source_module_id;
        periodic.source_state_revision = identity.source_state_revision;
        periodic.source_field_digest = identity.source_field_digest;
        periodic.evaluation_time_s = identity.evaluation_time_s;
        periodic.stage_identity = identity.stage_identity;
        periodic.envelope_revision = identity.envelope_revision;
        periodic.envelope_digest = identity.envelope_digest;
        periodic.evaluated_envelope_multiplier = identity.evaluated_envelope_multiplier;
        periodic.mesh_revision = identity.mesh_revision;
        periodic.geometry_digest = identity.geometry_digest;
        periodic.conductivity_digest = conductivity_digest;
        periodic.source_cut_digest = closed_closure.digest;
        periodic.algebraic_relative_tolerance = request.algebraic_relative_tolerance;
        periodic.maximum_iterations = request.base.maximum_iterations > 0
            ? static_cast<int>(request.base.maximum_iterations) : 1000;
        periodic.reference_mpi_gather_rank0_broadcast =
            request.reference_mpi_gather_broadcast != 0;
        periodic_snapshot =
            fullmag::fem::transport::PeriodicChargePotentialSolver::Solve(periodic);
        build.closure = closed_closure;
        build.periodic_charge_potential = periodic_snapshot;
        build.external_lead_coupled_solve = false;
    } else {
        const auto &external = *request.external_lead;
        const MeshView lead_mesh_view = make_mesh_view(external.lead_mesh, true);
        lead_mesh = import_mesh(external.lead_mesh, lead_mesh_view);
        external_closure = rt0_external_closure(external, lead_mesh,
            lead_conductivity, lead_conductivity_values, lead_mesh_view);
        build.closure = external_closure;
        build.external_lead_coupled_solve = true;
        build.periodic_charge_potential.reset();
    }

    const auto view = fullmag::fem::transport::ConservativeCurrentView::Build(build);
    const auto &field = view->field();
    const auto &records = view->canonical_face_flux_records();
    std::vector<double> charge_vertex_xyz;
    if (charge_snapshot != nullptr) {
        const auto *potential = view->charge_potential_vertex_values_v();
        const auto &ids = view->stable_vertex_identities();
        const auto *mesh = view->space().GetMesh();
        const auto count = static_cast<std::uint64_t>(mesh->GetNV());
        rt0_require(potential != nullptr && potential->size() == count &&
                ids.local_to_stable.size() == count,
            "RT0 charge snapshot is absent or has inconsistent vertex ordering");
        rt0_require(count <= std::numeric_limits<std::uint64_t>::max() / 3u &&
                charge_snapshot->electric_potential_v != nullptr &&
                charge_snapshot->electric_potential_v_capacity >= count &&
                charge_snapshot->stable_vertex_ids != nullptr &&
                charge_snapshot->stable_vertex_ids_capacity >= count &&
                charge_snapshot->vertex_xyz_m != nullptr &&
                charge_snapshot->vertex_xyz_m_capacity >= 3u * count,
            "RT0 charge snapshot output capacity is smaller than the combined mesh");
        charge_vertex_xyz.reserve(static_cast<std::size_t>(3u * count));
        for (int vertex = 0; vertex < mesh->GetNV(); ++vertex) {
            rt0_require(std::isfinite(potential->at(vertex)),
                "RT0 charge snapshot potential is non-finite");
            for (int component = 0; component < 3; ++component) {
                const double coordinate = mesh->GetVertex(vertex)[component];
                rt0_require(std::isfinite(coordinate),
                    "RT0 charge snapshot coordinate is non-finite");
                charge_vertex_xyz.push_back(coordinate);
            }
        }
        copy_rt0_text(charge_snapshot->stable_vertex_id_version,
            sizeof(charge_snapshot->stable_vertex_id_version), ids.version,
            "RT0 charge snapshot stable vertex ID version");
        copy_rt0_text(charge_snapshot->source_view_identity_digest,
            sizeof(charge_snapshot->source_view_identity_digest),
            view->identity().view_identity_digest, "RT0 charge snapshot source digest");
    }
    if (result.rt0_dof_values == nullptr ||
        result.rt0_dof_values_capacity < static_cast<std::uint64_t>(field.Size())) {
        throw std::invalid_argument("RT0 dof output capacity is smaller than the RT0 space");
    }
    if (result.canonical_face_records == nullptr ||
        result.canonical_face_records_capacity < records.size()) {
        throw std::invalid_argument(
            "RT0 canonical face-record output capacity is smaller than the result");
    }
    std::copy(field.GetData(), field.GetData() + field.Size(), result.rt0_dof_values);
    for (std::size_t index = 0; index < records.size(); ++index) {
        for (int component = 0; component < 3; ++component) {
            result.canonical_face_records[index].face_vertex_ids[component] =
                records[index].face_vertex_ids[component];
        }
        result.canonical_face_records[index].flux_a = records[index].flux_a;
    }
    result.rt0_dof_values_len = static_cast<std::uint64_t>(field.Size());
    result.canonical_face_records_len = records.size();
    result.converged = 1;
    const auto &balance = view->balance();
    result.max_element_divergence_a = balance.max_element_divergence_a;
    result.max_internal_face_jump_a = balance.max_internal_face_jump_a;
    result.net_outer_flux_a = balance.net_outer_flux_a;
    result.electrode_balance_relative = balance.electrode_balance_relative;
    result.max_closure_interface_mismatch_a = balance.max_closure_interface_mismatch_a;
    result.scaled_kkt_residual = balance.scaled_kkt_residual;
    result.correction_norm_mw = balance.correction_norm_mw;
    copy_rt0_text(result.operator_version, sizeof(result.operator_version),
        view->identity().operator_version, "RT0 operator version");
    copy_rt0_text(result.fe_space, sizeof(result.fe_space), "RT_3D_P0", "RT0 FE space");
    copy_rt0_text(result.flux_unit, sizeof(result.flux_unit), "A", "RT0 flux unit");
    copy_rt0_text(result.canonical_face_digest, sizeof(result.canonical_face_digest),
        view->identity().canonical_face_digest, "RT0 face digest");
    copy_rt0_text(result.balance_certificate_digest,
        sizeof(result.balance_certificate_digest),
        view->identity().balance_certificate_digest, "RT0 balance digest");
    copy_rt0_text(result.view_identity_digest, sizeof(result.view_identity_digest),
        view->identity().view_identity_digest, "RT0 view digest");
    result.error_message[0] = '\0';
    std::snprintf(
        result.diagnostics_json,
        sizeof(result.diagnostics_json),
        "{\"schema_version\":\"fem_conservative_current_rt0_view.v1\","
        "\"operator_version\":\"%s\",\"fe_space\":\"RT_3D_P0\","
        "\"converged\":true,\"rt0_dof_count\":%llu,"
        "\"canonical_face_record_count\":%llu,"
        "\"max_element_divergence_A\":%.17g,"
        "\"max_internal_face_jump_A\":%.17g,"
        "\"view_identity_digest\":\"%s\"}",
        result.operator_version,
        static_cast<unsigned long long>(result.rt0_dof_values_len),
        static_cast<unsigned long long>(result.canonical_face_records_len),
        result.max_element_divergence_a,
        result.max_internal_face_jump_a,
        result.view_identity_digest);
    if (oersted_result != nullptr && oersted_request != nullptr) {
        rt0_require(oersted_request->target_points_xyz_len % 3u == 0,
            "OE-F1 target point buffer length must be a multiple of three");
        const auto target_count = oersted_request->target_points_xyz_len / 3u;
        rt0_require(target_count == 0 || oersted_request->target_points_xyz != nullptr,
            "OE-F1 target point buffer is null");
        rt0_require(oersted_result->h_xyz_apm != nullptr &&
                oersted_result->h_xyz_apm_capacity >= target_count * 3u,
            "OE-F1 output capacity is smaller than the target point count");
        fullmag::fem::oersted::DirectTetraQuadratureOptions options;
        options.base_quadrature_order = oersted_request->base_quadrature_order;
        options.maximum_subdivision_depth = oersted_request->maximum_subdivision_depth;
        options.absolute_tolerance_apm = oersted_request->absolute_tolerance_apm;
        options.relative_tolerance = oersted_request->relative_tolerance;
        options.maximum_source_target_pairs =
            oersted_request->maximum_source_target_pairs;
        std::vector<std::array<double, 3>> target_points;
        target_points.reserve(static_cast<std::size_t>(target_count));
        for (std::uint64_t index = 0; index < target_count; ++index) {
            std::array<double, 3> point{};
            for (int component = 0; component < 3; ++component) {
                point[component] = oersted_request->target_points_xyz[3u * index +
                    static_cast<std::uint64_t>(component)];
                rt0_require(std::isfinite(point[component]),
                    "OE-F1 target point is non-finite");
            }
            target_points.push_back(point);
        }
        const auto direct = fullmag::fem::oersted::DirectTetraQuadrature::Evaluate(
            *view, target_points, options);
        rt0_require(direct.h_xyz_apm.size() <=
                oersted_result->h_xyz_apm_capacity,
            "OE-F1 result size exceeds output capacity");
        std::copy(direct.h_xyz_apm.begin(), direct.h_xyz_apm.end(),
            oersted_result->h_xyz_apm);
        oersted_result->h_xyz_apm_len = direct.h_xyz_apm.size();
        oersted_result->source_target_pairs = direct.diagnostics.source_target_pairs;
        oersted_result->refined_pairs = direct.diagnostics.refined_pairs;
        oersted_result->unconverged_pair_count =
            direct.diagnostics.unconverged_pair_count;
        oersted_result->maximum_pair_error_apm =
            direct.diagnostics.maximum_pair_error_apm;
        copy_rt0_text(oersted_result->operator_version,
            sizeof(oersted_result->operator_version), direct.operator_version,
            "OE-F1 operator version");
        copy_rt0_text(oersted_result->source_view_identity_digest,
            sizeof(oersted_result->source_view_identity_digest),
            direct.source_view_identity_digest, "OE-F1 source view digest");
        oersted_result->error_message[0] = '\0';
        std::snprintf(
            oersted_result->diagnostics_json,
            sizeof(oersted_result->diagnostics_json),
            "{\"schema_version\":\"%s\","
            "\"operator_version\":\"%s\",\"source_view_identity_digest\":\"%s\","
            "\"target_count\":%llu,\"source_target_pairs\":%llu,"
            "\"unconverged_pair_count\":%llu,\"maximum_pair_error_apm\":%.17g}",
            oersted_result->operator_version,
            oersted_result->operator_version,
            oersted_result->source_view_identity_digest,
            static_cast<unsigned long long>(target_count),
            static_cast<unsigned long long>(oersted_result->source_target_pairs),
            static_cast<unsigned long long>(oersted_result->unconverged_pair_count),
            oersted_result->maximum_pair_error_apm);
        if (quadrature_snapshot != nullptr) {
            rt0_require(direct.target_diagnostics.size() == target_count &&
                    direct.h_xyz_apm.size() == target_count * 3u,
                "OE-F1 target ledger count differs from the raw field");
            for (std::size_t index = 0; index < target_count; ++index) {
                auto &record = quadrature_snapshot->target_records[index];
                const auto &diagnostic = direct.target_diagnostics[index];
                for (std::size_t component = 0; component < 3u; ++component) {
                    record.target_xyz_m[component] = target_points[index][component];
                    record.h_xyz_apm[component] = direct.h_xyz_apm[3u * index + component];
                }
                record.estimated_error_apm = diagnostic.estimated_error_apm;
                record.tolerance_apm = diagnostic.tolerance_apm;
                record.roundoff_indicator_apm = diagnostic.roundoff_indicator_apm;
                record.final_leaf_count = diagnostic.final_leaf_count;
                record.kernel_evaluations = diagnostic.kernel_evaluations;
                record.ledger_leaf_visits = diagnostic.ledger_leaf_visits;
            }
            quadrature_snapshot->source_target_pairs = direct.diagnostics.source_target_pairs;
            quadrature_snapshot->refined_pairs = direct.diagnostics.refined_pairs;
            quadrature_snapshot->unconverged_pair_count = direct.diagnostics.unconverged_pair_count;
            quadrature_snapshot->maximum_pair_error_apm = direct.diagnostics.maximum_pair_error_apm;
            quadrature_snapshot->kernel_evaluations = direct.diagnostics.kernel_evaluations;
            quadrature_snapshot->ledger_leaf_visits = direct.diagnostics.ledger_leaf_visits;
            quadrature_snapshot->base_quadrature_order = options.base_quadrature_order;
            quadrature_snapshot->maximum_subdivision_depth = options.maximum_subdivision_depth;
            quadrature_snapshot->absolute_tolerance_apm = options.absolute_tolerance_apm;
            quadrature_snapshot->relative_tolerance = options.relative_tolerance;
            quadrature_snapshot->relative_scale_floor_apm = 0.0;
            quadrature_snapshot->maximum_source_target_pairs = options.maximum_source_target_pairs;
            quadrature_snapshot->maximum_final_leaves_per_target =
                fullmag::fem::oersted::DirectTetraQuadrature::maximum_final_leaves_per_target;
            quadrature_snapshot->maximum_kernel_evaluations =
                fullmag::fem::oersted::DirectTetraQuadrature::maximum_kernel_evaluations;
            quadrature_snapshot->maximum_ledger_leaf_visits =
                fullmag::fem::oersted::DirectTetraQuadrature::maximum_ledger_leaf_visits;
            copy_rt0_text(quadrature_snapshot->schema_version,
                sizeof(quadrature_snapshot->schema_version),
                "fem_direct_oersted_target_snapshot.v1", "OE-F1 snapshot schema");
            copy_rt0_text(quadrature_snapshot->operator_version,
                sizeof(quadrature_snapshot->operator_version),
                direct.operator_version, "OE-F1 snapshot operator");
            copy_rt0_text(quadrature_snapshot->quadrature_scope,
                sizeof(quadrature_snapshot->quadrature_scope),
                "global_target", "OE-F1 quadrature scope");
            copy_rt0_text(quadrature_snapshot->estimated_error_policy,
                sizeof(quadrature_snapshot->estimated_error_policy),
                "sum_final_leaf_l2_difference.v1", "OE-F1 error policy");
            copy_rt0_text(quadrature_snapshot->roundoff_indicator_policy,
                sizeof(quadrature_snapshot->roundoff_indicator_policy),
                "weighted_terms_binary64_epsilon.v1", "OE-F1 roundoff policy");
            copy_rt0_text(quadrature_snapshot->source_view_identity_digest,
                sizeof(quadrature_snapshot->source_view_identity_digest),
                direct.source_view_identity_digest, "OE-F1 snapshot source digest");
            quadrature_snapshot->target_records_len = target_count;
        }
    }
    if (vector_potential_result != nullptr || vector_potential_request != nullptr) {
        rt0_require(vector_potential_result != nullptr &&
                vector_potential_request != nullptr,
            "OE-F2 request and result must be supplied together");
        const auto gauge = rt0_string(
            vector_potential_request->boundary_gauge_variant,
            "OE-F2 boundary gauge variant");
        fullmag::fem::oersted::VectorPotentialOptions options;
        options.mu0_si = vector_potential_request->mu0_si;
        options.relative_tolerance = vector_potential_request->relative_tolerance;
        options.maximum_nd_dofs = vector_potential_request->maximum_nd_dofs;
        options.maximum_h1_dofs = vector_potential_request->maximum_h1_dofs;
        options.boundary_gauge_variant = gauge;
        const auto mixed = fullmag::fem::oersted::VectorPotentialSolver::Evaluate(
            *view, options);
        rt0_require(vector_potential_result->a_dofs_t_m != nullptr &&
                vector_potential_result->a_dofs_t_m_capacity >= mixed.a_dofs_t_m.size(),
            "OE-F2 A output capacity is smaller than the mixed ND solution");
        rt0_require(vector_potential_result->gauge_dofs_apm != nullptr &&
                vector_potential_result->gauge_dofs_apm_capacity >= mixed.gauge_dofs_apm.size(),
            "OE-F2 gauge output capacity is smaller than the mixed H1 solution");
        rt0_require(vector_potential_result->compatible_b_dofs_t != nullptr &&
                vector_potential_result->compatible_b_dofs_t_capacity >=
                    mixed.compatible_b_dofs_t.size(),
            "OE-F2 compatible B output capacity is smaller than the RT0 field");
        rt0_require(vector_potential_result->compatible_h_dofs_apm != nullptr &&
                vector_potential_result->compatible_h_dofs_apm_capacity >=
                    mixed.compatible_h_dofs_apm.size(),
            "OE-F2 compatible H output capacity is smaller than the RT0 field");
        rt0_require(vector_potential_result->nodal_h_xyz_apm != nullptr &&
                vector_potential_result->nodal_h_xyz_apm_capacity >=
                    mixed.nodal_h_xyz_apm.size(),
            "OE-F2 nodal H output capacity is smaller than the H1 projection");
        std::copy(mixed.a_dofs_t_m.begin(), mixed.a_dofs_t_m.end(),
            vector_potential_result->a_dofs_t_m);
        std::copy(mixed.gauge_dofs_apm.begin(), mixed.gauge_dofs_apm.end(),
            vector_potential_result->gauge_dofs_apm);
        std::copy(mixed.compatible_b_dofs_t.begin(), mixed.compatible_b_dofs_t.end(),
            vector_potential_result->compatible_b_dofs_t);
        std::copy(mixed.compatible_h_dofs_apm.begin(), mixed.compatible_h_dofs_apm.end(),
            vector_potential_result->compatible_h_dofs_apm);
        std::copy(mixed.nodal_h_xyz_apm.begin(), mixed.nodal_h_xyz_apm.end(),
            vector_potential_result->nodal_h_xyz_apm);
        vector_potential_result->a_dofs_t_m_len = mixed.a_dofs_t_m.size();
        vector_potential_result->gauge_dofs_apm_len = mixed.gauge_dofs_apm.size();
        vector_potential_result->compatible_b_dofs_t_len = mixed.compatible_b_dofs_t.size();
        vector_potential_result->compatible_h_dofs_apm_len = mixed.compatible_h_dofs_apm.size();
        vector_potential_result->nodal_h_xyz_apm_len = mixed.nodal_h_xyz_apm.size();
        vector_potential_result->converged = 1;
        vector_potential_result->harmonic_count = mixed.diagnostics.harmonic_count;
        vector_potential_result->essential_nd_dof_count =
            mixed.diagnostics.essential_nd_dof_count;
        vector_potential_result->essential_h1_dof_count =
            mixed.diagnostics.essential_h1_dof_count;
        vector_potential_result->first_block_residual =
            mixed.diagnostics.first_block_residual;
        vector_potential_result->constraint_residual =
            mixed.diagnostics.constraint_residual;
        vector_potential_result->weak_ampere_residual =
            mixed.diagnostics.weak_ampere_residual;
        vector_potential_result->compatible_divergence_residual =
            mixed.diagnostics.compatible_divergence_residual;
        vector_potential_result->source_pairing_norm =
            mixed.diagnostics.source_pairing_norm;
        copy_rt0_text(vector_potential_result->operator_version,
            sizeof(vector_potential_result->operator_version), mixed.operator_version,
            "OE-F2 operator version");
        copy_rt0_text(vector_potential_result->source_view_identity_digest,
            sizeof(vector_potential_result->source_view_identity_digest),
            mixed.source_view_identity_digest, "OE-F2 source view digest");
        copy_rt0_text(vector_potential_result->boundary_gauge_variant,
            sizeof(vector_potential_result->boundary_gauge_variant),
            mixed.boundary_gauge_variant, "OE-F2 boundary gauge variant");
        vector_potential_result->error_message[0] = '\0';
        std::snprintf(
            vector_potential_result->diagnostics_json,
            sizeof(vector_potential_result->diagnostics_json),
            "{\"schema_version\":\"fem_oersted_hcurl_h1_gauge.v1\","
            "\"operator_version\":\"%s\","
            "\"source_view_identity_digest\":\"%s\","
            "\"boundary_gauge_variant\":\"%s\","
            "\"converged\":true,\"nd_dofs\":%d,\"h1_dofs\":%d,"
            "\"harmonic_count\":%d,\"first_block_residual\":%.17g,"
            "\"constraint_residual\":%.17g,\"compatible_divergence_residual\":%.17g,"
            "\"nodal_h_xyz_apm_len\":%llu,\"nodal_projection_residual\":%.17g}",
            vector_potential_result->operator_version,
            vector_potential_result->source_view_identity_digest,
            vector_potential_result->boundary_gauge_variant,
            mixed.diagnostics.nd_dofs,
            mixed.diagnostics.h1_dofs,
            mixed.diagnostics.harmonic_count,
            mixed.diagnostics.first_block_residual,
            mixed.diagnostics.constraint_residual,
            mixed.diagnostics.compatible_divergence_residual,
            static_cast<unsigned long long>(vector_potential_result->nodal_h_xyz_apm_len),
            mixed.diagnostics.nodal_projection_residual);
    }
    if (charge_snapshot != nullptr) {
        const auto &potential = *view->charge_potential_vertex_values_v();
        const auto &ids = view->stable_vertex_identities().local_to_stable;
        std::copy(potential.begin(), potential.end(), charge_snapshot->electric_potential_v);
        std::copy(ids.begin(), ids.end(), charge_snapshot->stable_vertex_ids);
        std::copy(charge_vertex_xyz.begin(), charge_vertex_xyz.end(),
            charge_snapshot->vertex_xyz_m);
        charge_snapshot->electric_potential_v_len = potential.size();
        charge_snapshot->stable_vertex_ids_len = ids.size();
        charge_snapshot->vertex_xyz_m_len = charge_vertex_xyz.size();
    }
    return FULLMAG_FEM_OK;
}

#endif

} // namespace

extern "C" int fullmag_fem_solve_charge_transport_v1(
    const fullmag_fem_charge_transport_request_v1 *request,
    fullmag_fem_charge_transport_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "charge transport requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve_charge(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM charge transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_charge_transport_v2(
    const fullmag_fem_charge_transport_request_v1 *request,
    fullmag_fem_charge_transport_result_v2 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result == nullptr ? nullptr : &result->base,
            "charge transport v2 requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        result->dirichlet_boundary_currents_a_len = 0;
        return solve_charge(
            *request,
            result->base,
            result->dirichlet_boundary_currents_a,
            result->dirichlet_boundary_currents_a_capacity,
            &result->dirichlet_boundary_currents_a_len);
    } catch (const std::domain_error &error) {
        set_error(&result->base, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(&result->base, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(&result->base, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(&result->base,
        "FEM charge transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_charge_transport_v3(
    const fullmag_fem_charge_transport_request_v3 *request,
    fullmag_fem_charge_transport_result_v3 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "charge terminal-current v3 requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
    result->terminal_voltages_v_len = 0;
    result->measured_outward_currents_a_len = 0;
    result->gauge_terminal_indices_len = 0;
    if (request->abi_version != FULLMAG_FEM_CHARGE_TERMINAL_CURRENT_ABI_VERSION ||
        request->struct_size != sizeof(*request) || request->reserved_flags != 0 ||
        result->abi_version != FULLMAG_FEM_CHARGE_TERMINAL_CURRENT_ABI_VERSION ||
        result->struct_size != sizeof(*result) || result->reserved_flags != 0) {
        set_error(result, "charge terminal-current v3 ABI header mismatch");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve_charge(request->base, result->base,
            nullptr, 0, nullptr, request, result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM charge terminal-current solve requires FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_accepted_terminal_charge_v1(
    const fullmag_fem_accepted_terminal_charge_request_v1 *request,
    fullmag_fem_accepted_terminal_charge_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "accepted terminal charge requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
    set_error(result, "");
    if (request->abi_version != FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION ||
        request->struct_size != sizeof(*request) || request->reserved_flags != 0 ||
        result->abi_version != FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION ||
        result->struct_size != sizeof(*result) || result->reserved_flags != 0) {
        set_error(result, "accepted terminal charge ABI header mismatch");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve_accepted_terminal_charge(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result, "accepted terminal charge requires FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_accepted_external_lead_field_v1(
    const fullmag_fem_accepted_external_lead_request_v1 *request,
    fullmag_fem_accepted_external_lead_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "accepted external lead bundle requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
    set_error(result, "");
    if (request->abi_version != FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_ABI_VERSION ||
        request->struct_size != sizeof(*request) || request->reserved_flags != 0 ||
        result->abi_version != FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_ABI_VERSION ||
        result->struct_size != sizeof(*result) || result->reserved_flags != 0) {
        set_error(result, "accepted external lead bundle ABI header mismatch");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve_accepted_external_lead(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result, "accepted external lead bundle requires FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_steady_transport_v1(
    const fullmag_fem_steady_transport_request_v1 *request,
    fullmag_fem_steady_transport_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "steady transport requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM steady transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_steady_transport_m2_v1(
    const fullmag_fem_steady_transport_m2_request_v1 *request,
    fullmag_fem_steady_transport_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "steady transport M2 requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        if (request->base.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
            request->base.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
            throw std::invalid_argument("steady transport M2 base ABI header mismatch");
        }
        if (result->abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
            result->struct_size != sizeof(fullmag_fem_steady_transport_result_v1)) {
            throw std::invalid_argument("steady transport M2 result ABI header mismatch");
        }
        return solve_m2(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM reciprocal steady transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

static int solve_steady_transport_rt0_impl(
    const fullmag_fem_steady_transport_rt0_request_v1 *request,
    fullmag_fem_steady_transport_rt0_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot)
{
    (void)charge_snapshot;
    if (request == nullptr || result == nullptr) {
        set_error(result, "RT0 transport requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve_rt0(*request, *result, nullptr, nullptr, nullptr, nullptr,
            charge_snapshot);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM conservative RT0 transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

static int solve_steady_transport_rt0_oersted_impl(
    const fullmag_fem_steady_transport_rt0_oersted_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot,
    fullmag_fem_direct_oersted_snapshot_result_v1 *quadrature_snapshot = nullptr)
{
    (void)charge_snapshot;
    (void)quadrature_snapshot;
    if (request == nullptr || result == nullptr) {
        set_error(result, "RT0 Oersted transport requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        if (request->abi_version !=
                FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION ||
            request->struct_size !=
                sizeof(fullmag_fem_steady_transport_rt0_oersted_request_v1) ||
            request->reserved_flags != 0) {
            throw std::invalid_argument("RT0 Oersted request ABI header mismatch");
        }
        if (result->abi_version !=
                FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION ||
            result->struct_size !=
                sizeof(fullmag_fem_steady_transport_rt0_oersted_result_v1) ||
            result->reserved_flags != 0) {
            throw std::invalid_argument("RT0 Oersted result ABI header mismatch");
        }
        if (request->target_points_xyz_len % 3u != 0) {
            throw std::invalid_argument(
                "RT0 Oersted target point buffer length must be a multiple of three");
        }
        validate_rt0_header(request->rt0, result->rt0);
        return solve_rt0(request->rt0, result->rt0, result, request, nullptr,
            nullptr, charge_snapshot, quadrature_snapshot);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM RT0 Oersted requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

static int solve_steady_transport_rt0_oersted_vector_potential_impl(
    const fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot)
{
    (void)charge_snapshot;
    if (request == nullptr || result == nullptr) {
        set_error(result, "RT0 OE-F2 transport requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        if (request->abi_version !=
                FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_VECTOR_POTENTIAL_ABI_VERSION ||
            request->struct_size !=
                sizeof(fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1) ||
            request->reserved_flags != 0) {
            throw std::invalid_argument("RT0 OE-F2 request ABI header mismatch");
        }
        if (result->abi_version !=
                FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_VECTOR_POTENTIAL_ABI_VERSION ||
            result->struct_size !=
                sizeof(fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1) ||
            result->reserved_flags != 0) {
            throw std::invalid_argument("RT0 OE-F2 result ABI header mismatch");
        }
        validate_rt0_header(request->rt0, result->rt0);
        return solve_rt0(
            request->rt0,
            result->rt0,
            nullptr,
            nullptr,
            result,
            request,
            charge_snapshot);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM RT0 OE-F2 requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_v1(
    const fullmag_fem_steady_transport_rt0_request_v1 *request,
    fullmag_fem_steady_transport_rt0_result_v1 *result)
{
    return solve_steady_transport_rt0_impl(request, result, nullptr);
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_v1(
    const fullmag_fem_steady_transport_rt0_oersted_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *result)
{
    return solve_steady_transport_rt0_oersted_impl(request, result, nullptr);
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_v1(
    const fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1 *result)
{
    return solve_steady_transport_rt0_oersted_vector_potential_impl(request, result, nullptr);
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_with_charge_snapshot_v1(
    const fullmag_fem_steady_transport_rt0_request_v1 *request,
    fullmag_fem_steady_transport_rt0_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot)
{
    return call_with_charge_snapshot(result, charge_snapshot, [&] {
        return solve_steady_transport_rt0_impl(request, result, charge_snapshot);
    });
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_with_charge_snapshot_v1(
    const fullmag_fem_steady_transport_rt0_oersted_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot)
{
    return call_with_charge_snapshot(result, charge_snapshot, [&] {
        return solve_steady_transport_rt0_oersted_impl(request, result, charge_snapshot);
    });
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1(
    const fullmag_fem_steady_transport_rt0_oersted_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot,
    fullmag_fem_direct_oersted_snapshot_result_v1 *quadrature_snapshot)
{
    const auto fail = [&](const char *message, int status) {
        if (result != nullptr && result->struct_size >= sizeof(*result)) {
            set_error(result, message);
        }
        set_error(charge_snapshot, message);
        set_error(quadrature_snapshot, message);
        return status;
    };
    if (quadrature_snapshot == nullptr ||
        quadrature_snapshot->abi_version != FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_ABI_VERSION ||
        quadrature_snapshot->reserved_flags != 0 ||
        quadrature_snapshot->struct_size != sizeof(*quadrature_snapshot)) {
        return fail("OE-F1 quadrature snapshot ABI header mismatch", FULLMAG_FEM_ERR_INVALID);
    }
    set_error(quadrature_snapshot, "");
    if (request == nullptr || result == nullptr ||
        request->abi_version != FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION ||
        request->struct_size != sizeof(*request) || request->reserved_flags != 0 ||
        result->struct_size < sizeof(*result)) {
        return fail("OE-F1 snapshot requires valid request and result", FULLMAG_FEM_ERR_INVALID);
    }
    const auto target_count = request->target_points_xyz_len / 3u;
    if (request->target_points_xyz_len % 3u != 0 || target_count == 0 ||
        target_count > FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_MAX_TARGETS ||
        request->target_points_xyz == nullptr ||
        quadrature_snapshot->target_records == nullptr ||
        quadrature_snapshot->target_records_capacity < target_count) {
        return fail("OE-F1 snapshot target buffer/count/capacity mismatch", FULLMAG_FEM_ERR_INVALID);
    }
    const int status = call_with_charge_snapshot(result, charge_snapshot, [&] {
        return solve_steady_transport_rt0_oersted_impl(
            request, result, charge_snapshot, quadrature_snapshot);
    });
    if (status != FULLMAG_FEM_OK) {
        // Copy before resetting result: snprintf source/destination must not alias.
        char message[256];
        std::snprintf(message, sizeof(message), "%s", result->error_message);
        return fail(message, status);
    }
    return status;
}

extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_with_charge_snapshot_v1(
    const fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1 *result,
    fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1 *charge_snapshot)
{
    return call_with_charge_snapshot(result, charge_snapshot, [&] {
        return solve_steady_transport_rt0_oersted_vector_potential_impl(
            request, result, charge_snapshot);
    });
}
