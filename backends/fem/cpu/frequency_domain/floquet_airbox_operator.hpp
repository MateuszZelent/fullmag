#pragma once

#include "frequency_domain/floquet_dynamic_demag_k.hpp"
#include "cpu/frequency_domain/floquet_bloch_scalar.hpp"

#include <array>
#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

#if FULLMAG_HAS_MFEM_STACK

// Bounded bridge from the MFEM Bloch scalar blocks to the dynamic magnetic
// Schur provider.  The bridge owns only dense materialization for validation
// sized problems; production runs must replace it with a matrix-free owner.
struct FloquetAirboxDynamicDemagKProblem {
    const mfem::ComplexSparseMatrix *scalar_operator = nullptr;
    const mfem::ComplexSparseMatrix *scalar_constraint = nullptr;
    const mfem::ComplexSparseMatrix *tangent_source = nullptr;
    // Optional full-q -> reduced-q Floquet constraint.  When present the
    // bridge materializes A_phiq = C_phi^H A_phiq,full C_q; when absent the
    // tangent source is already in reduced q coordinates for compatibility
    // with the original bounded oracle.
    const mfem::ComplexSparseMatrix *tangent_constraint = nullptr;
    std::array<double, 3> k_rad_per_m{};
    FloquetDynamicDemagKGaugePolicy gauge_policy =
        FloquetDynamicDemagKGaugePolicy::require_invertible;
    double pivot_tolerance = 1.0e-14;
    std::uint64_t workspace_budget_bytes = 256ull * 1024ull * 1024ull;
};

struct FloquetAirboxDynamicDemagKResult {
    std::vector<double> real_split_row_major{};
    FloquetDynamicDemagKDiagnostics diagnostics{};
    FloquetPotentialReconstruction reconstruction{};
};

// The shared-domain Floquet bridge must receive the physical airbox boundary
// contract explicitly. `unknown` is intentionally the zero value so a caller
// that forgets to propagate the descriptor fails closed instead of silently
// assembling a natural (Neumann) boundary.
enum class FloquetAirboxBoundaryKind : std::uint32_t {
    unknown = 0,
    robin = 1,
    dirichlet = 2,
    pure_neumann = 3,
};

/*
 * Mesh-level block producer for the full-field Floquet representation.  The
 * producer owns only the small MFEM block objects; the Schur bridge below
 * remains responsible for bounded dense elimination.  A future shared-domain
 * modal owner can use this seam after importing its accepted mesh/state
 * payload, without moving assembly into the Rust runner.
 */
struct FloquetAirboxSharedDomainBlockRequest {
    mfem::FiniteElementSpace *scalar_space = nullptr;
    const TangentFrameNode *tangent_frames = nullptr;
    std::uint64_t tangent_frame_count = 0;
    const std::uint8_t *magnetic_element_mask = nullptr;
    std::uint64_t magnetic_element_count = 0;
    const double *saturation_magnetization_a_per_m = nullptr;
    std::uint64_t saturation_magnetization_count = 0;
    double uniform_saturation_magnetization_a_per_m = 0.0;
    const std::uint32_t *scalar_reduced_node = nullptr;
    std::uint64_t scalar_reduced_node_count = 0;
    const std::uint32_t *magnetic_reduced_node = nullptr;
    std::uint64_t magnetic_reduced_node_count = 0;
    const FrequencyDomainFloquetPeriodicPair *periodic_pairs = nullptr;
    std::uint64_t periodic_pair_count = 0;
    std::array<double, 3> k_rad_per_m{};
    FloquetAirboxBoundaryKind boundary_kind = FloquetAirboxBoundaryKind::unknown;
    double robin_beta = 0.0;
    mfem::Array<int> *robin_boundary_marker = nullptr;
};

struct FloquetAirboxSharedDomainBlockResult {
    std::unique_ptr<mfem::ComplexSparseMatrix> scalar_operator{};
    std::unique_ptr<mfem::ComplexSparseMatrix> scalar_constraint{};
    std::unique_ptr<mfem::ComplexSparseMatrix> tangent_source{};
    std::unique_ptr<mfem::ComplexSparseMatrix> tangent_constraint{};
    char error_message[256]{};
};

FrequencyDomainStatus assemble_floquet_airbox_shared_domain_blocks(
    const FloquetAirboxSharedDomainBlockRequest &request,
    FloquetAirboxSharedDomainBlockResult *out_result) noexcept;

// Materialize
//
//     P(k)       = C(k)^H P_full(k) C(k),
//     A_phiq(k)  = C(k)^H A_phiq,full(k),
//     A_qphi(k)  = A_phiq(k)^H,
//     D(k)       = -A_qphi(k) P(k)^-1 A_phiq(k),
//
// and return D in the real-split tangent layout expected by the modal ABI.
// This function is intentionally bounded and does not advertise production
// nonzero-k dynamic-demagnetization capability.
FrequencyDomainStatus assemble_floquet_airbox_dynamic_demag_k(
    const FloquetAirboxDynamicDemagKProblem &problem,
    FloquetAirboxDynamicDemagKResult *out_result) noexcept;

#endif

} // namespace fullmag::fem::frequency_domain
