#include "cpu/frequency_domain/contour_interval_solver.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fd::ContourIntervalSolverRequest macrospin_window_request()
{
    static constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    static constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fd::ContourIntervalSolverRequest request{};
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.requested_mode_count = 4;
    request.residual_tolerance = 1.0e-12;
    request.max_outer_iterations = 8;
    request.max_linear_iterations = 128;
    request.eigensolver_family = fd::kModalEigensolverFamilyContourInterval;
    request.contour_point_count = 16;
    request.tangent_dof_count = 2;
    request.stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.gyrotropic_mass_matrix_row_major = gyrotropic_mass_row_major;
    return request;
}

void contour_solver_counts_modes_inside_interval()
{
    const fd::ContourIntervalSolveResult result =
        fd::solve_tiny_contour_interval(macrospin_window_request());

    check(result.ok, "contour interval solve must succeed for the macrospin pencil");
    check(result.estimated_mode_count == 1,
          "contour count must find one positive-frequency mode in the interval");
    check(result.accepted_mode_count == 1,
          "contour interval solve must accept the in-window mode");
    check(result.count_certificate,
          "stable contour count must publish a count certificate");
}

void contour_solver_rejects_missing_linear_solver()
{
    fd::ContourIntervalSolverRequest request = macrospin_window_request();
    request.max_linear_iterations = 0;

    const fd::ContourIntervalSolveResult result =
        fd::solve_tiny_contour_interval(request);

    check(!result.ok, "contour solve must reject a missing linear solver budget");
    check(result.linear_solve_failed,
          "missing linear solver budget must be reported as a failed contour solve");
    check(result.stop_reason != nullptr,
          "missing linear solver result must carry a stop reason");
}

void contour_solver_reports_each_contour_point()
{
    const fd::ContourIntervalSolveResult result =
        fd::solve_tiny_contour_interval(macrospin_window_request());

    check(result.ok, "contour solve must succeed before checking point diagnostics");
    check(result.contour_point_count == 16,
          "default contour solve must use sixteen contour points");
    check(result.contour_points.size() == 16,
          "diagnostics must contain one entry per contour point");
    for (const fd::ContourPointSolveDiagnostic &point : result.contour_points) {
        check(point.linear_iterations > 0,
              "each contour point must report linear iterations");
        check(point.converged,
              "each contour point must report a converged shifted solve");
    }
}

void contour_solver_matches_dense_oracle_small_mesh()
{
    const fd::ContourIntervalSolveResult result =
        fd::solve_tiny_contour_interval(macrospin_window_request());

    check(result.ok, "contour solve must succeed before checking dense oracle");
    check(!result.modes.empty(), "contour solve must return the accepted mode");
    check(std::abs(result.modes[0].frequency_hz - 0.15915494309189535) < 1.0e-12,
          "contour interval mode frequency must match the dense macrospin oracle");
    check(result.modes[0].relative_residual <= 1.0e-12,
          "contour interval mode residual must satisfy the requested tolerance");
}

} // namespace

int main()
{
    contour_solver_counts_modes_inside_interval();
    contour_solver_rejects_missing_linear_solver();
    contour_solver_reports_each_contour_point();
    contour_solver_matches_dense_oracle_small_mesh();
    return 0;
}
