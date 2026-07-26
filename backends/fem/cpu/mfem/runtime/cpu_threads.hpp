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
 * Runtime-published CPU/OpenMP thread telemetry.
 *
 * This state is stored on Context for ABI snapshots and demag/recovery loops,
 * but cpu_threads.* owns how it is resolved from env/plan policy.
 */
struct CpuThreadRuntimeState {
    bool auto_requested = false;
    int requested_omp_threads = 1;
    int effective_omp_threads = 1;
    int cap_reason = 0;
};

enum CpuThreadCapReason {
    FULLMAG_FEM_CPU_THREAD_CAP_NONE = 0,
    FULLMAG_FEM_CPU_THREAD_CAP_EXTERNAL_AUTO_RESOLVED = 1,
    FULLMAG_FEM_CPU_THREAD_CAP_SMALL_MESH = 2,
    FULLMAG_FEM_CPU_THREAD_CAP_MEDIUM_MESH = 3,
    FULLMAG_FEM_CPU_THREAD_CAP_GPU_DEFAULT_ONE = 4,
    FULLMAG_FEM_CPU_THREAD_CAP_AUTO_UNCAPPED = 5,
};

inline constexpr int FULLMAG_FEM_HOST_THREAD_POLICY_NONE =
    FULLMAG_FEM_CPU_THREAD_CAP_NONE;
inline constexpr int FULLMAG_FEM_HOST_THREAD_POLICY_GPU_DEFAULT_ONE =
    FULLMAG_FEM_CPU_THREAD_CAP_GPU_DEFAULT_ONE;

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
 * Small meshes avoid oversubscribing OpenMP overhead; large CPU meshes keep
 * the requested count. Automatic GPU host policy resolves deliberately to one
 * thread until an A/B-qualified default is promoted.
 */
int auto_cpu_thread_cap_for_context(const Context &ctx, int requested_threads);
int auto_cpu_thread_cap_reason_for_context(const Context &ctx, int requested_threads);

/*
 * Apply the resolved host/OpenMP thread policy to the native FEM context.
 *
 * The context fields become the source of truth for telemetry and downstream
 * demag recovery loops; when OpenMP is compiled in, the runtime thread count is
 * also pushed into `omp_set_num_threads`.
 *
 * It does not choose MFEM devices, manage contexts, execute steps, or publish
 * solver metrics.
 */
void configure_fem_host_runtime_threads(Context &ctx);

/*
 * Emit one startup diagnostic for the selected CPU runtime.
 *
 * GPU MFEM device requests suppress this log because CPU thread telemetry is
 * not the runtime selector for that path.
 */
void log_cpu_runtime_selection(const Context &ctx);

} // namespace fullmag::fem
