/*
 * GPU CUDA nonlinear-CG relaxation step source contract.
 *
 * Owns the native GPU Polak-Ribiere+ relaxation entrypoint, persistent search
 * direction handling, Armijo line search, and rollback for FEM CUDA
 * minimization. Routing remains disabled until this lane has live CUDA proof.
 */

#include "gpu/cuda/relaxation/nonlinear_cg.hpp"

#include "context.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
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
constexpr double kGradientFloor = 1.0e-30;
constexpr uint32_t kMaxBacktracks = 30;
constexpr uint64_t kRestartInterval = 50;

struct GpuRelaxNcgRollbackState {
    double step_size = kDefaultStepSize;
    bool direction_valid = false;
    uint64_t accepted_steps = 0;
    uint64_t step_count = 0;
    double current_time = 0.0;
};

GpuRelaxNcgRollbackState capture_gpu_relax_ncg_rollback_state(
    const Context &ctx)
{
    return {
        ctx.relaxation.step_size,
        ctx.gpu_state.device.relaxation.nonlinear_cg_direction_valid,
        ctx.relaxation.accepted_steps,
        ctx.state.step_count,
        ctx.state.current_time,
    };
}

void restore_gpu_relax_ncg_metadata(
    Context &ctx,
    const GpuRelaxNcgRollbackState &rollback)
{
    ctx.relaxation.step_size = rollback.step_size;
    ctx.gpu_state.device.relaxation.nonlinear_cg_direction_valid =
        rollback.direction_valid;
    ctx.relaxation.accepted_steps = rollback.accepted_steps;
    ctx.state.step_count = rollback.step_count;
    ctx.state.current_time = rollback.current_time;
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

bool gpu_relax_ncg_preflight(
    Context &ctx,
    std::string &reason)
{
    const auto plan = gpu_rk_plan_device_resident(ctx, reason);
    if (!plan.enabled) {
        reason = "GPU nonlinear-CG requires device-resident effective-field pipeline: " +
            reason;
        return false;
    }
    if (plan.exchange_operator_mode == nullptr ||
        std::string(plan.exchange_operator_mode) != "legacy_sparse_gpu") {
        reason = "GPU nonlinear-CG requires legacy_sparse_gpu exchange operator mode";
        return false;
    }
    const auto &gpu = ctx.gpu_state.device;
    if (gpu.lifecycle.node_count == 0 ||
        gpu.lifecycle.dof_len != gpu.lifecycle.node_count * 3ull) {
        reason = "GPU nonlinear-CG requires a non-empty vector FEM state";
        return false;
    }
    if (gpu.lifecycle.node_count >
        static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU nonlinear-CG node count exceeds CUDA kernel launch index range";
        return false;
    }
    if (gpu.mesh_metrics.lumped_mass == nullptr) {
        reason = "GPU nonlinear-CG requires a device FEM lumped-mass metric";
        return false;
    }
    if (gpu.mesh_regions.magnetic_node_mask == nullptr ||
        gpu.mesh_regions.node_count != gpu.lifecycle.node_count) {
        reason = "GPU nonlinear-CG requires a device magnetic-node mask matching the FEM state";
        return false;
    }
    if (gpu.reductions.scalar_workspace == nullptr ||
        gpu.reductions.scalar_result == nullptr ||
        gpu.reductions.temp_storage == nullptr ||
        gpu.reductions.temp_storage_bytes == 0) {
        reason = "GPU nonlinear-CG requires preallocated scalar reduction workspace";
        return false;
    }
    if (gpu.rk.m_backup.x == nullptr ||
        gpu.rk.m_backup.y == nullptr ||
        gpu.rk.m_backup.z == nullptr) {
        reason = "GPU nonlinear-CG requires RK backup scratch for rollback";
        return false;
    }
    if (gpu.rk.k[0].x == nullptr ||
        gpu.rk.k[0].y == nullptr ||
        gpu.rk.k[0].z == nullptr ||
        gpu.rk.k[1].x == nullptr ||
        gpu.rk.k[1].y == nullptr ||
        gpu.rk.k[1].z == nullptr ||
        gpu.rk.m_stage.x == nullptr ||
        gpu.rk.m_stage.y == nullptr ||
        gpu.rk.m_stage.z == nullptr) {
        reason = "GPU nonlinear-CG requires RK scratch fields for gradients and trial magnetization";
        return false;
    }
    if (gpu.relaxation.node_count != gpu.lifecycle.node_count ||
        gpu.relaxation.nonlinear_cg_direction.x == nullptr ||
        gpu.relaxation.nonlinear_cg_direction.y == nullptr ||
        gpu.relaxation.nonlinear_cg_direction.z == nullptr ||
        gpu.relaxation.nonlinear_cg_direction_backup.x == nullptr ||
        gpu.relaxation.nonlinear_cg_direction_backup.y == nullptr ||
        gpu.relaxation.nonlinear_cg_direction_backup.z == nullptr) {
        reason = "GPU nonlinear-CG requires persistent device search-direction state";
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
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.magnetization.m,
            gpu.rk.error,
            stream,
            n,
            "launch GPU nonlinear-CG h_eff accumulation",
            reason)) {
        return false;
    }
    if (!gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    std::array<double, kGpuFinalScalarSlots> scalars{};
    if (!gpu_rk_read_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG energy scalars device->host",
            scalars.data(),
            scalars.size(),
            reason)) {
        return false;
    }
    auto scalar = [&](GpuFinalScalarSlot slot) {
        return scalars[static_cast<size_t>(slot)];
    };

    const double exchange_energy = scalar(GpuFinalScalarSlot::ExchangeEnergy);
    double demag_energy = 0.0;
    if (ctx.demag.enabled) {
        demag_energy = scalar(GpuFinalScalarSlot::DemagEnergy);
#if FULLMAG_HAS_MFEM_STACK
        if (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
            ctx.poisson_demag.robin_effective_beta > 0.0) {
            demag_energy += scalar(GpuFinalScalarSlot::DemagRobinBoundaryEnergy);
        }
#endif
    }
    const double external_energy =
        ctx.zeeman.has_external_field ? scalar(GpuFinalScalarSlot::ExternalEnergy) : 0.0;
    const double anisotropy_energy =
        ctx.anisotropy.uniaxial_enabled ? scalar(GpuFinalScalarSlot::AnisotropyEnergy) : 0.0;
    const double cubic_energy =
        ctx.anisotropy.cubic_enabled ? scalar(GpuFinalScalarSlot::CubicAnisotropyEnergy) : 0.0;
    const double dmi_energy =
        ctx.dmi.interfacial_enabled ? scalar(GpuFinalScalarSlot::DmiEnergy) : 0.0;
    const double bulk_dmi_energy =
        ctx.dmi.bulk_enabled ? scalar(GpuFinalScalarSlot::BulkDmiEnergy) : 0.0;
    const double magnetoelastic_energy =
        ctx.magnetoelastic.enabled ? scalar(GpuFinalScalarSlot::MagnetoelasticEnergy) : 0.0;
    total_energy =
        exchange_energy + demag_energy + external_energy + anisotropy_energy +
        cubic_energy + dmi_energy + bulk_dmi_energy + magnetoelastic_energy;
    if (!std::isfinite(total_energy)) {
        reason = "GPU nonlinear-CG produced non-finite total energy";
        return false;
    }
    return true;
}

bool gpu_relax_compute_tangent_gradient_norm(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    FemGpuComponentField &gradient,
    double &gradient_norm_sq,
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
        gradient.x,
        gradient.y,
        gradient.z,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG tangent-gradient blocks", reason)) {
        return false;
    }
    if (!gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            "launch GPU nonlinear-CG gradient norm reduction",
            reason)) {
        return false;
    }
    if (!gpu_rk_read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG gradient norm device->host",
            gradient_norm_sq,
            reason)) {
        return false;
    }
    if (!std::isfinite(gradient_norm_sq) || gradient_norm_sq < 0.0) {
        reason = "GPU nonlinear-CG produced a non-finite or negative tangent-gradient norm";
        return false;
    }
    return true;
}

bool gpu_relax_metric_dot(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    const FemGpuComponentField &a,
    const FemGpuComponentField &b,
    const char *label,
    double &value,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    fullmag_cuda_relax_metric_dot_blocks(
        a.x,
        a.y,
        a.z,
        b.x,
        b.y,
        b.z,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok(label, reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            label,
            reason) ||
        !gpu_rk_read_scalar_result(ctx, stream, label, value, reason)) {
        return false;
    }
    if (!std::isfinite(value)) {
        reason = std::string(label) + " produced a non-finite metric dot";
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
            "cudaMemcpyAsync GPU nonlinear-CG restore previous m",
            reason)) {
        return false;
    }
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceDirty;
    gpu.residency.host_state = FemGpuSyncState::HostStale;
    return true;
}

bool gpu_relax_restore_previous_direction(
    Context &ctx,
    cudaStream_t stream,
    const GpuRelaxNcgRollbackState &rollback,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (rollback.direction_valid &&
        !gpu_rk_copy_component_device(
            gpu.relaxation.nonlinear_cg_direction_backup,
            gpu.relaxation.nonlinear_cg_direction,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG restore previous direction",
            reason)) {
        return false;
    }
    gpu.relaxation.nonlinear_cg_direction_valid = rollback.direction_valid;
    return true;
}

int gpu_relax_restore_previous_state_after_failure(
    Context &ctx,
    cudaStream_t stream,
    const GpuRelaxNcgRollbackState &rollback,
    const char *failure_context,
    const std::string &original_reason,
    std::string &error)
{
    std::string restore_reason;
    if (!gpu_relax_restore_previous_magnetization(ctx, stream, restore_reason) ||
        !gpu_relax_restore_previous_direction(ctx, stream, rollback, restore_reason)) {
        error =
            "GPU nonlinear-CG failed to restore previous device state after " +
            std::string(failure_context) + ": " + restore_reason +
            "; original error: " + original_reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    restore_gpu_relax_ncg_metadata(ctx, rollback);
    error = original_reason + "; previous device state restored";
    return FULLMAG_FEM_ERR_INTERNAL;
}

bool gpu_relax_prepare_descent_direction(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    double gradient_norm_sq,
    double &p_dot_g,
    double &direction_norm_sq,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    auto &direction = gpu.relaxation.nonlinear_cg_direction;
    fullmag_cuda_relax_ncg_prepare_direction_blocks(
        gpu.rk.m_backup.x,
        gpu.rk.m_backup.y,
        gpu.rk.m_backup.z,
        gpu.rk.k[0].x,
        gpu.rk.k[0].y,
        gpu.rk.k[0].z,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.relaxation.nonlinear_cg_direction_valid,
        direction.x,
        direction.y,
        direction.z,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG direction preparation", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            "launch GPU nonlinear-CG direction-dot-gradient reduction",
            reason) ||
        !gpu_rk_read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG direction-dot-gradient device->host",
            p_dot_g,
            reason)) {
        return false;
    }
    if (!std::isfinite(p_dot_g) || p_dot_g >= 0.0) {
        fullmag_cuda_relax_ncg_prepare_direction_blocks(
            gpu.rk.m_backup.x,
            gpu.rk.m_backup.y,
            gpu.rk.m_backup.z,
            gpu.rk.k[0].x,
            gpu.rk.k[0].y,
            gpu.rk.k[0].z,
            gpu.mesh_metrics.lumped_mass,
            gpu.mesh_regions.magnetic_node_mask,
            false,
            direction.x,
            direction.y,
            direction.z,
            gpu.reductions.scalar_workspace,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU nonlinear-CG descent reset", reason) ||
            !gpu_relax_reduce_scalar_sum(
                ctx,
                stream,
                gpu.reductions.scalar_workspace,
                blocks,
                gpu.reductions.scalar_result,
                "launch GPU nonlinear-CG reset direction-dot-gradient reduction",
                reason) ||
            !gpu_rk_read_scalar_result(
                ctx,
                stream,
                "cudaMemcpyAsync GPU nonlinear-CG reset direction-dot-gradient device->host",
                p_dot_g,
                reason)) {
            return false;
        }
    }
    if (!std::isfinite(p_dot_g) || p_dot_g >= 0.0) {
        reason = "GPU nonlinear-CG produced a non-finite or non-descent direction";
        return false;
    }
    if (!gpu_relax_metric_dot(
            ctx,
            stream,
            n,
            blocks,
            direction,
            direction,
            "launch GPU nonlinear-CG direction norm reduction",
            direction_norm_sq,
            reason)) {
        return false;
    }
    if (!std::isfinite(direction_norm_sq) || direction_norm_sq <= 0.0) {
        reason = "GPU nonlinear-CG produced a non-positive direction norm";
        return false;
    }
    if (gradient_norm_sq <= kGradientFloor) {
        reason = "GPU nonlinear-CG cannot prepare direction for a degenerate gradient";
        return false;
    }
    return true;
}

bool gpu_relax_update_next_direction(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    double previous_gradient_norm_sq,
    double trial_gradient_norm_sq,
    uint64_t accepted_step,
    bool previous_direction_valid,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    fullmag_cuda_relax_ncg_pr_plus_numerator_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.rk.k[0].x,
        gpu.rk.k[0].y,
        gpu.rk.k[0].z,
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG PR+ numerator blocks", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            "launch GPU nonlinear-CG PR+ numerator reduction",
            reason)) {
        return false;
    }
    double numerator = 0.0;
    if (!gpu_rk_read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG PR+ numerator device->host",
            numerator,
            reason)) {
        return false;
    }
    if (!std::isfinite(numerator)) {
        reason = "GPU nonlinear-CG produced a non-finite PR+ numerator";
        return false;
    }

    double beta = 0.0;
    if (previous_direction_valid && previous_gradient_norm_sq > kGradientFloor) {
        beta = std::max(0.0, numerator / previous_gradient_norm_sq);
    }
    if (accepted_step % kRestartInterval == 0u) {
        beta = 0.0;
    }

    auto &direction = gpu.relaxation.nonlinear_cg_direction;
    fullmag_cuda_relax_ncg_update_direction_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.relaxation.nonlinear_cg_direction_backup.x,
        gpu.relaxation.nonlinear_cg_direction_backup.y,
        gpu.relaxation.nonlinear_cg_direction_backup.z,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        beta,
        direction.x,
        direction.y,
        direction.z,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG next direction update", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            "launch GPU nonlinear-CG next direction descent reduction",
            reason)) {
        return false;
    }
    double next_p_dot_g = 0.0;
    if (!gpu_rk_read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG next direction-dot-gradient device->host",
            next_p_dot_g,
            reason)) {
        return false;
    }
    if (!std::isfinite(next_p_dot_g) || next_p_dot_g >= 0.0) {
        fullmag_cuda_relax_ncg_prepare_direction_blocks(
            gpu.magnetization.m.x,
            gpu.magnetization.m.y,
            gpu.magnetization.m.z,
            gpu.rk.k[1].x,
            gpu.rk.k[1].y,
            gpu.rk.k[1].z,
            gpu.mesh_metrics.lumped_mass,
            gpu.mesh_regions.magnetic_node_mask,
            false,
            direction.x,
            direction.y,
            direction.z,
            gpu.reductions.scalar_workspace,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU nonlinear-CG next direction descent reset", reason)) {
            return false;
        }
    }
    gpu.relaxation.nonlinear_cg_direction_valid =
        std::isfinite(trial_gradient_norm_sq) && trial_gradient_norm_sq > kGradientFloor;
    return true;
}

} // namespace
#endif

int gpu_relax_nonlinear_cg_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
    out_stats = {};
#if FULLMAG_HAS_CUDA_RUNTIME
    std::string reason;
    if (!gpu_relax_ncg_preflight(ctx, reason)) {
        error = reason;
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }

    auto &gpu = ctx.gpu_state.device;
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const int n = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    const GpuRelaxNcgRollbackState rollback =
        capture_gpu_relax_ncg_rollback_state(ctx);

    if (!gpu_rk_copy_component_device(
            gpu.magnetization.m,
            gpu.rk.m_backup,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG backup current m",
            reason) ||
        !gpu_rk_copy_component_device(
            gpu.relaxation.nonlinear_cg_direction,
            gpu.relaxation.nonlinear_cg_direction_backup,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG backup current direction",
            reason)) {
        error = reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    double current_energy = 0.0;
    if (!gpu_relax_compute_effective_field_and_energy(
            ctx,
            stream,
            n,
            blocks,
            current_energy,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "current effective-field/energy evaluation failure",
            reason,
            error);
    }

    double gradient_norm_sq = 0.0;
    if (!gpu_relax_compute_tangent_gradient_norm(
            ctx,
            stream,
            n,
            blocks,
            gpu.rk.k[0],
            gradient_norm_sq,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "current tangent-gradient reduction failure",
            reason,
            error);
    }
    if (gradient_norm_sq <= kGradientFloor) {
        out_stats.step = ctx.state.step_count;
        out_stats.time_seconds = 0.0;
        out_stats.dt_seconds = 0.0;
        if (!gpu_rk_finalize_step_stats(ctx, out_stats, reason)) {
            error = reason;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        out_stats.max_rhs_amplitude = 0.0;
        gpu.relaxation.nonlinear_cg_direction_valid = false;
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
            "tangent_gradient_norm_sq",
            gradient_norm_sq,
            kGradientFloor);
        return FULLMAG_FEM_OK;
    }

    double p_dot_g = 0.0;
    double direction_norm_sq = 0.0;
    if (!gpu_relax_prepare_descent_direction(
            ctx,
            stream,
            n,
            blocks,
            gradient_norm_sq,
            p_dot_g,
            direction_norm_sq,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "descent-direction preparation failure",
            reason,
            error);
    }

    double trial_step = kDefaultStepSize;
    if (std::isfinite(ctx.relaxation.step_size) &&
        ctx.relaxation.step_size > 0.0) {
        trial_step =
            std::clamp(ctx.relaxation.step_size, kMinStepSize, kMaxStepSize);
    }
    trial_step = std::min(
        trial_step,
        std::clamp(
            1.0 / std::sqrt(direction_norm_sq),
            kMinStepSize,
            kMaxStepSize));

    double trial_energy = current_energy;
    uint32_t backtracks = 0;
    bool line_search_accepted = false;
    while (true) {
        fullmag_cuda_relax_retract_field(
            gpu.rk.m_backup.x,
            gpu.rk.m_backup.y,
            gpu.rk.m_backup.z,
            gpu.relaxation.nonlinear_cg_direction.x,
            gpu.relaxation.nonlinear_cg_direction.y,
            gpu.relaxation.nonlinear_cg_direction.z,
            gpu.mesh_regions.magnetic_node_mask,
            trial_step,
            gpu.rk.m_stage.x,
            gpu.rk.m_stage.y,
            gpu.rk.m_stage.z,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU nonlinear-CG trial retraction", reason) ||
            !gpu_rk_copy_component_device(
                gpu.rk.m_stage,
                gpu.magnetization.m,
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU nonlinear-CG trial m",
                reason) ||
            !gpu_relax_compute_effective_field_and_energy(
                ctx,
                stream,
                n,
                blocks,
                trial_energy,
                reason)) {
            return gpu_relax_restore_previous_state_after_failure(
                ctx,
                stream,
                rollback,
                "trial effective-field/energy evaluation failure",
                reason,
                error);
        }

        const bool armijo =
            trial_energy <=
            current_energy + kArmijoCoefficient * trial_step * p_dot_g;
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
        const std::string original_error =
            "GPU nonlinear-CG failed Armijo line search after " +
            std::to_string(backtracks) +
            " backtracks";
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "exhausted Armijo line search",
            original_error,
            error);
    }

    double accepted_gradient_norm_sq = 0.0;
    const uint64_t accepted_step = ctx.relaxation.accepted_steps + 1u;
    if (!gpu_relax_compute_tangent_gradient_norm(
            ctx,
            stream,
            n,
            blocks,
            gpu.rk.k[1],
            accepted_gradient_norm_sq,
            reason) ||
        !gpu_relax_update_next_direction(
            ctx,
            stream,
            n,
            blocks,
            gradient_norm_sq,
            accepted_gradient_norm_sq,
            accepted_step,
            rollback.direction_valid,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step direction update failure",
            reason,
            error);
    }

    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceDirty;
    gpu.residency.host_state = FemGpuSyncState::HostStale;
    gpu.rk.fsal_valid = false;
    ctx.relaxation.step_size =
        std::clamp(trial_step, kMinStepSize, kMaxStepSize);
    ctx.relaxation.accepted_steps = accepted_step;
    ctx.state.step_count += 1;
    ctx.state.current_time = 0.0;

    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = trial_step;
    out_stats.rejected_attempts = backtracks;
    out_stats.rhs_evaluations = backtracks + 2u;
    if (!gpu_rk_finalize_step_stats(ctx, out_stats, reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step stats finalization failure",
            reason,
            error);
    }
    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = trial_step;
    out_stats.max_rhs_amplitude = 0.0;
    out_stats.rejected_attempts = backtracks;
    out_stats.rhs_evaluations = backtracks + 2u;
    update_stage_completion_from_stats(ctx, out_stats);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = "GPU nonlinear-CG relaxation requires FULLMAG_HAS_CUDA_RUNTIME=1";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
