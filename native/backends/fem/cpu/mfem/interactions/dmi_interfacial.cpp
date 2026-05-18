/*
 * Interfacial DMI source contract.
 *
 * This source owns the interfacial weak-residual element loop, no-MFEM active
 * error, lumped-mass H_DMI projection, and joule energy accumulation for the
 * configured interface normal. It does not own bulk DMI, shared scratch
 * lifetime, top-level plan import, or LLG torque conversion.
 */
#include "cpu/mfem/interactions/dmi_interfacial.hpp"

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

bool compute_interfacial_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error)
{
    const size_t n = ctx.n_nodes;
    h_dmi_xyz.assign(n * 3u, 0.0);
    if (!ctx.enable_dmi || (ctx.dmi_D == 0.0 && ctx.material_fields.Dind_field.empty())) {
        if (dmi_energy != nullptr) {
            *dmi_energy = 0.0;
        }
        return true;
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.mfem_ready) {
        error = "MFEM context not ready for DMI computation";
        return false;
    }

    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "MFEM FE space or mesh is null during DMI computation";
        return false;
    }

    const double uniform_D = ctx.dmi_D;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    double energy = 0.0;

    auto *dmi_workspace = dmi_element_workspace(ctx);

    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);

    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);

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
        if (!ctx.material_fields.Dind_field.empty()) {
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                elem_D += ctx.material_fields.Dind_field[gdof];
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

            const double nx = ctx.dmi_n_hat[0];
            const double ny = ctx.dmi_n_hat[1];
            const double nz = ctx.dmi_n_hat[2];

            double dm[3][3] = {};
            for (int i = 0; i < local_ndof; ++i) {
                dm[0][0] += mx_elem(i) * dshape(i, 0);
                dm[0][1] += mx_elem(i) * dshape(i, 1);
                dm[0][2] += mx_elem(i) * dshape(i, 2);
                dm[1][0] += my_elem(i) * dshape(i, 0);
                dm[1][1] += my_elem(i) * dshape(i, 1);
                dm[1][2] += my_elem(i) * dshape(i, 2);
                dm[2][0] += mz_elem(i) * dshape(i, 0);
                dm[2][1] += mz_elem(i) * dshape(i, 1);
                dm[2][2] += mz_elem(i) * dshape(i, 2);
            }

            const double div_m = dm[0][0] + dm[1][1] + dm[2][2];
            const double grad_mn[3] = {
                nx * dm[0][0] + ny * dm[1][0] + nz * dm[2][0],
                nx * dm[0][1] + ny * dm[1][1] + nz * dm[2][1],
                nx * dm[0][2] + ny * dm[1][2] + nz * dm[2][2],
            };

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
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.n_nodes) {
                    continue;
                }
                const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
                DmiElementData data{};
                data.m_q[0] = m_q[0];
                data.m_q[1] = m_q[1];
                data.m_q[2] = m_q[2];
                data.shape = sign * shape(i);
                data.weight = w;
                for (int comp = 0; comp < 3; ++comp) {
                    for (int dir = 0; dir < 3; ++dir) {
                        data.grad_m[comp][dir] = dm[comp][dir];
                    }
                }
                for (int dir = 0; dir < 3; ++dir) {
                    data.grad_shape[dir] = sign * dshape(i, dir);
                }
                const double n_hat[3] = {nx, ny, nz};
                dmi_accumulate_interfacial_residual(
                    data,
                    n_hat,
                    elem_D,
                    &thread_residual[static_cast<size_t>(gdof) * 3u]);
            }

            if (dmi_energy != nullptr) {
                double mx_q = 0.0;
                double my_q = 0.0;
                double mz_q = 0.0;
                for (int i = 0; i < local_ndof; ++i) {
                    mx_q += mx_elem(i) * shape(i);
                    my_q += my_elem(i) * shape(i);
                    mz_q += mz_elem(i) * shape(i);
                }
                const double m_dot_n = mx_q * nx + my_q * ny + mz_q * nz;
                const double m_grad_mn =
                    mx_q * grad_mn[0] + my_q * grad_mn[1] + mz_q * grad_mn[2];
                thread_energy += elem_D * (m_dot_n * div_m - m_grad_mn) * w;
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
        error = "MFEM lumped mass is unavailable for interfacial DMI weak-residual projection";
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
    error = "DMI computation requires MFEM stack";
    return false;
#endif
}

} // namespace fullmag::fem
