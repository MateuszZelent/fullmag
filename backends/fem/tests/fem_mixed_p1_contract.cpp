/*
 * fem_mixed_p1_contract.cpp - direct MFEM mixed-topology mesh contract.
 */

#include "core/fem_mesh.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace {

using fullmag::fem::FemMeshRuntimeState;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

FemMeshRuntimeState make_mesh(
    std::vector<double> nodes,
    std::vector<uint32_t> cell_types,
    std::vector<uint32_t> cell_offsets,
    std::vector<uint32_t> cell_nodes,
    std::vector<uint32_t> cell_markers)
{
    FemMeshRuntimeState source{};
    source.n_nodes = static_cast<uint32_t>(nodes.size() / 3u);
    source.n_elements = static_cast<uint32_t>(cell_types.size());
    source.nodes_xyz = std::move(nodes);
    source.cell_types = std::move(cell_types);
    source.cell_offsets = std::move(cell_offsets);
    source.cell_nodes = std::move(cell_nodes);
    source.cell_markers = std::move(cell_markers);
    return source;
}

std::unique_ptr<mfem::Mesh> build(const FemMeshRuntimeState &source)
{
    std::unique_ptr<mfem::Mesh> mesh;
    std::string error;
    check(fullmag::fem::build_mfem_mesh(source, mesh, error), error.c_str());
    check(mesh != nullptr, "successful mixed MFEM build must return a mesh");
    return mesh;
}

void expect_reject(const FemMeshRuntimeState &source, const char *needle)
{
    std::unique_ptr<mfem::Mesh> mesh;
    std::string error;
    check(!fullmag::fem::build_mfem_mesh(source, mesh, error),
          "malformed mixed MFEM mesh must be rejected");
    check(mesh == nullptr, "rejected mixed MFEM build must not publish a mesh");
    check(error.find(needle) != std::string::npos, error.c_str());
}

void check_identity_vertices(mfem::Mesh &mesh, int element, const std::vector<int> &expected)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    check(vertices.Size() == static_cast<int>(expected.size()),
          "MFEM element arity must match canonical arity");
    for (int i = 0; i < vertices.Size(); ++i) {
        check(vertices[i] == expected[static_cast<size_t>(i)],
              "Fullmag-to-MFEM vertex permutation must be the audited identity table");
    }
}

void single_element_families_preserve_geometry_dofs_vertices_and_attributes()
{
    struct Case {
        uint32_t type;
        mfem::Geometry::Type geometry;
        std::vector<double> nodes;
        std::vector<uint32_t> connectivity;
        int attribute;
    };
    const std::vector<Case> cases{
        {FULLMAG_FEM_CELL_TET4, mfem::Geometry::TETRAHEDRON,
         {0,0,0, 1,0,0, 0,1,0, 0,0,1}, {0,1,2,3}, 2},
        {FULLMAG_FEM_CELL_PRISM6, mfem::Geometry::PRISM,
         {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1}, {0,1,2,3,4,5}, 3},
        {FULLMAG_FEM_CELL_PYRAMID5, mfem::Geometry::PYRAMID,
         {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0.5,0.5,1}, {0,1,2,3,4}, 4},
        {FULLMAG_FEM_CELL_HEX8, mfem::Geometry::CUBE,
         {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1},
         {0,1,2,3,4,5,6,7}, 5},
    };

    for (const auto &item : cases) {
        std::vector<uint32_t> offsets{0u, static_cast<uint32_t>(item.connectivity.size())};
        auto source = make_mesh(item.nodes, {item.type}, offsets, item.connectivity,
                                {static_cast<uint32_t>(item.attribute)});
        auto mesh = build(source);
        check(mesh->GetNV() == static_cast<int>(source.n_nodes),
              "MFEM mesh must preserve canonical vertex count");
        check(mesh->GetNE() == 1, "single canonical cell must remain one MFEM element");
        check(mesh->GetElementGeometry(0) == item.geometry,
              "canonical cell family must map to its native MFEM geometry");
        check(mesh->GetAttribute(0) == item.attribute,
              "positive canonical cell marker must remain the MFEM attribute");
        std::vector<int> expected;
        for (uint32_t node : item.connectivity) expected.push_back(static_cast<int>(node));
        check_identity_vertices(*mesh, 0, expected);
        mfem::H1_FECollection fec(1, 3);
        mfem::FiniteElementSpace fes(mesh.get(), &fec);
        check(fes.GetNDofs() == static_cast<int>(source.n_nodes),
              "mixed MFEM H1 P1 space must have one DOF per canonical node");
        check(mesh->CheckElementOrientation(false) == 0,
              "canonical positive element order must remain positive in MFEM");
    }
}

void zero_marker_uses_an_unoccupied_positive_air_attribute()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1,
         2,0,0, 3,0,0, 2,1,0, 2,0,1},
        {FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4},
        {0,4,8}, {0,1,2,3, 4,5,6,7}, {2,0});
    auto mesh = build(source);
    check(mesh->GetAttribute(0) == 2,
          "non-zero canonical marker must remain unchanged");
    check(mesh->GetAttribute(1) == 3,
          "air attribute must not collide with an existing positive marker");
}

FemMeshRuntimeState conforming_prism_pyramid_tet()
{
    return make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1,
         0.5,-1,0.5, 1.5,-1,0.5},
        {FULLMAG_FEM_CELL_PRISM6, FULLMAG_FEM_CELL_PYRAMID5, FULLMAG_FEM_CELL_TET4},
        {0,6,11,15},
        {0,1,2,3,4,5, 0,1,4,3,6, 1,4,6,7},
        {7,0,0});
}

int common_dof_count(mfem::FiniteElementSpace &fes, int first, int second)
{
    mfem::Array<int> a;
    mfem::Array<int> b;
    fes.GetElementDofs(first, a);
    fes.GetElementDofs(second, b);
    int count = 0;
    for (int i = 0; i < a.Size(); ++i) {
        for (int j = 0; j < b.Size(); ++j) {
            if (a[i] == b[j]) ++count;
        }
    }
    return count;
}

void conforming_mixed_domain_shares_faces_and_h1_dofs()
{
    const auto source = conforming_prism_pyramid_tet();
    auto mesh = build(source);
    check(mesh->GetNE() == 3, "mixed domain must preserve canonical cell ordinals");
    check(mesh->GetNFaces() == 12,
          "shared prism-pyramid and pyramid-tet faces must not be duplicated");
    check(mesh->GetNBE() == 10,
          "legacy facet-free descriptor must generate only one-owner faces");
    check(mesh->GetElementGeometry(0) == mfem::Geometry::PRISM &&
          mesh->GetElementGeometry(1) == mfem::Geometry::PYRAMID &&
          mesh->GetElementGeometry(2) == mfem::Geometry::TETRAHEDRON,
          "mixed MFEM element ordering must follow canonical cell ordinals");

    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(mesh.get(), &fec);
    check(fes.GetNDofs() == static_cast<int>(source.n_nodes),
          "conforming mixed H1 P1 domain must have one DOF per global node");
    check(common_dof_count(fes, 0, 1) == 4,
          "prism-pyramid quad interface must share four H1 DOFs");
    check(common_dof_count(fes, 1, 2) == 3,
          "pyramid-tet triangle interface must share three H1 DOFs");
}

FemMeshRuntimeState typed_prism_pyramid_boundary()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1, 0.5,-1,0.5},
        {FULLMAG_FEM_CELL_PRISM6, FULLMAG_FEM_CELL_PYRAMID5},
        {0,6,11}, {0,1,2,3,4,5, 0,1,4,3,6}, {7,0});
    source.facet_types = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_QUAD4, FULLMAG_FEM_FACET_QUAD4,
        FULLMAG_FEM_FACET_QUAD4,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3};
    source.facet_roles = {
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    source.facet_offsets = {0,3,6,10,14,18,21,24,27,30};
    source.facet_nodes = {
        0,1,2, 3,4,5, 0,1,4,3, 1,2,5,4, 2,0,3,5,
        0,1,6, 1,4,6, 4,3,6, 3,0,6};
    source.facet_markers = {77,12,20,13,14,15,16,17,0};
    source.n_boundary_faces = static_cast<uint32_t>(source.facet_types.size());
    return source;
}

void typed_boundary_uses_owner_orientation_roles_and_attributes()
{
    const auto source = typed_prism_pyramid_boundary();
    auto mesh = build(source);
    check(mesh->GetNBE() == 8,
          "material interface must not become an MFEM boundary element");
    int triangles = 0;
    int quads = 0;
    bool found_periodic = false;
    std::vector<int> boundary_attributes;
    for (int boundary = 0; boundary < mesh->GetNBE(); ++boundary) {
        const auto geometry = mesh->GetBdrElementGeometry(boundary);
        triangles += geometry == mfem::Geometry::TRIANGLE ? 1 : 0;
        quads += geometry == mfem::Geometry::SQUARE ? 1 : 0;
        int owner = -1;
        int info = -1;
        mesh->GetBdrElementAdjacentElement(boundary, owner, info);
        check(owner >= 0 && owner < mesh->GetNE(),
              "every canonical exterior/seam facet must keep its sole owner");
        boundary_attributes.push_back(mesh->GetBdrAttribute(boundary));
        if (mesh->GetBdrAttribute(boundary) == 77) {
            found_periodic = true;
            mfem::Array<int> vertices;
            mesh->GetBdrElementVertices(boundary, vertices);
            check(vertices.Size() == 3 && vertices[0] == 0 && vertices[1] == 2 && vertices[2] == 1,
                  "boundary orientation must come from the owner face, not reversed input winding");
        }
        check(mesh->GetBdrAttribute(boundary) != 20,
              "material-interface marker must not leak into MFEM boundary attributes");
    }
    check(triangles == 6 && quads == 2,
          "typed boundary must preserve native tri3 and quad4 geometries");
    check(found_periodic, "periodic seam must remain an attributed MFEM boundary element");
    std::sort(boundary_attributes.begin(), boundary_attributes.end());
    check(boundary_attributes == std::vector<int>({1,12,13,14,15,16,17,77}),
          "boundary markers must be preserved, with zero mapped to positive attribute one");
}

void all_tet_periodic_seam_remains_an_attributed_boundary()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1},
        {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {1});
    source.facet_types = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3};
    source.facet_roles = {
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    source.facet_offsets = {0,3,6,9,12};
    source.facet_nodes = {0,1,2, 0,1,3, 1,2,3, 2,0,3};
    source.facet_markers = {91,2,3,4};
    source.n_boundary_faces = 4;

    auto mesh = build(source);
    check(mesh->GetNBE() == 4,
          "all-tet typed boundary must keep all one-owner faces");
    bool found_periodic = false;
    for (int boundary = 0; boundary < mesh->GetNBE(); ++boundary) {
        found_periodic = found_periodic || mesh->GetBdrAttribute(boundary) == 91;
    }
    check(found_periodic,
          "all-tet periodic seam marker must remain available to Robin-boundary exclusion");
}

void malformed_face_ownership_and_marker_inputs_fail_closed()
{
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_roles[2] = FULLMAG_FEM_FACET_ROLE_EXTERIOR;
        expect_reject(source, "exterior facet must have exactly one owner");
    }
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_roles[0] = FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE;
        expect_reject(source, "material-interface facet must have exactly two owners");
    }
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_types.push_back(source.facet_types[0]);
        source.facet_roles.push_back(source.facet_roles[0]);
        source.facet_nodes.insert(source.facet_nodes.end(), {0,2,1});
        source.facet_offsets.push_back(static_cast<uint32_t>(source.facet_nodes.size()));
        source.facet_markers.push_back(78);
        source.n_boundary_faces += 1u;
        expect_reject(source, "duplicate input facet");
    }
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_nodes[0] = 0;
        source.facet_nodes[1] = 1;
        source.facet_nodes[2] = 5;
        expect_reject(source, "input facet has no volume-cell owner");
    }
    {
        auto source = make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,0,-1, 0,0,2},
            {FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4},
            {0,4,8,12}, {0,1,2,3, 0,2,1,4, 0,1,2,5}, {1,1,1});
        expect_reject(source, "non-manifold face has more than two owners");
    }
    {
        auto source = make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1},
            {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3},
            {static_cast<uint32_t>(std::numeric_limits<int>::max()) + 1u});
        expect_reject(source, "cell marker exceeds positive MFEM attribute range");
    }
    {
        auto source = make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1},
            {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {1});
        source.facet_types = {FULLMAG_FEM_FACET_TRI3};
        source.facet_roles = {FULLMAG_FEM_FACET_ROLE_EXTERIOR};
        source.facet_offsets = {0,3};
        source.facet_nodes = {0,2,1};
        source.facet_markers = {1};
        source.n_boundary_faces = 1;
        expect_reject(source, "typed facet list is incomplete");
    }
}

} // namespace

int main()
{
    single_element_families_preserve_geometry_dofs_vertices_and_attributes();
    zero_marker_uses_an_unoccupied_positive_air_attribute();
    conforming_mixed_domain_shares_faces_and_h1_dofs();
    typed_boundary_uses_owner_orientation_roles_and_attributes();
    all_tet_periodic_seam_remains_an_attributed_boundary();
    malformed_face_ownership_and_marker_inputs_fail_closed();
    return 0;
}

#else

int main()
{
    return 0;
}

#endif
