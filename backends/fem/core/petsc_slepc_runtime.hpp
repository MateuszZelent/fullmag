#pragma once

#include <mutex>

namespace fullmag::fem::runtime {

// PETSc and SLEPc expose process-global runtime and solver graph state.
// Every in-process FEM lane must hold this shared-library mutex while using
// those APIs, including initialization and resource cleanup.
std::mutex &petsc_slepc_process_mutex() noexcept;

// Unsafe state and live graph registrations are accessed only while the mutex
// above is held.
void mark_petsc_slepc_process_unsafe_locked() noexcept;
bool petsc_slepc_process_is_unsafe_locked() noexcept;
void register_petsc_slepc_live_cpu_graph_locked() noexcept;
void unregister_petsc_slepc_live_cpu_graph_locked() noexcept;
bool petsc_slepc_has_live_cpu_graphs_locked() noexcept;
bool petsc_slepc_global_finalization_allowed_locked() noexcept;

} // namespace fullmag::fem::runtime