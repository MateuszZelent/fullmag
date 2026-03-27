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
 *   - Host-side transfer buffers use f64 for simplicity.
 *   - Internal conversion to f32 happens only when precision is SINGLE.
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

/* ── Enums ── */

typedef enum {
    FULLMAG_FDM_PRECISION_SINGLE = 1,
    FULLMAG_FDM_PRECISION_DOUBLE = 2,
} fullmag_fdm_precision;

typedef enum {
    FULLMAG_FDM_INTEGRATOR_HEUN = 1,
    FULLMAG_FDM_INTEGRATOR_DP45 = 2,
    FULLMAG_FDM_INTEGRATOR_ABM3 = 3,
} fullmag_fdm_integrator;

typedef enum {
    FULLMAG_FDM_OBSERVABLE_M        = 1,
    FULLMAG_FDM_OBSERVABLE_H_EX     = 2,
    FULLMAG_FDM_OBSERVABLE_H_DEMAG  = 3,
    FULLMAG_FDM_OBSERVABLE_H_EXT    = 4,
    FULLMAG_FDM_OBSERVABLE_H_EFF    = 5,
} fullmag_fdm_observable;

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
     * as a sharp inter-body interface, i.e. exchange sees a free surface.
     * Length must equal cell_count when present.
     */
    const uint32_t            *region_mask;
    uint64_t                   region_mask_len;

    /* Initial m in AoS layout: [m0x, m0y, m0z, m1x, m1y, m1z, ...] */
    const double              *initial_magnetization_xyz;
    uint64_t                   initial_magnetization_len; /* = 3 * cell_count */

    /* Adaptive step configuration (DP45 only) */
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

/* ── Opaque handle ── */

typedef struct fullmag_fdm_backend fullmag_fdm_backend;

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
 * Even in SINGLE precision mode, this exports f64.
 */
int fullmag_fdm_backend_copy_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_xyz,
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
 * Replace the backend magnetization state from host-side f64 AoS storage.
 * This does not advance time; call `fullmag_fdm_backend_refresh_observables`
 * afterwards to recompute H_ex / H_demag / H_eff for the uploaded state.
 */
int fullmag_fdm_backend_upload_magnetization_f64(
    fullmag_fdm_backend   *handle,
    const double          *m_xyz,
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
