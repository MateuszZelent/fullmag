/* Device-resident CUDA contracts for the Fredkin-Koehler BEM apply. */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_demag_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk_snapshot.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdio>
#include <cstdlib>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

#if FULLMAG_HAS_CUDA_RUNTIME
template <typename T>
T *upload(const std::vector<T> &values) {
    T *device = nullptr;
    check(
        cudaMalloc(reinterpret_cast<void **>(&device), values.size() * sizeof(T)) == cudaSuccess,
        "CUDA test allocation");
    check(
        cudaMemcpy(device, values.data(), values.size() * sizeof(T), cudaMemcpyHostToDevice) ==
            cudaSuccess,
        "CUDA test upload");
    return device;
}

void device_bem_apply_is_device_resident() {
    const std::vector<uint32_t> near_offsets = {0u, 1u, 2u};
    const std::vector<uint32_t> near_columns = {0u, 1u};
    const std::vector<double> near_values = {2.0, 3.0};
    const std::vector<fullmag::fem::AcaHMatrixDemagBemFarBlock> far_blocks = {
        {0u, 2u, 0u, 2u, 1u, 0u, 0u},
    };
    const std::vector<double> far_u = {1.0, 2.0};
    const std::vector<double> far_v = {4.0, 5.0};
    const std::vector<uint32_t> permutation = {0u, 1u};
    const std::vector<uint32_t> boundary_tdofs = {3u, 5u};
    const std::vector<double> u1_full = {0.0, 0.0, 0.0, 1.0, 0.0, 2.0};

    uint32_t *d_near_offsets = upload(near_offsets);
    uint32_t *d_near_columns = upload(near_columns);
    double *d_near_values = upload(near_values);
    auto *d_far_blocks = upload(far_blocks);
    double *d_far_u = upload(far_u);
    double *d_far_v = upload(far_v);
    uint32_t *d_permutation = upload(permutation);
    uint32_t *d_boundary_tdofs = upload(boundary_tdofs);
    double *d_u1_full = upload(u1_full);
    double *d_output = nullptr;
    check(cudaMalloc(reinterpret_cast<void **>(&d_output), 2u * sizeof(double)) == cudaSuccess,
          "CUDA test output allocation");

    fullmag::fem::fullmag_cuda_fem_bem_apply(
        d_near_offsets,
        d_near_columns,
        d_near_values,
        d_far_blocks,
        d_far_u,
        d_far_v,
        d_permutation,
        d_boundary_tdofs,
        d_u1_full,
        d_output,
        2,
        1,
        1,
        nullptr);
    check(cudaGetLastError() == cudaSuccess, "CUDA BEM apply launch");
    check(cudaDeviceSynchronize() == cudaSuccess, "CUDA BEM apply synchronization");
    std::vector<double> output(2u, 0.0);
    check(cudaMemcpy(output.data(), d_output, 2u * sizeof(double), cudaMemcpyDeviceToHost) ==
              cudaSuccess,
          "CUDA BEM apply readback");
    check(output[0] == 16.0 && output[1] == 34.0,
          "CUDA BEM apply matches near plus low-rank reference");

    cudaFree(d_near_offsets);
    cudaFree(d_near_columns);
    cudaFree(d_near_values);
    cudaFree(d_far_blocks);
    cudaFree(d_far_u);
    cudaFree(d_far_v);
    cudaFree(d_permutation);
    cudaFree(d_boundary_tdofs);
    cudaFree(d_u1_full);
    cudaFree(d_output);
}

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
void initialize_and_apply_uses_uploaded_boundary_tdofs_without_host_fences() {
    unsetenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL");
    int device_count = 0;
    check(cudaGetDeviceCount(&device_count) == cudaSuccess && device_count > 0,
          "managed FEM/BEM GPU contract requires a CUDA device");

    auto *mesh = new mfem::Mesh(3, 4, 1, 0, 3);
    const double vertices[][3] = {
        {0.0, 0.0, 0.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    for (const auto &vertex : vertices) {
        mesh->AddVertex(vertex);
    }
    int tet[] = {0, 1, 2, 3};
    mesh->AddTet(tet, 1);
    mesh->FinalizeTetMesh(1, 0, true);

    auto *fec = new mfem::H1_FECollection(1, 3);
    auto *fes = new mfem::FiniteElementSpace(mesh, fec);
    fullmag::fem::Context ctx;
    ctx.base_plan.fe_order = 1u;
    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    ctx.mfem_context.mesh = mesh;
    ctx.mfem_context.fec = fec;
    ctx.mfem_context.fes = fes;
    ctx.mfem_context.ready = true;
    ctx.mesh.n_nodes = static_cast<uint32_t>(mesh->GetNV());
    ctx.mesh.n_elements = static_cast<uint32_t>(mesh->GetNE());
    for (int node = 0; node < mesh->GetNV(); ++node) {
        const double *vertex = mesh->GetVertex(node);
        ctx.mesh.nodes_xyz.insert(ctx.mesh.nodes_xyz.end(), vertex, vertex + 3);
    }
    ctx.mesh.cell_nodes = {0u, 1u, 2u, 3u};
    ctx.mesh.cell_types = {FULLMAG_FEM_CELL_TET4};
    ctx.mesh.cell_offsets = {0u, 4u};
    ctx.mesh.cell_global_ordinals = {0u};
    ctx.mesh.cell_markers = {1u};
    ctx.mesh.magnetic_element_mask = {1u};
    ctx.mesh.magnetic_node_mask = {1u, 1u, 1u, 1u};
    ctx.mesh.node_volumes.assign(4u, 1.0 / 24.0);
    ctx.integration_weights.mfem_lumped_mass = ctx.mesh.node_volumes;
    ctx.material_fields.material.saturation_magnetisation = 1.0;
    ctx.demag.enabled = true;
    ctx.demag.realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
    ctx.demag.solver.relative_tolerance = 1.0e-10;
    ctx.demag.solver.max_iterations = 500;
    ctx.cpu_threads.effective_omp_threads = 1;
    ctx.poisson_demag.gpu_demag_mode =
        FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM;

    std::vector<double> magnetization(12u, 0.0);
    for (size_t node = 0; node < 4u; ++node) {
        magnetization[3u * node] = 1.0;
    }
    std::string error;
    check(fullmag::fem::context_initialize_demag_fem_bem(ctx, error, 3u),
          "FEM/BEM GPU contract shared geometry/P1 workspace initialization");
    auto *cpu_workspace = fullmag::fem::demag_fem_bem_workspace(ctx);
    check(cpu_workspace != nullptr &&
              cpu_workspace->boundary_operator_build_count == 0u &&
              cpu_workspace->cpu_boundary_operator == nullptr,
          "forced GPU FEM/BEM setup must not build the dense CPU operator");
    check(fullmag::fem::gpu_state_initialize(
              ctx.gpu_state.device,
              ctx.mesh.n_nodes,
              FULLMAG_FEM_INTEGRATOR_HEUN,
              true,
              true,
              magnetization.data(),
              magnetization.size(),
              ctx.transfer_audit.audit,
              error),
          "FEM/BEM GPU contract device state initialization");
    check(fullmag::fem::gpu_state_upload_runtime_coefficients(
              ctx.gpu_state.device,
              ctx.mesh.node_volumes.data(), ctx.mesh.node_volumes.size(),
              nullptr, 0u, 1.0,
              nullptr, 0u, 0.0,
              nullptr, 0u, 0.02,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u, 1.0,
              nullptr, 0u, 0.0,
              nullptr, 0u, 0.0,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u,
              ctx.mesh.magnetic_node_mask.data(), ctx.mesh.magnetic_node_mask.size(),
              nullptr, 0u,
              nullptr, 0u,
              ctx.transfer_audit.audit,
              error),
          "FEM/BEM GPU contract runtime coefficient upload");
    const std::vector<uint32_t> exchange_row_offsets = {0u, 1u, 2u, 3u, 4u};
    const std::vector<uint32_t> exchange_col_indices = {0u, 1u, 2u, 3u};
    const std::vector<double> exchange_values(4u, 0.0);
    const std::vector<double> inverse_node_volumes(4u, 24.0);
    check(fullmag::fem::gpu_state_upload_exchange_legacy_sparse(
              ctx.gpu_state.device,
              4u,
              4u,
              exchange_row_offsets.data(), exchange_row_offsets.size(),
              exchange_col_indices.data(), exchange_col_indices.size(),
              exchange_values.data(), exchange_values.size(),
              ctx.mesh.node_volumes.data(), ctx.mesh.node_volumes.size(),
              inverse_node_volumes.data(), inverse_node_volumes.size(),
              ctx.transfer_audit.audit,
              error),
          "FEM/BEM production GPU snapshot exchange upload");
    ctx.exchange.enabled = true;
    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = true;
    ctx.gpu_state.legacy_exchange.lumped_mass_ready = true;
    const uint64_t baseline_device_bytes =
        ctx.gpu_state.device.lifecycle.device_bytes;
    check(fullmag::fem::initialize_context_gpu_demag_workspace(ctx, error),
          "FEM/BEM GPU bootstrap demag selection must accept Fredkin-Koehler");
    auto *gpu_workspace = static_cast<fullmag::fem::GpuDemagFemBemWorkspace *>(
        cpu_workspace == nullptr ? nullptr : cpu_workspace->gpu_workspace);
    check(gpu_workspace != nullptr && gpu_workspace->ready,
          "FEM/BEM GPU full initialization publishes a ready workspace");
    check(gpu_workspace->d_boundary_tdofs != nullptr,
          "FEM/BEM GPU full initialization uploads boundary true DOFs");
    check(gpu_workspace->device_bytes > 0u,
          "FEM/BEM GPU workspace accounts uploaded device bytes");
    check(gpu_workspace->stream_lease.ready,
          "FEM/BEM GPU workspace owns a prepared HYPRE stream lease");
    check(!gpu_workspace->force_independent_residual_validation,
          "FEM/BEM GPU initialization must default qualification validation to disabled");

    constexpr uint64_t demag_mask =
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_RHS |
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_SOLVE |
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_RECOVERY |
        fullmag::fem::FEM_GPU_OPERATOR_PRECONDITIONER;
    std::string plan_reason;
    const auto production_plan = fullmag::fem::gpu_rk_plan_device_resident(
        ctx, plan_reason);
    check(production_plan.enabled &&
              std::string(production_plan.demag_operator_mode) ==
                  "device_hypre_fem_bem_aca_hmatrix" &&
              (production_plan.resolved_device_operator_mask & demag_mask) == demag_mask,
          "forced FEM/BEM must publish a strict production GPU plan without Poisson fallback");
    check(fullmag::fem::context_upload_magnetization_f64(
              ctx, magnetization.data(), magnetization.size(), error) == FULLMAG_FEM_OK,
          "public FEM/BEM GPU state upload must remain device-resident");
    check(cpu_workspace->cpu_boundary_operator == nullptr,
          "public FEM/BEM GPU state upload must not construct a CPU boundary operator");
    check(ctx.poisson_demag.fresh_initial_guess_required,
          "public FEM/BEM GPU state upload must request a cold demag solve");
    const uint64_t event_waits_before_failed_cold_start =
        gpu_workspace->stream_lease.event_wait_count;
    ctx.demag.solver.max_iterations = 0;
    check(!fullmag::fem::gpu_rk_compute_demag_for_device_stage(
              ctx, ctx.gpu_state.device.magnetization.m, nullptr, error),
          "failed cold FEM/BEM dispatcher solve must fail closed");
    check(gpu_workspace->stream_lease.event_wait_count ==
              event_waits_before_failed_cold_start + 2u,
          "failed cold FEM/BEM dispatcher solve must close both HYPRE dependencies");
    check(ctx.poisson_demag.fresh_initial_guess_required,
          "failed cold FEM/BEM dispatcher solve must retain the cold-start intent");
    ctx.demag.solver.max_iterations = 500;
    const uint64_t event_waits_before_successful_cold_start =
        gpu_workspace->stream_lease.event_wait_count;
    check(fullmag::fem::gpu_rk_compute_demag_for_device_stage(
              ctx, ctx.gpu_state.device.magnetization.m, nullptr, error),
          "cold FEM/BEM dispatcher solve must succeed after upload");
    check(gpu_workspace->stream_lease.event_wait_count ==
              event_waits_before_successful_cold_start + 4u,
          "successful cold FEM/BEM dispatcher solve must enqueue two solve dependency pairs");
    check(!ctx.poisson_demag.fresh_initial_guess_required,
          "successful cold FEM/BEM dispatcher solve must clear the cold-start intent");
    fullmag::fem::gpu_execution_receipt_resolve_plan(
        ctx.gpu_state.execution_receipt,
        demag_mask,
        demag_mask,
        0u,
        0u,
        fullmag::fem::FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    const auto before = fullmag::fem::transfer_audit_snapshot(ctx);
    fullmag::fem::gpu_execution_receipt_begin_attempt(
        ctx.gpu_state.execution_receipt, before);
    ctx.transfer_audit.audit.assert_no_hot_loop_host_sync = true;
    ctx.transfer_audit.audit.assert_no_hot_loop_compute_sync = true;
    const uint64_t event_waits_before_ordinary_dispatch =
        gpu_workspace->stream_lease.event_wait_count;
    {
        fullmag::fem::TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        check(fullmag::fem::gpu_rk_compute_demag_for_device_stage(
                  ctx,
                  ctx.gpu_state.device.magnetization.m,
                  nullptr,
                  error),
              "FEM/BEM production RK dispatcher device stage");
    }
    check(gpu_workspace->boundary_operator_apply_count == 2u,
          "FEM/BEM upload cold start and ordinary dispatcher each execute the boundary operator");
    check(gpu_workspace->stream_lease.event_wait_count ==
              event_waits_before_ordinary_dispatch + 4u,
          "ordinary FEM/BEM dispatcher solve must enqueue two solve dependency pairs");
    const auto after = fullmag::fem::transfer_audit_snapshot(ctx);
    check(after.hot_loop_compute_host_sync_count ==
              before.hot_loop_compute_host_sync_count,
          "FEM/BEM GPU HYPRE event interop must not add hot-loop host fences");
    check(!ctx.transfer_audit.audit.hot_loop_violation,
          "strict FEM/BEM GPU event interop must preserve the hot-loop contract");
    check(fullmag::fem::gpu_execution_receipt_update_attempt_transfer(
              ctx.gpu_state.execution_receipt, after),
          "device-resident receipt must accept event-ordered FEM/BEM execution");
    const auto receipt = fullmag::fem::gpu_execution_receipt_snapshot(
        ctx.gpu_state.execution_receipt);
    check(receipt.accounting_valid &&
              receipt.execution_class == fullmag::fem::FemGpuExecutionClass::DeviceResident,
          "FEM/BEM strict receipt must preserve the resolved device-resident class");
    fullmag::fem::gpu_execution_receipt_commit_attempt(
        ctx.gpu_state.execution_receipt);
    fullmag_fem_step_stats snapshot_stats{};
    const uint64_t event_waits_before_snapshot =
        gpu_workspace->stream_lease.event_wait_count;
    check(fullmag::fem::gpu_rk_snapshot_current_state(ctx, snapshot_stats, error),
          "FEM/BEM production RK snapshot must reuse the FK dispatcher");
    check(ctx.gpu_state.device.fields.accepted_observables_valid,
          "FEM/BEM production snapshot must publish accepted observables");
    const auto performance =
        fullmag::fem::gpu_execution_receipt_performance_snapshot(
            ctx.gpu_state.execution_receipt);
    check(performance.compute_fence_count == 0u,
          "versioned FEM/BEM performance receipt must report zero compute fences");
    check(gpu_workspace->stream_lease.event_wait_count ==
              event_waits_before_snapshot + 4u,
          "FEM/BEM snapshot solve must enqueue two solve dependency pairs");
    check(gpu_workspace->u1_system.independent_residual_validation_count == 0u &&
              gpu_workspace->u2_system.independent_residual_validation_count == 0u,
          "ordinary converged FEM/BEM solves must skip independent residual SpMV");

    gpu_workspace->force_independent_residual_validation = true;
    const uint64_t event_waits_before_forced_validation =
        gpu_workspace->stream_lease.event_wait_count;
    check(fullmag::fem::compute_device_demag_fem_bem_for_device_stage(
              ctx,
              ctx.gpu_state.device.magnetization.m,
              nullptr,
              true,
              false,
              error),
          "forced FEM/BEM independent residual validation must execute");
    check(gpu_workspace->u1_system.independent_residual_validation_count == 1u &&
              gpu_workspace->u2_system.independent_residual_validation_count == 1u,
          "forced FEM/BEM solve must independently validate both residuals");
    check(
        gpu_workspace->stream_lease.event_wait_count ==
            event_waits_before_forced_validation + 4u,
        "forced FEM/BEM solve must retain exactly two stream dependencies per solve");

    const uint64_t event_waits_before_failed_validation =
        gpu_workspace->stream_lease.event_wait_count;
    ctx.demag.solver.max_iterations = 0;
    check(!fullmag::fem::compute_device_demag_fem_bem_for_device_stage(
              ctx,
              ctx.gpu_state.device.magnetization.m,
              nullptr,
              true,
              false,
              error),
          "invalid post-solve iteration limit must fail FEM/BEM residual validation");
    check(
        gpu_workspace->stream_lease.event_wait_count ==
            event_waits_before_failed_validation + 2u,
        "failed validation after HYPRE A*x must still close the outbound dependency");
    check(error.find("max_iterations=0") != std::string::npos,
          "failed FEM/BEM validation must report the deterministic iteration limit");
    check(error.find("norm_kind=L2") != std::string::npos,
          "failed FEM/BEM validation must report norm_kind=L2");
    ctx.demag.solver.max_iterations = 500;

    check(ctx.gpu_state.device.lifecycle.device_bytes > baseline_device_bytes,
          "FEM/BEM GPU initialization must account nested device allocations");
    check(setenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL", "1", 1) == 0,
          "FEM/BEM GPU contract enables qualification validation through the environment");
    check(fullmag::fem::context_initialize_demag_fem_bem(ctx, error, 3u),
          "FEM/BEM shared workspace reinitialization must destroy the prior GPU workspace");
    check(ctx.gpu_state.device.lifecycle.device_bytes == baseline_device_bytes,
          "FEM/BEM reinitialization must release and unaccount the prior GPU workspace");
    cpu_workspace = fullmag::fem::demag_fem_bem_workspace(ctx);
    check(cpu_workspace != nullptr &&
              cpu_workspace->boundary_operator_build_count == 0u &&
              cpu_workspace->cpu_boundary_operator == nullptr &&
              cpu_workspace->gpu_workspace == nullptr,
          "forced GPU FEM/BEM reinitialization must publish only shared geometry/P1 state");
    check(fullmag::fem::gpu_demag_fem_bem_initialize(ctx, error),
          "FEM/BEM GPU workspace must initialize after shared workspace reinitialization");
    gpu_workspace = static_cast<fullmag::fem::GpuDemagFemBemWorkspace *>(
        cpu_workspace->gpu_workspace);
    check(gpu_workspace != nullptr && gpu_workspace->d_boundary_tdofs != nullptr,
          "FEM/BEM GPU workspace must own device allocations after reinitialization");
    check(gpu_workspace->force_independent_residual_validation,
          "FEM/BEM GPU initialization must consume the qualification environment");
    check(ctx.gpu_state.device.lifecycle.device_bytes > baseline_device_bytes,
          "FEM/BEM GPU reinitialization must account exactly one nested workspace");
    unsetenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL");

    fullmag::fem::context_destroy_mfem(ctx);
    check(ctx.demag_fem_bem.workspace == nullptr && !ctx.demag_fem_bem.ready,
          "normal MFEM teardown must clear FEM/BEM shared runtime state");
    check(ctx.gpu_state.device.lifecycle.device_bytes == baseline_device_bytes,
          "normal MFEM teardown must release and unaccount the nested GPU workspace");
    fullmag::fem::context_destroy_mfem(ctx);
    check(ctx.gpu_state.device.lifecycle.device_bytes == baseline_device_bytes,
          "repeated normal MFEM teardown must not double-free or double-unaccount GPU state");
    fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
}
#endif
#endif

} // namespace

int main() {
#if FULLMAG_HAS_CUDA_RUNTIME
    device_bem_apply_is_device_resident();
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    initialize_and_apply_uses_uploaded_boundary_tdofs_without_host_fences();
#endif
#endif
    return 0;
}
