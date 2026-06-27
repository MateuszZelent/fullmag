#pragma once

#include "cpu/frequency_domain/contour_quadrature.hpp"

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

constexpr int kModalEigensolverFamilyAuto = 0;
constexpr int kModalEigensolverFamilyShiftInvert = 1;
constexpr int kModalEigensolverFamilyContourInterval = 2;

struct ModalSolverSelection {
    const char *family = "shift_invert";
    const char *reason = "default_shift_invert";
};

struct ContourIntervalSolverRequest {
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    int requested_mode_count = 1;
    double residual_tolerance = 0.0;
    int max_outer_iterations = 0;
    int max_linear_iterations = 0;
    int eigensolver_family = kModalEigensolverFamilyAuto;
    int completeness_policy = 0;
    int contour_point_count = 16;
    std::uint64_t tangent_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    const double *gyrotropic_mass_matrix_row_major = nullptr;
};

struct ContourIntervalMode {
    double frequency_hz = 0.0;
    double omega_rad_s = 0.0;
    std::complex<double> eigenvalue{};
    std::complex<double> mode[2]{};
    std::vector<std::complex<double>> mode_vector{};
    double relative_residual = 0.0;
};

struct ContourPointSolveDiagnostic {
    std::size_t index = 0;
    std::complex<double> lambda{};
    int linear_iterations = 0;
    bool converged = false;
};

struct ContourIntervalSolveResult {
    bool ok = false;
    const char *stop_reason = nullptr;
    std::vector<ContourIntervalMode> modes;
    std::vector<ContourPointSolveDiagnostic> contour_points;
    int contour_point_count = 0;
    const char *quadrature_rule = "trapezoidal";
    double contour_center_hz = 0.0;
    double contour_radius_hz = 0.0;
    int projection_rank = 0;
    std::complex<double> projection_matrix_row_major[4]{};
    int estimated_mode_count = 0;
    int accepted_mode_count = 0;
    bool count_certificate = false;
    int quadrature_refinements = 0;
    bool rank_deficiency_detected = false;
    bool linear_solve_failed = false;
};

ModalSolverSelection select_modal_solver_for_frequency_window(
    double frequency_min_hz,
    double frequency_max_hz,
    int eigensolver_family) noexcept;

ContourIntervalSolveResult solve_tiny_contour_interval(
    const ContourIntervalSolverRequest &request);

std::string contour_interval_diagnostics_json(
    const ContourIntervalSolveResult &result);

} // namespace fullmag::fem::frequency_domain
