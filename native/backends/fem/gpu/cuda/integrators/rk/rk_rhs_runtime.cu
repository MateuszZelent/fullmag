// ── GPU CUDA RK RHS runtime source contract ───────────────────────────
// This source owns device-resident RHS assembly orchestration for GPU RK:
// exchange, DMI field contribution dispatch, demag dispatch, local-field
// contribution dispatch, H_eff accumulation, LLG RHS, and direct torque
// dispatch. It does not own DMI field generation, local-field generation,
// direct torque RHS additions, RK step orchestration, final stats, stage
// kernels, adaptive policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"
#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"
#include "gpu/cuda/kernels/kernels.hpp"

#include <cstdint>
#include <limits>
#include <string>

namespace fullmag::fem {

namespace {

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

bool gpu_rk_compute_hybrid_cpu_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason)
{
    if (!ctx.demag.enabled) {
        return true;
    }
#if FULLMAG_HAS_MFEM_STACK
    auto &gpu = ctx.gpu_state.device;
    if (gpu.h_demag.x == nullptr || gpu.h_demag.y == nullptr || gpu.h_demag.z == nullptr) {
        reason = "GPU RK hybrid CPU demag requires allocated device H_demag buffers";
        return false;
    }
    if (!gpu_rk_download_component_device_to_aos(
            ctx,
            m,
            gpu.hybrid_stage_m_xyz,
            stream,
            "cudaMemcpy2DAsync GPU RK hybrid demag stage magnetization device->host",
            reason)) {
        return false;
    }
    double demag_energy = 0.0;
    if (!compute_demag_field_for_magnetization(
            ctx,
            gpu.hybrid_stage_m_xyz,
            gpu.hybrid_demag_xyz,
            demag_energy,
            true,
            nullptr,
            reason)) {
        return false;
    }
    ctx.demag.h_xyz = gpu.hybrid_demag_xyz;
    gpu.hybrid_demag_energy_joules = demag_energy;
    return gpu_state_upload_demag_field_aos(
        gpu,
        gpu.hybrid_demag_xyz.data(),
        static_cast<uint64_t>(gpu.hybrid_demag_xyz.size()),
        ctx.transfer_audit.audit,
        reason);
#else
    reason = "GPU RK hybrid CPU demag requires MFEM stack";
    return false;
#endif
}

bool gpu_rk_compute_legacy_sparse_exchange(
    FemGpuState &gpu,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason)
{
    if (!gpu.exchange_legacy_sparse_uploaded ||
        gpu.exchange_csr_row_offsets == nullptr ||
        gpu.exchange_csr_col_indices == nullptr ||
        gpu.exchange_csr_values == nullptr ||
        gpu.ms == nullptr ||
        gpu.exchange_inv_lumped_mass == nullptr) {
        reason = "GPU legacy sparse exchange requires uploaded CSR/mass device buffers";
        return false;
    }
    if (gpu.exchange_legacy_sparse_rows != gpu.node_count ||
        gpu.exchange_legacy_sparse_cols != gpu.node_count ||
        gpu.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU legacy sparse exchange dimensions do not match RK node_count";
        return false;
    }

    const int rows = static_cast<int>(gpu.node_count);
    fullmag_cuda_legacy_sparse_exchange(
        gpu.exchange_csr_row_offsets,
        gpu.exchange_csr_col_indices,
        gpu.exchange_csr_values,
        m.x,
        gpu.ms,
        gpu.exchange_inv_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.h_ex.x,
        rows,
        stream);
    fullmag_cuda_legacy_sparse_exchange(
        gpu.exchange_csr_row_offsets,
        gpu.exchange_csr_col_indices,
        gpu.exchange_csr_values,
        m.y,
        gpu.ms,
        gpu.exchange_inv_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.h_ex.y,
        rows,
        stream);
    fullmag_cuda_legacy_sparse_exchange(
        gpu.exchange_csr_row_offsets,
        gpu.exchange_csr_col_indices,
        gpu.exchange_csr_values,
        m.z,
        gpu.ms,
        gpu.exchange_inv_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.h_ex.z,
        rows,
        stream);
    return cuda_launch_ok("launch GPU legacy sparse exchange", reason);
}

} // namespace

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0) {
        return false;
    }
    if (ctx.oersted.time_dep_kind != 0u) {
        return false;
    }
    return true;
}

bool gpu_rk_compute_rhs_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    const char *label,
    std::string &reason)
{
    if (!gpu_rk_compute_legacy_sparse_exchange(ctx.gpu_state.device, m, stream, reason)) {
        return false;
    }
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_compute_dmi_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    if (ctx.demag.enabled) {
        if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON) {
            if (!gpu_rk_compute_hybrid_cpu_demag_for_device_stage(ctx, m, stream, reason)) {
                return false;
            }
        } else if (!compute_device_demag_for_device_stage(ctx, m, stream, reason)) {
            return false;
        }
    }
    if (!gpu_rk_compute_local_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_accumulate_effective_field(ctx, stream, n, label, reason)) {
        return false;
    }

    fullmag_cuda_llg_rhs_fused(
        m.x, m.y, m.z,
        gpu.h_eff.x, gpu.h_eff.y, gpu.h_eff.z,
        rhs.x, rhs.y, rhs.z,
        gpu.scalar_reduce_workspace,
        gpu.alpha,
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.material.damping,
        !ctx.material_fields.alpha_field.empty(),
        ctx.base_plan.precession_enabled,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK RHS", reason)) {
        return false;
    }
    if (!gpu_rk_add_direct_torques(ctx, m, rhs, stream, n, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
