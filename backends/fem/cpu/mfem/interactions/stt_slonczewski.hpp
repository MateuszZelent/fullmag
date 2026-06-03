#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add Slonczewski CPP spin-transfer torque directly to the LLG RHS.
 *
 * This module owns the local current-perpendicular-to-plane torque
 * contribution in dm/dt units. It uses current-density magnitude and sign,
 * spin-polarization direction, free-layer thickness or mesh-derived thickness,
 * polarization degree, Lambda asymmetry, field-like epsilon-prime, and per-node
 * Ms overrides. It does not own Zhang-Li CIP torque, reusable Zhang-Li scratch, aggregate family dispatch, or effective-field composition.
 */
void add_slonczewski_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz);

} // namespace fullmag::fem
