#include "cpu/frequency_domain/mfem_modal_operator_payload.hpp"
#include "cpu/frequency_domain/contour_interval_solver.hpp"
#include "cpu/frequency_domain/floquet_airbox_operator.hpp"
#include "cpu/frequency_domain/modal_shared_domain_provider_status.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
#include "frequency_domain/linearized_dynamic_pencil.hpp"
#include "frequency_domain/linearization_state.hpp"
#include "frequency_domain/floquet_dynamic_demag_k.hpp"
#include "frequency_domain/mesh_symmetry_certificate.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"
#include "frequency_domain/nonfinite_json_sanitizer.hpp"
#include "frequency_domain/canonical_digest.hpp"
#include "context.hpp"
#include "core/fem_mesh.hpp"
#include "cpu/mfem/interactions/demag_poisson_lifecycle.hpp"
#include "cpu/mfem/interactions/demag_poisson_solve.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>


namespace {

namespace fd = fullmag::fem::frequency_domain;

static_assert(
    std::is_same<decltype(FullmagFemModalEigenRequest::spectral_transform_kind),
                 fullmag_fem_modal_spectral_transform_kind>::value,
    "modal request spectral_transform_kind preserves the named enum ABI field");
static_assert(
    std::is_same<decltype(FullmagFemFrequencyDomainResult::resolved_spectral_transform_kind),
                 fullmag_fem_modal_spectral_transform_kind>::value,
    "modal result resolved_spectral_transform_kind preserves the named enum ABI field");
static_assert(
    std::is_same<decltype(FullmagFemFrequencyDomainResult::resolved_certificate_binding_status),
                 std::uint32_t>::value,
    "modal result certificate binding status is a uint32_t ABI field");

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void modal_shared_domain_provider_terminal_status_fails_closed()
{
    constexpr std::array<fd::FrequencyDomainStatus, 6> provider_failures = {
        fd::FrequencyDomainStatus::unavailable,
        fd::FrequencyDomainStatus::validation_error,
        fd::FrequencyDomainStatus::operator_error,
        fd::FrequencyDomainStatus::solve_error,
        fd::FrequencyDomainStatus::artifact_error,
        fd::FrequencyDomainStatus::interrupted};
    for (fd::FrequencyDomainStatus provider_status : provider_failures) {
        check(
            fd::resolve_shared_domain_provider_terminal_status(
                provider_status, true) == provider_status,
            "shared-domain provider terminal transition preserves each non-ok status");
        check(
            fd::resolve_shared_domain_provider_terminal_status(
                provider_status, false) == provider_status,
            "shared-domain provider failure status takes precedence over missing output");
    }
    check(
        fd::resolve_shared_domain_provider_terminal_status(
            fd::FrequencyDomainStatus::ok, true) == fd::FrequencyDomainStatus::ok,
        "shared-domain provider accepts complete successful output");
    check(
        fd::resolve_shared_domain_provider_terminal_status(
            fd::FrequencyDomainStatus::ok, false) ==
            fd::FrequencyDomainStatus::operator_error,
        "shared-domain provider success without required output fails closed");
}

void nonfinite_json_sanitizer_has_bounded_fail_closed_semantics()
{
    constexpr char input[] = R"json({"nan_key":"nan inf -nan -inf",
        "escaped \"nan\" key":"value has \"inf\" and nan",
        "plain_nan":nan,"negative_nan":-nan,
        "positive_inf":inf,"negative_inf":-inf,
        "partial":"infinity nanometer xinf"})json";
    constexpr char expected[] = R"json({"nan_key":"nan inf -nan -inf",
        "escaped \"nan\" key":"value has \"inf\" and nan",
        "plain_nan":null,"negative_nan":null,
        "positive_inf":null,"negative_inf":null,
        "partial":"infinity nanometer xinf"})json";
    std::array<char, sizeof(input) + 8u> buffer{};
    std::memcpy(buffer.data(), input, sizeof(input));
    check(
        fd::sanitize_nonfinite_json(buffer.data(), buffer.size()),
        "bounded nonfinite JSON sanitizer accepts sufficient capacity");
    check(
        std::strcmp(buffer.data(), expected) == 0,
        "bounded nonfinite JSON sanitizer preserves quoted bytes and rewrites only value tokens");

    char partial_tokens[] = "nanometer infix xnan";
    check(
        fd::sanitize_nonfinite_json(partial_tokens, sizeof(partial_tokens)),
        "bounded nonfinite JSON sanitizer accepts terminated text");
    check(
        std::strcmp(partial_tokens, "nanometer infix xnan") == 0,
        "bounded nonfinite JSON sanitizer requires complete token boundaries");

    char exact_capacity[] = "{\"value\":inf}";
    char exact_capacity_before[sizeof(exact_capacity)]{};
    std::memcpy(exact_capacity_before, exact_capacity, sizeof(exact_capacity));
    check(
        !fd::sanitize_nonfinite_json(exact_capacity, sizeof(exact_capacity)),
        "bounded nonfinite JSON sanitizer rejects expansion without spare capacity");
    check(
        std::memcmp(exact_capacity, exact_capacity_before, sizeof(exact_capacity)) == 0,
        "capacity failure leaves JSON bytes unchanged instead of substituting zero");

    std::array<char, sizeof(exact_capacity) + 1u> spare_capacity{};
    std::memcpy(spare_capacity.data(), exact_capacity_before, sizeof(exact_capacity));
    check(
        fd::sanitize_nonfinite_json(spare_capacity.data(), spare_capacity.size()),
        "bounded nonfinite JSON sanitizer uses available expansion capacity");
    check(
        std::strcmp(spare_capacity.data(), "{\"value\":null}") == 0,
        "bounded nonfinite JSON sanitizer emits null for a complete token");

    char unterminated[] = {'n', 'a', 'n'};
    const char unterminated_before[] = {'n', 'a', 'n'};
    check(
        !fd::sanitize_nonfinite_json(unterminated, sizeof(unterminated)),
        "bounded nonfinite JSON sanitizer rejects missing terminator");
    check(
        std::memcmp(unterminated, unterminated_before, sizeof(unterminated)) == 0,
        "unterminated buffer remains unchanged");
    char malformed_quoted_json[] = "{\"text\":\"nan";
    char malformed_quoted_json_before[sizeof(malformed_quoted_json)]{};
    std::memcpy(
        malformed_quoted_json_before,
        malformed_quoted_json,
        sizeof(malformed_quoted_json));
    check(
        !fd::sanitize_nonfinite_json(
            malformed_quoted_json,
            sizeof(malformed_quoted_json)),
        "bounded nonfinite JSON sanitizer rejects an unterminated quoted string");
    check(
        std::memcmp(
            malformed_quoted_json,
            malformed_quoted_json_before,
            sizeof(malformed_quoted_json)) == 0,
        "unterminated quoted buffer remains unchanged");
    check(
        !fd::sanitize_nonfinite_json(nullptr, 1u),
        "bounded nonfinite JSON sanitizer rejects a null pointer");

    std::printf("PASS: bounded nonfinite JSON sanitizer contract\n");
}

bool contains(const char *haystack, const char *needle)
{
    return haystack != nullptr && std::strstr(haystack, needle) != nullptr;
}

void print_shifted_ksp_failure_probe_if_present(std::string_view diagnostics)
{
    constexpr std::string_view key = "\"shifted_ksp_failure_probe\":";
    constexpr std::size_t maximum_printed_bytes = 4096u;
    const std::size_t key_position = diagnostics.find(key);
    if (key_position == std::string_view::npos) {
        return;
    }
    const std::size_t object_start = key_position + key.size();
    if (object_start >= diagnostics.size() || diagnostics[object_start] != '{') {
        return;
    }
    const std::size_t closing_brace = diagnostics.find('}', object_start);
    if (closing_brace == std::string_view::npos) {
        return;
    }
    const std::size_t object_size = closing_brace - object_start + 1u;
    const std::size_t printed_size = std::min(object_size, maximum_printed_bytes);
    std::fprintf(
        stderr,
        "INFO: shifted_ksp_failure_probe=%.*s\n",
        static_cast<int>(printed_size),
        diagnostics.data() + object_start);
}

std::size_t count_occurrences(const char *haystack, const char *needle)
{
    if (haystack == nullptr || needle == nullptr || needle[0] == '\0') {
        return 0u;
    }
    std::size_t count = 0u;
    const std::size_t needle_size = std::strlen(needle);
    for (const char *match = std::strstr(haystack, needle);
         match != nullptr;
         match = std::strstr(match + needle_size, needle)) {
        ++count;
    }
    return count;
}

std::string read_text(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(input.good(), "expected modal C ABI artifact file must be readable");
    return std::string(
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>());
}

struct CsrOwned {
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    FullmagFemCsrMatrixView view() const
    {
        return FullmagFemCsrMatrixView{
            rows,
            columns,
            row_offsets.data(),
            static_cast<std::uint64_t>(row_offsets.size()),
            column_indices.data(),
            static_cast<std::uint64_t>(column_indices.size()),
            values.data(),
            static_cast<std::uint64_t>(values.size())};
    }
};

CsrOwned dense_to_csr(
    std::uint64_t rows,
    std::uint64_t columns,
    const double *row_major_values)
{
    CsrOwned csr{};
    csr.rows = rows;
    csr.columns = columns;
    csr.row_offsets.reserve(static_cast<std::size_t>(rows + 1));
    csr.row_offsets.push_back(0);
    for (std::uint64_t row = 0; row < rows; ++row) {
        for (std::uint64_t column = 0; column < columns; ++column) {
            const double value =
                row_major_values[static_cast<std::size_t>(row * columns + column)];
            if (value != 0.0) {
                csr.column_indices.push_back(static_cast<std::uint32_t>(column));
                csr.values.push_back(value);
            }
        }
        csr.row_offsets.push_back(static_cast<std::uint32_t>(csr.values.size()));
    }
    return csr;
}

double extract_json_number(
    const char *json,
    const char *key,
    const char *test_context)
{
    check(json != nullptr, "JSON buffer must be present");
    const char *start = std::strstr(json, key);
    if (start == nullptr) {
        std::fprintf(
            stderr,
            "FAIL: JSON key must be present: test=%s key=%s\n",
            test_context,
            key);
        std::fprintf(stderr, "JSON prefix: %.2048s\n", json);
        std::exit(1);
    }
    start += std::strlen(key);
    char *end = nullptr;
    const double value = std::strtod(start, &end);
    check(end != start, "JSON numeric value must parse");
    return value;
}

char g_last_progress_json[2048]{};
int g_progress_event_count = 0;

void reset_progress_capture()
{
    g_last_progress_json[0] = '\0';
    g_progress_event_count = 0;
}

void capture_progress(void *, const char *progress_json)
{
    ++g_progress_event_count;
    if (progress_json == nullptr) {
        g_last_progress_json[0] = '\0';
        return;
    }
    std::snprintf(
        g_last_progress_json,
        sizeof(g_last_progress_json),
        "%s",
        progress_json);
}

int always_cancel(void *)
{
    return 1;
}

FullmagFemModalEigenRequest base_request()
{
    FullmagFemModalEigenRequest request{};
    request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.mesh_asset_id = "macrospin_validation";
    request.operator_request.equilibrium_source_kind = "provided";
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.alpha = 0.0;
    request.requested_mode_count = 1;
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 0.16;
    request.frequency_min_hz = 0.0;
    request.frequency_max_hz = 1.0;
    request.residual_tolerance = 1.0e-12;
    request.max_outer_iterations = 32;
    request.max_linear_iterations = 128;
    request.struct_size = sizeof(request);
    return request;
}

void modal_dependency_info_is_reported()
{
    fullmag_fem_frequency_domain_dependency_info dependency_info{};
    check(
        fullmag_fem_get_frequency_domain_dependency_info(&dependency_info) ==
            FULLMAG_FEM_OK,
        "frequency-domain dependency info query succeeds");
    check(
        contains(
            dependency_info.diagnostics_json,
            "modal_eigen_native_cpu_slepc_available"),
        "dependency diagnostics expose modal_eigen_native_cpu_slepc_available");
#if FULLMAG_FEM_WITH_SLEPC
    check(dependency_info.petsc_available == 1, "PETSc dependency is available");
    check(dependency_info.slepc_available == 1, "SLEPc dependency is available");
    check(
        dependency_info.modal_eigen_native_cpu_slepc_available == 1,
        "modal_eigen native CPU SLEPc capability is available");
    check(std::strlen(dependency_info.petsc_version) > 0, "PETSc version is populated");
    check(std::strlen(dependency_info.slepc_version) > 0, "SLEPc version is populated");
#else
    check(dependency_info.slepc_available == 0, "SLEPc dependency is not available");
    check(
        dependency_info.modal_eigen_native_cpu_slepc_available == 0,
        "modal_eigen native CPU SLEPc capability is unavailable");
#endif
}

void modal_invalid_abi_returns_validation_error()
{
    FullmagFemModalEigenRequest invalid{};
    invalid.abi_version = 999u;
    invalid.operator_request.abi_version = 0u;
    invalid.struct_size = 0u;
    FullmagFemFrequencyDomainResult invalid_result =
        fullmag_fem_modal_eigen_solve(&invalid);
    check(invalid_result.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION,
          "legacy by-value modal result remains frozen at result ABI v18");
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "invalid modal ABI must return validation_error");
    check(contains(invalid_result.diagnostics_json, "unknown_abi"),
          "unknown modal ABI is rejected before optional tail dereference");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    FullmagFemModalEigenRequest short_prefix{};
    short_prefix.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    short_prefix.struct_size =
        static_cast<std::uint64_t>(offsetof(FullmagFemModalEigenRequest, operator_request));
    short_prefix.operator_request.abi_version = 999u;
    FullmagFemFrequencyDomainResult short_result =
        fullmag_fem_modal_eigen_solve(&short_prefix);
    check(short_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "known modal ABI with a short prefix must return validation_error");
    check(contains(short_result.diagnostics_json, "struct_size_too_small"),
          "short modal prefix is rejected before reading the operator ABI tail");
    fullmag_fem_frequency_domain_result_destroy(&short_result);
}

void modal_v13_extension_rejects_unknown_enum_and_releases_zero_result()
{
    FullmagFemModalEigenRequest invalid = base_request();
    invalid.execution_target = static_cast<fullmag_fem_modal_execution_target>(99);
    FullmagFemFrequencyDomainResult invalid_result =
        fullmag_fem_modal_eigen_solve(&invalid);
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal v13 rejects an unknown execution target");
    check(invalid_result.resolved_execution_target ==
              FULLMAG_FEM_MODAL_EXECUTION_VALIDATION,
          "modal v13 rejects an unknown execution target with resolved validation provenance");
    check(invalid_result.resolved_scalar_representation ==
              FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE &&
              invalid_result.resolved_spectral_transform_kind ==
                  FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO,
          "modal v13 validation provenance has explicit scalar and transform defaults");
    check(contains(invalid_result.diagnostics_json, "unknown_execution_target"),
          "modal v13 reports the unknown execution target reason");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    invalid = base_request();
    invalid.execution_target = FULLMAG_FEM_MODAL_EXECUTION_VALIDATION;
    invalid_result = fullmag_fem_modal_eigen_solve(&invalid);
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "validation is a resolved-only modal lane and cannot be requested");
    check(contains(invalid_result.diagnostics_json, "unknown_execution_target"),
          "resolved-only validation lane request reports a stable reason");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    invalid = base_request();
    invalid.scalar_representation =
        static_cast<fullmag_fem_modal_scalar_representation>(99);
    invalid_result = fullmag_fem_modal_eigen_solve(&invalid);
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal typed tail rejects an unknown scalar representation");
    check(invalid_result.resolved_execution_target ==
              FULLMAG_FEM_MODAL_EXECUTION_VALIDATION,
          "unknown scalar representation reports resolved validation provenance");
    check(contains(invalid_result.diagnostics_json, "unknown_scalar_representation"),
          "modal typed tail reports the unknown scalar representation reason");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    invalid = base_request();
    invalid.result_field_representation =
        static_cast<fullmag_fem_modal_result_field_representation>(99);
    invalid_result = fullmag_fem_modal_eigen_solve(&invalid);
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal typed tail rejects an unknown result field representation");
    check(invalid_result.resolved_execution_target ==
              FULLMAG_FEM_MODAL_EXECUTION_VALIDATION,
          "unknown result field representation reports resolved validation provenance");
    check(contains(invalid_result.diagnostics_json,
                   "unknown_result_field_representation"),
          "modal typed tail reports the unknown result field representation reason");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    FullmagFemFrequencyDomainResult zeroed{};
    fullmag_fem_frequency_domain_result_destroy(&zeroed);
    fullmag_fem_frequency_domain_result_destroy(&zeroed);
}

void modal_v16_extension_rejects_unknown_spectral_transform_and_short_prefix()
{
    FullmagFemModalEigenRequest unknown_transform = base_request();
    unknown_transform.struct_size = sizeof(FullmagFemModalEigenRequest);
    unknown_transform.spectral_transform_kind =
        static_cast<fullmag_fem_modal_spectral_transform_kind>(99);
    FullmagFemFrequencyDomainResult unknown_result =
        fullmag_fem_modal_eigen_solve(&unknown_transform);
    check(unknown_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal v16 rejects an unknown spectral transform kind");
    check(contains(unknown_result.diagnostics_json, "unknown_spectral_transform_kind"),
          "modal v16 reports the unknown spectral transform reason");
    fullmag_fem_frequency_domain_result_destroy(&unknown_result);

    FullmagFemModalEigenRequest short_prefix = base_request();
    short_prefix.struct_size =
        offsetof(FullmagFemModalEigenRequest, result_field_representation);
    FullmagFemFrequencyDomainResult short_result =
        fullmag_fem_modal_eigen_solve(&short_prefix);
    check(short_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal v16 rejects a struct prefix shorter than its typed tail");
    check(contains(short_result.diagnostics_json, "struct_size_too_small"),
          "modal v16 reports the short struct prefix reason");
    fullmag_fem_frequency_domain_result_destroy(&short_result);

    FullmagFemModalEigenRequest absent_size = base_request();
    absent_size.struct_size = 0;
    FullmagFemFrequencyDomainResult absent_size_result =
        fullmag_fem_modal_eigen_solve(&absent_size);
    check(absent_size_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal v16 rejects an absent struct_size instead of reading typed tails");
    check(absent_size_result.resolved_execution_target ==
              FULLMAG_FEM_MODAL_EXECUTION_VALIDATION,
          "modal v16 absent struct_size reports resolved validation provenance");
    check(contains(absent_size_result.diagnostics_json, "struct_size_too_small"),
          "modal v16 reports the absent struct_size reason");
    fullmag_fem_frequency_domain_result_destroy(&absent_size_result);
}

void modal_abi_layout_publishes_versioned_modal_structs()
{
    fullmag_fem_frequency_domain_abi_layout legacy{};
    check(fullmag_fem_get_frequency_domain_abi_layout(&legacy) == FULLMAG_FEM_OK,
          "legacy frequency-domain ABI layout query succeeds");
    check(legacy.solve_result_size == sizeof(fullmag_fem_frequency_domain_solve_result),
          "legacy v1 layout retains its baseline tail");
    check(legacy.modal_abi_schema == 1u &&
              legacy.modal_abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
          "legacy v1 layout publishes its modal schema and ABI version");
    check(legacy.modal_eigen_request_size == sizeof(FullmagFemModalEigenRequest) &&
              legacy.modal_shared_domain_payload_size ==
                  offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor) &&
              legacy.modal_frequency_domain_result_size ==
                  sizeof(FullmagFemFrequencyDomainResult) &&
              legacy.modal_csr_matrix_view_size == sizeof(FullmagFemCsrMatrixView),
          "legacy v1 layout publishes all modal envelope sizes");
    check(legacy.modal_eigen_request_struct_size_offset ==
                  offsetof(FullmagFemModalEigenRequest, struct_size) &&
              legacy.modal_eigen_request_shared_domain_payload_offset ==
                  offsetof(FullmagFemModalEigenRequest, shared_domain_payload) &&
              legacy.modal_shared_domain_payload_struct_size_offset ==
                  offsetof(FullmagFemModalSharedDomainPayload, struct_size) &&
              legacy.modal_frequency_domain_result_struct_size_offset ==
                  offsetof(FullmagFemFrequencyDomainResult, struct_size) &&
              legacy.modal_csr_matrix_view_values_len_offset ==
                  offsetof(FullmagFemCsrMatrixView, values_len),
          "legacy v1 layout publishes modal prefix and payload offsets");

    fullmag_fem_frequency_domain_modal_abi_layout_v2 short_modal{};
    short_modal.struct_size = sizeof(short_modal) - 1u;
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v2(&short_modal) ==
              FULLMAG_FEM_ERR_INVALID,
          "modal v2 ABI query rejects a short caller prefix");

    fullmag_fem_frequency_domain_modal_abi_layout_v2 absent_size_modal{};
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v2(&absent_size_modal) ==
              FULLMAG_FEM_ERR_INVALID,
          "modal v2 ABI query rejects an absent caller struct_size");

    fullmag_fem_frequency_domain_modal_abi_layout_v2 modal{};
    modal.struct_size = sizeof(modal);
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v2(&modal) == FULLMAG_FEM_OK,
          "versioned modal ABI layout query succeeds");
    check(modal.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V2,
          "modal ABI layout publishes v2 ABI version");
    check(modal.modal_abi_schema == 2u, "modal ABI layout publishes schema v2");
    check(modal.modal_eigen_request_size == sizeof(FullmagFemModalEigenRequest) &&
              modal.modal_linearized_operator_request_size ==
                  sizeof(FullmagFemLinearizedOperatorRequest) &&
              modal.modal_shared_domain_payload_size ==
                  offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor) &&
              modal.modal_frequency_domain_result_size ==
                  sizeof(FullmagFemFrequencyDomainResult) &&
              modal.modal_csr_matrix_view_size == sizeof(FullmagFemCsrMatrixView),
          "modal v2 manifest publishes all cross-language struct sizes");
    check(legacy.modal_eigen_request_size == modal.modal_eigen_request_size &&
              legacy.modal_shared_domain_payload_size == modal.modal_shared_domain_payload_size &&
              legacy.modal_frequency_domain_result_size ==
                  modal.modal_frequency_domain_result_size &&
              legacy.modal_csr_matrix_view_size == modal.modal_csr_matrix_view_size,
          "legacy v1 and modal v2 manifests agree on envelope sizes");
    check(modal.modal_eigen_request_field_count == 78u &&
              modal.modal_linearized_operator_request_field_count == 14u &&
              modal.modal_shared_domain_payload_field_count == 57u &&
              modal.modal_frequency_domain_result_field_count == 32u &&
              modal.modal_csr_matrix_view_field_count == 8u,
          "modal v2 manifest publishes complete field counts");
#define FULLMAG_FEM_V2_TEST_V6_RELATION(member) \
    offsetof(FullmagFemModalCertificateV6Relation, member),
    constexpr std::uint64_t v6_relation_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_LIST(
            FULLMAG_FEM_V2_TEST_V6_RELATION)
    };
#undef FULLMAG_FEM_V2_TEST_V6_RELATION
#define FULLMAG_FEM_V2_TEST_V6_REGION_ROLE(member) \
    offsetof(FullmagFemModalCertificateV6RegionRole, member),
    constexpr std::uint64_t v6_region_role_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_LIST(
            FULLMAG_FEM_V2_TEST_V6_REGION_ROLE)
    };
#undef FULLMAG_FEM_V2_TEST_V6_REGION_ROLE
#define FULLMAG_FEM_V2_TEST_V6_CLASS_DIGEST(member) \
    offsetof(FullmagFemModalCertificateV6ClassDigest, member),
    constexpr std::uint64_t v6_class_digest_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_LIST(
            FULLMAG_FEM_V2_TEST_V6_CLASS_DIGEST)
    };
#undef FULLMAG_FEM_V2_TEST_V6_CLASS_DIGEST
#define FULLMAG_FEM_V2_TEST_V6_VIEW(member) \
    offsetof(FullmagFemModalCertificateV6View, member),
    constexpr std::uint64_t v6_view_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_LIST(FULLMAG_FEM_V2_TEST_V6_VIEW)
    };
#undef FULLMAG_FEM_V2_TEST_V6_VIEW
#define FULLMAG_FEM_V2_TEST_V6_BINDING_REQUEST(member) \
    offsetof(FullmagFemModalCertificateV6BindingRequest, member),
    constexpr std::uint64_t v6_binding_request_offsets[] = {
        FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_LIST(
            FULLMAG_FEM_V2_TEST_V6_BINDING_REQUEST)
    };
#undef FULLMAG_FEM_V2_TEST_V6_BINDING_REQUEST
    check(modal.modal_certificate_v6_relation_size ==
                  sizeof(FullmagFemModalCertificateV6Relation) &&
              modal.modal_certificate_v6_region_role_size ==
                  sizeof(FullmagFemModalCertificateV6RegionRole) &&
              modal.modal_certificate_v6_class_digest_size ==
                  sizeof(FullmagFemModalCertificateV6ClassDigest) &&
              modal.modal_certificate_v6_view_size == sizeof(FullmagFemModalCertificateV6View) &&
              modal.modal_certificate_v6_binding_request_size ==
                  sizeof(FullmagFemModalCertificateV6BindingRequest),
          "modal v2 manifest publishes nested v6 certificate sizes");
    check(modal.modal_certificate_v6_relation_field_count ==
                  FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_COUNT &&
              modal.modal_certificate_v6_region_role_field_count ==
                  FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_COUNT &&
              modal.modal_certificate_v6_class_digest_field_count ==
                  FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_COUNT &&
              modal.modal_certificate_v6_view_field_count ==
                  FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_COUNT &&
              modal.modal_certificate_v6_binding_request_field_count ==
                  FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_COUNT,
          "modal v2 manifest publishes nested v6 certificate field counts");
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_CERTIFICATE_V6_RELATION_FIELD_COUNT; ++i) {
        check(modal.modal_certificate_v6_relation_field_offsets[i] == v6_relation_offsets[i],
              "modal v2 relation offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_CERTIFICATE_V6_REGION_ROLE_FIELD_COUNT; ++i) {
        check(modal.modal_certificate_v6_region_role_field_offsets[i] == v6_region_role_offsets[i],
              "modal v2 region-role offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_CERTIFICATE_V6_CLASS_DIGEST_FIELD_COUNT; ++i) {
        check(modal.modal_certificate_v6_class_digest_field_offsets[i] == v6_class_digest_offsets[i],
              "modal v2 class-digest offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_CERTIFICATE_V6_VIEW_FIELD_COUNT; ++i) {
        check(modal.modal_certificate_v6_view_field_offsets[i] == v6_view_offsets[i],
              "modal v2 view offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_CERTIFICATE_V6_BINDING_REQUEST_FIELD_COUNT; ++i) {
        check(modal.modal_certificate_v6_binding_request_field_offsets[i] ==
                  v6_binding_request_offsets[i],
              "modal v2 binding-request offset mismatch");
    }
#define FULLMAG_FEM_V2_TEST_OPERATOR(member) offsetof(FullmagFemLinearizedOperatorRequest, member),
    constexpr std::uint64_t operator_offsets[] = {
        FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_LIST(FULLMAG_FEM_V2_TEST_OPERATOR)
    };
#undef FULLMAG_FEM_V2_TEST_OPERATOR
#define FULLMAG_FEM_V2_TEST_REQUEST(member) offsetof(FullmagFemModalEigenRequest, member),
    constexpr std::uint64_t request_offsets[] = {
        FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_LIST(FULLMAG_FEM_V2_TEST_REQUEST)
    };
#undef FULLMAG_FEM_V2_TEST_REQUEST
#define FULLMAG_FEM_V2_TEST_PAYLOAD(member) offsetof(FullmagFemModalSharedDomainPayload, member),
    constexpr std::uint64_t payload_offsets[] = {
        FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_LIST(FULLMAG_FEM_V2_TEST_PAYLOAD)
    };
#undef FULLMAG_FEM_V2_TEST_PAYLOAD
#define FULLMAG_FEM_V2_TEST_RESULT(member) offsetof(FullmagFemFrequencyDomainResult, member),
    constexpr std::uint64_t result_offsets[] = {
        FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_LIST(FULLMAG_FEM_V2_TEST_RESULT)
    };
#undef FULLMAG_FEM_V2_TEST_RESULT
#define FULLMAG_FEM_V2_TEST_CSR(member) offsetof(FullmagFemCsrMatrixView, member),
    constexpr std::uint64_t csr_offsets[] = {
        FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_LIST(FULLMAG_FEM_V2_TEST_CSR)
    };
#undef FULLMAG_FEM_V2_TEST_CSR
    check(modal.modal_eigen_request_field_offsets[70] ==
                  legacy.modal_eigen_request_struct_size_offset &&
              modal.modal_eigen_request_field_offsets[75] ==
                  legacy.modal_eigen_request_shared_domain_payload_offset &&
              modal.modal_shared_domain_payload_field_offsets[1] ==
                  legacy.modal_shared_domain_payload_struct_size_offset &&
              modal.modal_shared_domain_payload_field_offsets[20] ==
                  legacy.modal_shared_domain_payload_mesh_certificate_digest_offset &&
              modal.modal_shared_domain_payload_field_offsets[41] ==
                  legacy.modal_shared_domain_payload_map_binding_digest_offset &&
              modal.modal_shared_domain_payload_field_offsets[44] ==
                  legacy.modal_shared_domain_payload_bias_field_sample_id_offset &&
              modal.modal_frequency_domain_result_field_offsets[25] ==
                  legacy.modal_frequency_domain_result_struct_size_offset &&
              modal.modal_frequency_domain_result_field_offsets[27] ==
                  legacy.modal_frequency_domain_result_resolved_engine_id_offset &&
              modal.modal_csr_matrix_view_field_offsets[7] ==
                  legacy.modal_csr_matrix_view_values_len_offset,
          "legacy v1 offsets agree with modal v2 manifest offsets");
    check(modal.modal_eigen_request_field_offsets[76] ==
                  offsetof(FullmagFemModalEigenRequest, mesh_generation_identity) &&
              modal.modal_eigen_request_field_offsets[77] ==
                  offsetof(FullmagFemModalEigenRequest, canonical_preimage_sha256) &&
              modal.modal_shared_domain_payload_field_offsets[48] ==
                  offsetof(FullmagFemModalSharedDomainPayload, mesh_generation_identity) &&
              modal.modal_shared_domain_payload_field_offsets[55] ==
                  offsetof(FullmagFemModalSharedDomainPayload, certificate_binding_reason) &&
              modal.modal_shared_domain_payload_field_offsets[56] ==
                  offsetof(FullmagFemModalSharedDomainPayload, certificate_binding_v6) &&
              modal.modal_frequency_domain_result_field_offsets[29] ==
                  offsetof(FullmagFemFrequencyDomainResult,
                           resolved_canonical_preimage_sha256) &&
              modal.modal_frequency_domain_result_field_offsets[31] ==
                  offsetof(FullmagFemFrequencyDomainResult,
                           resolved_certificate_binding_reason),
          "modal v2 manifest publishes v17 certificate binding offsets");
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_LINEARIZED_OPERATOR_REQUEST_FIELD_COUNT; ++i) {
        check(modal.modal_linearized_operator_request_field_offsets[i] == operator_offsets[i],
              "modal v2 operator offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_EIGEN_REQUEST_FIELD_COUNT; ++i) {
        check(modal.modal_eigen_request_field_offsets[i] == request_offsets[i],
              "modal v2 request offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT; ++i) {
        check(modal.modal_shared_domain_payload_field_offsets[i] == payload_offsets[i],
              "modal v2 payload offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_FREQUENCY_DOMAIN_RESULT_FIELD_COUNT; ++i) {
        check(modal.modal_frequency_domain_result_field_offsets[i] == result_offsets[i],
              "modal v2 result offset mismatch");
    }
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_CSR_MATRIX_VIEW_FIELD_COUNT; ++i) {
        check(modal.modal_csr_matrix_view_field_offsets[i] == csr_offsets[i],
              "modal v2 CSR offset mismatch");
    }
    check(modal.modal_eigen_request_field_offsets[78] == 0u &&
              modal.modal_shared_domain_payload_field_offsets[57] == 0u &&
              modal.modal_frequency_domain_result_field_offsets[32] == 0u,
          "modal v2 manifest zero-fills unused capacity");
    check(modal.modal_linearized_operator_request_field_offsets[14] == 0u &&
              modal.modal_csr_matrix_view_field_offsets[7] == csr_offsets[7],
          "modal v2 manifest preserves operator tail and full CSR capacity");

    fullmag_fem_frequency_domain_modal_abi_layout_v3 short_v3{};
    short_v3.v2.struct_size = sizeof(short_v3) - 1u;
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v3(&short_v3) ==
              FULLMAG_FEM_ERR_INVALID,
          "modal v3 ABI layout query rejects a short caller struct_size");

    fullmag_fem_frequency_domain_modal_abi_layout_v3 v3{};
    v3.v2.struct_size = sizeof(v3);
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v3(&v3) == FULLMAG_FEM_OK,
          "modal v3 ABI layout query succeeds");
    check(v3.v2.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V3 &&
              v3.v2.modal_shared_domain_payload_size ==
                  offsetof(FullmagFemModalSharedDomainPayload, exchange_material_view) +
                      sizeof(const FullmagFemModalExchangeMaterialView *) &&
              v3.v2.modal_shared_domain_payload_field_count ==
                  FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT + 2u &&
              v3.v2.modal_shared_domain_payload_field_offsets[
                  FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT] ==
                  offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor) &&
              v3.v2.modal_shared_domain_payload_field_offsets[
                  FULLMAG_FEM_MODAL_SHARED_DOMAIN_PAYLOAD_FIELD_COUNT + 1u] ==
                  offsetof(FullmagFemModalSharedDomainPayload, exchange_material_view),
          "modal v3 manifest publishes the V18 payload tail");
    check(v3.modal_linearization_descriptor_size ==
                  sizeof(FullmagFemModalLinearizationDescriptor) &&
              v3.modal_linearization_descriptor_field_count ==
                  FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT,
          "modal v3 manifest publishes descriptor size and field count");
#define FULLMAG_FEM_V3_TEST_DESCRIPTOR(member) \
    offsetof(FullmagFemModalLinearizationDescriptor, member),
    constexpr std::uint64_t descriptor_offsets[] = {
        FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_LIST(
            FULLMAG_FEM_V3_TEST_DESCRIPTOR)
    };
#undef FULLMAG_FEM_V3_TEST_DESCRIPTOR
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT; ++i) {
        check(v3.modal_linearization_descriptor_field_offsets[i] == descriptor_offsets[i],
              "modal v3 descriptor offset mismatch");
    }
    check(v3.modal_linearization_descriptor_field_offsets[
                  FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_FIELD_COUNT] == 0u,
          "modal v3 descriptor manifest zero-fills unused capacity");
    check(v3.modal_exchange_material_view_size ==
                  sizeof(FullmagFemModalExchangeMaterialView) &&
              v3.modal_exchange_material_view_field_count ==
                  FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_COUNT,
          "modal v3 manifest publishes scalar exchange material view");
#define FULLMAG_FEM_V3_TEST_MATERIAL(member) \
    offsetof(FullmagFemModalExchangeMaterialView, member),
    constexpr std::uint64_t material_offsets[] = {
        FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_LIST(
            FULLMAG_FEM_V3_TEST_MATERIAL)
    };
#undef FULLMAG_FEM_V3_TEST_MATERIAL
    for (std::size_t i = 0; i < FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_COUNT; ++i) {
        check(v3.modal_exchange_material_view_field_offsets[i] == material_offsets[i],
              "modal v3 scalar exchange material offset mismatch");
    }
    check(v3.modal_exchange_material_view_field_offsets[
                  FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_FIELD_COUNT] == 0u,
          "modal v3 scalar exchange material manifest zero-fills unused capacity");

    fullmag_fem_frequency_domain_modal_abi_layout_v4 short_v4{};
    short_v4.v3.v2.struct_size = sizeof(short_v4) - 1u;
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v4(&short_v4) ==
              FULLMAG_FEM_ERR_INVALID,
          "modal v4 ABI layout query rejects a short caller struct_size");

    fullmag_fem_frequency_domain_modal_abi_layout_v4 v4{};
    v4.v3.v2.struct_size = sizeof(v4);
    check(fullmag_fem_get_frequency_domain_modal_abi_layout_v4(&v4) == FULLMAG_FEM_OK,
          "modal v4 ABI layout query succeeds");
    constexpr std::uint64_t acceptance_offsets[] = {
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_criterion),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_metric_kind),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_unit),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_metric_value),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_threshold),
        offsetof(FullmagFemModalSharedDomainPayload, acceptance_certificate_sha256),
    };
    check(v4.v3.v2.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V4 &&
              v4.v3.v2.modal_abi_schema == 4u &&
              v4.v3.v2.modal_shared_domain_payload_size ==
                  sizeof(FullmagFemModalSharedDomainPayload) &&
              v4.v3.v2.modal_shared_domain_payload_field_count == 65u &&
              v4.modal_acceptance_certificate_field_count == 6u,
          "modal v4 manifest publishes the complete ABI v19 payload");
    for (std::size_t i = 0u; i < 6u; ++i) {
        check(v4.modal_acceptance_certificate_field_offsets[i] == acceptance_offsets[i] &&
                  v4.v3.v2.modal_shared_domain_payload_field_offsets[59u + i] ==
                      acceptance_offsets[i],
              "modal v4 manifest publishes acceptance-certificate offsets");
    }
    check(v4.modal_acceptance_certificate_field_offsets[6] == 0u,
          "modal v4 acceptance manifest zero-fills unused capacity");
}

FullmagFemModalSharedDomainPayload certificate_payload()
{
    static constexpr char kCanonicalPreimage[] =
        "periodic_modal_equivalence_map_binding.v1\n"
        "schema=periodic_mesh_certificate.v6\n";
    FullmagFemModalSharedDomainPayload payload{};
    /* This golden fixture deliberately exercises the preserved V17 prefix;
       V18 descriptor cases are tested separately below. */
    payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION;
    payload.struct_size =
        static_cast<std::uint32_t>(offsetof(FullmagFemModalSharedDomainPayload,
                                             linearization_descriptor));
    payload.magnetic_pair_count = 1;
    payload.airbox_pair_count = 1;
    payload.boundary_kind = "periodic";
    payload.boundary_marker = 1;
    payload.equilibrium_digest =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.mesh_certificate_digest =
        "sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.mesh_certificate_schema = "periodic_mesh_certificate.v6";
    payload.linearization_state_digest =
        "sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.mesh_certificate_map_binding_digest =
        "sha256:3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.boundary_gauge_digest =
        "sha256:4123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.bias_field_sample_index = 0;
    payload.bias_field_sample_id = "bias_sample:0";
    payload.bias_field_sample_signature =
        "sha256:5123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.magnetic_part_identity = "part:magnetic";
    payload.airbox_part_identity = "part:airbox";
    payload.mesh_generation_identity = "mesh-generation:fixture";
    payload.canonical_preimage = kCanonicalPreimage;
    payload.canonical_preimage_len = std::strlen(kCanonicalPreimage);
    payload.canonical_preimage_sha256 =
        "sha256:5c4867e34716043a16db534f5ffca90613cff84119573b5da0afdb2f1aafb6d2";
    payload.magnetic_class_digest_sha256 =
        "sha256:6123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.scalar_class_digest_sha256 =
        "sha256:7123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload.certificate_binding_status =
        FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED;
    payload.certificate_binding_reason = "canonical_certificate_binding_unverifiable";
    return payload;
}

struct ModalLinearizationDescriptorFixture {
    static constexpr char kDigest[] =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    double tangent_frames[12] = {
        1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        1.0, 0.0, 0.0, 0.0, 1.0, 0.0};
    double equilibrium[6] = {0.0, 0.0, 1.0, 0.0, 0.0, 1.0};
    double effective_field[6] = {0.0, 0.0, 1.0, 0.0, 0.0, 1.0};
    double external_field[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    double alpha[2] = {0.01, 0.01};
    FullmagFemModalLinearizationDescriptor descriptor{};

    ModalLinearizationDescriptorFixture()
    {
        descriptor.abi_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION;
        descriptor.struct_size = sizeof(descriptor);
        descriptor.schema_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA;
        descriptor.node_count = 2;
        descriptor.tangent_dof_count = 4;
        descriptor.coordinate_unit = "m";
        descriptor.magnetisation_unit = "A/m";
        descriptor.time_unit = "s";
        descriptor.frequency_unit = "Hz";
        descriptor.angular_frequency_unit = "rad/s";
        descriptor.linearization_state_digest = kDigest;
        descriptor.equilibrium_digest = kDigest;
        descriptor.operator_input_digest = kDigest;
        descriptor.term_presence_mask = 0;
        descriptor.tangent_frame_xyz = tangent_frames;
        descriptor.tangent_frame_xyz_count = 12;
        descriptor.equilibrium_m0_xyz = equilibrium;
        descriptor.equilibrium_m0_xyz_count = 6;
        descriptor.effective_field_h_eff0_xyz = effective_field;
        descriptor.effective_field_h_eff0_xyz_count = 6;
        descriptor.external_field_h_ext0_xyz = external_field;
        descriptor.external_field_h_ext0_xyz_count = 6;
        descriptor.alpha_per_node = alpha;
        descriptor.alpha_per_node_count = 2;
        descriptor.uniform_saturation_magnetisation_a_per_m = 1.0;
    }
};

constexpr char ModalLinearizationDescriptorFixture::kDigest[];

struct ModalCertificateV6CAbiGoldenFixture {
    std::uint32_t magnetic_regions[4] = {7, 7, 7, 7};
    std::uint32_t scalar_regions[4] = {100, 100, 100, 100};
    std::uint32_t boundary_axes[4] = {0, 1, 2, 3};
    fd::MeshSymmetryCertificateRegionRole magnetic_roles[1] = {
        {7, fd::MeshSymmetryCertificatePartRole::magnetic},
    };
    fd::MeshSymmetryCertificateRegionRole scalar_roles[1] = {
        {100, fd::MeshSymmetryCertificatePartRole::scalar_airbox},
    };
    fd::MeshSymmetryCertificateV6Relation generators[4] = {
        {0, 1, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 3, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 2, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 3, 2, fd::MeshSymmetryCertificateRelationKind::face},
    };
    fd::MeshSymmetryCertificateV6Relation closure[6] = {
        {0, 1, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 3, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 2, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 3, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 3, 3, fd::MeshSymmetryCertificateRelationKind::edge},
        {1, 2, 3, fd::MeshSymmetryCertificateRelationKind::edge},
    };
    std::uint64_t class_ids[4] = {0, 0, 0, 0};
    fd::MeshSymmetryCertificateV6ClassDigest magnetic_class_digest[1] = {
        {0, 4, "sha256:88feeb3b3663fbb296e50c8f7793b69577d882945f921a5d296cbbd0d93cebac"},
    };
    fd::MeshSymmetryCertificateV6ClassDigest scalar_class_digest[1] = {
        {0, 4, "sha256:7ff33f86d0dc4a728a5beaf03ef9b05fb20ee1821b92218d846272a01db7366c"},
    };
    std::string magnetic_class_digest_sha256{};
    std::string scalar_class_digest_sha256{};
    FullmagFemModalCertificateV6Relation c_generators[4] = {
        {0, 1, 1, 1}, {2, 3, 1, 1}, {0, 2, 2, 1}, {1, 3, 2, 1},
    };
    FullmagFemModalCertificateV6Relation c_closure[6] = {
        {0, 1, 1, 1}, {2, 3, 1, 1}, {0, 2, 2, 1}, {1, 3, 2, 1},
        {0, 3, 3, 2}, {1, 2, 3, 2},
    };
    FullmagFemModalCertificateV6RegionRole c_magnetic_roles[1] = {{7, 1}};
    FullmagFemModalCertificateV6RegionRole c_scalar_roles[1] = {{100, 2}};
    FullmagFemModalCertificateV6ClassDigest c_magnetic_class_digest[1] = {
        {0, 4, "sha256:88feeb3b3663fbb296e50c8f7793b69577d882945f921a5d296cbbd0d93cebac"},
    };
    FullmagFemModalCertificateV6ClassDigest c_scalar_class_digest[1] = {
        {0, 4, "sha256:7ff33f86d0dc4a728a5beaf03ef9b05fb20ee1821b92218d846272a01db7366c"},
    };
    FullmagFemModalCertificateV6View c_views[4]{};
    FullmagFemModalCertificateV6BindingRequest c_binding{};
    fd::MeshSymmetryCertificateV6Binding native_binding{};

    fd::MeshSymmetryCertificateV6View native_view(
        fd::MeshSymmetryCertificateV6ViewKind view_kind,
        fd::MeshSymmetryCertificatePartRole part_role,
        const char *part_identity,
        const char *topology_fingerprint,
        const std::uint32_t *regions,
        const fd::MeshSymmetryCertificateRegionRole *roles,
        const fd::MeshSymmetryCertificateV6ClassDigest *digests)
    {
        fd::MeshSymmetryCertificateV6View view{};
        view.schema_version = "periodic_mesh_certificate.v6";
        view.view_kind = view_kind;
        view.part_role = part_role;
        view.part_identity = part_identity;
        view.topology_fingerprint = topology_fingerprint;
        view.node_count = 4;
        view.region_ids = regions;
        view.boundary_axis_masks = boundary_axes;
        view.region_roles = roles;
        view.region_role_count = 1;
        view.generator_relations = generators;
        view.generator_relation_count = 4;
        view.closure_relations = closure;
        view.closure_relation_count = 6;
        view.require_complete_closure = true;
        view.expected_class_ids = class_ids;
        view.expected_class_id_count = 4;
        view.expected_class_digests = digests;
        view.expected_class_digest_count = 1;
        return view;
    }

    FullmagFemModalCertificateV6View c_view(
        std::uint32_t view_kind,
        std::uint32_t part_role,
        const char *part_identity,
        const char *topology_fingerprint,
        const std::uint32_t *regions,
        const FullmagFemModalCertificateV6RegionRole *roles,
        const FullmagFemModalCertificateV6ClassDigest *digests)
    {
        FullmagFemModalCertificateV6View view{};
        view.view_kind = view_kind;
        view.part_role = part_role;
        view.part_identity = part_identity;
        view.topology_fingerprint = topology_fingerprint;
        view.node_count = 4;
        view.region_ids = regions;
        view.boundary_axis_masks = boundary_axes;
        view.region_roles = roles;
        view.region_role_count = 1;
        view.generator_relations = c_generators;
        view.generator_relation_count = 4;
        view.closure_relations = c_closure;
        view.closure_relation_count = 6;
        view.require_complete_closure = 1;
        view.expected_class_ids = class_ids;
        view.expected_class_id_count = 4;
        view.expected_class_digests = digests;
        view.expected_class_digest_count = 1;
        return view;
    }

    void initialize()
    {
        fd::MeshSymmetryCertificateV6BindingRequest native_request{};
        native_request.schema_version = "periodic_mesh_certificate.v6";
        native_request.mesh_generation_identity = "mesh-generation:fixture";
        native_request.mesh_magnetic = native_view(
            fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh,
            fd::MeshSymmetryCertificatePartRole::magnetic,
            "magnetic:fixture",
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            magnetic_regions,
            magnetic_roles,
            magnetic_class_digest);
        native_request.payload_magnetic = native_view(
            fd::MeshSymmetryCertificateV6ViewKind::compact_payload,
            fd::MeshSymmetryCertificatePartRole::magnetic,
            "magnetic:fixture",
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            magnetic_regions,
            magnetic_roles,
            magnetic_class_digest);
        native_request.mesh_scalar = native_view(
            fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh,
            fd::MeshSymmetryCertificatePartRole::scalar_airbox,
            "airbox:fixture",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            scalar_regions,
            scalar_roles,
            scalar_class_digest);
        native_request.payload_scalar = native_view(
            fd::MeshSymmetryCertificateV6ViewKind::compact_payload,
            fd::MeshSymmetryCertificatePartRole::scalar_airbox,
            "airbox:fixture",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            scalar_regions,
            scalar_roles,
            scalar_class_digest);
        fd::verify_mesh_symmetry_certificate_v6(native_request, native_binding);
        check(native_binding.magnetic_class_digests.size() == 1u &&
                  native_binding.scalar_class_digests.size() == 1u,
              "v6 golden fixture bootstrap must compute one digest per class");
        magnetic_class_digest_sha256 = native_binding.magnetic_class_digests[0];
        scalar_class_digest_sha256 = native_binding.scalar_class_digests[0];
        magnetic_class_digest[0].sha256 = magnetic_class_digest_sha256.c_str();
        scalar_class_digest[0].sha256 = scalar_class_digest_sha256.c_str();
        fd::verify_mesh_symmetry_certificate_v6(native_request, native_binding);
        const std::string canonical_preimage_sha256 =
            native_binding.canonical_preimage_sha256;
        native_request.payload_binding_digest = canonical_preimage_sha256.c_str();
        fd::verify_mesh_symmetry_certificate_v6(native_request, native_binding);
        check(native_binding.accepted,
              "v6 golden fixture native relation binding must be accepted");

        c_magnetic_class_digest[0].sha256 =
            magnetic_class_digest_sha256.c_str();
        c_scalar_class_digest[0].sha256 =
            scalar_class_digest_sha256.c_str();

        c_views[0] = c_view(
            1,
            1,
            "magnetic:fixture",
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            magnetic_regions,
            c_magnetic_roles,
            c_magnetic_class_digest);
        c_views[1] = c_view(
            2,
            1,
            "magnetic:fixture",
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            magnetic_regions,
            c_magnetic_roles,
            c_magnetic_class_digest);
        c_views[2] = c_view(
            1,
            2,
            "airbox:fixture",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            scalar_regions,
            c_scalar_roles,
            c_scalar_class_digest);
        c_views[3] = c_view(
            2,
            2,
            "airbox:fixture",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            scalar_regions,
            c_scalar_roles,
            c_scalar_class_digest);
        c_binding.schema_version = "periodic_mesh_certificate.v6";
        c_binding.mesh_magnetic = c_views[0];
        c_binding.payload_magnetic = c_views[1];
        c_binding.mesh_scalar = c_views[2];
        c_binding.payload_scalar = c_views[3];
    }
};

#if FULLMAG_HAS_MFEM_STACK && FULLMAG_FEM_WITH_SLEPC

/*
 * The contour adapter must be exercised with the same bounded shared-domain
 * provider that production_cpu uses.  Keep this fixture deliberately small:
 * two tetrahedra provide four magnetic nodes and one airbox node, while the
 * v6 views bind the exact seam/corner topology used by the importer.
 */
struct FloquetContourSharedDomainFixture {
    std::vector<double> nodes = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, -1.0};
    std::vector<std::uint32_t> cell_types = {
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    std::vector<std::uint32_t> cell_offsets = {0u, 4u, 8u};
    std::vector<std::uint32_t> cell_nodes = {
        0u, 1u, 2u, 3u,
        0u, 2u, 1u, 4u};
    std::vector<std::uint64_t> cell_ordinals = {0u, 1u};
    std::vector<std::uint32_t> cell_markers = {1u, 0u};
    std::vector<std::uint32_t> facet_types =
        std::vector<std::uint32_t>(6u, FULLMAG_FEM_FACET_TRI3);
    std::vector<std::uint32_t> facet_roles = {
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    std::vector<std::uint32_t> facet_offsets = {0u, 3u, 6u, 9u, 12u, 15u, 18u};
    std::vector<std::uint32_t> facet_nodes = {
        1u, 2u, 3u,
        0u, 3u, 2u,
        0u, 1u, 3u,
        1u, 4u, 2u,
        0u, 2u, 4u,
        0u, 1u, 4u};
    std::vector<std::uint64_t> facet_ordinals = {0u, 1u, 2u, 3u, 4u, 5u};
    std::vector<std::uint32_t> facet_markers = {7u, 8u, 1u, 1u, 1u, 1u};
    std::vector<std::uint32_t> mesh_periodic_node_pairs = {
        0u, 1u, 0u, 2u, 0u, 3u, 1u, 2u, 1u, 3u, 2u, 3u};
    std::vector<std::uint32_t> periodic_boundary_markers = {7u, 8u, 9u, 10u};
    fullmag_fem_mesh_desc mesh{};

    std::vector<double> equilibrium = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0};
    std::vector<double> h_eff = equilibrium;
    std::vector<double> h_demag = std::vector<double>(15u, 0.0);
    std::vector<double> phi0 = std::vector<double>(5u, 0.0);
    std::vector<std::uint32_t> scalar_classes = {0u, 0u, 0u, 0u, 1u};
    std::vector<std::uint32_t> magnetic_classes = {
        0u, 0u, 0u, 0u, std::numeric_limits<std::uint32_t>::max()};
    std::vector<std::uint32_t> a_qq_offsets =
        std::vector<std::uint32_t>(11u, 0u);
    std::vector<double> descriptor_frames = std::vector<double>(30u, 0.0);
    std::vector<double> descriptor_external = std::vector<double>(15u, 0.0);
    std::vector<double> descriptor_alpha = std::vector<double>(5u, 0.01);
    FullmagFemModalLinearizationDescriptor descriptor{};

    std::vector<std::uint32_t> magnetic_certificate_regions{1u, 1u, 1u, 1u};
    std::vector<std::uint32_t> scalar_certificate_regions{2u, 2u, 2u, 2u, 2u};
    std::vector<std::uint32_t> magnetic_boundary_axes{0u, 1u, 2u, 7u};
    std::vector<std::uint32_t> scalar_boundary_axes{0u, 1u, 2u, 7u, 4u};
    std::uint64_t magnetic_reduced_node_count = 1u;
    std::uint64_t scalar_reduced_node_count = 2u;
    FullmagFemModalCertificateV6RegionRole magnetic_roles[1]{{1u, 1u}};
    FullmagFemModalCertificateV6RegionRole scalar_roles[1]{{2u, 2u}};
    FullmagFemModalCertificateV6Relation magnetic_generators[3]{
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u}};
    FullmagFemModalCertificateV6Relation magnetic_closure[6]{
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u},
        {1u, 2u, 3u, 2u}, {1u, 3u, 6u, 2u}, {2u, 3u, 5u, 2u}};
    FullmagFemModalCertificateV6Relation scalar_generators[3]{
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u}};
    FullmagFemModalCertificateV6Relation scalar_closure[6]{
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u},
        {1u, 2u, 3u, 2u}, {1u, 3u, 6u, 2u}, {2u, 3u, 5u, 2u}};
    FullmagFemModalCertificateV6View c_views[4]{};
    FullmagFemModalCertificateV6BindingRequest c_certificate{};
    fd::MeshSymmetryCertificateV6Binding accepted_certificate{};
    std::vector<std::uint64_t> magnetic_expected_class_ids{};
    std::vector<std::uint64_t> scalar_expected_class_ids{};
    std::vector<std::string> magnetic_expected_class_digest_strings{};
    std::vector<std::string> scalar_expected_class_digest_strings{};
    std::vector<FullmagFemModalCertificateV6ClassDigest> magnetic_expected_class_digests{};
    std::vector<FullmagFemModalCertificateV6ClassDigest> scalar_expected_class_digests{};
    std::string canonical_preimage{};
    std::string canonical_preimage_digest{};
    std::string magnetic_class_digest{};
    std::string scalar_class_digest{};
    std::string map_binding_digest{};
    std::array<fullmag_fem_frequency_domain_floquet_periodic_pair, 3> c_pairs{};
    std::array<fd::FrequencyDomainFloquetPeriodicPair, 3> native_pairs{};
    std::array<double, 3> k_vector{{1.0, 0.0, 0.0}};
    FullmagFemModalSharedDomainPayload payload{};
    std::string magnetic_topology_fingerprint{};
    std::string scalar_topology_fingerprint{};
    std::string equilibrium_content_digest{};
    std::string equilibrium_digest{};
    std::string linearization_state_digest{};
    std::string operator_input_digest{};
    std::string field_term_digest{};
    std::string demag_term_digest{};
    std::string acceptance_certificate_digest{};
    std::string boundary_gauge_digest{};
    std::string bias_field_sample_signature{};
    double reference_frequency_hz = 0.0;
    std::vector<double> static_reduced_poisson_matrix{};
    std::vector<std::uint32_t> static_scalar_class_representatives{};
    std::vector<std::uint32_t> static_scalar_raw_ids_by_canonical{};
    std::vector<std::uint32_t> static_scalar_raw_node_classes{};
    int static_scalar_order = 0;
    double static_robin_beta = 0.0;

    FullmagFemModalCertificateV6View make_c_view(
        std::uint32_t view_kind,
        std::uint32_t part_role,
        const char *part_identity,
        const char *topology_fingerprint,
        std::uint64_t node_count,
        const std::uint32_t *regions,
        const std::uint32_t *boundary_axes,
        const FullmagFemModalCertificateV6RegionRole *roles,
        std::uint64_t role_count,
        const FullmagFemModalCertificateV6Relation *generators,
        std::uint64_t generator_count,
        const FullmagFemModalCertificateV6Relation *closure,
        std::uint64_t closure_count)
    {
        FullmagFemModalCertificateV6View view{};
        view.view_kind = view_kind;
        view.part_role = part_role;
        view.part_identity = part_identity;
        view.topology_fingerprint = topology_fingerprint;
        view.node_count = node_count;
        view.region_ids = regions;
        view.boundary_axis_masks = boundary_axes;
        view.region_roles = roles;
        view.region_role_count = role_count;
        view.generator_relations = generators;
        view.generator_relation_count = generator_count;
        view.closure_relations = closure;
        view.closure_relation_count = closure_count;
        view.require_complete_closure = 1u;
        return view;
    }

    fd::MeshSymmetryCertificateV6View typed_view(
        const FullmagFemModalCertificateV6View &source) const
    {
        fd::MeshSymmetryCertificateV6View view{};
        view.schema_version = c_certificate.schema_version;
        view.view_kind = static_cast<fd::MeshSymmetryCertificateV6ViewKind>(source.view_kind);
        view.part_role = static_cast<fd::MeshSymmetryCertificatePartRole>(source.part_role);
        view.part_identity = source.part_identity;
        view.topology_fingerprint = source.topology_fingerprint;
        view.node_count = source.node_count;
        view.region_ids = source.region_ids;
        view.boundary_axis_masks = source.boundary_axis_masks;
        view.region_roles = reinterpret_cast<const fd::MeshSymmetryCertificateRegionRole *>(
            source.region_roles);
        view.region_role_count = source.region_role_count;
        view.generator_relations = reinterpret_cast<const fd::MeshSymmetryCertificateV6Relation *>(
            source.generator_relations);
        view.generator_relation_count = source.generator_relation_count;
        view.closure_relations = reinterpret_cast<const fd::MeshSymmetryCertificateV6Relation *>(
            source.closure_relations);
        view.closure_relation_count = source.closure_relation_count;
        view.require_complete_closure = source.require_complete_closure != 0u;
        view.expected_class_ids = source.expected_class_ids;
        view.expected_class_id_count = source.expected_class_id_count;
        view.expected_class_digests = reinterpret_cast<
            const fd::MeshSymmetryCertificateV6ClassDigest *>(source.expected_class_digests);
        view.expected_class_digest_count = source.expected_class_digest_count;
        return view;
    }

    std::string mesh_topology_fingerprint(std::string_view scope) const
    {
        fd::CanonicalDigestBuilder digest("modal_count_fixture.mesh_topology.v1");
        digest.add_string("scope", scope);
        digest.add_u64("node_count", nodes.size() / 3u);
        for (double coordinate : nodes) {
            digest.add_double("node_xyz", coordinate);
        }
        digest.add_u64("cell_type_count", cell_types.size());
        for (std::uint32_t value : cell_types) {
            digest.add_u64("cell_type", value);
        }
        digest.add_u64("cell_offset_count", cell_offsets.size());
        for (std::uint32_t value : cell_offsets) {
            digest.add_u64("cell_offset", value);
        }
        digest.add_u64("cell_node_count", cell_nodes.size());
        for (std::uint32_t value : cell_nodes) {
            digest.add_u64("cell_node", value);
        }
        digest.add_u64("cell_ordinal_count", cell_ordinals.size());
        for (std::uint64_t value : cell_ordinals) {
            digest.add_u64("cell_ordinal", value);
        }
        digest.add_u64("cell_marker_count", cell_markers.size());
        for (std::uint32_t value : cell_markers) {
            digest.add_u64("cell_marker", value);
        }
        digest.add_u64("facet_type_count", facet_types.size());
        for (std::uint32_t value : facet_types) {
            digest.add_u64("facet_type", value);
        }
        digest.add_u64("facet_role_count", facet_roles.size());
        for (std::uint32_t value : facet_roles) {
            digest.add_u64("facet_role", value);
        }
        digest.add_u64("facet_offset_count", facet_offsets.size());
        for (std::uint32_t value : facet_offsets) {
            digest.add_u64("facet_offset", value);
        }
        digest.add_u64("facet_node_count", facet_nodes.size());
        for (std::uint32_t value : facet_nodes) {
            digest.add_u64("facet_node", value);
        }
        digest.add_u64("facet_ordinal_count", facet_ordinals.size());
        for (std::uint64_t value : facet_ordinals) {
            digest.add_u64("facet_ordinal", value);
        }
        digest.add_u64("facet_marker_count", facet_markers.size());
        for (std::uint32_t value : facet_markers) {
            digest.add_u64("facet_marker", value);
        }
        digest.add_u64("periodic_pair_value_count", mesh_periodic_node_pairs.size());
        for (std::uint32_t value : mesh_periodic_node_pairs) {
            digest.add_u64("periodic_node_pair", value);
        }
        digest.add_u64("periodic_boundary_marker_count", periodic_boundary_markers.size());
        for (std::uint32_t value : periodic_boundary_markers) {
            digest.add_u64("periodic_boundary_marker", value);
        }
        return "sha256:" + digest.sha256_hex();
    }

    void expand_with_internal_magnetic_nodes(std::size_t internal_node_count)
    {
        if (internal_node_count == 0u) {
            return;
        }

        const std::array<double, 3> airbox_vertex{{
            nodes[12u], nodes[13u], nodes[14u]}};
        nodes.resize(12u);
        std::vector<std::array<std::uint32_t, 4>> magnetic_cells{{
            {{0u, 1u, 2u, 3u}}}};
        const auto coordinate = [this](
                                   std::uint32_t node,
                                   std::size_t axis) {
            return nodes[3u * static_cast<std::size_t>(node) + axis];
        };
        const auto signed_determinant = [&coordinate](
                                            const std::array<std::uint32_t, 4> &cell) {
            const double ax = coordinate(cell[1], 0u) - coordinate(cell[0], 0u);
            const double ay = coordinate(cell[1], 1u) - coordinate(cell[0], 1u);
            const double az = coordinate(cell[1], 2u) - coordinate(cell[0], 2u);
            const double bx = coordinate(cell[2], 0u) - coordinate(cell[0], 0u);
            const double by = coordinate(cell[2], 1u) - coordinate(cell[0], 1u);
            const double bz = coordinate(cell[2], 2u) - coordinate(cell[0], 2u);
            const double cx = coordinate(cell[3], 0u) - coordinate(cell[0], 0u);
            const double cy = coordinate(cell[3], 1u) - coordinate(cell[0], 1u);
            const double cz = coordinate(cell[3], 2u) - coordinate(cell[0], 2u);
            return ax * (by * cz - bz * cy) -
                ay * (bx * cz - bz * cx) +
                az * (bx * cy - by * cx);
        };

        for (std::size_t index = 0u; index < internal_node_count; ++index) {
            const std::array<std::uint32_t, 4> parent = magnetic_cells.front();
            magnetic_cells.erase(magnetic_cells.begin());
            const std::uint32_t center =
                static_cast<std::uint32_t>(nodes.size() / 3u);
            for (std::size_t axis = 0u; axis < 3u; ++axis) {
                nodes.push_back(0.25 * (
                    coordinate(parent[0], axis) + coordinate(parent[1], axis) +
                    coordinate(parent[2], axis) + coordinate(parent[3], axis)));
            }
            std::array<std::array<std::uint32_t, 4>, 4> children{{
                {{parent[0], parent[1], parent[2], center}},
                {{parent[0], center, parent[1], parent[3]}},
                {{parent[0], center, parent[2], parent[3]}},
                {{center, parent[1], parent[2], parent[3]}}}};
            for (std::array<std::uint32_t, 4> child : children) {
                if (signed_determinant(child) < 0.0) {
                    std::swap(child[0], child[1]);
                }
                check(
                    signed_determinant(child) > 0.0,
                    "expanded Floquet fixture subdivision must have positive tetrahedra");
                magnetic_cells.push_back(child);
            }
        }

        const std::uint32_t airbox_node =
            static_cast<std::uint32_t>(nodes.size() / 3u);
        nodes.insert(nodes.end(), airbox_vertex.begin(), airbox_vertex.end());
        cell_types.clear();
        cell_offsets.assign(1u, 0u);
        cell_nodes.clear();
        cell_ordinals.clear();
        cell_markers.clear();
        const auto append_cell = [this](
                                     const std::array<std::uint32_t, 4> &cell,
                                     std::uint32_t marker) {
            cell_types.push_back(FULLMAG_FEM_CELL_TET4);
            cell_nodes.insert(cell_nodes.end(), cell.begin(), cell.end());
            cell_offsets.push_back(static_cast<std::uint32_t>(cell_nodes.size()));
            cell_ordinals.push_back(static_cast<std::uint64_t>(cell_ordinals.size()));
            cell_markers.push_back(marker);
        };
        for (const auto &cell : magnetic_cells) {
            append_cell(cell, 1u);
        }
        append_cell({{0u, 2u, 1u, airbox_node}}, 0u);
        std::replace(facet_nodes.begin(), facet_nodes.end(), 4u, airbox_node);

        const std::size_t node_count = nodes.size() / 3u;
        const std::size_t magnetic_node_count = node_count - 1u;
        equilibrium.assign(3u * node_count, 0.0);
        for (std::size_t node = 0u; node < node_count; ++node) {
            equilibrium[3u * node + 2u] = 1.0;
        }
        h_eff = equilibrium;
        h_demag.assign(3u * node_count, 0.0);
        phi0.assign(node_count, 0.0);
        scalar_classes.assign(node_count, 0u);
        magnetic_classes.assign(
            node_count, std::numeric_limits<std::uint32_t>::max());
        for (std::size_t node = 0u; node < 4u; ++node) {
            magnetic_classes[node] = 0u;
        }
        for (std::size_t node = 4u; node < magnetic_node_count; ++node) {
            magnetic_classes[node] = static_cast<std::uint32_t>(node - 3u);
            scalar_classes[node] = static_cast<std::uint32_t>(node - 3u);
        }
        scalar_classes[airbox_node] =
            static_cast<std::uint32_t>(internal_node_count + 1u);
        magnetic_reduced_node_count =
            static_cast<std::uint64_t>(internal_node_count + 1u);
        scalar_reduced_node_count =
            static_cast<std::uint64_t>(internal_node_count + 2u);
        a_qq_offsets.assign(2u * node_count + 1u, 0u);

        descriptor_frames.assign(6u * node_count, 0.0);
        descriptor_external.assign(3u * node_count, 0.0);
        descriptor_alpha.assign(node_count, 0.01);
        for (std::size_t node = 0u; node < node_count; ++node) {
            descriptor_frames[6u * node] = 1.0;
            descriptor_frames[6u * node + 4u] = 1.0;
        }

        magnetic_certificate_regions.assign(magnetic_node_count, 1u);
        scalar_certificate_regions.assign(node_count, 2u);
        magnetic_boundary_axes.assign(magnetic_node_count, 0u);
        magnetic_boundary_axes[0] = 0u;
        magnetic_boundary_axes[1] = 1u;
        magnetic_boundary_axes[2] = 2u;
        magnetic_boundary_axes[3] = 7u;
        scalar_boundary_axes.assign(node_count, 0u);
        scalar_boundary_axes[0] = 0u;
        scalar_boundary_axes[1] = 1u;
        scalar_boundary_axes[2] = 2u;
        scalar_boundary_axes[3] = 7u;
        scalar_boundary_axes[airbox_node] = 4u;
    }

    void initialize(
        std::size_t internal_magnetic_nodes = 0u,
        bool bind_topology_fingerprints_to_mesh = false)
    {
        expand_with_internal_magnetic_nodes(internal_magnetic_nodes);
        const std::uint64_t mesh_node_count =
            static_cast<std::uint64_t>(nodes.size() / 3u);
        const std::uint64_t full_tangent_dof_count = 2u * mesh_node_count;

        mesh = fullmag_fem_mesh_desc{
            FULLMAG_FEM_MESH_DESC_ABI_VERSION,
            sizeof(fullmag_fem_mesh_desc),
            nodes.data(), nodes.size(),
            cell_types.data(), cell_types.size(),
            cell_offsets.data(), cell_offsets.size(),
            cell_nodes.data(), cell_nodes.size(),
            cell_ordinals.data(), cell_ordinals.size(),
            cell_markers.data(), cell_markers.size(),
            facet_types.data(), facet_types.size(),
            facet_roles.data(), facet_roles.size(),
            facet_offsets.data(), facet_offsets.size(),
            facet_nodes.data(), facet_nodes.size(),
            facet_ordinals.data(), facet_ordinals.size(),
            facet_markers.data(), facet_markers.size(),
            mesh_periodic_node_pairs.data(), mesh_periodic_node_pairs.size(),
            periodic_boundary_markers.data(), periodic_boundary_markers.size()};
        magnetic_topology_fingerprint = bind_topology_fingerprints_to_mesh
            ? mesh_topology_fingerprint("magnetic:film")
            : "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        scalar_topology_fingerprint = bind_topology_fingerprints_to_mesh
            ? mesh_topology_fingerprint("airbox:shared")
            : "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        for (std::uint64_t node = 0u; node < mesh_node_count; ++node) {
            descriptor_frames[6u * node] = 1.0;
            descriptor_frames[6u * node + 4u] = 1.0;
        }
        descriptor.abi_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION;
        descriptor.struct_size = sizeof(descriptor);
        descriptor.schema_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA;
        descriptor.node_count = mesh_node_count;
        descriptor.tangent_dof_count = full_tangent_dof_count;
        descriptor.coordinate_unit = "m";
        descriptor.magnetisation_unit = "A/m";
        descriptor.time_unit = "s";
        descriptor.frequency_unit = "Hz";
        descriptor.angular_frequency_unit = "rad/s";
        descriptor.linearization_state_digest = bind_topology_fingerprints_to_mesh
            ? magnetic_topology_fingerprint.c_str()
            : "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        descriptor.equilibrium_digest = descriptor.linearization_state_digest;
        descriptor.operator_input_digest = descriptor.linearization_state_digest;
        descriptor.term_presence_mask = 0u;
        descriptor.tangent_frame_xyz = descriptor_frames.data();
        descriptor.tangent_frame_xyz_count = descriptor_frames.size();
        descriptor.equilibrium_m0_xyz = equilibrium.data();
        descriptor.equilibrium_m0_xyz_count = equilibrium.size();
        descriptor.effective_field_h_eff0_xyz = h_eff.data();
        descriptor.effective_field_h_eff0_xyz_count = h_eff.size();
        descriptor.external_field_h_ext0_xyz = descriptor_external.data();
        descriptor.external_field_h_ext0_xyz_count = descriptor_external.size();
        descriptor.alpha_per_node = descriptor_alpha.data();
        descriptor.alpha_per_node_count = descriptor_alpha.size();
        descriptor.uniform_saturation_magnetisation_a_per_m = 2.0;

        c_certificate.schema_version = "periodic_mesh_certificate.v6";
        c_certificate.mesh_magnetic = make_c_view(
            1u, 1u, "magnetic:film",
            magnetic_topology_fingerprint.c_str(),
            static_cast<std::uint64_t>(magnetic_certificate_regions.size()),
            magnetic_certificate_regions.data(), magnetic_boundary_axes.data(),
            magnetic_roles, 1u, magnetic_generators, 3u, magnetic_closure, 6u);
        c_certificate.payload_magnetic = make_c_view(
            2u, 1u, "magnetic:film",
            magnetic_topology_fingerprint.c_str(),
            static_cast<std::uint64_t>(magnetic_certificate_regions.size()),
            magnetic_certificate_regions.data(), magnetic_boundary_axes.data(),
            magnetic_roles, 1u, magnetic_generators, 3u, magnetic_closure, 6u);
        c_certificate.mesh_scalar = make_c_view(
            1u, 2u, "airbox:shared",
            scalar_topology_fingerprint.c_str(),
            static_cast<std::uint64_t>(scalar_certificate_regions.size()),
            scalar_certificate_regions.data(), scalar_boundary_axes.data(),
            scalar_roles, 1u, scalar_generators, 3u, scalar_closure, 6u);
        c_certificate.payload_scalar = make_c_view(
            2u, 2u, "airbox:shared",
            scalar_topology_fingerprint.c_str(),
            static_cast<std::uint64_t>(scalar_certificate_regions.size()),
            scalar_certificate_regions.data(), scalar_boundary_axes.data(),
            scalar_roles, 1u, scalar_generators, 3u, scalar_closure, 6u);
        c_views[0] = c_certificate.mesh_magnetic;
        c_views[1] = c_certificate.payload_magnetic;
        c_views[2] = c_certificate.mesh_scalar;
        c_views[3] = c_certificate.payload_scalar;

        fd::MeshSymmetryCertificateV6BindingRequest binding_request{};
        binding_request.schema_version = c_certificate.schema_version;
        binding_request.mesh_generation_identity = "mesh-generation:fixture";
        binding_request.mesh_magnetic = typed_view(c_views[0]);
        binding_request.payload_magnetic = typed_view(c_views[1]);
        binding_request.mesh_scalar = typed_view(c_views[2]);
        binding_request.payload_scalar = typed_view(c_views[3]);
        binding_request.payload_binding_digest = bind_topology_fingerprints_to_mesh
            ? magnetic_topology_fingerprint.c_str()
            : "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        fd::MeshSymmetryCertificateV6Binding bootstrap{};
        check(fd::verify_mesh_symmetry_certificate_v6(binding_request, bootstrap) !=
                  fd::FrequencyDomainStatus::ok,
              "contour fixture bootstrap must reject missing payload class metadata");
        check(bootstrap.magnetic_canonical_class_ids.size() ==
                      magnetic_certificate_regions.size() &&
                  bootstrap.scalar_canonical_class_ids.size() ==
                      scalar_certificate_regions.size(),
              "contour fixture bootstrap must derive both canonical class maps");
        magnetic_expected_class_ids = bootstrap.magnetic_canonical_class_ids;
        scalar_expected_class_ids = bootstrap.scalar_canonical_class_ids;
        magnetic_expected_class_digest_strings = bootstrap.magnetic_class_digests;
        scalar_expected_class_digest_strings = bootstrap.scalar_class_digests;
        /* Class digests are ordered by canonical first-node IDs, which may have gaps. */
        const auto populate_expected_class_digests = [](
                                                        const std::vector<std::uint64_t> &ids,
                                                        const std::vector<std::string> &digests,
                                                        std::vector<FullmagFemModalCertificateV6ClassDigest> &out) {
            std::vector<std::uint64_t> canonical_ids = ids;
            std::sort(canonical_ids.begin(), canonical_ids.end());
            canonical_ids.erase(
                std::unique(canonical_ids.begin(), canonical_ids.end()),
                canonical_ids.end());
            check(canonical_ids.size() == digests.size(),
                  "expanded certificate must have one digest per canonical class");
            out.clear();
            out.reserve(digests.size());
            for (std::size_t index = 0u; index < canonical_ids.size(); ++index) {
                const std::uint64_t canonical_id = canonical_ids[index];
                check(canonical_id < ids.size() && ids[canonical_id] == canonical_id,
                      "each expanded certificate class must identify its first node");
                const std::uint64_t count = static_cast<std::uint64_t>(
                    std::count(ids.begin(), ids.end(), canonical_id));
                out.push_back({canonical_id, count, digests[index].c_str()});
            }
        };
        populate_expected_class_digests(
            magnetic_expected_class_ids,
            magnetic_expected_class_digest_strings,
            magnetic_expected_class_digests);
        populate_expected_class_digests(
            scalar_expected_class_ids,
            scalar_expected_class_digest_strings,
            scalar_expected_class_digests);
        c_certificate.payload_magnetic.expected_class_ids = magnetic_expected_class_ids.data();
        c_certificate.payload_magnetic.expected_class_id_count = magnetic_expected_class_ids.size();
        c_certificate.payload_magnetic.expected_class_digests =
            magnetic_expected_class_digests.data();
        c_certificate.payload_magnetic.expected_class_digest_count =
            magnetic_expected_class_digests.size();
        c_certificate.payload_scalar.expected_class_ids = scalar_expected_class_ids.data();
        c_certificate.payload_scalar.expected_class_id_count = scalar_expected_class_ids.size();
        c_certificate.payload_scalar.expected_class_digests = scalar_expected_class_digests.data();
        c_certificate.payload_scalar.expected_class_digest_count = scalar_expected_class_digests.size();
        c_views[1] = c_certificate.payload_magnetic;
        c_views[3] = c_certificate.payload_scalar;
        binding_request.payload_magnetic = typed_view(c_views[1]);
        binding_request.payload_scalar = typed_view(c_views[3]);
        fd::MeshSymmetryCertificateV6Binding final_binding{};
        check(fd::verify_mesh_symmetry_certificate_v6(binding_request, final_binding) !=
                  fd::FrequencyDomainStatus::ok &&
                  !final_binding.canonical_preimage.empty(),
              "contour fixture must expose the canonical preimage before digest binding");
        canonical_preimage = final_binding.canonical_preimage;
        canonical_preimage_digest = final_binding.canonical_preimage_sha256;
        magnetic_class_digest = final_binding.magnetic_class_digest_sha256;
        scalar_class_digest = final_binding.scalar_class_digest_sha256;
        binding_request.payload_binding_digest = canonical_preimage_digest.c_str();
        check(fd::verify_mesh_symmetry_certificate_v6(
                  binding_request, accepted_certificate) == fd::FrequencyDomainStatus::ok &&
                  accepted_certificate.accepted,
              "contour fixture must produce an accepted v6 binding");

        payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
        payload.struct_size = sizeof(payload);
        payload.mesh = &mesh;
        payload.equilibrium_m0_xyz = equilibrium.data();
        payload.equilibrium_m0_xyz_count = equilibrium.size();
        payload.linearization_m0_xyz = equilibrium.data();
        payload.linearization_m0_xyz_count = equilibrium.size();
        payload.linearization_h_eff0_xyz = h_eff.data();
        payload.linearization_h_eff0_xyz_count = h_eff.size();
        payload.linearization_h_demag0_xyz = h_demag.data();
        payload.linearization_h_demag0_xyz_count = h_demag.size();
        payload.linearization_phi0 = phi0.data();
        payload.linearization_phi0_count = phi0.size();
        payload.uniform_saturation_magnetisation_a_per_m = 2.0;
        payload.gamma0_m_per_a_s = 3.0;
        payload.magnetic_a_qq_csr = FullmagFemCsrMatrixView{
            full_tangent_dof_count, full_tangent_dof_count,
            a_qq_offsets.data(), a_qq_offsets.size(),
            nullptr, 0u, nullptr, 0u};
        payload.scalar_reduced_node = scalar_classes.data();
        payload.scalar_reduced_node_count = scalar_reduced_node_count;
        payload.magnetic_reduced_node = magnetic_classes.data();
        payload.magnetic_reduced_node_count = magnetic_reduced_node_count;
        payload.magnetic_pair_count = 6u;
        payload.airbox_pair_count = 6u;
        payload.boundary_kind = "robin";
        payload.robin_beta = 1.0;
        payload.boundary_marker = 1u;
        payload.mesh_certificate_schema = c_certificate.schema_version;
        payload.equilibrium_digest = bind_topology_fingerprints_to_mesh
            ? magnetic_topology_fingerprint.c_str()
            : "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        payload.mesh_certificate_digest = bind_topology_fingerprints_to_mesh
            ? canonical_preimage_digest.c_str()
            : payload.equilibrium_digest;
        payload.linearization_state_digest = bind_topology_fingerprints_to_mesh
            ? scalar_topology_fingerprint.c_str()
            : payload.equilibrium_digest;
        payload.equilibrium_id = "equilibrium_artifact.v7:contour-fixture";
        payload.mesh_snapshot_id = "mesh-snapshot:contour-fixture";
        payload.material_snapshot_id = "material-snapshot:contour-fixture";
        payload.physics_snapshot_id = "physics-snapshot:contour-fixture";
        payload.boundary_snapshot_id = "boundary-snapshot:contour-fixture";
        payload.producer_run_id = "producer-run:contour-fixture";
        payload.equilibrium_content_sha256 = payload.equilibrium_digest;
        payload.demag_model = "floquet_airbox";
        payload.m0_norm_tolerance = 1.0e-8;
        payload.equilibrium_torque_relative_tolerance = 0.0;
        payload.boundary_gauge_digest = bind_topology_fingerprints_to_mesh
            ? scalar_topology_fingerprint.c_str()
            : payload.equilibrium_digest;
        payload.bias_field_sample_id = "bias-field-sample:contour-fixture";
        payload.bias_field_sample_signature = bind_topology_fingerprints_to_mesh
            ? magnetic_topology_fingerprint.c_str()
            : payload.equilibrium_digest;
        payload.magnetic_part_identity = "magnetic:film";
        payload.airbox_part_identity = "airbox:shared";
        payload.mesh_generation_identity = "mesh-generation:fixture";
        payload.canonical_preimage = canonical_preimage.c_str();
        payload.canonical_preimage_len = canonical_preimage.size();
        payload.canonical_preimage_sha256 = canonical_preimage_digest.c_str();
        payload.magnetic_class_digest_sha256 = magnetic_class_digest.c_str();
        payload.scalar_class_digest_sha256 = scalar_class_digest.c_str();
        payload.certificate_binding_status = FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED;
        payload.certificate_binding_reason = "none";
        payload.certificate_binding_v6 = &c_certificate;
        payload.linearization_descriptor = &descriptor;
        payload.acceptance_criterion = "energy";
        payload.acceptance_metric_kind = "total_energy_plateau_range_j";
        payload.acceptance_unit = "J";
        payload.acceptance_metric_value = 2.5e-19;
        payload.acceptance_threshold = 1.0e-18;
        payload.acceptance_certificate_sha256 = bind_topology_fingerprints_to_mesh
            ? canonical_preimage_digest.c_str()
            : "sha256:2222222222222222222222222222222222222222222222222222222222222222";
        char map_error[256]{};
        check(fd::compute_modal_shared_domain_map_binding_digest(
                  payload, accepted_certificate,
                  static_cast<std::uint64_t>(magnetic_certificate_regions.size()),
                  map_binding_digest, map_error) ==
                  fd::FrequencyDomainStatus::ok,
              map_error);
        payload.mesh_certificate_map_binding_digest = map_binding_digest.c_str();

        const std::array<std::array<double, 3>, 3> translations{{
            {{1.0, 0.0, 0.0}}, {{0.0, 1.0, 0.0}}, {{0.0, 0.0, 1.0}}}};
        const std::array<std::pair<std::uint64_t, std::uint64_t>, 3> endpoints{{
            {0u, 1u}, {0u, 2u}, {0u, 3u}}};
        const char *pair_ids[3] = {
            "x_periodic_pair_0", "y_periodic_pair_0", "z_periodic_pair_0"};
        for (std::size_t index = 0u; index < 3u; ++index) {
            c_pairs[index].pair_id = pair_ids[index];
            c_pairs[index].node_a = endpoints[index].first;
            c_pairs[index].node_b = endpoints[index].second;
            c_pairs[index].has_translation = 1;
            for (std::size_t axis = 0u; axis < 3u; ++axis) {
                c_pairs[index].translation_m[axis] = translations[index][axis];
            }
            native_pairs[index].pair_id = pair_ids[index];
            native_pairs[index].node_a = endpoints[index].first;
            native_pairs[index].node_b = endpoints[index].second;
            native_pairs[index].has_translation = true;
            for (std::size_t axis = 0u; axis < 3u; ++axis) {
                native_pairs[index].translation_m[axis] = translations[index][axis];
            }
        }
    }
};

constexpr std::uint32_t kFixtureInactiveClass =
    std::numeric_limits<std::uint32_t>::max();

struct CanonicalFixturePartition {
    std::vector<std::uint32_t> node_class{};
    std::vector<std::uint32_t> class_representatives{};
    std::vector<std::uint32_t> raw_class_ids_by_canonical{};
};

CanonicalFixturePartition canonical_fixture_partition(
    const std::vector<std::uint32_t> &raw_classes,
    std::uint32_t inactive_class = kFixtureInactiveClass)
{
    CanonicalFixturePartition result{};
    result.node_class.assign(raw_classes.size(), inactive_class);
    std::uint32_t maximum_class = 0u;
    bool has_active_class = false;
    for (std::uint32_t class_id : raw_classes) {
        if (class_id == inactive_class) {
            continue;
        }
        maximum_class = std::max(maximum_class, class_id);
        has_active_class = true;
    }
    if (!has_active_class) {
        return result;
    }

    std::vector<std::uint32_t> representative_by_raw(
        static_cast<std::size_t>(maximum_class) + 1u,
        inactive_class);
    for (std::size_t node = 0u; node < raw_classes.size(); ++node) {
        const std::uint32_t class_id = raw_classes[node];
        if (class_id == inactive_class) {
            continue;
        }
        std::uint32_t &representative = representative_by_raw[class_id];
        representative = representative == inactive_class
            ? static_cast<std::uint32_t>(node)
            : std::min(representative, static_cast<std::uint32_t>(node));
    }

    std::vector<std::pair<std::uint32_t, std::uint32_t>> ordered_classes;
    for (std::uint32_t class_id = 0u;
         class_id < representative_by_raw.size();
         ++class_id) {
        if (representative_by_raw[class_id] != inactive_class) {
            ordered_classes.emplace_back(representative_by_raw[class_id], class_id);
        }
    }
    std::sort(ordered_classes.begin(), ordered_classes.end());
    std::vector<std::uint32_t> canonical_by_raw(representative_by_raw.size(), inactive_class);
    for (std::size_t canonical = 0u; canonical < ordered_classes.size(); ++canonical) {
        result.class_representatives.push_back(ordered_classes[canonical].first);
        result.raw_class_ids_by_canonical.push_back(ordered_classes[canonical].second);
        canonical_by_raw[ordered_classes[canonical].second] =
            static_cast<std::uint32_t>(canonical);
    }
    for (std::size_t node = 0u; node < raw_classes.size(); ++node) {
        if (raw_classes[node] != inactive_class) {
            result.node_class[node] = canonical_by_raw[raw_classes[node]];
        }
    }
    return result;
}

void add_digest_doubles(
    fd::CanonicalDigestBuilder &digest,
    std::string_view field,
    const std::vector<double> &values)
{
    const std::string count_field = std::string(field) + ".count";
    digest.add_u64(count_field, values.size());
    for (double value : values) {
        digest.add_double(field, value);
    }
}

void add_digest_u32s(
    fd::CanonicalDigestBuilder &digest,
    std::string_view field,
    const std::vector<std::uint32_t> &values)
{
    const std::string count_field = std::string(field) + ".count";
    digest.add_u64(count_field, values.size());
    for (std::uint32_t value : values) {
        digest.add_u64(field, value);
    }
}

std::vector<double> dense_real_csr(
    const fd::PoissonAirboxSharedDomainCsrMatrix &matrix)
{
    std::vector<double> dense(
        static_cast<std::size_t>(matrix.row_count * matrix.column_count), 0.0);
    if (matrix.row_offsets.size() != static_cast<std::size_t>(matrix.row_count + 1u)) {
        return {};
    }
    for (std::uint64_t row = 0u; row < matrix.row_count; ++row) {
        for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
             entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            if (entry >= matrix.values.size() || entry >= matrix.column_indices.size() ||
                matrix.column_indices[entry] >= matrix.column_count) {
                return {};
            }
            dense[static_cast<std::size_t>(
                row * matrix.column_count + matrix.column_indices[entry])] =
                matrix.values[entry];
        }
    }
    return dense;
}

std::complex<double> complex_csr_value(
    const fd::PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    std::uint64_t row,
    std::uint64_t column)
{
    if (row >= matrix.row_count || column >= matrix.column_count ||
        matrix.row_offsets.size() != static_cast<std::size_t>(matrix.row_count + 1u)) {
        return {};
    }
    for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
         entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
         ++entry) {
        if (entry >= matrix.values.size() || entry >= matrix.column_indices.size()) {
            return {};
        }
        if (matrix.column_indices[entry] == column) {
            return matrix.values[entry];
        }
    }
    return {};
}

std::vector<double> complex_csr_to_real_split(
    const fd::PoissonAirboxSharedDomainComplexCsrMatrix &matrix)
{
    if (matrix.row_count == 0u || matrix.row_count != matrix.column_count ||
        matrix.row_count > std::numeric_limits<std::size_t>::max() / 2u) {
        return {};
    }
    const std::size_t complex_dimension = static_cast<std::size_t>(matrix.row_count);
    const std::size_t dimension = 2u * complex_dimension;
    std::vector<double> real_split(dimension * dimension, 0.0);
    for (std::size_t row = 0u; row < complex_dimension; ++row) {
        for (std::size_t column = 0u; column < complex_dimension; ++column) {
            const std::complex<double> value = complex_csr_value(
                matrix, row, column);
            real_split[row * dimension + column] = value.real();
            real_split[row * dimension + complex_dimension + column] = -value.imag();
            real_split[(complex_dimension + row) * dimension + column] = value.imag();
            real_split[(complex_dimension + row) * dimension + complex_dimension + column] =
                value.real();
        }
    }
    return real_split;
}

bool symmetric_min_eigenvalue(
    std::vector<double> matrix,
    std::size_t dimension,
    double &out_minimum,
    double &out_scale,
    double &out_asymmetry)
{
    if (dimension == 0u || matrix.size() != dimension * dimension) {
        return false;
    }
    out_scale = 0.0;
    out_asymmetry = 0.0;
    for (std::size_t row = 0u; row < dimension; ++row) {
        for (std::size_t column = 0u; column < dimension; ++column) {
            const double value = matrix[row * dimension + column];
            if (!std::isfinite(value)) {
                return false;
            }
            out_scale = std::max(out_scale, std::abs(value));
        }
    }
    for (std::size_t row = 0u; row < dimension; ++row) {
        for (std::size_t column = row + 1u; column < dimension; ++column) {
            double &upper = matrix[row * dimension + column];
            double &lower = matrix[column * dimension + row];
            out_asymmetry = std::max(out_asymmetry, std::abs(upper - lower));
            upper = lower = 0.5 * (upper + lower);
        }
    }

    if (out_scale == 0.0) {
        out_minimum = 0.0;
        return true;
    }
    const double stopping_tolerance = 1.0e-14 * out_scale;
    const std::size_t iteration_limit = 100u * dimension * dimension;
    bool converged = false;
    for (std::size_t iteration = 0u; iteration < iteration_limit; ++iteration) {
        std::size_t p = 0u;
        std::size_t q = 0u;
        double largest_off_diagonal = 0.0;
        for (std::size_t row = 0u; row < dimension; ++row) {
            for (std::size_t column = row + 1u; column < dimension; ++column) {
                const double magnitude =
                    std::abs(matrix[row * dimension + column]);
                if (magnitude > largest_off_diagonal) {
                    largest_off_diagonal = magnitude;
                    p = row;
                    q = column;
                }
            }
        }
        if (largest_off_diagonal <= stopping_tolerance) {
            converged = true;
            break;
        }
        const double app = matrix[p * dimension + p];
        const double aqq = matrix[q * dimension + q];
        const double apq = matrix[p * dimension + q];
        const double tau = (aqq - app) / (2.0 * apq);
        const double t = std::copysign(
            1.0 / (std::abs(tau) + std::sqrt(1.0 + tau * tau)), tau);
        const double cosine = 1.0 / std::sqrt(1.0 + t * t);
        const double sine = t * cosine;
        matrix[p * dimension + p] = app - t * apq;
        matrix[q * dimension + q] = aqq + t * apq;
        matrix[p * dimension + q] = 0.0;
        matrix[q * dimension + p] = 0.0;
        for (std::size_t index = 0u; index < dimension; ++index) {
            if (index == p || index == q) {
                continue;
            }
            const double aip = matrix[index * dimension + p];
            const double aiq = matrix[index * dimension + q];
            const double rotated_p = cosine * aip - sine * aiq;
            const double rotated_q = sine * aip + cosine * aiq;
            matrix[index * dimension + p] = rotated_p;
            matrix[p * dimension + index] = rotated_p;
            matrix[index * dimension + q] = rotated_q;
            matrix[q * dimension + index] = rotated_q;
        }
    }
    if (!converged) {
        return false;
    }
    out_minimum = matrix[0];
    for (std::size_t index = 1u; index < dimension; ++index) {
        out_minimum = std::min(out_minimum, matrix[index * dimension + index]);
    }
    return std::isfinite(out_minimum);
}

void initialize_native_count_fixture(FloquetContourSharedDomainFixture &fixture)
{
    constexpr double saturation_a_per_m = 2.0;
    constexpr double gamma0_m_per_a_s = 3.0;
    constexpr double bias_a_per_m = 100.0;
    constexpr double mu0_t_m_a = 4.0e-7 * 3.14159265358979323846;
    const std::size_t node_count = fixture.nodes.size() / 3u;
    const std::size_t magnetic_node_count = node_count - 1u;

    fullmag::fem::Context context{};
    std::string error;
    check(
        fullmag::fem::initialize_mesh_plan_fields(context, fixture.mesh, error),
        error.c_str());
    check(context.mesh.n_nodes == node_count &&
              context.mesh.n_elements == fixture.cell_markers.size() &&
              context.mesh.periodic_reduced_node.size() == node_count,
          "native static fixture imports the exact shared-domain mesh and periodic classes");

    context.mesh.magnetic_element_mask.assign(context.mesh.n_elements, 0u);
    context.mesh.magnetic_node_mask.assign(context.mesh.n_nodes, 0u);
    for (std::size_t element = 0u; element < context.mesh.cell_markers.size(); ++element) {
        if (context.mesh.cell_markers[element] != 1u) {
            continue;
        }
        context.mesh.magnetic_element_mask[element] = 1u;
        const std::uint32_t begin = context.mesh.cell_offsets[element];
        const std::uint32_t end = context.mesh.cell_offsets[element + 1u];
        for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
            context.mesh.magnetic_node_mask[context.mesh.cell_nodes[cursor]] = 1u;
        }
    }
    check(
        std::count(
            context.mesh.magnetic_node_mask.begin(),
            context.mesh.magnetic_node_mask.end(),
            static_cast<std::uint8_t>(1u)) ==
            static_cast<std::ptrdiff_t>(magnetic_node_count),
        "native static fixture marks the same magnetic node prefix as the payload");

    const CanonicalFixturePartition static_partition =
        canonical_fixture_partition(context.mesh.periodic_reduced_node);
    const CanonicalFixturePartition payload_partition =
        canonical_fixture_partition(fixture.scalar_classes);
    const CanonicalFixturePartition magnetic_partition =
        canonical_fixture_partition(fixture.magnetic_classes);
    check(static_partition.node_class == payload_partition.node_class &&
              static_partition.class_representatives ==
                  payload_partition.class_representatives,
          "static Context and modal payload share the same canonical scalar equivalence partition");
    check(static_partition.class_representatives.size() == 7u &&
              magnetic_partition.class_representatives.size() == 6u,
          "physical count fixture preserves six magnetic and seven scalar classes");
    for (std::size_t node = 0u; node < magnetic_node_count; ++node) {
        check(static_partition.node_class[node] == magnetic_partition.node_class[node],
              "static scalar and magnetic partitions agree on every magnetic node");
    }
    fixture.static_scalar_class_representatives =
        static_partition.class_representatives;
    fixture.static_scalar_raw_ids_by_canonical =
        static_partition.raw_class_ids_by_canonical;
    fixture.static_scalar_raw_node_classes = context.mesh.periodic_reduced_node;

    std::unique_ptr<mfem::Mesh> native_mesh;
    check(
        fullmag::fem::build_mfem_mesh(context.mesh, native_mesh, error),
        error.c_str());
    check(native_mesh != nullptr && native_mesh->GetNV() == static_cast<int>(node_count),
          "native static Poisson uses the same expanded MFEM mesh as the modal importer");

    const int maximum_boundary_attribute = native_mesh->bdr_attributes.Max();
    check(maximum_boundary_attribute >= 8,
          "physical fixture contains the explicit Robin and periodic seam attributes");
    std::vector<int> static_robin_marker(
        static_cast<std::size_t>(maximum_boundary_attribute), 0);
    std::vector<int> dynamic_robin_marker(
        static_cast<std::size_t>(maximum_boundary_attribute), 0);
    static_robin_marker[0] = 1;
    dynamic_robin_marker[0] = 1;
    for (std::uint32_t periodic_marker : context.mesh.periodic_boundary_marker_set) {
        if (periodic_marker == 0u || periodic_marker >
                static_cast<std::uint32_t>(maximum_boundary_attribute)) {
            continue;
        }
        static_robin_marker[periodic_marker - 1u] = 0;
        dynamic_robin_marker[periodic_marker - 1u] = 0;
    }
    check(static_robin_marker == dynamic_robin_marker,
          "static and shared-domain owners select Robin boundaries with the same marker policy");

    std::vector<std::array<std::uint32_t, 3>> expected_active_faces;
    for (std::size_t facet = 0u; facet < fixture.facet_markers.size(); ++facet) {
        if (fixture.facet_roles[facet] != FULLMAG_FEM_FACET_ROLE_EXTERIOR ||
            fixture.facet_markers[facet] != 1u) {
            continue;
        }
        std::array<std::uint32_t, 3> vertices{};
        const std::size_t offset = fixture.facet_offsets[facet];
        std::copy_n(fixture.facet_nodes.begin() +
                        static_cast<std::ptrdiff_t>(offset),
                    3u,
                    vertices.begin());
        std::sort(vertices.begin(), vertices.end());
        expected_active_faces.push_back(vertices);
    }
    std::vector<std::array<std::uint32_t, 3>> actual_active_faces;
    std::size_t marker1_face_count = 0u;
    std::size_t marker7_face_count = 0u;
    std::size_t marker8_face_count = 0u;
    for (int boundary = 0; boundary < native_mesh->GetNBE(); ++boundary) {
        const int attribute = native_mesh->GetBdrAttribute(boundary);
        marker1_face_count += attribute == 1 ? 1u : 0u;
        marker7_face_count += attribute == 7 ? 1u : 0u;
        marker8_face_count += attribute == 8 ? 1u : 0u;
        if (attribute <= 0 ||
            static_robin_marker[static_cast<std::size_t>(attribute - 1)] == 0) {
            continue;
        }
        mfem::Array<int> vertices;
        native_mesh->GetBdrElementVertices(boundary, vertices);
        check(vertices.Size() == 3,
              "physical Robin boundary contains only the fixture's triangular facets");
        std::array<std::uint32_t, 3> face{{
            static_cast<std::uint32_t>(vertices[0]),
            static_cast<std::uint32_t>(vertices[1]),
            static_cast<std::uint32_t>(vertices[2])}};
        std::sort(face.begin(), face.end());
        actual_active_faces.push_back(face);
    }
    std::sort(expected_active_faces.begin(), expected_active_faces.end());
    std::sort(actual_active_faces.begin(), actual_active_faces.end());
    check(marker1_face_count == 4u && marker7_face_count == 1u &&
              marker8_face_count == 1u &&
              actual_active_faces == expected_active_faces,
          "Robin marker 1 selects exactly the four exterior faces and excludes seam markers 7/8");

    context.base_plan.fe_order = 1u;
    context.mfem_context.mesh = native_mesh.get();
    std::unique_ptr<mfem::H1_FECollection> state_fec =
        std::make_unique<mfem::H1_FECollection>(1, native_mesh->Dimension());
    std::unique_ptr<mfem::FiniteElementSpace> state_fes =
        std::make_unique<mfem::FiniteElementSpace>(native_mesh.get(), state_fec.get());
    context.mfem_context.fec = state_fec.get();
    context.mfem_context.fes = state_fes.get();
    check(state_fes->GetNDofs() == static_cast<int>(node_count),
          "native static magnetization space remains global-node P1");
    context.demag.enabled = true;
    context.demag.realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    context.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    context.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
    context.demag.solver.relative_tolerance = 1.0e-12;
    context.demag.solver.max_iterations = 500;
    context.material_fields.material.saturation_magnetisation = saturation_a_per_m;
    context.poisson_demag.boundary_marker = 1;
    context.poisson_demag.robin_beta_mode = 0;
    context.poisson_demag.robin_beta_factor = 1.0;
    context.cpu_threads.effective_omp_threads = 1;
    const bool initialized = fullmag::fem::context_initialize_poisson(context, error);
    if (!initialized) {
        std::fprintf(stderr, "FAIL: native static Poisson initialization: %s\n", error.c_str());
    }
    check(initialized, "native static Poisson owner initializes for the count mesh");
    fixture.static_scalar_order = context.poisson_demag.potential_order;
    fixture.static_robin_beta = context.poisson_demag.robin_effective_beta;
    check(context.poisson_demag.potential_order == 1 &&
              context.poisson_demag.periodic_reduced_ready &&
              std::abs(context.poisson_demag.robin_effective_beta - 1.0) <= 1.0e-14,
          "static Poisson uses P1 periodic reduction and the shared Robin beta without a gauge pin");

    auto *full_robin_matrix =
        static_cast<mfem::SparseMatrix *>(context.poisson_demag.poisson_bc_op);
    auto *diffusion_form =
        static_cast<mfem::BilinearForm *>(context.poisson_demag.poisson_bilinear);
    check(full_robin_matrix != nullptr && diffusion_form != nullptr &&
              node_count == 10u &&
              full_robin_matrix->Height() == static_cast<int>(node_count) &&
              full_robin_matrix->Width() == static_cast<int>(node_count),
          "native Robin fixture retains the full ten-node Poisson operator");
    const auto matrix_entry = [](const mfem::SparseMatrix &matrix, int row, int column) {
        mfem::Array<int> columns;
        mfem::Vector values;
        matrix.GetRow(row, columns, values);
        for (int entry = 0; entry < columns.Size(); ++entry) {
            if (columns[entry] == column) {
                return static_cast<double>(values[entry]);
            }
        }
        return 0.0;
    };
    const mfem::SparseMatrix &diffusion_matrix = diffusion_form->SpMat();
    const int air_node_index = static_cast<int>(node_count - 1u);
    constexpr int magnetic_node_index_1 = 1;
    constexpr int magnetic_node_index_2 = 2;
    const double diffusion_9_1 =
        matrix_entry(diffusion_matrix, air_node_index, magnetic_node_index_1);
    const double diffusion_1_9 =
        matrix_entry(diffusion_matrix, magnetic_node_index_1, air_node_index);
    const double diffusion_9_2 =
        matrix_entry(diffusion_matrix, air_node_index, magnetic_node_index_2);
    const double diffusion_2_9 =
        matrix_entry(diffusion_matrix, magnetic_node_index_2, air_node_index);
    check(diffusion_9_1 == 0.0 && diffusion_1_9 == 0.0 &&
              diffusion_9_2 == 0.0 && diffusion_2_9 == 0.0,
          "zero-based air node 9 has no volume-diffusion coupling to magnetic nodes 1 or 2");

    const double expected_robin_coupling =
        context.poisson_demag.robin_effective_beta *
        (1.0 + std::sqrt(3.0)) / 24.0;
    const double robin_entry_tolerance =
        1.0e-12 * std::max(1.0, std::abs(expected_robin_coupling));
    const double robin_9_1 =
        matrix_entry(*full_robin_matrix, air_node_index, magnetic_node_index_1);
    const double robin_1_9 =
        matrix_entry(*full_robin_matrix, magnetic_node_index_1, air_node_index);
    const double robin_9_2 =
        matrix_entry(*full_robin_matrix, air_node_index, magnetic_node_index_2);
    const double robin_2_9 =
        matrix_entry(*full_robin_matrix, magnetic_node_index_2, air_node_index);
    const auto matches_robin_integral = [&](double value) {
        return value > 0.0 &&
            std::abs(value - expected_robin_coupling) <= robin_entry_tolerance;
    };
    check(matches_robin_integral(robin_9_1) &&
              matches_robin_integral(robin_1_9) &&
              matches_robin_integral(robin_9_2) &&
              matches_robin_integral(robin_2_9) &&
              std::abs(robin_9_1 - robin_1_9) <= robin_entry_tolerance &&
              std::abs(robin_9_2 - robin_2_9) <= robin_entry_tolerance,
          "full-node Robin operator retains symmetric fill-in at air index 9 and magnetic indices 1 and 2");

    const std::size_t scalar_class_count =
        context.mesh.periodic_reduced_node_count;
    auto *static_poisson_matrix =
        static_cast<mfem::SparseMatrix *>(context.poisson_demag.periodic_matrix);
    check(static_poisson_matrix != nullptr &&
              static_poisson_matrix->Height() == static_cast<int>(scalar_class_count) &&
              static_poisson_matrix->Width() == static_cast<int>(scalar_class_count),
          "static Poisson owner exposes the actual periodic-reduced Robin operator");
    std::vector<double> static_poisson_raw(
        scalar_class_count * scalar_class_count, 0.0);
    mfem::Array<int> row_columns;
    mfem::Vector row_values;
    for (int row = 0; row < static_poisson_matrix->Height(); ++row) {
        static_poisson_matrix->GetRow(row, row_columns, row_values);
        for (int entry = 0; entry < row_columns.Size(); ++entry) {
            static_poisson_raw[static_cast<std::size_t>(
                row * static_poisson_matrix->Width() + row_columns[entry])] =
                row_values[entry];
        }
    }
    fixture.static_reduced_poisson_matrix.assign(
        scalar_class_count * scalar_class_count, 0.0);
    for (std::size_t row = 0u; row < scalar_class_count; ++row) {
        const std::uint32_t raw_row =
            static_partition.raw_class_ids_by_canonical[row];
        for (std::size_t column = 0u; column < scalar_class_count; ++column) {
            const std::uint32_t raw_column =
                static_partition.raw_class_ids_by_canonical[column];
            fixture.static_reduced_poisson_matrix[
                row * scalar_class_count + column] = static_poisson_raw[
                    static_cast<std::size_t>(raw_row) * scalar_class_count + raw_column];
        }
    }

    mfem::Array<int> magnetic_attributes(native_mesh->attributes.Max());
    check(magnetic_attributes.Size() >= 1,
          "native static fixture has the magnetic MFEM volume attribute");
    magnetic_attributes = 0;
    magnetic_attributes[0] = 1;
    mfem::BilinearForm lumped_mass_form(state_fes.get());
    lumped_mass_form.AddDomainIntegrator(
        new mfem::MassIntegrator(), magnetic_attributes);
    lumped_mass_form.Assemble();
    lumped_mass_form.Finalize();
    mfem::Vector mass_ones(static_cast<int>(node_count));
    mfem::Vector lumped_mass_weights(static_cast<int>(node_count));
    mass_ones = 1.0;
    lumped_mass_form.Mult(mass_ones, lumped_mass_weights);
    lumped_mass_weights.HostRead();
    check(lumped_mass_weights.Size() == static_cast<int>(node_count),
          "native static state produces a full-node geometric P1 lumped mass on the same mesh");
    context.integration_weights.mfem_lumped_mass.assign(
        node_count, 0.0);
    std::vector<double> magnetic_lumped_mass(magnetic_node_count, 0.0);
    for (std::size_t node = 0u; node < node_count; ++node) {
        const double weight = lumped_mass_weights[static_cast<int>(node)];
        check(std::isfinite(weight) && weight >= 0.0,
              "native geometric P1 lumped-mass row sum is finite and non-negative");
        context.integration_weights.mfem_lumped_mass[node] = weight;
        if (node < magnetic_node_count) {
            magnetic_lumped_mass[node] = weight;
            check(weight > 0.0,
                  "native magnetic P1 lumped-mass weight is positive");
        } else {
            check(weight == 0.0,
                  "air-only node has no magnetic mass row sum");
        }
    }
    check(context.integration_weights.mfem_lumped_mass.size() == node_count,
          "static Poisson energy owner receives full-node MFEM magnetic lumped mass");
    context.mesh.node_volumes = context.integration_weights.mfem_lumped_mass;

    std::vector<double> unit_magnetization(3u * node_count, 0.0);
    for (std::size_t node = 0u; node < magnetic_node_count; ++node) {
        unit_magnetization[3u * node + 2u] = 1.0;
    }
    std::vector<double> static_h_demag;
    double static_demag_energy_j = 0.0;
    const bool solved = fullmag::fem::context_compute_demag_poisson(
        context,
        unit_magnetization,
        static_h_demag,
        static_demag_energy_j,
        false,
        nullptr,
        error);
    if (!solved) {
        std::fprintf(stderr, "FAIL: native static Poisson solve: %s\n", error.c_str());
    }
    check(solved && static_h_demag.size() == 3u * node_count &&
              std::isfinite(static_demag_energy_j) && static_demag_energy_j > 0.0,
          "native static Poisson owner returns nonzero H_demag and positive energy");
    auto *potential_grid =
        static_cast<mfem::GridFunction *>(context.poisson_demag.gf_potential);
    check(potential_grid != nullptr,
          "native static Poisson owner retains the solved phi0 grid function");
    mfem::Vector potential_true_dofs;
    potential_grid->GetTrueDofs(potential_true_dofs);
    check(potential_true_dofs.Size() == static_cast<int>(node_count),
          "native static periodic P1 phi0 lifts to the shared global-node order");

    std::copy(static_h_demag.begin(), static_h_demag.end(), fixture.h_demag.begin());
    for (std::size_t node = 0u; node < node_count; ++node) {
        fixture.h_eff[3u * node] = 0.0;
        fixture.h_eff[3u * node + 1u] = 0.0;
        fixture.h_eff[3u * node + 2u] = bias_a_per_m;
        fixture.descriptor_external[3u * node] = -fixture.h_demag[3u * node];
        fixture.descriptor_external[3u * node + 1u] =
            -fixture.h_demag[3u * node + 1u];
        fixture.descriptor_external[3u * node + 2u] =
            bias_a_per_m - fixture.h_demag[3u * node + 2u];
        for (std::size_t axis = 0u; axis < 3u; ++axis) {
            const std::size_t index = 3u * node + axis;
            check(std::abs(
                      fixture.descriptor_external[index] + fixture.h_demag[index] -
                      fixture.h_eff[index]) <= 1.0e-12 * bias_a_per_m,
                  "compensating H_ext and native H_demag reproduce the prescribed H_eff");
        }
    }
    fixture.phi0.resize(node_count);
    double max_abs_phi0 = 0.0;
    for (std::size_t node = 0u; node < node_count; ++node) {
        fixture.phi0[node] = potential_true_dofs[static_cast<int>(node)];
        check(std::isfinite(fixture.phi0[node]),
              "native static phi0 contains only finite nodal values");
        max_abs_phi0 = std::max(max_abs_phi0, std::abs(fixture.phi0[node]));
    }
    check(max_abs_phi0 > 0.0,
          "native static Poisson fixture must not substitute a zero-potential assumption");
    std::fill(fixture.descriptor_alpha.begin(), fixture.descriptor_alpha.end(), 0.0);
    context_destroy_poisson(context);

    fd::CanonicalDigestBuilder content_digest(
        "modal_count_fixture.equilibrium_content.v1");
    content_digest.add_string("source", "context_compute_demag_poisson");
    content_digest.add_string("mesh_topology", fixture.scalar_topology_fingerprint);
    content_digest.add_u64("magnetic_node_count", magnetic_node_count);
    content_digest.add_u64("global_node_count", node_count);
    content_digest.add_double("saturation_magnetisation_a_per_m", saturation_a_per_m);
    content_digest.add_double("gamma0_m_per_a_s", gamma0_m_per_a_s);
    content_digest.add_double("prescribed_total_bias_a_per_m", bias_a_per_m);
    content_digest.add_double("robin_beta_m_inv", 1.0);
    content_digest.add_double("m0_norm_tolerance", fixture.payload.m0_norm_tolerance);
    content_digest.add_double("equilibrium_torque_relative_tolerance", 0.0);
    add_digest_doubles(content_digest, "m0_unit_xyz", fixture.equilibrium);
    add_digest_doubles(content_digest, "h_eff0_apm_xyz", fixture.h_eff);
    add_digest_doubles(content_digest, "h_demag0_apm_xyz", fixture.h_demag);
    add_digest_doubles(content_digest, "h_ext0_apm_xyz", fixture.descriptor_external);
    add_digest_doubles(content_digest, "phi0_a", fixture.phi0);
    add_digest_doubles(content_digest, "alpha_per_node", fixture.descriptor_alpha);
    add_digest_doubles(content_digest, "magnetic_lumped_mass_m3", magnetic_lumped_mass);
    content_digest.add_double("static_demag_energy_j", static_demag_energy_j);
    fixture.equilibrium_content_digest = "sha256:" + content_digest.sha256_hex();

    const char *equilibrium_id = "equilibrium_artifact.v7:native-count-fixture";
    const char *mesh_snapshot_id = "mesh-snapshot:native-count-fixture";
    const char *material_snapshot_id = "material-snapshot:Ms-2-apm";
    const char *physics_snapshot_id = "physics-snapshot:field-demag-alpha-zero";
    const char *boundary_snapshot_id = "boundary-snapshot:robin-1-periodic";
    const char *producer_run_id = "native-static-poisson-count-fixture";
    fixture.payload.equilibrium_id = equilibrium_id;
    fixture.payload.mesh_snapshot_id = mesh_snapshot_id;
    fixture.payload.material_snapshot_id = material_snapshot_id;
    fixture.payload.physics_snapshot_id = physics_snapshot_id;
    fixture.payload.boundary_snapshot_id = boundary_snapshot_id;
    fixture.payload.producer_run_id = producer_run_id;
    fixture.payload.bias_field_sample_id =
        "bias-field-sample:native-count-fixture";
    const char *acceptance_criterion = "torque";
    const char *acceptance_metric_kind = "max_torque_apm";
    const char *acceptance_unit = "A/m";
    constexpr double acceptance_metric_value = 0.0;
    constexpr double acceptance_threshold = 0.0;
    fd::CanonicalDigestBuilder acceptance_digest(
        "modal_count_fixture.acceptance_certificate.v1");
    acceptance_digest.add_string("criterion", acceptance_criterion);
    acceptance_digest.add_string("metric_kind", acceptance_metric_kind);
    acceptance_digest.add_string("unit", acceptance_unit);
    acceptance_digest.add_double("metric_value", acceptance_metric_value);
    acceptance_digest.add_double("threshold", acceptance_threshold);
    acceptance_digest.add_string(
        "equilibrium_content_sha256", fixture.equilibrium_content_digest);
    fixture.acceptance_certificate_digest =
        "sha256:" + acceptance_digest.sha256_hex();

    fd::CanonicalDigestBuilder equilibrium_binding_digest(
        "modal_count_fixture.equilibrium_binding.v1");
    equilibrium_binding_digest.add_string("equilibrium_id", equilibrium_id);
    equilibrium_binding_digest.add_string("mesh_snapshot_id", mesh_snapshot_id);
    equilibrium_binding_digest.add_string("material_snapshot_id", material_snapshot_id);
    equilibrium_binding_digest.add_string("physics_snapshot_id", physics_snapshot_id);
    equilibrium_binding_digest.add_string("boundary_snapshot_id", boundary_snapshot_id);
    equilibrium_binding_digest.add_string("producer_run_id", producer_run_id);
    equilibrium_binding_digest.add_string(
        "equilibrium_content_sha256", fixture.equilibrium_content_digest);
    equilibrium_binding_digest.add_string(
        "acceptance_certificate_sha256", fixture.acceptance_certificate_digest);
    fixture.equilibrium_digest =
        "sha256:" + equilibrium_binding_digest.sha256_hex();

    fd::CanonicalDigestBuilder boundary_digest(
        "modal_count_fixture.boundary_gauge.v1");
    boundary_digest.add_string("boundary_kind", "robin");
    boundary_digest.add_u64("boundary_marker", 1u);
    boundary_digest.add_double("robin_beta_m_inv", 1.0);
    boundary_digest.add_string("gauge_policy", "none_robin_is_invertible");
    boundary_digest.add_string("mesh_topology", fixture.scalar_topology_fingerprint);
    add_digest_u32s(boundary_digest, "periodic_boundary_markers", fixture.periodic_boundary_markers);
    add_digest_u32s(boundary_digest, "facet_roles", fixture.facet_roles);
    add_digest_u32s(boundary_digest, "facet_markers", fixture.facet_markers);
    add_digest_u32s(boundary_digest, "scalar_reduced_node", fixture.scalar_classes);
    fixture.boundary_gauge_digest = "sha256:" + boundary_digest.sha256_hex();

    fd::CanonicalDigestBuilder bias_digest("modal_count_fixture.bias_field_sample.v1");
    bias_digest.add_string("sample_id", "bias-field-sample:native-count-fixture");
    bias_digest.add_string("equilibrium_digest", fixture.equilibrium_digest);
    bias_digest.add_double("prescribed_total_bias_a_per_m", bias_a_per_m);
    add_digest_doubles(bias_digest, "h_ext0_apm_xyz", fixture.descriptor_external);
    add_digest_doubles(bias_digest, "h_eff0_apm_xyz", fixture.h_eff);
    fixture.bias_field_sample_signature = "sha256:" + bias_digest.sha256_hex();

    constexpr std::uint32_t physical_terms =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD |
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG;
    fd::CanonicalDigestBuilder field_digest("modal_count_fixture.field_term.v1");
    field_digest.add_u64("term_presence_mask", physical_terms);
    field_digest.add_double("uniform_saturation_magnetisation_a_per_m", saturation_a_per_m);
    add_digest_doubles(field_digest, "m0_unit_xyz", fixture.equilibrium);
    add_digest_doubles(field_digest, "h_ext0_apm_xyz", fixture.descriptor_external);
    add_digest_doubles(field_digest, "h_eff0_apm_xyz", fixture.h_eff);
    fixture.field_term_digest = "sha256:" + field_digest.sha256_hex();

    fd::CanonicalDigestBuilder demag_digest("modal_count_fixture.demag_term.v1");
    demag_digest.add_u64("term_presence_mask", physical_terms);
    demag_digest.add_string("demag_model", "floquet_airbox");
    demag_digest.add_string("mesh_topology", fixture.scalar_topology_fingerprint);
    demag_digest.add_string("boundary_gauge_digest", fixture.boundary_gauge_digest);
    demag_digest.add_double("uniform_saturation_magnetisation_a_per_m", saturation_a_per_m);
    add_digest_doubles(demag_digest, "h_demag0_apm_xyz", fixture.h_demag);
    add_digest_doubles(demag_digest, "phi0_a", fixture.phi0);
    fixture.demag_term_digest = "sha256:" + demag_digest.sha256_hex();

    fd::CanonicalDigestBuilder operator_digest("modal_count_fixture.operator_input.v1");
    operator_digest.add_u64("term_presence_mask", physical_terms);
    operator_digest.add_string("mesh_topology", fixture.scalar_topology_fingerprint);
    operator_digest.add_string("equilibrium_digest", fixture.equilibrium_digest);
    operator_digest.add_string("field_term_digest", fixture.field_term_digest);
    operator_digest.add_string("demag_term_digest", fixture.demag_term_digest);
    operator_digest.add_string("boundary_gauge_digest", fixture.boundary_gauge_digest);
    operator_digest.add_double("uniform_saturation_magnetisation_a_per_m", saturation_a_per_m);
    operator_digest.add_double("gamma0_m_per_a_s", gamma0_m_per_a_s);
    operator_digest.add_double("mu0_T_m_A", mu0_t_m_a);
    operator_digest.add_double("robin_beta_m_inv", 1.0);
    add_digest_doubles(operator_digest, "alpha_per_node", fixture.descriptor_alpha);
    add_digest_doubles(operator_digest, "tangent_frame_xyz", fixture.descriptor_frames);
    for (double value : fixture.k_vector) {
        operator_digest.add_double("floquet_k_rad_per_m", value);
    }
    for (const auto &pair : fixture.native_pairs) {
        operator_digest.add_u64("floquet_pair_node_a", pair.node_a);
        operator_digest.add_u64("floquet_pair_node_b", pair.node_b);
        for (double value : pair.translation_m) {
            operator_digest.add_double("floquet_pair_translation_m", value);
        }
    }
    fixture.operator_input_digest = "sha256:" + operator_digest.sha256_hex();

    std::vector<double> m0_x(magnetic_node_count, 0.0);
    std::vector<double> m0_y(magnetic_node_count, 0.0);
    std::vector<double> m0_z(magnetic_node_count, 0.0);
    std::vector<double> h_eff_x(magnetic_node_count, 0.0);
    std::vector<double> h_eff_y(magnetic_node_count, 0.0);
    std::vector<double> h_eff_z(magnetic_node_count, 0.0);
    std::vector<double> h_demag_x(magnetic_node_count, 0.0);
    std::vector<double> h_demag_y(magnetic_node_count, 0.0);
    std::vector<double> h_demag_z(magnetic_node_count, 0.0);
    for (std::size_t node = 0u; node < magnetic_node_count; ++node) {
        const std::size_t source = 3u * node;
        m0_x[node] = fixture.equilibrium[source];
        m0_y[node] = fixture.equilibrium[source + 1u];
        m0_z[node] = fixture.equilibrium[source + 2u];
        h_eff_x[node] = fixture.h_eff[source];
        h_eff_y[node] = fixture.h_eff[source + 1u];
        h_eff_z[node] = fixture.h_eff[source + 2u];
        h_demag_x[node] = fixture.h_demag[source];
        h_demag_y[node] = fixture.h_demag[source + 1u];
        h_demag_z[node] = fixture.h_demag[source + 2u];
    }

    fd::EquilibriumArtifactDescriptor artifact{};
    artifact.equilibrium_id = equilibrium_id;
    artifact.mesh_snapshot_id = mesh_snapshot_id;
    artifact.material_snapshot_id = material_snapshot_id;
    artifact.physics_snapshot_id = physics_snapshot_id;
    artifact.boundary_snapshot_id = boundary_snapshot_id;
    artifact.producer_run_id = producer_run_id;
    artifact.content_sha256 = fixture.equilibrium_content_digest.c_str();
    artifact.m0_unit = {m0_x.data(), m0_y.data(), m0_z.data(), magnetic_node_count};
    artifact.h_eff0_a_per_m = {
        h_eff_x.data(), h_eff_y.data(), h_eff_z.data(), magnetic_node_count};
    artifact.h_demag0_a_per_m = {
        h_demag_x.data(), h_demag_y.data(), h_demag_z.data(), magnetic_node_count};
    artifact.phi0 = fixture.phi0.data();
    artifact.tangent_lumped_mass = magnetic_lumped_mass.data();
    artifact.magnetic_node_count = magnetic_node_count;
    artifact.airbox_node_count = node_count;
    artifact.tangent_lumped_mass_count = magnetic_lumped_mass.size();
    artifact.accepted_for_linearization = true;
    artifact.acceptance = {
        acceptance_criterion,
        acceptance_metric_kind,
        acceptance_unit,
        acceptance_metric_value,
        acceptance_threshold,
        fixture.acceptance_certificate_digest.c_str()};
    artifact.demag_model = "floquet_airbox";
    fd::LinearizationBuildOptions build_options{};
    build_options.m0_norm_tolerance = fixture.payload.m0_norm_tolerance;
    build_options.allow_m0_renormalization = false;
    fd::LinearizationStateNative linearization_state{};
    fd::LinearizationDiagnostics linearization_diagnostics{};
    const fd::FrequencyDomainStatus linearization_status =
        fd::build_linearization_state_from_equilibrium(
            artifact,
            build_options,
            linearization_state,
            linearization_diagnostics);
    if (linearization_status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(stderr,
                     "FAIL: native count linearization state: reject=%s error=%s\n",
                     linearization_diagnostics.reject_reason,
                     linearization_diagnostics.error_message);
    }
    check(linearization_status == fd::FrequencyDomainStatus::ok &&
              linearization_state.tangent_frames.size() == magnetic_node_count,
          "canonical linearization builder accepts the owner-produced static state");
    for (std::size_t node = 0u; node < magnetic_node_count; ++node) {
        const auto &frame = linearization_state.tangent_frames[node];
        check(std::abs(frame.e1[0] - 1.0) <= 1.0e-14 &&
                  std::abs(frame.e1[1]) <= 1.0e-14 &&
                  std::abs(frame.e1[2]) <= 1.0e-14 &&
                  std::abs(frame.e2[0]) <= 1.0e-14 &&
                  std::abs(frame.e2[1] - 1.0) <= 1.0e-14 &&
                  std::abs(frame.e2[2]) <= 1.0e-14,
              "native m0=z tangent basis is e1=x and e2=y");
        for (std::size_t axis = 0u; axis < 3u; ++axis) {
            fixture.descriptor_frames[6u * node + axis] = frame.e1[axis];
            fixture.descriptor_frames[6u * node + 3u + axis] = frame.e2[axis];
        }
    }
    fixture.linearization_state_digest =
        linearization_state.linearization_signature_hash;
    fixture.reference_frequency_hz =
        gamma0_m_per_a_s * bias_a_per_m / (2.0 * 3.14159265358979323846);

    fixture.descriptor.linearization_state_digest =
        fixture.linearization_state_digest.c_str();
    fixture.descriptor.equilibrium_digest = fixture.equilibrium_digest.c_str();
    fixture.descriptor.operator_input_digest = fixture.operator_input_digest.c_str();
    fixture.descriptor.term_presence_mask = physical_terms;
    fixture.descriptor.field_term_digest = fixture.field_term_digest.c_str();
    fixture.descriptor.demag_term_digest = fixture.demag_term_digest.c_str();
    fixture.descriptor.demag_provider_signature =
        fixture.operator_input_digest.c_str();
    fixture.descriptor.uniform_saturation_magnetisation_a_per_m = saturation_a_per_m;
    std::fill(fixture.descriptor_alpha.begin(), fixture.descriptor_alpha.end(), 0.0);

    fixture.payload.magnetic_a_qq_csr = FullmagFemCsrMatrixView{};
    fixture.payload.equilibrium_digest = fixture.equilibrium_digest.c_str();
    fixture.payload.mesh_certificate_digest = fixture.canonical_preimage_digest.c_str();
    fixture.payload.linearization_state_digest =
        fixture.linearization_state_digest.c_str();
    fixture.payload.equilibrium_content_sha256 =
        fixture.equilibrium_content_digest.c_str();
    fixture.payload.boundary_gauge_digest = fixture.boundary_gauge_digest.c_str();
    fixture.payload.bias_field_sample_signature =
        fixture.bias_field_sample_signature.c_str();
    fixture.payload.acceptance_criterion = acceptance_criterion;
    fixture.payload.acceptance_metric_kind = acceptance_metric_kind;
    fixture.payload.acceptance_unit = acceptance_unit;
    fixture.payload.acceptance_metric_value = acceptance_metric_value;
    fixture.payload.acceptance_threshold = acceptance_threshold;
    fixture.payload.acceptance_certificate_sha256 =
        fixture.acceptance_certificate_digest.c_str();
}

void verify_native_count_fixture_composed_operator(
    const FloquetContourSharedDomainFixture &fixture)
{
    fd::PoissonAirboxSharedDomainAssemblyResult assembled{};
    fd::FloquetAirboxDynamicDemagKResult dynamic_demag{};
    const fd::FrequencyDomainStatus status =
        fd::assemble_poisson_airbox_shared_domain_payload(
            fixture.payload,
            &assembled,
            fixture.native_pairs.data(),
            fixture.native_pairs.size(),
            &fixture.k_vector,
            &dynamic_demag,
            true);
    if (status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(stderr,
                     "FAIL: physical count shared-domain assembly: %s; demag: %s\n",
                     assembled.error_message,
                     dynamic_demag.diagnostics.error_message);
    }
    check(status == fd::FrequencyDomainStatus::ok &&
              assembled.floquet_sparse_operator_ready &&
              dynamic_demag.diagnostics.potential_solve_certified &&
              dynamic_demag.reconstruction.gauge_policy ==
                  fd::FloquetDynamicDemagKGaugePolicy::require_invertible,
          "physical count oracle uses the native composed shared-domain and Schur owners");
    check(std::strcmp(assembled.boundary_kind, "poisson_robin") == 0 &&
              std::strcmp(assembled.gauge_policy, "none") == 0 &&
              assembled.floquet_full_field_blocks.scalar_robin_coefficient != nullptr,
          "dynamic k0 and Floquet blocks retain the same ungauged Robin form as static phi0");

    const CanonicalFixturePartition payload_partition =
        canonical_fixture_partition(fixture.scalar_classes);
    const std::size_t scalar_class_count =
        fixture.static_scalar_class_representatives.size();
    check(payload_partition.class_representatives ==
              fixture.static_scalar_class_representatives &&
              assembled.p.row_count == scalar_class_count &&
              assembled.p.column_count == scalar_class_count &&
              fixture.static_reduced_poisson_matrix.size() ==
                  scalar_class_count * scalar_class_count,
          "static and shared-domain Poisson owners use the same canonical scalar partition");
    const std::vector<double> shared_p = dense_real_csr(assembled.p);
    check(shared_p.size() == scalar_class_count * scalar_class_count,
          "shared-domain Poisson block is valid CSR on the reduced scalar classes");
    double poisson_scale = 0.0;
    double poisson_error = 0.0;
    for (std::size_t row = 0u; row < scalar_class_count; ++row) {
        const std::uint32_t raw_row = payload_partition.raw_class_ids_by_canonical[row];
        for (std::size_t column = 0u; column < scalar_class_count; ++column) {
            const std::uint32_t raw_column =
                payload_partition.raw_class_ids_by_canonical[column];
            const double actual = shared_p[
                static_cast<std::size_t>(raw_row) * scalar_class_count + raw_column];
            const double expected =
                fixture.static_reduced_poisson_matrix[row * scalar_class_count + column];
            poisson_scale = std::max(poisson_scale, std::abs(expected));
            poisson_error = std::max(poisson_error, std::abs(actual - expected));
        }
    }
    if (!(poisson_scale > 0.0 && poisson_error <= 1.0e-10 * poisson_scale)) {
        std::fprintf(stderr,
                     "count Poisson mismatch: classes=%zu scale=%.17g max_error=%.17g "
                     "static_scalar_order=%d static_beta=%.17g marker=1 "
                     "dynamic_boundary=%s dynamic_gauge=%s\n",
                     scalar_class_count, poisson_scale, poisson_error,
                     fixture.static_scalar_order, fixture.static_robin_beta,
                     assembled.boundary_kind, assembled.gauge_policy);
        const auto print_class_map = [](const char *label,
                                        const std::vector<std::uint32_t> &values) {
            std::fprintf(stderr, "%s:", label);
            for (std::uint32_t value : values) {
                std::fprintf(stderr, " %u", static_cast<unsigned>(value));
            }
            std::fprintf(stderr, "\n");
        };
        print_class_map("static canonical_to_raw", fixture.static_scalar_raw_ids_by_canonical);
        print_class_map("shared canonical_to_raw", payload_partition.raw_class_ids_by_canonical);
        print_class_map("static representatives", fixture.static_scalar_class_representatives);
        print_class_map("shared representatives", payload_partition.class_representatives);
        print_class_map("static raw_node_classes", fixture.static_scalar_raw_node_classes);
        print_class_map("shared raw_node_classes", fixture.scalar_classes);
        for (std::size_t row = 0u; row < scalar_class_count; ++row) {
            const std::uint32_t raw_row = payload_partition.raw_class_ids_by_canonical[row];
            for (std::size_t column = 0u; column < scalar_class_count; ++column) {
                const std::uint32_t raw_column = payload_partition.raw_class_ids_by_canonical[column];
                const double actual = shared_p[
                    static_cast<std::size_t>(raw_row) * scalar_class_count + raw_column];
                const double expected = fixture.static_reduced_poisson_matrix[
                    row * scalar_class_count + column];
                std::fprintf(stderr,
                             "count P[%zu,%zu] shared_raw=[%u,%u] static=%.17g "
                             "shared=%.17g error=%.17g\n",
                             row, column, static_cast<unsigned>(raw_row),
                             static_cast<unsigned>(raw_column), expected, actual,
                             actual - expected);
            }
        }
    }
    check(poisson_scale > 0.0 && poisson_error <= 1.0e-10 * poisson_scale,
          "native static and dynamic k0 Poisson owners assemble the same Robin weak form and gauge");
    double poisson_minimum = 0.0;
    double poisson_eigen_scale = 0.0;
    double poisson_asymmetry = 0.0;
    check(symmetric_min_eigenvalue(
              shared_p,
              scalar_class_count,
              poisson_minimum,
              poisson_eigen_scale,
              poisson_asymmetry) &&
              poisson_asymmetry <= 1.0e-10 * poisson_eigen_scale &&
              poisson_minimum > 0.0,
          "positive Robin boundary removes the periodic Poisson constant nullspace without a pin");

    const auto &positive_mass = assembled.floquet_positive_tangent_mass;
    const std::size_t q_dimension = static_cast<std::size_t>(positive_mass.row_count);
    const std::size_t real_dimension = 2u * q_dimension;
    const std::vector<double> mass_real_split =
        complex_csr_to_real_split(positive_mass);
    const std::vector<double> &demag_real_split = dynamic_demag.real_split_row_major;
    check(q_dimension == 2u * fixture.magnetic_reduced_node_count &&
              real_dimension * real_dimension == demag_real_split.size() &&
              mass_real_split.size() == demag_real_split.size() &&
              assembled.floquet_a_qq.row_count == q_dimension &&
              assembled.floquet_b_qq.row_count == q_dimension,
          "composed Schur, geometric mass, FIELD, and gyrotropic blocks share one reduced basis");

    double mass_minimum = 0.0;
    double mass_scale = 0.0;
    double mass_asymmetry = 0.0;
    check(symmetric_min_eigenvalue(
              mass_real_split,
              real_dimension,
              mass_minimum,
              mass_scale,
              mass_asymmetry) &&
              mass_scale > 0.0 && mass_asymmetry <= 1.0e-10 * mass_scale &&
              mass_minimum > 0.0,
          "composed phase-reduced geometric tangent mass is positive definite");

    double demag_minimum = 0.0;
    double demag_scale = 0.0;
    double demag_asymmetry = 0.0;
    check(symmetric_min_eigenvalue(
              demag_real_split,
              real_dimension,
              demag_minimum,
              demag_scale,
              demag_asymmetry) &&
              demag_scale > 0.0 && demag_asymmetry <= 1.0e-8 * demag_scale &&
              demag_minimum >= -1.0e-8 * demag_scale,
          "native dynamic-demag Schur block is a positive semidefinite energy contribution");
    constexpr double mu0_t_m_a = 4.0e-7 * 3.14159265358979323846;
    constexpr double saturation_a_per_m = 2.0;
    const double upper_coefficient =
        mu0_t_m_a * saturation_a_per_m * saturation_a_per_m;
    std::vector<double> upper_minus_demag(mass_real_split.size(), 0.0);
    for (std::size_t entry = 0u; entry < mass_real_split.size(); ++entry) {
        upper_minus_demag[entry] =
            upper_coefficient * mass_real_split[entry] - demag_real_split[entry];
    }
    double upper_minimum = 0.0;
    double upper_scale = 0.0;
    double upper_asymmetry = 0.0;
    check(symmetric_min_eigenvalue(
              upper_minus_demag,
              real_dimension,
              upper_minimum,
              upper_scale,
              upper_asymmetry) &&
              upper_scale > 0.0 && upper_asymmetry <= 1.0e-8 * upper_scale &&
              upper_minimum >= -1.0e-8 * upper_scale,
          "native Schur block obeys D <= mu0 Ms^2 times the composed geometric mass");

    constexpr double bias_a_per_m = 100.0;
    constexpr double gamma0_m_per_a_s = 3.0;
    const double field_curvature =
        mu0_t_m_a * saturation_a_per_m * bias_a_per_m;
    const double gyrotropic_scale =
        mu0_t_m_a * saturation_a_per_m / gamma0_m_per_a_s;
    double field_error = 0.0;
    double field_scale = 0.0;
    double gyrotropic_error = 0.0;
    double gyrotropic_matrix_scale = 0.0;
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        for (std::size_t column = 0u; column < q_dimension; ++column) {
            const std::complex<double> mass_entry =
                complex_csr_value(positive_mass, row, column);
            const std::complex<double> expected_field =
                field_curvature * mass_entry;
            const std::complex<double> actual_field =
                complex_csr_value(assembled.floquet_a_qq, row, column);
            field_error = std::max(field_error,
                                   std::abs(actual_field - expected_field));
            field_scale = std::max(field_scale, std::abs(expected_field));

            const std::size_t column_component = column % 2u;
            std::complex<double> expected_gyro{};
            for (std::size_t inner_component = 0u;
                 inner_component < 2u;
                 ++inner_component) {
                double rotation = 0.0;
                if (inner_component == 0u && column_component == 1u) {
                    rotation = 1.0;
                } else if (inner_component == 1u && column_component == 0u) {
                    rotation = -1.0;
                }
                expected_gyro += gyrotropic_scale * rotation * complex_csr_value(
                    positive_mass,
                    row,
                    (column / 2u) * 2u + inner_component);
            }
            const std::complex<double> actual_gyro =
                complex_csr_value(assembled.floquet_b_qq, row, column);
            gyrotropic_error = std::max(
                gyrotropic_error,
                std::abs(actual_gyro - expected_gyro));
            gyrotropic_matrix_scale = std::max(
                gyrotropic_matrix_scale,
                std::abs(expected_gyro));
        }
    }
    check(field_scale > 0.0 && field_error <= 1.0e-10 * field_scale,
          "native FIELD block matches the independent mu0 Ms H0 geometric-mass baseline");
    check(gyrotropic_matrix_scale > 0.0 &&
              gyrotropic_error <= 1.0e-10 * gyrotropic_matrix_scale,
          "native zero-damping gyrotropic block matches mu0 Ms/gamma0 times M_T J");
    const double upper_frequency_hz =
        gamma0_m_per_a_s * (bias_a_per_m + saturation_a_per_m) /
        (2.0 * 3.14159265358979323846);
    check(fixture.reference_frequency_hz > 0.0 &&
              upper_frequency_hz > fixture.reference_frequency_hz,
          "independent positive Kittel baseline and demag energetic frequency bound are ordered");
}

FullmagFemModalEigenRequest make_floquet_contour_request(
    const FloquetContourSharedDomainFixture &fixture,
    const double *stiffness,
    const double *gyrotropic)
{
    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.01;
    request.frequency_max_hz = 1.0;
    request.requested_mode_count = 1;
    request.residual_tolerance = 1.0e-10;
    request.eigensolver_family = 2;
    request.completeness_policy = 1;
    request.execution_target = FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_CPU;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2u;
    request.mfem_stiffness_matrix_row_major = stiffness;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic;
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "floquet_airbox";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = fixture.k_vector[0];
    request.floquet_k_vector_rad_per_m[1] = fixture.k_vector[1];
    request.floquet_k_vector_rad_per_m[2] = fixture.k_vector[2];
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = fixture.c_pairs.data();
    request.mfem_floquet_periodic_pair_count = fixture.c_pairs.size();
    request.poisson_airbox_periodic_mesh_certificate_schema =
        fixture.payload.mesh_certificate_schema;
    request.poisson_airbox_magnetic_pair_count = fixture.payload.magnetic_pair_count;
    request.poisson_airbox_airbox_pair_count = fixture.payload.airbox_pair_count;
    request.shared_domain_payload = &fixture.payload;
    request.mesh_generation_identity = fixture.payload.mesh_generation_identity;
    request.canonical_preimage_sha256 = fixture.payload.canonical_preimage_sha256;
    return request;
}

#endif

void modal_shared_domain_provider_failure_status_is_consistent()
{
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_FEM_WITH_SLEPC
    FloquetContourSharedDomainFixture fixture{};
    fixture.initialize();
    fixture.descriptor.term_presence_mask =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD;
    fixture.descriptor.field_term_digest =
        fixture.descriptor.linearization_state_digest;

    CsrOwned magnetic_stiffness{};
    magnetic_stiffness.rows = 10u;
    magnetic_stiffness.columns = 10u;
    magnetic_stiffness.row_offsets.push_back(0u);
    for (std::uint32_t row = 0u; row < 10u; ++row) {
        magnetic_stiffness.column_indices.push_back(row);
        magnetic_stiffness.values.push_back(1.0);
        magnetic_stiffness.row_offsets.push_back(
            static_cast<std::uint32_t>(magnetic_stiffness.values.size()));
    }
    fixture.payload.magnetic_a_qq_csr = magnetic_stiffness.view();

    const std::size_t provider_node_count = fixture.nodes.size() / 3u;
    std::vector<double> unsupported_uniaxial_axes(3u * provider_node_count, 0.0);
    std::vector<double> unsupported_uniaxial_fields(provider_node_count, 1.0);
    for (std::size_t node = 0u; node < provider_node_count; ++node) {
        unsupported_uniaxial_axes[3u * node + 2u] = 1.0;
    }
    fixture.descriptor.term_presence_mask |=
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY;
    fixture.descriptor.anisotropy_term_digest =
        fixture.descriptor.linearization_state_digest;
    fixture.descriptor.uniaxial_axis_xyz = unsupported_uniaxial_axes.data();
    fixture.descriptor.uniaxial_axis_xyz_count = unsupported_uniaxial_axes.size();
    fixture.descriptor.uniaxial_anisotropy_field_a_per_m =
        unsupported_uniaxial_fields.data();
    fixture.descriptor.uniaxial_anisotropy_field_count =
        unsupported_uniaxial_fields.size();

    constexpr double stiffness[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic[] = {0.0, -1.0, 1.0, 0.0};
    FullmagFemModalEigenRequest sparse_provider_failure_request =
        make_floquet_contour_request(fixture, nullptr, nullptr);
    sparse_provider_failure_request.target_kind = "nearest_frequency";
    sparse_provider_failure_request.target_frequency_hz = 0.16;
    sparse_provider_failure_request.frequency_min_hz = 0.0;
    sparse_provider_failure_request.frequency_max_hz = 0.0;
    sparse_provider_failure_request.eigensolver_family = 1;
    sparse_provider_failure_request.mfem_operator_enabled = 0;
    sparse_provider_failure_request.mfem_tangent_dof_count = 0u;
    sparse_provider_failure_request.mfem_stiffness_matrix_row_major = nullptr;
    sparse_provider_failure_request.mfem_gyrotropic_matrix_row_major = nullptr;
    FullmagFemFrequencyDomainResult result =
        fullmag_fem_modal_eigen_solve(&sparse_provider_failure_request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE &&
              contains(result.diagnostics_json,
                       "\"reason\":\"floquet_shared_domain_sparse_assembly_failed\""),
          "C ABI sparse shared-domain provider propagates its unsupported-term status");
    check(contains(result.diagnostics_json,
                   "\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
                   "\"study_product\":\"modal_eigen\",\"status\":\"unavailable\"") &&
              contains(result.result_json,
                       "\"schema_version\":\"frequency_domain_contract_result.v1\","
                       "\"study_product\":\"modal_eigen\",\"status\":\"unavailable\""),
          "C ABI sparse provider failure serializes matching diagnostics and result statuses");
    fullmag_fem_frequency_domain_result_destroy(&result);

    FullmagFemModalEigenRequest dense_provider_failure_request =
        make_floquet_contour_request(fixture, stiffness, gyrotropic);
    dense_provider_failure_request.target_kind = "nearest_frequency";
    dense_provider_failure_request.target_frequency_hz = 0.16;
    dense_provider_failure_request.frequency_min_hz = 0.0;
    dense_provider_failure_request.frequency_max_hz = 0.0;
    dense_provider_failure_request.eigensolver_family = 1;
    result = fullmag_fem_modal_eigen_solve(&dense_provider_failure_request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE &&
              contains(result.diagnostics_json,
                       "\"reason\":\"floquet_airbox_dynamic_demag_k_assembly_failed\""),
          "C ABI dense shared-domain provider propagates its unsupported-term status");
    check(contains(result.diagnostics_json,
                   "\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
                   "\"study_product\":\"modal_eigen\",\"status\":\"unavailable\"") &&
              contains(result.result_json,
                       "\"schema_version\":\"frequency_domain_contract_result.v1\","
                       "\"study_product\":\"modal_eigen\",\"status\":\"unavailable\""),
          "C ABI dense provider failure serializes matching diagnostics and result statuses");
    fullmag_fem_frequency_domain_result_destroy(&result);
    std::printf("PASS: modal_shared_domain_provider_failure_status_contract\n");
#else
    std::printf("SKIP: modal_shared_domain_provider_failure_status_requires_mfem_slepc\n");
#endif
}

void modal_floquet_shared_domain_original_descriptor_certification_is_fail_closed()
{
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_FEM_WITH_SLEPC
    FloquetContourSharedDomainFixture fixture{};
    fixture.initialize();
    fixture.descriptor.term_presence_mask =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD;
    fixture.descriptor.field_term_digest =
        fixture.descriptor.linearization_state_digest;

    constexpr double stiffness[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic[] = {0.0, -1.0, 1.0, 0.0};
    // Keep a positive synthetic total A_qq in the minimal payload so the
    // shared-domain sparse Floquet pencil has a spectrum. The descriptor
    // advertises its supplied collinear static field but no Ku/anisotropy
    // term; the production owner separately assembles geometric tangent mass
    // from this mesh and its periodic classes.
    CsrOwned magnetic_stiffness{};
    magnetic_stiffness.rows = 10u;
    magnetic_stiffness.columns = 10u;
    magnetic_stiffness.row_offsets.push_back(0u);
    for (std::uint32_t row = 0u; row < 10u; ++row) {
        magnetic_stiffness.column_indices.push_back(row);
        magnetic_stiffness.values.push_back(1.0);
        magnetic_stiffness.row_offsets.push_back(
            static_cast<std::uint32_t>(magnetic_stiffness.values.size()));
    }
    fixture.payload.magnetic_a_qq_csr = magnetic_stiffness.view();

    reset_progress_capture();
    FullmagFemModalEigenRequest request =
        make_floquet_contour_request(fixture, nullptr, nullptr);
    request.target_frequency_hz = 0.16;
    request.eigensolver_family = 1;
    request.completeness_policy = 0;
    request.mfem_operator_enabled = 0;
    request.mfem_tangent_dof_count = 0u;
    request.mfem_stiffness_matrix_row_major = nullptr;
    request.mfem_gyrotropic_matrix_row_major = nullptr;
    static constexpr char kNestedOperatorDiagnostics[] =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"certified_shared_domain\","
        "\"operator_diagnostics\":{\"shared_domain_operator_provenance\":"
        "{\"scope\":\"nested-only\"}}}";
    static constexpr char kContourOperatorDiagnostics[] =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\"}";

    fd::ModalEigenRequest native_request{};
    native_request.abi_version = fd::kFrequencyDomainAbiVersion;
    native_request.struct_size = sizeof(native_request);
    native_request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    native_request.operator_request.mesh_asset_id = "modal-quadrature-provenance-fixture";
    native_request.operator_request.equilibrium_source_kind = "provided";
    native_request.operator_request.gamma_rad_s_T = 1.760859e11;
    native_request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    native_request.operator_request.include_demag = 1;
    native_request.operator_request.demag_realization = "floquet_airbox";
    native_request.operator_request.spin_wave_bc_kind = "floquet";
    native_request.operator_request.operator_diagnostics_json =
        kNestedOperatorDiagnostics;
    native_request.requested_mode_count = 1;
    native_request.target_kind = "frequency_window";
    native_request.target_frequency_hz = 0.16;
    native_request.frequency_min_hz = 0.01;
    native_request.frequency_max_hz = 1.0;
    native_request.residual_tolerance = 1.0e-10;
    native_request.max_outer_iterations = 32;
    native_request.max_linear_iterations = 128;
    native_request.eigensolver_family = 1;
    native_request.completeness_policy = 0;
    native_request.execution_target = fd::ModalExecutionTarget::production_cpu;
    native_request.mfem_operator_enabled = 0;
    native_request.mfem_tangent_dof_count = 0u;
    native_request.mfem_stiffness_matrix_row_major = nullptr;
    native_request.mfem_gyrotropic_matrix_row_major = nullptr;
    native_request.has_floquet_k_vector = true;
    native_request.floquet_k_vector_rad_per_m[0] = fixture.k_vector[0];
    native_request.floquet_k_vector_rad_per_m[1] = fixture.k_vector[1];
    native_request.floquet_k_vector_rad_per_m[2] = fixture.k_vector[2];
    native_request.phase_convention = fd::FrequencyDomainPhaseConvention::exp_i_omega_t;
    native_request.floquet_periodic_pairs = fixture.native_pairs.data();
    native_request.floquet_periodic_pair_count = fixture.native_pairs.size();
    native_request.poisson_airbox_periodic_mesh_certificate_schema =
        fixture.payload.mesh_certificate_schema;
    native_request.poisson_airbox_magnetic_pair_count = fixture.payload.magnetic_pair_count;
    native_request.poisson_airbox_airbox_pair_count = fixture.payload.airbox_pair_count;
    native_request.poisson_airbox_shared_domain_enabled = 1;
    native_request.poisson_airbox_shared_domain_payload = &fixture.payload;
    const fd::FrequencyDomainContractResult native_result =
        fd::solve_modal_eigen_contract(native_request);
    if (native_result.status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(
            stderr,
            "INFO: native Floquet provenance fixture status=%u error=%.512s "
            "diagnostics=%.2048s\n",
            static_cast<unsigned int>(native_result.status),
            native_result.error_message.c_str(),
            native_result.diagnostics_json.c_str());
        print_shifted_ksp_failure_probe_if_present(
            std::string_view(native_result.diagnostics_json));
    }
    check(native_result.status == fd::FrequencyDomainStatus::ok,
          "native shared-domain modal contract provenance fixture must reach the Floquet solver");
    const auto best_effort_window_status =
        [](const char *diagnostics_json, int requested_mode_count) {
            const double accepted_modes_before_cap = extract_json_number(
                diagnostics_json,
                "\"accepted_modes_before_cap\":",
                "floquet_shared_domain_window_modes_before_cap");
            return accepted_modes_before_cap >
                    static_cast<double>(requested_mode_count)
                ? "truncated_by_requested_count"
                : "partial_convergence";
        };
    const char *native_window_status = best_effort_window_status(
        native_result.diagnostics_json.c_str(),
        native_request.requested_mode_count);
    const std::string native_result_window_status =
        "\"window_completeness\":\"" +
        std::string(native_window_status) + "\"";
    const std::string native_diagnostics_window_status =
        "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"" +
        std::string(native_window_status) +
        "\",\"certification_method\":\"none\"";
    check(native_result.diagnostics_json.find(
                  "\"complete\":false,\"execution_lane\":\"production_cpu\"") !=
                  std::string::npos &&
              native_result.diagnostics_json.find(
                  "\"unsupported_reason\":\"floquet_nev_refill_dimension_limit_reached\"") !=
                  std::string::npos &&
              native_result.diagnostics_json.find(
                  native_diagnostics_window_status) != std::string::npos &&
              native_result.result_json.find(native_result_window_status) !=
                  std::string::npos,
          "native best_effort result preserves incomplete coverage and the actual refill reason");
    check(native_result.diagnostics_json.find(
              "\"operator_diagnostics\":{\"operator_family\":\"mfem_linearized_llg\","
              "\"payload_kind\":\"certified_shared_domain\","
              "\"operator_diagnostics\":{\"shared_domain_operator_provenance\":"
              "{\"scope\":\"nested-only\"}}}") != std::string::npos,
          "native modal contract must retain nested operator diagnostics");
    check(native_result.diagnostics_json.find(
              "\"deduplication_inner_product\":\"floquet_positive_tangent_mass\"") !=
                  std::string::npos &&
              native_result.diagnostics_json.find(
                  "\"deduplication_mass_matrix\":\"provided_complex_csr\"") !=
                  std::string::npos,
          "native shared-domain Floquet provenance must use the producer-owned geometric tangent mass");
    check(native_result.diagnostics_json.find(
              ",\"shared_domain_operator_provenance\":{\"schema_version\":\"poisson_airbox_shared_domain_operator_provenance.v1\"") !=
              std::string::npos,
          "native modal contract must append provenance at diagnostics top level");
    check(native_result.result_json.find(
              ",\"shared_domain_operator_provenance\":{\"schema_version\":\"poisson_airbox_shared_domain_operator_provenance.v1\"") !=
              std::string::npos,
          "native modal contract must append provenance at result top level");
    request.operator_request.operator_diagnostics_json =
        kNestedOperatorDiagnostics;
    request.progress_callback = capture_progress;
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    if (result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(
            stderr,
            "INFO: C ABI shared-domain Floquet fixture status=%u error=%.512s "
            "diagnostics=%.2048s\n",
            static_cast<unsigned int>(result.status),
            result.error_message != nullptr ? result.error_message : "",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "");
        if (result.diagnostics_json != nullptr) {
            print_shifted_ksp_failure_probe_if_present(
                std::string_view(result.diagnostics_json));
        }
    }
    check(result.status == FULLMAG_FEM_FD_OK,
          "shared-domain Floquet production adapter must certify the original descriptor");
    const char *cabi_window_status = best_effort_window_status(
        result.diagnostics_json,
        request.requested_mode_count);
    const std::string cabi_result_window_status =
        "\"window_completeness\":\"" +
        std::string(cabi_window_status) + "\"";
    const std::string cabi_diagnostics_window_status =
        "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"" +
        std::string(cabi_window_status) +
        "\",\"certification_method\":\"none\"";
    check(contains(result.diagnostics_json,
                   "\"complete\":false,\"execution_lane\":\"production_cpu\"") &&
              contains(result.diagnostics_json,
                       cabi_diagnostics_window_status.c_str()) &&
              contains(result.diagnostics_json,
                       "\"unsupported_reason\":\"floquet_nev_refill_dimension_limit_reached\"") &&
              contains(result.result_json, cabi_result_window_status.c_str()),
          "best_effort C ABI result preserves incomplete coverage and its refill reason");
    check(contains(result.diagnostics_json,
                   "\"deduplication_inner_product\":\"floquet_positive_tangent_mass\"") &&
              contains(result.diagnostics_json,
                       "\"deduplication_mass_matrix\":\"provided_complex_csr\""),
          "shared-domain Floquet production must deduplicate with its producer-owned geometric mass");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "shared-domain Floquet window must publish one accepted mode");
    check(contains(result.result_json, "\"floquet_descriptor_certified\":true"),
          "shared-domain Floquet window must publish the descriptor certificate");
    check(contains(result.result_json, "\"floquet_geometric_bc_certified\":false"),
          "shared-domain Floquet window must preserve the geometric-BC certificate distinction");
    check(contains(result.result_json,
                   "\"potential_representation\":\"doubled_real_split_complex_coefficients\""),
          "shared-domain Floquet window must publish the reconstructed potential representation");
    check(contains(result.result_json, "\"magnetic_relative_residual\":"),
          "shared-domain Floquet window must publish the original magnetic residual");
    check(contains(
              result.diagnostics_json,
              "\"operator_diagnostics\":{\"operator_family\":\"mfem_linearized_llg\","
              "\"payload_kind\":\"certified_shared_domain\","
              "\"operator_diagnostics\":{\"shared_domain_operator_provenance\":"
              "{\"scope\":\"nested-only\"}}}"),
          "nested operator provenance fixture must remain nested under operator diagnostics");
    check(contains(
              result.diagnostics_json,
              ",\"shared_domain_operator_provenance\":{\"schema_version\":\"poisson_airbox_shared_domain_operator_provenance.v1\""),
          "modal solver must append assembled provenance at the diagnostics top level");
    check(contains(
              result.result_json,
              ",\"shared_domain_operator_provenance\":{\"schema_version\":\"poisson_airbox_shared_domain_operator_provenance.v1\""),
          "modal solver must append assembled provenance at the result top level");
    check(contains(result.result_json, "\"potential_relative_residual\":"),
          "shared-domain Floquet window must publish the original potential residual");
    check(contains(result.result_json, "\"potential_vector_real\":[") &&
              contains(result.result_json, "\"potential_vector_imag\":["),
          "shared-domain Floquet window must publish both potential components");
    check(contains(result.diagnostics_json, "\"floquet_potential_certificate\":"),
          "shared-domain Floquet diagnostics must retain the provider potential certificate");
    check(g_progress_event_count == 16,
          "shared-domain Floquet window progress must follow descriptor certification");
    fullmag_fem_frequency_domain_result_destroy(&result);

    FullmagFemModalEigenRequest contour_phase_request =
        make_floquet_contour_request(fixture, stiffness, gyrotropic);
    contour_phase_request.operator_request.operator_diagnostics_json =
        kContourOperatorDiagnostics;
    contour_phase_request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T;
    reset_progress_capture();
    contour_phase_request.progress_callback = capture_progress;
    result = fullmag_fem_modal_eigen_solve(&contour_phase_request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "Floquet contour must reject the unsupported negative-i omega phase convention");
    check(contains(result.diagnostics_json,
                   "contour_interval_phase_convention_unsupported"),
          "Floquet contour phase rejection must expose a stable reason");
    check(contains(result.result_json, "\"accepted_mode_count\":0"),
          "Floquet contour phase rejection must publish no accepted modes");
    check(g_progress_event_count == 0,
          "Floquet contour phase rejection must publish no progress events");
    fullmag_fem_frequency_domain_result_destroy(&result);

    fd::PoissonAirboxSharedDomainAssemblyResult provider_assembly{};
    fd::FloquetAirboxDynamicDemagKResult provider_result{};
    check(fd::assemble_poisson_airbox_shared_domain_payload(
              fixture.payload,
              &provider_assembly,
              fixture.native_pairs.data(),
              fixture.native_pairs.size(),
              &fixture.k_vector,
              &provider_result) == fd::FrequencyDomainStatus::ok,
          "Floquet contour regression provider assembly must succeed");
    check(provider_result.reconstruction.q_count == 2u &&
              provider_result.reconstruction.phi_count > 0u &&
              provider_result.reconstruction.magnetic_stiffness_real_split_value_count == 16u,
          "Floquet contour provider must bind the bounded original K dimension");

    std::vector<double> effective_stiffness(16u, 0.0);
    for (std::size_t index = 0u; index < effective_stiffness.size(); ++index) {
        effective_stiffness[index] = provider_result.real_split_row_major[index];
    }
    effective_stiffness[0] += stiffness[0];
    effective_stiffness[5] += stiffness[1];
    effective_stiffness[10] += stiffness[2];
    effective_stiffness[15] += stiffness[3];
    fd::ContourIntervalSolverRequest contour_request{};
    contour_request.frequency_min_hz = 0.01;
    contour_request.frequency_max_hz = 1.0;
    contour_request.requested_mode_count = 1;
    contour_request.residual_tolerance = 1.0e-10;
    contour_request.max_outer_iterations = 32;
    contour_request.max_linear_iterations = 128;
    contour_request.eigensolver_family = fd::kModalEigensolverFamilyContourInterval;
    contour_request.completeness_policy = 1;
    contour_request.contour_point_count = 16;
    contour_request.tangent_dof_count = 4u;
    contour_request.stiffness_matrix_row_major = effective_stiffness.data();
    contour_request.gyrotropic_mass_matrix_row_major = gyrotropic;
    const fd::ContourIntervalSolveResult contour_result =
        fd::solve_tiny_contour_interval(contour_request);
    check(contour_result.ok && !contour_result.modes.empty(),
          "Floquet contour regression must obtain a mode from the provider Schur pencil");

    fd::FloquetPotentialReconstruction reconstruction = provider_result.reconstruction;
    reconstruction.magnetic_stiffness_real_split = stiffness;
    fd::FloquetModalResidual accepted{};
    check(fd::certify_floquet_realified_mode(
              reconstruction,
              stiffness,
              gyrotropic,
              contour_result.modes.front().mode_vector,
              contour_result.modes.front().eigenvalue,
              &accepted) == fd::FrequencyDomainStatus::ok &&
              accepted.certified && !accepted.potential_real_split.empty(),
          "the contour mode must pass against the original magnetic descriptor");

    std::vector<double> perturbed_stiffness(stiffness, stiffness + 4u);
    perturbed_stiffness[0] += 1.0;
    fd::FloquetModalResidual rejected{};
    const fd::FrequencyDomainStatus perturbed_status =
        fd::certify_floquet_realified_mode(
            reconstruction,
            perturbed_stiffness.data(),
            gyrotropic,
            contour_result.modes.front().mode_vector,
            contour_result.modes.front().eigenvalue,
            &rejected);
    check(perturbed_status != fd::FrequencyDomainStatus::ok || !rejected.certified,
          "perturbing original K must reject the Floquet descriptor certificate");
    check(rejected.potential_real_split.empty(),
          "a rejected original-K certificate must publish no potential payload");

    fd::ModalEigenRequest mismatched_request{};
    mismatched_request.target_kind = "frequency_window";
    mismatched_request.frequency_min_hz = 0.01;
    mismatched_request.frequency_max_hz = 1.0;
    mismatched_request.requested_mode_count = 1;
    mismatched_request.residual_tolerance = 1.0e-10;
    mismatched_request.max_outer_iterations = 32;
    mismatched_request.max_linear_iterations = 128;
    mismatched_request.eigensolver_family = fd::kModalEigensolverFamilyContourInterval;
    mismatched_request.completeness_policy = 1;
    mismatched_request.execution_target = fd::ModalExecutionTarget::production_cpu;
    mismatched_request.mfem_operator_enabled = 1;
    mismatched_request.mfem_tangent_dof_count = 2u;
    mismatched_request.mfem_stiffness_matrix_row_major = stiffness;
    mismatched_request.mfem_gyrotropic_matrix_row_major = gyrotropic;
    mismatched_request.dynamic_demag_k_tangent_matrix_row_major =
        provider_result.real_split_row_major.data();
    mismatched_request.dynamic_demag_k_tangent_matrix_value_count =
        provider_result.real_split_row_major.size();
    mismatched_request.operator_request.include_demag = 1;
    mismatched_request.operator_request.demag_realization = "floquet_airbox";
    mismatched_request.operator_request.spin_wave_bc_kind = "floquet";
    mismatched_request.operator_request.k_vector_rad_m = fixture.k_vector.data();
    mismatched_request.operator_request.k_vector_len = 3;
    mismatched_request.floquet_periodic_pairs = fixture.native_pairs.data();
    mismatched_request.floquet_periodic_pair_count = fixture.native_pairs.size();
    mismatched_request.phase_convention =
        fd::FrequencyDomainPhaseConvention::exp_i_omega_t;
    fd::FloquetPotentialReconstruction mismatched_reconstruction = reconstruction;
    mismatched_reconstruction.magnetic_stiffness_real_split =
        perturbed_stiffness.data();
    reset_progress_capture();
    mismatched_request.progress_callback = capture_progress;
    const fd::FrequencyDomainContractResult mismatched_result =
        fd::production_cpu_modal_eigen_unavailable(
            mismatched_request,
            &mismatched_reconstruction);
    check(mismatched_result.status == fd::FrequencyDomainStatus::solve_error,
          "the contour adapter must fail when its original K certificate is perturbed");
    check(contains(mismatched_result.result_json.c_str(), "\"accepted_mode_count\":0"),
          "a failed original-K contour certificate must publish no accepted modes");
    check(contains(mismatched_result.result_json.c_str(),
                   "\"floquet_descriptor_certified\":false"),
          "a failed original-K contour certificate must publish an explicit false marker");
    check(!contains(mismatched_result.result_json.c_str(), "\"potential_vector_real\":"),
          "a failed original-K contour certificate must publish no potential payload");
    check(g_progress_event_count == 0,
          "a failed original-K contour certificate must publish no progress events");

    fd::FloquetPotentialReconstruction malformed = reconstruction;
    malformed.magnetic_stiffness_real_split_value_count -= 1u;
    fd::FloquetModalResidual malformed_result{};
    check(fd::certify_floquet_realified_mode(
              malformed,
              stiffness,
              gyrotropic,
              contour_result.modes.front().mode_vector,
              contour_result.modes.front().eigenvalue,
              &malformed_result) == fd::FrequencyDomainStatus::validation_error &&
              !malformed_result.certified && malformed_result.potential_real_split.empty(),
          "a mismatched original-K bound must fail before publishing a potential");

    fd::FloquetPotentialReconstruction malformed_adapter = reconstruction;
    malformed_adapter.magnetic_stiffness_real_split_value_count -= 1u;
    reset_progress_capture();
    mismatched_request.progress_callback = capture_progress;
    const fd::FrequencyDomainContractResult malformed_adapter_result =
        fd::production_cpu_modal_eigen_unavailable(
            mismatched_request,
            &malformed_adapter);
    check(malformed_adapter_result.status == fd::FrequencyDomainStatus::solve_error,
          "the contour adapter must reject a mismatched original-K bound");
    check(contains(malformed_adapter_result.result_json.c_str(),
                   "\"accepted_mode_count\":0") &&
              contains(malformed_adapter_result.result_json.c_str(),
                       "\"floquet_descriptor_certified\":false"),
          "a mismatched original-K bound must publish no accepted modes and an explicit false marker");
    check(!contains(malformed_adapter_result.result_json.c_str(),
                    "\"potential_vector_real\":"),
          "a mismatched original-K bound must publish no potential payload");
    check(g_progress_event_count == 0,
          "a mismatched original-K bound must publish no progress events");
#endif
}

void modal_v6_c_abi_relation_views_accept_golden_and_reject_digest_tamper()
{
    ModalCertificateV6CAbiGoldenFixture fixture{};
    fixture.initialize();
    check(fixture.native_binding.canonical_preimage_sha256[0] != '\0',
          "v6 golden fixture must produce a canonical preimage digest");

    fullmag_fem_mesh_desc sentinel_mesh{};
    std::uint32_t reduced_node[] = {0u};
    FullmagFemModalSharedDomainPayload payload = certificate_payload();
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    payload.canonical_preimage = fixture.native_binding.canonical_preimage.c_str();
    payload.canonical_preimage_len = fixture.native_binding.canonical_preimage.size();
    payload.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;
    payload.magnetic_class_digest_sha256 = fixture.native_binding.magnetic_class_digest_sha256;
    payload.scalar_class_digest_sha256 = fixture.native_binding.scalar_class_digest_sha256;
    payload.certificate_binding_v6 = &fixture.c_binding;

    FullmagFemModalEigenRequest request = base_request();
    request.poisson_airbox_periodic_mesh_certificate_schema =
        "periodic_mesh_certificate.v6";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.mesh_generation_identity = "mesh-generation:fixture";
    request.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;
    request.shared_domain_payload = &payload;

    const FullmagFemModalCertificateV6Relation *saved_generators =
        fixture.c_binding.mesh_magnetic.generator_relations;
    fixture.c_binding.mesh_magnetic.generator_relations = nullptr;
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects a v6 view with a missing generator relation array");
    check(contains(result.diagnostics_json, "periodic_mesh_certificate_v6_c_abi_view_missing"),
          "modal C ABI reports a stable malformed v6 view token");
    fullmag_fem_frequency_domain_result_destroy(&result);
    fixture.c_binding.mesh_magnetic.generator_relations = saved_generators;

    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.resolved_certificate_binding_status ==
              FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED,
          "modal C ABI accepts a complete v6 relation-view binding before solver dispatch");
    check(!contains(result.diagnostics_json, "unsupported_abi_version"),
          "public v17 relation fixture is normalized to the internal v16 solver ABI");
    check(contains(result.resolved_canonical_preimage_sha256,
                   fixture.native_binding.canonical_preimage_sha256),
          "modal C ABI publishes the accepted v6 canonical binding digest");
    check(!contains(result.diagnostics_json, "canonical_certificate_binding_unverifiable"),
          "accepted v6 relation views must not be reported as unverifiable");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload.canonical_preimage = nullptr;
    payload.canonical_preimage_len = 0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects complete v6 relation views without canonical preimage bytes");
    check(contains(result.diagnostics_json, "canonical_preimage_missing"),
          "modal C ABI reports missing canonical preimage bytes");
    fullmag_fem_frequency_domain_result_destroy(&result);
    payload.canonical_preimage = fixture.native_binding.canonical_preimage.c_str();
    payload.canonical_preimage_len = fixture.native_binding.canonical_preimage.size();

    payload.canonical_preimage_sha256 = nullptr;
    request.canonical_preimage_sha256 = nullptr;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects a v6 binding with a missing canonical digest");
    check(contains(result.diagnostics_json, "canonical_certificate_binding_unverifiable"),
          "modal C ABI reports a stable missing canonical digest reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    payload.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;
    request.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;

    payload.canonical_preimage_sha256 =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    request.canonical_preimage_sha256 = payload.canonical_preimage_sha256;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects a stale v6 canonical binding digest");
    check(contains(result.diagnostics_json,
                   "periodic_mesh_certificate_v6_binding_digest_mismatch"),
          "modal C ABI reports a stable v6 binding digest mismatch");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_v18_is_fail_closed_and_v19_descriptor_validation_is_preserved()
{
    ModalCertificateV6CAbiGoldenFixture certificate_fixture{};
    certificate_fixture.initialize();
    ModalLinearizationDescriptorFixture descriptor_fixture{};
    double nodes_xyz[6] = {0.0, 0.0, 0.0, 1.0, 0.0, 0.0};
    fullmag_fem_mesh_desc sentinel_mesh{};
    sentinel_mesh.nodes_xyz = nodes_xyz;
    sentinel_mesh.nodes_xyz_len = 6;
    std::uint32_t reduced_node[] = {0u};
    fullmag_fem_frequency_domain_exchange_edge exchange_edge{0u, 1u, 1.0};
    FullmagFemModalSharedDomainPayload payload = certificate_payload();
    payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_V18_ABI_VERSION;
    payload.struct_size = sizeof(payload);
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    payload.equilibrium_m0_xyz = descriptor_fixture.equilibrium;
    payload.equilibrium_m0_xyz_count = 6;
    payload.canonical_preimage = certificate_fixture.native_binding.canonical_preimage.c_str();
    payload.canonical_preimage_len = certificate_fixture.native_binding.canonical_preimage.size();
    payload.canonical_preimage_sha256 =
        certificate_fixture.native_binding.canonical_preimage_sha256;
    payload.magnetic_class_digest_sha256 =
        certificate_fixture.native_binding.magnetic_class_digest_sha256;
    payload.scalar_class_digest_sha256 = certificate_fixture.native_binding.scalar_class_digest_sha256;
    payload.certificate_binding_v6 = &certificate_fixture.c_binding;
    descriptor_fixture.descriptor.linearization_state_digest = payload.linearization_state_digest;
    descriptor_fixture.descriptor.equilibrium_digest = payload.equilibrium_digest;

    FullmagFemModalEigenRequest request = base_request();
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.mesh_generation_identity = "mesh-generation:fixture";
    request.canonical_preimage_sha256 =
        certificate_fixture.native_binding.canonical_preimage_sha256;
    request.shared_domain_payload = &payload;

    FullmagFemModalSharedDomainPayload short_payload = payload;
    short_payload.struct_size = static_cast<std::uint32_t>(
        offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor));
    request.shared_domain_payload = &short_payload;
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload with a short descriptor tail must fail closed");
    check(contains(result.diagnostics_json, "shared_payload_struct_size_too_small"),
          "v18 modal payload reports a short descriptor-tail reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    FullmagFemModalSharedDomainPayload v17_prefix_payload = payload;
    v17_prefix_payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION;
    v17_prefix_payload.struct_size = static_cast<std::uint32_t>(
        offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor));
    request.shared_domain_payload = &v17_prefix_payload;
    result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_HAS_MFEM_STACK
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "complete v17 modal payload reaches the v17 solver boundary without reading v18 fields");
    check(contains(result.diagnostics_json, "shared_domain_assembly_failed"),
          "complete v17 modal payload reports the sentinel shared-domain assembly failure");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "complete v17 modal payload reaches the provider boundary without reading v18 fields");
    check(contains(result.diagnostics_json, "shared_domain_requires_mfem_stack"),
          "complete v17 modal payload reports the unavailable provider without assembly");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
    FullmagFemModalSharedDomainPayload v16_prefix_payload = payload;
    v16_prefix_payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION;
    v16_prefix_payload.struct_size = static_cast<std::uint32_t>(
        offsetof(FullmagFemModalSharedDomainPayload, mesh_generation_identity));
    request.shared_domain_payload = &v16_prefix_payload;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v16 modal payload must fail before reading v18 tail fields");
    check(contains(result.diagnostics_json, "shared_payload_struct_size_too_small"),
          "v16 modal payload reports a stable short-prefix reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    request.shared_domain_payload = &payload;

    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload without an acceptance tail must fail closed");
    check(contains(result.diagnostics_json, "equilibrium_acceptance_certificate_missing"),
          "v18 modal payload reports the missing acceptance-tail reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    payload.acceptance_criterion = "energy";
    payload.acceptance_metric_kind = "total_energy_plateau_range_j";
    payload.acceptance_unit = "J";
    payload.acceptance_metric_value = 1.0e-19;
    payload.acceptance_threshold = 1.0e-18;
    payload.acceptance_certificate_sha256 =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const fd::EquilibriumAcceptanceCertificateDescriptor acceptance{
        payload.acceptance_criterion,
        payload.acceptance_metric_kind,
        payload.acceptance_unit,
        payload.acceptance_metric_value,
        payload.acceptance_threshold,
        payload.acceptance_certificate_sha256};
    char acceptance_error[128]{};
    check(fd::validate_equilibrium_acceptance_certificate(
              acceptance, acceptance_error) == fd::FrequencyDomainStatus::ok,
          "v19 descriptor fixture starts from a valid acceptance certificate");
    payload.linearization_descriptor = &descriptor_fixture.descriptor;
    descriptor_fixture.descriptor.coordinate_unit = "mm";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects a non-SI descriptor unit");
    check(contains(result.diagnostics_json, "linearization_descriptor_unit_invalid"),
          "v19 modal payload reports the descriptor unit reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.coordinate_unit = "m";

    descriptor_fixture.descriptor.linearization_state_digest = "not-a-digest";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects a malformed descriptor digest");
    check(contains(result.diagnostics_json, "linearization_descriptor_digest_invalid"),
          "v19 modal payload reports the descriptor digest reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.linearization_state_digest =
        payload.linearization_state_digest;

    descriptor_fixture.descriptor.linearization_state_digest =
        ModalLinearizationDescriptorFixture::kDigest;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects a descriptor state-digest mismatch");
    check(contains(result.diagnostics_json, "linearization_descriptor_state_digest_mismatch"),
          "v19 modal payload reports the state-digest mismatch reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.linearization_state_digest =
        payload.linearization_state_digest;

    descriptor_fixture.descriptor.equilibrium_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects a descriptor equilibrium-digest mismatch");
    check(contains(result.diagnostics_json, "linearization_descriptor_equilibrium_digest_mismatch"),
          "v19 modal payload reports the equilibrium-digest mismatch reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.equilibrium_digest = payload.equilibrium_digest;

    descriptor_fixture.descriptor.tangent_frame_xyz_count = 0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects a descriptor with an incompatible array count");
    check(contains(result.diagnostics_json, "linearization_descriptor_state_arrays_invalid"),
          "v19 modal payload reports the descriptor array-count reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    descriptor_fixture.descriptor.tangent_frame_xyz_count = 12;
    descriptor_fixture.descriptor.exchange_edge_count = 1;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects an inactive exchange view with a non-zero count");
    check(contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v19 modal payload reports the inactive exchange-view reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.exchange_edge_count = 0;
    descriptor_fixture.descriptor.exchange_edges = &exchange_edge;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects an inactive exchange view with a non-null pointer");
    check(contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v19 modal payload reports the inactive exchange-pointer reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    descriptor_fixture.descriptor.term_presence_mask =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE;
    descriptor_fixture.descriptor.exchange_term_digest = payload.linearization_state_digest;
    descriptor_fixture.descriptor.exchange_edge_count = 1;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR &&
              contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v19 modal payload rejects graph-only exchange without scalar material carrier");
    fullmag_fem_frequency_domain_result_destroy(&result);

    FullmagFemModalExchangeMaterialView material_view{};
    material_view.abi_version = FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION;
    material_view.struct_size = sizeof(material_view);
    material_view.schema_version = FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_SCHEMA;
    material_view.material_kind = FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX;
    material_view.exchange_stiffness_j_per_m = 1.0;
    payload.exchange_material_view = &material_view;
    descriptor_fixture.descriptor.exchange_edges = nullptr;
    descriptor_fixture.descriptor.exchange_edge_count = 0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(!contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v19 modal payload accepts scalar exchange material carrier without graph edges");
    check(!contains(result.diagnostics_json, "exchange_material_view_invalid"),
          "v19 modal payload accepts a valid append-only exchange material view");
    fullmag_fem_frequency_domain_result_destroy(&result);

    material_view.exchange_stiffness_j_per_m = -1.0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v19 modal payload rejects non-positive scalar exchange material");
    check(contains(result.diagnostics_json, "exchange_material_view_invalid"),
          "invalid scalar exchange material uses a stable reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    material_view.exchange_stiffness_j_per_m = 1.0;
    payload.exchange_material_view = nullptr;

    descriptor_fixture.descriptor.term_presence_mask = 0;
    descriptor_fixture.descriptor.exchange_term_digest = nullptr;
    descriptor_fixture.descriptor.exchange_edges = nullptr;
    descriptor_fixture.descriptor.exchange_edge_count = 0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(!contains(result.diagnostics_json, "linearization_descriptor_"),
          "v19 modal payload accepts a complete inactive-term descriptor");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_certificate_boundary_rejects_stale_and_mismatched_identity()
{
    FullmagFemModalEigenRequest request = base_request();
    request.struct_size = sizeof(request);
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_periodic_mesh_certificate_schema =
        "periodic_mesh_certificate.v5";
    request.mesh_generation_identity = "mesh-generation:fixture";
    request.canonical_preimage_sha256 =
        "sha256:5c4867e34716043a16db534f5ffca90613cff84119573b5da0afdb2f1aafb6d2";

    FullmagFemModalSharedDomainPayload payload = certificate_payload();
    request.shared_domain_payload = &payload;
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects request/payload certificate schema disagreement");
    check(contains(result.diagnostics_json, "mesh_certificate_schema_mismatch"),
          "modal C ABI reports stable certificate schema mismatch reason");
    check(result.resolved_fallback_state == 0u,
          "certificate rejection must not select a fallback lane");
    check(contains(result.resolved_fallback_reason, "none"),
          "certificate rejection records fallback=none");
    fullmag_fem_frequency_domain_result_destroy(&result);

    request.poisson_airbox_periodic_mesh_certificate_schema =
        "periodic_mesh_certificate.v6";
    payload.mesh_certificate_digest = "stale-certificate";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects stale certificate identity before solve");
    check(contains(result.diagnostics_json, "invalid_mesh_certificate_digest"),
          "modal C ABI reports stable stale certificate identity reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload = certificate_payload();
    payload.struct_size =
        static_cast<std::uint32_t>(offsetof(FullmagFemModalSharedDomainPayload,
                                            mesh_certificate_map_binding_digest));
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects a shared payload shorter than its certificate tail");
    check(contains(result.diagnostics_json, "shared_payload_struct_size_too_small"),
          "modal C ABI reports stable short payload reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload = certificate_payload();
    payload.struct_size = 0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects an absent shared payload struct_size before tail dereference");
    check(contains(result.diagnostics_json, "shared_payload_struct_size_too_small"),
          "modal C ABI reports an absent shared payload prefix reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    fullmag_fem_mesh_desc sentinel_mesh{};
    std::uint32_t reduced_node[] = {0u};
    payload = certificate_payload();
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    payload.magnetic_pair_count = 2;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects a changed magnetic certificate pair count");
    check(contains(result.diagnostics_json, "certificate_pair_count_mismatch"),
          "modal C ABI reports the changed pair count with a stable token");
    fullmag_fem_frequency_domain_result_destroy(&result);

    FullmagFemModalSharedDomainPayload missing_identity = certificate_payload();
    missing_identity.bias_field_sample_id = nullptr;
    request.shared_domain_payload = &missing_identity;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects a missing certificate identity");
    check(contains(result.diagnostics_json, "missing_certificate_identity"),
          "modal C ABI reports the missing identity with a stable token");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload = certificate_payload();
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    payload.boundary_marker = 0;
    request.shared_domain_payload = &payload;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI rejects an unknown airbox marker before assembly");
    check(contains(result.diagnostics_json, "unknown_airbox_marker"),
          "modal C ABI reports the unknown marker with a stable token");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload.boundary_marker = 1;
    payload.equilibrium_digest =
        "sha256:6123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal C ABI refuses a well-formed identity without a canonical binding verifier");
    check(contains(result.diagnostics_json, "canonical_certificate_binding_unverifiable"),
          "modal C ABI fails closed when the producer cannot prove canonical identity binding");
    check(result.resolved_certificate_binding_status ==
              FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNVERIFIABLE,
          "modal C ABI exposes an unverifiable certificate binding status");
    check(result.resolved_canonical_preimage_sha256 != nullptr &&
              result.resolved_canonical_preimage_sha256[0] == '\0',
          "modal C ABI does not publish a producer canonical digest without relation views");
    check(contains(result.resolved_certificate_binding_reason,
                   "canonical_certificate_binding_unverifiable"),
          "modal C ABI exposes the stable binding reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_v17_certificate_preimage_validation_is_fail_closed()
{
    fullmag_fem_mesh_desc sentinel_mesh{};
    std::uint32_t reduced_node[] = {0u};
    ModalCertificateV6CAbiGoldenFixture fixture{};
    fixture.initialize();
    const auto bind_v6_payload = [&](FullmagFemModalSharedDomainPayload &payload) {
        payload.canonical_preimage = fixture.native_binding.canonical_preimage.c_str();
        payload.canonical_preimage_len = fixture.native_binding.canonical_preimage.size();
        payload.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;
        payload.magnetic_class_digest_sha256 =
            fixture.native_binding.magnetic_class_digest_sha256;
        payload.scalar_class_digest_sha256 =
            fixture.native_binding.scalar_class_digest_sha256;
        payload.certificate_binding_v6 = &fixture.c_binding;
    };
    FullmagFemModalEigenRequest request = base_request();
    request.poisson_airbox_periodic_mesh_certificate_schema =
        "periodic_mesh_certificate.v6";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.mesh_generation_identity = "mesh-generation:fixture";
    request.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;

    FullmagFemModalSharedDomainPayload payload = certificate_payload();
    bind_v6_payload(payload);
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    request.shared_domain_payload = &payload;

    FullmagFemModalEigenRequest short_request = request;
    short_request.struct_size =
        static_cast<std::uint64_t>(offsetof(FullmagFemModalEigenRequest,
                                            mesh_generation_identity));
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&short_request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal request rejects a prefix shorter than certificate identity fields");
    check(contains(result.diagnostics_json, "struct_size_too_small"),
          "v17 modal request reports a short certificate prefix");
    fullmag_fem_frequency_domain_result_destroy(&result);

    FullmagFemModalSharedDomainPayload short_payload = payload;
    short_payload.struct_size = static_cast<std::uint32_t>(
        offsetof(FullmagFemModalSharedDomainPayload, mesh_generation_identity));
    request.shared_domain_payload = &short_payload;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal payload rejects a prefix shorter than certificate fields");
    check(contains(result.diagnostics_json, "shared_payload_struct_size_too_small"),
          "v17 modal payload reports a short certificate prefix");
    fullmag_fem_frequency_domain_result_destroy(&result);

    request.shared_domain_payload = &payload;
    payload.canonical_preimage_sha256 =
        "sha256:8c4867e34716043a16db534f5ffca90613cff84119573b5da0afdb2f1aafb6d2";
    request.canonical_preimage_sha256 = payload.canonical_preimage_sha256;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal payload rejects a mismatched canonical preimage digest");
    check(contains(result.diagnostics_json,
                   "periodic_mesh_certificate_v6_binding_digest_mismatch"),
          "v17 modal payload reports the specific v6 binding digest mismatch");
    check(result.resolved_certificate_binding_status ==
              FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_INVALID,
          "v17 digest mismatch reports invalid binding status");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload = certificate_payload();
    bind_v6_payload(payload);
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    static const char invalid_utf8[] = "canonical\xC0\xAF";
    payload.canonical_preimage = invalid_utf8;
    payload.canonical_preimage_len = sizeof(invalid_utf8) - 1u;
    payload.canonical_preimage_sha256 = fixture.native_binding.canonical_preimage_sha256;
    request.canonical_preimage_sha256 = payload.canonical_preimage_sha256;
    request.shared_domain_payload = &payload;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal payload rejects invalid UTF-8 canonical preimage bytes");
    check(contains(result.diagnostics_json, "canonical_preimage_utf8_invalid"),
          "v17 modal payload reports invalid UTF-8");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload = certificate_payload();
    bind_v6_payload(payload);
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    payload.canonical_preimage_len -= 1u;
    request.canonical_preimage_sha256 = payload.canonical_preimage_sha256;
    request.shared_domain_payload = &payload;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal payload rejects a canonical preimage length mismatch");
    check(contains(result.diagnostics_json, "canonical_preimage_digest_mismatch"),
          "v17 modal payload fails closed after a preimage length mismatch");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload = certificate_payload();
    bind_v6_payload(payload);
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
    request.mesh_generation_identity = "mesh-generation:other";
    request.canonical_preimage_sha256 = payload.canonical_preimage_sha256;
    request.shared_domain_payload = &payload;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal request rejects a mismatched mesh generation identity");
    check(contains(result.diagnostics_json, "certificate_binding_identity_mismatch"),
          "v17 modal request reports identity mismatch");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_result_provenance_is_resolved_or_explicitly_unavailable()
{
    FullmagFemModalEigenRequest request = base_request();
    request.struct_size = sizeof(request);
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "unsolved modal request remains unavailable");
    check(contains(result.resolved_engine_id, "unavailable"),
          "unavailable modal result exposes resolved engine state instead of requested AUTO");
    check(result.resolved_fallback_state == 0u,
          "unavailable modal result must not claim a fallback");
    check(contains(result.resolved_fallback_reason, "none"),
          "unavailable modal result records fallback=none");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_result_destroy_is_safe_for_partial_allocation_and_repeated_calls()
{
    FullmagFemFrequencyDomainResult partial{};
    partial.error_message = new char[1]{'\0'};
    partial.mode_lambda = new FullmagFemComplex64[1]{};
    partial.mode_lambda_count = 1;
    partial.resolved_engine_id = new char[1]{'\0'};
    partial.resolved_canonical_preimage_sha256 = new char[1]{'\0'};
    partial.resolved_certificate_binding_reason = new char[1]{'\0'};
    fullmag_fem_frequency_domain_result_destroy(&partial);
    check(partial.error_message == nullptr && partial.mode_lambda == nullptr &&
              partial.resolved_engine_id == nullptr &&
              partial.resolved_canonical_preimage_sha256 == nullptr &&
              partial.resolved_certificate_binding_reason == nullptr,
          "destroy clears a partially allocated modal result");
    fullmag_fem_frequency_domain_result_destroy(&partial);
}

void modal_v18_result_is_frozen_and_strict_gpu_requires_v20_attestation()
{
    static_assert(FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION == 18u,
                  "the by-value modal result ABI must remain frozen at v18");

    FullmagFemModalEigenRequest request = base_request();
    request.execution_target = FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU;
    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION,
          "legacy by-value modal callers continue to receive the frozen v18 result");
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "strict production GPU through the v18 result ABI must fail closed");
    check(contains(result.diagnostics_json, "k0_poisson_airbox_gpu_attestation_abi_required"),
          "strict production GPU through v18 reports the v20 attestation requirement");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_v20_short_envelope_is_rejected_before_any_write()
{
    FullmagFemFrequencyDomainResultV20 result{};
    std::memset(&result, 0xa5, sizeof(result));
    result.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION;
    result.struct_size =
        static_cast<std::uint32_t>(offsetof(FullmagFemFrequencyDomainResultV20,
                                            scientific_result_v18));
    std::array<std::uint8_t, sizeof(result)> before{};
    std::memcpy(before.data(), &result, sizeof(result));

    const FullmagFemModalEigenRequest request = base_request();
    check(fullmag_fem_modal_eigen_solve_v20(&request, &result) == FULLMAG_FEM_ERR_INVALID,
          "v20 modal solve rejects a short caller envelope");
    check(std::memcmp(before.data(), &result, sizeof(result)) == 0,
          "v20 modal solve rejects a short caller envelope before any write");
}

void modal_v20_strict_gpu_attestation_is_present_complete_and_known()
{
    FullmagFemModalEigenRequest request = base_request();
    request.execution_target = FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU;

    FullmagFemFrequencyDomainResultV20 result{};
    result.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION;
    result.struct_size = sizeof(result);
    check(fullmag_fem_modal_eigen_solve_v20(&request, &result) == FULLMAG_FEM_OK,
          "v20 modal solve accepts a complete caller envelope");
    check(result.scientific_result_v18.abi_version ==
              FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION,
          "v20 envelope embeds the frozen scientific v18 result");
    check(result.gpu_attestation != nullptr,
          "strict production GPU v20 result rejects completion without an attestation");
    check(result.gpu_attestation->abi_version ==
              FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_ABI_VERSION,
          "strict production GPU v20 result rejects an unknown attestation ABI");
    check(result.gpu_attestation->struct_size >= sizeof(FullmagFemModalGpuAttestationV1),
          "strict production GPU v20 result rejects a short attestation before tail access");
    check(result.gpu_attestation->measurement_state ==
              FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE,
          "strict production GPU v20 result rejects an unknown attestation measurement state");
    check(result.gpu_attestation->device_residency_verified == 0u,
          "T3-only v20 sidecar must not promote full object-graph residency");
    check((result.gpu_attestation->measurement_coverage_flags &
               ~FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP) == 0u,
          "T3-only v20 sidecar must not claim T4 or export coverage");
    check(result.scientific_result_v18.status != FULLMAG_FEM_FD_OK,
          "unavailable GPU attestation cannot mark a strict production result complete");

    fullmag_fem_frequency_domain_result_v20_destroy(&result);
    check(result.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION &&
              result.struct_size == sizeof(result) &&
              result.gpu_attestation == nullptr &&
              result.scientific_result_v18.status ==
                  static_cast<FullmagFemFrequencyDomainStatus>(0),
          "v20 destroy clears the complete envelope while preserving its caller header");
    fullmag_fem_frequency_domain_result_v20_destroy(&result);
}

void modal_v20_tiny_validation_rejects_forced_production_gpu()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.execution_target = FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResultV20 result{};
    result.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION;
    result.struct_size = sizeof(result);
    check(fullmag_fem_modal_eigen_solve_v20(&request, &result) == FULLMAG_FEM_OK,
          "v20 accepts the forced-GPU tiny-conflict request envelope");
    const FullmagFemFrequencyDomainResult &scientific_result =
        result.scientific_result_v18;
    check(scientific_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "forced production GPU with a tiny fixture is rejected before validation solve");
    check(contains(
              scientific_result.diagnostics_json,
              "tiny_validation_production_gpu_conflict"),
          "forced-GPU tiny rejection reports its explicit conflict reason");
    check(scientific_result.resolved_execution_target ==
              FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU,
          "rejection preserves the explicitly requested GPU target as resolved target");
    check(scientific_result.resolved_fallback_state ==
              0u &&
              contains(scientific_result.resolved_fallback_reason, "none"),
          "forced-GPU tiny rejection records no CPU or validation fallback");
    check(contains(
              scientific_result.resolved_engine_id,
              "production_gpu_tiny_validation_rejected"),
          "resolved engine identifies the rejected GPU/tiny combination");
    check(!contains(
              scientific_result.diagnostics_json,
              "\"tiny_validation_solver\":true") &&
              !contains(
                  scientific_result.result_json,
                  "\"tiny_validation_solver\":true"),
          "the forced-GPU request never enters the toy validation solver");
    check(result.gpu_attestation != nullptr &&
              result.gpu_attestation->measurement_state ==
                  FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE &&
              result.gpu_attestation->fallback_state ==
                  FULLMAG_FEM_MODAL_GPU_FALLBACK_NONE,
          "rejected GPU request remains unavailable with no attested fallback");

    fullmag_fem_frequency_domain_result_v20_destroy(&result);
}

void modal_v20_destroy_is_safe_for_partial_allocation_and_repeated_calls()
{
    FullmagFemFrequencyDomainResultV20 partial{};
    partial.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION;
    partial.struct_size = sizeof(partial);
    partial.scientific_result_v18.error_message = new char[1]{'\0'};
    partial.gpu_attestation = new FullmagFemModalGpuAttestationV1{};
    partial.gpu_attestation->device_name = new char[1]{'\0'};

    fullmag_fem_frequency_domain_result_v20_destroy(&partial);
    check(partial.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION &&
              partial.struct_size == sizeof(partial) &&
              partial.scientific_result_v18.error_message == nullptr &&
              partial.gpu_attestation == nullptr,
          "v20 destroy clears a partially allocated result envelope");
    fullmag_fem_frequency_domain_result_v20_destroy(&partial);
}

void modal_shift_invert_finds_macrospin_mode()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    if (result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(stderr,
                     "DIAG: tiny macrospin status=%d error=%s diagnostics=%s result=%s\n",
                     static_cast<int>(result.status),
                     result.error_message != nullptr ? result.error_message : "",
                     result.diagnostics_json != nullptr ? result.diagnostics_json : "",
                     result.result_json != nullptr ? result.result_json : "");
    }
    check(result.status == FULLMAG_FEM_FD_OK, "macrospin modal validation should succeed");
    check(contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
          "macrospin modal validation diagnostics identify validation lane");
    check(contains(result.result_json, "\"status\":\"ok\""),
          "macrospin modal result reports ok");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "macrospin modal result accepts one positive-frequency mode");
    check(result.resolved_execution_target == FULLMAG_FEM_MODAL_EXECUTION_VALIDATION,
          "tiny validation reports the execution lane selected by the solver");
    check(result.resolved_spectral_transform_kind ==
              FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_SHIFT_INVERT,
          "tiny validation reports its actual shift-invert transform");
    check(contains(result.resolved_engine_id, "tiny_validation_modal_eigen"),
          "tiny validation reports the actual modal engine without JSON inference");
    check(result.resolved_fallback_state == 0u &&
              contains(result.resolved_fallback_reason, "none"),
          "tiny validation records that no fallback was used");
    const double frequency_hz =
        extract_json_number(
            result.result_json,
            "\"frequency_hz\":",
            "modal_shift_invert_finds_macrospin_mode");
    check(std::abs(frequency_hz - 0.15915494309189535) < 1.0e-12,
          "macrospin modal frequency matches 1/(2*pi)");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_residual_below_tolerance()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK, "macrospin residual validation should succeed");
    const double residual =
        extract_json_number(
            result.result_json,
            "\"relative_residual\":",
            "modal_shift_invert_residual_below_tolerance");
    check(residual <= request.residual_tolerance,
          "macrospin modal residual must satisfy requested tolerance");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_validation_reports_slepc_adapter_configuration()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK,
          "macrospin SLEPc modal validation should succeed");
#if FULLMAG_FEM_WITH_SLEPC
    check(contains(result.diagnostics_json, "\"solver_adapter\":\"slepc_modal_eigen\""),
          "macrospin validation diagnostics must name the SLEPc modal adapter");
    check(contains(result.diagnostics_json, "\"solver_family\":\"slepc_shift_invert_validation\""),
          "macrospin validation diagnostics must report the SLEPc shift-invert family");
    check(contains(result.diagnostics_json, "\"eps_type\":\"krylovschur\""),
          "macrospin validation diagnostics must report the SLEPc EPS type");
    check(contains(result.diagnostics_json, "\"slepc_problem_type\":\"gnhep\""),
          "macrospin validation diagnostics must report the generalized non-Hermitian problem type");
    check(contains(result.diagnostics_json, "\"spectral_transform\":\"shift_invert\""),
          "macrospin validation diagnostics must report shift-invert spectral transform");
    check(contains(result.diagnostics_json, "\"which_eigenpairs\":\"target_magnitude\""),
          "macrospin validation diagnostics must report target-magnitude eigenpair selection");
    check(contains(result.diagnostics_json, "\"ksp_type\":\"preonly\""),
          "macrospin validation diagnostics must report the shifted linear KSP type");
    check(contains(result.diagnostics_json, "\"pc_type\":\"lu\""),
          "macrospin validation diagnostics must report the shifted linear PC type");
    check(contains(result.diagnostics_json, "\"ksp_rtol\":"),
          "macrospin validation diagnostics must report KSP relative tolerance");
    check(contains(result.diagnostics_json, "\"ksp_atol\":"),
          "macrospin validation diagnostics must report KSP absolute tolerance");
    check(contains(result.diagnostics_json, "\"ksp_max_iterations\":128"),
          "macrospin validation diagnostics must report KSP iteration cap");
    check(contains(result.diagnostics_json, "\"ksp_final_residual\":"),
          "macrospin validation diagnostics must report final KSP residual");
    check(contains(result.result_json, "\"solver_adapter\":\"slepc_modal_eigen\""),
          "macrospin validation result must name the SLEPc modal adapter");
#else
    check(contains(result.diagnostics_json, "\"solver_family\":\"analytic_validation_shift_target\""),
          "non-SLEPc macrospin validation keeps the analytic validation family");
#endif
    const double diagnostics_shift_frequency_hz =
        extract_json_number(
            result.diagnostics_json,
            "\"shift_frequency_hz\":",
            "modal_shift_invert_validation_reports_slepc_adapter_configuration");
    check(std::abs(diagnostics_shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "macrospin validation diagnostics must report the requested shift frequency");
    const double diagnostics_shift_omega_rad_s =
        extract_json_number(
            result.diagnostics_json,
            "\"shift_omega_rad_s\":",
            "modal_shift_invert_validation_reports_slepc_adapter_configuration");
    check(std::abs(diagnostics_shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "macrospin validation diagnostics must report the angular shift");
    const double result_shift_frequency_hz =
        extract_json_number(
            result.result_json,
            "\"shift_frequency_hz\":",
            "modal_shift_invert_validation_reports_slepc_adapter_configuration");
    check(std::abs(result_shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "macrospin validation result must report the requested shift frequency");
    const double result_shift_omega_rad_s =
        extract_json_number(
            result.result_json,
            "\"shift_omega_rad_s\":",
            "modal_shift_invert_validation_reports_slepc_adapter_configuration");
    check(std::abs(result_shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "macrospin validation result must report the angular shift");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_reports_ksp_iterations()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    reset_progress_capture();
    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;
    request.progress_callback = capture_progress;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK, "progress-reporting modal validation should succeed");
    check(contains(g_last_progress_json, "\"solver_phase\":\"solving_shift_invert\""),
          "modal progress phase reports solving_shift_invert");
    check(contains(g_last_progress_json, "\"outer_iteration\":1"),
          "modal progress reports outer iterations");
    check(contains(g_last_progress_json, "\"linear_iteration\":1"),
          "modal progress reports shifted linear iterations");
    check(contains(g_last_progress_json, "\"accepted_mode_count\":1"),
          "modal progress reports accepted mode count");
    const double current_shift_hz =
        extract_json_number(
            g_last_progress_json,
            "\"current_shift_hz\":",
            "modal_shift_invert_reports_ksp_iterations");
    check(std::abs(current_shift_hz - request.target_frequency_hz) < 1.0e-15,
          "modal progress preserves the legacy current shift");
    const double shift_frequency_hz =
        extract_json_number(
            g_last_progress_json,
            "\"shift_frequency_hz\":",
            "modal_shift_invert_reports_ksp_iterations");
    check(std::abs(shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "modal progress reports shift frequency provenance");
    const double shift_omega_rad_s =
        extract_json_number(
            g_last_progress_json,
            "\"shift_omega_rad_s\":",
            "modal_shift_invert_reports_ksp_iterations");
    check(std::abs(shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "modal progress reports angular shift provenance");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_cancel_returns_interrupted()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;
    request.cancel_requested = always_cancel;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_INTERRUPTED,
          "modal cancellation must report interrupted");
    check(contains(result.diagnostics_json, "\"status\":\"interrupted\""),
          "cancelled modal diagnostics report interrupted");
    check(contains(result.diagnostics_json, "\"stop_reason\":\"cancel_requested\""),
          "cancelled modal diagnostics report cancel stop reason");
    check(contains(result.result_json, "\"status\":\"interrupted\""),
          "cancelled modal result reports interrupted");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void frequency_window_reports_unresolved_subwindow()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.max_outer_iterations = 0;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_SOLVE_ERROR,
          "unresolved frequency window must not report ok");
    check(contains(result.diagnostics_json, "\"window_completeness\""),
          "unresolved frequency window diagnostics include completeness");
    check(contains(result.diagnostics_json, "\"status\":\"partial_convergence\""),
          "unresolved frequency window reports partial convergence");
    check(contains(result.diagnostics_json, "\"stop_reason\":\"max_iterations\""),
          "unresolved frequency window records max_iterations stop reason");
    check(contains(result.result_json, "\"window_completeness\":\"partial_convergence\""),
          "unresolved frequency window result exposes completeness status");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void frequency_window_wide_auto_selects_contour_interval_solver()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    reset_progress_capture();
    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.eigensolver_family = 0;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;
    request.progress_callback = capture_progress;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK,
          "wide frequency window should select the contour interval solver");
    check(contains(result.diagnostics_json, "\"resolved_solver_family\":\"contour_interval\""),
          "wide frequency window diagnostics expose the contour solver family");
    check(contains(result.diagnostics_json, "\"solver_selection_reason\":\"frequency_window_relative_width_ge_0.5\""),
          "wide frequency window diagnostics expose resolved policy");
    check(contains(result.diagnostics_json, "\"contour_point_count\":16"),
          "contour diagnostics expose contour point count");
    check(contains(result.diagnostics_json, "\"certified_count\":true"),
          "contour diagnostics expose certified contour count separately");
    check(contains(result.result_json, "\"window_completeness\":\"certified\""),
          "contour interval result exposes certified window completeness");
    check(g_progress_event_count == 16,
          "contour interval solve must emit one progress event per contour point");
    check(contains(g_last_progress_json, "\"solver_phase\":\"solving_contour_interval\""),
          "contour progress reports solving_contour_interval");
    check(contains(g_last_progress_json, "\"contour_point_index\":15"),
          "contour progress reports the final contour point index");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_frequency_window_production_payload_contour_accepts_multiple_modes()
{
    constexpr double stiffness_matrix_row_major[] = {
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 2.0, 0.0,
        0.0, 0.0, 0.0, 2.0,
    };
    constexpr double gyrotropic_matrix_row_major[] = {
        0.0, -1.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, -1.0,
        0.0, 0.0, 1.0, 0.0,
    };

    reset_progress_capture();
    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.requested_mode_count = 4;
    request.eigensolver_family = 2;
    request.completeness_policy = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 4;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_matrix_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\",\"tangent_dof_count\":4}";
    request.progress_callback = capture_progress;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "multi-mode production contour payload should solve through the contour interval adapter");
    check(contains(result.diagnostics_json, "\"resolved_solver_family\":\"contour_interval\""),
          "multi-mode contour diagnostics expose the contour solver family");
    check(contains(result.diagnostics_json, "\"solver_model\":\"contour_interval_production_cpu_dense\""),
          "multi-mode contour diagnostics publish the production contour solver model");
    check(contains(result.diagnostics_json, "\"solver_family\":\"contour_interval_production_cpu_dense\""),
          "multi-mode contour diagnostics report the production contour family");
    check(contains(result.diagnostics_json, "\"estimated_mode_count\":2"),
          "multi-mode contour diagnostics publish the certified mode count");
    check(contains(result.diagnostics_json, "\"projection_rank\":2"),
          "multi-mode contour diagnostics publish projector rank");
    check(contains(result.diagnostics_json, "\"accepted_mode_count\":2"),
          "multi-mode contour diagnostics accept both modes");
    check(contains(result.result_json, "\"accepted_mode_count\":2"),
          "multi-mode contour result accepts both modes");
    check(contains(result.result_json, "\"frequency_hz\":0.159154943091895"),
          "multi-mode contour result includes the lower positive mode");
    check(contains(result.result_json, "\"frequency_hz\":0.318309886183790"),
          "multi-mode contour result includes the upper positive mode");
    check(contains(result.result_json, "\"mode_vector_real\":["),
          "multi-mode contour result publishes global real mode vectors");
    check(contains(result.result_json, "\"mode_vector_imag\":["),
          "multi-mode contour result publishes global imaginary mode vectors");
    check(contains(result.result_json, "\"window_completeness\":\"certified\""),
          "multi-mode contour result exposes certified window completeness");
    check(g_progress_event_count == 16,
          "multi-mode production contour payload must emit one progress event per contour point");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "multi-mode production contour payload remains unavailable without SLEPc");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_payload_can_be_assembled_from_mfem_operator()
{
    namespace fd = fullmag::fem::frequency_domain;

    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM modal payload tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM modal payload tangent layout succeeds");

    const double h_ext_a_per_m[] = {0.0, 0.0, 1.0};
    const double tangent_lumped_mass[] = {2.0};
    double stiffness_matrix_row_major[4]{};
    double dynamic_mass_matrix_row_major[4]{};
    double tangent_mass_matrix_row_major[4]{};
    fd::MfemModalDenseOperatorPayloadResult payload_result{};
    const fd::FrequencyDomainStatus payload_status =
        fd::assemble_mfem_modal_dense_operator_payload(
            fd::MfemModalDenseOperatorPayloadProblem{
                descriptor,
                layout,
                &node,
                nullptr,
                0,
                h_ext_a_per_m,
                nullptr,
                0.0,
                nullptr,
                tangent_lumped_mass,
                1.0,
                0.0,
                stiffness_matrix_row_major,
                dynamic_mass_matrix_row_major,
                tangent_mass_matrix_row_major,
                4,
            },
            &payload_result);

    check(payload_status == fd::FrequencyDomainStatus::ok,
          "MFEM modal dense payload assembly succeeds");
    check(payload_result.tangent_dof_count == 2,
          "MFEM modal payload keeps tangent DOF count");
    check(std::strcmp(payload_result.payload_kind, "dense_linearized_mfem_operator") == 0,
          "MFEM modal payload reports dense linearized payload kind");
    check(std::strcmp(payload_result.algebraic_form, "first_order_complex") == 0,
          "MFEM modal payload reports first-order complex algebraic form");
    check(std::abs(payload_result.max_abs_tangent_mass_matrix - 2.0) < 1.0e-12,
          "MFEM modal payload reports tangent mass matrix scale");
    check(std::abs(stiffness_matrix_row_major[1] + 1.0) < 1.0e-12,
          "MFEM modal payload dynamic matrix k01");
    check(std::abs(stiffness_matrix_row_major[2] - 1.0) < 1.0e-12,
          "MFEM modal payload dynamic matrix k10");
    check(std::abs(stiffness_matrix_row_major[0]) < 1.0e-12,
          "MFEM modal payload dynamic matrix k00");
    check(std::abs(stiffness_matrix_row_major[3]) < 1.0e-12,
          "MFEM modal payload dynamic matrix k11");
    check(std::abs(dynamic_mass_matrix_row_major[0] - 1.0) < 1.0e-12,
          "MFEM modal payload mass matrix m00");
    check(std::abs(dynamic_mass_matrix_row_major[1]) < 1.0e-12,
          "MFEM modal payload mass matrix m01");
    check(std::abs(dynamic_mass_matrix_row_major[2]) < 1.0e-12,
          "MFEM modal payload mass matrix m10");
    check(std::abs(dynamic_mass_matrix_row_major[3] - 1.0) < 1.0e-12,
          "MFEM modal payload mass matrix m11");
    check(std::abs(tangent_mass_matrix_row_major[0] - 2.0) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt00");
    check(std::abs(tangent_mass_matrix_row_major[1]) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt01");
    check(std::abs(tangent_mass_matrix_row_major[2]) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt10");
    check(std::abs(tangent_mass_matrix_row_major[3] - 2.0) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt11");
    check(std::abs(payload_result.linearized_pencil_gamma0_m_per_a_s - 1.0) < 1.0e-12,
          "MFEM modal payload publishes canonical pencil gamma0 metadata");
    const fd::MfemLinearizedPencilDependency shared_dependency{
        descriptor, layout, &node, nullptr, 0, h_ext_a_per_m, 3,
        nullptr, 0, 0.0, nullptr, 0, 1.0, 0.0,
        nullptr, 0, nullptr, 0, nullptr, 0, 0.0,
        nullptr, 0, nullptr, nullptr, 0, false,
    };
    const std::string driven_dependency_digest =
        fd::mfem_linearized_pencil_dependency_digest(shared_dependency);
    const auto true_residual_pencil = fd::LinearizedDynamicPencil::from_real_callbacks(
        fd::dynamic_pencil_metadata_from_legacy_gamma0(
            1.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t),
        2,
        {},
        driven_dependency_digest,
        "mfem_linearized_cpu_jvp.v1");
    check(std::strcmp(payload_result.dependency_digest, driven_dependency_digest.c_str()) == 0,
          "modal payload and driven operator share dynamic-demag and static-periodic provenance");
    check(true_residual_pencil.dependency_digest() == driven_dependency_digest,
          "true residual provenance uses the driven dependency digest");
    check(std::strcmp(payload_result.operator_digest, true_residual_pencil.digest().c_str()) == 0,
          "one MFEM dependency fixture gives modal and true-residual paths one canonical pencil identity");

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = payload_result.tangent_dof_count;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = dynamic_mass_matrix_row_major;
    request.mfem_mass_matrix_row_major = tangent_mass_matrix_row_major;
    request.mfem_linearized_pencil_dependency_digest = payload_result.dependency_digest;
    request.mfem_linearized_pencil_gamma0_m_per_a_s =
        payload_result.linearized_pencil_gamma0_m_per_a_s;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\",\"payload_kind\":\"dense_linearized_mfem_operator\"}";
    constexpr double k_vector_rad_m[] = {0.0, 0.0, 0.0};
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "MFEM-assembled modal payload should solve through production SLEPc path");
    check(contains(result.diagnostics_json, "\"execution_lane\":\"production_cpu\""),
          "MFEM-assembled modal payload diagnostics report production lane");
    check(contains(result.diagnostics_json, payload_result.operator_digest),
          "magnetic modal route publishes the payload's canonical pencil digest");
    check(contains(
              result.diagnostics_json,
              "\"linearized_dynamic_pencil_gamma0_m_per_a_s\":1"),
          "magnetic modal route reports payload-sourced canonical pencil metadata");
    check(contains(result.diagnostics_json, "\"solver_family\":\"slepc_multi_shift_invert_production_cpu_dense\""),
          "MFEM-assembled modal payload diagnostics report production multi-shift SLEPc family");
    check(contains(result.diagnostics_json, "\"solver_model\":\"slepc_multi_shift_invert_production_cpu_dense\""),
          "MFEM-assembled modal payload diagnostics publish production multi-shift solver model");
    check(contains(result.diagnostics_json, "\"deduplication_mass_matrix\":\"provided\""),
          "MFEM-assembled modal payload diagnostics report provided tangent mass");
    const double frequency_hz =
        extract_json_number(
            result.result_json,
            "\"frequency_hz\":",
            "modal_shift_invert_payload_can_be_assembled_from_mfem_operator");
    check(std::abs(frequency_hz - 0.15915494309189535) < 1.0e-10,
          "MFEM-assembled modal payload frequency matches one radian per second");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "MFEM-assembled modal payload remains unavailable without SLEPc");
#endif
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "MFEM-assembled modal payload diagnostics preserve explicit k-vector");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_dynamic_demag_materialization_preserves_legacy_s_sign()
{
    namespace fd = fullmag::fem::frequency_domain;

    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "dynamic-demag modal payload tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.demag_enabled = true;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "dynamic-demag modal payload tangent layout succeeds");

    const double tangent_lumped_mass[] = {1.0};
    // For H_demag = D e_j, legacy S(:, j) = (H_demag[1], -H_demag[0]), while
    // the canonical JVP is L=-S. With D=[[2,5],[7,11]], legacy S is
    // [[7,11],[-2,-5]], proving both tangent basis columns are materialized.
    const double demag_tangent_matrix_row_major[] = {2.0, 5.0, 7.0, 11.0};
    double stiffness_matrix_row_major[4]{};
    double dynamic_mass_matrix_row_major[4]{};
    double tangent_mass_matrix_row_major[4]{};
    fd::MfemModalDenseOperatorPayloadResult payload_result{};
    const fd::FrequencyDomainStatus payload_status =
        fd::assemble_mfem_modal_dense_operator_payload(
            fd::MfemModalDenseOperatorPayloadProblem{
                descriptor,
                layout,
                &node,
                nullptr,
                0,
                nullptr,
                nullptr,
                0.0,
                nullptr,
                tangent_lumped_mass,
                1.0,
                0.0,
                stiffness_matrix_row_major,
                dynamic_mass_matrix_row_major,
                tangent_mass_matrix_row_major,
                4,
                nullptr,
                0,
                nullptr,
                nullptr,
                0.0,
                demag_tangent_matrix_row_major,
                4,
                "dynamic_demag_provider.v1",
                nullptr,
                0,
                false,
            },
            &payload_result);

    check(payload_status == fd::FrequencyDomainStatus::ok,
          "dynamic-demag modal dense payload assembly succeeds");
    check(std::abs(stiffness_matrix_row_major[0] - 7.0) < 1.0e-12,
          "dynamic-demag legacy S materializes column-zero first entry");
    check(std::abs(stiffness_matrix_row_major[1] - 11.0) < 1.0e-12,
          "dynamic-demag legacy S materializes column-one first entry");
    check(std::abs(stiffness_matrix_row_major[2] + 2.0) < 1.0e-12,
          "dynamic-demag legacy S materializes column-zero second entry");
    check(std::abs(stiffness_matrix_row_major[3] + 5.0) < 1.0e-12,
          "dynamic-demag legacy S materializes column-one second entry");
}

void modal_shift_invert_dense_full_2x2_payload_accepts_k0_kittel_macrospin()
{
    constexpr double mu0 = 1.25663706212e-6;
    constexpr double gamma0_rad_s_per_a_m = 2.211e5;
    constexpr double field_t = 0.02;
    constexpr double field_a_per_m = field_t / mu0;
    constexpr double omega_rad_s = gamma0_rad_s_per_a_m * field_a_per_m;
    constexpr double expected_frequency_hz = omega_rad_s / (2.0 * M_PI);
    const double stiffness_matrix_row_major[] = {
        omega_rad_s,
        0.0,
        0.0,
        omega_rad_s,
    };
    constexpr double gyrotropic_mass_row_major[] = {
        0.0,
        1.0,
        -1.0,
        0.0,
    };
    constexpr double tangent_mass_row_major[] = {
        1.0,
        0.0,
        0.0,
        1.0,
    };

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.target_frequency_hz = 2.55e9;
    request.frequency_min_hz = 100.0e6;
    request.frequency_max_hz = 5.0e9;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.mfem_mass_matrix_row_major = tangent_mass_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"rust_full_2x2_dense_operator\","
        "\"payload_kind\":\"rust_full_2x2_dense_operator\"}";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "full_2x2 Kittel dense payload should solve through production SLEPc path");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "full_2x2 Kittel dense payload accepts one positive-frequency mode");
    const double frequency_hz =
        extract_json_number(
            result.result_json,
            "\"frequency_hz\":",
            "modal_shift_invert_dense_full_2x2_payload_accepts_k0_kittel_macrospin");
    check(std::abs(frequency_hz - expected_frequency_hz) / expected_frequency_hz < 1.0e-10,
          "full_2x2 Kittel dense payload frequency matches gamma0 H/(2*pi)");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "full_2x2 Kittel dense payload remains unavailable without SLEPc");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator()
{
    namespace fd = fullmag::fem::frequency_domain;

    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM sparse modal payload tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM sparse modal payload tangent layout succeeds");

    const double h_ext_a_per_m[] = {0.0, 0.0, 1.0};
    const double tangent_lumped_mass[] = {2.0};
    uint32_t dynamic_offsets[3]{};
    uint32_t dynamic_columns[2]{};
    double dynamic_values[2]{};
    uint32_t gyrotropic_offsets[3]{};
    uint32_t gyrotropic_columns[2]{};
    double gyrotropic_values[2]{};
    uint32_t mass_offsets[3]{};
    uint32_t mass_columns[2]{};
    double mass_values[2]{};
    fd::MfemModalSparseOperatorPayloadResult payload_result{};
    const fd::FrequencyDomainStatus payload_status =
        fd::assemble_mfem_modal_sparse_operator_payload(
            fd::MfemModalSparseOperatorPayloadProblem{
                fd::MfemModalDenseOperatorPayloadProblem{
                    descriptor,
                    layout,
                    &node,
                    nullptr,
                    0,
                    h_ext_a_per_m,
                    nullptr,
                    0.0,
                    nullptr,
                    tangent_lumped_mass,
                    1.0,
                    0.0,
                    nullptr,
                    nullptr,
                    nullptr,
                    0,
                },
                fd::MfemModalCsrOutputBuffer{
                    dynamic_offsets,
                    3,
                    dynamic_columns,
                    2,
                    dynamic_values,
                    2,
                },
                fd::MfemModalCsrOutputBuffer{
                    gyrotropic_offsets,
                    3,
                    gyrotropic_columns,
                    2,
                    gyrotropic_values,
                    2,
                },
                fd::MfemModalCsrOutputBuffer{
                    mass_offsets,
                    3,
                    mass_columns,
                    2,
                    mass_values,
                    2,
                },
                1.0e-15,
            },
            &payload_result);

    check(payload_status == fd::FrequencyDomainStatus::ok,
          "MFEM modal sparse payload assembly succeeds");
    check(payload_result.tangent_dof_count == 2,
          "MFEM sparse modal payload keeps tangent DOF count");
    check(std::strcmp(payload_result.payload_kind, "sparse_csr_from_dense_linearized_mfem_operator") == 0,
          "MFEM sparse modal payload reports materialized sparse payload kind");
    check(payload_result.dynamic_matrix_nnz == 2,
          "MFEM sparse modal dynamic matrix keeps two nonzero entries");
    check(payload_result.dynamic_mass_matrix_nnz == 2,
          "MFEM sparse modal gyrotropic mass matrix keeps two nonzero entries");
    check(payload_result.tangent_mass_matrix_nnz == 2,
          "MFEM sparse modal tangent mass matrix keeps two nonzero entries");
    check(dynamic_offsets[0] == 0 && dynamic_offsets[1] == 1 && dynamic_offsets[2] == 2,
          "MFEM sparse modal dynamic row offsets are compact");
    check(dynamic_columns[0] == 1 && dynamic_columns[1] == 0,
          "MFEM sparse modal dynamic columns preserve off-diagonal gyrotropic structure");
    check(std::abs(dynamic_values[0] + 1.0) < 1.0e-12,
          "MFEM sparse modal dynamic first value");
    check(std::abs(dynamic_values[1] - 1.0) < 1.0e-12,
          "MFEM sparse modal dynamic second value");
    check(gyrotropic_offsets[0] == 0 && gyrotropic_offsets[1] == 1 && gyrotropic_offsets[2] == 2,
          "MFEM sparse modal gyrotropic row offsets are compact");
    check(gyrotropic_columns[0] == 0 && gyrotropic_columns[1] == 1,
          "MFEM sparse modal gyrotropic columns preserve diagonal mass");
    check(std::abs(gyrotropic_values[0] - 1.0) < 1.0e-12,
          "MFEM sparse modal gyrotropic first value");
    check(std::abs(gyrotropic_values[1] - 1.0) < 1.0e-12,
          "MFEM sparse modal gyrotropic second value");
    check(mass_offsets[0] == 0 && mass_offsets[1] == 1 && mass_offsets[2] == 2,
          "MFEM sparse modal tangent mass row offsets are compact");
    check(mass_columns[0] == 0 && mass_columns[1] == 1,
          "MFEM sparse modal tangent mass columns preserve diagonal mass");
    check(std::abs(mass_values[0] - 2.0) < 1.0e-12,
          "MFEM sparse modal tangent mass first value");
    check(std::abs(mass_values[1] - 2.0) < 1.0e-12,
          "MFEM sparse modal tangent mass second value");

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_sparse_operator_enabled = 1;
    request.mfem_sparse_stiffness_csr =
        FullmagFemCsrMatrixView{2, 2, dynamic_offsets, 3, dynamic_columns, payload_result.dynamic_matrix_nnz, dynamic_values, payload_result.dynamic_matrix_nnz};
    request.mfem_sparse_gyrotropic_csr =
        FullmagFemCsrMatrixView{2, 2, gyrotropic_offsets, 3, gyrotropic_columns, payload_result.dynamic_mass_matrix_nnz, gyrotropic_values, payload_result.dynamic_mass_matrix_nnz};
    request.mfem_sparse_mass_csr =
        FullmagFemCsrMatrixView{2, 2, mass_offsets, 3, mass_columns, payload_result.tangent_mass_matrix_nnz, mass_values, payload_result.tangent_mass_matrix_nnz};
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\",\"payload_kind\":\"sparse_csr_from_dense_linearized_mfem_operator\"}";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    if (result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(
            stderr,
            "FAIL-DIAGNOSTICS: generic_mfem_sparse status=%d error=%.1024s diagnostics=%s result=%s\n",
            static_cast<int>(result.status),
            result.error_message != nullptr ? result.error_message : "null",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "null",
            result.result_json != nullptr ? result.result_json : "null");
    }
    check(result.status == FULLMAG_FEM_FD_OK,
          "MFEM-assembled sparse modal payload should solve through production SLEPc path");
    check(contains(result.diagnostics_json, "\"mfem_operator_payload\":\"sparse_csr\""),
          "MFEM-assembled sparse modal payload diagnostics report sparse CSR payload");
    check(contains(result.diagnostics_json, "\"solver_model\":\"slepc_multi_shift_invert_production_cpu_sparse_csr\""),
          "MFEM-assembled sparse modal payload diagnostics report sparse multi-shift SLEPc family");
    check(contains(result.diagnostics_json, "\"deduplication_mass_matrix\":\"provided_sparse_csr\""),
          "MFEM-assembled sparse modal payload diagnostics report provided sparse tangent mass");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "MFEM-assembled sparse modal payload remains unavailable without SLEPc");
#endif
    check(!contains(result.diagnostics_json, "\"mfem_operator_payload\":\"dense_gyrotropic_matrix\""),
          "MFEM-assembled sparse modal payload must not fall back to the dense MFEM payload lane");
    fullmag_fem_frequency_domain_result_destroy(&result);

#if FULLMAG_FEM_WITH_SLEPC
    request.target_kind = "nearest_frequency";
    request.frequency_min_hz = 0.0;
    request.frequency_max_hz = 0.0;
    request.target_frequency_hz = 0.16;
    FullmagFemFrequencyDomainResult nearest_result =
        fullmag_fem_modal_eigen_solve(&request);
    check(nearest_result.status == FULLMAG_FEM_FD_OK,
          "ordinary k=0 sparse nearest-frequency solve should remain available");
    check(contains(nearest_result.diagnostics_json,
                   "\"solver_adapter\":\"slepc_modal_eigen\""),
          "ordinary k=0 sparse nearest-frequency solve keeps the generic adapter");
    check(!contains(nearest_result.diagnostics_json, "\"ksp_diagnostics_available\":"),
          "generic k=0 nearest-frequency diagnostics omit Floquet-only KSP telemetry");
    check(!contains(nearest_result.diagnostics_json,
                    "\"shifted_ksp_configuration_before_eps\":"),
          "generic k=0 nearest-frequency diagnostics omit Floquet pre-EPS telemetry");
    check(!contains(nearest_result.diagnostics_json,
                    "\"ksp_true_residual_criterion\":"),
          "generic k=0 nearest-frequency diagnostics omit Floquet true-residual telemetry");
    check(!contains(nearest_result.diagnostics_json,
                    "\"ksp_monitor_progress\":"),
          "generic k=0 nearest-frequency diagnostics omit Floquet-only monitor telemetry");
    fullmag_fem_frequency_domain_result_destroy(&nearest_result);

    std::printf("PASS: generic_sparse_mfem_window_and_nearest_certification\n");

    FullmagFemModalEigenRequest missing_mass_request = request;
    missing_mass_request.mfem_sparse_mass_csr = FullmagFemCsrMatrixView{};
    FullmagFemFrequencyDomainResult missing_mass_result =
        fullmag_fem_modal_eigen_solve(&missing_mass_request);
    check(missing_mass_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR &&
              contains(missing_mass_result.diagnostics_json,
                       "invalid_sparse_csr_payload"),
          "generic sparse nearest solve rejects a missing geometric mass CSR payload");
    fullmag_fem_frequency_domain_result_destroy(&missing_mass_result);

    const double invalid_mass_values[] = {-2.0, 2.0};
    FullmagFemModalEigenRequest invalid_mass_request = request;
    invalid_mass_request.mfem_sparse_mass_csr.values = invalid_mass_values;
    FullmagFemFrequencyDomainResult invalid_mass_result =
        fullmag_fem_modal_eigen_solve(&invalid_mass_request);
    check(invalid_mass_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR &&
              contains(invalid_mass_result.diagnostics_json,
                       "invalid_tangent_mass_metric"),
          "generic sparse nearest solve rejects a non-positive geometric mass");
    fullmag_fem_frequency_domain_result_destroy(&invalid_mass_result);
#endif
}

void generic_dense_window_refills_after_search_filtering()
{
    constexpr int tangent_dof_count = 10;
    std::vector<double> stiffness(
        static_cast<std::size_t>(tangent_dof_count * tangent_dof_count), 0.0);
    std::vector<double> gyrotropic(stiffness.size(), 0.0);
    std::vector<double> tangent_mass(stiffness.size(), 0.0);
    for (int block = 0; block < tangent_dof_count / 2; ++block) {
        const int row = 2 * block;
        const double omega = 2.0 * M_PI * static_cast<double>(block + 1);
        stiffness[static_cast<std::size_t>(row * tangent_dof_count + row)] = omega;
        stiffness[static_cast<std::size_t>((row + 1) * tangent_dof_count + row + 1)] = omega;
        gyrotropic[static_cast<std::size_t>(row * tangent_dof_count + row + 1)] = 1.0;
        gyrotropic[static_cast<std::size_t>((row + 1) * tangent_dof_count + row)] = -1.0;
        tangent_mass[static_cast<std::size_t>(row * tangent_dof_count + row)] = 1.0;
        tangent_mass[static_cast<std::size_t>((row + 1) * tangent_dof_count + row + 1)] = 1.0;
    }

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.target_frequency_hz = 1.0;
    request.frequency_min_hz = 0.99;
    request.frequency_max_hz = 1.01;
    request.requested_mode_count = 1;
    request.completeness_policy = 0;
    request.residual_tolerance = 1.0e-10;
    request.max_outer_iterations = 256;
    request.max_linear_iterations = 256;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = tangent_dof_count;
    request.mfem_stiffness_matrix_row_major = stiffness.data();
    request.mfem_gyrotropic_matrix_row_major = gyrotropic.data();
    request.mfem_mass_matrix_row_major = tangent_mass.data();
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"generic_mass_refill_fixture\","
        "\"payload_kind\":\"dense_linearized_mfem_operator\"}";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "best-effort generic dense window retains a certified dimension-limited mode");
    check(contains(result.diagnostics_json,
                   "\"deduplication_mass_matrix\":\"provided_dense_row_major\""),
          "generic dense window uses the provided geometric tangent mass");
    check(contains(result.diagnostics_json, "\"complete\":false") &&
              contains(result.diagnostics_json,
                       "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"partial_convergence\""),
          "best-effort dimension-limited window reports partial, incomplete coverage");
    const int refill_attempts = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"attempt_count\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int solved_attempts = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"solved_attempt_count\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int initial_nev = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"initial_nev\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int last_nev = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"last_attempt_nev\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int initial_ncv = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"initial_resolved_ncv\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int initial_mpd = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"initial_resolved_mpd\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int last_ncv = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"last_attempt_ncv\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int last_mpd = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"last_attempt_mpd\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int last_finalized_attempt = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"last_finalized_attempt\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int outer_iteration_budget = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"outer_iteration_budget\":",
        "generic_dense_window_refills_after_search_filtering"));
    const int cumulative_outer_iterations = static_cast<int>(extract_json_number(
        result.diagnostics_json,
        "\"cumulative_outer_iterations\":",
        "generic_dense_window_refills_after_search_filtering"));
    check(refill_attempts >= 2 && solved_attempts >= 2,
          "generic provider performs another solved EPS attempt after search-window filtering");
    check(initial_nev > 0 && last_nev > initial_nev,
          "generic provider increases NEV after the first solved attempt");
    check(initial_ncv > 0 && initial_mpd > 0 &&
              last_ncv == initial_ncv && last_mpd == initial_mpd,
          "generic provider preserves the initially resolved NCV and MPD across refill");
    check(last_finalized_attempt == refill_attempts,
          "generic provider publishes only the final attempt's certified pool");
    check(outer_iteration_budget > 0 && cumulative_outer_iterations >= 0 &&
              cumulative_outer_iterations <= outer_iteration_budget,
          "generic provider reports cumulative iterations within the first-attempt budget");
    check(contains(result.result_json, "\"accepted_mode_count\":1") &&
              contains(result.result_json, "\"modes\":["),
          "best-effort partial result retains the certified window mode");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "generic dense refill fixture remains unavailable without SLEPc");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);

#if FULLMAG_FEM_WITH_SLEPC
    FullmagFemModalEigenRequest missing_mass_request = request;
    missing_mass_request.mfem_mass_matrix_row_major = nullptr;
    FullmagFemFrequencyDomainResult missing_mass =
        fullmag_fem_modal_eigen_solve(&missing_mass_request);
    check(missing_mass.status == FULLMAG_FEM_FD_VALIDATION_ERROR &&
              contains(missing_mass.diagnostics_json,
                       "invalid_tangent_mass_metric"),
          "generic dense window rejects a missing geometric tangent mass");
    fullmag_fem_frequency_domain_result_destroy(&missing_mass);

    std::vector<double> asymmetric_mass = tangent_mass;
    asymmetric_mass[1] = 0.25;
    FullmagFemModalEigenRequest invalid_mass_request = request;
    invalid_mass_request.mfem_mass_matrix_row_major = asymmetric_mass.data();
    FullmagFemFrequencyDomainResult invalid_mass =
        fullmag_fem_modal_eigen_solve(&invalid_mass_request);
    check(invalid_mass.status == FULLMAG_FEM_FD_VALIDATION_ERROR &&
              contains(invalid_mass.diagnostics_json,
                       "invalid_tangent_mass_metric"),
          "generic dense window rejects an asymmetric geometric tangent mass");
    fullmag_fem_frequency_domain_result_destroy(&invalid_mass);

    FullmagFemModalEigenRequest nearest_underfill_request = request;
    nearest_underfill_request.target_kind = "nearest_frequency";
    nearest_underfill_request.target_frequency_hz = 2.5;
    nearest_underfill_request.frequency_min_hz = 0.0;
    nearest_underfill_request.frequency_max_hz = 0.0;
    nearest_underfill_request.requested_mode_count = 6;
    FullmagFemFrequencyDomainResult nearest_underfill =
        fullmag_fem_modal_eigen_solve(&nearest_underfill_request);
    check(nearest_underfill.status == FULLMAG_FEM_FD_SOLVE_ERROR,
          "generic nearest request fails closed when the physical pool is smaller than the requested count");
    check(contains(nearest_underfill.diagnostics_json,
                   "\"certified_partial_candidate_count\":"),
          "generic nearest underfill retains certified candidates as diagnostics");
    check(!contains(nearest_underfill.result_json, "\"modes\":[") &&
              contains(nearest_underfill.result_json, "\"solve_complete\":false"),
          "generic nearest underfill does not publish partial candidates as canonical modes");
    fullmag_fem_frequency_domain_result_destroy(&nearest_underfill);

    FullmagFemModalEigenRequest budget_request = request;
    budget_request.target_kind = "nearest_frequency";
    budget_request.target_frequency_hz = 1.0;
    budget_request.frequency_min_hz = 0.0;
    budget_request.frequency_max_hz = 0.0;
    budget_request.requested_mode_count = 1;
    budget_request.residual_tolerance = 1.0e-30;
    budget_request.max_outer_iterations = 1;
    FullmagFemFrequencyDomainResult budget_result =
        fullmag_fem_modal_eigen_solve(&budget_request);
    check(budget_result.status == FULLMAG_FEM_FD_SOLVE_ERROR &&
              contains(budget_result.diagnostics_json,
                       "\"outer_iteration_budget\":1"),
          "generic nearest solve fails closed and records a one-iteration EPS budget");
    if (!contains(budget_result.diagnostics_json,
                  "\"outer_iteration_budget_exhausted\":true")) {
        std::fprintf(
            stderr,
            "FAIL-DIAGNOSTICS: generic_budget status=%d error=%.1024s diagnostics=%s result=%s\n",
            static_cast<int>(budget_result.status),
            budget_result.error_message != nullptr ? budget_result.error_message : "null",
            budget_result.diagnostics_json != nullptr ? budget_result.diagnostics_json : "null",
            budget_result.result_json != nullptr ? budget_result.result_json : "null");
    }
    check(contains(budget_result.diagnostics_json,
                   "\"outer_iteration_budget_exhausted\":true") &&
              !contains(budget_result.result_json, "\"modes\":["),
          "generic budget exhaustion remains explicit and does not publish a canonical partial mode");
    fullmag_fem_frequency_domain_result_destroy(&budget_result);
#endif
}

void modal_without_validation_problem_stays_unavailable()
{
    FullmagFemModalEigenRequest request = base_request();

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal contract without validation problem stays unavailable");
    check(contains(result.diagnostics_json, "\"study_product\":\"modal_eigen\""),
          "modal diagnostics preserve study_product");
    check(contains(result.diagnostics_json, "progress_schema_version"),
          "modal diagnostics expose progress schema");
    check(contains(result.result_json, "\"status\":\"unavailable\""),
          "modal result json reports unavailable");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void assert_modal_phase_kinematics(
    const std::string &json,
    const std::string &test_context,
    double expected_lambda_imag,
    const char *expected_phasor_convention,
    bool require_mode_vectors)
{
    const auto number = [&](const char *key) {
        return extract_json_number(json.c_str(), key, test_context.c_str());
    };
    const auto close_to = [&](double actual, double expected, double tolerance,
                              const char *field) {
        const std::string message = test_context + " " + field;
        check(
            std::isfinite(actual) && std::abs(actual - expected) <= tolerance,
            message.c_str());
    };

    check(
        contains(
            json.c_str(),
            (std::string("\"phasor_convention\":\"") +
             expected_phasor_convention + "\"").c_str()),
        (test_context + " reports the actual phasor convention").c_str());
    const std::size_t phasor_key = json.find("\"phasor_convention\":");
    check(phasor_key != std::string::npos, "kinematics record has phasor provenance");
    check(
        json.find("\"phasor_convention\":", phasor_key + 1u) == std::string::npos,
        (test_context + " has exactly one phasor-convention key").c_str());

    const double frequency_hz = number("\"frequency_hz\":");
    const double omega_rad_s = number("\"omega_rad_s\":");
    const double lambda_real = number("\"lambda_real_per_s\":");
    const double lambda_imag = number("\"lambda_imag_rad_per_s\":");
    const double eigenvalue_real = number("\"eigenvalue_real\":");
    const double eigenvalue_imag = number("\"eigenvalue_imag\":");
    const double branch_sign = number("\"branch_sign\":");
    const double relative_residual = number("\"relative_residual\":");
    close_to(frequency_hz, 1.0, 1.0e-6, "frequency_hz is positive and convention mapped");
    close_to(omega_rad_s, 6.2831853071795864769, 1.0e-5,
             "omega_rad_s is positive and convention mapped");
    close_to(lambda_real, 0.0, 1.0e-5, "raw lambda real part is preserved");
    close_to(lambda_imag, expected_lambda_imag, 1.0e-5,
             "raw lambda imaginary sign follows the requested convention");
    close_to(eigenvalue_real, lambda_real, 0.0,
             "eigenvalue_real preserves the raw lambda real part");
    close_to(eigenvalue_imag, lambda_imag, 0.0,
             "eigenvalue_imag preserves the raw lambda imaginary part");
    close_to(branch_sign, 1.0, 0.0, "branch_sign selects positive physical frequency");
    check(
        std::isfinite(relative_residual) && relative_residual >= 0.0 &&
            relative_residual <= 1.0e-8,
        (test_context + " retains a finite accepted residual").c_str());

    if (require_mode_vectors) {
        const std::size_t real_vector = json.find("\"mode_vector_real\":[");
        const std::size_t imag_vector = json.find("\"mode_vector_imag\":[");
        check(real_vector != std::string::npos,
              (test_context + " retains mode_vector_real").c_str());
        check(imag_vector != std::string::npos,
              (test_context + " retains mode_vector_imag").c_str());
        const std::size_t real_end = json.find(']', real_vector);
        const std::size_t imag_end = json.find(']', imag_vector);
        check(real_end > real_vector + std::strlen("\"mode_vector_real\":["),
              (test_context + " retains real mode-vector amplitudes").c_str());
        check(imag_end > imag_vector + std::strlen("\"mode_vector_imag\":["),
              (test_context + " retains imaginary mode-vector amplitudes").c_str());
    }
}

void generic_slepc_phase_convention_cabi()
{
    constexpr int tangent_dof_count = 10;
    const std::size_t matrix_size =
        static_cast<std::size_t>(tangent_dof_count * tangent_dof_count);
    std::vector<double> stiffness(matrix_size, 0.0);
    std::vector<double> gyrotropic(matrix_size, 0.0);
    std::vector<double> tangent_mass(matrix_size, 0.0);
    for (int block = 0; block < tangent_dof_count / 2; ++block) {
        const int row = 2 * block;
        const double omega = 6.2831853071795864769 *
            static_cast<double>(block + 1);
        stiffness[static_cast<std::size_t>(row * tangent_dof_count + row)] = omega;
        stiffness[static_cast<std::size_t>(
            (row + 1) * tangent_dof_count + row + 1)] = omega;
        gyrotropic[static_cast<std::size_t>(
            row * tangent_dof_count + row + 1)] = 1.0;
        gyrotropic[static_cast<std::size_t>(
            (row + 1) * tangent_dof_count + row)] = -1.0;
        tangent_mass[static_cast<std::size_t>(
            row * tangent_dof_count + row)] = 1.0;
        tangent_mass[static_cast<std::size_t>(
            (row + 1) * tangent_dof_count + row + 1)] = 1.0;
    }

    const CsrOwned stiffness_csr = dense_to_csr(
        tangent_dof_count, tangent_dof_count, stiffness.data());
    const CsrOwned gyrotropic_csr = dense_to_csr(
        tangent_dof_count, tangent_dof_count, gyrotropic.data());
    const CsrOwned mass_csr = dense_to_csr(
        tangent_dof_count, tangent_dof_count, tangent_mass.data());
    const bool sparse_payloads[] = {false, true};
    const char *target_kinds[] = {"nearest_frequency", "frequency_window"};
    const bool negative_phasors[] = {false, true};

    for (const bool sparse_payload : sparse_payloads) {
        for (const char *target_kind : target_kinds) {
            for (const bool negative_phasor : negative_phasors) {
                FullmagFemModalEigenRequest request = base_request();
                request.operator_request.mesh_asset_id =
                    "generic_modal_phase_convention_fixture";
                request.target_kind = target_kind;
                request.target_frequency_hz = 1.0;
                request.frequency_min_hz =
                    std::strcmp(target_kind, "frequency_window") == 0 ? 0.99 : 0.0;
                request.frequency_max_hz =
                    std::strcmp(target_kind, "frequency_window") == 0 ? 1.01 : 0.0;
                request.requested_mode_count = 1;
                request.completeness_policy = 0;
                request.residual_tolerance = 1.0e-10;
                request.max_outer_iterations = 256;
                request.max_linear_iterations = 256;
                request.eigensolver_family = 1;
                request.phase_convention = negative_phasor
                    ? FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T
                    : FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
                request.operator_request.operator_diagnostics_json =
                    "{\"operator_family\":\"generic_modal_phase_convention_fixture\","
                    "\"payload_kind\":\"dense_linearized_mfem_operator\"}";
                if (sparse_payload) {
                    request.mfem_sparse_operator_enabled = 1;
                    request.mfem_sparse_stiffness_csr = stiffness_csr.view();
                    request.mfem_sparse_gyrotropic_csr = gyrotropic_csr.view();
                    request.mfem_sparse_mass_csr = mass_csr.view();
                    request.operator_request.operator_diagnostics_json =
                        "{\"operator_family\":\"generic_modal_phase_convention_fixture\","
                        "\"payload_kind\":\"sparse_csr\"}";
                } else {
                    request.mfem_operator_enabled = 1;
                    request.mfem_tangent_dof_count = tangent_dof_count;
                    request.mfem_stiffness_matrix_row_major = stiffness.data();
                    request.mfem_gyrotropic_matrix_row_major = gyrotropic.data();
                    request.mfem_mass_matrix_row_major = tangent_mass.data();
                }

                char context[160]{};
                std::snprintf(
                    context,
                    sizeof(context),
                    "%s %s %s",
                    sparse_payload ? "CSR" : "dense",
                    target_kind,
                    negative_phasor ? "exp_minus_i_omega_t" : "exp_i_omega_t");
                FullmagFemFrequencyDomainResult result =
                    fullmag_fem_modal_eigen_solve(&request);
                check(
                    result.status == FULLMAG_FEM_FD_OK,
                    "generic SLEPc C ABI phase fixture must produce accepted modes");
                check(
                    contains(result.diagnostics_json, "\"solver_adapter\":\"slepc_modal_eigen\""),
                    "generic phase fixture must use the SLEPc modal provider");
                check(
                    contains(
                        result.diagnostics_json,
                        sparse_payload
                            ? "\"mfem_operator_payload\":\"sparse_csr\""
                            : "\"mfem_operator_payload\":\"dense_gyrotropic_matrix\""),
                    "generic phase fixture must exercise the requested dense or CSR provider");

                const std::string result_json = result.result_json;
                const std::size_t modes_key = result_json.find("\"modes\":[");
                check(modes_key != std::string::npos,
                      "generic SLEPc result must publish its mode array");
                const std::string top_level = result_json.substr(0, modes_key);
                const char *phasor_label = negative_phasor
                    ? "exp_minus_i_omega_t" : "exp_i_omega_t";
                const double expected_lambda_imag = negative_phasor
                    ? -6.2831853071795864769 : 6.2831853071795864769;
                assert_modal_phase_kinematics(
                    top_level,
                    std::string(context) + " top-level",
                    expected_lambda_imag,
                    phasor_label,
                    false);
                const double accepted_mode_count = extract_json_number(
                    top_level.c_str(),
                    "\"accepted_mode_count\":",
                    context);
                check(
                    accepted_mode_count == 1.0,
                    "focused phase fixture must select exactly one physical mode");
                const std::size_t mode_begin = result_json.find('{', modes_key);
                const std::size_t mode_end = result_json.find('}', mode_begin);
                check(
                    mode_begin != std::string::npos &&
                        mode_end != std::string::npos,
                    "generic SLEPc result must contain its single mode object");
                const std::string mode = result_json.substr(
                    mode_begin,
                    mode_end - mode_begin + 1u);
                check(
                    result_json.find("\"mode_index\":1", mode_end + 1u) ==
                        std::string::npos,
                    "focused phase result must not publish an additional mode");
                assert_modal_phase_kinematics(
                    mode,
                    std::string(context) + " mode 0",
                    expected_lambda_imag,
                    phasor_label,
                    true);
                fullmag_fem_frequency_domain_result_destroy(&result);
            }
        }
    }
}

void modal_sparse_validation_error_preserves_explicit_k_vector()
{
    constexpr double k_vector_rad_m[] = {0.0, 0.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.mfem_sparse_operator_enabled = 1;
    request.mfem_sparse_stiffness_csr.row_count = 1;
    request.mfem_sparse_stiffness_csr.column_count = 1;
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal sparse validation error keeps validation status");
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "modal sparse validation diagnostics preserve the explicit k-vector");
    check(contains(result.diagnostics_json, "\"k_vector_len\":3"),
          "modal sparse validation diagnostics preserve the explicit k-vector length");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_diagnostics_preserve_explicit_k_vector()
{
    constexpr double k_vector_rad_m[] = {0.0, 0.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "modal diagnostics preserve the explicit k-vector");
    check(contains(result.diagnostics_json, "\"k_vector_len\":3"),
          "modal diagnostics preserve the explicit k-vector length");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_floquet_wavevector_validation_precedes_tiny_dispatch()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};
    const auto check_tiny_matrix_buffer_bindings = [
        expected_mass = gyrotropic_mass_row_major,
        expected_stiffness = stiffness_matrix_row_major](const char *case_name,
                                                       const char *phase,
                                                       const FullmagFemModalEigenRequest &request) {
        char message[256]{};
        std::snprintf(message,
                      sizeof(message),
                      "case=%s phase=%s mass pointer must remain bound to the outer fixture buffer",
                      case_name,
                      phase);
        check(request.tiny_validation_mass_matrix_row_major == expected_mass,
              message);
        std::snprintf(message,
                      sizeof(message),
                      "case=%s phase=%s stiffness pointer must remain bound to the outer fixture buffer",
                      case_name,
                      phase);
        check(request.tiny_validation_stiffness_matrix_row_major == expected_stiffness,
              message);
    };
    const auto tiny_floquet_request = [
        mass_buffer = gyrotropic_mass_row_major,
        stiffness_buffer = stiffness_matrix_row_major,
        &check_tiny_matrix_buffer_bindings]() {
        FullmagFemModalEigenRequest request = base_request();
        request.operator_request.spin_wave_bc_kind = "floquet";
        request.tiny_validation_enabled = 1;
        request.tiny_validation_tangent_dof_count = 2;
        request.tiny_validation_stiffness_matrix_row_major = stiffness_buffer;
        request.tiny_validation_mass_matrix_row_major = mass_buffer;
        check_tiny_matrix_buffer_bindings("tiny_floquet_request", "construction", request);
        return request;
    };
    const FullmagFemModalEigenRequest initial_factory_request = tiny_floquet_request();
    check_tiny_matrix_buffer_bindings(
        "initial_factory_request",
        "before first C ABI call",
        initial_factory_request);
    const auto expect_invalid_wavevector = [&](const char *case_name,
                                              FullmagFemModalEigenRequest request) {
        check_tiny_matrix_buffer_bindings(case_name, "after input mutations", request);
        FullmagFemFrequencyDomainResult result =
            fullmag_fem_modal_eigen_solve(&request);
        check_tiny_matrix_buffer_bindings(case_name, "after solve", request);
        check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
              "an invalid declared Floquet wavevector must fail validation");
        check(contains(result.diagnostics_json, "invalid_floquet_wavevector"),
              "invalid Floquet wavevector diagnostics must expose a stable reason");
        check(!contains(result.diagnostics_json, "tiny_validation_solver"),
              "invalid Floquet wavevector must be rejected before tiny validation");
        fullmag_fem_frequency_domain_result_destroy(&result);
        check_tiny_matrix_buffer_bindings(case_name, "after result destroy", request);
    };
    const auto report_unexpected_success_status = [](
        const char *case_name,
        const FullmagFemFrequencyDomainResult &result) {
        if (result.status == FULLMAG_FEM_FD_OK) {
            return;
        }
        std::fprintf(
            stderr,
            "INFO: modal C ABI case=%s status=%u error=%.512s diagnostics=%.2048s\n",
            case_name,
            static_cast<unsigned int>(result.status),
            result.error_message != nullptr ? result.error_message : "",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "");
    };

    const double nonfinite_components[] = {
        std::numeric_limits<double>::quiet_NaN(),
        std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity(),
    };
    const char *const fixed_nonfinite_case_names[] = {
        "fixed_nan",
        "fixed_positive_infinity",
        "fixed_negative_infinity",
    };
    for (std::size_t index = 0; index < 3; ++index) {
        FullmagFemModalEigenRequest request = tiny_floquet_request();
        request.has_floquet_k_vector = 1;
        request.floquet_k_vector_rad_per_m[0] = nonfinite_components[index];
        expect_invalid_wavevector(fixed_nonfinite_case_names[index], request);
    }

    const double short_wavevector[] = {0.0, 0.0};
    const double raw_zero_wavevector[] = {0.0, 0.0, 0.0};
    const double long_wavevector[] = {0.0, 0.0, 0.0, 0.0};
    FullmagFemModalEigenRequest invalid_length = tiny_floquet_request();
    invalid_length.operator_request.k_vector_rad_m = short_wavevector;
    invalid_length.operator_request.k_vector_len = 2;
    expect_invalid_wavevector("short_raw_vector", invalid_length);

    const int invalid_raw_lengths[] = {0, -1, 4};
    const char *const invalid_raw_length_case_names[] = {
        "zero_raw_length",
        "negative_raw_length",
        "long_raw_length",
    };
    for (std::size_t index = 0; index < 3; ++index) {
        const int invalid_raw_length = invalid_raw_lengths[index];
        FullmagFemModalEigenRequest invalid_raw_length_request = tiny_floquet_request();
        invalid_raw_length_request.operator_request.k_vector_rad_m =
            invalid_raw_length == 4 ? long_wavevector : raw_zero_wavevector;
        invalid_raw_length_request.operator_request.k_vector_len = invalid_raw_length;
        expect_invalid_wavevector(
            invalid_raw_length_case_names[index],
            invalid_raw_length_request);
    }

    FullmagFemModalEigenRequest null_raw_pointer_with_length = tiny_floquet_request();
    null_raw_pointer_with_length.operator_request.k_vector_rad_m = nullptr;
    null_raw_pointer_with_length.operator_request.k_vector_len = 3;
    expect_invalid_wavevector("null_raw_pointer_with_length", null_raw_pointer_with_length);

    const char *const raw_nonfinite_case_names[] = {
        "raw_nan_component",
        "raw_positive_infinity_component",
        "raw_negative_infinity_component",
    };
    for (std::size_t index = 0; index < 3; ++index) {
        const double raw_nonfinite_wavevector[] = {nonfinite_components[index], 0.0, 0.0};
        FullmagFemModalEigenRequest request = tiny_floquet_request();
        request.operator_request.k_vector_rad_m = raw_nonfinite_wavevector;
        request.operator_request.k_vector_len = 3;
        expect_invalid_wavevector(raw_nonfinite_case_names[index], request);
    }

    // A valid raw vector takes precedence over a malformed fixed-array fallback.
    FullmagFemModalEigenRequest raw_vector_wins = tiny_floquet_request();
    raw_vector_wins.operator_request.k_vector_rad_m = raw_zero_wavevector;
    raw_vector_wins.operator_request.k_vector_len = 3;
    raw_vector_wins.has_floquet_k_vector = 1;
    raw_vector_wins.floquet_k_vector_rad_per_m[0] =
        std::numeric_limits<double>::quiet_NaN();
    check(raw_vector_wins.tiny_validation_mass_matrix_row_major == gyrotropic_mass_row_major,
          "raw-vector fixture must bind the live mass buffer before the C ABI call");
    check(raw_vector_wins.tiny_validation_stiffness_matrix_row_major == stiffness_matrix_row_major,
          "raw-vector fixture must bind the live stiffness buffer before the C ABI call");
    FullmagFemFrequencyDomainResult raw_vector_wins_result =
        fullmag_fem_modal_eigen_solve(&raw_vector_wins);
    if (raw_vector_wins_result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(
            stderr,
            "INFO: modal C ABI fixture case=raw_vector_wins abi=%u struct_size=%llu "
            "request_size=%zu mass_offset=%zu mass_field_size=%zu "
            "request_mass_ptr=%p fixture_mass_ptr=%p pointer_matches=%d "
            "fixture_mass=[%.17g,%.17g,%.17g,%.17g]\n",
            static_cast<unsigned int>(raw_vector_wins.abi_version),
            static_cast<unsigned long long>(raw_vector_wins.struct_size),
            sizeof(raw_vector_wins),
            offsetof(FullmagFemModalEigenRequest, tiny_validation_mass_matrix_row_major),
            sizeof(raw_vector_wins.tiny_validation_mass_matrix_row_major),
            const_cast<void *>(static_cast<const void *>(
                raw_vector_wins.tiny_validation_mass_matrix_row_major)),
            const_cast<void *>(static_cast<const void *>(gyrotropic_mass_row_major)),
            raw_vector_wins.tiny_validation_mass_matrix_row_major ==
                gyrotropic_mass_row_major,
            gyrotropic_mass_row_major[0],
            gyrotropic_mass_row_major[1],
            gyrotropic_mass_row_major[2],
            gyrotropic_mass_row_major[3]);
    }
    report_unexpected_success_status("raw_vector_wins", raw_vector_wins_result);
    check(raw_vector_wins_result.status == FULLMAG_FEM_FD_OK,
          "a finite raw vector must take precedence over a nonfinite fixed-array fallback");
    check(contains(raw_vector_wins_result.diagnostics_json,
                   "\"tiny_validation_solver\":true"),
          "a valid raw Gamma vector must preserve tiny-validation dispatch");
    fullmag_fem_frequency_domain_result_destroy(&raw_vector_wins_result);

    // A positive but invalid raw length must not be hidden by a valid fallback.
    FullmagFemModalEigenRequest raw_invalid_length_with_fallback = tiny_floquet_request();
    raw_invalid_length_with_fallback.operator_request.k_vector_rad_m = short_wavevector;
    raw_invalid_length_with_fallback.operator_request.k_vector_len = 2;
    raw_invalid_length_with_fallback.has_floquet_k_vector = 1;
    expect_invalid_wavevector("raw_invalid_length_with_fallback", raw_invalid_length_with_fallback);

    // An empty raw pointer/length pair can still select the explicit fallback.
    FullmagFemModalEigenRequest raw_empty_with_fallback = tiny_floquet_request();
    raw_empty_with_fallback.operator_request.k_vector_rad_m = raw_zero_wavevector;
    raw_empty_with_fallback.operator_request.k_vector_len = 0;
    raw_empty_with_fallback.has_floquet_k_vector = 1;
    FullmagFemFrequencyDomainResult raw_empty_with_fallback_result =
        fullmag_fem_modal_eigen_solve(&raw_empty_with_fallback);
    report_unexpected_success_status(
        "raw_empty_with_fallback",
        raw_empty_with_fallback_result);
    check(raw_empty_with_fallback_result.status == FULLMAG_FEM_FD_OK,
          "a nonnull zero-length raw vector must preserve the fixed-array fallback");
    check(contains(raw_empty_with_fallback_result.diagnostics_json,
                   "\"tiny_validation_solver\":true"),
          "the fixed-array fallback must preserve tiny-validation dispatch");
    fullmag_fem_frequency_domain_result_destroy(&raw_empty_with_fallback_result);

    // A null raw pointer also selects the fixed-array fallback when it is declared.
    FullmagFemModalEigenRequest null_raw_with_fallback = tiny_floquet_request();
    null_raw_with_fallback.operator_request.k_vector_rad_m = nullptr;
    null_raw_with_fallback.operator_request.k_vector_len = 3;
    null_raw_with_fallback.has_floquet_k_vector = 1;
    FullmagFemFrequencyDomainResult null_raw_with_fallback_result =
        fullmag_fem_modal_eigen_solve(&null_raw_with_fallback);
    report_unexpected_success_status(
        "null_raw_with_fallback",
        null_raw_with_fallback_result);
    check(null_raw_with_fallback_result.status == FULLMAG_FEM_FD_OK,
          "a declared fixed array must remain available when the raw pointer is null");
    check(contains(null_raw_with_fallback_result.diagnostics_json,
                   "\"tiny_validation_solver\":true"),
          "the null-pointer fixed-array fallback must preserve tiny-validation dispatch");
    fullmag_fem_frequency_domain_result_destroy(&null_raw_with_fallback_result);

    // A missing explicit vector remains the legacy implicit-Gamma request.
    FullmagFemModalEigenRequest implicit_gamma = tiny_floquet_request();
    FullmagFemFrequencyDomainResult implicit_gamma_result =
        fullmag_fem_modal_eigen_solve(&implicit_gamma);
    check(implicit_gamma_result.status == FULLMAG_FEM_FD_OK,
          "Floquet Gamma without an explicit vector must preserve implicit-Gamma compatibility");
    check(contains(implicit_gamma_result.diagnostics_json,
                   "\"tiny_validation_solver\":true"),
          "implicit Floquet Gamma must retain the existing tiny-validation dispatch");
    fullmag_fem_frequency_domain_result_destroy(&implicit_gamma_result);

    // The ABI's fixed-array presence flag is another explicit k-vector source.
    FullmagFemModalEigenRequest explicit_gamma = tiny_floquet_request();
    explicit_gamma.has_floquet_k_vector = 1;
    FullmagFemFrequencyDomainResult explicit_gamma_result =
        fullmag_fem_modal_eigen_solve(&explicit_gamma);
    check(explicit_gamma_result.status == FULLMAG_FEM_FD_OK,
          "a finite explicit Gamma vector must remain valid");
    check(contains(explicit_gamma_result.diagnostics_json,
                   "\"tiny_validation_solver\":true"),
          "finite explicit Gamma must preserve the existing tiny-validation dispatch");
    fullmag_fem_frequency_domain_result_destroy(&explicit_gamma_result);
}

void modal_nonzero_k_floquet_payload_rejects_until_production_operator_exists()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};
    constexpr double k_vector_rad_m[] = {1.0e6, 0.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet modal payload must remain unavailable until the production operator exists");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "nonzero-k Floquet modal diagnostics expose production CPU rejection reason");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_scope\":\"selected_spectrum_nonzero_k_floquet_modal\""),
          "nonzero-k Floquet modal diagnostics expose rejection scope");
    check(contains(result.diagnostics_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\""),
          "nonzero-k Floquet modal diagnostics name the missing operator contract");
    check(contains(result.diagnostics_json,
                   "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\""),
          "nonzero-k Floquet modal diagnostics name the missing operator payload kind");
    check(contains(result.diagnostics_json, "\"modal_periodic_pair_contract_available\":false"),
          "nonzero-k Floquet modal diagnostics report missing modal periodic-pair contract");
    check(contains(result.result_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\""),
          "nonzero-k Floquet modal result names the missing operator contract");
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[1000000,0,0]"),
          "nonzero-k Floquet modal diagnostics preserve the requested k-vector");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_never_enters_k0_poisson_path()
{
    constexpr double k_vector_rad_m[] = {1.0e6, 0.0, 0.0};

    fd::ModalEigenRequest request{};
    request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;
    request.poisson_airbox_shared_domain_enabled = 1;

    const fd::FrequencyDomainContractResult result =
        fd::solve_modal_eigen_contract(request);
    check(result.status == fd::FrequencyDomainStatus::unavailable,
          "nonzero-k Floquet shared-domain request must remain unavailable");
    check(result.error_message.find("real k=0 Poisson-airbox path") != std::string::npos,
          "nonzero-k Floquet shared-domain request must explain the k=0 routing guard");
    check(result.diagnostics_json.find(
              "\"unsupported_reason\":\"nonzero_k_floquet_k0_poisson_path\"") !=
              std::string::npos,
          "nonzero-k Floquet shared-domain diagnostics must expose the k=0 routing guard");
    check(result.result_json.find(
              "\"required_operator_contract\":\"bloch_floquet_airbox_shared_domain_operator\"") !=
              std::string::npos,
          "nonzero-k Floquet shared-domain result must name the required operator");
}

void modal_nonzero_k_floquet_legacy_poisson_block_never_enters_k0_solver()
{
    constexpr double k_vector_rad_m[] = {1.0e6, 0.0, 0.0};

    fd::ModalEigenRequest request{};
    request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;
    request.poisson_airbox_block_enabled = 1;

    const fd::FrequencyDomainContractResult result =
        fd::solve_modal_eigen_contract(request);
    check(result.status == fd::FrequencyDomainStatus::unavailable,
          "nonzero-k Floquet legacy Poisson block must remain unavailable");
    check(result.diagnostics_json.find(
              "\"unsupported_reason\":\"nonzero_k_floquet_k0_poisson_path\"") !=
              std::string::npos,
          "nonzero-k Floquet legacy Poisson diagnostics must expose the k=0 routing guard");
}

void modal_k0_shared_domain_without_mfem_is_unavailable()
{
#if !FULLMAG_HAS_MFEM_STACK
    FullmagFemModalSharedDomainPayload payload{};
    fd::ModalEigenRequest request{};
    request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.execution_target = fd::ModalExecutionTarget::production_cpu;
    request.spectral_transform_kind = fd::ModalSpectralTransformKind::shift_invert;
    request.result_field_representation = fd::ModalResultFieldRepresentation::tangent_q;
    request.poisson_airbox_shared_domain_enabled = 1;
    request.poisson_airbox_shared_domain_payload = &payload;

    const fd::FrequencyDomainContractResult present_payload_result =
        fd::solve_modal_eigen_contract(request);
    check(present_payload_result.status == fd::FrequencyDomainStatus::unavailable,
          "no-MFEM k=0 shared-domain request with a payload is explicitly unavailable");
    check(present_payload_result.diagnostics_json.find(
              "\"unsupported_reason\":\"shared_domain_requires_mfem_stack\"") !=
              std::string::npos,
          "no-MFEM shared-domain diagnostics name the required MFEM stack");
    check(present_payload_result.modal_execution.execution_target ==
              static_cast<std::uint32_t>(fd::ModalExecutionTarget::production_cpu),
          "no-MFEM shared-domain result preserves the requested CPU execution target");
    check(present_payload_result.modal_execution.spectral_transform_kind ==
              static_cast<std::uint32_t>(fd::ModalSpectralTransformKind::shift_invert),
          "no-MFEM shared-domain result preserves the requested spectral transform");

    request.poisson_airbox_shared_domain_payload = nullptr;
    const fd::FrequencyDomainContractResult missing_payload_result =
        fd::solve_modal_eigen_contract(request);
    check(missing_payload_result.status == fd::FrequencyDomainStatus::validation_error,
          "no-MFEM k=0 shared-domain request still validates a missing payload first");
    check(missing_payload_result.diagnostics_json.find(
              "\"reason\":\"missing_shared_domain_payload\"") != std::string::npos,
          "missing shared-domain payload retains its validation reason without MFEM");
#endif
}

void modal_nonzero_k_floquet_tail_payload_preserves_periodic_pair_contract()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal Floquet tail payload must reject until the production operator exists");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "modal Floquet tail diagnostics expose production CPU rejection reason");
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[1000000,0,0]"),
          "modal Floquet tail diagnostics preserve the requested k-vector");
    check(contains(result.diagnostics_json, "\"floquet_periodic_pair_count\":1"),
          "modal Floquet tail diagnostics preserve the periodic-pair count");
    check(contains(result.diagnostics_json,
                   "\"modal_periodic_pair_contract_available\":true"),
          "modal Floquet tail diagnostics report the supplied periodic-pair contract");
    check(contains(result.diagnostics_json,
                   "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\""),
          "modal Floquet tail diagnostics still name the missing operator payload kind");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_reaches_production_solver()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "nonzero-k Floquet Bloch payload reaches the production SLEPc path");
    check(contains(result.diagnostics_json, "\"execution_lane\":\"production_cpu\""),
          "nonzero-k Floquet Bloch payload diagnostics report production lane");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "nonzero-k Floquet Bloch payload solves one accepted mode");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet Bloch payload remains unavailable without SLEPc");
#endif
    check(!contains(result.diagnostics_json,
                    "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "nonzero-k Floquet Bloch payload must not be rejected as a missing operator");
    check(contains(result.diagnostics_json, "\"floquet_periodic_pair_count\":1"),
          "nonzero-k Floquet Bloch payload diagnostics preserve periodic-pair count");
    check(contains(result.diagnostics_json,
                   "\"payload_kind\":\"bloch_floquet_tangent_operator\""),
          "nonzero-k Floquet Bloch payload diagnostics preserve operator payload kind");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_rejects_gated_operator_terms()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"operator_terms_included\":[\"exchange\",\"dynamic_demag\"]}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    if (!contains(result.diagnostics_json,
                  "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\"")) {
        std::fprintf(stderr,
                     "INFO: gated Floquet terms status=%u include_demag=%d pair_count=%llu "
                     "error=%.512s operator=%.512s diagnostics=%.2048s result=%.2048s\n",
                     static_cast<unsigned int>(result.status),
                     request.operator_request.include_demag,
                     static_cast<unsigned long long>(request.mfem_floquet_periodic_pair_count),
                     result.error_message != nullptr ? result.error_message : "",
                     request.operator_request.operator_diagnostics_json,
                     result.diagnostics_json != nullptr ? result.diagnostics_json : "",
                     result.result_json != nullptr ? result.result_json : "");
    }
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet modal payload with gated operator terms must remain unavailable");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\""),
          "nonzero-k Floquet modal diagnostics expose gated operator terms rejection reason");
    check(contains(result.diagnostics_json, "\"gated_operator_term\":\"dynamic_demag\""),
          "nonzero-k Floquet modal diagnostics name the gated operator term");
    check(contains(result.result_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\""),
          "nonzero-k Floquet modal result exposes gated operator terms rejection reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_with_demag_is_unavailable()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "floquet_airbox";
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"demag_payload_kind\":\"dynamic_demag_k_operator\"}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet modal demag payload must remain unavailable until dynamic demag-k exists");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_dynamic_demag_k_operator_missing\""),
          "nonzero-k Floquet modal demag diagnostics reject a labelled dynamic demag-k payload");
    check(contains(result.diagnostics_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_dynamic_demag_k\""),
          "nonzero-k Floquet modal demag diagnostics name the dynamic demag-k operator contract");
    check(contains(result.diagnostics_json,
                   "\"required_demag_payload_kind\":\"dynamic_demag_k_operator\""),
          "nonzero-k Floquet modal demag diagnostics name the required demag payload kind");
    check(contains(result.diagnostics_json,
                   "\"dynamic_demag_operator_source\":\"missing_numeric_fem_demag_k\""),
          "nonzero-k Floquet modal demag diagnostics report missing dense block-real matrix data");
    check(!contains(result.diagnostics_json,
                    "\"dynamic_demag_operator_source\":\"provided_numeric_fem_demag_k_pending_full_fe_constraint_grad_k\""),
          "nonzero-k Floquet modal demag diagnostics must not report an unimplemented payload as provided");
    check(!contains(result.diagnostics_json,
                    "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "nonzero-k Floquet modal demag must not be rejected as a generic missing Bloch payload");
    check(contains(result.result_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_dynamic_demag_k\""),
          "nonzero-k Floquet modal demag result names the dynamic demag-k operator contract");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_with_dynamic_demag_k_is_admitted()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};
    constexpr double dynamic_demag_k_row_major[] = {0.25, 0.0, 0.0, 0.25};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.3;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "floquet_airbox";
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"operator_terms_included\":[\"exchange\",\"dynamic_demag\"]}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.dynamic_demag_k_tangent_matrix_row_major = dynamic_demag_k_row_major;
    request.dynamic_demag_k_tangent_matrix_value_count = 4;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "a complete nonzero-k dynamic demag matrix must reach the production SLEPc path");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "a complete nonzero-k dynamic demag matrix must produce one accepted mode");
    check(contains(result.resolved_engine_id, "floquet_airbox_cpu_schur_slepc"),
          "a complete nonzero-k dynamic demag matrix must attest the distinct Floquet CPU engine");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "a complete nonzero-k dynamic demag matrix still requires SLEPc");
#endif
    check(!contains(result.diagnostics_json,
                    "\"production_cpu_rejection_reason\":\"production_cpu_modal_dynamic_demag_k_operator_missing\""),
          "a supplied dynamic demag matrix must not be reported as missing");
    check(contains(result.diagnostics_json,
                   "\"dynamic_demag_k_operator\":{\"payload_kind\":\"dense_real_split_tangent_matrix\""),
          "dynamic demag diagnostics must identify the real-split payload");
    check(contains(result.diagnostics_json, "\"value_count\":4"),
          "dynamic demag diagnostics must preserve the payload extent");
    fullmag_fem_frequency_domain_result_destroy(&result);

    // The same admitted Floquet operator must publish selected-only metadata
    // when the native target is nearest-frequency.  This remains a prepared
    // contract regression until the managed SLEPc build is available.
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 0.2;
    FullmagFemFrequencyDomainResult nearest_result =
        fullmag_fem_modal_eigen_solve(&request);
    check(contains(nearest_result.diagnostics_json,
                   "\"target_kind\":\"nearest_frequency\""),
          "nearest Floquet diagnostics must publish the native target kind");
    check(contains(nearest_result.diagnostics_json,
                   "\"target_frequency_hz\":0.2"),
          "nearest Floquet diagnostics must publish the requested target frequency");
    check(contains(nearest_result.diagnostics_json,
                   "\"spectrum_completeness\":\"selected_only\""),
          "nearest Floquet diagnostics must publish selected-only completeness");
    check(contains(nearest_result.diagnostics_json,
                   "\"window_complete\":false"),
          "nearest Floquet diagnostics must never publish a complete window");
    const std::string expected_solve_complete =
        nearest_result.status == FULLMAG_FEM_FD_OK ?
            "\"solve_complete\":true" :
            "\"solve_complete\":false";
    check(contains(nearest_result.diagnostics_json, expected_solve_complete.c_str()),
          "nearest Floquet diagnostics must distinguish solver completion from spectrum coverage");
    check(contains(nearest_result.result_json,
                   "\"target_kind\":\"nearest_frequency\""),
          "nearest Floquet result must publish the native target kind");
    check(contains(nearest_result.result_json,
                   "\"target_frequency_hz\":0.2"),
          "nearest Floquet result must publish the requested target frequency");
    check(contains(nearest_result.result_json,
                   "\"spectrum_completeness\":\"selected_only\""),
          "nearest Floquet result must publish selected-only completeness");
    check(contains(nearest_result.result_json,
                   "\"window_complete\":false"),
          "nearest Floquet result must never publish a complete window");
    check(contains(nearest_result.result_json, expected_solve_complete.c_str()),
          "nearest Floquet result must distinguish solver completion from spectrum coverage");
    fullmag_fem_frequency_domain_result_destroy(&nearest_result);
}

void modal_nonzero_k_floquet_shared_domain_nearest_reports_shifted_ksp_diagnostics(
    bool count_certificate_only = false)
{
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_FEM_WITH_SLEPC
    FloquetContourSharedDomainFixture fixture{};
    fixture.initialize(count_certificate_only ? 5u : 0u, count_certificate_only);
    if (count_certificate_only) {
        initialize_native_count_fixture(fixture);
        verify_native_count_fixture_composed_operator(fixture);
    }

    // The shared-domain production path consumes the full magnetic A_qq
    // block from the immutable payload and does not materialize K/G through
    // the legacy dense request fields. The default compact fixture retains
    // its historical bounded diagonal carrier; the count case leaves the
    // legacy CSR empty and consumes the native FIELD/DEMAG owner.
    CsrOwned magnetic_stiffness{};
    if (!count_certificate_only) {
        magnetic_stiffness.rows = 10u;
        magnetic_stiffness.columns = 10u;
        magnetic_stiffness.row_offsets.push_back(0u);
        for (std::uint32_t row = 0u; row < 10u; ++row) {
            magnetic_stiffness.column_indices.push_back(row);
            magnetic_stiffness.values.push_back(1.0);
            magnetic_stiffness.row_offsets.push_back(
                static_cast<std::uint32_t>(magnetic_stiffness.values.size()));
        }
        fixture.payload.magnetic_a_qq_csr = magnetic_stiffness.view();
    }

    FullmagFemModalEigenRequest request =
        make_floquet_contour_request(fixture, nullptr, nullptr);
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = count_certificate_only
        ? fixture.reference_frequency_hz
        : 0.16;
    request.frequency_min_hz = 0.0;
    request.frequency_max_hz = 0.0;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 0;
    request.mfem_tangent_dof_count = 0u;
    request.mfem_stiffness_matrix_row_major = nullptr;
    request.mfem_gyrotropic_matrix_row_major = nullptr;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"certified_shared_domain\"}";

    if (!count_certificate_only) {
        FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
        check(result.status == FULLMAG_FEM_FD_OK,
              "shared-domain Floquet nearest-frequency fixture should reach production SLEPc");
        check(contains(result.resolved_engine_id, "floquet_airbox_cpu_schur_slepc"),
              "shared-domain nearest-frequency fixture resolves the Floquet CPU engine");
        check(contains(result.diagnostics_json,
                       "\"solver_adapter\":\"floquet_airbox_cpu_schur_slepc\""),
              "shared-domain nearest-frequency diagnostics publish the resolved Floquet adapter");
        check(contains(result.diagnostics_json,
                       "\"mfem_operator_payload\":\"floquet_shared_domain_sparse_matshell\""),
              "nearest regression exercises the shared-domain production MatShell payload");
        check(contains(result.result_json,
                       "\"floquet_descriptor_certified\":true"),
              "shared-domain nearest path certifies with an explicit positive tolerance");
        check(contains(result.diagnostics_json,
                       "\"target_kind\":\"nearest_frequency\""),
              "shared-domain nearest diagnostics preserve the requested target kind");
        check(contains(result.diagnostics_json,
                       "\"spectrum_completeness\":\"selected_only\""),
              "shared-domain nearest diagnostics remain selected-only");
        check(contains(result.diagnostics_json, "\"window_complete\":false"),
              "shared-domain nearest diagnostics do not claim a complete window");
        check(contains(result.diagnostics_json, "\"ksp_diagnostics_available\":"),
              "shared-domain nearest diagnostics publish cached shifted-KSP availability");
        check(contains(result.diagnostics_json,
                       "\"shifted_ksp_configuration_before_eps\":"),
              "shared-domain nearest diagnostics publish the pre-EPS KSP configuration field");
        check(contains(result.diagnostics_json,
                       "\"ksp_true_residual_criterion\":{\"schema_version\":"),
              "shared-domain nearest diagnostics publish true-residual criterion aggregates");
        check(contains(result.diagnostics_json,
                       "\"ksp_monitor_progress\":{\"schema_version\":\"floquet_shifted_ksp_monitor_progress.v1\""),
              "shared-domain nearest diagnostics publish a separately versioned monitor snapshot");
        check(contains(result.diagnostics_json,
                       "\"source\":\"petsc_ksp_monitor\""),
              "shared-domain nearest diagnostics identify the monitor source");
        check(contains(result.diagnostics_json,
                       "\"recursive_residual_semantics\":\"petsc_monitor_recursive_norm_not_true_residual\""),
              "shared-domain nearest diagnostics do not label the monitor norm as a true residual");
        check(contains(result.diagnostics_json,
                       "\"last_observed_reason_is_final\":false"),
              "shared-domain nearest diagnostics never promote a monitor reason to the final reason");
        check(contains(result.diagnostics_json,
                       "\"ksp_last_true_residual_available\":"),
              "shared-domain nearest diagnostics publish true-residual sample availability");
        check(contains(result.diagnostics_json, "\"ksp_last_true_residual_norm\":"),
              "shared-domain nearest diagnostics publish the cached true-residual norm");
        check(contains(result.diagnostics_json, "\"ksp_last_rhs_norm\":"),
              "shared-domain nearest diagnostics publish the cached true-residual RHS norm");
        check(contains(result.diagnostics_json, "\"ksp_last_true_relative_residual\":"),
              "shared-domain nearest diagnostics publish the cached true-relative residual");
        check(contains(result.diagnostics_json, "\"ksp_true_residual_sample_count\":"),
              "shared-domain nearest diagnostics publish the cached residual sample count");
        check(contains(result.diagnostics_json,
                       "\"ksp_true_residual_measurement_failure_count\":"),
              "shared-domain nearest diagnostics publish residual measurement failures");
        check(contains(result.diagnostics_json, "\"ksp_pc_side\":"),
              "shared-domain nearest diagnostics publish the available PC side or null");
        check(contains(result.diagnostics_json, "\"ksp_norm_type\":"),
              "shared-domain nearest diagnostics publish the available norm type or null");
        check(contains(result.diagnostics_json, "\"ksp_converged_reason\":"),
              "shared-domain nearest diagnostics publish the available KSP reason or null");
        check(contains(result.diagnostics_json, "\"eps_converged_reason\":"),
              "shared-domain nearest diagnostics publish the available EPS reason or null");
        check(contains(result.diagnostics_json, "\"eps_dimensions_available\":"),
              "shared-domain nearest diagnostics publish EPS dimensions availability");
        check(contains(result.diagnostics_json, "\"eps_nev\":"),
              "shared-domain nearest diagnostics publish the resolved EPS dimensions or null");
        check(contains(result.diagnostics_json, "\"eps_ncv\":"),
              "shared-domain nearest diagnostics publish the resolved EPS subspace or null");
        check(contains(result.diagnostics_json, "\"eps_mpd\":"),
              "shared-domain nearest diagnostics publish the resolved EPS maximum projected dimension or null");
        check(!contains(result.diagnostics_json,
                        "\"shifted_ksp_failure_probe\":"),
              "successful nearest diagnostics omit the failure-only shifted-KSP probe");
        const char *basic_ksp_keys[] = {
            "\"ksp_type\":", "\"ksp_rtol\":", "\"ksp_atol\":",
            "\"ksp_final_residual\":"};
        for (const char *key : basic_ksp_keys) {
            check(count_occurrences(result.diagnostics_json, key) == 1u,
                  "nearest Floquet diagnostics must serialize each basic KSP field exactly once");
        }
        check(!contains(result.result_json, "\"ksp_diagnostics_available\":"),
              "nearest result JSON keeps shifted-KSP telemetry in diagnostics only");
        check(contains(result.result_json, "\"solve_complete\":true"),
              "nearest result preserves solve completion independently of window coverage");
        check(contains(result.result_json, "\"spectrum_completeness\":\"selected_only\""),
              "nearest result remains selected-only");
        check(contains(result.result_json, "\"window_complete\":false"),
              "nearest result does not claim a complete window");
        fullmag_fem_frequency_domain_result_destroy(&result);
    }

    if (!count_certificate_only) {
        FullmagFemModalEigenRequest underfilled_nearest_request = request;
        underfilled_nearest_request.requested_mode_count = 100;
        FullmagFemFrequencyDomainResult underfilled_nearest_result =
            fullmag_fem_modal_eigen_solve(&underfilled_nearest_request);
        check(underfilled_nearest_result.status == FULLMAG_FEM_FD_SOLVE_ERROR,
              "native nearest solve cannot report success when its requested count is underfilled");
        check(contains(underfilled_nearest_result.result_json,
                       "\"accepted_mode_count\":") &&
                  !contains(underfilled_nearest_result.result_json,
                            "\"accepted_mode_count\":0") &&
                  !contains(underfilled_nearest_result.result_json,
                            "\"accepted_mode_count\":100") &&
                  contains(underfilled_nearest_result.result_json,
                           "\"modes\":[{") &&
                  contains(underfilled_nearest_result.result_json,
                           "\"floquet_descriptor_certified\":true"),
              "public nearest result retains certified modes below the requested count");
        check(contains(underfilled_nearest_result.result_json,
                       "\"solve_complete\":false") &&
                  contains(underfilled_nearest_result.result_json,
                           "\"window_complete\":false") &&
                  contains(underfilled_nearest_result.result_json,
                           "\"stop_reason\":\"floquet_nev_refill_dimension_limit_reached\""),
              "public nearest JSON reports the refill limit without claiming solve or window completion");
        fullmag_fem_frequency_domain_result_destroy(&underfilled_nearest_result);
        std::printf("PASS: public_native_floquet_nearest_underfill_retains_certified_modes\n");
    }

    // Reuse the exact imported native operator through the public production
    // entry. The normal suite spans overlapping subwindows; the focused count
    // path uses one narrow subwindow to isolate certificate admission.
    FullmagFemModalEigenRequest window_request = request;
    window_request.target_kind = "frequency_window";
    if (count_certificate_only) {
        constexpr double upper_factor = (100.0 + 2.0) / 100.0;
        window_request.frequency_min_hz = 0.90 * fixture.reference_frequency_hz;
        window_request.frequency_max_hz = 1.03 * fixture.reference_frequency_hz;
        const double midpoint_hz = 0.5 * (
            window_request.frequency_min_hz + window_request.frequency_max_hz);
        check(window_request.frequency_min_hz < fixture.reference_frequency_hz &&
                  midpoint_hz < fixture.reference_frequency_hz &&
                  window_request.frequency_max_hz >
                      upper_factor * fixture.reference_frequency_hz,
              "physical count window brackets the oracle band with its sole midpoint below it");
    } else {
        window_request.frequency_min_hz = 0.05;
        window_request.frequency_max_hz = 0.30;
    }
    window_request.requested_mode_count = 1;
    window_request.completeness_policy = 0;
    FullmagFemFrequencyDomainResult window_result =
        fullmag_fem_modal_eigen_solve(&window_request);
    if (window_result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(
            stderr,
            "FAIL-DIAGNOSTICS: native_floquet_window status=%d error=%.1024s diagnostics=%s result=%s\n",
            static_cast<int>(window_result.status),
            window_result.error_message != nullptr ? window_result.error_message : "null",
            window_result.diagnostics_json != nullptr ? window_result.diagnostics_json : "null",
            window_result.result_json != nullptr ? window_result.result_json : "null");
    }
    check(window_result.status == FULLMAG_FEM_FD_OK,
          "native Floquet production frequency window accepts a certified mode");
    if (count_certificate_only) {
        const double selected_frequency_hz = extract_json_number(
            window_result.result_json,
            "\"frequency_hz\":",
            "native_count_fixture_selected_frequency");
        const double selected_omega_rad_s = extract_json_number(
            window_result.result_json,
            "\"omega_rad_s\":",
            "native_count_fixture_selected_omega");
        const double selected_branch_sign = extract_json_number(
            window_result.result_json,
            "\"branch_sign\":",
            "native_count_fixture_selected_branch");
        constexpr double gamma0_m_per_a_s = 3.0;
        constexpr double saturation_a_per_m = 2.0;
        constexpr double bias_a_per_m = 100.0;
        const double upper_frequency_hz =
            gamma0_m_per_a_s * (bias_a_per_m + saturation_a_per_m) /
            (2.0 * 3.14159265358979323846);
        const double lower_frequency_hz = fixture.reference_frequency_hz;
        check(selected_frequency_hz > 0.0 && selected_omega_rad_s > 0.0 &&
                  selected_branch_sign == 1.0 &&
                  selected_frequency_hz >= lower_frequency_hz * (1.0 - 1.0e-8) &&
                  selected_frequency_hz <= upper_frequency_hz * (1.0 + 1.0e-8) &&
                  std::abs(selected_omega_rad_s -
                           2.0 * 3.14159265358979323846 * selected_frequency_hz) <=
                      1.0e-10 * selected_omega_rad_s,
              "native count mode has the positive branch and lies inside the independent energy bracket");
    }
    check(contains(window_result.diagnostics_json,
                   "\"deduplication_inner_product\":\"floquet_positive_tangent_mass\""),
          "native window merge reports its physical reduced tangent mass");
    check(contains(window_result.diagnostics_json,
                   "\"deduplication_mass_matrix\":\"provided_complex_csr\""),
          "native window merge keeps the owned complex CSR metric");
    check(!contains(window_result.diagnostics_json, "identity_fallback"),
          "native window cannot revert to Euclidean identity deduplication");
    check(contains(window_result.result_json, "\"accepted_mode_count\":1,") ||
              contains(window_result.result_json, "\"accepted_mode_count\":1}"),
          "native window applies the exact user publication cap after merging");
    check(contains(window_result.result_json,
                   "\"floquet_descriptor_certified\":true"),
          "native window keeps original descriptor certification after merging");
    const double accepted_modes_before_cap = extract_json_number(
        window_result.diagnostics_json,
        "\"accepted_modes_before_cap\":",
        "native_floquet_window_modes_before_cap");
    const bool publication_cap_truncated_modes =
        accepted_modes_before_cap >
        static_cast<double>(window_request.requested_mode_count);
    const char *expected_window_completeness = "not_certified";
    if (count_certificate_only || publication_cap_truncated_modes) {
        expected_window_completeness = "truncated_by_requested_count";
    } else if (contains(window_result.diagnostics_json,
                        "\"stop_reason\":\"partial_convergence\"")) {
        expected_window_completeness = "partial_convergence";
    }
    const std::string expected_result_window_completeness =
        "\"window_completeness\":\"" +
        std::string(expected_window_completeness) + "\"";
    const std::string expected_diagnostic_window_completeness =
        "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"" +
        std::string(expected_window_completeness) +
        "\",\"certification_method\":\"none\"";
    check(contains(window_result.result_json,
                   expected_result_window_completeness.c_str()) &&
              contains(window_result.diagnostics_json,
                       "\"complete\":false,\"execution_lane\":\"production_cpu\"") &&
              contains(window_result.diagnostics_json,
                       expected_diagnostic_window_completeness.c_str()) &&
              contains(window_result.diagnostics_json,
                       "\"additional_modes_may_exist\":true"),
          "native merge preserves the exact incomplete best_effort window status");
    check(!contains(window_result.diagnostics_json,
                    "\"shifted_ksp_failure_probe\":"),
          "successful window subsolves omit the failure-only shifted-KSP probe");

    if (count_certificate_only) {
        const std::size_t best_effort_subwindow_count =
            count_occurrences(window_result.diagnostics_json, "\"requested_hz\":[");
        check(best_effort_subwindow_count == 1u &&
                  count_occurrences(
                      window_result.diagnostics_json,
                      "\"status\":\"ok\",\"requested_hz\":[") ==
                      best_effort_subwindow_count &&
                  !contains(window_result.diagnostics_json,
                            "\"status\":\"partial\"") &&
                  !contains(window_result.diagnostics_json,
                            "floquet_nev_refill_dimension_limit_reached"),
              "best_effort control has one completed native subwindow with no partial or refill-limit result");

        check(accepted_modes_before_cap >= 4.0,
              "expanded fixture supplies at least four independent in-window modes before the public cap");

        FullmagFemModalEigenRequest uncertified_count_request = window_request;
        uncertified_count_request.completeness_policy = 1;
        FullmagFemFrequencyDomainResult uncertified_count_result =
            fullmag_fem_modal_eigen_solve(&uncertified_count_request);
        const double retained_uncertified_mode_count =
            extract_json_number(
                uncertified_count_result.result_json,
                "\"accepted_mode_count\":",
                "public_native_floquet_certified_count_without_certificate");
        check(uncertified_count_result.status == FULLMAG_FEM_FD_SOLVE_ERROR &&
                  contains(uncertified_count_result.result_json,
                           "\"status\":\"solve_error\"") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"policy\":\"certified_count\"") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"certification_method\":\"none\"") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"certification_unavailable_reason\":\"native_floquet_count_certificate_unavailable\""),
              "certified_count fails closed when native Floquet has no count-certificate producer");
        check(retained_uncertified_mode_count == 1.0 &&
                  contains(uncertified_count_result.result_json, "\"modes\":[{") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"additional_modes_may_exist\":true") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"complete\":false,\"execution_lane\":\"production_cpu\"") &&
                  contains(uncertified_count_result.result_json,
                           "\"window_completeness\":\"truncated_by_requested_count\"") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"window_completeness\":{\"policy\":\"certified_count\",\"status\":\"truncated_by_requested_count\",\"certification_method\":\"none\""),
              "strict failure retains validated diagnostic modes without claiming window completeness");

        const double strict_modes_before_cap =
            extract_json_number(
                uncertified_count_result.diagnostics_json,
                "\"accepted_modes_before_cap\":",
                "public_native_floquet_strict_count_fixture_unique_modes");
        check(strict_modes_before_cap >= 4.0,
              "strict adapter retains the same four independent modes before enforcing the certificate gate");

        const std::size_t strict_subwindow_count =
            count_occurrences(
                uncertified_count_result.diagnostics_json, "\"requested_hz\":[");
        check(strict_subwindow_count == 1u &&
                  count_occurrences(
                      uncertified_count_result.diagnostics_json,
                      "\"status\":\"ok\",\"requested_hz\":[") ==
                      strict_subwindow_count &&
                  count_occurrences(
                      uncertified_count_result.diagnostics_json,
                      "\"stop_reason\":\"converged\"") == strict_subwindow_count &&
                  !contains(uncertified_count_result.diagnostics_json,
                            "\"status\":\"partial\"") &&
                  !contains(uncertified_count_result.diagnostics_json,
                            "\"stop_reason\":\"partial_convergence\"") &&
                  !contains(uncertified_count_result.diagnostics_json,
                            "floquet_nev_refill_dimension_limit_reached") &&
                  contains(uncertified_count_result.diagnostics_json,
                           "\"stop_reason\":\"count_certificate_unavailable\"") &&
                  !contains(uncertified_count_result.diagnostics_json,
                            "\"window_completeness\":{\"policy\":\"certified_count\",\"status\":\"solver_error\""),
              "certified_count fails only after its one native subwindow completed without refill or solver error");
        check(contains(uncertified_count_result.error_message, "count certificate"),
              "strict native failure reports the unavailable count certificate directly");
        fullmag_fem_frequency_domain_result_destroy(&uncertified_count_result);
    }
    fullmag_fem_frequency_domain_result_destroy(&window_result);
    std::printf("PASS: native_floquet_production_window_positive_mass_merge\n");
    if (count_certificate_only) {
        std::printf("PASS: public_native_floquet_certified_count_requires_count_certificate\n");
        return;
    }

    // The public count is a maximum publication cap. The per-subwindow NEV
    // guard is internal overfetch and can exceed the real-split dimension, so
    // best_effort must retain a certified in-window pool when that guard alone
    // reaches its legal dimension limit.
    FullmagFemModalEigenRequest dimension_limited_one_request = request;
    dimension_limited_one_request.target_kind = "frequency_window";
    dimension_limited_one_request.frequency_min_hz = 0.15;
    dimension_limited_one_request.frequency_max_hz = 0.17;
    dimension_limited_one_request.requested_mode_count = 1;
    dimension_limited_one_request.completeness_policy = 0;
    FullmagFemFrequencyDomainResult dimension_limited_one_result =
        fullmag_fem_modal_eigen_solve(&dimension_limited_one_request);
    check(dimension_limited_one_result.status == FULLMAG_FEM_FD_OK,
          "best_effort window returns a certified mode when only the internal NEV guard hits the dimension limit");
    const double dimension_limited_one_count =
        extract_json_number(
            dimension_limited_one_result.result_json,
            "\"accepted_mode_count\":",
            "public_native_floquet_window_dimension_limited_one_mode");
    check(dimension_limited_one_count == 1.0 &&
              dimension_limited_one_count <=
                  dimension_limited_one_request.requested_mode_count,
          "best_effort window keeps the public mode count as an upper cap");
    check(contains(dimension_limited_one_result.result_json,
                   "\"status\":\"ok\"") &&
              contains(dimension_limited_one_result.result_json, "\"modes\":[{"),
          "best_effort dimension-limited window publishes its certified mode");
    const double dimension_limited_one_modes_before_cap = extract_json_number(
        dimension_limited_one_result.diagnostics_json,
        "\"accepted_modes_before_cap\":",
        "public_native_floquet_window_dimension_limited_modes_before_cap");
    const bool dimension_limited_one_truncated =
        dimension_limited_one_modes_before_cap >
        static_cast<double>(dimension_limited_one_request.requested_mode_count);
    const char *expected_dimension_limited_one_window_status =
        dimension_limited_one_truncated
            ? "truncated_by_requested_count"
            : "partial_convergence";
    const std::string expected_dimension_limited_one_result_status =
        "\"window_completeness\":\"" +
        std::string(expected_dimension_limited_one_window_status) + "\"";
    const std::string expected_dimension_limited_one_diagnostic_status =
        "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"" +
        std::string(expected_dimension_limited_one_window_status) +
        "\",\"certification_method\":\"none\"";
    check(contains(dimension_limited_one_result.diagnostics_json,
                   "\"complete\":false,\"execution_lane\":\"production_cpu\"") &&
              contains(dimension_limited_one_result.diagnostics_json,
                       expected_dimension_limited_one_diagnostic_status.c_str()) &&
              contains(dimension_limited_one_result.result_json,
                       expected_dimension_limited_one_result_status.c_str()) &&
              contains(dimension_limited_one_result.diagnostics_json,
                       "\"unsupported_reason\":\"floquet_nev_refill_dimension_limit_reached\""),
          "dimension-limited best_effort preserves its exact incomplete-window status and internal-limit evidence");
    if (dimension_limited_one_truncated) {
        check(contains(dimension_limited_one_result.diagnostics_json,
                       "\"result_truncated\":true") &&
                  contains(dimension_limited_one_result.diagnostics_json,
                           "\"truncation_reason\":\"requested_mode_cap\""),
              "actual public-cap truncation keeps its existing completeness classification");
    }
    fullmag_fem_frequency_domain_result_destroy(&dimension_limited_one_result);
    std::printf("PASS: public_native_floquet_window_dimension_limited_best_effort\n");

    // A larger public cap is still only an upper bound: the solver does not
    // claim that the requested count exists in the band or certify coverage.
    FullmagFemModalEigenRequest underfilled_request = request;
    underfilled_request.target_kind = "frequency_window";
    underfilled_request.frequency_min_hz = 0.15;
    underfilled_request.frequency_max_hz = 0.17;
    underfilled_request.requested_mode_count = 100;
    underfilled_request.completeness_policy = 0;
    FullmagFemFrequencyDomainResult underfilled_result =
        fullmag_fem_modal_eigen_solve(&underfilled_request);
    check(underfilled_result.status == FULLMAG_FEM_FD_OK,
          "best_effort window may return fewer certified modes than its public output cap");
    const double underfilled_mode_count =
        extract_json_number(
            underfilled_result.result_json,
            "\"accepted_mode_count\":",
            "public_native_floquet_window_cap_is_not_a_minimum");
    check(underfilled_mode_count > 0.0 &&
              underfilled_mode_count < underfilled_request.requested_mode_count &&
              contains(underfilled_result.result_json, "\"modes\":[{"),
          "best_effort result retains a nonempty certified pool below the public cap");
    check(contains(underfilled_result.diagnostics_json,
                   "\"requested_mode_count\":100") &&
              contains(underfilled_result.diagnostics_json,
                       "\"status\":\"ok\"") &&
              contains(underfilled_result.diagnostics_json,
                       "\"complete\":false") &&
              contains(underfilled_result.diagnostics_json,
                       "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"partial_convergence\"") &&
              contains(underfilled_result.diagnostics_json,
                       "\"additional_modes_may_exist\":true") &&
              contains(underfilled_result.diagnostics_json,
                       "\"unsupported_reason\":\"floquet_nev_refill_dimension_limit_reached\""),
          "public diagnostics preserve the incomplete window and dimension-limited refill reason");
    check(contains(underfilled_result.result_json,
                   "\"status\":\"ok\"") &&
              contains(underfilled_result.result_json,
                       "\"window_completeness\":\"partial_convergence\""),
          "public result distinguishes usable partial modes from complete window coverage");
    fullmag_fem_frequency_domain_result_destroy(&underfilled_result);
    std::printf("PASS: public_native_floquet_window_count_is_upper_cap\n");

    FullmagFemModalEigenRequest strict_count_request = underfilled_request;
    strict_count_request.completeness_policy = 1;
    FullmagFemFrequencyDomainResult strict_count_result =
        fullmag_fem_modal_eigen_solve(&strict_count_request);
    check(strict_count_result.status == FULLMAG_FEM_FD_SOLVE_ERROR,
          "certified_count policy remains fail-closed when dimension-limited refill leaves the window incomplete");
    check(contains(strict_count_result.result_json, "\"modes\":[{") &&
              contains(strict_count_result.result_json,
                       "\"window_completeness\":\"partial_convergence\"") &&
              contains(strict_count_result.diagnostics_json,
                       "\"complete\":false,\"execution_lane\":\"production_cpu\"") &&
              contains(strict_count_result.diagnostics_json,
                       "\"window_completeness\":{\"policy\":\"certified_count\",\"status\":\"partial_convergence\",\"certification_method\":\"none\"") &&
              contains(strict_count_result.diagnostics_json,
                       "\"certification_unavailable_reason\":\"native_floquet_count_certificate_unavailable\"") &&
              contains(strict_count_result.diagnostics_json,
                       "\"unsupported_reason\":\"floquet_nev_refill_dimension_limit_reached\""),
          "strict policy preserves certified partial modes and explicit refill evidence without claiming completion");
    fullmag_fem_frequency_domain_result_destroy(&strict_count_result);
    std::printf("PASS: public_native_floquet_window_certified_count_remains_strict\n");

    request.residual_tolerance = 0.0;
    FullmagFemFrequencyDomainResult default_tolerance_result =
        fullmag_fem_modal_eigen_solve(&request);
    check(default_tolerance_result.status == FULLMAG_FEM_FD_OK &&
              contains(default_tolerance_result.result_json,
                       "\"floquet_descriptor_certified\":true"),
          "shared-domain nearest path resolves zero request tolerance before certifying");
    fullmag_fem_frequency_domain_result_destroy(&default_tolerance_result);

    FullmagFemModalEigenRequest hard_ksp_nearest_request = request;
    hard_ksp_nearest_request.max_linear_iterations = 1;
    FullmagFemFrequencyDomainResult hard_ksp_nearest_result =
        fullmag_fem_modal_eigen_solve(&hard_ksp_nearest_request);
    check(hard_ksp_nearest_result.status == FULLMAG_FEM_FD_SOLVE_ERROR &&
              contains(hard_ksp_nearest_result.diagnostics_json,
                       "\"unsupported_reason\":\"floquet_slepc_solve_failed\"") &&
              contains(hard_ksp_nearest_result.diagnostics_json,
                       "\"shifted_ksp_failure_probe\":{\"schema_version\":\"shifted_ksp_failure_probe.v1\""),
          "nearest hard KSP failure serializes its failure-only scalar probe");
    check(extract_json_number(
              hard_ksp_nearest_result.diagnostics_json,
              "\"eps_attempt_number\":",
              "nearest_shifted_ksp_failure_probe") >= 1.0 &&
              extract_json_number(
                  hard_ksp_nearest_result.diagnostics_json,
                  "\"eps_nev_argument\":",
                  "nearest_shifted_ksp_failure_probe") >= 1.0 &&
              extract_json_number(
                  hard_ksp_nearest_result.diagnostics_json,
                  "\"eps_ncv_argument\":",
                  "nearest_shifted_ksp_failure_probe") >= 1.0,
          "nearest failure JSON retains the actual attempt and EPS dimension arguments");
    check(contains(hard_ksp_nearest_result.diagnostics_json,
                   "\"scope\":\"internal_shifted_linear_system_not_original_descriptor\"") &&
              contains(hard_ksp_nearest_result.diagnostics_json,
                       "\"true_probe_measurement_failure_count\":") &&
              contains(hard_ksp_nearest_result.diagnostics_json,
                       "\"callback_ordinal\":"),
          "nearest failure JSON scopes the callback norms and exposes probe availability counts");
    if (contains(hard_ksp_nearest_result.diagnostics_json,
                 "\"last_true_probe\":{\"available\":false")) {
        check(contains(hard_ksp_nearest_result.diagnostics_json,
                       "\"rhs_l2_norm\":null") &&
                  contains(hard_ksp_nearest_result.diagnostics_json,
                           "\"true_residual_l2_norm\":null") &&
                  contains(hard_ksp_nearest_result.diagnostics_json,
                           "\"threshold_l2_norm\":null"),
              "unavailable callback measurement values serialize as null rather than zero");
    }
    fullmag_fem_frequency_domain_result_destroy(&hard_ksp_nearest_result);

    FullmagFemModalEigenRequest hard_ksp_window_request = window_request;
    hard_ksp_window_request.max_linear_iterations = 1;
    FullmagFemFrequencyDomainResult hard_ksp_window_result =
        fullmag_fem_modal_eigen_solve(&hard_ksp_window_request);
    check(hard_ksp_window_result.status == FULLMAG_FEM_FD_SOLVE_ERROR &&
              contains(hard_ksp_window_result.diagnostics_json,
                       "floquet_slepc_solve_failed") &&
              contains(hard_ksp_window_result.diagnostics_json,
                       "\"shifted_ksp_failure_probe\":{\"schema_version\":\"shifted_ksp_failure_probe.v1\""),
          "window hard KSP failure preserves the failing subwindow probe in aggregate diagnostics");
    check(contains(hard_ksp_window_result.diagnostics_json,
                   "\"complete\":false,\"execution_lane\":\"production_cpu\"") &&
              contains(hard_ksp_window_result.diagnostics_json,
                       "\"window_completeness\":{\"policy\":\"best_effort\",\"status\":\"solver_error\"") &&
              contains(hard_ksp_window_result.result_json,
                       "\"status\":\"solve_error\"") &&
              contains(hard_ksp_window_result.result_json,
                       "\"window_completeness\":\"solver_error\""),
          "window failure probe does not promote the failed solve to completion");
    fullmag_fem_frequency_domain_result_destroy(&hard_ksp_window_result);
#else
    if (count_certificate_only) {
        std::fprintf(stderr,
                     "FAIL: --floquet-count-certificate requires MFEM and SLEPc");
        std::exit(2);
    }
#endif
}

void modal_nonzero_k_floquet_dynamic_demag_k_rejects_malformed_payload()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};
    constexpr double dynamic_demag_k_row_major[] = {0.25, 0.0, 0.0, 0.25};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "floquet_airbox";
    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.dynamic_demag_k_tangent_matrix_row_major = dynamic_demag_k_row_major;
    request.dynamic_demag_k_tangent_matrix_value_count = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "a dynamic demag matrix with a wrong extent must fail before solving");
    check(contains(result.diagnostics_json, "invalid_dynamic_demag_k_tangent_matrix"),
          "a malformed dynamic demag matrix must expose a stable validation reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_poisson_airbox_tail_payload_resolves_augmented_gauge_schur_solver()
{
    constexpr double omega0 = 6.283185307179586476925286766559 * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);

    FullmagFemModalEigenRequest request = base_request();
    const double gamma_k[3] = {0.0, 0.0, 0.0};
    request.operator_request.k_vector_rad_m = gamma_k;
    request.operator_request.k_vector_len = 3;
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "periodic_airbox_k0";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.frequency_min_hz = 1.0e9;
    request.frequency_max_hz = 3.0e9;
    request.residual_tolerance = 1.0e-10;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = A_qq.view();
    request.poisson_airbox_a_qphi_csr = A_qphi.view();
    request.poisson_airbox_a_phiq_csr = A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    request.poisson_airbox_b_qq_csr = B_qq.view();
    request.poisson_airbox_phi_mean_weights = weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz = 2.0119012110259213e9;
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    if (result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(
            stderr,
            "modal Poisson-airbox tail status=%d error=%s diagnostics=%s result=%s\n",
            static_cast<int>(result.status),
            result.error_message != nullptr ? result.error_message : "",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "",
            result.result_json != nullptr ? result.result_json : "");
    }
    check(result.status == FULLMAG_FEM_FD_OK,
          "modal Poisson-airbox tail payload must solve through the certified Schur SLEPc lane");
    check(contains(result.diagnostics_json,
                   "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_slepc\""),
          "modal Poisson-airbox tail diagnostics name the resolved Schur adapter");
    check(contains(result.diagnostics_json, "\"k_vector_len\":3") &&
              contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "K0 special adapter diagnostics preserve the explicitly requested Gamma vector");
    check(contains(result.result_json, "\"k_vector_len\":3") &&
              contains(result.result_json, "\"k_vector_rad_m\":[0,0,0]"),
          "K0 special adapter result preserves the explicitly requested Gamma vector");
    check(contains(result.diagnostics_json, "\"demag_kind\":\"periodic_airbox_k0\""),
          "modal Poisson-airbox tail diagnostics preserve periodic_airbox_k0");
    check(contains(result.diagnostics_json, "\"gauge_policy\":\"mean_zero_augmented\""),
          "modal Poisson-airbox tail diagnostics preserve mean-zero gauge");
    check(contains(result.result_json,
                   "\"requested_solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_slepc\""),
          "modal Poisson-airbox tail result preserves the requested full-coupled adapter");
    check(contains(result.result_json,
                   "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_slepc\""),
          "modal Poisson-airbox tail result names the resolved Schur adapter");
    check(contains(result.result_json, "\"demag_kind\":\"periodic_airbox_k0\""),
          "modal Poisson-airbox tail result preserves periodic_airbox_k0");
    check(contains(result.result_json, "\"phi_dof_count\":2"),
          "modal Poisson-airbox tail result reports phi DOF count");
    check(contains(result.result_json, "\"augmented_phi_dof_count\":3"),
          "modal Poisson-airbox tail result reports augmented phi DOF count");
    check(contains(result.result_json, "\"poisson_constraint_relative_residual\""),
          "modal Poisson-airbox tail result reports Poisson residual");
    check(contains(result.result_json, "\"periodic_mesh_certificate\""),
          "modal Poisson-airbox tail result reports periodic mesh certificate metadata");
    check(contains(result.result_json, "\"magnetic_pair_count\":1"),
          "modal Poisson-airbox tail result reports magnetic pair count");
    check(contains(result.result_json, "\"airbox_pair_count\":1"),
          "modal Poisson-airbox tail result reports airbox pair count");
    check(result.mode_count == 1, "modal Poisson-airbox ABI exposes one accepted mode");
    check(result.mode_lambda_count == result.mode_count,
          "modal Poisson-airbox ABI exposes one lambda per mode");
    check(result.mode_q_complex_count == result.mode_count * result.q_dof_count,
          "modal Poisson-airbox ABI exposes mode-major q vectors");
    check(result.mode_phi_complex_count == result.mode_count * result.phi_dof_count,
          "modal Poisson-airbox ABI exposes mode-major phi vectors");
    check(result.mode_residual_count == result.mode_count,
          "modal Poisson-airbox ABI exposes one residual per mode");
    check(result.mode_lambda != nullptr && result.mode_q_complex != nullptr &&
              result.mode_phi_complex != nullptr && result.mode_residuals != nullptr,
          "modal Poisson-airbox ABI owns all accepted-mode buffers");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal Poisson-airbox tail payload must require SLEPc when unavailable");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_poisson_airbox_tail_shift_invert_action_writes_artifact()
{
    constexpr double omega0 = 6.283185307179586476925286766559 * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};

    const std::filesystem::path output_dir =
        std::filesystem::temp_directory_path() /
        "fullmag-pa-g3d-modal-cabi-shift-invert-action";
    std::filesystem::remove_all(output_dir);
    std::filesystem::create_directories(output_dir);
    const std::string output_dir_string = output_dir.string();

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "periodic_airbox_k0";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.residual_tolerance = 1.0e-10;
    request.output_directory = output_dir_string.c_str();
    request.write_partial_artifacts = 1;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = A_qq.view();
    request.poisson_airbox_a_qphi_csr = A_qphi.view();
    request.poisson_airbox_a_phiq_csr = A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    request.poisson_airbox_b_qq_csr = B_qq.view();
    request.poisson_airbox_phi_mean_weights = weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz = 2.0119012110259213e9;
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";
    request.poisson_airbox_shift_invert_action_enabled = 1;
    request.poisson_airbox_shift_sigma_real = 0.0;
    request.poisson_airbox_shift_sigma_imag = 6.283185307179586476925286766559 * 1.25e9;
    request.poisson_airbox_shift_action_vector_real = v_re;
    request.poisson_airbox_shift_action_vector_imag = v_im;
    request.poisson_airbox_shift_action_vector_count = 2;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK,
          "the Poisson-airbox CPU reference shift-invert action must solve without SLEPc");
    check(contains(result.artifact_manifest_path,
                   "poisson_airbox_modal_shift_invert_action.v1.json"),
          "modal C ABI result must point at the shift-invert action artifact");
    check(contains(result.result_json, "\"operator_family\":\"full_modal_shift_invert\""),
          "modal C ABI result must identify full modal shift-invert");
    const std::filesystem::path artifact_path =
        output_dir / "eigen" / "diagnostics" /
        "poisson_airbox_modal_shift_invert_action.v1.json";
    const std::string artifact = read_text(artifact_path);
    check(artifact.find("\"schema_version\":\"poisson_airbox_modal_shift_invert_action.v1\"") !=
              std::string::npos,
          "modal C ABI action artifact must expose schema version");
    check(artifact.find("\"full_modal_shift_invert_claim\":true") !=
              std::string::npos,
          "modal C ABI action artifact must claim true modal shift-invert");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_poisson_airbox_tail_gpu_shift_invert_action_writes_artifact()
{
    constexpr double omega0 = 6.283185307179586476925286766559 * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};

    const std::filesystem::path output_dir =
        std::filesystem::temp_directory_path() /
        "fullmag-pa-g3g-modal-cabi-gpu-shift-invert-action";
    std::filesystem::remove_all(output_dir);
    std::filesystem::create_directories(output_dir);
    const std::string output_dir_string = output_dir.string();

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "periodic_airbox_k0";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.residual_tolerance = 1.0e-10;
    request.output_directory = output_dir_string.c_str();
    request.write_partial_artifacts = 1;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = A_qq.view();
    request.poisson_airbox_a_qphi_csr = A_qphi.view();
    request.poisson_airbox_a_phiq_csr = A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    request.poisson_airbox_b_qq_csr = B_qq.view();
    request.poisson_airbox_phi_mean_weights = weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz = 2.0119012110259213e9;
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";
    request.poisson_airbox_shift_invert_action_enabled = 1;
    request.poisson_airbox_shift_invert_action_device = 1;
    request.poisson_airbox_shift_sigma_real = 0.0;
    request.poisson_airbox_shift_sigma_imag = 6.283185307179586476925286766559 * 1.25e9;
    request.poisson_airbox_shift_action_vector_real = v_re;
    request.poisson_airbox_shift_action_vector_imag = v_im;
    request.poisson_airbox_shift_action_vector_count = 2;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_HAS_CUDA_RUNTIME
    check(result.status == FULLMAG_FEM_FD_OK,
          "modal C ABI Poisson-airbox GPU shift-invert action must solve when CUDA is enabled");
    check(contains(result.artifact_manifest_path,
                   "gpu_modal_shift_invert_action.v1.json"),
          "modal C ABI result must point at the GPU shift-invert action artifact");
    check(contains(result.result_json,
                   "\"solver_adapter\":\"gpu_device_dense_modal_shift_invert_action_contract\""),
          "modal C ABI GPU action result must identify the GPU hidden action adapter");
    check(contains(result.result_json,
                   "\"execution_lane\":\"gpu_operator_host_modal_eigen_compatibility\""),
          "modal C ABI GPU action result must identify the hidden GPU-G4 compatibility lane");
    check(contains(result.result_json, "\"frequency_response_proxy\":false"),
          "modal C ABI GPU action result must reject frequency-response proxy semantics");
    const std::filesystem::path artifact_path =
        output_dir / "eigen" / "diagnostics" /
        "gpu_modal_shift_invert_action.v1.json";
    const std::string artifact = read_text(artifact_path);
    check(artifact.find("\"schema_version\":\"gpu_modal_shift_invert_action.v1\"") !=
              std::string::npos,
          "modal C ABI GPU action artifact must expose schema version");
    check(artifact.find("\"rhs_family\":\"modal_mass_times_vector\"") !=
              std::string::npos,
          "modal C ABI GPU action artifact must identify Bv RHS semantics");
    check(artifact.find("\"execution_lane\":\"gpu_operator_host_modal_eigen_compatibility\"") !=
              std::string::npos,
          "modal C ABI GPU action artifact must identify the hidden GPU-G4 compatibility lane");
    check(artifact.find("\"frequency_response_proxy\":false") !=
              std::string::npos,
          "modal C ABI GPU action artifact must reject frequency-response proxy semantics");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal C ABI Poisson-airbox GPU shift-invert action must require CUDA when unavailable");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

} // namespace

int main(int argc, char **argv)
{
    if (argc > 1) {
        if (argc == 2 &&
            std::strcmp(argv[1], "--modal-slepc-phase-convention") == 0) {
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_FEM_WITH_SLEPC
            generic_slepc_phase_convention_cabi();
            std::printf("PASS: modal_slepc_phase_convention_contract\n");
            return 0;
#else
            std::fprintf(
                stderr,
                "FAIL: --modal-slepc-phase-convention requires MFEM and SLEPc\n");
            return 3;
#endif
        }
        if (argc == 2 && std::strcmp(argv[1], "--generic-mass-refill") == 0) {
            modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator();
            generic_dense_window_refills_after_search_filtering();
            std::printf("PASS: generic_modal_mass_refill_contract\n");
            return 0;
        }
        if (argc == 2 && std::strcmp(argv[1], "--floquet-count-certificate") == 0) {
            modal_nonzero_k_floquet_shared_domain_nearest_reports_shifted_ksp_diagnostics(true);
            return 0;
        }
        std::fprintf(stderr, "FAIL: unknown modal eigen contract test argument\n");
        return 2;
    }
    modal_shared_domain_provider_terminal_status_fails_closed();
    modal_shared_domain_provider_failure_status_is_consistent();
    nonfinite_json_sanitizer_has_bounded_fail_closed_semantics();
    FullmagFemFrequencyDomainResult zeroed{};
    fullmag_fem_frequency_domain_result_destroy(&zeroed);
    check(zeroed.status == static_cast<FullmagFemFrequencyDomainStatus>(0),
          "destroy on zeroed result must be idempotent");

    modal_dependency_info_is_reported();
    modal_invalid_abi_returns_validation_error();
    modal_v13_extension_rejects_unknown_enum_and_releases_zero_result();
    modal_v16_extension_rejects_unknown_spectral_transform_and_short_prefix();
    modal_abi_layout_publishes_versioned_modal_structs();
    modal_certificate_boundary_rejects_stale_and_mismatched_identity();
    modal_v17_certificate_preimage_validation_is_fail_closed();
    modal_v6_c_abi_relation_views_accept_golden_and_reject_digest_tamper();
    modal_v18_is_fail_closed_and_v19_descriptor_validation_is_preserved();
    modal_result_provenance_is_resolved_or_explicitly_unavailable();
    modal_result_destroy_is_safe_for_partial_allocation_and_repeated_calls();
    modal_v18_result_is_frozen_and_strict_gpu_requires_v20_attestation();
    modal_v20_short_envelope_is_rejected_before_any_write();
    modal_v20_strict_gpu_attestation_is_present_complete_and_known();
    modal_v20_tiny_validation_rejects_forced_production_gpu();
    modal_v20_destroy_is_safe_for_partial_allocation_and_repeated_calls();
    modal_shift_invert_finds_macrospin_mode();
    modal_shift_invert_residual_below_tolerance();
    modal_shift_invert_validation_reports_slepc_adapter_configuration();
    modal_shift_invert_reports_ksp_iterations();
    modal_shift_invert_cancel_returns_interrupted();
    frequency_window_reports_unresolved_subwindow();
    frequency_window_wide_auto_selects_contour_interval_solver();
    modal_frequency_window_production_payload_contour_accepts_multiple_modes();
    modal_floquet_shared_domain_original_descriptor_certification_is_fail_closed();
    modal_shift_invert_payload_can_be_assembled_from_mfem_operator();
    modal_dynamic_demag_materialization_preserves_legacy_s_sign();
    modal_shift_invert_dense_full_2x2_payload_accepts_k0_kittel_macrospin();
    modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator();
    generic_dense_window_refills_after_search_filtering();
    modal_without_validation_problem_stays_unavailable();
    modal_sparse_validation_error_preserves_explicit_k_vector();
    modal_diagnostics_preserve_explicit_k_vector();
    modal_floquet_wavevector_validation_precedes_tiny_dispatch();
    modal_nonzero_k_floquet_payload_rejects_until_production_operator_exists();
    modal_nonzero_k_floquet_never_enters_k0_poisson_path();
    modal_nonzero_k_floquet_legacy_poisson_block_never_enters_k0_solver();
    modal_k0_shared_domain_without_mfem_is_unavailable();
    modal_nonzero_k_floquet_tail_payload_preserves_periodic_pair_contract();
    modal_nonzero_k_floquet_bloch_payload_reaches_production_solver();
    modal_nonzero_k_floquet_bloch_payload_rejects_gated_operator_terms();
    modal_nonzero_k_floquet_bloch_payload_with_demag_is_unavailable();
    modal_nonzero_k_floquet_bloch_payload_with_dynamic_demag_k_is_admitted();
    modal_nonzero_k_floquet_shared_domain_nearest_reports_shifted_ksp_diagnostics();
    modal_nonzero_k_floquet_dynamic_demag_k_rejects_malformed_payload();
    modal_poisson_airbox_tail_payload_resolves_augmented_gauge_schur_solver();
    modal_poisson_airbox_tail_shift_invert_action_writes_artifact();
    modal_poisson_airbox_tail_gpu_shift_invert_action_writes_artifact();
    return 0;
}
