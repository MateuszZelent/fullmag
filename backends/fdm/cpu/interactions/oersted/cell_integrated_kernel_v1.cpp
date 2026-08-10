#include "oersted_internal_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <limits>

namespace fullmag::fdm::cpu::oersted::v1 {
namespace {

constexpr double inverse_four_pi =
    0.079577471545947667884441881686257181017229822870228;

double coefficient_log(double coefficient, double argument) {
    if (coefficient == 0.0) {
        return 0.0;
    }
    if (argument < 0.0 &&
        argument > -64.0 * std::numeric_limits<double>::epsilon()) {
        argument = 0.0;
    }
    if (!(argument > 0.0)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return coefficient * std::log(argument);
}

double rectangular_field_primitive_x(double x, double y, double z) {
    const double radius = std::sqrt(x * x + y * y + z * z);
    if (radius == 0.0) {
        return 0.0;
    }
    return coefficient_log(y, z + radius) +
           coefficient_log(z, y + radius) -
           x * std::atan2(y * z, x * radius);
}

double integrate_x_component(const Vector3 &target,
                             const Vector3 &half_width,
                             double scale) {
    const std::array<double, 2> x_bounds{
        (target[0] - half_width[0]) / scale,
        (target[0] + half_width[0]) / scale,
    };
    const std::array<double, 2> y_bounds{
        (target[1] - half_width[1]) / scale,
        (target[1] + half_width[1]) / scale,
    };
    const std::array<double, 2> z_bounds{
        (target[2] - half_width[2]) / scale,
        (target[2] + half_width[2]) / scale,
    };
    double sum = 0.0;
    for (std::size_t ix = 0; ix < 2; ++ix) {
        const double sign_x = ix == 0 ? 1.0 : -1.0;
        for (std::size_t iy = 0; iy < 2; ++iy) {
            const double sign_y = iy == 0 ? -1.0 : 1.0;
            for (std::size_t iz = 0; iz < 2; ++iz) {
                const double sign_z = iz == 0 ? -1.0 : 1.0;
                sum += sign_x * sign_y * sign_z * rectangular_field_primitive_x(
                    x_bounds[ix], y_bounds[iy], z_bounds[iz]);
            }
        }
    }
    return inverse_four_pi * scale * sum;
}

Vector3 evaluate_canonical(const Grid &grid,
                           std::array<std::ptrdiff_t, 3> displacement_cells) {
    const Vector3 target{
        static_cast<double>(displacement_cells[0]) * grid.dx_m,
        static_cast<double>(displacement_cells[1]) * grid.dy_m,
        static_cast<double>(displacement_cells[2]) * grid.dz_m,
    };
    const Vector3 half_width{
        0.5 * grid.dx_m,
        0.5 * grid.dy_m,
        0.5 * grid.dz_m,
    };
    const double scale = std::max({grid.dx_m, grid.dy_m, grid.dz_m});
    Vector3 value{};
    if (displacement_cells[0] != 0) {
        value[0] = integrate_x_component(target, half_width, scale);
    }
    if (displacement_cells[1] != 0) {
        value[1] = integrate_x_component(
            {target[1], target[2], target[0]},
            {half_width[1], half_width[2], half_width[0]},
            scale);
    }
    if (displacement_cells[2] != 0) {
        value[2] = integrate_x_component(
            {target[2], target[0], target[1]},
            {half_width[2], half_width[0], half_width[1]},
            scale);
    }
    return value;
}

} // namespace

Vector3 cell_integrated_kernel_m(const Grid &grid,
                                 std::array<std::ptrdiff_t, 3> displacement_cells) {
    if (!(grid.dx_m > 0.0) || !(grid.dy_m > 0.0) || !(grid.dz_m > 0.0) ||
        !std::isfinite(grid.dx_m) || !std::isfinite(grid.dy_m) ||
        !std::isfinite(grid.dz_m)) {
        const double invalid = std::numeric_limits<double>::quiet_NaN();
        return {invalid, invalid, invalid};
    }
    if (displacement_cells == std::array<std::ptrdiff_t, 3>{0, 0, 0}) {
        return {0.0, 0.0, 0.0};
    }

    double global_sign = 1.0;
    for (std::ptrdiff_t coordinate : displacement_cells) {
        if (coordinate < 0) {
            global_sign = -1.0;
            for (std::ptrdiff_t &entry : displacement_cells) {
                entry = -entry;
            }
            break;
        }
        if (coordinate > 0) {
            break;
        }
    }
    Vector3 value = evaluate_canonical(grid, displacement_cells);
    for (std::size_t component = 0; component < value.size(); ++component) {
        if (displacement_cells[component] == 0) {
            value[component] = 0.0;
        } else {
            value[component] *= global_sign;
        }
    }
    return value;
}

} // namespace fullmag::fdm::cpu::oersted::v1
