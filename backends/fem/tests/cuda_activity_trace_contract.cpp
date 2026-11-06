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

int enabled_contract() {
    TempTrace trace;
    if (!trace.create()) return fail("could not create trace output file");

    uint64_t unused_token = 0;
    if (fullmag_fem_cuda_trace_start_v1(-1, 4096, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("invalid fd was not rejected");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4095, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("undersized byte limit was not rejected");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4096, 0, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("zero duration was not rejected");

    if (write(trace.fd, "x", 1) != 1) return fail("could not seed non-empty output file");
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4096, 1000, &unused_token) !=
        FULLMAG_FEM_ERR_INVALID) return fail("non-empty output file was not rejected");
    if (!trace.reset()) return fail("could not reset output file");

    uint64_t token = 0;
    if (fullmag_fem_cuda_trace_start_v1(trace.fd, 4 * 1024 * 1024, 30000, &token) !=
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
