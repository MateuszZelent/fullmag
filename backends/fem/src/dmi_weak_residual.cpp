/*
 * DMI weak-residual facade source contract.
 *
 * This source owns standalone weak-residual kernels used to validate and
 * project interfacial/bulk DMI element residuals through lumped mass into
 * A/m fields. It does not own Context plan import, effective-field composition, demag solves, runtime state I/O, or integrator execution.
 */

#include "dmi_weak_residual.hpp"

#include "fem_common.hpp"

#include <cmath>

namespace fullmag::fem {

namespace {

constexpr double kTiny = 1e-300;

} // namespace

void dmi_accumulate_interfacial_residual(
    const DmiElementData &data,
    const double n_hat[3],
    double d,
    double residual[3])
{
    if (n_hat == nullptr || residual == nullptr || d == 0.0 || data.weight == 0.0) {
        return;
    }

    const double div_m = data.grad_m[0][0] + data.grad_m[1][1] + data.grad_m[2][2];
    const double grad_m_dot_n[3] = {
        n_hat[0] * data.grad_m[0][0] +
            n_hat[1] * data.grad_m[1][0] +
            n_hat[2] * data.grad_m[2][0],
        n_hat[0] * data.grad_m[0][1] +
            n_hat[1] * data.grad_m[1][1] +
            n_hat[2] * data.grad_m[2][1],
        n_hat[0] * data.grad_m[0][2] +
            n_hat[1] * data.grad_m[1][2] +
            n_hat[2] * data.grad_m[2][2],
    };
    const double m_dot_n =
        data.m_q[0] * n_hat[0] +
        data.m_q[1] * n_hat[1] +
        data.m_q[2] * n_hat[2];

    for (int comp = 0; comp < 3; ++comp) {
        const double dw_dm = d * (n_hat[comp] * div_m - grad_m_dot_n[comp]);
        double grad_action = 0.0;
        for (int dir = 0; dir < 3; ++dir) {
            const double delta = comp == dir ? 1.0 : 0.0;
            const double dw_dg = d * (m_dot_n * delta - n_hat[comp] * data.m_q[dir]);
            grad_action += dw_dg * data.grad_shape[dir];
        }
        residual[comp] += data.weight * (data.shape * dw_dm + grad_action);
    }
}

void dmi_accumulate_bulk_residual(
    const DmiElementData &data,
    double d,
    double residual[3])
{
    if (residual == nullptr || d == 0.0 || data.weight == 0.0) {
        return;
    }

    const double curl_m[3] = {
        data.grad_m[2][1] - data.grad_m[1][2],
        data.grad_m[0][2] - data.grad_m[2][0],
        data.grad_m[1][0] - data.grad_m[0][1],
    };

    residual[0] += d * data.weight *
        (data.shape * curl_m[0] +
         data.m_q[1] * data.grad_shape[2] -
         data.m_q[2] * data.grad_shape[1]);
    residual[1] += d * data.weight *
        (data.shape * curl_m[1] -
         data.m_q[0] * data.grad_shape[2] +
         data.m_q[2] * data.grad_shape[0]);
    residual[2] += d * data.weight *
        (data.shape * curl_m[2] +
         data.m_q[0] * data.grad_shape[1] -
         data.m_q[1] * data.grad_shape[0]);
}

bool dmi_project_lumped_field(
    const double *residual_xyz,
    const double *lumped_mass,
    const double *ms_field,
    uint64_t node_count,
    double uniform_ms,
    double *out_h_xyz,
    std::string &error)
{
    if (residual_xyz == nullptr) {
        error = "DMI weak-residual projection received null residual buffer";
        return false;
    }
    if (lumped_mass == nullptr) {
        error = "DMI weak-residual projection requires lumped mass";
        return false;
    }
    if (out_h_xyz == nullptr) {
        error = "DMI weak-residual projection received null output buffer";
        return false;
    }
    if (!std::isfinite(uniform_ms) || uniform_ms <= 0.0) {
        error = "DMI weak-residual projection requires positive uniform Ms";
        return false;
    }

    for (uint64_t node = 0; node < node_count; ++node) {
        const double mass = lumped_mass[node];
        const double ms = ms_field != nullptr ? ms_field[node] : uniform_ms;
        const uint64_t base = node * 3ull;
        if (!std::isfinite(mass) || mass <= 0.0) {
            out_h_xyz[base + 0] = 0.0;
            out_h_xyz[base + 1] = 0.0;
            out_h_xyz[base + 2] = 0.0;
            continue;
        }
        if (!std::isfinite(ms) || ms <= 0.0) {
            error = "DMI weak-residual projection requires positive nodal Ms";
            return false;
        }
        const double inv_projection_mass = -1.0 / (kMu0 * ms * mass + kTiny);
        out_h_xyz[base + 0] = residual_xyz[base + 0] * inv_projection_mass;
        out_h_xyz[base + 1] = residual_xyz[base + 1] * inv_projection_mass;
        out_h_xyz[base + 2] = residual_xyz[base + 2] * inv_projection_mass;
    }
    return true;
}

} // namespace fullmag::fem
