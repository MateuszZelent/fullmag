#pragma once

#include "cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.hpp"
#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/modal_eigen_request.hpp"

#include <complex>
#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

// Real-scalar representation of L q = (i omega) B q:
//
//   [ L   0 ] [ Re(q) ]       [ 0  -B ] [ Re(q) ]
//   [ 0   L ] [ Im(q) ] = w   [ B   0 ] [ Im(q) ]
//
// The matrices are kept sparse and retain the row/column ordering of the
// original operator.  This is the only target representation accepted by the
// managed real-scalar PETSc/SLEPc K0 lane.
struct RealFrequencyRotatedPencil {
    std::uint64_t base_dimension = 0;
    RealSplitCsrMatrix lhs{};
    RealSplitCsrMatrix rhs{};
};

std::complex<double> original_descriptor_eigenvalue_from_rotated(
    std::complex<double> rotated_eigenvalue,
    double angular_frequency_scale) noexcept;

FrequencyDomainStatus assemble_real_frequency_rotated_pencil(
    const CsrMatrixView &lhs,
    const CsrMatrixView &mass,
    RealFrequencyRotatedPencil *out_pencil,
    char error_message[128]) noexcept;

} // namespace fullmag::fem::frequency_domain
