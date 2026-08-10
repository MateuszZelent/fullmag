#include "cpu/frequency_domain/mfem_modal_operator_payload.hpp"
#include "frequency_domain/linearized_dynamic_pencil.hpp"
#include "frequency_domain/mesh_symmetry_certificate.hpp"
#include "fullmag_fem.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <type_traits>
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

bool contains(const char *haystack, const char *needle)
{
    return haystack != nullptr && std::strstr(haystack, needle) != nullptr;
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

double extract_json_number(const char *json, const char *key)
{
    check(json != nullptr, "JSON buffer must be present");
    const char *start = std::strstr(json, key);
    check(start != nullptr, "JSON key must be present");
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
    check(invalid_result.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
          "modal result returns ABI version");
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
                  sizeof(FullmagFemModalSharedDomainPayload) &&
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
    check(contains(result.diagnostics_json, "certificate_binding_digest_mismatch"),
          "modal C ABI reports a stable v6 binding digest mismatch");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_v18_linearization_descriptor_is_fail_closed()
{
    ModalCertificateV6CAbiGoldenFixture certificate_fixture{};
    certificate_fixture.initialize();
    ModalLinearizationDescriptorFixture descriptor_fixture{};
    fullmag_fem_mesh_desc sentinel_mesh{};
    std::uint32_t reduced_node[] = {0u};
    fullmag_fem_frequency_domain_exchange_edge exchange_edge{0u, 1u, 1.0};
    FullmagFemModalSharedDomainPayload payload = certificate_payload();
    payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    payload.struct_size = sizeof(payload);
    payload.mesh = &sentinel_mesh;
    payload.scalar_reduced_node = reduced_node;
    payload.scalar_reduced_node_count = 1;
    payload.magnetic_reduced_node = reduced_node;
    payload.magnetic_reduced_node_count = 1;
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
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v17 modal payload must fail before reading v18 tail fields");
    check(contains(result.diagnostics_json, "shared_payload_struct_size_too_small"),
          "v17 modal payload reports a stable short-prefix reason");
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
          "v18 modal payload without a descriptor must fail closed");
    check(contains(result.diagnostics_json, "linearization_descriptor_missing"),
          "v18 modal payload reports a missing descriptor reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    payload.linearization_descriptor = &descriptor_fixture.descriptor;
    descriptor_fixture.descriptor.coordinate_unit = "mm";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects a non-SI descriptor unit");
    check(contains(result.diagnostics_json, "linearization_descriptor_unit_invalid"),
          "v18 modal payload reports the unit validation reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.coordinate_unit = "m";

    descriptor_fixture.descriptor.linearization_state_digest = "not-a-digest";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects a malformed descriptor digest");
    check(contains(result.diagnostics_json, "linearization_descriptor_digest_invalid"),
          "v18 modal payload reports the descriptor digest reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.linearization_state_digest =
        payload.linearization_state_digest;

    descriptor_fixture.descriptor.linearization_state_digest =
        ModalLinearizationDescriptorFixture::kDigest;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects a descriptor state-digest mismatch");
    check(contains(result.diagnostics_json, "linearization_descriptor_state_digest_mismatch"),
          "v18 modal payload reports the state-digest mismatch reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.linearization_state_digest =
        payload.linearization_state_digest;

    descriptor_fixture.descriptor.equilibrium_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects a descriptor equilibrium-digest mismatch");
    check(contains(result.diagnostics_json, "linearization_descriptor_equilibrium_digest_mismatch"),
          "v18 modal payload reports the equilibrium-digest mismatch reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.equilibrium_digest = payload.equilibrium_digest;

    descriptor_fixture.descriptor.tangent_frame_xyz_count = 0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects a descriptor with an incompatible array count");
    check(contains(result.diagnostics_json, "linearization_descriptor_state_arrays_invalid"),
          "v18 modal payload reports the descriptor array-count reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    descriptor_fixture.descriptor.tangent_frame_xyz_count = 12;
    descriptor_fixture.descriptor.exchange_edge_count = 1;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects an inactive exchange view with a non-zero count");
    check(contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v18 modal payload reports the inactive exchange-view reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
    descriptor_fixture.descriptor.exchange_edge_count = 0;
    descriptor_fixture.descriptor.exchange_edges = &exchange_edge;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects an inactive exchange view with a non-null pointer");
    check(contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v18 modal payload reports the inactive exchange-pointer reason");
    fullmag_fem_frequency_domain_result_destroy(&result);

    descriptor_fixture.descriptor.term_presence_mask =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE;
    descriptor_fixture.descriptor.exchange_term_digest = payload.linearization_state_digest;
    descriptor_fixture.descriptor.exchange_edge_count = 1;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR &&
              contains(result.diagnostics_json, "linearization_descriptor_exchange_invalid"),
          "v18 modal payload rejects graph-only exchange without scalar material carrier");
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
          "v18 modal payload accepts scalar exchange material carrier without graph edges");
    check(!contains(result.diagnostics_json, "exchange_material_view_invalid"),
          "v18 modal payload accepts a valid append-only exchange material view");
    fullmag_fem_frequency_domain_result_destroy(&result);

    material_view.exchange_stiffness_j_per_m = -1.0;
    result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "v18 modal payload rejects non-positive scalar exchange material");
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
          "v18 modal payload accepts a complete inactive-term descriptor");
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

    payload = certificate_payload();
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

    fullmag_fem_mesh_desc sentinel_mesh{};
    std::uint32_t reduced_node[] = {0u};
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
    check(contains(result.diagnostics_json, "certificate_binding_digest_mismatch"),
          "v17 modal payload reports the v6 binding digest mismatch");
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
        extract_json_number(result.result_json, "\"frequency_hz\":");
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
        extract_json_number(result.result_json, "\"relative_residual\":");
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
        extract_json_number(result.diagnostics_json, "\"shift_frequency_hz\":");
    check(std::abs(diagnostics_shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "macrospin validation diagnostics must report the requested shift frequency");
    const double diagnostics_shift_omega_rad_s =
        extract_json_number(result.diagnostics_json, "\"shift_omega_rad_s\":");
    check(std::abs(diagnostics_shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "macrospin validation diagnostics must report the angular shift");
    const double result_shift_frequency_hz =
        extract_json_number(result.result_json, "\"shift_frequency_hz\":");
    check(std::abs(result_shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "macrospin validation result must report the requested shift frequency");
    const double result_shift_omega_rad_s =
        extract_json_number(result.result_json, "\"shift_omega_rad_s\":");
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
        extract_json_number(g_last_progress_json, "\"current_shift_hz\":");
    check(std::abs(current_shift_hz - request.target_frequency_hz) < 1.0e-15,
          "modal progress preserves the legacy current shift");
    const double shift_frequency_hz =
        extract_json_number(g_last_progress_json, "\"shift_frequency_hz\":");
    check(std::abs(shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "modal progress reports shift frequency provenance");
    const double shift_omega_rad_s =
        extract_json_number(g_last_progress_json, "\"shift_omega_rad_s\":");
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
        extract_json_number(result.result_json, "\"frequency_hz\":");
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
        extract_json_number(result.result_json, "\"frequency_hz\":");
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
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "modal C ABI Poisson-airbox shift-invert action must solve");
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
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal C ABI Poisson-airbox shift-invert action must require SLEPc when unavailable");
#endif
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

int main()
{
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
    modal_v18_linearization_descriptor_is_fail_closed();
    modal_result_provenance_is_resolved_or_explicitly_unavailable();
    modal_result_destroy_is_safe_for_partial_allocation_and_repeated_calls();
    modal_shift_invert_finds_macrospin_mode();
    modal_shift_invert_residual_below_tolerance();
    modal_shift_invert_validation_reports_slepc_adapter_configuration();
    modal_shift_invert_reports_ksp_iterations();
    modal_shift_invert_cancel_returns_interrupted();
    frequency_window_reports_unresolved_subwindow();
    frequency_window_wide_auto_selects_contour_interval_solver();
    modal_frequency_window_production_payload_contour_accepts_multiple_modes();
    modal_shift_invert_payload_can_be_assembled_from_mfem_operator();
    modal_dynamic_demag_materialization_preserves_legacy_s_sign();
    modal_shift_invert_dense_full_2x2_payload_accepts_k0_kittel_macrospin();
    modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator();
    modal_without_validation_problem_stays_unavailable();
    modal_sparse_validation_error_preserves_explicit_k_vector();
    modal_diagnostics_preserve_explicit_k_vector();
    modal_nonzero_k_floquet_payload_rejects_until_production_operator_exists();
    modal_nonzero_k_floquet_tail_payload_preserves_periodic_pair_contract();
    modal_nonzero_k_floquet_bloch_payload_reaches_production_solver();
    modal_nonzero_k_floquet_bloch_payload_rejects_gated_operator_terms();
    modal_nonzero_k_floquet_bloch_payload_with_demag_is_unavailable();
    modal_poisson_airbox_tail_payload_resolves_augmented_gauge_schur_solver();
    modal_poisson_airbox_tail_shift_invert_action_writes_artifact();
    modal_poisson_airbox_tail_gpu_shift_invert_action_writes_artifact();
    return 0;
}
