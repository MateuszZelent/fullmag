#include <fullmag/fdm/cpu/charge_transport_v1.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <new>
#include <numeric>
#include <queue>
#include <stdexcept>
#include <utility>

namespace fullmag::fdm::cpu::transport::v1 {

BoundaryCondition BoundaryCondition::insulating() noexcept {
    return {BoundaryKind::insulating, 0.0};
}

BoundaryCondition BoundaryCondition::voltage(double potential_v) noexcept {
    return {BoundaryKind::voltage_electrode, potential_v};
}

BoundaryCondition BoundaryCondition::total_current(double outward_current_a) noexcept {
    return {BoundaryKind::total_current_electrode, outward_current_a};
}

BoundaryCondition BoundaryCondition::specified_outward_current_density() noexcept {
    return {BoundaryKind::specified_outward_current_density, 0.0};
}

BoundaryCondition &BoundaryConditions::operator[](Face face) noexcept {
    return values[static_cast<std::size_t>(face)];
}

const BoundaryCondition &BoundaryConditions::operator[](Face face) const noexcept {
    return values[static_cast<std::size_t>(face)];
}

OrientedMixingInterface OrientedMixingInterface::one_way(
    StructuredFace face,
    std::size_t from_cell,
    std::size_t to_cell,
    double g_up_s_per_m2,
    double g_down_s_per_m2) noexcept {
    return {face, from_cell, to_cell, g_up_s_per_m2, g_down_s_per_m2};
}

AcceptedChargeSnapshot::AcceptedChargeSnapshot(
    std::uint64_t identity,
    Grid grid,
    std::vector<double> conductivity_s_per_m,
    std::vector<std::uint8_t> active_cells,
    std::vector<double> potential_v,
    FaceCurrentDensity face_current_density_a_per_m2,
    std::vector<OrientedMixingInterface> interfaces,
    std::vector<ChargeInterfaceFluxObservation> interface_fluxes)
    : identity_(identity),
      grid_(grid),
      conductivity_s_per_m_(std::move(conductivity_s_per_m)),
      active_cells_(std::move(active_cells)),
      potential_v_(std::move(potential_v)),
      face_current_density_a_per_m2_(std::move(face_current_density_a_per_m2)),
      interfaces_(std::move(interfaces)),
      interface_fluxes_(std::move(interface_fluxes)) {}

namespace {

constexpr std::size_t no_component = std::numeric_limits<std::size_t>::max();

struct DomainAnalysis {
    std::vector<std::uint8_t> conducting;
    std::vector<std::size_t> component_of_cell;
    std::vector<std::vector<std::size_t>> component_cells;
    std::vector<std::uint8_t> component_anchored;
    std::array<std::vector<std::size_t>, 6> boundary_cells;
    std::array<BoundaryCondition, 6> boundary;
    std::array<std::size_t, 3> face_counts{};
    std::array<std::vector<const OrientedMixingInterface *>, 3> interface_by_face;
    std::array<std::vector<const SpecifiedOutwardCurrentDensityFace *>, 3>
        outward_density_by_face;
    std::array<std::size_t, 6> outward_density_count_by_boundary{};
};

struct OperatorWorkspace {
    FaceCurrentDensity fluxes;
    std::vector<double> divergence;
};

SolveResult failure(Status status, std::string message) {
    SolveResult result;
    result.status = status;
    result.message = std::move(message);
    return result;
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

bool face_counts(const Grid &grid, std::array<std::size_t, 3> &counts) {
    std::size_t nx_faces = 0;
    std::size_t ny_faces = 0;
    std::size_t nz_faces = 0;
    std::size_t scratch = 0;
    if (!checked_add(grid.nx, 1, nx_faces) ||
        !checked_multiply(nx_faces, grid.ny, scratch) ||
        !checked_multiply(scratch, grid.nz, counts[0]) ||
        !checked_add(grid.ny, 1, ny_faces) ||
        !checked_multiply(grid.nx, ny_faces, scratch) ||
        !checked_multiply(scratch, grid.nz, counts[1]) ||
        !checked_add(grid.nz, 1, nz_faces) ||
        !checked_multiply(grid.nx, grid.ny, scratch) ||
        !checked_multiply(scratch, nz_faces, counts[2])) {
        return false;
    }
    return true;
}

bool cell_count(const Grid &grid, std::size_t &count) {
    std::size_t xy = 0;
    return checked_multiply(grid.nx, grid.ny, xy) && checked_multiply(xy, grid.nz, count);
}

std::size_t cell_index(const Grid &grid, std::size_t x, std::size_t y, std::size_t z) {
    return x + grid.nx * (y + grid.ny * z);
}

bool structured_face_index(const Grid &grid,
                           const StructuredFace &face,
                           std::size_t &result) {
    std::size_t count = 0;
    if (!cell_count(grid, count) || face.axis > 2 ||
        face.negative_cell >= count || face.positive_cell >= count) {
        return false;
    }
    const auto coordinates = [&grid](std::size_t cell) {
        const std::size_t x = cell % grid.nx;
        const std::size_t yz = cell / grid.nx;
        return std::array<std::size_t, 3>{x, yz % grid.ny, yz / grid.ny};
    };
    const auto negative = coordinates(face.negative_cell);
    const auto positive = coordinates(face.positive_cell);
    for (std::size_t axis = 0; axis < 3; ++axis) {
        if (axis == face.axis) {
            if (negative[axis] + 1 != positive[axis]) {
                return false;
            }
        } else if (negative[axis] != positive[axis]) {
            return false;
        }
    }
    if (face.axis == 0) {
        result = positive[0] + (grid.nx + 1) *
                                   (negative[1] + grid.ny * negative[2]);
    } else if (face.axis == 1) {
        result = negative[0] + grid.nx *
                                  (positive[1] + (grid.ny + 1) * negative[2]);
    } else {
        result = negative[0] + grid.nx *
                                  (negative[1] + grid.ny * positive[2]);
    }
    return true;
}

bool is_min_face(Face face) {
    return face == Face::x_min || face == Face::y_min || face == Face::z_min;
}

double face_area(const Grid &grid, Face face);

Face external_face_side(std::size_t axis, std::int32_t outward_normal_sign) {
    if (axis == 0) {
        return outward_normal_sign < 0 ? Face::x_min : Face::x_max;
    }
    if (axis == 1) {
        return outward_normal_sign < 0 ? Face::y_min : Face::y_max;
    }
    return outward_normal_sign < 0 ? Face::z_min : Face::z_max;
}

bool validate_external_face(const Grid &grid,
                            const StructuredExternalFace &face,
                            Face &side) {
    std::size_t count = 0;
    if (!cell_count(grid, count) || face.axis > 2 || face.adjacent_cell >= count ||
        (face.outward_normal_sign != -1 && face.outward_normal_sign != 1)) {
        return false;
    }
    const std::size_t x = face.adjacent_cell % grid.nx;
    const std::size_t yz = face.adjacent_cell / grid.nx;
    const std::size_t y = yz % grid.ny;
    const std::size_t z = yz / grid.ny;
    const std::array<std::size_t, 3> coordinate{x, y, z};
    const std::array<std::size_t, 3> extent{grid.nx, grid.ny, grid.nz};
    const bool on_expected_side = face.outward_normal_sign < 0
                                      ? coordinate[face.axis] == 0
                                      : coordinate[face.axis] + 1 == extent[face.axis];
    if (!on_expected_side) {
        return false;
    }
    std::size_t expected_index = 0;
    if (face.axis == 0) {
        const std::size_t fx = face.outward_normal_sign < 0 ? 0 : grid.nx;
        expected_index = fx + (grid.nx + 1) * (y + grid.ny * z);
    } else if (face.axis == 1) {
        const std::size_t fy = face.outward_normal_sign < 0 ? 0 : grid.ny;
        expected_index = x + grid.nx * (fy + (grid.ny + 1) * z);
    } else {
        const std::size_t fz = face.outward_normal_sign < 0 ? 0 : grid.nz;
        expected_index = x + grid.nx * (y + grid.ny * fz);
    }
    side = external_face_side(face.axis, face.outward_normal_sign);
    return face.face_index == expected_index && face.area_m2 == face_area(grid, side);
}

double face_spacing(const Grid &grid, Face face) {
    if (face == Face::x_min || face == Face::x_max) {
        return grid.dx_m;
    }
    if (face == Face::y_min || face == Face::y_max) {
        return grid.dy_m;
    }
    return grid.dz_m;
}

double face_area(const Grid &grid, Face face) {
    if (face == Face::x_min || face == Face::x_max) {
        return grid.dy_m * grid.dz_m;
    }
    if (face == Face::y_min || face == Face::y_max) {
        return grid.dx_m * grid.dz_m;
    }
    return grid.dx_m * grid.dy_m;
}

std::vector<std::size_t> neighboring_cells(const Grid &grid, std::size_t cell) {
    const std::size_t x = cell % grid.nx;
    const std::size_t yz = cell / grid.nx;
    const std::size_t y = yz % grid.ny;
    const std::size_t z = yz / grid.ny;
    std::vector<std::size_t> neighbors;
    neighbors.reserve(6);
    if (x > 0) {
        neighbors.push_back(cell_index(grid, x - 1, y, z));
    }
    if (x + 1 < grid.nx) {
        neighbors.push_back(cell_index(grid, x + 1, y, z));
    }
    if (y > 0) {
        neighbors.push_back(cell_index(grid, x, y - 1, z));
    }
    if (y + 1 < grid.ny) {
        neighbors.push_back(cell_index(grid, x, y + 1, z));
    }
    if (z > 0) {
        neighbors.push_back(cell_index(grid, x, y, z - 1));
    }
    if (z + 1 < grid.nz) {
        neighbors.push_back(cell_index(grid, x, y, z + 1));
    }
    return neighbors;
}

const OrientedMixingInterface *interface_between(const Grid &grid,
                                                 const DomainAnalysis &analysis,
                                                 std::size_t left,
                                                 std::size_t right) {
    const auto coordinates = [&grid](std::size_t cell) {
        const std::size_t x = cell % grid.nx;
        const std::size_t yz = cell / grid.nx;
        return std::array<std::size_t, 3>{x, yz % grid.ny, yz / grid.ny};
    };
    const auto left_coordinates = coordinates(left);
    const auto right_coordinates = coordinates(right);
    std::size_t axis = 0;
    while (axis < 3 && left_coordinates[axis] == right_coordinates[axis]) {
        ++axis;
    }
    if (axis == 3) {
        return nullptr;
    }
    const std::size_t negative = left_coordinates[axis] < right_coordinates[axis]
                                     ? left
                                     : right;
    const std::size_t positive = negative == left ? right : left;
    std::size_t face = 0;
    if (!structured_face_index(grid, {axis, negative, positive}, face)) {
        return nullptr;
    }
    return analysis.interface_by_face[axis][face];
}

void populate_boundary_cells(const Problem &problem, DomainAnalysis &analysis) {
    const auto &grid = problem.grid;
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            analysis.boundary_cells[static_cast<std::size_t>(Face::x_min)].push_back(
                cell_index(grid, 0, y, z));
            analysis.boundary_cells[static_cast<std::size_t>(Face::x_max)].push_back(
                cell_index(grid, grid.nx - 1, y, z));
        }
    }
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t x = 0; x < grid.nx; ++x) {
            analysis.boundary_cells[static_cast<std::size_t>(Face::y_min)].push_back(
                cell_index(grid, x, 0, z));
            analysis.boundary_cells[static_cast<std::size_t>(Face::y_max)].push_back(
                cell_index(grid, x, grid.ny - 1, z));
        }
    }
    for (std::size_t y = 0; y < grid.ny; ++y) {
        for (std::size_t x = 0; x < grid.nx; ++x) {
            analysis.boundary_cells[static_cast<std::size_t>(Face::z_min)].push_back(
                cell_index(grid, x, y, 0));
            analysis.boundary_cells[static_cast<std::size_t>(Face::z_max)].push_back(
                cell_index(grid, x, y, grid.nz - 1));
        }
    }
}

SolveResult analyze_problem(const Problem &problem,
                            const SolverOptions &options,
                            DomainAnalysis &analysis) {
    const auto &grid = problem.grid;
    if (grid.nx == 0 || grid.ny == 0 || grid.nz == 0 ||
        !std::isfinite(grid.dx_m) || !std::isfinite(grid.dy_m) ||
        !std::isfinite(grid.dz_m) || grid.dx_m <= 0.0 || grid.dy_m <= 0.0 ||
        grid.dz_m <= 0.0) {
        return failure(Status::invalid_argument,
                       "charge grid counts and cell dimensions must be positive and finite");
    }
    const double cell_volume_m3 = grid.dx_m * grid.dy_m * grid.dz_m;
    if (!std::isfinite(cell_volume_m3) || cell_volume_m3 <= 0.0 ||
        !std::isfinite(grid.dx_m * grid.dy_m) ||
        !std::isfinite(grid.dx_m * grid.dz_m) ||
        !std::isfinite(grid.dy_m * grid.dz_m)) {
        return failure(Status::invalid_argument,
                       "charge cell volume and face areas must be positive and finite");
    }
    std::size_t count = 0;
    if (!cell_count(grid, count)) {
        return failure(Status::invalid_argument, "charge grid cell count overflows size_t");
    }
    if (!face_counts(grid, analysis.face_counts)) {
        return failure(Status::invalid_argument, "charge grid face count overflows size_t");
    }
    for (std::size_t axis = 0; axis < 3; ++axis) {
        analysis.interface_by_face[axis].assign(analysis.face_counts[axis], nullptr);
        analysis.outward_density_by_face[axis].assign(analysis.face_counts[axis], nullptr);
    }
    if (problem.conductivity_s_per_m.size() != count ||
        problem.active_cells.size() != count) {
        return failure(Status::invalid_argument,
                       "charge conductivity and active mask must contain one value per cell");
    }
    if (!std::isfinite(options.relative_tolerance) || options.relative_tolerance <= 0.0 ||
        !std::isfinite(options.absolute_tolerance_a_per_m3) ||
        options.absolute_tolerance_a_per_m3 < 0.0 || options.max_iterations == 0) {
        return failure(Status::invalid_argument,
                       "charge relative tolerance must be finite and positive; absolute tolerance must be finite and non-negative; max_iterations must be positive");
    }

    analysis.conducting.assign(count, 0);
    for (std::size_t cell = 0; cell < count; ++cell) {
        const double conductivity = problem.conductivity_s_per_m[cell];
        if (!std::isfinite(conductivity) || conductivity < 0.0) {
            return failure(Status::invalid_argument,
                           "charge conductivity must be finite and non-negative");
        }
        analysis.conducting[cell] =
            static_cast<std::uint8_t>(problem.active_cells[cell] != 0 && conductivity > 0.0);
    }
    if (std::none_of(analysis.conducting.begin(),
                     analysis.conducting.end(),
                     [](std::uint8_t value) { return value != 0; })) {
        return failure(Status::invalid_argument,
                       "charge transport requires at least one active conducting cell");
    }

    for (const auto &interface : problem.interfaces) {
        std::size_t face = 0;
        if (!structured_face_index(grid, interface.face, face) ||
            (interface.from_cell != interface.face.negative_cell &&
             interface.from_cell != interface.face.positive_cell) ||
            (interface.to_cell != interface.face.negative_cell &&
             interface.to_cell != interface.face.positive_cell) ||
            interface.from_cell == interface.to_cell) {
            return failure(Status::invalid_argument,
                           "charge mixing interface must name one adjacent oriented internal face and opposite from/to cells");
        }
        if (!analysis.conducting[interface.face.negative_cell] ||
            !analysis.conducting[interface.face.positive_cell]) {
            return failure(Status::invalid_argument,
                           "charge mixing interface requires two active conducting cells");
        }
        const double interface_conductance =
            interface.g_up_s_per_m2 + interface.g_down_s_per_m2;
        if (!std::isfinite(interface.g_up_s_per_m2) ||
            !std::isfinite(interface.g_down_s_per_m2) ||
            interface.g_up_s_per_m2 < 0.0 || interface.g_down_s_per_m2 < 0.0 ||
            !std::isfinite(interface_conductance)) {
            return failure(Status::invalid_argument,
                           "charge mixing G_up/G_down must be finite, non-negative, and have a finite sum");
        }
        auto &owner = analysis.interface_by_face[interface.face.axis][face];
        if (owner != nullptr) {
            return failure(Status::invalid_argument,
                           "a charge face may have only one oriented mixing-interface owner");
        }
        owner = &interface;
    }

    const bool any_unset = std::any_of(problem.boundary.values.begin(),
                                       problem.boundary.values.end(),
                                       [](const BoundaryCondition &condition) {
                                           return condition.kind == BoundaryKind::unset;
                                       });
    if (any_unset) {
        return failure(Status::invalid_argument,
                       "FDM charge requires explicit coverage of all six boundary faces; no natural insulating default is inserted");
    }
    for (std::size_t face = 0; face < analysis.boundary.size(); ++face) {
        analysis.boundary[face] = problem.boundary.values[face];
    }
    for (const auto &condition : analysis.boundary) {
        if (!std::isfinite(condition.value)) {
            return failure(Status::invalid_argument, "charge boundary values must be finite");
        }
        if (condition.kind != BoundaryKind::insulating &&
            condition.kind != BoundaryKind::voltage_electrode &&
            condition.kind != BoundaryKind::total_current_electrode &&
            condition.kind != BoundaryKind::specified_outward_current_density) {
            return failure(Status::invalid_argument, "unknown charge boundary kind");
        }
    }
    for (const auto &specified : problem.specified_outward_current_density_faces) {
        Face side = Face::x_min;
        if (!std::isfinite(specified.outward_current_density_a_per_m2) ||
            !std::isfinite(specified.face.area_m2) || specified.face.area_m2 <= 0.0 ||
            !validate_external_face(grid, specified.face, side)) {
            return failure(Status::invalid_argument,
                           "specified outward current density requires one exact external face with canonical index, adjacent cell, outward sign, and area");
        }
        if (analysis.boundary[static_cast<std::size_t>(side)].kind !=
            BoundaryKind::specified_outward_current_density) {
            return failure(Status::invalid_argument,
                           "specified outward current density conflicts with the owning boundary condition");
        }
        if (!analysis.conducting[specified.face.adjacent_cell]) {
            return failure(Status::invalid_argument,
                           "specified outward current density requires an active conducting adjacent cell");
        }
        auto &slot = analysis.outward_density_by_face[specified.face.axis]
                                                    [specified.face.face_index];
        if (slot != nullptr) {
            return failure(Status::invalid_argument,
                           "specified outward current density contains a duplicate external face");
        }
        slot = &specified;
        ++analysis.outward_density_count_by_boundary[static_cast<std::size_t>(side)];
    }
    for (std::size_t side = 0; side < analysis.boundary.size(); ++side) {
        const bool expects_density = analysis.boundary[side].kind ==
                                     BoundaryKind::specified_outward_current_density;
        if (expects_density != (analysis.outward_density_count_by_boundary[side] != 0)) {
            return failure(Status::invalid_argument,
                           "specified outward current density boundary requires a non-empty exact-face scope and no unowned density records");
        }
    }

    analysis.component_of_cell.assign(count, no_component);
    for (std::size_t seed = 0; seed < count; ++seed) {
        if (!analysis.conducting[seed] || analysis.component_of_cell[seed] != no_component) {
            continue;
        }
        const std::size_t component = analysis.component_cells.size();
        analysis.component_cells.emplace_back();
        std::queue<std::size_t> queue;
        queue.push(seed);
        analysis.component_of_cell[seed] = component;
        while (!queue.empty()) {
            const std::size_t cell = queue.front();
            queue.pop();
            analysis.component_cells.back().push_back(cell);
            for (std::size_t neighbor : neighboring_cells(grid, cell)) {
                const auto *interface = interface_between(grid, analysis, cell, neighbor);
                const bool charge_connected =
                    interface == nullptr ||
                    interface->g_up_s_per_m2 + interface->g_down_s_per_m2 > 0.0;
                if (charge_connected && analysis.conducting[neighbor] &&
                    analysis.component_of_cell[neighbor] == no_component) {
                    analysis.component_of_cell[neighbor] = component;
                    queue.push(neighbor);
                }
            }
        }
    }
    analysis.component_anchored.assign(analysis.component_cells.size(), 0);
    populate_boundary_cells(problem, analysis);

    std::vector<double> component_prescribed_current_a(analysis.component_cells.size(), 0.0);
    std::vector<double> component_prescribed_current_l1_a(analysis.component_cells.size(), 0.0);
    for (std::size_t face_index = 0; face_index < 6; ++face_index) {
        const auto &condition = analysis.boundary[face_index];
        if (condition.kind == BoundaryKind::insulating ||
            condition.kind == BoundaryKind::specified_outward_current_density) {
            continue;
        }
        std::size_t touched_component = no_component;
        bool has_conducting_face_cell = false;
        for (std::size_t cell : analysis.boundary_cells[face_index]) {
            if (!analysis.conducting[cell]) {
                continue;
            }
            has_conducting_face_cell = true;
            const std::size_t component = analysis.component_of_cell[cell];
            if (condition.kind == BoundaryKind::voltage_electrode) {
                analysis.component_anchored[component] = 1;
            } else if (touched_component == no_component) {
                touched_component = component;
            } else if (touched_component != component) {
                return failure(Status::invalid_argument,
                               "one total-current electrode cannot span disconnected conductor components in charge API v1");
            }
        }
        if (!has_conducting_face_cell) {
            return failure(Status::invalid_argument,
                           "a charge electrode must touch at least one active conducting boundary cell");
        }
        if (condition.kind == BoundaryKind::total_current_electrode) {
            component_prescribed_current_a[touched_component] += condition.value;
            component_prescribed_current_l1_a[touched_component] += std::abs(condition.value);
        }
    }
    for (const auto &specified : problem.specified_outward_current_density_faces) {
        const std::size_t component =
            analysis.component_of_cell[specified.face.adjacent_cell];
        const double current_a =
            specified.outward_current_density_a_per_m2 * specified.face.area_m2;
        component_prescribed_current_a[component] += current_a;
        component_prescribed_current_l1_a[component] += std::abs(current_a);
    }

    for (std::size_t component = 0; component < analysis.component_cells.size(); ++component) {
        if (analysis.component_anchored[component]) {
            continue;
        }
        if (problem.gauge != Gauge::zero_mean) {
            return failure(Status::missing_gauge,
                           "every pure-Neumann conductor component requires an explicit zero-mean gauge");
        }
        const double current = component_prescribed_current_a[component];
        const double scale = component_prescribed_current_l1_a[component];
        const double tolerance = 64.0 * std::numeric_limits<double>::epsilon() * scale;
        if (std::abs(current) > tolerance) {
            return failure(Status::incompatible_boundary_current,
                           "pure-Neumann charge boundary currents must sum to zero on each conductor component");
        }
    }
    return {Status::ok, {}, {}};
}

FaceCurrentDensity allocate_fluxes(const DomainAnalysis &analysis) {
    FaceCurrentDensity fluxes;
    fluxes.x.assign(analysis.face_counts[0], 0.0);
    fluxes.y.assign(analysis.face_counts[1], 0.0);
    fluxes.z.assign(analysis.face_counts[2], 0.0);
    return fluxes;
}

double harmonic_mean(double left, double right) {
    if (left == 0.0 || right == 0.0) {
        return 0.0;
    }
    const double smaller = std::min(left, right);
    const double larger = std::max(left, right);
    return smaller * (2.0 / (1.0 + smaller / larger));
}

double electrode_potential(const Problem &problem,
                           const DomainAnalysis &analysis,
                           Face face,
                           const std::vector<double> &potential) {
    const auto &condition = analysis.boundary[static_cast<std::size_t>(face)];
    if (condition.kind == BoundaryKind::voltage_electrode) {
        return condition.value;
    }
    const double area = face_area(problem.grid, face);
    const double half_width = 0.5 * face_spacing(problem.grid, face);
    double conductance_sum = 0.0;
    double weighted_potential = 0.0;
    for (std::size_t cell : analysis.boundary_cells[static_cast<std::size_t>(face)]) {
        if (!analysis.conducting[cell]) {
            continue;
        }
        const double conductance = problem.conductivity_s_per_m[cell] * area / half_width;
        conductance_sum += conductance;
        weighted_potential += conductance * potential[cell];
    }
    return (weighted_potential - condition.value) / conductance_sum;
}

double boundary_flux(const Problem &problem,
                     const DomainAnalysis &analysis,
                     Face face,
                     std::size_t axis,
                     std::size_t structured_face_index,
                     std::size_t cell,
                     const std::vector<double> &potential,
                     double electrode_v) {
    if (const auto *specified =
            analysis.outward_density_by_face[axis][structured_face_index];
        specified != nullptr) {
        return static_cast<double>(specified->face.outward_normal_sign) *
               specified->outward_current_density_a_per_m2;
    }
    if (!analysis.conducting[cell] ||
        analysis.boundary[static_cast<std::size_t>(face)].kind == BoundaryKind::insulating ||
        analysis.boundary[static_cast<std::size_t>(face)].kind ==
            BoundaryKind::specified_outward_current_density) {
        return 0.0;
    }
    const double outward = problem.conductivity_s_per_m[cell] *
                           (potential[cell] - electrode_v) /
                           (0.5 * face_spacing(problem.grid, face));
    return is_min_face(face) ? -outward : outward;
}

double internal_flux(const Problem &problem,
                     const DomainAnalysis &analysis,
                     std::size_t axis,
                     std::size_t face,
                     std::size_t lower,
                     std::size_t upper,
                     double spacing,
                     const std::vector<double> &potential) {
    if (!analysis.conducting[lower] || !analysis.conducting[upper]) {
        return 0.0;
    }
    if (const auto *interface = analysis.interface_by_face[axis][face];
        interface != nullptr) {
        const double interface_conductance =
            interface->g_up_s_per_m2 + interface->g_down_s_per_m2;
        if (interface_conductance == 0.0) {
            return 0.0;
        }
        const double resistance =
            0.5 * spacing / problem.conductivity_s_per_m[lower] +
            1.0 / interface_conductance +
            0.5 * spacing / problem.conductivity_s_per_m[upper];
        return -(potential[upper] - potential[lower]) / resistance;
    }
    const double conductivity = harmonic_mean(problem.conductivity_s_per_m[lower],
                                              problem.conductivity_s_per_m[upper]);
    return -conductivity * (potential[upper] - potential[lower]) / spacing;
}

void compute_face_fluxes(const Problem &problem,
                         const DomainAnalysis &analysis,
                         const std::vector<double> &potential,
                         FaceCurrentDensity &fluxes) {
    const auto &grid = problem.grid;
    std::array<double, 6> electrode_v{};
    for (std::size_t face = 0; face < 6; ++face) {
        if (analysis.boundary[face].kind == BoundaryKind::voltage_electrode ||
            analysis.boundary[face].kind == BoundaryKind::total_current_electrode) {
            electrode_v[face] = electrode_potential(problem,
                                                     analysis,
                                                     static_cast<Face>(face),
                                                     potential);
        }
    }

    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t face_x = 0; face_x <= grid.nx; ++face_x) {
                const std::size_t face = face_x + (grid.nx + 1) * (y + grid.ny * z);
                if (face_x == 0) {
                    const std::size_t cell = cell_index(grid, 0, y, z);
                    fluxes.x[face] = boundary_flux(problem,
                                                  analysis,
                                                  Face::x_min,
                                                  0,
                                                  face,
                                                  cell,
                                                  potential,
                                                  electrode_v[0]);
                } else if (face_x == grid.nx) {
                    const std::size_t cell = cell_index(grid, grid.nx - 1, y, z);
                    fluxes.x[face] = boundary_flux(problem,
                                                  analysis,
                                                  Face::x_max,
                                                  0,
                                                  face,
                                                  cell,
                                                  potential,
                                                  electrode_v[1]);
                } else {
                    fluxes.x[face] = internal_flux(problem,
                                                  analysis,
                                                  0,
                                                  face,
                                                  cell_index(grid, face_x - 1, y, z),
                                                  cell_index(grid, face_x, y, z),
                                                  grid.dx_m,
                                                  potential);
                }
            }
        }
    }
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t face_y = 0; face_y <= grid.ny; ++face_y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t face = x + grid.nx * (face_y + (grid.ny + 1) * z);
                if (face_y == 0) {
                    const std::size_t cell = cell_index(grid, x, 0, z);
                    fluxes.y[face] = boundary_flux(problem,
                                                  analysis,
                                                  Face::y_min,
                                                  1,
                                                  face,
                                                  cell,
                                                  potential,
                                                  electrode_v[2]);
                } else if (face_y == grid.ny) {
                    const std::size_t cell = cell_index(grid, x, grid.ny - 1, z);
                    fluxes.y[face] = boundary_flux(problem,
                                                  analysis,
                                                  Face::y_max,
                                                  1,
                                                  face,
                                                  cell,
                                                  potential,
                                                  electrode_v[3]);
                } else {
                    fluxes.y[face] = internal_flux(problem,
                                                  analysis,
                                                  1,
                                                  face,
                                                  cell_index(grid, x, face_y - 1, z),
                                                  cell_index(grid, x, face_y, z),
                                                  grid.dy_m,
                                                  potential);
                }
            }
        }
    }
    for (std::size_t face_z = 0; face_z <= grid.nz; ++face_z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t face = x + grid.nx * (y + grid.ny * face_z);
                if (face_z == 0) {
                    const std::size_t cell = cell_index(grid, x, y, 0);
                    fluxes.z[face] = boundary_flux(problem,
                                                  analysis,
                                                  Face::z_min,
                                                  2,
                                                  face,
                                                  cell,
                                                  potential,
                                                  electrode_v[4]);
                } else if (face_z == grid.nz) {
                    const std::size_t cell = cell_index(grid, x, y, grid.nz - 1);
                    fluxes.z[face] = boundary_flux(problem,
                                                  analysis,
                                                  Face::z_max,
                                                  2,
                                                  face,
                                                  cell,
                                                  potential,
                                                  electrode_v[5]);
                } else {
                    fluxes.z[face] = internal_flux(problem,
                                                  analysis,
                                                  2,
                                                  face,
                                                  cell_index(grid, x, y, face_z - 1),
                                                  cell_index(grid, x, y, face_z),
                                                  grid.dz_m,
                                                  potential);
                }
            }
        }
    }
}

void compute_divergence(const Problem &problem,
                        const DomainAnalysis &analysis,
                        const FaceCurrentDensity &fluxes,
                        std::vector<double> &divergence) {
    const auto &grid = problem.grid;
    std::fill(divergence.begin(), divergence.end(), 0.0);
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t cell = cell_index(grid, x, y, z);
                if (!analysis.conducting[cell]) {
                    continue;
                }
                const std::size_t x0 = x + (grid.nx + 1) * (y + grid.ny * z);
                const std::size_t y0 = x + grid.nx * (y + (grid.ny + 1) * z);
                const std::size_t z0 = x + grid.nx * (y + grid.ny * z);
                divergence[cell] =
                    (fluxes.x[x0 + 1] - fluxes.x[x0]) / grid.dx_m +
                    (fluxes.y[y0 + grid.nx] - fluxes.y[y0]) / grid.dy_m +
                    (fluxes.z[z0 + grid.nx * grid.ny] - fluxes.z[z0]) / grid.dz_m;
            }
        }
    }
}

void apply_residual(const Problem &problem,
                    const DomainAnalysis &analysis,
                    const std::vector<double> &potential,
                    OperatorWorkspace &workspace) {
    compute_face_fluxes(problem, analysis, potential, workspace.fluxes);
    compute_divergence(problem, analysis, workspace.fluxes, workspace.divergence);
}

double dot_conducting(const std::vector<double> &left,
                      const std::vector<double> &right,
                      const DomainAnalysis &analysis) {
    double result = 0.0;
    for (std::size_t cell = 0; cell < left.size(); ++cell) {
        if (analysis.conducting[cell]) {
            result += left[cell] * right[cell];
        }
    }
    return result;
}

double l2_conducting(const std::vector<double> &values,
                     const DomainAnalysis &analysis) {
    double scale = 0.0;
    double sum_squares = 1.0;
    for (std::size_t cell = 0; cell < values.size(); ++cell) {
        if (!analysis.conducting[cell] || values[cell] == 0.0) {
            continue;
        }
        const double magnitude = std::abs(values[cell]);
        if (!std::isfinite(magnitude)) {
            return std::numeric_limits<double>::quiet_NaN();
        }
        if (scale < magnitude) {
            const double ratio = scale / magnitude;
            sum_squares = 1.0 + sum_squares * ratio * ratio;
            scale = magnitude;
        } else {
            const double ratio = magnitude / scale;
            sum_squares += ratio * ratio;
        }
    }
    return scale == 0.0 ? 0.0 : scale * std::sqrt(sum_squares);
}

bool all_finite(const std::vector<double> &values) {
    return std::all_of(values.begin(), values.end(), [](double value) {
        return std::isfinite(value);
    });
}

bool workspace_is_finite(const OperatorWorkspace &workspace) {
    return all_finite(workspace.fluxes.x) && all_finite(workspace.fluxes.y) &&
           all_finite(workspace.fluxes.z) && all_finite(workspace.divergence);
}

std::vector<ChargeInterfaceFluxObservation> interface_observations(
    const Problem &problem,
    const std::vector<double> &potential,
    const FaceCurrentDensity &fluxes) {
    std::vector<ChargeInterfaceFluxObservation> observations;
    observations.reserve(problem.interfaces.size());
    for (const auto &interface : problem.interfaces) {
        std::size_t face = 0;
        if (!structured_face_index(problem.grid, interface.face, face)) {
            throw std::logic_error("validated charge interface lost its structured face");
        }
        const double global_current = interface.face.axis == 0 ? fluxes.x[face]
                                      : interface.face.axis == 1 ? fluxes.y[face]
                                                                 : fluxes.z[face];
        const bool from_is_negative =
            interface.from_cell == interface.face.negative_cell;
        const double from_to_current = from_is_negative ? global_current : -global_current;
        const double spacing = interface.face.axis == 0 ? problem.grid.dx_m
                               : interface.face.axis == 1 ? problem.grid.dy_m
                                                          : problem.grid.dz_m;
        const double from_trace =
            potential[interface.from_cell] -
            from_to_current * 0.5 * spacing /
                problem.conductivity_s_per_m[interface.from_cell];
        const double to_trace =
            potential[interface.to_cell] +
            from_to_current * 0.5 * spacing /
                problem.conductivity_s_per_m[interface.to_cell];
        observations.push_back({interface.face,
                                interface.from_cell,
                                interface.to_cell,
                                interface.g_up_s_per_m2,
                                interface.g_down_s_per_m2,
                                from_trace,
                                to_trace,
                                from_trace - to_trace,
                                from_to_current,
                                global_current});
    }
    return observations;
}

void project_unanchored_zero_mean(std::vector<double> &values,
                                  const DomainAnalysis &analysis) {
    for (std::size_t component = 0; component < analysis.component_cells.size(); ++component) {
        if (analysis.component_anchored[component]) {
            continue;
        }
        const auto &cells = analysis.component_cells[component];
        double mean = 0.0;
        for (std::size_t cell : cells) {
            mean += values[cell];
        }
        mean /= static_cast<double>(cells.size());
        for (std::size_t cell : cells) {
            values[cell] -= mean;
        }
    }
}

Diagnostics diagnostics(const Problem &problem,
                        const DomainAnalysis &analysis,
                        const FaceCurrentDensity &fluxes,
                        const std::vector<double> &physical_residual,
                        std::size_t iterations,
                        double recursive_algebraic_residual,
                        double recomputed_algebraic_residual,
                        double algebraic_tolerance) {
    Diagnostics result;
    result.iterations = iterations;
    result.algebraic_residual_l2_a_per_m3 = recursive_algebraic_residual;
    result.recomputed_algebraic_residual_l2_a_per_m3 = recomputed_algebraic_residual;
    result.algebraic_tolerance_l2_a_per_m3 = algebraic_tolerance;
    result.physical_residual_l2_a_per_m3 = l2_conducting(physical_residual, analysis);
    const double cell_volume_m3 = problem.grid.dx_m * problem.grid.dy_m * problem.grid.dz_m;
    double integrated_sum_squares_a2 = 0.0;
    result.component_net_current_a.assign(analysis.component_cells.size(), 0.0);
    result.component_balance_integrated_l2_a.assign(
        analysis.component_cells.size(), 0.0);
    result.component_boundary_current_l1_a.assign(analysis.component_cells.size(), 0.0);
    result.max_abs_divergence_a_per_m3 = 0.0;
    for (std::size_t cell = 0; cell < physical_residual.size(); ++cell) {
        if (analysis.conducting[cell]) {
            result.max_abs_divergence_a_per_m3 =
                std::max(result.max_abs_divergence_a_per_m3,
                         std::abs(physical_residual[cell]));
            const double imbalance_a = std::abs(physical_residual[cell] * cell_volume_m3);
            result.component_net_current_a[analysis.component_of_cell[cell]] +=
                physical_residual[cell] * cell_volume_m3;
            result.component_balance_integrated_l2_a[
                analysis.component_of_cell[cell]] += imbalance_a * imbalance_a;
            result.max_cell_current_imbalance_a =
                std::max(result.max_cell_current_imbalance_a, imbalance_a);
            integrated_sum_squares_a2 += imbalance_a * imbalance_a;
        }
    }

    const auto &grid = problem.grid;
    const double area_x = grid.dy_m * grid.dz_m;
    const double area_y = grid.dx_m * grid.dz_m;
    const double area_z = grid.dx_m * grid.dy_m;
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            const std::size_t min_cell = cell_index(grid, 0, y, z);
            const std::size_t max_cell = cell_index(grid, grid.nx - 1, y, z);
            const double min_current =
                -fluxes.x[(grid.nx + 1) * (y + grid.ny * z)] * area_x;
            const double max_current =
                fluxes.x[grid.nx + (grid.nx + 1) * (y + grid.ny * z)] * area_x;
            result.boundary_outward_current_a[0] += min_current;
            result.boundary_outward_current_a[1] += max_current;
            if (analysis.conducting[min_cell]) {
                result.component_boundary_current_l1_a[
                    analysis.component_of_cell[min_cell]] += std::abs(min_current);
            }
            if (analysis.conducting[max_cell]) {
                result.component_boundary_current_l1_a[
                    analysis.component_of_cell[max_cell]] += std::abs(max_current);
            }
        }
    }
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t x = 0; x < grid.nx; ++x) {
            const std::size_t min_cell = cell_index(grid, x, 0, z);
            const std::size_t max_cell = cell_index(grid, x, grid.ny - 1, z);
            const double min_current =
                -fluxes.y[x + grid.nx * ((grid.ny + 1) * z)] * area_y;
            const double max_current =
                fluxes.y[x + grid.nx * (grid.ny + (grid.ny + 1) * z)] * area_y;
            result.boundary_outward_current_a[2] += min_current;
            result.boundary_outward_current_a[3] += max_current;
            if (analysis.conducting[min_cell]) {
                result.component_boundary_current_l1_a[
                    analysis.component_of_cell[min_cell]] += std::abs(min_current);
            }
            if (analysis.conducting[max_cell]) {
                result.component_boundary_current_l1_a[
                    analysis.component_of_cell[max_cell]] += std::abs(max_current);
            }
        }
    }
    for (std::size_t y = 0; y < grid.ny; ++y) {
        for (std::size_t x = 0; x < grid.nx; ++x) {
            const std::size_t min_cell = cell_index(grid, x, y, 0);
            const std::size_t max_cell = cell_index(grid, x, y, grid.nz - 1);
            const double min_current = -fluxes.z[x + grid.nx * y] * area_z;
            const double max_current =
                fluxes.z[x + grid.nx * (y + grid.ny * grid.nz)] * area_z;
            result.boundary_outward_current_a[4] += min_current;
            result.boundary_outward_current_a[5] += max_current;
            if (analysis.conducting[min_cell]) {
                result.component_boundary_current_l1_a[
                    analysis.component_of_cell[min_cell]] += std::abs(min_current);
            }
            if (analysis.conducting[max_cell]) {
                result.component_boundary_current_l1_a[
                    analysis.component_of_cell[max_cell]] += std::abs(max_current);
            }
        }
    }
    result.net_boundary_current_a =
        std::accumulate(result.boundary_outward_current_a.begin(),
                        result.boundary_outward_current_a.end(),
                        0.0);
    result.boundary_current_l1_a =
        std::accumulate(result.boundary_outward_current_a.begin(),
                        result.boundary_outward_current_a.end(),
                        0.0,
                        [](double sum, double value) { return sum + std::abs(value); });
    result.physical_balance_integrated_l2_a = std::sqrt(integrated_sum_squares_a2);
    for (double &component_l2_a : result.component_balance_integrated_l2_a) {
        component_l2_a = std::sqrt(component_l2_a);
    }
    const double relative_balance_tolerance =
        1.0e-10 * result.boundary_current_l1_a;
    const double roundoff_balance_tolerance =
        64.0 * std::numeric_limits<double>::epsilon() * result.boundary_current_l1_a;
    result.physical_balance_tolerance_l2_a =
        relative_balance_tolerance + roundoff_balance_tolerance;
    result.max_cell_current_imbalance_tolerance_a =
        relative_balance_tolerance + roundoff_balance_tolerance;
    result.component_net_current_tolerance_a.reserve(
        result.component_boundary_current_l1_a.size());
    for (double local_l1_a : result.component_boundary_current_l1_a) {
        result.component_net_current_tolerance_a.push_back(
            1.0e-10 * local_l1_a +
            64.0 * std::numeric_limits<double>::epsilon() * local_l1_a);
    }
    result.net_boundary_tolerance_a =
        relative_balance_tolerance + roundoff_balance_tolerance;
    return result;
}

} // namespace

std::vector<CellCurrentDensity>
reconstruct_cell_current_density(const Grid &grid,
                                 const FaceCurrentDensity &face_current_density) {
    std::size_t count = 0;
    std::array<std::size_t, 3> expected_faces{};
    if (!cell_count(grid, count) || !face_counts(grid, expected_faces) ||
        face_current_density.x.size() != expected_faces[0] ||
        face_current_density.y.size() != expected_faces[1] ||
        face_current_density.z.size() != expected_faces[2]) {
        throw std::invalid_argument("charge face-current dimensions do not match the grid");
    }
    std::vector<CellCurrentDensity> result(count);
    for (std::size_t z = 0; z < grid.nz; ++z) {
        for (std::size_t y = 0; y < grid.ny; ++y) {
            for (std::size_t x = 0; x < grid.nx; ++x) {
                const std::size_t cell = cell_index(grid, x, y, z);
                const std::size_t x_low = x + (grid.nx + 1) * (y + grid.ny * z);
                const std::size_t x_high = x_low + 1;
                const std::size_t y_low = x + grid.nx * (y + (grid.ny + 1) * z);
                const std::size_t y_high = y_low + grid.nx;
                const std::size_t z_low = x + grid.nx * (y + grid.ny * z);
                const std::size_t z_high = z_low + grid.nx * grid.ny;
                result[cell] = {
                    0.5 * (face_current_density.x[x_low] +
                           face_current_density.x[x_high]),
                    0.5 * (face_current_density.y[y_low] +
                           face_current_density.y[y_high]),
                    0.5 * (face_current_density.z[z_low] +
                           face_current_density.z[z_high]),
                };
            }
        }
    }
    return result;
}

SolveResult solve(const Problem &problem, const SolverOptions &options) {
    try {
    DomainAnalysis analysis;
    if (auto validation = analyze_problem(problem, options, analysis); !validation.ok()) {
        return validation;
    }

    const std::size_t count = problem.conductivity_s_per_m.size();
    OperatorWorkspace workspace{allocate_fluxes(analysis), std::vector<double>(count, 0.0)};
    std::vector<double> potential(count, 0.0);
    apply_residual(problem, analysis, potential, workspace);
    if (!workspace_is_finite(workspace)) {
        return failure(Status::numerical_failure,
                       "charge operator produced a non-finite affine residual");
    }
    const std::vector<double> affine_offset = workspace.divergence;
    std::vector<double> rhs(count, 0.0);
    for (std::size_t cell = 0; cell < count; ++cell) {
        rhs[cell] = -affine_offset[cell];
    }
    if (!all_finite(rhs)) {
        return failure(Status::numerical_failure, "charge RHS contains a non-finite value");
    }
    const double cell_volume_m3 = problem.grid.dx_m * problem.grid.dy_m * problem.grid.dz_m;
    for (std::size_t component = 0; component < analysis.component_cells.size(); ++component) {
        if (analysis.component_anchored[component]) {
            continue;
        }
        double integrated_sum_a = 0.0;
        double integrated_l1_a = 0.0;
        for (std::size_t cell : analysis.component_cells[component]) {
            const double integrated_rhs_a = rhs[cell] * cell_volume_m3;
            integrated_sum_a += integrated_rhs_a;
            integrated_l1_a += std::abs(integrated_rhs_a);
        }
        const double compatibility_tolerance_a =
            64.0 * std::numeric_limits<double>::epsilon() * integrated_l1_a;
        if (std::abs(integrated_sum_a) > compatibility_tolerance_a) {
            return failure(Status::incompatible_boundary_current,
                           "assembled pure-Neumann charge RHS is incompatible on a conductor component");
        }
    }
    project_unanchored_zero_mean(rhs, analysis);

    const double rhs_norm = l2_conducting(rhs, analysis);
    const double tolerance =
        std::max(options.absolute_tolerance_a_per_m3, options.relative_tolerance * rhs_norm);
    if (!std::isfinite(rhs_norm) || !std::isfinite(tolerance)) {
        return failure(Status::numerical_failure,
                       "charge RHS norm or algebraic tolerance is non-finite");
    }
    std::vector<double> residual = rhs;
    std::vector<double> direction = residual;
    std::vector<double> applied(count, 0.0);
    double residual_squared = dot_conducting(residual, residual, analysis);
    if (!std::isfinite(residual_squared) || residual_squared < 0.0) {
        return failure(Status::numerical_failure,
                       "charge recursive residual norm is non-finite");
    }
    std::size_t iterations = 0;

    while (std::sqrt(residual_squared) > tolerance && iterations < options.max_iterations) {
        apply_residual(problem, analysis, direction, workspace);
        if (!workspace_is_finite(workspace)) {
            return failure(Status::numerical_failure,
                           "charge operator produced a non-finite Krylov vector");
        }
        for (std::size_t cell = 0; cell < count; ++cell) {
            applied[cell] = workspace.divergence[cell] - affine_offset[cell];
        }
        project_unanchored_zero_mean(applied, analysis);
        const double denominator = dot_conducting(direction, applied, analysis);
        if (!std::isfinite(denominator) || denominator <= 0.0) {
            return failure(Status::singular_operator,
                           "charge operator is singular or not positive definite on the gauged conducting domain");
        }
        const double alpha = residual_squared / denominator;
        if (!std::isfinite(alpha)) {
            return failure(Status::numerical_failure, "charge CG alpha is non-finite");
        }
        for (std::size_t cell = 0; cell < count; ++cell) {
            if (analysis.conducting[cell]) {
                potential[cell] += alpha * direction[cell];
                residual[cell] -= alpha * applied[cell];
            }
        }
        project_unanchored_zero_mean(potential, analysis);
        project_unanchored_zero_mean(residual, analysis);
        const double next_squared = dot_conducting(residual, residual, analysis);
        if (!std::isfinite(next_squared) || next_squared < 0.0 ||
            !all_finite(potential) || !all_finite(residual)) {
            return failure(Status::numerical_failure,
                           "charge CG iterate or recursive residual is non-finite");
        }
        ++iterations;
        if (std::sqrt(next_squared) <= tolerance) {
            residual_squared = next_squared;
            break;
        }
        const double beta = next_squared / residual_squared;
        if (!std::isfinite(beta)) {
            return failure(Status::numerical_failure, "charge CG beta is non-finite");
        }
        for (std::size_t cell = 0; cell < count; ++cell) {
            if (analysis.conducting[cell]) {
                direction[cell] = residual[cell] + beta * direction[cell];
            }
        }
        residual_squared = next_squared;
    }
    const double algebraic_residual = std::sqrt(residual_squared);
    if (algebraic_residual > tolerance) {
        return failure(Status::did_not_converge,
                       "charge CG did not converge within the requested iteration budget");
    }

    apply_residual(problem, analysis, potential, workspace);
    if (!workspace_is_finite(workspace) || !all_finite(potential)) {
        return failure(Status::numerical_failure,
                       "charge solution contains a non-finite potential, flux, or balance");
    }
    std::vector<double> recomputed_residual(count, 0.0);
    for (std::size_t cell = 0; cell < count; ++cell) {
        recomputed_residual[cell] =
            rhs[cell] - (workspace.divergence[cell] - affine_offset[cell]);
    }
    project_unanchored_zero_mean(recomputed_residual, analysis);
    const double recomputed_algebraic_residual =
        l2_conducting(recomputed_residual, analysis);
    if (!std::isfinite(recomputed_algebraic_residual)) {
        return failure(Status::numerical_failure,
                       "recomputed charge algebraic residual is non-finite");
    }
    if (recomputed_algebraic_residual > tolerance) {
        return failure(Status::did_not_converge,
                       "recomputed charge algebraic residual exceeds the requested tolerance");
    }
    Solution solution;
    solution.potential_v = std::move(potential);
    solution.face_current_density_a_per_m2 = std::move(workspace.fluxes);
    solution.diagnostics = diagnostics(problem,
                                       analysis,
                                       solution.face_current_density_a_per_m2,
                                       workspace.divergence,
                                       iterations,
                                       algebraic_residual,
                                       recomputed_algebraic_residual,
                                       tolerance);
    const auto &diagnostic = solution.diagnostics;
    if (!std::isfinite(diagnostic.physical_balance_integrated_l2_a) ||
        !std::isfinite(diagnostic.max_cell_current_imbalance_a) ||
        !std::isfinite(diagnostic.net_boundary_current_a)) {
        return failure(Status::numerical_failure,
                       "charge physical balance diagnostics contain a non-finite value");
    }
    bool component_balance_failed = false;
    for (std::size_t component = 0;
         component < diagnostic.component_net_current_a.size();
         ++component) {
        component_balance_failed =
            component_balance_failed ||
            std::abs(diagnostic.component_net_current_a[component]) >
                diagnostic.component_net_current_tolerance_a[component] ||
            diagnostic.component_balance_integrated_l2_a[component] >
                diagnostic.component_net_current_tolerance_a[component];
    }
    if (diagnostic.physical_balance_integrated_l2_a >
            diagnostic.physical_balance_tolerance_l2_a ||
        diagnostic.max_cell_current_imbalance_a >
            diagnostic.max_cell_current_imbalance_tolerance_a ||
        std::abs(diagnostic.net_boundary_current_a) >
            diagnostic.net_boundary_tolerance_a ||
        component_balance_failed) {
        return failure(Status::balance_failure,
                       "charge solution failed an integrated cell or boundary current balance gate");
    }
    for (std::size_t face = 0; face < analysis.boundary.size(); ++face) {
        const auto &condition = analysis.boundary[face];
        if (condition.kind == BoundaryKind::total_current_electrode) {
            solution.resolved_electrode_potentials.push_back(
                {static_cast<Face>(face),
                 electrode_potential(problem,
                                     analysis,
                                     static_cast<Face>(face),
                                     solution.potential_v),
                 condition.value});
        }
    }
    const auto observations = interface_observations(problem,
                                                     solution.potential_v,
                                                     solution.face_current_density_a_per_m2);
    static std::atomic<std::uint64_t> next_snapshot_identity{1};
    const std::uint64_t snapshot_identity =
        next_snapshot_identity.fetch_add(1, std::memory_order_relaxed);
    if (snapshot_identity == 0) {
        return failure(Status::numerical_failure,
                       "accepted charge snapshot identity space was exhausted");
    }
    solution.accepted_snapshot_ = std::shared_ptr<const AcceptedChargeSnapshot>(
        new AcceptedChargeSnapshot(snapshot_identity,
                                   problem.grid,
                                   problem.conductivity_s_per_m,
                                   problem.active_cells,
                                   solution.potential_v,
                                   solution.face_current_density_a_per_m2,
                                   problem.interfaces,
                                   observations));
    solution.provenance = {api_version,
                           operator_version,
                           problem.interfaces.empty() ? std::string_view{}
                                                      : mixing_operator_version,
                           solver_version,
                           residual_version};
    return {Status::ok, {}, std::move(solution)};
    } catch (const std::bad_alloc &) {
        return failure(Status::invalid_argument,
                       "charge grid or face buffers exceed available allocation capacity");
    } catch (const std::length_error &) {
        return failure(Status::invalid_argument,
                       "charge grid or face buffer length exceeds the implementation limit");
    }
}

} // namespace fullmag::fdm::cpu::transport::v1
