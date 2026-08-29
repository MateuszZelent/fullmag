/*
 * Step-metrics runtime source contract.
 *
 * This source owns common step-stat aggregation, average magnetization,
 * max-field/RHS norms, energy bookkeeping, and demag solver stat publication. It does not execute steps, compose fields, own snapshots, or manage state I/O.
 */

#include "cpu/mfem/runtime/step_metrics.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace fullmag::fem {

namespace {

uint64_t saturating_add_u64(uint64_t lhs, uint64_t rhs)
{
    return lhs > std::numeric_limits<uint64_t>::max() - rhs
        ? std::numeric_limits<uint64_t>::max()
        : lhs + rhs;
}

double max_cross_norm_aos_impl(
    const std::vector<double> &a_xyz,
    const std::vector<double> &b_xyz,
    const std::vector<uint8_t> *magnetic_node_mask,
    const std::vector<uint8_t> *frozen_node_mask)
{
    if (a_xyz.size() % 3u != 0u || b_xyz.size() != a_xyz.size()) {
        return std::numeric_limits<double>::infinity();
    }
    const size_t n = a_xyz.size() / 3u;
    if ((magnetic_node_mask != nullptr &&
         !magnetic_node_mask->empty() && magnetic_node_mask->size() != n) ||
        (frozen_node_mask != nullptr &&
         !frozen_node_mask->empty() && frozen_node_mask->size() != n)) {
        return std::numeric_limits<double>::infinity();
    }

    double max_value = 0.0;
    for (size_t i = 0; i < n; ++i) {
        if (magnetic_node_mask != nullptr &&
            !magnetic_node_mask->empty() && (*magnetic_node_mask)[i] == 0u) {
            continue;
        }
        if (frozen_node_mask != nullptr &&
            !frozen_node_mask->empty() && (*frozen_node_mask)[i] != 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const double cx = a_xyz[base + 1] * b_xyz[base + 2] -
                          a_xyz[base + 2] * b_xyz[base + 1];
        const double cy = a_xyz[base + 2] * b_xyz[base + 0] -
                          a_xyz[base + 0] * b_xyz[base + 2];
        const double cz = a_xyz[base + 0] * b_xyz[base + 1] -
                          a_xyz[base + 1] * b_xyz[base + 0];
        max_value = std::max(max_value, std::sqrt(cx * cx + cy * cy + cz * cz));
    }
    return max_value;
}

} // namespace

std::array<double, 3> average_magnetization_components(const Context &ctx)
{
    const size_t nodes = ctx.state.m_xyz.size() / 3u;
    const auto *material = ctx.material_fields.runtime.has_value()
        ? &ctx.material_fields.runtime.value()
        : nullptr;
    if (material != nullptr && material->has_elementwise_ms()) {
        const auto reduction =
            material->ms_weighted_aos3_average_reduction(ctx.state.m_xyz);
        if (!(std::isfinite(reduction.denominator) && reduction.denominator > 0.0)) {
            return {0.0, 0.0, 0.0};
        }
        const double inv = 1.0 / reduction.denominator;
        return {
            reduction.weighted_component_integrals[0] * inv,
            reduction.weighted_component_integrals[1] * inv,
            reduction.weighted_component_integrals[2] * inv,
        };
    }

    std::array<double, 3> sum{};
    double weight_sum = 0.0;
    const bool mixed_topology = std::any_of(
        ctx.mesh.cell_types.begin(),
        ctx.mesh.cell_types.end(),
        [](uint32_t type) { return type != FULLMAG_FEM_CELL_TET4; });
    if (mixed_topology &&
        ctx.integration_weights.mfem_lumped_mass.size() != nodes) {
        return {0.0, 0.0, 0.0};
    }
    const auto &lumped_volume = !ctx.integration_weights.mfem_lumped_mass.empty()
        ? ctx.integration_weights.mfem_lumped_mass
        : ctx.mesh.node_volumes;
    if (lumped_volume.size() != nodes || std::any_of(
            lumped_volume.begin(), lumped_volume.end(),
            [](double weight) { return !std::isfinite(weight) || weight < 0.0; })) {
        return {0.0, 0.0, 0.0};
    }
    for (size_t node = 0; node < nodes; ++node) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const size_t base = node * 3u;
        const double mx = ctx.state.m_xyz[base + 0u];
        const double my = ctx.state.m_xyz[base + 1u];
        const double mz = ctx.state.m_xyz[base + 2u];
        const double volume = node < lumped_volume.size() ? lumped_volume[node] : 0.0;
        const double ms = ctx.material_fields.Ms_field.empty()
            ? ctx.material_fields.material.saturation_magnetisation
            : ctx.material_fields.Ms_field[node];
        const double weight = ms * volume;
        if (!std::isfinite(weight) || weight <= 0.0) {
            continue;
        }
        sum[0] += weight * mx;
        sum[1] += weight * my;
        sum[2] += weight * mz;
        weight_sum += weight;
    }
    if (!(weight_sum > 0.0)) {
        return {0.0, 0.0, 0.0};
    }
    const double inv = 1.0 / weight_sum;
    return {sum[0] * inv, sum[1] * inv, sum[2] * inv};
}

double max_norm_aos(const std::vector<double> &field_xyz)
{
    double max_value = 0.0;
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        max_value = std::max(
            max_value,
            vector_norm3(field_xyz[base + 0], field_xyz[base + 1], field_xyz[base + 2]));
    }
    return max_value;
}

double max_cross_norm_aos(
    const std::vector<double> &a_xyz,
    const std::vector<double> &b_xyz)
{
    return max_cross_norm_aos_impl(a_xyz, b_xyz, nullptr, nullptr);
}

double max_cross_norm_aos_free(
    const std::vector<double> &a_xyz,
    const std::vector<double> &b_xyz,
    const std::vector<uint8_t> &magnetic_node_mask,
    const std::vector<uint8_t> &frozen_node_mask)
{
    return max_cross_norm_aos_impl(
        a_xyz, b_xyz, &magnetic_node_mask, &frozen_node_mask);
}

void fill_demag_solver_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats)
{
    fill_demag_poisson_solver_stats(ctx, stats);
#if FULLMAG_HAS_MFEM_STACK
    stats.requested_omp_threads = ctx.cpu_threads.requested_omp_threads;
    stats.effective_omp_threads = ctx.cpu_threads.effective_omp_threads;
    stats.cpu_thread_cap_reason = ctx.cpu_threads.cap_reason;
#else
    (void)ctx;
#endif
}

void fill_step_profiler_timing_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats)
{
    const auto &transaction = ctx.stepper.transaction_telemetry;
    stats.rk_transaction_capture_host_wall_time_ns =
        transaction.step_transaction_host_capture_wall_time_ns;
    const auto &device_transaction = ctx.gpu_state.rk_transaction_telemetry;
    stats.rk_transaction_capture_device_elapsed_time_ns =
        device_transaction.capture_device_elapsed_ns;
    stats.rk_transaction_capture_bytes = saturating_add_u64(
        transaction.step_transaction_host_snapshot_payload_bytes,
        saturating_add_u64(
            transaction.step_transaction_device_snapshot_payload_bytes,
            device_transaction.capture_bytes));
    stats.rk_transaction_restore_host_wall_time_ns =
        transaction.step_transaction_host_restore_wall_time_ns;
    stats.rk_transaction_restore_device_elapsed_time_ns =
        device_transaction.restore_device_elapsed_ns;
    stats.rk_transaction_restore_bytes = saturating_add_u64(
        transaction.step_transaction_host_restore_payload_bytes,
        saturating_add_u64(
            transaction.step_transaction_device_restore_payload_bytes,
            device_transaction.restore_bytes));
    stats.rk_transaction_rollback_count =
        transaction.step_transaction_rollback_count;
    stats.rk_transaction_commit_count =
        transaction.step_transaction_commit_count;
    stats.rk_transaction_cpu_snapshot_allocation_count =
        transaction.step_transaction_cpu_snapshot_allocation_count;
    stats.rk_transaction_peak_rss_bytes =
        transaction.step_transaction_peak_rss_bytes;

#if FULLMAG_HAS_MFEM_STACK
    const auto &poisson = ctx.poisson_demag;
    stats.demag_hypre_wait_in_enqueue_wall_time_ns =
        poisson.step_hypre_wait_in_enqueue_wall_time_ns;
    stats.demag_hypre_host_api_wall_time_ns =
        poisson.step_hypre_host_api_wall_time_ns;
    stats.demag_hypre_device_elapsed_time_ns =
        poisson.step_solver_apply_device_wall_time_ns;
    stats.demag_hypre_wait_out_enqueue_wall_time_ns =
        poisson.step_hypre_wait_out_enqueue_wall_time_ns;
    stats.demag_hypre_event_wait_count =
        poisson.step_hypre_event_wait_count;
    stats.demag_hypre_timed_solve_count =
        poisson.step_hypre_timed_solve_count;
#else
    stats.demag_hypre_wait_in_enqueue_wall_time_ns = 0;
    stats.demag_hypre_host_api_wall_time_ns = 0;
    stats.demag_hypre_device_elapsed_time_ns = 0;
    stats.demag_hypre_wait_out_enqueue_wall_time_ns = 0;
    stats.demag_hypre_event_wait_count = 0;
    stats.demag_hypre_timed_solve_count = 0;
#endif
}

void fill_common_step_metrics(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    double max_rhs,
    PhaseTimings *timings)
{
#if FULLMAG_HAS_MFEM_STACK
    ScopedPhaseTimer timer(timings != nullptr ? &timings->extra_energy_wall_time_ns : nullptr);
#else
    (void)timings;
#endif

    stats.external_energy_joules = zeeman_energy_from_field(ctx, ctx.state.m_xyz);
    materialize_regional_field_drive(ctx, ctx.state.current_time);
    stats.drive_energy_joules = regional_field_drive_energy(ctx, ctx.state.m_xyz);
    stats.anisotropy_energy_joules = ctx.anisotropy.energy_joules;
    stats.dmi_energy_joules = ctx.dmi.energy_joules;
    stats.magnetoelastic_energy_joules = ctx.magnetoelastic.energy_joules;

    stats.total_energy_joules =
        stats.exchange_energy_joules + stats.demag_energy_joules +
        stats.external_energy_joules + stats.drive_energy_joules + stats.anisotropy_energy_joules +
        stats.dmi_energy_joules + stats.magnetoelastic_energy_joules;
    stats.max_effective_field_amplitude = max_norm_aos(ctx.effective_field.h_xyz);
    stats.max_demag_field_amplitude = max_norm_aos(ctx.demag.h_xyz);
    stats.max_rhs_amplitude = max_rhs;
    static const std::vector<uint8_t> no_frozen_nodes;
    const auto &frozen_nodes = ctx.frozen_spins.enabled()
        ? ctx.frozen_spins.mask()
        : no_frozen_nodes;
    stats.max_torque_Apm = max_cross_norm_aos_free(
        ctx.state.m_xyz,
        ctx.effective_field.h_xyz,
        ctx.mesh.magnetic_node_mask,
        frozen_nodes);
    const auto average = average_magnetization_components(ctx);
    stats.mx = average[0];
    stats.my = average[1];
    stats.mz = average[2];
    fill_demag_solver_stats(ctx, stats);
    fill_step_profiler_timing_stats(ctx, stats);
}

} // namespace fullmag::fem
