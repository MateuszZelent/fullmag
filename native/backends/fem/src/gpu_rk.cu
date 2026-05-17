#include "gpu_rk.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "gpu_state.hpp"
#include "kernels.h"
#include "transfer_audit.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;
constexpr double kPi = 3.141592653589793238462643383279502884;

struct GpuAdaptiveResult {
    bool accepted;
    double dt_next;
};

double oersted_scale(const Context &ctx)
{
    if (!ctx.has_oersted_cylinder) {
        return 1.0;
    }
    double scale = ctx.oersted_current;
    switch (ctx.oersted_time_dep_kind) {
        case 1:
            scale *= std::sin(
                         2.0 * kPi * ctx.oersted_time_dep_freq * ctx.current_time +
                         ctx.oersted_time_dep_phase) +
                     ctx.oersted_time_dep_offset;
            break;
        case 2:
            scale *= (ctx.current_time >= ctx.oersted_time_dep_t_on &&
                      ctx.current_time < ctx.oersted_time_dep_t_off)
                         ? 1.0
                         : 0.0;
            break;
        default:
            break;
    }
    return scale;
}

double current_density_magnitude(const Context &ctx)
{
    const double jx = ctx.stt_current_density_am2[0];
    const double jy = ctx.stt_current_density_am2[1];
    const double jz = ctx.stt_current_density_am2[2];
    return std::sqrt(jx * jx + jy * jy + jz * jz);
}

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

bool read_scalar_result(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double &value,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state;
    if (!cuda_ok(
            cudaMemcpyAsync(
                &value,
                gpu.scalar_reduce_result,
                sizeof(double),
                cudaMemcpyDeviceToHost,
                stream),
            label,
            reason)) {
        return false;
    }
    if (!cuda_ok(cudaStreamSynchronize(stream), "cudaStreamSynchronize GPU RK scalar stats", reason)) {
        return false;
    }
    record_device_to_host(ctx.transfer_audit, sizeof(double));
    return true;
}

bool copy_component_device(
    const FemGpuComponentField &src,
    FemGpuComponentField &dst,
    uint64_t node_count,
    cudaStream_t stream,
    const char *operation,
    std::string &reason)
{
    const size_t bytes = static_cast<size_t>(node_count) * sizeof(double);
    if (!cuda_ok(
            cudaMemcpyAsync(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice, stream),
            operation,
            reason) ||
        !cuda_ok(
            cudaMemcpyAsync(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice, stream),
            operation,
            reason) ||
        !cuda_ok(
            cudaMemcpyAsync(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice, stream),
            operation,
            reason)) {
        return false;
    }
    return true;
}

bool compute_legacy_sparse_exchange(
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

GpuAdaptiveResult gpu_adaptive_pi_step(Context &ctx, double error_norm)
{
    if (!ctx.adaptive_dt_enabled || error_norm <= 0.0) {
        return {true, ctx.dt_seconds};
    }

    const double clamped_error = std::max(error_norm, 1e-15);
    if (clamped_error <= 1.0) {
        double ratio = ctx.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.pi_alpha) *
                       std::pow(ctx.prev_error_norm / clamped_error, ctx.pi_beta);
        ratio = std::min(ratio, ctx.dt_grow_max);
        ratio = std::max(ratio, 1.0);

        const double dt_new = std::min(ctx.dt_seconds * ratio, ctx.dt_max);
        ctx.prev_error_norm = clamped_error;
        return {true, dt_new};
    }

    double ratio = ctx.safety_factor * std::pow(1.0 / clamped_error, ctx.pi_alpha);
    ratio = std::max(ratio, ctx.dt_shrink_min);

    const double dt_new = std::max(ctx.dt_seconds * ratio, ctx.dt_min);
    ctx.rejected_steps += 1;
    return {false, dt_new};
}

bool restore_adaptive_reject_magnetization_device(
    FemGpuState &gpu,
    cudaStream_t stream,
    std::string &reason)
{
    gpu.fsal_valid = false;
    return copy_component_device(
        gpu.m_backup,
        gpu.m,
        gpu.node_count,
        stream,
        "cudaMemcpyAsync GPU RK restore rejected adaptive magnetization device copy",
        reason);
}

bool compute_adaptive_error_norm_device(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    cudaStream_t stream,
    int n,
    int blocks,
    double &error_norm,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state;
    if (gpu.scalar_reduce_temp_storage == nullptr ||
        gpu.scalar_reduce_temp_storage_bytes == 0) {
        reason = "GPU RK adaptive error norm requires preallocated CUB reduction temp storage";
        return false;
    }

    fullmag_cuda_adaptive_error_norm_blocks(
        gpu.m_backup.x, gpu.m_backup.y, gpu.m_backup.z,
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.k[6].x, gpu.k[6].y, gpu.k[6].z,
        tableau.b_hi[0], tableau.b_hi[1], tableau.b_hi[2], tableau.b_hi[3],
        tableau.b_hi[4], tableau.b_hi[5], tableau.b_hi[6],
        tableau.b_lo[0], tableau.b_lo[1], tableau.b_lo[2], tableau.b_lo[3],
        tableau.b_lo[4], tableau.b_lo[5], tableau.b_lo[6],
        dt_seconds,
        ctx.adaptive_atol,
        ctx.adaptive_rtol,
        gpu.scalar_reduce_workspace,
        tableau.stages,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK adaptive error norm blocks", reason)) {
        return false;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        std::max(1, blocks),
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK adaptive error norm reduction", reason)) {
        return false;
    }

    return read_scalar_result(
        ctx,
        stream,
        "cudaMemcpyAsync GPU RK adaptive error norm scalar device->host",
        error_norm,
        reason);
}

__global__ void euler_stage_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ kx,
    const double *__restrict__ ky,
    const double *__restrict__ kz,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    out_x[i] = mx[i] + dt * kx[i];
    out_y[i] = my[i] + dt * ky[i];
    out_z[i] = mz[i] + dt * kz[i];
}

__global__ void rk45_stage_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k1x,
    const double *__restrict__ k1y,
    const double *__restrict__ k1z,
    const double *__restrict__ k2x,
    const double *__restrict__ k2y,
    const double *__restrict__ k2z,
    const double *__restrict__ k3x,
    const double *__restrict__ k3y,
    const double *__restrict__ k3z,
    const double *__restrict__ k4x,
    const double *__restrict__ k4y,
    const double *__restrict__ k4z,
    const double *__restrict__ k5x,
    const double *__restrict__ k5y,
    const double *__restrict__ k5z,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    double c0,
    double c1,
    double c2,
    double c3,
    double c4,
    double c5,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    out_x[i] = mx[i] + dt * (
        c0 * k0x[i] + c1 * k1x[i] + c2 * k2x[i] +
        c3 * k3x[i] + c4 * k4x[i] + c5 * k5x[i]);
    out_y[i] = my[i] + dt * (
        c0 * k0y[i] + c1 * k1y[i] + c2 * k2y[i] +
        c3 * k3y[i] + c4 * k4y[i] + c5 * k5y[i]);
    out_z[i] = mz[i] + dt * (
        c0 * k0z[i] + c1 * k1z[i] + c2 * k2z[i] +
        c3 * k3z[i] + c4 * k4z[i] + c5 * k5z[i]);
}

__global__ void heun_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k1x,
    const double *__restrict__ k1y,
    const double *__restrict__ k1z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    mx[i] += 0.5 * dt * (k0x[i] + k1x[i]);
    my[i] += 0.5 * dt * (k0y[i] + k1y[i]);
    mz[i] += 0.5 * dt * (k0z[i] + k1z[i]);
}

__global__ void rk4_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k1x,
    const double *__restrict__ k1y,
    const double *__restrict__ k1z,
    const double *__restrict__ k2x,
    const double *__restrict__ k2y,
    const double *__restrict__ k2z,
    const double *__restrict__ k3x,
    const double *__restrict__ k3y,
    const double *__restrict__ k3z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    const double scale = dt / 6.0;
    mx[i] += scale * (k0x[i] + 2.0 * k1x[i] + 2.0 * k2x[i] + k3x[i]);
    my[i] += scale * (k0y[i] + 2.0 * k1y[i] + 2.0 * k2y[i] + k3y[i]);
    mz[i] += scale * (k0z[i] + 2.0 * k1z[i] + 2.0 * k2z[i] + k3z[i]);
}

__global__ void bs23_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k1x,
    const double *__restrict__ k1y,
    const double *__restrict__ k1z,
    const double *__restrict__ k2x,
    const double *__restrict__ k2y,
    const double *__restrict__ k2z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    mx[i] += dt * ((2.0 / 9.0) * k0x[i] + (1.0 / 3.0) * k1x[i] + (4.0 / 9.0) * k2x[i]);
    my[i] += dt * ((2.0 / 9.0) * k0y[i] + (1.0 / 3.0) * k1y[i] + (4.0 / 9.0) * k2y[i]);
    mz[i] += dt * ((2.0 / 9.0) * k0z[i] + (1.0 / 3.0) * k1z[i] + (4.0 / 9.0) * k2z[i]);
}

__global__ void dp54_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k2x,
    const double *__restrict__ k2y,
    const double *__restrict__ k2z,
    const double *__restrict__ k3x,
    const double *__restrict__ k3y,
    const double *__restrict__ k3z,
    const double *__restrict__ k4x,
    const double *__restrict__ k4y,
    const double *__restrict__ k4z,
    const double *__restrict__ k5x,
    const double *__restrict__ k5y,
    const double *__restrict__ k5z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    mx[i] += dt * (
        (35.0 / 384.0) * k0x[i] +
        (500.0 / 1113.0) * k2x[i] +
        (125.0 / 192.0) * k3x[i] -
        (2187.0 / 6784.0) * k4x[i] +
        (11.0 / 84.0) * k5x[i]);
    my[i] += dt * (
        (35.0 / 384.0) * k0y[i] +
        (500.0 / 1113.0) * k2y[i] +
        (125.0 / 192.0) * k3y[i] -
        (2187.0 / 6784.0) * k4y[i] +
        (11.0 / 84.0) * k5y[i]);
    mz[i] += dt * (
        (35.0 / 384.0) * k0z[i] +
        (500.0 / 1113.0) * k2z[i] +
        (125.0 / 192.0) * k3z[i] -
        (2187.0 / 6784.0) * k4z[i] +
        (11.0 / 84.0) * k5z[i]);
}

bool compute_rhs_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    const char *label,
    std::string &reason)
{
    if (!compute_legacy_sparse_exchange(ctx.gpu_state, m, stream, reason)) {
        return false;
    }
    auto &gpu = ctx.gpu_state;
    auto compute_dmi_field = [&](bool bulk_mode) -> bool {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.n_elements) ||
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
        fullmag_cuda_dmi_field_energy_serial(
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
            ctx.material.saturation_magnetisation,
            bulk_mode ? ctx.bulk_dmi_D : ctx.dmi_D,
            ctx.dmi_n_hat[0],
            ctx.dmi_n_hat[1],
            ctx.dmi_n_hat[2],
            bulk_mode ? !ctx.Dbulk_field.empty() : !ctx.Dind_field.empty(),
            bulk_mode,
            static_cast<int>(ctx.n_elements),
            n,
            stream);
        if (!cuda_launch_ok(bulk_mode ? "launch GPU RK bulk DMI field" : "launch GPU RK interfacial DMI field", reason)) {
            return false;
        }
        return true;
    };
    if (ctx.enable_dmi && !compute_dmi_field(false)) {
        return false;
    }
    if (ctx.enable_bulk_dmi && !compute_dmi_field(true)) {
        return false;
    }
    if (ctx.enable_anisotropy) {
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
            ctx.anisotropy_Ku,
            ctx.anisotropy_Ku2,
            ctx.anisotropy_axis[0],
            ctx.anisotropy_axis[1],
            ctx.anisotropy_axis[2],
            !ctx.Ku_field.empty(),
            !ctx.Ku2_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy field", reason)) {
            return false;
        }
    }
    if (ctx.enable_cubic_anisotropy) {
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
            ctx.cubic_Kc1,
            ctx.cubic_Kc2,
            ctx.cubic_Kc3,
            ctx.cubic_axis1[0],
            ctx.cubic_axis1[1],
            ctx.cubic_axis1[2],
            ctx.cubic_axis2[0],
            ctx.cubic_axis2[1],
            ctx.cubic_axis2[2],
            !ctx.Kc1_field.empty(),
            !ctx.Kc2_field.empty(),
            !ctx.Kc3_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy field", reason)) {
            return false;
        }
    }
    if (ctx.enable_magnetoelastic) {
        const uint64_t per_node_strain_len = static_cast<uint64_t>(ctx.n_nodes) * 6ull;
        const bool use_per_node_strain = !ctx.mel_uniform_strain;
        if (!use_per_node_strain && ctx.mel_strain_voigt.size() < 6u) {
            reason = "GPU RK magnetoelastic field requires prescribed strain data";
            return false;
        }
        if (use_per_node_strain &&
            static_cast<uint64_t>(ctx.mel_strain_voigt.size()) != per_node_strain_len) {
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
        const double *eps = ctx.mel_strain_voigt.data();
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
            ctx.mel_b1,
            ctx.mel_b2,
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
    if (ctx.temperature > 0.0) {
        if (ctx.thermal_seed == 0) {
            reason = "GPU RK thermal field requires deterministic thermal seed";
            return false;
        }
        if (ctx.current_dt <= 0.0) {
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
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.temperature,
            ctx.current_dt,
            ctx.thermal_seed,
            ctx.step_count,
            !ctx.alpha_field.empty(),
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
    if (ctx.enable_anisotropy) {
        fullmag_cuda_add_field_inplace(gpu.h_ani.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_ani.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_ani.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.enable_cubic_anisotropy) {
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.enable_dmi) {
        fullmag_cuda_add_field_inplace(gpu.h_dmi.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_dmi.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_dmi.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK interfacial DMI h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.enable_bulk_dmi) {
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK bulk DMI h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.has_oersted_cylinder || ctx.has_oersted_field) {
        if (gpu.h_oe.x == nullptr || gpu.h_oe.y == nullptr || gpu.h_oe.z == nullptr) {
            reason = "GPU RK Oersted field requires device-resident H_oe buffers";
            return false;
        }
        const double scale = oersted_scale(ctx);
        fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.x, gpu.h_eff.x, scale, n, stream);
        fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.y, gpu.h_eff.y, scale, n, stream);
        fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.z, gpu.h_eff.z, scale, n, stream);
        if (!cuda_launch_ok("launch GPU RK Oersted h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.enable_magnetoelastic) {
        fullmag_cuda_add_field_inplace(gpu.h_mel.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_mel.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_mel.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.temperature > 0.0) {
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
        ctx.material.gyromagnetic_ratio,
        ctx.material.damping,
        !ctx.alpha_field.empty(),
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK RHS", reason)) {
        return false;
    }
    if (ctx.has_slonczewski_stt) {
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
            current_density_magnitude(ctx),
            ctx.stt_current_sign,
            slonczewski_thickness,
            ctx.stt_degree > 0.0 ? ctx.stt_degree : 1.0,
            ctx.stt_lambda,
            ctx.stt_epsilon_prime,
            ctx.stt_spin_polarization[0],
            ctx.stt_spin_polarization[1],
            ctx.stt_spin_polarization[2],
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK Slonczewski STT RHS", reason)) {
            return false;
        }
    }
    if (ctx.has_zhang_li_stt) {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.n_elements) ||
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
            ctx.stt_current_density_am2[0],
            ctx.stt_current_density_am2[1],
            ctx.stt_current_density_am2[2],
            ctx.stt_degree,
            ctx.stt_beta,
            static_cast<int>(ctx.n_elements),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK Zhang-Li STT RHS", reason)) {
            return false;
        }
    }
    return true;
}

} // namespace

bool gpu_rk_exchange_only_step(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    stats = {};
    const auto plan = gpu_rk_plan_exchange_only(ctx, reason);
    if (!plan.enabled) {
        return false;
    }
    const bool is_heun =
        ctx.integrator == FULLMAG_FEM_INTEGRATOR_HEUN && tableau.stages == 2;
    const bool is_rk4 =
        ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK4 && tableau.stages == 4;
    const bool is_rk23 =
        ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS && tableau.stages == 4;
    const bool is_rk45 =
        ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54 && tableau.stages == 7;
    if (!is_heun && !is_rk4 && !is_rk23 && !is_rk45) {
        reason = "GPU RK execution surface currently implements fixed-step Heun, RK4, RK23, and RK45 only";
        return false;
    }
    if (dt_seconds <= 0.0) {
        reason = "GPU RK exchange-only step requires a positive dt";
        return false;
    }

    auto &gpu = ctx.gpu_state;
    const int n = static_cast<int>(ctx.n_nodes);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.compute_stream);

    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH &&
        gpu.device_state == FemGpuSyncState::DeviceClean &&
        gpu.host_state == FemGpuSyncState::HostClean) {
        gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    }
    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH) {
        reason = "GPU RK exchange-only step requires FemGpuState device source of truth";
        return false;
    }
    if (plan.exchange_operator_mode == nullptr ||
        std::string(plan.exchange_operator_mode) != "legacy_sparse_gpu") {
        reason = "GPU RK exchange-only step requires legacy_sparse_gpu exchange operator mode";
        return false;
    }

    const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt_enabled;
    const bool fsal_method = is_rk23 || is_rk45;
    double active_dt = dt_seconds;
    double error_estimate = 0.0;
    double suggested_dt = dt_seconds;
    uint32_t rejected_attempts = 0;
    uint32_t total_stage_rhs_evaluations = 0;
    uint32_t stage_rhs_evaluations = 0;
    bool fsal_reused = false;

    for (;;) {
    ctx.current_dt = active_dt;
    stage_rhs_evaluations = 0;
    fsal_reused = fsal_method && gpu.fsal_valid;
    if (!copy_component_device(
            gpu.m,
            gpu.m_backup,
            gpu.node_count,
            stream,
            "cudaMemcpyAsync GPU RK backup magnetization device copy",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    if (!fsal_reused) {
        if (!compute_rhs_for_magnetization(
                ctx,
                gpu.m,
                gpu.k[0],
                stream,
                n,
                "launch GPU RK stage-0 h_eff accumulation",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
    }

    euler_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        is_heun ? active_dt : (is_rk45 ? 0.2 * active_dt : 0.5 * active_dt),
        n);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK predictor/normalize", reason)) {
        return false;
    }

    if (!compute_rhs_for_magnetization(
            ctx,
            gpu.m_stage,
            gpu.k[1],
            stream,
            n,
            "launch GPU RK stage-1 h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    if (is_rk45) {
        rk45_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            3.0 / 40.0, 9.0 / 40.0, 0.0, 0.0, 0.0, 0.0,
            active_dt,
            n);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-2/normalize", reason)) {
            return false;
        }
        if (!compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[2], stream, n,
                "launch GPU RK45 stage-2 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        rk45_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            44.0 / 45.0, -56.0 / 15.0, 32.0 / 9.0, 0.0, 0.0, 0.0,
            active_dt,
            n);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-3/normalize", reason)) {
            return false;
        }
        if (!compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[3], stream, n,
                "launch GPU RK45 stage-3 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        rk45_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            19372.0 / 6561.0, -25360.0 / 2187.0, 64448.0 / 6561.0,
            -212.0 / 729.0, 0.0, 0.0,
            active_dt,
            n);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-4/normalize", reason)) {
            return false;
        }
        if (!compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[4], stream, n,
                "launch GPU RK45 stage-4 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        rk45_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            9017.0 / 3168.0, -355.0 / 33.0, 46732.0 / 5247.0,
            49.0 / 176.0, -5103.0 / 18656.0, 0.0,
            active_dt,
            n);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-5/normalize", reason)) {
            return false;
        }
        if (!compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[5], stream, n,
                "launch GPU RK45 stage-5 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        rk45_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            35.0 / 384.0, 0.0, 500.0 / 1113.0,
            125.0 / 192.0, -2187.0 / 6784.0, 11.0 / 84.0,
            active_dt,
            n);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-6/normalize", reason)) {
            return false;
        }
        if (!compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[6], stream, n,
                "launch GPU RK45 stage-6 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        dp54_accept_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            active_dt,
            n);
    } else if (is_rk4 || is_rk23) {
        euler_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            is_rk23 ? 0.75 * active_dt : 0.5 * active_dt,
            n);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK4 midpoint-2/normalize", reason)) {
            return false;
        }
        if (!compute_rhs_for_magnetization(
                ctx,
                gpu.m_stage,
                gpu.k[2],
                stream,
                n,
                "launch GPU RK stage-2 h_eff accumulation",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
        if (is_rk23) {
            bs23_accept_kernel<<<blocks, kBlockSize, 0, stream>>>(
                gpu.m.x, gpu.m.y, gpu.m.z,
                gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
                gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
                gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
                active_dt,
                n);
        } else {
            euler_stage_kernel<<<blocks, kBlockSize, 0, stream>>>(
                gpu.m.x, gpu.m.y, gpu.m.z,
                gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
                gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
                active_dt,
                n);
            fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
            if (!cuda_launch_ok("launch GPU RK4 endpoint/normalize", reason)) {
                return false;
            }
            if (!compute_rhs_for_magnetization(
                    ctx,
                    gpu.m_stage,
                    gpu.k[3],
                    stream,
                    n,
                    "launch GPU RK stage-3 h_eff accumulation",
                    reason)) {
                gpu.fsal_valid = false;
                return false;
            }
            stage_rhs_evaluations += 1;
            rk4_accept_kernel<<<blocks, kBlockSize, 0, stream>>>(
                gpu.m.x, gpu.m.y, gpu.m.z,
                gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
                gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
                gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
                gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
                active_dt,
                n);
        }
    } else {
        heun_accept_kernel<<<blocks, kBlockSize, 0, stream>>>(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            active_dt,
            n);
    }
    fullmag_cuda_normalize_vectors(gpu.m.x, gpu.m.y, gpu.m.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK accept/normalize", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    total_stage_rhs_evaluations += stage_rhs_evaluations;

    if (adaptive) {
        if (!compute_adaptive_error_norm_device(
                ctx,
                tableau,
                active_dt,
                stream,
                n,
                blocks,
                error_estimate,
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        const auto adaptive_result = gpu_adaptive_pi_step(ctx, error_estimate);
        suggested_dt = adaptive_result.dt_next;
        if (!adaptive_result.accepted) {
            if (!restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                return false;
            }
            active_dt = adaptive_result.dt_next;
            ctx.dt_seconds = active_dt;
            ctx.current_dt = active_dt;
            rejected_attempts += 1;
            continue;
        }
        ctx.dt_seconds = suggested_dt;
    } else {
        error_estimate = 0.0;
        suggested_dt = active_dt;
    }
    break;
    }

    if (!compute_rhs_for_magnetization(
            ctx,
            gpu.m,
            gpu.error,
            stream,
            n,
            "launch GPU RK final h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    if (fsal_method) {
        if (!copy_component_device(
                gpu.error,
                gpu.k[0],
                gpu.node_count,
                stream,
                "cudaMemcpyAsync GPU RK FSAL k0 device copy",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        gpu.fsal_valid = true;
    } else {
        gpu.fsal_valid = false;
    }

    if (gpu.scalar_reduce_temp_storage == nullptr ||
        gpu.scalar_reduce_temp_storage_bytes == 0) {
        reason = "GPU RK device max requires preallocated CUB reduction temp storage";
        gpu.fsal_valid = false;
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        std::max(1, blocks),
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK device max query", reason)) {
        gpu.fsal_valid = false;
        return false;
    }

    ctx.current_time += active_dt;
    ctx.step_count += 1;
    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = active_dt;
    stats.error_estimate = error_estimate;
    stats.dt_suggested = suggested_dt;
    stats.rejected_attempts = rejected_attempts;
    stats.rhs_evaluations = total_stage_rhs_evaluations + 1;
    stats.fsal_reused = fsal_reused ? 1 : 0;
    gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.device_state = FemGpuSyncState::DeviceDirty;
    gpu.host_state = FemGpuSyncState::HostStale;
    reason.clear();
    return true;
}

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state;
    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        gpu.scalar_reduce_result == nullptr ||
        gpu.scalar_reduce_temp_storage == nullptr) {
        return true;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.compute_stream);
    double max_rhs = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK max_rhs device->host",
            max_rhs,
            reason)) {
        return false;
    }
    stats.max_rhs_amplitude = max_rhs;

    const int n = static_cast<int>(gpu.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    if (blocks <= 0) {
        return true;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_legacy_sparse_exchange_energy_blocks(
        gpu.exchange_csr_row_offsets,
        gpu.exchange_csr_col_indices,
        gpu.exchange_csr_values,
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK exchange energy blocks", reason)) {
        return false;
    }
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK exchange energy reduction", reason)) {
        return false;
    }
    double exchange_energy = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK exchange energy device->host",
            exchange_energy,
            reason)) {
        return false;
    }

    double external_energy = 0.0;
    if (ctx.has_external_field) {
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_ext.x == nullptr || gpu.h_ext.y == nullptr || gpu.h_ext.z == nullptr) {
            reason = "GPU RK external energy requires device-resident Ms, lumped mass, and H_ext";
            return false;
        }
        fullmag_cuda_external_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.h_ext.x,
            gpu.h_ext.y,
            gpu.h_ext.z,
            gpu.ms,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.scalar_reduce_workspace,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK external energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu.scalar_reduce_result,
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK external energy reduction", reason)) {
            return false;
        }
        if (!read_scalar_result(
                ctx,
                stream,
                "cudaMemcpyAsync GPU RK external energy device->host",
                external_energy,
                reason)) {
            return false;
        }
    }

    auto compute_dmi_energy = [&](bool bulk_mode, double &out_energy) -> bool {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.n_elements) ||
            gpu.nodes_xyz == nullptr || gpu.elements == nullptr ||
            gpu.magnetic_element_mask == nullptr ||
            gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.zhang_li_rhs.x == nullptr || gpu.zhang_li_rhs.y == nullptr ||
            gpu.zhang_li_rhs.z == nullptr) {
            reason = "GPU RK DMI energy requires device-resident mesh geometry, Ms, lumped mass, and residual buffers";
            return false;
        }
        FemGpuComponentField &field = bulk_mode ? gpu.h_bulk_dmi : gpu.h_dmi;
        fullmag_cuda_dmi_field_energy_serial(
            gpu.nodes_xyz,
            gpu.elements,
            gpu.magnetic_element_mask,
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
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
            ctx.material.saturation_magnetisation,
            bulk_mode ? ctx.bulk_dmi_D : ctx.dmi_D,
            ctx.dmi_n_hat[0],
            ctx.dmi_n_hat[1],
            ctx.dmi_n_hat[2],
            bulk_mode ? !ctx.Dbulk_field.empty() : !ctx.Dind_field.empty(),
            bulk_mode,
            static_cast<int>(ctx.n_elements),
            n,
            stream);
        if (!cuda_launch_ok(bulk_mode ? "launch GPU RK bulk DMI energy blocks" : "launch GPU RK interfacial DMI energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            1,
            gpu.scalar_reduce_result,
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok(bulk_mode ? "launch GPU RK bulk DMI energy reduction" : "launch GPU RK interfacial DMI energy reduction", reason)) {
            return false;
        }
        if (!read_scalar_result(
                ctx,
                stream,
                bulk_mode
                    ? "cudaMemcpyAsync GPU RK bulk DMI energy device->host"
                    : "cudaMemcpyAsync GPU RK interfacial DMI energy device->host",
                out_energy,
                reason)) {
            return false;
        }
        return true;
    };
    double dmi_energy = 0.0;
    if (ctx.enable_dmi && !compute_dmi_energy(false, dmi_energy)) {
        return false;
    }
    double bulk_dmi_energy = 0.0;
    if (ctx.enable_bulk_dmi && !compute_dmi_energy(true, bulk_dmi_energy)) {
        return false;
    }

    double anisotropy_energy = 0.0;
    if (ctx.enable_anisotropy) {
        if (gpu.ms == nullptr || gpu.ku == nullptr || gpu.ku2 == nullptr ||
            gpu.exchange_lumped_mass == nullptr ||
            gpu.h_ani.x == nullptr || gpu.h_ani.y == nullptr || gpu.h_ani.z == nullptr) {
            reason = "GPU RK uniaxial anisotropy energy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers";
            return false;
        }
        fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.ku,
            gpu.ku2,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_ani.x,
            gpu.h_ani.y,
            gpu.h_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy_Ku,
            ctx.anisotropy_Ku2,
            ctx.anisotropy_axis[0],
            ctx.anisotropy_axis[1],
            ctx.anisotropy_axis[2],
            !ctx.Ku_field.empty(),
            !ctx.Ku2_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu.scalar_reduce_result,
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy energy reduction", reason)) {
            return false;
        }
        if (!read_scalar_result(
                ctx,
                stream,
                "cudaMemcpyAsync GPU RK uniaxial anisotropy energy device->host",
                anisotropy_energy,
                reason)) {
            return false;
        }
    }

    double cubic_anisotropy_energy = 0.0;
    if (ctx.enable_cubic_anisotropy) {
        if (gpu.ms == nullptr || gpu.kc1 == nullptr || gpu.kc2 == nullptr ||
            gpu.kc3 == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_cubic_ani.x == nullptr || gpu.h_cubic_ani.y == nullptr ||
            gpu.h_cubic_ani.z == nullptr) {
            reason = "GPU RK cubic anisotropy energy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers";
            return false;
        }
        fullmag_cuda_cubic_anisotropy_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
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
            ctx.cubic_Kc1,
            ctx.cubic_Kc2,
            ctx.cubic_Kc3,
            ctx.cubic_axis1[0],
            ctx.cubic_axis1[1],
            ctx.cubic_axis1[2],
            ctx.cubic_axis2[0],
            ctx.cubic_axis2[1],
            ctx.cubic_axis2[2],
            !ctx.Kc1_field.empty(),
            !ctx.Kc2_field.empty(),
            !ctx.Kc3_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu.scalar_reduce_result,
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy energy reduction", reason)) {
            return false;
        }
        if (!read_scalar_result(
                ctx,
                stream,
                "cudaMemcpyAsync GPU RK cubic anisotropy energy device->host",
                cubic_anisotropy_energy,
                reason)) {
            return false;
        }
    }

    double magnetoelastic_energy = 0.0;
    if (ctx.enable_magnetoelastic) {
        const uint64_t per_node_strain_len = static_cast<uint64_t>(ctx.n_nodes) * 6ull;
        const bool use_per_node_strain = !ctx.mel_uniform_strain;
        if (!use_per_node_strain && ctx.mel_strain_voigt.size() < 6u) {
            reason = "GPU RK magnetoelastic energy requires prescribed strain data";
            return false;
        }
        if (use_per_node_strain &&
            static_cast<uint64_t>(ctx.mel_strain_voigt.size()) != per_node_strain_len) {
            reason = "GPU RK magnetoelastic energy requires 6 prescribed strain Voigt values per node";
            return false;
        }
        if (use_per_node_strain &&
            (gpu.mel_strain_voigt == nullptr || !gpu.mel_strain_uploaded ||
                gpu.mel_strain_voigt_len != per_node_strain_len)) {
            reason = "GPU RK magnetoelastic energy requires device-resident per-node strain";
            return false;
        }
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_mel.x == nullptr || gpu.h_mel.y == nullptr || gpu.h_mel.z == nullptr) {
            reason = "GPU RK magnetoelastic energy requires device-resident Ms, lumped mass, and H_mel buffers";
            return false;
        }
        const double *eps = ctx.mel_strain_voigt.data();
        fullmag_cuda_magnetoelastic_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            use_per_node_strain ? gpu.mel_strain_voigt : nullptr,
            gpu.h_mel.x,
            gpu.h_mel.y,
            gpu.h_mel.z,
            gpu.scalar_reduce_workspace,
            ctx.mel_b1,
            ctx.mel_b2,
            eps[0],
            eps[1],
            eps[2],
            eps[3] * 0.5,
            eps[4] * 0.5,
            eps[5] * 0.5,
            use_per_node_strain,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu.scalar_reduce_result,
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic energy reduction", reason)) {
            return false;
        }
        if (!read_scalar_result(
                ctx,
                stream,
                "cudaMemcpyAsync GPU RK magnetoelastic energy device->host",
                magnetoelastic_energy,
                reason)) {
            return false;
        }
    }

    fullmag_cuda_field_metric_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.h_eff.x,
        gpu.h_eff.y,
        gpu.h_eff.z,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        gpu.error.x,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK field metric blocks", reason)) {
        return false;
    }

    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK max H_eff reduction", reason)) {
        return false;
    }
    double max_h_eff = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK max H_eff device->host",
            max_h_eff,
            reason)) {
        return false;
    }

    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.error.x,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK max torque reduction", reason)) {
        return false;
    }
    double max_torque = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK max torque device->host",
            max_torque,
            reason)) {
        return false;
    }

    fullmag_cuda_magnetization_sum_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        gpu.error.x,
        gpu.error.y,
        gpu.error.z,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetization average blocks", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK mx average reduction", reason)) {
        return false;
    }
    double mx_sum = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK mx average device->host",
            mx_sum,
            reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.x,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK my average reduction", reason)) {
        return false;
    }
    double my_sum = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK my average device->host",
            my_sum,
            reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.y,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK mz average reduction", reason)) {
        return false;
    }
    double mz_sum = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK mz average device->host",
            mz_sum,
            reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.z,
        blocks,
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetic count reduction", reason)) {
        return false;
    }
    double magnetic_count = 0.0;
    if (!read_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK magnetic count device->host",
            magnetic_count,
            reason)) {
        return false;
    }

    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = 0.0;
    stats.external_energy_joules = external_energy;
    stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy;
    stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy;
    stats.magnetoelastic_energy_joules = magnetoelastic_energy;
    stats.total_energy_joules =
        exchange_energy + external_energy + anisotropy_energy + cubic_anisotropy_energy +
        dmi_energy + bulk_dmi_energy + magnetoelastic_energy;
    stats.max_effective_field_amplitude = max_h_eff;
    stats.max_demag_field_amplitude = 0.0;
    stats.max_torque_Apm = max_torque;
    if (magnetic_count > 0.0) {
        stats.mx = mx_sum / magnetic_count;
        stats.my = my_sum / magnetic_count;
        stats.mz = mz_sum / magnetic_count;
    } else {
        stats.mx = 0.0;
        stats.my = 0.0;
        stats.mz = 0.0;
    }
    stats.demag_solve_count = 0;
    stats.demag_linear_iterations = 0;
    stats.demag_linear_residual = 0.0;
    stats.requested_omp_threads = ctx.requested_omp_threads;
    stats.effective_omp_threads = ctx.effective_omp_threads;
    context_update_stage_completion_from_stats(ctx, stats);
    return true;
}

} // namespace fullmag::fem
