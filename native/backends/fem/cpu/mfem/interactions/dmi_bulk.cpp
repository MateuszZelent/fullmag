/*
 * Bulk DMI source contract.
 *
 * This source owns the bulk/Bloch weak-residual element loop, optional periodic
 * input projection, no-MFEM active error, lumped-mass H_DMI projection, and
 * joule energy accumulation. It does not own interfacial DMI, shared scratch
 * lifetime, top-level plan import, or LLG torque conversion.
 */
#include "cpu/mfem/interactions/dmi_bulk.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/dmi_workspace.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "dmi_weak_residual.hpp"

#include <algorithm>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#ifdef _OPENMP
#include <omp.h>
#endif
#endif

namespace fullmag::fem {

bool compute_bulk_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error)
{
    const size_t n = ctx.mesh.n_nodes;
    h_dmi_xyz.assign(n * 3u, 0.0);
    if (!ctx.dmi.bulk_enabled || (ctx.dmi.bulk_D == 0.0 && ctx.material_fields.Dbulk_field.empty())) {
        if (dmi_energy != nullptr) {
            *dmi_energy = 0.0;
        }
        return true;
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.mfem_context.ready) {
        error = "MFEM context not ready for bulk DMI computation";
        return false;
    }

    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "MFEM FE space or mesh is null during bulk DMI computation";
        return false;
    }

    const double uniform_D = ctx.dmi.bulk_D;
    const double uniform_Ms = ctx.material_fields.material.saturation_magnetisation;
    double energy = 0.0;

    auto *dmi_workspace = dmi_element_workspace(ctx);

    const std::vector<double> *exchange_input = &m_xyz;
    if (!ctx.mesh.periodic_reduced_node.empty()) {
        dmi_workspace->projected_m_xyz = m_xyz;
        project_static_periodic_aos(ctx, dmi_workspace->projected_m_xyz);
        exchange_input = &dmi_workspace->projected_m_xyz;
    }

    unpack_aos_to_existing_components(*exchange_input, ctx.mfem_context.m_x, ctx.mfem_context.m_y, ctx.mfem_context.m_z);

    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_mz);

    int dmi_threads = 1;
#ifdef _OPENMP
    dmi_threads = std::max(1, ctx.cpu_threads.effective_omp_threads);
#endif
    const bool parallel_dmi = dmi_threads > 1 && mesh->GetNE() >= 2000;
    dmi_workspace->prepare_thread_residuals(parallel_dmi ? dmi_threads : 1, n * 3u);

    auto accumulate_element = [&](int elem, int thread_index, double &thread_energy) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem) < ctx.mesh.magnetic_element_mask.size() &&
            ctx.mesh.magnetic_element_mask[elem] == 0u) {
            return;
        }

        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        mfem::Array<int> &dofs =
            dmi_workspace->dofs_by_thread[static_cast<size_t>(thread_index)];
        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();
        dmi_workspace->prepare_thread_local(thread_index, local_ndof);

        mfem::Vector &mx_elem =
            dmi_workspace->mx_elem_by_thread[static_cast<size_t>(thread_index)];
        mfem::Vector &my_elem =
            dmi_workspace->my_elem_by_thread[static_cast<size_t>(thread_index)];
        mfem::Vector &mz_elem =
            dmi_workspace->mz_elem_by_thread[static_cast<size_t>(thread_index)];
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            mx_elem(i) = sign * (*gf_mx)(gdof);
            my_elem(i) = sign * (*gf_my)(gdof);
            mz_elem(i) = sign * (*gf_mz)(gdof);
        }

        double elem_D = 0.0;
        if (!ctx.material_fields.Dbulk_field.empty()) {
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                elem_D += ctx.material_fields.Dbulk_field[gdof];
            }
            elem_D /= static_cast<double>(local_ndof);
        } else {
            elem_D = uniform_D;
        }

        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            mfem::DenseMatrix &dshape =
                dmi_workspace->dshape_by_thread[static_cast<size_t>(thread_index)];
            fe->CalcPhysDShape(*T, dshape);

            double dmx_dx = 0.0, dmx_dy = 0.0, dmx_dz = 0.0;
            double dmy_dx = 0.0, dmy_dy = 0.0, dmy_dz = 0.0;
            double dmz_dx = 0.0, dmz_dy = 0.0, dmz_dz = 0.0;
            for (int i = 0; i < local_ndof; ++i) {
                dmx_dx += mx_elem(i) * dshape(i, 0);
                dmx_dy += mx_elem(i) * dshape(i, 1);
                dmx_dz += mx_elem(i) * dshape(i, 2);
                dmy_dx += my_elem(i) * dshape(i, 0);
                dmy_dy += my_elem(i) * dshape(i, 1);
                dmy_dz += my_elem(i) * dshape(i, 2);
                dmz_dx += mz_elem(i) * dshape(i, 0);
                dmz_dy += mz_elem(i) * dshape(i, 1);
                dmz_dz += mz_elem(i) * dshape(i, 2);
            }

            const double curl_x = dmz_dy - dmy_dz;
            const double curl_y = dmx_dz - dmz_dx;
            const double curl_z = dmy_dx - dmx_dy;

            mfem::Vector &shape =
                dmi_workspace->shape_by_thread[static_cast<size_t>(thread_index)];
            fe->CalcShape(ip, shape);
            double m_q[3] = {};
            for (int i = 0; i < local_ndof; ++i) {
                m_q[0] += mx_elem(i) * shape(i);
                m_q[1] += my_elem(i) * shape(i);
                m_q[2] += mz_elem(i) * shape(i);
            }
            std::vector<double> &thread_residual =
                dmi_workspace->residual_xyz_by_thread[static_cast<size_t>(thread_index)];
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.mesh.n_nodes) {
                    continue;
                }
                const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
                DmiElementData data{};
                data.m_q[0] = m_q[0];
                data.m_q[1] = m_q[1];
                data.m_q[2] = m_q[2];
                data.shape = sign * shape(i);
                data.weight = w;
                data.grad_m[0][0] = dmx_dx;
                data.grad_m[0][1] = dmx_dy;
                data.grad_m[0][2] = dmx_dz;
                data.grad_m[1][0] = dmy_dx;
                data.grad_m[1][1] = dmy_dy;
                data.grad_m[1][2] = dmy_dz;
                data.grad_m[2][0] = dmz_dx;
                data.grad_m[2][1] = dmz_dy;
                data.grad_m[2][2] = dmz_dz;
                for (int dir = 0; dir < 3; ++dir) {
                    data.grad_shape[dir] = sign * dshape(i, dir);
                }
                dmi_accumulate_bulk_residual(
                    data,
                    elem_D,
                    &thread_residual[static_cast<size_t>(gdof) * 3u]);
            }

            if (dmi_energy != nullptr) {
                thread_energy +=
                    elem_D * (m_q[0] * curl_x + m_q[1] * curl_y + m_q[2] * curl_z) * w;
            }
        }
    };

#ifdef _OPENMP
    if (parallel_dmi) {
#pragma omp parallel num_threads(dmi_threads)
        {
            const int thread_index = omp_get_thread_num();
            double thread_energy = 0.0;
#pragma omp for schedule(static)
            for (int elem = 0; elem < mesh->GetNE(); ++elem) {
                accumulate_element(elem, thread_index, thread_energy);
            }
#pragma omp atomic
            energy += thread_energy;
        }
    } else
#endif
    {
        double thread_energy = 0.0;
        for (int elem = 0; elem < mesh->GetNE(); ++elem) {
            accumulate_element(elem, 0, thread_energy);
        }
        energy += thread_energy;
    }
    dmi_workspace->reduce_thread_residuals(n * 3u);
    std::vector<double> &residual_xyz = dmi_workspace->residual_xyz;

    if (ctx.integration_weights.mfem_lumped_mass.size() != n) {
        error = "MFEM lumped mass is unavailable for bulk DMI weak-residual projection";
        return false;
    }
    if (!dmi_project_lumped_field(
            residual_xyz.data(),
            ctx.integration_weights.mfem_lumped_mass.data(),
            ctx.material_fields.Ms_field.empty() ? nullptr : ctx.material_fields.Ms_field.data(),
            static_cast<uint64_t>(n),
            uniform_Ms,
            h_dmi_xyz.data(),
            error)) {
        return false;
    }

    if (dmi_energy != nullptr) {
        *dmi_energy = energy;
    }
    return true;
#else
    (void) m_xyz;
    error = "Bulk DMI computation requires MFEM stack";
    return false;
#endif
}

} // namespace fullmag::fem
