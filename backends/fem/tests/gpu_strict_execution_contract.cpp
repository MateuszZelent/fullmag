#include "context.hpp"
#include "backend_handle.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <string>

namespace {

using namespace fullmag::fem;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void make_exchange_context_ready(Context &ctx, fullmag_fem_integrator integrator)
{
    ctx.mesh.n_nodes = 8;
    ctx.base_plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    ctx.base_plan.integrator = integrator;
    ctx.exchange.enabled = true;
    ctx.demag.enabled = false;
    ctx.gpu_state.device.lifecycle.initialized = true;
    ctx.gpu_state.device.lifecycle.allocated = true;
    ctx.gpu_state.device.lifecycle.node_count = 8;
    ctx.gpu_state.device.lifecycle.dof_len = 24;
    ctx.gpu_state.device.lifecycle.stage_count = gpu_rk_stage_count(integrator);
    ctx.gpu_state.residency.source_of_truth =
        FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    ctx.gpu_state.residency.host_state = FemGpuSyncState::HostClean;
    ctx.gpu_state.residency.device_state = FemGpuSyncState::DeviceClean;
    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = true;
    ctx.gpu_state.legacy_exchange.lumped_mass_ready = true;
    ctx.gpu_state.device.runtime_coefficients.uploaded = true;
    ctx.gpu_state.device.legacy_exchange.uploaded = true;
    ctx.gpu_state.device.legacy_exchange.rows = 8;
    ctx.gpu_state.device.legacy_exchange.cols = 8;
    ctx.gpu_state.device.legacy_exchange.csr_row_offsets = reinterpret_cast<uint32_t *>(1);
    ctx.gpu_state.device.legacy_exchange.csr_col_indices = reinterpret_cast<uint32_t *>(1);
    ctx.gpu_state.device.legacy_exchange.csr_values = reinterpret_cast<double *>(1);
    ctx.gpu_state.device.materials.ms = reinterpret_cast<double *>(1);
    ctx.gpu_state.device.materials.alpha = reinterpret_cast<double *>(1);
    ctx.gpu_state.device.mesh_metrics.inv_lumped_mass = reinterpret_cast<double *>(1);
}

void resolve_receipt_from_plan(
    FemGpuExecutionReceiptRuntimeState &receipt,
    const GpuRkPlan &plan,
    fullmag_fem_integrator integrator)
{
    gpu_execution_receipt_resolve_plan(
        receipt,
        plan.required_operator_mask,
        plan.resolved_device_operator_mask,
        plan.resolved_host_operator_mask,
        plan.resolved_unknown_operator_mask,
        plan.execution_class,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        static_cast<uint32_t>(integrator));
}

void planner_covers_every_explicit_rk_integrator()
{
    const uint64_t baseline =
        FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_LLG_RHS |
        FEM_GPU_OPERATOR_RK_STEPPER |
        FEM_GPU_OPERATOR_REDUCTIONS;
    for (const fullmag_fem_integrator integrator : {
             FULLMAG_FEM_INTEGRATOR_HEUN,
             FULLMAG_FEM_INTEGRATOR_RK4,
             FULLMAG_FEM_INTEGRATOR_RK23_BS,
             FULLMAG_FEM_INTEGRATOR_RK45_DP54,
         }) {
        Context ctx;
        make_exchange_context_ready(ctx, integrator);
        std::string reason;
        const GpuRkPlan plan = gpu_rk_plan_device_resident(ctx, reason);
        check(plan.enabled, "qualified explicit RK plan must be enabled");
        check(plan.stage_count == gpu_rk_stage_count(integrator),
              "plan must publish the selected integrator stage count");
        check(plan.required_operator_mask == baseline,
              "every explicit RK integrator must require exchange/LLG/RK/reductions");
        check(plan.resolved_device_operator_mask == baseline,
              "strict explicit RK baseline must resolve entirely to device");
        check(gpu_rk_plan_is_strict_device_resident(plan, reason),
              "qualified explicit RK plan must pass strict validation");
    }
}

void planner_tracks_local_fields_and_direct_torques()
{
    Context local;
    make_exchange_context_ready(local, FULLMAG_FEM_INTEGRATOR_HEUN);
    local.zeeman.has_external_field = true;
    std::string reason;
    const GpuRkPlan local_plan = gpu_rk_plan_device_resident(local, reason);
    check(local_plan.enabled, "uniform Zeeman local-field plan must be executable");
    check((local_plan.required_operator_mask & FEM_GPU_OPERATOR_LOCAL_FIELDS) != 0,
          "active local field must be required");
    check((local_plan.resolved_device_operator_mask & FEM_GPU_OPERATOR_LOCAL_FIELDS) != 0,
          "active local field must resolve to device");

    Context direct;
    make_exchange_context_ready(direct, FULLMAG_FEM_INTEGRATOR_RK4);
    direct.sot.enabled = true;
    const GpuRkPlan direct_plan = gpu_rk_plan_device_resident(direct, reason);
    check(direct_plan.enabled, "prescribed SOT direct-torque plan must be executable");
    check((direct_plan.required_operator_mask & FEM_GPU_OPERATOR_DIRECT_TORQUES) != 0,
          "active direct torque must be required");
    check((direct_plan.resolved_device_operator_mask & FEM_GPU_OPERATOR_DIRECT_TORQUES) != 0,
          "active direct torque must resolve to device");
}

void planner_proves_strict_device_hypre_and_rejects_hybrid_host_unknown()
{
#if FULLMAG_HAS_MFEM_STACK
    Context strict;
    make_exchange_context_ready(strict, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    strict.demag.enabled = true;
    strict.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    GpuDemagPoissonWorkspace workspace{};
    workspace.ready = true;
    strict.poisson_demag.gpu_workspace = &workspace;
    std::string reason;
    const GpuRkPlan strict_plan = gpu_rk_plan_device_resident(strict, reason);
    const uint64_t demag_mask =
        FEM_GPU_OPERATOR_DEMAG_RHS |
        FEM_GPU_OPERATOR_DEMAG_SOLVE |
        FEM_GPU_OPERATOR_DEMAG_RECOVERY |
        FEM_GPU_OPERATOR_PRECONDITIONER;
    check(strict_plan.enabled, "ready device-Hypre demag plan must be enabled");
    check(strict_plan.execution_class == FemGpuExecutionClass::DeviceResident,
          "device-Hypre demag must resolve device-resident");
    check((strict_plan.required_operator_mask & demag_mask) == demag_mask,
          "device-Hypre plan must require the complete demag operator family");
    check((strict_plan.resolved_device_operator_mask & demag_mask) == demag_mask,
          "device-Hypre plan must resolve the complete demag family to device");
    check(gpu_rk_plan_is_strict_device_resident(strict_plan, reason),
          "ready device-Hypre demag must pass strict validation");

    Context hybrid;
    make_exchange_context_ready(hybrid, FULLMAG_FEM_INTEGRATOR_HEUN);
    hybrid.demag.enabled = true;
    hybrid.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON;
    const GpuRkPlan hybrid_plan = gpu_rk_plan_device_resident(hybrid, reason);
    check(hybrid_plan.enabled, "explicit hybrid compatibility plan must remain executable");
    check((hybrid_plan.resolved_host_operator_mask & demag_mask) == demag_mask,
          "hybrid CPU Poisson must resolve the complete demag operator family to host");
    check((hybrid_plan.resolved_device_operator_mask & demag_mask) == 0,
          "hybrid H_demag upload must not be reported as device demag recovery");
    check(!gpu_rk_plan_is_strict_device_resident(hybrid_plan, reason),
          "strict execution must reject hybrid mode");

    GpuRkPlan host_plan = hybrid_plan;
    host_plan.execution_class = FemGpuExecutionClass::DeviceResident;
    check(!gpu_rk_plan_is_strict_device_resident(host_plan, reason),
          "strict execution must reject resolved host operators");
    check(reason.find("host operator") != std::string::npos,
          "host rejection must be explicit");

    Context unavailable;
    make_exchange_context_ready(unavailable, FULLMAG_FEM_INTEGRATOR_HEUN);
    unavailable.demag.enabled = true;
    unavailable.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    const GpuRkPlan unknown_plan = gpu_rk_plan_device_resident(unavailable, reason);
    check(!unknown_plan.enabled, "missing device-Hypre workspace must disable the plan");
    check((unknown_plan.resolved_unknown_operator_mask & demag_mask) == demag_mask,
          "missing device-Hypre workspace must leave demag operators unresolved");
    check(!gpu_rk_plan_is_strict_device_resident(unknown_plan, reason),
          "strict execution must reject unresolved operators before a step");
#endif
}

void final_reduction_owner_and_lifecycle_preserve_last_commit()
{
    Context ctx;
    make_exchange_context_ready(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    std::string reason;
    const GpuRkPlan plan = gpu_rk_plan_device_resident(ctx, reason);
    resolve_receipt_from_plan(ctx.gpu_state.execution_receipt, plan, ctx.base_plan.integrator);
    gpu_execution_receipt_begin_attempt(ctx.gpu_state.execution_receipt);
    gpu_execution_receipt_note_device(
        ctx.gpu_state.execution_receipt,
        plan.required_operator_mask & ~FEM_GPU_OPERATOR_REDUCTIONS);
    gpu_rk_note_completed_final_reductions(ctx);
    gpu_execution_receipt_commit_attempt(ctx.gpu_state.execution_receipt);
    const auto accepted = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(accepted.accounting_valid && accepted.accepted_step_count == 1,
          "successful final reductions must permit one accepted commit");
    check(accepted.executed_device_operator_mask == plan.required_operator_mask,
          "final-reduction owner must complete the executed device mask");

    gpu_execution_receipt_begin_attempt(ctx.gpu_state.execution_receipt);
    gpu_execution_receipt_note_device(
        ctx.gpu_state.execution_receipt,
        plan.required_operator_mask & ~FEM_GPU_OPERATOR_REDUCTIONS);
    gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
    const auto final_stats_failed = gpu_execution_receipt_snapshot(
        ctx.gpu_state.execution_receipt);
    check(final_stats_failed.failed_attempt_count == 1,
          "failed final reductions must fail the active attempt");
    check(final_stats_failed.executed_device_operator_mask == accepted.executed_device_operator_mask,
          "failed final reductions must preserve the last accepted receipt");

    gpu_execution_receipt_begin_attempt(ctx.gpu_state.execution_receipt);
    gpu_execution_receipt_note_device(
        ctx.gpu_state.execution_receipt, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_reject_attempt(ctx.gpu_state.execution_receipt);
    const auto energy_rejected = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(energy_rejected.rejected_attempt_count == 1,
          "outer energy rejection must increment rejected attempts");
    check(energy_rejected.executed_device_operator_mask == accepted.executed_device_operator_mask,
          "outer energy rejection must preserve the last accepted receipt");

    gpu_execution_receipt_begin_attempt(ctx.gpu_state.execution_receipt);
    gpu_execution_receipt_note_device(
        ctx.gpu_state.execution_receipt, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
    const auto cancelled = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(cancelled.failed_attempt_count == 2,
          "outer cancellation/failure must increment failed attempts");
    check(cancelled.executed_device_operator_mask == accepted.executed_device_operator_mask,
          "outer cancellation/failure must preserve the last accepted receipt");
}

void strict_transfer_audit_rejects_compute_traffic_only()
{
    fullmag_fem_transfer_audit transfer{};
    std::string reason;
    check(gpu_rk_strict_transfer_audit_is_clean(transfer, reason),
          "zero compute transfer audit must permit strict commit");
    transfer.hot_loop_control_scalar_d2h_bytes = sizeof(double);
    transfer.hot_loop_control_scalar_host_sync_count = 1;
    check(gpu_rk_strict_transfer_audit_is_clean(transfer, reason),
          "bounded control-scalar readback must remain legal");
    transfer.hot_loop_compute_d2h_bytes = sizeof(double);
    check(!gpu_rk_strict_transfer_audit_is_clean(transfer, reason),
          "compute D2H transfer must reject strict commit");
}

void public_execution_request_rejects_invalid_values()
{
    fullmag_fem_backend backend{};
    check(fullmag_fem_backend_set_gpu_execution_request_v1(
              &backend,
              static_cast<fullmag_fem_gpu_execution_request_v1>(99)) == FULLMAG_FEM_ERR_INVALID,
          "public GPU execution request must reject unknown policy values");
    check(fullmag_fem_backend_set_gpu_execution_request_v1(
              nullptr,
              FULLMAG_FEM_GPU_EXECUTION_REQUEST_COMPATIBILITY) == FULLMAG_FEM_ERR_INVALID,
          "public GPU execution request must reject a null backend handle");
}

void public_strict_hybrid_rejects_before_preflight_attempt()
{
    fullmag_fem_backend backend{};
    Context &ctx = backend.context;
    make_exchange_context_ready(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    ctx.mfem_device.device_string_override = "cuda";
    ctx.demag.enabled = true;
    ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON;
    check(fullmag_fem_backend_set_gpu_execution_request_v1(
              &backend,
              FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE) == FULLMAG_FEM_OK,
          "public strict request must cross the ABI before native preflight");
    const auto before = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);

    GpuRkStepPreflight preflight{};
    std::string reason;
    const bool prepared = gpu_rk_prepare_step_preflight(
        ctx,
        tableau_for_integrator(FULLMAG_FEM_INTEGRATOR_HEUN),
        1.0e-15,
        preflight,
        reason);

    check(!prepared,
          "public strict hybrid request must reject before native preflight permits a step");
    check(reason ==
              "strict FEM GPU execution rejects explicit hybrid_cpu_poisson compatibility mode",
          "public strict hybrid rejection must preserve the stable typed diagnostic");
    const auto after = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(!gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt),
          "strict hybrid rejection must not begin an execution attempt");
    check(after.accepted_step_count == before.accepted_step_count &&
              after.rejected_attempt_count == before.rejected_attempt_count &&
              after.failed_attempt_count == before.failed_attempt_count,
          "strict hybrid rejection must leave lifecycle counters unchanged");
    check(after.executed_device_operator_mask == before.executed_device_operator_mask &&
              after.executed_host_operator_mask == before.executed_host_operator_mask &&
              after.executed_unknown_operator_mask == before.executed_unknown_operator_mask,
          "strict hybrid rejection must leave executed masks unchanged");

    fullmag_fem_step_stats stats{};
    check(fullmag_fem_backend_step(&backend, 1.0e-15, &stats) == FULLMAG_FEM_ERR_UNAVAILABLE,
          "public strict hybrid backend step must fail before opening a transaction");
    const char *backend_error = fullmag_fem_backend_last_error(&backend);
    check(backend_error != nullptr &&
              std::string(backend_error) ==
                  "strict FEM GPU execution rejects explicit hybrid_cpu_poisson compatibility mode",
          "public strict hybrid backend step must preserve the typed preflight diagnostic");
    const auto after_backend_step = gpu_execution_receipt_snapshot(
        ctx.gpu_state.execution_receipt);
    check(!gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt),
          "public strict hybrid backend step must not begin an execution attempt");
    check(after_backend_step.accepted_step_count == before.accepted_step_count &&
              after_backend_step.rejected_attempt_count == before.rejected_attempt_count &&
              after_backend_step.failed_attempt_count == before.failed_attempt_count,
          "public strict hybrid backend step must leave receipt lifecycle counters unchanged");
    check(ctx.stepper.transaction_telemetry.step_transaction_begin_count == 0u,
          "public strict hybrid backend step must reject before RkStepTransaction::begin");
}

void public_compatibility_hybrid_remains_executable()
{
    fullmag_fem_backend backend{};
    Context &ctx = backend.context;
    make_exchange_context_ready(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
    ctx.demag.enabled = true;
    ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON;
    check(fullmag_fem_backend_set_gpu_execution_request_v1(
              &backend,
              FULLMAG_FEM_GPU_EXECUTION_REQUEST_COMPATIBILITY) == FULLMAG_FEM_OK,
          "public compatibility request must cross the ABI");

    GpuRkStepPreflight preflight{};
    std::string reason;
    check(gpu_rk_prepare_step_preflight(
              ctx,
              tableau_for_integrator(FULLMAG_FEM_INTEGRATOR_RK4),
              1.0e-15,
              preflight,
              reason),
          "explicit non-strict hybrid compatibility must pass native preflight");
    const auto receipt = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(receipt.plan_resolved &&
              receipt.execution_class == FemGpuExecutionClass::HybridCpuPoisson,
          "non-strict hybrid must resolve as hybrid_cpu_poisson");
    check(!gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt),
          "preflight alone must not begin a compatibility attempt");
}

void public_strict_device_resident_remains_executable()
{
    fullmag_fem_backend backend{};
    Context &ctx = backend.context;
    make_exchange_context_ready(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    check(fullmag_fem_backend_set_gpu_execution_request_v1(
              &backend,
              FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE) == FULLMAG_FEM_OK,
          "public strict request must cross the ABI");

    GpuRkStepPreflight preflight{};
    std::string reason;
    check(gpu_rk_prepare_step_preflight(
              ctx,
              tableau_for_integrator(FULLMAG_FEM_INTEGRATOR_RK23_BS),
              1.0e-15,
              preflight,
              reason),
          "strict fully device-resident request must pass native preflight");
    const auto receipt = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(receipt.plan_resolved &&
              receipt.execution_class == FemGpuExecutionClass::DeviceResident,
          "strict fully device-resident request must resolve device_resident");
    check(!gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt),
          "strict device preflight alone must not begin an attempt");
}

} // namespace

int main()
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
    planner_covers_every_explicit_rk_integrator();
    planner_tracks_local_fields_and_direct_torques();
    planner_proves_strict_device_hypre_and_rejects_hybrid_host_unknown();
    final_reduction_owner_and_lifecycle_preserve_last_commit();
    strict_transfer_audit_rejects_compute_traffic_only();
    public_execution_request_rejects_invalid_values();
    public_strict_hybrid_rejects_before_preflight_attempt();
    public_compatibility_hybrid_remains_executable();
    public_strict_device_resident_remains_executable();
#endif
    std::printf("FEM GPU strict execution contract PASS\n");
    return 0;
}
