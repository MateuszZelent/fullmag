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
} fullmag_fdm_integrator;

typedef enum {
    FULLMAG_FDM_OBSERVABLE_M    = 1,
    FULLMAG_FDM_OBSERVABLE_H_EX = 2,
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

    /* Initial m in AoS layout: [m0x, m0y, m0z, m1x, m1y, m1z, ...] */
    const double              *initial_magnetization_xyz;
    uint64_t                   initial_magnetization_len; /* = 3 * cell_count */
} fullmag_fdm_plan_desc;

/* ── Per-step diagnostics ── */

typedef struct {
    uint64_t step;
    double   time_seconds;
    double   dt_seconds;
    double   exchange_energy_joules;
    double   max_effective_field_amplitude;  /* max |H_ex| */
    double   max_rhs_amplitude;             /* max |dm/dt| */
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
 * Execute one Heun time step of length dt_seconds.
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
