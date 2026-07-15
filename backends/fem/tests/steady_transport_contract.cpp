#include "cpu/mfem/transport/steady_transport.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <stdexcept>

namespace {

using fullmag::fem::transport::ChargeGauge;
using fullmag::fem::transport::SteadyTransportOracle;
using fullmag::fem::transport::SteadyTransportParameters;

constexpr double kTolerance = 2.0e-10;

void require(bool condition, const char *message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
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

} // namespace

int main()
{
    try {
        charge_uniform_bar_is_linear_and_conservative();
        missing_charge_gauge_fails_closed();
        transparent_layered_bar_preserves_series_current();
        mixing_interface_fails_closed_without_broken_h1();
        invalid_dissipative_block_fails_closed();
        spin_diffusion_matches_sinh_profile();
        direct_she_sign_and_torque_projection_are_canonical();
        std::cout << "fem steady transport contract: PASS\n";
        return EXIT_SUCCESS;
    } catch (const std::exception &error) {
        std::cerr << "fem steady transport contract: FAIL: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
