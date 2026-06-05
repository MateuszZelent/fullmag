#pragma once

/*
 * GPU CUDA state-runtime module header.
 *
 * Declares CUDA runtime handles, legacy sparse exchange metadata, and the
 * context bootstrap bridge that uploads FEM runtime state into FemGpuState.
 */

#include "gpu/cuda/state/gpu_state.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

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
 * Runtime state for CUDA stream/event and pinned snapshot handles.
 *
 * CUDA-capable native FEM execution creates high-priority compute and
 * low-priority I/O streams plus a compute event. Snapshot staging uses a
 * double-buffered pinned host allocation tracked here.
 */
struct CudaRuntimeState {
    void *compute_stream = nullptr;
    void *io_stream = nullptr;
    void *compute_event = nullptr;
    void *pinned_snapshot[2] = {nullptr, nullptr};
    size_t pinned_snapshot_bytes = 0;
    int active_snapshot_buffer = 0;
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

void set_gpu_step_profile(Context &ctx, bool enabled);

} // namespace fullmag::fem
