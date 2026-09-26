#include "fullmag_fem.h"

#include <mfem.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>

namespace {

int failures = 0;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    }
}

fullmag_fem_mesh_desc tetrahedron_mesh(
    const double *nodes,
    const std::uint32_t *cell_types,
    const std::uint32_t *cell_offsets,
    const std::uint32_t *cell_nodes,
    const std::uint64_t *cell_ordinals,
    const std::uint32_t *cell_markers,
    const std::uint32_t *facet_offsets)
{
    fullmag_fem_mesh_desc mesh{};
    mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    mesh.struct_size = sizeof(mesh);
    mesh.nodes_xyz = nodes;
    mesh.nodes_xyz_len = 12;
    mesh.cell_types = cell_types;
    mesh.cell_types_len = 1;
    mesh.cell_offsets = cell_offsets;
    mesh.cell_offsets_len = 2;
    mesh.cell_nodes = cell_nodes;
    mesh.cell_nodes_len = 4;
    mesh.cell_global_ordinals = cell_ordinals;
    mesh.cell_global_ordinals_len = 1;
    mesh.cell_markers = cell_markers;
    mesh.cell_markers_len = 1;
    mesh.facet_offsets = facet_offsets;
    mesh.facet_offsets_len = 1;
    return mesh;
}

bool valid_fingerprint(
    const char (&fingerprint)[FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY])
{
    if (fingerprint[64] != '\0') {
        return false;
    }
    for (int index = 0; index < 64; ++index) {
        const char value = fingerprint[index];
        if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) {
            return false;
        }
    }
    return true;
}

} // namespace

int main()
{
    const std::array<double, 12> nodes{
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const std::array<std::uint32_t, 1> cell_types{FULLMAG_FEM_CELL_TET4};
    const std::array<std::uint32_t, 2> cell_offsets{0u, 4u};
    const std::array<std::uint32_t, 4> cell_nodes{0u, 1u, 2u, 3u};
    const std::array<std::uint64_t, 1> cell_ordinals{17u};
    const std::array<std::uint32_t, 1> cell_markers{3u};
    const std::array<std::uint32_t, 1> facet_offsets{0u};
    auto mesh = tetrahedron_mesh(
        nodes.data(),
        cell_types.data(),
        cell_offsets.data(),
        cell_nodes.data(),
        cell_ordinals.data(),
        cell_markers.data(),
        facet_offsets.data());

    fullmag_fem_mesh_space_preparation_request_v1 request{};
    request.abi_version = FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.mesh = &mesh;
    request.fe_order = 1u;

    fullmag_fem_mesh_space_preparation_evidence_v1 evidence{};
    evidence.abi_version = FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION;
    evidence.struct_size = sizeof(evidence);
    std::array<char, 512> error_message{};
    const bool device_was_configured = mfem::Device::IsConfigured();
    const int status = fullmag_fem_prepare_mesh_space_v1(
        &request, &evidence, error_message.data(), error_message.size());
    check(status == FULLMAG_FEM_OK, "standalone producer builds a valid MFEM mesh and H1 space");
    check(mfem::Device::IsConfigured() == device_was_configured,
        "preparation does not configure or alter MFEM device state");
    check(evidence.mesh_matches_canonical_input == 1u,
        "evidence confirms canonical mesh and marker-map correspondence");
    check(evidence.mesh_dimension == 3u && evidence.fe_family == FULLMAG_FEM_FE_FAMILY_H1 &&
        evidence.fe_order == 1u, "evidence records the realized H1 family and order");
    check(evidence.node_count == 4u && evidence.cell_count == 1u &&
        evidence.boundary_element_count == 4u, "evidence records actual MFEM mesh cardinalities");
    check(evidence.local_dof_count == 4u && evidence.true_dof_count == 4u,
        "evidence records actual local and true H1 DOFs");
    check(evidence.quality_sample_count > 0u && evidence.invalid_cell_count == 0u &&
        evidence.min_jacobian_determinant > 0.0 &&
        evidence.max_jacobian_determinant >= evidence.min_jacobian_determinant,
        "evidence includes accepted order-two Jacobian quality");
    check(valid_fingerprint(evidence.topology_fingerprint), "topology fingerprint is SHA-256 hex");
    check(valid_fingerprint(evidence.marker_map_fingerprint), "marker-map fingerprint is SHA-256 hex");
    check(valid_fingerprint(evidence.quality_fingerprint), "quality fingerprint is SHA-256 hex");
    check(valid_fingerprint(evidence.space_fingerprint), "space fingerprint is SHA-256 hex");

    fullmag_fem_mesh_space_preparation_evidence_v1 untouched{};
    untouched.abi_version = FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION;
    untouched.struct_size = sizeof(untouched) - 1u;
    untouched.node_count = 91u;
    check(fullmag_fem_prepare_mesh_space_v1(
        &request, &untouched, error_message.data(), error_message.size()) == FULLMAG_FEM_ERR_INVALID,
        "evidence ABI size mismatch fails closed");
    check(untouched.node_count == 91u, "failed preparation does not publish partial evidence");

    request.fe_order = 2u;
    evidence.abi_version = FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION;
    evidence.struct_size = sizeof(evidence);
    evidence.node_count = 91u;
    check(fullmag_fem_prepare_mesh_space_v1(
        &request, &evidence, error_message.data(), error_message.size()) == FULLMAG_FEM_ERR_INVALID,
        "unsupported H1 order fails closed");
    check(evidence.node_count == 91u, "unsupported order does not publish partial evidence");

    return failures == 0 ? 0 : 1;
}
