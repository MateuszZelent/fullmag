/*
 * FEM C ABI facade source contract.
 *
 * This source owns the exported fullmag_fem_* ABI entrypoints, handle/global
 * error propagation, high-level backend lifetime calls, step/observe/state C
 * wrappers, ABI snapshot handle scheduling/destruction, and ABI-level
 * unavailable-path errors. It does not own Context construction internals, MFEM runtime lifecycle, interaction physics, integrator stages, or transfer-audit policy.
 */

#include "fullmag_fem.h"

#include "backend_handle.hpp"
#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/transport_stage.hpp"
#include "cpu/mfem/runtime/availability.hpp"
#include "cpu/mfem/runtime/backend_lifecycle.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/runtime/backend_step.hpp"
#include "cpu/mfem/runtime/eigen_dense.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/runtime_build_info.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "frequency_domain/driven_response_solver.hpp"
#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/linearization_state.hpp"
#include "frequency_domain/modal_gpu_krylov.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"
#include "frequency_domain/mesh_symmetry_certificate.hpp"
#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/interactions/zeeman/regional_field_kernels.cuh"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/component_transfer.hpp"
#include "gpu/cuda/transfer/snapshot_pool.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <algorithm>
#include <cctype>
#include <cmath>
#include <complex>
#include <cstddef>
#include <iterator>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <vector>

void fullmag_fem_set_global_error(const std::string &message);
void fullmag_fem_clear_global_error();
const char *fullmag_fem_get_global_error();
void fullmag_fem_set_handle_error(fullmag_fem_backend *handle, const std::string &message);

namespace {

struct DrivenResponseCAbiDemagTangentContext {
    const fullmag_fem_frequency_domain_driven_response_request *request;
    fullmag_fem_frequency_domain_apply_with_potential_callback apply_with_potential;
};

constexpr const char *kUnavailableMessage =
    "fullmag_fem native backend was built without the MFEM stack; rebuild with FULLMAG_USE_MFEM_STACK=ON and an installed MFEM toolchain";

uint32_t gpu_execution_class_to_abi(fullmag::fem::FemGpuExecutionClass execution_class) {
    switch (execution_class) {
    case fullmag::fem::FemGpuExecutionClass::Unknown:
        return FULLMAG_FEM_GPU_EXECUTION_UNKNOWN;
    case fullmag::fem::FemGpuExecutionClass::DeviceResident:
        return FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT;
    case fullmag::fem::FemGpuExecutionClass::GpuOperatorHostSolver:
        return FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER;
    case fullmag::fem::FemGpuExecutionClass::HybridCpuPoisson:
        return FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON;
    case fullmag::fem::FemGpuExecutionClass::Cpu:
        return FULLMAG_FEM_GPU_EXECUTION_CPU;
    default:
        return FULLMAG_FEM_GPU_EXECUTION_UNKNOWN;
    }
}

void apply_demag_solver_policy_to_step_stats(
    const fullmag::fem::Context &ctx,
    fullmag_fem_step_stats &stats)
{
    if (!ctx.demag.enabled ||
        ctx.demag.solver.preconditioner != FULLMAG_FEM_PRECONDITIONER_AMG) {
        stats.demag_amg_relax_type = 0;
        stats.demag_amg_coarsening = 0;
        stats.demag_amg_interpolation = 0;
        stats.demag_amg_aggressive_coarsening = 0;
        stats.demag_amg_strength_threshold = 0.0;
        stats.demag_amg_strength_threshold_is_set = 0;
        stats.demag_amg_max_levels = 0;
        stats.demag_amg_max_levels_is_set = 0;
        return;
    }
    const auto &policy = ctx.demag.amg_policy;
    stats.demag_amg_relax_type = policy.relax_type;
    stats.demag_amg_coarsening = policy.coarsening;
    stats.demag_amg_interpolation = policy.interpolation;
    stats.demag_amg_aggressive_coarsening = policy.aggressive_coarsening;
    stats.demag_amg_strength_threshold = policy.strength_threshold;
    stats.demag_amg_strength_threshold_is_set = policy.strength_threshold_is_set ? 1 : 0;
    stats.demag_amg_max_levels = policy.max_levels;
    stats.demag_amg_max_levels_is_set = policy.max_levels_is_set ? 1 : 0;
}

bool apply_device_demag_tangent_with_potential_f64(
    fullmag::fem::Context &ctx,
    const double *delta_m_xyz,
    uint64_t delta_m_len,
    double *out_delta_h_demag_xyz,
    uint64_t out_len,
    double *out_delta_phi,
    uint64_t out_phi_len,
    std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    const uint64_t node_count = static_cast<uint64_t>(ctx.mesh.n_nodes);
    const uint64_t expected_vector_len = node_count * 3ull;
    if (!ctx.gpu_state.device.lifecycle.allocated ||
        ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
        error = "device demag tangent-with-potential requires allocated strict GPU device_hypre_poisson state";
        return false;
    }
    if (delta_m_xyz == nullptr || out_delta_h_demag_xyz == nullptr || out_delta_phi == nullptr) {
        error = "device demag tangent-with-potential received null buffers";
        return false;
    }
    if (delta_m_len != expected_vector_len ||
        out_len < expected_vector_len ||
        out_phi_len != node_count) {
        error = "device demag tangent-with-potential buffer lengths must match the backend mesh";
        return false;
    }
    if (ctx.gpu_state.device.demag_poisson.poisson_solution == nullptr) {
        error = "device demag tangent-with-potential requires a device scalar-potential buffer";
        return false;
    }
    if (ctx.gpu_state.device.rk.m_stage.x == nullptr ||
        ctx.gpu_state.device.rk.m_stage.y == nullptr ||
        ctx.gpu_state.device.rk.m_stage.z == nullptr) {
        error = "device demag tangent-with-potential requires allocated GPU RK scratch for delta_m";
        return false;
    }
    if (!fullmag::fem::gpu_component_upload_aos(
            ctx.gpu_state.device.lifecycle,
            ctx.gpu_state.device.rk.m_stage,
            delta_m_xyz,
            delta_m_len,
            "frequency-domain delta_m",
            ctx.transfer_audit.audit,
            error)) {
        error = "device demag tangent-with-potential delta_m upload failed: " + error;
        return false;
    }
    const cudaError_t upload_status = cudaDeviceSynchronize();
    if (upload_status != cudaSuccess) {
        error = std::string("device demag tangent-with-potential delta_m upload synchronize failed: ") +
            cudaGetErrorString(upload_status);
        return false;
    }
    if (!fullmag::fem::compute_device_demag_for_device_stage_fresh(
            ctx,
            ctx.gpu_state.device.rk.m_stage,
            ctx.gpu_state.cuda.compute_stream,
            fullmag::fem::GpuDemagApplyRequest{
                true,
                fullmag::fem::GpuDemagEvaluationMode::FieldOnly,
                fullmag::fem::GpuDemagSolvePurpose::FrequencyTangent},
            error)) {
        error = "device demag tangent-with-potential Poisson solve failed: " + error;
        return false;
    }
    ctx.gpu_state.device.rk.fsal_valid = false;
    const cudaError_t stream_status =
        cudaStreamSynchronize(reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream));
    if (stream_status != cudaSuccess) {
        error = std::string("device demag tangent-with-potential stream synchronize failed: ") +
            cudaGetErrorString(stream_status);
        return false;
    }

    std::vector<double> delta_h_demag;
    if (!fullmag::fem::gpu_state_download_component_aos(
            ctx.gpu_state.device,
            ctx.gpu_state.device.fields.h_demag,
            delta_h_demag,
            ctx.transfer_audit.audit,
            "frequency-domain delta_H_demag",
            error)) {
        error = "device demag tangent-with-potential H_demag download failed: " + error;
        return false;
    }
    if (delta_h_demag.size() != static_cast<std::size_t>(expected_vector_len)) {
        error = "device demag tangent-with-potential H_demag download returned mismatched length";
        return false;
    }
    const double *phi_source = nullptr;
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto *workspace = fullmag::fem::workspace_ptr(ctx);
    if (workspace == nullptr || workspace->x_par == nullptr) {
        error = "device demag tangent-with-potential requires a solved Hypre true-DOF potential";
        return false;
    }
    auto *gf_potential =
        static_cast<mfem::GridFunction *>(ctx.poisson_demag.gf_potential);
    if (gf_potential == nullptr) {
        error = "device demag tangent-with-potential requires an initialized nodal scalar-potential field";
        return false;
    }
    mfem::Vector full_phi;
    full_phi.SetSize(static_cast<int>(node_count));
    const double *reduced_phi = fullmag::fem::audited_host_read(*workspace->x_par);
    if (ctx.mesh.periodic_reduced_node.size() == static_cast<std::size_t>(node_count) &&
        ctx.mesh.periodic_reduced_node_count == workspace->rhs.rows) {
        for (uint64_t node = 0; node < node_count; ++node) {
            const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<std::size_t>(node)];
            if (reduced >= ctx.mesh.periodic_reduced_node_count) {
                error = "device demag tangent-with-potential periodic scalar-potential lift map is invalid";
                return false;
            }
            full_phi[static_cast<int>(node)] = reduced_phi[static_cast<int>(reduced)];
        }
    } else if (workspace->rhs.rows == node_count) {
        for (uint64_t node = 0; node < node_count; ++node) {
            full_phi[static_cast<int>(node)] = reduced_phi[static_cast<int>(node)];
        }
    } else {
        error = "device demag tangent-with-potential cannot lift scalar potential: "
            "scalar_rows=" + std::to_string(workspace->rhs.rows) +
            " periodic_reduced_node_count=" + std::to_string(ctx.mesh.periodic_reduced_node_count) +
            " mesh_nodes=" + std::to_string(node_count);
        return false;
    }
    gf_potential->SetFromTrueDofs(full_phi);
    if (gf_potential->Size() != static_cast<int>(out_phi_len)) {
        error = "device demag tangent-with-potential recovered scalar-potential size mismatch: "
            "grid_function_size=" + std::to_string(gf_potential->Size()) +
            " out_phi_len=" + std::to_string(out_phi_len) +
            " mesh_nodes=" + std::to_string(node_count);
        return false;
    }
    phi_source = fullmag::fem::audited_host_read(*gf_potential);
#else
    error = "device demag tangent-with-potential phi recovery requires MFEM MPI true-DOF support";
    return false;
#endif
    std::memcpy(
        out_delta_h_demag_xyz,
        delta_h_demag.data(),
        static_cast<std::size_t>(sizeof(double) * expected_vector_len));
    std::memcpy(
        out_delta_phi,
        phi_source,
        static_cast<std::size_t>(sizeof(double) * out_phi_len));
    fullmag::fem::record_device_to_host(
        ctx.transfer_audit.audit,
        static_cast<uint64_t>(sizeof(double) * out_phi_len));
    return true;
#else
    (void)ctx;
    (void)delta_m_xyz;
    (void)delta_m_len;
    (void)out_delta_h_demag_xyz;
    (void)out_len;
    (void)out_delta_phi;
    (void)out_phi_len;
    error = "device demag tangent-with-potential requires CUDA runtime support";
    return false;
#endif
}

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

#ifndef FULLMAG_FEM_PETSC_VERSION
#define FULLMAG_FEM_PETSC_VERSION ""
#endif

#ifndef FULLMAG_FEM_SLEPC_VERSION
#define FULLMAG_FEM_SLEPC_VERSION ""
#endif

#ifndef FULLMAG_FEM_PETSC_PKGCONFIG_DIR
#define FULLMAG_FEM_PETSC_PKGCONFIG_DIR ""
#endif

#ifndef FULLMAG_FEM_SLEPC_PKGCONFIG_DIR
#define FULLMAG_FEM_SLEPC_PKGCONFIG_DIR ""
#endif

#ifndef FULLMAG_FEM_PETSC_FIND_MODULE_FILE
#define FULLMAG_FEM_PETSC_FIND_MODULE_FILE ""
#endif

#ifndef FULLMAG_FEM_SLEPC_FIND_MODULE_FILE
#define FULLMAG_FEM_SLEPC_FIND_MODULE_FILE ""
#endif

#ifndef FULLMAG_FEM_PETSC_LIBRARY_PATH
#define FULLMAG_FEM_PETSC_LIBRARY_PATH ""
#endif

#ifndef FULLMAG_FEM_SLEPC_LIBRARY_PATH
#define FULLMAG_FEM_SLEPC_LIBRARY_PATH ""
#endif

struct FemSnapshotPayload {
    std::vector<double> data;
    void *host_aos = nullptr;
    size_t host_aos_len_bytes = 0;
    fullmag::fem::FemGpuComponentField staging{};
    void *stream = nullptr;
    void *ready_event = nullptr;
    void *staging_done_event = nullptr;
    void *done_event = nullptr;
    std::shared_ptr<fullmag::fem::FemGpuSnapshotPoolState> pool{};
    size_t pool_slot = fullmag::fem::kFemGpuSnapshotPoolCapacity;
    bool needs_wait = false;
    fullmag_fem_snapshot_desc desc{};
};

void destroy_snapshot_payload(FemSnapshotPayload &snapshot)
{
    if (snapshot.pool) {
        fullmag::fem::gpu_snapshot_pool_release(
            *snapshot.pool,
            snapshot.pool_slot,
            !snapshot.needs_wait);
        snapshot.pool.reset();
        snapshot.pool_slot = fullmag::fem::kFemGpuSnapshotPoolCapacity;
    }
    snapshot.host_aos = nullptr;
    snapshot.host_aos_len_bytes = 0;
    snapshot.staging = {};
    snapshot.stream = nullptr;
    snapshot.ready_event = nullptr;
    snapshot.staging_done_event = nullptr;
    snapshot.done_event = nullptr;
    snapshot.needs_wait = false;
}

const fullmag::fem::FemGpuComponentField *gpu_snapshot_source_field(
    fullmag::fem::Context &context,
    fullmag_fem_observable observable)
{
    if (!context.gpu_state.device.lifecycle.allocated) {
        return nullptr;
    }
    switch (observable) {
    case FULLMAG_FEM_OBSERVABLE_M:
        return &context.gpu_state.device.magnetization.m;
    case FULLMAG_FEM_OBSERVABLE_H_EX:
        return &context.gpu_state.device.fields.h_ex;
    case FULLMAG_FEM_OBSERVABLE_H_DEMAG:
        if (context.demag.enabled &&
            context.poisson_demag.gpu_demag_mode ==
                FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
            return &context.gpu_state.device.demag_poisson.poisson_gradient;
        }
        return nullptr;
    case FULLMAG_FEM_OBSERVABLE_H_EXT:
        return &context.gpu_state.device.fields.h_ext;
    case FULLMAG_FEM_OBSERVABLE_H_ANI:
        return &context.gpu_state.device.fields.h_ani;
    case FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC:
        return &context.gpu_state.device.fields.h_cubic_ani;
    case FULLMAG_FEM_OBSERVABLE_H_DMI:
        return &context.gpu_state.device.fields.h_dmi;
    case FULLMAG_FEM_OBSERVABLE_H_DMI_BULK:
        return &context.gpu_state.device.fields.h_bulk_dmi;
    case FULLMAG_FEM_OBSERVABLE_H_OE:
        return &context.gpu_state.device.fields.h_oe;
    case FULLMAG_FEM_OBSERVABLE_H_THERM:
        return &context.gpu_state.device.fields.h_therm;
    case FULLMAG_FEM_OBSERVABLE_H_MEL:
        return &context.gpu_state.device.fields.h_mel;
    case FULLMAG_FEM_OBSERVABLE_H_EFF:
        if (!context.demag.enabled ||
            context.poisson_demag.gpu_demag_mode ==
                FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
            return &context.gpu_state.device.fields.h_eff;
        }
        return nullptr;
    case FULLMAG_FEM_OBSERVABLE_DEMAG_PHI:
        return nullptr;
    default:
        return nullptr;
    }
}

#if FULLMAG_HAS_CUDA_RUNTIME
bool prepare_gpu_full_domain_snapshot(
    fullmag_fem_backend &handle,
    fullmag_fem_observable observable)
{
    auto &context = handle.context;
    const bool needs_full_domain_demag =
        observable == FULLMAG_FEM_OBSERVABLE_H_DEMAG ||
        observable == FULLMAG_FEM_OBSERVABLE_H_EFF;
    if (!context.gpu_state.device.lifecycle.allocated ||
        !context.demag.enabled ||
        !needs_full_domain_demag ||
        context.poisson_demag.gpu_demag_mode !=
            FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
        return true;
    }
    if (!fullmag::fem::recover_device_demag_full_domain_field_device(
            context,
            context.gpu_state.cuda.compute_stream,
            handle.last_error)) {
        handle.last_error = "GPU full-domain snapshot demag recovery failed: " +
            handle.last_error;
        return false;
    }
    return true;
}

bool schedule_gpu_snapshot_payload(
    fullmag_fem_backend &handle,
    fullmag_fem_observable observable,
    FemSnapshotPayload &snapshot)
{
    auto &context = handle.context;
    const auto *source = gpu_snapshot_source_field(context, observable);
    if (source == nullptr) {
        return false;
    }
    if (source->x == nullptr || source->y == nullptr || source->z == nullptr) {
        handle.last_error = "FEM GPU snapshot requires allocated source component buffers";
        return false;
    }

    const uint64_t node_count = context.gpu_state.device.lifecycle.node_count;
    if (node_count == 0 || node_count != context.mesh.n_nodes) {
        handle.last_error = "FEM GPU snapshot node count mismatch";
        return false;
    }
    if (node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        handle.last_error = "FEM GPU snapshot node count exceeds CUDA kernel index range";
        return false;
    }
    const size_t component_bytes = static_cast<size_t>(node_count) * sizeof(double);
    snapshot.host_aos_len_bytes = component_bytes * 3u;

    auto &cuda_runtime = context.gpu_state.cuda;
    if (cuda_runtime.compute_stream == nullptr || cuda_runtime.io_stream == nullptr ||
        !cuda_runtime.snapshot_pool) {
        handle.last_error = "FEM GPU snapshot requires initialized compute and I/O streams";
        return false;
    }
    fullmag::fem::FemGpuSnapshotPoolLease lease{};
    if (!fullmag::fem::gpu_snapshot_pool_acquire(
            *cuda_runtime.snapshot_pool,
            lease,
            handle.last_error)) {
        return false;
    }
    snapshot.pool = cuda_runtime.snapshot_pool;
    snapshot.pool_slot = lease.slot_index;
    snapshot.host_aos = lease.host_aos;
    snapshot.staging = lease.staging;
    snapshot.stream = cuda_runtime.io_stream;
    snapshot.ready_event = lease.ready_event;
    snapshot.staging_done_event = lease.staging_done_event;
    snapshot.done_event = lease.done_event;
    if (cuda_runtime.snapshot_pool->component_bytes != component_bytes ||
        cuda_runtime.snapshot_pool->host_aos_bytes != snapshot.host_aos_len_bytes) {
        handle.last_error = "FEM GPU snapshot pool size does not match backend node count";
        destroy_snapshot_payload(snapshot);
        return false;
    }

    auto io_stream = reinterpret_cast<cudaStream_t>(snapshot.stream);
    auto ready_event = reinterpret_cast<cudaEvent_t>(snapshot.ready_event);
    auto staging_done_event =
        reinterpret_cast<cudaEvent_t>(snapshot.staging_done_event);
    auto done_event = reinterpret_cast<cudaEvent_t>(snapshot.done_event);
    auto cleanup_failed_submission = [&]() {
        const cudaError_t record_status = cudaEventRecord(done_event, io_stream);
        if (record_status == cudaSuccess) {
            snapshot.needs_wait = true;
            destroy_snapshot_payload(snapshot);
            return;
        }
        const cudaError_t stream_status = cudaStreamSynchronize(io_stream);
        if (stream_status == cudaSuccess || cudaDeviceSynchronize() == cudaSuccess) {
            snapshot.needs_wait = false;
            destroy_snapshot_payload(snapshot);
            return;
        }
        // Preserve safety after an unrecoverable CUDA failure: do not return
        // this slot to the pool because queued work may still reference it.
        snapshot.pool.reset();
        snapshot.pool_slot = fullmag::fem::kFemGpuSnapshotPoolCapacity;
        snapshot.needs_wait = false;
        destroy_snapshot_payload(snapshot);
    };
    auto fail = [&](const char *label, cudaError_t status) -> bool {
        handle.last_error = std::string(label) + ": " + cudaGetErrorString(status);
        cleanup_failed_submission();
        return false;
    };
    auto fail_message = [&](const char *message) -> bool {
        handle.last_error = message;
        cleanup_failed_submission();
        return false;
    };
    cudaError_t err = cudaSuccess;

    cudaStream_t compute_stream =
        reinterpret_cast<cudaStream_t>(context.gpu_state.cuda.compute_stream);
    err = cudaEventRecord(ready_event, compute_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(FEM snapshot.ready_event)", err);
    err = cudaStreamWaitEvent(io_stream, ready_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(FEM snapshot.ready_event)", err);

    err = cudaMemcpyAsync(
        snapshot.staging.x, source->x, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(FEM snapshot.x)", err);
    err = cudaMemcpyAsync(
        snapshot.staging.y, source->y, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(FEM snapshot.y)", err);
    err = cudaMemcpyAsync(
        snapshot.staging.z, source->z, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(FEM snapshot.z)", err);

    const bool compose_full_domain_h_eff =
        observable == FULLMAG_FEM_OBSERVABLE_H_EFF &&
        context.demag.enabled &&
        context.poisson_demag.gpu_demag_mode ==
            FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    if (compose_full_domain_h_eff) {
        const auto &h_demag_full = context.gpu_state.device.demag_poisson.poisson_gradient;
        const auto &h_demag_magnetic = context.gpu_state.device.fields.h_demag;
        if (h_demag_full.x == nullptr || h_demag_full.y == nullptr ||
            h_demag_full.z == nullptr || h_demag_magnetic.x == nullptr ||
            h_demag_magnetic.y == nullptr || h_demag_magnetic.z == nullptr) {
            return fail_message(
                "FEM GPU full-domain H_eff snapshot requires allocated demag component buffers");
        }
        fullmag::fem::fullmag_cuda_apply_full_domain_demag_correction(
            h_demag_full.x,
            h_demag_magnetic.x,
            snapshot.staging.x,
            static_cast<int>(node_count),
            io_stream);
        fullmag::fem::fullmag_cuda_apply_full_domain_demag_correction(
            h_demag_full.y,
            h_demag_magnetic.y,
            snapshot.staging.y,
            static_cast<int>(node_count),
            io_stream);
        fullmag::fem::fullmag_cuda_apply_full_domain_demag_correction(
            h_demag_full.z,
            h_demag_magnetic.z,
            snapshot.staging.z,
            static_cast<int>(node_count),
            io_stream);
        err = cudaGetLastError();
        if (err != cudaSuccess) return fail("launch FEM full-domain H_eff snapshot", err);
    }

    err = cudaEventRecord(staging_done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(FEM snapshot.staging_done_event)", err);
    err = cudaStreamWaitEvent(compute_stream, staging_done_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(FEM snapshot.staging_done_event)", err);

    auto *host = static_cast<double *>(snapshot.host_aos);
    const size_t host_pitch = 3u * sizeof(double);
    err = cudaMemcpy2DAsync(
        host + 0u,
        host_pitch,
        snapshot.staging.x,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(node_count),
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpy2DAsync(FEM snapshot.host_x)", err);
    err = cudaMemcpy2DAsync(
        host + 1u,
        host_pitch,
        snapshot.staging.y,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(node_count),
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpy2DAsync(FEM snapshot.host_y)", err);
    err = cudaMemcpy2DAsync(
        host + 2u,
        host_pitch,
        snapshot.staging.z,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(node_count),
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpy2DAsync(FEM snapshot.host_z)", err);

    err = cudaEventRecord(done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(FEM snapshot.done_event)", err);

    snapshot.needs_wait = true;
    return true;
}
#endif

FemSnapshotPayload *begin_snapshot_payload(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable)
{
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_begin_snapshot received null handle");
        return nullptr;
    }
    handle->last_error.clear();
#if FULLMAG_HAS_CUDA_RUNTIME
    if (!prepare_gpu_full_domain_snapshot(*handle, observable)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return nullptr;
    }
#endif
    if (observable == FULLMAG_FEM_OBSERVABLE_TORQUE &&
        !fullmag::fem::context_sync_gpu_magnetization_to_host(
            handle->context,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return nullptr;
    }

    const bool scalar_snapshot = observable == FULLMAG_FEM_OBSERVABLE_DEMAG_PHI;
    const uint32_t component_count = scalar_snapshot ? 1u : 3u;
    const uint64_t len =
        static_cast<uint64_t>(handle->context.mesh.n_nodes) *
        static_cast<uint64_t>(component_count);
    auto *snapshot = new (std::nothrow) FemSnapshotPayload();
    if (snapshot == nullptr) {
        fullmag_fem_set_handle_error(handle, "failed to allocate FEM snapshot payload");
        return nullptr;
    }

    snapshot->desc.node_count = handle->context.mesh.n_nodes;
    if (scalar_snapshot) {
        snapshot->desc.component_count = 1;
    } else {
        snapshot->desc.component_count = 3;
    }
    snapshot->desc.scalar_bytes = sizeof(double);
    snapshot->desc.scalar_type = FULLMAG_FEM_SNAPSHOT_SCALAR_F64;

#if FULLMAG_HAS_CUDA_RUNTIME
    if (schedule_gpu_snapshot_payload(*handle, observable, *snapshot)) {
        return snapshot;
    }
    if (!handle->last_error.empty()) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        delete snapshot;
        return nullptr;
    }
#endif

    if (observable == FULLMAG_FEM_OBSERVABLE_M &&
        !fullmag::fem::context_sync_gpu_magnetization_to_host(
            handle->context,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        delete snapshot;
        return nullptr;
    }

    snapshot->data.assign(static_cast<size_t>(len), 0.0);
    const int rc = fullmag::fem::context_copy_field_f64(
        handle->context,
        observable,
        snapshot->data.data(),
        len,
        handle->last_error);
    if (rc != FULLMAG_FEM_OK) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        delete snapshot;
        return nullptr;
    }
    return snapshot;
}

int wait_snapshot_payload(
    FemSnapshotPayload *snapshot,
    const void **out_data,
    uint64_t *out_len_bytes,
    fullmag_fem_snapshot_desc *out_desc)
{
    if (snapshot == nullptr || out_data == nullptr || out_len_bytes == nullptr ||
        out_desc == nullptr) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (snapshot->host_aos != nullptr) {
#if FULLMAG_HAS_CUDA_RUNTIME
        if (snapshot->needs_wait) {
            cudaError_t err =
                cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot->done_event));
            if (err != cudaSuccess) {
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            snapshot->needs_wait = false;
        }
        *out_data = snapshot->host_aos;
        *out_len_bytes = static_cast<uint64_t>(snapshot->host_aos_len_bytes);
        *out_desc = snapshot->desc;
        return FULLMAG_FEM_OK;
#else
        return FULLMAG_FEM_ERR_INTERNAL;
#endif
    }
    *out_data = snapshot->data.data();
    *out_len_bytes =
        static_cast<uint64_t>(snapshot->data.size() * sizeof(double));
    *out_desc = snapshot->desc;
    return FULLMAG_FEM_OK;
}

int snapshot_payload_ready(FemSnapshotPayload *snapshot)
{
    if (snapshot == nullptr) {
        return 0;
    }
    if (!snapshot->needs_wait || snapshot->host_aos == nullptr) {
        return 1;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    cudaError_t err = cudaEventQuery(reinterpret_cast<cudaEvent_t>(snapshot->done_event));
    if (err == cudaSuccess) {
        snapshot->needs_wait = false;
        return 1;
    }
    if (err == cudaErrorNotReady) {
        return 0;
    }
    return 0;
#else
    return 0;
#endif
}

fullmag_fem_frequency_domain_status to_abi_status(
    fullmag::fem::frequency_domain::FrequencyDomainStatus status)
{
    namespace fd = fullmag::fem::frequency_domain;
    switch (status) {
    case fd::FrequencyDomainStatus::ok:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
    case fd::FrequencyDomainStatus::unavailable:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE;
    case fd::FrequencyDomainStatus::validation_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
    case fd::FrequencyDomainStatus::operator_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    case fd::FrequencyDomainStatus::solve_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR;
    case fd::FrequencyDomainStatus::artifact_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR;
    case fd::FrequencyDomainStatus::interrupted:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED;
    }
    return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
}

fullmag::fem::frequency_domain::FrequencyDomainStatus from_abi_status(
    fullmag_fem_frequency_domain_status status)
{
    namespace fd = fullmag::fem::frequency_domain;
    switch (status) {
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK:
        return fd::FrequencyDomainStatus::ok;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE:
        return fd::FrequencyDomainStatus::unavailable;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR:
        return fd::FrequencyDomainStatus::validation_error;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR:
        return fd::FrequencyDomainStatus::operator_error;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR:
        return fd::FrequencyDomainStatus::solve_error;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR:
        return fd::FrequencyDomainStatus::artifact_error;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED:
        return fd::FrequencyDomainStatus::interrupted;
    }
    return fd::FrequencyDomainStatus::validation_error;
}

FullmagFemFrequencyDomainStatus to_frequency_domain_contract_status(
    fullmag::fem::frequency_domain::FrequencyDomainStatus status)
{
    namespace fd = fullmag::fem::frequency_domain;
    switch (status) {
    case fd::FrequencyDomainStatus::ok:
        return FULLMAG_FEM_FD_OK;
    case fd::FrequencyDomainStatus::unavailable:
        return FULLMAG_FEM_FD_UNAVAILABLE;
    case fd::FrequencyDomainStatus::validation_error:
        return FULLMAG_FEM_FD_VALIDATION_ERROR;
    case fd::FrequencyDomainStatus::operator_error:
        return FULLMAG_FEM_FD_OPERATOR_ERROR;
    case fd::FrequencyDomainStatus::solve_error:
        return FULLMAG_FEM_FD_SOLVE_ERROR;
    case fd::FrequencyDomainStatus::artifact_error:
        return FULLMAG_FEM_FD_ARTIFACT_ERROR;
    case fd::FrequencyDomainStatus::interrupted:
        return FULLMAG_FEM_FD_INTERRUPTED;
    }
    return FULLMAG_FEM_FD_VALIDATION_ERROR;
}

bool from_abi_study_kind(
    fullmag_fem_frequency_domain_study_kind study_kind,
    fullmag::fem::frequency_domain::FrequencyDomainStudyKind *out_study_kind)
{
    namespace fd = fullmag::fem::frequency_domain;
    if (out_study_kind == nullptr) {
        return false;
    }
    switch (study_kind) {
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE:
        *out_study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_EIGENMODES:
        *out_study_kind = fd::FrequencyDomainStudyKind::modal_dynamic_matrix;
        return true;
    }
    return false;
}

bool from_abi_frequency_domain_execution_lane(
    fullmag_fem_frequency_domain_execution_lane execution_lane,
    fullmag::fem::frequency_domain::DrivenFrequencyResponseExecutionLane *out_lane)
{
    namespace fd = fullmag::fem::frequency_domain;
    if (out_lane == nullptr) {
        return false;
    }
    switch (execution_lane) {
    case FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION:
        *out_lane = fd::DrivenFrequencyResponseExecutionLane::validation;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU:
        *out_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU:
        *out_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
        return true;
    }
    return false;
}

bool from_abi_frequency_domain_phase_convention(
    fullmag_fem_frequency_domain_phase_convention phase_convention,
    fullmag::fem::frequency_domain::FrequencyDomainPhaseConvention *out_phase_convention)
{
    namespace fd = fullmag::fem::frequency_domain;
    if (out_phase_convention == nullptr) {
        return false;
    }
    switch (phase_convention) {
    case FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T:
        *out_phase_convention = fd::FrequencyDomainPhaseConvention::exp_i_omega_t;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T:
        *out_phase_convention = fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t;
        return true;
    }
    return false;
}

bool from_abi_frequency_domain_drive_kind(
    fullmag_fem_frequency_domain_drive_kind drive_kind,
    fullmag::fem::frequency_domain::FrequencyDriveKind *out_drive_kind)
{
    namespace fd = fullmag::fem::frequency_domain;
    if (out_drive_kind == nullptr) {
        return false;
    }
    switch (drive_kind) {
    case FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED:
    case FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_DYNAMIC_FIELD_PHASOR_A_PER_M:
        *out_drive_kind = fd::FrequencyDriveKind::dynamic_field_phasor_a_per_m;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_TANGENT_RHS:
        *out_drive_kind = fd::FrequencyDriveKind::tangent_rhs;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_CARTESIAN_TORQUE_PHASOR:
        *out_drive_kind = fd::FrequencyDriveKind::cartesian_torque_phasor;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_STT_CURRENT_PHASOR:
        *out_drive_kind = fd::FrequencyDriveKind::stt_current_phasor;
        return true;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_COUPLED_EXTERNAL_PROVIDER:
        *out_drive_kind = fd::FrequencyDriveKind::coupled_external_provider;
        return true;
    }
    return false;
}

char *duplicate_c_string(const char *value) noexcept
{
    if (value == nullptr) {
        value = "";
    }
    const std::size_t size = std::strlen(value) + 1;
    char *copy = new (std::nothrow) char[size];
    if (copy == nullptr) {
        return nullptr;
    }
    std::memcpy(copy, value, size);
    return copy;
}

FullmagFemComplex64 *duplicate_complex_values(
    const std::vector<std::complex<double>> &values) noexcept
{
    if (values.empty()) {
        return nullptr;
    }
    auto *copy = new (std::nothrow) FullmagFemComplex64[values.size()];
    if (copy == nullptr) {
        return nullptr;
    }
    for (std::size_t index = 0; index < values.size(); ++index) {
        copy[index].real = values[index].real();
        copy[index].imag = values[index].imag();
    }
    return copy;
}

double *duplicate_double_values(const std::vector<double> &values) noexcept
{
    if (values.empty()) {
        return nullptr;
    }
    auto *copy = new (std::nothrow) double[values.size()];
    if (copy == nullptr) {
        return nullptr;
    }
    std::copy(values.begin(), values.end(), copy);
    return copy;
}

std::uint64_t *duplicate_u64_values(const std::vector<std::uint64_t> &values) noexcept
{
    if (values.empty()) {
        return nullptr;
    }
    auto *copy = new (std::nothrow) std::uint64_t[values.size()];
    if (copy == nullptr) {
        return nullptr;
    }
    std::copy(values.begin(), values.end(), copy);
    return copy;
}

void release_modal_buffers(FullmagFemFrequencyDomainResult &result) noexcept
{
    delete[] result.mode_lambda;
    delete[] result.mode_q_complex;
    delete[] result.mode_phi_complex;
    delete[] result.mode_delta_m_xyz_complex;
    delete[] result.mode_residuals;
    delete[] result.mode_cluster_ids;
    result.mode_lambda = nullptr;
    result.mode_q_complex = nullptr;
    result.mode_phi_complex = nullptr;
    result.mode_delta_m_xyz_complex = nullptr;
    result.mode_residuals = nullptr;
    result.mode_cluster_ids = nullptr;
}

bool fill_frequency_domain_validation_result(
    fullmag_fem_frequency_domain_solve_result *out_result,
    uint64_t total_frequency_count,
    const char *error_message) noexcept
{
    *out_result = {};
    out_result->status = FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
    out_result->total_frequency_count = total_frequency_count;
    out_result->completed_frequency_count = 0;
    out_result->written_frequency_point_artifacts = 0;
    out_result->error_message = duplicate_c_string(error_message);
    out_result->diagnostics_json = duplicate_c_string(
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"status\":\"validation_error\","
        "\"complete\":false}");
    out_result->result_json = duplicate_c_string(
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"validation_error\","
        "\"complete\":false}");
    out_result->artifact_manifest_path = duplicate_c_string("");
    if (out_result->error_message == nullptr ||
        out_result->diagnostics_json == nullptr ||
        out_result->result_json == nullptr ||
        out_result->artifact_manifest_path == nullptr) {
        delete[] out_result->error_message;
        delete[] out_result->diagnostics_json;
        delete[] out_result->result_json;
        delete[] out_result->artifact_manifest_path;
        *out_result = {};
        return false;
    }
    return true;
}

void copy_frequency_domain_progress(
    const fullmag::fem::frequency_domain::FrequencyDomainSweepProgress &native_progress,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
)
{
    *out_progress = {};
    out_progress->total_frequency_points = native_progress.total_frequency_points;
    out_progress->completed_frequency_points = native_progress.completed_frequency_points;
    out_progress->written_frequency_point_artifacts =
        native_progress.written_frequency_point_artifacts;
    out_progress->current_frequency_hz = native_progress.current_frequency_hz;
    out_progress->partial_artifacts_available =
        native_progress.partial_artifacts_available ? 1 : 0;
    std::snprintf(
        out_progress->latest_artifact_manifest_path,
        sizeof(out_progress->latest_artifact_manifest_path),
        "%s",
        native_progress.latest_artifact_manifest_path != nullptr
            ? native_progress.latest_artifact_manifest_path
            : "");
    std::snprintf(
        out_progress->progress_json,
        sizeof(out_progress->progress_json),
        "%s",
        native_progress.progress_json != nullptr ? native_progress.progress_json : "");
}

void copy_frequency_domain_solve_result(
    fullmag::fem::frequency_domain::DrivenFrequencyResponseSolveResult &native_result,
    fullmag_fem_frequency_domain_solve_result *out_result
)
{
    *out_result = {};
    out_result->status = to_abi_status(native_result.status);
    out_result->total_frequency_count = native_result.total_frequency_count;
    out_result->completed_frequency_count = native_result.completed_frequency_count;
    out_result->written_frequency_point_artifacts =
        native_result.written_frequency_point_artifacts;
    out_result->error_message = native_result.error_message;
    out_result->diagnostics_json = native_result.diagnostics_json;
    out_result->result_json = native_result.result_json;
    out_result->artifact_manifest_path = native_result.artifact_manifest_path;
    native_result.error_message = nullptr;
    native_result.diagnostics_json = nullptr;
    native_result.result_json = nullptr;
    native_result.artifact_manifest_path = nullptr;
}

FullmagFemFrequencyDomainResult copy_frequency_domain_contract_result(
    const fullmag::fem::frequency_domain::FrequencyDomainContractResult &native_result) noexcept
{
    FullmagFemFrequencyDomainResult result{};
    result.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION;
    result.status = to_frequency_domain_contract_status(native_result.status);
    result.error_message = duplicate_c_string(native_result.error_message.c_str());
    result.diagnostics_json = duplicate_c_string(native_result.diagnostics_json.c_str());
    result.result_json = duplicate_c_string(native_result.result_json.c_str());
    result.artifact_manifest_path =
        duplicate_c_string(native_result.artifact_manifest_path.c_str());
    result.struct_size = sizeof(result);
    result.q_dof_count = native_result.modal_eigen.q_dof_count;
    result.phi_dof_count = native_result.modal_eigen.phi_dof_count;
    result.mode_count = native_result.modal_eigen.mode_lambda.size();
    result.mode_lambda_count = native_result.modal_eigen.mode_lambda.size();
    result.mode_q_complex_count = native_result.modal_eigen.mode_q_complex.size();
    result.mode_phi_complex_count = native_result.modal_eigen.mode_phi_complex.size();
    result.mode_delta_m_xyz_complex_count =
        native_result.modal_eigen.mode_delta_m_xyz_complex.size();
    result.mode_residual_count = native_result.modal_eigen.mode_residuals.size();
    result.mode_cluster_id_count = native_result.modal_eigen.mode_cluster_ids.size();
    result.mode_lambda = duplicate_complex_values(native_result.modal_eigen.mode_lambda);
    result.mode_q_complex = duplicate_complex_values(native_result.modal_eigen.mode_q_complex);
    result.mode_phi_complex = duplicate_complex_values(native_result.modal_eigen.mode_phi_complex);
    result.mode_delta_m_xyz_complex = duplicate_complex_values(
        native_result.modal_eigen.mode_delta_m_xyz_complex);
    result.mode_residuals = duplicate_double_values(native_result.modal_eigen.mode_residuals);
    result.mode_cluster_ids = duplicate_u64_values(native_result.modal_eigen.mode_cluster_ids);
    result.resolved_execution_target = FULLMAG_FEM_MODAL_EXECUTION_AUTO;
    result.resolved_scalar_representation = FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE;
    result.resolved_spectral_transform_kind =
        FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO;
    result.resolved_execution_target =
        static_cast<fullmag_fem_modal_execution_target>(
            native_result.modal_execution.execution_target);
    result.resolved_scalar_representation =
        static_cast<fullmag_fem_modal_scalar_representation>(
            native_result.modal_execution.scalar_representation);
    result.resolved_spectral_transform_kind =
        static_cast<fullmag_fem_modal_spectral_transform_kind>(
            native_result.modal_execution.spectral_transform_kind);
    result.resolved_fallback_state =
        static_cast<std::uint32_t>(native_result.modal_execution.fallback_state);
    result.resolved_engine_id =
        duplicate_c_string(native_result.modal_execution.engine_id.c_str());
    result.resolved_fallback_reason =
        duplicate_c_string(native_result.modal_execution.fallback_reason.c_str());
    result.resolved_canonical_preimage_sha256 = duplicate_c_string(
        native_result.certificate_binding.canonical_preimage_sha256.c_str());
    result.resolved_certificate_binding_status = native_result.certificate_binding.status;
    result.resolved_certificate_binding_reason = duplicate_c_string(
        native_result.certificate_binding.reason.c_str());
    if (result.error_message == nullptr ||
        result.diagnostics_json == nullptr ||
        result.result_json == nullptr ||
        result.artifact_manifest_path == nullptr ||
        result.resolved_engine_id == nullptr ||
        result.resolved_fallback_reason == nullptr ||
        result.resolved_canonical_preimage_sha256 == nullptr ||
        result.resolved_certificate_binding_reason == nullptr ||
        (result.mode_lambda_count != 0 && result.mode_lambda == nullptr) ||
        (result.mode_q_complex_count != 0 && result.mode_q_complex == nullptr) ||
        (result.mode_phi_complex_count != 0 && result.mode_phi_complex == nullptr) ||
        (result.mode_delta_m_xyz_complex_count != 0 &&
         result.mode_delta_m_xyz_complex == nullptr) ||
        (result.mode_residual_count != 0 && result.mode_residuals == nullptr) ||
        (result.mode_cluster_id_count != 0 && result.mode_cluster_ids == nullptr)) {
        delete[] result.error_message;
        delete[] result.diagnostics_json;
        delete[] result.result_json;
        delete[] result.artifact_manifest_path;
        delete[] result.resolved_engine_id;
        delete[] result.resolved_fallback_reason;
        delete[] result.resolved_canonical_preimage_sha256;
        delete[] result.resolved_certificate_binding_reason;
        release_modal_buffers(result);
        result = {};
        result.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION;
        result.struct_size = sizeof(result);
        result.status = FULLMAG_FEM_FD_ARTIFACT_ERROR;
        result.resolved_execution_target = FULLMAG_FEM_MODAL_EXECUTION_AUTO;
        result.resolved_scalar_representation =
            FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE;
        result.resolved_spectral_transform_kind =
            FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO;
        result.resolved_fallback_state = 0u;
        result.error_message =
            duplicate_c_string("failed to allocate native FEM frequency-domain result strings");
        result.diagnostics_json = duplicate_c_string(
            "{\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
            "\"status\":\"artifact_error\","
            "\"complete\":false}");
        result.result_json = duplicate_c_string(
            "{\"schema_version\":\"frequency_domain_contract_result.v1\","
            "\"status\":\"artifact_error\"}");
        result.artifact_manifest_path = duplicate_c_string("");
        result.resolved_engine_id = duplicate_c_string("artifact_error");
        result.resolved_fallback_reason = duplicate_c_string("none");
        result.resolved_canonical_preimage_sha256 = duplicate_c_string("");
        result.resolved_certificate_binding_status =
            FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED;
        result.resolved_certificate_binding_reason = duplicate_c_string("none");
    }
    return result;
}

bool frequency_domain_cancel_requested_from_c_abi(void *user_data) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    return request != nullptr &&
        request->cancel_requested != nullptr &&
        request->cancel_requested(request->cancel_user_data) != 0;
}

void frequency_domain_progress_from_c_abi(
    void *user_data,
    const fullmag::fem::frequency_domain::ProductionCpuDrivenResponseProgress &progress) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    if (request == nullptr || request->progress_callback == nullptr) {
        return;
    }
    const fullmag_fem_frequency_domain_progress abi_progress{
        progress.frequency_index,
        progress.completed_frequency_count,
        progress.total_frequency_count,
        progress.iteration_count,
        progress.frequency_hz,
        progress.residual_l2_norm,
        progress.relative_residual_l2_norm,
        progress.converged ? 1 : 0,
    };
    request->progress_callback(request->progress_user_data, &abi_progress);
}

fullmag::fem::frequency_domain::FrequencyDomainStatus
frequency_domain_periodic_airbox_apply_stiffness_from_c_abi(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    if (request == nullptr || request->periodic_airbox_coupled_block_apply_stiffness == nullptr) {
        std::snprintf(error_message, 128, "missing periodic-airbox coupled-block stiffness callback");
        return fullmag::fem::frequency_domain::FrequencyDomainStatus::validation_error;
    }
    return from_abi_status(request->periodic_airbox_coupled_block_apply_stiffness(
        request->periodic_airbox_coupled_block_operator_user_data,
        in,
        out,
        error_message));
}

fullmag::fem::frequency_domain::FrequencyDomainStatus
frequency_domain_periodic_airbox_apply_mass_from_c_abi(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    if (request == nullptr || request->periodic_airbox_coupled_block_apply_mass == nullptr) {
        std::snprintf(error_message, 128, "missing periodic-airbox coupled-block mass callback");
        return fullmag::fem::frequency_domain::FrequencyDomainStatus::validation_error;
    }
    return from_abi_status(request->periodic_airbox_coupled_block_apply_mass(
        request->periodic_airbox_coupled_block_operator_user_data,
        in,
        out,
        error_message));
}

fullmag::fem::frequency_domain::FrequencyDomainStatus
frequency_domain_periodic_airbox_apply_complex_stiffness_from_c_abi(
    void *user_data,
    const double *in_real,
    const double *in_imag,
    double *out_real,
    double *out_imag,
    char error_message[128]) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    if (request == nullptr ||
        request->periodic_airbox_coupled_block_apply_complex_stiffness == nullptr) {
        std::snprintf(error_message, 128, "missing periodic-airbox coupled-block complex stiffness callback");
        return fullmag::fem::frequency_domain::FrequencyDomainStatus::validation_error;
    }
    return from_abi_status(request->periodic_airbox_coupled_block_apply_complex_stiffness(
        request->periodic_airbox_coupled_block_operator_user_data,
        in_real,
        in_imag,
        out_real,
        out_imag,
        error_message));
}

fullmag::fem::frequency_domain::FrequencyDomainStatus
frequency_domain_periodic_airbox_apply_complex_mass_from_c_abi(
    void *user_data,
    const double *in_real,
    const double *in_imag,
    double *out_real,
    double *out_imag,
    char error_message[128]) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    if (request == nullptr ||
        request->periodic_airbox_coupled_block_apply_complex_mass == nullptr) {
        std::snprintf(error_message, 128, "missing periodic-airbox coupled-block complex mass callback");
        return fullmag::fem::frequency_domain::FrequencyDomainStatus::validation_error;
    }
    return from_abi_status(request->periodic_airbox_coupled_block_apply_complex_mass(
        request->periodic_airbox_coupled_block_operator_user_data,
        in_real,
        in_imag,
        out_real,
        out_imag,
        error_message));
}

fullmag::fem::frequency_domain::FrequencyDomainStatus
frequency_domain_mfem_apply_demag_tangent_from_c_abi(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *context = static_cast<const DrivenResponseCAbiDemagTangentContext *>(user_data);
    const auto *request = context != nullptr ? context->request : nullptr;
    if (request == nullptr || request->mfem_apply_demag_tangent == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM demag tangent callback");
        return fullmag::fem::frequency_domain::FrequencyDomainStatus::validation_error;
    }
    return from_abi_status(request->mfem_apply_demag_tangent(
        request->mfem_demag_tangent_user_data,
        in,
        out,
        error_message));
}

fullmag::fem::frequency_domain::FrequencyDomainStatus
frequency_domain_mfem_apply_demag_tangent_with_potential_from_c_abi(
    void *user_data,
    const double *in,
    double *out,
    double *out_phi,
    std::uint64_t out_phi_len,
    char error_message[128]) noexcept
{
    auto *context = static_cast<const DrivenResponseCAbiDemagTangentContext *>(user_data);
    const auto *request = context != nullptr ? context->request : nullptr;
    if (request == nullptr || context->apply_with_potential == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM demag tangent-with-potential callback");
        return fullmag::fem::frequency_domain::FrequencyDomainStatus::validation_error;
    }
    return from_abi_status(context->apply_with_potential(
        request->mfem_demag_tangent_user_data,
        in,
        out,
        out_phi,
        out_phi_len,
        error_message));
}

constexpr fullmag_fem_mesh_abi_record make_mesh_abi_record() {
    static_assert(sizeof(fullmag_fem_mesh_abi_layout) == 360u);
    static_assert(alignof(fullmag_fem_mesh_abi_layout) == 8u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, abi_version) == 0u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, struct_size) == 4u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, mesh_desc_abi_version) == 8u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, mesh_desc_struct_size) == 12u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, field_count) == 16u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, reserved) == 20u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, field_offsets) == 24u);
    static_assert(offsetof(fullmag_fem_mesh_abi_layout, layout_fingerprint) == 264u);
    static_assert(sizeof(fullmag_fem_mesh_abi_record) == 416u);
    static_assert(alignof(fullmag_fem_mesh_abi_record) == 8u);
    static_assert(offsetof(fullmag_fem_mesh_abi_record, magic) == 0u);
    static_assert(offsetof(fullmag_fem_mesh_abi_record, record_version) == 40u);
    static_assert(offsetof(fullmag_fem_mesh_abi_record, record_size) == 44u);
    static_assert(offsetof(fullmag_fem_mesh_abi_record, endian_tag) == 48u);
    static_assert(offsetof(fullmag_fem_mesh_abi_record, reserved) == 52u);
    static_assert(offsetof(fullmag_fem_mesh_abi_record, layout) == 56u);
    fullmag_fem_mesh_abi_record record{};
    constexpr char magic[] = FULLMAG_FEM_MESH_ABI_RECORD_MAGIC;
    constexpr char fingerprint[] = FULLMAG_FEM_MESH_DESC_ABI_LAYOUT_FINGERPRINT;
    for (size_t i = 0; i < sizeof(magic); ++i) record.magic[i] = magic[i];
    record.record_version = FULLMAG_FEM_MESH_ABI_RECORD_VERSION;
    record.record_size = sizeof(record);
    record.endian_tag = FULLMAG_FEM_MESH_ABI_RECORD_ENDIAN_TAG;
    record.layout.abi_version = FULLMAG_FEM_MESH_ABI_LAYOUT_VERSION;
    record.layout.struct_size = sizeof(record.layout);
    record.layout.mesh_desc_abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    record.layout.mesh_desc_struct_size = sizeof(fullmag_fem_mesh_desc);
    record.layout.field_count = FULLMAG_FEM_MESH_ABI_FIELD_COUNT;
    constexpr uint64_t offsets[] = {
        offsetof(fullmag_fem_mesh_desc, abi_version),
        offsetof(fullmag_fem_mesh_desc, struct_size),
        offsetof(fullmag_fem_mesh_desc, nodes_xyz),
        offsetof(fullmag_fem_mesh_desc, nodes_xyz_len),
        offsetof(fullmag_fem_mesh_desc, cell_types),
        offsetof(fullmag_fem_mesh_desc, cell_types_len),
        offsetof(fullmag_fem_mesh_desc, cell_offsets),
        offsetof(fullmag_fem_mesh_desc, cell_offsets_len),
        offsetof(fullmag_fem_mesh_desc, cell_nodes),
        offsetof(fullmag_fem_mesh_desc, cell_nodes_len),
        offsetof(fullmag_fem_mesh_desc, cell_global_ordinals),
        offsetof(fullmag_fem_mesh_desc, cell_global_ordinals_len),
        offsetof(fullmag_fem_mesh_desc, cell_markers),
        offsetof(fullmag_fem_mesh_desc, cell_markers_len),
        offsetof(fullmag_fem_mesh_desc, facet_types),
        offsetof(fullmag_fem_mesh_desc, facet_types_len),
        offsetof(fullmag_fem_mesh_desc, facet_roles),
        offsetof(fullmag_fem_mesh_desc, facet_roles_len),
        offsetof(fullmag_fem_mesh_desc, facet_offsets),
        offsetof(fullmag_fem_mesh_desc, facet_offsets_len),
        offsetof(fullmag_fem_mesh_desc, facet_nodes),
        offsetof(fullmag_fem_mesh_desc, facet_nodes_len),
        offsetof(fullmag_fem_mesh_desc, facet_global_ordinals),
        offsetof(fullmag_fem_mesh_desc, facet_global_ordinals_len),
        offsetof(fullmag_fem_mesh_desc, facet_markers),
        offsetof(fullmag_fem_mesh_desc, facet_markers_len),
        offsetof(fullmag_fem_mesh_desc, periodic_node_pairs),
        offsetof(fullmag_fem_mesh_desc, periodic_node_pairs_len),
        offsetof(fullmag_fem_mesh_desc, periodic_boundary_pair_markers),
        offsetof(fullmag_fem_mesh_desc, periodic_boundary_pair_markers_len),
    };
    static_assert(sizeof(offsets) / sizeof(offsets[0]) == FULLMAG_FEM_MESH_ABI_FIELD_COUNT);
    for (size_t i = 0; i < FULLMAG_FEM_MESH_ABI_FIELD_COUNT; ++i) {
        record.layout.field_offsets[i] = offsets[i];
    }
    for (size_t i = 0; i < sizeof(fingerprint); ++i) {
        record.layout.layout_fingerprint[i] = fingerprint[i];
    }
    return record;
}

} // namespace

extern "C" {

#if defined(__GNUC__)
__attribute__((used, section(".fullmag_fem_abi"), aligned(8), visibility("default")))
#endif
extern const fullmag_fem_mesh_abi_record fullmag_fem_mesh_abi_record_v1 =
    make_mesh_abi_record();

int fullmag_fem_is_available(void) {
    const auto info = fullmag::fem::query_availability();
    return (info.native_fem_cpu_available != 0 || info.native_fem_gpu_available != 0) ? 1 : 0;
}

int fullmag_fem_get_availability_info(fullmag_fem_availability_info *out_info) {
    if (out_info == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_availability_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_info = fullmag::fem::query_availability();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_availability_info(
    const fullmag_fem_frequency_domain_availability_request *request,
    fullmag_fem_frequency_domain_availability_info *out_info
) {
    if (request == nullptr || out_info == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_availability_info requires non-null request and out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }

    namespace fd = fullmag::fem::frequency_domain;
    fd::FrequencyDomainAvailabilityRequest native_request{};
    if (!from_abi_study_kind(request->study_kind, &native_request.study_kind)) {
        fullmag_fem_set_global_error(
            "invalid frequency-domain study kind in availability request");
        return FULLMAG_FEM_ERR_INVALID;
    }
    native_request.requires_driven_solver = request->requires_driven_solver != 0;
    native_request.requires_modal_solver = request->requires_modal_solver != 0;
    native_request.requires_static_periodic_boundary =
        request->requires_static_periodic_boundary != 0;
    native_request.requires_floquet_boundary = request->requires_floquet_boundary != 0;
    native_request.requires_nonzero_k_dynamic_demag =
        request->requires_nonzero_k_dynamic_demag != 0;
    native_request.requires_gpu = request->requires_gpu != 0;
    native_request.strict_device = request->strict_device != 0;
    native_request.has_floquet_k_vector = request->has_floquet_k_vector != 0;
    native_request.floquet_k_vector_rad_per_m[0] =
        request->floquet_k_vector_rad_per_m[0];
    native_request.floquet_k_vector_rad_per_m[1] =
        request->floquet_k_vector_rad_per_m[1];
    native_request.floquet_k_vector_rad_per_m[2] =
        request->floquet_k_vector_rad_per_m[2];
    if (!from_abi_frequency_domain_phase_convention(
            request->phase_convention,
            &native_request.phase_convention)) {
        fullmag_fem_set_global_error(
            "invalid frequency-domain phase convention in availability request");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const fd::FrequencyDomainAvailabilityResult native_result =
        fd::frequency_domain_availability(native_request);

    *out_info = {};
    out_info->status = to_abi_status(native_result.status);
    out_info->driven_response_available =
        native_result.driven_response_available ? 1 : 0;
    out_info->modal_solver_available = native_result.modal_solver_available ? 1 : 0;
    out_info->static_periodic_response_available =
        native_result.static_periodic_response_available ? 1 : 0;
    out_info->floquet_modal_available = native_result.floquet_modal_available ? 1 : 0;
    out_info->floquet_response_available =
        native_result.floquet_response_available ? 1 : 0;
    out_info->dynamic_demag_k_available =
        native_result.dynamic_demag_k_available ? 1 : 0;
    out_info->gpu_available = native_result.gpu_available ? 1 : 0;
    std::snprintf(
        out_info->status_name,
        sizeof(out_info->status_name),
        "%s",
        fd::status_to_string(native_result.status));
    std::snprintf(
        out_info->study_kind_name,
        sizeof(out_info->study_kind_name),
        "%s",
        fd::study_kind_to_string(native_request.study_kind));
    std::snprintf(
        out_info->reason,
        sizeof(out_info->reason),
        "%s",
        native_result.error_message != nullptr ? native_result.error_message : "");
    std::snprintf(
        out_info->diagnostics_json,
        sizeof(out_info->diagnostics_json),
        "%s",
        native_result.diagnostics_json != nullptr ? native_result.diagnostics_json : "");
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_dependency_info(
    fullmag_fem_frequency_domain_dependency_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_dependency_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }

    *out_info = {};
    const bool petsc_available =
        FULLMAG_FEM_WITH_SLEPC != 0 && FULLMAG_FEM_PETSC_VERSION[0] != '\0';
    const bool slepc_available =
        FULLMAG_FEM_WITH_SLEPC != 0 && FULLMAG_FEM_SLEPC_VERSION[0] != '\0';
    const bool modal_eigen_native_cpu_slepc_available =
        FULLMAG_FEM_WITH_SLEPC != 0 && petsc_available && slepc_available;
    const char *reason = modal_eigen_native_cpu_slepc_available
                             ? ""
                             : "modal_eigen production CPU path requires PETSc/SLEPc, but fullmag_fem was built without SLEPc support";

    out_info->petsc_available = petsc_available ? 1 : 0;
    out_info->slepc_available = slepc_available ? 1 : 0;
    out_info->modal_eigen_native_cpu_slepc_available =
        modal_eigen_native_cpu_slepc_available ? 1 : 0;
    std::snprintf(
        out_info->petsc_version,
        sizeof(out_info->petsc_version),
        "%s",
        FULLMAG_FEM_PETSC_VERSION);
    std::snprintf(
        out_info->slepc_version,
        sizeof(out_info->slepc_version),
        "%s",
        FULLMAG_FEM_SLEPC_VERSION);
    std::snprintf(
        out_info->petsc_pkgconfig_dir,
        sizeof(out_info->petsc_pkgconfig_dir),
        "%s",
        FULLMAG_FEM_PETSC_PKGCONFIG_DIR);
    std::snprintf(
        out_info->slepc_pkgconfig_dir,
        sizeof(out_info->slepc_pkgconfig_dir),
        "%s",
        FULLMAG_FEM_SLEPC_PKGCONFIG_DIR);
    std::snprintf(
        out_info->petsc_find_module_file,
        sizeof(out_info->petsc_find_module_file),
        "%s",
        FULLMAG_FEM_PETSC_FIND_MODULE_FILE);
    std::snprintf(
        out_info->slepc_find_module_file,
        sizeof(out_info->slepc_find_module_file),
        "%s",
        FULLMAG_FEM_SLEPC_FIND_MODULE_FILE);
    std::snprintf(
        out_info->petsc_library_path,
        sizeof(out_info->petsc_library_path),
        "%s",
        FULLMAG_FEM_PETSC_LIBRARY_PATH);
    std::snprintf(
        out_info->slepc_library_path,
        sizeof(out_info->slepc_library_path),
        "%s",
        FULLMAG_FEM_SLEPC_LIBRARY_PATH);
    if (!modal_eigen_native_cpu_slepc_available) {
        std::snprintf(
            out_info->reason,
            sizeof(out_info->reason),
            "%s",
            reason);
    }
    std::snprintf(
        out_info->diagnostics_json,
        sizeof(out_info->diagnostics_json),
        "{\"schema_version\":\"fullmag_fem_frequency_domain_dependency_info.v1\","
        "\"petsc_available\":%s,"
        "\"slepc_available\":%s,"
        "\"modal_eigen_native_cpu_slepc_available\":%s,"
        "\"petsc_version\":\"%s\","
        "\"slepc_version\":\"%s\","
        "\"petsc_pkgconfig_dir\":\"%s\","
        "\"slepc_pkgconfig_dir\":\"%s\","
        "\"petsc_find_module_file\":\"%s\","
        "\"slepc_find_module_file\":\"%s\","
        "\"petsc_library_path\":\"%s\","
        "\"slepc_library_path\":\"%s\","
        "\"reason\":\"%s\"}",
        petsc_available ? "true" : "false",
        slepc_available ? "true" : "false",
        modal_eigen_native_cpu_slepc_available ? "true" : "false",
        FULLMAG_FEM_PETSC_VERSION,
        FULLMAG_FEM_SLEPC_VERSION,
        FULLMAG_FEM_PETSC_PKGCONFIG_DIR,
        FULLMAG_FEM_SLEPC_PKGCONFIG_DIR,
        FULLMAG_FEM_PETSC_FIND_MODULE_FILE,
        FULLMAG_FEM_SLEPC_FIND_MODULE_FILE,
        FULLMAG_FEM_PETSC_LIBRARY_PATH,
        FULLMAG_FEM_SLEPC_LIBRARY_PATH,
        reason);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_abi_layout(
    fullmag_fem_frequency_domain_abi_layout *out_layout
) {
    if (out_layout == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_abi_layout received null out_layout");
        return FULLMAG_FEM_ERR_INVALID;
    }

    *out_layout = {};
    out_layout->availability_request_size =
        sizeof(fullmag_fem_frequency_domain_availability_request);
    out_layout->availability_request_phase_convention_offset =
        offsetof(fullmag_fem_frequency_domain_availability_request, phase_convention);
    out_layout->availability_info_size =
        sizeof(fullmag_fem_frequency_domain_availability_info);
    out_layout->availability_info_diagnostics_json_offset =
        offsetof(fullmag_fem_frequency_domain_availability_info, diagnostics_json);
    out_layout->dependency_info_size =
        sizeof(fullmag_fem_frequency_domain_dependency_info);
    out_layout->dependency_info_modal_eigen_native_cpu_slepc_available_offset =
        offsetof(fullmag_fem_frequency_domain_dependency_info, modal_eigen_native_cpu_slepc_available);
    out_layout->dependency_info_diagnostics_json_offset =
        offsetof(fullmag_fem_frequency_domain_dependency_info, diagnostics_json);
    out_layout->sweep_progress_size =
        sizeof(fullmag_fem_frequency_domain_sweep_progress);
    out_layout->sweep_progress_progress_json_offset =
        offsetof(fullmag_fem_frequency_domain_sweep_progress, progress_json);
    out_layout->progress_size =
        sizeof(fullmag_fem_frequency_domain_progress);
    out_layout->progress_converged_offset =
        offsetof(fullmag_fem_frequency_domain_progress, converged);
    out_layout->exchange_edge_size =
        sizeof(fullmag_fem_frequency_domain_exchange_edge);
    out_layout->exchange_edge_stiffness_offset =
        offsetof(fullmag_fem_frequency_domain_exchange_edge, stiffness);
    out_layout->periodic_node_pair_size =
        sizeof(fullmag_fem_frequency_domain_periodic_node_pair);
    out_layout->periodic_node_pair_node_b_offset =
        offsetof(fullmag_fem_frequency_domain_periodic_node_pair, node_b);
    out_layout->floquet_periodic_pair_size =
        sizeof(fullmag_fem_frequency_domain_floquet_periodic_pair);
    out_layout->floquet_periodic_pair_phase_rad_offset =
        offsetof(fullmag_fem_frequency_domain_floquet_periodic_pair, phase_rad);
    out_layout->dmi_element_size =
        sizeof(fullmag_fem_frequency_domain_dmi_element);
    out_layout->dmi_element_normal_offset =
        offsetof(fullmag_fem_frequency_domain_dmi_element, normal);
    out_layout->driven_response_request_size =
        sizeof(fullmag_fem_frequency_domain_driven_response_request);
    out_layout->driven_response_request_abi_version_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, abi_version);
    out_layout->driven_response_request_struct_size_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, struct_size);
    out_layout->driven_response_request_requested_execution_lane_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, requested_execution_lane);
    out_layout->driven_response_request_progress_callback_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, progress_callback);
    out_layout->driven_response_request_tiny_validation_drive_imag_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, tiny_validation_drive_imag);
    out_layout->driven_response_request_phase_convention_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, phase_convention);
    out_layout->driven_response_request_drive_kind_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, drive_kind);
    out_layout->driven_response_request_require_nonzero_rhs_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, require_nonzero_rhs);
    out_layout->driven_response_request_mfem_floquet_periodic_pair_count_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, mfem_floquet_periodic_pair_count);
    out_layout->driven_response_request_periodic_airbox_magnetostatic_periodic_node_pairs_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, periodic_airbox_magnetostatic_periodic_node_pairs);
    out_layout->driven_response_request_periodic_airbox_coupled_block_enabled_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, periodic_airbox_coupled_block_enabled);
    out_layout->driven_response_request_periodic_airbox_coupled_block_apply_stiffness_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, periodic_airbox_coupled_block_apply_stiffness);
    out_layout->driven_response_request_periodic_airbox_coupled_block_apply_complex_stiffness_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, periodic_airbox_coupled_block_apply_complex_stiffness);
    out_layout->driven_response_request_periodic_airbox_coupled_block_operator_user_data_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, periodic_airbox_coupled_block_operator_user_data);
    out_layout->driven_response_request_mfem_apply_demag_tangent_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, mfem_apply_demag_tangent);
    out_layout->driven_response_request_mfem_demag_tangent_user_data_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, mfem_demag_tangent_user_data);
    out_layout->driven_response_request_mfem_demag_tangent_matrix_row_major_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, mfem_demag_tangent_matrix_row_major);
    out_layout->driven_response_request_solver_relative_tolerance_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, solver_relative_tolerance);
    out_layout->driven_response_request_solver_absolute_tolerance_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, solver_absolute_tolerance);
    out_layout->driven_response_request_solver_max_iterations_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, solver_max_iterations);
    out_layout->driven_response_request_solver_restart_iterations_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, solver_restart_iterations);
    out_layout->driven_response_request_solver_progress_interval_iterations_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, solver_progress_interval_iterations);
    out_layout->driven_response_request_tiny_validation_drive_real_value_count_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, tiny_validation_drive_real_value_count);
    out_layout->driven_response_request_mfem_equilibrium_m_value_count_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, mfem_equilibrium_m_value_count);
    out_layout->driven_response_request_mfem_drive_real_value_count_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, mfem_drive_real_value_count);
    out_layout->driven_response_request_periodic_airbox_coupled_block_drive_real_value_count_offset =
        offsetof(fullmag_fem_frequency_domain_driven_response_request, periodic_airbox_coupled_block_drive_real_value_count);
    out_layout->solve_result_size =
        sizeof(fullmag_fem_frequency_domain_solve_result);
    out_layout->solve_result_artifact_manifest_path_offset =
        offsetof(fullmag_fem_frequency_domain_solve_result, artifact_manifest_path);
    out_layout->modal_abi_schema = 1u;
    out_layout->modal_abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    out_layout->modal_eigen_request_size = sizeof(FullmagFemModalEigenRequest);
    out_layout->modal_eigen_request_struct_size_offset =
        offsetof(FullmagFemModalEigenRequest, struct_size);
    out_layout->modal_eigen_request_shared_domain_payload_offset =
        offsetof(FullmagFemModalEigenRequest, shared_domain_payload);
    /* v1 remains the legacy V17-prefix manifest.  The V18 descriptor tail is
       published only through the explicit v3 manifest below. */
    out_layout->modal_shared_domain_payload_size =
        offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor);
    out_layout->modal_shared_domain_payload_struct_size_offset =
        offsetof(FullmagFemModalSharedDomainPayload, struct_size);
    out_layout->modal_shared_domain_payload_mesh_certificate_digest_offset =
        offsetof(FullmagFemModalSharedDomainPayload, mesh_certificate_digest);
    out_layout->modal_shared_domain_payload_map_binding_digest_offset =
        offsetof(FullmagFemModalSharedDomainPayload, mesh_certificate_map_binding_digest);
    out_layout->modal_shared_domain_payload_bias_field_sample_id_offset =
        offsetof(FullmagFemModalSharedDomainPayload, bias_field_sample_id);
    out_layout->modal_frequency_domain_result_size = sizeof(FullmagFemFrequencyDomainResult);
    out_layout->modal_frequency_domain_result_struct_size_offset =
        offsetof(FullmagFemFrequencyDomainResult, struct_size);
    out_layout->modal_frequency_domain_result_resolved_engine_id_offset =
        offsetof(FullmagFemFrequencyDomainResult, resolved_engine_id);
    out_layout->modal_csr_matrix_view_size = sizeof(FullmagFemCsrMatrixView);
    out_layout->modal_csr_matrix_view_values_len_offset =
        offsetof(FullmagFemCsrMatrixView, values_len);
    out_layout->modal_eigen_request_abi_version_offset =
        offsetof(FullmagFemModalEigenRequest, abi_version);
    out_layout->modal_eigen_request_operator_request_offset =
        offsetof(FullmagFemModalEigenRequest, operator_request);
    out_layout->modal_eigen_request_spectral_transform_kind_offset =
        offsetof(FullmagFemModalEigenRequest, spectral_transform_kind);
    out_layout->modal_eigen_request_execution_target_offset =
        offsetof(FullmagFemModalEigenRequest, execution_target);
    out_layout->modal_eigen_request_scalar_representation_offset =
        offsetof(FullmagFemModalEigenRequest, scalar_representation);
    out_layout->modal_eigen_request_result_field_representation_offset =
        offsetof(FullmagFemModalEigenRequest, result_field_representation);
    out_layout->modal_shared_domain_payload_abi_version_offset =
        offsetof(FullmagFemModalSharedDomainPayload, abi_version);
    out_layout->modal_shared_domain_payload_mesh_offset =
        offsetof(FullmagFemModalSharedDomainPayload, mesh);
    out_layout->modal_shared_domain_payload_magnetic_a_qq_csr_offset =
        offsetof(FullmagFemModalSharedDomainPayload, magnetic_a_qq_csr);
    out_layout->modal_shared_domain_payload_scalar_reduced_node_offset =
        offsetof(FullmagFemModalSharedDomainPayload, scalar_reduced_node);
    out_layout->modal_shared_domain_payload_magnetic_reduced_node_offset =
        offsetof(FullmagFemModalSharedDomainPayload, magnetic_reduced_node);
    out_layout->modal_shared_domain_payload_magnetic_pair_count_offset =
        offsetof(FullmagFemModalSharedDomainPayload, magnetic_pair_count);
    out_layout->modal_shared_domain_payload_airbox_pair_count_offset =
        offsetof(FullmagFemModalSharedDomainPayload, airbox_pair_count);
    out_layout->modal_shared_domain_payload_boundary_marker_offset =
        offsetof(FullmagFemModalSharedDomainPayload, boundary_marker);
    out_layout->modal_shared_domain_payload_mesh_certificate_schema_offset =
        offsetof(FullmagFemModalSharedDomainPayload, mesh_certificate_schema);
    out_layout->modal_shared_domain_payload_equilibrium_digest_offset =
        offsetof(FullmagFemModalSharedDomainPayload, equilibrium_digest);
    out_layout->modal_shared_domain_payload_linearization_state_digest_offset =
        offsetof(FullmagFemModalSharedDomainPayload, linearization_state_digest);
    out_layout->modal_shared_domain_payload_boundary_gauge_digest_offset =
        offsetof(FullmagFemModalSharedDomainPayload, boundary_gauge_digest);
    out_layout->modal_shared_domain_payload_bias_field_sample_index_offset =
        offsetof(FullmagFemModalSharedDomainPayload, bias_field_sample_index);
    out_layout->modal_shared_domain_payload_bias_field_sample_signature_offset =
        offsetof(FullmagFemModalSharedDomainPayload, bias_field_sample_signature);
    out_layout->modal_shared_domain_payload_magnetic_part_identity_offset =
        offsetof(FullmagFemModalSharedDomainPayload, magnetic_part_identity);
    out_layout->modal_shared_domain_payload_airbox_part_identity_offset =
        offsetof(FullmagFemModalSharedDomainPayload, airbox_part_identity);
    out_layout->modal_frequency_domain_result_abi_version_offset =
        offsetof(FullmagFemFrequencyDomainResult, abi_version);
    out_layout->modal_frequency_domain_result_status_offset =
        offsetof(FullmagFemFrequencyDomainResult, status);
    out_layout->modal_frequency_domain_result_error_message_offset =
        offsetof(FullmagFemFrequencyDomainResult, error_message);
    out_layout->modal_frequency_domain_result_mode_lambda_offset =
        offsetof(FullmagFemFrequencyDomainResult, mode_lambda);
    out_layout->modal_frequency_domain_result_resolved_execution_target_offset =
        offsetof(FullmagFemFrequencyDomainResult, resolved_execution_target);
    out_layout->modal_frequency_domain_result_resolved_scalar_representation_offset =
        offsetof(FullmagFemFrequencyDomainResult, resolved_scalar_representation);
    out_layout->modal_frequency_domain_result_resolved_spectral_transform_kind_offset =
        offsetof(FullmagFemFrequencyDomainResult, resolved_spectral_transform_kind);
    out_layout->modal_frequency_domain_result_resolved_fallback_state_offset =
        offsetof(FullmagFemFrequencyDomainResult, resolved_fallback_state);
    out_layout->modal_frequency_domain_result_resolved_fallback_reason_offset =
        offsetof(FullmagFemFrequencyDomainResult, resolved_fallback_reason);
    out_layout->modal_csr_matrix_view_row_count_offset =
        offsetof(FullmagFemCsrMatrixView, row_count);
    out_layout->modal_csr_matrix_view_column_count_offset =
        offsetof(FullmagFemCsrMatrixView, column_count);
    out_layout->modal_csr_matrix_view_row_offsets_offset =
        offsetof(FullmagFemCsrMatrixView, row_offsets);
    out_layout->modal_csr_matrix_view_row_offsets_len_offset =
        offsetof(FullmagFemCsrMatrixView, row_offsets_len);
    out_layout->modal_csr_matrix_view_column_indices_offset =
        offsetof(FullmagFemCsrMatrixView, column_indices);
    out_layout->modal_csr_matrix_view_column_indices_len_offset =
        offsetof(FullmagFemCsrMatrixView, column_indices_len);
    out_layout->modal_csr_matrix_view_values_offset =
        offsetof(FullmagFemCsrMatrixView, values);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_modal_abi_layout_v2(
    fullmag_fem_frequency_domain_modal_abi_layout_v2 *out_layout
) {
    static_assert(
        FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_COUNT <= 128u,
        "modal request manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_COUNT <= 32u,
        "modal operator manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT <= 128u,
        "modal payload manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_COUNT <= 64u,
        "modal result manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_COUNT <= 8u,
        "modal CSR manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_COUNT <= 8u,
        "modal v6 relation manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_COUNT <= 4u,
        "modal v6 region-role manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_COUNT <= 8u,
        "modal v6 class-digest manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_COUNT <= 32u,
        "modal v6 view manifest capacity must cover the append-only field list");
    static_assert(
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_COUNT <= 8u,
        "modal v6 binding-request manifest capacity must cover the append-only field list");
    if (out_layout == nullptr ||
        out_layout->struct_size < sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v2)) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_modal_abi_layout_v2 requires its full v2 struct");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_layout = {};
    out_layout->abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V2;
    out_layout->struct_size = sizeof(*out_layout);
    out_layout->modal_abi_schema = 2u;
    out_layout->modal_eigen_request_size = sizeof(FullmagFemModalEigenRequest);
    out_layout->modal_linearized_operator_request_size =
        sizeof(FullmagFemLinearizedOperatorRequest);
    out_layout->modal_shared_domain_payload_size =
        offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor);
    out_layout->modal_frequency_domain_result_size = sizeof(FullmagFemFrequencyDomainResult);
    out_layout->modal_csr_matrix_view_size = sizeof(FullmagFemCsrMatrixView);
#define FULLMAG_FEM_V2_REQUEST_OFFSET(member) offsetof(FullmagFemModalEigenRequest, member),
    constexpr std::uint64_t request_offsets[] = {
        FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_LIST(FULLMAG_FEM_V2_REQUEST_OFFSET)
    };
#undef FULLMAG_FEM_V2_REQUEST_OFFSET
#define FULLMAG_FEM_V2_OPERATOR_OFFSET(member) offsetof(FullmagFemLinearizedOperatorRequest, member),
    constexpr std::uint64_t operator_offsets[] = {
        FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_LIST(FULLMAG_FEM_V2_OPERATOR_OFFSET)
    };
#undef FULLMAG_FEM_V2_OPERATOR_OFFSET
#define FULLMAG_FEM_V2_PAYLOAD_OFFSET(member) offsetof(FullmagFemModalSharedDomainPayload, member),
    constexpr std::uint64_t payload_offsets[] = {
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_LIST(FULLMAG_FEM_V2_PAYLOAD_OFFSET)
    };
#undef FULLMAG_FEM_V2_PAYLOAD_OFFSET
#define FULLMAG_FEM_V2_RESULT_OFFSET(member) offsetof(FullmagFemFrequencyDomainResult, member),
    constexpr std::uint64_t result_offsets[] = {
        FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_LIST(FULLMAG_FEM_V2_RESULT_OFFSET)
    };
#undef FULLMAG_FEM_V2_RESULT_OFFSET
#define FULLMAG_FEM_V2_CSR_OFFSET(member) offsetof(FullmagFemCsrMatrixView, member),
    constexpr std::uint64_t csr_offsets[] = {
        FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_LIST(FULLMAG_FEM_V2_CSR_OFFSET)
    };
#undef FULLMAG_FEM_V2_CSR_OFFSET
#define FULLMAG_FEM_V2_V6_RELATION_OFFSET(member) \
    offsetof(FullmagFemModalCertificateV6Relation, member),
    constexpr std::uint64_t v6_relation_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_LIST(
            FULLMAG_FEM_V2_V6_RELATION_OFFSET)
    };
#undef FULLMAG_FEM_V2_V6_RELATION_OFFSET
#define FULLMAG_FEM_V2_V6_REGION_ROLE_OFFSET(member) \
    offsetof(FullmagFemModalCertificateV6RegionRole, member),
    constexpr std::uint64_t v6_region_role_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_LIST(
            FULLMAG_FEM_V2_V6_REGION_ROLE_OFFSET)
    };
#undef FULLMAG_FEM_V2_V6_REGION_ROLE_OFFSET
#define FULLMAG_FEM_V2_V6_CLASS_DIGEST_OFFSET(member) \
    offsetof(FullmagFemModalCertificateV6ClassDigest, member),
    constexpr std::uint64_t v6_class_digest_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_LIST(
            FULLMAG_FEM_V2_V6_CLASS_DIGEST_OFFSET)
    };
#undef FULLMAG_FEM_V2_V6_CLASS_DIGEST_OFFSET
#define FULLMAG_FEM_V2_V6_VIEW_OFFSET(member) \
    offsetof(FullmagFemModalCertificateV6View, member),
    constexpr std::uint64_t v6_view_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_LIST(FULLMAG_FEM_V2_V6_VIEW_OFFSET)
    };
#undef FULLMAG_FEM_V2_V6_VIEW_OFFSET
#define FULLMAG_FEM_V2_V6_BINDING_REQUEST_OFFSET(member) \
    offsetof(FullmagFemModalCertificateV6BindingRequest, member),
    constexpr std::uint64_t v6_binding_request_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_LIST(
            FULLMAG_FEM_V2_V6_BINDING_REQUEST_OFFSET)
    };
#undef FULLMAG_FEM_V2_V6_BINDING_REQUEST_OFFSET
    out_layout->modal_eigen_request_field_count = FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_COUNT;
    out_layout->modal_linearized_operator_request_field_count =
        FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_COUNT;
    out_layout->modal_shared_domain_payload_field_count =
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT;
    out_layout->modal_frequency_domain_result_field_count =
        FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_COUNT;
    out_layout->modal_csr_matrix_view_field_count = FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_COUNT;
    std::copy(request_offsets, request_offsets + FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_COUNT,
              out_layout->modal_eigen_request_field_offsets);
    std::copy(operator_offsets, operator_offsets + FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_COUNT,
              out_layout->modal_linearized_operator_request_field_offsets);
    std::copy(payload_offsets, payload_offsets + FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT,
              out_layout->modal_shared_domain_payload_field_offsets);
    std::copy(result_offsets, result_offsets + FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_COUNT,
              out_layout->modal_frequency_domain_result_field_offsets);
    std::copy(csr_offsets, csr_offsets + FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_COUNT,
              out_layout->modal_csr_matrix_view_field_offsets);
    out_layout->modal_certificate_v6_relation_size =
        sizeof(FullmagFemModalCertificateV6Relation);
    out_layout->modal_certificate_v6_relation_field_count =
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_COUNT;
    out_layout->modal_certificate_v6_region_role_size =
        sizeof(FullmagFemModalCertificateV6RegionRole);
    out_layout->modal_certificate_v6_region_role_field_count =
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_COUNT;
    out_layout->modal_certificate_v6_class_digest_size =
        sizeof(FullmagFemModalCertificateV6ClassDigest);
    out_layout->modal_certificate_v6_class_digest_field_count =
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_COUNT;
    out_layout->modal_certificate_v6_view_size = sizeof(FullmagFemModalCertificateV6View);
    out_layout->modal_certificate_v6_view_field_count =
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_COUNT;
    out_layout->modal_certificate_v6_binding_request_size =
        sizeof(FullmagFemModalCertificateV6BindingRequest);
    out_layout->modal_certificate_v6_binding_request_field_count =
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_COUNT;
    std::copy(v6_relation_offsets,
              v6_relation_offsets + FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_COUNT,
              out_layout->modal_certificate_v6_relation_field_offsets);
    std::copy(v6_region_role_offsets,
              v6_region_role_offsets + FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_COUNT,
              out_layout->modal_certificate_v6_region_role_field_offsets);
    std::copy(v6_class_digest_offsets,
              v6_class_digest_offsets + FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_COUNT,
              out_layout->modal_certificate_v6_class_digest_field_offsets);
    std::copy(v6_view_offsets,
              v6_view_offsets + FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_COUNT,
              out_layout->modal_certificate_v6_view_field_offsets);
    std::copy(v6_binding_request_offsets,
              v6_binding_request_offsets +
                  FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_COUNT,
              out_layout->modal_certificate_v6_binding_request_field_offsets);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_modal_abi_layout_v3(
    fullmag_fem_frequency_domain_modal_abi_layout_v3 *out_layout
) {
    static_assert(
        FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT <= 128u,
        "modal linearization descriptor manifest capacity must cover the append-only field list");
    if (out_layout == nullptr ||
        out_layout->v2.struct_size < sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v3)) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_modal_abi_layout_v3 requires its full v3 struct");
        return FULLMAG_FEM_ERR_INVALID;
    }

    *out_layout = {};
    out_layout->v2.struct_size = sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v2);
    if (fullmag_fem_get_frequency_domain_modal_abi_layout_v2(&out_layout->v2) != FULLMAG_FEM_OK) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    /* v3's nested envelope is the frozen V18 view: retain the v2 field
       ordering and append only the descriptor/material pointers. */
    out_layout->v2.modal_shared_domain_payload_size =
        offsetof(FullmagFemModalSharedDomainPayload, exchange_material_view) +
        sizeof(const FullmagFemModalExchangeMaterialView *);
    out_layout->v2.modal_shared_domain_payload_field_count =
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT + 2u;
    out_layout->v2.modal_shared_domain_payload_field_offsets[
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT] =
        offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor);
    out_layout->v2.modal_shared_domain_payload_field_offsets[
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT + 1u] =
        offsetof(FullmagFemModalSharedDomainPayload, exchange_material_view);

    out_layout->v2.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V3;
    out_layout->modal_linearization_descriptor_size =
        sizeof(FullmagFemModalLinearizationDescriptor);
    out_layout->modal_linearization_descriptor_field_count =
        FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT;
#define FULLMAG_FEM_V3_DESCRIPTOR_OFFSET(member) \
    offsetof(FullmagFemModalLinearizationDescriptor, member),
    constexpr std::uint64_t descriptor_offsets[] = {
        FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_LIST(
            FULLMAG_FEM_V3_DESCRIPTOR_OFFSET)
    };
#undef FULLMAG_FEM_V3_DESCRIPTOR_OFFSET
    std::copy(
        descriptor_offsets,
        descriptor_offsets + FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT,
        out_layout->modal_linearization_descriptor_field_offsets);
    out_layout->modal_exchange_material_view_size =
        sizeof(FullmagFemModalExchangeMaterialView);
    out_layout->modal_exchange_material_view_field_count =
        FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_COUNT;
#define FULLMAG_FEM_V3_MATERIAL_OFFSET(member) \
    offsetof(FullmagFemModalExchangeMaterialView, member),
    constexpr std::uint64_t material_view_offsets[] = {
        FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_LIST(
            FULLMAG_FEM_V3_MATERIAL_OFFSET)
    };
#undef FULLMAG_FEM_V3_MATERIAL_OFFSET
    std::copy(
        material_view_offsets,
        material_view_offsets + FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_COUNT,
        out_layout->modal_exchange_material_view_field_offsets);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_modal_abi_layout_v4(
    fullmag_fem_frequency_domain_modal_abi_layout_v4 *out_layout
) {
    static_assert(
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT + 2u + 6u <= 128u,
        "modal v4 payload manifest capacity must cover the acceptance tail");
    if (out_layout == nullptr ||
        out_layout->v3.v2.struct_size <
            sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v4)) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_modal_abi_layout_v4 requires its full v4 struct");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_layout = {};
    out_layout->v3.v2.struct_size =
        sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v3);
    if (fullmag_fem_get_frequency_domain_modal_abi_layout_v3(&out_layout->v3) !=
        FULLMAG_FEM_OK) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    constexpr std::uint64_t acceptance_offsets[] = {
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_criterion),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_metric_kind),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_unit),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_metric_value),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_threshold),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_certificate_sha256),
    };
    constexpr std::size_t acceptance_field_count =
        sizeof(acceptance_offsets) / sizeof(acceptance_offsets[0]);
    out_layout->v3.v2.modal_shared_domain_payload_size =
        sizeof(FullmagFemModalSharedDomainPayload);
    out_layout->v3.v2.modal_shared_domain_payload_field_count +=
        acceptance_field_count;
    std::copy(
        acceptance_offsets,
        acceptance_offsets + acceptance_field_count,
        out_layout->v3.v2.modal_shared_domain_payload_field_offsets +
            FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT + 2u);
    out_layout->v3.v2.abi_version =
        FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V4;
    out_layout->v3.v2.modal_abi_schema = 4u;
    out_layout->modal_acceptance_certificate_field_count =
        acceptance_field_count;
    std::copy(
        acceptance_offsets,
        acceptance_offsets + acceptance_field_count,
        out_layout->modal_acceptance_certificate_field_offsets);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_frequency_domain_modal_abi_layout_v5(
    fullmag_fem_frequency_domain_modal_abi_layout_v5 *out_layout
) {
    static_assert(
        FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_FIELD_COUNT <= 128u,
        "modal GPU attestation manifest capacity must cover V1");
    if (out_layout == nullptr ||
        out_layout->v4.v3.v2.struct_size <
            sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v5)) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_modal_abi_layout_v5 requires its full v5 struct");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_layout = {};
    out_layout->v4.v3.v2.struct_size =
        sizeof(fullmag_fem_frequency_domain_modal_abi_layout_v4);
    if (fullmag_fem_get_frequency_domain_modal_abi_layout_v4(&out_layout->v4) !=
        FULLMAG_FEM_OK) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    constexpr std::uint64_t result_offsets[] = {
        offsetof(FullmagFemFrequencyDomainResultV20, abi_version),
        offsetof(FullmagFemFrequencyDomainResultV20, struct_size),
        offsetof(FullmagFemFrequencyDomainResultV20, scientific_result_v18),
        offsetof(FullmagFemFrequencyDomainResultV20, gpu_attestation),
    };
#define FULLMAG_FEM_V5_ATTESTATION_OFFSET(member) \
    offsetof(FullmagFemModalGpuAttestationV1, member),
    constexpr std::uint64_t attestation_offsets[] = {
        FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_FIELD_LIST(
            FULLMAG_FEM_V5_ATTESTATION_OFFSET)
    };
#undef FULLMAG_FEM_V5_ATTESTATION_OFFSET
    out_layout->modal_frequency_domain_result_v20_size =
        sizeof(FullmagFemFrequencyDomainResultV20);
    out_layout->modal_frequency_domain_result_v20_align =
        alignof(FullmagFemFrequencyDomainResultV20);
    out_layout->modal_frequency_domain_result_v20_field_count =
        sizeof(result_offsets) / sizeof(result_offsets[0]);
    std::copy(
        result_offsets,
        result_offsets + sizeof(result_offsets) / sizeof(result_offsets[0]),
        out_layout->modal_frequency_domain_result_v20_field_offsets);
    out_layout->modal_gpu_attestation_v1_size = sizeof(FullmagFemModalGpuAttestationV1);
    out_layout->modal_gpu_attestation_v1_align = alignof(FullmagFemModalGpuAttestationV1);
    out_layout->modal_gpu_attestation_v1_field_count =
        sizeof(attestation_offsets) / sizeof(attestation_offsets[0]);
    std::copy(
        attestation_offsets,
        attestation_offsets + sizeof(attestation_offsets) / sizeof(attestation_offsets[0]),
        out_layout->modal_gpu_attestation_v1_field_offsets);
    out_layout->v4.v3.v2.abi_version =
        FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V5;
    out_layout->v4.v3.v2.modal_abi_schema = 5u;
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_mesh_abi_layout(fullmag_fem_mesh_abi_layout *out_layout)
{
    if (out_layout == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_mesh_abi_layout received null out_layout");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_layout = fullmag_fem_mesh_abi_record_v1.layout;
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_initial_sweep_progress(
    uint64_t total_frequency_points,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_initial_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::initial_sweep_progress(total_frequency_points);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_interrupted_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_interrupted_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::interrupted_sweep_progress(
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_cancelling_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_cancelling_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::cancelling_sweep_progress(
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_completed_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_completed_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::completed_sweep_progress(
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

static int fullmag_fem_frequency_domain_solve_driven_response_from_c_abi(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_apply_with_potential_callback mfem_apply_demag_tangent_with_potential,
    fullmag_fem_frequency_domain_solve_result *out_result
) {
    if (request == nullptr || out_result == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_solve_driven_response requires non-null request and out_result");
        return FULLMAG_FEM_ERR_INVALID;
    }

    namespace fd = fullmag::fem::frequency_domain;
    const bool strict_request_contract =
        request->abi_version != 0 || request->struct_size != 0;
    if (request->abi_version != 0 &&
        request->abi_version != 9u &&
        request->abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION &&
        request->abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION &&
        request->abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION &&
        request->abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "unsupported frequency-domain driven-response request ABI version")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid frequency-domain request ABI result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    if (request->struct_size != 0 &&
        request->struct_size != sizeof(fullmag_fem_frequency_domain_driven_response_request)) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "unsupported frequency-domain driven-response request struct_size")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid frequency-domain request size result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    if (strict_request_contract &&
        request->mfem_operator_enabled != 0 &&
        request->mfem_equilibrium_m != nullptr &&
        request->node_count > std::numeric_limits<std::uint64_t>::max() / 3) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "node_count is too large for MFEM equilibrium length validation")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid MFEM equilibrium overflow result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    if (strict_request_contract &&
        request->mfem_operator_enabled != 0 &&
        request->mfem_equilibrium_m != nullptr &&
        request->mfem_equilibrium_m_value_count < request->node_count * 3) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "mfem_equilibrium_m_value_count is smaller than 3 * node_count")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid MFEM equilibrium length result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    fd::DrivenFrequencyResponseSolveRequest native_request{};
    std::vector<fd::TangentFrameNode> frequency_domain_tangent_nodes;
    std::vector<fd::TangentOperatorEdgeBlock> frequency_domain_exchange_edges;
    std::vector<fd::MfemDmiElementTangentData> frequency_domain_dmi_elements;
    std::vector<std::uint64_t> frequency_domain_static_periodic_node_pairs;
    std::vector<std::uint64_t> frequency_domain_periodic_airbox_magnetostatic_periodic_node_pairs;
    std::vector<fd::FrequencyDomainFloquetPeriodicPair> frequency_domain_floquet_periodic_pairs;
    const DrivenResponseCAbiDemagTangentContext demag_tangent_context{
        request,
        mfem_apply_demag_tangent_with_potential,
    };
    native_request.abi_version = request->abi_version == 0
        ? 0
        : fd::kDrivenFrequencyResponseSolveRequestAbiVersion;
    native_request.reserved_contract_flags = request->reserved_contract_flags;
    native_request.struct_size = request->struct_size == 0
        ? 0
        : sizeof(fd::DrivenFrequencyResponseSolveRequest);
    native_request.solver_options.relative_tolerance =
        request->solver_relative_tolerance;
    native_request.solver_options.absolute_tolerance =
        request->solver_absolute_tolerance;
    native_request.solver_options.max_iterations =
        request->solver_max_iterations;
    native_request.solver_options.restart_iterations =
        request->solver_restart_iterations;
    native_request.solver_options.progress_interval_iterations =
        request->solver_progress_interval_iterations;
    native_request.solve_request.operator_request.node_count = request->node_count;
    native_request.solve_request.operator_request.tangent_dof_count =
        request->tangent_dof_count;
    native_request.solve_request.operator_request.alpha = request->alpha;
    native_request.solve_request.operator_request.gamma0 = request->gamma0;
    if (!from_abi_frequency_domain_execution_lane(
            request->requested_execution_lane,
            &native_request.execution_lane)) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "invalid frequency-domain execution lane")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid frequency-domain execution-lane result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    native_request.solve_request.frequencies_hz = request->frequencies_hz;
    native_request.solve_request.frequency_count = request->frequency_count;
    native_request.solve_request.write_response_fields =
        request->write_response_fields != 0;
    native_request.output_directory = request->output_directory;
    native_request.write_partial_artifacts = request->write_partial_artifacts != 0;
    native_request.operator_diagnostics_json = request->operator_diagnostics_json;
    native_request.has_floquet_k_vector = request->has_floquet_k_vector != 0;
    native_request.floquet_k_vector_rad_per_m[0] =
        request->floquet_k_vector_rad_per_m[0];
    native_request.floquet_k_vector_rad_per_m[1] =
        request->floquet_k_vector_rad_per_m[1];
    native_request.floquet_k_vector_rad_per_m[2] =
        request->floquet_k_vector_rad_per_m[2];
    if (!from_abi_frequency_domain_phase_convention(
            request->phase_convention,
            &native_request.phase_convention)) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "invalid frequency-domain phase convention")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid frequency-domain phase-convention result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    native_request.solve_request.phase_convention = native_request.phase_convention;
    if (!from_abi_frequency_domain_drive_kind(
            request->drive_kind,
            &native_request.drive_kind)) {
        if (!fill_frequency_domain_validation_result(
                out_result,
                request->frequency_count,
                "invalid frequency-domain drive kind")) {
            fullmag_fem_set_global_error(
                "failed to allocate invalid frequency-domain drive-kind result");
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    }
    native_request.require_nonzero_rhs = request->require_nonzero_rhs != 0;
    native_request.floquet_periodic_pair_count =
        request->mfem_floquet_periodic_pair_count;
    if (request->mfem_floquet_periodic_pair_count > 0 &&
        request->mfem_floquet_periodic_pairs != nullptr) {
        frequency_domain_floquet_periodic_pairs.reserve(
            static_cast<std::size_t>(request->mfem_floquet_periodic_pair_count));
        for (std::uint64_t pair_index = 0;
             pair_index < request->mfem_floquet_periodic_pair_count;
             ++pair_index) {
            const fullmag_fem_frequency_domain_floquet_periodic_pair &source =
                request->mfem_floquet_periodic_pairs[pair_index];
            fd::FrequencyDomainFloquetPeriodicPair target{};
            target.pair_id = source.pair_id;
            target.node_a = source.node_a;
            target.node_b = source.node_b;
            target.has_translation = source.has_translation != 0;
            target.translation_m[0] = source.translation_m[0];
            target.translation_m[1] = source.translation_m[1];
            target.translation_m[2] = source.translation_m[2];
            target.has_phase = source.has_phase != 0;
            target.phase_rad = source.phase_rad;
            frequency_domain_floquet_periodic_pairs.push_back(target);
        }
        native_request.floquet_periodic_pairs =
            frequency_domain_floquet_periodic_pairs.data();
    }
    native_request.requires_periodic_airbox_dynamic_demag =
        request->requires_periodic_airbox_dynamic_demag != 0;
    native_request.requires_floquet_airbox_dynamic_demag =
        request->requires_floquet_airbox_dynamic_demag != 0;
    native_request.magnetic_periodic_constraint_set_count =
        request->magnetic_periodic_constraint_set_count;
    native_request.magnetostatic_periodic_constraint_set_count =
        request->magnetostatic_periodic_constraint_set_count;
    native_request.periodic_airbox_delta_m_tangent_dof_count =
        request->periodic_airbox_delta_m_tangent_dof_count;
    native_request.periodic_airbox_delta_phi_dof_count =
        request->periodic_airbox_delta_phi_dof_count;
    native_request.periodic_airbox_magnetostatic_periodic_node_pair_count =
        request->periodic_airbox_magnetostatic_periodic_node_pair_count;
    if (request->periodic_airbox_magnetostatic_periodic_node_pair_count > 0 &&
        request->periodic_airbox_magnetostatic_periodic_node_pairs != nullptr) {
        frequency_domain_periodic_airbox_magnetostatic_periodic_node_pairs.reserve(
            static_cast<std::size_t>(
                request->periodic_airbox_magnetostatic_periodic_node_pair_count * 2));
        for (std::uint64_t pair_index = 0;
             pair_index < request->periodic_airbox_magnetostatic_periodic_node_pair_count;
             ++pair_index) {
            const fullmag_fem_frequency_domain_periodic_node_pair &source =
                request->periodic_airbox_magnetostatic_periodic_node_pairs[pair_index];
            frequency_domain_periodic_airbox_magnetostatic_periodic_node_pairs.push_back(source.node_a);
            frequency_domain_periodic_airbox_magnetostatic_periodic_node_pairs.push_back(source.node_b);
        }
        native_request.periodic_airbox_magnetostatic_periodic_node_pairs =
            frequency_domain_periodic_airbox_magnetostatic_periodic_node_pairs.data();
    }
    native_request.periodic_airbox_coupled_block_problem.enabled =
        request->periodic_airbox_coupled_block_enabled != 0;
    native_request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count =
        request->periodic_airbox_coupled_block_delta_m_tangent_dof_count;
    native_request.periodic_airbox_coupled_block_problem.delta_phi_dof_count =
        request->periodic_airbox_coupled_block_delta_phi_dof_count;
    native_request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major =
        request->periodic_airbox_coupled_block_stiffness_matrix_row_major;
    native_request.periodic_airbox_coupled_block_problem.stiffness_matrix_value_count =
        request->periodic_airbox_coupled_block_stiffness_matrix_value_count;
    native_request.periodic_airbox_coupled_block_problem.mass_matrix_row_major =
        request->periodic_airbox_coupled_block_mass_matrix_row_major;
    native_request.periodic_airbox_coupled_block_problem.mass_matrix_value_count =
        request->periodic_airbox_coupled_block_mass_matrix_value_count;
    if (request->periodic_airbox_coupled_block_apply_stiffness != nullptr ||
        request->periodic_airbox_coupled_block_apply_mass != nullptr) {
        native_request.periodic_airbox_coupled_block_problem.apply_stiffness =
            frequency_domain_periodic_airbox_apply_stiffness_from_c_abi;
        native_request.periodic_airbox_coupled_block_problem.apply_mass =
            frequency_domain_periodic_airbox_apply_mass_from_c_abi;
        native_request.periodic_airbox_coupled_block_problem.operator_user_data =
            const_cast<fullmag_fem_frequency_domain_driven_response_request *>(request);
    }
    if (request->periodic_airbox_coupled_block_apply_complex_stiffness != nullptr ||
        request->periodic_airbox_coupled_block_apply_complex_mass != nullptr) {
        native_request.periodic_airbox_coupled_block_problem.apply_complex_stiffness =
            frequency_domain_periodic_airbox_apply_complex_stiffness_from_c_abi;
        native_request.periodic_airbox_coupled_block_problem.apply_complex_mass =
            frequency_domain_periodic_airbox_apply_complex_mass_from_c_abi;
        native_request.periodic_airbox_coupled_block_problem.operator_user_data =
            const_cast<fullmag_fem_frequency_domain_driven_response_request *>(request);
    }
    native_request.periodic_airbox_coupled_block_problem.drive_real =
        request->periodic_airbox_coupled_block_drive_real;
    native_request.periodic_airbox_coupled_block_problem.drive_real_value_count =
        request->periodic_airbox_coupled_block_drive_real_value_count;
    native_request.periodic_airbox_coupled_block_problem.drive_imag =
        request->periodic_airbox_coupled_block_drive_imag;
    native_request.periodic_airbox_coupled_block_problem.drive_imag_value_count =
        request->periodic_airbox_coupled_block_drive_imag_value_count;
    if (request->mfem_apply_demag_tangent != nullptr) {
        native_request.mfem_validation_problem.apply_demag_tangent =
            frequency_domain_mfem_apply_demag_tangent_from_c_abi;
        native_request.mfem_validation_problem.demag_tangent_user_data =
            const_cast<DrivenResponseCAbiDemagTangentContext *>(&demag_tangent_context);
    }
    if (mfem_apply_demag_tangent_with_potential != nullptr) {
        native_request.mfem_validation_problem.apply_demag_tangent_with_potential =
            frequency_domain_mfem_apply_demag_tangent_with_potential_from_c_abi;
        native_request.mfem_validation_problem.demag_tangent_user_data =
            const_cast<DrivenResponseCAbiDemagTangentContext *>(&demag_tangent_context);
    }
    native_request.mfem_validation_problem.demag_tangent_matrix_row_major =
        request->mfem_demag_tangent_matrix_row_major;
    native_request.mfem_validation_problem.demag_tangent_matrix_value_count =
        request->mfem_demag_tangent_matrix_value_count;
    if (request->cancel_requested != nullptr) {
        native_request.cancel_requested = frequency_domain_cancel_requested_from_c_abi;
        native_request.cancel_user_data = const_cast<fullmag_fem_frequency_domain_driven_response_request *>(request);
    }
    if (request->progress_callback != nullptr) {
        native_request.progress_callback = frequency_domain_progress_from_c_abi;
        native_request.progress_user_data = const_cast<fullmag_fem_frequency_domain_driven_response_request *>(request);
    }
    native_request.tiny_validation_problem.enabled =
        request->tiny_validation_enabled != 0;
    native_request.tiny_validation_problem.tangent_dof_count =
        request->tiny_validation_tangent_dof_count;
    native_request.tiny_validation_problem.stiffness_matrix_row_major =
        request->tiny_validation_stiffness_matrix_row_major;
    native_request.tiny_validation_problem.stiffness_matrix_value_count =
        request->tiny_validation_stiffness_matrix_value_count;
    native_request.tiny_validation_problem.mass_matrix_row_major =
        request->tiny_validation_mass_matrix_row_major;
    native_request.tiny_validation_problem.mass_matrix_value_count =
        request->tiny_validation_mass_matrix_value_count;
    native_request.tiny_validation_problem.stiffness_diagonal =
        request->tiny_validation_stiffness_diagonal;
    native_request.tiny_validation_problem.stiffness_diagonal_value_count =
        request->tiny_validation_stiffness_diagonal_value_count;
    native_request.tiny_validation_problem.mass_diagonal =
        request->tiny_validation_mass_diagonal;
    native_request.tiny_validation_problem.mass_diagonal_value_count =
        request->tiny_validation_mass_diagonal_value_count;
    native_request.tiny_validation_problem.drive_real =
        request->tiny_validation_drive_real;
    native_request.tiny_validation_problem.drive_real_value_count =
        request->tiny_validation_drive_real_value_count;
    native_request.tiny_validation_problem.drive_imag =
        request->tiny_validation_drive_imag;
    native_request.tiny_validation_problem.drive_imag_value_count =
        request->tiny_validation_drive_imag_value_count;
    if (request->mfem_operator_enabled != 0) {
        native_request.solve_request.operator_request.include_zeeman =
            request->mfem_include_zeeman != 0;
        native_request.mfem_validation_problem.enabled = true;
        native_request.mfem_validation_problem.descriptor.node_count =
            request->node_count;
        native_request.mfem_validation_problem.descriptor.full_dof_count =
            request->node_count * 3;
        native_request.mfem_validation_problem.descriptor.tangent_dof_count =
            request->tangent_dof_count;
        native_request.mfem_validation_problem.descriptor.zeeman_enabled =
            request->mfem_include_zeeman != 0;
        native_request.mfem_validation_problem.descriptor.exchange_enabled =
            request->mfem_exchange_edge_count > 0 &&
            request->mfem_exchange_edges != nullptr;
        native_request.mfem_validation_problem.descriptor.dmi_enabled =
            request->mfem_dmi_element_count > 0 &&
            request->mfem_dmi_elements != nullptr;
        const bool has_mfem_demag_tangent =
            request->mfem_apply_demag_tangent != nullptr ||
            mfem_apply_demag_tangent_with_potential != nullptr ||
            request->mfem_demag_tangent_matrix_row_major != nullptr;
        native_request.mfem_validation_problem.descriptor.demag_enabled =
            has_mfem_demag_tangent;
        native_request.mfem_validation_problem.descriptor.demag_kind =
            has_mfem_demag_tangent ?
                fd::FrequencyDomainDemagKind::static_k0 :
                fd::FrequencyDomainDemagKind::none;
        native_request.mfem_validation_problem.descriptor.uniaxial_anisotropy_enabled =
            request->mfem_uniaxial_anisotropy_axis != nullptr &&
            request->mfem_uniaxial_anisotropy_field_a_per_m != 0.0;
        native_request.mfem_validation_problem.descriptor.element_count =
            request->mfem_dmi_elements != nullptr ? request->mfem_dmi_element_count : 0;
        native_request.mfem_validation_problem.descriptor.element_node_count =
            (request->mfem_dmi_element_count > 0 &&
             request->mfem_dmi_elements != nullptr) ? 4 : 0;
        native_request.mfem_validation_problem.descriptor.mfem_mesh_available = true;
        native_request.mfem_validation_problem.layout.node_count =
            request->node_count;
        native_request.mfem_validation_problem.layout.full_dof_count =
            request->node_count * 3;
        native_request.mfem_validation_problem.layout.tangent_dof_count =
            request->tangent_dof_count;
        native_request.mfem_validation_problem.layout.tangent_components_per_node = 2;
        native_request.mfem_validation_problem.layout.tangent_stride = 2;
        native_request.mfem_validation_problem.h_ext_a_per_m =
            request->mfem_h_ext_a_per_m;
        native_request.mfem_validation_problem.h_ext_value_count =
            request->mfem_h_ext_value_count;
        native_request.mfem_validation_problem.uniaxial_anisotropy_axis =
            request->mfem_uniaxial_anisotropy_axis;
        native_request.mfem_validation_problem.uniaxial_anisotropy_axis_value_count =
            request->mfem_uniaxial_anisotropy_axis_value_count;
        native_request.mfem_validation_problem.uniaxial_anisotropy_field_a_per_m =
            request->mfem_uniaxial_anisotropy_field_a_per_m;
        native_request.mfem_validation_problem.alpha_per_node =
            request->mfem_alpha_per_node;
        native_request.mfem_validation_problem.alpha_value_count =
            request->mfem_alpha_value_count;
        native_request.mfem_validation_problem.drive_real =
            request->mfem_drive_real;
        native_request.mfem_validation_problem.drive_real_value_count =
            request->mfem_drive_real_value_count;
        native_request.mfem_validation_problem.drive_imag =
            request->mfem_drive_imag;
        native_request.mfem_validation_problem.drive_imag_value_count =
            request->mfem_drive_imag_value_count;
        native_request.mfem_validation_problem.static_periodic_node_pair_count =
            request->mfem_static_periodic_node_pair_count;
        if (request->mfem_static_periodic_node_pair_count > 0 &&
            request->mfem_static_periodic_node_pairs != nullptr) {
            frequency_domain_static_periodic_node_pairs.reserve(
                static_cast<std::size_t>(
                    request->mfem_static_periodic_node_pair_count * 2));
            for (std::uint64_t pair_index = 0;
                 pair_index < request->mfem_static_periodic_node_pair_count;
                 ++pair_index) {
                const fullmag_fem_frequency_domain_periodic_node_pair &source =
                    request->mfem_static_periodic_node_pairs[pair_index];
                frequency_domain_static_periodic_node_pairs.push_back(source.node_a);
                frequency_domain_static_periodic_node_pairs.push_back(source.node_b);
            }
            native_request.mfem_validation_problem.static_periodic_node_pairs =
                frequency_domain_static_periodic_node_pairs.data();
        }
        native_request.mfem_validation_problem.dmi_lumped_mass =
            request->mfem_dmi_lumped_mass;
        native_request.mfem_validation_problem.dmi_lumped_mass_value_count =
            request->mfem_dmi_lumped_mass_value_count;
        native_request.mfem_validation_problem.dmi_ms_field =
            request->mfem_dmi_ms_field;
        native_request.mfem_validation_problem.dmi_ms_field_value_count =
            request->mfem_dmi_ms_field_value_count;
        native_request.mfem_validation_problem.dmi_uniform_ms =
            request->mfem_dmi_uniform_ms;
        native_request.mfem_validation_problem.observable_ms_field =
            request->mfem_observable_ms_field;
        native_request.mfem_validation_problem.observable_ms_field_len =
            request->mfem_observable_ms_field_len;
        native_request.mfem_validation_problem.observable_uniform_ms =
            request->mfem_observable_uniform_ms;
        if (request->mfem_exchange_edge_count > 0 &&
            request->mfem_exchange_edges != nullptr) {
            frequency_domain_exchange_edges.reserve(
                static_cast<std::size_t>(request->mfem_exchange_edge_count));
            for (std::uint64_t edge_index = 0;
                 edge_index < request->mfem_exchange_edge_count;
                 ++edge_index) {
                const fullmag_fem_frequency_domain_exchange_edge &edge =
                    request->mfem_exchange_edges[edge_index];
                frequency_domain_exchange_edges.push_back(fd::TangentOperatorEdgeBlock{
                    fd::FrequencyDomainOperatorTermKind::exchange,
                    edge.node_i,
                    edge.node_j,
                    edge.stiffness,
                });
            }
            native_request.mfem_validation_problem.exchange_edges =
                frequency_domain_exchange_edges.data();
            native_request.mfem_validation_problem.exchange_edge_count =
                request->mfem_exchange_edge_count;
        }
        if (request->mfem_dmi_element_count > 0 &&
            request->mfem_dmi_elements != nullptr) {
            frequency_domain_dmi_elements.reserve(
                static_cast<std::size_t>(request->mfem_dmi_element_count));
            for (std::uint64_t element_index = 0;
                 element_index < request->mfem_dmi_element_count;
                 ++element_index) {
                const fullmag_fem_frequency_domain_dmi_element &source =
                    request->mfem_dmi_elements[element_index];
                fd::MfemDmiElementTangentData target{};
                switch (source.kind) {
                case FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_INTERFACIAL:
                    target.kind = fd::MfemDmiInteractionKind::interfacial;
                    break;
                case FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK:
                    target.kind = fd::MfemDmiInteractionKind::bulk;
                    break;
                default:
                    target.kind = static_cast<fd::MfemDmiInteractionKind>(-1);
                    break;
                }
                for (int local_node = 0; local_node < 4; ++local_node) {
                    target.node_indices[local_node] =
                        source.node_indices[local_node];
                    target.shape[local_node] = source.shape[local_node];
                    for (int axis = 0; axis < 3; ++axis) {
                        target.grad_shape[local_node][axis] =
                            source.grad_shape[local_node * 3 + axis];
                    }
                }
                target.weight = source.weight;
                target.d = source.d;
                for (int axis = 0; axis < 3; ++axis) {
                    target.normal[axis] = source.normal[axis];
                }
                frequency_domain_dmi_elements.push_back(target);
            }
            native_request.mfem_validation_problem.dmi_elements =
                frequency_domain_dmi_elements.data();
            native_request.mfem_validation_problem.dmi_element_count =
                request->mfem_dmi_element_count;
        }
        if (request->mfem_equilibrium_m != nullptr && request->node_count > 0) {
            frequency_domain_tangent_nodes.resize(
                static_cast<std::size_t>(request->node_count));
            fd::TangentFrameDiagnostics tangent_diagnostics{};
            const fd::FrequencyDomainStatus tangent_status = fd::build_tangent_frame(
                    request->mfem_equilibrium_m,
                    request->node_count,
                    frequency_domain_tangent_nodes.data(),
                    &tangent_diagnostics);
            if (tangent_status != fd::FrequencyDomainStatus::ok) {
                char error_message[192]{};
                std::snprintf(
                    error_message,
                    sizeof(error_message),
                    "invalid MFEM frequency-domain equilibrium magnetization: %s",
                    tangent_diagnostics.error_message);
                if (!fill_frequency_domain_validation_result(
                        out_result,
                        request->frequency_count,
                        error_message)) {
                    fullmag_fem_set_global_error(
                        "failed to allocate invalid MFEM equilibrium result");
                    return FULLMAG_FEM_ERR_INTERNAL;
                }
                fullmag_fem_clear_global_error();
                return FULLMAG_FEM_OK;
            }
            native_request.mfem_validation_problem.nodes =
                frequency_domain_tangent_nodes.data();
            native_request.mfem_validation_problem.node_count =
                request->node_count;
        }
    }

    fd::DrivenFrequencyResponseSolveResult native_result{};
    fd::solve_driven_frequency_response(native_request, &native_result);
    copy_frequency_domain_solve_result(native_result, out_result);
    fd::release_driven_frequency_response_result(&native_result);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_solve_driven_response(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_solve_result *out_result
) {
    return fullmag_fem_frequency_domain_solve_driven_response_from_c_abi(
        request,
        nullptr,
        out_result);
}

int fullmag_fem_frequency_domain_solve_driven_response_v9(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_apply_with_potential_callback mfem_apply_demag_tangent_with_potential,
    fullmag_fem_frequency_domain_solve_result *out_result
) {
    return fullmag_fem_frequency_domain_solve_driven_response_from_c_abi(
        request,
        mfem_apply_demag_tangent_with_potential,
        out_result);
}

int fullmag_fem_frequency_domain_solve_driven_response_v10(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_apply_with_potential_callback mfem_apply_demag_tangent_with_potential,
    fullmag_fem_frequency_domain_solve_result *out_result
) {
    return fullmag_fem_frequency_domain_solve_driven_response_from_c_abi(
        request,
        mfem_apply_demag_tangent_with_potential,
        out_result);
}

void fullmag_fem_frequency_domain_solve_result_release(
    fullmag_fem_frequency_domain_solve_result *result
) {
    if (result == nullptr) {
        return;
    }
    delete[] result->error_message;
    delete[] result->diagnostics_json;
    delete[] result->result_json;
    delete[] result->artifact_manifest_path;
    *result = {};
}

static FullmagFemFrequencyDomainResult fullmag_fem_modal_eigen_solve_impl(
    const FullmagFemModalEigenRequest *request,
    bool caller_supports_v20,
    fullmag::fem::frequency_domain::ModalGpuExecutionAttestation *out_gpu_attestation
)
{
    if (out_gpu_attestation != nullptr) {
        *out_gpu_attestation = {};
    }
    if (request == nullptr) {
        return copy_frequency_domain_contract_result(
            fullmag::fem::frequency_domain::solve_modal_eigen_contract({}));
    }

    namespace fd = fullmag::fem::frequency_domain;
    const auto validation_error = [](
                                      const char *message,
                                      const char *reason,
                                      std::uint32_t certificate_binding_status =
                                          FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED,
                                      const char *canonical_preimage_sha256 = "",
                                      const char *certificate_binding_reason = "none") {
        fd::FrequencyDomainContractResult invalid{};
        invalid.status = fd::FrequencyDomainStatus::validation_error;
        invalid.modal_execution.execution_target =
            FULLMAG_FEM_MODAL_EXECUTION_VALIDATION;
        invalid.modal_execution.scalar_representation =
            FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE;
        invalid.modal_execution.spectral_transform_kind =
            FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO;
        invalid.modal_execution.fallback_state = fd::ModalResolvedFallbackState::none;
        invalid.modal_execution.engine_id = "validation_error";
        invalid.modal_execution.fallback_reason = "none";
        invalid.certificate_binding.status = certificate_binding_status;
        invalid.certificate_binding.canonical_preimage_sha256 =
            canonical_preimage_sha256 != nullptr ? canonical_preimage_sha256 : "";
        invalid.certificate_binding.reason =
            certificate_binding_reason != nullptr ? certificate_binding_reason : "none";
        invalid.error_message = message;
        invalid.diagnostics_json =
            std::string("{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\",") +
            "\"study_product\":\"modal_eigen\",\"status\":\"validation_error\",\"reason\":\"" +
            reason + "\"}";
        invalid.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"status\":\"validation_error\"}";
        return copy_frequency_domain_contract_result(invalid);
    };
    const auto supported_public_modal_abi = [](std::uint32_t version) noexcept {
        return version == FULLMAG_FEM_FREQUENCY_DOMAIN_V15_ABI_VERSION ||
            version == FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION ||
            version == FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION ||
            version == FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION ||
            version == FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    };
    /* Read only the mandatory ABI discriminant before this gate.  An unknown
       producer must not cause the boundary to inspect optional tail fields
       whose layout is not known to this build. */
    if (!supported_public_modal_abi(request->abi_version)) {
        return validation_error(
            "native FEM modal_eigen request uses an unknown public ABI version",
            "unknown_abi");
    }
    std::uint32_t accepted_certificate_binding_status =
        FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED;
    std::string accepted_certificate_binding_digest;
    std::string accepted_certificate_binding_reason = "none";
    constexpr std::size_t kModalV15MinimumStructSize =
        offsetof(FullmagFemModalEigenRequest, result_field_representation) +
        sizeof(fullmag_fem_modal_result_field_representation);
    constexpr std::size_t kModalV16SharedPayloadRequestSize =
        offsetof(FullmagFemModalEigenRequest, shared_domain_payload) +
        sizeof(request->shared_domain_payload);
    constexpr std::size_t kModalV17CertificateRequestSize =
        offsetof(FullmagFemModalEigenRequest, canonical_preimage_sha256) +
        sizeof(request->canonical_preimage_sha256);
    constexpr std::size_t kModalOperatorAbiPrefixSize =
        offsetof(FullmagFemModalEigenRequest, operator_request) +
        offsetof(FullmagFemLinearizedOperatorRequest, abi_version) +
        sizeof(request->operator_request.abi_version);
    const bool known_modal_abi =
        request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V15_ABI_VERSION &&
        request->abi_version <= FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    if (request->struct_size == 0u) {
        return validation_error(
            "native FEM modal_eigen request has no declared struct_size",
            "struct_size_too_small");
    }
    if (request->struct_size < kModalOperatorAbiPrefixSize) {
        return validation_error(
            "native FEM modal_eigen request has a struct_size shorter than the mandatory operator ABI prefix",
            "struct_size_too_small");
    }
    const bool has_modal_v15_tail =
        known_modal_abi &&
        request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V15_ABI_VERSION &&
        request->struct_size >= kModalV15MinimumStructSize;
    if (known_modal_abi &&
        request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V15_ABI_VERSION &&
        request->struct_size < kModalV15MinimumStructSize) {
        return validation_error(
            "native FEM modal_eigen request has a struct_size shorter than the v15 typed tail",
            "struct_size_too_small");
    }
    if (known_modal_abi &&
        request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION &&
        request->struct_size < kModalV16SharedPayloadRequestSize) {
        return validation_error(
            "native FEM modal_eigen request has a struct_size shorter than the v16 shared payload tail",
            "struct_size_too_small");
    }
    const bool has_shared_payload_tail =
        known_modal_abi &&
        request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION &&
        request->struct_size >= kModalV16SharedPayloadRequestSize;
    if (known_modal_abi && request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION &&
        request->struct_size < kModalV17CertificateRequestSize) {
        return validation_error(
            "native FEM modal_eigen request has a struct_size shorter than the v17 certificate tail",
            "struct_size_too_small");
    }
    if (!supported_public_modal_abi(request->operator_request.abi_version)) {
        return validation_error(
            "native FEM modal_eigen operator request uses an unknown public ABI version",
            "unknown_abi");
    }
    const bool has_modal_v17_certificate_tail =
        known_modal_abi &&
        request->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION &&
        request->struct_size >= kModalV17CertificateRequestSize;
    if (has_shared_payload_tail && request->shared_domain_payload != nullptr) {
        const FullmagFemModalSharedDomainPayload *payload = request->shared_domain_payload;
        constexpr std::size_t kModalPayloadCertificateTailSize =
            offsetof(FullmagFemModalSharedDomainPayload, airbox_part_identity) +
            sizeof(payload->airbox_part_identity);
        constexpr std::size_t kModalPayloadV17CertificateTailSize =
            offsetof(FullmagFemModalSharedDomainPayload, certificate_binding_reason) +
            sizeof(payload->certificate_binding_reason);
        constexpr std::size_t kModalPayloadV6RelationViewTailSize =
            offsetof(FullmagFemModalSharedDomainPayload, certificate_binding_v6) +
            sizeof(payload->certificate_binding_v6);
        constexpr std::size_t kModalPayloadV18LinearizationDescriptorTailSize =
            offsetof(FullmagFemModalSharedDomainPayload, exchange_material_view) +
            sizeof(payload->exchange_material_view);
        constexpr std::size_t kModalPayloadV19AcceptanceCertificateTailSize =
            offsetof(FullmagFemModalSharedDomainPayload, acceptance_certificate_sha256) +
            sizeof(payload->acceptance_certificate_sha256);
        const auto nonempty = [](const char *value) {
            return value != nullptr && value[0] != '\0';
        };
        const auto sha256_digest = [](const char *value) {
            if (value == nullptr || std::strlen(value) != 71u ||
                std::strncmp(value, "sha256:", 7) != 0) {
                return false;
            }
            for (std::size_t index = 7; index < 71; ++index) {
                const unsigned char character = static_cast<unsigned char>(value[index]);
                if (!std::isxdigit(character)) {
                    return false;
                }
            }
            return true;
        };
        if (payload->abi_version < FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION ||
            payload->abi_version > FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION ||
            payload->struct_size < kModalPayloadCertificateTailSize) {
            return validation_error(
                "native FEM shared-domain payload has an incompatible ABI prefix",
                "shared_payload_struct_size_too_small");
        }
        const bool has_payload_v17_certificate_tail =
            payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION &&
            payload->struct_size >= kModalPayloadV17CertificateTailSize;
        const bool has_payload_v6_relation_view_tail =
            payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION &&
            payload->struct_size >= kModalPayloadV6RelationViewTailSize;
        const bool has_payload_v18_linearization_descriptor_tail =
            payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION &&
            payload->struct_size >= kModalPayloadV18LinearizationDescriptorTailSize;
        const bool has_payload_v19_acceptance_certificate_tail =
            payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION &&
            payload->struct_size >= kModalPayloadV19AcceptanceCertificateTailSize;
        if (has_modal_v17_certificate_tail && !has_payload_v17_certificate_tail) {
            return validation_error(
                "native FEM shared-domain payload has no v17 certificate binding prefix",
                "shared_payload_struct_size_too_small",
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                "",
                "canonical_certificate_binding_unverifiable");
        }
        if (payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION &&
            !has_payload_v18_linearization_descriptor_tail) {
            return validation_error(
                "native FEM shared-domain payload has no v18 descriptor/material prefix",
                "shared_payload_struct_size_too_small",
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                "",
                "linearization_descriptor_missing");
        }
        if (payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION &&
            !has_payload_v19_acceptance_certificate_tail) {
            return validation_error(
                "native FEM shared-domain payload has no v19 acceptance-certificate prefix",
                "shared_payload_struct_size_too_small",
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                "",
                "equilibrium_acceptance_certificate_missing");
        }
#if FULLMAG_HAS_MFEM_STACK
        if (payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION &&
            has_payload_v19_acceptance_certificate_tail) {
            const fd::EquilibriumAcceptanceCertificateDescriptor acceptance{
                payload->acceptance_criterion,
                payload->acceptance_metric_kind,
                payload->acceptance_unit,
                payload->acceptance_metric_value,
                payload->acceptance_threshold,
                payload->acceptance_certificate_sha256};
            char acceptance_error[128]{};
            if (fd::validate_equilibrium_acceptance_certificate(
                    acceptance, acceptance_error) != fd::FrequencyDomainStatus::ok) {
                return validation_error(
                    "native FEM shared-domain payload has an invalid equilibrium acceptance certificate",
                    acceptance_error[0] != '\0'
                        ? acceptance_error
                        : "equilibrium_acceptance_certificate_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    acceptance_error[0] != '\0'
                        ? acceptance_error
                        : "equilibrium_acceptance_certificate_invalid");
            }
        }
#endif
        if (has_payload_v18_linearization_descriptor_tail &&
            payload->exchange_material_view != nullptr) {
            const FullmagFemModalExchangeMaterialView *material_view =
                payload->exchange_material_view;
            if (material_view->abi_version !=
                    FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION ||
                material_view->struct_size < sizeof(FullmagFemModalExchangeMaterialView) ||
                material_view->reserved0 != 0u || material_view->reserved1 != 0u ||
                material_view->schema_version == nullptr ||
                std::strcmp(material_view->schema_version,
                            FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_SCHEMA) != 0 ||
                material_view->material_kind != FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX ||
                !std::isfinite(material_view->exchange_stiffness_j_per_m) ||
                material_view->exchange_stiffness_j_per_m <= 0.0) {
                return validation_error(
                    "native FEM shared-domain payload has an invalid exchange material view",
                    "exchange_material_view_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "exchange_material_view_invalid");
            }
        }
        if (payload->mesh_certificate_schema == nullptr ||
            std::strcmp(payload->mesh_certificate_schema, "periodic_mesh_certificate.v6") != 0) {
            return validation_error(
                "native FEM shared-domain payload has an unknown certificate schema",
                "unknown_mesh_certificate_schema");
        }
        if (request->poisson_airbox_periodic_mesh_certificate_schema != nullptr &&
            std::strcmp(
                request->poisson_airbox_periodic_mesh_certificate_schema,
                payload->mesh_certificate_schema) != 0) {
            return validation_error(
                "native FEM modal_eigen request and shared-domain payload disagree on certificate schema",
                "mesh_certificate_schema_mismatch");
        }
        if (!sha256_digest(payload->mesh_certificate_digest)) {
            return validation_error(
                "native FEM shared-domain payload has an invalid or stale certificate digest",
                "invalid_mesh_certificate_digest");
        }
        if (!sha256_digest(payload->mesh_certificate_map_binding_digest)) {
            return validation_error(
                "native FEM shared-domain payload has an invalid map-binding digest",
                "invalid_mesh_certificate_map_binding_digest");
        }
        if (!sha256_digest(payload->equilibrium_digest) ||
            !sha256_digest(payload->linearization_state_digest)) {
            return validation_error(
                "native FEM shared-domain payload has an invalid equilibrium identity digest",
                "invalid_equilibrium_identity_digest");
        }
        if (!sha256_digest(payload->boundary_gauge_digest)) {
            return validation_error(
                "native FEM shared-domain payload has an invalid boundary or gauge digest",
                "invalid_boundary_gauge_digest");
        }
        if (!sha256_digest(payload->bias_field_sample_signature)) {
            return validation_error(
                "native FEM shared-domain payload has an invalid bias-field sample signature",
                "invalid_bias_field_sample_signature");
        }
        if (!nonempty(payload->mesh_certificate_digest) ||
            !nonempty(payload->mesh_certificate_map_binding_digest) ||
            !nonempty(payload->equilibrium_digest) ||
            !nonempty(payload->linearization_state_digest) ||
            !nonempty(payload->boundary_gauge_digest) ||
            !nonempty(payload->bias_field_sample_id) ||
            !nonempty(payload->bias_field_sample_signature) ||
            !nonempty(payload->magnetic_part_identity) ||
            !nonempty(payload->airbox_part_identity)) {
            return validation_error(
                "native FEM shared-domain payload is missing a certificate-bound identity",
                "missing_certificate_identity");
        }
        if (payload->mesh == nullptr || payload->boundary_kind == nullptr ||
            payload->boundary_kind[0] == '\0') {
            return validation_error(
                "native FEM shared-domain payload is missing mesh or boundary identity",
                "missing_shared_domain_mesh_or_boundary_identity");
        }
        if (payload->scalar_reduced_node == nullptr ||
            payload->scalar_reduced_node_count == 0u ||
            payload->magnetic_reduced_node == nullptr ||
            payload->magnetic_reduced_node_count == 0u) {
            return validation_error(
                "native FEM shared-domain payload is missing certificate-bound reduction maps",
                "missing_certificate_map_binding_data");
        }
        if (payload->magnetic_pair_count == 0u || payload->airbox_pair_count == 0u ||
            (request->poisson_airbox_magnetic_pair_count != 0u &&
             request->poisson_airbox_magnetic_pair_count != payload->magnetic_pair_count) ||
            (request->poisson_airbox_airbox_pair_count != 0u &&
             request->poisson_airbox_airbox_pair_count != payload->airbox_pair_count)) {
            return validation_error(
                "native FEM shared-domain payload has a certificate pair-count mismatch",
                "certificate_pair_count_mismatch");
        }
        if (payload->boundary_marker == 0u) {
            return validation_error(
                "native FEM shared-domain payload has an unknown airbox boundary marker",
                "unknown_airbox_marker");
        }
        if (has_modal_v17_certificate_tail) {
            const bool request_mesh_identity_missing =
                request->mesh_generation_identity == nullptr ||
                request->mesh_generation_identity[0] == '\0';
            const bool payload_mesh_identity_missing =
                payload->mesh_generation_identity == nullptr ||
                payload->mesh_generation_identity[0] == '\0';
            if (request_mesh_identity_missing && payload_mesh_identity_missing) {
                return validation_error(
                    "native FEM shared-domain payload has no authoritative mesh generation identity",
                    "canonical_certificate_binding_unverifiable",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
                    "",
                    "canonical_certificate_binding_unverifiable");
            }
            if (request_mesh_identity_missing || payload_mesh_identity_missing ||
                std::strcmp(request->mesh_generation_identity,
                            payload->mesh_generation_identity) != 0) {
                return validation_error(
                    "native FEM modal request and shared-domain payload disagree on mesh generation identity",
                    "certificate_binding_identity_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "certificate_binding_identity_mismatch");
            }
            const bool request_preimage_digest_missing =
                request->canonical_preimage_sha256 == nullptr ||
                request->canonical_preimage_sha256[0] == '\0';
            const bool payload_preimage_digest_missing =
                payload->canonical_preimage_sha256 == nullptr ||
                payload->canonical_preimage_sha256[0] == '\0';
            if (request_preimage_digest_missing && payload_preimage_digest_missing) {
                return validation_error(
                    "native FEM shared-domain payload has no canonical preimage digest",
                    "canonical_certificate_binding_unverifiable",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
                    "",
                    "canonical_certificate_binding_unverifiable");
            }
            if (request_preimage_digest_missing || payload_preimage_digest_missing ||
                std::strcmp(request->canonical_preimage_sha256,
                            payload->canonical_preimage_sha256) != 0) {
                return validation_error(
                    "native FEM modal request and shared-domain payload disagree on canonical preimage digest",
                    "certificate_binding_digest_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "certificate_binding_digest_mismatch");
            }
            if (!sha256_digest(payload->magnetic_class_digest_sha256) ||
                !sha256_digest(payload->scalar_class_digest_sha256)) {
                return validation_error(
                    "native FEM shared-domain payload has an invalid v6 class digest",
                    "invalid_certificate_class_digest",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "invalid_certificate_class_digest");
            }
            if (!has_payload_v6_relation_view_tail || payload->certificate_binding_v6 == nullptr) {
                return validation_error(
                    "native FEM shared-domain payload has no authoritative v6 relation views",
                    "canonical_certificate_binding_unverifiable",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
                    "",
                    "canonical_certificate_binding_unverifiable");
            }

            struct OwnedV6View {
                std::vector<std::uint32_t> region_ids;
                std::vector<std::uint32_t> boundary_axis_masks;
                std::vector<fd::MeshSymmetryCertificateRegionRole> region_roles;
                std::vector<fd::MeshSymmetryCertificateV6Relation> generator_relations;
                std::vector<fd::MeshSymmetryCertificateV6Relation> closure_relations;
                std::vector<std::uint64_t> expected_class_ids;
                std::vector<std::string> expected_class_digest_strings;
                std::vector<fd::MeshSymmetryCertificateV6ClassDigest> expected_class_digests;
                fd::MeshSymmetryCertificateV6View view{};
            } owned_views[4];
            const auto copy_v6_view = [&](const FullmagFemModalCertificateV6View &source,
                                          OwnedV6View &owned) -> const char * {
                constexpr std::uint64_t kMaximumViewEntries = 64ull * 1024ull * 1024ull;
                const auto valid_count = [&](std::uint64_t count, const void *pointer) {
                    return count <= kMaximumViewEntries && (count == 0u || pointer != nullptr);
                };
                if (source.node_count == 0u || source.node_count > kMaximumViewEntries ||
                    source.region_ids == nullptr || source.boundary_axis_masks == nullptr ||
                    !valid_count(source.region_role_count, source.region_roles) ||
                    !valid_count(source.generator_relation_count, source.generator_relations) ||
                    !valid_count(source.closure_relation_count, source.closure_relations) ||
                    !valid_count(source.expected_class_id_count, source.expected_class_ids) ||
                    !valid_count(source.expected_class_digest_count, source.expected_class_digests)) {
                    return "periodic_mesh_certificate_v6_c_abi_view_missing";
                }
                owned.region_ids.assign(
                    source.region_ids,
                    source.region_ids + static_cast<std::ptrdiff_t>(source.node_count));
                owned.boundary_axis_masks.assign(
                    source.boundary_axis_masks,
                    source.boundary_axis_masks + static_cast<std::ptrdiff_t>(source.node_count));
                owned.region_roles.reserve(static_cast<std::size_t>(source.region_role_count));
                for (std::uint64_t index = 0; index < source.region_role_count; ++index) {
                    owned.region_roles.push_back({
                        source.region_roles[index].region_id,
                        static_cast<fd::MeshSymmetryCertificatePartRole>(
                            source.region_roles[index].part_role)});
                }
                owned.generator_relations.reserve(
                    static_cast<std::size_t>(source.generator_relation_count));
                for (std::uint64_t index = 0; index < source.generator_relation_count; ++index) {
                    const auto &relation = source.generator_relations[index];
                    owned.generator_relations.push_back({
                        relation.source_node,
                        relation.destination_node,
                        relation.axis_mask,
                        static_cast<fd::MeshSymmetryCertificateRelationKind>(relation.kind)});
                }
                owned.closure_relations.reserve(
                    static_cast<std::size_t>(source.closure_relation_count));
                for (std::uint64_t index = 0; index < source.closure_relation_count; ++index) {
                    const auto &relation = source.closure_relations[index];
                    owned.closure_relations.push_back({
                        relation.source_node,
                        relation.destination_node,
                        relation.axis_mask,
                        static_cast<fd::MeshSymmetryCertificateRelationKind>(relation.kind)});
                }
                if (source.expected_class_id_count > 0u) {
                    owned.expected_class_ids.assign(
                        source.expected_class_ids,
                        source.expected_class_ids +
                            static_cast<std::ptrdiff_t>(source.expected_class_id_count));
                }
                owned.expected_class_digest_strings.reserve(
                    static_cast<std::size_t>(source.expected_class_digest_count));
                for (std::uint64_t index = 0; index < source.expected_class_digest_count; ++index) {
                    if (source.expected_class_digests[index].sha256 == nullptr) {
                        return "periodic_mesh_certificate_v6_c_abi_class_digest_missing";
                    }
                    owned.expected_class_digest_strings.emplace_back(
                        source.expected_class_digests[index].sha256);
                }
                owned.expected_class_digests.reserve(owned.expected_class_digest_strings.size());
                for (std::size_t index = 0; index < owned.expected_class_digest_strings.size(); ++index) {
                    owned.expected_class_digests.push_back({
                        source.expected_class_digests[index].canonical_class_id,
                        source.expected_class_digests[index].member_count,
                        owned.expected_class_digest_strings[index].c_str()});
                }
                owned.view.schema_version = payload->mesh_certificate_schema;
                owned.view.view_kind =
                    static_cast<fd::MeshSymmetryCertificateV6ViewKind>(source.view_kind);
                owned.view.part_role =
                    static_cast<fd::MeshSymmetryCertificatePartRole>(source.part_role);
                owned.view.part_identity = source.part_identity;
                owned.view.topology_fingerprint = source.topology_fingerprint;
                owned.view.node_count = source.node_count;
                owned.view.region_ids = owned.region_ids.data();
                owned.view.boundary_axis_masks = owned.boundary_axis_masks.data();
                owned.view.region_roles = owned.region_roles.data();
                owned.view.region_role_count = owned.region_roles.size();
                owned.view.generator_relations = owned.generator_relations.data();
                owned.view.generator_relation_count = owned.generator_relations.size();
                owned.view.closure_relations = owned.closure_relations.data();
                owned.view.closure_relation_count = owned.closure_relations.size();
                owned.view.require_complete_closure = source.require_complete_closure != 0u;
                owned.view.expected_class_ids = owned.expected_class_ids.data();
                owned.view.expected_class_id_count = owned.expected_class_ids.size();
                owned.view.expected_class_digests = owned.expected_class_digests.data();
                owned.view.expected_class_digest_count = owned.expected_class_digests.size();
                return nullptr;
            };
            const FullmagFemModalCertificateV6BindingRequest *c_binding =
                payload->certificate_binding_v6;
            const char *view_error = nullptr;
            try {
                for (std::size_t index = 0; index < 4u && view_error == nullptr; ++index) {
                    const FullmagFemModalCertificateV6View *source = nullptr;
                    switch (index) {
                    case 0:
                        source = &c_binding->mesh_magnetic;
                        break;
                    case 1:
                        source = &c_binding->payload_magnetic;
                        break;
                    case 2:
                        source = &c_binding->mesh_scalar;
                        break;
                    default:
                        source = &c_binding->payload_scalar;
                        break;
                    }
                    view_error = copy_v6_view(*source, owned_views[index]);
                }
            } catch (const std::bad_alloc &) {
                view_error = "periodic_mesh_certificate_v6_c_abi_allocation_failed";
            } catch (...) {
                view_error = "periodic_mesh_certificate_v6_c_abi_view_copy_failed";
            }
            if (c_binding->schema_version == nullptr ||
                std::strcmp(c_binding->schema_version, payload->mesh_certificate_schema) != 0) {
                view_error = "periodic_mesh_certificate_v6_c_abi_schema_mismatch";
            }
            if (view_error != nullptr) {
                return validation_error(
                    "native FEM shared-domain payload has malformed v6 relation views",
                    view_error,
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    view_error);
            }
            fd::MeshSymmetryCertificateV6BindingRequest v6_request{};
            v6_request.schema_version = c_binding->schema_version;
            v6_request.mesh_generation_identity = payload->mesh_generation_identity;
            v6_request.mesh_magnetic = owned_views[0].view;
            v6_request.payload_magnetic = owned_views[1].view;
            v6_request.mesh_scalar = owned_views[2].view;
            v6_request.payload_scalar = owned_views[3].view;
            v6_request.payload_binding_digest = payload->canonical_preimage_sha256;
            fd::MeshSymmetryCertificateV6Binding v6_binding{};
            if (fd::verify_mesh_symmetry_certificate_v6(v6_request, v6_binding) !=
                fd::FrequencyDomainStatus::ok) {
                const char *reason = v6_binding.rejection_reason[0] != '\0'
                    ? v6_binding.rejection_reason
                    : "periodic_mesh_certificate_v6_binding_invalid";
                return validation_error(
                    "native FEM shared-domain payload has an invalid v6 relation binding",
                    reason,
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    reason);
            }
            if (std::strcmp(payload->canonical_preimage_sha256,
                            v6_binding.canonical_preimage_sha256) != 0 ||
                std::strcmp(payload->magnetic_class_digest_sha256,
                            v6_binding.magnetic_class_digest_sha256) != 0 ||
                std::strcmp(payload->scalar_class_digest_sha256,
                            v6_binding.scalar_class_digest_sha256) != 0) {
                return validation_error(
                    "native FEM shared-domain payload has stale v6 binding digests",
                    "certificate_binding_digest_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "certificate_binding_digest_mismatch");
            }
            char canonical_preimage_digest[96]{};
            char canonical_preimage_reason[160]{};
            if (fd::verify_mesh_symmetry_certificate_v6_preimage(
                    payload->canonical_preimage,
                    payload->canonical_preimage_len,
                    v6_binding.canonical_preimage_sha256,
                    canonical_preimage_digest,
                    sizeof(canonical_preimage_digest),
                    canonical_preimage_reason,
                    sizeof(canonical_preimage_reason)) != fd::FrequencyDomainStatus::ok ||
                std::strcmp(canonical_preimage_digest,
                            v6_binding.canonical_preimage_sha256) != 0) {
                return validation_error(
                    "native FEM shared-domain payload has an invalid canonical certificate preimage",
                    canonical_preimage_reason[0] != '\0'
                        ? canonical_preimage_reason
                        : "canonical_preimage_digest_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    canonical_preimage_reason[0] != '\0'
                        ? canonical_preimage_reason
                        : "canonical_preimage_digest_mismatch");
            }
            accepted_certificate_binding_status =
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED;
            accepted_certificate_binding_digest = v6_binding.canonical_preimage_sha256;
            accepted_certificate_binding_reason = "none";
        }
        if (payload->abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION) {
            return validation_error(
                "native FEM shared-domain payload ABI v18 has no accepted equilibrium certificate",
                "equilibrium_acceptance_certificate_missing",
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
                "",
                "equilibrium_acceptance_certificate_missing");
        }
        if (payload->abi_version >= FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION) {
            const FullmagFemModalLinearizationDescriptor *descriptor =
                payload->linearization_descriptor;
            if (descriptor == nullptr) {
                return validation_error(
                    "native FEM shared-domain payload has no v18 linearization descriptor",
                    "linearization_descriptor_missing",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
                    "",
                    "linearization_descriptor_missing");
            }
            if (descriptor->abi_version !=
                FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION) {
                return validation_error(
                    "native FEM shared-domain payload uses an unknown linearization descriptor ABI",
                    "linearization_descriptor_unknown_abi",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_unknown_abi");
            }
            if (descriptor->struct_size < sizeof(FullmagFemModalLinearizationDescriptor)) {
                return validation_error(
                    "native FEM shared-domain payload has a short linearization descriptor",
                    "linearization_descriptor_struct_size_too_small",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_struct_size_too_small");
            }
            const auto descriptor_nonempty = [](const char *value) {
                return value != nullptr && value[0] != '\0';
            };
            const auto descriptor_sha256 = [&](const char *value) {
                return sha256_digest(value);
            };
            const auto descriptor_unit = [](const char *value, const char *expected) {
                return value != nullptr && std::strcmp(value, expected) == 0;
            };
            if (descriptor->schema_version == nullptr ||
                std::strcmp(
                    descriptor->schema_version,
                    FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA) != 0) {
                return validation_error(
                    "native FEM linearization descriptor has an unknown schema",
                    "linearization_descriptor_schema_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_schema_invalid");
            }
            if (!descriptor_unit(descriptor->coordinate_unit, "m") ||
                !descriptor_unit(descriptor->magnetisation_unit, "A/m") ||
                !descriptor_unit(descriptor->time_unit, "s") ||
                !descriptor_unit(descriptor->frequency_unit, "Hz") ||
                !descriptor_unit(descriptor->angular_frequency_unit, "rad/s")) {
                return validation_error(
                    "native FEM linearization descriptor has non-SI units",
                    "linearization_descriptor_unit_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_unit_invalid");
            }
            if (descriptor->reserved0 != 0u || descriptor->reserved_contract_flags != 0u) {
                return validation_error(
                    "native FEM linearization descriptor has non-zero reserved flags",
                    "linearization_descriptor_reserved_flags",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_reserved_flags");
            }
            constexpr std::uint32_t kKnownTermMask =
                FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE |
                FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD |
                FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY |
                FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI |
                FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG;
            if ((descriptor->term_presence_mask & ~kKnownTermMask) != 0u) {
                return validation_error(
                    "native FEM linearization descriptor has unknown term flags",
                    "linearization_descriptor_term_mask_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_term_mask_invalid");
            }
            if (descriptor->node_count == 0u || descriptor->node_count > 64ull * 1024ull * 1024ull ||
                descriptor->node_count > std::numeric_limits<std::uint64_t>::max() / 6ull ||
                descriptor->tangent_dof_count != descriptor->node_count * 2ull) {
                return validation_error(
                    "native FEM linearization descriptor has incompatible node or tangent dimensions",
                    "linearization_descriptor_dimension_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_dimension_mismatch");
            }
            const std::uint64_t xyz_count = descriptor->node_count * 3ull;
            const std::uint64_t tangent_frame_count = descriptor->node_count * 6ull;
            const auto exact_array = [](const void *pointer,
                                        std::uint64_t count,
                                        std::uint64_t expected) {
                return pointer != nullptr && count == expected;
            };
            const auto optional_array = [](const void *pointer, std::uint64_t count) {
                return (count == 0u && pointer == nullptr) ||
                    (count != 0u && pointer != nullptr);
            };
            if (!exact_array(
                    descriptor->tangent_frame_xyz,
                    descriptor->tangent_frame_xyz_count,
                    tangent_frame_count) ||
                !exact_array(
                    descriptor->equilibrium_m0_xyz,
                    descriptor->equilibrium_m0_xyz_count,
                    xyz_count) ||
                !exact_array(
                    descriptor->effective_field_h_eff0_xyz,
                    descriptor->effective_field_h_eff0_xyz_count,
                    xyz_count) ||
                !exact_array(
                    descriptor->external_field_h_ext0_xyz,
                    descriptor->external_field_h_ext0_xyz_count,
                    xyz_count) ||
                !exact_array(
                    descriptor->alpha_per_node,
                    descriptor->alpha_per_node_count,
                    descriptor->node_count)) {
                return validation_error(
                    "native FEM linearization descriptor has incomplete state arrays",
                    "linearization_descriptor_state_arrays_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_state_arrays_invalid");
            }
            if (!optional_array(
                    descriptor->saturation_magnetisation_a_per_m,
                    descriptor->saturation_magnetisation_count) ||
                (descriptor->saturation_magnetisation_count != 0u &&
                 descriptor->saturation_magnetisation_count != descriptor->node_count) ||
                (!std::isfinite(descriptor->uniform_saturation_magnetisation_a_per_m) ||
                 (descriptor->saturation_magnetisation_count == 0u &&
                  descriptor->uniform_saturation_magnetisation_a_per_m <= 0.0))) {
                return validation_error(
                    "native FEM linearization descriptor has invalid saturation magnetisation data",
                    "linearization_descriptor_saturation_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_saturation_invalid");
            }

            const bool has_anisotropy =
                (descriptor->term_presence_mask &
                 FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY) != 0u;
            if (has_anisotropy) {
                if (!exact_array(
                        descriptor->uniaxial_axis_xyz,
                        descriptor->uniaxial_axis_xyz_count,
                        xyz_count) ||
                    descriptor->uniaxial_anisotropy_field_a_per_m == nullptr ||
                    (descriptor->uniaxial_anisotropy_field_count != 1u &&
                     descriptor->uniaxial_anisotropy_field_count != descriptor->node_count)) {
                    return validation_error(
                        "native FEM linearization descriptor has invalid anisotropy views",
                        "linearization_descriptor_anisotropy_invalid",
                        FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                        "",
                        "linearization_descriptor_anisotropy_invalid");
                }
            } else if (descriptor->uniaxial_axis_xyz != nullptr ||
                       descriptor->uniaxial_axis_xyz_count != 0u ||
                       descriptor->uniaxial_anisotropy_field_a_per_m != nullptr ||
                       descriptor->uniaxial_anisotropy_field_count != 0u) {
                return validation_error(
                    "native FEM linearization descriptor carries an unadvertised anisotropy view",
                    "linearization_descriptor_anisotropy_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_anisotropy_invalid");
            }

            const bool has_exchange =
                (descriptor->term_presence_mask &
                 FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u;
            if ((has_exchange && payload->exchange_material_view == nullptr) ||
                (has_exchange && payload->exchange_material_view != nullptr &&
                 (descriptor->exchange_edges != nullptr || descriptor->exchange_edge_count != 0u)) ||
                (!has_exchange &&
                 (descriptor->exchange_edges != nullptr || descriptor->exchange_edge_count != 0u ||
                  payload->exchange_material_view != nullptr))) {
                return validation_error(
                    "native FEM linearization descriptor has invalid exchange views",
                    "linearization_descriptor_exchange_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_exchange_invalid");
            }

            const bool has_dmi =
                (descriptor->term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI) != 0u;
            if (has_dmi) {
                const bool dmi_ms_valid =
                    optional_array(descriptor->dmi_ms_field, descriptor->dmi_ms_field_count) &&
                    (descriptor->dmi_ms_field_count == 0u ||
                     descriptor->dmi_ms_field_count == descriptor->node_count);
                if (descriptor->dmi_elements == nullptr || descriptor->dmi_element_count == 0u ||
                    descriptor->dmi_lumped_mass == nullptr ||
                    descriptor->dmi_lumped_mass_count == 0u || !dmi_ms_valid ||
                    (!std::isfinite(descriptor->dmi_uniform_ms) ||
                     (descriptor->dmi_ms_field_count == 0u && descriptor->dmi_uniform_ms <= 0.0))) {
                    return validation_error(
                        "native FEM linearization descriptor has invalid DMI views",
                        "linearization_descriptor_dmi_invalid",
                        FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                        "",
                        "linearization_descriptor_dmi_invalid");
                }
            } else if (descriptor->dmi_elements != nullptr || descriptor->dmi_element_count != 0u ||
                       descriptor->dmi_lumped_mass != nullptr ||
                       descriptor->dmi_lumped_mass_count != 0u ||
                       descriptor->dmi_ms_field != nullptr || descriptor->dmi_ms_field_count != 0u) {
                return validation_error(
                    "native FEM linearization descriptor carries an unadvertised DMI view",
                    "linearization_descriptor_dmi_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_dmi_invalid");
            }

            if (!descriptor_nonempty(descriptor->linearization_state_digest) ||
                !descriptor_sha256(descriptor->linearization_state_digest)) {
                return validation_error(
                    "native FEM linearization descriptor has an invalid state digest",
                    "linearization_descriptor_digest_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_digest_invalid");
            }
            if (!descriptor_nonempty(descriptor->equilibrium_digest) ||
                !descriptor_sha256(descriptor->equilibrium_digest) ||
                !descriptor_nonempty(descriptor->operator_input_digest) ||
                !descriptor_sha256(descriptor->operator_input_digest)) {
                return validation_error(
                    "native FEM linearization descriptor has invalid input digests",
                    "linearization_descriptor_digest_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_digest_invalid");
            }
            if (std::strcmp(
                    descriptor->linearization_state_digest,
                    payload->linearization_state_digest) != 0) {
                return validation_error(
                    "native FEM linearization descriptor does not match the accepted state digest",
                    "linearization_descriptor_state_digest_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_state_digest_mismatch");
            }
            if (std::strcmp(descriptor->equilibrium_digest, payload->equilibrium_digest) != 0) {
                return validation_error(
                    "native FEM linearization descriptor does not match the accepted equilibrium digest",
                    "linearization_descriptor_equilibrium_digest_mismatch",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_equilibrium_digest_mismatch");
            }
            const auto validate_term_digest = [&](std::uint32_t term, const char *digest) {
                return (descriptor->term_presence_mask & term) == 0u ||
                    (descriptor_nonempty(digest) && descriptor_sha256(digest));
            };
            if (!validate_term_digest(
                    FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE,
                    descriptor->exchange_term_digest) ||
                !validate_term_digest(
                    FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD,
                    descriptor->field_term_digest) ||
                !validate_term_digest(
                    FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY,
                    descriptor->anisotropy_term_digest) ||
                !validate_term_digest(
                    FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI,
                    descriptor->dmi_term_digest) ||
                !validate_term_digest(
                    FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG,
                    descriptor->demag_term_digest)) {
                return validation_error(
                    "native FEM linearization descriptor has an invalid term digest",
                    "linearization_descriptor_term_digest_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_term_digest_invalid");
            }
            if ((descriptor->term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG) != 0u &&
                !descriptor_nonempty(descriptor->demag_provider_signature)) {
                return validation_error(
                    "native FEM linearization descriptor has no demag provider signature",
                    "linearization_descriptor_demag_provider_missing",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    "linearization_descriptor_demag_provider_missing");
            }
#if FULLMAG_HAS_MFEM_STACK
            char shared_descriptor_error[256]{};
            if (fullmag::fem::frequency_domain::validate_linearization_descriptor_contract(
                    *descriptor,
                    descriptor->node_count,
                    shared_descriptor_error) != fd::FrequencyDomainStatus::ok) {
                return validation_error(
                    "native FEM linearization descriptor failed the shared contract",
                    shared_descriptor_error[0] != '\0'
                        ? shared_descriptor_error
                        : "linearization_descriptor_contract_invalid",
                    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
                    "",
                    shared_descriptor_error[0] != '\0'
                        ? shared_descriptor_error
                        : "linearization_descriptor_contract_invalid");
            }
#endif
        }
        if (accepted_certificate_binding_status ==
            FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED) {
            return validation_error(
                "native FEM shared-domain payload has no canonical certificate binding verifier",
                "canonical_certificate_binding_unverifiable",
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
                "",
                "canonical_certificate_binding_unverifiable");
        }
    }
    fd::ModalEigenRequest native_request{};
    /* Public v19 appends the accepted-equilibrium certificate after the frozen
       v18 descriptor/material prefix.  The boundary validates both but does
       not synthesize an A_qq matrix or solver policy from it.  Normalize both
       internal ABI discriminants explicitly; public v19 result/provenance
       remains intact at the C ABI boundary. */
    native_request.abi_version = fd::kFrequencyDomainAbiVersion;
    native_request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    native_request.operator_request.mesh_asset_id =
        request->operator_request.mesh_asset_id;
    native_request.operator_request.equilibrium_source_kind =
        request->operator_request.equilibrium_source_kind;
    native_request.operator_request.gamma_rad_s_T =
        request->operator_request.gamma_rad_s_T;
    native_request.operator_request.mu0_T_m_A =
        request->operator_request.mu0_T_m_A;
    native_request.operator_request.alpha = request->operator_request.alpha;
    native_request.operator_request.include_exchange =
        request->operator_request.include_exchange;
    native_request.operator_request.include_demag =
        request->operator_request.include_demag;
    native_request.operator_request.demag_realization =
        request->operator_request.demag_realization;
    native_request.operator_request.damping_policy =
        request->operator_request.damping_policy;
    native_request.operator_request.spin_wave_bc_kind =
        request->operator_request.spin_wave_bc_kind;
    native_request.operator_request.k_vector_rad_m =
        request->operator_request.k_vector_rad_m;
    native_request.operator_request.k_vector_len =
        request->operator_request.k_vector_len;
    native_request.operator_request.operator_diagnostics_json =
        request->operator_request.operator_diagnostics_json;
    native_request.requested_mode_count = request->requested_mode_count;
    native_request.target_kind = request->target_kind;
    native_request.target_frequency_hz = request->target_frequency_hz;
    native_request.frequency_min_hz = request->frequency_min_hz;
    native_request.frequency_max_hz = request->frequency_max_hz;
    native_request.residual_tolerance = request->residual_tolerance;
    native_request.max_outer_iterations = request->max_outer_iterations;
    native_request.max_linear_iterations = request->max_linear_iterations;
    native_request.output_directory = request->output_directory;
    native_request.write_partial_artifacts = request->write_partial_artifacts;
    native_request.completeness_policy = request->completeness_policy;
    native_request.eigensolver_family = request->eigensolver_family;
    native_request.cancel_user_data = request->cancel_user_data;
    native_request.cancel_requested = request->cancel_requested;
    native_request.progress_user_data = request->progress_user_data;
    native_request.progress_callback = request->progress_callback;
    native_request.tiny_validation_enabled = request->tiny_validation_enabled;
    native_request.tiny_validation_tangent_dof_count =
        request->tiny_validation_tangent_dof_count;
    native_request.tiny_validation_stiffness_matrix_row_major =
        request->tiny_validation_stiffness_matrix_row_major;
    native_request.tiny_validation_mass_matrix_row_major =
        request->tiny_validation_mass_matrix_row_major;
    native_request.tiny_validation_stiffness_diagonal =
        request->tiny_validation_stiffness_diagonal;
    native_request.tiny_validation_mass_diagonal =
        request->tiny_validation_mass_diagonal;
    native_request.mfem_operator_enabled = request->mfem_operator_enabled;
    native_request.mfem_tangent_dof_count = request->mfem_tangent_dof_count;
    native_request.mfem_stiffness_matrix_row_major =
        request->mfem_stiffness_matrix_row_major;
    native_request.mfem_gyrotropic_matrix_row_major =
        request->mfem_gyrotropic_matrix_row_major;
    native_request.mfem_mass_matrix_row_major =
        request->mfem_mass_matrix_row_major;
    native_request.mfem_linearized_pencil_dependency_digest =
        request->mfem_linearized_pencil_dependency_digest;
    native_request.mfem_linearized_pencil_gamma0_m_per_a_s =
        request->mfem_linearized_pencil_gamma0_m_per_a_s;
    native_request.mfem_sparse_operator_enabled =
        request->mfem_sparse_operator_enabled;
    native_request.mfem_sparse_stiffness_csr.row_count =
        request->mfem_sparse_stiffness_csr.row_count;
    native_request.mfem_sparse_stiffness_csr.column_count =
        request->mfem_sparse_stiffness_csr.column_count;
    native_request.mfem_sparse_stiffness_csr.row_offsets =
        request->mfem_sparse_stiffness_csr.row_offsets;
    native_request.mfem_sparse_stiffness_csr.row_offsets_len =
        request->mfem_sparse_stiffness_csr.row_offsets_len;
    native_request.mfem_sparse_stiffness_csr.column_indices =
        request->mfem_sparse_stiffness_csr.column_indices;
    native_request.mfem_sparse_stiffness_csr.column_indices_len =
        request->mfem_sparse_stiffness_csr.column_indices_len;
    native_request.mfem_sparse_stiffness_csr.values =
        request->mfem_sparse_stiffness_csr.values;
    native_request.mfem_sparse_stiffness_csr.values_len =
        request->mfem_sparse_stiffness_csr.values_len;
    native_request.mfem_sparse_gyrotropic_csr.row_count =
        request->mfem_sparse_gyrotropic_csr.row_count;
    native_request.mfem_sparse_gyrotropic_csr.column_count =
        request->mfem_sparse_gyrotropic_csr.column_count;
    native_request.mfem_sparse_gyrotropic_csr.row_offsets =
        request->mfem_sparse_gyrotropic_csr.row_offsets;
    native_request.mfem_sparse_gyrotropic_csr.row_offsets_len =
        request->mfem_sparse_gyrotropic_csr.row_offsets_len;
    native_request.mfem_sparse_gyrotropic_csr.column_indices =
        request->mfem_sparse_gyrotropic_csr.column_indices;
    native_request.mfem_sparse_gyrotropic_csr.column_indices_len =
        request->mfem_sparse_gyrotropic_csr.column_indices_len;
    native_request.mfem_sparse_gyrotropic_csr.values =
        request->mfem_sparse_gyrotropic_csr.values;
    native_request.mfem_sparse_gyrotropic_csr.values_len =
        request->mfem_sparse_gyrotropic_csr.values_len;
    native_request.mfem_sparse_mass_csr.row_count =
        request->mfem_sparse_mass_csr.row_count;
    native_request.mfem_sparse_mass_csr.column_count =
        request->mfem_sparse_mass_csr.column_count;
    native_request.mfem_sparse_mass_csr.row_offsets =
        request->mfem_sparse_mass_csr.row_offsets;
    native_request.mfem_sparse_mass_csr.row_offsets_len =
        request->mfem_sparse_mass_csr.row_offsets_len;
    native_request.mfem_sparse_mass_csr.column_indices =
        request->mfem_sparse_mass_csr.column_indices;
    native_request.mfem_sparse_mass_csr.column_indices_len =
        request->mfem_sparse_mass_csr.column_indices_len;
    native_request.mfem_sparse_mass_csr.values =
        request->mfem_sparse_mass_csr.values;
    native_request.mfem_sparse_mass_csr.values_len =
        request->mfem_sparse_mass_csr.values_len;
    std::vector<fd::FrequencyDomainFloquetPeriodicPair> modal_floquet_periodic_pairs;
    native_request.has_floquet_k_vector = request->has_floquet_k_vector != 0;
    native_request.floquet_k_vector_rad_per_m[0] =
        request->floquet_k_vector_rad_per_m[0];
    native_request.floquet_k_vector_rad_per_m[1] =
        request->floquet_k_vector_rad_per_m[1];
    native_request.floquet_k_vector_rad_per_m[2] =
        request->floquet_k_vector_rad_per_m[2];
    if (native_request.has_floquet_k_vector &&
        native_request.operator_request.k_vector_rad_m == nullptr) {
        native_request.operator_request.k_vector_rad_m =
            native_request.floquet_k_vector_rad_per_m;
        native_request.operator_request.k_vector_len = 3;
    }
    if (!from_abi_frequency_domain_phase_convention(
            request->phase_convention,
            &native_request.phase_convention)) {
        fd::FrequencyDomainContractResult invalid_phase{};
        invalid_phase.status = fd::FrequencyDomainStatus::validation_error;
        invalid_phase.error_message = "invalid frequency-domain phase convention";
        invalid_phase.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"validation_error\","
            "\"validation_error\":\"invalid frequency-domain phase convention\"}";
        return copy_frequency_domain_contract_result(
            invalid_phase);
    }
    native_request.floquet_periodic_pair_count =
        request->mfem_floquet_periodic_pair_count;
    if (request->mfem_floquet_periodic_pair_count > 0 &&
        request->mfem_floquet_periodic_pairs != nullptr) {
        modal_floquet_periodic_pairs.reserve(
            static_cast<std::size_t>(request->mfem_floquet_periodic_pair_count));
        for (std::uint64_t pair_index = 0;
             pair_index < request->mfem_floquet_periodic_pair_count;
             ++pair_index) {
            const fullmag_fem_frequency_domain_floquet_periodic_pair &source =
                request->mfem_floquet_periodic_pairs[pair_index];
            fd::FrequencyDomainFloquetPeriodicPair target{};
            target.pair_id = source.pair_id;
            target.node_a = source.node_a;
            target.node_b = source.node_b;
            target.has_translation = source.has_translation != 0;
            target.translation_m[0] = source.translation_m[0];
            target.translation_m[1] = source.translation_m[1];
            target.translation_m[2] = source.translation_m[2];
            target.has_phase = source.has_phase != 0;
            target.phase_rad = source.phase_rad;
            modal_floquet_periodic_pairs.push_back(target);
        }
        native_request.floquet_periodic_pairs =
            modal_floquet_periodic_pairs.data();
    }
    native_request.poisson_airbox_block_enabled =
        request->poisson_airbox_block_enabled;
    native_request.poisson_airbox_q_dof_count =
        request->poisson_airbox_q_dof_count;
    native_request.poisson_airbox_phi_dof_count =
        request->poisson_airbox_phi_dof_count;
    native_request.poisson_airbox_a_qq_csr.row_count =
        request->poisson_airbox_a_qq_csr.row_count;
    native_request.poisson_airbox_a_qq_csr.column_count =
        request->poisson_airbox_a_qq_csr.column_count;
    native_request.poisson_airbox_a_qq_csr.row_offsets =
        request->poisson_airbox_a_qq_csr.row_offsets;
    native_request.poisson_airbox_a_qq_csr.row_offsets_len =
        request->poisson_airbox_a_qq_csr.row_offsets_len;
    native_request.poisson_airbox_a_qq_csr.column_indices =
        request->poisson_airbox_a_qq_csr.column_indices;
    native_request.poisson_airbox_a_qq_csr.column_indices_len =
        request->poisson_airbox_a_qq_csr.column_indices_len;
    native_request.poisson_airbox_a_qq_csr.values =
        request->poisson_airbox_a_qq_csr.values;
    native_request.poisson_airbox_a_qq_csr.values_len =
        request->poisson_airbox_a_qq_csr.values_len;
    native_request.poisson_airbox_a_qphi_csr.row_count =
        request->poisson_airbox_a_qphi_csr.row_count;
    native_request.poisson_airbox_a_qphi_csr.column_count =
        request->poisson_airbox_a_qphi_csr.column_count;
    native_request.poisson_airbox_a_qphi_csr.row_offsets =
        request->poisson_airbox_a_qphi_csr.row_offsets;
    native_request.poisson_airbox_a_qphi_csr.row_offsets_len =
        request->poisson_airbox_a_qphi_csr.row_offsets_len;
    native_request.poisson_airbox_a_qphi_csr.column_indices =
        request->poisson_airbox_a_qphi_csr.column_indices;
    native_request.poisson_airbox_a_qphi_csr.column_indices_len =
        request->poisson_airbox_a_qphi_csr.column_indices_len;
    native_request.poisson_airbox_a_qphi_csr.values =
        request->poisson_airbox_a_qphi_csr.values;
    native_request.poisson_airbox_a_qphi_csr.values_len =
        request->poisson_airbox_a_qphi_csr.values_len;
    native_request.poisson_airbox_a_phiq_csr.row_count =
        request->poisson_airbox_a_phiq_csr.row_count;
    native_request.poisson_airbox_a_phiq_csr.column_count =
        request->poisson_airbox_a_phiq_csr.column_count;
    native_request.poisson_airbox_a_phiq_csr.row_offsets =
        request->poisson_airbox_a_phiq_csr.row_offsets;
    native_request.poisson_airbox_a_phiq_csr.row_offsets_len =
        request->poisson_airbox_a_phiq_csr.row_offsets_len;
    native_request.poisson_airbox_a_phiq_csr.column_indices =
        request->poisson_airbox_a_phiq_csr.column_indices;
    native_request.poisson_airbox_a_phiq_csr.column_indices_len =
        request->poisson_airbox_a_phiq_csr.column_indices_len;
    native_request.poisson_airbox_a_phiq_csr.values =
        request->poisson_airbox_a_phiq_csr.values;
    native_request.poisson_airbox_a_phiq_csr.values_len =
        request->poisson_airbox_a_phiq_csr.values_len;
    native_request.poisson_airbox_a_phiphi_csr.row_count =
        request->poisson_airbox_a_phiphi_csr.row_count;
    native_request.poisson_airbox_a_phiphi_csr.column_count =
        request->poisson_airbox_a_phiphi_csr.column_count;
    native_request.poisson_airbox_a_phiphi_csr.row_offsets =
        request->poisson_airbox_a_phiphi_csr.row_offsets;
    native_request.poisson_airbox_a_phiphi_csr.row_offsets_len =
        request->poisson_airbox_a_phiphi_csr.row_offsets_len;
    native_request.poisson_airbox_a_phiphi_csr.column_indices =
        request->poisson_airbox_a_phiphi_csr.column_indices;
    native_request.poisson_airbox_a_phiphi_csr.column_indices_len =
        request->poisson_airbox_a_phiphi_csr.column_indices_len;
    native_request.poisson_airbox_a_phiphi_csr.values =
        request->poisson_airbox_a_phiphi_csr.values;
    native_request.poisson_airbox_a_phiphi_csr.values_len =
        request->poisson_airbox_a_phiphi_csr.values_len;
    native_request.poisson_airbox_b_qq_csr.row_count =
        request->poisson_airbox_b_qq_csr.row_count;
    native_request.poisson_airbox_b_qq_csr.column_count =
        request->poisson_airbox_b_qq_csr.column_count;
    native_request.poisson_airbox_b_qq_csr.row_offsets =
        request->poisson_airbox_b_qq_csr.row_offsets;
    native_request.poisson_airbox_b_qq_csr.row_offsets_len =
        request->poisson_airbox_b_qq_csr.row_offsets_len;
    native_request.poisson_airbox_b_qq_csr.column_indices =
        request->poisson_airbox_b_qq_csr.column_indices;
    native_request.poisson_airbox_b_qq_csr.column_indices_len =
        request->poisson_airbox_b_qq_csr.column_indices_len;
    native_request.poisson_airbox_b_qq_csr.values =
        request->poisson_airbox_b_qq_csr.values;
    native_request.poisson_airbox_b_qq_csr.values_len =
        request->poisson_airbox_b_qq_csr.values_len;
    native_request.poisson_airbox_phi_mean_weights =
        request->poisson_airbox_phi_mean_weights;
    native_request.poisson_airbox_phi_mean_weights_count =
        request->poisson_airbox_phi_mean_weights_count;
    native_request.poisson_airbox_target_frequency_hz =
        request->poisson_airbox_target_frequency_hz;
    native_request.poisson_airbox_expected_reference_frequency_hz =
        request->poisson_airbox_expected_reference_frequency_hz;
    native_request.poisson_airbox_periodic_mesh_certificate_schema =
        request->poisson_airbox_periodic_mesh_certificate_schema;
    native_request.poisson_airbox_magnetic_pair_count =
        request->poisson_airbox_magnetic_pair_count;
    native_request.poisson_airbox_airbox_pair_count =
        request->poisson_airbox_airbox_pair_count;
    native_request.poisson_airbox_shift_invert_action_enabled =
        request->poisson_airbox_shift_invert_action_enabled;
    native_request.poisson_airbox_shift_invert_action_device =
        request->poisson_airbox_shift_invert_action_device;
    native_request.poisson_airbox_shift_sigma_real =
        request->poisson_airbox_shift_sigma_real;
    native_request.poisson_airbox_shift_sigma_imag =
        request->poisson_airbox_shift_sigma_imag;
    native_request.poisson_airbox_shift_action_vector_real =
        request->poisson_airbox_shift_action_vector_real;
    native_request.poisson_airbox_shift_action_vector_imag =
        request->poisson_airbox_shift_action_vector_imag;
    native_request.poisson_airbox_shift_action_vector_count =
        request->poisson_airbox_shift_action_vector_count;
    native_request.poisson_airbox_outer_boundary_kind =
        request->poisson_airbox_outer_boundary_kind;
    native_request.poisson_airbox_robin_beta =
        request->poisson_airbox_robin_beta;
    native_request.poisson_airbox_gauge_policy =
        request->poisson_airbox_gauge_policy;
    native_request.poisson_airbox_gauge_reason =
        request->poisson_airbox_gauge_reason;
    native_request.poisson_airbox_assembly_kind =
        request->poisson_airbox_assembly_kind;
    native_request.dynamic_demag_k_tangent_matrix_row_major =
        request->dynamic_demag_k_tangent_matrix_row_major;
    native_request.dynamic_demag_k_tangent_matrix_value_count =
        request->dynamic_demag_k_tangent_matrix_value_count;
    if (has_modal_v15_tail) {
        native_request.struct_size = request->struct_size;
        switch (request->execution_target) {
        case FULLMAG_FEM_MODAL_EXECUTION_AUTO:
            native_request.execution_target = fd::ModalExecutionTarget::auto_select;
            break;
        case FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_CPU:
            native_request.execution_target = fd::ModalExecutionTarget::production_cpu;
            break;
        case FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU:
            native_request.execution_target = fd::ModalExecutionTarget::production_gpu;
            break;
        default: {
            return validation_error(
                "native FEM modal_eigen request uses an unknown execution target",
                "unknown_execution_target");
        }
        }
        switch (request->scalar_representation) {
        case FULLMAG_FEM_MODAL_SCALAR_REAL_SPLIT:
            native_request.scalar_representation =
                fd::ModalScalarRepresentation::real_split;
            break;
        case FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE:
            native_request.scalar_representation =
                fd::ModalScalarRepresentation::complex_double;
            break;
        default: {
            return validation_error(
                "native FEM modal_eigen request uses an unknown scalar representation",
                "unknown_scalar_representation");
        }
        }
        switch (request->result_field_representation) {
        case FULLMAG_FEM_MODAL_RESULT_TANGENT_Q:
            native_request.result_field_representation =
                fd::ModalResultFieldRepresentation::tangent_q;
            break;
        case FULLMAG_FEM_MODAL_RESULT_CARTESIAN_DELTA_M:
            native_request.result_field_representation =
                fd::ModalResultFieldRepresentation::cartesian_delta_m;
            break;
        case FULLMAG_FEM_MODAL_RESULT_TANGENT_Q_AND_CARTESIAN_DELTA_M:
            native_request.result_field_representation =
                fd::ModalResultFieldRepresentation::tangent_q_and_cartesian_delta_m;
            break;
        default: {
            return validation_error(
                "native FEM modal_eigen request uses an unknown result field representation",
                "unknown_result_field_representation");
        }
        }
        switch (request->spectral_transform_kind) {
        case FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO:
            native_request.spectral_transform_kind =
                fd::ModalSpectralTransformKind::auto_select;
            break;
        case FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_SHIFT_INVERT:
            native_request.spectral_transform_kind =
                fd::ModalSpectralTransformKind::shift_invert;
            break;
        default:
            return validation_error(
                "native FEM modal_eigen request uses an unknown spectral transform kind",
                "unknown_spectral_transform_kind");
        }
    }
    if (has_shared_payload_tail && request->shared_domain_payload != nullptr) {
        native_request.poisson_airbox_shared_domain_enabled = 1;
        native_request.poisson_airbox_shared_domain_payload =
            request->shared_domain_payload;
    }
    if (native_request.execution_target == fd::ModalExecutionTarget::production_gpu &&
        !caller_supports_v20) {
        return validation_error(
            "strict production GPU requires the caller-sized result v20 attestation ABI",
            "k0_poisson_airbox_gpu_attestation_abi_required");
    }

    fd::FrequencyDomainContractResult native_result =
        fd::solve_modal_eigen_contract(native_request);
    if (accepted_certificate_binding_status !=
        FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED) {
        native_result.certificate_binding.status = accepted_certificate_binding_status;
        native_result.certificate_binding.canonical_preimage_sha256 =
            accepted_certificate_binding_digest;
        native_result.certificate_binding.reason = accepted_certificate_binding_reason;
    }
    if (out_gpu_attestation != nullptr) {
        *out_gpu_attestation = native_result.modal_gpu_attestation;
    }
    return copy_frequency_domain_contract_result(native_result);
}

FullmagFemFrequencyDomainResult fullmag_fem_modal_eigen_solve(
    const FullmagFemModalEigenRequest *request
)
{
    return fullmag_fem_modal_eigen_solve_impl(request, false, nullptr);
}

int fullmag_fem_modal_eigen_solve_v20(
    const FullmagFemModalEigenRequest *request,
    FullmagFemFrequencyDomainResultV20 *out_result
)
{
    if (out_result == nullptr ||
        out_result->abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION ||
        out_result->struct_size < sizeof(FullmagFemFrequencyDomainResultV20)) {
        return FULLMAG_FEM_ERR_INVALID;
    }

    const std::uint32_t caller_abi_version = out_result->abi_version;
    const std::uint32_t caller_struct_size = out_result->struct_size;
    fullmag::fem::frequency_domain::ModalGpuExecutionAttestation gpu_snapshot{};
    out_result->scientific_result_v18 =
        fullmag_fem_modal_eigen_solve_impl(request, true, &gpu_snapshot);
    const bool gpu_requested = request != nullptr &&
        request->struct_size >=
            offsetof(FullmagFemModalEigenRequest, execution_target) +
                sizeof(request->execution_target) &&
        request->execution_target == FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU;
    if (!gpu_requested) {
        out_result->gpu_attestation = nullptr;
        out_result->abi_version = caller_abi_version;
        out_result->struct_size = caller_struct_size;
        return FULLMAG_FEM_OK;
    }
    out_result->gpu_attestation = new (std::nothrow) FullmagFemModalGpuAttestationV1{};
    if (out_result->gpu_attestation == nullptr) {
        fullmag_fem_frequency_domain_result_destroy(&out_result->scientific_result_v18);
        out_result->abi_version = caller_abi_version;
        out_result->struct_size = caller_struct_size;
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    out_result->gpu_attestation->abi_version =
        FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_ABI_VERSION;
    out_result->gpu_attestation->struct_size = sizeof(FullmagFemModalGpuAttestationV1);
    out_result->gpu_attestation->measurement_state =
        FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE;
    out_result->gpu_attestation->fallback_state =
        FULLMAG_FEM_MODAL_GPU_FALLBACK_NONE;
    if (gpu_snapshot.hypre_policy_observed) {
        out_result->gpu_attestation->measurement_coverage_flags |=
            FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP;
    }
    if (gpu_snapshot.hypre_memory_location_device) {
        out_result->gpu_attestation->hypre_memory_location =
            FULLMAG_FEM_MODAL_HYPRE_MEMORY_DEVICE;
    }
    if (gpu_snapshot.hypre_execution_policy_device) {
        out_result->gpu_attestation->hypre_execution_policy =
            FULLMAG_FEM_MODAL_HYPRE_EXEC_DEVICE;
    }
    out_result->gpu_attestation->last_invalidation_reason = duplicate_c_string(
        gpu_snapshot.hypre_failure_reason.empty()
            ? "full_gpu_measurement_incomplete"
            : gpu_snapshot.hypre_failure_reason.c_str());
    if (out_result->gpu_attestation->last_invalidation_reason == nullptr) {
        fullmag_fem_frequency_domain_result_v20_destroy(out_result);
        out_result->abi_version = caller_abi_version;
        out_result->struct_size = caller_struct_size;
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (out_result->scientific_result_v18.status == FULLMAG_FEM_FD_OK) {
        out_result->scientific_result_v18.status = FULLMAG_FEM_FD_UNAVAILABLE;
        delete[] out_result->scientific_result_v18.error_message;
        delete[] out_result->scientific_result_v18.diagnostics_json;
        delete[] out_result->scientific_result_v18.result_json;
        out_result->scientific_result_v18.error_message = duplicate_c_string(
            "strict production GPU execution attestation is incomplete");
        out_result->scientific_result_v18.diagnostics_json = duplicate_c_string(
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\",\"status\":\"unavailable\","
            "\"complete\":false,\"reason\":"
            "\"k0_poisson_airbox_gpu_transfer_measurement_unavailable\"}");
        out_result->scientific_result_v18.result_json = duplicate_c_string(
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\",\"status\":\"unavailable\","
            "\"complete\":false}");
        if (out_result->scientific_result_v18.error_message == nullptr ||
            out_result->scientific_result_v18.diagnostics_json == nullptr ||
            out_result->scientific_result_v18.result_json == nullptr) {
            fullmag_fem_frequency_domain_result_v20_destroy(out_result);
            out_result->abi_version = caller_abi_version;
            out_result->struct_size = caller_struct_size;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }
    out_result->abi_version = caller_abi_version;
    out_result->struct_size = caller_struct_size;
    return 0;
}

void fullmag_fem_frequency_domain_result_v20_destroy(
    FullmagFemFrequencyDomainResultV20 *result
)
{
    if (result == nullptr) {
        return;
    }
    const std::uint32_t abi_version = result->abi_version;
    const std::uint32_t struct_size = result->struct_size;
    fullmag_fem_frequency_domain_result_destroy(&result->scientific_result_v18);
    if (result->gpu_attestation != nullptr) {
        auto *attestation = result->gpu_attestation;
        delete[] attestation->device_name;
        delete[] attestation->mfem_version;
        delete[] attestation->hypre_version;
        delete[] attestation->petsc_version;
        delete[] attestation->slepc_version;
        delete[] attestation->petsc_vec_type;
        delete[] attestation->petsc_matrix_type;
        delete[] attestation->matshell_vec_type;
        delete[] attestation->slepc_bv_type;
        delete[] attestation->eps_type;
        delete[] attestation->st_type;
        delete[] attestation->ksp_type;
        delete[] attestation->poisson_pc_type;
        delete[] attestation->shift_pc_type;
        delete[] attestation->last_invalidation_reason;
        delete attestation;
    }
    *result = {};
    result->abi_version = abi_version;
    result->struct_size = struct_size;
}

int fullmag_fem_modal_eigen_gpu_runtime_finalize(void)
{
#if FULLMAG_FEM_WITH_SLEPC && FULLMAG_HAS_CUDA_RUNTIME
    return fullmag::fem::frequency_domain::
                   finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
               fullmag::fem::frequency_domain::FrequencyDomainStatus::ok
        ? FULLMAG_FEM_OK
        : FULLMAG_FEM_ERR_INTERNAL;
#else
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

FullmagFemFrequencyDomainResult fullmag_fem_driven_response_solve(
    const FullmagFemDrivenResponseRequest *request
)
{
    if (request == nullptr) {
        return copy_frequency_domain_contract_result(
            fullmag::fem::frequency_domain::solve_driven_response_contract({}));
    }

    namespace fd = fullmag::fem::frequency_domain;
    fd::DrivenResponseContractRequest native_request{};
    native_request.abi_version = request->abi_version;
    native_request.operator_request.abi_version =
        request->operator_request.abi_version;
    native_request.operator_request.mesh_asset_id =
        request->operator_request.mesh_asset_id;
    native_request.operator_request.equilibrium_source_kind =
        request->operator_request.equilibrium_source_kind;
    native_request.operator_request.gamma_rad_s_T =
        request->operator_request.gamma_rad_s_T;
    native_request.operator_request.mu0_T_m_A =
        request->operator_request.mu0_T_m_A;
    native_request.operator_request.alpha = request->operator_request.alpha;
    native_request.operator_request.include_exchange =
        request->operator_request.include_exchange;
    native_request.operator_request.include_demag =
        request->operator_request.include_demag;
    native_request.operator_request.demag_realization =
        request->operator_request.demag_realization;
    native_request.operator_request.damping_policy =
        request->operator_request.damping_policy;
    native_request.operator_request.spin_wave_bc_kind =
        request->operator_request.spin_wave_bc_kind;
    native_request.operator_request.k_vector_rad_m =
        request->operator_request.k_vector_rad_m;
    native_request.operator_request.k_vector_len =
        request->operator_request.k_vector_len;
    native_request.operator_request.operator_diagnostics_json =
        request->operator_request.operator_diagnostics_json;
    native_request.frequencies_hz = request->frequencies_hz;
    native_request.frequency_count = request->frequency_count;
    native_request.excitation_field_A_m = request->excitation_field_A_m;
    native_request.excitation_field_len = request->excitation_field_len;
    native_request.excitation_phase_rad = request->excitation_phase_rad;
    native_request.residual_tolerance = request->residual_tolerance;
    native_request.max_linear_iterations = request->max_linear_iterations;
    native_request.output_directory = request->output_directory;
    native_request.write_partial_artifacts = request->write_partial_artifacts;
    native_request.cancel_user_data = request->cancel_user_data;
    native_request.cancel_requested = request->cancel_requested;
    native_request.progress_user_data = request->progress_user_data;
    native_request.progress_callback = request->progress_callback;

    return copy_frequency_domain_contract_result(
        fd::solve_driven_response_contract(native_request));
}

void fullmag_fem_frequency_domain_result_destroy(
    FullmagFemFrequencyDomainResult *result
)
{
    if (result == nullptr) {
        return;
    }
    delete[] result->error_message;
    delete[] result->diagnostics_json;
    delete[] result->result_json;
    delete[] result->artifact_manifest_path;
    delete[] result->resolved_engine_id;
    delete[] result->resolved_fallback_reason;
    delete[] result->resolved_canonical_preimage_sha256;
    delete[] result->resolved_certificate_binding_reason;
    release_modal_buffers(*result);
    *result = {};
}

fullmag_fem_backend *fullmag_fem_backend_create(const fullmag_fem_plan_desc *plan) {
    if (plan == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_create received null plan");
        return nullptr;
    }

    auto *handle = new (std::nothrow) fullmag_fem_backend();
    if (handle == nullptr) {
        fullmag_fem_set_global_error("failed to allocate fullmag_fem_backend");
        return nullptr;
    }

    std::string error;
    if (!fullmag::fem::initialize_backend_runtime(handle->context, *plan, error)) {
        fullmag_fem_set_global_error(error);
        fullmag_fem_set_handle_error(handle, error);
        delete handle;
        return nullptr;
    }

    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return handle;
}

fullmag_fem_backend *fullmag_fem_backend_create_v2(
    const fullmag_fem_plan_desc *plan,
    const fullmag_fem_adaptive_config_v2 *adaptive_config)
{
    if (plan == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_create_v2 received null plan");
        return nullptr;
    }
    if (adaptive_config == nullptr) {
        return fullmag_fem_backend_create(plan);
    }

    auto *handle = new (std::nothrow) fullmag_fem_backend();
    if (handle == nullptr) {
        fullmag_fem_set_global_error("failed to allocate fullmag_fem_backend");
        return nullptr;
    }

    std::string error;
    if (!fullmag::fem::apply_adaptive_dt_v2_guard_fields(
            handle->context, adaptive_config, error)) {
        fullmag_fem_set_global_error(error);
        fullmag_fem_set_handle_error(handle, error);
        delete handle;
        return nullptr;
    }

    fullmag_fem_plan_desc plan_v2 = *plan;
    plan_v2.adaptive_config = &adaptive_config->base;
    if (!fullmag::fem::initialize_backend_runtime(handle->context, plan_v2, error)) {
        fullmag_fem_set_global_error(error);
        fullmag_fem_set_handle_error(handle, error);
        delete handle;
        return nullptr;
    }

    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return handle;
}

int fullmag_fem_get_regional_field_drive_abi_layout(
    fullmag_fem_regional_field_drive_abi_layout *out_layout)
{
    if (out_layout == nullptr) return FULLMAG_FEM_ERR_INVALID;
    *out_layout = {};
    out_layout->abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    out_layout->struct_size = sizeof(*out_layout);
    out_layout->time_dependence_desc_size = sizeof(fullmag_fem_time_dependence_desc);
    out_layout->field_target_desc_size = sizeof(fullmag_fem_field_target_desc);
    out_layout->spatial_profile_desc_size = sizeof(fullmag_fem_spatial_profile_desc);
    out_layout->regional_field_drive_desc_size = sizeof(fullmag_fem_regional_field_drive_desc);
    out_layout->plan_desc_size = sizeof(fullmag_fem_plan_desc);
    out_layout->plan_regional_field_drives_offset = offsetof(fullmag_fem_plan_desc, regional_field_drives);
    out_layout->plan_regional_field_drive_count_offset = offsetof(fullmag_fem_plan_desc, regional_field_drive_count);
    out_layout->plan_stage_start_time_s_offset = offsetof(fullmag_fem_plan_desc, stage_start_time_s);
    out_layout->step_stats_size = sizeof(fullmag_fem_step_stats);
    out_layout->step_stats_drive_energy_joules_offset = offsetof(fullmag_fem_step_stats, drive_energy_joules);
    out_layout->step_stats_rk_transaction_capture_host_wall_time_ns_offset =
        offsetof(fullmag_fem_step_stats, rk_transaction_capture_host_wall_time_ns);
    out_layout->step_stats_demag_hypre_timed_solve_count_offset =
        offsetof(fullmag_fem_step_stats, demag_hypre_timed_solve_count);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_begin_stage(
    fullmag_fem_backend *handle,
    double stage_start_time_s)
{
    if (handle == nullptr || !std::isfinite(stage_start_time_s)) {
        fullmag_fem_set_handle_error(handle, "begin_stage requires a non-null handle and finite stage start time");
        return FULLMAG_FEM_ERR_INVALID;
    }
    auto &ctx = handle->context;
    const double tolerance = 64.0 * std::numeric_limits<double>::epsilon() *
        std::max({1.0, std::abs(ctx.state.current_time), std::abs(stage_start_time_s)});
    if (std::abs(ctx.state.current_time - stage_start_time_s) > tolerance) {
        fullmag_fem_set_handle_error(handle,
            "begin_stage start time must equal the backend's current absolute time");
        return FULLMAG_FEM_ERR_INVALID;
    }
    ctx.zeeman.stage_start_time_s = stage_start_time_s;
    ctx.zeeman.regional_drive_revision += 1;
    ctx.stepper.workspace.fsal_valid = false;
    ctx.gpu_state.device.rk.fsal_valid = false;
    ctx.gpu_state.device.rk.endpoint_valid = false;
    ctx.gpu_state.device.rk.endpoint_consumed = true;
    ctx.gpu_state.device.rk.endpoint_operator_signature = 0;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.adaptive_dt.has_prev_error_norm = false;
    ctx.poisson_demag.fresh_initial_guess_required =
        ctx.demag.enabled && ctx.gpu_state.device.lifecycle.allocated;
    std::fill(ctx.zeeman.h_drive_xyz.begin(), ctx.zeeman.h_drive_xyz.end(), 0.0);
    std::fill(ctx.effective_field.h_xyz.begin(), ctx.effective_field.h_xyz.end(), 0.0);
    handle->last_error.clear();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_set_gpu_execution_request_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_execution_request_v1 request)
{
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_set_gpu_execution_request_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (request != FULLMAG_FEM_GPU_EXECUTION_REQUEST_COMPATIBILITY &&
        request != FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_set_gpu_execution_request_v1 received unsupported request");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (fullmag::fem::gpu_execution_receipt_attempt_active(
            handle->context.gpu_state.execution_receipt)) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_set_gpu_execution_request_v1 cannot change policy during an active attempt");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->context.gpu_state.execution_request = request;
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_reconfigure_regional_field_drives(
    fullmag_fem_backend *handle,
    const fullmag_fem_regional_field_drive_desc *drives,
    uint64_t drive_count,
    double stage_start_time_s)
{
    if (handle == nullptr || !std::isfinite(stage_start_time_s) ||
        ((drive_count == 0) != (drives == nullptr))) {
        fullmag_fem_set_handle_error(handle, "regional drive reconfigure requires valid handle, time, and null/count pair");
        return FULLMAG_FEM_ERR_INVALID;
    }
    auto &ctx = handle->context;
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drives = drives;
    plan.regional_field_drive_count = drive_count;
    plan.stage_start_time_s = stage_start_time_s;
    std::string error;
    if (!fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error) ||
        !fullmag::fem::project_regional_field_drive_bases(ctx, error)) {
        fullmag_fem_set_handle_error(handle, error);
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.gpu_state.device.lifecycle.allocated &&
        !fullmag::fem::gpu_regional_field_drive_upload(ctx, error)) {
        fullmag_fem_set_handle_error(handle, error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#endif
    ctx.zeeman.regional_drive_revision += 1;
    ctx.stepper.workspace.fsal_valid = false;
    ctx.gpu_state.device.rk.fsal_valid = false;
    ctx.gpu_state.device.rk.endpoint_valid = false;
    ctx.gpu_state.device.rk.endpoint_consumed = true;
    ctx.gpu_state.device.rk.endpoint_operator_signature = 0;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.adaptive_dt.has_prev_error_norm = false;
    std::fill(ctx.effective_field.h_xyz.begin(), ctx.effective_field.h_xyz.end(), 0.0);
    handle->last_error.clear();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_invalidate_fsal(fullmag_fem_backend *handle)
{
    if (handle == nullptr) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    auto &ctx = handle->context;
    ctx.stepper.workspace.fsal_valid = false;
#if FULLMAG_HAS_CUDA_RUNTIME
    ctx.gpu_state.device.rk.fsal_valid = false;
#endif
    ctx.gpu_state.device.rk.endpoint_valid = false;
    ctx.gpu_state.device.rk.endpoint_consumed = true;
    ctx.gpu_state.device.rk.endpoint_operator_signature = 0;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.adaptive_dt.has_prev_error_norm = false;
    handle->last_error.clear();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_set_stage_oersted_callback_v1(
    fullmag_fem_backend *handle,
    const fullmag_fem_stage_oersted_callback_v1 *callback)
{
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_set_stage_oersted_callback_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    std::string error;
    if (!fullmag::fem::configure_oersted_stage_callback(
            handle->context, callback, error)) {
        fullmag_fem_set_handle_error(handle, error);
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_set_stage_transport_callback_v1(
    fullmag_fem_backend *handle,
    const fullmag_fem_stage_transport_callback_v1 *callback)
{
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_set_stage_transport_callback_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    std::string error;
    if (!fullmag::fem::configure_transport_stage_callback(
            handle->context, callback, error)) {
        fullmag_fem_set_handle_error(handle, error);
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_step(
    fullmag_fem_backend *handle,
    double dt_seconds,
    fullmag_fem_step_stats *out_stats
) {
    if (handle == nullptr || out_stats == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_step requires non-null handle and out_stats");
        return FULLMAG_FEM_ERR_INVALID;
    }

    handle->last_error.clear();
    handle->context.relaxation.accepted_energy_proof = {};
    const int status =
        fullmag::fem::run_backend_step(
            handle->context,
            dt_seconds,
            *out_stats,
            handle->last_error);
    if (status == FULLMAG_FEM_OK) {
        apply_demag_solver_policy_to_step_stats(handle->context, *out_stats);
    }
    if (status != FULLMAG_FEM_OK && !handle->last_error.empty()) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
    }
    return status;
}

int fullmag_fem_backend_relax_step(
    fullmag_fem_backend *handle,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats *out_stats
) {
    if (handle == nullptr || out_stats == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_relax_step requires non-null handle and out_stats");
        return FULLMAG_FEM_ERR_INVALID;
    }

    handle->last_error.clear();
    handle->context.relaxation.accepted_energy_proof = {};
    const int status =
        fullmag::fem::run_backend_relaxation_step(
            handle->context,
            algorithm,
            *out_stats,
            handle->last_error);
    if (status == FULLMAG_FEM_OK) {
        apply_demag_solver_policy_to_step_stats(handle->context, *out_stats);
    }
    if (status != FULLMAG_FEM_OK && !handle->last_error.empty()) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
    }
    return status;
}

int fullmag_fem_backend_set_interrupt_poll(
    fullmag_fem_backend *handle,
    fullmag_fem_interrupt_poll_fn poll_fn,
    void *user_data
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_set_interrupt_poll received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    fullmag::fem::set_interrupt_poll(handle->context, poll_fn, user_data);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_set_step_profile(
    fullmag_fem_backend *handle,
    int enabled
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_set_step_profile received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    fullmag::fem::set_gpu_step_profile(handle->context, enabled != 0);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_copy_field_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    if ((observable == FULLMAG_FEM_OBSERVABLE_M ||
         observable == FULLMAG_FEM_OBSERVABLE_TORQUE) &&
        !fullmag::fem::context_sync_gpu_magnetization_to_host(
            handle->context,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return fullmag::fem::context_copy_field_f64(
        handle->context,
        observable,
        out_xyz,
        out_len,
        handle->last_error);
}

int fullmag_fem_backend_copy_linearization_field_f64(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_copy_linearization_field_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    return fullmag::fem::context_copy_linearization_field_f64(
        handle->context,
        observable,
        out_xyz,
        out_len,
        handle->last_error);
}

int fullmag_fem_backend_average_m_for_nodes_f64(
    fullmag_fem_backend *handle,
    const uint32_t *node_indices,
    uint64_t node_count,
    double *out_xyz,
    uint64_t out_len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_average_m_for_nodes_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (out_xyz == nullptr || out_len < 3) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_average_m_for_nodes_f64 requires out_xyz[3]");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (node_count > 0 && node_indices == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_average_m_for_nodes_f64 received null node_indices");
        return FULLMAG_FEM_ERR_INVALID;
    }

    handle->last_error.clear();
    if (!fullmag::fem::context_sync_gpu_magnetization_to_host(
            handle->context,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    double sum[3] = {0.0, 0.0, 0.0};
    double weight_sum = 0.0;
    const uint64_t available_nodes =
        static_cast<uint64_t>(handle->context.state.m_xyz.size() / 3u);
    const auto &lumped_volume = !handle->context.integration_weights.mfem_lumped_mass.empty()
        ? handle->context.integration_weights.mfem_lumped_mass
        : handle->context.mesh.node_volumes;
    if (lumped_volume.size() != available_nodes) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_average_m_for_nodes_f64 requires nodal integration weights");
        return FULLMAG_FEM_ERR_INVALID;
    }
    for (uint64_t i = 0; i < node_count; ++i) {
        const uint64_t node = static_cast<uint64_t>(node_indices[i]);
        if (node >= available_nodes) {
            fullmag_fem_set_handle_error(
                handle,
                "fullmag_fem_backend_average_m_for_nodes_f64 received node index out of range");
            return FULLMAG_FEM_ERR_INVALID;
        }
        const uint64_t base = node * 3u;
        const double mx = handle->context.state.m_xyz[static_cast<size_t>(base + 0u)];
        const double my = handle->context.state.m_xyz[static_cast<size_t>(base + 1u)];
        const double mz = handle->context.state.m_xyz[static_cast<size_t>(base + 2u)];
        const double volume = lumped_volume[static_cast<size_t>(node)];
        const double ms = handle->context.material_fields.Ms_field.empty()
            ? handle->context.material_fields.material.saturation_magnetisation
            : handle->context.material_fields.Ms_field[static_cast<size_t>(node)];
        const double weight = ms * volume;
        if (!std::isfinite(weight) || weight <= 0.0) {
            continue;
        }
        sum[0] += weight * mx;
        sum[1] += weight * my;
        sum[2] += weight * mz;
        weight_sum += weight;
    }

    if (!(weight_sum > 0.0) || !std::isfinite(weight_sum)) {
        out_xyz[0] = 0.0;
        out_xyz[1] = 0.0;
        out_xyz[2] = 0.0;
    } else {
        const double inv = 1.0 / weight_sum;
        out_xyz[0] = sum[0] * inv;
        out_xyz[1] = sum[1] * inv;
        out_xyz[2] = sum[2] * inv;
    }
    return FULLMAG_FEM_OK;
}

fullmag_fem_field_snapshot *fullmag_fem_backend_begin_field_snapshot(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable
) {
    return reinterpret_cast<fullmag_fem_field_snapshot *>(
        begin_snapshot_payload(handle, observable));
}

fullmag_fem_preview_snapshot *fullmag_fem_backend_begin_preview_snapshot(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable
) {
    return reinterpret_cast<fullmag_fem_preview_snapshot *>(
        begin_snapshot_payload(handle, observable));
}

int fullmag_fem_field_snapshot_wait(
    fullmag_fem_field_snapshot *snapshot,
    const void **out_data,
    uint64_t *out_len_bytes,
    fullmag_fem_snapshot_desc *out_desc
) {
    return wait_snapshot_payload(
        reinterpret_cast<FemSnapshotPayload *>(snapshot),
        out_data,
        out_len_bytes,
        out_desc);
}

int fullmag_fem_preview_snapshot_wait(
    fullmag_fem_preview_snapshot *snapshot,
    const void **out_data,
    uint64_t *out_len_bytes,
    fullmag_fem_snapshot_desc *out_desc
) {
    return wait_snapshot_payload(
        reinterpret_cast<FemSnapshotPayload *>(snapshot),
        out_data,
        out_len_bytes,
        out_desc);
}

int fullmag_fem_preview_snapshot_ready(fullmag_fem_preview_snapshot *snapshot) {
    return snapshot_payload_ready(reinterpret_cast<FemSnapshotPayload *>(snapshot));
}

int fullmag_fem_field_snapshot_ready(fullmag_fem_field_snapshot *snapshot) {
    return snapshot_payload_ready(reinterpret_cast<FemSnapshotPayload *>(snapshot));
}

void fullmag_fem_field_snapshot_destroy(fullmag_fem_field_snapshot *snapshot) {
    auto *payload = reinterpret_cast<FemSnapshotPayload *>(snapshot);
    if (payload != nullptr) {
        destroy_snapshot_payload(*payload);
        delete payload;
    }
}

void fullmag_fem_preview_snapshot_destroy(fullmag_fem_preview_snapshot *snapshot) {
    auto *payload = reinterpret_cast<FemSnapshotPayload *>(snapshot);
    if (payload != nullptr) {
        destroy_snapshot_payload(*payload);
        delete payload;
    }
}

int fullmag_fem_backend_upload_magnetization_f64(
    fullmag_fem_backend *handle,
    const double *m_xyz,
    uint64_t len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_upload_magnetization_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    return fullmag::fem::context_upload_magnetization_f64(
        handle->context,
        m_xyz,
        len,
        handle->last_error);
}

int fullmag_fem_backend_apply_demag_tangent_f64(
    fullmag_fem_backend *handle,
    const double *delta_m_xyz,
    uint64_t delta_m_len,
    double *out_delta_h_demag_xyz,
    uint64_t out_len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_apply_demag_tangent_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    if (delta_m_xyz == nullptr || out_delta_h_demag_xyz == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_f64 requires non-null input and output buffers");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!handle->context.demag.enabled) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_f64 requires enabled native FEM demag");
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (!fullmag::fem::context_sync_gpu_magnetization_to_host(
            handle->context,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    const uint64_t expected_len = static_cast<uint64_t>(handle->context.state.m_xyz.size());
    if (expected_len == 0 ||
        delta_m_len != expected_len ||
        out_len < expected_len) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_f64 buffer lengths must match the backend magnetization field");
        return FULLMAG_FEM_ERR_INVALID;
    }

#if FULLMAG_HAS_MFEM_STACK
    std::vector<double> delta_m(
        delta_m_xyz,
        delta_m_xyz + static_cast<std::size_t>(delta_m_len));
    std::vector<double> delta_h_demag;
    double delta_demag_energy = 0.0;
    if (!fullmag::fem::compute_fresh_demag_field_for_magnetization(
            handle->context,
            delta_m,
            delta_h_demag,
            delta_demag_energy,
            true,
            nullptr,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (delta_h_demag.size() != static_cast<std::size_t>(expected_len)) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_f64 received inconsistent demag field sizes from native solver");
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    for (std::size_t index = 0; index < delta_h_demag.size(); ++index) {
        out_delta_h_demag_xyz[index] = delta_h_demag[index];
    }
    return FULLMAG_FEM_OK;
#else
    fullmag_fem_set_handle_error(handle, kUnavailableMessage);
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int fullmag_fem_backend_apply_demag_tangent_with_potential_f64(
    fullmag_fem_backend *handle,
    const double *delta_m_xyz,
    uint64_t delta_m_len,
    double *out_delta_h_demag_xyz,
    uint64_t out_len,
    double *out_delta_phi,
    uint64_t out_phi_len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_apply_demag_tangent_with_potential_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    if (delta_m_xyz == nullptr ||
        out_delta_h_demag_xyz == nullptr ||
        out_delta_phi == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_with_potential_f64 requires non-null input and output buffers");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!handle->context.demag.enabled) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_with_potential_f64 requires enabled native FEM demag");
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }

    const uint64_t expected_vector_len =
        static_cast<uint64_t>(handle->context.mesh.n_nodes) * 3ull;
    const uint64_t expected_phi_len =
        static_cast<uint64_t>(handle->context.mesh.n_nodes);
    if (expected_vector_len == 0 ||
        delta_m_len != expected_vector_len ||
        out_len < expected_vector_len ||
        out_phi_len != expected_phi_len) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_apply_demag_tangent_with_potential_f64 buffer lengths must match the backend mesh");
        return FULLMAG_FEM_ERR_INVALID;
    }

    if (handle->context.gpu_state.device.lifecycle.allocated &&
        handle->context.poisson_demag.gpu_demag_mode ==
            FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
        if (!apply_device_demag_tangent_with_potential_f64(
                handle->context,
                delta_m_xyz,
                delta_m_len,
                out_delta_h_demag_xyz,
                out_len,
                out_delta_phi,
                out_phi_len,
                handle->last_error)) {
            fullmag_fem_set_handle_error(handle, handle->last_error);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        return FULLMAG_FEM_OK;
    }

    const int tangent_status = fullmag_fem_backend_apply_demag_tangent_f64(
        handle,
        delta_m_xyz,
        delta_m_len,
        out_delta_h_demag_xyz,
        out_len);
    if (tangent_status != FULLMAG_FEM_OK) {
        return tangent_status;
    }
    const int phi_status = fullmag::fem::context_copy_field_f64(
        handle->context,
        FULLMAG_FEM_OBSERVABLE_DEMAG_PHI,
        out_delta_phi,
        out_phi_len,
        handle->last_error);
    if (phi_status != FULLMAG_FEM_OK) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return phi_status;
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_snapshot_stats(
    fullmag_fem_backend *handle,
    fullmag_fem_step_stats *out_stats
) {
    if (out_stats == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_snapshot_stats received null out_stats");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_snapshot_stats received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }

#if FULLMAG_HAS_MFEM_STACK
    handle->last_error.clear();
    if (!fullmag::fem::context_snapshot_stats_mfem(
            handle->context, *out_stats, handle->last_error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    apply_demag_solver_policy_to_step_stats(handle->context, *out_stats);
    return FULLMAG_FEM_OK;
#else
    fullmag_fem_set_handle_error(handle, kUnavailableMessage);
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int fullmag_fem_backend_snapshot_endpoint_cache_telemetry_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_endpoint_cache_telemetry_v1 *out_telemetry
)
{
    if (out_telemetry == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_snapshot_endpoint_cache_telemetry_v1 received null out_telemetry");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_snapshot_endpoint_cache_telemetry_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }

#if FULLMAG_HAS_MFEM_STACK
    const auto &source = handle->context.stepper.workspace.endpoint_telemetry;
    *out_telemetry = {};
    out_telemetry->abi_version = FULLMAG_FEM_ENDPOINT_CACHE_TELEMETRY_V1_ABI_VERSION;
    out_telemetry->struct_size = sizeof(*out_telemetry);
    out_telemetry->final_rhs_evaluations = source.final_rhs_evaluations;
    out_telemetry->extra_poisson_solves = source.extra_poisson_solves;
    out_telemetry->endpoint_cache_hits = source.endpoint_cache_hits;
    out_telemetry->endpoint_refreshes = source.endpoint_refreshes;
    out_telemetry->accepted_step_wall_time_ns = source.accepted_step_wall_time_ns;
    out_telemetry->available =
        source.final_refresh_reason != fullmag::fem::RkFinalRefreshReason::NotEvaluated ? 1u : 0u;
    out_telemetry->final_refresh_reason = static_cast<uint32_t>(source.final_refresh_reason);
    out_telemetry->cache_state_valid = source.cache_validity.state ? 1u : 0u;
    out_telemetry->cache_time_valid = source.cache_validity.time ? 1u : 0u;
    out_telemetry->cache_dynamic_sources_valid = source.cache_validity.dynamic_sources ? 1u : 0u;
    out_telemetry->cache_transport_valid = source.cache_validity.transport ? 1u : 0u;
    out_telemetry->cache_projection_valid = source.cache_validity.projection ? 1u : 0u;
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
#else
    fullmag_fem_set_handle_error(handle, kUnavailableMessage);
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int fullmag_fem_backend_snapshot_representation_receipt_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_representation_receipt_v1 *out_receipt)
{
    if (out_receipt == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_snapshot_representation_receipt_v1 received null out_receipt");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_snapshot_representation_receipt_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }

    fullmag::fem::PeriodicNodeMapView map;
    std::string error;
    if (!fullmag::fem::bind_periodic_node_map(handle->context, map, error)) {
        fullmag_fem_set_handle_error(
            handle,
            "representation receipt rejected invalid periodic map: " + error);
        return FULLMAG_FEM_ERR_INVALID;
    }
    const auto material_location = [](
        const std::vector<double> &nodal,
        const std::vector<double> &element) -> uint32_t {
        if (!nodal.empty()) {
            return FULLMAG_FEM_MATERIAL_LOCATION_NODAL_P1;
        }
        if (!element.empty()) {
            return FULLMAG_FEM_MATERIAL_LOCATION_ELEMENT_DG0;
        }
        return FULLMAG_FEM_MATERIAL_LOCATION_SCALAR;
    };
    const auto counters = fullmag::fem::representation_audit_snapshot(handle->context);
    *out_receipt = {};
    out_receipt->abi_version = FULLMAG_FEM_REPRESENTATION_RECEIPT_V1_ABI_VERSION;
    out_receipt->struct_size = sizeof(*out_receipt);
    out_receipt->state_space = FULLMAG_FEM_REPRESENTATION_SPACE_LOCAL_NODE_AOS;
    out_receipt->ms_location = material_location(
        handle->context.material_fields.Ms_field,
        handle->context.material_fields.Ms_element_field);
    out_receipt->a_location = material_location(
        handle->context.material_fields.A_field,
        handle->context.material_fields.A_element_field);
    out_receipt->local_node_count = map.local_node_count;
    out_receipt->true_node_count = map.true_node_count;
    out_receipt->periodic_map_revision = map.revision;
    out_receipt->representation_copy_count = counters.representation_copy_count;
    out_receipt->gather_scatter_bytes = counters.gather_scatter_bytes;
    out_receipt->invalid_space_assertion_count = counters.invalid_space_assertion_count;
    out_receipt->hot_loop_representation_copy_count =
        counters.hot_loop_representation_copy_count;
    out_receipt->hot_loop_gather_scatter_bytes = counters.hot_loop_gather_scatter_bytes;
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_solver_attempt_count_v1(
    fullmag_fem_backend *handle,
    uint64_t *out_count)
{
    if (handle == nullptr || out_count == nullptr) {
        fullmag_fem_set_handle_error(handle, "solver attempt count requires non-null handle and output");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_count = static_cast<uint64_t>(handle->context.stepper.attempt_trace.records.size());
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_copy_solver_attempts_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_solver_attempt_record_v1 *out_records,
    uint64_t capacity,
    uint64_t *out_count)
{
    if (handle == nullptr || out_count == nullptr || (capacity > 0u && out_records == nullptr)) {
        fullmag_fem_set_handle_error(handle, "solver attempt copy requires valid handle, output count, and capacity buffer");
        return FULLMAG_FEM_ERR_INVALID;
    }
    const auto &records = handle->context.stepper.attempt_trace.records;
    *out_count = static_cast<uint64_t>(records.size());
    if (capacity < records.size()) {
        fullmag_fem_set_handle_error(handle, "solver attempt copy capacity is smaller than the current trace");
        return FULLMAG_FEM_ERR_INVALID;
    }
    for (size_t index = 0; index < records.size(); ++index) {
        const auto &source = records[index];
        auto &target = out_records[index];
        target = {};
        target.abi_version = FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V1_ABI_VERSION;
        target.struct_size = sizeof(target);
        target.attempt = source.attempt;
        target.target_step = source.target_step;
        target.time_seconds = source.time_seconds;
        target.dt_attempt_seconds = source.dt_attempt_seconds;
        target.eta = source.eta;
        target.max_norm_defect = source.max_norm_defect;
        target.max_spin_rotation = source.max_spin_rotation;
        target.decision = static_cast<uint32_t>(source.decision);
        target.reason = source.reason;
        target.dt_next_seconds = source.dt_next_seconds;
        target.demag_solve_count = source.demag_solve_count;
        target.demag_linear_iterations = source.demag_linear_iterations;
        target.demag_linear_residual = source.demag_linear_residual;
        target.rhs_evaluations = source.rhs_evaluations;
        target.estimator_order = source.estimator_order;
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_copy_solver_attempts_v2(
    fullmag_fem_backend *handle,
    fullmag_fem_solver_attempt_record_v2 *out_records,
    uint64_t capacity,
    uint64_t *out_count)
{
    if (handle == nullptr || out_count == nullptr || (capacity > 0u && out_records == nullptr)) {
        fullmag_fem_set_handle_error(handle, "solver attempt v2 copy requires valid handle, output count, and capacity buffer");
        return FULLMAG_FEM_ERR_INVALID;
    }
    const auto &records = handle->context.stepper.attempt_trace.records;
    *out_count = static_cast<uint64_t>(records.size());
    if (capacity < records.size()) {
        fullmag_fem_set_handle_error(handle, "solver attempt v2 copy capacity is smaller than the current trace");
        return FULLMAG_FEM_ERR_INVALID;
    }
    for (size_t index = 0; index < records.size(); ++index) {
        const auto &source = records[index];
        auto &target = out_records[index];
        target = {};
        target.abi_version = FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V2_ABI_VERSION;
        target.struct_size = sizeof(target);
        target.attempt = source.attempt;
        target.target_step = source.target_step;
        target.time_seconds = source.time_seconds;
        target.dt_attempt_seconds = source.dt_attempt_seconds;
        target.eta = source.eta;
        target.max_norm_defect = source.max_norm_defect;
        target.max_spin_rotation = source.max_spin_rotation;
        target.decision = static_cast<uint32_t>(source.decision);
        target.reason = source.reason;
        target.dt_next_seconds = source.dt_next_seconds;
        target.demag_solve_count = source.demag_solve_count;
        target.demag_linear_iterations = source.demag_linear_iterations;
        target.demag_linear_residual = source.demag_linear_residual;
        target.rhs_evaluations = source.rhs_evaluations;
        target.estimator_order = source.estimator_order;
        target.error_norm_type = source.error_norm_type;
        target.active_node_count = source.active_node_count;
        target.active_measure = source.active_measure;
        target.normalization_denominator = source.normalization_denominator;
        target.max_scaled_error = source.max_scaled_error;
        target.weighted_rms_error = source.weighted_rms_error;
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_take_accepted_energy_proof_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_accepted_energy_proof_v1 *out_proof)
{
    if (handle == nullptr || out_proof == nullptr) {
        fullmag_fem_set_handle_error(
            handle, "accepted-energy proof query requires non-null handle and output");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (out_proof->abi_version !=
            FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION ||
        out_proof->struct_size != sizeof(fullmag_fem_accepted_energy_proof_v1)) {
        fullmag_fem_set_handle_error(
            handle, "accepted-energy proof query received incompatible ABI version or size");
        return FULLMAG_FEM_ERR_INVALID;
    }
    const auto source = handle->context.relaxation.accepted_energy_proof;
    fullmag_fem_accepted_energy_proof_v1 result{};
    result.abi_version = FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION;
    result.struct_size = sizeof(result);
    result.accepted_energy_proof_available = source.available ? 1 : 0;
    if (source.available) {
        result.accepted_energy_delta_j = source.delta_j;
        result.accepted_energy_roundoff_bound_j = source.roundoff_bound_j;
        result.accepted_energy_delta_upper_j = source.delta_upper_j;
        result.armijo_increment_rhs_j = source.armijo_rhs_j;
    }
    *out_proof = result;
    handle->context.relaxation.accepted_energy_proof = {};
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_stage_completion(
    fullmag_fem_backend *handle,
    fullmag_fem_stage_completion *out_completion
) {
    if (out_completion == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_stage_completion received null out_completion");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_stage_completion received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_completion = fullmag::fem::stage_completion_snapshot(handle->context);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_device_info(
    fullmag_fem_backend *handle,
    fullmag_fem_device_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_handle_error(handle, "fullmag_fem_backend_get_device_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_device_info received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    *out_info = fullmag::fem::device_info_snapshot(handle->context);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_runtime_build_info(fullmag_fem_runtime_build_info *out_info)
{
    if (out_info == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_get_runtime_build_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!fullmag::fem::runtime_build_info(*out_info)) {
        fullmag_fem_set_global_error(
            "fullmag_fem runtime build identity is unavailable without the MFEM stack");
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_get_runtime_build_info_v2(fullmag_fem_runtime_build_info_v2 *out_info)
{
    if (out_info == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_get_runtime_build_info_v2 received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!fullmag::fem::runtime_build_info_v2(*out_info)) {
        fullmag_fem_set_global_error(
            "fullmag_fem runtime build identity v2 is unavailable without the MFEM stack");
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_transfer_audit(
    fullmag_fem_backend *handle,
    fullmag_fem_transfer_audit *out_audit
) {
    if (out_audit == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_get_transfer_audit received null out_audit");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_transfer_audit received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_audit = fullmag::fem::transfer_audit_snapshot(handle->context);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_gpu_state_info(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_state_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_get_gpu_state_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_gpu_state_info received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_info = fullmag::fem::gpu_state_info(handle->context);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_gpu_rk_plan_info(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_rk_plan_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_get_gpu_rk_plan_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_gpu_rk_plan_info received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    std::string reason;
    const auto plan = fullmag::fem::gpu_rk_plan_device_resident(handle->context, reason);
    *out_info = {};
    out_info->exchange_only_enabled = plan.enabled ? 1 : 0;
    out_info->stage_count = plan.stage_count;
    out_info->uses_cuda_kernels = plan.uses_cuda_kernels ? 1 : 0;
    out_info->allows_exchange_host_sync = plan.allows_exchange_host_sync ? 1 : 0;
    out_info->stage_exchange_device_resident =
        plan.stage_exchange_device_resident ? 1 : 0;
    out_info->uses_gpu_poisson = plan.uses_gpu_poisson ? 1 : 0;
    std::snprintf(
        out_info->exchange_operator_mode,
        sizeof(out_info->exchange_operator_mode),
        "%s",
        plan.exchange_operator_mode != nullptr ? plan.exchange_operator_mode : "unsupported");
    std::snprintf(
        out_info->demag_operator_mode,
        sizeof(out_info->demag_operator_mode),
        "%s",
        plan.demag_operator_mode != nullptr ? plan.demag_operator_mode : "none");
    std::snprintf(
        out_info->hypre_execution_policy,
        sizeof(out_info->hypre_execution_policy),
        "%s",
        plan.hypre_execution_policy != nullptr ? plan.hypre_execution_policy : "none");
    std::snprintf(
        out_info->demag_residency,
        sizeof(out_info->demag_residency),
        "%s",
        plan.demag_residency != nullptr ? plan.demag_residency : "none");
    if (!reason.empty()) {
        std::snprintf(out_info->reason, sizeof(out_info->reason), "%s", reason.c_str());
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_validate_strict_gpu_rk_plan(fullmag_fem_backend *handle) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_validate_strict_gpu_rk_plan received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    std::string reason;
    const auto plan = fullmag::fem::gpu_rk_plan_device_resident(handle->context, reason);
    if (!fullmag::fem::gpu_rk_plan_is_strict_device_resident(plan, reason)) {
        fullmag_fem_set_handle_error(handle, reason.c_str());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_gpu_execution_receipt_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_execution_receipt_v1 *out_receipt
) {
    if (out_receipt == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_execution_receipt_v1 received null out_receipt");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_gpu_execution_receipt_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (out_receipt->abi_version != FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_execution_receipt_v1 received unsupported abi_version");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (out_receipt->struct_size != sizeof(fullmag_fem_gpu_execution_receipt_v1)) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_execution_receipt_v1 received unsupported struct_size");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto snapshot = fullmag::fem::gpu_execution_receipt_snapshot(
        handle->context.gpu_state.execution_receipt);
    if (!snapshot.plan_resolved) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_execution_receipt_v1 has no resolved execution plan");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!snapshot.accounting_valid) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_execution_receipt_v1 accounting is invalid");
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    fullmag_fem_gpu_execution_receipt_v1 receipt{};
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
    receipt.struct_size = sizeof(receipt);
    receipt.execution_class = gpu_execution_class_to_abi(snapshot.execution_class);
    receipt.precision = snapshot.precision;
    receipt.integrator = snapshot.integrator;
    receipt.device_ordinal = snapshot.device_ordinal;
    receipt.required_operator_mask = snapshot.required_operator_mask;
    receipt.resolved_device_operator_mask = snapshot.resolved_device_operator_mask;
    receipt.resolved_host_operator_mask = snapshot.resolved_host_operator_mask;
    receipt.resolved_unknown_operator_mask = snapshot.resolved_unknown_operator_mask;
    receipt.executed_device_operator_mask = snapshot.executed_device_operator_mask;
    receipt.executed_host_operator_mask = snapshot.executed_host_operator_mask;
    receipt.executed_unknown_operator_mask = snapshot.executed_unknown_operator_mask;
    receipt.fallback_count = snapshot.fallback_count;
    receipt.accepted_step_count = snapshot.accepted_step_count;
    receipt.rejected_attempt_count = snapshot.rejected_attempt_count;
    receipt.failed_attempt_count = snapshot.failed_attempt_count;
    receipt.hot_loop_compute_h2d_bytes = snapshot.hot_loop_compute_h2d_bytes;
    receipt.hot_loop_compute_d2h_bytes = snapshot.hot_loop_compute_d2h_bytes;
    receipt.hot_loop_compute_host_sync_count = snapshot.hot_loop_compute_host_sync_count;
    *out_receipt = receipt;
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_gpu_performance_snapshot_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_performance_snapshot_v1 *out_snapshot
) {
    if (out_snapshot == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v1 received null out_snapshot");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_gpu_performance_snapshot_v1 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (out_snapshot->abi_version !=
            FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION ||
        out_snapshot->struct_size !=
            sizeof(fullmag_fem_gpu_performance_snapshot_v1)) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v1 received unsupported abi_version or struct_size");
        return FULLMAG_FEM_ERR_INVALID;
    }
    const auto snapshot = fullmag::fem::gpu_performance_snapshot(
        handle->context.gpu_state.performance_counters);
    *out_snapshot = snapshot;
    if (snapshot.available == 0u) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem GPU performance snapshot is unavailable for CPU execution");
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_gpu_performance_snapshot_v2(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_performance_snapshot_v2 *out_snapshot
) {
    if (out_snapshot == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v2 received null out_snapshot");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_gpu_performance_snapshot_v2 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (out_snapshot->abi_version !=
            FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION ||
        out_snapshot->struct_size !=
            sizeof(fullmag_fem_gpu_performance_snapshot_v2)) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v2 received unsupported abi_version or struct_size");
        return FULLMAG_FEM_ERR_INVALID;
    }
    const auto execution = fullmag::fem::gpu_execution_receipt_snapshot(
        handle->context.gpu_state.execution_receipt);
    if (!execution.plan_resolved) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v2 has no resolved execution plan");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!execution.accounting_valid) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v2 accounting is invalid");
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (execution.accepted_step_count == 0) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_gpu_performance_snapshot_v2 has no accepted execution attempt");
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }

    const auto snapshot = fullmag::fem::gpu_execution_receipt_performance_snapshot(
        handle->context.gpu_state.execution_receipt);
    fullmag_fem_gpu_performance_snapshot_v2 out{};
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
    out.struct_size = sizeof(out);
    out.setup_count = snapshot.setup_count;
    out.apply_count = snapshot.apply_count;
    out.kernel_launch_count = snapshot.kernel_launch_count;
    out.compute_fence_count = snapshot.compute_fence_count;
    out.snapshot_fence_count = snapshot.snapshot_fence_count;
    out.export_fence_count = snapshot.export_fence_count;
    out.selected_sparse_kernel_id = snapshot.selected_sparse_kernel_id;
    out.setup_wall_time_ns = snapshot.setup_wall_time_ns;
    out.apply_wall_time_ns = snapshot.apply_wall_time_ns;
    out.accepted_finalization_wall_time_ns =
        snapshot.accepted_finalization_wall_time_ns;
    *out_snapshot = out;
    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

const char *fullmag_fem_backend_last_error(fullmag_fem_backend *handle) {
    if (handle != nullptr) {
        return handle->last_error.empty() ? nullptr : handle->last_error.c_str();
    }
    return fullmag_fem_get_global_error();
}

void fullmag_fem_backend_destroy(fullmag_fem_backend *handle) {
    if (handle != nullptr) {
        fullmag::fem::destroy_backend_runtime(handle->context);
    }
    delete handle;
}

int fullmag_fem_backend_upload_strain(
    fullmag_fem_backend *handle,
    const double *strain_voigt,
    uint64_t len,
    int uniform
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_upload_strain received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (strain_voigt == nullptr || len == 0) {
        fullmag_fem_set_handle_error(handle, "strain data pointer is null or length is zero");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    if (!fullmag::fem::upload_magnetoelastic_strain(
            handle->context,
            strain_voigt,
            len,
            uniform != 0,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_eigen_dense(fullmag_fem_eigen_dense_desc *desc) {
    return fullmag::fem::solve_dense_generalized_eigenproblem(desc);
}

} // extern "C"
