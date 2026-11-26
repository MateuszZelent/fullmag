#include "cpu/mfem/transport/steady_transport.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <vector>

#if defined(MFEM_USE_MPI) && \
    !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI) && \
    defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

#if defined(FULLMAG_FEM_CUDSS_POISSON_ENABLED) && FULLMAG_FEM_CUDSS_POISSON_ENABLED && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime_api.h>
#endif

namespace {

using fullmag::fem::transport::ChargeGauge;
using fullmag::fem::transport::TransportConstitutiveModel;
using fullmag::fem::transport::SteadyTransportOracle;
using fullmag::fem::transport::SteadyTransportParameters;

constexpr double kTolerance = 2.0e-10;

void require(bool condition, const char *message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

bool can_test_hypre_backend() noexcept
{
#if defined(MFEM_USE_MPI) && \
    !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI)
#if defined(__unix__)
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        ::close(fd);
        return true;
    }
    return false;
#else
    return true;
#endif
#else
    return false;
#endif
}

mfem::Array<int> x_electrodes(const mfem::Mesh &mesh)
{
    mfem::Array<int> marker(mesh.bdr_attributes.Max());
    marker = 0;
    double x_min = mesh.GetVertex(0)[0];
    double x_max = x_min;
    for (int vertex = 1; vertex < mesh.GetNV(); ++vertex) {
        x_min = std::min(x_min, mesh.GetVertex(vertex)[0]);
        x_max = std::max(x_max, mesh.GetVertex(vertex)[0]);
    }
    const double tolerance = 1.0e-12 * std::max(1.0, x_max - x_min);
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool on_min = true;
        bool on_max = true;
        for (int i = 0; i < vertices.Size(); ++i) {
            const double x = mesh.GetVertex(vertices[i])[0];
            on_min = on_min && std::abs(x - x_min) <= tolerance;
            on_max = on_max && std::abs(x - x_max) <= tolerance;
        }
        if (on_min || on_max) {
            marker[mesh.GetBdrAttribute(boundary) - 1] = 1;
        }
    }
    return marker;
}

mfem::Array<int> all_external_boundaries(const mfem::Mesh &mesh)
{
    mfem::Array<int> marker(mesh.bdr_attributes.Max());
    marker = 1;
    return marker;
}

double max_nodal_error(
    const mfem::GridFunction &field,
    mfem::Coefficient &expected)
{
    mfem::GridFunction projection(const_cast<mfem::FiniteElementSpace *>(field.FESpace()));
    projection.ProjectCoefficient(expected);
    projection -= field;
    return projection.Normlinf();
}

double max_vector_nodal_error(
    const mfem::GridFunction &field,
    mfem::VectorCoefficient &expected)
{
    mfem::GridFunction projection(const_cast<mfem::FiniteElementSpace *>(field.FESpace()));
    projection.ProjectCoefficient(expected);
    projection -= field;
    return projection.Normlinf();
}

void charge_uniform_bar_is_linear_and_conservative()
{
    constexpr double length_m = 2.0;
    constexpr double sigma_spm = 5.0;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        12, 1, 1, mfem::Element::TETRAHEDRON, length_m, 1.0, 1.0);
    mfem::ConstantCoefficient sigma(sigma_spm);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.sigma_s_spm = 2.0;
    parameters.lambda_sf_m = 1.0;

    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    auto electrodes = x_electrodes(mesh);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
        return 1.0 - x[0] / length_m;
    });
    const auto diagnostics = oracle.solve_charge(
        electrodes, voltage, ChargeGauge::BoundaryReference);

    require(diagnostics.converged, "charge CG did not converge");
    require(diagnostics.relative_residual < 1.0e-11, "charge residual exceeds contract");
    const double potential_error = max_nodal_error(oracle.electric_potential(), voltage);
    if (!(potential_error < kTolerance)) {
        std::cerr << "uniform-bar potential error=" << potential_error
                  << " residual=" << diagnostics.relative_residual << '\n';
    }
    require(potential_error < kTolerance,
        "uniform-bar potential is not the exact P1 linear solution");
    require(std::abs(diagnostics.net_boundary_current_a) < 5.0e-11,
        "charge boundary flux is not globally conservative");
    require(std::abs(diagnostics.current_density_volume_average_apm2[0] - sigma_spm / length_m) < 2.0e-10,
        "uniform-bar current has the wrong sign or magnitude");
}

void charge_weak_terminal_reaction_preserves_uneliminated_rhs()
{
    constexpr double length_m = 2.0;
    constexpr double sigma_spm = 5.0;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        12, 1, 1, mfem::Element::TETRAHEDRON, length_m, 1.0, 1.0);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
        return 1.0 - x[0] / length_m;
    });
    mfem::GridFunction potential(&space);
    potential.ProjectCoefficient(voltage);
    mfem::ConstantCoefficient sigma(sigma_spm);
    mfem::BilinearForm form(&space);
    form.AddDomainIntegrator(new mfem::DiffusionIntegrator(sigma));
    form.Assemble();
    form.Finalize();
    mfem::LinearForm rhs(&space);
    rhs = 0.0;
    rhs.Assemble();

    mfem::Array<int> inlet_marker(mesh.bdr_attributes.Max());
    mfem::Array<int> outlet_marker(mesh.bdr_attributes.Max());
    inlet_marker = 0;
    outlet_marker = 0;
    int inlet_attribute = 0;
    int outlet_attribute = 0;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool inlet = true;
        bool outlet = true;
        for (int vertex = 0; vertex < vertices.Size(); ++vertex) {
            const double x = mesh.GetVertex(vertices[vertex])[0];
            inlet = inlet && std::abs(x) < 1.0e-12;
            outlet = outlet && std::abs(x - length_m) < 1.0e-12;
        }
        const int attribute = mesh.GetBdrAttribute(boundary) - 1;
        inlet_marker[attribute] |= inlet;
        outlet_marker[attribute] |= outlet;
        if (inlet) {
            require(inlet_attribute == 0 || inlet_attribute == attribute + 1,
                "uniform-bar inlet spans multiple boundary attributes");
            inlet_attribute = attribute + 1;
        }
        if (outlet) {
            require(outlet_attribute == 0 || outlet_attribute == attribute + 1,
                "uniform-bar outlet spans multiple boundary attributes");
            outlet_attribute = attribute + 1;
        }
    }
    mfem::Array<int> inlet_dofs, outlet_dofs;
    space.GetEssentialTrueDofs(inlet_marker, inlet_dofs);
    space.GetEssentialTrueDofs(outlet_marker, outlet_dofs);
    require(inlet_dofs.Size() > 0 && outlet_dofs.Size() > 0,
        "uniform-bar terminal markers have no H1 dofs");

    mfem::Vector original_rhs(rhs);
    mfem::Vector original_potential(potential);
    mfem::Vector before(space.GetVSize());
    form.Mult(potential, before);
    before -= original_rhs;
    double inlet_reaction = 0.0;
    double outlet_reaction = 0.0;
    for (int i = 0; i < inlet_dofs.Size(); ++i) {
        inlet_reaction += before[inlet_dofs[i]];
    }
    for (int i = 0; i < outlet_dofs.Size(); ++i) {
        outlet_reaction += before[outlet_dofs[i]];
    }
    require(std::abs(inlet_reaction - sigma_spm / length_m) < kTolerance,
        "uneliminated inlet reaction has the wrong sign or magnitude");
    require(std::abs(outlet_reaction + sigma_spm / length_m) < kTolerance,
        "uneliminated outlet reaction has the wrong sign or magnitude");

    auto electrodes = x_electrodes(mesh);
    mfem::Array<int> essential_dofs;
    space.GetEssentialTrueDofs(electrodes, essential_dofs);
    mfem::OperatorPtr system_operator;
    mfem::Vector solution, system_rhs;
    form.FormLinearSystem(
        essential_dofs, potential, rhs, system_operator, solution, system_rhs);
    mfem::Vector eliminated_rhs(rhs);
    eliminated_rhs -= original_rhs;
    require(eliminated_rhs.Normlinf() > kTolerance,
        "FormLinearSystem did not expose the expected RHS elimination");
    mfem::Vector after(space.GetVSize());
    form.FullMult(original_potential, after);
    after -= original_rhs;
    after -= before;
    require(after.Normlinf() < kTolerance,
        "FullMult does not recover the original terminal reaction");

    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    const auto diagnostics = oracle.solve_charge(
        electrodes, voltage, ChargeGauge::BoundaryReference);
    require(diagnostics.converged, "weak-current charge solve did not converge");
    require(std::abs(oracle.boundary_weak_current_a(inlet_attribute) +
            sigma_spm / length_m) < kTolerance,
        "weak inlet current has the wrong sign or magnitude");
    require(std::abs(oracle.boundary_weak_current_a(outlet_attribute) -
            sigma_spm / length_m) < kTolerance,
        "weak outlet current has the wrong sign or magnitude");

    mfem::FunctionCoefficient shifted_voltage([](const mfem::Vector &x) {
        return 8.0 - x[0] / length_m;
    });
    require(oracle.solve_charge(
            electrodes, shifted_voltage, ChargeGauge::BoundaryReference).converged,
        "shifted-gauge charge solve did not converge");
    require(std::abs(oracle.boundary_weak_current_a(inlet_attribute) +
            sigma_spm / length_m) < kTolerance,
        "weak inlet current changed under a constant potential shift");
    require(std::abs(oracle.boundary_weak_current_a(outlet_attribute) -
            sigma_spm / length_m) < kTolerance,
        "weak outlet current changed under a constant potential shift");

    mfem::FunctionCoefficient doubled_voltage([](const mfem::Vector &x) {
        return 2.0 - 2.0 * x[0] / length_m;
    });
    require(oracle.solve_charge(
            electrodes, doubled_voltage, ChargeGauge::BoundaryReference).converged,
        "double-current charge solve did not converge");
    require(std::abs(oracle.boundary_weak_current_a(inlet_attribute) +
            2.0 * sigma_spm / length_m) < kTolerance,
        "weak inlet current is not linear in the voltage difference");
    require(std::abs(oracle.boundary_weak_current_a(outlet_attribute) -
            2.0 * sigma_spm / length_m) < kTolerance,
        "weak outlet current is not linear in the voltage difference");

    mfem::FunctionCoefficient reversed_voltage([](const mfem::Vector &x) {
        return -1.0 + x[0] / length_m;
    });
    require(oracle.solve_charge(
            electrodes, reversed_voltage, ChargeGauge::BoundaryReference).converged,
        "reversed-current charge solve did not converge");
    require(std::abs(oracle.boundary_weak_current_a(inlet_attribute) -
            sigma_spm / length_m) < kTolerance,
        "weak inlet current did not reverse sign");
    require(std::abs(oracle.boundary_weak_current_a(outlet_attribute) +
            sigma_spm / length_m) < kTolerance,
        "weak outlet current did not reverse sign");

    const std::vector<std::vector<int>> terminals = {
        {inlet_attribute}, {outlet_attribute},
    };
    const auto prescribed = oracle.solve_charge_terminal_currents(
        terminals, {-sigma_spm / length_m, sigma_spm / length_m});
    require(prescribed.diagnostics.converged,
        "prescribed terminal-current H1 solve did not converge");
    require(prescribed.gauge_terminal_indices == std::vector<int>{0},
        "prescribed current solve chose the wrong component gauge");
    require(std::abs(prescribed.terminal_voltage_v[0]) < kTolerance &&
            std::abs(prescribed.terminal_voltage_v[1] + 1.0) < kTolerance,
        "prescribed current solve returned the wrong terminal voltage");
    require(std::abs(prescribed.measured_outward_current_a[0] + sigma_spm / length_m) < kTolerance &&
            std::abs(prescribed.measured_outward_current_a[1] - sigma_spm / length_m) < kTolerance,
        "prescribed current solve did not enforce signed terminal currents");

    const auto doubled = oracle.solve_charge_terminal_currents(
        terminals, {-2.0 * sigma_spm / length_m, 2.0 * sigma_spm / length_m});
    require(std::abs(doubled.terminal_voltage_v[1] + 2.0) < kTolerance &&
            std::abs(doubled.measured_outward_current_a[1] -
                2.0 * sigma_spm / length_m) < kTolerance,
        "prescribed current solve is not linear in requested current");

    const auto reversed = oracle.solve_charge_terminal_currents(
        terminals, {sigma_spm / length_m, -sigma_spm / length_m});
    require(std::abs(reversed.terminal_voltage_v[1] - 1.0) < kTolerance &&
            std::abs(reversed.measured_outward_current_a[1] +
                sigma_spm / length_m) < kTolerance,
        "prescribed current solve did not preserve current orientation");

    bool rejected_unbalanced = false;
    try {
        (void)oracle.solve_charge_terminal_currents(terminals, {-1.0, 0.5});
    } catch (const std::invalid_argument &) {
        rejected_unbalanced = true;
    }
    require(rejected_unbalanced,
        "prescribed current solve accepted an unbalanced conductor component");
}

void missing_charge_gauge_fails_closed()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::ConstantCoefficient sigma(1.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    mfem::Array<int> no_dirichlet(mesh.bdr_attributes.Max());
    no_dirichlet = 0;
    mfem::ConstantCoefficient zero(0.0);
    bool rejected = false;
    try {
        (void)oracle.solve_charge(no_dirichlet, zero, ChargeGauge::Missing);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected, "charge solve accepted a singular problem without a gauge");
}

void disconnected_unforced_conductor_receives_independent_gauge()
{
    mfem::Mesh mesh(3, 8, 2, 8, 3);
    const double vertices[8][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0},
        {3.0, 0.0, 0.0}, {4.0, 0.0, 0.0},
        {3.0, 1.0, 0.0}, {3.0, 0.0, 1.0},
    };
    for (const auto &vertex : vertices) {
        mesh.AddVertex(vertex);
    }
    for (int component = 0; component < 2; ++component) {
        const int offset = 4 * component;
        int tetrahedron[4] = {offset, offset + 1, offset + 2, offset + 3};
        mesh.AddTet(tetrahedron, component + 1);
        int faces[4][3] = {
            {offset, offset + 2, offset + 1},
            {offset, offset + 1, offset + 3},
            {offset + 1, offset + 2, offset + 3},
            {offset + 2, offset, offset + 3},
        };
        for (auto &face : faces) {
            mesh.AddBdrTriangle(face, component + 1);
        }
    }
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);

    mfem::ConstantCoefficient sigma(1.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    mfem::Array<int> terminal(mesh.bdr_attributes.Max());
    terminal = 0;
    terminal[0] = 1;
    mfem::ConstantCoefficient voltage(1.0);
    const auto diagnostics = oracle.solve_charge(
        terminal, voltage, ChargeGauge::BoundaryReference);
    require(diagnostics.converged,
        "unforced disconnected conductor made the charge solve singular");
    mfem::Array<int> dofs;
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        oracle.electric_potential().FESpace()->GetVertexDofs(vertex, dofs);
        require(dofs.Size() == 1, "disconnected P1 vertex has no unique H1 dof");
        const double expected = vertex < 4 ? 1.0 : 0.0;
        require(std::abs(oracle.electric_potential()[dofs[0]] - expected) < kTolerance,
            "disconnected charge component has the wrong independent gauge");
    }
    require(std::abs(oracle.boundary_weak_current_a(1)) < kTolerance,
        "unforced disconnected conductor created a spurious terminal current");
}

void disconnected_terminal_currents_keep_independent_scales()
{
    mfem::Mesh mesh(3, 16, 2, 12, 3);
    for (int component = 0; component < 2; ++component) {
        const double x_offset = 3.0 * component;
        const double vertices[8][3] = {
            {x_offset, 0.0, 0.0}, {x_offset + 1.0, 0.0, 0.0},
            {x_offset + 1.0, 1.0, 0.0}, {x_offset, 1.0, 0.0},
            {x_offset, 0.0, 1.0}, {x_offset + 1.0, 0.0, 1.0},
            {x_offset + 1.0, 1.0, 1.0}, {x_offset, 1.0, 1.0},
        };
        for (const auto &vertex : vertices) {
            mesh.AddVertex(vertex);
        }
        const int offset = 8 * component;
        int hex[8] = {
            offset, offset + 1, offset + 2, offset + 3,
            offset + 4, offset + 5, offset + 6, offset + 7,
        };
        mesh.AddHex(hex, component + 1);
        const int faces[6][4] = {
            {offset, offset + 3, offset + 7, offset + 4},
            {offset + 1, offset + 5, offset + 6, offset + 2},
            {offset, offset + 1, offset + 2, offset + 3},
            {offset + 4, offset + 7, offset + 6, offset + 5},
            {offset, offset + 4, offset + 5, offset + 1},
            {offset + 3, offset + 2, offset + 6, offset + 7},
        };
        for (int face = 0; face < 6; ++face) {
            int nodes[4] = {
                faces[face][0], faces[face][1], faces[face][2], faces[face][3],
            };
            mesh.AddBdrQuad(nodes, face < 2 ? 2 * component + face + 1 : 5 + component);
        }
    }
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);

    mfem::ConstantCoefficient sigma(1.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.relative_tolerance = 1.0e-13;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    const std::vector<std::vector<int>> terminals = {{1}, {2}, {3}, {4}};
    const std::vector<double> requested = {-1.0, 1.0, -1.0e-4, 1.0e-4};
    const auto solution = oracle.solve_charge_terminal_currents(terminals, requested);
    require(solution.diagnostics.converged &&
            solution.gauge_terminal_indices == std::vector<int>({0, 2}),
        "disconnected current components did not receive independent gauges");
    for (std::size_t terminal = 0; terminal < requested.size(); ++terminal) {
        const double component_scale = terminal < 2 ? 1.0 : 1.0e-4;
        require(std::abs(solution.measured_outward_current_a[terminal] - requested[terminal]) <=
                1.0e-8 * component_scale + 1.0e-18,
            "disconnected terminal current exceeds its component-local tolerance");
    }
    require(std::abs(solution.terminal_voltage_v[1] + 1.0) < kTolerance &&
            std::abs(solution.terminal_voltage_v[3] + 1.0e-4) < 1.0e-12,
        "disconnected current components returned incorrect terminal voltages");
}

void transparent_layered_bar_preserves_series_current()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        16, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        double x = 0.0;
        for (int i = 0; i < vertices.Size(); ++i) {
            x += mesh.GetVertex(vertices[i])[0];
        }
        x /= vertices.Size();
        mesh.GetElement(element)->SetAttribute(x < 0.5 ? 1 : 2);
    }
    mfem::Vector values(2);
    values[0] = 1.0;
    values[1] = 4.0;
    mfem::PWConstCoefficient sigma(values);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.sigma_s_spm = 5.0;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    auto electrodes = x_electrodes(mesh);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
        return x[0] < 0.5 ? 1.0 - 1.6 * x[0] : 0.4 - 0.4 * x[0];
    });
    const auto diagnostics = oracle.solve_charge(
        electrodes, voltage, ChargeGauge::BoundaryReference);
    require(diagnostics.converged, "layered-bar charge CG did not converge");
    require(max_nodal_error(oracle.electric_potential(), voltage) < 5.0e-10,
        "transparent interface does not preserve continuous series-resistance potential");
    require(std::abs(diagnostics.current_density_volume_average_apm2[0] - 1.6) < 5.0e-9,
        "layered-bar series current is incorrect");
}

void mixing_interface_fails_closed_without_broken_h1()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::ConstantCoefficient sigma(1.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.interface_model = fullmag::fem::transport::SpinInterfaceModel::MixingBrokenH1;
    bool rejected = false;
    try {
        SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected, "mixing conductance silently used a conforming-H1 interface");
}

void invalid_dissipative_block_fails_closed()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::ConstantCoefficient sigma(4.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.sigma_s_spm = 2.0;
    parameters.polarization_p = 1.0;
    bool rejected = false;
    try {
        SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected, "spin material accepted sigma_s-P^2 sigma<=0");
}

void spin_diffusion_matches_sinh_profile()
{
    constexpr double length_m = 1.0;
    constexpr double lambda_m = 0.2;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        64, 1, 1, mfem::Element::TETRAHEDRON, length_m, 0.1, 0.1);
    mfem::ConstantCoefficient sigma(4.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.sigma_s_spm = 4.0;
    parameters.lambda_sf_m = lambda_m;
    parameters.polarization_p = 0.0;
    parameters.theta_sh = 0.0;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);

    auto electrodes = x_electrodes(mesh);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) { return 1.0 - x[0]; });
    (void)oracle.solve_charge(electrodes, voltage, ChargeGauge::BoundaryReference);

    mfem::VectorFunctionCoefficient spin_boundary(3, [](const mfem::Vector &x, mfem::Vector &value) {
        value.SetSize(3);
        value = 0.0;
        if (x[0] < 0.5) {
            value[0] = 1.0;
        }
    });
    const auto diagnostics = oracle.solve_spin(electrodes, &spin_boundary);
    require(diagnostics.converged, "spin GMRES did not converge");
    require(diagnostics.relative_residual < 1.0e-10, "spin residual exceeds contract");

    mfem::VectorFunctionCoefficient expected(3, [](const mfem::Vector &x, mfem::Vector &value) {
        value.SetSize(3);
        value = 0.0;
        value[0] = std::sinh((length_m - x[0]) / lambda_m) / std::sinh(length_m / lambda_m);
    });
    const double spin_error = max_vector_nodal_error(oracle.spin_potential(), expected);
    if (!(spin_error < 1.0e-3)) {
        std::cerr << "spin sinh error=" << spin_error
                  << " residual=" << diagnostics.relative_residual
                  << " balance=" << diagnostics.angular_momentum_balance_apm2[0] << '\n';
    }
    require(spin_error < 1.0e-3,
        "steady spin diffusion does not converge to the sinh oracle");
    const double balance_scale = std::abs(diagnostics.boundary_spin_flux_a[0]) +
        std::abs(diagnostics.reaction_integral_a[0]);
    require(std::abs(diagnostics.angular_momentum_balance_apm2[0]) <
            0.05 * std::max(balance_scale, 1.0e-14),
        "spin boundary flux and volumetric reaction do not balance");
}

void direct_she_sign_and_torque_projection_are_canonical()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        8, 1, 8, mfem::Element::TETRAHEDRON, 1.0, 0.1, 1.0);
    mfem::ConstantCoefficient sigma(3.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.sigma_s_spm = 2.0;
    parameters.lambda_sf_m = 0.25;
    parameters.theta_sh = 0.1;
    parameters.polarization_p = 0.0;
    parameters.lambda_j_m = 0.3;
    parameters.lambda_phi_m = 0.4;
    parameters.gamma_e_per_ts = 1.76085963023e11;
    parameters.saturation_magnetization_apm = 8.0e5;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);

    auto electrodes = x_electrodes(mesh);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) { return 1.0 - x[0]; });
    (void)oracle.solve_charge(electrodes, voltage, ChargeGauge::BoundaryReference);
    mfem::Array<int> no_spin_dirichlet(mesh.bdr_attributes.Max());
    no_spin_dirichlet = 0;
    const auto diagnostics = oracle.solve_spin(no_spin_dirichlet, nullptr);

    require(diagnostics.converged, "direct-SHE spin solve did not converge");
    require(diagnostics.spin_potential_top_minus_bottom_v[1] > 0.0,
        "epsilon_zxy direct-SHE sign is reversed");
    for (int component = 0; component < 3; ++component) {
        const double scale = std::abs(diagnostics.boundary_spin_flux_a[component]) +
            std::abs(diagnostics.reaction_integral_a[component]);
        if (!(std::abs(diagnostics.angular_momentum_balance_apm2[component]) <
                0.08 * std::max(scale, 1.0e-10))) {
            std::cerr << "SHE balance component=" << component
                      << " boundary=" << diagnostics.boundary_spin_flux_a[component]
                      << " reaction=" << diagnostics.reaction_integral_a[component]
                      << " residual=" << diagnostics.angular_momentum_balance_apm2[component]
                      << '\n';
        }
        require(std::abs(diagnostics.angular_momentum_balance_apm2[component]) <
                0.08 * std::max(scale, 1.0e-10),
            "direct-SHE global spin balance is not closed");
    }
    require(diagnostics.torque_l2_per_s > 0.0,
        "exchange/dephasing absorption was not projected to Gilbert torque");
}

void direct_she_matches_uniform_film_sinh_profile()
{
    constexpr double length_m = 1.0;
    constexpr double lambda_m = 0.2;
    constexpr double sigma_spm = 3.0;
    constexpr double sigma_s_spm = 2.0;
    constexpr double theta_sh = 0.1;
    constexpr double electric_field_v_per_m = 1.0;
    constexpr double transverse_width_m = 0.1;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        4, 4, 32, mfem::Element::HEXAHEDRON, length_m, transverse_width_m, length_m);
    mfem::ConstantCoefficient sigma(sigma_spm);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.sigma_s_spm = sigma_s_spm;
    parameters.lambda_sf_m = lambda_m;
    parameters.theta_sh = theta_sh;
    parameters.polarization_p = 0.0;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);

    auto electrodes = x_electrodes(mesh);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
        return 1.0 - electric_field_v_per_m * x[0];
    });
    const auto charge_diagnostics = oracle.solve_charge(
        electrodes, voltage, ChargeGauge::BoundaryReference);
    require(std::abs(charge_diagnostics.current_density_volume_average_apm2[0] -
            sigma_spm * electric_field_v_per_m) < 1.0e-10,
        "uniform-film direct-SHE charge field is not the prescribed linear field");
    mfem::Array<int> no_spin_dirichlet(mesh.bdr_attributes.Max());
    no_spin_dirichlet = 0;
    const auto diagnostics = oracle.solve_spin(no_spin_dirichlet, nullptr);
    require(diagnostics.converged, "uniform-film direct-SHE spin solve did not converge");

    const double z_min = 0.0;
    const double z_max = length_m;
    const double z_mid = 0.5 * (z_min + z_max);
    const double amplitude = 2.0 * theta_sh * sigma_spm * electric_field_v_per_m *
        lambda_m / (sigma_s_spm * std::cosh(0.5 * length_m / lambda_m));
    const double transverse_amplitude = -2.0 * theta_sh * sigma_spm * electric_field_v_per_m *
        lambda_m / (sigma_s_spm * std::cosh(0.5 * transverse_width_m / lambda_m));

    mfem::VectorFunctionCoefficient expected(3, [=](const mfem::Vector &x, mfem::Vector &value) {
        value.SetSize(3);
        value = 0.0;
        value[1] = amplitude * std::sinh((x[2] - z_mid) / lambda_m);
        value[2] = transverse_amplitude *
            std::sinh((x[1] - 0.5 * transverse_width_m) / lambda_m);
    });
    const double profile_error = max_vector_nodal_error(oracle.spin_potential(), expected);
    if (!(profile_error < 2.0e-3)) {
        std::cerr << "uniform-film SHE profile error=" << profile_error
                  << " top-bottom=" << diagnostics.spin_potential_top_minus_bottom_v[1]
                  << " expected-top-bottom="
                  << 2.0 * amplitude * std::sinh(0.5 * length_m / lambda_m)
                  << " residual=" << diagnostics.relative_residual
                  << " charge-current=" << charge_diagnostics.current_density_volume_average_apm2[0]
                  << '\n';
    }
    require(profile_error < 2.0e-3,
        "direct-SHE uniform-film profile does not match the sinh oracle");
    require(std::abs(diagnostics.spin_potential_top_minus_bottom_v[1] -
            2.0 * amplitude * std::sinh(0.5 * length_m / lambda_m)) < 2.0e-3,
        "direct-SHE top-to-bottom spin voltage does not match the sinh oracle");
}

void direct_she_converges_on_three_mesh_resolutions()
{
    constexpr double length_m = 1.0;
    constexpr double lambda_m = 0.2;
    constexpr double sigma_spm = 3.0;
    constexpr double sigma_s_spm = 2.0;
    constexpr double theta_sh = 0.1;
    constexpr double electric_field_v_per_m = 1.0;
    constexpr double transverse_width_m = 0.1;
    constexpr std::array<int, 3> z_elements = {16, 32, 64};
    std::array<double, 3> profile_errors{};

    const double amplitude = 2.0 * theta_sh * sigma_spm * electric_field_v_per_m *
        lambda_m / (sigma_s_spm * std::cosh(0.5 * length_m / lambda_m));
    const double transverse_amplitude = -2.0 * theta_sh * sigma_spm *
        electric_field_v_per_m * lambda_m /
        (sigma_s_spm * std::cosh(0.5 * transverse_width_m / lambda_m));

    for (std::size_t index = 0; index < z_elements.size(); ++index) {
        const int y_count = z_elements[index] / 8;
        mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
            4, y_count, z_elements[index], mfem::Element::HEXAHEDRON,
            length_m, transverse_width_m, length_m);
        mfem::ConstantCoefficient sigma(sigma_spm);
        mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
        SteadyTransportParameters parameters;
        parameters.sigma_s_spm = sigma_s_spm;
        parameters.lambda_sf_m = lambda_m;
        parameters.theta_sh = theta_sh;
        parameters.polarization_p = 0.0;
        SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);

        auto electrodes = x_electrodes(mesh);
        mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
            return 1.0 - electric_field_v_per_m * x[0];
        });
        const auto charge_diagnostics = oracle.solve_charge(
            electrodes, voltage, ChargeGauge::BoundaryReference);
        require(charge_diagnostics.converged,
            "three-grid direct-SHE charge solve did not converge");
        require(std::abs(charge_diagnostics.current_density_volume_average_apm2[0] -
                sigma_spm * electric_field_v_per_m) < 1.0e-10,
            "three-grid direct-SHE charge field is not the prescribed linear field");

        mfem::Array<int> no_spin_dirichlet(mesh.bdr_attributes.Max());
        no_spin_dirichlet = 0;
        const auto diagnostics = oracle.solve_spin(no_spin_dirichlet, nullptr);
        require(diagnostics.converged,
            "three-grid direct-SHE spin solve did not converge");
        require(diagnostics.relative_residual < 1.0e-10,
            "three-grid direct-SHE residual exceeds contract");

        const double z_mid = 0.5 * length_m;
        const double y_mid = 0.5 * transverse_width_m;
        mfem::VectorFunctionCoefficient expected(3, [=](const mfem::Vector &x,
                                                        mfem::Vector &value) {
            value.SetSize(3);
            value = 0.0;
            value[1] = amplitude * std::sinh((x[2] - z_mid) / lambda_m);
            value[2] = transverse_amplitude *
                std::sinh((x[1] - y_mid) / lambda_m);
        });
        profile_errors[index] = max_vector_nodal_error(oracle.spin_potential(), expected);
    }

    require(profile_errors[1] < profile_errors[0] &&
            profile_errors[2] < profile_errors[1],
        "direct-SHE profile error does not decrease on three mesh resolutions");
    require(profile_errors[2] < 0.8 * profile_errors[0],
        "direct-SHE three-grid refinement is too weak");
}

void reciprocal_m2_uniform_she_and_ishe_have_canonical_si_response()
{
    constexpr double sigma_spm = 4.0;
    constexpr double sigma_s_spm = 3.0;
    constexpr double theta_sh = 0.1;
    constexpr double electric_field_v_per_m = 1.0;
    constexpr double spin_gradient_v_per_m = 0.4;
    constexpr double spin_potential_gradient_v_per_m = 0.5 * spin_gradient_v_per_m;

    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        8, 2, 8, mfem::Element::TETRAHEDRON, 1.0, 0.4, 1.0);
    mfem::ConstantCoefficient sigma(sigma_spm);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    SteadyTransportParameters parameters;
    parameters.constitutive_model = TransportConstitutiveModel::Reciprocal;
    parameters.sigma_s_spm = sigma_s_spm;
    parameters.sigma_parallel_spm = sigma_spm;
    parameters.sigma_perpendicular_spm = sigma_spm;
    parameters.sigma_ahe_spm = 0.0;
    parameters.polarization_p = 0.0;
    parameters.theta_sh = theta_sh;
    parameters.lambda_sf_m = std::numeric_limits<double>::infinity();
    parameters.lambda_j_m = std::numeric_limits<double>::infinity();
    parameters.lambda_phi_m = std::numeric_limits<double>::infinity();
    parameters.relative_tolerance = 1.0e-11;
    parameters.maximum_iterations = 1000;
    SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);

    const auto charge_marker = all_external_boundaries(mesh);
    const auto spin_marker = all_external_boundaries(mesh);
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
        return 1.0 - x[0];
    });
    mfem::VectorFunctionCoefficient spin_boundary(3, [](const mfem::Vector &x,
                                                         mfem::Vector &value) {
        value.SetSize(3);
        value = 0.0;
        value[1] = 0.4 * (1.0 - x[2]);
    });

    const auto diagnostics = oracle.solve_reciprocal(
        charge_marker, voltage, spin_marker, &spin_boundary,
        ChargeGauge::BoundaryReference);
    require(diagnostics.charge.converged, "reciprocal charge solve did not converge");
    require(diagnostics.spin.converged, "reciprocal spin solve did not converge");
    require(diagnostics.charge.relative_residual < 1.0e-10,
        "reciprocal charge residual exceeds contract");
    require(diagnostics.spin.relative_residual < 1.0e-10,
        "reciprocal spin residual exceeds contract");

    const double expected_charge_x = sigma_spm * electric_field_v_per_m -
        theta_sh * sigma_spm * spin_potential_gradient_v_per_m;
    const double expected_spin_zy = sigma_s_spm * spin_potential_gradient_v_per_m +
        theta_sh * sigma_spm * electric_field_v_per_m;
    const auto &spin_current = oracle.spin_current_tensor();
    const int node_count = spin_current.FESpace()->GetNDofs();
    double mean_spin_zy = 0.0;
    for (int node = 0; node < node_count; ++node) {
        mean_spin_zy += spin_current[spin_current.FESpace()->DofToVDof(node, 7)];
    }
    mean_spin_zy /= node_count;
    mfem::VectorFunctionCoefficient expected_spin(3, [](const mfem::Vector &x,
                                                         mfem::Vector &value) {
        value.SetSize(3);
        value = 0.0;
        value[1] = 0.4 * (1.0 - x[2]);
    });
    mfem::FunctionCoefficient expected_voltage([](const mfem::Vector &x) {
        return 1.0 - x[0];
    });
    require(max_nodal_error(oracle.electric_potential(), expected_voltage) < 1.0e-9,
        "reciprocal charge potential does not reproduce the prescribed linear field");
    require(max_vector_nodal_error(oracle.spin_potential(), expected_spin) < 1.0e-9,
        "reciprocal spin potential does not reproduce the prescribed linear field");
    require(std::abs(diagnostics.charge.current_density_volume_average_apm2[0] -
            expected_charge_x) < 1.0e-9,
        "reciprocal iSHE charge current has the wrong sign or magnitude");
    require(std::abs(mean_spin_zy - expected_spin_zy) < 1.0e-9,
        "reciprocal direct-SHE spin current has the wrong sign or magnitude");
}

void reciprocal_m2_converges_on_three_mesh_resolutions()
{
    constexpr double length_m = 1.0;
    constexpr double width_m = 0.2;
    constexpr double height_m = 0.2;
    constexpr std::array<int, 3> x_elements = {8, 16, 32};
    std::array<double, 3> potential_midpoint{};
    std::array<double, 3> spin_midpoint{};

    for (std::size_t index = 0; index < x_elements.size(); ++index) {
        mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
            x_elements[index], 1, 1, mfem::Element::TETRAHEDRON,
            length_m, width_m, height_m);
        mfem::ConstantCoefficient sigma(4.0);
        mfem::VectorConstantCoefficient magnetization(
            mfem::Vector({1.0, 0.0, 0.0}));
        SteadyTransportParameters parameters;
        parameters.constitutive_model = TransportConstitutiveModel::Reciprocal;
        parameters.sigma_s_spm = 5.0;
        parameters.sigma_parallel_spm = 6.0;
        parameters.sigma_perpendicular_spm = 3.0;
        parameters.sigma_ahe_spm = 0.0;
        parameters.polarization_p = 0.25;
        parameters.theta_sh = 0.0;
        parameters.lambda_sf_m = 0.3;
        parameters.lambda_j_m = std::numeric_limits<double>::infinity();
        parameters.lambda_phi_m = std::numeric_limits<double>::infinity();
        parameters.relative_tolerance = 1.0e-11;
        parameters.maximum_iterations = 1000;
        SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);

        const auto electrodes = x_electrodes(mesh);
        mfem::FunctionCoefficient voltage([](const mfem::Vector &x) {
            return 1.0 - x[0];
        });
        mfem::VectorFunctionCoefficient spin_boundary(3, [](const mfem::Vector &x,
                                                             mfem::Vector &value) {
            value.SetSize(3);
            value = 0.0;
            value[0] = 1.0 - x[0];
        });
        const auto diagnostics = oracle.solve_reciprocal(
            electrodes, voltage, electrodes, &spin_boundary,
            ChargeGauge::BoundaryReference);
        require(diagnostics.charge.converged && diagnostics.spin.converged,
            "three-grid reciprocal M2 solve did not converge");
        require(diagnostics.charge.relative_residual < 1.0e-10 &&
                diagnostics.spin.relative_residual < 1.0e-10,
            "three-grid reciprocal M2 residual exceeds contract");

        double potential_sum = 0.0;
        double spin_sum = 0.0;
        int midpoint_count = 0;
        const double midpoint = 0.5 * length_m;
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            if (std::abs(mesh.GetVertex(vertex)[0] - midpoint) > 1.0e-12) {
                continue;
            }
            mfem::Array<int> scalar_dofs;
            oracle.electric_potential().FESpace()->GetVertexDofs(vertex, scalar_dofs);
            require(scalar_dofs.Size() == 1,
                "reciprocal M2 midpoint vertex does not have one scalar H1 dof");
            potential_sum += oracle.electric_potential()[scalar_dofs[0]];
            mfem::Array<int> vector_dofs;
            oracle.spin_potential().FESpace()->GetVertexDofs(vertex, vector_dofs);
            require(vector_dofs.Size() == 1,
                "reciprocal M2 midpoint vertex does not have one vector H1 dof");
            spin_sum += oracle.spin_potential()[
                oracle.spin_potential().FESpace()->DofToVDof(vector_dofs[0], 0)];
            ++midpoint_count;
        }
        require(midpoint_count > 0, "three-grid reciprocal M2 mesh has no midpoint vertices");
        potential_midpoint[index] = potential_sum / midpoint_count;
        spin_midpoint[index] = spin_sum / midpoint_count;
    }

    const double potential_coarse_error =
        std::abs(potential_midpoint[0] - potential_midpoint[2]);
    const double potential_medium_error =
        std::abs(potential_midpoint[1] - potential_midpoint[2]);
    const double spin_coarse_error =
        std::abs(spin_midpoint[0] - spin_midpoint[2]);
    const double spin_medium_error =
        std::abs(spin_midpoint[1] - spin_midpoint[2]);
    std::cout << "reciprocal M2 mesh midpoint: nx=8 V=" << potential_midpoint[0]
              << " mu_x=" << spin_midpoint[0]
              << ", nx=16 V=" << potential_midpoint[1]
              << " mu_x=" << spin_midpoint[1]
              << ", nx=32 V=" << potential_midpoint[2]
              << " mu_x=" << spin_midpoint[2]
              << "; errors coarse/medium=" << potential_coarse_error << "/"
              << potential_medium_error << " V, " << spin_coarse_error << "/"
              << spin_medium_error << " V\n";
    require(potential_coarse_error > potential_medium_error &&
            spin_coarse_error > spin_medium_error,
        "reciprocal M2 midpoint errors do not decrease under refinement");
    require(potential_medium_error < 0.8 * potential_coarse_error &&
            spin_medium_error < 0.8 * spin_coarse_error,
        "reciprocal M2 three-grid refinement is too weak");
}

mfem::Mesh make_four_terminal_plus_unforced_component_mesh()
{
    mfem::Mesh main_bar = mfem::Mesh::MakeCartesian3D(
        6, 2, 2, mfem::Element::TETRAHEDRON, 6.0, 2.0, 2.0);
    mfem::Mesh unforced_bar = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int vertex = 0; vertex < unforced_bar.GetNV(); ++vertex) {
        unforced_bar.GetVertex(vertex)[0] += 8.0;
    }

    const int main_nv = main_bar.GetNV();
    const int total_nv = main_nv + unforced_bar.GetNV();
    const int total_ne = main_bar.GetNE() + unforced_bar.GetNE();
    const int total_nbe = main_bar.GetNBE() + unforced_bar.GetNBE();
    mfem::Mesh combined(3, total_nv, total_ne, total_nbe, 3);
    for (int v = 0; v < main_nv; ++v) {
        combined.AddVertex(main_bar.GetVertex(v));
    }
    for (int v = 0; v < unforced_bar.GetNV(); ++v) {
        combined.AddVertex(unforced_bar.GetVertex(v));
    }
    for (int e = 0; e < main_bar.GetNE(); ++e) {
        mfem::Array<int> verts;
        main_bar.GetElementVertices(e, verts);
        int tet[4] = {verts[0], verts[1], verts[2], verts[3]};
        combined.AddTet(tet, 1);
    }
    for (int e = 0; e < unforced_bar.GetNE(); ++e) {
        mfem::Array<int> verts;
        unforced_bar.GetElementVertices(e, verts);
        int tet[4] = {
            main_nv + verts[0], main_nv + verts[1],
            main_nv + verts[2], main_nv + verts[3],
        };
        combined.AddTet(tet, 2);
    }

    // Assign four vertex-disjoint terminals on component 0:
    //   attr 1: x == 0
    //   attr 2: x == 6
    //   attr 3: y == 0 and 1 <= x <= 2
    //   attr 4: y == 2 and 4 <= x <= 5
    //   attr 5: remaining insulating faces on component 0
    //   attr 6: insulating faces on disconnected unforced component 1
    constexpr double eps = 1.0e-12;
    for (int b = 0; b < main_bar.GetNBE(); ++b) {
        mfem::Array<int> verts;
        main_bar.GetBdrElementVertices(b, verts);
        bool on_x0 = true, on_x6 = true, on_y0_patch = true, on_y2_patch = true;
        for (int i = 0; i < verts.Size(); ++i) {
            const double *p = main_bar.GetVertex(verts[i]);
            on_x0 = on_x0 && std::abs(p[0]) <= eps;
            on_x6 = on_x6 && std::abs(p[0] - 6.0) <= eps;
            on_y0_patch = on_y0_patch && std::abs(p[1]) <= eps &&
                p[0] >= 1.0 - eps && p[0] <= 2.0 + eps;
            on_y2_patch = on_y2_patch && std::abs(p[1] - 2.0) <= eps &&
                p[0] >= 4.0 - eps && p[0] <= 5.0 + eps;
        }
        int attr = 5;
        if (on_x0) attr = 1;
        else if (on_x6) attr = 2;
        else if (on_y0_patch) attr = 3;
        else if (on_y2_patch) attr = 4;
        int tri[3] = {verts[0], verts[1], verts[2]};
        combined.AddBdrTriangle(tri, attr);
    }
    for (int b = 0; b < unforced_bar.GetNBE(); ++b) {
        mfem::Array<int> verts;
        unforced_bar.GetBdrElementVertices(b, verts);
        int tri[3] = {
            main_nv + verts[0], main_nv + verts[1], main_nv + verts[2],
        };
        combined.AddBdrTriangle(tri, 6);
    }
    combined.FinalizeTopology();
    combined.Finalize(false, true);
    return combined;
}

void multi_terminal_factor_once_matches_independent_charge_solves()
{
    using fullmag::fem::multiphysics::SparseCpuBackendPolicy;

    mfem::Mesh mesh = make_four_terminal_plus_unforced_component_mesh();
    double sigma_value = 3.5;
    class MutableConductivity final : public mfem::Coefficient {
    public:
        explicit MutableConductivity(double &v) : value_(v) {}
        double Eval(mfem::ElementTransformation &, const mfem::IntegrationPoint &) override
        {
            return value_;
        }
    private:
        double &value_;
    } sigma(sigma_value);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));

    const std::vector<std::vector<int>> terminals = {{1}, {2}, {3}, {4}};
    const std::vector<double> requested = {-1.0, 0.4, 0.35, 0.25};

    std::vector<SparseCpuBackendPolicy> policies = {
        SparseCpuBackendPolicy::Auto,
    };
    if (can_test_hypre_backend()) {
        policies.push_back(SparseCpuBackendPolicy::Hypre);
    }
    policies.push_back(SparseCpuBackendPolicy::MfemSerial);

    std::vector<double> reference_voltages;
    mfem::Vector reference_potential;
    for (const auto policy : policies) {
        SteadyTransportParameters parameters;
        parameters.sigma_s_spm = 5.0;
        parameters.relative_tolerance = 1.0e-12;
        parameters.maximum_iterations = 2000;
        parameters.cpu_backend = policy;

        SteadyTransportOracle oracle(mesh, sigma, magnetization, parameters);
        const auto sol = oracle.solve_charge_terminal_currents(terminals, requested);
        require(sol.diagnostics.converged,
            "multi-terminal factor-once charge solve did not converge");
        require(!sol.diagnostics.resolved_solver.empty(),
            "multi-terminal factor-once did not populate resolved_solver");
        require(sol.diagnostics.relative_residual <= 1.0e-11,
            "multi-terminal factor-once residual exceeds tolerance");
        require(sol.gauge_terminal_indices == std::vector<int>{0},
            "multi-terminal factor-once chose the wrong gauge terminal");
        for (std::size_t t = 0; t < requested.size(); ++t) {
            require(std::abs(sol.measured_outward_current_a[t] - requested[t]) <=
                    1.0e-8 * std::abs(requested[t]) + 1.0e-18,
                "multi-terminal factor-once terminal current mismatch");
        }
        // Unforced disconnected component (x >= 7.5) must stay pinned at 0 V.
        const auto &pot = oracle.electric_potential();
        for (int v = 0; v < mesh.GetNV(); ++v) {
            if (mesh.GetVertex(v)[0] >= 7.5) {
                mfem::Array<int> dofs;
                pot.FESpace()->GetVertexDofs(v, dofs);
                require(dofs.Size() == 1 && std::abs(pot[dofs[0]]) <= 1.0e-12,
                    "unforced disconnected component drifted away from zero gauge");
            }
        }
        if (reference_voltages.empty()) {
            reference_voltages = sol.terminal_voltage_v;
            reference_potential = pot;

            // Cross-check against an independent single-call solve_charge with
            // the solved terminal voltages prescribed on attributes 1..4.
            mfem::Array<int> all_terms(mesh.bdr_attributes.Max());
            all_terms = 0;
            for (int attr = 1; attr <= 4; ++attr) all_terms[attr - 1] = 1;
            class BdrAttrVoltage final : public mfem::Coefficient {
            public:
                explicit BdrAttrVoltage(const std::vector<double> &v) : voltages_(v) {}
                double Eval(mfem::ElementTransformation &T, const mfem::IntegrationPoint &) override
                {
                    return (T.Attribute >= 1 && T.Attribute <= 4)
                        ? voltages_[static_cast<std::size_t>(T.Attribute - 1)]
                        : 0.0;
                }
            private:
                const std::vector<double> &voltages_;
            } prescribed_voltage(reference_voltages);

            SteadyTransportOracle check_oracle(mesh, sigma, magnetization, parameters);
            const auto check_diag = check_oracle.solve_charge(
                all_terms, prescribed_voltage, ChargeGauge::BoundaryReference);
            require(check_diag.converged && !check_diag.resolved_solver.empty(),
                "independent charge cross-check did not converge");
            mfem::Vector diff(check_oracle.electric_potential());
            diff -= reference_potential;
            require(diff.Normlinf() <= 1.0e-11 * std::max(1.0, reference_potential.Normlinf()),
                "multi-terminal factor-once potential differs from independent solve_charge");
        } else {
            for (std::size_t t = 0; t < requested.size(); ++t) {
                require(std::abs(sol.terminal_voltage_v[t] - reference_voltages[t]) <=
                        1.0e-11 * std::max(1.0, std::abs(reference_voltages[t])),
                    "multi-terminal voltages disagree across CPU sparse backends");
            }
            mfem::Vector diff(pot);
            diff -= reference_potential;
            require(diff.Normlinf() <= 1.0e-11 * std::max(1.0, reference_potential.Normlinf()),
                "multi-terminal potential disagrees across CPU sparse backends");
        }
    }

    // Verify per-call factorization lifetime: mutating external conductivity
    // between two calls on one SteadyTransportOracle must not reuse a stale factor.
    SteadyTransportParameters mut_params;
    mut_params.sigma_s_spm = 5.0;
    mut_params.relative_tolerance = 1.0e-12;
    SteadyTransportOracle mut_oracle(mesh, sigma, magnetization, mut_params);
    sigma_value = 3.5;
    const auto first = mut_oracle.solve_charge_terminal_currents(terminals, requested);
    sigma_value = 7.0;
    const auto second = mut_oracle.solve_charge_terminal_currents(terminals, requested);
    for (std::size_t t = 1; t < requested.size(); ++t) {
        require(std::abs(second.terminal_voltage_v[t] - 0.5 * first.terminal_voltage_v[t]) <=
                1.0e-11 * std::max(1.0, std::abs(first.terminal_voltage_v[t])),
            "solve_charge_terminal_currents reused a stale factor after conductivity mutation");
    }
}

void stiff_precession_m1_and_reciprocal_m2_converge_with_strong_ahe_and_contrast()
{
    using fullmag::fem::multiphysics::SparseCpuBackendPolicy;

    constexpr double length_m = 1.0;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        8, 8, 8, mfem::Element::TETRAHEDRON, length_m, length_m, length_m);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> verts;
        mesh.GetElementVertices(element, verts);
        double x = 0.0;
        for (int i = 0; i < verts.Size(); ++i) {
            x += mesh.GetVertex(verts[i])[0];
        }
        x /= static_cast<double>(verts.Size());
        mesh.GetElement(element)->SetAttribute(x < 0.5 * length_m ? 1 : 2);
    }

    // 100x conductivity contrast between layers.
    mfem::Vector sigma_values(2);
    sigma_values[0] = 1.0;
    sigma_values[1] = 100.0;
    mfem::PWConstCoefficient sigma(sigma_values);
    mfem::Vector m_dir({0.3, -0.4, std::sqrt(1.0 - 0.09 - 0.16)});
    mfem::VectorConstantCoefficient magnetization(m_dir);

    const auto electrodes = x_electrodes(mesh);
    mfem::Array<int> no_spin_dirichlet(mesh.bdr_attributes.Max());
    no_spin_dirichlet = 0;
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) { return 1.0 - x[0]; });

    std::vector<SparseCpuBackendPolicy> policies = {
        SparseCpuBackendPolicy::Auto,
    };
    if (can_test_hypre_backend()) {
        policies.push_back(SparseCpuBackendPolicy::Hypre);
    }

    mfem::Vector ref_m1_spin;
    mfem::Vector ref_m2_potential;
    mfem::Vector ref_m2_spin;

    for (const auto policy : policies) {
        // M1 stiff precession (lambda_J = 0.05 L) + 100x contrast.
        SteadyTransportParameters m1_params;
        m1_params.constitutive_model = TransportConstitutiveModel::OneWay;
        m1_params.sigma_s_spm = 100.0;
        m1_params.polarization_p = 0.2;
        m1_params.theta_sh = 0.15;
        m1_params.lambda_sf_m = 0.2 * length_m;
        m1_params.lambda_j_m = 0.05 * length_m;
        m1_params.lambda_phi_m = 0.15 * length_m;
        m1_params.relative_tolerance = 1.0e-11;
        m1_params.maximum_iterations = 2000;
        m1_params.cpu_backend = policy;

        SteadyTransportOracle m1_oracle(mesh, sigma, magnetization, m1_params);
        const auto m1_charge = m1_oracle.solve_charge(
            electrodes, voltage, ChargeGauge::BoundaryReference);
        require(m1_charge.converged && m1_charge.relative_residual <= 1.0e-11 &&
                !m1_charge.resolved_solver.empty(),
            "stiff-precession M1 charge solve did not converge");
        const auto m1_spin = m1_oracle.solve_spin(no_spin_dirichlet, nullptr);
        require(m1_spin.converged && m1_spin.relative_residual <= 1.0e-11 &&
                !m1_spin.resolved_solver.empty(),
            "stiff-precession M1 spin solve did not converge");
        for (int a = 0; a < 3; ++a) {
            const double scale = std::abs(m1_spin.boundary_spin_flux_a[a]) +
                std::abs(m1_spin.reaction_integral_a[a]);
            require(std::abs(m1_spin.angular_momentum_balance_apm2[a]) <=
                    1.0e-7 * std::max(scale, 1.0e-10),
                "stiff-precession M1 angular momentum balance is not closed");
        }
        require(m1_spin.torque_l2_per_s > 0.0,
            "stiff-precession M1 torque projection vanished");

        // M2 reciprocal with strong AMR (1.5x), AHE (0.3 * sigma_perp),
        // stiff precession (lambda_J = 0.05 L), and 100x conductivity contrast.
        SteadyTransportParameters m2_params = m1_params;
        m2_params.constitutive_model = TransportConstitutiveModel::Reciprocal;
        m2_params.sigma_perpendicular_spm = 50.0;
        m2_params.sigma_parallel_spm = 75.0;
        m2_params.sigma_ahe_spm = 0.3 * m2_params.sigma_perpendicular_spm;

        SteadyTransportOracle m2_oracle(mesh, sigma, magnetization, m2_params);
        const auto m2_diag = m2_oracle.solve_reciprocal(
            electrodes, voltage, no_spin_dirichlet, nullptr,
            ChargeGauge::BoundaryReference);
        require(m2_diag.charge.converged && m2_diag.spin.converged &&
                m2_diag.charge.relative_residual <= 1.0e-11 &&
                m2_diag.spin.relative_residual <= 1.0e-11 &&
                !m2_diag.charge.resolved_solver.empty() &&
                !m2_diag.spin.resolved_solver.empty(),
            "stiff-precession reciprocal M2 solve with strong AHE/contrast did not converge");
        for (int a = 0; a < 3; ++a) {
            const double scale = std::abs(m2_diag.spin.boundary_spin_flux_a[a]) +
                std::abs(m2_diag.spin.reaction_integral_a[a]);
            require(std::abs(m2_diag.spin.angular_momentum_balance_apm2[a]) <=
                    1.0e-7 * std::max(scale, 1.0e-10),
                "stiff-precession reciprocal M2 angular momentum balance is not closed");
        }
        require(m2_diag.spin.torque_l2_per_s > 0.0,
            "stiff-precession reciprocal M2 torque projection vanished");

        if (ref_m1_spin.Size() == 0) {
            ref_m1_spin = m1_oracle.spin_potential();
            ref_m2_potential = m2_oracle.electric_potential();
            ref_m2_spin = m2_oracle.spin_potential();
        } else {
            mfem::Vector d1(m1_oracle.spin_potential());
            d1 -= ref_m1_spin;
            require(d1.Normlinf() <= 1.0e-9 * std::max(1.0, ref_m1_spin.Normlinf()),
                "stiff M1 spin potential disagrees between Auto and Hypre");
            mfem::Vector d2v(m2_oracle.electric_potential());
            d2v -= ref_m2_potential;
            require(d2v.Normlinf() <= 1.0e-9 * std::max(1.0, ref_m2_potential.Normlinf()),
                "stiff M2 electric potential disagrees between Auto and Hypre");
            mfem::Vector d2s(m2_oracle.spin_potential());
            d2s -= ref_m2_spin;
            require(d2s.Normlinf() <= 1.0e-9 * std::max(1.0, ref_m2_spin.Normlinf()),
                "stiff M2 spin potential disagrees between Auto and Hypre");
        }
    }
}

void gpu_cudss_transport_parity_when_cuda_enabled()
{
    using fullmag::fem::multiphysics::SparseExecutionTarget;

    mfem::Mesh mesh = make_four_terminal_plus_unforced_component_mesh();
    mfem::ConstantCoefficient sigma(4.0);
    mfem::VectorConstantCoefficient magnetization(mfem::Vector({0.0, 0.0, 1.0}));
    const std::vector<std::vector<int>> terminals = {{1}, {2}, {3}, {4}};
    const std::vector<double> requested = {-1.0, 0.4, 0.35, 0.25};

#if defined(FULLMAG_FEM_CUDSS_POISSON_ENABLED) && FULLMAG_FEM_CUDSS_POISSON_ENABLED && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
    int device_count = 0;
    const cudaError_t count_err = cudaGetDeviceCount(&device_count);
    if (count_err != cudaSuccess || device_count <= 0) {
        SteadyTransportParameters gpu_params;
        gpu_params.sigma_s_spm = 5.0;
        gpu_params.execution_target = SparseExecutionTarget::GpuCudss;
        SteadyTransportOracle gpu_oracle(mesh, sigma, magnetization, gpu_params);
        bool failed_closed = false;
        try {
            (void)gpu_oracle.solve_charge_terminal_currents(terminals, requested);
        } catch (const std::runtime_error &) {
            failed_closed = true;
        }
        require(failed_closed,
            "GpuCudss transport request without visible CUDA device must throw (no silent CPU fallback)");
        return;
    }

    SteadyTransportParameters cpu_params;
    cpu_params.sigma_s_spm = 5.0;
    cpu_params.relative_tolerance = 1.0e-12;
    cpu_params.execution_target = SparseExecutionTarget::Cpu;
    SteadyTransportParameters gpu_params = cpu_params;
    gpu_params.execution_target = SparseExecutionTarget::GpuCudss;

    SteadyTransportOracle cpu_charge_oracle(mesh, sigma, magnetization, cpu_params);
    SteadyTransportOracle gpu_charge_oracle(mesh, sigma, magnetization, gpu_params);
    const auto cpu_sol = cpu_charge_oracle.solve_charge_terminal_currents(terminals, requested);
    const auto gpu_sol = gpu_charge_oracle.solve_charge_terminal_currents(terminals, requested);
    require(gpu_sol.diagnostics.converged &&
            gpu_sol.diagnostics.resolved_solver.rfind("cuda_cudss_", 0) == 0,
        "GpuCudss multi-terminal charge solve did not resolve to cuDSS");
    for (std::size_t t = 0; t < requested.size(); ++t) {
        require(std::abs(gpu_sol.terminal_voltage_v[t] - cpu_sol.terminal_voltage_v[t]) <=
                1.0e-11 * std::max(1.0, std::abs(cpu_sol.terminal_voltage_v[t])),
            "GpuCudss multi-terminal voltage disagrees with CPU");
    }

    mfem::Mesh m2_mesh = mfem::Mesh::MakeCartesian3D(
        6, 2, 6, mfem::Element::TETRAHEDRON, 1.0, 0.4, 1.0);
    SteadyTransportParameters m2_cpu;
    m2_cpu.constitutive_model = TransportConstitutiveModel::Reciprocal;
    m2_cpu.sigma_s_spm = 5.0;
    m2_cpu.sigma_parallel_spm = 6.0;
    m2_cpu.sigma_perpendicular_spm = 3.0;
    m2_cpu.sigma_ahe_spm = 0.5;
    m2_cpu.polarization_p = 0.25;
    m2_cpu.theta_sh = 0.1;
    m2_cpu.lambda_sf_m = 0.3;
    m2_cpu.lambda_j_m = 0.1;
    m2_cpu.lambda_phi_m = 0.2;
    m2_cpu.relative_tolerance = 1.0e-12;
    m2_cpu.execution_target = SparseExecutionTarget::Cpu;
    SteadyTransportParameters m2_gpu = m2_cpu;
    m2_gpu.execution_target = SparseExecutionTarget::GpuCudss;

    const auto electrodes = x_electrodes(m2_mesh);
    mfem::Array<int> no_spin(m2_mesh.bdr_attributes.Max());
    no_spin = 0;
    mfem::FunctionCoefficient voltage([](const mfem::Vector &x) { return 1.0 - x[0]; });

    SteadyTransportOracle m2_cpu_oracle(m2_mesh, sigma, magnetization, m2_cpu);
    SteadyTransportOracle m2_gpu_oracle(m2_mesh, sigma, magnetization, m2_gpu);
    const auto m2_cpu_diag = m2_cpu_oracle.solve_reciprocal(
        electrodes, voltage, no_spin, nullptr, ChargeGauge::BoundaryReference);
    const auto m2_gpu_diag = m2_gpu_oracle.solve_reciprocal(
        electrodes, voltage, no_spin, nullptr, ChargeGauge::BoundaryReference);
    require(m2_cpu_diag.charge.converged && m2_gpu_diag.charge.converged &&
            m2_gpu_diag.spin.converged &&
            m2_gpu_diag.spin.resolved_solver.rfind("cuda_cudss_", 0) == 0,
        "GpuCudss reciprocal M2 solve did not resolve to cuDSS");
    mfem::Vector dv(m2_gpu_oracle.electric_potential());
    dv -= m2_cpu_oracle.electric_potential();
    require(dv.Normlinf() <= 1.0e-11 * std::max(1.0, m2_cpu_oracle.electric_potential().Normlinf()),
        "GpuCudss reciprocal M2 electric potential disagrees with CPU");
    mfem::Vector ds(m2_gpu_oracle.spin_potential());
    ds -= m2_cpu_oracle.spin_potential();
    require(ds.Normlinf() <= 1.0e-11 * std::max(1.0, m2_cpu_oracle.spin_potential().Normlinf()),
        "GpuCudss reciprocal M2 spin potential disagrees with CPU");
#else
    SteadyTransportParameters gpu_params;
    gpu_params.sigma_s_spm = 5.0;
    gpu_params.execution_target = SparseExecutionTarget::GpuCudss;
    SteadyTransportOracle gpu_oracle(mesh, sigma, magnetization, gpu_params);
    bool failed_closed = false;
    try {
        (void)gpu_oracle.solve_charge_terminal_currents(terminals, requested);
    } catch (const std::runtime_error &) {
        failed_closed = true;
    }
    require(failed_closed,
        "GpuCudss transport request silently fell back to CPU without CUDA/cuDSS");
#endif
}

} // namespace

int main()
{
    try {
        charge_uniform_bar_is_linear_and_conservative();
        charge_weak_terminal_reaction_preserves_uneliminated_rhs();
        missing_charge_gauge_fails_closed();
        disconnected_unforced_conductor_receives_independent_gauge();
        disconnected_terminal_currents_keep_independent_scales();
        transparent_layered_bar_preserves_series_current();
        mixing_interface_fails_closed_without_broken_h1();
        invalid_dissipative_block_fails_closed();
        spin_diffusion_matches_sinh_profile();
        direct_she_sign_and_torque_projection_are_canonical();
        direct_she_matches_uniform_film_sinh_profile();
        direct_she_converges_on_three_mesh_resolutions();
        reciprocal_m2_uniform_she_and_ishe_have_canonical_si_response();
        const auto m2_convergence_oracle = &reciprocal_m2_converges_on_three_mesh_resolutions;
        m2_convergence_oracle();
        multi_terminal_factor_once_matches_independent_charge_solves();
        stiff_precession_m1_and_reciprocal_m2_converge_with_strong_ahe_and_contrast();
        gpu_cudss_transport_parity_when_cuda_enabled();
        std::cout << "fem steady transport contract: PASS\n";
        return EXIT_SUCCESS;
    } catch (const std::exception &error) {
        std::cerr << "fem steady transport contract: FAIL: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
