#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

/*
 * Runtime products emitted by top-level effective-field composition.
 *
 * `h_xyz` is the magnetic-domain H_eff buffer used by LLG, observables, step
 * metrics, snapshots, and GPU runtime bootstrap. `h_visual_xyz` is the
 * full-domain visualization buffer when demag recovery provides airbox data.
 */
struct EffectiveFieldRuntimeState {
    std::vector<double> h_xyz;
    std::vector<double> h_visual_xyz;
};

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
 * fields, disabled local-buffer zeroing, optional interrupt polling, and phase
 * timing accumulation.
 *
 * This composition surface does not assemble exchange operators, implement demag solvers, define individual interaction physics, own state I/O, or publish step metrics. Those responsibilities stay with exchange, demag, Zeeman,
 * anisotropy, DMI, Oersted, thermal, magnetoelastic, STT, runtime state I/O,
 * and step-metrics owner modules.
 */
#if FULLMAG_HAS_MFEM_STACK
/*
 * Refresh initial native FEM effective-field buffers when the ABI plan asks for
 * eager startup observables.
 *
 * This plan-time policy belongs with top-level effective-field composition. It
 * skips work when no exchange or demag field can be refreshed and otherwise
 * delegates to the extracted exchange/effective-field runtime refresh wrapper.
 */
bool refresh_initial_effective_field_from_plan(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

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
