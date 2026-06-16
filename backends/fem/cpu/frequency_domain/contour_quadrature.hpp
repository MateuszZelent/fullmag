#pragma once

#include <complex>
#include <cstddef>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct ContourPoint {
    std::size_t index = 0;
    std::complex<double> lambda{};
    std::complex<double> weight{};
    double frequency_hz = 0.0;
};

struct ContourQuadratureRequest {
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    int contour_point_count = 16;
    double real_half_width_rad_s = 0.0;
};

struct ContourQuadrature {
    std::vector<ContourPoint> points;
    const char *quadrature_rule = "trapezoidal";
    const char *contour_plane = "lambda";
    double contour_center_hz = 0.0;
    double contour_radius_hz = 0.0;
    double real_half_width_rad_s = 0.0;
};

ContourQuadrature build_lambda_ellipse_quadrature(
    const ContourQuadratureRequest &request);

} // namespace fullmag::fem::frequency_domain
