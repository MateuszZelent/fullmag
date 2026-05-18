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
#include "fem_common.hpp"
#include "transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace fullmag::fem {
#if FULLMAG_HAS_MFEM_STACK
namespace {

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

double *audited_host_read_write(mfem::Vector &vector) {
    record_mfem_host_read_write(vector_bytes(vector));
    return vector.HostReadWrite();
}

void copy_mfem_vector_to_host(const mfem::Vector &src, std::vector<double> &dst) {
    const int n = src.Size();
    dst.resize(static_cast<size_t>(n));
    const double *host = audited_host_read(src);
    for (int i = 0; i < n; ++i) {
        dst[static_cast<size_t>(i)] = host[i];
    }
}

double dot_host_vectors(const std::vector<double> &a, const std::vector<double> &b) {
    double value = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        value += a[i] * b[i];
    }
    return value;
}

bool apply_periodic_consistent_mass_component(
    const Context &ctx,
    mfem::BilinearForm &mass_form,
    const mfem::Vector &rhs_full,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host)
{
    const int ndofs = rhs_full.Size();
    const uint32_t n_reduced = ctx.mesh.periodic_reduced_node_count;
    if (n_reduced == 0 || ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(ndofs)) {
        return false;
    }

    std::vector<double> rhs_reduced(static_cast<size_t>(n_reduced), 0.0);
    const double *rhs_host = audited_host_read(rhs_full);
    for (int i = 0; i < ndofs; ++i) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)];
        rhs_reduced[static_cast<size_t>(reduced)] += rhs_host[i];
    }

    auto multiply_reduced_mass =
        [&](const std::vector<double> &x_reduced, std::vector<double> &out_reduced) {
            mfem::Vector full_x(ndofs);
            mfem::Vector full_y(ndofs);
            full_x.UseDevice(true);
            full_y.UseDevice(true);
            double *x_host = audited_host_write(full_x);
            for (int i = 0; i < ndofs; ++i) {
                const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)];
                x_host[i] = x_reduced[static_cast<size_t>(reduced)];
            }

            mass_form.Mult(full_x, full_y);
            out_reduced.assign(static_cast<size_t>(n_reduced), 0.0);
            const double *y_host = audited_host_read(full_y);
            for (int i = 0; i < ndofs; ++i) {
                const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)];
                out_reduced[static_cast<size_t>(reduced)] += y_host[i];
            }
        };

    std::vector<double> solution(static_cast<size_t>(n_reduced), 0.0);
    std::vector<double> residual = rhs_reduced;
    std::vector<double> direction = residual;
    std::vector<double> operator_direction;
    double residual_norm_sq = dot_host_vectors(residual, residual);
    const double rhs_norm = std::sqrt(residual_norm_sq);
    if (rhs_norm <= 1e-30) {
        h_component = 0.0;
        copy_mfem_vector_to_host(h_component, h_component_host);
        return true;
    }
    const double tolerance_sq = std::pow(std::max(1e-20, 1e-10 * rhs_norm), 2.0);
    const int max_iter = std::max(200, static_cast<int>(n_reduced) * 10);
    for (int iter = 0; iter < max_iter && residual_norm_sq > tolerance_sq; ++iter) {
        multiply_reduced_mass(direction, operator_direction);
        const double denom = dot_host_vectors(direction, operator_direction);
        if (!std::isfinite(denom) || denom <= 0.0) {
            return false;
        }
        const double alpha = residual_norm_sq / denom;
        for (uint32_t i = 0; i < n_reduced; ++i) {
            solution[static_cast<size_t>(i)] += alpha * direction[static_cast<size_t>(i)];
            residual[static_cast<size_t>(i)] -= alpha * operator_direction[static_cast<size_t>(i)];
        }
        const double next_residual_norm_sq = dot_host_vectors(residual, residual);
        if (!std::isfinite(next_residual_norm_sq)) {
            return false;
        }
        if (next_residual_norm_sq <= tolerance_sq) {
            residual_norm_sq = next_residual_norm_sq;
            break;
        }
        const double beta = next_residual_norm_sq / residual_norm_sq;
        for (uint32_t i = 0; i < n_reduced; ++i) {
            direction[static_cast<size_t>(i)] =
                residual[static_cast<size_t>(i)] + beta * direction[static_cast<size_t>(i)];
        }
        residual_norm_sq = next_residual_norm_sq;
    }
    if (residual_norm_sq > tolerance_sq) {
        return false;
    }

    std::vector<double> reduced_ms(static_cast<size_t>(n_reduced), ctx.material.saturation_magnetisation);
    for (uint32_t reduced = 0; reduced < n_reduced; ++reduced) {
        const uint32_t representative = ctx.mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
        reduced_ms[static_cast<size_t>(reduced)] = scalar_field_value(
            ctx.material_fields.Ms_field,
            static_cast<size_t>(representative),
            ctx.material.saturation_magnetisation);
    }
    double *h_host = audited_host_write(h_component);
    for (int i = 0; i < ndofs; ++i) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)];
        const double Ms = reduced_ms[static_cast<size_t>(reduced)];
        if (Ms <= 0.0) {
            h_host[i] = 0.0;
        } else {
            h_host[i] = -(2.0 / (kMu0 * Ms)) * solution[static_cast<size_t>(reduced)];
        }
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
    std::vector<double> &host_lumped)
{
    const int ndofs = mass_form.FESpace()->GetNDofs();
    ones.SetSize(ndofs);
    lumped.SetSize(ndofs);
    inv_lumped.SetSize(ndofs);
    ones.UseDevice(true);
    lumped.UseDevice(true);
    inv_lumped.UseDevice(true);
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
                mass_form,
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
            ctx->material.saturation_magnetisation);
        for (uint32_t reduced = 0; reduced < n_reduced; ++reduced) {
            const uint32_t representative =
                ctx->mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
            reduced_ms[static_cast<size_t>(reduced)] = scalar_field_value(
                ctx->material_fields.Ms_field,
                static_cast<size_t>(representative),
                ctx->material.saturation_magnetisation);
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
        mfem::CGSolver cg_solver;
        cg_solver.SetRelTol(1e-10);
        cg_solver.SetMaxIter(200);
        cg_solver.SetPrintLevel(0);
        cg_solver.SetOperator(mass_form);
        h_component = 0.0;
        cg_solver.Mult(tmp, h_component);
        const double *ms_host = audited_host_read(ms_field);
        double *h_host = audited_host_read_write(h_component);
        for (int i = 0; i < ndofs; ++i) {
            const double Ms_i = ms_host[i];
            if (Ms_i <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms_i)) * h_host[i];
            }
        }
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
