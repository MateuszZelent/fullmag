#include "cpu/mfem/integrators/llg_rhs.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {
namespace {

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

double vector_norm3(double x, double y, double z)
{
    return std::sqrt(x * x + y * y + z * z);
}

} // namespace

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

        rhs_xyz[base + 0] = -gamma_bar * (px + alpha_i * dx);
        rhs_xyz[base + 1] = -gamma_bar * (py + alpha_i * dy);
        rhs_xyz[base + 2] = -gamma_bar * (pz + alpha_i * dz);

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
