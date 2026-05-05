#ifndef FULLMAG_FEM_H
#define FULLMAG_FEM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FULLMAG_FEM_OK 0
#define FULLMAG_FEM_ERR_INVALID -1
#define FULLMAG_FEM_ERR_UNAVAILABLE -2
#define FULLMAG_FEM_ERR_INTERNAL -3
#define FULLMAG_FEM_ERR_INTERRUPTED -4

typedef enum {
    FULLMAG_FEM_PRECISION_SINGLE = 1,
    FULLMAG_FEM_PRECISION_DOUBLE = 2,
} fullmag_fem_precision;

typedef enum {
    FULLMAG_FEM_INTEGRATOR_HEUN = 1,
    FULLMAG_FEM_INTEGRATOR_RK4 = 2,
    FULLMAG_FEM_INTEGRATOR_RK23_BS = 3,
    FULLMAG_FEM_INTEGRATOR_RK45_DP54 = 4,
} fullmag_fem_integrator;

typedef struct {
    double atol;
    double rtol;
    double dt_initial;
    double dt_min;
    double dt_max;
    double safety;
    double growth_limit;
    double shrink_limit;
} fullmag_fem_adaptive_config;

typedef enum {
    FULLMAG_FEM_OBSERVABLE_M = 1,
    FULLMAG_FEM_OBSERVABLE_H_EX = 2,
    FULLMAG_FEM_OBSERVABLE_H_DEMAG = 3,
    FULLMAG_FEM_OBSERVABLE_H_EXT = 4,
    FULLMAG_FEM_OBSERVABLE_H_EFF = 5,
    FULLMAG_FEM_OBSERVABLE_H_ANI = 6,
    FULLMAG_FEM_OBSERVABLE_H_DMI = 7,
    FULLMAG_FEM_OBSERVABLE_H_MEL = 8,
    // F-12: added observables for cubic anisotropy, bulk DMI, Oersted, thermal
    FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC = 9,
    FULLMAG_FEM_OBSERVABLE_H_DMI_BULK = 10,
    FULLMAG_FEM_OBSERVABLE_H_OE = 11,
    FULLMAG_FEM_OBSERVABLE_H_THERM = 12,
} fullmag_fem_observable;

typedef enum {
    FULLMAG_FEM_LINEAR_SOLVER_CG = 1,
    FULLMAG_FEM_LINEAR_SOLVER_GMRES = 2,
} fullmag_fem_linear_solver;

typedef enum {
    FULLMAG_FEM_PRECONDITIONER_NONE = 0,
    FULLMAG_FEM_PRECONDITIONER_JACOBI = 1,
    FULLMAG_FEM_PRECONDITIONER_AMG = 2,
} fullmag_fem_preconditioner;

typedef enum {
    FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET = 1,
    FULLMAG_FEM_DEMAG_AIRBOX_ROBIN     = 2,
} fullmag_fem_demag_realization;

typedef enum {
    FULLMAG_FEM_STAGE_STOP_REASON_TORQUE = 1,
    FULLMAG_FEM_STAGE_STOP_REASON_ENERGY = 2,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS = 3,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME = 4,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME = 5,
    FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED = 6,
    FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR = 7,
} fullmag_fem_stage_stop_reason;

typedef int (*fullmag_fem_interrupt_poll_fn)(void *user_data);

typedef struct {
    const double *nodes_xyz;
    uint32_t n_nodes;

    const uint32_t *elements;
    uint32_t n_elements;
    const uint32_t *element_markers;

    const uint32_t *boundary_faces;
    uint32_t n_boundary_faces;
    const uint32_t *boundary_markers;
} fullmag_fem_mesh_desc;

typedef struct {
    double saturation_magnetisation;
    double exchange_stiffness;
    double damping;
    double gyromagnetic_ratio;
} fullmag_fem_material_desc;

typedef struct {
    fullmag_fem_linear_solver solver;
    fullmag_fem_preconditioner preconditioner;
    double relative_tolerance;
    uint32_t max_iterations;
} fullmag_fem_solver_config;

typedef struct {
    int has_demag_interval_s;
    double demag_interval_s;
} fullmag_fem_field_refresh_policy;

typedef struct {
    int has_torque_tolerance_apm;
    double torque_tolerance_apm;
    int has_energy_tolerance_j;
    double energy_tolerance_j;
    int has_max_steps;
    uint64_t max_steps;
    int has_max_pseudotime_s;
    double max_pseudotime_s;
    int has_max_physical_time_s;
    double max_physical_time_s;
} fullmag_fem_relax_stop;

typedef struct {
    int has_reason;
    fullmag_fem_stage_stop_reason reason;
    int has_metric_name;
    char metric_name[64];
    double metric_value;
    double threshold;
} fullmag_fem_stage_completion;

typedef struct {
    fullmag_fem_mesh_desc mesh;
    fullmag_fem_material_desc material;
    uint32_t fe_order;
    double hmax;
    fullmag_fem_precision precision;
    fullmag_fem_integrator integrator;
    int enable_exchange;
    int enable_demag;
    int has_external_field;
    double external_field_am[3];
    fullmag_fem_solver_config demag_solver;
    double air_box_factor;
    fullmag_fem_demag_realization demag_realization;
    int poisson_boundary_marker;
    int robin_beta_mode;        /* 0=off(Dirichlet), 1=legacy(c=1), 2=dipole(c=2), 3=user */
    double robin_beta_factor;   /* user c in β = c/R* */
    const double *initial_magnetization_xyz;
    uint64_t initial_magnetization_len;
    double dt_seconds;
    const fullmag_fem_adaptive_config *adaptive_config;
    fullmag_fem_field_refresh_policy field_refresh;
    fullmag_fem_relax_stop relax_stop;
    int has_uniaxial_anisotropy;
    double uniaxial_anisotropy_constant;
    double uniaxial_anisotropy_k2;
    double anisotropy_axis[3];
    int has_interfacial_dmi;
    double dmi_constant;
    double dmi_interface_normal[3]; /* FND-009: interface normal for iDMI, default {0,0,1} */
    int has_bulk_dmi;
    double bulk_dmi_constant;
    int has_cubic_anisotropy;
    double cubic_kc1;
    double cubic_kc2;
    double cubic_kc3;
    double cubic_axis1[3];
    double cubic_axis2[3];
    /* Per-node spatially varying fields (NULL + 0 = uniform, use scalar). */
    const double *ms_field;           uint64_t ms_field_len;
    const double *a_field;            uint64_t a_field_len;
    const double *alpha_field;        uint64_t alpha_field_len;
    const double *ku_field;           uint64_t ku_field_len;
    const double *ku2_field;          uint64_t ku2_field_len;
    const double *dind_field;         uint64_t dind_field_len;
    const double *dbulk_field;        uint64_t dbulk_field_len;
    const double *kc1_field;          uint64_t kc1_field_len;
    const double *kc2_field;          uint64_t kc2_field_len;
    const double *kc3_field;          uint64_t kc3_field_len;

    /* Spin-transfer torque */
    int                        has_zhang_li_stt;
    int                        has_slonczewski_stt;
    double                     stt_current_density_am2[3];
    double                     stt_degree;
    double                     stt_beta;
    double                     stt_spin_polarization[3];
    double                     stt_lambda;
    double                     stt_epsilon_prime;
    double                     stt_free_layer_thickness; /* free layer thickness [m]; 0 = geometry-derived */

    /* Oersted field from cylindrical conductor */
    int                        has_oersted_cylinder;
    double                     oersted_current;
    double                     oersted_radius;
    double                     oersted_center[3];
    double                     oersted_axis[3];
    const double              *oersted_field_xyz;
    uint64_t                   oersted_field_len;
    uint32_t                   oersted_time_dep_kind;
    double                     oersted_time_dep_freq;
    double                     oersted_time_dep_phase;
    double                     oersted_time_dep_offset;
    double                     oersted_time_dep_t_on;
    double                     oersted_time_dep_t_off;

    /* Thermal noise */
    double                     temperature;            /* Temperature in K (0 = no thermal noise) */

    /* Magnetoelastic coupling (prescribed-strain mode) */
    int                        has_magnetoelastic;
    double                     mel_b1;                 /* First magnetoelastic coupling constant B₁ [Pa] */
    double                     mel_b2;                 /* Second magnetoelastic coupling constant B₂ [Pa] */
    int                        mel_uniform_strain;     /* 1 = uniform (6 doubles), 0 = per-node (6*n_nodes) */
    const double              *mel_strain_voigt;       /* Voigt strain [ε₁₁,ε₂₂,ε₃₃,2ε₂₃,2ε₁₃,2ε₁₂] */
    uint64_t                   mel_strain_len;         /* Length of strain array (6 or 6*n_nodes) */

    /* FEM-029: explicit GPU device index from plan (-1 = env / default) */
    int32_t                    gpu_device_index;
    /* Thermal noise seed (0 = system entropy) */
    uint64_t                   thermal_seed;
    /* FEM-030: explicit MFEM device string (null = env / compiled default) */
    const char                *mfem_device_string;
    /* FND-013: use consistent (full) mass matrix instead of lumped for exchange.
       0 = lumped (default), 1 = consistent (CG solve). */
    int                        use_consistent_mass;
} fullmag_fem_plan_desc;

typedef struct {
    uint64_t step;
    double time_seconds;
    double dt_seconds;
    double exchange_energy_joules;
    double demag_energy_joules;
    double external_energy_joules;
    double anisotropy_energy_joules;
    double dmi_energy_joules;
    double total_energy_joules;
    double magnetoelastic_energy_joules;
    double max_effective_field_amplitude;
    double max_demag_field_amplitude;
    double max_rhs_amplitude;
    double max_torque_Apm;                 /* max |m × H_eff|  (A/m) */
    uint32_t demag_linear_iterations;
    double demag_linear_residual;
    uint64_t wall_time_ns;
    uint64_t exchange_wall_time_ns;
    uint64_t demag_wall_time_ns;
    uint64_t rhs_wall_time_ns;
    uint64_t extra_energy_wall_time_ns;
    uint64_t snapshot_wall_time_ns;
    double error_estimate;
    uint32_t rejected_attempts;
    double dt_suggested;
    uint32_t rhs_evaluations;
    int fsal_reused;
    /* Thread provenance (filled from context each step) */
    int32_t requested_omp_threads;
    int32_t effective_omp_threads;
} fullmag_fem_step_stats;

typedef struct {
    char name[128];
    int is_gpu_enabled;
    int compute_capability_major;
    int compute_capability_minor;
    int driver_version;
    int runtime_version;
} fullmag_fem_device_info;

typedef struct {
    int available;
    int built_with_mfem_stack;
    int built_with_cuda_runtime;
    int built_with_ceed;
    int visible_cuda_device_count;
    int requested_gpu_index;
    int resolved_gpu_index;
    char reason[256];
} fullmag_fem_availability_info;

typedef struct fullmag_fem_backend fullmag_fem_backend;

int fullmag_fem_is_available(void);
int fullmag_fem_get_availability_info(fullmag_fem_availability_info *out_info);

fullmag_fem_backend *fullmag_fem_backend_create(
    const fullmag_fem_plan_desc *plan
);

int fullmag_fem_backend_step(
    fullmag_fem_backend *handle,
    double dt_seconds,
    fullmag_fem_step_stats *out_stats
);

int fullmag_fem_backend_set_interrupt_poll(
    fullmag_fem_backend *handle,
    fullmag_fem_interrupt_poll_fn poll_fn,
    void *user_data
);

int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len
);

int fullmag_fem_backend_upload_magnetization_f64(
    fullmag_fem_backend *handle,
    const double *m_xyz,
    uint64_t len
);

int fullmag_fem_backend_snapshot_stats(
    fullmag_fem_backend *handle,
    fullmag_fem_step_stats *out_stats
);

int fullmag_fem_backend_stage_completion(
    fullmag_fem_backend *handle,
    fullmag_fem_stage_completion *out_completion
);

int fullmag_fem_backend_get_device_info(
    fullmag_fem_backend *handle,
    fullmag_fem_device_info *out_info
);

int fullmag_fem_backend_upload_strain(
    fullmag_fem_backend *handle,
    const double *strain_voigt,
    uint64_t len,
    int uniform
);

const char *fullmag_fem_backend_last_error(fullmag_fem_backend *handle);

void fullmag_fem_backend_destroy(fullmag_fem_backend *handle);

/* ── GPU Dense Generalized Eigenvalue Solver (Etap A4) ────────────────────
 *
 * Solves the real symmetric generalized eigenproblem  K·x = λ·M·x  on the
 * GPU using cuSolverDN `cusolverDnDsygvd`.  Both K and M must be supplied
 * as packed, column-major, lower-triangular dense arrays of n×n doubles.
 *
 * On output, `out_eigenvalues` receives n eigenvalues in ascending order and
 * `out_eigenvectors` receives the corresponding eigenvectors stored as
 * column-major n×n matrix (column i = eigenvector i).
 *
 * When CUDA + cuSolver are not available at build time or at runtime this
 * function returns FULLMAG_FEM_ERR_UNAVAILABLE, filling `out_reason` with a
 * human-readable explanation (up to reason_len bytes including null terminator).
 *
 * Returns FULLMAG_FEM_OK on success, or a negative error code otherwise.
 */
typedef struct {
    const double *k_lower_col_major;  /* stiffness matrix, lower triangle, col-major, n*n doubles */
    const double *m_lower_col_major;  /* mass matrix,      lower triangle, col-major, n*n doubles */
    uint32_t      n;                  /* matrix dimension (number of active DOF) */
    uint32_t      n_eigenvalues;      /* how many eigenvalues/vectors to return (≤ n) */
    double       *out_eigenvalues;    /* caller-allocated, n_eigenvalues doubles    */
    double       *out_eigenvectors;   /* caller-allocated, n * n_eigenvalues doubles, col-major */
    char         *out_reason;         /* optional: human-readable error/warning, may be NULL */
    uint32_t      reason_len;         /* capacity of out_reason buffer (including null) */
} fullmag_fem_eigen_dense_desc;

int fullmag_fem_eigen_dense(fullmag_fem_eigen_dense_desc *desc);

#ifdef __cplusplus
}
#endif

#endif
