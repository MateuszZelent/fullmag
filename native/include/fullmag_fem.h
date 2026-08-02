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

typedef enum {
    FULLMAG_FEM_STT_FORMULA_LEGACY_FULLMAG_V0 = 0,
    /* Historical canonical evaluator; read-only provenance only. */
    FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V1 = 1,
    FULLMAG_FEM_STT_FORMULA_ZHANG_LI_V1 = 2,
    /* Corrected canonical Slonczewski evaluator (Omega_J uses hbar/e). */
    FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2 = 3,
} fullmag_fem_stt_formula_version;

typedef enum {
    FULLMAG_FEM_STT_REALIZATION_NONE = 0,
    FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_THIN_LAYER_V1 = 1,
    FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_INTERFACE_FLUX_V1 = 2,
} fullmag_fem_stt_realization_version;

typedef enum {
    FULLMAG_FEM_STT_OPERATOR_NONE = 0,
    FULLMAG_FEM_STT_OPERATOR_ZL_CENTRAL_REFERENCE_V1 = 1,
} fullmag_fem_stt_operator_version;

typedef struct {
    double atol;
    double rtol;
    double dt_initial;
    double dt_min;
    double dt_max;
    double safety;
    double growth_limit;
    double shrink_limit;
    uint32_t max_reject;
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
    FULLMAG_FEM_OBSERVABLE_TORQUE = 13,
    FULLMAG_FEM_OBSERVABLE_DEMAG_PHI = 14,
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
    FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER  = 3,
} fullmag_fem_demag_realization;

typedef enum {
    FULLMAG_FEM_STAGE_STOP_REASON_TORQUE = 1,
    FULLMAG_FEM_STAGE_STOP_REASON_ENERGY = 2,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS = 3,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME = 4,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME = 5,
    FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED = 6,
    FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR = 7,
    FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT = 8,
} fullmag_fem_stage_stop_reason;

typedef enum {
    FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB = 1,
    FULLMAG_FEM_RELAX_NONLINEAR_CG = 2,
    FULLMAG_FEM_RELAX_TANGENT_PLANE_IMPLICIT = 3,
} fullmag_fem_relax_algorithm;

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

    /* Static periodic node pairs as [node_a0,node_b0,node_a1,node_b1,...].
       Supported native CPU/MFEM static-reduction paths consume these to build
       periodic node classes for k=0 local operators, demag Poisson reduction,
       and static-periodic driven-response projection.  Unsupported lanes must
       reject them explicitly rather than silently treating seams as open. */
    const uint32_t *periodic_node_pairs;
    uint32_t n_periodic_node_pairs;

    /* MFEM boundary attribute markers for periodic seam face pairs,
       stored as [marker_a0, marker_b0, marker_a1, marker_b1, ...].
       Used to exclude periodic seam faces from Robin boundary mass
       when demag PBC is enabled.  Pass NULL / 0 when not applicable. */
    const uint32_t *periodic_boundary_pair_markers;
    uint32_t periodic_boundary_pair_count;
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
    int has_absolute_tolerance;
    double absolute_tolerance;
    uint32_t max_iterations;
    uint32_t print_level;
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
    const double *anisotropy_axis_x_field; uint64_t anisotropy_axis_x_field_len;
    const double *anisotropy_axis_y_field; uint64_t anisotropy_axis_y_field_len;
    const double *anisotropy_axis_z_field; uint64_t anisotropy_axis_z_field_len;
    const double *dind_field;         uint64_t dind_field_len;
    const double *dbulk_field;        uint64_t dbulk_field_len;
    const double *kc1_field;          uint64_t kc1_field_len;
    const double *kc2_field;          uint64_t kc2_field_len;
    const double *kc3_field;          uint64_t kc3_field_len;

    /* Per-element material coefficients for discontinuous conformal domains.
       NULL + 0 = use per-node field/scalar fallback. When present, length must
       equal mesh.n_elements. These fields preserve one shared H1 magnetization
       space while allowing discontinuous A/Ms coefficients across conformal
       internal domain boundaries. */
    const double *ms_element_field;    uint64_t ms_element_field_len;
    const double *a_element_field;     uint64_t a_element_field_len;

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
    double                     stt_current_sign;         /* +1 top, -1 bottom for Slonczewski */
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
    /* Strict FEM GPU demag policy. 0 = runner/default policy. */
    int                        gpu_demag_mode;
    /* FND-013: use consistent (full) mass matrix instead of lumped for exchange.
       0 = lumped (default), 1 = consistent (CG solve). */
    int                        use_consistent_mass;
    /* Compute initial effective field during backend creation.
       0 = lazy, 1 = eager (default for interactive/live paths). */
    int                        eager_initial_effective_field;
    /* Explicit LLG mode.
       has_precession_enabled=0 defaults to precessional mode for legacy ABI callers.
       precession_enabled=1 = full Gilbert LLG, 0 = pure damping relaxation. */
    int                        has_precession_enabled;
    int                        precession_enabled;

    /* Append-only versioned STT extension. Keep after the established plan prefix. */
    uint32_t                   stt_formula_version;
    uint32_t                   stt_realization_version;
    uint32_t                   stt_operator_version;
    double                     stt_stack_normal[3];
    double                     stt_lande_g;
    const uint8_t             *stt_active_node_mask;
    uint64_t                   stt_active_node_mask_len;
    const uint8_t             *stt_active_element_mask;
    uint64_t                   stt_active_element_mask_len;
} fullmag_fem_plan_desc;

/*
 * Standalone M1 steady charge/spin transport ABI.
 *
 * This is intentionally separate from fullmag_fem_plan_desc and Context: the
 * transport workflow owns its MFEM spaces, operators, fields and diagnostics.
 * Future revisions append fields after the v1 tails and bump abi_version.
 */
#define FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION 1u

typedef enum {
    FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE = 2,
} fullmag_fem_steady_transport_execution_lane;

typedef enum {
    FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1 = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1 = 2,
} fullmag_fem_steady_transport_interface_model;

typedef enum {
    FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL = 2,
} fullmag_fem_steady_transport_charge_gauge;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    fullmag_fem_steady_transport_execution_lane execution_lane;
    fullmag_fem_steady_transport_interface_model interface_model;
    fullmag_fem_steady_transport_charge_gauge charge_gauge;
    const char *constitutive_version;
    const char *operator_version;
    const char *physical_residual_version;
    fullmag_fem_mesh_desc mesh;
    const double *charge_conductivity_spm_per_element;
    uint64_t charge_conductivity_spm_per_element_len;
    const double *magnetization_xyz;
    uint64_t magnetization_xyz_len;
    double sigma_s_spm;
    double polarization_p;
    double theta_sh;
    double lambda_sf_m;
    int has_lambda_j;
    double lambda_j_m;
    int has_lambda_phi;
    double lambda_phi_m;
    double gamma_e_per_ts;
    double saturation_magnetization_apm;
    double relative_tolerance;
    double absolute_tolerance;
    uint32_t maximum_iterations;
    const uint32_t *charge_dirichlet_boundary_attributes;
    const double *charge_dirichlet_values_v;
    uint64_t charge_dirichlet_count;
    const uint32_t *spin_dirichlet_boundary_attributes;
    const double *spin_dirichlet_values_v;
    uint64_t spin_dirichlet_count;
} fullmag_fem_steady_transport_request_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    double *electric_potential_v;
    uint64_t electric_potential_v_len;
    double *charge_current_density_xyz_apm2;
    uint64_t charge_current_density_xyz_apm2_len;
    double *spin_potential_xyz_v;
    uint64_t spin_potential_xyz_v_len;
    double *spin_current_tensor_row_major_qia_apm2;
    uint64_t spin_current_tensor_row_major_qia_apm2_len;
    double *torque_xyz_per_s;
    uint64_t torque_xyz_len;
    int charge_converged;
    uint32_t charge_iterations;
    double charge_relative_residual;
    double net_boundary_current_a;
    double current_density_volume_average_apm2[3];
    int spin_converged;
    uint32_t spin_iterations;
    double spin_relative_residual;
    double boundary_spin_flux_a[3];
    double reaction_integral_a[3];
    double angular_momentum_balance_apm2[3];
    double torque_volume_average_per_s[3];
    double torque_l2_per_s;
    char error_message[256];
    char diagnostics_json[1024];
} fullmag_fem_steady_transport_result_v1;

typedef struct {
    uint64_t step;
    double time_seconds;
    double dt_seconds;
    double mx;
    double my;
    double mz;
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
    uint32_t demag_solve_count;
    uint32_t demag_linear_iterations;
    double demag_linear_residual;
    uint64_t wall_time_ns;
    uint64_t exchange_wall_time_ns;
    uint64_t demag_wall_time_ns;
    uint64_t demag_assemble_wall_time_ns;
    uint64_t demag_solve_wall_time_ns;
    uint64_t demag_solver_setup_wall_time_ns;
    uint64_t demag_solver_apply_wall_time_ns;
    int demag_solver_setup_reused;
    uint64_t demag_recover_wall_time_ns;
    uint64_t demag_energy_wall_time_ns;
    uint64_t rhs_wall_time_ns;
    uint64_t extra_energy_wall_time_ns;
    uint64_t snapshot_wall_time_ns;
    uint64_t relaxation_preconditioner_wall_time_ns;
    uint64_t relaxation_state_copy_wall_time_ns;
    uint64_t relaxation_state_upload_wall_time_ns;
    uint64_t relaxation_retraction_wall_time_ns;
    uint64_t relaxation_gradient_wall_time_ns;
    uint64_t relaxation_metric_wall_time_ns;
    uint64_t relaxation_line_search_wall_time_ns;
    uint64_t relaxation_update_wall_time_ns;
    uint32_t relaxation_preconditioner_cache_hits;
    uint32_t relaxation_preconditioner_cache_misses;
    double error_estimate;
    uint32_t rejected_attempts;
    double dt_suggested;
    uint32_t rhs_evaluations;
    int fsal_reused;
    /* Thread provenance (filled from context each step) */
    int32_t requested_omp_threads;
    int32_t effective_omp_threads;
    int32_t cpu_thread_cap_reason;
} fullmag_fem_step_stats;

typedef struct {
    char name[128];
    int is_gpu_enabled;
    int compute_capability_major;
    int compute_capability_minor;
    int driver_version;
    int runtime_version;
    uint64_t gpu_memory_free_bytes;
    uint64_t gpu_memory_total_bytes;
} fullmag_fem_device_info;

typedef struct {
    int available;
    int built_with_mfem_stack;
    int built_with_cuda_runtime;
    int built_with_ceed;
    int native_fem_cpu_available;
    int native_fem_gpu_available;
    int native_fem_gpu_full_demag_available;
    int mfem_cuda_available;
    int hypre_gpu_available;
    int libceed_used_hot_path;
    int visible_cuda_device_count;
    int requested_gpu_index;
    int resolved_gpu_index;
    uint64_t gpu_memory_free_bytes;
    uint64_t gpu_memory_total_bytes;
    char reason[256];
    int available_any;
    int available_cpu;
    int available_gpu;
    char reason_cpu[256];
    char reason_gpu[256];
} fullmag_fem_availability_info;

typedef enum {
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR = 2,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR = 3,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR = 4,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR = 5,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED = 6,
} fullmag_fem_frequency_domain_status;

typedef fullmag_fem_frequency_domain_status (*fullmag_fem_frequency_domain_apply_callback)(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]
);

typedef fullmag_fem_frequency_domain_status (*fullmag_fem_frequency_domain_complex_apply_callback)(
    void *user_data,
    const double *in_real,
    const double *in_imag,
    double *out_real,
    double *out_imag,
    char error_message[128]
);

typedef fullmag_fem_frequency_domain_status (*fullmag_fem_frequency_domain_apply_with_potential_callback)(
    void *user_data,
    const double *in,
    double *out,
    double *out_phi,
    uint64_t out_phi_len,
    char error_message[128]
);

typedef enum {
    FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_EIGENMODES = 2,
} fullmag_fem_frequency_domain_study_kind;

typedef enum {
    FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU = 2,
} fullmag_fem_frequency_domain_execution_lane;

typedef enum {
    FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T = 1,
} fullmag_fem_frequency_domain_phase_convention;

typedef enum {
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_DYNAMIC_FIELD_PHASOR_A_PER_M = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_TANGENT_RHS = 2,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_CARTESIAN_TORQUE_PHASOR = 3,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_STT_CURRENT_PHASOR = 4,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_COUPLED_EXTERNAL_PROVIDER = 5,
} fullmag_fem_frequency_domain_drive_kind;

typedef struct {
    fullmag_fem_frequency_domain_study_kind study_kind;
    int requires_driven_solver;
    int requires_modal_solver;
    int requires_static_periodic_boundary;
    int requires_floquet_boundary;
    int requires_nonzero_k_dynamic_demag;
    int requires_gpu;
    int strict_device;
    int has_floquet_k_vector;
    double floquet_k_vector_rad_per_m[3];
    fullmag_fem_frequency_domain_phase_convention phase_convention;
} fullmag_fem_frequency_domain_availability_request;

typedef struct {
    fullmag_fem_frequency_domain_status status;
    int driven_response_available;
    int modal_solver_available;
    int static_periodic_response_available;
    int floquet_modal_available;
    int floquet_response_available;
    int dynamic_demag_k_available;
    int gpu_available;
    char status_name[64];
    char study_kind_name[64];
    char reason[256];
    char diagnostics_json[512];
} fullmag_fem_frequency_domain_availability_info;

typedef struct {
    int petsc_available;
    int slepc_available;
    int modal_eigen_native_cpu_slepc_available;
    char petsc_version[64];
    char slepc_version[64];
    char petsc_pkgconfig_dir[256];
    char slepc_pkgconfig_dir[256];
    char petsc_find_module_file[256];
    char slepc_find_module_file[256];
    char petsc_library_path[256];
    char slepc_library_path[256];
    char reason[256];
    char diagnostics_json[1024];
} fullmag_fem_frequency_domain_dependency_info;

typedef struct {
    uint64_t total_frequency_points;
    uint64_t completed_frequency_points;
    uint64_t written_frequency_point_artifacts;
    double current_frequency_hz;
    int partial_artifacts_available;
    char latest_artifact_manifest_path[256];
    char progress_json[512];
} fullmag_fem_frequency_domain_sweep_progress;

typedef struct {
    uint64_t frequency_index;
    uint64_t completed_frequency_count;
    uint64_t total_frequency_count;
    uint64_t iteration_count;
    double frequency_hz;
    double residual_l2_norm;
    double relative_residual_l2_norm;
    int converged;
} fullmag_fem_frequency_domain_progress;

typedef struct {
    uint64_t node_i;
    uint64_t node_j;
    double stiffness;
} fullmag_fem_frequency_domain_exchange_edge;

typedef struct {
    uint64_t node_a;
    uint64_t node_b;
} fullmag_fem_frequency_domain_periodic_node_pair;

typedef struct {
    const char *pair_id;
    uint64_t node_a;
    uint64_t node_b;
    int has_translation;
    double translation_m[3];
    int has_phase;
    double phase_rad;
} fullmag_fem_frequency_domain_floquet_periodic_pair;

typedef enum {
    FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_INTERFACIAL = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK = 1,
} fullmag_fem_frequency_domain_dmi_kind;

typedef struct {
    fullmag_fem_frequency_domain_dmi_kind kind;
    uint32_t node_indices[4];
    double shape[4];
    double grad_shape[12]; /* flat [local_node][xyz] */
    double weight;
    double d;
    double normal[3];
} fullmag_fem_frequency_domain_dmi_element;

typedef struct {
    uint64_t node_count;
    uint64_t tangent_dof_count;
    double alpha;
    double gamma0;
    fullmag_fem_frequency_domain_execution_lane requested_execution_lane;
    const double *frequencies_hz;
    uint64_t frequency_count;
    const char *output_directory;
    int write_response_fields;
    int write_partial_artifacts;
    const char *operator_diagnostics_json;
    int (*cancel_requested)(void *user_data);
    void *cancel_user_data;
    void (*progress_callback)(void *user_data, const fullmag_fem_frequency_domain_progress *progress);
    void *progress_user_data;
    int tiny_validation_enabled;
    uint64_t tiny_validation_tangent_dof_count;
    const double *tiny_validation_stiffness_matrix_row_major;
    const double *tiny_validation_mass_matrix_row_major;
    const double *tiny_validation_stiffness_diagonal;
    const double *tiny_validation_mass_diagonal;
    const double *tiny_validation_drive_real;
    int mfem_operator_enabled;
    int mfem_include_zeeman;
    const double *mfem_equilibrium_m;
    const double *mfem_h_ext_a_per_m;
    const double *mfem_uniaxial_anisotropy_axis;
    double mfem_uniaxial_anisotropy_field_a_per_m;
    const double *mfem_alpha_per_node;
    const double *mfem_drive_real;
    const fullmag_fem_frequency_domain_exchange_edge *mfem_exchange_edges;
    uint64_t mfem_exchange_edge_count;
    const fullmag_fem_frequency_domain_dmi_element *mfem_dmi_elements;
    uint64_t mfem_dmi_element_count;
    const double *mfem_dmi_lumped_mass;
    const double *mfem_dmi_ms_field;
    double mfem_dmi_uniform_ms;
    const double *tiny_validation_drive_imag;
    const double *mfem_drive_imag;
    const fullmag_fem_frequency_domain_periodic_node_pair *mfem_static_periodic_node_pairs;
    uint64_t mfem_static_periodic_node_pair_count;
    int has_floquet_k_vector;
    double floquet_k_vector_rad_per_m[3];
    fullmag_fem_frequency_domain_phase_convention phase_convention;
    fullmag_fem_frequency_domain_drive_kind drive_kind;
    int require_nonzero_rhs;
    const fullmag_fem_frequency_domain_floquet_periodic_pair *mfem_floquet_periodic_pairs;
    uint64_t mfem_floquet_periodic_pair_count;
    int requires_periodic_airbox_dynamic_demag;
    int requires_floquet_airbox_dynamic_demag;
    uint64_t magnetic_periodic_constraint_set_count;
    uint64_t magnetostatic_periodic_constraint_set_count;
    uint64_t periodic_airbox_delta_m_tangent_dof_count;
    uint64_t periodic_airbox_delta_phi_dof_count;
    const fullmag_fem_frequency_domain_periodic_node_pair *periodic_airbox_magnetostatic_periodic_node_pairs;
    uint64_t periodic_airbox_magnetostatic_periodic_node_pair_count;
    int periodic_airbox_coupled_block_enabled;
    uint64_t periodic_airbox_coupled_block_delta_m_tangent_dof_count;
    uint64_t periodic_airbox_coupled_block_delta_phi_dof_count;
    const double *periodic_airbox_coupled_block_stiffness_matrix_row_major;
    const double *periodic_airbox_coupled_block_mass_matrix_row_major;
    fullmag_fem_frequency_domain_apply_callback periodic_airbox_coupled_block_apply_stiffness;
    fullmag_fem_frequency_domain_apply_callback periodic_airbox_coupled_block_apply_mass;
    fullmag_fem_frequency_domain_complex_apply_callback periodic_airbox_coupled_block_apply_complex_stiffness;
    fullmag_fem_frequency_domain_complex_apply_callback periodic_airbox_coupled_block_apply_complex_mass;
    void *periodic_airbox_coupled_block_operator_user_data;
    const double *periodic_airbox_coupled_block_drive_real;
    const double *periodic_airbox_coupled_block_drive_imag;
    fullmag_fem_frequency_domain_apply_callback mfem_apply_demag_tangent;
    void *mfem_demag_tangent_user_data;
    const double *mfem_demag_tangent_matrix_row_major;
    const double *mfem_observable_ms_field;
    uint64_t mfem_observable_ms_field_len;
    double mfem_observable_uniform_ms;
    uint32_t abi_version;
    uint32_t reserved_contract_flags;
    uint64_t struct_size;
    double solver_relative_tolerance;
    double solver_absolute_tolerance;
    uint64_t solver_max_iterations;
    uint64_t solver_restart_iterations;
    uint64_t solver_progress_interval_iterations;
    uint64_t tiny_validation_stiffness_matrix_value_count;
    uint64_t tiny_validation_mass_matrix_value_count;
    uint64_t tiny_validation_stiffness_diagonal_value_count;
    uint64_t tiny_validation_mass_diagonal_value_count;
    uint64_t tiny_validation_drive_real_value_count;
    uint64_t tiny_validation_drive_imag_value_count;
    uint64_t mfem_equilibrium_m_value_count;
    uint64_t mfem_h_ext_value_count;
    uint64_t mfem_uniaxial_anisotropy_axis_value_count;
    uint64_t mfem_alpha_value_count;
    uint64_t mfem_drive_real_value_count;
    uint64_t mfem_drive_imag_value_count;
    uint64_t mfem_dmi_lumped_mass_value_count;
    uint64_t mfem_dmi_ms_field_value_count;
    uint64_t mfem_demag_tangent_matrix_value_count;
    uint64_t periodic_airbox_coupled_block_stiffness_matrix_value_count;
    uint64_t periodic_airbox_coupled_block_mass_matrix_value_count;
    uint64_t periodic_airbox_coupled_block_drive_real_value_count;
    uint64_t periodic_airbox_coupled_block_drive_imag_value_count;
} fullmag_fem_frequency_domain_driven_response_request;

typedef struct {
    fullmag_fem_frequency_domain_status status;
    uint64_t total_frequency_count;
    uint64_t completed_frequency_count;
    uint64_t written_frequency_point_artifacts;
    char *error_message;
    char *diagnostics_json;
    char *result_json;
    char *artifact_manifest_path;
} fullmag_fem_frequency_domain_solve_result;

#define FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION 12u

typedef enum {
    FULLMAG_FEM_FD_OK = 0,
    FULLMAG_FEM_FD_UNAVAILABLE = 1,
    FULLMAG_FEM_FD_VALIDATION_ERROR = 2,
    FULLMAG_FEM_FD_OPERATOR_ERROR = 3,
    FULLMAG_FEM_FD_SOLVE_ERROR = 4,
    FULLMAG_FEM_FD_ARTIFACT_ERROR = 5,
    FULLMAG_FEM_FD_INTERRUPTED = 6,
} FullmagFemFrequencyDomainStatus;

typedef struct {
    uint32_t abi_version;
    const char *mesh_asset_id;
    const char *equilibrium_source_kind;
    double gamma_rad_s_T;
    double mu0_T_m_A;
    double alpha;
    int include_exchange;
    int include_demag;
    const char *demag_realization;
    const char *damping_policy;
    const char *spin_wave_bc_kind;
    const double *k_vector_rad_m;
    int k_vector_len;
    const char *operator_diagnostics_json;
} FullmagFemLinearizedOperatorRequest;

typedef struct {
    uint64_t row_count;
    uint64_t column_count;
    const uint32_t *row_offsets;
    uint64_t row_offsets_len;
    const uint32_t *column_indices;
    uint64_t column_indices_len;
    const double *values;
    uint64_t values_len;
} FullmagFemCsrMatrixView;

typedef struct {
    uint32_t abi_version;
    FullmagFemLinearizedOperatorRequest operator_request;
    int requested_mode_count;
    const char *target_kind;
    double target_frequency_hz;
    double frequency_min_hz;
    double frequency_max_hz;
    double residual_tolerance;
    int max_outer_iterations;
    int max_linear_iterations;
    const char *output_directory;
    int write_partial_artifacts;
    int completeness_policy;
    int eigensolver_family;
    int spectral_transform_kind;
    void *cancel_user_data;
    int (*cancel_requested)(void *user_data);
    void *progress_user_data;
    void (*progress_callback)(void *user_data, const char *progress_json);
    int tiny_validation_enabled;
    uint64_t tiny_validation_tangent_dof_count;
    const double *tiny_validation_stiffness_matrix_row_major;
    const double *tiny_validation_mass_matrix_row_major;
    const double *tiny_validation_stiffness_diagonal;
    const double *tiny_validation_mass_diagonal;
    int mfem_operator_enabled;
    uint64_t mfem_tangent_dof_count;
    const double *mfem_stiffness_matrix_row_major;
    const double *mfem_gyrotropic_matrix_row_major;
    const double *mfem_mass_matrix_row_major;
    const char *mfem_linearized_pencil_dependency_digest;
    double mfem_linearized_pencil_gamma0_m_per_a_s;
    int mfem_sparse_operator_enabled;
    FullmagFemCsrMatrixView mfem_sparse_stiffness_csr;
    FullmagFemCsrMatrixView mfem_sparse_gyrotropic_csr;
    FullmagFemCsrMatrixView mfem_sparse_mass_csr;
    int has_floquet_k_vector;
    double floquet_k_vector_rad_per_m[3];
    fullmag_fem_frequency_domain_phase_convention phase_convention;
    const fullmag_fem_frequency_domain_floquet_periodic_pair *mfem_floquet_periodic_pairs;
    uint64_t mfem_floquet_periodic_pair_count;
    int poisson_airbox_block_enabled;
    uint64_t poisson_airbox_q_dof_count;
    uint64_t poisson_airbox_phi_dof_count;
    FullmagFemCsrMatrixView poisson_airbox_a_qq_csr;
    FullmagFemCsrMatrixView poisson_airbox_a_qphi_csr;
    FullmagFemCsrMatrixView poisson_airbox_a_phiq_csr;
    FullmagFemCsrMatrixView poisson_airbox_a_phiphi_csr;
    FullmagFemCsrMatrixView poisson_airbox_b_qq_csr;
    const double *poisson_airbox_phi_mean_weights;
    uint64_t poisson_airbox_phi_mean_weights_count;
    double poisson_airbox_target_frequency_hz;
    double poisson_airbox_expected_reference_frequency_hz;
    const char *poisson_airbox_periodic_mesh_certificate_schema;
    uint64_t poisson_airbox_magnetic_pair_count;
    uint64_t poisson_airbox_airbox_pair_count;
    int poisson_airbox_shift_invert_action_enabled;
    int poisson_airbox_shift_invert_action_device;
    double poisson_airbox_shift_sigma_real;
    double poisson_airbox_shift_sigma_imag;
    const double *poisson_airbox_shift_action_vector_real;
    const double *poisson_airbox_shift_action_vector_imag;
    uint64_t poisson_airbox_shift_action_vector_count;
    const char *poisson_airbox_outer_boundary_kind;
    double poisson_airbox_robin_beta;
    const char *poisson_airbox_gauge_policy;
    const char *poisson_airbox_gauge_reason;
    const char *poisson_airbox_assembly_kind;
    const double *dynamic_demag_k_tangent_matrix_row_major;
    uint64_t dynamic_demag_k_tangent_matrix_value_count;
} FullmagFemModalEigenRequest;

typedef struct {
    uint32_t abi_version;
    FullmagFemLinearizedOperatorRequest operator_request;
    const double *frequencies_hz;
    int frequency_count;
    const double *excitation_field_A_m;
    int excitation_field_len;
    double excitation_phase_rad;
    double residual_tolerance;
    int max_linear_iterations;
    const char *output_directory;
    int write_partial_artifacts;
    void *cancel_user_data;
    int (*cancel_requested)(void *user_data);
    void *progress_user_data;
    void (*progress_callback)(void *user_data, const char *progress_json);
} FullmagFemDrivenResponseRequest;

typedef struct {
    uint32_t abi_version;
    FullmagFemFrequencyDomainStatus status;
    char *error_message;
    char *diagnostics_json;
    char *result_json;
    char *artifact_manifest_path;
} FullmagFemFrequencyDomainResult;

typedef struct {
    uint64_t availability_request_size;
    uint64_t availability_request_phase_convention_offset;
    uint64_t availability_info_size;
    uint64_t availability_info_diagnostics_json_offset;
    uint64_t dependency_info_size;
    uint64_t dependency_info_modal_eigen_native_cpu_slepc_available_offset;
    uint64_t dependency_info_diagnostics_json_offset;
    uint64_t sweep_progress_size;
    uint64_t sweep_progress_progress_json_offset;
    uint64_t progress_size;
    uint64_t progress_converged_offset;
    uint64_t exchange_edge_size;
    uint64_t exchange_edge_stiffness_offset;
    uint64_t periodic_node_pair_size;
    uint64_t periodic_node_pair_node_b_offset;
    uint64_t floquet_periodic_pair_size;
    uint64_t floquet_periodic_pair_phase_rad_offset;
    uint64_t dmi_element_size;
    uint64_t dmi_element_normal_offset;
    uint64_t driven_response_request_size;
    uint64_t driven_response_request_abi_version_offset;
    uint64_t driven_response_request_struct_size_offset;
    uint64_t driven_response_request_requested_execution_lane_offset;
    uint64_t driven_response_request_progress_callback_offset;
    uint64_t driven_response_request_tiny_validation_drive_imag_offset;
    uint64_t driven_response_request_phase_convention_offset;
    uint64_t driven_response_request_drive_kind_offset;
    uint64_t driven_response_request_require_nonzero_rhs_offset;
    uint64_t driven_response_request_mfem_floquet_periodic_pair_count_offset;
    uint64_t driven_response_request_periodic_airbox_magnetostatic_periodic_node_pairs_offset;
    uint64_t driven_response_request_periodic_airbox_coupled_block_enabled_offset;
    uint64_t driven_response_request_periodic_airbox_coupled_block_apply_stiffness_offset;
    uint64_t driven_response_request_periodic_airbox_coupled_block_apply_complex_stiffness_offset;
    uint64_t driven_response_request_periodic_airbox_coupled_block_operator_user_data_offset;
    uint64_t driven_response_request_mfem_apply_demag_tangent_offset;
    uint64_t driven_response_request_mfem_demag_tangent_user_data_offset;
    uint64_t driven_response_request_mfem_demag_tangent_matrix_row_major_offset;
    uint64_t driven_response_request_solver_relative_tolerance_offset;
    uint64_t driven_response_request_solver_absolute_tolerance_offset;
    uint64_t driven_response_request_solver_max_iterations_offset;
    uint64_t driven_response_request_solver_restart_iterations_offset;
    uint64_t driven_response_request_solver_progress_interval_iterations_offset;
    uint64_t driven_response_request_tiny_validation_drive_real_value_count_offset;
    uint64_t driven_response_request_mfem_equilibrium_m_value_count_offset;
    uint64_t driven_response_request_mfem_drive_real_value_count_offset;
    uint64_t driven_response_request_periodic_airbox_coupled_block_drive_real_value_count_offset;
    uint64_t solve_result_size;
    uint64_t solve_result_artifact_manifest_path_offset;
} fullmag_fem_frequency_domain_abi_layout;

typedef struct {
    uint64_t h2d_bytes;
    uint64_t d2h_bytes;
    uint64_t host_read_count;
    uint64_t host_write_count;
    uint64_t host_read_write_count;
    uint64_t hot_loop_h2d_bytes;
    uint64_t hot_loop_d2h_bytes;
    uint64_t hot_loop_host_read_count;
    uint64_t hot_loop_host_write_count;
    uint64_t hot_loop_host_read_write_count;
    uint64_t hot_loop_host_sync_count;
    uint64_t hot_loop_exchange_h2d_bytes;
    uint64_t hot_loop_exchange_d2h_bytes;
    uint64_t hot_loop_exchange_host_sync_count;
    uint64_t hot_loop_compute_h2d_bytes;
    uint64_t hot_loop_compute_d2h_bytes;
    uint64_t hot_loop_compute_host_sync_count;
    uint64_t hot_loop_control_scalar_d2h_bytes;
    uint64_t hot_loop_control_scalar_host_sync_count;
} fullmag_fem_transfer_audit;

typedef enum {
    FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH = 0,
    FULLMAG_FEM_RESIDENCY_MIXED = 1,
    FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH = 2,
} fullmag_fem_data_residency;

typedef enum {
    FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED = 0,
    FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON = 1,
    FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON = 2,
} fullmag_fem_gpu_demag_mode;

typedef struct {
    int allocated;
    uint64_t node_count;
    uint64_t dof_len;
    uint32_t stage_count;
    uint64_t device_bytes;
    uint64_t reduction_workspace_bytes;
    fullmag_fem_data_residency source_of_truth;
} fullmag_fem_gpu_state_info;

typedef struct {
    /* Legacy ABI name for device-resident GPU RK eligibility. */
    int exchange_only_enabled;
    uint32_t stage_count;
    int uses_cuda_kernels;
    int allows_exchange_host_sync;
    int stage_exchange_device_resident;
    int uses_gpu_poisson;
    char exchange_operator_mode[64];
    char demag_operator_mode[64];
    char hypre_execution_policy[32];
    char demag_residency[32];
    char reason[256];
} fullmag_fem_gpu_rk_plan_info;

typedef struct fullmag_fem_backend fullmag_fem_backend;
typedef struct fullmag_fem_field_snapshot fullmag_fem_field_snapshot;
typedef struct fullmag_fem_preview_snapshot fullmag_fem_preview_snapshot;

typedef enum {
    FULLMAG_FEM_SNAPSHOT_SCALAR_F64 = 2,
} fullmag_fem_snapshot_scalar_type;

typedef struct {
    uint64_t node_count;
    uint32_t component_count;
    uint32_t scalar_bytes;
    fullmag_fem_snapshot_scalar_type scalar_type;
} fullmag_fem_snapshot_desc;

int fullmag_fem_is_available(void);
int fullmag_fem_solve_steady_transport_v1(
    const fullmag_fem_steady_transport_request_v1 *request,
    fullmag_fem_steady_transport_result_v1 *result
);
int fullmag_fem_get_availability_info(fullmag_fem_availability_info *out_info);
int fullmag_fem_get_frequency_domain_availability_info(
    const fullmag_fem_frequency_domain_availability_request *request,
    fullmag_fem_frequency_domain_availability_info *out_info
);
int fullmag_fem_get_frequency_domain_dependency_info(
    fullmag_fem_frequency_domain_dependency_info *out_info
);
int fullmag_fem_get_frequency_domain_abi_layout(
    fullmag_fem_frequency_domain_abi_layout *out_layout
);
int fullmag_fem_frequency_domain_initial_sweep_progress(
    uint64_t total_frequency_points,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
);
int fullmag_fem_frequency_domain_interrupted_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
);
int fullmag_fem_frequency_domain_cancelling_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
);
int fullmag_fem_frequency_domain_completed_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
);
int fullmag_fem_frequency_domain_solve_driven_response(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_solve_result *out_result
);
int fullmag_fem_frequency_domain_solve_driven_response_v9(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_apply_with_potential_callback mfem_apply_demag_tangent_with_potential,
    fullmag_fem_frequency_domain_solve_result *out_result
);
int fullmag_fem_frequency_domain_solve_driven_response_v10(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_apply_with_potential_callback mfem_apply_demag_tangent_with_potential,
    fullmag_fem_frequency_domain_solve_result *out_result
);
void fullmag_fem_frequency_domain_solve_result_release(
    fullmag_fem_frequency_domain_solve_result *result
);
FullmagFemFrequencyDomainResult fullmag_fem_modal_eigen_solve(
    const FullmagFemModalEigenRequest *request
);
FullmagFemFrequencyDomainResult fullmag_fem_driven_response_solve(
    const FullmagFemDrivenResponseRequest *request
);
void fullmag_fem_frequency_domain_result_destroy(
    FullmagFemFrequencyDomainResult *result
);

fullmag_fem_backend *fullmag_fem_backend_create(
    const fullmag_fem_plan_desc *plan
);

int fullmag_fem_backend_step(
    fullmag_fem_backend *handle,
    double dt_seconds,
    fullmag_fem_step_stats *out_stats
);

int fullmag_fem_backend_relax_step(
    fullmag_fem_backend *handle,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats *out_stats
);

int fullmag_fem_backend_set_interrupt_poll(
    fullmag_fem_backend *handle,
    fullmag_fem_interrupt_poll_fn poll_fn,
    void *user_data
);

int fullmag_fem_backend_set_step_profile(
    fullmag_fem_backend *handle,
    int enabled
);

int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len
);

int fullmag_fem_backend_average_m_for_nodes_f64(
    fullmag_fem_backend *handle,
    const uint32_t *node_indices,
    uint64_t node_count,
    double *out_xyz,
    uint64_t out_len
);

/*
 * Begin a native FEM field snapshot.
 *
 * GPU-backed observables are staged through private device buffers and pinned
 * host memory on a snapshot stream before `wait` exposes an AoS f64 payload:
 *   [x0,y0,z0, x1,y1,z1, ...]
 *
 * CPU-only or host-only observables fall back to the synchronous host field
 * copy path while preserving the same payload layout.
 */
fullmag_fem_field_snapshot *fullmag_fem_backend_begin_field_snapshot(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable
);

/*
 * Begin a native FEM preview snapshot.
 *
 * FEM previews currently expose the full mesh-node vector payload in the same
 * AoS f64 layout as field snapshots. GPU-backed observables use the same
 * private staging/pinned-host path as field snapshots.
 */
fullmag_fem_preview_snapshot *fullmag_fem_backend_begin_preview_snapshot(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable
);

/*
 * Wait for a native FEM field snapshot and expose the owned payload pointer.
 * The returned pointer remains valid until the snapshot handle is destroyed.
 */
int fullmag_fem_field_snapshot_wait(
    fullmag_fem_field_snapshot *snapshot,
    const void **out_data,
    uint64_t *out_len_bytes,
    fullmag_fem_snapshot_desc *out_desc
);

/*
 * Wait for a native FEM preview snapshot and expose the owned payload pointer.
 * The returned pointer remains valid until the snapshot handle is destroyed.
 */
int fullmag_fem_preview_snapshot_wait(
    fullmag_fem_preview_snapshot *snapshot,
    const void **out_data,
    uint64_t *out_len_bytes,
    fullmag_fem_snapshot_desc *out_desc
);

/*
 * Return nonzero when a native FEM preview snapshot can be consumed without
 * blocking in `fullmag_fem_preview_snapshot_wait`.
 */
int fullmag_fem_preview_snapshot_ready(fullmag_fem_preview_snapshot *snapshot);

/*
 * Return nonzero when a native FEM field snapshot can be consumed without
 * blocking in `fullmag_fem_field_snapshot_wait`.
 */
int fullmag_fem_field_snapshot_ready(fullmag_fem_field_snapshot *snapshot);

void fullmag_fem_field_snapshot_destroy(fullmag_fem_field_snapshot *snapshot);
void fullmag_fem_preview_snapshot_destroy(fullmag_fem_preview_snapshot *snapshot);

int fullmag_fem_backend_upload_magnetization_f64(
    fullmag_fem_backend *handle,
    const double *m_xyz,
    uint64_t len
);

/*
 * Apply the native demag tangent operator to the supplied tangent
 * magnetization field.
 *
 * The returned AoS field is the direct fresh demag solve:
 *   H_demag(delta_m)
 *
 * This entrypoint is intended for frequency-domain matrix-free providers. It
 * uses the backend's fresh demag solver path rather than frozen-field cache
 * reuse.
 */
int fullmag_fem_backend_apply_demag_tangent_f64(
    fullmag_fem_backend *handle,
    const double *delta_m_xyz,
    uint64_t delta_m_len,
    double *out_delta_h_demag_xyz,
    uint64_t out_len
);

int fullmag_fem_backend_apply_demag_tangent_with_potential_f64(
    fullmag_fem_backend *handle,
    const double *delta_m_xyz,
    uint64_t delta_m_len,
    double *out_delta_h_demag_xyz,
    uint64_t out_len,
    double *out_delta_phi,
    uint64_t out_phi_len
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

int fullmag_fem_backend_get_transfer_audit(
    fullmag_fem_backend *handle,
    fullmag_fem_transfer_audit *out_audit
);

int fullmag_fem_backend_get_gpu_state_info(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_state_info *out_info
);

int fullmag_fem_backend_get_gpu_rk_plan_info(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_rk_plan_info *out_info
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
