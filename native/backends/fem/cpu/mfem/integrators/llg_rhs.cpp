/*
 * LLG RHS source contract.
 *
 * This source owns AoS normalization, nonmagnetic-node zeroing, and nodewise
 * Gilbert-form LLG RHS evaluation from an already composed effective field. It does not compose H_eff, evaluate interaction fields, advance time, or own step metrics.
 */

#include "cpu/mfem/integrators/llg_rhs.hpp"

#include "fem_common.hpp"

#include <algorithm>

namespace fullmag::fem {

void normalize_aos_field(std::vector<double> &m_xyz)
{
    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double norm = vector_norm3(m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]);
        if (norm > 0.0) {
            m_xyz[base + 0] /= norm;
            m_xyz[base + 1] /= norm;
            m_xyz[base + 2] /= norm;
        }
    }
}

void llg_rhs_aos(
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_xyz,
    double gamma,
    double alpha,
    const std::vector<double> *alpha_field,
    bool precession_enabled,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    const size_t n = m_xyz.size() / 3u;
    rhs_xyz.resize(m_xyz.size());
    max_rhs = 0.0;

    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];
        const double hx = h_xyz[base + 0];
        const double hy = h_xyz[base + 1];
        const double hz = h_xyz[base + 2];
        const double alpha_i = alpha_field == nullptr
            ? alpha
            : scalar_field_value(*alpha_field, i, alpha);
        const double gamma_bar = gamma / (1.0 + alpha_i * alpha_i);

        const double px = my * hz - mz * hy;
        const double py = mz * hx - mx * hz;
        const double pz = mx * hy - my * hx;

        const double dx = my * pz - mz * py;
        const double dy = mz * px - mx * pz;
        const double dz = mx * py - my * px;

        const double precession_scale = precession_enabled ? 1.0 : 0.0;
        rhs_xyz[base + 0] = -gamma_bar * (precession_scale * px + alpha_i * dx);
        rhs_xyz[base + 1] = -gamma_bar * (precession_scale * py + alpha_i * dy);
        rhs_xyz[base + 2] = -gamma_bar * (precession_scale * pz + alpha_i * dz);

        max_rhs = std::max(
            max_rhs,
            vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
    }
}

void zero_non_magnetic_nodes_aos(
    std::vector<double> &field_xyz,
    const std::vector<uint8_t> &magnetic_node_mask)
{
    if (magnetic_node_mask.empty()) {
        return;
    }
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (magnetic_node_mask[i] == 0u) {
            const size_t base = i * 3u;
            field_xyz[base + 0] = 0.0;
            field_xyz[base + 1] = 0.0;
            field_xyz[base + 2] = 0.0;
        }
    }
}

} // namespace fullmag::fem
