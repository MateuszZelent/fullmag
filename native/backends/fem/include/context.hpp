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
#endif

} // namespace fullmag::fem

struct fullmag_fem_backend {
    fullmag::fem::Context context;
    std::string last_error;
};
