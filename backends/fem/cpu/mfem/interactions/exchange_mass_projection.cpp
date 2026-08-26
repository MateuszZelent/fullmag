/*
 * Exchange mass-projection source contract.
 *
 * This source owns lumped, consistent, and periodic reduced-node mass
 * projection from exchange residuals into H_ex components, including Ms scaling
 * and interrupt polling. It does not assemble exchange operators or upload GPU state.
 */
#include "cpu/mfem/interactions/exchange_mass_projection.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "fem_common.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

namespace fullmag::fem {
#if FULLMAG_HAS_MFEM_STACK
namespace {

void copy_mfem_vector_to_host(const mfem::Vector &src, std::vector<double> &dst) {
    const int n = src.Size();
    dst.resize(static_cast<size_t>(n));
    const double *host = audited_host_read(src);
    for (int i = 0; i < n; ++i) {
        dst[static_cast<size_t>(i)] = host[i];
    }
}

bool apply_periodic_consistent_mass_component(
    Context &ctx,
    const mfem::Vector &rhs_full,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host)
{
    const int ndofs = rhs_full.Size();
    const uint32_t n_reduced = ctx.mesh.periodic_reduced_node_count;
    auto *reduced_matrix = static_cast<mfem::SparseMatrix *>(
        ctx.exchange.mfem.periodic_mass_matrix);
    auto *reduced_solver = static_cast<mfem::CGSolver *>(
        ctx.exchange.mfem.periodic_mass_solver);
    auto *reduced_rhs = static_cast<mfem::Vector *>(
        ctx.exchange.mfem.periodic_mass_rhs);
    auto *reduced_solution = static_cast<mfem::Vector *>(
        ctx.exchange.mfem.periodic_mass_solution);
    auto *reduced_residual = static_cast<mfem::Vector *>(
        ctx.exchange.mfem.periodic_mass_residual);
    if (n_reduced == 0 || ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(ndofs) ||
        reduced_matrix == nullptr || reduced_solver == nullptr || reduced_rhs == nullptr ||
        reduced_solution == nullptr || reduced_residual == nullptr ||
        reduced_matrix->Height() != static_cast<int>(n_reduced) ||
        reduced_matrix->Width() != static_cast<int>(n_reduced) ||
        reduced_rhs->Size() != static_cast<int>(n_reduced) ||
        reduced_solution->Size() != static_cast<int>(n_reduced) ||
        reduced_residual->Size() != static_cast<int>(n_reduced)) {
        return false;
    }

    *reduced_rhs = 0.0;
    double *rhs_reduced_host = audited_host_write(*reduced_rhs);
    const double *rhs_host = audited_host_read(rhs_full);
    for (int i = 0; i < ndofs; ++i) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)];
        if (reduced >= n_reduced) {
            return false;
        }
        rhs_reduced_host[static_cast<size_t>(reduced)] += rhs_host[i];
    }

    const double rhs_norm = reduced_rhs->Norml2();
    *reduced_solution = 0.0;
    if (rhs_norm <= 1e-30) {
        h_component = 0.0;
        copy_mfem_vector_to_host(h_component, h_component_host);
        return true;
    }

    reduced_solver->Mult(*reduced_rhs, *reduced_solution);
    reduced_matrix->Mult(*reduced_solution, *reduced_residual);
    *reduced_residual -= *reduced_rhs;
    const double absolute_residual = reduced_residual->Norml2();
    const double residual_limit = std::max(1e-20, 1e-10 * rhs_norm);
    if (!reduced_solver->GetConverged() || !std::isfinite(absolute_residual) ||
        absolute_residual > residual_limit ||
        !std::isfinite(reduced_solution->Norml2())) {
        return false;
    }

    ++ctx.exchange.mfem.periodic_mass_solver_applies;
    const double *solution_host = audited_host_read(*reduced_solution);
    double *h_host = audited_host_write(h_component);
    for (int i = 0; i < ndofs; ++i) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)];
        if (reduced >= n_reduced) {
            return false;
        }
        h_host[i] = -(2.0 / kMu0) * solution_host[static_cast<size_t>(reduced)];
    }
    copy_mfem_vector_to_host(h_component, h_component_host);
    return true;
}

} // namespace

void prepare_exchange_mass_lumping(
    mfem::BilinearForm &mass_form,
    mfem::Vector &ones,
    mfem::Vector &lumped,
    mfem::Vector &inv_lumped,
    std::vector<double> &host_lumped,
    bool use_device)
{
    const int ndofs = mass_form.FESpace()->GetNDofs();
    ones.SetSize(ndofs);
    lumped.SetSize(ndofs);
    inv_lumped.SetSize(ndofs);
    ones.UseDevice(use_device);
    lumped.UseDevice(use_device);
    inv_lumped.UseDevice(use_device);
    ones = 1.0;
    mass_form.Mult(ones, lumped);
    const double *lumped_host = audited_host_read(lumped);
    double *inv_host = audited_host_write(inv_lumped);
    for (int i = 0; i < ndofs; ++i) {
        const double mass = lumped_host[i];
        inv_host[i] = mass > 0.0 ? 1.0 / mass : 0.0;
    }
    copy_mfem_vector_to_host(lumped, host_lumped);
}

bool apply_exchange_component_mass_projection(
    Context *ctx,
    bool allow_interrupt,
    mfem::BilinearForm &exchange_form,
    mfem::GridFunction &m_component,
    mfem::GridFunction &ms_field,
    mfem::Vector &inv_lumped_mass,
    mfem::BilinearForm &mass_form,
    bool use_consistent_mass,
    mfem::Vector &tmp,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host,
    double *energy_out)
{
    exchange_form.Mult(m_component, tmp);
    if (allow_interrupt && ctx != nullptr && poll_interrupt(*ctx)) {
        return false;
    }

    const int ndofs = tmp.Size();
    if (ctx != nullptr && !ctx->mesh.periodic_reduced_node.empty()) {
        if (ctx->integration_weights.mfem_lumped_mass.size() != static_cast<size_t>(ndofs)) {
            return false;
        }
        if (ctx->exchange.mfem.use_consistent_mass) {
            if (energy_out != nullptr) {
                *energy_out = m_component * tmp;
            }
            return apply_periodic_consistent_mass_component(
                *ctx,
                tmp,
                h_component,
                h_component_host);
        }
        const uint32_t n_reduced = ctx->mesh.periodic_reduced_node_count;
        std::vector<double> reduced_tmp(static_cast<size_t>(n_reduced), 0.0);
        std::vector<double> reduced_mass(static_cast<size_t>(n_reduced), 0.0);
        const double *tmp_host = audited_host_read(tmp);
        for (int i = 0; i < ndofs; ++i) {
            const uint32_t reduced =
                ctx->mesh.periodic_reduced_node[static_cast<size_t>(i)];
            reduced_tmp[static_cast<size_t>(reduced)] += tmp_host[i];
            reduced_mass[static_cast<size_t>(reduced)] +=
                ctx->integration_weights.mfem_lumped_mass[static_cast<size_t>(i)];
        }

        std::vector<double> reduced_ms(
            static_cast<size_t>(n_reduced),
            ctx->material_fields.material.saturation_magnetisation);
        for (uint32_t reduced = 0; reduced < n_reduced; ++reduced) {
            const uint32_t representative =
                ctx->mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
            reduced_ms[static_cast<size_t>(reduced)] = scalar_field_value(
                ctx->material_fields.Ms_field,
                static_cast<size_t>(representative),
                ctx->material_fields.material.saturation_magnetisation);
        }
        double *h_host = audited_host_write(h_component);
        for (int i = 0; i < ndofs; ++i) {
            const uint32_t reduced =
                ctx->mesh.periodic_reduced_node[static_cast<size_t>(i)];
            const double mass = reduced_mass[static_cast<size_t>(reduced)];
            const double Ms = reduced_ms[static_cast<size_t>(reduced)];
            if (mass <= 0.0 || Ms <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms)) *
                    reduced_tmp[static_cast<size_t>(reduced)] / mass;
            }
        }
        if (energy_out != nullptr) {
            *energy_out = m_component * tmp;
        }
        copy_mfem_vector_to_host(h_component, h_component_host);
        return true;
    }

    if (use_consistent_mass) {
        std::unique_ptr<mfem::CGSolver> local_solver;
        std::unique_ptr<mfem::GSSmoother> local_preconditioner;
        mfem::CGSolver *cg_solver = nullptr;
        if (ctx != nullptr) {
            cg_solver = ctx->exchange.mfem.consistent_mass_solver;
            if (ctx->exchange.mfem.consistent_mass_matrix == nullptr ||
                cg_solver == nullptr ||
                ctx->exchange.mfem.consistent_mass_preconditioner == nullptr) {
                return false;
            }
        } else {
            local_preconditioner = std::make_unique<mfem::GSSmoother>(mass_form.SpMat());
            local_solver = std::make_unique<mfem::CGSolver>();
            local_solver->SetRelTol(1e-10);
            local_solver->SetAbsTol(0.0);
            local_solver->SetMaxIter(200);
            local_solver->SetPrintLevel(0);
            local_solver->SetPreconditioner(*local_preconditioner);
            local_solver->SetOperator(mass_form.SpMat());
            cg_solver = local_solver.get();
        }
        h_component = 0.0;
        cg_solver->Mult(tmp, h_component);
        if (!cg_solver->GetConverged() || !std::isfinite(h_component.Norml2())) {
            return false;
        }
        if (ctx != nullptr) {
            ++ctx->exchange.mfem.consistent_mass_solver_applies;
        }
        h_component *= -(2.0 / kMu0);
    } else {
        const double *tmp_host = audited_host_read(tmp);
        const double *inv_mass_host = audited_host_read(inv_lumped_mass);
        const double *ms_host = audited_host_read(ms_field);
        double *h_host = audited_host_write(h_component);
        for (int i = 0; i < ndofs; ++i) {
            const double inv_mass = inv_mass_host[i];
            const double Ms_i = ms_host[i];
            if (inv_mass <= 0.0 || Ms_i <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms_i)) * tmp_host[i] * inv_mass;
            }
        }
    }
    if (energy_out != nullptr) {
        *energy_out = m_component * tmp;
    }
    copy_mfem_vector_to_host(h_component, h_component_host);
    return true;
}
#endif

} // namespace fullmag::fem
