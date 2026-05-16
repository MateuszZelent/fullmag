#include "cpu/mfem/integrators/heun_step.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"

#include <chrono>
#include <utility>
#include <vector>

namespace {

using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start)
{
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

class ScopedPhaseTimer {
public:
    explicit ScopedPhaseTimer(uint64_t *accumulator)
        : accumulator_(accumulator)
    {
        if (accumulator_ != nullptr) {
            start_ = SteadyClock::now();
        }
    }

    ~ScopedPhaseTimer()
    {
        if (accumulator_ != nullptr) {
            *accumulator_ += elapsed_ns(start_);
        }
    }

private:
    uint64_t *accumulator_ = nullptr;
    SteadyClock::time_point start_{};
};

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
bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    if (!has_any_field_or_direct_torque_term(ctx)) {
        error = "native FEM stepper requires at least one effective-field term to be enabled";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }
    ctx.current_dt = dt_seconds;

    std::vector<double> h_ex_now;
    std::vector<double> h_demag_now;
    std::vector<double> h_eff_now;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            h_ex_now,
            h_demag_now,
            h_eff_now,
            &exchange_energy,
            &demag_energy,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }

    std::vector<double> k1;
    double max_rhs_k1 = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            h_eff_now,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            k1,
            max_rhs_k1);
        add_stt_rhs_aos(ctx, ctx.m_xyz, k1, max_rhs_k1);
        zero_non_magnetic_nodes_aos(k1, ctx.magnetic_node_mask);
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> predicted = ctx.m_xyz;
    for (size_t i = 0; i < predicted.size(); ++i) {
        predicted[i] += dt_seconds * k1[i];
    }
    normalize_aos_field(predicted);
    project_static_periodic_aos(ctx, predicted);

    std::vector<double> h_ex_pred;
    std::vector<double> h_demag_pred;
    std::vector<double> h_eff_pred;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            predicted,
            h_ex_pred,
            h_demag_pred,
            h_eff_pred,
            nullptr,
            nullptr,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> k2;
    double max_rhs_k2 = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            predicted,
            h_eff_pred,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            k2,
            max_rhs_k2);
        add_stt_rhs_aos(ctx, predicted, k2, max_rhs_k2);
        zero_non_magnetic_nodes_aos(k2, ctx.magnetic_node_mask);
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> corrected = ctx.m_xyz;
    for (size_t i = 0; i < corrected.size(); ++i) {
        corrected[i] += 0.5 * dt_seconds * (k1[i] + k2[i]);
    }
    normalize_aos_field(corrected);
    project_static_periodic_aos(ctx, corrected);

    std::vector<double> h_ex_final;
    std::vector<double> h_demag_final;
    std::vector<double> h_eff_final;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            corrected,
            h_ex_final,
            h_demag_final,
            h_eff_final,
            &exchange_energy_final,
            &demag_energy_final,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    ctx.m_xyz = std::move(corrected);
    ctx.h_ex_xyz = std::move(h_ex_final);
    ctx.h_demag_xyz = std::move(h_demag_final);
    ctx.h_eff_xyz = std::move(h_eff_final);
    ctx.current_time += dt_seconds;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    std::vector<double> rhs_final;
    double max_rhs_final = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            ctx.h_eff_xyz,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            rhs_final,
            max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, rhs_final, max_rhs_final);
        zero_non_magnetic_nodes_aos(rhs_final, ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(rhs_final);
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt_seconds;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.error_estimate = 0.0;
    stats.rejected_attempts = 0;
    stats.dt_suggested = 0.0;
    stats.rhs_evaluations = 2;
    stats.fsal_reused = 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    update_stage_completion_from_stats(ctx, stats);

    return true;
}
#endif

} // namespace fullmag::fem
