/*
 * GPU CUDA RK prescribed-SOT direct-torque source contract.
 *
 * This source owns device launch validation and delegates the local SI/Gilbert
 * algebra to the SOT interaction kernel. It does not solve SHE/iSHE transport.
 */

#include "gpu/cuda/integrators/rk/rk_sot_torque.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/sot/sot_kernels.hpp"
#include "cpu/mfem/interactions/sot.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

namespace {

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    const cudaError_t status = cudaPeekAtLastError();
    if (status == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(status);
    return false;
}

} // namespace

bool gpu_rk_add_prescribed_sot_torque(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    std::string &reason)
{
    if (!ctx.sot.enabled) {
        return true;
    }
    auto &gpu = ctx.gpu_state.device;
    if (gpu.materials.ms == nullptr || gpu.materials.alpha == nullptr) {
        reason = "GPU RK prescribed SOT requires device-resident Ms and alpha";
        return false;
    }
    if (!ctx.sot.active_node_mask.empty() &&
        (gpu.mesh_regions.stt_active_node_mask == nullptr ||
            gpu.mesh_regions.stt_active_node_count != static_cast<uint64_t>(ctx.mesh.n_nodes))) {
        reason = "GPU RK prescribed SOT requires the canonical target-node mask on device";
        return false;
    }
    fullmag_cuda_add_prescribed_sot_rhs(
        m.x,
        m.y,
        m.z,
        gpu.materials.ms,
        gpu.materials.alpha,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.mesh_regions.stt_active_node_mask,
        rhs.x,
        rhs.y,
        rhs.z,
        gpu.reductions.scalar_workspace,
        ctx.sot.current_density_am2,
        ctx.sot.xi_dl,
        ctx.sot.xi_fl,
        evaluate_sot_envelope(ctx.sot, evaluation_time_s, ctx.zeeman.stage_start_time_s),
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.sot.thickness,
        ctx.sot.sigma[0],
        ctx.sot.sigma[1],
        ctx.sot.sigma[2],
        n,
        stream);
    return cuda_launch_ok("launch GPU prescribed SOT RHS", reason);
}

} // namespace fullmag::fem
