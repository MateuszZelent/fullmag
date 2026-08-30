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
#include "fullmag/fdm/transport/gpu_abi_v1.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ── Return codes ── */

#define FULLMAG_FDM_OK            0
#define FULLMAG_FDM_ERR_INVALID  -1
#define FULLMAG_FDM_ERR_CUDA     -2
#define FULLMAG_FDM_ERR_INTERNAL -3
#define FULLMAG_FDM_ERR_INTERRUPTED -4
#define FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED -5
#define FULLMAG_FDM_ERR_ABI -6

/* Maximum number of distinct exchange regions supported by the LUT. */
#define FULLMAG_FDM_MAX_EXCHANGE_REGIONS 256
/* Region id 0 is background; ids 1..MAX_REGION_ID address the LUT safely. */
#define FULLMAG_FDM_MAX_REGION_ID (FULLMAG_FDM_MAX_EXCHANGE_REGIONS - 1)

/* Append-only frozen-spin plan extension. Support is advertised separately. */
#define FULLMAG_FDM_FROZEN_SPINS_ABI_V1 1u
#define FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1 (UINT64_C(1) << 0)
#define FULLMAG_FDM_PLAN_DESC_ABI_V2 UINT32_C(2)

/* ── Enums ── */

typedef enum {
    FULLMAG_FDM_PRECISION_SINGLE = 1,
    FULLMAG_FDM_PRECISION_DOUBLE = 2,
} fullmag_fdm_precision;

typedef enum {
    FULLMAG_FDM_PLAN_UNIFORM_GRID = 0,
    FULLMAG_FDM_PLAN_MULTILAYER_CONV = 1,
} fullmag_fdm_plan_kind;

typedef enum {
    FULLMAG_FDM_TRANSFER_IDENTITY = 0,
    FULLMAG_FDM_TRANSFER_PUSH_PULL = 1,
} fullmag_fdm_transfer_kind;

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
    FULLMAG_FDM_OBSERVABLE_H_OE     = 6,
    FULLMAG_FDM_OBSERVABLE_H_DMI    = 7,
    FULLMAG_FDM_OBSERVABLE_H_ANI    = 8,
    /* Per-cell energy densities [J/m^3]; values are append-only ABI IDs. */
    FULLMAG_FDM_OBSERVABLE_EDEN_EX    = 9,
    FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG = 10,
    FULLMAG_FDM_OBSERVABLE_EDEN_EXT   = 11,
    FULLMAG_FDM_OBSERVABLE_EDEN_DRIVE = 12,
    FULLMAG_FDM_OBSERVABLE_EDEN_ANI   = 13,
    FULLMAG_FDM_OBSERVABLE_EDEN_DMI   = 14,
    FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL = 15,
} fullmag_fdm_observable;

typedef enum {
    FULLMAG_FDM_SNAPSHOT_SCALAR_F32 = 1,
    FULLMAG_FDM_SNAPSHOT_SCALAR_F64 = 2,
} fullmag_fdm_snapshot_scalar_type;

typedef enum {
    /* Zero preserves the historical unversioned ABI behavior. */
    FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0 = 0,
    FULLMAG_FDM_PRESCRIBED_SOT_V1 = 1,
} fullmag_fdm_prescribed_sot_formula;

typedef enum {
    /* Zero preserves the historical upwind Zhang-Li ABI behavior. */
    FULLMAG_FDM_ZHANG_LI_LEGACY_FULLMAG_V0 = 0,
    /* MuMax3 addzhanglitorque2: central clamped/PBC stencil. */
    FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1 = 1,
} fullmag_fdm_zhang_li_formula;

typedef enum {
    /* Zero preserves the historical hbar/(2e) Slonczewski ABI behavior. */
    FULLMAG_FDM_SLONCZEWSKI_LEGACY_FULLMAG_V0 = 0,
    /* Canonical SI evaluator: signed J_n and hbar/e Omega_J. */
    FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2 = 1,
} fullmag_fdm_slonczewski_formula;

typedef enum {
    FULLMAG_FDM_BOUNDARY_NONE   = 0,  /* binary active_mask (current) */
    FULLMAG_FDM_BOUNDARY_VOLUME = 1,  /* T0: face-link + φ weighting */
    FULLMAG_FDM_BOUNDARY_FULL   = 2,  /* T1: ECB stencil + H_corr    */
} fullmag_fdm_boundary_correction;

typedef enum {
    /*
     * Compatibility default for zero-initialized legacy callers.  When a
     * region_mask is present and no explicit exchange_lut is provided, this
     * keeps the historical free-surface cross-region behavior.
     */
    FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED   = 0,
    FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN = 1,
    FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT      = 2,
    FULLMAG_FDM_EXCHANGE_PAIR_DISABLED      = 3,
} fullmag_fdm_exchange_pair_mode;

typedef struct {
    uint32_t region_i;
    uint32_t region_j;
    fullmag_fdm_exchange_pair_mode mode;
    double scale;
    double inter_exchange;
} fullmag_fdm_exchange_pair_desc;

typedef enum {
    FULLMAG_FDM_STATS_FULL = 0,  /* default: preserve existing per-step diagnostics */
    FULLMAG_FDM_STATS_NONE = 1,  /* step returns only step/time/dt metadata */
    FULLMAG_FDM_STATS_CONTROL = 2, /* step-control metadata; no full observation */
    FULLMAG_FDM_STATS_REQUESTED = 3, /* on-demand masked scalar observation */
} fullmag_fdm_stats_mode;

#define FULLMAG_FDM_STATS_QUANTITY_E_EX          (UINT64_C(1) << 0)
#define FULLMAG_FDM_STATS_QUANTITY_E_DEMAG       (UINT64_C(1) << 1)
#define FULLMAG_FDM_STATS_QUANTITY_E_EXT         (UINT64_C(1) << 2)
#define FULLMAG_FDM_STATS_QUANTITY_E_ANI         (UINT64_C(1) << 3)
#define FULLMAG_FDM_STATS_QUANTITY_E_DMI         (UINT64_C(1) << 4)
#define FULLMAG_FDM_STATS_QUANTITY_E_TOTAL       (UINT64_C(1) << 5)
#define FULLMAG_FDM_STATS_QUANTITY_MAX_H_EFF     (UINT64_C(1) << 6)
#define FULLMAG_FDM_STATS_QUANTITY_MAX_H_DEMAG   (UINT64_C(1) << 7)
#define FULLMAG_FDM_STATS_QUANTITY_MAX_TORQUE    (UINT64_C(1) << 8)
#define FULLMAG_FDM_STATS_QUANTITY_MAX_RHS       (UINT64_C(1) << 9)
#define FULLMAG_FDM_STATS_QUANTITY_ALL           ((UINT64_C(1) << 10) - 1)
#define FULLMAG_FDM_STATS_QUANTITY_CONTROL       \
    (FULLMAG_FDM_STATS_QUANTITY_MAX_TORQUE | \
     FULLMAG_FDM_STATS_QUANTITY_MAX_RHS)

#define FULLMAG_FDM_STATS_POLICY_ABI_V1 1u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fdm_stats_mode mode;
    uint32_t stride;
    uint64_t quantity_mask;
} fullmag_fdm_stats_policy_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_stats_policy_v1) == 24,
              "stats policy v1 ABI size changed");
#endif

#define FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V1 UINT32_C(1)
#define FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V2 UINT32_C(2)
#define FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3 UINT32_C(3)
#define FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V4 UINT32_C(4)
#define FULLMAG_FDM_CHECKPOINT_EXECUTION_IDENTITY_ABI_V3 UINT32_C(3)
#define FULLMAG_FDM_WORKSPACE_DEPENDENCY_IDENTITY_ABI_V1 UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_BACKEND_FDM UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_BACKEND_AUTO UINT32_C(2)
#define FULLMAG_FDM_CHECKPOINT_POLICY_GPU_REQUIRED UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_POLICY_STRICT UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_POLICY_EXTENDED UINT32_C(2)
#define FULLMAG_FDM_CHECKPOINT_DEVICE_AUTO UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_DEVICE_GPU UINT32_C(2)
#define FULLMAG_FDM_CHECKPOINT_RNG_NONE UINT32_C(0)
#define FULLMAG_FDM_CHECKPOINT_RNG_CURAND_PHILOX4X32_10 UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_DISABLED UINT32_C(0)
#define FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_CUDA_FP32 UINT32_C(1)
#define FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_CUDA_FP64 UINT32_C(2)

typedef struct {
    uint32_t schema_version;
    uint32_t integrator;
    uint32_t precision;
    uint32_t array_mask;
    uint64_t cell_count;
    uint64_t payload_bytes;
    uint64_t step_count;
    double current_time;
    double current_dt;
    uint64_t transport_attempt_generation;
    uint32_t fsal_valid;
    uint32_t abm_startup;
    double abm_last_dt;
    uint32_t adaptive_has_previous_error;
    uint32_t reserved0;
    double adaptive_previous_error;
} fullmag_fdm_llg_checkpoint_info_v1;

typedef struct {
    uint32_t schema_version;
    uint32_t struct_size;
    uint32_t integrator;
    uint32_t precision;
    uint32_t requested_backend;
    uint32_t resolved_backend;
    uint32_t executed_backend;
    uint32_t requested_policy;
    uint32_t resolved_policy;
    uint32_t execution_realization;
    int32_t device_ordinal;
    uint32_t array_mask;
    uint64_t cell_count;
    uint64_t payload_bytes;
    uint64_t step_count;
    uint64_t accepted_step_index;
    uint64_t accepted_state_revision;
    double current_time;
    double current_dt;
    uint64_t transport_attempt_generation;
    uint64_t rhs_source_revision;
    uint64_t rhs_field_revision;
    uint64_t rhs_transport_revision;
    uint64_t projection_policy_identity;
    uint32_t fsal_valid;
    uint32_t abm_startup;
    double abm_last_dt;
    uint32_t adaptive_enabled;
    uint32_t adaptive_has_previous_error;
    double adaptive_previous_error;
    uint64_t fsal_accepted_state_revision;
    uint64_t fsal_accepted_time_bits;
    uint64_t fsal_accepted_dt_bits;
    uint64_t fsal_source_revision;
    uint64_t fsal_field_revision;
    uint64_t fsal_transport_revision;
    uint64_t fsal_transport_state_identity;
    uint64_t fsal_projection_policy_identity;
    uint32_t fsal_integrator_identity;
    uint32_t fsal_precision_identity;
} fullmag_fdm_llg_checkpoint_info_v2;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t requested_backend;
    uint32_t resolved_backend;
    uint32_t executed_backend;
    uint32_t requested_policy;
    uint32_t resolved_policy;
    uint32_t executed_policy;
    uint32_t requested_realization;
    uint32_t resolved_realization;
    uint32_t executed_realization;
    uint32_t requested_device;
    uint32_t resolved_device;
    uint32_t executed_device;
    uint32_t requested_precision;
    uint32_t resolved_precision;
    uint32_t executed_precision;
    uint32_t requested_integrator;
    uint32_t resolved_integrator;
    uint32_t executed_integrator;
    int32_t device_ordinal;
    uint32_t reserved0;
} fullmag_fdm_checkpoint_execution_identity_v3;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t grid_nx;
    uint32_t grid_ny;
    uint32_t grid_nz;
    uint32_t fft_nx;
    uint32_t fft_ny;
    uint32_t fft_nz;
    uint32_t precision;
    uint32_t integrator;
    uint32_t periodic_axis_mask;
    uint32_t reserved0;
    double grid_dx;
    double grid_dy;
    double grid_dz;
    uint8_t mask_topology_sha256[32];
    uint8_t material_layout_sha256[32];
    uint8_t spectra_sha256[32];
    uint8_t dependency_sha256[32];
} fullmag_fdm_workspace_dependency_identity_v1;

typedef struct {
    uint32_t schema_version;
    uint32_t struct_size;
    fullmag_fdm_checkpoint_execution_identity_v3 execution_identity;
    uint32_t array_mask;
    uint32_t reserved0;
    uint64_t cell_count;
    uint64_t payload_bytes;
    uint64_t step_count;
    uint64_t accepted_step_index;
    uint64_t accepted_state_revision;
    double current_time;
    double current_dt;
    uint64_t thermal_seed;
    uint32_t rng_algorithm;
    uint32_t rng_realization;
    uint64_t transport_attempt_generation;
    uint64_t rhs_source_revision;
    uint64_t rhs_field_revision;
    uint64_t rhs_transport_revision;
    uint64_t projection_policy_identity;
    uint32_t fsal_valid;
    uint32_t abm_startup;
    double abm_last_dt;
    uint32_t adaptive_enabled;
    uint32_t adaptive_has_previous_error;
    double adaptive_previous_error;
    uint64_t fsal_accepted_state_revision;
    uint64_t fsal_accepted_time_bits;
    uint64_t fsal_accepted_dt_bits;
    uint64_t fsal_source_revision;
    uint64_t fsal_field_revision;
    uint64_t fsal_transport_revision;
    uint64_t fsal_transport_state_identity;
    uint64_t fsal_projection_policy_identity;
    uint32_t fsal_integrator_identity;
    uint32_t fsal_precision_identity;
} fullmag_fdm_llg_checkpoint_info_v3;

typedef struct {
    uint32_t schema_version;
    uint32_t struct_size;
    fullmag_fdm_checkpoint_execution_identity_v3 execution_identity;
    fullmag_fdm_workspace_dependency_identity_v1 workspace_dependency_identity;
    uint32_t array_mask;
    uint32_t reserved0;
    uint64_t cell_count;
    uint64_t payload_bytes;
    uint64_t step_count;
    uint64_t accepted_step_index;
    uint64_t accepted_state_revision;
    double current_time;
    double current_dt;
    uint64_t thermal_seed;
    uint32_t rng_algorithm;
    uint32_t rng_realization;
    uint64_t transport_attempt_generation;
    uint64_t rhs_source_revision;
    uint64_t rhs_field_revision;
    uint64_t rhs_transport_revision;
    uint64_t projection_policy_identity;
    uint32_t fsal_valid;
    uint32_t abm_startup;
    double abm_last_dt;
    uint32_t adaptive_enabled;
    uint32_t adaptive_has_previous_error;
    double adaptive_previous_error;
    uint64_t fsal_accepted_state_revision;
    uint64_t fsal_accepted_time_bits;
    uint64_t fsal_accepted_dt_bits;
    uint64_t fsal_source_revision;
    uint64_t fsal_field_revision;
    uint64_t fsal_transport_revision;
    uint64_t fsal_transport_state_identity;
    uint64_t fsal_projection_policy_identity;
    uint32_t fsal_integrator_identity;
    uint32_t fsal_precision_identity;
} fullmag_fdm_llg_checkpoint_info_v4;

typedef int (*fullmag_fdm_interrupt_poll_fn)(void *user_data);

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
    double re;
    double im;
} fullmag_fdm_complex64;

typedef struct {
    float re;
    float im;
} fullmag_fdm_complex32;

typedef struct {
    fullmag_fdm_grid_desc      native_grid;
    fullmag_fdm_grid_desc      convolution_grid;
    fullmag_fdm_transfer_kind  transfer_kind;
    uint32_t                   layer_index;
    int32_t                    z_offset_cells;
    fullmag_fdm_material_desc  material;
    int                        has_uniaxial_anisotropy;
    double                     uniaxial_anisotropy_constant; /* K_u1 (J/m^3) */
    double                     uniaxial_anisotropy_k2;       /* K_u2 (J/m^3) */
    double                     anisotropy_axis[3];           /* Normalized axis */
    int                        has_cubic_anisotropy;
    double                     cubic_Kc1;                    /* 1st-order cubic (J/m^3) */
    double                     cubic_Kc2;                    /* 2nd-order cubic (J/m^3) */
    double                     cubic_Kc3;                    /* 3rd-order cubic (J/m^3) */
    double                     cubic_axis1[3];               /* Normalized 1st crystal axis */
    double                     cubic_axis2[3];               /* Normalized 2nd crystal axis; c3 = c1×c2 */
    const double              *initial_magnetization_xyz;
    uint64_t                   initial_magnetization_len;
    const uint8_t             *active_mask;
    uint64_t                   active_mask_len;
} fullmag_fdm_layer_desc_v2;

typedef struct {
    fullmag_fdm_grid_desc      fft_grid;
    uint32_t                   dst_layer;
    uint32_t                   src_layer;
    double                     z_shift_meters;
    const fullmag_fdm_complex64 *kernel_xx;
    const fullmag_fdm_complex64 *kernel_yy;
    const fullmag_fdm_complex64 *kernel_zz;
    const fullmag_fdm_complex64 *kernel_xy;
    const fullmag_fdm_complex64 *kernel_xz;
    const fullmag_fdm_complex64 *kernel_yz;
    uint64_t                   kernel_len;
} fullmag_fdm_tensor_kernel_desc_v2;

typedef struct {
    fullmag_fdm_plan_kind      kind;
    fullmag_fdm_precision      precision;
    fullmag_fdm_integrator     integrator;
    int                        disable_precession;
    int                        enable_exchange;
    int                        enable_demag;
    int                        has_external_field;
    double                     external_field_am[3]; /* uniform H_ext in A/m */
    int                        has_interfacial_dmi;
    double                     dmi_D_interfacial;     /* D_ind (J/m^2) */
    int                        has_bulk_dmi;
    double                     dmi_D_bulk;            /* D_bulk (J/m^2) */
    const fullmag_fdm_layer_desc_v2 *layers;
    uint32_t                   layer_count;
    const fullmag_fdm_tensor_kernel_desc_v2 *kernels;
    uint32_t                   kernel_count;
    double                     adaptive_max_error;
    double                     adaptive_dt_min;
    double                     adaptive_dt_max;
    double                     adaptive_headroom;
    fullmag_fdm_stats_mode     stats_mode;
    uint32_t                   stats_stride;
} fullmag_fdm_multilayer_plan_desc_v2;

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

    const double              *ms_field;         /* optional f64[cell_count], Ms(x) [A/m] */
    uint64_t                   ms_field_len;
    const double              *a_field;          /* optional f64[cell_count], A(x) [J/m] */
    uint64_t                   a_field_len;
    const double              *alpha_field;      /* optional f64[cell_count], alpha(x) */
    uint64_t                   alpha_field_len;

    int                        has_uniaxial_anisotropy;
    double                     uniaxial_anisotropy_constant; /* K_u1 (J/m^3) */
    double                     uniaxial_anisotropy_k2;       /* K_u2 (J/m^3) */
    double                     anisotropy_axis[3];           /* Normalized axis */

    const double              *ku1_field;        /* optional f64[cell_count] */
    const double              *ku2_field;        /* optional f64[cell_count] */

    int                        has_cubic_anisotropy;
    double                     cubic_Kc1;             /* 1st-order cubic (J/m^3) */
    double                     cubic_Kc2;             /* 2nd-order cubic (J/m^3) */
    double                     cubic_Kc3;             /* 3rd-order cubic (J/m^3) */
    double                     cubic_axis1[3];        /* Normalized 1st crystal axis */
    double                     cubic_axis2[3];        /* Normalized 2nd crystal axis; c3 = c1×c2 */

    const double              *kc1_field;        /* optional f64[cell_count] */
    const double              *kc2_field;        /* optional f64[cell_count] */
    const double              *kc3_field;        /* optional f64[cell_count] */

    int                        has_interfacial_dmi;
    double                     dmi_D_interfacial;     /* D_ind (J/m^2) */
    int                        has_bulk_dmi;
    double                     dmi_D_bulk;            /* D_bulk (J/m^2) */
    const double              *dind_field;            /* optional f64[cell_count], D_ind(x) */
    uint64_t                   dind_field_len;
    const double              *dbulk_field;           /* optional f64[cell_count], D_bulk(x) */
    uint64_t                   dbulk_field_len;

    /* Magnetoelastic coupling — prescribed strain B1/B2 model */
    int                        has_magnetoelastic;    /* 1 = enabled */
    double                     mel_b1;                /* B1 coupling constant [Pa] */
    double                     mel_b2;                /* B2 coupling constant [Pa] */
    /* Uniform strain in Voigt order: [e11, e22, e33, 2e23, 2e13, 2e12] */
    double                     mel_strain[6];

    double                     temperature;            /* Temperature in K (0 = no thermal noise) */
    /* Fixed Brown-noise seed. Zero requests a backend-resolved entropy seed. */
    uint64_t                   thermal_seed;

    /* Zhang-Li Spin-Transfer Torque (CIP) */
    double                     current_density_x;      /* j_x (A/m^2) */
    double                     current_density_y;      /* j_y (A/m^2) */
    double                     current_density_z;      /* j_z (A/m^2) */
    double                     stt_degree;             /* P (dimensionless) */
    double                     stt_beta;               /* beta (dimensionless) */
    fullmag_fdm_zhang_li_formula zhang_li_formula;    /* explicit Zhang-Li realization */
    
    /* Slonczewski Spin-Transfer Torque (CPP / SOT) */
    double                     stt_p_x;                /* p_x (polarization direction) */
    double                     stt_p_y;                /* p_y */
    double                     stt_p_z;                /* p_z */
    double                     stt_lambda;             /* Lambda (asymmetry parameter) */
    double                     stt_epsilon_prime;      /* epsilon' (secondary spin-transfer term) */
    double                     stt_free_layer_thickness; /* free layer thickness [m]; 0 = use dz */
    double                     stt_current_sign;       /* +1 top/default, -1 bottom fixed layer */
    fullmag_fdm_slonczewski_formula slonczewski_formula;
    double                     stt_stack_normal[3];    /* canonical signed-current normal */
    const uint8_t              *slonczewski_active_mask; /* canonical target mask */
    uint64_t                   slonczewski_active_mask_len;

    /* Spin-Orbit Torque (SOT) — Manchon-Zhang damping-like + field-like model */
    int                        has_sot;                /* 1 = enabled */
    fullmag_fdm_prescribed_sot_formula sot_formula;   /* explicit formula discriminator */
    double                     sot_je;                 /* v1: signed conventional J; legacy v0: historical |J| */
    double                     sot_xi_dl;              /* damping-like SOT efficiency (≈ θ_SH) */
    double                     sot_xi_fl;              /* field-like SOT efficiency (Rashba term) */
    double                     sot_sigma[3];           /* σ̂ spin polarisation unit vector */
    double                     sot_thickness;          /* t_F ferromagnet layer thickness [m] */
    const uint8_t             *sot_active_mask;        /* target mask: 1 = prescribed SOT applies */
    uint64_t                   sot_active_mask_len;    /* = cell_count when has_sot */

    /* Oersted field from cylindrical conductor (STNO / MTJ) */
    int                        has_oersted_cylinder;   /* 1 = enabled */
    double                     oersted_current;        /* DC current [A] */
    double                     oersted_radius;         /* cylinder radius [m] */
    double                     oersted_center[3];      /* cross-section centre [m] */
    double                     oersted_axis[3];        /* current-flow axis (unit vector) */
    uint32_t                   oersted_time_dep_kind;  /* 0=constant, 1=sinusoidal, 2=pulse */
    double                     oersted_time_dep_freq;  /* sinusoidal: frequency [Hz] */
    double                     oersted_time_dep_phase; /* sinusoidal: phase [rad] */
    double                     oersted_time_dep_offset;/* sinusoidal: offset */
    double                     oersted_time_dep_t_on;  /* pulse: t_on [s] */
    double                     oersted_time_dep_t_off; /* pulse: t_off [s] */
    const double              *oersted_field_xyz;      /* optional precomputed AoS H_OE [A/m] */
    uint64_t                   oersted_field_len;      /* = cell_count * 3 when present */

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
    uint32_t                   demag_fft_nx; /* optional explicit FFT X dimension */
    uint32_t                   demag_fft_ny; /* optional explicit FFT Y dimension */
    uint32_t                   demag_fft_nz; /* optional explicit FFT Z dimension */

    /* Optional active geometry mask: 1 = active cell, 0 = inactive cell. */
    const uint8_t             *active_mask;
    uint64_t                   active_mask_len; /* = cell_count when present */

    /*
     * Optional region/body ids for exchange barriers.
     * Neighboring active cells with different non-zero region ids are treated
     * according to the exchange LUT (see below).  When no LUT is provided,
     * cross-region exchange coupling is resolved from exchange_pair_default.
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
     * LUT from exchange_pair_default.  Legacy UNSPECIFIED keeps the historical
     * A_ii = material.exchange_stiffness and A_ij(i!=j) = 0 behavior.  Current
     * region-owned semantics must set HARMONIC_MEAN so region-region exchange
     * inside one object remains continuous by default.
     */
    const double              *exchange_lut;
    uint64_t                   exchange_lut_len; /* must be MAX_EXCHANGE_REGIONS^2 when present */
    fullmag_fdm_exchange_pair_mode exchange_pair_default;
    const fullmag_fdm_exchange_pair_desc *exchange_pairs;
    uint64_t                   exchange_pair_count;

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

    /* Periodic boundary conditions per axis (exchange wrapping) */
    int                        periodic_x;
    int                        periodic_y;
    int                        periodic_z;

    /* Adaptive step configuration (DP45 and RK23) */
    double                     adaptive_max_error;   /* 0 → use default 1e-5 */
    double                     adaptive_dt_min;      /* 0 → use default 1e-18 */
    double                     adaptive_dt_max;      /* 0 → use default 1e-10 */
    double                     adaptive_headroom;    /* 0 → use default 0.8 */

    /*
     * Step-end scalar diagnostics.  FULL preserves legacy behavior.  NONE
     * avoids expensive energy/norm reductions inside the step path; callers can
     * use fullmag_fdm_backend_snapshot_stats when full diagnostics are needed.
     * stats_stride = 0 is treated as 1.
     */
    fullmag_fdm_stats_mode     stats_mode;
    uint32_t                   stats_stride;

    /*
     * Frozen-spin ABI v1. NULL/zero preserves the unconstrained fast path.
     * The reference is AoS f64 xyz and must contain 3 * frozen_mask_len values.
     * Callers must check FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1 before use.
     */
    const uint8_t             *frozen_mask;
    uint64_t                   frozen_mask_len;
    const double              *frozen_reference_xyz;
    uint64_t                   frozen_reference_len;
} fullmag_fdm_plan_desc;

typedef enum {
    FULLMAG_FDM_ADAPTIVE_MAX_ERROR = 1,
    FULLMAG_FDM_ADAPTIVE_ADVANCED = 2,
} fullmag_fdm_adaptive_tolerance_mode;

/* Complete single-grid LLG timestep policy. No field uses zero as a sentinel. */
typedef struct {
    int adaptive_enabled;
    fullmag_fdm_adaptive_tolerance_mode adaptive_tolerance_mode;
    double adaptive_atol;
    double adaptive_rtol;
    double adaptive_dt_min;
    double adaptive_dt_max;
    double adaptive_safety;
    double adaptive_growth_limit;
    double adaptive_shrink_limit;
    int has_adaptive_max_spin_rotation;
    double adaptive_max_spin_rotation;
    int has_adaptive_norm_tolerance;
    double adaptive_norm_tolerance;
} fullmag_fdm_time_policy_desc_v2;

typedef enum {
    FULLMAG_FDM_FSAL_INVALIDATION_NONE = 0,
    FULLMAG_FDM_FSAL_INVALIDATION_CACHE_EMPTY = 1,
    FULLMAG_FDM_FSAL_INVALIDATION_UNKNOWN_IDENTITY = 2,
    FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE = 3,
    FULLMAG_FDM_FSAL_INVALIDATION_WAVEFORM_DISCONTINUITY = 4,
    FULLMAG_FDM_FSAL_INVALIDATION_STATE_MISMATCH = 5,
    FULLMAG_FDM_FSAL_INVALIDATION_TIME_MISMATCH = 6,
    FULLMAG_FDM_FSAL_INVALIDATION_SOURCE_MISMATCH = 7,
    FULLMAG_FDM_FSAL_INVALIDATION_FIELD_MISMATCH = 8,
    FULLMAG_FDM_FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH = 9,
    FULLMAG_FDM_FSAL_INVALIDATION_PROJECTION_MISMATCH = 10,
    FULLMAG_FDM_FSAL_INVALIDATION_REALIZATION_MISMATCH = 11,
    FULLMAG_FDM_FSAL_INVALIDATION_REJECTED_STEP = 12,
    FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR = 13,
    FULLMAG_FDM_FSAL_INVALIDATION_CHECKPOINT_RESTORE = 14,
    FULLMAG_FDM_FSAL_INVALIDATION_STALE_PUBLICATION = 15,
} fullmag_fdm_fsal_invalidation_reason;

#define FULLMAG_FDM_FSAL_INVALIDATION_REASON_COUNT 16u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fdm_plan_desc base;
    fullmag_fdm_time_policy_desc_v2 time_policy;
} fullmag_fdm_plan_desc_v2;

/* ── Per-step diagnostics ── */

typedef struct {
    uint64_t step;
    double   time_seconds;
    double   dt_seconds;
    double   exchange_energy_joules;
    double   demag_energy_joules;
    double   external_energy_joules;
    double   anisotropy_energy_joules;
    double   cubic_energy_joules;
    double   dmi_energy_joules;
    double   total_energy_joules;
    double   max_effective_field_amplitude;  /* max |H_eff| */
    double   max_demag_field_amplitude;      /* max |H_demag| */
    double   max_rhs_amplitude;              /* max |dm/dt| */
    double   max_torque_Apm;                 /* max |m × H_eff|  (A/m) */
    double   suggested_next_dt;               /* adaptive optimal dt for next call */
    uint64_t wall_time_ns;
    uint64_t hot_loop_d2h_bytes;
    uint64_t hot_loop_host_sync_count;
    uint64_t hot_loop_control_scalar_d2h_bytes;
    uint64_t hot_loop_control_scalar_host_sync_count;
    uint64_t multilayer_refresh_count;
    uint64_t multilayer_forward_fft_count;
    uint64_t multilayer_inverse_fft_count;
    uint64_t multilayer_pair_accumulation_count;
} fullmag_fdm_step_stats;

#define FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1 1u
#define FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1 51u

typedef enum {
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED = 1,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_RETRY = 2,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_FAILED = 3,
} fullmag_fdm_adaptive_attempt_decision_v1;

typedef enum {
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_WITHIN_TOLERANCE = 1,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_ERROR_ABOVE_TOLERANCE = 2,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_DT_MIN_EXHAUSTED = 3,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_INVALID_TIMESTEP = 4,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_INVALID_CURRENT_ERROR = 5,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_INVALID_PREVIOUS_ERROR = 6,
    FULLMAG_FDM_ADAPTIVE_ATTEMPT_RETRY_LIMIT_EXHAUSTED = 7,
} fullmag_fdm_adaptive_attempt_reason_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t attempt_index;
    fullmag_fdm_adaptive_attempt_decision_v1 decision;
    fullmag_fdm_adaptive_attempt_reason_v1 reason;
    uint32_t reserved0;
    double dt_attempt_seconds;
    double normalized_error;
    double ratio;
    double dt_next_seconds;
} fullmag_fdm_adaptive_attempt_v1;

#define FULLMAG_FDM_ADAPTIVE_BATCH_STEP_ABI_V1 1u
#define FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1 64u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fdm_adaptive_attempt_decision_v1 decision;
    fullmag_fdm_adaptive_attempt_reason_v1 reason;
    uint64_t step;
    double time_seconds;
    double dt_seconds;
    double suggested_next_dt_seconds;
    double normalized_error;
    uint32_t rejected_attempts;
    uint32_t reserved0;
} fullmag_fdm_adaptive_batch_step_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_adaptive_batch_step_v1) == 64,
              "adaptive batch step v1 ABI size changed");
#endif

#define FULLMAG_FDM_FSAL_TELEMETRY_ABI_V1 1u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t fsal_reused;
    fullmag_fdm_fsal_invalidation_reason fsal_invalidation_reason;
    uint64_t fsal_invalidation_count;
    uint64_t rhs_evaluations_saved;
    uint64_t thermal_rng_draws;
    uint64_t accepted_step_index;
    uint64_t stale_publication_count;
    uint64_t transaction_commit_count;
} fullmag_fdm_fsal_telemetry_v1;

#define FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2 2u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t fsal_reused;
    fullmag_fdm_fsal_invalidation_reason fsal_invalidation_reason;
    uint64_t fsal_invalidation_count;
    uint64_t rhs_evaluations_saved;
    uint64_t thermal_rng_draws;
    uint64_t accepted_step_index;
    uint64_t stale_publication_count;
    uint64_t transaction_commit_count;
    uint64_t invalidation_reason_counts[FULLMAG_FDM_FSAL_INVALIDATION_REASON_COUNT];
} fullmag_fdm_fsal_telemetry_v2;

#define FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1 1u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t accounting_valid;
    uint32_t reserved0;
    uint64_t capture_count;
    uint64_t rollback_count;
    uint64_t capture_d2d_bytes;
    uint64_t rollback_d2d_bytes;
    uint64_t rollback_latency_total_ns;
    uint64_t rollback_latency_max_ns;
    uint64_t accepted_step_index;
    uint64_t attempt_generation;
    uint64_t thermal_rng_draws;
    uint64_t stale_publication_count;
} fullmag_fdm_step_transaction_telemetry_v1;

#define FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1 1u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t cache_identity_valid;
    uint32_t stats_valid;
    uint64_t accepted_state_revision;
    uint64_t accepted_time_bits;
    uint64_t source_revision;
    uint64_t field_revision;
    uint64_t transport_revision;
    uint64_t projection_policy_identity;
    uint64_t valid_field_mask;
    uint64_t refresh_request_count;
    uint64_t refresh_execution_count;
    uint64_t refresh_cache_hit_count;
    uint64_t invalidation_count;
    uint64_t stats_snapshot_request_count;
    uint64_t stats_snapshot_cache_hit_count;
    uint64_t field_snapshot_request_count;
    uint64_t field_snapshot_latency_total_ns;
    uint64_t field_snapshot_latency_max_ns;
    uint64_t exchange_evaluation_count;
    uint64_t demag_evaluation_count;
    uint64_t demag_forward_fft_count;
    uint64_t demag_inverse_fft_count;
    uint64_t effective_field_evaluation_count;
    uint64_t energy_reduction_count;
    uint64_t last_step_exchange_evaluation_count;
    uint64_t last_step_demag_evaluation_count;
    uint64_t last_step_demag_forward_fft_count;
    uint64_t last_step_demag_inverse_fft_count;
    uint64_t last_step_effective_field_evaluation_count;
    uint64_t last_step_energy_reduction_count;
} fullmag_fdm_endpoint_cache_telemetry_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_endpoint_cache_telemetry_v1) == 240,
              "endpoint cache telemetry v1 ABI size changed");
#endif

#define FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1 1u

typedef enum {
    FULLMAG_FDM_ADAPTIVE_CONTROL_NOT_APPLICABLE = 0,
    FULLMAG_FDM_ADAPTIVE_CONTROL_LEGACY_HOST_READBACK = 1,
    FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH = 2,
    FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH_BATCHED = 3,
} fullmag_fdm_adaptive_control_realization_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fdm_adaptive_control_realization_v1 realization;
    uint32_t accounting_valid;
    uint64_t graph_build_count;
    uint64_t graph_launch_count;
    uint64_t terminal_control_d2h_bytes;
    uint64_t terminal_control_host_sync_count;
    uint64_t step_completion_host_sync_count;
    uint64_t stats_none_host_sync_count;
} fullmag_fdm_adaptive_execution_telemetry_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_adaptive_execution_telemetry_v1) == 64,
              "adaptive execution telemetry v1 ABI size changed");
#endif

#define FULLMAG_FDM_PRECISION_POLICY_TELEMETRY_ABI_V1 1u

typedef enum {
    FULLMAG_FDM_PRECISION_POLICY_FULL_DOUBLE = 1,
    FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION = 2,
} fullmag_fdm_precision_policy_realization_v1;

#define FULLMAG_FDM_PRECISION_POLICY_METRIC_IDENTITY (UINT64_C(1) << 0)

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t accounting_valid;
    fullmag_fdm_precision storage_precision;
    fullmag_fdm_precision compute_precision;
    fullmag_fdm_precision fft_precision;
    fullmag_fdm_precision reduction_precision;
    fullmag_fdm_precision_policy_realization_v1 realization;
    uint64_t metric_valid_mask;
} fullmag_fdm_precision_policy_telemetry_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_precision_policy_telemetry_v1) == 40,
              "precision policy telemetry v1 ABI size changed");
#endif

#define FULLMAG_FDM_LOCAL_PIPELINE_TELEMETRY_ABI_V1 1u

typedef enum {
    FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE = 1,
} fullmag_fdm_local_pipeline_policy_v1;

typedef enum {
    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE = 0,
    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED = 1,
    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED = 2,
    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_FUSED = 3,
    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_UNFUSED = 4,
    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_MIXED = 5,
} fullmag_fdm_local_pipeline_realization_v1;

#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_IDENTITY (UINT64_C(1) << 0)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_DIRECT_SUBMISSIONS (UINT64_C(1) << 1)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_CAPTURED_NODES (UINT64_C(1) << 2)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_LIFECYCLE (UINT64_C(1) << 3)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_EXECUTIONS (UINT64_C(1) << 4)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_DRAM_BYTES (UINT64_C(1) << 5)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_LAUNCH_TIME (UINT64_C(1) << 6)
#define FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_OCCUPANCY (UINT64_C(1) << 7)

#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_EXCHANGE_INPUT (UINT64_C(1) << 0)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_DEMAG_INPUT (UINT64_C(1) << 1)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_UNIFORM_ZEEMAN (UINT64_C(1) << 2)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_STATIC_FIELD_PROFILE (UINT64_C(1) << 3)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_OERSTED (UINT64_C(1) << 4)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_ANISOTROPY (UINT64_C(1) << 5)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_MAGNETOELASTIC (UINT64_C(1) << 6)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_THERMAL (UINT64_C(1) << 7)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_ZHANG_LI_STT (UINT64_C(1) << 8)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_SLONCZEWSKI_STT (UINT64_C(1) << 9)
#define FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_SOT (UINT64_C(1) << 10)

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fdm_local_pipeline_policy_v1 requested_policy;
    fullmag_fdm_local_pipeline_realization_v1 resolved_realization;
    fullmag_fdm_local_pipeline_realization_v1 executed_realization;
    uint32_t accounting_valid;
    fullmag_fdm_precision precision;
    fullmag_fdm_integrator integrator;
    uint64_t metric_valid_mask;
    uint64_t required_operator_mask;
    uint64_t active_feature_mask;
    uint64_t source_revision;
    uint64_t field_revision;
    uint64_t direct_fused_field_rhs_launch_count;
    uint64_t direct_unfused_effective_field_launch_count;
    uint64_t direct_unfused_rhs_launch_count;
    uint64_t captured_fused_field_rhs_node_count;
    uint64_t captured_unfused_effective_field_node_count;
    uint64_t captured_unfused_rhs_node_count;
    uint64_t graph_build_count;
    uint64_t graph_replay_count;
    uint64_t graph_recapture_count;
    uint64_t graph_attempt_execution_count;
    uint64_t graph_fused_field_rhs_execution_count;
    uint64_t graph_unfused_effective_field_execution_count;
    uint64_t graph_unfused_rhs_execution_count;
    uint64_t profiled_dram_read_bytes;
    uint64_t profiled_dram_write_bytes;
    uint64_t profiled_launch_time_ns;
    uint64_t profiled_achieved_occupancy_permyriad;
} fullmag_fdm_local_pipeline_telemetry_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_local_pipeline_telemetry_v1) == 208,
              "local pipeline telemetry v1 ABI size changed");
#endif

#define FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1 1u

#define FULLMAG_FDM_GPU_WORKSPACE_METRIC_IDENTITY (UINT64_C(1) << 0)
#define FULLMAG_FDM_GPU_WORKSPACE_METRIC_ALLOCATIONS (UINT64_C(1) << 1)
#define FULLMAG_FDM_GPU_WORKSPACE_METRIC_FFT_PLANS (UINT64_C(1) << 2)
#define FULLMAG_FDM_GPU_WORKSPACE_METRIC_FOOTPRINT (UINT64_C(1) << 3)
#define FULLMAG_FDM_GPU_WORKSPACE_METRIC_REVISIONS (UINT64_C(1) << 4)

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t accounting_valid;
    uint32_t setup_complete;
    fullmag_fdm_precision precision;
    fullmag_fdm_integrator integrator;
    uint64_t metric_valid_mask;
    uint64_t workspace_revision;
    uint64_t source_revision;
    uint64_t field_revision;
    uint64_t setup_device_allocation_count;
    uint64_t setup_device_allocation_bytes;
    uint64_t total_device_allocation_count;
    uint64_t total_device_allocation_bytes;
    uint64_t step_device_allocation_count;
    uint64_t step_device_allocation_bytes;
    uint64_t setup_fft_plan_creation_count;
    uint64_t total_fft_plan_creation_count;
    uint64_t step_fft_plan_creation_count;
    uint64_t prepared_fft_workspace_count;
    uint64_t workspace_bytes;
    uint64_t peak_vram_bytes;
    uint64_t observed_step_count;
} fullmag_fdm_gpu_workspace_telemetry_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_gpu_workspace_telemetry_v1) == 160,
              "GPU workspace telemetry v1 ABI size changed");
#endif

#define FULLMAG_FDM_ADAPTIVE_NUMERICS_TELEMETRY_ABI_V1 1u

typedef enum {
    FULLMAG_FDM_EMBEDDED_ERROR_PRE_PROJECTION_DIFFERENCE = 1,
} fullmag_fdm_embedded_error_semantics_v1;

typedef enum {
    FULLMAG_FDM_NORM_DEFECT_POST_PROJECTION_ABS_UNIT = 1,
} fullmag_fdm_norm_defect_semantics_v1;

typedef enum {
    FULLMAG_FDM_SPIN_ROTATION_ATTEMPT_GEODESIC_RADIANS = 1,
} fullmag_fdm_spin_rotation_semantics_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fdm_embedded_error_semantics_v1 embedded_error_semantics;
    fullmag_fdm_norm_defect_semantics_v1 norm_defect_semantics;
    fullmag_fdm_spin_rotation_semantics_v1 spin_rotation_semantics;
    uint32_t accounting_valid;
    uint64_t terminal_observation_count;
    uint64_t decision_comparison_count;
    uint64_t decision_divergence_count;
    double last_terminal_normalized_error;
    double last_terminal_max_norm_defect;
    double last_terminal_max_spin_rotation_radians;
    double max_attempt_normalized_error;
    double max_attempt_norm_defect;
    double max_attempt_spin_rotation_radians;
} fullmag_fdm_adaptive_numerics_telemetry_v1;

#if defined(__cplusplus)
static_assert(sizeof(fullmag_fdm_adaptive_numerics_telemetry_v1) == 96,
              "adaptive numerics telemetry v1 ABI size changed");
#endif

/* ── Device info ── */

typedef struct {
    char name[128];
    int  compute_capability_major;
    int  compute_capability_minor;
    int  driver_version;
    int  runtime_version;
} fullmag_fdm_device_info;

#define FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 1u
#define FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2 2u

typedef enum {
#define FULLMAG_FDM_EXECUTION_CLASS_VALUE(name, value) name = value,
#define FULLMAG_FDM_EXECUTED_BACKEND_VALUE(name, value)
#define FULLMAG_FDM_OPERATOR_LOCATION_VALUE(name, value)
#define FULLMAG_FDM_OPERATOR_MASK_VALUE(name, value)
#include "fullmag_fdm_execution_receipt_v1_values.def"
#undef FULLMAG_FDM_OPERATOR_MASK_VALUE
#undef FULLMAG_FDM_OPERATOR_LOCATION_VALUE
#undef FULLMAG_FDM_EXECUTED_BACKEND_VALUE
#undef FULLMAG_FDM_EXECUTION_CLASS_VALUE
} fullmag_fdm_execution_class_v1;

typedef enum {
#define FULLMAG_FDM_EXECUTION_CLASS_VALUE(name, value)
#define FULLMAG_FDM_EXECUTED_BACKEND_VALUE(name, value) name = value,
#define FULLMAG_FDM_OPERATOR_LOCATION_VALUE(name, value)
#define FULLMAG_FDM_OPERATOR_MASK_VALUE(name, value)
#include "fullmag_fdm_execution_receipt_v1_values.def"
#undef FULLMAG_FDM_OPERATOR_MASK_VALUE
#undef FULLMAG_FDM_OPERATOR_LOCATION_VALUE
#undef FULLMAG_FDM_EXECUTED_BACKEND_VALUE
#undef FULLMAG_FDM_EXECUTION_CLASS_VALUE
} fullmag_fdm_executed_backend_v1;

typedef enum {
#define FULLMAG_FDM_EXECUTION_CLASS_VALUE(name, value)
#define FULLMAG_FDM_EXECUTED_BACKEND_VALUE(name, value)
#define FULLMAG_FDM_OPERATOR_LOCATION_VALUE(name, value) name = value,
#define FULLMAG_FDM_OPERATOR_MASK_VALUE(name, value)
#include "fullmag_fdm_execution_receipt_v1_values.def"
#undef FULLMAG_FDM_OPERATOR_MASK_VALUE
#undef FULLMAG_FDM_OPERATOR_LOCATION_VALUE
#undef FULLMAG_FDM_EXECUTED_BACKEND_VALUE
#undef FULLMAG_FDM_EXECUTION_CLASS_VALUE
} fullmag_fdm_operator_location_v1;

enum {
#define FULLMAG_FDM_EXECUTION_CLASS_VALUE(name, value)
#define FULLMAG_FDM_EXECUTED_BACKEND_VALUE(name, value)
#define FULLMAG_FDM_OPERATOR_LOCATION_VALUE(name, value)
#define FULLMAG_FDM_OPERATOR_MASK_VALUE(name, value) name = value,
#include "fullmag_fdm_execution_receipt_v1_values.def"
#undef FULLMAG_FDM_OPERATOR_MASK_VALUE
#undef FULLMAG_FDM_OPERATOR_LOCATION_VALUE
#undef FULLMAG_FDM_EXECUTED_BACKEND_VALUE
#undef FULLMAG_FDM_EXECUTION_CLASS_VALUE
};

typedef struct {
#define FULLMAG_FDM_EXECUTION_RECEIPT_FIELD(type, name, offset) type name;
#define FULLMAG_FDM_EXECUTION_RECEIPT_SIZE(size)
#include "fullmag_fdm_execution_receipt_v1_layout.def"
#undef FULLMAG_FDM_EXECUTION_RECEIPT_SIZE
#undef FULLMAG_FDM_EXECUTION_RECEIPT_FIELD
} fullmag_fdm_execution_receipt_v1;

typedef struct {
#define FULLMAG_FDM_EXECUTION_RECEIPT_FIELD(type, name, offset) type name;
#define FULLMAG_FDM_EXECUTION_RECEIPT_SIZE(size)
#include "fullmag_fdm_execution_receipt_v2_layout.def"
#undef FULLMAG_FDM_EXECUTION_RECEIPT_SIZE
#undef FULLMAG_FDM_EXECUTION_RECEIPT_FIELD
} fullmag_fdm_execution_receipt_v2;

typedef struct {
    uint64_t cell_count;
    uint32_t component_count; /* 3 for vectors, 1 for scalar fields */
    uint32_t scalar_bytes;    /* 4 for f32, 8 for f64 */
    fullmag_fdm_snapshot_scalar_type scalar_type;
} fullmag_fdm_snapshot_desc;

/* ── Opaque handle ── */

typedef struct fullmag_fdm_backend fullmag_fdm_backend;
typedef struct fullmag_fdm_plan_ingestion_v2 fullmag_fdm_plan_ingestion_v2;
typedef struct fullmag_fdm_field_snapshot fullmag_fdm_field_snapshot;
typedef struct fullmag_fdm_preview_snapshot fullmag_fdm_preview_snapshot;

/*
 * Append-only binding between a single-grid FP64 LLG context and an accepted
 * GPU M1 charge snapshot.  The record contains registry identities and solver
 * policy only: CUDA pointers, streams, and transport buffers remain owned by
 * the native GPU transport context.
 */
#if defined(__cplusplus)
#define FULLMAG_FDM_BINDING_ALIGN8 alignas(8)
#define FULLMAG_FDM_BINDING_ALIGN8_FIELD
#else
#define FULLMAG_FDM_BINDING_ALIGN8
#define FULLMAG_FDM_BINDING_ALIGN8_FIELD _Alignas(8)
#endif
typedef struct FULLMAG_FDM_BINDING_ALIGN8 fullmag_fdm_gpu_transport_llg_binding_v1 {
    FULLMAG_FDM_BINDING_ALIGN8_FIELD uint32_t abi_version;
    uint32_t struct_version;
    uint32_t struct_size;
    uint32_t reserved_flags;
    uint64_t required_features;
    uint64_t reserved0;
    fullmag_fdm_gpu_transport_context_handle_v1 transport_context;
    fullmag_fdm_gpu_charge_snapshot_handle_v1 charge_snapshot;
    uint64_t accepted_sequence;
    uint64_t source_revision;
    uint64_t operator_revision;
    double relative_tolerance;
    uint64_t max_iterations;
    uint64_t reserved1;
} fullmag_fdm_gpu_transport_llg_binding_v1;
#undef FULLMAG_FDM_BINDING_ALIGN8_FIELD
#undef FULLMAG_FDM_BINDING_ALIGN8

/* ── Functions ── */

/**
 * Check whether the CUDA FDM backend is compiled and a valid GPU is available.
 * Returns 1 if available, 0 otherwise.
 */
int fullmag_fdm_is_available(void);

/** Return supported append-only FDM feature bits for ABI v1. */
uint64_t fullmag_fdm_capability_bits_v1(void);

/**
 * Legacy unversioned v1 compatibility entrypoint.
 * Create a backend handle from an executable plan.
 * Allocates device memory and uploads initial magnetization.
 * Returns NULL on failure; call fullmag_fdm_backend_last_error for details.
 */
fullmag_fdm_backend *fullmag_fdm_backend_create(
    const fullmag_fdm_plan_desc *plan);

/* Canonical versioned single-grid entrypoint preserving complete LLG policy. */
fullmag_fdm_backend *fullmag_fdm_backend_create_time_policy_v2(
    const fullmag_fdm_plan_desc_v2 *plan);

/*
 * Validate and ingest the exact supported v2 descriptor into a short-lived
 * ABI owner.  The owner stores plan-input fields only, owns no pointed-to
 * buffers, and must not outlive those caller-owned buffers.
 */
int fullmag_fdm_plan_ingestion_v2_create_checked(
    const fullmag_fdm_plan_desc_v2 *plan,
    fullmag_fdm_plan_ingestion_v2 **out_ingestion);

/* Copy the ingested semantic fields into a caller-owned receipt. */
int fullmag_fdm_plan_ingestion_v2_receipt(
    const fullmag_fdm_plan_ingestion_v2 *ingestion,
    fullmag_fdm_plan_desc_v2 *out_receipt);

/* Destroy the plan-input owner.  No backend or hot-loop state is affected. */
void fullmag_fdm_plan_ingestion_v2_destroy(
    fullmag_fdm_plan_ingestion_v2 *ingestion);

/* Typed constructor. ABI rejection happens before backend allocation. */
int fullmag_fdm_backend_create_time_policy_v2_checked(
    const fullmag_fdm_plan_desc_v2 *plan,
    fullmag_fdm_backend **out_handle);

/**
 * Create a backend handle from the v2 executable FDM plan descriptor.
 *
 * This entrypoint stages multilayer convolution plans without overloading the
 * legacy single-grid plan.  Supported staged v2 handles execute native CUDA
 * multilayer fixed-step Heun/RK4/RK23 slices with explicit per-layer field copy/upload and
 * demag-refresh entrypoints; unsupported v2 variants fail explicitly rather
 * than silently falling back to single-grid execution.
 */
fullmag_fdm_backend *fullmag_fdm_backend_create_v2(
    const fullmag_fdm_multilayer_plan_desc_v2 *plan);

int fullmag_fdm_backend_set_stats_policy_v1(
    fullmag_fdm_backend *handle,
    const fullmag_fdm_stats_policy_v1 *policy);

/** Upload a cell-wise profile as static external H_ext [A/m].
 * The legacy descriptor keeps the wire layout stable; this role setter is
 * intentionally a separate versioned operation and is valid only for a
 * non-cylindrical single-grid profile. It does not set the Oersted role.
 */
int fullmag_fdm_backend_set_static_external_field_f64(
    fullmag_fdm_backend *handle,
    const double *field_xyz,
    uint64_t field_len);

/**
 * Execute one time step of length dt_seconds using the configured integrator.
 * For DP45: dt_seconds is the initial step size; adaptive stepping may adjust it.
 * On success, writes diagnostics to *out_stats and returns FULLMAG_FDM_OK.
 */
int fullmag_fdm_backend_step(
    fullmag_fdm_backend    *handle,
    double                  dt_seconds,
    fullmag_fdm_step_stats *out_stats);

/*
 * Execute a bounded, atomic batch of adaptive CUDA steps through one terminal
 * D2H/synchronization boundary. This API is valid only for stats-none,
 * single-grid RK23/RK45 configurations accepted by device-loop preflight.
 * On failure the complete batch is rolled back and *out_count remains zero.
 */
int fullmag_fdm_backend_step_adaptive_batch_v1(
    fullmag_fdm_backend *handle,
    double initial_dt_seconds,
    double target_time_seconds,
    uint32_t max_steps,
    fullmag_fdm_adaptive_batch_step_v1 *out_steps,
    uint32_t capacity,
    uint32_t *out_count);

/*
 * Copy the completed adaptive-attempt trace in one observation-time D2H batch.
 * A NULL output with capacity zero queries the required record count. The trace
 * belongs to the most recent public step and is empty for fixed-step methods.
 */
int fullmag_fdm_backend_copy_adaptive_attempts_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_adaptive_attempt_v1 *out_attempts,
    uint32_t capacity,
    uint32_t *out_count);

/* Caller initializes abi_version and struct_size. Invalid headers leave output unchanged. */
int fullmag_fdm_backend_get_fsal_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_fsal_telemetry_v1 *out_telemetry);

int fullmag_fdm_backend_get_fsal_telemetry_v2(
    fullmag_fdm_backend *handle,
    fullmag_fdm_fsal_telemetry_v2 *out_telemetry);

int fullmag_fdm_backend_get_step_transaction_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_step_transaction_telemetry_v1 *out_telemetry);

int fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_endpoint_cache_telemetry_v1 *out_telemetry);

/* Caller initializes abi_version and struct_size. */
int fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_adaptive_execution_telemetry_v1 *out_telemetry);

int fullmag_fdm_backend_get_precision_policy_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_precision_policy_telemetry_v1 *out_telemetry);

int fullmag_fdm_backend_get_local_pipeline_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_local_pipeline_telemetry_v1 *out_telemetry);

int fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_gpu_workspace_telemetry_v1 *out_telemetry);

int fullmag_fdm_backend_get_adaptive_numerics_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_adaptive_numerics_telemetry_v1 *out_telemetry);

/* Bind/unbind the stage-wise GPU transport torque source for Heun or RK4. */
int fullmag_fdm_context_bind_gpu_transport_v1(
    fullmag_fdm_backend *handle,
    const fullmag_fdm_gpu_transport_llg_binding_v1 *binding);

int fullmag_fdm_context_unbind_gpu_transport_v1(
    fullmag_fdm_backend *handle);

int fullmag_fdm_backend_set_interrupt_poll(
    fullmag_fdm_backend *handle,
    fullmag_fdm_interrupt_poll_fn poll_fn,
    void *user_data);

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
 * Copy a per-cell scalar energy-density observable from device to host as f64.
 * `out_len` must equal the backend cell count. Only EDEN_* observables are
 * valid; scalar values use the canonical unit J/m^3.
 */
int fullmag_fdm_backend_copy_scalar_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_values,
    uint64_t               out_len);

/** Copy a per-cell scalar energy-density observable from device to host as f32. */
int fullmag_fdm_backend_copy_scalar_field_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    float                 *out_values,
    uint64_t               out_len);

/**
 * Copy a v2 multilayer layer field observable from device to host as f64.
 * Supports FULLMAG_FDM_OBSERVABLE_M, FULLMAG_FDM_OBSERVABLE_H_EX,
 * FULLMAG_FDM_OBSERVABLE_H_DEMAG, FULLMAG_FDM_OBSERVABLE_H_DMI,
 * FULLMAG_FDM_OBSERVABLE_H_ANI, FULLMAG_FDM_OBSERVABLE_H_EXT,
 * and FULLMAG_FDM_OBSERVABLE_H_EFF.
 * out_xyz length must be 3 * the selected layer native cell count.
 */
int fullmag_fdm_backend_copy_layer_field_f64(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    fullmag_fdm_observable observable,
    double                *out_xyz,
    uint64_t               out_len);

/**
 * Copy a v2 multilayer layer field observable from device to host as f32.
 * Supports FULLMAG_FDM_OBSERVABLE_M, FULLMAG_FDM_OBSERVABLE_H_EX,
 * FULLMAG_FDM_OBSERVABLE_H_DEMAG, FULLMAG_FDM_OBSERVABLE_H_DMI,
 * FULLMAG_FDM_OBSERVABLE_H_ANI, FULLMAG_FDM_OBSERVABLE_H_EXT,
 * and FULLMAG_FDM_OBSERVABLE_H_EFF.
 * out_xyz length must be 3 * the selected layer native cell count.
 */
int fullmag_fdm_backend_copy_layer_field_f32(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
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
 * component-major SoA for vector observables:
 *   [x0..xN-1, y0..yN-1, z0..zN-1]
 * Scalar EDEN_* observables contain one component: [value0..valueN-1].
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
 * Begin an asynchronous downsampled preview snapshot.
 *
 * The payload layout exposed by `fullmag_fdm_preview_snapshot_wait` matches
 * `fullmag_fdm_backend_copy_field_preview_*`:
 *   [x0,y0,z0, x1,y1,z1, ...]
 *
 * The snapshot owns a private device preview buffer plus pinned host storage.
 * Device downsampling is scheduled on the backend compute/default stream,
 * then the device-to-host transfer continues on a dedicated preview stream.
 */
fullmag_fdm_preview_snapshot *fullmag_fdm_backend_begin_preview_snapshot(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride);

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
 * Wait for an asynchronous preview snapshot to complete and expose the payload.
 */
int fullmag_fdm_preview_snapshot_wait(
    fullmag_fdm_preview_snapshot *snapshot,
    const void                 **out_data,
    uint64_t                    *out_len_bytes,
    fullmag_fdm_snapshot_desc   *out_desc);

/**
 * Destroy an asynchronous field snapshot handle.
 * Safe to call with NULL.
 */
void fullmag_fdm_field_snapshot_destroy(
    fullmag_fdm_field_snapshot *snapshot);

/**
 * Destroy an asynchronous preview snapshot handle.
 * Safe to call with NULL.
 */
void fullmag_fdm_preview_snapshot_destroy(
    fullmag_fdm_preview_snapshot *snapshot);

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
 * Query/export/import an exact FP64 single-grid LLG continuation checkpoint.
 *
 * These calls are explicit checkpoint boundaries and may perform synchronous
 * device/host transfers. Import is accepted only by a fresh, matching context.
 * The opaque payload includes the accepted magnetization and all integrator
 * history needed for bitwise continuation.
 */
int fullmag_fdm_backend_llg_checkpoint_query_size_v1(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes);

int fullmag_fdm_backend_llg_checkpoint_export_v1(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v1 *out_info);

int fullmag_fdm_backend_llg_checkpoint_import_v1(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v1 *expected_info);

int fullmag_fdm_backend_llg_checkpoint_query_size_v2(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes);

int fullmag_fdm_backend_llg_checkpoint_export_v2(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v2 *out_info);

int fullmag_fdm_backend_llg_checkpoint_import_v2(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v2 *expected_info);

int fullmag_fdm_backend_set_checkpoint_execution_identity_v3(
    fullmag_fdm_backend *handle,
    const fullmag_fdm_checkpoint_execution_identity_v3 *identity);

int fullmag_fdm_backend_get_workspace_dependency_identity_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_workspace_dependency_identity_v1 *out_identity);

int fullmag_fdm_backend_llg_checkpoint_query_size_v3(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes);

int fullmag_fdm_backend_llg_checkpoint_export_v3(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v3 *out_info);

int fullmag_fdm_backend_llg_checkpoint_import_v3(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v3 *expected_info);

int fullmag_fdm_backend_llg_checkpoint_query_size_v4(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes);

int fullmag_fdm_backend_llg_checkpoint_export_v4(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v4 *out_info);

int fullmag_fdm_backend_llg_checkpoint_import_v4(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v4 *expected_info);

/**
 * Replace one v2 multilayer layer magnetization from host-side f64 AoS storage.
 * This does not advance time; refresh native multilayer demag before copying
 * H_DEMAG for the uploaded state.
 */
int fullmag_fdm_backend_upload_layer_magnetization_f64(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    const double          *m_xyz,
    uint64_t               len);

/**
 * Replace one v2 multilayer layer magnetization from host-side f32 AoS storage.
 * This does not advance time; refresh native multilayer demag before copying
 * H_DEMAG for the uploaded state.
 */
int fullmag_fdm_backend_upload_layer_magnetization_f32(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    const float           *m_xyz,
    uint64_t               len);

/**
 * Recompute staged v2 multilayer H_DEMAG without taking a time step.
 *
 * This entrypoint is valid only for handles created with
 * fullmag_fdm_backend_create_v2.
 */
int fullmag_fdm_backend_refresh_multilayer_demag(
    fullmag_fdm_backend   *handle);

/**
 * Recompute observables for the current magnetization state without taking a
 * time step.
 */
int fullmag_fdm_backend_refresh_observables(
    fullmag_fdm_backend   *handle);

/**
 * Recompute only H_demag for the current magnetization state without taking a
 * time step.
 */
int fullmag_fdm_backend_refresh_demag_observable(
    fullmag_fdm_backend   *handle);

/**
 * Snapshot scalar diagnostics for the current state without advancing time.
 *
 * The backend recomputes derived observables first, then fills `out_stats`
 * using the current magnetization / field state and the current accumulated
 * step/time counters.
 */
int fullmag_fdm_backend_snapshot_stats(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_step_stats *out_stats);

/**
 * Query GPU device metadata.
 */
int fullmag_fdm_backend_get_device_info(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_device_info *out_info);

/** Query the execution and residency receipt owned by the created Context. */
int fullmag_fdm_backend_execution_receipt_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_execution_receipt_v1 *out_receipt);
int fullmag_fdm_backend_execution_receipt_v2(
    fullmag_fdm_backend *handle,
    fullmag_fdm_execution_receipt_v2 *out_receipt);

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

/* ── FDM CPU steady charge + one-way spin transport ABI v1 ── */

/*
 * Every non-null result pointer passed to the transport solve/destroy
 * entrypoints must reference at least the readable 8-byte ABI header
 * `{abi_version, struct_size}`.  The implementation reads that header with
 * memcpy and must not read or write any later field unless `struct_size`
 * declares the complete field.  Result storage shorter than the declared
 * `struct_size` remains a caller contract violation.
 */

#define FULLMAG_FDM_CPU_TRANSPORT_ABI_V1 1u
#define FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY 64u
#define FULLMAG_FDM_CPU_TRANSPORT_ERROR_CAPACITY 512u

typedef enum {
    FULLMAG_FDM_CPU_TRANSPORT_OK = 0,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL = -100,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI = -101,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID = -102,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_BUFFER = -103,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED = -104,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_CONVERGENCE = -105,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_BALANCE = -106,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_NUMERICAL = -107,
    FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL = -108,
} fullmag_fdm_cpu_transport_status_v1;

typedef enum {
    FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU = 1,
    FULLMAG_FDM_CPU_TRANSPORT_DEVICE_GPU = 2,
} fullmag_fdm_cpu_transport_device_v1;

typedef enum {
    FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F32 = 1,
    FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64 = 2,
} fullmag_fdm_cpu_transport_precision_v1;

typedef enum {
    FULLMAG_FDM_CPU_CHARGE_BC_UNSET = 0,
    FULLMAG_FDM_CPU_CHARGE_BC_INSULATING = 1,
    FULLMAG_FDM_CPU_CHARGE_BC_VOLTAGE = 2,
    FULLMAG_FDM_CPU_CHARGE_BC_TOTAL_CURRENT = 3,
    FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY = 4,
} fullmag_fdm_cpu_charge_boundary_kind_v1;

typedef enum {
    FULLMAG_FDM_CPU_CHARGE_GAUGE_NONE = 0,
    FULLMAG_FDM_CPU_CHARGE_GAUGE_ZERO_MEAN = 1,
} fullmag_fdm_cpu_charge_gauge_v1;

typedef enum {
    FULLMAG_FDM_CPU_SPIN_BC_UNSET = 0,
    FULLMAG_FDM_CPU_SPIN_BC_INSULATING = 1,
    FULLMAG_FDM_CPU_SPIN_BC_SINK = 2,
    FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_POTENTIAL = 3,
    FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_OUTWARD_FLUX = 4,
    FULLMAG_FDM_CPU_SPIN_BC_PERIODIC = 5,
} fullmag_fdm_cpu_spin_boundary_kind_v1;

typedef enum {
    FULLMAG_FDM_CPU_SPIN_INTERFACE_TRANSPARENT = 0,
    FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2 = 1,
    FULLMAG_FDM_CPU_SPIN_INTERFACE_SML_RESERVOIR_V2 = 2,
} fullmag_fdm_cpu_spin_interface_kind_v1;

typedef struct {
    uint64_t nx;
    uint64_t ny;
    uint64_t nz;
    double dx_m;
    double dy_m;
    double dz_m;
} fullmag_fdm_cpu_transport_grid_v1;

typedef struct {
    double *data;
    uint64_t capacity;
    uint64_t length;
} fullmag_fdm_cpu_f64_buffer_v1;

typedef struct {
    uint32_t kind;
    uint32_t reserved;
    double value;
} fullmag_fdm_cpu_charge_boundary_v1;

typedef struct {
    uint32_t kind;
    uint32_t reserved;
    double potential_v[3];
} fullmag_fdm_cpu_spin_boundary_v1;

typedef struct {
    uint32_t axis;
    int32_t outward_normal_sign;
    uint64_t face_index;
    uint64_t adjacent_cell;
    double area_m2;
    double outward_current_density_a_per_m2;
} fullmag_fdm_cpu_specified_current_face_v1;

typedef struct {
    uint64_t source_cut_index;
    uint32_t axis;
    int32_t normal_sign;
    uint64_t negative_cell;
    uint64_t positive_cell;
    double potential_jump_v;
} fullmag_fdm_cpu_impressed_potential_jump_face_v1;

typedef struct {
    uint64_t interface_id;
    uint32_t axis;
    uint32_t kind;
    uint64_t negative_cell;
    uint64_t positive_cell;
    uint64_t from_cell;
    uint64_t to_cell;
    double g_up_s_per_m2;
    double g_down_s_per_m2;
    double g_r_s_per_m2;
    double g_i_s_per_m2;
    double magnetization[3];
} fullmag_fdm_cpu_transport_interface_v1;

typedef struct {
    uint64_t interface_id;
    uint32_t axis;
    uint32_t reserved;
    uint64_t negative_cell;
    uint64_t positive_cell;
    uint64_t from_cell;
    uint64_t to_cell;
    double g_up_s_per_m2;
    double g_down_s_per_m2;
    double from_potential_trace_v;
    double to_potential_trace_v;
    double delta_potential_trace_v;
    double from_to_current_density_a_per_m2;
    double global_face_current_density_a_per_m2;
} fullmag_fdm_cpu_charge_interface_observation_v1;

typedef struct {
    fullmag_fdm_cpu_charge_interface_observation_v1 *data;
    uint64_t capacity;
    uint64_t length;
} fullmag_fdm_cpu_charge_interface_observation_buffer_v1;

typedef struct {
    uint64_t interface_id;
    uint32_t axis;
    uint32_t reserved;
    uint64_t negative_cell;
    uint64_t positive_cell;
    uint64_t from_cell;
    uint64_t to_cell;
    double incoming_longitudinal_a_per_m2[3];
    double backflow_longitudinal_a_per_m2[3];
    double absorbed_transverse_a_per_m2[3];
    double negative_cell_flux_positive_axis_a_per_m2[3];
    double positive_cell_flux_positive_axis_a_per_m2[3];
    double from_side_outgoing_a_per_m2[3];
    double to_side_transmitted_a_per_m2[3];
} fullmag_fdm_cpu_spin_interface_observation_v1;

typedef struct {
    fullmag_fdm_cpu_spin_interface_observation_v1 *data;
    uint64_t capacity;
    uint64_t length;
} fullmag_fdm_cpu_spin_interface_observation_buffer_v1;

typedef struct {
    double spin_flip_m;
    double exchange_m;
    double dephasing_m;
} fullmag_fdm_cpu_spin_reaction_lengths_v1;

typedef struct fullmag_fdm_cpu_charge_snapshot_v1
    fullmag_fdm_cpu_charge_snapshot_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    fullmag_fdm_cpu_transport_grid_v1 grid;
    uint32_t device;
    uint32_t precision;
    const double *conductivity_s_per_m;
    uint64_t conductivity_len;
    const uint8_t *active_cells;
    uint64_t active_cells_len;
    fullmag_fdm_cpu_charge_boundary_v1 boundaries[6];
    const fullmag_fdm_cpu_specified_current_face_v1 *specified_current_faces;
    uint64_t specified_current_face_count;
    const fullmag_fdm_cpu_transport_interface_v1 *interfaces;
    uint64_t interface_count;
    uint32_t gauge;
    uint32_t reserved0;
    double relative_tolerance;
    double absolute_tolerance_a_per_m3;
    uint64_t max_iterations;
    char api_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char solver_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char residual_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    const fullmag_fdm_cpu_impressed_potential_jump_face_v1
        *impressed_potential_jump_faces;
    uint64_t impressed_potential_jump_face_count;
} fullmag_fdm_cpu_charge_request_v1;

/*
 * Result storage is caller-owned, but `accepted_snapshot` is a unique native
 * owner after a successful solve.  Initialise the full v1 record with a null
 * handle before solve.  Do not bitwise-copy a successful result, and do not
 * call spin solve concurrently with destroy.  Destroy transfers the result
 * back to the empty state, clears both owner fields, and is idempotent for an
 * already-empty, full-size v1 result.  A result may be reused only after
 * destroy has completed.
 */
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    int32_t status;
    uint32_t reserved0;
    fullmag_fdm_cpu_f64_buffer_v1 potential_v;
    fullmag_fdm_cpu_f64_buffer_v1 jc_x_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 jc_y_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 jc_z_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 jc_cell_xyz_a_per_m2;
    fullmag_fdm_cpu_charge_interface_observation_buffer_v1 interface_observations;
    uint64_t iterations;
    double algebraic_residual_l2_a_per_m3;
    double recomputed_algebraic_residual_l2_a_per_m3;
    double physical_balance_integrated_l2_a;
    double max_cell_current_imbalance_a;
    double max_abs_divergence_a_per_m3;
    double boundary_outward_current_a[6];
    double net_boundary_current_a;
    uint64_t accepted_snapshot_identity;
    fullmag_fdm_cpu_charge_snapshot_v1 *accepted_snapshot;
    char api_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char interface_operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char solver_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char residual_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char runtime_owner[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char error_message[FULLMAG_FDM_CPU_TRANSPORT_ERROR_CAPACITY];
} fullmag_fdm_cpu_charge_result_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    fullmag_fdm_cpu_transport_grid_v1 grid;
    uint32_t device;
    uint32_t precision;
    const double *spin_conductivity_s_per_m;
    uint64_t spin_conductivity_len;
    const double *polarization;
    uint64_t polarization_len;
    const double *spin_hall_angle;
    uint64_t spin_hall_angle_len;
    const double *magnetization_xyz;
    uint64_t magnetization_xyz_len;
    const fullmag_fdm_cpu_spin_reaction_lengths_v1 *reactions;
    uint64_t reaction_count;
    const uint8_t *active_cells;
    uint64_t active_cells_len;
    const uint32_t *region_ids;
    uint64_t region_id_count;
    fullmag_fdm_cpu_spin_boundary_v1 boundaries[6];
    const fullmag_fdm_cpu_transport_interface_v1 *interfaces;
    uint64_t interface_count;
    const uint8_t *torque_target_cells;
    uint64_t torque_target_cells_len;
    const double *saturation_magnetization_a_per_m;
    uint64_t saturation_magnetization_len;
    double gamma_e_rad_per_s_t;
    double relative_tolerance;
    double absolute_tolerance_a;
    double local_relative_tolerance;
    double local_absolute_tolerance_a_per_m3;
    uint64_t max_iterations;
    uint64_t gmres_restart;
    char api_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char formula_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char electric_reconstruction_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char solver_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char residual_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char local_residual_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char interface_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char torque_operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
} fullmag_fdm_cpu_steady_spin_request_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    int32_t status;
    uint32_t reserved0;
    fullmag_fdm_cpu_f64_buffer_v1 spin_potential_xyz_v;
    fullmag_fdm_cpu_f64_buffer_v1 q_x_xyz_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 q_y_xyz_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 q_z_xyz_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 q_cell_ia_a_per_m2;
    fullmag_fdm_cpu_f64_buffer_v1 reaction_spin_flip_xyz_a_per_m3;
    fullmag_fdm_cpu_f64_buffer_v1 reaction_exchange_xyz_a_per_m3;
    fullmag_fdm_cpu_f64_buffer_v1 reaction_dephasing_xyz_a_per_m3;
    fullmag_fdm_cpu_f64_buffer_v1 reaction_total_xyz_a_per_m3;
    fullmag_fdm_cpu_f64_buffer_v1 transport_torque_xyz_per_s;
    fullmag_fdm_cpu_spin_interface_observation_buffer_v1 interface_observations;
    uint64_t iterations;
    uint64_t gmres_restart;
    double initial_rhs_integrated_l2_a;
    double recursive_residual_integrated_l2_a;
    double recomputed_balance_integrated_l2_a;
    double balance_tolerance_integrated_l2_a;
    double boundary_outward_current_a[18];
    double global_balance_closure_a[3];
    double relative_global_balance;
    double max_abs_residual_a_per_m3;
    char api_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char formula_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char electric_reconstruction_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char solver_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char residual_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char local_residual_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char interface_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char torque_operator_version[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char runtime_owner[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char convergence_reason[FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    char error_message[FULLMAG_FDM_CPU_TRANSPORT_ERROR_CAPACITY];
} fullmag_fdm_cpu_steady_spin_result_v1;

/* Read-only diagnostic manifest for exact C/Rust transport ABI verification. */
typedef struct {
    const char *field_name;
    uint64_t offset;
} fullmag_fdm_cpu_transport_abi_layout_field_v1;

typedef struct {
    const char *record_name;
    uint64_t size;
    uint64_t alignment;
    uint64_t field_count;
    const fullmag_fdm_cpu_transport_abi_layout_field_v1 *fields;
} fullmag_fdm_cpu_transport_abi_layout_record_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    uint64_t record_count;
    const fullmag_fdm_cpu_transport_abi_layout_record_v1 *records;
} fullmag_fdm_cpu_transport_abi_layout_manifest_v1;

int fullmag_fdm_cpu_transport_is_available_v1(void);
const fullmag_fdm_cpu_transport_abi_layout_manifest_v1 *
fullmag_fdm_cpu_transport_abi_layout_manifest_get_v1(void);
int fullmag_fdm_cpu_charge_solve_v1(
    const fullmag_fdm_cpu_charge_request_v1 *request,
    fullmag_fdm_cpu_charge_result_v1 *result);
int fullmag_fdm_cpu_steady_spin_solve_v1(
    const fullmag_fdm_cpu_steady_spin_request_v1 *request,
    const fullmag_fdm_cpu_charge_result_v1 *charge,
    fullmag_fdm_cpu_steady_spin_result_v1 *result);
/* See fullmag_fdm_cpu_charge_result_v1 ownership rules above. */
void fullmag_fdm_cpu_charge_result_destroy_v1(
    fullmag_fdm_cpu_charge_result_v1 *result);

/* ── FDM CPU/FP64 solved-current open-boundary Oersted ABI v1 ── */

#define FULLMAG_FDM_CPU_OERSTED_ABI_V1 1u
#define FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY 96u
#define FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY 80u
#define FULLMAG_FDM_CPU_OERSTED_ERROR_CAPACITY 512u

typedef enum {
    FULLMAG_FDM_CPU_OERSTED_OK = 0,
    FULLMAG_FDM_CPU_OERSTED_ERR_NULL = -200,
    FULLMAG_FDM_CPU_OERSTED_ERR_ABI = -201,
    FULLMAG_FDM_CPU_OERSTED_ERR_INVALID = -202,
    FULLMAG_FDM_CPU_OERSTED_ERR_BUFFER = -203,
    FULLMAG_FDM_CPU_OERSTED_ERR_PERIODIC = -204,
    FULLMAG_FDM_CPU_OERSTED_ERR_MISSING_CERTIFICATE = -205,
    FULLMAG_FDM_CPU_OERSTED_ERR_STALE_CERTIFICATE = -206,
    FULLMAG_FDM_CPU_OERSTED_ERR_OPEN_CIRCUIT = -207,
    FULLMAG_FDM_CPU_OERSTED_ERR_CLOSURE = -208,
    FULLMAG_FDM_CPU_OERSTED_ERR_NUMERICAL = -209,
    FULLMAG_FDM_CPU_OERSTED_ERR_INTERNAL = -210,
} fullmag_fdm_cpu_oersted_status_v1;

typedef enum {
    FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN = 0,
    FULLMAG_FDM_CPU_OERSTED_BOUNDARY_PERIODIC = 1,
} fullmag_fdm_cpu_oersted_boundary_v1;

typedef enum {
    FULLMAG_FDM_CPU_OERSTED_CLOSURE_CLOSED_GEOMETRY = 0,
    FULLMAG_FDM_CPU_OERSTED_CLOSURE_CERTIFIED_IMPORT = 1,
} fullmag_fdm_cpu_oersted_closure_kind_v1;

typedef struct {
    const double *data;
    uint64_t length;
} fullmag_fdm_cpu_oersted_const_f64_buffer_v1;

typedef struct {
    const uint64_t *data;
    uint64_t length;
} fullmag_fdm_cpu_oersted_const_u64_buffer_v1;

typedef struct {
    const int8_t *data;
    uint64_t length;
} fullmag_fdm_cpu_oersted_const_i8_buffer_v1;

typedef struct {
    const char *stable_id;
    uint64_t component_label;
    fullmag_fdm_cpu_oersted_const_u64_buffer_v1 ordered_internal_face_ids;
    fullmag_fdm_cpu_oersted_const_i8_buffer_v1 ordered_normals;
    const char *drive_id;
    const char *drive_kind;
    double drive_value;
    const char *drive_si_unit;
    uint64_t revision;
    const char *digest;
} fullmag_fdm_cpu_oersted_source_cut_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    uint32_t closure_kind;
    uint32_t global_continuity_passed;
    uint32_t exterior_flux_passed;
    uint32_t component_flux_passed;
    uint32_t return_path_complete;
    uint32_t reserved0;
    uint64_t revision;
    const char *version;
    const char *digest;
    const char *geometry_digest;
    uint64_t conductor_mask_revision;
    const char *conductor_mask_digest;
    uint64_t face_current_revision;
    const char *face_current_digest;
    fullmag_fdm_cpu_oersted_const_u64_buffer_v1 component_labels;
    uint64_t component_count;
    double divergence_tolerance_a_per_m3;
    double exterior_current_tolerance_a;
    double measured_max_abs_divergence_a_per_m3;
    fullmag_fdm_cpu_oersted_const_f64_buffer_v1 measured_component_exterior_current_a;
    const fullmag_fdm_cpu_oersted_source_cut_v1 *source_cuts;
    uint64_t source_cut_count;
    const char *imported_certification_method;
    const char *imported_field_digest;
} fullmag_fdm_cpu_oersted_certificate_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    fullmag_fdm_cpu_transport_grid_v1 grid;
    double origin_m[3];
    uint32_t boundaries[3];
    uint32_t reserved0;
    const uint8_t *conductor_mask;
    uint64_t conductor_mask_len;
    const uint8_t *target_mask;
    uint64_t target_mask_len;
    fullmag_fdm_cpu_oersted_const_f64_buffer_v1 jc_x_a_per_m2;
    fullmag_fdm_cpu_oersted_const_f64_buffer_v1 jc_y_a_per_m2;
    fullmag_fdm_cpu_oersted_const_f64_buffer_v1 jc_z_a_per_m2;
    uint64_t geometry_revision;
    const char *geometry_digest;
    uint64_t conductor_mask_revision;
    const char *conductor_mask_digest;
    uint64_t target_mask_revision;
    const char *target_mask_digest;
    uint64_t face_current_revision;
    const char *face_current_digest;
    const char *source_identity;
    uint64_t envelope_revision;
    const char *envelope_digest;
    uint64_t stage_identity;
    double evaluation_time_s;
    double evaluated_envelope_multiplier;
    uint64_t trusted_snapshot_revision;
    const char *trusted_snapshot_digest;
    const fullmag_fdm_cpu_oersted_certificate_v1 *certificate;
} fullmag_fdm_cpu_oersted_request_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    int32_t status;
    uint32_t reserved0;
    fullmag_fdm_cpu_f64_buffer_v1 field_xyz_a_per_m;
    uint64_t face_current_revision;
    uint64_t certificate_revision;
    uint64_t trusted_snapshot_revision;
    uint64_t envelope_revision;
    uint64_t stage_identity;
    double evaluation_time_s;
    double evaluated_envelope_multiplier;
    uint64_t plan_build_count;
    uint64_t kernel_build_count;
    uint64_t numerical_buffer_allocation_count;
    uint64_t resolved_field_hit_count;
    uint64_t resolved_field_miss_count;
    uint64_t resolved_field_invalidation_count;
    uint64_t trusted_fast_path_hit_count;
    uint32_t resolved_field_reused;
    uint32_t diagnostics_available;
    double divergence_current_rms_a_per_m3;
    double divergence_field_rms_a_per_m2;
    double curl_h_minus_j_rms_a_per_m2;
    char api_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char formula_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char reconstruction_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char operator_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char realization_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char engine_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char certificate_version[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char face_current_digest[FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY];
    char certificate_digest[FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY];
    char trusted_snapshot_digest[FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY];
    char resolved_field_cache_key_digest[FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY];
    char kernel_plan_cache_key_digest[FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY];
    char source_identity[FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY];
    char error_message[FULLMAG_FDM_CPU_OERSTED_ERROR_CAPACITY];
} fullmag_fdm_cpu_oersted_result_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t reserved_flags;
    uint64_t source_cut_size;
    uint64_t source_cut_alignment;
    uint64_t certificate_size;
    uint64_t certificate_alignment;
    uint64_t request_size;
    uint64_t request_alignment;
    uint64_t result_size;
    uint64_t result_alignment;
} fullmag_fdm_cpu_oersted_abi_layout_v1;

const fullmag_fdm_cpu_oersted_abi_layout_v1 *
fullmag_fdm_cpu_oersted_abi_layout_get_v1(void);
const fullmag_fdm_cpu_transport_abi_layout_manifest_v1 *
fullmag_fdm_cpu_oersted_abi_layout_manifest_get_v1(void);
int fullmag_fdm_cpu_oersted_solve_v1(
    const fullmag_fdm_cpu_oersted_request_v1 *request,
    fullmag_fdm_cpu_oersted_result_v1 *result);

#ifdef __cplusplus
}
#endif

#endif /* FULLMAG_FDM_H */
