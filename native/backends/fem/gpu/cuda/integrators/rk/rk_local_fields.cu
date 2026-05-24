/*
 * GPU CUDA RK local field contributions source contract.
 *
 * This source owns per-stage generation of local effective-field
 * contributions used by the device-resident RK RHS: uniaxial anisotropy,
 * cubic anisotropy, prescribed-strain magnetoelasticity, and deterministic
 * Brown thermal fields. It does not own exchange, demag dispatch, H_eff
 * accumulation, LLG RHS evaluation, direct torque terms, RK step scheduling,
 * final statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"
#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"

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

bool gpu_rk_compute_local_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (ctx.anisotropy.uniaxial_enabled) {
        if (gpu.ms == nullptr || gpu.ku == nullptr || gpu.ku2 == nullptr ||
            gpu.exchange_lumped_mass == nullptr ||
            gpu.h_ani.x == nullptr || gpu.h_ani.y == nullptr || gpu.h_ani.z == nullptr) {
            reason = "GPU RK uniaxial anisotropy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers";
            return false;
        }
        fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
            m.x,
            m.y,
            m.z,
            gpu.ms,
            gpu.ku,
            gpu.ku2,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_ani.x,
            gpu.h_ani.y,
            gpu.h_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy.uniaxial_Ku,
            ctx.anisotropy.uniaxial_Ku2,
            ctx.anisotropy.uniaxial_axis[0],
            ctx.anisotropy.uniaxial_axis[1],
            ctx.anisotropy.uniaxial_axis[2],
            !ctx.material_fields.Ku_field.empty(),
            !ctx.material_fields.Ku2_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy field", reason)) {
            return false;
        }
    }
    if (ctx.anisotropy.cubic_enabled) {
        if (gpu.ms == nullptr || gpu.kc1 == nullptr || gpu.kc2 == nullptr ||
            gpu.kc3 == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_cubic_ani.x == nullptr || gpu.h_cubic_ani.y == nullptr ||
            gpu.h_cubic_ani.z == nullptr) {
            reason = "GPU RK cubic anisotropy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers";
            return false;
        }
        fullmag_cuda_cubic_anisotropy_field_energy_blocks(
            m.x,
            m.y,
            m.z,
            gpu.ms,
            gpu.kc1,
            gpu.kc2,
            gpu.kc3,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_cubic_ani.x,
            gpu.h_cubic_ani.y,
            gpu.h_cubic_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy.cubic_Kc1,
            ctx.anisotropy.cubic_Kc2,
            ctx.anisotropy.cubic_Kc3,
            ctx.anisotropy.cubic_axis1[0],
            ctx.anisotropy.cubic_axis1[1],
            ctx.anisotropy.cubic_axis1[2],
            ctx.anisotropy.cubic_axis2[0],
            ctx.anisotropy.cubic_axis2[1],
            ctx.anisotropy.cubic_axis2[2],
            !ctx.material_fields.Kc1_field.empty(),
            !ctx.material_fields.Kc2_field.empty(),
            !ctx.material_fields.Kc3_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy field", reason)) {
            return false;
        }
    }
    if (ctx.magnetoelastic.enabled) {
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
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_mel.x == nullptr || gpu.h_mel.y == nullptr || gpu.h_mel.z == nullptr) {
            reason = "GPU RK magnetoelastic field requires device-resident Ms, lumped mass, and H_mel buffers";
            return false;
        }
        const double *eps = ctx.magnetoelastic.strain_voigt.data();
        fullmag_cuda_magnetoelastic_field_energy_blocks(
            m.x,
            m.y,
            m.z,
            gpu.ms,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
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
    }
    if (ctx.thermal_brown.temperature > 0.0) {
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
    }
    return true;
}

} // namespace fullmag::fem
