#include "fullmag_fem_cuda_trace.h"

#include <cerrno>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <string>
#include <thread>
#include <chrono>
#include <csignal>

#if defined(FULLMAG_FEM_CUDA_TRACE_TEST_ENABLED)
#include <cuda.h>
#include <cuda_runtime_api.h>
#include "../gpu/cuda/runtime/cupti_library.hpp"
#include <fcntl.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
extern char **environ;
#endif

namespace {

int fail(const char *message) {
    std::cerr << "cuda_activity_trace_contract: " << message << '\n';
    return 1;
}

#if defined(FULLMAG_FEM_CUDA_TRACE_TEST_ENABLED)

std::atomic<unsigned> refused_buffers{0};

void CUPTIAPI refuse_buffer(uint8_t **buffer, size_t *size, size_t *max_records) {
    *buffer = nullptr;
    *size = 0;
    *max_records = 0;
    ++refused_buffers;
}

void CUPTIAPI complete_refused_buffer(CUcontext, uint32_t, uint8_t *, size_t, size_t) {}

std::string probe_ptx(const std::string &kernel_name) {
    return std::string(R"ptx(
.version 6.0
.target sm_52
.address_size 64
.visible .entry )ptx") + kernel_name + R"ptx((.param .u64 output_ptr)
{
    .reg .b64 %rd1;
    .reg .b32 %r1;
    ld.param.u64 %rd1, [output_ptr];
    mov.u32 %r1, 1;
    st.global.u32 [%rd1], %r1;
    ret;
}
)ptx";
}

struct TempTrace {
    char path[64] = "/tmp/fullmag-cupti-trace-XXXXXX";
    int fd = -1;

    bool create() {
        fd = mkstemp(path);
        return fd >= 0;
    }

    bool reset() {
        if (fd < 0 || ftruncate(fd, 0) != 0 || lseek(fd, 0, SEEK_SET) != 0) {
            return false;
        }
        return true;
    }

    ~TempTrace() {
        if (fd >= 0) close(fd);
        if (path[0] != '\0') unlink(path);
    }
};

bool launch_probe_kernel_with_name(const std::string &kernel_name) {
    CUmodule module = nullptr;
    CUfunction function = nullptr;
    cudaStream_t stream = nullptr;
    if (cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking) != cudaSuccess) return false;
    const std::string ptx = probe_ptx(kernel_name);
    CUresult result = cuModuleLoadData(&module, ptx.c_str());
    if (result != CUDA_SUCCESS) {
        cudaStreamDestroy(stream);
        return false;
    }
    result = cuModuleGetFunction(&function, module, kernel_name.c_str());
    if (result != CUDA_SUCCESS) {
        cuModuleUnload(module);
        cudaStreamDestroy(stream);
        return false;
    }
    int *device_output = nullptr;
    if (cudaMalloc(reinterpret_cast<void **>(&device_output), sizeof(int)) != cudaSuccess) {
        cuModuleUnload(module);
        cudaStreamDestroy(stream);
        return false;
    }
    void *arguments[] = {&device_output};
    result = cuLaunchKernel(function, 1, 1, 1, 1, 1, 1, 0,
                            reinterpret_cast<CUstream>(stream), arguments, nullptr);
    const cudaError_t sync_result = cudaStreamSynchronize(stream);
    const cudaError_t free_result = cudaFree(device_output);
    const CUresult unload_result = cuModuleUnload(module);
    const cudaError_t stream_result = cudaStreamDestroy(stream);
    return result == CUDA_SUCCESS && sync_result == cudaSuccess &&
           free_result == cudaSuccess && unload_result == CUDA_SUCCESS &&
           stream_result == cudaSuccess;
}

std::string long_probe_kernel_name(size_t length) {
    constexpr char prefix[] = "fullmag_trace_long_";
    if (length <= sizeof(prefix) - 1) return prefix;
    return std::string(prefix) + std::string(length - (sizeof(prefix) - 1), 'x');
}

bool launch_probe_kernel() {
    return launch_probe_kernel_with_name("fullmag_trace_probe");
}

bool run_cuda_workload() {
    constexpr size_t kBytes = 4096;
    unsigned char *device = nullptr;
    unsigned char host[kBytes]{};
    cudaStream_t stream = nullptr;
    cudaEvent_t event = nullptr;
    bool ok = cudaStreamCreate(&stream) == cudaSuccess;
    if (ok) ok = cudaMalloc(reinterpret_cast<void **>(&device), kBytes) == cudaSuccess;
    if (ok) ok = cudaEventCreate(&event) == cudaSuccess;
    if (ok) ok = cudaMemcpyAsync(device, host, kBytes, cudaMemcpyHostToDevice, stream) == cudaSuccess;
    if (ok) ok = cudaMemsetAsync(device, 0x2a, kBytes, stream) == cudaSuccess;
    if (ok) ok = cudaMemcpyAsync(host, device, kBytes, cudaMemcpyDeviceToHost, stream) == cudaSuccess;
    if (ok) ok = cudaEventRecord(event, stream) == cudaSuccess;
    if (ok) ok = cudaEventSynchronize(event) == cudaSuccess;
    if (ok) ok = cudaStreamSynchronize(stream) == cudaSuccess;
    if (ok) ok = launch_probe_kernel();
    if (ok) ok = launch_probe_kernel_with_name(long_probe_kernel_name(600));
    if (device != nullptr && cudaFree(device) != cudaSuccess) ok = false;
    if (event != nullptr && cudaEventDestroy(event) != cudaSuccess) ok = false;
    if (stream != nullptr && cudaStreamDestroy(stream) != cudaSuccess) ok = false;
    return ok;
}

int buffer_refusal_contract() {
    fullmag::fem::CuptiLibrary api;
    if (!api.load() || api.version != 28) return fail("buffer refusal requires verified CUPTI API 28");
    if (api.cuptiActivityRegisterCallbacks(refuse_buffer, complete_refused_buffer) != CUPTI_SUCCESS ||
        api.cuptiActivityEnable(CUPTI_ACTIVITY_KIND_RUNTIME) != CUPTI_SUCCESS ||
        api.cuptiActivityEnable(CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL) != CUPTI_SUCCESS)
        return fail("could not start intentional buffer refusal capture");
    const bool workload_ok = run_cuda_workload();
    const auto disable_runtime = api.cuptiActivityDisable(CUPTI_ACTIVITY_KIND_RUNTIME);
    const auto disable_kernel = api.cuptiActivityDisable(CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL);
    const auto flush = api.cuptiActivityFlushAll(CUPTI_ACTIVITY_FLAG_FLUSH_FORCED);
    std::cerr << "cuda_activity_trace_contract: phase=buffer_refusal"
              << " cupti_version=" << api.version << " refused_buffers=" << refused_buffers.load()
              << " workload_ok=" << workload_ok << " disable_runtime=" << disable_runtime
              << " disable_kernel=" << disable_kernel << " flush=" << flush << '\n' << std::flush;
    if (!workload_ok || refused_buffers.load() == 0)
        return fail("buffer refusal did not preserve the CUDA workload or was not exercised");
    if (disable_runtime != CUPTI_SUCCESS || disable_kernel != CUPTI_SUCCESS || flush != CUPTI_SUCCESS)
        return fail("buffer refusal capture did not close successfully");
    return 0;
}

int run_buffer_refusal_child() {
    // A separate process keeps this deliberately lossy CUPTI subscriber out of
    // the production collector's callback registration and exact-loss tests.
    char program[] = "/proc/self/exe";
    char mode[] = "--reject-buffers";
    char *arguments[] = {program, mode, nullptr};
    pid_t child = -1;
    if (posix_spawn(&child, program, nullptr, nullptr, arguments, environ) != 0)
        return fail("could not spawn buffer refusal contract");
    int status = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(25);
    pid_t waited = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        waited = waitpid(child, &status, WNOHANG);
        if (waited == child || (waited < 0 && errno != EINTR)) break;
        usleep(10000);
    }
    if (waited == 0 || (waited < 0 && errno == EINTR)) {
        (void)kill(child, SIGKILL);
        do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
        return fail("buffer refusal child exceeded its deadline");
    }
    if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        return fail("buffer refusal child failed or crashed");
    return 0;
}

bool file_contains(const char *path, const char *needle) {
    std::ifstream input(path, std::ios::binary);
    const std::string contents((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
    return input.good() || input.eof() ? contents.find(needle) != std::string::npos : false;
}

bool file_contains_cuda_event_metadata(const char *path) {
    std::ifstream input(path, std::ios::binary);
    std::string line;
    while (std::getline(input, line)) {
        if (line.find("\"kind\":\"cuda_event_metadata\"") != std::string::npos &&
            line.find("\"activity_kind\":36") != std::string::npos &&
            line.find("\"timestamp_status\":\"not_applicable\"") != std::string::npos &&
            line.find("\"timestamps_valid\":false") != std::string::npos &&
            line.find("\"start_ns\":0,\"end_ns\":0,\"duration_ns\":0") != std::string::npos &&
            line.find("\"event_id\":") != std::string::npos &&
            line.find("\"event_id\":null") == std::string::npos &&
            line.find("\"correlation_id\":") != std::string::npos &&
            line.find("\"correlation_id\":null") == std::string::npos &&
            line.find("\"context_id\":") != std::string::npos &&
            line.find("\"context_id\":null") == std::string::npos &&
            line.find("\"stream_id\":") != std::string::npos &&
            line.find("\"stream_id\":null") == std::string::npos) return true;
    }
    return false;
}

bool stats_match_file_size(int fd, uint64_t bytes_written) {
    struct stat info{};
    return fstat(fd, &info) == 0 && info.st_size >= 0 &&
           static_cast<uint64_t>(info.st_size) == bytes_written;
}

bool has_complete_named_kernel_record(int fd, const std::string &kernel_name) {
    struct stat info{};
    if (fstat(fd, &info) != 0 || info.st_size <= 0 ||
        static_cast<uint64_t>(info.st_size) > 4ULL * 1024 * 1024) return false;

    std::string contents(static_cast<size_t>(info.st_size), '\0');
    size_t bytes_read = 0;
    while (bytes_read < contents.size()) {
        const ssize_t count = pread(fd, contents.data() + bytes_read,
                                    contents.size() - bytes_read,
                                    static_cast<off_t>(bytes_read));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        bytes_read += static_cast<size_t>(count);
    }

    const std::string quoted_name = "\"name\":\"" + kernel_name + "\"";
    size_t line_start = 0;
    while (true) {
        const size_t line_end = contents.find('\n', line_start);
        if (line_end == std::string::npos) return false;
        const std::string line = contents.substr(line_start, line_end - line_start);
        if (line.size() >= 2 && line.front() == '{' && line.back() == '}' &&
            line.find("\"kind\":\"kernel\"") != std::string::npos &&
            line.find(quoted_name) != std::string::npos) return true;
        line_start = line_end + 1;
    }
}

uint64_t independent_monotonic_timestamp() {
    timespec now{};
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0) return 0;
    return static_cast<uint64_t>(now.tv_sec) * 1000000000ULL +
        static_cast<uint64_t>(now.tv_nsec);
}

bool timestamps_match_capture(const char *path, const fullmag_fem_cuda_trace_stats_v1 &stats,
                              uint64_t before_start, uint64_t before_stop, uint64_t after_stop) {
    if (before_start == 0 || before_stop < before_start || after_stop < before_stop ||
        stats.start_timestamp_ns < before_start || stats.start_timestamp_ns > before_stop ||
        stats.end_timestamp_ns < before_stop || stats.end_timestamp_ns > after_stop) return false;
    std::ifstream file(path);
    std::string line;
    if (!std::getline(file, line) ||
        line.find("\"clock_source\":\"clock_monotonic\"") == std::string::npos ||
        line.find("\"timestamp_callback_registered\":true") == std::string::npos) return false;
    size_t checked = 0;
    while (std::getline(file, line)) {
        if (line.find("\"timestamps_valid\":true") == std::string::npos) continue;
        const auto start = line.find("\"start_ns\":");
        const auto end = line.find("\"end_ns\":");
        if (start == std::string::npos || end == std::string::npos) return false;
        try {
            const uint64_t first = std::stoull(line.substr(start + 11));
            const uint64_t last = std::stoull(line.substr(end + 9));
            if (first < stats.start_timestamp_ns || last > stats.end_timestamp_ns || last < first)
                return false;
        } catch (...) { return false; }
        ++checked;
    }
    return file.eof() && checked > 0;
}

bool capture_duration_fits_steady_clock_lifecycle(
    const fullmag_fem_cuda_trace_stats_v1 &stats,
    std::chrono::steady_clock::time_point lifecycle_start,
    std::chrono::steady_clock::time_point lifecycle_end) {
    if (stats.start_timestamp_ns == 0 || stats.end_timestamp_ns < stats.start_timestamp_ns ||
        lifecycle_end < lifecycle_start) return false;
    const auto lifecycle_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
        lifecycle_end - lifecycle_start).count();
    if (lifecycle_ns < 0) return false;
    constexpr uint64_t kToleranceNs = 1000000;
    const uint64_t elapsed_ns = static_cast<uint64_t>(lifecycle_ns);
    if (elapsed_ns > std::numeric_limits<uint64_t>::max() - kToleranceNs) return false;
    return stats.end_timestamp_ns - stats.start_timestamp_ns <= elapsed_ns + kToleranceNs;
}

bool run_dense_cuda_workload(std::string &failure) {
    constexpr int kLaunchCount = 50000;
    constexpr int kEventInterval = 8;
    constexpr size_t kKernelNameBytes = 1800;

    CUmodule module = nullptr;
    CUfunction function = nullptr;
    int *device_output = nullptr;
    cudaStream_t stream = nullptr;
    cudaEvent_t event = nullptr;
    bool ok = true;
    auto fail_workload = [&](const char *message) {
        if (failure.empty()) {
            failure = message;
        } else {
            failure += "; ";
            failure += message;
        }
        ok = false;
    };

    if (cudaStreamCreate(&stream) != cudaSuccess) {
        fail_workload("dense workload stream creation failed");
    }
    if (ok && cudaMalloc(reinterpret_cast<void **>(&device_output), sizeof(*device_output)) != cudaSuccess) {
        fail_workload("dense workload device allocation failed");
    }
    if (ok && cudaEventCreate(&event) != cudaSuccess) {
        fail_workload("dense workload event creation failed");
    }
    if (ok) {
        const std::string kernel_name = long_probe_kernel_name(kKernelNameBytes);
        const std::string ptx = probe_ptx(kernel_name);
        CUresult result = cuModuleLoadData(&module, ptx.c_str());
        if (result == CUDA_SUCCESS) {
            result = cuModuleGetFunction(&function, module, kernel_name.c_str());
        }
        if (result != CUDA_SUCCESS) {
            fail_workload("dense workload PTX load or kernel lookup failed");
        }
    }

    if (ok) {
        void *arguments[] = {&device_output};
        const CUstream driver_stream = reinterpret_cast<CUstream>(stream);
        for (int launch = 0; launch < kLaunchCount; ++launch) {
            const CUresult result = cuLaunchKernel(
                function, 1, 1, 1, 1, 1, 1, 0, driver_stream, arguments, nullptr);
            if (result != CUDA_SUCCESS) {
                fail_workload("dense cuLaunchKernel sequence failed");
                break;
            }
            if ((launch + 1) % kEventInterval == 0 &&
                cudaEventRecord(event, stream) != cudaSuccess) {
                fail_workload("dense workload event recording failed");
                break;
            }
        }
    }

    if (stream != nullptr && ok) {
        if (cudaStreamSynchronize(stream) != cudaSuccess) {
            fail_workload("dense workload final stream synchronization failed");
        }
    } else if (stream != nullptr) {
        // Drain queued launches before releasing resources on an early failure.
        if (cudaStreamSynchronize(stream) != cudaSuccess) {
            fail_workload("dense workload cleanup synchronization failed");
        }
    }

    auto record_cleanup_failure = [&](bool succeeded, const char *message) {
        if (!succeeded) fail_workload(message);
    };
    if (event != nullptr) {
        record_cleanup_failure(cudaEventDestroy(event) == cudaSuccess,
                               "dense workload event cleanup failed");
    }
    if (stream != nullptr) {
        record_cleanup_failure(cudaStreamDestroy(stream) == cudaSuccess,
                               "dense workload stream cleanup failed");
    }
    if (device_output != nullptr) {
        record_cleanup_failure(cudaFree(device_output) == cudaSuccess,
                               "dense workload allocation cleanup failed");
    }
    if (module != nullptr) {
        record_cleanup_failure(cuModuleUnload(module) == CUDA_SUCCESS,
                               "dense workload PTX cleanup failed");
    }
    return ok;
}

void print_dense_capture_stats(int stop_status, int fd,
                               const fullmag_fem_cuda_trace_stats_v1 &stats) {
    struct stat info{};
    const bool have_file_size = fstat(fd, &info) == 0 && info.st_size >= 0;
    std::cerr << "cuda_activity_trace_contract: phase=dense_capture_stats"
              << " stop_status=" << stop_status
              << " file_bytes=" << (have_file_size ? static_cast<uint64_t>(info.st_size) : 0)
              << " schema_version=" << stats.schema_version
              << " records_written=" << stats.records_written
              << " bytes_written=" << stats.bytes_written
              << " dropped_records=" << stats.dropped_records
              << " buffer_starvations=" << stats.buffer_starvations
              << " unknown_records=" << stats.unknown_records
              << " truncated_names=" << stats.truncated_names
              << " incomplete_records=" << stats.incomplete_records
              << " api_errors=" << stats.api_errors
              << " io_errors=" << stats.io_errors
              << " limit_flags=" << stats.limit_flags
              << " cupti_version=" << stats.cupti_version
              << " start_timestamp_ns=" << stats.start_timestamp_ns
              << " end_timestamp_ns=" << stats.end_timestamp_ns << '\n' << std::flush;
}

int enabled_contract() {
    std::ifstream maps("/proc/self/maps");
    if (!maps) return fail("could not inspect trace-off library mappings");
    const std::string mapped((std::istreambuf_iterator<char>(maps)), std::istreambuf_iterator<char>());
    if (mapped.find("libcupti.so") != std::string::npos)
        return fail("CUPTI was loaded before capture opt-in");
    int runtime_version = 0;
    if (cudaRuntimeGetVersion(&runtime_version) != cudaSuccess || runtime_version != CUDART_VERSION)
        return fail("CUDA runtime differs from the solver toolkit headers");
    std::cerr << "cuda_activity_trace_contract: phase=trace_off cupti_mapped=false"
              << " cuda_runtime_version=" << runtime_version
              << " cuda_headers_version=" << CUDART_VERSION << '\n' << std::flush;
    TempTrace trace;
    if (!trace.create()) return fail("could not create trace output file");

    uint64_t unused_token = 0;
    if (fullmag_fem_cuda_trace_start_v1(-1, 4096, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("invalid fd was not rejected");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4095, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("undersized byte limit was not rejected");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd,
            static_cast<uint64_t>(FULLMAG_FEM_CUDA_TRACE_MAX_BYTES) + 1, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("oversized byte limit was not rejected");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4096, 0, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("zero duration was not rejected");

    if (write(trace.fd, "x", 1) != 1) return fail("could not seed non-empty output file");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4096, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("non-empty output file was not rejected");
    if (!trace.reset()) return fail("could not reset output file");

    const std::string live_delivery_kernel_name = "fullmag_trace_live_delivery_probe";
    if (!launch_probe_kernel_with_name(live_delivery_kernel_name))
        return fail("CUDA context warmup kernel failed before live-delivery capture");

    const auto capture_lifecycle_start = std::chrono::steady_clock::now();
    const uint64_t before_capture = independent_monotonic_timestamp();
    uint64_t token = 0;
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, FULLMAG_FEM_CUDA_TRACE_MAX_BYTES, 30000, &token) !=
        FULLMAG_FEM_OK || token == 0) return fail("valid capture did not start");
    if (!file_contains("/proc/self/maps", FULLMAG_FEM_CUPTI_LIBRARY_PATH))
        return fail("capture did not map the pinned CUPTI library");
    std::cerr << "cuda_activity_trace_contract: phase=trace_on cupti_library="
              << FULLMAG_FEM_CUPTI_LIBRARY_PATH << '\n' << std::flush;
    TempTrace competing_trace;
    if (!competing_trace.create()) return fail("could not create competing output file");
    uint64_t second_token = 0;
    if (fullmag_fem_cuda_trace_start_v1(competing_trace.fd, 4096, 1000, &second_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("second concurrent start was not rejected");

    const int live_reader_fd = open(trace.path, O_RDONLY | O_CLOEXEC);
    if (live_reader_fd < 0) {
        fullmag_fem_cuda_trace_stats_v1 ignored{};
        fullmag_fem_cuda_trace_stop_v1(token, &ignored);
        return fail("could not open independent reader for live-delivery capture");
    }
    if (!launch_probe_kernel_with_name(live_delivery_kernel_name)) {
        close(live_reader_fd);
        fullmag_fem_cuda_trace_stats_v1 ignored{};
        fullmag_fem_cuda_trace_stop_v1(token, &ignored);
        return fail("live-delivery CUDA workload failed");
    }
    const auto live_delivery_deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(2);
    bool live_kernel_delivered = false;
    while (std::chrono::steady_clock::now() < live_delivery_deadline) {
        if (has_complete_named_kernel_record(live_reader_fd, live_delivery_kernel_name)) {
            live_kernel_delivered = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    close(live_reader_fd);
    std::cerr << "cuda_activity_trace_contract: phase=live_delivery"
              << " capture_active=true kernel=" << live_delivery_kernel_name
              << " delivered=" << (live_kernel_delivered ? "true" : "false")
              << " timeout_ms=2000 reader=independent_pread\n" << std::flush;
    if (!live_kernel_delivered) {
        fullmag_fem_cuda_trace_stats_v1 ignored{};
        fullmag_fem_cuda_trace_stop_v1(token, &ignored);
        return fail("complete named kernel NDJSON record was not delivered before stop");
    }

    if (!run_cuda_workload()) {
        fullmag_fem_cuda_trace_stats_v1 ignored{};
        fullmag_fem_cuda_trace_stop_v1(token, &ignored);
        return fail("CUDA test workload failed");
    }

    fullmag_fem_cuda_trace_stats_v1 stats{};
    const uint64_t before_stop = independent_monotonic_timestamp();
    if (fullmag_fem_cuda_trace_stop_v1(token, &stats) != FULLMAG_FEM_OK)
        return fail("capture did not stop cleanly");
    const uint64_t after_stop = independent_monotonic_timestamp();
    const auto capture_lifecycle_end = std::chrono::steady_clock::now();
    if (!timestamps_match_capture(trace.path, stats, before_capture, before_stop, after_stop))
        return fail("capture timestamps differ from the independent monotonic clock window");
    if (!capture_duration_fits_steady_clock_lifecycle(
            stats, capture_lifecycle_start, capture_lifecycle_end))
        return fail("native capture duration exceeds the independent steady-clock lifecycle envelope");
    fullmag_fem_cuda_trace_stats_v1 repeated{};
    if (fullmag_fem_cuda_trace_stop_v1(token, &repeated) != FULLMAG_FEM_OK ||
        std::memcmp(&stats, &repeated, sizeof(stats)) != 0)
        return fail("repeated stop did not return the stable result");
    if (stats.schema_version != FULLMAG_FEM_CUDA_TRACE_SCHEMA_VERSION ||
        stats.cupti_version != 28 || stats.records_written == 0 ||
        stats.bytes_written > 4 * 1024 * 1024 || stats.io_errors != 0 ||
        stats.dropped_records != 0 || stats.buffer_starvations != 0 ||
        stats.unknown_records != 0 || stats.truncated_names != 0 ||
        stats.incomplete_records != 0 || stats.api_errors != 0 || stats.limit_flags != 0 ||
        !stats_match_file_size(trace.fd, stats.bytes_written))
        return fail("normal capture statistics report loss or are invalid");

    if (!file_contains(trace.path, "worker_cuda_trace.v1") ||
        !file_contains(trace.path, "\"activity_kinds\":[\"driver_api\",\"runtime_api\",\"kernel\",\"memcpy\",\"memset\",\"synchronization\",\"memory\",\"cuda_event_metadata\"]") ||
        !file_contains(trace.path, "\"timestamp_status\":\"valid\"") ||
        !file_contains(trace.path, "\"kind\":\"runtime_api\"") ||
        !file_contains(trace.path, "\"kind\":\"driver_api\"") ||
        !file_contains(trace.path, "\"kind\":\"kernel\"") ||
        !file_contains(trace.path, "\"kind\":\"memcpy\"") ||
        !file_contains(trace.path, "\"name\":\"host_to_device\"") ||
        !file_contains(trace.path, "\"operation_kind\":1") ||
        !file_contains(trace.path, "\"name\":\"device_to_host\"") ||
        !file_contains(trace.path, "\"operation_kind\":2") ||
        !file_contains(trace.path, "\"kind\":\"memset\"") ||
        !file_contains(trace.path, "\"kind\":\"synchronization\"") ||
        !file_contains(trace.path, "\"name\":\"stream_synchronize\"") ||
        !file_contains(trace.path, "\"operation_kind\":3") ||
        !file_contains(trace.path, "\"kind\":\"memory\"") ||
        !file_contains(trace.path, long_probe_kernel_name(600).c_str()) ||
        !file_contains_cuda_event_metadata(trace.path))
        return fail("trace omitted one or more required activity classes");

    if (!trace.reset()) return fail("could not reset output for dense capture");
    std::cerr << "cuda_activity_trace_contract: phase=dense_capture_before_start"
              << " max_bytes=" << FULLMAG_FEM_CUDA_TRACE_MAX_BYTES
              << " max_duration_ms=30000 launches=50000 kernel_name_bytes=1800\n" << std::flush;
    token = 0;
    const auto dense_lifecycle_start = std::chrono::steady_clock::now();
    const uint64_t before_dense = independent_monotonic_timestamp();
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, FULLMAG_FEM_CUDA_TRACE_MAX_BYTES, 30000, &token) !=
        FULLMAG_FEM_OK || token == 0)
        return fail("dense capture did not start");

    std::string dense_failure;
    const bool dense_workload_ok = run_dense_cuda_workload(dense_failure);
    std::cerr << "cuda_activity_trace_contract: phase=dense_capture_before_stop"
              << " workload=" << (dense_workload_ok ? "complete" : "failed")
              << " detail=" << (dense_failure.empty() ? "none" : dense_failure) << '\n' << std::flush;
    fullmag_fem_cuda_trace_stats_v1 dense_stats{};
    const uint64_t before_dense_stop = independent_monotonic_timestamp();
    const int dense_stop_status = fullmag_fem_cuda_trace_stop_v1(token, &dense_stats);
    const uint64_t after_dense_stop = independent_monotonic_timestamp();
    const auto dense_lifecycle_end = std::chrono::steady_clock::now();
    print_dense_capture_stats(dense_stop_status, trace.fd, dense_stats);
    if (!dense_workload_ok) return fail("dense CUDA test workload failed");
    if (dense_stop_status != FULLMAG_FEM_OK)
        return fail("dense capture did not stop cleanly");
    if (!timestamps_match_capture(trace.path, dense_stats, before_dense, before_dense_stop, after_dense_stop))
        return fail("dense timestamps differ from the independent monotonic clock window");
    if (!capture_duration_fits_steady_clock_lifecycle(
            dense_stats, dense_lifecycle_start, dense_lifecycle_end))
        return fail("dense native capture duration exceeds the independent steady-clock lifecycle envelope");
    std::cerr << "cuda_activity_trace_contract: phase=clock_domain source=clock_monotonic"
              << " callback_registered=true all_timed_records_in_capture=true\n" << std::flush;
    if (dense_stats.schema_version != FULLMAG_FEM_CUDA_TRACE_SCHEMA_VERSION ||
        dense_stats.cupti_version != 28 || dense_stats.records_written == 0 ||
        dense_stats.bytes_written <= 8 * 1024 * 1024 ||
        dense_stats.bytes_written > FULLMAG_FEM_CUDA_TRACE_MAX_BYTES ||
        dense_stats.dropped_records != 0 || dense_stats.buffer_starvations != 0 ||
        dense_stats.unknown_records != 0 || dense_stats.truncated_names != 0 ||
        dense_stats.incomplete_records != 0 || dense_stats.api_errors != 0 ||
        dense_stats.io_errors != 0 || dense_stats.limit_flags != 0 ||
        dense_stats.start_timestamp_ns == 0 ||
        dense_stats.end_timestamp_ns < dense_stats.start_timestamp_ns ||
        !stats_match_file_size(trace.fd, dense_stats.bytes_written))
        return fail("dense capture was partial, lost records, or exceeded its contract");

    if (!trace.reset()) return fail("could not reset output for byte-limit case");
    token = 0;
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4096, 30000, &token) !=
        FULLMAG_FEM_OK || token == 0) return fail("byte-limit capture did not start");
    unsigned char *byte_limit_device = nullptr;
    if (cudaMalloc(reinterpret_cast<void **>(&byte_limit_device), 4096) != cudaSuccess) {
        fullmag_fem_cuda_trace_stop_v1(token, &repeated);
        return fail("byte-limit device allocation failed");
    }
    for (int i = 0; i < 128; ++i) {
        if (cudaMemset(byte_limit_device, i, 4096) != cudaSuccess) {
            fullmag_fem_cuda_trace_stop_v1(token, &repeated);
            cudaFree(byte_limit_device);
            return fail("byte-limit CUDA workload failed");
        }
    }
    if (cudaFree(byte_limit_device) != cudaSuccess) return fail("byte-limit device free failed");
    if (fullmag_fem_cuda_trace_stop_v1(token, &stats) != FULLMAG_FEM_OK)
        return fail("byte-limit capture did not stop");
    if (stats.bytes_written > 4096 ||
        !stats_match_file_size(trace.fd, stats.bytes_written) ||
        (stats.limit_flags & FULLMAG_FEM_CUDA_TRACE_LIMIT_BYTES) == 0)
        return fail("byte limit was exceeded or not reported");

    if (!trace.reset()) return fail("could not reset output for time-limit case");
    token = 0;
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4096, 1, &token) !=
        FULLMAG_FEM_OK || token == 0) return fail("time-limit capture did not start");
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
    if (fullmag_fem_cuda_trace_stop_v1(token, &stats) != FULLMAG_FEM_OK)
        return fail("time-limit capture did not stop");
    if (stats.bytes_written > 4096 ||
        !stats_match_file_size(trace.fd, stats.bytes_written) ||
        (stats.limit_flags & FULLMAG_FEM_CUDA_TRACE_LIMIT_DURATION) == 0)
        return fail("duration limit was exceeded or not reported");

    unsigned char *prompt_stop_device = nullptr;
    if (cudaMalloc(reinterpret_cast<void **>(&prompt_stop_device), 4096) != cudaSuccess)
        return fail("prompt-stop device allocation failed");
    for (int i = 0; i < 8; ++i) {
        if (!trace.reset()) {
            cudaFree(prompt_stop_device);
            return fail("could not reset output for prompt-stop loop");
        }
        token = 0;
        if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4 * 1024 * 1024, 120000, &token) !=
            FULLMAG_FEM_OK || token == 0) {
            cudaFree(prompt_stop_device);
            return fail("prompt-stop capture did not start");
        }
        if (cudaMemset(prompt_stop_device, i, 4096) != cudaSuccess) {
            fullmag_fem_cuda_trace_stop_v1(token, &repeated);
            cudaFree(prompt_stop_device);
            return fail("prompt-stop short CUDA workload failed");
        }
        if (fullmag_fem_cuda_trace_stop_v1(token, &stats) != FULLMAG_FEM_OK ||
            !stats_match_file_size(trace.fd, stats.bytes_written) ||
            (stats.limit_flags & FULLMAG_FEM_CUDA_TRACE_LIMIT_DURATION) != 0) {
            cudaFree(prompt_stop_device);
            return fail("prompt stop did not close a short capture cleanly");
        }
    }
    if (cudaFree(prompt_stop_device) != cudaSuccess)
        return fail("prompt-stop device free failed");
    return 0;
}

#endif

} // namespace

int main(int argc, char **argv) {
    static_assert(sizeof(fullmag_fem_cuda_trace_stats_v1) == 112,
                  "native trace stats ABI must be 112 bytes");
#if !defined(FULLMAG_FEM_CUDA_TRACE_TEST_ENABLED)
    if (fullmag_fem_cuda_trace_available_v1() != 0)
        return fail("unsupported build reported CUPTI tracing available");
    uint64_t token = 0;
    if (fullmag_fem_cuda_trace_start_v1(-1, 4096, 1, &token) !=
        FULLMAG_FEM_ERR_UNAVAILABLE)
        return fail("unsupported build did not return unavailable");
    std::cout << "CUPTI activity tracing unavailable in this build (expected)\n";
    return 77;
#else
    // Bound initialization too: a child must not keep the managed log pipe open
    // indefinitely if CUDA stalls before the refusal workload begins.
    const bool refusal_child = argc == 2 && std::strcmp(argv[1], "--reject-buffers") == 0;
    std::signal(SIGALRM, [](int) { std::_Exit(124); });
    alarm(refusal_child ? 20 : 60);
    if (fullmag_fem_cuda_trace_available_v1() != 1) {
        int device_count = 0;
        if (cudaGetDeviceCount(&device_count) == cudaSuccess && device_count == 0) return 77;
        return fail("CUPTI trace support is built but reports unavailable");
    }
    int device_count = 0;
    const cudaError_t device_result = cudaGetDeviceCount(&device_count);
    if (device_result != cudaSuccess || device_count == 0) return 77;
    if (cudaSetDevice(0) != cudaSuccess) return 77;
    if (refusal_child)
        return buffer_refusal_contract();
    if (argc != 1) return fail("unexpected contract arguments");
    // Reset before spawning: the bounded wait can kill/reap the exact child
    // before the parent-wide alarm expires, even after slow initialization.
    alarm(60);
    const int refusal_result = run_buffer_refusal_child();
    const int result = refusal_result == 0 ? enabled_contract() : refusal_result;
    alarm(0);
    return result;
#endif
}
