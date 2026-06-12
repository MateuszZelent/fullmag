#pragma once

#include "frequency_domain/operator_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct TangentFrameNode;

struct MfemOperatorContextRequest {
    std::uint64_t node_count = 0;
    std::uint64_t element_count = 0;
    std::uint64_t element_node_count = 0;
    std::uint64_t material_region_count = 0;
    const double *nodes_xyz = nullptr;
    const std::uint32_t *elements = nullptr;
    const std::uint32_t *element_material_ids = nullptr;
    const TangentFrameNode *tangent_nodes = nullptr;
    FrequencyDomainOperatorRequest operator_request{};
    bool has_mfem_mesh = false;
    bool periodic_reduced_mesh = false;
};

struct MfemOperatorContextDescriptor {
    std::uint64_t node_count = 0;
    std::uint64_t element_count = 0;
    std::uint64_t element_node_count = 0;
    std::uint64_t full_dof_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t material_region_count = 0;
    FrequencyDomainBoundaryKind boundary_kind = FrequencyDomainBoundaryKind::open_boundary;
    FrequencyDomainDemagKind demag_kind = FrequencyDomainDemagKind::none;
    bool exchange_enabled = false;
    bool zeeman_enabled = false;
    bool demag_enabled = false;
    bool mfem_mesh_available = false;
    bool periodic_reduced_mesh = false;
};

struct MfemOperatorContextDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t element_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t material_region_count = 0;
    bool mfem_mesh_available = false;
    char error_message[128] = "";
};

FrequencyDomainStatus build_mfem_operator_context_descriptor(
    const MfemOperatorContextRequest &request,
    MfemOperatorContextDescriptor *out_descriptor,
    MfemOperatorContextDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
