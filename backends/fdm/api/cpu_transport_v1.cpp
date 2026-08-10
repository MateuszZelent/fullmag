#include "fullmag_fdm.h"

#include <fullmag/fdm/cpu/charge_transport_v1.hpp>
#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace charge = fullmag::fdm::cpu::transport::v1;
namespace spin = fullmag::fdm::cpu::transport::spin::v1;

struct fullmag_fdm_cpu_charge_snapshot_v1 {
    std::shared_ptr<const charge::AcceptedChargeSnapshot> snapshot;
    std::vector<fullmag_fdm_cpu_transport_interface_v1> mixing_interfaces;
};

namespace {

constexpr std::string_view runtime_owner = "fdm_cpu_native_transport_m1_v1";

template <std::size_t N>
void copy_text(char (&target)[N], std::string_view value) noexcept {
    std::memset(target, 0, N);
    const std::size_t length = std::min(value.size(), N - 1);
    std::memcpy(target, value.data(), length);
}

template <std::size_t N>
bool exact_text(const char (&value)[N], std::string_view expected) noexcept {
    const void *terminator = std::memchr(value, '\0', N);
    if (terminator == nullptr) {
        return false;
    }
    const auto length = static_cast<std::size_t>(
        static_cast<const char *>(terminator) - value);
    return std::string_view(value, length) == expected;
}

template <typename Result>
bool result_field_available(const Result *result,
                            std::size_t offset,
                            std::size_t width) noexcept {
    struct AbiHeader {
        uint32_t abi_version;
        uint32_t struct_size;
    };
    static_assert(offsetof(Result, abi_version) == 0);
    static_assert(offsetof(Result, struct_size) == sizeof(uint32_t));
    if (result == nullptr) {
        return false;
    }
    AbiHeader header{};
    std::memcpy(&header, result, sizeof(header));
    return header.abi_version == FULLMAG_FDM_CPU_TRANSPORT_ABI_V1 &&
           header.struct_size >= offset &&
           width <= static_cast<std::size_t>(header.struct_size) - offset;
}

template <typename Result>
int fail(Result *result, int status, std::string_view message) noexcept {
    if (result_field_available(result,
                               offsetof(Result, status),
                               sizeof(result->status))) {
        std::memcpy(reinterpret_cast<unsigned char *>(result) +
                        offsetof(Result, status),
                    &status,
                    sizeof(status));
    }
    if (result_field_available(result,
                               offsetof(Result, error_message),
                               sizeof(result->error_message))) {
        auto *target = reinterpret_cast<char *>(result) +
                       offsetof(Result, error_message);
        std::memset(target, 0, sizeof(result->error_message));
        const std::size_t length =
            std::min(message.size(), sizeof(result->error_message) - 1);
        std::memcpy(target, message.data(), length);
    }
    return status;
}

bool checked_size(uint64_t value, std::size_t &output) noexcept {
    if (value > static_cast<uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return false;
    }
    output = static_cast<std::size_t>(value);
    return true;
}

bool checked_product(std::size_t left,
                     std::size_t right,
                     std::size_t &output) noexcept {
    if (left != 0 && right > std::numeric_limits<std::size_t>::max() / left) {
        return false;
    }
    output = left * right;
    return true;
}

bool checked_u64(std::size_t value, uint64_t &output) noexcept {
    if constexpr (sizeof(std::size_t) > sizeof(uint64_t)) {
        if (value > static_cast<std::size_t>(std::numeric_limits<uint64_t>::max())) {
            return false;
        }
    }
    output = static_cast<uint64_t>(value);
    return true;
}

bool grid_and_counts(const fullmag_fdm_cpu_transport_grid_v1 &input,
                     charge::Grid &grid,
                     std::size_t &cell_count,
                     std::array<std::size_t, 3> &face_counts) noexcept {
    if (!checked_size(input.nx, grid.nx) || !checked_size(input.ny, grid.ny) ||
        !checked_size(input.nz, grid.nz) || grid.nx == 0 || grid.ny == 0 ||
        grid.nz == 0 || !std::isfinite(input.dx_m) || input.dx_m <= 0.0 ||
        !std::isfinite(input.dy_m) || input.dy_m <= 0.0 ||
        !std::isfinite(input.dz_m) || input.dz_m <= 0.0) {
        return false;
    }
    grid.dx_m = input.dx_m;
    grid.dy_m = input.dy_m;
    grid.dz_m = input.dz_m;
    std::size_t xy = 0;
    std::size_t scratch = 0;
    if (!checked_product(grid.nx, grid.ny, xy) ||
        !checked_product(xy, grid.nz, cell_count) ||
        grid.nx == std::numeric_limits<std::size_t>::max() ||
        grid.ny == std::numeric_limits<std::size_t>::max() ||
        grid.nz == std::numeric_limits<std::size_t>::max() ||
        !checked_product(grid.nx + 1, grid.ny, scratch) ||
        !checked_product(scratch, grid.nz, face_counts[0]) ||
        !checked_product(grid.nx, grid.ny + 1, scratch) ||
        !checked_product(scratch, grid.nz, face_counts[1]) ||
        !checked_product(grid.nx, grid.ny, scratch) ||
        !checked_product(scratch, grid.nz + 1, face_counts[2])) {
        return false;
    }
    return true;
}

template <typename T>
bool input_span(const T *data, uint64_t length, std::size_t expected) noexcept {
    uint64_t expected_u64 = 0;
    return checked_u64(expected, expected_u64) && length == expected_u64 &&
           (expected == 0 || data != nullptr);
}

template <typename T>
bool input_records(const T *data, uint64_t length, std::size_t &count) noexcept {
    std::size_t bytes = 0;
    return checked_size(length, count) &&
           checked_product(count, sizeof(T), bytes) &&
           count <= std::vector<T>().max_size() &&
           (count == 0 || data != nullptr);
}

bool output_buffer(fullmag_fdm_cpu_f64_buffer_v1 &buffer,
                   std::size_t required) noexcept {
    uint64_t required_u64 = 0;
    if (!checked_u64(required, required_u64)) {
        return false;
    }
    buffer.length = required_u64;
    return buffer.capacity >= required_u64 &&
           (required == 0 || buffer.data != nullptr);
}

bool same_accepted_mixing_interface(
    const fullmag_fdm_cpu_transport_interface_v1 &accepted,
    const fullmag_fdm_cpu_transport_interface_v1 &requested) noexcept {
    return accepted.interface_id == requested.interface_id &&
           accepted.axis == requested.axis && accepted.kind == requested.kind &&
           accepted.negative_cell == requested.negative_cell &&
           accepted.positive_cell == requested.positive_cell &&
           accepted.from_cell == requested.from_cell &&
           accepted.to_cell == requested.to_cell &&
           accepted.g_up_s_per_m2 == requested.g_up_s_per_m2 &&
           accepted.g_down_s_per_m2 == requested.g_down_s_per_m2;
}

bool exact_accepted_mixing_interfaces(
    const fullmag_fdm_cpu_transport_interface_v1 *requested,
    std::size_t requested_count,
    const std::vector<fullmag_fdm_cpu_transport_interface_v1> &accepted) noexcept {
    std::vector<bool> matched(accepted.size(), false);
    std::size_t requested_mixing_count = 0;
    for (std::size_t index = 0; index < requested_count; ++index) {
        if (requested[index].kind !=
            FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            continue;
        }
        ++requested_mixing_count;
        std::size_t match_count = 0;
        std::size_t matched_index = 0;
        for (std::size_t candidate = 0; candidate < accepted.size(); ++candidate) {
            if (same_accepted_mixing_interface(accepted[candidate], requested[index])) {
                ++match_count;
                matched_index = candidate;
            }
        }
        if (match_count != 1 || matched[matched_index]) {
            return false;
        }
        matched[matched_index] = true;
    }
    return requested_mixing_count == accepted.size() &&
           std::all_of(matched.begin(), matched.end(), [](bool value) { return value; });
}

template <typename Observation>
bool same_interface_topology(
    const fullmag_fdm_cpu_transport_interface_v1 &source,
    const Observation &observation) noexcept {
    return source.axis == observation.face.axis &&
           source.negative_cell == observation.face.negative_cell &&
           source.positive_cell == observation.face.positive_cell &&
           source.from_cell == observation.from_cell &&
           source.to_cell == observation.to_cell;
}

template <typename Observation>
const Observation *unique_interface_observation(
    const fullmag_fdm_cpu_transport_interface_v1 &source,
    const std::vector<Observation> &observations) noexcept {
    const Observation *matched = nullptr;
    for (const auto &observation : observations) {
        if (!same_interface_topology(source, observation)) {
            continue;
        }
        if (matched != nullptr) {
            return nullptr;
        }
        matched = &observation;
    }
    return matched;
}

template <typename Vector>
void copy_scalar_vector(fullmag_fdm_cpu_f64_buffer_v1 &buffer,
                        const Vector &values) {
    std::copy(values.begin(), values.end(), buffer.data);
}

template <std::size_t N, typename Vector>
void copy_array_vector(fullmag_fdm_cpu_f64_buffer_v1 &buffer,
                       const Vector &values) {
    std::size_t output = 0;
    for (const auto &value : values) {
        for (std::size_t component = 0; component < N; ++component) {
            buffer.data[output++] = value[component];
        }
    }
}

bool charge_result_header(fullmag_fdm_cpu_charge_result_v1 *result) noexcept {
    return result_field_available(result,
                                  offsetof(fullmag_fdm_cpu_charge_result_v1,
                                           reserved_flags),
                                  sizeof(result->reserved_flags)) &&
           result->struct_size >= sizeof(*result) && result->reserved_flags == 0;
}

bool spin_result_header(fullmag_fdm_cpu_steady_spin_result_v1 *result) noexcept {
    return result_field_available(result,
                                  offsetof(fullmag_fdm_cpu_steady_spin_result_v1,
                                           reserved_flags),
                                  sizeof(result->reserved_flags)) &&
           result->struct_size >= sizeof(*result) && result->reserved_flags == 0;
}

charge::BoundaryCondition charge_boundary(
    const fullmag_fdm_cpu_charge_boundary_v1 &condition) {
    if (condition.reserved != 0 || !std::isfinite(condition.value)) {
        throw std::invalid_argument("charge boundary carries reserved or non-finite data");
    }
    switch (condition.kind) {
    case FULLMAG_FDM_CPU_CHARGE_BC_INSULATING:
        return charge::BoundaryCondition::insulating();
    case FULLMAG_FDM_CPU_CHARGE_BC_VOLTAGE:
        return charge::BoundaryCondition::voltage(condition.value);
    case FULLMAG_FDM_CPU_CHARGE_BC_TOTAL_CURRENT:
        return charge::BoundaryCondition::total_current(condition.value);
    case FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY:
        return charge::BoundaryCondition::specified_outward_current_density();
    default:
        throw std::invalid_argument("unsupported or unset charge boundary kind");
    }
}

spin::BoundaryCondition spin_boundary(
    const fullmag_fdm_cpu_spin_boundary_v1 &condition) {
    if (condition.reserved != 0 ||
        !std::all_of(std::begin(condition.potential_v),
                     std::end(condition.potential_v),
                     [](double value) { return std::isfinite(value); })) {
        throw std::invalid_argument("spin boundary carries reserved or non-finite data");
    }
    const spin::Vector3 value{
        condition.potential_v[0], condition.potential_v[1], condition.potential_v[2]};
    switch (condition.kind) {
    case FULLMAG_FDM_CPU_SPIN_BC_INSULATING:
        return spin::BoundaryCondition::insulating();
    case FULLMAG_FDM_CPU_SPIN_BC_SINK:
        return spin::BoundaryCondition::sink();
    case FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_POTENTIAL:
        return spin::BoundaryCondition::specified_potential(value);
    case FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_OUTWARD_FLUX:
        throw std::domain_error("specified spin flux is not supported by native M1 v1");
    case FULLMAG_FDM_CPU_SPIN_BC_PERIODIC:
        throw std::domain_error("periodic spin boundary is not supported by native M1 v1");
    default:
        throw std::invalid_argument("unsupported or unset spin boundary kind");
    }
}

charge::StructuredFace charge_face(
    const fullmag_fdm_cpu_transport_interface_v1 &input) {
    std::size_t axis = 0;
    std::size_t negative = 0;
    std::size_t positive = 0;
    if (!checked_size(input.axis, axis) || !checked_size(input.negative_cell, negative) ||
        !checked_size(input.positive_cell, positive)) {
        throw std::invalid_argument("interface face index exceeds native size_t");
    }
    return {axis, negative, positive};
}

int charge_status(charge::Status status) noexcept {
    switch (status) {
    case charge::Status::ok:
        return FULLMAG_FDM_CPU_TRANSPORT_OK;
    case charge::Status::did_not_converge:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_CONVERGENCE;
    case charge::Status::balance_failure:
    case charge::Status::incompatible_boundary_current:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_BALANCE;
    case charge::Status::numerical_failure:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_NUMERICAL;
    default:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID;
    }
}

int spin_status(spin::Status status) noexcept {
    switch (status) {
    case spin::Status::ok:
        return FULLMAG_FDM_CPU_TRANSPORT_OK;
    case spin::Status::unsupported_model:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED;
    case spin::Status::did_not_converge:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_CONVERGENCE;
    case spin::Status::balance_failure:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_BALANCE;
    case spin::Status::numerical_failure:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_NUMERICAL;
    default:
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID;
    }
}

#define FULLMAG_LAYOUT_FIELD(type, field) {#field, offsetof(type, field)}

const fullmag_fdm_cpu_transport_abi_layout_field_v1 grid_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_grid_v1, nx),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_grid_v1, ny),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_grid_v1, nz),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_grid_v1, dx_m),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_grid_v1, dy_m),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_grid_v1, dz_m),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 f64_buffer_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_f64_buffer_v1, data),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_f64_buffer_v1, capacity),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_f64_buffer_v1, length),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 charge_boundary_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_boundary_v1, kind),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_boundary_v1, reserved),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_boundary_v1, value),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 spin_boundary_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_boundary_v1, kind),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_boundary_v1, reserved),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_boundary_v1, potential_v),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 specified_face_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_specified_current_face_v1, axis),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_specified_current_face_v1, outward_normal_sign),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_specified_current_face_v1, face_index),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_specified_current_face_v1, adjacent_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_specified_current_face_v1, area_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_specified_current_face_v1, outward_current_density_a_per_m2),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 interface_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, interface_id),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, axis),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, kind),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, negative_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, positive_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, from_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, to_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, g_up_s_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, g_down_s_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, g_r_s_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, g_i_s_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_interface_v1, magnetization),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 charge_observation_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, interface_id),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, axis),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, reserved),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, negative_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, positive_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, from_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, to_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, g_up_s_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, g_down_s_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, from_potential_trace_v),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, to_potential_trace_v),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, delta_potential_trace_v),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, from_to_current_density_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_v1, global_face_current_density_a_per_m2),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 charge_observation_buffer_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_buffer_v1, data),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_buffer_v1, capacity),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_charge_interface_observation_buffer_v1, length),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 spin_observation_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, interface_id),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, axis),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, reserved),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, negative_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, positive_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, from_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, to_cell),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, incoming_longitudinal_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, backflow_longitudinal_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, absorbed_transverse_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, negative_cell_flux_positive_axis_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, positive_cell_flux_positive_axis_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, from_side_outgoing_a_per_m2),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_v1, to_side_transmitted_a_per_m2),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 spin_observation_buffer_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_buffer_v1, data),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_buffer_v1, capacity),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_interface_observation_buffer_v1, length),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 reaction_lengths_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_reaction_lengths_v1, spin_flip_m),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_reaction_lengths_v1, exchange_m),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_spin_reaction_lengths_v1, dephasing_m),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 layout_field_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_field_v1, field_name),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_field_v1, offset),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 layout_record_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_record_v1, record_name),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_record_v1, size),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_record_v1, alignment),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_record_v1, field_count),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_record_v1, fields),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1 layout_manifest_layout_fields[] = {
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_manifest_v1, abi_version),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_manifest_v1, struct_size),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_manifest_v1, reserved_flags),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_manifest_v1, record_count),
    FULLMAG_LAYOUT_FIELD(fullmag_fdm_cpu_transport_abi_layout_manifest_v1, records),
};
#define FULLMAG_CHARGE_REQUEST_FIELDS(type) \
    FULLMAG_LAYOUT_FIELD(type, abi_version), FULLMAG_LAYOUT_FIELD(type, struct_size), \
    FULLMAG_LAYOUT_FIELD(type, reserved_flags), FULLMAG_LAYOUT_FIELD(type, grid), \
    FULLMAG_LAYOUT_FIELD(type, device), FULLMAG_LAYOUT_FIELD(type, precision), \
    FULLMAG_LAYOUT_FIELD(type, conductivity_s_per_m), FULLMAG_LAYOUT_FIELD(type, conductivity_len), \
    FULLMAG_LAYOUT_FIELD(type, active_cells), FULLMAG_LAYOUT_FIELD(type, active_cells_len), \
    FULLMAG_LAYOUT_FIELD(type, boundaries), FULLMAG_LAYOUT_FIELD(type, specified_current_faces), \
    FULLMAG_LAYOUT_FIELD(type, specified_current_face_count), FULLMAG_LAYOUT_FIELD(type, interfaces), \
    FULLMAG_LAYOUT_FIELD(type, interface_count), FULLMAG_LAYOUT_FIELD(type, gauge), \
    FULLMAG_LAYOUT_FIELD(type, reserved0), FULLMAG_LAYOUT_FIELD(type, relative_tolerance), \
    FULLMAG_LAYOUT_FIELD(type, absolute_tolerance_a_per_m3), FULLMAG_LAYOUT_FIELD(type, max_iterations), \
    FULLMAG_LAYOUT_FIELD(type, api_version), FULLMAG_LAYOUT_FIELD(type, operator_version), \
    FULLMAG_LAYOUT_FIELD(type, solver_version), FULLMAG_LAYOUT_FIELD(type, residual_version)
const fullmag_fdm_cpu_transport_abi_layout_field_v1 charge_request_layout_fields[] = {
    FULLMAG_CHARGE_REQUEST_FIELDS(fullmag_fdm_cpu_charge_request_v1),
};
#define FULLMAG_CHARGE_RESULT_FIELDS(type) \
    FULLMAG_LAYOUT_FIELD(type, abi_version), FULLMAG_LAYOUT_FIELD(type, struct_size), \
    FULLMAG_LAYOUT_FIELD(type, reserved_flags), FULLMAG_LAYOUT_FIELD(type, status), \
    FULLMAG_LAYOUT_FIELD(type, reserved0), FULLMAG_LAYOUT_FIELD(type, potential_v), \
    FULLMAG_LAYOUT_FIELD(type, jc_x_a_per_m2), FULLMAG_LAYOUT_FIELD(type, jc_y_a_per_m2), \
    FULLMAG_LAYOUT_FIELD(type, jc_z_a_per_m2), FULLMAG_LAYOUT_FIELD(type, jc_cell_xyz_a_per_m2), \
    FULLMAG_LAYOUT_FIELD(type, interface_observations), FULLMAG_LAYOUT_FIELD(type, iterations), \
    FULLMAG_LAYOUT_FIELD(type, algebraic_residual_l2_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, recomputed_algebraic_residual_l2_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, physical_balance_integrated_l2_a), \
    FULLMAG_LAYOUT_FIELD(type, max_cell_current_imbalance_a), \
    FULLMAG_LAYOUT_FIELD(type, max_abs_divergence_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, boundary_outward_current_a), \
    FULLMAG_LAYOUT_FIELD(type, net_boundary_current_a), \
    FULLMAG_LAYOUT_FIELD(type, accepted_snapshot_identity), \
    FULLMAG_LAYOUT_FIELD(type, accepted_snapshot), FULLMAG_LAYOUT_FIELD(type, api_version), \
    FULLMAG_LAYOUT_FIELD(type, operator_version), FULLMAG_LAYOUT_FIELD(type, interface_operator_version), \
    FULLMAG_LAYOUT_FIELD(type, solver_version), FULLMAG_LAYOUT_FIELD(type, residual_version), \
    FULLMAG_LAYOUT_FIELD(type, runtime_owner), FULLMAG_LAYOUT_FIELD(type, error_message)
const fullmag_fdm_cpu_transport_abi_layout_field_v1 charge_result_layout_fields[] = {
    FULLMAG_CHARGE_RESULT_FIELDS(fullmag_fdm_cpu_charge_result_v1),
};
#define FULLMAG_SPIN_REQUEST_FIELDS(type) \
    FULLMAG_LAYOUT_FIELD(type, abi_version), FULLMAG_LAYOUT_FIELD(type, struct_size), \
    FULLMAG_LAYOUT_FIELD(type, reserved_flags), FULLMAG_LAYOUT_FIELD(type, grid), \
    FULLMAG_LAYOUT_FIELD(type, device), FULLMAG_LAYOUT_FIELD(type, precision), \
    FULLMAG_LAYOUT_FIELD(type, spin_conductivity_s_per_m), FULLMAG_LAYOUT_FIELD(type, spin_conductivity_len), \
    FULLMAG_LAYOUT_FIELD(type, polarization), FULLMAG_LAYOUT_FIELD(type, polarization_len), \
    FULLMAG_LAYOUT_FIELD(type, spin_hall_angle), FULLMAG_LAYOUT_FIELD(type, spin_hall_angle_len), \
    FULLMAG_LAYOUT_FIELD(type, magnetization_xyz), FULLMAG_LAYOUT_FIELD(type, magnetization_xyz_len), \
    FULLMAG_LAYOUT_FIELD(type, reactions), FULLMAG_LAYOUT_FIELD(type, reaction_count), \
    FULLMAG_LAYOUT_FIELD(type, active_cells), FULLMAG_LAYOUT_FIELD(type, active_cells_len), \
    FULLMAG_LAYOUT_FIELD(type, region_ids), FULLMAG_LAYOUT_FIELD(type, region_id_count), \
    FULLMAG_LAYOUT_FIELD(type, boundaries), FULLMAG_LAYOUT_FIELD(type, interfaces), \
    FULLMAG_LAYOUT_FIELD(type, interface_count), FULLMAG_LAYOUT_FIELD(type, torque_target_cells), \
    FULLMAG_LAYOUT_FIELD(type, torque_target_cells_len), \
    FULLMAG_LAYOUT_FIELD(type, saturation_magnetization_a_per_m), \
    FULLMAG_LAYOUT_FIELD(type, saturation_magnetization_len), \
    FULLMAG_LAYOUT_FIELD(type, gamma_e_rad_per_s_t), FULLMAG_LAYOUT_FIELD(type, relative_tolerance), \
    FULLMAG_LAYOUT_FIELD(type, absolute_tolerance_a), FULLMAG_LAYOUT_FIELD(type, local_relative_tolerance), \
    FULLMAG_LAYOUT_FIELD(type, local_absolute_tolerance_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, max_iterations), FULLMAG_LAYOUT_FIELD(type, gmres_restart), \
    FULLMAG_LAYOUT_FIELD(type, api_version), FULLMAG_LAYOUT_FIELD(type, formula_version), \
    FULLMAG_LAYOUT_FIELD(type, operator_version), FULLMAG_LAYOUT_FIELD(type, electric_reconstruction_version), \
    FULLMAG_LAYOUT_FIELD(type, solver_version), FULLMAG_LAYOUT_FIELD(type, residual_version), \
    FULLMAG_LAYOUT_FIELD(type, local_residual_version), FULLMAG_LAYOUT_FIELD(type, interface_version), \
    FULLMAG_LAYOUT_FIELD(type, torque_operator_version)
const fullmag_fdm_cpu_transport_abi_layout_field_v1 spin_request_layout_fields[] = {
    FULLMAG_SPIN_REQUEST_FIELDS(fullmag_fdm_cpu_steady_spin_request_v1),
};
#define FULLMAG_SPIN_RESULT_FIELDS(type) \
    FULLMAG_LAYOUT_FIELD(type, abi_version), FULLMAG_LAYOUT_FIELD(type, struct_size), \
    FULLMAG_LAYOUT_FIELD(type, reserved_flags), FULLMAG_LAYOUT_FIELD(type, status), \
    FULLMAG_LAYOUT_FIELD(type, reserved0), FULLMAG_LAYOUT_FIELD(type, spin_potential_xyz_v), \
    FULLMAG_LAYOUT_FIELD(type, q_x_xyz_a_per_m2), FULLMAG_LAYOUT_FIELD(type, q_y_xyz_a_per_m2), \
    FULLMAG_LAYOUT_FIELD(type, q_z_xyz_a_per_m2), FULLMAG_LAYOUT_FIELD(type, q_cell_ia_a_per_m2), \
    FULLMAG_LAYOUT_FIELD(type, reaction_spin_flip_xyz_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, reaction_exchange_xyz_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, reaction_dephasing_xyz_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, reaction_total_xyz_a_per_m3), \
    FULLMAG_LAYOUT_FIELD(type, transport_torque_xyz_per_s), \
    FULLMAG_LAYOUT_FIELD(type, interface_observations), FULLMAG_LAYOUT_FIELD(type, iterations), \
    FULLMAG_LAYOUT_FIELD(type, gmres_restart), FULLMAG_LAYOUT_FIELD(type, initial_rhs_integrated_l2_a), \
    FULLMAG_LAYOUT_FIELD(type, recursive_residual_integrated_l2_a), \
    FULLMAG_LAYOUT_FIELD(type, recomputed_balance_integrated_l2_a), \
    FULLMAG_LAYOUT_FIELD(type, balance_tolerance_integrated_l2_a), \
    FULLMAG_LAYOUT_FIELD(type, boundary_outward_current_a), \
    FULLMAG_LAYOUT_FIELD(type, global_balance_closure_a), \
    FULLMAG_LAYOUT_FIELD(type, relative_global_balance), \
    FULLMAG_LAYOUT_FIELD(type, max_abs_residual_a_per_m3), FULLMAG_LAYOUT_FIELD(type, api_version), \
    FULLMAG_LAYOUT_FIELD(type, formula_version), FULLMAG_LAYOUT_FIELD(type, operator_version), \
    FULLMAG_LAYOUT_FIELD(type, electric_reconstruction_version), \
    FULLMAG_LAYOUT_FIELD(type, solver_version), FULLMAG_LAYOUT_FIELD(type, residual_version), \
    FULLMAG_LAYOUT_FIELD(type, local_residual_version), FULLMAG_LAYOUT_FIELD(type, interface_version), \
    FULLMAG_LAYOUT_FIELD(type, torque_operator_version), FULLMAG_LAYOUT_FIELD(type, runtime_owner), \
    FULLMAG_LAYOUT_FIELD(type, convergence_reason), FULLMAG_LAYOUT_FIELD(type, error_message)
const fullmag_fdm_cpu_transport_abi_layout_field_v1 spin_result_layout_fields[] = {
    FULLMAG_SPIN_RESULT_FIELDS(fullmag_fdm_cpu_steady_spin_result_v1),
};

#define FULLMAG_LAYOUT_RECORD(name, type, fields) \
    {name, sizeof(type), alignof(type), std::size(fields), fields}
const fullmag_fdm_cpu_transport_abi_layout_record_v1 transport_layout_records[] = {
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_transport_grid_v1", fullmag_fdm_cpu_transport_grid_v1, grid_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_f64_buffer_v1", fullmag_fdm_cpu_f64_buffer_v1, f64_buffer_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_charge_boundary_v1", fullmag_fdm_cpu_charge_boundary_v1, charge_boundary_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_spin_boundary_v1", fullmag_fdm_cpu_spin_boundary_v1, spin_boundary_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_specified_current_face_v1", fullmag_fdm_cpu_specified_current_face_v1, specified_face_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_transport_interface_v1", fullmag_fdm_cpu_transport_interface_v1, interface_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_charge_interface_observation_v1", fullmag_fdm_cpu_charge_interface_observation_v1, charge_observation_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_charge_interface_observation_buffer_v1", fullmag_fdm_cpu_charge_interface_observation_buffer_v1, charge_observation_buffer_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_spin_interface_observation_v1", fullmag_fdm_cpu_spin_interface_observation_v1, spin_observation_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_spin_interface_observation_buffer_v1", fullmag_fdm_cpu_spin_interface_observation_buffer_v1, spin_observation_buffer_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_spin_reaction_lengths_v1", fullmag_fdm_cpu_spin_reaction_lengths_v1, reaction_lengths_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_charge_request_v1", fullmag_fdm_cpu_charge_request_v1, charge_request_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_charge_result_v1", fullmag_fdm_cpu_charge_result_v1, charge_result_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_steady_spin_request_v1", fullmag_fdm_cpu_steady_spin_request_v1, spin_request_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_steady_spin_result_v1", fullmag_fdm_cpu_steady_spin_result_v1, spin_result_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_transport_abi_layout_field_v1", fullmag_fdm_cpu_transport_abi_layout_field_v1, layout_field_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_transport_abi_layout_record_v1", fullmag_fdm_cpu_transport_abi_layout_record_v1, layout_record_layout_fields),
    FULLMAG_LAYOUT_RECORD("fullmag_fdm_cpu_transport_abi_layout_manifest_v1", fullmag_fdm_cpu_transport_abi_layout_manifest_v1, layout_manifest_layout_fields),
};
const fullmag_fdm_cpu_transport_abi_layout_manifest_v1 transport_layout_manifest = {
    FULLMAG_FDM_CPU_TRANSPORT_ABI_V1,
    sizeof(fullmag_fdm_cpu_transport_abi_layout_manifest_v1),
    0,
    std::size(transport_layout_records),
    transport_layout_records,
};
#undef FULLMAG_LAYOUT_RECORD
#undef FULLMAG_SPIN_RESULT_FIELDS
#undef FULLMAG_SPIN_REQUEST_FIELDS
#undef FULLMAG_CHARGE_RESULT_FIELDS
#undef FULLMAG_CHARGE_REQUEST_FIELDS
#undef FULLMAG_LAYOUT_FIELD

} // namespace

extern "C" int fullmag_fdm_cpu_transport_is_available_v1(void) {
    return 1;
}

extern "C" const fullmag_fdm_cpu_transport_abi_layout_manifest_v1 *
fullmag_fdm_cpu_transport_abi_layout_manifest_get_v1(void) {
    return &transport_layout_manifest;
}

extern "C" int fullmag_fdm_cpu_charge_solve_v1(
    const fullmag_fdm_cpu_charge_request_v1 *request,
    fullmag_fdm_cpu_charge_result_v1 *result) {
    if (result == nullptr) {
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL;
    }
    if (!charge_result_header(result)) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
                    "invalid charge result ABI header or reserved flags");
    }
    result->status = FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID;
    result->error_message[0] = '\0';
    if (request == nullptr) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL,
                    "charge request pointer is null");
    }
    if (request->abi_version != FULLMAG_FDM_CPU_TRANSPORT_ABI_V1 ||
        request->struct_size < sizeof(*request) || request->reserved_flags != 0) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
                    "invalid charge request ABI header or reserved flags");
    }
    if (result->accepted_snapshot != nullptr) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                    "charge result already owns a snapshot; destroy it before reuse");
    }
    try {
        if (request->device != FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU ||
            request->precision != FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                        "native M1 v1 supports only CPU and f64");
        }
        if (!exact_text(request->api_version, charge::api_version) ||
            !exact_text(request->operator_version, charge::operator_version) ||
            !exact_text(request->solver_version, charge::solver_version) ||
            !exact_text(request->residual_version, charge::residual_version)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                        "charge API/operator/solver/residual version mismatch");
        }
        charge::Problem problem;
        std::size_t cell_count = 0;
        std::array<std::size_t, 3> face_counts{};
        std::size_t cell_xyz = 0;
        std::size_t cell_tensor = 0;
        std::array<std::size_t, 3> face_xyz{};
        if (!grid_and_counts(request->grid, problem.grid, cell_count, face_counts) ||
            !checked_product(cell_count, 3, cell_xyz) ||
            !checked_product(cell_count, 9, cell_tensor) ||
            !checked_product(face_counts[0], 3, face_xyz[0]) ||
            !checked_product(face_counts[1], 3, face_xyz[1]) ||
            !checked_product(face_counts[2], 3, face_xyz[2]) ||
            !input_span(request->conductivity_s_per_m,
                        request->conductivity_len,
                        cell_count) ||
            !input_span(request->active_cells, request->active_cells_len, cell_count)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "charge grid or per-cell input lengths are invalid");
        }
        problem.conductivity_s_per_m.assign(request->conductivity_s_per_m,
                                            request->conductivity_s_per_m + cell_count);
        problem.active_cells.assign(request->active_cells,
                                    request->active_cells + cell_count);
        for (std::size_t face = 0; face < 6; ++face) {
            problem.boundary.values[face] = charge_boundary(request->boundaries[face]);
        }
        switch (request->gauge) {
        case FULLMAG_FDM_CPU_CHARGE_GAUGE_NONE:
            problem.gauge = charge::Gauge::none;
            break;
        case FULLMAG_FDM_CPU_CHARGE_GAUGE_ZERO_MEAN:
            problem.gauge = charge::Gauge::zero_mean;
            break;
        default:
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "unknown charge gauge");
        }
        std::size_t specified_count = 0;
        if (!input_records(request->specified_current_faces,
                           request->specified_current_face_count,
                           specified_count)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "specified current face array is invalid");
        }
        problem.specified_outward_current_density_faces.reserve(specified_count);
        for (std::size_t index = 0; index < specified_count; ++index) {
            const auto &source = request->specified_current_faces[index];
            std::size_t axis = 0;
            std::size_t face_index = 0;
            std::size_t adjacent_cell = 0;
            if (!checked_size(source.axis, axis) ||
                !checked_size(source.face_index, face_index) ||
                !checked_size(source.adjacent_cell, adjacent_cell)) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                            "specified current face index exceeds native size_t");
            }
            problem.specified_outward_current_density_faces.push_back(
                {{axis,
                  face_index,
                  adjacent_cell,
                  source.outward_normal_sign,
                  source.area_m2},
                 source.outward_current_density_a_per_m2});
        }
        std::size_t interface_count = 0;
        if (!input_records(request->interfaces,
                           request->interface_count,
                           interface_count)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "charge interface array is invalid");
        }
        std::vector<fullmag_fdm_cpu_transport_interface_v1> mixing_interfaces;
        for (std::size_t index = 0; index < interface_count; ++index) {
            const auto &source = request->interfaces[index];
            if (source.kind == FULLMAG_FDM_CPU_SPIN_INTERFACE_TRANSPARENT) {
                continue;
            }
            if (source.kind != FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                            "SML is not supported by native M1 v1");
            }
            std::size_t from = 0;
            std::size_t to = 0;
            if (!checked_size(source.from_cell, from) ||
                !checked_size(source.to_cell, to)) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                            "charge interface orientation exceeds native size_t");
            }
            problem.interfaces.push_back(charge::OrientedMixingInterface::one_way(
                charge_face(source), from, to, source.g_up_s_per_m2,
                source.g_down_s_per_m2));
            mixing_interfaces.push_back(source);
        }
        uint64_t mixing_interface_count_u64 = 0;
        if (!checked_u64(mixing_interfaces.size(), mixing_interface_count_u64)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "charge interface count exceeds uint64_t");
        }
        result->interface_observations.length = mixing_interface_count_u64;
        if (!output_buffer(result->potential_v, cell_count) ||
            !output_buffer(result->jc_x_a_per_m2, face_counts[0]) ||
            !output_buffer(result->jc_y_a_per_m2, face_counts[1]) ||
            !output_buffer(result->jc_z_a_per_m2, face_counts[2]) ||
            !output_buffer(result->jc_cell_xyz_a_per_m2, cell_xyz) ||
            result->interface_observations.capacity < mixing_interfaces.size() ||
            (!mixing_interfaces.empty() && result->interface_observations.data == nullptr)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_BUFFER,
                        "charge output buffer is too small; required lengths were published");
        }
        charge::SolverOptions options;
        options.relative_tolerance = request->relative_tolerance;
        options.absolute_tolerance_a_per_m3 = request->absolute_tolerance_a_per_m3;
        if (!checked_size(request->max_iterations, options.max_iterations)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "charge max_iterations exceeds native size_t");
        }
        auto solved = charge::solve(problem, options);
        if (!solved.ok()) {
            return fail(result, charge_status(solved.status), solved.message);
        }
        auto cell_current = charge::reconstruct_cell_current_density(
            problem.grid, solved.solution.face_current_density_a_per_m2);
        copy_scalar_vector(result->potential_v, solved.solution.potential_v);
        copy_scalar_vector(result->jc_x_a_per_m2,
                           solved.solution.face_current_density_a_per_m2.x);
        copy_scalar_vector(result->jc_y_a_per_m2,
                           solved.solution.face_current_density_a_per_m2.y);
        copy_scalar_vector(result->jc_z_a_per_m2,
                           solved.solution.face_current_density_a_per_m2.z);
        copy_array_vector<3>(result->jc_cell_xyz_a_per_m2, cell_current);
        for (std::size_t index = 0; index < mixing_interfaces.size(); ++index) {
            const auto &source = mixing_interfaces[index];
            const auto *observation = unique_interface_observation(
                source,
                solved.solution.accepted_snapshot()->interface_fluxes());
            if (observation == nullptr) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL,
                            "charge owner returned a missing or duplicate interface observation");
            }
            auto &target = result->interface_observations.data[index];
            target = {source.interface_id,
                      source.axis,
                      0,
                      source.negative_cell,
                      source.positive_cell,
                      source.from_cell,
                      source.to_cell,
                      source.g_up_s_per_m2,
                      source.g_down_s_per_m2,
                      observation->from_potential_trace_v,
                      observation->to_potential_trace_v,
                      observation->delta_potential_trace_v,
                      observation->from_to_current_density_a_per_m2,
                      observation->global_face_current_density_a_per_m2};
        }
        const auto &diagnostics = solved.solution.diagnostics;
        result->iterations = diagnostics.iterations;
        result->algebraic_residual_l2_a_per_m3 =
            diagnostics.algebraic_residual_l2_a_per_m3;
        result->recomputed_algebraic_residual_l2_a_per_m3 =
            diagnostics.recomputed_algebraic_residual_l2_a_per_m3;
        result->physical_balance_integrated_l2_a =
            diagnostics.physical_balance_integrated_l2_a;
        result->max_cell_current_imbalance_a =
            diagnostics.max_cell_current_imbalance_a;
        result->max_abs_divergence_a_per_m3 = diagnostics.max_abs_divergence_a_per_m3;
        std::copy(diagnostics.boundary_outward_current_a.begin(),
                  diagnostics.boundary_outward_current_a.end(),
                  result->boundary_outward_current_a);
        result->net_boundary_current_a = diagnostics.net_boundary_current_a;
        auto owned = std::make_unique<fullmag_fdm_cpu_charge_snapshot_v1>();
        owned->snapshot = solved.solution.accepted_snapshot();
        owned->mixing_interfaces = std::move(mixing_interfaces);
        result->accepted_snapshot_identity = owned->snapshot->identity();
        result->accepted_snapshot = owned.release();
        copy_text(result->api_version, solved.solution.provenance.api_version);
        copy_text(result->operator_version, solved.solution.provenance.operator_version);
        copy_text(result->interface_operator_version,
                  solved.solution.provenance.interface_operator_version);
        copy_text(result->solver_version, solved.solution.provenance.solver_version);
        copy_text(result->residual_version, solved.solution.provenance.residual_version);
        copy_text(result->runtime_owner, runtime_owner);
        result->status = FULLMAG_FDM_CPU_TRANSPORT_OK;
        return FULLMAG_FDM_CPU_TRANSPORT_OK;
    } catch (const std::domain_error &error) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED, error.what());
    } catch (const std::bad_alloc &) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL,
                    "native charge ABI allocation failed");
    } catch (const std::exception &error) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID, error.what());
    } catch (...) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL,
                    "unknown native charge ABI failure");
    }
}

extern "C" int fullmag_fdm_cpu_steady_spin_solve_v1(
    const fullmag_fdm_cpu_steady_spin_request_v1 *request,
    const fullmag_fdm_cpu_charge_result_v1 *charge_result,
    fullmag_fdm_cpu_steady_spin_result_v1 *result) {
    if (result == nullptr) {
        return FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL;
    }
    if (!spin_result_header(result)) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
                    "invalid spin result ABI header or reserved flags");
    }
    result->status = FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID;
    result->error_message[0] = '\0';
    if (request == nullptr || charge_result == nullptr) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL,
                    "spin request or charge result pointer is null");
    }
    if (request->abi_version != FULLMAG_FDM_CPU_TRANSPORT_ABI_V1 ||
        request->struct_size < sizeof(*request) || request->reserved_flags != 0 ||
        !charge_result_header(const_cast<fullmag_fdm_cpu_charge_result_v1 *>(charge_result))) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
                    "invalid spin request or charge result ABI header");
    }
    try {
        if (charge_result->status != FULLMAG_FDM_CPU_TRANSPORT_OK ||
            charge_result->accepted_snapshot == nullptr) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin solve requires a successful owned charge snapshot");
        }
        if (charge_result->accepted_snapshot_identity !=
            charge_result->accepted_snapshot->snapshot->identity()) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "public charge snapshot identity does not match owned snapshot");
        }
        if (request->device != FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU ||
            request->precision != FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                        "native M1 v1 supports only CPU and f64");
        }
        if (!exact_text(request->api_version, spin::api_version) ||
            !exact_text(request->formula_version, spin::formula_version) ||
            !exact_text(request->operator_version, spin::operator_version) ||
            !exact_text(request->electric_reconstruction_version,
                        spin::electric_reconstruction_version) ||
            !exact_text(request->solver_version, spin::engine_version) ||
            !exact_text(request->residual_version, spin::residual_version) ||
            !exact_text(request->local_residual_version,
                        spin::local_residual_version) ||
            !exact_text(request->interface_version, spin::interface_version) ||
            !exact_text(request->torque_operator_version,
                        spin::torque_operator_version)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                        "spin API/formula/operator/solver/interface version mismatch");
        }
        spin::Problem problem;
        std::size_t cell_count = 0;
        std::array<std::size_t, 3> face_counts{};
        std::size_t cell_xyz = 0;
        std::size_t cell_tensor = 0;
        std::array<std::size_t, 3> face_xyz{};
        if (!grid_and_counts(request->grid, problem.grid, cell_count, face_counts) ||
            !checked_product(cell_count, 3, cell_xyz) ||
            !checked_product(cell_count, 9, cell_tensor) ||
            !checked_product(face_counts[0], 3, face_xyz[0]) ||
            !checked_product(face_counts[1], 3, face_xyz[1]) ||
            !checked_product(face_counts[2], 3, face_xyz[2]) ||
            problem.grid.nx != charge_result->accepted_snapshot->snapshot->grid().nx ||
            problem.grid.ny != charge_result->accepted_snapshot->snapshot->grid().ny ||
            problem.grid.nz != charge_result->accepted_snapshot->snapshot->grid().nz ||
            problem.grid.dx_m != charge_result->accepted_snapshot->snapshot->grid().dx_m ||
            problem.grid.dy_m != charge_result->accepted_snapshot->snapshot->grid().dy_m ||
            problem.grid.dz_m != charge_result->accepted_snapshot->snapshot->grid().dz_m) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin grid must exactly match the accepted charge snapshot");
        }
        std::size_t reaction_count = 0;
        if (!input_records(request->reactions,
                           request->reaction_count,
                           reaction_count) ||
            reaction_count != cell_count ||
            !input_span(request->spin_conductivity_s_per_m,
                        request->spin_conductivity_len,
                        cell_count) ||
            !input_span(request->polarization, request->polarization_len, cell_count) ||
            !input_span(request->spin_hall_angle,
                        request->spin_hall_angle_len,
                        cell_count) ||
            !input_span(request->magnetization_xyz,
                        request->magnetization_xyz_len,
                        cell_xyz) ||
            !input_span(request->active_cells, request->active_cells_len, cell_count) ||
            !input_span(request->region_ids, request->region_id_count, cell_count) ||
            !input_span(request->torque_target_cells,
                        request->torque_target_cells_len,
                        cell_count) ||
            !input_span(request->saturation_magnetization_a_per_m,
                        request->saturation_magnetization_len,
                        cell_count)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin per-cell input lengths are invalid");
        }
        problem.accepted_charge_snapshot = charge_result->accepted_snapshot->snapshot;
        problem.spin_conductivity_s_per_m.assign(request->spin_conductivity_s_per_m,
                                                 request->spin_conductivity_s_per_m + cell_count);
        problem.polarization.assign(request->polarization,
                                    request->polarization + cell_count);
        problem.spin_hall_angle.assign(request->spin_hall_angle,
                                       request->spin_hall_angle + cell_count);
        problem.magnetization.resize(cell_count);
        problem.reactions.resize(cell_count);
        for (std::size_t cell = 0; cell < cell_count; ++cell) {
            problem.magnetization[cell] = {request->magnetization_xyz[3 * cell],
                                           request->magnetization_xyz[3 * cell + 1],
                                           request->magnetization_xyz[3 * cell + 2]};
            problem.reactions[cell] = {request->reactions[cell].spin_flip_m,
                                       request->reactions[cell].exchange_m,
                                       request->reactions[cell].dephasing_m};
        }
        problem.active_cells.assign(request->active_cells,
                                    request->active_cells + cell_count);
        problem.region_ids.assign(request->region_ids,
                                  request->region_ids + cell_count);
        for (std::size_t face = 0; face < 6; ++face) {
            problem.boundary.values[face] = spin_boundary(request->boundaries[face]);
        }
        std::size_t interface_count = 0;
        if (!input_records(request->interfaces,
                           request->interface_count,
                           interface_count)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin interface array is invalid");
        }
        for (std::size_t index = 0; index < interface_count; ++index) {
            if (request->interfaces[index].kind ==
                FULLMAG_FDM_CPU_SPIN_INTERFACE_SML_RESERVOIR_V2) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                            "SML is not supported by native M1 v1");
            }
        }
        if (!exact_accepted_mixing_interfaces(
                request->interfaces,
                interface_count,
                charge_result->accepted_snapshot->mixing_interfaces)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin mixing interfaces do not exactly match accepted charge interfaces");
        }
        problem.interfaces.reserve(interface_count);
        for (std::size_t index = 0; index < interface_count; ++index) {
            const auto &source = request->interfaces[index];
            std::size_t from = 0;
            std::size_t to = 0;
            if (!checked_size(source.from_cell, from) ||
                !checked_size(source.to_cell, to)) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                            "spin interface orientation exceeds native size_t");
            }
            const spin::StructuredFace face{charge_face(source).axis,
                                            charge_face(source).negative_cell,
                                            charge_face(source).positive_cell};
            if (source.kind == FULLMAG_FDM_CPU_SPIN_INTERFACE_TRANSPARENT) {
                problem.interfaces.push_back(spin::Interface::transparent(face, from, to));
            } else if (source.kind ==
                       FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
                problem.interfaces.push_back(spin::Interface::mixing_conductance_v2(
                    face,
                    from,
                    to,
                    source.g_up_s_per_m2,
                    source.g_down_s_per_m2,
                    source.g_r_s_per_m2,
                    source.g_i_s_per_m2,
                    {source.magnetization[0],
                     source.magnetization[1],
                     source.magnetization[2]}));
            } else {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
                            "SML is not supported by native M1 v1");
            }
        }
        problem.torque_targets.target_cells.assign(request->torque_target_cells,
                                                   request->torque_target_cells + cell_count);
        problem.torque_targets.saturation_magnetization_a_per_m.assign(
            request->saturation_magnetization_a_per_m,
            request->saturation_magnetization_a_per_m + cell_count);
        problem.torque_targets.gamma_e_rad_per_s_t = request->gamma_e_rad_per_s_t;
        uint64_t interface_count_u64 = 0;
        if (!checked_u64(interface_count, interface_count_u64)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin interface count exceeds uint64_t");
        }
        result->interface_observations.length = interface_count_u64;
        if (!output_buffer(result->spin_potential_xyz_v, cell_xyz) ||
            !output_buffer(result->q_x_xyz_a_per_m2, face_xyz[0]) ||
            !output_buffer(result->q_y_xyz_a_per_m2, face_xyz[1]) ||
            !output_buffer(result->q_z_xyz_a_per_m2, face_xyz[2]) ||
            !output_buffer(result->q_cell_ia_a_per_m2, cell_tensor) ||
            !output_buffer(result->reaction_spin_flip_xyz_a_per_m3, cell_xyz) ||
            !output_buffer(result->reaction_exchange_xyz_a_per_m3, cell_xyz) ||
            !output_buffer(result->reaction_dephasing_xyz_a_per_m3, cell_xyz) ||
            !output_buffer(result->reaction_total_xyz_a_per_m3, cell_xyz) ||
            !output_buffer(result->transport_torque_xyz_per_s, cell_xyz) ||
            result->interface_observations.capacity < interface_count ||
            (interface_count != 0 && result->interface_observations.data == nullptr)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_BUFFER,
                        "spin output buffer is too small; required lengths were published");
        }
        spin::SolverOptions options;
        options.relative_tolerance = request->relative_tolerance;
        options.absolute_tolerance_a = request->absolute_tolerance_a;
        options.local_relative_tolerance = request->local_relative_tolerance;
        options.local_absolute_tolerance_a_per_m3 =
            request->local_absolute_tolerance_a_per_m3;
        if (!checked_size(request->max_iterations, options.max_iterations) ||
            !checked_size(request->gmres_restart, options.gmres_restart)) {
            return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
                        "spin iteration controls exceed native size_t");
        }
        auto solved = spin::solve(problem, options);
        if (!solved.ok()) {
            return fail(result, spin_status(solved.status), solved.message);
        }
        auto cell_tensor_values = spin::reconstruct_cell_spin_current_tensor(
            problem.grid, solved.solution.face_spin_current_density_a_per_m2);
        copy_array_vector<3>(result->spin_potential_xyz_v,
                             solved.solution.spin_potential_v);
        copy_array_vector<3>(result->q_x_xyz_a_per_m2,
                             solved.solution.face_spin_current_density_a_per_m2.x);
        copy_array_vector<3>(result->q_y_xyz_a_per_m2,
                             solved.solution.face_spin_current_density_a_per_m2.y);
        copy_array_vector<3>(result->q_z_xyz_a_per_m2,
                             solved.solution.face_spin_current_density_a_per_m2.z);
        copy_array_vector<9>(result->q_cell_ia_a_per_m2, cell_tensor_values);
        for (std::size_t cell = 0; cell < cell_count; ++cell) {
            const auto &reaction = solved.solution.reaction_channels[cell];
            for (std::size_t component = 0; component < 3; ++component) {
                const std::size_t output = 3 * cell + component;
                result->reaction_spin_flip_xyz_a_per_m3.data[output] =
                    reaction.spin_flip_a_per_m3[component];
                result->reaction_exchange_xyz_a_per_m3.data[output] =
                    reaction.exchange_a_per_m3[component];
                result->reaction_dephasing_xyz_a_per_m3.data[output] =
                    reaction.dephasing_a_per_m3[component];
                result->reaction_total_xyz_a_per_m3.data[output] =
                    reaction.spin_flip_a_per_m3[component] +
                    reaction.exchange_a_per_m3[component] +
                    reaction.dephasing_a_per_m3[component];
                result->transport_torque_xyz_per_s.data[output] =
                    solved.solution.transport_gilbert_torque_per_s[cell][component];
            }
        }
        for (std::size_t index = 0; index < interface_count; ++index) {
            const auto &source = request->interfaces[index];
            const auto *observation = unique_interface_observation(
                source,
                solved.solution.interface_fluxes);
            if (observation == nullptr) {
                return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL,
                            "spin owner returned a missing or duplicate interface observation");
            }
            auto &target = result->interface_observations.data[index];
            target.interface_id = source.interface_id;
            target.axis = source.axis;
            target.reserved = 0;
            target.negative_cell = source.negative_cell;
            target.positive_cell = source.positive_cell;
            target.from_cell = source.from_cell;
            target.to_cell = source.to_cell;
            for (std::size_t component = 0; component < 3; ++component) {
                target.incoming_longitudinal_a_per_m2[component] =
                    observation->incoming_longitudinal_a_per_m2[component];
                target.backflow_longitudinal_a_per_m2[component] =
                    observation->backflow_longitudinal_a_per_m2[component];
                target.absorbed_transverse_a_per_m2[component] =
                    observation->absorbed_transverse_a_per_m2[component];
                target.negative_cell_flux_positive_axis_a_per_m2[component] =
                    observation->negative_cell_flux_positive_axis_a_per_m2[component];
                target.positive_cell_flux_positive_axis_a_per_m2[component] =
                    observation->positive_cell_flux_positive_axis_a_per_m2[component];
                const bool from_is_negative = source.from_cell == source.negative_cell;
                target.from_side_outgoing_a_per_m2[component] =
                    from_is_negative
                        ? observation->negative_cell_flux_positive_axis_a_per_m2[component]
                        : -observation->positive_cell_flux_positive_axis_a_per_m2[component];
                target.to_side_transmitted_a_per_m2[component] =
                    from_is_negative
                        ? observation->positive_cell_flux_positive_axis_a_per_m2[component]
                        : -observation->negative_cell_flux_positive_axis_a_per_m2[component];
            }
        }
        const auto &diagnostics = solved.solution.diagnostics;
        result->iterations = diagnostics.iterations;
        result->gmres_restart = diagnostics.gmres_restart;
        result->initial_rhs_integrated_l2_a = diagnostics.initial_rhs_integrated_l2_a;
        result->recursive_residual_integrated_l2_a =
            diagnostics.recursive_residual_integrated_l2_a;
        result->recomputed_balance_integrated_l2_a =
            diagnostics.recomputed_balance_integrated_l2_a;
        result->balance_tolerance_integrated_l2_a =
            diagnostics.balance_tolerance_integrated_l2_a;
        std::size_t boundary_output = 0;
        for (const auto &boundary : diagnostics.boundary_outward_current_a) {
            for (double component : boundary) {
                result->boundary_outward_current_a[boundary_output++] = component;
            }
        }
        std::copy(diagnostics.global_balance_closure_a.begin(),
                  diagnostics.global_balance_closure_a.end(),
                  result->global_balance_closure_a);
        result->relative_global_balance = diagnostics.relative_global_balance;
        result->max_abs_residual_a_per_m3 = diagnostics.max_abs_residual_a_per_m3;
        copy_text(result->api_version, solved.solution.provenance.api_version);
        copy_text(result->formula_version, solved.solution.provenance.formula_version);
        copy_text(result->operator_version, solved.solution.provenance.operator_version);
        copy_text(result->electric_reconstruction_version,
                  solved.solution.provenance.electric_reconstruction_version);
        copy_text(result->solver_version, solved.solution.provenance.engine_version);
        copy_text(result->residual_version, solved.solution.provenance.residual_version);
        copy_text(result->local_residual_version,
                  solved.solution.provenance.local_residual_version);
        copy_text(result->interface_version, solved.solution.provenance.interface_version);
        copy_text(result->torque_operator_version,
                  solved.solution.provenance.torque_operator_version);
        copy_text(result->runtime_owner, runtime_owner);
        copy_text(result->convergence_reason, diagnostics.convergence_reason);
        result->status = FULLMAG_FDM_CPU_TRANSPORT_OK;
        return FULLMAG_FDM_CPU_TRANSPORT_OK;
    } catch (const std::domain_error &error) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED, error.what());
    } catch (const std::bad_alloc &) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL,
                    "native spin ABI allocation failed");
    } catch (const std::exception &error) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID, error.what());
    } catch (...) {
        return fail(result, FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL,
                    "unknown native spin ABI failure");
    }
}

extern "C" void fullmag_fdm_cpu_charge_result_destroy_v1(
    fullmag_fdm_cpu_charge_result_v1 *result) {
    if (!result_field_available(result,
                                offsetof(fullmag_fdm_cpu_charge_result_v1,
                                         accepted_snapshot),
                                sizeof(result->accepted_snapshot))) {
        return;
    }
    auto *owned = result->accepted_snapshot;
    result->accepted_snapshot = nullptr;
    if (result_field_available(result,
                               offsetof(fullmag_fdm_cpu_charge_result_v1,
                                        accepted_snapshot_identity),
                               sizeof(result->accepted_snapshot_identity))) {
        result->accepted_snapshot_identity = 0;
    }
    try {
        delete owned;
    } catch (...) {
    }
}
