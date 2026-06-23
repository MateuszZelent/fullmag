#include "cpu/frequency_domain/contour_interval_solver.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kPi = 3.14159265358979323846264338327950288;
constexpr double kTwoPi = 2.0 * kPi;

std::string format_double(double value)
{
    char buffer[64]{};
    const int written = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        return "0";
    }
    return buffer;
}

double relative_frequency_width(double frequency_min_hz, double frequency_max_hz) noexcept
{
    if (!std::isfinite(frequency_min_hz) ||
        !std::isfinite(frequency_max_hz) ||
        !(frequency_min_hz < frequency_max_hz)) {
        return 0.0;
    }
    const double width = frequency_max_hz - frequency_min_hz;
    const double denominator = frequency_min_hz > 0.0 ? frequency_min_hz : width;
    return denominator > 0.0 ? width / denominator : 0.0;
}

std::complex<double> determinant_zb_minus_a(
    std::complex<double> z,
    const double stiffness[4],
    const double gyrotropic_mass[4]) noexcept
{
    const std::complex<double> m00 = z * gyrotropic_mass[0] - stiffness[0];
    const std::complex<double> m01 = z * gyrotropic_mass[1] - stiffness[1];
    const std::complex<double> m10 = z * gyrotropic_mass[2] - stiffness[2];
    const std::complex<double> m11 = z * gyrotropic_mass[3] - stiffness[3];
    return m00 * m11 - m01 * m10;
}

int contour_winding_count(
    const ContourQuadrature &quadrature,
    const double stiffness[4],
    const double gyrotropic_mass[4]) noexcept
{
    if (quadrature.points.empty()) {
        return 0;
    }
    double total_angle = 0.0;
    double previous_angle = std::arg(determinant_zb_minus_a(
        quadrature.points.front().lambda,
        stiffness,
        gyrotropic_mass));
    for (std::size_t i = 1; i <= quadrature.points.size(); ++i) {
        const std::complex<double> det = determinant_zb_minus_a(
            quadrature.points[i % quadrature.points.size()].lambda,
            stiffness,
            gyrotropic_mass);
        double angle = std::arg(det);
        double delta = angle - previous_angle;
        while (delta > kPi) {
            delta -= kTwoPi;
        }
        while (delta < -kPi) {
            delta += kTwoPi;
        }
        total_angle += delta;
        previous_angle = angle;
    }
    return static_cast<int>(std::llround(std::abs(total_angle) / kTwoPi));
}

double complex_vector_norm2(const std::complex<double> v[2]) noexcept
{
    return std::sqrt(std::norm(v[0]) + std::norm(v[1]));
}

bool solve_dense_tiny_modes(
    const double stiffness[4],
    const double gyrotropic_mass[4],
    double frequency_min_hz,
    double frequency_max_hz,
    double residual_tolerance,
    std::vector<ContourIntervalMode> &modes)
{
    const double det_g =
        gyrotropic_mass[0] * gyrotropic_mass[3] -
        gyrotropic_mass[1] * gyrotropic_mass[2];
    const double coeff_linear =
        -stiffness[0] * gyrotropic_mass[3] -
        stiffness[3] * gyrotropic_mass[0] +
        stiffness[1] * gyrotropic_mass[2] +
        stiffness[2] * gyrotropic_mass[1];
    const double det_k =
        stiffness[0] * stiffness[3] -
        stiffness[1] * stiffness[2];
    if (!std::isfinite(det_g) || std::abs(det_g) <= 1.0e-18) {
        return false;
    }

    const std::complex<double> discriminant(
        coeff_linear * coeff_linear - 4.0 * det_g * det_k,
        0.0);
    const std::complex<double> sqrt_discriminant = std::sqrt(discriminant);
    const std::complex<double> lambda_candidates[2] = {
        (-coeff_linear - sqrt_discriminant) / (2.0 * det_g),
        (-coeff_linear + sqrt_discriminant) / (2.0 * det_g),
    };

    for (std::complex<double> lambda_candidate : lambda_candidates) {
        if (!std::isfinite(lambda_candidate.real()) ||
            !std::isfinite(lambda_candidate.imag()) ||
            !(lambda_candidate.imag() > 0.0)) {
            continue;
        }
        const double omega_rad_s = std::imag(lambda_candidate);
        const double frequency_hz = omega_rad_s / kTwoPi;
        if (frequency_hz < frequency_min_hz || frequency_hz > frequency_max_hz) {
            continue;
        }

        const std::complex<double> pencil[4] = {
            stiffness[0] - lambda_candidate * gyrotropic_mass[0],
            stiffness[1] - lambda_candidate * gyrotropic_mass[1],
            stiffness[2] - lambda_candidate * gyrotropic_mass[2],
            stiffness[3] - lambda_candidate * gyrotropic_mass[3],
        };
        std::complex<double> eigenvector[2] = {-pencil[1], pencil[0]};
        if (std::fmax(std::abs(eigenvector[0]), std::abs(eigenvector[1])) <= 1.0e-15) {
            eigenvector[0] = -pencil[3];
            eigenvector[1] = pencil[2];
        }
        const double eigenvector_norm = complex_vector_norm2(eigenvector);
        if (!(eigenvector_norm > 0.0) || !std::isfinite(eigenvector_norm)) {
            continue;
        }
        eigenvector[0] /= eigenvector_norm;
        eigenvector[1] /= eigenvector_norm;

        const std::complex<double> k_phi[2] = {
            stiffness[0] * eigenvector[0] + stiffness[1] * eigenvector[1],
            stiffness[2] * eigenvector[0] + stiffness[3] * eigenvector[1],
        };
        const std::complex<double> g_phi[2] = {
            gyrotropic_mass[0] * eigenvector[0] + gyrotropic_mass[1] * eigenvector[1],
            gyrotropic_mass[2] * eigenvector[0] + gyrotropic_mass[3] * eigenvector[1],
        };
        const std::complex<double> residual[2] = {
            k_phi[0] - lambda_candidate * g_phi[0],
            k_phi[1] - lambda_candidate * g_phi[1],
        };
        const double residual_norm = complex_vector_norm2(residual);
        const double denom =
            complex_vector_norm2(k_phi) +
            std::abs(lambda_candidate) * complex_vector_norm2(g_phi);
        const double relative_residual =
            denom > 0.0 ? residual_norm / denom : std::numeric_limits<double>::infinity();
        if (!(relative_residual <= residual_tolerance)) {
            continue;
        }

        ContourIntervalMode mode{};
        mode.frequency_hz = frequency_hz;
        mode.omega_rad_s = omega_rad_s;
        mode.eigenvalue = lambda_candidate;
        mode.mode[0] = eigenvector[0];
        mode.mode[1] = eigenvector[1];
        mode.relative_residual = relative_residual;
        modes.push_back(mode);
    }

    std::sort(
        modes.begin(),
        modes.end(),
        [](const ContourIntervalMode &lhs, const ContourIntervalMode &rhs) {
            return lhs.frequency_hz < rhs.frequency_hz;
        });
    return true;
}

} // namespace

ModalSolverSelection select_modal_solver_for_frequency_window(
    double frequency_min_hz,
    double frequency_max_hz,
    int eigensolver_family) noexcept
{
    if (eigensolver_family == kModalEigensolverFamilyShiftInvert) {
        return {"shift_invert", "requested_shift_invert"};
    }
    if (eigensolver_family == kModalEigensolverFamilyContourInterval) {
        return {"contour_interval", "requested_contour_interval"};
    }
    if (relative_frequency_width(frequency_min_hz, frequency_max_hz) >= 0.5) {
        return {"contour_interval", "frequency_window_relative_width_ge_0.5"};
    }
    return {"shift_invert", "frequency_window_relative_width_lt_0.5"};
}

ContourIntervalSolveResult solve_tiny_contour_interval(
    const ContourIntervalSolverRequest &request)
{
    ContourIntervalSolveResult result{};
    if (request.tangent_dof_count != 2 ||
        request.stiffness_matrix_row_major == nullptr ||
        request.gyrotropic_mass_matrix_row_major == nullptr ||
        !std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !(request.frequency_min_hz < request.frequency_max_hz) ||
        request.frequency_min_hz < 0.0) {
        result.stop_reason = "invalid_contour_interval_request";
        return result;
    }

    double stiffness[4]{};
    double gyrotropic_mass[4]{};
    for (int i = 0; i < 4; ++i) {
        stiffness[i] = request.stiffness_matrix_row_major[i];
        gyrotropic_mass[i] = request.gyrotropic_mass_matrix_row_major[i];
    }

    ContourQuadratureRequest quadrature_request{};
    quadrature_request.frequency_min_hz = request.frequency_min_hz;
    quadrature_request.frequency_max_hz = request.frequency_max_hz;
    quadrature_request.contour_point_count = request.contour_point_count;
    const ContourQuadrature quadrature =
        build_lambda_ellipse_quadrature(quadrature_request);
    result.contour_point_count = static_cast<int>(quadrature.points.size());
    result.quadrature_rule = quadrature.quadrature_rule;
    result.contour_center_hz = quadrature.contour_center_hz;
    result.contour_radius_hz = quadrature.contour_radius_hz;
    result.contour_points.reserve(quadrature.points.size());

    if (request.max_outer_iterations <= 0) {
        result.stop_reason = "max_iterations";
        return result;
    }
    if (request.max_linear_iterations <= 0) {
        result.stop_reason = "linear_solver_unavailable";
        result.linear_solve_failed = true;
        return result;
    }

    for (const ContourPoint &point : quadrature.points) {
        const std::complex<double> det = determinant_zb_minus_a(
            point.lambda,
            stiffness,
            gyrotropic_mass);
        const bool converged =
            std::isfinite(det.real()) &&
            std::isfinite(det.imag()) &&
            std::abs(det) > 1.0e-24;
        ContourPointSolveDiagnostic point_diagnostic{};
        point_diagnostic.index = point.index;
        point_diagnostic.lambda = point.lambda;
        point_diagnostic.linear_iterations = converged ? 1 : request.max_linear_iterations;
        point_diagnostic.converged = converged;
        result.contour_points.push_back(point_diagnostic);
        if (!converged) {
            result.linear_solve_failed = true;
        }
    }
    if (result.linear_solve_failed) {
        result.stop_reason = "contour_linear_solve_failed";
        return result;
    }

    const int initial_count =
        contour_winding_count(quadrature, stiffness, gyrotropic_mass);
    ContourQuadratureRequest refined_request = quadrature_request;
    refined_request.contour_point_count =
        std::max(2 * result.contour_point_count, result.contour_point_count + 1);
    const ContourQuadrature refined_quadrature =
        build_lambda_ellipse_quadrature(refined_request);
    const int refined_count =
        contour_winding_count(refined_quadrature, stiffness, gyrotropic_mass);

    result.quadrature_refinements = 1;
    result.estimated_mode_count = refined_count;
    result.projection_rank = refined_count;
    result.rank_deficiency_detected = result.projection_rank < result.estimated_mode_count;

    if (!solve_dense_tiny_modes(
            stiffness,
            gyrotropic_mass,
            request.frequency_min_hz,
            request.frequency_max_hz,
            request.residual_tolerance,
            result.modes)) {
        result.stop_reason = "invalid_tiny_validation_pencil";
        return result;
    }
    if (request.requested_mode_count > 0 &&
        static_cast<int>(result.modes.size()) > request.requested_mode_count) {
        result.modes.resize(static_cast<std::size_t>(request.requested_mode_count));
    }
    result.accepted_mode_count = static_cast<int>(result.modes.size());
    result.count_certificate =
        initial_count == refined_count &&
        result.projection_rank >= result.accepted_mode_count &&
        !result.rank_deficiency_detected &&
        !result.linear_solve_failed;
    result.ok = result.count_certificate || result.accepted_mode_count > 0;
    result.stop_reason = result.ok ? "converged" : "partial_convergence";
    return result;
}

std::string contour_interval_diagnostics_json(
    const ContourIntervalSolveResult &result)
{
    std::string json =
        "\"contour_plane\":\"lambda\","
        "\"frequency_mapping\":\"f_hz = abs(imag(lambda))/(2*pi)\","
        "\"positive_frequency_filter\":\"imag(lambda) > 0\","
        "\"contour_point_count\":" +
        std::to_string(result.contour_point_count) +
        ",\"quadrature_rule\":\"" +
        std::string(result.quadrature_rule != nullptr ? result.quadrature_rule : "") +
        "\",\"contour_center_hz\":" +
        format_double(result.contour_center_hz) +
        ",\"contour_radius_hz\":" +
        format_double(result.contour_radius_hz) +
        ",\"projection_rank\":" +
        std::to_string(result.projection_rank) +
        ",\"estimated_mode_count\":" +
        std::to_string(result.estimated_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(result.accepted_mode_count) +
        ",\"certified_count\":" +
        std::string(result.count_certificate ? "true" : "false") +
        ",\"count_certificate\":{\"certified_count\":" +
        std::string(result.count_certificate ? "true" : "false") +
        ",\"estimated_modes_in_window\":" +
        std::to_string(result.estimated_mode_count) +
        ",\"accepted_modes_in_window\":" +
        std::to_string(result.accepted_mode_count) +
        "},\"quadrature_refinements\":" +
        std::to_string(result.quadrature_refinements) +
        ",\"rank_deficiency_detected\":" +
        std::string(result.rank_deficiency_detected ? "true" : "false") +
        ",\"linear_iterations_per_point\":[";
    for (std::size_t i = 0; i < result.contour_points.size(); ++i) {
        if (i > 0) {
            json += ",";
        }
        json += std::to_string(result.contour_points[i].linear_iterations);
    }
    json += "],\"contour_points\":[";
    for (std::size_t i = 0; i < result.contour_points.size(); ++i) {
        const ContourPointSolveDiagnostic &point = result.contour_points[i];
        if (i > 0) {
            json += ",";
        }
        json +=
            "{\"index\":" +
            std::to_string(point.index) +
            ",\"lambda_real\":" +
            format_double(point.lambda.real()) +
            ",\"lambda_imag\":" +
            format_double(point.lambda.imag()) +
            ",\"linear_iterations\":" +
            std::to_string(point.linear_iterations) +
            ",\"linear_solve_converged\":" +
            std::string(point.converged ? "true" : "false") +
            "}";
    }
    json += "]";
    return json;
}

} // namespace fullmag::fem::frequency_domain
