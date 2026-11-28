#pragma once

/*
 * FEM host-memory trace and heap-release source contract.
 *
 * This header owns the environment-gated host-memory trace that attributes
 * native FEM backend RSS to named setup phases (diagnostic, off by default),
 * and the release of freed heap pages during backend creation (on by
 * default). It does not own solver state, numerical policy, solver-profiler
 * phases, or allocation behavior. With the trace off, each trace call costs
 * one cached environment check.
 *
 * FULLMAG_FEM_MEMORY_TRACE=1    one stderr line per phase: wall-clock and
 *                               monotonic time, VmRSS, VmHWM, RssAnon, RssFile.
 * FULLMAG_FEM_MEMORY_TRACE=2    also glibc heap totals from malloc_info():
 *                               free bytes in fast bins and in other bins
 *                               (including each arena top), bytes that all
 *                               arenas hold from the system, and mmapped chunk
 *                               bytes. malloc_info() walks every free chunk, so
 *                               level 2 slows setup when many chunks are free.
 *
 * Setup temporaries freed by glibc stay resident in the thread arena of the
 * setup thread. malloc_trim(0) returns those pages; nothing reads them. On
 * glibc builds it runs by default at two points: on the device-Hypre GPU lane
 * right after the demag operator upload, before the linear-solver setup that
 * sets the setup memory peak, and at the end of backend creation.
 * FULLMAG_FEM_MALLOC_TRIM=off   skips both, for diagnosis. Unset, empty, or
 *                               "on" keeps the default; any other value fails
 *                               backend creation.
 */

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#if defined(__GLIBC__)
#include <malloc.h>
#endif

namespace fullmag::fem {

inline int fem_memory_trace_level()
{
    static const int level = [] {
        const char *raw = std::getenv("FULLMAG_FEM_MEMORY_TRACE");
        if (raw == nullptr || *raw == '\0' || std::strcmp(raw, "0") == 0 ||
            std::strcmp(raw, "off") == 0 || std::strcmp(raw, "false") == 0 ||
            std::strcmp(raw, "no") == 0) {
            return 0;
        }
        if (std::strcmp(raw, "2") == 0 || std::strcmp(raw, "heap") == 0) {
            return 2;
        }
        return 1;
    }();
    return level;
}

inline constexpr const char *kFemMallocTrimEnv = "FULLMAG_FEM_MALLOC_TRIM";

// Unset, empty, or "on" keeps the default heap release; "off" disables it.
// Any other value is an error, so a typo cannot silently change behavior.
inline bool resolve_fem_malloc_trim_enabled(
    const char *raw,
    bool &enabled,
    std::string &error)
{
    enabled = true;
    if (raw == nullptr || *raw == '\0' || std::strcmp(raw, "on") == 0) {
        return true;
    }
    if (std::strcmp(raw, "off") == 0) {
        enabled = false;
        return true;
    }
    error = std::string(kFemMallocTrimEnv) + " must be unset, 'on', or 'off', got '" +
        raw + "'";
    return false;
}

struct FemProcessMemorySample {
    unsigned long long rss_kib = 0;
    unsigned long long hwm_kib = 0;
    unsigned long long anon_kib = 0;
    unsigned long long file_kib = 0;
};

inline FemProcessMemorySample fem_process_memory_sample()
{
    FemProcessMemorySample sample;
#if defined(__linux__)
    std::FILE *status = std::fopen("/proc/self/status", "r");
    if (status == nullptr) {
        return sample;
    }
    char line[256];
    while (std::fgets(line, sizeof(line), status) != nullptr) {
        unsigned long long value = 0;
        if (std::sscanf(line, "VmRSS: %llu", &value) == 1) {
            sample.rss_kib = value;
        } else if (std::sscanf(line, "VmHWM: %llu", &value) == 1) {
            sample.hwm_kib = value;
        } else if (std::sscanf(line, "RssAnon: %llu", &value) == 1) {
            sample.anon_kib = value;
        } else if (std::sscanf(line, "RssFile: %llu", &value) == 1) {
            sample.file_kib = value;
        }
    }
    std::fclose(status);
#endif
    return sample;
}

struct FemHeapTotals {
    bool valid = false;
    unsigned long long fast_free_bytes = 0;
    unsigned long long other_free_bytes = 0;
    unsigned long long arena_system_bytes = 0;
    unsigned long long mmapped_bytes = 0;
};

// malloc_info() prints one section per arena and then the process totals, so
// the last occurrence of each tag is the process-wide value.
inline bool fem_parse_malloc_info_size(
    const std::string &text,
    const char *tag,
    unsigned long long &value)
{
    const std::size_t tag_at = text.rfind(tag);
    if (tag_at == std::string::npos) {
        return false;
    }
    static const char kSizeKey[] = "size=\"";
    const std::size_t size_at = text.find(kSizeKey, tag_at);
    if (size_at == std::string::npos) {
        return false;
    }
    const char *begin = text.c_str() + size_at + (sizeof(kSizeKey) - 1u);
    char *end = nullptr;
    const unsigned long long parsed = std::strtoull(begin, &end, 10);
    if (end == begin) {
        return false;
    }
    value = parsed;
    return true;
}

inline FemHeapTotals fem_heap_totals()
{
    FemHeapTotals totals;
#if defined(__GLIBC__)
    char *buffer = nullptr;
    std::size_t length = 0;
    std::FILE *stream = open_memstream(&buffer, &length);
    if (stream == nullptr) {
        return totals;
    }
    const int status = malloc_info(0, stream);
    std::fclose(stream);
    if (status == 0 && buffer != nullptr) {
        const std::string text(buffer, length);
        totals.valid =
            fem_parse_malloc_info_size(text, "<total type=\"fast\"", totals.fast_free_bytes) &&
            fem_parse_malloc_info_size(text, "<total type=\"rest\"", totals.other_free_bytes) &&
            fem_parse_malloc_info_size(
                text, "<system type=\"current\"", totals.arena_system_bytes) &&
            fem_parse_malloc_info_size(text, "<total type=\"mmap\"", totals.mmapped_bytes);
    }
    std::free(buffer);
#endif
    return totals;
}

inline void fem_memory_trace_emit(const char *phase, bool force)
{
    const int level = fem_memory_trace_level();
    if (level == 0 && !force) {
        return;
    }
    const long long wall_ms = static_cast<long long>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
    const double mono_ms =
        static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
                                std::chrono::steady_clock::now().time_since_epoch())
                                .count()) /
        1000.0;
    const FemProcessMemorySample memory = fem_process_memory_sample();
    if (level >= 2) {
        const FemHeapTotals heap = fem_heap_totals();
        std::fprintf(
            stderr,
            "[fullmag_fem][mem] phase=%s wall_ms=%lld mono_ms=%.1f rss_kib=%llu "
            "hwm_kib=%llu anon_kib=%llu file_kib=%llu heap_valid=%d "
            "heap_fast_free_b=%llu heap_other_free_b=%llu heap_arena_system_b=%llu "
            "heap_mmapped_b=%llu\n",
            phase, wall_ms, mono_ms, memory.rss_kib, memory.hwm_kib, memory.anon_kib,
            memory.file_kib, heap.valid ? 1 : 0, heap.fast_free_bytes,
            heap.other_free_bytes, heap.arena_system_bytes, heap.mmapped_bytes);
    } else {
        std::fprintf(
            stderr,
            "[fullmag_fem][mem] phase=%s wall_ms=%lld mono_ms=%.1f rss_kib=%llu "
            "hwm_kib=%llu anon_kib=%llu file_kib=%llu\n",
            phase, wall_ms, mono_ms, memory.rss_kib, memory.hwm_kib, memory.anon_kib,
            memory.file_kib);
    }
    std::fflush(stderr);
}

inline void fem_memory_trace_phase(const char *phase)
{
    fem_memory_trace_emit(phase, false);
}

inline void fem_memory_trace_stat(const char *phase, const char *name, uint64_t value)
{
    if (fem_memory_trace_level() == 0) {
        return;
    }
    std::fprintf(
        stderr,
        "[fullmag_fem][mem] stat phase=%s %s=%llu\n",
        phase,
        name,
        static_cast<unsigned long long>(value));
    std::fflush(stderr);
}

inline void fem_memory_trace_values(
    const char *phase,
    const char *name,
    const int64_t *values,
    std::size_t count)
{
    if (fem_memory_trace_level() == 0 || values == nullptr) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][mem] stat phase=%s %s=", phase, name);
    for (std::size_t index = 0; index < count; ++index) {
        std::fprintf(
            stderr,
            "%s%lld",
            index == 0 ? "" : ",",
            static_cast<long long>(values[index]));
    }
    std::fprintf(stderr, "\n");
    std::fflush(stderr);
}

// Returns the free heap pages that setup temporaries left behind (glibc keeps
// them otherwise, and nothing reads them). Silent unless the memory trace is
// on; then it adds one line with the released bytes. No-op without glibc.
inline void fem_release_free_heap(const char *where)
{
#if defined(__GLIBC__)
    const bool traced = fem_memory_trace_level() > 0;
    unsigned long long rss_before_kib = 0;
    if (traced) {
        fem_memory_trace_phase((std::string("malloc_trim:") + where + ":before").c_str());
        rss_before_kib = fem_process_memory_sample().rss_kib;
    }
    const auto started = std::chrono::steady_clock::now();
    malloc_trim(0);
    if (!traced) {
        return;
    }
    const double elapsed_ms =
        static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
                                std::chrono::steady_clock::now() - started)
                                .count()) /
        1000.0;
    const unsigned long long rss_after_kib = fem_process_memory_sample().rss_kib;
    const unsigned long long released_bytes =
        rss_before_kib > rss_after_kib ? (rss_before_kib - rss_after_kib) * 1024ull : 0ull;
    std::fprintf(
        stderr,
        "[fullmag_fem][mem] malloc_trim where=%s released_bytes=%llu elapsed_ms=%.1f\n",
        where,
        released_bytes,
        elapsed_ms);
    fem_memory_trace_phase((std::string("malloc_trim:") + where + ":after").c_str());
#else
    (void)where;
#endif
}

// fem_release_free_heap under the FULLMAG_FEM_MALLOC_TRIM policy, for setup
// steps below the builder. The builder rejects an invalid value before setup
// starts, so the error branch only matters for direct callers such as tests.
inline bool fem_release_free_heap_if_enabled(const char *where, std::string &error)
{
    bool enabled = true;
    if (!resolve_fem_malloc_trim_enabled(std::getenv(kFemMallocTrimEnv), enabled, error)) {
        return false;
    }
    if (enabled) {
        fem_release_free_heap(where);
    }
    return true;
}

} // namespace fullmag::fem
