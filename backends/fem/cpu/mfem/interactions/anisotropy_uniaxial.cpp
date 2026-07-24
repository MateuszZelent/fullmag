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

struct DoubleDouble {
    double hi;
    double lo;
};

DoubleDouble two_sum(double a, double b)
{
    const double hi = a + b;
    const double b_virtual = hi - a;
    return {hi, (a - (hi - b_virtual)) + (b - b_virtual)};
}

DoubleDouble two_product(double a, double b)
{
    const double hi = a * b;
    if (a != 0.0 && b != 0.0 && std::isfinite(a) && std::isfinite(b) &&
        (!std::isfinite(hi) ||
         std::abs(hi) < std::numeric_limits<double>::min())) {
        return {hi, std::numeric_limits<double>::quiet_NaN()};
    }
    return {hi, std::fma(a, b, -hi)};
}

DoubleDouble add(DoubleDouble a, DoubleDouble b)
{
    const DoubleDouble sum = two_sum(a.hi, b.hi);
    const DoubleDouble correction = two_sum(sum.lo, a.lo + b.lo);
    const DoubleDouble normalized = two_sum(sum.hi, correction.hi);
    return {normalized.hi, normalized.lo + correction.lo};
}

DoubleDouble subtract(DoubleDouble a, DoubleDouble b)
{
    return add(a, {-b.hi, -b.lo});
}

DoubleDouble multiply(DoubleDouble a, DoubleDouble b)
{
    const DoubleDouble product = two_product(a.hi, b.hi);
    const double correction =
        product.lo + a.hi * b.lo + a.lo * b.hi + a.lo * b.lo;
    return two_sum(product.hi, correction);
}

DoubleDouble dot3(
    double ax,
    double ay,
    double az,
    double bx,
    double by,
    double bz)
{
    return add(
        add(two_product(ax, bx), two_product(ay, by)),
        two_product(az, bz));
}

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

double uniaxial_anisotropy_energy_from_material_realization(
    const P1TetrahedralMaterialRealization &material,
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
    if (material.ms_location() != MaterialCoefficientLocation::element_dg0) {
        throw std::invalid_argument("sharp uniaxial material realization requires element_dg0 Ms");
    }

    double energy_j = 0.0;
    for (const std::size_t ordinal : material.active_element_ordinals()) {
        const P1TetrahedronMaterialTopology &element = material.element_topology(ordinal);
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
                    const double weight = 6.0 * element.volume_m3 *
                        kGl4Weights[ir] * kGl4Weights[is] * kGl3Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double q = interpolate_m_dot_axis(m_xyz, axis, element, shape);
                    const double q2 = q * q;
                    energy_j -= weight * (
                        interpolate_scalar(ku1_j_per_m3, element, shape) * q2 +
                        interpolate_scalar(ku2_j_per_m3, element, shape) * q2 * q2);
                }
            }
        }
    }
    return energy_j;
}

double uniaxial_anisotropy_directional_derivative_from_material_realization(
    const P1TetrahedralMaterialRealization &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &p_xyz,
    const std::vector<double> &ku1_j_per_m3,
    const std::vector<double> &ku2_j_per_m3,
    const std::array<double, 3> &axis)
{
    const std::size_t nodes = material.node_count();
    require_p1_aos3(m_xyz, nodes, "P1 magnetization");
    require_p1_aos3(p_xyz, nodes, "P1 probe");
    require_p1_scalar(ku1_j_per_m3, nodes, "P1 Ku1");
    require_p1_scalar(ku2_j_per_m3, nodes, "P1 Ku2");
    require_unit_axis(axis);
    if (material.ms_location() != MaterialCoefficientLocation::element_dg0) {
        throw std::invalid_argument("sharp uniaxial material realization requires element_dg0 Ms");
    }

    double derivative_j = 0.0;
    for (const std::size_t ordinal : material.active_element_ordinals()) {
        const P1TetrahedronMaterialTopology &element = material.element_topology(ordinal);
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
                    const double weight = 6.0 * element.volume_m3 *
                        kGl4Weights[ir] * kGl4Weights[is] * kGl3Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double q = interpolate_m_dot_axis(m_xyz, axis, element, shape);
                    const double d = interpolate_m_dot_axis(p_xyz, axis, element, shape);
                    derivative_j -= weight * d * (
                        2.0 * interpolate_scalar(ku1_j_per_m3, element, shape) * q +
                        4.0 * interpolate_scalar(ku2_j_per_m3, element, shape) * q * q * q);
                }
            }
        }
    }
    return derivative_j;
}

relaxation::EnergyDifference uniaxial_anisotropy_energy_difference(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz)
{
    relaxation::EnergyDifference result;
    if (current_m_xyz.empty() || current_m_xyz.size() % 3u != 0u ||
        trial_m_xyz.size() != current_m_xyz.size()) {
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    const size_t nodes = current_m_xyz.size() / 3u;
    if (!ctx.anisotropy.uniaxial_enabled ||
        ctx.integration_weights.mfem_lumped_mass.size() < nodes) {
        return result;
    }
    const bool axis_field = !ctx.anisotropy.uniaxial_axis_x_field.empty() &&
        !ctx.anisotropy.uniaxial_axis_y_field.empty() &&
        !ctx.anisotropy.uniaxial_axis_z_field.empty();
    std::size_t active_nodes = 0u;
    DoubleDouble accumulated_difference{0.0, 0.0};
    long double accumulated_operand_scale = 0.0L;
    for (size_t node = 0; node < nodes; ++node) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) continue;
        ++active_nodes;
        const double ku1 = ctx.material_fields.Ku_field.empty() ? ctx.anisotropy.uniaxial_Ku : ctx.material_fields.Ku_field[node];
        const double ku2 = ctx.material_fields.Ku2_field.empty() ? ctx.anisotropy.uniaxial_Ku2 : ctx.material_fields.Ku2_field[node];
        const double ux = axis_field ? ctx.anisotropy.uniaxial_axis_x_field[node] : ctx.anisotropy.uniaxial_axis[0];
        const double uy = axis_field ? ctx.anisotropy.uniaxial_axis_y_field[node] : ctx.anisotropy.uniaxial_axis[1];
        const double uz = axis_field ? ctx.anisotropy.uniaxial_axis_z_field[node] : ctx.anisotropy.uniaxial_axis[2];
        const size_t base = 3u * node;
        const DoubleDouble q0 = dot3(
            current_m_xyz[base], current_m_xyz[base+1u],
            current_m_xyz[base+2u], ux, uy, uz);
        const DoubleDouble q1 = dot3(
            trial_m_xyz[base], trial_m_xyz[base+1u],
            trial_m_xyz[base+2u], ux, uy, uz);
        const DoubleDouble q0_squared = multiply(q0, q0);
        const DoubleDouble q1_squared = multiply(q1, q1);
        const DoubleDouble quadratic_difference = multiply(
            subtract(q1, q0), add(q1, q0));
        const DoubleDouble quartic_difference = multiply(
            quadratic_difference, add(q1_squared, q0_squared));
        const double volume = ctx.integration_weights.mfem_lumped_mass[node];
        DoubleDouble ku1_coefficient = two_product(volume, ku1);
        DoubleDouble ku2_coefficient = two_product(volume, ku2);
        ku1_coefficient = {-ku1_coefficient.hi, -ku1_coefficient.lo};
        ku2_coefficient = {-ku2_coefficient.hi, -ku2_coefficient.lo};
        const DoubleDouble ku1_term =
            multiply(quadratic_difference, ku1_coefficient);
        const DoubleDouble ku2_term =
            multiply(quartic_difference, ku2_coefficient);
        accumulated_difference = add(
            accumulated_difference, add(ku1_term, ku2_term));
        const long double q0_operand_scale =
            std::abs(static_cast<long double>(current_m_xyz[base]) * ux) +
            std::abs(static_cast<long double>(current_m_xyz[base+1u]) * uy) +
            std::abs(static_cast<long double>(current_m_xyz[base+2u]) * uz);
        const long double q1_operand_scale =
            std::abs(static_cast<long double>(trial_m_xyz[base]) * ux) +
            std::abs(static_cast<long double>(trial_m_xyz[base+1u]) * uy) +
            std::abs(static_cast<long double>(trial_m_xyz[base+2u]) * uz);
        const long double projection_scale = q0_operand_scale + q1_operand_scale;
        const long double quadratic_operand_scale =
            projection_scale * projection_scale;
        const long double quartic_operand_scale =
            quadratic_operand_scale * projection_scale * projection_scale;
        accumulated_operand_scale +=
            std::abs(static_cast<long double>(volume) * ku1) *
                quadratic_operand_scale +
            std::abs(static_cast<long double>(volume) * ku2) *
                quartic_operand_scale;
    }
    // Conservatively covers every primitive operation in the double-double
    // projection, polynomial products, scaling, and global accumulation.
    constexpr std::size_t kScalarOperationsPerActiveNode = 256u;
    const std::size_t scalar_operation_count =
        active_nodes > std::numeric_limits<std::size_t>::max() /
                kScalarOperationsPerActiveNode
        ? std::numeric_limits<std::size_t>::max()
        : kScalarOperationsPerActiveNode * active_nodes;
    const long double double_epsilon =
        std::numeric_limits<double>::epsilon();
    const long double n_epsilon = static_cast<long double>(scalar_operation_count) *
        double_epsilon * double_epsilon;
    const long double relative_operation_bound =
        !std::isfinite(n_epsilon) || n_epsilon >= 1.0L
        ? std::numeric_limits<long double>::infinity()
        : n_epsilon / (1.0L - n_epsilon) * accumulated_operand_scale;
    const long double denormal_operation_floor =
        static_cast<long double>(scalar_operation_count) *
        static_cast<long double>(std::numeric_limits<double>::denorm_min());
    const long double operation_bound =
        relative_operation_bound + denormal_operation_floor;
    result.delta_joules = accumulated_difference.hi + accumulated_difference.lo;
    result.absolute_term_sum_joules = std::nextafter(
        static_cast<double>(accumulated_operand_scale),
        std::numeric_limits<double>::infinity());
    const long double cast_error = std::abs(
        static_cast<long double>(result.delta_joules) -
        (static_cast<long double>(accumulated_difference.hi) +
         static_cast<long double>(accumulated_difference.lo)));
    result.roundoff_bound_joules = std::nextafter(
        static_cast<double>(operation_bound + cast_error),
        std::numeric_limits<double>::infinity());
    return result;
}

} // namespace fullmag::fem
