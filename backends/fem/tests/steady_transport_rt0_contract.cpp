#include "fullmag_fem.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}

struct FaceInfo {
    std::array<std::uint64_t, 3> key{};
    double y = 0.0;
    double z = 0.0;
    int boundary = -1;
};

std::array<std::uint64_t, 3> face_key(
    const mfem::Mesh &mesh,
    int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary, vertices);
    require(vertices.Size() == 3, "RT0 fixture boundary is not triangular");
    std::array<std::uint64_t, 3> key{
        1000u + static_cast<std::uint64_t>(vertices[0]),
        1000u + static_cast<std::uint64_t>(vertices[1]),
        1000u + static_cast<std::uint64_t>(vertices[2]),
    };
    std::sort(key.begin(), key.end());
    return key;
}

FaceInfo face_info(const mfem::Mesh &mesh, int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary, vertices);
    FaceInfo result;
    result.key = face_key(mesh, boundary);
    result.boundary = boundary;
    for (int local = 0; local < vertices.Size(); ++local) {
        result.y += mesh.GetVertex(vertices[local])[1];
        result.z += mesh.GetVertex(vertices[local])[2];
    }
    result.y /= 3.0;
    result.z /= 3.0;
    return result;
}

void run_closed_geometry_rt0_contract()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);

    std::vector<double> nodes_xyz;
    nodes_xyz.reserve(static_cast<std::size_t>(mesh.GetNV()) * 3u);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const double *coordinate = mesh.GetVertex(vertex);
        nodes_xyz.insert(nodes_xyz.end(), coordinate, coordinate + 3);
    }
    std::vector<std::uint32_t> cell_types(mesh.GetNE(), FULLMAG_FEM_CELL_TET4);
    std::vector<std::uint32_t> cell_offsets{0};
    std::vector<std::uint32_t> cell_nodes;
    cell_nodes.reserve(static_cast<std::size_t>(mesh.GetNE()) * 4u);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        require(vertices.Size() == 4, "RT0 fixture element is not tetrahedral");
        for (int local = 0; local < vertices.Size(); ++local) {
            cell_nodes.push_back(static_cast<std::uint32_t>(vertices[local]));
        }
        cell_offsets.push_back(static_cast<std::uint32_t>(cell_nodes.size()));
    }
    std::vector<std::uint32_t> facet_types(mesh.GetNBE(), FULLMAG_FEM_FACET_TRI3);
    std::vector<std::uint32_t> facet_roles(
        mesh.GetNBE(), FULLMAG_FEM_FACET_ROLE_EXTERIOR);
    std::vector<std::uint32_t> facet_markers(mesh.GetNBE(), 1u);
    std::vector<std::uint32_t> facet_offsets{0};
    std::vector<std::uint32_t> facet_nodes;
    facet_nodes.reserve(static_cast<std::size_t>(mesh.GetNBE()) * 3u);
    std::vector<FaceInfo> lower_faces;
    std::vector<FaceInfo> upper_faces;
    std::vector<fullmag_fem_steady_transport_rt0_boundary_face_v1> boundaries(
        static_cast<std::size_t>(mesh.GetNBE()));
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        require(vertices.Size() == 3, "RT0 fixture boundary is not triangular");
        for (int local = 0; local < vertices.Size(); ++local) {
            facet_nodes.push_back(static_cast<std::uint32_t>(vertices[local]));
        }
        facet_offsets.push_back(static_cast<std::uint32_t>(facet_nodes.size()));
        const auto info = face_info(mesh, boundary);
        boundaries[static_cast<std::size_t>(boundary)].face_vertex_ids[0] = info.key[0];
        boundaries[static_cast<std::size_t>(boundary)].face_vertex_ids[1] = info.key[1];
        boundaries[static_cast<std::size_t>(boundary)].face_vertex_ids[2] = info.key[2];
        const double x = mesh.GetVertex(vertices[0])[0];
        bool planar = true;
        for (int local = 1; local < vertices.Size(); ++local) {
            planar = planar && std::abs(mesh.GetVertex(vertices[local])[0] - x) < 1.0e-12;
        }
        if (planar && std::abs(x) < 1.0e-12) lower_faces.push_back(info);
        if (planar && std::abs(x - 1.0) < 1.0e-12) upper_faces.push_back(info);
    }
    require(!lower_faces.empty() && lower_faces.size() == upper_faces.size(),
        "RT0 fixture has no complete x source-cut pair");
    for (auto &boundary : boundaries) {
        boundary.role = FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_INSULATING_OUTER;
        boundary.circuit_id = nullptr;
    }

    std::vector<fullmag_fem_steady_transport_rt0_source_cut_face_pair_v1> pairs;
    std::vector<std::string> circuit_ids(static_cast<std::size_t>(mesh.GetNBE()));
    for (const auto &minus : lower_faces) {
        const auto match = std::find_if(upper_faces.begin(), upper_faces.end(),
            [&](const FaceInfo &plus) {
                return std::abs(plus.y - minus.y) < 1.0e-12 &&
                    std::abs(plus.z - minus.z) < 1.0e-12;
            });
        require(match != upper_faces.end(), "RT0 source-cut face has no translated peer");
        fullmag_fem_steady_transport_rt0_source_cut_face_pair_v1 pair{};
        pair.minus_face_vertex_ids[0] = minus.key[0];
        pair.minus_face_vertex_ids[1] = minus.key[1];
        pair.minus_face_vertex_ids[2] = minus.key[2];
        pair.plus_face_vertex_ids[0] = match->key[0];
        pair.plus_face_vertex_ids[1] = match->key[1];
        pair.plus_face_vertex_ids[2] = match->key[2];
        pairs.push_back(pair);
        circuit_ids[static_cast<std::size_t>(minus.boundary)] = "x-cut";
        circuit_ids[static_cast<std::size_t>(match->boundary)] = "x-cut";
        boundaries[static_cast<std::size_t>(minus.boundary)].role =
            FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_SOURCE_CUT;
        boundaries[static_cast<std::size_t>(match->boundary)].role =
            FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_SOURCE_CUT;
        boundaries[static_cast<std::size_t>(minus.boundary)].circuit_id =
            circuit_ids[static_cast<std::size_t>(minus.boundary)].c_str();
        boundaries[static_cast<std::size_t>(match->boundary)].circuit_id =
            circuit_ids[static_cast<std::size_t>(match->boundary)].c_str();
    }
    fullmag_fem_steady_transport_rt0_source_cut_v1 source_cut{};
    source_cut.id = "x-cut";
    source_cut.translation_m[0] = 1.0;
    source_cut.potential_drop_v = -1.0;
    source_cut.face_pairs = pairs.data();
    source_cut.face_pair_count = pairs.size();
    fullmag_fem_steady_transport_rt0_closed_geometry_closure_v1 closure{};
    closure.operator_version = "fem_closed_current_geometry.v1";
    closure.revision = "closure-r1";
    closure.digest = "closure-digest-r1";
    closure.source_cuts = &source_cut;
    closure.source_cut_count = 1;

    std::vector<std::uint64_t> stable_ids(static_cast<std::size_t>(mesh.GetNV()));
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        stable_ids[static_cast<std::size_t>(vertex)] =
            1000u + static_cast<std::uint64_t>(vertex);
    }
    fullmag_fem_mesh_desc mesh_desc{};
    mesh_desc.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    mesh_desc.struct_size = sizeof(mesh_desc);
    mesh_desc.nodes_xyz = nodes_xyz.data();
    mesh_desc.nodes_xyz_len = nodes_xyz.size();
    mesh_desc.cell_types = cell_types.data();
    mesh_desc.cell_types_len = cell_types.size();
    mesh_desc.cell_offsets = cell_offsets.data();
    mesh_desc.cell_offsets_len = cell_offsets.size();
    mesh_desc.cell_nodes = cell_nodes.data();
    mesh_desc.cell_nodes_len = cell_nodes.size();
    mesh_desc.facet_types = facet_types.data();
    mesh_desc.facet_types_len = facet_types.size();
    mesh_desc.facet_roles = facet_roles.data();
    mesh_desc.facet_roles_len = facet_roles.size();
    mesh_desc.facet_offsets = facet_offsets.data();
    mesh_desc.facet_offsets_len = facet_offsets.size();
    mesh_desc.facet_nodes = facet_nodes.data();
    mesh_desc.facet_nodes_len = facet_nodes.size();
    mesh_desc.facet_markers = facet_markers.data();
    mesh_desc.facet_markers_len = facet_markers.size();

    std::vector<double> conductivity(static_cast<std::size_t>(mesh.GetNE()), 4.0);
    auto base = fullmag_fem_steady_transport_request_v1{};
    base.abi_version = FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION;
    base.struct_size = sizeof(base);
    base.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE;
    base.mesh = mesh_desc;
    base.charge_conductivity_spm_per_element = conductivity.data();
    base.charge_conductivity_spm_per_element_len = conductivity.size();
    base.maximum_iterations = 1000;

    fullmag_fem_steady_transport_rt0_identity_v1 identity{};
    identity.source_module_id = "current";
    identity.source_state_revision = "state-r1";
    identity.source_field_digest = "field-r1";
    identity.conductivity_digest = "conductivity-r1";
    identity.mesh_revision = "mesh-r1";
    identity.topology_revision = "topology-r1";
    identity.geometry_digest = "geometry-r1";
    identity.envelope_revision = "envelope-r1";
    identity.envelope_digest = "envelope-digest-r1";
    identity.evaluated_envelope_multiplier = 1.0;
    identity.evaluation_time_s = 0.0;
    identity.stage_identity = 1;

    std::vector<double> rt0_dofs(4096);
    std::vector<fullmag_fem_steady_transport_rt0_face_flux_record_v1> records(4096);
    auto request = fullmag_fem_steady_transport_rt0_request_v1{};
    request.abi_version = FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.base = base;
    request.closure_kind = FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_CLOSED_GEOMETRY;
    request.identity = identity;
    request.pins = identity;
    request.stable_vertex_identities.version = "stable_mesh_vertex_u64.v1";
    request.stable_vertex_identities.local_to_stable_vertex_ids = stable_ids.data();
    request.stable_vertex_identities.local_to_stable_vertex_ids_len = stable_ids.size();
    request.boundary_faces = boundaries.data();
    request.boundary_face_count = boundaries.size();
    request.closed_geometry = &closure;
    request.algebraic_relative_tolerance = 1.0e-12;
    request.physical_relative_gate = 1.0e-10;
    request.physical_absolute_gate_a = 1.0e-18;

    auto result = fullmag_fem_steady_transport_rt0_result_v1{};
    result.abi_version = FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION;
    result.struct_size = sizeof(result);
    result.rt0_dof_values = rt0_dofs.data();
    result.rt0_dof_values_capacity = rt0_dofs.size();
    result.canonical_face_records = records.data();
    result.canonical_face_records_capacity = records.size();
    const int status = fullmag_fem_solve_steady_transport_rt0_v1(&request, &result);
    if (status != FULLMAG_FEM_OK) {
        std::cerr << "RT0 solve error: " << result.error_message << '\n';
    }
    require(status == FULLMAG_FEM_OK, "public RT0 solved-current contract failed");
    require(result.converged != 0 && result.rt0_dof_values_len > 0 &&
            result.canonical_face_records_len > 0,
        "public RT0 result did not publish a converged field and records");
    require(std::string(result.operator_version) ==
            "fem_conservative_current_rt0_view.v1",
        "public RT0 result operator identity is wrong");
    require(std::string(result.diagnostics_json).find(
                "fem_conservative_current_rt0_view.v1") != std::string::npos,
        "public RT0 diagnostics schema is missing");

    const std::vector<double> target_points_xyz{
        0.0, 0.0, 0.0,
        3.0, 0.25, 0.25,
    };
    std::vector<double> h_xyz_apm(target_points_xyz.size(), 0.0);
    auto oersted_request =
        fullmag_fem_steady_transport_rt0_oersted_request_v1{};
    oersted_request.abi_version =
        FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION;
    oersted_request.struct_size = sizeof(oersted_request);
    oersted_request.rt0 = request;
    oersted_request.target_points_xyz = target_points_xyz.data();
    oersted_request.target_points_xyz_len = target_points_xyz.size();
    oersted_request.base_quadrature_order = 4;
    oersted_request.maximum_subdivision_depth = 6;
    oersted_request.absolute_tolerance_apm = 1.0e-9;
    oersted_request.relative_tolerance = 1.0e-5;
    oersted_request.maximum_source_target_pairs = 1'000'000;

    auto oersted_result =
        fullmag_fem_steady_transport_rt0_oersted_result_v1{};
    oersted_result.abi_version =
        FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION;
    oersted_result.struct_size = sizeof(oersted_result);
    oersted_result.rt0 = result;
    oersted_result.h_xyz_apm = h_xyz_apm.data();
    oersted_result.h_xyz_apm_capacity = h_xyz_apm.size();
    const int oersted_status =
        fullmag_fem_solve_steady_transport_rt0_oersted_v1(
            &oersted_request, &oersted_result);
    if (oersted_status != FULLMAG_FEM_OK) {
        std::cerr << "RT0 Oersted solve error: " << oersted_result.error_message
                  << '\n';
    }
    require(oersted_status == FULLMAG_FEM_OK,
        "public RT0 OE-F1 solved-current contract failed");
    require(oersted_result.rt0.converged != 0 &&
            oersted_result.h_xyz_apm_len == h_xyz_apm.size(),
        "public RT0 OE-F1 result did not publish a complete field");
    require(std::string(oersted_result.operator_version) ==
            "fem_oersted_direct_tetra_quadrature.v1",
        "public RT0 OE-F1 operator identity is wrong");
    require(std::string(oersted_result.source_view_identity_digest) ==
            std::string(result.view_identity_digest),
        "public RT0 OE-F1 source view digest is not bound to RT0");
    require(std::string(oersted_result.diagnostics_json).find(
                "fem_oersted_direct_tetra_quadrature.v1") != std::string::npos,
        "public RT0 OE-F1 diagnostics schema is missing");
    require(std::all_of(h_xyz_apm.begin(), h_xyz_apm.end(),
                [](double value) { return std::isfinite(value); }),
        "public RT0 OE-F1 field contains a non-finite value");
}

} // namespace

int main()
{
    try {
        run_closed_geometry_rt0_contract();
        std::cout << "fem steady transport RT0 contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem steady transport RT0 contract: FAIL: " << error.what() << '\n';
        return 1;
    }
}
