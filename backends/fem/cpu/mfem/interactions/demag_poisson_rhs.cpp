/*
 * Poisson demag RHS assembly source contract.
 *
 * This source owns M_s m vector-coefficient evaluation and RHS assembly workspace
 * for the scalar potential equation. It does not configure boundary operators, solve Poisson, recover H_demag, compute energy, or manage cache.
 */

#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"

#include "context.hpp"
#include "core/fem_material_runtime.hpp"
#include "fem_common.hpp"
#include "cpu/mfem/interactions/demag_poisson_transfer.hpp"

#include <cstddef>
#include <stdexcept>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
uint64_t cpu_transfer_live_matrix_count_for_tests() noexcept
{
    return cpu_transfer_live_matrices.load(std::memory_order_relaxed);
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
        mfem::FiniteElementSpace *source_fes_ref)
        : mfem::VectorCoefficient(3)
        , ctx_(ctx_ref)
        , source_fes_(source_fes_ref)
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
            !ctx_.mesh.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem_no) < ctx_.mesh.magnetic_element_mask.size() &&
            ctx_.mesh.magnetic_element_mask[static_cast<size_t>(elem_no)] == 0u) {
            V = 0.0;
            return;
        }

        thread_local EvalScratch scratch;
        mfem::Array<int> &dofs = scratch.dofs;
        source_fes_->GetElementDofs(elem_no, dofs);
        const int ndof = dofs.Size();

        const mfem::FiniteElement *fe = source_fes_->GetFE(elem_no);
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

        double Ms = ctx_.material_fields.material.saturation_magnetisation;
        const auto *runtime = ctx_.material_fields.runtime
            ? &*ctx_.material_fields.runtime
            : nullptr;
        if (runtime != nullptr && runtime->has_elementwise_ms()) {
            if (elem_no < 0 || static_cast<size_t>(elem_no) >= ctx_.mesh.n_elements ||
                (!ctx_.mesh.magnetic_element_mask.empty() &&
                 ctx_.mesh.magnetic_element_mask[static_cast<size_t>(elem_no)] == 0u)) {
                V = 0.0;
                return;
            }
            Ms = runtime->realization().ms_a_per_m(static_cast<size_t>(elem_no));
        } else if (!ctx_.material_fields.Ms_field.empty()) {
            Ms = 0.0;
            for (int i = 0; i < ndof; ++i) {
                const int global_dof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                Ms += shape(i) *
                    scalar_field_value(
                        ctx_.material_fields.Ms_field,
                        static_cast<size_t>(global_dof),
                        ctx_.material_fields.material.saturation_magnetisation);
            }
        }
        V(0) = Ms * mx;
        V(1) = Ms * my;
        V(2) = Ms * mz;
    }

private:
    const Context &ctx_;
    const std::vector<double> *m_xyz_ = nullptr;
    mfem::FiniteElementSpace *source_fes_;
};

struct PoissonRhsWorkspace {
    PoissonRhsWorkspace(
        Context &ctx,
        mfem::FiniteElementSpace *potential_fes,
        mfem::FiniteElementSpace *source_fes)
        : fes(potential_fes)
        , m_coeff(ctx, source_fes)
        , rhs_form(potential_fes)
        , rhs_true(potential_fes->GetTrueVSize())
    {
        rhs_form.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(m_coeff));
    }

    mfem::FiniteElementSpace *fes = nullptr;
    MagnetizationCoefficient m_coeff;
    mfem::LinearForm rhs_form;
    mfem::Vector rhs_true;
    std::array<std::unique_ptr<mfem::SparseMatrix>, 3> transfer;
    std::unique_ptr<mfem::Vector> component;
    std::unique_ptr<mfem::Vector> product;
};

static void build_rhs_transfer(Context &ctx, PoissonRhsWorkspace &workspace,
                               mfem::FiniteElementSpace &source_fes)
{
    auto &potential_fes = *workspace.fes;
    auto &diagnostics = ctx.poisson_demag.rhs_transfer;
    cpu_transfer_begin(ctx, source_fes, potential_fes, diagnostics);
    auto *mesh = potential_fes.GetMesh();
    if (!ctx.mesh.magnetic_element_mask.empty() &&
        ctx.mesh.magnetic_element_mask.size() != static_cast<size_t>(mesh->GetNE())) {
        throw CpuTransferUnavailable("partial magnetic-element mask uses quadrature");
    }
    if (ctx.material_fields.runtime && ctx.material_fields.runtime->has_elementwise_ms() &&
        ctx.mesh.n_elements != static_cast<uint64_t>(mesh->GetNE())) {
        throw CpuTransferUnavailable("material element extent uses quadrature");
    }
    const uint64_t scratch_bytes = (static_cast<uint64_t>(source_fes.GetNDofs()) +
        static_cast<uint64_t>(potential_fes.GetNDofs())) * sizeof(double);
    cpu_transfer_check_budget(ctx, diagnostics, 0, scratch_bytes);
    uint64_t pairs = 0;
    for (int element = 0; element < mesh->GetNE(); ++element) {
        pairs += static_cast<uint64_t>(source_fes.GetFE(element)->GetDof()) *
            potential_fes.GetFE(element)->GetDof();
    }
    std::array<std::unique_ptr<mfem::SparseMatrix>, 3> staged;
    uint64_t bytes = 0, nnz = 0;
    for (int component = 0; component < 3; ++component) {
        cpu_transfer_check_matrix_bound(ctx, diagnostics, bytes, scratch_bytes, pairs,
                                        potential_fes.GetNDofs());
        auto matrix = std::make_unique<CpuTransferMatrix>(
            potential_fes.GetNDofs(), source_fes.GetNDofs());
        mfem::Array<int> source_dofs, potential_dofs;
        mfem::Vector shape;
        mfem::DenseMatrix dshape;
        for (int element = 0; element < mesh->GetNE(); ++element) {
            if ((element & 255) == 0) cpu_transfer_check_budget(ctx, diagnostics, bytes, scratch_bytes);
            if (!ctx.mesh.magnetic_element_mask.empty() &&
                ctx.mesh.magnetic_element_mask[static_cast<size_t>(element)] == 0u) continue;
            cpu_transfer_element_dofs(source_fes, element, source_dofs);
            cpu_transfer_element_dofs(potential_fes, element, potential_dofs);
            const auto *source_fe = source_fes.GetFE(element);
            const auto *potential_fe = potential_fes.GetFE(element);
            auto *transformation = mesh->GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(potential_fe->GetGeomType(),
                                                 2 * potential_fe->GetOrder());
            shape.SetSize(source_dofs.Size());
            dshape.SetSize(potential_dofs.Size(), 3);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &point = rule.IntPoint(q);
                transformation->SetIntPoint(&point);
                source_fe->CalcShape(point, shape);
                potential_fe->CalcPhysDShape(*transformation, dshape);
                double ms = ctx.material_fields.material.saturation_magnetisation;
                const auto *runtime = ctx.material_fields.runtime ? &*ctx.material_fields.runtime : nullptr;
                if (runtime != nullptr && runtime->has_elementwise_ms()) {
                    ms = runtime->realization().ms_a_per_m(static_cast<size_t>(element));
                } else if (!ctx.material_fields.Ms_field.empty()) {
                    ms = 0.0;
                    for (int j = 0; j < source_dofs.Size(); ++j) {
                        ms += shape(j) * scalar_field_value(ctx.material_fields.Ms_field,
                            static_cast<size_t>(transfer_dof_index(source_dofs[j])),
                            ctx.material_fields.material.saturation_magnetisation);
                    }
                }
                const double weight = point.weight * transformation->Weight() * ms;
                for (int i = 0; i < potential_dofs.Size(); ++i) {
                    for (int j = 0; j < source_dofs.Size(); ++j) {
                        cpu_transfer_add(*matrix, transfer_dof_index(potential_dofs[i]),
                            transfer_dof_index(source_dofs[j]), weight * shape(j) *
                            dshape(i, component) * transfer_dof_sign(potential_dofs[i]) *
                            transfer_dof_sign(source_dofs[j]));
                    }
                }
            }
        }
        cpu_transfer_finalize(*matrix);
        bytes += cpu_transfer_matrix_bytes(*matrix);
        nnz += static_cast<uint64_t>(matrix->NumNonZeroElems());
        staged[component] = std::move(matrix);
        cpu_transfer_check_budget(ctx, diagnostics, bytes, scratch_bytes);
        cpu_transfer_setup_checkpoint(ctx, static_cast<uint32_t>(component + 1));
    }
    auto component = std::make_unique<mfem::Vector>(source_fes.GetNDofs());
    auto product = std::make_unique<mfem::Vector>(potential_fes.GetNDofs());
    cpu_transfer_check_budget(ctx, diagnostics, bytes, scratch_bytes);
    workspace.component = std::move(component);
    workspace.product = std::move(product);
    workspace.transfer = std::move(staged);
    diagnostics.persistent_bytes = bytes + scratch_bytes;
    diagnostics.nnz = nnz;
    diagnostics.state = "ready";
    ++diagnostics.build_count;
}



bool initialize_demag_poisson_rhs_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error)
{
    try {
        auto *source_fes = static_cast<mfem::FiniteElementSpace *>(
            ctx.mfem_context.fes);
        if (source_fes == nullptr) {
            error = "Poisson RHS requires the base magnetization FE space";
            return false;
        }
        auto *rhs_workspace = new PoissonRhsWorkspace(ctx, &fes, source_fes);
        ctx.poisson_demag.rhs_workspace = rhs_workspace;
        ctx.poisson_demag.rhs_form = &rhs_workspace->rhs_form;
        ctx.poisson_demag.rhs_vec = &rhs_workspace->rhs_true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson RHS workspace initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson RHS workspace initialization failed with an unknown error";
    }
    ctx.poisson_demag.rhs_workspace = nullptr;
    ctx.poisson_demag.rhs_form = nullptr;
    ctx.poisson_demag.rhs_vec = nullptr;
    ctx.poisson_demag.rhs_transfer = {};
    return false;
}

void destroy_demag_poisson_rhs_workspace(Context &ctx)
{
    delete static_cast<PoissonRhsWorkspace *>(ctx.poisson_demag.rhs_workspace);
    ctx.poisson_demag.rhs_workspace = nullptr;
    ctx.poisson_demag.rhs_form = nullptr;
    ctx.poisson_demag.rhs_vec = nullptr;
    ctx.poisson_demag.rhs_transfer = {};
}

static bool assemble_demag_poisson_rhs_impl(
    Context &ctx,
    const std::vector<double> &m_xyz,
    mfem::Vector *&rhs,
    std::string &error,
    bool use_fixed_transfer)
{
    auto *workspace =
        static_cast<PoissonRhsWorkspace *>(ctx.poisson_demag.rhs_workspace);
    if (workspace == nullptr || workspace->fes == nullptr) {
        error = "Poisson FE space is null during RHS assembly";
        return false;
    }

    if (workspace == nullptr ||
        ctx.poisson_demag.rhs_form == nullptr ||
        ctx.poisson_demag.rhs_vec == nullptr) {
        error = "Poisson RHS workspace is null during RHS assembly";
        return false;
    }

    mfem::FiniteElementSpace *fes = workspace->fes;
    auto *source_fes = static_cast<mfem::FiniteElementSpace *>(
        ctx.mfem_context.fes);
    if (source_fes == nullptr ||
        m_xyz.size() != 3u * static_cast<size_t>(source_fes->GetNDofs())) {
        error = "Poisson RHS magnetization extent does not match the base P1 state space";
        return false;
    }
    mfem::LinearForm &b = workspace->rhs_form;
    mfem::Vector &rhs_true = workspace->rhs_true;
    auto &diagnostics = ctx.poisson_demag.rhs_transfer;
    if (use_fixed_transfer && diagnostics.state == "not-built") {
        const auto started = FemSteadyClock::now();
        try {
            build_rhs_transfer(ctx, *workspace, *source_fes);
        } catch (const CpuTransferUnavailable &refusal) {
            cpu_transfer_refused(ctx, diagnostics, refusal.what());
        } catch (const std::bad_alloc &) {
            cpu_transfer_refused(ctx, diagnostics, "cache allocation refused");
        } catch (const std::exception &failure) {
            error = failure.what();
            return false;
        }
        diagnostics.setup_wall_time_ns = elapsed_ns(started);
        cpu_transfer_note("rhs", diagnostics);
    }
    b = 0.0;
    if (use_fixed_transfer && diagnostics.state == "ready") {
        for (int component = 0; component < 3; ++component) {
            for (int node = 0; node < source_fes->GetNDofs(); ++node) {
                (*workspace->component)[node] = m_xyz[3u * static_cast<size_t>(node) + component];
            }
            workspace->transfer[component]->Mult(*workspace->component, *workspace->product);
            b += *workspace->product;
        }
        cpu_transfer_reused("rhs", diagnostics);
    } else {
        workspace->m_coeff.SetMagnetization(m_xyz);
        b.Assemble();
        workspace->m_coeff.ClearMagnetization();
    }

    rhs_true.SetSize(fes->GetTrueVSize());
    if (const mfem::SparseMatrix *restriction = fes->GetRestrictionMatrix()) {
        restriction->Mult(b, rhs_true);
    } else {
        rhs_true = b;
    }
    rhs = &rhs_true;
    return true;
}

bool assemble_demag_poisson_rhs(Context &ctx, const std::vector<double> &m_xyz,
                               mfem::Vector *&rhs, std::string &error)
{
    return assemble_demag_poisson_rhs_impl(ctx, m_xyz, rhs, error, true);
}

bool assemble_demag_poisson_rhs_quadrature(Context &ctx, const std::vector<double> &m_xyz,
                                          mfem::Vector *&rhs, std::string &error)
{
    return assemble_demag_poisson_rhs_impl(ctx, m_xyz, rhs, error, false);
}
#endif

} // namespace fullmag::fem
