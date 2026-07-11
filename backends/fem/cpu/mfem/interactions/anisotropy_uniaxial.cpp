/*
 * Uniaxial anisotropy source contract.
 *
 * This source owns easy-axis Ku1/Ku2 H_eff projection, per-node overrides,
 * joule energy integration, and nonmagnetic-node zeroing. It does not validate cubic axes or compute cubic H_eff.
 */
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"

#include "core/fem_element_quadrature_material.hpp"
#include "context.hpp"
#include "fem_common.hpp"

#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace fullmag::fem {
namespace {

constexpr std::array<double, 4> kGl4Nodes = {
    0.069431844202973712388026755553595,
    0.330009478207571867598667120448377,
    0.669990521792428132401332879551623,
    0.930568155797026287611973244446405,
};
constexpr std::array<double, 4> kGl4Weights = {
    0.173927422568726928686531974610999,
    0.326072577431273071313468025389001,
    0.326072577431273071313468025389001,
    0.173927422568726928686531974610999,
};
constexpr std::array<double, 3> kGl3Nodes = {
    0.112701665379258311482073460021760,
    0.5,
    0.887298334620741688517926539978240,
};
constexpr std::array<double, 3> kGl3Weights = {
    0.277777777777777777777777777777778,
    0.444444444444444444444444444444444,
    0.277777777777777777777777777777778,
};

void require_p1_scalar(const std::vector<double> &values, std::size_t nodes, const char *name) {
    if (values.size() != nodes) {
        throw std::invalid_argument(std::string(name) + " must have one value per P1 node");
    }
    for (double value : values) {
        if (!std::isfinite(value)) {
            throw std::invalid_argument(std::string(name) + " contains NaN/Inf");
        }
    }
}

void require_p1_aos3(const std::vector<double> &values, std::size_t nodes, const char *name) {
    if (values.size() != 3u * nodes) {
        throw std::invalid_argument(std::string(name) + " must have three values per P1 node");
    }
    for (double value : values) {
        if (!std::isfinite(value)) {
            throw std::invalid_argument(std::string(name) + " contains NaN/Inf");
        }
    }
}

void require_unit_axis(const std::array<double, 3> &axis) {
    for (double component : axis) {
        if (!std::isfinite(component)) {
            throw std::invalid_argument("uniaxial axis contains NaN/Inf");
        }
    }
    const double norm = std::hypot(axis[0], axis[1], axis[2]);
    if (std::fabs(norm - 1.0) > 128.0 * std::numeric_limits<double>::epsilon()) {
        throw std::invalid_argument("uniaxial axis must have unit Euclidean norm");
    }
}

double interpolate_scalar(
    const std::vector<double> &values,
    const P1TetrahedronMaterialTopology &element,
    const std::array<double, 4> &shape)
{
    double result = 0.0;
    for (std::size_t local = 0; local < 4u; ++local) {
        result += shape[local] * values[static_cast<std::size_t>(element.node_ids[local])];
    }
    return result;
}

double interpolate_m_dot_axis(
    const std::vector<double> &m_xyz,
    const std::array<double, 3> &axis,
    const P1TetrahedronMaterialTopology &element,
    const std::array<double, 4> &shape)
{
    double result = 0.0;
    for (std::size_t local = 0; local < 4u; ++local) {
        const std::size_t base = static_cast<std::size_t>(element.node_ids[local]) * 3u;
        const double local_dot =
            m_xyz[base + 0u] * axis[0u] +
            m_xyz[base + 1u] * axis[1u] +
            m_xyz[base + 2u] * axis[2u];
        result += shape[local] * local_dot;
    }
    return result;
}

} // namespace

void compute_uniaxial_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ani_xyz,
    double *anisotropy_energy)
{
    const size_t n = ctx.mesh.n_nodes;
    h_ani_xyz.assign(n * 3u, 0.0);
    if (!ctx.anisotropy.uniaxial_enabled ||
        (ctx.anisotropy.uniaxial_Ku == 0.0 && ctx.anisotropy.uniaxial_Ku2 == 0.0 &&
         ctx.material_fields.Ku_field.empty() && ctx.material_fields.Ku2_field.empty())) {
        if (anisotropy_energy != nullptr) {
            *anisotropy_energy = 0.0;
        }
        return;
    }

    const bool use_axis_field =
        !ctx.anisotropy.uniaxial_axis_x_field.empty() &&
        !ctx.anisotropy.uniaxial_axis_y_field.empty() &&
        !ctx.anisotropy.uniaxial_axis_z_field.empty();
    const double uniform_ux = ctx.anisotropy.uniaxial_axis[0];
    const double uniform_uy = ctx.anisotropy.uniaxial_axis[1];
    const double uniform_uz = ctx.anisotropy.uniaxial_axis[2];
    const double uniform_Ms = ctx.material_fields.material.saturation_magnetisation;
    const double uniform_Ku = ctx.anisotropy.uniaxial_Ku;
    const double uniform_Ku2 = ctx.anisotropy.uniaxial_Ku2;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.material_fields.Ms_field.empty() ? uniform_Ms : ctx.material_fields.Ms_field[i];
        const double Ku_i = ctx.material_fields.Ku_field.empty() ? uniform_Ku : ctx.material_fields.Ku_field[i];
        const double Ku2_i = ctx.material_fields.Ku2_field.empty() ? uniform_Ku2 : ctx.material_fields.Ku2_field[i];
        const double ux = use_axis_field ? ctx.anisotropy.uniaxial_axis_x_field[i] : uniform_ux;
        const double uy = use_axis_field ? ctx.anisotropy.uniaxial_axis_y_field[i] : uniform_uy;
        const double uz = use_axis_field ? ctx.anisotropy.uniaxial_axis_z_field[i] : uniform_uz;
        const double prefactor = 2.0 * Ku_i / (kMu0 * Ms_i);
        const double prefactor2 = (Ku2_i != 0.0) ? 4.0 * Ku2_i / (kMu0 * Ms_i) : 0.0;
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];
        const double m_dot_u = mx * ux + my * uy + mz * uz;
        const double m_dot_u2 = m_dot_u * m_dot_u;

        const double coeff = prefactor * m_dot_u + prefactor2 * m_dot_u * m_dot_u2;
        h_ani_xyz[base + 0] = coeff * ux;
        h_ani_xyz[base + 1] = coeff * uy;
        h_ani_xyz[base + 2] = coeff * uz;

        if (anisotropy_energy != nullptr && !ctx.integration_weights.mfem_lumped_mass.empty()) {
            energy += (-Ku_i * m_dot_u2 - Ku2_i * m_dot_u2 * m_dot_u2) *
                      ctx.integration_weights.mfem_lumped_mass[i];
        }
    }

    if (anisotropy_energy != nullptr) {
        *anisotropy_energy = energy;
    }
}

double uniaxial_anisotropy_energy_from_element_quadrature_material(
    const ElementQuadratureMaterial &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &ku1_j_per_m3,
    const std::vector<double> &ku2_j_per_m3,
    const std::array<double, 3> &axis)
{
    const std::size_t nodes = material.node_count();
    require_p1_aos3(m_xyz, nodes, "P1 magnetization");
    require_p1_scalar(ku1_j_per_m3, nodes, "P1 Ku1");
    require_p1_scalar(ku2_j_per_m3, nodes, "P1 Ku2");
    require_unit_axis(axis);

    double energy_j = 0.0;
    for (std::size_t ordinal = 0; ordinal < material.element_count(); ++ordinal) {
        const P1TetrahedronMaterialTopology &element = material.element_topology(ordinal);
        // Read Ms from the same sharp map that later mass-projects H_u.  It is
        // not a factor of E_u, whose density is already measured in J/m^3.
        if (!(material.ms_a_per_m(ordinal) > 0.0)) {
            throw std::logic_error("element-quadrature material lost positive DG0 Ms");
        }
        for (std::size_t ir = 0; ir < kGl4Nodes.size(); ++ir) {
            const double r = kGl4Nodes[ir];
            for (std::size_t is = 0; is < kGl4Nodes.size(); ++is) {
                const double s = kGl4Nodes[is];
                for (std::size_t it = 0; it < kGl3Nodes.size(); ++it) {
                    const double t = kGl3Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t), r,
                        (1.0 - r) * s, (1.0 - r) * (1.0 - s) * t,
                    };
                    const double jacobian_weight = 6.0 * element.volume_m3 *
                        kGl4Weights[ir] * kGl4Weights[is] * kGl3Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double q = interpolate_m_dot_axis(m_xyz, axis, element, shape);
                    const double q2 = q * q;
                    const double density =
                        interpolate_scalar(ku1_j_per_m3, element, shape) * q2 +
                        interpolate_scalar(ku2_j_per_m3, element, shape) * q2 * q2;
                    energy_j -= jacobian_weight * density;
                }
            }
        }
    }
    return energy_j;
}

} // namespace fullmag::fem
