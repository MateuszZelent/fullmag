#include "fullmag_fem_cuda_trace.h"

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <thread>
#include <chrono>
#include <csignal>

#if defined(FULLMAG_FEM_CUDA_TRACE_TEST_ENABLED)
#include <cuda.h>
#include <cuda_runtime_api.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

int fail(const char *message) {
    std::cerr << "cuda_activity_trace_contract: " << message << '\n';
    return 1;
}

#if defined(FULLMAG_FEM_CUDA_TRACE_TEST_ENABLED)

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
    const std::string ptx = probe_ptx(kernel_name);
    CUresult result = cuModuleLoadData(&module, ptx.c_str());
    if (result != CUDA_SUCCESS) return false;
    result = cuModuleGetFunction(&function, module, kernel_name.c_str());
    if (result != CUDA_SUCCESS) {
        cuModuleUnload(module);
        return false;
    }
    int *device_output = nullptr;
    if (cudaMalloc(reinterpret_cast<void **>(&device_output), sizeof(int)) != cudaSuccess) {
        cuModuleUnload(module);
        return false;
    }
    void *arguments[] = {&device_output};
    result = cuLaunchKernel(function, 1, 1, 1, 1, 1, 1, 0, nullptr, arguments, nullptr);
    const cudaError_t sync_result = cudaDeviceSynchronize();
    const cudaError_t free_result = cudaFree(device_output);
    const CUresult unload_result = cuModuleUnload(module);
    return result == CUDA_SUCCESS && sync_result == cudaSuccess &&
           free_result == cudaSuccess && unload_result == CUDA_SUCCESS;
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

    uint64_t token = 0;
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, FULLMAG_FEM_CUDA_TRACE_MAX_BYTES, 30000, &token) !=
        FULLMAG_FEM_OK || token == 0) return fail("valid capture did not start");
    TempTrace competing_trace;
    if (!competing_trace.create()) return fail("could not create competing output file");
    uint64_t second_token = 0;
    if (fullmag_fem_cuda_trace_start_v1(competing_trace.fd, 4096, 1000, &second_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("second concurrent start was not rejected");

    if (!run_cuda_workload()) {
        fullmag_fem_cuda_trace_stats_v1 ignored{};
        fullmag_fem_cuda_trace_stop_v1(token, &ignored);
        return fail("CUDA test workload failed");
    }

    fullmag_fem_cuda_trace_stats_v1 stats{};
    if (fullmag_fem_cuda_trace_stop_v1(token, &stats) != FULLMAG_FEM_OK)
        return fail("capture did not stop cleanly");
    fullmag_fem_cuda_trace_stats_v1 repeated{};
    if (fullmag_fem_cuda_trace_stop_v1(token, &repeated) != FULLMAG_FEM_OK ||
        std::memcmp(&stats, &repeated, sizeof(stats)) != 0)
        return fail("repeated stop did not return the stable result");
    if (stats.schema_version != FULLMAG_FEM_CUDA_TRACE_SCHEMA_VERSION ||
        stats.cupti_version == 0 || stats.records_written == 0 ||
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
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, FULLMAG_FEM_CUDA_TRACE_MAX_BYTES, 30000, &token) !=
        FULLMAG_FEM_OK || token == 0)
        return fail("dense capture did not start");

    std::string dense_failure;
    const bool dense_workload_ok = run_dense_cuda_workload(dense_failure);
    std::cerr << "cuda_activity_trace_contract: phase=dense_capture_before_stop"
              << " workload=" << (dense_workload_ok ? "complete" : "failed")
              << " detail=" << (dense_failure.empty() ? "none" : dense_failure) << '\n' << std::flush;
    fullmag_fem_cuda_trace_stats_v1 dense_stats{};
    const int dense_stop_status = fullmag_fem_cuda_trace_stop_v1(token, &dense_stats);
    print_dense_capture_stats(dense_stop_status, trace.fd, dense_stats);
    if (!dense_workload_ok) return fail("dense CUDA test workload failed");
    if (dense_stop_status != FULLMAG_FEM_OK)
        return fail("dense capture did not stop cleanly");
    if (dense_stats.schema_version != FULLMAG_FEM_CUDA_TRACE_SCHEMA_VERSION ||
        dense_stats.cupti_version == 0 || dense_stats.records_written == 0 ||
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

int main() {
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
    if (fullmag_fem_cuda_trace_available_v1() != 1) {
        int device_count = 0;
        if (cudaGetDeviceCount(&device_count) == cudaSuccess && device_count == 0) return 77;
        return fail("CUPTI trace support is built but reports unavailable");
    }
    int device_count = 0;
    const cudaError_t device_result = cudaGetDeviceCount(&device_count);
    if (device_result != cudaSuccess || device_count == 0) return 77;
    if (cudaSetDevice(0) != cudaSuccess) return 77;
    std::signal(SIGALRM, [](int) { std::_Exit(124); });
    alarm(60);
    const int result = enabled_contract();
    alarm(0);
    return result;
#endif
}
