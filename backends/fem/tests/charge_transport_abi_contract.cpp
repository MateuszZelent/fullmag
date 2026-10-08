#include "fullmag_fem.h"

#include <array>
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

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
static_assert(offsetof(fullmag_fem_charge_transport_request_v3, base) == 16);
static_assert(offsetof(fullmag_fem_charge_transport_result_v3, base) == 16);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_terminal_v1) == 32);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_interface_v1) == 104);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_request_v1) == 360);
static_assert(sizeof(fullmag_fem_accepted_terminal_charge_result_v1) == 656);
static_assert(alignof(fullmag_fem_accepted_terminal_charge_request_v1) == 8);
static_assert(alignof(fullmag_fem_accepted_terminal_charge_result_v1) == 8);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_request_v1, mesh) == 24);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_request_v1, stable_vertex_identities) == 256);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_request_v1, maximum_iterations) == 352);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_result_v1, canonical_payload) == 16);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_result_v1, content_sha256) == 328);
static_assert(offsetof(fullmag_fem_accepted_terminal_charge_result_v1, error_message) == 393);
static_assert(sizeof(fullmag_fem_accepted_external_lead_boundary_v1) == 40);
static_assert(sizeof(fullmag_fem_accepted_external_lead_branch_v1) == 32);
static_assert(sizeof(fullmag_fem_accepted_external_lead_request_v1) == 496);
static_assert(sizeof(fullmag_fem_accepted_external_lead_result_v1) == 656);
static_assert(offsetof(fullmag_fem_accepted_external_lead_request_v1, charge) == 16);
static_assert(offsetof(fullmag_fem_accepted_external_lead_result_v1, canonical_payload) == 16);

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

struct SolveBuffersV3 {
    std::array<double, 8> potential{};
    std::array<double, 24> current{};
    std::array<double, 2> terminal_voltages{};
    std::array<double, 2> terminal_currents{};
    std::array<uint32_t, 2> gauges{};
    fullmag_fem_charge_transport_result_v3 result{};

    SolveBuffersV3()
    {
        result.abi_version = FULLMAG_FEM_CHARGE_TERMINAL_CURRENT_ABI_VERSION;
        result.struct_size = sizeof(result);
        result.base.abi_version = FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION;
        result.base.struct_size = sizeof(result.base);
        result.base.electric_potential_v = potential.data();
        result.base.electric_potential_v_capacity = potential.size();
        result.base.charge_current_density_xyz_apm2 = current.data();
        result.base.charge_current_density_xyz_apm2_capacity = current.size();
        result.terminal_voltages_v = terminal_voltages.data();
        result.terminal_voltages_v_capacity = terminal_voltages.size();
        result.measured_outward_currents_a = terminal_currents.data();
        result.measured_outward_currents_a_capacity = terminal_currents.size();
        result.gauge_terminal_indices = gauges.data();
        result.gauge_terminal_indices_capacity = gauges.size();
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

void terminal_current_v2_rejects_shared_h1_nodes()
{
    constexpr std::array<double, 6> conductivity = {4.0, 4.0, 4.0, 4.0, 4.0, 4.0};
    const double boundary_values[] = {0.0, 1.0};
    const uint32_t touching_attributes[] = {1, 3};
    auto request = base_request(conductivity.data(), boundary_values);
    request.dirichlet_boundary_attributes = touching_attributes;
    SolveBuffersV2 buffers;
    const int status = fullmag_fem_solve_charge_transport_v2(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_INVALID,
        "charge-only terminal-current v2 accepted touching H1 electrodes");
    require(std::strstr(buffers.result.base.error_message, "share an H1 node") != nullptr,
        "touching charge terminals lack a stable diagnostic");
    require(buffers.result.dirichlet_boundary_currents_a_len == 0 &&
            buffers.result.base.electric_potential_v_len == 0,
        "touching charge terminals published partial output");
}

void prescribed_terminal_current_v3_enforces_sign_and_gauge()
{
    constexpr std::array<double, 6> conductivity = {4.0, 4.0, 4.0, 4.0, 4.0, 4.0};
    const double boundary_values[] = {0.0, 1.0};
    const uint64_t offsets[] = {0, 1, 2};
    const uint32_t attributes[] = {1, 2};
    const double requested[] = {-4.0, 4.0};
    fullmag_fem_charge_transport_request_v3 request{};
    request.abi_version = FULLMAG_FEM_CHARGE_TERMINAL_CURRENT_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.base = base_request(conductivity.data(), boundary_values);
    request.base.dirichlet_boundary_attributes = nullptr;
    request.base.dirichlet_boundary_values_v = nullptr;
    request.base.dirichlet_boundary_count = 0;
    request.terminal_attribute_offsets = offsets;
    request.terminal_attribute_offsets_len = std::size(offsets);
    request.terminal_boundary_attributes = attributes;
    request.terminal_boundary_attributes_len = std::size(attributes);
    request.requested_outward_currents_a = requested;
    request.terminal_count = std::size(requested);
    SolveBuffersV3 buffers;
    int status = fullmag_fem_solve_charge_transport_v3(&request, &buffers.result);
    require(status == FULLMAG_FEM_OK, "prescribed terminal-current v3 solve failed");
    require(buffers.result.base.electric_potential_v_len == 8 &&
            buffers.result.base.charge_current_density_xyz_apm2_len == 24 &&
            buffers.result.terminal_voltages_v_len == 2 &&
            buffers.result.measured_outward_currents_a_len == 2 &&
            buffers.result.gauge_terminal_indices_len == 1,
        "prescribed terminal-current v3 lengths are wrong");
    require(buffers.gauges[0] == 0 &&
            std::abs(buffers.terminal_voltages[0]) < 1.0e-10 &&
            std::abs(buffers.terminal_voltages[1] + 1.0) < 1.0e-10,
        "prescribed terminal-current v3 chose the wrong gauge or voltage");
    require(std::abs(buffers.terminal_currents[0] + 4.0) < 1.0e-9 &&
            std::abs(buffers.terminal_currents[1] - 4.0) < 1.0e-9,
        "prescribed terminal-current v3 did not enforce signed outward flux");

    const double unbalanced[] = {-4.0, 3.0};
    request.requested_outward_currents_a = unbalanced;
    status = fullmag_fem_solve_charge_transport_v3(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_INVALID,
        "prescribed terminal-current v3 accepted net current on a component");
    require(buffers.result.terminal_voltages_v_len == 0 &&
            buffers.result.base.electric_potential_v_len == 0,
        "failed prescribed-current v3 solve published partial lengths");

    request.requested_outward_currents_a = requested;
    request.abi_version += 1;
    status = fullmag_fem_solve_charge_transport_v3(&request, &buffers.result);
    require(status == FULLMAG_FEM_ERR_INVALID &&
            std::strstr(buffers.result.base.error_message, "ABI header") != nullptr,
        "prescribed terminal-current v3 accepted an incompatible ABI header");
}

using Bytes = std::vector<uint8_t>;

uint32_t rotate_right(uint32_t value, unsigned count)
{
    return (value >> count) | (value << (32u - count));
}

std::string accepted_payload_sha256(const Bytes &message)
{
    static constexpr std::array<uint32_t, 64> k{
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
    Bytes padded = message;
    const uint64_t bit_length = static_cast<uint64_t>(message.size()) * 8u;
    padded.push_back(0x80u);
    while ((padded.size() % 64u) != 56u) {
        padded.push_back(0u);
    }
    for (int shift = 56; shift >= 0; shift -= 8) {
        padded.push_back(static_cast<uint8_t>(bit_length >> shift));
    }
    std::array<uint32_t, 8> h{0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
        0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    for (std::size_t offset = 0; offset < padded.size(); offset += 64u) {
        std::array<uint32_t, 64> w{};
        for (std::size_t i = 0; i < 16; ++i) {
            const std::size_t p = offset + 4u * i;
            w[i] = (static_cast<uint32_t>(padded[p]) << 24u) |
                (static_cast<uint32_t>(padded[p + 1]) << 16u) |
                (static_cast<uint32_t>(padded[p + 2]) << 8u) |
                static_cast<uint32_t>(padded[p + 3]);
        }
        for (std::size_t i = 16; i < 64; ++i) {
            const uint32_t s0 = rotate_right(w[i - 15], 7) ^
                rotate_right(w[i - 15], 18) ^ (w[i - 15] >> 3u);
            const uint32_t s1 = rotate_right(w[i - 2], 17) ^
                rotate_right(w[i - 2], 19) ^ (w[i - 2] >> 10u);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        auto [a,b,c,d,e,f,g,hh] = h;
        for (std::size_t i = 0; i < 64; ++i) {
            const uint32_t s1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^
                rotate_right(e, 25);
            const uint32_t choice = (e & f) ^ ((~e) & g);
            const uint32_t temp1 = hh + s1 + choice + k[i] + w[i];
            const uint32_t s0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^
                rotate_right(a, 22);
            const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t temp2 = s0 + majority;
            hh = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d;
        h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    static constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(64);
    for (const uint32_t word : h) {
        for (int shift = 28; shift >= 0; shift -= 4) {
            result.push_back(hex[(word >> shift) & 0x0fu]);
        }
    }
    return result;
}

struct AcceptedChargeFixture {
    std::vector<double> nodes, sigma;
    std::vector<uint32_t> cells, cell_offsets{0}, facets, facet_offsets{0};
    std::vector<uint32_t> cell_types, facet_types, facet_roles, markers;
    std::vector<uint64_t> ids, left_faces, right_faces;
    std::array<fullmag_fem_accepted_terminal_charge_terminal_v1, 2> terminals{};
    fullmag_fem_accepted_terminal_charge_request_v1 request{};
    AcceptedChargeFixture()
    {
        nodes.assign(std::begin(kNodes), std::end(kNodes));
        for (std::size_t vertex = 0; vertex < 8; ++vertex) nodes[3 * vertex] *= 0.5;
        for (int vertex : {1, 2, 5, 6}) nodes.insert(nodes.end(), kNodes + 3 * vertex, kNodes + 3 * vertex + 3);
        const std::array<uint32_t, 8> second{1, 8, 9, 2, 5, 10, 11, 6};
        for (unsigned slab = 0; slab < 2; ++slab) {
            for (unsigned element = 0; element < 6; ++element) {
                for (unsigned corner = 0; corner < 4; ++corner) {
                    const auto vertex = kCellNodes[4 * element + corner];
                    cells.push_back(slab == 0 ? vertex : second[vertex]);
                }
                cell_offsets.push_back(cells.size());
                cell_types.push_back(FULLMAG_FEM_CELL_TET4);
                sigma.push_back(slab == 0 ? 4.0 : 8.0);
            }
            for (unsigned face = 0; face < 12; ++face) {
                if ((slab == 0 && (face == 2 || face == 3)) || (slab == 1 && face < 2)) continue;
                for (unsigned corner = 0; corner < 3; ++corner) {
                    const auto vertex = kFacetNodes[3 * face + corner];
                    facets.push_back(slab == 0 ? vertex : second[vertex]);
                }
                facet_offsets.push_back(facets.size());
                facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
                facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR);
                markers.push_back(kFacetMarkers[face]);
            }
        }
        for (uint64_t vertex = 0; vertex < 12; ++vertex) ids.push_back(100 + vertex);
        left_faces = {100, 103, 107, 100, 104, 107};
        right_faces = {108, 109, 111, 108, 110, 111};
        terminals = {{{"left", left_faces.data(), 2, -1.0}, {"right", right_faces.data(), 2, 1.0}}};
        request.abi_version = FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION;
        request.struct_size = sizeof(request);
        request.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE;
        request.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        request.mesh.struct_size = sizeof(request.mesh);
        request.mesh.nodes_xyz = nodes.data(); request.mesh.nodes_xyz_len = nodes.size();
        request.mesh.cell_types = cell_types.data(); request.mesh.cell_types_len = cell_types.size();
        request.mesh.cell_offsets = cell_offsets.data(); request.mesh.cell_offsets_len = cell_offsets.size();
        request.mesh.cell_nodes = cells.data(); request.mesh.cell_nodes_len = cells.size();
        request.mesh.facet_types = facet_types.data(); request.mesh.facet_types_len = facet_types.size();
        request.mesh.facet_roles = facet_roles.data(); request.mesh.facet_roles_len = facet_roles.size();
        request.mesh.facet_offsets = facet_offsets.data(); request.mesh.facet_offsets_len = facet_offsets.size();
        request.mesh.facet_nodes = facets.data(); request.mesh.facet_nodes_len = facets.size();
        request.mesh.facet_markers = markers.data(); request.mesh.facet_markers_len = markers.size();
        request.stable_vertex_identities = {"fixture-real-ids.v1", ids.data(), ids.size()};
        request.conductivity_spm_per_element = sigma.data(); request.conductivity_spm_per_element_len = sigma.size();
        request.terminals = terminals.data(); request.terminal_count = terminals.size();
        request.absolute_jump_tolerance_v = 1.0e-12;
        request.relative_jump_tolerance = 1.0e-12;
        request.algebraic_relative_tolerance = 1.0e-12;
        request.maximum_iterations = 1000;
    }
};

struct AcceptedChargeBuffers {
    std::vector<uint8_t> payload = std::vector<uint8_t>(1u << 20, 0xa5);
    fullmag_fem_accepted_terminal_charge_result_v1 result{};
    AcceptedChargeBuffers()
    {
        result.abi_version = FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION;
        result.struct_size = sizeof(result);
        result.canonical_payload = payload.data(); result.canonical_payload_capacity = payload.size();
        result.canonical_payload_len = 17;
        for (auto *text : {result.digest_schema, result.operator_version, result.layout_fingerprint, result.content_sha256}) std::strcpy(text, "stale");
    }
};

void require_accepted_charge_failure(const fullmag_fem_accepted_terminal_charge_request_v1 *request,
    AcceptedChargeBuffers &buffers, int expected, const char *fragment)
{
    require(fullmag_fem_solve_accepted_terminal_charge_v1(request, &buffers.result) == expected,
        "accepted charge ABI returned an incorrect failure status");
    require(buffers.result.canonical_payload_len == 0 && buffers.result.digest_schema[0] == 0 &&
            buffers.result.operator_version[0] == 0 && buffers.result.layout_fingerprint[0] == 0 &&
            buffers.result.content_sha256[0] == 0,
        "accepted charge ABI error published stale length or identity");
    require(std::strstr(buffers.result.error_message, fragment) != nullptr,
        "accepted charge ABI error lost its specific diagnostic");
    require(std::all_of(buffers.payload.begin(), buffers.payload.end(), [](uint8_t byte) { return byte == 0xa5; }),
        "accepted charge ABI error partially wrote caller payload");
}

void accepted_charge_abi_headers_policies_and_gpu_fail_atomically()
{
    AcceptedChargeFixture fixture;
    const auto reject = [&](const auto &mutate, const char *fragment = "invalid", int status = FULLMAG_FEM_ERR_INVALID) {
        auto request = fixture.request;
        AcceptedChargeBuffers buffers;
        mutate(request, buffers.result);
        require_accepted_charge_failure(&request, buffers, status, fragment);
    };
    AcceptedChargeBuffers null_request;
    require_accepted_charge_failure(nullptr, null_request, FULLMAG_FEM_ERR_INVALID, "non-null");
    require(fullmag_fem_solve_accepted_terminal_charge_v1(&fixture.request, nullptr) == FULLMAG_FEM_ERR_INVALID,
        "accepted charge ABI accepted a null result");
    reject([](auto &r, auto &) { ++r.abi_version; }, "ABI header");
    reject([](auto &r, auto &) { --r.struct_size; }, "ABI header");
    reject([](auto &r, auto &) { r.reserved_flags = 1; }, "ABI header");
    reject([](auto &, auto &r) { ++r.abi_version; }, "ABI header");
    reject([](auto &, auto &r) { ++r.struct_size; }, "ABI header");
    reject([](auto &, auto &r) { r.reserved_flags = 1; }, "ABI header");
    reject([](auto &r, auto &) { r.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE; }, "GPU", FULLMAG_FEM_ERR_UNAVAILABLE);
    reject([](auto &r, auto &) { r.execution_lane = static_cast<fullmag_fem_steady_transport_execution_lane>(99); });
    reject([](auto &r, auto &) { r.reserved_execution = 1; });
    reject([](auto &r, auto &) { r.reserved_solver = 1; });
    reject([](auto &, auto &r) { r.canonical_payload = nullptr; });
    reject([](auto &, auto &r) { r.canonical_payload_capacity = 0; });
    reject([](auto &, auto &r) { r.canonical_payload_capacity = FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_MAX_PAYLOAD_BYTES + 1; });
    reject([](auto &r, auto &) { r.maximum_iterations = 0; });
    reject([](auto &r, auto &) { r.maximum_iterations = UINT32_MAX; });
    for (double value : {-1.0, std::numeric_limits<double>::quiet_NaN()}) {
        reject([&](auto &r, auto &) { r.absolute_jump_tolerance_v = value; });
    }
    for (double value : {-1.0, std::numeric_limits<double>::infinity()}) {
        reject([&](auto &r, auto &) { r.relative_jump_tolerance = value; });
    }
    for (double value : {0.0, 1.0, std::numeric_limits<double>::quiet_NaN()}) {
        reject([&](auto &r, auto &) { r.algebraic_relative_tolerance = value; });
    }
    reject([](auto &, auto &r) { r.canonical_payload_capacity = 1; }, "capacity is insufficient");
}

void accepted_charge_abi_mesh_and_descriptors_fail_closed()
{
    const auto reject = [](const auto &mutate, const char *fragment, int status = FULLMAG_FEM_ERR_INVALID) {
        AcceptedChargeFixture fixture;
        AcceptedChargeBuffers buffers;
        mutate(fixture);
        require_accepted_charge_failure(&fixture.request, buffers, status, fragment);
    };
    reject([](auto &f) { ++f.request.mesh.abi_version; }, "mesh ABI");
    reject([](auto &f) { --f.request.mesh.struct_size; }, "mesh ABI");
    reject([](auto &f) { f.request.mesh.nodes_xyz = nullptr; }, "node");
    reject([](auto &f) { f.request.mesh.facet_roles = nullptr; }, "role pointer/count");
    reject([](auto &f) { f.request.mesh.facet_roles_len = 1; }, "role pointer/count");
    reject([](auto &f) { --f.request.mesh.cell_nodes_len; }, "complete tet4/tri3 CSR");
    reject([](auto &f) { --f.request.mesh.facet_nodes_len; }, "complete tet4/tri3 CSR");
    reject([](auto &f) { f.cell_offsets[0] = 1; }, "cell");
    reject([](auto &f) { f.facet_offsets[0] = 1; }, "CSR");
    reject([](auto &f) { f.facet_offsets[1] = 2; }, "CSR");
    reject([](auto &f) { f.facets[0] = 99; }, "outside the mesh");
    reject([](auto &f) { f.cells[0] = f.cells[1]; }, "repeats a vertex");
    reject([](auto &f) { std::copy_n(f.facets.begin(), 3, f.facets.begin() + 3); }, "facet is repeated");
    reject([](auto &f) { f.facet_roles[0] = 99; }, "unknown role");
    reject([](auto &f) {
        --f.request.mesh.facet_types_len; --f.request.mesh.facet_roles_len;
        --f.request.mesh.facet_offsets_len; --f.request.mesh.facet_markers_len;
        f.request.mesh.facet_nodes_len -= 3;
    }, "exterior boundary is incomplete");
    reject([](auto &f) { f.facet_roles[0] = FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE; }, "must be an interior face");
    reject([](auto &f) { f.markers[0] = 0; }, "positive");
    reject([](auto &f) { f.nodes[0] = std::numeric_limits<double>::infinity(); }, "coordinates must be finite");
    reject([](auto &f) { f.request.mesh.cell_markers_len = 1; }, "optional mesh arrays");
    reject([](auto &f) { f.request.mesh.periodic_node_pairs_len = 2; }, "periodic mesh metadata", FULLMAG_FEM_ERR_UNAVAILABLE);
    reject([](auto &f) { f.facet_roles[0] = FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM; }, "periodic seams", FULLMAG_FEM_ERR_UNAVAILABLE);
    reject([](auto &f) { std::fill(f.facet_roles.begin(), f.facet_roles.end(), FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM); }, "periodic seams", FULLMAG_FEM_ERR_UNAVAILABLE);
    reject([](auto &f) { --f.request.conductivity_spm_per_element_len; }, "conductivity count");
    reject([](auto &f) { f.sigma[0] = -1; }, "finite and positive");
    reject([](auto &f) { f.ids[0] = f.ids[1]; }, "nonzero and unique");
    reject([](auto &f) { f.request.stable_vertex_identities.local_to_stable_vertex_ids_len = 1; }, "count must equal");
    reject([](auto &f) { f.request.terminals = nullptr; }, "pointer/count");
    reject([](auto &f) { f.request.interface_count = 1; }, "pointer/count");
    reject([](auto &f) { f.terminals[0].boundary_face_vertex_ids = nullptr; }, "face pointer/count");
    reject([](auto &f) { f.terminals[0].requested_outward_current_a = std::numeric_limits<double>::quiet_NaN(); }, "current is invalid");
    reject([](auto &f) { f.terminals[0].id = nullptr; }, "terminal ID must not be null");
    reject([](auto &f) { f.terminals[1].requested_outward_current_a = 0.75; }, "balance");
}

void accepted_charge_truncated_result_keeps_prefix_and_canary_untouched()
{
    AcceptedChargeFixture fixture;
    struct alignas(8) TruncatedResult {
        uint32_t abi_version = FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION;
        uint32_t reserved_flags = 0;
        uint64_t struct_size = 16;
        std::array<uint8_t, 32> canary{};
    } truncated;
    truncated.canary.fill(0xa7);
    std::array<uint8_t, sizeof(truncated)> before{};
    std::memcpy(before.data(), &truncated, before.size());
    const int status = fullmag_fem_solve_accepted_terminal_charge_v1(&fixture.request,
        reinterpret_cast<fullmag_fem_accepted_terminal_charge_result_v1 *>(&truncated));
    require(status == FULLMAG_FEM_ERR_INVALID && std::memcmp(before.data(), &truncated, before.size()) == 0,
        "accepted charge ABI wrote beyond its truncated result prefix or changed its canary");
}

void accepted_charge_layered_record_has_exact_sha_and_signed_payload()
{
    require(accepted_payload_sha256(Bytes{'a', 'b', 'c'}) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "accepted charge payload SHA oracle failed its known-answer abc check");
    AcceptedChargeFixture fixture;
    const auto solve = [&](double sign) {
        fixture.terminals[0].requested_outward_current_a = -sign;
        fixture.terminals[1].requested_outward_current_a = sign;
        AcceptedChargeBuffers buffers;
        const int status = fullmag_fem_solve_accepted_terminal_charge_v1(&fixture.request, &buffers.result);
        if (status != FULLMAG_FEM_OK) std::cerr << "accepted charge ABI error: " << buffers.result.error_message << '\n';
        require(status == FULLMAG_FEM_OK && buffers.result.canonical_payload_len > 0 &&
                buffers.result.canonical_payload_len <= buffers.payload.size() && buffers.result.error_message[0] == 0,
            "accepted layered charge ABI solve did not publish a complete owned record");
        require(std::strcmp(buffers.result.digest_schema, "accepted_terminal_charge_source.ordered.v1") == 0 &&
                std::strcmp(buffers.result.operator_version, "fem_accepted_terminal_charge_source.v1") == 0 &&
                std::strcmp(buffers.result.layout_fingerprint, FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_LAYOUT_FINGERPRINT) == 0,
            "accepted charge ABI record identity or fingerprint is incorrect");
        const Bytes payload(buffers.payload.begin(), buffers.payload.begin() + buffers.result.canonical_payload_len);
        require(accepted_payload_sha256(payload) == buffers.result.content_sha256,
            "accepted charge ABI content SHA does not match exact published bytes");
        require(std::all_of(buffers.payload.begin() + payload.size(), buffers.payload.end(), [](uint8_t value) { return value == 0xa5; }),
            "accepted charge ABI wrote beyond its published payload");
        std::size_t cursor = 0;
        const auto read_u64 = [&]() {
            require(cursor <= payload.size() && payload.size() - cursor >= 8, "accepted payload BE64 is truncated");
            uint64_t value = 0;
            for (int byte = 0; byte < 8; ++byte) value = (value << 8) | payload[cursor++];
            return value;
        };
        std::vector<uint64_t> vertex_ids;
        std::vector<double> potentials, sigmas, requested, h1, rt0, voltages;
        std::vector<std::string> terminal_ids;
        unsigned schema_count = 0, operator_count = 0;
        while (cursor < payload.size()) {
            const auto name_size = read_u64();
            require(name_size <= payload.size() - cursor, "accepted payload field name is truncated");
            const std::string name(payload.begin() + cursor, payload.begin() + cursor + name_size);
            cursor += name_size;
            require(cursor < payload.size(), "accepted payload type is missing");
            const uint8_t type = payload[cursor++];
            const auto size = read_u64();
            require(size <= payload.size() - cursor && (type == 1 || type == 2 || type == 4),
                "accepted payload field has invalid type or bounds");
            if (type == 1) {
                const std::string value(payload.begin() + cursor, payload.begin() + cursor + size);
                cursor += size;
                if (name == "schema") { ++schema_count; require(value == buffers.result.digest_schema, "payload schema differs from ABI metadata"); }
                if (name == "operator") { ++operator_count; require(value == buffers.result.operator_version, "payload operator differs from ABI metadata"); }
                if (name == "terminal_id") terminal_ids.push_back(value);
            } else {
                require(size == 8, "accepted payload scalar is not exactly eight bytes");
                const auto bits = read_u64();
                if (type == 2) {
                    if (name == "vertex_id") vertex_ids.push_back(bits);
                } else {
                    double value = 0;
                    std::memcpy(&value, &bits, sizeof(value));
                    require(std::isfinite(value), "accepted payload contains a nonfinite owned scalar");
                    if (name == "potential_v") potentials.push_back(value);
                    if (name == "conductivity_spm") sigmas.push_back(value);
                    if (name == "requested_current_a") requested.push_back(value);
                    if (name == "h1_current_a") h1.push_back(value);
                    if (name == "rt0_current_a") rt0.push_back(value);
                    if (name == "terminal_voltage_v") voltages.push_back(value);
                }
            }
        }
        require(cursor == payload.size() && schema_count == 1 && operator_count == 1 &&
                potentials.size() == fixture.ids.size() && sigmas == fixture.sigma &&
                vertex_ids.size() >= fixture.ids.size() && std::equal(fixture.ids.begin(), fixture.ids.end(), vertex_ids.begin()),
            "accepted payload lost owned V, element order/material or real stable vertex identities");
        require(terminal_ids == std::vector<std::string>({"left", "right", "left"}) &&
                requested.size() == 2 && h1.size() == 2 && rt0.size() == 2 && voltages.size() == 2,
            "accepted payload terminal order/reference or current lengths are incorrect");
        for (std::size_t vertex = 0; vertex < fixture.ids.size(); ++vertex) {
            const double x = fixture.nodes[3 * vertex];
            const double expected = sign * (x <= 0.5 ? -x / 4 : -0.125 - (x - 0.5) / 8);
            require(std::abs(potentials[vertex] - expected) < 1.0e-10, "accepted payload V disagrees with sigma4/8 series conductor");
        }
        for (std::size_t terminal = 0; terminal < 2; ++terminal) {
            const double expected = terminal == 0 ? -sign : sign;
            const double gate = 1.0e-18 + 1.0e-8 * std::abs(expected);
            require(requested[terminal] == expected && std::abs(h1[terminal] - expected) <= gate &&
                    std::abs(rt0[terminal] - expected) <= gate,
                "accepted payload H1/RT0 did not retain every signed requested current");
        }
        require(std::abs(voltages[0]) < 1.0e-10 && std::abs(voltages[1] + 3 * sign / 16) < 1.0e-10,
            "accepted layered voltage differs from R=0.5/4+0.5/8 ohm");
        auto altered = payload;
        altered.back() ^= 1;
        require(accepted_payload_sha256(altered) != buffers.result.content_sha256,
            "accepted payload SHA did not detect an altered owned record byte");
        return payload;
    };
    const auto positive = solve(1.0);
    require(solve(1.0) == positive, "equivalent accepted ABI request changed exact owned payload bytes");
    require(solve(-1.0) != positive, "reversed accepted ABI request retained the positive owned payload");
    (void)solve(0.0);
}

struct ExternalLeadAbiFixture {
    AcceptedChargeFixture charge;
    std::vector<uint64_t> device, lead;
    std::vector<fullmag_fem_accepted_terminal_charge_interface_v1> interfaces;
    std::vector<std::string> interface_ids;
    std::vector<fullmag_fem_accepted_external_lead_boundary_v1> boundaries;
    std::array<std::vector<const char *>, 2> pair_ids;
    std::array<fullmag_fem_accepted_external_lead_branch_v1, 2> branches{};
    std::array<double, 3> target{4.0, 2.0, 2.0};
    fullmag_fem_accepted_external_lead_request_v1 request{};
    ExternalLeadAbiFixture()
    {
        AcceptedChargeFixture bar;
        charge.nodes.clear(); charge.cells.clear(); charge.facets.clear(); charge.sigma.clear();
        charge.cell_offsets = {0}; charge.facet_offsets = {0};
        charge.cell_types.clear(); charge.facet_types.clear(); charge.facet_roles.clear(); charge.markers.clear();
        charge.ids.clear(); charge.left_faces.clear(); charge.right_faces.clear();
        for (unsigned block = 0; block < 3; ++block) {
            for (std::size_t vertex = 0; vertex < bar.ids.size(); ++vertex) {
                charge.nodes.insert(charge.nodes.end(), {bar.nodes[3 * vertex] + block, bar.nodes[3 * vertex + 1], bar.nodes[3 * vertex + 2]});
                const uint64_t id = 100 + charge.ids.size(); charge.ids.push_back(id);
                (block == 1 ? device : lead).push_back(id);
            }
            for (std::size_t element = 0; element < bar.sigma.size(); ++element) {
                for (unsigned corner = 0; corner < 4; ++corner) charge.cells.push_back(bar.cells[4 * element + corner] + 12 * block);
                charge.cell_offsets.push_back(charge.cells.size()); charge.cell_types.push_back(FULLMAG_FEM_CELL_TET4); charge.sigma.push_back(4.0);
            }
            for (std::size_t face = 0; face < bar.markers.size(); ++face) {
                for (unsigned corner = 0; corner < 3; ++corner) charge.facets.push_back(bar.facets[3 * face + corner] + 12 * block);
                charge.facet_offsets.push_back(charge.facets.size()); charge.facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
                charge.facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR); charge.markers.push_back(bar.markers[face]);
            }
        }
        interfaces.reserve(4); interface_ids.reserve(4);
        for (std::size_t face = 0; face < charge.markers.size(); ++face) {
            const auto *vertices = charge.facets.data() + 3 * face;
            const double x = charge.nodes[3 * vertices[0]];
            if (vertices[0] < 12 || vertices[0] >= 24 || (x != 1.0 && x != 2.0) ||
                charge.nodes[3 * vertices[1]] != x || charge.nodes[3 * vertices[2]] != x) continue;
            fullmag_fem_accepted_terminal_charge_interface_v1 pair{};
            interface_ids.push_back("device-lead:" + std::to_string(interfaces.size()));
            for (unsigned corner = 0; corner < 3; ++corner) {
                unsigned match = 36;
                for (unsigned other = 0; other < 36; ++other) {
                    if (other >= 12 && other < 24) continue;
                    if (std::equal(charge.nodes.begin() + 3 * vertices[corner], charge.nodes.begin() + 3 * vertices[corner] + 3,
                            charge.nodes.begin() + 3 * other)) match = other;
                }
                require(match < 36, "bundle fixture lacks actual coincident lead vertex");
                pair.first_face_vertex_ids[corner] = charge.ids[vertices[corner]];
                pair.second_face_vertex_ids[corner] = charge.ids[match];
                pair.vertex_pairs[corner][0] = charge.ids[vertices[corner]]; pair.vertex_pairs[corner][1] = charge.ids[match];
            }
            std::sort(std::begin(pair.first_face_vertex_ids), std::end(pair.first_face_vertex_ids));
            std::sort(std::begin(pair.second_face_vertex_ids), std::end(pair.second_face_vertex_ids)); interfaces.push_back(pair);
        }
        require(interfaces.size() == 4, "bundle fixture does not cover both complete interfaces");
        for (std::size_t i = 0; i < interfaces.size(); ++i) {
            interfaces[i].id = interface_ids[i].c_str();
            const auto id = interfaces[i].vertex_pairs[0][0];
            pair_ids[charge.nodes[3 * (id - 100)] == 1.0 ? 0 : 1].push_back(interfaces[i].id);
        }
        for (std::size_t face = 0; face < charge.markers.size(); ++face) {
            fullmag_fem_accepted_external_lead_boundary_v1 boundary{};
            for (unsigned corner = 0; corner < 3; ++corner) boundary.vertex_ids[corner] = charge.ids[charge.facets[3 * face + corner]];
            std::sort(std::begin(boundary.vertex_ids), std::end(boundary.vertex_ids));
            boundary.role = FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_BOUNDARY_INSULATING; boundary.circuit_id = "";
            const auto vertex = charge.facets[3 * face]; const double x = charge.nodes[3 * vertex];
            if ((x == 0.0 || x == 3.0) && charge.nodes[3 * charge.facets[3 * face + 1]] == x && charge.nodes[3 * charge.facets[3 * face + 2]] == x) {
                boundary.role = FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_BOUNDARY_OUTER_ELECTRODE; boundary.circuit_id = x == 0.0 ? "left" : "right";
                auto &keys = x == 0.0 ? charge.left_faces : charge.right_faces;
                keys.insert(keys.end(), std::begin(boundary.vertex_ids), std::end(boundary.vertex_ids));
            }
            for (const auto &pair : interfaces) {
                if (std::equal(std::begin(boundary.vertex_ids), std::end(boundary.vertex_ids), pair.first_face_vertex_ids) ||
                    std::equal(std::begin(boundary.vertex_ids), std::end(boundary.vertex_ids), pair.second_face_vertex_ids)) {
                    boundary.role = FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_BOUNDARY_DEVICE_INTERFACE; boundary.circuit_id = pair.id;
                }
            }
            boundaries.push_back(boundary);
        }
        charge.terminals = {{{"left", charge.left_faces.data(), 2, -1.0}, {"right", charge.right_faces.data(), 2, 1.0}}};
        auto &r = charge.request; auto &m = r.mesh;
        m.nodes_xyz = charge.nodes.data(); m.nodes_xyz_len = charge.nodes.size();
        m.cell_types = charge.cell_types.data(); m.cell_types_len = charge.cell_types.size();
        m.cell_offsets = charge.cell_offsets.data(); m.cell_offsets_len = charge.cell_offsets.size();
        m.cell_nodes = charge.cells.data(); m.cell_nodes_len = charge.cells.size();
        m.facet_types = charge.facet_types.data(); m.facet_types_len = charge.facet_types.size();
        m.facet_roles = charge.facet_roles.data(); m.facet_roles_len = charge.facet_roles.size();
        m.facet_offsets = charge.facet_offsets.data(); m.facet_offsets_len = charge.facet_offsets.size();
        m.facet_nodes = charge.facets.data(); m.facet_nodes_len = charge.facets.size();
        m.facet_markers = charge.markers.data(); m.facet_markers_len = charge.markers.size();
        r.stable_vertex_identities.local_to_stable_vertex_ids = charge.ids.data(); r.stable_vertex_identities.local_to_stable_vertex_ids_len = charge.ids.size();
        r.conductivity_spm_per_element = charge.sigma.data(); r.conductivity_spm_per_element_len = charge.sigma.size();
        r.terminals = charge.terminals.data(); r.interfaces = interfaces.data(); r.interface_count = interfaces.size();
        branches = {{{"device-left", pair_ids[0].data(), pair_ids[0].size(), -1.0}, {"device-right", pair_ids[1].data(), pair_ids[1].size(), 1.0}}};
        request.abi_version = FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_ABI_VERSION; request.struct_size = sizeof(request); request.charge = r;
        request.closure_revision = "three-cube-series.v1";
        request.device_vertex_ids = device.data(); request.device_vertex_count = device.size(); request.lead_vertex_ids = lead.data(); request.lead_vertex_count = lead.size();
        request.boundary_faces = boundaries.data(); request.boundary_face_count = boundaries.size(); request.branches = branches.data(); request.branch_count = branches.size();
        request.target_xyz_m = target.data(); request.target_count = 1; request.base_quadrature_order = 4; request.maximum_subdivision_depth = 6;
        request.absolute_tolerance_apm = 1e-9; request.relative_tolerance = 1e-5; request.maximum_source_target_pairs = 1'000'000;
    }
};

struct ExternalLeadAbiBuffers {
    Bytes payload = Bytes(1u << 20, 0xa5);
    fullmag_fem_accepted_external_lead_result_v1 result{};
    ExternalLeadAbiBuffers() {
        result.abi_version = FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_ABI_VERSION; result.struct_size = sizeof(result);
        result.canonical_payload = payload.data(); result.canonical_payload_capacity = payload.size(); result.canonical_payload_len = 17;
        for (auto *text : {result.digest_schema, result.operator_version, result.layout_fingerprint, result.content_sha256}) std::strcpy(text, "stale");
    }
};

struct BundleField { std::string name; uint8_t tag; Bytes bytes; };
std::vector<BundleField> read_bundle_fields(const Bytes &payload)
{
    std::size_t cursor = 0;
    const auto word = [&]() { require(cursor <= payload.size() && payload.size() - cursor >= 8, "bundle BE64 truncated"); uint64_t value = 0; for (int i = 0; i < 8; ++i) value = (value << 8) | payload[cursor++]; return value; };
    std::vector<BundleField> fields;
    while (cursor < payload.size()) {
        const auto length = word(); require(length <= payload.size() - cursor, "bundle name truncated");
        std::string name(payload.begin() + cursor, payload.begin() + cursor + length); cursor += length;
        require(cursor < payload.size(), "bundle tag missing"); const auto tag = payload[cursor++];
        const auto size = word(); require(size <= payload.size() - cursor && tag >= 1 && tag <= 4, "bundle value/tag invalid");
        fields.push_back({std::move(name), tag, Bytes(payload.begin() + cursor, payload.begin() + cursor + size)}); cursor += size;
    }
    return fields;
}

void external_lead_bundle_abi_keeps_nested_records_signed_and_owned()
{
    Bytes retained;
    {
        ExternalLeadAbiFixture fixture;
        const auto solve = [&](double current) {
            fixture.charge.terminals[0].requested_outward_current_a = -current; fixture.charge.terminals[1].requested_outward_current_a = current;
            fixture.branches[0].requested_device_outward_current_a = -current; fixture.branches[1].requested_device_outward_current_a = current;
            ExternalLeadAbiBuffers output;
            const auto status = fullmag_fem_solve_accepted_external_lead_field_v1(&fixture.request, &output.result);
            if (status != FULLMAG_FEM_OK) std::cerr << output.result.error_message << '\n';
            require(status == FULLMAG_FEM_OK && output.result.canonical_payload_len > 0 && output.result.canonical_payload_len <= output.payload.size(), "external bundle did not publish complete payload");
            Bytes payload(output.payload.begin(), output.payload.begin() + output.result.canonical_payload_len);
            require(accepted_payload_sha256(payload) == output.result.content_sha256 &&
                    std::strcmp(output.result.digest_schema, "accepted_external_lead_bundle.ordered.v1") == 0 &&
                    std::strcmp(output.result.operator_version, "fem_accepted_external_lead_bundle.v1") == 0 &&
                    std::strcmp(output.result.layout_fingerprint, FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_LAYOUT_FINGERPRINT) == 0,
                "bundle SHA/schema/operator/layout mismatch");
            require(std::all_of(output.payload.begin() + payload.size(), output.payload.end(), [](uint8_t byte) { return byte == 0xa5; }), "bundle wrote beyond published bytes");
            const auto fields = read_bundle_fields(payload);
            const std::array<const char *, 9> names{"schema", "operator_version", "field_scope", "charge_content_sha256", "charge_record", "source_content_sha256", "source_record", "field_content_sha256", "field_record"};
            require(fields.size() == names.size(), "bundle field cardinality differs from versioned framing");
            for (std::size_t i = 0; i < fields.size(); ++i) require(fields[i].name == names[i] && fields[i].tag == (i == 4 || i == 6 || i == 8 ? 3 : 1), "bundle field ordering/tag mismatch");
            require(std::string(fields[0].bytes.begin(), fields[0].bytes.end()) == "accepted_external_lead_bundle.ordered.v1" &&
                    std::string(fields[1].bytes.begin(), fields[1].bytes.end()) == "fem_accepted_external_lead_bundle.v1",
                "bundle outer schema/operator values differ from the versioned contract");
            require(std::string(fields[2].bytes.begin(), fields[2].bytes.end()) == "external_electrode_truncation", "bundle impersonated a full circuit scope");
            for (std::size_t i : {4u, 6u, 8u}) require(accepted_payload_sha256(fields[i].bytes) == std::string(fields[i - 1].bytes.begin(), fields[i - 1].bytes.end()), "nested binary record SHA mismatch");
            const std::array<const char *, 3> schemas{"accepted_terminal_charge_source.ordered.v1",
                "accepted_external_lead_current_source.ordered.v2", "accepted_external_lead_field.ordered.v2"};
            for (unsigned nested = 0; nested < schemas.size(); ++nested) {
                const auto decoded = read_bundle_fields(fields[4 + 2 * nested].bytes);
                require(!decoded.empty() && decoded.front().name == "schema" && decoded.front().tag == 1 &&
                        std::string(decoded.front().bytes.begin(), decoded.front().bytes.end()) == schemas[nested],
                    "nested binary record has an incorrect versioned schema");
            }
            const auto charge_sha = std::string(fields[3].bytes.begin(), fields[3].bytes.end());
            const auto source_sha = std::string(fields[5].bytes.begin(), fields[5].bytes.end());
            for (std::size_t record_index : {6u, 8u}) {
                bool charge_bound = false, source_bound = record_index == 6;
                for (const auto &field : read_bundle_fields(fields[record_index].bytes)) {
                    if (field.name == "charge_content_digest") charge_bound = field.tag == 1 && std::string(field.bytes.begin(), field.bytes.end()) == charge_sha;
                    if (field.name == "accepted_external_source_digest") source_bound = field.tag == 1 && std::string(field.bytes.begin(), field.bytes.end()) == source_sha;
                }
                require(charge_bound && source_bound, "nested source/field record does not pin exact preceding content SHA");
            }
            const auto scalar = [](const BundleField &field) {
                require(field.tag == 4 && field.bytes.size() == 8, "nested current has incorrect binary64 framing");
                uint64_t bits = 0; for (auto byte : field.bytes) bits = (bits << 8) | byte;
                double value = 0; std::memcpy(&value, &bits, 8);
                require(std::isfinite(value) && bits != (uint64_t{1} << 63), "nested scalar is nonfinite or negative zero");
                return value;
            };
            std::vector<double> requested, h1, rt0, volts, potentials, sigma, branch_h1, branch_rt0, target_xyz, h_xyz;
            for (const auto &field : read_bundle_fields(fields[4].bytes)) if (field.tag == 4) {
                const double value = scalar(field);
                if (field.name == "requested_current_a") requested.push_back(value);
                if (field.name == "h1_current_a") h1.push_back(value);
                if (field.name == "rt0_current_a") rt0.push_back(value);
                if (field.name == "terminal_voltage_v") volts.push_back(value);
                if (field.name == "potential_v") potentials.push_back(value);
                if (field.name == "conductivity_spm") sigma.push_back(value);
            }
            const auto source_fields = read_bundle_fields(fields[6].bytes);
            std::size_t weight_count = 0;
            bool source_operator_v2 = false;
            for (std::size_t i = 0; i < source_fields.size(); ++i) {
                const auto &field = source_fields[i];
                if (field.name == "operator_version") source_operator_v2 = field.tag == 1 &&
                    std::string(field.bytes.begin(), field.bytes.end()) == "fem_accepted_external_lead_current_source.v2";
                if (field.name == "face_rt0_to_canonical_weight") {
                    require(i > 0 && source_fields[i - 1].name == "face_side_count" && scalar(field) != 0.0,
                        "source v2 omitted its finite nonzero signed face basis weight or changed field order");
                    ++weight_count;
                }
            }
            require(source_operator_v2 && weight_count == (4 * fixture.charge.sigma.size() + fixture.boundaries.size()) / 2,
                "source v2 did not bind the actual RT0-to-canonical map of every physical face");
            for (const auto &field : source_fields) if (field.tag == 4) {
                const double value = scalar(field);
                if (field.name == "branch_h1_a") branch_h1.push_back(value);
                if (field.name == "branch_rt0_a") branch_rt0.push_back(value);
            }
            for (const auto &field : read_bundle_fields(fields[8].bytes)) if (field.tag == 4) {
                const double value = scalar(field);
                if (field.name == "target_coordinate_m") target_xyz.push_back(value);
                if (field.name == "h_component_apm") h_xyz.push_back(value);
            }
            require(requested == std::vector<double>({-current, current}), "bundle lost signed requested charge currents");
            require(h1.size() == 2 && rt0.size() == 2 && volts.size() == 2 && branch_h1.size() == 2 && branch_rt0.size() == 2 &&
                    potentials.size() == fixture.charge.ids.size() && sigma == fixture.charge.sigma &&
                    target_xyz == std::vector<double>(fixture.target.begin(), fixture.target.end()) && h_xyz.size() == 3,
                "bundle nested model/current/field cardinality or request binding is incorrect");
            for (unsigned side = 0; side < 2; ++side) {
                const double expected = side == 0 ? -current : current;
                const double gate = 1e-18 + 1e-8 * std::abs(expected);
                require(std::abs(h1[side] - expected) <= gate && std::abs(rt0[side] - expected) <= gate &&
                        std::abs(branch_h1[side] - expected) <= gate && std::abs(branch_rt0[side] - expected) <= gate,
                    "bundle H1/RT0 terminal or device-outward branch current has wrong sign");
            }
            const double conductivity = fixture.charge.sigma.front();
            require(std::abs(volts[0]) <= 1e-12 && std::abs(volts[1] + 3 * current / conductivity) <= 1e-10,
                "bundle whole-domain V disagrees with analytic three-cube series resistance");
            for (std::size_t vertex = 0; vertex < potentials.size(); ++vertex) {
                require(std::abs(potentials[vertex] + current * fixture.charge.nodes[3 * vertex] / conductivity) <= 1e-10,
                    "bundle P1 potential did not preserve the whole-domain accepted model");
            }
            if (current == 0.0) require(std::all_of(h_xyz.begin(), h_xyz.end(), [](double value) { return value == 0.0; }), "zero-drive bundle H is not zero");
            return payload;
        };
        retained = solve(1.0); require(solve(1.0) == retained, "repeated bundle request changed exact bytes");
        const auto negative = solve(-1.0);
        const auto doubled = solve(2.0);
        require(negative != retained && solve(0.0) != retained, "reverse/zero drive did not change bundle identity");
        const auto field_values = [](const Bytes &payload) {
            const auto outer = read_bundle_fields(payload);
            std::vector<double> values;
            for (const auto &field : read_bundle_fields(outer[8].bytes)) {
                if (field.name != "h_component_apm") continue;
                require(field.tag == 4 && field.bytes.size() == 8, "linearity oracle encountered malformed H binary64");
                uint64_t bits = 0; for (auto byte : field.bytes) bits = (bits << 8) | byte;
                double value = 0; std::memcpy(&value, &bits, 8); values.push_back(value);
            }
            require(values.size() == 3, "linearity oracle requires one vector at the unchanged far target");
            return values;
        };
        const auto positive_h = field_values(retained), negative_h = field_values(negative), doubled_h = field_values(doubled);
        double maximum_signal = 0.0;
        for (unsigned component = 0; component < 3; ++component) {
            maximum_signal = std::max(maximum_signal, std::abs(positive_h[component]));
            const auto gate = [](double expected, double measured) {
                return 1.0e-8 + 1.0e-4 * std::max(std::abs(expected), std::abs(measured));
            };
            require(std::abs(negative_h[component] + positive_h[component]) <= gate(-positive_h[component], negative_h[component]) &&
                    std::abs(doubled_h[component] - 2.0 * positive_h[component]) <= gate(2.0 * positive_h[component], doubled_h[component]),
                "bundle H violates odd current linearity with gate 1e-8 A/m + 1e-4*max(abs(expected),abs(measured))");
        }
        require(maximum_signal > 1.0e-8, "bundle linearity fixture has no resolved nonzero far-field signal");
        fixture.target[0] += 1.0; require(solve(1.0) != retained, "changed target did not bind bundle identity");
        fixture.target[0] -= 1.0;
        fixture.request.base_quadrature_order = 6;
        const auto policy_payload = solve(1.0);
        require(policy_payload != retained, "changed valid field policy did not bind bundle identity");
        std::fill(fixture.charge.sigma.begin(), fixture.charge.sigma.end(), 5.0);
        require(solve(1.0) != policy_payload, "changed accepted material did not bind bundle identity");
    }
    require(!retained.empty() && read_bundle_fields(retained).size() == 9, "bundle bytes depended on destroyed native input buffers");
}

void external_lead_bundle_abi_failures_are_atomic_and_prefix_safe()
{
    const auto reject = [](const auto &mutate, int expected = FULLMAG_FEM_ERR_INVALID) {
        ExternalLeadAbiFixture fixture; ExternalLeadAbiBuffers output; mutate(fixture, output.result);
        require(fullmag_fem_solve_accepted_external_lead_field_v1(&fixture.request, &output.result) == expected, "external bundle failure status incorrect");
        require(output.result.canonical_payload_len == 0 && output.result.digest_schema[0] == 0 && output.result.operator_version[0] == 0 && output.result.layout_fingerprint[0] == 0 && output.result.content_sha256[0] == 0 && output.result.error_message[0] != 0, "bundle failure published acceptance or lost error");
        require(std::all_of(output.payload.begin(), output.payload.end(), [](uint8_t byte) { return byte == 0xa5; }), "failed bundle partially wrote caller payload");
    };
    reject([](auto &f, auto &) { ++f.request.abi_version; });
    reject([](auto &f, auto &) { --f.request.struct_size; });
    reject([](auto &f, auto &) { f.request.reserved_flags = 1; });
    reject([](auto &, auto &r) { ++r.abi_version; });
    reject([](auto &, auto &r) { ++r.struct_size; });
    reject([](auto &, auto &r) { r.reserved_flags = 1; });
    reject([](auto &f, auto &) { ++f.request.charge.abi_version; });
    reject([](auto &f, auto &) { --f.request.charge.struct_size; });
    reject([](auto &f, auto &) { f.request.charge.reserved_flags = 1; });
    reject([](auto &f, auto &) { f.request.charge.reserved_execution = 1; });
    reject([](auto &f, auto &) { f.request.charge.reserved_solver = 1; });
    reject([](auto &f, auto &) { f.request.charge.execution_lane = FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE; }, FULLMAG_FEM_ERR_UNAVAILABLE);
    reject([](auto &f, auto &) { f.request.device_vertex_ids = nullptr; });
    reject([](auto &f, auto &) { f.request.closure_revision = nullptr; });
    reject([](auto &f, auto &) { --f.request.lead_vertex_count; });
    reject([](auto &f, auto &) { f.request.boundary_faces = nullptr; });
    reject([](auto &f, auto &) { --f.request.boundary_face_count; });
    reject([](auto &f, auto &) { f.boundaries[0].reserved = 1; });
    reject([](auto &f, auto &) { f.boundaries[0].role = 99; });
    reject([](auto &f, auto &) { f.boundaries[0].circuit_id = "wrong-scope"; });
    reject([](auto &f, auto &) { f.request.branches = nullptr; });
    reject([](auto &f, auto &) { f.request.branch_count = 0; });
    reject([](auto &f, auto &) { f.branches[0].interface_pair_ids = nullptr; });
    reject([](auto &f, auto &) { f.branches[0].requested_device_outward_current_a = 0.1; });
    reject([](auto &f, auto &) { f.request.target_xyz_m = nullptr; });
    reject([](auto &f, auto &) { f.request.target_count = UINT64_MAX; });
    reject([](auto &f, auto &) { f.target[0] = std::numeric_limits<double>::quiet_NaN(); });
    reject([](auto &f, auto &) { f.request.base_quadrature_order = 17; });
    reject([](auto &f, auto &) { f.request.base_quadrature_order = std::numeric_limits<int32_t>::max(); });
    reject([](auto &f, auto &) { f.request.maximum_subdivision_depth = 7; });
    reject([](auto &f, auto &) { f.request.maximum_subdivision_depth = std::numeric_limits<int32_t>::max(); });
    reject([](auto &f, auto &) { f.request.absolute_tolerance_apm = std::numeric_limits<double>::quiet_NaN(); });
    reject([](auto &f, auto &) { f.request.relative_tolerance = std::numeric_limits<double>::infinity(); });
    reject([](auto &f, auto &) { f.request.maximum_source_target_pairs = 1'000'001; });
    reject([](auto &f, auto &) { f.request.maximum_source_target_pairs = 1; });
    reject([](auto &, auto &r) { r.canonical_payload = nullptr; });
    reject([](auto &, auto &r) { r.canonical_payload_capacity = 0; });
    reject([](auto &, auto &r) { r.canonical_payload_capacity = 1; });
    reject([](auto &, auto &r) { r.canonical_payload_capacity = FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES + 1; });
    ExternalLeadAbiFixture fixture;
    ExternalLeadAbiBuffers null_request;
    require(fullmag_fem_solve_accepted_external_lead_field_v1(nullptr, &null_request.result) == FULLMAG_FEM_ERR_INVALID &&
            null_request.result.canonical_payload_len == 0 && null_request.result.content_sha256[0] == 0,
        "bundle null request published acceptance");
    require(fullmag_fem_solve_accepted_external_lead_field_v1(&fixture.request, nullptr) == FULLMAG_FEM_ERR_INVALID, "bundle accepted null result");
    struct alignas(8) Prefix { uint32_t version = 1, flags = 0; uint64_t size = 16; std::array<uint8_t, 32> canary{}; } prefix;
    prefix.canary.fill(0xa7); const auto before = prefix;
    require(fullmag_fem_solve_accepted_external_lead_field_v1(&fixture.request, reinterpret_cast<fullmag_fem_accepted_external_lead_result_v1 *>(&prefix)) == FULLMAG_FEM_ERR_INVALID &&
            std::memcmp(&before, &prefix, sizeof(prefix)) == 0, "bundle wrote beyond truncated result prefix");
    ExternalLeadAbiBuffers prefix_request_output;
    require(fullmag_fem_solve_accepted_external_lead_field_v1(
                reinterpret_cast<const fullmag_fem_accepted_external_lead_request_v1 *>(&prefix), &prefix_request_output.result) == FULLMAG_FEM_ERR_INVALID &&
            std::memcmp(&before, &prefix, sizeof(prefix)) == 0 && prefix_request_output.result.canonical_payload_len == 0,
        "bundle read beyond or mutated a truncated request prefix");
}

} // namespace

int main()
{
    try {
        malformed_headers_and_gpu_fail_closed();
        affine_bar_has_exact_sign_and_linearity();
        invalid_material_and_capacity_fail_closed();
        terminal_current_v2_is_balanced_and_ordered_like_the_request();
        terminal_current_v2_rejects_shared_h1_nodes();
        prescribed_terminal_current_v3_enforces_sign_and_gauge();
        accepted_charge_abi_headers_policies_and_gpu_fail_atomically();
        accepted_charge_abi_mesh_and_descriptors_fail_closed();
        accepted_charge_truncated_result_keeps_prefix_and_canary_untouched();
        accepted_charge_layered_record_has_exact_sha_and_signed_payload();
        external_lead_bundle_abi_keeps_nested_records_signed_and_owned();
        external_lead_bundle_abi_failures_are_atomic_and_prefix_safe();
        std::cout << "fem charge transport ABI contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem charge transport ABI contract: FAIL: " << error.what() << '\n';
        return 1;
    }
}
