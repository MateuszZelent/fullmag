#include "fullmag_fem.h"

#include <cstring>
#include <cmath>
#include <iostream>
#include <stdexcept>

namespace {

void require(bool condition, const char *message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
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

void cpu_double_transparent_request_materializes_all_transport_fields()
{
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const uint32_t elements[] = {0, 1, 2, 3};
    const uint32_t element_markers[] = {1};
    const uint32_t boundary_faces[] = {
        0, 2, 1,
        0, 1, 3,
        0, 3, 2,
        1, 2, 3,
    };
    const uint32_t boundary_markers[] = {1, 1, 1, 1};
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
    request.mesh.nodes_xyz = nodes;
    request.mesh.n_nodes = 4;
    request.mesh.elements = elements;
    request.mesh.n_elements = 1;
    request.mesh.element_markers = element_markers;
    request.mesh.boundary_faces = boundary_faces;
    request.mesh.n_boundary_faces = 4;
    request.mesh.boundary_markers = boundary_markers;
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

} // namespace

int main()
{
    try {
        wrong_abi_version_fails_before_mesh_import();
        gpu_fails_closed_before_mesh_import();
        mixing_fails_closed_before_mesh_import();
        cpu_double_transparent_request_materializes_all_transport_fields();
        std::cout << "fem steady transport ABI contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem steady transport ABI contract: FAIL: " << error.what() << '\n';
        return 1;
    }
}
