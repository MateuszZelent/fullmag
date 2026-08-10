#include "oersted_internal_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1::detail {
namespace {

Vector3 centered_derivative(const Grid &grid,
                            const std::vector<Vector3> &field,
                            std::size_t x,
                            std::size_t y,
                            std::size_t z,
                            std::size_t axis) {
    auto minus = std::array<std::size_t, 3>{x, y, z};
    auto plus = minus;
    --minus[axis];
    ++plus[axis];
    const double spacing = axis == 0 ? grid.dx_m : (axis == 1 ? grid.dy_m : grid.dz_m);
    const Vector3 &left = field[cell_index(grid, minus[0], minus[1], minus[2])];
    const Vector3 &right = field[cell_index(grid, plus[0], plus[1], plus[2])];
    return {
        (right[0] - left[0]) / (2.0 * spacing),
        (right[1] - left[1]) / (2.0 * spacing),
        (right[2] - left[2]) / (2.0 * spacing),
    };
}

double squared_norm(const Vector3 &value) {
    return value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
}

} // namespace

DifferentialDiagnostics compute_differential_diagnostics(
    const Grid &grid,
    const std::vector<Vector3> &cell_current_density_a_per_m2,
    const std::vector<Vector3> &field_a_per_m) {
    DifferentialDiagnostics diagnostics;
    constexpr std::size_t band = 2;
    if (grid.nx <= 2U * band || grid.ny <= 2U * band || grid.nz <= 2U * band) {
        return diagnostics;
    }
    const std::size_t expected = grid.nx * grid.ny * grid.nz;
    if (cell_current_density_a_per_m2.size() != expected ||
        field_a_per_m.size() != expected) {
        return diagnostics;
    }

    long double sum_current2 = 0.0L;
    long double sum_curl2 = 0.0L;
    long double sum_div_current2 = 0.0L;
    long double sum_div_field2 = 0.0L;
    long double sum_ampere2 = 0.0L;
    std::size_t count = 0;
    for (std::size_t z = band; z + band < grid.nz; ++z) {
        for (std::size_t y = band; y + band < grid.ny; ++y) {
            for (std::size_t x = band; x + band < grid.nx; ++x) {
                const Vector3 current_dx = centered_derivative(
                    grid, cell_current_density_a_per_m2, x, y, z, 0);
                const Vector3 current_dy = centered_derivative(
                    grid, cell_current_density_a_per_m2, x, y, z, 1);
                const Vector3 current_dz = centered_derivative(
                    grid, cell_current_density_a_per_m2, x, y, z, 2);
                const Vector3 field_dx =
                    centered_derivative(grid, field_a_per_m, x, y, z, 0);
                const Vector3 field_dy =
                    centered_derivative(grid, field_a_per_m, x, y, z, 1);
                const Vector3 field_dz =
                    centered_derivative(grid, field_a_per_m, x, y, z, 2);
                const double div_current = current_dx[0] + current_dy[1] + current_dz[2];
                const double div_field = field_dx[0] + field_dy[1] + field_dz[2];
                const Vector3 curl_field{
                    field_dy[2] - field_dz[1],
                    field_dz[0] - field_dx[2],
                    field_dx[1] - field_dy[0],
                };
                const Vector3 &current =
                    cell_current_density_a_per_m2[cell_index(grid, x, y, z)];
                const Vector3 ampere{
                    curl_field[0] - current[0],
                    curl_field[1] - current[1],
                    curl_field[2] - current[2],
                };
                sum_current2 += squared_norm(current);
                sum_curl2 += squared_norm(curl_field);
                sum_div_current2 += div_current * div_current;
                sum_div_field2 += div_field * div_field;
                sum_ampere2 += squared_norm(ampere);
                ++count;
            }
        }
    }
    if (count == 0) {
        return diagnostics;
    }
    const long double inverse_count = 1.0L / static_cast<long double>(count);
    diagnostics.current_scale_a_per_m2 =
        std::sqrt(static_cast<double>(sum_current2 * inverse_count));
    const double curl_scale =
        std::sqrt(static_cast<double>(sum_curl2 * inverse_count));
    diagnostics.ampere_scale_a_per_m2 =
        std::max(curl_scale, diagnostics.current_scale_a_per_m2);
    diagnostics.divergence_current_rms_a_per_m3 =
        std::sqrt(static_cast<double>(sum_div_current2 * inverse_count));
    diagnostics.divergence_field_rms_a_per_m2 =
        std::sqrt(static_cast<double>(sum_div_field2 * inverse_count));
    diagnostics.curl_h_minus_j_rms_a_per_m2 =
        std::sqrt(static_cast<double>(sum_ampere2 * inverse_count));
    if (!(diagnostics.current_scale_a_per_m2 > 0.0) ||
        !(diagnostics.ampere_scale_a_per_m2 > 0.0)) {
        return diagnostics;
    }
    const double h_min = std::min({grid.dx_m, grid.dy_m, grid.dz_m});
    diagnostics.rho_div_j = diagnostics.divergence_current_rms_a_per_m3 /
                            (diagnostics.current_scale_a_per_m2 / h_min);
    diagnostics.rho_div_h = diagnostics.divergence_field_rms_a_per_m2 /
                            diagnostics.ampere_scale_a_per_m2;
    diagnostics.rho_ampere = diagnostics.curl_h_minus_j_rms_a_per_m2 /
                             diagnostics.ampere_scale_a_per_m2;
    diagnostics.available = std::isfinite(diagnostics.rho_div_j) &&
                            std::isfinite(diagnostics.rho_div_h) &&
                            std::isfinite(diagnostics.rho_ampere);
    return diagnostics;
}

} // namespace fullmag::fdm::cpu::oersted::v1::detail
