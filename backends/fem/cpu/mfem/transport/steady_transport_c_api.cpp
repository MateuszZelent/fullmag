/*
 * Standalone C ABI adapter for M1 steady charge/spin transport.
 *
 * This file owns descriptor validation, MFEM mesh/material/BC import, field
 * export and diagnostic serialization. It deliberately does not use Context,
 * mfem_bridge.cpp or the time-domain backend lifecycle.
 */

#include "fullmag_fem.h"

#if FULLMAG_HAS_MFEM_STACK
#include "cpu/mfem/transport/steady_transport.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>
#endif

namespace {

void set_error(fullmag_fem_steady_transport_result_v1 *result, const char *message)
{
    if (result == nullptr) {
        return;
    }
    std::snprintf(result->error_message, sizeof(result->error_message), "%s", message);
    result->diagnostics_json[0] = '\0';
}

#if FULLMAG_HAS_MFEM_STACK

constexpr const char *kConstitutiveVersion =
    "transport_constitutive.one_way.fullmag.v1";
constexpr const char *kOperatorVersion =
    "fem_charge_spin_conforming_h1_p1.transparent.v1";
constexpr const char *kM2ConstitutiveVersion =
    "transport_constitutive.reciprocal.fullmag.v1";
constexpr const char *kM2OperatorVersion =
    "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
constexpr const char *kPhysicalResidualVersion =
    "transport_balance_integrated_l2.v1";

bool equals(const char *actual, const char *expected)
{
    return actual != nullptr && std::strcmp(actual, expected) == 0;
}

template <typename T>
bool pointer_matches_count(const T *pointer, uint64_t count)
{
    return (count == 0 && pointer == nullptr) || (count > 0 && pointer != nullptr);
}

struct MeshView {
    uint64_t n_nodes = 0;
    uint64_t n_elements = 0;
    std::vector<uint32_t> elements;
    std::vector<uint32_t> boundary_faces;
    std::vector<uint32_t> boundary_markers;
};

MeshView make_mesh_view(const fullmag_fem_mesh_desc &descriptor)
{
    if (descriptor.abi_version != FULLMAG_FEM_MESH_DESC_ABI_VERSION ||
        descriptor.struct_size != sizeof(fullmag_fem_mesh_desc)) {
        throw std::invalid_argument("steady transport mesh descriptor ABI mismatch");
    }
    if (descriptor.nodes_xyz_len == 0 || descriptor.nodes_xyz == nullptr ||
        descriptor.nodes_xyz_len % 3u != 0u) {
        throw std::invalid_argument("steady transport requires xyz coordinates for every node");
    }
    if (descriptor.cell_types_len == 0 || descriptor.cell_types == nullptr ||
        descriptor.cell_offsets == nullptr ||
        descriptor.cell_offsets_len != descriptor.cell_types_len + 1u ||
        descriptor.cell_nodes == nullptr || descriptor.cell_nodes_len == 0u) {
        throw std::invalid_argument("steady transport requires a typed CSR cell mesh");
    }
    if (descriptor.facet_types == nullptr || descriptor.facet_roles == nullptr ||
        descriptor.facet_offsets == nullptr || descriptor.facet_markers == nullptr ||
        descriptor.facet_offsets_len != descriptor.facet_types_len + 1u ||
        descriptor.facet_roles_len != descriptor.facet_types_len ||
        descriptor.facet_markers_len != descriptor.facet_types_len ||
        descriptor.facet_nodes == nullptr || descriptor.facet_nodes_len == 0u) {
        throw std::invalid_argument("steady transport requires typed facet topology and markers");
    }

    MeshView view;
    view.n_nodes = descriptor.nodes_xyz_len / 3u;
    view.n_elements = descriptor.cell_types_len;
    view.elements.reserve(static_cast<size_t>(view.n_elements) * 4u);
    for (uint64_t element = 0; element < view.n_elements; ++element) {
        if (descriptor.cell_types[element] != FULLMAG_FEM_CELL_TET4) {
            throw std::domain_error("FEM steady transport currently requires tetrahedral cells");
        }
        const uint64_t begin = descriptor.cell_offsets[element];
        const uint64_t end = descriptor.cell_offsets[element + 1u];
        if (end < begin || end - begin != 4u || end > descriptor.cell_nodes_len) {
            throw std::invalid_argument("tetrahedral cell CSR offsets are invalid");
        }
        for (uint64_t local = begin; local < end; ++local) {
            const uint32_t node = descriptor.cell_nodes[local];
            if (node >= view.n_nodes) {
                throw std::invalid_argument("tetrahedron references a node outside the mesh");
            }
            view.elements.push_back(node);
        }
    }

    for (uint64_t facet = 0; facet < descriptor.facet_types_len; ++facet) {
        if (descriptor.facet_roles[facet] != FULLMAG_FEM_FACET_ROLE_EXTERIOR) {
            continue;
        }
        if (descriptor.facet_types[facet] != FULLMAG_FEM_FACET_TRI3) {
            throw std::domain_error("FEM steady transport currently requires triangular exterior facets");
        }
        const uint64_t begin = descriptor.facet_offsets[facet];
        const uint64_t end = descriptor.facet_offsets[facet + 1u];
        if (end < begin || end - begin != 3u || end > descriptor.facet_nodes_len) {
            throw std::invalid_argument("exterior facet CSR offsets are invalid");
        }
        const uint32_t marker = descriptor.facet_markers[facet];
        if (marker == 0u) {
            throw std::invalid_argument("MFEM boundary attributes must be positive");
        }
        for (uint64_t local = begin; local < end; ++local) {
            const uint32_t node = descriptor.facet_nodes[local];
            if (node >= view.n_nodes) {
                throw std::invalid_argument("boundary triangle references a node outside the mesh");
            }
            view.boundary_faces.push_back(node);
        }
        view.boundary_markers.push_back(marker);
    }
    if (view.boundary_markers.empty()) {
        throw std::invalid_argument("steady transport requires explicit exterior triangular facets");
    }
    return view;
}

void validate_request_header(
    const fullmag_fem_steady_transport_request_v1 &request,
    const fullmag_fem_steady_transport_result_v1 &result)
{
    if (request.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport request abi_version must be 1");
    }
    if (request.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("steady transport request struct_size mismatch");
    }
    if (result.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport result abi_version must be 1");
    }
    if (result.struct_size != sizeof(fullmag_fem_steady_transport_result_v1)) {
        throw std::invalid_argument("steady transport result struct_size mismatch");
    }
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error(
            "FEM steady spin transport GPU is unavailable; strict requests cannot fall back to CPU");
    }
    if (request.execution_lane != FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE) {
        throw std::invalid_argument("unknown FEM steady transport execution lane");
    }
    if (request.interface_model == FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1) {
        throw std::domain_error(
            "mixing/SML transport requires the unavailable broken-H1 mortar realization");
    }
    if (request.interface_model !=
        FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1) {
        throw std::invalid_argument("unknown FEM steady transport interface model");
    }
    if (request.reserved_flags != 0 || result.reserved_flags != 0) {
        throw std::invalid_argument("steady transport reserved_flags must be zero");
    }
}

void validate_request(
    const fullmag_fem_steady_transport_request_v1 &request,
    const fullmag_fem_steady_transport_result_v1 &result,
    const MeshView &mesh,
    const char *expected_constitutive_version = kConstitutiveVersion,
    const char *expected_operator_version = kOperatorVersion)
{
    validate_request_header(request, result);
    if (request.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport request abi_version must be 1");
    }
    if (request.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("steady transport request struct_size mismatch");
    }
    if (result.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION) {
        throw std::invalid_argument("steady transport result abi_version must be 1");
    }
    if (result.struct_size != sizeof(fullmag_fem_steady_transport_result_v1)) {
        throw std::invalid_argument("steady transport result struct_size mismatch");
    }
    if (request.execution_lane == FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE) {
        throw std::domain_error(
            "FEM steady spin transport GPU is unavailable; strict requests cannot fall back to CPU");
    }
    if (request.execution_lane != FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE) {
        throw std::invalid_argument("unknown FEM steady transport execution lane");
    }
    if (request.interface_model == FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1) {
        throw std::domain_error(
            "mixing/SML transport requires the unavailable broken-H1 mortar realization");
    }
    if (request.interface_model !=
        FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1) {
        throw std::invalid_argument("unknown FEM steady transport interface model");
    }
    if (!equals(request.constitutive_version, expected_constitutive_version) ||
        !equals(request.operator_version, expected_operator_version) ||
        !equals(request.physical_residual_version, kPhysicalResidualVersion)) {
        throw std::invalid_argument(
            "unsupported FEM steady transport constitutive/operator/residual version");
    }
    if (request.reserved_flags != 0 || result.reserved_flags != 0) {
        throw std::invalid_argument("steady transport reserved_flags must be zero");
    }
    if (request.mesh.periodic_node_pairs != nullptr ||
        request.mesh.periodic_node_pairs_len != 0 ||
        request.mesh.periodic_boundary_pair_markers != nullptr ||
        request.mesh.periodic_boundary_pair_markers_len != 0) {
        throw std::domain_error("PeriodicSpin is not implemented by the FEM conforming-H1 M1 oracle");
    }
    if (!pointer_matches_count(
            request.charge_conductivity_spm_per_element,
            request.charge_conductivity_spm_per_element_len) ||
        request.charge_conductivity_spm_per_element_len != mesh.n_elements) {
        throw std::invalid_argument("charge conductivity must contain one value per tetrahedron");
    }
    if (request.magnetization_xyz == nullptr ||
        request.magnetization_xyz_len != static_cast<uint64_t>(mesh.n_nodes) * 3u) {
        throw std::invalid_argument("magnetization_xyz length must equal 3*n_nodes");
    }
    if (!pointer_matches_count(
            request.charge_dirichlet_boundary_attributes,
            request.charge_dirichlet_count) ||
        !pointer_matches_count(request.charge_dirichlet_values_v, request.charge_dirichlet_count)) {
        throw std::invalid_argument("charge Dirichlet attributes and values must have equal presence");
    }
    if (!pointer_matches_count(
            request.spin_dirichlet_boundary_attributes,
            request.spin_dirichlet_count) ||
        (request.spin_dirichlet_count > 0 && request.spin_dirichlet_values_v == nullptr)) {
        throw std::invalid_argument("spin Dirichlet attributes require three values per attribute");
    }
    if (request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE &&
        request.charge_dirichlet_count == 0) {
        throw std::invalid_argument("boundary-reference charge gauge requires an electrode");
    }
    if (request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL &&
        request.charge_dirichlet_count != 0) {
        throw std::invalid_argument("zero-mean charge gauge conflicts with fixed-potential electrodes");
    }
    if (request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE &&
        request.charge_gauge != FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL) {
        throw std::invalid_argument("unknown steady transport charge gauge");
    }
    if (request.absolute_tolerance != 0.0) {
        throw std::domain_error(
            "FEM M1 steady transport absolute_tolerance is not implemented; use zero");
    }

    const uint64_t nodes = mesh.n_nodes;
    const auto require_output = [](const double *pointer, uint64_t actual, uint64_t expected,
                                   const char *label) {
        if (pointer == nullptr || actual < expected) {
            throw std::invalid_argument(label);
        }
    };
    require_output(result.electric_potential_v, result.electric_potential_v_len, nodes,
        "electric_potential_v output capacity is smaller than n_nodes");
    require_output(result.charge_current_density_xyz_apm2,
        result.charge_current_density_xyz_apm2_len, 3u * nodes,
        "charge current output capacity is smaller than 3*n_nodes");
    require_output(result.spin_potential_xyz_v, result.spin_potential_xyz_v_len, 3u * nodes,
        "spin potential output capacity is smaller than 3*n_nodes");
    require_output(result.spin_current_tensor_row_major_qia_apm2,
        result.spin_current_tensor_row_major_qia_apm2_len, 9u * nodes,
        "spin current tensor output capacity is smaller than 9*n_nodes");
    require_output(result.torque_xyz_per_s, result.torque_xyz_len, 3u * nodes,
        "transport torque output capacity is smaller than 3*n_nodes");

    for (uint64_t i = 0; i < 3u * nodes; ++i) {
        if (!std::isfinite(request.magnetization_xyz[i])) {
            throw std::invalid_argument("magnetization_xyz must be finite");
        }
    }
    for (uint64_t i = 0; i < mesh.n_elements; ++i) {
        const double sigma = request.charge_conductivity_spm_per_element[i];
        if (!(std::isfinite(sigma) && sigma > 0.0)) {
            throw std::invalid_argument("charge conductivity must be finite and positive");
        }
    }
}

std::unique_ptr<mfem::Mesh> import_mesh(
    const fullmag_fem_mesh_desc &descriptor,
    const MeshView &view)
{
    auto mesh = std::make_unique<mfem::Mesh>(
        3,
        static_cast<int>(view.n_nodes),
        static_cast<int>(view.n_elements),
        static_cast<int>(view.boundary_markers.size()),
        3);
    for (uint32_t node = 0; node < view.n_nodes; ++node) {
        mesh->AddVertex(descriptor.nodes_xyz + static_cast<size_t>(node) * 3u);
    }
    for (uint32_t element = 0; element < view.n_elements; ++element) {
        const uint32_t *indices = view.elements.data() + static_cast<size_t>(element) * 4u;
        int tetrahedron[4];
        for (int local = 0; local < 4; ++local) {
            tetrahedron[local] = static_cast<int>(indices[local]);
        }
        // A unique attribute preserves arbitrary elementwise conductivity.
        mesh->AddTet(tetrahedron, static_cast<int>(element + 1u));
    }
    for (uint32_t boundary = 0; boundary < view.boundary_markers.size(); ++boundary) {
        const uint32_t *indices = view.boundary_faces.data() + static_cast<size_t>(boundary) * 3u;
        int triangle[3];
        for (int local = 0; local < 3; ++local) {
            triangle[local] = static_cast<int>(indices[local]);
        }
        const uint32_t attribute = view.boundary_markers[boundary];
        mesh->AddBdrTriangle(triangle, static_cast<int>(attribute));
    }
    mesh->FinalizeTopology();
    mesh->Finalize(false, true);
    return mesh;
}

class BoundaryScalarCoefficient final : public mfem::Coefficient {
public:
    BoundaryScalarCoefficient(const uint32_t *attributes, const double *values, uint64_t count)
    {
        for (uint64_t i = 0; i < count; ++i) {
            if (attributes[i] == 0 || !std::isfinite(values[i])) {
                throw std::invalid_argument("charge boundary attributes must be positive and finite");
            }
            entries_.push_back({attributes[i], values[i]});
        }
    }

    double Eval(mfem::ElementTransformation &transformation,
                const mfem::IntegrationPoint &) override
    {
        for (const auto &entry : entries_) {
            if (static_cast<uint32_t>(transformation.Attribute) == entry.first) {
                return entry.second;
            }
        }
        return 0.0;
    }

private:
    std::vector<std::pair<uint32_t, double>> entries_;
};

class BoundaryVectorCoefficient final : public mfem::VectorCoefficient {
public:
    BoundaryVectorCoefficient(const uint32_t *attributes, const double *values, uint64_t count)
        : mfem::VectorCoefficient(3)
    {
        for (uint64_t i = 0; i < count; ++i) {
            if (attributes[i] == 0) {
                throw std::invalid_argument("spin boundary attributes must be positive");
            }
            std::array<double, 3> value{};
            for (int component = 0; component < 3; ++component) {
                value[component] = values[3u * i + static_cast<uint64_t>(component)];
                if (!std::isfinite(value[component])) {
                    throw std::invalid_argument("spin boundary potential must be finite");
                }
            }
            entries_.push_back({attributes[i], value});
        }
    }

    void Eval(mfem::Vector &value, mfem::ElementTransformation &transformation,
              const mfem::IntegrationPoint &) override
    {
        value.SetSize(3);
        value = 0.0;
        for (const auto &entry : entries_) {
            if (static_cast<uint32_t>(transformation.Attribute) == entry.first) {
                for (int component = 0; component < 3; ++component) {
                    value[component] = entry.second[component];
                }
                return;
            }
        }
    }

private:
    std::vector<std::pair<uint32_t, std::array<double, 3>>> entries_;
};

mfem::Array<int> boundary_marker(
    const mfem::Mesh &mesh,
    const uint32_t *attributes,
    uint64_t count)
{
    mfem::Array<int> marker(mesh.bdr_attributes.Max());
    marker = 0;
    for (uint64_t i = 0; i < count; ++i) {
        if (attributes[i] == 0 || attributes[i] > static_cast<uint32_t>(marker.Size())) {
            throw std::invalid_argument("boundary attribute is not present in the MFEM mesh");
        }
        marker[static_cast<int>(attributes[i] - 1u)] = 1;
    }
    return marker;
}

void copy_scalar(const mfem::GridFunction &field, double *output, uint64_t node_count)
{
    if (field.Size() != static_cast<int>(node_count)) {
        throw std::runtime_error("scalar P1 field DOF count does not equal n_nodes");
    }
    std::copy(field.GetData(), field.GetData() + node_count, output);
}

void copy_by_vdim(
    const mfem::GridFunction &field,
    int components,
    double *output,
    uint64_t node_count)
{
    if (field.Size() != static_cast<int>(node_count) * components) {
        throw std::runtime_error("vector P1 field DOF count does not equal components*n_nodes");
    }
    const double *data = field.GetData();
    for (uint64_t node = 0; node < node_count; ++node) {
        for (int component = 0; component < components; ++component) {
            output[node * static_cast<uint64_t>(components) + static_cast<uint64_t>(component)] =
                data[static_cast<uint64_t>(component) * node_count + node];
        }
    }
}

int solve(
    const fullmag_fem_steady_transport_request_v1 &request,
    fullmag_fem_steady_transport_result_v1 &result)
{
    validate_request_header(request, result);
    const MeshView mesh_view = make_mesh_view(request.mesh);
    validate_request(request, result, mesh_view);
    auto mesh = import_mesh(request.mesh, mesh_view);

    mfem::Vector conductivity_values(static_cast<int>(mesh_view.n_elements));
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        conductivity_values[static_cast<int>(i)] = request.charge_conductivity_spm_per_element[i];
    }
    mfem::PWConstCoefficient conductivity(conductivity_values);

    mfem::H1_FECollection magnetization_collection(1, 3);
    mfem::FiniteElementSpace magnetization_space(
        mesh.get(), &magnetization_collection, 3, mfem::Ordering::byNODES);
    if (magnetization_space.GetNDofs() != static_cast<int>(mesh_view.n_nodes)) {
        throw std::runtime_error("magnetization P1 space DOF count does not equal n_nodes");
    }
    mfem::GridFunction magnetization_grid(&magnetization_space);
    for (uint64_t node = 0; node < mesh_view.n_nodes; ++node) {
        for (int component = 0; component < 3; ++component) {
            magnetization_grid[component * static_cast<int>(mesh_view.n_nodes) +
                static_cast<int>(node)] =
                request.magnetization_xyz[3u * node + static_cast<uint64_t>(component)];
        }
    }
    mfem::VectorGridFunctionCoefficient magnetization(&magnetization_grid);

    fullmag::fem::transport::SteadyTransportParameters parameters;
    parameters.sigma_s_spm = request.sigma_s_spm;
    parameters.polarization_p = request.polarization_p;
    parameters.theta_sh = request.theta_sh;
    parameters.lambda_sf_m = request.lambda_sf_m;
    parameters.lambda_j_m = request.has_lambda_j != 0
        ? request.lambda_j_m : std::numeric_limits<double>::infinity();
    parameters.lambda_phi_m = request.has_lambda_phi != 0
        ? request.lambda_phi_m : std::numeric_limits<double>::infinity();
    parameters.gamma_e_per_ts = request.gamma_e_per_ts;
    parameters.saturation_magnetization_apm = request.saturation_magnetization_apm;
    parameters.relative_tolerance = request.relative_tolerance;
    parameters.maximum_iterations = static_cast<int>(request.maximum_iterations);

    fullmag::fem::transport::SteadyTransportOracle oracle(
        *mesh, conductivity, magnetization, parameters);
    const auto charge_marker = boundary_marker(
        *mesh,
        request.charge_dirichlet_boundary_attributes,
        request.charge_dirichlet_count);
    BoundaryScalarCoefficient charge_boundary(
        request.charge_dirichlet_boundary_attributes,
        request.charge_dirichlet_values_v,
        request.charge_dirichlet_count);
    const auto charge_gauge =
        request.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL
            ? fullmag::fem::transport::ChargeGauge::ZeroMeanPotential
            : fullmag::fem::transport::ChargeGauge::BoundaryReference;
    const auto charge = oracle.solve_charge(charge_marker, charge_boundary, charge_gauge);
    if (!charge.converged) {
        throw std::runtime_error("FEM steady transport charge solve did not converge");
    }

    const auto spin_marker = boundary_marker(
        *mesh,
        request.spin_dirichlet_boundary_attributes,
        request.spin_dirichlet_count);
    std::unique_ptr<BoundaryVectorCoefficient> spin_boundary;
    if (request.spin_dirichlet_count > 0) {
        spin_boundary = std::make_unique<BoundaryVectorCoefficient>(
            request.spin_dirichlet_boundary_attributes,
            request.spin_dirichlet_values_v,
            request.spin_dirichlet_count);
    }
    const auto spin = oracle.solve_spin(spin_marker, spin_boundary.get());
    if (!spin.converged) {
        throw std::runtime_error("FEM steady transport spin solve did not converge");
    }

    const uint64_t nodes = mesh_view.n_nodes;
    copy_scalar(oracle.electric_potential(), result.electric_potential_v, nodes);
    copy_by_vdim(oracle.charge_current_density(), 3,
        result.charge_current_density_xyz_apm2, nodes);
    copy_by_vdim(oracle.spin_potential(), 3, result.spin_potential_xyz_v, nodes);
    copy_by_vdim(oracle.spin_current_tensor(), 9,
        result.spin_current_tensor_row_major_qia_apm2, nodes);
    copy_by_vdim(oracle.transport_torque(), 3, result.torque_xyz_per_s, nodes);

    result.charge_converged = charge.converged ? 1 : 0;
    result.charge_iterations = static_cast<uint32_t>(charge.iterations);
    result.charge_relative_residual = charge.relative_residual;
    result.net_boundary_current_a = charge.net_boundary_current_a;
    result.spin_converged = spin.converged ? 1 : 0;
    result.spin_iterations = static_cast<uint32_t>(spin.iterations);
    result.spin_relative_residual = spin.relative_residual;
    result.torque_l2_per_s = spin.torque_l2_per_s;
    for (int component = 0; component < 3; ++component) {
        result.current_density_volume_average_apm2[component] =
            charge.current_density_volume_average_apm2[component];
        result.boundary_spin_flux_a[component] = spin.boundary_spin_flux_a[component];
        result.reaction_integral_a[component] = spin.reaction_integral_a[component];
        result.angular_momentum_balance_apm2[component] =
            spin.angular_momentum_balance_apm2[component];
        result.torque_volume_average_per_s[component] =
            spin.torque_volume_average_per_s[component];
    }
    result.error_message[0] = '\0';
    std::snprintf(
        result.diagnostics_json,
        sizeof(result.diagnostics_json),
        "{\"schema_version\":\"fem_steady_transport_diagnostics.v1\","
        "\"constitutive_version\":\"%s\",\"operator_version\":\"%s\","
        "\"physical_residual_version\":\"%s\",\"execution_lane\":\"fem_cpu_double\","
        "\"interface_model\":\"transparent_conforming_h1\","
        "\"charge_converged\":true,\"charge_iterations\":%u,"
        "\"charge_relative_residual\":%.17g,\"net_boundary_current_A\":%.17g,"
        "\"spin_converged\":true,\"spin_iterations\":%u,"
        "\"spin_relative_residual\":%.17g,\"torque_l2_per_s\":%.17g}",
        kConstitutiveVersion,
        kOperatorVersion,
        kPhysicalResidualVersion,
        result.charge_iterations,
        result.charge_relative_residual,
        result.net_boundary_current_a,
        result.spin_iterations,
        result.spin_relative_residual,
        result.torque_l2_per_s);
    return FULLMAG_FEM_OK;
}

int solve_m2(
    const fullmag_fem_steady_transport_m2_request_v1 &request,
    fullmag_fem_steady_transport_result_v1 &result)
{
    const auto &base = request.base;
    if (base.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
        base.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
        throw std::invalid_argument("steady transport M2 base ABI header mismatch");
    }
    const MeshView mesh_view = make_mesh_view(base.mesh);
    validate_request(
        base, result, mesh_view, kM2ConstitutiveVersion, kM2OperatorVersion);
    if (!(std::isfinite(request.sigma_parallel_spm) && request.sigma_parallel_spm > 0.0) ||
        !(std::isfinite(request.sigma_perpendicular_spm) &&
            request.sigma_perpendicular_spm > 0.0) ||
        !std::isfinite(request.sigma_ahe_spm)) {
        throw std::invalid_argument("reciprocal charge conductivities must be finite and positive");
    }
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        const double sigma = base.charge_conductivity_spm_per_element[i];
        const double minimum_charge_conductivity = std::min(
            request.sigma_parallel_spm, request.sigma_perpendicular_spm);
        if (!(minimum_charge_conductivity * base.sigma_s_spm -
                base.polarization_p * base.polarization_p * sigma * sigma > 0.0)) {
            throw std::invalid_argument("reciprocal spin material violates the positive Schur complement");
        }
    }
    auto mesh = import_mesh(base.mesh, mesh_view);

    mfem::Vector conductivity_values(static_cast<int>(mesh_view.n_elements));
    for (uint32_t i = 0; i < mesh_view.n_elements; ++i) {
        conductivity_values[static_cast<int>(i)] =
            base.charge_conductivity_spm_per_element[i];
    }
    mfem::PWConstCoefficient conductivity(conductivity_values);

    mfem::H1_FECollection magnetization_collection(1, 3);
    mfem::FiniteElementSpace magnetization_space(
        mesh.get(), &magnetization_collection, 3, mfem::Ordering::byNODES);
    if (magnetization_space.GetNDofs() != static_cast<int>(mesh_view.n_nodes)) {
        throw std::runtime_error("magnetization P1 space DOF count does not equal n_nodes");
    }
    mfem::GridFunction magnetization_grid(&magnetization_space);
    for (uint64_t node = 0; node < mesh_view.n_nodes; ++node) {
        for (int component = 0; component < 3; ++component) {
            magnetization_grid[component * static_cast<int>(mesh_view.n_nodes) +
                static_cast<int>(node)] =
                base.magnetization_xyz[3u * node + static_cast<uint64_t>(component)];
        }
    }
    mfem::VectorGridFunctionCoefficient magnetization(&magnetization_grid);

    fullmag::fem::transport::SteadyTransportParameters parameters;
    parameters.constitutive_model =
        fullmag::fem::transport::TransportConstitutiveModel::Reciprocal;
    parameters.sigma_s_spm = base.sigma_s_spm;
    parameters.sigma_parallel_spm = request.sigma_parallel_spm;
    parameters.sigma_perpendicular_spm = request.sigma_perpendicular_spm;
    parameters.sigma_ahe_spm = request.sigma_ahe_spm;
    parameters.polarization_p = base.polarization_p;
    parameters.theta_sh = base.theta_sh;
    parameters.lambda_sf_m = base.lambda_sf_m;
    parameters.lambda_j_m = base.has_lambda_j != 0
        ? base.lambda_j_m : std::numeric_limits<double>::infinity();
    parameters.lambda_phi_m = base.has_lambda_phi != 0
        ? base.lambda_phi_m : std::numeric_limits<double>::infinity();
    parameters.gamma_e_per_ts = base.gamma_e_per_ts;
    parameters.saturation_magnetization_apm = base.saturation_magnetization_apm;
    parameters.relative_tolerance = base.relative_tolerance;
    parameters.maximum_iterations = static_cast<int>(base.maximum_iterations);

    fullmag::fem::transport::SteadyTransportOracle oracle(
        *mesh, conductivity, magnetization, parameters);
    const auto charge_marker = boundary_marker(
        *mesh, base.charge_dirichlet_boundary_attributes, base.charge_dirichlet_count);
    BoundaryScalarCoefficient charge_boundary(
        base.charge_dirichlet_boundary_attributes,
        base.charge_dirichlet_values_v,
        base.charge_dirichlet_count);
    if (base.charge_gauge == FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL) {
        throw std::domain_error("reciprocal FEM reference lane requires a Dirichlet charge reference");
    }
    const auto spin_marker = boundary_marker(
        *mesh, base.spin_dirichlet_boundary_attributes, base.spin_dirichlet_count);
    std::unique_ptr<BoundaryVectorCoefficient> spin_boundary;
    if (base.spin_dirichlet_count > 0) {
        spin_boundary = std::make_unique<BoundaryVectorCoefficient>(
            base.spin_dirichlet_boundary_attributes,
            base.spin_dirichlet_values_v,
            base.spin_dirichlet_count);
    }
    const auto diagnostics = oracle.solve_reciprocal(
        charge_marker, charge_boundary, spin_marker, spin_boundary.get(),
        fullmag::fem::transport::ChargeGauge::BoundaryReference);
    if (!diagnostics.charge.converged || !diagnostics.spin.converged) {
        throw std::runtime_error("FEM reciprocal steady transport solve did not converge");
    }

    const uint64_t nodes = mesh_view.n_nodes;
    copy_scalar(oracle.electric_potential(), result.electric_potential_v, nodes);
    copy_by_vdim(oracle.charge_current_density(), 3,
        result.charge_current_density_xyz_apm2, nodes);
    copy_by_vdim(oracle.spin_potential(), 3, result.spin_potential_xyz_v, nodes);
    copy_by_vdim(oracle.spin_current_tensor(), 9,
        result.spin_current_tensor_row_major_qia_apm2, nodes);
    copy_by_vdim(oracle.transport_torque(), 3, result.torque_xyz_per_s, nodes);

    result.charge_converged = diagnostics.charge.converged ? 1 : 0;
    result.charge_iterations = static_cast<uint32_t>(diagnostics.charge.iterations);
    result.charge_relative_residual = diagnostics.charge.relative_residual;
    result.net_boundary_current_a = diagnostics.charge.net_boundary_current_a;
    result.spin_converged = diagnostics.spin.converged ? 1 : 0;
    result.spin_iterations = static_cast<uint32_t>(diagnostics.spin.iterations);
    result.spin_relative_residual = diagnostics.spin.relative_residual;
    result.torque_l2_per_s = diagnostics.spin.torque_l2_per_s;
    for (int component = 0; component < 3; ++component) {
        result.current_density_volume_average_apm2[component] =
            diagnostics.charge.current_density_volume_average_apm2[component];
        result.boundary_spin_flux_a[component] = diagnostics.spin.boundary_spin_flux_a[component];
        result.reaction_integral_a[component] = diagnostics.spin.reaction_integral_a[component];
        result.angular_momentum_balance_apm2[component] =
            diagnostics.spin.angular_momentum_balance_apm2[component];
        result.torque_volume_average_per_s[component] =
            diagnostics.spin.torque_volume_average_per_s[component];
    }
    result.error_message[0] = '\0';
    std::snprintf(
        result.diagnostics_json,
        sizeof(result.diagnostics_json),
        "{\"schema_version\":\"fem_steady_transport_diagnostics.v1\","
        "\"constitutive_version\":\"%s\",\"operator_version\":\"%s\","
        "\"physical_residual_version\":\"%s\",\"execution_lane\":\"fem_cpu_double\","
        "\"interface_model\":\"transparent_conforming_h1\",\"constitutive_model\":\"reciprocal_m2\","
        "\"charge_converged\":true,\"charge_iterations\":%u,"
        "\"charge_relative_residual\":%.17g,\"spin_converged\":true,\"spin_iterations\":%u,"
        "\"spin_relative_residual\":%.17g,\"torque_l2_per_s\":%.17g}",
        kM2ConstitutiveVersion,
        kM2OperatorVersion,
        kPhysicalResidualVersion,
        result.charge_iterations,
        result.charge_relative_residual,
        result.spin_iterations,
        result.spin_relative_residual,
        result.torque_l2_per_s);
    return FULLMAG_FEM_OK;
}

#endif

} // namespace

extern "C" int fullmag_fem_solve_steady_transport_v1(
    const fullmag_fem_steady_transport_request_v1 *request,
    fullmag_fem_steady_transport_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "steady transport requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        return solve(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM steady transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

extern "C" int fullmag_fem_solve_steady_transport_m2_v1(
    const fullmag_fem_steady_transport_m2_request_v1 *request,
    fullmag_fem_steady_transport_result_v1 *result)
{
    if (request == nullptr || result == nullptr) {
        set_error(result, "steady transport M2 requires non-null request and result");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    try {
        if (request->base.abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
            request->base.struct_size != sizeof(fullmag_fem_steady_transport_request_v1)) {
            throw std::invalid_argument("steady transport M2 base ABI header mismatch");
        }
        if (result->abi_version != FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION ||
            result->struct_size != sizeof(fullmag_fem_steady_transport_result_v1)) {
            throw std::invalid_argument("steady transport M2 result ABI header mismatch");
        }
        return solve_m2(*request, *result);
    } catch (const std::domain_error &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch (const std::invalid_argument &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INVALID;
    } catch (const std::exception &error) {
        set_error(result, error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    set_error(result,
        "FEM reciprocal steady transport requires a runtime built with FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}
