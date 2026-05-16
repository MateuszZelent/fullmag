#pragma once

namespace fullmag::fem {

struct Context;

/*
 * Parsed CPU thread request from the native FEM runtime environment.
 *
 * `requested_threads` is the user-facing requested count. In auto mode it is
 * the detected host capacity. `auto_resolved_threads` is an optional external
 * resolver hint used to make auto mode deterministic in launchers.
 */
struct CpuThreadRequest {
    int requested_threads = 1;
    int auto_resolved_threads = 0;
    bool auto_requested = false;
};

/*
 * Resolve CPU thread intent from environment variables.
 *
 * `FULLMAG_CPU_THREADS=auto` owns auto mode and overrides manual OMP settings.
 * Otherwise `OMP_NUM_THREADS` wins over manual `FULLMAG_CPU_THREADS`, matching
 * OpenMP user expectations.
 */
CpuThreadRequest requested_cpu_threads();

/*
 * Cap automatic CPU thread counts according to native FEM problem size.
 *
 * Small meshes avoid oversubscribing OpenMP overhead; large meshes keep the
 * requested count. GPU MFEM device requests bypass this cap.
 */
int auto_cpu_thread_cap_for_context(const Context &ctx, int requested_threads);

/*
 * Apply the resolved CPU/OpenMP thread policy to the native FEM context.
 *
 * The context fields become the source of truth for telemetry and downstream
 * demag recovery loops; when OpenMP is compiled in, the runtime thread count is
 * also pushed into `omp_set_num_threads`.
 */
void configure_cpu_openmp_runtime(Context &ctx);

/*
 * Emit one startup diagnostic for the selected CPU runtime.
 *
 * GPU MFEM device requests suppress this log because CPU thread telemetry is
 * not the runtime selector for that path.
 */
void log_cpu_runtime_selection(const Context &ctx);

} // namespace fullmag::fem
