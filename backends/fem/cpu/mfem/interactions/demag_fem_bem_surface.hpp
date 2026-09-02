#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Boundary-only surface extracted from the magnetic body mesh for FEM/BEM demag.
 *
 * `boundary_nodes` maps dense BEM rows back to global mesh nodes.
 * `global_to_boundary` maps global nodes to boundary rows or -1 for interior
 * nodes. Triangles, outward unit normals, and triangle areas define the
 * exterior magnetic boundary used by the dense reference BEM operator.
 */
struct DemagBoundarySurface {
    std::vector<uint32_t> boundary_nodes;
    std::vector<int32_t> global_to_boundary;
    std::vector<std::array<uint32_t, 3>> triangles;
    std::vector<std::array<double, 3>> unit_normals;
    std::vector<double> triangle_areas;
    // Characteristic active-mesh length used by scale-aware geometry checks.
    double characteristic_length = 0.0;
};

/*
 * Extract the exterior magnetic boundary surface for body-only FEM/BEM demag.
 *
 * The input mesh is tetrahedral and airbox-free. Interior magnetic faces are
 * discarded; explicit boundary faces are validated against magnetic tets when
 * present. The resulting triangles are oriented with outward normals. This
 * module owns topology validation and outward-normal construction only; dense
 * BEM matrix assembly and Fredkin-Koehler solve orchestration live elsewhere.
 * It does not assemble BEM operators, solve sparse systems, transfer boundary values, compute energy, or orchestrate solves.
 */
bool build_demag_boundary_surface(
    const Context &ctx,
    DemagBoundarySurface &surface,
    std::string &error);

} // namespace fullmag::fem
