#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add Zhang-Li CIP spin-transfer torque directly to the LLG RHS.
 *
 * This module owns the current-in-plane torque contribution in dm/dt units. It
 * estimates one P1 tetrahedral gradient of reduced magnetization per magnetic
 * element, projects the element torque back to nodes with lumped P1 weights,
 * and applies the configured current-density vector, spin-polarization degree,
 * non-adiabatic beta, and Ms overrides. It does not add an H_eff field, assemble
 * Slonczewski/CPP torque, or apply LLG field-to-RHS conversion.
 */
void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz);

} // namespace fullmag::fem
