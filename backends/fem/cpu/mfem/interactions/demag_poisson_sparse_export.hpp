#pragma once

/*
 * Host CSR sparse block exporter for the MFEM Poisson demagnetization operator.
 *
 * Exports P (periodic_reduced_ready ? periodic_matrix : poisson_bc_op),
 * rhs_{x,y,z} with ess_tdofs rows explicitly zeroed, recovery_{x,y,z}, and
 * index maps for GPU cuDSS driven response.
 */

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
struct Context;

bool export_demag_poisson_sparse_blocks(
    const Context &ctx,
    fullmag_fem_demag_poisson_sparse_blocks &out_blocks,
    std::string &error);
#endif

void destroy_demag_poisson_sparse_blocks(
    fullmag_fem_demag_poisson_sparse_blocks &blocks) noexcept;

} // namespace fullmag::fem
