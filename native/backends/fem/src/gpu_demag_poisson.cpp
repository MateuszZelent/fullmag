/*
 * GPU Poisson demag source contract.
 *
 * This source owns the device-resident P1 Poisson demag workspace: sparse RHS
 * and recovery operators, Hypre device-policy solve state, essential true DOF
 * masks, warm-started scalar potential, and device demag energy. It does not
 * own public DSL semantics, MFEM context construction, RK stage orchestration,
 * exchange, local interaction kernels, or C ABI entrypoints.
 */

#include "gpu_demag_poisson.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "fem_common.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "kernels.h"
#include <cuda_runtime.h>
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem {

namespace {

struct DeviceCsrTriple {
    uint64_t rows = 0;
    uint64_t nnz = 0;
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values_x;
    std::vector<double> values_y;
    std::vector<double> values_z;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_row_offsets = nullptr;
    uint32_t *d_col_indices = nullptr;
    double *d_values_x = nullptr;
    double *d_values_y = nullptr;
    double *d_values_z = nullptr;
#endif
};

struct DeviceCsrScalar {
    uint64_t rows = 0;
    uint64_t nnz = 0;
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_row_offsets = nullptr;
    uint32_t *d_col_indices = nullptr;
    double *d_values = nullptr;
#endif
};

struct GpuDemagPoissonWorkspace {
    DeviceCsrTriple rhs;
    DeviceCsrScalar recovery_x;
    DeviceCsrScalar recovery_y;
    DeviceCsrScalar recovery_z;
    std::vector<uint32_t> ess_tdofs;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_ess_tdofs = nullptr;
    cudaEvent_t compute_ready_event = nullptr;
    cudaEvent_t hypre_done_event = nullptr;
#endif
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    HYPRE_BigInt row_starts[2] = {0, 0};
    std::unique_ptr<mfem::HypreParMatrix> A_par;
    std::unique_ptr<mfem::HypreSolver> preconditioner;
    std::unique_ptr<mfem::HypreSolver> solver;
    std::unique_ptr<mfem::HypreParVector> b_par;
    std::unique_ptr<mfem::HypreParVector> x_par;
#endif
    uint64_t device_bytes = 0;
    bool ready = false;
};

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

    workspace.ess_tdofs.clear();
    workspace.ess_tdofs.reserve(ctx.poisson_demag.ess_tdof_list.size());
    for (const int tdof : ctx.poisson_demag.ess_tdof_list) {
        if (tdof >= 0) {
            workspace.ess_tdofs.push_back(static_cast<uint32_t>(tdof));
        }
    }
    return true;
}
#endif

#if FULLMAG_HAS_MFEM_STACK
GpuDemagPoissonWorkspace *workspace_ptr(const Context &ctx)
{
    return static_cast<GpuDemagPoissonWorkspace *>(ctx.poisson_demag.gpu_workspace);
}
#endif

} // namespace

bool gpu_demag_poisson_initialize(Context &ctx, std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.demag.enabled || ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
        return true;
    }
    if (!ctx.gpu_state.device.allocated ||
        ctx.gpu_state.device.poisson_rhs == nullptr ||
        ctx.gpu_state.device.poisson_solution == nullptr ||
        ctx.gpu_state.device.h_demag.x == nullptr) {
        error = "GPU Poisson demag requires allocated FemGpuState demag buffers";
        return false;
    }

    auto workspace = std::make_unique<GpuDemagPoissonWorkspace>();
    if (!build_p1_demag_operators(ctx, *workspace, error)) {
        return false;
    }

    uint64_t device_bytes = 0;
    if (!upload_triple(workspace->rhs, device_bytes, error) ||
        !upload_scalar(workspace->recovery_x, device_bytes, "cudaMalloc/upload demag recovery x CSR", error) ||
        !upload_scalar(workspace->recovery_y, device_bytes, "cudaMalloc/upload demag recovery y CSR", error) ||
        !upload_scalar(workspace->recovery_z, device_bytes, "cudaMalloc/upload demag recovery z CSR", error) ||
        !upload_device_array(
            workspace->d_ess_tdofs,
            workspace->ess_tdofs,
            device_bytes,
            "cudaMalloc/upload demag essential tdofs",
            error)) {
        destroy_triple(workspace->rhs);
        destroy_scalar(workspace->recovery_x);
        destroy_scalar(workspace->recovery_y);
        destroy_scalar(workspace->recovery_z);
        free_device_array(workspace->d_ess_tdofs);
        return false;
    }
    workspace->device_bytes = device_bytes;

    if (!cuda_ok(cudaEventCreateWithFlags(&workspace->compute_ready_event, cudaEventDisableTiming),
            "cudaEventCreate demag compute_ready_event", error) ||
        !cuda_ok(cudaEventCreateWithFlags(&workspace->hypre_done_event, cudaEventDisableTiming),
            "cudaEventCreate demag hypre_done_event", error) ||
        !cuda_ok(cudaMemset(ctx.gpu_state.device.poisson_rhs, 0,
                static_cast<size_t>(ctx.mesh.n_nodes) * sizeof(double)),
            "cudaMemset demag poisson_rhs", error) ||
        !cuda_ok(cudaMemset(ctx.gpu_state.device.poisson_solution, 0,
                static_cast<size_t>(ctx.mesh.n_nodes) * sizeof(double)),
            "cudaMemset demag poisson_solution", error)) {
        gpu_demag_poisson_destroy(ctx);
        return false;
    }

    mfem::Hypre::Init();
    mfem::Hypre::InitDevice();
#if defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP)
    HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE);
    HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE);
#endif

    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.poisson_bc_op);
    if (A_bc == nullptr) {
        error = "GPU Poisson demag requires an initialized Poisson boundary-conditioned operator";
        return false;
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    workspace->row_starts[0] = 0;
    workspace->row_starts[1] = glob_size;
    workspace->A_par = std::make_unique<mfem::HypreParMatrix>(
        fullmag_serial_comm(),
        glob_size,
        workspace->row_starts,
        A_bc);
    workspace->A_par->HypreRead();

    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(*workspace->A_par);
        amg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        amg->SetRelaxType(18);
        amg->SetCoarsening(8);
        amg->SetInterpolation(6);
        amg->SetAggressiveCoarsening(1);
        workspace->preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        workspace->preconditioner = std::make_unique<mfem::HypreDiagScale>(*workspace->A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(*workspace->A_par);
        workspace->preconditioner = std::move(identity);
        break;
    }
    default:
        error = "Unsupported native FEM GPU demag preconditioner enum";
        return false;
    }

    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto pcg = std::make_unique<mfem::HyprePCG>(fullmag_serial_comm());
        pcg->iterative_mode = true;
        pcg->SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            pcg->SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        pcg->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        pcg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        pcg->SetOperator(*workspace->A_par);
        pcg->SetPreconditioner(*workspace->preconditioner);
        workspace->solver = std::move(pcg);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto gmres = std::make_unique<mfem::HypreGMRES>(fullmag_serial_comm());
        gmres->iterative_mode = true;
        gmres->SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            gmres->SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        gmres->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        gmres->SetKDim(50);
        gmres->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        gmres->SetOperator(*workspace->A_par);
        gmres->SetPreconditioner(*workspace->preconditioner);
        workspace->solver = std::move(gmres);
        break;
    }
    default:
        error = "Unsupported native FEM GPU demag linear solver enum";
        return false;
    }

    workspace->b_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        glob_size,
        ctx.gpu_state.device.poisson_rhs,
        workspace->row_starts,
        true);
    workspace->x_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        glob_size,
        ctx.gpu_state.device.poisson_solution,
        workspace->row_starts,
        true);
    workspace->ready = true;
    ctx.poisson_demag.gpu_workspace = workspace.release();
    ctx.poisson_demag.gpu_workspace_ready = true;
    ctx.poisson_demag.gpu_workspace_device_bytes = device_bytes;
    ctx.gpu_state.device.device_bytes += device_bytes;
    return true;
#else
    (void)ctx;
    error = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

void gpu_demag_poisson_destroy(Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    auto *workspace = workspace_ptr(ctx);
    if (workspace == nullptr) {
        return;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    destroy_triple(workspace->rhs);
    destroy_scalar(workspace->recovery_x);
    destroy_scalar(workspace->recovery_y);
    destroy_scalar(workspace->recovery_z);
    free_device_array(workspace->d_ess_tdofs);
    if (workspace->compute_ready_event != nullptr) {
        cudaEventDestroy(workspace->compute_ready_event);
        workspace->compute_ready_event = nullptr;
    }
    if (workspace->hypre_done_event != nullptr) {
        cudaEventDestroy(workspace->hypre_done_event);
        workspace->hypre_done_event = nullptr;
    }
#endif
    if (workspace->device_bytes <= ctx.gpu_state.device.device_bytes) {
        ctx.gpu_state.device.device_bytes -= workspace->device_bytes;
    }
    delete workspace;
    ctx.poisson_demag.gpu_workspace = nullptr;
    ctx.poisson_demag.gpu_workspace_ready = false;
    ctx.poisson_demag.gpu_workspace_device_bytes = 0;
#else
    (void)ctx;
#endif
}

bool gpu_demag_poisson_ready(const Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    auto *workspace = workspace_ptr(ctx);
    return workspace != nullptr && workspace->ready;
#else
    (void)ctx;
    return false;
#endif
}

uint64_t gpu_demag_poisson_device_bytes(const Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    auto *workspace = workspace_ptr(ctx);
    return workspace != nullptr ? workspace->device_bytes : 0;
#else
    (void)ctx;
    return 0;
#endif
}

const char *gpu_demag_poisson_operator_mode(const Context &ctx)
{
    if (!ctx.demag.enabled) {
        return "none";
    }
    return gpu_demag_poisson_ready(ctx) ? "device_hypre_poisson" : "unsupported";
}

const char *gpu_demag_poisson_hypre_policy(const Context &ctx)
{
    if (!ctx.demag.enabled) {
        return "none";
    }
    return gpu_demag_poisson_ready(ctx) ? "device" : "unavailable";
}

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.demag.enabled) {
        return true;
    }
    auto *workspace = workspace_ptr(ctx);
    auto &gpu = ctx.gpu_state.device;
    if (workspace == nullptr || !workspace->ready) {
        reason = "strict FEM GPU demag requires ready device_hypre_poisson workspace";
        return false;
    }
    if (gpu.poisson_rhs == nullptr || gpu.poisson_solution == nullptr ||
        gpu.h_demag.x == nullptr || gpu.h_demag.y == nullptr || gpu.h_demag.z == nullptr) {
        reason = "strict FEM GPU demag requires device-resident Poisson and H_demag buffers";
        return false;
    }
    if (gpu.exchange_lumped_mass == nullptr || gpu.ms == nullptr) {
        reason = "strict FEM GPU demag energy requires uploaded Ms and lumped mass buffers";
        return false;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    fullmag_cuda_demag_rhs_csr(
        workspace->rhs.d_row_offsets,
        workspace->rhs.d_col_indices,
        workspace->rhs.d_values_x,
        workspace->rhs.d_values_y,
        workspace->rhs.d_values_z,
        m.x,
        m.y,
        m.z,
        gpu.poisson_rhs,
        static_cast<int>(workspace->rhs.rows),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag RHS CSR", reason)) {
        return false;
    }
    fullmag_cuda_zero_indexed_values(
        gpu.poisson_rhs,
        workspace->d_ess_tdofs,
        static_cast<int>(workspace->ess_tdofs.size()),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag essential RHS zero", reason)) {
        return false;
    }

    if (workspace->compute_ready_event != nullptr) {
        if (!cuda_ok(cudaEventRecord(workspace->compute_ready_event, stream),
                "cudaEventRecord GPU demag RHS ready", reason) ||
            !cuda_ok(cudaStreamWaitEvent(nullptr, workspace->compute_ready_event, 0),
                "cudaStreamWaitEvent GPU demag default stream wait RHS", reason)) {
            return false;
        }
    }

    workspace->b_par->HypreReadWrite();
    workspace->x_par->HypreReadWrite();
    const auto solve_start = FemSteadyClock::now();
    workspace->solver->Mult(*workspace->b_par, *workspace->x_par);
    ctx.poisson_demag.last_solver_apply_wall_time_ns = elapsed_ns(solve_start);

    int iterations = 0;
    mfem::real_t residual = 0.0;
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(workspace->solver.get());
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(residual);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(workspace->solver.get());
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(residual);
        break;
    }
    default:
        break;
    }
    ctx.poisson_demag.last_iterations = iterations;
    ctx.poisson_demag.last_residual = static_cast<double>(residual);
    ctx.poisson_demag.last_setup_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_setup_reused = true;

    if (workspace->hypre_done_event != nullptr) {
        if (!cuda_ok(cudaEventRecord(workspace->hypre_done_event, nullptr),
                "cudaEventRecord GPU demag hypre done", reason) ||
            !cuda_ok(cudaStreamWaitEvent(stream, workspace->hypre_done_event, 0),
                "cudaStreamWaitEvent GPU demag compute stream wait solve", reason)) {
            return false;
        }
    }
    fullmag_cuda_zero_indexed_values(
        gpu.poisson_solution,
        workspace->d_ess_tdofs,
        static_cast<int>(workspace->ess_tdofs.size()),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_x.d_row_offsets,
        workspace->recovery_x.d_col_indices,
        workspace->recovery_x.d_values,
        gpu.poisson_solution,
        gpu.magnetic_node_mask,
        gpu.h_demag.x,
        static_cast<int>(workspace->recovery_x.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_y.d_row_offsets,
        workspace->recovery_y.d_col_indices,
        workspace->recovery_y.d_values,
        gpu.poisson_solution,
        gpu.magnetic_node_mask,
        gpu.h_demag.y,
        static_cast<int>(workspace->recovery_y.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_z.d_row_offsets,
        workspace->recovery_z.d_col_indices,
        workspace->recovery_z.d_values,
        gpu.poisson_solution,
        gpu.magnetic_node_mask,
        gpu.h_demag.z,
        static_cast<int>(workspace->recovery_z.rows),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag recovery CSR", reason)) {
        return false;
    }

    const int n = static_cast<int>(gpu.node_count);
    const int blocks = (n + 255) / 256;
    fullmag_cuda_demag_energy_blocks(
        m.x,
        m.y,
        m.z,
        gpu.h_demag.x,
        gpu.h_demag.y,
        gpu.h_demag.z,
        gpu.ms,
        gpu.exchange_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        std::max(1, blocks),
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy reduction", reason)) {
        return false;
    }
    ctx.poisson_demag.solves_current_step += 1;
    return true;
#else
    (void)ctx;
    (void)m;
    (void)raw_stream;
    reason = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

} // namespace fullmag::fem
