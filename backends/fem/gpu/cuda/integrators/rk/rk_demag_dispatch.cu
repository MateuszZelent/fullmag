/*
 * GPU CUDA RK demag dispatch source contract.
 *
 * This source owns per-stage demag mode dispatch for GPU RK RHS assembly:
 * strict device Poisson dispatch and the explicit hybrid CPU Poisson
 * compatibility path. It does not own exchange dispatch, DMI/local field
 * generation, H_eff accumulation, LLG RHS, RK stage scheduling, final
 * statistics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_demag_dispatch.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

namespace {

bool gpu_rk_compute_hybrid_cpu_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason,
    bool fresh_initial_guess)
{
    if (!ctx.demag.enabled) {
        return true;
    }
#if FULLMAG_HAS_MFEM_STACK
    auto &gpu = ctx.gpu_state.device;
    if (gpu.fields.h_demag.x == nullptr || gpu.fields.h_demag.y == nullptr || gpu.fields.h_demag.z == nullptr) {
        reason = "GPU RK hybrid CPU demag requires allocated device H_demag buffers";
        return false;
    }
    if (!gpu_rk_download_component_device_to_aos(
            ctx,
            m,
            gpu.demag_poisson.hybrid_stage_m_xyz,
            stream,
            "cudaMemcpy2DAsync GPU RK hybrid demag stage magnetization device->host",
            reason)) {
        return false;
    }
    double demag_energy = 0.0;
    if (fresh_initial_guess) {
        reset_demag_poisson_hypre_initial_guess(ctx);
    }
    if (!compute_demag_field_for_magnetization(
            ctx,
            gpu.demag_poisson.hybrid_stage_m_xyz,
            gpu.demag_poisson.hybrid_demag_xyz,
            demag_energy,
            true,
            nullptr,
            reason)) {
        return false;
    }
    ctx.demag.h_xyz = gpu.demag_poisson.hybrid_demag_xyz;
    gpu.demag_poisson.hybrid_demag_energy_joules = demag_energy;
    return gpu_state_upload_demag_field_aos(
        gpu,
        gpu.demag_poisson.hybrid_demag_xyz.data(),
        static_cast<uint64_t>(gpu.demag_poisson.hybrid_demag_xyz.size()),
        ctx.transfer_audit.audit,
        reason);
#else
    reason = "GPU RK hybrid CPU demag requires MFEM stack";
    return false;
#endif
}

} // namespace

bool gpu_rk_compute_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason)
{
    if (!ctx.demag.enabled) {
        return true;
    }
    if (ctx.poisson_demag.fresh_initial_guess_required) {
        const bool refreshed =
            ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON
                ? gpu_rk_compute_hybrid_cpu_demag_for_device_stage(
                      ctx, m, stream, reason, true)
                : compute_device_demag_for_device_stage_fresh(ctx, m, stream, reason);
        if (refreshed) {
            ctx.poisson_demag.fresh_initial_guess_required = false;
        }
        return refreshed;
    }
    if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON) {
        return gpu_rk_compute_hybrid_cpu_demag_for_device_stage(
            ctx, m, stream, reason, false);
    }
    return compute_device_demag_for_device_stage(ctx, m, stream, reason);
}

bool gpu_rk_compute_demag_for_device_stage_fresh(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason)
{
    if (!ctx.demag.enabled) {
        return true;
    }
    if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON) {
        return gpu_rk_compute_hybrid_cpu_demag_for_device_stage(
            ctx, m, stream, reason, true);
    }
    return compute_device_demag_for_device_stage_fresh(ctx, m, stream, reason);
}

} // namespace fullmag::fem
