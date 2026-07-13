/*
 * Cubic anisotropy source contract.
 *
 * This source owns cubic crystal-frame K1/K2/K3 H_eff projection, per-node
 * overrides, joule energy integration, and nonmagnetic-node zeroing. It does not validate plan axes or compute uniaxial H_eff.
 */
#include "cpu/mfem/interactions/anisotropy_cubic.hpp"

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

constexpr std::array<double, 6> kGl6Nodes = {
    0.033765242898423986093849222753002,
    0.169395306766867743169300202490047,
    0.380690406958401545684749139159645,
    0.619309593041598454315250860840355,
    0.830604693233132256830699797509953,
    0.966234757101576013906150777246998,
};
constexpr std::array<double, 6> kGl6Weights = {
    0.085662246189585172520148071086366,
    0.180380786524069303784916756918858,
    0.233956967286345523694935171994776,
    0.233956967286345523694935171994776,
    0.180380786524069303784916756918858,
    0.085662246189585172520148071086366,
};
constexpr std::array<double, 5> kGl5Nodes = {
    0.046910077030668003601186560850304,
    0.230765344947158454481842789649895,
    0.5,
    0.769234655052841545518157210350105,
    0.953089922969331996398813439149696,
};
constexpr std::array<double, 5> kGl5Weights = {
    0.118463442528094543757132020359959,
    0.239314335249683234020645757417819,
    0.284444444444444444444444444444444,
    0.239314335249683234020645757417819,
    0.118463442528094543757132020359959,
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

void require_orthonormal_crystal_axes(
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    for (double component : axis1) {
        if (!std::isfinite(component)) {
            throw std::invalid_argument("cubic axis1 contains NaN/Inf");
        }
    }
    for (double component : axis2) {
        if (!std::isfinite(component)) {
            throw std::invalid_argument("cubic axis2 contains NaN/Inf");
        }
    }
    constexpr double tolerance = 128.0 * std::numeric_limits<double>::epsilon();
    const double norm1 = std::hypot(axis1[0], axis1[1], axis1[2]);
    const double norm2 = std::hypot(axis2[0], axis2[1], axis2[2]);
    const double dot = axis1[0] * axis2[0] + axis1[1] * axis2[1] + axis1[2] * axis2[2];
    if (std::fabs(norm1 - 1.0) > tolerance || std::fabs(norm2 - 1.0) > tolerance ||
        std::fabs(dot) > tolerance) {
        throw std::invalid_argument("cubic axes must be a unit orthonormal crystal frame");
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

double interpolate_m_projection(
    const std::vector<double> &m_xyz,
    const std::array<double, 3> &axis,
    const P1TetrahedronMaterialTopology &element,
    const std::array<double, 4> &shape)
{
    double result = 0.0;
    for (std::size_t local = 0; local < 4u; ++local) {
        const std::size_t base = static_cast<std::size_t>(element.node_ids[local]) * 3u;
        result += shape[local] *
            (m_xyz[base] * axis[0] + m_xyz[base + 1u] * axis[1] + m_xyz[base + 2u] * axis[2]);
    }
    return result;
}

} // namespace

void compute_cubic_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_cub_xyz,
    double *cubic_energy)
{
    const size_t n = ctx.mesh.n_nodes;
    h_cub_xyz.assign(n * 3u, 0.0);
    if (!ctx.anisotropy.cubic_enabled ||
        (ctx.anisotropy.cubic_Kc1 == 0.0 && ctx.anisotropy.cubic_Kc2 == 0.0 && ctx.anisotropy.cubic_Kc3 == 0.0 &&
         ctx.material_fields.Kc1_field.empty() && ctx.material_fields.Kc2_field.empty() && ctx.material_fields.Kc3_field.empty())) {
        if (cubic_energy != nullptr) {
            *cubic_energy = 0.0;
        }
        return;
    }

    const double c1x = ctx.anisotropy.cubic_axis1[0], c1y = ctx.anisotropy.cubic_axis1[1], c1z = ctx.anisotropy.cubic_axis1[2];
    const double c2x = ctx.anisotropy.cubic_axis2[0], c2y = ctx.anisotropy.cubic_axis2[1], c2z = ctx.anisotropy.cubic_axis2[2];
    const double c3x = c1y * c2z - c1z * c2y;
    const double c3y = c1z * c2x - c1x * c2z;
    const double c3z = c1x * c2y - c1y * c2x;

    const double inv_mu0 = 1.0 / kMu0;
    const double uniform_Ms = ctx.material_fields.material.saturation_magnetisation;
    const double uniform_Kc1 = ctx.anisotropy.cubic_Kc1;
    const double uniform_Kc2 = ctx.anisotropy.cubic_Kc2;
    const double uniform_Kc3 = ctx.anisotropy.cubic_Kc3;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.material_fields.Ms_field.empty() ? uniform_Ms : ctx.material_fields.Ms_field[i];
        const double Kc1_i = ctx.material_fields.Kc1_field.empty() ? uniform_Kc1 : ctx.material_fields.Kc1_field[i];
        const double Kc2_i = ctx.material_fields.Kc2_field.empty() ? uniform_Kc2 : ctx.material_fields.Kc2_field[i];
        const double Kc3_i = ctx.material_fields.Kc3_field.empty() ? uniform_Kc3 : ctx.material_fields.Kc3_field[i];
        const double inv_mu0Ms = inv_mu0 / Ms_i;
        const double pf1 = -2.0 * Kc1_i * inv_mu0Ms;
        const double pf2 = -2.0 * Kc2_i * inv_mu0Ms;
        const double pf3 = -4.0 * Kc3_i * inv_mu0Ms;
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];

        const double m1 = mx * c1x + my * c1y + mz * c1z;
        const double m2 = mx * c2x + my * c2y + mz * c2z;
        const double m3 = mx * c3x + my * c3y + mz * c3z;

        const double m1sq = m1 * m1;
        const double m2sq = m2 * m2;
        const double m3sq = m3 * m3;
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

        double g1 = pf1 * m1 * (m2sq + m3sq);
        double g2 = pf1 * m2 * (m1sq + m3sq);
        double g3 = pf1 * m3 * (m1sq + m2sq);

        if (ctx.anisotropy.cubic_Kc2 != 0.0 || !ctx.material_fields.Kc2_field.empty()) {
            g1 += pf2 * m1 * m2sq * m3sq;
            g2 += pf2 * m1sq * m2 * m3sq;
            g3 += pf2 * m1sq * m2sq * m3;
        }

        if (ctx.anisotropy.cubic_Kc3 != 0.0 || !ctx.material_fields.Kc3_field.empty()) {
            g1 += pf3 * sigma * m1 * (m2sq + m3sq);
            g2 += pf3 * sigma * m2 * (m1sq + m3sq);
            g3 += pf3 * sigma * m3 * (m1sq + m2sq);
        }

        h_cub_xyz[base + 0] = g1 * c1x + g2 * c2x + g3 * c3x;
        h_cub_xyz[base + 1] = g1 * c1y + g2 * c2y + g3 * c3y;
        h_cub_xyz[base + 2] = g1 * c1z + g2 * c2z + g3 * c3z;

        if (cubic_energy != nullptr && !ctx.integration_weights.mfem_lumped_mass.empty()) {
            energy += (Kc1_i * sigma +
                       Kc2_i * m1sq * m2sq * m3sq +
                       Kc3_i * sigma * sigma) *
                      ctx.integration_weights.mfem_lumped_mass[i];
        }
    }

    if (cubic_energy != nullptr) {
        *cubic_energy = energy;
    }
}

double cubic_anisotropy_energy_from_element_quadrature_material(
    const ElementQuadratureMaterial &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &kc1_j_per_m3,
    const std::vector<double> &kc2_j_per_m3,
    const std::vector<double> &kc3_j_per_m3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    const std::size_t nodes = material.node_count();
    require_p1_aos3(m_xyz, nodes, "P1 magnetization");
    require_p1_scalar(kc1_j_per_m3, nodes, "P1 Kc1");
    require_p1_scalar(kc2_j_per_m3, nodes, "P1 Kc2");
    require_p1_scalar(kc3_j_per_m3, nodes, "P1 Kc3");
    require_orthonormal_crystal_axes(axis1, axis2);
    const std::array<double, 3> axis3 = {
        axis1[1] * axis2[2] - axis1[2] * axis2[1],
        axis1[2] * axis2[0] - axis1[0] * axis2[2],
        axis1[0] * axis2[1] - axis1[1] * axis2[0],
    };

    double energy_j = 0.0;
    for (std::size_t ordinal = 0; ordinal < material.element_count(); ++ordinal) {
        const P1TetrahedronMaterialTopology &element = material.element_topology(ordinal);
        // Ms is not part of this conservative density, but retain the same
        // sharp map validation required by the later mu0-Ms field projection.
        if (!(material.ms_a_per_m(ordinal) > 0.0)) {
            throw std::logic_error("element-quadrature material lost positive DG0 Ms");
        }
        for (std::size_t ir = 0; ir < kGl6Nodes.size(); ++ir) {
            const double r = kGl6Nodes[ir];
            for (std::size_t is = 0; is < kGl6Nodes.size(); ++is) {
                const double s = kGl6Nodes[is];
                for (std::size_t it = 0; it < kGl5Nodes.size(); ++it) {
                    const double t = kGl5Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t),
                        r,
                        (1.0 - r) * s,
                        (1.0 - r) * (1.0 - s) * t,
                    };
                    const double weight = 6.0 * element.volume_m3 *
                        kGl6Weights[ir] * kGl6Weights[is] * kGl5Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double m1 = interpolate_m_projection(m_xyz, axis1, element, shape);
                    const double m2 = interpolate_m_projection(m_xyz, axis2, element, shape);
                    const double m3 = interpolate_m_projection(m_xyz, axis3, element, shape);
                    const double m1sq = m1 * m1;
                    const double m2sq = m2 * m2;
                    const double m3sq = m3 * m3;
                    const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
                    const double density =
                        interpolate_scalar(kc1_j_per_m3, element, shape) * sigma +
                        interpolate_scalar(kc2_j_per_m3, element, shape) * m1sq * m2sq * m3sq +
                        interpolate_scalar(kc3_j_per_m3, element, shape) * sigma * sigma;
                    energy_j += weight * density;
                }
            }
        }
    }
    return energy_j;
}

double cubic_anisotropy_energy_from_material_realization(
    const P1TetrahedralMaterialRealization &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &kc1_j_per_m3,
    const std::vector<double> &kc2_j_per_m3,
    const std::vector<double> &kc3_j_per_m3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    const std::size_t nodes = material.node_count();
    require_p1_aos3(m_xyz, nodes, "P1 magnetization");
    require_p1_scalar(kc1_j_per_m3, nodes, "P1 Kc1");
    require_p1_scalar(kc2_j_per_m3, nodes, "P1 Kc2");
    require_p1_scalar(kc3_j_per_m3, nodes, "P1 Kc3");
    require_orthonormal_crystal_axes(axis1, axis2);
    if (material.ms_location() != MaterialCoefficientLocation::element_dg0) {
        throw std::invalid_argument("sharp cubic material realization requires element_dg0 Ms");
    }
    const std::array<double, 3> axis3 = {
        axis1[1] * axis2[2] - axis1[2] * axis2[1],
        axis1[2] * axis2[0] - axis1[0] * axis2[2],
        axis1[0] * axis2[1] - axis1[1] * axis2[0],
    };

    double energy_j = 0.0;
    for (const std::size_t ordinal : material.active_element_ordinals()) {
        const P1TetrahedronMaterialTopology &element = material.element_topology(ordinal);
        for (std::size_t ir = 0; ir < kGl6Nodes.size(); ++ir) {
            const double r = kGl6Nodes[ir];
            for (std::size_t is = 0; is < kGl6Nodes.size(); ++is) {
                const double s = kGl6Nodes[is];
                for (std::size_t it = 0; it < kGl5Nodes.size(); ++it) {
                    const double t = kGl5Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t), r,
                        (1.0 - r) * s, (1.0 - r) * (1.0 - s) * t,
                    };
                    const double weight = 6.0 * element.volume_m3 *
                        kGl6Weights[ir] * kGl6Weights[is] * kGl5Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double m1 = interpolate_m_projection(m_xyz, axis1, element, shape);
                    const double m2 = interpolate_m_projection(m_xyz, axis2, element, shape);
                    const double m3 = interpolate_m_projection(m_xyz, axis3, element, shape);
                    const double m1sq = m1 * m1;
                    const double m2sq = m2 * m2;
                    const double m3sq = m3 * m3;
                    const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
                    energy_j += weight * (
                        interpolate_scalar(kc1_j_per_m3, element, shape) * sigma +
                        interpolate_scalar(kc2_j_per_m3, element, shape) * m1sq * m2sq * m3sq +
                        interpolate_scalar(kc3_j_per_m3, element, shape) * sigma * sigma);
                }
            }
        }
    }
    return energy_j;
}

double cubic_anisotropy_directional_derivative_from_material_realization(
    const P1TetrahedralMaterialRealization &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &p_xyz,
    const std::vector<double> &kc1_j_per_m3,
    const std::vector<double> &kc2_j_per_m3,
    const std::vector<double> &kc3_j_per_m3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    const std::size_t nodes = material.node_count();
    require_p1_aos3(m_xyz, nodes, "P1 magnetization");
    require_p1_aos3(p_xyz, nodes, "P1 probe");
    require_p1_scalar(kc1_j_per_m3, nodes, "P1 Kc1");
    require_p1_scalar(kc2_j_per_m3, nodes, "P1 Kc2");
    require_p1_scalar(kc3_j_per_m3, nodes, "P1 Kc3");
    require_orthonormal_crystal_axes(axis1, axis2);
    if (material.ms_location() != MaterialCoefficientLocation::element_dg0) {
        throw std::invalid_argument("sharp cubic material realization requires element_dg0 Ms");
    }
    const std::array<double, 3> axis3 = {
        axis1[1] * axis2[2] - axis1[2] * axis2[1],
        axis1[2] * axis2[0] - axis1[0] * axis2[2],
        axis1[0] * axis2[1] - axis1[1] * axis2[0],
    };

    double derivative_j = 0.0;
    for (const std::size_t ordinal : material.active_element_ordinals()) {
        const P1TetrahedronMaterialTopology &element = material.element_topology(ordinal);
        for (std::size_t ir = 0; ir < kGl6Nodes.size(); ++ir) {
            const double r = kGl6Nodes[ir];
            for (std::size_t is = 0; is < kGl6Nodes.size(); ++is) {
                const double s = kGl6Nodes[is];
                for (std::size_t it = 0; it < kGl5Nodes.size(); ++it) {
                    const double t = kGl5Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t), r,
                        (1.0 - r) * s, (1.0 - r) * (1.0 - s) * t,
                    };
                    const double weight = 6.0 * element.volume_m3 *
                        kGl6Weights[ir] * kGl6Weights[is] * kGl5Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double m1 = interpolate_m_projection(m_xyz, axis1, element, shape);
                    const double m2 = interpolate_m_projection(m_xyz, axis2, element, shape);
                    const double m3 = interpolate_m_projection(m_xyz, axis3, element, shape);
                    const double p1 = interpolate_m_projection(p_xyz, axis1, element, shape);
                    const double p2 = interpolate_m_projection(p_xyz, axis2, element, shape);
                    const double p3 = interpolate_m_projection(p_xyz, axis3, element, shape);
                    const double m1sq = m1 * m1;
                    const double m2sq = m2 * m2;
                    const double m3sq = m3 * m3;
                    const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
                    const double sigma_derivative = 2.0 * (
                        m1 * p1 * (m2sq + m3sq) +
                        m2 * p2 * (m1sq + m3sq) +
                        m3 * p3 * (m1sq + m2sq));
                    const double sixth_derivative = 2.0 * (
                        p1 * m1 * m2sq * m3sq +
                        p2 * m2 * m1sq * m3sq +
                        p3 * m3 * m1sq * m2sq);
                    derivative_j += weight * (
                        interpolate_scalar(kc1_j_per_m3, element, shape) * sigma_derivative +
                        interpolate_scalar(kc2_j_per_m3, element, shape) * sixth_derivative +
                        2.0 * interpolate_scalar(kc3_j_per_m3, element, shape) * sigma * sigma_derivative);
                }
            }
        }
    }
    return derivative_j;
}

} // namespace fullmag::fem
