#include "cpu/mfem/interactions/dmi.hpp"

#include "context.hpp"
#include "dmi_weak_residual.hpp"

#include <algorithm>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {
namespace {

/*
 * Dzyaloshinskii-Moriya interaction module for the native FEM CPU backend.
 *
 * Physical contract
 * -----------------
 * DMI is represented by a weak residual and lumped-mass projection to an
 * observable H_DMI field in A/m. The ordinary LLG RHS later converts this field
 * into dm/dt through gamma_mu0. This module must not apply gamma, damping, or a
 * direct-torque factor.
 *
 * MFEM dependency
 * ---------------
 * The executable element-loop path requires MFEM finite-element spaces,
 * transformations, integration rules, and grid functions. Non-MFEM builds still
 * compile the public contract and return a clear environment error when active
 * DMI is requested.
 */

#if FULLMAG_HAS_MFEM_STACK
struct DmiElementWorkspace {
    void reset_vector(std::vector<double> &vector, size_t size) {
        if (vector.size() != size) {
            vector.assign(size, 0.0);
        } else {
            std::fill(vector.begin(), vector.end(), 0.0);
        }
    }

    void prepare_residual(size_t field_len) {
        reset_vector(residual_xyz, field_len);
    }

    void prepare_local(int local_ndof) {
        mx_elem.SetSize(local_ndof);
        my_elem.SetSize(local_ndof);
        mz_elem.SetSize(local_ndof);
        dshape.SetSize(local_ndof, 3);
        shape.SetSize(local_ndof);
    }

    mfem::Array<int> dofs;
    mfem::Vector mx_elem;
    mfem::Vector my_elem;
    mfem::Vector mz_elem;
    mfem::DenseMatrix dshape;
    mfem::Vector shape;
    std::vector<double> residual_xyz;
    std::vector<double> projected_m_xyz;
};

DmiElementWorkspace *dmi_element_workspace(Context &ctx) {
    auto *workspace = static_cast<DmiElementWorkspace *>(ctx.mfem_dmi_workspace);
    if (workspace == nullptr) {
        workspace = new DmiElementWorkspace();
        ctx.mfem_dmi_workspace = workspace;
    }
    return workspace;
}

void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    x.resize(n);
    y.resize(n);
    z.resize(n);
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0u];
        y[i] = aos[i * 3u + 1u];
        z[i] = aos[i * 3u + 2u];
    }
}

void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    if (x.size() != n || y.size() != n || z.size() != n) {
        unpack_aos_to_components(aos, x, y, z);
        return;
    }
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0u];
        y[i] = aos[i * 3u + 1u];
        z[i] = aos[i * 3u + 2u];
    }
}

void project_static_periodic_aos(const Context &ctx, std::vector<double> &field_xyz) {
    if (ctx.periodic_reduced_node.empty()) {
        return;
    }
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        const uint32_t representative = ctx.periodic_representative_nodes[static_cast<size_t>(reduced)];
        const size_t dst = static_cast<size_t>(node) * 3u;
        const size_t src = static_cast<size_t>(representative) * 3u;
        field_xyz[dst + 0u] = field_xyz[src + 0u];
        field_xyz[dst + 1u] = field_xyz[src + 1u];
        field_xyz[dst + 2u] = field_xyz[src + 2u];
    }
}
#endif

} // namespace

bool compute_interfacial_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error)
{
    const size_t n = ctx.n_nodes;
    h_dmi_xyz.assign(n * 3u, 0.0);
    if (!ctx.enable_dmi || (ctx.dmi_D == 0.0 && ctx.Dind_field.empty())) {
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
    dmi_workspace->prepare_residual(n * 3u);
    std::vector<double> &residual_xyz = dmi_workspace->residual_xyz;

    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);

    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);

    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem) < ctx.magnetic_element_mask.size() &&
            ctx.magnetic_element_mask[elem] == 0u) {
            continue;
        }

        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        mfem::Array<int> &dofs = dmi_workspace->dofs;
        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();
        dmi_workspace->prepare_local(local_ndof);

        mfem::Vector &mx_elem = dmi_workspace->mx_elem;
        mfem::Vector &my_elem = dmi_workspace->my_elem;
        mfem::Vector &mz_elem = dmi_workspace->mz_elem;
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            mx_elem(i) = sign * (*gf_mx)(gdof);
            my_elem(i) = sign * (*gf_my)(gdof);
            mz_elem(i) = sign * (*gf_mz)(gdof);
        }

        double elem_D = 0.0;
        if (!ctx.Dind_field.empty()) {
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                elem_D += ctx.Dind_field[gdof];
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

            mfem::DenseMatrix &dshape = dmi_workspace->dshape;
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

            mfem::Vector &shape = dmi_workspace->shape;
            fe->CalcShape(ip, shape);
            double m_q[3] = {};
            for (int i = 0; i < local_ndof; ++i) {
                m_q[0] += mx_elem(i) * shape(i);
                m_q[1] += my_elem(i) * shape(i);
                m_q[2] += mz_elem(i) * shape(i);
            }
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
                    &residual_xyz[static_cast<size_t>(gdof) * 3u]);
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
                energy += elem_D * (m_dot_n * div_m - m_grad_mn) * w;
            }
        }
    }

    if (ctx.mfem_lumped_mass.size() != n) {
        error = "MFEM lumped mass is unavailable for interfacial DMI weak-residual projection";
        return false;
    }
    if (!dmi_project_lumped_field(
            residual_xyz.data(),
            ctx.mfem_lumped_mass.data(),
            ctx.Ms_field.empty() ? nullptr : ctx.Ms_field.data(),
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

bool compute_bulk_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error)
{
    const size_t n = ctx.n_nodes;
    h_dmi_xyz.assign(n * 3u, 0.0);
    if (!ctx.enable_bulk_dmi || (ctx.bulk_dmi_D == 0.0 && ctx.Dbulk_field.empty())) {
        if (dmi_energy != nullptr) {
            *dmi_energy = 0.0;
        }
        return true;
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.mfem_ready) {
        error = "MFEM context not ready for bulk DMI computation";
        return false;
    }

    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "MFEM FE space or mesh is null during bulk DMI computation";
        return false;
    }

    const double uniform_D = ctx.bulk_dmi_D;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    double energy = 0.0;

    auto *dmi_workspace = dmi_element_workspace(ctx);
    dmi_workspace->prepare_residual(n * 3u);
    std::vector<double> &residual_xyz = dmi_workspace->residual_xyz;

    const std::vector<double> *exchange_input = &m_xyz;
    if (!ctx.periodic_reduced_node.empty()) {
        dmi_workspace->projected_m_xyz = m_xyz;
        project_static_periodic_aos(ctx, dmi_workspace->projected_m_xyz);
        exchange_input = &dmi_workspace->projected_m_xyz;
    }

    unpack_aos_to_existing_components(*exchange_input, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);

    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);

    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem) < ctx.magnetic_element_mask.size() &&
            ctx.magnetic_element_mask[elem] == 0u) {
            continue;
        }

        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        mfem::Array<int> &dofs = dmi_workspace->dofs;
        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();
        dmi_workspace->prepare_local(local_ndof);

        mfem::Vector &mx_elem = dmi_workspace->mx_elem;
        mfem::Vector &my_elem = dmi_workspace->my_elem;
        mfem::Vector &mz_elem = dmi_workspace->mz_elem;
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            mx_elem(i) = sign * (*gf_mx)(gdof);
            my_elem(i) = sign * (*gf_my)(gdof);
            mz_elem(i) = sign * (*gf_mz)(gdof);
        }

        double elem_D = 0.0;
        if (!ctx.Dbulk_field.empty()) {
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                elem_D += ctx.Dbulk_field[gdof];
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

            mfem::DenseMatrix &dshape = dmi_workspace->dshape;
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

            mfem::Vector &shape = dmi_workspace->shape;
            fe->CalcShape(ip, shape);
            double m_q[3] = {};
            for (int i = 0; i < local_ndof; ++i) {
                m_q[0] += mx_elem(i) * shape(i);
                m_q[1] += my_elem(i) * shape(i);
                m_q[2] += mz_elem(i) * shape(i);
            }
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
                    &residual_xyz[static_cast<size_t>(gdof) * 3u]);
            }

            if (dmi_energy != nullptr) {
                energy += elem_D * (m_q[0] * curl_x + m_q[1] * curl_y + m_q[2] * curl_z) * w;
            }
        }
    }

    if (ctx.mfem_lumped_mass.size() != n) {
        error = "MFEM lumped mass is unavailable for bulk DMI weak-residual projection";
        return false;
    }
    if (!dmi_project_lumped_field(
            residual_xyz.data(),
            ctx.mfem_lumped_mass.data(),
            ctx.Ms_field.empty() ? nullptr : ctx.Ms_field.data(),
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

void destroy_dmi_workspace(Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    delete static_cast<DmiElementWorkspace *>(ctx.mfem_dmi_workspace);
    ctx.mfem_dmi_workspace = nullptr;
#else
    (void) ctx;
#endif
}

} // namespace fullmag::fem
