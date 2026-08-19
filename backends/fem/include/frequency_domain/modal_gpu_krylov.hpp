#pragma once

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"

namespace fullmag::fem::frequency_domain {

/*
 * Device-resident K0 modal implementation.
 *
 * The function owns one CUDA operator/workspace context for the complete
 * solve.  The input CSR blocks are uploaded once, Krylov/inverse-iteration
 * vectors stay on the device until the final accepted modes are copied back,
 * and failures are returned without a CPU fallback.
 */
FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_device_krylov(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept;

// Production K0 GPU realization. PETSc owns CUDA vectors and sparse blocks,
// SLEPc owns the device-resident Krylov basis, and hypre preconditions the
// Poisson and shifted magnetic actions. No CPU solver fallback is permitted.
FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept;

// Release the PETSc/SLEPc CUDA runtime while the owning Fullmag GPU context is
// still alive. This is idempotent and must run after the final modal GPU solve
// instead of being deferred to static destruction.
FrequencyDomainStatus finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() noexcept;

} // namespace fullmag::fem::frequency_domain
