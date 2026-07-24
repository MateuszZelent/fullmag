#pragma once

#include <string>
#include <cstdint>
#include <vector>

namespace mfem {
class SparseMatrix;
} // namespace mfem

namespace fullmag::fem {

struct Context;

bool canonicalize_legacy_exchange_graph_laplacian(
    const std::vector<uint32_t> &row_offsets,
    const std::vector<uint32_t> &col_indices,
    std::vector<double> &values,
    bool materialize_diagonal,
    std::string &error);

/*
 * Legacy sparse GPU upload bridge for the native FEM exchange interaction.
 *
 * The current GPU exchange path consumes the assembled MFEM stiffness matrix as
 * a CSR operator plus lumped and inverse lumped mass vectors. This module owns
 * CSR shape/pointer/index validation, inverse-mass packaging, and the transfer
 * into `FemGpuState`.
 *
 * It does not assemble exchange or mass forms, compute H_ex, choose magnetic
 * attributes, decide source-of-truth residency, or implement the physical
 * exchange energy/field convention.
 */
bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &ctx,
    mfem::SparseMatrix &exchange_spmat,
    std::string &error);

} // namespace fullmag::fem
