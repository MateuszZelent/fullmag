#pragma once

#include "cpu/mfem/interactions/zeeman_time_dependence.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

struct RegionalFieldDriveRuntime {
    uint64_t stable_id_hash = 0;
    uint32_t time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    OwnedTimeDependence waveform{};
    std::vector<uint32_t> target_element_markers;
    uint32_t target_kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
    uint32_t spatial_profile_kind = FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM;
    std::array<double, 3> sinc_axis{0.0, 0.0, 0.0};
    double sinc_period_m = 0.0;
    double sinc_center_m = 0.0;
    double sinc_width_m = 0.0;
    uint32_t sinc_window = FULLMAG_FEM_SPATIAL_WINDOW_NONE;
    double gaussian_center_x_m = 0.0;
    double gaussian_center_y_m = 0.0;
    double gaussian_carrier_origin_x_m = 0.0;
    double gaussian_sigma_x_m = 0.0;
    double gaussian_sigma_y_m = 0.0;
    double gaussian_wavelength_m = 0.0;
    double gaussian_carrier_phase_rad = 0.0;
    std::vector<fullmag_fem_geometry_mask_node> geometry_nodes;
    uint32_t geometry_root_index = 0;
    std::array<double, 3> direction{0.0, 0.0, 0.0};
    double amplitude_b_t = 0.0;
    std::vector<double> basis_h_xyz;
};

bool copy_regional_field_drive_plan(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

bool project_regional_field_drive_bases(Context &ctx, std::string &error);

void materialize_regional_field_drive(Context &ctx, double evaluation_time_s);

double regional_field_drive_energy(
    const Context &ctx,
    const std::vector<double> &m_xyz);

} // namespace fullmag::fem
