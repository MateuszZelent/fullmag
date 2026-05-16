#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "gpu_rk.hpp"
#include "transfer_audit.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>

#ifdef _OPENMP
#include <omp.h>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;
constexpr double kGeomEps = 1e-30;
constexpr double kPoissonAbsResidualTol = 1e-6;
constexpr int kInterruptPollStride = 256;

using Vec3 = std::array<double, 3>;
using SteadyClock = std::chrono::steady_clock;

// FND-005 fix: helper to check if any effective-field term is enabled,
// so that snapshot/step are not blocked for anisotropy-only, DMI-only, etc.
inline bool has_any_effective_field_term(const Context &ctx) {
    return ctx.enable_exchange
        || ctx.enable_demag
        || ctx.has_external_field
        || ctx.enable_anisotropy
        || ctx.enable_dmi
        || ctx.enable_bulk_dmi
        || ctx.enable_cubic_anisotropy
        || ctx.has_oersted_cylinder
        || ctx.has_oersted_field
        || ctx.enable_magnetoelastic
        || ctx.has_zhang_li_stt
        || ctx.has_slonczewski_stt
        || (ctx.temperature > 0.0);
}

uint64_t elapsed_ns(const SteadyClock::time_point &start) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

class ScopedPhaseTimer {
public:
    explicit ScopedPhaseTimer(uint64_t *accumulator)
        : accumulator_(accumulator) {
        if (accumulator_ != nullptr) {
            start_ = SteadyClock::now();
        }
    }

    ~ScopedPhaseTimer() {
        if (accumulator_ != nullptr) {
            *accumulator_ += elapsed_ns(start_);
        }
    }

private:
    uint64_t *accumulator_ = nullptr;
    SteadyClock::time_point start_{};
};

void apply_phase_timings(
    fullmag_fem_step_stats &stats,
    const PhaseTimings &timings)
{
    stats.exchange_wall_time_ns = timings.exchange_wall_time_ns;
    fill_demag_poisson_phase_stats(timings.demag, stats);
    stats.rhs_wall_time_ns = timings.rhs_wall_time_ns;
    stats.extra_energy_wall_time_ns = timings.extra_energy_wall_time_ns;
    stats.snapshot_wall_time_ns = timings.snapshot_wall_time_ns;
}

std::optional<int> selected_cuda_device_from_env() {
    const char *specific = std::getenv("FULLMAG_FEM_GPU_INDEX");
    const char *generic = std::getenv("FULLMAG_CUDA_DEVICE_INDEX");
    const char *raw = specific != nullptr ? specific : generic;
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0) {
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

} // namespace

namespace {

bool env_flag_enabled(const char *name) {
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
           std::strcmp(raw, "true") == 0 ||
           std::strcmp(raw, "TRUE") == 0 ||
           std::strcmp(raw, "on") == 0 ||
           std::strcmp(raw, "ON") == 0 ||
           std::strcmp(raw, "yes") == 0 ||
           std::strcmp(raw, "YES") == 0;
}

int openmp_max_threads() {
#ifdef _OPENMP
    return std::max(1, omp_get_max_threads());
#else
    return 1;
#endif
}

int detected_cpu_threads() {
#ifdef _OPENMP
    return std::max(1, omp_get_num_procs());
#else
    const unsigned int concurrency = std::thread::hardware_concurrency();
    return std::max(1u, concurrency);
#endif
}

std::optional<int> parse_positive_env_int(const char *name) {
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 1) {
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

bool env_requests_auto_threads(const char *name) {
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "auto") == 0 ||
           std::strcmp(raw, "AUTO") == 0 ||
           std::strcmp(raw, "Auto") == 0;
}

struct CpuThreadRequest {
    int requested_threads = 1;
    int auto_resolved_threads = 0;
    bool auto_requested = false;
};

CpuThreadRequest requested_cpu_threads() {
    if (env_requests_auto_threads("FULLMAG_CPU_THREADS")) {
        return CpuThreadRequest{
            detected_cpu_threads(),
            parse_positive_env_int("FULLMAG_CPU_THREADS_AUTO_RESOLVED").value_or(0),
            true,
        };
    }
    if (const auto from_omp = parse_positive_env_int("OMP_NUM_THREADS")) {
        return CpuThreadRequest{*from_omp, 0, false};
    }
    if (const auto from_fullmag = parse_positive_env_int("FULLMAG_CPU_THREADS")) {
        return CpuThreadRequest{*from_fullmag, 0, false};
    }
    return CpuThreadRequest{detected_cpu_threads(), 0, true};
}

int auto_cpu_thread_cap_for_context(const Context &ctx, int requested_threads) {
    if (requested_threads <= 1 || mfem_device_requests_gpu(ctx)) {
        return std::max(1, requested_threads);
    }
    const uint32_t node_count = ctx.n_nodes;
    const uint32_t element_count = ctx.n_elements;
    if (node_count <= 10000u || element_count <= 75000u) {
        return std::min(requested_threads, 8);
    }
    if (node_count <= 50000u || element_count <= 400000u) {
        return std::min(requested_threads, 16);
    }
    return std::max(1, requested_threads);
}

void configure_cpu_openmp_runtime(Context &ctx) {
    const CpuThreadRequest request = requested_cpu_threads();
    ctx.cpu_threads_auto_requested = request.auto_requested;
    ctx.requested_omp_threads = request.requested_threads;
    ctx.effective_omp_threads = request.requested_threads;
    if (request.auto_requested) {
        ctx.effective_omp_threads = request.auto_resolved_threads > 0
            ? std::min(request.requested_threads, request.auto_resolved_threads)
            : auto_cpu_thread_cap_for_context(ctx, request.requested_threads);
    }
#ifdef _OPENMP
    omp_set_num_threads(ctx.effective_omp_threads);
#endif
}

void log_cpu_runtime_selection(const Context &ctx) {
    if (mfem_device_requests_gpu(ctx)) {
        return;
    }
    const char *thread_mode = ctx.cpu_threads_auto_requested ? "auto" : "manual";

    std::fprintf(
        stderr,
        "[fullmag-fem] cpu runtime: poisson_solver=%s preconditioner=%s cpu_threads=%s requested_omp_threads=%d effective_omp_threads=%d mesh_nodes=%u elements=%u\n",
        demag_poisson_linear_solver_name(ctx.demag_solver.solver),
        demag_poisson_preconditioner_name(ctx.demag_solver.preconditioner),
        thread_mode,
        ctx.requested_omp_threads,
        ctx.effective_omp_threads,
        ctx.n_nodes,
        ctx.n_elements);
}

void debug_checkpoint(const char *stage) {
    if (!env_flag_enabled("FULLMAG_FEM_DEBUG_STARTUP")) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

double dot3(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross3(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

bool has_relax_stop_criteria(const Context &ctx) {
    return ctx.relax_stop.has_torque_tolerance_apm != 0
        || ctx.relax_stop.has_energy_tolerance_j != 0
        || ctx.relax_stop.has_max_steps != 0
        || ctx.relax_stop.has_max_pseudotime_s != 0
        || ctx.relax_stop.has_max_physical_time_s != 0;
}

void set_stage_completion(
    Context &ctx,
    fullmag_fem_stage_stop_reason reason,
    const char *metric_name,
    double metric_value,
    double threshold)
{
    if (ctx.stage_completion.has_reason != 0) {
        return;
    }
    ctx.stage_completion = {};
    ctx.stage_completion.has_reason = 1;
    ctx.stage_completion.reason = reason;
    if (metric_name != nullptr && metric_name[0] != '\0') {
        ctx.stage_completion.has_metric_name = 1;
        std::snprintf(
            ctx.stage_completion.metric_name,
            sizeof(ctx.stage_completion.metric_name),
            "%s",
            metric_name);
    }
    ctx.stage_completion.metric_value = metric_value;
    ctx.stage_completion.threshold = threshold;
}

void update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    if (ctx.stage_completion.has_reason != 0 || !has_relax_stop_criteria(ctx)) {
        return;
    }

    const double previous_energy = ctx.relax_previous_total_energy_j;
    const bool has_previous_energy = ctx.relax_previous_total_energy_valid;
    ctx.relax_previous_total_energy_j = stats.total_energy_joules;
    ctx.relax_previous_total_energy_valid = true;
    ctx.relax_pseudotime_s += std::max(stats.dt_seconds, 0.0);

    const bool torque_ok =
        ctx.relax_stop.has_torque_tolerance_apm == 0 ||
        stats.max_torque_Apm <= ctx.relax_stop.torque_tolerance_apm;

    if (ctx.relax_stop.has_energy_tolerance_j != 0 && has_previous_energy) {
        const double delta_energy =
            std::abs(stats.total_energy_joules - previous_energy);
        if (torque_ok && delta_energy <= ctx.relax_stop.energy_tolerance_j) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_ENERGY,
                "delta_total_energy_J",
                delta_energy,
                ctx.relax_stop.energy_tolerance_j);
            return;
        }
    }
    if (ctx.relax_stop.has_torque_tolerance_apm != 0 &&
        ctx.relax_stop.has_energy_tolerance_j == 0 &&
        stats.max_torque_Apm <= ctx.relax_stop.torque_tolerance_apm) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            "max_torque_Apm",
            stats.max_torque_Apm,
            ctx.relax_stop.torque_tolerance_apm);
        return;
    }
    if (ctx.relax_stop.has_max_physical_time_s != 0 &&
        stats.time_seconds >= ctx.relax_stop.max_physical_time_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME,
            "physical_time_s",
            stats.time_seconds,
            ctx.relax_stop.max_physical_time_s);
        return;
    }
    if (ctx.relax_stop.has_max_pseudotime_s != 0 &&
        ctx.relax_pseudotime_s >= ctx.relax_stop.max_pseudotime_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME,
            "pseudo_time_s",
            ctx.relax_pseudotime_s,
            ctx.relax_stop.max_pseudotime_s);
        return;
    }
    if (ctx.relax_stop.has_max_steps != 0 &&
        stats.step >= ctx.relax_stop.max_steps) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS,
            "steps",
            static_cast<double>(stats.step),
            static_cast<double>(ctx.relax_stop.max_steps));
    }
}

double average_magnetic_scalar_field(
    const std::vector<double> &field,
    const std::vector<uint8_t> &magnetic_node_mask,
    double fallback)
{
    if (field.empty()) {
        return fallback;
    }

    double sum = 0.0;
    size_t count = 0;
    const size_t node_count = std::min(field.size(), magnetic_node_mask.size());
    for (size_t node = 0; node < node_count; ++node) {
        if (magnetic_node_mask[node] == 0u) {
            continue;
        }
        sum += field[node];
        count += 1;
    }
    if (count == 0) {
        return fallback;
    }
    return sum / static_cast<double>(count);
}

std::array<double, 3> average_magnetization_components(const Context &ctx)
{
    std::array<double, 3> sum{};
    uint64_t count = 0;
    const size_t nodes = ctx.m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const size_t base = node * 3u;
        const double mx = ctx.m_xyz[base + 0u];
        const double my = ctx.m_xyz[base + 1u];
        const double mz = ctx.m_xyz[base + 2u];
        if (std::abs(mx) <= 1e-18 && std::abs(my) <= 1e-18 && std::abs(mz) <= 1e-18) {
            continue;
        }
        sum[0] += mx;
        sum[1] += my;
        sum[2] += mz;
        count += 1;
    }
    if (count == 0) {
        return {0.0, 0.0, 0.0};
    }
    const double inv = 1.0 / static_cast<double>(count);
    return {sum[0] * inv, sum[1] * inv, sum[2] * inv};
}

void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    x.resize(n);
    y.resize(n);
    z.resize(n);
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0];
        y[i] = aos[i * 3u + 1];
        z[i] = aos[i * 3u + 2];
    }
}

void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    if (x.size() != n || y.size() != n || z.size() != n) {
        unpack_aos_to_components(aos, x, y, z);
        return;
    }
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0];
        y[i] = aos[i * 3u + 1];
        z[i] = aos[i * 3u + 2];
    }
}

void pack_components_to_aos(
    const std::vector<double> &x,
    const std::vector<double> &y,
    const std::vector<double> &z,
    std::vector<double> &aos)
{
    const size_t n = x.size();
    aos.resize(n * 3u);
    for (size_t i = 0; i < n; ++i) {
        aos[i * 3u + 0] = x[i];
        aos[i * 3u + 1] = y[i];
        aos[i * 3u + 2] = z[i];
    }
}

bool is_fully_magnetic(const Context &ctx) {
    if (ctx.element_markers.empty()) {
        return true;
    }
    const uint32_t first = ctx.element_markers.front();
    return std::all_of(
        ctx.element_markers.begin(),
        ctx.element_markers.end(),
        [first](uint32_t marker) { return marker == first; });
}

uint64_t vector_bytes(const mfem::Vector &vector) {
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

const double *audited_host_read(const mfem::Vector &vector) {
    record_mfem_host_read(vector_bytes(vector));
    return vector.HostRead();
}

double *audited_host_write(mfem::Vector &vector) {
    record_mfem_host_write(vector_bytes(vector));
    return vector.HostWrite();
}

double *audited_host_read_write(mfem::Vector &vector) {
    record_mfem_host_read_write(vector_bytes(vector));
    return vector.HostReadWrite();
}

void copy_host_vector_to_mfem(const std::vector<double> &src, mfem::Vector &dst) {
    dst.SetSize(static_cast<int>(src.size()));
    dst.UseDevice(true);
    double *host = audited_host_write(dst);
    for (size_t i = 0; i < src.size(); ++i) {
        host[static_cast<int>(i)] = src[i];
    }
}

void copy_mfem_vector_to_host(const mfem::Vector &src, std::vector<double> &dst) {
    const int n = src.Size();
    dst.resize(static_cast<size_t>(n));
    const double *host = audited_host_read(src);
    for (int i = 0; i < n; ++i) {
        dst[static_cast<size_t>(i)] = host[i];
    }
}

void project_static_periodic_aos(const Context &ctx, std::vector<double> &field_xyz) {
    if (ctx.periodic_reduced_node.empty()) {
        return;
    }
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        const uint32_t representative = ctx.periodic_representative_nodes[static_cast<size_t>(reduced)];
        const size_t dst = static_cast<size_t>(node) * 3u;
        const size_t src = static_cast<size_t>(representative) * 3u;
        field_xyz[dst + 0u] = field_xyz[src + 0u];
        field_xyz[dst + 1u] = field_xyz[src + 1u];
        field_xyz[dst + 2u] = field_xyz[src + 2u];
    }
}

double dot_host_vectors(const std::vector<double> &a, const std::vector<double> &b) {
    double value = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        value += a[i] * b[i];
    }
    return value;
}

double vector_norm3(double x, double y, double z) {
    return std::sqrt(x * x + y * y + z * z);
}

// ── S17: PI controller for adaptive time stepping ─────────────────────
// Given the local error estimate `error_norm` (0-based, 1 = at tolerance),
// computes the next dt using a PI controller:
//   dt_new = dt * safety * (1/error)^α * (prev_error/error)^β
//
// Returns the accepted/rejected status and the proposed new dt.
struct AdaptiveResult {
    bool accepted;
    double dt_next;
};

AdaptiveResult adaptive_pi_step(Context &ctx, double error_norm) {
    if (!ctx.adaptive_dt_enabled || error_norm <= 0.0) {
        return {true, ctx.dt_seconds};
    }

    const double clamped_error = std::max(error_norm, 1e-15);

    if (clamped_error <= 1.0) {
        // Accepted step — compute growth ratio
        double ratio = ctx.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.pi_alpha) *
                       std::pow(ctx.prev_error_norm / clamped_error, ctx.pi_beta);
        ratio = std::min(ratio, ctx.dt_grow_max);
        ratio = std::max(ratio, 1.0);  // never shrink on accept

        const double dt_new = std::min(ctx.dt_seconds * ratio, ctx.dt_max);
        ctx.prev_error_norm = clamped_error;
        return {true, dt_new};
    } else {
        // Rejected step — shrink dt and retry
        double ratio = ctx.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.pi_alpha);
        ratio = std::max(ratio, ctx.dt_shrink_min);

        const double dt_new = std::max(ctx.dt_seconds * ratio, ctx.dt_min);
        ctx.rejected_steps += 1;
        return {false, dt_new};
    }
}

void normalize_aos_field(std::vector<double> &m_xyz) {
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

double max_norm_aos(const std::vector<double> &field_xyz) {
    double max_value = 0.0;
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        max_value = std::max(
            max_value,
            vector_norm3(field_xyz[base + 0], field_xyz[base + 1], field_xyz[base + 2]));
    }
    return max_value;
}

double max_cross_norm_aos(const std::vector<double> &a_xyz,
                          const std::vector<double> &b_xyz) {
    double max_value = 0.0;
    const size_t n = a_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        double cx = a_xyz[base+1]*b_xyz[base+2] - a_xyz[base+2]*b_xyz[base+1];
        double cy = a_xyz[base+2]*b_xyz[base+0] - a_xyz[base+0]*b_xyz[base+2];
        double cz = a_xyz[base+0]*b_xyz[base+1] - a_xyz[base+1]*b_xyz[base+0];
        max_value = std::max(max_value, std::sqrt(cx*cx + cy*cy + cz*cz));
    }
    return max_value;
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

bool compute_effective_fields_for_magnetization_impl(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> &h_demag_xyz,
    std::vector<double> &h_eff_xyz,
    double *exchange_energy,
    double *demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    if (ctx.enable_exchange) {
        h_ex_xyz.resize(m_xyz.size());
    } else {
        h_ex_xyz.assign(m_xyz.size(), 0.0);
    }
    if (ctx.enable_demag) {
        h_demag_xyz.resize(m_xyz.size());
    } else {
        h_demag_xyz.assign(m_xyz.size(), 0.0);
    }
    h_eff_xyz.resize(m_xyz.size());

    double exchange = 0.0;
    if (ctx.enable_exchange) {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->exchange_wall_time_ns : nullptr);
        if (!compute_exchange_for_magnetization(
                ctx,
                m_xyz,
                h_ex_xyz,
                nullptr,
                exchange_energy != nullptr ? &exchange : nullptr,
                allow_interrupt,
                error))
        {
            return false;
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
    }

    double demag = 0.0;
    if (ctx.enable_demag) {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->demag.wall_time_ns : nullptr);
        DemagFieldUpdateDecision demag_decision{};
        if (!plan_demag_field_update(ctx, demag_decision, error)) {
            return false;
        }
        switch (demag_decision.action) {
            case DemagFieldUpdateAction::FreshFemBemSolve:
                if (!context_compute_demag_fem_bem(
                        ctx, m_xyz, h_demag_xyz, demag, allow_interrupt, timings, error)) {
                    return false;
                }
                break;
            case DemagFieldUpdateAction::FreshPoissonSolve:
                if (!context_compute_demag_poisson(
                        ctx, m_xyz, h_demag_xyz, demag, allow_interrupt, timings, error)) {
                    return false;
                }
                break;
            case DemagFieldUpdateAction::UseCachedField:
                if (demag_poisson_try_load_cached_field(ctx, h_demag_xyz)) {
                    demag = demag_poisson_cached_energy_from_field(
                        ctx,
                        m_xyz,
                        h_demag_xyz,
                        ctx.effective_omp_threads);
                }
                break;
        }
        if (demag_decision.store_refreshed_field_cache) {
            demag_poisson_store_refreshed_field_cache(ctx, h_demag_xyz);
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
    }

    {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->extra_energy_wall_time_ns : nullptr);
        double anisotropy_energy = 0.0;
        if (ctx.enable_anisotropy) {
            compute_uniaxial_anisotropy_field(
                ctx, m_xyz, ctx.h_ani_xyz,
                &anisotropy_energy);
            // Project anisotropy field onto periodic classes so all nodes in
            // the same class carry the same value (local term, so this is safe).
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_ani_xyz);
            }
        } else {
            ctx.h_ani_xyz.assign(m_xyz.size(), 0.0);
        }

        double dmi = 0.0;
        if (ctx.enable_dmi) {
            if (!compute_interfacial_dmi_field(
                    ctx, m_xyz, ctx.h_dmi_xyz, &dmi, error)) {
                return false;
            }
            // Project interfacial DMI field onto periodic classes.
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_dmi_xyz);
            }
        }

        // F-03 fix: compute cubic anisotropy and add to H_eff.
        if (ctx.enable_cubic_anisotropy) {
            double cubic_energy = 0.0;
            compute_cubic_anisotropy_field(
                ctx, m_xyz, ctx.h_cubic_ani_xyz, &cubic_energy);
            anisotropy_energy += cubic_energy;
            // Same periodic projection for cubic anisotropy.
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_cubic_ani_xyz);
            }
        }

        // F-03/F-07 fix: compute bulk DMI and add to H_eff.
        // FEM-027 fix: persist bulk DMI field in context for readback.
        double bulk_dmi = 0.0;
        if (ctx.enable_bulk_dmi) {
            if (!compute_bulk_dmi_field(
                    ctx, m_xyz, ctx.h_bulk_dmi_xyz, &bulk_dmi, error)) {
                return false;
            }
            // Project bulk DMI field onto periodic classes.
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_bulk_dmi_xyz);
            }
        }

        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            h_eff_xyz[i] = h_ex_xyz[i] + h_demag_xyz[i] +
                           ctx.h_ani_xyz[i] + ctx.h_dmi_xyz[i] +
                           ctx.h_cubic_ani_xyz[i];
        }
        add_zeeman_field(ctx, h_eff_xyz);

        // Add bulk DMI to H_eff
        if (ctx.enable_bulk_dmi && !ctx.h_bulk_dmi_xyz.empty()) {
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += ctx.h_bulk_dmi_xyz[i];
            }
        }

        add_oersted_field(ctx, h_eff_xyz);

        // F-09 fix: add thermal noise to H_eff per step.
        if (ctx.temperature > 0.0) {
            refresh_thermal_brown_field(ctx);
            add_thermal_brown_field(ctx, h_eff_xyz);
        }

        // Add magnetoelastic field
        double magnetoelastic_energy = 0.0;
        if (ctx.enable_magnetoelastic) {
            compute_magnetoelastic_field(ctx, m_xyz);
            magnetoelastic_energy = ctx.mel_energy;
            add_magnetoelastic_field(ctx, h_eff_xyz);
        }
        // After all local terms are assembled, project H_eff onto periodic
        // classes.  This removes floating-point rounding mismatches between
        // paired nodes that could otherwise accumulate over many steps.
        if (!ctx.periodic_reduced_node.empty()) {
            project_static_periodic_aos(ctx, h_eff_xyz);
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
        ctx.last_anisotropy_energy_joules = anisotropy_energy;
        ctx.last_dmi_energy_joules = dmi + bulk_dmi;
        ctx.last_magnetoelastic_energy_joules = magnetoelastic_energy;
    }

    update_demag_poisson_visual_effective_field(ctx, h_eff_xyz, h_demag_xyz);

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange;
    }
    if (demag_energy != nullptr) {
        *demag_energy = demag;
    }

    return true;
}

void fill_demag_solver_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats)
{
    fill_demag_poisson_solver_stats(ctx, stats);
    // Thread provenance: filled from context each step for telemetry.
    stats.requested_omp_threads = ctx.requested_omp_threads;
    stats.effective_omp_threads = ctx.effective_omp_threads;
}

void fill_common_step_metrics(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    double max_rhs,
    PhaseTimings *timings)
{
    ScopedPhaseTimer timer(timings != nullptr ? &timings->extra_energy_wall_time_ns : nullptr);

    stats.external_energy_joules = zeeman_energy_from_field(ctx, ctx.m_xyz);
    stats.anisotropy_energy_joules = ctx.last_anisotropy_energy_joules;
    stats.dmi_energy_joules = ctx.last_dmi_energy_joules;
    stats.magnetoelastic_energy_joules = ctx.last_magnetoelastic_energy_joules;

    stats.total_energy_joules =
        stats.exchange_energy_joules + stats.demag_energy_joules +
        stats.external_energy_joules + stats.anisotropy_energy_joules +
        stats.dmi_energy_joules + stats.magnetoelastic_energy_joules;
    stats.max_effective_field_amplitude = max_norm_aos(ctx.h_eff_xyz);
    stats.max_demag_field_amplitude = max_norm_aos(ctx.h_demag_xyz);
    stats.max_rhs_amplitude = max_rhs;
    stats.max_torque_Apm = max_cross_norm_aos(ctx.m_xyz, ctx.h_eff_xyz);
    const auto average = average_magnetization_components(ctx);
    stats.mx = average[0];
    stats.my = average[1];
    stats.mz = average[2];
    fill_demag_solver_stats(ctx, stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Poisson demag: ∇²u = ∇·M on Ω_m ∪ Ω_air  (S02–S05)
// ─────────────────────────────────────────────────────────────────────────────

} // namespace

bool compute_effective_fields_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> &h_demag_xyz,
    std::vector<double> &h_eff_xyz,
    double *exchange_energy,
    double *demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    return compute_effective_fields_for_magnetization_impl(
        ctx,
        m_xyz,
        h_ex_xyz,
        h_demag_xyz,
        h_eff_xyz,
        exchange_energy,
        demag_energy,
        allow_interrupt,
        timings,
        error);
}

void context_update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    update_stage_completion_from_stats(ctx, stats);
}

bool context_initialize_mfem(Context &ctx, std::string &error) {
    try {
        debug_checkpoint("context_initialize_mfem:enter");
        // mfem::Device is a process-global singleton; creating it more than once
        // triggers an abort ("mfem::Device is already configured!").  We use
        // std::call_once so that multi-stage simulations AND parallel test
        // threads share the same device safely.
        static std::once_flag s_mfem_device_once;
#if FULLMAG_HAS_CUDA_RUNTIME
        // FEM-030: use plan override > env var > compiled default.
        const char *device_config = configured_mfem_device_string(ctx);
        const bool use_gpu_device = is_gpu_device_string(device_config);
        if (use_gpu_device) {
            // FEM-029: honour explicit gpu_device_index from the plan; fall
            // back to the env-var path, then to device 0.
            const int selected_device = (ctx.gpu_device_index >= 0)
                ? ctx.gpu_device_index
                : selected_cuda_device_from_env().value_or(0);
            int device_count = 0;
            cudaError_t cuda_err = cudaGetDeviceCount(&device_count);
            if (cuda_err != cudaSuccess || device_count <= 0) {
                error = "MFEM CUDA backend requested but no CUDA device is available";
                return false;
            }
            if (selected_device < 0 || selected_device >= device_count) {
                error = "requested FEM GPU device index is out of range";
                return false;
            }
            cuda_err = cudaSetDevice(selected_device);
            if (cuda_err != cudaSuccess) {
                error = std::string("cudaSetDevice failed for native FEM backend: ") +
                        cudaGetErrorString(cuda_err);
                return false;
            }
            std::call_once(s_mfem_device_once, [&, device_config]() {
                ctx.mfem_device = new mfem::Device(device_config);
            });
            ctx.mfem_selected_device_index = selected_device;

            // S12: Create prioritized CUDA streams
            int low_priority = 0, high_priority = 0;
            cudaDeviceGetStreamPriorityRange(&low_priority, &high_priority);
            cudaStream_t cs{}, ios{};
            cudaStreamCreateWithPriority(&cs, cudaStreamNonBlocking, high_priority);
            cudaStreamCreateWithPriority(&ios, cudaStreamNonBlocking, low_priority);
            ctx.compute_stream = reinterpret_cast<void *>(cs);
            ctx.io_stream = reinterpret_cast<void *>(ios);
            cudaEvent_t ev{};
            cudaEventCreateWithFlags(&ev, cudaEventDisableTiming);
            ctx.compute_event = reinterpret_cast<void *>(ev);
        } else {
            configure_cpu_openmp_runtime(ctx);
            // Phase-0B fix: pass the original host device string (e.g. "omp",
            // "ceed-cpu") to MFEM instead of hard-coding "cpu".
            const char *host_device = (device_config != nullptr && *device_config != '\0')
                ? device_config : "cpu";
            std::call_once(s_mfem_device_once, [&ctx, host_device]() {
                ctx.mfem_device = new mfem::Device(host_device);
            });
            ctx.mfem_selected_device_index = -1;
            log_cpu_runtime_selection(ctx);
        }
#else
        configure_cpu_openmp_runtime(ctx);
        std::call_once(s_mfem_device_once, [&ctx]() {
            ctx.mfem_device = new mfem::Device("cpu");
        });
        ctx.mfem_selected_device_index = -1;
        log_cpu_runtime_selection(ctx);
#endif

        debug_checkpoint("context_initialize_mfem:device_ready");
        auto *mesh = new mfem::Mesh(3, static_cast<int>(ctx.n_nodes), static_cast<int>(ctx.n_elements),
                                    static_cast<int>(ctx.n_boundary_faces), 3);

        for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
            const double *coords = ctx.nodes_xyz.data() + static_cast<size_t>(i) * 3u;
            mesh->AddVertex(coords);
        }

        for (uint32_t i = 0; i < ctx.n_elements; ++i) {
            const int *ignored = nullptr;
            (void)ignored;
            const uint32_t *tet = ctx.elements.data() + static_cast<size_t>(i) * 4u;
            const int vi[4] = {
                static_cast<int>(tet[0]),
                static_cast<int>(tet[1]),
                static_cast<int>(tet[2]),
                static_cast<int>(tet[3]),
            };
            // MFEM attributes must be >= 1.  Our markers: 1 = magnetic, 0 = air.
            // Map: marker 0 -> attr 2 (air), marker 1 -> attr 1 (magnetic).
            // Any other marker m -> attr m (unchanged, already >= 1).
            int attr = 1;
            if (!ctx.element_markers.empty()) {
                const uint32_t marker = ctx.element_markers[static_cast<size_t>(i)];
                attr = marker == 0u ? 2 : static_cast<int>(marker);
            }
            mesh->AddTet(vi, attr);
        }

        for (uint32_t i = 0; i < ctx.n_boundary_faces; ++i) {
            const uint32_t *tri = ctx.boundary_faces.data() + static_cast<size_t>(i) * 3u;
            const int vi[3] = {
                static_cast<int>(tri[0]),
                static_cast<int>(tri[1]),
                static_cast<int>(tri[2]),
            };
            const int attr = ctx.boundary_markers.empty()
                ? 1
                : static_cast<int>(ctx.boundary_markers[static_cast<size_t>(i)]);
            mesh->AddBdrTriangle(vi, attr);
        }

        mesh->FinalizeTopology();
        mesh->Finalize(false, true);
        debug_checkpoint("context_initialize_mfem:mesh_ready");

        auto *fec = new mfem::H1_FECollection(static_cast<int>(ctx.fe_order), mesh->Dimension());
        auto *fes = new mfem::FiniteElementSpace(mesh, fec);
        debug_checkpoint("context_initialize_mfem:fes_ready");

        if (fes->GetNDofs() != static_cast<int>(ctx.n_nodes)) {
            error = "MFEM H1 P1 space DOF count does not match node count";
            delete fes;
            delete fec;
            delete mesh;
            return false;
        }

        unpack_aos_to_components(ctx.m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);
        auto *gf_mx = new mfem::GridFunction(fes);
        auto *gf_my = new mfem::GridFunction(fes);
        auto *gf_mz = new mfem::GridFunction(fes);
        auto *gf_a = new mfem::GridFunction(fes);
        auto *gf_ms = new mfem::GridFunction(fes);
        auto *a_coeff = new mfem::GridFunctionCoefficient(gf_a);
        // S09: enable device memory so that future GPU operators find data
        // already on device without extra H2D copies.
        gf_mx->UseDevice(true);
        gf_my->UseDevice(true);
        gf_mz->UseDevice(true);
        gf_a->UseDevice(true);
        gf_ms->UseDevice(true);
        double *mx_host = audited_host_write(*gf_mx);
        double *my_host = audited_host_write(*gf_my);
        double *mz_host = audited_host_write(*gf_mz);
        double *a_host = audited_host_write(*gf_a);
        double *ms_host = audited_host_write(*gf_ms);
        for (int i = 0; i < fes->GetNDofs(); ++i) {
            mx_host[i] = ctx.mfem_mx[static_cast<size_t>(i)];
            my_host[i] = ctx.mfem_my[static_cast<size_t>(i)];
            mz_host[i] = ctx.mfem_mz[static_cast<size_t>(i)];
            a_host[i] = scalar_field_value(
                ctx.A_field,
                static_cast<size_t>(i),
                ctx.material.exchange_stiffness);
            ms_host[i] = scalar_field_value(
                ctx.Ms_field,
                static_cast<size_t>(i),
                ctx.material.saturation_magnetisation);
        }

        if (!initialize_exchange_operator_mfem(ctx, *mesh, *fes, *a_coeff, error)) {
            delete a_coeff;
            delete gf_ms;
            delete gf_a;
            delete gf_mx;
            delete gf_my;
            delete gf_mz;
            delete fes;
            delete fec;
            delete mesh;
            return false;
        }
        debug_checkpoint("context_initialize_mfem:exchange_operator_ready");
        ctx.mfem_mesh = mesh;
        ctx.mfem_fec = fec;
        ctx.mfem_fes = fes;
        ctx.mfem_gf_mx = gf_mx;
        ctx.mfem_gf_my = gf_my;
        ctx.mfem_gf_mz = gf_mz;
        ctx.mfem_gf_a = gf_a;
        ctx.mfem_gf_ms = gf_ms;
        ctx.mfem_a_coeff = a_coeff;
        ctx.mfem_ready = true;
        debug_checkpoint("context_initialize_mfem:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("MFEM mesh/space initialization failed: ") + ex.what();
    } catch (...) {
        error = "MFEM mesh/space initialization failed with an unknown error";
    }

    context_destroy_mfem(ctx);
    return false;
}

bool context_upload_mfem_exchange_to_gpu_state(Context &ctx, std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "legacy sparse exchange GPU upload requested before MFEM context initialization";
        return false;
    }
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    if (exchange_form == nullptr) {
        error = "legacy sparse exchange GPU upload requested without MFEM exchange form";
        return false;
    }
    if (!upload_legacy_sparse_exchange_to_gpu_state(
            ctx,
            exchange_form->SpMat(),
            error)) {
        error = "legacy sparse exchange GPU upload failed: " + error;
        return false;
    }
    return true;
}

void context_destroy_mfem(Context &ctx) {
    // Destroy demag resources first.
    context_destroy_demag_fem_bem(ctx);
    context_destroy_poisson(ctx);

    destroy_dmi_workspace(ctx);

    // NOTE: mfem::Device is a process-global singleton — do NOT delete it here,
    // because a subsequent NativeFemBackend may need the already-configured device.
    delete static_cast<mfem::Coefficient *>(ctx.mfem_a_coeff);
    delete static_cast<mfem::Vector *>(ctx.mfem_exchange_out_vec);
    delete static_cast<mfem::Vector *>(ctx.mfem_exchange_tmp_vec);
    delete static_cast<mfem::Vector *>(ctx.mfem_inv_lumped_mass);
    delete static_cast<mfem::Vector *>(ctx.mfem_mass_lumped);
    delete static_cast<mfem::Vector *>(ctx.mfem_mass_ones);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_ms);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_a);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_fec);
    delete static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    ctx.mfem_device = nullptr;
    ctx.mfem_mass_form = nullptr;
    ctx.mfem_exchange_form = nullptr;
    ctx.mfem_a_coeff = nullptr;
    ctx.mfem_exchange_out_vec = nullptr;
    ctx.mfem_exchange_tmp_vec = nullptr;
    ctx.mfem_inv_lumped_mass = nullptr;
    ctx.mfem_mass_lumped = nullptr;
    ctx.mfem_mass_ones = nullptr;
    ctx.mfem_gf_ms = nullptr;
    ctx.mfem_gf_a = nullptr;
    ctx.mfem_gf_mz = nullptr;
    ctx.mfem_gf_my = nullptr;
    ctx.mfem_gf_mx = nullptr;
    ctx.mfem_fes = nullptr;
    ctx.mfem_fec = nullptr;
    ctx.mfem_mesh = nullptr;
    ctx.mfem_ready = false;
    ctx.mfem_exchange_ready = false;
    ctx.gpu_exchange_legacy_sparse_metadata_ready = false;
    ctx.gpu_exchange_legacy_sparse_rows = 0;
    ctx.gpu_exchange_legacy_sparse_cols = 0;
    ctx.gpu_exchange_legacy_sparse_nnz = 0;
    ctx.gpu_exchange_lumped_mass_ready = false;

    // S12: Destroy CUDA streams and events
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.compute_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.compute_stream));
        ctx.compute_stream = nullptr;
    }
    if (ctx.io_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.io_stream));
        ctx.io_stream = nullptr;
    }
    if (ctx.compute_event != nullptr) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.compute_event));
        ctx.compute_event = nullptr;
    }
    // S13: Free pinned snapshot buffers
    for (auto &buf : ctx.pinned_snapshot) {
        if (buf != nullptr) {
            cudaFreeHost(buf);
            buf = nullptr;
        }
    }
    ctx.pinned_snapshot_bytes = 0;
#endif
}

bool context_snapshot_stats_mfem(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM snapshot requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_effective_field_term(ctx)) {
        error = "native FEM snapshot requires at least one effective-field term";
        return false;
    }
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return false;
    }

    std::vector<double> h_ex_current;
    std::vector<double> h_demag_current;
    std::vector<double> h_eff_current;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            h_ex_current,
            h_demag_current,
            h_eff_current,
            &exchange_energy,
            &demag_energy,
            false,
            &timings,
            error)) {
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    ctx.h_ex_xyz = std::move(h_ex_current);
    ctx.h_demag_xyz = std::move(h_demag_current);
    ctx.h_eff_xyz = std::move(h_eff_current);
    ctx.mfem_exchange_ready = true;

    std::vector<double> rhs_current;
    double max_rhs_current = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            ctx.h_eff_xyz,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            rhs_current,
            max_rhs_current);
        add_stt_rhs_aos(ctx, ctx.m_xyz, rhs_current, max_rhs_current);
        zero_non_magnetic_nodes_aos(rhs_current, ctx.magnetic_node_mask);
        max_rhs_current = max_norm_aos(rhs_current);
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = 0.0;
    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = demag_energy;
    fill_common_step_metrics(ctx, stats, max_rhs_current, &timings);
    timings.snapshot_wall_time_ns = elapsed_ns(wall_start);
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = timings.snapshot_wall_time_ns;
    return true;
}

bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_effective_field_term(ctx)) {
        error = "native FEM stepper requires at least one effective-field term to be enabled";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }
    ctx.current_dt = dt_seconds;

    std::vector<double> h_ex_now;
    std::vector<double> h_demag_now;
    std::vector<double> h_eff_now;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            h_ex_now,
            h_demag_now,
            h_eff_now,
            &exchange_energy,
            &demag_energy,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }

    std::vector<double> k1;
    double max_rhs_k1 = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            h_eff_now,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            k1,
            max_rhs_k1);
        add_stt_rhs_aos(ctx, ctx.m_xyz, k1, max_rhs_k1);
        zero_non_magnetic_nodes_aos(k1, ctx.magnetic_node_mask);
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> predicted = ctx.m_xyz;
    for (size_t i = 0; i < predicted.size(); ++i) {
        predicted[i] += dt_seconds * k1[i];
    }
    normalize_aos_field(predicted);
    project_static_periodic_aos(ctx, predicted);

    std::vector<double> h_ex_pred;
    std::vector<double> h_demag_pred;
    std::vector<double> h_eff_pred;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            predicted,
            h_ex_pred,
            h_demag_pred,
            h_eff_pred,
            nullptr,
            nullptr,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> k2;
    double max_rhs_k2 = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            predicted,
            h_eff_pred,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            k2,
            max_rhs_k2);
        add_stt_rhs_aos(ctx, predicted, k2, max_rhs_k2);
        zero_non_magnetic_nodes_aos(k2, ctx.magnetic_node_mask);
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> corrected = ctx.m_xyz;
    for (size_t i = 0; i < corrected.size(); ++i) {
        corrected[i] += 0.5 * dt_seconds * (k1[i] + k2[i]);
    }
    normalize_aos_field(corrected);
    project_static_periodic_aos(ctx, corrected);

    std::vector<double> h_ex_final;
    std::vector<double> h_demag_final;
    std::vector<double> h_eff_final;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            corrected,
            h_ex_final,
            h_demag_final,
            h_eff_final,
            &exchange_energy_final,
            &demag_energy_final,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    ctx.m_xyz = std::move(corrected);
    ctx.h_ex_xyz = std::move(h_ex_final);
    ctx.h_demag_xyz = std::move(h_demag_final);
    ctx.h_eff_xyz = std::move(h_eff_final);
    ctx.current_time += dt_seconds;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Compute post-step RHS from final corrected state (matches CPU metric).
    std::vector<double> rhs_final;
    double max_rhs_final = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            ctx.h_eff_xyz,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            rhs_final,
            max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, rhs_final, max_rhs_final);
        zero_non_magnetic_nodes_aos(rhs_final, ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(rhs_final);
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt_seconds;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.error_estimate = 0.0;
    stats.rejected_attempts = 0;
    stats.dt_suggested = 0.0;
    stats.rhs_evaluations = 2;
    stats.fsal_reused = 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    update_stage_completion_from_stats(ctx, stats);

    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified explicit Runge-Kutta engine (Butcher tableau-driven)
// ═══════════════════════════════════════════════════════════════════════════

// evaluate_rhs: compute H_eff for state m_state, then LLG RHS into out_k
static bool evaluate_rhs(
    Context &ctx,
    const std::vector<double> &m_state,
    StepperWorkspace &ws,
    std::vector<double> &out_k,
    double *out_max_rhs,
    double *out_exchange_energy,
    double *out_demag_energy,
    PhaseTimings *timings,
    std::string &error)
{
    if (!compute_effective_fields_for_magnetization(
            ctx, m_state, ws.h_ex_tmp, ws.h_demag_tmp, ws.h_eff_tmp,
            out_exchange_energy, out_demag_energy, true, timings, error)) {
        return false;
    }
    double max_rhs = 0.0;
    {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->rhs_wall_time_ns : nullptr);
        llg_rhs_aos(m_state, ws.h_eff_tmp,
                    ctx.material.gyromagnetic_ratio, ctx.material.damping,
                    ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
                    out_k, max_rhs);
        add_stt_rhs_aos(ctx, m_state, out_k, max_rhs);
        zero_non_magnetic_nodes_aos(out_k, ctx.magnetic_node_mask);
    }
    if (out_max_rhs) *out_max_rhs = max_rhs;
    return true;
}

// Compute the weighted error norm for adaptive stepping:
// norm = max_i |err_i| / (atol + rtol * max(|m_old_i|, |m_new_i|))
static double compute_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol, double rtol)
{
    double max_scaled = 0.0;
    const size_t n = err.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t b = i * 3u;
        for (int d = 0; d < 3; ++d) {
            const double scale = atol + rtol * std::max(std::abs(m_old[b+d]), std::abs(m_new[b+d]));
            max_scaled = std::max(max_scaled, std::abs(err[b+d]) / scale);
        }
    }
    return max_scaled;
}

bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_effective_field_term(ctx)) {
        error = "native FEM stepper requires at least one effective-field term";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }

    if ((ctx.integrator == FULLMAG_FEM_INTEGRATOR_HEUN && tab.stages == 2) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK4 && tab.stages == 4) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS && tab.stages == 4) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54 && tab.stages == 7)) {
        std::string gpu_rk_reason;
        const auto gpu_rk_plan = gpu_rk_plan_exchange_only(ctx, gpu_rk_reason);
        if (gpu_rk_plan.enabled) {
            if (!gpu_rk_exchange_only_step(ctx, tab, dt_seconds, stats, gpu_rk_reason)) {
                error = gpu_rk_reason;
                return false;
            }
            stats.wall_time_ns = elapsed_ns(wall_start);
            return true;
        }
    }

    ctx.current_dt = dt_seconds;

    const size_t dof_len = ctx.m_xyz.size();
    stepper_workspace_allocate(ctx.stepper, dof_len, tab.stages);
    auto &ws = ctx.stepper;

    const bool adaptive = (tab.order_est > 0) && ctx.adaptive_dt_enabled;
    double dt = dt_seconds;
    uint32_t rejected = 0;
    uint32_t total_rhs = 0;
    bool fsal_used = false;
    bool final_stage_cache_valid = false;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;

    // Outer accept/reject loop (runs once for non-adaptive)
    for (;;) {
        ctx.current_dt = dt;
        // Save m_backup
        ws.m_backup = ctx.m_xyz;
        final_stage_cache_valid = false;

        // Stage 0: evaluate or reuse FSAL
        if (tab.fsal && ws.fsal_valid) {
            // k[0] already holds the RHS from previous accepted step
            fsal_used = true;
        } else {
            double exchange_energy_s0 = 0.0;
            double demag_energy_s0 = 0.0;
            if (!evaluate_rhs(
                    ctx,
                    ctx.m_xyz,
                    ws,
                    ws.k[0],
                    nullptr,
                    &exchange_energy_s0,
                    &demag_energy_s0,
                    &timings,
                    error)) {
                if (ctx.step_interrupted) {
                    ctx.m_xyz = ws.m_backup;
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            total_rhs += 1;
        }
        if (poll_interrupt(ctx)) {
            ctx.m_xyz = ws.m_backup;
            ws.fsal_valid = false;
            return true;
        }

        // Stages 1..s-1
        for (int s = 1; s < tab.stages; ++s) {
            // m_stage = m_backup + dt * sum_j(a[s][j] * k[j])
            for (size_t i = 0; i < dof_len; ++i) {
                double accum = 0.0;
                for (int j = 0; j < s; ++j) {
                    accum += tab.a[s][j] * ws.k[j][i];
                }
                ws.m_stage[i] = ws.m_backup[i] + dt * accum;
            }
            normalize_aos_field(ws.m_stage);
            project_static_periodic_aos(ctx, ws.m_stage);

            double *stage_exchange_energy = nullptr;
            double *stage_demag_energy = nullptr;
            if (tab.fsal && s == tab.stages - 1) {
                stage_exchange_energy = &exchange_energy_final;
                stage_demag_energy = &demag_energy_final;
            }
            if (!evaluate_rhs(ctx, ws.m_stage, ws, ws.k[s],
                              nullptr,
                              stage_exchange_energy,
                              stage_demag_energy,
                              &timings,
                              error)) {
                if (ctx.step_interrupted) {
                    ctx.m_xyz = ws.m_backup;
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            if (poll_interrupt(ctx)) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            if (tab.fsal && s == tab.stages - 1) {
                final_stage_cache_valid = true;
            }
            total_rhs += 1;
        }

        // High-order solution: m_new = m_backup + dt * sum(b_hi[s] * k[s])
        for (size_t i = 0; i < dof_len; ++i) {
            double accum = 0.0;
            for (int s = 0; s < tab.stages; ++s) {
                accum += tab.b_hi[s] * ws.k[s][i];
            }
            ctx.m_xyz[i] = ws.m_backup[i] + dt * accum;
        }
        normalize_aos_field(ctx.m_xyz);
        project_static_periodic_aos(ctx, ctx.m_xyz);
        if (poll_interrupt(ctx)) {
            ctx.m_xyz = ws.m_backup;
            ws.fsal_valid = false;
            return true;
        }

        // For adaptive methods, compute error estimate
        if (adaptive) {
            for (size_t i = 0; i < dof_len; ++i) {
                double err_accum = 0.0;
                for (int s = 0; s < tab.stages; ++s) {
                    err_accum += (tab.b_hi[s] - tab.b_lo[s]) * ws.k[s][i];
                }
                ws.err[i] = dt * err_accum;
            }
            double err_norm = compute_error_norm(ws.err, ws.m_backup, ctx.m_xyz,
                                                  ctx.adaptive_atol, ctx.adaptive_rtol);
            auto result = adaptive_pi_step(ctx, err_norm);
            if (!result.accepted) {
                // Reject: restore, shrink dt, retry
                ctx.m_xyz = ws.m_backup;
                dt = result.dt_next;
                ctx.dt_seconds = dt;
                ctx.current_dt = dt;
                ws.fsal_valid = false;
                rejected += 1;
                if (rejected > ctx.max_reject) {
                    error = "adaptive RK exceeded adaptive_config.max_reject rejected attempts before accepting a step";
                    return false;
                }
                continue;
            }
            if (poll_interrupt(ctx)) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            stats.error_estimate = err_norm;
            stats.dt_suggested = result.dt_next;
            ctx.dt_seconds = result.dt_next;
        } else {
            stats.error_estimate = 0.0;
            stats.dt_suggested = dt;
        }

        // Accept: FSAL cache for next step
        if (tab.fsal) {
            // Last stage k[stages-1] evaluated at c=1 becomes k[0] of next step
            std::swap(ws.k[0], ws.k[tab.stages - 1]);
            ws.fsal_valid = true;
        } else {
            ws.fsal_valid = false;
        }

        break; // accepted
    }

    if (final_stage_cache_valid) {
        // FSAL tableaux used here evaluate the last stage at c=1 using the same
        // state as the accepted high-order solution, so we can reuse the cached
        // H_ex/H_demag/H_eff and avoid a full post-step recompute.
        std::swap(ctx.h_ex_xyz, ws.h_ex_tmp);
        std::swap(ctx.h_demag_xyz, ws.h_demag_tmp);
        std::swap(ctx.h_eff_xyz, ws.h_eff_tmp);
    } else {
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                ws.h_ex_tmp,
                ws.h_demag_tmp,
                ws.h_eff_tmp,
                &exchange_energy_final,
                &demag_energy_final,
                true,
                &timings,
                error)) {
            if (ctx.step_interrupted) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            return false;
        }
        std::swap(ctx.h_ex_xyz, ws.h_ex_tmp);
        std::swap(ctx.h_demag_xyz, ws.h_demag_tmp);
        std::swap(ctx.h_eff_xyz, ws.h_eff_tmp);
    }
    ctx.current_time += dt;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Post-step RHS for max_dm_dt metric
    double max_rhs_final = 0.0;
    if (final_stage_cache_valid) {
        max_rhs_final = max_norm_aos(ws.k[0]);
    } else {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(ctx.m_xyz, ctx.h_eff_xyz,
                    ctx.material.gyromagnetic_ratio, ctx.material.damping,
                    ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
                    ws.k[0], max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, ws.k[0], max_rhs_final);
        zero_non_magnetic_nodes_aos(ws.k[0], ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(ws.k[0]);
        total_rhs += 1;
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.rejected_attempts = rejected;
    stats.rhs_evaluations = total_rhs;
    stats.fsal_reused = fsal_used ? 1 : 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    update_stage_completion_from_stats(ctx, stats);

    return true;
}

} // namespace fullmag::fem
