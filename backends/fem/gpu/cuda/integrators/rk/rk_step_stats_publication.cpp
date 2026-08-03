/*
 * GPU CUDA RK final step stats publication source contract.
 *
 * This source owns host-side publication of already reduced GPU RK scalar slots
 * into fullmag_fem_step_stats. It does not own CUDA reductions, scalar readback,
 * RK step orchestration, RHS assembly, interaction kernels, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats_publication.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"

#include <cstddef>
#include <limits>

namespace fullmag::fem {

namespace {

uint64_t saturating_add(uint64_t lhs, uint64_t rhs)
{
    return lhs > std::numeric_limits<uint64_t>::max() - rhs
        ? std::numeric_limits<uint64_t>::max()
        : lhs + rhs;
}

} // namespace

void gpu_rk_publish_final_step_stats(
    Context &ctx,
    const std::array<double, kGpuFinalScalarSlots> &scalars,
    fullmag_fem_step_stats &stats)
{
    auto scalar = [&](GpuFinalScalarSlot slot) {
        return scalars[static_cast<size_t>(slot)];
    };

    const double max_rhs = scalar(GpuFinalScalarSlot::MaxRhs);
    const double exchange_energy = scalar(GpuFinalScalarSlot::ExchangeEnergy);
    if (ctx.demag.enabled) {
        ctx.demag.cached_robin_boundary_energy = 0.0;
    }
    const double demag_energy =
        ctx.demag.enabled
            ? scalar(GpuFinalScalarSlot::DemagEnergy)
            : 0.0;
    const double external_energy =
        ctx.zeeman.has_external_field ? scalar(GpuFinalScalarSlot::ExternalEnergy) : 0.0;
    const double drive_energy = !ctx.zeeman.regional_drives.empty()
        ? scalar(GpuFinalScalarSlot::DriveEnergy) : 0.0;
    const double anisotropy_energy =
        ctx.anisotropy.uniaxial_enabled ? scalar(GpuFinalScalarSlot::AnisotropyEnergy) : 0.0;
    const double cubic_anisotropy_energy =
        ctx.anisotropy.cubic_enabled ? scalar(GpuFinalScalarSlot::CubicAnisotropyEnergy) : 0.0;
    const double dmi_energy =
        ctx.dmi.interfacial_enabled ? scalar(GpuFinalScalarSlot::DmiEnergy) : 0.0;
    const double bulk_dmi_energy =
        ctx.dmi.bulk_enabled ? scalar(GpuFinalScalarSlot::BulkDmiEnergy) : 0.0;
    const double magnetoelastic_energy =
        ctx.magnetoelastic.enabled ? scalar(GpuFinalScalarSlot::MagnetoelasticEnergy) : 0.0;
    const double max_h_eff = scalar(GpuFinalScalarSlot::MaxHEff);
    const double max_h_demag =
        ctx.demag.enabled ? scalar(GpuFinalScalarSlot::MaxHDemag) : 0.0;
    const double max_torque = scalar(GpuFinalScalarSlot::MaxTorque);
    const double mx_sum = scalar(GpuFinalScalarSlot::MxSum);
    const double my_sum = scalar(GpuFinalScalarSlot::MySum);
    const double mz_sum = scalar(GpuFinalScalarSlot::MzSum);
    const double moment_weight = scalar(GpuFinalScalarSlot::MomentWeight);

    stats.max_rhs_amplitude = max_rhs;
    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = demag_energy;
    stats.external_energy_joules = external_energy;
    stats.drive_energy_joules = drive_energy;
    stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy;
    stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy;
    stats.magnetoelastic_energy_joules = magnetoelastic_energy;
    stats.total_energy_joules =
        exchange_energy + demag_energy + external_energy + drive_energy + anisotropy_energy + cubic_anisotropy_energy +
        dmi_energy + bulk_dmi_energy + magnetoelastic_energy;
    stats.max_effective_field_amplitude = max_h_eff;
    stats.max_demag_field_amplitude = max_h_demag;
    stats.max_torque_Apm = max_torque;
    if (moment_weight > 0.0) {
        stats.mx = mx_sum / moment_weight;
        stats.my = my_sum / moment_weight;
        stats.mz = mz_sum / moment_weight;
    } else {
        stats.mx = 0.0;
        stats.my = 0.0;
        stats.mz = 0.0;
    }
    if (ctx.demag.enabled) {
        fill_demag_solver_stats(ctx, stats);
#if FULLMAG_HAS_MFEM_STACK
        if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON &&
            ctx.poisson_demag.solves_current_step > 0) {
            DemagPoissonPhaseTimings demag_timings{};
            demag_timings.assemble_wall_time_ns = ctx.poisson_demag.step_assemble_wall_time_ns;
            demag_timings.solve_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns;
            demag_timings.solver_setup_wall_time_ns = ctx.poisson_demag.last_setup_wall_time_ns;
            demag_timings.solver_apply_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns;
            demag_timings.solver_setup_reused = ctx.poisson_demag.last_solver_setup_reused;
            demag_timings.recover_wall_time_ns = ctx.poisson_demag.step_recover_wall_time_ns;
            demag_timings.energy_wall_time_ns = ctx.poisson_demag.step_energy_wall_time_ns;
            demag_timings.wall_time_ns =
                demag_timings.assemble_wall_time_ns +
                demag_timings.solve_wall_time_ns +
                demag_timings.recover_wall_time_ns +
                demag_timings.energy_wall_time_ns;
            fill_demag_poisson_phase_stats(demag_timings, stats);
        }
#endif // FULLMAG_HAS_MFEM_STACK
    } else {
        stats.demag_solve_count = 0;
        stats.demag_linear_iterations = 0;
        stats.demag_linear_residual = 0.0;
    }
    fill_step_profiler_timing_stats(ctx, stats);
    const auto &host_transaction = ctx.stepper.transaction_telemetry;
    const auto &device_transaction = ctx.gpu_state.rk_transaction_telemetry;
    stats.rk_transaction_capture_device_elapsed_time_ns =
        device_transaction.capture_device_elapsed_ns;
    stats.rk_transaction_capture_bytes = saturating_add(
        host_transaction.step_transaction_host_snapshot_payload_bytes,
        device_transaction.capture_bytes);
    stats.rk_transaction_restore_device_elapsed_time_ns =
        device_transaction.restore_device_elapsed_ns;
    stats.rk_transaction_restore_bytes = saturating_add(
        host_transaction.step_transaction_host_restore_payload_bytes,
        device_transaction.restore_bytes);
    stats.requested_omp_threads = ctx.cpu_threads.requested_omp_threads;
    stats.effective_omp_threads = ctx.cpu_threads.effective_omp_threads;
    stats.cpu_thread_cap_reason = ctx.cpu_threads.cap_reason;
    context_update_stage_completion_from_stats(ctx, stats);
}

} // namespace fullmag::fem
