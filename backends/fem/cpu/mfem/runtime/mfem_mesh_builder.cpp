/*
 * MFEM mesh-builder source contract.
 *
 * This source owns canonical topology translation, local permutations,
 * volume/boundary attributes, face ownership, and general MFEM finalization.
 * It does not own physics capability, materials, operators, or device policy.
 */

#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "core/fem_mesh.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <exception>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem {
namespace {

constexpr std::array<uint8_t, 4> kTetFullmagToMfem{{0, 1, 2, 3}};
constexpr std::array<uint8_t, 6> kPrismFullmagToMfem{{0, 1, 2, 3, 4, 5}};
constexpr std::array<uint8_t, 5> kPyramidFullmagToMfem{{0, 1, 2, 3, 4}};
constexpr std::array<uint8_t, 8> kHexFullmagToMfem{{0, 1, 2, 3, 4, 5, 6, 7}};

struct FaceKey {
    uint8_t arity = 0;
    std::array<uint32_t, 4> nodes{{0, 0, 0, 0}};

    bool operator<(const FaceKey &other) const
    {
        return arity < other.arity || (arity == other.arity && nodes < other.nodes);
    }
};

struct FaceRecord {
    uint8_t arity = 0;
    std::array<uint32_t, 4> oriented_nodes{{0, 0, 0, 0}};
    std::array<uint32_t, 2> owners{{0, 0}};
    uint8_t owner_count = 0;
};

struct BoundaryRecord {
    uint32_t type = 0;
    std::array<uint32_t, 4> nodes{{0, 0, 0, 0}};
    int attribute = 1;
};

uint8_t facet_arity(uint32_t type)
{
    switch (type) {
        case FULLMAG_FEM_FACET_TRI3: return 3u;
        case FULLMAG_FEM_FACET_QUAD4: return 4u;
        default: return 0u;
    }
}

FaceKey face_key(const std::array<uint32_t, 4> &nodes, uint8_t arity)
{
    FaceKey key{};
    key.arity = arity;
    std::copy_n(nodes.begin(), arity, key.nodes.begin());
    std::sort(key.nodes.begin(), key.nodes.begin() + arity);
    return key;
}

bool validate_source_shape(const FemMeshRuntimeState &source, std::string &error)
{
    if (source.n_nodes == 0u || source.n_elements == 0u) {
        error = "MFEM mesh builder requires at least one node and one element";
        return false;
    }
    if (source.n_nodes > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        source.n_elements > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        source.n_boundary_faces > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
        error = "MFEM mesh cardinality exceeds signed int range";
        return false;
    }
    if (source.nodes_xyz.size() != 3u * static_cast<size_t>(source.n_nodes) ||
        source.cell_types.size() != source.n_elements ||
        source.cell_offsets.size() != static_cast<size_t>(source.n_elements) + 1u ||
        (!source.cell_markers.empty() && source.cell_markers.size() != source.n_elements)) {
        error = "MFEM mesh builder received inconsistent canonical cell buffers";
        return false;
    }
    if (source.cell_offsets.front() != 0u ||
        source.cell_offsets.back() != source.cell_nodes.size()) {
        error = "MFEM mesh builder received invalid canonical cell offsets";
        return false;
    }
    if (source.facet_types.size() != source.n_boundary_faces ||
        (!source.facet_types.empty() &&
         (source.facet_roles.size() != source.facet_types.size() ||
          source.facet_offsets.size() != source.facet_types.size() + 1u ||
          (!source.facet_markers.empty() &&
           source.facet_markers.size() != source.facet_types.size())))) {
        error = "MFEM mesh builder received inconsistent canonical facet buffers";
        return false;
    }
    if (!source.facet_types.empty() &&
        (source.facet_offsets.front() != 0u ||
         source.facet_offsets.back() != source.facet_nodes.size())) {
        error = "MFEM mesh builder received invalid canonical facet offsets";
        return false;
    }
    for (double coordinate : source.nodes_xyz) {
        if (!std::isfinite(coordinate)) {
            error = "MFEM mesh node coordinates must be finite";
            return false;
        }
    }
    return true;
}

bool build_face_index(
    const FemMeshRuntimeState &source,
    std::map<FaceKey, FaceRecord> &faces,
    std::string &error)
{
    for (uint32_t element = 0; element < source.n_elements; ++element) {
        ElementTopology topology{};
        if (!element_topology(source.cell_types[element], topology)) {
            error = "MFEM mesh builder received unsupported canonical cell type";
            return false;
        }
        const uint32_t start = source.cell_offsets[element];
        const uint32_t end = source.cell_offsets[element + 1u];
        if (start > end || end > source.cell_nodes.size() || end - start != topology.arity) {
            error = "MFEM mesh builder cell CSR arity does not match canonical type";
            return false;
        }
        for (uint32_t cursor = start; cursor < end; ++cursor) {
            if (source.cell_nodes[cursor] >= source.n_nodes ||
                source.cell_nodes[cursor] > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
                error = "MFEM mesh builder cell references an invalid vertex";
                return false;
            }
            for (uint32_t previous = start; previous < cursor; ++previous) {
                if (source.cell_nodes[previous] == source.cell_nodes[cursor]) {
                    error = "MFEM mesh builder cell contains duplicate local vertices";
                    return false;
                }
            }
        }
        for (uint8_t local_face = 0; local_face < topology.faces.entity_count; ++local_face) {
            const uint8_t local_start = topology.faces.offsets[local_face];
            const uint8_t local_end = topology.faces.offsets[local_face + 1u];
            const uint8_t arity = local_end - local_start;
            std::array<uint32_t, 4> oriented{{0, 0, 0, 0}};
            for (uint8_t node = 0; node < arity; ++node) {
                const uint8_t local_node = topology.faces.nodes[local_start + node];
                oriented[node] = source.cell_nodes[start + local_node];
            }
            auto &record = faces[face_key(oriented, arity)];
            if (record.owner_count == 0u) {
                record.arity = arity;
                record.oriented_nodes = oriented;
            }
            if (record.owner_count >= 2u) {
                error = "MFEM mesh builder non-manifold face has more than two owners";
                return false;
            }
            record.owners[record.owner_count++] = element;
        }
    }
    return true;
}

bool collect_boundaries(
    const FemMeshRuntimeState &source,
    const std::map<FaceKey, FaceRecord> &faces,
    std::vector<BoundaryRecord> &boundaries,
    std::string &error)
{
    if (source.facet_types.empty()) {
        for (const auto &[key, face] : faces) {
            (void)key;
            if (face.owner_count == 1u) {
                boundaries.push_back({
                    face.arity == 3u ? FULLMAG_FEM_FACET_TRI3 : FULLMAG_FEM_FACET_QUAD4,
                    face.oriented_nodes,
                    1,
                });
            }
        }
        return true;
    }

    std::map<FaceKey, uint32_t> input_faces;
    for (uint32_t facet = 0; facet < source.n_boundary_faces; ++facet) {
        const uint8_t arity = facet_arity(source.facet_types[facet]);
        const uint32_t start = source.facet_offsets[facet];
        const uint32_t end = source.facet_offsets[facet + 1u];
        if (arity == 0u || start > end || end > source.facet_nodes.size() || end - start != arity) {
            error = "MFEM mesh builder facet CSR arity does not match canonical type";
            return false;
        }
        std::array<uint32_t, 4> input_nodes{{0, 0, 0, 0}};
        for (uint8_t node = 0; node < arity; ++node) {
            input_nodes[node] = source.facet_nodes[start + node];
            if (input_nodes[node] >= source.n_nodes) {
                error = "MFEM mesh builder facet references an invalid vertex";
                return false;
            }
            for (uint8_t previous = 0; previous < node; ++previous) {
                if (input_nodes[previous] == input_nodes[node]) {
                    error = "MFEM mesh builder facet contains duplicate local vertices";
                    return false;
                }
            }
        }
        const FaceKey key = face_key(input_nodes, arity);
        if (!input_faces.emplace(key, facet).second) {
            error = "MFEM mesh builder duplicate input facet key";
            return false;
        }
        const auto owner = faces.find(key);
        if (owner == faces.end()) {
            error = "MFEM mesh builder input facet has no volume-cell owner";
            return false;
        }

        const uint32_t role = source.facet_roles[facet];
        if (role == FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE) {
            if (owner->second.owner_count != 2u) {
                error = "MFEM mesh builder material-interface facet must have exactly two owners";
                return false;
            }
            continue;
        }
        if (role != FULLMAG_FEM_FACET_ROLE_EXTERIOR &&
            role != FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM) {
            error = "MFEM mesh builder received unsupported canonical facet role";
            return false;
        }
        if (owner->second.owner_count != 1u) {
            error = role == FULLMAG_FEM_FACET_ROLE_EXTERIOR
                ? "MFEM mesh builder exterior facet must have exactly one owner"
                : "MFEM mesh builder periodic-seam facet must have exactly one owner";
            return false;
        }
        const uint32_t marker = source.facet_markers.empty() ? 1u : source.facet_markers[facet];
        if (marker > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
            error = "MFEM boundary marker exceeds positive MFEM attribute range";
            return false;
        }
        boundaries.push_back({
            source.facet_types[facet],
            owner->second.oriented_nodes,
            marker == 0u ? 1 : static_cast<int>(marker),
        });
    }

    for (const auto &[key, face] : faces) {
        if (face.owner_count == 1u && input_faces.find(key) == input_faces.end()) {
            error = "MFEM mesh builder typed facet list is incomplete for one-owner faces";
            return false;
        }
    }
    return true;
}

bool volume_attributes(
    const FemMeshRuntimeState &source,
    std::vector<int> &attributes,
    std::string &error)
{
    uint32_t maximum_marker = 0u;
    bool has_air = source.cell_markers.empty();
    for (uint32_t marker : source.cell_markers) {
        if (marker > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
            error = "MFEM cell marker exceeds positive MFEM attribute range";
            return false;
        }
        maximum_marker = std::max(maximum_marker, marker);
        has_air = has_air || marker == 0u;
    }
    int air_attribute = 1;
    if (has_air) {
        if (maximum_marker == static_cast<uint32_t>(std::numeric_limits<int>::max())) {
            error = "MFEM mesh builder cannot allocate an unoccupied positive air attribute";
            return false;
        }
        air_attribute = static_cast<int>(maximum_marker + 1u);
    }
    attributes.reserve(source.n_elements);
    for (uint32_t element = 0; element < source.n_elements; ++element) {
        const uint32_t marker = source.cell_markers.empty() ? 1u : source.cell_markers[element];
        attributes.push_back(marker == 0u ? air_attribute : static_cast<int>(marker));
    }
    return true;
}

template <size_t N>
void permute_vertices(
    const FemMeshRuntimeState &source,
    uint32_t element,
    const std::array<uint8_t, N> &permutation,
    int (&vertices)[8])
{
    const uint32_t start = source.cell_offsets[element];
    for (size_t node = 0; node < N; ++node) {
        vertices[node] = static_cast<int>(source.cell_nodes[start + permutation[node]]);
    }
}

mfem::Geometry::Type expected_geometry(uint32_t type)
{
    switch (type) {
        case FULLMAG_FEM_CELL_TET4: return mfem::Geometry::TETRAHEDRON;
        case FULLMAG_FEM_CELL_PRISM6: return mfem::Geometry::PRISM;
        case FULLMAG_FEM_CELL_PYRAMID5: return mfem::Geometry::PYRAMID;
        case FULLMAG_FEM_CELL_HEX8: return mfem::Geometry::CUBE;
        default: return mfem::Geometry::INVALID;
    }
}

bool verify_finalized_mesh(
    const FemMeshRuntimeState &source,
    const std::vector<BoundaryRecord> &boundaries,
    mfem::Mesh &mesh,
    std::string &error)
{
    if (mesh.GetNV() != static_cast<int>(source.n_nodes) ||
        mesh.GetNE() != static_cast<int>(source.n_elements) ||
        mesh.GetNBE() != static_cast<int>(boundaries.size())) {
        error = "finalized MFEM mesh cardinality differs from canonical topology";
        return false;
    }
    if (mesh.CheckElementOrientation(false) != 0) {
        error = "finalized MFEM mesh contains an inverted element";
        return false;
    }
    for (uint32_t element = 0; element < source.n_elements; ++element) {
        if (mesh.GetElementGeometry(static_cast<int>(element)) !=
            expected_geometry(source.cell_types[element])) {
            error = "finalized MFEM mesh element geometry differs from canonical type";
            return false;
        }
        mfem::Array<int> vertices;
        mesh.GetElementVertices(static_cast<int>(element), vertices);
        const uint32_t start = source.cell_offsets[element];
        const uint32_t end = source.cell_offsets[element + 1u];
        if (vertices.Size() != static_cast<int>(end - start)) {
            error = "finalized MFEM mesh element arity differs from canonical topology";
            return false;
        }
        for (int node = 0; node < vertices.Size(); ++node) {
            if (vertices[node] != static_cast<int>(source.cell_nodes[start + node])) {
                error = "finalized MFEM mesh changed the audited local vertex permutation";
                return false;
            }
        }
        mfem::ElementTransformation *transformation =
            mesh.GetElementTransformation(static_cast<int>(element));
        const mfem::IntegrationRule &rule =
            mfem::IntRules.Get(mesh.GetElementGeometry(static_cast<int>(element)), 2);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            const mfem::IntegrationPoint &integration_point = rule.IntPoint(point);
            transformation->SetIntPoint(&integration_point);
            const double determinant = transformation->Jacobian().Det();
            if (!std::isfinite(determinant) || determinant <= 0.0) {
                error = "finalized MFEM mesh has a non-positive order-two Jacobian";
                return false;
            }
        }
    }
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        const mfem::Geometry::Type expected = boundaries[static_cast<size_t>(boundary)].type ==
                FULLMAG_FEM_FACET_TRI3
            ? mfem::Geometry::TRIANGLE
            : mfem::Geometry::SQUARE;
        if (mesh.GetBdrElementGeometry(boundary) != expected) {
            error = "finalized MFEM boundary geometry differs from canonical facet type";
            return false;
        }
    }
    return true;
}

} // namespace

bool build_mfem_mesh(
    const FemMeshRuntimeState &source,
    std::unique_ptr<mfem::Mesh> &mesh,
    std::string &error)
{
    mesh.reset();
    error.clear();
    try {
        if (!validate_source_shape(source, error)) {
            return false;
        }
        std::map<FaceKey, FaceRecord> faces;
        if (!build_face_index(source, faces, error)) {
            return false;
        }
        std::vector<BoundaryRecord> boundaries;
        if (!collect_boundaries(source, faces, boundaries, error)) {
            return false;
        }
        std::vector<int> attributes;
        if (!volume_attributes(source, attributes, error)) {
            return false;
        }
        if (boundaries.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            error = "MFEM boundary element count exceeds signed int range";
            return false;
        }

        auto candidate = std::make_unique<mfem::Mesh>(
            3,
            static_cast<int>(source.n_nodes),
            static_cast<int>(source.n_elements),
            static_cast<int>(boundaries.size()),
            3);
        for (uint32_t node = 0; node < source.n_nodes; ++node) {
            candidate->AddVertex(source.nodes_xyz.data() + 3u * static_cast<size_t>(node));
        }
        for (uint32_t element = 0; element < source.n_elements; ++element) {
            int vertices[8]{};
            switch (source.cell_types[element]) {
                case FULLMAG_FEM_CELL_TET4:
                    permute_vertices(source, element, kTetFullmagToMfem, vertices);
                    candidate->AddTet(vertices, attributes[element]);
                    break;
                case FULLMAG_FEM_CELL_PRISM6:
                    permute_vertices(source, element, kPrismFullmagToMfem, vertices);
                    candidate->AddWedge(vertices, attributes[element]);
                    break;
                case FULLMAG_FEM_CELL_PYRAMID5:
                    permute_vertices(source, element, kPyramidFullmagToMfem, vertices);
                    candidate->AddPyramid(vertices, attributes[element]);
                    break;
                case FULLMAG_FEM_CELL_HEX8:
                    permute_vertices(source, element, kHexFullmagToMfem, vertices);
                    candidate->AddHex(vertices, attributes[element]);
                    break;
                default:
                    error = "MFEM mesh builder received unsupported canonical cell type";
                    return false;
            }
        }
        for (const auto &boundary : boundaries) {
            int vertices[4]{};
            for (size_t node = 0; node < 4u; ++node) {
                vertices[node] = static_cast<int>(boundary.nodes[node]);
            }
            if (boundary.type == FULLMAG_FEM_FACET_TRI3) {
                candidate->AddBdrTriangle(vertices, boundary.attribute);
            } else {
                candidate->AddBdrQuad(vertices, boundary.attribute);
            }
        }

        candidate->FinalizeTopology(false);
        candidate->Finalize(false, false);
        if (!verify_finalized_mesh(source, boundaries, *candidate, error)) {
            return false;
        }
        mesh = std::move(candidate);
        return true;
    } catch (const std::exception &exception) {
        error = std::string("MFEM mesh builder failed: ") + exception.what();
    } catch (...) {
        error = "MFEM mesh builder failed with an unknown exception";
    }
    return false;
}

} // namespace fullmag::fem

#endif
