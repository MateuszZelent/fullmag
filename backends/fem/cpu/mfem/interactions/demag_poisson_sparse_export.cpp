/*
 * Host CSR sparse block exporter for the MFEM Poisson demagnetization operator.
 *
 * Unconditionally compiled into fullmag_fem so non-MFEM builds link cleanly.
 * Exports P (periodic_reduced_ready ? periodic_matrix : poisson_bc_op),
 * rhs_{x,y,z} with ess_tdofs rows explicitly zeroed, recovery_{x,y,z},
 * magnetic node indices, essential true DOFs, and optional periodic reduction
 * mapping for GPU cuDSS driven response.
 */

#include "cpu/mfem/interactions/demag_poisson_sparse_export.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_ready.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include <mfem.hpp>
#endif

namespace fullmag::fem {

namespace {

struct DemagPoissonSparseBlocksOwner {
    std::vector<uint32_t> poisson_row_ptr;
    std::vector<uint32_t> poisson_col_indices;
    std::vector<double> poisson_values;

    std::vector<uint32_t> rhs_row_ptr;
    std::vector<uint32_t> rhs_col_indices;
    std::vector<double> rhs_values_x;
    std::vector<double> rhs_values_y;
    std::vector<double> rhs_values_z;

    std::vector<uint32_t> recovery_x_row_ptr;
    std::vector<uint32_t> recovery_x_col_indices;
    std::vector<double> recovery_x_values;

    std::vector<uint32_t> recovery_y_row_ptr;
    std::vector<uint32_t> recovery_y_col_indices;
    std::vector<double> recovery_y_values;

    std::vector<uint32_t> recovery_z_row_ptr;
    std::vector<uint32_t> recovery_z_col_indices;
    std::vector<double> recovery_z_values;

    std::vector<uint32_t> magnetic_node_indices;
    std::vector<uint32_t> ess_tdofs;
    std::vector<uint32_t> periodic_reduced_node;
};

#if FULLMAG_HAS_MFEM_STACK

template <class T>
const T *data_or_null(const std::vector<T> &values) noexcept
{
    return values.empty() ? nullptr : values.data();
}

fullmag_fem_sparse_csr_f64_view make_csr_view(
    uint64_t num_rows,
    uint64_t num_cols,
    const std::vector<uint32_t> &row_ptr,
    const std::vector<uint32_t> &col_indices,
    const std::vector<double> &values) noexcept
{
    fullmag_fem_sparse_csr_f64_view view{};
    view.num_rows = num_rows;
    view.num_cols = num_cols;
    view.nnz = static_cast<uint64_t>(values.size());
    view.row_ptr = data_or_null(row_ptr);
    view.col_indices = data_or_null(col_indices);
    view.values = data_or_null(values);
    return view;
}

bool copy_mfem_sparse_matrix_sorted_csr(
    const mfem::SparseMatrix &matrix,
    std::vector<uint32_t> &row_ptr,
    std::vector<uint32_t> &col_indices,
    std::vector<double> &values,
    std::string &error)
{
    if (!matrix.Finalized()) {
        error = "demag Poisson sparse export requires a finalized MFEM SparseMatrix";
        return false;
    }
    const int num_rows = matrix.Height();
    const int num_cols = matrix.Width();
    if (num_rows <= 0 || num_cols <= 0 || num_rows != num_cols) {
        error = "demag Poisson sparse export requires a non-empty square Poisson operator";
        return false;
    }
    const int *I = matrix.GetI();
    const int *J = matrix.GetJ();
    const double *Data = matrix.GetData();
    if (I == nullptr) {
        error = "demag Poisson sparse export encountered null CSR row offsets";
        return false;
    }
    const int raw_nnz = I[num_rows];
    if (raw_nnz < 0 || (raw_nnz > 0 && (J == nullptr || Data == nullptr))) {
        error = "demag Poisson sparse export encountered invalid MFEM SparseMatrix storage";
        return false;
    }

    row_ptr.assign(static_cast<size_t>(num_rows) + 1u, 0u);
    col_indices.clear();
    values.clear();
    col_indices.reserve(static_cast<size_t>(raw_nnz));
    values.reserve(static_cast<size_t>(raw_nnz));

    std::vector<std::pair<uint32_t, double>> row_entries;
    uint64_t nnz = 0;
    for (int row = 0; row < num_rows; ++row) {
        const int begin = I[row];
        const int end = I[row + 1];
        if (begin < 0 || end < begin || end > raw_nnz) {
            error = "demag Poisson sparse export encountered malformed MFEM CSR row bounds";
            return false;
        }
        row_entries.clear();
        row_entries.reserve(static_cast<size_t>(end - begin));
        for (int cursor = begin; cursor < end; ++cursor) {
            const int col = J[cursor];
            const double val = Data[cursor];
            if (col < 0 || col >= num_cols) {
                error = "demag Poisson sparse export encountered out-of-range Poisson column index";
                return false;
            }
            if (!std::isfinite(val)) {
                error = "demag Poisson sparse export encountered non-finite Poisson matrix entry";
                return false;
            }
            row_entries.emplace_back(static_cast<uint32_t>(col), val);
        }
        std::sort(
            row_entries.begin(),
            row_entries.end(),
            [](const auto &lhs, const auto &rhs) { return lhs.first < rhs.first; });

        for (size_t idx = 0; idx < row_entries.size();) {
            const uint32_t col = row_entries[idx].first;
            double sum = row_entries[idx].second;
            ++idx;
            while (idx < row_entries.size() && row_entries[idx].first == col) {
                sum += row_entries[idx].second;
                ++idx;
            }
            if (!std::isfinite(sum)) {
                error = "demag Poisson sparse export accumulated non-finite Poisson matrix entry";
                return false;
            }
            if (nnz >= std::numeric_limits<uint32_t>::max()) {
                error = "demag Poisson sparse export exceeded 32-bit CSR nnz capacity";
                return false;
            }
            col_indices.push_back(col);
            values.push_back(sum);
            ++nnz;
        }
        row_ptr[static_cast<size_t>(row) + 1u] = static_cast<uint32_t>(nnz);
    }
    return true;
}

bool copy_device_csr_scalar(
    const DeviceCsrScalar &src,
    uint64_t expected_rows,
    uint64_t expected_cols,
    const char *label,
    std::vector<uint32_t> &row_ptr,
    std::vector<uint32_t> &col_indices,
    std::vector<double> &values,
    std::string &error)
{
    if (src.rows != expected_rows ||
        src.row_offsets.size() != static_cast<size_t>(expected_rows) + 1u ||
        src.col_indices.size() != static_cast<size_t>(src.nnz) ||
        src.values.size() != static_cast<size_t>(src.nnz) ||
        src.row_offsets.front() != 0u ||
        static_cast<uint64_t>(src.row_offsets.back()) != src.nnz) {
        error = std::string("demag Poisson sparse export received malformed ") + label + " CSR";
        return false;
    }
    for (uint64_t row = 0; row < expected_rows; ++row) {
        const uint32_t begin = src.row_offsets[static_cast<size_t>(row)];
        const uint32_t end = src.row_offsets[static_cast<size_t>(row) + 1u];
        if (end < begin || static_cast<uint64_t>(end) > src.nnz) {
            error = std::string("demag Poisson sparse export has non-monotonic row offsets in ") +
                label;
            return false;
        }
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            if (static_cast<uint64_t>(src.col_indices[cursor]) >= expected_cols ||
                !std::isfinite(src.values[cursor])) {
                error = std::string("demag Poisson sparse export has invalid entry in ") + label;
                return false;
            }
        }
    }
    row_ptr = src.row_offsets;
    col_indices = src.col_indices;
    values = src.values;
    return true;
}

bool copy_rhs_csr_zeroing_ess_tdofs(
    const DeviceCsrTriple &src,
    uint64_t phi_dof_count,
    uint64_t full_node_count,
    const std::vector<uint8_t> &is_ess_row,
    std::vector<uint32_t> &row_ptr,
    std::vector<uint32_t> &col_indices,
    std::vector<double> &values_x,
    std::vector<double> &values_y,
    std::vector<double> &values_z,
    std::string &error)
{
    if (src.rows != phi_dof_count ||
        src.row_offsets.size() != static_cast<size_t>(phi_dof_count) + 1u ||
        src.col_indices.size() != static_cast<size_t>(src.nnz) ||
        src.values_x.size() != static_cast<size_t>(src.nnz) ||
        src.values_y.size() != static_cast<size_t>(src.nnz) ||
        src.values_z.size() != static_cast<size_t>(src.nnz) ||
        src.row_offsets.front() != 0u ||
        static_cast<uint64_t>(src.row_offsets.back()) != src.nnz) {
        error = "demag Poisson sparse export received malformed RHS CSR triple";
        return false;
    }

    row_ptr.assign(static_cast<size_t>(phi_dof_count) + 1u, 0u);
    col_indices.clear();
    values_x.clear();
    values_y.clear();
    values_z.clear();
    col_indices.reserve(static_cast<size_t>(src.nnz));
    values_x.reserve(static_cast<size_t>(src.nnz));
    values_y.reserve(static_cast<size_t>(src.nnz));
    values_z.reserve(static_cast<size_t>(src.nnz));

    uint64_t nnz = 0;
    for (uint64_t row = 0; row < phi_dof_count; ++row) {
        const uint32_t begin = src.row_offsets[static_cast<size_t>(row)];
        const uint32_t end = src.row_offsets[static_cast<size_t>(row) + 1u];
        if (end < begin || static_cast<uint64_t>(end) > src.nnz) {
            error = "demag Poisson sparse export encountered non-monotonic RHS CSR row offsets";
            return false;
        }
        // Essential boundary / gauge-pin rows carry prescribed delta_phi = 0,
        // matching stage_compute.cpp::fullmag_cuda_zero_indexed_values and
        // demag_poisson_periodic.cpp. Explicitly empty these rows in rhs_{x,y,z}.
        if (is_ess_row[static_cast<size_t>(row)] == 0u) {
            for (uint32_t cursor = begin; cursor < end; ++cursor) {
                const uint32_t col = src.col_indices[cursor];
                const double vx = src.values_x[cursor];
                const double vy = src.values_y[cursor];
                const double vz = src.values_z[cursor];
                if (static_cast<uint64_t>(col) >= full_node_count ||
                    !std::isfinite(vx) || !std::isfinite(vy) || !std::isfinite(vz)) {
                    error = "demag Poisson sparse export encountered invalid RHS CSR entry";
                    return false;
                }
                if (nnz >= std::numeric_limits<uint32_t>::max()) {
                    error = "demag Poisson sparse export exceeded 32-bit RHS CSR nnz capacity";
                    return false;
                }
                col_indices.push_back(col);
                values_x.push_back(vx);
                values_y.push_back(vy);
                values_z.push_back(vz);
                ++nnz;
            }
        }
        row_ptr[static_cast<size_t>(row) + 1u] = static_cast<uint32_t>(nnz);
    }
    return true;
}

#endif // FULLMAG_HAS_MFEM_STACK

} // namespace

#if FULLMAG_HAS_MFEM_STACK
bool export_demag_poisson_sparse_blocks(
    const Context &ctx,
    fullmag_fem_demag_poisson_sparse_blocks &out_blocks,
    std::string &error)
{
    out_blocks = {};
    error.clear();

    try {
        if (!ctx.demag.enabled) {
            error = "demag Poisson sparse block export requires enabled demagnetization";
            return false;
        }
        if (!demag_poisson_operator_ready_for_fresh_solve(
                ctx.demag.realization, ctx.poisson_demag.ready, error)) {
            return false;
        }

        const bool periodic_reduced = ctx.poisson_demag.periodic_reduced_ready;
        const auto *poisson_matrix = static_cast<const mfem::SparseMatrix *>(
            periodic_reduced
                ? ctx.poisson_demag.periodic_matrix
                : ctx.poisson_demag.poisson_bc_op);
        if (poisson_matrix == nullptr) {
            error = periodic_reduced
                ? "demag Poisson sparse export requires an assembled periodic_matrix"
                : "demag Poisson sparse export requires an assembled poisson_bc_op";
            return false;
        }
        if (!poisson_matrix->Finalized() ||
            poisson_matrix->Height() <= 0 ||
            poisson_matrix->Height() != poisson_matrix->Width()) {
            error = "demag Poisson sparse export requires a finalized square Poisson operator";
            return false;
        }

        const uint64_t full_node_count = static_cast<uint64_t>(ctx.mesh.n_nodes);
        const uint64_t phi_dof_count = static_cast<uint64_t>(poisson_matrix->Height());
        if (full_node_count == 0u || phi_dof_count == 0u) {
            error = "demag Poisson sparse export requires non-empty mesh and potential spaces";
            return false;
        }

        if (periodic_reduced) {
            if (ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(full_node_count) ||
                static_cast<uint64_t>(ctx.mesh.periodic_reduced_node_count) != phi_dof_count) {
                error = "demag Poisson sparse export periodic reduction map does not match periodic_matrix";
                return false;
            }
            for (const uint32_t reduced : ctx.mesh.periodic_reduced_node) {
                if (static_cast<uint64_t>(reduced) >= phi_dof_count) {
                    error = "demag Poisson sparse export has out-of-range periodic_reduced_node entry";
                    return false;
                }
            }
        }

        const GpuDemagPoissonWorkspace *existing_ws = workspace_ptr(ctx);
        const bool reuse_existing_ws =
            existing_ws != nullptr &&
            existing_ws->ready &&
            existing_ws->rhs.rows == phi_dof_count &&
            existing_ws->rhs.row_offsets.size() == static_cast<size_t>(phi_dof_count) + 1u &&
            existing_ws->recovery_x.rows == full_node_count &&
            existing_ws->recovery_y.rows == full_node_count &&
            existing_ws->recovery_z.rows == full_node_count;

        GpuDemagPoissonWorkspace local_ws;
        const GpuDemagPoissonWorkspace *active_ws = existing_ws;
        if (!reuse_existing_ws) {
            if (!build_mixed_demag_operators(const_cast<Context &>(ctx), local_ws, error)) {
                return false;
            }
            active_ws = &local_ws;
        }

        auto owner = std::make_unique<DemagPoissonSparseBlocksOwner>();
        if (!copy_mfem_sparse_matrix_sorted_csr(
                *poisson_matrix,
                owner->poisson_row_ptr,
                owner->poisson_col_indices,
                owner->poisson_values,
                error)) {
            return false;
        }

        // Collect all essential boundary / gauge-pin potential true DOFs in
        // the exported potential space (already reduced when periodic_reduced).
        owner->ess_tdofs = active_ws->ess_tdofs;
        for (const int tdof : ctx.poisson_demag.ess_tdof_list) {
            if (tdof < 0) {
                error = "demag Poisson sparse export encountered negative essential true DOF";
                return false;
            }
            uint32_t mapped = static_cast<uint32_t>(tdof);
            if (periodic_reduced) {
                if (static_cast<uint64_t>(tdof) >= full_node_count) {
                    error = "demag Poisson sparse export essential true DOF exceeds mesh nodes";
                    return false;
                }
                mapped = ctx.mesh.periodic_reduced_node[static_cast<size_t>(tdof)];
            }
            if (static_cast<uint64_t>(mapped) >= phi_dof_count) {
                error = "demag Poisson sparse export essential true DOF exceeds Poisson dimension";
                return false;
            }
            owner->ess_tdofs.push_back(mapped);
        }
        for (const uint32_t ess : owner->ess_tdofs) {
            if (static_cast<uint64_t>(ess) >= phi_dof_count) {
                error = "demag Poisson sparse export essential true DOF out of range";
                return false;
            }
        }
        std::sort(owner->ess_tdofs.begin(), owner->ess_tdofs.end());
        owner->ess_tdofs.erase(
            std::unique(owner->ess_tdofs.begin(), owner->ess_tdofs.end()),
            owner->ess_tdofs.end());

        std::vector<uint8_t> is_ess_row(static_cast<size_t>(phi_dof_count), 0u);
        for (const uint32_t ess : owner->ess_tdofs) {
            is_ess_row[static_cast<size_t>(ess)] = 1u;
        }

        if (!copy_rhs_csr_zeroing_ess_tdofs(
                active_ws->rhs,
                phi_dof_count,
                full_node_count,
                is_ess_row,
                owner->rhs_row_ptr,
                owner->rhs_col_indices,
                owner->rhs_values_x,
                owner->rhs_values_y,
                owner->rhs_values_z,
                error)) {
            return false;
        }

        if (!copy_device_csr_scalar(
                active_ws->recovery_x,
                full_node_count,
                phi_dof_count,
                "recovery_x",
                owner->recovery_x_row_ptr,
                owner->recovery_x_col_indices,
                owner->recovery_x_values,
                error) ||
            !copy_device_csr_scalar(
                active_ws->recovery_y,
                full_node_count,
                phi_dof_count,
                "recovery_y",
                owner->recovery_y_row_ptr,
                owner->recovery_y_col_indices,
                owner->recovery_y_values,
                error) ||
            !copy_device_csr_scalar(
                active_ws->recovery_z,
                full_node_count,
                phi_dof_count,
                "recovery_z",
                owner->recovery_z_row_ptr,
                owner->recovery_z_col_indices,
                owner->recovery_z_values,
                error)) {
            return false;
        }

        owner->magnetic_node_indices.clear();
        if (!ctx.mesh.magnetic_node_mask.empty()) {
            if (ctx.mesh.magnetic_node_mask.size() != static_cast<size_t>(full_node_count)) {
                error = "demag Poisson sparse export magnetic_node_mask size mismatch";
                return false;
            }
            owner->magnetic_node_indices.reserve(static_cast<size_t>(full_node_count));
            for (uint32_t node = 0; node < static_cast<uint32_t>(full_node_count); ++node) {
                if (ctx.mesh.magnetic_node_mask[static_cast<size_t>(node)] != 0u) {
                    owner->magnetic_node_indices.push_back(node);
                }
            }
        } else {
            owner->magnetic_node_indices.resize(static_cast<size_t>(full_node_count));
            for (uint32_t node = 0; node < static_cast<uint32_t>(full_node_count); ++node) {
                owner->magnetic_node_indices[static_cast<size_t>(node)] = node;
            }
        }
        if (owner->magnetic_node_indices.empty()) {
            error = "demag Poisson sparse export found zero magnetic nodes";
            return false;
        }

        if (periodic_reduced) {
            owner->periodic_reduced_node = ctx.mesh.periodic_reduced_node;
        }

        out_blocks.abi_version = FULLMAG_FEM_DEMAG_POISSON_SPARSE_BLOCKS_ABI_VERSION;
        out_blocks.struct_size =
            static_cast<uint32_t>(sizeof(fullmag_fem_demag_poisson_sparse_blocks));
        out_blocks.is_periodic_reduced = periodic_reduced ? 1u : 0u;
        out_blocks.reserved = 0u;
        out_blocks.full_node_count = full_node_count;
        out_blocks.phi_dof_count = phi_dof_count;
        out_blocks.magnetic_node_count =
            static_cast<uint64_t>(owner->magnetic_node_indices.size());
        out_blocks.ess_tdof_count = static_cast<uint64_t>(owner->ess_tdofs.size());
        out_blocks.poisson_matrix = make_csr_view(
            phi_dof_count,
            phi_dof_count,
            owner->poisson_row_ptr,
            owner->poisson_col_indices,
            owner->poisson_values);
        out_blocks.rhs_x = make_csr_view(
            phi_dof_count,
            full_node_count,
            owner->rhs_row_ptr,
            owner->rhs_col_indices,
            owner->rhs_values_x);
        out_blocks.rhs_y = make_csr_view(
            phi_dof_count,
            full_node_count,
            owner->rhs_row_ptr,
            owner->rhs_col_indices,
            owner->rhs_values_y);
        out_blocks.rhs_z = make_csr_view(
            phi_dof_count,
            full_node_count,
            owner->rhs_row_ptr,
            owner->rhs_col_indices,
            owner->rhs_values_z);
        out_blocks.recovery_x = make_csr_view(
            full_node_count,
            phi_dof_count,
            owner->recovery_x_row_ptr,
            owner->recovery_x_col_indices,
            owner->recovery_x_values);
        out_blocks.recovery_y = make_csr_view(
            full_node_count,
            phi_dof_count,
            owner->recovery_y_row_ptr,
            owner->recovery_y_col_indices,
            owner->recovery_y_values);
        out_blocks.recovery_z = make_csr_view(
            full_node_count,
            phi_dof_count,
            owner->recovery_z_row_ptr,
            owner->recovery_z_col_indices,
            owner->recovery_z_values);
        out_blocks.magnetic_node_indices = data_or_null(owner->magnetic_node_indices);
        out_blocks.ess_tdofs = data_or_null(owner->ess_tdofs);
        out_blocks.periodic_reduced_node =
            periodic_reduced ? data_or_null(owner->periodic_reduced_node) : nullptr;
        out_blocks.owner_state = owner.release();
        return true;
    } catch (const std::exception &ex) {
        out_blocks = {};
        error = std::string("demag Poisson sparse block export failed: ") + ex.what();
        return false;
    } catch (...) {
        out_blocks = {};
        error = "demag Poisson sparse block export failed with an unknown exception";
        return false;
    }
}
#endif

void destroy_demag_poisson_sparse_blocks(
    fullmag_fem_demag_poisson_sparse_blocks &blocks) noexcept
{
    delete static_cast<DemagPoissonSparseBlocksOwner *>(blocks.owner_state);
    blocks = {};
}

} // namespace fullmag::fem
