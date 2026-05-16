#include "cpu/mfem/interactions/demag_poisson.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_cache.hpp"
#include "transfer_audit.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>

#ifdef _OPENMP
#include <omp.h>
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {
namespace {

/*
 * FEM Poisson demagnetizing-field interaction for the native MFEM CPU backend.
 *
 * Physical contract
 * -----------------
 * The Poisson subsystem recovers H_demag = -grad(u) in A/m from the scalar
 * magnetic potential. Once that field is available on magnetic nodes, its
 * energy is
 *
 *   E_d = -0.5 mu0 integral_Omega_m Ms m . H_demag dV                 [J].
 *
 * The half factor avoids double-counting the self-field energy. The sign
 * convention matches the existing Fullmag FEM observable `demag_energy_joules`.
 *
 * Current extraction boundary
 * ---------------------------
 * This file owns the Poisson-demag interaction slices that are independent of
 * the runtime stepper: energy, RHS assembly, boundary-conditioned operators,
 * periodic reduction, Hypre solve policy, and field recovery. The scalar
 * energy contract is kept outside the MFEM guard so sign and unit conventions
 * remain testable without a full MFEM stack.
 */

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

} // namespace

double demag_poisson_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    if (ctx.mfem_lumped_mass.empty()) {
        return 0.0;
    }

    const size_t n = std::min(
        {ctx.mfem_lumped_mass.size(), m_xyz.size() / 3u, h_demag_xyz.size() / 3u});
    double demag_energy = 0.0;
#ifdef _OPENMP
    energy_threads = std::max(1, energy_threads);
#else
    (void)energy_threads;
#endif
#ifdef _OPENMP
#pragma omp parallel for schedule(static) reduction(+:demag_energy) if(energy_threads > 1 && static_cast<int>(n) >= 2048) num_threads(energy_threads)
#endif
    for (int node_index = 0; node_index < static_cast<int>(n); ++node_index) {
        const size_t node = static_cast<size_t>(node_index);
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const size_t base = node * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        const double ms_i = scalar_field_value(
            ctx.Ms_field,
            node,
            ctx.material.saturation_magnetisation);
        demag_energy += -0.5 * kMu0 * ms_i * mdoth * ctx.mfem_lumped_mass[node];
    }
    return demag_energy;
}

double demag_poisson_cached_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    return demag_poisson_energy_from_field(ctx, m_xyz, h_demag_xyz, energy_threads) +
           ctx.cached_robin_boundary_energy;
}

bool demag_poisson_operator_ready_for_fresh_solve(
    int demag_realization,
    bool poisson_ready,
    std::string &error)
{
    if (demag_realization != FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET &&
        demag_realization != FULLMAG_FEM_DEMAG_AIRBOX_ROBIN) {
        error =
            "Native FEM demag requires a Poisson airbox realization, but the configured "
            "demag realization is unsupported";
        return false;
    }
    if (!poisson_ready) {
        error =
            "Native FEM demag requires a Poisson airbox realization, but the Poisson "
            "demag operator is not ready";
        return false;
    }
    error.clear();
    return true;
}

void finalize_demag_poisson_recovered_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz)
{
    if (!ctx.periodic_reduced_node.empty()) {
        const uint32_t n_nodes =
            std::min(ctx.n_nodes, static_cast<uint32_t>(h_demag_xyz.size() / 3u));
        for (uint32_t node = 0; node < n_nodes; ++node) {
            if (static_cast<size_t>(node) >= ctx.periodic_reduced_node.size()) {
                continue;
            }
            const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(node)];
            if (static_cast<size_t>(reduced) >= ctx.periodic_representative_nodes.size()) {
                continue;
            }
            const uint32_t representative =
                ctx.periodic_representative_nodes[static_cast<size_t>(reduced)];
            const size_t dst = static_cast<size_t>(node) * 3u;
            const size_t src = static_cast<size_t>(representative) * 3u;
            if (src + 2u >= h_demag_xyz.size() || dst + 2u >= h_demag_xyz.size()) {
                continue;
            }
            h_demag_xyz[dst + 0u] = h_demag_xyz[src + 0u];
            h_demag_xyz[dst + 1u] = h_demag_xyz[src + 1u];
            h_demag_xyz[dst + 2u] = h_demag_xyz[src + 2u];
        }
    }
    if (!ctx.h_demag_visual_xyz.empty()) {
        ctx.h_demag_visual_xyz = h_demag_xyz;
    }
}

void update_demag_poisson_visual_effective_field(
    Context &ctx,
    const std::vector<double> &h_eff_xyz,
    const std::vector<double> &h_demag_xyz)
{
    if (!ctx.h_demag_visual_xyz.empty() &&
        ctx.h_demag_visual_xyz.size() == h_eff_xyz.size() &&
        h_demag_xyz.size() == h_eff_xyz.size()) {
        ctx.h_eff_visual_xyz = h_eff_xyz;
        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            ctx.h_eff_visual_xyz[i] += ctx.h_demag_visual_xyz[i] - h_demag_xyz[i];
        }
        return;
    }
    ctx.h_eff_visual_xyz.clear();
}

#if FULLMAG_HAS_MFEM_STACK
namespace {

using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

bool debug_startup_env_enabled()
{
    const char *raw = std::getenv("FULLMAG_FEM_DEBUG_STARTUP");
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
           std::strcmp(raw, "true") == 0 ||
           std::strcmp(raw, "TRUE") == 0 ||
           std::strcmp(raw, "on") == 0 ||
           std::strcmp(raw, "ON") == 0 ||
           std::strcmp(raw, "yes") == 0 ||
           std::strcmp(raw, "YES") == 0;
}

void debug_checkpoint(const char *stage)
{
    if (!debug_startup_env_enabled()) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

uint64_t vector_bytes(const mfem::Vector &vector) {
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

const double *audited_host_read(const mfem::Vector &vector) {
    record_mfem_host_read(vector_bytes(vector));
    return vector.HostRead();
}

double *audited_host_write(mfem::Vector &vector) {
    record_mfem_host_write(vector_bytes(vector));
    return vector.HostWrite();
}

/// MFEM vector coefficient for M_s m(x), restricted to magnetic elements.
class MagnetizationCoefficient : public mfem::VectorCoefficient {
public:
    struct EvalScratch {
        mfem::Array<int> dofs;
        mfem::Vector shape;
    };

    MagnetizationCoefficient(
        const Context &ctx_ref,
        mfem::FiniteElementSpace *fes_ref)
        : mfem::VectorCoefficient(3)
        , ctx_(ctx_ref)
        , fes_(fes_ref)
    {
    }

    void SetMagnetization(const std::vector<double> &m_xyz_ref)
    {
        m_xyz_ = &m_xyz_ref;
    }

    void ClearMagnetization()
    {
        m_xyz_ = nullptr;
    }

    void Eval(mfem::Vector &V, mfem::ElementTransformation &T,
              const mfem::IntegrationPoint &ip) override
    {
        V.SetSize(3);
        if (m_xyz_ == nullptr) {
            throw std::runtime_error(
                "Poisson RHS magnetization coefficient evaluated without a current magnetization source");
        }

        const int elem_no = T.ElementNo;
        if (elem_no >= 0 &&
            !ctx_.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem_no) < ctx_.magnetic_element_mask.size() &&
            ctx_.magnetic_element_mask[static_cast<size_t>(elem_no)] == 0u) {
            V = 0.0;
            return;
        }

        thread_local EvalScratch scratch;
        mfem::Array<int> &dofs = scratch.dofs;
        fes_->GetElementDofs(elem_no, dofs);
        const int ndof = dofs.Size();

        const mfem::FiniteElement *fe = fes_->GetFE(elem_no);
        mfem::Vector &shape = scratch.shape;
        shape.SetSize(ndof);
        fe->CalcShape(ip, shape);

        double mx = 0.0;
        double my = 0.0;
        double mz = 0.0;
        for (int i = 0; i < ndof; ++i) {
            const int global_dof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            const size_t base = static_cast<size_t>(global_dof) * 3u;
            mx += sign * shape(i) * (*m_xyz_)[base + 0];
            my += sign * shape(i) * (*m_xyz_)[base + 1];
            mz += sign * shape(i) * (*m_xyz_)[base + 2];
        }

        double Ms = ctx_.material.saturation_magnetisation;
        if (!ctx_.Ms_field.empty()) {
            Ms = 0.0;
            for (int i = 0; i < ndof; ++i) {
                const int global_dof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                Ms += shape(i) *
                    scalar_field_value(
                        ctx_.Ms_field,
                        static_cast<size_t>(global_dof),
                        ctx_.material.saturation_magnetisation);
            }
        }
        V(0) = Ms * mx;
        V(1) = Ms * my;
        V(2) = Ms * mz;
    }

private:
    const Context &ctx_;
    const std::vector<double> *m_xyz_ = nullptr;
    mfem::FiniteElementSpace *fes_;
};

struct PoissonRhsWorkspace {
    PoissonRhsWorkspace(Context &ctx, mfem::FiniteElementSpace *fes)
        : m_coeff(ctx, fes)
        , rhs_form(fes)
        , rhs_true(fes->GetTrueVSize())
    {
        rhs_form.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(m_coeff));
    }

    MagnetizationCoefficient m_coeff;
    mfem::LinearForm rhs_form;
    mfem::Vector rhs_true;
};

struct PeriodicPoissonReducedWorkspace {
    explicit PeriodicPoissonReducedWorkspace(mfem::SparseMatrix &op)
        : preconditioner(op)
    {
        solver.SetPreconditioner(preconditioner);
        solver.SetOperator(op);
        solver.SetPrintLevel(0);
    }

    void configure(double rel_tol, int max_iter) {
        solver.SetRelTol(rel_tol);
        solver.SetMaxIter(max_iter);
    }

    mfem::GSSmoother preconditioner;
    mfem::CGSolver solver;
    mfem::Vector full_solution;
};

#ifdef MFEM_USE_MPI
struct PoissonHypreWorkspace {
    PoissonHypreWorkspace(
        MPI_Comm comm,
        HYPRE_BigInt glob_size,
        HYPRE_BigInt *row_starts)
        : rhs_bc(static_cast<int>(glob_size))
        , b_par(comm, glob_size, row_starts)
        , x_par(comm, glob_size, row_starts)
    {}

    mfem::Vector rhs_bc;
    mfem::HypreParVector b_par;
    mfem::HypreParVector x_par;
    bool x_par_contains_solution = false;
};
#endif

struct DemagRecoveryWorkspace {
    struct Scratch {
        mfem::Array<int> dofs;
        mfem::Vector u_elem;
        mfem::DenseMatrix dshape;
        mfem::Vector shape;
    };

    explicit DemagRecoveryWorkspace(mfem::FiniteElementSpace *fes)
        : potential(fes)
        , robin_boundary_tmp(fes->GetNDofs())
    {}

    static void reset_vector(std::vector<double> &values, size_t size) {
        if (values.size() != size) {
            values.assign(size, 0.0);
        } else {
            std::fill(values.begin(), values.end(), 0.0);
        }
    }

    void prepare(size_t node_count, size_t field_len, int recover_threads, bool parallel_recover) {
        reset_vector(node_weight, node_count);
        if (!parallel_recover) {
            return;
        }

        const size_t thread_count = static_cast<size_t>(recover_threads);
        field_partials.resize(thread_count);
        weight_partials.resize(thread_count);
        while (thread_scratch.size() < thread_count) {
            thread_scratch.emplace_back(std::make_unique<Scratch>());
        }
        for (size_t tid = 0; tid < thread_count; ++tid) {
            reset_vector(field_partials[tid], field_len);
            reset_vector(weight_partials[tid], node_count);
        }
    }

    mfem::GridFunction potential;
    std::vector<double> node_weight;
    std::vector<std::vector<double>> field_partials;
    std::vector<std::vector<double>> weight_partials;
    Scratch serial_scratch;
    std::vector<std::unique_ptr<Scratch>> thread_scratch;
    mfem::Vector robin_boundary_tmp;
};

void zero_non_magnetic_nodes_aos(
    std::vector<double> &field_xyz,
    const std::vector<uint8_t> &magnetic_node_mask)
{
    if (magnetic_node_mask.empty()) {
        return;
    }
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (magnetic_node_mask[i] == 0u) {
            const size_t base = i * 3u;
            field_xyz[base + 0] = 0.0;
            field_xyz[base + 1] = 0.0;
            field_xyz[base + 2] = 0.0;
        }
    }
}

mfem::SparseMatrix *reduce_sparse_matrix_by_periodic_classes(
    const mfem::SparseMatrix &A,
    const Context &ctx)
{
    const int nred = static_cast<int>(ctx.periodic_reduced_node_count);
    auto *R = new mfem::SparseMatrix(nred, nred);

    mfem::Array<int> cols;
    mfem::Vector vals;
    for (int i = 0; i < A.Height(); ++i) {
        const int ri = static_cast<int>(
            ctx.periodic_reduced_node[static_cast<size_t>(i)]);
        A.GetRow(i, cols, vals);
        for (int k = 0; k < cols.Size(); ++k) {
            const int rj = static_cast<int>(
                ctx.periodic_reduced_node[static_cast<size_t>(cols[k])]);
            R->Add(ri, rj, vals[k]);
        }
    }
    R->Finalize();
    return R;
}

void reduce_vector_by_periodic_classes(
    const Context &ctx,
    const mfem::Vector &full,
    mfem::Vector &reduced)
{
    reduced.SetSize(static_cast<int>(ctx.periodic_reduced_node_count));
    reduced = 0.0;
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t r = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        reduced[static_cast<int>(r)] += full[static_cast<int>(node)];
    }
}

void lift_vector_by_periodic_classes(
    const Context &ctx,
    const mfem::Vector &reduced,
    mfem::Vector &full)
{
    full.SetSize(static_cast<int>(ctx.n_nodes));
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t r = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        full[static_cast<int>(node)] = reduced[static_cast<int>(r)];
    }
}

void zero_poisson_essential_values(const Context &ctx, mfem::Vector &vec) {
    for (const int tdof : ctx.poisson_ess_tdof_list) {
        vec(tdof) = 0.0;
    }
}

#ifdef MFEM_USE_MPI
void ensure_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (!initialized) {
        int provided = 0;
        MPI_Init_thread(nullptr, nullptr, MPI_THREAD_FUNNELED, &provided);
    }
}
#endif

} // namespace

bool initialize_demag_poisson_rhs_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error)
{
    try {
        auto *rhs_workspace = new PoissonRhsWorkspace(ctx, &fes);
        ctx.mfem_poisson_rhs_workspace = rhs_workspace;
        ctx.mfem_poisson_rhs = &rhs_workspace->rhs_form;
        ctx.mfem_poisson_rhs_vec = &rhs_workspace->rhs_true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson RHS workspace initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson RHS workspace initialization failed with an unknown error";
    }
    ctx.mfem_poisson_rhs_workspace = nullptr;
    ctx.mfem_poisson_rhs = nullptr;
    ctx.mfem_poisson_rhs_vec = nullptr;
    return false;
}

void destroy_demag_poisson_rhs_workspace(Context &ctx)
{
    delete static_cast<PoissonRhsWorkspace *>(ctx.mfem_poisson_rhs_workspace);
    ctx.mfem_poisson_rhs_workspace = nullptr;
    ctx.mfem_poisson_rhs = nullptr;
    ctx.mfem_poisson_rhs_vec = nullptr;
}

bool assemble_demag_poisson_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    mfem::Vector *&rhs,
    std::string &error)
{
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    if (fes == nullptr) {
        error = "Poisson FE space is null during RHS assembly";
        return false;
    }

    auto *workspace =
        static_cast<PoissonRhsWorkspace *>(ctx.mfem_poisson_rhs_workspace);
    if (workspace == nullptr ||
        ctx.mfem_poisson_rhs == nullptr ||
        ctx.mfem_poisson_rhs_vec == nullptr) {
        error = "Poisson RHS workspace is null during RHS assembly";
        return false;
    }

    mfem::LinearForm &b = workspace->rhs_form;
    mfem::Vector &rhs_true = workspace->rhs_true;
    workspace->m_coeff.SetMagnetization(m_xyz);
    b = 0.0;
    b.Assemble();
    workspace->m_coeff.ClearMagnetization();

    rhs_true.SetSize(fes->GetTrueVSize());
    if (const mfem::SparseMatrix *restriction = fes->GetRestrictionMatrix()) {
        restriction->Mult(b, rhs_true);
    } else {
        rhs_true = b;
    }
    rhs = &rhs_true;
    return true;
}

bool initialize_demag_poisson_boundary_operator(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &potential_fes,
    mfem::BilinearForm &poisson_bilinear,
    std::string &error)
{
    if (ctx.demag_realization == 2 /* AIRBOX_ROBIN */) {
        double c = ctx.robin_beta_factor;
        if (ctx.robin_beta_mode == 1) {
            c = 1.0;
        } else if (ctx.robin_beta_mode == 2) {
            c = 2.0;
        }

        mfem::Vector bb_min;
        mfem::Vector bb_max;
        mesh.GetBoundingBox(bb_min, bb_max);
        double max_extent = 0.0;
        for (int d = 0; d < mesh.Dimension(); ++d) {
            max_extent = std::max(max_extent, bb_max(d) - bb_min(d));
        }
        double R_star = max_extent / 2.0;
        if (R_star <= 0.0) {
            R_star = 1.0;
        }
        ctx.robin_effective_beta = c / R_star;

        if (ctx.poisson_boundary_marker < 1 ||
            ctx.poisson_boundary_marker > mesh.bdr_attributes.Max()) {
            error = "Robin BC: poisson_boundary_marker=" +
                    std::to_string(ctx.poisson_boundary_marker) +
                    " not found in mesh bdr_attributes (max=" +
                    std::to_string(mesh.bdr_attributes.Max()) +
                    "). Check air_box_config boundary markers.";
            return false;
        }

        auto bdr_mass = std::make_unique<mfem::BilinearForm>(&potential_fes);
        mfem::Array<int> bdr_marker(mesh.bdr_attributes.Max());
        bdr_marker = 0;
        bdr_marker[ctx.poisson_boundary_marker - 1] = 1;
        for (uint32_t pm : ctx.periodic_boundary_marker_set) {
            if (pm >= 1 && static_cast<int>(pm) <= mesh.bdr_attributes.Max()) {
                bdr_marker[static_cast<int>(pm) - 1] = 0;
            }
        }
        bdr_mass->AddBoundaryIntegrator(
            new mfem::MassIntegrator(), bdr_marker);
        bdr_mass->Assemble();
        bdr_mass->Finalize();

        auto A_robin = std::make_unique<mfem::SparseMatrix>(poisson_bilinear.SpMat());
        A_robin->Add(ctx.robin_effective_beta, bdr_mass->SpMat());
        ctx.mfem_boundary_mass = bdr_mass.release();
        ctx.mfem_poisson_bc_op = A_robin.release();
        ctx.poisson_ess_tdof_list.clear();
        return true;
    }

    ctx.poisson_ess_tdof_list.clear();
    if (ctx.poisson_boundary_marker > 0) {
        if (ctx.poisson_boundary_marker > mesh.bdr_attributes.Max()) {
            error = "Dirichlet BC: poisson_boundary_marker=" +
                    std::to_string(ctx.poisson_boundary_marker) +
                    " exceeds mesh bdr_attributes.Max()=" +
                    std::to_string(mesh.bdr_attributes.Max()) +
                    ". Check air_box_config boundary markers.";
            return false;
        }
        mfem::Array<int> bdr_attr_is_ess(mesh.bdr_attributes.Max());
        bdr_attr_is_ess = 0;
        bdr_attr_is_ess[ctx.poisson_boundary_marker - 1] = 1;
        mfem::Array<int> ess_tdof;
        potential_fes.GetEssentialTrueDofs(bdr_attr_is_ess, ess_tdof);
        ctx.poisson_ess_tdof_list.assign(
            ess_tdof.GetData(),
            ess_tdof.GetData() + ess_tdof.Size());
    }

    if (ctx.poisson_ess_tdof_list.empty()) {
        error = "Dirichlet BC for Poisson — no boundary DOFs found for marker=" +
                std::to_string(ctx.poisson_boundary_marker) +
                ". Check that the mesh has correctly marked outer boundary faces "
                "and that air_box_config.boundary_marker matches.";
        return false;
    }

    mfem::Array<int> ess_tdof(
        ctx.poisson_ess_tdof_list.data(),
        static_cast<int>(ctx.poisson_ess_tdof_list.size()));
    auto A_bc = std::make_unique<mfem::SparseMatrix>(poisson_bilinear.SpMat());
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        A_bc->EliminateRowCol(ess_tdof[i]);
    }
    ctx.mfem_poisson_bc_op = A_bc.release();
    return true;
}

bool initialize_demag_periodic_poisson_reduction(
    Context &ctx,
    std::string &error)
{
    if (!ctx.demag_periodic_enabled() || ctx.periodic_reduced_node_count == 0) {
        return true;
    }

    auto *A_full = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_full == nullptr) {
        error = "Poisson BC operator is null when building periodic reduced system";
        return false;
    }

    try {
        ctx.mfem_periodic_poisson_matrix =
            reduce_sparse_matrix_by_periodic_classes(*A_full, ctx);
        ctx.mfem_periodic_poisson_rhs =
            new mfem::Vector(static_cast<int>(ctx.periodic_reduced_node_count));
        auto *periodic_solution =
            new mfem::Vector(static_cast<int>(ctx.periodic_reduced_node_count));
        *periodic_solution = 0.0;
        ctx.mfem_periodic_poisson_solution = periodic_solution;
        ctx.mfem_periodic_poisson_workspace =
            new PeriodicPoissonReducedWorkspace(
                *static_cast<mfem::SparseMatrix *>(ctx.mfem_periodic_poisson_matrix));
        ctx.poisson_periodic_reduced_ready = true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Periodic Poisson reduced-system initialization failed: ") + ex.what();
    } catch (...) {
        error = "Periodic Poisson reduced-system initialization failed with an unknown error";
    }
    destroy_demag_periodic_poisson_reduction(ctx);
    return false;
}

void destroy_demag_periodic_poisson_reduction(Context &ctx)
{
    delete static_cast<PeriodicPoissonReducedWorkspace *>(ctx.mfem_periodic_poisson_workspace);
    ctx.mfem_periodic_poisson_workspace = nullptr;
    delete static_cast<mfem::SparseMatrix *>(ctx.mfem_periodic_poisson_matrix);
    ctx.mfem_periodic_poisson_matrix = nullptr;
    delete static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_rhs);
    ctx.mfem_periodic_poisson_rhs = nullptr;
    delete static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_solution);
    ctx.mfem_periodic_poisson_solution = nullptr;
    ctx.poisson_periodic_reduced_ready = false;
}

bool solve_demag_periodic_poisson_reduced(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector *&full_solution,
    uint64_t &solve_wall_time_ns,
    std::string &error)
{
    full_solution = nullptr;
    solve_wall_time_ns = 0;
    auto *rhs_p = static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_rhs);
    auto *x_p = static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_solution);
    auto *periodic_workspace =
        static_cast<PeriodicPoissonReducedWorkspace *>(ctx.mfem_periodic_poisson_workspace);
    if (ctx.mfem_periodic_poisson_matrix == nullptr ||
        rhs_p == nullptr ||
        x_p == nullptr ||
        periodic_workspace == nullptr) {
        error = "Periodic Poisson reduced system is not properly initialised";
        return false;
    }

    const auto solve_wall_start = SteadyClock::now();
    reduce_vector_by_periodic_classes(ctx, rhs, *rhs_p);

    const double rel_tol = ctx.demag_solver.relative_tolerance > 0.0
                               ? ctx.demag_solver.relative_tolerance
                               : 1e-10;
    const int max_iter = ctx.demag_solver.max_iterations > 0
                             ? static_cast<int>(ctx.demag_solver.max_iterations)
                             : 1000;
    periodic_workspace->configure(rel_tol, max_iter);
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_setup_reused = true;
    const auto solver_apply_wall_start = SteadyClock::now();
    periodic_workspace->solver.Mult(*rhs_p, *x_p);
    ctx.poisson_last_solver_apply_wall_time_ns =
        elapsed_ns(solver_apply_wall_start);
    ctx.poisson_last_iterations = 0;
    ctx.poisson_last_residual = 0.0;

    mfem::Vector &lifted_solution = periodic_workspace->full_solution;
    lift_vector_by_periodic_classes(ctx, *x_p, lifted_solution);
    solve_wall_time_ns = elapsed_ns(solve_wall_start);
    full_solution = &lifted_solution;
    return true;
}

bool demag_poisson_hypre_has_warm_start(const Context &ctx)
{
#ifdef MFEM_USE_MPI
    auto *workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.mfem_poisson_hypre_workspace);
    return workspace != nullptr && workspace->x_par_contains_solution;
#else
    (void)ctx;
    return false;
#endif
}

void destroy_demag_poisson_hypre_workspace(Context &ctx)
{
#ifdef MFEM_USE_MPI
    delete static_cast<PoissonHypreWorkspace *>(ctx.mfem_poisson_hypre_workspace);
    ctx.mfem_poisson_hypre_workspace = nullptr;
    switch (ctx.demag_solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG:
        delete static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_solver);
        break;
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES:
        delete static_cast<mfem::HypreGMRES *>(ctx.mfem_cached_hypre_solver);
        break;
    default:
        break;
    }
    ctx.mfem_cached_hypre_solver = nullptr;
    switch (ctx.demag_solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG:
        delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        delete static_cast<mfem::HypreDiagScale *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        delete static_cast<mfem::HypreIdentity *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    default:
        break;
    }
    ctx.mfem_cached_hypre_preconditioner = nullptr;
    delete static_cast<mfem::HypreParMatrix *>(ctx.mfem_cached_hypre_par);
    ctx.mfem_cached_hypre_par = nullptr;
#else
    ctx.mfem_poisson_hypre_workspace = nullptr;
    ctx.mfem_cached_hypre_solver = nullptr;
    ctx.mfem_cached_hypre_preconditioner = nullptr;
    ctx.mfem_cached_hypre_par = nullptr;
#endif
    ctx.poisson_solver_setup = false;
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_apply_wall_time_ns = 0;
    ctx.poisson_last_solver_setup_reused = false;
}

bool solve_demag_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
#ifdef MFEM_USE_MPI
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_apply_wall_time_ns = 0;
    ctx.poisson_last_solver_setup_reused = ctx.poisson_solver_setup;
    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_bc == nullptr) {
        error = "Poisson BC-eliminated operator is null during Hypre solve";
        return false;
    }

    ensure_mpi_initialized();

    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};

    auto *poisson_hypre_workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.mfem_poisson_hypre_workspace);
    if (poisson_hypre_workspace == nullptr) {
        poisson_hypre_workspace =
            new PoissonHypreWorkspace(MPI_COMM_WORLD, glob_size, row_starts);
        ctx.mfem_poisson_hypre_workspace = poisson_hypre_workspace;
    }

    mfem::Vector &rhs_bc = poisson_hypre_workspace->rhs_bc;
    rhs_bc.SetSize(rhs.Size());
    rhs_bc = rhs;
    zero_poisson_essential_values(ctx, rhs_bc);

    if (!ctx.poisson_solver_setup) {
        const auto setup_wall_start = SteadyClock::now();
        auto *A_par = new mfem::HypreParMatrix(MPI_COMM_WORLD, glob_size, row_starts, A_bc);
        ctx.mfem_cached_hypre_par = A_par;

        mfem::HypreSolver *preconditioner = nullptr;
        switch (ctx.demag_solver.preconditioner) {
        case FULLMAG_FEM_PRECONDITIONER_AMG: {
            auto *amg = new mfem::HypreBoomerAMG(*A_par);
            amg->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
            amg->SetRelaxType(18);
            amg->SetCoarsening(8);
            amg->SetInterpolation(6);
            amg->SetAggressiveCoarsening(1);
            preconditioner = amg;
            break;
        }
        case FULLMAG_FEM_PRECONDITIONER_JACOBI:
            preconditioner = new mfem::HypreDiagScale(*A_par);
            break;
        case FULLMAG_FEM_PRECONDITIONER_NONE: {
            auto *identity = new mfem::HypreIdentity();
            identity->SetOperator(*A_par);
            preconditioner = identity;
            break;
        }
        default:
            error = "Unsupported native FEM demag preconditioner enum";
            delete A_par;
            ctx.mfem_cached_hypre_par = nullptr;
            return false;
        }
        ctx.mfem_cached_hypre_preconditioner = preconditioner;

        mfem::HypreSolver *solver = nullptr;
        switch (ctx.demag_solver.solver) {
        case FULLMAG_FEM_LINEAR_SOLVER_CG: {
            auto *pcg = new mfem::HyprePCG(MPI_COMM_WORLD);
            pcg->iterative_mode = true;
            pcg->SetTol(ctx.demag_solver.relative_tolerance);
            if (ctx.demag_solver.has_absolute_tolerance &&
                ctx.demag_solver.absolute_tolerance > 0.0) {
                pcg->SetAbsTol(ctx.demag_solver.absolute_tolerance);
            }
            pcg->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
            pcg->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
            pcg->SetOperator(*A_par);
            pcg->SetPreconditioner(*preconditioner);
            solver = pcg;
            break;
        }
        case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
            auto *gmres = new mfem::HypreGMRES(MPI_COMM_WORLD);
            gmres->iterative_mode = true;
            gmres->SetTol(ctx.demag_solver.relative_tolerance);
            if (ctx.demag_solver.has_absolute_tolerance &&
                ctx.demag_solver.absolute_tolerance > 0.0) {
                gmres->SetAbsTol(ctx.demag_solver.absolute_tolerance);
            }
            gmres->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
            gmres->SetKDim(50);
            gmres->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
            gmres->SetOperator(*A_par);
            gmres->SetPreconditioner(*preconditioner);
            solver = gmres;
            break;
        }
        default:
            error = "Unsupported native FEM demag linear solver enum";
            switch (ctx.demag_solver.preconditioner) {
            case FULLMAG_FEM_PRECONDITIONER_AMG:
                delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_JACOBI:
                delete static_cast<mfem::HypreDiagScale *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_NONE:
                delete static_cast<mfem::HypreIdentity *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            default:
                break;
            }
            ctx.mfem_cached_hypre_preconditioner = nullptr;
            delete A_par;
            ctx.mfem_cached_hypre_par = nullptr;
            return false;
        }
        ctx.mfem_cached_hypre_solver = solver;

        ctx.poisson_solver_setup = true;
        ctx.poisson_last_setup_wall_time_ns = elapsed_ns(setup_wall_start);
    }

    auto *solver = static_cast<mfem::HypreSolver *>(ctx.mfem_cached_hypre_solver);

    mfem::HypreParVector &b_par = poisson_hypre_workspace->b_par;
    mfem::HypreParVector &x_par = poisson_hypre_workspace->x_par;
    if (b_par.Size() != rhs_bc.Size() || x_par.Size() != solution.Size()) {
        error = "Hypre vector size mismatch during Poisson solve";
        return false;
    }
    const double *rhs_host = audited_host_read(rhs_bc);
    double *b_host = audited_host_write(b_par);
    for (int i = 0; i < rhs_bc.Size(); ++i) {
        b_host[i] = rhs_host[i];
    }
    if (!poisson_hypre_workspace->x_par_contains_solution) {
        const double *sol_host = audited_host_read(solution);
        double *x_host = audited_host_write(x_par);
        for (int i = 0; i < solution.Size(); ++i) {
            x_host[i] = sol_host[i];
        }
    }

    const auto solver_apply_wall_start = SteadyClock::now();
    solver->Mult(b_par, x_par);
    ctx.poisson_last_solver_apply_wall_time_ns = elapsed_ns(solver_apply_wall_start);

    const double *x_solved = audited_host_read(x_par);
    double *solution_host = audited_host_write(solution);
    for (int i = 0; i < solution.Size(); ++i) {
        solution_host[i] = x_solved[i];
    }
    poisson_hypre_workspace->x_par_contains_solution = true;

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    switch (ctx.demag_solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_solver);
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(final_residual);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(ctx.mfem_cached_hypre_solver);
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(final_residual);
        break;
    }
    default:
        iterations = 0;
        final_residual = 0.0;
        break;
    }
    ctx.poisson_last_iterations = iterations;
    ctx.poisson_last_residual = static_cast<double>(final_residual);

    zero_poisson_essential_values(ctx, solution);
    return true;
#else
    (void)ctx;
    (void)rhs;
    (void)solution;
    error =
        "Poisson demag requires an MPI/Hypre-enabled MFEM runtime; legacy CPU-native fallback solvers were removed";
    return false;
#endif
}

bool initialize_demag_poisson_recovery_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error)
{
    try {
        ctx.mfem_demag_recovery_workspace =
            new DemagRecoveryWorkspace(&fes);
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag recovery workspace initialization failed: ") +
                ex.what();
    } catch (...) {
        error = "Poisson demag recovery workspace initialization failed with an unknown error";
    }
    ctx.mfem_demag_recovery_workspace = nullptr;
    return false;
}

void destroy_demag_poisson_recovery_workspace(Context &ctx)
{
    delete static_cast<DemagRecoveryWorkspace *>(ctx.mfem_demag_recovery_workspace);
    ctx.mfem_demag_recovery_workspace = nullptr;
}

/// Recover H_demag = -grad(u) from the scalar potential solution.
/// Computes element-wise gradient, then distributes it to nodes with shape weights.
bool recover_demag_poisson_field(
    Context &ctx,
    const mfem::Vector &potential,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    const std::vector<double> &m_xyz,
    uint64_t *energy_wall_time_ns,
    std::string &error)
{
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "Poisson FE space or mesh is null during H_demag recovery";
        return false;
    }

    const size_t node_count = static_cast<size_t>(ctx.n_nodes);
    const size_t field_len = node_count * 3u;
    h_demag_xyz.assign(field_len, 0.0);

    auto accumulate_element = [&](int elem,
                                  std::vector<double> &field_accum,
                                  std::vector<double> &weight_accum,
                                  const mfem::GridFunction &gf_u,
                                  mfem::Array<int> &dofs,
                                  mfem::Vector &u_elem,
                                  mfem::DenseMatrix &dshape,
                                  mfem::Vector &shape) {
        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);

        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();
        u_elem.SetSize(local_ndof);
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            u_elem(i) = sign * gf_u(gdof);
        }

        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        shape.SetSize(local_ndof);
        dshape.SetSize(local_ndof, 3);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            fe->CalcPhysDShape(*T, dshape);

            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < local_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            fe->CalcShape(ip, shape);
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.n_nodes) {
                    continue;
                }
                const double phi_w = std::abs(shape(i)) * w;
                const size_t node = static_cast<size_t>(gdof);
                const size_t base = node * 3u;
                field_accum[base + 0] += -grad_u[0] * phi_w;
                field_accum[base + 1] += -grad_u[1] * phi_w;
                field_accum[base + 2] += -grad_u[2] * phi_w;
                weight_accum[node] += phi_w;
            }
        }
    };

    int recover_threads = 1;
#ifdef _OPENMP
    recover_threads = std::max(1, ctx.effective_omp_threads);
    const size_t bytes_per_thread =
        sizeof(double) * (field_len + node_count);
    constexpr size_t kMaxRecoverScratchBytes = 256ull * 1024ull * 1024ull;
    while (recover_threads > 1 &&
           bytes_per_thread * static_cast<size_t>(recover_threads) > kMaxRecoverScratchBytes) {
        recover_threads /= 2;
    }
#endif
    const bool parallel_recover = recover_threads > 1 && mesh->GetNE() >= 2000;

    auto *demag_recovery_workspace =
        static_cast<DemagRecoveryWorkspace *>(ctx.mfem_demag_recovery_workspace);
    if (demag_recovery_workspace == nullptr) {
        error = "Demag recovery workspace is null during H_demag recovery";
        return false;
    }
    demag_recovery_workspace->prepare(
        node_count,
        field_len,
        recover_threads,
        parallel_recover);
    mfem::GridFunction &gf_u = demag_recovery_workspace->potential;
    gf_u.SetFromTrueDofs(potential);
    std::vector<double> &node_weight = demag_recovery_workspace->node_weight;

    if (parallel_recover) {
#ifdef _OPENMP
        auto &field_partials = demag_recovery_workspace->field_partials;
        auto &weight_partials = demag_recovery_workspace->weight_partials;

#pragma omp parallel num_threads(recover_threads)
        {
            const int tid = omp_get_thread_num();
            auto &field_local = field_partials[static_cast<size_t>(tid)];
            auto &weight_local = weight_partials[static_cast<size_t>(tid)];
            auto &scratch =
                *demag_recovery_workspace->thread_scratch[static_cast<size_t>(tid)];

#pragma omp for schedule(static)
            for (int elem = 0; elem < mesh->GetNE(); ++elem) {
                accumulate_element(
                    elem,
                    field_local,
                    weight_local,
                    gf_u,
                    scratch.dofs,
                    scratch.u_elem,
                    scratch.dshape,
                    scratch.shape);
            }
        }

#pragma omp parallel for schedule(static) num_threads(recover_threads)
        for (int node = 0; node < static_cast<int>(node_count); ++node) {
            double weight_sum = 0.0;
            double hx = 0.0;
            double hy = 0.0;
            double hz = 0.0;
            const size_t base = static_cast<size_t>(node) * 3u;
            for (int tid = 0; tid < recover_threads; ++tid) {
                const auto &field_local = field_partials[static_cast<size_t>(tid)];
                const auto &weight_local = weight_partials[static_cast<size_t>(tid)];
                hx += field_local[base + 0];
                hy += field_local[base + 1];
                hz += field_local[base + 2];
                weight_sum += weight_local[static_cast<size_t>(node)];
            }
            node_weight[static_cast<size_t>(node)] = weight_sum;
            if (weight_sum > 0.0) {
                h_demag_xyz[base + 0] = hx / weight_sum;
                h_demag_xyz[base + 1] = hy / weight_sum;
                h_demag_xyz[base + 2] = hz / weight_sum;
            }
        }
#endif
    } else {
        auto &scratch = demag_recovery_workspace->serial_scratch;
        for (int elem = 0; elem < mesh->GetNE(); ++elem) {
            accumulate_element(
                elem,
                h_demag_xyz,
                node_weight,
                gf_u,
                scratch.dofs,
                scratch.u_elem,
                scratch.dshape,
                scratch.shape);
        }

#ifdef _OPENMP
#pragma omp parallel for schedule(static) if(recover_threads > 1 && static_cast<int>(node_count) >= 2048) num_threads(recover_threads)
#endif
        for (int node = 0; node < static_cast<int>(node_count); ++node) {
            const double weight = node_weight[static_cast<size_t>(node)];
            if (weight > 0.0) {
                const size_t base = static_cast<size_t>(node) * 3u;
                h_demag_xyz[base + 0] /= weight;
                h_demag_xyz[base + 1] /= weight;
                h_demag_xyz[base + 2] /= weight;
            }
        }
    }

    // Preserve full-domain H_demag for visualization before zeroing airbox.
    ctx.h_demag_visual_xyz = h_demag_xyz;

    zero_non_magnetic_nodes_aos(h_demag_xyz, ctx.magnetic_node_mask);

    if (ctx.mfem_lumped_mass.empty()) {
        error = "MFEM lumped mass is unavailable for Poisson demag energy evaluation";
        return false;
    }

    const auto energy_wall_start = SteadyClock::now();
    demag_energy = demag_poisson_energy_from_field(
        ctx,
        m_xyz,
        h_demag_xyz,
        recover_threads);

    // Robin BC correction: E_bdr = (mu0/2) * beta * integral_Gamma u^2 dS.
    ctx.cached_robin_boundary_energy = 0.0;
    if (ctx.demag_realization == 2 /* AIRBOX_ROBIN */ &&
        ctx.robin_effective_beta > 0.0 &&
        ctx.mfem_boundary_mass != nullptr) {
        auto *bdr_mass =
            static_cast<mfem::BilinearForm *>(ctx.mfem_boundary_mass);
        mfem::Vector &robin_boundary_tmp =
            demag_recovery_workspace->robin_boundary_tmp;
        robin_boundary_tmp.SetSize(gf_u.Size());
        bdr_mass->SpMat().Mult(gf_u, robin_boundary_tmp);
        ctx.cached_robin_boundary_energy =
            0.5 * kMu0 * ctx.robin_effective_beta * (gf_u * robin_boundary_tmp);
        demag_energy += ctx.cached_robin_boundary_energy;
    }
    if (energy_wall_time_ns != nullptr) {
        *energy_wall_time_ns += elapsed_ns(energy_wall_start);
    }

    return true;
}

bool context_initialize_poisson(Context &ctx, std::string &error)
{
    try {
        debug_checkpoint("context_initialize_poisson:enter");
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
        if (mesh == nullptr) {
            error = "MFEM mesh is null — cannot initialize Poisson demag";
            return false;
        }

        // S02: Scalar H1 FE space on the FULL mesh (magnetic + air).
        auto *potential_fec = new mfem::H1_FECollection(
            static_cast<int>(ctx.fe_order),
            mesh->Dimension());
        auto *potential_fes = new mfem::FiniteElementSpace(mesh, potential_fec);

        // S02: Poisson bilinear form: a(u,v) = integral grad(u).grad(v) dV.
        auto *poisson_bilinear = new mfem::BilinearForm(potential_fes);
        poisson_bilinear->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        poisson_bilinear->Assemble();
        poisson_bilinear->Finalize();

        auto *gf_potential = new mfem::GridFunction(potential_fes);
        gf_potential->UseDevice(true);
        *gf_potential = 0.0;

        ctx.mfem_potential_fec = potential_fec;
        ctx.mfem_potential_fes = potential_fes;
        ctx.mfem_poisson_bilinear = poisson_bilinear;
        ctx.mfem_gf_potential = gf_potential;

        if (!initialize_demag_poisson_boundary_operator(
                ctx,
                *mesh,
                *potential_fes,
                *poisson_bilinear,
                error)) {
            context_destroy_poisson(ctx);
            return false;
        }

        if (!initialize_demag_periodic_poisson_reduction(ctx, error)) {
            context_destroy_poisson(ctx);
            return false;
        }

        if (!initialize_demag_poisson_rhs_workspace(ctx, *potential_fes, error)) {
            context_destroy_poisson(ctx);
            return false;
        }
        ctx.mfem_poisson_solution_vec =
            new mfem::Vector(potential_fes->GetTrueVSize());
        if (!initialize_demag_poisson_recovery_workspace(
                ctx,
                *potential_fes,
                error)) {
            context_destroy_poisson(ctx);
            return false;
        }

        ctx.poisson_ready = true;
        debug_checkpoint("context_initialize_poisson:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson demag initialization failed with an unknown error";
    }
    context_destroy_poisson(ctx);
    return false;
}

void context_destroy_poisson(Context &ctx)
{
    // Cached Hypre solver objects must be deleted before the matrix they reference.
    destroy_demag_poisson_hypre_workspace(ctx);

    delete static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    ctx.mfem_poisson_bc_op = nullptr;
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_boundary_mass);
    ctx.mfem_boundary_mass = nullptr;
    destroy_demag_periodic_poisson_reduction(ctx);
    destroy_demag_poisson_rhs_workspace(ctx);
    delete static_cast<mfem::Vector *>(ctx.mfem_poisson_solution_vec);
    ctx.mfem_poisson_solution_vec = nullptr;
    destroy_demag_poisson_recovery_workspace(ctx);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_poisson_bilinear);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_potential_fec);
    ctx.mfem_gf_potential = nullptr;
    ctx.mfem_poisson_bilinear = nullptr;
    ctx.mfem_potential_fes = nullptr;
    ctx.mfem_potential_fec = nullptr;
    ctx.poisson_ess_tdof_list.clear();
    ctx.poisson_ready = false;
}

bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    if (!ctx.poisson_ready) {
        error = "Poisson demag requested before initialization";
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:enter");
    const uint64_t demag_call_index = ++ctx.demag_call_count;

    const auto assemble_wall_start = SteadyClock::now();
    mfem::Vector *rhs = nullptr;
    debug_checkpoint("context_compute_demag_poisson:assemble_rhs_enter");
    if (!assemble_demag_poisson_rhs(ctx, m_xyz, rhs, error)) {
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:assemble_rhs_done");
    if (rhs == nullptr) {
        error = "Poisson RHS assembly returned a null RHS vector";
        return false;
    }
    const uint64_t assemble_wall_time_ns = elapsed_ns(assemble_wall_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    if (ctx.demag_periodic_enabled() && ctx.poisson_periodic_reduced_ready) {
        mfem::Vector *full_solution = nullptr;
        uint64_t solve_wall_time_ns_pbc = 0;
        if (!solve_demag_periodic_poisson_reduced(
                ctx,
                *rhs,
                full_solution,
                solve_wall_time_ns_pbc,
                error)) {
            return false;
        }
        if (full_solution == nullptr) {
            error = "Periodic Poisson reduced solve returned a null lifted solution";
            return false;
        }

        debug_checkpoint("context_compute_demag_poisson:solve_done");
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }

        uint64_t energy_wall_time_ns_pbc = 0;
        const auto recover_wall_start_pbc = SteadyClock::now();
        debug_checkpoint("context_compute_demag_poisson:recover_enter");
        if (!recover_demag_poisson_field(
                ctx,
                *full_solution,
                h_demag_xyz,
                demag_energy,
                m_xyz,
                &energy_wall_time_ns_pbc,
                error)) {
            return false;
        }
        const uint64_t recover_total_wall_time_ns_pbc = elapsed_ns(recover_wall_start_pbc);
        const uint64_t recover_wall_time_ns_pbc =
            recover_total_wall_time_ns_pbc > energy_wall_time_ns_pbc
                ? recover_total_wall_time_ns_pbc - energy_wall_time_ns_pbc
                : 0;
        debug_checkpoint("context_compute_demag_poisson:recover_done");

        finalize_demag_poisson_recovered_field(ctx, h_demag_xyz);

        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }

        auto *gf_potential_pbc =
            static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
        gf_potential_pbc->SetFromTrueDofs(*full_solution);

        log_demag_poisson_call_profile(
            ctx,
            demag_call_index,
            assemble_wall_time_ns,
            solve_wall_time_ns_pbc,
            recover_wall_time_ns_pbc,
            energy_wall_time_ns_pbc);
        accumulate_demag_poisson_phase_timings(
            timings != nullptr ? &timings->demag : nullptr,
            assemble_wall_time_ns,
            solve_wall_time_ns_pbc,
            ctx.poisson_last_setup_wall_time_ns,
            ctx.poisson_last_solver_apply_wall_time_ns,
            ctx.poisson_last_solver_setup_reused,
            recover_wall_time_ns_pbc,
            energy_wall_time_ns_pbc);
        ctx.demag_solves_current_step += 1;
        return true;
    }

    auto *gf_potential = static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    auto *solution = static_cast<mfem::Vector *>(ctx.mfem_poisson_solution_vec);
    if (gf_potential == nullptr || fes == nullptr || solution == nullptr) {
        error = "Poisson solution workspace is null during non-PBC demag solve";
        return false;
    }
    solution->SetSize(fes->GetTrueVSize());
    if (!demag_poisson_hypre_has_warm_start(ctx)) {
        gf_potential->GetTrueDofs(*solution);
    }

    const auto solve_wall_start = SteadyClock::now();
    debug_checkpoint("context_compute_demag_poisson:solve_enter_hypre");
    if (!solve_demag_poisson_hypre(ctx, *rhs, *solution, error)) {
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:solve_done_hypre");
    const uint64_t solve_wall_time_ns = elapsed_ns(solve_wall_start);
    debug_checkpoint("context_compute_demag_poisson:solve_done");
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    uint64_t energy_wall_time_ns = 0;
    const auto recover_wall_start = SteadyClock::now();
    debug_checkpoint("context_compute_demag_poisson:recover_enter");
    if (!recover_demag_poisson_field(
            ctx,
            *solution,
            h_demag_xyz,
            demag_energy,
            m_xyz,
            &energy_wall_time_ns,
            error)) {
        return false;
    }
    const uint64_t recover_total_wall_time_ns = elapsed_ns(recover_wall_start);
    const uint64_t recover_wall_time_ns =
        recover_total_wall_time_ns > energy_wall_time_ns
            ? recover_total_wall_time_ns - energy_wall_time_ns
            : 0;
    debug_checkpoint("context_compute_demag_poisson:recover_done");
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    gf_potential->SetFromTrueDofs(*solution);
    log_demag_poisson_call_profile(
        ctx,
        demag_call_index,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        recover_wall_time_ns,
        energy_wall_time_ns);
    accumulate_demag_poisson_phase_timings(
        timings != nullptr ? &timings->demag : nullptr,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        ctx.poisson_last_setup_wall_time_ns,
        ctx.poisson_last_solver_apply_wall_time_ns,
        ctx.poisson_last_solver_setup_reused,
        recover_wall_time_ns,
        energy_wall_time_ns);
    ctx.demag_solves_current_step += 1;

    return true;
}
#endif

} // namespace fullmag::fem
