/*
 * GPU CUDA RK LLG RHS dispatch source contract.
 *
 * This source owns the fused LLG RHS launch used by GPU RK RHS assembly after
 * H_eff accumulation. It preserves the backend-neutral LLG contract arguments:
 * gamma_mu0, damping, alpha-field selection, and precession mode. It does not
 * own exchange, demag, local-field generation, H_eff accumulation, direct
 * torque additions, RK stage scheduling, final statistics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/llg/llg_rhs_kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

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

} // namespace

bool gpu_rk_compute_llg_rhs(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
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
    return cuda_launch_ok("launch GPU RK RHS", reason);
}

} // namespace fullmag::fem
