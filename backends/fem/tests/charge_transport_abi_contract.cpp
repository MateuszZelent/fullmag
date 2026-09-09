#include "fullmag_fem.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace {

void require(bool condition, const char *message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

static_assert(sizeof(fullmag_fem_charge_transport_request_v1) == 344);
static_assert(alignof(fullmag_fem_charge_transport_request_v1) == 8);
static_assert(offsetof(fullmag_fem_charge_transport_request_v1, mesh) == 48);
static_assert(offsetof(
    fullmag_fem_charge_transport_request_v1,
    charge_conductivity_spm_per_element) == 280);
static_assert(offsetof(
    fullmag_fem_charge_transport_request_v1,
    dirichlet_boundary_attributes) == 320);
static_assert(sizeof(fullmag_fem_charge_transport_result_v1) == 1392);
static_assert(alignof(fullmag_fem_charge_transport_result_v1) == 8);
static_assert(offsetof(
    fullmag_fem_charge_transport_result_v1,
    current_density_volume_average_apm2) == 88);
static_assert(offsetof(fullmag_fem_charge_transport_result_v1, error_message) == 112);
static_assert(sizeof(fullmag_fem_charge_transport_result_v2) == 1416);
static_assert(offsetof(
    fullmag_fem_charge_transport_result_v2,
    dirichlet_boundary_currents_a) == 1392);

constexpr double kNodes[] = {
    0.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    1.0, 1.0, 0.0,
    0.0, 1.0, 0.0,
    0.0, 0.0, 1.0,
    1.0, 0.0, 1.0,
    1.0, 1.0, 1.0,
    0.0, 1.0, 1.0,
};
constexpr uint32_t kCellTypes[] = {
    FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
    FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
    FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
};
constexpr uint32_t kCellOffsets[] = {0, 4, 8, 12, 16, 20, 24};
constexpr uint32_t kCellNodes[] = {
    0, 1, 2, 6,
    0, 2, 3, 6,
    0, 4, 5, 6,
    0, 5, 1, 6,
    0, 3, 7, 6,
    0, 7, 4, 6,
};
constexpr uint32_t kFacetTypes[] = {
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
};
constexpr uint32_t kFacetRoles[] = {
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
};
constexpr uint32_t kFacetOffsets[] = {
    0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36,
};
constexpr uint32_t kFacetNodes[] = {
    0, 7, 3, 0, 4, 7,
    1, 2, 6, 5, 1, 6,
    0, 1, 5, 0, 5, 4,
    2, 3, 6, 3, 7, 6,
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 7, 4, 6,
};
constexpr uint32_t kFacetMarkers[] = {
    1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
};
constexpr uint32_t kDirichletAttributes[] = {1, 2};

struct SolveBuffers {
    std::array<double, 8> potential{};
    std::array<double, 24> current{};
    fullmag_fem_charge_transport_result_v1 result{};

    SolveBuffers()
    {
        result.abi_version = FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION;
        result.struct_size = sizeof(result);
        result.electric_potential_v = potential.data();
        result.electric_potential_v_capacity = potential.size();
        result.charge_current_density_xyz_apm2 = current.data();
        result.charge_current_density_xyz_apm2_capacity = current.size();
    }
};

struct SolveBuffersV2 {
    std::array<double, 8> potential{};
    std::array<double, 24> current{};
    std::array<double, 2> terminal_currents{};
    fullmag_fem_charge_transport_result_v2 result{};

    SolveBuffersV2()
    {
        result.base.abi_version = FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION;
        result.base.struct_size = sizeof(result.base);
        result.base.electric_potential_v = potential.data();
        result.base.electric_potential_v_capacity = potential.size();
        result.base.charge_current_density_xyz_apm2 = current.data();
        result.base.charge_current_density_xyz_apm2_capacity = current.size();
        result.dirichlet_boundary_currents_a = terminal_currents.data();
        result.dirichlet_boundary_currents_a_capacity = terminal_currents.size();
    }
};

fullmag_fem_charge_transport_request_v1 base_request(
    const double *conductivity,
    const double *boundary_values)
{
    fullmag_fem_charge_transport_request_v1 request{};
    request.abi_version = FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE;
    request.charge_gauge = FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE;
    request.constitutive_version = FULLMAG_FEM_CHARGE_TRANSPORT_CONSTITUTIVE_VERSION;
    request.operator_version = FULLMAG_FEM_CHARGE_TRANSPORT_OPERATOR_VERSION;
    request.physical_residual_version =
        FULLMAG_FEM_CHARGE_TRANSPORT_PHYSICAL_RESIDUAL_VERSION;
    request.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    request.mesh.struct_size = sizeof(request.mesh);
    request.mesh.nodes_xyz = kNodes;
    request.mesh.nodes_xyz_len = std::size(kNodes);
    request.mesh.cell_types = kCellTypes;
    request.mesh.cell_types_len = std::size(kCellTypes);
    request.mesh.cell_offsets = kCellOffsets;
    request.mesh.cell_offsets_len = std::size(kCellOffsets);
    request.mesh.cell_nodes = kCellNodes;
    request.mesh.cell_nodes_len = std::size(kCellNodes);
    request.mesh.facet_types = kFacetTypes;
    request.mesh.facet_types_len = std::size(kFacetTypes);
    request.mesh.facet_roles = kFacetRoles;
    request.mesh.facet_roles_len = std::size(kFacetRoles);
    request.mesh.facet_offsets = kFacetOffsets;
    request.mesh.facet_offsets_len = std::size(kFacetOffsets);
    request.mesh.facet_nodes = kFacetNodes;
    request.mesh.facet_nodes_len = std::size(kFacetNodes);
    request.mesh.facet_markers = kFacetMarkers;
    request.mesh.facet_markers_len = std::size(kFacetMarkers);
    request.charge_conductivity_spm_per_element = conductivity;
    request.charge_conductivity_spm_per_element_len = std::size(kCellTypes);
    request.relative_tolerance = 1.0e-12;
    request.maximum_iterations = 500;
    request.dirichlet_boundary_attributes = kDirichletAttributes;
    request.dirichlet_boundary_values_v = boundary_values;
    request.dirichlet_boundary_count = std::size(kDirichletAttributes);
    return request;
}

void malformed_headers_and_gpu_fail_closed()
{
    fullmag_fem_charge_transport_request_v1 request{};
    request.abi_version = FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION + 1;
    request.struct_size = sizeof(request);
    SolveBuffers buffers;
    int status = fullmag_fem_solve_charge_transport_v1(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_INVALID, "wrong charge-only ABI version was accepted");
    require(buffers.result.electric_potential_v_len == 0 &&
            buffers.result.charge_current_density_xyz_apm2_len == 0,
        "failed charge-only request published output lengths");
    require(std::strstr(buffers.result.error_message, "ABI") != nullptr,
        "wrong charge-only ABI version lacks a stable diagnostic");

    request.abi_version = FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION;
    request.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE;
    status = fullmag_fem_solve_charge_transport_v1(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_UNAVAILABLE,
        "charge-only GPU request silently fell back to CPU");
    require(std::strstr(buffers.result.error_message, "GPU") != nullptr,
        "charge-only GPU rejection lacks a stable diagnostic");
}

void affine_bar_has_exact_sign_and_linearity()
{
    constexpr std::array<double, 6> conductivity = {4.0, 4.0, 4.0, 4.0, 4.0, 4.0};
    double boundary_values[] = {0.0, 1.0};
    auto request = base_request(conductivity.data(), boundary_values);
    SolveBuffers positive;
    int status = fullmag_fem_solve_charge_transport_v1(&request, &positive.result);
    if (status != FULLMAG_FEM_OK) {
        std::cerr << "charge-only affine solve error: " << positive.result.error_message << '\n';
    }
    require(status == FULLMAG_FEM_OK, "charge-only affine bar solve failed");
    require(positive.result.charge_converged != 0, "charge-only affine solve did not converge");
    require(positive.result.electric_potential_v_len == positive.potential.size(),
        "charge-only potential length was not published");
    require(positive.result.charge_current_density_xyz_apm2_len == positive.current.size(),
        "charge-only current length was not published");
    require(std::isfinite(positive.result.charge_relative_residual),
        "charge-only relative residual is non-finite");
    require(std::abs(positive.result.net_boundary_current_a) < 1.0e-10,
        "charge-only affine bar violates global current balance");
    require(std::strstr(
                positive.result.diagnostics_json,
                "fem_charge_transport_diagnostics.v1") != nullptr,
        "charge-only versioned diagnostics were not published");

    for (std::size_t node = 0; node < positive.potential.size(); ++node) {
        require(std::abs(positive.potential[node] - kNodes[3 * node]) < 1.0e-9,
            "charge-only affine potential is not exact");
        require(std::abs(positive.current[3 * node] + 4.0) < 1.0e-9,
            "charge-only affine current has the wrong sign or magnitude");
        require(std::abs(positive.current[3 * node + 1]) < 1.0e-9 &&
                std::abs(positive.current[3 * node + 2]) < 1.0e-9,
            "charge-only affine current has a spurious transverse component");
    }
    require(std::abs(positive.result.current_density_volume_average_apm2[0] + 4.0) < 1.0e-9,
        "charge-only average current has the wrong sign or magnitude");

    boundary_values[1] = -2.0;
    SolveBuffers reversed;
    status = fullmag_fem_solve_charge_transport_v1(&request, &reversed.result);
    require(status == FULLMAG_FEM_OK, "reversed charge-only affine bar solve failed");
    for (std::size_t i = 0; i < positive.potential.size(); ++i) {
        require(std::abs(reversed.potential[i] + 2.0 * positive.potential[i]) < 1.0e-9,
            "charge-only potential violates drive linearity");
    }
    for (std::size_t i = 0; i < positive.current.size(); ++i) {
        require(std::abs(reversed.current[i] + 2.0 * positive.current[i]) < 1.0e-9,
            "charge-only current violates sign reversal or drive linearity");
    }
}

void invalid_material_and_capacity_fail_closed()
{
    std::array<double, 6> conductivity = {4.0, 4.0, -1.0, 4.0, 4.0, 4.0};
    const double boundary_values[] = {0.0, 1.0};
    auto request = base_request(conductivity.data(), boundary_values);
    SolveBuffers buffers;
    int status = fullmag_fem_solve_charge_transport_v1(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_INVALID,
        "charge-only solve accepted a negative conductivity");
    require(buffers.result.electric_potential_v_len == 0 &&
            buffers.result.charge_current_density_xyz_apm2_len == 0,
        "invalid charge-only material published output lengths");

    conductivity[2] = 4.0;
    buffers.result.electric_potential_v_capacity = 7;
    status = fullmag_fem_solve_charge_transport_v1(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_INVALID,
        "charge-only solve accepted an undersized potential buffer");
    require(std::strstr(buffers.result.error_message, "capacity") != nullptr,
        "undersized charge-only output lacks a stable diagnostic");
}

void terminal_current_v2_is_balanced_and_ordered_like_the_request()
{
    constexpr std::array<double, 6> conductivity = {4.0, 4.0, 4.0, 4.0, 4.0, 4.0};
    const double boundary_values[] = {0.0, 1.0};
    auto request = base_request(conductivity.data(), boundary_values);
    SolveBuffersV2 buffers;
    const int status = fullmag_fem_solve_charge_transport_v2(&request, &buffers.result);
    require(status == FULLMAG_FEM_OK, "charge-only terminal-current v2 solve failed");
    require(buffers.result.dirichlet_boundary_currents_a_len == 2,
        "charge-only terminal-current v2 length was not published");
    require(std::abs(buffers.terminal_currents[0] + buffers.terminal_currents[1]) < 1.0e-10,
        "charge-only terminal currents do not balance");
    require(std::abs(std::abs(buffers.terminal_currents[0]) - 4.0) < 1.0e-9,
        "charge-only terminal current has the wrong magnitude");
}

} // namespace

int main()
{
    try {
        malformed_headers_and_gpu_fail_closed();
        affine_bar_has_exact_sign_and_linearity();
        invalid_material_and_capacity_fail_closed();
        terminal_current_v2_is_balanced_and_ordered_like_the_request();
        std::cout << "fem charge transport ABI contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem charge transport ABI contract: FAIL: " << error.what() << '\n';
        return 1;
    }
}
