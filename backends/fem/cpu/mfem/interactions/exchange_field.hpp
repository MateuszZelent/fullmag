#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute the exchange field for a magnetization state.
 *
 * The returned `h_ex_xyz` is H_ex in A/m and the optional energy is in joules.
 * This module owns component unpack/upload, exchange mass projection calls,
 * nonmagnetic-node zeroing, optional H_eff export, and energy accumulation. It
 * does not apply gamma, damping, or direct-torque scaling.
 */
bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool allow_interrupt,
    std::string &error);

} // namespace fullmag::fem
