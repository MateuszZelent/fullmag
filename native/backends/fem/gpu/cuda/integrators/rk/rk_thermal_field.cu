/*
 * GPU CUDA RK thermal local field source contract.
 *
 * This source owns deterministic Brown thermal field validation and kernel
 * launch for the device-resident RK local-field path. It does not own generic
 * local-field orchestration, H_eff accumulation, LLG RHS evaluation, RK step
 * scheduling, final statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_thermal_field.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"

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

bool gpu_rk_compute_thermal_field_contribution(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (ctx.thermal_brown.temperature <= 0.0) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    if (ctx.thermal_brown.seed == 0) {
        reason = "GPU RK thermal field requires deterministic thermal seed";
        return false;
    }
    if (ctx.adaptive_dt.current_dt <= 0.0) {
        reason = "GPU RK thermal field requires positive timestep";
        return false;
    }
    if (gpu.ms == nullptr || gpu.alpha == nullptr || gpu.node_volumes == nullptr ||
        gpu.h_therm.x == nullptr || gpu.h_therm.y == nullptr || gpu.h_therm.z == nullptr) {
        reason = "GPU RK thermal field requires device-resident Ms, alpha, node volumes, and H_therm buffers";
        return false;
    }
    fullmag_cuda_thermal_field_blocks(
        gpu.ms,
        gpu.alpha,
        gpu.node_volumes,
        gpu.magnetic_node_mask,
        gpu.h_therm.x,
        gpu.h_therm.y,
        gpu.h_therm.z,
        gpu.scalar_reduce_workspace,
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.material.damping,
        ctx.thermal_brown.temperature,
        ctx.adaptive_dt.current_dt,
        ctx.thermal_brown.seed,
        ctx.state.step_count,
        !ctx.material_fields.alpha_field.empty(),
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK deterministic thermal field", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
