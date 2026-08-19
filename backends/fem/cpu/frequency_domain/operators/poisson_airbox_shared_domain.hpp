#pragma once

#include "frequency_domain/modal_eigen_request.hpp"
#include "frequency_domain/mesh_symmetry_certificate.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>
#include <string>
#include <vector>

#ifndef FULLMAG_HAS_MFEM_STACK
#define FULLMAG_HAS_MFEM_STACK 0
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {
struct FemMeshRuntimeState;
}

namespace fullmag::fem::frequency_domain {

#if FULLMAG_HAS_MFEM_STACK

enum class PoissonAirboxBoundaryKind : std::uint32_t {
    robin,
    dirichlet,
    pure_neumann,
};

struct PoissonAirboxSharedDomainCsrMatrix {
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    CsrMatrixView view() const noexcept
    {
        return CsrMatrixView{
            row_count,
            column_count,
            row_offsets.data(),
            static_cast<std::uint64_t>(row_offsets.size()),
            column_indices.data(),
            static_cast<std::uint64_t>(column_indices.size()),
            values.data(),
            static_cast<std::uint64_t>(values.size())};
    }
};

/*
 * Backend-owned shared-domain P1 assembly contract.
 *
 * The scalar FE space and all tangent fields are built from one MFEM mesh.
 * The magnetic A_qq input is the accepted static-restoring linearization
 * already assembled by the canonical magnetic operator path; this module
 * owns the scalar Poisson block, reciprocal couplings, gyrotropic B_qq,
 * class reduction, BC/gauge policy, and the immutable operator digest.
 *
 * A node-pair list is deliberately not accepted.  Both scalar_reduced_node
 * and magnetic_reduced_node must describe complete equivalence classes.
 */
struct PoissonAirboxSharedDomainAssemblyRequest {
    mfem::FiniteElementSpace *scalar_space = nullptr;
    const TangentFrameNode *tangent_frames = nullptr;
    std::uint64_t tangent_frame_count = 0;

    const std::uint8_t *magnetic_element_mask = nullptr;
    std::uint64_t magnetic_element_count = 0;
    const double *saturation_magnetization_a_per_m = nullptr;
    std::uint64_t saturation_magnetization_count = 0;
    double uniform_saturation_magnetization_a_per_m = 0.0;
    double gamma0_m_per_a_s = 0.0;
    double mu0_T_m_A = 0.0;

    const CsrMatrixView *magnetic_a_qq_csr = nullptr;

    const std::uint32_t *scalar_reduced_node = nullptr;
    std::uint64_t scalar_reduced_node_count = 0;
    const std::uint32_t *magnetic_reduced_node = nullptr;
    std::uint64_t magnetic_reduced_node_count = 0;
    bool equivalence_classes_complete = false;

    PoissonAirboxBoundaryKind boundary_kind = PoissonAirboxBoundaryKind::pure_neumann;
    double robin_beta = 0.0;
    mfem::Array<int> *robin_boundary_marker = nullptr;
};

struct PoissonAirboxSharedDomainAssemblyResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t full_q_dof_count = 0;
    std::uint64_t full_phi_dof_count = 0;

    PoissonAirboxSharedDomainCsrMatrix a_qq{};
    PoissonAirboxSharedDomainCsrMatrix a_qphi{};
    PoissonAirboxSharedDomainCsrMatrix a_phiq{};
    PoissonAirboxSharedDomainCsrMatrix p{};
    PoissonAirboxSharedDomainCsrMatrix b_qq{};
    std::vector<double> phi_mean_weights{};
    std::vector<std::uint32_t> dirichlet_dofs{};
    char boundary_kind[32]{};
    char gauge_policy[32]{};
    char assembly_kind[64]{};
    char operator_digest[65]{};
};

/* Shared descriptor contract used by the public ABI boundary and the native
 * shared-domain importer before any MFEM operator is assembled. */
FrequencyDomainStatus validate_linearization_descriptor_contract(
    const FullmagFemModalLinearizationDescriptor &descriptor,
    std::uint64_t expected_node_count,
    char error_message[256]) noexcept;

/* Complete native shared-domain handoff validation.  This is the single
 * backend-owned gate used by both the public C ABI and the direct C++
 * importer.  It validates the descriptor and its payload state binding,
 * the append-only v6 relation views/preimage, and the magnetic/airbox cell
 * marker map before any MFEM object or operator is constructed. */
struct ModalSharedDomainValidationResult {
    char canonical_preimage_sha256[96]{};
    char canonical_map_binding_sha256[96]{};
    char magnetic_class_digest_sha256[96]{};
    char scalar_class_digest_sha256[96]{};
    std::uint32_t certificate_binding_status = 0;
};

/*
 * Compute the native canonical reduction-map binding carried by the existing
 * append-only v18 `mesh_certificate_map_binding_digest` field.
 *
 * The scalar mesh order is authoritative global-node order.  Because ABI v18
 * has no compact-to-global index array, magnetic compact nodes have exactly
 * the prefix order [0, magnetic_node_count); every remaining entry in the
 * full magnetic reduction map is UINT32_MAX.  The digest binds that explicit
 * order contract, ordered element markers, exact part/status identities, the
 * accepted v6 canonical class IDs, and both supplied reduction maps.
 */
FrequencyDomainStatus compute_modal_shared_domain_map_binding_digest(
    const FullmagFemModalSharedDomainPayload &payload,
    const MeshSymmetryCertificateV6Binding &accepted_v6_binding,
    std::uint64_t magnetic_node_count,
    std::string &out_digest,
    char error_message[256]) noexcept;

FrequencyDomainStatus validate_modal_shared_domain_payload_contract(
    const FullmagFemModalSharedDomainPayload &payload,
    std::uint64_t expected_node_count,
    ModalSharedDomainValidationResult *out_validation,
    char error_message[256]) noexcept;

/* Internal modal adapter over the canonical Context mesh admission contract.
 * It preserves the typed mesh order and derived periodic classes without
 * maintaining a second, weaker mesh validator in the frequency-domain path. */
bool import_modal_shared_domain_mesh(
    const fullmag_fem_mesh_desc &mesh,
    fullmag::fem::FemMeshRuntimeState &out_mesh,
    std::string &error);

/*
 * Assemble the magnetic energy-Hessian block from the accepted backend-neutral
 * linearization descriptor.  This is intentionally a backend-owned producer:
 * the runner may describe the accepted state and physical terms, but it must
 * not materialize A_qq and pass a synthetic CSR into the shared-domain path.
 *
 * The current producer covers the certified exchange + static h_eff0 scope.
 * Its static-field Hessian is diagonal in the accepted tangent frame and is
 * available only when h_eff0 is parallel to m0 within the declared tolerance.
 * Dynamic demagnetization is deliberately not an A_qq term: the native
 * shared-domain A_qphi P^{-1} A_phiq coupling owns that response.  A DEMAG
 * descriptor therefore supplies only a provider signature bound to its
 * operator-input identity, never an independent local weak form here.
 *
 * The optional append-only material view supplies one scalar A_ex without
 * carrying graph endpoints.  The payload importer must separately prove that
 * the descriptor and B_qq consume one accepted tangent-frame/state source.
 * This helper has no payload-side state digest to compare and must not infer
 * equality.
 * Unsupported local terms fail closed until their native weak forms are added.
 */
FrequencyDomainStatus assemble_native_magnetic_a_qq(
    const FullmagFemModalLinearizationDescriptor &descriptor,
    mfem::FiniteElementSpace *scalar_space,
    const std::uint8_t *magnetic_element_mask,
    std::uint64_t magnetic_element_count,
    PoissonAirboxSharedDomainCsrMatrix *out_a_qq,
    char error_message[256],
    const FullmagFemModalExchangeMaterialView *exchange_material_view = nullptr,
    const TangentFrameNode *accepted_tangent_frames = nullptr,
    std::uint64_t accepted_tangent_frame_count = 0,
    double accepted_max_transverse_field_a_per_m = -1.0) noexcept;

/* Import and assemble the versioned public shared-domain modal payload.  The
 * returned CSR buffers own their storage and remain valid until the result is
 * destroyed by the caller. */
FrequencyDomainStatus assemble_poisson_airbox_shared_domain_payload(
    const FullmagFemModalSharedDomainPayload &payload,
    PoissonAirboxSharedDomainAssemblyResult *out_result) noexcept;

FrequencyDomainStatus assemble_poisson_airbox_shared_domain(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    PoissonAirboxSharedDomainAssemblyResult *out_result) noexcept;

#endif

} // namespace fullmag::fem::frequency_domain
