/*
 * MFEM device runtime source contract.
 *
 * This source owns MFEM device-string plan import, CPU/GPU classification,
 * device-info snapshots, and runtime MFEM device configuration. It does not allocate Context resources, bootstrap GPU state, execute steps, or own availability policy.
 */

#include "cpu/mfem/runtime/mfem_device.hpp"

#include "context.hpp"

#include <cstdlib>
#include <cstring>
#include <string>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

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

void initialize_mfem_device_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan)
{
    ctx.mfem_device.gpu_device_index = plan.gpu_device_index;
    ctx.mfem_device.device_string_override.clear();
    if (plan.mfem_device_string != nullptr && plan.mfem_device_string[0] != '\0') {
        ctx.mfem_device.device_string_override = plan.mfem_device_string;
    }
}

const char *configured_mfem_device_string() {
    const char *raw = std::getenv("FULLMAG_FEM_MFEM_DEVICE");
    if (raw != nullptr && *raw != '\0') {
        return raw;
    }
    return "cpu";
}

const char *configured_mfem_device_string(const Context &ctx) {
    if (!ctx.mfem_device.device_string_override.empty()) {
        return ctx.mfem_device.device_string_override.c_str();
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

void context_populate_device_info(Context &ctx) {
    std::memset(&ctx.mfem_device.device_info_cache, 0, sizeof(ctx.mfem_device.device_info_cache));
#if FULLMAG_HAS_MFEM_STACK
    // FND-007: backend name reflects the actual demag realization in use.
    // Phase-0D fix: use device-aware prefix instead of hard-coding "cuda".
    const char *mfem_dev = configured_mfem_device_string(ctx);
    const bool on_gpu = is_gpu_device_string(mfem_dev);
    const char *dev_tag = on_gpu ? "gpu" : "cpu";

    std::string backend_name;
    if (ctx.exchange.mfem.ready) {
        if (!ctx.enable_demag) {
            backend_name = std::string("mfem_") + dev_tag + "_exchange_ready";
        } else if (ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET) {
            backend_name = std::string("mfem_") + dev_tag + "_native_poisson_dirichlet_demag";
        } else if (ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN) {
            backend_name = std::string("mfem_") + dev_tag + "_native_poisson_robin_demag";
        } else if (ctx.demag_realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
            backend_name = std::string("mfem_") + dev_tag + "_native_fem_bem_demag";
        } else {
            backend_name = std::string("mfem_") + dev_tag + "_unknown_demag_realization";
        }
    } else if (ctx.mfem_ready) {
        backend_name = std::string("mfem_") + dev_tag + "_mesh_ready";
    } else {
        backend_name = "mfem_stack_uninitialized";
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.mfem_context.selected_device_index >= 0) {
        cudaDeviceProp props{};
        int driver_version = 0;
        int runtime_version = 0;
        if (cudaGetDeviceProperties(&props, ctx.mfem_context.selected_device_index) == cudaSuccess) {
            backend_name = std::string(props.name);
            ctx.mfem_device.device_info_cache.compute_capability_major = props.major;
            ctx.mfem_device.device_info_cache.compute_capability_minor = props.minor;
        }
        if (cudaDriverGetVersion(&driver_version) == cudaSuccess) {
            ctx.mfem_device.device_info_cache.driver_version = driver_version;
        }
        if (cudaRuntimeGetVersion(&runtime_version) == cudaSuccess) {
            ctx.mfem_device.device_info_cache.runtime_version = runtime_version;
        }
    }
#endif
    std::strncpy(
        ctx.mfem_device.device_info_cache.name,
        backend_name.c_str(),
        sizeof(ctx.mfem_device.device_info_cache.name) - 1);
    ctx.mfem_device.device_info_cache.is_gpu_enabled = on_gpu ? 1 : 0;
#else
    std::strncpy(
        ctx.mfem_device.device_info_cache.name,
        "native_fem_scaffold",
        sizeof(ctx.mfem_device.device_info_cache.name) - 1);
    ctx.mfem_device.device_info_cache.is_gpu_enabled = 0;
#endif
    ctx.mfem_device.device_info_valid = true;
}

fullmag_fem_device_info device_info_snapshot(const Context &ctx)
{
    return ctx.mfem_device.device_info_cache;
}

} // namespace fullmag::fem
