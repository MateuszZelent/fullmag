// ── GPU CUDA RK RHS runtime source contract ───────────────────────────
// This source owns device-resident RHS assembly orchestration for GPU RK:
// exchange, demag dispatch, local-field accumulation, LLG RHS, and direct
// torque terms. It does not own RK step orchestration, final stats, stage
// kernels, adaptive policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/kernels/kernels.hpp"

#include <cmath>
#include <cstdint>
#include <limits>
#include <string>

namespace fullmag::fem {

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;

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

double gpu_rk_oersted_scale(const Context &ctx)
{
    if (!ctx.oersted.has_cylinder) {
        return 1.0;
    }
    double scale = ctx.oersted.current;
    switch (ctx.oersted.time_dep_kind) {
        case 1:
            scale *= std::sin(
                         2.0 * kPi * ctx.oersted.time_dep_freq * ctx.state.current_time +
                         ctx.oersted.time_dep_phase) +
                     ctx.oersted.time_dep_offset;
            break;
        case 2:
            scale *= (ctx.state.current_time >= ctx.oersted.time_dep_t_on &&
                      ctx.state.current_time < ctx.oersted.time_dep_t_off)
                         ? 1.0
                         : 0.0;
            break;
        default:
            break;
    }
    return scale;
}

double gpu_rk_current_density_magnitude(const Context &ctx)
{
    const double jx = ctx.stt.current_density_am2[0];
    const double jy = ctx.stt.current_density_am2[1];
    const double jz = ctx.stt.current_density_am2[2];
    return std::sqrt(jx * jx + jy * jy + jz * jz);
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
    auto compute_dmi_field = [&](bool bulk_mode) -> bool {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
            gpu.nodes_xyz == nullptr || gpu.elements == nullptr ||
            gpu.magnetic_element_mask == nullptr ||
            gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.zhang_li_rhs.x == nullptr || gpu.zhang_li_rhs.y == nullptr ||
            gpu.zhang_li_rhs.z == nullptr) {
            reason = "GPU RK DMI requires device-resident mesh geometry, Ms, lumped mass, and residual buffers";
            return false;
        }
        FemGpuComponentField &field = bulk_mode ? gpu.h_bulk_dmi : gpu.h_dmi;
        if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
            reason = "GPU RK DMI requires device-resident H_dmi buffers";
            return false;
        }
        fullmag_cuda_dmi_field_energy(
            gpu.nodes_xyz,
            gpu.elements,
            gpu.magnetic_element_mask,
            m.x,
            m.y,
            m.z,
            gpu.ms,
            bulk_mode ? gpu.dbulk : gpu.dind,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.zhang_li_rhs.x,
            gpu.zhang_li_rhs.y,
            gpu.zhang_li_rhs.z,
            field.x,
            field.y,
            field.z,
            gpu.scalar_reduce_workspace,
            ctx.material_fields.material.saturation_magnetisation,
            bulk_mode ? ctx.dmi.bulk_D : ctx.dmi.interfacial_D,
            ctx.dmi.interface_normal[0],
            ctx.dmi.interface_normal[1],
            ctx.dmi.interface_normal[2],
            bulk_mode ? !ctx.material_fields.Dbulk_field.empty() : !ctx.material_fields.Dind_field.empty(),
            bulk_mode,
            static_cast<int>(ctx.mesh.n_elements),
            n,
            stream);
        if (!cuda_launch_ok(bulk_mode ? "launch GPU RK bulk DMI field" : "launch GPU RK interfacial DMI field", reason)) {
            return false;
        }
        return true;
    };
    if (ctx.dmi.interfacial_enabled && !compute_dmi_field(false)) {
        return false;
    }
    if (ctx.dmi.bulk_enabled && !compute_dmi_field(true)) {
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
    fullmag_cuda_accumulate_heff(gpu.h_ex.x, gpu.h_demag.x, gpu.h_ext.x, gpu.h_eff.x, n, true, stream);
    fullmag_cuda_accumulate_heff(gpu.h_ex.y, gpu.h_demag.y, gpu.h_ext.y, gpu.h_eff.y, n, true, stream);
    fullmag_cuda_accumulate_heff(gpu.h_ex.z, gpu.h_demag.z, gpu.h_ext.z, gpu.h_eff.z, n, true, stream);
    if (!cuda_launch_ok(label, reason)) {
        return false;
    }
    if (ctx.anisotropy.uniaxial_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_ani.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_ani.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_ani.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.anisotropy.cubic_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.dmi.interfacial_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_dmi.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_dmi.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_dmi.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK interfacial DMI h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.dmi.bulk_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK bulk DMI h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.oersted.has_cylinder || ctx.oersted.has_explicit_field) {
        if (gpu.h_oe.x == nullptr || gpu.h_oe.y == nullptr || gpu.h_oe.z == nullptr) {
            reason = "GPU RK Oersted field requires device-resident H_oe buffers";
            return false;
        }
        const double scale = gpu_rk_oersted_scale(ctx);
        fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.x, gpu.h_eff.x, scale, n, stream);
        fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.y, gpu.h_eff.y, scale, n, stream);
        fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.z, gpu.h_eff.z, scale, n, stream);
        if (!cuda_launch_ok("launch GPU RK Oersted h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.magnetoelastic.enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_mel.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_mel.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_mel.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.thermal_brown.temperature > 0.0) {
        fullmag_cuda_add_field_inplace(gpu.h_therm.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_therm.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_therm.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK thermal h_eff accumulation", reason)) {
            return false;
        }
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
    if (ctx.stt.slonczewski_enabled) {
        const double slonczewski_thickness = gpu_rk_resolve_slonczewski_thickness(ctx);
        if (slonczewski_thickness <= 0.0) {
            reason = "GPU RK Slonczewski STT requires explicit or geometry-derived free-layer thickness";
            return false;
        }
        if (gpu.ms == nullptr) {
            reason = "GPU RK Slonczewski STT requires device-resident Ms";
            return false;
        }
        fullmag_cuda_add_slonczewski_stt_rhs(
            m.x,
            m.y,
            m.z,
            gpu.ms,
            gpu.magnetic_node_mask,
            rhs.x,
            rhs.y,
            rhs.z,
            gpu.scalar_reduce_workspace,
            gpu_rk_current_density_magnitude(ctx),
            ctx.stt.current_sign,
            slonczewski_thickness,
            ctx.stt.degree > 0.0 ? ctx.stt.degree : 1.0,
            ctx.stt.lambda,
            ctx.stt.epsilon_prime,
            ctx.stt.spin_polarization[0],
            ctx.stt.spin_polarization[1],
            ctx.stt.spin_polarization[2],
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK Slonczewski STT RHS", reason)) {
            return false;
        }
    }
    if (ctx.stt.zhang_li_enabled) {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
            gpu.nodes_xyz == nullptr || gpu.elements == nullptr ||
            gpu.magnetic_element_mask == nullptr) {
            reason = "GPU RK Zhang-Li STT requires device-resident mesh geometry";
            return false;
        }
        if (gpu.ms == nullptr || gpu.zhang_li_rhs.x == nullptr ||
            gpu.zhang_li_rhs.y == nullptr || gpu.zhang_li_rhs.z == nullptr ||
            gpu.zhang_li_node_weight == nullptr) {
            reason = "GPU RK Zhang-Li STT requires device-resident Ms and Zhang-Li work buffers";
            return false;
        }
        fullmag_cuda_add_zhang_li_stt_rhs(
            gpu.nodes_xyz,
            gpu.elements,
            gpu.magnetic_element_mask,
            m.x,
            m.y,
            m.z,
            gpu.ms,
            gpu.magnetic_node_mask,
            gpu.zhang_li_rhs.x,
            gpu.zhang_li_rhs.y,
            gpu.zhang_li_rhs.z,
            gpu.zhang_li_node_weight,
            rhs.x,
            rhs.y,
            rhs.z,
            gpu.scalar_reduce_workspace,
            ctx.stt.current_density_am2[0],
            ctx.stt.current_density_am2[1],
            ctx.stt.current_density_am2[2],
            ctx.stt.degree,
            ctx.stt.beta,
            static_cast<int>(ctx.mesh.n_elements),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK Zhang-Li STT RHS", reason)) {
            return false;
        }
    }
    return true;
}

} // namespace fullmag::fem
