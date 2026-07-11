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

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/integrators/rk/rk_total_energy_reduction.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "src/relaxation_numerics.hpp"

#include <algorithm>
#include <array>
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
constexpr uint32_t kArmijoRecoveryCycles = 1;

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

bool gpu_relax_accept_monotone_line_search_step(
    double current_energy,
    double trial_energy)
{
    return relaxation::strict_monotone_energy_accept(current_energy, trial_energy);
}

bool gpu_relax_accept_monotone_recovery_step(
    double current_energy,
    double trial_energy)
{
    return gpu_relax_accept_monotone_line_search_step(
        current_energy,
        trial_energy);
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

bool gpu_relax_compute_effective_field_and_energy(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    double &total_energy,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            n,
            "launch GPU projected-gradient BB h_eff accumulation",
            reason)) {
        return false;
    }
    if (!gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }
    double scalar = 0.0;
    if (!gpu_rk_reduce_total_energy_scalar(
            ctx,
            stream,
            gpu.reductions.scalar_result,
            reason) ||
        !gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB total energy scalar device->host",
            &scalar,
            1,
            reason)) {
        return false;
    }
    total_energy = scalar;
    if (!std::isfinite(total_energy)) {
        reason = "GPU projected-gradient BB produced non-finite total energy";
        return false;
    }
    return true;
}

bool gpu_relax_compute_effective_field_energy_and_tangent_gradient_norm(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    FemGpuComponentField &gradient,
    double &total_energy,
    double &gradient_norm_sq,
    double &energy_gradient_norm_sq,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            n,
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
        !gpu_rk_reduce_total_energy_scalar(
            ctx,
            stream,
            gpu.reductions.scalar_result,
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result + 1,
            "launch GPU projected-gradient BB volume gradient norm reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.x,
            blocks,
            gpu.reductions.scalar_result + 2,
            "launch GPU projected-gradient BB energy gradient norm reduction",
            reason)) {
        return false;
    }

    double scalars[3] = {0.0, 0.0, 0.0};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB total energy/volume-gradient/energy-gradient scalars device->host",
            scalars,
            3,
            reason)) {
        return false;
    }
    total_energy = scalars[0];
    gradient_norm_sq = scalars[1];
    energy_gradient_norm_sq = scalars[2];
    if (!std::isfinite(total_energy)) {
        reason = "GPU projected-gradient BB produced non-finite total energy";
        return false;
    }
    if (!std::isfinite(gradient_norm_sq) || gradient_norm_sq < 0.0) {
        reason = "GPU projected-gradient BB produced a non-finite or negative tangent-gradient norm";
        return false;
    }
    if (!std::isfinite(energy_gradient_norm_sq) || energy_gradient_norm_sq < 0.0) {
        reason = "GPU projected-gradient BB produced a non-finite or negative J A/m energy-metric tangent-gradient norm";
        return false;
    }
    return true;
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

bool gpu_relax_retry_pgbb_line_search_with_reset(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    double current_energy,
    double gradient_norm_sq,
    double &trial_step,
    double &trial_energy,
    uint32_t &backtracks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    for (uint32_t recovery_cycle = 0;
         recovery_cycle < kArmijoRecoveryCycles;
         ++recovery_cycle) {
        ctx.relaxation.reset_consecutive += 1;
        const double restart_step = std::clamp(
            kDefaultStepSize /
                static_cast<double>(ctx.relaxation.reset_consecutive + 1u),
            kMinStepSize,
            kMaxStepSize);
        trial_step = restart_step;

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
            if (!cuda_launch_ok("launch GPU projected-gradient BB recovery retraction", reason) ||
                !gpu_rk_copy_component_device(
                    gpu.rk.m_stage,
                    gpu.magnetization.m,
                    gpu.lifecycle.node_count,
                    stream,
                    "cudaMemcpyAsync GPU projected-gradient BB recovery m",
                    reason) ||
                !gpu_relax_compute_effective_field_and_energy(
                    ctx,
                    stream,
                    n,
                    blocks,
                    trial_energy,
                    reason)) {
                return false;
            }

            const bool armijo =
                trial_energy <=
                current_energy -
                    kArmijoCoefficient * trial_step * gradient_norm_sq;
            if (armijo) {
                return true;
            }
            if (gpu_relax_accept_monotone_recovery_step(
                    current_energy,
                    trial_energy)) {
                return true;
            }
            if (backtracks >= 2u * kMaxBacktracks) {
                break;
            }
            trial_step *= 0.5;
            backtracks += 1;
        }
    }
    return false;
}

bool gpu_relax_retry_pgbb_line_search_with_raw_gradient_restart(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    double current_energy,
    double volume_gradient_norm_sq,
    double energy_gradient_norm_sq,
    double &trial_step,
    double &trial_energy,
    uint32_t &backtracks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    trial_step = relaxation::initial_step_from_volume_norm_sq(
        volume_gradient_norm_sq,
        kDefaultStepSize,
        kMinStepSize,
        kMaxStepSize);

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
        if (!cuda_launch_ok(
                "launch GPU projected-gradient BB raw-gradient recovery retraction",
                reason) ||
            !gpu_rk_copy_component_device(
                gpu.rk.m_stage,
                gpu.magnetization.m,
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU projected-gradient BB raw-gradient recovery m",
                reason) ||
            !gpu_relax_compute_effective_field_and_energy(
                ctx,
                stream,
                n,
                blocks,
                trial_energy,
                reason)) {
            return false;
        }

        const bool armijo =
            trial_energy <=
            current_energy -
                kArmijoCoefficient * trial_step * energy_gradient_norm_sq;
        if (armijo || gpu_relax_accept_monotone_recovery_step(
                current_energy,
                trial_energy)) {
            return true;
        }
        if (backtracks >= 3u * kMaxBacktracks) {
            break;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }
    return false;
}

bool gpu_relax_pgbb_refined_armijo_accepts(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    const relaxation::EnergyDifference &ordinary_difference,
    double armijo_rhs_joules,
    std::string &reason)
{
    if (!ctx.demag.enabled) {
        return false;
    }
    auto &gpu = ctx.gpu_state.device;
    const fullmag_fem_solver_config ordinary_solver = ctx.demag.solver;
    const double ordinary_rtol = ordinary_solver.relative_tolerance;
    const double refinement_floor = 16.0 * std::numeric_limits<double>::epsilon();
    const double refined_rtol = std::max(refinement_floor, ordinary_rtol * 0.1);
    if (!std::isfinite(ordinary_rtol) || !std::isfinite(refined_rtol) ||
        ordinary_rtol <= refined_rtol) {
        return false;
    }
    ctx.demag.solver.relative_tolerance = refined_rtol;
    const auto restore_solver = [&ctx, &ordinary_solver]() {
        ctx.demag.solver = ordinary_solver;
    };

    double refined_current_energy = 0.0;
    if (!gpu_rk_copy_component_device(
            gpu.rk.m_backup,
            gpu.magnetization.m,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB refinement current m",
            reason) ||
        !gpu_relax_compute_effective_field_and_energy(
            ctx,
            stream,
            n,
            blocks,
            refined_current_energy,
            reason)) {
        restore_solver();
        return false;
    }
    std::array<double, kGpuFinalScalarSlots> refined_current_terms{};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB refinement current energy terms device->host",
            refined_current_terms.data(),
            refined_current_terms.size(),
            reason) ||
        !gpu_rk_copy_component_device(
            gpu.fields.h_demag,
            gpu.rk.error,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB refinement current H_demag",
            reason) ||
        !gpu_rk_copy_component_device(
            gpu.rk.m_stage,
            gpu.magnetization.m,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB refinement trial m",
            reason)) {
        restore_solver();
        return false;
    }
    double refined_trial_energy = 0.0;
    if (!gpu_relax_compute_effective_field_and_energy(
            ctx,
            stream,
            n,
            blocks,
            refined_trial_energy,
            reason)) {
        restore_solver();
        return false;
    }
    std::array<double, kGpuFinalScalarSlots> refined_trial_terms{};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB refinement trial energy terms device->host",
            refined_trial_terms.data(),
            refined_trial_terms.size(),
            reason)) {
        restore_solver();
        return false;
    }
    fullmag_cuda_relax_direct_energy_difference_blocks(
        gpu.rk.m_backup.x, gpu.rk.m_backup.y, gpu.rk.m_backup.z,
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        gpu.rk.error.x, gpu.rk.error.y, gpu.rk.error.z,
        gpu.fields.h_demag.x, gpu.fields.h_demag.y, gpu.fields.h_demag.z,
        gpu.fields.h_ext.x, gpu.fields.h_ext.y, gpu.fields.h_ext.z,
        gpu.materials.ms, gpu.materials.ku, gpu.materials.ku2,
        gpu.materials.anisotropy_axis_x, gpu.materials.anisotropy_axis_y,
        gpu.materials.anisotropy_axis_z, gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        ctx.anisotropy.uniaxial_Ku, ctx.anisotropy.uniaxial_Ku2,
        !ctx.material_fields.Ku_field.empty(), !ctx.material_fields.Ku2_field.empty(),
        gpu.reductions.scalar_workspace,
        gpu.rk.k[1].x, n, stream);
    if (!cuda_launch_ok("launch GPU projected-gradient BB refinement direct energy difference", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx, stream, gpu.reductions.scalar_workspace, blocks,
            gpu.reductions.scalar_result,
            "launch GPU projected-gradient BB refinement direct delta reduction", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx, stream, gpu.rk.k[1].x, blocks,
            gpu.reductions.scalar_result + 1,
            "launch GPU projected-gradient BB refinement direct absolute reduction", reason)) {
        restore_solver();
        return false;
    }
    double direct_scalars[2] = {0.0, 0.0};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU projected-gradient BB refinement direct energy scalars device->host",
            direct_scalars,
            2,
            reason)) {
        restore_solver();
        return false;
    }
    restore_solver();
    const auto slot = [](GpuFinalScalarSlot value) { return static_cast<size_t>(value); };
    const double endpoint_replaced =
        (refined_trial_terms[slot(GpuFinalScalarSlot::DemagEnergy)] -
            refined_current_terms[slot(GpuFinalScalarSlot::DemagEnergy)]) +
        (refined_trial_terms[slot(GpuFinalScalarSlot::ExternalEnergy)] -
            refined_current_terms[slot(GpuFinalScalarSlot::ExternalEnergy)]) +
        (refined_trial_terms[slot(GpuFinalScalarSlot::AnisotropyEnergy)] -
            refined_current_terms[slot(GpuFinalScalarSlot::AnisotropyEnergy)]);
    const double residual =
        (refined_trial_energy - refined_current_energy) - endpoint_replaced;
    relaxation::EnergyDifference refined_difference = {
        residual + direct_scalars[0],
        std::abs(residual) + direct_scalars[1],
        relaxation::reduction_roundoff_bound(static_cast<size_t>(n) * 3u) *
            (std::abs(residual) + direct_scalars[1]),
    };
    return relaxation::strict_armijo_difference_refinement_accepts(
        ordinary_difference,
        refined_difference,
        armijo_rhs_joules);
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

    double current_energy = 0.0;
    double gradient_norm_sq = 0.0;
    double energy_gradient_norm_sq = 0.0;
    if (!gpu_relax_compute_effective_field_energy_and_tangent_gradient_norm(
            ctx,
            stream,
            n,
            blocks,
            gpu.rk.k[0],
            current_energy,
            gradient_norm_sq,
            energy_gradient_norm_sq,
            reason)) {
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx,
            stream,
            "current effective-field/energy/gradient evaluation failure",
            reason,
            error);
    }
    std::array<double, kGpuFinalScalarSlots> current_energy_terms{};
    if (!gpu_rk_read_control_scalar_results(
            ctx, stream,
            "cudaMemcpyAsync GPU projected-gradient BB current energy terms device->host",
            current_energy_terms.data(), current_energy_terms.size(), reason) ||
        !gpu_rk_copy_component_device(
            gpu.fields.h_demag, gpu.rk.error, gpu.lifecycle.node_count, stream,
            "cudaMemcpyAsync GPU projected-gradient BB backup current H_demag", reason)) {
        return gpu_relax_restore_previous_magnetization_after_failure(
            ctx, stream, "current direct-energy snapshot failure", reason, error);
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
    double trial_energy = current_energy;
    uint32_t backtracks = 0;
    bool line_search_accepted = false;
    relaxation::EnergyDifference last_direct_difference{};
    relaxation::ArmijoDifferenceDecision last_armijo_decision =
        relaxation::ArmijoDifferenceDecision::Reject;
    bool last_refinement_attempted = false;
    bool last_refinement_accepted = false;
    double last_local_direct_delta = 0.0;
    double last_residual_delta = 0.0;
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
        if (!cuda_launch_ok("launch GPU projected-gradient BB trial retraction", reason) ||
            !gpu_rk_copy_component_device(
                gpu.rk.m_stage,
                gpu.magnetization.m,
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU projected-gradient BB trial m",
                reason) ||
            !gpu_relax_compute_effective_field_and_energy(
                ctx,
                stream,
                n,
                blocks,
                trial_energy,
                reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx,
                stream,
                "trial effective-field/energy evaluation failure",
                reason,
                error);
        }

        std::array<double, kGpuFinalScalarSlots> trial_energy_terms{};
        if (!gpu_rk_read_control_scalar_results(
                ctx, stream,
                "cudaMemcpyAsync GPU projected-gradient BB trial energy terms device->host",
                trial_energy_terms.data(), trial_energy_terms.size(), reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "trial direct-energy terms readback failure", reason, error);
        }
        fullmag_cuda_relax_direct_energy_difference_blocks(
            gpu.rk.m_backup.x, gpu.rk.m_backup.y, gpu.rk.m_backup.z,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            gpu.rk.error.x, gpu.rk.error.y, gpu.rk.error.z,
            gpu.fields.h_demag.x, gpu.fields.h_demag.y, gpu.fields.h_demag.z,
            gpu.fields.h_ext.x, gpu.fields.h_ext.y, gpu.fields.h_ext.z,
            gpu.materials.ms, gpu.materials.ku, gpu.materials.ku2,
            gpu.materials.anisotropy_axis_x, gpu.materials.anisotropy_axis_y,
            gpu.materials.anisotropy_axis_z, gpu.mesh_metrics.lumped_mass,
            gpu.mesh_regions.magnetic_node_mask,
            ctx.anisotropy.uniaxial_Ku, ctx.anisotropy.uniaxial_Ku2,
            !ctx.material_fields.Ku_field.empty(), !ctx.material_fields.Ku2_field.empty(),
            gpu.reductions.scalar_workspace,
            gpu.rk.k[1].x, n, stream);
        if (!cuda_launch_ok("launch GPU projected-gradient BB direct energy difference", reason) ||
            !gpu_relax_reduce_scalar_sum(ctx, stream, gpu.reductions.scalar_workspace, blocks,
                gpu.reductions.scalar_result, "launch GPU projected-gradient BB direct delta reduction", reason) ||
            !gpu_relax_reduce_scalar_sum(ctx, stream, gpu.rk.k[1].x, blocks,
                gpu.reductions.scalar_result + 1,
                "launch GPU projected-gradient BB direct absolute reduction", reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "trial direct-energy reduction failure", reason, error);
        }
        double direct_scalars[2] = {0.0, 0.0};
        if (!gpu_rk_read_control_scalar_results(ctx, stream,
                "cudaMemcpyAsync GPU projected-gradient BB direct energy scalars device->host",
                direct_scalars, 2, reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "trial direct-energy scalar readback failure", reason, error);
        }
        fullmag_cuda_legacy_sparse_exchange_difference_blocks(
            gpu.legacy_exchange.csr_row_offsets,
            gpu.legacy_exchange.csr_col_indices,
            gpu.legacy_exchange.csr_values,
            gpu.rk.m_backup.x, gpu.rk.m_backup.y, gpu.rk.m_backup.z,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            gpu.reductions.scalar_workspace, n, stream);
        if (!cuda_launch_ok("launch GPU projected-gradient BB exchange difference", reason) ||
            !gpu_relax_reduce_scalar_sum(
                ctx, stream, gpu.reductions.scalar_workspace, blocks,
                gpu.reductions.scalar_result,
                "launch GPU projected-gradient BB exchange delta reduction", reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "trial exchange-difference reduction failure", reason, error);
        }
        double exchange_delta = 0.0;
        if (!gpu_rk_read_control_scalar_results(
                ctx, stream,
                "cudaMemcpyAsync GPU projected-gradient BB exchange delta device->host",
                &exchange_delta, 1, reason)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "trial exchange-difference readback failure", reason, error);
        }
        direct_scalars[0] += exchange_delta;
        direct_scalars[1] += std::abs(exchange_delta);
        const auto add_dmi_difference = [&](bool bulk_mode) -> bool {
            if (!(bulk_mode ? ctx.dmi.bulk_enabled : ctx.dmi.interfacial_enabled)) return true;
            if (!cuda_ok(cudaMemsetAsync(gpu.reductions.scalar_result, 0, sizeof(double), stream),
                    "cudaMemsetAsync GPU projected-gradient BB DMI delta", reason)) return false;
            fullmag_cuda_dmi_energy_difference(
                gpu.mesh_geometry.nodes_xyz, gpu.mesh_geometry.elements,
                gpu.mesh_geometry.magnetic_element_mask,
                gpu.rk.m_backup.x, gpu.rk.m_backup.y, gpu.rk.m_backup.z,
                gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
                bulk_mode ? gpu.materials.dbulk : gpu.materials.dind,
                gpu.reductions.scalar_result,
                bulk_mode ? ctx.dmi.bulk_D : ctx.dmi.interfacial_D,
                ctx.dmi.interface_normal[0], ctx.dmi.interface_normal[1], ctx.dmi.interface_normal[2],
                bulk_mode ? !ctx.material_fields.Dbulk_field.empty() : !ctx.material_fields.Dind_field.empty(),
                bulk_mode, static_cast<int>(ctx.mesh.n_elements), stream);
            if (!cuda_launch_ok("launch GPU projected-gradient BB DMI difference", reason)) return false;
            double dmi_delta = 0.0;
            if (!gpu_rk_read_control_scalar_results(ctx, stream,
                    "cudaMemcpyAsync GPU projected-gradient BB DMI delta device->host",
                    &dmi_delta, 1, reason)) return false;
            direct_scalars[0] += dmi_delta;
            direct_scalars[1] += std::abs(dmi_delta);
            return true;
        };
        if (!add_dmi_difference(false) || !add_dmi_difference(true)) {
            return gpu_relax_restore_previous_magnetization_after_failure(
                ctx, stream, "trial DMI-difference reduction failure", reason, error);
        }
        const auto slot = [](GpuFinalScalarSlot value) { return static_cast<size_t>(value); };
        const double endpoint_replaced =
            (trial_energy_terms[slot(GpuFinalScalarSlot::DemagEnergy)] -
                current_energy_terms[slot(GpuFinalScalarSlot::DemagEnergy)]) +
            (trial_energy_terms[slot(GpuFinalScalarSlot::ExternalEnergy)] -
                current_energy_terms[slot(GpuFinalScalarSlot::ExternalEnergy)]) +
            (trial_energy_terms[slot(GpuFinalScalarSlot::AnisotropyEnergy)] -
                current_energy_terms[slot(GpuFinalScalarSlot::AnisotropyEnergy)]);
        const double residual_delta = 0.0;
        relaxation::EnergyDifference direct_difference = {
            residual_delta + direct_scalars[0],
            std::abs(residual_delta) + direct_scalars[1],
            relaxation::reduction_roundoff_bound(static_cast<size_t>(n) * 3u) *
                (std::abs(residual_delta) + direct_scalars[1]),
        };
        const double armijo_rhs =
            -kArmijoCoefficient * trial_step * energy_gradient_norm_sq;
        const auto armijo_decision = relaxation::strict_armijo_difference_decision(
            direct_difference,
            armijo_rhs);
        last_direct_difference = direct_difference;
        last_local_direct_delta = direct_scalars[0];
        last_residual_delta = residual_delta;
        last_armijo_decision = armijo_decision;
        last_refinement_attempted =
            armijo_decision == relaxation::ArmijoDifferenceDecision::Refine;
        last_refinement_accepted =
            last_refinement_attempted &&
            gpu_relax_pgbb_refined_armijo_accepts(
                ctx,
                stream,
                n,
                blocks,
                direct_difference,
                armijo_rhs,
                reason);
        const bool armijo =
            armijo_decision == relaxation::ArmijoDifferenceDecision::Accept ||
            last_refinement_accepted;
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
    if (!line_search_accepted) {
        const double armijo_rhs =
            current_energy -
                kArmijoCoefficient * trial_step * energy_gradient_norm_sq;
        const std::string original_error =
            "GPU projected-gradient BB failed Armijo line search after " +
            std::to_string(backtracks) +
            " backtracks; current_energy_j=" +
            format_gpu_relax_pgbb_scalar(current_energy) +
            " last_trial_energy_j=" +
            format_gpu_relax_pgbb_scalar(trial_energy) +
            " armijo_rhs_j=" + format_gpu_relax_pgbb_scalar(armijo_rhs) +
            " direct_delta_j=" +
            format_gpu_relax_pgbb_scalar(last_direct_difference.delta_joules) +
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
            format_gpu_relax_pgbb_scalar(last_residual_delta);
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
    out_stats.rhs_evaluations = backtracks + 2u;
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
    out_stats.rhs_evaluations = backtracks + 2u;
    update_stage_completion_from_stats(ctx, out_stats);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = "GPU projected-gradient BB relaxation requires FULLMAG_HAS_CUDA_RUNTIME=1";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
