#include "gpu/cuda/relaxation/bb_exchange_mass.hpp"
#include "gpu/cuda/relaxation/bb_exchange_mass_kernels.hpp"
#include "context.hpp"
#include "gpu/cuda/state/device_memory.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"
#include "src/relaxation_operator_units.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>

#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include <mfem.hpp>
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {
void gpu_bb_exchange_mass_resolve(const Context &ctx, GpuBbExchangeMassStatus &out)
{
    out = {};
    const uint32_t policy = ctx.gpu_state.device.relaxation.bb_preconditioner_policy;
    out.requested_policy = policy;
    if (policy == 1u) {
        out.resolved_enabled = false;
        out.solver_kind = "not_used";
        out.preconditioner_kind = "not_used";
        out.fallback_reason = "policy_none";
        return;
    }
    if (!ctx.exchange.enabled) {
        out.resolved_enabled = false;
        out.solver_kind = "not_used";
        out.preconditioner_kind = "not_used";
        out.fallback_reason = "exchange_disabled";
        return;
    }
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
    const auto *mass_form = ctx.exchange.mfem.mass_form;
    const auto *exchange_form = ctx.exchange.mfem.exchange_form;
    if (mass_form == nullptr || exchange_form == nullptr ||
        mass_form->FESpace() == nullptr || exchange_form->FESpace() == nullptr ||
        !mfem::Device::Allows(mfem::Backend::CUDA_MASK)) {
        out.resolved_enabled = false;
        out.fallback_reason = "mfem_forms_unavailable";
        return;
    }
    const auto &mass_mat = mass_form->SpMat();
    const auto &stiff_mat = exchange_form->SpMat();
    const uint64_t expected_nodes = ctx.gpu_state.device.lifecycle.node_count;
    if (mass_mat.Height() <= 0 ||
        mass_mat.Height() > (std::numeric_limits<int>::max() - 256) / 3 ||
        mass_mat.Height() != mass_mat.Width() ||
        stiff_mat.Height() != mass_mat.Height() ||
        stiff_mat.Width() != mass_mat.Width() ||
        !mass_mat.Finalized() || !stiff_mat.Finalized() ||
        (expected_nodes > 0 &&
         static_cast<uint64_t>(mass_mat.Height()) != expected_nodes)) {
        out.resolved_enabled = false;
        out.fallback_reason = "mfem_forms_unavailable";
        return;
    }
    int blocks = 0;
    if (gpu_bb_pcg_grid_size(mass_mat.Height(), blocks) != cudaSuccess || blocks <= 0) {
        out.resolved_enabled = false;
        out.fallback_reason = "cooperative_launch_unsupported";
        return;
    }
    out.resolved_enabled = true;
    out.solver_kind = "cooperative_device_pcg";
    out.preconditioner_kind = "device_jacobi";
    out.fallback_reason = "";
    if (ctx.gpu_state.device.relaxation.bb_exchange_mass != nullptr) {
        out.last_iterations = gpu_bb_exchange_mass_last_iterations(
            *ctx.gpu_state.device.relaxation.bb_exchange_mass);
        out.last_relative_residual = gpu_bb_exchange_mass_last_relative_residual(
            *ctx.gpu_state.device.relaxation.bb_exchange_mass);
    }
#else
    out.resolved_enabled = false;
    out.fallback_reason = "mfem_forms_unavailable";
#endif
}

bool gpu_bb_exchange_mass_enabled(const Context &ctx)
{
    GpuBbExchangeMassStatus status{};
    gpu_bb_exchange_mass_resolve(ctx, status);
    return status.resolved_enabled;
}

#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
namespace {
constexpr int kBbReductionBlockSize = 256;

bool checked(cudaError_t status, const char *operation, std::string &error)
{
    if (status == cudaSuccess) { return true; }
    error = std::string(operation) + ": " + cudaGetErrorString(status);
    return false;
}

bool force_pageable_scalar_readback()
{
    const char *value = std::getenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    return value != nullptr && std::strcmp(value, "1") == 0;
}

GpuBbCsr device_csr(const mfem::SparseMatrix &matrix)
{ return {matrix.ReadI(), matrix.ReadJ(), matrix.ReadData()}; }

struct GpuBbHostReadbackStaging {
    GpuBbPcgResult last{};
    double direction_dot_gradient = 0.0;
};
}

struct GpuBbExchangeMassWorkspace {
    mfem::SparseMatrix mass, stiffness, regularized_mass;
    GpuBbPcgDevice device{};
    FemGpuComponentField direction{};
    cudaEvent_t uploaded = nullptr;
    const mfem::SparseMatrix *source_mass = nullptr;
    const mfem::SparseMatrix *source_stiffness = nullptr;
    OperatorDependencyKey source_key{};
    uint64_t device_bytes = 0;
    int blocks = 0;
    GpuBbPcgResult last{};
    GpuBbHostReadbackStaging *host_readback = nullptr;
    GpuBbHostReadbackStaging pageable_readback{};
    bool host_readback_pinned = false;

    GpuBbExchangeMassWorkspace(const mfem::SparseMatrix &m, const mfem::SparseMatrix &k)
        : mass(m), stiffness(k), regularized_mass(m.Height())
    {
        const int *rows = mass.HostReadI(), *columns = mass.HostReadJ();
        const double *values = mass.HostReadData();
        for (int row = 0; row < mass.Height(); ++row) {
            bool nonzero = false;
            for (int j = rows[row]; j < rows[row + 1]; ++j) {
                if (values[j] != 0.0) {
                    regularized_mass.Add(row, columns[j], values[j]);
                    nonzero = true;
                }
            }
            // Air-only rows are identities, exactly as in the CPU solve.
            // They are still zero in the physical mass used by the RHS.
            if (!nonzero) { regularized_mass.Add(row, row, 1.0); }
        }
        regularized_mass.Finalize();
        source_mass = &m;
        source_stiffness = &k;
    }
    ~GpuBbExchangeMassWorkspace()
    {
        if (host_readback != nullptr && host_readback_pinned) {
            cudaFreeHost(host_readback);
        }
        host_readback = nullptr;
        host_readback_pinned = false;
        gpu_device_free_component(direction);
        gpu_device_free_component(device.rhs);
        gpu_device_free_component(device.residual);
        gpu_device_free_component(device.search);
        gpu_device_free_component(device.applied);
        gpu_device_free_double(device.inv_sqrt_diagonal);
        gpu_device_free_double(device.block_sums);
        void *result = device.result;
        gpu_device_free_bytes(result);
        if (uploaded != nullptr) { cudaEventDestroy(uploaded); }
    }
};

bool gpu_bb_exchange_mass_create(
    const mfem::SparseMatrix &mass_ms, const mfem::SparseMatrix &stiffness_a,
    std::shared_ptr<GpuBbExchangeMassWorkspace> &workspace,
    TransferAudit &audit, std::string &error)
{
    if (!mfem::Device::Allows(mfem::Backend::CUDA_MASK) ||
        mass_ms.Height() <= 0 || mass_ms.Height() > (std::numeric_limits<int>::max() - 256) / 3 ||
        mass_ms.Height() != mass_ms.Width() || stiffness_a.Height() != mass_ms.Height() ||
        stiffness_a.Width() != mass_ms.Width() || !mass_ms.Finalized() || !stiffness_a.Finalized()) {
        error = "FEM GPU BB requires CUDA and compatible finalized MFEM exchange-mass operators";
        return false;
    }
    int blocks = 0;
    if (!checked(gpu_bb_pcg_grid_size(mass_ms.Height(), blocks),
                 "FEM GPU BB requires cooperative CUDA PCG (no CPU fallback)", error)) { return false; }
    for (const auto *matrix : {&mass_ms, &stiffness_a}) {
        const double *values = matrix->HostReadData();
        for (int i = 0; i < matrix->NumNonZeroElems(); ++i) {
            if (!std::isfinite(values[i])) {
                error = "FEM GPU BB exchange-mass operator contains non-finite values";
                return false;
            }
        }
    }
    auto w = std::make_shared<GpuBbExchangeMassWorkspace>(mass_ms, stiffness_a);
    w->blocks = blocks;
    const uint64_t nodes = static_cast<uint64_t>(mass_ms.Height());
    if (!gpu_device_allocate_component(w->direction, nodes, w->device_bytes, error) ||
        !gpu_device_allocate_component(w->device.rhs, nodes, w->device_bytes, error) ||
        !gpu_device_allocate_component(w->device.residual, nodes, w->device_bytes, error) ||
        !gpu_device_allocate_component(w->device.search, nodes, w->device_bytes, error) ||
        !gpu_device_allocate_component(w->device.applied, nodes, w->device_bytes, error) ||
        !gpu_device_allocate_double(w->device.inv_sqrt_diagonal, nodes, w->device_bytes, error) ||
        !gpu_device_allocate_double(w->device.block_sums, 6ull * blocks + 6ull, w->device_bytes, error) ||
        !gpu_device_allocate_bytes(reinterpret_cast<void **>(&w->device.result),
            sizeof(GpuBbPcgResult), w->device_bytes, error)) { return false; }

    const bool forced_pageable = force_pageable_scalar_readback();
    const cudaError_t host_status = forced_pageable
        ? cudaErrorMemoryAllocation
        : cudaHostAlloc(
              reinterpret_cast<void **>(&w->host_readback),
              sizeof(GpuBbHostReadbackStaging),
              cudaHostAllocDefault);
    if (host_status == cudaSuccess) {
        *w->host_readback = {};
        w->host_readback_pinned = true;
    } else if (host_status == cudaErrorMemoryAllocation) {
        cudaGetLastError();
        w->host_readback = &w->pageable_readback;
        w->host_readback_pinned = false;
    } else {
        error = std::string("cudaHostAlloc BB scalar readback staging failed: ") +
            cudaGetErrorString(host_status);
        w->host_readback = nullptr;
        w->host_readback_pinned = false;
        return false;
    }

    w->device.mass = device_csr(w->mass);
    w->device.stiffness = device_csr(w->stiffness);
    w->device.regularized_mass = device_csr(w->regularized_mass);
    uint64_t csr_bytes = 0;
    for (const auto *matrix : {&w->mass, &w->stiffness, &w->regularized_mass}) {
        csr_bytes += (nodes + 1) * sizeof(int) +
            static_cast<uint64_t>(matrix->NumNonZeroElems()) * (sizeof(int) + sizeof(double));
    }
    // These are cold immutable MFEM CSR uploads; hot solves never revisit
    // host matrices or rebuild/upload an operator when lambda changes.
    w->device_bytes += csr_bytes;
    record_host_to_device(audit, csr_bytes);
    if (!checked(cudaEventCreateWithFlags(&w->uploaded, cudaEventDisableTiming),
                 "create BB CSR upload event", error) ||
        !checked(cudaEventRecord(w->uploaded, nullptr), "record BB CSR upload", error)) { return false; }
    workspace = std::move(w);
    return true;
}

const FemGpuComponentField &gpu_bb_exchange_mass_direction(const GpuBbExchangeMassWorkspace &workspace)
{
    return workspace.direction;
}

bool gpu_bb_exchange_mass_solve(
    GpuBbExchangeMassWorkspace &w, const FemGpuComponentField &gradient,
    const FemGpuComponentField &direction, double step_m_per_a,
    void *compute_stream, TransferAudit &audit, std::string &error)
{
    if (!std::isfinite(step_m_per_a) || step_m_per_a <= 0.0 ||
        gradient.x == nullptr || gradient.y == nullptr || gradient.z == nullptr ||
        direction.x == nullptr || direction.y == nullptr || direction.z == nullptr ||
        w.host_readback == nullptr) {
        error = "FEM GPU BB exchange-mass received invalid step or device field";
        return false;
    }
    const auto stream = reinterpret_cast<cudaStream_t>(compute_stream);
    const double weight = relaxation::exchange_hessian_scale_from_step_m_per_a(
        std::clamp(step_m_per_a,
            relaxation::kDirectMinimizerPreconditionerMinimumStepMPerA,
            relaxation::kDirectMinimizerPreconditionerMaximumStepMPerA));
    if (!checked(cudaStreamWaitEvent(stream, w.uploaded, 0), "order immutable BB CSR upload", error) ||
        !checked(gpu_bb_pcg_launch(w.device, gradient, direction, w.mass.Height(),
            w.blocks, weight, stream), "launch cooperative BB device PCG", error) ||
        !checked(cudaMemcpyAsync(&w.host_readback->last, w.device.result, sizeof(w.last),
            cudaMemcpyDeviceToHost, stream), "read BB final residual certificate", error) ||
        !checked(cudaStreamSynchronize(stream), "complete BB final certificate read", error)) { return false; }
    w.last = w.host_readback->last;
    // One small terminal result only. Every inner dot, alpha/beta update,
    // stopping decision and true residual action stayed inside one GPU launch.
    record_device_control_scalar_to_host(audit, sizeof(w.last));
    if (w.last.status != 1) {
        error = "cooperative FEM GPU BB PCG failed: status=" + std::to_string(w.last.status) +
            " iterations=" + std::to_string(w.last.iterations);
        return false;
    }
    return true;
}

bool gpu_bb_exchange_mass_solve_and_project(
    GpuBbExchangeMassWorkspace &w,
    const FemGpuComponentField &m_backup,
    const FemGpuComponentField &gradient,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *active_node_mask,
    bool has_periodic_reduced_nodes,
    const uint32_t *periodic_representative_nodes,
    double *scalar_workspace,
    double *scalar_result_slot,
    void *reduction_temp_storage,
    size_t reduction_temp_storage_bytes,
    int blocks,
    double step_m_per_a,
    void *compute_stream,
    TransferAudit &audit,
    double &out_direction_dot_gradient,
    std::string &error)
{
    out_direction_dot_gradient = 0.0;
    const int n = w.mass.Height();
    const int expected_blocks = (n + kBbReductionBlockSize - 1) / kBbReductionBlockSize;
    if (!std::isfinite(step_m_per_a) || step_m_per_a <= 0.0 ||
        m_backup.x == nullptr || m_backup.y == nullptr || m_backup.z == nullptr ||
        gradient.x == nullptr || gradient.y == nullptr || gradient.z == nullptr ||
        w.direction.x == nullptr || w.direction.y == nullptr || w.direction.z == nullptr ||
        ms == nullptr || lumped_mass == nullptr || active_node_mask == nullptr ||
        (has_periodic_reduced_nodes && periodic_representative_nodes == nullptr) ||
        scalar_workspace == nullptr || scalar_result_slot == nullptr ||
        reduction_temp_storage == nullptr || reduction_temp_storage_bytes == 0 ||
        blocks <= 0 || blocks != expected_blocks || w.host_readback == nullptr) {
        error = "FEM GPU BB exchange-mass solve_and_project received invalid arguments";
        return false;
    }
    const auto stream = reinterpret_cast<cudaStream_t>(compute_stream);
    const double weight = relaxation::exchange_hessian_scale_from_step_m_per_a(
        std::clamp(step_m_per_a,
            relaxation::kDirectMinimizerPreconditionerMinimumStepMPerA,
            relaxation::kDirectMinimizerPreconditionerMaximumStepMPerA));
    const auto &z = w.direction;
    if (!checked(cudaStreamWaitEvent(stream, w.uploaded, 0), "order immutable BB CSR upload", error) ||
        !checked(gpu_bb_pcg_launch(w.device, gradient, z, n, w.blocks, weight, stream),
                 "launch cooperative BB device PCG", error)) {
        return false;
    }
    if (has_periodic_reduced_nodes) {
        fullmag_cuda_relax_project_static_periodic_field(
            z.x, z.y, z.z, periodic_representative_nodes, n, stream);
    }
    fullmag_cuda_relax_project_tangent_field(
        m_backup.x, m_backup.y, m_backup.z,
        z.x, z.y, z.z, active_node_mask, n, stream);
    fullmag_cuda_relax_energy_weighted_dot_blocks(
        z.x, z.y, z.z,
        gradient.x, gradient.y, gradient.z,
        ms, lumped_mass, active_node_mask, scalar_workspace, n, stream);
    if (!checked(cudaPeekAtLastError(), "project BB preconditioned direction", error)) {
        return false;
    }
    size_t reduce_bytes = reduction_temp_storage_bytes;
    fullmag_cuda_device_sum(
        scalar_workspace,
        blocks,
        scalar_result_slot,
        reduction_temp_storage,
        reduce_bytes,
        stream);
    if (!checked(cudaPeekAtLastError(), "reduce BB direction descent", error) ||
        !checked(cudaMemcpyAsync(&w.host_readback->last, w.device.result, sizeof(w.last),
            cudaMemcpyDeviceToHost, stream), "read BB final residual certificate", error) ||
        !checked(cudaMemcpyAsync(&w.host_readback->direction_dot_gradient, scalar_result_slot,
            sizeof(double), cudaMemcpyDeviceToHost, stream), "read BB direction descent", error) ||
        !checked(cudaStreamSynchronize(stream), "complete fused BB solve and descent read", error)) {
        return false;
    }
    w.last = w.host_readback->last;
    const double dot = w.host_readback->direction_dot_gradient;
    record_device_control_scalar_to_host(audit, sizeof(w.last) + sizeof(double));
    if (w.last.status != 1) {
        error = "cooperative FEM GPU BB PCG failed: status=" + std::to_string(w.last.status) +
            " iterations=" + std::to_string(w.last.iterations);
        return false;
    }
    if (!std::isfinite(dot)) {
        error = "non-finite FEM GPU BB preconditioned descent metric";
        return false;
    }
    out_direction_dot_gradient = dot;
    return true;
}

double gpu_bb_exchange_mass_last_relative_residual(const GpuBbExchangeMassWorkspace &w)
{
    double result = 0.0;
    for (int c = 0; c < 3; ++c) {
        const double rhs = w.last.scaled_rhs_norm_squared[c];
        const double r = w.last.scaled_residual_norm_squared[c];
        result = std::max(result, rhs > 0.0 ? std::sqrt(r / rhs) : std::sqrt(r));
    }
    return result;
}
uint64_t gpu_bb_exchange_mass_last_iterations(const GpuBbExchangeMassWorkspace &w)
{ return static_cast<uint64_t>(std::max(0, w.last.iterations)); }
#endif

bool gpu_bb_exchange_mass_prepare(Context &ctx, std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
    auto &state = ctx.gpu_state.device.relaxation;
    auto *mass = ctx.exchange.mfem.mass_form;
    auto *stiffness = ctx.exchange.mfem.exchange_form;
    if (mass == nullptr || stiffness == nullptr) {
        error = "FEM GPU BB exchange-mass requires assembled MFEM mass and exchange forms";
        return false;
    }
    if (state.bb_exchange_mass != nullptr &&
        state.bb_exchange_mass->source_mass == &mass->SpMat() &&
        state.bb_exchange_mass->source_stiffness == &stiffness->SpMat() &&
        state.bb_exchange_mass->source_key == ctx.exchange.mfem.operator_lifecycle.active_key) {
        state.bb_preconditioner_cache_hits += 1;
        return true;
    }
    state.bb_preconditioner_cache_misses += 1;
    const uint64_t previous_bytes = state.bb_exchange_mass ? state.bb_exchange_mass->device_bytes : 0;
    if (!gpu_bb_exchange_mass_create(mass->SpMat(), stiffness->SpMat(),
            state.bb_exchange_mass, ctx.transfer_audit.audit, error)) { return false; }
    state.bb_exchange_mass->source_key = ctx.exchange.mfem.operator_lifecycle.active_key;
    auto &bytes = ctx.gpu_state.device.lifecycle.device_bytes;
    bytes = bytes >= previous_bytes ? bytes - previous_bytes : 0;
    bytes += state.bb_exchange_mass->device_bytes;
    return true;
#else
    (void)ctx;
    error = "FEM GPU BB exchange-mass requires MFEM and CUDA";
    return false;
#endif
}
} // namespace fullmag::fem
