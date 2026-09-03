/* Device-resident CUDA contracts for the Fredkin-Koehler BEM apply. */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
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
    const uint64_t baseline_device_bytes =
        ctx.gpu_state.device.lifecycle.device_bytes;
    check(fullmag::fem::gpu_demag_fem_bem_initialize(ctx, error),
          "FEM/BEM GPU full initialization must accept Fredkin-Koehler");
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

    constexpr uint64_t demag_mask =
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_RHS |
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_SOLVE |
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_RECOVERY |
        fullmag::fem::FEM_GPU_OPERATOR_PRECONDITIONER;
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
    {
        fullmag::fem::TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        check(fullmag::fem::compute_device_demag_fem_bem_for_device_stage(
                  ctx,
                  ctx.gpu_state.device.magnetization.m,
                  nullptr,
                  true,
                  false,
                  error),
              "FEM/BEM GPU initialize-to-apply device stage");
    }
    check(gpu_workspace->boundary_operator_apply_count == 1u,
          "FEM/BEM GPU initialize-to-apply path executes one boundary operator");
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
    check(gpu_workspace->stream_lease.event_wait_count == 4u,
          "two FEM/BEM HYPRE solves must enqueue exactly two dependency pairs");
    check(gpu_workspace->u1_system.independent_residual_validation_count == 0u &&
              gpu_workspace->u2_system.independent_residual_validation_count == 0u,
          "ordinary converged FEM/BEM solves must skip independent residual SpMV");

    check(ctx.gpu_state.device.lifecycle.device_bytes > baseline_device_bytes,
          "FEM/BEM GPU initialization must account nested device allocations");
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
    check(ctx.gpu_state.device.lifecycle.device_bytes > baseline_device_bytes,
          "FEM/BEM GPU reinitialization must account exactly one nested workspace");

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
