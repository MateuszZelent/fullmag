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

#include "context.hpp"
#include "gpu/cuda/runtime/nvtx_ranges.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
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
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

constexpr int kBlockSize = 256;
constexpr double kDefaultStepSize = 1.0e-6;
constexpr double kMinStepSize = 1.0e-15;
constexpr double kMaxStepSize = 1.0e-3;
constexpr double kArmijoCoefficient = 1.0e-4;
constexpr uint32_t kMaxBacktracks = 20;

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
    if (!gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            n,
            ctx.state.current_time,
            "launch GPU projected-gradient BB h_eff accumulation",
            reason) ||
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
        gpu.mesh_regions.magnetic_node_mask,
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
        gpu.mesh_regions.magnetic_node_mask,
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
        gpu.mesh_regions.magnetic_node_mask,
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
        gpu.mesh_regions.magnetic_node_mask,
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
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const int n = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;

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

    GpuPgbbCurrentMetrics current_metrics{};
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
    const double gradient_norm_sq = current_metrics.gradient_norm_sq;
    const double energy_gradient_norm_sq =
        current_metrics.projected_gradient_norm_sq;
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
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
            "tangent_gradient_norm_sq",
            gradient_norm_sq,
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
                gpu.rk.k[0].x,
                gpu.rk.k[0].y,
                gpu.rk.k[0].z,
                gpu.mesh_regions.magnetic_node_mask,
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
    update_stage_completion_from_stats(ctx, out_stats);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = "GPU projected-gradient BB relaxation requires FULLMAG_HAS_CUDA_RUNTIME=1";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
