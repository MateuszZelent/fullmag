/*
 * GPU CUDA projected-gradient BB relaxation step source contract.
 *
 * Owns the native GPU projected-gradient BB relaxation entrypoint and preflight
 * boundary. The accepted-step Armijo loop remains here in the native backend
 * and uses the CUDA kernels in pgbb_kernels.cu. This module does not own
 * CPU/MFEM relaxation algorithms, Rust runner dispatch, effective-field
 * kernels, energy reductions, or public C ABI plumbing.
 */

#include "gpu/cuda/relaxation/pgbb.hpp"
#include "gpu/cuda/relaxation/bb_exchange_mass.hpp"

#include "context.hpp"

#include <cstring>
#include "gpu/cuda/runtime/nvtx_ranges.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/constraints/frozen_spins.cuh"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "gpu/cuda/relaxation/direct_energy_increment.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "src/relaxation_numerics.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#endif

namespace fullmag::fem {

bool gpu_relax_pgbb_field_reuse_key(
    const Context &ctx, FemGpuPgbbFieldKey &key) noexcept
{
    key = {};
#if FULLMAG_HAS_MFEM_STACK
    const auto &gpu = ctx.gpu_state.device;
    // Start with the static SP4 operator family. Other interactions and
    // projections remain fresh until their exact endpoint identity is covered.
    if (!ctx.demag.enabled ||
        ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON ||
        ctx.state.current_time != 0.0 ||
        ctx.stage_completion.relax_torque_confirmation_count != 0 ||
        ctx.thermal_brown.temperature > 0.0 ||
        ctx.oersted.has_stage_callback || ctx.oersted.has_cylinder ||
        ctx.oersted.has_explicit_field || ctx.stage_transport.has_stage_callback ||
        !ctx.zeeman.regional_drives.empty() || ctx.frozen_spins.enabled() ||
        gpu.mesh_regions.has_periodic_reduced_nodes ||
        ctx.anisotropy.uniaxial_enabled || ctx.anisotropy.cubic_enabled ||
        ctx.dmi.interfacial_enabled || ctx.dmi.rotated_interfacial_enabled ||
        ctx.dmi.bulk_enabled || ctx.magnetoelastic.enabled) {
        return false;
    }
    auto number = [](auto value) { return static_cast<uint64_t>(value); };
    auto bits = [](double value) {
        uint64_t result = 0;
        static_assert(sizeof(result) == sizeof(value));
        std::memcpy(&result, &value, sizeof(result));
        return result;
    };
    // Aggregate initialization provides a compile-time bound on the key size.
    key.values = {
        number(gpu.relaxation.state_generation),
        number(ctx.state.step_count),
        number(ctx.relaxation.accepted_steps),
        number(ctx.stage_completion.relax_stop.has_torque_tolerance_apm),
        bits(ctx.stage_completion.relax_stop.torque_tolerance_apm),
        number(ctx.stage_completion.relax_torque_confirmation_count),
        bits(ctx.state.current_time),
        number(ctx.base_plan.precision),
        number(ctx.demag.realization),
        number(ctx.poisson_demag.gpu_demag_mode),
        number(ctx.poisson_demag.boundary_marker),
        number(ctx.poisson_demag.robin_beta_mode),
        bits(ctx.poisson_demag.robin_beta_factor),
        bits(ctx.poisson_demag.robin_effective_beta),
        number(ctx.demag.solver.solver),
        number(ctx.demag.solver.preconditioner),
        bits(ctx.demag.solver.relative_tolerance),
        number(ctx.demag.solver.has_absolute_tolerance),
        bits(ctx.demag.solver.absolute_tolerance),
        number(ctx.demag.solver.max_iterations),
        number(ctx.demag.solver.print_level),
        number(ctx.demag.amg_policy.relax_type),
        number(ctx.demag.amg_policy.coarsening),
        number(ctx.demag.amg_policy.interpolation),
        number(ctx.demag.amg_policy.aggressive_coarsening),
        bits(ctx.demag.amg_policy.strength_threshold),
        number(ctx.demag.amg_policy.strength_threshold_is_set),
        number(ctx.demag.amg_policy.max_levels),
        number(ctx.demag.amg_policy.max_levels_is_set),
        number(ctx.demag.field_refresh.has_demag_interval_s),
        bits(ctx.demag.field_refresh.demag_interval_s),
        bits(ctx.demag.cached_robin_boundary_energy),
        number(ctx.zeeman.has_external_field),
        bits(ctx.zeeman.external_field_am[0]),
        bits(ctx.zeeman.external_field_am[1]),
        bits(ctx.zeeman.external_field_am[2]),
        number(ctx.zeeman.regional_drive_revision),
        bits(ctx.zeeman.stage_start_time_s),
        number(ctx.exchange.enabled),
        number(ctx.exchange.mfem.use_consistent_mass),
        number(ctx.exchange.mfem.ready),
        number(gpu.legacy_exchange.nnz),
        number(gpu.lifecycle.node_count),
        number(gpu.lifecycle.dof_len),
    };
    return true;
#else
    (void)ctx;
    return false;
#endif
}

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

constexpr int kBlockSize = 256;
constexpr double kDefaultStepSize = 1.0e-6;
constexpr double kMinStepSize = 1.0e-15;
constexpr double kMaxStepSize = 1.0e-3;
constexpr double kArmijoCoefficient = 1.0e-4;
constexpr uint32_t kMaxBacktracks = 20;

const uint8_t *gpu_relax_pgbb_node_mask(const Context &ctx)
{
    const auto &regions = ctx.gpu_state.device.mesh_regions;
    return ctx.frozen_spins.enabled()
        ? regions.free_node_mask
        : regions.magnetic_node_mask;
}

void gpu_relax_pgbb_project_frozen_reference(
    Context &ctx,
    FemGpuComponentField &field,
    cudaStream_t stream)
{
    if (!ctx.frozen_spins.enabled()) {
        return;
    }
    const auto &regions = ctx.gpu_state.device.mesh_regions;
    gpu_project_frozen_reference(
        field,
        regions.frozen_mask,
        regions.frozen_reference_x,
        regions.frozen_reference_y,
        regions.frozen_reference_z,
        static_cast<int>(ctx.gpu_state.device.lifecycle.node_count),
        stream);
}

struct GpuRelaxPgbbRollbackState {
    double step_size = kDefaultStepSize;
    bool use_bb1 = true;
    uint64_t reset_consecutive = 0;
    uint64_t accepted_steps = 0;
    uint64_t step_count = 0;
    double current_time = 0.0;
};

GpuRelaxPgbbRollbackState capture_gpu_relax_pgbb_rollback_state(
    const Context &ctx)
{
    return {
        ctx.relaxation.step_size,
        ctx.relaxation.use_bb1,
        ctx.relaxation.reset_consecutive,
        ctx.relaxation.accepted_steps,
        ctx.state.step_count,
        ctx.state.current_time,
    };
}

void restore_gpu_relax_pgbb_metadata(
    Context &ctx,
    const GpuRelaxPgbbRollbackState &rollback)
{
    ctx.relaxation.step_size = rollback.step_size;
    ctx.relaxation.use_bb1 = rollback.use_bb1;
    ctx.relaxation.reset_consecutive = rollback.reset_consecutive;
    ctx.relaxation.accepted_steps = rollback.accepted_steps;
    ctx.state.step_count = rollback.step_count;
    ctx.state.current_time = rollback.current_time;
}

void mark_gpu_relax_pgbb_device_source_of_truth(Context &ctx)
{
    auto &gpu = ctx.gpu_state.device;
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceDirty;
    gpu.residency.host_state = FemGpuSyncState::HostStale;
}

std::string format_gpu_relax_pgbb_scalar(double value)
{
    std::ostringstream out;
    out << std::scientific << std::setprecision(17) << value;
    return out.str();
}

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

bool gpu_relax_pgbb_preflight(
    Context &ctx,
    std::string &reason)
{
    const auto plan = gpu_rk_plan_device_resident(ctx, reason);
    if (!plan.enabled) {
        reason = "GPU projected-gradient BB requires device-resident effective-field pipeline: " +
            reason;
        return false;
    }
    if (plan.exchange_operator_mode == nullptr ||
        std::string(plan.exchange_operator_mode) != "legacy_sparse_gpu") {
        reason = "GPU projected-gradient BB requires legacy_sparse_gpu exchange operator mode";
        return false;
    }
    const auto &gpu = ctx.gpu_state.device;
    if (gpu.lifecycle.node_count == 0 ||
        gpu.lifecycle.dof_len != gpu.lifecycle.node_count * 3ull) {
        reason = "GPU projected-gradient BB requires a non-empty vector FEM state";
        return false;
    }
    if (gpu.lifecycle.node_count >
        static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU projected-gradient BB node count exceeds CUDA kernel launch index range";
        return false;
    }
    if (gpu.mesh_metrics.lumped_mass == nullptr) {
        reason = "GPU projected-gradient BB requires a device FEM lumped-mass metric";
        return false;
    }
    if (gpu.materials.ms == nullptr) {
        reason = "GPU projected-gradient BB requires a device Ms energy metric";
        return false;
    }
    if (gpu.mesh_regions.magnetic_node_mask == nullptr ||
        gpu.mesh_regions.node_count != gpu.lifecycle.node_count) {
        reason = "GPU projected-gradient BB requires a device magnetic-node mask matching the FEM state";
        return false;
    }
    if (ctx.frozen_spins.enabled() &&
        (gpu.mesh_regions.free_node_mask == nullptr ||
         gpu.mesh_regions.free_node_mask_count != gpu.lifecycle.node_count ||
         gpu.mesh_regions.frozen_mask == nullptr ||
         gpu.mesh_regions.frozen_node_count != gpu.lifecycle.node_count ||
         gpu.mesh_regions.frozen_reference_x == nullptr ||
         gpu.mesh_regions.frozen_reference_y == nullptr ||
         gpu.mesh_regions.frozen_reference_z == nullptr)) {
        reason = "GPU projected-gradient BB requires complete device Frozen Spins masks and reference matching the FEM state";
        return false;
    }
    if (gpu.reductions.scalar_workspace == nullptr ||
        gpu.reductions.scalar_result == nullptr ||
        gpu.reductions.temp_storage == nullptr ||
        gpu.reductions.temp_storage_bytes == 0) {
        reason = "GPU projected-gradient BB requires preallocated scalar reduction workspace";
        return false;
    }
    if (gpu.rk.m_backup.x == nullptr ||
        gpu.rk.m_backup.y == nullptr ||
        gpu.rk.m_backup.z == nullptr) {
        reason = "GPU projected-gradient BB requires RK backup scratch for rollback";
        return false;
    }
    if (gpu.rk.k[0].x == nullptr ||
        gpu.rk.k[0].y == nullptr ||
        gpu.rk.k[0].z == nullptr ||
        gpu.rk.m_stage.x == nullptr ||
        gpu.rk.m_stage.y == nullptr ||
        gpu.rk.m_stage.z == nullptr) {
        reason = "GPU projected-gradient BB requires RK scratch fields for gradient and trial magnetization";
        return false;
    }
    if (gpu.rk.k[1].x == nullptr ||
        gpu.rk.k[1].y == nullptr ||
        gpu.rk.k[1].z == nullptr) {
        reason = "GPU projected-gradient BB requires a second RK scratch field for accepted-step BB curvature";
        return false;
    }
    if (gpu.relaxation.projected_gradient_accepted_h_eff.x == nullptr ||
        gpu.relaxation.projected_gradient_accepted_h_eff.y == nullptr ||
        gpu.relaxation.projected_gradient_accepted_h_eff.z == nullptr) {
        reason =
            "GPU projected-gradient BB requires persistent accepted-state H_eff storage";
        return false;
    }
    return true;
}

bool gpu_relax_reduce_scalar_sum(
    Context &ctx,
    cudaStream_t stream,
    const double *block_values,
    int blocks,
    double *result_slot,
    const char *operation,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    fullmag_cuda_device_sum(
        block_values,
        blocks,
        result_slot,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    return cuda_launch_ok(operation, reason);
}

bool gpu_relax_compute_current_metrics(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    FemGpuComponentField &gradient,
    GpuPgbbCurrentMetrics &metrics,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    FemGpuPgbbFieldKey key{};
    const bool eligible = gpu_relax_pgbb_field_reuse_key(ctx, key);
    const bool reused_field = gpu_relax_consume_pgbb_field(
        gpu.relaxation.pgbb_accepted_field, key, eligible);
    if (reused_field) {
        gpu.relaxation.accepted_evaluation_cache_hits_current_step += 1;
    } else {
        gpu.relaxation.accepted_evaluation_cache_misses_current_step += 1;
    }
    if ((!reused_field && !gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            n,
            ctx.state.current_time,
            "launch GPU projected-gradient BB h_eff accumulation",
            reason)) ||
        !gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }
    fullmag_cuda_relax_tangent_gradient_and_norm_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.fields.h_eff.x,
        gpu.fields.h_eff.y,
        gpu.fields.h_eff.z,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_pgbb_node_mask(ctx),
        gradient.x,
        gradient.y,
        gradient.z,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    fullmag_cuda_relax_energy_weighted_dot_blocks(
        gradient.x,
        gradient.y,
        gradient.z,
        gradient.x,
        gradient.y,
        gradient.z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_pgbb_node_mask(ctx),
        gpu.rk.error.x,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU projected-gradient BB tangent-gradient blocks", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result + kGpuPgbbCurrentGradientNormSlot,
            "launch GPU projected-gradient BB volume gradient norm reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.x,
            blocks,
            gpu.reductions.scalar_result +
                kGpuPgbbCurrentProjectedGradientNormSlot,
            "launch GPU projected-gradient BB energy gradient norm reduction",
            reason)) {
        return false;
    }

    // The energy reduction does not own MaxTorque. Refresh the field metrics
    // here so the torque-only completion gate cannot consume the previous
    // accepted step's scalar slot while the current gradient is already fresh.
    if (!gpu_rk_reduce_final_field_metric_terms(
            ctx, stream, n, blocks, reason)) {
        return false;
    }

    constexpr int first_energy_slot =
        static_cast<int>(GpuFinalScalarSlot::ExchangeEnergy);
    constexpr int energy_slot_count =
        static_cast<int>(GpuFinalScalarSlot::MagnetoelasticEnergy) -
        first_energy_slot + 1;
    fullmag_cuda_relax_pgbb_current_metrics_finite_flags(
        gpu.reductions.scalar_result + first_energy_slot,
        energy_slot_count,
        gpu.reductions.scalar_result + kGpuPgbbCurrentGradientNormSlot,
        gpu.reductions.scalar_result + kGpuPgbbCurrentProjectedGradientNormSlot,
        gpu.reductions.scalar_result + kGpuPgbbCurrentFiniteFlagsSlot,
        stream);
    if (!cuda_launch_ok(
            "launch GPU projected-gradient BB current metrics finite flags",
            reason)) {
        return false;
    }

    std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> packed_scalars{};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB packed current snapshot/gradient metrics device->host",
            packed_scalars.data(),
            kGpuPgbbCurrentPackedScalarCount,
            reason)) {
        return false;
    }
    return gpu_unpack_pgbb_current_metrics(ctx, packed_scalars, metrics, reason);
}

bool gpu_relax_restore_previous_magnetization(
    Context &ctx,
    cudaStream_t stream,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    gpu_relax_invalidate_accepted_evaluation(gpu.relaxation);
    if (!gpu_rk_copy_component_device(
            gpu.rk.m_backup,
            gpu.magnetization.m,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB restore previous m",
            reason)) {
        return false;
    }
    mark_gpu_relax_pgbb_device_source_of_truth(ctx);
    return true;
}

int gpu_relax_restore_previous_magnetization_after_failure(
    Context &ctx,
    cudaStream_t stream,
    const char *failure_context,
    const std::string &original_reason,
    std::string &error)
{
    std::string restore_reason;
    if (!gpu_relax_restore_previous_magnetization(ctx, stream, restore_reason)) {
        error =
            "GPU projected-gradient BB failed to restore previous device state after " +
            std::string(failure_context) + ": " + restore_reason +
            "; original error: " + original_reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    error = original_reason + "; previous device state restored";
    return FULLMAG_FEM_ERR_INTERNAL;
}

int gpu_relax_restore_accepted_step_after_finalize_failure(
    Context &ctx,
    cudaStream_t stream,
    const GpuRelaxPgbbRollbackState &rollback,
    const std::string &original_reason,
    std::string &error)
{
    restore_gpu_relax_pgbb_metadata(ctx, rollback);
    return gpu_relax_restore_previous_magnetization_after_failure(
        ctx,
        stream,
        "accepted-step stats finalization failure",
        original_reason,
        error);
}

bool gpu_relax_apply_bb_step_size_from_curvature(
    Context &ctx,
    const double curvature[3],
    std::string &reason)
{
    const double s_dot_s = curvature[0];
    const double s_dot_y = curvature[1];
    const double y_dot_y = curvature[2];
    if (!std::isfinite(s_dot_s) || !std::isfinite(s_dot_y) ||
        !std::isfinite(y_dot_y) || s_dot_s < 0.0 || y_dot_y < 0.0) {
        reason = "GPU projected-gradient BB produced invalid BB curvature scalars";
        return false;
    }

    const relaxation::BbStepDecision decision = relaxation::bb_step_decision(
        s_dot_s,
        s_dot_y,
        y_dot_y,
        3u * ctx.mesh.n_nodes,
        ctx.relaxation.use_bb1,
        ctx.relaxation.reset_consecutive,
        kDefaultStepSize,
        kMinStepSize,
        kMaxStepSize);
    ctx.relaxation.reset_consecutive = decision.reset_consecutive;
    ctx.relaxation.step_size = decision.step_size;
    ctx.relaxation.use_bb1 = !ctx.relaxation.use_bb1;
    return true;
}

bool gpu_relax_compute_accepted_bb_curvature(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    fullmag_cuda_relax_tangent_gradient_and_norm_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.fields.h_eff.x,
        gpu.fields.h_eff.y,
        gpu.fields.h_eff.z,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_pgbb_node_mask(ctx),
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU projected-gradient BB accepted tangent-gradient blocks", reason)) {
        return false;
    }

    fullmag_cuda_relax_bb_curvature_blocks(
        gpu.rk.m_backup.x,
        gpu.rk.m_backup.y,
        gpu.rk.m_backup.z,
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.rk.k[0].x,
        gpu.rk.k[0].y,
        gpu.rk.k[0].z,
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_pgbb_node_mask(ctx),
        gpu.reductions.scalar_workspace,
        gpu.rk.error.x,
        gpu.rk.error.y,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU projected-gradient BB curvature blocks", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            "launch GPU projected-gradient BB s_dot_s reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.x,
            blocks,
            gpu.reductions.scalar_result + 1,
            "launch GPU projected-gradient BB s_dot_y reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.y,
            blocks,
            gpu.reductions.scalar_result + 2,
            "launch GPU projected-gradient BB y_dot_y reduction",
            reason)) {
        return false;
    }

    double scalars[3] = {0.0, 0.0, 0.0};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB accepted curvature scalars device->host",
            scalars,
            3,
            reason)) {
        return false;
    }
    return gpu_relax_apply_bb_step_size_from_curvature(ctx, scalars, reason);
}

} // namespace
#endif

int gpu_relax_projected_gradient_bb_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
    out_stats = {};
#if FULLMAG_HAS_CUDA_RUNTIME
    std::string reason;
    if (!gpu_relax_pgbb_preflight(ctx, reason)) {
        error = reason;
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }

    auto &gpu = ctx.gpu_state.device;
    gpu_relax_reset_step_diagnostics(gpu.relaxation);
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const int n = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;

    gpu_relax_pgbb_project_frozen_reference(
        ctx, gpu.magnetization.m, stream);
    if (!cuda_launch_ok(
            "launch GPU projected-gradient BB entry Frozen Spins restore",
            reason)) {
        error = reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    if (!gpu_rk_copy_component_device(
            gpu.magnetization.m,
            gpu.rk.m_backup,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB backup current m",
            reason)) {
        error = reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    const auto capture_confirmation_controls = [&](bool hot) {
        std::array<uint64_t,6> value{};
        if (hot) {
            const auto &a=ctx.transfer_audit.audit;
            value={a.counters.hot_loop_control_scalar_host_sync_count,a.counters.hot_loop_control_scalar_d2h_bytes,
                a.mandatory_controls_hot_loop.poisson_certificate_readbacks,a.mandatory_controls_hot_loop.poisson_certificate_bytes,
                a.device_pcg_hot_loop.status_readbacks,a.device_pcg_hot_loop.control_d2h_bytes};
        } else {
            const auto &s=ctx.gpu_state.performance_counters;
            const std::lock_guard<std::mutex> lock(s.mutex);
            const auto &p=s.physical_lifetime; const auto &a=s.active;
            value={p.control_fences+a.control_fences,p.control_d2h_bytes+a.control_d2h_bytes,
                p.mandatory_controls.poisson_certificate_readbacks+a.mandatory_controls.poisson_certificate_readbacks,
                p.mandatory_controls.poisson_certificate_bytes+a.mandatory_controls.poisson_certificate_bytes,
                p.device_pcg_status_readbacks+a.device_pcg_status_readbacks,
                p.device_pcg_control_d2h_bytes+a.device_pcg_control_d2h_bytes};
        }
        return value;
    };
    const auto confirmation_physical_before=capture_confirmation_controls(false);
    const auto confirmation_hot_before=capture_confirmation_controls(true);
    GpuPgbbCurrentMetrics current_metrics{};
    const double field_evaluation_time_s = ctx.state.current_time;
    if (!gpu_relax_compute_current_metrics(
            ctx,
            stream,
            n,
            blocks,
            gpu.rk.k[0],
            current_metrics,
            reason)) {
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx,
            stream,
            "current effective-field/energy/gradient evaluation failure",
            reason,
            error);
    }
    const GpuDirectEnergySnapshot &current_snapshot =
        current_metrics.energy_snapshot;
    const double current_energy = current_snapshot.total_energy_j;
    const double current_torque_apm =
        current_snapshot.terms_j[static_cast<size_t>(GpuFinalScalarSlot::MaxTorque)];
    const double gradient_norm_sq = current_metrics.gradient_norm_sq;
    const double energy_gradient_norm_sq =
        current_metrics.projected_gradient_norm_sq;
    if (relaxation_torque_confirmation_pending(ctx, current_torque_apm)) {
        mark_gpu_relax_pgbb_device_source_of_truth(ctx);
        out_stats.step = ctx.state.step_count;
        out_stats.time_seconds = 0.0;
        out_stats.dt_seconds = 0.0;
        if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)) {
            error = reason;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        GpuPerformanceCounterDelta confirmation{};
        fullmag_fem_gpu_mandatory_control_counters_v1 hot_confirmation{};
        if (!resolve_confirmation_control_delta(confirmation_physical_before,capture_confirmation_controls(false),confirmation.mandatory_controls) ||
            !resolve_confirmation_control_delta(confirmation_hot_before,capture_confirmation_controls(true),hot_confirmation)) {
            error="GPU torque confirmation control attribution underflow";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        gpu_performance_note(ctx.gpu_state.performance_counters,confirmation);
        note_hot_loop_mandatory_controls(ctx.transfer_audit.audit,hot_confirmation);
        out_stats.step = ctx.state.step_count;
        out_stats.time_seconds = 0.0;
        out_stats.dt_seconds = 0.0;
        out_stats.max_rhs_amplitude = 0.0;
        return FULLMAG_FEM_OK;
    }
    if (!gpu_rk_copy_component_device(
            gpu.fields.h_demag, gpu.rk.error, gpu.lifecycle.node_count, stream,
            "cudaMemcpyAsync GPU projected-gradient BB backup current H_demag", reason)) {
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx, stream, "current direct-energy snapshot failure", reason, error);
    }
    if (!gpu_rk_copy_component_device(
            gpu.fields.h_eff, gpu.relaxation.projected_gradient_accepted_h_eff,
            gpu.lifecycle.node_count, stream,
            "cudaMemcpyAsync GPU projected-gradient BB backup accepted H_eff", reason)) {
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx, stream, "current accepted H_eff snapshot failure", reason, error);
    }
    if (gradient_norm_sq == 0.0) {
        out_stats.step = ctx.state.step_count;
        out_stats.time_seconds = 0.0;
        out_stats.dt_seconds = 0.0;
        mark_gpu_relax_pgbb_device_source_of_truth(ctx);
        if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)) {
            error = reason;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        out_stats.max_rhs_amplitude = 0.0;
        const bool degenerate_gradient_stagnation =
            relaxation_degenerate_gradient_requires_stagnation(
                ctx,
                current_torque_apm);
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
            degenerate_gradient_stagnation
                ? "numerical_stagnation"
                : "tangent_gradient_norm_sq",
            degenerate_gradient_stagnation
                ? 1.0
                : gradient_norm_sq,
            0.0);
        return FULLMAG_FEM_OK;
    }

    double trial_step = kDefaultStepSize;
    if (std::isfinite(ctx.relaxation.step_size) &&
        ctx.relaxation.step_size > 0.0) {
        trial_step =
            std::clamp(ctx.relaxation.step_size, kMinStepSize, kMaxStepSize);
    }
    double last_trial_energy_j = current_energy;
    // Preserve k[0] as the physical gradient for transported BB curvature
    // and stopping. Only the retraction direction is preconditioned.
    const FemGpuComponentField *trial_gradient = &gpu.rk.k[0];
    const bool precondition = gpu_bb_exchange_mass_enabled(ctx);
    if (precondition) {
#if FULLMAG_HAS_MFEM_STACK
        const auto begin = std::chrono::steady_clock::now();
        if (!gpu_bb_exchange_mass_prepare(ctx, reason) ||
            !gpu_bb_exchange_mass_solve(*gpu.relaxation.bb_exchange_mass,
                gpu.rk.k[0], gpu.relaxation.bb_preconditioned_gradient,
                trial_step, reinterpret_cast<void *>(stream),
                ctx.transfer_audit.audit, reason, &ctx.gpu_state.performance_counters)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "exchange-mass direction solve failure", reason, error);
        }
        auto &z = gpu.relaxation.bb_preconditioned_gradient;
        if (gpu.mesh_regions.has_periodic_reduced_nodes) {
            fullmag_cuda_relax_project_static_periodic_field(z.x, z.y, z.z,
                gpu.mesh_regions.periodic_representative_nodes, n, stream);
        }
        fullmag_cuda_relax_project_tangent_field(
            gpu.rk.m_backup.x, gpu.rk.m_backup.y, gpu.rk.m_backup.z,
            z.x, z.y, z.z, gpu_relax_pgbb_node_mask(ctx), n, stream);
        fullmag_cuda_relax_energy_weighted_dot_blocks(
            z.x, z.y, z.z, gpu.rk.k[0].x, gpu.rk.k[0].y, gpu.rk.k[0].z,
            gpu.materials.ms, gpu.mesh_metrics.lumped_mass,
            gpu_relax_pgbb_node_mask(ctx), gpu.reductions.scalar_workspace, n, stream);
        double direction_dot_gradient = 0.0;
        if (!cuda_launch_ok("project BB preconditioned direction", reason) ||
            !gpu_relax_reduce_scalar_sum(ctx, stream, gpu.reductions.scalar_workspace,
                blocks, gpu.reductions.scalar_result, "reduce BB direction descent", reason) ||
            !gpu_rk_read_control_scalar_results(ctx, stream, "read BB direction descent",
                &direction_dot_gradient, 1, reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "exchange-mass descent check failure", reason, error);
        }
        GpuPerformanceCounterDelta descent_counter{};
        descent_counter.mandatory_controls.bb_descent_readbacks=1;
        descent_counter.mandatory_controls.bb_descent_bytes=sizeof(direction_dot_gradient);
        gpu_performance_note(ctx.gpu_state.performance_counters,descent_counter);
        note_hot_loop_mandatory_controls(ctx.transfer_audit.audit,descent_counter.mandatory_controls);
        if (!std::isfinite(direction_dot_gradient)) {
            reason = "non-finite FEM GPU BB preconditioned descent metric";
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "exchange-mass direction failure", reason, error);
        }
        if (direction_dot_gradient > 0.0) { trial_gradient = &z; }
        // Same safeguard as CPU: a non-descent projected direction restarts
        // with the raw GPU gradient. This never invokes a CPU operator.
        gpu.relaxation.bb_preconditioner_wall_time_ns = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - begin).count());
#else
        reason = "FEM GPU BB exchange-mass requires the MFEM stack";
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx, stream, "exchange-mass unavailable", reason, error);
#endif
    }
    uint32_t backtracks = 0;
    uint32_t logical_rhs_evaluations = 1u;
    uint32_t refinement_rhs_evaluations = 0u;
    bool line_search_accepted = false;
    relaxation::EnergyDifference last_direct_difference{};
    double accepted_armijo_increment_rhs_j = 0.0;
    double last_armijo_increment_rhs_j = 0.0;
    relaxation::ArmijoDifferenceDecision last_armijo_decision =
        relaxation::ArmijoDifferenceDecision::Reject;
    bool last_refinement_attempted = false;
    bool last_refinement_accepted = false;
    double last_local_direct_delta = 0.0;
    double last_endpoint_residual_delta = 0.0;
    double last_endpoint_residual_operand_absolute_sum = 0.0;
    double last_direct_local_component = 0.0;
    double last_direct_exchange_component = 0.0;
    double last_direct_interfacial_dmi_component = 0.0;
    double last_direct_bulk_dmi_component = 0.0;
    bool every_permitted_trial_unchanged = true;
    {
        FULLMAG_NVTX_RANGE("fem.relax.armijo");
        while (true) {
            fullmag_cuda_relax_retract_field(
                gpu.rk.m_backup.x,
                gpu.rk.m_backup.y,
                gpu.rk.m_backup.z,
                trial_gradient->x,
                trial_gradient->y,
                trial_gradient->z,
                gpu_relax_pgbb_node_mask(ctx),
                -trial_step,
                gpu.rk.m_stage.x,
                gpu.rk.m_stage.y,
                gpu.rk.m_stage.z,
                n,
                stream);
            if (gpu.mesh_regions.has_periodic_reduced_nodes) {
                fullmag_cuda_relax_project_static_periodic_field(
                    gpu.rk.m_stage.x,
                    gpu.rk.m_stage.y,
                    gpu.rk.m_stage.z,
                    gpu.mesh_regions.periodic_representative_nodes,
                    n,
                    stream);
            }
            gpu_relax_pgbb_project_frozen_reference(
                ctx, gpu.rk.m_stage, stream);
            if (!cuda_launch_ok("launch GPU projected-gradient BB trial retraction", reason)) {
                return gpu_relax_restore_previous_magnetization_after_failure(
                    ctx,
                    stream,
                    "trial retraction failure",
                    reason,
                    error);
            }
            if (!gpu_direct_minimizer_precompute_representable_chord_increment(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.m_stage,
                    gpu.relaxation.projected_gradient_accepted_h_eff,
                    reason)) {
                return gpu_relax_restore_previous_magnetization_after_failure(
                    ctx,
                    stream,
                    "trial representable-chord reduction failure",
                    reason,
                    error);
            }
            bool armijo = false;
            if (!gpu_rk_copy_component_device(
                    gpu.rk.m_stage,
                    gpu.magnetization.m,
                    gpu.lifecycle.node_count,
                    stream,
                    "cudaMemcpyAsync GPU projected-gradient BB trial m",
                    reason) ||
                !gpu_relax_compute_effective_field_and_energy_terms(
                    ctx,
                    stream,
                    n,
                    blocks,
                    reason)) {
                return gpu_relax_restore_previous_magnetization_after_failure(
                    ctx,
                    stream,
                    "trial effective-field/energy evaluation failure",
                    reason,
                    error);
            }
            logical_rhs_evaluations += 1u;

            GpuDirectArmijoResult armijo_result{};
            if (!gpu_direct_minimizer_armijo_evaluate(
                    ctx, stream, n, blocks, gpu.rk.m_backup, gpu.rk.error,
                    current_snapshot, kArmijoCoefficient, true, armijo_result,
                    reason)) {
                return gpu_relax_restore_previous_magnetization_after_failure(
                    ctx, stream, "trial direct-energy evaluation failure", reason, error);
            }
            last_direct_difference = armijo_result.difference;
            const double armijo_rhs = armijo_result.armijo_rhs_j;
            last_armijo_increment_rhs_j = armijo_rhs;
            last_local_direct_delta = armijo_result.local_delta_j;
            last_endpoint_residual_delta =
                armijo_result.endpoint_residual_delta_j;
            last_endpoint_residual_operand_absolute_sum =
                armijo_result.endpoint_residual_operand_absolute_sum_j;
            last_direct_local_component = armijo_result.local_delta_j;
            last_direct_exchange_component = armijo_result.exchange_delta_j;
            last_direct_interfacial_dmi_component =
                armijo_result.interfacial_dmi_delta_j;
            last_direct_bulk_dmi_component = armijo_result.bulk_dmi_delta_j;
            last_armijo_decision = armijo_result.decision;
            last_refinement_attempted = armijo_result.refinement_attempted;
            last_refinement_accepted = false;
            if (last_refinement_attempted &&
                !gpu_direct_armijo_refine(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.m_stage,
                    gpu.rk.error,
                    armijo_rhs,
                    armijo_result,
                    reason)) {
                return gpu_relax_restore_previous_magnetization_after_failure(
                    ctx, stream, "trial direct-energy refinement failure", reason, error);
            }
            last_refinement_accepted = armijo_result.refinement_accepted;
            refinement_rhs_evaluations +=
                armijo_result.refinement_rhs_evaluations;
            last_trial_energy_j = armijo_result.trial_snapshot.total_energy_j;
            if (!std::isfinite(last_trial_energy_j)) {
                return gpu_relax_restore_previous_magnetization_after_failure(
                    ctx,
                    stream,
                    "trial direct-energy validation failure",
                    "GPU projected-gradient BB produced non-finite total energy",
                    error);
            }
            const bool trial_unchanged =
                armijo_result.trial_active_state_unchanged;
            every_permitted_trial_unchanged =
                every_permitted_trial_unchanged && trial_unchanged;
            armijo = !trial_unchanged &&
                (armijo_result.decision == relaxation::ArmijoDifferenceDecision::Accept ||
                 last_refinement_accepted);
            if (armijo) {
                last_direct_difference = armijo_result.difference;
                accepted_armijo_increment_rhs_j = armijo_rhs;
            }
            if (armijo) {
                line_search_accepted = true;
                break;
            }
            if (backtracks >= kMaxBacktracks) {
                break;
            }
            trial_step *= 0.5;
            backtracks += 1;
        }
    }
    if (!line_search_accepted) {
        if (every_permitted_trial_unchanged) {
            mark_gpu_relax_pgbb_device_source_of_truth(ctx);
            out_stats.step = ctx.state.step_count;
            out_stats.time_seconds = 0.0;
            out_stats.dt_seconds = 0.0;
            out_stats.rejected_attempts = backtracks;
            out_stats.rhs_evaluations = logical_rhs_evaluations;
            if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)) {
                error = reason;
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            out_stats.step = ctx.state.step_count;
            out_stats.time_seconds = 0.0;
            out_stats.dt_seconds = 0.0;
            out_stats.max_rhs_amplitude = 0.0;
            out_stats.rejected_attempts = backtracks;
            out_stats.rhs_evaluations = logical_rhs_evaluations;
            relaxation::publish_representability_stationary_completion(ctx);
            return FULLMAG_FEM_OK;
        }
        const double armijo_rhs =
            current_energy + last_armijo_increment_rhs_j;
        const double torque_tolerance_apm =
            ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0
            ? ctx.stage_completion.relax_stop.torque_tolerance_apm
            : std::numeric_limits<double>::quiet_NaN();
        const std::string original_error =
            "GPU projected-gradient BB failed Armijo line search after " +
            std::to_string(backtracks) +
            " backtracks; current_energy_j=" +
            format_gpu_relax_pgbb_scalar(current_energy) +
            " last_trial_energy_j=" +
            format_gpu_relax_pgbb_scalar(last_trial_energy_j) +
            " armijo_rhs_j=" + format_gpu_relax_pgbb_scalar(armijo_rhs) +
            " direct_delta_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_difference.delta_joules) +
            " direct_local_component_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_local_component) +
            " direct_exchange_component_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_exchange_component) +
            " direct_interfacial_dmi_component_j=" +
            format_gpu_relax_pgbb_scalar(
                last_direct_interfacial_dmi_component) +
            " direct_bulk_dmi_component_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_bulk_dmi_component) +
            " endpoint_residual_delta_j=" +
            format_gpu_relax_pgbb_scalar(
                last_endpoint_residual_delta) +
            " endpoint_residual_operand_absolute_sum_j=" +
            format_gpu_relax_pgbb_scalar(
                last_endpoint_residual_operand_absolute_sum) +
            " direct_roundoff_bound_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_difference.roundoff_bound_joules) +
            " direct_armijo_decision=" +
            std::to_string(static_cast<int>(last_armijo_decision)) +
            " direct_refinement_attempted=" +
            std::to_string(last_refinement_attempted) +
            " direct_refinement_accepted=" +
            std::to_string(last_refinement_accepted) +
            " last_trial_step=" + format_gpu_relax_pgbb_scalar(trial_step) +
            " gradient_norm_sq=" +
            format_gpu_relax_pgbb_scalar(energy_gradient_norm_sq) +
            " current_torque_apm=" +
            format_gpu_relax_pgbb_scalar(current_torque_apm) +
            " torque_tolerance_apm=" +
            format_gpu_relax_pgbb_scalar(torque_tolerance_apm) +
            " torque_confirmation_count=" +
            std::to_string(ctx.stage_completion.relax_torque_confirmation_count) +
            " direct_delta_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_difference.delta_joules) +
            " direct_delta_over_step_j_per_m_per_a=" +
            format_gpu_relax_pgbb_scalar(
                last_direct_difference.delta_joules / trial_step) +
            " predicted_directional_derivative_j_per_m_per_a=" +
            format_gpu_relax_pgbb_scalar(-energy_gradient_norm_sq) +
            " direct_local_delta_j=" +
            format_gpu_relax_pgbb_scalar(last_local_direct_delta) +
            " residual_delta_j=" +
            format_gpu_relax_pgbb_scalar(last_endpoint_residual_delta);
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx,
            stream,
            "exhausted Armijo line search",
            original_error,
            error);
    }

    // Rollback captured *after* the accepted line search (unlike NCG which
    // captures before).  PGBB only needs metadata rollback (step_size, use_bb1,
    // reset_consecutive) if the post-acceptance BB curvature or stats finalization
    // fails — the magnetization is already correct on device from the line search
    // and m_backup still holds the pre-step state for device-level restore.
    const GpuRelaxPgbbRollbackState rollback =
        capture_gpu_relax_pgbb_rollback_state(ctx);
    if (!gpu_relax_compute_accepted_bb_curvature(
            ctx,
            stream,
            n,
            blocks,
            reason)) {
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx,
            stream,
            "accepted-step BB update failure",
            reason,
            error);
    }

    mark_gpu_relax_pgbb_device_source_of_truth(ctx);
    gpu.rk.fsal_valid = false;
    ctx.relaxation.accepted_steps += 1;
    ctx.state.step_count += 1;
    ctx.state.current_time = 0.0;

    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = 0.0;
    out_stats.rejected_attempts = backtracks;
    out_stats.rhs_evaluations =
        logical_rhs_evaluations + refinement_rhs_evaluations;
    if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)) {
        return gpu_relax_restore_accepted_step_after_finalize_failure(
            ctx,
            stream,
            rollback,
            reason,
            error);
    }
    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = 0.0;
    out_stats.max_rhs_amplitude = 0.0;
    out_stats.rejected_attempts = backtracks;
    out_stats.rhs_evaluations =
        logical_rhs_evaluations + refinement_rhs_evaluations;
    const double accepted_energy_delta_upper_j =
        last_direct_difference.delta_joules +
        last_direct_difference.roundoff_bound_joules;
    const double armijo_increment_rhs_j = accepted_armijo_increment_rhs_j;
    if (!std::isfinite(accepted_energy_delta_upper_j) ||
        !std::isfinite(armijo_increment_rhs_j) ||
        !(accepted_energy_delta_upper_j <= armijo_increment_rhs_j &&
          armijo_increment_rhs_j <= 0.0)) {
        return gpu_relax_restore_accepted_step_after_finalize_failure(
            ctx,
            stream,
            rollback,
            "GPU projected-gradient BB accepted Armijo proof is invalid",
            error);
    }
    ctx.relaxation.accepted_energy_proof.available = true;
    ctx.relaxation.accepted_energy_proof.delta_j =
        last_direct_difference.delta_joules;
    ctx.relaxation.accepted_energy_proof.roundoff_bound_j =
        last_direct_difference.roundoff_bound_joules;
    ctx.relaxation.accepted_energy_proof.delta_upper_j =
        accepted_energy_delta_upper_j;
    ctx.relaxation.accepted_energy_proof.armijo_rhs_j = armijo_increment_rhs_j;
    // The direct minimizer already evaluated its device energy, gradient and
    // field reductions. Its finalizer only reads those control scalars, unlike
    // the RK finalizer that both evaluates and records the reductions.
    gpu_rk_note_completed_final_reductions(ctx);
    // Refinement restores the ordinary solver configuration, but leaves fields
    // evaluated at the refined tolerance. Never publish those as ordinary.
    FemGpuPgbbFieldKey accepted_key{};
    const auto &stop = ctx.stage_completion.relax_stop;
    const bool torque_confirmation_due = stop.has_torque_tolerance_apm != 0 &&
        out_stats.max_torque_Apm <= stop.torque_tolerance_apm;
    if (!last_refinement_attempted && !torque_confirmation_due && field_evaluation_time_s == 0.0 &&
        gpu_relax_pgbb_field_reuse_key(ctx, accepted_key)) {
        gpu.relaxation.pgbb_accepted_field.key = accepted_key;
        gpu.relaxation.pgbb_accepted_field.valid = true;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = "GPU projected-gradient BB relaxation requires FULLMAG_HAS_CUDA_RUNTIME=1";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
