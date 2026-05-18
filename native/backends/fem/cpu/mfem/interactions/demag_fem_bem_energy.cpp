/*
 * FEM/BEM demag energy source contract.
 *
 * This source owns the FEM/BEM energy wrapper that delegates to the shared
 * Poisson-demag energy convention. It does not extract surfaces, assemble operators, solve sparse systems, recover fields, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_energy.hpp"

#include "cpu/mfem/interactions/demag_poisson_energy.hpp"

namespace fullmag::fem {

double demag_fem_bem_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    return demag_poisson_energy_from_field(ctx, m_xyz, h_demag_xyz, energy_threads);
}

} // namespace fullmag::fem
