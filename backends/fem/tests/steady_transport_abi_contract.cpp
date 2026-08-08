#include "fullmag_fem.h"

#include <algorithm>
#include <cstring>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>

namespace {

void require(bool condition, const char *message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    if (!input) {
        throw std::runtime_error("unable to read " + path.string());
    }
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

fullmag_fem_steady_transport_request_v1 base_request()
{
    fullmag_fem_steady_transport_request_v1 request{};
    request.abi_version = FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE;
    request.interface_model = FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1;
    request.charge_gauge = FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE;
    request.constitutive_version = "transport_constitutive.one_way.fullmag.v1";
    request.operator_version = "fem_charge_spin_conforming_h1_p1.transparent.v1";
    request.physical_residual_version = "transport_balance_integrated_l2.v1";
    return request;
}

fullmag_fem_steady_transport_result_v1 base_result()
{
    fullmag_fem_steady_transport_result_v1 result{};
    result.abi_version = FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION;
    result.struct_size = sizeof(result);
    return result;
}

void wrong_abi_version_fails_before_mesh_import()
{
    auto request = base_request();
    auto result = base_result();
    request.abi_version += 1;
    const int status = fullmag_fem_solve_steady_transport_v1(&request, &result);
    require(status == FULLMAG_FEM_ERR_INVALID, "wrong transport ABI version was accepted");
    require(std::strstr(result.error_message, "abi_version") != nullptr,
        "wrong-version diagnostic is not stable");
}

void gpu_fails_closed_before_mesh_import()
{
    auto request = base_request();
    auto result = base_result();
    request.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE;
    const int status = fullmag_fem_solve_steady_transport_v1(&request, &result);
    require(status == FULLMAG_FEM_ERR_UNAVAILABLE, "GPU transport silently fell back to CPU");
    require(std::strstr(result.error_message, "GPU") != nullptr,
        "GPU rejection diagnostic is missing");
}

void mixing_fails_closed_before_mesh_import()
{
    auto request = base_request();
    auto result = base_result();
    request.interface_model = FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1;
    const int status = fullmag_fem_solve_steady_transport_v1(&request, &result);
    require(status == FULLMAG_FEM_ERR_UNAVAILABLE,
        "mixing transport silently used conforming H1");
    require(std::strstr(result.error_message, "broken-H1") != nullptr,
        "mixing rejection diagnostic is missing");
}

void solved_current_oersted_public_boundary_does_not_claim_rt0()
{
    const auto root = fem_source_root();
    const auto repo = root.parent_path().parent_path();
    const auto header = read_text_file(repo / "native" / "include" / "fullmag_fem.h");
    const auto runner = read_text_file(
        repo / "crates" / "fullmag-runner" / "src" / "native_fem" / "steady_transport.rs");
    const auto physics = read_text_file(
        repo / "docs" / "physics" / "0980-dynamic-current-and-oersted-coupling.md");

    require(header.find("not a conservative RT0/H(div) current view") != std::string::npos,
        "steady transport ABI must label nodal current as non-conservative");
    require(header.find("FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION 1u") != std::string::npos,
        "steady transport ABI v1 marker disappeared");
    require(runner.find("solved_current_h1_nodal_midpoint_reference") != std::string::npos,
        "bounded runner source kind must remain explicit until RT0 integration");
    require(runner.find("fem_conservative_current_rt0_view.v1") == std::string::npos,
        "bounded runner must not claim an unimplemented RT0 source view");
    require(physics.find("Public ABI boundary and next append-only extension") !=
            std::string::npos,
        "physics note must freeze the public ABI blocker and next extension contract");
}

void cpu_double_transparent_request_materializes_all_transport_fields()
{
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const uint32_t cell_types[] = {FULLMAG_FEM_CELL_TET4};
    const uint32_t cell_offsets[] = {0, 4};
    const uint32_t cell_nodes[] = {0, 1, 2, 3};
    const uint32_t facet_types[] = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    };
    const uint32_t facet_roles[] = {
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    const uint32_t facet_offsets[] = {0, 3, 6, 9, 12};
    const uint32_t facet_nodes[] = {
        0, 2, 1,
        0, 1, 3,
        0, 3, 2,
        1, 2, 3,
    };
    const uint32_t facet_markers[] = {1, 1, 1, 1};
    const double conductivity[] = {4.0};
    const double magnetization[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const uint32_t charge_attributes[] = {1};
    const double charge_values[] = {1.0};

    double potential[4]{};
    double current[12]{};
    double spin[12]{};
    double spin_current[36]{};
    double torque[12]{};

    auto request = base_request();
    request.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    request.mesh.struct_size = sizeof(request.mesh);
    request.mesh.nodes_xyz = nodes;
    request.mesh.nodes_xyz_len = 12;
    request.mesh.cell_types = cell_types;
    request.mesh.cell_types_len = 1;
    request.mesh.cell_offsets = cell_offsets;
    request.mesh.cell_offsets_len = 2;
    request.mesh.cell_nodes = cell_nodes;
    request.mesh.cell_nodes_len = 4;
    request.mesh.facet_types = facet_types;
    request.mesh.facet_types_len = 4;
    request.mesh.facet_roles = facet_roles;
    request.mesh.facet_roles_len = 4;
    request.mesh.facet_offsets = facet_offsets;
    request.mesh.facet_offsets_len = 5;
    request.mesh.facet_nodes = facet_nodes;
    request.mesh.facet_nodes_len = 12;
    request.mesh.facet_markers = facet_markers;
    request.mesh.facet_markers_len = 4;
    request.charge_conductivity_spm_per_element = conductivity;
    request.charge_conductivity_spm_per_element_len = 1;
    request.magnetization_xyz = magnetization;
    request.magnetization_xyz_len = 12;
    request.sigma_s_spm = 5.0;
    request.polarization_p = 0.2;
    request.theta_sh = 0.1;
    request.lambda_sf_m = 0.5;
    request.has_lambda_j = 1;
    request.lambda_j_m = 0.4;
    request.has_lambda_phi = 1;
    request.lambda_phi_m = 0.6;
    request.gamma_e_per_ts = 1.76085963023e11;
    request.saturation_magnetization_apm = 8.0e5;
    request.relative_tolerance = 1.0e-10;
    request.absolute_tolerance = 0.0;
    request.maximum_iterations = 500;
    request.charge_dirichlet_boundary_attributes = charge_attributes;
    request.charge_dirichlet_values_v = charge_values;
    request.charge_dirichlet_count = 1;

    auto result = base_result();
    result.electric_potential_v = potential;
    result.electric_potential_v_len = 4;
    result.charge_current_density_xyz_apm2 = current;
    result.charge_current_density_xyz_apm2_len = 12;
    result.spin_potential_xyz_v = spin;
    result.spin_potential_xyz_v_len = 12;
    result.spin_current_tensor_row_major_qia_apm2 = spin_current;
    result.spin_current_tensor_row_major_qia_apm2_len = 36;
    result.torque_xyz_per_s = torque;
    result.torque_xyz_len = 12;

    const int status = fullmag_fem_solve_steady_transport_v1(&request, &result);
    if (status != FULLMAG_FEM_OK) {
        std::cerr << "steady transport solve error: " << result.error_message << '\n';
    }
    require(status == FULLMAG_FEM_OK, "CPU-double transparent transport solve failed");
    require(result.charge_converged != 0, "charge solve did not converge");
    require(result.spin_converged != 0, "spin solve did not converge");
    require(std::isfinite(result.charge_relative_residual), "charge residual is non-finite");
    require(std::isfinite(result.spin_relative_residual), "spin residual is non-finite");
    require(std::strstr(result.diagnostics_json, "fem_steady_transport_diagnostics.v1") != nullptr,
        "versioned transport diagnostics were not published");
    require(std::abs(potential[0] - 1.0) < 1.0e-12,
        "charge boundary potential was not imported by attribute");
    for (double value : spin_current) {
        require(std::isfinite(value), "spin current tensor contains a non-finite value");
    }
}

void cpu_double_reciprocal_m2_request_is_explicit_and_fail_closed()
{
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const uint32_t cell_types[] = {FULLMAG_FEM_CELL_TET4};
    const uint32_t cell_offsets[] = {0, 4};
    const uint32_t cell_nodes[] = {0, 1, 2, 3};
    const uint32_t facet_types[] = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    };
    const uint32_t facet_roles[] = {
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    const uint32_t facet_offsets[] = {0, 3, 6, 9, 12};
    const uint32_t facet_nodes[] = {
        0, 2, 1,
        0, 1, 3,
        0, 3, 2,
        1, 2, 3,
    };
    const uint32_t facet_markers[] = {1, 1, 1, 1};
    const double conductivity[] = {4.0};
    const double magnetization[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const uint32_t boundary_attributes[] = {1};
    const double charge_values[] = {1.0};
    const double spin_values[] = {0.0, 0.0, 0.0};

    double potential[4]{};
    double current[12]{};
    double spin[12]{};
    double spin_current[36]{};
    double torque[12]{};

    auto request = fullmag_fem_steady_transport_m2_request_v1{};
    request.base = base_request();
    request.base.constitutive_version = "transport_constitutive.reciprocal.fullmag.v1";
    request.base.operator_version = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
    request.base.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    request.base.mesh.struct_size = sizeof(request.base.mesh);
    request.base.mesh.nodes_xyz = nodes;
    request.base.mesh.nodes_xyz_len = 12;
    request.base.mesh.cell_types = cell_types;
    request.base.mesh.cell_types_len = 1;
    request.base.mesh.cell_offsets = cell_offsets;
    request.base.mesh.cell_offsets_len = 2;
    request.base.mesh.cell_nodes = cell_nodes;
    request.base.mesh.cell_nodes_len = 4;
    request.base.mesh.facet_types = facet_types;
    request.base.mesh.facet_types_len = 4;
    request.base.mesh.facet_roles = facet_roles;
    request.base.mesh.facet_roles_len = 4;
    request.base.mesh.facet_offsets = facet_offsets;
    request.base.mesh.facet_offsets_len = 5;
    request.base.mesh.facet_nodes = facet_nodes;
    request.base.mesh.facet_nodes_len = 12;
    request.base.mesh.facet_markers = facet_markers;
    request.base.mesh.facet_markers_len = 4;
    request.base.charge_conductivity_spm_per_element = conductivity;
    request.base.charge_conductivity_spm_per_element_len = 1;
    request.base.magnetization_xyz = magnetization;
    request.base.magnetization_xyz_len = 12;
    request.base.sigma_s_spm = 3.0;
    request.base.polarization_p = 0.0;
    request.base.theta_sh = 0.1;
    request.base.lambda_sf_m = std::numeric_limits<double>::infinity();
    request.base.gamma_e_per_ts = 1.76085963023e11;
    request.base.saturation_magnetization_apm = 8.0e5;
    request.base.relative_tolerance = 1.0e-10;
    request.base.absolute_tolerance = 0.0;
    request.base.maximum_iterations = 500;
    request.base.charge_dirichlet_boundary_attributes = boundary_attributes;
    request.base.charge_dirichlet_values_v = charge_values;
    request.base.charge_dirichlet_count = 1;
    request.base.spin_dirichlet_boundary_attributes = boundary_attributes;
    request.base.spin_dirichlet_values_v = spin_values;
    request.base.spin_dirichlet_count = 1;
    request.sigma_parallel_spm = 4.0;
    request.sigma_perpendicular_spm = 4.0;
    request.sigma_ahe_spm = 0.0;

    auto result = base_result();
    result.electric_potential_v = potential;
    result.electric_potential_v_len = 4;
    result.charge_current_density_xyz_apm2 = current;
    result.charge_current_density_xyz_apm2_len = 12;
    result.spin_potential_xyz_v = spin;
    result.spin_potential_xyz_v_len = 12;
    result.spin_current_tensor_row_major_qia_apm2 = spin_current;
    result.spin_current_tensor_row_major_qia_apm2_len = 36;
    result.torque_xyz_per_s = torque;
    result.torque_xyz_len = 12;

    const int status = fullmag_fem_solve_steady_transport_m2_v1(&request, &result);
    if (status != FULLMAG_FEM_OK) {
        std::cerr << "steady transport M2 solve error: " << result.error_message << '\n';
    }
    require(status == FULLMAG_FEM_OK, "CPU-double reciprocal M2 transport solve failed");
    require(result.charge_converged != 0, "reciprocal M2 charge solve did not converge");
    require(result.spin_converged != 0, "reciprocal M2 spin solve did not converge");
    require(std::strstr(result.diagnostics_json, "reciprocal_m2") != nullptr,
        "reciprocal M2 diagnostics did not publish the constitutive model");
    for (double value : potential) {
        require(std::abs(value - 1.0) < 1.0e-10,
            "reciprocal M2 charge Dirichlet value was not imported");
    }
    for (double value : spin) {
        require(std::abs(value) < 1.0e-10,
            "reciprocal M2 spin Dirichlet value was not imported");
    }

    request.base.constitutive_version = "transport_constitutive.one_way.fullmag.v1";
    auto rejected_result = base_result();
    rejected_result.electric_potential_v = potential;
    rejected_result.electric_potential_v_len = 4;
    rejected_result.charge_current_density_xyz_apm2 = current;
    rejected_result.charge_current_density_xyz_apm2_len = 12;
    rejected_result.spin_potential_xyz_v = spin;
    rejected_result.spin_potential_xyz_v_len = 12;
    rejected_result.spin_current_tensor_row_major_qia_apm2 = spin_current;
    rejected_result.spin_current_tensor_row_major_qia_apm2_len = 36;
    rejected_result.torque_xyz_per_s = torque;
    rejected_result.torque_xyz_len = 12;
    const int rejected_status = fullmag_fem_solve_steady_transport_m2_v1(
        &request, &rejected_result);
    require(rejected_status == FULLMAG_FEM_ERR_INVALID,
        "M2 accepted a request carrying the M1 constitutive version");
}

void cpu_double_reciprocal_m2_affine_constitutive_oracle()
{
    // Six positively oriented tetrahedra partition the unit cube.  Attributes
    // 1 and 2 are the x=0/x=1 faces; all other faces are natural boundaries.
    // With m=e_x, theta_SH=sigma_AHE=0 and all spin-reaction lengths disabled,
    // V=x and mu_s=(u_x,u_y,u_z)x are an exact solution of the coupled block.
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 1.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 0.0, 1.0,
        1.0, 1.0, 1.0,
        0.0, 1.0, 1.0,
    };
    const uint32_t cell_types[] = {
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
    };
    const uint32_t cell_offsets[] = {0, 4, 8, 12, 16, 20, 24};
    const uint32_t cell_nodes[] = {
        0, 1, 2, 6,
        0, 2, 3, 6,
        0, 4, 5, 6,
        0, 5, 1, 6,
        0, 3, 7, 6,
        0, 7, 4, 6,
    };
    const uint32_t facet_types[] = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    };
    const uint32_t facet_roles[] = {
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    const uint32_t facet_offsets[] = {
        0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36,
    };
    const uint32_t facet_nodes[] = {
        // x=0 (attribute 1)
        0, 7, 3, 0, 4, 7,
        // x=1 (attribute 2)
        1, 2, 6, 5, 1, 6,
        // y=0 (attribute 3)
        0, 1, 5, 0, 5, 4,
        // y=1 (attribute 4)
        2, 3, 6, 3, 7, 6,
        // z=0 (attribute 5)
        0, 2, 1, 0, 3, 2,
        // z=1 (attribute 6)
        4, 5, 6, 7, 4, 6,
    };
    const uint32_t facet_markers[] = {
        1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    };
    const double conductivity[] = {
        3.0, 3.0, 3.0, 3.0, 3.0, 3.0,
    };
    const double magnetization[] = {
        1.0, 0.0, 0.0, 1.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 1.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 1.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 1.0, 0.0, 0.0,
    };
    const uint32_t dirichlet_attributes[] = {1, 2};
    double charge_values[] = {0.0, 1.0};
    double spin_values[] = {
        0.0, 0.0, 0.0,
        0.2, 0.3, 0.4,
    };

    double potential[8]{};
    double current[24]{};
    double spin[24]{};
    double spin_current[72]{};
    double torque[24]{};

    auto request = fullmag_fem_steady_transport_m2_request_v1{};
    request.base = base_request();
    request.base.constitutive_version = "transport_constitutive.reciprocal.fullmag.v1";
    request.base.operator_version = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
    request.base.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    request.base.mesh.struct_size = sizeof(request.base.mesh);
    request.base.mesh.nodes_xyz = nodes;
    request.base.mesh.nodes_xyz_len = 24;
    request.base.mesh.cell_types = cell_types;
    request.base.mesh.cell_types_len = 6;
    request.base.mesh.cell_offsets = cell_offsets;
    request.base.mesh.cell_offsets_len = 7;
    request.base.mesh.cell_nodes = cell_nodes;
    request.base.mesh.cell_nodes_len = 24;
    request.base.mesh.facet_types = facet_types;
    request.base.mesh.facet_types_len = 12;
    request.base.mesh.facet_roles = facet_roles;
    request.base.mesh.facet_roles_len = 12;
    request.base.mesh.facet_offsets = facet_offsets;
    request.base.mesh.facet_offsets_len = 13;
    request.base.mesh.facet_nodes = facet_nodes;
    request.base.mesh.facet_nodes_len = 36;
    request.base.mesh.facet_markers = facet_markers;
    request.base.mesh.facet_markers_len = 12;
    request.base.charge_conductivity_spm_per_element = conductivity;
    request.base.charge_conductivity_spm_per_element_len = 6;
    request.base.magnetization_xyz = magnetization;
    request.base.magnetization_xyz_len = 24;
    request.base.sigma_s_spm = 5.0;
    request.base.polarization_p = 0.25;
    request.base.theta_sh = 0.0;
    request.base.lambda_sf_m = std::numeric_limits<double>::infinity();
    request.base.has_lambda_j = 0;
    request.base.has_lambda_phi = 0;
    request.base.gamma_e_per_ts = 1.76085963023e11;
    request.base.saturation_magnetization_apm = 8.0e5;
    request.base.relative_tolerance = 1.0e-11;
    request.base.absolute_tolerance = 0.0;
    request.base.maximum_iterations = 500;
    request.base.charge_dirichlet_boundary_attributes = dirichlet_attributes;
    request.base.charge_dirichlet_values_v = charge_values;
    request.base.charge_dirichlet_count = 2;
    request.base.spin_dirichlet_boundary_attributes = dirichlet_attributes;
    request.base.spin_dirichlet_values_v = spin_values;
    request.base.spin_dirichlet_count = 2;
    request.sigma_parallel_spm = 6.0;
    request.sigma_perpendicular_spm = 4.0;
    request.sigma_ahe_spm = 0.0;

    auto result = base_result();
    result.electric_potential_v = potential;
    result.electric_potential_v_len = 8;
    result.charge_current_density_xyz_apm2 = current;
    result.charge_current_density_xyz_apm2_len = 24;
    result.spin_potential_xyz_v = spin;
    result.spin_potential_xyz_v_len = 24;
    result.spin_current_tensor_row_major_qia_apm2 = spin_current;
    result.spin_current_tensor_row_major_qia_apm2_len = 72;
    result.torque_xyz_per_s = torque;
    result.torque_xyz_len = 24;

    const int status = fullmag_fem_solve_steady_transport_m2_v1(&request, &result);
    if (status != FULLMAG_FEM_OK) {
        std::cerr << "steady transport affine M2 solve error: " << result.error_message << '\n';
    }
    require(status == FULLMAG_FEM_OK, "affine reciprocal M2 transport solve failed");
    require(result.charge_converged != 0 && result.spin_converged != 0,
        "affine reciprocal M2 solve did not converge");

    constexpr double u[3] = {0.2, 0.3, 0.4};
    constexpr double sigma = 3.0;
    constexpr double sigma_parallel = 6.0;
    constexpr double sigma_spin = 5.0;
    constexpr double polarization = 0.25;
    constexpr double expected_charge_x[] = {
        -sigma_parallel - 0.5 * polarization * sigma * u[0],
        0.0,
        0.0,
    };
    constexpr double expected_spin_x[] = {
        -0.5 * sigma_spin * u[0] - polarization * sigma,
        -0.5 * sigma_spin * u[1],
        -0.5 * sigma_spin * u[2],
    };
    for (int node = 0; node < 8; ++node) {
        const double x = nodes[3 * node];
        require(std::abs(potential[node] - x) < 1.0e-8,
            "affine reciprocal M2 charge potential is not exact");
        for (int component = 0; component < 3; ++component) {
            require(std::abs(spin[3 * node + component] - u[component] * x) < 1.0e-8,
                "affine reciprocal M2 spin potential is not exact");
            require(std::abs(current[3 * node + component] - expected_charge_x[component]) < 1.0e-8,
                "affine reciprocal M2 charge current has the wrong constitutive value");
            for (int spin_component = 0; spin_component < 3; ++spin_component) {
                const double expected = component == 0
                    ? expected_spin_x[spin_component]
                    : 0.0;
                const int index = (node * 9) + (component * 3) + spin_component;
                require(std::abs(spin_current[index] - expected) < 1.0e-8,
                    "affine reciprocal M2 spin current has the wrong constitutive value");
            }
        }
    }

    // Two additional affine drives isolate the reciprocal P*sigma cross block.
    // The charge-only drive has E_x=-1 V/m and G_xx=0; the spin-only drive has
    // E_x=0 and G_xx=-1/2 V/m.  Reciprocity requires
    // J_x(G_xx)/G_xx = Q_xx(E_x)/E_x, while both diagonal powers must be positive.
    const auto solve_drive = [&]() {
        std::fill(std::begin(potential), std::end(potential), 0.0);
        std::fill(std::begin(current), std::end(current), 0.0);
        std::fill(std::begin(spin), std::end(spin), 0.0);
        std::fill(std::begin(spin_current), std::end(spin_current), 0.0);
        std::fill(std::begin(torque), std::end(torque), 0.0);
        const int drive_status = fullmag_fem_solve_steady_transport_m2_v1(&request, &result);
        if (drive_status != FULLMAG_FEM_OK) {
            std::cerr << "steady transport affine M2 drive error: " << result.error_message << '\n';
        }
        require(drive_status == FULLMAG_FEM_OK, "affine reciprocal M2 drive failed");
        require(result.charge_converged != 0 && result.spin_converged != 0,
            "affine reciprocal M2 drive did not converge");
    };
    const auto average_current_x = [&]() {
        double value = 0.0;
        for (int node = 0; node < 8; ++node) {
            value += current[3 * node];
        }
        return value / 8.0;
    };
    const auto average_spin_q_xx = [&]() {
        double value = 0.0;
        for (int node = 0; node < 8; ++node) {
            value += spin_current[9 * node];
        }
        return value / 8.0;
    };

    std::fill(std::begin(spin_values), std::end(spin_values), 0.0);
    charge_values[0] = 0.0;
    charge_values[1] = 1.0;
    solve_drive();
    const double charge_only_jx = average_current_x();
    const double charge_only_qxx = average_spin_q_xx();

    charge_values[0] = 0.0;
    charge_values[1] = 0.0;
    spin_values[3] = 1.0;
    solve_drive();
    const double spin_only_jx = average_current_x();
    const double spin_only_qxx = average_spin_q_xx();

    constexpr double charge_only_e = -1.0;
    constexpr double spin_only_g = -0.5;
    require(std::abs(charge_only_jx + sigma_parallel) < 1.0e-8,
        "charge-only affine reciprocal M2 current is not the expected diagonal response");
    require(std::abs(spin_only_qxx - sigma_spin * spin_only_g) < 1.0e-8,
        "spin-only affine reciprocal M2 current is not the expected diagonal response");
    require(std::abs(charge_only_qxx / charge_only_e - spin_only_jx / spin_only_g) < 1.0e-8,
        "affine reciprocal M2 cross response violates Onsager reciprocity");
    require(charge_only_e * charge_only_jx > 0.0 && spin_only_g * spin_only_qxx > 0.0,
        "affine reciprocal M2 diagonal response has negative dissipation");
}

} // namespace

int main()
{
    try {
        wrong_abi_version_fails_before_mesh_import();
        gpu_fails_closed_before_mesh_import();
        mixing_fails_closed_before_mesh_import();
        solved_current_oersted_public_boundary_does_not_claim_rt0();
        cpu_double_transparent_request_materializes_all_transport_fields();
        cpu_double_reciprocal_m2_request_is_explicit_and_fail_closed();
        const auto affine_oracle = &cpu_double_reciprocal_m2_affine_constitutive_oracle;
        affine_oracle();
        std::cout << "fem steady transport ABI contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem steady transport ABI contract: FAIL: " << error.what() << '\n';
        return 1;
    }
}
