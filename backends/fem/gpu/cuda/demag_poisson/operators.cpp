/*
 * GPU CUDA Poisson demag operator workspace source contract.
 *
 * This source owns construction and device upload/destruction of the strict GPU
 * Poisson demag P1 RHS CSR, scalar-potential recovery CSR, and essential true
 * DOF lists. It does not own Hypre solver policy, lifecycle publication,
 * RK-stage orchestration, local interaction kernels, or C ABI entrypoints.
 */

#include "gpu/cuda/demag_poisson/operators.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

template <typename T>
bool upload_device_array(
    T *&dst,
    const std::vector<T> &src,
    uint64_t &device_bytes,
    const char *name,
    std::string &error)
{
    dst = nullptr;
    if (src.empty()) {
        return true;
    }
    if (src.size() > std::numeric_limits<size_t>::max() / sizeof(T)) {
        error = std::string(name) + " is too large for device allocation";
        return false;
    }
    const size_t bytes = src.size() * sizeof(T);
    if (!cuda_ok(cudaMalloc(reinterpret_cast<void **>(&dst), bytes), name, error)) {
        dst = nullptr;
        return false;
    }
    if (!cuda_ok(cudaMemcpy(dst, src.data(), bytes, cudaMemcpyHostToDevice), name, error)) {
        cudaFree(dst);
        dst = nullptr;
        return false;
    }
    device_bytes += static_cast<uint64_t>(bytes);
    return true;
}

template <typename T>
void free_device_array(T *&ptr)
{
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
}

bool upload_triple(DeviceCsrTriple &op, uint64_t &device_bytes, std::string &error)
{
    return upload_device_array(op.d_row_offsets, op.row_offsets, device_bytes, "cudaMalloc/upload demag RHS row offsets", error) &&
           upload_device_array(op.d_col_indices, op.col_indices, device_bytes, "cudaMalloc/upload demag RHS column indices", error) &&
           upload_device_array(op.d_values_x, op.values_x, device_bytes, "cudaMalloc/upload demag RHS x values", error) &&
           upload_device_array(op.d_values_y, op.values_y, device_bytes, "cudaMalloc/upload demag RHS y values", error) &&
           upload_device_array(op.d_values_z, op.values_z, device_bytes, "cudaMalloc/upload demag RHS z values", error);
}

bool upload_scalar(DeviceCsrScalar &op, uint64_t &device_bytes, const char *label, std::string &error)
{
    return upload_device_array(op.d_row_offsets, op.row_offsets, device_bytes, label, error) &&
           upload_device_array(op.d_col_indices, op.col_indices, device_bytes, label, error) &&
           upload_device_array(op.d_values, op.values, device_bytes, label, error);
}

void destroy_triple(DeviceCsrTriple &op)
{
    free_device_array(op.d_row_offsets);
    free_device_array(op.d_col_indices);
    free_device_array(op.d_values_x);
    free_device_array(op.d_values_y);
    free_device_array(op.d_values_z);
}

void destroy_scalar(DeviceCsrScalar &op)
{
    free_device_array(op.d_row_offsets);
    free_device_array(op.d_col_indices);
    free_device_array(op.d_values);
}
#endif

int signed_dof_index(int dof)
{
    return dof >= 0 ? dof : -1 - dof;
}

double signed_dof_sign(int dof)
{
    return dof >= 0 ? 1.0 : -1.0;
}

double scalar_ms_value(const Context &ctx, uint32_t node)
{
    return scalar_field_value(
        ctx.material_fields.Ms_field,
        static_cast<size_t>(node),
        ctx.material_fields.material.saturation_magnetisation);
}

} // namespace

#if FULLMAG_HAS_MFEM_STACK
bool build_p1_demag_operators(Context &ctx, GpuDemagPoissonWorkspace &workspace, std::string &error)
{
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "GPU Poisson demag requires initialized MFEM mesh and potential FE space";
        return false;
    }
    if (ctx.base_plan.fe_order != 1) {
        error = "strict FEM GPU demag supports P1 tetrahedral elements only";
        return false;
    }
    if (!ctx.mesh.periodic_node_pairs.empty()) {
        error = "strict FEM GPU demag does not support periodic Poisson demag yet";
        return false;
    }
    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        error = "strict FEM GPU demag does not support Fredkin-Koehler FEM/BEM demag";
        return false;
    }

    const uint64_t rows = static_cast<uint64_t>(fes->GetTrueVSize());
    if (rows != ctx.mesh.n_nodes || rows > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "strict FEM GPU demag requires serial P1 true DOFs to match mesh nodes";
        return false;
    }

    workspace.rhs.rows = rows;
    workspace.recovery_x.rows = rows;
    workspace.recovery_y.rows = rows;
    workspace.recovery_z.rows = rows;
    workspace.rhs.row_offsets.assign(static_cast<size_t>(rows) + 1u, 0u);
    workspace.recovery_x.row_offsets.assign(static_cast<size_t>(rows) + 1u, 0u);
    workspace.recovery_y.row_offsets.assign(static_cast<size_t>(rows) + 1u, 0u);
    workspace.recovery_z.row_offsets.assign(static_cast<size_t>(rows) + 1u, 0u);

    std::vector<std::vector<std::array<double, 4>>> rhs_rows(static_cast<size_t>(rows));
    std::vector<std::vector<std::pair<uint32_t, double>>> rec_x(static_cast<size_t>(rows));
    std::vector<std::vector<std::pair<uint32_t, double>>> rec_y(static_cast<size_t>(rows));
    std::vector<std::vector<std::pair<uint32_t, double>>> rec_z(static_cast<size_t>(rows));
    std::vector<double> recovery_weight(static_cast<size_t>(rows), 0.0);

    mfem::Array<int> dofs;
    mfem::DenseMatrix dshape;
    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        const mfem::FiniteElement *fe = fes->GetFE(elem);
        if (fe == nullptr || fe->GetOrder() != 1) {
            error = "strict FEM GPU demag found a non-P1 element in the potential FE space";
            return false;
        }
        fes->GetElementDofs(elem, dofs);
        if (dofs.Size() != 4) {
            error = "strict FEM GPU demag requires tetrahedral P1 elements with four local DOFs";
            return false;
        }

        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        const mfem::IntegrationPoint &ip0 = mfem::Geometries.GetCenter(fe->GetGeomType());
        T->SetIntPoint(&ip0);
        const double volume = std::abs(T->Weight()) / 6.0;
        dshape.SetSize(4, 3);
        fe->CalcPhysDShape(*T, dshape);

        std::array<uint32_t, 4> nodes{};
        std::array<double, 4> signs{};
        for (int i = 0; i < 4; ++i) {
            const int gdof = signed_dof_index(dofs[i]);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= rows) {
                error = "strict FEM GPU demag found an out-of-range P1 DOF";
                return false;
            }
            nodes[static_cast<size_t>(i)] = static_cast<uint32_t>(gdof);
            signs[static_cast<size_t>(i)] = signed_dof_sign(dofs[i]);
            recovery_weight[static_cast<size_t>(gdof)] += volume / 4.0;
        }

        if (ctx.mesh.magnetic_element_mask.empty() ||
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] != 0u) {
            double ms_sum = 0.0;
            std::array<double, 4> ms_nodes{};
            for (int k = 0; k < 4; ++k) {
                ms_nodes[static_cast<size_t>(k)] =
                    scalar_ms_value(ctx, nodes[static_cast<size_t>(k)]);
                ms_sum += ms_nodes[static_cast<size_t>(k)];
            }
            for (int i = 0; i < 4; ++i) {
                const uint32_t row = nodes[static_cast<size_t>(i)];
                for (int k = 0; k < 4; ++k) {
                    const uint32_t col = nodes[static_cast<size_t>(k)];
                    const double coeff = ctx.material_fields.Ms_field.empty()
                        ? ctx.material_fields.material.saturation_magnetisation * volume / 4.0
                        : volume * (ms_sum + ms_nodes[static_cast<size_t>(k)]) / 20.0;
                    rhs_rows[static_cast<size_t>(row)].push_back({
                        static_cast<double>(col),
                        signs[static_cast<size_t>(i)] * signs[static_cast<size_t>(k)] *
                            coeff * dshape(i, 0),
                        signs[static_cast<size_t>(i)] * signs[static_cast<size_t>(k)] *
                            coeff * dshape(i, 1),
                        signs[static_cast<size_t>(i)] * signs[static_cast<size_t>(k)] *
                            coeff * dshape(i, 2),
                    });
                }
            }
        }

        for (int i = 0; i < 4; ++i) {
            const uint32_t row = nodes[static_cast<size_t>(i)];
            const double node_weight = recovery_weight[static_cast<size_t>(row)];
            (void)node_weight;
        }
    }

    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        const mfem::FiniteElement *fe = fes->GetFE(elem);
        fes->GetElementDofs(elem, dofs);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        const mfem::IntegrationPoint &ip0 = mfem::Geometries.GetCenter(fe->GetGeomType());
        T->SetIntPoint(&ip0);
        const double volume = std::abs(T->Weight()) / 6.0;
        dshape.SetSize(4, 3);
        fe->CalcPhysDShape(*T, dshape);

        std::array<uint32_t, 4> nodes{};
        std::array<double, 4> signs{};
        for (int i = 0; i < 4; ++i) {
            nodes[static_cast<size_t>(i)] = static_cast<uint32_t>(signed_dof_index(dofs[i]));
            signs[static_cast<size_t>(i)] = signed_dof_sign(dofs[i]);
        }
        for (int i = 0; i < 4; ++i) {
            const uint32_t row = nodes[static_cast<size_t>(i)];
            const double normalizer = recovery_weight[static_cast<size_t>(row)];
            if (normalizer <= 0.0) {
                continue;
            }
            const double weight = (volume / 4.0) / normalizer;
            for (int k = 0; k < 4; ++k) {
                const uint32_t col = nodes[static_cast<size_t>(k)];
                rec_x[static_cast<size_t>(row)].push_back(
                    {col, -signs[static_cast<size_t>(k)] * dshape(k, 0) * weight});
                rec_y[static_cast<size_t>(row)].push_back(
                    {col, -signs[static_cast<size_t>(k)] * dshape(k, 1) * weight});
                rec_z[static_cast<size_t>(row)].push_back(
                    {col, -signs[static_cast<size_t>(k)] * dshape(k, 2) * weight});
            }
        }
    }

    uint64_t rhs_nnz = 0;
    uint64_t rec_nnz = 0;
    for (uint64_t row = 0; row < rows; ++row) {
        rhs_nnz += rhs_rows[static_cast<size_t>(row)].size();
        rec_nnz += rec_x[static_cast<size_t>(row)].size();
        if (rhs_nnz > std::numeric_limits<uint32_t>::max() ||
            rec_nnz > std::numeric_limits<uint32_t>::max()) {
            error = "strict FEM GPU demag CSR operator exceeds 32-bit index capacity";
            return false;
        }
        workspace.rhs.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rhs_nnz);
        workspace.recovery_x.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
        workspace.recovery_y.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
        workspace.recovery_z.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
    }
    workspace.rhs.nnz = rhs_nnz;
    workspace.recovery_x.nnz = rec_nnz;
    workspace.recovery_y.nnz = rec_nnz;
    workspace.recovery_z.nnz = rec_nnz;

    workspace.rhs.col_indices.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_x.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_y.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_z.reserve(static_cast<size_t>(rhs_nnz));
    for (uint64_t row = 0; row < rows; ++row) {
        for (const auto &entry : rhs_rows[static_cast<size_t>(row)]) {
            workspace.rhs.col_indices.push_back(static_cast<uint32_t>(entry[0]));
            workspace.rhs.values_x.push_back(entry[1]);
            workspace.rhs.values_y.push_back(entry[2]);
            workspace.rhs.values_z.push_back(entry[3]);
        }
    }

    auto fill_recovery = [](const std::vector<std::vector<std::pair<uint32_t, double>>> &rows_in,
                            DeviceCsrScalar &op) {
        op.col_indices.reserve(static_cast<size_t>(op.nnz));
        op.values.reserve(static_cast<size_t>(op.nnz));
        for (const auto &row_entries : rows_in) {
            for (const auto &entry : row_entries) {
                op.col_indices.push_back(entry.first);
                op.values.push_back(entry.second);
            }
        }
    };
    fill_recovery(rec_x, workspace.recovery_x);
    fill_recovery(rec_y, workspace.recovery_y);
    fill_recovery(rec_z, workspace.recovery_z);

    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
        ctx.poisson_demag.robin_effective_beta > 0.0 &&
        ctx.poisson_demag.robin_boundary_mass != nullptr) {
        auto *bdr_mass =
            static_cast<mfem::BilinearForm *>(ctx.poisson_demag.robin_boundary_mass);
        const mfem::SparseMatrix &matrix = bdr_mass->SpMat();
        if (matrix.Height() != static_cast<int>(rows) ||
            matrix.Width() != static_cast<int>(rows)) {
            error = "strict FEM GPU demag Robin boundary mass shape does not match potential DOFs";
            return false;
        }
        const int *row_offsets = matrix.GetI();
        const int *col_indices = matrix.GetJ();
        const double *values = matrix.GetData();
        if (row_offsets == nullptr) {
            error = "strict FEM GPU demag Robin boundary mass CSR row offsets are null";
            return false;
        }
        const int nnz = row_offsets[static_cast<int>(rows)];
        if (nnz < 0 || static_cast<uint64_t>(nnz) > std::numeric_limits<uint32_t>::max()) {
            error = "strict FEM GPU demag Robin boundary mass exceeds 32-bit CSR capacity";
            return false;
        }
        if (nnz > 0 && (col_indices == nullptr || values == nullptr)) {
            error = "strict FEM GPU demag Robin boundary mass CSR data are null";
            return false;
        }
        workspace.robin_boundary_mass.rows = rows;
        workspace.robin_boundary_mass.nnz = static_cast<uint64_t>(nnz);
        workspace.robin_boundary_mass.row_offsets.resize(static_cast<size_t>(rows) + 1u);
        for (uint64_t row = 0; row <= rows; ++row) {
            const int offset = row_offsets[static_cast<int>(row)];
            if (offset < 0 || static_cast<uint64_t>(offset) > static_cast<uint64_t>(nnz)) {
                error = "strict FEM GPU demag Robin boundary mass row offset is invalid";
                return false;
            }
            workspace.robin_boundary_mass.row_offsets[static_cast<size_t>(row)] =
                static_cast<uint32_t>(offset);
        }
        workspace.robin_boundary_mass.col_indices.resize(static_cast<size_t>(nnz));
        workspace.robin_boundary_mass.values.resize(static_cast<size_t>(nnz));
        for (int entry = 0; entry < nnz; ++entry) {
            if (col_indices[entry] < 0 || static_cast<uint64_t>(col_indices[entry]) >= rows) {
                error = "strict FEM GPU demag Robin boundary mass column index is invalid";
                return false;
            }
            workspace.robin_boundary_mass.col_indices[static_cast<size_t>(entry)] =
                static_cast<uint32_t>(col_indices[entry]);
            workspace.robin_boundary_mass.values[static_cast<size_t>(entry)] = values[entry];
        }
    }

    workspace.ess_tdofs.clear();
    workspace.ess_tdofs.reserve(ctx.poisson_demag.ess_tdof_list.size());
    for (const int tdof : ctx.poisson_demag.ess_tdof_list) {
        if (tdof >= 0) {
            workspace.ess_tdofs.push_back(static_cast<uint32_t>(tdof));
        }
    }
    return true;
}
#else
bool build_p1_demag_operators(Context &ctx, GpuDemagPoissonWorkspace &workspace, std::string &error)
{
    (void)ctx;
    (void)workspace;
    error = "strict FEM GPU demag requires MFEM stack support";
    return false;
}
#endif

bool upload_demag_poisson_operators(
    GpuDemagPoissonWorkspace &workspace,
    uint64_t &device_bytes,
    std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (!upload_triple(workspace.rhs, device_bytes, error) ||
        !upload_scalar(workspace.recovery_x, device_bytes, "cudaMalloc/upload demag recovery x CSR", error) ||
        !upload_scalar(workspace.recovery_y, device_bytes, "cudaMalloc/upload demag recovery y CSR", error) ||
        !upload_scalar(workspace.recovery_z, device_bytes, "cudaMalloc/upload demag recovery z CSR", error) ||
        !upload_scalar(workspace.robin_boundary_mass, device_bytes, "cudaMalloc/upload demag Robin boundary mass CSR", error) ||
        !upload_device_array(
            workspace.d_ess_tdofs,
            workspace.ess_tdofs,
            device_bytes,
            "cudaMalloc/upload demag essential tdofs",
            error)) {
        destroy_demag_poisson_operators(workspace);
        return false;
    }
    return true;
#else
    (void)workspace;
    (void)device_bytes;
    error = "strict FEM GPU demag operator upload requires CUDA runtime support";
    return false;
#endif
}

void destroy_demag_poisson_operators(GpuDemagPoissonWorkspace &workspace)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    destroy_triple(workspace.rhs);
    destroy_scalar(workspace.recovery_x);
    destroy_scalar(workspace.recovery_y);
    destroy_scalar(workspace.recovery_z);
    destroy_scalar(workspace.robin_boundary_mass);
    free_device_array(workspace.d_ess_tdofs);
#else
    (void)workspace;
#endif
}

GpuDemagPoissonWorkspace *workspace_ptr(const Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    return static_cast<GpuDemagPoissonWorkspace *>(ctx.poisson_demag.gpu_workspace);
#else
    (void)ctx;
    return nullptr;
#endif
}

} // namespace fullmag::fem
