#include "fft_plan_v1.hpp"
#include "oersted_internal_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <queue>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1 {
namespace {

struct PreflightResult {
    Status status = Status::invalid_argument;
    std::string message;
};

bool finite_vector(const std::vector<double> &values) {
    return std::all_of(values.begin(), values.end(), [](double value) {
        return std::isfinite(value);
    });
}

bool valid_mask(const std::vector<std::uint8_t> &mask) {
    return std::all_of(mask.begin(), mask.end(), [](std::uint8_t value) {
        return value == 0U || value == 1U;
    });
}

bool checked_multiply(std::size_t a, std::size_t b, std::size_t &result) {
    if (a != 0 && b > std::numeric_limits<std::size_t>::max() / a) {
        return false;
    }
    result = a * b;
    return true;
}

bool valid_exact_2n_workspace_shape(const Grid &grid) {
    const std::size_t maximum = std::numeric_limits<std::size_t>::max();
    if (grid.nx > maximum / 2U || grid.ny > maximum / 2U ||
        grid.nz > maximum / 2U) {
        return false;
    }
    const std::size_t px = 2U * grid.nx;
    const std::size_t py = 2U * grid.ny;
    const std::size_t pz = 2U * grid.nz;
    std::size_t plane = 0;
    std::size_t padded_cells = 0;
    std::size_t reduced_plane = 0;
    std::size_t reduced_cells = 0;
    return checked_multiply(px, py, plane) &&
           checked_multiply(plane, pz, padded_cells) &&
           checked_multiply(grid.nx + 1U, py, reduced_plane) &&
           checked_multiply(reduced_plane, pz, reduced_cells);
}

bool expected_face_sizes(const Grid &grid,
                         std::array<std::size_t, 3> &sizes) {
    std::size_t temporary = 0;
    if (!checked_multiply(grid.nx + 1U, grid.ny, temporary) ||
        !checked_multiply(temporary, grid.nz, sizes[0])) {
        return false;
    }
    if (!checked_multiply(grid.nx, grid.ny + 1U, temporary) ||
        !checked_multiply(temporary, grid.nz, sizes[1])) {
        return false;
    }
    if (!checked_multiply(grid.nx, grid.ny, temporary) ||
        !checked_multiply(temporary, grid.nz + 1U, sizes[2])) {
        return false;
    }
    return true;
}

std::array<std::size_t, 3> coordinates(const Grid &grid, std::size_t index) {
    const std::size_t x = index % grid.nx;
    index /= grid.nx;
    const std::size_t y = index % grid.ny;
    return {x, y, index / grid.ny};
}

std::vector<std::uint64_t> compute_component_labels(
    const Grid &grid,
    const std::vector<std::uint8_t> &mask,
    std::size_t &component_count) {
    const std::size_t cells = grid.nx * grid.ny * grid.nz;
    std::vector<std::uint64_t> labels(cells, inactive_component_label);
    component_count = 0;
    for (std::size_t seed = 0; seed < cells; ++seed) {
        if (mask[seed] == 0U || labels[seed] != inactive_component_label) {
            continue;
        }
        const std::uint64_t label = static_cast<std::uint64_t>(seed);
        ++component_count;
        std::queue<std::size_t> pending;
        pending.push(seed);
        labels[seed] = label;
        while (!pending.empty()) {
            const std::size_t current = pending.front();
            pending.pop();
            const auto c = coordinates(grid, current);
            for (std::size_t axis = 0; axis < 3; ++axis) {
                for (int direction : {-1, 1}) {
                    auto next = c;
                    const std::ptrdiff_t candidate =
                        static_cast<std::ptrdiff_t>(next[axis]) + direction;
                    const std::size_t extent =
                        axis == 0 ? grid.nx : (axis == 1 ? grid.ny : grid.nz);
                    if (candidate < 0 ||
                        candidate >= static_cast<std::ptrdiff_t>(extent)) {
                        continue;
                    }
                    next[axis] = static_cast<std::size_t>(candidate);
                    const std::size_t next_index =
                        detail::cell_index(grid, next[0], next[1], next[2]);
                    if (mask[next_index] != 0U &&
                        labels[next_index] == inactive_component_label) {
                        labels[next_index] = label;
                        pending.push(next_index);
                    }
                }
            }
        }
    }
    return labels;
}

class UnionFind {
  public:
    explicit UnionFind(std::size_t size) : parent_(size), rank_(size, 0U) {
        for (std::size_t index = 0; index < size; ++index) {
            parent_[index] = index;
        }
    }

    std::size_t find(std::size_t value) {
        while (parent_[value] != value) {
            parent_[value] = parent_[parent_[value]];
            value = parent_[value];
        }
        return value;
    }

    bool merge(std::size_t a, std::size_t b) {
        a = find(a);
        b = find(b);
        if (a == b) {
            return false;
        }
        if (rank_[a] < rank_[b]) {
            std::swap(a, b);
        }
        parent_[b] = a;
        if (rank_[a] == rank_[b]) {
            ++rank_[a];
        }
        return true;
    }

  private:
    std::vector<std::size_t> parent_;
    std::vector<std::uint8_t> rank_;
};

double face_area(const Grid &grid, std::size_t axis) {
    if (axis == 0) {
        return grid.dy_m * grid.dz_m;
    }
    if (axis == 1) {
        return grid.dx_m * grid.dz_m;
    }
    return grid.dx_m * grid.dy_m;
}

struct FaceTopologyAnalysis {
    Status status = Status::ok;
    std::string message;
    std::vector<double> component_exterior_current_a;
    std::vector<bool> component_has_nonzero_current;
    std::vector<bool> component_has_cycle;
};

FaceTopologyAnalysis analyze_face_topology(
    const Problem &problem,
    const std::vector<std::uint64_t> &labels,
    std::size_t component_count) {
    FaceTopologyAnalysis analysis;
    analysis.component_exterior_current_a.assign(component_count, 0.0);
    analysis.component_has_nonzero_current.assign(component_count, false);
    analysis.component_has_cycle.assign(component_count, false);
    std::vector<std::uint64_t> component_ids;
    component_ids.reserve(component_count);
    for (std::uint64_t label : labels) {
        if (label != inactive_component_label &&
            std::find(component_ids.begin(), component_ids.end(), label) ==
                component_ids.end()) {
            component_ids.push_back(label);
        }
    }
    const auto component_slot = [&component_ids](std::uint64_t label) {
        return static_cast<std::size_t>(
            std::find(component_ids.begin(), component_ids.end(), label) -
            component_ids.begin());
    };
    UnionFind current_graph(labels.size());

    const auto inspect_face = [&](std::size_t axis,
                                  double value,
                                  bool has_negative,
                                  std::size_t negative,
                                  bool has_positive,
                                  std::size_t positive,
                                  bool global_outer) -> bool {
        const bool negative_active =
            has_negative && problem.conductor_mask[negative] != 0U;
        const bool positive_active =
            has_positive && problem.conductor_mask[positive] != 0U;
        if (value == 0.0) {
            return true;
        }
        if (!negative_active && !positive_active) {
            analysis.status = Status::closure_failure;
            analysis.message = "inactive face carries nonzero current";
            return false;
        }
        if (!(negative_active && positive_active)) {
            analysis.status = global_outer ? Status::open_circuit
                                           : Status::closure_failure;
            analysis.message = global_outer
                                   ? "nonzero current crosses the outer union-grid boundary"
                                   : "nonzero current leaks across the conductor mask boundary";
            const std::size_t active = negative_active ? negative : positive;
            const std::size_t slot = component_slot(labels[active]);
            const double outward_sign = negative_active ? 1.0 : -1.0;
            analysis.component_exterior_current_a[slot] +=
                outward_sign * value * face_area(problem.grid, axis);
            return false;
        }
        const std::size_t slot = component_slot(labels[negative]);
        analysis.component_has_nonzero_current[slot] = true;
        if (!current_graph.merge(negative, positive)) {
            analysis.component_has_cycle[slot] = true;
        }
        return true;
    };

    for (std::size_t z = 0; z < problem.grid.nz; ++z) {
        for (std::size_t y = 0; y < problem.grid.ny; ++y) {
            for (std::size_t x = 0; x <= problem.grid.nx; ++x) {
                const bool has_negative = x > 0;
                const bool has_positive = x < problem.grid.nx;
                const std::size_t negative = has_negative
                                                 ? detail::cell_index(
                                                       problem.grid, x - 1U, y, z)
                                                 : 0U;
                const std::size_t positive = has_positive
                                                 ? detail::cell_index(
                                                       problem.grid, x, y, z)
                                                 : 0U;
                if (!inspect_face(0,
                                  problem.face_current_density_a_per_m2.x[
                                      detail::x_face_index(problem.grid, x, y, z)],
                                  has_negative,
                                  negative,
                                  has_positive,
                                  positive,
                                  x == 0 || x == problem.grid.nx)) {
                    return analysis;
                }
            }
        }
    }
    for (std::size_t z = 0; z < problem.grid.nz; ++z) {
        for (std::size_t y = 0; y <= problem.grid.ny; ++y) {
            for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                const bool has_negative = y > 0;
                const bool has_positive = y < problem.grid.ny;
                const std::size_t negative = has_negative
                                                 ? detail::cell_index(
                                                       problem.grid, x, y - 1U, z)
                                                 : 0U;
                const std::size_t positive = has_positive
                                                 ? detail::cell_index(
                                                       problem.grid, x, y, z)
                                                 : 0U;
                if (!inspect_face(1,
                                  problem.face_current_density_a_per_m2.y[
                                      detail::y_face_index(problem.grid, x, y, z)],
                                  has_negative,
                                  negative,
                                  has_positive,
                                  positive,
                                  y == 0 || y == problem.grid.ny)) {
                    return analysis;
                }
            }
        }
    }
    for (std::size_t z = 0; z <= problem.grid.nz; ++z) {
        for (std::size_t y = 0; y < problem.grid.ny; ++y) {
            for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                const bool has_negative = z > 0;
                const bool has_positive = z < problem.grid.nz;
                const std::size_t negative = has_negative
                                                 ? detail::cell_index(
                                                       problem.grid, x, y, z - 1U)
                                                 : 0U;
                const std::size_t positive = has_positive
                                                 ? detail::cell_index(
                                                       problem.grid, x, y, z)
                                                 : 0U;
                if (!inspect_face(2,
                                  problem.face_current_density_a_per_m2.z[
                                      detail::z_face_index(problem.grid, x, y, z)],
                                  has_negative,
                                  negative,
                                  has_positive,
                                  positive,
                                  z == 0 || z == problem.grid.nz)) {
                    return analysis;
                }
            }
        }
    }
    for (std::size_t component = 0; component < component_count; ++component) {
        if (analysis.component_has_nonzero_current[component] &&
            !analysis.component_has_cycle[component]) {
            analysis.status = Status::open_circuit;
            analysis.message = "driven conductor component has no contained return cycle";
            return analysis;
        }
    }
    return analysis;
}

double max_abs_divergence(const Problem &problem) {
    double maximum = 0.0;
    for (std::size_t z = 0; z < problem.grid.nz; ++z) {
        for (std::size_t y = 0; y < problem.grid.ny; ++y) {
            for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                const std::size_t cell = detail::cell_index(problem.grid, x, y, z);
                if (problem.conductor_mask[cell] == 0U) {
                    continue;
                }
                const double divergence =
                    (problem.face_current_density_a_per_m2.x[
                         detail::x_face_index(problem.grid, x + 1U, y, z)] -
                     problem.face_current_density_a_per_m2.x[
                         detail::x_face_index(problem.grid, x, y, z)]) /
                        problem.grid.dx_m +
                    (problem.face_current_density_a_per_m2.y[
                         detail::y_face_index(problem.grid, x, y + 1U, z)] -
                     problem.face_current_density_a_per_m2.y[
                         detail::y_face_index(problem.grid, x, y, z)]) /
                        problem.grid.dy_m +
                    (problem.face_current_density_a_per_m2.z[
                         detail::z_face_index(problem.grid, x, y, z + 1U)] -
                     problem.face_current_density_a_per_m2.z[
                         detail::z_face_index(problem.grid, x, y, z)]) /
                        problem.grid.dz_m;
                maximum = std::max(maximum, std::abs(divergence));
            }
        }
    }
    return maximum;
}

bool finite_grid(const Grid &grid) {
    return grid.dx_m > 0.0 && grid.dy_m > 0.0 && grid.dz_m > 0.0 &&
           std::isfinite(grid.dx_m) && std::isfinite(grid.dy_m) &&
           std::isfinite(grid.dz_m) &&
           std::all_of(grid.origin_m.begin(), grid.origin_m.end(), [](double value) {
               return std::isfinite(value);
           });
}

struct DecodedInternalFace {
    std::size_t axis = 0;
    std::size_t local_index = 0;
    std::size_t negative_cell = 0;
    std::size_t positive_cell = 0;
    double density_a_per_m2 = 0.0;
};

bool decode_internal_face(const Problem &problem,
                          std::uint64_t flat_id,
                          DecodedInternalFace &decoded) {
    const std::uint64_t x_count = static_cast<std::uint64_t>(
        (problem.grid.nx + 1U) * problem.grid.ny * problem.grid.nz);
    const std::uint64_t y_count = static_cast<std::uint64_t>(
        problem.grid.nx * (problem.grid.ny + 1U) * problem.grid.nz);
    const std::uint64_t z_count = static_cast<std::uint64_t>(
        problem.grid.nx * problem.grid.ny * (problem.grid.nz + 1U));
    if (flat_id < x_count) {
        const std::size_t local = static_cast<std::size_t>(flat_id);
        const std::size_t x = local % (problem.grid.nx + 1U);
        if (x == 0 || x >= problem.grid.nx) {
            return false;
        }
        const std::size_t yz = local / (problem.grid.nx + 1U);
        const std::size_t y = yz % problem.grid.ny;
        const std::size_t z = yz / problem.grid.ny;
        decoded = {0,
                   local,
                   detail::cell_index(problem.grid, x - 1U, y, z),
                   detail::cell_index(problem.grid, x, y, z),
                   problem.face_current_density_a_per_m2.x[local]};
        return true;
    }
    if (flat_id < x_count + y_count) {
        const std::size_t local = static_cast<std::size_t>(flat_id - x_count);
        const std::size_t y = (local / problem.grid.nx) % (problem.grid.ny + 1U);
        if (y == 0 || y >= problem.grid.ny) {
            return false;
        }
        const std::size_t x = local % problem.grid.nx;
        const std::size_t z = local / (problem.grid.nx * (problem.grid.ny + 1U));
        decoded = {1,
                   local,
                   detail::cell_index(problem.grid, x, y - 1U, z),
                   detail::cell_index(problem.grid, x, y, z),
                   problem.face_current_density_a_per_m2.y[local]};
        return true;
    }
    if (flat_id < x_count + y_count + z_count) {
        const std::size_t local = static_cast<std::size_t>(flat_id - x_count - y_count);
        const std::size_t z = local / (problem.grid.nx * problem.grid.ny);
        if (z == 0 || z >= problem.grid.nz) {
            return false;
        }
        const std::size_t xy = local % (problem.grid.nx * problem.grid.ny);
        const std::size_t x = xy % problem.grid.nx;
        const std::size_t y = xy / problem.grid.nx;
        decoded = {2,
                   local,
                   detail::cell_index(problem.grid, x, y, z - 1U),
                   detail::cell_index(problem.grid, x, y, z),
                   problem.face_current_density_a_per_m2.z[local]};
        return true;
    }
    return false;
}

PreflightResult preflight(const Problem &problem) {
    bool cell_count_ok = false;
    const std::size_t cells = detail::checked_cell_count(problem.grid, cell_count_ok);
    if (!cell_count_ok || !finite_grid(problem.grid) ||
        !valid_exact_2n_workspace_shape(problem.grid)) {
        return {Status::invalid_argument, "invalid or overflowing union grid"};
    }
    if (std::any_of(problem.grid.boundaries.begin(),
                    problem.grid.boundaries.end(),
                    [](AxisBoundary boundary) {
                        return boundary != AxisBoundary::open;
                    })) {
        return {Status::periodic_unsupported,
                "fdm_oersted_cell_integrated_open.v1 rejects every periodic axis"};
    }
    if (problem.conductor_mask.size() != cells || problem.target_mask.size() != cells) {
        return {Status::shape_mismatch, "conductor/target mask shape mismatch"};
    }
    if (!valid_mask(problem.conductor_mask) || !valid_mask(problem.target_mask) ||
        std::none_of(problem.conductor_mask.begin(), problem.conductor_mask.end(),
                     [](std::uint8_t value) { return value != 0U; }) ||
        std::none_of(problem.target_mask.begin(), problem.target_mask.end(),
                     [](std::uint8_t value) { return value != 0U; })) {
        return {Status::invalid_argument,
                "conductor and target masks must be nonempty Boolean arrays"};
    }
    std::array<std::size_t, 3> face_sizes{};
    if (!expected_face_sizes(problem.grid, face_sizes) ||
        problem.face_current_density_a_per_m2.x.size() != face_sizes[0] ||
        problem.face_current_density_a_per_m2.y.size() != face_sizes[1] ||
        problem.face_current_density_a_per_m2.z.size() != face_sizes[2]) {
        return {Status::shape_mismatch, "oriented face-current shape mismatch"};
    }
    if (!finite_vector(problem.face_current_density_a_per_m2.x) ||
        !finite_vector(problem.face_current_density_a_per_m2.y) ||
        !finite_vector(problem.face_current_density_a_per_m2.z) ||
        !std::isfinite(problem.evaluation_time_s) ||
        !std::isfinite(problem.evaluated_envelope_multiplier)) {
        return {Status::nonfinite_input, "non-finite current or source identity value"};
    }
    if (problem.geometry_revision == 0 || problem.conductor_mask_revision == 0 ||
        problem.target_mask_revision == 0 || problem.face_current_revision == 0 ||
        problem.envelope_revision == 0 || problem.stage_identity == 0 ||
        problem.trusted_snapshot_revision == 0 ||
        problem.trusted_snapshot_digest.empty() || problem.source_identity.empty() ||
        problem.envelope_digest.empty()) {
        return {Status::invalid_argument, "missing source/mask/geometry revision identity"};
    }
    if (problem.geometry_digest != canonical_geometry_digest(problem.grid) ||
        problem.conductor_mask_digest != canonical_mask_digest(problem.conductor_mask) ||
        problem.target_mask_digest != canonical_mask_digest(problem.target_mask) ||
        problem.face_current_digest !=
            canonical_face_current_digest(problem.face_current_density_a_per_m2)) {
        return {Status::stale_certificate, "declared source or geometry digest is stale"};
    }
    if (problem.trusted_snapshot_revision != problem.face_current_revision ||
        problem.trusted_snapshot_digest != canonical_trusted_snapshot_digest(problem)) {
        return {Status::stale_certificate,
                "trusted immutable snapshot identity is stale"};
    }

    const auto &certificate = problem.closure_certificate;
    if (certificate.version.empty()) {
        return {Status::missing_certificate,
                "global_closed_current_certificate.v1 is required"};
    }
    if (certificate.version != certificate_version || certificate.revision == 0 ||
        certificate.digest.empty()) {
        return {Status::missing_certificate,
                "missing or unsupported global closed-current certificate"};
    }
    if (certificate.geometry_digest != problem.geometry_digest ||
        certificate.conductor_mask_revision != problem.conductor_mask_revision ||
        certificate.conductor_mask_digest != problem.conductor_mask_digest ||
        certificate.face_current_revision != problem.face_current_revision ||
        certificate.face_current_digest != problem.face_current_digest ||
        certificate.revision != problem.face_current_revision ||
        certificate.digest != canonical_certificate_digest(certificate)) {
        return {Status::stale_certificate,
                "closure certificate does not bind the exact source snapshot"};
    }
    if (!certificate.global_continuity_passed || !certificate.exterior_flux_passed ||
        !certificate.component_flux_passed || !certificate.return_path_complete ||
        !(certificate.divergence_tolerance_a_per_m3 >= 0.0) ||
        !(certificate.exterior_current_tolerance_a >= 0.0) ||
        !std::isfinite(certificate.divergence_tolerance_a_per_m3) ||
        !std::isfinite(certificate.exterior_current_tolerance_a) ||
        !std::isfinite(certificate.measured_max_abs_divergence_a_per_m3)) {
        return {Status::closure_failure, "certificate reports a failed closure gate"};
    }

    std::size_t component_count = 0;
    const auto labels =
        compute_component_labels(problem.grid, problem.conductor_mask, component_count);
    if (certificate.component_count != component_count ||
        certificate.component_labels != labels ||
        certificate.measured_component_exterior_current_a.size() != component_count ||
        !finite_vector(certificate.measured_component_exterior_current_a)) {
        return {Status::stale_certificate,
                "certificate component labels or exterior-current vector are stale"};
    }
    const auto topology = analyze_face_topology(problem, labels, component_count);
    if (topology.status != Status::ok) {
        return {topology.status, topology.message};
    }
    const double measured_divergence = max_abs_divergence(problem);
    if (measured_divergence > certificate.divergence_tolerance_a_per_m3) {
        return {Status::closure_failure,
                "oriented finite-volume divergence exceeds certificate tolerance"};
    }
    const double comparison_scale =
        std::max({1.0,
                  std::abs(measured_divergence),
                  std::abs(certificate.measured_max_abs_divergence_a_per_m3)});
    if (std::abs(measured_divergence -
                 certificate.measured_max_abs_divergence_a_per_m3) >
        64.0 * std::numeric_limits<double>::epsilon() * comparison_scale) {
        return {Status::stale_certificate,
                "certificate divergence measurement does not match the face field"};
    }
    for (std::size_t component = 0; component < component_count; ++component) {
        if (std::abs(topology.component_exterior_current_a[component]) >
                certificate.exterior_current_tolerance_a ||
            std::abs(certificate.measured_component_exterior_current_a[component] -
                     topology.component_exterior_current_a[component]) >
                64.0 * std::numeric_limits<double>::epsilon() *
                    std::max(1.0,
                             std::abs(topology.component_exterior_current_a[component]))) {
            return {Status::closure_failure,
                    "component exterior-current certificate failed"};
        }
    }

    switch (certificate.closure_kind) {
    case ClosureKind::closed_geometry:
    case ClosureKind::certified_import:
        break;
    default:
        return {Status::closure_failure, "unsupported closure kind"};
    }

    const bool driven = std::any_of(topology.component_has_nonzero_current.begin(),
                                    topology.component_has_nonzero_current.end(),
                                    [](bool value) { return value; });
    if (driven) {
        if (certificate.closure_kind == ClosureKind::closed_geometry) {
            const std::size_t driven_components = static_cast<std::size_t>(
                std::count(topology.component_has_nonzero_current.begin(),
                           topology.component_has_nonzero_current.end(),
                           true));
            if (certificate.source_cuts.size() != driven_components) {
                return {Status::open_circuit,
                        "every driven component requires exactly one explicit source_cut"};
            }

            std::vector<std::uint64_t> component_ids;
            component_ids.reserve(component_count);
            for (std::uint64_t label : labels) {
                if (label != inactive_component_label &&
                    std::find(component_ids.begin(), component_ids.end(), label) ==
                        component_ids.end()) {
                    component_ids.push_back(label);
                }
            }
            std::vector<bool> covered(component_count, false);
            std::vector<std::string_view> stable_ids;
            std::vector<std::string_view> drive_ids;
            stable_ids.reserve(certificate.source_cuts.size());
            drive_ids.reserve(certificate.source_cuts.size());
            for (const SourceCutRecord &cut : certificate.source_cuts) {
                const auto component_it =
                    std::find(component_ids.begin(), component_ids.end(), cut.component_label);
                const bool base_identity_valid =
                    !cut.stable_id.empty() && !cut.drive_id.empty() &&
                    cut.drive_kind == "impressed_potential_jump.v1" &&
                    cut.drive_si_unit == "V" &&
                    cut.revision == problem.face_current_revision &&
                    cut.ordered_internal_face_ids.size() >= 2U &&
                    cut.ordered_internal_face_ids.size() % 2U == 0U &&
                    cut.ordered_internal_face_ids.size() == cut.ordered_normals.size() &&
                    std::isfinite(cut.drive_value) && cut.drive_value != 0.0 &&
                    cut.digest == canonical_source_cut_digest(cut) &&
                    component_it != component_ids.end();
                if (!base_identity_valid) {
                    return {Status::closure_failure,
                            "source_cut identity, drive type, revision or digest is invalid"};
                }
                const std::size_t component = static_cast<std::size_t>(
                    component_it - component_ids.begin());
                if (!topology.component_has_nonzero_current[component] ||
                    covered[component] ||
                    std::find(stable_ids.begin(), stable_ids.end(), cut.stable_id) !=
                        stable_ids.end() ||
                    std::find(drive_ids.begin(), drive_ids.end(), cut.drive_id) !=
                        drive_ids.end()) {
                    return {Status::closure_failure,
                            "source_cut must uniquely cover one driven component"};
                }
                for (std::size_t pair = 0;
                     pair < cut.ordered_internal_face_ids.size();
                     pair += 2U) {
                    DecodedInternalFace first;
                    DecodedInternalFace second;
                    if (cut.ordered_internal_face_ids[pair] !=
                            cut.ordered_internal_face_ids[pair + 1U] ||
                        cut.ordered_normals[pair] != -cut.ordered_normals[pair + 1U] ||
                        (cut.ordered_normals[pair] != -1 &&
                         cut.ordered_normals[pair] != 1) ||
                        !decode_internal_face(
                            problem, cut.ordered_internal_face_ids[pair], first) ||
                        !decode_internal_face(
                            problem, cut.ordered_internal_face_ids[pair + 1U], second) ||
                        first.axis != second.axis ||
                        first.local_index != second.local_index ||
                        problem.conductor_mask[first.negative_cell] == 0U ||
                        problem.conductor_mask[first.positive_cell] == 0U ||
                        labels[first.negative_cell] != cut.component_label ||
                        labels[first.positive_cell] != cut.component_label ||
                        first.density_a_per_m2 == 0.0 ||
                        !std::isfinite(first.density_a_per_m2)) {
                        return {Status::closure_failure,
                                "source_cut trace is not a paired nonzero internal face"};
                    }
                }
                covered[component] = true;
                stable_ids.push_back(cut.stable_id);
                drive_ids.push_back(cut.drive_id);
            }
            for (std::size_t component = 0; component < component_count; ++component) {
                if (topology.component_has_nonzero_current[component] &&
                    !covered[component]) {
                    return {Status::open_circuit,
                            "driven component is missing a typed source_cut"};
                }
            }
        } else if (certificate.closure_kind == ClosureKind::certified_import) {
            if (certificate.imported_certification_method.empty() ||
                certificate.imported_field_digest.empty()) {
                return {Status::closure_failure,
                        "certified import requires method and immutable field digest"};
            }
        }
    } else if (!certificate.source_cuts.empty()) {
        return {Status::closure_failure,
                "zero-current snapshot must not carry source_cut records"};
    }
    return {Status::ok, {}};
}

std::string kernel_plan_key(const Problem &problem) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oersted_kernel_plan_cache_key.v1");
    bytes.text(formula_version);
    bytes.text(operator_version);
    bytes.text(realization_version);
    bytes.text(engine_version);
    bytes.text(kernel_policy_version);
    bytes.text(exact_zero_policy_version);
    bytes.text(problem.geometry_digest);
    bytes.u64(problem.geometry_revision);
    bytes.text("x-fastest");
    bytes.text("r2c-[Pz][Py][Px/2+1]-x-contiguous");
    bytes.text("one_over_Px_Py_Pz_once.v1");
    bytes.text("fp64");
    return detail::sha256_digest(bytes.data());
}

std::string resolved_field_key(const Problem &problem,
                               std::string_view kernel_key) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oersted_resolved_field_cache_key.v1");
    bytes.text(kernel_key);
    bytes.text(problem.geometry_digest);
    bytes.u64(problem.geometry_revision);
    bytes.text(problem.conductor_mask_digest);
    bytes.u64(problem.conductor_mask_revision);
    bytes.text(problem.target_mask_digest);
    bytes.u64(problem.target_mask_revision);
    bytes.text(problem.face_current_digest);
    bytes.u64(problem.face_current_revision);
    bytes.text(problem.closure_certificate.digest);
    bytes.u64(problem.closure_certificate.revision);
    bytes.u64(static_cast<std::uint64_t>(problem.closure_certificate.source_cuts.size()));
    for (const SourceCutRecord &cut : problem.closure_certificate.source_cuts) {
        bytes.text(cut.stable_id);
        bytes.text(cut.digest);
    }
    bytes.text(problem.source_identity);
    bytes.u64(problem.envelope_revision);
    bytes.text(problem.envelope_digest);
    bytes.u64(problem.stage_identity);
    bytes.f64(problem.evaluation_time_s);
    bytes.f64(problem.evaluated_envelope_multiplier);
    bytes.u64(problem.trusted_snapshot_revision);
    bytes.text(problem.trusted_snapshot_digest);
    return detail::sha256_digest(bytes.data());
}

class FftWorkspace {
  public:
    explicit FftWorkspace(const Problem &problem)
        : grid_(problem.grid), padded_(detail::padded_shape(grid_)),
          px_(padded_[0]), py_(padded_[1]), pz_(padded_[2]),
          padded_cells_(px_ * py_ * pz_), reduced_x_(px_ / 2U + 1U),
          reduced_cells_(reduced_x_ * py_ * pz_), plan_(px_, py_, pz_),
          full_buffer_(padded_cells_) {
        for (auto &spectrum : kernel_spectrum_) {
            spectrum.resize(reduced_cells_);
        }
        for (auto &spectrum : current_spectrum_) {
            spectrum.resize(reduced_cells_);
        }
        for (auto &spectrum : field_spectrum_) {
            spectrum.resize(reduced_cells_);
        }
        build_kernel_spectra();
    }

    void convolve(const std::vector<Vector3> &cell_current,
                  const std::vector<std::uint8_t> &target_mask,
                  std::vector<Vector3> &full_field,
                  std::vector<Vector3> &published_field) {
        const std::size_t physical_cells = grid_.nx * grid_.ny * grid_.nz;
        if (cell_current.size() != physical_cells || target_mask.size() != physical_cells) {
            throw std::invalid_argument("Oersted workspace physical shape mismatch");
        }
        full_field.resize(physical_cells);
        published_field.resize(physical_cells);
        std::fill(full_field.begin(), full_field.end(), Vector3{});
        std::fill(published_field.begin(), published_field.end(), Vector3{});
        for (std::size_t component = 0; component < 3; ++component) {
            std::fill(full_buffer_.begin(), full_buffer_.end(), detail::Complex{});
            for (std::size_t z = 0; z < grid_.nz; ++z) {
                for (std::size_t y = 0; y < grid_.ny; ++y) {
                    for (std::size_t x = 0; x < grid_.nx; ++x) {
                        const std::size_t physical = detail::cell_index(grid_, x, y, z);
                        full_buffer_[full_index(x, y, z)] =
                            detail::Complex(cell_current[physical][component], 0.0);
                    }
                }
            }
            plan_.transform(full_buffer_, false);
            copy_full_to_reduced(full_buffer_, current_spectrum_[component]);
        }

        for (std::size_t index = 0; index < reduced_cells_; ++index) {
            const auto &jx = current_spectrum_[0][index];
            const auto &jy = current_spectrum_[1][index];
            const auto &jz = current_spectrum_[2][index];
            const auto &kx = kernel_spectrum_[0][index];
            const auto &ky = kernel_spectrum_[1][index];
            const auto &kz = kernel_spectrum_[2][index];
            field_spectrum_[0][index] = jy * kz - jz * ky;
            field_spectrum_[1][index] = -jx * kz + jz * kx;
            field_spectrum_[2][index] = jx * ky - jy * kx;
        }

        const double normalization = 1.0 / static_cast<double>(padded_cells_);
        for (std::size_t component = 0; component < 3; ++component) {
            reconstruct_full_from_reduced(field_spectrum_[component], full_buffer_);
            plan_.transform(full_buffer_, true);
            for (std::size_t z = 0; z < grid_.nz; ++z) {
                for (std::size_t y = 0; y < grid_.ny; ++y) {
                    for (std::size_t x = 0; x < grid_.nx; ++x) {
                        const std::size_t physical = detail::cell_index(grid_, x, y, z);
                        const detail::Complex value =
                            full_buffer_[full_index(x, y, z)] * normalization;
                        const double imaginary_budget =
                            4096.0 * std::numeric_limits<double>::epsilon() *
                            std::max(1.0, std::abs(value.real()));
                        if (!std::isfinite(value.real()) || !std::isfinite(value.imag()) ||
                            std::abs(value.imag()) > imaginary_budget) {
                            throw std::runtime_error(
                                "inverse Oersted FFT is non-finite or non-real");
                        }
                        full_field[physical][component] = value.real();
                    }
                }
            }
        }
        for (std::size_t physical = 0; physical < physical_cells; ++physical) {
            if (target_mask[physical] != 0U) {
                published_field[physical] = full_field[physical];
            }
        }
    }

    const std::array<std::size_t, 3> &padded() const noexcept { return padded_; }

  private:
    std::size_t full_index(std::size_t x,
                           std::size_t y,
                           std::size_t z) const noexcept {
        return (z * py_ + y) * px_ + x;
    }

    std::size_t reduced_index(std::size_t x,
                              std::size_t y,
                              std::size_t z) const noexcept {
        return (z * py_ + y) * reduced_x_ + x;
    }

    static std::ptrdiff_t displacement(std::size_t q,
                                       std::size_t physical,
                                       std::size_t padded) noexcept {
        if (q < physical) {
            return static_cast<std::ptrdiff_t>(q);
        }
        if (q == physical) {
            return 0;
        }
        return static_cast<std::ptrdiff_t>(q) -
               static_cast<std::ptrdiff_t>(padded);
    }

    bool is_full_self_conjugate(std::size_t x,
                                std::size_t y,
                                std::size_t z) const noexcept {
        return (x == 0 || x == px_ / 2U) &&
               (y == 0 || y == py_ / 2U) &&
               (z == 0 || z == pz_ / 2U);
    }

    void copy_full_to_reduced(const std::vector<detail::Complex> &full,
                              std::vector<detail::Complex> &reduced) const {
        for (std::size_t z = 0; z < pz_; ++z) {
            for (std::size_t y = 0; y < py_; ++y) {
                for (std::size_t x = 0; x < reduced_x_; ++x) {
                    reduced[reduced_index(x, y, z)] = full[full_index(x, y, z)];
                }
            }
        }
    }

    void reconstruct_full_from_reduced(
        const std::vector<detail::Complex> &reduced,
        std::vector<detail::Complex> &full) const {
        for (std::size_t z = 0; z < pz_; ++z) {
            for (std::size_t y = 0; y < py_; ++y) {
                for (std::size_t x = 0; x < px_; ++x) {
                    if (x < reduced_x_) {
                        full[full_index(x, y, z)] =
                            reduced[reduced_index(x, y, z)];
                    } else {
                        const std::size_t mirror_x = px_ - x;
                        const std::size_t mirror_y = (py_ - y) % py_;
                        const std::size_t mirror_z = (pz_ - z) % pz_;
                        full[full_index(x, y, z)] = std::conj(
                            reduced[reduced_index(mirror_x, mirror_y, mirror_z)]);
                    }
                }
            }
        }
    }

    void build_kernel_spectra() {
        for (std::size_t component = 0; component < 3; ++component) {
            std::fill(full_buffer_.begin(), full_buffer_.end(), detail::Complex{});
            for (std::size_t z = 0; z < pz_; ++z) {
                for (std::size_t y = 0; y < py_; ++y) {
                    for (std::size_t x = 0; x < px_; ++x) {
                        if (x == grid_.nx || y == grid_.ny || z == grid_.nz) {
                            continue;
                        }
                        const auto kernel = cell_integrated_kernel_m(
                            grid_,
                            {displacement(x, grid_.nx, px_),
                             displacement(y, grid_.ny, py_),
                             displacement(z, grid_.nz, pz_)});
                        if (!std::isfinite(kernel[component])) {
                            throw std::runtime_error("non-finite Oersted kernel entry");
                        }
                        full_buffer_[full_index(x, y, z)] =
                            detail::Complex(kernel[component], 0.0);
                    }
                }
            }
            plan_.transform(full_buffer_, false);
            double spectral_scale = 0.0;
            for (const detail::Complex &value : full_buffer_) {
                if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
                    throw std::runtime_error(
                        "non-finite Oersted kernel spectrum");
                }
                spectral_scale = std::max(spectral_scale, std::abs(value));
            }
            const double spectral_tolerance =
                8192.0 * std::numeric_limits<double>::epsilon() * spectral_scale;
            for (std::size_t z = 0; z < pz_; ++z) {
                for (std::size_t y = 0; y < py_; ++y) {
                    for (std::size_t x = 0; x < px_; ++x) {
                        const detail::Complex value =
                            full_buffer_[full_index(x, y, z)];
                        const detail::Complex mirror = std::conj(full_buffer_[
                            full_index((px_ - x) % px_,
                                       (py_ - y) % py_,
                                       (pz_ - z) % pz_)]);
                        if (std::abs(value - mirror) > spectral_tolerance ||
                            std::abs(value.real()) > spectral_tolerance ||
                            (is_full_self_conjugate(x, y, z) &&
                             std::abs(value) > spectral_tolerance)) {
                            throw std::runtime_error(
                                "Oersted kernel spectrum violates Hermitian, odd or "
                                "self-conjugate-zero consistency");
                        }
                    }
                }
            }
            copy_full_to_reduced(full_buffer_, kernel_spectrum_[component]);
            for (std::size_t z = 0; z < pz_; ++z) {
                for (std::size_t y = 0; y < py_; ++y) {
                    for (std::size_t x = 0; x < reduced_x_; ++x) {
                        detail::Complex &value =
                            kernel_spectrum_[component][reduced_index(x, y, z)];
                        if (!std::isfinite(value.real()) ||
                            !std::isfinite(value.imag())) {
                            throw std::runtime_error(
                                "non-finite Oersted kernel spectrum");
                        }
                        if (is_full_self_conjugate(x, y, z)) {
                            value = detail::Complex(0.0, 0.0);
                        } else {
                            value = detail::Complex(0.0, value.imag());
                        }
                    }
                }
            }
            for (std::size_t x : {std::size_t{0}, px_ / 2U}) {
                for (std::size_t z = 0; z < pz_; ++z) {
                    for (std::size_t y = 0; y < py_; ++y) {
                        const std::size_t mirror_y = (py_ - y) % py_;
                        const std::size_t mirror_z = (pz_ - z) % pz_;
                        const std::size_t index = reduced_index(x, y, z);
                        const std::size_t mirror_index =
                            reduced_index(x, mirror_y, mirror_z);
                        if (index > mirror_index) {
                            continue;
                        }
                        if (index == mirror_index) {
                            kernel_spectrum_[component][index] =
                                detail::Complex(0.0, 0.0);
                            continue;
                        }
                        const double imaginary =
                            0.5 * (kernel_spectrum_[component][index].imag() -
                                   kernel_spectrum_[component][mirror_index].imag());
                        kernel_spectrum_[component][index] =
                            detail::Complex(0.0, imaginary);
                        kernel_spectrum_[component][mirror_index] =
                            detail::Complex(0.0, -imaginary);
                    }
                }
            }
        }
    }

    Grid grid_;
    std::array<std::size_t, 3> padded_{};
    std::size_t px_ = 0;
    std::size_t py_ = 0;
    std::size_t pz_ = 0;
    std::size_t padded_cells_ = 0;
    std::size_t reduced_x_ = 0;
    std::size_t reduced_cells_ = 0;
    detail::Fft3dPlan plan_;
    std::array<std::vector<detail::Complex>, 3> kernel_spectrum_;
    std::array<std::vector<detail::Complex>, 3> current_spectrum_;
    std::array<std::vector<detail::Complex>, 3> field_spectrum_;
    std::vector<detail::Complex> full_buffer_;
};

void fill_provenance(const Problem &problem,
                     const FftWorkspace &workspace,
                     const CacheDiagnostics &cache,
                     Provenance &provenance) {
    provenance.physical_shape = {problem.grid.nx, problem.grid.ny, problem.grid.nz};
    provenance.padded_shape = workspace.padded();
    provenance.origin_m = problem.grid.origin_m;
    provenance.spacing_m = {problem.grid.dx_m, problem.grid.dy_m, problem.grid.dz_m};
    provenance.geometry_revision = problem.geometry_revision;
    provenance.conductor_mask_revision = problem.conductor_mask_revision;
    provenance.target_mask_revision = problem.target_mask_revision;
    provenance.face_current_revision = problem.face_current_revision;
    provenance.certificate_revision = problem.closure_certificate.revision;
    provenance.trusted_snapshot_revision = problem.trusted_snapshot_revision;
    provenance.envelope_revision = problem.envelope_revision;
    provenance.stage_identity = problem.stage_identity;
    provenance.evaluation_time_s = problem.evaluation_time_s;
    provenance.evaluated_envelope_multiplier =
        problem.evaluated_envelope_multiplier;
    provenance.closure_kind = problem.closure_certificate.closure_kind;
    provenance.geometry_digest = problem.geometry_digest;
    provenance.conductor_mask_digest = problem.conductor_mask_digest;
    provenance.target_mask_digest = problem.target_mask_digest;
    provenance.face_current_digest = problem.face_current_digest;
    provenance.certificate_digest = problem.closure_certificate.digest;
    provenance.trusted_snapshot_digest = problem.trusted_snapshot_digest;
    provenance.source_identity = problem.source_identity;
    provenance.envelope_digest = problem.envelope_digest;
    provenance.imported_certification_method =
        problem.closure_certificate.imported_certification_method;
    provenance.imported_field_digest =
        problem.closure_certificate.imported_field_digest;
    provenance.source_cuts = problem.closure_certificate.source_cuts;
    provenance.cache = cache;
}

} // namespace

Status reconstruct_face_to_cell(const Grid &grid,
                                const std::vector<std::uint8_t> &conductor_mask,
                                const FaceCurrentDensity &face_current,
                                std::vector<Vector3> &cell_current,
                                std::string &message) {
    bool count_ok = false;
    const std::size_t cells = detail::checked_cell_count(grid, count_ok);
    if (!count_ok || !finite_grid(grid)) {
        message = "invalid union grid";
        return Status::invalid_argument;
    }
    if (conductor_mask.size() != cells || !valid_mask(conductor_mask)) {
        message = "conductor mask shape/value mismatch";
        return Status::shape_mismatch;
    }
    std::array<std::size_t, 3> face_sizes{};
    if (!expected_face_sizes(grid, face_sizes) || face_current.x.size() != face_sizes[0] ||
        face_current.y.size() != face_sizes[1] ||
        face_current.z.size() != face_sizes[2]) {
        message = "face-current shape mismatch";
        return Status::shape_mismatch;
    }
    if (!finite_vector(face_current.x) || !finite_vector(face_current.y) ||
        !finite_vector(face_current.z)) {
        message = "face current contains NaN/Inf";
        return Status::nonfinite_input;
    }
    cell_current.resize(cells);
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t cell = detail::cell_index(grid, x, y, z);
                if (conductor_mask[cell] == 0U) {
                    cell_current[cell] = {};
                    continue;
                }
                cell_current[cell] = {
                    0.5 * (face_current.x[detail::x_face_index(grid, x, y, z)] +
                           face_current.x[detail::x_face_index(grid, x + 1U, y, z)]),
                    0.5 * (face_current.y[detail::y_face_index(grid, x, y, z)] +
                           face_current.y[detail::y_face_index(grid, x, y + 1U, z)]),
                    0.5 * (face_current.z[detail::z_face_index(grid, x, y, z)] +
                           face_current.z[detail::z_face_index(grid, x, y, z + 1U)]),
                };
            }
        }
    }
    message.clear();
    return Status::ok;
}

class Solver::Impl {
  public:
    const SolveResult &solve(const Problem &problem) {
        cache_.resolved_field_reused = false;
        cache_.last_invalidation_reason.clear();
        if (accepted_problem_ == &problem && accepted_result_.ok() &&
            problem.trusted_snapshot_revision == accepted_snapshot_revision_ &&
            problem.trusted_snapshot_digest == accepted_snapshot_digest_) {
            ++cache_.resolved_field_hit_count;
            ++cache_.trusted_fast_path_hit_count;
            cache_.resolved_field_reused = true;
            auto &accepted_cache = accepted_result_.solution.provenance.cache;
            accepted_cache.resolved_field_hit_count = cache_.resolved_field_hit_count;
            accepted_cache.trusted_fast_path_hit_count =
                cache_.trusted_fast_path_hit_count;
            accepted_cache.resolved_field_reused = true;
            accepted_cache.last_invalidation_reason.clear();
            accepted_result_.message.clear();
            return accepted_result_;
        }
        const PreflightResult validation = preflight(problem);
        if (validation.status != Status::ok) {
            return fail(validation.status, validation.message);
        }

        const std::string new_kernel_key = kernel_plan_key(problem);
        if (!workspace_ || new_kernel_key != kernel_key_) {
            if (workspace_) {
                ++cache_.resolved_field_invalidation_count;
                cache_.last_invalidation_reason = "geometry_or_layout_revision";
            }
            try {
                workspace_ = std::make_unique<FftWorkspace>(problem);
            } catch (const std::exception &error) {
                return fail(Status::numerical_failure, error.what());
            }
            kernel_key_ = new_kernel_key;
            last_resolved_key_.clear();
            ++cache_.plan_build_count;
            ++cache_.kernel_build_count;
            ++cache_.numerical_buffer_allocation_count;
            cache_.kernel_plan_cache_key_digest = kernel_key_;
        }

        const std::string new_resolved_key = resolved_field_key(problem, kernel_key_);
        if (!last_resolved_key_.empty() && new_resolved_key == last_resolved_key_) {
            ++cache_.resolved_field_hit_count;
            cache_.resolved_field_reused = true;
            cache_.resolved_field_cache_key_digest = new_resolved_key;
            accepted_result_.solution.provenance.cache = cache_;
            accepted_result_.status = Status::ok;
            accepted_result_.message.clear();
            accepted_problem_ = &problem;
            accepted_snapshot_revision_ = problem.trusted_snapshot_revision;
            accepted_snapshot_digest_ = problem.trusted_snapshot_digest;
            return accepted_result_;
        }
        if (!last_resolved_key_.empty()) {
            ++cache_.resolved_field_invalidation_count;
            cache_.last_invalidation_reason = "source_mask_certificate_or_stage_revision";
        }
        ++cache_.resolved_field_miss_count;

        candidate_result_ = SolveResult{};

        std::string reconstruction_message;
        const Status reconstruction = reconstruct_face_to_cell(
            problem.grid,
            problem.conductor_mask,
            problem.face_current_density_a_per_m2,
            candidate_result_.solution.cell_current_density_a_per_m2,
            reconstruction_message);
        if (reconstruction != Status::ok) {
            return fail(reconstruction, reconstruction_message);
        }
        std::vector<Vector3> full_diagnostic_field;
        try {
            workspace_->convolve(candidate_result_.solution.cell_current_density_a_per_m2,
                                 problem.target_mask,
                                 full_diagnostic_field,
                                 candidate_result_.solution.field_a_per_m);
        } catch (const std::exception &error) {
            return fail(Status::numerical_failure, error.what());
        }
        candidate_result_.solution.diagnostics = detail::compute_differential_diagnostics(
            problem.grid,
            candidate_result_.solution.cell_current_density_a_per_m2,
            full_diagnostic_field);
        cache_.resolved_field_cache_key_digest = new_resolved_key;
        fill_provenance(
            problem, *workspace_, cache_, candidate_result_.solution.provenance);
        last_resolved_key_ = new_resolved_key;
        candidate_result_.status = Status::ok;
        candidate_result_.message.clear();
        accepted_result_ = std::move(candidate_result_);
        accepted_problem_ = &problem;
        accepted_snapshot_revision_ = problem.trusted_snapshot_revision;
        accepted_snapshot_digest_ = problem.trusted_snapshot_digest;
        return accepted_result_;
    }

    const CacheDiagnostics &cache() const noexcept { return cache_; }

  private:
    const SolveResult &fail(Status status, std::string message) {
        failure_result_ = SolveResult{};
        failure_result_.status = status;
        failure_result_.message = std::move(message);
        return failure_result_;
    }

    std::unique_ptr<FftWorkspace> workspace_;
    std::string kernel_key_;
    std::string last_resolved_key_;
    const Problem *accepted_problem_ = nullptr;
    std::uint64_t accepted_snapshot_revision_ = 0;
    std::string accepted_snapshot_digest_;
    CacheDiagnostics cache_;
    SolveResult accepted_result_;
    SolveResult candidate_result_;
    SolveResult failure_result_;
};

Solver::Solver() : impl_(std::make_unique<Impl>()) {}
Solver::~Solver() = default;
Solver::Solver(Solver &&) noexcept = default;
Solver &Solver::operator=(Solver &&) noexcept = default;

const SolveResult &Solver::solve(const Problem &problem) {
    return impl_->solve(problem);
}

const CacheDiagnostics &Solver::cache_diagnostics() const noexcept {
    return impl_->cache();
}

} // namespace fullmag::fdm::cpu::oersted::v1
