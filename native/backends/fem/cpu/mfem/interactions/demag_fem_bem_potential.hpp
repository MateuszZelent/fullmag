#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class Vector;
} // namespace mfem

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
/*
 * Potential-vector helpers for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns small vector transformations around the two scalar
 * potentials: extracting the boundary trace of the Neumann potential u1 for the
 * dense BEM operator, and combining u1 + u2 before field recovery. It does not
 * assemble RHS, build boundary values, solve sparse systems, recover H_demag,
 * compute energy, or orchestrate one update.
 */
bool extract_demag_fem_bem_boundary_trace(
    const std::vector<uint32_t> &boundary_nodes,
    const mfem::Vector &potential,
    std::vector<double> &boundary_trace,
    std::string &error);

bool combine_demag_fem_bem_total_potential(
    const mfem::Vector &u1,
    const mfem::Vector &u2,
    mfem::Vector &total_potential,
    std::string &error);
#endif

} // namespace fullmag::fem
