#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

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
};

/*
 * Extract the exterior magnetic boundary surface for body-only FEM/BEM demag.
 *
 * The input mesh is tetrahedral and airbox-free. Interior magnetic faces are
 * discarded; explicit boundary faces are validated against magnetic tets when
 * present. The resulting triangles are oriented with outward normals.
 */
bool build_demag_boundary_surface(
    const Context &ctx,
    DemagBoundarySurface &surface,
    std::string &error);

/*
 * Dense reference BEM operator for the Fredkin-Koehler open-boundary demag path.
 *
 * This operator is intentionally O(Nb^2) and exists as a correctness/reference
 * implementation. Production-scale compressed BEM/H2/FMM operators are separate
 * future implementations behind the same boundary-operator role.
 */
class DenseDemagBemOperator {
public:
    /*
     * Assemble the dense boundary integral matrix for the extracted surface.
     *
     * The current kernel uses linear-triangle Lindholm-style weights and a
     * constant-potential sanity correction on boundary vertices.
     */
    bool build(
        const Context &ctx,
        const DemagBoundarySurface &surface,
        std::string &error);

    /*
     * Apply the dense BEM boundary operator to boundary potential values.
     */
    bool apply(
        const std::vector<double> &u1_boundary,
        std::vector<double> &u2_boundary,
        std::string &error) const;

    const std::vector<double> &matrix_row_major() const { return matrix_; }
    uint32_t size() const { return size_; }
    const char *mode() const { return "dense_reference"; }

private:
    uint32_t size_ = 0;
    std::vector<double> matrix_;
};

/*
 * Compute demag energy for a FEM/BEM recovered field.
 *
 * FEM/BEM and Poisson demag share the same energy convention:
 *
 *   E_d = -0.5 mu0 integral_Omega_m Ms m.H_demag dV.
 */
double demag_fem_bem_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads = 1);

#if FULLMAG_HAS_MFEM_STACK
/*
 * Initialize the initial dense-reference FEM/BEM demag workspace.
 *
 * The path rejects periodic meshes and requires a body-only magnetic tetrahedral
 * mesh with watertight exterior boundary faces.
 */
bool context_initialize_demag_fem_bem(Context &ctx, std::string &error);
void context_destroy_demag_fem_bem(Context &ctx);

/*
 * Compute one Fredkin-Koehler FEM/BEM demag field.
 *
 * The active MFEM path solves the Neumann volume potential u1, applies the dense
 * BEM boundary operator for u2 boundary data, solves the Dirichlet correction,
 * recovers H_demag, and reports energy using the common demag convention.
 */
bool context_compute_demag_fem_bem(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error);
#endif

} // namespace fullmag::fem
