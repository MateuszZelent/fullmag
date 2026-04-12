/*
 * context.hpp — Internal FDM backend context.
 *
 * Wraps device state, material constants, and GPU resources.
 * NOT part of the public ABI.
 */

#ifndef FULLMAG_FDM_CONTEXT_HPP
#define FULLMAG_FDM_CONTEXT_HPP

#include "fullmag_fdm.h"

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

#ifdef FULLMAG_HAS_CUDA
#include <cuda_runtime.h>
#include <cufft.h>
#endif

namespace fullmag {
namespace fdm {

/// Per-component SoA device arrays for a 3D vector field.
struct DeviceVectorField {
    void *x = nullptr;
    void *y = nullptr;
    void *z = nullptr;
};

struct DeviceDemagKernel {
    void *xx = nullptr;
    void *yy = nullptr;
    void *zz = nullptr;
    void *xy = nullptr;
    void *xz = nullptr;
    void *yz = nullptr;
};

struct Context {
    // Grid
    uint32_t nx, ny, nz;
    uint64_t cell_count;
    double dx, dy, dz;

    // Material
    double Ms, A, alpha, gamma;
    bool enable_exchange = true;
    bool enable_demag = false;
    bool has_external_field = false;
    bool has_active_mask = false;
    bool has_region_mask = false;
    bool has_demag_tensor_kernel = false;
    bool thin_film_2d_demag = false;
    double external_field[3] = {0.0, 0.0, 0.0};
    uint64_t active_cell_count = 0;

    // Uniaxial Anisotropy
    bool has_uniaxial_anisotropy = false;
    double Ku1 = 0.0;
    double Ku2 = 0.0;
    double anisU[3] = {0.0, 0.0, 1.0};
    double *ku1_field = nullptr;
    double *ku2_field = nullptr;

    // Cubic Anisotropy
    bool has_cubic_anisotropy = false;
    double Kc1 = 0.0;
    double Kc2 = 0.0;
    double Kc3 = 0.0;
    double cubic_axis1[3] = {1.0, 0.0, 0.0};
    double cubic_axis2[3] = {0.0, 1.0, 0.0};
    double *kc1_field = nullptr;
    double *kc2_field = nullptr;
    double *kc3_field = nullptr;

    // DMI
    bool has_interfacial_dmi = false;
    double D_interfacial = 0.0;
    bool has_bulk_dmi = false;
    double D_bulk = 0.0;

    // Magnetoelastic coupling (prescribed strain, B1/B2 model)
    bool has_magnetoelastic = false;
    double mel_b1 = 0.0;          // B1 coupling constant [Pa]
    double mel_b2 = 0.0;          // B2 coupling constant [Pa]
    double mel_strain[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};  // Voigt: [e11,e22,e33,2e23,2e13,2e12]

    // Thermal noise
    double temperature = 0.0;  // Kelvin
    double thermal_sigma = 0.0;  // Precomputed noise amplitude (A/m)
    double current_dt = 1e-13;   // Current timestep for thermal sigma computation

    // Zhang-Li STT (CIP)
    bool has_zhang_li_stt = false;

    double current_density_x = 0.0;
    double current_density_y = 0.0;
    double current_density_z = 0.0;
    double stt_u_pf = 0.0;     // Precomputed coefficient: j * P * mu_B / (e * M_s * (1 + beta^2))
    double stt_degree = 0.0;   // P
    double stt_beta = 0.0;     // beta

    // Slonczewski STT (CPP / SOT)
    bool has_slonczewski_stt = false;
    double stt_p_x = 0.0;
    double stt_p_y = 0.0;
    double stt_p_z = 0.0;
    double stt_lambda = 0.0;
    double stt_epsilon_prime = 0.0;
    double stt_cpp_pf = 0.0;   // Precomputed coefficient: j * hbar / (2 * e * mu_0 * M_s * d)

    // Spin-Orbit Torque (SOT) — Manchon-Zhang DL + FL model
    bool   has_sot        = false;
    double sot_je         = 0.0;          // |Je| charge current density [A/m²]
    double sot_xi_dl      = 0.0;          // ξ_DL damping-like efficiency
    double sot_xi_fl      = 0.0;          // ξ_FL field-like efficiency
    double sot_sigma[3]   = {0.0, 0.0, 1.0}; // σ̂ spin polarisation vector (normalised on use)
    double sot_thickness  = 1.0e-9;       // t_F FM layer thickness [m]

    // Oersted field (cylindrical conductor)
    bool has_oersted_cylinder = false;
    double oersted_current = 0.0;        // DC current [A]
    double oersted_radius = 0.0;         // cylinder radius [m]
    double oersted_center[3] = {0,0,0};  // cross-section centre [m]
    double oersted_axis[3] = {0,0,1};    // current-flow axis (unit vector)
    // Time dependence envelope
    uint32_t oersted_time_dep_kind = 0;  // 0=constant, 1=sinusoidal, 2=pulse
    double oersted_time_dep_freq = 0.0;  // sinusoidal: frequency [Hz]
    double oersted_time_dep_phase = 0.0; // sinusoidal: phase [rad]
    double oersted_time_dep_offset = 0.0;// sinusoidal: offset
    double oersted_time_dep_t_on = 0.0;  // pulse: t_on [s]
    double oersted_time_dep_t_off = 0.0; // pulse: t_off [s]
    // Precomputed static Oersted field profile for I = 1 A (SoA layout)
    DeviceVectorField h_oe_static;       // H_oe(x,y,z) for I=1A

    // Execution
    fullmag_fdm_precision precision;
    fullmag_fdm_integrator integrator;
    bool disable_precession = false;


    // Step counter
    uint64_t step_count = 0;
    double current_time = 0.0;

    // Device state (SoA layout)
    DeviceVectorField m;      // magnetization
    DeviceVectorField h_ex;   // exchange field
    DeviceVectorField h_demag;// demag field
    DeviceVectorField k1;     // RHS stage 1 (all integrators)
    DeviceVectorField tmp;    // predictor state / scratch
    DeviceVectorField work;   // effective field / scratch

    // --- DP45-specific stage buffers ---
    DeviceVectorField k2, k3, k4, k5, k6;
    DeviceVectorField k_fsal; // FSAL: k7 from prev accepted step = k1 for next
    bool              fsal_valid = false;

    // Adaptive step config (DP45)
    double adaptive_max_error = 1e-5;
    double adaptive_dt_min    = 1e-18;
    double adaptive_dt_max    = 1e-10;
    double adaptive_headroom  = 0.8;

    // --- ABM3-specific history buffers ---
    DeviceVectorField abm_f_n;       // RHS at step n
    DeviceVectorField abm_f_n1;      // RHS at step n-1
    DeviceVectorField abm_f_n2;      // RHS at step n-2
    uint32_t          abm_startup = 0; // counts 0..3 Heun warmup steps
    double            abm_last_dt = 0.0;

    uint8_t *active_mask = nullptr;
    uint32_t *region_mask = nullptr;
    double *exchange_lut = nullptr;  // device-side, MAX_EXCHANGE_REGIONS × MAX_EXCHANGE_REGIONS
    bool has_exchange_lut = false;

    // Periodicity: per-axis PBC flags for exchange wrapping
    bool periodic_x = false;
    bool periodic_y = false;
    bool periodic_z = false;

    // Boundary correction (T0 / T1)
    uint8_t boundary_tier = 0;     // 0=none, 1=volume, 2=full
    double  phi_floor = 0.05;
    double  delta_min = 0.0;       // computed as 0.1*min(dx,dy,dz) if zero
    double *volume_fraction = nullptr;  // f64[cell_count]
    double *face_link_xp = nullptr;
    double *face_link_xm = nullptr;
    double *face_link_yp = nullptr;
    double *face_link_ym = nullptr;
    double *face_link_zp = nullptr;
    double *face_link_zm = nullptr;
    // T1 only: intersection distances
    double *delta_xp = nullptr;
    double *delta_xm = nullptr;
    double *delta_yp = nullptr;
    double *delta_ym = nullptr;
    double *delta_zp = nullptr;
    double *delta_zm = nullptr;
    // Sparse demag boundary correction
    bool     has_demag_boundary_corr = false;
    uint32_t demag_corr_target_count = 0;
    uint32_t demag_corr_stencil_size = 0;
    int32_t *demag_corr_target_idx = nullptr;
    int32_t *demag_corr_source_idx = nullptr;
    double  *demag_corr_tensor = nullptr;

    double *reduction_scratch = nullptr;
    uint64_t reduction_scratch_len = 0;
    void *preview_download_scratch = nullptr;
    uint64_t preview_download_scratch_len_bytes = 0;
    std::vector<uint8_t> active_mask_host;
    std::vector<uint32_t> region_mask_host;

    // Demag FFT resources
    uint32_t fft_nx = 0;
    uint32_t fft_ny = 0;
    uint32_t fft_nz = 0;
    uint64_t fft_cell_count = 0;
    void *fft_x = nullptr;
    void *fft_y = nullptr;
    void *fft_z = nullptr;
    DeviceDemagKernel demag_kernel;
    cufftHandle fft_plan = 0;
    bool fft_plan_valid = false;

    // Device info cache
    fullmag_fdm_device_info device_info_cache;
    bool device_info_valid = false;

    // Error state
    std::string last_error;

    // Cooperative interrupt hook for interactive control-plane.
    fullmag_fdm_interrupt_poll_fn interrupt_poll = nullptr;
    void *interrupt_poll_user_data = nullptr;
    bool step_interrupted = false;
};

struct AsyncFieldSnapshot {
    fullmag_fdm_precision precision = FULLMAG_FDM_PRECISION_DOUBLE;
    uint64_t cell_count = 0;
    DeviceVectorField staging;
    void *host_soa = nullptr;
    size_t host_soa_len_bytes = 0;
    void *stream = nullptr;      // cudaStream_t
    void *ready_event = nullptr; // cudaEvent_t
    void *done_event = nullptr;  // cudaEvent_t
    bool needs_wait = false;
};

struct AsyncPreviewSnapshot {
    fullmag_fdm_precision precision = FULLMAG_FDM_PRECISION_DOUBLE;
    uint64_t preview_count = 0;
    void *device_xyz = nullptr;
    void *host_xyz = nullptr;
    size_t host_xyz_len_bytes = 0;
    void *stream = nullptr;      // cudaStream_t
    void *ready_event = nullptr; // cudaEvent_t
    void *done_event = nullptr;  // cudaEvent_t
    bool needs_wait = false;
};

/// Plain-old-data copy of STT-related fields from Context.
/// Passed by value to CUDA kernels so they don't need host-side Context access.
struct SttParams {
    int     has_zhang_li_stt    = 0;
    double  current_density_x   = 0.0;
    double  current_density_y   = 0.0;
    double  current_density_z   = 0.0;
    double  stt_u_pf            = 0.0;
    double  stt_beta            = 0.0;
    double  stt_degree          = 0.0;
    int     nx = 1, ny = 1, nz = 1;
    double  dx = 1.0, dy = 1.0, dz = 1.0;

    int     has_slonczewski_stt = 0;
    double  stt_p_x             = 0.0;
    double  stt_p_y             = 0.0;
    double  stt_p_z             = 0.0;
    double  stt_lambda          = 1.0;
    double  stt_epsilon_prime   = 0.0;
    double  stt_cpp_pf          = 0.0;
};

/// Build an SttParams from a Context.
inline SttParams stt_params_from_ctx(const Context &ctx) {
    SttParams p;
    p.has_zhang_li_stt  = ctx.has_zhang_li_stt  ? 1 : 0;
    p.current_density_x = ctx.current_density_x;
    p.current_density_y = ctx.current_density_y;
    p.current_density_z = ctx.current_density_z;
    p.stt_u_pf          = ctx.stt_u_pf;
    p.stt_beta          = ctx.stt_beta;
    p.stt_degree        = ctx.stt_degree;
    p.nx = static_cast<int>(ctx.nx);
    p.ny = static_cast<int>(ctx.ny);
    p.nz = static_cast<int>(ctx.nz);
    p.dx = ctx.dx; p.dy = ctx.dy; p.dz = ctx.dz;
    p.has_slonczewski_stt = ctx.has_slonczewski_stt ? 1 : 0;
    p.stt_p_x             = ctx.stt_p_x;
    p.stt_p_y             = ctx.stt_p_y;
    p.stt_p_z             = ctx.stt_p_z;
    p.stt_lambda          = ctx.stt_lambda;
    p.stt_epsilon_prime   = ctx.stt_epsilon_prime;
    p.stt_cpp_pf          = ctx.stt_cpp_pf;
    return p;
}

/// Plain-old-data copy of SOT fields from Context.
/// Passed by value to CUDA kernels so they don't need host-side Context access.
struct SotParams {
    int    has_sot = 0;
    double xi_dl   = 0.0;  // ξ_DL damping-like efficiency
    double xi_fl   = 0.0;  // ξ_FL field-like efficiency
    double sx      = 0.0;  // σ̂_x (normalised)
    double sy      = 0.0;  // σ̂_y
    double sz      = 1.0;  // σ̂_z
    double amp     = 0.0;  // ℏ|Je|/(2e μ₀ Ms t_F)  [rad/s]
};

/// Build a SotParams from a Context.
inline SotParams sot_params_from_ctx(const Context &ctx) {
    SotParams p;
    if (!ctx.has_sot || ctx.Ms <= 0.0 || ctx.sot_thickness <= 0.0) return p;
    constexpr double HBAR = 1.054571817e-34;
    constexpr double E_CH = 1.60217662e-19;
    constexpr double MU0  = 1.2566370614359173e-6;
    p.has_sot = 1;
    p.xi_dl   = ctx.sot_xi_dl;
    p.xi_fl   = ctx.sot_xi_fl;
    double len = sqrt(ctx.sot_sigma[0]*ctx.sot_sigma[0] +
                      ctx.sot_sigma[1]*ctx.sot_sigma[1] +
                      ctx.sot_sigma[2]*ctx.sot_sigma[2]);
    double inv = (len > 1e-30) ? 1.0 / len : 0.0;
    p.sx = ctx.sot_sigma[0] * inv;
    p.sy = ctx.sot_sigma[1] * inv;
    p.sz = ctx.sot_sigma[2] * inv;
    p.amp = (fabs(ctx.sot_je) * HBAR) / (2.0 * E_CH * MU0 * ctx.Ms * ctx.sot_thickness);
    return p;
}

#ifdef FULLMAG_HAS_CUDA
inline bool poll_interrupt(Context &ctx) {
    if (ctx.interrupt_poll == nullptr) {
        return false;
    }
    if (ctx.interrupt_poll(ctx.interrupt_poll_user_data) == 0) {
        return false;
    }
    ctx.step_interrupted = true;
    return true;
}

inline void restore_m_from_tmp(Context &ctx) {
    const size_t bytes =
        static_cast<size_t>(ctx.cell_count) *
        (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE ? sizeof(double) : sizeof(float));
    cudaMemcpy(ctx.m.x, ctx.tmp.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.m.y, ctx.tmp.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.m.z, ctx.tmp.z, bytes, cudaMemcpyDeviceToDevice);
}

inline void abort_step_after_interrupt(Context &ctx, bool invalidate_fsal = true) {
    ctx.step_interrupted = true;
    if (invalidate_fsal) {
        ctx.fsal_valid = false;
    }
    restore_m_from_tmp(ctx);
}

inline bool abort_step_from_tmp(Context &ctx, bool invalidate_fsal = true) {
    if (!poll_interrupt(ctx)) {
        return false;
    }
    abort_step_after_interrupt(ctx, invalidate_fsal);
    return true;
}
#endif

#ifdef FULLMAG_HAS_CUDA

/// Allocate all device buffers.
bool context_alloc_device(Context &ctx);

/// Free all device buffers.
void context_free_device(Context &ctx);

/// Upload initial magnetization (AoS f64 host → SoA device).
bool context_upload_magnetization_f64(Context &ctx, const double *m_xyz, uint64_t len);

/// Upload initial magnetization (AoS f32 host → SoA device).
bool context_upload_magnetization_f32(Context &ctx, const float *m_xyz, uint64_t len);

/// Upload active cell mask (host u8 -> device u8).
bool context_upload_active_mask(Context &ctx, const uint8_t *mask, uint64_t len);

/// Upload region ids (host u32 -> device u32).
bool context_upload_region_mask(Context &ctx, const uint32_t *mask, uint64_t len);

/// Upload inter-region exchange coupling LUT (host f64, MAX_EXCHANGE_REGIONS^2 entries).
bool context_upload_exchange_lut(Context &ctx, const double *lut, uint64_t len);

/// Upload precomputed Newell tensor spectra (host f64 interleaved complex -> device complex).
bool context_upload_demag_kernel_spectra(
    Context &ctx,
    const double *kxx,
    const double *kyy,
    const double *kzz,
    const double *kxy,
    const double *kxz,
    const double *kyz,
    uint64_t len);

/// Upload boundary correction geometry data (T0/T1).
bool context_upload_boundary_correction(
    Context &ctx,
    uint8_t tier,
    double phi_floor,
    double delta_min,
    const double *volume_fraction,
    const double *face_link_xp, const double *face_link_xm,
    const double *face_link_yp, const double *face_link_ym,
    const double *face_link_zp, const double *face_link_zm,
    const double *delta_xp, const double *delta_xm,
    const double *delta_yp, const double *delta_ym,
    const double *delta_zp, const double *delta_zm,
    uint64_t cell_count);

/// Upload spatially varying uniaxial anisotropy constants (host f64 -> device f64).
bool context_upload_anisotropy_fields(
    Context &ctx,
    const double *ku1,
    const double *ku2,
    uint64_t len);

/// Upload spatially varying cubic anisotropy constants (host f64 -> device f64).
bool context_upload_cubic_anisotropy_fields(
    Context &ctx,
    const double *kc1,
    const double *kc2,
    const double *kc3,
    uint64_t len);

/// Precompute static Oersted field profile for I = 1 A (host → device).
/// Must be called after context_alloc_device when has_oersted_cylinder is set.
bool context_precompute_oersted_field(Context &ctx);

/// Upload sparse demag boundary correction tensors.
bool context_upload_demag_boundary_corr(
    Context &ctx,
    const int32_t *target_idx,
    const int32_t *source_idx,
    const double *tensor,
    uint32_t target_count,
    uint32_t stencil_size);

/// Download a field observable from device to host as f64 AoS.
bool context_download_field_f64(
    const Context &ctx,
    fullmag_fdm_observable observable,
    double *out_xyz,
    uint64_t out_len);

/// Download a field observable from device to host as f32 AoS.
bool context_download_field_f32(
    const Context &ctx,
    fullmag_fdm_observable observable,
    float *out_xyz,
    uint64_t out_len);

/// Download a downsampled preview of a field observable from device to host.
bool context_download_field_preview_f64(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    double *out_xyz,
    uint64_t out_len);

/// Download a downsampled preview of a field observable from device to host as f32.
bool context_download_field_preview_f32(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    float *out_xyz,
    uint64_t out_len);

/// Populate device info cache.
bool context_query_device_info(Context &ctx);

/// Populate H_ex / H_demag / H_eff for the current state without advancing time.
bool context_refresh_observables(Context &ctx);

/// Populate only H_demag for the current state without advancing time.
bool context_refresh_demag_observable(Context &ctx);

/// Begin an asynchronous field snapshot with private staging + pinned host storage.
AsyncFieldSnapshot *context_begin_async_field_snapshot(
    Context &ctx,
    fullmag_fdm_observable observable);

/// Wait for an asynchronous field snapshot to complete and expose the pinned payload.
bool context_wait_async_field_snapshot(
    AsyncFieldSnapshot &snapshot,
    const void **out_data,
    uint64_t &out_len_bytes,
    fullmag_fdm_snapshot_desc &out_desc,
    std::string &error);

/// Destroy an asynchronous field snapshot and free all owned resources.
void context_destroy_async_field_snapshot(AsyncFieldSnapshot *snapshot);

/// Begin an asynchronous downsampled preview snapshot.
AsyncPreviewSnapshot *context_begin_async_preview_snapshot(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride);

/// Wait for an asynchronous preview snapshot to complete and expose the payload.
bool context_wait_async_preview_snapshot(
    AsyncPreviewSnapshot &snapshot,
    const void **out_data,
    uint64_t &out_len_bytes,
    fullmag_fdm_snapshot_desc &out_desc,
    std::string &error);

/// Destroy an asynchronous preview snapshot and free all owned resources.
void context_destroy_async_preview_snapshot(AsyncPreviewSnapshot *snapshot);

#endif // FULLMAG_HAS_CUDA

} // namespace fdm
} // namespace fullmag

#endif // FULLMAG_FDM_CONTEXT_HPP
