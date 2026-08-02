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

} // namespace fullmag::fem::frequency_domain
