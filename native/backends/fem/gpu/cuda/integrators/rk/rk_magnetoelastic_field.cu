/*
 * GPU CUDA RK magnetoelastic local field source contract.
 *
 * This source owns prescribed-strain magnetoelastic field validation and
 * kernel launch for the device-resident RK local-field path. It does not own
 * generic local-field orchestration, H_eff accumulation, LLG RHS evaluation,
 * RK step scheduling, final statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"

#include <cuda_runtime.h>

#include <cstdint>
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

bool gpu_rk_compute_magnetoelastic_field_contribution(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (!ctx.magnetoelastic.enabled) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    const uint64_t per_node_strain_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 6ull;
    const bool use_per_node_strain = !ctx.magnetoelastic.uniform_strain;
    if (!use_per_node_strain && ctx.magnetoelastic.strain_voigt.size() < 6u) {
        reason = "GPU RK magnetoelastic field requires prescribed strain data";
        return false;
    }
    if (use_per_node_strain &&
        static_cast<uint64_t>(ctx.magnetoelastic.strain_voigt.size()) != per_node_strain_len) {
        reason = "GPU RK magnetoelastic field requires 6 prescribed strain Voigt values per node";
        return false;
    }
    if (use_per_node_strain &&
        (gpu.mel_strain_voigt == nullptr || !gpu.mel_strain_uploaded ||
            gpu.mel_strain_voigt_len != per_node_strain_len)) {
        reason = "GPU RK magnetoelastic field requires device-resident per-node strain";
        return false;
    }
    if (gpu.materials.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr ||
        gpu.h_mel.x == nullptr || gpu.h_mel.y == nullptr || gpu.h_mel.z == nullptr) {
        reason = "GPU RK magnetoelastic field requires device-resident Ms, lumped mass, and H_mel buffers";
        return false;
    }
    const double *eps = ctx.magnetoelastic.strain_voigt.data();
    fullmag_cuda_magnetoelastic_field_energy_blocks(
        m.x,
        m.y,
        m.z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        use_per_node_strain ? gpu.mel_strain_voigt : nullptr,
        gpu.h_mel.x,
        gpu.h_mel.y,
        gpu.h_mel.z,
        gpu.scalar_reduce_workspace,
        ctx.magnetoelastic.b1,
        ctx.magnetoelastic.b2,
        eps[0],
        eps[1],
        eps[2],
        eps[3] * 0.5,
        eps[4] * 0.5,
        eps[5] * 0.5,
        use_per_node_strain,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetoelastic field", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
