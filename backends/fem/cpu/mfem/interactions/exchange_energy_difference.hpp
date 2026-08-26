#pragma once

#include "src/relaxation_numerics.hpp"

#include <cstddef>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Exchange energy-difference owner for the CPU/MFEM relaxation path.
 * This module owns the quadratic exchange increment from an already applied
 * symmetric form. It does not own exchange assembly, field projection, GPU
 * exchange buffers, or relaxation transaction lifecycle.
 */

/*
 * Accumulate (trial - base)^T K_A (trial + base) from an already applied
 * symmetric exchange form. The arguments contain one scalar component.
 */
relaxation::EnergyDifference polarized_exchange_difference_from_applied_sum(
    const double *difference,
    const double *applied_sum,
    std::size_t scalar_count);

/*
 * Evaluate the exact quadratic exchange increment for the assembled CPU/MFEM
 * form. Magnetic/nonmagnetic semantics are inherited from that form's domain
 * marker; this owner does not mass-project an exchange field.
 */
relaxation::EnergyDifference exchange_energy_difference(
    Context &ctx,
    const std::vector<double> &base_m_xyz,
    const std::vector<double> &trial_m_xyz,
    bool allow_interrupt,
    std::string &error);

} // namespace fullmag::fem
