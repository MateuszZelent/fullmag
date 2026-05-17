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
 * Ms overrides. It does not add an H_eff field, assemble Zhang-Li/CIP
 * gradients, or apply LLG field-to-RHS conversion.
 */
void add_slonczewski_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz);

} // namespace fullmag::fem
