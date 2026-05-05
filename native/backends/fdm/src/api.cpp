/*
 * api.cpp — Public C ABI implementation for the FDM backend.
 *
 * This file dispatches to the internal Context and kernel implementations.
 * It is the sole file that exposes symbols matching fullmag_fdm.h.
 */

#include "fullmag_fdm.h"
#include "context.hpp"

#include <cstdlib>
#include <cstring>
#include <new>
#include <optional>
#include <algorithm>

using namespace fullmag::fdm;

// Forward declarations from .cu files — must be in correct namespace
namespace fullmag { namespace fdm {
extern void launch_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_dp45_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_dp45_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_abm3_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_abm3_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk4_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk4_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk23_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk23_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern double launch_exchange_energy_fp64(Context &ctx);
extern double launch_exchange_energy_fp32(Context &ctx);
extern double launch_demag_energy_fp64(Context &ctx);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp64(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp64(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp32(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp64(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp32(Context &ctx);
extern double reduce_dmi_energy_fp64(Context &ctx);
extern double reduce_dmi_energy_fp32(Context &ctx);
extern double reduce_max_norm_fp64(
    Context &ctx,
    const void *vx,
    const void *vy,
    const void *vz,
    uint64_t n);
extern double reduce_max_norm_fp32(
    Context &ctx,
    const void *vx,
    const void *vy,
    const void *vz,
    uint64_t n);
extern double reduce_max_cross_norm_fp64(
    Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz,
    uint64_t n);
extern double reduce_max_cross_norm_fp32(
    Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz,
    uint64_t n);
extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
} }

namespace {

std::optional<int> selected_cuda_device_from_env() {
    const char *specific = std::getenv("FULLMAG_FDM_GPU_INDEX");
    const char *generic = std::getenv("FULLMAG_CUDA_DEVICE_INDEX");
    const char *raw = specific != nullptr ? specific : generic;
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0) {
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

bool select_cuda_device_if_requested(Context &ctx) {
    auto selected = selected_cuda_device_from_env();
    if (!selected.has_value()) {
        return true;
    }
    cudaError_t err = cudaSetDevice(*selected);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaSetDevice", err);
        return false;
    }
    return true;
}

bool fill_current_stats(Context &ctx, fullmag_fdm_step_stats *out_stats) {
    if (!context_refresh_observables(ctx)) {
        return false;
    }

    std::memset(out_stats, 0, sizeof(*out_stats));
    out_stats->step = ctx.step_count;
    out_stats->time_seconds = ctx.current_time;

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        out_stats->exchange_energy_joules =
            ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
        out_stats->demag_energy_joules =
            ctx.enable_demag ? launch_demag_energy_fp64(ctx) : 0.0;
        out_stats->external_energy_joules = launch_external_energy_fp64(ctx);
        out_stats->anisotropy_energy_joules = reduce_uniaxial_anisotropy_energy_fp64(ctx);
        out_stats->cubic_energy_joules = reduce_cubic_anisotropy_energy_fp64(ctx);
        out_stats->dmi_energy_joules = reduce_dmi_energy_fp64(ctx);
        out_stats->max_effective_field_amplitude =
            reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
        out_stats->max_demag_field_amplitude = ctx.enable_demag
            ? reduce_max_norm_fp64(
                ctx,
                ctx.h_demag.x,
                ctx.h_demag.y,
                ctx.h_demag.z,
                ctx.cell_count)
            : 0.0;
        out_stats->max_torque_Apm = reduce_max_cross_norm_fp64(
            ctx,
            ctx.m.x, ctx.m.y, ctx.m.z,
            ctx.work.x, ctx.work.y, ctx.work.z,
            ctx.cell_count);
    } else {
        out_stats->exchange_energy_joules =
            ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
        out_stats->demag_energy_joules =
            ctx.enable_demag ? launch_demag_energy_fp32(ctx) : 0.0;
        out_stats->external_energy_joules = launch_external_energy_fp32(ctx);
        out_stats->anisotropy_energy_joules = reduce_uniaxial_anisotropy_energy_fp32(ctx);
        out_stats->cubic_energy_joules = reduce_cubic_anisotropy_energy_fp32(ctx);
        out_stats->dmi_energy_joules = reduce_dmi_energy_fp32(ctx);
        out_stats->max_effective_field_amplitude =
            reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
        out_stats->max_demag_field_amplitude = ctx.enable_demag
            ? reduce_max_norm_fp32(
                ctx,
                ctx.h_demag.x,
                ctx.h_demag.y,
                ctx.h_demag.z,
                ctx.cell_count)
            : 0.0;
        out_stats->max_torque_Apm = reduce_max_cross_norm_fp32(
            ctx,
            ctx.m.x, ctx.m.y, ctx.m.z,
            ctx.work.x, ctx.work.y, ctx.work.z,
            ctx.cell_count);
    }

    out_stats->total_energy_joules =
        out_stats->exchange_energy_joules +
        out_stats->demag_energy_joules +
        out_stats->external_energy_joules +
        out_stats->anisotropy_energy_joules +
        out_stats->cubic_energy_joules +
        out_stats->dmi_energy_joules;
    return true;
}

} // namespace

/* ── Availability ── */

int fullmag_fdm_is_available(void) {
#if FULLMAG_HAS_CUDA
    int device_count = 0;
    cudaError_t err = cudaGetDeviceCount(&device_count);
    if (err != cudaSuccess || device_count <= 0) {
        return 0;
    }
    auto selected = selected_cuda_device_from_env();
    if (selected.has_value() && *selected >= device_count) {
        return 0;
    }
    return 1;
#else
    return 0;
#endif
}

/* ── Create ── */

fullmag_fdm_backend *fullmag_fdm_backend_create(
    const fullmag_fdm_plan_desc *plan)
{
#if FULLMAG_HAS_CUDA
    if (!plan) return nullptr;

    auto *ctx = new (std::nothrow) Context();
    if (!ctx) return nullptr;
    if (!select_cuda_device_if_requested(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Copy grid
    ctx->nx = plan->grid.nx;
    ctx->ny = plan->grid.ny;
    ctx->nz = plan->grid.nz;
    ctx->cell_count = static_cast<uint64_t>(ctx->nx) * ctx->ny * ctx->nz;
    ctx->dx = plan->grid.dx;
    ctx->dy = plan->grid.dy;
    ctx->dz = plan->grid.dz;

    // Copy material
    ctx->Ms    = plan->material.saturation_magnetisation;
    ctx->A     = plan->material.exchange_stiffness;
    ctx->alpha = plan->material.damping;
    ctx->gamma = plan->material.gyromagnetic_ratio;

    // Execution config
    ctx->precision  = plan->precision;
    ctx->integrator = plan->integrator;
    ctx->disable_precession = plan->disable_precession != 0;
    ctx->enable_exchange = plan->enable_exchange != 0;
    ctx->enable_demag = plan->enable_demag != 0;
    ctx->has_external_field = plan->has_external_field != 0;
    ctx->has_active_mask = plan->active_mask != nullptr;
    ctx->has_region_mask = plan->region_mask != nullptr;
    ctx->has_exchange_lut = ctx->has_region_mask; // always build LUT when regions are present
    ctx->has_demag_tensor_kernel = plan->demag_kernel_spectrum_len != 0;
    ctx->external_field[0] = plan->external_field_am[0];
    ctx->external_field[1] = plan->external_field_am[1];
    ctx->external_field[2] = plan->external_field_am[2];
    ctx->active_cell_count = ctx->cell_count;

    // Uniaxial Anisotropy
    ctx->has_uniaxial_anisotropy = plan->has_uniaxial_anisotropy != 0;
    ctx->Ku1 = plan->uniaxial_anisotropy_constant;
    ctx->Ku2 = plan->uniaxial_anisotropy_k2;
    ctx->anisU[0] = plan->anisotropy_axis[0];
    ctx->anisU[1] = plan->anisotropy_axis[1];
    ctx->anisU[2] = plan->anisotropy_axis[2];

    // Cubic Anisotropy
    ctx->has_cubic_anisotropy = plan->has_cubic_anisotropy != 0;
    ctx->Kc1 = plan->cubic_Kc1;
    ctx->Kc2 = plan->cubic_Kc2;
    ctx->Kc3 = plan->cubic_Kc3;
    ctx->cubic_axis1[0] = plan->cubic_axis1[0];
    ctx->cubic_axis1[1] = plan->cubic_axis1[1];
    ctx->cubic_axis1[2] = plan->cubic_axis1[2];
    ctx->cubic_axis2[0] = plan->cubic_axis2[0];
    ctx->cubic_axis2[1] = plan->cubic_axis2[1];
    ctx->cubic_axis2[2] = plan->cubic_axis2[2];

    // DMI
    ctx->has_interfacial_dmi = plan->has_interfacial_dmi != 0;
    ctx->D_interfacial = plan->dmi_D_interfacial;
    ctx->has_bulk_dmi = plan->has_bulk_dmi != 0;
    ctx->D_bulk = plan->dmi_D_bulk;

    // Magnetoelastic coupling (prescribed strain)
    ctx->has_magnetoelastic = plan->has_magnetoelastic != 0;
    ctx->mel_b1 = plan->mel_b1;
    ctx->mel_b2 = plan->mel_b2;
    for (int i = 0; i < 6; ++i) {
        ctx->mel_strain[i] = plan->mel_strain[i];
    }

    // Thermal noise
    ctx->temperature = plan->temperature;

    // Zhang-Li STT
    ctx->has_zhang_li_stt = (plan->current_density_x != 0 || plan->current_density_y != 0 || plan->current_density_z != 0) 
                         && plan->stt_degree > 0;
    ctx->current_density_x = plan->current_density_x;
    ctx->current_density_y = plan->current_density_y;
    ctx->current_density_z = plan->current_density_z;
    ctx->stt_degree = plan->stt_degree;
    ctx->stt_beta = plan->stt_beta;
    if (ctx->has_zhang_li_stt && ctx->Ms > 0) {
        double mu_B = 9.274009994e-24; // Bohr magneton (J/T)
        double e = 1.60217662e-19;     // Elementary charge (C)
        double b = (ctx->stt_degree * mu_B) / (e * ctx->Ms * (1.0 + ctx->stt_beta * ctx->stt_beta));
        ctx->stt_u_pf = b;
    } else {
        ctx->stt_u_pf = 0.0;
    }

    // Slonczewski STT (CPP / SOT)
    double px = plan->stt_p_x;
    double py = plan->stt_p_y;
    double pz = plan->stt_p_z;
    double p_sq = px*px + py*py + pz*pz;
    
    ctx->has_slonczewski_stt = p_sq > 0.0 && plan->stt_lambda > 0.0 
                            && (plan->current_density_x != 0 || plan->current_density_y != 0 || plan->current_density_z != 0);
    ctx->stt_p_x = px;
    ctx->stt_p_y = py;
    ctx->stt_p_z = pz;
    ctx->stt_lambda = plan->stt_lambda;
    ctx->stt_epsilon_prime = plan->stt_epsilon_prime;
    
    if (ctx->has_slonczewski_stt && ctx->Ms > 0 && ctx->dz > 0) {
        double hbar = 1.054571817e-34; // Reduced Planck constant (J s)
        double e = 1.60217662e-19;     // Elementary charge (C)
        double mu_0 = 4.0 * M_PI * 1e-7; // Vacuum permeability
        double js = sqrt(ctx->current_density_x*ctx->current_density_x + 
                         ctx->current_density_y*ctx->current_density_y + 
                         ctx->current_density_z*ctx->current_density_z);
        // Standard prefactor: j * hbar / (2 * e * mu_0 * M_s * d)
        // Use explicit free layer thickness if provided, otherwise cell dz
        double d_free = plan->stt_free_layer_thickness > 0.0
                      ? plan->stt_free_layer_thickness : ctx->dz;
        ctx->stt_cpp_pf = (js * hbar) / (2.0 * e * mu_0 * ctx->Ms * d_free);
    } else {
        ctx->stt_cpp_pf = 0.0;
    }

    // ── Spin-Orbit Torque (SOT) ──
    ctx->has_sot       = plan->has_sot != 0;
    ctx->sot_je        = plan->sot_je;
    ctx->sot_xi_dl     = plan->sot_xi_dl;
    ctx->sot_xi_fl     = plan->sot_xi_fl;
    ctx->sot_sigma[0]  = plan->sot_sigma[0];
    ctx->sot_sigma[1]  = plan->sot_sigma[1];
    ctx->sot_sigma[2]  = plan->sot_sigma[2];
    ctx->sot_thickness = plan->sot_thickness > 0.0 ? plan->sot_thickness : 1.0e-9;

    // ── Oersted field (cylindrical conductor) ──
    ctx->has_oersted_cylinder = plan->has_oersted_cylinder != 0;
    ctx->oersted_current = plan->oersted_current;
    ctx->oersted_radius = plan->oersted_radius;
    for (int i = 0; i < 3; ++i) {
        ctx->oersted_center[i] = plan->oersted_center[i];
        ctx->oersted_axis[i] = plan->oersted_axis[i];
    }
    ctx->oersted_time_dep_kind = plan->oersted_time_dep_kind;
    ctx->oersted_time_dep_freq = plan->oersted_time_dep_freq;
    ctx->oersted_time_dep_phase = plan->oersted_time_dep_phase;
    ctx->oersted_time_dep_offset = plan->oersted_time_dep_offset;
    ctx->oersted_time_dep_t_on = plan->oersted_time_dep_t_on;
    ctx->oersted_time_dep_t_off = plan->oersted_time_dep_t_off;
    const bool has_oersted_field = plan->oersted_field_xyz != nullptr && plan->oersted_field_len != 0;
    ctx->has_oersted_field = ctx->has_oersted_cylinder || has_oersted_field;

    // Adaptive step config (DP45)
    ctx->adaptive_max_error = plan->adaptive_max_error > 0 ? plan->adaptive_max_error : 1e-5;
    ctx->adaptive_dt_min    = plan->adaptive_dt_min > 0    ? plan->adaptive_dt_min    : 1e-18;
    ctx->adaptive_dt_max    = plan->adaptive_dt_max > 0    ? plan->adaptive_dt_max    : 1e-10;
    ctx->adaptive_headroom  = plan->adaptive_headroom > 0  ? plan->adaptive_headroom  : 0.8;

    // Validate
    if (ctx->cell_count == 0) {
        ctx->last_error = "grid has zero cells";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    uint64_t expected_len = ctx->cell_count * 3;
    if (plan->initial_magnetization_len != expected_len) {
        ctx->last_error = "initial_magnetization_len mismatch: expected "
            + std::to_string(expected_len)
            + ", got " + std::to_string(plan->initial_magnetization_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_active_mask && plan->active_mask_len != ctx->cell_count) {
        ctx->last_error = "active_mask_len mismatch: expected "
            + std::to_string(ctx->cell_count)
            + ", got " + std::to_string(plan->active_mask_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_oersted_cylinder && has_oersted_field) {
        ctx->last_error =
            "oersted configuration is ambiguous: provide either OerstedCylinder or oersted_field_xyz, not both";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (has_oersted_field && plan->oersted_field_len != ctx->cell_count * 3u) {
        ctx->last_error = "oersted_field_len mismatch: expected "
            + std::to_string(ctx->cell_count * 3u)
            + ", got " + std::to_string(plan->oersted_field_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_region_mask && plan->region_mask_len != ctx->cell_count) {
        ctx->last_error = "region_mask_len mismatch: expected "
            + std::to_string(ctx->cell_count)
            + ", got " + std::to_string(plan->region_mask_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_active_mask) {
        ctx->active_mask_host.assign(plan->active_mask, plan->active_mask + plan->active_mask_len);
        ctx->active_cell_count = 0;
        for (uint8_t value : ctx->active_mask_host) {
            if (value != 0) {
                ctx->active_cell_count++;
            }
        }
    }
    if (ctx->has_region_mask) {
        ctx->region_mask_host.assign(plan->region_mask, plan->region_mask + plan->region_mask_len);
    }
    if (ctx->has_demag_tensor_kernel) {
        if (!plan->demag_kernel_xx_spectrum || !plan->demag_kernel_yy_spectrum
            || !plan->demag_kernel_zz_spectrum || !plan->demag_kernel_xy_spectrum
            || !plan->demag_kernel_xz_spectrum || !plan->demag_kernel_yz_spectrum)
        {
            ctx->last_error = "demag kernel spectra pointers must all be present when demag_kernel_spectrum_len is set";
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
        const bool has_explicit_fft_dims =
            plan->demag_fft_nx != 0 || plan->demag_fft_ny != 0 || plan->demag_fft_nz != 0;
        if (has_explicit_fft_dims) {
            if (plan->demag_fft_nx == 0 || plan->demag_fft_ny == 0 || plan->demag_fft_nz == 0) {
                ctx->last_error = "demag FFT dimensions must either all be zero or all be non-zero";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            uint64_t expected_fft_cell_count =
                static_cast<uint64_t>(plan->demag_fft_nx) * plan->demag_fft_ny * plan->demag_fft_nz;
            if (plan->demag_kernel_spectrum_len != expected_fft_cell_count * 2) {
                ctx->last_error = "demag_kernel_spectrum_len mismatch: expected "
                    + std::to_string(expected_fft_cell_count * 2)
                    + " for explicit FFT dimensions "
                    + std::to_string(plan->demag_fft_nx) + "x"
                    + std::to_string(plan->demag_fft_ny) + "x"
                    + std::to_string(plan->demag_fft_nz)
                    + ", got " + std::to_string(plan->demag_kernel_spectrum_len);
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            ctx->fft_nx = plan->demag_fft_nx;
            ctx->fft_ny = plan->demag_fft_ny;
            ctx->fft_nz = plan->demag_fft_nz;
            ctx->thin_film_2d_demag = ctx->fft_nz == 1;
        } else {
            uint64_t expected_fft_cell_count_3d =
                static_cast<uint64_t>(ctx->nx * 2) * (ctx->ny * 2) * (ctx->nz * 2);
            uint64_t expected_fft_cell_count_2d =
                static_cast<uint64_t>(ctx->nx * 2) * (ctx->ny * 2);
            if (ctx->nz == 1 && plan->demag_kernel_spectrum_len == expected_fft_cell_count_2d * 2) {
                ctx->thin_film_2d_demag = true;
            } else if (plan->demag_kernel_spectrum_len == expected_fft_cell_count_3d * 2) {
                ctx->thin_film_2d_demag = false;
            } else {
                ctx->last_error = "demag_kernel_spectrum_len mismatch: expected "
                    + std::to_string(expected_fft_cell_count_3d * 2)
                    + " (3D)"
                    + (ctx->nz == 1
                        ? " or " + std::to_string(expected_fft_cell_count_2d * 2) + " (thin-film 2D)"
                        : std::string())
                    + ", got " + std::to_string(plan->demag_kernel_spectrum_len);
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
        }
    }

    // Allocate device buffers
    if (!context_alloc_device(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    if (ctx->has_active_mask &&
        !context_upload_active_mask(*ctx, plan->active_mask, plan->active_mask_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_region_mask &&
        !context_upload_region_mask(*ctx, plan->region_mask, plan->region_mask_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    // Build or upload inter-region exchange coupling LUT
    if (ctx->has_exchange_lut) {
        constexpr uint64_t N = FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
        std::vector<double> lut_host(N * N, 0.0);
        if (plan->exchange_lut != nullptr && plan->exchange_lut_len == N * N) {
            // Use caller-provided LUT
            std::memcpy(lut_host.data(), plan->exchange_lut, N * N * sizeof(double));
        } else {
            // Auto-build default LUT: A_ii = A, A_ij(i!=j) = 0
            for (uint64_t r = 0; r < N; ++r) {
                lut_host[r * N + r] = ctx->A;
            }
        }
        if (!context_upload_exchange_lut(*ctx, lut_host.data(), N * N)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }
    if (plan->demag_kernel_spectrum_len != 0 &&
        !context_upload_demag_kernel_spectra(
            *ctx,
            plan->demag_kernel_xx_spectrum,
            plan->demag_kernel_yy_spectrum,
            plan->demag_kernel_zz_spectrum,
            plan->demag_kernel_xy_spectrum,
            plan->demag_kernel_xz_spectrum,
            plan->demag_kernel_yz_spectrum,
            plan->demag_kernel_spectrum_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Upload boundary correction geometry data (T0/T1)
    if (plan->boundary_correction != FULLMAG_FDM_BOUNDARY_NONE
        && plan->volume_fraction != nullptr
        && plan->volume_fraction_len == ctx->cell_count)
    {
        uint8_t tier = static_cast<uint8_t>(plan->boundary_correction);
        double phi_floor = plan->boundary_phi_floor > 0.0
            ? plan->boundary_phi_floor : 0.05;
        double delta_min = plan->boundary_delta_min > 0.0
            ? plan->boundary_delta_min
            : 0.1 * std::min({ctx->dx, ctx->dy, ctx->dz});

        if (!context_upload_boundary_correction(
                *ctx, tier, phi_floor, delta_min,
                plan->volume_fraction,
                plan->face_link_xp, plan->face_link_xm,
                plan->face_link_yp, plan->face_link_ym,
                plan->face_link_zp, plan->face_link_zm,
                plan->delta_xp, plan->delta_xm,
                plan->delta_yp, plan->delta_ym,
                plan->delta_zp, plan->delta_zm,
                ctx->cell_count))
        {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }

        // Sparse demag boundary correction tensors
        if (plan->has_demag_boundary_corr
            && plan->demag_corr_target_idx != nullptr
            && plan->demag_corr_target_count > 0)
        {
            if (!context_upload_demag_boundary_corr(
                    *ctx,
                    plan->demag_corr_target_idx,
                    plan->demag_corr_source_idx,
                    plan->demag_corr_tensor,
                    plan->demag_corr_target_count,
                    plan->demag_corr_stencil_size))
            {
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
        }
    }

    // Periodic boundary conditions (per-axis exchange wrapping)
    ctx->periodic_x = plan->periodic_x != 0;
    ctx->periodic_y = plan->periodic_y != 0;
    ctx->periodic_z = plan->periodic_z != 0;

    if (ctx->has_uniaxial_anisotropy) {
        if (!context_upload_anisotropy_fields(*ctx, plan->ku1_field, plan->ku2_field, ctx->cell_count)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }

    if (ctx->has_cubic_anisotropy) {
        if (!context_upload_cubic_anisotropy_fields(*ctx, plan->kc1_field, plan->kc2_field, plan->kc3_field, ctx->cell_count)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }

    // Precompute Oersted static field for I = 1 A
    if (ctx->has_oersted_cylinder) {
        if (!context_precompute_oersted_field(*ctx)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    } else if (has_oersted_field) {
        if (!context_upload_oersted_field(*ctx, plan->oersted_field_xyz, plan->oersted_field_len)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }

    // Upload initial magnetization
    if (!context_upload_magnetization_f64(
            *ctx, plan->initial_magnetization_xyz,
            plan->initial_magnetization_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    if (!context_refresh_observables(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Query device info
    context_query_device_info(*ctx);

    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
#else
    (void)plan;
    return nullptr;
#endif
}

/* ── Step ── */

int fullmag_fdm_backend_step(
    fullmag_fdm_backend    *handle,
    double                  dt_seconds,
    fullmag_fdm_step_stats *out_stats)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_stats) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    ctx->step_interrupted = false;

    if (ctx->precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        switch (ctx->integrator) {
            case FULLMAG_FDM_INTEGRATOR_DP45:
                launch_dp45_step_fp64(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_ABM3:
                launch_abm3_step_fp64(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_RK4:
                launch_rk4_step_fp64(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_RK23:
                launch_rk23_step_fp64(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_HEUN:
            default:
                launch_heun_step_fp64(*ctx, dt_seconds, out_stats);
                break;
        }
    } else {
        // fp32: full integrator support
        switch (ctx->integrator) {
            case FULLMAG_FDM_INTEGRATOR_DP45:
                launch_dp45_step_fp32(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_ABM3:
                launch_abm3_step_fp32(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_RK4:
                launch_rk4_step_fp32(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_RK23:
                launch_rk23_step_fp32(*ctx, dt_seconds, out_stats);
                break;
            case FULLMAG_FDM_INTEGRATOR_HEUN:
            default:
                launch_heun_step_fp32(*ctx, dt_seconds, out_stats);
                break;
        }
    }

    if (ctx->step_interrupted) {
        if (!fill_current_stats(*ctx, out_stats)) {
            return FULLMAG_FDM_ERR_CUDA;
        }
        out_stats->dt_seconds = 0.0;
        return FULLMAG_FDM_ERR_INTERRUPTED;
    }

    // Check for CUDA errors
    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(*ctx, "integrator_step", err);
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)dt_seconds; (void)out_stats;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_set_interrupt_poll(
    fullmag_fdm_backend *handle,
    fullmag_fdm_interrupt_poll_fn poll_fn,
    void *user_data)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    ctx->interrupt_poll = poll_fn;
    ctx->interrupt_poll_user_data = user_data;
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)poll_fn; (void)user_data;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Copy field ── */

int fullmag_fdm_backend_copy_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (out_len != ctx->cell_count * 3) {
        ctx->last_error = "out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_f64(*ctx, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_field_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    float                 *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (out_len != ctx->cell_count * 3) {
        ctx->last_error = "out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_f32(*ctx, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_field_preview_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride,
    double                *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0
        || z_stride == 0)
    {
        return FULLMAG_FDM_ERR_INVALID;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);

    uint64_t expected_len =
        static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz * 3;
    if (out_len != expected_len) {
        ctx->last_error = "preview out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_preview_f64(
            *ctx,
            observable,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            out_xyz,
            out_len))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)observable;
    (void)preview_nx;
    (void)preview_ny;
    (void)preview_nz;
    (void)z_origin;
    (void)z_stride;
    (void)out_xyz;
    (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_field_preview_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride,
    float                 *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0
        || z_stride == 0)
    {
        return FULLMAG_FDM_ERR_INVALID;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);

    uint64_t expected_len =
        static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz * 3;
    if (out_len != expected_len) {
        ctx->last_error = "preview out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_preview_f32(
            *ctx,
            observable,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            out_xyz,
            out_len))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)observable;
    (void)preview_nx;
    (void)preview_ny;
    (void)preview_nz;
    (void)z_origin;
    (void)z_stride;
    (void)out_xyz;
    (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

fullmag_fdm_field_snapshot *fullmag_fdm_backend_begin_field_snapshot(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return nullptr;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return reinterpret_cast<fullmag_fdm_field_snapshot *>(
        context_begin_async_field_snapshot(*ctx, observable));
#else
    (void)handle;
    (void)observable;
    return nullptr;
#endif
}

fullmag_fdm_preview_snapshot *fullmag_fdm_backend_begin_preview_snapshot(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return nullptr;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return reinterpret_cast<fullmag_fdm_preview_snapshot *>(
        context_begin_async_preview_snapshot(
            *ctx,
            observable,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride));
#else
    (void)handle;
    (void)observable;
    (void)preview_nx;
    (void)preview_ny;
    (void)preview_nz;
    (void)z_origin;
    (void)z_stride;
    return nullptr;
#endif
}

int fullmag_fdm_field_snapshot_wait(
    fullmag_fdm_field_snapshot *snapshot,
    const void               **out_data,
    uint64_t                  *out_len_bytes,
    fullmag_fdm_snapshot_desc *out_desc)
{
#if FULLMAG_HAS_CUDA
    if (!snapshot || !out_data || !out_len_bytes || !out_desc) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::string error;
    const void *data = nullptr;
    uint64_t len_bytes = 0;
    fullmag_fdm_snapshot_desc desc{};
    if (!context_wait_async_field_snapshot(
            *reinterpret_cast<AsyncFieldSnapshot *>(snapshot),
            &data,
            len_bytes,
            desc,
            error))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }
    *out_data = data;
    *out_len_bytes = len_bytes;
    *out_desc = desc;
    return FULLMAG_FDM_OK;
#else
    (void)snapshot;
    (void)out_data;
    (void)out_len_bytes;
    (void)out_desc;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_preview_snapshot_wait(
    fullmag_fdm_preview_snapshot *snapshot,
    const void                 **out_data,
    uint64_t                    *out_len_bytes,
    fullmag_fdm_snapshot_desc   *out_desc)
{
#if FULLMAG_HAS_CUDA
    if (!snapshot || !out_data || !out_len_bytes || !out_desc) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::string error;
    const void *data = nullptr;
    uint64_t len_bytes = 0;
    fullmag_fdm_snapshot_desc desc{};
    if (!context_wait_async_preview_snapshot(
            *reinterpret_cast<AsyncPreviewSnapshot *>(snapshot),
            &data,
            len_bytes,
            desc,
            error))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }
    *out_data = data;
    *out_len_bytes = len_bytes;
    *out_desc = desc;
    return FULLMAG_FDM_OK;
#else
    (void)snapshot;
    (void)out_data;
    (void)out_len_bytes;
    (void)out_desc;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

void fullmag_fdm_field_snapshot_destroy(
    fullmag_fdm_field_snapshot *snapshot)
{
#if FULLMAG_HAS_CUDA
    context_destroy_async_field_snapshot(
        reinterpret_cast<AsyncFieldSnapshot *>(snapshot));
#else
    (void)snapshot;
#endif
}

void fullmag_fdm_preview_snapshot_destroy(
    fullmag_fdm_preview_snapshot *snapshot)
{
#if FULLMAG_HAS_CUDA
    context_destroy_async_preview_snapshot(
        reinterpret_cast<AsyncPreviewSnapshot *>(snapshot));
#else
    (void)snapshot;
#endif
}

int fullmag_fdm_backend_upload_magnetization_f64(
    fullmag_fdm_backend   *handle,
    const double          *m_xyz,
    uint64_t               len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !m_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (len != ctx->cell_count * 3) {
        ctx->last_error = "magnetization length mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_upload_magnetization_f64(*ctx, m_xyz, len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)m_xyz; (void)len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_upload_magnetization_f32(
    fullmag_fdm_backend   *handle,
    const float           *m_xyz,
    uint64_t               len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !m_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (len != ctx->cell_count * 3) {
        ctx->last_error = "magnetization length mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_upload_magnetization_f32(*ctx, m_xyz, len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)m_xyz; (void)len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_refresh_observables(
    fullmag_fdm_backend *handle)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!context_refresh_observables(*ctx)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_refresh_demag_observable(
    fullmag_fdm_backend *handle)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!context_refresh_demag_observable(*ctx)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_snapshot_stats(
    fullmag_fdm_backend *handle,
    fullmag_fdm_step_stats *out_stats)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_stats) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!fill_current_stats(*ctx, out_stats)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)out_stats;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Device info ── */

int fullmag_fdm_backend_get_device_info(
    fullmag_fdm_backend     *handle,
    fullmag_fdm_device_info *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!ctx->device_info_valid) {
        if (!context_query_device_info(*ctx)) {
            return FULLMAG_FDM_ERR_CUDA;
        }
    }

    *out_info = ctx->device_info_cache;
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Error ── */

const char *fullmag_fdm_backend_last_error(fullmag_fdm_backend *handle) {
    if (!handle) return "null handle";
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return ctx->last_error.empty() ? nullptr : ctx->last_error.c_str();
#else
    return "CUDA backend not compiled";
#endif
}

/* ── Destroy ── */

void fullmag_fdm_backend_destroy(fullmag_fdm_backend *handle) {
    if (!handle) return;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    context_free_device(*ctx);
    delete ctx;
#endif
}
