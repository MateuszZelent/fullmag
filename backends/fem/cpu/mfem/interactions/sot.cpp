/*
 * Prescribed SOT source contract.
 *
 * This source owns the canonical prescribed_sot.fullmag.v1 local algebra and
 * its FEM node-mask/runtime import. It does not solve charge or spin
 * transport, and it does not define the SHE/iSHE transport equations.
 */

#include "cpu/mfem/interactions/sot.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>

namespace fullmag::fem {
namespace {

using Vec3 = std::array<double, 3>;

constexpr double kSotMu0 = 1.2566370614359173e-6;
constexpr double kHbar = 1.054571817e-34;
constexpr double kExactElectronCharge = 1.602176634e-19;

Vec3 cross3(const Vec3 &a, const Vec3 &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm3(const Vec3 &v)
{
    return vector_norm3(v[0], v[1], v[2]);
}

double stable_sinc_pi(double x)
{
    const double ax = std::abs(x);
    if (ax <= 1.0e-4) {
        const double pi2_x2 = (M_PI * x) * (M_PI * x);
        return 1.0 - pi2_x2 / 6.0 + (pi2_x2 * pi2_x2) / 120.0;
    }
    return std::sin(M_PI * x) / (M_PI * x);
}

bool finite_time_points(const fullmag_fem_sot_envelope_desc &descriptor, std::string &error)
{
    if (descriptor.point_count == 0) {
        error = "prescribed FEM SOT piecewise-linear envelope requires at least one point";
        return false;
    }
    if (descriptor.points == nullptr) {
        error = "prescribed FEM SOT envelope points are null";
        return false;
    }
    for (uint64_t i = 0; i < descriptor.point_count; ++i) {
        const auto &point = descriptor.points[i];
        if (!std::isfinite(point.time_s) || !std::isfinite(point.value)) {
            error = "prescribed FEM SOT envelope points must be finite";
            return false;
        }
        if (i > 0 && !(point.time_s > descriptor.points[i - 1].time_s)) {
            error = "prescribed FEM SOT envelope point times must be strictly increasing";
            return false;
        }
    }
    return true;
}

} // namespace

double evaluate_sot_envelope(
    const SotRuntimeState &sot,
    double evaluation_time_s,
    double stage_start_time_s)
{
    const double time_s = sot.envelope_time_origin == FULLMAG_FEM_TIME_STAGE_LOCAL
        ? evaluation_time_s - stage_start_time_s
        : evaluation_time_s;
    switch (sot.envelope_kind) {
    case FULLMAG_FEM_TIME_CONSTANT:
        return sot.envelope_value;
    case FULLMAG_FEM_TIME_SINUSOIDAL:
        return sot.envelope_offset + sot.envelope_amplitude * std::sin(
            2.0 * M_PI * sot.envelope_frequency_hz * time_s + sot.envelope_phase_rad);
    case FULLMAG_FEM_TIME_PULSE:
        return time_s >= sot.envelope_t_on_s && time_s < sot.envelope_t_off_s
            ? sot.envelope_amplitude
            : 0.0;
    case FULLMAG_FEM_TIME_PIECEWISE_LINEAR: {
        if (sot.envelope_point_times_s.empty()) {
            return 0.0;
        }
        if (time_s <= sot.envelope_point_times_s.front()) {
            return sot.envelope_point_values.front();
        }
        if (time_s >= sot.envelope_point_times_s.back()) {
            return sot.envelope_point_values.back();
        }
        const auto upper = std::upper_bound(
            sot.envelope_point_times_s.begin(), sot.envelope_point_times_s.end(), time_s);
        const size_t upper_index = static_cast<size_t>(upper - sot.envelope_point_times_s.begin());
        const size_t lower_index = upper_index - 1u;
        const double u = (time_s - sot.envelope_point_times_s[lower_index]) /
            (sot.envelope_point_times_s[upper_index] - sot.envelope_point_times_s[lower_index]);
        return sot.envelope_point_values[lower_index] + u *
            (sot.envelope_point_values[upper_index] - sot.envelope_point_values[lower_index]);
    }
    case FULLMAG_FEM_TIME_SINC_PULSE:
        return sot.envelope_offset + sot.envelope_amplitude * stable_sinc_pi(
            sot.envelope_bandwidth_hz * (time_s - sot.envelope_center_s));
    default:
        return 0.0;
    }
}

bool initialize_sot_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    ctx.sot = SotRuntimeState{};
    ctx.sot.enabled = plan.has_prescribed_sot != 0;
    if (!ctx.sot.enabled) {
        return true;
    }

    if (plan.sot_formula_version != FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1) {
        error = "native FEM supports only prescribed_sot.fullmag.v1";
        return false;
    }
    if (!std::isfinite(plan.sot_current_density_am2) ||
        !std::isfinite(plan.sot_xi_dl) ||
        !std::isfinite(plan.sot_xi_fl) ||
        !std::isfinite(plan.sot_thickness) ||
        !(plan.sot_thickness > 0.0)) {
        error = "prescribed FEM SOT current, efficiencies, and thickness must be finite; thickness must be positive";
        return false;
    }
    if (!std::isfinite(plan.sot_envelope_value)) {
        error = "prescribed FEM SOT envelope value must be finite";
        return false;
    }
    const auto &envelope = plan.sot_envelope;
    if (envelope.abi_version != 0 &&
        envelope.abi_version != FULLMAG_FEM_SOT_ENVELOPE_ABI_VERSION) {
        error = "prescribed FEM SOT envelope ABI version is unsupported";
        return false;
    }
    if (envelope.abi_version != 0 &&
        envelope.struct_size < sizeof(fullmag_fem_sot_envelope_desc)) {
        error = "prescribed FEM SOT envelope descriptor is truncated";
        return false;
    }
    const uint32_t envelope_kind = envelope.abi_version == 0
        ? FULLMAG_FEM_TIME_CONSTANT
        : envelope.kind;
    if (envelope_kind > FULLMAG_FEM_TIME_SINC_PULSE) {
        error = "prescribed FEM SOT envelope kind is unsupported";
        return false;
    }
    if (envelope.time_origin != FULLMAG_FEM_TIME_STAGE_LOCAL &&
        envelope.time_origin != FULLMAG_FEM_TIME_ABSOLUTE) {
        error = "prescribed FEM SOT envelope time origin is unsupported";
        return false;
    }
    if (envelope_kind == FULLMAG_FEM_TIME_SINUSOIDAL &&
        (!std::isfinite(envelope.amplitude) || !std::isfinite(envelope.frequency_hz) ||
         envelope.frequency_hz < 0.0 || !std::isfinite(envelope.phase_rad) ||
         !std::isfinite(envelope.offset))) {
        error = "prescribed FEM SOT sinusoidal envelope parameters are invalid";
        return false;
    }
    if (envelope_kind == FULLMAG_FEM_TIME_PULSE &&
        (!std::isfinite(envelope.amplitude) || !std::isfinite(envelope.t_on_s) ||
         !std::isfinite(envelope.t_off_s) || envelope.t_off_s <= envelope.t_on_s)) {
        error = "prescribed FEM SOT pulse envelope parameters are invalid";
        return false;
    }
    if (envelope_kind == FULLMAG_FEM_TIME_PIECEWISE_LINEAR &&
        !finite_time_points(envelope, error)) {
        return false;
    }
    if (envelope_kind == FULLMAG_FEM_TIME_SINC_PULSE &&
        (!std::isfinite(envelope.amplitude) || !std::isfinite(envelope.center_s) ||
         !std::isfinite(envelope.bandwidth_hz) || envelope.bandwidth_hz <= 0.0 ||
         !std::isfinite(envelope.offset))) {
        error = "prescribed FEM SOT sinc envelope parameters are invalid";
        return false;
    }

    const Vec3 sigma = {plan.sot_sigma[0], plan.sot_sigma[1], plan.sot_sigma[2]};
    const double sigma_norm = norm3(sigma);
    if (!std::isfinite(sigma_norm) || sigma_norm <= 1e-30) {
        error = "prescribed FEM SOT sigma must be finite and non-zero";
        return false;
    }

    ctx.sot.formula_version = plan.sot_formula_version;
    ctx.sot.current_density_am2 = plan.sot_current_density_am2;
    ctx.sot.xi_dl = plan.sot_xi_dl;
    ctx.sot.xi_fl = plan.sot_xi_fl;
    ctx.sot.thickness = plan.sot_thickness;
    ctx.sot.envelope_value = plan.sot_envelope_value;
    ctx.sot.envelope_kind = envelope_kind;
    ctx.sot.envelope_time_origin = envelope.abi_version == 0
        ? FULLMAG_FEM_TIME_ABSOLUTE
        : envelope.time_origin;
    ctx.sot.envelope_amplitude = envelope.abi_version == 0
        ? plan.sot_envelope_value
        : envelope.amplitude;
    ctx.sot.envelope_frequency_hz = envelope.frequency_hz;
    ctx.sot.envelope_phase_rad = envelope.phase_rad;
    ctx.sot.envelope_offset = envelope.offset;
    ctx.sot.envelope_t_on_s = envelope.t_on_s;
    ctx.sot.envelope_t_off_s = envelope.t_off_s;
    ctx.sot.envelope_center_s = envelope.center_s;
    ctx.sot.envelope_bandwidth_hz = envelope.bandwidth_hz;
    if (envelope_kind == FULLMAG_FEM_TIME_PIECEWISE_LINEAR) {
        ctx.sot.envelope_point_times_s.reserve(envelope.point_count);
        ctx.sot.envelope_point_values.reserve(envelope.point_count);
        for (uint64_t i = 0; i < envelope.point_count; ++i) {
            ctx.sot.envelope_point_times_s.push_back(envelope.points[i].time_s);
            ctx.sot.envelope_point_values.push_back(envelope.points[i].value);
        }
    }
    ctx.sot.sigma = {
        sigma[0] / sigma_norm,
        sigma[1] / sigma_norm,
        sigma[2] / sigma_norm,
    };

    if (plan.sot_active_node_mask != nullptr || plan.sot_active_node_mask_len != 0) {
        if (plan.sot_active_node_mask == nullptr ||
            plan.sot_active_node_mask_len != static_cast<uint64_t>(ctx.mesh.n_nodes)) {
            error = "sot_active_node_mask length must match FEM node count";
            return false;
        }
        ctx.sot.active_node_mask.assign(
            plan.sot_active_node_mask,
            plan.sot_active_node_mask + plan.sot_active_node_mask_len);
        if (std::none_of(ctx.sot.active_node_mask.begin(), ctx.sot.active_node_mask.end(),
                         [](uint8_t selected) { return selected != 0u; })) {
            error = "sot_active_node_mask must select at least one FEM node";
            return false;
        }
    }
    return true;
}

void add_sot_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs,
    double evaluation_time_s,
    double stage_start_time_s)
{
    if (!ctx.sot.enabled) {
        return;
    }

    const Vec3 sigma = ctx.sot.sigma;
    const double envelope_value = evaluate_sot_envelope(
        ctx.sot, evaluation_time_s, stage_start_time_s);
    if (!std::isfinite(envelope_value)) {
        return;
    }
    const double gamma_e = ctx.material_fields.material.gyromagnetic_ratio / kSotMu0;
    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        if (!ctx.sot.active_node_mask.empty() && ctx.sot.active_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const double ms = scalar_field_value(
            ctx.material_fields.Ms_field,
            i,
            ctx.material_fields.material.saturation_magnetisation);
        if (!(ms > 0.0)) {
            continue;
        }
        const double alpha = scalar_field_value(
            ctx.material_fields.alpha_field,
            i,
            ctx.material_fields.material.damping);
        const double omega_base = gamma_e * kHbar *
            (ctx.sot.current_density_am2 * envelope_value) /
            (2.0 * kExactElectronCharge * ms * ctx.sot.thickness);
        const double omega_dl = omega_base * ctx.sot.xi_dl;
        const double omega_fl = omega_base * ctx.sot.xi_fl;
        const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        const double damping_like = (omega_dl - alpha * omega_fl) * inv_gilbert;
        const double field_like = (omega_fl + alpha * omega_dl) * inv_gilbert;

        const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
        const Vec3 m_cross_sigma = cross3(m, sigma);
        const Vec3 m_cross_m_cross_sigma = cross3(m, m_cross_sigma);
        rhs_xyz[base + 0] += -damping_like * m_cross_m_cross_sigma[0] +
            field_like * m_cross_sigma[0];
        rhs_xyz[base + 1] += -damping_like * m_cross_m_cross_sigma[1] +
            field_like * m_cross_sigma[1];
        rhs_xyz[base + 2] += -damping_like * m_cross_m_cross_sigma[2] +
            field_like * m_cross_sigma[2];
    }

    max_rhs = 0.0;
    for (size_t i = 0; i < rhs_xyz.size() / 3u; ++i) {
        const size_t base = i * 3u;
        max_rhs = std::max(
            max_rhs,
            vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
    }
}

} // namespace fullmag::fem
