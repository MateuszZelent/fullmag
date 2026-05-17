#include "cpu/mfem/interactions/zeeman_energy.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

} // namespace

double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    if (!ctx.has_external_field) {
        return 0.0;
    }

    const size_t n = std::min(ctx.mfem_lumped_mass.size(), m_xyz.size() / 3u);
    double energy = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double mdoth =
            m_xyz[base + 0] * ctx.h_ext_xyz[base + 0] +
            m_xyz[base + 1] * ctx.h_ext_xyz[base + 1] +
            m_xyz[base + 2] * ctx.h_ext_xyz[base + 2];
        const double Ms_i = scalar_field_value(
            ctx.Ms_field,
            i,
            ctx.material.saturation_magnetisation);
        energy += -kMu0 * Ms_i * mdoth * ctx.mfem_lumped_mass[i];
    }
    return energy;
}

} // namespace fullmag::fem
