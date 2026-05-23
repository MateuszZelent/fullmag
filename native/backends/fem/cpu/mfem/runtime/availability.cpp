/*
 * Runtime availability source contract.
 *
 * This source owns native FEM CPU/GPU availability probes, lane reason strings,
 * CUDA visibility checks, and the public C availability ABI result. It does not initialize MFEM contexts, choose devices, manage GPU state, or execute solver steps.
 */

#include "cpu/mfem/runtime/availability.hpp"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr const char *kNativeBackendUnavailableMessage =
    "fullmag_fem native backend was built without the MFEM stack; rebuild with FULLMAG_USE_MFEM_STACK=ON and an installed MFEM toolchain";

std::optional<int> selected_cuda_device_from_env()
{
    const char *specific = std::getenv("FULLMAG_FEM_GPU_INDEX");
    const char *generic = std::getenv("FULLMAG_CUDA_DEVICE_INDEX");
    const char *raw = specific != nullptr ? specific : generic;
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0) {
        const char *var_name =
            (specific != nullptr) ? "FULLMAG_FEM_GPU_INDEX" : "FULLMAG_CUDA_DEVICE_INDEX";
        std::fprintf(
            stderr,
            "warning: ignoring invalid %s='%s' (expected non-negative integer)\n",
            var_name,
            raw);
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

bool env_flag(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr) {
        return false;
    }
    std::string value(raw);
    for (char &ch : value) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return value == "1" || value == "on" || value == "true" || value == "yes";
}

void set_reason(fullmag_fem_availability_info &info, const std::string &message)
{
    std::snprintf(info.reason, sizeof(info.reason), "%s", message.c_str());
}

void set_cpu_reason(fullmag_fem_availability_info &info, const std::string &message)
{
    std::snprintf(info.reason_cpu, sizeof(info.reason_cpu), "%s", message.c_str());
}

void set_gpu_reason(fullmag_fem_availability_info &info, const std::string &message)
{
    std::snprintf(info.reason_gpu, sizeof(info.reason_gpu), "%s", message.c_str());
}

void finalize_availability(fullmag_fem_availability_info &info)
{
    info.available_cpu = info.native_fem_cpu_available;
    info.available_gpu = info.native_fem_gpu_available;
    info.available_any = (info.available_cpu != 0 || info.available_gpu != 0) ? 1 : 0;
    info.available = info.available_any;

    if (info.available_cpu != 0 && info.available_gpu != 0) {
        set_reason(info, "native FEM CPU and GPU backends are available");
    } else if (info.available_cpu != 0) {
        std::string message = "native FEM CPU backend is available";
        if (info.reason_gpu[0] != '\0') {
            message += "; native FEM GPU backend is unavailable: ";
            message += info.reason_gpu;
        }
        set_reason(info, message);
    } else if (info.available_gpu != 0) {
        std::string message = "native FEM GPU backend is available";
        if (info.reason_cpu[0] != '\0') {
            message += "; native FEM CPU backend is unavailable: ";
            message += info.reason_cpu;
        }
        set_reason(info, message);
    } else if (info.reason_cpu[0] != '\0' && info.reason_gpu[0] != '\0') {
        std::string message = "native FEM CPU backend is unavailable: ";
        message += info.reason_cpu;
        message += "; native FEM GPU backend is unavailable: ";
        message += info.reason_gpu;
        set_reason(info, message);
    } else if (info.reason_gpu[0] != '\0') {
        set_reason(info, info.reason_gpu);
    } else if (info.reason_cpu[0] != '\0') {
        set_reason(info, info.reason_cpu);
    }
}

bool mfem_device_request_needs_ceed()
{
    const char *raw = std::getenv("FULLMAG_FEM_MFEM_DEVICE");
    return raw != nullptr && std::strncmp(raw, "ceed-", 5) == 0;
}

} // namespace

fullmag_fem_availability_info query_availability()
{
    fullmag_fem_availability_info info{};
    info.available = 0;
    info.requested_gpu_index = -1;
    info.resolved_gpu_index = -1;

#if FULLMAG_HAS_MFEM_STACK
    info.built_with_mfem_stack = 1;
    info.native_fem_cpu_available = 1;
    set_cpu_reason(info, "native FEM CPU backend is available (MFEM/hypre stack)");
#else
    set_cpu_reason(info, kNativeBackendUnavailableMessage);
    set_gpu_reason(info, kNativeBackendUnavailableMessage);
    finalize_availability(info);
    return info;
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
    info.built_with_cuda_runtime = 1;
#else
    set_gpu_reason(
        info,
        "fullmag_fem was built without CUDA runtime support");
    finalize_availability(info);
    return info;
#endif

#ifdef MFEM_USE_CEED
    info.built_with_ceed = 1;
#endif
    info.libceed_used_hot_path = 0;

#ifdef MFEM_USE_CUDA
    info.mfem_cuda_available = 1;
#endif

#if defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP)
    info.hypre_gpu_available = 1;
#endif

    if (!info.mfem_cuda_available) {
        set_gpu_reason(
            info,
            "native FEM GPU backend requires an MFEM build with CUDA device support");
        finalize_availability(info);
        return info;
    }

    if (mfem_device_request_needs_ceed() && !info.built_with_ceed) {
        set_gpu_reason(
            info,
            "FULLMAG_FEM_MFEM_DEVICE requests a CEED backend, but MFEM was built without libCEED support");
        finalize_availability(info);
        return info;
    }

    int device_count = 0;
#if FULLMAG_HAS_CUDA_RUNTIME
    const cudaError_t device_count_rc = cudaGetDeviceCount(&device_count);
    if (device_count_rc != cudaSuccess) {
        set_gpu_reason(
            info,
            std::string("cudaGetDeviceCount failed for fullmag_fem: ") +
                cudaGetErrorString(device_count_rc));
        finalize_availability(info);
        return info;
    }

    info.visible_cuda_device_count = device_count;
    if (device_count <= 0) {
        set_gpu_reason(info, "no CUDA devices are visible to the native FEM backend");
        finalize_availability(info);
        return info;
    }

    const auto selected = selected_cuda_device_from_env();
    if (selected.has_value()) {
        info.requested_gpu_index = *selected;
    }

    const int resolved_index = selected.value_or(0);
    if (resolved_index < 0 || resolved_index >= device_count) {
        set_gpu_reason(
            info,
            "requested FEM GPU device index is out of range for the visible CUDA device set");
        finalize_availability(info);
        return info;
    }
    info.resolved_gpu_index = resolved_index;

    int previous_index = -1;
    const cudaError_t get_device_rc = cudaGetDevice(&previous_index);
    if (get_device_rc != cudaSuccess) {
        set_gpu_reason(
            info,
            std::string("cudaGetDevice failed for fullmag_fem: ") +
                cudaGetErrorString(get_device_rc));
        finalize_availability(info);
        return info;
    }

    const cudaError_t set_device_rc = cudaSetDevice(resolved_index);
    if (set_device_rc != cudaSuccess) {
        set_gpu_reason(
            info,
            std::string("cudaSetDevice failed for fullmag_fem: ") +
                cudaGetErrorString(set_device_rc));
        finalize_availability(info);
        return info;
    }

    size_t memory_free_bytes = 0;
    size_t memory_total_bytes = 0;
    const cudaError_t memory_rc =
        cudaMemGetInfo(&memory_free_bytes, &memory_total_bytes);
    if (previous_index >= 0 && previous_index != resolved_index) {
        (void)cudaSetDevice(previous_index);
    }
    if (memory_rc != cudaSuccess) {
        set_gpu_reason(
            info,
            std::string("cudaMemGetInfo failed for fullmag_fem: ") +
                cudaGetErrorString(memory_rc));
        finalize_availability(info);
        return info;
    }
    info.gpu_memory_free_bytes = static_cast<uint64_t>(memory_free_bytes);
    info.gpu_memory_total_bytes = static_cast<uint64_t>(memory_total_bytes);
#endif

    if (env_flag("FULLMAG_FEM_REQUIRE_CEED") && !info.built_with_ceed) {
        set_gpu_reason(
            info,
            "FULLMAG_FEM_REQUIRE_CEED=1 requested a libCEED-enabled FEM runtime, but the detected MFEM stack has no libCEED support");
        finalize_availability(info);
        return info;
    }

    info.native_fem_gpu_available = 1;
    info.native_fem_gpu_full_demag_available =
        (info.mfem_cuda_available != 0 && info.hypre_gpu_available != 0) ? 1 : 0;
    if (!info.native_fem_gpu_full_demag_available) {
        set_gpu_reason(
            info,
            "native FEM GPU backend is available, but strict full-demag GPU requires hypre GPU support");
        finalize_availability(info);
        return info;
    }
    if (info.built_with_ceed) {
        set_gpu_reason(info, "native FEM GPU backend is available (MFEM + CUDA + libCEED)");
    } else {
        set_gpu_reason(
            info,
            "native FEM GPU backend is available in bootstrap mode (MFEM + CUDA, without libCEED)");
    }
    finalize_availability(info);
    return info;
}

} // namespace fullmag::fem
