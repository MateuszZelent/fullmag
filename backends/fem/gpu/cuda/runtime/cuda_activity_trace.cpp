#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE 1
#endif

#include "fullmag_fem_cuda_trace.h"

#if defined(FULLMAG_FEM_CUPTI_TRACE_ENABLED) && defined(__linux__)

#include <cupti_activity.h>
#include <cupti_callbacks.h>
#include <cupti_version.h>

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
#include <mutex>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

static_assert(CUPTI_API_VERSION == 24, "CUPTI trace collector requires Activity API 24");

namespace {

constexpr size_t kBufferCount = 8;
constexpr size_t kBufferBytes = 1024 * 1024;
constexpr size_t kNameBytes = 2048;
constexpr size_t kLineBytes = 16384;
constexpr uint64_t kMinBytes = FULLMAG_FEM_CUDA_TRACE_MIN_BYTES;
constexpr uint64_t kMaxBytes = FULLMAG_FEM_CUDA_TRACE_MAX_BYTES;
constexpr uint32_t kMinDurationMs = FULLMAG_FEM_CUDA_TRACE_MIN_DURATION_MS;
constexpr uint32_t kMaxDurationMs = FULLMAG_FEM_CUDA_TRACE_MAX_DURATION_MS;

enum SlotState : uint8_t { kFree = 0, kFilling = 1, kReady = 2, kProcessing = 3 };

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

struct ActivityTrace {
    BufferSlot slots[kBufferCount];
    AtomicStats counts;
    std::atomic<bool> active{false};
    std::atomic<bool> callbacks_accepting{false};
    std::atomic<bool> stop_requested{false};
    std::atomic<bool> flush_complete{false};
    std::atomic<bool> writer_done{false};
    std::atomic<uint64_t> callbacks_in_flight{0};
    std::atomic<bool> collector_poisoned{false};
    std::atomic<int> output_fd{-1};
    std::atomic<uint64_t> max_bytes{0};
    std::atomic<uint64_t> start_timestamp_ns{0};
    std::atomic<uint64_t> end_timestamp_ns{0};
    std::atomic<uint64_t> token{0};
    std::mutex wait_mutex;
    std::condition_variable changed;
    std::thread writer;
    std::thread watchdog;
    uint64_t next_token = 1;
    uint64_t last_token = 0;
    fullmag_fem_cuda_trace_stats_v1 last_stats{};
    bool enabled[7]{};
};

ActivityTrace g_trace;
std::mutex g_api_mutex;
std::once_flag g_callback_registration_once;
CUptiResult g_callback_registration = CUPTI_ERROR_NOT_INITIALIZED;

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
        if (g_trace.active.load(std::memory_order_acquire)) {
            increment(g_trace.counts.buffer_starvations);
            increment(g_trace.counts.dropped_records);
        } else {
            g_trace.collector_poisoned.store(true, std::memory_order_release);
            increment(g_trace.counts.api_errors);
        }
        return;
    }
    for (auto &slot : g_trace.slots) {
        uint8_t expected = kFree;
        if (slot.state.compare_exchange_strong(expected, kFilling,
                                               std::memory_order_acq_rel)) {
            slot.valid_size = 0;
            *buffer = slot.bytes;
            *size = kBufferBytes;
            return;
        }
    }
    increment(g_trace.counts.buffer_starvations);
    increment(g_trace.counts.dropped_records);
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
    bool has_bytes = false;
    bool has_address = false;
    bool has_return_value = false;
    bool has_event_id = false;
    bool has_activity_kind = false;
    bool has_operation_kind = false;
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

void write_event(ActivityTrace &trace, const Event &event) {
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
        increment(trace.counts.dropped_records);
        request_stop(trace);
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
            const char *callback_name = nullptr;
            const CUpti_CallbackDomain domain = record->kind == CUPTI_ACTIVITY_KIND_DRIVER
                ? CUPTI_CB_DOMAIN_DRIVER_API : CUPTI_CB_DOMAIN_RUNTIME_API;
            if (cuptiGetCallbackName(domain, static_cast<uint32_t>(item->cbid), &callback_name) == CUPTI_SUCCESS) {
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
            const auto *item = reinterpret_cast<const CUpti_ActivityMemcpy5 *>(record);
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
            const auto *item = reinterpret_cast<const CUpti_ActivitySynchronization *>(record);
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
            const auto *item = reinterpret_cast<const CUpti_ActivityCudaEvent *>(record);
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
    if (event.kind == "unknown") {
        // Unknown kinds are preserved as numeric records and explicitly make the trace partial.
    }
    write_event(trace, event);
}

void process_buffer(ActivityTrace &trace, BufferSlot &slot) {
    CUpti_Activity *record = nullptr;
    while (true) {
        const CUptiResult result = cuptiActivityGetNextRecord(slot.bytes, slot.valid_size, &record);
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
    const CUptiResult dropped_result = cuptiActivityGetNumDroppedRecords(nullptr, 0, &dropped);
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
            process_buffer(trace, slot);
            slot.valid_size = 0;
            slot.state.store(kFree, std::memory_order_release);
            processed = true;
        }
        if (trace.flush_complete.load(std::memory_order_acquire) && !any_ready(trace)) break;
        if (!processed) {
            std::unique_lock<std::mutex> lock(trace.wait_mutex);
            trace.changed.wait_for(lock, std::chrono::milliseconds(2));
        }
    }
    trace.writer_done.store(true, std::memory_order_release);
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
    };
    for (size_t index = 0; index < std::size(kinds); ++index) {
        if (trace.enabled[index]) {
            const CUptiResult result = cuptiActivityDisable(kinds[index]);
            if (result != CUPTI_SUCCESS) {
                increment(trace.counts.api_errors);
                trace.collector_poisoned.store(true, std::memory_order_release);
            }
            trace.enabled[index] = false;
        }
    }
    const CUptiResult flush_result = cuptiActivityFlushAll(CUPTI_ACTIVITY_FLAG_FLUSH_FORCED);
    if (flush_result != CUPTI_SUCCESS) {
        increment(trace.counts.api_errors);
        trace.collector_poisoned.store(true, std::memory_order_release);
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
    uint64_t timestamp = 0;
    const CUptiResult timestamp_result = cuptiGetTimestamp(&timestamp);
    if (timestamp_result == CUPTI_SUCCESS) trace.end_timestamp_ns.store(timestamp);
    else increment(trace.counts.api_errors);
    trace.flush_complete.store(true, std::memory_order_release);
    trace.active.store(false, std::memory_order_release);
    trace.changed.notify_all();
}

void watchdog_loop(ActivityTrace &trace, std::chrono::steady_clock::time_point deadline) {
    {
        std::unique_lock<std::mutex> lock(trace.wait_mutex);
        const bool stopped = trace.changed.wait_until(
            lock, deadline, [&trace] {
                return trace.stop_requested.load(std::memory_order_acquire);
            });
        if (!stopped) {
            trace.counts.limit_flags.fetch_or(FULLMAG_FEM_CUDA_TRACE_LIMIT_DURATION,
                                              std::memory_order_relaxed);
            trace.stop_requested.store(true, std::memory_order_release);
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
        "\"timestamp_domain\":\"cupti_activity_ns\",\"cupti_api_version\":24,"
        "\"max_bytes\":%llu,\"max_duration_ms\":%u,"
        "\"activity_kinds\":[\"driver_api\",\"runtime_api\",\"kernel\",\"memcpy\","
        "\"memset\",\"synchronization\",\"memory\",\"cuda_event_metadata\"]}\n",
        static_cast<unsigned long long>(max_bytes), duration_ms);
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
        g_callback_registration = cuptiActivityRegisterCallbacks(buffer_requested, buffer_completed);
    });
}

constexpr CUpti_ActivityKind kKinds[] = {
    CUPTI_ACTIVITY_KIND_DRIVER,
    CUPTI_ACTIVITY_KIND_RUNTIME,
    CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL,
    CUPTI_ACTIVITY_KIND_MEMCPY,
    CUPTI_ACTIVITY_KIND_MEMSET,
    CUPTI_ACTIVITY_KIND_SYNCHRONIZATION,
    CUPTI_ACTIVITY_KIND_MEMORY2,
};
// CUPTI Activity API 24 emits CUDA_EVENT metadata with SYNCHRONIZATION.
// CUDA_EVENT itself cannot be passed to ActivityEnable/ActivityDisable.

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

extern "C" int fullmag_fem_cuda_trace_available_v1(void) {
    return g_trace.collector_poisoned.load(std::memory_order_acquire) ? 0 : 1;
}

extern "C" int fullmag_fem_cuda_trace_start_v1(
    int fd, uint64_t max_bytes, uint32_t max_duration_ms, uint64_t *token) {
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

    const int duplicate = fcntl(fd, F_DUPFD_CLOEXEC, 0);
    if (duplicate < 0) return FULLMAG_FEM_ERR_INVALID;
    reset_capture(g_trace);
    g_trace.output_fd.store(duplicate);
    g_trace.max_bytes.store(max_bytes);
    uint64_t this_token = g_trace.next_token++;
    if (this_token == 0) this_token = g_trace.next_token++;
    g_trace.token.store(this_token);

    if (!append_header(g_trace, max_bytes, max_duration_ms)) {
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    register_callbacks_once();
    if (g_callback_registration != CUPTI_SUCCESS) {
        increment(g_trace.counts.api_errors);
        ::close(duplicate);
        g_trace.output_fd.store(-1);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    uint64_t timestamp = 0;
    if (cuptiGetTimestamp(&timestamp) != CUPTI_SUCCESS) {
        increment(g_trace.counts.api_errors);
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
        const CUptiResult result = cuptiActivityEnable(kKinds[index]);
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

extern "C" int fullmag_fem_cuda_trace_available_v1(void) {
    return 0;
}

extern "C" int fullmag_fem_cuda_trace_start_v1(
    int, uint64_t, uint32_t, uint64_t *token) {
    if (token != nullptr) *token = 0;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
}

extern "C" int fullmag_fem_cuda_trace_stop_v1(
    uint64_t, fullmag_fem_cuda_trace_stats_v1 *) {
    return FULLMAG_FEM_ERR_UNAVAILABLE;
}

#endif
