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

typedef enum {
    FULLMAG_FEM_PRECISION_SINGLE = 1,
    FULLMAG_FEM_PRECISION_DOUBLE = 2,
} fullmag_fem_precision;

typedef enum {
    FULLMAG_FEM_INTEGRATOR_HEUN = 1,
} fullmag_fem_integrator;

typedef enum {
    FULLMAG_FEM_OBSERVABLE_M = 1,
    FULLMAG_FEM_OBSERVABLE_H_EX = 2,
    FULLMAG_FEM_OBSERVABLE_H_DEMAG = 3,
    FULLMAG_FEM_OBSERVABLE_H_EXT = 4,
    FULLMAG_FEM_OBSERVABLE_H_EFF = 5,
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
    FULLMAG_FEM_DEMAG_TRANSFER_GRID = 0,
    FULLMAG_FEM_DEMAG_POISSON_AIRBOX = 1,
} fullmag_fem_demag_realization;

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
    const double *demag_kernel_xx_spectrum;
    const double *demag_kernel_yy_spectrum;
    const double *demag_kernel_zz_spectrum;
    const double *demag_kernel_xy_spectrum;
    const double *demag_kernel_xz_spectrum;
    const double *demag_kernel_yz_spectrum;
    uint64_t demag_kernel_spectrum_len;
    const double *initial_magnetization_xyz;
    uint64_t initial_magnetization_len;
    double dt_seconds;
} fullmag_fem_plan_desc;

typedef struct {
    uint64_t step;
    double time_seconds;
    double dt_seconds;
    double exchange_energy_joules;
    double demag_energy_joules;
    double external_energy_joules;
    double total_energy_joules;
    double max_effective_field_amplitude;
    double max_demag_field_amplitude;
    double max_rhs_amplitude;
    uint32_t demag_linear_iterations;
    double demag_linear_residual;
    uint64_t wall_time_ns;
} fullmag_fem_step_stats;

typedef struct {
    char name[128];
    int is_gpu_enabled;
    int compute_capability_major;
    int compute_capability_minor;
    int driver_version;
    int runtime_version;
} fullmag_fem_device_info;

typedef struct fullmag_fem_backend fullmag_fem_backend;

int fullmag_fem_is_available(void);

fullmag_fem_backend *fullmag_fem_backend_create(
    const fullmag_fem_plan_desc *plan
);

int fullmag_fem_backend_step(
    fullmag_fem_backend *handle,
    double dt_seconds,
    fullmag_fem_step_stats *out_stats
);

int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len
);

int fullmag_fem_backend_get_device_info(
    fullmag_fem_backend *handle,
    fullmag_fem_device_info *out_info
);

const char *fullmag_fem_backend_last_error(fullmag_fem_backend *handle);

void fullmag_fem_backend_destroy(fullmag_fem_backend *handle);

#ifdef __cplusplus
}
#endif

#endif
