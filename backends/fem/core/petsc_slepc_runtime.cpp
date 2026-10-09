#include "core/petsc_slepc_runtime.hpp"

#include <cstddef>
#include <limits>
#include <new>

namespace fullmag::fem::runtime {
namespace {

bool &process_unsafe_flag() noexcept
{
    static bool unsafe = false;
    return unsafe;
}

std::size_t &live_cpu_graph_count() noexcept
{
    static std::size_t count = 0u;
    return count;
}

} // namespace

std::mutex &petsc_slepc_process_mutex() noexcept
{
    // This process-lifetime lock also outlives public context destructors and
    // GPU atexit callbacks; the operating system reclaims it at process exit.
    static std::mutex *const mutex = new std::mutex;
    return *mutex;
}

void mark_petsc_slepc_process_unsafe_locked() noexcept
{
    process_unsafe_flag() = true;
}

bool petsc_slepc_process_is_unsafe_locked() noexcept
{
    return process_unsafe_flag();
}

void register_petsc_slepc_live_cpu_graph_locked() noexcept
{
    auto &count = live_cpu_graph_count();
    if (count != std::numeric_limits<std::size_t>::max()) {
        ++count;
    }
}

void unregister_petsc_slepc_live_cpu_graph_locked() noexcept
{
    auto &count = live_cpu_graph_count();
    if (count != 0u && count != std::numeric_limits<std::size_t>::max()) {
        --count;
    }
}

bool petsc_slepc_has_live_cpu_graphs_locked() noexcept
{
    return live_cpu_graph_count() != 0u;
}

bool petsc_slepc_global_finalization_allowed_locked() noexcept
{
    // A saturated count remains fenced instead of wrapping to an unsafe zero.
    return !process_unsafe_flag() && !petsc_slepc_has_live_cpu_graphs_locked();
}

} // namespace fullmag::fem::runtime