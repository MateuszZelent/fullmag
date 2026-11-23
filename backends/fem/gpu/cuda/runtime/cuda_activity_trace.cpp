#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE 1
#endif

#include "fullmag_fem_cuda_trace.h"
#include "cuda_activity_trace.hpp"

#if defined(__linux__)
#include <time.h>
#endif

std::uint64_t fullmag::fem::cuda_trace::host_activity_timestamp_ns() noexcept {
#if defined(__linux__)
    timespec now{};
    if (clock_gettime(CLOCK_MONOTONIC, &now) == 0 && now.tv_sec >= 0) {
        return static_cast<std::uint64_t>(now.tv_sec) * 1000000000ULL +
            static_cast<std::uint64_t>(now.tv_nsec);
    }
#endif
    return 0u;
}

#if defined(FULLMAG_FEM_CUPTI_TRACE_ENABLED) && defined(__linux__)

#include "cupti_library.hpp"
#include "frequency_domain/canonical_digest.hpp"

#include <cuda_runtime_api.h>
#include <cupti_runtime_cbid.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <iterator>
#include <limits>
#include <mutex>
#include <sys/stat.h>
#include <thread>
#include <optional>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

constexpr size_t kBufferCount = 8;
constexpr size_t kBufferBytes = 1024 * 1024;
constexpr uint32_t kBufferFlushPeriodMs = 10;
constexpr size_t kNameBytes = 2048;
constexpr size_t kLineBytes = 16384;
constexpr uint64_t kMinBytes = FULLMAG_FEM_CUDA_TRACE_MIN_BYTES;
constexpr uint64_t kMaxBytes = FULLMAG_FEM_CUDA_TRACE_MAX_BYTES;
constexpr uint32_t kMinDurationMs = FULLMAG_FEM_CUDA_TRACE_MIN_DURATION_MS;
constexpr uint32_t kMaxDurationMs = FULLMAG_FEM_CUDA_TRACE_MAX_DURATION_MS;
constexpr size_t kPhaseDigestChunkRecords = 256;
constexpr size_t kPhaseEventNameBytes = kNameBytes;
constexpr size_t kPhaseEventEncodingBytes = 192 + kPhaseEventNameBytes;
constexpr size_t kMaxPhasePollRecords = 65536;
constexpr uint32_t kPhaseDrainTimeoutMs = 5000;

enum SlotState : uint8_t { kFree = 0, kFilling = 1, kReady = 2, kProcessing = 3 };

enum PhaseRecordKind : uint8_t {
    kPhaseKernel = 1,
    kPhaseDriverApi = 2,
    kPhaseRuntimeApi = 3,
    kPhaseMemcpy = 4,
    kPhaseMemset = 5,
    kPhaseSynchronization = 6,
    kPhaseMemory = 7,
};

enum PhasePresence : uint16_t {
    kPhaseHasBytes = 1U << 0,
    kPhaseHasAddress = 1U << 1,
    kPhaseHasReturnValue = 1U << 2,
    kPhaseHasEventId = 1U << 3,
    kPhaseHasActivityKind = 1U << 4,
    kPhaseHasOperationKind = 1U << 5,
    kPhaseHasProcessId = 1U << 6,
    kPhaseHasThreadId = 1U << 7,
    kPhaseHasDeviceId = 1U << 8,
    kPhaseHasContextId = 1U << 9,
    kPhaseHasStreamId = 1U << 10,
    kPhaseHasCallbackId = 1U << 11,
    kPhaseHasMemoryKind = 1U << 12,
};

enum PhaseLifecycle : uint8_t { kPhaseIdle = 0, kPhaseOpen = 1, kPhaseClosing = 2, kPhaseFinalized = 3 };

struct PhaseEvent {
    uint64_t start_ns = 0;
    uint64_t end_ns = 0;
    uint64_t correlation_id = 0;
    uint64_t runtime_correlation_id = 0;
    uint64_t event_id = 0;
    uint64_t bytes = 0;
    uint64_t address = 0;
    uint64_t return_value = 0;
    uint64_t callback_id = 0;
    int64_t process_id = -1;
    int64_t thread_id = -1;
    int64_t device_id = -1;
    int64_t context_id = -1;
    int64_t stream_id = -1;
    int64_t activity_kind = -1;
    int64_t operation_kind = -1;
    int64_t memory_kind = -1;
    uint16_t presence = 0;
    uint16_t name_length = 0;
    uint8_t kind = 0;
    char name[kPhaseEventNameBytes]{};
};

struct StreamPollRecord {
    uint64_t correlation_id;
    uint64_t start_ns;
    uint64_t end_ns;
    uint64_t duration_ns = 0;
};

struct BufferSlot {
    alignas(8) uint8_t bytes[kBufferBytes]{};
    std::atomic<uint8_t> state{kFree};
    size_t valid_size = 0;
};

struct AtomicStats {
    std::atomic<uint64_t> records_written{0};
    std::atomic<uint64_t> bytes_written{0};
    std::atomic<uint64_t> dropped_records{0};
    std::atomic<uint64_t> buffer_starvations{0};
    std::atomic<uint64_t> unknown_records{0};
    std::atomic<uint64_t> truncated_names{0};
    std::atomic<uint64_t> incomplete_records{0};
    std::atomic<uint64_t> api_errors{0};
    std::atomic<uint64_t> io_errors{0};
    std::atomic<uint64_t> limit_flags{0};
};

struct BufferPressureSample {
    uint64_t occurrence = 0;
    std::array<size_t, 4> observed_states{};
    uint64_t completed = 0;
    uint64_t processed = 0;
    uint64_t records_written = 0;
    uint64_t bytes_written = 0;
};

enum class TraceLimitScope { Capture, Sample };

struct ActivityTrace {
    // Set before the worker threads start and unchanged until both join.
    TraceLimitScope limit_scope = TraceLimitScope::Capture;
    BufferSlot slots[kBufferCount];
    AtomicStats counts;
    std::atomic<bool> active{false};
    std::atomic<bool> callbacks_accepting{false};
    std::atomic<bool> stop_requested{false};
    std::atomic<bool> flush_complete{false};
    std::atomic<bool> writer_done{false};
    std::atomic<uint64_t> callbacks_in_flight{0};
    std::atomic<bool> collector_poisoned{false};
    std::atomic<bool> reported_closed_buffer_request{false};
    std::atomic<bool> reported_exhausted_buffer_request{false};
    std::atomic<uint64_t> pool_exhaustions{0};
    std::atomic<uint64_t> closed_buffer_requests{0};
    std::atomic<uint64_t> buffers_completed{0};
    std::atomic<uint64_t> buffers_processed{0};
    std::atomic<uint64_t> buffer_bytes_processed{0};
    std::atomic<uint64_t> buffer_processing_ns{0};
    std::atomic<uint64_t> normal_flush_calls{0};
    std::atomic<uint64_t> normal_flush_errors{0};
    std::atomic<uint64_t> normal_flush_ns{0};
    // One unique callback owns each power-of-two occurrence. Read only after
    // all callbacks have returned and both collector threads have joined.
    std::array<BufferPressureSample, 64> pressure_samples{};
    std::atomic<int> output_fd{-1};
    std::atomic<uint64_t> max_bytes{0};
    std::atomic<uint64_t> start_timestamp_ns{0};
    std::atomic<uint64_t> end_timestamp_ns{0};
    std::atomic<uint64_t> token{0};
    std::mutex wait_mutex;
    std::mutex flush_mutex;
    std::mutex phase_mutex;
    std::condition_variable changed;
    std::thread writer;
    std::thread watchdog;
    uint64_t next_token = 1;
    uint64_t last_token = 0;
    fullmag_fem_cuda_trace_stats_v1 last_stats{};
    PhaseLifecycle phase_lifecycle = kPhaseIdle;
    uint64_t phase_capture_token = 0;
    uint64_t phase_token = 0;
    uint64_t next_phase_token = 1;
    uint64_t phase_start_ns = 0;
    uint64_t phase_end_ns = 0;
    uint64_t phase_flags = 0;
    uint64_t phase_untimed_metadata_records = 0;
    uint64_t phase_full_vector_bytes = 0;
    fullmag::fem::cuda_trace::ModalEpsSolveTraceV1 phase_metrics{};
    uint64_t phase_latest_open_record_end_ns = 0;
    int64_t phase_observed_device_id = -1;
    bool phase_host_vector_size_ambiguous = false;
    size_t phase_digest_chunk_record_count = 0;
    std::optional<fullmag::fem::frequency_domain::CanonicalDigestBuilder> phase_digest_chunk;
    std::string phase_digest_chain;
    std::vector<StreamPollRecord> phase_stream_queries;
    std::vector<StreamPollRecord> phase_stream_synchronizations;

    void reset_phase_measurements() noexcept {
        phase_metrics = {};
        phase_latest_open_record_end_ns = 0;
        phase_observed_device_id = -1;
        phase_host_vector_size_ambiguous = false;
        phase_digest_chunk_record_count = 0;
        phase_digest_chunk.reset();
        phase_digest_chain.clear();
        phase_stream_queries.clear();
        phase_stream_synchronizations.clear();
    }
    bool enabled[8]{};
};

ActivityTrace g_trace;
fullmag::fem::CuptiLibrary g_cupti;
std::mutex g_api_mutex;
std::once_flag g_callback_registration_once;
CUptiResult g_callback_registration = CUPTI_ERROR_NOT_INITIALIZED;

// Use the host's Rust Instant-compatible monotonic clock domain for GPU-to-CPU
// interpolation and capture bounds. Register this process-lifetime callback
// before enabling any activity, and use exactly the same clock for the capture
// boundaries. No allocation or collector lock here.
uint64_t CUPTIAPI monotonic_timestamp() {
    const auto now = fullmag::fem::cuda_trace::host_activity_timestamp_ns();
    if (now == 0u) {
        g_trace.counts.api_errors.fetch_add(1, std::memory_order_relaxed);
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        g_trace.stop_requested.store(true, std::memory_order_release);
        g_trace.changed.notify_all();
    }
    return now;
}

void increment(std::atomic<uint64_t> &counter, uint64_t amount = 1) {
    counter.fetch_add(amount, std::memory_order_relaxed);
}

uint64_t read_count(const std::atomic<uint64_t> &counter) {
    return counter.load(std::memory_order_relaxed);
}

void request_stop(ActivityTrace &trace) {
    {
        std::lock_guard<std::mutex> lock(trace.wait_mutex);
        trace.stop_requested.store(true, std::memory_order_release);
    }
    trace.changed.notify_all();
}

struct CallbackGuard {
    CallbackGuard() { g_trace.callbacks_in_flight.fetch_add(1, std::memory_order_acq_rel); }
    ~CallbackGuard() { g_trace.callbacks_in_flight.fetch_sub(1, std::memory_order_acq_rel); }
};

BufferSlot *find_slot(uint8_t *buffer) {
    for (auto &slot : g_trace.slots) {
        if (slot.bytes == buffer) return &slot;
    }
    return nullptr;
}

void CUPTIAPI buffer_requested(uint8_t **buffer, size_t *size, size_t *max_records) {
    CallbackGuard guard;
    if (buffer == nullptr || size == nullptr || max_records == nullptr) {
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        increment(g_trace.counts.api_errors);
        return;
    }
    *buffer = nullptr;
    *size = 0;
    *max_records = 0;
    if (!g_trace.callbacks_accepting.load(std::memory_order_acquire)) {
        increment(g_trace.closed_buffer_requests);
        if (!g_trace.reported_closed_buffer_request.exchange(true, std::memory_order_relaxed)) {
            // Keep a bounded breadcrumb even if CUPTI faults before stop can write its receipt.
            constexpr char message[] = "cuda_activity_trace: refusing buffer: collection closed\n";
            (void)::write(STDERR_FILENO, message, sizeof(message) - 1);
        }
        if (g_trace.active.load(std::memory_order_acquire)) {
            increment(g_trace.counts.buffer_starvations);
            increment(g_trace.counts.dropped_records);
        } else {
            g_trace.collector_poisoned.store(true, std::memory_order_release);
            increment(g_trace.counts.api_errors);
        }
        return;
    }
    std::array<size_t, 4> observed_states{};
    for (auto &slot : g_trace.slots) {
        uint8_t expected = kFree;
        if (slot.state.compare_exchange_strong(expected, kFilling,
                                               std::memory_order_acq_rel)) {
            slot.valid_size = 0;
            *buffer = slot.bytes;
            *size = kBufferBytes;
            return;
        }
        // Reuse the failed CAS observation. Concurrent transitions mean this
        // one-pass sample is not a coherent snapshot of the complete pool.
        if (expected < observed_states.size()) ++observed_states[expected];
    }
    increment(g_trace.counts.buffer_starvations);
    increment(g_trace.counts.dropped_records);
    const uint64_t occurrence =
        g_trace.pool_exhaustions.fetch_add(1, std::memory_order_relaxed) + 1;
    if (occurrence != 0 && (occurrence & (occurrence - 1)) == 0) {
        size_t index = 0;
        for (uint64_t value = occurrence; value > 1; value >>= 1) ++index;
        g_trace.pressure_samples[index] = BufferPressureSample{
            occurrence, observed_states, read_count(g_trace.buffers_completed),
            read_count(g_trace.buffers_processed), read_count(g_trace.counts.records_written),
            read_count(g_trace.counts.bytes_written)};
    }
    if (!g_trace.reported_exhausted_buffer_request.exchange(true, std::memory_order_relaxed)) {
        constexpr char message[] = "cuda_activity_trace: refusing buffer: all 8 slots occupied\n";
        (void)::write(STDERR_FILENO, message, sizeof(message) - 1);
    }
}

void CUPTIAPI buffer_completed(CUcontext, uint32_t, uint8_t *buffer, size_t, size_t valid_size) {
    CallbackGuard guard;
    BufferSlot *slot = find_slot(buffer);
    if (slot == nullptr) {
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        increment(g_trace.counts.api_errors);
        increment(g_trace.counts.incomplete_records);
        increment(g_trace.counts.dropped_records);
        return;
    }
    if (!g_trace.active.load(std::memory_order_acquire)) {
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        increment(g_trace.counts.api_errors);
        increment(g_trace.counts.incomplete_records);
        increment(g_trace.counts.dropped_records);
        uint8_t expected = kFilling;
        if (!slot->state.compare_exchange_strong(expected, kFree, std::memory_order_acq_rel)) {
            g_trace.collector_poisoned.store(true, std::memory_order_release);
        }
        return;
    }
    if (slot->state.load(std::memory_order_acquire) != kFilling) {
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        increment(g_trace.counts.api_errors);
        increment(g_trace.counts.incomplete_records);
        increment(g_trace.counts.dropped_records);
        return;
    }
    if (valid_size > kBufferBytes) {
        increment(g_trace.counts.incomplete_records);
        increment(g_trace.counts.dropped_records);
    }
    slot->valid_size = std::min(valid_size, kBufferBytes);
    uint8_t expected = kFilling;
    if (!slot->state.compare_exchange_strong(expected, kReady, std::memory_order_acq_rel)) {
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        increment(g_trace.counts.api_errors);
        increment(g_trace.counts.incomplete_records);
        increment(g_trace.counts.dropped_records);
        return;
    }
    increment(g_trace.buffers_completed);
    g_trace.changed.notify_one();
}

bool write_all(int fd, const char *data, size_t size, size_t *written) {
    *written = 0;
    while (*written < size) {
        const ssize_t result = ::write(fd, data + *written, size - *written);
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) return false;
        *written += static_cast<size_t>(result);
    }
    return true;
}

bool append_json_string(char *destination, size_t capacity, const char *source,
                        bool *truncated) {
    if (capacity < 3) return false;
    size_t out = 0;
    destination[out++] = '"';
    if (source != nullptr) {
        size_t source_length = 0;
        while (source_length < 4096 && source[source_length] != '\0') ++source_length;
        const size_t limit = std::min(source_length, kNameBytes);
        if (source_length > limit) *truncated = true;
        for (size_t i = 0; i < limit; ++i) {
            const unsigned char ch = static_cast<unsigned char>(source[i]);
            const char *escape = nullptr;
            switch (ch) {
                case '"': escape = "\\\""; break;
                case '\\': escape = "\\\\"; break;
                case '\b': escape = "\\b"; break;
                case '\f': escape = "\\f"; break;
                case '\n': escape = "\\n"; break;
                case '\r': escape = "\\r"; break;
                case '\t': escape = "\\t"; break;
                default: break;
            }
            if (escape != nullptr) {
                const size_t length = std::strlen(escape);
                if (out + length + 2 > capacity) {
                    *truncated = true;
                    break;
                }
                std::memcpy(destination + out, escape, length);
                out += length;
            } else if (ch < 0x20) {
                if (out + 6 + 2 > capacity) {
                    *truncated = true;
                    break;
                }
                const int count = std::snprintf(destination + out, capacity - out,
                                                "\\u%04x", static_cast<unsigned>(ch));
                if (count != 6) return false;
                out += 6;
            } else {
                if (out + 1 + 2 > capacity) {
                    *truncated = true;
                    break;
                }
                destination[out++] = static_cast<char>(ch);
            }
        }
    }
    if (out + 2 > capacity) return false;
    destination[out++] = '"';
    destination[out] = '\0';
    return true;
}

struct Event {
    const char *kind = "unknown";
    const char *name = nullptr;
    uint64_t start_ns = 0;
    uint64_t end_ns = 0;
    uint64_t correlation_id = 0;
    uint64_t runtime_correlation_id = 0;
    uint64_t event_id = 0;
    uint64_t bytes = 0;
    uint64_t address = 0;
    uint64_t return_value = 0;
    int64_t process_id = -1;
    int64_t thread_id = -1;
    int64_t device_id = -1;
    int64_t context_id = -1;
    int64_t stream_id = -1;
    int64_t activity_kind = -1;
    int64_t operation_kind = -1;
    int64_t memory_kind = -1;
    uint64_t callback_id = 0;
    bool has_bytes = false;
    bool has_address = false;
    bool has_return_value = false;
    bool has_event_id = false;
    bool has_activity_kind = false;
    bool has_operation_kind = false;
    bool has_memory_kind = false;
    bool has_callback_id = false;
    bool has_process_id = false;
    bool has_thread_id = false;
    bool has_device_id = false;
    bool has_context_id = false;
    bool has_stream_id = false;
    bool timestamps_applicable = true;
    bool timestamp_valid = true;
};

void note_timestamp(ActivityTrace &trace, Event *event) {
    if (!event->timestamps_applicable) {
        event->timestamp_valid = false;
        return;
    }
    if (event->start_ns == 0 || event->end_ns == 0 || event->end_ns < event->start_ns) {
        event->timestamp_valid = false;
        increment(trace.counts.incomplete_records);
    }
}

bool phase_kind_for_event(const Event &event, uint8_t *kind) {
    if (std::strcmp(event.kind, "kernel") == 0) *kind = kPhaseKernel;
    else if (std::strcmp(event.kind, "driver_api") == 0) *kind = kPhaseDriverApi;
    else if (std::strcmp(event.kind, "runtime_api") == 0) *kind = kPhaseRuntimeApi;
    else if (std::strcmp(event.kind, "memcpy") == 0) *kind = kPhaseMemcpy;
    else if (std::strcmp(event.kind, "memset") == 0) *kind = kPhaseMemset;
    else if (std::strcmp(event.kind, "synchronization") == 0) *kind = kPhaseSynchronization;
    else if (std::strcmp(event.kind, "memory") == 0) *kind = kPhaseMemory;
    else return false;
    return true;
}

void measure_phase_event(ActivityTrace &trace, const PhaseEvent &event) noexcept;

void append_phase_candidate(ActivityTrace &trace, const Event &event) {
    std::lock_guard<std::mutex> lock(trace.phase_mutex);
    if (trace.phase_lifecycle != kPhaseOpen && trace.phase_lifecycle != kPhaseClosing) return;
    if (std::strcmp(event.kind, "cuda_event_metadata") == 0) {
        ++trace.phase_untimed_metadata_records;
        trace.phase_flags |= fullmag::fem::cuda_trace::modal_eps_trace_unclassified;
        return;
    }
    if (!event.timestamps_applicable || !event.timestamp_valid) {
        trace.phase_flags |= fullmag::fem::cuda_trace::modal_eps_trace_unclassified;
        return;
    }
    if (event.start_ns < trace.phase_start_ns ||
        (trace.phase_end_ns != 0 && event.start_ns >= trace.phase_end_ns)) return;

    uint8_t phase_kind = 0;
    if (!phase_kind_for_event(event, &phase_kind)) {
        trace.phase_flags |= fullmag::fem::cuda_trace::modal_eps_trace_unclassified;
        return;
    }
    size_t name_length = 0;
    if (event.name != nullptr) {
        while (name_length < kPhaseEventNameBytes && event.name[name_length] != '\0') ++name_length;
    }
    if (name_length >= kPhaseEventNameBytes) {
        trace.phase_flags |= fullmag::fem::cuda_trace::modal_eps_trace_unclassified;
        return;
    }
    PhaseEvent candidate{};
    candidate.start_ns = event.start_ns;
    candidate.end_ns = event.end_ns;
    candidate.correlation_id = event.correlation_id;
    candidate.runtime_correlation_id = event.runtime_correlation_id;
    candidate.event_id = event.event_id;
    candidate.bytes = event.bytes;
    candidate.address = event.address;
    candidate.return_value = event.return_value;
    candidate.callback_id = event.callback_id;
    candidate.process_id = event.process_id;
    candidate.thread_id = event.thread_id;
    candidate.device_id = event.device_id;
    candidate.context_id = event.context_id;
    candidate.stream_id = event.stream_id;
    candidate.activity_kind = event.activity_kind;
    candidate.operation_kind = event.operation_kind;
    candidate.memory_kind = event.memory_kind;
    candidate.kind = phase_kind;
    candidate.name_length = static_cast<uint16_t>(name_length);
    if (name_length != 0) std::memcpy(candidate.name, event.name, name_length);
    candidate.name[name_length] = '\0';
    if (event.has_bytes) candidate.presence |= kPhaseHasBytes;
    if (event.has_address) candidate.presence |= kPhaseHasAddress;
    if (event.has_return_value) candidate.presence |= kPhaseHasReturnValue;
    if (event.has_event_id) candidate.presence |= kPhaseHasEventId;
    if (event.has_activity_kind) candidate.presence |= kPhaseHasActivityKind;
    if (event.has_operation_kind) candidate.presence |= kPhaseHasOperationKind;
    if (event.has_process_id) candidate.presence |= kPhaseHasProcessId;
    if (event.has_thread_id) candidate.presence |= kPhaseHasThreadId;
    if (event.has_device_id) candidate.presence |= kPhaseHasDeviceId;
    if (event.has_context_id) candidate.presence |= kPhaseHasContextId;
    if (event.has_stream_id) candidate.presence |= kPhaseHasStreamId;
    if (event.has_callback_id) candidate.presence |= kPhaseHasCallbackId;
    if (event.has_memory_kind) candidate.presence |= kPhaseHasMemoryKind;
    measure_phase_event(trace, candidate);
}

void append_be_u16(std::array<uint8_t, kPhaseEventEncodingBytes> *payload, size_t *offset, uint16_t value) {
    (*payload)[(*offset)++] = static_cast<uint8_t>(value >> 8);
    (*payload)[(*offset)++] = static_cast<uint8_t>(value);
}

void append_be_u64(std::array<uint8_t, kPhaseEventEncodingBytes> *payload, size_t *offset, uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8) {
        (*payload)[(*offset)++] = static_cast<uint8_t>(value >> shift);
    }
}

void append_be_i64(std::array<uint8_t, kPhaseEventEncodingBytes> *payload, size_t *offset, int64_t value) {
    append_be_u64(payload, offset, static_cast<uint64_t>(value));
}

void add_phase_event_digest(
    fullmag::fem::frequency_domain::CanonicalDigestBuilder *digest,
    const PhaseEvent &event) {
    std::array<uint8_t, kPhaseEventEncodingBytes> encoded{};
    size_t offset = 0;
    encoded[offset++] = event.kind;
    append_be_u16(&encoded, &offset, event.presence);
    append_be_u64(&encoded, &offset, event.start_ns);
    append_be_u64(&encoded, &offset, event.end_ns);
    append_be_u64(&encoded, &offset, event.correlation_id);
    append_be_u64(&encoded, &offset, event.runtime_correlation_id);
    append_be_u64(&encoded, &offset, event.event_id);
    append_be_u64(&encoded, &offset, event.bytes);
    append_be_u64(&encoded, &offset, event.address);
    append_be_u64(&encoded, &offset, event.return_value);
    append_be_u64(&encoded, &offset, event.callback_id);
    append_be_i64(&encoded, &offset, event.process_id);
    append_be_i64(&encoded, &offset, event.thread_id);
    append_be_i64(&encoded, &offset, event.device_id);
    append_be_i64(&encoded, &offset, event.context_id);
    append_be_i64(&encoded, &offset, event.stream_id);
    append_be_i64(&encoded, &offset, event.activity_kind);
    append_be_i64(&encoded, &offset, event.operation_kind);
    append_be_i64(&encoded, &offset, event.memory_kind);
    append_be_u16(&encoded, &offset, event.name_length);
    if (event.name_length != 0) {
        std::memcpy(encoded.data() + offset, event.name, event.name_length);
        offset += event.name_length;
    }
    digest->add_bytes("activity_record", encoded.data(), offset);
}

uint64_t clipped_duration(const PhaseEvent &event, uint64_t start_ns, uint64_t end_ns) {
    const uint64_t clipped_start = std::max(event.start_ns, start_ns);
    const uint64_t clipped_end = std::min(event.end_ns, end_ns);
    return clipped_end > clipped_start ? clipped_end - clipped_start : 0;
}

bool checked_add(uint64_t *target, uint64_t value) {
    if (value > std::numeric_limits<uint64_t>::max() - *target) return false;
    *target += value;
    return true;
}

void finish_phase_digest_chunk(ActivityTrace &trace) {
    if (!trace.phase_digest_chunk) return;
    trace.phase_digest_chain = trace.phase_digest_chunk->sha256_hex();
    trace.phase_digest_chunk.reset();
    trace.phase_digest_chunk_record_count = 0;
}

void record_stream_poll(std::vector<StreamPollRecord> &records, const PhaseEvent &event,
                        uint64_t duration, uint64_t &flags) noexcept {
    if (event.correlation_id == 0) return;
    if (records.size() >= kMaxPhasePollRecords) {
        flags |= fullmag::fem::cuda_trace::modal_eps_trace_buffer_overflow;
        return;
    }
    try {
        records.push_back({event.correlation_id, event.start_ns, event.end_ns, duration});
    } catch (...) {
        flags |= fullmag::fem::cuda_trace::modal_eps_trace_lost;
    }
}

void classify_stream_query_synchronizations(
    ActivityTrace &trace, fullmag::fem::cuda_trace::ModalEpsSolveTraceV1 &report) noexcept {
    auto &queries = trace.phase_stream_queries;
    auto &syncs = trace.phase_stream_synchronizations;
    const auto by_correlation = [](const auto &a, const auto &b) {
        return a.correlation_id < b.correlation_id;
    };
    std::sort(queries.begin(), queries.end(), by_correlation);
    std::sort(syncs.begin(), syncs.end(), by_correlation);
    auto query = queries.begin();
    for (const auto &sync : syncs) {
        while (query != queries.end() && query->correlation_id < sync.correlation_id) ++query;
        if (query == queries.end() || query->correlation_id != sync.correlation_id ||
            query->start_ns > sync.start_ns || query->end_ns < sync.end_ns) {
            continue;
        }
        if (report.host_sync_count == 0 || report.host_sync_duration_ns < sync.duration_ns) {
            report.flags |= fullmag::fem::cuda_trace::modal_eps_trace_unclassified;
            return;
        }
        // CUPTI may label a nonblocking cudaStreamQuery as STREAM_SYNCHRONIZE.
        // Keep both timed records in the digest. Only this positively matched
        // query is excluded from the blocking synchronization count.
        --report.host_sync_count;
        report.host_sync_duration_ns -= sync.duration_ns;
        ++query;
    }
}

void measure_phase_event(ActivityTrace &trace, const PhaseEvent &event) noexcept {
    using namespace fullmag::fem::cuda_trace;
    auto *report = &trace.phase_metrics;
    auto &observed_device_id = trace.phase_observed_device_id;
    auto &host_vector_size_ambiguous = trace.phase_host_vector_size_ambiguous;
    if (trace.phase_lifecycle == kPhaseOpen) {
        trace.phase_latest_open_record_end_ns =
            std::max(trace.phase_latest_open_record_end_ns, event.end_ns);
    }
    if (!checked_add(&report->observed_activity_records, 1)) {
        report->flags |= modal_eps_trace_lost;
        return;
    }

    const uint64_t duration = clipped_duration(event, trace.phase_start_ns,
        trace.phase_end_ns == 0 ? event.end_ns : trace.phase_end_ns);
    switch (event.kind) {
        case kPhaseKernel:
            report->phase_coverage |= modal_eps_coverage_kernel;
            if (!checked_add(&report->kernel_records, 1) ||
                !checked_add(&report->kernel_duration_ns, duration))
                report->flags |= modal_eps_trace_lost;
            if ((event.presence & kPhaseHasDeviceId) == 0 || event.device_id < 0 ||
                event.device_id == static_cast<int64_t>(CUPTI_UNIFIED_MEMORY_CPU_DEVICE_ID) ||
                (observed_device_id >= 0 && observed_device_id != event.device_id)) {
                report->flags |= modal_eps_trace_unclassified;
            } else {
                observed_device_id = event.device_id;
            }
            break;
        case kPhaseDriverApi:
            report->phase_coverage |= modal_eps_coverage_driver_api;
            break;
        case kPhaseRuntimeApi:
            report->phase_coverage |= modal_eps_coverage_runtime_api;
            if ((event.presence & (kPhaseHasCallbackId | kPhaseHasReturnValue)) ==
                    (kPhaseHasCallbackId | kPhaseHasReturnValue) &&
                (event.callback_id == CUPTI_RUNTIME_TRACE_CBID_cudaStreamQuery_v3020 ||
                 event.callback_id == CUPTI_RUNTIME_TRACE_CBID_cudaStreamQuery_ptsz_v7000) &&
                (event.return_value == cudaSuccess || event.return_value == cudaErrorNotReady)) {
                record_stream_poll(trace.phase_stream_queries, event, duration, report->flags);
            }
            break;
        case kPhaseMemcpy: {
            report->phase_coverage |= modal_eps_coverage_memcpy;
            if ((event.presence & (kPhaseHasOperationKind | kPhaseHasBytes)) !=
                (kPhaseHasOperationKind | kPhaseHasBytes)) {
                report->flags |= modal_eps_trace_unclassified;
                host_vector_size_ambiguous = true;
                break;
            }
            uint64_t *count = nullptr;
            uint64_t *bytes = nullptr;
            bool host_directed = false;
            switch (event.operation_kind) {
                case CUPTI_ACTIVITY_MEMCPY_KIND_HTOD:
                case CUPTI_ACTIVITY_MEMCPY_KIND_HTOA:
                    count = &report->h2d_count; bytes = &report->h2d_bytes; host_directed = true; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_DTOH:
                case CUPTI_ACTIVITY_MEMCPY_KIND_ATOH:
                    count = &report->d2h_count; bytes = &report->d2h_bytes; host_directed = true; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_DTOD:
                case CUPTI_ACTIVITY_MEMCPY_KIND_ATOD:
                case CUPTI_ACTIVITY_MEMCPY_KIND_DTOA:
                case CUPTI_ACTIVITY_MEMCPY_KIND_ATOA:
                    count = &report->d2d_count; bytes = &report->d2d_bytes; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_HTOH:
                    count = &report->h2h_count; bytes = &report->h2h_bytes; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_PTOP:
                    count = &report->p2p_count; bytes = &report->p2p_bytes; break;
                default:
                    report->flags |= modal_eps_trace_unclassified;
                    host_vector_size_ambiguous = true;
                    break;
            }
            if (count != nullptr && bytes != nullptr &&
                (!checked_add(count, 1) || !checked_add(bytes, event.bytes))) {
                report->flags |= modal_eps_trace_lost;
            }
            if (event.operation_kind != CUPTI_ACTIVITY_MEMCPY_KIND_HTOH) {
                if ((event.presence & kPhaseHasDeviceId) == 0 || event.device_id < 0 ||
                    event.device_id == static_cast<int64_t>(CUPTI_UNIFIED_MEMORY_CPU_DEVICE_ID) ||
                    (observed_device_id >= 0 && observed_device_id != event.device_id)) {
                    report->flags |= modal_eps_trace_unclassified;
                } else {
                    observed_device_id = event.device_id;
                }
            }
            if (host_directed) {
                if (trace.phase_full_vector_bytes != 0 &&
                    event.bytes == trace.phase_full_vector_bytes) {
                    if (!checked_add(&report->full_vector_crossings, 1))
                        report->flags |= modal_eps_trace_lost;
                } else {
                    host_vector_size_ambiguous = true;
                }
            }
            break;
        }
        case kPhaseMemset:
            report->phase_coverage |= modal_eps_coverage_memset;
            if ((event.presence & kPhaseHasDeviceId) == 0 || event.device_id < 0 ||
                event.device_id == static_cast<int64_t>(CUPTI_UNIFIED_MEMORY_CPU_DEVICE_ID) ||
                (observed_device_id >= 0 && observed_device_id != event.device_id)) {
                report->flags |= modal_eps_trace_unclassified;
            } else {
                observed_device_id = event.device_id;
            }
            break;
        case kPhaseSynchronization:
            report->phase_coverage |= modal_eps_coverage_synchronization;
            switch (event.operation_kind) {
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_STREAM_SYNCHRONIZE:
                    record_stream_poll(trace.phase_stream_synchronizations, event, duration, report->flags);
                    [[fallthrough]];
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_EVENT_SYNCHRONIZE:
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_CONTEXT_SYNCHRONIZE:
                    if (!checked_add(&report->host_sync_count, 1) ||
                        !checked_add(&report->host_sync_duration_ns, duration))
                        report->flags |= modal_eps_trace_lost;
                    break;
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_STREAM_WAIT_EVENT:
                    break;
                default:
                    report->flags |= modal_eps_trace_unclassified;
                    break;
            }
            break;
        case kPhaseMemory: {
            report->phase_coverage |= modal_eps_coverage_memory;
            if ((event.presence & (kPhaseHasOperationKind | kPhaseHasMemoryKind | kPhaseHasBytes)) !=
                (kPhaseHasOperationKind | kPhaseHasMemoryKind | kPhaseHasBytes)) {
                report->flags |= modal_eps_trace_unclassified;
                break;
            }
            uint64_t *total_count = nullptr;
            uint64_t *total_bytes = nullptr;
            uint64_t *kind_count = nullptr;
            uint64_t *kind_bytes = nullptr;
            switch (event.memory_kind) {
                case CUPTI_ACTIVITY_MEMORY_KIND_DEVICE:
                case CUPTI_ACTIVITY_MEMORY_KIND_ARRAY:
                case CUPTI_ACTIVITY_MEMORY_KIND_DEVICE_STATIC:
                    report->allocation_kind_coverage |= modal_eps_allocation_kind_device;
                    if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_ALLOCATION) {
                        kind_count = &report->device_allocation_count; kind_bytes = &report->device_allocation_bytes;
                    } else if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_RELEASE) {
                        kind_count = &report->device_release_count; kind_bytes = &report->device_release_bytes;
                    }
                    break;
                case CUPTI_ACTIVITY_MEMORY_KIND_MANAGED:
                case CUPTI_ACTIVITY_MEMORY_KIND_MANAGED_STATIC:
                    report->allocation_kind_coverage |= modal_eps_allocation_kind_managed;
                    if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_ALLOCATION) {
                        kind_count = &report->managed_allocation_count; kind_bytes = &report->managed_allocation_bytes;
                    } else if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_RELEASE) {
                        kind_count = &report->managed_release_count; kind_bytes = &report->managed_release_bytes;
                    }
                    break;
                case CUPTI_ACTIVITY_MEMORY_KIND_PAGEABLE:
                case CUPTI_ACTIVITY_MEMORY_KIND_PINNED:
                    report->allocation_kind_coverage |= modal_eps_allocation_kind_host;
                    if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_ALLOCATION) {
                        kind_count = &report->host_allocation_count; kind_bytes = &report->host_allocation_bytes;
                    } else if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_RELEASE) {
                        kind_count = &report->host_release_count; kind_bytes = &report->host_release_bytes;
                    }
                    break;
                default:
                    report->flags |= modal_eps_trace_unclassified;
                    break;
            }
            if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_ALLOCATION) {
                total_count = &report->allocation_count; total_bytes = &report->allocation_bytes;
            } else if (event.operation_kind == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_RELEASE) {
                total_count = &report->release_count; total_bytes = &report->release_bytes;
            } else {
                report->flags |= modal_eps_trace_unclassified;
            }
            if (total_count != nullptr && total_bytes != nullptr &&
                (!checked_add(total_count, 1) || !checked_add(total_bytes, event.bytes)))
                report->flags |= modal_eps_trace_lost;
            if (kind_count != nullptr && kind_bytes != nullptr &&
                (!checked_add(kind_count, 1) || !checked_add(kind_bytes, event.bytes)))
                report->flags |= modal_eps_trace_lost;
            break;
        }
        default:
            report->flags |= modal_eps_trace_unclassified;
            break;
    }
    if ((report->flags & modal_eps_trace_lost) != 0) return;
    try {
        if (!trace.phase_digest_chunk) {
            trace.phase_digest_chunk.emplace("fullmag.cupti.modal_eps_delivery_chunk.v2");
            trace.phase_digest_chunk->add_string("previous_chunk_sha256", trace.phase_digest_chain);
        }
        add_phase_event_digest(&*trace.phase_digest_chunk, event);
        if (++trace.phase_digest_chunk_record_count == kPhaseDigestChunkRecords) {
            finish_phase_digest_chunk(trace);
        }
    } catch (...) {
        report->flags |= modal_eps_trace_lost;
    }
}

void mark_global_phase_quality(ActivityTrace &trace, fullmag::fem::cuda_trace::ModalEpsSolveTraceV1 *report) {
    using namespace fullmag::fem::cuda_trace;
    if (read_count(trace.counts.unknown_records) != 0 ||
        read_count(trace.counts.incomplete_records) != 0 ||
        read_count(trace.counts.truncated_names) != 0) {
        report->flags |= modal_eps_trace_unclassified;
    }
    if (read_count(trace.counts.dropped_records) != 0 ||
        read_count(trace.counts.buffer_starvations) != 0 ||
        read_count(trace.counts.api_errors) != 0 ||
        read_count(trace.counts.io_errors) != 0 ||
        (trace.limit_scope == TraceLimitScope::Capture &&
         read_count(trace.counts.limit_flags) != 0) ||
        trace.collector_poisoned.load(std::memory_order_acquire)) {
        report->flags |= modal_eps_trace_lost;
    }
}

void encode_modal_eps_phase_digest(ActivityTrace &trace,
                                   fullmag::fem::cuda_trace::ModalEpsSolveTraceV1 *report) {
    finish_phase_digest_chunk(trace);
    fullmag::fem::frequency_domain::CanonicalDigestBuilder digest(
        "fullmag.cupti.modal_eps_solve_window.v2");
    digest.add_u64("cupti_api_version", CUPTI_API_VERSION);
    digest.add_u64("start_ns", report->start_ns);
    digest.add_u64("end_ns", report->end_ns);
    digest.add_u64("observed_activity_records", report->observed_activity_records);
    digest.add_string("delivery_order_chunks_sha256", trace.phase_digest_chain);
    const std::string hex = digest.sha256_hex();
    if (hex.size() != 64) {
        report->flags |= fullmag::fem::cuda_trace::modal_eps_trace_lost;
        return;
    }
    std::memcpy(report->native_trace_sha256, hex.data(), hex.size());
    report->native_trace_sha256[64] = '\0';
}

void write_event(ActivityTrace &trace, const Event &event) {
    if (trace.limit_scope == TraceLimitScope::Sample &&
        read_count(trace.counts.limit_flags) != 0) return;

    char quoted_name[kNameBytes * 6 + 4]{};
    bool name_truncated = false;
    if (!append_json_string(quoted_name, sizeof(quoted_name), event.name, &name_truncated)) {
        increment(trace.counts.io_errors);
        request_stop(trace);
        return;
    }
    if (name_truncated) increment(trace.counts.truncated_names);

    if (read_count(trace.counts.io_errors) != 0) {
        increment(trace.counts.dropped_records);
        return;
    }

    char bytes[32]{};
    char address[32]{};
    char return_value[32]{};
    char event_id[32]{};
    char activity_kind[32]{};
    char operation_kind[32]{};
    char process_id[32]{};
    char thread_id[32]{};
    char device_id[32]{};
    char context_id[32]{};
    char stream_id[32]{};
    if (event.has_bytes) std::snprintf(bytes, sizeof(bytes), "%llu", static_cast<unsigned long long>(event.bytes));
    else std::strcpy(bytes, "null");
    if (event.has_address) std::snprintf(address, sizeof(address), "%llu", static_cast<unsigned long long>(event.address));
    else std::strcpy(address, "null");
    if (event.has_return_value) std::snprintf(return_value, sizeof(return_value), "%llu", static_cast<unsigned long long>(event.return_value));
    else std::strcpy(return_value, "null");
    if (event.has_event_id) std::snprintf(event_id, sizeof(event_id), "%llu", static_cast<unsigned long long>(event.event_id));
    else std::strcpy(event_id, "null");
    if (event.has_activity_kind) std::snprintf(activity_kind, sizeof(activity_kind), "%lld", static_cast<long long>(event.activity_kind));
    else std::strcpy(activity_kind, "null");
    if (event.has_operation_kind) std::snprintf(operation_kind, sizeof(operation_kind), "%lld", static_cast<long long>(event.operation_kind));
    else std::strcpy(operation_kind, "null");
    if (event.has_process_id) std::snprintf(process_id, sizeof(process_id), "%lld", static_cast<long long>(event.process_id));
    else std::strcpy(process_id, "null");
    if (event.has_thread_id) std::snprintf(thread_id, sizeof(thread_id), "%lld", static_cast<long long>(event.thread_id));
    else std::strcpy(thread_id, "null");
    if (event.has_device_id) std::snprintf(device_id, sizeof(device_id), "%lld", static_cast<long long>(event.device_id));
    else std::strcpy(device_id, "null");
    if (event.has_context_id) std::snprintf(context_id, sizeof(context_id), "%lld", static_cast<long long>(event.context_id));
    else std::strcpy(context_id, "null");
    if (event.has_stream_id) std::snprintf(stream_id, sizeof(stream_id), "%lld", static_cast<long long>(event.stream_id));
    else std::strcpy(stream_id, "null");
    const char *timestamp_status = !event.timestamps_applicable
        ? "not_applicable" : event.timestamp_valid ? "valid" : "incomplete";

    char line[kLineBytes]{};
    const uint64_t duration = event.timestamp_valid ? event.end_ns - event.start_ns : 0;
    const int length = std::snprintf(
        line, sizeof(line),
        "{\"type\":\"activity\",\"kind\":\"%s\",\"timestamp_domain\":\"cupti_activity_ns\","
        "\"start_ns\":%llu,\"end_ns\":%llu,\"duration_ns\":%llu,\"timestamps_valid\":%s,\"timestamp_status\":\"%s\","
        "\"correlation_id\":%llu,\"runtime_correlation_id\":%llu,\"event_id\":%s,\"process_id\":%s,"
        "\"thread_id\":%s,\"device_id\":%s,\"context_id\":%s,\"stream_id\":%s,"
        "\"bytes\":%s,\"address\":%s,\"return_value\":%s,"
        "\"activity_kind\":%s,\"operation_kind\":%s,\"name\":%s,\"name_truncated\":%s}\n",
        event.kind,
        static_cast<unsigned long long>(event.start_ns),
        static_cast<unsigned long long>(event.end_ns),
        static_cast<unsigned long long>(duration),
        event.timestamp_valid ? "true" : "false",
        timestamp_status,
        static_cast<unsigned long long>(event.correlation_id),
        static_cast<unsigned long long>(event.runtime_correlation_id),
        event_id, process_id, thread_id, device_id, context_id, stream_id,
        bytes, address, return_value,
        activity_kind, operation_kind, quoted_name,
        name_truncated ? "true" : "false");
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(line)) {
        increment(trace.counts.io_errors);
        request_stop(trace);
        return;
    }

    const uint64_t current = read_count(trace.counts.bytes_written);
    const uint64_t budget = trace.max_bytes.load(std::memory_order_relaxed);
    if (current > budget || static_cast<uint64_t>(length) > budget - current) {
        trace.counts.limit_flags.fetch_or(FULLMAG_FEM_CUDA_TRACE_LIMIT_BYTES,
                                          std::memory_order_relaxed);
        if (trace.limit_scope == TraceLimitScope::Capture) {
            increment(trace.counts.dropped_records);
            request_stop(trace);
        }
        return;
    }

    size_t written = 0;
    if (!write_all(trace.output_fd.load(std::memory_order_relaxed), line,
                   static_cast<size_t>(length), &written)) {
        trace.counts.bytes_written.fetch_add(written, std::memory_order_relaxed);
        increment(trace.counts.io_errors);
        request_stop(trace);
        return;
    }
    trace.counts.bytes_written.fetch_add(written, std::memory_order_relaxed);
    increment(trace.counts.records_written);
}

void process_record(ActivityTrace &trace, CUpti_Activity *record) {
    if (record == nullptr) {
        increment(trace.counts.incomplete_records);
        return;
    }
    Event event;
    char dynamic_name[80]{};
    event.activity_kind = static_cast<int64_t>(record->kind);
    event.has_activity_kind = true;

    switch (record->kind) {
        case CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL: {
            const auto *item = reinterpret_cast<const CUpti_ActivityKernel9 *>(record);
            event.kind = "kernel";
            event.name = item->name;
            event.start_ns = item->start;
            event.end_ns = item->end;
            event.correlation_id = item->correlationId;
            event.device_id = item->deviceId;
            event.has_device_id = true;
            event.context_id = item->contextId;
            event.has_context_id = true;
            event.stream_id = item->streamId;
            event.has_stream_id = true;
            break;
        }
        case CUPTI_ACTIVITY_KIND_DRIVER:
        case CUPTI_ACTIVITY_KIND_RUNTIME: {
            const auto *item = reinterpret_cast<const CUpti_ActivityAPI *>(record);
            event.kind = record->kind == CUPTI_ACTIVITY_KIND_DRIVER ? "driver_api" : "runtime_api";
            event.callback_id = static_cast<uint64_t>(item->cbid);
            event.has_callback_id = true;
            const char *callback_name = nullptr;
            const CUpti_CallbackDomain domain = record->kind == CUPTI_ACTIVITY_KIND_DRIVER
                ? CUPTI_CB_DOMAIN_DRIVER_API : CUPTI_CB_DOMAIN_RUNTIME_API;
            if (g_cupti.cuptiGetCallbackName(domain, static_cast<uint32_t>(item->cbid), &callback_name) == CUPTI_SUCCESS) {
                event.name = callback_name;
            } else {
                increment(trace.counts.api_errors);
                event.name = "unknown_api";
            }
            event.start_ns = item->start;
            event.end_ns = item->end;
            event.correlation_id = item->correlationId;
            event.process_id = item->processId;
            event.has_process_id = true;
            event.thread_id = item->threadId;
            event.has_thread_id = true;
            event.return_value = item->returnValue;
            event.has_return_value = true;
            break;
        }
        case CUPTI_ACTIVITY_KIND_MEMCPY: {
            const auto *item = reinterpret_cast<const CUpti_ActivityMemcpy6 *>(record);
            event.kind = "memcpy";
            const char *copy_name = "unknown_copy_kind";
            switch (item->copyKind) {
                case CUPTI_ACTIVITY_MEMCPY_KIND_HTOD: copy_name = "host_to_device"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_DTOH: copy_name = "device_to_host"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_HTOA: copy_name = "host_to_array"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_ATOH: copy_name = "array_to_host"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_ATOA: copy_name = "array_to_array"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_ATOD: copy_name = "array_to_device"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_DTOA: copy_name = "device_to_array"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_DTOD: copy_name = "device_to_device"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_HTOH: copy_name = "host_to_host"; break;
                case CUPTI_ACTIVITY_MEMCPY_KIND_PTOP: copy_name = "peer_to_peer"; break;
                default: break;
            }
            if (std::strcmp(copy_name, "unknown_copy_kind") == 0) {
                std::snprintf(dynamic_name, sizeof(dynamic_name),
                              "unknown_copy_kind_%u", static_cast<unsigned>(item->copyKind));
                event.name = dynamic_name;
            } else {
                event.name = copy_name;
            }
            event.operation_kind = item->copyKind;
            event.has_operation_kind = true;
            event.start_ns = item->start;
            event.end_ns = item->end;
            event.correlation_id = item->correlationId;
            event.runtime_correlation_id = item->runtimeCorrelationId;
            event.device_id = item->deviceId;
            event.has_device_id = true;
            event.context_id = item->contextId;
            event.has_context_id = true;
            event.stream_id = item->streamId;
            event.has_stream_id = true;
            event.bytes = item->bytes;
            event.has_bytes = true;
            break;
        }
        case CUPTI_ACTIVITY_KIND_MEMSET: {
            const auto *item = reinterpret_cast<const CUpti_ActivityMemset4 *>(record);
            event.kind = "memset";
            event.name = "cuda_memset";
            event.start_ns = item->start;
            event.end_ns = item->end;
            event.correlation_id = item->correlationId;
            event.device_id = item->deviceId;
            event.has_device_id = true;
            event.context_id = item->contextId;
            event.has_context_id = true;
            event.stream_id = item->streamId;
            event.has_stream_id = true;
            event.bytes = item->bytes;
            event.has_bytes = true;
            break;
        }
        case CUPTI_ACTIVITY_KIND_SYNCHRONIZATION: {
            const auto *item = reinterpret_cast<const CUpti_ActivitySynchronization2 *>(record);
            event.kind = "synchronization";
            const char *sync_name = "unknown_synchronization_type";
            switch (item->type) {
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_UNKNOWN: sync_name = "unknown"; break;
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_EVENT_SYNCHRONIZE: sync_name = "event_synchronize"; break;
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_STREAM_WAIT_EVENT: sync_name = "stream_wait_event"; break;
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_STREAM_SYNCHRONIZE: sync_name = "stream_synchronize"; break;
                case CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_CONTEXT_SYNCHRONIZE: sync_name = "context_synchronize"; break;
                default: break;
            }
            if (std::strcmp(sync_name, "unknown_synchronization_type") == 0) {
                std::snprintf(dynamic_name, sizeof(dynamic_name),
                              "unknown_synchronization_type_%u", static_cast<unsigned>(item->type));
                event.name = dynamic_name;
            } else {
                event.name = sync_name;
            }
            event.operation_kind = static_cast<int64_t>(item->type);
            event.has_operation_kind = true;
            event.start_ns = item->start;
            event.end_ns = item->end;
            event.correlation_id = item->correlationId;
            event.context_id = item->contextId;
            event.has_context_id = true;
            event.stream_id = item->streamId;
            event.has_stream_id = true;
            break;
        }
        case CUPTI_ACTIVITY_KIND_CUDA_EVENT: {
            const auto *item = reinterpret_cast<const CUpti_ActivityCudaEvent2 *>(record);
            event.kind = "cuda_event_metadata";
            event.name = "cuda_event_record";
            event.timestamps_applicable = false;
            event.correlation_id = item->correlationId;
            event.context_id = item->contextId;
            event.has_context_id = true;
            event.stream_id = item->streamId;
            event.has_stream_id = true;
            event.event_id = item->eventId;
            event.has_event_id = true;
            break;
        }
        case CUPTI_ACTIVITY_KIND_MEMORY2: {
            const auto *item = reinterpret_cast<const CUpti_ActivityMemory4 *>(record);
            event.kind = "memory";
            event.name = item->memoryOperationType == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_ALLOCATION
                ? "allocation" : item->memoryOperationType == CUPTI_ACTIVITY_MEMORY_OPERATION_TYPE_RELEASE
                    ? "release" : "unknown_memory_operation";
            event.start_ns = item->timestamp;
            event.end_ns = item->timestamp;
            event.correlation_id = item->correlationId;
            event.operation_kind = static_cast<int64_t>(item->memoryOperationType);
            event.has_operation_kind = true;
            event.memory_kind = static_cast<int64_t>(item->memoryKind);
            event.has_memory_kind = true;
            event.process_id = item->processId;
            event.has_process_id = true;
            event.device_id = item->deviceId;
            event.has_device_id = true;
            event.context_id = item->contextId;
            event.has_context_id = true;
            event.stream_id = item->streamId;
            event.has_stream_id = true;
            event.bytes = item->bytes;
            event.address = item->address;
            event.has_bytes = true;
            event.has_address = true;
            break;
        }
        default:
            increment(trace.counts.unknown_records);
            event.kind = "unknown";
            event.name = "unsupported_activity_record";
            break;
    }

    note_timestamp(trace, &event);
    append_phase_candidate(trace, event);
    if (event.kind == "unknown") {
        // Unknown kinds are preserved as numeric records and explicitly make the trace partial.
    }
    write_event(trace, event);
}

void process_buffer(ActivityTrace &trace, BufferSlot &slot) {
    CUpti_Activity *record = nullptr;
    while (true) {
        const CUptiResult result = g_cupti.cuptiActivityGetNextRecord(slot.bytes, slot.valid_size, &record);
        if (result == CUPTI_ERROR_MAX_LIMIT_REACHED) break;
        if (result == CUPTI_ERROR_INVALID_KIND) {
            increment(trace.counts.incomplete_records);
            break;
        }
        if (result != CUPTI_SUCCESS) {
            increment(trace.counts.api_errors);
            break;
        }
        process_record(trace, record);
    }

    size_t dropped = 0;
    const CUptiResult dropped_result = g_cupti.cuptiActivityGetNumDroppedRecords(nullptr, 0, &dropped);
    if (dropped_result == CUPTI_SUCCESS) {
        if (dropped > 0) increment(trace.counts.dropped_records, dropped);
    } else if (dropped_result != CUPTI_ERROR_NOT_INITIALIZED) {
        increment(trace.counts.api_errors);
    }
}

bool any_ready(ActivityTrace &trace) {
    for (auto &slot : trace.slots) {
        if (slot.state.load(std::memory_order_acquire) == kReady) return true;
    }
    return false;
}

void writer_loop(ActivityTrace &trace) {
    while (true) {
        bool processed = false;
        for (auto &slot : trace.slots) {
            uint8_t expected = kReady;
            if (!slot.state.compare_exchange_strong(expected, kProcessing,
                                                    std::memory_order_acq_rel)) continue;
            const auto processing_started = std::chrono::steady_clock::now();
            process_buffer(trace, slot);
            const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - processing_started).count();
            increment(trace.buffer_processing_ns, static_cast<uint64_t>(elapsed));
            increment(trace.buffer_bytes_processed, slot.valid_size);
            increment(trace.buffers_processed);
            slot.valid_size = 0;
            slot.state.store(kFree, std::memory_order_release);
            trace.changed.notify_all();
            processed = true;
        }
        if (trace.flush_complete.load(std::memory_order_acquire) && !any_ready(trace)) break;
        if (!processed) {
            std::unique_lock<std::mutex> lock(trace.wait_mutex);
            trace.changed.wait_for(lock, std::chrono::milliseconds(2));
        }
    }
    trace.writer_done.store(true, std::memory_order_release);
    trace.changed.notify_all();
}

void disable_and_flush(ActivityTrace &trace) {
    trace.callbacks_accepting.store(false, std::memory_order_release);
    static constexpr CUpti_ActivityKind kinds[] = {
        CUPTI_ACTIVITY_KIND_DRIVER,
        CUPTI_ACTIVITY_KIND_RUNTIME,
        CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL,
        CUPTI_ACTIVITY_KIND_MEMCPY,
        CUPTI_ACTIVITY_KIND_MEMSET,
        CUPTI_ACTIVITY_KIND_SYNCHRONIZATION,
        CUPTI_ACTIVITY_KIND_MEMORY2,
        CUPTI_ACTIVITY_KIND_CUDA_EVENT,
    };
    {
        std::lock_guard<std::mutex> flush_lock(trace.flush_mutex);
        for (size_t index = 0; index < std::size(kinds); ++index) {
            if (trace.enabled[index]) {
                const CUptiResult result = g_cupti.cuptiActivityDisable(kinds[index]);
                if (result != CUPTI_SUCCESS) {
                    increment(trace.counts.api_errors);
                    trace.collector_poisoned.store(true, std::memory_order_release);
                }
                trace.enabled[index] = false;
            }
        }
        const CUptiResult flush_result = g_cupti.cuptiActivityFlushAll(CUPTI_ACTIVITY_FLAG_FLUSH_FORCED);
        if (flush_result != CUPTI_SUCCESS) {
            increment(trace.counts.api_errors);
            trace.collector_poisoned.store(true, std::memory_order_release);
        }
    }
    // FlushAll waits for completed-buffer callbacks. This in-flight check
    // protects the static buffers before a later capture resets their slots.
    while (trace.callbacks_in_flight.load(std::memory_order_acquire) != 0) {
        std::this_thread::yield();
    }
    for (auto &slot : trace.slots) {
        if (slot.state.load(std::memory_order_acquire) == kFilling) {
            increment(trace.counts.incomplete_records);
            increment(trace.counts.dropped_records);
            trace.collector_poisoned.store(true, std::memory_order_release);
        }
    }
    trace.end_timestamp_ns.store(monotonic_timestamp());
    trace.flush_complete.store(true, std::memory_order_release);
    trace.active.store(false, std::memory_order_release);
    trace.changed.notify_all();
}

void watchdog_loop(ActivityTrace &trace, std::chrono::steady_clock::time_point deadline) {
    while (!trace.stop_requested.load(std::memory_order_acquire)) {
        const auto next_flush = std::chrono::steady_clock::now() +
            std::chrono::milliseconds(kBufferFlushPeriodMs);
        const bool duration_elapsed =
            (read_count(trace.counts.limit_flags) & FULLMAG_FEM_CUDA_TRACE_LIMIT_DURATION) != 0;
        const auto wake = duration_elapsed ? next_flush : std::min(deadline, next_flush);
        {
            std::unique_lock<std::mutex> lock(trace.wait_mutex);
            const bool stopped = trace.changed.wait_until(lock, wake, [&trace] {
                return trace.stop_requested.load(std::memory_order_acquire);
            });
            if (stopped) break;
            if (!duration_elapsed && std::chrono::steady_clock::now() >= deadline) {
                trace.counts.limit_flags.fetch_or(FULLMAG_FEM_CUDA_TRACE_LIMIT_DURATION,
                                                  std::memory_order_relaxed);
                if (trace.limit_scope == TraceLimitScope::Capture) {
                    trace.stop_requested.store(true, std::memory_order_release);
                    break;
                }
            }
        }
        // Normal FlushAll also delivers partially filled buffers whose records
        // are complete. Serialize it with tagged-window flushes and final stop.
        const auto started = std::chrono::steady_clock::now();
        increment(trace.normal_flush_calls);
        CUptiResult result = CUPTI_ERROR_NOT_INITIALIZED;
        {
            std::lock_guard<std::mutex> flush_lock(trace.flush_mutex);
            if (trace.active.load(std::memory_order_acquire) &&
                trace.callbacks_accepting.load(std::memory_order_acquire)) {
                result = g_cupti.cuptiActivityFlushAll(0);
            }
        }
        increment(trace.normal_flush_ns, static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - started).count()));
        if (result != CUPTI_SUCCESS) {
            increment(trace.normal_flush_errors);
            increment(trace.counts.api_errors);
            trace.collector_poisoned.store(true, std::memory_order_release);
            request_stop(trace);
            break;
        }
    }
    disable_and_flush(trace);
}

void reset_capture(ActivityTrace &trace) {
    for (auto &slot : trace.slots) {
        slot.valid_size = 0;
        slot.state.store(kFree, std::memory_order_relaxed);
    }
    trace.counts.records_written.store(0);
    trace.counts.bytes_written.store(0);
    trace.counts.dropped_records.store(0);
    trace.counts.buffer_starvations.store(0);
    trace.counts.unknown_records.store(0);
    trace.counts.truncated_names.store(0);
    trace.counts.incomplete_records.store(0);
    trace.counts.api_errors.store(0);
    trace.counts.io_errors.store(0);
    trace.counts.limit_flags.store(0);
    trace.stop_requested.store(false);
    trace.reported_closed_buffer_request.store(false);
    trace.reported_exhausted_buffer_request.store(false);
    trace.pool_exhaustions.store(0);
    trace.closed_buffer_requests.store(0);
    trace.buffers_completed.store(0);
    trace.buffers_processed.store(0);
    trace.buffer_bytes_processed.store(0);
    trace.buffer_processing_ns.store(0);
    trace.normal_flush_calls.store(0);
    trace.normal_flush_errors.store(0);
    trace.normal_flush_ns.store(0);
    trace.pressure_samples.fill(BufferPressureSample{});
    {
        std::lock_guard<std::mutex> phase_lock(trace.phase_mutex);
        trace.phase_lifecycle = kPhaseIdle;
        trace.phase_capture_token = 0;
        trace.phase_token = 0;
        trace.phase_start_ns = 0;
        trace.phase_end_ns = 0;
        trace.phase_flags = 0;
        trace.phase_untimed_metadata_records = 0;
        trace.phase_full_vector_bytes = 0;
        trace.reset_phase_measurements();
    }
    trace.active.store(false);
    trace.callbacks_accepting.store(false);
    trace.flush_complete.store(false);
    trace.writer_done.store(false);
    trace.start_timestamp_ns.store(0);
    trace.end_timestamp_ns.store(0);
    std::fill(std::begin(trace.enabled), std::end(trace.enabled), false);
}

bool slots_idle(ActivityTrace &trace) {
    if (trace.callbacks_in_flight.load(std::memory_order_acquire) != 0) return false;
    for (auto &slot : trace.slots) {
        if (slot.state.load(std::memory_order_acquire) != kFree) return false;
    }
    return true;
}

bool append_header(ActivityTrace &trace, uint64_t max_bytes, uint32_t duration_ms) {
    char header[512]{};
    const int length = std::snprintf(
        header, sizeof(header),
        "{\"type\":\"header\",\"schema\":\"worker_cuda_trace.v1\","
        "\"timestamp_domain\":\"cupti_activity_ns\",\"cupti_api_version\":%u,"
        "\"clock_source\":\"clock_monotonic\",\"timestamp_callback_registered\":true,"
        "\"max_bytes\":%llu,\"max_duration_ms\":%u,"
        "\"activity_kinds\":[\"driver_api\",\"runtime_api\",\"kernel\",\"memcpy\","
        "\"memset\",\"synchronization\",\"memory\",\"cuda_event_metadata\"]}\n",
        g_cupti.version, static_cast<unsigned long long>(max_bytes), duration_ms);
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(header) ||
        static_cast<uint64_t>(length) > max_bytes) return false;
    size_t written = 0;
    const bool ok = write_all(trace.output_fd.load(), header, static_cast<size_t>(length), &written);
    trace.counts.bytes_written.store(written);
    if (!ok) increment(trace.counts.io_errors);
    return ok;
}

void fill_stats(ActivityTrace &trace, fullmag_fem_cuda_trace_stats_v1 *stats) {
    std::memset(stats, 0, sizeof(*stats));
    stats->schema_version = FULLMAG_FEM_CUDA_TRACE_SCHEMA_VERSION;
    stats->cupti_version = CUPTI_API_VERSION;
    stats->start_timestamp_ns = trace.start_timestamp_ns.load();
    stats->end_timestamp_ns = trace.end_timestamp_ns.load();
    stats->records_written = read_count(trace.counts.records_written);
    stats->bytes_written = read_count(trace.counts.bytes_written);
    stats->dropped_records = read_count(trace.counts.dropped_records);
    stats->buffer_starvations = read_count(trace.counts.buffer_starvations);
    stats->unknown_records = read_count(trace.counts.unknown_records);
    stats->truncated_names = read_count(trace.counts.truncated_names);
    stats->incomplete_records = read_count(trace.counts.incomplete_records);
    stats->api_errors = read_count(trace.counts.api_errors);
    stats->io_errors = read_count(trace.counts.io_errors);
    stats->limit_flags = read_count(trace.counts.limit_flags);
}

bool validate_output_fd(int fd) {
    struct stat info{};
    if (fd < 0 || fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size != 0) return false;
    const int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || (flags & O_ACCMODE) == O_RDONLY || (flags & O_APPEND) != 0) return false;
    return lseek(fd, 0, SEEK_CUR) == 0;
}

void register_callbacks_once() {
    std::call_once(g_callback_registration_once, [] {
        g_callback_registration = g_cupti.cuptiActivityRegisterTimestampCallback(monotonic_timestamp);
        if (g_callback_registration == CUPTI_SUCCESS) {
            g_callback_registration = g_cupti.cuptiActivityRegisterCallbacks(buffer_requested, buffer_completed);
        }
    });
}

void report_buffer_pressure(const ActivityTrace &trace) {
    // Outside callbacks and after joins: no new allocation, formatting or I/O
    // is added to CUPTI's buffer-request path. Samples are selected moments,
    // not a frequency distribution. Processing includes decode, JSON, writes
    // and the CUPTI dropped-record query; it is not CPU-only serialization time.
    for (const auto &sample : trace.pressure_samples) {
        if (sample.occurrence == 0) continue;
        std::fprintf(stderr,
                     "cuda_activity_trace: buffer_pressure occurrence=%llu sampled_free=%zu "
                     "sampled_filling=%zu sampled_ready=%zu sampled_processing=%zu "
                     "completed=%llu processed=%llu records_written=%llu bytes_written=%llu\n",
                     static_cast<unsigned long long>(sample.occurrence), sample.observed_states[kFree],
                     sample.observed_states[kFilling], sample.observed_states[kReady],
                     sample.observed_states[kProcessing], static_cast<unsigned long long>(sample.completed),
                     static_cast<unsigned long long>(sample.processed),
                     static_cast<unsigned long long>(sample.records_written),
                     static_cast<unsigned long long>(sample.bytes_written));
    }
    std::fprintf(stderr,
                 "cuda_activity_trace: buffer_processing pool_exhaustions=%llu closed_requests=%llu "
                 "completed=%llu processed=%llu raw_bytes=%llu processing_ns=%llu "
                 "normal_flush_calls=%llu normal_flush_errors=%llu normal_flush_ns=%llu\n",
                 static_cast<unsigned long long>(read_count(trace.pool_exhaustions)),
                 static_cast<unsigned long long>(read_count(trace.closed_buffer_requests)),
                 static_cast<unsigned long long>(read_count(trace.buffers_completed)),
                 static_cast<unsigned long long>(read_count(trace.buffers_processed)),
                 static_cast<unsigned long long>(read_count(trace.buffer_bytes_processed)),
                 static_cast<unsigned long long>(read_count(trace.buffer_processing_ns)),
                 static_cast<unsigned long long>(read_count(trace.normal_flush_calls)),
                 static_cast<unsigned long long>(read_count(trace.normal_flush_errors)),
                 static_cast<unsigned long long>(read_count(trace.normal_flush_ns)));
}

constexpr CUpti_ActivityKind kKinds[] = {
    CUPTI_ACTIVITY_KIND_DRIVER,
    CUPTI_ACTIVITY_KIND_RUNTIME,
    CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL,
    CUPTI_ACTIVITY_KIND_MEMCPY,
    CUPTI_ACTIVITY_KIND_MEMSET,
    CUPTI_ACTIVITY_KIND_SYNCHRONIZATION,
    CUPTI_ACTIVITY_KIND_MEMORY2,
    CUPTI_ACTIVITY_KIND_CUDA_EVENT,
};
// API 28 decouples event metadata from synchronization: enable both explicitly.

void terminate_failed_start(ActivityTrace &trace) {
    request_stop(trace);
    if (trace.watchdog.joinable()) {
        trace.watchdog.join();
    } else {
        disable_and_flush(trace);
    }
    if (trace.writer.joinable()) trace.writer.join();
    trace.active.store(false);
}

} // namespace

namespace fullmag::fem::cuda_trace {

bool begin_modal_eps_solve_v1(
    const ModalEpsSolveTraceConfigV1 &config,
    PhaseTokenV1 *token) noexcept {
    if (token == nullptr) return false;
    *token = PhaseTokenV1{};
    try {
        std::lock_guard<std::mutex> api_lock(g_api_mutex);
        if (g_trace.output_fd.load(std::memory_order_acquire) < 0 ||
            !g_trace.active.load(std::memory_order_acquire) ||
            !g_trace.callbacks_accepting.load(std::memory_order_acquire)) {
            token->flags = modal_eps_trace_unavailable;
            return false;
        }
        if (g_trace.collector_poisoned.load(std::memory_order_acquire)) {
            token->flags = modal_eps_trace_lost;
            return false;
        }

        std::lock_guard<std::mutex> phase_lock(g_trace.phase_mutex);
        if (g_trace.phase_lifecycle == kPhaseOpen || g_trace.phase_lifecycle == kPhaseClosing) {
            token->flags = modal_eps_trace_unsupported;
            return false;
        }
        const uint64_t start_ns = monotonic_timestamp();
        const uint64_t capture_token = g_trace.token.load(std::memory_order_acquire);
        if (start_ns == 0) {
            token->flags = modal_eps_trace_lost | modal_eps_trace_invalid_window;
            return false;
        }
        if (capture_token == 0 ||
            start_ns < g_trace.start_timestamp_ns.load(std::memory_order_acquire)) {
            token->flags = modal_eps_trace_unclassified;
            return false;
        }

        uint64_t phase_token = g_trace.next_phase_token++;
        if (phase_token == 0) phase_token = g_trace.next_phase_token++;
        g_trace.phase_lifecycle = kPhaseOpen;
        g_trace.phase_capture_token = capture_token;
        g_trace.phase_token = phase_token;
        g_trace.phase_start_ns = start_ns;
        g_trace.phase_end_ns = 0;
        g_trace.phase_flags = 0;
        g_trace.phase_untimed_metadata_records = 0;
        g_trace.phase_full_vector_bytes = config.full_vector_bytes;
        g_trace.reset_phase_measurements();
        token->capture_token = capture_token;
        token->value = phase_token;
        return true;
    } catch (...) {
        token->flags = modal_eps_trace_lost;
        return false;
    }
}

bool end_modal_eps_solve_v1(
    PhaseTokenV1 token,
    ModalEpsSolveTraceV1 *report) noexcept {
    if (report == nullptr) return false;
    *report = ModalEpsSolveTraceV1{};
    if (token.value == 0) {
        report->flags = token.flags != 0 ? token.flags : modal_eps_trace_unsupported;
        return false;
    }
    try {
        std::lock_guard<std::mutex> api_lock(g_api_mutex);
        if (g_trace.output_fd.load(std::memory_order_acquire) < 0 ||
            !g_trace.active.load(std::memory_order_acquire) ||
            !g_trace.callbacks_accepting.load(std::memory_order_acquire)) {
            report->flags = modal_eps_trace_unavailable;
            return false;
        }
        {
            std::lock_guard<std::mutex> phase_lock(g_trace.phase_mutex);
            if (g_trace.phase_lifecycle != kPhaseOpen ||
                token.capture_token != g_trace.phase_capture_token ||
                token.capture_token != g_trace.token.load(std::memory_order_acquire) ||
                token.value != g_trace.phase_token) {
                report->flags = modal_eps_trace_unsupported;
                return false;
            }
            const uint64_t end_ns = monotonic_timestamp();
            if (end_ns == 0 || end_ns <= g_trace.phase_start_ns) {
                g_trace.phase_flags |= modal_eps_trace_invalid_window;
                if (end_ns == 0) g_trace.phase_flags |= modal_eps_trace_lost;
                g_trace.phase_lifecycle = kPhaseFinalized;
                report->start_ns = g_trace.phase_start_ns;
                report->end_ns = end_ns;
                report->flags = g_trace.phase_flags;
                return false;
            }
            g_trace.phase_end_ns = end_ns;
            g_trace.phase_lifecycle = kPhaseClosing;
        }

        // CUPTI's normal flush only delivers completed activity. The fence
        // is deliberately issued after closing the tagged solve interval.
        if (cudaDeviceSynchronize() != cudaSuccess) {
            std::lock_guard<std::mutex> phase_lock(g_trace.phase_mutex);
            g_trace.phase_flags |= modal_eps_trace_lost | modal_eps_trace_flush_failed;
        }

        const auto flush_started = std::chrono::steady_clock::now();
        increment(g_trace.normal_flush_calls);
        CUptiResult flush_result = CUPTI_ERROR_NOT_INITIALIZED;
        {
            std::lock_guard<std::mutex> flush_lock(g_trace.flush_mutex);
            if (g_trace.active.load(std::memory_order_acquire) &&
                g_trace.callbacks_accepting.load(std::memory_order_acquire)) {
                flush_result = g_cupti.cuptiActivityFlushAll(0);
            }
        }
        increment(g_trace.normal_flush_ns, static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - flush_started).count()));
        if (flush_result != CUPTI_SUCCESS) {
            increment(g_trace.normal_flush_errors);
            increment(g_trace.counts.api_errors);
            g_trace.collector_poisoned.store(true, std::memory_order_release);
            std::lock_guard<std::mutex> phase_lock(g_trace.phase_mutex);
            g_trace.phase_flags |= modal_eps_trace_lost | modal_eps_trace_flush_failed;
        }

        const uint64_t target_completed = read_count(g_trace.buffers_completed);
        const auto drain_deadline = std::chrono::steady_clock::now() +
            std::chrono::milliseconds(kPhaseDrainTimeoutMs);
        bool drained = false;
        {
            std::unique_lock<std::mutex> wait_lock(g_trace.wait_mutex);
            drained = g_trace.changed.wait_until(wait_lock, drain_deadline, [&] {
                return read_count(g_trace.buffers_processed) >= target_completed &&
                    slots_idle(g_trace);
            });
        }
        if (!drained) {
            std::lock_guard<std::mutex> phase_lock(g_trace.phase_mutex);
            g_trace.phase_flags |= modal_eps_trace_lost | modal_eps_trace_flush_failed;
        }

        std::lock_guard<std::mutex> phase_lock(g_trace.phase_mutex);
        *report = g_trace.phase_metrics;
        report->start_ns = g_trace.phase_start_ns;
        report->end_ns = g_trace.phase_end_ns;
        report->flags |= g_trace.phase_flags;
        report->untimed_metadata_records = g_trace.phase_untimed_metadata_records;
        if (report->untimed_metadata_records != 0) {
            report->phase_coverage |= modal_eps_coverage_cuda_event_metadata;
        }
        if (g_trace.phase_full_vector_bytes != 0 && !g_trace.phase_host_vector_size_ambiguous) {
            report->counter_coverage |= modal_eps_counter_coverage_full_vector_crossings;
        }
        if (g_trace.phase_latest_open_record_end_ns > report->end_ns) {
            // Records processed before close have unclipped durations. A
            // timestamp beyond the close boundary invalidates those totals.
            report->flags |= modal_eps_trace_invalid_window;
        }
        mark_global_phase_quality(g_trace, report);
        classify_stream_query_synchronizations(g_trace, *report);
        if (report->kernel_records == 0)
            report->flags |= modal_eps_trace_no_kernel_activity;

        constexpr uint64_t kFatalFlags = modal_eps_trace_unavailable |
            modal_eps_trace_unsupported | modal_eps_trace_unclassified |
            modal_eps_trace_lost | modal_eps_trace_flush_failed |
            modal_eps_trace_buffer_overflow | modal_eps_trace_invalid_window |
            modal_eps_trace_no_kernel_activity;
        if ((report->flags & kFatalFlags) == 0) {
            report->counter_coverage |= modal_eps_counter_coverage_transfers |
                modal_eps_counter_coverage_allocations |
                modal_eps_counter_coverage_host_sync;
            try {
                encode_modal_eps_phase_digest(g_trace, report);
            } catch (...) {
                report->flags |= modal_eps_trace_lost;
            }
        }
        if (report->flags == 0 && report->native_trace_sha256[0] != '\0') {
            if (report->d2h_count == 0 && report->d2h_bytes == 0) {
                report->counter_coverage |= modal_eps_counter_coverage_scalar_telemetry_d2h;
            }
            report->flags = modal_eps_trace_complete;
        } else {
            report->counter_coverage = 0;
            report->native_trace_sha256[0] = '\0';
        }
        g_trace.phase_lifecycle = kPhaseFinalized;
        return (report->flags & modal_eps_trace_complete) != 0;
    } catch (...) {
        report->flags = modal_eps_trace_lost;
        report->counter_coverage = 0;
        report->native_trace_sha256[0] = '\0';
        return false;
    }
}

} // namespace fullmag::fem::cuda_trace

extern "C" int fullmag_fem_cuda_trace_available_v1(void) {
    return g_trace.collector_poisoned.load(std::memory_order_acquire) ? 0 : 1;
}

static int start_cuda_activity_trace(
    int fd, uint64_t max_bytes, uint32_t max_duration_ms, uint64_t *token,
    TraceLimitScope limit_scope) {
    if (token == nullptr) return FULLMAG_FEM_ERR_INVALID;
    *token = 0;
    std::lock_guard<std::mutex> api_lock(g_api_mutex);
    if (g_trace.collector_poisoned.load(std::memory_order_acquire))
        return FULLMAG_FEM_ERR_INTERNAL;
    if (g_trace.output_fd.load() >= 0 || g_trace.writer.joinable() ||
        g_trace.watchdog.joinable()) return FULLMAG_FEM_ERR_INVALID;
    if (!slots_idle(g_trace)) {
        g_trace.collector_poisoned.store(true, std::memory_order_release);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (max_bytes < kMinBytes || max_bytes > kMaxBytes ||
        max_duration_ms < kMinDurationMs || max_duration_ms > kMaxDurationMs ||
        !validate_output_fd(fd)) return FULLMAG_FEM_ERR_INVALID;

    if (!g_cupti.load()) return FULLMAG_FEM_ERR_UNAVAILABLE;

    const int duplicate = fcntl(fd, F_DUPFD_CLOEXEC, 0);
    if (duplicate < 0) return FULLMAG_FEM_ERR_INVALID;
    reset_capture(g_trace);
    g_trace.limit_scope = limit_scope;
    g_trace.output_fd.store(duplicate);
    g_trace.max_bytes.store(max_bytes);
    uint64_t this_token = g_trace.next_token++;
    if (this_token == 0) this_token = g_trace.next_token++;
    g_trace.token.store(this_token);

    register_callbacks_once();
    if (g_callback_registration != CUPTI_SUCCESS) {
        increment(g_trace.counts.api_errors);
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    if (!append_header(g_trace, max_bytes, max_duration_ms)) {
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    const uint64_t timestamp = monotonic_timestamp();
    if (timestamp == 0) {
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    g_trace.start_timestamp_ns.store(timestamp);
    const auto duration_deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(max_duration_ms);
    g_trace.active.store(true, std::memory_order_release);
    g_trace.callbacks_accepting.store(true, std::memory_order_release);
    try {
        g_trace.writer = std::thread(writer_loop, std::ref(g_trace));
    } catch (...) {
        increment(g_trace.counts.api_errors);
        terminate_failed_start(g_trace);
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    for (size_t index = 0; index < std::size(kKinds); ++index) {
        const CUptiResult result = g_cupti.cuptiActivityEnable(kKinds[index]);
        if (result != CUPTI_SUCCESS) {
            std::fprintf(stderr, "cuda_activity_trace: enable kind=%u failed: CUPTI result=%u\n",
                         static_cast<unsigned>(kKinds[index]), static_cast<unsigned>(result));
            increment(g_trace.counts.api_errors);
            terminate_failed_start(g_trace);
            ::close(duplicate);
            g_trace.output_fd.store(-1);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        g_trace.enabled[index] = true;
    }
    try {
        g_trace.watchdog = std::thread(watchdog_loop, std::ref(g_trace), duration_deadline);
    } catch (...) {
        increment(g_trace.counts.api_errors);
        terminate_failed_start(g_trace);
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    *token = this_token;
    return FULLMAG_FEM_OK;
}

extern "C" int fullmag_fem_cuda_trace_start_v1(
    int fd, uint64_t max_bytes, uint32_t max_duration_ms, uint64_t *token) {
    return start_cuda_activity_trace(fd, max_bytes, max_duration_ms, token, TraceLimitScope::Capture);
}

extern "C" int fullmag_fem_cuda_trace_start_modal_v1(
    int fd, uint64_t max_bytes, uint32_t max_duration_ms, uint64_t *token) {
    return start_cuda_activity_trace(fd, max_bytes, max_duration_ms, token, TraceLimitScope::Sample);
}

extern "C" int fullmag_fem_cuda_trace_stop_v1(
    uint64_t token, fullmag_fem_cuda_trace_stats_v1 *stats) {
    if (stats == nullptr || token == 0) return FULLMAG_FEM_ERR_INVALID;
    std::lock_guard<std::mutex> api_lock(g_api_mutex);
    if (g_trace.output_fd.load() < 0) {
        if (token != g_trace.last_token) return FULLMAG_FEM_ERR_INVALID;
        *stats = g_trace.last_stats;
        return (stats->api_errors == 0 && stats->io_errors == 0)
            ? FULLMAG_FEM_OK : FULLMAG_FEM_ERR_INTERNAL;
    }
    if (token != g_trace.token.load()) return FULLMAG_FEM_ERR_INVALID;

    request_stop(g_trace);
    if (g_trace.watchdog.joinable()) g_trace.watchdog.join();
    g_trace.changed.notify_all();
    if (g_trace.writer.joinable()) g_trace.writer.join();

    report_buffer_pressure(g_trace);
    const int output_fd = g_trace.output_fd.load();
    if (output_fd >= 0) {
        if (fsync(output_fd) != 0) increment(g_trace.counts.io_errors);
        if (::close(output_fd) != 0) increment(g_trace.counts.io_errors);
        g_trace.output_fd.store(-1);
    }
    g_trace.active.store(false, std::memory_order_release);
    fill_stats(g_trace, stats);
    g_trace.last_token = token;
    g_trace.last_stats = *stats;
    return (stats->api_errors == 0 && stats->io_errors == 0)
        ? FULLMAG_FEM_OK : FULLMAG_FEM_ERR_INTERNAL;
}

#else

namespace fullmag::fem::cuda_trace {

bool begin_modal_eps_solve_v1(
    const ModalEpsSolveTraceConfigV1 &,
    PhaseTokenV1 *token) noexcept {
    if (token == nullptr) return false;
    *token = PhaseTokenV1{};
    token->flags = modal_eps_trace_unavailable;
    return false;
}

bool end_modal_eps_solve_v1(
    PhaseTokenV1,
    ModalEpsSolveTraceV1 *report) noexcept {
    if (report == nullptr) return false;
    *report = ModalEpsSolveTraceV1{};
    report->flags = modal_eps_trace_unavailable;
    return false;
}

} // namespace fullmag::fem::cuda_trace

extern "C" int fullmag_fem_cuda_trace_available_v1(void) {
    return 0;
}

extern "C" int fullmag_fem_cuda_trace_start_v1(
    int, uint64_t, uint32_t, uint64_t *token) {
    if (token != nullptr) *token = 0;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
}

extern "C" int fullmag_fem_cuda_trace_start_modal_v1(
    int fd, uint64_t max_bytes, uint32_t max_duration_ms, uint64_t *token) {
    return fullmag_fem_cuda_trace_start_v1(fd, max_bytes, max_duration_ms, token);
}

extern "C" int fullmag_fem_cuda_trace_stop_v1(
    uint64_t, fullmag_fem_cuda_trace_stats_v1 *) {
    return FULLMAG_FEM_ERR_UNAVAILABLE;
}

#endif
