#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "context.hpp"
#include "core/fem_mesh.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "frequency_domain/canonical_digest.hpp"
#include "frequency_domain/linearization_state.hpp"
#include "frequency_domain/mesh_symmetry_certificate.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <stdexcept>
#include <utility>
#include <vector>

namespace fullmag::fem::frequency_domain {
namespace {

constexpr std::uint32_t kInactiveMagneticClass = std::numeric_limits<std::uint32_t>::max();

struct SparseAccumulator {
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
    std::vector<std::map<std::uint32_t, double>> rows{};

    SparseAccumulator(std::uint64_t rows_in, std::uint64_t columns_in)
        : row_count(rows_in)
        , column_count(columns_in)
        , rows(static_cast<std::size_t>(rows_in))
    {
    }

    void add(std::uint64_t row, std::uint64_t column, double value)
    {
        if (value == 0.0) {
            return;
        }
        rows[static_cast<std::size_t>(row)][static_cast<std::uint32_t>(column)] += value;
    }

    void finish(PoissonAirboxSharedDomainCsrMatrix &out) const
    {
        out = PoissonAirboxSharedDomainCsrMatrix{};
        out.row_count = row_count;
        out.column_count = column_count;
        out.row_offsets.reserve(rows.size() + 1u);
        out.row_offsets.push_back(0u);
        for (const auto &row : rows) {
            for (const auto &[column, value] : row) {
                if (value == 0.0) {
                    continue;
                }
                if (!std::isfinite(value)) {
                    throw std::invalid_argument(
                        "shared-domain CSR assembly produced a non-finite value");
                }
                out.column_indices.push_back(column);
                out.values.push_back(value);
            }
            if (out.values.size() > std::numeric_limits<std::uint32_t>::max()) {
                throw std::overflow_error("shared-domain CSR nnz exceeds uint32 range");
            }
            out.row_offsets.push_back(static_cast<std::uint32_t>(out.values.size()));
        }
    }
};

void copy_error(char out[256], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message != nullptr ? message : "", 255);
    out[255] = '\0';
}

bool finite_positive(double value) noexcept
{
    return std::isfinite(value) && value > 0.0;
}

bool validate_tangent_frame_buffer(
    const TangentFrameNode *frames,
    std::uint64_t node_count,
    char error_message[256]) noexcept
{
    if (frames == nullptr) {
        copy_error(error_message, "linearization_descriptor_frame_source_invalid");
        return false;
    }
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const TangentFrameNode &frame = frames[static_cast<std::size_t>(node)];
        const double m_norm = std::sqrt(dot3(frame.m, frame.m));
        const double e1_norm = std::sqrt(dot3(frame.e1, frame.e1));
        const double e2_norm = std::sqrt(dot3(frame.e2, frame.e2));
        const double cross_e1_e2[3] = {
            frame.e1[1] * frame.e2[2] - frame.e1[2] * frame.e2[1],
            frame.e1[2] * frame.e2[0] - frame.e1[0] * frame.e2[2],
            frame.e1[0] * frame.e2[1] - frame.e1[1] * frame.e2[0],
        };
        if (!finite_positive(m_norm) || !finite_positive(e1_norm) ||
            !finite_positive(e2_norm) || std::abs(m_norm - 1.0) > 1.0e-8 ||
            std::abs(e1_norm - 1.0) > 1.0e-8 ||
            std::abs(e2_norm - 1.0) > 1.0e-8 ||
            std::abs(dot3(frame.m, frame.e1)) > 1.0e-8 ||
            std::abs(dot3(frame.m, frame.e2)) > 1.0e-8 ||
            std::abs(dot3(frame.e1, frame.e2)) > 1.0e-8 ||
            std::abs(cross_e1_e2[0] - frame.m[0]) > 1.0e-8 ||
            std::abs(cross_e1_e2[1] - frame.m[1]) > 1.0e-8 ||
            std::abs(cross_e1_e2[2] - frame.m[2]) > 1.0e-8) {
            copy_error(error_message, "linearization_descriptor_frame_source_invalid");
            return false;
        }
    }
    return true;
}

FrequencyDomainStatus validate_linearization_descriptor_common(
    const FullmagFemModalLinearizationDescriptor &descriptor,
    std::uint64_t expected_node_count,
    char error_message[256]) noexcept
{
    const std::uint32_t known_terms =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE |
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD |
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY |
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI |
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG;
    const auto nonempty = [](const char *value) {
        return value != nullptr && value[0] != '\0';
    };
    const auto sha256 = [](const char *value) {
        if (value == nullptr || std::strlen(value) != 71u ||
            std::strncmp(value, "sha256:", 7u) != 0) {
            return false;
        }
        for (std::size_t index = 7u; index < 71u; ++index) {
            if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
                return false;
            }
        }
        return true;
    };
    const auto finite_span = [](const double *values, std::uint64_t count) {
        if (count > 0u && values == nullptr) {
            return false;
        }
        for (std::uint64_t index = 0u; index < count; ++index) {
            if (!std::isfinite(values[index])) {
                return false;
            }
        }
        return true;
    };
    const auto optional_span = [&](const void *values, std::uint64_t count) {
        return (values == nullptr && count == 0u) ||
            (values != nullptr && count > 0u);
    };
    const auto term_digest_valid = [&](std::uint32_t term, const char *digest) {
        if ((descriptor.term_presence_mask & term) != 0u) {
            return sha256(digest);
        }
        return digest == nullptr || digest[0] == '\0';
    };
    if (descriptor.abi_version != FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION ||
        descriptor.reserved0 != 0u ||
        descriptor.struct_size < sizeof(FullmagFemModalLinearizationDescriptor) ||
        descriptor.schema_version == nullptr ||
        std::strcmp(descriptor.schema_version,
                    FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA) != 0 ||
        descriptor.node_count != expected_node_count ||
        descriptor.tangent_dof_count != 2u * expected_node_count ||
        descriptor.reserved_contract_flags != 0u ||
        (descriptor.term_presence_mask & ~known_terms) != 0u ||
        !descriptor.coordinate_unit || std::strcmp(descriptor.coordinate_unit, "m") != 0 ||
        !descriptor.magnetisation_unit || std::strcmp(descriptor.magnetisation_unit, "A/m") != 0 ||
        !descriptor.time_unit || std::strcmp(descriptor.time_unit, "s") != 0 ||
        !descriptor.frequency_unit || std::strcmp(descriptor.frequency_unit, "Hz") != 0 ||
        !descriptor.angular_frequency_unit ||
            std::strcmp(descriptor.angular_frequency_unit, "rad/s") != 0 ||
        !nonempty(descriptor.linearization_state_digest) ||
        !sha256(descriptor.linearization_state_digest) ||
        !nonempty(descriptor.equilibrium_digest) || !sha256(descriptor.equilibrium_digest) ||
        !nonempty(descriptor.operator_input_digest) || !sha256(descriptor.operator_input_digest) ||
        descriptor.tangent_frame_xyz == nullptr ||
        descriptor.tangent_frame_xyz_count != 6u * expected_node_count ||
        descriptor.equilibrium_m0_xyz == nullptr ||
        descriptor.equilibrium_m0_xyz_count != 3u * expected_node_count ||
        descriptor.effective_field_h_eff0_xyz == nullptr ||
        descriptor.effective_field_h_eff0_xyz_count != 3u * expected_node_count ||
        !finite_span(descriptor.tangent_frame_xyz, descriptor.tangent_frame_xyz_count) ||
        !finite_span(descriptor.equilibrium_m0_xyz, descriptor.equilibrium_m0_xyz_count) ||
        !finite_span(descriptor.effective_field_h_eff0_xyz,
                     descriptor.effective_field_h_eff0_xyz_count) ||
        !finite_span(descriptor.external_field_h_ext0_xyz,
                     descriptor.external_field_h_ext0_xyz_count) ||
        (descriptor.external_field_h_ext0_xyz != nullptr &&
         descriptor.external_field_h_ext0_xyz_count != 3u * expected_node_count) ||
        (descriptor.alpha_per_node != nullptr &&
         descriptor.alpha_per_node_count != expected_node_count) ||
        !finite_span(descriptor.alpha_per_node, descriptor.alpha_per_node_count) ||
        !optional_span(descriptor.external_field_h_ext0_xyz,
                       descriptor.external_field_h_ext0_xyz_count) ||
        !optional_span(descriptor.alpha_per_node, descriptor.alpha_per_node_count) ||
        !term_digest_valid(FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE,
                           descriptor.exchange_term_digest) ||
        !term_digest_valid(FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD,
                           descriptor.field_term_digest) ||
        !term_digest_valid(FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY,
                           descriptor.anisotropy_term_digest) ||
        !term_digest_valid(FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI,
                           descriptor.dmi_term_digest) ||
        !term_digest_valid(FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG,
                           descriptor.demag_term_digest)) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_anisotropy =
        (descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY) != 0u;
    if (has_anisotropy) {
        if (descriptor.uniaxial_axis_xyz == nullptr ||
            descriptor.uniaxial_axis_xyz_count != 3u * expected_node_count ||
            descriptor.uniaxial_anisotropy_field_a_per_m == nullptr ||
            (descriptor.uniaxial_anisotropy_field_count != 1u &&
             descriptor.uniaxial_anisotropy_field_count != expected_node_count) ||
            !finite_span(descriptor.uniaxial_axis_xyz, descriptor.uniaxial_axis_xyz_count) ||
            !finite_span(descriptor.uniaxial_anisotropy_field_a_per_m,
                         descriptor.uniaxial_anisotropy_field_count)) {
            copy_error(error_message, "linearization_descriptor_contract_invalid");
            return FrequencyDomainStatus::validation_error;
        }
    } else if (descriptor.uniaxial_axis_xyz != nullptr ||
               descriptor.uniaxial_axis_xyz_count != 0u ||
               descriptor.uniaxial_anisotropy_field_a_per_m != nullptr ||
               descriptor.uniaxial_anisotropy_field_count != 0u) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_dmi =
        (descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI) != 0u;
    if (has_dmi) {
        const bool dmi_ms_valid = optional_span(
            descriptor.dmi_ms_field, descriptor.dmi_ms_field_count) &&
            (descriptor.dmi_ms_field_count == 0u ||
             descriptor.dmi_ms_field_count == expected_node_count) &&
            finite_span(descriptor.dmi_ms_field, descriptor.dmi_ms_field_count);
        if (descriptor.dmi_elements == nullptr || descriptor.dmi_element_count == 0u ||
            descriptor.dmi_lumped_mass == nullptr || descriptor.dmi_lumped_mass_count == 0u ||
            !dmi_ms_valid || !std::isfinite(descriptor.dmi_uniform_ms) ||
            (descriptor.dmi_ms_field_count == 0u && descriptor.dmi_uniform_ms <= 0.0) ||
            !finite_span(descriptor.dmi_lumped_mass, descriptor.dmi_lumped_mass_count)) {
            copy_error(error_message, "linearization_descriptor_contract_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        for (std::uint64_t index = 0u; index < descriptor.dmi_element_count; ++index) {
            const auto &element = descriptor.dmi_elements[index];
            if (!std::isfinite(element.weight) || !std::isfinite(element.d) ||
                !finite_span(element.shape, 4u) || !finite_span(element.grad_shape, 12u) ||
                !finite_span(element.normal, 3u)) {
                copy_error(error_message, "linearization_descriptor_contract_invalid");
                return FrequencyDomainStatus::validation_error;
            }
            for (std::uint32_t local = 0u; local < 4u; ++local) {
                if (element.node_indices[local] >= expected_node_count) {
                    copy_error(error_message, "linearization_descriptor_contract_invalid");
                    return FrequencyDomainStatus::validation_error;
                }
            }
        }
    } else if (descriptor.dmi_elements != nullptr || descriptor.dmi_element_count != 0u ||
               descriptor.dmi_lumped_mass != nullptr || descriptor.dmi_lumped_mass_count != 0u ||
               descriptor.dmi_ms_field != nullptr || descriptor.dmi_ms_field_count != 0u) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_exchange =
        (descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u;
    if (!has_exchange &&
        (descriptor.exchange_edges != nullptr || descriptor.exchange_edge_count != 0u)) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_demag =
        (descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG) != 0u;
    if (has_demag && (descriptor.demag_provider_signature == nullptr ||
                     descriptor.demag_provider_signature[0] == '\0')) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    if (!has_demag && (descriptor.demag_provider_signature != nullptr &&
                      descriptor.demag_provider_signature[0] != '\0')) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    if (descriptor.saturation_magnetisation_a_per_m != nullptr) {
        if (descriptor.saturation_magnetisation_count != expected_node_count ||
            !finite_span(descriptor.saturation_magnetisation_a_per_m,
                         descriptor.saturation_magnetisation_count)) {
            copy_error(error_message, "linearization_descriptor_contract_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        for (std::uint64_t node = 0u; node < expected_node_count; ++node) {
            if (!finite_positive(descriptor.saturation_magnetisation_a_per_m[node])) {
                copy_error(error_message, "linearization_descriptor_contract_invalid");
                return FrequencyDomainStatus::validation_error;
            }
        }
    } else if (!finite_positive(descriptor.uniform_saturation_magnetisation_a_per_m)) {
        copy_error(error_message, "linearization_descriptor_contract_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus materialize_descriptor_tangent_frames(
    const FullmagFemModalLinearizationDescriptor &descriptor,
    std::uint64_t expected_node_count,
    std::vector<TangentFrameNode> &out_frames,
    char error_message[256]) noexcept
{
    if (descriptor.abi_version !=
            FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION ||
        descriptor.struct_size < sizeof(FullmagFemModalLinearizationDescriptor) ||
        descriptor.node_count != expected_node_count ||
        descriptor.tangent_dof_count != 2u * expected_node_count ||
        descriptor.tangent_frame_xyz == nullptr ||
        descriptor.tangent_frame_xyz_count != 6u * expected_node_count ||
        descriptor.equilibrium_m0_xyz == nullptr ||
        descriptor.equilibrium_m0_xyz_count != 3u * expected_node_count) {
        copy_error(error_message,
                   "linearization_descriptor_frame_dimensions_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    out_frames.assign(static_cast<std::size_t>(expected_node_count), TangentFrameNode{});
    for (std::uint64_t node = 0; node < expected_node_count; ++node) {
        TangentFrameNode &frame = out_frames[static_cast<std::size_t>(node)];
        for (int axis = 0; axis < 3; ++axis) {
            frame.m[axis] = descriptor.equilibrium_m0_xyz[3u * node + axis];
            frame.e1[axis] = descriptor.tangent_frame_xyz[6u * node + axis];
            frame.e2[axis] = descriptor.tangent_frame_xyz[6u * node + 3u + axis];
        }
    }
    if (!validate_tangent_frame_buffer(
            out_frames.data(), expected_node_count, error_message)) {
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

bool csr_is_valid(const CsrMatrixView &matrix, std::uint64_t expected_dimension) noexcept
{
    if (matrix.row_count != expected_dimension ||
        matrix.column_count != expected_dimension ||
        matrix.row_offsets == nullptr ||
        matrix.row_offsets_len != expected_dimension + 1u ||
        matrix.column_indices_len != matrix.values_len ||
        (matrix.values_len > 0 &&
         (matrix.column_indices == nullptr || matrix.values == nullptr)) ||
        matrix.row_offsets[0] != 0u ||
        matrix.row_offsets[expected_dimension] != matrix.values_len) {
        return false;
    }
    for (std::uint64_t row = 0; row < expected_dimension; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (matrix.column_indices[entry] >= expected_dimension ||
            !std::isfinite(matrix.values[entry])) {
            return false;
        }
    }
    return true;
}

bool validate_classes(
    const std::uint32_t *classes,
    std::uint64_t node_count,
    std::uint64_t class_count,
    bool allow_inactive,
    const char *name,
    std::string &error)
{
    if (classes == nullptr || class_count == 0 || class_count > node_count) {
        error = std::string(name) + " equivalence classes are missing";
        return false;
    }
    std::vector<bool> seen(static_cast<std::size_t>(class_count), false);
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const std::uint32_t value = classes[node];
        if (value == kInactiveMagneticClass && allow_inactive) {
            continue;
        }
        if (value >= class_count) {
            error = std::string(name) + " equivalence class index is out of range";
            return false;
        }
        seen[static_cast<std::size_t>(value)] = true;
    }
    if (std::find(seen.begin(), seen.end(), false) != seen.end()) {
        error = std::string(name) + " equivalence classes are not complete";
        return false;
    }
    return true;
}

double node_ms(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    std::uint64_t node) noexcept
{
    return request.saturation_magnetization_a_per_m != nullptr
        ? request.saturation_magnetization_a_per_m[node]
        : request.uniform_saturation_magnetization_a_per_m;
}

bool validate_materials(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    std::uint64_t node_count,
    std::string &error)
{
    if (request.saturation_magnetization_a_per_m != nullptr &&
        request.saturation_magnetization_count != node_count) {
        error = "shared-domain saturation magnetization count does not match the scalar mesh";
        return false;
    }
    if (request.saturation_magnetization_a_per_m == nullptr &&
        !finite_positive(request.uniform_saturation_magnetization_a_per_m)) {
        error = "shared-domain saturation magnetization must be finite and positive";
        return false;
    }
    for (std::uint64_t node = 0; node < node_count; ++node) {
        if (!finite_positive(node_ms(request, node))) {
            error = "shared-domain saturation magnetization contains a non-positive value";
            return false;
        }
    }
    return true;
}

void add_mfem_matrix(
    const mfem::SparseMatrix &matrix,
    const std::uint32_t *row_classes,
    std::uint64_t row_class_count,
    const std::uint32_t *column_classes,
    std::uint64_t column_class_count,
    std::uint32_t row_stride,
    std::uint32_t column_stride,
    SparseAccumulator &out)
{
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < matrix.Height(); ++row) {
        const std::uint64_t row_node = static_cast<std::uint64_t>(row) / row_stride;
        const std::uint32_t row_component = static_cast<std::uint32_t>(row) % row_stride;
        const std::uint32_t reduced_row_node = row_classes[row_node];
        if (reduced_row_node == kInactiveMagneticClass) {
            continue;
        }
        matrix.GetRow(row, columns, values);
        for (int entry = 0; entry < columns.Size(); ++entry) {
            const std::uint64_t column = static_cast<std::uint64_t>(columns[entry]);
            const std::uint64_t column_node = column / column_stride;
            const std::uint32_t column_component =
                static_cast<std::uint32_t>(column % column_stride);
            const std::uint32_t reduced_column_node = column_classes[column_node];
            if (reduced_column_node == kInactiveMagneticClass) {
                continue;
            }
            const std::uint64_t reduced_row =
                static_cast<std::uint64_t>(reduced_row_node) * row_stride + row_component;
            const std::uint64_t reduced_column =
                static_cast<std::uint64_t>(reduced_column_node) * column_stride + column_component;
            out.add(reduced_row, reduced_column, values[entry]);
        }
    }
}

void add_csr_matrix(
    const CsrMatrixView &matrix,
    const std::uint32_t *row_classes,
    const std::uint32_t *column_classes,
    std::uint32_t row_stride,
    std::uint32_t column_stride,
    SparseAccumulator &out)
{
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        const std::uint64_t row_node = row / row_stride;
        const std::uint32_t row_component = static_cast<std::uint32_t>(row % row_stride);
        const std::uint32_t reduced_row_node = row_classes[row_node];
        if (reduced_row_node == kInactiveMagneticClass) {
            continue;
        }
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1u];
             ++entry) {
            const std::uint64_t column = matrix.column_indices[entry];
            const std::uint64_t column_node = column / column_stride;
            const std::uint32_t column_component =
                static_cast<std::uint32_t>(column % column_stride);
            const std::uint32_t reduced_column_node = column_classes[column_node];
            if (reduced_column_node == kInactiveMagneticClass) {
                continue;
            }
            out.add(
                static_cast<std::uint64_t>(reduced_row_node) * row_stride + row_component,
                static_cast<std::uint64_t>(reduced_column_node) * column_stride + column_component,
                matrix.values[entry]);
        }
    }
}

void add_csr_rectangular(
    const SparseAccumulator &source,
    const std::uint32_t *row_classes,
    const std::uint32_t *column_classes,
    std::uint32_t row_stride,
    std::uint32_t column_stride,
    SparseAccumulator &out)
{
    for (std::uint64_t row = 0; row < source.row_count; ++row) {
        const std::uint64_t row_node = row / row_stride;
        const std::uint32_t row_component = static_cast<std::uint32_t>(row % row_stride);
        const std::uint32_t reduced_row_node = row_classes[row_node];
        if (reduced_row_node == kInactiveMagneticClass) {
            continue;
        }
        for (const auto &[column_u32, value] : source.rows[static_cast<std::size_t>(row)]) {
            const std::uint64_t column = column_u32;
            const std::uint64_t column_node = column / column_stride;
            const std::uint32_t column_component =
                static_cast<std::uint32_t>(column % column_stride);
            const std::uint32_t reduced_column_node = column_classes[column_node];
            if (reduced_column_node == kInactiveMagneticClass) {
                continue;
            }
            out.add(
                static_cast<std::uint64_t>(reduced_row_node) * row_stride + row_component,
                static_cast<std::uint64_t>(reduced_column_node) * column_stride + column_component,
                value);
        }
    }
}

void eliminate_rows_and_columns(
    PoissonAirboxSharedDomainCsrMatrix &matrix,
    const std::set<std::uint32_t> &rows_to_eliminate,
    const std::set<std::uint32_t> &columns_to_eliminate)
{
    std::vector<std::uint32_t> row_offsets;
    std::vector<std::uint32_t> column_indices;
    std::vector<double> values;
    row_offsets.reserve(matrix.row_offsets.size());
    row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        if (rows_to_eliminate.find(static_cast<std::uint32_t>(row)) ==
            rows_to_eliminate.end()) {
            const std::uint32_t begin = matrix.row_offsets[static_cast<std::size_t>(row)];
            const std::uint32_t end = matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
            for (std::uint32_t entry = begin; entry < end; ++entry) {
                if (columns_to_eliminate.find(matrix.column_indices[entry]) !=
                    columns_to_eliminate.end()) {
                    continue;
                }
                column_indices.push_back(matrix.column_indices[entry]);
                values.push_back(matrix.values[entry]);
            }
        }
        if (values.size() > std::numeric_limits<std::uint32_t>::max()) {
            throw std::overflow_error("shared-domain constrained CSR nnz exceeds uint32 range");
        }
        row_offsets.push_back(static_cast<std::uint32_t>(values.size()));
    }
    matrix.row_offsets = std::move(row_offsets);
    matrix.column_indices = std::move(column_indices);
    matrix.values = std::move(values);
}

void add_digest_matrix(
    CanonicalDigestBuilder &digest,
    const char *name,
    const PoissonAirboxSharedDomainCsrMatrix &matrix)
{
    digest.add_u64(std::string(name) + ".rows", matrix.row_count);
    digest.add_u64(std::string(name) + ".columns", matrix.column_count);
    for (std::size_t index = 0; index < matrix.values.size(); ++index) {
        digest.add_u64(
            std::string(name) + ".column[" + std::to_string(index) + "]",
            matrix.column_indices[index]);
        digest.add_double(
            std::string(name) + ".value[" + std::to_string(index) + "]",
            matrix.values[index]);
    }
}

template <typename T>
bool copy_payload_span(
    const T *source,
    std::uint64_t count,
    std::vector<T> &destination,
    std::string &error,
    const char *name)
{
    if (count > 0u && source == nullptr) {
        error = std::string("shared-domain payload ") + name + " is null";
        return false;
    }
    if (count > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        error = std::string("shared-domain payload ") + name + " exceeds host size_t";
        return false;
    }
    if (count == 0u) {
        destination.clear();
        return true;
    }
    destination.assign(source, source + static_cast<std::size_t>(count));
    return true;
}

struct OwnedNativeV6View {
    std::vector<std::uint32_t> region_ids{};
    std::vector<std::uint32_t> boundary_axis_masks{};
    std::vector<MeshSymmetryCertificateRegionRole> region_roles{};
    std::vector<MeshSymmetryCertificateV6Relation> generator_relations{};
    std::vector<MeshSymmetryCertificateV6Relation> closure_relations{};
    std::vector<std::uint64_t> expected_class_ids{};
    std::vector<std::string> expected_class_digest_strings{};
    std::vector<MeshSymmetryCertificateV6ClassDigest> expected_class_digests{};
    MeshSymmetryCertificateV6View view{};
};

bool copy_native_v6_view(
    const FullmagFemModalCertificateV6View &source,
    const char *schema_version,
    OwnedNativeV6View &owned,
    std::string &error)
{
    constexpr std::uint64_t kMaximumViewEntries = 64ull * 1024ull * 1024ull;
    const auto valid_count = [&](std::uint64_t count, const void *pointer) {
        return count <= kMaximumViewEntries && (count == 0u || pointer != nullptr);
    };
    if (source.node_count == 0u || source.node_count > kMaximumViewEntries ||
        source.region_ids == nullptr || source.boundary_axis_masks == nullptr ||
        !valid_count(source.region_role_count, source.region_roles) ||
        !valid_count(source.generator_relation_count, source.generator_relations) ||
        !valid_count(source.closure_relation_count, source.closure_relations) ||
        !valid_count(source.expected_class_id_count, source.expected_class_ids) ||
        !valid_count(source.expected_class_digest_count, source.expected_class_digests)) {
        error = "periodic_mesh_certificate_v6_c_abi_view_missing";
        return false;
    }
    owned.region_ids.assign(source.region_ids,
                            source.region_ids + static_cast<std::ptrdiff_t>(source.node_count));
    owned.boundary_axis_masks.assign(
        source.boundary_axis_masks,
        source.boundary_axis_masks + static_cast<std::ptrdiff_t>(source.node_count));
    owned.region_roles.reserve(static_cast<std::size_t>(source.region_role_count));
    for (std::uint64_t index = 0u; index < source.region_role_count; ++index) {
        owned.region_roles.push_back({
            source.region_roles[index].region_id,
            static_cast<MeshSymmetryCertificatePartRole>(source.region_roles[index].part_role)});
    }
    owned.generator_relations.reserve(static_cast<std::size_t>(source.generator_relation_count));
    for (std::uint64_t index = 0u; index < source.generator_relation_count; ++index) {
        const auto &relation = source.generator_relations[index];
        owned.generator_relations.push_back({
            relation.source_node,
            relation.destination_node,
            relation.axis_mask,
            static_cast<MeshSymmetryCertificateRelationKind>(relation.kind)});
    }
    owned.closure_relations.reserve(static_cast<std::size_t>(source.closure_relation_count));
    for (std::uint64_t index = 0u; index < source.closure_relation_count; ++index) {
        const auto &relation = source.closure_relations[index];
        owned.closure_relations.push_back({
            relation.source_node,
            relation.destination_node,
            relation.axis_mask,
            static_cast<MeshSymmetryCertificateRelationKind>(relation.kind)});
    }
    if (source.expected_class_id_count > 0u) {
        owned.expected_class_ids.assign(
            source.expected_class_ids,
            source.expected_class_ids +
                static_cast<std::ptrdiff_t>(source.expected_class_id_count));
    }
    owned.expected_class_digest_strings.reserve(
        static_cast<std::size_t>(source.expected_class_digest_count));
    for (std::uint64_t index = 0u; index < source.expected_class_digest_count; ++index) {
        if (source.expected_class_digests[index].sha256 == nullptr) {
            error = "periodic_mesh_certificate_v6_c_abi_class_digest_missing";
            return false;
        }
        owned.expected_class_digest_strings.emplace_back(source.expected_class_digests[index].sha256);
    }
    owned.expected_class_digests.reserve(owned.expected_class_digest_strings.size());
    for (std::size_t index = 0u; index < owned.expected_class_digest_strings.size(); ++index) {
        owned.expected_class_digests.push_back({
            source.expected_class_digests[index].canonical_class_id,
            source.expected_class_digests[index].member_count,
            owned.expected_class_digest_strings[index].c_str()});
    }
    owned.view.schema_version = schema_version;
    owned.view.view_kind = static_cast<MeshSymmetryCertificateV6ViewKind>(source.view_kind);
    owned.view.part_role = static_cast<MeshSymmetryCertificatePartRole>(source.part_role);
    owned.view.part_identity = source.part_identity;
    owned.view.topology_fingerprint = source.topology_fingerprint;
    owned.view.node_count = source.node_count;
    owned.view.region_ids = owned.region_ids.data();
    owned.view.boundary_axis_masks = owned.boundary_axis_masks.data();
    owned.view.region_roles = owned.region_roles.data();
    owned.view.region_role_count = owned.region_roles.size();
    owned.view.generator_relations = owned.generator_relations.data();
    owned.view.generator_relation_count = owned.generator_relations.size();
    owned.view.closure_relations = owned.closure_relations.data();
    owned.view.closure_relation_count = owned.closure_relations.size();
    owned.view.require_complete_closure = source.require_complete_closure != 0u;
    owned.view.expected_class_ids = owned.expected_class_ids.data();
    owned.view.expected_class_id_count = owned.expected_class_ids.size();
    owned.view.expected_class_digests = owned.expected_class_digests.data();
    owned.view.expected_class_digest_count = owned.expected_class_digests.size();
    return true;
}

bool valid_sha256_binding_digest(const char *value) noexcept
{
    if (value == nullptr || std::strlen(value) != 71u ||
        std::strncmp(value, "sha256:", 7u) != 0) {
        return false;
    }
    for (std::size_t index = 7u; index < 71u; ++index) {
        if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
            return false;
        }
    }
    return true;
}

bool validate_marker_certificate_binding(
    const FullmagFemModalSharedDomainPayload &payload,
    const OwnedNativeV6View &magnetic_view,
    const OwnedNativeV6View &scalar_view,
    std::uint64_t node_count,
    std::uint64_t &out_magnetic_node_count,
    std::string &error)
{
    out_magnetic_node_count = 0u;
    if (payload.mesh == nullptr || payload.mesh->cell_types == nullptr ||
        payload.mesh->cell_markers == nullptr ||
        payload.mesh->cell_markers_len != payload.mesh->cell_types_len ||
        payload.mesh->cell_types_len == 0u ||
        payload.mesh->cell_offsets == nullptr ||
        payload.mesh->cell_offsets_len != payload.mesh->cell_types_len + 1u ||
        payload.mesh->cell_nodes == nullptr ||
        payload.mesh->cell_offsets[0] != 0u ||
        payload.mesh->cell_offsets[payload.mesh->cell_types_len] != payload.mesh->cell_nodes_len) {
        error = "shared-domain payload has no authoritative magnetic/airbox cell marker map";
        return false;
    }
    std::vector<std::uint8_t> magnetic_node_mask(static_cast<std::size_t>(node_count), 0u);
    bool has_magnetic = false;
    bool has_airbox = false;
    for (std::uint64_t element = 0u; element < payload.mesh->cell_types_len; ++element) {
        const std::uint32_t marker = payload.mesh->cell_markers[element];
        if (marker > 1u) {
            error = "shared-domain payload uses an unknown magnetic/airbox cell marker";
            return false;
        }
        has_magnetic = has_magnetic || marker == 1u;
        has_airbox = has_airbox || marker == 0u;
        const std::uint32_t begin = payload.mesh->cell_offsets[element];
        const std::uint32_t end = payload.mesh->cell_offsets[element + 1u];
        if (begin > end || end > payload.mesh->cell_nodes_len) {
            error = "shared-domain payload has invalid cell marker topology";
            return false;
        }
        if (marker == 1u) {
            for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                const std::uint32_t node = payload.mesh->cell_nodes[cursor];
                if (node >= node_count) {
                    error = "shared-domain payload has an out-of-range magnetic cell node";
                    return false;
                }
                magnetic_node_mask[node] = 1u;
            }
        }
    }
    if (!has_magnetic || !has_airbox) {
        error = "shared-domain payload requires both magnetic and airbox cell regions";
        return false;
    }
    const std::uint64_t magnetic_node_count = static_cast<std::uint64_t>(std::count(
        magnetic_node_mask.begin(), magnetic_node_mask.end(), static_cast<std::uint8_t>(1u)));
    /* The v6 C handoff has no separate node-index map.  The only safe
       interpretation is the canonical compact ordering: magnetic nodes are
       the leading node range and scalar nodes cover the full mesh. */
    if (magnetic_view.view.node_count != magnetic_node_count ||
        scalar_view.view.node_count != node_count) {
        error = "shared-domain certificate view cardinalities do not match the marker map";
        return false;
    }
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        const bool expected_magnetic = node < magnetic_node_count;
        if ((magnetic_node_mask[static_cast<std::size_t>(node)] != 0u) != expected_magnetic) {
            error = "shared-domain certificate magnetic node ordering is not bound to the marker map";
            return false;
        }
    }
    std::set<std::uint32_t> magnetic_regions;
    for (std::uint64_t index = 0u; index < magnetic_view.view.region_role_count; ++index) {
        if (magnetic_view.view.region_roles[index].part_role !=
            MeshSymmetryCertificatePartRole::magnetic) {
            error = "shared-domain magnetic certificate region role is invalid";
            return false;
        }
        magnetic_regions.insert(magnetic_view.view.region_roles[index].region_id);
    }
    std::set<std::uint32_t> scalar_regions;
    for (std::uint64_t index = 0u; index < scalar_view.view.region_role_count; ++index) {
        if (scalar_view.view.region_roles[index].part_role !=
            MeshSymmetryCertificatePartRole::scalar_airbox) {
            error = "shared-domain scalar certificate region role is invalid";
            return false;
        }
        scalar_regions.insert(scalar_view.view.region_roles[index].region_id);
    }
    for (std::uint64_t node = 0u; node < magnetic_node_count; ++node) {
        if (magnetic_regions.find(magnetic_view.view.region_ids[node]) == magnetic_regions.end()) {
            error = "shared-domain magnetic marker map is not bound to certificate regions";
            return false;
        }
    }
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        if (scalar_regions.find(scalar_view.view.region_ids[node]) == scalar_regions.end()) {
            error = "shared-domain scalar marker map is not bound to certificate regions";
            return false;
        }
    }
    if (magnetic_view.view.part_identity == nullptr ||
        std::strncmp(magnetic_view.view.part_identity, "magnetic:", 9u) != 0 ||
        scalar_view.view.part_identity == nullptr ||
        std::strncmp(scalar_view.view.part_identity, "airbox:", 7u) != 0) {
        error = "shared-domain certificate part identities do not bind magnetic and airbox regions";
        return false;
    }
    out_magnetic_node_count = magnetic_node_count;
    return true;
}

bool validate_canonical_reduction_map(
    const std::vector<std::uint64_t> &canonical_class_ids,
    const std::uint32_t *reduced_node,
    std::uint64_t reduced_class_count,
    std::uint64_t global_node_count,
    bool magnetic_prefix,
    const char *name,
    std::string &error)
{
    if (reduced_node == nullptr || canonical_class_ids.empty() ||
        canonical_class_ids.size() > global_node_count) {
        error = std::string(name) + "_reduced_node_missing";
        return false;
    }
    std::set<std::uint64_t> ordered_class_ids(
        canonical_class_ids.begin(), canonical_class_ids.end());
    if (ordered_class_ids.size() != reduced_class_count) {
        error = std::string(name) + "_reduced_node_class_count_mismatch";
        return false;
    }
    std::map<std::uint64_t, std::uint32_t> canonical_to_reduced;
    std::uint32_t reduced_index = 0u;
    for (const std::uint64_t canonical_id : ordered_class_ids) {
        canonical_to_reduced.emplace(canonical_id, reduced_index++);
    }
    for (std::size_t node = 0u; node < canonical_class_ids.size(); ++node) {
        const auto expected = canonical_to_reduced.find(canonical_class_ids[node]);
        if (expected == canonical_to_reduced.end() || reduced_node[node] != expected->second) {
            error = std::string(name) + "_reduced_node_not_canonical";
            return false;
        }
    }
    if (!magnetic_prefix && canonical_class_ids.size() != global_node_count) {
        error = "scalar_reduced_node_not_canonical";
        return false;
    }
    if (magnetic_prefix) {
        for (std::uint64_t node = canonical_class_ids.size(); node < global_node_count; ++node) {
            if (reduced_node[node] != kInactiveMagneticClass) {
                error = "magnetic_reduced_node_not_canonical";
                return false;
            }
        }
    }
    return true;
}

} // namespace

bool import_modal_shared_domain_mesh(
    const fullmag_fem_mesh_desc &mesh,
    fullmag::fem::FemMeshRuntimeState &out_mesh,
    std::string &error)
{
    fullmag::fem::Context context;
    if (!fullmag::fem::initialize_mesh_plan_fields(context, mesh, error)) {
        return false;
    }
    out_mesh = std::move(context.mesh);
    return true;
}

FrequencyDomainStatus compute_modal_shared_domain_map_binding_digest(
    const FullmagFemModalSharedDomainPayload &payload,
    const MeshSymmetryCertificateV6Binding &accepted_v6_binding,
    std::uint64_t magnetic_node_count,
    std::string &out_digest,
    char error_message[256]) noexcept
{
    out_digest.clear();
    copy_error(error_message, "");
    try {
        if (!accepted_v6_binding.accepted || payload.mesh == nullptr ||
            payload.mesh->nodes_xyz == nullptr || payload.mesh->nodes_xyz_len == 0u ||
            payload.mesh->nodes_xyz_len % 3u != 0u ||
            payload.mesh->cell_markers == nullptr ||
            payload.mesh->cell_markers_len != payload.mesh->cell_types_len ||
            payload.mesh->cell_offsets == nullptr ||
            payload.mesh->cell_offsets_len != payload.mesh->cell_types_len + 1u ||
            payload.mesh->cell_nodes == nullptr ||
            payload.mesh->cell_offsets[0] != 0u ||
            payload.mesh->cell_offsets[payload.mesh->cell_types_len] !=
                payload.mesh->cell_nodes_len ||
            payload.mesh_generation_identity == nullptr ||
            payload.magnetic_part_identity == nullptr ||
            payload.airbox_part_identity == nullptr ||
            payload.certificate_binding_reason == nullptr ||
            payload.scalar_reduced_node == nullptr ||
            payload.magnetic_reduced_node == nullptr) {
            copy_error(error_message, "shared_domain_map_binding_inputs_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        const std::uint64_t node_count = payload.mesh->nodes_xyz_len / 3u;
        if (magnetic_node_count == 0u || magnetic_node_count > node_count ||
            accepted_v6_binding.magnetic_canonical_class_ids.size() != magnetic_node_count ||
            accepted_v6_binding.scalar_canonical_class_ids.size() != node_count) {
            copy_error(error_message, "shared_domain_map_binding_node_order_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        std::vector<std::uint8_t> magnetic_node_mask(
            static_cast<std::size_t>(node_count), 0u);
        for (std::uint64_t element = 0u; element < payload.mesh->cell_types_len; ++element) {
            const std::uint32_t begin = payload.mesh->cell_offsets[element];
            const std::uint32_t end = payload.mesh->cell_offsets[element + 1u];
            if (begin > end || end > payload.mesh->cell_nodes_len) {
                copy_error(error_message, "shared_domain_map_binding_marker_topology_invalid");
                return FrequencyDomainStatus::validation_error;
            }
            if (payload.mesh->cell_markers[element] != 1u) {
                continue;
            }
            for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                const std::uint32_t node = payload.mesh->cell_nodes[cursor];
                if (node >= node_count) {
                    copy_error(error_message, "shared_domain_map_binding_marker_topology_invalid");
                    return FrequencyDomainStatus::validation_error;
                }
                magnetic_node_mask[node] = 1u;
            }
        }
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            const bool expected_magnetic = node < magnetic_node_count;
            if ((magnetic_node_mask[static_cast<std::size_t>(node)] != 0u) !=
                expected_magnetic) {
                copy_error(error_message, "shared_domain_map_binding_node_order_invalid");
                return FrequencyDomainStatus::validation_error;
            }
        }
        CanonicalDigestBuilder digest("shared_domain_map_binding.v1");
        digest.add_string("mesh_generation_identity", payload.mesh_generation_identity);
        digest.add_string(
            "node_order_contract",
            "scalar_global_nodes_authoritative;magnetic_compact_exact_prefix");
        digest.add_u64("scalar_global_node_count", node_count);
        digest.add_u64("magnetic_compact_node_count", magnetic_node_count);
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            digest.add_u64(
                "global_node_magnetic_marker[" + std::to_string(node) + "]",
                magnetic_node_mask[static_cast<std::size_t>(node)]);
        }
        for (std::uint64_t compact_node = 0u;
             compact_node < magnetic_node_count;
             ++compact_node) {
            digest.add_u64(
                "magnetic_compact_source_global_node[" +
                    std::to_string(compact_node) + "]",
                compact_node);
        }
        digest.add_string("magnetic_part_identity", payload.magnetic_part_identity);
        digest.add_string("airbox_part_identity", payload.airbox_part_identity);
        digest.add_u64("certificate_binding_status", payload.certificate_binding_status);
        digest.add_string("certificate_binding_reason", payload.certificate_binding_reason);
        digest.add_string(
            "v6_canonical_preimage_sha256",
            accepted_v6_binding.canonical_preimage_sha256);
        digest.add_string(
            "v6_magnetic_class_digest_sha256",
            accepted_v6_binding.magnetic_class_digest_sha256);
        digest.add_string(
            "v6_scalar_class_digest_sha256",
            accepted_v6_binding.scalar_class_digest_sha256);
        digest.add_u64("cell_marker_count", payload.mesh->cell_markers_len);
        for (std::uint64_t index = 0u; index < payload.mesh->cell_markers_len; ++index) {
            digest.add_u64(
                "cell_marker[" + std::to_string(index) + "]",
                payload.mesh->cell_markers[index]);
        }
        digest.add_u64(
            "magnetic_canonical_class_id_count",
            accepted_v6_binding.magnetic_canonical_class_ids.size());
        for (std::size_t index = 0u;
             index < accepted_v6_binding.magnetic_canonical_class_ids.size(); ++index) {
            digest.add_u64(
                "magnetic_canonical_class_id[" + std::to_string(index) + "]",
                accepted_v6_binding.magnetic_canonical_class_ids[index]);
        }
        digest.add_u64(
            "scalar_canonical_class_id_count",
            accepted_v6_binding.scalar_canonical_class_ids.size());
        for (std::size_t index = 0u;
             index < accepted_v6_binding.scalar_canonical_class_ids.size(); ++index) {
            digest.add_u64(
                "scalar_canonical_class_id[" + std::to_string(index) + "]",
                accepted_v6_binding.scalar_canonical_class_ids[index]);
        }
        digest.add_u64("scalar_reduced_class_count", payload.scalar_reduced_node_count);
        digest.add_u64("magnetic_reduced_class_count", payload.magnetic_reduced_node_count);
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            digest.add_u64(
                "scalar_reduced_node[" + std::to_string(node) + "]",
                payload.scalar_reduced_node[node]);
            digest.add_u64(
                "magnetic_reduced_node[" + std::to_string(node) + "]",
                payload.magnetic_reduced_node[node]);
        }
        out_digest = "sha256:" + digest.sha256_hex();
        return FrequencyDomainStatus::ok;
    } catch (...) {
        copy_error(error_message, "shared_domain_map_binding_digest_failed");
        return FrequencyDomainStatus::validation_error;
    }
}

FrequencyDomainStatus validate_linearization_descriptor_contract(
    const FullmagFemModalLinearizationDescriptor &descriptor,
    std::uint64_t expected_node_count,
    char error_message[256]) noexcept
{
    return validate_linearization_descriptor_common(
        descriptor, expected_node_count, error_message);
}

FrequencyDomainStatus validate_modal_shared_domain_payload_contract(
    const FullmagFemModalSharedDomainPayload &payload,
    std::uint64_t expected_node_count,
    ModalSharedDomainValidationResult *out_validation,
    char error_message[256]) noexcept
{
    if (out_validation != nullptr) {
        *out_validation = ModalSharedDomainValidationResult{};
    }
    copy_error(error_message, "");
    try {
        constexpr std::size_t kV19PayloadSize =
            offsetof(FullmagFemModalSharedDomainPayload, acceptance_certificate_sha256) +
            sizeof(payload.acceptance_certificate_sha256);
        if (payload.abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION ||
            payload.struct_size < kV19PayloadSize) {
            copy_error(error_message,
                       "shared-domain native importer requires a full v19 acceptance-certificate prefix");
            return FrequencyDomainStatus::validation_error;
        }
        const EquilibriumAcceptanceCertificateDescriptor acceptance{
            payload.acceptance_criterion,
            payload.acceptance_metric_kind,
            payload.acceptance_unit,
            payload.acceptance_metric_value,
            payload.acceptance_threshold,
            payload.acceptance_certificate_sha256};
        char acceptance_error[128]{};
        if (validate_equilibrium_acceptance_certificate(
                acceptance, acceptance_error) != FrequencyDomainStatus::ok) {
            copy_error(error_message, acceptance_error);
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.mesh == nullptr || payload.mesh->nodes_xyz == nullptr ||
            payload.mesh->nodes_xyz_len == 0u || payload.mesh->nodes_xyz_len % 3u != 0u) {
            copy_error(error_message, "shared-domain payload has an invalid mesh node array");
            return FrequencyDomainStatus::validation_error;
        }
        const std::uint64_t node_count = payload.mesh->nodes_xyz_len / 3u;
        if (expected_node_count != 0u && expected_node_count != node_count) {
            copy_error(error_message, "shared-domain payload node count does not match the native mesh");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.linearization_descriptor == nullptr) {
            copy_error(error_message, "linearization_descriptor_missing");
            return FrequencyDomainStatus::validation_error;
        }
        char descriptor_error[256]{};
        if (validate_linearization_descriptor_common(
                *payload.linearization_descriptor, node_count, descriptor_error) !=
            FrequencyDomainStatus::ok) {
            copy_error(error_message, descriptor_error);
            return FrequencyDomainStatus::validation_error;
        }
        const auto digest_equal = [](const char *lhs, const char *rhs) {
            return lhs != nullptr && rhs != nullptr && std::strcmp(lhs, rhs) == 0;
        };
        if (!valid_sha256_binding_digest(payload.equilibrium_digest) ||
            !valid_sha256_binding_digest(payload.linearization_state_digest) ||
            !valid_sha256_binding_digest(payload.mesh_certificate_digest) ||
            !valid_sha256_binding_digest(payload.mesh_certificate_map_binding_digest) ||
            !valid_sha256_binding_digest(payload.boundary_gauge_digest) ||
            !valid_sha256_binding_digest(payload.bias_field_sample_signature) ||
            !digest_equal(payload.linearization_descriptor->linearization_state_digest,
                          payload.linearization_state_digest) ||
            !digest_equal(payload.linearization_descriptor->equilibrium_digest,
                          payload.equilibrium_digest)) {
            copy_error(error_message, "linearization_descriptor_payload_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.equilibrium_m0_xyz == nullptr ||
            payload.equilibrium_m0_xyz_count != 3u * node_count ||
            payload.linearization_descriptor->equilibrium_m0_xyz == nullptr ||
            payload.linearization_descriptor->equilibrium_m0_xyz_count != 3u * node_count) {
            copy_error(error_message, "linearization_descriptor_full_equilibrium_dimensions_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        const bool has_exchange =
            (payload.linearization_descriptor->term_presence_mask &
             FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u;
        if ((has_exchange && payload.exchange_material_view == nullptr) ||
            (!has_exchange && payload.exchange_material_view != nullptr)) {
            copy_error(error_message, "linearization_descriptor_exchange_material_binding_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.exchange_material_view != nullptr &&
            (payload.exchange_material_view->abi_version !=
                 FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION ||
             payload.exchange_material_view->struct_size <
                 sizeof(FullmagFemModalExchangeMaterialView) ||
             payload.exchange_material_view->reserved0 != 0u ||
             payload.exchange_material_view->reserved1 != 0u ||
             payload.exchange_material_view->schema_version == nullptr ||
             std::strcmp(payload.exchange_material_view->schema_version,
                         FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_SCHEMA) != 0 ||
             payload.exchange_material_view->material_kind !=
                 FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX ||
             !finite_positive(payload.exchange_material_view->exchange_stiffness_j_per_m))) {
            copy_error(error_message, "exchange_material_view_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.linearization_descriptor->exchange_edges != nullptr ||
            payload.linearization_descriptor->exchange_edge_count != 0u) {
            copy_error(error_message, "linearization_descriptor_exchange_graph_forbidden");
            return FrequencyDomainStatus::validation_error;
        }

        OwnedNativeV6View owned_views[4];
        if (payload.certificate_binding_v6 == nullptr ||
            payload.mesh_certificate_schema == nullptr ||
            std::strcmp(payload.mesh_certificate_schema, "periodic_mesh_certificate.v6") != 0) {
            copy_error(error_message, "shared-domain payload is missing the v6 periodic seam/corner certificate");
            return FrequencyDomainStatus::validation_error;
        }
        const FullmagFemModalCertificateV6BindingRequest &c_binding =
            *payload.certificate_binding_v6;
        if (c_binding.schema_version == nullptr ||
            std::strcmp(c_binding.schema_version, payload.mesh_certificate_schema) != 0) {
            copy_error(error_message, "periodic_mesh_certificate_v6_c_abi_schema_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        const FullmagFemModalCertificateV6View *c_views[4] = {
            &c_binding.mesh_magnetic,
            &c_binding.payload_magnetic,
            &c_binding.mesh_scalar,
            &c_binding.payload_scalar};
        for (std::size_t index = 0u; index < 4u; ++index) {
            std::string view_error;
            if (!copy_native_v6_view(*c_views[index], payload.mesh_certificate_schema,
                                     owned_views[index], view_error)) {
                copy_error(error_message, view_error.c_str());
                return FrequencyDomainStatus::validation_error;
            }
        }
        std::uint64_t magnetic_node_count = 0u;
        std::string marker_error;
        if (!validate_marker_certificate_binding(
                payload,
                owned_views[0],
                owned_views[2],
                node_count,
                magnetic_node_count,
                marker_error)) {
            copy_error(error_message, marker_error.c_str());
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.mesh->periodic_node_pairs == nullptr ||
            payload.mesh->periodic_node_pairs_len < 2u ||
            payload.mesh->periodic_node_pairs_len % 2u != 0u ||
            payload.mesh->periodic_boundary_pair_markers == nullptr ||
            payload.mesh->periodic_boundary_pair_markers_len == 0u ||
            payload.mesh->facet_roles == nullptr || payload.mesh->facet_markers == nullptr ||
            payload.mesh->facet_roles_len != payload.mesh->facet_markers_len) {
            copy_error(error_message,
                       "shared-domain payload has no authoritative periodic/open-z boundary map");
            return FrequencyDomainStatus::validation_error;
        }
        const auto mesh_pair_present = [&](std::uint64_t lhs, std::uint64_t rhs) {
            for (std::uint64_t index = 0u;
                 index + 1u < payload.mesh->periodic_node_pairs_len;
                 index += 2u) {
                const std::uint32_t first = payload.mesh->periodic_node_pairs[index];
                const std::uint32_t second = payload.mesh->periodic_node_pairs[index + 1u];
                if ((first == lhs && second == rhs) || (first == rhs && second == lhs)) {
                    return true;
                }
            }
            return false;
        };
        const auto relation_pairs_present = [&](const MeshSymmetryCertificateV6View &view) {
            for (std::uint64_t index = 0u; index < view.generator_relation_count; ++index) {
                const auto &relation = view.generator_relations[index];
                if (relation.source_node >= node_count || relation.destination_node >= node_count ||
                    !mesh_pair_present(relation.source_node, relation.destination_node)) {
                    return false;
                }
            }
            return true;
        };
        if (!relation_pairs_present(owned_views[0].view) ||
            !relation_pairs_present(owned_views[2].view)) {
            copy_error(error_message,
                       "periodic_mesh_certificate_v6_relation_missing_from_mesh_pair_map");
            return FrequencyDomainStatus::validation_error;
        }
        bool has_periodic_face = false;
        bool has_open_z_face = false;
        for (std::uint64_t index = 0u; index < payload.mesh->facet_roles_len; ++index) {
            const std::uint32_t role = payload.mesh->facet_roles[index];
            const std::uint32_t marker = payload.mesh->facet_markers[index];
            if (role == FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM) {
                has_periodic_face = true;
            }
            if (role == FULLMAG_FEM_FACET_ROLE_EXTERIOR && marker == payload.boundary_marker) {
                has_open_z_face = true;
            }
        }
        if (!has_periodic_face || !has_open_z_face) {
            copy_error(error_message,
                       "shared-domain payload periodic seams or open-z boundary are not mapped");
            return FrequencyDomainStatus::validation_error;
        }
        MeshSymmetryCertificateV6BindingRequest v6_request{};
        v6_request.schema_version = payload.mesh_certificate_schema;
        v6_request.mesh_generation_identity = payload.mesh_generation_identity;
        v6_request.mesh_magnetic = owned_views[0].view;
        v6_request.payload_magnetic = owned_views[1].view;
        v6_request.mesh_scalar = owned_views[2].view;
        v6_request.payload_scalar = owned_views[3].view;
        v6_request.payload_binding_digest = payload.canonical_preimage_sha256;
        MeshSymmetryCertificateV6Binding v6_binding{};
        if (verify_mesh_symmetry_certificate_v6(v6_request, v6_binding) !=
            FrequencyDomainStatus::ok) {
            copy_error(error_message,
                       v6_binding.rejection_reason[0] != '\0'
                           ? v6_binding.rejection_reason
                           : "periodic_mesh_certificate_v6_binding_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.magnetic_part_identity == nullptr ||
            std::strcmp(
                payload.magnetic_part_identity,
                v6_request.mesh_magnetic.part_identity) != 0) {
            copy_error(error_message, "magnetic_part_identity_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.airbox_part_identity == nullptr ||
            std::strcmp(
                payload.airbox_part_identity,
                v6_request.mesh_scalar.part_identity) != 0) {
            copy_error(error_message, "airbox_part_identity_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.certificate_binding_status !=
            FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED) {
            copy_error(error_message, "certificate_binding_status_not_accepted");
            return FrequencyDomainStatus::validation_error;
        }
        if (payload.certificate_binding_reason == nullptr ||
            std::strcmp(payload.certificate_binding_reason, "none") != 0) {
            copy_error(error_message, "certificate_binding_reason_not_none");
            return FrequencyDomainStatus::validation_error;
        }
        std::string reduction_map_error;
        if (!validate_canonical_reduction_map(
                v6_binding.scalar_canonical_class_ids,
                payload.scalar_reduced_node,
                payload.scalar_reduced_node_count,
                node_count,
                false,
                "scalar",
                reduction_map_error) ||
            !validate_canonical_reduction_map(
                v6_binding.magnetic_canonical_class_ids,
                payload.magnetic_reduced_node,
                payload.magnetic_reduced_node_count,
                node_count,
                true,
                "magnetic",
                reduction_map_error)) {
            copy_error(error_message, reduction_map_error.c_str());
            return FrequencyDomainStatus::validation_error;
        }
        if (!valid_sha256_binding_digest(payload.canonical_preimage_sha256) ||
            !valid_sha256_binding_digest(payload.magnetic_class_digest_sha256) ||
            !valid_sha256_binding_digest(payload.scalar_class_digest_sha256) ||
            std::strcmp(payload.canonical_preimage_sha256,
                        v6_binding.canonical_preimage_sha256) != 0 ||
            std::strcmp(payload.magnetic_class_digest_sha256,
                        v6_binding.magnetic_class_digest_sha256) != 0 ||
            std::strcmp(payload.scalar_class_digest_sha256,
                        v6_binding.scalar_class_digest_sha256) != 0) {
            copy_error(error_message, "periodic_mesh_certificate_v6_binding_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        std::string canonical_map_binding_digest;
        char canonical_map_binding_error[256]{};
        if (compute_modal_shared_domain_map_binding_digest(
                payload,
                v6_binding,
                magnetic_node_count,
                canonical_map_binding_digest,
                canonical_map_binding_error) != FrequencyDomainStatus::ok) {
            copy_error(error_message, canonical_map_binding_error);
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(
                payload.mesh_certificate_map_binding_digest,
                canonical_map_binding_digest.c_str()) != 0) {
            copy_error(error_message, "shared_domain_map_binding_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        char preimage_digest[96]{};
        char preimage_reason[160]{};
        if (verify_mesh_symmetry_certificate_v6_preimage(
                payload.canonical_preimage,
                payload.canonical_preimage_len,
                v6_binding.canonical_preimage_sha256,
                preimage_digest,
                sizeof(preimage_digest),
                preimage_reason,
                sizeof(preimage_reason)) != FrequencyDomainStatus::ok ||
            std::strcmp(preimage_digest, v6_binding.canonical_preimage_sha256) != 0) {
            copy_error(error_message,
                       preimage_reason[0] != '\0' ? preimage_reason
                                                   : "canonical_preimage_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (out_validation != nullptr) {
            std::strncpy(out_validation->canonical_preimage_sha256,
                         v6_binding.canonical_preimage_sha256,
                         sizeof(out_validation->canonical_preimage_sha256) - 1u);
            std::strncpy(out_validation->canonical_map_binding_sha256,
                         canonical_map_binding_digest.c_str(),
                         sizeof(out_validation->canonical_map_binding_sha256) - 1u);
            std::strncpy(out_validation->magnetic_class_digest_sha256,
                         v6_binding.magnetic_class_digest_sha256,
                         sizeof(out_validation->magnetic_class_digest_sha256) - 1u);
            std::strncpy(out_validation->scalar_class_digest_sha256,
                         v6_binding.scalar_class_digest_sha256,
                         sizeof(out_validation->scalar_class_digest_sha256) - 1u);
            out_validation->certificate_binding_status =
                FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED;
        }
        return FrequencyDomainStatus::ok;
    } catch (const std::exception &exception) {
        copy_error(error_message, exception.what());
    } catch (...) {
        copy_error(error_message, "shared-domain payload contract validation failed");
    }
    return FrequencyDomainStatus::validation_error;
}

FrequencyDomainStatus assemble_native_magnetic_a_qq(
    const FullmagFemModalLinearizationDescriptor &descriptor,
    mfem::FiniteElementSpace *scalar_space,
    const std::uint8_t *magnetic_element_mask,
    std::uint64_t magnetic_element_count,
    PoissonAirboxSharedDomainCsrMatrix *out_a_qq,
    char error_message[256],
    const FullmagFemModalExchangeMaterialView *exchange_material_view,
    const TangentFrameNode *accepted_tangent_frames,
    std::uint64_t accepted_tangent_frame_count,
    double accepted_max_transverse_field_a_per_m) noexcept
{
    if (out_a_qq != nullptr) {
        *out_a_qq = PoissonAirboxSharedDomainCsrMatrix{};
    }
    copy_error(error_message, "");
    try {
        if (out_a_qq == nullptr || scalar_space == nullptr ||
            scalar_space->GetMesh() == nullptr || magnetic_element_mask == nullptr ||
            magnetic_element_count !=
                static_cast<std::uint64_t>(scalar_space->GetMesh()->GetNE())) {
            copy_error(error_message,
                       "native magnetic A_qq producer requires one MFEM mesh and element mask");
            return FrequencyDomainStatus::validation_error;
        }
        const std::uint64_t node_count =
            static_cast<std::uint64_t>(scalar_space->GetVSize());
        if (node_count > std::numeric_limits<std::uint64_t>::max() / 2u ||
            node_count > static_cast<std::uint64_t>(std::numeric_limits<std::uint32_t>::max() / 2u)) {
            copy_error(error_message,
                       "native magnetic A_qq mesh exceeds the CSR index range");
            return FrequencyDomainStatus::validation_error;
        }
        if (validate_linearization_descriptor_common(
                descriptor, node_count, error_message) != FrequencyDomainStatus::ok) {
            return FrequencyDomainStatus::validation_error;
        }
        const std::uint32_t known_terms =
            FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE |
            FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD |
            FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY |
            FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI |
            FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG;
        if (descriptor.abi_version !=
                FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION ||
            descriptor.struct_size < sizeof(FullmagFemModalLinearizationDescriptor) ||
            descriptor.node_count != node_count ||
            descriptor.tangent_dof_count != 2u * node_count ||
            (descriptor.term_presence_mask & ~known_terms) != 0u ||
            (descriptor.term_presence_mask & known_terms) == 0u ||
            descriptor.tangent_frame_xyz == nullptr ||
            descriptor.tangent_frame_xyz_count != 6u * node_count ||
            descriptor.equilibrium_m0_xyz == nullptr ||
            descriptor.equilibrium_m0_xyz_count != 3u * node_count ||
            descriptor.effective_field_h_eff0_xyz == nullptr ||
            descriptor.effective_field_h_eff0_xyz_count != 3u * node_count) {
            copy_error(error_message,
                       "native magnetic A_qq descriptor has incomplete dimensions or terms");
            return FrequencyDomainStatus::validation_error;
        }
        if ((descriptor.term_presence_mask &
             (FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY |
              FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DMI)) != 0u) {
            copy_error(error_message,
                       "native magnetic A_qq producer does not yet certify anisotropy or DMI weak forms");
            return FrequencyDomainStatus::unavailable;
        }
        const bool has_exchange_material_view = exchange_material_view != nullptr;
        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u &&
            !has_exchange_material_view &&
            (descriptor.exchange_edges == nullptr || descriptor.exchange_edge_count == 0u)) {
            copy_error(error_message,
                       "native magnetic A_qq exchange term requires exchange edges");
            return FrequencyDomainStatus::validation_error;
        }
        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u &&
            has_exchange_material_view &&
            (descriptor.exchange_edges != nullptr || descriptor.exchange_edge_count != 0u)) {
            copy_error(error_message,
                       "native magnetic A_qq exchange material view forbids graph endpoints");
            return FrequencyDomainStatus::validation_error;
        }
        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) == 0u &&
            (descriptor.exchange_edges != nullptr || descriptor.exchange_edge_count != 0u ||
             has_exchange_material_view)) {
            copy_error(error_message,
                       "native magnetic A_qq descriptor carries unadvertised exchange edges");
            return FrequencyDomainStatus::validation_error;
        }
        if (has_exchange_material_view &&
            (exchange_material_view->abi_version !=
                 FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION ||
             exchange_material_view->struct_size < sizeof(FullmagFemModalExchangeMaterialView) ||
             exchange_material_view->reserved0 != 0u || exchange_material_view->reserved1 != 0u ||
             exchange_material_view->schema_version == nullptr ||
             std::strcmp(exchange_material_view->schema_version,
                         FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_SCHEMA) != 0 ||
             exchange_material_view->material_kind != FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX ||
             !finite_positive(exchange_material_view->exchange_stiffness_j_per_m))) {
            copy_error(error_message,
                       "native magnetic A_qq exchange material view is invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG) != 0u &&
            (descriptor.demag_provider_signature == nullptr ||
             descriptor.demag_provider_signature[0] == '\0' ||
             descriptor.operator_input_digest == nullptr ||
             descriptor.operator_input_digest[0] == '\0')) {
            copy_error(error_message,
                       "native magnetic A_qq demag term requires a provider signature and operator input digest");
            return FrequencyDomainStatus::validation_error;
        }
        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG) != 0u &&
            std::strcmp(descriptor.demag_provider_signature,
                        descriptor.operator_input_digest) != 0) {
            copy_error(error_message,
                       "native magnetic A_qq demag provider signature does not bind the operator input digest");
            return FrequencyDomainStatus::validation_error;
        }
        for (std::uint64_t element = 0; element < magnetic_element_count; ++element) {
            if (magnetic_element_mask[element] > 1u) {
                copy_error(error_message,
                           "native magnetic A_qq element mask must contain only zero or one");
                return FrequencyDomainStatus::validation_error;
            }
        }
        mfem::Mesh *mesh = scalar_space->GetMesh();
        std::vector<std::uint8_t> magnetic_node_mask(
            static_cast<std::size_t>(node_count), 0u);
        for (int element = 0; element < mesh->GetNE(); ++element) {
            if (magnetic_element_mask[static_cast<std::size_t>(element)] == 0u) {
                continue;
            }
            mfem::Array<int> dofs;
            scalar_space->GetElementDofs(element, dofs);
            for (int local = 0; local < dofs.Size(); ++local) {
                const std::uint64_t node = static_cast<std::uint64_t>(
                    dofs[local] >= 0 ? dofs[local] : -1 - dofs[local]);
                if (node >= node_count) {
                    copy_error(error_message,
                               "native magnetic A_qq MFEM element has an out-of-range node");
                    return FrequencyDomainStatus::validation_error;
                }
                magnetic_node_mask[static_cast<std::size_t>(node)] = 1u;
            }
        }

        const auto finite_vector = [](const double *values, std::uint64_t count) {
            if (values == nullptr) {
                return false;
            }
            for (std::uint64_t index = 0; index < count; ++index) {
                if (!std::isfinite(values[index])) {
                    return false;
                }
            }
            return true;
        };
        if (!finite_vector(descriptor.tangent_frame_xyz, 6u * node_count) ||
            !finite_vector(descriptor.equilibrium_m0_xyz, 3u * node_count) ||
            !finite_vector(descriptor.effective_field_h_eff0_xyz, 3u * node_count)) {
            copy_error(error_message,
                       "native magnetic A_qq descriptor contains non-finite state data");
            return FrequencyDomainStatus::validation_error;
        }
        if (descriptor.saturation_magnetisation_a_per_m != nullptr) {
            if (descriptor.saturation_magnetisation_count != node_count ||
                !finite_vector(descriptor.saturation_magnetisation_a_per_m, node_count)) {
                copy_error(error_message,
                           "native magnetic A_qq saturation magnetisation cardinality is invalid");
                return FrequencyDomainStatus::validation_error;
            }
            for (std::uint64_t node = 0; node < node_count; ++node) {
                if (!finite_positive(descriptor.saturation_magnetisation_a_per_m[node])) {
                    copy_error(error_message,
                               "native magnetic A_qq saturation magnetisation must be positive");
                    return FrequencyDomainStatus::validation_error;
                }
            }
        } else if (!finite_positive(descriptor.uniform_saturation_magnetisation_a_per_m)) {
            copy_error(error_message,
                       "native magnetic A_qq requires a positive uniform saturation magnetisation");
            return FrequencyDomainStatus::validation_error;
        }

        const TangentFrameNode *tangent_frames = accepted_tangent_frames;
        if (tangent_frames == nullptr) {
            copy_error(error_message,
                       "native magnetic A_qq requires one accepted tangent-frame buffer");
            return FrequencyDomainStatus::validation_error;
        }
        if (accepted_tangent_frame_count != node_count) {
            copy_error(error_message,
                       "native magnetic A_qq accepted tangent frame cardinality mismatch");
            return FrequencyDomainStatus::validation_error;
        } else if (!validate_tangent_frame_buffer(
                       tangent_frames, accepted_tangent_frame_count, error_message)) {
            return FrequencyDomainStatus::validation_error;
        }
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            const TangentFrameNode &frame = tangent_frames[static_cast<std::size_t>(node)];
            for (int axis = 0; axis < 3; ++axis) {
                if (frame.m[axis] != descriptor.equilibrium_m0_xyz[3u * node + axis] ||
                    frame.e1[axis] != descriptor.tangent_frame_xyz[6u * node + axis] ||
                    frame.e2[axis] != descriptor.tangent_frame_xyz[6u * node + 3u + axis]) {
                    copy_error(error_message,
                               "linearization_descriptor_frame_source_mismatch");
                    return FrequencyDomainStatus::validation_error;
                }
            }
        }

        const std::uint64_t full_q_count = 2u * node_count;
        SparseAccumulator assembled(full_q_count, full_q_count);
        const double mu0 = 1.25663706212e-6;
        const auto node_ms = [&](std::uint64_t node) {
            return descriptor.saturation_magnetisation_a_per_m != nullptr
                ? descriptor.saturation_magnetisation_a_per_m[node]
                : descriptor.uniform_saturation_magnetisation_a_per_m;
        };

        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u) {
            /*
             * exchange_edges is retained only for direct producer validation
             * tests and pre-v18 compatibility.  The public ABI-v18 importer
             * requires the append-only scalar material view.  When this
             * validation-only carrier is present, it supplies one A_ex scalar;
             * its node endpoints are validated as a trusted magnetic-node
             * view but never select a graph edge or a matrix entry.  The actual
             * operator is the P1 weak form on this native MFEM mesh and
             * quadrature:
             *
             *   K[(i,c),(j,d)] += 2 A_ex
             *       (e_c(i) . e_d(j)) (grad N_i . grad N_j) w_K.
             *
             * Keeping this carrier interpretation explicit prevents a
             * runner-owned graph Laplacian from becoming production physics.
             */
            const double exchange_stiffness = has_exchange_material_view
                ? exchange_material_view->exchange_stiffness_j_per_m
                : descriptor.exchange_edges[0].stiffness;
            if (!finite_positive(exchange_stiffness)) {
                copy_error(error_message,
                           "native magnetic A_qq exchange material stiffness must be positive");
                return FrequencyDomainStatus::validation_error;
            }
            std::set<std::pair<std::uint64_t, std::uint64_t>> seen_edges;
            for (std::uint64_t edge_index = 0;
                 !has_exchange_material_view && edge_index < descriptor.exchange_edge_count;
                 ++edge_index) {
                const auto &edge = descriptor.exchange_edges[edge_index];
                if (!finite_positive(edge.stiffness) ||
                    edge.stiffness != exchange_stiffness) {
                    copy_error(error_message,
                               "native magnetic A_qq exchange material view must be homogeneous");
                    return FrequencyDomainStatus::validation_error;
                }
                if (edge.node_i >= node_count || edge.node_j >= node_count ||
                    edge.node_i == edge.node_j) {
                    copy_error(error_message,
                               "native magnetic A_qq exchange material view has invalid endpoints");
                    return FrequencyDomainStatus::validation_error;
                }
                if (magnetic_node_mask[static_cast<std::size_t>(edge.node_i)] == 0u ||
                    magnetic_node_mask[static_cast<std::size_t>(edge.node_j)] == 0u) {
                    copy_error(error_message,
                               "native magnetic A_qq exchange material view endpoints must belong to the magnetic node set");
                    return FrequencyDomainStatus::validation_error;
                }
                const auto canonical_edge = std::minmax(edge.node_i, edge.node_j);
                if (!seen_edges.emplace(canonical_edge.first, canonical_edge.second).second) {
                    copy_error(error_message,
                               "native magnetic A_qq exchange material view contains duplicate endpoints");
                    return FrequencyDomainStatus::validation_error;
                }
            }

            mfem::Mesh *exchange_mesh = scalar_space->GetMesh();
            for (int element = 0; element < exchange_mesh->GetNE(); ++element) {
                if (magnetic_element_mask[static_cast<std::size_t>(element)] == 0u) {
                    continue;
                }
                mfem::Array<int> dofs;
                scalar_space->GetElementDofs(element, dofs);
                const mfem::FiniteElement *finite_element = scalar_space->GetFE(element);
                const bool supported_p1_geometry = finite_element != nullptr &&
                    ((finite_element->GetGeomType() == mfem::Geometry::TETRAHEDRON &&
                      dofs.Size() == 4) ||
                     (finite_element->GetGeomType() == mfem::Geometry::PRISM &&
                      dofs.Size() == 6));
                if (finite_element == nullptr ||
                    finite_element->GetOrder() != 1 || !supported_p1_geometry) {
                    copy_error(error_message,
                               "native magnetic A_qq exchange supports only P1 tet4 or prism6 elements");
                    return FrequencyDomainStatus::unavailable;
                }
                mfem::ElementTransformation *transformation =
                    exchange_mesh->GetElementTransformation(element);
                const mfem::IntegrationRule &rule =
                    mfem::IntRules.Get(finite_element->GetGeomType(), 1);
                for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
                    const mfem::IntegrationPoint &point = rule.IntPoint(point_index);
                    transformation->SetIntPoint(&point);
                    const double weight = transformation->Weight() * point.weight;
                    if (!finite_positive(weight)) {
                        copy_error(error_message,
                                   "native magnetic A_qq exchange quadrature has non-positive weight");
                        return FrequencyDomainStatus::operator_error;
                    }
                    mfem::DenseMatrix physical_dshape(dofs.Size(), 3);
                    finite_element->CalcPhysDShape(*transformation, physical_dshape);
                    for (int local_row = 0; local_row < dofs.Size(); ++local_row) {
                        const std::uint64_t row_node = static_cast<std::uint64_t>(
                            dofs[local_row] >= 0 ? dofs[local_row] : -1 - dofs[local_row]);
                        const double row_sign = dofs[local_row] >= 0 ? 1.0 : -1.0;
                        if (row_node >= node_count ||
                            magnetic_node_mask[static_cast<std::size_t>(row_node)] == 0u) {
                            copy_error(error_message,
                                       "native magnetic A_qq exchange element has a non-magnetic node");
                            return FrequencyDomainStatus::validation_error;
                        }
                        for (int local_column = 0; local_column < dofs.Size(); ++local_column) {
                            const std::uint64_t column_node = static_cast<std::uint64_t>(
                                dofs[local_column] >= 0 ? dofs[local_column] : -1 - dofs[local_column]);
                            const double column_sign = dofs[local_column] >= 0 ? 1.0 : -1.0;
                            if (column_node >= node_count ||
                                magnetic_node_mask[static_cast<std::size_t>(column_node)] == 0u) {
                                copy_error(error_message,
                                           "native magnetic A_qq exchange element has a non-magnetic node");
                                return FrequencyDomainStatus::validation_error;
                            }
                            double gradient_dot = 0.0;
                            for (int axis = 0; axis < 3; ++axis) {
                                const double row_gradient = physical_dshape(local_row, axis);
                                const double column_gradient = physical_dshape(local_column, axis);
                                if (!std::isfinite(row_gradient) || !std::isfinite(column_gradient)) {
                                    copy_error(error_message,
                                               "native magnetic A_qq exchange gradient is non-finite");
                                    return FrequencyDomainStatus::operator_error;
                                }
                                gradient_dot += row_gradient * column_gradient;
                            }
                            const TangentFrameNode &row_frame =
                                tangent_frames[static_cast<std::size_t>(row_node)];
                            const TangentFrameNode &column_frame =
                                tangent_frames[static_cast<std::size_t>(column_node)];
                            const double *row_tangent[2] = {row_frame.e1, row_frame.e2};
                            const double *column_tangent[2] = {column_frame.e1, column_frame.e2};
                            const double coefficient =
                                row_sign * column_sign * 2.0 * exchange_stiffness *
                                gradient_dot * weight;
                            for (std::uint32_t row_component = 0; row_component < 2u;
                                 ++row_component) {
                                for (std::uint32_t column_component = 0;
                                     column_component < 2u; ++column_component) {
                                    assembled.add(
                                        2u * row_node + row_component,
                                        2u * column_node + column_component,
                                        coefficient *
                                            dot3(row_tangent[row_component],
                                                 column_tangent[column_component]));
                                }
                            }
                        }
                    }
                }
            }
        }

        if ((descriptor.term_presence_mask & FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD) != 0u) {
            constexpr double kStaticFieldParallelRelativeTolerance = 1.0e-8;
            for (std::uint64_t node = 0u; node < node_count; ++node) {
                if (magnetic_node_mask[static_cast<std::size_t>(node)] == 0u) {
                    continue;
                }
                const double *m0 = &descriptor.equilibrium_m0_xyz[3u * node];
                const double *h_eff0 = &descriptor.effective_field_h_eff0_xyz[3u * node];
                const double h_parallel = dot3(m0, h_eff0);
                double h_transverse_squared = 0.0;
                double h_eff0_squared = 0.0;
                for (int axis = 0; axis < 3; ++axis) {
                    const double transverse = h_eff0[axis] - h_parallel * m0[axis];
                    h_transverse_squared += transverse * transverse;
                    h_eff0_squared += h_eff0[axis] * h_eff0[axis];
                }
                const double tolerance = accepted_max_transverse_field_a_per_m >= 0.0
                    ? accepted_max_transverse_field_a_per_m
                    : kStaticFieldParallelRelativeTolerance *
                        std::max(1.0, std::sqrt(h_eff0_squared));
                if (std::sqrt(h_transverse_squared) > tolerance) {
                    copy_error(error_message,
                               "native magnetic A_qq static field exceeds the accepted equilibrium torque threshold");
                    return FrequencyDomainStatus::unavailable;
                }
            }
            for (int element = 0; element < mesh->GetNE(); ++element) {
                if (magnetic_element_mask[static_cast<std::size_t>(element)] == 0u) {
                    continue;
                }
                mfem::Array<int> dofs;
                scalar_space->GetElementDofs(element, dofs);
                const mfem::FiniteElement *finite_element = scalar_space->GetFE(element);
                mfem::ElementTransformation *transformation = mesh->GetElementTransformation(element);
                const mfem::IntegrationRule &rule =
                    mfem::IntRules.Get(finite_element->GetGeomType(), 4);
                for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
                    const mfem::IntegrationPoint &point = rule.IntPoint(point_index);
                    transformation->SetIntPoint(&point);
                    mfem::Vector shape(dofs.Size());
                    finite_element->CalcShape(point, shape);
                    const double weight = transformation->Weight() * point.weight;
                    double m0[3] = {0.0, 0.0, 0.0};
                    double h_eff0[3] = {0.0, 0.0, 0.0};
                    double ms = 0.0;
                    for (int local = 0; local < dofs.Size(); ++local) {
                        const std::uint64_t node = static_cast<std::uint64_t>(
                            dofs[local] >= 0 ? dofs[local] : -1 - dofs[local]);
                        for (int axis = 0; axis < 3; ++axis) {
                            m0[axis] += shape[local] *
                                descriptor.equilibrium_m0_xyz[3u * node + axis];
                            h_eff0[axis] += shape[local] *
                                descriptor.effective_field_h_eff0_xyz[3u * node + axis];
                        }
                        ms += shape[local] * node_ms(node);
                    }
                    const double m_norm = std::sqrt(dot3(m0, m0));
                    if (!finite_positive(m_norm) || !finite_positive(ms)) {
                        copy_error(error_message,
                                   "native magnetic A_qq field quadrature is non-finite");
                        return FrequencyDomainStatus::operator_error;
                    }
                    for (int axis = 0; axis < 3; ++axis) {
                        m0[axis] /= m_norm;
                    }
                    const double h_parallel = dot3(m0, h_eff0);
                    const double field_block[2][2] = {
                        {h_parallel, 0.0},
                        {0.0, h_parallel},
                    };
                    for (int local_row = 0; local_row < dofs.Size(); ++local_row) {
                        const std::uint64_t row_node = static_cast<std::uint64_t>(
                            dofs[local_row] >= 0 ? dofs[local_row] : -1 - dofs[local_row]);
                        const double row_sign = dofs[local_row] >= 0 ? 1.0 : -1.0;
                        for (int local_column = 0; local_column < dofs.Size(); ++local_column) {
                            const std::uint64_t column_node = static_cast<std::uint64_t>(
                                dofs[local_column] >= 0 ? dofs[local_column] : -1 - dofs[local_column]);
                            const double column_sign = dofs[local_column] >= 0 ? 1.0 : -1.0;
                            const double coefficient = row_sign * column_sign * weight *
                                shape[local_row] * shape[local_column] * mu0 * ms;
                            for (std::uint32_t row_component = 0; row_component < 2u; ++row_component) {
                                for (std::uint32_t column_component = 0; column_component < 2u;
                                     ++column_component) {
                                    assembled.add(
                                        2u * row_node + row_component,
                                        2u * column_node + column_component,
                                        coefficient * field_block[row_component][column_component]);
                                }
                            }
                        }
                    }
                }
            }
        }

        assembled.finish(*out_a_qq);
        return FrequencyDomainStatus::ok;
    } catch (const std::exception &exception) {
        copy_error(error_message, exception.what());
    } catch (...) {
        copy_error(error_message, "native magnetic A_qq assembly failed");
    }
    return FrequencyDomainStatus::operator_error;
}

FrequencyDomainStatus assemble_poisson_airbox_shared_domain(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    PoissonAirboxSharedDomainAssemblyResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxSharedDomainAssemblyResult{};
    out_result->status = FrequencyDomainStatus::validation_error;

    try {
        if (request.scalar_space == nullptr || request.tangent_frames == nullptr ||
            request.tangent_frame_count == 0) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires one scalar FE space and tangent frames");
            return out_result->status;
        }
        const std::uint64_t node_count =
            static_cast<std::uint64_t>(request.scalar_space->GetVSize());
        if (node_count != request.tangent_frame_count ||
            request.scalar_space->GetMesh() == nullptr ||
            request.scalar_space->GetMesh()->Dimension() != 3 ||
            request.scalar_space->GetFE(0)->GetOrder() != 1) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires a three-dimensional nodal P1 FE space");
            return out_result->status;
        }
        if (!request.equivalence_classes_complete) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires complete scalar and magnetic equivalence classes");
            return out_result->status;
        }
        std::string error;
        if (!validate_classes(
                request.scalar_reduced_node,
                node_count,
                request.scalar_reduced_node_count,
                false,
                "scalar",
                error) ||
            !validate_classes(
                request.magnetic_reduced_node,
                node_count,
                request.magnetic_reduced_node_count,
                true,
                "magnetic",
                error)) {
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        if (request.magnetic_element_mask == nullptr ||
            request.magnetic_element_count !=
                static_cast<std::uint64_t>(request.scalar_space->GetMesh()->GetNE())) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires one magnetic mask entry per mesh element");
            return out_result->status;
        }
        for (std::uint64_t element = 0; element < request.magnetic_element_count; ++element) {
            if (request.magnetic_element_mask[element] > 1u) {
                copy_error(out_result->error_message,
                           "shared-domain magnetic element mask must contain only zero or one");
                return out_result->status;
            }
        }
        if (!validate_materials(request, node_count, error) ||
            !finite_positive(request.gamma0_m_per_a_s) ||
            !finite_positive(request.mu0_T_m_A)) {
            if (error.empty()) {
                error = "shared-domain gamma0 and mu0 must be finite and positive";
            }
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        const std::uint64_t full_q_count = 2u * node_count;
        if (request.magnetic_a_qq_csr == nullptr ||
            !csr_is_valid(*request.magnetic_a_qq_csr, full_q_count)) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires a finite full magnetic A_qq CSR block");
            return out_result->status;
        }

        switch (request.boundary_kind) {
        case PoissonAirboxBoundaryKind::robin:
            if (!finite_positive(request.robin_beta) || request.robin_boundary_marker == nullptr) {
                copy_error(out_result->error_message,
                           "Robin shared-domain assembly requires beta>0 and a boundary marker");
                return out_result->status;
            }
            break;
        case PoissonAirboxBoundaryKind::dirichlet:
            if (request.robin_beta != 0.0 || request.robin_boundary_marker == nullptr) {
                copy_error(out_result->error_message,
                           "Dirichlet shared-domain assembly requires beta=0 and a boundary marker");
                return out_result->status;
            }
            break;
        case PoissonAirboxBoundaryKind::pure_neumann:
            if (request.robin_beta != 0.0 || request.robin_boundary_marker != nullptr) {
                copy_error(out_result->error_message,
                           "pure-Neumann shared-domain assembly forbids Robin data");
                return out_result->status;
            }
            break;
        default:
            copy_error(out_result->error_message, "unknown shared-domain boundary kind");
            return out_result->status;
        }

        std::unique_ptr<mfem::ConstantCoefficient> robin_coefficient;
        mfem::BilinearForm scalar_form(request.scalar_space);
        scalar_form.AddDomainIntegrator(new mfem::DiffusionIntegrator());
        if (request.boundary_kind == PoissonAirboxBoundaryKind::robin) {
            robin_coefficient = std::make_unique<mfem::ConstantCoefficient>(request.robin_beta);
            scalar_form.AddBoundaryIntegrator(
                new mfem::BoundaryMassIntegrator(*robin_coefficient),
                *request.robin_boundary_marker);
        }
        scalar_form.Assemble();
        scalar_form.Finalize();
        std::unique_ptr<mfem::SparseMatrix> p_full(
            new mfem::SparseMatrix(scalar_form.SpMat()));

        mfem::Array<int> essential;
        if (request.boundary_kind == PoissonAirboxBoundaryKind::dirichlet) {
            request.scalar_space->GetEssentialTrueDofs(
                *request.robin_boundary_marker,
                essential);
            for (int index = 0; index < essential.Size(); ++index) {
                p_full->EliminateRowCol(essential[index]);
            }
        }

        SparseAccumulator p_reduced(
            request.scalar_reduced_node_count,
            request.scalar_reduced_node_count);
        add_mfem_matrix(
            *p_full,
            request.scalar_reduced_node,
            request.scalar_reduced_node_count,
            request.scalar_reduced_node,
            request.scalar_reduced_node_count,
            1u,
            1u,
            p_reduced);
        p_reduced.finish(out_result->p);

        SparseAccumulator a_qq_reduced(
            2u * request.magnetic_reduced_node_count,
            2u * request.magnetic_reduced_node_count);
        add_csr_matrix(
            *request.magnetic_a_qq_csr,
            request.magnetic_reduced_node,
            request.magnetic_reduced_node,
            2u,
            2u,
            a_qq_reduced);
        a_qq_reduced.finish(out_result->a_qq);

        SparseAccumulator a_phiq_full(node_count, full_q_count);
        SparseAccumulator a_qphi_full(full_q_count, node_count);
        SparseAccumulator b_qq_full(full_q_count, full_q_count);
        mfem::Mesh *mesh = request.scalar_space->GetMesh();
        for (int element = 0; element < mesh->GetNE(); ++element) {
            if (request.magnetic_element_mask[static_cast<std::size_t>(element)] == 0u) {
                continue;
            }
            mfem::Array<int> dofs;
            request.scalar_space->GetElementDofs(element, dofs);
            const mfem::FiniteElement *finite_element = request.scalar_space->GetFE(element);
            mfem::ElementTransformation *transformation =
                mesh->GetElementTransformation(element);
            const mfem::IntegrationRule &rule =
                mfem::IntRules.Get(finite_element->GetGeomType(), 4);
            for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
                const mfem::IntegrationPoint &point = rule.IntPoint(point_index);
                transformation->SetIntPoint(&point);
                mfem::Vector shape(dofs.Size());
                mfem::DenseMatrix physical_dshape(dofs.Size(), 3);
                finite_element->CalcShape(point, shape);
                finite_element->CalcPhysDShape(*transformation, physical_dshape);
                const double weight = transformation->Weight() * point.weight;
                double m0[3] = {0.0, 0.0, 0.0};
                double ms = 0.0;
                for (int local = 0; local < dofs.Size(); ++local) {
                    const std::uint64_t node = static_cast<std::uint64_t>(
                        dofs[local] >= 0 ? dofs[local] : -1 - dofs[local]);
                    for (int axis = 0; axis < 3; ++axis) {
                        m0[axis] += shape[local] * request.tangent_frames[node].m[axis];
                    }
                    ms += shape[local] * node_ms(request, node);
                }
                const double m0_norm = std::sqrt(
                    m0[0] * m0[0] + m0[1] * m0[1] + m0[2] * m0[2]);
                if (!finite_positive(m0_norm)) {
                    copy_error(out_result->error_message,
                               "shared-domain equilibrium interpolation is non-finite");
                    return out_result->status;
                }
                m0[0] /= m0_norm;
                m0[1] /= m0_norm;
                m0[2] /= m0_norm;
                for (int local_test = 0; local_test < dofs.Size(); ++local_test) {
                    const std::uint64_t test_node = static_cast<std::uint64_t>(
                        dofs[local_test] >= 0 ? dofs[local_test] : -1 - dofs[local_test]);
                    const double test_sign = dofs[local_test] >= 0 ? 1.0 : -1.0;
                    for (int local_trial = 0; local_trial < dofs.Size(); ++local_trial) {
                        const std::uint64_t trial_node = static_cast<std::uint64_t>(
                            dofs[local_trial] >= 0 ? dofs[local_trial] : -1 - dofs[local_trial]);
                        const double trial_sign = dofs[local_trial] >= 0 ? 1.0 : -1.0;
                        double grad_test[3] = {
                            physical_dshape(local_test, 0),
                            physical_dshape(local_test, 1),
                            physical_dshape(local_test, 2)};
                        double grad_trial[3] = {
                            physical_dshape(local_trial, 0),
                            physical_dshape(local_trial, 1),
                            physical_dshape(local_trial, 2)};
                        double h_phi[3] = {
                            -grad_trial[0], -grad_trial[1], -grad_trial[2]};
                        double m_cross_h[3] = {
                            m0[1] * h_phi[2] - m0[2] * h_phi[1],
                            m0[2] * h_phi[0] - m0[0] * h_phi[2],
                            m0[0] * h_phi[1] - m0[1] * h_phi[0]};
                        double torque[3] = {
                            -request.gamma0_m_per_a_s * m_cross_h[0],
                            -request.gamma0_m_per_a_s * m_cross_h[1],
                            -request.gamma0_m_per_a_s * m_cross_h[2]};
                        for (std::uint32_t component = 0; component < 2u; ++component) {
                            const double *test_frame = component == 0u
                                ? request.tangent_frames[test_node].e1
                                : request.tangent_frames[test_node].e2;
                            const double *trial_frame = component == 0u
                                ? request.tangent_frames[trial_node].e1
                                : request.tangent_frames[trial_node].e2;
                            const double source_projection =
                                trial_frame[0] * grad_test[0] +
                                trial_frame[1] * grad_test[1] +
                                trial_frame[2] * grad_test[2];
                            a_phiq_full.add(
                                test_node,
                                2u * trial_node + component,
                                -test_sign * trial_sign * ms * shape[local_trial] *
                                    source_projection * weight);
                            const double torque_projection =
                                // The magnetic row is the energy-Hessian
                                // test represented in the frequency
                                // dictionary: v_h = -m0 x (T p).  The
                                // torque already contains -gamma0 m0 x
                                // delta_h, so the two rotations cancel and
                                // leave the reciprocal scalar-field Hessian.
                                (-(m0[1] * test_frame[2] - m0[2] * test_frame[1])) * torque[0] +
                                (-(m0[2] * test_frame[0] - m0[0] * test_frame[2])) * torque[1] +
                                (-(m0[0] * test_frame[1] - m0[1] * test_frame[0])) * torque[2];
                            a_qphi_full.add(
                                2u * test_node + component,
                                trial_node,
                                -test_sign * trial_sign * shape[local_test] *
                                    (request.mu0_T_m_A * ms / request.gamma0_m_per_a_s) *
                                    torque_projection * weight);
                        }
                        // Assemble all four tangent-component entries.  The
                        // gyrotropic block is skew-symmetric only after the
                        // complete component pair is included.
                        for (std::uint32_t row_component = 0; row_component < 2u; ++row_component) {
                            for (std::uint32_t column_component = 0; column_component < 2u; ++column_component) {
                                const double *row_frame = row_component == 0u
                                    ? request.tangent_frames[test_node].e1
                                    : request.tangent_frames[test_node].e2;
                                const double *column_frame = column_component == 0u
                                    ? request.tangent_frames[trial_node].e1
                                    : request.tangent_frames[trial_node].e2;
                                const double cross_value[3] = {
                                    m0[1] * column_frame[2] - m0[2] * column_frame[1],
                                    m0[2] * column_frame[0] - m0[0] * column_frame[2],
                                    m0[0] * column_frame[1] - m0[1] * column_frame[0]};
                                const double gyrotropic =
                                    row_frame[0] * cross_value[0] +
                                    row_frame[1] * cross_value[1] +
                                    row_frame[2] * cross_value[2];
                                b_qq_full.add(
                                    2u * test_node + row_component,
                                    2u * trial_node + column_component,
                                    -test_sign * trial_sign * shape[local_test] *
                                        shape[local_trial] *
                                        (request.mu0_T_m_A * ms / request.gamma0_m_per_a_s) *
                                        gyrotropic * weight);
                            }
                        }
                    }
                }
            }
        }

        SparseAccumulator a_phiq_reduced(
            request.scalar_reduced_node_count,
            2u * request.magnetic_reduced_node_count);
        SparseAccumulator a_qphi_reduced(
            2u * request.magnetic_reduced_node_count,
            request.scalar_reduced_node_count);
        SparseAccumulator b_qq_reduced(
            2u * request.magnetic_reduced_node_count,
            2u * request.magnetic_reduced_node_count);
        add_csr_rectangular(
            a_phiq_full,
            request.scalar_reduced_node,
            request.magnetic_reduced_node,
            1u,
            2u,
            a_phiq_reduced);
        add_csr_rectangular(
            a_qphi_full,
            request.magnetic_reduced_node,
            request.scalar_reduced_node,
            2u,
            1u,
            a_qphi_reduced);
        add_csr_rectangular(
            b_qq_full,
            request.magnetic_reduced_node,
            request.magnetic_reduced_node,
            2u,
            2u,
            b_qq_reduced);
        a_phiq_reduced.finish(out_result->a_phiq);
        a_qphi_reduced.finish(out_result->a_qphi);
        b_qq_reduced.finish(out_result->b_qq);

        if (request.boundary_kind == PoissonAirboxBoundaryKind::pure_neumann) {
            mfem::ConstantCoefficient one(1.0);
            mfem::LinearForm mean_form(request.scalar_space);
            mean_form.AddDomainIntegrator(new mfem::DomainLFIntegrator(one));
            mean_form.Assemble();
            out_result->phi_mean_weights.assign(
                static_cast<std::size_t>(request.scalar_reduced_node_count), 0.0);
            for (std::uint64_t node = 0; node < node_count; ++node) {
                out_result->phi_mean_weights[
                    request.scalar_reduced_node[node]] += mean_form[static_cast<int>(node)];
            }
            long double weight_sum = 0.0L;
            for (double weight : out_result->phi_mean_weights) {
                if (!finite_positive(weight)) {
                    copy_error(out_result->error_message,
                               "pure-Neumann shared-domain gauge weights must be finite and positive");
                    return out_result->status;
                }
                weight_sum += static_cast<long double>(weight);
            }
            if (!(weight_sum > 0.0L) || !std::isfinite(static_cast<double>(weight_sum))) {
                copy_error(out_result->error_message,
                           "pure-Neumann shared-domain gauge weights have zero or non-finite measure");
                return out_result->status;
            }
            const double inverse_weight_sum = 1.0 / static_cast<double>(weight_sum);
            for (double &weight : out_result->phi_mean_weights) {
                weight *= inverse_weight_sum;
            }
        } else if (request.boundary_kind == PoissonAirboxBoundaryKind::dirichlet) {
            std::set<std::uint32_t> reduced_dofs;
            for (int index = 0; index < essential.Size(); ++index) {
                reduced_dofs.insert(request.scalar_reduced_node[
                    static_cast<std::size_t>(essential[index])]);
            }
            out_result->dirichlet_dofs.assign(reduced_dofs.begin(), reduced_dofs.end());
            eliminate_rows_and_columns(
                out_result->a_phiq,
                reduced_dofs,
                {});
            eliminate_rows_and_columns(
                out_result->a_qphi,
                {},
                reduced_dofs);
        }

        const char *boundary = request.boundary_kind == PoissonAirboxBoundaryKind::robin
            ? "poisson_robin"
            : request.boundary_kind == PoissonAirboxBoundaryKind::dirichlet
                ? "poisson_dirichlet"
                : "pure_neumann";
        const char *gauge = request.boundary_kind == PoissonAirboxBoundaryKind::pure_neumann
            ? "mean_zero_augmented"
            : "none";
        std::strncpy(out_result->boundary_kind, boundary, sizeof(out_result->boundary_kind) - 1u);
        std::strncpy(out_result->gauge_policy, gauge, sizeof(out_result->gauge_policy) - 1u);
        std::strncpy(out_result->assembly_kind, "mfem_weak_form_shared_domain",
                     sizeof(out_result->assembly_kind) - 1u);

        CanonicalDigestBuilder digest("poisson_airbox_shared_domain.assembly.v1");
        digest.add_u64("full_phi_dof_count", node_count);
        digest.add_u64("full_q_dof_count", full_q_count);
        digest.add_u64("phi_dof_count", request.scalar_reduced_node_count);
        digest.add_u64("q_dof_count", 2u * request.magnetic_reduced_node_count);
        digest.add_string("boundary_kind", boundary);
        digest.add_string("gauge_policy", gauge);
        digest.add_double("robin_beta", request.robin_beta);
        digest.add_double("gamma0_m_per_a_s", request.gamma0_m_per_a_s);
        digest.add_double("mu0_T_m_A", request.mu0_T_m_A);
        for (std::uint64_t node = 0; node < node_count; ++node) {
            digest.add_u64("scalar_class[" + std::to_string(node) + "]",
                           request.scalar_reduced_node[node]);
            digest.add_u64("magnetic_class[" + std::to_string(node) + "]",
                           request.magnetic_reduced_node[node]);
            digest.add_double("Ms[" + std::to_string(node) + "]", node_ms(request, node));
            for (int axis = 0; axis < 3; ++axis) {
                digest.add_double("m[" + std::to_string(node) + "][" + std::to_string(axis) + "]",
                                  request.tangent_frames[node].m[axis]);
            }
        }
        add_digest_matrix(digest, "A_qq", out_result->a_qq);
        add_digest_matrix(digest, "A_qphi", out_result->a_qphi);
        add_digest_matrix(digest, "A_phiq", out_result->a_phiq);
        add_digest_matrix(digest, "P", out_result->p);
        add_digest_matrix(digest, "B_qq", out_result->b_qq);
        const std::string hex = digest.sha256_hex();
        std::strncpy(out_result->operator_digest, hex.c_str(), sizeof(out_result->operator_digest) - 1u);

        out_result->full_q_dof_count = full_q_count;
        out_result->full_phi_dof_count = node_count;
        out_result->q_dof_count = 2u * request.magnetic_reduced_node_count;
        out_result->phi_dof_count = request.scalar_reduced_node_count;
        out_result->status = FrequencyDomainStatus::ok;
        return out_result->status;
    } catch (const std::exception &exception) {
        copy_error(out_result->error_message, exception.what());
    } catch (...) {
        copy_error(out_result->error_message, "shared-domain MFEM assembly failed");
    }
    out_result->status = FrequencyDomainStatus::operator_error;
    return out_result->status;
}

FrequencyDomainStatus assemble_poisson_airbox_shared_domain_payload(
    const FullmagFemModalSharedDomainPayload &payload,
    PoissonAirboxSharedDomainAssemblyResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxSharedDomainAssemblyResult{};
    out_result->status = FrequencyDomainStatus::validation_error;
    try {
        constexpr std::size_t kV16PayloadSize =
            offsetof(FullmagFemModalSharedDomainPayload, airbox_part_identity) +
            sizeof(payload.airbox_part_identity);
        constexpr std::size_t kV19PayloadSize =
            offsetof(FullmagFemModalSharedDomainPayload, acceptance_certificate_sha256) +
            sizeof(payload.acceptance_certificate_sha256);
        if (payload.abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION ||
            payload.struct_size < kV19PayloadSize) {
            copy_error(out_result->error_message,
                       "shared-domain native importer requires a full v19 acceptance-certificate prefix");
            return out_result->status;
        }
        if (payload.linearization_descriptor == nullptr) {
            copy_error(out_result->error_message, "linearization_descriptor_missing");
            return out_result->status;
        }
        if (payload.abi_version < FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION ||
            payload.abi_version > FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION ||
            payload.struct_size < kV16PayloadSize ||
            payload.mesh == nullptr || payload.equilibrium_m0_xyz == nullptr ||
            payload.equilibrium_m0_xyz_count == 0u ||
            payload.scalar_reduced_node == nullptr ||
            payload.magnetic_reduced_node == nullptr ||
            payload.scalar_reduced_node_count == 0u ||
            payload.magnetic_reduced_node_count == 0u ||
            payload.magnetic_pair_count == 0u || payload.airbox_pair_count == 0u ||
            payload.boundary_kind == nullptr || payload.boundary_kind[0] == '\0' ||
            payload.equilibrium_digest == nullptr || payload.equilibrium_digest[0] == '\0' ||
            payload.mesh_certificate_digest == nullptr || payload.mesh_certificate_digest[0] == '\0' ||
            payload.mesh_certificate_schema == nullptr ||
            payload.linearization_state_digest == nullptr ||
            payload.linearization_state_digest[0] == '\0' ||
            payload.linearization_m0_xyz == nullptr ||
            payload.linearization_m0_xyz_count == 0u ||
            payload.linearization_h_eff0_xyz == nullptr ||
            payload.linearization_h_eff0_xyz_count == 0u ||
            payload.linearization_h_demag0_xyz == nullptr ||
            payload.linearization_h_demag0_xyz_count == 0u ||
            payload.linearization_phi0 == nullptr ||
            payload.linearization_phi0_count == 0u ||
            payload.equilibrium_id == nullptr || payload.equilibrium_id[0] == '\0' ||
            payload.mesh_snapshot_id == nullptr || payload.mesh_snapshot_id[0] == '\0' ||
            payload.material_snapshot_id == nullptr || payload.material_snapshot_id[0] == '\0' ||
            payload.physics_snapshot_id == nullptr || payload.physics_snapshot_id[0] == '\0' ||
            payload.boundary_snapshot_id == nullptr || payload.boundary_snapshot_id[0] == '\0' ||
            payload.producer_run_id == nullptr || payload.producer_run_id[0] == '\0' ||
            payload.equilibrium_content_sha256 == nullptr ||
            payload.equilibrium_content_sha256[0] == '\0' ||
            payload.demag_model == nullptr || payload.demag_model[0] == '\0' ||
            payload.magnetic_part_identity == nullptr ||
            payload.magnetic_part_identity[0] == '\0' ||
            payload.airbox_part_identity == nullptr ||
            payload.airbox_part_identity[0] == '\0' ||
            !std::isfinite(payload.m0_norm_tolerance) || payload.m0_norm_tolerance < 0.0 ||
            std::strcmp(payload.mesh_certificate_schema, "periodic_mesh_certificate.v6") != 0) {
            copy_error(out_result->error_message,
                       "shared-domain modal payload is incomplete or uses an unsupported certificate");
            return out_result->status;
        }
        fullmag::fem::FemMeshRuntimeState source{};
        std::string error;
        if (!import_modal_shared_domain_mesh(*payload.mesh, source, error)) {
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        const std::uint64_t node_count = source.n_nodes;
        if (payload.equilibrium_m0_xyz_count != 3u * node_count ||
            payload.scalar_reduced_node_count > node_count ||
            payload.magnetic_reduced_node_count > node_count) {
            copy_error(out_result->error_message,
                       "shared-domain modal payload cardinalities do not match the mesh");
            return out_result->status;
        }
        if (payload.linearization_m0_xyz_count != 3u * node_count ||
            payload.linearization_h_eff0_xyz_count != 3u * node_count ||
            payload.linearization_h_demag0_xyz_count != 3u * node_count ||
            payload.linearization_phi0_count != node_count) {
            copy_error(out_result->error_message,
                       "shared-domain linearization fields have inconsistent cardinalities");
            return out_result->status;
        }
        std::vector<double> saturation_magnetization;
        if (payload.saturation_magnetisation_a_per_m != nullptr) {
            if (payload.saturation_magnetisation_count != node_count ||
                !copy_payload_span(payload.saturation_magnetisation_a_per_m,
                                   payload.saturation_magnetisation_count,
                                   saturation_magnetization,
                                   error,
                                   "saturation_magnetisation_a_per_m")) {
                copy_error(out_result->error_message, error.c_str());
                return out_result->status;
            }
        }
        if (source.cell_markers.size() != source.n_elements) {
            copy_error(out_result->error_message,
                       source.cell_markers.empty()
                           ? "shared-domain payload is missing the magnetic/airbox cell marker map"
                           : "shared-domain payload cell marker count does not match the mesh");
            return out_result->status;
        }
        bool has_magnetic_elements = false;
        bool has_airbox_elements = false;
        std::vector<std::uint8_t> magnetic_element_mask(source.n_elements, 0u);
        for (std::size_t index = 0; index < source.cell_markers.size(); ++index) {
            const std::uint32_t marker = source.cell_markers[index];
            if (marker > 1u) {
                copy_error(out_result->error_message,
                           "shared-domain payload uses an unknown magnetic/airbox cell marker");
                return out_result->status;
            }
            magnetic_element_mask[index] = marker == 1u ? 1u : 0u;
            has_magnetic_elements = has_magnetic_elements || marker == 1u;
            has_airbox_elements = has_airbox_elements || marker == 0u;
        }
        if (!has_magnetic_elements || !has_airbox_elements) {
            copy_error(out_result->error_message,
                       "shared-domain payload requires both magnetic and airbox cell regions");
            return out_result->status;
        }
        ModalSharedDomainValidationResult validation_result{};
        char payload_contract_error[256]{};
        if (validate_modal_shared_domain_payload_contract(
                payload, node_count, &validation_result, payload_contract_error) !=
            FrequencyDomainStatus::ok) {
            copy_error(out_result->error_message, payload_contract_error);
            return out_result->status;
        }
        std::unique_ptr<mfem::Mesh> mesh;
        if (!fullmag::fem::build_mfem_mesh(source, mesh, error)) {
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        mfem::H1_FECollection collection(1, mesh->Dimension());
        mfem::FiniteElementSpace scalar_space(mesh.get(), &collection);
        std::vector<std::uint8_t> magnetic_node_mask(static_cast<std::size_t>(node_count), 0u);
        for (std::uint32_t element = 0; element < source.n_elements; ++element) {
            if (magnetic_element_mask[element] == 0u) {
                continue;
            }
            const std::uint32_t begin = source.cell_offsets[element];
            const std::uint32_t end = source.cell_offsets[element + 1u];
            for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                magnetic_node_mask[source.cell_nodes[cursor]] = 1u;
            }
        }
        const std::uint64_t magnetic_node_count = static_cast<std::uint64_t>(std::count(
            magnetic_node_mask.begin(), magnetic_node_mask.end(), static_cast<std::uint8_t>(1u)));
        if (payload.linearization_descriptor == nullptr ||
            payload.linearization_descriptor->node_count != node_count ||
            payload.linearization_descriptor->equilibrium_m0_xyz == nullptr ||
            payload.linearization_descriptor->equilibrium_m0_xyz_count != 3u * node_count ||
            payload.linearization_descriptor->effective_field_h_eff0_xyz == nullptr ||
            payload.linearization_descriptor->effective_field_h_eff0_xyz_count != 3u * node_count) {
            copy_error(out_result->error_message,
                       "linearization_descriptor_payload_state_dimensions_invalid");
            return out_result->status;
        }
        char descriptor_contract_error[256]{};
        if (validate_linearization_descriptor_common(
                *payload.linearization_descriptor,
                node_count,
                descriptor_contract_error) != FrequencyDomainStatus::ok) {
            copy_error(out_result->error_message, descriptor_contract_error);
            return out_result->status;
        }
        for (std::uint64_t index = 0u; index < 3u * node_count; ++index) {
            if (payload.linearization_descriptor->equilibrium_m0_xyz[index] !=
                payload.equilibrium_m0_xyz[index]) {
                copy_error(out_result->error_message,
                           "linearization_descriptor_full_equilibrium_mismatch");
                return out_result->status;
            }
            if (payload.linearization_descriptor->equilibrium_m0_xyz[index] !=
                    payload.linearization_m0_xyz[index] ||
                payload.linearization_descriptor->effective_field_h_eff0_xyz[index] !=
                    payload.linearization_h_eff0_xyz[index]) {
                copy_error(out_result->error_message,
                           "linearization_descriptor_payload_state_mismatch");
                return out_result->status;
            }
        }
        std::vector<TangentFrameNode> tangent_frames;
        char descriptor_frame_error[256]{};
        if (materialize_descriptor_tangent_frames(
                *payload.linearization_descriptor,
                node_count,
                tangent_frames,
                descriptor_frame_error) != FrequencyDomainStatus::ok) {
            copy_error(out_result->error_message, descriptor_frame_error);
            return out_result->status;
        }
        std::vector<double> linearization_m0_x(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_m0_y(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_m0_z(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_h_eff0_x(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_h_eff0_y(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_h_eff0_z(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_h_demag0_x(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_h_demag0_y(
            static_cast<std::size_t>(magnetic_node_count));
        std::vector<double> linearization_h_demag0_z(
            static_cast<std::size_t>(magnetic_node_count));
        std::uint64_t linearization_node = 0u;
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            if (magnetic_node_mask[static_cast<std::size_t>(node)] == 0u) {
                continue;
            }
            const std::size_t source_offset = static_cast<std::size_t>(3u * node);
            const std::size_t destination = static_cast<std::size_t>(linearization_node);
            linearization_m0_x[destination] = payload.linearization_m0_xyz[source_offset];
            linearization_m0_y[destination] = payload.linearization_m0_xyz[source_offset + 1u];
            linearization_m0_z[destination] = payload.linearization_m0_xyz[source_offset + 2u];
            linearization_h_eff0_x[destination] = payload.linearization_h_eff0_xyz[source_offset];
            linearization_h_eff0_y[destination] = payload.linearization_h_eff0_xyz[source_offset + 1u];
            linearization_h_eff0_z[destination] = payload.linearization_h_eff0_xyz[source_offset + 2u];
            linearization_h_demag0_x[destination] = payload.linearization_h_demag0_xyz[source_offset];
            linearization_h_demag0_y[destination] = payload.linearization_h_demag0_xyz[source_offset + 1u];
            linearization_h_demag0_z[destination] = payload.linearization_h_demag0_xyz[source_offset + 2u];
            ++linearization_node;
        }
        EquilibriumArtifactDescriptor equilibrium_artifact{};
        equilibrium_artifact.equilibrium_id = payload.equilibrium_id;
        equilibrium_artifact.mesh_snapshot_id = payload.mesh_snapshot_id;
        equilibrium_artifact.material_snapshot_id = payload.material_snapshot_id;
        equilibrium_artifact.physics_snapshot_id = payload.physics_snapshot_id;
        equilibrium_artifact.boundary_snapshot_id = payload.boundary_snapshot_id;
        equilibrium_artifact.producer_run_id = payload.producer_run_id;
        equilibrium_artifact.content_sha256 = payload.equilibrium_content_sha256;
        equilibrium_artifact.m0_unit = CartesianVectorFieldView{
            linearization_m0_x.data(),
            linearization_m0_y.data(),
            linearization_m0_z.data(),
            magnetic_node_count};
        equilibrium_artifact.h_eff0_a_per_m = CartesianVectorFieldView{
            linearization_h_eff0_x.data(),
            linearization_h_eff0_y.data(),
            linearization_h_eff0_z.data(),
            magnetic_node_count};
        equilibrium_artifact.h_demag0_a_per_m = CartesianVectorFieldView{
            linearization_h_demag0_x.data(),
            linearization_h_demag0_y.data(),
            linearization_h_demag0_z.data(),
            magnetic_node_count};
        equilibrium_artifact.phi0 = payload.linearization_phi0;
        equilibrium_artifact.magnetic_node_count = magnetic_node_count;
        equilibrium_artifact.airbox_node_count = payload.linearization_phi0_count;
        equilibrium_artifact.accepted_for_linearization = true;
        equilibrium_artifact.acceptance = {
            payload.acceptance_criterion,
            payload.acceptance_metric_kind,
            payload.acceptance_unit,
            payload.acceptance_metric_value,
            payload.acceptance_threshold,
            payload.acceptance_certificate_sha256};
        equilibrium_artifact.demag_model = payload.demag_model;
        LinearizationBuildOptions linearization_options{};
        linearization_options.m0_norm_tolerance = payload.m0_norm_tolerance;
        linearization_options.allow_m0_renormalization = false;
        LinearizationStateNative linearization_state{};
        LinearizationDiagnostics linearization_diagnostics{};
        const FrequencyDomainStatus linearization_status =
            build_linearization_state_from_equilibrium(
                equilibrium_artifact,
                linearization_options,
                linearization_state,
                linearization_diagnostics);
        if (linearization_status != FrequencyDomainStatus::ok) {
            std::string message = "shared-domain equilibrium linearization rejected";
            if (linearization_diagnostics.reject_reason[0] != '\0') {
                message += ": ";
                message += linearization_diagnostics.reject_reason;
            }
            if (linearization_diagnostics.error_message[0] != '\0') {
                message += " (";
                message += linearization_diagnostics.error_message;
                message += ')';
            }
            copy_error(out_result->error_message, message.c_str());
            return out_result->status;
        }
        mfem::Array<int> boundary_marker;
        if (std::strcmp(payload.boundary_kind, "pure_neumann") != 0) {
            if (payload.boundary_marker == 0u ||
                payload.boundary_marker > static_cast<std::uint32_t>(std::numeric_limits<int>::max())) {
                copy_error(out_result->error_message,
                           "shared-domain Robin/Dirichlet payload requires a positive boundary marker");
                return out_result->status;
            }
            const int maximum_marker = std::max(1, mesh->bdr_attributes.Max());
            if (payload.boundary_marker > static_cast<std::uint32_t>(maximum_marker)) {
                copy_error(out_result->error_message,
                           "shared-domain payload boundary marker is absent from the MFEM mesh");
                return out_result->status;
            }
            boundary_marker.SetSize(maximum_marker);
            boundary_marker = 0;
            boundary_marker[static_cast<int>(payload.boundary_marker) - 1] = 1;
            for (const std::uint32_t periodic_marker : source.periodic_boundary_marker_set) {
                if (periodic_marker >= 1u && periodic_marker <= static_cast<std::uint32_t>(maximum_marker)) {
                    boundary_marker[static_cast<int>(periodic_marker) - 1] = 0;
                }
            }
        }
        PoissonAirboxBoundaryKind boundary_kind;
        if (std::strcmp(payload.boundary_kind, "robin") == 0) {
            boundary_kind = PoissonAirboxBoundaryKind::robin;
        } else if (std::strcmp(payload.boundary_kind, "dirichlet") == 0) {
            boundary_kind = PoissonAirboxBoundaryKind::dirichlet;
        } else if (std::strcmp(payload.boundary_kind, "pure_neumann") == 0) {
            boundary_kind = PoissonAirboxBoundaryKind::pure_neumann;
        } else {
            copy_error(out_result->error_message,
                       "shared-domain payload uses an unknown boundary kind");
            return out_result->status;
        }
        if ((payload.linearization_descriptor->term_presence_mask &
             FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE) != 0u &&
            payload.exchange_material_view == nullptr) {
            copy_error(out_result->error_message,
                       "linearization_descriptor_exchange_material_missing");
            return out_result->status;
        }
        PoissonAirboxSharedDomainAssemblyRequest request{};
        request.scalar_space = &scalar_space;
        request.tangent_frames = tangent_frames.data();
        request.tangent_frame_count = node_count;
        request.magnetic_element_mask = magnetic_element_mask.data();
        request.magnetic_element_count = magnetic_element_mask.size();
        request.saturation_magnetization_a_per_m = saturation_magnetization.empty()
            ? nullptr
            : saturation_magnetization.data();
        request.saturation_magnetization_count = saturation_magnetization.size();
        request.uniform_saturation_magnetization_a_per_m =
            payload.uniform_saturation_magnetisation_a_per_m;
        request.gamma0_m_per_a_s = payload.gamma0_m_per_a_s;
        request.mu0_T_m_A = 1.25663706212e-6;
        PoissonAirboxSharedDomainCsrMatrix native_magnetic_a_qq{};
        char native_error[256]{};
        const double accepted_max_transverse_field_a_per_m =
            std::strcmp(payload.acceptance_criterion, "torque") == 0 &&
                std::strcmp(payload.acceptance_metric_kind, "max_torque_apm") == 0 &&
                std::strcmp(payload.acceptance_unit, "A/m") == 0
            ? payload.acceptance_threshold
            : -1.0;
        const FrequencyDomainStatus native_status =
            assemble_native_magnetic_a_qq(
                *payload.linearization_descriptor,
                &scalar_space,
                magnetic_element_mask.data(),
                magnetic_element_mask.size(),
                &native_magnetic_a_qq,
                native_error,
                payload.exchange_material_view,
                tangent_frames.data(),
                tangent_frames.size(),
                accepted_max_transverse_field_a_per_m);
        if (native_status != FrequencyDomainStatus::ok) {
            copy_error(out_result->error_message, native_error);
            out_result->status = native_status;
            return native_status;
        }
        CsrMatrixView magnetic_a_qq = native_magnetic_a_qq.view();
        request.magnetic_a_qq_csr = &magnetic_a_qq;
        request.scalar_reduced_node = payload.scalar_reduced_node;
        request.scalar_reduced_node_count = payload.scalar_reduced_node_count;
        request.magnetic_reduced_node = payload.magnetic_reduced_node;
        request.magnetic_reduced_node_count = payload.magnetic_reduced_node_count;
        request.equivalence_classes_complete = true;
        request.boundary_kind = boundary_kind;
        request.robin_beta = payload.robin_beta;
        request.robin_boundary_marker = boundary_marker.Size() > 0 ? &boundary_marker : nullptr;
        return assemble_poisson_airbox_shared_domain(request, out_result);
    } catch (const std::exception &exception) {
        copy_error(out_result->error_message, exception.what());
    } catch (...) {
        copy_error(out_result->error_message, "shared-domain modal payload import failed");
    }
    out_result->status = FrequencyDomainStatus::operator_error;
    return out_result->status;
}

} // namespace fullmag::fem::frequency_domain

#endif
