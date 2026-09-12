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
    std::array<double, 3> k_rad_per_m{};
    FloquetDynamicDemagKGaugePolicy gauge_policy =
        FloquetDynamicDemagKGaugePolicy::require_invertible;
    double pivot_tolerance = 1.0e-14;
    std::uint64_t workspace_budget_bytes = 256ull * 1024ull * 1024ull;
};

struct FloquetAirboxDynamicDemagKResult {
    std::vector<double> real_split_row_major{};
    FloquetDynamicDemagKDiagnostics diagnostics{};
};

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
