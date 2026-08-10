#include "oersted_direct_oracle_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <map>
#include <stdexcept>
#include <tuple>

namespace fullmag::fdm::cpu::oersted::test_only {
namespace {

constexpr long double pi =
    3.141592653589793238462643383279502884L;
constexpr std::array<long double, 16> gauss_nodes{
    -0.98940093499164993260L,
    -0.94457502307323257608L,
    -0.86563120238783174388L,
    -0.75540440835500303390L,
    -0.61787624440264374845L,
    -0.45801677765722738634L,
    -0.28160355077925891323L,
    -0.095012509837637440185L,
    0.095012509837637440185L,
    0.28160355077925891323L,
    0.45801677765722738634L,
    0.61787624440264374845L,
    0.75540440835500303390L,
    0.86563120238783174388L,
    0.94457502307323257608L,
    0.98940093499164993260L,
};
constexpr std::array<long double, 16> gauss_weights{
    0.027152459411754094852L,
    0.062253523938647892863L,
    0.095158511682492784810L,
    0.12462897125553387205L,
    0.14959598881657673208L,
    0.16915651939500253819L,
    0.18260341504492358887L,
    0.18945061045506849629L,
    0.18945061045506849629L,
    0.18260341504492358887L,
    0.16915651939500253819L,
    0.14959598881657673208L,
    0.12462897125553387205L,
    0.095158511682492784810L,
    0.062253523938647892863L,
    0.027152459411754094852L,
};

std::size_t cell_index(const Grid &grid,
                       std::size_t x,
                       std::size_t y,
                       std::size_t z) {
    return (z * grid.ny + y) * grid.nx + x;
}

long double surface_potential_primitive(long double x,
                                        long double y,
                                        long double normal_distance) {
    const long double abs_normal = std::abs(normal_distance);
    const long double radius =
        std::sqrt(x * x + y * y + abs_normal * abs_normal);
    return x * std::log(y + radius) + y * std::log(x + radius) -
           abs_normal * std::atan2(x * y, abs_normal * radius);
}

long double rectangle_potential_integral(long double x_lower,
                                         long double x_upper,
                                         long double y_lower,
                                         long double y_upper,
                                         long double normal_distance) {
    return surface_potential_primitive(x_upper, y_upper, normal_distance) -
           surface_potential_primitive(x_lower, y_upper, normal_distance) -
           surface_potential_primitive(x_upper, y_lower, normal_distance) +
           surface_potential_primitive(x_lower, y_lower, normal_distance);
}

long double surface_potential_for_source_face(
    const std::array<long double, 3> &target,
    const std::array<long double, 3> &spacing,
    std::size_t normal_axis,
    long double source_normal_coordinate) {
    const std::size_t tangent_a = (normal_axis + 1U) % 3U;
    const std::size_t tangent_b = (normal_axis + 2U) % 3U;
    const long double a_lower =
        target[tangent_a] - 0.5L * spacing[tangent_a];
    const long double a_upper =
        target[tangent_a] + 0.5L * spacing[tangent_a];
    const long double b_lower =
        target[tangent_b] - 0.5L * spacing[tangent_b];
    const long double b_upper =
        target[tangent_b] + 0.5L * spacing[tangent_b];
    return rectangle_potential_integral(
        a_lower,
        a_upper,
        b_lower,
        b_upper,
        target[normal_axis] - source_normal_coordinate);
}

long double numerical_surface_potential(
    const std::array<long double, 3> &target,
    const std::array<long double, 3> &spacing,
    std::size_t normal_axis,
    long double source_normal_coordinate,
    std::size_t subdivisions,
    std::size_t &evaluations) {
    const std::size_t tangent_a = (normal_axis + 1U) % 3U;
    const std::size_t tangent_b = (normal_axis + 2U) % 3U;
    const long double cell_a =
        spacing[tangent_a] / static_cast<long double>(subdivisions);
    const long double cell_b =
        spacing[tangent_b] / static_cast<long double>(subdivisions);
    const long double half_a = 0.5L * cell_a;
    const long double half_b = 0.5L * cell_b;
    const long double normal_distance =
        target[normal_axis] - source_normal_coordinate;
    long double sum = 0.0L;
    long double compensation = 0.0L;
    for (std::size_t ib = 0; ib < subdivisions; ++ib) {
        const long double center_b = -0.5L * spacing[tangent_b] +
                                     (static_cast<long double>(ib) + 0.5L) *
                                         cell_b;
        for (std::size_t ia = 0; ia < subdivisions; ++ia) {
            const long double center_a = -0.5L * spacing[tangent_a] +
                                         (static_cast<long double>(ia) + 0.5L) *
                                             cell_a;
            for (std::size_t qb = 0; qb < gauss_nodes.size(); ++qb) {
                const long double rb =
                    target[tangent_b] -
                    (center_b + half_b * gauss_nodes[qb]);
                for (std::size_t qa = 0; qa < gauss_nodes.size(); ++qa) {
                    const long double ra =
                        target[tangent_a] -
                        (center_a + half_a * gauss_nodes[qa]);
                    const long double radius = std::sqrt(
                        ra * ra + rb * rb + normal_distance * normal_distance);
                    const long double term =
                        half_a * half_b * gauss_weights[qa] *
                        gauss_weights[qb] / radius;
                    const long double corrected = term - compensation;
                    const long double updated = sum + corrected;
                    compensation = (updated - sum) - corrected;
                    sum = updated;
                    ++evaluations;
                }
            }
        }
    }
    return sum;
}

} // namespace

OracleKernelResult integrate_source_cell_at_target_center(
    const Grid &grid,
    std::array<std::ptrdiff_t, 3> displacement_cells) {
    OracleKernelResult result;
    if (displacement_cells[0] == 0 && displacement_cells[1] == 0 &&
        displacement_cells[2] == 0) {
        result.converged = true;
        return result;
    }

    const std::array<long double, 3> spacing{
        static_cast<long double>(grid.dx_m),
        static_cast<long double>(grid.dy_m),
        static_cast<long double>(grid.dz_m),
    };
    const std::array<long double, 3> target{
        static_cast<long double>(displacement_cells[0]) * spacing[0],
        static_cast<long double>(displacement_cells[1]) * spacing[1],
        static_cast<long double>(displacement_cells[2]) * spacing[2],
    };
    for (std::size_t component = 0; component < 3; ++component) {
        if (displacement_cells[component] == 0) {
            result.value_m[component] = 0.0;
            continue;
        }
        const long double upper = surface_potential_for_source_face(
            target, spacing, component, 0.5L * spacing[component]);
        const long double lower = surface_potential_for_source_face(
            target, spacing, component, -0.5L * spacing[component]);
        result.value_m[component] =
            static_cast<double>((upper - lower) / (4.0L * pi));
        result.evaluations += 8U;
    }
    result.converged = std::all_of(
        result.value_m.begin(), result.value_m.end(), [](double value) {
            return std::isfinite(value);
        });
    return result;
}

AdaptiveSpotCheckResult adaptive_surface_spot_check(
    const Grid &grid,
    std::array<std::ptrdiff_t, 3> displacement_cells) {
    AdaptiveSpotCheckResult result;
    if (displacement_cells == std::array<std::ptrdiff_t, 3>{0, 0, 0}) {
        result.converged = true;
        return result;
    }
    const std::array<long double, 3> spacing{
        static_cast<long double>(grid.dx_m),
        static_cast<long double>(grid.dy_m),
        static_cast<long double>(grid.dz_m),
    };
    const std::array<long double, 3> target{
        static_cast<long double>(displacement_cells[0]) * spacing[0],
        static_cast<long double>(displacement_cells[1]) * spacing[1],
        static_cast<long double>(displacement_cells[2]) * spacing[2],
    };
    const long double h_max =
        std::max({spacing[0], spacing[1], spacing[2]});
    std::array<long double, 3> previous{};
    bool have_previous = false;
    for (std::size_t subdivisions : {1U, 2U, 4U, 8U, 16U, 32U, 64U}) {
        std::array<long double, 3> current{};
        for (std::size_t component = 0; component < 3; ++component) {
            if (displacement_cells[component] == 0) {
                continue;
            }
            const long double upper = numerical_surface_potential(
                target,
                spacing,
                component,
                0.5L * spacing[component],
                subdivisions,
                result.evaluations);
            const long double lower = numerical_surface_potential(
                target,
                spacing,
                component,
                -0.5L * spacing[component],
                subdivisions,
                result.evaluations);
            current[component] = (upper - lower) / (4.0L * pi);
        }
        if (have_previous) {
            bool converged = true;
            for (std::size_t component = 0; component < 3; ++component) {
                if (displacement_cells[component] == 0) {
                    continue;
                }
                const long double error =
                    std::abs(current[component] - previous[component]);
                const long double budget =
                    2.0e-14L * h_max +
                    2.0e-13L * std::abs(current[component]);
                result.successive_error_m[component] =
                    static_cast<double>(error);
                result.budget_m[component] = static_cast<double>(budget);
                converged = converged && error <= budget;
            }
            for (std::size_t component = 0; component < 3; ++component) {
                result.value_m[component] = static_cast<double>(current[component]);
            }
            result.subdivisions_per_axis = subdivisions;
            if (converged) {
                result.converged = true;
                return result;
            }
        }
        previous = current;
        have_previous = true;
    }
    return result;
}

std::vector<Vector3> direct_field_from_cell_current(
    const Grid &grid,
    const std::vector<Vector3> &cell_current_density_a_per_m2,
    const std::vector<std::uint8_t> &target_mask) {
    const std::size_t cells = grid.nx * grid.ny * grid.nz;
    if (cell_current_density_a_per_m2.size() != cells || target_mask.size() != cells) {
        throw std::invalid_argument("direct oracle shape mismatch");
    }
    std::vector<Vector3> field(cells);
    std::map<std::tuple<std::ptrdiff_t, std::ptrdiff_t, std::ptrdiff_t>, Vector3>
        kernel_cache;
    for (std::size_t tz = 0; tz < grid.nz; ++tz) {
        for (std::size_t ty = 0; ty < grid.ny; ++ty) {
            for (std::size_t tx = 0; tx < grid.nx; ++tx) {
                const std::size_t target = cell_index(grid, tx, ty, tz);
                if (target_mask[target] == 0) {
                    continue;
                }
                Vector3 value{};
                for (std::size_t sz = 0; sz < grid.nz; ++sz) {
                    for (std::size_t sy = 0; sy < grid.ny; ++sy) {
                        for (std::size_t sx = 0; sx < grid.nx; ++sx) {
                            const std::size_t source = cell_index(grid, sx, sy, sz);
                            const Vector3 &current = cell_current_density_a_per_m2[source];
                            if (current[0] == 0.0 && current[1] == 0.0 &&
                                current[2] == 0.0) {
                                continue;
                            }
                            const auto key = std::make_tuple(
                                static_cast<std::ptrdiff_t>(tx) -
                                    static_cast<std::ptrdiff_t>(sx),
                                static_cast<std::ptrdiff_t>(ty) -
                                    static_cast<std::ptrdiff_t>(sy),
                                static_cast<std::ptrdiff_t>(tz) -
                                    static_cast<std::ptrdiff_t>(sz));
                            auto found = kernel_cache.find(key);
                            if (found == kernel_cache.end()) {
                                const auto integrated =
                                    integrate_source_cell_at_target_center(
                                        grid,
                                        {std::get<0>(key),
                                         std::get<1>(key),
                                         std::get<2>(key)});
                                if (!integrated.converged) {
                                    throw std::runtime_error(
                                        "direct oracle failed to converge");
                                }
                                found =
                                    kernel_cache.emplace(key, integrated.value_m).first;
                            }
                            const Vector3 &k = found->second;
                            value[0] += current[1] * k[2] - current[2] * k[1];
                            value[1] += -current[0] * k[2] + current[2] * k[0];
                            value[2] += current[0] * k[1] - current[1] * k[0];
                        }
                    }
                }
                field[target] = value;
            }
        }
    }
    return field;
}

} // namespace fullmag::fdm::cpu::oersted::test_only
