#include "fullmag_fdm.h"

#include <fullmag/fdm/cpu/charge_transport_v1.hpp>
#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace charge = fullmag::fdm::cpu::transport::v1;
namespace spin = fullmag::fdm::cpu::transport::spin::v1;

namespace {

constexpr uint64_t kCharge = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
constexpr uint64_t kSpin = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;
constexpr uint64_t kChargeSpin = kCharge | kSpin;
constexpr uint64_t kReadback = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
constexpr double kRelativeTolerance = 2.0e-8;
constexpr double kAbsolutePotentialTolerance = 2.0e-11;
constexpr double kAbsoluteFluxTolerance = 2.0e-7;
constexpr double kAbsoluteTorqueTolerance = 2.0e-3;

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

[[noreturn]] void fail(const std::string &message) {
    throw std::runtime_error(message);
}

void require(bool condition, const std::string &message) {
    if (!condition) fail(message);
}

void require_close(double actual, double expected, double absolute_tolerance,
                   const std::string &what) {
    const double tolerance =
        absolute_tolerance + kRelativeTolerance * std::max(std::abs(actual), std::abs(expected));
    if (!std::isfinite(actual) || !std::isfinite(expected) ||
        std::abs(actual - expected) > tolerance) {
        char values[256]{};
        std::snprintf(values, sizeof(values),
                      ": expected %.17e, got %.17e, difference %.17e, tolerance %.17e",
                      expected, actual, actual - expected, tolerance);
        fail(what + values);
    }
}

struct InterfaceSpec {
    uint32_t kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT;
    uint32_t axis = 0;
    uint64_t negative_cell = 0;
    uint64_t positive_cell = 0;
    uint64_t from_cell = 0;
    uint64_t to_cell = 0;
    double g_up = 0.0;
    double g_down = 0.0;
    double g_r = 0.0;
    double g_i = 0.0;
    std::array<double, 3> magnetization{0.0, 0.0, 1.0};
    uint64_t source_id = 0;
    uint64_t topology_id = 0;
};

struct Scenario {
    std::string name;
    uint64_t nx = 1;
    uint64_t ny = 1;
    uint64_t nz = 1;
    double dx = 1.0e-9;
    double dy = 1.0e-9;
    double dz = 1.0e-9;
    double left_voltage = 0.0;
    double right_voltage = 0.0;
    std::array<double, 3> left_spin_potential{};
    bool left_spin_specified = false;
    bool right_spin_sink = false;
    double conductivity = 5.0e6;
    double spin_conductivity = 4.0e6;
    double polarization = 0.0;
    double spin_hall_angle = 0.0;
    double spin_flip = 8.0e-9;
    double exchange = 0.0;
    double dephasing = 0.0;
    std::array<double, 3> magnetization{0.0, 0.0, 1.0};
    std::vector<uint32_t> region_ids;
    std::vector<InterfaceSpec> interfaces;
};

uint64_t cells(const Scenario &scenario) {
    return scenario.nx * scenario.ny * scenario.nz;
}

uint64_t cell_index(const Scenario &scenario, uint64_t x, uint64_t y, uint64_t z) {
    return x + scenario.nx * (y + scenario.ny * z);
}

uint64_t face_index(const Scenario &scenario, uint32_t axis, uint64_t plane,
                    uint64_t x, uint64_t y, uint64_t z) {
    if (axis == 0) return plane + (scenario.nx + 1) * (y + scenario.ny * z);
    if (axis == 1) return x + scenario.nx * (plane + (scenario.ny + 1) * z);
    return x + scenario.nx * (y + scenario.ny * plane);
}

uint64_t face_count(const Scenario &scenario, uint32_t axis) {
    if (axis == 0) return (scenario.nx + 1) * scenario.ny * scenario.nz;
    if (axis == 1) return scenario.nx * (scenario.ny + 1) * scenario.nz;
    return scenario.nx * scenario.ny * (scenario.nz + 1);
}

double face_area(const Scenario &scenario, uint32_t axis) {
    if (axis == 0) return scenario.dy * scenario.dz;
    if (axis == 1) return scenario.dx * scenario.dz;
    return scenario.dx * scenario.dy;
}

fullmag_fdm_gpu_transport_buffer_view_v1 host_view(const void *data, uint64_t count,
                                                    uint64_t stride) {
    fullmag_fdm_gpu_transport_buffer_view_v1 view{};
    init_record(view);
    view.address = count == 0 ? 0 : reinterpret_cast<uint64_t>(data);
    view.element_count = count;
    view.byte_stride = stride;
    view.byte_length = count * stride;
    view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES;
    view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
    return view;
}

fullmag_fdm_gpu_transport_buffer_view_v1 device_view(void *data, uint64_t count,
                                                      uint32_t pointer_space) {
    fullmag_fdm_gpu_transport_buffer_view_v1 view{};
    init_record(view);
    view.address = reinterpret_cast<uint64_t>(data);
    view.element_count = count;
    view.byte_stride = sizeof(double);
    view.byte_length = count * sizeof(double);
    view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
    view.pointer_space = pointer_space;
    view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
    return view;
}

fullmag_fdm_gpu_transport_buffer_view_v1 host_write_view(std::vector<double> &values) {
    fullmag_fdm_gpu_transport_buffer_view_v1 view{};
    init_record(view);
    view.address = reinterpret_cast<uint64_t>(values.data());
    view.element_count = values.size();
    view.byte_stride = sizeof(double);
    view.byte_length = values.size() * sizeof(double);
    view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
    view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
    return view;
}

fullmag_fdm_gpu_transport_buffer_view_v1 observation_write_view(
    std::vector<fullmag_fdm_gpu_transport_spin_observation_record_v1> &values) {
    fullmag_fdm_gpu_transport_buffer_view_v1 view{};
    init_record(view);
    view.address = reinterpret_cast<uint64_t>(values.data());
    view.element_count = values.size();
    view.byte_stride = sizeof(fullmag_fdm_gpu_transport_spin_observation_record_v1);
    view.byte_length = values.size() * view.byte_stride;
    view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES;
    view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
    return view;
}

fullmag_fdm_gpu_transport_charge_face_v1 charge_face(
    const Scenario &scenario, uint32_t axis, int32_t side, uint64_t adjacent,
    uint64_t canonical_face, double value, uint64_t source_id) {
    fullmag_fdm_gpu_transport_charge_face_v1 face{};
    init_record(face, kCharge);
    face.kind = axis == 0
                    ? FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE
                    : FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING;
    face.axis = axis;
    face.side = side;
    face.outward_sign = side;
    face.adjacent_cell = adjacent;
    face.canonical_face_index = canonical_face;
    face.area = face_area(scenario, axis);
    face.value = axis == 0 ? value : 0.0;
    face.source_id = source_id;
    return face;
}

fullmag_fdm_gpu_transport_spin_boundary_face_v1 spin_face(
    const Scenario &scenario, uint32_t axis, int32_t side, uint64_t adjacent,
    uint64_t canonical_face, uint64_t source_id) {
    fullmag_fdm_gpu_transport_spin_boundary_face_v1 face{};
    init_record(face, kSpin);
    face.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING;
    if (axis == 0 && side < 0 && scenario.left_spin_specified) {
        face.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL;
        std::copy(scenario.left_spin_potential.begin(), scenario.left_spin_potential.end(),
                  face.potential_xyz);
    } else if (axis == 0 && side > 0 && scenario.right_spin_sink) {
        face.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK;
    }
    face.axis = axis;
    face.side = side;
    face.outward_sign = side;
    face.adjacent_cell = adjacent;
    face.canonical_face_index = canonical_face;
    face.area = face_area(scenario, axis);
    face.source_id = source_id;
    return face;
}

void append_external_faces(
    const Scenario &scenario,
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> &charge_faces,
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> &spin_faces) {
    uint64_t source_id = 100;
    for (uint32_t axis = 0; axis < 3; ++axis) {
        const uint64_t a_extent = axis == 0 ? scenario.ny : scenario.nx;
        const uint64_t b_extent = axis == 2 ? scenario.ny : scenario.nz;
        for (uint64_t b = 0; b < b_extent; ++b) {
            for (uint64_t a = 0; a < a_extent; ++a) {
                for (int32_t side : {-1, 1}) {
                    uint64_t x = axis == 0 ? (side < 0 ? 0 : scenario.nx - 1) : a;
                    uint64_t y = axis == 1 ? (side < 0 ? 0 : scenario.ny - 1)
                                            : (axis == 0 ? a : b);
                    uint64_t z = axis == 2 ? (side < 0 ? 0 : scenario.nz - 1) : b;
                    const uint64_t plane = side < 0 ? 0
                        : (axis == 0 ? scenario.nx : axis == 1 ? scenario.ny : scenario.nz);
                    const uint64_t adjacent = cell_index(scenario, x, y, z);
                    const uint64_t canonical = face_index(scenario, axis, plane, x, y, z);
                    const double value = side < 0 ? scenario.left_voltage
                                                   : scenario.right_voltage;
                    charge_faces.push_back(charge_face(
                        scenario, axis, side, adjacent, canonical, value, source_id));
                    spin_faces.push_back(spin_face(
                        scenario, axis, side, adjacent, canonical, source_id));
                    ++source_id;
                }
            }
        }
    }
}

charge::StructuredFace cpu_face(const InterfaceSpec &spec) {
    return {spec.axis, spec.negative_cell, spec.positive_cell};
}

spin::StructuredFace cpu_spin_face(const InterfaceSpec &spec) {
    return {spec.axis, spec.negative_cell, spec.positive_cell};
}

struct CpuResult {
    spin::SolveResult spin;
    std::vector<charge::ChargeInterfaceFluxObservation> charge_interfaces;
};

CpuResult solve_cpu(const Scenario &scenario) {
    charge::Problem charge_problem;
    charge_problem.grid = {static_cast<std::size_t>(scenario.nx),
                           static_cast<std::size_t>(scenario.ny),
                           static_cast<std::size_t>(scenario.nz),
                           scenario.dx, scenario.dy, scenario.dz};
    charge_problem.conductivity_s_per_m.assign(cells(scenario), scenario.conductivity);
    charge_problem.active_cells.assign(cells(scenario), 1);
    for (auto &bc : charge_problem.boundary.values) bc = charge::BoundaryCondition::insulating();
    charge_problem.boundary[charge::Face::x_min] =
        charge::BoundaryCondition::voltage(scenario.left_voltage);
    charge_problem.boundary[charge::Face::x_max] =
        charge::BoundaryCondition::voltage(scenario.right_voltage);
    for (const auto &interface : scenario.interfaces) {
        if (interface.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            charge_problem.interfaces.push_back(charge::OrientedMixingInterface::one_way(
                cpu_face(interface), interface.from_cell, interface.to_cell,
                interface.g_up, interface.g_down));
        }
    }
    const auto charge_result = charge::solve(charge_problem);
    require(charge_result.ok(), scenario.name + ": CPU charge solve failed: " +
                                    charge_result.message);

    spin::Problem spin_problem;
    spin_problem.grid = charge_problem.grid;
    spin_problem.accepted_charge_snapshot = charge_result.solution.accepted_snapshot();
    const auto charge_interfaces =
        spin_problem.accepted_charge_snapshot->interface_fluxes();
    spin_problem.spin_conductivity_s_per_m.assign(cells(scenario), scenario.spin_conductivity);
    spin_problem.polarization.assign(cells(scenario), scenario.polarization);
    spin_problem.spin_hall_angle.assign(cells(scenario), scenario.spin_hall_angle);
    spin_problem.magnetization.assign(cells(scenario), scenario.magnetization);
    spin_problem.reactions.assign(
        cells(scenario), spin::ReactionLengths{scenario.spin_flip,
                                                scenario.exchange,
                                                scenario.dephasing});
    spin_problem.active_cells.assign(cells(scenario), 1);
    spin_problem.region_ids = scenario.region_ids;
    if (spin_problem.region_ids.empty()) spin_problem.region_ids.assign(cells(scenario), 1);
    for (auto &bc : spin_problem.boundary.values) bc = spin::BoundaryCondition::insulating();
    if (scenario.left_spin_specified) {
        spin_problem.boundary[charge::Face::x_min] =
            spin::BoundaryCondition::specified_potential(scenario.left_spin_potential);
    }
    if (scenario.right_spin_sink) {
        spin_problem.boundary[charge::Face::x_max] = spin::BoundaryCondition::sink();
    }
    for (const auto &interface : scenario.interfaces) {
        if (interface.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT) {
            spin_problem.interfaces.push_back(spin::Interface::transparent(
                cpu_spin_face(interface), interface.from_cell, interface.to_cell));
        } else {
            spin_problem.interfaces.push_back(spin::Interface::mixing_conductance_v2(
                cpu_spin_face(interface), interface.from_cell, interface.to_cell,
                interface.g_up, interface.g_down, interface.g_r, interface.g_i,
                interface.magnetization));
        }
    }
    spin_problem.torque_targets.target_cells.assign(cells(scenario), 1);
    spin_problem.torque_targets.saturation_magnetization_a_per_m.assign(cells(scenario), 8.0e5);
    spin_problem.torque_targets.gamma_e_rad_per_s_t = 1.76085963023e11;
    spin::SolverOptions options;
    options.relative_tolerance = 1.0e-10;
    options.absolute_tolerance_a = 1.0e-18;
    options.local_relative_tolerance = 1.0e-10;
    options.local_absolute_tolerance_a_per_m3 = 1.0e-5;
    options.max_iterations = 4000;
    options.gmres_restart = 40;
    const auto result = spin::solve(spin_problem, options);
    require(result.ok(), scenario.name + ": CPU spin solve failed: " + result.message);
    return {result, charge_interfaces};
}

uint64_t canonical_face_index(const Scenario &scenario, const InterfaceSpec &spec) {
    const uint64_t x = spec.positive_cell % scenario.nx;
    const uint64_t yz = spec.positive_cell / scenario.nx;
    const std::array<uint64_t, 3> positive_coordinates{x, yz % scenario.ny,
                                                       yz / scenario.ny};
    return face_index(scenario, spec.axis, positive_coordinates[spec.axis],
                      positive_coordinates[0], positive_coordinates[1],
                      positive_coordinates[2]);
}

fullmag_fdm_gpu_transport_spin_interface_v1 gpu_interface(
    const Scenario &scenario, const InterfaceSpec &spec) {
    fullmag_fdm_gpu_transport_spin_interface_v1 result{};
    init_record(result,
                spec.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
                    ? kCharge | FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
                    : kCharge);
    result.kind = spec.kind;
    result.axis = spec.axis;
    result.orientation = spec.from_cell == spec.negative_cell ? 1 : -1;
    result.negative_cell = spec.negative_cell;
    result.positive_cell = spec.positive_cell;
    result.from_cell = spec.from_cell;
    result.to_cell = spec.to_cell;
    result.canonical_face_index = canonical_face_index(scenario, spec);
    result.area = face_area(scenario, spec.axis);
    result.G_up = spec.g_up;
    result.G_down = spec.g_down;
    result.G_r = spec.g_r;
    result.G_i = spec.g_i;
    std::copy(spec.magnetization.begin(), spec.magnetization.end(),
              result.magnetization_xyz);
    result.source_id = spec.source_id;
    result.topology_id = spec.topology_id;
    result.charge_edge_enabled =
        spec.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT ||
        spec.g_up + spec.g_down > 0.0;
    return result;
}

struct GpuResult {
    std::vector<double> mu;
    std::vector<double> q;
    std::vector<double> torque;
    std::vector<fullmag_fdm_gpu_transport_spin_observation_record_v1> observations;
    fullmag_fdm_gpu_steady_spin_solve_result_v1 diagnostics{};
};

std::vector<double> readback(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_charge_snapshot_info_v1 &snapshot,
    uint32_t field_id, uint64_t count) {
    std::vector<double> values(count);
    auto destination = host_write_view(values);
    if (field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA)
        destination.component_order =
            FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ;
    fullmag_fdm_gpu_transport_artifact_request_v1 request{};
    init_record(request, kCharge | kReadback);
    request.context_handle = context;
    request.snapshot_handle = snapshot.snapshot_handle;
    request.field_id = field_id;
    request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    request.range_count = count;
    request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination);
    request.expected_bytes = count * sizeof(double);
    request.accepted_sequence = snapshot.accepted_sequence;
    const uint32_t status = fullmag_fdm_gpu_transport_readback_artifact_v1(&request);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "artifact readback field=%u count=%llu status=%u\n",
                     field_id, static_cast<unsigned long long>(count), status);
    require(status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "public GPU artifact readback failed");
    return values;
}

std::vector<fullmag_fdm_gpu_transport_spin_observation_record_v1>
readback_observations(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_charge_snapshot_info_v1 &snapshot, uint64_t count) {
    std::vector<fullmag_fdm_gpu_transport_spin_observation_record_v1> values(count);
    auto destination = observation_write_view(values);
    fullmag_fdm_gpu_transport_artifact_request_v1 request{};
    init_record(request, kCharge | kReadback);
    request.context_handle = context;
    request.snapshot_handle = snapshot.snapshot_handle;
    request.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TRANSPORT_OBSERVATIONS;
    request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    request.range_count = count;
    request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination);
    request.expected_bytes = count * sizeof(values[0]);
    request.accepted_sequence = snapshot.accepted_sequence;
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "public typed GPU observation readback failed");
    return values;
}

GpuResult solve_gpu(const Scenario &scenario) {
    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess,
            "an actual CUDA device is required; SKIP is forbidden");
    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    const bool has_mixing = std::any_of(
        scenario.interfaces.begin(), scenario.interfaces.end(),
        [](const InterfaceSpec &interface) {
            return interface.kind ==
                   FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2;
        });
    const uint64_t create_features = kChargeSpin | kReadback |
        (has_mixing ? FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2 : 0);
    init_record(create, create_features);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy = FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 128ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 128ULL * 1024ULL * 1024ULL;
    create.requested_device_features = create_features;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created, create_features);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": GPU context create failed");

    std::vector<fullmag_fdm_gpu_transport_spin_cell_v1> cell_records(cells(scenario));
    for (uint64_t cell = 0; cell < cells(scenario); ++cell) {
        auto &record = cell_records[cell];
        init_record(record, kCharge);
        record.active = record.conductor = record.spin_active = record.torque_target = 1;
        record.material_index = 7;
        record.region_id = scenario.region_ids.empty() ? 1 : scenario.region_ids[cell];
        record.saturation_magnetization = 8.0e5;
    }
    fullmag_fdm_gpu_transport_spin_material_v1 material{};
    init_record(material, kCharge);
    material.material_index = 7;
    material.conductivity = scenario.conductivity;
    material.material_revision = 17;
    material.spin_conductivity = scenario.spin_conductivity;
    material.polarization = scenario.polarization;
    material.spin_hall_angle = scenario.spin_hall_angle;
    material.spin_flip_length = scenario.spin_flip;
    material.exchange_length = scenario.exchange;
    material.dephasing_length = scenario.dephasing;
    material.spin_revision = 19;
    std::vector<fullmag_fdm_gpu_transport_spin_interface_v1> interfaces;
    interfaces.reserve(scenario.interfaces.size());
    for (const auto &spec : scenario.interfaces) interfaces.push_back(gpu_interface(scenario, spec));
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> charge_faces;
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> spin_faces;
    append_external_faces(scenario, charge_faces, spin_faces);
    fullmag_fdm_gpu_transport_formula_ids_v1 formula{};
    init_record(formula, kCharge);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 23;
    formula.spin_formula_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1;
    formula.spin_operator_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1;
    formula.electric_reconstruction_id =
        FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1;
    formula.interface_formula_id =
        FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2;
    formula.torque_operator_id =
        FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1;
    formula.spin_engine_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1;
    formula.preconditioner_id =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1;
    formula.spin_residual_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1;
    formula.local_residual_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1;
    formula.spin_operator_revision = 29;
    formula.preconditioner_revision = 31;
    formula.gamma_e = 1.76085963023e11;
    formula.gmres_restart = 50;
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        host_view(cell_records.data(), cell_records.size(), sizeof(cell_records[0])),
        host_view(&material, 1, sizeof(material)),
        host_view(interfaces.data(), interfaces.size(), sizeof(fullmag_fdm_gpu_transport_spin_interface_v1)),
        host_view(charge_faces.data(), charge_faces.size(), sizeof(charge_faces[0])),
        host_view(spin_faces.data(), spin_faces.size(), sizeof(spin_faces[0])),
        host_view(&formula, 1, sizeof(formula)),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor,
                kChargeSpin |
                    (has_mixing ? FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2 : 0));
    descriptor.grid[0] = scenario.nx;
    descriptor.grid[1] = scenario.ny;
    descriptor.grid[2] = scenario.nz;
    descriptor.cell_size[0] = scenario.dx;
    descriptor.cell_size[1] = scenario.dy;
    descriptor.cell_size[2] = scenario.dz;
    descriptor.descriptor_revision = 37;
    descriptor.source_revision = 41;
    std::fill(std::begin(descriptor.descriptor_digest),
              std::end(descriptor.descriptor_digest), 0x91);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": GPU descriptor upload failed");
    fullmag_fdm_gpu_charge_solve_request_v1 charge_request{};
    init_record(charge_request, kCharge);
    charge_request.context_handle = created.context_handle;
    charge_request.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    charge_request.gauge_policy =
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    charge_request.attempt_id = 43;
    charge_request.stage_id = 47;
    charge_request.source_revision = descriptor.source_revision;
    charge_request.static_revision = descriptor.descriptor_revision;
    charge_request.relative_tolerance = 1.0e-12;
    charge_request.max_iterations = 1000;
    fullmag_fdm_gpu_charge_solve_result_v1 charge_result{};
    init_record(charge_result, kCharge);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&charge_request, &charge_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": GPU charge solve failed");
    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot, kCharge);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, charge_result.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": GPU charge snapshot accept failed");

    std::vector<double> magnetization(3 * cells(scenario));
    for (uint64_t cell = 0; cell < cells(scenario); ++cell)
        for (uint32_t component = 0; component < 3; ++component)
            magnetization[component * cells(scenario) + cell] = scenario.magnetization[component];
    double *m_device = nullptr;
    double *torque_device = nullptr;
    require(cudaMalloc(reinterpret_cast<void **>(&m_device), magnetization.size() * sizeof(double)) == cudaSuccess &&
                cudaMalloc(reinterpret_cast<void **>(&torque_device), magnetization.size() * sizeof(double)) == cudaSuccess,
            scenario.name + ": device stage allocation failed");
    require(cudaMemcpy(m_device, magnetization.data(), magnetization.size() * sizeof(double),
                       cudaMemcpyHostToDevice) == cudaSuccess &&
                cudaMemset(torque_device, 0, magnetization.size() * sizeof(double)) == cudaSuccess,
            scenario.name + ": device stage initialization failed");
    auto m_view = device_view(m_device, magnetization.size(),
                              FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY);
    auto torque_view = device_view(torque_device, magnetization.size(),
                                   FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY);
    fullmag_fdm_gpu_steady_spin_solve_request_v1 request{};
    init_record(request, kChargeSpin);
    request.context_handle = created.context_handle;
    request.snapshot_handle = snapshot.snapshot_handle;
    request.accepted_sequence = snapshot.accepted_sequence;
    request.m_stage_view_ptr = reinterpret_cast<uint64_t>(&m_view);
    request.torque_view_ptr = reinterpret_cast<uint64_t>(&torque_view);
    request.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1;
    request.attempt_id = 53;
    request.stage_id = 59;
    request.source_revision = descriptor.source_revision;
    request.operator_revision = formula.spin_operator_revision;
    request.relative_tolerance = 1.0e-10;
    request.max_iterations = 4000;
    GpuResult output;
    init_record(output.diagnostics, kChargeSpin);
    require(fullmag_fdm_gpu_transport_solve_steady_spin_v1(&request, &output.diagnostics) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": GPU spin solve failed");
    require(output.diagnostics.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            scenario.name + ": GPU spin solve returned OK without convergence");
    output.mu = readback(created.context_handle, snapshot,
                         FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S,
                         3 * cells(scenario));
    output.q = readback(created.context_handle, snapshot,
                        FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA,
                        3 * (face_count(scenario, 0) + face_count(scenario, 1) +
                             face_count(scenario, 2)));
    output.torque = readback(created.context_handle, snapshot,
                             FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT,
                             3 * cells(scenario));
    output.observations = readback_observations(
        created.context_handle, snapshot, 2 * cells(scenario) + scenario.interfaces.size());
    (void)cudaFree(m_device);
    (void)cudaFree(torque_device);
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": snapshot destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            scenario.name + ": context destroy failed");
    return output;
}

std::vector<double> flatten_mu(const spin::Solution &solution) {
    std::vector<double> values(3 * solution.spin_potential_v.size());
    for (uint64_t cell = 0; cell < solution.spin_potential_v.size(); ++cell)
        for (uint32_t component = 0; component < 3; ++component)
            values[component * solution.spin_potential_v.size() + cell] =
                solution.spin_potential_v[cell][component];
    return values;
}

std::vector<double> flatten_q(const spin::Solution &solution) {
    std::vector<double> values;
    for (const auto *faces : {&solution.face_spin_current_density_a_per_m2.x,
                              &solution.face_spin_current_density_a_per_m2.y,
                              &solution.face_spin_current_density_a_per_m2.z}) {
        for (uint32_t component = 0; component < 3; ++component)
            for (const auto &face : *faces) values.push_back(face[component]);
    }
    return values;
}

std::vector<double> flatten_torque(const spin::Solution &solution) {
    std::vector<double> values(3 * solution.transport_gilbert_torque_per_s.size());
    for (uint64_t cell = 0; cell < solution.transport_gilbert_torque_per_s.size(); ++cell)
        for (uint32_t component = 0; component < 3; ++component)
            values[component * solution.transport_gilbert_torque_per_s.size() + cell] =
                solution.transport_gilbert_torque_per_s[cell][component];
    return values;
}

void compare(const std::vector<double> &gpu, const std::vector<double> &cpu,
             double absolute_tolerance, const std::string &what) {
    require(gpu.size() == cpu.size(), what + ": length mismatch");
    double artifact_scale = 0.0;
    for (uint64_t index = 0; index < gpu.size(); ++index)
        artifact_scale = std::max(
            artifact_scale, std::max(std::abs(gpu[index]), std::abs(cpu[index])));
    const double roundoff_tolerance =
        128.0 * std::numeric_limits<double>::epsilon() * artifact_scale;
    const double effective_absolute_tolerance =
        std::max(absolute_tolerance, roundoff_tolerance);
    for (uint64_t index = 0; index < gpu.size(); ++index)
        require_close(gpu[index], cpu[index], effective_absolute_tolerance,
                      what + "[" + std::to_string(index) + "]");
}

GpuResult verify_case(const Scenario &scenario) {
    const auto cpu = solve_cpu(scenario);
    const auto gpu = solve_gpu(scenario);
    require(gpu.diagnostics.local_balance <= 1.0e-9,
            scenario.name + ": local balance exceeds contract: " +
                std::to_string(gpu.diagnostics.local_balance));
    require(gpu.diagnostics.global_balance <= 1.0e-9,
            scenario.name + ": global balance exceeds contract: " +
                std::to_string(gpu.diagnostics.global_balance));
    require(gpu.diagnostics.interface_balance <= 1.0e-9,
            scenario.name + ": interface balance exceeds contract: " +
                std::to_string(gpu.diagnostics.interface_balance));
    require(gpu.diagnostics.torque_balance <= 1.0e-9,
            scenario.name + ": torque balance exceeds contract: " +
                std::to_string(gpu.diagnostics.torque_balance));
    compare(gpu.mu, flatten_mu(cpu.spin.solution), kAbsolutePotentialTolerance,
            scenario.name + ": mu_s");
    compare(gpu.q, flatten_q(cpu.spin.solution), kAbsoluteFluxTolerance,
            scenario.name + ": full Q_x/Q_y/Q_z");
    compare(gpu.torque, flatten_torque(cpu.spin.solution), kAbsoluteTorqueTolerance,
            scenario.name + ": total torque");
    require(gpu.observations.size() == 2 * cells(scenario) + scenario.interfaces.size(),
            scenario.name + ": observation stream length mismatch");
    for (uint64_t cell = 0; cell < cells(scenario); ++cell) {
        const auto &reaction = gpu.observations[cell];
        require(reaction.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_REACTION &&
                    reaction.cell_index == cell &&
                    reaction.required_features == (kSpin | kReadback),
                scenario.name + ": non-canonical reaction record");
        for (uint32_t component = 0; component < 3; ++component) {
            require_close(reaction.lane0_xyz[component],
                          cpu.spin.solution.reaction_channels[cell].spin_flip_a_per_m3[component],
                          kAbsoluteFluxTolerance, scenario.name + ": R_sf");
            require_close(reaction.lane1_xyz[component],
                          cpu.spin.solution.reaction_channels[cell].exchange_a_per_m3[component],
                          kAbsoluteFluxTolerance, scenario.name + ": R_J");
            require_close(reaction.lane2_xyz[component],
                          cpu.spin.solution.reaction_channels[cell].dephasing_a_per_m3[component],
                          kAbsoluteFluxTolerance, scenario.name + ": R_phi");
        }
        const auto &torque = gpu.observations[cells(scenario) + cell];
        require(torque.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_TORQUE &&
                    torque.cell_index == cell,
                scenario.name + ": non-canonical torque record");
        for (uint32_t component = 0; component < 3; ++component) {
            require_close(torque.lane0_xyz[component] + torque.lane1_xyz[component],
                          torque.lane2_xyz[component], kAbsoluteTorqueTolerance,
                          scenario.name + ": decomposed torque closure");
            require_close(torque.lane2_xyz[component],
                          gpu.torque[component * cells(scenario) + cell],
                          kAbsoluteTorqueTolerance, scenario.name + ": immutable total torque");
        }
    }
    std::vector<const InterfaceSpec *> sorted_interfaces;
    sorted_interfaces.reserve(scenario.interfaces.size());
    for (const auto &interface : scenario.interfaces)
        sorted_interfaces.push_back(&interface);
    std::sort(sorted_interfaces.begin(), sorted_interfaces.end(),
              [&](const InterfaceSpec *left, const InterfaceSpec *right) {
                  return std::make_tuple(
                             left->source_id, left->topology_id, left->axis,
                             canonical_face_index(scenario, *left),
                             left->negative_cell, left->positive_cell,
                             left->from_cell, left->to_cell) <
                         std::make_tuple(
                             right->source_id, right->topology_id, right->axis,
                             canonical_face_index(scenario, *right),
                             right->negative_cell, right->positive_cell,
                             right->from_cell, right->to_cell);
              });
    for (uint64_t interface_index = 0;
         interface_index < sorted_interfaces.size(); ++interface_index) {
        const uint64_t index = 2 * cells(scenario) + interface_index;
        const auto &interface = gpu.observations[index];
        const auto &spec = *sorted_interfaces[interface_index];
        require(interface.kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE &&
                    interface.required_features == (kSpin | kReadback),
                scenario.name + ": non-canonical interface record");
        require(interface.source_id == spec.source_id &&
                    interface.topology_id == spec.topology_id &&
                    interface.axis == spec.axis &&
                    interface.orientation ==
                        (spec.from_cell == spec.negative_cell ? 1 : -1) &&
                    interface.canonical_face_index ==
                        canonical_face_index(scenario, spec) &&
                    interface.negative_cell == spec.negative_cell &&
                    interface.positive_cell == spec.positive_cell &&
                    interface.from_cell == spec.from_cell &&
                    interface.to_cell == spec.to_cell,
                scenario.name + ": interface identity or orientation drift");
        const auto spin_flux = std::find_if(
            cpu.spin.solution.interface_fluxes.begin(),
            cpu.spin.solution.interface_fluxes.end(),
            [&](const spin::InterfaceFluxObservation &candidate) {
                return candidate.face.axis == spec.axis &&
                       candidate.face.negative_cell == spec.negative_cell &&
                       candidate.face.positive_cell == spec.positive_cell &&
                       candidate.from_cell == spec.from_cell &&
                       candidate.to_cell == spec.to_cell;
            });
        require(spin_flux != cpu.spin.solution.interface_fluxes.end(),
                scenario.name + ": CPU interface observation missing");
        for (uint32_t component = 0; component < 3; ++component) {
            require_close(interface.lane0_xyz[component],
                          spin_flux->incoming_longitudinal_a_per_m2[component],
                          kAbsoluteFluxTolerance, scenario.name + ": interface incoming");
            require_close(interface.lane1_xyz[component],
                          spin_flux->backflow_longitudinal_a_per_m2[component],
                          kAbsoluteFluxTolerance, scenario.name + ": interface backflow");
            require_close(interface.lane2_xyz[component],
                          spin_flux->absorbed_transverse_a_per_m2[component],
                          kAbsoluteFluxTolerance, scenario.name + ": interface absorbed");
            require_close(
                interface.lane3_xyz[component],
                spin_flux->negative_cell_flux_positive_axis_a_per_m2[component],
                kAbsoluteFluxTolerance, scenario.name + ": interface negative flux");
            require_close(
                interface.lane4_xyz[component],
                spin_flux->positive_cell_flux_positive_axis_a_per_m2[component],
                kAbsoluteFluxTolerance, scenario.name + ": interface positive flux");
            require_close(interface.lane3_xyz[component] - interface.lane4_xyz[component],
                          interface.lane2_xyz[component], kAbsoluteFluxTolerance,
                          scenario.name + ": one-sided interface balance");
            require(interface.lane5_xyz[component] == 0.0,
                    scenario.name + ": unsupported SML channel is not exact zero");
        }
        if (spec.kind ==
            FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            const auto charge_flux = std::find_if(
                cpu.charge_interfaces.begin(), cpu.charge_interfaces.end(),
                [&](const charge::ChargeInterfaceFluxObservation &candidate) {
                    return candidate.face.axis == spec.axis &&
                           candidate.face.negative_cell == spec.negative_cell &&
                           candidate.face.positive_cell == spec.positive_cell &&
                           candidate.from_cell == spec.from_cell &&
                           candidate.to_cell == spec.to_cell;
                });
            require(charge_flux != cpu.charge_interfaces.end(),
                    scenario.name + ": accepted CPU charge interface missing");
            require_close(interface.charge_from_trace_v,
                          charge_flux->from_potential_trace_v,
                          kAbsolutePotentialTolerance,
                          scenario.name + ": accepted charge from trace");
            require_close(interface.charge_to_trace_v,
                          charge_flux->to_potential_trace_v,
                          kAbsolutePotentialTolerance,
                          scenario.name + ": accepted charge to trace");
            require_close(interface.charge_delta_trace_v,
                          charge_flux->delta_potential_trace_v,
                          kAbsolutePotentialTolerance,
                          scenario.name + ": accepted charge delta trace");
        } else {
            require(interface.charge_from_trace_v == 0.0 &&
                        interface.charge_to_trace_v == 0.0 &&
                        interface.charge_delta_trace_v == 0.0,
                    scenario.name +
                        ": transparent interface carries synthetic charge traces");
        }
        require_close(interface.charge_from_trace_v - interface.charge_to_trace_v,
                      interface.charge_delta_trace_v, kAbsolutePotentialTolerance,
                      scenario.name + ": accepted charge trace closure");
    }
    for (uint64_t index = 2 * cells(scenario) + 1; index < gpu.observations.size(); ++index) {
        const auto &previous = gpu.observations[index - 1];
        const auto &current = gpu.observations[index];
        require(std::tie(previous.source_id, previous.topology_id, previous.axis,
                         previous.canonical_face_index, previous.negative_cell,
                         previous.positive_cell, previous.from_cell, previous.to_cell) <
                    std::tie(current.source_id, current.topology_id, current.axis,
                             current.canonical_face_index, current.negative_cell,
                             current.positive_cell, current.from_cell, current.to_cell),
                scenario.name + ": interface observations depend on authored order");
    }
    return gpu;
}

Scenario signed_she(double voltage) {
    Scenario scenario;
    scenario.name = voltage > 0.0 ? "direct_she_positive" : "direct_she_negative";
    scenario.nx = 3;
    scenario.nz = 4;
    scenario.left_voltage = voltage;
    scenario.spin_hall_angle = 0.15;
    scenario.spin_flip = 6.0e-9;
    return scenario;
}

Scenario volume_reaction_torque() {
    Scenario scenario;
    scenario.name = "reactions_and_volume_torque";
    scenario.nx = 3;
    scenario.left_spin_specified = true;
    scenario.right_spin_sink = true;
    scenario.left_spin_potential = {2.0e-4, -1.0e-4, 0.5e-4};
    scenario.spin_flip = 9.0e-9;
    scenario.exchange = 7.0e-9;
    scenario.dephasing = 5.0e-9;
    scenario.magnetization = {0.0, 0.0, 1.0};
    return scenario;
}

Scenario unsorted_interfaces() {
    Scenario scenario;
    scenario.name = "transparent_full_transverse_reversed_unsorted_multiple";
    scenario.nx = 4;
    scenario.dx = 1.0;
    scenario.dy = 1.0;
    scenario.dz = 1.0;
    scenario.conductivity = 5.0;
    scenario.spin_conductivity = 4.0;
    scenario.spin_flip = 8.0;
    scenario.left_voltage = 0.0;
    scenario.left_spin_specified = true;
    scenario.right_spin_sink = true;
    scenario.left_spin_potential = {2.0e-4, -1.0e-4, 0.5e-4};
    scenario.region_ids = {1, 2, 3, 4};
    scenario.interfaces = {
        {FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
         0, 2, 3, 3, 2, 3.0, 1.0, 2.0, -0.5,
         {0.0, 0.0, 1.0}, 303, 3003},
        {FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT,
         0, 0, 1, 0, 1, 0.0, 0.0, 0.0, 0.0,
         {0.0, 0.0, 1.0}, 101, 1001},
        {FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
         0, 1, 2, 1, 2, 0.0, 0.0, 1.5, 0.25,
         {0.0, 0.0, 1.0}, 202, 2002},
    };
    return scenario;
}

} // namespace

int main() {
    try {
        const auto positive = verify_case(signed_she(1.0e-3));
        const auto negative = verify_case(signed_she(-1.0e-3));
        require(positive.mu.size() == negative.mu.size(), "signed SHE length mismatch");
        for (uint64_t i = 0; i < positive.mu.size(); ++i)
            require_close(positive.mu[i], -negative.mu[i], kAbsolutePotentialTolerance,
                          "integrated direct-SHE sign reversal");
        (void)verify_case(volume_reaction_torque());
        (void)verify_case(unsorted_interfaces());
        std::puts("FDM GPU M1 complete spin-operator CPU parity contract: PASS");
        return EXIT_SUCCESS;
    } catch (const std::exception &error) {
        std::fprintf(stderr, "FAIL: %s\n", error.what());
        return EXIT_FAILURE;
    }
}
