#include <fullmag/fdm/cpu/oersted_fft_open_v1.hpp>

#include "oersted_direct_oracle_v1.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <queue>
#include <random>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {
std::atomic<bool> allocation_counting_enabled{false};
std::atomic<std::size_t> counted_allocations{0};
}

void *operator new(std::size_t size) {
    if (void *memory = std::malloc(size)) {
        if (allocation_counting_enabled.load(std::memory_order_relaxed)) {
            counted_allocations.fetch_add(1U, std::memory_order_relaxed);
        }
        return memory;
    }
    throw std::bad_alloc();
}

void *operator new[](std::size_t size) {
    return ::operator new(size);
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete[](void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

void operator delete[](void *memory, std::size_t) noexcept {
    std::free(memory);
}

namespace oe = fullmag::fdm::cpu::oersted::v1;
namespace oracle = fullmag::fdm::cpu::oersted::test_only;

namespace {

constexpr double pi = 3.141592653589793238462643383279502884;

void check(bool condition, const std::string &message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message.c_str());
        std::exit(1);
    }
}

void check_close(double actual,
                 double expected,
                 double absolute_tolerance,
                 double relative_tolerance,
                 const std::string &message) {
    check(std::isfinite(actual) && std::isfinite(expected), message + " must be finite");
    const double tolerance = absolute_tolerance +
                             relative_tolerance *
                                 std::max(std::abs(actual), std::abs(expected));
    if (std::abs(actual - expected) > tolerance) {
        std::fprintf(stderr,
                     "FAIL: %s: expected %.17e, got %.17e, tolerance %.3e\n",
                     message.c_str(),
                     expected,
                     actual,
                     tolerance);
        std::exit(1);
    }
}

std::size_t checked_cells(const oe::Grid &grid) {
    return grid.nx * grid.ny * grid.nz;
}

std::size_t cell_index(const oe::Grid &grid,
                       std::size_t x,
                       std::size_t y,
                       std::size_t z) {
    return (z * grid.ny + y) * grid.nx + x;
}

std::array<std::size_t, 3> cell_coordinates(const oe::Grid &grid,
                                             std::size_t index) {
    const std::size_t x = index % grid.nx;
    index /= grid.nx;
    const std::size_t y = index % grid.ny;
    return {x, y, index / grid.ny};
}

std::size_t x_face_index(const oe::Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) {
    return (z * grid.ny + y) * (grid.nx + 1) + x;
}

std::size_t y_face_index(const oe::Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) {
    return (z * (grid.ny + 1) + y) * grid.nx + x;
}

std::size_t z_face_index(const oe::Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) {
    return (z * grid.ny + y) * grid.nx + x;
}

oe::FaceCurrentDensity zero_faces(const oe::Grid &grid) {
    oe::FaceCurrentDensity faces;
    faces.x.assign((grid.nx + 1) * grid.ny * grid.nz, 0.0);
    faces.y.assign(grid.nx * (grid.ny + 1) * grid.nz, 0.0);
    faces.z.assign(grid.nx * grid.ny * (grid.nz + 1), 0.0);
    return faces;
}

double face_area(const oe::Grid &grid, std::size_t axis) {
    if (axis == 0) {
        return grid.dy_m * grid.dz_m;
    }
    if (axis == 1) {
        return grid.dx_m * grid.dz_m;
    }
    return grid.dx_m * grid.dy_m;
}

std::uint64_t flattened_face_id(const oe::Grid &grid,
                                std::size_t axis,
                                std::size_t face_index) {
    const std::uint64_t x_count =
        static_cast<std::uint64_t>((grid.nx + 1) * grid.ny * grid.nz);
    const std::uint64_t y_count =
        static_cast<std::uint64_t>(grid.nx * (grid.ny + 1) * grid.nz);
    if (axis == 0) {
        return static_cast<std::uint64_t>(face_index);
    }
    if (axis == 1) {
        return x_count + static_cast<std::uint64_t>(face_index);
    }
    return x_count + y_count + static_cast<std::uint64_t>(face_index);
}

std::pair<std::size_t, std::size_t> add_oriented_internal_current(
    const oe::Grid &grid,
    oe::FaceCurrentDensity &faces,
    std::size_t from_cell,
    std::size_t to_cell,
    double signed_current_a) {
    const auto from = cell_coordinates(grid, from_cell);
    const auto to = cell_coordinates(grid, to_cell);
    for (std::size_t axis = 0; axis < 3; ++axis) {
        const std::ptrdiff_t difference = static_cast<std::ptrdiff_t>(to[axis]) -
                                          static_cast<std::ptrdiff_t>(from[axis]);
        if (std::abs(difference) != 1) {
            continue;
        }
        const std::size_t other_a = (axis + 1) % 3;
        const std::size_t other_b = (axis + 2) % 3;
        check(from[other_a] == to[other_a] && from[other_b] == to[other_b],
              "current edge cells must share one face");
        const double density = signed_current_a / face_area(grid, axis) *
                               static_cast<double>(difference);
        std::size_t face = 0;
        if (axis == 0) {
            face = x_face_index(grid,
                                std::max(from[0], to[0]),
                                from[1],
                                from[2]);
            faces.x[face] += density;
        } else if (axis == 1) {
            face = y_face_index(grid,
                                from[0],
                                std::max(from[1], to[1]),
                                from[2]);
            faces.y[face] += density;
        } else {
            face = z_face_index(grid,
                                from[0],
                                from[1],
                                std::max(from[2], to[2]));
            faces.z[face] += density;
        }
        return {axis, face};
    }
    check(false, "current edge cells must be face adjacent");
    return {};
}

std::pair<std::size_t, std::size_t> add_plaquette_loop(
    const oe::Grid &grid,
    oe::FaceCurrentDensity &faces,
    std::size_t axis_u,
    std::size_t axis_v,
    std::array<std::size_t, 3> lower,
    double current_a) {
    check(axis_u != axis_v, "plaquette axes must differ");
    auto coordinate = lower;
    const std::size_t a = cell_index(grid, coordinate[0], coordinate[1], coordinate[2]);
    ++coordinate[axis_u];
    const std::size_t b = cell_index(grid, coordinate[0], coordinate[1], coordinate[2]);
    ++coordinate[axis_v];
    const std::size_t c = cell_index(grid, coordinate[0], coordinate[1], coordinate[2]);
    --coordinate[axis_u];
    const std::size_t d = cell_index(grid, coordinate[0], coordinate[1], coordinate[2]);
    const auto first = add_oriented_internal_current(grid, faces, a, b, current_a);
    add_oriented_internal_current(grid, faces, b, c, current_a);
    add_oriented_internal_current(grid, faces, c, d, current_a);
    add_oriented_internal_current(grid, faces, d, a, current_a);
    return first;
}

std::vector<std::uint64_t> component_labels(const oe::Grid &grid,
                                             const std::vector<std::uint8_t> &mask,
                                             std::size_t &component_count) {
    const std::size_t cells = checked_cells(grid);
    std::vector<std::uint64_t> labels(cells, oe::inactive_component_label);
    component_count = 0;
    for (std::size_t seed = 0; seed < cells; ++seed) {
        if (mask[seed] == 0 || labels[seed] != oe::inactive_component_label) {
            continue;
        }
        const std::uint64_t label = static_cast<std::uint64_t>(seed);
        ++component_count;
        std::queue<std::size_t> queue;
        queue.push(seed);
        labels[seed] = label;
        while (!queue.empty()) {
            const std::size_t current = queue.front();
            queue.pop();
            const auto c = cell_coordinates(grid, current);
            for (std::size_t axis = 0; axis < 3; ++axis) {
                for (int direction : {-1, 1}) {
                    auto next = c;
                    const std::ptrdiff_t value =
                        static_cast<std::ptrdiff_t>(next[axis]) + direction;
                    const std::size_t extent =
                        axis == 0 ? grid.nx : (axis == 1 ? grid.ny : grid.nz);
                    if (value < 0 || value >= static_cast<std::ptrdiff_t>(extent)) {
                        continue;
                    }
                    next[axis] = static_cast<std::size_t>(value);
                    const std::size_t index =
                        cell_index(grid, next[0], next[1], next[2]);
                    if (mask[index] != 0 &&
                        labels[index] == oe::inactive_component_label) {
                        labels[index] = label;
                        queue.push(index);
                    }
                }
            }
        }
    }
    return labels;
}

double max_abs_face_divergence(const oe::Problem &problem) {
    double maximum = 0.0;
    for (std::size_t z = 0; z < problem.grid.nz; ++z) {
        for (std::size_t y = 0; y < problem.grid.ny; ++y) {
            for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                const std::size_t cell = cell_index(problem.grid, x, y, z);
                if (problem.conductor_mask[cell] == 0) {
                    continue;
                }
                const double divergence =
                    (problem.face_current_density_a_per_m2.x[
                         x_face_index(problem.grid, x + 1, y, z)] -
                     problem.face_current_density_a_per_m2.x[
                         x_face_index(problem.grid, x, y, z)]) /
                        problem.grid.dx_m +
                    (problem.face_current_density_a_per_m2.y[
                         y_face_index(problem.grid, x, y + 1, z)] -
                     problem.face_current_density_a_per_m2.y[
                         y_face_index(problem.grid, x, y, z)]) /
                        problem.grid.dy_m +
                    (problem.face_current_density_a_per_m2.z[
                         z_face_index(problem.grid, x, y, z + 1)] -
                     problem.face_current_density_a_per_m2.z[
                         z_face_index(problem.grid, x, y, z)]) /
                        problem.grid.dz_m;
                maximum = std::max(maximum, std::abs(divergence));
            }
        }
    }
    return maximum;
}

double max_abs_face_divergence_scale(const oe::Problem &problem) {
    double maximum = 0.0;
    for (std::size_t z = 0; z < problem.grid.nz; ++z) {
        for (std::size_t y = 0; y < problem.grid.ny; ++y) {
            for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                const std::size_t cell = cell_index(problem.grid, x, y, z);
                if (problem.conductor_mask[cell] == 0) {
                    continue;
                }
                const double scale =
                    (std::abs(problem.face_current_density_a_per_m2.x[
                         x_face_index(problem.grid, x + 1, y, z)]) +
                     std::abs(problem.face_current_density_a_per_m2.x[
                         x_face_index(problem.grid, x, y, z)])) /
                        problem.grid.dx_m +
                    (std::abs(problem.face_current_density_a_per_m2.y[
                         y_face_index(problem.grid, x, y + 1, z)]) +
                     std::abs(problem.face_current_density_a_per_m2.y[
                         y_face_index(problem.grid, x, y, z)])) /
                        problem.grid.dy_m +
                    (std::abs(problem.face_current_density_a_per_m2.z[
                         z_face_index(problem.grid, x, y, z + 1)]) +
                     std::abs(problem.face_current_density_a_per_m2.z[
                         z_face_index(problem.grid, x, y, z)])) /
                        problem.grid.dz_m;
                maximum = std::max(maximum, scale);
            }
        }
    }
    return maximum;
}

bool any_nonzero_face(const oe::FaceCurrentDensity &faces) {
    const auto nonzero = [](double value) { return value != 0.0; };
    return std::any_of(faces.x.begin(), faces.x.end(), nonzero) ||
           std::any_of(faces.y.begin(), faces.y.end(), nonzero) ||
           std::any_of(faces.z.begin(), faces.z.end(), nonzero);
}

std::uint64_t component_label_for_internal_face(
    const oe::Grid &grid,
    const std::vector<std::uint64_t> &labels,
    std::size_t axis,
    std::size_t face) {
    if (axis == 0) {
        const std::size_t x = face % (grid.nx + 1U);
        const std::size_t yz = face / (grid.nx + 1U);
        const std::size_t y = yz % grid.ny;
        const std::size_t z = yz / grid.ny;
        check(x > 0 && x < grid.nx, "source cut x-face must be internal");
        return labels[cell_index(grid, x - 1U, y, z)];
    }
    if (axis == 1) {
        const std::size_t x = face % grid.nx;
        const std::size_t yz = face / grid.nx;
        const std::size_t y = yz % (grid.ny + 1U);
        const std::size_t z = yz / (grid.ny + 1U);
        check(y > 0 && y < grid.ny, "source cut y-face must be internal");
        return labels[cell_index(grid, x, y - 1U, z)];
    }
    const std::size_t x = face % grid.nx;
    const std::size_t yz = face / grid.nx;
    const std::size_t y = yz % grid.ny;
    const std::size_t z = yz / grid.ny;
    check(z > 0 && z < grid.nz, "source cut z-face must be internal");
    return labels[cell_index(grid, x, y, z - 1U)];
}

void finalize_problem_identity(oe::Problem &problem,
                               std::pair<std::size_t, std::size_t> cut_face) {
    problem.geometry_revision = std::max<std::uint64_t>(problem.geometry_revision, 1);
    problem.conductor_mask_revision =
        std::max<std::uint64_t>(problem.conductor_mask_revision, 1);
    problem.target_mask_revision =
        std::max<std::uint64_t>(problem.target_mask_revision, 1);
    problem.face_current_revision =
        std::max<std::uint64_t>(problem.face_current_revision, 1);
    problem.envelope_revision = std::max<std::uint64_t>(problem.envelope_revision, 1);
    problem.stage_identity = std::max<std::uint64_t>(problem.stage_identity, 1);
    problem.source_identity = "closed-loop-source";
    problem.envelope_digest = "sha256:test-envelope";
    problem.geometry_digest = oe::canonical_geometry_digest(problem.grid);
    problem.conductor_mask_digest = oe::canonical_mask_digest(problem.conductor_mask);
    problem.target_mask_digest = oe::canonical_mask_digest(problem.target_mask);
    problem.face_current_digest =
        oe::canonical_face_current_digest(problem.face_current_density_a_per_m2);

    auto &certificate = problem.closure_certificate;
    certificate.version = std::string(oe::certificate_version);
    certificate.closure_kind = oe::ClosureKind::closed_geometry;
    certificate.revision = problem.face_current_revision;
    certificate.geometry_digest = problem.geometry_digest;
    certificate.conductor_mask_revision = problem.conductor_mask_revision;
    certificate.conductor_mask_digest = problem.conductor_mask_digest;
    certificate.face_current_revision = problem.face_current_revision;
    certificate.face_current_digest = problem.face_current_digest;
    certificate.component_labels =
        component_labels(problem.grid, problem.conductor_mask, certificate.component_count);
    certificate.global_continuity_passed = true;
    certificate.exterior_flux_passed = true;
    certificate.component_flux_passed = true;
    certificate.return_path_complete = true;
    certificate.divergence_tolerance_a_per_m3 =
        std::max(1.0e-2,
                 128.0 * std::numeric_limits<double>::epsilon() *
                     max_abs_face_divergence_scale(problem));
    certificate.exterior_current_tolerance_a = 1.0e-18;
    certificate.measured_max_abs_divergence_a_per_m3 =
        max_abs_face_divergence(problem);
    certificate.measured_component_exterior_current_a.assign(
        certificate.component_count, 0.0);
    if (any_nonzero_face(problem.face_current_density_a_per_m2)) {
        oe::SourceCutRecord source_cut;
        source_cut.stable_id = "source-cut-1";
        source_cut.component_label = component_label_for_internal_face(
            problem.grid,
            certificate.component_labels,
            cut_face.first,
            cut_face.second);
        const std::uint64_t flat_face =
            flattened_face_id(problem.grid, cut_face.first, cut_face.second);
        source_cut.ordered_internal_face_ids = {
            flat_face,
            flat_face,
        };
        source_cut.ordered_normals = {1, -1};
        source_cut.drive_id = "drive-1";
        source_cut.drive_kind = "impressed_potential_jump.v1";
        source_cut.drive_value = 1.0;
        source_cut.drive_si_unit = "V";
        source_cut.revision = problem.face_current_revision;
        source_cut.digest = oe::canonical_source_cut_digest(source_cut);
        certificate.source_cuts = {std::move(source_cut)};
    } else {
        certificate.source_cuts.clear();
    }
    certificate.digest = oe::canonical_certificate_digest(certificate);
    problem.trusted_snapshot_revision = problem.face_current_revision;
    problem.trusted_snapshot_digest = oe::canonical_trusted_snapshot_digest(problem);
}

void refresh_certificate_and_snapshot(oe::Problem &problem) {
    problem.closure_certificate.digest =
        oe::canonical_certificate_digest(problem.closure_certificate);
    problem.trusted_snapshot_revision = problem.face_current_revision;
    problem.trusted_snapshot_digest = oe::canonical_trusted_snapshot_digest(problem);
}

oe::Problem plaquette_problem(oe::Grid grid,
                              std::size_t axis_u,
                              std::size_t axis_v,
                              std::array<std::size_t, 3> lower,
                              double current_a,
                              bool full_conductor = true) {
    oe::Problem problem;
    problem.grid = grid;
    const std::size_t cells = checked_cells(grid);
    problem.conductor_mask.assign(cells, full_conductor ? 1 : 0);
    problem.target_mask.assign(cells, 1);
    problem.face_current_density_a_per_m2 = zero_faces(grid);
    if (!full_conductor) {
        auto coordinate = lower;
        problem.conductor_mask[cell_index(grid, coordinate[0], coordinate[1], coordinate[2])] = 1;
        ++coordinate[axis_u];
        problem.conductor_mask[cell_index(grid, coordinate[0], coordinate[1], coordinate[2])] = 1;
        ++coordinate[axis_v];
        problem.conductor_mask[cell_index(grid, coordinate[0], coordinate[1], coordinate[2])] = 1;
        --coordinate[axis_u];
        problem.conductor_mask[cell_index(grid, coordinate[0], coordinate[1], coordinate[2])] = 1;
    }
    const auto cut = add_plaquette_loop(grid,
                                        problem.face_current_density_a_per_m2,
                                        axis_u,
                                        axis_v,
                                        lower,
                                        current_a);
    finalize_problem_identity(problem, cut);
    return problem;
}

oe::Problem zero_problem(oe::Grid grid) {
    oe::Problem problem;
    problem.grid = grid;
    problem.conductor_mask.assign(checked_cells(grid), 1);
    problem.target_mask.assign(checked_cells(grid), 1);
    problem.face_current_density_a_per_m2 = zero_faces(grid);
    finalize_problem_identity(problem, {0, 0});
    return problem;
}

oe::Problem rectangular_current_loop_problem(const oe::Grid &grid,
                                             std::size_t x0,
                                             std::size_t x1,
                                             std::size_t y0,
                                             std::size_t y1,
                                             std::size_t z,
                                             double current_a) {
    oe::Problem problem;
    problem.grid = grid;
    problem.conductor_mask.assign(checked_cells(grid), 1U);
    problem.target_mask.assign(checked_cells(grid), 1U);
    problem.face_current_density_a_per_m2 = zero_faces(grid);
    const std::size_t first_from = cell_index(grid, x0, y0, z);
    const std::size_t first_to = cell_index(grid, x0 + 1U, y0, z);
    const auto cut = add_oriented_internal_current(
        grid,
        problem.face_current_density_a_per_m2,
        first_from,
        first_to,
        current_a);
    for (std::size_t x = x0 + 1U; x < x1; ++x) {
        add_oriented_internal_current(
            grid,
            problem.face_current_density_a_per_m2,
            cell_index(grid, x, y0, z),
            cell_index(grid, x + 1U, y0, z),
            current_a);
    }
    for (std::size_t y = y0; y < y1; ++y) {
        add_oriented_internal_current(
            grid,
            problem.face_current_density_a_per_m2,
            cell_index(grid, x1, y, z),
            cell_index(grid, x1, y + 1U, z),
            current_a);
    }
    for (std::size_t x = x1; x > x0; --x) {
        add_oriented_internal_current(
            grid,
            problem.face_current_density_a_per_m2,
            cell_index(grid, x, y1, z),
            cell_index(grid, x - 1U, y1, z),
            current_a);
    }
    for (std::size_t y = y1; y > y0; --y) {
        add_oriented_internal_current(
            grid,
            problem.face_current_density_a_per_m2,
            cell_index(grid, x0, y, z),
            cell_index(grid, x0, y - 1U, z),
            current_a);
    }
    finalize_problem_identity(problem, cut);
    return problem;
}

double oriented_yz_contour_integral(const oe::Grid &grid,
                                    const std::vector<oe::Vector3> &field,
                                    std::size_t x,
                                    std::size_t y_min,
                                    std::size_t y_max,
                                    std::size_t z_min,
                                    std::size_t z_max) {
    const auto value = [&grid, &field, x](std::size_t y, std::size_t z) {
        return field[cell_index(grid, x, y, z)];
    };
    double integral_a = 0.0;
    for (std::size_t y = y_min; y < y_max; ++y) {
        integral_a += 0.5 *
                      (value(y, z_min)[1] + value(y + 1U, z_min)[1]) *
                      grid.dy_m;
    }
    for (std::size_t z = z_min; z < z_max; ++z) {
        integral_a += 0.5 *
                      (value(y_max, z)[2] + value(y_max, z + 1U)[2]) *
                      grid.dz_m;
    }
    for (std::size_t y = y_max; y > y_min; --y) {
        integral_a -= 0.5 *
                      (value(y, z_max)[1] + value(y - 1U, z_max)[1]) *
                      grid.dy_m;
    }
    for (std::size_t z = z_max; z > z_min; --z) {
        integral_a -= 0.5 *
                      (value(y_min, z)[2] + value(y_min, z - 1U)[2]) *
                      grid.dz_m;
    }
    return integral_a;
}

void check_kernel_mixed_bound(const oe::Grid &grid,
                              std::array<std::ptrdiff_t, 3> displacement) {
    const double h_max = std::max({grid.dx_m, grid.dy_m, grid.dz_m});
    const auto analytic =
        oracle::integrate_source_cell_at_target_center(grid, displacement);
    const auto spot = oracle::adaptive_surface_spot_check(grid, displacement);
    if (!(analytic.converged && spot.converged)) {
        std::fprintf(stderr,
                     "FAIL: independent oracle spot check did not converge at "
                     "(%td,%td,%td); eval=%zu subdivisions=%zu converged=%d; "
                     "analytic=(%.17e,%.17e,%.17e) "
                     "spot=(%.17e,%.17e,%.17e) error=(%.3e,%.3e,%.3e) "
                     "budget=(%.3e,%.3e,%.3e)\n",
                     displacement[0],
                     displacement[1],
                     displacement[2],
                     spot.evaluations,
                     spot.subdivisions_per_axis,
                     spot.converged ? 1 : 0,
                     analytic.value_m[0],
                     analytic.value_m[1],
                     analytic.value_m[2],
                     spot.value_m[0],
                     spot.value_m[1],
                     spot.value_m[2],
                     spot.successive_error_m[0],
                     spot.successive_error_m[1],
                     spot.successive_error_m[2],
                     spot.budget_m[0],
                     spot.budget_m[1],
                     spot.budget_m[2]);
        std::exit(1);
    }
    const oe::Vector3 production = oe::cell_integrated_kernel_m(grid, displacement);
    for (std::size_t component = 0; component < 3; ++component) {
        if (displacement[component] == 0) {
            check(production[component] == 0.0 &&
                      !std::signbit(production[component]),
                  "component-parity kernel zero must be exact positive zero");
            continue;
        }
        check(spot.successive_error_m[component] <= spot.budget_m[component],
              "adaptive surface spot-check successive error exceeds budget");
        check(std::abs(analytic.value_m[component] - spot.value_m[component]) <=
                  4.0 * spot.budget_m[component],
              "analytic surface oracle disagrees with adaptive spot check");
        const double production_budget =
            2.0e-13 * h_max + 2.0e-11 * std::abs(analytic.value_m[component]);
        check(std::abs(production[component] - analytic.value_m[component]) <=
                  production_budget,
              "production kernel exceeds mixed direct-oracle bound");
    }
}

double field_scale_for_target(const oe::Grid &grid,
                              const std::vector<oe::Vector3> &current,
                              std::size_t target) {
    const auto t = cell_coordinates(grid, target);
    double scale = 0.0;
    for (std::size_t source = 0; source < current.size(); ++source) {
        const double current_inf = std::max({std::abs(current[source][0]),
                                             std::abs(current[source][1]),
                                             std::abs(current[source][2])});
        if (current_inf == 0.0) {
            continue;
        }
        const auto s = cell_coordinates(grid, source);
        const auto integrated = oracle::integrate_source_cell_at_target_center(
            grid,
            {static_cast<std::ptrdiff_t>(t[0]) - static_cast<std::ptrdiff_t>(s[0]),
             static_cast<std::ptrdiff_t>(t[1]) - static_cast<std::ptrdiff_t>(s[1]),
             static_cast<std::ptrdiff_t>(t[2]) - static_cast<std::ptrdiff_t>(s[2])});
        check(integrated.converged, "field scale oracle must converge");
        const double kernel_inf = std::max({std::abs(integrated.value_m[0]),
                                            std::abs(integrated.value_m[1]),
                                            std::abs(integrated.value_m[2])});
        scale += kernel_inf * current_inf;
    }
    return scale;
}

void compare_fft_with_direct(const oe::Problem &problem,
                             const oe::SolveResult &result,
                             const std::string &label) {
    const auto direct = oracle::direct_field_from_cell_current(
        problem.grid,
        result.solution.cell_current_density_a_per_m2,
        problem.target_mask);
    const double epsilon = std::numeric_limits<double>::epsilon();
    for (std::size_t cell = 0; cell < direct.size(); ++cell) {
        if (problem.target_mask[cell] == 0) {
            check(result.solution.field_a_per_m[cell] == oe::Vector3{},
                  label + " inactive target must remain zero");
            continue;
        }
        const double scale = field_scale_for_target(
            problem.grid, result.solution.cell_current_density_a_per_m2, cell);
        for (std::size_t component = 0; component < 3; ++component) {
            const double tolerance = 1024.0 * epsilon * scale +
                                     5.0e-12 * std::abs(direct[cell][component]);
            check_close(result.solution.field_a_per_m[cell][component],
                        direct[cell][component],
                        tolerance,
                        0.0,
                        label + " FFT/direct component parity");
        }
    }
}

void version_and_reconstruction_contract() {
    check(oe::operator_version == "fdm_oersted_cell_integrated_open.v1",
          "operator version must remain frozen");
    check(oe::realization_version == "oersted_fdm_fft_open.v1",
          "realization version must remain frozen");
    check(oe::engine_version == "fdm_oersted_fft_open_v1",
          "CPU engine identity must remain frozen");

    oe::Grid grid{2, 1, 1, 2.0, 3.0, 5.0, {7.0, 11.0, 13.0}};
    auto faces = zero_faces(grid);
    faces.x = {2.0, 4.0, 6.0};
    faces.y = {1.0, 5.0, -1.0, 7.0};
    faces.z = {3.0, 9.0, -3.0, -9.0};
    std::vector<oe::Vector3> current;
    std::string message;
    check(oe::reconstruct_face_to_cell(grid, {1, 1}, faces, current, message) ==
              oe::Status::ok,
          message);
    check(current.size() == 2, "reconstruction must publish one vector per cell");
    check(current[0] == oe::Vector3{3.0, 0.0, 0.0},
          "cell 0 arithmetic face mean mismatch");
    check(current[1] == oe::Vector3{5.0, 6.0, 0.0},
          "cell 1 arithmetic face mean mismatch");

    check(oe::reconstruct_face_to_cell(grid, {1, 0}, faces, current, message) ==
              oe::Status::ok,
          message);
    check(current[1] == oe::Vector3{}, "conductor mask must zero inactive source cell");
}

void kernel_contract_and_independent_oracle() {
    const oe::Grid isotropic{5, 5, 5, 1.0e-9, 1.0e-9, 1.0e-9};
    const oe::Vector3 self = oe::cell_integrated_kernel_m(isotropic, {0, 0, 0});
    for (double value : self) {
        check(value == 0.0 && !std::signbit(value),
              "self kernel must be IEEE-754 positive zero");
    }
    check_kernel_mixed_bound(isotropic, {1, 0, 0});
    check_kernel_mixed_bound(isotropic, {1, 1, 0});
    check_kernel_mixed_bound(isotropic, {1, 1, 1});
    check_kernel_mixed_bound(isotropic, {7, -4, 3});

    const oe::Grid anisotropic{5, 5, 5, 0.2e-9, 1.7e-9, 8.0e-9};
    check_kernel_mixed_bound(anisotropic, {1, 0, 0});
    check_kernel_mixed_bound(anisotropic, {1, 1, 1});
    check_kernel_mixed_bound(anisotropic, {5, -3, 2});

    const auto positive = oe::cell_integrated_kernel_m(anisotropic, {3, -2, 4});
    const auto negative = oe::cell_integrated_kernel_m(anisotropic, {-3, 2, -4});
    for (std::size_t component = 0; component < 3; ++component) {
        check(negative[component] == -positive[component],
              "kernel odd parity must be an exact sign involution");
    }

    const auto far = oe::cell_integrated_kernel_m(isotropic, {80, -61, 47});
    const oe::Vector3 r{80.0e-9, -61.0e-9, 47.0e-9};
    const double radius2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    const double factor = isotropic.dx_m * isotropic.dy_m * isotropic.dz_m /
                          (4.0 * pi * radius2 * std::sqrt(radius2));
    for (std::size_t component = 0; component < 3; ++component) {
        check_close(far[component],
                    factor * r[component],
                    0.0,
                    2.0e-4,
                    "far kernel must approach midpoint limit");
    }

    oe::Grid scaled = isotropic;
    scaled.dx_m *= 3.0;
    scaled.dy_m *= 3.0;
    scaled.dz_m *= 3.0;
    const auto base = oe::cell_integrated_kernel_m(isotropic, {2, 3, 4});
    const auto triple = oe::cell_integrated_kernel_m(scaled, {2, 3, 4});
    for (std::size_t component = 0; component < 3; ++component) {
        check_close(triple[component],
                    3.0 * base[component],
                    1.0e-24,
                    2.0e-13,
                    "kernel must scale as length and contain no mu0");
    }

    const auto cancellation_a =
        oracle::integrate_source_cell_at_target_center(anisotropic, {1, 1, 0});
    const auto cancellation_b =
        oracle::integrate_source_cell_at_target_center(anisotropic, {2, 1, 0});
    const auto cancellation_a_spot =
        oracle::adaptive_surface_spot_check(anisotropic, {1, 1, 0});
    const auto cancellation_b_spot =
        oracle::adaptive_surface_spot_check(anisotropic, {2, 1, 0});
    check(cancellation_a.converged && cancellation_b.converged &&
              cancellation_a_spot.converged && cancellation_b_spot.converged &&
              cancellation_b.value_m[1] != 0.0,
          "cancellation oracle fixtures must converge");
    const double cancellation_weight =
        -cancellation_a.value_m[1] / cancellation_b.value_m[1] *
        (1.0 - 1.0e-8);
    const double analytic_cancellation =
        cancellation_a.value_m[1] +
        cancellation_weight * cancellation_b.value_m[1];
    const double adaptive_cancellation =
        cancellation_a_spot.value_m[1] +
        cancellation_weight * cancellation_b_spot.value_m[1];
    const double cancellation_budget =
        4.0 * (cancellation_a_spot.budget_m[1] +
               std::abs(cancellation_weight) * cancellation_b_spot.budget_m[1]);
    check(std::abs(analytic_cancellation - adaptive_cancellation) <=
              cancellation_budget,
          "cancellation-dominated analytic/adaptive oracle bound");
    check(std::abs(analytic_cancellation) <=
              2.0e-8 * std::abs(cancellation_a.value_m[1]),
          "cancellation fixture must be dominated by subtractive cancellation");
}

void failure_contract_is_fail_closed_before_planning() {
    const oe::Grid grid{5, 5, 1, 1.0e-9, 1.5e-9, 2.0e-9};
    const auto base = plaquette_problem(grid, 0, 1, {1, 1, 0}, 1.0e-6);

    {
        oe::Problem problem = base;
        problem.closure_certificate.version.clear();
        oe::Solver solver;
        const auto &result = solver.solve(problem);
        check(result.status == oe::Status::missing_certificate,
              "missing closure certificate must fail closed");
        check(solver.cache_diagnostics().plan_build_count == 0 &&
                  solver.cache_diagnostics().numerical_buffer_allocation_count == 0,
              "missing certificate must fail before FFT planning/allocation");
    }
    {
        oe::Problem problem = base;
        problem.grid.boundaries[0] = oe::AxisBoundary::periodic;
        problem.geometry_digest = oe::canonical_geometry_digest(problem.grid);
        problem.closure_certificate.geometry_digest = problem.geometry_digest;
        problem.closure_certificate.digest =
            oe::canonical_certificate_digest(problem.closure_certificate);
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::periodic_unsupported,
              "PBC must fail closed instead of reusing the open operator");
    }
    {
        oe::Problem problem = base;
        problem.face_current_density_a_per_m2.x[0] =
            std::numeric_limits<double>::quiet_NaN();
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::nonfinite_input,
              "NaN face current must fail closed");
    }
    {
        oe::Problem problem = base;
        problem.face_current_density_a_per_m2.x[0] =
            std::numeric_limits<double>::infinity();
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::nonfinite_input,
              "Inf face current must fail closed");
    }
    {
        oe::Solver solver;
        check(solver.solve(base).ok(), "valid fixture must seed a resolved field");
        oe::Problem invalid = base;
        invalid.face_current_density_a_per_m2.x[0] =
            std::numeric_limits<double>::quiet_NaN();
        const auto &failed = solver.solve(invalid);
        check(failed.status == oe::Status::nonfinite_input &&
                  failed.solution.field_a_per_m.empty() &&
                  failed.solution.cell_current_density_a_per_m2.empty(),
              "fail-closed solve must not retain a previously resolved field");
        const auto &retried = solver.solve(base);
        check(retried.ok() && !retried.solution.field_a_per_m.empty() &&
                  !retried.solution.cell_current_density_a_per_m2.empty() &&
                  !retried.solution.provenance.trusted_snapshot_digest.empty(),
              "valid -> NaN -> same-valid retry must return the full accepted payload");
    }
    {
        oe::Solver solver;
        check(solver.solve(base).ok(),
              "valid fixture must seed accepted payload before numerical failure");
        oe::Problem numerically_invalid = base;
        const double huge_spacing =
            std::numeric_limits<double>::max() / 8.0;
        numerically_invalid.grid.dx_m = huge_spacing;
        numerically_invalid.grid.dy_m = huge_spacing;
        numerically_invalid.grid.dz_m = huge_spacing;
        ++numerically_invalid.geometry_revision;
        finalize_problem_identity(
            numerically_invalid, {0, x_face_index(grid, 2, 1, 0)});
        const auto &failed = solver.solve(numerically_invalid);
        check(failed.status == oe::Status::numerical_failure &&
                  failed.solution.field_a_per_m.empty(),
              "non-finite kernel construction must fail without a stale payload");
        const auto &retried = solver.solve(base);
        check(retried.ok() && !retried.solution.field_a_per_m.empty() &&
                  !retried.solution.cell_current_density_a_per_m2.empty() &&
                  !retried.solution.provenance.trusted_snapshot_digest.empty(),
              "valid -> numerical failure -> same-valid retry must preserve payload");
    }
    {
        oe::Problem problem = zero_problem(grid);
        problem.closure_certificate.closure_kind =
            static_cast<oe::ClosureKind>(999U);
        refresh_certificate_and_snapshot(problem);
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::closure_failure,
              "unknown closure enum must fail even for a zero-current snapshot");
    }
    {
        oe::Problem problem;
        problem.grid = {std::numeric_limits<std::size_t>::max() / 2U + 1U,
                        1,
                        1,
                        1.0,
                        1.0,
                        1.0};
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::invalid_argument &&
                  solver.cache_diagnostics().plan_build_count == 0,
              "overflowing exact-2N padding must fail before planning");
    }
    {
        oe::Problem problem = base;
        problem.face_current_density_a_per_m2.y.pop_back();
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::shape_mismatch,
              "face shape mismatch must fail closed");
    }
    {
        oe::Problem problem = base;
        ++problem.face_current_revision;
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::stale_certificate,
              "stale face-current revision must fail closed");
    }
    {
        oe::Problem problem = base;
        problem.face_current_density_a_per_m2.x[
            x_face_index(grid, 0, 2, 0)] = 1.0e10;
        problem.face_current_digest =
            oe::canonical_face_current_digest(problem.face_current_density_a_per_m2);
        problem.closure_certificate.face_current_digest = problem.face_current_digest;
        problem.closure_certificate.measured_max_abs_divergence_a_per_m3 =
            max_abs_face_divergence(problem);
        refresh_certificate_and_snapshot(problem);
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::open_circuit,
              "open terminal current must fail despite a freshly hashed certificate");
    }
    {
        oe::Problem problem = plaquette_problem(
            grid, 0, 1, {1, 1, 0}, 1.0e-6, false);
        const std::size_t inactive_face = x_face_index(grid, 4, 4, 0);
        problem.face_current_density_a_per_m2.x[inactive_face] = 1.0;
        problem.face_current_digest =
            oe::canonical_face_current_digest(problem.face_current_density_a_per_m2);
        problem.closure_certificate.face_current_digest = problem.face_current_digest;
        refresh_certificate_and_snapshot(problem);
        oe::Solver solver;
        check(solver.solve(problem).status == oe::Status::closure_failure,
              "inactive topology face carrying current must fail closed");
    }
}

void source_cut_certificate_contract() {
    const oe::Grid grid{6, 6, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    const oe::Problem base =
        plaquette_problem(grid, 0, 1, {1, 1, 0}, 1.0e-6);
    const auto resign = [](oe::Problem &problem) {
        for (oe::SourceCutRecord &cut :
             problem.closure_certificate.source_cuts) {
            cut.digest = oe::canonical_source_cut_digest(cut);
        }
        refresh_certificate_and_snapshot(problem);
    };
    const auto expect_rejected = [](const oe::Problem &problem,
                                    const char *label) {
        oe::Solver solver;
        const auto status = solver.solve(problem).status;
        check(status == oe::Status::closure_failure ||
                  status == oe::Status::open_circuit,
              std::string("source-cut mutation must fail: ") + label);
    };

    {
        oe::Problem problem = base;
        problem.closure_certificate.source_cuts[0].drive_kind = "anything";
        resign(problem);
        expect_rejected(problem, "unsupported drive kind");
    }
    {
        oe::Problem problem = base;
        problem.closure_certificate.source_cuts[0].drive_si_unit = "kg";
        resign(problem);
        expect_rejected(problem, "wrong drive SI unit");
    }
    {
        oe::Problem problem = base;
        problem.closure_certificate.source_cuts[0].revision =
            problem.face_current_revision + 1U;
        resign(problem);
        expect_rejected(problem, "stale source-cut revision");
    }
    {
        oe::Problem problem = base;
        auto &cut = problem.closure_certificate.source_cuts[0];
        const std::uint64_t zero_face = flattened_face_id(
            grid, 0, x_face_index(grid, 4, 4, 0));
        cut.ordered_internal_face_ids = {zero_face, zero_face};
        resign(problem);
        expect_rejected(problem, "zero-current dummy face");
    }
    {
        oe::Problem problem = base;
        auto &cut = problem.closure_certificate.source_cuts[0];
        cut.ordered_internal_face_ids.pop_back();
        cut.ordered_normals.pop_back();
        resign(problem);
        expect_rejected(problem, "unpaired trace");
    }
    {
        oe::Problem problem = base;
        auto &cut = problem.closure_certificate.source_cuts[0];
        cut.ordered_normals = {1, 1};
        resign(problem);
        expect_rejected(problem, "non-opposite trace normals");
    }
    {
        oe::Problem problem = base;
        problem.closure_certificate.source_cuts[0].component_label =
            oe::inactive_component_label;
        resign(problem);
        expect_rejected(problem, "wrong driven component");
    }
    {
        oe::Problem problem =
            plaquette_problem(grid, 0, 1, {1, 1, 0}, 1.0e-6, false);
        auto &cut = problem.closure_certificate.source_cuts[0];
        const std::uint64_t inactive_face = flattened_face_id(
            grid, 0, x_face_index(grid, 4, 4, 0));
        cut.ordered_internal_face_ids = {inactive_face, inactive_face};
        resign(problem);
        expect_rejected(problem, "inactive conductor trace");
    }
    {
        const oe::Grid two_grid{8, 8, 1, 1.0e-9, 1.0e-9, 1.0e-9};
        oe::Problem problem;
        problem.grid = two_grid;
        problem.conductor_mask.assign(checked_cells(two_grid), 0U);
        problem.target_mask.assign(checked_cells(two_grid), 1U);
        problem.face_current_density_a_per_m2 = zero_faces(two_grid);
        const auto activate_plaquette = [&problem, &two_grid](
                                             std::array<std::size_t, 3> lower) {
            const std::array<std::array<std::size_t, 3>, 4> cells{{
                lower,
                {lower[0] + 1U, lower[1], lower[2]},
                {lower[0] + 1U, lower[1] + 1U, lower[2]},
                {lower[0], lower[1] + 1U, lower[2]},
            }};
            for (const auto &cell : cells) {
                problem.conductor_mask[cell_index(
                    two_grid, cell[0], cell[1], cell[2])] = 1U;
            }
        };
        activate_plaquette({1, 1, 0});
        activate_plaquette({5, 5, 0});
        const auto first_cut = add_plaquette_loop(
            two_grid,
            problem.face_current_density_a_per_m2,
            0,
            1,
            {1, 1, 0},
            1.0e-6);
        add_plaquette_loop(two_grid,
                           problem.face_current_density_a_per_m2,
                           0,
                           1,
                           {5, 5, 0},
                           -0.7e-6);
        finalize_problem_identity(problem, first_cut);
        expect_rejected(problem, "missing cut for second driven component");
    }
}

void fft_matches_independent_direct_for_closed_loops() {
    std::vector<oe::Problem> problems;
    problems.push_back(plaquette_problem(
        {5, 5, 1, 0.7e-9, 1.1e-9, 2.3e-9}, 0, 1, {1, 1, 0}, 2.0e-6));
    problems.push_back(plaquette_problem(
        {1, 5, 5, 0.7e-9, 1.1e-9, 2.3e-9}, 1, 2, {0, 1, 1}, -1.5e-6));
    problems.push_back(plaquette_problem(
        {5, 1, 5, 0.7e-9, 1.1e-9, 2.3e-9}, 2, 0, {1, 0, 1}, 0.8e-6));

    std::mt19937_64 random(0x5eedULL);
    std::uniform_real_distribution<double> current(-3.0e-6, 3.0e-6);
    oe::Problem random_loops = zero_problem({6, 6, 2, 0.4e-9, 1.3e-9, 4.7e-9});
    std::pair<std::size_t, std::size_t> first_cut{};
    bool have_cut = false;
    for (std::size_t z = 0; z < random_loops.grid.nz; ++z) {
        for (std::size_t y = 1; y + 2 < random_loops.grid.ny; ++y) {
            for (std::size_t x = 1; x + 2 < random_loops.grid.nx; ++x) {
                const auto cut = add_plaquette_loop(random_loops.grid,
                                                    random_loops.face_current_density_a_per_m2,
                                                    0,
                                                    1,
                                                    {x, y, z},
                                                    current(random));
                if (!have_cut) {
                    first_cut = cut;
                    have_cut = true;
                }
            }
        }
    }
    finalize_problem_identity(random_loops, first_cut);
    problems.push_back(std::move(random_loops));

    std::size_t case_index = 0;
    for (const auto &problem : problems) {
        oe::Solver solver;
        const auto &result = solver.solve(problem);
        check(result.ok(), "closed-loop FFT solve failed: " + result.message);
        const auto expected_padded = std::array<std::size_t, 3>{
            2 * problem.grid.nx,
            2 * problem.grid.ny,
            2 * problem.grid.nz,
        };
        check(result.solution.provenance.padded_shape == expected_padded,
              "padding must be exact 2N including singleton axes");
        compare_fft_with_direct(problem,
                                result,
                                "closed-loop case " + std::to_string(case_index++));
    }

    oe::Solver singleton_solver;
    const auto &singleton = singleton_solver.solve(
        zero_problem({1, 1, 1, 0.9e-9, 1.4e-9, 2.1e-9}));
    check(singleton.ok(), singleton.message);
    check(singleton.solution.provenance.padded_shape ==
              std::array<std::size_t, 3>{2, 2, 2},
          "1x1x1 must pad to 2x2x2");
    check(singleton.solution.field_a_per_m[0] == oe::Vector3{},
          "zero singleton source must remain zero");
}

void linearity_sign_translation_masks_and_no_wrap() {
    const oe::Grid grid{8, 8, 1, 0.8e-9, 1.2e-9, 2.0e-9};
    oe::Problem a = plaquette_problem(grid, 0, 1, {1, 1, 0}, 1.2e-6);
    oe::Problem b = plaquette_problem(grid, 0, 1, {4, 4, 0}, -0.7e-6);
    oe::Problem sum = zero_problem(grid);
    for (std::size_t i = 0; i < sum.face_current_density_a_per_m2.x.size(); ++i) {
        sum.face_current_density_a_per_m2.x[i] =
            a.face_current_density_a_per_m2.x[i] + b.face_current_density_a_per_m2.x[i];
    }
    for (std::size_t i = 0; i < sum.face_current_density_a_per_m2.y.size(); ++i) {
        sum.face_current_density_a_per_m2.y[i] =
            a.face_current_density_a_per_m2.y[i] + b.face_current_density_a_per_m2.y[i];
    }
    finalize_problem_identity(sum, {0, x_face_index(grid, 2, 1, 0)});

    oe::Solver solver_a;
    oe::Solver solver_b;
    oe::Solver solver_sum;
    const auto &result_a = solver_a.solve(a);
    const auto &result_b = solver_b.solve(b);
    const auto &result_sum = solver_sum.solve(sum);
    check(result_a.ok() && result_b.ok() && result_sum.ok(),
          "linearity fixtures must solve");
    for (std::size_t cell = 0; cell < checked_cells(grid); ++cell) {
        for (std::size_t component = 0; component < 3; ++component) {
            const double expected = result_a.solution.field_a_per_m[cell][component] +
                                    result_b.solution.field_a_per_m[cell][component];
            check_close(result_sum.solution.field_a_per_m[cell][component],
                        expected,
                        2.0e-10 * std::max(1.0, std::abs(expected)),
                        3.0e-13,
                        "FFT linearity");
        }
    }

    oe::Problem reversed = a;
    for (double &value : reversed.face_current_density_a_per_m2.x) {
        value = -value;
    }
    for (double &value : reversed.face_current_density_a_per_m2.y) {
        value = -value;
    }
    for (double &value : reversed.face_current_density_a_per_m2.z) {
        value = -value;
    }
    ++reversed.face_current_revision;
    finalize_problem_identity(reversed, {0, x_face_index(grid, 2, 1, 0)});
    oe::Solver reverse_solver;
    const auto &reverse_result = reverse_solver.solve(reversed);
    check(reverse_result.ok(), reverse_result.message);
    for (std::size_t cell = 0; cell < checked_cells(grid); ++cell) {
        for (std::size_t component = 0; component < 3; ++component) {
            check_close(reverse_result.solution.field_a_per_m[cell][component],
                        -result_a.solution.field_a_per_m[cell][component],
                        2.0e-10 * std::max(
                            1.0,
                            std::abs(result_a.solution.field_a_per_m[cell][component])),
                        3.0e-13,
                        "signed-current involution");
        }
    }

    oe::Problem shifted = plaquette_problem(grid, 0, 1, {3, 2, 0}, 1.2e-6);
    oe::Solver shifted_solver;
    const auto &shifted_result = shifted_solver.solve(shifted);
    check(shifted_result.ok(), shifted_result.message);
    for (std::size_t y = 0; y < 5; ++y) {
        for (std::size_t x = 0; x < 5; ++x) {
            const std::size_t original = cell_index(grid, x, y, 0);
            const std::size_t translated = cell_index(grid, x + 2, y + 1, 0);
            for (std::size_t component = 0; component < 3; ++component) {
                check_close(shifted_result.solution.field_a_per_m[translated][component],
                            result_a.solution.field_a_per_m[original][component],
                            3.0e-10 * std::max(
                                1.0,
                                std::abs(result_a.solution.field_a_per_m[original][component])),
                            5.0e-13,
                            "union-grid translation covariance");
            }
        }
    }

    oe::Problem masked = a;
    std::fill(masked.target_mask.begin(), masked.target_mask.end(), 0);
    masked.target_mask[cell_index(grid, 7, 7, 0)] = 1;
    ++masked.target_mask_revision;
    masked.target_mask_digest = oe::canonical_mask_digest(masked.target_mask);
    refresh_certificate_and_snapshot(masked);
    oe::Solver masked_solver;
    const auto &masked_result = masked_solver.solve(masked);
    check(masked_result.ok(), masked_result.message);
    compare_fft_with_direct(masked, masked_result, "target-mask/no-wrap");
    for (std::size_t cell = 0; cell < checked_cells(grid); ++cell) {
        if (cell != cell_index(grid, 7, 7, 0)) {
            check(masked_result.solution.field_a_per_m[cell] == oe::Vector3{},
                  "crop must apply target mask only after convolution");
        }
    }
}

void cache_and_provenance_contract() {
    const oe::Grid grid{6, 6, 1, 0.8e-9, 1.2e-9, 2.0e-9,
                        {4.0e-9, -3.0e-9, 7.0e-9}};
    oe::Problem problem = plaquette_problem(grid, 0, 1, {2, 2, 0}, 1.0e-6);
    oe::Solver solver;
    const auto &first = solver.solve(problem);
    check(first.ok(), first.message);
    const auto first_cache = solver.cache_diagnostics();
    check(first_cache.plan_build_count == 1 && first_cache.kernel_build_count == 1,
          "first solve must build exactly one persistent 3-D plan and kernel set");
    check(first_cache.numerical_buffer_allocation_count == 1,
          "first solve must allocate one persistent numerical workspace set");
    check(first.solution.provenance.physical_shape ==
              std::array<std::size_t, 3>{6, 6, 1},
          "physical shape provenance mismatch");
    check(first.solution.provenance.padded_shape ==
              std::array<std::size_t, 3>{12, 12, 2},
          "padded shape provenance mismatch");
    check(first.solution.provenance.origin_m == grid.origin_m,
          "origin provenance mismatch");
    check(first.solution.provenance.near_far_cutoff == "none",
          "near/far cutoff provenance must be none");
    check(first.solution.provenance.inverse_normalization ==
              "one_over_Px_Py_Pz_once.v1",
          "inverse normalization provenance mismatch");
    check(first.solution.provenance.cache.resolved_field_cache_key_digest.rfind(
              "sha256:", 0) == 0,
          "resolved cache key must be a SHA-256 digest");

    counted_allocations.store(0U, std::memory_order_relaxed);
    allocation_counting_enabled.store(true, std::memory_order_relaxed);
    const auto &second = solver.solve(problem);
    allocation_counting_enabled.store(false, std::memory_order_relaxed);
    const std::size_t warm_allocations =
        counted_allocations.load(std::memory_order_relaxed);
    check(second.ok(), second.message);
    check(warm_allocations == 0U,
          "trusted immutable-snapshot warm hit must perform zero allocations");
    const auto second_cache = solver.cache_diagnostics();
    check(second_cache.resolved_field_hit_count == first_cache.resolved_field_hit_count + 1,
          "identical solve must hit resolved-field cache");
    check(second_cache.trusted_fast_path_hit_count ==
              first_cache.trusted_fast_path_hit_count + 1,
          "identical immutable object must use trusted preflight-free fast path");
    check(second_cache.plan_build_count == first_cache.plan_build_count &&
              second_cache.kernel_build_count == first_cache.kernel_build_count &&
              second_cache.numerical_buffer_allocation_count ==
                  first_cache.numerical_buffer_allocation_count,
          "cache hit must not allocate, replan or rebuild spectra");
    const auto &provenance = second.solution.provenance;
    check(provenance.trusted_snapshot_revision == problem.trusted_snapshot_revision &&
              provenance.trusted_snapshot_digest == problem.trusted_snapshot_digest &&
              provenance.envelope_revision == problem.envelope_revision &&
              provenance.envelope_digest == problem.envelope_digest &&
              provenance.stage_identity == problem.stage_identity &&
              provenance.evaluation_time_s == problem.evaluation_time_s &&
              provenance.evaluated_envelope_multiplier ==
                  problem.evaluated_envelope_multiplier &&
              provenance.source_identity == problem.source_identity &&
              provenance.closure_kind == problem.closure_certificate.closure_kind &&
              provenance.source_cuts.size() == 1U &&
              provenance.source_cuts[0].stable_id ==
                  problem.closure_certificate.source_cuts[0].stable_id &&
              provenance.source_cuts[0].component_label ==
                  problem.closure_certificate.source_cuts[0].component_label &&
              provenance.source_cuts[0].drive_id ==
                  problem.closure_certificate.source_cuts[0].drive_id &&
              provenance.source_cuts[0].drive_kind ==
                  problem.closure_certificate.source_cuts[0].drive_kind &&
              provenance.source_cuts[0].drive_si_unit ==
                  problem.closure_certificate.source_cuts[0].drive_si_unit &&
              provenance.source_cuts[0].digest ==
                  problem.closure_certificate.source_cuts[0].digest,
          "accepted provenance must retain every immutable source constituent");

    oe::Problem changed_source = problem;
    for (double &value : changed_source.face_current_density_a_per_m2.x) {
        value *= 2.0;
    }
    for (double &value : changed_source.face_current_density_a_per_m2.y) {
        value *= 2.0;
    }
    ++changed_source.face_current_revision;
    finalize_problem_identity(changed_source,
                              {0, x_face_index(grid, 3, 2, 0)});
    const auto &third = solver.solve(changed_source);
    check(third.ok(), third.message);
    const auto third_cache = solver.cache_diagnostics();
    check(third_cache.resolved_field_miss_count ==
              second_cache.resolved_field_miss_count + 1 &&
              third_cache.resolved_field_invalidation_count ==
                  second_cache.resolved_field_invalidation_count + 1,
          "source revision must invalidate resolved field");
    check(third_cache.plan_build_count == second_cache.plan_build_count &&
              third_cache.kernel_build_count == second_cache.kernel_build_count &&
              third_cache.numerical_buffer_allocation_count ==
                  second_cache.numerical_buffer_allocation_count,
          "source-only change must reuse plan, kernel spectra and buffers");
    const auto &third_hit = solver.solve(changed_source);
    check(third_hit.ok() && solver.cache_diagnostics().resolved_field_reused &&
              solver.cache_diagnostics().last_invalidation_reason.empty(),
          "current cache-hit diagnostics must clear a prior invalidation reason");

    oe::Problem changed_target = changed_source;
    changed_target.target_mask[0] = 0;
    ++changed_target.target_mask_revision;
    changed_target.target_mask_digest =
        oe::canonical_mask_digest(changed_target.target_mask);
    refresh_certificate_and_snapshot(changed_target);
    const auto &fourth = solver.solve(changed_target);
    check(fourth.ok(), fourth.message);
    const auto fourth_cache = solver.cache_diagnostics();
    check(fourth_cache.resolved_field_invalidation_count ==
              third_cache.resolved_field_invalidation_count + 1,
          "target-mask revision must invalidate resolved crop");
    check(fourth_cache.plan_build_count == third_cache.plan_build_count &&
              fourth_cache.kernel_build_count == third_cache.kernel_build_count,
          "target-mask change must reuse geometry-only plan and kernel spectra");

    oe::Problem changed_geometry = plaquette_problem(
        {6, 6, 1, 0.9e-9, 1.2e-9, 2.0e-9, grid.origin_m},
        0,
        1,
        {2, 2, 0},
        1.0e-6);
    changed_geometry.geometry_revision = changed_target.geometry_revision + 1;
    changed_geometry.geometry_digest =
        oe::canonical_geometry_digest(changed_geometry.grid);
    changed_geometry.closure_certificate.geometry_digest =
        changed_geometry.geometry_digest;
    refresh_certificate_and_snapshot(changed_geometry);
    const auto &fifth = solver.solve(changed_geometry);
    check(fifth.ok(), fifth.message);
    const auto fifth_cache = solver.cache_diagnostics();
    check(fifth_cache.plan_build_count == fourth_cache.plan_build_count + 1 &&
              fifth_cache.kernel_build_count == fourth_cache.kernel_build_count + 1 &&
              fifth_cache.numerical_buffer_allocation_count ==
                  fourth_cache.numerical_buffer_allocation_count + 1,
          "geometry revision must rebuild persistent numerical workspace");
}

void oriented_ampere_contour_contract() {
    const oe::Grid grid{16, 16, 16, 0.8e-9, 0.8e-9, 0.8e-9};
    constexpr double current_a = 2.0e-6;
    const auto positive = rectangular_current_loop_problem(
        grid, 3, 12, 4, 12, 8, current_a);
    oe::Solver positive_solver;
    const auto &positive_result = positive_solver.solve(positive);
    check(positive_result.ok(), positive_result.message);
    const double positive_integral = oriented_yz_contour_integral(
        grid, positive_result.solution.field_a_per_m, 8, 1, 7, 5, 11);
    check(positive_integral > 0.0,
          "positive x-current must give positive +x-oriented Ampere circulation");
    check_close(positive_integral,
                current_a,
                0.0,
                8.0e-2,
                "oriented Ampere contour must enclose the driven current");

    const auto negative = rectangular_current_loop_problem(
        grid, 3, 12, 4, 12, 8, -current_a);
    oe::Solver negative_solver;
    const auto &negative_result = negative_solver.solve(negative);
    check(negative_result.ok(), negative_result.message);
    const double negative_integral = oriented_yz_contour_integral(
        grid, negative_result.solution.field_a_per_m, 8, 1, 7, 5, 11);
    check(negative_integral < 0.0,
          "negative x-current must reverse the oriented Ampere circulation");
    check_close(negative_integral,
                -positive_integral,
                1.0e-15,
                2.0e-12,
                "oriented Ampere contour sign involution");
}

oe::Problem smooth_closed_current_problem(std::size_t n) {
    oe::Grid grid{n, n, n, 1.0 / static_cast<double>(n),
                  1.0 / static_cast<double>(n),
                  1.0 / static_cast<double>(n)};
    oe::Problem problem = zero_problem(grid);
    const std::size_t vertices_xy = (n + 1) * (n + 1);
    std::vector<double> psi((n + 1) * (n + 1) * n, 0.0);
    const auto psi_index = [n, vertices_xy](std::size_t x,
                                            std::size_t y,
                                            std::size_t z) {
        return z * vertices_xy + y * (n + 1) + x;
    };
    for (std::size_t z = 0; z < n; ++z) {
        const double zc = (static_cast<double>(z) + 0.5) / static_cast<double>(n);
        const double z_window = std::pow(std::sin(pi * zc), 4);
        for (std::size_t y = 0; y <= n; ++y) {
            const double yy = static_cast<double>(y) / static_cast<double>(n);
            for (std::size_t x = 0; x <= n; ++x) {
                const double xx = static_cast<double>(x) / static_cast<double>(n);
                psi[psi_index(x, y, z)] =
                    (x == 0 || x == n || y == 0 || y == n)
                        ? 0.0
                        : std::pow(std::sin(pi * xx), 4) *
                              std::pow(std::sin(pi * yy), 4) * z_window;
            }
        }
    }
    auto &faces = problem.face_current_density_a_per_m2;
    for (std::size_t z = 0; z < n; ++z) {
        for (std::size_t y = 0; y < n; ++y) {
            for (std::size_t x = 0; x <= n; ++x) {
                faces.x[x_face_index(grid, x, y, z)] =
                    (psi[psi_index(x, y + 1, z)] - psi[psi_index(x, y, z)]) /
                    grid.dy_m;
            }
        }
        for (std::size_t y = 0; y <= n; ++y) {
            for (std::size_t x = 0; x < n; ++x) {
                faces.y[y_face_index(grid, x, y, z)] =
                    -(psi[psi_index(x + 1, y, z)] - psi[psi_index(x, y, z)]) /
                    grid.dx_m;
            }
        }
    }
    finalize_problem_identity(problem, {0, x_face_index(grid, n / 2, n / 2, n / 2)});
    problem.closure_certificate.divergence_tolerance_a_per_m3 = 1.0e-9;
    problem.closure_certificate.measured_max_abs_divergence_a_per_m3 =
        max_abs_face_divergence(problem);
    refresh_certificate_and_snapshot(problem);
    return problem;
}

void diagnostics_and_refinement_contract() {
    std::array<double, 3> rho_div_j{};
    std::array<double, 3> rho_div_h{};
    std::array<double, 3> rho_ampere{};
    const std::array<std::size_t, 3> sizes{8, 16, 32};
    for (std::size_t level = 0; level < sizes.size(); ++level) {
        oe::Solver solver;
        const auto problem = smooth_closed_current_problem(sizes[level]);
        const auto &result = solver.solve(problem);
        check(result.ok(), "smooth refinement solve failed: " + result.message);
        check(result.solution.diagnostics.available,
              "smooth fixture must have a nonempty two-cell interior diagnostic set");
        const auto &d = result.solution.diagnostics;
        check(d.excluded_open_boundary_cells == 2,
              "diagnostics must exclude exactly two open-boundary cells");
        check(std::isfinite(d.rho_div_j) && std::isfinite(d.rho_div_h) &&
                  std::isfinite(d.rho_ampere),
              "differential residuals must be finite");
        rho_div_j[level] = d.rho_div_j;
        rho_div_h[level] = d.rho_div_h;
        rho_ampere[level] = d.rho_ampere;
    }

    check(rho_div_j[2] <= 2.0e-2, "finest reconstructed-current divergence gate");
    check(rho_div_h[2] <= 2.0e-2, "finest field-divergence gate");
    check(rho_ampere[2] <= 5.0e-2, "finest discrete Ampere gate");
    const double epsilon = std::numeric_limits<double>::epsilon();
    const auto check_order = [epsilon](const std::array<double, 3> &rho,
                                       const char *label) {
        if (rho[1] > 64.0 * epsilon && rho[2] > 64.0 * epsilon) {
            check(std::log2(rho[1] / rho[2]) >= 1.5,
                  std::string(label) + " refinement order must be at least 1.5");
        } else {
            check(rho[2] <= std::max(64.0 * epsilon, rho[1] + 4.0 * epsilon),
                  std::string(label) + " roundoff branch must be non-increasing");
        }
    };
    check_order(rho_div_j, "rho_div_j");
    check_order(rho_div_h, "rho_div_h");
    check_order(rho_ampere, "rho_ampere");

    oe::Problem full_target = smooth_closed_current_problem(8);
    oe::Solver full_solver;
    const auto &full_result = full_solver.solve(full_target);
    check(full_result.ok(), full_result.message);
    oe::Problem sparse_target = full_target;
    std::fill(sparse_target.target_mask.begin(), sparse_target.target_mask.end(), 0U);
    sparse_target.target_mask[cell_index(sparse_target.grid, 4, 4, 4)] = 1U;
    ++sparse_target.target_mask_revision;
    sparse_target.target_mask_digest =
        oe::canonical_mask_digest(sparse_target.target_mask);
    refresh_certificate_and_snapshot(sparse_target);
    oe::Solver sparse_solver;
    const auto &sparse_result = sparse_solver.solve(sparse_target);
    check(sparse_result.ok(), sparse_result.message);
    const auto &full_diagnostics = full_result.solution.diagnostics;
    const auto &sparse_diagnostics = sparse_result.solution.diagnostics;
    check(full_diagnostics.rho_div_j == sparse_diagnostics.rho_div_j &&
              full_diagnostics.rho_div_h == sparse_diagnostics.rho_div_h &&
              full_diagnostics.rho_ampere == sparse_diagnostics.rho_ampere &&
              full_diagnostics.divergence_current_rms_a_per_m3 ==
                  sparse_diagnostics.divergence_current_rms_a_per_m3 &&
              full_diagnostics.divergence_field_rms_a_per_m2 ==
                  sparse_diagnostics.divergence_field_rms_a_per_m2 &&
              full_diagnostics.curl_h_minus_j_rms_a_per_m2 ==
                  sparse_diagnostics.curl_h_minus_j_rms_a_per_m2,
          "diagnostics must be computed on the full union-grid field before crop");
    for (std::size_t cell = 0; cell < sparse_target.target_mask.size(); ++cell) {
        if (sparse_target.target_mask[cell] == 0U) {
            check(sparse_result.solution.field_a_per_m[cell] == oe::Vector3{},
                  "sparse target crop must zero unpublished field cells");
        }
    }
}

void negative_comparator_rejects_nonfinite_and_over_bound() {
    const auto accepts = [](double actual,
                            double expected,
                            double absolute_tolerance,
                            double relative_tolerance) {
        if (!std::isfinite(actual) || !std::isfinite(expected) ||
            !std::isfinite(absolute_tolerance) ||
            !std::isfinite(relative_tolerance)) {
            return false;
        }
        return std::abs(actual - expected) <=
               absolute_tolerance + relative_tolerance * std::abs(expected);
    };
    check(accepts(1.0, 1.0 + 1.0e-12, 2.0e-12, 1.0e-12),
          "finite comparator positive fixture");
    check(!accepts(std::numeric_limits<double>::quiet_NaN(), 1.0, 1.0, 1.0),
          "comparator must reject NaN");
    check(!accepts(std::numeric_limits<double>::infinity(), 1.0, 1.0, 1.0),
          "comparator must reject infinity");
    const double bound = 3.0e-12;
    const double over = std::nextafter(1.0 + bound,
                                       std::numeric_limits<double>::infinity());
    check(!accepts(over, 1.0, 2.0e-12, 1.0e-12),
          "comparator must reject first representable over-bound perturbation");
}

} // namespace

int main() {
    version_and_reconstruction_contract();
    kernel_contract_and_independent_oracle();
    failure_contract_is_fail_closed_before_planning();
    source_cut_certificate_contract();
    fft_matches_independent_direct_for_closed_loops();
    linearity_sign_translation_masks_and_no_wrap();
    oriented_ampere_contour_contract();
    cache_and_provenance_contract();
    diagnostics_and_refinement_contract();
    negative_comparator_rejects_nonfinite_and_over_bound();
    std::puts("PASS: native FDM CPU Oersted open-boundary FFT contract");
    return 0;
}
