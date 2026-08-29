/*
 * GPU CUDA nonlinear-CG relaxation step source contract.
 *
 * Owns the native GPU Polak-Ribiere+ relaxation entrypoint, persistent search
 * direction handling, Armijo line search, and rollback for FEM CUDA
 * minimization. Runtime routing is enabled only through the native FEM backend
 * step boundary after the GPU transfer-audit preflight succeeds.
 *
 * NOTE: unlike the CPU/MFEM nonlinear-CG in cpu/mfem/relaxation/nonlinear_cg,
 * this GPU implementation is unpreconditioned — it does not apply the
 * exchange-mass preconditioner (M + w·K)^{-1}·M to the tangent gradient
 * before computing the PR+ beta or the descent direction.  This is a valid
 * but slower-converging variant; adding a GPU sparse CG preconditioner
 * solve is deferred.
 *
 * The GPU path also omits the CPU's third-tier raw-gradient recovery fallback
 * (retry with d = −g after both preconditioned and restart recoveries fail).
 * Primary and restarted recovery trials use the same canonical direct-energy
 * Armijo decision and bounded refinement owner.
 */

#include "gpu/cuda/relaxation/nonlinear_cg.hpp"

#include "context.hpp"
#include "gpu/cuda/runtime/nvtx_ranges.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "gpu/cuda/constraints/frozen_spins.cuh"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/relaxation/direct_energy_increment.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/reductions/reduction_workspace_state.hpp"
#include "src/relaxation_numerics.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
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
constexpr uint32_t kMaxBacktracks = 30;
constexpr uint32_t kArmijoRecoveryCycles = 1;
constexpr uint64_t kRestartInterval = 50;
constexpr size_t kNcgAcceptedGradientNormTailSlot = 0;
constexpr size_t kNcgPreviousGradientEnergyNormTailSlot = 1;
constexpr size_t kNcgPrPlusNumeratorTailSlot = 2;
constexpr size_t kNcgScalarTailCount = 3;
constexpr size_t kNcgCurrentGradientNormTailSlot = 0;
constexpr size_t kNcgCurrentGradientEnergyNormTailSlot = 1;
constexpr size_t kNcgCurrentDirectionDotGradientTailSlot = 2;
constexpr size_t kNcgCurrentDirectionNormTailSlot = 3;
constexpr size_t kNcgCurrentScalarTailCount = 4;

const uint8_t *gpu_relax_ncg_node_mask(const Context &ctx)
{
    const auto &regions = ctx.gpu_state.device.mesh_regions;
    return ctx.frozen_spins.enabled()
        ? regions.free_node_mask
        : regions.magnetic_node_mask;
}

void gpu_relax_ncg_project_frozen_reference(
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
static_assert(
    kGpuFinalScalarSlots + kNcgScalarTailCount <= FEM_GPU_SCALAR_RESULT_SLOTS,
    "GPU nonlinear-CG scalar tail must fit in the shared scalar result buffer");
static_assert(
    kGpuFinalScalarSlots + kNcgCurrentScalarTailCount <=
        FEM_GPU_SCALAR_RESULT_SLOTS,
    "GPU nonlinear-CG packed current metrics must fit in the shared scalar result buffer");
static_assert(
    kFemGpuAcceptedEnergyTermSlots == kGpuFinalScalarSlots,
    "GPU nonlinear-CG accepted endpoint token must store every energy term");

struct GpuNcgArmijoState {
    relaxation::EnergyDifference last_difference{};
    relaxation::EnergyDifference accepted_difference{};
    double last_increment_rhs_j = 0.0;
    double accepted_increment_rhs_j = 0.0;
};

std::string format_gpu_relax_ncg_scalar(double value)
{
    std::ostringstream out;
    out << std::scientific << std::setprecision(17) << value;
    return out.str();
}

uint64_t mix_signature(uint64_t seed, uint64_t value) noexcept
{
    return seed ^
        (value + 0x9e3779b97f4a7c15ULL + (seed << 6) + (seed >> 2));
}

uint64_t double_signature(double value) noexcept
{
    uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    return bits;
}

uint64_t ncg_solver_signature(const Context &ctx) noexcept
{
    const auto &solver = ctx.demag.solver;
    uint64_t signature = 0x1d8e4e27c47d124fULL;
    signature = mix_signature(signature, static_cast<uint64_t>(solver.solver));
    signature = mix_signature(
        signature, static_cast<uint64_t>(solver.preconditioner));
    signature = mix_signature(
        signature, double_signature(solver.relative_tolerance));
    signature = mix_signature(
        signature, static_cast<uint64_t>(solver.has_absolute_tolerance));
    signature = mix_signature(
        signature, double_signature(solver.absolute_tolerance));
    signature = mix_signature(signature, solver.max_iterations);
    return signature;
}

uint64_t ncg_configuration_signature(const Context &ctx) noexcept
{
    uint64_t signature = 0x94d049bb133111ebULL;
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.demag.enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.demag.realization));
    signature = mix_signature(
        signature, static_cast<uint64_t>(ctx.zeeman.has_external_field));
    signature = mix_signature(signature, ctx.zeeman.regional_drive_revision);
    for (double value : ctx.zeeman.external_field_am) {
        signature = mix_signature(signature, double_signature(value));
    }
    signature = mix_signature(
        signature, static_cast<uint64_t>(ctx.anisotropy.uniaxial_enabled));
    signature = mix_signature(
        signature, static_cast<uint64_t>(ctx.anisotropy.cubic_enabled));
    signature = mix_signature(
        signature, static_cast<uint64_t>(ctx.dmi.interfacial_enabled));
    signature = mix_signature(
        signature, static_cast<uint64_t>(ctx.dmi.bulk_enabled));
    signature = mix_signature(
        signature, static_cast<uint64_t>(ctx.magnetoelastic.enabled));
    signature = mix_signature(signature, ctx.material_fields.Ms_field.size());
    signature = mix_signature(signature, ctx.material_fields.A_field.size());
    signature = mix_signature(signature, ctx.material_fields.Ku_field.size());
    signature = mix_signature(signature, ctx.material_fields.Ku2_field.size());
    return signature;
}

bool consume_ncg_accepted_evaluation(
    Context &ctx,
    GpuDirectEnergySnapshot &snapshot) noexcept
{
    auto &relaxation = ctx.gpu_state.device.relaxation;
    auto &token = relaxation.accepted_evaluation;
    const bool exact_match =
        token.valid &&
        token.accepted_step == ctx.relaxation.accepted_steps &&
        token.state_generation == relaxation.state_generation &&
        token.configuration_signature == ncg_configuration_signature(ctx) &&
        token.solver_signature == ncg_solver_signature(ctx) &&
        !token.evaluation_refined &&
        std::isfinite(token.total_energy_j);
    token.valid = false;
    if (!exact_match) {
        token.misses += 1;
        relaxation.accepted_evaluation_cache_misses_current_step += 1;
        return false;
    }
    token.hits += 1;
    relaxation.accepted_evaluation_cache_hits_current_step += 1;
    snapshot.total_energy_j = token.total_energy_j;
    snapshot.terms_j = token.energy_terms_j;
    return true;
}

void publish_ncg_accepted_evaluation(
    Context &ctx,
    uint64_t accepted_step,
    const GpuDirectEnergySnapshot &snapshot,
    bool evaluation_refined) noexcept
{
    auto &relaxation = ctx.gpu_state.device.relaxation;
    auto &token = relaxation.accepted_evaluation;
    token.valid = !evaluation_refined;
    token.accepted_step = accepted_step;
    token.state_generation = relaxation.state_generation;
    token.configuration_signature = ncg_configuration_signature(ctx);
    token.solver_signature = ncg_solver_signature(ctx);
    token.evaluation_refined = evaluation_refined;
    token.total_energy_j = snapshot.total_energy_j;
    token.energy_terms_j = snapshot.terms_j;
}

struct GpuRelaxNcgRollbackState {
    double step_size = kDefaultStepSize;
    bool direction_valid = false;
    uint64_t accepted_steps = 0;
    uint64_t step_count = 0;
    double current_time = 0.0;
    double cached_robin_boundary_energy = 0.0;
    FemGpuAcceptedEvaluationToken accepted_evaluation{};
    int poisson_last_iterations = 0;
    double poisson_last_residual = 0.0;
    uint64_t poisson_last_setup_wall_time_ns = 0;
    uint64_t poisson_last_solver_apply_wall_time_ns = 0;
    uint64_t poisson_step_assemble_wall_time_ns = 0;
    uint64_t poisson_step_solver_apply_wall_time_ns = 0;
    uint64_t poisson_step_recover_wall_time_ns = 0;
    uint64_t poisson_step_energy_wall_time_ns = 0;
    bool poisson_last_solver_setup_reused = false;
    uint32_t poisson_solves_current_step = 0;
    uint32_t poisson_setup_count_current_step = 0;
    uint32_t poisson_fresh_zero_guess_count_current_step = 0;
    uint32_t poisson_event_wait_count_current_step = 0;
    uint32_t poisson_global_sync_count_current_step = 0;
    bool poisson_fresh_initial_guess_required = false;
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
        ctx.demag.cached_robin_boundary_energy,
        ctx.gpu_state.device.relaxation.accepted_evaluation,
        ctx.poisson_demag.last_iterations,
        ctx.poisson_demag.last_residual,
        ctx.poisson_demag.last_setup_wall_time_ns,
        ctx.poisson_demag.last_solver_apply_wall_time_ns,
        ctx.poisson_demag.step_assemble_wall_time_ns,
        ctx.poisson_demag.step_solver_apply_wall_time_ns,
        ctx.poisson_demag.step_recover_wall_time_ns,
        ctx.poisson_demag.step_energy_wall_time_ns,
        ctx.poisson_demag.last_solver_setup_reused,
        ctx.poisson_demag.solves_current_step,
        ctx.poisson_demag.setup_count_current_step,
        ctx.poisson_demag.fresh_zero_guess_count_current_step,
        ctx.poisson_demag.event_wait_count_current_step,
        ctx.poisson_demag.global_sync_count_current_step,
        ctx.poisson_demag.fresh_initial_guess_required,
    };
}

void restore_gpu_relax_ncg_accepted_evaluation(
    Context &ctx,
    const GpuRelaxNcgRollbackState &rollback) noexcept
{
    auto &token = ctx.gpu_state.device.relaxation.accepted_evaluation;
    const uint64_t hits = token.hits;
    const uint64_t misses = token.misses;
    const uint64_t invalidations = token.invalidations;
    token = rollback.accepted_evaluation;
    token.hits = hits;
    token.misses = misses;
    token.invalidations = invalidations;
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
    ctx.demag.cached_robin_boundary_energy =
        rollback.cached_robin_boundary_energy;
    restore_gpu_relax_ncg_accepted_evaluation(ctx, rollback);
    ctx.poisson_demag.last_iterations = rollback.poisson_last_iterations;
    ctx.poisson_demag.last_residual = rollback.poisson_last_residual;
    ctx.poisson_demag.last_setup_wall_time_ns =
        rollback.poisson_last_setup_wall_time_ns;
    ctx.poisson_demag.last_solver_apply_wall_time_ns =
        rollback.poisson_last_solver_apply_wall_time_ns;
    ctx.poisson_demag.step_assemble_wall_time_ns =
        rollback.poisson_step_assemble_wall_time_ns;
    ctx.poisson_demag.step_solver_apply_wall_time_ns =
        rollback.poisson_step_solver_apply_wall_time_ns;
    ctx.poisson_demag.step_recover_wall_time_ns =
        rollback.poisson_step_recover_wall_time_ns;
    ctx.poisson_demag.step_energy_wall_time_ns =
        rollback.poisson_step_energy_wall_time_ns;
    ctx.poisson_demag.last_solver_setup_reused =
        rollback.poisson_last_solver_setup_reused;
    ctx.poisson_demag.solves_current_step =
        rollback.poisson_solves_current_step;
    ctx.poisson_demag.setup_count_current_step =
        rollback.poisson_setup_count_current_step;
    ctx.poisson_demag.fresh_zero_guess_count_current_step =
        rollback.poisson_fresh_zero_guess_count_current_step;
    ctx.poisson_demag.event_wait_count_current_step =
        rollback.poisson_event_wait_count_current_step;
    ctx.poisson_demag.global_sync_count_current_step =
        rollback.poisson_global_sync_count_current_step;
    ctx.poisson_demag.fresh_initial_guess_required =
        rollback.poisson_fresh_initial_guess_required;
}

void mark_gpu_relax_ncg_device_source_of_truth(Context &ctx)
{
    auto &gpu = ctx.gpu_state.device;
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceDirty;
    gpu.residency.host_state = FemGpuSyncState::HostStale;
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

bool inject_nonlinear_cg_failure(
    Context &ctx,
    GpuRelaxNcgFailurePoint point,
    std::string &reason)
{
    auto &relaxation = ctx.gpu_state.device.relaxation;
    if (relaxation.next_nonlinear_cg_failure != point) {
        return false;
    }
    relaxation.next_nonlinear_cg_failure = GpuRelaxNcgFailurePoint::None;
    relaxation.nonlinear_cg_failures_injected += 1u;
    switch (point) {
        case GpuRelaxNcgFailurePoint::AfterTrialMagnetization:
            reason = "injected GPU nonlinear-CG failure after trial magnetization";
            break;
        case GpuRelaxNcgFailurePoint::DuringAcceptedStatistics:
            reason = "injected GPU nonlinear-CG failure during accepted statistics";
            break;
        case GpuRelaxNcgFailurePoint::None:
            return false;
    }
    return true;
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
    if (gpu.materials.ms == nullptr) {
        reason = "GPU nonlinear-CG requires a device nodal saturation-magnetisation field";
        return false;
    }
    if (gpu.mesh_regions.magnetic_node_mask == nullptr ||
        gpu.mesh_regions.node_count != gpu.lifecycle.node_count) {
        reason = "GPU nonlinear-CG requires a device magnetic-node mask matching the FEM state";
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
        reason = "GPU nonlinear-CG requires complete device Frozen Spins masks and reference matching the FEM state";
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
    if (gpu.relaxation.projected_gradient_accepted_h_eff.x == nullptr ||
        gpu.relaxation.projected_gradient_accepted_h_eff.y == nullptr ||
        gpu.relaxation.projected_gradient_accepted_h_eff.z == nullptr) {
        reason = "GPU nonlinear-CG requires persistent accepted H_eff scratch";
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
        gpu_relax_ncg_node_mask(ctx),
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
    if (!gpu_rk_read_control_scalar_result(
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

bool gpu_relax_compute_effective_field_energy_gradient_and_direction(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    FemGpuComponentField &gradient,
    bool evaluate_fields,
    GpuDirectEnergySnapshot &energy_snapshot,
    double &total_energy,
    double &gradient_norm_sq,
    double &gradient_energy_norm_sq,
    double &p_dot_g,
    double &direction_norm_sq,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (evaluate_fields) {
        if (!gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
                ctx,
                gpu.magnetization.m,
                stream,
                n,
                ctx.state.current_time,
                "launch GPU nonlinear-CG h_eff accumulation",
                reason) ||
            !gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
            return false;
        }
    }
    double *const current_scalar_results = evaluate_fields
        ? gpu.reductions.scalar_result + kGpuFinalScalarSlots
        : gpu.reductions.scalar_result;
    fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.fields.h_eff.x,
        gpu.fields.h_eff.y,
        gpu.fields.h_eff.z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_ncg_node_mask(ctx),
        gpu.relaxation.nonlinear_cg_direction_valid,
        gradient.x,
        gradient.y,
        gradient.z,
        gpu.relaxation.nonlinear_cg_direction.x,
        gpu.relaxation.nonlinear_cg_direction.y,
        gpu.relaxation.nonlinear_cg_direction.z,
        gpu.reductions.scalar_workspace,
        gpu.rk.error.x,
        gpu.rk.error.y,
        gpu.rk.error.z,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG current gradient/direction blocks", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            current_scalar_results + kNcgCurrentGradientNormTailSlot,
            "launch GPU nonlinear-CG gradient norm reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.x,
            blocks,
            current_scalar_results + kNcgCurrentGradientEnergyNormTailSlot,
            "launch GPU nonlinear-CG gradient energy norm reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.y,
            blocks,
            current_scalar_results + kNcgCurrentDirectionDotGradientTailSlot,
            "launch GPU nonlinear-CG direction-dot-gradient reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.z,
            blocks,
            current_scalar_results + kNcgCurrentDirectionNormTailSlot,
            "launch GPU nonlinear-CG direction norm reduction",
            reason)) {
        return false;
    }

    double scalars[4] = {0.0, 0.0, 0.0, 0.0};
    if (evaluate_fields) {
        std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> packed_scalars{};
        if (!gpu_rk_read_control_scalar_results(
                ctx,
                stream,
                "cudaMemcpyAsync GPU nonlinear-CG packed current metrics device->host",
                packed_scalars.data(),
                kGpuFinalScalarSlots + kNcgCurrentScalarTailCount,
                reason) ||
            !gpu_unpack_direct_energy_snapshot(
                ctx, packed_scalars.data(), energy_snapshot, reason)) {
            return false;
        }
        std::copy_n(
            packed_scalars.data() + kGpuFinalScalarSlots,
            kNcgCurrentScalarTailCount,
            scalars);
    } else if (!gpu_rk_read_control_scalar_results(
                   ctx,
                   stream,
                   "cudaMemcpyAsync GPU nonlinear-CG current gradient/direction scalars device->host",
                   scalars,
                   kNcgCurrentScalarTailCount,
                   reason)) {
        return false;
    }
    total_energy = energy_snapshot.total_energy_j;
    gradient_norm_sq = scalars[0];
    gradient_energy_norm_sq = scalars[1];
    p_dot_g = scalars[2];
    direction_norm_sq = scalars[3];
    if (!std::isfinite(total_energy)) {
        reason = "GPU nonlinear-CG produced non-finite total energy";
        return false;
    }
    if (!std::isfinite(gradient_norm_sq) || gradient_norm_sq < 0.0) {
        reason = "GPU nonlinear-CG produced a non-finite or negative tangent-gradient norm";
        return false;
    }
    if (!std::isfinite(gradient_energy_norm_sq) ||
        gradient_energy_norm_sq < 0.0) {
        reason = "GPU nonlinear-CG produced a non-finite or negative energy-metric tangent-gradient norm";
        return false;
    }
    if (!std::isfinite(p_dot_g) || !std::isfinite(direction_norm_sq) ||
        direction_norm_sq < 0.0) {
        reason = "GPU nonlinear-CG produced invalid current direction scalars";
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
        gpu_relax_ncg_node_mask(ctx),
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
        !gpu_rk_read_control_scalar_result(ctx, stream, label, value, reason)) {
        return false;
    }
    if (!std::isfinite(value)) {
        reason = std::string(label) + " produced a non-finite metric dot";
        return false;
    }
    return true;
}

bool gpu_relax_compute_accepted_gradient_norm_and_pr_plus_numerator(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    double *accepted_gradient_norm_sq =
        gpu.reductions.scalar_result + kGpuFinalScalarSlots +
        kNcgAcceptedGradientNormTailSlot;
    double *previous_gradient_energy_norm_sq =
        gpu.reductions.scalar_result + kGpuFinalScalarSlots +
        kNcgPreviousGradientEnergyNormTailSlot;
    double *pr_plus_numerator =
        gpu.reductions.scalar_result + kGpuFinalScalarSlots +
        kNcgPrPlusNumeratorTailSlot;
    fullmag_cuda_relax_ncg_gradient_norm_and_pr_plus_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.fields.h_eff.x,
        gpu.fields.h_eff.y,
        gpu.fields.h_eff.z,
        gpu.rk.k[0].x,
        gpu.rk.k[0].y,
        gpu.rk.k[0].z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_ncg_node_mask(ctx),
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.reductions.scalar_workspace,
        gpu.rk.error.x,
        gpu.rk.error.y,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG accepted gradient/PR+ blocks", reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            accepted_gradient_norm_sq,
            "launch GPU nonlinear-CG accepted gradient norm reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.x,
            blocks,
            previous_gradient_energy_norm_sq,
            "launch GPU nonlinear-CG previous gradient energy norm reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.y,
            blocks,
            pr_plus_numerator,
            "launch GPU nonlinear-CG PR+ numerator reduction",
            reason)) {
        return false;
    }
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

bool gpu_relax_restore_previous_state(
    Context &ctx,
    cudaStream_t stream,
    const GpuRelaxNcgRollbackState &rollback,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_copy_component_device(
            gpu.rk.m_backup,
            gpu.magnetization.m,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG restore previous m",
            reason) ||
        !gpu_relax_restore_previous_direction(ctx, stream, rollback, reason)) {
        return false;
    }
    if (!cuda_ok(
            cudaStreamSynchronize(stream),
            "GPU nonlinear-CG rollback synchronization",
            reason)) {
        return false;
    }
    restore_gpu_relax_ncg_metadata(ctx, rollback);
    gpu_relax_invalidate_accepted_evaluation(gpu.relaxation);
    // Nonlinear-CG uses k0 as gradient scratch, so a failed minimizer step
    // invalidates FSAL instead of retaining another full vector backup.
    gpu.rk.fsal_valid = false;
    gpu.fields.accepted_observables_valid = false;
    gpu.fields.accepted_observables_step = ctx.state.step_count;
    ctx.poisson_demag.fresh_initial_guess_required = true;
    mark_gpu_relax_ncg_device_source_of_truth(ctx);
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
    if (!gpu_relax_restore_previous_state(
            ctx, stream, rollback, restore_reason)) {
        error =
            "GPU nonlinear-CG failed to restore previous device state after " +
            std::string(failure_context) + ": " + restore_reason +
            "; original error: " + original_reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    error = original_reason + "; previous device state restored";
    return FULLMAG_FEM_ERR_INTERNAL;
}

bool gpu_relax_prepare_descent_direction(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    double gradient_norm_sq,
    double gradient_energy_norm_sq,
    double &p_dot_g,
    double &direction_norm_sq,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    auto &direction = gpu.relaxation.nonlinear_cg_direction;
    const bool reuse_gradient_scalars =
        !gpu.relaxation.nonlinear_cg_direction_valid;
    fullmag_cuda_relax_ncg_prepare_direction_blocks(
        gpu.rk.m_backup.x,
        gpu.rk.m_backup.y,
        gpu.rk.m_backup.z,
        gpu.rk.k[0].x,
        gpu.rk.k[0].y,
        gpu.rk.k[0].z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_ncg_node_mask(ctx),
        gpu.relaxation.nonlinear_cg_direction_valid,
        direction.x,
        direction.y,
        direction.z,
        gpu.reductions.scalar_workspace,
        gpu.rk.error.x,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG direction preparation", reason)) {
        return false;
    }
    if (!reuse_gradient_scalars &&
        (!gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result,
            "launch GPU nonlinear-CG direction-dot-gradient reduction",
            reason) ||
        !gpu_relax_reduce_scalar_sum(
            ctx,
            stream,
            gpu.rk.error.x,
            blocks,
            gpu.reductions.scalar_result + 1,
            "launch GPU nonlinear-CG direction norm reduction",
            reason))) {
        return false;
    }
    if (reuse_gradient_scalars) {
        p_dot_g = -gradient_energy_norm_sq;
        direction_norm_sq = gradient_norm_sq;
    } else {
        double direction_scalars[2] = {0.0, 0.0};
        if (!gpu_rk_read_control_scalar_results(
                ctx,
                stream,
                "cudaMemcpyAsync GPU nonlinear-CG direction scalars device->host",
                direction_scalars,
                2,
                reason)) {
            return false;
        }
        p_dot_g = direction_scalars[0];
        direction_norm_sq = direction_scalars[1];
    }
    if (!std::isfinite(p_dot_g) || p_dot_g >= 0.0) {
        fullmag_cuda_relax_ncg_reset_direction_if_not_descent(
            gpu.rk.k[0].x,
            gpu.rk.k[0].y,
            gpu.rk.k[0].z,
            gpu.reductions.scalar_result,
            gpu_relax_ncg_node_mask(ctx),
            direction.x,
            direction.y,
            direction.z,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU nonlinear-CG descent reset", reason)) {
            return false;
        }
        p_dot_g = -gradient_energy_norm_sq;
        direction_norm_sq = gradient_norm_sq;
    }
    if (!std::isfinite(p_dot_g) || p_dot_g >= 0.0) {
        reason = "GPU nonlinear-CG produced a non-finite or non-descent direction";
        return false;
    }
    if (!std::isfinite(direction_norm_sq) || direction_norm_sq <= 0.0) {
        reason = "GPU nonlinear-CG produced a non-positive direction norm";
        return false;
    }
    if (gradient_norm_sq == 0.0) {
        reason = "GPU nonlinear-CG cannot prepare direction for a degenerate gradient";
        return false;
    }
    return true;
}

bool gpu_relax_retry_ncg_line_search_with_restart(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    const GpuDirectEnergySnapshot &current_snapshot,
    FemGpuComponentField &base_h_demag,
    double gradient_norm_sq,
    double gradient_energy_norm_sq,
    double &p_dot_g,
    double &direction_norm_sq,
    double &trial_step,
    double &last_trial_energy_j,
    uint32_t &backtracks,
    GpuDirectEnergySnapshot &accepted_snapshot,
    bool &accepted_refined,
    uint32_t &logical_rhs_evaluations,
    uint32_t &refinement_rhs_evaluations,
    bool &every_permitted_trial_unchanged,
    GpuNcgArmijoState &armijo_state,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    for (uint32_t recovery_cycle = 0;
         recovery_cycle < kArmijoRecoveryCycles;
         ++recovery_cycle) {
        gpu.relaxation.nonlinear_cg_direction_valid = false;
        if (!gpu_relax_prepare_descent_direction(
                ctx,
                stream,
                n,
                blocks,
                gradient_norm_sq,
                gradient_energy_norm_sq,
                p_dot_g,
                direction_norm_sq,
                reason)) {
            return false;
        }
        const double restart_step = relaxation::initial_step_from_volume_norm_sq(
            direction_norm_sq,
            kMaxStepSize,
            kMinStepSize,
            kMaxStepSize);
        trial_step = restart_step;
        while (true) {
            fullmag_cuda_relax_retract_field(
                gpu.rk.m_backup.x,
                gpu.rk.m_backup.y,
                gpu.rk.m_backup.z,
                gpu.relaxation.nonlinear_cg_direction.x,
                gpu.relaxation.nonlinear_cg_direction.y,
                gpu.relaxation.nonlinear_cg_direction.z,
                gpu_relax_ncg_node_mask(ctx),
                trial_step,
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
            gpu_relax_ncg_project_frozen_reference(
                ctx, gpu.rk.m_stage, stream);
            if (!cuda_launch_ok("launch GPU nonlinear-CG recovery retraction", reason) ||
                !gpu_direct_minimizer_precompute_representable_chord_increment(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.m_stage,
                    gpu.relaxation.projected_gradient_accepted_h_eff,
                    reason) ||
                !gpu_rk_copy_component_device(
                    gpu.rk.m_stage,
                    gpu.magnetization.m,
                    gpu.lifecycle.node_count,
                    stream,
                    "cudaMemcpyAsync GPU nonlinear-CG recovery m",
                    reason) ||
                !gpu_relax_compute_effective_field_and_energy_terms(
                    ctx,
                    stream,
                    n,
                    blocks,
                    reason)) {
                return false;
            }
            logical_rhs_evaluations += 1u;

            GpuDirectArmijoResult armijo_result{};
            if (!gpu_direct_minimizer_armijo_evaluate(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    base_h_demag,
                    current_snapshot,
                    kArmijoCoefficient,
                    true,
                    armijo_result,
                    reason)) {
                return false;
            }
            armijo_state.last_difference = armijo_result.difference;
            armijo_state.last_increment_rhs_j = armijo_result.armijo_rhs_j;
            const bool trial_unchanged =
                armijo_result.trial_active_state_unchanged;
            every_permitted_trial_unchanged =
                every_permitted_trial_unchanged && trial_unchanged;
            if (armijo_result.refinement_attempted &&
                !gpu_direct_armijo_refine(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.m_stage,
                    base_h_demag,
                    armijo_result.armijo_rhs_j,
                    armijo_result,
                    reason)) {
                return false;
            }
            if (armijo_result.refinement_attempted) {
                gpu.relaxation.direct_energy_refinements_current_step += 1;
                gpu.relaxation.direct_energy_refinements += 1;
            }
            refinement_rhs_evaluations +=
                armijo_result.refinement_rhs_evaluations;
            last_trial_energy_j =
                armijo_result.trial_snapshot.total_energy_j;
            if (!std::isfinite(last_trial_energy_j)) {
                reason = "GPU nonlinear-CG produced non-finite total energy";
                return false;
            }
            if (!trial_unchanged &&
                (armijo_result.decision ==
                     relaxation::ArmijoDifferenceDecision::Accept ||
                 armijo_result.refinement_accepted)) {
                accepted_snapshot = armijo_result.trial_snapshot;
                accepted_refined = armijo_result.refinement_accepted;
                armijo_state.accepted_difference = armijo_result.difference;
                armijo_state.accepted_increment_rhs_j =
                    armijo_result.armijo_rhs_j;
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

bool gpu_relax_update_next_direction(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    uint64_t accepted_step,
    bool previous_direction_valid,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    const bool restart_step = accepted_step % kRestartInterval == 0u;
    const double *previous_gradient_energy_norm_sq =
        gpu.reductions.scalar_result + kGpuFinalScalarSlots +
        kNcgPreviousGradientEnergyNormTailSlot;
    const double *pr_plus_numerator =
        gpu.reductions.scalar_result + kGpuFinalScalarSlots +
        kNcgPrPlusNumeratorTailSlot;

    auto &direction = gpu.relaxation.nonlinear_cg_direction;
    fullmag_cuda_relax_ncg_update_direction_from_reduced_pr_plus(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.relaxation.nonlinear_cg_direction_backup.x,
        gpu.relaxation.nonlinear_cg_direction_backup.y,
        gpu.relaxation.nonlinear_cg_direction_backup.z,
        previous_gradient_energy_norm_sq,
        pr_plus_numerator,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu_relax_ncg_node_mask(ctx),
        relaxation::reduction_roundoff_bound(3u * static_cast<size_t>(n)),
        previous_direction_valid,
        restart_step,
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
    fullmag_cuda_relax_ncg_reset_direction_if_not_descent(
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        gpu.reductions.scalar_result,
        gpu_relax_ncg_node_mask(ctx),
        direction.x,
        direction.y,
        direction.z,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU nonlinear-CG next direction device reset", reason)) {
        return false;
    }
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
    FULLMAG_NVTX_RANGE("fem.relax.ncg.step");
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

    gpu_relax_ncg_project_frozen_reference(
        ctx, gpu.magnetization.m, stream);
    if (!cuda_launch_ok(
            "launch GPU nonlinear-CG entry Frozen Spins restore",
            reason)) {
        error = reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    if (!gpu_rk_copy_component_device(
            gpu.magnetization.m,
            gpu.rk.m_backup,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG backup current m",
            reason) ||
        (rollback.direction_valid &&
         !gpu_rk_copy_component_device(
             gpu.relaxation.nonlinear_cg_direction,
             gpu.relaxation.nonlinear_cg_direction_backup,
             gpu.lifecycle.node_count,
             stream,
             "cudaMemcpyAsync GPU nonlinear-CG backup current direction",
             reason))) {
        error = reason;
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    double current_energy = 0.0;
    GpuDirectEnergySnapshot current_snapshot{};
    const bool reused_current =
        consume_ncg_accepted_evaluation(ctx, current_snapshot);
    // rhs_evaluations is a logical line-search record count. Reusing the
    // accepted endpoint avoids physical work but still supplies this step's
    // nominal current-state record.
    uint32_t logical_rhs_evaluations = 1u;
    double gradient_norm_sq = 0.0;
    double gradient_energy_norm_sq = 0.0;
    double p_dot_g = 0.0;
    double direction_norm_sq = 0.0;
    if (!gpu_relax_compute_effective_field_energy_gradient_and_direction(
            ctx,
            stream,
            n,
            blocks,
            gpu.rk.k[0],
            !reused_current,
            current_snapshot,
            current_energy,
            gradient_norm_sq,
            gradient_energy_norm_sq,
            p_dot_g,
            direction_norm_sq,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "current effective-field/energy/gradient evaluation failure",
            reason,
            error);
    }
    gpu.fields.accepted_observables_valid = true;
    gpu.fields.accepted_observables_step = ctx.state.step_count;
    const double current_torque_apm = current_snapshot.terms_j[
        static_cast<size_t>(GpuFinalScalarSlot::MaxTorque)];
    if (relaxation_torque_confirmation_pending(ctx, current_torque_apm)) {
        out_stats.step = ctx.state.step_count;
        out_stats.time_seconds = 0.0;
        out_stats.dt_seconds = 0.0;
        mark_gpu_relax_ncg_device_source_of_truth(ctx);
        if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)) {
            error = reason;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        out_stats.max_rhs_amplitude = 0.0;
        return FULLMAG_FEM_OK;
    }
    if (gradient_norm_sq == 0.0) {
        out_stats.step = ctx.state.step_count;
        out_stats.time_seconds = 0.0;
        out_stats.dt_seconds = 0.0;
        mark_gpu_relax_ncg_device_source_of_truth(ctx);
        if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)) {
            error = reason;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        out_stats.max_rhs_amplitude = 0.0;
        gpu.relaxation.nonlinear_cg_direction_valid = false;
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

    const bool reset_descent_direction =
        !std::isfinite(p_dot_g) || p_dot_g >= 0.0 ||
        !std::isfinite(direction_norm_sq) || direction_norm_sq <= 0.0;
    if (reset_descent_direction) {
        gpu.relaxation.nonlinear_cg_direction_valid = false;
    }
    if (reset_descent_direction) {
        if (!gpu_relax_prepare_descent_direction(
            ctx,
            stream,
            n,
            blocks,
            gradient_norm_sq,
            gradient_energy_norm_sq,
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
    }

    double trial_step = kDefaultStepSize;
    if (std::isfinite(ctx.relaxation.step_size) &&
        ctx.relaxation.step_size > 0.0) {
        trial_step =
            std::clamp(ctx.relaxation.step_size, kMinStepSize, kMaxStepSize);
    }
    trial_step = relaxation::initial_step_from_volume_norm_sq(
        direction_norm_sq,
        trial_step,
        kMinStepSize,
        kMaxStepSize);

    if (!gpu_rk_copy_component_device(
            gpu.fields.h_demag,
            gpu.rk.error,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG backup current H_demag",
            reason) ||
        !gpu_rk_copy_component_device(
            gpu.fields.h_eff,
            gpu.relaxation.projected_gradient_accepted_h_eff,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU nonlinear-CG backup accepted H_eff",
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "current direct-energy snapshot failure",
            reason,
            error);
    }

    double last_trial_energy_j = current_energy;
    uint32_t backtracks = 0;
    bool line_search_accepted = false;
    bool accepted_snapshot_valid = false;
    bool accepted_refined = false;
    bool every_permitted_trial_unchanged = true;
    uint32_t refinement_rhs_evaluations = 0;
    GpuDirectEnergySnapshot accepted_snapshot{};
    GpuNcgArmijoState armijo_state;
    {
        FULLMAG_NVTX_RANGE("fem.relax.armijo");
        while (true) {
            fullmag_cuda_relax_retract_field(
                gpu.rk.m_backup.x,
                gpu.rk.m_backup.y,
                gpu.rk.m_backup.z,
                gpu.relaxation.nonlinear_cg_direction.x,
                gpu.relaxation.nonlinear_cg_direction.y,
                gpu.relaxation.nonlinear_cg_direction.z,
                gpu_relax_ncg_node_mask(ctx),
                trial_step,
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
            gpu_relax_ncg_project_frozen_reference(
                ctx, gpu.rk.m_stage, stream);
            if (!cuda_launch_ok("launch GPU nonlinear-CG trial retraction", reason) ||
                !gpu_direct_minimizer_precompute_representable_chord_increment(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.m_stage,
                    gpu.relaxation.projected_gradient_accepted_h_eff,
                    reason) ||
                !gpu_rk_copy_component_device(
                    gpu.rk.m_stage,
                    gpu.magnetization.m,
                    gpu.lifecycle.node_count,
                    stream,
                    "cudaMemcpyAsync GPU nonlinear-CG trial m",
                    reason) ||
                inject_nonlinear_cg_failure(
                    ctx,
                    GpuRelaxNcgFailurePoint::AfterTrialMagnetization,
                    reason) ||
                !gpu_relax_compute_effective_field_and_energy_terms(
                    ctx,
                    stream,
                    n,
                    blocks,
                    reason)) {
                return gpu_relax_restore_previous_state_after_failure(
                    ctx,
                    stream,
                    rollback,
                    "trial effective-field/energy evaluation failure",
                    reason,
                    error);
            }
            logical_rhs_evaluations += 1u;

            GpuDirectArmijoResult armijo_result{};
            if (!gpu_direct_minimizer_armijo_evaluate(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.error,
                    current_snapshot,
                    kArmijoCoefficient,
                    true,
                    armijo_result,
                    reason)) {
                return gpu_relax_restore_previous_state_after_failure(
                    ctx,
                    stream,
                    rollback,
                    "trial direct-energy evaluation failure",
                    reason,
                    error);
            }
            armijo_state.last_difference = armijo_result.difference;
            armijo_state.last_increment_rhs_j = armijo_result.armijo_rhs_j;
            const bool trial_unchanged =
                armijo_result.trial_active_state_unchanged;
            every_permitted_trial_unchanged =
                every_permitted_trial_unchanged && trial_unchanged;
            if (armijo_result.refinement_attempted &&
                !gpu_direct_armijo_refine(
                    ctx,
                    stream,
                    n,
                    blocks,
                    gpu.rk.m_backup,
                    gpu.rk.m_stage,
                    gpu.rk.error,
                    armijo_result.armijo_rhs_j,
                    armijo_result,
                    reason)) {
                return gpu_relax_restore_previous_state_after_failure(
                    ctx,
                    stream,
                    rollback,
                    "trial direct-energy refinement failure",
                    reason,
                    error);
            }
            if (armijo_result.refinement_attempted) {
                gpu.relaxation.direct_energy_refinements_current_step += 1;
                gpu.relaxation.direct_energy_refinements += 1;
            }
            refinement_rhs_evaluations +=
                armijo_result.refinement_rhs_evaluations;
            last_trial_energy_j =
                armijo_result.trial_snapshot.total_energy_j;
            if (!std::isfinite(last_trial_energy_j)) {
                return gpu_relax_restore_previous_state_after_failure(
                    ctx,
                    stream,
                    rollback,
                    "trial direct-energy validation failure",
                    "GPU nonlinear-CG produced non-finite total energy",
                    error);
            }
            const bool armijo =
                !trial_unchanged &&
                (armijo_result.decision ==
                     relaxation::ArmijoDifferenceDecision::Accept ||
                 armijo_result.refinement_accepted);
            if (armijo) {
                line_search_accepted = true;
                accepted_snapshot = armijo_result.trial_snapshot;
                accepted_snapshot_valid = true;
                accepted_refined = armijo_result.refinement_accepted;
                armijo_state.accepted_difference = armijo_result.difference;
                armijo_state.accepted_increment_rhs_j =
                    armijo_result.armijo_rhs_j;
                break;
            }
            if (backtracks >= kMaxBacktracks) {
                break;
            }
            trial_step *= 0.5;
            backtracks += 1;
        }
        if (!line_search_accepted) {
            if (gpu_relax_retry_ncg_line_search_with_restart(
                    ctx,
                    stream,
                    n,
                    blocks,
                    current_snapshot,
                    gpu.rk.error,
                    gradient_norm_sq,
                    gradient_energy_norm_sq,
                    p_dot_g,
                    direction_norm_sq,
                    trial_step,
                    last_trial_energy_j,
                    backtracks,
                    accepted_snapshot,
                    accepted_refined,
                    logical_rhs_evaluations,
                    refinement_rhs_evaluations,
                    every_permitted_trial_unchanged,
                    armijo_state,
                    reason)) {
                line_search_accepted = true;
                accepted_snapshot_valid = true;
            }
        }
    }
    if (line_search_accepted && !accepted_snapshot_valid &&
        !gpu_direct_energy_snapshot(ctx, stream, accepted_snapshot, reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted direct-energy snapshot failure",
            reason,
            error);
    }
    if (!line_search_accepted && !reason.empty()) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "recovery Armijo line search failure",
            reason,
            error);
    }
    if (!line_search_accepted) {
        if (every_permitted_trial_unchanged) {
            std::string restore_reason;
            if (!gpu_relax_restore_previous_state(
                    ctx, stream, rollback, restore_reason)) {
                error =
                    "GPU nonlinear-CG failed to restore the representability-stationary state: " +
                    restore_reason;
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            if (!gpu_relax_compute_effective_field_and_energy_terms(
                    ctx, stream, n, blocks, reason)) {
                error =
                    "GPU nonlinear-CG failed to refresh the representability-stationary state: " +
                    reason;
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            gpu.fields.accepted_observables_valid = true;
            gpu.fields.accepted_observables_step = ctx.state.step_count;
            logical_rhs_evaluations += 1u;
            out_stats.step = ctx.state.step_count;
            out_stats.time_seconds = 0.0;
            out_stats.dt_seconds = 0.0;
            out_stats.rejected_attempts = backtracks;
            out_stats.rhs_evaluations =
                logical_rhs_evaluations + refinement_rhs_evaluations;
            if (!gpu_rk_finalize_step_stats_control_readback(
                    ctx, out_stats, reason)) {
                error = reason;
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            out_stats.step = ctx.state.step_count;
            out_stats.time_seconds = 0.0;
            out_stats.dt_seconds = 0.0;
            out_stats.max_rhs_amplitude = 0.0;
            out_stats.rejected_attempts = backtracks;
            out_stats.rhs_evaluations =
                logical_rhs_evaluations + refinement_rhs_evaluations;
            gpu.relaxation.nonlinear_cg_direction_valid = false;
            relaxation::publish_representability_stationary_completion(ctx);
            return FULLMAG_FEM_OK;
        }
        const double armijo_rhs =
            current_energy + armijo_state.last_increment_rhs_j;
        const double trial_energy_increment_j =
            last_trial_energy_j - current_energy;
        const double energy_scale_j = std::max(
            std::abs(current_energy), std::abs(last_trial_energy_j));
        const double current_torque_apm = current_snapshot.terms_j[
            static_cast<size_t>(GpuFinalScalarSlot::MaxTorque)];
        const double torque_tolerance_apm =
            ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0
            ? ctx.stage_completion.relax_stop.torque_tolerance_apm
            : std::numeric_limits<double>::quiet_NaN();
        const std::string original_error =
            "GPU nonlinear-CG failed Armijo line search after " +
            std::to_string(backtracks) +
            " backtracks; current_energy_j=" +
            format_gpu_relax_ncg_scalar(current_energy) +
            " last_trial_energy_j=" +
            format_gpu_relax_ncg_scalar(last_trial_energy_j) +
            " trial_energy_increment_j=" +
            format_gpu_relax_ncg_scalar(trial_energy_increment_j) +
            " energy_scale_j=" +
            format_gpu_relax_ncg_scalar(energy_scale_j) +
            " armijo_rhs_j=" + format_gpu_relax_ncg_scalar(armijo_rhs) +
            " armijo_increment_rhs_j=" + format_gpu_relax_ncg_scalar(
                armijo_state.last_increment_rhs_j) +
            " direct_delta_j=" + format_gpu_relax_ncg_scalar(
                armijo_state.last_difference.delta_joules) +
            " direct_roundoff_bound_j=" + format_gpu_relax_ncg_scalar(
                armijo_state.last_difference.roundoff_bound_joules) +
            " direct_upper_j=" + format_gpu_relax_ncg_scalar(
                armijo_state.last_difference.delta_joules +
                armijo_state.last_difference.roundoff_bound_joules) +
            " last_trial_step=" + format_gpu_relax_ncg_scalar(trial_step) +
            " direction_dot_gradient=" +
            format_gpu_relax_ncg_scalar(p_dot_g) +
            " gradient_norm_sq=" +
            format_gpu_relax_ncg_scalar(gradient_norm_sq) +
            " current_torque_apm=" +
            format_gpu_relax_ncg_scalar(current_torque_apm) +
            " torque_tolerance_apm=" +
            format_gpu_relax_ncg_scalar(torque_tolerance_apm) +
            " torque_confirmation_count=" + std::to_string(
                ctx.stage_completion.relax_torque_confirmation_count);
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "exhausted Armijo line search",
            original_error,
            error);
    }

    const double accepted_energy_delta_upper_j =
        armijo_state.accepted_difference.delta_joules +
        armijo_state.accepted_difference.roundoff_bound_joules;
    const double armijo_increment_rhs_j =
        armijo_state.accepted_increment_rhs_j;
    if (!std::isfinite(accepted_energy_delta_upper_j) ||
        !std::isfinite(armijo_increment_rhs_j) ||
        !(accepted_energy_delta_upper_j <= armijo_increment_rhs_j &&
          armijo_increment_rhs_j <= 0.0)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted Armijo proof validation failure",
            "GPU nonlinear-CG accepted Armijo proof is invalid",
            error);
    }

    const uint64_t accepted_step = ctx.relaxation.accepted_steps + 1u;
    if (!gpu_relax_compute_accepted_gradient_norm_and_pr_plus_numerator(
            ctx,
            stream,
            n,
            blocks,
            reason) ||
        !gpu_relax_update_next_direction(
            ctx,
            stream,
            n,
            blocks,
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

    mark_gpu_relax_ncg_device_source_of_truth(ctx);
    gpu.rk.fsal_valid = false;
    ctx.relaxation.step_size =
        std::clamp(trial_step, kMinStepSize, kMaxStepSize);
    ctx.relaxation.accepted_steps = accepted_step;
    ctx.state.step_count += 1;
    ctx.state.current_time = 0.0;

    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = 0.0;
    out_stats.rejected_attempts = backtracks;
    out_stats.rhs_evaluations =
        logical_rhs_evaluations + refinement_rhs_evaluations;
    double ncg_tail_scalars[kNcgScalarTailCount] = {0.0, 0.0, 0.0};
    if (inject_nonlinear_cg_failure(
            ctx,
            GpuRelaxNcgFailurePoint::DuringAcceptedStatistics,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step stats finalization failure",
            reason,
            error);
    }
    if (!gpu_rk_finalize_step_stats_control_readback_with_scalar_tail(
            ctx,
            out_stats,
            ncg_tail_scalars,
            kNcgScalarTailCount,
            reason)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step stats finalization failure",
            reason,
            error);
    }
    const double accepted_gradient_norm_sq =
        ncg_tail_scalars[kNcgAcceptedGradientNormTailSlot];
    const double previous_gradient_energy_norm_sq =
        ncg_tail_scalars[kNcgPreviousGradientEnergyNormTailSlot];
    const double pr_plus_numerator =
        ncg_tail_scalars[kNcgPrPlusNumeratorTailSlot];
    if (!std::isfinite(accepted_gradient_norm_sq) ||
        accepted_gradient_norm_sq < 0.0) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step gradient validation failure",
            "GPU nonlinear-CG produced a non-finite or negative accepted tangent-gradient norm",
            error);
    }
    if (!std::isfinite(pr_plus_numerator)) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step PR+ validation failure",
            "GPU nonlinear-CG produced a non-finite PR+ numerator",
            error);
    }
    if (!std::isfinite(previous_gradient_energy_norm_sq) ||
        previous_gradient_energy_norm_sq < 0.0) {
        return gpu_relax_restore_previous_state_after_failure(
            ctx,
            stream,
            rollback,
            "accepted-step PR+ denominator validation failure",
            "GPU nonlinear-CG produced a non-finite or negative energy-metric PR+ denominator",
            error);
    }
    gpu.relaxation.nonlinear_cg_direction_valid =
        accepted_gradient_norm_sq > 0.0;
    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = 0.0;
    out_stats.max_rhs_amplitude = 0.0;
    out_stats.rejected_attempts = backtracks;
    out_stats.rhs_evaluations =
        logical_rhs_evaluations + refinement_rhs_evaluations;
    ctx.relaxation.accepted_energy_proof.available = true;
    ctx.relaxation.accepted_energy_proof.delta_j =
        armijo_state.accepted_difference.delta_joules;
    ctx.relaxation.accepted_energy_proof.roundoff_bound_j =
        armijo_state.accepted_difference.roundoff_bound_joules;
    ctx.relaxation.accepted_energy_proof.delta_upper_j =
        accepted_energy_delta_upper_j;
    ctx.relaxation.accepted_energy_proof.armijo_rhs_j =
        armijo_increment_rhs_j;
    publish_ncg_accepted_evaluation(
        ctx, accepted_step, accepted_snapshot, accepted_refined);
    gpu.fields.accepted_observables_valid = true;
    gpu.fields.accepted_observables_step = ctx.state.step_count;
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = "GPU nonlinear-CG relaxation requires FULLMAG_HAS_CUDA_RUNTIME=1";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
