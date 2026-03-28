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

#endif // FULLMAG_HAS_CUDA

} // namespace fdm
} // namespace fullmag

#endif // FULLMAG_FDM_CONTEXT_HPP
