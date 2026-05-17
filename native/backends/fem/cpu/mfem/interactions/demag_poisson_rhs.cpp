#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"

#include "context.hpp"

#include <cstddef>
#include <stdexcept>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
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
#endif

} // namespace fullmag::fem
