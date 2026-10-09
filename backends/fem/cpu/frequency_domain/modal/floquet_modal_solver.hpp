#pragma once

#include "cpu/frequency_domain/slepc_modal_eigen.hpp"
#include "frequency_domain/modal_eigen_request.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct PoissonAirboxSharedDomainComplexCsrMatrix;
struct PoissonAirboxSharedDomainAssemblyResult;

namespace detail {

// Refill is only safe after the whole attempt was torn down and EPS no longer
// owns its per-attempt graph. Keep this decision pure so its fail-closed cases
// can be tested without fabricating an invalid PETSc/MPI object graph.
constexpr bool floquet_eps_cleanup_allows_refill(
    bool teardown_succeeded,
    bool eps_handle_live) noexcept
{
    return teardown_succeeded && !eps_handle_live;
}

constexpr bool floquet_cancellation_is_observed(
    bool sticky_result_observed,
    bool stopping_callback_observed,
    bool callback_requested_now) noexcept
{
    return sticky_result_observed || stopping_callback_observed ||
        callback_requested_now;
}

// Internal seam shared by the native solver and its deterministic candidate
// finalization regression. Inputs are already certified against the original
// Floquet descriptor; this stage only mass-deduplicates, target-ranks, and
// applies the publication count.
struct CertifiedFloquetModalCandidate {
    SLEPcModalAcceptedMode mode{};
    double target_distance = 0.0;
};

struct FloquetModalCandidateFinalization {
    bool success = false;
    const char *failure_reason = "floquet_mass_candidate_finalization_failed";
    std::vector<CertifiedFloquetModalCandidate> accepted_candidates;
};

FloquetModalCandidateFinalization finalize_certified_floquet_candidates(
    std::vector<CertifiedFloquetModalCandidate> candidates,
    std::uint64_t q_complex_dof_count,
    const PoissonAirboxSharedDomainComplexCsrMatrix *positive_tangent_mass,
    std::size_t requested_mode_count);

} // namespace detail

/*
 * Native shared-domain Floquet owner.  The five pencil blocks and positive
 * tangent-overlap metric are phase-reduced complex CSR matrices assembled
 * from one MFEM mesh/material/equilibrium payload. The metric is not a pencil
 * block. The modal solver realifies only the sparse PETSc views and keeps
 * A_qphi P^{-1} A_phiq as a MatShell action, so the dense512 diagnostic bound
 * is not part of this production contract.
 */
struct FloquetSharedDomainSparseModalOperator {
    const PoissonAirboxSharedDomainComplexCsrMatrix *a_qq = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *b_qq = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *p = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *a_qphi = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *a_phiq = nullptr;
    // Non-pencil physical overlap metric borrowed from full_descriptor_assembly.
    const PoissonAirboxSharedDomainComplexCsrMatrix *positive_tangent_mass = nullptr;
    std::uint64_t q_complex_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    const std::vector<double> *uniform_transverse_probe_q_y = nullptr;
    const std::vector<double> *uniform_transverse_probe_q_z = nullptr;
    const PoissonAirboxSharedDomainAssemblyResult *full_descriptor_assembly = nullptr;
    std::array<double, 3> k_rad_per_m{};
    double mu0_T_m_A = 0.0;
    const char *boundary_kind = nullptr;
    const char *gauge_policy = nullptr;
};

/*
 * Optional owner for one native frequency-window execution.  The object is
 * intentionally opaque here: PETSc matrices, KSP state and work vectors are
 * created and destroyed by the Floquet implementation.  It is never a
 * process-global cache and must not outlive the operator payload it borrows.
 */
struct FloquetSharedDomainSparseModalSolveContext {
    FloquetSharedDomainSparseModalSolveContext() noexcept;
    ~FloquetSharedDomainSparseModalSolveContext() noexcept;
    // Close the retained PETSc graph before publishing the outer window result.
    // False leaves the owner and process-finalization fence intact.
    bool close() noexcept;
    FloquetSharedDomainSparseModalSolveContext(
        const FloquetSharedDomainSparseModalSolveContext &) = delete;
    FloquetSharedDomainSparseModalSolveContext &operator=(
        const FloquetSharedDomainSparseModalSolveContext &) = delete;
    FloquetSharedDomainSparseModalSolveContext(
        FloquetSharedDomainSparseModalSolveContext &&) = delete;
    FloquetSharedDomainSparseModalSolveContext &operator=(
        FloquetSharedDomainSparseModalSolveContext &&) = delete;

    void *opaque = nullptr;
};

// The Floquet modal owner is the boundary between the phase-reduced Bloch
// operator and the ordinary SLEPc spectral adapter.  The spectral request is
// already realified by the caller; this owner only admits the finite-k,
// periodic, CPU contract and then executes the selected spectrum.  Keeping
// the admission here prevents a nonzero-k request from accidentally entering
// the k=0 Poisson branch or a GPU fallback.
struct FloquetModalSolverAdmission {
    bool accepted = false;
    bool nonzero_k = false;
    bool dynamic_demag_k = false;
    bool frequency_window = false;
    const char *reason = "invalid_request";
};

FloquetModalSolverAdmission admit_floquet_modal_request(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept;

FloquetModalSolverAdmission admit_floquet_modal_sparse_request(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept;

// Execute one selected spectrum/window through the existing SLEPc adapter
// after Floquet admission.  A rejected request is returned as a validation
// result and never reaches the generic or k=0 solver.
SLEPcTinyGyrotropicModalEigenResult solve_floquet_modal_spectrum(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept;

SLEPcTinyGyrotropicModalEigenResult solve_floquet_modal_sparse_spectrum(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept;

/* Execute the native shared-domain phase-reduced operator.  This entry point
 * is kept separate from the legacy real CSR adapter so callers cannot
 * accidentally erase the complex phase or reintroduce a dense dynamic block.
 */
SLEPcTinyGyrotropicModalEigenResult
solve_floquet_shared_domain_sparse_modal_spectrum(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept;

SLEPcTinyGyrotropicModalEigenResult
solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request,
    FloquetSharedDomainSparseModalSolveContext *reuse_context) noexcept;

const char *floquet_modal_solver_model() noexcept;

} // namespace fullmag::fem::frequency_domain
