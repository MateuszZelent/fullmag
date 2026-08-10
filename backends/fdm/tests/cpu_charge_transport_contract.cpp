#include <fullmag/fdm/cpu/charge_transport_v1.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <numeric>
#include <string>
#include <string_view>
#include <vector>

namespace charge = fullmag::fdm::cpu::transport::v1;

namespace {

constexpr double parity_relative_tolerance = 2.0e-10;
constexpr double parity_potential_absolute_tolerance_v = 1.0e-12;
constexpr double parity_current_density_absolute_tolerance_a_per_m2 = 1.0e-12;
constexpr double parity_integrated_current_absolute_tolerance_a = 1.0e-18;

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_close(double actual, double expected, double tolerance, const char *message) {
    if (!std::isfinite(actual) || !std::isfinite(expected) ||
        !std::isfinite(tolerance) || std::abs(actual - expected) > tolerance) {
        std::fprintf(stderr,
                     "FAIL: %s: expected %.16e, got %.16e (tolerance %.3e)\n",
                     message,
                     expected,
                     actual,
                     tolerance);
        std::exit(1);
    }
}

void check_quantity_close(double actual,
                          double expected,
                          double absolute_tolerance,
                          double relative_tolerance,
                          const char *message) {
    check(std::isfinite(actual) && std::isfinite(expected),
          "native/Rust parity values must be finite");
    const double tolerance =
        absolute_tolerance + relative_tolerance * std::max(std::abs(actual), std::abs(expected));
    check_close(actual, expected, tolerance, message);
}

void check_integrated_current_close(double actual, double expected, const char *message) {
    check_quantity_close(actual,
                         expected,
                         parity_integrated_current_absolute_tolerance_a,
                         parity_relative_tolerance,
                         message);
}

void set_all_insulating(charge::Problem &problem) {
    for (auto &condition : problem.boundary.values) {
        condition = charge::BoundaryCondition::insulating();
    }
}

charge::Problem uniform_bar(std::size_t nx, double left_v, double right_v) {
    charge::Problem problem;
    problem.grid = {nx, 1, 1, 2.0e-9, 3.0e-9, 4.0e-9};
    problem.conductivity_s_per_m.assign(nx, 5.8e7);
    problem.active_cells.assign(nx, 1);
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(left_v);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(right_v);
    return problem;
}

void uniform_conductor_has_linear_potential_and_one_conservative_flux() {
    const auto result = charge::solve(uniform_bar(8, 0.0, 0.16));
    check(result.ok(), result.message.c_str());
    const double expected_jx = -5.8e7 * 0.16 / (8.0 * 2.0e-9);
    for (std::size_t x = 0; x < 8; ++x) {
        check_close(result.solution.potential_v[x],
                    0.16 * (static_cast<double>(x) + 0.5) / 8.0,
                    5.0e-12,
                    "uniform bar potential");
    }
    for (double flux : result.solution.face_current_density_a_per_m2.x) {
        check_close(flux,
                    expected_jx,
                    std::abs(expected_jx) * 1.0e-10,
                    "uniform bar face current");
    }
    check(std::all_of(result.solution.face_current_density_a_per_m2.y.begin(),
                      result.solution.face_current_density_a_per_m2.y.end(),
                      [](double value) { return value == 0.0; }),
          "uniform bar y-face current must vanish");
    check(std::all_of(result.solution.face_current_density_a_per_m2.z.begin(),
                      result.solution.face_current_density_a_per_m2.z.end(),
                      [](double value) { return value == 0.0; }),
          "uniform bar z-face current must vanish");
    std::printf("uniform_bar iterations=%zu recursive_l2=%.16e recomputed_l2=%.16e "
                "algebraic_tol=%.16e integrated_balance_A=%.16e balance_tol_A=%.16e "
                "net_boundary_A=%.16e net_tol_A=%.16e max_div_Apm3=%.16e\n",
                result.solution.diagnostics.iterations,
                result.solution.diagnostics.algebraic_residual_l2_a_per_m3,
                result.solution.diagnostics.recomputed_algebraic_residual_l2_a_per_m3,
                result.solution.diagnostics.algebraic_tolerance_l2_a_per_m3,
                result.solution.diagnostics.physical_balance_integrated_l2_a,
                result.solution.diagnostics.physical_balance_tolerance_l2_a,
                result.solution.diagnostics.net_boundary_current_a,
                result.solution.diagnostics.net_boundary_tolerance_a,
                result.solution.diagnostics.max_abs_divergence_a_per_m3);
}

void layered_series_conductor_uses_harmonic_face_conductivity() {
    charge::Problem problem;
    problem.grid = {2, 1, 1, 1.0, 1.0, 1.0};
    problem.conductivity_s_per_m = {2.0, 8.0};
    problem.active_cells = {1, 1};
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(0.0);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(1.0);

    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    for (double flux : result.solution.face_current_density_a_per_m2.x) {
        check_close(flux, -1.6, 1.0e-11, "layered harmonic face current");
    }
    check_close(result.solution.potential_v[0], 0.4, 1.0e-11, "layered left potential");
    check_close(result.solution.potential_v[1], 0.9, 1.0e-11, "layered right potential");
}

void one_way_mixing_interface_publishes_accepted_oriented_traces() {
    charge::Problem problem;
    problem.grid = {2, 1, 1, 2.0, 1.0, 1.0};
    problem.conductivity_s_per_m = {2.0, 8.0};
    problem.active_cells = {1, 1};
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(1.0);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(0.0);
    problem.interfaces.push_back(charge::OrientedMixingInterface::one_way(
        {0, 0, 1}, 0, 1, 3.0, 1.0));

    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    const double expected_current = 2.0 / 3.0;
    for (double current : result.solution.face_current_density_a_per_m2.x) {
        check_close(current, expected_current, 1.0e-12,
                    "mixing charge current must be one conservative face value");
    }
    const auto snapshot = result.solution.accepted_snapshot();
    check(snapshot != nullptr && snapshot->identity() != 0,
          "successful charge solve must publish a non-forgeable accepted snapshot");
    check(snapshot->interface_fluxes().size() == 1,
          "accepted charge snapshot must publish one interface observation");
    const auto &observation = snapshot->interface_fluxes().front();
    check_close(observation.from_potential_trace_v, 1.0 / 3.0, 1.0e-12,
                "N-side accepted charge trace");
    check_close(observation.to_potential_trace_v, 1.0 / 6.0, 1.0e-12,
                "F-side accepted charge trace");
    check_close(observation.delta_potential_trace_v, 1.0 / 6.0, 1.0e-12,
                "accepted interface trace jump");
    check_close(observation.from_to_current_density_a_per_m2, expected_current, 1.0e-12,
                "one-way charge law (Gup+Gdown) Delta V");
    check_close(observation.global_face_current_density_a_per_m2, expected_current, 1.0e-12,
                "global face orientation for N-to-F interface");
    check(result.solution.provenance.operator_version == charge::operator_version,
          "mixing charge solve must retain the bulk harmonic operator");
    check(result.solution.provenance.interface_operator_version ==
              charge::mixing_operator_version,
          "mixing charge solve must separately publish the trace-elimination operator");
    check(snapshot->interfaces().size() == 1 && snapshot->interface_fluxes().size() == 1,
          "mixing provenance must correspond to exactly one accepted interface observation");

    auto reversed = problem;
    reversed.interfaces = {charge::OrientedMixingInterface::one_way(
        {0, 0, 1}, 1, 0, 3.0, 1.0)};
    const auto reversed_result = charge::solve(reversed);
    check(reversed_result.ok(), reversed_result.message.c_str());
    const auto &reversed_observation =
        reversed_result.solution.accepted_snapshot()->interface_fluxes().front();
    check_close(reversed_observation.from_to_current_density_a_per_m2,
                -expected_current, 1.0e-12,
                "reversing oriented normal must reverse from-to current");
    check_close(reversed_observation.global_face_current_density_a_per_m2,
                expected_current, 1.0e-12,
                "reversing descriptor must preserve the physical global face current");
}

void transverse_only_mixing_is_charge_insulating_and_splits_components() {
    charge::Problem problem;
    problem.grid = {2, 1, 1, 1.0, 1.0, 1.0};
    problem.conductivity_s_per_m = {2.0, 8.0};
    problem.active_cells = {1, 1};
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(1.0);
    problem.gauge = charge::Gauge::zero_mean;
    problem.interfaces.push_back(charge::OrientedMixingInterface::one_way(
        {0, 0, 1}, 0, 1, 0.0, 0.0));

    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    check_close(result.solution.potential_v[0], 1.0, 1.0e-12,
                "anchored component potential");
    check_close(result.solution.potential_v[1], 0.0, 1.0e-12,
                "independent zero-mean component potential");
    check_close(result.solution.face_current_density_a_per_m2.x[1], 0.0, 0.0,
                "transverse-only interface charge flux");
    const auto snapshot = result.solution.accepted_snapshot();
    check(snapshot->interfaces().size() == 1 && snapshot->interface_fluxes().size() == 1,
          "transverse-only interface must retain one accepted identity/observation");
    const auto &observation = snapshot->interface_fluxes().front();
    check_close(observation.from_potential_trace_v, 1.0, 1.0e-12,
                "transverse-only from trace");
    check_close(observation.to_potential_trace_v, 0.0, 1.0e-12,
                "transverse-only to trace");
    check_close(observation.from_to_current_density_a_per_m2, 0.0, 0.0,
                "transverse-only oriented charge observation");

    auto negative = problem;
    negative.interfaces[0].g_up_s_per_m2 = -1.0;
    check(charge::solve(negative).status == charge::Status::invalid_argument,
          "negative longitudinal interface conductance must fail closed");
    auto nonfinite = problem;
    nonfinite.interfaces[0].g_down_s_per_m2 =
        std::numeric_limits<double>::quiet_NaN();
    check(charge::solve(nonfinite).status == charge::Status::invalid_argument,
          "non-finite longitudinal interface conductance must fail closed");
}

void sigma_zero_and_inactive_barriers_do_not_leak() {
    for (bool zero_sigma_only : {false, true}) {
        charge::Problem problem;
        problem.grid = {5, 1, 1, 1.0, 1.0, 1.0};
        problem.conductivity_s_per_m.assign(5, 2.0);
        problem.active_cells.assign(5, 1);
        set_all_insulating(problem);
        problem.conductivity_s_per_m[2] = 0.0;
        if (!zero_sigma_only) {
            problem.active_cells[2] = 0;
        }
        problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(0.0);
        problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(1.0);

        const auto result = charge::solve(problem);
        check(result.ok(), result.message.c_str());
        check_close(result.solution.face_current_density_a_per_m2.x[2],
                    0.0,
                    0.0,
                    "left barrier face");
        check_close(result.solution.face_current_density_a_per_m2.x[3],
                    0.0,
                    0.0,
                    "right barrier face");
        check_close(result.solution.diagnostics.net_boundary_current_a,
                    0.0,
                    1.0e-12,
                    "barrier boundary balance");
    }
}

void conservation_reports_boundary_current_and_cell_divergence_independently() {
    const auto result = charge::solve(uniform_bar(16, -0.2, 0.3));
    check(result.ok(), result.message.c_str());
    const auto &diagnostics = result.solution.diagnostics;
    const double current_scale = diagnostics.boundary_current_l1_a;
    const double divergence_scale = 5.8e7 * 0.5 / (32.0e-9 * 2.0e-9);
    check(std::abs(diagnostics.net_boundary_current_a) <= 1.0e-10 * current_scale,
          "net boundary current must close independently");
    check(diagnostics.max_abs_divergence_a_per_m3 <= 1.0e-9 * divergence_scale,
          "maximum physical cell divergence must close independently");
    check(diagnostics.algebraic_residual_l2_a_per_m3 >= 0.0,
          "algebraic residual must be published");
    check(diagnostics.physical_residual_l2_a_per_m3 >= 0.0,
          "physical residual must be published");
}

void pure_neumann_requires_explicit_gauge_and_balanced_current() {
    charge::Problem problem;
    problem.grid = {4, 1, 1, 1.0, 2.0, 3.0};
    problem.conductivity_s_per_m.assign(4, 2.0);
    problem.active_cells.assign(4, 1);

    const auto unset = charge::solve(problem);
    check(unset.status == charge::Status::invalid_argument,
          "FDM charge must reject six unset boundary faces");
    set_all_insulating(problem);
    const auto missing = charge::solve(problem);
    check(missing.status == charge::Status::missing_gauge,
          "pure-Neumann solve must fail closed without a gauge");

    problem.gauge = charge::Gauge::zero_mean;
    const auto gauged = charge::solve(problem);
    check(gauged.ok(), gauged.message.c_str());
    for (double potential : gauged.solution.potential_v) {
        check_close(potential, 0.0, 0.0, "zero-mean null solution");
    }

    problem.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::total_current(-6.0);
    problem.boundary[charge::Face::x_max] =
        charge::BoundaryCondition::total_current(6.0);
    const auto driven = charge::solve(problem);
    check(driven.ok(), driven.message.c_str());
    check_close(driven.solution.diagnostics.boundary_outward_current_a[0],
                -6.0,
                1.0e-11,
                "minimum current electrode");
    check_close(driven.solution.diagnostics.boundary_outward_current_a[1],
                6.0,
                1.0e-11,
                "maximum current electrode");

    problem.boundary[charge::Face::x_max] =
        charge::BoundaryCondition::total_current(5.0);
    const auto unbalanced = charge::solve(problem);
    check(unbalanced.status == charge::Status::incompatible_boundary_current,
          "unbalanced pure-Neumann current must fail closed");
}

void internal_potential_jump_drives_one_closed_conservative_loop() {
    charge::Problem problem;
    problem.grid = {3, 3, 1, 1.0, 1.0, 1.0};
    problem.conductivity_s_per_m.assign(9, 1.0);
    problem.active_cells.assign(9, 1);
    problem.conductivity_s_per_m[4] = 0.0;
    problem.active_cells[4] = 0;
    set_all_insulating(problem);
    problem.gauge = charge::Gauge::zero_mean;
    problem.impressed_potential_jump_faces = {
        {0, {1, 0, 3}, +1, 0.8},
    };

    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    const std::size_t source_face = 0 + problem.grid.nx * 1;
    check_close(result.solution.face_current_density_a_per_m2.y[source_face],
                0.1,
                1.0e-12,
                "closed-loop source-cut current");
    check_close(result.solution.diagnostics.net_boundary_current_a,
                0.0,
                0.0,
                "closed-loop source cut must not inject exterior current");
    check(result.solution.provenance.operator_version ==
              charge::source_cut_operator_version,
          "source-cut solve must publish the affine jump operator version");
    const auto snapshot = result.solution.accepted_snapshot();
    check(snapshot != nullptr && snapshot->impressed_potential_jump_faces().size() == 1,
          "accepted charge snapshot must retain the exact source-cut face");
}

void internal_potential_jump_faces_fail_closed_when_malformed() {
    auto problem = uniform_bar(2, 0.0, 1.0);
    problem.impressed_potential_jump_faces = {{0, {0, 0, 1}, +1, 0.1}};
    problem.interfaces = {charge::OrientedMixingInterface::one_way(
        {0, 0, 1}, 0, 1, 1.0, 1.0)};
    check(charge::solve(problem).status == charge::Status::invalid_argument,
          "source cut may not overlap a mixing interface");

    problem.interfaces.clear();
    problem.impressed_potential_jump_faces.push_back(
        problem.impressed_potential_jump_faces.front());
    check(charge::solve(problem).status == charge::Status::invalid_argument,
          "duplicate source-cut faces must fail closed");

    problem.impressed_potential_jump_faces.resize(1);
    problem.impressed_potential_jump_faces[0].normal_sign = 0;
    check(charge::solve(problem).status == charge::Status::invalid_argument,
          "source-cut normal must be signed and axis-oriented");

    problem.impressed_potential_jump_faces[0].normal_sign = 1;
    problem.impressed_potential_jump_faces[0].potential_jump_v =
        std::numeric_limits<double>::quiet_NaN();
    check(charge::solve(problem).status == charge::Status::invalid_argument,
          "source-cut jump must be finite");
}

charge::Problem disconnected_component_current_problem(double component_a_return_current_a) {
    charge::Problem problem;
    problem.grid = {3, 3, 1, 1.0, 1.0, 1.0};
    problem.conductivity_s_per_m.assign(9, 0.0);
    problem.active_cells.assign(9, 0);
    problem.conductivity_s_per_m[0] = 2.0;
    problem.conductivity_s_per_m[8] = 3.0;
    problem.active_cells[0] = 1;
    problem.active_cells[8] = 1;
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::total_current(-1.0e-12);
    problem.boundary[charge::Face::y_min] =
        charge::BoundaryCondition::total_current(component_a_return_current_a);
    problem.boundary[charge::Face::x_max] =
        charge::BoundaryCondition::total_current(-1.0e-9);
    problem.boundary[charge::Face::y_max] =
        charge::BoundaryCondition::total_current(1.0e-9);
    problem.gauge = charge::Gauge::zero_mean;
    return problem;
}

void disconnected_component_current_compatibility_is_local_and_dimensionally_scaled() {
    const auto balanced = charge::solve(disconnected_component_current_problem(1.0e-12));
    check(balanced.ok(), balanced.message.c_str());
    check_close(balanced.solution.potential_v[0], 0.0, 0.0,
                "component A independent zero mean");
    check_close(balanced.solution.potential_v[8], 0.0, 0.0,
                "component B independent zero mean");
    check(balanced.solution.diagnostics.component_net_current_a.size() == 2,
          "both floating components must publish an independent balance");
    check(balanced.solution.diagnostics.component_boundary_current_l1_a.size() == 2 &&
              balanced.solution.diagnostics.component_net_current_tolerance_a.size() == 2,
          "each floating component must publish its local scale and tolerance");
    for (std::size_t component = 0; component < 2; ++component) {
        check(std::abs(balanced.solution.diagnostics.component_net_current_a[component]) <=
                  balanced.solution.diagnostics.component_net_current_tolerance_a[component],
              "each floating component must independently close its current balance");
    }
    check_close(balanced.solution.diagnostics.component_boundary_current_l1_a[0],
                2.0e-12,
                1.0e-26,
                "component A local boundary-current scale");
    check_close(balanced.solution.diagnostics.component_boundary_current_l1_a[1],
                2.0e-9,
                1.0e-23,
                "component B local boundary-current scale");

    const auto locally_unbalanced =
        charge::solve(disconnected_component_current_problem(1.0e-12 + 1.0e-18));
    check(locally_unbalanced.status == charge::Status::incompatible_boundary_current,
          "a local pA current imbalance must not be hidden by another nA component or by gauge projection");
}

void swapping_voltage_electrodes_reverses_the_current_sign() {
    const auto forward = charge::solve(uniform_bar(8, 0.0, 0.16));
    const auto reverse = charge::solve(uniform_bar(8, 0.16, 0.0));
    check(forward.ok(), forward.message.c_str());
    check(reverse.ok(), reverse.message.c_str());
    for (std::size_t face = 0;
         face < forward.solution.face_current_density_a_per_m2.x.size();
         ++face) {
        check_close(reverse.solution.face_current_density_a_per_m2.x[face],
                    -forward.solution.face_current_density_a_per_m2.x[face],
                    std::abs(forward.solution.face_current_density_a_per_m2.x[face]) * 1.0e-10,
                    "electrode swap current sign");
    }
}

double manufactured_resistivity_error(std::size_t nx) {
    charge::Problem problem;
    const double h = 1.0 / static_cast<double>(nx);
    problem.grid = {nx, 1, 1, h, 1.0, 1.0};
    problem.active_cells.assign(nx, 1);
    set_all_insulating(problem);
    for (std::size_t x = 0; x < nx; ++x) {
        const double center = (static_cast<double>(x) + 0.5) * h;
        problem.conductivity_s_per_m.push_back(1.0 / (1.0 + center));
    }
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(0.0);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(1.0);
    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    double max_error = 0.0;
    for (std::size_t x = 0; x < nx; ++x) {
        const double center = (static_cast<double>(x) + 0.5) * h;
        const double exact = (center + 0.5 * center * center) / 1.5;
        max_error = std::max(max_error, std::abs(result.solution.potential_v[x] - exact));
    }
    return max_error;
}

void analytic_problem_converges_over_three_resolutions() {
    const std::array<double, 3> errors = {
        manufactured_resistivity_error(8),
        manufactured_resistivity_error(16),
        manufactured_resistivity_error(32),
    };
    check(errors[1] < 0.35 * errors[0],
          "8-to-16 manufactured error must show second-order decay");
    check(errors[2] < 0.35 * errors[1],
          "16-to-32 manufactured error must show second-order decay");
    std::printf("manufactured_resistivity max_error_V N8=%.16e N16=%.16e N32=%.16e\n",
                errors[0],
                errors[1],
                errors[2]);
}

void result_provenance_is_exact_and_versioned() {
    const auto result = charge::solve(uniform_bar(4, 0.0, 1.0));
    check(result.ok(), result.message.c_str());
    const auto &provenance = result.solution.provenance;
    check(provenance.api_version == "fullmag.fdm.cpu.charge.v1",
          "charge API version must be exact");
    check(provenance.operator_version == "fv_charge_harmonic_v1",
          "charge operator version must be exact");
    check(provenance.interface_operator_version.empty(),
          "charge solve without interfaces must not publish an interface operator");
    check(provenance.solver_version == "fdm_charge_cg_matrix_free_v1",
          "charge solver version must be exact");
    check(provenance.residual_version == "charge_balance_integrated_l2.v1",
          "charge residual version must be exact");
    check(result.solution.diagnostics.iterations > 0,
          "charge iterations must be published");
}

void boundary_coverage_is_explicit_and_fdm_has_no_inserted_default() {
    charge::Problem partial = uniform_bar(3, 0.0, 1.0);
    partial.boundary[charge::Face::y_min] = {};
    const auto rejected = charge::solve(partial);
    check(rejected.status == charge::Status::invalid_argument,
          "partially authored boundary coverage must fail closed");

    charge::Problem natural;
    natural.grid = {2, 1, 1, 1.0, 1.0, 1.0};
    natural.conductivity_s_per_m.assign(2, 1.0);
    natural.active_cells.assign(2, 1);
    natural.gauge = charge::Gauge::zero_mean;
    const auto rejected_unset = charge::solve(natural);
    check(rejected_unset.status == charge::Status::invalid_argument,
          "FDM all-unset boundaries must fail closed instead of inserting the FEM-only default");
}

void convergence_requires_recomputed_algebraic_and_integrated_physical_gates() {
    const auto accepted = charge::solve(uniform_bar(16, -0.2, 0.3));
    check(accepted.ok(), accepted.message.c_str());
    const auto &diagnostics = accepted.solution.diagnostics;
    check(diagnostics.recomputed_algebraic_residual_l2_a_per_m3 <=
              diagnostics.algebraic_tolerance_l2_a_per_m3,
          "recomputed algebraic residual must satisfy its published gate");
    check(diagnostics.physical_balance_integrated_l2_a <=
              diagnostics.physical_balance_tolerance_l2_a,
          "integrated cell balance must satisfy its published gate");
    check(std::abs(diagnostics.net_boundary_current_a) <=
              diagnostics.net_boundary_tolerance_a,
          "net boundary balance must satisfy its published gate");

    charge::SolverOptions loose;
    loose.relative_tolerance = 0.9;
    const auto rejected = charge::solve(uniform_bar(16, -0.2, 0.3), loose);
    check(rejected.status == charge::Status::balance_failure,
          "a loose recursive CG residual must not bypass the physical balance gate");
}

void numerical_policy_rejects_zero_relative_tolerance_and_avoids_harmonic_overflow() {
    charge::SolverOptions invalid;
    invalid.relative_tolerance = 0.0;
    check(charge::solve(uniform_bar(2, 0.0, 1.0), invalid).status ==
              charge::Status::invalid_argument,
          "relative tolerance must be strictly positive");

    charge::Problem large;
    large.grid = {2, 1, 1, 1.0, 1.0, 1.0};
    large.conductivity_s_per_m = {1.0e308, 5.0e307};
    large.active_cells = {1, 1};
    set_all_insulating(large);
    large.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(0.0);
    large.boundary[charge::Face::x_max] = charge::BoundaryCondition::voltage(1.0e-308);
    const auto stable = charge::solve(large);
    check(stable.ok(), stable.message.c_str());
    check(std::all_of(stable.solution.face_current_density_a_per_m2.x.begin(),
                      stable.solution.face_current_density_a_per_m2.x.end(),
                      [](double value) { return std::isfinite(value); }),
          "large finite conductivities must not overflow the harmonic mean");

    auto overflowing_interface = uniform_bar(2, 0.0, 1.0);
    overflowing_interface.interfaces.push_back(charge::OrientedMixingInterface::one_way(
        {0, 0, 1}, 0, 1, 1.0e308, 1.0e308));
    const auto rejected_interface = charge::solve(overflowing_interface);
    check(rejected_interface.status == charge::Status::invalid_argument,
          "finite interface conductances with an overflowing sum must fail validation");
}

void resolved_total_current_electrode_potential_is_published_with_face_identity() {
    charge::Problem problem;
    problem.grid = {4, 1, 1, 1.0, 2.0, 3.0};
    problem.conductivity_s_per_m.assign(4, 2.0);
    problem.active_cells.assign(4, 1);
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::total_current(-6.0);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::total_current(6.0);
    problem.gauge = charge::Gauge::zero_mean;
    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    check(result.solution.resolved_electrode_potentials.size() == 2,
          "both resolved total-current electrode potentials must be published");
    check(result.solution.resolved_electrode_potentials[0].face == charge::Face::x_min &&
              result.solution.resolved_electrode_potentials[1].face == charge::Face::x_max,
          "resolved electrode potentials must retain face identity");
}

void specified_outward_current_density_is_local_oriented_and_not_total_current() {
    charge::Problem problem;
    problem.grid = {2, 2, 1, 2.0, 3.0, 5.0};
    problem.conductivity_s_per_m = {1.0, 9.0, 4.0, 16.0};
    problem.active_cells.assign(4, 1);
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::specified_outward_current_density();
    problem.boundary[charge::Face::x_max] =
        charge::BoundaryCondition::specified_outward_current_density();
    problem.specified_outward_current_density_faces = {
        {{0, 0, 0, -1, 15.0}, -2.0},
        {{0, 3, 2, -1, 15.0}, -5.0},
        {{0, 2, 1, +1, 15.0}, 2.0},
        {{0, 5, 3, +1, 15.0}, 5.0},
    };
    problem.gauge = charge::Gauge::zero_mean;

    const auto result = charge::solve(problem);
    check(result.ok(), result.message.c_str());
    check_close(result.solution.face_current_density_a_per_m2.x[0],
                2.0,
                0.0,
                "x-min local density must use outward-to-axis sign");
    check_close(result.solution.face_current_density_a_per_m2.x[3],
                5.0,
                0.0,
                "second x-min local density must remain spatially local");
    check_close(result.solution.face_current_density_a_per_m2.x[2],
                2.0,
                0.0,
                "x-max local density must preserve positive-axis sign");
    check_close(result.solution.face_current_density_a_per_m2.x[5],
                5.0,
                0.0,
                "second x-max local density must remain spatially local");
    check_close(result.solution.diagnostics.boundary_outward_current_a[0],
                -105.0,
                0.0,
                "x-min diagnostic integrates local density with exact area only");
    check_close(result.solution.diagnostics.boundary_outward_current_a[1],
                105.0,
                0.0,
                "x-max diagnostic integrates local density with exact area only");
    check(result.solution.resolved_electrode_potentials.empty(),
          "local current density must never materialize a total-current electrode potential");
}

void specified_outward_current_density_scope_fails_closed() {
    auto base = uniform_bar(2, 0.0, 1.0);
    base.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::specified_outward_current_density();
    check(charge::solve(base).status == charge::Status::invalid_argument,
          "a density boundary with an empty exact-face scope must fail closed");

    auto invalid = uniform_bar(2, 0.0, 1.0);
    invalid.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::specified_outward_current_density();
    invalid.specified_outward_current_density_faces = {{{0, 1, 0, -1, 1.0}, 1.0}};
    check(charge::solve(invalid).status == charge::Status::invalid_argument,
          "an internal face masquerading as an external density face must fail closed");

    invalid.specified_outward_current_density_faces = {{{0, 0, 0, +1, 1.0}, 1.0}};
    check(charge::solve(invalid).status == charge::Status::invalid_argument,
          "a density face with an ambiguous outward orientation must fail closed");

    invalid.specified_outward_current_density_faces = {
        {{0, 0, 0, -1, 1.0}, 1.0},
        {{0, 0, 0, -1, 1.0}, 1.0},
    };
    check(charge::solve(invalid).status == charge::Status::invalid_argument,
          "duplicate density faces must fail closed");

    invalid.boundary[charge::Face::x_min] = charge::BoundaryCondition::voltage(0.0);
    check(charge::solve(invalid).status == charge::Status::invalid_argument,
          "a local density record conflicting with a voltage boundary must fail closed");

    invalid = uniform_bar(2, 0.0, 1.0);
    invalid.active_cells[0] = 0;
    invalid.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::specified_outward_current_density();
    invalid.specified_outward_current_density_faces = {{{0, 0, 0, -1, 1.0}, 1.0}};
    check(charge::solve(invalid).status == charge::Status::invalid_argument,
          "a density face adjacent to an inactive cell must fail closed");
}

void face_count_overflow_fails_predictably_before_allocation() {
    charge::Problem problem;
    problem.grid = {std::numeric_limits<std::size_t>::max(), 1, 1, 1.0, 1.0, 1.0};
    const auto result = charge::solve(problem);
    check(result.status == charge::Status::invalid_argument,
          "overflowing face counts must fail with invalid_argument");
    check(result.message.find("face count") != std::string::npos,
          "overflowing face counts must report the rejected count");
}

void local_component_gate_cannot_be_scaled_by_an_unrelated_ampere_component() {
    charge::Problem problem;
    problem.grid = {4, 3, 3, 1.0, 1.0, 1.0};
    problem.conductivity_s_per_m.assign(36, 0.0);
    problem.active_cells.assign(36, 0);
    const auto index = [&problem](std::size_t x, std::size_t y, std::size_t z) {
        return x + problem.grid.nx * (y + problem.grid.ny * z);
    };
    for (std::size_t x = 0; x < 4; ++x) {
        problem.conductivity_s_per_m[index(x, 2, 2)] = 1.0;
        problem.active_cells[index(x, 2, 2)] = 1;
    }
    problem.conductivity_s_per_m[index(2, 0, 0)] = 1.0;
    problem.active_cells[index(2, 0, 0)] = 1;
    set_all_insulating(problem);
    problem.boundary[charge::Face::x_min] = charge::BoundaryCondition::total_current(-1.0e-12);
    problem.boundary[charge::Face::x_max] = charge::BoundaryCondition::total_current(1.0e-12);
    problem.boundary[charge::Face::y_min] = charge::BoundaryCondition::total_current(-1.0);
    problem.boundary[charge::Face::z_min] = charge::BoundaryCondition::total_current(1.0);
    problem.gauge = charge::Gauge::zero_mean;
    charge::SolverOptions loose;
    loose.relative_tolerance = 2.0;
    const auto result = charge::solve(problem, loose);
    check(result.status == charge::Status::balance_failure,
          "an unrelated ampere component must not relax the pA component balance gate");
}

charge::Problem read_parity_fixture(const char *path) {
    std::ifstream input(path);
    check(input.good(), "shared Rust/native parity fixture must be readable");
    std::string schema;
    input >> schema;
    check(schema == "fullmag.fdm.charge.parity_fixture.v1",
          "shared Rust/native parity fixture schema must be exact");
    charge::Problem problem;
    input >> problem.grid.nx >> problem.grid.ny >> problem.grid.nz >>
        problem.grid.dx_m >> problem.grid.dy_m >> problem.grid.dz_m;
    std::size_t count = 0;
    input >> count;
    problem.conductivity_s_per_m.resize(count);
    for (double &conductivity : problem.conductivity_s_per_m) {
        input >> conductivity;
    }
    input >> count;
    problem.active_cells.resize(count);
    for (std::uint8_t &active : problem.active_cells) {
        unsigned value = 0;
        input >> value;
        active = static_cast<std::uint8_t>(value);
    }
    for (auto &condition : problem.boundary.values) {
        std::string kind;
        double value = 0.0;
        input >> kind >> value;
        if (kind == "insulating") {
            condition = charge::BoundaryCondition::insulating();
        } else if (kind == "voltage") {
            condition = charge::BoundaryCondition::voltage(value);
        } else {
            check(false, "unsupported boundary kind in shared parity fixture");
        }
    }
    check(input.good() || input.eof(), "shared Rust/native parity fixture must parse completely");
    return problem;
}

std::vector<double> read_named_vector(std::ifstream &input, const char *expected_name) {
    std::string name;
    std::size_t count = 0;
    input >> name >> count;
    check(name == expected_name, "Rust parity output vector name must be exact");
    std::vector<double> values(count);
    for (double &value : values) {
        std::string token;
        input >> token;
        check(input.good(), "Rust parity output vector must contain every declared value");
        std::size_t consumed = 0;
        value = std::stod(token, &consumed);
        check(consumed == token.size(), "Rust parity numeric token must parse completely");
    }
    return values;
}

void compare_vector(const std::vector<double> &native,
                    const std::vector<double> &rust,
                    double absolute_tolerance,
                    double relative_tolerance,
                    const char *message) {
    check(native.size() == rust.size(), "native/Rust parity vector sizes must match");
    for (std::size_t index = 0; index < native.size(); ++index) {
        check_quantity_close(native[index],
                             rust[index],
                             absolute_tolerance,
                             relative_tolerance,
                             message);
    }
}

void compare_native_with_rust_artifact(const char *fixture_path, const char *rust_output_path) {
    const auto native = charge::solve(read_parity_fixture(fixture_path));
    check(native.ok(), native.message.c_str());
    std::ifstream input(rust_output_path);
    check(input.good(), "Rust oracle output artifact must be readable");
    std::string schema;
    input >> schema;
    check(schema == "fullmag.fdm.charge.rust_oracle_output.v1",
          "Rust oracle output schema must be exact");
    compare_vector(native.solution.potential_v,
                   read_named_vector(input, "potential"),
                   parity_potential_absolute_tolerance_v,
                   parity_relative_tolerance,
                   "native/Rust potential parity");
    compare_vector(native.solution.face_current_density_a_per_m2.x,
                   read_named_vector(input, "x"),
                   parity_current_density_absolute_tolerance_a_per_m2,
                   parity_relative_tolerance,
                   "native/Rust x-face flux parity");
    compare_vector(native.solution.face_current_density_a_per_m2.y,
                   read_named_vector(input, "y"),
                   parity_current_density_absolute_tolerance_a_per_m2,
                   parity_relative_tolerance,
                   "native/Rust y-face flux parity");
    compare_vector(native.solution.face_current_density_a_per_m2.z,
                   read_named_vector(input, "z"),
                   parity_current_density_absolute_tolerance_a_per_m2,
                   parity_relative_tolerance,
                   "native/Rust z-face flux parity");
    const auto rust_boundary = read_named_vector(input, "boundary");
    check(rust_boundary.size() == 6, "Rust boundary diagnostic must contain six faces");
    for (std::size_t face = 0; face < 6; ++face) {
        check_integrated_current_close(
            native.solution.diagnostics.boundary_outward_current_a[face],
            rust_boundary[face],
            "native/Rust boundary-current parity");
    }
    std::string name;
    std::string net_token;
    double rust_net = 0.0;
    input >> name >> net_token;
    check(name == "net", "Rust net-current diagnostic name must be exact");
    check(input.good() || input.eof(), "Rust net-current diagnostic must contain a value");
    std::size_t consumed = 0;
    rust_net = std::stod(net_token, &consumed);
    check(consumed == net_token.size(), "Rust net-current token must parse completely");
    const double rust_boundary_l1 = std::accumulate(
        rust_boundary.begin(), rust_boundary.end(), 0.0,
        [](double sum, double value) { return sum + std::abs(value); });
    const double net_tolerance =
        parity_integrated_current_absolute_tolerance_a +
        parity_relative_tolerance *
            std::max(native.solution.diagnostics.boundary_current_l1_a,
                     rust_boundary_l1);
    check_close(native.solution.diagnostics.net_boundary_current_a,
                rust_net,
                net_tolerance,
                "native/Rust net-current parity");
    std::puts("FDM CPU M1 charge Rust/native artifact parity: PASS");
}

} // namespace

int main(int argc, char **argv) {
    if (argc == 4 && std::string_view(argv[1]) == "--compare-rust") {
        compare_native_with_rust_artifact(argv[2], argv[3]);
        return 0;
    }
    if (argc == 2 && std::string_view(argv[1]) == "--reject-small-current-mismatch") {
        check_integrated_current_close(0.0,
                                       1.0e-12,
                                       "small integrated-current mismatch");
        return 0;
    }
    check(argc == 1, "usage: contract [--compare-rust FIXTURE RUST_OUTPUT]");
    uniform_conductor_has_linear_potential_and_one_conservative_flux();
    layered_series_conductor_uses_harmonic_face_conductivity();
    one_way_mixing_interface_publishes_accepted_oriented_traces();
    transverse_only_mixing_is_charge_insulating_and_splits_components();
    sigma_zero_and_inactive_barriers_do_not_leak();
    conservation_reports_boundary_current_and_cell_divergence_independently();
    pure_neumann_requires_explicit_gauge_and_balanced_current();
    internal_potential_jump_drives_one_closed_conservative_loop();
    internal_potential_jump_faces_fail_closed_when_malformed();
    disconnected_component_current_compatibility_is_local_and_dimensionally_scaled();
    swapping_voltage_electrodes_reverses_the_current_sign();
    analytic_problem_converges_over_three_resolutions();
    result_provenance_is_exact_and_versioned();
    boundary_coverage_is_explicit_and_fdm_has_no_inserted_default();
    convergence_requires_recomputed_algebraic_and_integrated_physical_gates();
    numerical_policy_rejects_zero_relative_tolerance_and_avoids_harmonic_overflow();
    resolved_total_current_electrode_potential_is_published_with_face_identity();
    specified_outward_current_density_is_local_oriented_and_not_total_current();
    specified_outward_current_density_scope_fails_closed();
    face_count_overflow_fails_predictably_before_allocation();
    local_component_gate_cannot_be_scaled_by_an_unrelated_ampere_component();
    std::puts("FDM CPU M1 charge transport contract: PASS");
    return 0;
}
