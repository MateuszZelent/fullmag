/*
 * Host CSR sparse block exporter for the MFEM Poisson demagnetization operator.
 *
 * Phase 0 compiling seam stub (unconditionally compiled into fullmag_fem so
 * non-MFEM builds link cleanly; full MFEM CSR export with ess_tdofs row zeroing
 * is implemented by Track 3 in Phase 1).
 */

#include "cpu/mfem/interactions/demag_poisson_sparse_export.hpp"

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool export_demag_poisson_sparse_blocks(
    const Context &ctx,
    fullmag_fem_demag_poisson_sparse_blocks &out_blocks,
    std::string &error)
{
    (void)ctx;
    out_blocks = {};
    error = "demag Poisson sparse block export is not implemented yet (Phase 0 seam)";
    return false;
}
#endif

void destroy_demag_poisson_sparse_blocks(
    fullmag_fem_demag_poisson_sparse_blocks &blocks) noexcept
{
    blocks = {};
}

} // namespace fullmag::fem
