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

#define FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION 2u

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
    FULLMAG_FEM_HOST_THREAD_POLICY_NONE = 0,
    FULLMAG_FEM_HOST_THREAD_POLICY_EXTERNAL_AUTO_RESOLVED = 1,
    FULLMAG_FEM_HOST_THREAD_POLICY_SMALL_MESH = 2,
    FULLMAG_FEM_HOST_THREAD_POLICY_MEDIUM_MESH = 3,
    FULLMAG_FEM_HOST_THREAD_POLICY_GPU_DEFAULT_ONE = 4,
    FULLMAG_FEM_HOST_THREAD_POLICY_AUTO_UNCAPPED = 5,
} fullmag_fem_host_thread_policy_reason;

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

typedef enum {
    FULLMAG_FEM_SOT_FORMULA_NONE = 0,
    FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1 = 1,
} fullmag_fem_sot_formula_version;

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

#define FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION 2u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    fullmag_fem_adaptive_config base;
    int has_max_spin_rotation;
    double max_spin_rotation;
    int has_norm_tolerance;
    double norm_tolerance;
} fullmag_fem_adaptive_config_v2;

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
    FULLMAG_FEM_OBSERVABLE_H_DRIVE = 15,
} fullmag_fem_observable;

typedef enum {
    FULLMAG_FEM_TIME_CONSTANT = 0,
    FULLMAG_FEM_TIME_SINUSOIDAL = 1,
    FULLMAG_FEM_TIME_PULSE = 2,
    FULLMAG_FEM_TIME_PIECEWISE_LINEAR = 3,
    FULLMAG_FEM_TIME_SINC_PULSE = 4,
} fullmag_fem_time_dependence_kind;

typedef enum {
    FULLMAG_FEM_TIME_STAGE_LOCAL = 0,
    FULLMAG_FEM_TIME_ABSOLUTE = 1,
} fullmag_fem_time_origin;

typedef enum {
    FULLMAG_FEM_FIELD_TARGET_GLOBAL = 0,
    FULLMAG_FEM_FIELD_TARGET_ELEMENT_MARKERS = 1,
} fullmag_fem_field_target_kind;

typedef enum {
    FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM = 0,
    FULLMAG_FEM_SPATIAL_PROFILE_SINC = 1,
    FULLMAG_FEM_SPATIAL_PROFILE_GEOMETRY_MASK = 2,
    FULLMAG_FEM_SPATIAL_PROFILE_GAUSSIAN_PLANE_WAVE = 3,
} fullmag_fem_spatial_profile_kind;

typedef enum {
    FULLMAG_FEM_SPATIAL_WINDOW_NONE = 0,
    FULLMAG_FEM_SPATIAL_WINDOW_HANN = 1,
} fullmag_fem_spatial_window_kind;

typedef enum {
    FULLMAG_FEM_GEOMETRY_BOX = 1,
    FULLMAG_FEM_GEOMETRY_CYLINDER = 2,
    FULLMAG_FEM_GEOMETRY_TRANSLATE = 3,
    FULLMAG_FEM_GEOMETRY_DIFFERENCE = 4,
    FULLMAG_FEM_GEOMETRY_UNION = 5,
    FULLMAG_FEM_GEOMETRY_INTERSECTION = 6,
} fullmag_fem_geometry_mask_kind;

typedef struct {
    double time_s;
    double value;
} fullmag_fem_time_point;

typedef struct {
    double frequency_hz;
    double phase_rad;
    double offset;
} fullmag_fem_sinusoidal_time_desc;

typedef struct {
    double t_on_s;
    double t_off_s;
} fullmag_fem_pulse_time_desc;

typedef struct {
    double cutoff_hz;
    double t0_s;
    double amplitude;
} fullmag_fem_sinc_pulse_time_desc;

typedef union {
    fullmag_fem_sinusoidal_time_desc sinusoidal;
    fullmag_fem_pulse_time_desc pulse;
    fullmag_fem_sinc_pulse_time_desc sinc_pulse;
} fullmag_fem_time_dependence_parameters;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t kind;
    fullmag_fem_time_dependence_parameters parameters;
    const fullmag_fem_time_point *points;
    uint64_t point_count;
} fullmag_fem_time_dependence_desc;

/*
 * Append-only prescribed-SOT envelope descriptor.  Unlike the regional-field
 * waveform, this descriptor carries the dimensionless amplitude explicitly so
 * all canonical TimeEnvelopeIR variants retain their SI multiplier semantics.
 * The envelope is evaluated at the RK stage time; time_origin is retained for
 * the ABI so direct C callers can request stage-local evaluation explicitly.
 */
#define FULLMAG_FEM_SOT_ENVELOPE_ABI_VERSION 1u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t kind;
    uint32_t time_origin;
    double amplitude;
    double frequency_hz;
    double phase_rad;
    double offset;
    double t_on_s;
    double t_off_s;
    double center_s;
    double bandwidth_hz;
    const fullmag_fem_time_point *points;
    uint64_t point_count;
} fullmag_fem_sot_envelope_desc;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t kind;
    const uint32_t *element_markers;
    uint64_t element_marker_count;
} fullmag_fem_field_target_desc;

typedef struct {
    uint32_t kind;
    uint32_t child_a;
    uint32_t child_b;
    double center_m[3];
    double size_m[3];
    double axis[3];
    double radius_m;
    double height_m;
    double translation_m[3];
} fullmag_fem_geometry_mask_node;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    const fullmag_fem_geometry_mask_node *nodes;
    uint64_t node_count;
    uint32_t root_index;
} fullmag_fem_geometry_mask_desc;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t kind;
    double sinc_axis[3];
    double sinc_period_m;
    double sinc_center_m;
    double sinc_width_m;
    uint32_t sinc_window;
    const fullmag_fem_geometry_mask_desc *geometry_mask;
    double gaussian_center_x_m;
    double gaussian_center_y_m;
    double gaussian_carrier_origin_x_m;
    double gaussian_sigma_x_m;
    double gaussian_sigma_y_m;
    double gaussian_wavelength_m;
    double gaussian_carrier_phase_rad;
} fullmag_fem_spatial_profile_desc;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t stable_id_hash;
    fullmag_fem_field_target_desc target;
    fullmag_fem_spatial_profile_desc spatial_profile;
    double amplitude_b_t;
    double direction[3];
    fullmag_fem_time_dependence_desc waveform;
    uint32_t time_origin;
} fullmag_fem_regional_field_drive_desc;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t time_dependence_desc_size;
    uint64_t field_target_desc_size;
    uint64_t spatial_profile_desc_size;
    uint64_t regional_field_drive_desc_size;
    uint64_t plan_desc_size;
    uint64_t plan_regional_field_drives_offset;
    uint64_t plan_regional_field_drive_count_offset;
    uint64_t plan_stage_start_time_s_offset;
    uint64_t step_stats_size;
    uint64_t step_stats_drive_energy_joules_offset;
    uint64_t step_stats_rk_transaction_capture_host_wall_time_ns_offset;
    uint64_t step_stats_demag_hypre_timed_solve_count_offset;
} fullmag_fem_regional_field_drive_abi_layout;

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

/*
 * Append-only native CPU RK hook for a magnetization-dependent Oersted
 * source.  The callback is deliberately independent of the v1 plan and step
 * ABI: it receives the exact stage magnetization and time, returns a complete
 * nodal H_oe field in A/m, and may maintain a transactional solved-current
 * cache through the optional attempt hooks.  GPU execution rejects this hook
 * until a device-resident implementation is qualified.
 */
#define FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ABI_VERSION 1u
#define FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ERROR_CAPACITY 256u

typedef int (*fullmag_fem_stage_oersted_evaluate_fn)(
    void *user_data,
    const double *m_xyz,
    uint64_t m_xyz_len,
    double evaluation_time_s,
    uint64_t stage_identity,
    double *out_h_xyz_apm,
    uint64_t out_h_xyz_len,
    uint64_t *out_source_state_revision,
    char *error_message,
    uint64_t error_message_capacity);

typedef int (*fullmag_fem_stage_oersted_attempt_fn)(
    void *user_data,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    char *error_message,
    uint64_t error_message_capacity);

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    void *user_data;
    fullmag_fem_stage_oersted_evaluate_fn evaluate;
    fullmag_fem_stage_oersted_attempt_fn begin_attempt;
    fullmag_fem_stage_oersted_attempt_fn commit_attempt;
    fullmag_fem_stage_oersted_attempt_fn rollback_attempt;
} fullmag_fem_stage_oersted_callback_v1;

/* Append-only native CPU RK hook for a reciprocal charge--spin solve.  The
 * callback receives the exact stage magnetization and returns a direct LLG
 * torque in 1/s.  The torque is added to the native RHS after the standard
 * LLG, STT and SOT terms; GPU execution rejects this hook until a
 * device-resident implementation is qualified. */
#define FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ABI_VERSION 1u
#define FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ERROR_CAPACITY 256u

typedef int (*fullmag_fem_stage_transport_evaluate_fn)(
    void *user_data,
    const double *m_xyz,
    uint64_t m_xyz_len,
    double evaluation_time_s,
    uint64_t stage_identity,
    double *out_torque_xyz_per_s,
    uint64_t out_torque_xyz_len,
    uint64_t *out_source_state_revision,
    char *error_message,
    uint64_t error_message_capacity);

typedef int (*fullmag_fem_stage_transport_attempt_fn)(
    void *user_data,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    char *error_message,
    uint64_t error_message_capacity);

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    void *user_data;
    fullmag_fem_stage_transport_evaluate_fn evaluate;
    fullmag_fem_stage_transport_attempt_fn begin_attempt;
    fullmag_fem_stage_transport_attempt_fn commit_attempt;
    fullmag_fem_stage_transport_attempt_fn rollback_attempt;
} fullmag_fem_stage_transport_callback_v1;

/* Canonical typed P1 mesh descriptor. Wire values are stable ABI, not Gmsh IDs. */
#define FULLMAG_FEM_MESH_DESC_ABI_VERSION 2u
#define FULLMAG_FEM_MESH_DESC_ABI_LAYOUT_FINGERPRINT \
    "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals"

#define FULLMAG_FEM_CELL_TET4 1u
#define FULLMAG_FEM_CELL_PRISM6 2u
#define FULLMAG_FEM_CELL_PYRAMID5 3u
#define FULLMAG_FEM_CELL_HEX8 4u

#define FULLMAG_FEM_FACET_TRI3 1u
#define FULLMAG_FEM_FACET_QUAD4 2u

#define FULLMAG_FEM_FACET_ROLE_EXTERIOR 1u
#define FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE 2u
#define FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM 3u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;

    const double *nodes_xyz;
    uint64_t nodes_xyz_len;

    const uint32_t *cell_types;
    uint64_t cell_types_len;
    const uint32_t *cell_offsets;
    uint64_t cell_offsets_len;
    const uint32_t *cell_nodes;
    uint64_t cell_nodes_len;
    const uint64_t *cell_global_ordinals;
    uint64_t cell_global_ordinals_len;
    const uint32_t *cell_markers;
    uint64_t cell_markers_len;

    const uint32_t *facet_types;
    uint64_t facet_types_len;
    const uint32_t *facet_roles;
    uint64_t facet_roles_len;
    const uint32_t *facet_offsets;
    uint64_t facet_offsets_len;
    const uint32_t *facet_nodes;
    uint64_t facet_nodes_len;
    const uint64_t *facet_global_ordinals;
    uint64_t facet_global_ordinals_len;
    const uint32_t *facet_markers;
    uint64_t facet_markers_len;

    /* Static periodic node pairs as [node_a0,node_b0,node_a1,node_b1,...].
       Supported native CPU/MFEM static-reduction paths consume these to build
       periodic node classes for k=0 local operators, demag Poisson reduction,
       and static-periodic driven-response projection.  Unsupported lanes must
       reject them explicitly rather than silently treating seams as open. */
    const uint32_t *periodic_node_pairs;
    uint64_t periodic_node_pairs_len;

    /* MFEM boundary attribute markers for periodic seam face pairs,
       stored as [marker_a0, marker_b0, marker_a1, marker_b1, ...].
       Used to exclude periodic seam faces from Robin boundary mass
       when demag PBC is enabled.  Pass NULL / 0 when not applicable. */
    const uint32_t *periodic_boundary_pair_markers;
    uint64_t periodic_boundary_pair_markers_len;
} fullmag_fem_mesh_desc;

#define FULLMAG_FEM_MESH_ABI_LAYOUT_VERSION 1u
#define FULLMAG_FEM_MESH_ABI_FIELD_COUNT 30u
#define FULLMAG_FEM_MESH_ABI_FINGERPRINT_CAPACITY 96u
#define FULLMAG_FEM_MESH_ABI_RECORD_VERSION 1u
#define FULLMAG_FEM_MESH_ABI_RECORD_MAGIC_CAPACITY 40u
#define FULLMAG_FEM_MESH_ABI_RECORD_MAGIC "FULLMAG_FEM_MESH_ABI_RECORD_V1"
#define FULLMAG_FEM_MESH_ABI_RECORD_ENDIAN_TAG 0x01020304u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t mesh_desc_abi_version;
    uint32_t mesh_desc_struct_size;
    uint32_t field_count;
    uint32_t reserved;
    uint64_t field_offsets[FULLMAG_FEM_MESH_ABI_FIELD_COUNT];
    char layout_fingerprint[FULLMAG_FEM_MESH_ABI_FINGERPRINT_CAPACITY];
} fullmag_fem_mesh_abi_layout;

typedef struct {
    char magic[FULLMAG_FEM_MESH_ABI_RECORD_MAGIC_CAPACITY];
    uint32_t record_version;
    uint32_t record_size;
    uint32_t endian_tag;
    uint32_t reserved;
    fullmag_fem_mesh_abi_layout layout;
} fullmag_fem_mesh_abi_record;

extern const fullmag_fem_mesh_abi_record fullmag_fem_mesh_abi_record_v1;

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
    uint32_t relaxation_controller_policy_version;
    uint32_t torque_confirmation_samples_required;
    uint32_t torque_confirmation_samples_current;
    uint64_t energy_rejected_attempts;
    uint64_t controller_tightening_count;
    int controller_at_floor;
    double energy_increase_relative_tolerance;
    double energy_increase_absolute_tolerance_j;
    double controller_tightening_factor;
    double max_error_floor;
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
       equal mesh.cell_types_len. These fields preserve one shared H1 magnetization
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

    /* Time-aware regional field drives. These fields are part of the
       established plan ABI prefix and must remain before later extensions. */
    const fullmag_fem_regional_field_drive_desc *regional_field_drives;
    uint64_t                   regional_field_drive_count;
    double                     stage_start_time_s;

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

    /* Append-only prescribed spin-orbit torque extension. */
    int                        has_prescribed_sot;
    uint32_t                   sot_formula_version;
    double                     sot_current_density_am2;
    double                     sot_xi_dl;
    double                     sot_xi_fl;
    double                     sot_thickness;
    double                     sot_envelope_value;
    double                     sot_sigma[3];
    const uint8_t             *sot_active_node_mask;
    uint64_t                   sot_active_node_mask_len;
    /* Append-only stage-time envelope extension. */
    fullmag_fem_sot_envelope_desc sot_envelope;

    /* Append-only frozen-spins descriptor. The native FEM runtime must either
       consume both arrays as one activation snapshot or fail closed. */
    const uint8_t *frozen_mask;
    uint64_t frozen_mask_len;
    const double *frozen_reference_xyz;
    uint64_t frozen_reference_len;
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

/*
 * Bounded reciprocal M2 reference lane.  The v1 M1 request above is kept
 * byte-for-byte stable; this wrapper is a separate symbol and carries the
 * same mesh/BC/result contract plus the symmetric charge conductivities and
 * anomalous-Hall coefficient required by the Onsager block.
 */
#define FULLMAG_FEM_STEADY_TRANSPORT_M2_ABI_VERSION 1u
typedef struct {
    fullmag_fem_steady_transport_request_v1 base;
    double sigma_parallel_spm;
    double sigma_perpendicular_spm;
    double sigma_ahe_spm;
} fullmag_fem_steady_transport_m2_request_v1;

/*
 * Append-only solved-current extension for the conservative FEM Oersted
 * source.  The legacy M1/M2 request/result structs above are intentionally
 * not extended: their nodal H1/P1 current remains a visualization/reference
 * projection and can never be reinterpreted as an RT0/H(div) field.
 */
#define FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION 1u
#define FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_LAYOUT_FINGERPRINT \
    "fullmag:fem-steady-transport-rt0:abi:v1:closure-identity-records"
#define FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY 96u
#define FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY 65u

typedef enum {
    FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_CLOSED_GEOMETRY = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_EXTERNAL_LEAD = 2,
} fullmag_fem_steady_transport_rt0_closure_kind;

typedef enum {
    FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_INSULATING_OUTER = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_SOURCE_CUT = 2,
    FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_CLOSURE_INTERFACE = 3,
} fullmag_fem_steady_transport_rt0_boundary_role;

typedef struct {
    uint64_t minus_face_vertex_ids[3];
    uint64_t plus_face_vertex_ids[3];
} fullmag_fem_steady_transport_rt0_source_cut_face_pair_v1;

typedef struct {
    const char *id;
    double translation_m[3];
    double potential_drop_v;
    const fullmag_fem_steady_transport_rt0_source_cut_face_pair_v1 *face_pairs;
    uint64_t face_pair_count;
} fullmag_fem_steady_transport_rt0_source_cut_v1;

typedef struct {
    uint64_t face_vertex_ids[3];
    uint32_t role;
    const char *circuit_id;
} fullmag_fem_steady_transport_rt0_boundary_face_v1;

typedef struct {
    const char *version;
    const uint64_t *local_to_stable_vertex_ids;
    uint64_t local_to_stable_vertex_ids_len;
} fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1;

typedef struct {
    const char *source_module_id;
    const char *source_state_revision;
    const char *source_field_digest;
    const char *conductivity_digest;
    const char *mesh_revision;
    const char *topology_revision;
    const char *geometry_digest;
    const char *envelope_revision;
    const char *envelope_digest;
    double evaluated_envelope_multiplier;
    double evaluation_time_s;
    uint64_t stage_identity;
} fullmag_fem_steady_transport_rt0_identity_v1;

typedef struct {
    const char *operator_version;
    const char *revision;
    const char *digest;
    const fullmag_fem_steady_transport_rt0_source_cut_v1 *source_cuts;
    uint64_t source_cut_count;
} fullmag_fem_steady_transport_rt0_closed_geometry_closure_v1;

typedef struct {
    uint64_t transport_face_vertex_ids[3];
    uint64_t lead_face_vertex_ids[3];
} fullmag_fem_steady_transport_rt0_interface_pair_v1;

typedef struct {
    const char *operator_version;
    const char *revision;
    const char *digest;
    const char *drive_id;
    double outer_electrode_potential_drop_v;
    fullmag_fem_mesh_desc lead_mesh;
    const double *lead_conductivity_spm_per_element;
    uint64_t lead_conductivity_spm_per_element_len;
    fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1
        lead_stable_vertex_identities;
    const fullmag_fem_steady_transport_rt0_interface_pair_v1 *interface_pairs;
    uint64_t interface_pair_count;
    const uint64_t *minus_outer_electrode_face_vertex_ids;
    uint64_t minus_outer_electrode_face_count;
    const uint64_t *plus_outer_electrode_face_vertex_ids;
    uint64_t plus_outer_electrode_face_count;
    const char *lead_conductivity_digest;
} fullmag_fem_steady_transport_rt0_external_lead_closure_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    fullmag_fem_steady_transport_request_v1 base;
    uint32_t closure_kind;
    uint32_t reserved_closure;
    fullmag_fem_steady_transport_rt0_identity_v1 identity;
    fullmag_fem_steady_transport_rt0_identity_v1 pins;
    fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1
        stable_vertex_identities;
    const fullmag_fem_steady_transport_rt0_boundary_face_v1 *boundary_faces;
    uint64_t boundary_face_count;
    const fullmag_fem_steady_transport_rt0_closed_geometry_closure_v1
        *closed_geometry;
    const fullmag_fem_steady_transport_rt0_external_lead_closure_v1
        *external_lead;
    double algebraic_relative_tolerance;
    double physical_relative_gate;
    double physical_absolute_gate_a;
    int reference_mpi_gather_broadcast;
} fullmag_fem_steady_transport_rt0_request_v1;

typedef struct {
    uint64_t face_vertex_ids[3];
    double flux_a;
} fullmag_fem_steady_transport_rt0_face_flux_record_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    double *rt0_dof_values;
    uint64_t rt0_dof_values_capacity;
    uint64_t rt0_dof_values_len;
    fullmag_fem_steady_transport_rt0_face_flux_record_v1 *canonical_face_records;
    uint64_t canonical_face_records_capacity;
    uint64_t canonical_face_records_len;
    int converged;
    double max_element_divergence_a;
    double max_internal_face_jump_a;
    double net_outer_flux_a;
    double electrode_balance_relative;
    double max_closure_interface_mismatch_a;
    double scaled_kkt_residual;
    double correction_norm_mw;
    char operator_version[FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY];
    char fe_space[32];
    char flux_unit[16];
    char canonical_face_digest[FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY];
    char balance_certificate_digest[FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY];
    char view_identity_digest[FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY];
    char error_message[256];
    char diagnostics_json[1024];
} fullmag_fem_steady_transport_rt0_result_v1;

/* Direct OE-F1 evaluation on the exact immutable RT0 view produced by the
 * closure-aware transport extension.  This is a new symbol; the RT0 result
 * above remains byte-for-byte stable. */
#define FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION 1u
typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    fullmag_fem_steady_transport_rt0_request_v1 rt0;
    const double *target_points_xyz;
    uint64_t target_points_xyz_len;
    int32_t base_quadrature_order;
    int32_t maximum_subdivision_depth;
    double absolute_tolerance_apm;
    double relative_tolerance;
    uint64_t maximum_source_target_pairs;
} fullmag_fem_steady_transport_rt0_oersted_request_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    fullmag_fem_steady_transport_rt0_result_v1 rt0;
    double *h_xyz_apm;
    uint64_t h_xyz_apm_capacity;
    uint64_t h_xyz_apm_len;
    uint64_t source_target_pairs;
    uint64_t refined_pairs;
    uint64_t unconverged_pair_count;
    double maximum_pair_error_apm;
    char operator_version[FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY];
    char source_view_identity_digest[FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY];
    char error_message[256];
    char diagnostics_json[1024];
} fullmag_fem_steady_transport_rt0_oersted_result_v1;

/* Mixed H(curl) x H1 OE-F2 evaluation on the exact immutable RT0 view.  This
 * is an append-only wrapper: the nested RT0 request/result and all legacy
 * transport layouts remain byte-for-byte stable. */
#define FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_VECTOR_POTENTIAL_ABI_VERSION 1u
typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    fullmag_fem_steady_transport_rt0_request_v1 rt0;
    double mu0_si;
    double relative_tolerance;
    int32_t maximum_nd_dofs;
    int32_t maximum_h1_dofs;
    const char *boundary_gauge_variant;
} fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    fullmag_fem_steady_transport_rt0_result_v1 rt0;
    double *a_dofs_t_m;
    uint64_t a_dofs_t_m_capacity;
    uint64_t a_dofs_t_m_len;
    double *gauge_dofs_apm;
    uint64_t gauge_dofs_apm_capacity;
    uint64_t gauge_dofs_apm_len;
    double *compatible_b_dofs_t;
    uint64_t compatible_b_dofs_t_capacity;
    uint64_t compatible_b_dofs_t_len;
    double *compatible_h_dofs_apm;
    uint64_t compatible_h_dofs_apm_capacity;
    uint64_t compatible_h_dofs_apm_len;
    int converged;
    int32_t harmonic_count;
    int32_t essential_nd_dof_count;
    int32_t essential_h1_dof_count;
    double first_block_residual;
    double constraint_residual;
    double weak_ampere_residual;
    double compatible_divergence_residual;
    double source_pairing_norm;
    char operator_version[FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY];
    char source_view_identity_digest[FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY];
    char boundary_gauge_variant[64];
    char error_message[256];
    char diagnostics_json[1024];
    /* AoS-3 continuous H1 projection for the nodal LLG field. */
    double *nodal_h_xyz_apm;
    uint64_t nodal_h_xyz_apm_capacity;
    uint64_t nodal_h_xyz_apm_len;
} fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t reserved_flags;
    uint64_t struct_size;
    double *electric_potential_v;
    uint64_t electric_potential_v_len;
    /*
     * This is an H1/P1 nodal visualization/reference projection. It is not a conservative RT0/H(div) current view and must not be consumed by a
     * production solved-current Oersted operator. The immutable
     * ConservativeCurrentView requires a separate closure-aware ABI.
     */
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
    double drive_energy_joules;
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
    /* fullmag_fem_host_thread_policy_reason; field name retained for ABI stability. */
    int32_t cpu_thread_cap_reason;
    /* Effective native BoomerAMG policy, including optional override presence. */
    int32_t demag_amg_relax_type;
    int32_t demag_amg_coarsening;
    int32_t demag_amg_interpolation;
    int32_t demag_amg_aggressive_coarsening;
    double demag_amg_strength_threshold;
    int32_t demag_amg_strength_threshold_is_set;
    int32_t demag_amg_max_levels;
    int32_t demag_amg_max_levels_is_set;
    /* Optional profiler-only RK transaction telemetry. */
    uint64_t rk_transaction_capture_host_wall_time_ns;
    uint64_t rk_transaction_capture_device_elapsed_time_ns;
    uint64_t rk_transaction_capture_bytes;
    uint64_t rk_transaction_restore_host_wall_time_ns;
    uint64_t rk_transaction_restore_device_elapsed_time_ns;
    uint64_t rk_transaction_restore_bytes;
    uint64_t rk_transaction_rollback_count;
    uint64_t rk_transaction_commit_count;
    /* Optional profiler-only HYPRE stream timing telemetry. */
    uint64_t demag_hypre_wait_in_enqueue_wall_time_ns;
    uint64_t demag_hypre_host_api_wall_time_ns;
    uint64_t demag_hypre_device_elapsed_time_ns;
    uint64_t demag_hypre_wait_out_enqueue_wall_time_ns;
    uint64_t demag_hypre_event_wait_count;
    uint64_t demag_hypre_timed_solve_count;
    /* Resolved Poisson demag provenance; energies are in J. */
    int32_t demag_potential_order;
    uint64_t demag_potential_true_dof_count;
    double demag_variational_energy_joules;
    double demag_recovered_field_energy_joules;
    /* Append-only CPU RK minimal-journal performance telemetry. */
    uint64_t rk_transaction_cpu_snapshot_allocation_count;
    uint64_t rk_transaction_peak_rss_bytes;
} fullmag_fem_step_stats;

/*
 * Versioned CPU explicit-RK accepted-endpoint cache telemetry.  This is an
 * additive query rather than an extension of fullmag_fem_step_stats so older
 * callers never receive writes past the struct they allocated.
 */
#define FULLMAG_FEM_ENDPOINT_CACHE_TELEMETRY_V1_ABI_VERSION 1u

typedef enum {
    FULLMAG_FEM_ENDPOINT_REFRESH_NOT_EVALUATED = 0,
    FULLMAG_FEM_ENDPOINT_REFRESH_CACHE_HIT = 1,
    FULLMAG_FEM_ENDPOINT_REFRESH_NON_FSAL_TABLEAU = 2,
    FULLMAG_FEM_ENDPOINT_REFRESH_CANDIDATE_STATE_MISMATCH = 3,
    FULLMAG_FEM_ENDPOINT_REFRESH_ENDPOINT_TIME_MISMATCH = 4,
    FULLMAG_FEM_ENDPOINT_REFRESH_DYNAMIC_SOURCE_CHANGED = 5,
    FULLMAG_FEM_ENDPOINT_REFRESH_TRANSPORT_SOURCE_CHANGED = 6,
    FULLMAG_FEM_ENDPOINT_REFRESH_PROJECTION_MISMATCH = 7,
    FULLMAG_FEM_ENDPOINT_REFRESH_CACHE_UNAVAILABLE = 8,
} fullmag_fem_endpoint_refresh_reason;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t final_rhs_evaluations;
    uint64_t extra_poisson_solves;
    uint64_t endpoint_cache_hits;
    uint64_t endpoint_refreshes;
    uint64_t accepted_step_wall_time_ns;
    uint32_t available;
    uint32_t final_refresh_reason;
    uint32_t cache_state_valid;
    uint32_t cache_time_valid;
    uint32_t cache_dynamic_sources_valid;
    uint32_t cache_transport_valid;
    uint32_t cache_projection_valid;
} fullmag_fem_endpoint_cache_telemetry_v1;

#define FULLMAG_FEM_REPRESENTATION_RECEIPT_V1_ABI_VERSION 1u

typedef enum {
    FULLMAG_FEM_REPRESENTATION_SPACE_LOCAL_NODE_AOS = 1,
} fullmag_fem_representation_space;

typedef enum {
    FULLMAG_FEM_MATERIAL_LOCATION_SCALAR = 1,
    FULLMAG_FEM_MATERIAL_LOCATION_NODAL_P1 = 2,
    FULLMAG_FEM_MATERIAL_LOCATION_ELEMENT_DG0 = 3,
} fullmag_fem_material_location;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t state_space;
    uint32_t ms_location;
    uint32_t a_location;
    uint32_t reserved0;
    uint64_t local_node_count;
    uint64_t true_node_count;
    uint64_t periodic_map_revision;
    uint64_t representation_copy_count;
    uint64_t gather_scatter_bytes;
    uint64_t invalid_space_assertion_count;
    uint64_t hot_loop_representation_copy_count;
    uint64_t hot_loop_gather_scatter_bytes;
} fullmag_fem_representation_receipt_v1;

#define FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION 1u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    int32_t accepted_energy_proof_available;
    double accepted_energy_delta_j;
    double accepted_energy_roundoff_bound_j;
    double accepted_energy_delta_upper_j;
    double armijo_increment_rhs_j;
} fullmag_fem_accepted_energy_proof_v1;

#define FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V1_ABI_VERSION 1u

typedef enum {
    FULLMAG_FEM_SOLVER_ATTEMPT_ACCEPTED = 1,
    FULLMAG_FEM_SOLVER_ATTEMPT_RETRY = 2,
    FULLMAG_FEM_SOLVER_ATTEMPT_FAILED = 3,
} fullmag_fem_solver_attempt_decision;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t attempt;
    uint64_t target_step;
    double time_seconds;
    double dt_attempt_seconds;
    double eta;
    double max_norm_defect;
    double max_spin_rotation;
    uint32_t decision;
    uint32_t reason;
    double dt_next_seconds;
    uint32_t demag_solve_count;
    uint32_t demag_linear_iterations;
    double demag_linear_residual;
    uint32_t rhs_evaluations;
    int32_t estimator_order;
} fullmag_fem_solver_attempt_record_v1;

#define FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V2_ABI_VERSION 2u

typedef enum {
    FULLMAG_FEM_SOLVER_ERROR_NORM_NONE = 0,
    FULLMAG_FEM_SOLVER_ERROR_NORM_MAX = 1,
    FULLMAG_FEM_SOLVER_ERROR_NORM_MASS_WEIGHTED_RMS = 2,
} fullmag_fem_solver_error_norm_type;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t attempt;
    uint64_t target_step;
    double time_seconds;
    double dt_attempt_seconds;
    double eta;
    double max_norm_defect;
    double max_spin_rotation;
    uint32_t decision;
    uint32_t reason;
    double dt_next_seconds;
    uint32_t demag_solve_count;
    uint32_t demag_linear_iterations;
    double demag_linear_residual;
    uint32_t rhs_evaluations;
    int32_t estimator_order;
    uint32_t error_norm_type;
    uint64_t active_node_count;
    double active_measure;
    double normalization_denominator;
    double max_scaled_error;
    double weighted_rms_error;
} fullmag_fem_solver_attempt_record_v2;

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

#define FULLMAG_FEM_RUNTIME_BUILD_INFO_V1_ABI_VERSION 1u
#define FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY 32u
#define FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY 32u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    char mfem_version[FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY];
} fullmag_fem_runtime_build_info;

#define FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION 2u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    char mfem_version[FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY];
    char hypre_version[FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY];
} fullmag_fem_runtime_build_info_v2;

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
    FULLMAG_FEM_MODAL_EXECUTION_AUTO = 0,
    FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_CPU = 1,
    FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU = 2,
    FULLMAG_FEM_MODAL_EXECUTION_VALIDATION = 3,
} fullmag_fem_modal_execution_target;

typedef enum {
    FULLMAG_FEM_MODAL_SCALAR_REAL_SPLIT = 0,
    FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE = 1,
} fullmag_fem_modal_scalar_representation;

typedef enum {
    FULLMAG_FEM_MODAL_RESULT_TANGENT_Q = 0,
    FULLMAG_FEM_MODAL_RESULT_CARTESIAN_DELTA_M = 1,
    FULLMAG_FEM_MODAL_RESULT_TANGENT_Q_AND_CARTESIAN_DELTA_M = 2,
} fullmag_fem_modal_result_field_representation;

typedef enum {
    FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO = 0,
    FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_SHIFT_INVERT = 1,
} fullmag_fem_modal_spectral_transform_kind;

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

#define FULLMAG_FEM_FREQUENCY_DOMAIN_LEGACY_ABI_VERSION 12u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_PRIOR_ABI_VERSION 13u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_PREVIOUS_ABI_VERSION 14u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_V15_ABI_VERSION 15u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION 16u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION 17u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION 18u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION 19u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION 18u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION 20u
#define FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_ABI_VERSION 1u

typedef enum {
    FULLMAG_FEM_FD_OK = 0,
    FULLMAG_FEM_FD_UNAVAILABLE = 1,
    FULLMAG_FEM_FD_VALIDATION_ERROR = 2,
    FULLMAG_FEM_FD_OPERATOR_ERROR = 3,
    FULLMAG_FEM_FD_SOLVE_ERROR = 4,
    FULLMAG_FEM_FD_ARTIFACT_ERROR = 5,
    FULLMAG_FEM_FD_INTERRUPTED = 6,
} FullmagFemFrequencyDomainStatus;

typedef enum {
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_MEASURED = 1,
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE = 2,
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_FAILED = 3,
} FullmagFemModalGpuMeasurementState;

typedef enum {
    FULLMAG_FEM_MODAL_GPU_FALLBACK_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_GPU_FALLBACK_NONE = 1,
    FULLMAG_FEM_MODAL_GPU_FALLBACK_ATTEMPTED = 2,
} FullmagFemModalGpuFallbackState;

typedef enum {
    FULLMAG_FEM_MODAL_OPERATOR_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_OPERATOR_MATRIX_FREE_SCHUR_CUDA = 1,
    FULLMAG_FEM_MODAL_OPERATOR_MATERIALIZED_VALIDATION_CUDA = 2,
} FullmagFemModalOperatorKind;

typedef enum {
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_HOST = 1,
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_DEVICE = 2,
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_UNIFIED = 3,
} FullmagFemModalHypreMemoryLocation;

typedef enum {
    FULLMAG_FEM_MODAL_HYPRE_EXEC_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_HYPRE_EXEC_HOST = 1,
    FULLMAG_FEM_MODAL_HYPRE_EXEC_DEVICE = 2,
} FullmagFemModalHypreExecutionPolicy;

#define FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP UINT64_C(1)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP UINT64_C(2)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_OBJECT_GRAPH UINT64_C(4)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_SCALAR_TELEMETRY UINT64_C(8)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_EXPORT UINT64_C(16)

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

/*
 * Append-only v6 periodic certificate handoff used by the shared-domain
 * modal boundary.  These records intentionally use fixed-width integer
 * fields and pointers only; the C++ verifier converts them to its
 * backend-neutral MeshSymmetryCertificateV6* model before any MFEM assembly.
 */
typedef struct {
    uint64_t source_node;
    uint64_t destination_node;
    uint32_t axis_mask;
    uint32_t kind;
} FullmagFemModalCertificateV6Relation;

typedef struct {
    uint32_t region_id;
    uint32_t part_role;
} FullmagFemModalCertificateV6RegionRole;

typedef struct {
    uint64_t canonical_class_id;
    uint64_t member_count;
    const char *sha256;
} FullmagFemModalCertificateV6ClassDigest;

typedef struct {
    uint32_t view_kind;
    uint32_t part_role;
    const char *part_identity;
    const char *topology_fingerprint;
    uint64_t node_count;
    const uint32_t *region_ids;
    const uint32_t *boundary_axis_masks;
    const FullmagFemModalCertificateV6RegionRole *region_roles;
    uint64_t region_role_count;
    const FullmagFemModalCertificateV6Relation *generator_relations;
    uint64_t generator_relation_count;
    const FullmagFemModalCertificateV6Relation *closure_relations;
    uint64_t closure_relation_count;
    uint8_t require_complete_closure;
    const uint64_t *expected_class_ids;
    uint64_t expected_class_id_count;
    const FullmagFemModalCertificateV6ClassDigest *expected_class_digests;
    uint64_t expected_class_digest_count;
} FullmagFemModalCertificateV6View;

typedef struct {
    const char *schema_version;
    FullmagFemModalCertificateV6View mesh_magnetic;
    FullmagFemModalCertificateV6View payload_magnetic;
    FullmagFemModalCertificateV6View mesh_scalar;
    FullmagFemModalCertificateV6View payload_scalar;
} FullmagFemModalCertificateV6BindingRequest;

/*
 * Append-only backend-neutral physical handoff for the native modal
 * linearization.  This descriptor names the accepted state and term views;
 * it deliberately does not carry a preassembled A_qq matrix or solver/UI
 * policy.  ABI v18 producers must provide the complete v1 descriptor.
 */
#define FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION 1u
#define FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA \
    "modal_linearization_descriptor.v1"
#define FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION 1u
#define FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_SCHEMA \
    "modal_exchange_material_view.v1"
#define FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX 1u
#define FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE (1u << 0)
#define FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD (1u << 1)
#define FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY (1u << 2)
#define FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI (1u << 3)
#define FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG (1u << 4)

typedef struct {
    uint32_t abi_version;
    uint32_t reserved0;
    uint64_t struct_size;
    const char *schema_version;
    uint64_t node_count;
    uint64_t tangent_dof_count;
    const char *coordinate_unit;
    const char *magnetisation_unit;
    const char *time_unit;
    const char *frequency_unit;
    const char *angular_frequency_unit;
    const char *linearization_state_digest;
    const char *equilibrium_digest;
    const char *exchange_term_digest;
    const char *field_term_digest;
    const char *anisotropy_term_digest;
    const char *dmi_term_digest;
    const char *demag_term_digest;
    const char *operator_input_digest;
    const char *demag_provider_signature;
    uint32_t term_presence_mask;
    uint32_t reserved_contract_flags;
    const double *tangent_frame_xyz;
    uint64_t tangent_frame_xyz_count;
    const double *equilibrium_m0_xyz;
    uint64_t equilibrium_m0_xyz_count;
    const double *effective_field_h_eff0_xyz;
    uint64_t effective_field_h_eff0_xyz_count;
    const double *external_field_h_ext0_xyz;
    uint64_t external_field_h_ext0_xyz_count;
    const double *alpha_per_node;
    uint64_t alpha_per_node_count;
    const double *uniaxial_axis_xyz;
    uint64_t uniaxial_axis_xyz_count;
    const double *uniaxial_anisotropy_field_a_per_m;
    uint64_t uniaxial_anisotropy_field_count;
    const double *saturation_magnetisation_a_per_m;
    uint64_t saturation_magnetisation_count;
    double uniform_saturation_magnetisation_a_per_m;
    const fullmag_fem_frequency_domain_exchange_edge *exchange_edges;
    uint64_t exchange_edge_count;
    const fullmag_fem_frequency_domain_dmi_element *dmi_elements;
    uint64_t dmi_element_count;
    const double *dmi_lumped_mass;
    uint64_t dmi_lumped_mass_count;
    const double *dmi_ms_field;
    uint64_t dmi_ms_field_count;
    double dmi_uniform_ms;
} FullmagFemModalLinearizationDescriptor;

/*
 * Append-only scalar material carrier for the v18 modal shared-domain path.
 * It carries no node endpoints: native MFEM assembly owns topology and
 * quadrature.  The older exchange_edges view remains validation-only
 * compatibility until producers publish this sidecar.
 */
typedef struct {
    uint32_t abi_version;
    uint32_t reserved0;
    uint64_t struct_size;
    const char *schema_version;
    uint32_t material_kind;
    uint32_t reserved1;
    double exchange_stiffness_j_per_m;
} FullmagFemModalExchangeMaterialView;

/*
 * Versioned native modal payload for the physical shared-domain Poisson
 * airbox lane.  The payload is append-only and is referenced by the modal
 * request; all pointed-to storage remains owned by the caller for the
 * duration of fullmag_fem_modal_eigen_solve().
 */
typedef struct {
    uint32_t abi_version;
    /* The payload prefix must cover each identity field consumed by the
       requested modal ABI before any pointed-to tail is dereferenced. */
    uint32_t struct_size;
    const fullmag_fem_mesh_desc *mesh;
    const double *equilibrium_m0_xyz;
    uint64_t equilibrium_m0_xyz_count;
    const double *saturation_magnetisation_a_per_m;
    uint64_t saturation_magnetisation_count;
    double uniform_saturation_magnetisation_a_per_m;
    double gamma0_m_per_a_s;
    FullmagFemCsrMatrixView magnetic_a_qq_csr;
    const uint32_t *scalar_reduced_node;
    uint64_t scalar_reduced_node_count;
    const uint32_t *magnetic_reduced_node;
    uint64_t magnetic_reduced_node_count;
    uint64_t magnetic_pair_count;
    uint64_t airbox_pair_count;
    const char *boundary_kind;
    double robin_beta;
    uint32_t boundary_marker;
    const char *equilibrium_digest;
    const char *mesh_certificate_digest;
    const char *mesh_certificate_schema;
    /* v15: exact accepted LinearizationState.v6 identity. */
    const char *linearization_state_digest;
    /* v16: accepted equilibrium fields consumed by native linearization. */
    const double *linearization_m0_xyz;
    uint64_t linearization_m0_xyz_count;
    const double *linearization_h_eff0_xyz;
    uint64_t linearization_h_eff0_xyz_count;
    const double *linearization_h_demag0_xyz;
    uint64_t linearization_h_demag0_xyz_count;
    const double *linearization_phi0;
    uint64_t linearization_phi0_count;
    const char *equilibrium_id;
    const char *mesh_snapshot_id;
    const char *material_snapshot_id;
    const char *physics_snapshot_id;
    const char *boundary_snapshot_id;
    const char *producer_run_id;
    const char *equilibrium_content_sha256;
    const char *demag_model;
    double m0_norm_tolerance;
    /* Frozen v16 field retained only to preserve the historical ABI prefix.
       ABI v19 producers set it to zero and native code never treats it as an
       equilibrium-acceptance threshold. */
    double equilibrium_torque_relative_tolerance;
    /* v16 append-only certificate binding.  Every identity is required by
       the modal boundary before the payload may enter a shared-domain solve. */
    const char *mesh_certificate_map_binding_digest;
    const char *boundary_gauge_digest;
    uint64_t bias_field_sample_index;
    const char *bias_field_sample_id;
    const char *bias_field_sample_signature;
    const char *magnetic_part_identity;
    const char *airbox_part_identity;
    /* v17: canonical certificate preimage binding.  These fields are
       append-only and may only be read when struct_size covers this tail. */
    const char *mesh_generation_identity;
    const char *canonical_preimage;
    uint64_t canonical_preimage_len;
    const char *canonical_preimage_sha256;
    const char *magnetic_class_digest_sha256;
    const char *scalar_class_digest_sha256;
    uint32_t certificate_binding_status;
    const char *certificate_binding_reason;
    /* Append-only v6 relation views.  The modal boundary must reject a
       payload whose prefix does not cover this pointer or whose views cannot
       be verified against the canonical binding digest. */
    const FullmagFemModalCertificateV6BindingRequest *certificate_binding_v6;
    /* v18: backend-neutral physical linearization descriptor. */
    const FullmagFemModalLinearizationDescriptor *linearization_descriptor;
    /* v18 append-only scalar material carrier for native exchange. */
    const FullmagFemModalExchangeMaterialView *exchange_material_view;
    /* v19: immutable user-owned relaxation acceptance certificate. */
    const char *acceptance_criterion;
    const char *acceptance_metric_kind;
    const char *acceptance_unit;
    double acceptance_metric_value;
    double acceptance_threshold;
    const char *acceptance_certificate_sha256;
} FullmagFemModalSharedDomainPayload;

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
    fullmag_fem_modal_spectral_transform_kind spectral_transform_kind;
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
    /* v15+ append-only tail gate.  A known ABI version at or above v15
       requires this byte count to cover every field consumed by that version;
       callers must not rely on an implicit full-size default. */
    uint64_t struct_size;
    fullmag_fem_modal_execution_target execution_target;
    fullmag_fem_modal_scalar_representation scalar_representation;
    fullmag_fem_modal_result_field_representation result_field_representation;
    uint32_t reserved_modal_contract_flags;
    const FullmagFemModalSharedDomainPayload *shared_domain_payload;
    /* v17: producer expectations for the canonical certificate binding. */
    const char *mesh_generation_identity;
    const char *canonical_preimage_sha256;
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
    double real;
    double imag;
} FullmagFemComplex64;

typedef struct {
    uint32_t abi_version;
    FullmagFemFrequencyDomainStatus status;
    char *error_message;
    char *diagnostics_json;
    char *result_json;
    char *artifact_manifest_path;
    uint64_t mode_count;
    uint64_t q_dof_count;
    uint64_t phi_dof_count;
    uint64_t mode_lambda_count;
    uint64_t mode_q_complex_count;
    uint64_t mode_phi_complex_count;
    uint64_t mode_delta_m_xyz_complex_count;
    uint64_t mode_residual_count;
    uint64_t mode_cluster_id_count;
    FullmagFemComplex64 *mode_lambda;
    FullmagFemComplex64 *mode_q_complex;
    FullmagFemComplex64 *mode_phi_complex;
    FullmagFemComplex64 *mode_delta_m_xyz_complex;
    double *mode_residuals;
    uint64_t *mode_cluster_ids;
    fullmag_fem_modal_execution_target resolved_execution_target;
    fullmag_fem_modal_scalar_representation resolved_scalar_representation;
    fullmag_fem_modal_spectral_transform_kind resolved_spectral_transform_kind;
    uint32_t result_flags;
    uint64_t struct_size;
    /* v16 append-only executed-path provenance. */
    uint32_t resolved_fallback_state;
    char *resolved_engine_id;
    char *resolved_fallback_reason;
    /* v17: resolved canonical certificate binding provenance. */
    char *resolved_canonical_preimage_sha256;
    uint32_t resolved_certificate_binding_status;
    char *resolved_certificate_binding_reason;
} FullmagFemFrequencyDomainResult;

/* Caller-sized GPU execution evidence. V1 is deliberately complete-prefix:
   readers reject a shorter record before dereferencing any tail field. */
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t measurement_state;
    uint32_t fallback_state;
    uint64_t measurement_coverage_flags;
    uint32_t device_residency_verified;
    uint32_t production_shared_domain;
    uint32_t validation_only;
    uint32_t operator_kind;
    uint32_t hypre_memory_location;
    uint32_t hypre_execution_policy;
    uint32_t compute_capability_major;
    uint32_t compute_capability_minor;
    uint32_t cuda_driver_version;
    uint32_t cuda_runtime_version;
    char *device_name;
    char *mfem_version;
    char *hypre_version;
    char *petsc_version;
    char *slepc_version;
    char *petsc_vec_type;
    char *petsc_matrix_type;
    char *matshell_vec_type;
    char *slepc_bv_type;
    char *eps_type;
    char *st_type;
    char *ksp_type;
    char *poisson_pc_type;
    char *shift_pc_type;
    char *last_invalidation_reason;
    uint8_t device_uuid[16];
    uint8_t object_graph_sha256[32];
    uint8_t native_trace_sha256[32];
    uint8_t source_snapshot_sha256[32];
    uint8_t runtime_manifest_sha256[32];
    uint8_t mesh_identity_sha256[32];
    uint8_t equilibrium_sha256[32];
    uint8_t certificate_sha256[32];
    uint8_t linearization_sha256[32];
    uint8_t material_sha256[32];
    uint8_t physics_sha256[32];
    uint8_t boundary_sha256[32];
    uint8_t gauge_sha256[32];
    uint8_t operator_terms_sha256[32];
    uint8_t solver_policy_sha256[32];
    uint8_t operator_key_sha256[32];
    uint8_t target_key_sha256[32];
    uint8_t session_context_sha256[32];
    uint64_t setup_h2d_count;
    uint64_t setup_h2d_bytes;
    uint64_t hot_loop_computational_h2d_count;
    uint64_t hot_loop_computational_h2d_bytes;
    uint64_t hot_loop_computational_d2h_count;
    uint64_t hot_loop_computational_d2h_bytes;
    uint64_t hot_loop_scalar_telemetry_d2h_count;
    uint64_t hot_loop_scalar_telemetry_d2h_bytes;
    uint64_t hot_loop_full_vector_crossings;
    uint64_t hot_loop_computational_host_syncs;
    uint64_t hot_loop_scalar_telemetry_syncs;
    uint64_t hot_loop_allocations;
    uint64_t export_d2h_count;
    uint64_t export_d2h_bytes;
    uint64_t device_memory_baseline_bytes;
    uint64_t device_memory_peak_bytes;
    uint64_t device_memory_final_bytes;
    uint64_t operator_dimension;
    uint64_t operator_apply_count;
    uint64_t poisson_solve_count;
    uint64_t poisson_iteration_count;
    uint64_t eps_iteration_count;
    uint64_t eps_restart_count;
    int64_t eps_converged_reason;
    uint64_t operator_state_generation;
    uint64_t target_state_generation;
    uint64_t operator_reuse_count;
    uint64_t target_rebuild_count;
    uint64_t invalidation_flags;
} FullmagFemModalGpuAttestationV1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    FullmagFemFrequencyDomainResult scientific_result_v18;
    FullmagFemModalGpuAttestationV1 *gpu_attestation;
} FullmagFemFrequencyDomainResultV20;

#define FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_FIELD_LIST(X) \
    X(abi_version) X(struct_size) X(measurement_state) X(fallback_state) \
    X(measurement_coverage_flags) X(device_residency_verified) \
    X(production_shared_domain) X(validation_only) X(operator_kind) \
    X(hypre_memory_location) X(hypre_execution_policy) \
    X(compute_capability_major) X(compute_capability_minor) \
    X(cuda_driver_version) X(cuda_runtime_version) X(device_name) \
    X(mfem_version) X(hypre_version) X(petsc_version) X(slepc_version) \
    X(petsc_vec_type) X(petsc_matrix_type) X(matshell_vec_type) \
    X(slepc_bv_type) X(eps_type) X(st_type) X(ksp_type) X(poisson_pc_type) \
    X(shift_pc_type) X(last_invalidation_reason) X(device_uuid) \
    X(object_graph_sha256) X(native_trace_sha256) X(source_snapshot_sha256) \
    X(runtime_manifest_sha256) X(mesh_identity_sha256) X(equilibrium_sha256) \
    X(certificate_sha256) X(linearization_sha256) X(material_sha256) \
    X(physics_sha256) X(boundary_sha256) X(gauge_sha256) \
    X(operator_terms_sha256) X(solver_policy_sha256) X(operator_key_sha256) \
    X(target_key_sha256) X(session_context_sha256) X(setup_h2d_count) \
    X(setup_h2d_bytes) X(hot_loop_computational_h2d_count) \
    X(hot_loop_computational_h2d_bytes) X(hot_loop_computational_d2h_count) \
    X(hot_loop_computational_d2h_bytes) X(hot_loop_scalar_telemetry_d2h_count) \
    X(hot_loop_scalar_telemetry_d2h_bytes) X(hot_loop_full_vector_crossings) \
    X(hot_loop_computational_host_syncs) X(hot_loop_scalar_telemetry_syncs) \
    X(hot_loop_allocations) X(export_d2h_count) X(export_d2h_bytes) \
    X(device_memory_baseline_bytes) X(device_memory_peak_bytes) \
    X(device_memory_final_bytes) X(operator_dimension) X(operator_apply_count) \
    X(poisson_solve_count) X(poisson_iteration_count) X(eps_iteration_count) \
    X(eps_restart_count) X(eps_converged_reason) X(operator_state_generation) \
    X(target_state_generation) X(operator_reuse_count) X(target_rebuild_count) \
    X(invalidation_flags)

#define FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_COUNT_ONE(member) + 1u
#define FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_FIELD_COUNT \
    (0u FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_FIELD_LIST( \
        FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_COUNT_ONE))

typedef enum {
    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED = 1,
    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE = 2,
    FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID = 3,
} fullmag_fem_modal_certificate_binding_status;

/*
 * Modal ABI manifest order.  These lists are append-only contract metadata:
 * every entry names one directly addressable public member of the matching
 * modal envelope.  `fullmag_fem_frequency_domain_abi_layout` publishes the
 * corresponding sizeof/offsetof sequence below for C++/Rust ABI checks.
 */
#define FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_LIST(X) \
    X(abi_version) \
    X(mesh_asset_id) \
    X(equilibrium_source_kind) \
    X(gamma_rad_s_T) \
    X(mu0_T_m_A) \
    X(alpha) \
    X(include_exchange) \
    X(include_demag) \
    X(demag_realization) \
    X(damping_policy) \
    X(spin_wave_bc_kind) \
    X(k_vector_rad_m) \
    X(k_vector_len) \
    X(operator_diagnostics_json)

#define FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_LIST(X) \
    X(abi_version) \
    X(operator_request) \
    X(requested_mode_count) \
    X(target_kind) \
    X(target_frequency_hz) \
    X(frequency_min_hz) \
    X(frequency_max_hz) \
    X(residual_tolerance) \
    X(max_outer_iterations) \
    X(max_linear_iterations) \
    X(output_directory) \
    X(write_partial_artifacts) \
    X(completeness_policy) \
    X(eigensolver_family) \
    X(spectral_transform_kind) \
    X(cancel_user_data) \
    X(cancel_requested) \
    X(progress_user_data) \
    X(progress_callback) \
    X(tiny_validation_enabled) \
    X(tiny_validation_tangent_dof_count) \
    X(tiny_validation_stiffness_matrix_row_major) \
    X(tiny_validation_mass_matrix_row_major) \
    X(tiny_validation_stiffness_diagonal) \
    X(tiny_validation_mass_diagonal) \
    X(mfem_operator_enabled) \
    X(mfem_tangent_dof_count) \
    X(mfem_stiffness_matrix_row_major) \
    X(mfem_gyrotropic_matrix_row_major) \
    X(mfem_mass_matrix_row_major) \
    X(mfem_linearized_pencil_dependency_digest) \
    X(mfem_linearized_pencil_gamma0_m_per_a_s) \
    X(mfem_sparse_operator_enabled) \
    X(mfem_sparse_stiffness_csr) \
    X(mfem_sparse_gyrotropic_csr) \
    X(mfem_sparse_mass_csr) \
    X(has_floquet_k_vector) \
    X(floquet_k_vector_rad_per_m) \
    X(phase_convention) \
    X(mfem_floquet_periodic_pairs) \
    X(mfem_floquet_periodic_pair_count) \
    X(poisson_airbox_block_enabled) \
    X(poisson_airbox_q_dof_count) \
    X(poisson_airbox_phi_dof_count) \
    X(poisson_airbox_a_qq_csr) \
    X(poisson_airbox_a_qphi_csr) \
    X(poisson_airbox_a_phiq_csr) \
    X(poisson_airbox_a_phiphi_csr) \
    X(poisson_airbox_b_qq_csr) \
    X(poisson_airbox_phi_mean_weights) \
    X(poisson_airbox_phi_mean_weights_count) \
    X(poisson_airbox_target_frequency_hz) \
    X(poisson_airbox_expected_reference_frequency_hz) \
    X(poisson_airbox_periodic_mesh_certificate_schema) \
    X(poisson_airbox_magnetic_pair_count) \
    X(poisson_airbox_airbox_pair_count) \
    X(poisson_airbox_shift_invert_action_enabled) \
    X(poisson_airbox_shift_invert_action_device) \
    X(poisson_airbox_shift_sigma_real) \
    X(poisson_airbox_shift_sigma_imag) \
    X(poisson_airbox_shift_action_vector_real) \
    X(poisson_airbox_shift_action_vector_imag) \
    X(poisson_airbox_shift_action_vector_count) \
    X(poisson_airbox_outer_boundary_kind) \
    X(poisson_airbox_robin_beta) \
    X(poisson_airbox_gauge_policy) \
    X(poisson_airbox_gauge_reason) \
    X(poisson_airbox_assembly_kind) \
    X(dynamic_demag_k_tangent_matrix_row_major) \
    X(dynamic_demag_k_tangent_matrix_value_count) \
    X(struct_size) \
    X(execution_target) \
    X(scalar_representation) \
    X(result_field_representation) \
    X(reserved_modal_contract_flags) \
    X(shared_domain_payload) \
    X(mesh_generation_identity) \
    X(canonical_preimage_sha256)

#define FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_LIST(X) \
    X(abi_version) \
    X(struct_size) \
    X(mesh) \
    X(equilibrium_m0_xyz) \
    X(equilibrium_m0_xyz_count) \
    X(saturation_magnetisation_a_per_m) \
    X(saturation_magnetisation_count) \
    X(uniform_saturation_magnetisation_a_per_m) \
    X(gamma0_m_per_a_s) \
    X(magnetic_a_qq_csr) \
    X(scalar_reduced_node) \
    X(scalar_reduced_node_count) \
    X(magnetic_reduced_node) \
    X(magnetic_reduced_node_count) \
    X(magnetic_pair_count) \
    X(airbox_pair_count) \
    X(boundary_kind) \
    X(robin_beta) \
    X(boundary_marker) \
    X(equilibrium_digest) \
    X(mesh_certificate_digest) \
    X(mesh_certificate_schema) \
    X(linearization_state_digest) \
    X(linearization_m0_xyz) \
    X(linearization_m0_xyz_count) \
    X(linearization_h_eff0_xyz) \
    X(linearization_h_eff0_xyz_count) \
    X(linearization_h_demag0_xyz) \
    X(linearization_h_demag0_xyz_count) \
    X(linearization_phi0) \
    X(linearization_phi0_count) \
    X(equilibrium_id) \
    X(mesh_snapshot_id) \
    X(material_snapshot_id) \
    X(physics_snapshot_id) \
    X(boundary_snapshot_id) \
    X(producer_run_id) \
    X(equilibrium_content_sha256) \
    X(demag_model) \
    X(m0_norm_tolerance) \
    X(equilibrium_torque_relative_tolerance) \
    X(mesh_certificate_map_binding_digest) \
    X(boundary_gauge_digest) \
    X(bias_field_sample_index) \
    X(bias_field_sample_id) \
    X(bias_field_sample_signature) \
    X(magnetic_part_identity) \
    X(airbox_part_identity) \
    X(mesh_generation_identity) \
    X(canonical_preimage) \
    X(canonical_preimage_len) \
    X(canonical_preimage_sha256) \
    X(magnetic_class_digest_sha256) \
    X(scalar_class_digest_sha256) \
    X(certificate_binding_status) \
    X(certificate_binding_reason) \
    X(certificate_binding_v6)

#define FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_LIST(X) \
    X(abi_version) \
    X(status) \
    X(error_message) \
    X(diagnostics_json) \
    X(result_json) \
    X(artifact_manifest_path) \
    X(mode_count) \
    X(q_dof_count) \
    X(phi_dof_count) \
    X(mode_lambda_count) \
    X(mode_q_complex_count) \
    X(mode_phi_complex_count) \
    X(mode_delta_m_xyz_complex_count) \
    X(mode_residual_count) \
    X(mode_cluster_id_count) \
    X(mode_lambda) \
    X(mode_q_complex) \
    X(mode_phi_complex) \
    X(mode_delta_m_xyz_complex) \
    X(mode_residuals) \
    X(mode_cluster_ids) \
    X(resolved_execution_target) \
    X(resolved_scalar_representation) \
    X(resolved_spectral_transform_kind) \
    X(result_flags) \
    X(struct_size) \
    X(resolved_fallback_state) \
    X(resolved_engine_id) \
    X(resolved_fallback_reason) \
    X(resolved_canonical_preimage_sha256) \
    X(resolved_certificate_binding_status) \
    X(resolved_certificate_binding_reason)

#define FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_LIST(X) \
    X(row_count) \
    X(column_count) \
    X(row_offsets) \
    X(row_offsets_len) \
    X(column_indices) \
    X(column_indices_len) \
    X(values) \
    X(values_len)

/* Nested v6 certificate records are public C ABI types as well.  Keep these
   field lists append-only so the v2 manifest can prove their cross-language
   sizeof/offsetof contract without dereferencing caller-owned arrays. */
#define FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_LIST(X) \
    X(source_node) \
    X(destination_node) \
    X(axis_mask) \
    X(kind)

#define FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_LIST(X) \
    X(region_id) \
    X(part_role)

#define FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_LIST(X) \
    X(canonical_class_id) \
    X(member_count) \
    X(sha256)

#define FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_LIST(X) \
    X(view_kind) \
    X(part_role) \
    X(part_identity) \
    X(topology_fingerprint) \
    X(node_count) \
    X(region_ids) \
    X(boundary_axis_masks) \
    X(region_roles) \
    X(region_role_count) \
    X(generator_relations) \
    X(generator_relation_count) \
    X(closure_relations) \
    X(closure_relation_count) \
    X(require_complete_closure) \
    X(expected_class_ids) \
    X(expected_class_id_count) \
    X(expected_class_digests) \
    X(expected_class_digest_count)

#define FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_LIST(X) \
    X(schema_version) \
    X(mesh_magnetic) \
    X(payload_magnetic) \
    X(mesh_scalar) \
    X(payload_scalar)

#define FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_LIST(X) \
    X(abi_version) \
    X(reserved0) \
    X(struct_size) \
    X(schema_version) \
    X(node_count) \
    X(tangent_dof_count) \
    X(coordinate_unit) \
    X(magnetisation_unit) \
    X(time_unit) \
    X(frequency_unit) \
    X(angular_frequency_unit) \
    X(linearization_state_digest) \
    X(equilibrium_digest) \
    X(exchange_term_digest) \
    X(field_term_digest) \
    X(anisotropy_term_digest) \
    X(dmi_term_digest) \
    X(demag_term_digest) \
    X(operator_input_digest) \
    X(demag_provider_signature) \
    X(term_presence_mask) \
    X(reserved_contract_flags) \
    X(tangent_frame_xyz) \
    X(tangent_frame_xyz_count) \
    X(equilibrium_m0_xyz) \
    X(equilibrium_m0_xyz_count) \
    X(effective_field_h_eff0_xyz) \
    X(effective_field_h_eff0_xyz_count) \
    X(external_field_h_ext0_xyz) \
    X(external_field_h_ext0_xyz_count) \
    X(alpha_per_node) \
    X(alpha_per_node_count) \
    X(uniaxial_axis_xyz) \
    X(uniaxial_axis_xyz_count) \
    X(uniaxial_anisotropy_field_a_per_m) \
    X(uniaxial_anisotropy_field_count) \
    X(saturation_magnetisation_a_per_m) \
    X(saturation_magnetisation_count) \
    X(uniform_saturation_magnetisation_a_per_m) \
    X(exchange_edges) \
    X(exchange_edge_count) \
    X(dmi_elements) \
    X(dmi_element_count) \
    X(dmi_lumped_mass) \
    X(dmi_lumped_mass_count) \
    X(dmi_ms_field) \
    X(dmi_ms_field_count) \
    X(dmi_uniform_ms)

#define FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_LIST(X) \
    X(abi_version) \
    X(reserved0) \
    X(struct_size) \
    X(schema_version) \
    X(material_kind) \
    X(reserved1) \
    X(exchange_stiffness_j_per_m)

#define FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER(name) + 1
enum {
    FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
    FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_COUNT =
        0 FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_LIST(FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER),
};
#undef FULLMAG_FEM_ABI_FIELD_COUNT_MEMBER

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
    /* Legacy modal manifest fields are retained in the v1 envelope.  New
       complete manifests use fullmag_fem_frequency_domain_modal_abi_layout_v2
       below; removing these fields would break existing Rust/C consumers. */
    uint64_t modal_abi_schema;
    uint64_t modal_abi_version;
    uint64_t modal_eigen_request_size;
    uint64_t modal_eigen_request_struct_size_offset;
    uint64_t modal_eigen_request_shared_domain_payload_offset;
    uint64_t modal_shared_domain_payload_size;
    uint64_t modal_shared_domain_payload_struct_size_offset;
    uint64_t modal_shared_domain_payload_mesh_certificate_digest_offset;
    uint64_t modal_shared_domain_payload_map_binding_digest_offset;
    uint64_t modal_shared_domain_payload_bias_field_sample_id_offset;
    uint64_t modal_frequency_domain_result_size;
    uint64_t modal_frequency_domain_result_struct_size_offset;
    uint64_t modal_frequency_domain_result_resolved_engine_id_offset;
    uint64_t modal_csr_matrix_view_size;
    uint64_t modal_csr_matrix_view_values_len_offset;
    uint64_t modal_eigen_request_abi_version_offset;
    uint64_t modal_eigen_request_operator_request_offset;
    uint64_t modal_eigen_request_spectral_transform_kind_offset;
    uint64_t modal_eigen_request_execution_target_offset;
    uint64_t modal_eigen_request_scalar_representation_offset;
    uint64_t modal_eigen_request_result_field_representation_offset;
    uint64_t modal_shared_domain_payload_abi_version_offset;
    uint64_t modal_shared_domain_payload_mesh_offset;
    uint64_t modal_shared_domain_payload_magnetic_a_qq_csr_offset;
    uint64_t modal_shared_domain_payload_scalar_reduced_node_offset;
    uint64_t modal_shared_domain_payload_magnetic_reduced_node_offset;
    uint64_t modal_shared_domain_payload_magnetic_pair_count_offset;
    uint64_t modal_shared_domain_payload_airbox_pair_count_offset;
    uint64_t modal_shared_domain_payload_boundary_marker_offset;
    uint64_t modal_shared_domain_payload_mesh_certificate_schema_offset;
    uint64_t modal_shared_domain_payload_equilibrium_digest_offset;
    uint64_t modal_shared_domain_payload_linearization_state_digest_offset;
    uint64_t modal_shared_domain_payload_boundary_gauge_digest_offset;
    uint64_t modal_shared_domain_payload_bias_field_sample_index_offset;
    uint64_t modal_shared_domain_payload_bias_field_sample_signature_offset;
    uint64_t modal_shared_domain_payload_magnetic_part_identity_offset;
    uint64_t modal_shared_domain_payload_airbox_part_identity_offset;
    uint64_t modal_frequency_domain_result_abi_version_offset;
    uint64_t modal_frequency_domain_result_status_offset;
    uint64_t modal_frequency_domain_result_error_message_offset;
    uint64_t modal_frequency_domain_result_mode_lambda_offset;
    uint64_t modal_frequency_domain_result_resolved_execution_target_offset;
    uint64_t modal_frequency_domain_result_resolved_scalar_representation_offset;
    uint64_t modal_frequency_domain_result_resolved_spectral_transform_kind_offset;
    uint64_t modal_frequency_domain_result_resolved_fallback_state_offset;
    uint64_t modal_frequency_domain_result_resolved_fallback_reason_offset;
    uint64_t modal_csr_matrix_view_row_count_offset;
    uint64_t modal_csr_matrix_view_column_count_offset;
    uint64_t modal_csr_matrix_view_row_offsets_offset;
    uint64_t modal_csr_matrix_view_row_offsets_len_offset;
    uint64_t modal_csr_matrix_view_column_indices_offset;
    uint64_t modal_csr_matrix_view_column_indices_len_offset;
    uint64_t modal_csr_matrix_view_values_offset;
} fullmag_fem_frequency_domain_abi_layout;

#define FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V2 2u
typedef struct {
    uint32_t abi_version;
    uint32_t reserved0;
    uint64_t struct_size;
    uint64_t modal_abi_schema;
    uint64_t modal_eigen_request_size;
    uint64_t modal_linearized_operator_request_size;
    uint64_t modal_shared_domain_payload_size;
    uint64_t modal_frequency_domain_result_size;
    uint64_t modal_csr_matrix_view_size;
    uint64_t modal_eigen_request_field_count;
    uint64_t modal_eigen_request_field_offsets[128];
    uint64_t modal_linearized_operator_request_field_count;
    uint64_t modal_linearized_operator_request_field_offsets[32];
    uint64_t modal_shared_domain_payload_field_count;
    uint64_t modal_shared_domain_payload_field_offsets[128];
    uint64_t modal_frequency_domain_result_field_count;
    uint64_t modal_frequency_domain_result_field_offsets[64];
    uint64_t modal_csr_matrix_view_field_count;
    uint64_t modal_csr_matrix_view_field_offsets[8];
    uint64_t modal_certificate_v6_relation_size;
    uint64_t modal_certificate_v6_relation_field_count;
    uint64_t modal_certificate_v6_relation_field_offsets[8];
    uint64_t modal_certificate_v6_region_role_size;
    uint64_t modal_certificate_v6_region_role_field_count;
    uint64_t modal_certificate_v6_region_role_field_offsets[4];
    uint64_t modal_certificate_v6_class_digest_size;
    uint64_t modal_certificate_v6_class_digest_field_count;
    uint64_t modal_certificate_v6_class_digest_field_offsets[8];
    uint64_t modal_certificate_v6_view_size;
    uint64_t modal_certificate_v6_view_field_count;
    uint64_t modal_certificate_v6_view_field_offsets[32];
    uint64_t modal_certificate_v6_binding_request_size;
    uint64_t modal_certificate_v6_binding_request_field_count;
    uint64_t modal_certificate_v6_binding_request_field_offsets[8];
} fullmag_fem_frequency_domain_modal_abi_layout_v2;

#define FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V3 3u
typedef struct {
    /* v2 remains the legacy V17-prefix manifest.  This wrapper publishes the
       V18 payload tail and its descriptor offsets without changing v2.  The
       caller supplies `v2.struct_size >= sizeof(v3)` as the wrapper prefix
       guard; the returned nested v2 record reports its own sizeof(v2). */
    fullmag_fem_frequency_domain_modal_abi_layout_v2 v2;
    uint64_t modal_linearization_descriptor_size;
    uint64_t modal_linearization_descriptor_field_count;
    uint64_t modal_linearization_descriptor_field_offsets[128];
    uint64_t modal_exchange_material_view_size;
    uint64_t modal_exchange_material_view_field_count;
    uint64_t modal_exchange_material_view_field_offsets[16];
} fullmag_fem_frequency_domain_modal_abi_layout_v3;

#define FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V4 4u
typedef struct {
    /* v3 remains the frozen V18 descriptor/material manifest.  This wrapper
       publishes the six append-only V19 acceptance-certificate fields. */
    fullmag_fem_frequency_domain_modal_abi_layout_v3 v3;
    uint64_t modal_acceptance_certificate_field_count;
    uint64_t modal_acceptance_certificate_field_offsets[8];
} fullmag_fem_frequency_domain_modal_abi_layout_v4;

#define FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V5 5u
typedef struct {
    /* v4 remains the frozen request/shared-payload v19 manifest. */
    fullmag_fem_frequency_domain_modal_abi_layout_v4 v4;
    uint64_t modal_frequency_domain_result_v20_size;
    uint64_t modal_frequency_domain_result_v20_align;
    uint64_t modal_frequency_domain_result_v20_field_count;
    uint64_t modal_frequency_domain_result_v20_field_offsets[4];
    uint64_t modal_gpu_attestation_v1_size;
    uint64_t modal_gpu_attestation_v1_align;
    uint64_t modal_gpu_attestation_v1_field_count;
    uint64_t modal_gpu_attestation_v1_field_offsets[128];
} fullmag_fem_frequency_domain_modal_abi_layout_v5;

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

/*
 * Public policy for the native FEM GPU RK preflight. Compatibility preserves
 * the existing executable hybrid/operator-acceleration lanes; strict_device
 * must resolve every required operator to the device before a step begins.
 */
typedef enum {
    FULLMAG_FEM_GPU_EXECUTION_REQUEST_COMPATIBILITY = 0,
    FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE = 1,
} fullmag_fem_gpu_execution_request_v1;

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

#define FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1 1u

typedef enum {
    FULLMAG_FEM_GPU_EXECUTION_UNKNOWN = 0,
    FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT = 1,
    FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER = 2,
    FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON = 3,
    FULLMAG_FEM_GPU_EXECUTION_CPU = 4,
} fullmag_fem_gpu_execution_class_v1;

#define FULLMAG_FEM_GPU_OPERATOR_EXCHANGE (UINT64_C(1) << 0)
#define FULLMAG_FEM_GPU_OPERATOR_DEMAG_RHS (UINT64_C(1) << 1)
#define FULLMAG_FEM_GPU_OPERATOR_DEMAG_SOLVE (UINT64_C(1) << 2)
#define FULLMAG_FEM_GPU_OPERATOR_DEMAG_RECOVERY (UINT64_C(1) << 3)
#define FULLMAG_FEM_GPU_OPERATOR_LOCAL_FIELDS (UINT64_C(1) << 4)
#define FULLMAG_FEM_GPU_OPERATOR_DIRECT_TORQUES (UINT64_C(1) << 5)
#define FULLMAG_FEM_GPU_OPERATOR_LLG_RHS (UINT64_C(1) << 6)
#define FULLMAG_FEM_GPU_OPERATOR_RK_STEPPER (UINT64_C(1) << 7)
#define FULLMAG_FEM_GPU_OPERATOR_REDUCTIONS (UINT64_C(1) << 8)
#define FULLMAG_FEM_GPU_OPERATOR_PRECONDITIONER (UINT64_C(1) << 9)

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t execution_class;
    uint32_t precision;
    uint32_t integrator;
    int32_t device_ordinal;
    uint64_t required_operator_mask;
    uint64_t resolved_device_operator_mask;
    uint64_t resolved_host_operator_mask;
    uint64_t resolved_unknown_operator_mask;
    uint64_t executed_device_operator_mask;
    uint64_t executed_host_operator_mask;
    uint64_t executed_unknown_operator_mask;
    uint64_t fallback_count;
    uint64_t accepted_step_count;
    uint64_t rejected_attempt_count;
    uint64_t failed_attempt_count;
    uint64_t hot_loop_compute_h2d_bytes;
    uint64_t hot_loop_compute_d2h_bytes;
    uint64_t hot_loop_compute_host_sync_count;
} fullmag_fem_gpu_execution_receipt_v1;

/*
 * Append-only host-owned performance snapshot.  The physical counters include
 * rejected and failed attempts; accepted counters include all attempts that
 * belong to a committed logical step, including retries.  A snapshot is
 * published atomically at commit and therefore never exposes an active attempt.
 */
#define FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION 1u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t available;
    uint32_t execution_class;
    uint32_t precision;
    uint32_t integrator;
    int32_t device_ordinal;
    uint64_t completed_step;
    uint64_t completed_execution_id;
    uint64_t completed_operator_id;
    uint64_t completed_attempt_count;
    uint64_t rejected_attempt_count;
    uint64_t failed_attempt_count;

    uint64_t physical_rhs_evaluations;
    uint64_t physical_exchange_applies;
    uint64_t physical_exchange_launches;
    uint64_t physical_exchange_nnz_visited;
    uint64_t physical_demag_solves;
    uint64_t physical_demag_iterations;
    uint64_t physical_demag_rhs_norm_evaluations;
    uint64_t physical_demag_stage_energy_evaluations;
    uint64_t physical_normalization_launches;
    uint64_t physical_normalization_readbacks;
    uint64_t physical_adaptive_readbacks;
    uint64_t physical_control_fences;
    uint64_t physical_endpoint_cache_hits;
    uint64_t physical_endpoint_cache_misses;
    uint64_t physical_endpoint_cache_invalidations;
    uint64_t physical_device_to_device_bytes;
    uint64_t physical_control_d2h_bytes;
    uint64_t physical_bulk_d2h_bytes;
    double physical_demag_rhs_norm_sum;
    double physical_demag_stage_energy_sum_joules;

    uint64_t accepted_rhs_evaluations;
    uint64_t accepted_exchange_applies;
    uint64_t accepted_exchange_launches;
    uint64_t accepted_exchange_nnz_visited;
    uint64_t accepted_demag_solves;
    uint64_t accepted_demag_iterations;
    uint64_t accepted_demag_rhs_norm_evaluations;
    uint64_t accepted_demag_stage_energy_evaluations;
    uint64_t accepted_normalization_launches;
    uint64_t accepted_normalization_readbacks;
    uint64_t accepted_adaptive_readbacks;
    uint64_t accepted_control_fences;
    uint64_t accepted_endpoint_cache_hits;
    uint64_t accepted_endpoint_cache_misses;
    uint64_t accepted_endpoint_cache_invalidations;
    uint64_t accepted_device_to_device_bytes;
    uint64_t accepted_control_d2h_bytes;
    uint64_t accepted_bulk_d2h_bytes;
    double accepted_demag_rhs_norm_sum;
    double accepted_demag_stage_energy_sum_joules;

    uint64_t physical_exchange_elapsed_ns;
    uint64_t physical_demag_assemble_elapsed_ns;
    uint64_t physical_demag_recover_elapsed_ns;
    uint64_t physical_demag_energy_elapsed_ns;
    uint64_t physical_rhs_elapsed_ns;
    uint64_t accepted_exchange_elapsed_ns;
    uint64_t accepted_demag_assemble_elapsed_ns;
    uint64_t accepted_demag_recover_elapsed_ns;
    uint64_t accepted_demag_energy_elapsed_ns;
    uint64_t accepted_rhs_elapsed_ns;
} fullmag_fem_gpu_performance_snapshot_v1;

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
int fullmag_fem_solve_steady_transport_m2_v1(
    const fullmag_fem_steady_transport_m2_request_v1 *request,
    fullmag_fem_steady_transport_result_v1 *result
);
int fullmag_fem_solve_steady_transport_rt0_v1(
    const fullmag_fem_steady_transport_rt0_request_v1 *request,
    fullmag_fem_steady_transport_rt0_result_v1 *result
);
int fullmag_fem_solve_steady_transport_rt0_oersted_v1(
    const fullmag_fem_steady_transport_rt0_oersted_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_result_v1 *result
);
int fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_v1(
    const fullmag_fem_steady_transport_rt0_oersted_vector_potential_request_v1 *request,
    fullmag_fem_steady_transport_rt0_oersted_vector_potential_result_v1 *result
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
int fullmag_fem_get_frequency_domain_modal_abi_layout_v2(
    fullmag_fem_frequency_domain_modal_abi_layout_v2 *out_layout
);
int fullmag_fem_get_frequency_domain_modal_abi_layout_v3(
    fullmag_fem_frequency_domain_modal_abi_layout_v3 *out_layout
);
int fullmag_fem_get_frequency_domain_modal_abi_layout_v4(
    fullmag_fem_frequency_domain_modal_abi_layout_v4 *out_layout
);
int fullmag_fem_get_frequency_domain_modal_abi_layout_v5(
    fullmag_fem_frequency_domain_modal_abi_layout_v5 *out_layout
);
int fullmag_fem_get_mesh_abi_layout(fullmag_fem_mesh_abi_layout *out_layout);
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
int fullmag_fem_modal_eigen_solve_v20(
    const FullmagFemModalEigenRequest *request,
    FullmagFemFrequencyDomainResultV20 *out_result
);
void fullmag_fem_frequency_domain_result_v20_destroy(
    FullmagFemFrequencyDomainResultV20 *result
);
int fullmag_fem_modal_eigen_gpu_runtime_finalize(void);
FullmagFemFrequencyDomainResult fullmag_fem_driven_response_solve(
    const FullmagFemDrivenResponseRequest *request
);
void fullmag_fem_frequency_domain_result_destroy(
    FullmagFemFrequencyDomainResult *result
);

fullmag_fem_backend *fullmag_fem_backend_create(
    const fullmag_fem_plan_desc *plan
);

fullmag_fem_backend *fullmag_fem_backend_create_v2(
    const fullmag_fem_plan_desc *plan,
    const fullmag_fem_adaptive_config_v2 *adaptive_config
);

int fullmag_fem_get_regional_field_drive_abi_layout(
    fullmag_fem_regional_field_drive_abi_layout *out_layout
);

int fullmag_fem_backend_begin_stage(
    fullmag_fem_backend *handle,
    double stage_start_time_s
);

int fullmag_fem_backend_set_gpu_execution_request_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_execution_request_v1 request
);

int fullmag_fem_backend_reconfigure_regional_field_drives(
    fullmag_fem_backend *handle,
    const fullmag_fem_regional_field_drive_desc *drives,
    uint64_t drive_count,
    double stage_start_time_s
);

int fullmag_fem_backend_invalidate_fsal(fullmag_fem_backend *handle);

/* Install or clear the append-only CPU stage Oersted callback. Passing NULL
 * clears the hook and invalidates FSAL. The callback is never used by the
 * GPU RK path. */
int fullmag_fem_backend_set_stage_oersted_callback_v1(
    fullmag_fem_backend *handle,
    const fullmag_fem_stage_oersted_callback_v1 *callback);

/* Install or clear the append-only CPU reciprocal transport torque callback.
 * Passing NULL clears the hook and invalidates FSAL. */
int fullmag_fem_backend_set_stage_transport_callback_v1(
    fullmag_fem_backend *handle,
    const fullmag_fem_stage_transport_callback_v1 *callback);

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

/* Internal scientific handoff: copy the magnetic-domain LLG field, never the
 * full-domain visualization field used by the public observable API. */
int fullmag_fem_backend_copy_linearization_field_f64(
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

int fullmag_fem_backend_snapshot_endpoint_cache_telemetry_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_endpoint_cache_telemetry_v1 *out_telemetry
);

int fullmag_fem_backend_snapshot_representation_receipt_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_representation_receipt_v1 *out_receipt
);

int fullmag_fem_backend_solver_attempt_count_v1(
    fullmag_fem_backend *handle,
    uint64_t *out_count
);

int fullmag_fem_backend_copy_solver_attempts_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_solver_attempt_record_v1 *out_records,
    uint64_t capacity,
    uint64_t *out_count
);

int fullmag_fem_backend_copy_solver_attempts_v2(
    fullmag_fem_backend *handle,
    fullmag_fem_solver_attempt_record_v2 *out_records,
    uint64_t capacity,
    uint64_t *out_count
);

int fullmag_fem_backend_take_accepted_energy_proof_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_accepted_energy_proof_v1 *out_proof
);

int fullmag_fem_backend_stage_completion(
    fullmag_fem_backend *handle,
    fullmag_fem_stage_completion *out_completion
);

int fullmag_fem_backend_get_device_info(
    fullmag_fem_backend *handle,
    fullmag_fem_device_info *out_info
);

int fullmag_fem_get_runtime_build_info(
    fullmag_fem_runtime_build_info *out_info
);
int fullmag_fem_get_runtime_build_info_v2(
    fullmag_fem_runtime_build_info_v2 *out_info
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

/*
 * Validate the complete native GPU RK operator plan before a stage starts.
 * This is intentionally separate from the descriptive plan-info query: strict
 * callers need the same mask-level validation used by the CUDA step preflight.
 */
int fullmag_fem_backend_validate_strict_gpu_rk_plan(
    fullmag_fem_backend *handle
);

int fullmag_fem_backend_gpu_execution_receipt_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_execution_receipt_v1 *out_receipt
);

int fullmag_fem_backend_gpu_performance_snapshot_v1(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_performance_snapshot_v1 *out_snapshot
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
