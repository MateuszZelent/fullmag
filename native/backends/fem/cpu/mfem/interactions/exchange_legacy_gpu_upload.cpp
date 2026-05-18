/*
 * Exchange legacy GPU upload source contract.
 *
 * This source owns validation and publication of assembled legacy sparse
 * exchange CSR data, lumped mass, and inverse mass into GPU state. It does not assemble exchange operators or compute H_ex.
 */
#include "cpu/mfem/interactions/exchange_legacy_gpu_upload.hpp"

#include "context.hpp"
#include "gpu_state.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &ctx,
    mfem::SparseMatrix &exchange_spmat,
    std::string &error)
{
    if (!ctx.gpu_state.allocated) {
        return true;
    }
    const int height = exchange_spmat.Height();
    const int width = exchange_spmat.Width();
    const int nnz = exchange_spmat.NumNonZeroElems();
    if (height <= 0 || width <= 0 || nnz < 0) {
        error = "legacy sparse exchange CSR has invalid dimensions";
        return false;
    }
    if (height > static_cast<int>(std::numeric_limits<uint32_t>::max()) ||
        width > static_cast<int>(std::numeric_limits<uint32_t>::max())) {
        error = "legacy sparse exchange CSR dimensions exceed u32 GPU indexing";
        return false;
    }
    if (ctx.integration_weights.mfem_lumped_mass.size() != static_cast<size_t>(height)) {
        error = "legacy sparse exchange CSR row count does not match lumped mass";
        return false;
    }

    const int *row_offsets_raw = exchange_spmat.GetI();
    const int *col_indices_raw = exchange_spmat.GetJ();
    const double *values_raw = exchange_spmat.GetData();
    if (row_offsets_raw == nullptr || col_indices_raw == nullptr || values_raw == nullptr) {
        error = "legacy sparse exchange CSR data pointers are null";
        return false;
    }

    std::vector<uint32_t> row_offsets(static_cast<size_t>(height) + 1u);
    for (int i = 0; i <= height; ++i) {
        if (row_offsets_raw[i] < 0) {
            error = "legacy sparse exchange CSR row offset is negative";
            return false;
        }
        row_offsets[static_cast<size_t>(i)] = static_cast<uint32_t>(row_offsets_raw[i]);
    }
    if (row_offsets.back() != static_cast<uint32_t>(nnz)) {
        error = "legacy sparse exchange CSR row offsets do not match nnz";
        return false;
    }

    std::vector<uint32_t> col_indices(static_cast<size_t>(nnz));
    for (int i = 0; i < nnz; ++i) {
        if (col_indices_raw[i] < 0 || col_indices_raw[i] >= width) {
            error = "legacy sparse exchange CSR column index is out of bounds";
            return false;
        }
        col_indices[static_cast<size_t>(i)] = static_cast<uint32_t>(col_indices_raw[i]);
    }

    std::vector<double> inv_lumped(ctx.integration_weights.mfem_lumped_mass.size(), 0.0);
    for (size_t i = 0; i < ctx.integration_weights.mfem_lumped_mass.size(); ++i) {
        const double mass = ctx.integration_weights.mfem_lumped_mass[i];
        inv_lumped[i] = mass > 0.0 ? 1.0 / mass : 0.0;
    }

    return gpu_state_upload_exchange_legacy_sparse(
        ctx.gpu_state,
        static_cast<uint64_t>(height),
        static_cast<uint64_t>(width),
        row_offsets.data(),
        static_cast<uint64_t>(row_offsets.size()),
        col_indices.data(),
        static_cast<uint64_t>(col_indices.size()),
        values_raw,
        static_cast<uint64_t>(nnz),
        ctx.integration_weights.mfem_lumped_mass.data(),
        static_cast<uint64_t>(ctx.integration_weights.mfem_lumped_mass.size()),
        inv_lumped.data(),
        static_cast<uint64_t>(inv_lumped.size()),
        ctx.transfer_audit,
        error);
}
#else
bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &,
    mfem::SparseMatrix &,
    std::string &error)
{
    error = "Native FEM exchange GPU upload requires the MFEM stack";
    return false;
}
#endif

} // namespace fullmag::fem
