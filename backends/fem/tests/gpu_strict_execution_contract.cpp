#include "context.hpp"
#include "backend_handle.hpp"
#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <array>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <string>
#include <tuple>
#include <vector>

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
    ctx.gpu_state.device.residency.source_of_truth =
        FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    ctx.gpu_state.device.residency.host_state = FemGpuSyncState::HostClean;
    ctx.gpu_state.device.residency.device_state = FemGpuSyncState::DeviceClean;
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

// docs/physics/0997: the required linear-solve bit follows the realization
// the device Poisson workspace resolved, and the C ABI reports it.
void planner_requires_the_resolved_linear_solve_operator()
{
#if FULLMAG_HAS_MFEM_STACK
    const uint64_t demag_family =
        FEM_GPU_OPERATOR_DEMAG_RHS |
        FEM_GPU_OPERATOR_DEMAG_SOLVE |
        FEM_GPU_OPERATOR_DEMAG_RECOVERY;
    // The planner only reads whether a factor exists; this placeholder is never
    // dereferenced, and its deleter does nothing.
    static int factor_placeholder = 0;
    uint64_t required_masks[2] = {0, 0};
    for (const bool direct : {false, true}) {
        fullmag_fem_backend backend{};
        Context &ctx = backend.context;
        make_exchange_context_ready(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
        ctx.demag.enabled = true;
        ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
        GpuDemagPoissonWorkspace workspace{};
        workspace.ready = true;
        if (direct) {
            workspace.direct_solver = std::shared_ptr<GpuDemagCudssDirectSolver>(
                reinterpret_cast<GpuDemagCudssDirectSolver *>(&factor_placeholder),
                [](GpuDemagCudssDirectSolver *) {});
        }
        ctx.poisson_demag.gpu_workspace = &workspace;

        const GpuDemagPoissonLinearSolver expected_solver = direct
            ? GpuDemagPoissonLinearSolver::CudssDirect
            : GpuDemagPoissonLinearSolver::HypreKrylov;
        check(gpu_demag_poisson_linear_solver(ctx) == expected_solver,
              "device Poisson workspace must report its linear-solve realization");
        uint32_t abi_solver = 99;
        check(fullmag_fem_backend_get_gpu_demag_linear_solver_v1(&backend, &abi_solver) ==
                  FULLMAG_FEM_OK,
              "linear-solver query must cross the ABI");
        check(abi_solver == (direct ? FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_CUDSS_DIRECT
                                    : FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_HYPRE_KRYLOV),
              "public linear-solver value must match the workspace realization");

        std::string reason;
        const GpuRkPlan plan = gpu_rk_plan_device_resident(ctx, reason);
        const uint64_t expected_bit =
            direct ? FEM_GPU_OPERATOR_DIRECT_SOLVE : FEM_GPU_OPERATOR_PRECONDITIONER;
        const uint64_t excluded_bit =
            direct ? FEM_GPU_OPERATOR_PRECONDITIONER : FEM_GPU_OPERATOR_DIRECT_SOLVE;
        check(plan.enabled, "ready device Poisson plan must be enabled");
        check((plan.required_operator_mask & (demag_family | expected_bit)) ==
                  (demag_family | expected_bit),
              "plan must require the demag family and the resolved linear-solve bit");
        check((plan.required_operator_mask & excluded_bit) == 0,
              "plan must not require the other linear-solve realization");
        check(plan.resolved_device_operator_mask == plan.required_operator_mask,
              "resolved linear solve must resolve to device");
        check(gpu_rk_plan_is_strict_device_resident(plan, reason),
              "both linear-solve realizations must pass strict validation");

        resolve_receipt_from_plan(
            ctx.gpu_state.execution_receipt, plan, ctx.base_plan.integrator);
        gpu_execution_receipt_begin_attempt(ctx.gpu_state.execution_receipt);
        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            plan.required_operator_mask);
        gpu_execution_receipt_commit_attempt(ctx.gpu_state.execution_receipt);
        const auto receipt = gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
        check(receipt.accounting_valid && receipt.accepted_step_count == 1,
              "resolved linear-solve receipt must commit");
        check((receipt.executed_device_operator_mask & expected_bit) != 0 &&
                  (receipt.executed_device_operator_mask & excluded_bit) == 0,
              "receipt must publish only the linear solve that ran");
        required_masks[direct ? 1 : 0] = receipt.required_operator_mask;
        ctx.poisson_demag.gpu_workspace = nullptr;
    }
    check(required_masks[0] != required_masks[1],
          "Krylov and direct solves must produce distinct receipts");

    fullmag_fem_backend unavailable{};
    make_exchange_context_ready(unavailable.context, FULLMAG_FEM_INTEGRATOR_HEUN);
    unavailable.context.demag.enabled = true;
    unavailable.context.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON;
    uint32_t abi_solver = 99;
    check(fullmag_fem_backend_get_gpu_demag_linear_solver_v1(&unavailable, &abi_solver) ==
                  FULLMAG_FEM_OK &&
              abi_solver == FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_UNAVAILABLE,
          "hybrid CPU Poisson has no device linear-solve realization");
    check(fullmag_fem_backend_get_gpu_demag_linear_solver_v1(&unavailable, nullptr) ==
              FULLMAG_FEM_ERR_INVALID,
          "linear-solver query must reject a null output");
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

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
struct PeriodicHexMeshFixture {
    std::vector<double> nodes_xyz;
    std::vector<uint32_t> cell_types;
    std::vector<uint32_t> cell_offsets;
    std::vector<uint32_t> cell_nodes;
    std::vector<uint32_t> cell_markers;
    std::vector<uint64_t> cell_global_ordinals;
    std::vector<uint32_t> facet_types;
    std::vector<uint32_t> facet_roles;
    std::vector<uint32_t> facet_offsets;
    std::vector<uint32_t> facet_nodes;
    std::vector<uint32_t> facet_markers;
    std::vector<uint64_t> facet_global_ordinals;
    std::vector<uint32_t> periodic_node_pairs;
    std::vector<uint32_t> periodic_boundary_pair_markers;
    std::vector<double> initial_m;

    PeriodicHexMeshFixture(bool periodic_x, bool periodic_y)
    {
        // 2x2x1 grid of HEX8 cells (18 nodes): open z=0/z=1 faces retain
        // singleton interior nodes (1,1,0) and (1,1,1) outside both X and Y
        // periodic seams so 2D-periodic pure Neumann has a valid gauge pin.
        constexpr int nx = 2;
        constexpr int ny = 2;
        constexpr int nz = 1;
        constexpr double h = 8.0e-9;
        auto node_id = [&](int ix, int iy, int iz) -> uint32_t {
            return static_cast<uint32_t>((iz * (ny + 1) + iy) * (nx + 1) + ix);
        };
        for (int iz = 0; iz <= nz; ++iz) {
            for (int iy = 0; iy <= ny; ++iy) {
                for (int ix = 0; ix <= nx; ++ix) {
                    nodes_xyz.push_back(ix * h);
                    nodes_xyz.push_back(iy * h);
                    nodes_xyz.push_back(iz * h);
                    // Non-uniform unit magnetization so demag RHS is non-zero.
                    const double mx = (ix == 1) ? 0.6 : 0.8;
                    const double my = (ix == 1) ? 0.8 : 0.6;
                    initial_m.push_back(mx);
                    initial_m.push_back(my);
                    initial_m.push_back(0.0);
                }
            }
        }
        cell_offsets.push_back(0u);
        for (int cz = 0; cz < nz; ++cz) {
            for (int cy = 0; cy < ny; ++cy) {
                for (int cx = 0; cx < nx; ++cx) {
                    cell_global_ordinals.push_back(cell_types.size());
                    cell_types.push_back(FULLMAG_FEM_CELL_HEX8);
                    cell_markers.push_back(1u);
                    const uint32_t verts[8] = {
                        node_id(cx, cy, cz),         node_id(cx + 1, cy, cz),
                        node_id(cx + 1, cy + 1, cz), node_id(cx, cy + 1, cz),
                        node_id(cx, cy, cz + 1),     node_id(cx + 1, cy, cz + 1),
                        node_id(cx + 1, cy + 1, cz + 1), node_id(cx, cy + 1, cz + 1),
                    };
                    cell_nodes.insert(cell_nodes.end(), verts, verts + 8);
                    cell_offsets.push_back(static_cast<uint32_t>(cell_nodes.size()));
                }
            }
        }
        facet_offsets.push_back(0u);
        auto add_quad = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d, uint32_t marker) {
            facet_global_ordinals.push_back(facet_types.size());
            facet_types.push_back(FULLMAG_FEM_FACET_QUAD4);
            facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR);
            facet_markers.push_back(marker);
            facet_nodes.push_back(a);
            facet_nodes.push_back(b);
            facet_nodes.push_back(c);
            facet_nodes.push_back(d);
            facet_offsets.push_back(static_cast<uint32_t>(facet_nodes.size()));
        };
        const uint32_t x_min_marker = periodic_x ? 101u : 99u;
        const uint32_t x_max_marker = periodic_x ? 102u : 99u;
        const uint32_t y_min_marker = periodic_y ? 103u : 99u;
        const uint32_t y_max_marker = periodic_y ? 104u : 99u;
        for (int cy = 0; cy < ny; ++cy) {
            for (int cx = 0; cx < nx; ++cx) {
                add_quad(node_id(cx, cy, 0), node_id(cx, cy + 1, 0),
                         node_id(cx + 1, cy + 1, 0), node_id(cx + 1, cy, 0), 99u);
                add_quad(node_id(cx, cy, nz), node_id(cx + 1, cy, nz),
                         node_id(cx + 1, cy + 1, nz), node_id(cx, cy + 1, nz), 99u);
            }
        }
        for (int cz = 0; cz < nz; ++cz) {
            for (int cx = 0; cx < nx; ++cx) {
                add_quad(node_id(cx, 0, cz), node_id(cx + 1, 0, cz),
                         node_id(cx + 1, 0, cz + 1), node_id(cx, 0, cz + 1), y_min_marker);
                add_quad(node_id(cx, ny, cz), node_id(cx, ny, cz + 1),
                         node_id(cx + 1, ny, cz + 1), node_id(cx + 1, ny, cz), y_max_marker);
            }
        }
        for (int cz = 0; cz < nz; ++cz) {
            for (int cy = 0; cy < ny; ++cy) {
                add_quad(node_id(0, cy, cz), node_id(0, cy, cz + 1),
                         node_id(0, cy + 1, cz + 1), node_id(0, cy + 1, cz), x_min_marker);
                add_quad(node_id(nx, cy, cz), node_id(nx, cy + 1, cz),
                         node_id(nx, cy + 1, cz + 1), node_id(nx, cy, cz + 1), x_max_marker);
            }
        }
        if (periodic_x) {
            periodic_boundary_pair_markers.push_back(101u);
            periodic_boundary_pair_markers.push_back(102u);
            for (int iz = 0; iz <= nz; ++iz) {
                for (int iy = 0; iy <= ny; ++iy) {
                    periodic_node_pairs.push_back(node_id(0, iy, iz));
                    periodic_node_pairs.push_back(node_id(nx, iy, iz));
                }
            }
        }
        if (periodic_y) {
            periodic_boundary_pair_markers.push_back(103u);
            periodic_boundary_pair_markers.push_back(104u);
            for (int iz = 0; iz <= nz; ++iz) {
                for (int ix = 0; ix <= nx; ++ix) {
                    periodic_node_pairs.push_back(node_id(ix, 0, iz));
                    periodic_node_pairs.push_back(node_id(ix, ny, iz));
                }
            }
        }
    }

    fullmag_fem_plan_desc_v5 make_plan_v5(uint32_t gpu_strategy) const
    {
        fullmag_fem_plan_desc p{};
        p.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        p.mesh.struct_size = sizeof(p.mesh);
        p.mesh.nodes_xyz = nodes_xyz.data();
        p.mesh.nodes_xyz_len = nodes_xyz.size();
        p.mesh.cell_types = cell_types.data();
        p.mesh.cell_types_len = cell_types.size();
        p.mesh.cell_offsets = cell_offsets.data();
        p.mesh.cell_offsets_len = cell_offsets.size();
        p.mesh.cell_nodes = cell_nodes.data();
        p.mesh.cell_nodes_len = cell_nodes.size();
        p.mesh.cell_markers = cell_markers.data();
        p.mesh.cell_markers_len = cell_markers.size();
        p.mesh.cell_global_ordinals = cell_global_ordinals.data();
        p.mesh.cell_global_ordinals_len = cell_global_ordinals.size();
        p.mesh.facet_types = facet_types.data();
        p.mesh.facet_types_len = facet_types.size();
        p.mesh.facet_roles = facet_roles.data();
        p.mesh.facet_roles_len = facet_roles.size();
        p.mesh.facet_offsets = facet_offsets.data();
        p.mesh.facet_offsets_len = facet_offsets.size();
        p.mesh.facet_nodes = facet_nodes.data();
        p.mesh.facet_nodes_len = facet_nodes.size();
        p.mesh.facet_markers = facet_markers.data();
        p.mesh.facet_markers_len = facet_markers.size();
        p.mesh.facet_global_ordinals = facet_global_ordinals.data();
        p.mesh.facet_global_ordinals_len = facet_global_ordinals.size();
        if (!periodic_node_pairs.empty()) {
            p.mesh.periodic_node_pairs = periodic_node_pairs.data();
            p.mesh.periodic_node_pairs_len = periodic_node_pairs.size();
        }
        if (!periodic_boundary_pair_markers.empty()) {
            p.mesh.periodic_boundary_pair_markers = periodic_boundary_pair_markers.data();
            p.mesh.periodic_boundary_pair_markers_len = periodic_boundary_pair_markers.size();
        }
        p.material = {8.0e5, 1.3e-11, 0.1, 2.211e5};
        p.fe_order = 1;
        p.hmax = 8.0e-9;
        p.precision = FULLMAG_FEM_PRECISION_DOUBLE;
        p.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
        p.enable_exchange = 1;
        p.enable_demag = 1;
        p.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
        p.poisson_boundary_marker = 99;
        p.robin_beta_mode = 2;
        p.robin_beta_factor = 2.0;
        p.initial_magnetization_xyz = initial_m.data();
        p.initial_magnetization_len = initial_m.size();
        p.dt_seconds = 1.0e-15;
        p.eager_initial_effective_field = 1;
        p.mfem_device_string = "cuda";
        p.gpu_device_index = 0;
        p.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
        p.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
        p.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_AMG;
        p.demag_solver.relative_tolerance = 1.0e-8;
        p.demag_solver.max_iterations = 1000;

        fullmag_fem_plan_desc_v2 v2{};
        v2.abi_version = FULLMAG_FEM_PLAN_DESC_V2_ABI_VERSION;
        v2.struct_size = sizeof(v2);
        v2.base = p;

        fullmag_fem_plan_desc_v3 v3{};
        v3.abi_version = FULLMAG_FEM_PLAN_DESC_V3_ABI_VERSION;
        v3.struct_size = sizeof(v3);
        v3.base = v2;

        fullmag_fem_plan_desc_v4 v4{};
        v4.abi_version = FULLMAG_FEM_PLAN_DESC_V4_ABI_VERSION;
        v4.struct_size = sizeof(v4);
        v4.base = v3;
        v4.poisson_boundary_marker = 99u;
        v4.reserved = 0u;

        fullmag_fem_plan_desc_v5 v5{};
        v5.abi_version = FULLMAG_FEM_PLAN_DESC_V5_ABI_VERSION;
        v5.struct_size = sizeof(v5);
        v5.gpu_demag_solver_strategy = gpu_strategy;
        v5.reserved = 0u;
        v5.base = v4;
        return v5;
    }
};

void public_create_v6_strategy_vram_and_pbc_cudss_contract()
{
    auto clear_env = []() {
        check(unsetenv(kDemagGpuDirectSolverEnv) == 0, "unset direct solver env");
        check(unsetenv(kDemagCudssDeviceBudgetCapEnv) == 0, "unset byte cap env");
        check(unsetenv(kDemagCudssMaxVramMibEnv) == 0, "unset MiB cap env");
    };
    clear_env();

    // 1. ABI validation of create_v6 and provenance_v1 query.
    check(fullmag_fem_backend_create_v6(nullptr, nullptr) == nullptr,
          "create_v6 must reject null plan");
    PeriodicHexMeshFixture open_mesh(false, false);
    {
        auto bad = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        bad.abi_version = FULLMAG_FEM_PLAN_DESC_V4_ABI_VERSION;
        check(fullmag_fem_backend_create_v6(&bad, nullptr) == nullptr,
              "create_v6 must reject mismatched abi_version");
        bad = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        bad.struct_size -= 1u;
        check(fullmag_fem_backend_create_v6(&bad, nullptr) == nullptr,
              "create_v6 must reject mismatched struct_size");
        bad = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        bad.reserved = 1u;
        check(fullmag_fem_backend_create_v6(&bad, nullptr) == nullptr,
              "create_v6 must reject nonzero reserved");
        bad = open_mesh.make_plan_v5(99u);
        check(fullmag_fem_backend_create_v6(&bad, nullptr) == nullptr,
              "create_v6 must reject unsupported gpu_demag_solver_strategy");
        bad = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        bad.base.reserved = 1u;
        check(fullmag_fem_backend_create_v6(&bad, nullptr) == nullptr,
              "create_v6 must reject nonzero inner v4 reserved");
    }
    {
        fullmag_fem_backend dummy{};
        fullmag_fem_gpu_demag_linear_solver_provenance_v1 prov{};
        check(fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1(nullptr, &prov) ==
                  FULLMAG_FEM_ERR_INVALID,
              "provenance_v1 query must reject null handle");
        check(fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1(&dummy, nullptr) ==
                  FULLMAG_FEM_ERR_INVALID,
              "provenance_v1 query must reject null output");
    }

    int cuda_device_count = 0;
    if (cudaGetDeviceCount(&cuda_device_count) != cudaSuccess || cuda_device_count <= 0) {
        return;
    }

    using Handle = std::unique_ptr<fullmag_fem_backend, decltype(&fullmag_fem_backend_destroy)>;
    auto run_strict_step_and_check_bit = [](fullmag_fem_backend *handle, uint64_t expected_bit,
                                            uint64_t excluded_bit) {
        check(fullmag_fem_backend_set_gpu_execution_request_v1(
                  handle, FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE) == FULLMAG_FEM_OK,
              "strict GPU execution request must succeed");
        fullmag_fem_step_stats stats{};
        check(fullmag_fem_backend_step(handle, 1.0e-15, &stats) == FULLMAG_FEM_OK,
              "strict GPU step must succeed");
        fullmag_fem_gpu_execution_receipt_v1 receipt{};
        receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
        receipt.struct_size = sizeof(receipt);
        check(fullmag_fem_backend_gpu_execution_receipt_v1(handle, &receipt) == FULLMAG_FEM_OK,
              "strict GPU receipt query must succeed");
        check((receipt.executed_device_operator_mask & expected_bit) != 0 &&
                  (receipt.executed_device_operator_mask & excluded_bit) == 0 &&
                  receipt.executed_host_operator_mask == 0 &&
                  receipt.fallback_count == 0,
              "strict GPU receipt must record only the resolved linear-solve operator bit");
    };

    // 2. CG_AMG passed to create_v6 NEVER factorizes cuDSS during create.
    {
        const auto plan = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        Handle handle(fullmag_fem_backend_create_v6(&plan, nullptr), fullmag_fem_backend_destroy);
        check(handle != nullptr, "create_v6 with CG_AMG must succeed");
        fullmag_fem_gpu_demag_linear_solver_provenance_v1 prov{};
        check(fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1(handle.get(), &prov) ==
                  FULLMAG_FEM_OK,
              "provenance query for CG_AMG must succeed");
        check(prov.requested_strategy == FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG &&
                  prov.resolved_linear_solver == FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_HYPRE_KRYLOV &&
                  prov.fallback_reason == FULLMAG_FEM_GPU_DEMAG_FALLBACK_NONE &&
                  prov.estimated_device_peak_bytes == 0 && prov.factor_nnz == 0,
              "CG_AMG at create_v6 must never initialize cuDSS");
        run_strict_step_and_check_bit(
            handle.get(), FEM_GPU_OPERATOR_PRECONDITIONER, FEM_GPU_OPERATOR_DIRECT_SOLVE);
    }

    // 3. Over-budget caps at create_v6: CUDSS fails hard, AUTO falls back cleanly.
    check(setenv(kDemagCudssDeviceBudgetCapEnv, "1", 1) == 0, "set tight byte cap");
    check(setenv(kDemagCudssMaxVramMibEnv, "1", 1) == 0, "set MiB cap");
    {
        const auto forced = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CUDSS);
        check(fullmag_fem_backend_create_v6(&forced, nullptr) == nullptr,
              "create_v6 with forced CUDSS over budget must fail hard during create");

        const auto auto_plan = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        Handle handle(fullmag_fem_backend_create_v6(&auto_plan, nullptr),
                      fullmag_fem_backend_destroy);
        check(handle != nullptr, "create_v6 with AUTO over budget must fall back cleanly");
        fullmag_fem_gpu_demag_linear_solver_provenance_v1 prov{};
        check(fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1(handle.get(), &prov) ==
                  FULLMAG_FEM_OK,
              "provenance query for AUTO fallback must succeed");
        check(prov.requested_strategy == FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO &&
                  prov.resolved_linear_solver == FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_HYPRE_KRYLOV &&
                  prov.factor_nnz == 0,
              "AUTO over budget must resolve to HYPRE Krylov without factorizing");
#if FULLMAG_FEM_CUDSS_POISSON_ENABLED
        check(prov.fallback_reason ==
                      FULLMAG_FEM_GPU_DEMAG_FALLBACK_CUDSS_FACTOR_EXCEEDS_VRAM_BUDGET &&
                  prov.device_budget_bytes == 1 && prov.estimated_device_peak_bytes > 1,
              "AUTO over budget must record CudssFactorExceedsVramBudget with 1-byte cap");
#else
        check(prov.fallback_reason == FULLMAG_FEM_GPU_DEMAG_FALLBACK_CUDSS_UNAVAILABLE,
              "AUTO without cuDSS build must record CudssUnavailable");
#endif
        run_strict_step_and_check_bit(
            handle.get(), FEM_GPU_OPERATOR_PRECONDITIONER, FEM_GPU_OPERATOR_DIRECT_SOLVE);
    }

    // 4. Malformed MAX_VRAM_MIB fails hard in create_v6 even under AUTO.
    clear_env();
    check(setenv(kDemagCudssMaxVramMibEnv, "0", 1) == 0, "set invalid MAX_VRAM_MIB");
    {
        const auto auto_plan = open_mesh.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        check(fullmag_fem_backend_create_v6(&auto_plan, nullptr) == nullptr,
              "malformed MAX_VRAM_MIB must fail hard in create_v6 even under AUTO");
    }
    clear_env();

#if FULLMAG_FEM_CUDSS_POISSON_ENABLED
    // 5. Open, 1D-periodic Robin, and 2D-periodic film (singleton pin) under AUTO
    //    all resolve cleanly to CUDSS_DIRECT and commit strict GPU receipts.
    for (const auto &[px, py, label] : std::array<std::tuple<bool, bool, const char *>, 3>{
             {{false, false, "open_robin"},
              {true, false, "pbc_1d_robin"},
              {true, true, "pbc_2d_film_pin"}}}) {
        PeriodicHexMeshFixture fixture(px, py);
        const auto plan = fixture.make_plan_v5(FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);
        Handle handle(fullmag_fem_backend_create_v6(&plan, nullptr), fullmag_fem_backend_destroy);
        check(handle != nullptr,
              (std::string("create_v6 AUTO must succeed for ") + label).c_str());
        if (px && py) {
            check(handle->context.poisson_demag.robin_effective_beta == 0.0,
                  "2D-periodic film must use pure Neumann beta=0 with singleton gauge pin");
        }
        fullmag_fem_gpu_demag_linear_solver_provenance_v1 prov{};
        check(fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1(handle.get(), &prov) ==
                  FULLMAG_FEM_OK,
              "provenance query for AUTO cuDSS must succeed");
        check(prov.requested_strategy == FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO &&
                  prov.resolved_linear_solver == FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_CUDSS_DIRECT &&
                  prov.fallback_reason == FULLMAG_FEM_GPU_DEMAG_FALLBACK_NONE &&
                  prov.factor_nnz > 0,
              (std::string("AUTO must resolve to CUDSS_DIRECT for ") + label).c_str());
        run_strict_step_and_check_bit(
            handle.get(), FEM_GPU_OPERATOR_DIRECT_SOLVE, FEM_GPU_OPERATOR_PRECONDITIONER);
    }
#endif
}
#endif

} // namespace

int main()
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
    planner_covers_every_explicit_rk_integrator();
    planner_tracks_local_fields_and_direct_torques();
    planner_proves_strict_device_hypre_and_rejects_hybrid_host_unknown();
    planner_requires_the_resolved_linear_solve_operator();
    final_reduction_owner_and_lifecycle_preserve_last_commit();
    strict_transfer_audit_rejects_compute_traffic_only();
    public_execution_request_rejects_invalid_values();
    public_strict_hybrid_rejects_before_preflight_attempt();
    public_compatibility_hybrid_remains_executable();
    public_strict_device_resident_remains_executable();
    public_create_v6_strategy_vram_and_pbc_cudss_contract();
#endif
    std::printf("FEM GPU strict execution contract PASS\n");
    return 0;
}
