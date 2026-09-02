/*
 * FEM/BEM demag surface source contract.
 *
 * This source owns body-only boundary surface extraction, oriented exterior face
 * discovery, boundary-node maps, normals, triangle areas, and topology
 * validation.
 * It does not assemble BEM operators, solve sparse systems, transfer boundary values, compute energy, or orchestrate solves.
 */

#include "cpu/mfem/interactions/demag_fem_bem_surface.hpp"

#include "context.hpp"
#include "fem_geometry.hpp"
#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace fullmag::fem {
namespace {

constexpr double kRelativeGeometryTolerance =
    128.0 * std::numeric_limits<double>::epsilon();

struct FaceKey {
    uint32_t a;
    uint32_t b;
    uint32_t c;
};

struct FaceRecord {
    FaceKey key{};
    std::array<uint32_t, 3> tri{};
    uint32_t opposite = 0;
    uint32_t count = 0;
};

using Vec3 = fullmag::fem::Vec3;
inline Vec3 sub(const Vec3 &a, const Vec3 &b) { return vec3_sub(a, b); }
inline Vec3 add(const Vec3 &a, const Vec3 &b) { return vec3_add(a, b); }
inline Vec3 scale(const Vec3 &a, double s) { return vec3_scale(a, s); }
inline double dot(const Vec3 &a, const Vec3 &b) { return vec3_dot(a, b); }
inline Vec3 cross(const Vec3 &a, const Vec3 &b) { return vec3_cross(a, b); }

double stable_norm(const Vec3 &value) {
    return std::hypot(
        std::hypot(std::abs(value[0]), std::abs(value[1])),
        std::abs(value[2]));
}

bool finite_vec3(const Vec3 &value) {
    return std::isfinite(value[0]) &&
           std::isfinite(value[1]) &&
           std::isfinite(value[2]);
}

Vec3 node_position(const Context &ctx, uint32_t node) {
    return mesh_node_position(ctx.mesh.nodes_xyz, node);
}

FaceKey sorted_key(std::array<uint32_t, 3> tri) {
    std::sort(tri.begin(), tri.end());
    return {tri[0], tri[1], tri[2]};
}

bool key_less(const FaceKey &lhs, const FaceKey &rhs) {
    return std::tie(lhs.a, lhs.b, lhs.c) < std::tie(rhs.a, rhs.b, rhs.c);
}

bool key_equal(const FaceKey &lhs, const FaceKey &rhs) {
    return lhs.a == rhs.a && lhs.b == rhs.b && lhs.c == rhs.c;
}

bool same_node(uint32_t lhs, uint32_t rhs) {
    return lhs == rhs;
}

std::array<std::array<uint32_t, 3>, 4> tetra_faces(
    const std::array<uint32_t, 4> &tet)
{
    return {{
        {tet[1], tet[2], tet[3]},
        {tet[0], tet[3], tet[2]},
        {tet[0], tet[1], tet[3]},
        {tet[0], tet[2], tet[1]},
    }};
}

std::array<uint32_t, 4> tetra_opposites(const std::array<uint32_t, 4> &tet) {
    return tet;
}

bool active_element(const Context &ctx, size_t element) {
    return ctx.mesh.magnetic_element_mask.empty() ||
           ctx.mesh.magnetic_element_mask[element] != 0u;
}

bool validate_mesh_contract(
    const Context &ctx,
    double &characteristic_length,
    std::string &error)
{
    const auto &mesh = ctx.mesh;
    if (mesh.n_nodes == 0 || mesh.n_elements == 0) {
        error = "FEM/BEM demag requires a non-empty magnetic tetrahedral mesh";
        return false;
    }
    if (mesh.nodes_xyz.size() != static_cast<size_t>(mesh.n_nodes) * 3u) {
        error = "FEM/BEM demag nodes_xyz length is inconsistent with n_nodes";
        return false;
    }
    if (mesh.cell_types.size() != static_cast<size_t>(mesh.n_elements)) {
        error = "FEM/BEM demag requires typed cell_types for every element";
        return false;
    }
    if (mesh.cell_offsets.size() != static_cast<size_t>(mesh.n_elements) + 1u ||
        mesh.cell_offsets.empty() ||
        mesh.cell_offsets.front() != 0u ||
        mesh.cell_offsets.back() != mesh.cell_nodes.size()) {
        error = "FEM/BEM demag cell CSR buffers are inconsistent";
        return false;
    }
    if (!mesh.magnetic_element_mask.empty() &&
        mesh.magnetic_element_mask.size() != static_cast<size_t>(mesh.n_elements)) {
        error = "FEM/BEM demag magnetic element mask length is inconsistent";
        return false;
    }
    for (size_t i = 0; i < mesh.nodes_xyz.size(); ++i) {
        if (!std::isfinite(mesh.nodes_xyz[i])) {
            error = "FEM/BEM demag mesh contains a non-finite coordinate";
            return false;
        }
    }

    Vec3 lower = {
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity()};
    Vec3 upper = {
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity()};
    bool has_active_element = false;

    for (size_t element = 0; element < static_cast<size_t>(mesh.n_elements); ++element) {
        if (mesh.cell_types[element] != FULLMAG_FEM_CELL_TET4) {
            error = "FEM/BEM demag requires typed TET4 active/body topology";
            return false;
        }
        if (mesh.cell_offsets[element] > mesh.cell_offsets[element + 1u]) {
            error = "FEM/BEM demag cell CSR offsets are not monotone";
            return false;
        }
        const size_t begin = mesh.cell_offsets[element];
        const size_t end = mesh.cell_offsets[element + 1u];
        if (end - begin != 4u) {
            error = "FEM/BEM demag TET4 cell has an invalid connectivity span";
            return false;
        }
        const std::array<uint32_t, 4> tet = {
            mesh.cell_nodes[begin + 0u],
            mesh.cell_nodes[begin + 1u],
            mesh.cell_nodes[begin + 2u],
            mesh.cell_nodes[begin + 3u]};
        for (size_t i = 0; i < tet.size(); ++i) {
            if (tet[i] >= mesh.n_nodes) {
                error = "FEM/BEM demag element node is outside the mesh";
                return false;
            }
            for (size_t j = 0; j < i; ++j) {
                if (same_node(tet[i], tet[j])) {
                    error = "FEM/BEM demag TET4 cell contains a duplicate node";
                    return false;
                }
            }
        }

        const Vec3 p0 = node_position(ctx, tet[0]);
        const Vec3 p1 = node_position(ctx, tet[1]);
        const Vec3 p2 = node_position(ctx, tet[2]);
        const Vec3 p3 = node_position(ctx, tet[3]);
        const Vec3 edge0 = sub(p1, p0);
        const Vec3 edge1 = sub(p2, p0);
        const Vec3 edge2 = sub(p3, p0);
        const double edge0_norm = stable_norm(edge0);
        const double edge1_norm = stable_norm(edge1);
        const double edge2_norm = stable_norm(edge2);
        const double edge_product = edge0_norm * edge1_norm * edge2_norm;
        const double determinant = dot(edge0, cross(edge1, edge2));
        if (!std::isfinite(edge_product) || !(edge_product > 0.0) ||
            !std::isfinite(determinant) ||
            !(std::abs(determinant) / edge_product > kRelativeGeometryTolerance)) {
            error = "FEM/BEM demag TET4 cell has zero or degenerate volume";
            return false;
        }

        if (active_element(ctx, element)) {
            has_active_element = true;
            for (uint32_t node : tet) {
                const Vec3 point = node_position(ctx, node);
                for (int axis = 0; axis < 3; ++axis) {
                    lower[axis] = std::min(lower[axis], point[axis]);
                    upper[axis] = std::max(upper[axis], point[axis]);
                }
            }
        }
    }

    if (!has_active_element) {
        error = "FEM/BEM demag requires at least one active magnetic element";
        return false;
    }
    characteristic_length = std::max({
        upper[0] - lower[0],
        upper[1] - lower[1],
        upper[2] - lower[2]});
    if (!std::isfinite(characteristic_length) ||
        !(characteristic_length > 0.0)) {
        error = "FEM/BEM demag active mesh has no finite characteristic length";
        return false;
    }

    return true;
}

bool face_references_valid_nodes(
    const Context &ctx,
    const std::array<uint32_t, 3> &face)
{
    return face[0] < ctx.mesh.n_nodes &&
           face[1] < ctx.mesh.n_nodes &&
           face[2] < ctx.mesh.n_nodes;
}

bool build_face_records(
    const Context &ctx,
    std::vector<FaceRecord> &records,
    std::string &error)
{
    records.clear();
    records.reserve(static_cast<size_t>(ctx.mesh.n_elements) * 4u);
    for (size_t elem = 0; elem < static_cast<size_t>(ctx.mesh.n_elements); ++elem) {
        if (!active_element(ctx, elem)) {
            continue;
        }
        const size_t base = ctx.mesh.cell_offsets[elem];
        const std::array<uint32_t, 4> tet = {
            ctx.mesh.cell_nodes[base + 0u],
            ctx.mesh.cell_nodes[base + 1u],
            ctx.mesh.cell_nodes[base + 2u],
            ctx.mesh.cell_nodes[base + 3u]};
        const auto faces = tetra_faces(tet);
        const auto opposites = tetra_opposites(tet);
        for (size_t i = 0; i < faces.size(); ++i) {
            records.push_back(FaceRecord{
                sorted_key(faces[i]),
                faces[i],
                opposites[i],
                1u});
        }
    }
    std::sort(records.begin(), records.end(), [](const FaceRecord &lhs, const FaceRecord &rhs) {
        return key_less(lhs.key, rhs.key);
    });

    std::vector<FaceRecord> merged;
    merged.reserve(records.size());
    for (const FaceRecord &record : records) {
        if (!merged.empty() && key_equal(merged.back().key, record.key)) {
            if (merged.back().count == std::numeric_limits<uint32_t>::max()) {
                error = "FEM/BEM demag boundary face owner count overflow";
                return false;
            }
            merged.back().count += 1u;
            continue;
        }
        merged.push_back(record);
    }
    for (const FaceRecord &record : merged) {
        if (record.count > 2u) {
            error = "FEM/BEM demag boundary face is nonmanifold: more than two owners";
            return false;
        }
    }
    records = std::move(merged);
    return true;
}

const FaceRecord *find_face_record(
    const std::vector<FaceRecord> &records,
    const FaceKey &key)
{
    const auto it = std::lower_bound(
        records.begin(),
        records.end(),
        key,
        [](const FaceRecord &lhs, const FaceKey &rhs) {
            return key_less(lhs.key, rhs);
        });
    if (it == records.end() || !key_equal(it->key, key)) {
        return nullptr;
    }
    return &*it;
}

bool collect_explicit_facets(
    const Context &ctx,
    std::vector<std::array<uint32_t, 3>> &facets,
    bool &has_explicit_facets,
    std::string &error)
{
    const bool typed_metadata_present =
        !ctx.mesh.facet_types.empty() ||
        !ctx.mesh.facet_roles.empty() ||
        !ctx.mesh.facet_offsets.empty() ||
        !ctx.mesh.facet_global_ordinals.empty() ||
        !ctx.mesh.facet_markers.empty();
    has_explicit_facets = !ctx.mesh.facet_nodes.empty() ||
                          typed_metadata_present ||
                          ctx.mesh.n_boundary_faces != 0u;
    facets.clear();
    if (!has_explicit_facets) {
        return true;
    }
    if (ctx.mesh.facet_nodes.empty()) {
        error = "FEM/BEM explicit boundary metadata has no facet nodes";
        return false;
    }

    if (!typed_metadata_present) {
        if (ctx.mesh.facet_nodes.size() % 3u != 0u) {
            error = "FEM/BEM demag boundary face buffer length is not a multiple of 3";
            return false;
        }
        const size_t facet_count = ctx.mesh.facet_nodes.size() / 3u;
        if (ctx.mesh.n_boundary_faces != 0u &&
            ctx.mesh.n_boundary_faces != facet_count) {
            error = "FEM/BEM explicit boundary face count is inconsistent";
            return false;
        }
        facets.reserve(facet_count);
        for (size_t i = 0; i < facet_count; ++i) {
            facets.push_back({
                ctx.mesh.facet_nodes[i * 3u + 0u],
                ctx.mesh.facet_nodes[i * 3u + 1u],
                ctx.mesh.facet_nodes[i * 3u + 2u]});
        }
        return true;
    }

    const size_t facet_count = ctx.mesh.facet_types.size();
    if (facet_count == 0u ||
        ctx.mesh.facet_offsets.size() != facet_count + 1u ||
        ctx.mesh.facet_offsets.front() != 0u ||
        ctx.mesh.facet_offsets.back() != ctx.mesh.facet_nodes.size() ||
        (!ctx.mesh.facet_roles.empty() &&
         ctx.mesh.facet_roles.size() != facet_count) ||
        (!ctx.mesh.facet_global_ordinals.empty() &&
         ctx.mesh.facet_global_ordinals.size() != facet_count) ||
        (!ctx.mesh.facet_markers.empty() &&
         ctx.mesh.facet_markers.size() != facet_count)) {
        error = "FEM/BEM explicit boundary facet CSR metadata is inconsistent";
        return false;
    }
    if (ctx.mesh.n_boundary_faces != 0u &&
        ctx.mesh.n_boundary_faces != facet_count) {
        error = "FEM/BEM explicit boundary face count is inconsistent";
        return false;
    }
    facets.reserve(facet_count);
    for (size_t facet = 0; facet < facet_count; ++facet) {
        if (ctx.mesh.facet_types[facet] != FULLMAG_FEM_FACET_TRI3) {
            error = "FEM/BEM body-only boundary requires TRI3 exterior facets";
            return false;
        }
        if (!ctx.mesh.facet_roles.empty() &&
            ctx.mesh.facet_roles[facet] != FULLMAG_FEM_FACET_ROLE_EXTERIOR) {
            error = "FEM/BEM body-only boundary rejects non-exterior facet roles";
            return false;
        }
        if (ctx.mesh.facet_offsets[facet] > ctx.mesh.facet_offsets[facet + 1u] ||
            ctx.mesh.facet_offsets[facet + 1u] -
                    ctx.mesh.facet_offsets[facet] !=
                3u) {
            error = "FEM/BEM explicit boundary facet is not a TRI3 span";
            return false;
        }
        const size_t begin = ctx.mesh.facet_offsets[facet];
        facets.push_back({
            ctx.mesh.facet_nodes[begin + 0u],
            ctx.mesh.facet_nodes[begin + 1u],
            ctx.mesh.facet_nodes[begin + 2u]});
    }
    return true;
}

bool add_oriented_boundary_face(
    const Context &ctx,
    const std::array<uint32_t, 3> &input_tri,
    uint32_t opposite,
    DemagBoundarySurface &surface,
    std::string &error)
{
    if (!face_references_valid_nodes(ctx, input_tri) ||
        opposite >= ctx.mesh.n_nodes) {
        error = "FEM/BEM demag boundary face references a node outside the mesh";
        return false;
    }
    if (input_tri[0] == input_tri[1] ||
        input_tri[0] == input_tri[2] ||
        input_tri[1] == input_tri[2] ||
        opposite == input_tri[0] ||
        opposite == input_tri[1] ||
        opposite == input_tri[2]) {
        error = "FEM/BEM demag boundary face has duplicate/opposite node";
        return false;
    }

    std::array<uint32_t, 3> tri = input_tri;
    const Vec3 p0 = node_position(ctx, tri[0]);
    const Vec3 p1 = node_position(ctx, tri[1]);
    const Vec3 p2 = node_position(ctx, tri[2]);
    const Vec3 edge0 = sub(p1, p0);
    const Vec3 edge1 = sub(p2, p0);
    Vec3 normal = cross(edge0, edge1);
    const double edge0_norm = stable_norm(edge0);
    const double edge1_norm = stable_norm(edge1);
    const double area2 = stable_norm(normal);
    const double edge_product = edge0_norm * edge1_norm;
    if (!std::isfinite(edge_product) || !(edge_product > 0.0) ||
        !std::isfinite(area2) ||
        !(area2 / edge_product > kRelativeGeometryTolerance)) {
        error = "FEM/BEM demag boundary face has zero or degenerate area";
        return false;
    }

    const Vec3 centroid = {
        p0[0] / 3.0 + p1[0] / 3.0 + p2[0] / 3.0,
        p0[1] / 3.0 + p1[1] / 3.0 + p2[1] / 3.0,
        p0[2] / 3.0 + p1[2] / 3.0 + p2[2] / 3.0};
    const Vec3 interior = node_position(ctx, opposite);
    const double side = dot(normal, sub(interior, centroid));
    if (!finite_vec3(centroid) || !std::isfinite(side) || side == 0.0) {
        error = "FEM/BEM demag boundary face has an indeterminate outward orientation";
        return false;
    }
    if (side > 0.0) {
        std::swap(tri[1], tri[2]);
        normal = scale(normal, -1.0);
    }

    const Vec3 unit_normal = scale(normal, 1.0 / area2);
    const double area = 0.5 * area2;
    if (!finite_vec3(unit_normal) || !std::isfinite(area) || !(area > 0.0)) {
        error = "FEM/BEM demag boundary face produced non-finite geometry";
        return false;
    }
    if (surface.global_to_boundary.size() != ctx.mesh.n_nodes) {
        error = "FEM/BEM demag boundary-node map has an invalid size";
        return false;
    }

    surface.triangles.push_back(tri);
    surface.unit_normals.push_back(unit_normal);
    surface.triangle_areas.push_back(area);
    for (uint32_t node : tri) {
        if (surface.global_to_boundary[static_cast<size_t>(node)] < 0) {
            if (surface.boundary_nodes.size() >
                static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
                error = "FEM/BEM demag boundary-node map exceeds int32 capacity";
                return false;
            }
            surface.global_to_boundary[static_cast<size_t>(node)] =
                static_cast<int32_t>(surface.boundary_nodes.size());
            surface.boundary_nodes.push_back(node);
        }
    }
    return true;
}

bool validate_closed_surface(
    const Context &ctx,
    const DemagBoundarySurface &surface,
    std::string &error)
{
    if (surface.triangles.empty() ||
        surface.triangles.size() != surface.unit_normals.size() ||
        surface.triangles.size() != surface.triangle_areas.size() ||
        surface.global_to_boundary.size() != ctx.mesh.n_nodes) {
        error = "FEM/BEM demag extracted surface buffers are inconsistent";
        return false;
    }

    struct OrientedEdge {
        uint32_t start = 0;
        uint32_t end = 0;
        uint32_t count = 0;
    };
    using EdgeKey = std::pair<uint32_t, uint32_t>;
    std::map<EdgeKey, OrientedEdge> edges;
    std::map<uint32_t, std::map<uint32_t, std::vector<uint32_t>>> vertex_links;

    for (const auto &tri : surface.triangles) {
        if (!face_references_valid_nodes(ctx, tri) ||
            tri[0] == tri[1] || tri[0] == tri[2] || tri[1] == tri[2]) {
            error = "FEM/BEM demag extracted surface contains an invalid triangle";
            return false;
        }
        for (uint32_t node : tri) {
            const int32_t row = surface.global_to_boundary[static_cast<size_t>(node)];
            if (row < 0 ||
                static_cast<size_t>(row) >= surface.boundary_nodes.size() ||
                surface.boundary_nodes[static_cast<size_t>(row)] != node) {
                error = "FEM/BEM demag boundary-node map is not bijective";
                return false;
            }
        }
        for (size_t local = 0; local < 3u; ++local) {
            const uint32_t start = tri[local];
            const uint32_t end = tri[(local + 1u) % 3u];
            const EdgeKey key = {
                std::min(start, end),
                std::max(start, end)};
            auto [it, inserted] = edges.emplace(
                key,
                OrientedEdge{start, end, 1u});
            if (!inserted) {
                if (it->second.count != 1u) {
                    error = "FEM/BEM demag extracted surface has an edge with more than two faces";
                    return false;
                }
                if (it->second.start != end || it->second.end != start) {
                    error = "FEM/BEM demag extracted surface has inconsistent edge orientation";
                    return false;
                }
                it->second.count = 2u;
            }
        }
        vertex_links[tri[0]][tri[1]].push_back(tri[2]);
        vertex_links[tri[0]][tri[2]].push_back(tri[1]);
        vertex_links[tri[1]][tri[0]].push_back(tri[2]);
        vertex_links[tri[1]][tri[2]].push_back(tri[0]);
        vertex_links[tri[2]][tri[0]].push_back(tri[1]);
        vertex_links[tri[2]][tri[1]].push_back(tri[0]);
    }
    for (const auto &entry : edges) {
        if (entry.second.count != 2u) {
            error = "FEM/BEM demag extracted surface is not closed: boundary edge count is not two";
            return false;
        }
    }

    for (auto &[node, link] : vertex_links) {
        for (auto &[neighbor, neighbors] : link) {
            std::sort(neighbors.begin(), neighbors.end());
            neighbors.erase(std::unique(neighbors.begin(), neighbors.end()), neighbors.end());
            if (neighbors.size() != 2u) {
                error = "FEM/BEM demag extracted surface has a non-manifold vertex link";
                return false;
            }
        }
        if (link.empty()) {
            error = "FEM/BEM demag extracted surface has an empty vertex link";
            return false;
        }
        std::vector<uint32_t> stack = {link.begin()->first};
        std::vector<uint32_t> visited;
        while (!stack.empty()) {
            const uint32_t current = stack.back();
            stack.pop_back();
            if (std::find(visited.begin(), visited.end(), current) != visited.end()) {
                continue;
            }
            visited.push_back(current);
            auto link_it = link.find(current);
            if (link_it == link.end()) {
                error = "FEM/BEM demag extracted surface has an incomplete vertex link";
                return false;
            }
            for (uint32_t next : link_it->second) {
                if (std::find(visited.begin(), visited.end(), next) == visited.end()) {
                    stack.push_back(next);
                }
            }
        }
        if (visited.size() != link.size()) {
            error = "FEM/BEM demag extracted surface has a disconnected vertex link";
            return false;
        }
    }
    return true;
}

} // namespace

bool build_demag_boundary_surface(
    const Context &ctx,
    DemagBoundarySurface &surface,
    std::string &error)
{
    surface = {};
    surface.global_to_boundary.assign(static_cast<size_t>(ctx.mesh.n_nodes), -1);

    double characteristic_length = 0.0;
    if (!validate_mesh_contract(ctx, characteristic_length, error)) {
        return false;
    }
    surface.characteristic_length = characteristic_length;

    std::vector<FaceRecord> records;
    if (!build_face_records(ctx, records, error)) {
        return false;
    }
    if (records.empty()) {
        error = "FEM/BEM demag could not extract a magnetic boundary surface";
        return false;
    }

    std::vector<FaceKey> exterior_keys;
    exterior_keys.reserve(records.size());
    for (const FaceRecord &record : records) {
        if (record.count == 1u) {
            exterior_keys.push_back(record.key);
        }
    }
    std::sort(exterior_keys.begin(), exterior_keys.end(), key_less);
    if (exterior_keys.empty()) {
        error = "FEM/BEM demag has no exterior magnetic boundary";
        return false;
    }

    std::vector<std::array<uint32_t, 3>> explicit_facets;
    bool has_explicit_facets = false;
    if (!collect_explicit_facets(
            ctx,
            explicit_facets,
            has_explicit_facets,
            error)) {
        return false;
    }

    if (has_explicit_facets) {
        std::vector<FaceKey> supplied_keys;
        supplied_keys.reserve(explicit_facets.size());
        for (const auto &tri : explicit_facets) {
            if (!face_references_valid_nodes(ctx, tri)) {
                error = "FEM/BEM demag boundary face is not owned by any magnetic tetrahedron";
                return false;
            }
            const FaceRecord *record = find_face_record(records, sorted_key(tri));
            if (record == nullptr) {
                error = "FEM/BEM demag boundary face is not owned by any magnetic tetrahedron";
                return false;
            }
            if (record->count != 1u) {
                error = "FEM/BEM demag boundary face is nonmanifold or belongs to an interior interface";
                return false;
            }
            const FaceKey key = sorted_key(tri);
            if (std::find_if(
                    supplied_keys.begin(),
                    supplied_keys.end(),
                    [&](const FaceKey &existing) { return key_equal(existing, key); }) !=
                supplied_keys.end()) {
                error = "FEM/BEM explicit boundary facets contain a duplicate face";
                return false;
            }
            supplied_keys.push_back(key);
        }
        std::sort(supplied_keys.begin(), supplied_keys.end(), key_less);
        if (supplied_keys.size() != exterior_keys.size()) {
            error = supplied_keys.size() < exterior_keys.size()
                        ? "FEM/BEM explicit boundary facets are incomplete: missing exterior faces"
                        : "FEM/BEM explicit boundary facets contain extra faces";
            return false;
        }
        for (size_t i = 0; i < supplied_keys.size(); ++i) {
            if (!key_equal(supplied_keys[i], exterior_keys[i])) {
                error = "FEM/BEM explicit boundary facets do not match the complete exterior face set";
                return false;
            }
        }
        for (const auto &tri : explicit_facets) {
            const FaceRecord *record = find_face_record(records, sorted_key(tri));
            if (record == nullptr ||
                !add_oriented_boundary_face(ctx, tri, record->opposite, surface, error)) {
                return false;
            }
        }
    } else {
        for (const FaceRecord &record : records) {
            if (record.count == 1u &&
                !add_oriented_boundary_face(ctx, record.tri, record.opposite, surface, error)) {
                return false;
            }
        }
    }

    if (surface.boundary_nodes.empty() || surface.triangles.empty() ||
        !validate_closed_surface(ctx, surface, error)) {
        if (error.empty()) {
            error = "FEM/BEM demag requires a watertight exterior magnetic boundary";
        }
        return false;
    }
    return true;
}

} // namespace fullmag::fem
