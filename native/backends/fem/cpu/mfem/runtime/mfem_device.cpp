#include "cpu/mfem/runtime/mfem_device.hpp"

#include "context.hpp"

#include <cstdlib>
#include <cstring>

namespace fullmag::fem {

/*
 * MFEM device selection and CPU/GPU classification.
 *
 * This module is intentionally runtime-only: it must not define physics, finite
 * element operators, energy terms, or LLG semantics. Its responsibility is to
 * decide whether the native FEM/MFEM realization should initialize host CPU
 * resources or GPU-capable MFEM/CUDA resources.
 *
 * Default policy
 * --------------
 * The native FEM CPU path defaults to the MFEM "cpu" device. GPU execution must
 * be requested explicitly through the plan-level override or the
 * FULLMAG_FEM_MFEM_DEVICE environment variable. This keeps CPU availability
 * independent of CUDA visibility and matches the solver contract that CPU and
 * GPU are separate realizations of the same physical model.
 */

const char *configured_mfem_device_string() {
    const char *raw = std::getenv("FULLMAG_FEM_MFEM_DEVICE");
    if (raw != nullptr && *raw != '\0') {
        return raw;
    }
    return "cpu";
}

const char *configured_mfem_device_string(const Context &ctx) {
    if (!ctx.mfem_device_string_override.empty()) {
        return ctx.mfem_device_string_override.c_str();
    }
    return configured_mfem_device_string();
}

bool is_gpu_device_string(const char *device) {
    if (device == nullptr || *device == '\0') {
        return false;
    }
    if (std::strcmp(device, "cuda") == 0 ||
        std::strcmp(device, "hip") == 0 ||
        std::strncmp(device, "raja-cuda", 9) == 0 ||
        std::strncmp(device, "raja-hip", 8) == 0 ||
        std::strncmp(device, "occa-cuda", 9) == 0 ||
        std::strncmp(device, "ceed-cuda", 9) == 0 ||
        std::strncmp(device, "ceed/cuda", 9) == 0 ||
        std::strstr(device, "/gpu/") != nullptr) {
        return true;
    }
    if (std::strcmp(device, "cpu") == 0 ||
        std::strcmp(device, "omp") == 0 ||
        std::strncmp(device, "ceed-cpu", 8) == 0 ||
        std::strncmp(device, "ceed/cpu", 8) == 0 ||
        std::strncmp(device, "ceed-omp", 8) == 0 ||
        std::strncmp(device, "ceed/omp", 8) == 0 ||
        std::strncmp(device, "raja-omp", 8) == 0) {
        return false;
    }
    return true;
}

bool mfem_device_requests_gpu() {
    return is_gpu_device_string(configured_mfem_device_string());
}

bool mfem_device_requests_gpu(const Context &ctx) {
    return is_gpu_device_string(configured_mfem_device_string(ctx));
}

} // namespace fullmag::fem
