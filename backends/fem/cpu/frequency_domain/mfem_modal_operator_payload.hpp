#pragma once

#include "cpu/frequency_domain/mfem_linearized_operator.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemModalDenseOperatorPayloadProblem {
    MfemOperatorContextDescriptor descriptor{};
    MfemTangentSpaceLayout layout{};
    const TangentFrameNode *nodes = nullptr;
    const TangentOperatorEdgeBlock *exchange_edges = nullptr;
    std::uint64_t exchange_edge_count = 0;
    const double *h_ext_a_per_m = nullptr;
    const double *uniaxial_anisotropy_axis = nullptr;
    double uniaxial_anisotropy_field_a_per_m = 0.0;
    const double *alpha_per_node = nullptr;
    const double *tangent_lumped_mass = nullptr;
    double gamma0 = 0.0;
    double alpha = 0.0;
    double *out_dynamic_matrix_row_major = nullptr;
    double *out_dynamic_mass_matrix_row_major = nullptr;
    double *out_tangent_mass_matrix_row_major = nullptr;
    std::uint64_t matrix_capacity = 0;
    const MfemDmiElementTangentData *dmi_elements = nullptr;
    std::uint64_t dmi_element_count = 0;
    const double *dmi_lumped_mass = nullptr;
    const double *dmi_ms_field = nullptr;
    double dmi_uniform_ms = 0.0;
    const double *demag_tangent_matrix_row_major = nullptr;
    std::uint64_t demag_tangent_matrix_value_count = 0;
    const char *demag_provider_signature = nullptr;
    const std::uint64_t *static_periodic_node_pairs = nullptr;
    std::uint64_t static_periodic_node_pair_count = 0;
    bool periodic_airbox = false;
};

struct MfemModalDenseOperatorPayloadResult {
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t matrix_entry_count = 0;
    std::uint64_t assembled_column_count = 0;
    double max_abs_dynamic_matrix = 0.0;
    double max_abs_dynamic_mass_matrix = 0.0;
    double max_abs_tangent_mass_matrix = 0.0;
    char payload_kind[64] = "";
    char algebraic_form[64] = "";
    double linearized_pencil_gamma0_m_per_a_s = 0.0;
    char operator_digest[65] = "";
    char dependency_digest[65] = "";
    char error_message[128] = "";
};

struct MfemModalCsrOutputBuffer {
    std::uint32_t *row_offsets = nullptr;
    std::uint64_t row_offsets_capacity = 0;
    std::uint32_t *column_indices = nullptr;
    std::uint64_t column_indices_capacity = 0;
    double *values = nullptr;
    std::uint64_t values_capacity = 0;
};

struct MfemModalSparseOperatorPayloadProblem {
    MfemModalDenseOperatorPayloadProblem dense_problem{};
    MfemModalCsrOutputBuffer out_dynamic_matrix_csr{};
    MfemModalCsrOutputBuffer out_dynamic_mass_matrix_csr{};
    MfemModalCsrOutputBuffer out_tangent_mass_matrix_csr{};
    double drop_tolerance = 0.0;
};

struct MfemModalSparseOperatorPayloadResult {
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t matrix_entry_count = 0;
    std::uint64_t dynamic_matrix_nnz = 0;
    std::uint64_t dynamic_mass_matrix_nnz = 0;
    std::uint64_t tangent_mass_matrix_nnz = 0;
    std::uint64_t assembled_column_count = 0;
    double max_abs_dynamic_matrix = 0.0;
    double max_abs_dynamic_mass_matrix = 0.0;
    double max_abs_tangent_mass_matrix = 0.0;
    char payload_kind[64] = "";
    char algebraic_form[64] = "";
    double linearized_pencil_gamma0_m_per_a_s = 0.0;
    char operator_digest[65] = "";
    char dependency_digest[65] = "";
    char error_message[128] = "";
};

FrequencyDomainStatus assemble_mfem_modal_dense_operator_payload(
    const MfemModalDenseOperatorPayloadProblem &problem,
    MfemModalDenseOperatorPayloadResult *out_result) noexcept;

FrequencyDomainStatus assemble_mfem_modal_sparse_operator_payload(
    const MfemModalSparseOperatorPayloadProblem &problem,
    MfemModalSparseOperatorPayloadResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
