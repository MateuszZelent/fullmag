#pragma once

#include "gpu_state.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

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

/*
 * Runtime owner for the native FEM GPU-state object.
 *
 * The concrete FemGpuState owns device buffers, residency metadata, hybrid
 * CPU-demag scratch, and sparse exchange device allocations. Legacy sparse
 * exchange metadata and CUDA stream/snapshot handles remain adjacent to that
 * device state because GPU planning consumes them together.
 */
struct GpuStateRuntimeState {
    FemGpuState device{};
    LegacyGpuExchangeRuntimeState legacy_exchange{};
    CudaRuntimeState cuda{};
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

} // namespace fullmag::fem
