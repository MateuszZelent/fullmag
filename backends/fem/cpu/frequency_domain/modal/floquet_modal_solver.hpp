#pragma once

#include "cpu/frequency_domain/slepc_modal_eigen.hpp"
#include "frequency_domain/modal_eigen_request.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct PoissonAirboxSharedDomainComplexCsrMatrix;

/*
 * Native shared-domain Floquet owner.  All five blocks are phase-reduced
 * complex CSR matrices assembled from one MFEM mesh/material/equilibrium
 * payload.  The modal solver realifies only the sparse PETSc views and keeps
 * A_qphi P^{-1} A_phiq as a MatShell action, so the dense512 diagnostic bound
 * is not part of this production contract.
 */
struct FloquetSharedDomainSparseModalOperator {
    const PoissonAirboxSharedDomainComplexCsrMatrix *a_qq = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *b_qq = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *p = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *a_qphi = nullptr;
    const PoissonAirboxSharedDomainComplexCsrMatrix *a_phiq = nullptr;
    std::uint64_t q_complex_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    const char *boundary_kind = nullptr;
    const char *gauge_policy = nullptr;
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

const char *floquet_modal_solver_model() noexcept;

} // namespace fullmag::fem::frequency_domain
