#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include "spin_transport_gmres_v1.hpp"
#include "spin_transport_validation_v1.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
#include <queue>
#include <stdexcept>
#include <utility>

namespace fullmag::fdm::cpu::transport::spin::v1 {

BoundaryCondition BoundaryCondition::insulating() noexcept {
    return {BoundaryKind::insulating, {}};
}

BoundaryCondition BoundaryCondition::sink() noexcept {
    return {BoundaryKind::sink, {}};
}

BoundaryCondition BoundaryCondition::specified_potential(Vector3 potential_v) noexcept {
    return {BoundaryKind::specified_potential, potential_v};
}

BoundaryCondition &BoundaryConditions::operator[](transport::v1::Face face) noexcept {
    return values[static_cast<std::size_t>(face)];
}

const BoundaryCondition &BoundaryConditions::operator[](transport::v1::Face face) const noexcept {
    return values[static_cast<std::size_t>(face)];
}

Interface Interface::transparent(StructuredFace face,
                                 std::size_t from_cell,
                                 std::size_t to_cell) noexcept {
    Interface result;
    result.face = face;
    result.from_cell = from_cell;
    result.to_cell = to_cell;
    return result;
}

Interface Interface::mixing_conductance_v2(StructuredFace face,
                                           std::size_t from_cell,
                                           std::size_t to_cell,
                                           double g_up,
                                           double g_down,
                                           double g_r,
                                           double g_i,
                                           Vector3 magnetization) noexcept {
    Interface result = transparent(face, from_cell, to_cell);
    result.kind = InterfaceKind::mixing_conductance_v2;
    result.g_up_s_per_m2 = g_up;
    result.g_down_s_per_m2 = g_down;
    result.g_r_s_per_m2 = g_r;
    result.g_i_s_per_m2 = g_i;
    result.magnetization = magnetization;
    return result;
}

Interface Interface::sml_reservoir_v2(StructuredFace face,
                                      std::size_t from_cell,
                                      std::size_t to_cell) noexcept {
    Interface result = transparent(face, from_cell, to_cell);
    result.kind = InterfaceKind::sml_reservoir_v2;
    return result;
}

namespace {

struct ValidatedProblem {
    std::size_t count = 0;
    std::array<std::size_t, 3> face_counts{};
    double volume_m3 = 0.0;
    std::vector<std::vector<std::size_t>> components;
};

struct Observation {
    FaceSpinCurrentDensity fluxes;
    std::vector<InterfaceFluxObservation> interfaces;
    std::vector<ReactionObservation> reactions;
    std::vector<Vector3> residual_a_per_m3;
    std::vector<double> local_scale_a_per_m3;
    std::vector<Vector3> torque_per_s;
    Diagnostics diagnostics;
};

const transport::v1::AcceptedChargeSnapshot &charge_snapshot(const Problem &problem) {
    return *problem.accepted_charge_snapshot;
}

SolveResult failure(Status status, std::string message) {
    SolveResult result;
    result.status = status;
    result.message = std::move(message);
    return result;
}

Vector3 add(Vector3 left, Vector3 right) {
    return {left[0] + right[0], left[1] + right[1], left[2] + right[2]};
}

Vector3 scale(Vector3 value, double factor) {
    return {factor * value[0], factor * value[1], factor * value[2]};
}

double dot(Vector3 left, Vector3 right) {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

Vector3 cross(Vector3 left, Vector3 right) {
    return {left[1] * right[2] - left[2] * right[1],
            left[2] * right[0] - left[0] * right[2],
            left[0] * right[1] - left[1] * right[0]};
}

double norm(Vector3 value) {
    return std::sqrt(dot(value, value));
}

void accumulate(Vector3 &target, Vector3 value, double factor = 1.0) {
    for (std::size_t component = 0; component < 3; ++component) {
        target[component] += factor * value[component];
    }
}

bool finite(Vector3 value) {
    return std::all_of(value.begin(), value.end(), [](double item) {
        return std::isfinite(item);
    });
}

bool checked_multiply(std::size_t left, std::size_t right, std::size_t &result) {
    if (left != 0 && right > std::numeric_limits<std::size_t>::max() / left) {
        return false;
    }
    result = left * right;
    return true;
}

bool checked_add(std::size_t left, std::size_t right, std::size_t &result) {
    if (right > std::numeric_limits<std::size_t>::max() - left) {
        return false;
    }
    result = left + right;
    return true;
}

bool dimensions(const transport::v1::Grid &grid,
                std::size_t &count,
                std::array<std::size_t, 3> &faces) {
    std::size_t xy = 0;
    std::size_t extent = 0;
    std::size_t scratch = 0;
    return checked_multiply(grid.nx, grid.ny, xy) &&
           checked_multiply(xy, grid.nz, count) &&
           checked_add(grid.nx, 1, extent) && checked_multiply(extent, grid.ny, scratch) &&
           checked_multiply(scratch, grid.nz, faces[0]) &&
           checked_add(grid.ny, 1, extent) && checked_multiply(grid.nx, extent, scratch) &&
           checked_multiply(scratch, grid.nz, faces[1]) &&
           checked_add(grid.nz, 1, extent) && checked_multiply(grid.nx, grid.ny, scratch) &&
           checked_multiply(scratch, extent, faces[2]);
}

std::size_t cell_index(const transport::v1::Grid &grid,
                       std::size_t x,
                       std::size_t y,
                       std::size_t z) {
    return x + grid.nx * (y + grid.ny * z);
}

std::array<std::size_t, 3> coordinates(const transport::v1::Grid &grid,
                                       std::size_t cell) {
    const std::size_t x = cell % grid.nx;
    const std::size_t yz = cell / grid.nx;
    return {x, yz % grid.ny, yz / grid.ny};
}

double spacing(const transport::v1::Grid &grid, std::size_t axis) {
    return std::array<double, 3>{grid.dx_m, grid.dy_m, grid.dz_m}[axis];
}

double area(const transport::v1::Grid &grid, std::size_t axis) {
    return std::array<double, 3>{grid.dy_m * grid.dz_m,
                                 grid.dx_m * grid.dz_m,
                                 grid.dx_m * grid.dy_m}[axis];
}

bool same_face(StructuredFace left, StructuredFace right) {
    return left.axis == right.axis && left.negative_cell == right.negative_cell &&
           left.positive_cell == right.positive_cell;
}

const Interface *find_interface(const Problem &problem, StructuredFace face) {
    const auto found = std::find_if(problem.interfaces.begin(),
                                    problem.interfaces.end(),
                                    [face](const Interface &candidate) {
                                        return same_face(candidate.face, face);
                                    });
    return found == problem.interfaces.end() ? nullptr : &*found;
}

bool validate_face(const Problem &problem, StructuredFace face) {
    if (face.axis > 2 || face.negative_cell >= problem.active_cells.size() ||
        face.positive_cell >= problem.active_cells.size()) {
        return false;
    }
    auto expected = coordinates(problem.grid, face.negative_cell);
    ++expected[face.axis];
    return expected == coordinates(problem.grid, face.positive_cell);
}

std::vector<std::size_t> active_neighbors(const Problem &problem, std::size_t cell) {
    const auto c = coordinates(problem.grid, cell);
    std::vector<std::size_t> neighbors;
    for (std::size_t axis = 0; axis < 3; ++axis) {
        if (c[axis] > 0) {
            auto n = c;
            --n[axis];
            const std::size_t neighbor = cell_index(problem.grid, n[0], n[1], n[2]);
            if (problem.active_cells[neighbor]) {
                neighbors.push_back(neighbor);
            }
        }
        if (c[axis] + 1 < std::array<std::size_t, 3>{problem.grid.nx,
                                                     problem.grid.ny,
                                                     problem.grid.nz}[axis]) {
            auto n = c;
            ++n[axis];
            const std::size_t neighbor = cell_index(problem.grid, n[0], n[1], n[2]);
            if (problem.active_cells[neighbor]) {
                neighbors.push_back(neighbor);
            }
        }
    }
    return neighbors;
}

bool boundary_anchors_cell(const Problem &problem, std::size_t cell) {
    const auto c = coordinates(problem.grid, cell);
    const auto anchors = [](const BoundaryCondition &condition) {
        return condition.kind == BoundaryKind::sink ||
               condition.kind == BoundaryKind::specified_potential;
    };
    return (c[0] == 0 && anchors(problem.boundary[transport::v1::Face::x_min])) ||
           (c[0] + 1 == problem.grid.nx &&
            anchors(problem.boundary[transport::v1::Face::x_max])) ||
           (c[1] == 0 && anchors(problem.boundary[transport::v1::Face::y_min])) ||
           (c[1] + 1 == problem.grid.ny &&
            anchors(problem.boundary[transport::v1::Face::y_max])) ||
           (c[2] == 0 && anchors(problem.boundary[transport::v1::Face::z_min])) ||
           (c[2] + 1 == problem.grid.nz &&
            anchors(problem.boundary[transport::v1::Face::z_max]));
}

SolveResult validate(const Problem &problem,
                     const SolverOptions &options,
                     ValidatedProblem &validated) {
    const auto &grid = problem.grid;
    if (grid.nx == 0 || grid.ny == 0 || grid.nz == 0 || !std::isfinite(grid.dx_m) ||
        !std::isfinite(grid.dy_m) || !std::isfinite(grid.dz_m) || grid.dx_m <= 0.0 ||
        grid.dy_m <= 0.0 || grid.dz_m <= 0.0 ||
        !dimensions(grid, validated.count, validated.face_counts)) {
        return failure(Status::invalid_argument,
                       "spin grid dimensions must be finite, positive, and non-overflowing");
    }
    validated.volume_m3 = grid.dx_m * grid.dy_m * grid.dz_m;
    if (!std::isfinite(validated.volume_m3) || validated.volume_m3 <= 0.0) {
        return failure(Status::invalid_argument, "spin cell volume must be finite and positive");
    }
    const std::size_t count = validated.count;
    if (problem.accepted_charge_snapshot == nullptr ||
        problem.accepted_charge_snapshot->identity() == 0) {
        return failure(Status::invalid_argument,
                       "spin transport requires a snapshot constructed by an accepted charge solve");
    }
    const auto &charge = charge_snapshot(problem);
    const auto &charge_grid = charge.grid();
    if (charge_grid.nx != grid.nx || charge_grid.ny != grid.ny ||
        charge_grid.nz != grid.nz || charge_grid.dx_m != grid.dx_m ||
        charge_grid.dy_m != grid.dy_m || charge_grid.dz_m != grid.dz_m) {
        return failure(Status::invalid_argument,
                       "accepted charge snapshot grid does not match the spin grid");
    }
    if (charge.conductivity_s_per_m().size() != count ||
        charge.active_cells().size() != count ||
        charge.potential_v().size() != count ||
        problem.spin_conductivity_s_per_m.size() != count ||
        problem.polarization.size() != count || problem.spin_hall_angle.size() != count ||
        problem.magnetization.size() != count || problem.reactions.size() != count ||
        problem.active_cells.size() != count || problem.region_ids.size() != count) {
        return failure(Status::invalid_argument,
                       "spin material, charge, mask, and region fields require one value per cell");
    }
    const auto &charge_flux = charge.face_current_density_a_per_m2();
    if (charge_flux.x.size() != validated.face_counts[0] ||
        charge_flux.y.size() != validated.face_counts[1] ||
        charge_flux.z.size() != validated.face_counts[2]) {
        return failure(Status::invalid_argument,
                       "consumed charge face flux dimensions do not match the spin grid");
    }
    const auto finite_scalar = [](double value) { return std::isfinite(value); };
    if (!std::all_of(charge.potential_v().begin(),
                     charge.potential_v().end(),
                     finite_scalar) ||
        !std::all_of(charge_flux.x.begin(),
                     charge_flux.x.end(),
                     finite_scalar) ||
        !std::all_of(charge_flux.y.begin(),
                     charge_flux.y.end(),
                     finite_scalar) ||
        !std::all_of(charge_flux.z.begin(),
                     charge_flux.z.end(),
                     finite_scalar)) {
        return failure(Status::invalid_argument,
                       "consumed charge potential and exact face J_c must be finite");
    }
    bool any_active = false;
    for (std::size_t cell = 0; cell < count; ++cell) {
        any_active = any_active || problem.active_cells[cell] != 0;
        if (problem.active_cells[cell] && !charge.active_cells()[cell]) {
            return failure(Status::invalid_argument,
                           "every spin-active cell must belong to the immutable accepted charge-active mask");
        }
        if (!std::isfinite(charge.conductivity_s_per_m()[cell]) ||
            !std::isfinite(problem.spin_conductivity_s_per_m[cell]) ||
            !std::isfinite(problem.polarization[cell]) ||
            !std::isfinite(problem.spin_hall_angle[cell]) || !finite(problem.magnetization[cell]) ||
            charge.conductivity_s_per_m()[cell] < 0.0 ||
            problem.spin_conductivity_s_per_m[cell] < 0.0 ||
            (problem.active_cells[cell] &&
             (charge.conductivity_s_per_m()[cell] == 0.0 ||
              problem.spin_conductivity_s_per_m[cell] == 0.0)) ||
            problem.polarization[cell] < -1.0 || problem.polarization[cell] > 1.0) {
            return failure(Status::invalid_argument,
                           "spin/charge material fields are non-finite or outside their domain");
        }
        const auto reaction = problem.reactions[cell];
        for (double length : {reaction.spin_flip_m,
                              reaction.exchange_m,
                              reaction.dephasing_m}) {
            if (!std::isfinite(length) || length < 0.0) {
                return failure(Status::invalid_argument,
                               "active spin reaction lengths must be finite and positive; zero only disables a reaction");
            }
        }
        if ((problem.polarization[cell] != 0.0 || reaction.exchange_m > 0.0 ||
             reaction.dephasing_m > 0.0) &&
            std::abs(norm(problem.magnetization[cell]) - 1.0) > 1.0e-8) {
            return failure(Status::invalid_argument,
                           "magnetization must be unit length for polarized/exchange/dephasing spin transport");
        }
    }
    if (!any_active) {
        return failure(Status::invalid_argument, "spin transport requires an active cell");
    }
    for (const auto &condition : problem.boundary.values) {
        if (condition.kind == BoundaryKind::unset || !finite(condition.potential_v)) {
            return failure(Status::invalid_argument,
                           "FDM spin requires complete finite BC coverage on all six faces");
        }
    }
    if (charge.interfaces().size() != charge.interface_fluxes().size()) {
        return failure(Status::invalid_argument,
                       "accepted charge interface descriptors and observations must match one-to-one");
    }
    for (const auto &descriptor : charge.interfaces()) {
        const auto observation = std::find_if(
            charge.interface_fluxes().begin(),
            charge.interface_fluxes().end(),
            [&descriptor](const transport::v1::ChargeInterfaceFluxObservation &value) {
                return value.face.axis == descriptor.face.axis &&
                       value.face.negative_cell == descriptor.face.negative_cell &&
                       value.face.positive_cell == descriptor.face.positive_cell &&
                       value.from_cell == descriptor.from_cell &&
                       value.to_cell == descriptor.to_cell &&
                       value.g_up_s_per_m2 == descriptor.g_up_s_per_m2 &&
                       value.g_down_s_per_m2 == descriptor.g_down_s_per_m2;
            });
        if (observation == charge.interface_fluxes().end()) {
            return failure(Status::invalid_argument,
                           "accepted charge interface identity is inconsistent with its observation");
        }
    }
    for (std::size_t index = 0; index < problem.interfaces.size(); ++index) {
        const auto &interface = problem.interfaces[index];
        if (!validate_face(problem, interface.face) ||
            !((interface.from_cell == interface.face.negative_cell &&
               interface.to_cell == interface.face.positive_cell) ||
              (interface.from_cell == interface.face.positive_cell &&
               interface.to_cell == interface.face.negative_cell))) {
            return failure(Status::invalid_argument,
                           "spin interface must be an oriented adjacent structured face");
        }
        if (!problem.active_cells[interface.face.negative_cell] ||
            !problem.active_cells[interface.face.positive_cell] ||
            !charge.active_cells()[interface.face.negative_cell] ||
            !charge.active_cells()[interface.face.positive_cell]) {
            return failure(Status::invalid_argument,
                           "spin interface requires two spin-active and charge-active endpoints");
        }
        if (std::any_of(problem.interfaces.begin(),
                        problem.interfaces.begin() + static_cast<std::ptrdiff_t>(index),
                        [&interface](const Interface &other) {
                            return same_face(other.face, interface.face);
                        })) {
            return failure(Status::invalid_argument, "duplicate spin interface descriptor");
        }
        if (interface.kind == InterfaceKind::sml_reservoir_v2) {
            return failure(Status::unsupported_model,
                           "sml_reservoir.fullmag.v2 is not implemented in native FDM CPU M1");
        }
        if (interface.kind == InterfaceKind::mixing_conductance_v2 &&
            ((!std::isfinite(interface.g_up_s_per_m2) || interface.g_up_s_per_m2 < 0.0) ||
             (!std::isfinite(interface.g_down_s_per_m2) || interface.g_down_s_per_m2 < 0.0) ||
             (!std::isfinite(interface.g_r_s_per_m2) || interface.g_r_s_per_m2 < 0.0) ||
             !std::isfinite(interface.g_i_s_per_m2) || !finite(interface.magnetization) ||
             std::abs(norm(interface.magnetization) - 1.0) > 1.0e-8)) {
            return failure(Status::invalid_argument,
                           "mixing-conductance v2 requires finite nonnegative dissipative conductances and a unit magnetization");
        }
        if (interface.kind == InterfaceKind::mixing_conductance_v2) {
            const auto descriptor = std::find_if(
                charge.interfaces().begin(),
                charge.interfaces().end(),
                [&interface](const transport::v1::OrientedMixingInterface &value) {
                    return value.face.axis == interface.face.axis &&
                           value.face.negative_cell == interface.face.negative_cell &&
                           value.face.positive_cell == interface.face.positive_cell &&
                           value.from_cell == interface.from_cell &&
                           value.to_cell == interface.to_cell &&
                           value.g_up_s_per_m2 == interface.g_up_s_per_m2 &&
                           value.g_down_s_per_m2 == interface.g_down_s_per_m2;
                });
            const auto accepted = std::find_if(
                charge.interface_fluxes().begin(),
                charge.interface_fluxes().end(),
                [&interface](const transport::v1::ChargeInterfaceFluxObservation &value) {
                    return value.face.axis == interface.face.axis &&
                           value.face.negative_cell == interface.face.negative_cell &&
                           value.face.positive_cell == interface.face.positive_cell &&
                           value.from_cell == interface.from_cell &&
                           value.to_cell == interface.to_cell &&
                           value.g_up_s_per_m2 == interface.g_up_s_per_m2 &&
                           value.g_down_s_per_m2 == interface.g_down_s_per_m2;
                });
            if (descriptor == charge.interfaces().end() ||
                accepted == charge.interface_fluxes().end()) {
                return failure(Status::invalid_argument,
                               "mixing spin interface does not exactly match the accepted oriented charge descriptor and observation");
            }
        }
    }
    if (std::count_if(problem.interfaces.begin(),
                      problem.interfaces.end(),
                      [](const Interface &interface) {
                          return interface.kind == InterfaceKind::mixing_conductance_v2;
                      }) != static_cast<std::ptrdiff_t>(charge.interfaces().size())) {
        return failure(Status::invalid_argument,
                       "accepted charge mixing interfaces and spin mixing interfaces must match one-to-one");
    }
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t lower = cell_index(grid, x, y, z);
                for (std::size_t axis = 0; axis < 3; ++axis) {
                    auto upper_coordinates = std::array<std::size_t, 3>{x, y, z};
                    const auto extents = std::array<std::size_t, 3>{grid.nx, grid.ny, grid.nz};
                    if (++upper_coordinates[axis] >= extents[axis]) {
                        continue;
                    }
                    const std::size_t upper = cell_index(grid,
                                                         upper_coordinates[0],
                                                         upper_coordinates[1],
                                                         upper_coordinates[2]);
                    if (!problem.active_cells[lower] || !problem.active_cells[upper] ||
                        problem.region_ids[lower] == problem.region_ids[upper]) {
                        continue;
                    }
                    if (find_interface(problem, {axis, lower, upper}) == nullptr) {
                        return failure(Status::unsupported_model,
                                       "cross-region spin face requires one explicit interface law");
                    }
                }
            }
        }
    }
    if (!std::isfinite(options.relative_tolerance) || options.relative_tolerance <= 0.0 ||
        !std::isfinite(options.absolute_tolerance_a) || options.absolute_tolerance_a < 0.0 ||
        !std::isfinite(options.local_relative_tolerance) ||
        options.local_relative_tolerance <= 0.0 ||
        !std::isfinite(options.local_absolute_tolerance_a_per_m3) ||
        options.local_absolute_tolerance_a_per_m3 < 0.0 ||
        options.max_iterations == 0 || options.gmres_restart == 0) {
        return failure(Status::invalid_argument,
                       "spin GMRES policy requires positive finite relative tolerance/restart/iterations and nonnegative finite absolute tolerance");
    }
    std::vector<std::uint8_t> visited(count, 0);
    for (std::size_t seed = 0; seed < count; ++seed) {
        if (!problem.active_cells[seed] || visited[seed]) {
            continue;
        }
        bool anchored = false;
        std::queue<std::size_t> queue;
        queue.push(seed);
        visited[seed] = 1;
        validated.components.emplace_back();
        while (!queue.empty()) {
            const std::size_t cell = queue.front();
            queue.pop();
            validated.components.back().push_back(cell);
            anchored = anchored || problem.reactions[cell].spin_flip_m > 0.0 ||
                       boundary_anchors_cell(problem, cell);
            for (std::size_t neighbor : active_neighbors(problem, cell)) {
                if (!visited[neighbor]) {
                    visited[neighbor] = 1;
                    queue.push(neighbor);
                }
            }
        }
        if (!anchored) {
            return failure(Status::singular_operator,
                           "every disconnected spin component requires spin-flip or a sink/specified-potential anchor");
        }
    }
    const bool has_targets = !problem.torque_targets.target_cells.empty() ||
                             !problem.torque_targets.saturation_magnetization_a_per_m.empty() ||
                             problem.torque_targets.gamma_e_rad_per_s_t != 0.0;
    if (has_targets &&
        (problem.torque_targets.target_cells.size() != count ||
         problem.torque_targets.saturation_magnetization_a_per_m.size() != count ||
         !std::isfinite(problem.torque_targets.gamma_e_rad_per_s_t) ||
         problem.torque_targets.gamma_e_rad_per_s_t <= 0.0)) {
        return failure(Status::invalid_argument,
                       "torque targets require one mask/Ms per cell and positive finite gamma_e");
    }
    for (std::size_t cell = 0; cell < count && has_targets; ++cell) {
        if (problem.torque_targets.target_cells[cell] &&
            (!std::isfinite(problem.torque_targets.saturation_magnetization_a_per_m[cell]) ||
             problem.torque_targets.saturation_magnetization_a_per_m[cell] <= 0.0)) {
            return failure(Status::invalid_argument,
                           "torque target Ms must be finite and positive");
        }
    }
    return {Status::ok, {}, {}};
}

FaceSpinCurrentDensity allocate_fluxes(const ValidatedProblem &validated) {
    FaceSpinCurrentDensity result;
    result.x.assign(validated.face_counts[0], {});
    result.y.assign(validated.face_counts[1], {});
    result.z.assign(validated.face_counts[2], {});
    return result;
}

double harmonic_mean(double left, double right) {
    if (left == 0.0 || right == 0.0) {
        return 0.0;
    }
    const double smaller = std::min(left, right);
    const double larger = std::max(left, right);
    return smaller * (2.0 / (1.0 + smaller / larger));
}

std::vector<Vector3> electric_field_from_consumed_flux(const Problem &problem) {
    std::vector<Vector3> field(problem.active_cells.size(), Vector3{});
    const auto &charge = charge_snapshot(problem);
    const auto &charge_flux = charge.face_current_density_a_per_m2();
    for (std::size_t z = 0; z < problem.grid.nz; ++z) {
        for (std::size_t y = 0; y < problem.grid.ny; ++y) {
            for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                const std::size_t cell = cell_index(problem.grid, x, y, z);
                if (!problem.active_cells[cell]) {
                    continue;
                }
                const std::size_t x0 = x + (problem.grid.nx + 1) * (y + problem.grid.ny * z);
                const std::size_t y0 = x + problem.grid.nx * (y + (problem.grid.ny + 1) * z);
                const std::size_t z0 = x + problem.grid.nx * (y + problem.grid.ny * z);
                const double inverse_sigma = 1.0 / charge.conductivity_s_per_m()[cell];
                field[cell] = {
                    0.5 * (charge_flux.x[x0] + charge_flux.x[x0 + 1]) * inverse_sigma,
                    0.5 * (charge_flux.y[y0] + charge_flux.y[y0 + problem.grid.nx]) *
                        inverse_sigma,
                    0.5 * (charge_flux.z[z0] +
                           charge_flux.z[
                               z0 + problem.grid.nx * problem.grid.ny]) * inverse_sigma,
                };
            }
        }
    }
    return field;
}

Vector3 constitutive_source(const Problem &problem,
                            std::size_t axis,
                            std::size_t cell,
                            Vector3 electric_field,
                            double charge_flux) {
    const double sigma = charge_snapshot(problem).conductivity_s_per_m()[cell];
    electric_field[axis] = charge_flux / sigma;
    return add(scale(problem.magnetization[cell], problem.polarization[cell] * charge_flux),
               detail::direct_she_source(axis,
                                         electric_field,
                                         problem.spin_hall_angle[cell] * sigma));
}

InterfaceFluxObservation mixing_flux(const Problem &problem,
                                     const Interface &interface,
                                     const std::vector<Vector3> &mu) {
    const auto &accepted = charge_snapshot(problem).interface_fluxes();
    const auto charge_interface = std::find_if(
        accepted.begin(),
        accepted.end(),
        [&interface](const transport::v1::ChargeInterfaceFluxObservation &value) {
            return value.face.axis == interface.face.axis &&
                   value.face.negative_cell == interface.face.negative_cell &&
                   value.face.positive_cell == interface.face.positive_cell &&
                   value.from_cell == interface.from_cell &&
                   value.to_cell == interface.to_cell;
        });
    if (charge_interface == accepted.end()) {
        throw std::logic_error("validated spin mixing interface lost its charge snapshot");
    }
    const double delta_v = charge_interface->delta_potential_trace_v;
    const Vector3 delta_mu = add(mu[interface.from_cell], scale(mu[interface.to_cell], -1.0));
    const Vector3 incoming = scale(interface.magnetization,
                                   (interface.g_up_s_per_m2 - interface.g_down_s_per_m2) *
                                       delta_v);
    const Vector3 backflow = scale(interface.magnetization,
                                   0.5 * (interface.g_up_s_per_m2 +
                                          interface.g_down_s_per_m2) *
                                       dot(interface.magnetization, delta_mu));
    const Vector3 parallel = add(incoming, backflow);
    const Vector3 absorbed = add(
        scale(cross(interface.magnetization, cross(delta_mu, interface.magnetization)),
              interface.g_r_s_per_m2),
        scale(cross(delta_mu, interface.magnetization), interface.g_i_s_per_m2));
    const Vector3 from_outgoing = add(parallel, absorbed);
    const Vector3 to_transmitted = parallel;
    const bool from_is_negative = interface.from_cell == interface.face.negative_cell;
    InterfaceFluxObservation result;
    result.face = interface.face;
    result.from_cell = interface.from_cell;
    result.to_cell = interface.to_cell;
    result.incoming_longitudinal_a_per_m2 = incoming;
    result.backflow_longitudinal_a_per_m2 = backflow;
    result.absorbed_transverse_a_per_m2 = absorbed;
    if (from_is_negative) {
        result.negative_cell_flux_positive_axis_a_per_m2 = from_outgoing;
        result.positive_cell_flux_positive_axis_a_per_m2 = to_transmitted;
    } else {
        result.negative_cell_flux_positive_axis_a_per_m2 = scale(to_transmitted, -1.0);
        result.positive_cell_flux_positive_axis_a_per_m2 = scale(from_outgoing, -1.0);
    }
    return result;
}

Vector3 internal_flux(const Problem &problem,
                      std::size_t axis,
                      std::size_t lower,
                      std::size_t upper,
                      const std::vector<Vector3> &mu,
                      const std::vector<Vector3> &electric,
                      double charge_flux,
                      std::vector<InterfaceFluxObservation> &observations) {
    if (!problem.active_cells[lower] || !problem.active_cells[upper]) {
        return {};
    }
    const StructuredFace face{axis, lower, upper};
    const Interface *interface = find_interface(problem, face);
    if (interface != nullptr && interface->kind == InterfaceKind::mixing_conductance_v2) {
        observations.push_back(mixing_flux(problem, *interface, mu));
        return observations.back().negative_cell_flux_positive_axis_a_per_m2;
    }
    const double half_distance = 0.5 * spacing(problem.grid, axis);
    const double resistance_lower = half_distance /
                                    (0.5 * problem.spin_conductivity_s_per_m[lower]);
    const double resistance_upper = half_distance /
                                    (0.5 * problem.spin_conductivity_s_per_m[upper]);
    const double signed_polarized_flux =
        0.5 * (problem.polarization[lower] + problem.polarization[upper]) * charge_flux;
    const Vector3 face_m = signed_polarized_flux >= 0.0 ? problem.magnetization[lower]
                                                        : problem.magnetization[upper];
    Vector3 she{};
    if (problem.region_ids[lower] == problem.region_ids[upper]) {
        const auto &charge_sigma = charge_snapshot(problem).conductivity_s_per_m();
        const double sigma = harmonic_mean(charge_sigma[lower], charge_sigma[upper]);
        const double theta = 0.5 * (problem.spin_hall_angle[lower] +
                                    problem.spin_hall_angle[upper]);
        Vector3 electric_face = scale(add(electric[lower], electric[upper]), 0.5);
        electric_face[axis] = charge_flux / sigma;
        she = detail::direct_she_source(axis, electric_face, theta * sigma);
    } else {
        const Vector3 lower_source = constitutive_source(problem,
                                                         axis,
                                                         lower,
                                                         electric[lower],
                                                         0.0);
        const Vector3 upper_source = constitutive_source(problem,
                                                         axis,
                                                         upper,
                                                         electric[upper],
                                                         0.0);
        const double total = resistance_lower + resistance_upper;
        for (std::size_t component = 0; component < 3; ++component) {
            she[component] = (resistance_lower * lower_source[component] +
                              resistance_upper * upper_source[component]) /
                             total;
        }
    }
    Vector3 result = add(scale(face_m, signed_polarized_flux), she);
    const double total_resistance = resistance_lower + resistance_upper;
    for (std::size_t component = 0; component < 3; ++component) {
        result[component] -= (mu[upper][component] - mu[lower][component]) /
                             total_resistance;
    }
    if (interface != nullptr) {
        InterfaceFluxObservation transparent;
        transparent.face = face;
        transparent.from_cell = interface->from_cell;
        transparent.to_cell = interface->to_cell;
        transparent.negative_cell_flux_positive_axis_a_per_m2 = result;
        transparent.positive_cell_flux_positive_axis_a_per_m2 = result;
        observations.push_back(transparent);
    }
    return result;
}

Vector3 boundary_flux(const Problem &problem,
                      std::size_t axis,
                      std::size_t cell,
                      bool positive_side,
                      const BoundaryCondition &condition,
                      const std::vector<Vector3> &mu,
                      const std::vector<Vector3> &electric,
                      double charge_flux) {
    if (!problem.active_cells[cell] || condition.kind == BoundaryKind::insulating) {
        return {};
    }
    const Vector3 boundary_value = condition.kind == BoundaryKind::sink ? Vector3{}
                                                                        : condition.potential_v;
    Vector3 result{};
    const double distance = 0.5 * spacing(problem.grid, axis);
    for (std::size_t component = 0; component < 3; ++component) {
        const double difference = positive_side ? boundary_value[component] - mu[cell][component]
                                                : mu[cell][component] - boundary_value[component];
        result[component] = -0.5 * problem.spin_conductivity_s_per_m[cell] * difference /
                            distance;
    }
    return add(result,
               constitutive_source(problem, axis, cell, electric[cell], charge_flux));
}

void compute_fluxes(const Problem &problem,
                    const ValidatedProblem &validated,
                    const std::vector<Vector3> &mu,
                    FaceSpinCurrentDensity &fluxes,
                    std::vector<InterfaceFluxObservation> &observations) {
    fluxes = allocate_fluxes(validated);
    observations.clear();
    const auto electric = electric_field_from_consumed_flux(problem);
    const auto &charge_flux =
        charge_snapshot(problem).face_current_density_a_per_m2();
    const auto &grid = problem.grid;
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t face_x = 0; face_x <= grid.nx; ++face_x) {
                const std::size_t face = face_x + (grid.nx + 1) * (y + grid.ny * z);
                if (face_x == 0) {
                    fluxes.x[face] = boundary_flux(problem,
                                                   0,
                                                   cell_index(grid, 0, y, z),
                                                   false,
                                                   problem.boundary[transport::v1::Face::x_min],
                                                   mu,
                                                   electric,
                                                   charge_flux.x[face]);
                } else if (face_x == grid.nx) {
                    fluxes.x[face] = boundary_flux(problem,
                                                   0,
                                                   cell_index(grid, grid.nx - 1, y, z),
                                                   true,
                                                   problem.boundary[transport::v1::Face::x_max],
                                                   mu,
                                                   electric,
                                                   charge_flux.x[face]);
                } else {
                    fluxes.x[face] = internal_flux(problem,
                                                   0,
                                                   cell_index(grid, face_x - 1, y, z),
                                                   cell_index(grid, face_x, y, z),
                                                   mu,
                                                   electric,
                                                   charge_flux.x[face],
                                                   observations);
                }
            }
        }
    }
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t face_y = 0; face_y <= grid.ny; ++face_y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t face = x + grid.nx * (face_y + (grid.ny + 1) * z);
                if (face_y == 0) {
                    fluxes.y[face] = boundary_flux(problem,
                                                   1,
                                                   cell_index(grid, x, 0, z),
                                                   false,
                                                   problem.boundary[transport::v1::Face::y_min],
                                                   mu,
                                                   electric,
                                                   charge_flux.y[face]);
                } else if (face_y == grid.ny) {
                    fluxes.y[face] = boundary_flux(problem,
                                                   1,
                                                   cell_index(grid, x, grid.ny - 1, z),
                                                   true,
                                                   problem.boundary[transport::v1::Face::y_max],
                                                   mu,
                                                   electric,
                                                   charge_flux.y[face]);
                } else {
                    fluxes.y[face] = internal_flux(problem,
                                                   1,
                                                   cell_index(grid, x, face_y - 1, z),
                                                   cell_index(grid, x, face_y, z),
                                                   mu,
                                                   electric,
                                                   charge_flux.y[face],
                                                   observations);
                }
            }
        }
    }
    for (std::size_t face_z = 0; face_z <= grid.nz; ++face_z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t face = x + grid.nx * (y + grid.ny * face_z);
                if (face_z == 0) {
                    fluxes.z[face] = boundary_flux(problem,
                                                   2,
                                                   cell_index(grid, x, y, 0),
                                                   false,
                                                   problem.boundary[transport::v1::Face::z_min],
                                                   mu,
                                                   electric,
                                                   charge_flux.z[face]);
                } else if (face_z == grid.nz) {
                    fluxes.z[face] = boundary_flux(problem,
                                                   2,
                                                   cell_index(grid, x, y, grid.nz - 1),
                                                   true,
                                                   problem.boundary[transport::v1::Face::z_max],
                                                   mu,
                                                   electric,
                                                   charge_flux.z[face]);
                } else {
                    fluxes.z[face] = internal_flux(problem,
                                                   2,
                                                   cell_index(grid, x, y, face_z - 1),
                                                   cell_index(grid, x, y, face_z),
                                                   mu,
                                                   electric,
                                                   charge_flux.z[face],
                                                   observations);
                }
            }
        }
    }
}

void compute_reactions(const Problem &problem,
                       const std::vector<Vector3> &mu,
                       std::vector<ReactionObservation> &reactions) {
    reactions.assign(mu.size(), {});
    for (std::size_t cell = 0; cell < mu.size(); ++cell) {
        if (!problem.active_cells[cell]) {
            continue;
        }
        const double sigma_s = problem.spin_conductivity_s_per_m[cell];
        const auto lengths = problem.reactions[cell];
        if (lengths.spin_flip_m > 0.0) {
            reactions[cell].spin_flip_a_per_m3 =
                scale(mu[cell], sigma_s / (2.0 * lengths.spin_flip_m * lengths.spin_flip_m));
        }
        if (lengths.exchange_m > 0.0) {
            reactions[cell].exchange_a_per_m3 =
                scale(cross(mu[cell], problem.magnetization[cell]),
                      sigma_s / (2.0 * lengths.exchange_m * lengths.exchange_m));
        }
        if (lengths.dephasing_m > 0.0) {
            reactions[cell].dephasing_a_per_m3 =
                scale(cross(problem.magnetization[cell],
                            cross(mu[cell], problem.magnetization[cell])),
                      sigma_s / (2.0 * lengths.dephasing_m * lengths.dephasing_m));
        }
        reactions[cell].magnetic_torque_sink_a_per_m3 =
            add(reactions[cell].exchange_a_per_m3, reactions[cell].dephasing_a_per_m3);
    }
}

void compute_residual(const Problem &problem,
                      const FaceSpinCurrentDensity &fluxes,
                      const std::vector<InterfaceFluxObservation> &interfaces,
                      const std::vector<ReactionObservation> &reactions,
                      std::vector<Vector3> &residual) {
    residual.assign(problem.active_cells.size(), {});
    const auto &grid = problem.grid;
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t cell = cell_index(grid, x, y, z);
                if (!problem.active_cells[cell]) {
                    continue;
                }
                const std::size_t x0 = x + (grid.nx + 1) * (y + grid.ny * z);
                const std::size_t y0 = x + grid.nx * (y + (grid.ny + 1) * z);
                const std::size_t z0 = x + grid.nx * (y + grid.ny * z);
                for (std::size_t component = 0; component < 3; ++component) {
                    residual[cell][component] =
                        (fluxes.x[x0 + 1][component] - fluxes.x[x0][component]) / grid.dx_m +
                        (fluxes.y[y0 + grid.nx][component] - fluxes.y[y0][component]) /
                            grid.dy_m +
                        (fluxes.z[z0 + grid.nx * grid.ny][component] -
                         fluxes.z[z0][component]) /
                            grid.dz_m +
                        reactions[cell].spin_flip_a_per_m3[component] +
                        reactions[cell].exchange_a_per_m3[component] +
                        reactions[cell].dephasing_a_per_m3[component];
                }
            }
        }
    }
    for (const auto &interface : interfaces) {
        const Vector3 correction =
            add(interface.negative_cell_flux_positive_axis_a_per_m2,
                scale(interface.positive_cell_flux_positive_axis_a_per_m2, -1.0));
        accumulate(residual[interface.face.positive_cell],
                   correction,
                   1.0 / spacing(grid, interface.face.axis));
    }
}

void compute_local_scale(const Problem &problem,
                         const FaceSpinCurrentDensity &fluxes,
                         const std::vector<InterfaceFluxObservation> &interfaces,
                         const std::vector<ReactionObservation> &reactions,
                         std::vector<double> &scale_a_per_m3) {
    scale_a_per_m3.assign(problem.active_cells.size(), 0.0);
    const auto &grid = problem.grid;
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t cell = cell_index(grid, x, y, z);
                if (!problem.active_cells[cell]) {
                    continue;
                }
                const std::size_t x0 = x + (grid.nx + 1) * (y + grid.ny * z);
                const std::size_t y0 = x + grid.nx * (y + (grid.ny + 1) * z);
                const std::size_t z0 = x + grid.nx * (y + grid.ny * z);
                scale_a_per_m3[cell] =
                    (norm(fluxes.x[x0]) + norm(fluxes.x[x0 + 1])) / grid.dx_m +
                    (norm(fluxes.y[y0]) + norm(fluxes.y[y0 + grid.nx])) / grid.dy_m +
                    (norm(fluxes.z[z0]) +
                     norm(fluxes.z[z0 + grid.nx * grid.ny])) /
                        grid.dz_m +
                    norm(reactions[cell].spin_flip_a_per_m3) +
                    norm(reactions[cell].exchange_a_per_m3) +
                    norm(reactions[cell].dephasing_a_per_m3);
            }
        }
    }
    for (const auto &interface : interfaces) {
        const Vector3 correction =
            add(interface.negative_cell_flux_positive_axis_a_per_m2,
                scale(interface.positive_cell_flux_positive_axis_a_per_m2, -1.0));
        scale_a_per_m3[interface.face.positive_cell] +=
            norm(correction) / spacing(grid, interface.face.axis);
    }
}

void compute_diagnostics(const Problem &problem,
                         const ValidatedProblem &validated,
                         const Observation &observation,
                         Diagnostics &diagnostics) {
    const auto &grid = problem.grid;
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            accumulate(diagnostics.boundary_outward_current_a[0],
                       observation.fluxes.x[(grid.nx + 1) * (y + grid.ny * z)],
                       -area(grid, 0));
            accumulate(diagnostics.boundary_outward_current_a[1],
                       observation.fluxes.x[grid.nx + (grid.nx + 1) * (y + grid.ny * z)],
                       area(grid, 0));
        }
    }
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t x = 0; x < grid.nx; ++x) {
            accumulate(diagnostics.boundary_outward_current_a[2],
                       observation.fluxes.y[x + grid.nx * ((grid.ny + 1) * z)],
                       -area(grid, 1));
            accumulate(diagnostics.boundary_outward_current_a[3],
                       observation.fluxes.y[x + grid.nx * (grid.ny + (grid.ny + 1) * z)],
                       area(grid, 1));
        }
    }
    for (std::size_t y = 0; y < grid.ny; ++y) {
        for (std::size_t x = 0; x < grid.nx; ++x) {
            accumulate(diagnostics.boundary_outward_current_a[4],
                       observation.fluxes.z[x + grid.nx * y],
                       -area(grid, 2));
            accumulate(diagnostics.boundary_outward_current_a[5],
                       observation.fluxes.z[x + grid.nx * (y + grid.ny * grid.nz)],
                       area(grid, 2));
        }
    }
    double residual_squared = 0.0;
    for (const Vector3 &boundary : diagnostics.boundary_outward_current_a) {
        accumulate(diagnostics.net_boundary_current_a, boundary);
        diagnostics.global_balance_scale_a += norm(boundary);
    }
    for (std::size_t cell = 0; cell < validated.count; ++cell) {
        if (!problem.active_cells[cell]) {
            continue;
        }
        accumulate(diagnostics.spin_flip_sink_a,
                   observation.reactions[cell].spin_flip_a_per_m3,
                   validated.volume_m3);
        accumulate(diagnostics.magnetic_torque_sink_a,
                   observation.reactions[cell].magnetic_torque_sink_a_per_m3,
                   validated.volume_m3);
        diagnostics.global_balance_scale_a +=
            validated.volume_m3 * norm(observation.reactions[cell].spin_flip_a_per_m3);
        diagnostics.global_balance_scale_a +=
            validated.volume_m3 * norm(observation.reactions[cell].magnetic_torque_sink_a_per_m3);
        diagnostics.max_abs_residual_a_per_m3 =
            std::max({diagnostics.max_abs_residual_a_per_m3,
                      std::abs(observation.residual_a_per_m3[cell][0]),
                      std::abs(observation.residual_a_per_m3[cell][1]),
                      std::abs(observation.residual_a_per_m3[cell][2])});
        for (double component : observation.residual_a_per_m3[cell]) {
            const double integrated = component * validated.volume_m3;
            residual_squared += integrated * integrated;
        }
    }
    for (const auto &interface : observation.interfaces) {
        accumulate(diagnostics.interface_absorbed_sink_a,
                   interface.absorbed_transverse_a_per_m2,
                   area(grid, interface.face.axis));
        diagnostics.global_balance_scale_a +=
            area(grid, interface.face.axis) * norm(interface.absorbed_transverse_a_per_m2);
    }
    diagnostics.recomputed_balance_integrated_l2_a = std::sqrt(residual_squared);
    diagnostics.global_balance_closure_a =
        add(diagnostics.net_boundary_current_a,
            add(diagnostics.spin_flip_sink_a,
                add(diagnostics.magnetic_torque_sink_a,
                    diagnostics.interface_absorbed_sink_a)));
    diagnostics.relative_global_balance = diagnostics.global_balance_scale_a == 0.0
                                              ? norm(diagnostics.global_balance_closure_a)
                                              : norm(diagnostics.global_balance_closure_a) /
                                                    diagnostics.global_balance_scale_a;
}

SolveResult compute_observation(const Problem &problem,
                                const ValidatedProblem &validated,
                                const std::vector<Vector3> &mu,
                                Observation &observation) {
    if (mu.size() != validated.count ||
        std::any_of(mu.begin(), mu.end(), [](Vector3 value) { return !finite(value); })) {
        return failure(Status::numerical_failure, "spin iterate contains non-finite values");
    }
    compute_fluxes(problem, validated, mu, observation.fluxes, observation.interfaces);
    compute_reactions(problem, mu, observation.reactions);
    compute_residual(problem,
                     observation.fluxes,
                     observation.interfaces,
                     observation.reactions,
                     observation.residual_a_per_m3);
    compute_local_scale(problem,
                        observation.fluxes,
                        observation.interfaces,
                        observation.reactions,
                        observation.local_scale_a_per_m3);
    const bool finite_flux =
        std::all_of(observation.fluxes.x.begin(), observation.fluxes.x.end(), finite) &&
        std::all_of(observation.fluxes.y.begin(), observation.fluxes.y.end(), finite) &&
        std::all_of(observation.fluxes.z.begin(), observation.fluxes.z.end(), finite) &&
        std::all_of(observation.residual_a_per_m3.begin(),
                    observation.residual_a_per_m3.end(),
                    finite);
    if (!finite_flux) {
        return failure(Status::numerical_failure,
                       "spin operator produced a non-finite flux or residual");
    }
    observation.diagnostics = {};
    compute_diagnostics(problem, validated, observation, observation.diagnostics);
    return {Status::ok, {}, {}};
}

std::vector<double> flatten_integrated(const std::vector<Vector3> &values,
                                       double volume_m3) {
    std::vector<double> result;
    result.reserve(3 * values.size());
    for (Vector3 value : values) {
        for (double component : value) {
            result.push_back(component * volume_m3);
        }
    }
    return result;
}

std::vector<Vector3> unflatten(const std::vector<double> &values) {
    std::vector<Vector3> result(values.size() / 3);
    for (std::size_t cell = 0; cell < result.size(); ++cell) {
        result[cell] = {values[3 * cell], values[3 * cell + 1], values[3 * cell + 2]};
    }
    return result;
}

SolveResult compute_torque(const Problem &problem,
                           const ValidatedProblem &validated,
                           Observation &observation) {
    constexpr double hbar_j_s = 1.054571817e-34;
    constexpr double elementary_charge_c = 1.602176634e-19;
    observation.torque_per_s.assign(validated.count, {});
    const bool has_targets = problem.torque_targets.target_cells.size() == validated.count;
    for (std::size_t cell = 0; cell < validated.count; ++cell) {
        const Vector3 sink = observation.reactions[cell].magnetic_torque_sink_a_per_m3;
        if (norm(sink) == 0.0) {
            continue;
        }
        if (!has_targets || !problem.torque_targets.target_cells[cell]) {
            return failure(Status::invalid_argument,
                           "magnetic spin reaction requires an explicit torque target");
        }
        const double factor = -problem.torque_targets.gamma_e_rad_per_s_t /
                              problem.torque_targets.saturation_magnetization_a_per_m[cell] *
                              hbar_j_s / (2.0 * elementary_charge_c);
        observation.torque_per_s[cell] = scale(sink, factor);
    }
    for (const auto &interface_observation : observation.interfaces) {
        if (norm(interface_observation.absorbed_transverse_a_per_m2) == 0.0) {
            continue;
        }
        const Interface *interface = find_interface(problem, interface_observation.face);
        if (interface == nullptr || !has_targets ||
            !problem.torque_targets.target_cells[interface->to_cell]) {
            return failure(Status::invalid_argument,
                           "absorbed mixing flux requires the F-side cell as a torque target");
        }
        const std::size_t target = interface->to_cell;
        const double factor = -problem.torque_targets.gamma_e_rad_per_s_t /
                              problem.torque_targets.saturation_magnetization_a_per_m[target] *
                              hbar_j_s / (2.0 * elementary_charge_c);
        const Vector3 density = scale(interface_observation.absorbed_transverse_a_per_m2,
                                      area(problem.grid, interface_observation.face.axis) /
                                          validated.volume_m3);
        observation.torque_per_s[target] =
            add(observation.torque_per_s[target], scale(density, factor));
    }
    return {Status::ok, {}, {}};
}

} // namespace

std::vector<CellSpinCurrentTensor>
reconstruct_cell_spin_current_tensor(const transport::v1::Grid &grid,
                                     const FaceSpinCurrentDensity &face_spin_current_density) {
    std::size_t count = 0;
    std::array<std::size_t, 3> expected_faces{};
    if (!dimensions(grid, count, expected_faces) ||
        face_spin_current_density.x.size() != expected_faces[0] ||
        face_spin_current_density.y.size() != expected_faces[1] ||
        face_spin_current_density.z.size() != expected_faces[2]) {
        throw std::invalid_argument("spin face-current dimensions do not match the grid");
    }
    std::vector<CellSpinCurrentTensor> result(count);
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t cell = cell_index(grid, x, y, z);
                const std::array<std::size_t, 2> x_faces{
                    x + (grid.nx + 1) * (y + grid.ny * z),
                    x + 1 + (grid.nx + 1) * (y + grid.ny * z),
                };
                const std::array<std::size_t, 2> y_faces{
                    x + grid.nx * (y + (grid.ny + 1) * z),
                    x + grid.nx * (y + 1 + (grid.ny + 1) * z),
                };
                const std::array<std::size_t, 2> z_faces{
                    x + grid.nx * (y + grid.ny * z),
                    x + grid.nx * (y + grid.ny * (z + 1)),
                };
                for (std::size_t component = 0; component < 3; ++component) {
                    result[cell][component] =
                        0.5 * (face_spin_current_density.x[x_faces[0]][component] +
                               face_spin_current_density.x[x_faces[1]][component]);
                    result[cell][3 + component] =
                        0.5 * (face_spin_current_density.y[y_faces[0]][component] +
                               face_spin_current_density.y[y_faces[1]][component]);
                    result[cell][6 + component] =
                        0.5 * (face_spin_current_density.z[z_faces[0]][component] +
                               face_spin_current_density.z[z_faces[1]][component]);
                }
            }
        }
    }
    return result;
}

SolveResult solve(const Problem &problem, const SolverOptions &options) {
    try {
        ValidatedProblem validated;
        if (auto result = validate(problem, options, validated); !result.ok()) {
            return result;
        }
        std::vector<Vector3> zero(validated.count, Vector3{});
        Observation affine_observation;
        if (auto result = compute_observation(problem, validated, zero, affine_observation);
            !result.ok()) {
            return result;
        }
        const std::vector<double> affine =
            flatten_integrated(affine_observation.residual_a_per_m3, validated.volume_m3);
        std::vector<double> rhs(affine.size());
        std::transform(affine.begin(), affine.end(), rhs.begin(), [](double value) {
            return -value;
        });
        const double rhs_norm = detail::l2_norm(rhs);
        const double acceptance_tolerance =
            std::max(options.absolute_tolerance_a, options.relative_tolerance * rhs_norm);
        const double solver_tolerance = 0.01 * acceptance_tolerance;
        auto apply = [&](const std::vector<double> &values,
                         std::vector<double> &result) -> SolveResult {
            Observation observation;
            if (auto status = compute_observation(problem,
                                                  validated,
                                                  unflatten(values),
                                                  observation);
                !status.ok()) {
                return status;
            }
            result = flatten_integrated(observation.residual_a_per_m3, validated.volume_m3);
            for (std::size_t index = 0; index < result.size(); ++index) {
                result[index] -= affine[index];
            }
            return {Status::ok, {}, {}};
        };
        std::vector<double> flat_solution;
        std::size_t iterations = 0;
        double recursive_residual = rhs_norm;
        if (rhs_norm <= solver_tolerance) {
            flat_solution.assign(3 * validated.count, 0.0);
            recursive_residual = rhs_norm;
        } else if (auto result = detail::block_gmres(rhs,
                                                     options,
                                                     solver_tolerance,
                                                     apply,
                                                     flat_solution,
                                                     iterations,
                                                     recursive_residual);
                   !result.ok()) {
            return result;
        }
        const auto spin_potential = unflatten(flat_solution);
        Observation final_observation;
        if (auto result = compute_observation(problem,
                                              validated,
                                              spin_potential,
                                              final_observation);
            !result.ok()) {
            return result;
        }
        final_observation.diagnostics.iterations = iterations;
        final_observation.diagnostics.gmres_restart = options.gmres_restart;
        final_observation.diagnostics.initial_rhs_integrated_l2_a = rhs_norm;
        final_observation.diagnostics.recursive_residual_integrated_l2_a =
            recursive_residual;
        final_observation.diagnostics.balance_tolerance_integrated_l2_a =
            acceptance_tolerance;
        final_observation.diagnostics.convergence_reason =
            "converged_true_residual_and_balance";
        if (final_observation.diagnostics.recomputed_balance_integrated_l2_a >
            acceptance_tolerance) {
            return failure(Status::did_not_converge,
                           "independently recomputed transport_balance_integrated_l2.v1 exceeds the spin tolerance");
        }
        const auto local_gate = detail::evaluate_local_residual_gate(
            final_observation.residual_a_per_m3,
            final_observation.local_scale_a_per_m3,
            options.local_relative_tolerance,
            options.local_absolute_tolerance_a_per_m3);
        final_observation.diagnostics.max_local_residual_tolerance_a_per_m3 =
            local_gate.max_local_residual_tolerance_a_per_m3;
        final_observation.diagnostics.max_relative_local_residual =
            local_gate.max_relative_local_residual;
        if (!local_gate.accepted) {
            return failure(Status::did_not_converge,
                           "independently recomputed transport_balance_local_fv.v1 exceeds a per-cell tolerance");
        }
        const double closure_tolerance =
            std::max(options.absolute_tolerance_a,
                     10.0 * options.relative_tolerance *
                         final_observation.diagnostics.global_balance_scale_a);
        if (norm(final_observation.diagnostics.global_balance_closure_a) >
            closure_tolerance) {
            return failure(Status::balance_failure,
                           "global spin/interface/torque balance exceeds its independent gate");
        }
        if (auto result = compute_torque(problem, validated, final_observation); !result.ok()) {
            return result;
        }
        Solution solution;
        solution.spin_potential_v = spin_potential;
        solution.face_spin_current_density_a_per_m2 =
            std::move(final_observation.fluxes);
        solution.interface_fluxes = std::move(final_observation.interfaces);
        solution.reaction_channels = std::move(final_observation.reactions);
        solution.transport_gilbert_torque_per_s =
            std::move(final_observation.torque_per_s);
        solution.diagnostics = final_observation.diagnostics;
        solution.provenance = {api_version,
                               formula_version,
                               operator_version,
                               electric_reconstruction_version,
                               engine_version,
                               residual_version,
                               local_residual_version,
                               interface_version,
                               torque_operator_version};
        return {Status::ok, {}, std::move(solution)};
    } catch (const std::bad_alloc &) {
        return failure(Status::invalid_argument,
                       "spin grid or Krylov buffers exceed available allocation capacity");
    } catch (const std::length_error &) {
        return failure(Status::invalid_argument,
                       "spin grid or Krylov buffer length exceeds the implementation limit");
    }
}

} // namespace fullmag::fdm::cpu::transport::spin::v1
