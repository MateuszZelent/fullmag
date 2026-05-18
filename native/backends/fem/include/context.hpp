#pragma once

#include "core/fem_field_buffers.hpp"
#include "core/fem_material_fields.hpp"
#include "core/fem_mesh.hpp"
#include "core/fem_state.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/integrators/rk_stepper_workspace.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic_prescribed_strain.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/thermal_brown_sampler.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/runtime/cpu_threads.hpp"
#include "cpu/mfem/runtime/gpu_state_runtime.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "fullmag_fem.h"
#include "gpu_state.hpp"
#include "transfer_audit.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class BilinearForm;
class Coefficient;
class FiniteElementCollection;
class FiniteElementSpace;
class GridFunction;
class H1_FECollection;
class HypreParMatrix;
class HypreSolver;
class LinearForm;
class Mesh;
class SparseMatrix;
class Vector;
}

namespace fullmag::fem {

struct DemagFemBemWorkspace;
struct DemagRecoveryWorkspace;
struct DmiElementWorkspace;
struct PeriodicPoissonReducedWorkspace;
struct PoissonHypreWorkspace;
struct PoissonRhsWorkspace;

struct Context {
    uint32_t n_nodes = 0;
    uint32_t n_elements = 0;
    uint32_t n_boundary_faces = 0;

    uint32_t fe_order = 1;
    double hmax = 0.0;
    double dt_seconds = 0.0;
    double air_box_factor = 0.0;
    fullmag_fem_field_refresh_policy field_refresh{};

    fullmag_fem_precision precision = FULLMAG_FEM_PRECISION_DOUBLE;
    fullmag_fem_integrator integrator = FULLMAG_FEM_INTEGRATOR_HEUN;

    AdaptiveDtRuntimeState adaptive_dt{};

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
    AnisotropyRuntimeState anisotropy{};

    // ── Magnetoelastic coupling (prescribed-strain) ──────────────────
    bool enable_magnetoelastic = false;
    double mel_b1 = 0.0;             // B₁ [Pa]
    double mel_b2 = 0.0;             // B₂ [Pa]
    bool mel_uniform_strain = true;  // true = single 6-vector, false = per-node
    std::vector<double> mel_strain_voigt;  // 6 (uniform) or 6*n_nodes
    MagnetoelasticRuntimeState magnetoelastic{};

    FemMaterialFieldsRuntimeState material_fields{};

    fullmag_fem_material_desc material{};
    fullmag_fem_solver_config demag_solver{};

    uint64_t step_count = 0;
    uint64_t demag_call_count = 0;
    double current_time = 0.0;
    StageCompletionRuntimeState stage_completion{};

    FemMeshRuntimeState mesh{};
    FemStateRuntimeState state{};
    ExchangeRuntimeState exchange{};
    DemagRuntimeState demag{};
    ZeemanRuntimeState zeeman{};
    DmiRuntimeState dmi{};
    EffectiveFieldRuntimeState effective_field{};

    // ── Spin-transfer torque ──
    bool has_zhang_li_stt = false;
    bool has_slonczewski_stt = false;
    std::array<double, 3> stt_current_density_am2{0.0, 0.0, 0.0};
    double stt_degree = 0.0;
    double stt_beta = 0.0;
    std::array<double, 3> stt_spin_polarization{0.0, 0.0, 1.0};
    double stt_lambda = 1.0;
    double stt_epsilon_prime = 0.0;
    double stt_free_layer_thickness = 0.0; // 0 = geometry-derived
    double stt_current_sign = 1.0;

    // ── Oersted field (cylindrical conductor) ──
    bool has_oersted_cylinder = false;
    bool has_oersted_field = false;
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
    OerstedRuntimeState oersted{};

    // ── Thermal noise (Brown field) ──
    double temperature = 0.0;       // Kelvin
    double current_dt = 1e-13;      // Current timestep for thermal sigma computation
    uint64_t thermal_seed = 0;      // 0 = random seed from system entropy
    ThermalBrownRuntimeState thermal_brown{};

    FemIntegrationWeightsRuntimeState integration_weights{};

    MfemDeviceRuntimeState mfem_device{};

    // CPU OpenMP runtime diagnostics for Poisson/Robin demag and telemetry.
    CpuThreadRuntimeState cpu_threads{};
    MfemContextRuntimeState mfem_context{};

#if FULLMAG_HAS_MFEM_STACK
    std::vector<double> mfem_mx;
    std::vector<double> mfem_my;
    std::vector<double> mfem_mz;
    mfem::Mesh *mfem_mesh = nullptr;
    mfem::FiniteElementCollection *mfem_fec = nullptr;
    mfem::FiniteElementSpace *mfem_fes = nullptr;
    mfem::GridFunction *mfem_gf_mx = nullptr;
    mfem::GridFunction *mfem_gf_my = nullptr;
    mfem::GridFunction *mfem_gf_mz = nullptr;
    mfem::GridFunction *mfem_gf_a = nullptr;
    mfem::GridFunction *mfem_gf_ms = nullptr;
    mfem::Coefficient *mfem_a_coeff = nullptr;
    bool mfem_ready = false;

    // ── Poisson demag (S02-S05) ──
    // Scalar H1 space for potential u on the FULL mesh (magnetic + air).
    mfem::H1_FECollection *mfem_potential_fec = nullptr;
    mfem::FiniteElementSpace *mfem_potential_fes = nullptr;
    mfem::GridFunction *mfem_gf_potential = nullptr;    // solution u
    mfem::BilinearForm *mfem_poisson_bilinear = nullptr;// stiffness: integral grad(u).grad(v)
    mfem::SparseMatrix *mfem_poisson_matrix = nullptr;  // assembled, owned by form

    // S09: BC-eliminated Poisson operator (mfem::SparseMatrix*).
    // Created once by FormLinearSystem during init; reused every solve.
    // Owned by the BilinearForm — do NOT delete separately.
    mfem::SparseMatrix *mfem_poisson_bc_op = nullptr;

    // RHS and solver workspace
    PoissonRhsWorkspace *mfem_poisson_rhs_workspace = nullptr;
    mfem::LinearForm *mfem_poisson_rhs = nullptr;
    mfem::Vector *mfem_poisson_rhs_vec = nullptr;
    mfem::Vector *mfem_poisson_solution_vec = nullptr;
    DemagRecoveryWorkspace *mfem_demag_recovery_workspace = nullptr;
    PoissonHypreWorkspace *mfem_poisson_hypre_workspace = nullptr;
    DmiElementWorkspace *mfem_dmi_workspace = nullptr;

    // Dirichlet boundary: DOFs on outer air-box boundary (marker = boundary_marker)
    std::vector<int> poisson_ess_tdof_list;
    bool poisson_ready = false;

    // Solver state for warm-start
    int poisson_last_iterations = 0;
    double poisson_last_residual = 0.0;
    uint64_t poisson_last_setup_wall_time_ns = 0;
    uint64_t poisson_last_solver_apply_wall_time_ns = 0;
    bool poisson_last_solver_setup_reused = false;
    uint32_t demag_solves_current_step = 0;

    // Cached Hypre solver/preconditioner (persistent across solves)
    mfem::HypreParMatrix *mfem_cached_hypre_par = nullptr; // wraps bc_op
    mfem::HypreSolver *mfem_cached_hypre_preconditioner = nullptr;
    mfem::HypreSolver *mfem_cached_hypre_solver = nullptr;
    bool poisson_solver_setup = false;

    // Demag realization:
    // 1 = airbox_dirichlet, 2 = airbox_robin, 3 = Fredkin-Koehler FEM/BEM.
    int demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    int poisson_boundary_marker = 99;

    // ── Robin boundary condition ──
    int    robin_beta_mode = 0;          // 0=dirichlet, 1=legacy(c=1), 2=dipole(c=2), 3=user
    double robin_beta_factor = 1.0;      // c in β = c/R*
    double robin_effective_beta = 0.0;   // computed β value
    mfem::BilinearForm *mfem_boundary_mass = nullptr; // boundary mass for Robin

    // ── Periodic demag: algebraic P^T A P reduced Poisson system ──
    // Assembled once when periodic demag reduction is requested.
    // The reduced system has periodic_reduced_node_count DOFs.
    mfem::SparseMatrix *mfem_periodic_poisson_matrix = nullptr;    // P^T A_open P
    mfem::Vector *mfem_periodic_poisson_rhs = nullptr;             // work: b_p
    mfem::Vector *mfem_periodic_poisson_solution = nullptr;        // work: x_p
    PeriodicPoissonReducedWorkspace *mfem_periodic_poisson_workspace = nullptr;
    bool poisson_periodic_reduced_ready = false;

    // Body-only Fredkin-Koehler FEM/BEM demag subsystem.
    // Owned by cpu/mfem/interactions/demag_fem_bem_workspace.cpp.
    DemagFemBemWorkspace *mfem_demag_fem_bem_workspace = nullptr;
    bool demag_fem_bem_ready = false;
#endif

    CudaRuntimeState cuda_runtime{};

    mutable TransferAudit transfer_audit;
    FemGpuState gpu_state;

    LegacyGpuExchangeRuntimeState gpu_exchange{};

    // ── Unified RK stepper workspace ──
    StepperWorkspace stepper;

    // Cooperative interrupt hook for interactive control-plane.
    fullmag_fem_interrupt_poll_fn interrupt_poll = nullptr;
    void *interrupt_poll_user_data = nullptr;
    bool step_interrupted = false;
};

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error);

} // namespace fullmag::fem

struct fullmag_fem_backend {
    fullmag::fem::Context context;
    std::string last_error;
};
