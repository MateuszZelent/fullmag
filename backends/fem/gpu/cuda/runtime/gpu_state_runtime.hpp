#pragma once

/*
 * GPU CUDA state-runtime module header.
 *
 * Declares CUDA runtime handles, legacy sparse exchange metadata, and the
 * context bootstrap bridge that uploads FEM runtime state into FemGpuState.
 */

#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/transfer/snapshot_pool.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Return whether enabled GPU physics consumes the flat tetrahedral geometry
 * buffer. Exchange and Poisson demag consume assembled operators instead.
 */
bool gpu_state_requires_tetrahedral_mesh_geometry(const Context &ctx);

/*
 * Runtime metadata for the legacy sparse GPU exchange path.
 *
 * MFEM exchange assembly records sparse operator dimensions and lumped-mass
 * readiness here. GPU exchange planning reads this metadata before allowing
 * device-resident exchange stages.
 */
struct LegacyGpuExchangeRuntimeState {
    bool legacy_sparse_metadata_ready = false;
    uint64_t legacy_sparse_rows = 0;
    uint64_t legacy_sparse_cols = 0;
    uint64_t legacy_sparse_nnz = 0;
    bool lumped_mass_ready = false;
};

/*
 * Runtime state for CUDA streams and persistent snapshot resources.
 *
 * CUDA-capable native FEM execution creates high-priority compute and
 * low-priority I/O streams plus a compute event. Snapshot submission leases
 * preallocated staging, pinned-host, and event resources from a bounded pool.
 */
struct CudaRuntimeState {
    void *compute_stream = nullptr;
    void *io_stream = nullptr;
    void *compute_event = nullptr;
    std::shared_ptr<FemGpuSnapshotPoolState> snapshot_pool{};
};

struct GpuRkPhaseTimingRuntimeState {
    struct EventPair {
        void *start_event = nullptr;
        void *stop_event = nullptr;
    };

    bool configured = false;
    bool enabled = false;
    bool override_configured = false;
    bool override_enabled = false;
    uint64_t exchange_wall_time_ns = 0;
    uint64_t demag_assemble_wall_time_ns = 0;
    uint64_t demag_recover_wall_time_ns = 0;
    uint64_t demag_energy_wall_time_ns = 0;
    uint64_t rhs_wall_time_ns = 0;
    size_t exchange_used = 0;
    size_t demag_assemble_used = 0;
    size_t demag_recover_used = 0;
    size_t demag_energy_used = 0;
    size_t rhs_used = 0;
    uint64_t exchange_overflow_count = 0;
    uint64_t demag_assemble_overflow_count = 0;
    uint64_t demag_recover_overflow_count = 0;
    uint64_t demag_energy_overflow_count = 0;
    uint64_t rhs_overflow_count = 0;
    std::vector<EventPair> exchange_events{};
    std::vector<EventPair> demag_assemble_events{};
    std::vector<EventPair> demag_recover_events{};
    std::vector<EventPair> demag_energy_events{};
    std::vector<EventPair> rhs_events{};
};

/*
 * Optional profiler-only telemetry for the GPU portion of one outer RK
 * transaction.  Event pairs are allocated lazily on the first profiled
 * capture/restore and reused across attempts; profiler-off execution keeps
 * both vectors empty.  The byte counters count only the D2D ranges enqueued
 * by the transaction (component fields plus present Poisson solutions).
 */
struct GpuRkTransactionTelemetryRuntimeState {
    struct EventPair {
        void *start_event = nullptr;
        void *stop_event = nullptr;
    };

    std::vector<EventPair> capture_events{};
    std::vector<EventPair> restore_events{};
    size_t capture_used = 0;
    size_t restore_used = 0;
    uint64_t capture_bytes = 0;
    uint64_t restore_bytes = 0;
    uint64_t capture_device_elapsed_ns = 0;
    uint64_t restore_device_elapsed_ns = 0;
    uint64_t capture_event_pairs_created = 0;
    uint64_t restore_event_pairs_created = 0;
};

/*
 * Runtime owner for the native FEM GPU-state object.
 *
 * The concrete FemGpuState owns device buffers, residency metadata, hybrid
 * CPU-demag scratch, shared mesh metrics, and an exchange-owned legacy sparse
 * device substate.
 * Legacy sparse exchange planning metadata and CUDA stream/snapshot handles
 * remain adjacent to that device state because GPU planning consumes them
 * together.
 */
struct GpuStateRuntimeState {
    FemGpuState device{};
    LegacyGpuExchangeRuntimeState legacy_exchange{};
    CudaRuntimeState cuda{};
    GpuRkPhaseTimingRuntimeState rk_phase_timings{};
    GpuRkTransactionTelemetryRuntimeState rk_transaction_telemetry{};
    GpuPerformanceCounterState performance_counters{};
    FemGpuExecutionReceiptRuntimeState execution_receipt{};
    fullmag_fem_gpu_execution_request_v1 execution_request =
        FULLMAG_FEM_GPU_EXECUTION_REQUEST_COMPATIBILITY;
};

/*
 * Initialize and upload native FEM GPU state runtime buffers.
 *
 * This module owns the context bootstrap sequence for FemGpuState metadata,
 * optional device allocation, runtime coefficient upload, mesh geometry
 * upload, MFEM exchange device publication, and initial field uploads. It
 * keeps the plan/context construction path from owning residency mechanics.
 *
 * It does not choose MFEM devices, assemble exchange operators, execute RK
 * stages, or own state I/O.
 */
bool initialize_context_gpu_state(Context &ctx, std::string &error);

/*
 * Initialize the configured strict device-demag workspace after generic GPU
 * state and MFEM exchange have been uploaded.  This is the single production
 * selection point for device HYPRE Poisson versus Fredkin-Koehler FEM/BEM.
 */
bool initialize_context_gpu_demag_workspace(Context &ctx, std::string &error);

void set_gpu_step_profile(Context &ctx, bool enabled);

} // namespace fullmag::fem
