#include "context.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <limits>
#include <mutex>
#include <optional>
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

// Declared outside the anonymous namespace so that context.cpp can forward-declare
// and call this struct/function across translation units.
struct PhaseTimings {
    uint64_t exchange_wall_time_ns = 0;
    uint64_t demag_wall_time_ns = 0;
    uint64_t rhs_wall_time_ns = 0;
    uint64_t extra_energy_wall_time_ns = 0;
    uint64_t snapshot_wall_time_ns = 0;
};

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
    stats.demag_wall_time_ns = timings.demag_wall_time_ns;
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

Vec3 add3(const Vec3 &a, const Vec3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

Vec3 sub3(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vec3 scale3(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

} // namespace

const char *configured_mfem_device_string() {
    const char *raw = std::getenv("FULLMAG_FEM_MFEM_DEVICE");
    if (raw != nullptr && *raw != '\0') {
        return raw;
    }
    // Prefer plain CUDA as a safe default for managed host runtimes.
    // Some CEED-enabled builds may not ship /gpu/cuda/shared at runtime.
    return "cuda";
}

// FEM-030: plan override > env var > compiled default.
const char *configured_mfem_device_string(const Context &ctx) {
    if (!ctx.mfem_device_string_override.empty()) {
        return ctx.mfem_device_string_override.c_str();
    }
    return configured_mfem_device_string();
}

// Phase-0B fix: classify MFEM device strings into GPU-like and CPU-like
// families instead of treating everything ≠ "cpu" as GPU.
bool is_gpu_device_string(const char *device) {
    if (device == nullptr || *device == '\0') {
        return true; // default: GPU
    }
    // Known GPU-like device strings
    if (std::strcmp(device, "cuda") == 0 ||
        std::strcmp(device, "hip") == 0 ||
        std::strncmp(device, "raja-cuda", 9) == 0 ||
        std::strncmp(device, "raja-hip", 8) == 0 ||
        std::strncmp(device, "occa-cuda", 9) == 0 ||
        std::strncmp(device, "ceed-cuda", 9) == 0 ||
        std::strncmp(device, "ceed/cuda", 9) == 0 ||
        std::strstr(device, "/gpu/") != nullptr) {
        return true;
    }
    // Known CPU-like device strings
    if (std::strcmp(device, "cpu") == 0 ||
        std::strcmp(device, "omp") == 0 ||
        std::strncmp(device, "ceed-cpu", 8) == 0 ||
        std::strncmp(device, "ceed/cpu", 8) == 0 ||
        std::strncmp(device, "ceed-omp", 8) == 0 ||
        std::strncmp(device, "ceed/omp", 8) == 0 ||
        std::strncmp(device, "raja-omp", 8) == 0) {
        return false;
    }
    // Unknown device string — assume GPU to preserve existing behavior.
    return true;
}

bool mfem_device_requests_gpu() {
    const char *device = configured_mfem_device_string();
    return is_gpu_device_string(device);
}

bool mfem_device_requests_gpu(const Context &ctx) {
    const char *device = configured_mfem_device_string(ctx);
    return is_gpu_device_string(device);
}

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

bool detailed_fem_step_profile_enabled() {
    return env_flag_enabled("FULLMAG_FEM_STEP_PROFILE");
}

const char *demag_linear_solver_name(fullmag_fem_linear_solver solver) {
    switch (solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG:
        return "CG";
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES:
        return "GMRES";
    default:
        return "UNKNOWN";
    }
}

const char *demag_preconditioner_name(fullmag_fem_preconditioner preconditioner) {
    switch (preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG:
        return "AMG";
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        return "JACOBI";
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        return "NONE";
    default:
        return "UNKNOWN";
    }
}

void log_demag_call_profile(
    const Context &ctx,
    uint64_t demag_call_index,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t recover_wall_time_ns)
{
    if (!detailed_fem_step_profile_enabled()) {
        return;
    }
    const uint64_t total_wall_time_ns =
        assemble_wall_time_ns + solve_wall_time_ns + recover_wall_time_ns;
    std::fprintf(
        stderr,
        "[fullmag-fem] demag call: step=%llu call=%llu dt=%.3e assemble=%llums solve=%llums recover=%llums total=%llums lin_iters=%d residual=%.3e\n",
        static_cast<unsigned long long>(ctx.step_count),
        static_cast<unsigned long long>(demag_call_index),
        ctx.current_dt,
        static_cast<unsigned long long>(assemble_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(solve_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(recover_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(total_wall_time_ns / 1000000ull),
        ctx.poisson_last_iterations,
        ctx.poisson_last_residual);
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
        demag_linear_solver_name(ctx.demag_solver.solver),
        demag_preconditioner_name(ctx.demag_solver.preconditioner),
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

Vec3 node_coords(const Context &ctx, uint32_t node) {
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.nodes_xyz[base + 0],
        ctx.nodes_xyz[base + 1],
        ctx.nodes_xyz[base + 2],
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

double demag_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz)
{
    if (ctx.mfem_lumped_mass.empty()) {
        return 0.0;
    }
    const size_t n = std::min(ctx.mfem_lumped_mass.size(), m_xyz.size() / 3u);
    double demag_energy = 0.0;
    for (size_t node = 0; node < n; ++node) {
        const size_t base = node * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        const double ms_i = scalar_field_value(
            ctx.Ms_field,
            node,
            ctx.material.saturation_magnetisation);
        demag_energy += -0.5 * kMu0 * ms_i * mdoth * ctx.mfem_lumped_mass[node];
    }
    return demag_energy;
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

    if (ctx.relax_stop.has_energy_tolerance_j != 0 && has_previous_energy) {
        const double delta_energy =
            std::abs(stats.total_energy_joules - previous_energy);
        if (delta_energy <= ctx.relax_stop.energy_tolerance_j) {
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

void copy_host_vector_to_mfem(const std::vector<double> &src, mfem::Vector &dst) {
    dst.SetSize(static_cast<int>(src.size()));
    dst.UseDevice(true);
    double *host = dst.HostWrite();
    for (size_t i = 0; i < src.size(); ++i) {
        host[static_cast<int>(i)] = src[i];
    }
}

void copy_mfem_vector_to_host(const mfem::Vector &src, std::vector<double> &dst) {
    const int n = src.Size();
    dst.resize(static_cast<size_t>(n));
    const double *host = src.HostRead();
    for (int i = 0; i < n; ++i) {
        dst[static_cast<size_t>(i)] = host[i];
    }
}

void prepare_mass_lumping(
    mfem::BilinearForm &mass_form,
    mfem::Vector &ones,
    mfem::Vector &lumped,
    mfem::Vector &inv_lumped,
    std::vector<double> &host_lumped)
{
    const int ndofs = mass_form.FESpace()->GetNDofs();
    ones.SetSize(ndofs);
    lumped.SetSize(ndofs);
    inv_lumped.SetSize(ndofs);
    ones.UseDevice(true);
    lumped.UseDevice(true);
    inv_lumped.UseDevice(true);
    ones = 1.0;
    mass_form.Mult(ones, lumped);
    const double *lumped_host = lumped.HostRead();
    double *inv_host = inv_lumped.HostWrite();
    for (int i = 0; i < ndofs; ++i) {
        const double mass = lumped_host[i];
        inv_host[i] = mass > 0.0 ? 1.0 / mass : 0.0;
    }
    copy_mfem_vector_to_host(lumped, host_lumped);
}

bool apply_exchange_component_device(
    Context *ctx,
    bool allow_interrupt,
    mfem::BilinearForm &exchange_form,
    mfem::GridFunction &m_component,
    mfem::GridFunction &ms_field,
    mfem::Vector &inv_lumped_mass,
    mfem::BilinearForm &mass_form,
    bool use_consistent_mass,
    mfem::Vector &tmp,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host,
    double *energy_out)
{
    exchange_form.Mult(m_component, tmp);
    if (allow_interrupt && ctx != nullptr && poll_interrupt(*ctx)) {
        return false;
    }

    const int ndofs = tmp.Size();

    if (use_consistent_mass) {
        // FND-013: Consistent-mass projection: solve M * raw_h = K * m via CG,
        // then scale by -2/(μ₀ Ms_i).
        mfem::CGSolver cg_solver;
        cg_solver.SetRelTol(1e-10);
        cg_solver.SetMaxIter(200);
        cg_solver.SetPrintLevel(0);
        cg_solver.SetOperator(mass_form);
        h_component = 0.0;
        cg_solver.Mult(tmp, h_component);
        // Apply Ms scaling
        const double *ms_host = ms_field.HostRead();
        double *h_host = h_component.HostReadWrite();
        for (int i = 0; i < ndofs; ++i) {
            const double Ms_i = ms_host[i];
            if (Ms_i <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms_i)) * h_host[i];
            }
        }
    } else {
        // Default lumped-mass path
        const double *tmp_host = tmp.HostRead();
        const double *inv_mass_host = inv_lumped_mass.HostRead();
        const double *ms_host = ms_field.HostRead();
        double *h_host = h_component.HostWrite();
        for (int i = 0; i < ndofs; ++i) {
            const double inv_mass = inv_mass_host[i];
            const double Ms_i = ms_host[i];
            if (inv_mass <= 0.0 || Ms_i <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms_i)) * tmp_host[i] * inv_mass;
            }
        }
    }
    if (energy_out != nullptr) {
        *energy_out = m_component * tmp;
    }
    copy_mfem_vector_to_host(h_component, h_component_host);
    return true;
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

double effective_magnetic_thickness_along_axis(const Context &ctx, const Vec3 &axis) {
    double min_proj = std::numeric_limits<double>::infinity();
    double max_proj = -std::numeric_limits<double>::infinity();
    bool any = false;
    for (size_t i = 0; i < static_cast<size_t>(ctx.n_nodes); ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const double proj = ctx.nodes_xyz[base + 0] * axis[0]
            + ctx.nodes_xyz[base + 1] * axis[1]
            + ctx.nodes_xyz[base + 2] * axis[2];
        min_proj = std::min(min_proj, proj);
        max_proj = std::max(max_proj, proj);
        any = true;
    }
    if (!any) {
        return std::max(ctx.hmax, 1e-30);
    }
    return std::max(max_proj - min_proj, std::max(ctx.hmax, 1e-30));
}

bool tetrahedron_gradients(
    const Vec3 &p0,
    const Vec3 &p1,
    const Vec3 &p2,
    const Vec3 &p3,
    Vec3 (&grads)[4],
    double &volume)
{
    const Vec3 d1 = sub3(p1, p0);
    const Vec3 d2 = sub3(p2, p0);
    const Vec3 d3 = sub3(p3, p0);
    const Vec3 c23 = cross3(d2, d3);
    const double det = dot3(d1, c23);
    if (!(std::abs(det) > kGeomEps) || !std::isfinite(det)) {
        volume = 0.0;
        return false;
    }
    volume = std::abs(det) / 6.0;

    const double inv_det = 1.0 / det;
    const double a00 =  (d2[1] * d3[2] - d2[2] * d3[1]) * inv_det;
    const double a01 = -(d2[0] * d3[2] - d2[2] * d3[0]) * inv_det;
    const double a02 =  (d2[0] * d3[1] - d2[1] * d3[0]) * inv_det;
    const double a10 = -(d1[1] * d3[2] - d1[2] * d3[1]) * inv_det;
    const double a11 =  (d1[0] * d3[2] - d1[2] * d3[0]) * inv_det;
    const double a12 = -(d1[0] * d3[1] - d1[1] * d3[0]) * inv_det;
    const double a20 =  (d1[1] * d2[2] - d1[2] * d2[1]) * inv_det;
    const double a21 = -(d1[0] * d2[2] - d1[2] * d2[0]) * inv_det;
    const double a22 =  (d1[0] * d2[1] - d1[1] * d2[0]) * inv_det;

    grads[1] = {a00, a10, a20};
    grads[2] = {a01, a11, a21};
    grads[3] = {a02, a12, a22};
    grads[0] = scale3(add3(add3(grads[1], grads[2]), grads[3]), -1.0);
    return true;
}

void add_slonczewski_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz)
{
    if (!ctx.has_slonczewski_stt) {
        return;
    }

    constexpr double HBAR = 1.054571817e-34;
    constexpr double E_CHARGE = 1.60217662e-19;

    const Vec3 current_density = {
        ctx.stt_current_density_am2[0],
        ctx.stt_current_density_am2[1],
        ctx.stt_current_density_am2[2],
    };
    const double j_mag = vector_norm3(
        current_density[0],
        current_density[1],
        current_density[2]);
    if (!(j_mag > 0.0)) {
        return;
    }
    const Vec3 axis = scale3(current_density, 1.0 / j_mag);
    // Use explicit free layer thickness if provided, otherwise geometry-derived
    const double thickness = ctx.stt_free_layer_thickness > 0.0
        ? ctx.stt_free_layer_thickness
        : effective_magnetic_thickness_along_axis(ctx, axis);
    const double lambda = ctx.stt_lambda;
    const double lambda_sq = lambda * lambda;
    const double degree = ctx.stt_degree > 0.0 ? ctx.stt_degree : 1.0;
    const Vec3 p = ctx.stt_spin_polarization;

    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
        const double ms = scalar_field_value(
            ctx.Ms_field,
            i,
            ctx.material.saturation_magnetisation);
        if (!(ms > 0.0)) {
            continue;
        }
        const double prefactor =
            (j_mag * HBAR) / (2.0 * E_CHARGE * kMu0 * ms * thickness);
        const double m_dot_p = dot3(m, p);
        const double g = (degree * lambda_sq)
            / ((lambda_sq + 1.0) + (lambda_sq - 1.0) * m_dot_p);
        const double beta_stt = prefactor * g;

        const Vec3 m_cross_p = cross3(m, p);
        const Vec3 m_cross_m_cross_p = cross3(m, m_cross_p);
        const Vec3 torque = {
            beta_stt * (m_cross_m_cross_p[0] + ctx.stt_epsilon_prime * m_cross_p[0]),
            beta_stt * (m_cross_m_cross_p[1] + ctx.stt_epsilon_prime * m_cross_p[1]),
            beta_stt * (m_cross_m_cross_p[2] + ctx.stt_epsilon_prime * m_cross_p[2]),
        };
        rhs_xyz[base + 0] += torque[0];
        rhs_xyz[base + 1] += torque[1];
        rhs_xyz[base + 2] += torque[2];
    }
}

void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz)
{
    if (!ctx.has_zhang_li_stt) {
        return;
    }

    constexpr double MU_B = 9.274009994e-24;
    constexpr double E_CHARGE = 1.60217662e-19;

    std::vector<double> node_weight(static_cast<size_t>(ctx.n_nodes), 0.0);
    const double beta = ctx.stt_beta;

    for (size_t element_index = 0; element_index < static_cast<size_t>(ctx.n_elements); ++element_index) {
        if (!ctx.magnetic_element_mask.empty() && ctx.magnetic_element_mask[element_index] == 0u) {
            continue;
        }
        const size_t ebase = element_index * 4u;
        const uint32_t n0 = ctx.elements[ebase + 0];
        const uint32_t n1 = ctx.elements[ebase + 1];
        const uint32_t n2 = ctx.elements[ebase + 2];
        const uint32_t n3 = ctx.elements[ebase + 3];
        Vec3 grads[4];
        double volume = 0.0;
        if (!tetrahedron_gradients(
                node_coords(ctx, n0),
                node_coords(ctx, n1),
                node_coords(ctx, n2),
                node_coords(ctx, n3),
                grads,
                volume)) {
            continue;
        }

        const uint32_t nodes[4] = {n0, n1, n2, n3};
        double elem_ms = 0.0;
        for (int local = 0; local < 4; ++local) {
            elem_ms += scalar_field_value(
                ctx.Ms_field,
                nodes[local],
                ctx.material.saturation_magnetisation);
        }
        elem_ms /= 4.0;
        if (!(elem_ms > 0.0)) {
            continue;
        }

        const double drift_prefactor =
            (ctx.stt_degree * MU_B) / (E_CHARGE * elem_ms * (1.0 + beta * beta));
        const Vec3 u = scale3(ctx.stt_current_density_am2, drift_prefactor);

        Vec3 grad_m[3] = {};
        for (int local = 0; local < 4; ++local) {
            const size_t base = static_cast<size_t>(nodes[local]) * 3u;
            const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
            for (int component = 0; component < 3; ++component) {
                grad_m[component][0] += m[component] * grads[local][0];
                grad_m[component][1] += m[component] * grads[local][1];
                grad_m[component][2] += m[component] * grads[local][2];
            }
        }

        const Vec3 dm = {
            dot3(u, grad_m[0]),
            dot3(u, grad_m[1]),
            dot3(u, grad_m[2]),
        };

        const double nodal_weight = volume * 0.25;
        for (int local = 0; local < 4; ++local) {
            const uint32_t node = nodes[local];
            const size_t base = static_cast<size_t>(node) * 3u;
            const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
            const Vec3 c = cross3(m, dm);
            const Vec3 dc = cross3(m, c);
            rhs_xyz[base + 0] += nodal_weight * (-dc[0] - beta * c[0]);
            rhs_xyz[base + 1] += nodal_weight * (-dc[1] - beta * c[1]);
            rhs_xyz[base + 2] += nodal_weight * (-dc[2] - beta * c[2]);
            node_weight[node] += nodal_weight;
        }
    }

    for (size_t i = 0; i < static_cast<size_t>(ctx.n_nodes); ++i) {
        if (!(node_weight[i] > kGeomEps)) {
            continue;
        }
        const double inv_w = 1.0 / node_weight[i];
        const size_t base = i * 3u;
        rhs_xyz[base + 0] *= inv_w;
        rhs_xyz[base + 1] *= inv_w;
        rhs_xyz[base + 2] *= inv_w;
    }
}

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    const std::vector<double> llg_only = rhs_xyz;
    add_slonczewski_stt_rhs_aos(ctx, m_xyz, rhs_xyz);
    if (ctx.has_zhang_li_stt) {
        std::vector<double> zhang_li(rhs_xyz.size(), 0.0);
        add_zhang_li_stt_rhs_aos(ctx, m_xyz, zhang_li);
        for (size_t i = 0; i < rhs_xyz.size(); ++i) {
            rhs_xyz[i] += zhang_li[i];
        }
    }
    if (rhs_xyz != llg_only) {
        max_rhs = 0.0;
        const size_t n = rhs_xyz.size() / 3u;
        for (size_t i = 0; i < n; ++i) {
            const size_t base = i * 3u;
            max_rhs = std::max(
                max_rhs,
                vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
        }
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

void compute_uniaxial_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ani_xyz,
    double *anisotropy_energy)
{
    const size_t n = ctx.n_nodes;
    h_ani_xyz.assign(n * 3u, 0.0);
    // F-05 fix: do not bail out when Ku==0 — Ku2 or per-node fields may
    // still contribute a nonzero anisotropy field.
    if (!ctx.enable_anisotropy ||
        (ctx.anisotropy_Ku == 0.0 && ctx.anisotropy_Ku2 == 0.0 &&
         ctx.Ku_field.empty() && ctx.Ku2_field.empty())) {
        if (anisotropy_energy != nullptr) {
            *anisotropy_energy = 0.0;
        }
        return;
    }

    const double ux = ctx.anisotropy_axis[0];
    const double uy = ctx.anisotropy_axis[1];
    const double uz = ctx.anisotropy_axis[2];
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    const double uniform_Ku = ctx.anisotropy_Ku;
    const double uniform_Ku2 = ctx.anisotropy_Ku2;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[i];
        const double Ku_i = ctx.Ku_field.empty() ? uniform_Ku : ctx.Ku_field[i];
        const double Ku2_i = ctx.Ku2_field.empty() ? uniform_Ku2 : ctx.Ku2_field[i];
        const double prefactor = 2.0 * Ku_i / (kMu0 * Ms_i);
        const double prefactor2 = (Ku2_i != 0.0) ? 4.0 * Ku2_i / (kMu0 * Ms_i) : 0.0;
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];
        const double m_dot_u = mx * ux + my * uy + mz * uz;
        const double m_dot_u2 = m_dot_u * m_dot_u;

        // H_ani = (2Ku1/μ₀Ms)(m·û)û + (4Ku2/μ₀Ms)(m·û)³û
        const double coeff = prefactor * m_dot_u + prefactor2 * m_dot_u * m_dot_u2;
        h_ani_xyz[base + 0] = coeff * ux;
        h_ani_xyz[base + 1] = coeff * uy;
        h_ani_xyz[base + 2] = coeff * uz;

        if (anisotropy_energy != nullptr && !ctx.mfem_lumped_mass.empty()) {
            // F-06 fix: energy consistent with field H = (2Ku/μ₀Ms)(m·û)û.
            // E_density = -Ku1(m·û)² - Ku2(m·û)⁴
            // (Convention: Ku>0 → easy-axis along û.)
            energy += (-Ku_i * m_dot_u2 - Ku2_i * m_dot_u2 * m_dot_u2) *
                      ctx.mfem_lumped_mass[i];
        }
    }

    if (anisotropy_energy != nullptr) {
        *anisotropy_energy = energy;
    }
}

/// Compute cubic anisotropy effective field.
/// H_cubic = -(2Kc1/μ₀Ms)[m1(m2²+m3²)ĉ1 + m2(m1²+m3²)ĉ2 + m3(m1²+m2²)ĉ3]
///         -(2Kc2/μ₀Ms)[m1·m2²·m3²·ĉ1 + m1²·m2·m3²·ĉ2 + m1²·m2²·m3·ĉ3]
///         -(4Kc3/μ₀Ms)·σ·[m1(m2²+m3²)ĉ1 + m2(m1²+m3²)ĉ2 + m3(m1²+m2²)ĉ3]
/// where m_i = m·ĉ_i, σ = m1²m2² + m2²m3² + m1²m3².
/// ĉ3 is computed as ĉ1 × ĉ2.
/// Energy: E = Kc1·σ + Kc2·m1²m2²m3² + Kc3·σ²
void compute_cubic_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_cub_xyz,
    double *cubic_energy)
{
    const size_t n = ctx.n_nodes;
    h_cub_xyz.assign(n * 3u, 0.0);
    // F-05 fix: also check per-node fields — don't bail when only uniform constants are zero.
    if (!ctx.enable_cubic_anisotropy ||
        (ctx.cubic_Kc1 == 0.0 && ctx.cubic_Kc2 == 0.0 && ctx.cubic_Kc3 == 0.0 &&
         ctx.Kc1_field.empty() && ctx.Kc2_field.empty() && ctx.Kc3_field.empty())) {
        if (cubic_energy != nullptr) {
            *cubic_energy = 0.0;
        }
        return;
    }

    // Crystal axes: c1, c2, c3 = c1 × c2
    const double c1x = ctx.cubic_axis1[0], c1y = ctx.cubic_axis1[1], c1z = ctx.cubic_axis1[2];
    const double c2x = ctx.cubic_axis2[0], c2y = ctx.cubic_axis2[1], c2z = ctx.cubic_axis2[2];
    const double c3x = c1y * c2z - c1z * c2y;
    const double c3y = c1z * c2x - c1x * c2z;
    const double c3z = c1x * c2y - c1y * c2x;

    const double inv_mu0 = 1.0 / kMu0;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    const double uniform_Kc1 = ctx.cubic_Kc1;
    const double uniform_Kc2 = ctx.cubic_Kc2;
    const double uniform_Kc3 = ctx.cubic_Kc3;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[i];
        const double Kc1_i = ctx.Kc1_field.empty() ? uniform_Kc1 : ctx.Kc1_field[i];
        const double Kc2_i = ctx.Kc2_field.empty() ? uniform_Kc2 : ctx.Kc2_field[i];
        const double Kc3_i = ctx.Kc3_field.empty() ? uniform_Kc3 : ctx.Kc3_field[i];
        const double inv_mu0Ms = inv_mu0 / Ms_i;
        const double pf1 = -2.0 * Kc1_i * inv_mu0Ms;
        const double pf2 = -2.0 * Kc2_i * inv_mu0Ms;
        const double pf3 = -4.0 * Kc3_i * inv_mu0Ms;
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];

        // Project m onto crystal axes
        const double m1 = mx * c1x + my * c1y + mz * c1z;
        const double m2 = mx * c2x + my * c2y + mz * c2z;
        const double m3 = mx * c3x + my * c3y + mz * c3z;

        const double m1sq = m1 * m1;
        const double m2sq = m2 * m2;
        const double m3sq = m3 * m3;

        // σ = m1²m2² + m2²m3² + m1²m3²
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

        // Kc1 contribution: ∂σ/∂m_i = 2·m_i·(sum of other two m_j²)
        // H_i = -(2Kc1/μ₀Ms)·m_i·(mj² + mk²)
        double g1 = pf1 * m1 * (m2sq + m3sq);
        double g2 = pf1 * m2 * (m1sq + m3sq);
        double g3 = pf1 * m3 * (m1sq + m2sq);

        // Kc2 contribution: ∂(m1²m2²m3²)/∂m_i = 2·m_i·(product of other two)
        if (ctx.cubic_Kc2 != 0.0 || !ctx.Kc2_field.empty()) {
            g1 += pf2 * m1 * m2sq * m3sq;
            g2 += pf2 * m1sq * m2 * m3sq;
            g3 += pf2 * m1sq * m2sq * m3;
        }

        // Kc3 contribution: ∂(σ²)/∂m_i = 2σ · ∂σ/∂m_i
        if (ctx.cubic_Kc3 != 0.0 || !ctx.Kc3_field.empty()) {
            g1 += pf3 * sigma * m1 * (m2sq + m3sq);
            g2 += pf3 * sigma * m2 * (m1sq + m3sq);
            g3 += pf3 * sigma * m3 * (m1sq + m2sq);
        }

        // Transform back from crystal frame to Cartesian
        h_cub_xyz[base + 0] = g1 * c1x + g2 * c2x + g3 * c3x;
        h_cub_xyz[base + 1] = g1 * c1y + g2 * c2y + g3 * c3y;
        h_cub_xyz[base + 2] = g1 * c1z + g2 * c2z + g3 * c3z;

        if (cubic_energy != nullptr && !ctx.mfem_lumped_mass.empty()) {
            energy += (Kc1_i * sigma +
                       Kc2_i * m1sq * m2sq * m3sq +
                       Kc3_i * sigma * sigma) *
                      ctx.mfem_lumped_mass[i];
        }
    }

    if (cubic_energy != nullptr) {
        *cubic_energy = energy;
    }
}

/// Compute interfacial DMI effective field using element-loop gradient.
/// H_dmi_x =  (2D / μ₀Ms) ∂m_z/∂x
/// H_dmi_y =  (2D / μ₀Ms) ∂m_z/∂y
/// H_dmi_z = -(2D / μ₀Ms) (∂m_x/∂x + ∂m_y/∂y)
/// Energy: e_dmi = D [mz(∂mx/∂x + ∂my/∂y) - mx ∂mz/∂x - my ∂mz/∂y] (integrated)
bool compute_interfacial_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error)
{
    const size_t n = ctx.n_nodes;
    h_dmi_xyz.assign(n * 3u, 0.0);
    // F-05 fix: check per-node field too, not just uniform constant.
    if (!ctx.enable_dmi || (ctx.dmi_D == 0.0 && ctx.Dind_field.empty())) {
        if (dmi_energy != nullptr) {
            *dmi_energy = 0.0;
        }
        return true;
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.mfem_ready) {
        error = "MFEM context not ready for DMI computation";
        return false;
    }

    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "MFEM FE space or mesh is null during DMI computation";
        return false;
    }

    const double uniform_D = ctx.dmi_D;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    double energy = 0.0;

    // Node-accumulated weighted contributions
    std::vector<double> node_weight(n, 0.0);
    // h_dmi_xyz already zeroed above

    // Unpack m components for element-loop access
    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);

    // Set up GridFunctions for reading
    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);

    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        // Skip non-magnetic elements
        if (!ctx.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem) < ctx.magnetic_element_mask.size() &&
            ctx.magnetic_element_mask[elem] == 0u) {
            continue;
        }

        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        mfem::Array<int> dofs;
        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();

        // Extract local m_x, m_y, m_z
        mfem::Vector mx_elem(local_ndof), my_elem(local_ndof), mz_elem(local_ndof);
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            mx_elem(i) = sign * (*gf_mx)(gdof);
            my_elem(i) = sign * (*gf_my)(gdof);
            mz_elem(i) = sign * (*gf_mz)(gdof);
        }

        // Compute per-element average D and Ms for this element's DOFs
        double elem_D = 0.0, elem_Ms = 0.0;
        if (!ctx.Dind_field.empty() || !ctx.Ms_field.empty()) {
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                elem_D  += ctx.Dind_field.empty() ? uniform_D : ctx.Dind_field[gdof];
                elem_Ms += ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[gdof];
            }
            elem_D  /= static_cast<double>(local_ndof);
            elem_Ms /= static_cast<double>(local_ndof);
        } else {
            elem_D  = uniform_D;
            elem_Ms = uniform_Ms;
        }
        const double prefactor = 2.0 * elem_D / (kMu0 * elem_Ms);

        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            // Gradient of shape functions in physical coordinates
            mfem::DenseMatrix dshape(local_ndof, 3);
            fe->CalcPhysDShape(*T, dshape);

            // FND-009: General iDMI with arbitrary interface normal n̂.
            // H_dmi = (2D/μ₀Ms) [∇(m·n̂) − n̂(∇·m)]
            // Energy: e = D [(m·n̂)(∇·m) − (m·∇)(m·n̂)]
            const double nx = ctx.dmi_n_hat[0];
            const double ny = ctx.dmi_n_hat[1];
            const double nz = ctx.dmi_n_hat[2];

            // Compute full gradient: ∂m_i/∂x_j for all i,j
            double dm[3][3] = {}; // dm[component][spatial_dim]
            for (int i = 0; i < local_ndof; ++i) {
                dm[0][0] += mx_elem(i) * dshape(i, 0); // ∂mx/∂x
                dm[0][1] += mx_elem(i) * dshape(i, 1); // ∂mx/∂y
                dm[0][2] += mx_elem(i) * dshape(i, 2); // ∂mx/∂z
                dm[1][0] += my_elem(i) * dshape(i, 0); // ∂my/∂x
                dm[1][1] += my_elem(i) * dshape(i, 1); // ∂my/∂y
                dm[1][2] += my_elem(i) * dshape(i, 2); // ∂my/∂z
                dm[2][0] += mz_elem(i) * dshape(i, 0); // ∂mz/∂x
                dm[2][1] += mz_elem(i) * dshape(i, 1); // ∂mz/∂y
                dm[2][2] += mz_elem(i) * dshape(i, 2); // ∂mz/∂z
            }

            // ∇·m = ∂mx/∂x + ∂my/∂y + ∂mz/∂z
            const double div_m = dm[0][0] + dm[1][1] + dm[2][2];

            // ∇(m·n̂) = (∂/∂x_j)(mx*nx + my*ny + mz*nz) for j=0,1,2
            const double grad_mn[3] = {
                nx * dm[0][0] + ny * dm[1][0] + nz * dm[2][0],
                nx * dm[0][1] + ny * dm[1][1] + nz * dm[2][1],
                nx * dm[0][2] + ny * dm[1][2] + nz * dm[2][2],
            };

            // H_dmi = prefactor * [∇(m·n̂) − n̂(∇·m)]
            const double hx = prefactor * (grad_mn[0] - nx * div_m);
            const double hy = prefactor * (grad_mn[1] - ny * div_m);
            const double hz = prefactor * (grad_mn[2] - nz * div_m);

            // Distribute to DOFs weighted by shape function
            mfem::Vector shape(local_ndof);
            fe->CalcShape(ip, shape);
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.n_nodes) {
                    continue;
                }
                const double phi_w = std::abs(shape(i)) * w;
                const size_t base = static_cast<size_t>(gdof) * 3u;
                h_dmi_xyz[base + 0] += phi_w * hx;
                h_dmi_xyz[base + 1] += phi_w * hy;
                h_dmi_xyz[base + 2] += phi_w * hz;
                node_weight[gdof] += phi_w;
            }

            // Energy: e_dmi = D [(m·n̂)(∇·m) − (m·∇)(m·n̂)]
            if (dmi_energy != nullptr) {
                // Interpolate m at quadrature point
                double mx_q = 0.0, my_q = 0.0, mz_q = 0.0;
                for (int i = 0; i < local_ndof; ++i) {
                    mx_q += mx_elem(i) * shape(i);
                    my_q += my_elem(i) * shape(i);
                    mz_q += mz_elem(i) * shape(i);
                }
                const double m_dot_n = mx_q * nx + my_q * ny + mz_q * nz;
                // (m·∇)(m·n̂) = m_i ∂(m·n̂)/∂x_i
                const double m_grad_mn = mx_q * grad_mn[0] + my_q * grad_mn[1] + mz_q * grad_mn[2];
                energy += elem_D * (m_dot_n * div_m - m_grad_mn) * w;
            }
        }
    }

    // Normalize by accumulated weight (lumped-mass style)
    for (size_t i = 0; i < n; ++i) {
        if (node_weight[i] > kGeomEps) {
            const size_t base = i * 3u;
            const double inv_w = 1.0 / node_weight[i];
            h_dmi_xyz[base + 0] *= inv_w;
            h_dmi_xyz[base + 1] *= inv_w;
            h_dmi_xyz[base + 2] *= inv_w;
        }
    }

    if (dmi_energy != nullptr) {
        *dmi_energy = energy;
    }

    return true;
#else
    // No MFEM stack — DMI requires element-loop gradient
    error = "DMI computation requires MFEM stack";
    return false;
#endif
}

/// Compute Bloch-type (bulk) DMI effective field using element-loop gradient.
/// F-07 fix: sign matches spec H_dmi = -(2D / μ₀Ms) ∇ × m
///   H_x = -(2D / μ₀Ms) (∂m_z/∂y - ∂m_y/∂z)
///   H_y = -(2D / μ₀Ms) (∂m_x/∂z - ∂m_z/∂x)
///   H_z = -(2D / μ₀Ms) (∂m_y/∂x - ∂m_x/∂y)
/// Energy: e_bulk_dmi = D · m · (∇ × m) (integrated)
bool compute_bulk_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error)
{
    const size_t n = ctx.n_nodes;
    h_dmi_xyz.assign(n * 3u, 0.0);
    // F-05 fix: check per-node field too, not just uniform constant.
    if (!ctx.enable_bulk_dmi || (ctx.bulk_dmi_D == 0.0 && ctx.Dbulk_field.empty())) {
        if (dmi_energy != nullptr) {
            *dmi_energy = 0.0;
        }
        return true;
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.mfem_ready) {
        error = "MFEM context not ready for bulk DMI computation";
        return false;
    }

    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "MFEM FE space or mesh is null during bulk DMI computation";
        return false;
    }

    const double uniform_D = ctx.bulk_dmi_D;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    double energy = 0.0;

    std::vector<double> node_weight(n, 0.0);

    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);

    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);

    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem) < ctx.magnetic_element_mask.size() &&
            ctx.magnetic_element_mask[elem] == 0u) {
            continue;
        }

        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        mfem::Array<int> dofs;
        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();

        mfem::Vector mx_elem(local_ndof), my_elem(local_ndof), mz_elem(local_ndof);
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            mx_elem(i) = sign * (*gf_mx)(gdof);
            my_elem(i) = sign * (*gf_my)(gdof);
            mz_elem(i) = sign * (*gf_mz)(gdof);
        }

        // Compute per-element average D and Ms
        double elem_D = 0.0, elem_Ms = 0.0;
        if (!ctx.Dbulk_field.empty() || !ctx.Ms_field.empty()) {
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof2 = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                elem_D  += ctx.Dbulk_field.empty() ? uniform_D : ctx.Dbulk_field[gdof2];
                elem_Ms += ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[gdof2];
            }
            elem_D  /= static_cast<double>(local_ndof);
            elem_Ms /= static_cast<double>(local_ndof);
        } else {
            elem_D  = uniform_D;
            elem_Ms = uniform_Ms;
        }
        // F-07 fix: negative sign per spec H_bDMI = -(2D/μ₀Ms)(∇×m)
        const double prefactor = -2.0 * elem_D / (kMu0 * elem_Ms);

        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            mfem::DenseMatrix dshape(local_ndof, 3);
            fe->CalcPhysDShape(*T, dshape);

            // Full gradient: ∂m_i/∂x_j for i=x,y,z and j=x,y,z
            double dmx_dx = 0.0, dmx_dy = 0.0, dmx_dz = 0.0;
            double dmy_dx = 0.0, dmy_dy = 0.0, dmy_dz = 0.0;
            double dmz_dx = 0.0, dmz_dy = 0.0, dmz_dz = 0.0;
            for (int i = 0; i < local_ndof; ++i) {
                dmx_dx += mx_elem(i) * dshape(i, 0);
                dmx_dy += mx_elem(i) * dshape(i, 1);
                dmx_dz += mx_elem(i) * dshape(i, 2);
                dmy_dx += my_elem(i) * dshape(i, 0);
                dmy_dy += my_elem(i) * dshape(i, 1);
                dmy_dz += my_elem(i) * dshape(i, 2);
                dmz_dx += mz_elem(i) * dshape(i, 0);
                dmz_dy += mz_elem(i) * dshape(i, 1);
                dmz_dz += mz_elem(i) * dshape(i, 2);
            }

            // ∇ × m
            const double curl_x = dmz_dy - dmy_dz;
            const double curl_y = dmx_dz - dmz_dx;
            const double curl_z = dmy_dx - dmx_dy;

            const double hx = prefactor * curl_x;
            const double hy = prefactor * curl_y;
            const double hz = prefactor * curl_z;

            mfem::Vector shape(local_ndof);
            fe->CalcShape(ip, shape);
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.n_nodes) {
                    continue;
                }
                const double phi_w = std::abs(shape(i)) * w;
                const size_t base = static_cast<size_t>(gdof) * 3u;
                h_dmi_xyz[base + 0] += phi_w * hx;
                h_dmi_xyz[base + 1] += phi_w * hy;
                h_dmi_xyz[base + 2] += phi_w * hz;
                node_weight[gdof] += phi_w;
            }

            // Energy: e = D · m · (∇ × m)
            if (dmi_energy != nullptr) {
                double mx_q = 0.0, my_q = 0.0, mz_q = 0.0;
                for (int i = 0; i < local_ndof; ++i) {
                    mx_q += mx_elem(i) * shape(i);
                    my_q += my_elem(i) * shape(i);
                    mz_q += mz_elem(i) * shape(i);
                }
                energy += elem_D * (mx_q * curl_x + my_q * curl_y + mz_q * curl_z) * w;
            }
        }
    }

    // Normalize by accumulated weight
    for (size_t i = 0; i < n; ++i) {
        if (node_weight[i] > kGeomEps) {
            const size_t base = i * 3u;
            const double inv_w = 1.0 / node_weight[i];
            h_dmi_xyz[base + 0] *= inv_w;
            h_dmi_xyz[base + 1] *= inv_w;
            h_dmi_xyz[base + 2] *= inv_w;
        }
    }

    if (dmi_energy != nullptr) {
        *dmi_energy = energy;
    }

    return true;
#else
    error = "Bulk DMI computation requires MFEM stack";
    return false;
#endif
}

double external_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    if (!ctx.has_external_field) {
        return 0.0;
    }

    double energy = 0.0;
    for (size_t i = 0; i < ctx.mfem_lumped_mass.size(); ++i) {
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

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool allow_interrupt,
    std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "MFEM exchange requested before MFEM context initialization";
        return false;
    }

    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    auto *gf_ms = static_cast<mfem::GridFunction *>(ctx.mfem_gf_ms);
    auto *inv_lumped_mass = static_cast<mfem::Vector *>(ctx.mfem_inv_lumped_mass);
    auto *tmp_vec = static_cast<mfem::Vector *>(ctx.mfem_exchange_tmp_vec);
    auto *out_vec = static_cast<mfem::Vector *>(ctx.mfem_exchange_out_vec);
    if (exchange_form == nullptr || gf_mx == nullptr || gf_my == nullptr || gf_mz == nullptr ||
        gf_ms == nullptr || inv_lumped_mass == nullptr || tmp_vec == nullptr || out_vec == nullptr) {
        error = "MFEM exchange scaffold is missing one or more operator/device buffers";
        return false;
    }
    if (ctx.use_consistent_mass && mass_form == nullptr) {
        error = "MFEM mass form is required for consistent-mass exchange but is null";
        return false;
    }

    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);
    copy_host_vector_to_mfem(ctx.mfem_mx, *gf_mx);
    copy_host_vector_to_mfem(ctx.mfem_my, *gf_my);
    copy_host_vector_to_mfem(ctx.mfem_mz, *gf_mz);

    double exchange_energy_accum = 0.0;
    double component_energy = 0.0;

    if (!apply_exchange_component_device(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_mx,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.mfem_h_ex_x,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    component_energy = 0.0;
    if (!apply_exchange_component_device(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_my,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.mfem_h_ex_y,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    component_energy = 0.0;
    if (!apply_exchange_component_device(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_mz,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.mfem_h_ex_z,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    pack_components_to_aos(ctx.mfem_h_ex_x, ctx.mfem_h_ex_y, ctx.mfem_h_ex_z, h_ex_xyz);

    // S08 multi-region: zero exchange field on non-magnetic nodes.
    // The stiffness/mass forms are already restricted to magnetic elements,
    // but nodes shared between magnetic and air may carry residual coupling.
    if (!ctx.magnetic_node_mask.empty()) {
        for (size_t i = 0; i < ctx.magnetic_node_mask.size(); ++i) {
            if (allow_interrupt &&
                i > 0 &&
                (i % static_cast<size_t>(kInterruptPollStride)) == 0 &&
                poll_interrupt(ctx)) {
                return false;
            }
            if (ctx.magnetic_node_mask[i] == 0u) {
                const size_t base = i * 3u;
                h_ex_xyz[base + 0] = 0.0;
                h_ex_xyz[base + 1] = 0.0;
                h_ex_xyz[base + 2] = 0.0;
            }
        }
    }

    if (h_eff_xyz != nullptr) {
        h_eff_xyz->resize(h_ex_xyz.size());
        if (ctx.has_external_field) {
            for (size_t i = 0; i < h_ex_xyz.size(); ++i) {
                (*h_eff_xyz)[i] = h_ex_xyz[i] + ctx.h_ext_xyz[i];
            }
        } else {
            *h_eff_xyz = h_ex_xyz;
        }
    }

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange_energy_accum;
    }

    return true;
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
    h_ex_xyz.assign(m_xyz.size(), 0.0);
    h_demag_xyz.assign(m_xyz.size(), 0.0);
    h_eff_xyz.assign(m_xyz.size(), 0.0);

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
        ScopedPhaseTimer timer(timings != nullptr ? &timings->demag_wall_time_ns : nullptr);
        bool refresh_demag = true;
        if (ctx.field_refresh.has_demag_interval_s != 0 &&
            ctx.demag_cache_valid &&
            ctx.field_refresh.demag_interval_s > 0.0) {
            const double elapsed = ctx.current_time - ctx.demag_last_refresh_time;
            refresh_demag = elapsed + 1e-30 >= ctx.field_refresh.demag_interval_s;
        }
        if (refresh_demag) {
            if ((ctx.demag_realization == 1 || ctx.demag_realization == 2) && ctx.poisson_ready) {
                // Native FEM demag: Poisson-Dirichlet (1) or Poisson-Robin (2)
                if (!context_compute_demag_poisson(
                        ctx, m_xyz, h_demag_xyz, demag, allow_interrupt, error)) {
                    return false;
                }
            } else {
                error =
                    "Native FEM demag requires a Poisson airbox realization, but the Poisson "
                    "demag operator is not ready";
                return false;
            }
            ctx.h_demag_cached_xyz = h_demag_xyz;
            ctx.h_demag_cached_visual_xyz = ctx.h_demag_visual_xyz;
            ctx.demag_last_refresh_time = ctx.current_time;
            ctx.demag_cache_valid = true;
        } else if (ctx.demag_cache_valid &&
                   ctx.h_demag_cached_xyz.size() == h_demag_xyz.size()) {
            h_demag_xyz = ctx.h_demag_cached_xyz;
            if (ctx.h_demag_cached_visual_xyz.size() == h_demag_xyz.size()) {
                ctx.h_demag_visual_xyz = ctx.h_demag_cached_visual_xyz;
            } else {
                ctx.h_demag_visual_xyz.clear();
            }
            demag = demag_energy_from_field(ctx, m_xyz, h_demag_xyz);
            // Phase-0A fix: include the cached Robin boundary energy term
            // so that E_demag is energetically consistent between fresh and
            // frozen-field steps.  The potential u is frozen together with
            // H_demag, so the boundary integral is also frozen.
            demag += ctx.cached_robin_boundary_energy;
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
    }

    {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->extra_energy_wall_time_ns : nullptr);
        double anisotropy = 0.0;
        if (ctx.enable_anisotropy) {
            compute_uniaxial_anisotropy_field(
                ctx, m_xyz, ctx.h_ani_xyz,
                &anisotropy);
        } else {
            ctx.h_ani_xyz.assign(m_xyz.size(), 0.0);
        }

        double dmi = 0.0;
        if (ctx.enable_dmi) {
            if (!compute_interfacial_dmi_field(
                    ctx, m_xyz, ctx.h_dmi_xyz, &dmi, error)) {
                return false;
            }
        } else {
            ctx.h_dmi_xyz.assign(m_xyz.size(), 0.0);
        }

        // F-03 fix: compute cubic anisotropy and add to H_eff.
        if (ctx.enable_cubic_anisotropy) {
            compute_cubic_anisotropy_field(
                ctx, m_xyz, ctx.h_cubic_ani_xyz, nullptr);
        } else {
            ctx.h_cubic_ani_xyz.assign(m_xyz.size(), 0.0);
        }

        // F-03/F-07 fix: compute bulk DMI and add to H_eff.
        // FEM-027 fix: persist bulk DMI field in context for readback.
        double bulk_dmi = 0.0;
        if (ctx.enable_bulk_dmi) {
            if (!compute_bulk_dmi_field(
                    ctx, m_xyz, ctx.h_bulk_dmi_xyz, &bulk_dmi, error)) {
                return false;
            }
        } else {
            ctx.h_bulk_dmi_xyz.assign(m_xyz.size(), 0.0);
        }

        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            h_eff_xyz[i] = h_ex_xyz[i] + h_demag_xyz[i] + ctx.h_ext_xyz[i] +
                           ctx.h_ani_xyz[i] + ctx.h_dmi_xyz[i] +
                           ctx.h_cubic_ani_xyz[i];
        }

        // Add bulk DMI to H_eff
        if (ctx.enable_bulk_dmi && !ctx.h_bulk_dmi_xyz.empty()) {
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += ctx.h_bulk_dmi_xyz[i];
            }
        }

        // F-09 fix: add Oersted field to H_eff per step (with time modulation).
        if ((ctx.has_oersted_cylinder || ctx.has_oersted_field) && !ctx.h_oe_xyz.empty()) {
            double I_scale = 1.0;
            if (ctx.has_oersted_cylinder) {
                I_scale = ctx.oersted_current;
                switch (ctx.oersted_time_dep_kind) {
                    case 1: { // Sinusoidal
                        I_scale *= std::sin(2.0 * kPi * ctx.oersted_time_dep_freq * ctx.current_time
                                            + ctx.oersted_time_dep_phase)
                                 + ctx.oersted_time_dep_offset;
                        break;
                    }
                    case 2: { // Pulse
                        I_scale *= (ctx.current_time >= ctx.oersted_time_dep_t_on &&
                                    ctx.current_time <  ctx.oersted_time_dep_t_off) ? 1.0 : 0.0;
                        break;
                    }
                    default: break;
                }
            }
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += I_scale * ctx.h_oe_xyz[i];
            }
        }

        // F-09 fix: add thermal noise to H_eff per step.
        if (ctx.temperature > 0.0 && !ctx.h_therm_xyz.empty()) {
            context_refresh_thermal_field(ctx);
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += ctx.h_therm_xyz[i];
            }
        }

        // Add magnetoelastic field
        if (ctx.enable_magnetoelastic) {
            compute_magnetoelastic_field(ctx, m_xyz);
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += ctx.h_mel_xyz[i];
            }
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
    }

    // Build full-domain H_eff for visualization: replace zeroed h_demag
    // with the Poisson-recovered full-domain version so that airbox nodes
    // carry the correct stray-field contribution.
    if (!ctx.h_demag_visual_xyz.empty() &&
        ctx.h_demag_visual_xyz.size() == h_eff_xyz.size()) {
        ctx.h_eff_visual_xyz = h_eff_xyz;
        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            ctx.h_eff_visual_xyz[i] += ctx.h_demag_visual_xyz[i] - h_demag_xyz[i];
        }
    } else {
        ctx.h_eff_visual_xyz.clear();
    }

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
    if (ctx.enable_demag && (ctx.demag_realization == 1 || ctx.demag_realization == 2)) {
        stats.demag_linear_iterations = static_cast<uint32_t>(std::max(ctx.poisson_last_iterations, 0));
        stats.demag_linear_residual = ctx.poisson_last_residual;
    } else {
        stats.demag_linear_iterations = 0;
        stats.demag_linear_residual = 0.0;
    }
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

    stats.external_energy_joules = external_energy_from_field(ctx, ctx.m_xyz);
    double anisotropy_energy = 0.0;
    if (ctx.enable_anisotropy) {
        compute_uniaxial_anisotropy_field(ctx, ctx.m_xyz, ctx.h_ani_xyz, &anisotropy_energy);
    }
    if (ctx.enable_cubic_anisotropy) {
        double cubic_energy = 0.0;
        compute_cubic_anisotropy_field(ctx, ctx.m_xyz, ctx.h_cubic_ani_xyz, &cubic_energy);
        anisotropy_energy += cubic_energy;
    }
    stats.anisotropy_energy_joules = anisotropy_energy;

    double dmi_energy = 0.0;
    if (ctx.enable_dmi) {
        std::string dmi_error;
        compute_interfacial_dmi_field(ctx, ctx.m_xyz, ctx.h_dmi_xyz, &dmi_energy, dmi_error);
    }
    if (ctx.enable_bulk_dmi) {
        double bulk_dmi_energy = 0.0;
        std::string bulk_error;
        std::vector<double> h_bulk_tmp;
        compute_bulk_dmi_field(ctx, ctx.m_xyz, h_bulk_tmp, &bulk_dmi_energy, bulk_error);
        dmi_energy += bulk_dmi_energy;
    }
    stats.dmi_energy_joules = dmi_energy;

    // Magnetoelastic energy
    if (ctx.enable_magnetoelastic) {
        compute_magnetoelastic_field(ctx, ctx.m_xyz);
    }
    stats.magnetoelastic_energy_joules = ctx.mel_energy;

    stats.total_energy_joules =
        stats.exchange_energy_joules + stats.demag_energy_joules +
        stats.external_energy_joules + stats.anisotropy_energy_joules +
        stats.dmi_energy_joules + stats.magnetoelastic_energy_joules;
    stats.max_effective_field_amplitude = max_norm_aos(ctx.h_eff_xyz);
    stats.max_demag_field_amplitude = max_norm_aos(ctx.h_demag_xyz);
    stats.max_rhs_amplitude = max_rhs;
    stats.max_torque_Apm = max_cross_norm_aos(ctx.m_xyz, ctx.h_eff_xyz);
    fill_demag_solver_stats(ctx, stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Poisson demag: ∇²u = ∇·M on Ω_m ∪ Ω_air  (S02–S05)
// ─────────────────────────────────────────────────────────────────────────────

/// Custom MFEM VectorCoefficient for M_s * m(x), restricted to magnetic elements.
/// Returns zero on air elements. Used for the Poisson RHS: b(v) = ∫ M·∇v dV.
class MagnetizationCoefficient : public mfem::VectorCoefficient {
public:
    MagnetizationCoefficient(
        const Context &ctx_ref,
        const std::vector<double> &m_xyz_ref,
        mfem::FiniteElementSpace *fes_ref)
        : mfem::VectorCoefficient(3)
        , ctx_(ctx_ref)
        , m_xyz_(m_xyz_ref)
        , fes_(fes_ref)
    {
    }

    void Eval(mfem::Vector &V, mfem::ElementTransformation &T,
              const mfem::IntegrationPoint &ip) override
    {
        V.SetSize(3);

        // Check if this element is magnetic
        const int elem_no = T.ElementNo;
        if (elem_no >= 0 &&
            !ctx_.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem_no) < ctx_.magnetic_element_mask.size() &&
            ctx_.magnetic_element_mask[static_cast<size_t>(elem_no)] == 0u) {
            V = 0.0;
            return;
        }

        // Interpolate m at the integration point using FE basis
        mfem::Array<int> dofs;
        fes_->GetElementDofs(elem_no, dofs);
        const int ndof = dofs.Size();

        // Evaluate shape functions at ip
        const mfem::FiniteElement *fe = fes_->GetFE(elem_no);
        mfem::Vector shape(ndof);
        fe->CalcShape(ip, shape);

        // Interpolate m components
        double mx = 0.0, my = 0.0, mz = 0.0;
        for (int i = 0; i < ndof; ++i) {
            const int global_dof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            const size_t base = static_cast<size_t>(global_dof) * 3u;
            mx += sign * shape(i) * m_xyz_[base + 0];
            my += sign * shape(i) * m_xyz_[base + 1];
            mz += sign * shape(i) * m_xyz_[base + 2];
        }

        // M = M_s * m (A/m)
        double Ms = ctx_.material.saturation_magnetisation;
        if (!ctx_.Ms_field.empty()) {
            Ms = 0.0;
            for (int i = 0; i < ndof; ++i) {
                const int global_dof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                const double weight = shape(i);
                Ms += weight
                    * scalar_field_value(
                        ctx_.Ms_field,
                        static_cast<size_t>(global_dof),
                        ctx_.material.saturation_magnetisation);
            }
        }
        V(0) = Ms * mx;
        V(1) = Ms * my;
        V(2) = Ms * mz;
    }

private:
    const Context &ctx_;
    const std::vector<double> &m_xyz_;
    mfem::FiniteElementSpace *fes_;
};

/// Assemble the Poisson RHS: b(v) = ∫_Ω_m M·∇v dV
bool assemble_poisson_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    mfem::Vector &rhs,
    std::string &error)
{
    debug_checkpoint("context_compute_demag_poisson:assemble_rhs_enter");
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    if (fes == nullptr) {
        error = "Poisson FE space is null during RHS assembly";
        return false;
    }

    MagnetizationCoefficient M_coeff(ctx, m_xyz, fes);

    mfem::LinearForm b(fes);
    b.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(M_coeff));
    b.Assemble();

    rhs.SetSize(fes->GetTrueVSize());
    if (const mfem::SparseMatrix *restriction = fes->GetRestrictionMatrix()) {
        restriction->Mult(b, rhs);
    } else {
        rhs = b;
    }
    debug_checkpoint("context_compute_demag_poisson:assemble_rhs_done");

    return true;
}

mfem::Array<int> poisson_essential_tdofs(const Context &ctx) {
    return mfem::Array<int>(
        const_cast<int *>(ctx.poisson_ess_tdof_list.data()),
        static_cast<int>(ctx.poisson_ess_tdof_list.size()));
}

void zero_poisson_essential_values(const Context &ctx, mfem::Vector &vec) {
    mfem::Array<int> ess_tdof = poisson_essential_tdofs(ctx);
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        vec(ess_tdof[i]) = 0.0;
    }
}

#ifdef MFEM_USE_MPI
// ── S10: Hypre GPU CG + BoomerAMG for Poisson ─────────────────────────
// Wraps the pre-eliminated SparseMatrix in a HypreParMatrix and solves
// with HyprePCG + HypreBoomerAMG.  MPI is initialized in serial mode
// (single process) solely to satisfy Hypre's interface requirements.

void ensure_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (!initialized) {
        int provided = 0;
        MPI_Init_thread(nullptr, nullptr, MPI_THREAD_FUNNELED, &provided);
    }
}

bool solve_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    debug_checkpoint("context_compute_demag_poisson:solve_enter_hypre");
    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_bc == nullptr) {
        error = "Poisson BC-eliminated operator is null during Hypre solve";
        return false;
    }

    ensure_mpi_initialized();

    // Apply BCs to RHS
    mfem::Vector rhs_bc(rhs);
    zero_poisson_essential_values(ctx, rhs_bc);

    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};

    // First call: build and cache the HypreParMatrix plus the configured
    // Krylov solver/preconditioner pair. The policy is chosen in Rust and
    // must be honored here to keep runtime diagnostics truthful.
    if (!ctx.poisson_solver_setup) {
        // Wrap the SparseMatrix in a HypreParMatrix (borrows pointers; lives as long as ctx)
        auto *A_par = new mfem::HypreParMatrix(MPI_COMM_WORLD, glob_size, row_starts, A_bc);
        ctx.mfem_cached_hypre_par = A_par;

        mfem::HypreSolver *preconditioner = nullptr;
        switch (ctx.demag_solver.preconditioner) {
        case FULLMAG_FEM_PRECONDITIONER_AMG: {
            auto *amg = new mfem::HypreBoomerAMG(*A_par);
            amg->SetPrintLevel(0);
            amg->SetRelaxType(18);   // l1-scaled Jacobi
            amg->SetCoarsening(8);   // PMIS
            amg->SetInterpolation(6);   // extended+i interpolation
            amg->SetAggressiveCoarsening(1);
            preconditioner = amg;
            break;
        }
        case FULLMAG_FEM_PRECONDITIONER_JACOBI:
            preconditioner = new mfem::HypreDiagScale(*A_par);
            break;
        case FULLMAG_FEM_PRECONDITIONER_NONE: {
            auto *identity = new mfem::HypreIdentity();
            identity->SetOperator(*A_par);
            preconditioner = identity;
            break;
        }
        default:
            error = "Unsupported native FEM demag preconditioner enum";
            delete A_par;
            ctx.mfem_cached_hypre_par = nullptr;
            return false;
        }
        ctx.mfem_cached_hypre_preconditioner = preconditioner;

        mfem::HypreSolver *solver = nullptr;
        switch (ctx.demag_solver.solver) {
        case FULLMAG_FEM_LINEAR_SOLVER_CG: {
            auto *pcg = new mfem::HyprePCG(MPI_COMM_WORLD);
            pcg->SetTol(ctx.demag_solver.relative_tolerance);
            pcg->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
            pcg->SetPrintLevel(0);
            pcg->SetOperator(*A_par);
            pcg->SetPreconditioner(*preconditioner);
            solver = pcg;
            break;
        }
        case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
            auto *gmres = new mfem::HypreGMRES(MPI_COMM_WORLD);
            gmres->SetTol(ctx.demag_solver.relative_tolerance);
            gmres->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
            gmres->SetKDim(50);
            gmres->SetPrintLevel(0);
            gmres->SetOperator(*A_par);
            gmres->SetPreconditioner(*preconditioner);
            solver = gmres;
            break;
        }
        default:
            error = "Unsupported native FEM demag linear solver enum";
            switch (ctx.demag_solver.preconditioner) {
            case FULLMAG_FEM_PRECONDITIONER_AMG:
                delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_JACOBI:
                delete static_cast<mfem::HypreDiagScale *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_NONE:
                delete static_cast<mfem::HypreIdentity *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            default:
                break;
            }
            ctx.mfem_cached_hypre_preconditioner = nullptr;
            delete A_par;
            ctx.mfem_cached_hypre_par = nullptr;
            return false;
        }
        ctx.mfem_cached_hypre_solver = solver;

        ctx.poisson_solver_setup = true;
    }

    auto *A_par = static_cast<mfem::HypreParMatrix *>(ctx.mfem_cached_hypre_par);
    auto *solver = static_cast<mfem::HypreSolver *>(ctx.mfem_cached_hypre_solver);

    // Build dedicated Hypre vectors and copy data explicitly.
    // Wrapping mfem::Vector::GetData() directly can trip MFEM/Hypre memory
    // ownership rules on GPU-enabled builds (Unknown pointer at destruction).
    mfem::HypreParVector b_par(MPI_COMM_WORLD, glob_size, row_starts);
    mfem::HypreParVector x_par(MPI_COMM_WORLD, glob_size, row_starts);
    if (b_par.Size() != rhs_bc.Size() || x_par.Size() != solution.Size()) {
        error = "Hypre vector size mismatch during Poisson solve";
        return false;
    }
    const double *rhs_host = rhs_bc.HostRead();
    double *b_host = b_par.HostWrite();
    const double *sol_host = solution.HostRead();
    double *x_host = x_par.HostWrite();
    for (int i = 0; i < rhs_bc.Size(); ++i) {
        b_host[i] = rhs_host[i];
        x_host[i] = sol_host[i];
    }

    solver->Mult(b_par, x_par);

    // Copy the solved potential back to the MFEM vector.
    const double *x_solved = x_par.HostRead();
    double *solution_host = solution.HostWrite();
    for (int i = 0; i < solution.Size(); ++i) {
        solution_host[i] = x_solved[i];
    }

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    switch (ctx.demag_solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_solver);
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(final_residual);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(ctx.mfem_cached_hypre_solver);
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(final_residual);
        break;
    }
    default:
        iterations = 0;
        final_residual = 0.0;
        break;
    }
    ctx.poisson_last_iterations = iterations;
    ctx.poisson_last_residual = static_cast<double>(final_residual);

    // Restore essential DOFs
    zero_poisson_essential_values(ctx, solution);

    debug_checkpoint("context_compute_demag_poisson:solve_done_hypre");
    return true;
}
#endif // MFEM_USE_MPI

/// Recover H_demag = -∇u from the scalar potential solution.
/// Computes element-wise gradient, distributes to nodes weighted by shape functions.
bool recover_demag_field(
    Context &ctx,
    const mfem::Vector &potential,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    const std::vector<double> &m_xyz,
    std::string &error)
{
    debug_checkpoint("context_compute_demag_poisson:recover_enter");
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "Poisson FE space or mesh is null during H_demag recovery";
        return false;
    }

    const size_t node_count = static_cast<size_t>(ctx.n_nodes);
    const size_t field_len = node_count * 3u;
    h_demag_xyz.assign(field_len, 0.0);

    // Create GridFunction from the potential solution
    mfem::GridFunction gf_u(fes);
    gf_u.SetFromTrueDofs(potential);

    // Accumulate -∇u at each node, weighted by shape * quadrature weight
    std::vector<double> node_weight(node_count, 0.0);

    auto accumulate_element = [&](int elem,
                                  std::vector<double> &field_accum,
                                  std::vector<double> &weight_accum,
                                  mfem::Array<int> &dofs,
                                  mfem::Vector &u_elem,
                                  mfem::DenseMatrix &dshape,
                                  mfem::Vector &shape) {
        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);

        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();
        u_elem.SetSize(local_ndof);
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            u_elem(i) = sign * gf_u(gdof);
        }

        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        shape.SetSize(local_ndof);
        dshape.SetSize(local_ndof, 3);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            fe->CalcPhysDShape(*T, dshape);

            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < local_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            fe->CalcShape(ip, shape);
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.n_nodes) {
                    continue;
                }
                const double phi_w = std::abs(shape(i)) * w;
                const size_t node = static_cast<size_t>(gdof);
                const size_t base = node * 3u;
                field_accum[base + 0] += -grad_u[0] * phi_w;
                field_accum[base + 1] += -grad_u[1] * phi_w;
                field_accum[base + 2] += -grad_u[2] * phi_w;
                weight_accum[node] += phi_w;
            }
        }
    };

    int recover_threads = 1;
#ifdef _OPENMP
    recover_threads = std::max(1, ctx.effective_omp_threads);
    const size_t bytes_per_thread =
        sizeof(double) * (field_len + node_count);
    constexpr size_t kMaxRecoverScratchBytes = 256ull * 1024ull * 1024ull;
    while (recover_threads > 1 &&
           bytes_per_thread * static_cast<size_t>(recover_threads) > kMaxRecoverScratchBytes) {
        recover_threads /= 2;
    }
#endif
    const bool parallel_recover = recover_threads > 1 && mesh->GetNE() >= 2000;

    if (parallel_recover) {
#ifdef _OPENMP
        std::vector<std::vector<double>> field_partials(
            static_cast<size_t>(recover_threads),
            std::vector<double>(field_len, 0.0));
        std::vector<std::vector<double>> weight_partials(
            static_cast<size_t>(recover_threads),
            std::vector<double>(node_count, 0.0));

#pragma omp parallel num_threads(recover_threads)
        {
            const int tid = omp_get_thread_num();
            auto &field_local = field_partials[static_cast<size_t>(tid)];
            auto &weight_local = weight_partials[static_cast<size_t>(tid)];
            mfem::Array<int> dofs;
            mfem::Vector u_elem;
            mfem::DenseMatrix dshape;
            mfem::Vector shape;

#pragma omp for schedule(static)
            for (int elem = 0; elem < mesh->GetNE(); ++elem) {
                accumulate_element(elem, field_local, weight_local, dofs, u_elem, dshape, shape);
            }
        }

#pragma omp parallel for schedule(static) num_threads(recover_threads)
        for (int node = 0; node < static_cast<int>(node_count); ++node) {
            double weight_sum = 0.0;
            double hx = 0.0;
            double hy = 0.0;
            double hz = 0.0;
            const size_t base = static_cast<size_t>(node) * 3u;
            for (int tid = 0; tid < recover_threads; ++tid) {
                const auto &field_local = field_partials[static_cast<size_t>(tid)];
                const auto &weight_local = weight_partials[static_cast<size_t>(tid)];
                hx += field_local[base + 0];
                hy += field_local[base + 1];
                hz += field_local[base + 2];
                weight_sum += weight_local[static_cast<size_t>(node)];
            }
            node_weight[static_cast<size_t>(node)] = weight_sum;
            if (weight_sum > 0.0) {
                h_demag_xyz[base + 0] = hx / weight_sum;
                h_demag_xyz[base + 1] = hy / weight_sum;
                h_demag_xyz[base + 2] = hz / weight_sum;
            }
        }
#endif
    } else {
        mfem::Array<int> dofs;
        mfem::Vector u_elem;
        mfem::DenseMatrix dshape;
        mfem::Vector shape;
        for (int elem = 0; elem < mesh->GetNE(); ++elem) {
            accumulate_element(elem, h_demag_xyz, node_weight, dofs, u_elem, dshape, shape);
        }

#ifdef _OPENMP
#pragma omp parallel for schedule(static) if(recover_threads > 1 && static_cast<int>(node_count) >= 2048) num_threads(recover_threads)
#endif
        for (int node = 0; node < static_cast<int>(node_count); ++node) {
            const double weight = node_weight[static_cast<size_t>(node)];
            if (weight > 0.0) {
                const size_t base = static_cast<size_t>(node) * 3u;
                h_demag_xyz[base + 0] /= weight;
                h_demag_xyz[base + 1] /= weight;
                h_demag_xyz[base + 2] /= weight;
            }
        }
    }

    // Preserve full-domain H_demag for visualization before zeroing airbox.
    ctx.h_demag_visual_xyz = h_demag_xyz;

    // Zero out non-magnetic nodes (required for LLG and energy computation)
    zero_non_magnetic_nodes_aos(h_demag_xyz, ctx.magnetic_node_mask);

    // Demag energy: E_d = -μ₀/2 · M_s · Σᵢ (m·h_d)ᵢ · M_Lᵢ
    if (ctx.mfem_lumped_mass.empty()) {
        error = "MFEM lumped mass is unavailable for Poisson demag energy evaluation";
        return false;
    }

    demag_energy = 0.0;
#ifdef _OPENMP
#pragma omp parallel for schedule(static) reduction(+:demag_energy) if(recover_threads > 1 && static_cast<int>(ctx.mfem_lumped_mass.size()) >= 2048) num_threads(recover_threads)
#endif
    for (int i = 0; i < static_cast<int>(ctx.mfem_lumped_mass.size()); ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t node = static_cast<size_t>(i);
        const size_t base = node * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        const double Ms_i = scalar_field_value(
            ctx.Ms_field,
            node,
            ctx.material.saturation_magnetisation);
        demag_energy +=
            -0.5 * kMu0 * Ms_i * mdoth * ctx.mfem_lumped_mass[node];
    }

    // Robin BC correction: E_bdr = (μ₀/2) · β · ∫_Γ u² dS
    // This additional term accounts for the potential energy stored at the
    // open boundary when using the Robin approximation.
    // Cache it separately so that frozen-field energy updates (when
    // field_refresh skips a Poisson solve) can include this term.
    ctx.cached_robin_boundary_energy = 0.0;
    if (ctx.demag_realization == 2 /* AIRBOX_ROBIN */ &&
        ctx.robin_effective_beta > 0.0 &&
        ctx.mfem_boundary_mass != nullptr) {
        auto *bdr_mass =
            static_cast<mfem::BilinearForm *>(ctx.mfem_boundary_mass);
        mfem::Vector Bu(gf_u.Size());
        bdr_mass->SpMat().Mult(gf_u, Bu);
        ctx.cached_robin_boundary_energy =
            0.5 * kMu0 * ctx.robin_effective_beta * (gf_u * Bu);
        demag_energy += ctx.cached_robin_boundary_energy;
    }

    debug_checkpoint("context_compute_demag_poisson:recover_done");
    return true;
}

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
        double *mx_host = gf_mx->HostWrite();
        double *my_host = gf_my->HostWrite();
        double *mz_host = gf_mz->HostWrite();
        double *a_host = gf_a->HostWrite();
        double *ms_host = gf_ms->HostWrite();
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

        auto *exchange_form = new mfem::BilinearForm(fes);
        auto *mass_form = new mfem::BilinearForm(fes);
        auto *mass_ones = new mfem::Vector(fes->GetNDofs());
        auto *mass_lumped = new mfem::Vector(fes->GetNDofs());
        auto *inv_lumped_mass = new mfem::Vector(fes->GetNDofs());
        auto *exchange_tmp_vec = new mfem::Vector(fes->GetNDofs());
        auto *exchange_out_vec = new mfem::Vector(fes->GetNDofs());
        mass_ones->UseDevice(true);
        mass_lumped->UseDevice(true);
        inv_lumped_mass->UseDevice(true);
        exchange_tmp_vec->UseDevice(true);
        exchange_out_vec->UseDevice(true);

        // F-01 fix: build magnetic attribute set from the actual magnetic
        // element mask instead of hardcoding attribute 1.  This ensures
        // exchange/mass are assembled on the correct region regardless of
        // the marker values used by the mesh.
        const int max_attr = mesh->attributes.Max();
        mfem::Array<int> magnetic_attr_marker(max_attr);
        magnetic_attr_marker = 0;

        // Collect MFEM attributes that belong to magnetic elements.
        for (int e = 0; e < mesh->GetNE(); ++e) {
            if (!ctx.magnetic_element_mask.empty() &&
                static_cast<size_t>(e) < ctx.magnetic_element_mask.size() &&
                ctx.magnetic_element_mask[e] == 0u) {
                continue; // non-magnetic element
            }
            const int attr = mesh->GetAttribute(e);
            if (attr >= 1 && attr <= max_attr) {
                magnetic_attr_marker[attr - 1] = 1;
            }
        }

        // Validate: if exchange is enabled, at least one attribute must be active.
        {
            int n_active_attrs = 0;
            for (int a = 0; a < max_attr; ++a) {
                n_active_attrs += magnetic_attr_marker[a];
            }
            if (ctx.enable_exchange && n_active_attrs == 0) {
                error = "F-01 validation: enable_exchange=true but no MFEM "
                        "attributes are marked as magnetic — exchange/mass "
                        "assembly would be empty.  Check element_markers.";
                delete exchange_form;
                delete mass_form;
                delete exchange_out_vec;
                delete exchange_tmp_vec;
                delete inv_lumped_mass;
                delete mass_lumped;
                delete mass_ones;
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
        }

        // The intended end state for exchange is partial assembly, but the
        // current MFEM 4.7 tetrahedral H1 path in the managed GPU runtime can
        // abort in `GetDofToQuad(..., DofToQuad::FULL)` before the simulation
        // even starts. Use the assembled operator path here so FEM can execute
        // on the GPU via device-backed SpMV instead of crashing at startup.
        exchange_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
        exchange_form->AddDomainIntegrator(
            new mfem::DiffusionIntegrator(*a_coeff),
            magnetic_attr_marker);
        exchange_form->Assemble();
        exchange_form->Finalize();
        debug_checkpoint("context_initialize_mfem:exchange_form_ready");

        // Build the scalar mass form once in the assembled mode to obtain a
        // stable lumped diagonal for runtime use on simplex meshes.
        mass_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
        mass_form->AddDomainIntegrator(
            new mfem::MassIntegrator(), magnetic_attr_marker);
        mass_form->Assemble();
        mass_form->Finalize();
        prepare_mass_lumping(*mass_form, *mass_ones, *mass_lumped, *inv_lumped_mass, ctx.mfem_lumped_mass);
        debug_checkpoint("context_initialize_mfem:mass_ready");
        const bool has_nonzero_lumped_mass = std::any_of(
            ctx.mfem_lumped_mass.begin(),
            ctx.mfem_lumped_mass.end(),
            [](double value) { return value > 0.0; });
        if (ctx.enable_exchange && !has_nonzero_lumped_mass) {
            error = "F-01 validation: enable_exchange=true but MFEM lumped "
                    "mass is zero on every node in the resolved magnetic "
                    "domain.  Check element_markers and magnetic region "
                    "resolution.";
            delete exchange_form;
            delete mass_form;
            delete exchange_out_vec;
            delete exchange_tmp_vec;
            delete inv_lumped_mass;
            delete mass_lumped;
            delete mass_ones;
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

        ctx.mfem_mesh = mesh;
        ctx.mfem_fec = fec;
        ctx.mfem_fes = fes;
        ctx.mfem_gf_mx = gf_mx;
        ctx.mfem_gf_my = gf_my;
        ctx.mfem_gf_mz = gf_mz;
        ctx.mfem_gf_a = gf_a;
        ctx.mfem_gf_ms = gf_ms;
        ctx.mfem_a_coeff = a_coeff;
        ctx.mfem_exchange_form = exchange_form;
        ctx.mfem_mass_form = mass_form;
        ctx.mfem_mass_ones = mass_ones;
        ctx.mfem_mass_lumped = mass_lumped;
        ctx.mfem_inv_lumped_mass = inv_lumped_mass;
        ctx.mfem_exchange_tmp_vec = exchange_tmp_vec;
        ctx.mfem_exchange_out_vec = exchange_out_vec;
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

void context_destroy_mfem(Context &ctx) {
    // Destroy Poisson demag resources first
    context_destroy_poisson(ctx);

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

// ─────────────────────────────────────────────────────────────────────────────
// Poisson demag initialization / destruction / compute (S02–S05)
// ─────────────────────────────────────────────────────────────────────────────

bool context_initialize_poisson(Context &ctx, std::string &error) {
    try {
        debug_checkpoint("context_initialize_poisson:enter");
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
        if (mesh == nullptr) {
            error = "MFEM mesh is null — cannot initialize Poisson demag";
            return false;
        }

        // S02: Scalar H1 FE space on the FULL mesh (magnetic + air)
        auto *potential_fec = new mfem::H1_FECollection(
            static_cast<int>(ctx.fe_order), mesh->Dimension());
        auto *potential_fes = new mfem::FiniteElementSpace(mesh, potential_fec);

        // S02: Poisson bilinear form: a(u,v) = ∫ ∇u·∇v dV (Laplacian)
        auto *poisson_bilinear = new mfem::BilinearForm(potential_fes);
        poisson_bilinear->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        poisson_bilinear->Assemble();
        poisson_bilinear->Finalize();

        // Potential GridFunction (warm-start: zeros initially)
        auto *gf_potential = new mfem::GridFunction(potential_fes);
        gf_potential->UseDevice(true);
        *gf_potential = 0.0;

        ctx.mfem_potential_fec = potential_fec;
        ctx.mfem_potential_fes = potential_fes;
        ctx.mfem_poisson_bilinear = poisson_bilinear;
        ctx.mfem_gf_potential = gf_potential;

        if (ctx.demag_realization == 2 /* AIRBOX_ROBIN */) {
            // ── Robin BC path: A = K + β·B, no essential DOFs ──
            // Compute β = c / R*
            double c = ctx.robin_beta_factor;
            if (ctx.robin_beta_mode == 1) { c = 1.0; }       // legacy
            else if (ctx.robin_beta_mode == 2) { c = 2.0; }  // dipole
            // else ctx.robin_beta_mode == 3: use user-specified c

            // Auto-compute R* from mesh bounding box
            mfem::Vector bb_min, bb_max;
            mesh->GetBoundingBox(bb_min, bb_max);
            double max_extent = 0.0;
            for (int d = 0; d < mesh->Dimension(); ++d) {
                max_extent = std::max(max_extent, bb_max(d) - bb_min(d));
            }
            double R_star = max_extent / 2.0;
            if (R_star <= 0.0) { R_star = 1.0; } // safety
            ctx.robin_effective_beta = c / R_star;

            // Build boundary mass matrix B on Γ_out
            auto *bdr_mass = new mfem::BilinearForm(potential_fes);
            mfem::Array<int> bdr_marker(mesh->bdr_attributes.Max());
            bdr_marker = 0;
            if (ctx.poisson_boundary_marker >= 1 &&
                ctx.poisson_boundary_marker <= mesh->bdr_attributes.Max()) {
                bdr_marker[ctx.poisson_boundary_marker - 1] = 1;
            } else {
                // F-11 fix: error instead of silently assembling empty boundary.
                error = "Robin BC: poisson_boundary_marker=" +
                        std::to_string(ctx.poisson_boundary_marker) +
                        " not found in mesh bdr_attributes (max=" +
                        std::to_string(mesh->bdr_attributes.Max()) +
                        "). Check air_box_config boundary markers.";
                delete poisson_bilinear;
                delete potential_fes;
                delete potential_fec;
                delete gf_potential;
                return false;
            }
            bdr_mass->AddBoundaryIntegrator(
                new mfem::MassIntegrator(), bdr_marker);
            bdr_mass->Assemble();
            bdr_mass->Finalize();
            ctx.mfem_boundary_mass = bdr_mass;

            // Form A = K + β·B (no essential DOFs for Robin)
            auto *A_robin = new mfem::SparseMatrix(poisson_bilinear->SpMat());
            A_robin->Add(ctx.robin_effective_beta, bdr_mass->SpMat());
            ctx.mfem_poisson_bc_op = A_robin;
            ctx.poisson_ess_tdof_list.clear();
        } else {
            // ── Dirichlet BC path (default): u = 0 on Γ_out ──
            ctx.poisson_ess_tdof_list.clear();
            if (ctx.poisson_boundary_marker > 0) {
                if (ctx.poisson_boundary_marker > mesh->bdr_attributes.Max()) {
                    // F-11 fix: error when boundary marker not found.
                    error = "Dirichlet BC: poisson_boundary_marker=" +
                            std::to_string(ctx.poisson_boundary_marker) +
                            " exceeds mesh bdr_attributes.Max()=" +
                            std::to_string(mesh->bdr_attributes.Max()) +
                            ". Check air_box_config boundary markers.";
                    delete poisson_bilinear;
                    delete potential_fes;
                    delete potential_fec;
                    delete gf_potential;
                    return false;
                }
                mfem::Array<int> bdr_attr_is_ess(mesh->bdr_attributes.Max());
                bdr_attr_is_ess = 0;
                bdr_attr_is_ess[ctx.poisson_boundary_marker - 1] = 1;
                mfem::Array<int> ess_tdof;
                potential_fes->GetEssentialTrueDofs(bdr_attr_is_ess, ess_tdof);
                ctx.poisson_ess_tdof_list.assign(
                    ess_tdof.GetData(),
                    ess_tdof.GetData() + ess_tdof.Size());
            }

            if (ctx.poisson_ess_tdof_list.empty()) {
                // FND-006 fix: no boundary DOFs found is a hard error, not a fallback.
                // Pinning DOF 0 silently produces physically incorrect demag results.
                error = "Dirichlet BC for Poisson — no boundary DOFs found for marker=" +
                        std::to_string(ctx.poisson_boundary_marker) +
                        ". Check that the mesh has correctly marked outer boundary faces "
                        "and that air_box_config.boundary_marker matches.";
                delete poisson_bilinear;
                delete potential_fes;
                delete potential_fec;
                delete gf_potential;
                return false;
            }

            // S09: Pre-compute the BC-eliminated Poisson operator
            mfem::Array<int> ess_tdof(
                ctx.poisson_ess_tdof_list.data(),
                static_cast<int>(ctx.poisson_ess_tdof_list.size()));
            auto *A_bc = new mfem::SparseMatrix(poisson_bilinear->SpMat());
            for (int i = 0; i < ess_tdof.Size(); ++i) {
                A_bc->EliminateRowCol(ess_tdof[i]);
            }
            ctx.mfem_poisson_bc_op = A_bc;
        }

        ctx.poisson_ready = true;
        debug_checkpoint("context_initialize_poisson:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson demag initialization failed with an unknown error";
    }
    context_destroy_poisson(ctx);
    return false;
}

void context_destroy_poisson(Context &ctx) {
    // Cached Hypre solver objects — must be deleted before the matrix they reference.
    // Order matters: solver → preconditioner → ParMatrix (reverse of construction).
#ifdef MFEM_USE_MPI
    switch (ctx.demag_solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG:
        delete static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_solver);
        break;
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES:
        delete static_cast<mfem::HypreGMRES *>(ctx.mfem_cached_hypre_solver);
        break;
    default:
        break;
    }
    ctx.mfem_cached_hypre_solver = nullptr;
    switch (ctx.demag_solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG:
        delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        delete static_cast<mfem::HypreDiagScale *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        delete static_cast<mfem::HypreIdentity *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    default:
        break;
    }
    ctx.mfem_cached_hypre_preconditioner = nullptr;
    delete static_cast<mfem::HypreParMatrix *>(ctx.mfem_cached_hypre_par);
    ctx.mfem_cached_hypre_par = nullptr;
#endif
    ctx.poisson_solver_setup = false;

    // S09: BC-eliminated matrix is a separate allocation — delete first.
    delete static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    ctx.mfem_poisson_bc_op = nullptr;
    // Robin boundary mass form (separate allocation)
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_boundary_mass);
    ctx.mfem_boundary_mass = nullptr;
    // Poisson bilinear form owns the SparseMatrix — don't double-free
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_poisson_bilinear);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_potential_fec);
    ctx.mfem_gf_potential = nullptr;
    ctx.mfem_poisson_bilinear = nullptr;
    ctx.mfem_potential_fes = nullptr;
    ctx.mfem_potential_fec = nullptr;
    ctx.mfem_poisson_rhs = nullptr;
    ctx.mfem_poisson_rhs_vec = nullptr;
    ctx.poisson_ess_tdof_list.clear();
    ctx.poisson_ready = false;
}

bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    std::string &error)
{
    if (!ctx.poisson_ready) {
        error = "Poisson demag requested before initialization";
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:enter");
    const uint64_t demag_call_index = ++ctx.demag_call_count;

    // S03: Assemble RHS b(v) = ∫ M·∇v dV
    const auto assemble_wall_start = SteadyClock::now();
    mfem::Vector rhs;
    if (!assemble_poisson_rhs(ctx, m_xyz, rhs, error)) {
        return false;
    }
    const uint64_t assemble_wall_time_ns = elapsed_ns(assemble_wall_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    // S04: Solve -∇²u = -∇·M with Dirichlet BCs
    auto *gf_potential = static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    mfem::Vector solution(fes->GetTrueVSize());
    gf_potential->GetTrueDofs(solution);  // warm-start

    const auto solve_wall_start = SteadyClock::now();
#ifdef MFEM_USE_MPI
    if (!solve_poisson_hypre(ctx, rhs, solution, error)) {
        return false;
    }
#else
    error =
        "Poisson demag requires an MPI/Hypre-enabled MFEM runtime; legacy CPU-native fallback solvers were removed";
    return false;
#endif
    const uint64_t solve_wall_time_ns = elapsed_ns(solve_wall_start);
    debug_checkpoint("context_compute_demag_poisson:solve_done");
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    // S05: Recover H_demag = -∇u and compute energy
    const auto recover_wall_start = SteadyClock::now();
    if (!recover_demag_field(ctx, solution, h_demag_xyz, demag_energy, m_xyz, error)) {
        return false;
    }
    const uint64_t recover_wall_time_ns = elapsed_ns(recover_wall_start);
    debug_checkpoint("context_compute_demag_poisson:recover_done");
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    // Store solution for warm-start in next step
    gf_potential->SetFromTrueDofs(solution);
    log_demag_call_profile(
        ctx,
        demag_call_index,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        recover_wall_time_ns);

    return true;
}

bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error) {
    debug_checkpoint("context_refresh_exchange_field_mfem:enter");
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            ctx.h_ex_xyz,
            ctx.h_demag_xyz,
            ctx.h_eff_xyz,
            &exchange_energy,
            &demag_energy,
            false,
            nullptr,
            error)) {
        return false;
    }
    ctx.mfem_exchange_ready = true;
    debug_checkpoint("context_refresh_exchange_field_mfem:done");
    return true;
}

bool context_snapshot_stats_mfem(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};

    if (!ctx.mfem_ready) {
        error = "MFEM snapshot requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_effective_field_term(ctx)) {
        error = "native FEM snapshot requires at least one effective-field term";
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

// ── Static Butcher tableaux ───────────────────────────────────────────────

static const ExplicitTableau TABLEAU_HEUN = {
    /* stages */ 2,
    /* c */      {0.0, 1.0},
    /* a */      {{0},
                  {1.0}},
    /* b_hi */   {0.5, 0.5},
    /* b_lo */   {0},
    /* order_hi */  2,
    /* order_est */ 0,
    /* fsal */      false,
};

static const ExplicitTableau TABLEAU_RK4 = {
    /* stages */ 4,
    /* c */      {0.0, 0.5, 0.5, 1.0},
    /* a */      {{0},
                  {0.5},
                  {0.0, 0.5},
                  {0.0, 0.0, 1.0}},
    /* b_hi */   {1.0/6.0, 1.0/3.0, 1.0/3.0, 1.0/6.0},
    /* b_lo */   {0},
    /* order_hi */  4,
    /* order_est */ 0,
    /* fsal */      false,
};

static const ExplicitTableau TABLEAU_BS23 = {
    /* stages */ 4,
    /* c */      {0.0, 0.5, 0.75, 1.0},
    /* a */      {{0},
                  {0.5},
                  {0.0,   0.75},
                  {2.0/9.0, 1.0/3.0, 4.0/9.0}},
    /* b_hi */   {2.0/9.0, 1.0/3.0, 4.0/9.0, 0.0},        // 3rd order
    /* b_lo */   {7.0/24.0, 0.25, 1.0/3.0, 0.125},         // 2nd order (error est)
    /* order_hi */  3,
    /* order_est */ 2,
    /* fsal */      true,  // k[3] at c=1 reuses as k[0] of next step
};

static const ExplicitTableau TABLEAU_DP54 = {
    /* stages */ 7,
    /* c */      {0.0, 0.2, 0.3, 0.8, 8.0/9.0, 1.0, 1.0},
    /* a */      {{0},
                  {0.2},
                  {3.0/40.0,       9.0/40.0},
                  {44.0/45.0,      -56.0/15.0,     32.0/9.0},
                  {19372.0/6561.0, -25360.0/2187.0, 64448.0/6561.0, -212.0/729.0},
                  {9017.0/3168.0,  -355.0/33.0,     46732.0/5247.0,  49.0/176.0,  -5103.0/18656.0},
                  {35.0/384.0,      0.0,             500.0/1113.0,    125.0/192.0, -2187.0/6784.0, 11.0/84.0}},
    /* b_hi */   {35.0/384.0,  0.0,  500.0/1113.0,  125.0/192.0,  -2187.0/6784.0,  11.0/84.0,  0.0},  // 5th order
    /* b_lo */   {5179.0/57600.0, 0.0, 7571.0/16695.0, 393.0/640.0, -92097.0/339200.0, 187.0/2100.0, 1.0/40.0}, // 4th order
    /* order_hi */  5,
    /* order_est */ 4,
    /* fsal */      true,  // k[6] == k[0] of next step
};

const ExplicitTableau &tableau_for_integrator(fullmag_fem_integrator integrator) {
    switch (integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:      return TABLEAU_HEUN;
        case FULLMAG_FEM_INTEGRATOR_RK4:       return TABLEAU_RK4;
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:   return TABLEAU_BS23;
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54: return TABLEAU_DP54;
        default:
            // FEM-016 fix: abort instead of silently degrading to Heun.
            std::fprintf(stderr,
                "FATAL: tableau_for_integrator called with unsupported "
                "integrator value %d — refusing silent fallback to Heun\n",
                static_cast<int>(integrator));
            std::abort();
    }
}

void stepper_workspace_allocate(StepperWorkspace &ws, size_t dof_len, int stages) {
    if (ws.allocated && ws.dof_len == dof_len) return;
    ws.dof_len = dof_len;
    ws.m_backup.resize(dof_len, 0.0);
    for (int i = 0; i < stages; ++i) {
        ws.k[i].resize(dof_len, 0.0);
    }
    ws.m_stage.resize(dof_len, 0.0);
    ws.h_ex_tmp.resize(dof_len, 0.0);
    ws.h_demag_tmp.resize(dof_len, 0.0);
    ws.h_eff_tmp.resize(dof_len, 0.0);
    ws.err.resize(dof_len, 0.0);
    ws.fsal_valid = false;
    ws.allocated = true;
}

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
        ctx.h_ex_xyz = ws.h_ex_tmp;
        ctx.h_demag_xyz = ws.h_demag_tmp;
        ctx.h_eff_xyz = ws.h_eff_tmp;
    } else {
        std::vector<double> h_ex_final;
        std::vector<double> h_demag_final;
        std::vector<double> h_eff_final;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                h_ex_final,
                h_demag_final,
                h_eff_final,
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
        ctx.h_ex_xyz = std::move(h_ex_final);
        ctx.h_demag_xyz = std::move(h_demag_final);
        ctx.h_eff_xyz = std::move(h_eff_final);
    }
    ctx.current_time += dt;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Post-step RHS for max_dm_dt metric
    double max_rhs_final = 0.0;
    if (final_stage_cache_valid) {
        max_rhs_final = max_norm_aos(ws.k[0]);
    } else {
        std::vector<double> rhs_final;
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(ctx.m_xyz, ctx.h_eff_xyz,
                    ctx.material.gyromagnetic_ratio, ctx.material.damping,
                    ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
                    rhs_final, max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, rhs_final, max_rhs_final);
        zero_non_magnetic_nodes_aos(rhs_final, ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(rhs_final);
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
