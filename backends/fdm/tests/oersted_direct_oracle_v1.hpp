#pragma once

#include <fullmag/fdm/cpu/oersted_fft_open_v1.hpp>

#include <array>
#include <cstddef>
#include <vector>

namespace fullmag::fdm::cpu::oersted::test_only {

using v1::Grid;
using v1::Vector3;

struct OracleKernelResult {
    Vector3 value_m{};
    bool converged = false;
    std::size_t evaluations = 0;
    std::size_t deepest_subdivision = 0;
};

OracleKernelResult integrate_source_cell_at_target_center(
    const Grid &grid,
    std::array<std::ptrdiff_t, 3> displacement_cells);

struct AdaptiveSpotCheckResult {
    Vector3 value_m{};
    Vector3 successive_error_m{};
    Vector3 budget_m{};
    bool converged = false;
    std::size_t evaluations = 0;
    std::size_t subdivisions_per_axis = 0;
};

AdaptiveSpotCheckResult adaptive_surface_spot_check(
    const Grid &grid,
    std::array<std::ptrdiff_t, 3> displacement_cells);

std::vector<Vector3> direct_field_from_cell_current(
    const Grid &grid,
    const std::vector<Vector3> &cell_current_density_a_per_m2,
    const std::vector<std::uint8_t> &target_mask);

} // namespace fullmag::fdm::cpu::oersted::test_only
