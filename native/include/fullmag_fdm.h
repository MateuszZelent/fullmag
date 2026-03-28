/*
 * fullmag_fdm.h — Concrete C ABI for the Fullmag FDM backend.
 *
 * This header defines the stable interface between the Rust runner and the
 * native CUDA/FDM implementation. It is intentionally non-generic: it speaks
 * FDM grid semantics, not abstract backend patterns.
 *
 * The Rust runner owns:
 *   - output scheduling,
 *   - artifact writing,
 *   - provenance serialization.
 *
 * The native backend owns:
 *   - one-step execution,
 *   - field access,
 *   - per-step diagnostics,
 *   - device metadata.
 *
 * ABI stability rules:
 *   - The ABI exposes explicit f32 and f64 transfer entrypoints.
 *   - Callers that care about avoiding host-side casts should pick the entrypoint
 *     matching the requested execution precision.
 *   - Error codes map cleanly to Rust RunError.
 */

#ifndef FULLMAG_FDM_H
#define FULLMAG_FDM_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Return codes ── */

#define FULLMAG_FDM_OK            0
#define FULLMAG_FDM_ERR_INVALID  -1
#define FULLMAG_FDM_ERR_CUDA     -2
#define FULLMAG_FDM_ERR_INTERNAL -3

/* Maximum number of distinct exchange regions supported by the LUT. */
#define FULLMAG_FDM_MAX_EXCHANGE_REGIONS 256

/* ── Enums ── */

typedef enum {
    FULLMAG_FDM_PRECISION_SINGLE = 1,
    FULLMAG_FDM_PRECISION_DOUBLE = 2,
} fullmag_fdm_precision;

typedef enum {
    FULLMAG_FDM_INTEGRATOR_HEUN = 1,
    FULLMAG_FDM_INTEGRATOR_DP45 = 2,
    FULLMAG_FDM_INTEGRATOR_ABM3 = 3,
    FULLMAG_FDM_INTEGRATOR_RK4  = 4,
    FULLMAG_FDM_INTEGRATOR_RK23 = 5,
} fullmag_fdm_integrator;

typedef enum {
    FULLMAG_FDM_OBSERVABLE_M        = 1,
    FULLMAG_FDM_OBSERVABLE_H_EX     = 2,
    FULLMAG_FDM_OBSERVABLE_H_DEMAG  = 3,
    FULLMAG_FDM_OBSERVABLE_H_EXT    = 4,
    FULLMAG_FDM_OBSERVABLE_H_EFF    = 5,
} fullmag_fdm_observable;

typedef enum {
    FULLMAG_FDM_SNAPSHOT_SCALAR_F32 = 1,
    FULLMAG_FDM_SNAPSHOT_SCALAR_F64 = 2,
} fullmag_fdm_snapshot_scalar_type;

typedef enum {
    FULLMAG_FDM_BOUNDARY_NONE   = 0,  /* binary active_mask (current) */
    FULLMAG_FDM_BOUNDARY_VOLUME = 1,  /* T0: face-link + φ weighting */
    FULLMAG_FDM_BOUNDARY_FULL   = 2,  /* T1: ECB stencil + H_corr    */
} fullmag_fdm_boundary_correction;

/* ── Plan descriptor ── */

typedef struct {
    uint32_t nx;
    uint32_t ny;
    uint32_t nz;
    double   dx;
    double   dy;
    double   dz;
} fullmag_fdm_grid_desc;

typedef struct {
    double saturation_magnetisation;   /* A/m */
    double exchange_stiffness;         /* J/m */
    double damping;                    /* dimensionless */
    double gyromagnetic_ratio;         /* m/(A·s), Gilbert form */
} fullmag_fdm_material_desc;

typedef struct {
    fullmag_fdm_grid_desc      grid;
    fullmag_fdm_material_desc  material;
    fullmag_fdm_precision      precision;
    fullmag_fdm_integrator     integrator;
    int                        disable_precession; /* 1 = pure-damping relax RHS */
    int                        enable_exchange;
    int                        enable_demag;
    int                        has_external_field;
    double                     external_field_am[3]; /* H_ext in A/m */

    /*
     * Optional precomputed Newell tensor spectra, interleaved as
     * [re0, im0, re1, im1, ...] in host-side f64 for each component.
     * If absent, the backend falls back to the legacy spectral projection path.
     */
    const double              *demag_kernel_xx_spectrum;
    const double              *demag_kernel_yy_spectrum;
    const double              *demag_kernel_zz_spectrum;
    const double              *demag_kernel_xy_spectrum;
    const double              *demag_kernel_xz_spectrum;
    const double              *demag_kernel_yz_spectrum;
    uint64_t                   demag_kernel_spectrum_len; /* = 2 * fft_cell_count */

    /* Optional active geometry mask: 1 = active cell, 0 = inactive cell. */
    const uint8_t             *active_mask;
    uint64_t                   active_mask_len; /* = cell_count when present */

    /*
     * Optional region/body ids for exchange barriers.
     * Neighboring active cells with different non-zero region ids are treated
     * according to the exchange LUT (see below).  When no LUT is provided,
     * cross-region exchange coupling defaults to zero (free surface).
     * Length must equal cell_count when present.
     */
    const uint32_t            *region_mask;
    uint64_t                   region_mask_len;

    /*
     * Optional inter-region exchange coupling Look-Up Table (LUT).
     * Flat row-major array of FULLMAG_FDM_MAX_EXCHANGE_REGIONS^2 doubles:
     *   exchange_lut[ri * FULLMAG_FDM_MAX_EXCHANGE_REGIONS + rj] = A_ij [J/m]
     *
     * When present, the exchange kernel uses A_ij instead of material.exchange_stiffness
     * for every cell pair whose regions are ri and rj.  This enables:
     *   - Proper inter-region coupling with a per-pair A_ij (mumax parity)
     *   - Free surface semantics by setting A_ij = 0
     *
     * When NULL and region_mask is present, the backend auto-builds a default
     * LUT with A_ii = material.exchange_stiffness and A_ij(i!=j) = 0.
     */
    const double              *exchange_lut;
    uint64_t                   exchange_lut_len; /* must be MAX_EXCHANGE_REGIONS^2 when present */

    /*
     * Boundary correction tier:
     *   NONE   (0) = binary active_mask, current behavior
     *   VOLUME (1) = T0: face-link-weighted exchange + φ-weighted demag
     *   FULL   (2) = T1: ECB stencil (intersection distances) + sparse H_corr
     */
    fullmag_fdm_boundary_correction boundary_correction;
    double                     boundary_phi_floor;  /* 0 → use default 0.05 */
    double                     boundary_delta_min;   /* 0 → use default 0.1*min(dx,dy,dz) */

    /* T0+T1: per-cell volume fraction φ ∈ [0,1], f64[cell_count] */
    const double              *volume_fraction;
    uint64_t                   volume_fraction_len;

    /* T0+T1: per-cell face link fractions f64[cell_count] each */
    const double              *face_link_xp;
    const double              *face_link_xm;
    const double              *face_link_yp;
    const double              *face_link_ym;
    const double              *face_link_zp;
    const double              *face_link_zm;

    /* T1 only: intersection distances δ (center-to-boundary along axis), f64[cell_count] each */
    const double              *delta_xp;
    const double              *delta_xm;
    const double              *delta_yp;
    const double              *delta_ym;
    const double              *delta_zp;
    const double              *delta_zm;

    /* Sparse demag boundary correction (precomputed correction tensors) */
    int                        has_demag_boundary_corr;
    const int32_t             *demag_corr_target_idx; /* int32[target_count] */
    const int32_t             *demag_corr_source_idx; /* int32[target_count × stencil_size] */
    const double              *demag_corr_tensor;     /* f64[target_count × stencil_size × 6] */
    uint32_t                   demag_corr_target_count;
    uint32_t                   demag_corr_stencil_size;

    /* Initial m in AoS layout: [m0x, m0y, m0z, m1x, m1y, m1z, ...] */
    const double              *initial_magnetization_xyz;
    uint64_t                   initial_magnetization_len; /* = 3 * cell_count */

    /* Adaptive step configuration (DP45 and RK23) */
    double                     adaptive_max_error;   /* 0 → use default 1e-5 */
    double                     adaptive_dt_min;      /* 0 → use default 1e-18 */
    double                     adaptive_dt_max;      /* 0 → use default 1e-10 */
    double                     adaptive_headroom;    /* 0 → use default 0.8 */
} fullmag_fdm_plan_desc;

/* ── Per-step diagnostics ── */

typedef struct {
    uint64_t step;
    double   time_seconds;
    double   dt_seconds;
    double   exchange_energy_joules;
    double   demag_energy_joules;
    double   external_energy_joules;
    double   total_energy_joules;
    double   max_effective_field_amplitude;  /* max |H_eff| */
    double   max_demag_field_amplitude;      /* max |H_demag| */
    double   max_rhs_amplitude;              /* max |dm/dt| */
    double   suggested_next_dt;               /* adaptive optimal dt for next call */
    uint64_t wall_time_ns;
} fullmag_fdm_step_stats;

/* ── Device info ── */

typedef struct {
    char name[128];
    int  compute_capability_major;
    int  compute_capability_minor;
    int  driver_version;
    int  runtime_version;
} fullmag_fdm_device_info;

typedef struct {
    uint64_t cell_count;
    uint32_t component_count; /* always 3 for vector fields */
    uint32_t scalar_bytes;    /* 4 for f32, 8 for f64 */
    fullmag_fdm_snapshot_scalar_type scalar_type;
} fullmag_fdm_snapshot_desc;

/* ── Opaque handle ── */

typedef struct fullmag_fdm_backend fullmag_fdm_backend;
typedef struct fullmag_fdm_field_snapshot fullmag_fdm_field_snapshot;

/* ── Functions ── */

/**
 * Check whether the CUDA FDM backend is compiled and a valid GPU is available.
 * Returns 1 if available, 0 otherwise.
 */
int fullmag_fdm_is_available(void);

/**
 * Create a backend handle from an executable plan.
 * Allocates device memory and uploads initial magnetization.
 * Returns NULL on failure; call fullmag_fdm_backend_last_error for details.
 */
fullmag_fdm_backend *fullmag_fdm_backend_create(
    const fullmag_fdm_plan_desc *plan);

/**
 * Execute one time step of length dt_seconds using the configured integrator.
 * For DP45: dt_seconds is the initial step size; adaptive stepping may adjust it.
 * On success, writes diagnostics to *out_stats and returns FULLMAG_FDM_OK.
 */
int fullmag_fdm_backend_step(
    fullmag_fdm_backend    *handle,
    double                  dt_seconds,
    fullmag_fdm_step_stats *out_stats);

/**
 * Copy a field observable from device to host as f64.
 * out_xyz must point to at least out_len doubles (= 3 * cell_count).
 */
int fullmag_fdm_backend_copy_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_xyz,
    uint64_t               out_len);

/**
 * Copy a field observable from device to host as f32.
 * out_xyz must point to at least out_len floats (= 3 * cell_count).
 */
int fullmag_fdm_backend_copy_field_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    float                 *out_xyz,
    uint64_t               out_len);

/**
 * Copy a downsampled preview of a field observable from device to host as f64.
 * The preview grid is defined by preview_nx * preview_ny * preview_nz bins.
 * For each preview bin the backend returns the arithmetic average of the source
 * cells that fall into that bin, matching the runner/UI preview semantics.
 */
int fullmag_fdm_backend_copy_field_preview_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride,
    double                *out_xyz,
    uint64_t               out_len);

/**
 * Copy a downsampled preview of a field observable from device to host as f32.
 * The preview grid is defined by preview_nx * preview_ny * preview_nz bins.
 */
int fullmag_fdm_backend_copy_field_preview_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride,
    float                 *out_xyz,
    uint64_t               out_len);

/**
 * Begin an asynchronous binary field snapshot.
 *
 * The snapshot owns its own device staging buffers and pinned host buffer.
 * The payload layout exposed by `fullmag_fdm_field_snapshot_wait` is
 * component-major SoA:
 *   [x0..xN-1, y0..yN-1, z0..zN-1]
 *
 * This call schedules:
 *   1. device-to-device snapshot staging on the backend compute/default stream,
 *   2. device-to-host transfer to pinned memory on a dedicated snapshot stream.
 *
 * The returned snapshot handle can be waited on and consumed from another
 * host thread without needing any further backend interaction.
 */
fullmag_fdm_field_snapshot *fullmag_fdm_backend_begin_field_snapshot(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable);

/**
 * Wait for an asynchronous snapshot to complete and expose the pinned payload.
 *
 * On success:
 *   - `*out_data` points to the SoA payload owned by `snapshot`,
 *   - `*out_len_bytes` is the total payload byte length,
 *   - `*out_desc` describes dtype and logical vector shape.
 *
 * The returned pointer stays valid until `fullmag_fdm_field_snapshot_destroy`.
 */
int fullmag_fdm_field_snapshot_wait(
    fullmag_fdm_field_snapshot *snapshot,
    const void               **out_data,
    uint64_t                  *out_len_bytes,
    fullmag_fdm_snapshot_desc *out_desc);

/**
 * Destroy an asynchronous field snapshot handle.
 * Safe to call with NULL.
 */
void fullmag_fdm_field_snapshot_destroy(
    fullmag_fdm_field_snapshot *snapshot);

/**
 * Replace the backend magnetization state from host-side f64 AoS storage.
 * This does not advance time; call `fullmag_fdm_backend_refresh_observables`
 * afterwards to recompute H_ex / H_demag / H_eff for the uploaded state.
 */
int fullmag_fdm_backend_upload_magnetization_f64(
    fullmag_fdm_backend   *handle,
    const double          *m_xyz,
    uint64_t               len);

/**
 * Replace the backend magnetization state from host-side f32 AoS storage.
 * This does not advance time; call `fullmag_fdm_backend_refresh_observables`
 * afterwards to recompute H_ex / H_demag / H_eff for the uploaded state.
 */
int fullmag_fdm_backend_upload_magnetization_f32(
    fullmag_fdm_backend   *handle,
    const float           *m_xyz,
    uint64_t               len);

/**
 * Recompute observables for the current magnetization state without taking a
 * time step.
 */
int fullmag_fdm_backend_refresh_observables(
    fullmag_fdm_backend   *handle);

/**
 * Query GPU device metadata.
 */
int fullmag_fdm_backend_get_device_info(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_device_info *out_info);

/**
 * Return the last error message, or NULL if no error.
 * The pointer is valid until the next API call on this handle.
 */
const char *fullmag_fdm_backend_last_error(
    fullmag_fdm_backend *handle);

/**
 * Destroy a backend handle and free all device memory.
 * Safe to call with NULL.
 */
void fullmag_fdm_backend_destroy(
    fullmag_fdm_backend *handle);

#ifdef __cplusplus
}
#endif

#endif /* FULLMAG_FDM_H */
