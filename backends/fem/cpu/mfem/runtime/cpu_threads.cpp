/*
 * CPU threading runtime source contract.
 *
 * This source owns plan/env CPU thread resolution, OpenMP runtime limits, and
 * demag/exchange thread policy publication into Context. It does not choose MFEM devices, manage contexts, execute steps, or publish solver metrics.
 */

#include "cpu/mfem/runtime/cpu_threads.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <thread>

#ifdef _OPENMP
#include <omp.h>
#endif

namespace fullmag::fem {

namespace {

int detected_cpu_threads()
{
#ifdef _OPENMP
    return std::max(1, omp_get_num_procs());
#else
    const unsigned int concurrency = std::thread::hardware_concurrency();
    return static_cast<int>(std::max(1u, concurrency));
#endif
}

std::optional<int> parse_positive_env_int(const char *name)
{
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

bool env_requests_auto_threads(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "auto") == 0 ||
           std::strcmp(raw, "AUTO") == 0 ||
           std::strcmp(raw, "Auto") == 0;
}

} // namespace

CpuThreadRequest requested_cpu_threads()
{
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

int auto_cpu_thread_cap_for_context(const Context &ctx, int requested_threads)
{
    if (requested_threads <= 1 || mfem_device_requests_gpu(ctx)) {
        return std::max(1, requested_threads);
    }
    const uint32_t node_count = ctx.mesh.n_nodes;
    const uint32_t element_count = ctx.mesh.n_elements;
    if (node_count <= 10000u || element_count <= 75000u) {
        return std::min(requested_threads, 8);
    }
    if (node_count <= 50000u || element_count <= 400000u) {
        return std::min(requested_threads, 16);
    }
    return std::max(1, requested_threads);
}

void configure_cpu_openmp_runtime(Context &ctx)
{
    const CpuThreadRequest request = requested_cpu_threads();
    ctx.cpu_threads.auto_requested = request.auto_requested;
    ctx.cpu_threads.requested_omp_threads = request.requested_threads;
    ctx.cpu_threads.effective_omp_threads = request.requested_threads;
    if (request.auto_requested) {
        ctx.cpu_threads.effective_omp_threads = request.auto_resolved_threads > 0
            ? std::min(request.requested_threads, request.auto_resolved_threads)
            : auto_cpu_thread_cap_for_context(ctx, request.requested_threads);
    }
#ifdef _OPENMP
    omp_set_num_threads(ctx.cpu_threads.effective_omp_threads);
#endif
}

void log_cpu_runtime_selection(const Context &ctx)
{
    if (mfem_device_requests_gpu(ctx)) {
        return;
    }
    const char *thread_mode = ctx.cpu_threads.auto_requested ? "auto" : "manual";

    std::fprintf(
        stderr,
        "[fullmag-fem] cpu runtime: poisson_solver=%s preconditioner=%s cpu_threads=%s requested_omp_threads=%d effective_omp_threads=%d mesh_nodes=%u elements=%u\n",
        demag_poisson_linear_solver_name(ctx.demag.solver.solver),
        demag_poisson_preconditioner_name(ctx.demag.solver.preconditioner),
        thread_mode,
        ctx.cpu_threads.requested_omp_threads,
        ctx.cpu_threads.effective_omp_threads,
        ctx.mesh.n_nodes,
        ctx.mesh.n_elements);
}

} // namespace fullmag::fem
