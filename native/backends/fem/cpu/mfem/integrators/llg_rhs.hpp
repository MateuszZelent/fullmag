#pragma once

#include <cstdint>
#include <vector>

namespace fullmag::fem {

/*
 * Normalize an AOS magnetization field in-place.
 *
 * The buffer is laid out as `[mx0,my0,mz0,mx1,...]`. Zero vectors are left
 * unchanged so callers can preserve nonmagnetic or intentionally empty nodes
 * until the explicit magnetic-node mask is applied.
 */
void normalize_aos_field(std::vector<double> &m_xyz);

/*
 * Compute the reduced-magnetization LLG right-hand side for one AOS state.
 *
 * The effective field `h_xyz` is in A/m and the caller supplies the already
 * configured `gamma_mu0`-style factor used by the native FEM runtime. For each
 * node the implementation evaluates
 *
 *   dm/dt = -gamma/(1+alpha_i^2) [m x H + alpha_i m x (m x H)]
 *
 * with optional per-node damping from `alpha_field`. The function returns the
 * largest RHS vector norm through `max_rhs`.
 */
void llg_rhs_aos(
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_xyz,
    double gamma,
    double alpha,
    const std::vector<double> *alpha_field,
    std::vector<double> &rhs_xyz,
    double &max_rhs);

/*
 * Zero an AOS vector field on nodes marked nonmagnetic.
 *
 * Empty masks are treated as fully magnetic. The helper is shared by Heun/RK
 * staging so direct torques and LLG RHS terms never advance nonmagnetic nodes.
 */
void zero_non_magnetic_nodes_aos(
    std::vector<double> &field_xyz,
    const std::vector<uint8_t> &magnetic_node_mask);

} // namespace fullmag::fem
