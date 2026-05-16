#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

/*
 * Return whether the native FEM state has any term that can drive dm/dt.
 *
 * This covers both H_eff field contributors and direct torque contributors.
 * The gate is used by snapshot/step paths to avoid requiring exchange or demag
 * when another extracted interaction, such as Zeeman, DMI, STT, Oersted,
 * magnetoelastic, or thermal noise, is the active physics term.
 */
bool has_any_field_or_direct_torque_term(const Context &ctx);

/*
 * Assemble all enabled native FEM field contributors for a magnetization state.
 *
 * This is the interaction-level composition point for exchange, demag,
 * anisotropy, DMI, Zeeman, Oersted, thermal Brown field, and magnetoelastic
 * field terms. Direct torques remain RHS additions, but this routine owns the
 * H_eff buffer, per-term energy side effects, periodic projection for local
 * fields, optional interrupt polling, and phase timing accumulation.
 */
#if FULLMAG_HAS_MFEM_STACK
bool compute_effective_fields_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> &h_demag_xyz,
    std::vector<double> &h_eff_xyz,
    double *exchange_energy,
    double *demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error);
#endif

} // namespace fullmag::fem
