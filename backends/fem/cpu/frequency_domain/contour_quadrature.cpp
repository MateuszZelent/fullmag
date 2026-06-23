#include "cpu/frequency_domain/contour_quadrature.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kPi = 3.14159265358979323846264338327950288;
constexpr double kTwoPi = 2.0 * kPi;

int sanitize_point_count(int point_count) noexcept
{
    if (point_count <= 0) {
        return 16;
    }
    return std::max(4, point_count);
}

} // namespace

ContourQuadrature build_lambda_ellipse_quadrature(
    const ContourQuadratureRequest &request)
{
    ContourQuadrature quadrature{};
    if (!std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !(request.frequency_min_hz < request.frequency_max_hz) ||
        request.frequency_min_hz < 0.0) {
        return quadrature;
    }

    const int point_count = sanitize_point_count(request.contour_point_count);
    quadrature.contour_center_hz =
        0.5 * (request.frequency_min_hz + request.frequency_max_hz);
    quadrature.contour_radius_hz =
        0.5 * (request.frequency_max_hz - request.frequency_min_hz) * 1.000001;
    quadrature.real_half_width_rad_s =
        request.real_half_width_rad_s > 0.0 ?
            request.real_half_width_rad_s :
            std::max(kTwoPi * quadrature.contour_radius_hz * 1.0e-3, 1.0e-12);

    const double omega_center = kTwoPi * quadrature.contour_center_hz;
    const double omega_radius = kTwoPi * quadrature.contour_radius_hz;
    const double dtheta = kTwoPi / static_cast<double>(point_count);
    quadrature.points.reserve(static_cast<std::size_t>(point_count));
    for (int index = 0; index < point_count; ++index) {
        const double theta = dtheta * static_cast<double>(index);
        const double real_part = quadrature.real_half_width_rad_s * std::cos(theta);
        const double imag_part = omega_center + omega_radius * std::sin(theta);
        const std::complex<double> dlambda_dtheta(
            -quadrature.real_half_width_rad_s * std::sin(theta),
            omega_radius * std::cos(theta));

        ContourPoint point{};
        point.index = static_cast<std::size_t>(index);
        point.lambda = {real_part, imag_part};
        point.weight = dlambda_dtheta * dtheta / std::complex<double>(0.0, kTwoPi);
        point.frequency_hz = imag_part / kTwoPi;
        quadrature.points.push_back(point);
    }
    return quadrature;
}

} // namespace fullmag::fem::frequency_domain
