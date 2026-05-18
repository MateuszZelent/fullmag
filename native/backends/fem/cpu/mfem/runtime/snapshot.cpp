/*
 * Snapshot runtime source contract.
 *
 * This source owns on-demand native FEM snapshot assembly for current
 * magnetization, fields, torques, energy, and stop metrics. It does not own steady-state integration, state I/O primitives, common step metrics, or field-refresh policy.
 */

#include "cpu/mfem/runtime/snapshot.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "fem_common.hpp"

#include <utility>
#include <vector>

namespace {

#if FULLMAG_HAS_MFEM_STACK
void apply_phase_timings(
    fullmag_fem_step_stats &stats,
    const fullmag::fem::PhaseTimings &timings)
{
    stats.exchange_wall_time_ns = timings.exchange_wall_time_ns;
    fullmag::fem::fill_demag_poisson_phase_stats(timings.demag, stats);
    stats.rhs_wall_time_ns = timings.rhs_wall_time_ns;
    stats.extra_energy_wall_time_ns = timings.extra_energy_wall_time_ns;
    stats.snapshot_wall_time_ns = timings.snapshot_wall_time_ns;
}
#endif

} // namespace

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool context_snapshot_stats_mfem(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = FemSteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.poisson_demag.solves_current_step = 0;

    if (!ctx.mfem_context.ready) {
        error = "MFEM snapshot requested before MFEM context initialization";
        return false;
    }
    if (!has_any_field_or_direct_torque_term(ctx)) {
        error = "native FEM snapshot requires at least one effective-field term";
        return false;
    }
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return false;
    }

    std::vector<double> h_ex_current;
    std::vector<double> h_demag_current;
    std::vector<double> h_eff_current;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.state.m_xyz,
            h_ex_current,
            h_demag_current,
            h_eff_current,
            &exchange_energy,
            &demag_energy,
            false,
            &timings,
            error)) {
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    ctx.exchange.h_xyz = std::move(h_ex_current);
    ctx.demag.h_xyz = std::move(h_demag_current);
    ctx.effective_field.h_xyz = std::move(h_eff_current);
    ctx.exchange.mfem.ready = true;

    std::vector<double> rhs_current;
    double max_rhs_current = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.state.m_xyz,
            ctx.effective_field.h_xyz,
            ctx.material_fields.material.gyromagnetic_ratio,
            ctx.material_fields.material.damping,
            ctx.material_fields.alpha_field.empty() ? nullptr : &ctx.material_fields.alpha_field,
            rhs_current,
            max_rhs_current);
        add_stt_rhs_aos(ctx, ctx.state.m_xyz, rhs_current, max_rhs_current);
        zero_non_magnetic_nodes_aos(rhs_current, ctx.mesh.magnetic_node_mask);
        max_rhs_current = max_norm_aos(rhs_current);
    }

    stats.step = ctx.state.step_count;
    stats.time_seconds = ctx.state.current_time;
    stats.dt_seconds = 0.0;
    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = demag_energy;
    fill_common_step_metrics(ctx, stats, max_rhs_current, &timings);
    timings.snapshot_wall_time_ns = elapsed_ns(wall_start);
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = timings.snapshot_wall_time_ns;
    return true;
}
#endif

} // namespace fullmag::fem
