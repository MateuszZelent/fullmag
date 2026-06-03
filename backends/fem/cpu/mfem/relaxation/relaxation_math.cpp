#include "cpu/mfem/relaxation/relaxation_math.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem::relaxation {

namespace {

double dot3(
    const std::vector<double> &a,
    const std::vector<double> &b,
    size_t base)
{
    return a[base + 0] * b[base + 0] +
        a[base + 1] * b[base + 1] +
        a[base + 2] * b[base + 2];
}

bool magnetic_node(const Context &ctx, size_t node)
{
    return ctx.mesh.magnetic_node_mask.empty() ||
        ctx.mesh.magnetic_node_mask[node] != 0u;
}

} // namespace

double dot_fields(
    const std::vector<double> &a,
    const std::vector<double> &b)
{
    double value = 0.0;
    const size_t n = std::min(a.size(), b.size());
    for (size_t i = 0; i < n; ++i) {
        value += a[i] * b[i];
    }
    return value;
}

double gradient_norm_sq(const std::vector<double> &gradient)
{
    return dot_fields(gradient, gradient);
}

double metric_dot_fields(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b)
{
    const size_t nodes = std::min(a.size(), b.size()) / 3u;
    if (ctx.integration_weights.mfem_lumped_mass.size() < nodes) {
        return dot_fields(a, b);
    }

    double value = 0.0;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        value += ctx.integration_weights.mfem_lumped_mass[node] * dot3(a, b, base);
    }
    return value;
}

double metric_gradient_norm_sq(
    const Context &ctx,
    const std::vector<double> &gradient)
{
    return metric_dot_fields(ctx, gradient, gradient);
}

void tangent_gradient_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_eff_xyz,
    std::vector<double> &gradient_xyz)
{
    gradient_xyz.assign(m_xyz.size(), 0.0);
    const size_t nodes = m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        const double mdoth = dot3(m_xyz, h_eff_xyz, base);
        for (size_t component = 0; component < 3u; ++component) {
            const size_t idx = base + component;
            const double projected = h_eff_xyz[idx] - mdoth * m_xyz[idx];
            gradient_xyz[idx] = -projected;
        }
    }
}

std::vector<double> project_tangent(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &vector_xyz)
{
    std::vector<double> projected(m_xyz.size(), 0.0);
    const size_t nodes = m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        const double mdotv = dot3(m_xyz, vector_xyz, base);
        for (size_t component = 0; component < 3u; ++component) {
            const size_t idx = base + component;
            projected[idx] = vector_xyz[idx] - mdotv * m_xyz[idx];
        }
    }
    return projected;
}

std::vector<double> negative_field(const std::vector<double> &field_xyz)
{
    std::vector<double> result(field_xyz.size(), 0.0);
    for (size_t i = 0; i < field_xyz.size(); ++i) {
        result[i] = -field_xyz[i];
    }
    return result;
}

std::vector<double> retracted_step(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &direction_xyz,
    double step_size)
{
    std::vector<double> trial = m_xyz;
    const size_t nodes = m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        const double x = m_xyz[base + 0] + step_size * direction_xyz[base + 0];
        const double y = m_xyz[base + 1] + step_size * direction_xyz[base + 1];
        const double z = m_xyz[base + 2] + step_size * direction_xyz[base + 2];
        const double norm = std::sqrt(x * x + y * y + z * z);
        if (norm > 0.0) {
            const double inv = 1.0 / norm;
            trial[base + 0] = x * inv;
            trial[base + 1] = y * inv;
            trial[base + 2] = z * inv;
        }
    }
    return trial;
}

int ensure_cpu_mfem_relaxation_lane(
    Context &ctx,
    const char *algorithm_name,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    error.clear();
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (ctx.gpu_state.device.lifecycle.allocated) {
        error = std::string("native FEM ") + algorithm_name +
            " relaxation is implemented for the CPU/MFEM lane; "
            "GPU-resident production minimization is not implemented yet";
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = std::string(algorithm_name) +
        " relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int upload_and_snapshot(
    Context &ctx,
    const std::vector<double> &m_xyz,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int upload_status = context_upload_magnetization_f64(
        ctx,
        m_xyz.data(),
        static_cast<uint64_t>(m_xyz.size()),
        error);
    if (upload_status != FULLMAG_FEM_OK) {
        return upload_status;
    }
    if (!context_snapshot_stats_mfem(ctx, stats, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)m_xyz;
    (void)stats;
    error = "native FEM relaxation snapshot requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

void finish_accepted_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &trial_stats,
    fullmag_fem_step_stats &out_stats,
    double accepted_step_size)
{
    ctx.relaxation.accepted_steps += 1;
    ctx.state.step_count += 1;
    ctx.state.current_time = 0.0;

    out_stats = trial_stats;
    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = accepted_step_size;
    out_stats.max_rhs_amplitude = 0.0;
}

} // namespace fullmag::fem::relaxation
