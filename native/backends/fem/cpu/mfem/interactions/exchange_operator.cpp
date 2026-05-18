/*
 * Exchange operator source contract.
 *
 * This source owns MFEM exchange and mass bilinear-form assembly, magnetic
 * attribute selection, lumped-mass setup, and legacy sparse metadata. It does not compute H_ex, project mass, refresh runtime fields, or upload GPU state.
 */
#include "cpu/mfem/interactions/exchange_operator.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/exchange_mass_projection.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <memory>
#include <string>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool initialize_exchange_operator_mfem(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::GridFunctionCoefficient &a_coeff,
    std::string &error)
{
    auto exchange_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto mass_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto mass_ones = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto mass_lumped = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto inv_lumped_mass = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto exchange_tmp_vec = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto exchange_out_vec = std::make_unique<mfem::Vector>(fes.GetNDofs());
    mass_ones->UseDevice(true);
    mass_lumped->UseDevice(true);
    inv_lumped_mass->UseDevice(true);
    exchange_tmp_vec->UseDevice(true);
    exchange_out_vec->UseDevice(true);

    const int max_attr = mesh.attributes.Max();
    mfem::Array<int> magnetic_attr_marker(max_attr);
    magnetic_attr_marker = 0;
    for (int e = 0; e < mesh.GetNE(); ++e) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            static_cast<size_t>(e) < ctx.mesh.magnetic_element_mask.size() &&
            ctx.mesh.magnetic_element_mask[e] == 0u) {
            continue;
        }
        const int attr = mesh.GetAttribute(e);
        if (attr >= 1 && attr <= max_attr) {
            magnetic_attr_marker[attr - 1] = 1;
        }
    }

    int n_active_attrs = 0;
    for (int a = 0; a < max_attr; ++a) {
        n_active_attrs += magnetic_attr_marker[a];
    }
    if (ctx.enable_exchange && n_active_attrs == 0) {
        error = "F-01 validation: enable_exchange=true but no MFEM "
                "attributes are marked as magnetic — exchange/mass "
                "assembly would be empty.  Check element_markers.";
        return false;
    }

    // Partial assembly is the intended end state, but MFEM 4.7 tetrahedral H1
    // can abort in `GetDofToQuad(..., DofToQuad::FULL)` before startup. Use the
    // assembled operator path so FEM can execute through device-backed SpMV.
    exchange_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    exchange_form->AddDomainIntegrator(
        new mfem::DiffusionIntegrator(a_coeff),
        magnetic_attr_marker);
    exchange_form->Assemble();
    exchange_form->Finalize();

    const auto &exchange_spmat = exchange_form->SpMat();
    ctx.gpu_exchange.legacy_sparse_metadata_ready = true;
    ctx.gpu_exchange.legacy_sparse_rows =
        static_cast<uint64_t>(std::max(0, exchange_spmat.Height()));
    ctx.gpu_exchange.legacy_sparse_cols =
        static_cast<uint64_t>(std::max(0, exchange_spmat.Width()));
    ctx.gpu_exchange.legacy_sparse_nnz =
        static_cast<uint64_t>(std::max(0, exchange_spmat.NumNonZeroElems()));

    mass_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    mass_form->AddDomainIntegrator(
        new mfem::MassIntegrator(),
        magnetic_attr_marker);
    mass_form->Assemble();
    mass_form->Finalize();
    prepare_exchange_mass_lumping(
        *mass_form,
        *mass_ones,
        *mass_lumped,
        *inv_lumped_mass,
        ctx.integration_weights.mfem_lumped_mass);
    ctx.gpu_exchange.lumped_mass_ready =
        ctx.integration_weights.mfem_lumped_mass.size() == static_cast<size_t>(fes.GetNDofs());

    const bool has_nonzero_lumped_mass = std::any_of(
        ctx.integration_weights.mfem_lumped_mass.begin(),
        ctx.integration_weights.mfem_lumped_mass.end(),
        [](double value) { return value > 0.0; });
    if (ctx.enable_exchange && !has_nonzero_lumped_mass) {
        error = "F-01 validation: enable_exchange=true but MFEM lumped "
                "mass is zero on every node in the resolved magnetic "
                "domain.  Check element_markers and magnetic region "
                "resolution.";
        return false;
    }

    ctx.exchange.mfem.exchange_form = exchange_form.release();
    ctx.exchange.mfem.mass_form = mass_form.release();
    ctx.exchange.mfem.mass_ones = mass_ones.release();
    ctx.exchange.mfem.mass_lumped = mass_lumped.release();
    ctx.exchange.mfem.inv_lumped_mass = inv_lumped_mass.release();
    ctx.exchange.mfem.tmp_vec = exchange_tmp_vec.release();
    ctx.exchange.mfem.out_vec = exchange_out_vec.release();
    return true;
}
#endif

} // namespace fullmag::fem
