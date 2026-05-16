#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add Slonczewski CPP spin-transfer torque directly to the LLG RHS.
 *
 * The contribution is a dm/dt term, not an H_eff field. It uses the configured
 * current-density magnitude, spin-polarization direction, free-layer thickness,
 * polarization degree, Lambda asymmetry, field-like epsilon-prime, current sign,
 * and per-node Ms overrides when available.
 */
void add_slonczewski_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz);

/*
 * Add Zhang-Li CIP spin-transfer torque directly to the LLG RHS.
 *
 * The module estimates the tetrahedral gradient of reduced magnetization,
 * projects the element contribution back to nodes with P1 lumped weights, and
 * applies the configured current-density vector, polarization degree, beta, and
 * per-node Ms overrides.
 */
void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz);

/*
 * Add all enabled executable STT families and refresh max_rhs when the RHS
 * changed.
 */
void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs);

} // namespace fullmag::fem
