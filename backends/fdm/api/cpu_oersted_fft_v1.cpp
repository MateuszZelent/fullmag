#include "fullmag_fdm.h"

#include <fullmag/fdm/cpu/oersted_fft_open_v1.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace oe = fullmag::fdm::cpu::oersted::v1;

namespace {

template <std::size_t N>
void copy_text(char (&target)[N], std::string_view value) noexcept {
    std::memset(target, 0, N);
    const std::size_t count = std::min(value.size(), N - 1U);
    std::memcpy(target, value.data(), count);
}

bool result_header(fullmag_fdm_cpu_oersted_result_v1 *result) noexcept {
    struct Header {
        std::uint32_t abi_version;
        std::uint32_t struct_size;
    } header{};
    if (result == nullptr) {
        return false;
    }
    std::memcpy(&header, result, sizeof(header));
    return header.abi_version == FULLMAG_FDM_CPU_OERSTED_ABI_V1 &&
           header.struct_size >= sizeof(*result) && result->reserved_flags == 0U;
}

int fail(fullmag_fdm_cpu_oersted_result_v1 *result,
         int status,
         std::string_view message) noexcept {
    if (result_header(result)) {
        result->status = status;
        result->field_xyz_a_per_m.length = 0U;
        copy_text(result->error_message, message);
    }
    return status;
}

std::string required_text(const char *value, std::string_view name) {
    if (value == nullptr) {
        throw std::invalid_argument(std::string(name) + " is null");
    }
    constexpr std::size_t maximum = 4096U;
    const void *end = std::memchr(value, '\0', maximum);
    if (end == nullptr) {
        throw std::invalid_argument(std::string(name) + " is not terminated");
    }
    const std::size_t length =
        static_cast<const char *>(end) - value;
    if (length == 0U) {
        throw std::invalid_argument(std::string(name) + " is empty");
    }
    return std::string(value, length);
}

std::string optional_text(const char *value, std::string_view name) {
    if (value == nullptr) {
        return {};
    }
    constexpr std::size_t maximum = 4096U;
    const void *end = std::memchr(value, '\0', maximum);
    if (end == nullptr) {
        throw std::invalid_argument(std::string(name) + " is not terminated");
    }
    return std::string(value, static_cast<const char *>(end) - value);
}

std::string required_result_text(const char *value,
                                 std::string_view name,
                                 std::size_t result_capacity) {
    std::string output = required_text(value, name);
    if (output.size() >= result_capacity) {
        throw std::invalid_argument(std::string(name) +
                                    " exceeds lossless result capacity");
    }
    return output;
}

bool same_f64(double left, double right) noexcept {
    std::uint64_t left_bits = 0U;
    std::uint64_t right_bits = 0U;
    static_assert(sizeof(left_bits) == sizeof(left));
    std::memcpy(&left_bits, &left, sizeof(left_bits));
    std::memcpy(&right_bits, &right, sizeof(right_bits));
    return left_bits == right_bits;
}

bool same_f64_vector(const std::vector<double> &left,
                     const std::vector<double> &right) noexcept {
    return left.size() == right.size() &&
           std::equal(left.begin(), left.end(), right.begin(), same_f64);
}

bool same_grid(const oe::Grid &left, const oe::Grid &right) noexcept {
    return left.nx == right.nx && left.ny == right.ny && left.nz == right.nz &&
           same_f64(left.dx_m, right.dx_m) &&
           same_f64(left.dy_m, right.dy_m) &&
           same_f64(left.dz_m, right.dz_m) &&
           std::equal(left.origin_m.begin(),
                      left.origin_m.end(),
                      right.origin_m.begin(),
                      same_f64) &&
           left.boundaries == right.boundaries;
}

bool same_source_cut(const oe::SourceCutRecord &left,
                     const oe::SourceCutRecord &right) noexcept {
    return left.stable_id == right.stable_id &&
           left.component_label == right.component_label &&
           left.ordered_internal_face_ids == right.ordered_internal_face_ids &&
           left.ordered_normals == right.ordered_normals &&
           left.drive_id == right.drive_id && left.drive_kind == right.drive_kind &&
           same_f64(left.drive_value, right.drive_value) &&
           left.drive_si_unit == right.drive_si_unit &&
           left.revision == right.revision && left.digest == right.digest;
}

bool same_certificate(const oe::GlobalClosedCurrentCertificate &left,
                      const oe::GlobalClosedCurrentCertificate &right) noexcept {
    return left.version == right.version &&
           left.closure_kind == right.closure_kind &&
           left.revision == right.revision && left.digest == right.digest &&
           left.geometry_digest == right.geometry_digest &&
           left.conductor_mask_revision == right.conductor_mask_revision &&
           left.conductor_mask_digest == right.conductor_mask_digest &&
           left.face_current_revision == right.face_current_revision &&
           left.face_current_digest == right.face_current_digest &&
           left.component_labels == right.component_labels &&
           left.component_count == right.component_count &&
           left.global_continuity_passed == right.global_continuity_passed &&
           left.exterior_flux_passed == right.exterior_flux_passed &&
           left.component_flux_passed == right.component_flux_passed &&
           left.return_path_complete == right.return_path_complete &&
           same_f64(left.divergence_tolerance_a_per_m3,
                    right.divergence_tolerance_a_per_m3) &&
           same_f64(left.exterior_current_tolerance_a,
                    right.exterior_current_tolerance_a) &&
           same_f64(left.measured_max_abs_divergence_a_per_m3,
                    right.measured_max_abs_divergence_a_per_m3) &&
           same_f64_vector(left.measured_component_exterior_current_a,
                           right.measured_component_exterior_current_a) &&
           left.source_cuts.size() == right.source_cuts.size() &&
           std::equal(left.source_cuts.begin(),
                      left.source_cuts.end(),
                      right.source_cuts.begin(),
                      same_source_cut) &&
           left.imported_certification_method ==
               right.imported_certification_method &&
           left.imported_field_digest == right.imported_field_digest;
}

bool same_problem(const oe::Problem &left, const oe::Problem &right) noexcept {
    return same_grid(left.grid, right.grid) &&
           left.conductor_mask == right.conductor_mask &&
           left.target_mask == right.target_mask &&
           same_f64_vector(left.face_current_density_a_per_m2.x,
                           right.face_current_density_a_per_m2.x) &&
           same_f64_vector(left.face_current_density_a_per_m2.y,
                           right.face_current_density_a_per_m2.y) &&
           same_f64_vector(left.face_current_density_a_per_m2.z,
                           right.face_current_density_a_per_m2.z) &&
           left.geometry_revision == right.geometry_revision &&
           left.geometry_digest == right.geometry_digest &&
           left.conductor_mask_revision == right.conductor_mask_revision &&
           left.conductor_mask_digest == right.conductor_mask_digest &&
           left.target_mask_revision == right.target_mask_revision &&
           left.target_mask_digest == right.target_mask_digest &&
           left.face_current_revision == right.face_current_revision &&
           left.face_current_digest == right.face_current_digest &&
           left.source_identity == right.source_identity &&
           left.envelope_revision == right.envelope_revision &&
           left.envelope_digest == right.envelope_digest &&
           left.stage_identity == right.stage_identity &&
           same_f64(left.evaluation_time_s, right.evaluation_time_s) &&
           same_f64(left.evaluated_envelope_multiplier,
                    right.evaluated_envelope_multiplier) &&
           left.trusted_snapshot_revision == right.trusted_snapshot_revision &&
           left.trusted_snapshot_digest == right.trusted_snapshot_digest &&
           same_certificate(left.closure_certificate,
                            right.closure_certificate);
}

const oe::SolveResult &solve_immutable_snapshot(oe::Problem candidate) {
    struct BoundaryCache {
        std::unique_ptr<oe::Solver> solver;
        std::unique_ptr<const oe::Problem> problem;
    };
    thread_local BoundaryCache cache;
    if (!cache.problem || !same_problem(*cache.problem, candidate)) {
        auto next_problem =
            std::make_unique<const oe::Problem>(std::move(candidate));
        auto next_solver = std::make_unique<oe::Solver>();
        cache.solver = std::move(next_solver);
        cache.problem = std::move(next_problem);
    }
    return cache.solver->solve(*cache.problem);
}

bool checked_size(std::uint64_t value, std::size_t &output) noexcept {
    if (value > static_cast<std::uint64_t>(
                    std::numeric_limits<std::size_t>::max())) {
        return false;
    }
    output = static_cast<std::size_t>(value);
    return true;
}

bool checked_product(std::size_t left,
                     std::size_t right,
                     std::size_t &output) noexcept {
    if (left != 0U && right > std::numeric_limits<std::size_t>::max() / left) {
        return false;
    }
    output = left * right;
    return true;
}

bool grid_and_counts(const fullmag_fdm_cpu_oersted_request_v1 &request,
                     oe::Grid &grid,
                     std::size_t &cells,
                     std::array<std::size_t, 3> &faces) noexcept {
    if (!checked_size(request.grid.nx, grid.nx) ||
        !checked_size(request.grid.ny, grid.ny) ||
        !checked_size(request.grid.nz, grid.nz) || grid.nx == 0U ||
        grid.ny == 0U || grid.nz == 0U ||
        !std::isfinite(request.grid.dx_m) || request.grid.dx_m <= 0.0 ||
        !std::isfinite(request.grid.dy_m) || request.grid.dy_m <= 0.0 ||
        !std::isfinite(request.grid.dz_m) || request.grid.dz_m <= 0.0) {
        return false;
    }
    grid.dx_m = request.grid.dx_m;
    grid.dy_m = request.grid.dy_m;
    grid.dz_m = request.grid.dz_m;
    std::copy(std::begin(request.origin_m), std::end(request.origin_m),
              grid.origin_m.begin());
    if (!std::all_of(grid.origin_m.begin(), grid.origin_m.end(),
                     [](double value) { return std::isfinite(value); })) {
        return false;
    }
    for (std::size_t axis = 0; axis < 3U; ++axis) {
        switch (request.boundaries[axis]) {
        case FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN:
            grid.boundaries[axis] = oe::AxisBoundary::open;
            break;
        case FULLMAG_FDM_CPU_OERSTED_BOUNDARY_PERIODIC:
            grid.boundaries[axis] = oe::AxisBoundary::periodic;
            break;
        default:
            return false;
        }
    }
    std::size_t xy = 0U;
    std::size_t scratch = 0U;
    return checked_product(grid.nx, grid.ny, xy) &&
           checked_product(xy, grid.nz, cells) &&
           grid.nx != std::numeric_limits<std::size_t>::max() &&
           grid.ny != std::numeric_limits<std::size_t>::max() &&
           grid.nz != std::numeric_limits<std::size_t>::max() &&
           checked_product(grid.nx + 1U, grid.ny, scratch) &&
           checked_product(scratch, grid.nz, faces[0]) &&
           checked_product(grid.nx, grid.ny + 1U, scratch) &&
           checked_product(scratch, grid.nz, faces[1]) &&
           checked_product(grid.nx, grid.ny, scratch) &&
           checked_product(scratch, grid.nz + 1U, faces[2]);
}

template <typename T>
std::vector<T> copy_span(const T *data,
                         std::uint64_t length,
                         std::size_t expected,
                         std::string_view name) {
    std::size_t actual = 0U;
    if (!checked_size(length, actual) || actual != expected ||
        (actual != 0U && data == nullptr)) {
        throw std::invalid_argument(std::string(name) + " shape mismatch");
    }
    if (actual == 0U) {
        return {};
    }
    return std::vector<T>(data, data + actual);
}

oe::SourceCutRecord source_cut(
    const fullmag_fdm_cpu_oersted_source_cut_v1 &input) {
    oe::SourceCutRecord output;
    output.stable_id = required_text(input.stable_id, "source_cut.stable_id");
    output.component_label = input.component_label;
    std::size_t face_count = 0U;
    if (!checked_size(input.ordered_internal_face_ids.length, face_count)) {
        throw std::invalid_argument("source_cut face count overflows");
    }
    output.ordered_internal_face_ids = copy_span(
        input.ordered_internal_face_ids.data,
        input.ordered_internal_face_ids.length,
        face_count,
        "source_cut face ids");
    output.ordered_normals = copy_span(input.ordered_normals.data,
                                       input.ordered_normals.length,
                                       face_count,
                                       "source_cut normals");
    output.drive_id = required_text(input.drive_id, "source_cut.drive_id");
    output.drive_kind = required_text(input.drive_kind, "source_cut.drive_kind");
    output.drive_value = input.drive_value;
    output.drive_si_unit =
        required_text(input.drive_si_unit, "source_cut.drive_si_unit");
    output.revision = input.revision;
    output.digest = required_text(input.digest, "source_cut.digest");
    return output;
}

oe::GlobalClosedCurrentCertificate certificate(
    const fullmag_fdm_cpu_oersted_certificate_v1 &input,
    std::size_t cells) {
    if (input.abi_version != FULLMAG_FDM_CPU_OERSTED_ABI_V1 ||
        input.struct_size < sizeof(input) || input.reserved_flags != 0U ||
        input.reserved0 != 0U) {
        throw std::invalid_argument("invalid Oersted certificate ABI header");
    }
    oe::GlobalClosedCurrentCertificate output;
    switch (input.closure_kind) {
    case FULLMAG_FDM_CPU_OERSTED_CLOSURE_CLOSED_GEOMETRY:
        output.closure_kind = oe::ClosureKind::closed_geometry;
        break;
    case FULLMAG_FDM_CPU_OERSTED_CLOSURE_CERTIFIED_IMPORT:
        output.closure_kind = oe::ClosureKind::certified_import;
        break;
    default:
        throw std::invalid_argument("unknown Oersted closure kind");
    }
    const auto flag = [](std::uint32_t value, std::string_view name) {
        if (value > 1U) {
            throw std::invalid_argument(std::string(name) + " is not boolean");
        }
        return value == 1U;
    };
    output.global_continuity_passed =
        flag(input.global_continuity_passed, "global_continuity_passed");
    output.exterior_flux_passed =
        flag(input.exterior_flux_passed, "exterior_flux_passed");
    output.component_flux_passed =
        flag(input.component_flux_passed, "component_flux_passed");
    output.return_path_complete =
        flag(input.return_path_complete, "return_path_complete");
    output.revision = input.revision;
    output.version = required_text(input.version, "certificate.version");
    output.digest = required_text(input.digest, "certificate.digest");
    output.geometry_digest =
        required_text(input.geometry_digest, "certificate.geometry_digest");
    output.conductor_mask_revision = input.conductor_mask_revision;
    output.conductor_mask_digest = required_text(
        input.conductor_mask_digest, "certificate.conductor_mask_digest");
    output.face_current_revision = input.face_current_revision;
    output.face_current_digest = required_text(
        input.face_current_digest, "certificate.face_current_digest");
    output.component_labels = copy_span(input.component_labels.data,
                                        input.component_labels.length,
                                        cells,
                                        "certificate component labels");
    if (!checked_size(input.component_count, output.component_count)) {
        throw std::invalid_argument("certificate component count overflows");
    }
    output.divergence_tolerance_a_per_m3 =
        input.divergence_tolerance_a_per_m3;
    output.exterior_current_tolerance_a = input.exterior_current_tolerance_a;
    output.measured_max_abs_divergence_a_per_m3 =
        input.measured_max_abs_divergence_a_per_m3;
    output.measured_component_exterior_current_a = copy_span(
        input.measured_component_exterior_current_a.data,
        input.measured_component_exterior_current_a.length,
        output.component_count,
        "certificate exterior current");
    std::size_t cut_count = 0U;
    if (!checked_size(input.source_cut_count, cut_count) ||
        (cut_count != 0U && input.source_cuts == nullptr)) {
        throw std::invalid_argument("certificate source-cut shape mismatch");
    }
    output.source_cuts.reserve(cut_count);
    for (std::size_t index = 0U; index < cut_count; ++index) {
        output.source_cuts.push_back(source_cut(input.source_cuts[index]));
    }
    output.imported_certification_method = optional_text(
        input.imported_certification_method,
        "certificate.imported_certification_method");
    output.imported_field_digest = optional_text(
        input.imported_field_digest, "certificate.imported_field_digest");
    return output;
}

int mapped_status(oe::Status status) noexcept {
    switch (status) {
    case oe::Status::ok:
        return FULLMAG_FDM_CPU_OERSTED_OK;
    case oe::Status::periodic_unsupported:
        return FULLMAG_FDM_CPU_OERSTED_ERR_PERIODIC;
    case oe::Status::missing_certificate:
        return FULLMAG_FDM_CPU_OERSTED_ERR_MISSING_CERTIFICATE;
    case oe::Status::stale_certificate:
        return FULLMAG_FDM_CPU_OERSTED_ERR_STALE_CERTIFICATE;
    case oe::Status::open_circuit:
        return FULLMAG_FDM_CPU_OERSTED_ERR_OPEN_CIRCUIT;
    case oe::Status::closure_failure:
        return FULLMAG_FDM_CPU_OERSTED_ERR_CLOSURE;
    case oe::Status::numerical_failure:
        return FULLMAG_FDM_CPU_OERSTED_ERR_NUMERICAL;
    default:
        return FULLMAG_FDM_CPU_OERSTED_ERR_INVALID;
    }
}

const fullmag_fdm_cpu_oersted_abi_layout_v1 layout{
    FULLMAG_FDM_CPU_OERSTED_ABI_V1,
    sizeof(fullmag_fdm_cpu_oersted_abi_layout_v1),
    0U,
    sizeof(fullmag_fdm_cpu_oersted_source_cut_v1),
    alignof(fullmag_fdm_cpu_oersted_source_cut_v1),
    sizeof(fullmag_fdm_cpu_oersted_certificate_v1),
    alignof(fullmag_fdm_cpu_oersted_certificate_v1),
    sizeof(fullmag_fdm_cpu_oersted_request_v1),
    alignof(fullmag_fdm_cpu_oersted_request_v1),
    sizeof(fullmag_fdm_cpu_oersted_result_v1),
    alignof(fullmag_fdm_cpu_oersted_result_v1),
};

#define FULLMAG_OERSTED_LAYOUT_FIELD(type, field) {#field, offsetof(type, field)}
#define FULLMAG_OERSTED_LAYOUT_RECORD(name, type, fields)                         \
    {name, sizeof(type), alignof(type), std::size(fields), fields}

const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_f64_buffer_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(
            fullmag_fdm_cpu_oersted_const_f64_buffer_v1, data),
        FULLMAG_OERSTED_LAYOUT_FIELD(
            fullmag_fdm_cpu_oersted_const_f64_buffer_v1, length),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_u64_buffer_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(
            fullmag_fdm_cpu_oersted_const_u64_buffer_v1, data),
        FULLMAG_OERSTED_LAYOUT_FIELD(
            fullmag_fdm_cpu_oersted_const_u64_buffer_v1, length),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_i8_buffer_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(
            fullmag_fdm_cpu_oersted_const_i8_buffer_v1, data),
        FULLMAG_OERSTED_LAYOUT_FIELD(
            fullmag_fdm_cpu_oersted_const_i8_buffer_v1, length),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_source_cut_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    stable_id),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    component_label),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    ordered_internal_face_ids),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    ordered_normals),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    drive_id),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    drive_kind),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    drive_value),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    drive_si_unit),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_source_cut_v1,
                                    digest),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_certificate_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    abi_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    struct_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    reserved_flags),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    closure_kind),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    global_continuity_passed),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    exterior_flux_passed),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    component_flux_passed),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    return_path_complete),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    reserved0),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    geometry_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    conductor_mask_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    conductor_mask_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    face_current_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    face_current_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    component_labels),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    component_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    divergence_tolerance_a_per_m3),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    exterior_current_tolerance_a),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    measured_max_abs_divergence_a_per_m3),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    measured_component_exterior_current_a),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    source_cuts),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    source_cut_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    imported_certification_method),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_certificate_v1,
                                    imported_field_digest),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_request_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    abi_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    struct_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    reserved_flags),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1, grid),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    origin_m),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    boundaries),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    reserved0),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    conductor_mask),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    conductor_mask_len),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    target_mask),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    target_mask_len),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    jc_x_a_per_m2),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    jc_y_a_per_m2),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    jc_z_a_per_m2),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    geometry_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    geometry_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    conductor_mask_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    conductor_mask_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    target_mask_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    target_mask_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    face_current_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    face_current_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    source_identity),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    envelope_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    envelope_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    stage_identity),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    evaluation_time_s),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    evaluated_envelope_multiplier),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    trusted_snapshot_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    trusted_snapshot_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_request_v1,
                                    certificate),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_result_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    abi_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    struct_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    reserved_flags),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1, status),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    reserved0),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    field_xyz_a_per_m),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    face_current_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    certificate_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    trusted_snapshot_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    envelope_revision),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    stage_identity),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    evaluation_time_s),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    evaluated_envelope_multiplier),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    plan_build_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    kernel_build_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    numerical_buffer_allocation_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    resolved_field_hit_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    resolved_field_miss_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    resolved_field_invalidation_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    trusted_fast_path_hit_count),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    resolved_field_reused),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    diagnostics_available),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    divergence_current_rms_a_per_m3),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    divergence_field_rms_a_per_m2),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    curl_h_minus_j_rms_a_per_m2),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    api_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    formula_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    reconstruction_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    operator_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    realization_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    engine_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    certificate_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    face_current_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    certificate_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    trusted_snapshot_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    resolved_field_cache_key_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    kernel_plan_cache_key_digest),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    source_identity),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_result_v1,
                                    error_message),
};
const fullmag_fdm_cpu_transport_abi_layout_field_v1
    oersted_layout_layout_fields[] = {
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    abi_version),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    struct_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    reserved_flags),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    source_cut_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    source_cut_alignment),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    certificate_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    certificate_alignment),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    request_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    request_alignment),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    result_size),
        FULLMAG_OERSTED_LAYOUT_FIELD(fullmag_fdm_cpu_oersted_abi_layout_v1,
                                    result_alignment),
};

const fullmag_fdm_cpu_transport_abi_layout_record_v1 oersted_layout_records[] = {
    FULLMAG_OERSTED_LAYOUT_RECORD(
        "fullmag_fdm_cpu_oersted_const_f64_buffer_v1",
        fullmag_fdm_cpu_oersted_const_f64_buffer_v1,
        oersted_f64_buffer_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD(
        "fullmag_fdm_cpu_oersted_const_u64_buffer_v1",
        fullmag_fdm_cpu_oersted_const_u64_buffer_v1,
        oersted_u64_buffer_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD(
        "fullmag_fdm_cpu_oersted_const_i8_buffer_v1",
        fullmag_fdm_cpu_oersted_const_i8_buffer_v1,
        oersted_i8_buffer_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD("fullmag_fdm_cpu_oersted_source_cut_v1",
                                 fullmag_fdm_cpu_oersted_source_cut_v1,
                                 oersted_source_cut_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD("fullmag_fdm_cpu_oersted_certificate_v1",
                                 fullmag_fdm_cpu_oersted_certificate_v1,
                                 oersted_certificate_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD("fullmag_fdm_cpu_oersted_request_v1",
                                 fullmag_fdm_cpu_oersted_request_v1,
                                 oersted_request_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD("fullmag_fdm_cpu_oersted_result_v1",
                                 fullmag_fdm_cpu_oersted_result_v1,
                                 oersted_result_layout_fields),
    FULLMAG_OERSTED_LAYOUT_RECORD("fullmag_fdm_cpu_oersted_abi_layout_v1",
                                 fullmag_fdm_cpu_oersted_abi_layout_v1,
                                 oersted_layout_layout_fields),
};
const fullmag_fdm_cpu_transport_abi_layout_manifest_v1
    oersted_layout_manifest{
        FULLMAG_FDM_CPU_OERSTED_ABI_V1,
        sizeof(fullmag_fdm_cpu_transport_abi_layout_manifest_v1),
        0U,
        std::size(oersted_layout_records),
        oersted_layout_records,
    };

#undef FULLMAG_OERSTED_LAYOUT_RECORD
#undef FULLMAG_OERSTED_LAYOUT_FIELD

} // namespace

extern "C" const fullmag_fdm_cpu_oersted_abi_layout_v1 *
fullmag_fdm_cpu_oersted_abi_layout_get_v1(void) {
    return &layout;
}

extern "C" const fullmag_fdm_cpu_transport_abi_layout_manifest_v1 *
fullmag_fdm_cpu_oersted_abi_layout_manifest_get_v1(void) {
    return &oersted_layout_manifest;
}

extern "C"
int fullmag_fdm_cpu_oersted_solve_v1(
    const fullmag_fdm_cpu_oersted_request_v1 *request,
    fullmag_fdm_cpu_oersted_result_v1 *result) {
    if (request == nullptr || result == nullptr) {
        return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_NULL,
                    "request and result are required");
    }
    if (!result_header(result) ||
        request->abi_version != FULLMAG_FDM_CPU_OERSTED_ABI_V1 ||
        request->struct_size < sizeof(*request) || request->reserved_flags != 0U ||
        request->reserved0 != 0U) {
        return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_ABI,
                    "invalid Oersted v1 ABI header or reserved data");
    }
    if (request->certificate == nullptr) {
        return fail(result,
                    FULLMAG_FDM_CPU_OERSTED_ERR_MISSING_CERTIFICATE,
                    "global_closed_current_certificate.v1 is required");
    }
    try {
        oe::Problem problem;
        std::size_t cells = 0U;
        std::array<std::size_t, 3> faces{};
        if (!grid_and_counts(*request, problem.grid, cells, faces)) {
            return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_INVALID,
                        "invalid grid, boundary enum or count overflow");
        }
        problem.conductor_mask = copy_span(request->conductor_mask,
                                           request->conductor_mask_len,
                                           cells,
                                           "conductor mask");
        problem.target_mask = copy_span(request->target_mask,
                                        request->target_mask_len,
                                        cells,
                                        "target mask");
        problem.face_current_density_a_per_m2.x = copy_span(
            request->jc_x_a_per_m2.data,
            request->jc_x_a_per_m2.length,
            faces[0],
            "accepted Jc x faces");
        problem.face_current_density_a_per_m2.y = copy_span(
            request->jc_y_a_per_m2.data,
            request->jc_y_a_per_m2.length,
            faces[1],
            "accepted Jc y faces");
        problem.face_current_density_a_per_m2.z = copy_span(
            request->jc_z_a_per_m2.data,
            request->jc_z_a_per_m2.length,
            faces[2],
            "accepted Jc z faces");
        problem.geometry_revision = request->geometry_revision;
        problem.geometry_digest =
            required_text(request->geometry_digest, "geometry_digest");
        problem.conductor_mask_revision = request->conductor_mask_revision;
        problem.conductor_mask_digest = required_text(
            request->conductor_mask_digest, "conductor_mask_digest");
        problem.target_mask_revision = request->target_mask_revision;
        problem.target_mask_digest =
            required_text(request->target_mask_digest, "target_mask_digest");
        problem.face_current_revision = request->face_current_revision;
        problem.face_current_digest =
            required_text(request->face_current_digest, "face_current_digest");
        problem.source_identity = required_result_text(
            request->source_identity,
            "source_identity",
            FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY);
        problem.envelope_revision = request->envelope_revision;
        problem.envelope_digest =
            required_text(request->envelope_digest, "envelope_digest");
        problem.stage_identity = request->stage_identity;
        problem.evaluation_time_s = request->evaluation_time_s;
        problem.evaluated_envelope_multiplier =
            request->evaluated_envelope_multiplier;
        problem.trusted_snapshot_revision = request->trusted_snapshot_revision;
        problem.trusted_snapshot_digest = required_text(
            request->trusted_snapshot_digest, "trusted_snapshot_digest");
        problem.closure_certificate = certificate(*request->certificate, cells);

        std::size_t field_scalars = 0U;
        if (!checked_product(cells, 3U, field_scalars) ||
            result->field_xyz_a_per_m.capacity < field_scalars ||
            (field_scalars != 0U && result->field_xyz_a_per_m.data == nullptr)) {
            return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_BUFFER,
                        "field output buffer is too small");
        }

        const oe::SolveResult &solved =
            solve_immutable_snapshot(std::move(problem));
        if (!solved.ok()) {
            return fail(result, mapped_status(solved.status), solved.message);
        }
        std::size_t scalar = 0U;
        for (const auto &field : solved.solution.field_a_per_m) {
            for (double component : field) {
                result->field_xyz_a_per_m.data[scalar++] = component;
            }
        }
        result->field_xyz_a_per_m.length = field_scalars;
        const auto &provenance = solved.solution.provenance;
        const auto &diagnostics = solved.solution.diagnostics;
        const auto &cache = provenance.cache;
        result->status = FULLMAG_FDM_CPU_OERSTED_OK;
        result->face_current_revision = provenance.face_current_revision;
        result->certificate_revision = provenance.certificate_revision;
        result->trusted_snapshot_revision = provenance.trusted_snapshot_revision;
        result->envelope_revision = provenance.envelope_revision;
        result->stage_identity = provenance.stage_identity;
        result->evaluation_time_s = provenance.evaluation_time_s;
        result->evaluated_envelope_multiplier =
            provenance.evaluated_envelope_multiplier;
        result->plan_build_count = cache.plan_build_count;
        result->kernel_build_count = cache.kernel_build_count;
        result->numerical_buffer_allocation_count =
            cache.numerical_buffer_allocation_count;
        result->resolved_field_hit_count = cache.resolved_field_hit_count;
        result->resolved_field_miss_count = cache.resolved_field_miss_count;
        result->resolved_field_invalidation_count =
            cache.resolved_field_invalidation_count;
        result->trusted_fast_path_hit_count = cache.trusted_fast_path_hit_count;
        result->resolved_field_reused = cache.resolved_field_reused ? 1U : 0U;
        result->diagnostics_available = diagnostics.available ? 1U : 0U;
        result->divergence_current_rms_a_per_m3 =
            diagnostics.divergence_current_rms_a_per_m3;
        result->divergence_field_rms_a_per_m2 =
            diagnostics.divergence_field_rms_a_per_m2;
        result->curl_h_minus_j_rms_a_per_m2 =
            diagnostics.curl_h_minus_j_rms_a_per_m2;
        copy_text(result->api_version, provenance.api_version);
        copy_text(result->formula_version, provenance.formula_version);
        copy_text(result->reconstruction_version,
                  provenance.reconstruction_version);
        copy_text(result->operator_version, provenance.operator_version);
        copy_text(result->realization_version, provenance.realization_version);
        copy_text(result->engine_version, provenance.engine_version);
        copy_text(result->certificate_version, provenance.certificate_version);
        copy_text(result->face_current_digest, provenance.face_current_digest);
        copy_text(result->certificate_digest, provenance.certificate_digest);
        copy_text(result->trusted_snapshot_digest,
                  provenance.trusted_snapshot_digest);
        copy_text(result->resolved_field_cache_key_digest,
                  cache.resolved_field_cache_key_digest);
        copy_text(result->kernel_plan_cache_key_digest,
                  cache.kernel_plan_cache_key_digest);
        copy_text(result->source_identity, provenance.source_identity);
        copy_text(result->error_message, "");
        return FULLMAG_FDM_CPU_OERSTED_OK;
    } catch (const std::invalid_argument &error) {
        return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_INVALID, error.what());
    } catch (const std::bad_alloc &) {
        return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_INTERNAL,
                    "native Oersted allocation failed");
    } catch (const std::exception &error) {
        return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_INTERNAL, error.what());
    } catch (...) {
        return fail(result, FULLMAG_FDM_CPU_OERSTED_ERR_INTERNAL,
                    "unknown native Oersted failure");
    }
}
