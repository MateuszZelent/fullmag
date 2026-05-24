/*
 * GPU CUDA RK final step stats source contract.
 *
 * This source owns scalar slot access, scalar readback, and publication of
 * device-resident RK step statistics. It does not own final energy/observable
 * reductions, RK step scheduling, RHS assembly, interaction physics kernels,
 * GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <array>
#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

} // namespace

double *gpu_rk_final_scalar_result(FemGpuState &gpu, GpuFinalScalarSlot slot)
{
    return gpu.scalar_reduce_result + static_cast<int>(slot);
}

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        gpu.scalar_reduce_result == nullptr ||
        gpu.scalar_reduce_temp_storage == nullptr) {
        return true;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    std::array<double, kGpuFinalScalarSlots> scalars{};

    const int n = static_cast<int>(gpu.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    if (blocks <= 0) {
        return true;
    }

    if (!gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_observable_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_read_scalar_results(
        ctx,
        stream,
        "cudaMemcpyAsync GPU RK final scalar stats device->host",
        scalars.data(),
        scalars.size(),
        reason)) {
        return false;
    }

    auto scalar = [&](GpuFinalScalarSlot slot) {
        return scalars[static_cast<size_t>(slot)];
    };

    const double max_rhs = scalar(GpuFinalScalarSlot::MaxRhs);
    const double exchange_energy = scalar(GpuFinalScalarSlot::ExchangeEnergy);
    const double demag_robin_boundary_energy =
        ctx.demag.enabled &&
                ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
                ctx.poisson_demag.robin_effective_beta > 0.0
            ? scalar(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)
            : 0.0;
    if (ctx.demag.enabled) {
        ctx.demag.cached_robin_boundary_energy = demag_robin_boundary_energy;
    }
    const double demag_energy =
        ctx.demag.enabled
            ? scalar(GpuFinalScalarSlot::DemagEnergy) + ctx.demag.cached_robin_boundary_energy
            : 0.0;
    const double external_energy =
        ctx.zeeman.has_external_field ? scalar(GpuFinalScalarSlot::ExternalEnergy) : 0.0;
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
    const double magnetic_count = scalar(GpuFinalScalarSlot::MagneticCount);

    stats.max_rhs_amplitude = max_rhs;
    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = demag_energy;
    stats.external_energy_joules = external_energy;
    stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy;
    stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy;
    stats.magnetoelastic_energy_joules = magnetoelastic_energy;
    stats.total_energy_joules =
        exchange_energy + demag_energy + external_energy + anisotropy_energy + cubic_anisotropy_energy +
        dmi_energy + bulk_dmi_energy + magnetoelastic_energy;
    stats.max_effective_field_amplitude = max_h_eff;
    stats.max_demag_field_amplitude = max_h_demag;
    stats.max_torque_Apm = max_torque;
    if (magnetic_count > 0.0) {
        stats.mx = mx_sum / magnetic_count;
        stats.my = my_sum / magnetic_count;
        stats.mz = mz_sum / magnetic_count;
    } else {
        stats.mx = 0.0;
        stats.my = 0.0;
        stats.mz = 0.0;
    }
    if (ctx.demag.enabled) {
        fill_demag_solver_stats(ctx, stats);
        if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON &&
            ctx.poisson_demag.solves_current_step > 0) {
            DemagPoissonPhaseTimings demag_timings{};
            demag_timings.solve_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns;
            demag_timings.solver_setup_wall_time_ns = ctx.poisson_demag.last_setup_wall_time_ns;
            demag_timings.solver_apply_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns;
            demag_timings.solver_setup_reused = ctx.poisson_demag.last_solver_setup_reused;
            fill_demag_poisson_phase_stats(demag_timings, stats);
        }
    } else {
        stats.demag_solve_count = 0;
        stats.demag_linear_iterations = 0;
        stats.demag_linear_residual = 0.0;
    }
    stats.requested_omp_threads = ctx.cpu_threads.requested_omp_threads;
    stats.effective_omp_threads = ctx.cpu_threads.effective_omp_threads;
    context_update_stage_completion_from_stats(ctx, stats);
    return true;
}

} // namespace fullmag::fem
