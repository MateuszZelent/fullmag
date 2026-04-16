#pragma once

#include "fullmag_fem.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

// ── Butcher tableau for explicit Runge-Kutta methods ──────────────────────
// Max stages: 7 (DP54 uses 7 for FSAL).
static constexpr int MAX_RK_STAGES = 7;

struct ExplicitTableau {
    int stages;                                     // s
    double c[MAX_RK_STAGES];                        // nodes
    double a[MAX_RK_STAGES][MAX_RK_STAGES];         // lower-triangular coupling
    double b_hi[MAX_RK_STAGES];                     // high-order weights
    double b_lo[MAX_RK_STAGES];                     // low-order weights (embedded error)
    int order_hi;                                   // order of b_hi
    int order_est;                                  // order of b_lo (0 = no error est)
    bool fsal;                                      // first-same-as-last?
};

// ── Stepper workspace (device-resident allocation, reused per step) ───────
struct StepperWorkspace {
    bool allocated = false;
    size_t dof_len = 0;                             // n_nodes * 3
    std::vector<double> m_backup;                   // backup of m before stage loop
    std::vector<double> k[MAX_RK_STAGES];           // stage derivatives k_i
    std::vector<double> m_stage;                    // temp: m at stage evaluation point
    std::vector<double> h_ex_tmp;                   // temp exchange field
    std::vector<double> h_demag_tmp;                // temp demag field
    std::vector<double> h_eff_tmp;                  // temp effective field
    std::vector<double> err;                        // error = h*(b_hi - b_lo) . K
    bool fsal_valid = false;                        // true when k[0] holds valid FSAL RHS
};

struct Context {
    uint32_t n_nodes = 0;
    uint32_t n_elements = 0;
    uint32_t n_boundary_faces = 0;

    uint32_t fe_order = 1;
    double hmax = 0.0;
    double dt_seconds = 0.0;
    double air_box_factor = 0.0;
    fullmag_fem_field_refresh_policy field_refresh{};
    fullmag_fem_relax_stop relax_stop{};

    fullmag_fem_precision precision = FULLMAG_FEM_PRECISION_DOUBLE;
    fullmag_fem_integrator integrator = FULLMAG_FEM_INTEGRATOR_HEUN;

    // ── S17: Adaptive time stepping (PI controller) ──
    bool adaptive_dt_enabled = false;
    double dt_min = 1e-16;
    double dt_max = 1e-10;
    double adaptive_atol = 1e-6;      // absolute tolerance
    double adaptive_rtol = 1e-3;      // relative tolerance
    double pi_alpha = 0.7;            // PI controller exponent for error
    double pi_beta = 0.4;             // PI controller exponent for prev error ratio
    double safety_factor = 0.9;       // safety multiplier on predicted dt
    double dt_grow_max = 2.0;         // max growth ratio per step
    double dt_shrink_min = 0.2;       // min shrink ratio per step
    double prev_error_norm = 1.0;     // for PI: error from previous accepted step
    uint64_t rejected_steps = 0;      // total rejected (retried) steps

    bool enable_exchange = true;
    bool enable_demag = false;
    bool has_external_field = false;
    std::array<double, 3> external_field_am{0.0, 0.0, 0.0};

    bool enable_anisotropy = false;
    double anisotropy_Ku = 0.0;
    double anisotropy_Ku2 = 0.0;
    std::array<double, 3> anisotropy_axis{0.0, 0.0, 1.0};

    bool enable_dmi = false;
    double dmi_D = 0.0;
    std::array<double, 3> dmi_n_hat{0.0, 0.0, 1.0}; // FND-009: interface normal for iDMI

    bool enable_bulk_dmi = false;
    double bulk_dmi_D = 0.0;

    bool enable_cubic_anisotropy = false;
    double cubic_Kc1 = 0.0;
    double cubic_Kc2 = 0.0;
    double cubic_Kc3 = 0.0;
    std::array<double, 3> cubic_axis1{1.0, 0.0, 0.0};
    std::array<double, 3> cubic_axis2{0.0, 1.0, 0.0};
    std::vector<double> h_cubic_ani_xyz;

    // ── Magnetoelastic coupling (prescribed-strain) ──────────────────
    bool enable_magnetoelastic = false;
    double mel_b1 = 0.0;             // B₁ [Pa]
    double mel_b2 = 0.0;             // B₂ [Pa]
    bool mel_uniform_strain = true;  // true = single 6-vector, false = per-node
    std::vector<double> mel_strain_voigt;  // 6 (uniform) or 6*n_nodes
    std::vector<double> h_mel_xyz;         // per-node H_mel buffer (AOS-3)
    double mel_energy = 0.0;               // E_mel [J] from last evaluation

    // ── Per-node dual volumes for thermal noise scaling ──────────────
    // V_i = sum over tets containing node i of (1/4) * V_tet.
    // Computed once during context_from_plan.  Used by thermal field
    // instead of a single average_magnetic_node_volume.
    std::vector<double> node_volumes;

    // ── Per-node spatially varying material fields ────────────────────
    // When non-empty (size == n_nodes), kernels use per-node values.
    // When empty, scalar fallback (ctx.material.saturation_magnetisation etc.).
    std::vector<double> Ms_field;
    std::vector<double> A_field;
    std::vector<double> alpha_field;
    std::vector<double> Ku_field;
    std::vector<double> Ku2_field;
    std::vector<double> Dind_field;
    std::vector<double> Dbulk_field;
    std::vector<double> Kc1_field;
    std::vector<double> Kc2_field;
    std::vector<double> Kc3_field;

    fullmag_fem_material_desc material{};
    fullmag_fem_solver_config demag_solver{};

    uint64_t step_count = 0;
    uint64_t demag_call_count = 0;
    double current_time = 0.0;
    double relax_pseudotime_s = 0.0;
    double relax_previous_total_energy_j = 0.0;
    bool relax_previous_total_energy_valid = false;
    fullmag_fem_stage_completion stage_completion{};

    std::vector<double> nodes_xyz;
    std::vector<uint32_t> elements;
    std::vector<uint32_t> element_markers;
    std::vector<uint32_t> boundary_faces;
    std::vector<uint32_t> boundary_markers;

    std::vector<uint8_t> magnetic_element_mask;
    std::vector<uint8_t> magnetic_node_mask;

    std::vector<double> m_xyz;
    std::vector<double> h_ex_xyz;
    std::vector<double> h_demag_xyz;
    std::vector<double> h_demag_cached_xyz;
    std::vector<double> h_ext_xyz;
    std::vector<double> h_ani_xyz;
    std::vector<double> h_dmi_xyz;
    std::vector<double> h_bulk_dmi_xyz;   // Per-node bulk DMI field (AOS-3)
    std::vector<double> h_eff_xyz;

    // Full-domain H_demag for visualization (includes airbox nodes).
    // h_demag_xyz is zeroed on non-magnetic nodes for LLG/energy,
    // but this copy preserves the Poisson-recovered field everywhere.
    std::vector<double> h_demag_visual_xyz;
    std::vector<double> h_demag_cached_visual_xyz;
    // Full-domain H_eff for visualization (includes airbox contribution
    // from H_demag and H_ext).
    std::vector<double> h_eff_visual_xyz;
    bool demag_cache_valid = false;
    double demag_last_refresh_time = -1.0;

    // ── Oersted field (cylindrical conductor) ──
    bool has_oersted_cylinder = false;
    double oersted_current = 0.0;
    double oersted_radius = 0.0;
    std::array<double, 3> oersted_center{0.0, 0.0, 0.0};
    std::array<double, 3> oersted_axis{0.0, 0.0, 1.0};
    uint32_t oersted_time_dep_kind = 0;
    double oersted_time_dep_freq = 0.0;
    double oersted_time_dep_phase = 0.0;
    double oersted_time_dep_offset = 0.0;
    double oersted_time_dep_t_on = 0.0;
    double oersted_time_dep_t_off = 0.0;
    std::vector<double> h_oe_xyz;  // Precomputed static Oersted field for I=1A (AOS-3)

    // ── Thermal noise (Brown field) ──
    double temperature = 0.0;       // Kelvin
    double thermal_sigma = 0.0;     // Precomputed noise amplitude (A/m)
    double current_dt = 1e-13;      // Current timestep for thermal sigma computation
    double last_thermal_refresh_time = -1.0;
    double last_thermal_refresh_dt = -1.0;
    uint64_t thermal_seed = 0;      // 0 = random seed from system entropy
    std::vector<double> h_therm_xyz;  // Per-node thermal field buffer (AOS-3)

    // FEM-029 fix: explicit GPU device index from plan. -1 = env / default.
    int32_t gpu_device_index = -1;

    // FEM-030 fix: explicit MFEM device string from plan. Empty = env / default.
    std::string mfem_device_string_override;

#if FULLMAG_HAS_MFEM_STACK
    std::vector<double> mfem_mx;
    std::vector<double> mfem_my;
    std::vector<double> mfem_mz;
    std::vector<double> mfem_h_ex_x;
    std::vector<double> mfem_h_ex_y;
    std::vector<double> mfem_h_ex_z;
    std::vector<double> mfem_exchange_tmp;
    std::vector<double> mfem_lumped_mass;

    int mfem_selected_device_index = -1;
    void *mfem_mesh = nullptr;
    void *mfem_device = nullptr;
    void *mfem_fec = nullptr;
    void *mfem_fes = nullptr;
    void *mfem_gf_mx = nullptr;
    void *mfem_gf_my = nullptr;
    void *mfem_gf_mz = nullptr;
    void *mfem_gf_a = nullptr;
    void *mfem_gf_ms = nullptr;
    void *mfem_a_coeff = nullptr;
    void *mfem_exchange_form = nullptr;
    void *mfem_mass_form = nullptr;
    void *mfem_mass_ones = nullptr;
    void *mfem_mass_lumped = nullptr;
    void *mfem_inv_lumped_mass = nullptr;
    void *mfem_exchange_tmp_vec = nullptr;
    void *mfem_exchange_out_vec = nullptr;
    bool mfem_ready = false;
    bool mfem_exchange_ready = false;
    // FND-013: consistent-mass projection for exchange (CG solve M*h = K*m).
    bool use_consistent_mass = false;

    // ── Poisson demag (S02-S05) ──
    // Scalar H1 space for potential u on the FULL mesh (magnetic + air).
    void *mfem_potential_fec = nullptr;   // mfem::H1_FECollection*
    void *mfem_potential_fes = nullptr;   // mfem::FiniteElementSpace*
    void *mfem_gf_potential = nullptr;    // mfem::GridFunction* (solution u)
    void *mfem_poisson_bilinear = nullptr;// mfem::BilinearForm* (stiffness: ∫∇u·∇v)
    void *mfem_poisson_matrix = nullptr;  // mfem::SparseMatrix* (assembled, owned by form)

    // S09: BC-eliminated Poisson operator (mfem::SparseMatrix*).
    // Created once by FormLinearSystem during init; reused every solve.
    // Owned by the BilinearForm — do NOT delete separately.
    void *mfem_poisson_bc_op = nullptr;

    // RHS and solver workspace
    void *mfem_poisson_rhs = nullptr;     // mfem::LinearForm* (reusable handle)
    void *mfem_poisson_rhs_vec = nullptr; // mfem::Vector* (assembled RHS b)

    // Dirichlet boundary: DOFs on outer air-box boundary (marker = boundary_marker)
    std::vector<int> poisson_ess_tdof_list;
    bool poisson_ready = false;

    // Solver state for warm-start
    int poisson_last_iterations = 0;
    double poisson_last_residual = 0.0;

    // Cached Hypre solver/preconditioner (persistent across solves)
    void *mfem_cached_hypre_par = nullptr;  // mfem::HypreParMatrix* (wraps bc_op)
    void *mfem_cached_hypre_amg = nullptr;  // mfem::HypreBoomerAMG*
    void *mfem_cached_hypre_pcg = nullptr;  // mfem::HyprePCG*
    bool poisson_solver_setup = false;

    // Demag realization: 1 = airbox_dirichlet, 2 = airbox_robin
    int demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    int poisson_boundary_marker = 99;

    // ── Robin boundary condition ──
    int    robin_beta_mode = 0;          // 0=dirichlet, 1=legacy(c=1), 2=dipole(c=2), 3=user
    double robin_beta_factor = 1.0;      // c in β = c/R*
    double robin_effective_beta = 0.0;   // computed β value
    void  *mfem_boundary_mass = nullptr; // mfem::BilinearForm* for ∫_Γ φᵢφⱼ dS

    // CPU OpenMP runtime diagnostics for Poisson/Robin demag.
    bool cpu_threads_auto_requested = false;
    int requested_omp_threads = 1;
    int effective_omp_threads = 1;
#endif

    // ── S12: CUDA stream management ──
#if FULLMAG_HAS_CUDA_RUNTIME
    void *compute_stream = nullptr; // cudaStream_t (high priority)
    void *io_stream = nullptr;      // cudaStream_t (low priority, snapshot I/O)
    void *compute_event = nullptr;  // cudaEvent_t (signal scalars ready)
    // Double-buffered pinned host snapshots (S13)
    void *pinned_snapshot[2] = {nullptr, nullptr};
    size_t pinned_snapshot_bytes = 0;
    int active_snapshot_buffer = 0;
#endif

    fullmag_fem_device_info device_info_cache{};
    bool device_info_valid = false;

    // ── Unified RK stepper workspace ──
    StepperWorkspace stepper;

    // Cooperative interrupt hook for interactive control-plane.
    fullmag_fem_interrupt_poll_fn interrupt_poll = nullptr;
    void *interrupt_poll_user_data = nullptr;
    bool step_interrupted = false;
};

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error);
int context_copy_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error);
int context_upload_magnetization_f64(
    Context &ctx,
    const double *m_xyz,
    uint64_t len,
    std::string &error);
void context_populate_device_info(Context &ctx);
void context_refresh_thermal_field(Context &ctx);
#if FULLMAG_HAS_MFEM_STACK
bool context_initialize_mfem(Context &ctx, std::string &error);
void context_destroy_mfem(Context &ctx);
bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error);
bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error);
bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error);
bool context_snapshot_stats_mfem(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &error);
const ExplicitTableau &tableau_for_integrator(fullmag_fem_integrator integrator);
void stepper_workspace_allocate(StepperWorkspace &ws, size_t dof_len, int stages);
bool context_initialize_poisson(Context &ctx, std::string &error);
void context_destroy_poisson(Context &ctx);
bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    std::string &error);
void compute_magnetoelastic_field(
    Context &ctx,
    const std::vector<double> &m_xyz);
// Forward-declared so that context.cpp can call this without including
// mfem_bridge.cpp internals. PhaseTimings is only ever passed as nullptr
// from context.cpp.
struct PhaseTimings;
bool compute_effective_fields_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> &h_demag_xyz,
    std::vector<double> &h_eff_xyz,
    double *exchange_energy,
    double *demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error);
#endif

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

} // namespace fullmag::fem

struct fullmag_fem_backend {
    fullmag::fem::Context context;
    std::string last_error;
};
