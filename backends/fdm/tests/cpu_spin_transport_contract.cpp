#include <fullmag/fdm/cpu/charge_transport_v1.hpp>
#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include "spin_transport_validation_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace charge = fullmag::fdm::cpu::transport::v1;
namespace spin = fullmag::fdm::cpu::transport::spin::v1;

namespace {

using Vec3 = spin::Vector3;

void require(bool condition, const std::string &message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

void require_close(double actual,
                   double expected,
                   double absolute_tolerance,
                   const std::string &message) {
    if (!std::isfinite(actual) || !std::isfinite(expected) ||
        std::abs(actual - expected) > absolute_tolerance) {
        throw std::runtime_error(message + ": expected " + std::to_string(expected) +
                                 ", got " + std::to_string(actual));
    }
}

std::size_t cell_count(const charge::Grid &grid) {
    return grid.nx * grid.ny * grid.nz;
}

spin::BoundaryConditions insulating_boundaries() {
    spin::BoundaryConditions boundary;
    for (auto &condition : boundary.values) {
        condition = spin::BoundaryCondition::insulating();
    }
    return boundary;
}

std::shared_ptr<const charge::AcceptedChargeSnapshot> accepted_charge(
    const charge::Grid &grid,
    std::vector<double> conductivity,
    double x_min_v,
    double x_max_v,
    std::vector<charge::OrientedMixingInterface> interfaces = {}) {
    charge::Problem problem;
    problem.grid = grid;
    problem.conductivity_s_per_m = std::move(conductivity);
    problem.active_cells.assign(cell_count(grid), 1);
    for (auto &condition : problem.boundary.values) {
        condition = charge::BoundaryCondition::insulating();
    }
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(x_min_v);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(x_max_v);
    problem.interfaces = std::move(interfaces);
    const auto result = charge::solve(problem);
    require(result.ok(), "charge fixture solve failed: " + result.message);
    return result.solution.accepted_snapshot();
}

std::shared_ptr<const charge::AcceptedChargeSnapshot> accepted_charge_with_mask(
    const charge::Grid &grid,
    std::vector<double> conductivity,
    std::vector<std::uint8_t> active_cells) {
    charge::Problem problem;
    problem.grid = grid;
    problem.conductivity_s_per_m = std::move(conductivity);
    problem.active_cells = std::move(active_cells);
    for (auto &condition : problem.boundary.values) {
        condition = charge::BoundaryCondition::insulating();
    }
    problem.gauge = charge::Gauge::zero_mean;
    const auto result = charge::solve(problem);
    require(result.ok(), "masked charge fixture solve failed: " + result.message);
    return result.solution.accepted_snapshot();
}

spin::Problem base_problem(const charge::Grid &grid) {
    const std::size_t count = cell_count(grid);
    spin::Problem problem;
    problem.grid = grid;
    problem.accepted_charge_snapshot =
        accepted_charge(grid, std::vector<double>(count, 5.0), 0.0, 0.0);
    problem.spin_conductivity_s_per_m.assign(count, 4.0);
    problem.polarization.assign(count, 0.0);
    problem.spin_hall_angle.assign(count, 0.0);
    problem.magnetization.assign(count, Vec3{0.0, 0.0, 1.0});
    problem.reactions.assign(count, spin::ReactionLengths{});
    problem.active_cells.assign(count, 1);
    problem.region_ids.assign(count, 0);
    problem.boundary = insulating_boundaries();
    return problem;
}

spin::SolverOptions tight_options() {
    spin::SolverOptions options;
    options.relative_tolerance = 1.0e-10;
    options.absolute_tolerance_a = 1.0e-13;
    options.max_iterations = 4000;
    options.gmres_restart = 40;
    return options;
}

void theta_zero_reduces_to_source_free_diffusion_reaction() {
    charge::Grid grid{4, 2, 1, 0.25, 0.5, 1.0};
    auto problem = base_problem(grid);
    for (auto &reaction : problem.reactions) {
        reaction.spin_flip_m = 0.7;
    }
    problem.accepted_charge_snapshot =
        accepted_charge(grid, std::vector<double>(cell_count(grid), 5.0), 0.0, -0.7);

    const auto result = spin::solve(problem, tight_options());
    require(result.ok(), "theta_SH=0 solve failed: " + result.message);
    for (const Vec3 &value : result.solution.spin_potential_v) {
        require(value == Vec3{0.0, 0.0, 0.0},
                "theta_SH=0 created a spin potential source");
    }
    for (const auto *values : {&result.solution.face_spin_current_density_a_per_m2.x,
                               &result.solution.face_spin_current_density_a_per_m2.y,
                               &result.solution.face_spin_current_density_a_per_m2.z}) {
        require(std::all_of(values->begin(), values->end(), [](const Vec3 &value) {
                    return value == Vec3{0.0, 0.0, 0.0};
                }),
                "theta_SH=0 created a spin-current source");
    }
}

double diffusion_profile_error(std::size_t nx) {
    const double length = 5.0;
    const double lambda = 1.3;
    charge::Grid grid{nx, 1, 1, length / static_cast<double>(nx), 1.0, 1.0};
    auto problem = base_problem(grid);
    for (auto &reaction : problem.reactions) {
        reaction.spin_flip_m = lambda;
    }
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({1.0, 0.0, 0.0});
    problem.boundary[charge::Face::x_max] =
        spin::BoundaryCondition::specified_potential({0.0, 0.0, 0.0});

    const auto result = spin::solve(problem, tight_options());
    require(result.ok(), "1-D diffusion solve failed: " + result.message);
    double squared_error = 0.0;
    const double denominator = std::sinh(length / lambda);
    for (std::size_t x = 0; x < nx; ++x) {
        const double coordinate = (static_cast<double>(x) + 0.5) * grid.dx_m;
        const double exact = std::sinh((length - coordinate) / lambda) / denominator;
        const double error = result.solution.spin_potential_v[x][0] - exact;
        squared_error += error * error;
        require_close(result.solution.spin_potential_v[x][1], 0.0, 2.0e-11,
                      "1-D diffusion created y component");
        require_close(result.solution.spin_potential_v[x][2], 0.0, 2.0e-11,
                      "1-D diffusion created z component");
    }
    require(result.solution.diagnostics.recomputed_balance_integrated_l2_a <=
                result.solution.diagnostics.balance_tolerance_integrated_l2_a,
            "1-D diffusion did not pass independent integrated residual gate");
    return std::sqrt(squared_error / static_cast<double>(nx));
}

void spin_diffusion_matches_sinh_profile_at_three_resolutions() {
    const std::array<double, 3> errors{
        diffusion_profile_error(20),
        diffusion_profile_error(40),
        diffusion_profile_error(80),
    };
    require(errors[0] / errors[1] > 3.7,
            "coarse-to-medium spin diffusion is not second order");
    require(errors[1] / errors[2] > 3.7,
            "medium-to-fine spin diffusion is not second order");
}

spin::SolveResult she_film(double signed_charge_current) {
    constexpr std::size_t nz = 32;
    charge::Grid grid{3, 1, nz, 1.0, 1.0, 4.0 / static_cast<double>(nz)};
    auto problem = base_problem(grid);
    std::fill(problem.spin_hall_angle.begin(), problem.spin_hall_angle.end(), 0.2);
    for (auto &reaction : problem.reactions) {
        reaction.spin_flip_m = 1.1;
    }
    problem.accepted_charge_snapshot = accepted_charge(
        grid,
        std::vector<double>(cell_count(grid), 5.0),
        0.0,
        -signed_charge_current * static_cast<double>(grid.nx) * grid.dx_m / 5.0);
    return spin::solve(problem, tight_options());
}

void direct_she_sign_follows_exact_signed_face_current() {
    const auto positive = she_film(5.0);
    const auto negative = she_film(-5.0);
    require(positive.ok(), "positive-current SHE solve failed: " + positive.message);
    require(negative.ok(), "negative-current SHE solve failed: " + negative.message);
    require(positive.solution.spin_potential_v.back()[1] > 0.0,
            "positive charge current produced the wrong direct-SHE sign");
    require(positive.solution.spin_potential_v.front()[1] < 0.0,
            "positive charge current produced the wrong lower-surface SHE sign");
    for (std::size_t cell = 0; cell < positive.solution.spin_potential_v.size(); ++cell) {
        for (std::size_t component = 0; component < 3; ++component) {
            require_close(positive.solution.spin_potential_v[cell][component],
                          -negative.solution.spin_potential_v[cell][component],
                          2.0e-10,
                          "direct-SHE source did not reverse with exact face J_c");
        }
    }
}

void heterogeneous_exact_face_current_reconstruction_has_independent_mu_and_q_oracle() {
    charge::Grid grid{1, 2, 1, 1.0, 1.0, 1.0};
    charge::Problem charge_problem;
    charge_problem.grid = grid;
    charge_problem.conductivity_s_per_m = {2.0, 8.0};
    charge_problem.active_cells = {1, 1};
    for (auto &condition : charge_problem.boundary.values) {
        condition = charge::BoundaryCondition::insulating();
    }
    charge_problem.boundary[charge::Face::y_min] =
        charge::BoundaryCondition::voltage(1.0);
    charge_problem.boundary[charge::Face::y_max] =
        charge::BoundaryCondition::voltage(0.0);
    const auto charge_result = charge::solve(charge_problem);
    require(charge_result.ok(), "heterogeneous charge discriminator failed");

    constexpr double expected_jy = 1.6;
    const auto snapshot = charge_result.solution.accepted_snapshot();
    require_close(snapshot->face_current_density_a_per_m2().y[1], expected_jy, 1.0e-12,
                  "exact conservative heterogeneous face current");
    const double gradient_reconstruction_cell0 =
        charge_problem.conductivity_s_per_m[0] *
        (snapshot->potential_v()[0] - snapshot->potential_v()[1]) / grid.dy_m;
    const double gradient_reconstruction_cell1 =
        charge_problem.conductivity_s_per_m[1] *
        (snapshot->potential_v()[0] - snapshot->potential_v()[1]) / grid.dy_m;
    require(std::abs(gradient_reconstruction_cell0 - expected_jy) > 0.25 &&
                std::abs(gradient_reconstruction_cell1 - expected_jy) > 0.25,
            "heterogeneous fixture does not discriminate exact J_c/sigma from grad(V)");

    auto problem = base_problem(grid);
    problem.accepted_charge_snapshot = snapshot;
    std::fill(problem.spin_hall_angle.begin(), problem.spin_hall_angle.end(), 0.25);
    for (auto &reaction : problem.reactions) {
        reaction.spin_flip_m = 1.0;
    }
    problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    const auto result = spin::solve(problem, tight_options());
    require(result.ok(), "heterogeneous exact-Jc spin discriminator failed: " + result.message);

    constexpr double expected_she_source = 0.25 * expected_jy;
    constexpr double expected_mu_z = -expected_she_source / 6.0;
    constexpr double expected_qx_z = expected_she_source / 3.0;
    for (std::size_t cell = 0; cell < 2; ++cell) {
        require_close(result.solution.spin_potential_v[cell][2], expected_mu_z, 2.0e-11,
                      "independent two-cell exact-Jc spin-potential oracle");
        const std::size_t x_max_face = 1 + 2 * cell;
        require_close(result.solution.face_spin_current_density_a_per_m2.x[x_max_face][2],
                      expected_qx_z, 2.0e-11,
                      "independent exact-Jc boundary spin-flux oracle");
    }
}

void direct_she_levi_civita_oracle_covers_all_six_contractions() {
    struct Case {
        std::size_t normal_axis;
        std::size_t electric_axis;
        Vec3 expected;
    };
    const std::array<Case, 6> cases{{
        {0, 1, {0.0, 0.0, 1.0}},
        {0, 2, {0.0, -1.0, 0.0}},
        {1, 0, {0.0, 0.0, -1.0}},
        {1, 2, {1.0, 0.0, 0.0}},
        {2, 0, {0.0, 1.0, 0.0}},
        {2, 1, {-1.0, 0.0, 0.0}},
    }};
    for (const auto &test : cases) {
        Vec3 electric{};
        electric[test.electric_axis] = 2.0;
        const auto positive = spin::detail::direct_she_source(
            test.normal_axis, electric, 1.25);
        const auto negative = spin::detail::direct_she_source(
            test.normal_axis, {-electric[0], -electric[1], -electric[2]}, 1.25);
        for (std::size_t component = 0; component < 3; ++component) {
            const double expected = 2.5 * test.expected[component];
            require_close(positive[component], expected, 0.0,
                          "Levi-Civita direct-SHE contraction sign");
            require_close(negative[component], -expected, 0.0,
                          "direct-SHE current-sign reversal");
        }
    }
}

void local_fv_gate_rejects_equal_and_opposite_cell_defects() {
    const std::vector<Vec3> residual{{1.0, 0.0, 0.0}, {-1.0, 0.0, 0.0}};
    const std::vector<double> scale{1.0, 1.0};
    const auto gate = spin::detail::evaluate_local_residual_gate(
        residual, scale, 0.1, 0.0);
    require(!gate.accepted,
            "local FV gate accepted equal-and-opposite defects with zero global closure");
    require_close(gate.max_local_residual_tolerance_a_per_m3, 0.1, 0.0,
                  "local FV tolerance units/scale");
}

void end_to_end_local_gate_rejects_an_underresolved_spin_solution() {
    charge::Grid grid{3, 1, 1, 1.0, 1.0, 1.0};
    auto problem = base_problem(grid);
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({1.0, -0.25, 0.5});
    problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    problem.reactions = {
        spin::ReactionLengths{0.7, 0.0, 0.0},
        spin::ReactionLengths{1.1, 0.0, 0.0},
        spin::ReactionLengths{1.7, 0.0, 0.0},
    };
    auto options = tight_options();
    options.relative_tolerance = 1.0e-8;
    options.absolute_tolerance_a = 1.0e-12;
    options.local_relative_tolerance = 1.0e-18;
    options.local_absolute_tolerance_a_per_m3 = 0.0;
    const auto result = spin::solve(problem, options);
    require(result.status == spin::Status::did_not_converge,
            "end-to-end solve bypassed the stricter component-wise local FV gate");
    require(result.message.find("transport_balance_local_fv.v1") != std::string::npos,
            "end-to-end negative solve was rejected by a gate other than the local FV gate");
}

void spin_insulating_and_spin_sink_are_distinct() {
    charge::Grid grid{1, 1, 1, 1.0, 1.0, 1.0};
    auto insulating = base_problem(grid);
    insulating.reactions[0].spin_flip_m = 1.0;
    insulating.spin_hall_angle[0] = 0.25;
    insulating.accepted_charge_snapshot =
        accepted_charge(grid, {5.0}, 0.0, -0.4);
    auto sink = insulating;
    sink.boundary[charge::Face::z_min] = spin::BoundaryCondition::sink();
    sink.boundary[charge::Face::z_max] = spin::BoundaryCondition::sink();

    const auto insulating_result = spin::solve(insulating, tight_options());
    const auto sink_result = spin::solve(sink, tight_options());
    require(insulating_result.ok(), "spin-insulating solve failed");
    require(sink_result.ok(), "spin-sink solve failed");
    require(insulating_result.solution.face_spin_current_density_a_per_m2.z.front() ==
                Vec3{0.0, 0.0, 0.0},
            "spin-insulating boundary leaked spin flux");
    require(std::abs(sink_result.solution.face_spin_current_density_a_per_m2.z.front()[1]) > 0.0,
            "spin sink did not admit direct-SHE spin flux");
}

void transparent_interface_has_one_conservative_face_flux() {
    charge::Grid grid{2, 1, 1, 1.0, 1.0, 1.0};
    auto problem = base_problem(grid);
    problem.spin_conductivity_s_per_m = {2.0, 8.0};
    problem.region_ids = {1, 2};
    problem.reactions[0].spin_flip_m = 1.0;
    problem.reactions[1].spin_flip_m = 1.0;
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({1.0, -0.5, 0.25});
    problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    problem.interfaces.push_back(spin::Interface::transparent(
        spin::StructuredFace{0, 0, 1}, 0, 1));

    const auto result = spin::solve(problem, tight_options());
    require(result.ok(), "transparent-interface solve failed: " + result.message);
    require(result.solution.interface_fluxes.size() == 1,
            "transparent interface did not publish one observation");
    const auto &observation = result.solution.interface_fluxes.front();
    require(observation.negative_cell_flux_positive_axis_a_per_m2 ==
                observation.positive_cell_flux_positive_axis_a_per_m2,
            "transparent interface did not preserve flux continuity");
    require(result.solution.diagnostics.relative_global_balance <= 1.0e-9,
            "transparent interface failed global spin balance");
}

void exchange_dephasing_and_torque_stay_tangential() {
    charge::Grid grid{1, 1, 1, 1.0, 1.0, 1.0};
    auto problem = base_problem(grid);
    problem.reactions[0] = spin::ReactionLengths{2.0, 3.0, 4.0};
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({2.0, -3.0, 5.0});
    problem.boundary[charge::Face::x_max] =
        spin::BoundaryCondition::specified_potential({2.0, -3.0, 5.0});
    problem.torque_targets = spin::TorqueTargets{
        {1}, {8.0e5}, 1.76085963023e11,
    };

    const auto result = spin::solve(problem, tight_options());
    require(result.ok(), "exchange/dephasing solve failed: " + result.message);
    const auto &reaction = result.solution.reaction_channels[0];
    require_close(reaction.exchange_a_per_m3[2], 0.0, 1.0e-12,
                  "exchange reaction has a longitudinal component");
    require_close(reaction.dephasing_a_per_m3[2], 0.0, 1.0e-12,
                  "dephasing reaction has a longitudinal component");
    require_close(result.solution.transport_gilbert_torque_per_s[0][2], 0.0, 1.0e-12,
                  "transport torque has a longitudinal component");
    require(std::abs(reaction.exchange_a_per_m3[0]) > 0.0 &&
                std::abs(reaction.exchange_a_per_m3[1]) > 0.0,
            "exchange axis test is vacuous");
    constexpr double hbar_j_s = 1.054571817e-34;
    constexpr double elementary_charge_c = 1.602176634e-19;
    const auto mu = result.solution.spin_potential_v[0];
    const Vec3 expected_exchange{
        4.0 * mu[1] / 18.0,
        -4.0 * mu[0] / 18.0,
        0.0,
    };
    const Vec3 expected_dephasing{
        4.0 * mu[0] / 32.0,
        4.0 * mu[1] / 32.0,
        0.0,
    };
    const double torque_factor =
        -1.76085963023e11 / 8.0e5 * hbar_j_s /
        (2.0 * elementary_charge_c);
    for (std::size_t component = 0; component < 3; ++component) {
        require_close(reaction.exchange_a_per_m3[component],
                      expected_exchange[component], 2.0e-11,
                      "independent RJ algebraic oracle");
        require_close(reaction.dephasing_a_per_m3[component],
                      expected_dephasing[component], 2.0e-11,
                      "independent Rphi algebraic oracle");
        require_close(result.solution.transport_gilbert_torque_per_s[0][component],
                      torque_factor *
                          (expected_exchange[component] + expected_dephasing[component]),
                      2.0e-11,
                      "volumetric torque sign and angular-momentum scale");
    }
}

void verify_mixing_algebra_and_surface_torque(
    const spin::Problem &problem,
    const spin::SolveResult &result,
    std::size_t expected_target) {
    require(result.ok(), "mixing oracle solve failed: " + result.message);
    require(result.solution.interface_fluxes.size() == 1,
            "mixing oracle requires one public interface observation");
    const auto &interface = problem.interfaces.front();
    const auto &observation = result.solution.interface_fluxes.front();
    const auto &charge_observation =
        problem.accepted_charge_snapshot->interface_fluxes().front();
    const auto from_mu = result.solution.spin_potential_v[interface.from_cell];
    const auto to_mu = result.solution.spin_potential_v[interface.to_cell];
    const Vec3 delta_mu{from_mu[0] - to_mu[0],
                        from_mu[1] - to_mu[1],
                        from_mu[2] - to_mu[2]};
    const double longitudinal = delta_mu[2];
    const Vec3 incoming{0.0,
                        0.0,
                        (interface.g_up_s_per_m2 - interface.g_down_s_per_m2) *
                            charge_observation.delta_potential_trace_v};
    const Vec3 backflow{
        0.0,
        0.0,
        0.5 * (interface.g_up_s_per_m2 + interface.g_down_s_per_m2) *
            longitudinal,
    };
    const Vec3 absorbed{
        interface.g_r_s_per_m2 * delta_mu[0] +
            interface.g_i_s_per_m2 * delta_mu[1],
        interface.g_r_s_per_m2 * delta_mu[1] -
            interface.g_i_s_per_m2 * delta_mu[0],
        0.0,
    };
    const Vec3 parallel{incoming[0] + backflow[0],
                        incoming[1] + backflow[1],
                        incoming[2] + backflow[2]};
    const Vec3 from_outgoing{parallel[0] + absorbed[0],
                             parallel[1] + absorbed[1],
                             parallel[2] + absorbed[2]};
    const bool from_is_negative = interface.from_cell == interface.face.negative_cell;
    const Vec3 expected_negative = from_is_negative
                                       ? from_outgoing
                                       : Vec3{-parallel[0], -parallel[1], -parallel[2]};
    const Vec3 expected_positive = from_is_negative
                                       ? parallel
                                       : Vec3{-from_outgoing[0],
                                              -from_outgoing[1],
                                              -from_outgoing[2]};
    for (std::size_t component = 0; component < 3; ++component) {
        require_close(observation.incoming_longitudinal_a_per_m2[component],
                      incoming[component], 2.0e-10,
                      "mixing Gup/Gdown DeltaV trace oracle");
        require_close(observation.backflow_longitudinal_a_per_m2[component],
                      backflow[component], 2.0e-10,
                      "mixing longitudinal DeltaMu oracle");
        require_close(observation.absorbed_transverse_a_per_m2[component],
                      absorbed[component], 2.0e-10,
                      "mixing Gr/Gi algebraic oracle");
        require_close(observation.negative_cell_flux_positive_axis_a_per_m2[component],
                      expected_negative[component], 2.0e-10,
                      "mixing negative-cell trace orientation");
        require_close(observation.positive_cell_flux_positive_axis_a_per_m2[component],
                      expected_positive[component], 2.0e-10,
                      "mixing positive-cell trace orientation");
    }
    constexpr double hbar_j_s = 1.054571817e-34;
    constexpr double elementary_charge_c = 1.602176634e-19;
    const double factor = -problem.torque_targets.gamma_e_rad_per_s_t /
                          problem.torque_targets
                              .saturation_magnetization_a_per_m[expected_target] *
                          hbar_j_s / (2.0 * elementary_charge_c);
    const double area_over_volume =
        problem.grid.dy_m * problem.grid.dz_m /
        (problem.grid.dx_m * problem.grid.dy_m * problem.grid.dz_m);
    for (std::size_t component = 0; component < 3; ++component) {
        require_close(result.solution.transport_gilbert_torque_per_s[expected_target][component],
                      factor * absorbed[component] * area_over_volume,
                      2.0e-11,
                      "surface torque sign and area/volume scale");
    }
}

void mixing_interface_absorption_closes_with_torque() {
    charge::Grid grid{2, 1, 1, 1.0, 1.0, 1.0};
    auto problem = base_problem(grid);
    problem.accepted_charge_snapshot = accepted_charge(
        grid,
        {5.0, 5.0},
        1.0,
        0.0,
        {charge::OrientedMixingInterface::one_way({0, 0, 1}, 0, 1, 3.0, 1.0)});
    problem.region_ids = {1, 2};
    problem.reactions[0].spin_flip_m = 2.0;
    problem.reactions[1].spin_flip_m = 2.0;
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({1.0, 2.0, 0.0});
    problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    problem.interfaces.push_back(spin::Interface::mixing_conductance_v2(
        spin::StructuredFace{0, 0, 1},
        0,
        1,
        3.0,
        1.0,
        3.0,
        1.0,
        {0.0, 0.0, 1.0}));
    problem.torque_targets = spin::TorqueTargets{
        {0, 1}, {0.0, 8.0e5}, 1.76085963023e11,
    };

    const auto result = spin::solve(problem, tight_options());
    verify_mixing_algebra_and_surface_torque(problem, result, 1);
    require(result.solution.provenance.api_version == spin::api_version &&
                result.solution.provenance.formula_version == spin::formula_version &&
                result.solution.provenance.operator_version == spin::operator_version &&
                result.solution.provenance.electric_reconstruction_version ==
                    spin::electric_reconstruction_version &&
                result.solution.provenance.engine_version == spin::engine_version &&
                result.solution.provenance.residual_version == spin::residual_version &&
                result.solution.provenance.local_residual_version ==
                    spin::local_residual_version &&
                result.solution.provenance.interface_version == spin::interface_version &&
                result.solution.provenance.torque_operator_version ==
                    spin::torque_operator_version,
            "spin solution must publish every exact provenance field");
    require(result.solution.interface_fluxes.size() == 1,
            "spin provenance fixture must publish exactly one interface observation");
    const auto &observation = result.solution.interface_fluxes.front();
    require(std::hypot(observation.absorbed_transverse_a_per_m2[0],
                       observation.absorbed_transverse_a_per_m2[1]) > 0.0,
            "mixing-interface absorption test is vacuous");
    require(result.solution.transport_gilbert_torque_per_s[0] == Vec3{0.0, 0.0, 0.0},
            "mixing torque was applied to the N-side cell");
    require(std::hypot(result.solution.transport_gilbert_torque_per_s[1][0],
                       result.solution.transport_gilbert_torque_per_s[1][1]) > 0.0,
            "mixing torque was not applied to the F-side target");
    require(result.solution.diagnostics.relative_global_balance <= 1.0e-9,
            "spin + interface + torque balance did not close");

    auto reversed = base_problem(grid);
    reversed.region_ids = {1, 2};
    reversed.reactions = problem.reactions;
    reversed.boundary = problem.boundary;
    reversed.accepted_charge_snapshot = accepted_charge(
        grid,
        {5.0, 5.0},
        1.0,
        0.0,
        {charge::OrientedMixingInterface::one_way({0, 0, 1}, 1, 0, 3.0, 1.0)});
    reversed.interfaces.push_back(spin::Interface::mixing_conductance_v2(
        spin::StructuredFace{0, 0, 1}, 1, 0, 3.0, 1.0, 3.0, 1.0,
        {0.0, 0.0, 1.0}));
    reversed.torque_targets = spin::TorqueTargets{
        {1, 0}, {8.0e5, 0.0}, 1.76085963023e11,
    };
    const auto reversed_result = spin::solve(reversed, tight_options());
    verify_mixing_algebra_and_surface_torque(reversed, reversed_result, 0);
}

void transverse_only_mixing_absorbs_spin_without_charge_conduction() {
    charge::Grid grid{2, 1, 1, 1.0, 1.0, 1.0};
    auto problem = base_problem(grid);
    problem.accepted_charge_snapshot = accepted_charge(
        grid,
        {5.0, 5.0},
        1.0,
        0.0,
        {charge::OrientedMixingInterface::one_way({0, 0, 1}, 0, 1, 0.0, 0.0)});
    problem.region_ids = {1, 2};
    problem.reactions[0].spin_flip_m = 1.0;
    problem.reactions[1].spin_flip_m = 1.0;
    problem.boundary[charge::Face::x_min] =
        spin::BoundaryCondition::specified_potential({1.0, -0.5, 0.0});
    problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    problem.interfaces.push_back(spin::Interface::mixing_conductance_v2(
        {0, 0, 1}, 0, 1, 0.0, 0.0, 3.0, 1.0, {0.0, 0.0, 1.0}));
    problem.torque_targets = {{0, 1}, {0.0, 8.0e5}, 1.76085963023e11};

    const auto result = spin::solve(problem, tight_options());
    require(result.ok(), "transverse-only mixing solve failed: " + result.message);
    require(result.solution.interface_fluxes.size() == 1,
            "transverse-only mixing must publish one spin observation");
    const auto &observation = result.solution.interface_fluxes.front();
    require(observation.incoming_longitudinal_a_per_m2 == Vec3{} &&
                observation.backflow_longitudinal_a_per_m2 == Vec3{},
            "zero Gup/Gdown produced a longitudinal spin channel");
    require(std::hypot(observation.absorbed_transverse_a_per_m2[0],
                       observation.absorbed_transverse_a_per_m2[1]) > 0.0,
            "nonzero Gr/Gi did not absorb transverse spin");
    require(problem.accepted_charge_snapshot
                    ->interface_fluxes()
                    .front()
                    .from_to_current_density_a_per_m2 == 0.0,
            "transverse-only mixing leaked charge current");
}

void accepted_charge_snapshot_identity_and_interfaces_fail_closed() {
    charge::Grid grid{2, 1, 1, 1.0, 1.0, 1.0};

    auto mask_mismatch = base_problem(grid);
    mask_mismatch.accepted_charge_snapshot =
        accepted_charge_with_mask(grid, {5.0, 5.0}, {1, 0});
    mask_mismatch.active_cells = {0, 1};
    require(spin::solve(mask_mismatch, tight_options()).status ==
                spin::Status::invalid_argument,
            "spin-active cell outside the immutable charge-active mask was accepted");

    auto exact = base_problem(grid);
    exact.accepted_charge_snapshot = accepted_charge(
        grid,
        {5.0, 5.0},
        1.0,
        0.0,
        {charge::OrientedMixingInterface::one_way({0, 0, 1}, 0, 1, 3.0, 1.0)});
    exact.region_ids = {1, 2};
    exact.reactions[0].spin_flip_m = 1.0;
    exact.reactions[1].spin_flip_m = 1.0;
    exact.interfaces.push_back(spin::Interface::mixing_conductance_v2(
        {0, 0, 1}, 0, 1, 3.0, 1.0, 2.0, 0.5, {0.0, 0.0, 1.0}));
    const auto exact_result = spin::solve(exact, tight_options());
    require(exact_result.ok(),
            "exact charge/spin interface identity fixture must be accepted: " +
                exact_result.message);

    auto inactive_endpoint = exact;
    inactive_endpoint.active_cells[1] = 0;
    require(spin::solve(inactive_endpoint, tight_options()).status ==
                spin::Status::invalid_argument,
            "mixing interface with a spin-inactive endpoint was accepted");

    auto changed_g = exact;
    changed_g.interfaces[0].g_up_s_per_m2 = 4.0;
    require(spin::solve(changed_g, tight_options()).status ==
                spin::Status::invalid_argument,
            "changed Gup was accepted against the immutable charge snapshot");

    auto reversed = exact;
    reversed.interfaces[0].from_cell = 1;
    reversed.interfaces[0].to_cell = 0;
    require(spin::solve(reversed, tight_options()).status ==
                spin::Status::invalid_argument,
            "reversed interface orientation was accepted against the charge snapshot");

    auto missing = exact;
    missing.interfaces.clear();
    require(spin::solve(missing, tight_options()).status ==
                spin::Status::invalid_argument,
            "missing spin interface was accepted against an extra charge interface");

    auto extra = base_problem(grid);
    extra.region_ids = {1, 2};
    extra.interfaces.push_back(spin::Interface::mixing_conductance_v2(
        {0, 0, 1}, 0, 1, 3.0, 1.0, 2.0, 0.5, {0.0, 0.0, 1.0}));
    require(spin::solve(extra, tight_options()).status ==
                spin::Status::invalid_argument,
            "extra spin interface without charge identity was accepted");
}

void unsupported_and_invalid_inputs_fail_closed() {
    charge::Grid grid{2, 1, 1, 1.0, 1.0, 1.0};
    auto incomplete = base_problem(grid);
    incomplete.boundary.values[0] = {};
    require(spin::solve(incomplete, tight_options()).status == spin::Status::invalid_argument,
            "incomplete spin BC did not fail closed");

    auto nonfinite = base_problem(grid);
    nonfinite.spin_hall_angle[0] = std::numeric_limits<double>::quiet_NaN();
    require(spin::solve(nonfinite, tight_options()).status == spin::Status::invalid_argument,
            "NaN spin material did not fail closed");

    auto missing_interface = base_problem(grid);
    missing_interface.region_ids = {1, 2};
    require(spin::solve(missing_interface, tight_options()).status ==
                spin::Status::unsupported_model,
            "cross-region face without interface did not fail closed");

    auto sml = base_problem(grid);
    sml.region_ids = {1, 2};
    sml.interfaces.push_back(spin::Interface::sml_reservoir_v2(
        spin::StructuredFace{0, 0, 1}, 0, 1));
    require(spin::solve(sml, tight_options()).status == spin::Status::unsupported_model,
            "unimplemented SML reservoir did not fail closed");

    auto missing_snapshot = base_problem(grid);
    missing_snapshot.accepted_charge_snapshot.reset();
    require(spin::solve(missing_snapshot, tight_options()).status ==
                spin::Status::invalid_argument,
            "missing accepted charge snapshot did not fail closed");
}

} // namespace

int main() {
    try {
        theta_zero_reduces_to_source_free_diffusion_reaction();
        spin_diffusion_matches_sinh_profile_at_three_resolutions();
        direct_she_sign_follows_exact_signed_face_current();
        heterogeneous_exact_face_current_reconstruction_has_independent_mu_and_q_oracle();
        direct_she_levi_civita_oracle_covers_all_six_contractions();
        local_fv_gate_rejects_equal_and_opposite_cell_defects();
        end_to_end_local_gate_rejects_an_underresolved_spin_solution();
        spin_insulating_and_spin_sink_are_distinct();
        transparent_interface_has_one_conservative_face_flux();
        exchange_dephasing_and_torque_stay_tangential();
        mixing_interface_absorption_closes_with_torque();
        transverse_only_mixing_absorbs_spin_without_charge_conduction();
        accepted_charge_snapshot_identity_and_interfaces_fail_closed();
        unsupported_and_invalid_inputs_fail_closed();
        std::cout << "FDM CPU M1 steady spin transport contract: PASS\n";
        return EXIT_SUCCESS;
    } catch (const std::exception &error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
