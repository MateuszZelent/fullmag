#include "cpu/mfem/integrators/rk_explicit_step.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_stage_rhs.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "gpu_rk.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>

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
bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
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
        error = "native FEM stepper requires at least one effective-field term";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }

    if ((ctx.integrator == FULLMAG_FEM_INTEGRATOR_HEUN && tab.stages == 2) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK4 && tab.stages == 4) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS && tab.stages == 4) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54 && tab.stages == 7)) {
        std::string gpu_rk_reason;
        const auto gpu_rk_plan = gpu_rk_plan_exchange_only(ctx, gpu_rk_reason);
        if (gpu_rk_plan.enabled) {
            if (!gpu_rk_exchange_only_step(ctx, tab, dt_seconds, stats, gpu_rk_reason)) {
                error = gpu_rk_reason;
                return false;
            }
            stats.wall_time_ns = elapsed_ns(wall_start);
            return true;
        }
    }

    ctx.current_dt = dt_seconds;

    const size_t dof_len = ctx.m_xyz.size();
    stepper_workspace_allocate(ctx.stepper, dof_len, tab.stages);
    auto &ws = ctx.stepper;

    const bool adaptive = (tab.order_est > 0) && ctx.adaptive_dt_enabled;
    double dt = dt_seconds;
    uint32_t rejected = 0;
    uint32_t total_rhs = 0;
    bool fsal_used = false;
    bool final_stage_cache_valid = false;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;

    for (;;) {
        ctx.current_dt = dt;
        ws.m_backup = ctx.m_xyz;
        final_stage_cache_valid = false;

        if (tab.fsal && ws.fsal_valid) {
            fsal_used = true;
        } else {
            double exchange_energy_s0 = 0.0;
            double demag_energy_s0 = 0.0;
            if (!evaluate_rk_stage_rhs(
                    ctx,
                    ctx.m_xyz,
                    ws,
                    ws.k[0],
                    nullptr,
                    &exchange_energy_s0,
                    &demag_energy_s0,
                    &timings,
                    error)) {
                if (ctx.step_interrupted) {
                    ctx.m_xyz = ws.m_backup;
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            total_rhs += 1;
        }
        if (poll_interrupt(ctx)) {
            ctx.m_xyz = ws.m_backup;
            ws.fsal_valid = false;
            return true;
        }

        for (int s = 1; s < tab.stages; ++s) {
            for (size_t i = 0; i < dof_len; ++i) {
                double accum = 0.0;
                for (int j = 0; j < s; ++j) {
                    accum += tab.a[s][j] * ws.k[j][i];
                }
                ws.m_stage[i] = ws.m_backup[i] + dt * accum;
            }
            normalize_aos_field(ws.m_stage);
            project_static_periodic_aos(ctx, ws.m_stage);

            double *stage_exchange_energy = nullptr;
            double *stage_demag_energy = nullptr;
            if (tab.fsal && s == tab.stages - 1) {
                stage_exchange_energy = &exchange_energy_final;
                stage_demag_energy = &demag_energy_final;
            }
            if (!evaluate_rk_stage_rhs(ctx, ws.m_stage, ws, ws.k[s],
                                       nullptr,
                                       stage_exchange_energy,
                                       stage_demag_energy,
                                       &timings,
                                       error)) {
                if (ctx.step_interrupted) {
                    ctx.m_xyz = ws.m_backup;
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            if (poll_interrupt(ctx)) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            if (tab.fsal && s == tab.stages - 1) {
                final_stage_cache_valid = true;
            }
            total_rhs += 1;
        }

        for (size_t i = 0; i < dof_len; ++i) {
            double accum = 0.0;
            for (int s = 0; s < tab.stages; ++s) {
                accum += tab.b_hi[s] * ws.k[s][i];
            }
            ctx.m_xyz[i] = ws.m_backup[i] + dt * accum;
        }
        normalize_aos_field(ctx.m_xyz);
        project_static_periodic_aos(ctx, ctx.m_xyz);
        if (poll_interrupt(ctx)) {
            ctx.m_xyz = ws.m_backup;
            ws.fsal_valid = false;
            return true;
        }

        if (adaptive) {
            for (size_t i = 0; i < dof_len; ++i) {
                double err_accum = 0.0;
                for (int s = 0; s < tab.stages; ++s) {
                    err_accum += (tab.b_hi[s] - tab.b_lo[s]) * ws.k[s][i];
                }
                ws.err[i] = dt * err_accum;
            }
            double err_norm = compute_adaptive_error_norm(
                ws.err,
                ws.m_backup,
                ctx.m_xyz,
                ctx.adaptive_atol,
                ctx.adaptive_rtol);
            auto result = adaptive_pi_step(ctx, err_norm);
            if (!result.accepted) {
                ctx.m_xyz = ws.m_backup;
                dt = result.dt_next;
                ctx.dt_seconds = dt;
                ctx.current_dt = dt;
                ws.fsal_valid = false;
                rejected += 1;
                if (rejected > ctx.max_reject) {
                    error = "adaptive RK exceeded adaptive_config.max_reject rejected attempts before accepting a step";
                    return false;
                }
                continue;
            }
            if (poll_interrupt(ctx)) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            stats.error_estimate = err_norm;
            stats.dt_suggested = result.dt_next;
            ctx.dt_seconds = result.dt_next;
        } else {
            stats.error_estimate = 0.0;
            stats.dt_suggested = dt;
        }

        if (tab.fsal) {
            std::swap(ws.k[0], ws.k[tab.stages - 1]);
            ws.fsal_valid = true;
        } else {
            ws.fsal_valid = false;
        }

        break;
    }

    if (final_stage_cache_valid) {
        std::swap(ctx.h_ex_xyz, ws.h_ex_tmp);
        std::swap(ctx.h_demag_xyz, ws.h_demag_tmp);
        std::swap(ctx.h_eff_xyz, ws.h_eff_tmp);
    } else {
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                ws.h_ex_tmp,
                ws.h_demag_tmp,
                ws.h_eff_tmp,
                &exchange_energy_final,
                &demag_energy_final,
                true,
                &timings,
                error)) {
            if (ctx.step_interrupted) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            return false;
        }
        std::swap(ctx.h_ex_xyz, ws.h_ex_tmp);
        std::swap(ctx.h_demag_xyz, ws.h_demag_tmp);
        std::swap(ctx.h_eff_xyz, ws.h_eff_tmp);
    }
    ctx.current_time += dt;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    double max_rhs_final = 0.0;
    if (final_stage_cache_valid) {
        max_rhs_final = max_norm_aos(ws.k[0]);
    } else {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(ctx.m_xyz, ctx.h_eff_xyz,
                    ctx.material.gyromagnetic_ratio, ctx.material.damping,
                    ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
                    ws.k[0], max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, ws.k[0], max_rhs_final);
        zero_non_magnetic_nodes_aos(ws.k[0], ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(ws.k[0]);
        total_rhs += 1;
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.rejected_attempts = rejected;
    stats.rhs_evaluations = total_rhs;
    stats.fsal_reused = fsal_used ? 1 : 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    update_stage_completion_from_stats(ctx, stats);

    return true;
}
#endif

} // namespace fullmag::fem
