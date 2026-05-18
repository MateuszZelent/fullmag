/*
 * FEM/BEM demag surface source contract.
 *
 * This source owns body-only boundary surface extraction, oriented exterior face
 * discovery, boundary-node maps, normals, and triangle areas. It does not assemble BEM operators, solve sparse systems, transfer boundary values, compute energy, or orchestrate solves.
 */

#include "cpu/mfem/interactions/demag_fem_bem_surface.hpp"

#include "context.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <tuple>

namespace fullmag::fem {
namespace {

constexpr double kAreaEps = 1e-300;

using Vec3 = std::array<double, 3>;

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

Vec3 sub(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vec3 add(const Vec3 &a, const Vec3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

Vec3 scale(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

double dot(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm(const Vec3 &a) {
    return std::sqrt(dot(a, a));
}

Vec3 node_position(const Context &ctx, uint32_t node) {
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.mesh.nodes_xyz[base + 0u],
        ctx.mesh.nodes_xyz[base + 1u],
        ctx.mesh.nodes_xyz[base + 2u],
    };
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

std::array<std::array<uint32_t, 3>, 4> tetra_faces(const uint32_t *tet) {
    return {{
        {tet[1], tet[2], tet[3]},
        {tet[0], tet[3], tet[2]},
        {tet[0], tet[1], tet[3]},
        {tet[0], tet[2], tet[1]},
    }};
}

std::array<uint32_t, 4> tetra_opposites(const uint32_t *tet) {
    return {tet[0], tet[1], tet[2], tet[3]};
}

bool face_references_valid_nodes(
    const Context &ctx,
    const std::array<uint32_t, 3> &face)
{
    return face[0] < ctx.mesh.n_nodes && face[1] < ctx.mesh.n_nodes && face[2] < ctx.mesh.n_nodes;
}

bool build_face_records(const Context &ctx, std::vector<FaceRecord> &records, std::string &error) {
    records.clear();
    records.reserve(static_cast<size_t>(ctx.mesh.n_elements) * 4u);
    for (uint32_t elem = 0; elem < ctx.mesh.n_elements; ++elem) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const size_t base = static_cast<size_t>(elem) * 4u;
        const uint32_t tet[4] = {
            ctx.mesh.elements[base + 0u],
            ctx.mesh.elements[base + 1u],
            ctx.mesh.elements[base + 2u],
            ctx.mesh.elements[base + 3u],
        };
        for (uint32_t node : tet) {
            if (node >= ctx.mesh.n_nodes) {
                error = "FEM/BEM demag boundary extraction found an element node outside the mesh";
                return false;
            }
        }
        const auto faces = tetra_faces(tet);
        const auto opposites = tetra_opposites(tet);
        for (size_t i = 0; i < faces.size(); ++i) {
            records.push_back(FaceRecord{sorted_key(faces[i]), faces[i], opposites[i], 1u});
        }
    }
    std::sort(records.begin(), records.end(), [](const FaceRecord &lhs, const FaceRecord &rhs) {
        return key_less(lhs.key, rhs.key);
    });

    std::vector<FaceRecord> merged;
    merged.reserve(records.size());
    for (const FaceRecord &record : records) {
        if (!merged.empty() && key_equal(merged.back().key, record.key)) {
            merged.back().count += 1u;
            continue;
        }
        merged.push_back(record);
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

bool add_oriented_boundary_face(
    const Context &ctx,
    const std::array<uint32_t, 3> &input_tri,
    uint32_t opposite,
    DemagBoundarySurface &surface,
    std::string &error)
{
    if (!face_references_valid_nodes(ctx, input_tri) || opposite >= ctx.mesh.n_nodes) {
        error = "FEM/BEM demag boundary face references a node outside the mesh";
        return false;
    }

    std::array<uint32_t, 3> tri = input_tri;
    const Vec3 p0 = node_position(ctx, tri[0]);
    const Vec3 p1 = node_position(ctx, tri[1]);
    const Vec3 p2 = node_position(ctx, tri[2]);
    Vec3 normal = cross(sub(p1, p0), sub(p2, p0));
    double area2 = norm(normal);
    if (!(area2 > kAreaEps)) {
        error = "FEM/BEM demag boundary face has zero area";
        return false;
    }

    const Vec3 centroid = scale(add(add(p0, p1), p2), 1.0 / 3.0);
    const Vec3 interior = node_position(ctx, opposite);
    if (dot(normal, sub(interior, centroid)) > 0.0) {
        std::swap(tri[1], tri[2]);
        normal = scale(normal, -1.0);
    }

    area2 = norm(normal);
    surface.triangles.push_back(tri);
    surface.unit_normals.push_back(scale(normal, 1.0 / area2));
    surface.triangle_areas.push_back(0.5 * area2);
    for (uint32_t node : tri) {
        if (surface.global_to_boundary[static_cast<size_t>(node)] < 0) {
            surface.global_to_boundary[static_cast<size_t>(node)] =
                static_cast<int32_t>(surface.boundary_nodes.size());
            surface.boundary_nodes.push_back(node);
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

    if (ctx.mesh.n_nodes == 0 || ctx.mesh.n_elements == 0) {
        error = "FEM/BEM demag requires a non-empty magnetic tetrahedral mesh";
        return false;
    }

    std::vector<FaceRecord> records;
    if (!build_face_records(ctx, records, error)) {
        return false;
    }
    if (records.empty()) {
        error = "FEM/BEM demag could not extract a magnetic boundary surface";
        return false;
    }

    if (!ctx.mesh.boundary_faces.empty()) {
        if (ctx.mesh.boundary_faces.size() % 3u != 0u) {
            error = "FEM/BEM demag boundary face buffer length is not a multiple of 3";
            return false;
        }
        for (size_t i = 0; i < ctx.mesh.boundary_faces.size() / 3u; ++i) {
            const std::array<uint32_t, 3> tri = {
                ctx.mesh.boundary_faces[i * 3u + 0u],
                ctx.mesh.boundary_faces[i * 3u + 1u],
                ctx.mesh.boundary_faces[i * 3u + 2u],
            };
            const FaceRecord *record = find_face_record(records, sorted_key(tri));
            if (record == nullptr) {
                error = "FEM/BEM demag boundary face is not owned by any magnetic tetrahedron";
                return false;
            }
            if (record->count != 1u) {
                error = "FEM/BEM demag boundary face is nonmanifold or belongs to an interior interface";
                return false;
            }
            if (!add_oriented_boundary_face(ctx, tri, record->opposite, surface, error)) {
                return false;
            }
        }
    } else {
        for (const FaceRecord &record : records) {
            if (record.count == 1u) {
                if (!add_oriented_boundary_face(ctx, record.tri, record.opposite, surface, error)) {
                    return false;
                }
            }
        }
    }

    if (surface.boundary_nodes.empty() || surface.triangles.empty()) {
        error = "FEM/BEM demag requires a watertight exterior magnetic boundary";
        return false;
    }
    return true;
}

} // namespace fullmag::fem
