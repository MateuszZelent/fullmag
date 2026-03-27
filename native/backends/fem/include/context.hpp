#pragma once

#include "fullmag_fdm.h"
#include "fullmag_fem.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct TransferGridDesc {
    uint32_t nx = 0;
    uint32_t ny = 0;
    uint32_t nz = 0;
    double dx = 0.0;
    double dy = 0.0;
    double dz = 0.0;
    std::array<double, 3> bbox_min{0.0, 0.0, 0.0};

    [[nodiscard]] uint64_t cell_count() const {
        return static_cast<uint64_t>(nx) * static_cast<uint64_t>(ny) * static_cast<uint64_t>(nz);
    }

    [[nodiscard]] size_t index(uint32_t ix, uint32_t iy, uint32_t iz) const {
        return static_cast<size_t>(iz) * static_cast<size_t>(nx) * static_cast<size_t>(ny) +
               static_cast<size_t>(iy) * static_cast<size_t>(nx) +
               static_cast<size_t>(ix);
    }
};

struct TransferGridState {
    bool ready = false;
    TransferGridDesc desc{};
    std::vector<uint8_t> active_mask;
    std::vector<double> magnetization_xyz;
    std::vector<double> demag_xyz;
    std::vector<double> kernel_xx_spectrum;
    std::vector<double> kernel_yy_spectrum;
    std::vector<double> kernel_zz_spectrum;
    std::vector<double> kernel_xy_spectrum;
    std::vector<double> kernel_xz_spectrum;
    std::vector<double> kernel_yz_spectrum;
    fullmag_fdm_backend *backend = nullptr;
};

struct Context {
    uint32_t n_nodes = 0;
    uint32_t n_elements = 0;
    uint32_t n_boundary_faces = 0;

    uint32_t fe_order = 1;
    double hmax = 0.0;
    double dt_seconds = 0.0;
    double air_box_factor = 0.0;

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

    fullmag_fem_material_desc material{};
    fullmag_fem_solver_config demag_solver{};

    uint64_t step_count = 0;
    double current_time = 0.0;

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
    std::vector<double> h_ext_xyz;
    std::vector<double> h_eff_xyz;
    TransferGridState transfer_grid{};

#if FULLMAG_HAS_MFEM_STACK
    std::vector<double> mfem_mx;
    std::vector<double> mfem_my;
    std::vector<double> mfem_mz;
    std::vector<double> mfem_h_ex_x;
    std::vector<double> mfem_h_ex_y;
    std::vector<double> mfem_h_ex_z;
    std::vector<double> mfem_lumped_mass;

    int mfem_selected_device_index = -1;
    void *mfem_mesh = nullptr;
    void *mfem_device = nullptr;
    void *mfem_fec = nullptr;
    void *mfem_fes = nullptr;
    void *mfem_gf_mx = nullptr;
    void *mfem_gf_my = nullptr;
    void *mfem_gf_mz = nullptr;
    void *mfem_exchange_form = nullptr;
    void *mfem_mass_form = nullptr;
    bool mfem_ready = false;
    bool mfem_exchange_ready = false;

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

    // Demag realization: 0 = transfer_grid (legacy), 1 = poisson_airbox
    int demag_realization = 0;
    int poisson_boundary_marker = 99;
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
};

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error);
int context_copy_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error);
void context_populate_device_info(Context &ctx);
#if FULLMAG_HAS_MFEM_STACK
bool context_initialize_mfem(Context &ctx, std::string &error);
void context_destroy_mfem(Context &ctx);
bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error);
bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error);
bool context_initialize_poisson(Context &ctx, std::string &error);
void context_destroy_poisson(Context &ctx);
bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    std::string &error);
#endif

} // namespace fullmag::fem

struct fullmag_fem_backend {
    fullmag::fem::Context context;
    std::string last_error;
};
