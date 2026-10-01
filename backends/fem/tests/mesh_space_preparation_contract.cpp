#include "fullmag_fem.h"
#include "backend_handle.hpp"
#include "core/fem_mesh.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"

#include <mfem.hpp>

#include <array>
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>

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

#if FULLMAG_HAS_MFEM_STACK
    fullmag::fem::FemMeshRuntimeState imported;
    std::string ordering_error;
    check(fullmag::fem::import_mesh_descriptor(mesh, imported, ordering_error),
        "ordering fixture imports canonical topology");
    std::unique_ptr<mfem::Mesh> realized_mesh;
    check(fullmag::fem::build_mfem_mesh(imported, realized_mesh, ordering_error),
        "ordering fixture realizes canonical vertices");
    if (realized_mesh) {
        mfem::H1_FECollection p1(1, 3);
        mfem::FiniteElementSpace scalar(realized_mesh.get(), &p1);
        check(fullmag::fem::verify_mfem_local_node_ordering(imported, scalar, ordering_error),
            "actual scalar P1 vertex DOFs preserve canonical local indices");
        mfem::FiniteElementSpace vector(realized_mesh.get(), &p1, 3);
        check(!fullmag::fem::verify_mfem_local_node_ordering(imported, vector, ordering_error),
            "vector space cannot masquerade as scalar node ordering");
        mfem::H1_FECollection p2(2, 3);
        mfem::FiniteElementSpace higher_order(realized_mesh.get(), &p2);
        check(!fullmag::fem::verify_mfem_local_node_ordering(imported, higher_order, ordering_error),
            "higher-order space cannot masquerade as local P1 node ordering");
        auto wrong_extent = imported;
        wrong_extent.n_nodes = 3u;
        check(!fullmag::fem::verify_mfem_local_node_ordering(wrong_extent, scalar, ordering_error),
            "matching space must retain canonical vertex extent");

        // Cold ABI fixture borrows stack-owned MFEM handles; no solver runs.
        fullmag_fem_backend geometry_handle{};
        geometry_handle.context.mesh = imported;
        geometry_handle.context.base_plan.fe_order = 1u;
        geometry_handle.context.mfem_context.ready = true;
        geometry_handle.context.mfem_context.mesh = realized_mesh.get();
        geometry_handle.context.mfem_context.fes = &scalar;
        std::array<double, 12> observed_nodes{};
        std::array<uint32_t, 9> observed_cell{};
        check(fullmag_fem_backend_copy_local_node_geometry_v1(
            &geometry_handle, 4, 1, 0, 4, observed_nodes.data(), observed_nodes.size()) == FULLMAG_FEM_OK,
            "node ABI reads actual scalar P1 geometry");
        check(std::equal(observed_nodes.begin(), observed_nodes.end(), imported.nodes_xyz.begin()),
            "actual MFEM coordinates retain canonical order");
        check(fullmag_fem_backend_copy_local_cell_geometry_v1(
            &geometry_handle, 4, 1, 0, 1, observed_cell.data(), observed_cell.size()) == FULLMAG_FEM_OK,
            "cell ABI reads actual geometry and ordered connectivity");
        check(observed_cell == std::array<uint32_t, 9>{{1, 0, 1, 2, 3, 0, 0, 0, 0}},
            "Tet4 ABI has exact vertices and zero unused slots");
        observed_nodes.fill(91.);
        realized_mesh->GetVertex(3)[0] = std::numeric_limits<double>::quiet_NaN();
        check(fullmag_fem_backend_copy_local_node_geometry_v1(
            &geometry_handle, 4, 1, 0, 4, observed_nodes.data(), observed_nodes.size()) == FULLMAG_FEM_ERR_INVALID,
            "invalid later node rejects the entire ABI chunk");
        check(std::all_of(observed_nodes.begin(), observed_nodes.end(), [](double value) { return value == 91.; }),
            "failed later node leaves every caller output value untouched");
        realized_mesh->GetVertex(3)[0] = imported.nodes_xyz[9];
        realized_mesh->GetVertex(0)[0] = -0.;
        check(fullmag_fem_backend_copy_local_node_geometry_v1(
            &geometry_handle, 4, 1, 0, 4, observed_nodes.data(), observed_nodes.size()) == FULLMAG_FEM_ERR_INVALID,
            "signed zero mismatch cannot masquerade as exact native coordinates");
        realized_mesh->GetVertex(0)[0] = imported.nodes_xyz[0];
        observed_cell.fill(91u);
        geometry_handle.context.mesh.cell_nodes[1] = imported.cell_nodes[2];
        check(fullmag_fem_backend_copy_local_cell_geometry_v1(
            &geometry_handle, 4, 1, 0, 1, observed_cell.data(), observed_cell.size()) == FULLMAG_FEM_ERR_INVALID,
            "changed canonical connectivity rejects observed cell chunk");
        check(std::all_of(observed_cell.begin(), observed_cell.end(), [](uint32_t value) { return value == 91u; }),
            "invalid cell leaves every caller output value untouched");
        check(fullmag_fem_backend_copy_local_node_geometry_v1(
            &geometry_handle, 4, 1, 0, 4097, observed_nodes.data(), observed_nodes.size()) == FULLMAG_FEM_ERR_INVALID,
            "native geometry chunk cannot exceed its declared bound");
        // The fixture never transfers ownership to native teardown.
        geometry_handle.context.mfem_context.ready = false;
        geometry_handle.context.mfem_context.mesh = nullptr;
        geometry_handle.context.mfem_context.fes = nullptr;
    }
#endif
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
