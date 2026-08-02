#pragma once

#include "frequency_domain/modal_eigen_request.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>
#include <vector>

#ifndef FULLMAG_HAS_MFEM_STACK
#define FULLMAG_HAS_MFEM_STACK 0
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

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
