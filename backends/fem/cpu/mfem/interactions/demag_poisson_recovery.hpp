#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class FiniteElementSpace;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Field recovery for native FEM Poisson demag.
 *
 * This module owns the H_demag = -grad(u) reconstruction from the scalar
 * potential, including reusable recovery scratch, element-gradient
 * accumulation, optional OpenMP reduction buffers, full-domain visualization
 * preservation, nonmagnetic-node zeroing, scalar demag energy evaluation, and
 * the Robin boundary energy correction. It does not assemble the RHS, build
 * Poisson operators, solve linear systems, manage cached field reuse, or
 * orchestrate the full demag update.
 */
bool initialize_demag_poisson_recovery_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error);

void destroy_demag_poisson_recovery_workspace(Context &ctx);

bool recover_demag_poisson_field(
    Context &ctx,
    const mfem::Vector &potential,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    const std::vector<double> &m_xyz,
    uint64_t *energy_wall_time_ns,
    std::string &error,
    const mfem::Vector *assembled_rhs = nullptr);
#endif

} // namespace fullmag::fem
