/*
 * Object-local FEM scalar reductions.
 *
 * Energies are integrated over owned elements. Nodal-lumped terms are split
 * by each element's local mass row sum, so shared nodes never imply shared
 * ownership and the object partition reproduces the global discretization.
 */
#include "cpu/mfem/runtime/object_stats.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

double nodal_value(const std::vector<double> &values, std::size_t node, double fallback)
{
    return values.empty() ? fallback : values[node];
}

std::array<double, 3> cross3(
    const std::array<double, 3> &a,
    const std::array<double, 3> &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double dot3(const std::array<double, 3> &a, const std::array<double, 3> &b)
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

bool copy_linearization_field(
    const Context &ctx,
    fullmag_fem_observable observable,
    std::vector<double> &values,
    std::string &error)
{
    values.resize(static_cast<std::size_t>(ctx.mesh.n_nodes) * 3u);
    return context_copy_linearization_field_f64(
               ctx,
               observable,
               values.data(),
               static_cast<std::uint64_t>(values.size()),
               error) == FULLMAG_FEM_OK;
}

bool copy_field(
    const Context &ctx,
    fullmag_fem_observable observable,
    std::vector<double> &values,
    std::string &error)
{
    values.resize(static_cast<std::size_t>(ctx.mesh.n_nodes) * 3u);
    return context_copy_field_f64(
               ctx,
               observable,
               values.data(),
               static_cast<std::uint64_t>(values.size()),
               error) == FULLMAG_FEM_OK;
}

std::array<double, 3> aos3_at(const std::vector<double> &values, std::size_t node)
{
    const std::size_t base = node * 3u;
    return {values[base], values[base + 1u], values[base + 2u]};
}

} // namespace
#endif

bool compute_object_stats_for_elements(
    Context &ctx,
    const std::uint32_t *element_indices,
    std::uint64_t element_count,
    fullmag_fem_object_stats_v1 &stats,
    std::string &error)
{
#if !FULLMAG_HAS_MFEM_STACK
    (void)ctx;
    (void)element_indices;
    (void)element_count;
    (void)stats;
    error = "per-object FEM reductions require the MFEM stack";
    return false;
#else
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    if (!ctx.mfem_context.ready || mesh == nullptr || fes == nullptr) {
        error = "per-object FEM reductions require a ready MFEM mesh and finite-element space";
        return false;
    }
    if (element_count == 0u || element_indices == nullptr) {
        error = "per-object FEM reductions require at least one owned element";
        return false;
    }
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        error = "per-object FEM magnetization readback failed: " + error;
        return false;
    }

    std::vector<std::uint8_t> selected(static_cast<std::size_t>(mesh->GetNE()), 0u);
    for (std::uint64_t ordinal = 0; ordinal < element_count; ++ordinal) {
        const std::uint32_t element = element_indices[ordinal];
        if (element >= static_cast<std::uint32_t>(mesh->GetNE())) {
            error = "per-object FEM reduction received an element index out of range";
            return false;
        }
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[element] == 0u) {
            error = "per-object FEM reduction received a nonmagnetic element";
            return false;
        }
        if (selected[element] != 0u) {
            error = "per-object FEM reduction received a duplicate element index";
            return false;
        }
        selected[element] = 1u;
    }

    std::vector<double> h_demag;
    std::vector<double> h_ext;
    std::vector<double> h_drive;
    if (ctx.demag.enabled &&
        !copy_linearization_field(ctx, FULLMAG_FEM_OBSERVABLE_H_DEMAG, h_demag, error)) {
        error = "per-object FEM demag field readback failed: " + error;
        return false;
    }
    if (ctx.zeeman.has_external_field &&
        !copy_linearization_field(ctx, FULLMAG_FEM_OBSERVABLE_H_EXT, h_ext, error)) {
        error = "per-object FEM external field readback failed: " + error;
        return false;
    }
    if (!ctx.zeeman.regional_drives.empty() &&
        !copy_field(ctx, FULLMAG_FEM_OBSERVABLE_H_DRIVE, h_drive, error)) {
        error = "per-object FEM drive field readback failed: " + error;
        return false;
    }

    const auto &m = ctx.state.m_xyz;
    const bool elementwise_ms = !ctx.material_fields.Ms_element_field.empty();
    const double uniform_ms = ctx.material_fields.material.saturation_magnetisation;
    const double uniform_a = ctx.material_fields.material.exchange_stiffness;
    const auto cubic_axis3 = cross3(ctx.anisotropy.cubic_axis1, ctx.anisotropy.cubic_axis2);
    std::array<double, 3> moment{};
    double moment_weight = 0.0;
    double e_ex = 0.0;
    double e_demag = 0.0;
    double e_ext = 0.0;
    double e_drive = 0.0;
    double e_ani = 0.0;
    double e_interfacial = 0.0;
    double e_rotated = 0.0;
    double e_bulk = 0.0;
    double e_mel = 0.0;

    mfem::Array<int> dofs;
    mfem::Vector shape;
    mfem::DenseMatrix dshape;
    mfem::DenseMatrix exchange_matrix;
    std::vector<std::array<double, 3>> local_m;
    std::vector<double> local_lumped;

    for (int element = 0; element < mesh->GetNE(); ++element) {
        if (selected[static_cast<std::size_t>(element)] == 0u) {
            continue;
        }
        const mfem::FiniteElement *fe = fes->GetFE(element);
        mfem::ElementTransformation *transformation = mesh->GetElementTransformation(element);
        if (fe == nullptr || transformation == nullptr) {
            error = "per-object FEM reduction could not access an owned element";
            return false;
        }
        fes->GetElementDofs(element, dofs);
        const int ndof = dofs.Size();
        if (ndof <= 0) {
            error = "per-object FEM reduction encountered an element without degrees of freedom";
            return false;
        }
        local_m.assign(static_cast<std::size_t>(ndof), {});
        local_lumped.assign(static_cast<std::size_t>(ndof), 0.0);
        for (int local = 0; local < ndof; ++local) {
            const int signed_dof = dofs[local];
            const int global_dof = signed_dof >= 0 ? signed_dof : -1 - signed_dof;
            const double sign = signed_dof >= 0 ? 1.0 : -1.0;
            if (global_dof < 0 || static_cast<std::uint32_t>(global_dof) >= ctx.mesh.n_nodes) {
                error = "per-object FEM reduction encountered an invalid element degree of freedom";
                return false;
            }
            local_m[static_cast<std::size_t>(local)] = aos3_at(m, static_cast<std::size_t>(global_dof));
            for (double &component : local_m[static_cast<std::size_t>(local)]) {
                component *= sign;
            }
        }

        if (ctx.exchange.enabled) {
            if (exchange_form == nullptr) {
                error = "per-object FEM exchange reduction requires the assembled exchange form";
                return false;
            }
            exchange_form->ComputeElementMatrix(element, exchange_matrix);
            for (int component = 0; component < 3; ++component) {
                for (int i = 0; i < ndof; ++i) {
                    for (int j = 0; j < ndof; ++j) {
                        e_ex += local_m[static_cast<std::size_t>(i)][component] *
                            exchange_matrix(i, j) *
                            local_m[static_cast<std::size_t>(j)][component];
                    }
                }
            }
        }

        double conventional_d = ctx.dmi.interfacial_D;
        double bulk_d = ctx.dmi.bulk_D;
        if (!ctx.material_fields.Dind_field.empty()) {
            conventional_d = 0.0;
            for (int local = 0; local < ndof; ++local) {
                const int signed_dof = dofs[local];
                const int node = signed_dof >= 0 ? signed_dof : -1 - signed_dof;
                conventional_d += ctx.material_fields.Dind_field[static_cast<std::size_t>(node)];
            }
            conventional_d /= static_cast<double>(ndof);
        }
        if (!ctx.material_fields.Dbulk_field.empty()) {
            bulk_d = 0.0;
            for (int local = 0; local < ndof; ++local) {
                const int signed_dof = dofs[local];
                const int node = signed_dof >= 0 ? signed_dof : -1 - signed_dof;
                bulk_d += ctx.material_fields.Dbulk_field[static_cast<std::size_t>(node)];
            }
            bulk_d /= static_cast<double>(ndof);
        }

        const mfem::IntegrationRule &rule =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());
        shape.SetSize(ndof);
        dshape.SetSize(ndof, mesh->SpaceDimension());
        for (int q = 0; q < rule.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = rule.IntPoint(q);
            transformation->SetIntPoint(&ip);
            const double weight = ip.weight * transformation->Weight();
            fe->CalcShape(ip, shape);
            fe->CalcPhysDShape(*transformation, dshape);
            std::array<double, 3> m_q{};
            double grad_m[3][3] = {};
            for (int local = 0; local < ndof; ++local) {
                const auto &value = local_m[static_cast<std::size_t>(local)];
                local_lumped[static_cast<std::size_t>(local)] += shape(local) * weight;
                for (int component = 0; component < 3; ++component) {
                    m_q[component] += value[component] * shape(local);
                    for (int direction = 0; direction < mesh->SpaceDimension(); ++direction) {
                        grad_m[component][direction] += value[component] * dshape(local, direction);
                    }
                }
            }

            if (elementwise_ms) {
                const double ms = ctx.material_fields.Ms_element_field[static_cast<std::size_t>(element)];
                std::array<double, 3> demag_q{};
                std::array<double, 3> ext_q{};
                std::array<double, 3> drive_q{};
                for (int local = 0; local < ndof; ++local) {
                    const int signed_dof = dofs[local];
                    const int node = signed_dof >= 0 ? signed_dof : -1 - signed_dof;
                    const double basis = (signed_dof >= 0 ? 1.0 : -1.0) * shape(local);
                    if (!h_demag.empty()) {
                        const auto value = aos3_at(h_demag, static_cast<std::size_t>(node));
                        for (int c = 0; c < 3; ++c) demag_q[c] += basis * value[c];
                    }
                    if (!h_ext.empty()) {
                        const auto value = aos3_at(h_ext, static_cast<std::size_t>(node));
                        for (int c = 0; c < 3; ++c) ext_q[c] += basis * value[c];
                    }
                    if (!h_drive.empty()) {
                        const auto value = aos3_at(h_drive, static_cast<std::size_t>(node));
                        for (int c = 0; c < 3; ++c) drive_q[c] += basis * value[c];
                    }
                }
                const double local_moment_weight = ms * weight;
                moment_weight += local_moment_weight;
                for (int c = 0; c < 3; ++c) moment[c] += local_moment_weight * m_q[c];
                e_demag += -0.5 * kMu0 * ms * dot3(m_q, demag_q) * weight;
                e_ext += -kMu0 * ms * dot3(m_q, ext_q) * weight;
                e_drive += -kMu0 * ms * dot3(m_q, drive_q) * weight;
            }

            const double div_m = grad_m[0][0] + grad_m[1][1] + grad_m[2][2];
            const auto &normal = ctx.dmi.interface_normal;
            const std::array<double, 3> grad_mn = {
                normal[0] * grad_m[0][0] + normal[1] * grad_m[1][0] + normal[2] * grad_m[2][0],
                normal[0] * grad_m[0][1] + normal[1] * grad_m[1][1] + normal[2] * grad_m[2][1],
                normal[0] * grad_m[0][2] + normal[1] * grad_m[1][2] + normal[2] * grad_m[2][2],
            };
            if (ctx.dmi.interfacial_enabled && conventional_d != 0.0) {
                e_interfacial += conventional_d *
                    (dot3(m_q, normal) * div_m - dot3(m_q, grad_mn)) * weight;
            }
            if (ctx.dmi.rotated_interfacial_enabled && ctx.dmi.rotated_interfacial_D != 0.0) {
                e_rotated += ctx.dmi.rotated_interfacial_D *
                    (m_q[2] * grad_m[0][0] - m_q[0] * grad_m[2][0] +
                     m_q[0] * grad_m[1][1] - m_q[1] * grad_m[0][1]) * weight;
            }
            if (ctx.dmi.bulk_enabled && bulk_d != 0.0) {
                const std::array<double, 3> curl_m = {
                    grad_m[2][1] - grad_m[1][2],
                    grad_m[0][2] - grad_m[2][0],
                    grad_m[1][0] - grad_m[0][1],
                };
                e_bulk += bulk_d * dot3(m_q, curl_m) * weight;
            }
        }

        if (!elementwise_ms) {
            for (int local = 0; local < ndof; ++local) {
                const int signed_dof = dofs[local];
                const int node_i = signed_dof >= 0 ? signed_dof : -1 - signed_dof;
                const std::size_t node = static_cast<std::size_t>(node_i);
                const double local_volume = local_lumped[static_cast<std::size_t>(local)];
                const double ms = nodal_value(ctx.material_fields.Ms_field, node, uniform_ms);
                const auto m_node = aos3_at(m, node);
                const double mw = ms * local_volume;
                moment_weight += mw;
                for (int c = 0; c < 3; ++c) moment[c] += mw * m_node[c];
                if (!h_demag.empty()) e_demag += -0.5 * kMu0 * mw * dot3(m_node, aos3_at(h_demag, node));
                if (!h_ext.empty()) e_ext += -kMu0 * mw * dot3(m_node, aos3_at(h_ext, node));
                if (!h_drive.empty()) e_drive += -kMu0 * mw * dot3(m_node, aos3_at(h_drive, node));

                if (ctx.anisotropy.uniaxial_enabled) {
                    const std::array<double, 3> axis =
                        ctx.anisotropy.uniaxial_axis_x_field.empty()
                            ? ctx.anisotropy.uniaxial_axis
                            : std::array<double, 3>{
                                  ctx.anisotropy.uniaxial_axis_x_field[node],
                                  ctx.anisotropy.uniaxial_axis_y_field[node],
                                  ctx.anisotropy.uniaxial_axis_z_field[node]};
                    const double q = dot3(m_node, axis);
                    const double q2 = q * q;
                    const double ku1 = nodal_value(ctx.material_fields.Ku_field, node, ctx.anisotropy.uniaxial_Ku);
                    const double ku2 = nodal_value(ctx.material_fields.Ku2_field, node, ctx.anisotropy.uniaxial_Ku2);
                    e_ani += (-ku1 * q2 - ku2 * q2 * q2) * local_volume;
                }
                if (ctx.anisotropy.cubic_enabled) {
                    const double m1 = dot3(m_node, ctx.anisotropy.cubic_axis1);
                    const double m2 = dot3(m_node, ctx.anisotropy.cubic_axis2);
                    const double m3 = dot3(m_node, cubic_axis3);
                    const double m1sq = m1 * m1;
                    const double m2sq = m2 * m2;
                    const double m3sq = m3 * m3;
                    const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
                    const double kc1 = nodal_value(ctx.material_fields.Kc1_field, node, ctx.anisotropy.cubic_Kc1);
                    const double kc2 = nodal_value(ctx.material_fields.Kc2_field, node, ctx.anisotropy.cubic_Kc2);
                    const double kc3 = nodal_value(ctx.material_fields.Kc3_field, node, ctx.anisotropy.cubic_Kc3);
                    e_ani += (kc1 * sigma + kc2 * m1sq * m2sq * m3sq + kc3 * sigma * sigma) * local_volume;
                }
                if (ctx.magnetoelastic.enabled && !ctx.magnetoelastic.strain_voigt.empty()) {
                    const double *eps = ctx.magnetoelastic.uniform_strain
                        ? ctx.magnetoelastic.strain_voigt.data()
                        : ctx.magnetoelastic.strain_voigt.data() + node * 6u;
                    const double e23 = 0.5 * eps[3];
                    const double e13 = 0.5 * eps[4];
                    const double e12 = 0.5 * eps[5];
                    e_mel += (ctx.magnetoelastic.b1 *
                                  (m_node[0] * m_node[0] * eps[0] +
                                   m_node[1] * m_node[1] * eps[1] +
                                   m_node[2] * m_node[2] * eps[2]) +
                              2.0 * ctx.magnetoelastic.b2 *
                                  (m_node[0] * m_node[1] * e12 +
                                   m_node[0] * m_node[2] * e13 +
                                   m_node[1] * m_node[2] * e23)) * local_volume;
                }
            }
        }
    }

    if (!(std::isfinite(moment_weight) && moment_weight > 0.0)) {
        error = "per-object FEM reduction produced no positive magnetic moment weight";
        return false;
    }
    const double e_dmi = e_interfacial + e_rotated + e_bulk;
    stats.mx = moment[0] / moment_weight;
    stats.my = moment[1] / moment_weight;
    stats.mz = moment[2] / moment_weight;
    stats.moment_weight = moment_weight;
    stats.exchange_energy_joules = e_ex;
    stats.demag_energy_joules = e_demag;
    stats.external_energy_joules = e_ext;
    stats.drive_energy_joules = e_drive;
    stats.anisotropy_energy_joules = e_ani;
    stats.dmi_energy_joules = e_dmi;
    stats.rotated_dmi_energy_joules = e_rotated;
    stats.magnetoelastic_energy_joules = e_mel;
    stats.total_energy_joules = e_ex + e_demag + e_ext + e_drive + e_ani + e_dmi + e_mel;
    return true;
#endif
}

} // namespace fullmag::fem
