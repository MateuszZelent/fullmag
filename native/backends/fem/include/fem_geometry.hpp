#pragma once

/*
 * Shared FEM geometry helpers.
 *
 * Inline Vec3 utilities used by FEM/BEM surface extraction and dense BEM
 * operator assembly.  Avoids duplicating these in anonymous namespaces.
 */

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace fullmag::fem {

struct Context;

using Vec3 = std::array<double, 3>;

inline Vec3 vec3_sub(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

inline Vec3 vec3_add(const Vec3 &a, const Vec3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

inline Vec3 vec3_scale(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

inline double vec3_dot(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline Vec3 vec3_cross(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

inline double vec3_norm(const Vec3 &a) {
    return std::sqrt(vec3_dot(a, a));
}

inline Vec3 mesh_node_position(const std::vector<double> &nodes_xyz, uint32_t node) {
    const size_t base = static_cast<size_t>(node) * 3u;
    return {nodes_xyz[base + 0u], nodes_xyz[base + 1u], nodes_xyz[base + 2u]};
}

} // namespace fullmag::fem
