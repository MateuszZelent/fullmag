#include <fullmag/fdm/cpu/charge_transport_v1.hpp>
#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace charge = fullmag::fdm::cpu::transport::v1;
namespace spin = fullmag::fdm::cpu::transport::spin::v1;

namespace {

struct Fixture {
    charge::Grid grid;
    double charge_sigma = 0.0;
    double left_voltage = 0.0;
    double right_voltage = 0.0;
    double spin_sigma = 0.0;
    double polarization = 0.0;
    double theta = 0.0;
    double lambda_sf = 0.0;
    double lambda_j = 0.0;
    double lambda_phi = 0.0;
    std::size_t interface_split_x = 0;
    double g_up = 0.0;
    double g_down = 0.0;
    double g_r = 0.0;
    double g_i = 0.0;
    double saturation_magnetization = 0.0;
    double gamma_e = 0.0;
};

struct OracleOutput {
    std::vector<double> mu;
    std::vector<double> qx;
    std::vector<double> qy;
    std::vector<double> qz;
    std::vector<double> spin_flip;
    std::vector<double> exchange;
    std::vector<double> dephasing;
    std::vector<double> magnetic;
    std::vector<double> torque;
    std::vector<double> interfaces;
    std::vector<double> boundary;
    std::vector<double> balance;
};

void require(bool condition, const std::string &message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

Fixture read_fixture(const std::string &path) {
    std::ifstream input(path);
    require(input.good(), "cannot open spin parity fixture");
    std::string schema;
    Fixture fixture;
    input >> schema;
    require(schema == "fullmag.fdm.spin.parity_fixture.v2", "unexpected fixture schema");
    input >> fixture.grid.nx >> fixture.grid.ny >> fixture.grid.nz >> fixture.grid.dx_m >>
        fixture.grid.dy_m >> fixture.grid.dz_m >> fixture.charge_sigma >> fixture.left_voltage >>
        fixture.right_voltage >> fixture.spin_sigma >> fixture.polarization >> fixture.theta >>
        fixture.lambda_sf >> fixture.lambda_j >> fixture.lambda_phi >>
        fixture.interface_split_x >> fixture.g_up >> fixture.g_down >> fixture.g_r >>
        fixture.g_i >> fixture.saturation_magnetization >> fixture.gamma_e;
    require(input.good(), "incomplete spin parity fixture");
    std::string trailing;
    require(!(input >> trailing), "trailing spin parity fixture tokens");
    return fixture;
}

std::vector<double> read_vector(std::istream &input, const std::string &expected_name) {
    std::string name;
    std::size_t count = 0;
    input >> name >> count;
    require(input.good() && name == expected_name, "missing oracle vector " + expected_name);
    std::vector<double> values(count);
    for (double &value : values) {
        input >> value;
        require(input.good() && std::isfinite(value), "non-finite oracle vector " + expected_name);
    }
    return values;
}

OracleOutput read_oracle(const std::string &path) {
    std::ifstream input(path);
    require(input.good(), "cannot open Rust spin oracle output");
    std::string schema;
    input >> schema;
    require(schema == "fullmag.fdm.spin.rust_oracle_output.v1", "unexpected oracle schema");
    OracleOutput output;
    output.mu = read_vector(input, "mu");
    output.qx = read_vector(input, "qx");
    output.qy = read_vector(input, "qy");
    output.qz = read_vector(input, "qz");
    output.spin_flip = read_vector(input, "spin_flip");
    output.exchange = read_vector(input, "exchange");
    output.dephasing = read_vector(input, "dephasing");
    output.magnetic = read_vector(input, "magnetic");
    output.torque = read_vector(input, "torque");
    output.interfaces = read_vector(input, "interfaces");
    output.boundary = read_vector(input, "boundary");
    output.balance = read_vector(input, "balance");
    std::string trailing;
    require(!(input >> trailing), "trailing Rust oracle output tokens");
    return output;
}

std::size_t cell_index(const charge::Grid &grid,
                       std::size_t x,
                       std::size_t y,
                       std::size_t z) {
    return x + grid.nx * (y + grid.ny * z);
}

charge::SolveResult solve_charge(const Fixture &fixture) {
    const std::size_t count = fixture.grid.nx * fixture.grid.ny * fixture.grid.nz;
    charge::Problem problem;
    problem.grid = fixture.grid;
    problem.conductivity_s_per_m.assign(count, fixture.charge_sigma);
    problem.active_cells.assign(count, 1);
    for (auto &condition : problem.boundary.values) {
        condition = charge::BoundaryCondition::insulating();
    }
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(fixture.left_voltage);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(fixture.right_voltage);
    for (std::size_t z = 0; z < fixture.grid.nz; ++z) {
        for (std::size_t y = 0; y < fixture.grid.ny; ++y) {
            const std::size_t lower =
                cell_index(fixture.grid, fixture.interface_split_x - 1, y, z);
            const std::size_t upper = cell_index(fixture.grid, fixture.interface_split_x, y, z);
            problem.interfaces.push_back(charge::OrientedMixingInterface::one_way(
                {0, lower, upper}, lower, upper, fixture.g_up, fixture.g_down));
        }
    }
    return charge::solve(problem);
}

spin::Problem make_spin_problem(const Fixture &fixture,
                                const charge::Solution &charge_solution) {
    const std::size_t count = fixture.grid.nx * fixture.grid.ny * fixture.grid.nz;
    spin::Problem problem;
    problem.grid = fixture.grid;
    problem.accepted_charge_snapshot = charge_solution.accepted_snapshot();
    problem.spin_conductivity_s_per_m.assign(count, fixture.spin_sigma);
    problem.polarization.assign(count, fixture.polarization);
    problem.spin_hall_angle.assign(count, fixture.theta);
    problem.magnetization.assign(count, {0.0, 0.0, 1.0});
    problem.reactions.assign(count,
                             {fixture.lambda_sf, fixture.lambda_j, fixture.lambda_phi});
    problem.active_cells.assign(count, 1);
    problem.region_ids.resize(count);
    for (std::size_t z = 0; z < fixture.grid.nz; ++z) {
        for (std::size_t y = 0; y < fixture.grid.ny; ++y) {
            for (std::size_t x = 0; x < fixture.grid.nx; ++x) {
                problem.region_ids[cell_index(fixture.grid, x, y, z)] =
                    x < fixture.interface_split_x ? 1U : 2U;
            }
        }
    }
    for (auto &condition : problem.boundary.values) {
        condition = spin::BoundaryCondition::insulating();
    }
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({0.2, -0.1, 0.05});
    problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    for (std::size_t z = 0; z < fixture.grid.nz; ++z) {
        for (std::size_t y = 0; y < fixture.grid.ny; ++y) {
            const std::size_t lower =
                cell_index(fixture.grid, fixture.interface_split_x - 1, y, z);
            const std::size_t upper = cell_index(fixture.grid, fixture.interface_split_x, y, z);
            problem.interfaces.push_back(spin::Interface::mixing_conductance_v2(
                {0, lower, upper},
                lower,
                upper,
                fixture.g_up,
                fixture.g_down,
                fixture.g_r,
                fixture.g_i,
                {0.0, 0.0, 1.0}));
        }
    }
    problem.torque_targets = spin::TorqueTargets{
        std::vector<std::uint8_t>(count, 1),
        std::vector<double>(count, fixture.saturation_magnetization),
        fixture.gamma_e,
    };
    return problem;
}

template <typename Values, typename Projection>
std::vector<double> flatten(const Values &values, Projection projection) {
    std::vector<double> result;
    result.reserve(3 * values.size());
    for (const auto &value : values) {
        const auto vector = projection(value);
        result.insert(result.end(), vector.begin(), vector.end());
    }
    return result;
}

void compare(const std::vector<double> &native,
             const std::vector<double> &rust,
             double relative_tolerance,
             double absolute_tolerance,
             const std::string &name) {
    require(native.size() == rust.size(), name + " length mismatch");
    for (std::size_t index = 0; index < native.size(); ++index) {
        require(std::isfinite(native[index]) && std::isfinite(rust[index]),
                name + " contains non-finite values");
        const double tolerance =
            absolute_tolerance + relative_tolerance * std::max(std::abs(native[index]),
                                                                std::abs(rust[index]));
        require(std::abs(native[index] - rust[index]) <= tolerance,
                name + " mismatch at index " + std::to_string(index));
    }
}

void compare_oracle(const Fixture &fixture, const OracleOutput &oracle) {
    const auto charge_result = solve_charge(fixture);
    require(charge_result.ok(), "native charge fixture solve failed: " + charge_result.message);
    const auto spin_result = spin::solve(make_spin_problem(fixture, charge_result.solution));
    require(spin_result.ok(), "native spin fixture solve failed: " + spin_result.message);
    const auto &solution = spin_result.solution;
    const auto vectors = [](const auto &value) { return value; };
    compare(flatten(solution.spin_potential_v, vectors), oracle.mu, 2.0e-8, 2.0e-11, "mu");
    compare(flatten(solution.face_spin_current_density_a_per_m2.x, vectors),
            oracle.qx, 2.0e-8, 2.0e-10, "qx");
    compare(flatten(solution.face_spin_current_density_a_per_m2.y, vectors),
            oracle.qy, 2.0e-8, 2.0e-10, "qy");
    compare(flatten(solution.face_spin_current_density_a_per_m2.z, vectors),
            oracle.qz, 2.0e-8, 2.0e-10, "qz");
    compare(flatten(solution.reaction_channels,
                    [](const auto &value) { return value.spin_flip_a_per_m3; }),
            oracle.spin_flip, 2.0e-8, 2.0e-10, "spin_flip");
    compare(flatten(solution.reaction_channels,
                    [](const auto &value) { return value.exchange_a_per_m3; }),
            oracle.exchange, 2.0e-8, 2.0e-10, "exchange");
    compare(flatten(solution.reaction_channels,
                    [](const auto &value) { return value.dephasing_a_per_m3; }),
            oracle.dephasing, 2.0e-8, 2.0e-10, "dephasing");
    compare(flatten(solution.reaction_channels,
                    [](const auto &value) { return value.magnetic_torque_sink_a_per_m3; }),
            oracle.magnetic, 2.0e-8, 2.0e-10, "magnetic");
    compare(flatten(solution.transport_gilbert_torque_per_s, vectors),
            oracle.torque, 2.0e-8, 2.0e-10, "torque");
    std::vector<double> interfaces;
    interfaces.reserve(15 * solution.interface_fluxes.size());
    for (const auto &observation : solution.interface_fluxes) {
        for (const auto &value : {observation.incoming_longitudinal_a_per_m2,
                                  observation.backflow_longitudinal_a_per_m2,
                                  observation.absorbed_transverse_a_per_m2,
                                  observation.negative_cell_flux_positive_axis_a_per_m2,
                                  observation.positive_cell_flux_positive_axis_a_per_m2}) {
            interfaces.insert(interfaces.end(), value.begin(), value.end());
        }
    }
    compare(interfaces, oracle.interfaces, 2.0e-8, 2.0e-10, "interfaces");
    require(solution.interface_fluxes.size() ==
                (fixture.interface_split_x == 0
                     ? 0U
                     : fixture.grid.ny * fixture.grid.nz),
            "native spin parity must publish the exact interface observation count");
    compare(flatten(solution.diagnostics.boundary_outward_current_a, vectors),
            oracle.boundary, 2.0e-8, 2.0e-10, "boundary");
    const std::vector<double> balance{
        solution.diagnostics.net_boundary_current_a[0],
        solution.diagnostics.net_boundary_current_a[1],
        solution.diagnostics.net_boundary_current_a[2],
        solution.diagnostics.spin_flip_sink_a[0],
        solution.diagnostics.spin_flip_sink_a[1],
        solution.diagnostics.spin_flip_sink_a[2],
        solution.diagnostics.magnetic_torque_sink_a[0],
        solution.diagnostics.magnetic_torque_sink_a[1],
        solution.diagnostics.magnetic_torque_sink_a[2],
        solution.diagnostics.global_balance_closure_a[0],
        solution.diagnostics.global_balance_closure_a[1],
        solution.diagnostics.global_balance_closure_a[2],
    };
    compare(balance, oracle.balance, 2.0e-8, 2.0e-10, "balance");
    require(solution.provenance.api_version == spin::api_version &&
                solution.provenance.formula_version == spin::formula_version &&
                solution.provenance.operator_version == spin::operator_version &&
                solution.provenance.electric_reconstruction_version ==
                    spin::electric_reconstruction_version &&
                solution.provenance.engine_version == spin::engine_version &&
                solution.provenance.residual_version == spin::residual_version &&
                solution.provenance.local_residual_version ==
                    spin::local_residual_version &&
                solution.provenance.interface_version == spin::interface_version &&
                solution.provenance.torque_operator_version ==
                    spin::torque_operator_version,
            "native spin provenance versions are incomplete");
}

} // namespace

int main(int argc, char **argv) {
    try {
        require(argc == 3, "usage: cpu_spin_transport_parity FIXTURE RUST_OUTPUT");
        compare_oracle(read_fixture(argv[1]), read_oracle(argv[2]));
        std::cout << "FDM CPU M1 steady spin Rust/native parity: PASS\n";
        return EXIT_SUCCESS;
    } catch (const std::exception &error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
