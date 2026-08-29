/*
 * context.cu — CUDA device memory management for the FDM backend.
 *
 * Handles allocation, upload, download of SoA device buffers.
 * AoS ↔ SoA conversion happens at the host/device boundary.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <vector>

namespace fullmag {
namespace fdm {

static uint64_t steady_clock_now_ns() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_exchange_field_fp32(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_anisotropy_field_fp64(Context &ctx);
extern void launch_anisotropy_field_fp32(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx, double evaluation_time);
extern void launch_effective_field_fp32(Context &ctx, double evaluation_time);
extern void launch_newell_compute_spectra_fp64(Context &ctx);
extern void launch_newell_compute_spectra_fp32(Context &ctx);
extern bool launch_multilayer_dmi_field_fp64(Context &ctx);
extern bool launch_multilayer_dmi_field_fp32(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp64(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp32(Context &ctx);
extern void launch_multilayer_exchange_field_fp64(Context &ctx);
extern void launch_multilayer_exchange_field_fp32(Context &ctx);
extern bool launch_multilayer_effective_field_fp64(Context &ctx);
extern bool launch_multilayer_effective_field_fp32(Context &ctx);
extern bool launch_energy_density_observable(
    Context &ctx,
    fullmag_fdm_observable observable);

cudaError_t fullmag_fdm_receipt_cuda_memcpy(
    Context &ctx,
    void *destination,
    const void *source,
    size_t bytes,
    cudaMemcpyKind kind)
{
    const cudaError_t status = ::cudaMemcpy(destination, source, bytes, kind);
    if (status == cudaSuccess) {
        if (kind == cudaMemcpyHostToDevice) {
            fullmag_fdm_record_cuda_transfer_success(ctx, true, bytes);
        } else if (kind == cudaMemcpyDeviceToHost) {
            fullmag_fdm_record_cuda_transfer_success(ctx, false, bytes);
        }
    }
    return status;
}

cudaError_t fullmag_fdm_receipt_cuda_memcpy_async(
    Context &ctx,
    void *destination,
    const void *source,
    size_t bytes,
    cudaMemcpyKind kind,
    cudaStream_t stream)
{
    const cudaError_t status =
        ::cudaMemcpyAsync(destination, source, bytes, kind, stream);
    if (status == cudaSuccess) {
        if (kind == cudaMemcpyHostToDevice) {
            fullmag_fdm_record_cuda_transfer_success(ctx, true, bytes);
        }
    }
    return status;
}

// Every host-boundary copy in this translation unit is routed through the
// allocation-free receipt hook. Device-internal copies are intentionally not
// classified as host transfers.
#define cudaMemcpy(destination, source, bytes, kind) \
    fullmag_fdm_receipt_cuda_memcpy( \
        const_cast<Context &>(ctx), destination, source, bytes, kind)
#define cudaMemcpyAsync(destination, source, bytes, kind, stream) \
    fullmag_fdm_receipt_cuda_memcpy_async( \
        const_cast<Context &>(ctx), destination, source, bytes, kind, stream)

static void free_boundary_correction(Context &ctx);
static void free_anisotropy_fields(Context &ctx);
static void free_cubic_anisotropy_fields(Context &ctx);
static bool launch_anisotropy_observable(Context &ctx);
static bool upload_f64_array(Context &ctx, double *&dst, const double *src,
                              uint64_t len, const char *label);

template <typename Scalar>
__global__ static void compose_visual_effective_field_kernel(
    const Scalar *work_x,
    const Scalar *work_y,
    const Scalar *work_z,
    const Scalar *demag_x,
    const Scalar *demag_y,
    const Scalar *demag_z,
    Scalar external_x,
    Scalar external_y,
    Scalar external_z,
    const uint8_t *active_mask,
    Scalar *visual_x,
    Scalar *visual_y,
    Scalar *visual_z,
    uint64_t cell_count,
    bool has_active_mask)
{
    const uint64_t index = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= cell_count) return;
    const bool active = !has_active_mask || active_mask[index] != 0;
    visual_x[index] = active ? work_x[index] : demag_x[index] + external_x;
    visual_y[index] = active ? work_y[index] : demag_y[index] + external_y;
    visual_z[index] = active ? work_z[index] : demag_z[index] + external_z;
}

static bool context_refresh_effective_field_visual(Context &ctx)
{
    if (ctx.h_eff_visual.x == nullptr || ctx.h_eff_visual.y == nullptr ||
        ctx.h_eff_visual.z == nullptr) {
        ctx.last_error = "effective_visual_buffer_unavailable";
        return false;
    }
    constexpr uint32_t threads = 256;
    const uint32_t blocks = static_cast<uint32_t>(
        (ctx.cell_count + threads - 1u) / threads);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        compose_visual_effective_field_kernel<double><<<blocks, threads>>>(
            static_cast<const double *>(ctx.work.x),
            static_cast<const double *>(ctx.work.y),
            static_cast<const double *>(ctx.work.z),
            static_cast<const double *>(ctx.h_demag_visual.x),
            static_cast<const double *>(ctx.h_demag_visual.y),
            static_cast<const double *>(ctx.h_demag_visual.z),
            static_cast<double>(ctx.has_external_field ? ctx.external_field[0] : 0.0),
            static_cast<double>(ctx.has_external_field ? ctx.external_field[1] : 0.0),
            static_cast<double>(ctx.has_external_field ? ctx.external_field[2] : 0.0),
            ctx.active_mask,
            static_cast<double *>(ctx.h_eff_visual.x),
            static_cast<double *>(ctx.h_eff_visual.y),
            static_cast<double *>(ctx.h_eff_visual.z),
            ctx.cell_count,
            ctx.has_active_mask);
    } else {
        compose_visual_effective_field_kernel<float><<<blocks, threads>>>(
            static_cast<const float *>(ctx.work.x),
            static_cast<const float *>(ctx.work.y),
            static_cast<const float *>(ctx.work.z),
            static_cast<const float *>(ctx.h_demag_visual.x),
            static_cast<const float *>(ctx.h_demag_visual.y),
            static_cast<const float *>(ctx.h_demag_visual.z),
            static_cast<float>(ctx.has_external_field ? ctx.external_field[0] : 0.0),
            static_cast<float>(ctx.has_external_field ? ctx.external_field[1] : 0.0),
            static_cast<float>(ctx.has_external_field ? ctx.external_field[2] : 0.0),
            ctx.active_mask,
            static_cast<float *>(ctx.h_eff_visual.x),
            static_cast<float *>(ctx.h_eff_visual.y),
            static_cast<float *>(ctx.h_eff_visual.z),
            ctx.cell_count,
            ctx.has_active_mask);
    }
    const cudaError_t error = cudaGetLastError();
    if (error != cudaSuccess) {
        set_cuda_error(ctx, "compose_visual_effective_field", error);
        return false;
    }
    return true;
}

/* ── Helper: element size based on precision ── */

static size_t scalar_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(float) : sizeof(double);
}

static size_t complex_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(cufftComplex) : sizeof(cufftDoubleComplex);
}

/* ── Allocate one SoA vector field (3 components) ── */

static bool alloc_vector_field(Context &ctx, DeviceVectorField &field) {
    size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaError_t err;

    err = cudaMalloc(&field.x, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(x)", err); return false; }

    err = cudaMalloc(&field.y, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(y)", err); return false; }

    err = cudaMalloc(&field.z, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(z)", err); return false; }

    return true;
}

static bool alloc_energy_density(Context &ctx) {
    const size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    const cudaError_t err = cudaMalloc(&ctx.energy_density, bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(energy_density)", err);
        return false;
    }
    return true;
}

static void free_energy_density(Context &ctx) {
    if (ctx.energy_density) {
        cudaFree(ctx.energy_density);
        ctx.energy_density = nullptr;
    }
}

static void free_vector_field(DeviceVectorField &field) {
    if (field.x) { cudaFree(field.x); field.x = nullptr; }
    if (field.y) { cudaFree(field.y); field.y = nullptr; }
    if (field.z) { cudaFree(field.z); field.z = nullptr; }
}

static void destroy_async_field_snapshot_pool_resources(AsyncFieldSnapshotPool &pool)
{
    for (auto &slot : pool.slots) {
        if (slot.done_event) {
            // Context teardown is the last owner of the pool.  Synchronize the
            // slot event rather than the whole device so an in-flight I/O
            // transfer cannot race resource destruction.
            cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(slot.done_event));
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.done_event));
            slot.done_event = nullptr;
        }
        if (slot.staging_done_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.staging_done_event));
            slot.staging_done_event = nullptr;
        }
        if (slot.ready_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.ready_event));
            slot.ready_event = nullptr;
        }
        if (slot.stream) {
            cudaStreamDestroy(reinterpret_cast<cudaStream_t>(slot.stream));
            slot.stream = nullptr;
        }
        if (slot.host_soa) {
            cudaFreeHost(slot.host_soa);
            slot.host_soa = nullptr;
        }
        free_vector_field(slot.staging);
    }
    pool.component_bytes = 0;
    pool.host_soa_bytes = 0;
    pool.cell_count = 0;
    __atomic_store_n(&pool.leased_slots, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&pool.retired_slots, 0u, __ATOMIC_RELEASE);
    pool.initialized = false;
}

bool initialize_async_field_snapshot_pool(Context &ctx)
{
    ctx.async_field_snapshot_pool = std::shared_ptr<AsyncFieldSnapshotPool>(
        new AsyncFieldSnapshotPool(),
        [](AsyncFieldSnapshotPool *pool) {
            destroy_async_field_snapshot_pool_resources(*pool);
            delete pool;
        });
    AsyncFieldSnapshotPool &pool = *ctx.async_field_snapshot_pool;
    pool.cell_count = ctx.cell_count;
    pool.component_bytes = ctx.cell_count * scalar_size(ctx.precision);
    pool.host_soa_bytes = pool.component_bytes * 3u;

    auto fail = [&](const char *label, cudaError_t error) -> bool {
        set_cuda_error(ctx, label, error);
        destroy_async_field_snapshot_pool_resources(pool);
        return false;
    };

    for (auto &slot : pool.slots) {
        cudaError_t error = cudaMalloc(&slot.staging.x, pool.component_bytes);
        if (error != cudaSuccess) return fail("cudaMalloc(async_snapshot_pool.x)", error);
        error = cudaMalloc(&slot.staging.y, pool.component_bytes);
        if (error != cudaSuccess) return fail("cudaMalloc(async_snapshot_pool.y)", error);
        error = cudaMalloc(&slot.staging.z, pool.component_bytes);
        if (error != cudaSuccess) return fail("cudaMalloc(async_snapshot_pool.z)", error);
        error = cudaHostAlloc(&slot.host_soa, pool.host_soa_bytes, cudaHostAllocDefault);
        if (error != cudaSuccess) return fail("cudaHostAlloc(async_snapshot_pool.host_soa)", error);

        cudaStream_t stream{};
        error = cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking);
        if (error != cudaSuccess) return fail("cudaStreamCreate(async_snapshot_pool)", error);
        slot.stream = reinterpret_cast<void *>(stream);

        cudaEvent_t ready_event{};
        error = cudaEventCreateWithFlags(&ready_event, cudaEventDisableTiming);
        if (error != cudaSuccess) return fail("cudaEventCreate(async_snapshot_pool.ready)", error);
        slot.ready_event = reinterpret_cast<void *>(ready_event);

        cudaEvent_t staging_done_event{};
        error = cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming);
        if (error != cudaSuccess) return fail("cudaEventCreate(async_snapshot_pool.staging_done)", error);
        slot.staging_done_event = reinterpret_cast<void *>(staging_done_event);

        cudaEvent_t done_event{};
        error = cudaEventCreateWithFlags(&done_event, cudaEventDisableTiming);
        if (error != cudaSuccess) return fail("cudaEventCreate(async_snapshot_pool.done)", error);
        slot.done_event = reinterpret_cast<void *>(done_event);
    }
    __atomic_store_n(&pool.leased_slots, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&pool.retired_slots, 0u, __ATOMIC_RELEASE);
    pool.initialized = true;
    return true;
}

void destroy_async_field_snapshot_pool(Context &ctx)
{
    ctx.async_field_snapshot_pool.reset();
}

bool acquire_async_field_snapshot_pool_slot(
    Context &ctx,
    std::size_t &slot_index,
    std::string &error)
{
    if (!ctx.async_field_snapshot_pool) {
        error = "fdm_async_snapshot_pool_uninitialized";
        return false;
    }
    AsyncFieldSnapshotPool &pool = *ctx.async_field_snapshot_pool;
    slot_index = kFdmAsyncFieldSnapshotPoolCapacity;
    if (!pool.initialized) {
        error = "fdm_async_snapshot_pool_uninitialized";
        return false;
    }

    for (std::size_t candidate = 0;
         candidate < kFdmAsyncFieldSnapshotPoolCapacity;
         ++candidate) {
        const uint32_t bit = uint32_t{1} << candidate;
        uint32_t leased = __atomic_load_n(&pool.leased_slots, __ATOMIC_ACQUIRE);
        if ((leased & bit) != 0) {
            const uint32_t retired = __atomic_load_n(&pool.retired_slots, __ATOMIC_ACQUIRE);
            if ((retired & bit) == 0 ||
                cudaEventQuery(reinterpret_cast<cudaEvent_t>(pool.slots[candidate].done_event)) !=
                    cudaSuccess) {
                continue;
            }
            // A caller released the handle before waiting.  Reclaim it only
            // after the completion event is observable, then retry the same
            // slot through the normal lease CAS.
            __atomic_fetch_and(&pool.retired_slots, ~bit, __ATOMIC_ACQ_REL);
            __atomic_fetch_and(&pool.leased_slots, ~bit, __ATOMIC_ACQ_REL);
            leased = __atomic_load_n(&pool.leased_slots, __ATOMIC_ACQUIRE);
        }
        if ((leased & bit) != 0) continue;
        if (__atomic_compare_exchange_n(
                &pool.leased_slots,
                &leased,
                leased | bit,
                true,
                __ATOMIC_ACQ_REL,
                __ATOMIC_ACQUIRE)) {
            slot_index = candidate;
            return true;
        }
    }

    error = "fdm_async_snapshot_pool_exhausted";
    return false;
}

void release_async_field_snapshot_pool_slot(
    AsyncFieldSnapshotPool &pool,
    std::size_t slot_index,
    bool work_complete)
{
    if (slot_index >= kFdmAsyncFieldSnapshotPoolCapacity) return;
    const uint32_t bit = uint32_t{1} << slot_index;
    if (work_complete) {
        __atomic_fetch_and(&pool.retired_slots, ~bit, __ATOMIC_ACQ_REL);
        __atomic_fetch_and(&pool.leased_slots, ~bit, __ATOMIC_ACQ_REL);
    } else {
        __atomic_fetch_or(&pool.retired_slots, bit, __ATOMIC_ACQ_REL);
    }
}

static void destroy_async_preview_snapshot_pool_resources(AsyncPreviewSnapshotPool &pool)
{
    for (auto &slot : pool.slots) {
        if (slot.done_event) {
            cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(slot.done_event));
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.done_event));
            slot.done_event = nullptr;
        }
        if (slot.staging_done_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.staging_done_event));
            slot.staging_done_event = nullptr;
        }
        if (slot.ready_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.ready_event));
            slot.ready_event = nullptr;
        }
        if (slot.stream) {
            cudaStreamDestroy(reinterpret_cast<cudaStream_t>(slot.stream));
            slot.stream = nullptr;
        }
        if (slot.host_xyz) {
            cudaFreeHost(slot.host_xyz);
            slot.host_xyz = nullptr;
        }
        if (slot.device_xyz) {
            cudaFree(slot.device_xyz);
            slot.device_xyz = nullptr;
        }
    }
    pool.xyz_bytes = 0;
    pool.max_preview_count = 0;
    __atomic_store_n(&pool.leased_slots, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&pool.retired_slots, 0u, __ATOMIC_RELEASE);
    pool.initialized = false;
}

bool initialize_async_preview_snapshot_pool(Context &ctx)
{
    ctx.async_preview_snapshot_pool = std::shared_ptr<AsyncPreviewSnapshotPool>(
        new AsyncPreviewSnapshotPool(),
        [](AsyncPreviewSnapshotPool *pool) {
            destroy_async_preview_snapshot_pool_resources(*pool);
            delete pool;
        });
    AsyncPreviewSnapshotPool &pool = *ctx.async_preview_snapshot_pool;
    pool.max_preview_count = ctx.cell_count;
    pool.xyz_bytes = pool.max_preview_count * 3u * scalar_size(ctx.precision);

    auto fail = [&](const char *label, cudaError_t error) -> bool {
        set_cuda_error(ctx, label, error);
        destroy_async_preview_snapshot_pool_resources(pool);
        return false;
    };

    for (auto &slot : pool.slots) {
        cudaError_t error = cudaMalloc(&slot.device_xyz, pool.xyz_bytes);
        if (error != cudaSuccess) return fail("cudaMalloc(async_preview_pool.device_xyz)", error);
        error = cudaHostAlloc(&slot.host_xyz, pool.xyz_bytes, cudaHostAllocDefault);
        if (error != cudaSuccess) return fail("cudaHostAlloc(async_preview_pool.host_xyz)", error);

        cudaStream_t stream{};
        error = cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking);
        if (error != cudaSuccess) return fail("cudaStreamCreate(async_preview_pool)", error);
        slot.stream = reinterpret_cast<void *>(stream);

        cudaEvent_t ready_event{};
        error = cudaEventCreateWithFlags(&ready_event, cudaEventDisableTiming);
        if (error != cudaSuccess) return fail("cudaEventCreate(async_preview_pool.ready)", error);
        slot.ready_event = reinterpret_cast<void *>(ready_event);

        cudaEvent_t staging_done_event{};
        error = cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming);
        if (error != cudaSuccess) {
            return fail("cudaEventCreate(async_preview_pool.staging_done)", error);
        }
        slot.staging_done_event = reinterpret_cast<void *>(staging_done_event);

        cudaEvent_t done_event{};
        error = cudaEventCreateWithFlags(&done_event, cudaEventDisableTiming);
        if (error != cudaSuccess) return fail("cudaEventCreate(async_preview_pool.done)", error);
        slot.done_event = reinterpret_cast<void *>(done_event);
    }
    __atomic_store_n(&pool.leased_slots, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&pool.retired_slots, 0u, __ATOMIC_RELEASE);
    pool.initialized = true;
    return true;
}

void destroy_async_preview_snapshot_pool(Context &ctx)
{
    ctx.async_preview_snapshot_pool.reset();
}

bool acquire_async_preview_snapshot_pool_slot(
    Context &ctx,
    uint64_t preview_count,
    std::size_t &slot_index,
    std::string &error)
{
    if (!ctx.async_preview_snapshot_pool) {
        error = "fdm_async_preview_snapshot_pool_uninitialized";
        return false;
    }
    AsyncPreviewSnapshotPool &pool = *ctx.async_preview_snapshot_pool;
    slot_index = kFdmAsyncPreviewSnapshotPoolCapacity;
    if (!pool.initialized) {
        error = "fdm_async_preview_snapshot_pool_uninitialized";
        return false;
    }
    if (preview_count > pool.max_preview_count) {
        error = "fdm_async_preview_snapshot_capacity_exceeded";
        return false;
    }

    for (std::size_t candidate = 0;
         candidate < kFdmAsyncPreviewSnapshotPoolCapacity;
         ++candidate) {
        const uint32_t bit = uint32_t{1} << candidate;
        uint32_t leased = __atomic_load_n(&pool.leased_slots, __ATOMIC_ACQUIRE);
        if ((leased & bit) != 0) {
            const uint32_t retired = __atomic_load_n(&pool.retired_slots, __ATOMIC_ACQUIRE);
            if ((retired & bit) == 0 ||
                cudaEventQuery(reinterpret_cast<cudaEvent_t>(pool.slots[candidate].done_event)) !=
                    cudaSuccess) {
                continue;
            }
            __atomic_fetch_and(&pool.retired_slots, ~bit, __ATOMIC_ACQ_REL);
            __atomic_fetch_and(&pool.leased_slots, ~bit, __ATOMIC_ACQ_REL);
            leased = __atomic_load_n(&pool.leased_slots, __ATOMIC_ACQUIRE);
        }
        if ((leased & bit) != 0) continue;
        if (__atomic_compare_exchange_n(
                &pool.leased_slots,
                &leased,
                leased | bit,
                true,
                __ATOMIC_ACQ_REL,
                __ATOMIC_ACQUIRE)) {
            slot_index = candidate;
            return true;
        }
    }

    error = "fdm_async_preview_snapshot_pool_exhausted";
    return false;
}

void release_async_preview_snapshot_pool_slot(
    AsyncPreviewSnapshotPool &pool,
    std::size_t slot_index,
    bool work_complete)
{
    if (slot_index >= kFdmAsyncPreviewSnapshotPoolCapacity) return;
    const uint32_t bit = uint32_t{1} << slot_index;
    if (work_complete) {
        __atomic_fetch_and(&pool.retired_slots, ~bit, __ATOMIC_ACQ_REL);
        __atomic_fetch_and(&pool.leased_slots, ~bit, __ATOMIC_ACQ_REL);
    } else {
        __atomic_fetch_or(&pool.retired_slots, bit, __ATOMIC_ACQ_REL);
    }
}

static bool alloc_demag_kernel(Context &ctx) {
    if (!ctx.enable_demag) {
        return true;
    }
    size_t bytes = ctx.fft_cell_count * complex_size(ctx.precision);
    cudaError_t err = cudaMalloc(&ctx.demag_kernel.xx, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_xx)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.yy, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_yy)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.zz, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_zz)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.xy, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_xy)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.xz, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_xz)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.yz, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_yz)", err); return false; }
    return true;
}

static void free_demag_kernel(Context &ctx) {
    if (ctx.demag_kernel.xx) { cudaFree(ctx.demag_kernel.xx); ctx.demag_kernel.xx = nullptr; }
    if (ctx.demag_kernel.yy) { cudaFree(ctx.demag_kernel.yy); ctx.demag_kernel.yy = nullptr; }
    if (ctx.demag_kernel.zz) { cudaFree(ctx.demag_kernel.zz); ctx.demag_kernel.zz = nullptr; }
    if (ctx.demag_kernel.xy) { cudaFree(ctx.demag_kernel.xy); ctx.demag_kernel.xy = nullptr; }
    if (ctx.demag_kernel.xz) { cudaFree(ctx.demag_kernel.xz); ctx.demag_kernel.xz = nullptr; }
    if (ctx.demag_kernel.yz) { cudaFree(ctx.demag_kernel.yz); ctx.demag_kernel.yz = nullptr; }
}

static uint64_t grid_cell_count(const fullmag_fdm_grid_desc &grid) {
    return static_cast<uint64_t>(grid.nx) * grid.ny * grid.nz;
}

static bool alloc_vector_field_cells(
    Context &ctx,
    DeviceVectorField &field,
    uint64_t cell_count,
    const char *label)
{
    size_t bytes = cell_count * scalar_size(ctx.precision);
    auto alloc_component = [&](void **dst, const char *component) -> bool {
        cudaError_t err = cudaMalloc(dst, bytes);
        if (err != cudaSuccess) {
            std::string name = std::string(label) + "." + component;
            set_cuda_error(ctx, name.c_str(), err);
            return false;
        }
        return true;
    };
    return alloc_component(&field.x, "x") &&
        alloc_component(&field.y, "y") &&
        alloc_component(&field.z, "z");
}

static bool upload_vector_field_aos_f64(
    Context &ctx,
    DeviceVectorField &dst,
    const double *src_xyz,
    uint64_t cell_count,
    const char *label)
{
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(cell_count), hy(cell_count), hz(cell_count);
        for (uint64_t i = 0; i < cell_count; ++i) {
            hx[i] = src_xyz[i * 3 + 0];
            hy[i] = src_xyz[i * 3 + 1];
            hz[i] = src_xyz[i * 3 + 2];
        }
        const size_t bytes = cell_count * sizeof(double);
        cudaError_t err = cudaMemcpy(dst.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".x").c_str(), err); return false; }
        err = cudaMemcpy(dst.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".y").c_str(), err); return false; }
        err = cudaMemcpy(dst.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".z").c_str(), err); return false; }
        return true;
    }

    std::vector<float> hx(cell_count), hy(cell_count), hz(cell_count);
    for (uint64_t i = 0; i < cell_count; ++i) {
        hx[i] = static_cast<float>(src_xyz[i * 3 + 0]);
        hy[i] = static_cast<float>(src_xyz[i * 3 + 1]);
        hz[i] = static_cast<float>(src_xyz[i * 3 + 2]);
    }
    const size_t bytes = cell_count * sizeof(float);
    cudaError_t err = cudaMemcpy(dst.x, hx.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".x").c_str(), err); return false; }
    err = cudaMemcpy(dst.y, hy.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".y").c_str(), err); return false; }
    err = cudaMemcpy(dst.z, hz.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".z").c_str(), err); return false; }
    return true;
}

/*
 * Keep cell-wise static profiles independent from the Oersted role.  The
 * legacy descriptor predates static H_ext and the two roles currently share
 * the device allocation, but they must never share the enable flag or the
 * descriptor pointer.  This helper owns the allocation/upload boundary for
 * both roles; the caller decides which semantic role is enabled.
 */
static bool upload_cell_profile(
    Context &ctx,
    const double *field_xyz,
    uint64_t len,
    const char *label)
{
    const uint64_t expected_len = ctx.cell_count * 3u;
    if (!field_xyz || len != expected_len) {
        ctx.last_error = std::string(label) + " length mismatch";
        return false;
    }
    for (uint64_t i = 0; i < len; ++i) {
        if (!std::isfinite(field_xyz[i])) {
            ctx.last_error = std::string(label) + " contains non-finite values";
            return false;
        }
    }

    const bool allocated = ctx.h_oe_static.x != nullptr
        && ctx.h_oe_static.y != nullptr
        && ctx.h_oe_static.z != nullptr;
    if (!allocated) {
        free_vector_field(ctx.h_oe_static);
        if (!alloc_vector_field(ctx, ctx.h_oe_static)) {
            return false;
        }
    }
    return upload_vector_field_aos_f64(
        ctx,
        ctx.h_oe_static,
        field_xyz,
        ctx.cell_count,
        label);
}

template <typename HostScalar>
static bool upload_vector_field_aos_host(
    Context &ctx,
    DeviceVectorField &dst,
    const HostScalar *src_xyz,
    uint64_t cell_count,
    const char *label)
{
    if (!src_xyz) {
        ctx.last_error = std::string(label) + " source is null";
        return false;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(cell_count), hy(cell_count), hz(cell_count);
        for (uint64_t i = 0; i < cell_count; ++i) {
            hx[i] = static_cast<double>(src_xyz[i * 3 + 0]);
            hy[i] = static_cast<double>(src_xyz[i * 3 + 1]);
            hz[i] = static_cast<double>(src_xyz[i * 3 + 2]);
        }
        const size_t bytes = cell_count * sizeof(double);
        cudaError_t err = cudaMemcpy(dst.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".x").c_str(), err); return false; }
        err = cudaMemcpy(dst.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".y").c_str(), err); return false; }
        err = cudaMemcpy(dst.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".z").c_str(), err); return false; }
        return true;
    }

    std::vector<float> hx(cell_count), hy(cell_count), hz(cell_count);
    for (uint64_t i = 0; i < cell_count; ++i) {
        hx[i] = static_cast<float>(src_xyz[i * 3 + 0]);
        hy[i] = static_cast<float>(src_xyz[i * 3 + 1]);
        hz[i] = static_cast<float>(src_xyz[i * 3 + 2]);
    }
    const size_t bytes = cell_count * sizeof(float);
    cudaError_t err = cudaMemcpy(dst.x, hx.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".x").c_str(), err); return false; }
    err = cudaMemcpy(dst.y, hy.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".y").c_str(), err); return false; }
    err = cudaMemcpy(dst.z, hz.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".z").c_str(), err); return false; }
    return true;
}

static bool alloc_tensor_kernel_cells(
    Context &ctx,
    DeviceDemagKernel &kernel,
    uint64_t cell_count,
    const char *label)
{
    const size_t bytes = cell_count * complex_size(ctx.precision);
    auto alloc_component = [&](void **dst, const char *component) -> bool {
        cudaError_t err = cudaMalloc(dst, bytes);
        if (err != cudaSuccess) {
            std::string name = std::string(label) + "." + component;
            set_cuda_error(ctx, name.c_str(), err);
            return false;
        }
        return true;
    };
    return alloc_component(&kernel.xx, "xx") &&
        alloc_component(&kernel.yy, "yy") &&
        alloc_component(&kernel.zz, "zz") &&
        alloc_component(&kernel.xy, "xy") &&
        alloc_component(&kernel.xz, "xz") &&
        alloc_component(&kernel.yz, "yz");
}

static void free_device_demag_kernel(DeviceDemagKernel &kernel) {
    if (kernel.xx) { cudaFree(kernel.xx); kernel.xx = nullptr; }
    if (kernel.yy) { cudaFree(kernel.yy); kernel.yy = nullptr; }
    if (kernel.zz) { cudaFree(kernel.zz); kernel.zz = nullptr; }
    if (kernel.xy) { cudaFree(kernel.xy); kernel.xy = nullptr; }
    if (kernel.xz) { cudaFree(kernel.xz); kernel.xz = nullptr; }
    if (kernel.yz) { cudaFree(kernel.yz); kernel.yz = nullptr; }
}

static void free_device_push_map(DeviceMultilayerPushMap &map) {
    if (map.offsets) {
        cudaFree(map.offsets);
        map.offsets = nullptr;
    }
    if (map.indices) {
        cudaFree(map.indices);
        map.indices = nullptr;
    }
    if (map.weights) {
        cudaFree(map.weights);
        map.weights = nullptr;
    }
    map.cell_count = 0;
    map.entry_count = 0;
}

static void free_device_pull_map(DeviceMultilayerPullMap &map) {
    if (map.indices) {
        cudaFree(map.indices);
        map.indices = nullptr;
    }
    if (map.weights) {
        cudaFree(map.weights);
        map.weights = nullptr;
    }
    map.cell_count = 0;
}

static void unbind_multilayer_fft_workspace(Context &ctx) {
    if (!ctx.fft_workspace_bound_to_multilayer_cache) {
        return;
    }
    ctx.fft_nx = 0;
    ctx.fft_ny = 0;
    ctx.fft_nz = 0;
    ctx.fft_cell_count = 0;
    ctx.fft_component_stride = 0;
    ctx.fft_x = nullptr;
    ctx.fft_y = nullptr;
    ctx.fft_z = nullptr;
    ctx.fft_work_area = nullptr;
    ctx.fft_work_area_bytes = 0;
    ctx.fft_plan = 0;
    ctx.fft_plan_valid = false;
    ctx.fft_components_share_allocation = false;
    ctx.fft_workspace_bound_to_multilayer_cache = false;
}

static void free_multilayer_fft_workspace(DeviceMultilayerFftWorkspace &workspace) {
    if (workspace.plan_valid) {
        cufftDestroy(workspace.plan);
        workspace.plan = 0;
        workspace.plan_valid = false;
    }
    if (workspace.work_area) {
        cudaFree(workspace.work_area);
        workspace.work_area = nullptr;
    }
    workspace.work_area_bytes = 0;
    if (workspace.components_share_allocation) {
        if (workspace.fft_x) { cudaFree(workspace.fft_x); }
        workspace.fft_x = nullptr;
        workspace.fft_y = nullptr;
        workspace.fft_z = nullptr;
    } else {
        if (workspace.fft_x) { cudaFree(workspace.fft_x); workspace.fft_x = nullptr; }
        if (workspace.fft_y) { cudaFree(workspace.fft_y); workspace.fft_y = nullptr; }
        if (workspace.fft_z) { cudaFree(workspace.fft_z); workspace.fft_z = nullptr; }
    }
    workspace.cell_count = 0;
    workspace.component_stride = 0;
    workspace.components_share_allocation = false;
}

static void free_multilayer_batch_fft_buffers(Context &ctx) {
    if (ctx.multilayer_batch_components_share_allocation) {
        if (ctx.multilayer_batch_source_fft_x) {
            cudaFree(ctx.multilayer_batch_source_fft_x);
        }
        if (ctx.multilayer_batch_destination_fft_x) {
            cudaFree(ctx.multilayer_batch_destination_fft_x);
        }
    } else {
        if (ctx.multilayer_batch_source_fft_x) cudaFree(ctx.multilayer_batch_source_fft_x);
        if (ctx.multilayer_batch_source_fft_y) cudaFree(ctx.multilayer_batch_source_fft_y);
        if (ctx.multilayer_batch_source_fft_z) cudaFree(ctx.multilayer_batch_source_fft_z);
        if (ctx.multilayer_batch_destination_fft_x) cudaFree(ctx.multilayer_batch_destination_fft_x);
        if (ctx.multilayer_batch_destination_fft_y) cudaFree(ctx.multilayer_batch_destination_fft_y);
        if (ctx.multilayer_batch_destination_fft_z) cudaFree(ctx.multilayer_batch_destination_fft_z);
    }
    ctx.multilayer_batch_source_fft_x = nullptr;
    ctx.multilayer_batch_source_fft_y = nullptr;
    ctx.multilayer_batch_source_fft_z = nullptr;
    ctx.multilayer_batch_destination_fft_x = nullptr;
    ctx.multilayer_batch_destination_fft_y = nullptr;
    ctx.multilayer_batch_destination_fft_z = nullptr;
    ctx.multilayer_batch_component_stride = 0;
    ctx.multilayer_batch_layer_stride = 0;
    ctx.multilayer_batch_layer_count = 0;
    ctx.multilayer_batch_components_share_allocation = false;
}

static void free_multilayer_fft_workspaces(Context &ctx) {
    unbind_multilayer_fft_workspace(ctx);
    free_multilayer_batch_fft_buffers(ctx);
    for (DeviceMultilayerFftWorkspace &workspace : ctx.multilayer_fft_workspaces) {
        free_multilayer_fft_workspace(workspace);
    }
    ctx.multilayer_fft_workspaces.clear();
}

static uint64_t flatten_grid_index(uint32_t x, uint32_t y, uint32_t z, const fullmag_fdm_grid_desc &grid) {
    return (static_cast<uint64_t>(z) * grid.ny + y) * grid.nx + x;
}

static uint64_t clamp_grid_index(int64_t value, uint32_t upper) {
    if (value < 0) return 0;
    const uint64_t last = upper > 0 ? static_cast<uint64_t>(upper - 1) : 0;
    const uint64_t as_u64 = static_cast<uint64_t>(value);
    return as_u64 > last ? last : as_u64;
}

static bool upload_u64_array(
    Context &ctx,
    uint64_t *&dst,
    const std::vector<uint64_t> &src,
    const char *label)
{
    if (src.empty()) {
        return true;
    }
    cudaError_t err = cudaMalloc(
        reinterpret_cast<void **>(&dst),
        src.size() * sizeof(uint64_t));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    err = cudaMemcpy(dst, src.data(), src.size() * sizeof(uint64_t), cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

static bool upload_f64_vector(
    Context &ctx,
    double *&dst,
    const std::vector<double> &src,
    const char *label)
{
    if (src.empty()) {
        return true;
    }
    cudaError_t err = cudaMalloc(
        reinterpret_cast<void **>(&dst),
        src.size() * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    err = cudaMemcpy(dst, src.data(), src.size() * sizeof(double), cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

static void build_push_map_host(
    const fullmag_fdm_grid_desc &native_grid,
    const fullmag_fdm_grid_desc &convolution_grid,
    std::vector<uint64_t> &offsets,
    std::vector<uint64_t> &indices,
    std::vector<double> &weights)
{
    const uint64_t conv_cells = grid_cell_count(convolution_grid);
    offsets.assign(conv_cells + 1, 0);
    indices.clear();
    weights.clear();

    for (uint32_t cz = 0; cz < convolution_grid.nz; ++cz) {
        for (uint32_t cy = 0; cy < convolution_grid.ny; ++cy) {
            for (uint32_t cx = 0; cx < convolution_grid.nx; ++cx) {
                const uint64_t conv_idx = flatten_grid_index(cx, cy, cz, convolution_grid);
                offsets[conv_idx] = indices.size();

                const double c_lo_x = static_cast<double>(cx) * convolution_grid.dx;
                const double c_lo_y = static_cast<double>(cy) * convolution_grid.dy;
                const double c_lo_z = static_cast<double>(cz) * convolution_grid.dz;
                const double c_hi_x = c_lo_x + convolution_grid.dx;
                const double c_hi_y = c_lo_y + convolution_grid.dy;
                const double c_hi_z = c_lo_z + convolution_grid.dz;

                const int64_t nx_lo = static_cast<int64_t>(std::floor(c_lo_x / native_grid.dx));
                const int64_t nx_hi = static_cast<int64_t>(std::ceil(c_hi_x / native_grid.dx));
                const int64_t ny_lo = static_cast<int64_t>(std::floor(c_lo_y / native_grid.dy));
                const int64_t ny_hi = static_cast<int64_t>(std::ceil(c_hi_y / native_grid.dy));
                const int64_t nz_lo = static_cast<int64_t>(std::floor(c_lo_z / native_grid.dz));
                const int64_t nz_hi = static_cast<int64_t>(std::ceil(c_hi_z / native_grid.dz));

                for (int64_t nz = nz_lo; nz < nz_hi; ++nz) {
                    if (nz < 0 || nz >= static_cast<int64_t>(native_grid.nz)) continue;
                    const double n_lo_z = static_cast<double>(nz) * native_grid.dz;
                    const double n_hi_z = n_lo_z + native_grid.dz;
                    const double oz = std::max(0.0, std::min(c_hi_z, n_hi_z) - std::max(c_lo_z, n_lo_z));
                    if (oz <= 0.0) continue;
                    for (int64_t ny = ny_lo; ny < ny_hi; ++ny) {
                        if (ny < 0 || ny >= static_cast<int64_t>(native_grid.ny)) continue;
                        const double n_lo_y = static_cast<double>(ny) * native_grid.dy;
                        const double n_hi_y = n_lo_y + native_grid.dy;
                        const double oy = std::max(0.0, std::min(c_hi_y, n_hi_y) - std::max(c_lo_y, n_lo_y));
                        if (oy <= 0.0) continue;
                        for (int64_t nx = nx_lo; nx < nx_hi; ++nx) {
                            if (nx < 0 || nx >= static_cast<int64_t>(native_grid.nx)) continue;
                            const double n_lo_x = static_cast<double>(nx) * native_grid.dx;
                            const double n_hi_x = n_lo_x + native_grid.dx;
                            const double ox = std::max(0.0, std::min(c_hi_x, n_hi_x) - std::max(c_lo_x, n_lo_x));
                            if (ox <= 0.0) continue;

                            indices.push_back(flatten_grid_index(
                                static_cast<uint32_t>(nx),
                                static_cast<uint32_t>(ny),
                                static_cast<uint32_t>(nz),
                                native_grid));
                            weights.push_back(ox * oy * oz);
                        }
                    }
                }
            }
        }
    }
    offsets[conv_cells] = indices.size();
}

static void build_pull_map_host(
    const fullmag_fdm_grid_desc &native_grid,
    const fullmag_fdm_grid_desc &convolution_grid,
    const fullmag_fdm_grid_desc &fft_grid,
    std::vector<uint64_t> &indices,
    std::vector<double> &weights)
{
    const uint64_t native_cells = grid_cell_count(native_grid);
    indices.assign(native_cells * 8, 0);
    weights.assign(native_cells * 8, 0.0);

    for (uint32_t nz = 0; nz < native_grid.nz; ++nz) {
        for (uint32_t ny = 0; ny < native_grid.ny; ++ny) {
            for (uint32_t nx = 0; nx < native_grid.nx; ++nx) {
                const uint64_t native_idx = flatten_grid_index(nx, ny, nz, native_grid);
                const double fx = ((static_cast<double>(nx) + 0.5) * native_grid.dx) / convolution_grid.dx - 0.5;
                const double fy = ((static_cast<double>(ny) + 0.5) * native_grid.dy) / convolution_grid.dy - 0.5;
                const double fz = ((static_cast<double>(nz) + 0.5) * native_grid.dz) / convolution_grid.dz - 0.5;

                const double x_floor = std::floor(fx);
                const double y_floor = std::floor(fy);
                const double z_floor = std::floor(fz);
                const int64_t x0 = static_cast<int64_t>(x_floor);
                const int64_t y0 = static_cast<int64_t>(y_floor);
                const int64_t z0 = static_cast<int64_t>(z_floor);
                const double wx = fx - x_floor;
                const double wy = fy - y_floor;
                const double wz = fz - z_floor;

                uint64_t corner = 0;
                for (int dz = 0; dz < 2; ++dz) {
                    const uint32_t iz = static_cast<uint32_t>(clamp_grid_index(z0 + dz, convolution_grid.nz));
                    const double wz_i = dz == 0 ? 1.0 - wz : wz;
                    for (int dy = 0; dy < 2; ++dy) {
                        const uint32_t iy = static_cast<uint32_t>(clamp_grid_index(y0 + dy, convolution_grid.ny));
                        const double wy_i = dy == 0 ? 1.0 - wy : wy;
                        for (int dx = 0; dx < 2; ++dx) {
                            const uint32_t ix = static_cast<uint32_t>(clamp_grid_index(x0 + dx, convolution_grid.nx));
                            const double wx_i = dx == 0 ? 1.0 - wx : wx;
                            const uint64_t dst = native_idx * 8 + corner;
                            indices[dst] = flatten_grid_index(ix, iy, iz, fft_grid);
                            weights[dst] = wx_i * wy_i * wz_i;
                            ++corner;
                        }
                    }
                }
            }
        }
    }
}

static bool build_and_upload_push_map(
    Context &ctx,
    DeviceMultilayerLayer &layer)
{
    if (layer.transfer_kind != FULLMAG_FDM_TRANSFER_PUSH_PULL) {
        return true;
    }

    std::vector<uint64_t> push_offsets;
    std::vector<uint64_t> push_indices;
    std::vector<double> push_weights;
    build_push_map_host(
        layer.native_grid,
        layer.convolution_grid,
        push_offsets,
        push_indices,
        push_weights);

    layer.push_map.cell_count = layer.convolution_cell_count;
    layer.push_map.entry_count = push_indices.size();
    if (!upload_u64_array(ctx, layer.push_map.offsets, push_offsets, "cudaMemcpy(multilayer_push_map_offsets)") ||
        !upload_u64_array(ctx, layer.push_map.indices, push_indices, "cudaMemcpy(multilayer_push_map_indices)") ||
        !upload_f64_vector(ctx, layer.push_map.weights, push_weights, "cudaMemcpy(multilayer_push_map_weights)"))
    {
        return false;
    }

    return true;
}

static bool build_and_upload_kernel_pull_map(
    Context &ctx,
    DeviceMultilayerTensorKernel &kernel,
    const DeviceMultilayerLayer &dst_layer)
{
    if (dst_layer.transfer_kind != FULLMAG_FDM_TRANSFER_PUSH_PULL) {
        return true;
    }

    std::vector<uint64_t> pull_indices;
    std::vector<double> pull_weights;
    build_pull_map_host(
        dst_layer.native_grid,
        dst_layer.convolution_grid,
        kernel.fft_grid,
        pull_indices,
        pull_weights);

    kernel.dst_pull_map.cell_count = dst_layer.cell_count;
    return upload_u64_array(
            ctx,
            kernel.dst_pull_map.indices,
            pull_indices,
            "cudaMemcpy(multilayer_pull_map_indices)") &&
        upload_f64_vector(
            ctx,
            kernel.dst_pull_map.weights,
            pull_weights,
            "cudaMemcpy(multilayer_pull_map_weights)");
}

static bool upload_tensor_kernel_component(
    Context &ctx,
    void *dst,
    const fullmag_fdm_complex64 *src,
    uint64_t len,
    const char *label)
{
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<cufftDoubleComplex> values(len);
        for (uint64_t i = 0; i < len; ++i) {
            values[i].x = src[i].re;
            values[i].y = src[i].im;
        }
        cudaError_t err = cudaMemcpy(
            dst,
            values.data(),
            len * sizeof(cufftDoubleComplex),
            cudaMemcpyHostToDevice);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, label, err);
            return false;
        }
        return true;
    }

    std::vector<cufftComplex> values(len);
    for (uint64_t i = 0; i < len; ++i) {
        values[i].x = static_cast<float>(src[i].re);
        values[i].y = static_cast<float>(src[i].im);
    }
    cudaError_t err = cudaMemcpy(
        dst,
        values.data(),
        len * sizeof(cufftComplex),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

static void free_multilayer_plan_v2(Context &ctx) {
    free_multilayer_fft_workspaces(ctx);
    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        free_vector_field(layer.m);
        free_vector_field(layer.h_ex);
        free_vector_field(layer.h_demag);
        free_vector_field(layer.h_dmi);
        free_vector_field(layer.h_ani);
        free_vector_field(layer.tmp);
        free_vector_field(layer.k1);
        free_vector_field(layer.k2);
        free_vector_field(layer.k3);
        free_vector_field(layer.k4);
        free_device_push_map(layer.push_map);
        if (layer.active_mask) {
            cudaFree(layer.active_mask);
            layer.active_mask = nullptr;
        }
    }
    for (DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
        free_device_demag_kernel(kernel.tensor);
        free_device_pull_map(kernel.dst_pull_map);
    }
    ctx.multilayer_layers.clear();
    ctx.multilayer_kernels.clear();
    ctx.has_multilayer_plan_v2 = false;
}

static bool alloc_active_mask(Context &ctx) {
    if (!ctx.has_active_mask) {
        return true;
    }
    size_t bytes = ctx.cell_count * sizeof(uint8_t);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.active_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(active_mask)", err);
        return false;
    }
    return true;
}

static void free_active_mask(Context &ctx) {
    if (ctx.active_mask) {
        cudaFree(ctx.active_mask);
        ctx.active_mask = nullptr;
    }
}

static bool alloc_frozen_mask(Context &ctx) {
    if (!ctx.has_frozen_mask) {
        return true;
    }
    const size_t bytes = ctx.cell_count * sizeof(uint8_t);
    const cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.frozen_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(frozen_mask)", err);
        return false;
    }
    return true;
}

static void free_frozen_mask(Context &ctx) {
    if (ctx.frozen_mask) {
        cudaFree(ctx.frozen_mask);
        ctx.frozen_mask = nullptr;
    }
    ctx.frozen_cell_count = 0;
}

static bool alloc_sot_active_mask(Context &ctx) {
    if (!ctx.has_sot_active_mask) {
        return true;
    }
    const size_t bytes = ctx.cell_count * sizeof(uint8_t);
    const cudaError_t err =
        cudaMalloc(reinterpret_cast<void **>(&ctx.sot_active_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(sot_active_mask)", err);
        return false;
    }
    return true;
}

static void free_sot_active_mask(Context &ctx) {
    if (ctx.sot_active_mask) {
        cudaFree(ctx.sot_active_mask);
        ctx.sot_active_mask = nullptr;
    }
}

static bool alloc_slonczewski_active_mask(Context &ctx) {
    if (!ctx.has_slonczewski_active_mask) {
        return true;
    }
    const size_t bytes = ctx.cell_count * sizeof(uint8_t);
    const cudaError_t err =
        cudaMalloc(reinterpret_cast<void **>(&ctx.slonczewski_active_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(slonczewski_active_mask)", err);
        return false;
    }
    return true;
}

static void free_slonczewski_active_mask(Context &ctx) {
    if (ctx.slonczewski_active_mask) {
        cudaFree(ctx.slonczewski_active_mask);
        ctx.slonczewski_active_mask = nullptr;
    }
}

static bool alloc_region_mask(Context &ctx) {
    if (!ctx.has_region_mask) {
        return true;
    }
    size_t bytes = ctx.cell_count * sizeof(uint32_t);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.region_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(region_mask)", err);
        return false;
    }
    return true;
}

static void free_region_mask(Context &ctx) {
    if (ctx.region_mask) {
        cudaFree(ctx.region_mask);
        ctx.region_mask = nullptr;
    }
}

static bool alloc_exchange_lut(Context &ctx) {
    if (!ctx.has_exchange_lut) {
        return true;
    }
    constexpr uint64_t N = FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
    size_t bytes = N * N * sizeof(double);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.exchange_lut), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(exchange_lut)", err);
        return false;
    }
    return true;
}

static void free_exchange_lut(Context &ctx) {
    if (ctx.exchange_lut) {
        cudaFree(ctx.exchange_lut);
        ctx.exchange_lut = nullptr;
    }
}

static bool alloc_reduction_scratch(Context &ctx) {
    const uint64_t adaptive_metric_blocks =
        (ctx.cell_count + 255ULL) / 256ULL;
    const uint64_t scratch_len = std::max<uint64_t>(
        ctx.cell_count,
        uint64_t{3} * adaptive_metric_blocks);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.reduction_scratch),
        scratch_len * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(reduction_scratch)", err);
        return false;
    }
    ctx.reduction_scratch_len = scratch_len;
    err = cudaMalloc(reinterpret_cast<void **>(&ctx.reduction_scratch_aux),
        scratch_len * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(reduction_scratch_aux)", err);
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    ctx.reduction_scratch_aux_len = scratch_len;
    err = cudaMalloc(reinterpret_cast<void **>(&ctx.adaptive_policy_scratch),
        sizeof(AdaptiveDeviceControl));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(adaptive_policy_scratch)", err);
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
        ctx.reduction_scratch_aux_len = 0;
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    err = cudaMalloc(
        reinterpret_cast<void **>(&ctx.adaptive_batch_state),
        sizeof(AdaptiveDeviceBatchState));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(adaptive_batch_state)", err);
        cudaFree(ctx.adaptive_policy_scratch);
        ctx.adaptive_policy_scratch = nullptr;
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
        ctx.reduction_scratch_aux_len = 0;
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    err = cudaMalloc(
        reinterpret_cast<void **>(&ctx.adaptive_accepted_batch),
        ADAPTIVE_ACCEPTED_BATCH_CAPACITY * sizeof(AdaptiveDeviceControl));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(adaptive_accepted_batch)", err);
        cudaFree(ctx.adaptive_batch_state);
        ctx.adaptive_batch_state = nullptr;
        cudaFree(ctx.adaptive_policy_scratch);
        ctx.adaptive_policy_scratch = nullptr;
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
        ctx.reduction_scratch_aux_len = 0;
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    err = cudaMalloc(
        reinterpret_cast<void **>(&ctx.adaptive_attempt_trace_device),
        FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1 *
            sizeof(fullmag_fdm_adaptive_attempt_v1));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(adaptive_attempt_trace_device)", err);
        cudaFree(ctx.adaptive_accepted_batch);
        ctx.adaptive_accepted_batch = nullptr;
        cudaFree(ctx.adaptive_batch_state);
        ctx.adaptive_batch_state = nullptr;
        cudaFree(ctx.adaptive_policy_scratch);
        ctx.adaptive_policy_scratch = nullptr;
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
        ctx.reduction_scratch_aux_len = 0;
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    return true;
}

static void free_reduction_scratch(Context &ctx) {
    context_destroy_adaptive_step_graph(ctx);
    if (ctx.reduction_scratch) {
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
    }
    ctx.reduction_scratch_len = 0;
    if (ctx.reduction_scratch_aux) {
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
    }
    ctx.reduction_scratch_aux_len = 0;
    if (ctx.adaptive_policy_scratch) {
        cudaFree(ctx.adaptive_policy_scratch);
        ctx.adaptive_policy_scratch = nullptr;
    }
    if (ctx.adaptive_batch_state) {
        cudaFree(ctx.adaptive_batch_state);
        ctx.adaptive_batch_state = nullptr;
    }
    if (ctx.adaptive_accepted_batch) {
        cudaFree(ctx.adaptive_accepted_batch);
        ctx.adaptive_accepted_batch = nullptr;
    }
    if (ctx.adaptive_attempt_trace_device) {
        cudaFree(ctx.adaptive_attempt_trace_device);
        ctx.adaptive_attempt_trace_device = nullptr;
    }
}

static bool ensure_preview_download_scratch(Context &ctx, size_t required_bytes) {
    if (ctx.preview_download_scratch
        && ctx.preview_download_scratch_len_bytes >= required_bytes)
    {
        return true;
    }
    if (ctx.preview_download_scratch) {
        cudaFree(ctx.preview_download_scratch);
        ctx.preview_download_scratch = nullptr;
        ctx.preview_download_scratch_len_bytes = 0;
    }
    cudaError_t err = cudaMalloc(&ctx.preview_download_scratch, required_bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(preview_download_scratch)", err);
        return false;
    }
    ctx.preview_download_scratch_len_bytes = required_bytes;
    return true;
}

static void free_preview_download_scratch(Context &ctx) {
    if (ctx.preview_download_scratch) {
        cudaFree(ctx.preview_download_scratch);
        ctx.preview_download_scratch = nullptr;
    }
    ctx.preview_download_scratch_len_bytes = 0;
}

static void destroy_async_snapshot_resources(AsyncFieldSnapshot &snapshot) {
    if (snapshot.receipt_token) {
        (void)snapshot.receipt_token->invalidate();
    }
    if (snapshot.pool) {
        bool work_complete = !snapshot.needs_wait;
        if (snapshot.needs_wait && !snapshot.done_event_recorded) {
            // Setup can fail after the ready event has been recorded but before
            // the completion event is recorded.  The pool slot's old done
            // event is then not evidence for this request, so drain only this
            // slot's dependency and I/O stream before making it reusable.
            const cudaError_t ready_error = snapshot.ready_event
                ? cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot.ready_event))
                : cudaSuccess;
            const cudaError_t stream_error = snapshot.stream
                ? cudaStreamSynchronize(reinterpret_cast<cudaStream_t>(snapshot.stream))
                : cudaSuccess;
            work_complete = ready_error == cudaSuccess && stream_error == cudaSuccess;
        }
        release_async_field_snapshot_pool_slot(
            *snapshot.pool,
            snapshot.pool_slot,
            work_complete);
    } else {
        // Defensive cleanup for a partially initialized legacy handle.  New
        // snapshots always lease a persistent pool slot and never enter this
        // branch after successful acquisition.
        if (snapshot.done_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        }
        if (snapshot.staging_done_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.staging_done_event));
        }
        if (snapshot.ready_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.ready_event));
        }
        if (snapshot.stream) {
            cudaStreamDestroy(reinterpret_cast<cudaStream_t>(snapshot.stream));
        }
        if (snapshot.host_soa) {
            cudaFreeHost(snapshot.host_soa);
        }
        free_vector_field(snapshot.staging);
    }
    snapshot.host_soa = nullptr;
    snapshot.host_soa_len_bytes = 0;
    snapshot.component_count = 3;
    snapshot.stream = nullptr;
    snapshot.ready_event = nullptr;
    snapshot.staging_done_event = nullptr;
    snapshot.done_event = nullptr;
    snapshot.pool.reset();
    snapshot.receipt_token.reset();
    snapshot.pool_slot = kFdmAsyncFieldSnapshotPoolCapacity;
    snapshot.needs_wait = false;
    snapshot.done_event_recorded = false;
}

static void destroy_async_preview_resources(AsyncPreviewSnapshot &snapshot) {
    if (snapshot.receipt_token) {
        (void)snapshot.receipt_token->invalidate();
    }
    if (snapshot.pool) {
        bool work_complete = !snapshot.needs_wait;
        if (snapshot.needs_wait && !snapshot.done_event_recorded) {
            const cudaError_t ready_error = snapshot.ready_event
                ? cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot.ready_event))
                : cudaSuccess;
            const cudaError_t stream_error = snapshot.stream
                ? cudaStreamSynchronize(reinterpret_cast<cudaStream_t>(snapshot.stream))
                : cudaSuccess;
            work_complete = ready_error == cudaSuccess && stream_error == cudaSuccess;
        }
        release_async_preview_snapshot_pool_slot(
            *snapshot.pool,
            snapshot.pool_slot,
            work_complete);
    } else {
        if (snapshot.done_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        }
        if (snapshot.staging_done_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.staging_done_event));
        }
        if (snapshot.ready_event) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.ready_event));
        }
        if (snapshot.stream) {
            cudaStreamDestroy(reinterpret_cast<cudaStream_t>(snapshot.stream));
        }
        if (snapshot.host_xyz) {
            cudaFreeHost(snapshot.host_xyz);
        }
        if (snapshot.device_xyz) {
            cudaFree(snapshot.device_xyz);
        }
    }
    snapshot.pool.reset();
    snapshot.receipt_token.reset();
    snapshot.pool_slot = kFdmAsyncPreviewSnapshotPoolCapacity;
    snapshot.done_event = nullptr;
    snapshot.staging_done_event = nullptr;
    snapshot.ready_event = nullptr;
    snapshot.stream = nullptr;
    snapshot.host_xyz = nullptr;
    snapshot.device_xyz = nullptr;
    snapshot.host_xyz_len_bytes = 0;
    snapshot.needs_wait = false;
    snapshot.done_event_recorded = false;
}

template <typename InputScalar, typename OutputScalar>
__global__ void downsample_field_preview_kernel(
    const InputScalar *field_x,
    const InputScalar *field_y,
    const InputScalar *field_z,
    uint32_t full_x,
    uint32_t full_y,
    uint32_t full_z,
    uint32_t preview_x,
    uint32_t preview_y,
    uint32_t preview_z,
    uint32_t z_origin,
    uint32_t z_stride,
    OutputScalar *out_xyz)
{
    uint64_t preview_count =
        static_cast<uint64_t>(preview_x) * preview_y * preview_z;
    uint64_t preview_index =
        static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (preview_index >= preview_count) {
        return;
    }

    uint32_t px = static_cast<uint32_t>(preview_index % preview_x);
    uint32_t py = static_cast<uint32_t>((preview_index / preview_x) % preview_y);
    uint32_t pz = static_cast<uint32_t>(preview_index / (static_cast<uint64_t>(preview_x) * preview_y));

    uint32_t x_start = static_cast<uint32_t>((static_cast<uint64_t>(px) * full_x) / preview_x);
    uint32_t x_end = static_cast<uint32_t>((static_cast<uint64_t>(px + 1) * full_x) / preview_x);
    if (x_end <= x_start) x_end = x_start + 1;
    if (x_end > full_x) x_end = full_x;

    uint32_t y_start = static_cast<uint32_t>((static_cast<uint64_t>(py) * full_y) / preview_y);
    uint32_t y_end = static_cast<uint32_t>((static_cast<uint64_t>(py + 1) * full_y) / preview_y);
    if (y_end <= y_start) y_end = y_start + 1;
    if (y_end > full_y) y_end = full_y;

    uint32_t z_start = z_origin + pz * z_stride;
    if (z_start >= full_z) z_start = full_z - 1;
    uint32_t z_end = z_origin + (pz + 1) * z_stride;
    if (z_end <= z_start) z_end = z_start + 1;
    if (z_end > full_z) z_end = full_z;

    double accum_x = 0.0;
    double accum_y = 0.0;
    double accum_z = 0.0;
    double count = 0.0;

    for (uint32_t z = z_start; z < z_end; ++z) {
        for (uint32_t y = y_start; y < y_end; ++y) {
            for (uint32_t x = x_start; x < x_end; ++x) {
                uint64_t index =
                    (static_cast<uint64_t>(z) * full_y + y) * full_x + x;
                accum_x += static_cast<double>(field_x[index]);
                accum_y += static_cast<double>(field_y[index]);
                accum_z += static_cast<double>(field_z[index]);
                count += 1.0;
            }
        }
    }

    out_xyz[preview_index * 3 + 0] = static_cast<OutputScalar>(accum_x / count);
    out_xyz[preview_index * 3 + 1] = static_cast<OutputScalar>(accum_y / count);
    out_xyz[preview_index * 3 + 2] = static_cast<OutputScalar>(accum_z / count);
}

static bool alloc_fft_workspace(Context &ctx) {
    if (!ctx.enable_demag) {
        return true;
    }

    if (ctx.fft_nx == 0 || ctx.fft_ny == 0 || ctx.fft_nz == 0) {
        ctx.fft_nx = ctx.nx * 2;
        ctx.fft_ny = ctx.ny * 2;
        ctx.fft_nz = ctx.thin_film_2d_demag ? 1 : ctx.nz * 2;
    }
    ctx.fft_cell_count =
        static_cast<uint64_t>(ctx.fft_nx) * ctx.fft_ny * ctx.fft_nz;

    if (ctx.fft_cell_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = "demag FFT component stride exceeds cuFFT PlanMany limit";
        return false;
    }

    const int rank = ctx.thin_film_2d_demag ? 2 : 3;
    int dims[3] = {};
    if (ctx.thin_film_2d_demag) {
        dims[0] = static_cast<int>(ctx.fft_ny);
        dims[1] = static_cast<int>(ctx.fft_nx);
    } else {
        dims[0] = static_cast<int>(ctx.fft_nz);
        dims[1] = static_cast<int>(ctx.fft_ny);
        dims[2] = static_cast<int>(ctx.fft_nx);
    }
    int inembed[3] = {dims[0], dims[1], dims[2]};
    int onembed[3] = {dims[0], dims[1], dims[2]};
    const int component_stride = static_cast<int>(ctx.fft_cell_count);

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        size_t bytes = ctx.fft_cell_count * sizeof(cufftDoubleComplex);
        cudaError_t err = cudaMalloc(&ctx.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_xyz)", err); return false; }
        auto *base = static_cast<cufftDoubleComplex*>(ctx.fft_x);
        ctx.fft_y = base + ctx.fft_cell_count;
        ctx.fft_z = base + (2 * ctx.fft_cell_count);
        ctx.fft_component_stride = ctx.fft_cell_count;
        ctx.fft_components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&ctx.fft_plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(Z2Z, batch=3)", fft_err);
            return false;
        }
        ctx.fft_plan_valid = true;

        fft_err = cufftSetAutoAllocation(ctx.fft_plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(Z2Z, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            ctx.fft_plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_Z2Z,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(Z2Z, batch=3)", fft_err);
            return false;
        }

        ctx.fft_work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&ctx.fft_work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(ctx.fft_plan, ctx.fft_work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(Z2Z, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(ctx.fft_plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(Z2Z, batch=3)", fft_err);
            return false;
        }
    } else {
        size_t bytes = ctx.fft_cell_count * sizeof(cufftComplex);
        cudaError_t err = cudaMalloc(&ctx.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_xyz)", err); return false; }
        auto *base = static_cast<cufftComplex*>(ctx.fft_x);
        ctx.fft_y = base + ctx.fft_cell_count;
        ctx.fft_z = base + (2 * ctx.fft_cell_count);
        ctx.fft_component_stride = ctx.fft_cell_count;
        ctx.fft_components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&ctx.fft_plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(C2C, batch=3)", fft_err);
            return false;
        }
        ctx.fft_plan_valid = true;

        fft_err = cufftSetAutoAllocation(ctx.fft_plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(C2C, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            ctx.fft_plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_C2C,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(C2C, batch=3)", fft_err);
            return false;
        }

        ctx.fft_work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&ctx.fft_work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(ctx.fft_plan, ctx.fft_work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(C2C, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(ctx.fft_plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(C2C, batch=3)", fft_err);
            return false;
        }
    }

    return true;
}

static void free_fft_workspace(Context &ctx) {
    if (ctx.fft_workspace_bound_to_multilayer_cache) {
        unbind_multilayer_fft_workspace(ctx);
        return;
    }
    if (ctx.fft_plan_valid) {
        cufftDestroy(ctx.fft_plan);
        ctx.fft_plan = 0;
        ctx.fft_plan_valid = false;
    }
    if (ctx.fft_work_area) {
        cudaFree(ctx.fft_work_area);
        ctx.fft_work_area = nullptr;
    }
    ctx.fft_work_area_bytes = 0;
    if (ctx.fft_components_share_allocation) {
        if (ctx.fft_x) { cudaFree(ctx.fft_x); }
        ctx.fft_x = nullptr;
        ctx.fft_y = nullptr;
        ctx.fft_z = nullptr;
    } else {
        if (ctx.fft_x) { cudaFree(ctx.fft_x); ctx.fft_x = nullptr; }
        if (ctx.fft_y) { cudaFree(ctx.fft_y); ctx.fft_y = nullptr; }
        if (ctx.fft_z) { cudaFree(ctx.fft_z); ctx.fft_z = nullptr; }
    }
    ctx.fft_cell_count = 0;
    ctx.fft_component_stride = 0;
    ctx.fft_components_share_allocation = false;
}

static bool multilayer_fft_workspace_matches_grid(
    const DeviceMultilayerFftWorkspace &workspace,
    const fullmag_fdm_grid_desc &grid,
    uint64_t cell_count)
{
    return workspace.plan_valid &&
        workspace.fft_x != nullptr &&
        workspace.fft_y != nullptr &&
        workspace.fft_z != nullptr &&
        workspace.fft_grid.nx == grid.nx &&
        workspace.fft_grid.ny == grid.ny &&
        workspace.fft_grid.nz == grid.nz &&
        workspace.cell_count == cell_count;
}

static void bind_multilayer_fft_workspace(
    Context &ctx,
    DeviceMultilayerFftWorkspace &workspace)
{
    ctx.fft_nx = workspace.fft_grid.nx;
    ctx.fft_ny = workspace.fft_grid.ny;
    ctx.fft_nz = workspace.fft_grid.nz;
    ctx.fft_cell_count = workspace.cell_count;
    ctx.fft_component_stride = workspace.component_stride;
    ctx.fft_x = workspace.fft_x;
    ctx.fft_y = workspace.fft_y;
    ctx.fft_z = workspace.fft_z;
    ctx.fft_work_area = workspace.work_area;
    ctx.fft_work_area_bytes = workspace.work_area_bytes;
    ctx.fft_plan = workspace.plan;
    ctx.fft_plan_valid = workspace.plan_valid;
    ctx.fft_components_share_allocation = workspace.components_share_allocation;
    ctx.thin_film_2d_demag = workspace.fft_grid.nz == 1;
    ctx.fft_workspace_bound_to_multilayer_cache = true;
}

static bool alloc_multilayer_fft_workspace(
    Context &ctx,
    DeviceMultilayerFftWorkspace &workspace,
    const fullmag_fdm_grid_desc &grid)
{
    workspace.fft_grid = grid;
    workspace.cell_count = grid_cell_count(grid);

    if (workspace.cell_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = "multilayer demag FFT component stride exceeds cuFFT PlanMany limit";
        return false;
    }

    const bool thin_film = grid.nz == 1;
    const int rank = thin_film ? 2 : 3;
    int dims[3] = {};
    if (thin_film) {
        dims[0] = static_cast<int>(grid.ny);
        dims[1] = static_cast<int>(grid.nx);
    } else {
        dims[0] = static_cast<int>(grid.nz);
        dims[1] = static_cast<int>(grid.ny);
        dims[2] = static_cast<int>(grid.nx);
    }
    int inembed[3] = {dims[0], dims[1], dims[2]};
    int onembed[3] = {dims[0], dims[1], dims[2]};
    const int component_stride = static_cast<int>(workspace.cell_count);

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        size_t bytes = workspace.cell_count * sizeof(cufftDoubleComplex);
        cudaError_t err = cudaMalloc(&workspace.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_xyz)", err); return false; }
        auto *base = static_cast<cufftDoubleComplex*>(workspace.fft_x);
        workspace.fft_y = base + workspace.cell_count;
        workspace.fft_z = base + (2 * workspace.cell_count);
        workspace.component_stride = workspace.cell_count;
        workspace.components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&workspace.plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }
        workspace.plan_valid = true;

        fft_err = cufftSetAutoAllocation(workspace.plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            workspace.plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_Z2Z,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }

        workspace.work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&workspace.work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(workspace.plan, workspace.work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(workspace.plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }
    } else {
        size_t bytes = workspace.cell_count * sizeof(cufftComplex);
        cudaError_t err = cudaMalloc(&workspace.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_xyz)", err); return false; }
        auto *base = static_cast<cufftComplex*>(workspace.fft_x);
        workspace.fft_y = base + workspace.cell_count;
        workspace.fft_z = base + (2 * workspace.cell_count);
        workspace.component_stride = workspace.cell_count;
        workspace.components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&workspace.plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(multilayer C2C, batch=3)", fft_err);
            return false;
        }
        workspace.plan_valid = true;

        fft_err = cufftSetAutoAllocation(workspace.plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(multilayer C2C, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            workspace.plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_C2C,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(multilayer C2C, batch=3)", fft_err);
            return false;
        }

        workspace.work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&workspace.work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(workspace.plan, workspace.work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(multilayer C2C, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(workspace.plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(multilayer C2C, batch=3)", fft_err);
            return false;
        }
    }

    return true;
}

static DeviceMultilayerFftWorkspace *ensure_multilayer_fft_workspace(
    Context &ctx,
    const fullmag_fdm_grid_desc &grid,
    uint64_t cell_count)
{
    for (DeviceMultilayerFftWorkspace &workspace : ctx.multilayer_fft_workspaces) {
        if (multilayer_fft_workspace_matches_grid(workspace, grid, cell_count)) {
            return &workspace;
        }
    }

    if (!ctx.fft_workspace_bound_to_multilayer_cache &&
        (ctx.fft_plan_valid ||
            ctx.fft_x != nullptr ||
            ctx.fft_y != nullptr ||
            ctx.fft_z != nullptr ||
            ctx.fft_work_area != nullptr))
    {
        free_fft_workspace(ctx);
    }

    ctx.multilayer_fft_workspaces.emplace_back();
    DeviceMultilayerFftWorkspace &workspace = ctx.multilayer_fft_workspaces.back();
    if (!alloc_multilayer_fft_workspace(ctx, workspace, grid)) {
        free_multilayer_fft_workspace(workspace);
        ctx.multilayer_fft_workspaces.pop_back();
        return nullptr;
    }
    return &workspace;
}

/* ── Public context functions ── */

bool context_alloc_device(Context &ctx) {
    if (!context_create_compute_stream(ctx)) return false;
    if (!alloc_active_mask(ctx)) return false;
    if (!alloc_frozen_mask(ctx)) return false;
    if (ctx.has_frozen_mask && !alloc_vector_field(ctx, ctx.frozen_reference)) return false;
    if (!alloc_sot_active_mask(ctx)) return false;
    if (!alloc_slonczewski_active_mask(ctx)) return false;
    if (!alloc_region_mask(ctx)) return false;
    if (!alloc_exchange_lut(ctx)) return false;
    if (!alloc_reduction_scratch(ctx)) return false;
    if (!alloc_vector_field(ctx, ctx.m))    return false;
    if (!alloc_vector_field(ctx, ctx.h_ex)) return false;
    if (!alloc_vector_field(ctx, ctx.h_demag)) return false;
    if (!alloc_vector_field(ctx, ctx.h_demag_visual)) return false;
    if (!alloc_vector_field(ctx, ctx.h_eff_visual)) return false;
    if (!alloc_vector_field(ctx, ctx.h_ani)) return false;
    if (!alloc_energy_density(ctx)) return false;
    if (!alloc_vector_field(ctx, ctx.k1))   return false;
    if (!alloc_vector_field(ctx, ctx.tmp))  return false;
    if (!alloc_vector_field(ctx, ctx.work)) return false;

    // DP45 / RK23 / RK4: allocate extra stage buffers as needed.
    // DP45 needs k2..k6 + k_fsal; RK23 needs k2, k3, k_fsal; RK4 needs k2, k3, k4.
    // We allocate the union of required buffers per integrator.
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK4) {
        if (!alloc_vector_field(ctx, ctx.k2)) return false;
        if (!alloc_vector_field(ctx, ctx.k3)) return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK4) {
        if (!alloc_vector_field(ctx, ctx.k4)) return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45) {
        if (!alloc_vector_field(ctx, ctx.k5)) return false;
        if (!alloc_vector_field(ctx, ctx.k6)) return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23) {
        if (!alloc_vector_field(ctx, ctx.k_fsal)) return false;
        ctx.fsal_valid = false;
    }

    // ABM3: allocate 3 history buffers
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_ABM3) {
        if (!alloc_vector_field(ctx, ctx.abm_f_n))  return false;
        if (!alloc_vector_field(ctx, ctx.abm_f_n1)) return false;
        if (!alloc_vector_field(ctx, ctx.abm_f_n2)) return false;
        ctx.abm_startup = 0;
        ctx.abm_last_dt = 0.0;
    }

    if (!alloc_fft_workspace(ctx)) return false;
    if (!alloc_demag_kernel(ctx)) return false;
    if (ctx.enable_demag && !ctx.has_demag_tensor_kernel) {
        ctx.last_error =
            "FDM CUDA demag requires validated Newell tensor spectra; automatic native spectrum construction is unavailable";
        return false;
    }

    // Oersted static field buffer
    if (ctx.has_oersted_field) {
        if (!alloc_vector_field(ctx, ctx.h_oe_static)) return false;
    }

    // Zero out working buffers
    size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaMemset(ctx.h_ex.x, 0, bytes);
    cudaMemset(ctx.h_ex.y, 0, bytes);
    cudaMemset(ctx.h_ex.z, 0, bytes);
    cudaMemset(ctx.h_demag.x, 0, bytes);
    cudaMemset(ctx.h_demag.y, 0, bytes);
    cudaMemset(ctx.h_demag.z, 0, bytes);
    cudaMemset(ctx.h_demag_visual.x, 0, bytes);
    cudaMemset(ctx.h_demag_visual.y, 0, bytes);
    cudaMemset(ctx.h_demag_visual.z, 0, bytes);
    cudaMemset(ctx.h_eff_visual.x, 0, bytes);
    cudaMemset(ctx.h_eff_visual.y, 0, bytes);
    cudaMemset(ctx.h_eff_visual.z, 0, bytes);
    cudaMemset(ctx.h_ani.x, 0, bytes);
    cudaMemset(ctx.h_ani.y, 0, bytes);
    cudaMemset(ctx.h_ani.z, 0, bytes);
    cudaMemset(ctx.k1.x, 0, bytes);
    cudaMemset(ctx.k1.y, 0, bytes);
    cudaMemset(ctx.k1.z, 0, bytes);
    cudaMemset(ctx.tmp.x, 0, bytes);
    cudaMemset(ctx.tmp.y, 0, bytes);
    cudaMemset(ctx.tmp.z, 0, bytes);
    cudaMemset(ctx.work.x, 0, bytes);
    cudaMemset(ctx.work.y, 0, bytes);
    cudaMemset(ctx.work.z, 0, bytes);
    cudaMemset(ctx.energy_density, 0, bytes);

    if (!initialize_async_field_snapshot_pool(ctx)) return false;
    if (!initialize_async_preview_snapshot_pool(ctx)) {
        destroy_async_field_snapshot_pool(ctx);
        return false;
    }

    return true;
}

static bool copy_field_d2d_async(
    DeviceVectorField &destination,
    const DeviceVectorField &source,
    size_t bytes,
    cudaStream_t stream)
{
    return (::cudaMemcpyAsync)(destination.x, source.x, bytes,
                               cudaMemcpyDeviceToDevice, stream) == cudaSuccess &&
        (::cudaMemcpyAsync)(destination.y, source.y, bytes,
                            cudaMemcpyDeviceToDevice, stream) == cudaSuccess &&
        (::cudaMemcpyAsync)(destination.z, source.z, bytes,
                            cudaMemcpyDeviceToDevice, stream) == cudaSuccess;
}

bool context_capture_pre_step_state(Context &ctx) {
    if (ctx.cell_count == 0) return true;
    if (ctx.gpu_transport_pre_step_m.x == nullptr &&
        !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_m)) {
        ctx.step_transaction_accounting_valid = false;
        return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_ABM3 &&
        ((ctx.gpu_transport_pre_step_abm_f_n.x == nullptr &&
          !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_abm_f_n)) ||
         (ctx.gpu_transport_pre_step_abm_f_n1.x == nullptr &&
          !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_abm_f_n1)) ||
         (ctx.gpu_transport_pre_step_abm_f_n2.x == nullptr &&
          !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_abm_f_n2)))) {
        ctx.step_transaction_accounting_valid = false;
        return false;
    }
    const size_t scalar_bytes = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? sizeof(double) : sizeof(float);
    const size_t bytes = static_cast<size_t>(ctx.cell_count) * scalar_bytes;
    const cudaStream_t stream = context_compute_stream(ctx);
    // Legacy fixed-step kernels still publish m on the default stream.  Order
    // that producer before the transaction-owned compute-stream snapshot.
    if (cudaStreamSynchronize(nullptr) != cudaSuccess ||
        cudaMemcpyAsync(ctx.gpu_transport_pre_step_m.x, ctx.m.x, bytes,
                        cudaMemcpyDeviceToDevice, stream) != cudaSuccess ||
        cudaMemcpyAsync(ctx.gpu_transport_pre_step_m.y, ctx.m.y, bytes,
                        cudaMemcpyDeviceToDevice, stream) != cudaSuccess ||
        cudaMemcpyAsync(ctx.gpu_transport_pre_step_m.z, ctx.m.z, bytes,
                        cudaMemcpyDeviceToDevice, stream) != cudaSuccess ||
        cudaStreamSynchronize(stream) != cudaSuccess) {
        ctx.step_transaction_accounting_valid = false;
        ctx.last_error = "failed to capture pre-step magnetization";
        return false;
    }
    ctx.gpu_transport_pre_step_m_valid = true;
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_ABM3) {
        if (!copy_field_d2d_async(
                ctx.gpu_transport_pre_step_abm_f_n, ctx.abm_f_n, bytes, stream) ||
            !copy_field_d2d_async(
                ctx.gpu_transport_pre_step_abm_f_n1, ctx.abm_f_n1, bytes, stream) ||
            !copy_field_d2d_async(
                ctx.gpu_transport_pre_step_abm_f_n2, ctx.abm_f_n2, bytes, stream) ||
            cudaStreamSynchronize(stream) != cudaSuccess) {
            ctx.gpu_transport_pre_step_m_valid = false;
            ctx.step_transaction_accounting_valid = false;
            ctx.last_error = "failed to capture pre-step ABM history";
            return false;
        }
        ctx.gpu_transport_pre_step_abm_valid = true;
    }
    ctx.gpu_transport_pre_step_step_count = ctx.step_count;
    ctx.gpu_transport_pre_step_accepted_step_index = ctx.accepted_step_index;
    ctx.gpu_transport_pre_step_accepted_state_revision = ctx.accepted_state_revision;
    ctx.gpu_transport_pre_step_current_time = ctx.current_time;
    ctx.gpu_transport_pre_step_current_dt = ctx.current_dt;
    ctx.gpu_transport_pre_step_adaptive_has_previous_error =
        ctx.adaptive_has_previous_error;
    ctx.gpu_transport_pre_step_adaptive_previous_error = ctx.adaptive_previous_error;
    ctx.gpu_transport_pre_step_abm_startup = ctx.abm_startup;
    ctx.gpu_transport_pre_step_abm_last_dt = ctx.abm_last_dt;
    uint64_t step_transaction_capture_d2d_bytes = 0;
    if (!context_step_transaction_payload_bytes(
            ctx.cell_count, scalar_bytes,
            ctx.integrator == FULLMAG_FDM_INTEGRATOR_ABM3,
            step_transaction_capture_d2d_bytes)) {
        ctx.step_transaction_accounting_valid = false;
    } else {
        (void)context_commit_step_transaction_capture_sample(
            ctx, step_transaction_capture_d2d_bytes);
    }
    return true;
}

bool context_rollback_pre_step_state(Context &ctx) {
    if (ctx.step_transaction_rollback_sample_pending) {
        context_discard_step_transaction_rollback_sample(ctx);
    }
    if (!ctx.gpu_transport_pre_step_m_valid) {
        context_discard_step_transaction_rollback_sample(ctx);
        ctx.last_error = "pre-step magnetization snapshot is unavailable";
        return false;
    }
    const size_t scalar_bytes = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? sizeof(double) : sizeof(float);
    const size_t bytes = static_cast<size_t>(ctx.cell_count) * scalar_bytes;
    const cudaStream_t stream = context_compute_stream(ctx);
    const bool restored_abm_history = ctx.gpu_transport_pre_step_abm_valid;
    const auto rollback_started_at = std::chrono::steady_clock::now();
    // A rejected legacy fixed-step integrator can still have default-stream
    // writers in flight.  Complete those writers before restoring on the
    // dedicated compute stream.
    if (cudaStreamSynchronize(nullptr) != cudaSuccess) {
        context_discard_step_transaction_rollback_sample(ctx);
        ctx.last_error = "failed to order rejected integrator work before rollback";
        return false;
    }
    const cudaError_t copy_x = cudaMemcpyAsync(
        ctx.m.x, ctx.gpu_transport_pre_step_m.x, bytes,
        cudaMemcpyDeviceToDevice, stream);
    const cudaError_t copy_y = cudaMemcpyAsync(
        ctx.m.y, ctx.gpu_transport_pre_step_m.y, bytes,
        cudaMemcpyDeviceToDevice, stream);
    const cudaError_t copy_z = cudaMemcpyAsync(
        ctx.m.z, ctx.gpu_transport_pre_step_m.z, bytes,
        cudaMemcpyDeviceToDevice, stream);
    if (copy_x != cudaSuccess || copy_y != cudaSuccess || copy_z != cudaSuccess ||
        cudaStreamSynchronize(stream) != cudaSuccess) {
        context_discard_step_transaction_rollback_sample(ctx);
        ctx.last_error = "failed to restore bound transport pre-step magnetization";
        return false;
    }
    if (ctx.gpu_transport_pre_step_abm_valid &&
        (!copy_field_d2d_async(
             ctx.abm_f_n, ctx.gpu_transport_pre_step_abm_f_n, bytes, stream) ||
         !copy_field_d2d_async(
             ctx.abm_f_n1, ctx.gpu_transport_pre_step_abm_f_n1, bytes, stream) ||
         !copy_field_d2d_async(
             ctx.abm_f_n2, ctx.gpu_transport_pre_step_abm_f_n2, bytes, stream) ||
         cudaStreamSynchronize(stream) != cudaSuccess)) {
        context_discard_step_transaction_rollback_sample(ctx);
        ctx.last_error = "failed to restore pre-step ABM history";
        return false;
    }
    const auto rollback_finished_at = std::chrono::steady_clock::now();
    const uint64_t rollback_latency_ns = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            rollback_finished_at - rollback_started_at).count());
    uint64_t step_transaction_rollback_d2d_bytes = 0;
    if (!context_step_transaction_payload_bytes(
            ctx.cell_count, scalar_bytes, restored_abm_history,
            step_transaction_rollback_d2d_bytes)) {
        context_discard_step_transaction_rollback_sample(ctx);
    } else {
        (void)context_stage_step_transaction_rollback_sample(
            ctx, step_transaction_rollback_d2d_bytes, rollback_latency_ns);
    }
    ctx.gpu_transport_pre_step_m_valid = false;
    ctx.gpu_transport_pre_step_abm_valid = false;
    ctx.step_count = ctx.gpu_transport_pre_step_step_count;
    ctx.accepted_step_index = ctx.gpu_transport_pre_step_accepted_step_index;
    ctx.accepted_state_revision = ctx.gpu_transport_pre_step_accepted_state_revision;
    ctx.current_time = ctx.gpu_transport_pre_step_current_time;
    ctx.current_dt = ctx.gpu_transport_pre_step_current_dt;
    ctx.trial_dt = 0.0;
    ctx.fsal_valid = false;
    ctx.fsal_pending = false;
    ctx.accepted_step_pending = false;
    ctx.adaptive_has_previous_error =
        ctx.gpu_transport_pre_step_adaptive_has_previous_error;
    ctx.adaptive_previous_error = ctx.gpu_transport_pre_step_adaptive_previous_error;
    ctx.abm_startup = ctx.gpu_transport_pre_step_abm_startup;
    ctx.abm_last_dt = ctx.gpu_transport_pre_step_abm_last_dt;
    return true;
}

void context_discard_pre_step_state(Context &ctx) {
    ctx.gpu_transport_pre_step_m_valid = false;
    ctx.gpu_transport_pre_step_abm_valid = false;
}

bool context_prepare_checkpoint_import_staging(
    Context &ctx, bool include_fsal, bool include_abm_history)
{
    if (ctx.gpu_transport_pre_step_m.x == nullptr &&
        !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_m)) {
        return false;
    }
    if ((include_fsal || include_abm_history) &&
        ctx.gpu_transport_pre_step_abm_f_n.x == nullptr &&
        !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_abm_f_n)) {
        return false;
    }
    if (include_abm_history &&
        ((ctx.gpu_transport_pre_step_abm_f_n1.x == nullptr &&
          !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_abm_f_n1)) ||
         (ctx.gpu_transport_pre_step_abm_f_n2.x == nullptr &&
          !alloc_vector_field(ctx, ctx.gpu_transport_pre_step_abm_f_n2)))) {
        return false;
    }
    return true;
}

void context_commit_checkpoint_import_staging(
    Context &ctx, bool include_fsal, bool include_abm_history)
{
    std::swap(ctx.m, ctx.gpu_transport_pre_step_m);
    if (include_fsal) {
        std::swap(ctx.k_fsal, ctx.gpu_transport_pre_step_abm_f_n);
    }
    if (include_abm_history) {
        std::swap(ctx.abm_f_n, ctx.gpu_transport_pre_step_abm_f_n);
        std::swap(ctx.abm_f_n1, ctx.gpu_transport_pre_step_abm_f_n1);
        std::swap(ctx.abm_f_n2, ctx.gpu_transport_pre_step_abm_f_n2);
    }
    ctx.gpu_transport_pre_step_m_valid = false;
    ctx.gpu_transport_pre_step_abm_valid = false;
}

void context_free_device(Context &ctx) {
    destroy_async_preview_snapshot_pool(ctx);
    destroy_async_field_snapshot_pool(ctx);
    context_destroy_compute_stream(ctx);
    free_multilayer_plan_v2(ctx);
    free_vector_field(ctx.m);
    free_vector_field(ctx.h_ex);
    free_vector_field(ctx.h_demag);
    free_vector_field(ctx.h_demag_visual);
    free_vector_field(ctx.h_eff_visual);
    free_vector_field(ctx.h_ani);
    free_energy_density(ctx);
    free_vector_field(ctx.k1);
    free_vector_field(ctx.tmp);
    free_vector_field(ctx.gpu_transport_pre_step_m);
    free_vector_field(ctx.gpu_transport_pre_step_abm_f_n);
    free_vector_field(ctx.gpu_transport_pre_step_abm_f_n1);
    free_vector_field(ctx.gpu_transport_pre_step_abm_f_n2);
    free_vector_field(ctx.work);
    // DP45 stage buffers
    free_vector_field(ctx.k2);
    free_vector_field(ctx.k3);
    free_vector_field(ctx.k4);
    free_vector_field(ctx.k5);
    free_vector_field(ctx.k6);
    free_vector_field(ctx.k_fsal);
    // ABM3 history buffers
    free_vector_field(ctx.abm_f_n);
    free_vector_field(ctx.abm_f_n1);
    free_vector_field(ctx.abm_f_n2);
    // Oersted static field
    free_vector_field(ctx.h_oe_static);
    free_fft_workspace(ctx);
    free_demag_kernel(ctx);
    free_active_mask(ctx);
    free_frozen_mask(ctx);
    free_vector_field(ctx.frozen_reference);
    free_sot_active_mask(ctx);
    free_slonczewski_active_mask(ctx);
    free_region_mask(ctx);
    free_exchange_lut(ctx);
    free_boundary_correction(ctx);
    free_reduction_scratch(ctx);
    free_preview_download_scratch(ctx);
    free_anisotropy_fields(ctx);
    free_cubic_anisotropy_fields(ctx);
}

bool context_upload_active_mask(Context &ctx, const uint8_t *mask, uint64_t len) {
    if (!ctx.has_active_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "active_mask length mismatch";
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.active_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(active_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_frozen_spins(
    Context &ctx,
    const uint8_t *mask,
    uint64_t mask_len,
    const double *reference_xyz,
    uint64_t reference_len)
{
    if (!ctx.has_frozen_mask) {
        return true;
    }
    if (!mask || mask_len != ctx.cell_count || !reference_xyz ||
        reference_len != 3 * ctx.cell_count) {
        ctx.last_error = "frozen_spins_cuda_abi_invalid: expected dense mask[cell_count] and f64 reference[3*cell_count]";
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.frozen_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(frozen_mask)", err);
        return false;
    }
    ctx.frozen_cell_count = 0;
    for (uint64_t index = 0; index < ctx.cell_count; ++index) {
        if (mask[index] != 0) ++ctx.frozen_cell_count;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> x(ctx.cell_count), y(ctx.cell_count), z(ctx.cell_count);
        for (uint64_t index = 0; index < ctx.cell_count; ++index) {
            x[index] = reference_xyz[3 * index + 0];
            y[index] = reference_xyz[3 * index + 1];
            z[index] = reference_xyz[3 * index + 2];
        }
        if (cudaMemcpy(ctx.frozen_reference.x, x.data(), x.size() * sizeof(double), cudaMemcpyHostToDevice) != cudaSuccess ||
            cudaMemcpy(ctx.frozen_reference.y, y.data(), y.size() * sizeof(double), cudaMemcpyHostToDevice) != cudaSuccess ||
            cudaMemcpy(ctx.frozen_reference.z, z.data(), z.size() * sizeof(double), cudaMemcpyHostToDevice) != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(frozen_reference)", cudaGetLastError());
            return false;
        }
    } else {
        std::vector<float> x(ctx.cell_count), y(ctx.cell_count), z(ctx.cell_count);
        for (uint64_t index = 0; index < ctx.cell_count; ++index) {
            x[index] = static_cast<float>(reference_xyz[3 * index + 0]);
            y[index] = static_cast<float>(reference_xyz[3 * index + 1]);
            z[index] = static_cast<float>(reference_xyz[3 * index + 2]);
        }
        if (cudaMemcpy(ctx.frozen_reference.x, x.data(), x.size() * sizeof(float), cudaMemcpyHostToDevice) != cudaSuccess ||
            cudaMemcpy(ctx.frozen_reference.y, y.data(), y.size() * sizeof(float), cudaMemcpyHostToDevice) != cudaSuccess ||
            cudaMemcpy(ctx.frozen_reference.z, z.data(), z.size() * sizeof(float), cudaMemcpyHostToDevice) != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(frozen_reference)", cudaGetLastError());
            return false;
        }
    }
    return true;
}

bool context_upload_sot_active_mask(Context &ctx, const uint8_t *mask, uint64_t len) {
    if (!ctx.has_sot_active_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "sot_active_mask length mismatch";
        return false;
    }
    const cudaError_t err = cudaMemcpy(
        ctx.sot_active_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(sot_active_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_slonczewski_active_mask(Context &ctx, const uint8_t *mask, uint64_t len) {
    if (!ctx.has_slonczewski_active_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "slonczewski_active_mask length mismatch";
        return false;
    }
    const cudaError_t err = cudaMemcpy(
        ctx.slonczewski_active_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(slonczewski_active_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_region_mask(Context &ctx, const uint32_t *mask, uint64_t len) {
    if (!ctx.has_region_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "region_mask length mismatch";
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.region_mask,
        mask,
        ctx.cell_count * sizeof(uint32_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(region_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_exchange_lut(Context &ctx, const double *lut, uint64_t len) {
    if (!ctx.has_exchange_lut) {
        return true;
    }
    constexpr uint64_t N = FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
    if (!lut || len != N * N) {
        ctx.last_error = "exchange_lut length mismatch: expected "
            + std::to_string(N * N) + ", got " + std::to_string(len);
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.exchange_lut,
        lut,
        N * N * sizeof(double),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(exchange_lut)", err);
        return false;
    }
    return true;
}

bool context_upload_demag_kernel_spectra(
    Context &ctx,
    const double *kxx,
    const double *kyy,
    const double *kzz,
    const double *kxy,
    const double *kxz,
    const double *kyz,
    uint64_t len)
{
    if (!ctx.has_demag_tensor_kernel) {
        return true;
    }
    if (!kxx || !kyy || !kzz || !kxy || !kxz || !kyz || len != ctx.fft_cell_count * 2) {
        ctx.last_error = "demag kernel spectrum length mismatch";
        return false;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        auto upload = [&](void *dst, const double *src, const char *label) -> bool {
            cudaError_t err = cudaMemcpy(
                dst,
                src,
                len * sizeof(double),
                cudaMemcpyHostToDevice);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, label, err);
                return false;
            }
            return true;
        };
        return upload(ctx.demag_kernel.xx, kxx, "cudaMemcpy(kern_xx)")
            && upload(ctx.demag_kernel.yy, kyy, "cudaMemcpy(kern_yy)")
            && upload(ctx.demag_kernel.zz, kzz, "cudaMemcpy(kern_zz)")
            && upload(ctx.demag_kernel.xy, kxy, "cudaMemcpy(kern_xy)")
            && upload(ctx.demag_kernel.xz, kxz, "cudaMemcpy(kern_xz)")
            && upload(ctx.demag_kernel.yz, kyz, "cudaMemcpy(kern_yz)");
    }

    auto convert_and_upload = [&](void *dst, const double *src, const char *label) -> bool {
        std::vector<float> converted(len);
        for (uint64_t i = 0; i < len; i++) {
            converted[i] = static_cast<float>(src[i]);
        }
        cudaError_t err = cudaMemcpy(
            dst,
            converted.data(),
            len * sizeof(float),
            cudaMemcpyHostToDevice);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, label, err);
            return false;
        }
        return true;
    };

    return convert_and_upload(ctx.demag_kernel.xx, kxx, "cudaMemcpy(kern_xx)")
        && convert_and_upload(ctx.demag_kernel.yy, kyy, "cudaMemcpy(kern_yy)")
        && convert_and_upload(ctx.demag_kernel.zz, kzz, "cudaMemcpy(kern_zz)")
        && convert_and_upload(ctx.demag_kernel.xy, kxy, "cudaMemcpy(kern_xy)")
        && convert_and_upload(ctx.demag_kernel.xz, kxz, "cudaMemcpy(kern_xz)")
        && convert_and_upload(ctx.demag_kernel.yz, kyz, "cudaMemcpy(kern_yz)");
}

bool context_upload_multilayer_plan_v2(
    Context &ctx,
    const fullmag_fdm_multilayer_plan_desc_v2 &plan)
{
    free_multilayer_plan_v2(ctx);
    ctx.has_multilayer_plan_v2 = true;
    ctx.multilayer_layers.reserve(plan.layer_count);
    ctx.multilayer_kernels.reserve(plan.kernel_count);

    auto fail = [&]() -> bool {
        free_multilayer_plan_v2(ctx);
        return false;
    };

    for (uint32_t i = 0; i < plan.layer_count; ++i) {
        const fullmag_fdm_layer_desc_v2 &src = plan.layers[i];
        ctx.multilayer_layers.emplace_back();
        DeviceMultilayerLayer &dst = ctx.multilayer_layers.back();
        dst.native_grid = src.native_grid;
        dst.convolution_grid = src.convolution_grid;
        dst.transfer_kind = src.transfer_kind;
        dst.layer_index = src.layer_index;
        dst.z_offset_cells = src.z_offset_cells;
        dst.material = src.material;
        dst.has_uniaxial_anisotropy = src.has_uniaxial_anisotropy != 0;
        dst.Ku1 = src.uniaxial_anisotropy_constant;
        dst.Ku2 = src.uniaxial_anisotropy_k2;
        dst.anisU[0] = src.anisotropy_axis[0];
        dst.anisU[1] = src.anisotropy_axis[1];
        dst.anisU[2] = src.anisotropy_axis[2];
        dst.has_cubic_anisotropy = src.has_cubic_anisotropy != 0;
        dst.Kc1 = src.cubic_Kc1;
        dst.Kc2 = src.cubic_Kc2;
        dst.Kc3 = src.cubic_Kc3;
        dst.cubic_axis1[0] = src.cubic_axis1[0];
        dst.cubic_axis1[1] = src.cubic_axis1[1];
        dst.cubic_axis1[2] = src.cubic_axis1[2];
        dst.cubic_axis2[0] = src.cubic_axis2[0];
        dst.cubic_axis2[1] = src.cubic_axis2[1];
        dst.cubic_axis2[2] = src.cubic_axis2[2];
        dst.cell_count = grid_cell_count(src.native_grid);
        dst.convolution_cell_count = grid_cell_count(src.convolution_grid);
        dst.has_active_mask = src.active_mask != nullptr;

        if (!alloc_vector_field_cells(ctx, dst.m, dst.cell_count, "multilayer_m")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_ex, dst.cell_count, "multilayer_h_ex")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_demag, dst.cell_count, "multilayer_h_demag")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_dmi, dst.cell_count, "multilayer_h_dmi")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_ani, dst.cell_count, "multilayer_h_ani")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.tmp, dst.cell_count, "multilayer_tmp")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k1, dst.cell_count, "multilayer_k1")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k2, dst.cell_count, "multilayer_k2")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k3, dst.cell_count, "multilayer_k3")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k4, dst.cell_count, "multilayer_k4")) {
            return fail();
        }
        if (!upload_vector_field_aos_f64(
                ctx,
                dst.m,
                src.initial_magnetization_xyz,
                dst.cell_count,
                "cudaMemcpy(multilayer_m)"))
        {
            return fail();
        }
        const size_t layer_bytes = dst.cell_count * scalar_size(ctx.precision);
        cudaError_t zero_err = cudaMemset(dst.h_ex.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ex.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ex.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ex.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ex.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ex.z)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_demag.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_demag.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_demag.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_demag.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_demag.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_demag.z)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_dmi.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_dmi.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_dmi.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_dmi.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_dmi.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_dmi.z)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ani.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ani.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ani.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ani.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ani.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ani.z)", zero_err);
            return fail();
        }
        if (dst.has_active_mask) {
            cudaError_t err = cudaMalloc(
                reinterpret_cast<void **>(&dst.active_mask),
                dst.cell_count * sizeof(uint8_t));
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMalloc(multilayer_active_mask)", err);
                return fail();
            }
            err = cudaMemcpy(
                dst.active_mask,
                src.active_mask,
                dst.cell_count * sizeof(uint8_t),
                cudaMemcpyHostToDevice);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemcpy(multilayer_active_mask)", err);
                return fail();
            }
        }
    }

    for (uint32_t i = 0; i < plan.kernel_count; ++i) {
        const fullmag_fdm_tensor_kernel_desc_v2 &src = plan.kernels[i];
        ctx.multilayer_kernels.emplace_back();
        DeviceMultilayerTensorKernel &dst = ctx.multilayer_kernels.back();
        dst.fft_grid = src.fft_grid;
        dst.dst_layer = src.dst_layer;
        dst.src_layer = src.src_layer;
        dst.z_shift_meters = src.z_shift_meters;
        dst.kernel_len = src.kernel_len;

        if (!alloc_tensor_kernel_cells(ctx, dst.tensor, dst.kernel_len, "multilayer_kernel")) {
            return fail();
        }
        if (!upload_tensor_kernel_component(
                ctx, dst.tensor.xx, src.kernel_xx, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_xx)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.yy, src.kernel_yy, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_yy)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.zz, src.kernel_zz, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_zz)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.xy, src.kernel_xy, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_xy)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.xz, src.kernel_xz, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_xz)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.yz, src.kernel_yz, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_yz)"))
        {
            return fail();
        }
    }

    if (ctx.enable_demag && !ctx.multilayer_kernels.empty()) {
        for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
            if (!build_and_upload_push_map(ctx, layer)) {
                return fail();
            }
        }
        for (DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
            DeviceMultilayerLayer &dst_layer = ctx.multilayer_layers[kernel.dst_layer];
            if (!build_and_upload_kernel_pull_map(ctx, kernel, dst_layer)) {
                return fail();
            }
        }
    }

    return true;
}

bool context_prepare_multilayer_fft_workspace_v2(Context &ctx) {
    if (!ctx.has_multilayer_plan_v2 || !ctx.enable_demag) {
        return true;
    }
    if (ctx.multilayer_kernels.empty()) {
        ctx.last_error = "multilayer FFT workspace requires at least one tensor kernel";
        return false;
    }

    const DeviceMultilayerTensorKernel &first = ctx.multilayer_kernels.front();
    if (!context_prepare_multilayer_fft_workspace_for_kernel(ctx, first)) {
        return false;
    }
    return context_prepare_multilayer_batch_fft_workspace_v2(ctx);
}

static bool multilayer_grid_shape_matches(
    const fullmag_fdm_grid_desc &lhs,
    const fullmag_fdm_grid_desc &rhs)
{
    return lhs.nx == rhs.nx && lhs.ny == rhs.ny && lhs.nz == rhs.nz &&
        lhs.dx == rhs.dx && lhs.dy == rhs.dy && lhs.dz == rhs.dz;
}

static bool multilayer_grid_fits_fft(
    const fullmag_fdm_grid_desc &layer_grid,
    const fullmag_fdm_grid_desc &fft_grid)
{
    return layer_grid.nx <= fft_grid.nx &&
        layer_grid.ny <= fft_grid.ny &&
        layer_grid.nz <= fft_grid.nz &&
        layer_grid.dx == fft_grid.dx &&
        layer_grid.dy == fft_grid.dy &&
        layer_grid.dz == fft_grid.dz;
}

bool context_prepare_multilayer_batch_fft_workspace_v2(Context &ctx) {
    if (!ctx.has_multilayer_plan_v2 || !ctx.enable_demag) {
        return true;
    }
    if (ctx.multilayer_layers.empty() || ctx.multilayer_kernels.empty()) {
        ctx.last_error =
            "D-07 batched multilayer workspace requires layers and tensor kernels";
        return false;
    }

    // push_pull is intentionally retained for the host-authoritative assisted
    // lane.  It needs per-layer transfer maps and is not a device-resident D-07
    // refresh, so it must not allocate or masquerade as this workspace.
    for (const DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        if (layer.transfer_kind != FULLMAG_FDM_TRANSFER_IDENTITY) {
            return true;
        }
    }

    const uint64_t layer_count = ctx.multilayer_layers.size();
    if (layer_count > std::numeric_limits<uint32_t>::max()) {
        ctx.last_error = "D-07 batched multilayer layer count exceeds uint32";
        return false;
    }
    const uint64_t expected_kernel_count = layer_count * layer_count;
    if (ctx.multilayer_kernels.size() != expected_kernel_count) {
        ctx.last_error =
            "D-07 batched multilayer workspace requires exactly L^2 tensor kernels";
        return false;
    }

    const DeviceMultilayerLayer &first_layer = ctx.multilayer_layers.front();
    if (!multilayer_grid_shape_matches(
            first_layer.native_grid, first_layer.convolution_grid))
    {
        ctx.last_error =
            "D-07 batched multilayer workspace requires identity native/convolution grids";
        return false;
    }
    for (const DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        if (layer.transfer_kind != FULLMAG_FDM_TRANSFER_IDENTITY ||
            !multilayer_grid_shape_matches(layer.native_grid, first_layer.native_grid) ||
            !multilayer_grid_shape_matches(layer.convolution_grid, first_layer.convolution_grid))
        {
            ctx.last_error =
                "D-07 batched multilayer workspace requires one common identity layer grid";
            return false;
        }
    }

    const fullmag_fdm_grid_desc &fft_grid = ctx.multilayer_kernels.front().fft_grid;
    const uint64_t fft_cell_count = grid_cell_count(fft_grid);
    if (fft_cell_count == 0 || !multilayer_grid_fits_fft(first_layer.native_grid, fft_grid)) {
        ctx.last_error =
            "D-07 batched multilayer workspace requires a common padded FFT grid";
        return false;
    }
    for (const DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
        if (kernel.kernel_len != fft_cell_count ||
            !multilayer_grid_shape_matches(kernel.fft_grid, fft_grid) ||
            kernel.src_layer >= layer_count || kernel.dst_layer >= layer_count)
        {
            ctx.last_error =
                "D-07 batched multilayer workspace requires one common FFT grid and valid layer pairs";
            return false;
        }
    }

    if (ctx.multilayer_batch_layer_count == layer_count &&
        ctx.multilayer_batch_component_stride == fft_cell_count &&
        ctx.multilayer_batch_layer_stride == fft_cell_count * 3u &&
        ctx.multilayer_batch_source_fft_x != nullptr &&
        ctx.multilayer_batch_source_fft_y != nullptr &&
        ctx.multilayer_batch_source_fft_z != nullptr &&
        ctx.multilayer_batch_destination_fft_x != nullptr &&
        ctx.multilayer_batch_destination_fft_y != nullptr &&
        ctx.multilayer_batch_destination_fft_z != nullptr)
    {
        return true;
    }

    free_multilayer_batch_fft_buffers(ctx);
    if (fft_cell_count > std::numeric_limits<uint64_t>::max() / 3u) {
        ctx.last_error = "D-07 batched multilayer layer stride overflows uint64";
        return false;
    }
    const uint64_t component_stride = fft_cell_count;
    const uint64_t layer_stride = component_stride * 3u;
    if (layer_count > std::numeric_limits<uint64_t>::max() / layer_stride) {
        ctx.last_error = "D-07 batched multilayer spectrum size overflows uint64";
        return false;
    }
    const uint64_t allocation_element_count = layer_count * layer_stride;
    const size_t element_bytes = complex_size(ctx.precision);
    if (allocation_element_count > std::numeric_limits<size_t>::max() / element_bytes)
    {
        ctx.last_error = "D-07 batched multilayer spectrum allocation size overflows size_t";
        return false;
    }
    const size_t component_bytes = static_cast<size_t>(component_stride) * element_bytes;
    const size_t allocation_bytes = static_cast<size_t>(allocation_element_count) * element_bytes;

    void *source_allocation = nullptr;
    void *destination_allocation = nullptr;
    cudaError_t err = cudaMalloc(&source_allocation, allocation_bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(multilayer_batch_source_fft)", err);
        return false;
    }
    err = cudaMalloc(&destination_allocation, allocation_bytes);
    if (err != cudaSuccess) {
        cudaFree(source_allocation);
        set_cuda_error(ctx, "cudaMalloc(multilayer_batch_destination_fft)", err);
        return false;
    }

    auto component = [component_bytes](void *base, unsigned index) -> void * {
        return static_cast<void *>(
            static_cast<unsigned char *>(base) + component_bytes * index);
    };
    ctx.multilayer_batch_source_fft_x = source_allocation;
    ctx.multilayer_batch_source_fft_y = component(source_allocation, 1);
    ctx.multilayer_batch_source_fft_z = component(source_allocation, 2);
    ctx.multilayer_batch_destination_fft_x = destination_allocation;
    ctx.multilayer_batch_destination_fft_y = component(destination_allocation, 1);
    ctx.multilayer_batch_destination_fft_z = component(destination_allocation, 2);
    ctx.multilayer_batch_component_stride = component_stride;
    ctx.multilayer_batch_layer_stride = layer_stride;
    ctx.multilayer_batch_layer_count = static_cast<uint32_t>(layer_count);
    ctx.multilayer_batch_components_share_allocation = true;
    return true;
}

bool context_prepare_multilayer_fft_workspace_for_kernel(
    Context &ctx,
    const DeviceMultilayerTensorKernel &kernel)
{
    if (!ctx.has_multilayer_plan_v2 || !ctx.enable_demag) {
        return true;
    }

    if (kernel.kernel_len != grid_cell_count(kernel.fft_grid)) {
        ctx.last_error =
            "multilayer FFT workspace kernel length must match the tensor-kernel grid";
        return false;
    }

    if (!context_create_compute_stream(ctx)) {
        return false;
    }

    if (ctx.fft_workspace_bound_to_multilayer_cache &&
        ctx.fft_plan_valid &&
        ctx.fft_x != nullptr &&
        ctx.fft_y != nullptr &&
        ctx.fft_z != nullptr &&
        ctx.fft_nx == kernel.fft_grid.nx &&
        ctx.fft_ny == kernel.fft_grid.ny &&
        ctx.fft_nz == kernel.fft_grid.nz &&
        ctx.fft_cell_count == kernel.kernel_len)
    {
        return true;
    }

    DeviceMultilayerFftWorkspace *workspace =
        ensure_multilayer_fft_workspace(ctx, kernel.fft_grid, kernel.kernel_len);
    if (!workspace) {
        return false;
    }
    bind_multilayer_fft_workspace(ctx, *workspace);
    return true;
}

/* ── Boundary correction upload ── */

static void free_anisotropy_fields(Context &ctx) {
    auto free_f64 = [](double *&ptr) {
        if (ptr) { cudaFree(ptr); ptr = nullptr; }
    };
    free_f64(ctx.ku1_field);
    free_f64(ctx.ku2_field);
}

bool context_upload_anisotropy_fields(Context &ctx, const double *ku1, const double *ku2, uint64_t len) {
    if (!ctx.has_uniaxial_anisotropy || len != ctx.cell_count) {
        return true;
    }
    if (ku1) {
        if (!upload_f64_array(ctx, ctx.ku1_field, ku1, len, "cudaMalloc(ku1_field)")) return false;
    }
    if (ku2) {
        if (!upload_f64_array(ctx, ctx.ku2_field, ku2, len, "cudaMalloc(ku2_field)")) return false;
    }
    return true;
}

static void free_cubic_anisotropy_fields(Context &ctx) {
    auto free_f64 = [](double *&ptr) {
        if (ptr) { cudaFree(ptr); ptr = nullptr; }
    };
    free_f64(ctx.kc1_field);
    free_f64(ctx.kc2_field);
    free_f64(ctx.kc3_field);
}

bool context_upload_cubic_anisotropy_fields(Context &ctx, const double *kc1, const double *kc2, const double *kc3, uint64_t len) {
    if (!ctx.has_cubic_anisotropy || len != ctx.cell_count) {
        return true;
    }
    if (kc1) {
        if (!upload_f64_array(ctx, ctx.kc1_field, kc1, len, "cudaMalloc(kc1_field)")) return false;
    }
    if (kc2) {
        if (!upload_f64_array(ctx, ctx.kc2_field, kc2, len, "cudaMalloc(kc2_field)")) return false;
    }
    if (kc3) {
        if (!upload_f64_array(ctx, ctx.kc3_field, kc3, len, "cudaMalloc(kc3_field)")) return false;
    }
    return true;
}

static void free_boundary_correction(Context &ctx) {
    auto free_f64 = [](double *&ptr) {
        if (ptr) { cudaFree(ptr); ptr = nullptr; }
    };
    free_f64(ctx.volume_fraction);
    free_f64(ctx.face_link_xp); free_f64(ctx.face_link_xm);
    free_f64(ctx.face_link_yp); free_f64(ctx.face_link_ym);
    free_f64(ctx.face_link_zp); free_f64(ctx.face_link_zm);
    free_f64(ctx.delta_xp); free_f64(ctx.delta_xm);
    free_f64(ctx.delta_yp); free_f64(ctx.delta_ym);
    free_f64(ctx.delta_zp); free_f64(ctx.delta_zm);
    if (ctx.demag_corr_target_idx) { cudaFree(ctx.demag_corr_target_idx); ctx.demag_corr_target_idx = nullptr; }
    if (ctx.demag_corr_source_idx) { cudaFree(ctx.demag_corr_source_idx); ctx.demag_corr_source_idx = nullptr; }
    if (ctx.demag_corr_tensor)     { cudaFree(ctx.demag_corr_tensor);     ctx.demag_corr_tensor = nullptr; }
    ctx.boundary_tier = 0;
    ctx.has_demag_boundary_corr = false;
}

static bool upload_f64_array(Context &ctx, double *&dst, const double *src,
                              uint64_t count, const char *label) {
    size_t bytes = count * sizeof(double);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&dst), bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, label, err); return false; }
    err = cudaMemcpy(dst, src, bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, label, err); return false; }
    return true;
}

bool context_upload_boundary_correction(
    Context &ctx,
    uint8_t tier,
    double phi_floor,
    double delta_min,
    const double *volume_fraction,
    const double *face_link_xp, const double *face_link_xm,
    const double *face_link_yp, const double *face_link_ym,
    const double *face_link_zp, const double *face_link_zm,
    const double *delta_xp, const double *delta_xm,
    const double *delta_yp, const double *delta_ym,
    const double *delta_zp, const double *delta_zm,
    uint64_t cell_count)
{
    if (tier == 0 || cell_count != ctx.cell_count) {
        return true; // nothing to upload
    }
    if (!volume_fraction) {
        ctx.last_error = "boundary_correction: volume_fraction is required";
        return false;
    }

    ctx.boundary_tier = tier;
    ctx.phi_floor = (phi_floor > 0.0) ? phi_floor : 0.05;
    ctx.delta_min = (delta_min > 0.0) ? delta_min
                  : 0.1 * fmin(fmin(ctx.dx, ctx.dy), ctx.dz);

    uint64_t n = ctx.cell_count;
    if (!upload_f64_array(ctx, ctx.volume_fraction, volume_fraction, n, "cudaMalloc(volume_fraction)"))
        return false;

    // Face links (T0+T1)
    if (face_link_xp && face_link_xm && face_link_yp && face_link_ym
        && face_link_zp && face_link_zm)
    {
        if (!upload_f64_array(ctx, ctx.face_link_xp, face_link_xp, n, "face_link_xp")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_xm, face_link_xm, n, "face_link_xm")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_yp, face_link_yp, n, "face_link_yp")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_ym, face_link_ym, n, "face_link_ym")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_zp, face_link_zp, n, "face_link_zp")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_zm, face_link_zm, n, "face_link_zm")) return false;
    }

    // Intersection distances (T1 only)
    if (tier >= 2 && delta_xp && delta_xm && delta_yp && delta_ym
        && delta_zp && delta_zm)
    {
        if (!upload_f64_array(ctx, ctx.delta_xp, delta_xp, n, "delta_xp")) return false;
        if (!upload_f64_array(ctx, ctx.delta_xm, delta_xm, n, "delta_xm")) return false;
        if (!upload_f64_array(ctx, ctx.delta_yp, delta_yp, n, "delta_yp")) return false;
        if (!upload_f64_array(ctx, ctx.delta_ym, delta_ym, n, "delta_ym")) return false;
        if (!upload_f64_array(ctx, ctx.delta_zp, delta_zp, n, "delta_zp")) return false;
        if (!upload_f64_array(ctx, ctx.delta_zm, delta_zm, n, "delta_zm")) return false;
    }

    return true;
}

bool context_upload_demag_boundary_corr(
    Context &ctx,
    const int32_t *target_idx,
    const int32_t *source_idx,
    const double *tensor,
    uint32_t target_count,
    uint32_t stencil_size)
{
    if (target_count == 0 || stencil_size == 0 || !target_idx || !source_idx || !tensor) {
        return true; // nothing to upload
    }

    ctx.demag_corr_target_count = target_count;
    ctx.demag_corr_stencil_size = stencil_size;

    // Target indices
    {
        size_t bytes = target_count * sizeof(int32_t);
        cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.demag_corr_target_idx), bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(demag_target_idx)", err); return false; }
        err = cudaMemcpy(ctx.demag_corr_target_idx, target_idx, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(demag_target_idx)", err); return false; }
    }

    // Source indices
    {
        size_t bytes = (uint64_t)target_count * stencil_size * sizeof(int32_t);
        cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.demag_corr_source_idx), bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(demag_source_idx)", err); return false; }
        err = cudaMemcpy(ctx.demag_corr_source_idx, source_idx, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(demag_source_idx)", err); return false; }
    }

    // Correction tensors (6 components per pair)
    {
        size_t bytes = (uint64_t)target_count * stencil_size * 6 * sizeof(double);
        cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.demag_corr_tensor), bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(demag_tensor)", err); return false; }
        err = cudaMemcpy(ctx.demag_corr_tensor, tensor, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(demag_tensor)", err); return false; }
    }

    ctx.has_demag_boundary_corr = true;
    return true;
}

/* ── Oersted field precomputation (infinite cylinder, Ampère's law) ──
 *
 * For a z-axis cylinder carrying unit current I = 1 A:
 *   inside  (r < R):  H_phi = r / (2π R²)
 *   outside (r >= R):  H_phi = 1 / (2π r)
 *
 * H_x = -H_phi * sin(phi) = -H_phi * (y - cy) / r
 * H_y = +H_phi * cos(phi) = +H_phi * (x - cx) / r
 * H_z = 0
 *
 * For non-z axes we apply a rotation matrix.
 * The result is stored in h_oe_static for I=1A; at runtime it is scaled
 * by oersted_current * time_envelope(t).
 */
bool context_precompute_oersted_field(Context &ctx) {
    if (!ctx.has_oersted_cylinder) return true;

    uint64_t n = ctx.cell_count;
    double R = ctx.oersted_radius;
    const double center[3] = {
        ctx.oersted_center[0],
        ctx.oersted_center[1],
        ctx.oersted_center[2],
    };
    const double axis_norm = sqrt(
        ctx.oersted_axis[0] * ctx.oersted_axis[0]
        + ctx.oersted_axis[1] * ctx.oersted_axis[1]
        + ctx.oersted_axis[2] * ctx.oersted_axis[2]);

    if (R <= 0.0) {
        ctx.last_error = "oersted_radius must be positive";
        return false;
    }
    if (!isfinite(axis_norm) || axis_norm <= 1e-30) {
        ctx.last_error = "oersted_axis must be finite and nonzero";
        return false;
    }
    const double axis[3] = {
        ctx.oersted_axis[0] / axis_norm,
        ctx.oersted_axis[1] / axis_norm,
        ctx.oersted_axis[2] / axis_norm,
    };

    double inv_2pi = 1.0 / (2.0 * M_PI);
    double R2 = R * R;

    // Compute on host in SoA layout
    std::vector<double> hx(n), hy(n), hz(n);

    for (uint64_t idx = 0; idx < n; ++idx) {
        uint64_t iz = idx / (ctx.ny * ctx.nx);
        uint64_t rem = idx - iz * ctx.ny * ctx.nx;
        uint64_t iy = rem / ctx.nx;
        uint64_t ix = rem - iy * ctx.nx;

        const double rel[3] = {
            (ix + 0.5) * ctx.dx - center[0],
            (iy + 0.5) * ctx.dy - center[1],
            (iz + 0.5) * ctx.dz - center[2],
        };
        const double axial = rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2];
        const double radial[3] = {
            rel[0] - axial * axis[0],
            rel[1] - axial * axis[1],
            rel[2] - axial * axis[2],
        };
        const double r = sqrt(
            radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2]);

        double H_phi;
        if (r < 1e-30) {
            // At exact center, field is zero (by symmetry)
            H_phi = 0.0;
        } else if (r < R) {
            // Inside: H_phi = I * r / (2 * pi * R^2)  for I = 1 A
            H_phi = inv_2pi * r / R2;
        } else {
            // Outside: H_phi = I / (2 * pi * r)  for I = 1 A
            H_phi = inv_2pi / r;
        }

        if (r < 1e-30) {
            hx[idx] = 0.0;
            hy[idx] = 0.0;
            hz[idx] = 0.0;
            continue;
        }
        const double rhat[3] = {radial[0] / r, radial[1] / r, radial[2] / r};
        const double phi_hat[3] = {
            axis[1] * rhat[2] - axis[2] * rhat[1],
            axis[2] * rhat[0] - axis[0] * rhat[2],
            axis[0] * rhat[1] - axis[1] * rhat[0],
        };
        hx[idx] = H_phi * phi_hat[0];
        hy[idx] = H_phi * phi_hat[1];
        hz[idx] = H_phi * phi_hat[2];
    }

    // Upload to device
    size_t bytes = n * scalar_size(ctx.precision);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        cudaError_t err;
        err = cudaMemcpy(ctx.h_oe_static.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_z)", err); return false; }
    } else {
        // Convert to float and upload
        std::vector<float> hx_f(n), hy_f(n), hz_f(n);
        for (uint64_t i = 0; i < n; ++i) {
            hx_f[i] = static_cast<float>(hx[i]);
            hy_f[i] = static_cast<float>(hy[i]);
            hz_f[i] = static_cast<float>(hz[i]);
        }
        cudaError_t err;
        err = cudaMemcpy(ctx.h_oe_static.x, hx_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_z)", err); return false; }
    }

    return true;
}

bool context_upload_oersted_field(Context &ctx, const double *field_xyz, uint64_t len) {
    if (!ctx.has_oersted_field || field_xyz == nullptr) {
        return true;
    }
    if (len != ctx.cell_count * 3u) {
        ctx.last_error = "oersted_field_len mismatch";
        return false;
    }
    return upload_cell_profile(ctx, field_xyz, len, "oersted_field");
}

bool context_mark_static_external_field_profile(
    Context &ctx,
    const double *field_xyz,
    uint64_t len)
{
    if (ctx.has_oersted_cylinder) {
        ctx.last_error =
            "static external field profile cannot be combined with OerstedCylinder";
        return false;
    }
    if (ctx.has_oersted_field) {
        ctx.last_error =
            "static external field profile cannot reuse an Oersted field profile";
        return false;
    }
    if (!field_xyz || len != ctx.cell_count * 3u) {
        ctx.last_error = "static external field profile requires a cell-wise field";
        return false;
    }
    if (!upload_cell_profile(ctx, field_xyz, len, "static external field profile")) {
        return false;
    }
    ctx.has_static_external_field_profile = true;
    return true;
}

template <typename HostScalar>
static bool context_upload_magnetization_impl(Context &ctx, const HostScalar *m_xyz, uint64_t len) {
    uint64_t n = ctx.cell_count;
    if (!m_xyz || len != n * 3) {
        ctx.last_error = "magnetization length mismatch";
        return false;
    }

    size_t bytes = n * scalar_size(ctx.precision);
    auto upload_component = [&](void *dst, const void *src, const char *label) -> bool {
        cudaError_t err = cudaMemcpy(dst, src, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, label, err);
            return false;
        }
        return true;
    };

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(n), hy(n), hz(n);
        for (uint64_t i = 0; i < n; i++) {
            bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
            hx[i] = is_active ? static_cast<double>(m_xyz[3 * i + 0]) : 0.0;
            hy[i] = is_active ? static_cast<double>(m_xyz[3 * i + 1]) : 0.0;
            hz[i] = is_active ? static_cast<double>(m_xyz[3 * i + 2]) : 0.0;
        }
        const bool uploaded = upload_component(ctx.m.x, hx.data(), "cudaMemcpy(m.x)")
            && upload_component(ctx.m.y, hy.data(), "cudaMemcpy(m.y)")
            && upload_component(ctx.m.z, hz.data(), "cudaMemcpy(m.z)");
        if (uploaded) context_reset_integrator_history(ctx);
        return uploaded;
    }

    std::vector<float> hx(n), hy(n), hz(n);
    for (uint64_t i = 0; i < n; i++) {
        bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
        hx[i] = is_active ? static_cast<float>(m_xyz[3 * i + 0]) : 0.0f;
        hy[i] = is_active ? static_cast<float>(m_xyz[3 * i + 1]) : 0.0f;
        hz[i] = is_active ? static_cast<float>(m_xyz[3 * i + 2]) : 0.0f;
    }
    const bool uploaded = upload_component(ctx.m.x, hx.data(), "cudaMemcpy(m.x)")
        && upload_component(ctx.m.y, hy.data(), "cudaMemcpy(m.y)")
        && upload_component(ctx.m.z, hz.data(), "cudaMemcpy(m.z)");
    if (uploaded) context_reset_integrator_history(ctx);
    return uploaded;
}

bool context_upload_magnetization_f64(Context &ctx, const double *m_xyz, uint64_t len) {
    return context_upload_magnetization_impl(ctx, m_xyz, len);
}

bool context_upload_magnetization_f32(Context &ctx, const float *m_xyz, uint64_t len) {
    return context_upload_magnetization_impl(ctx, m_xyz, len);
}

template <typename HostScalar>
static bool context_upload_layer_magnetization_impl(
    Context &ctx,
    uint32_t layer_index,
    const HostScalar *m_xyz,
    uint64_t len)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "per-layer magnetization upload requires a staged v2 multilayer plan";
        return false;
    }
    if (layer_index >= ctx.multilayer_layers.size()) {
        ctx.last_error = "layer_index out of range";
        return false;
    }

    DeviceMultilayerLayer &layer = ctx.multilayer_layers[layer_index];
    if (!m_xyz || len != layer.cell_count * 3) {
        ctx.last_error = "layer magnetization length mismatch";
        return false;
    }

    const bool uploaded = upload_vector_field_aos_host(
        ctx,
        layer.m,
        m_xyz,
        layer.cell_count,
        "cudaMemcpy(multilayer_layer_m)");
    if (uploaded) context_reset_integrator_history(ctx);
    return uploaded;
}

bool context_upload_layer_magnetization_f64(
    Context &ctx,
    uint32_t layer_index,
    const double *m_xyz,
    uint64_t len)
{
    return context_upload_layer_magnetization_impl(ctx, layer_index, m_xyz, len);
}

bool context_upload_layer_magnetization_f32(
    Context &ctx,
    uint32_t layer_index,
    const float *m_xyz,
    uint64_t len)
{
    return context_upload_layer_magnetization_impl(ctx, layer_index, m_xyz, len);
}

template <typename HostScalar>
static bool context_download_field_impl(
    Context &ctx,
    fullmag_fdm_observable observable,
    HostScalar *out_xyz,
    uint64_t out_len)
{
    uint64_t n = ctx.cell_count;
    if (!out_xyz || out_len != n * 3) {
        return false;
    }

    uint64_t required_mask = 0;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            required_mask = OBSERVABLE_ENDPOINT_H_EX; break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            required_mask = OBSERVABLE_ENDPOINT_H_DEMAG; break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            required_mask = OBSERVABLE_ENDPOINT_H_ANI; break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            required_mask = OBSERVABLE_ENDPOINT_H_EFF_VISUAL; break;
        default:
            break;
    }
    if (required_mask != 0 &&
        !context_ensure_observable_fields(ctx, required_mask)) return false;

    const DeviceVectorField *field;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M: field = &ctx.m; break;
        case FULLMAG_FDM_OBSERVABLE_H_EX: field = &ctx.h_ex; break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            if (ctx.h_demag_visual.x == nullptr || ctx.h_demag_visual.y == nullptr ||
                ctx.h_demag_visual.z == nullptr) {
                ctx.last_error = "demag_visual_buffer_unavailable";
                return false;
            }
            field = &ctx.h_demag_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI: field = &ctx.h_ani; break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF: field = &ctx.h_eff_visual; break;
        case FULLMAG_FDM_OBSERVABLE_H_OE: {
            if (ctx.has_static_external_field_profile) {
                std::fill(out_xyz, out_xyz + (n * 3u), static_cast<HostScalar>(0.0));
                return true;
            }
            const double scale = oersted_field_scale(ctx, ctx.current_time);
            for (uint64_t i = 0; i < n; i++) {
                const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                out_xyz[3 * i + 0] = 0.0;
                out_xyz[3 * i + 1] = 0.0;
                out_xyz[3 * i + 2] = 0.0;
                if (!ctx.has_oersted_field || !is_active || scale == 0.0) {
                    continue;
                }
            }
            const DeviceVectorField *oe_field = ctx.has_oersted_field ? &ctx.h_oe_static : nullptr;
            auto copy_components = [&](auto tag) -> bool {
                using DeviceScalar = decltype(tag);
                std::vector<DeviceScalar> hx(n), hy(n), hz(n);
                size_t bytes = n * sizeof(DeviceScalar);
                cudaError_t err = cudaMemcpy(hx.data(), oe_field->x, bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) {
                    set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_oe.x)", err);
                    return false;
                }
                err = cudaMemcpy(hy.data(), oe_field->y, bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) {
                    set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_oe.y)", err);
                    return false;
                }
                err = cudaMemcpy(hz.data(), oe_field->z, bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) {
                    set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_oe.z)", err);
                    return false;
                }
                for (uint64_t i = 0; i < n; i++) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    if (!is_active) {
                        continue;
                    }
                    out_xyz[3 * i + 0] = static_cast<HostScalar>(scale * static_cast<double>(hx[i]));
                    out_xyz[3 * i + 1] = static_cast<HostScalar>(scale * static_cast<double>(hy[i]));
                    out_xyz[3 * i + 2] = static_cast<HostScalar>(scale * static_cast<double>(hz[i]));
                }
                return true;
            };
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                return copy_components(double{0.0});
            }
            return copy_components(float{0.0f});
        }
        case FULLMAG_FDM_OBSERVABLE_H_EXT: {
            if (ctx.has_static_external_field_profile) {
                const DeviceVectorField *profile = &ctx.h_oe_static;
                auto copy_profile = [&](auto tag) -> bool {
                    using DeviceScalar = decltype(tag);
                    std::vector<DeviceScalar> hx(n), hy(n), hz(n);
                    size_t bytes = n * sizeof(DeviceScalar);
                    cudaError_t err = cudaMemcpy(hx.data(), profile->x, bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) { set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_ext_profile.x)", err); return false; }
                    err = cudaMemcpy(hy.data(), profile->y, bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) { set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_ext_profile.y)", err); return false; }
                    err = cudaMemcpy(hz.data(), profile->z, bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) { set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_ext_profile.z)", err); return false; }
                    for (uint64_t i = 0; i < n; ++i) {
                        const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                        out_xyz[3u * i + 0] = is_active
                            ? static_cast<HostScalar>(ctx.external_field[0] + static_cast<double>(hx[i]))
                            : static_cast<HostScalar>(0.0);
                        out_xyz[3u * i + 1] = is_active
                            ? static_cast<HostScalar>(ctx.external_field[1] + static_cast<double>(hy[i]))
                            : static_cast<HostScalar>(0.0);
                        out_xyz[3u * i + 2] = is_active
                            ? static_cast<HostScalar>(ctx.external_field[2] + static_cast<double>(hz[i]))
                            : static_cast<HostScalar>(0.0);
                    }
                    return true;
                };
                return ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
                    ? copy_profile(double{0.0})
                    : copy_profile(float{0.0f});
            }
            for (uint64_t i = 0; i < n; i++) {
                bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                out_xyz[3 * i + 0] = (ctx.has_external_field && is_active)
                    ? static_cast<HostScalar>(ctx.external_field[0])
                    : static_cast<HostScalar>(0.0);
                out_xyz[3 * i + 1] = (ctx.has_external_field && is_active)
                    ? static_cast<HostScalar>(ctx.external_field[1])
                    : static_cast<HostScalar>(0.0);
                out_xyz[3 * i + 2] = (ctx.has_external_field && is_active)
                    ? static_cast<HostScalar>(ctx.external_field[2])
                    : static_cast<HostScalar>(0.0);
            }
            return true;
        }
        default:
            return false;
    }

    auto copy_components = [&](auto tag) -> bool {
        using DeviceScalar = decltype(tag);
        std::vector<DeviceScalar> hx(n), hy(n), hz(n);
        size_t bytes = n * sizeof(DeviceScalar);
        cudaError_t err = cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(field.x)", err);
            return false;
        }
        err = cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(field.y)", err);
            return false;
        }
        err = cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(field.z)", err);
            return false;
        }
        for (uint64_t i = 0; i < n; i++) {
            out_xyz[3 * i + 0] = static_cast<HostScalar>(hx[i]);
            out_xyz[3 * i + 1] = static_cast<HostScalar>(hy[i]);
            out_xyz[3 * i + 2] = static_cast<HostScalar>(hz[i]);
        }
        return true;
    };

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        return copy_components(double{});
    }
    return copy_components(float{});
}

bool context_download_field_f64(
    Context &ctx,
    fullmag_fdm_observable observable,
    double *out_xyz,
    uint64_t out_len)
{
    return context_download_field_impl(ctx, observable, out_xyz, out_len);
}

bool context_download_field_f32(
    Context &ctx,
    fullmag_fdm_observable observable,
    float *out_xyz,
    uint64_t out_len)
{
    return context_download_field_impl(ctx, observable, out_xyz, out_len);
}

static bool is_energy_density_observable(fullmag_fdm_observable observable) {
    return observable >= FULLMAG_FDM_OBSERVABLE_EDEN_EX &&
        observable <= FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL;
}

template <typename HostScalar>
static bool context_download_scalar_impl(
    Context &ctx,
    fullmag_fdm_observable observable,
    HostScalar *out_values,
    uint64_t out_len)
{
    if (!out_values || out_len != ctx.cell_count) {
        ctx.last_error = "scalar_out_len_mismatch";
        return false;
    }
    if (!is_energy_density_observable(observable)) {
        ctx.last_error = "unsupported scalar observable";
        return false;
    }
    if (!context_refresh_energy_density_observable(ctx, observable)) {
        return false;
    }

    const size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> values(ctx.cell_count);
        cudaError_t err = cudaMemcpy(
            values.data(), ctx.energy_density, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(energy_density)", err);
            return false;
        }
        for (uint64_t index = 0; index < ctx.cell_count; ++index) {
            out_values[index] = static_cast<HostScalar>(values[index]);
        }
    } else {
        std::vector<float> values(ctx.cell_count);
        cudaError_t err = cudaMemcpy(
            values.data(), ctx.energy_density, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(energy_density)", err);
            return false;
        }
        for (uint64_t index = 0; index < ctx.cell_count; ++index) {
            out_values[index] = static_cast<HostScalar>(values[index]);
        }
    }
    return true;
}

bool context_download_scalar_f64(
    Context &ctx,
    fullmag_fdm_observable observable,
    double *out_values,
    uint64_t out_len)
{
    return context_download_scalar_impl(ctx, observable, out_values, out_len);
}

bool context_download_scalar_f32(
    Context &ctx,
    fullmag_fdm_observable observable,
    float *out_values,
    uint64_t out_len)
{
    return context_download_scalar_impl(ctx, observable, out_values, out_len);
}

static bool context_refresh_multilayer_exchange_observable(Context &ctx)
{
    if (!ctx.enable_exchange) {
        return true;
    }
    ctx.last_error.clear();
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        launch_multilayer_exchange_field_fp64(ctx);
    } else {
        launch_multilayer_exchange_field_fp32(ctx);
    }
    return ctx.last_error.empty();
}

template <typename HostScalar>
static bool context_download_layer_field_impl(
    Context &ctx,
    uint32_t layer_index,
    fullmag_fdm_observable observable,
    HostScalar *out_xyz,
    uint64_t out_len)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "per-layer field copy requires a staged v2 multilayer plan";
        return false;
    }
    if (layer_index >= ctx.multilayer_layers.size()) {
        ctx.last_error = "layer_index out of range";
        return false;
    }

    const DeviceMultilayerLayer &layer = ctx.multilayer_layers[layer_index];
    if (!out_xyz || out_len != layer.cell_count * 3) {
        ctx.last_error = "layer out_len mismatch";
        return false;
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_EX
        && !context_refresh_multilayer_exchange_observable(ctx))
    {
        return false;
    }
    if (observable == FULLMAG_FDM_OBSERVABLE_H_DMI) {
        const bool ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_dmi_field_fp64(ctx)
            : launch_multilayer_dmi_field_fp32(ctx);
        if (!ok) {
            return false;
        }
    }
    if (observable == FULLMAG_FDM_OBSERVABLE_H_ANI) {
        const bool ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_anisotropy_field_fp64(ctx)
            : launch_multilayer_anisotropy_field_fp32(ctx);
        if (!ok) {
            return false;
        }
    }
    if (observable == FULLMAG_FDM_OBSERVABLE_H_EFF) {
        if (!context_refresh_multilayer_exchange_observable(ctx)) {
            return false;
        }
        const bool dmi_ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_dmi_field_fp64(ctx)
            : launch_multilayer_dmi_field_fp32(ctx);
        if (!dmi_ok) {
            return false;
        }
        const bool anisotropy_ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_anisotropy_field_fp64(ctx)
            : launch_multilayer_anisotropy_field_fp32(ctx);
        if (!anisotropy_ok) {
            return false;
        }
        const bool effective_ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_effective_field_fp64(ctx)
            : launch_multilayer_effective_field_fp32(ctx);
        if (!effective_ok) {
            return false;
        }
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_EXT) {
        const uint64_t n = layer.cell_count;
        std::vector<uint8_t> active_mask;
        if (layer.has_active_mask) {
            active_mask.resize(n);
            cudaError_t err = cudaMemcpy(
                active_mask.data(),
                layer.active_mask,
                static_cast<size_t>(n) * sizeof(uint8_t),
                cudaMemcpyDeviceToHost);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_h_ext_active_mask)", err);
                return false;
            }
        }
        for (uint64_t i = 0; i < n; ++i) {
            const bool is_active = !layer.has_active_mask || active_mask[i] != 0;
            out_xyz[i * 3 + 0] = (ctx.has_external_field && is_active)
                ? static_cast<HostScalar>(ctx.external_field[0])
                : HostScalar{};
            out_xyz[i * 3 + 1] = (ctx.has_external_field && is_active)
                ? static_cast<HostScalar>(ctx.external_field[1])
                : HostScalar{};
            out_xyz[i * 3 + 2] = (ctx.has_external_field && is_active)
                ? static_cast<HostScalar>(ctx.external_field[2])
                : HostScalar{};
        }
        return true;
    }

    const DeviceVectorField *field = nullptr;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:
            field = &layer.m;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            field = &layer.h_ex;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            field = &layer.h_demag;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DMI:
            field = &layer.h_dmi;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            field = &layer.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &layer.tmp;
            break;
        default:
            ctx.last_error = "unsupported multilayer layer observable";
            return false;
    }

    auto copy_components = [&](auto tag) -> bool {
        using DeviceScalar = decltype(tag);
        const uint64_t n = layer.cell_count;
        std::vector<DeviceScalar> hx(n), hy(n), hz(n);
        const size_t bytes = static_cast<size_t>(n) * sizeof(DeviceScalar);
        cudaError_t err = cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_field.x)", err);
            return false;
        }
        err = cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_field.y)", err);
            return false;
        }
        err = cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_field.z)", err);
            return false;
        }
        for (uint64_t i = 0; i < n; ++i) {
            out_xyz[i * 3 + 0] = static_cast<HostScalar>(hx[i]);
            out_xyz[i * 3 + 1] = static_cast<HostScalar>(hy[i]);
            out_xyz[i * 3 + 2] = static_cast<HostScalar>(hz[i]);
        }
        return true;
    };

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        return copy_components(double{});
    }
    return copy_components(float{});
}

bool context_download_layer_field_f64(
    Context &ctx,
    uint32_t layer_index,
    fullmag_fdm_observable observable,
    double *out_xyz,
    uint64_t out_len)
{
    return context_download_layer_field_impl(ctx, layer_index, observable, out_xyz, out_len);
}

bool context_download_layer_field_f32(
    Context &ctx,
    uint32_t layer_index,
    fullmag_fdm_observable observable,
    float *out_xyz,
    uint64_t out_len)
{
    return context_download_layer_field_impl(ctx, layer_index, observable, out_xyz, out_len);
}

template <typename HostScalar>
static bool context_download_field_preview_impl(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    HostScalar *out_xyz,
    uint64_t out_len)
{
    if (!out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0 || z_stride == 0) {
        return false;
    }

    uint64_t preview_count = static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz;
    if (out_len != preview_count * 3 || z_origin >= ctx.nz) {
        return false;
    }

    if (preview_nx == ctx.nx && preview_ny == ctx.ny && preview_nz == ctx.nz
        && z_origin == 0 && z_stride == 1)
    {
        return context_download_field_impl(ctx, observable, out_xyz, out_len);
    }

    uint64_t required_mask = 0;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            required_mask = OBSERVABLE_ENDPOINT_H_EX; break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            required_mask = OBSERVABLE_ENDPOINT_H_DEMAG; break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            required_mask = OBSERVABLE_ENDPOINT_H_ANI; break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            required_mask = OBSERVABLE_ENDPOINT_H_EFF_VISUAL; break;
        default:
            break;
    }
    if (required_mask != 0 &&
        !context_ensure_observable_fields(ctx, required_mask)) return false;

    const DeviceVectorField *field = nullptr;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:
            field = &ctx.m;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            field = &ctx.h_ex;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            if (ctx.h_demag_visual.x == nullptr || ctx.h_demag_visual.y == nullptr ||
                ctx.h_demag_visual.z == nullptr) {
                ctx.last_error = "demag_visual_buffer_unavailable";
                return false;
            }
            field = &ctx.h_demag_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            field = &ctx.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &ctx.h_eff_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_OE:
            if (!ctx.has_oersted_field) {
                for (uint64_t i = 0; i < preview_count * 3u; ++i) {
                    out_xyz[i] = static_cast<HostScalar>(0.0);
                }
                return true;
            }
            field = &ctx.h_oe_static;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EXT: {
            if (ctx.has_static_external_field_profile) {
                const DeviceVectorField *profile = &ctx.h_oe_static;
                auto copy_profile_preview = [&](auto tag) -> bool {
                    using DeviceScalar = decltype(tag);
                    std::vector<DeviceScalar> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                    size_t bytes = ctx.cell_count * sizeof(DeviceScalar);
                    cudaError_t err = cudaMemcpy(hx.data(), profile->x, bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) {
                        set_cuda_error(ctx, "cudaMemcpy(h_ext_profile_preview.x)", err);
                        return false;
                    }
                    err = cudaMemcpy(hy.data(), profile->y, bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) {
                        set_cuda_error(ctx, "cudaMemcpy(h_ext_profile_preview.y)", err);
                        return false;
                    }
                    err = cudaMemcpy(hz.data(), profile->z, bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) {
                        set_cuda_error(ctx, "cudaMemcpy(h_ext_profile_preview.z)", err);
                        return false;
                    }
                    for (uint32_t pz = 0; pz < preview_nz; ++pz) {
                        uint32_t z_start = z_origin + pz * z_stride;
                        if (z_start >= ctx.nz) z_start = ctx.nz - 1;
                        uint32_t z_end = z_origin + (pz + 1) * z_stride;
                        if (z_end <= z_start) z_end = z_start + 1;
                        if (z_end > ctx.nz) z_end = ctx.nz;
                        for (uint32_t py = 0; py < preview_ny; ++py) {
                            uint32_t y_start = static_cast<uint32_t>(
                                (static_cast<uint64_t>(py) * ctx.ny) / preview_ny);
                            uint32_t y_end = static_cast<uint32_t>(
                                (static_cast<uint64_t>(py + 1) * ctx.ny) / preview_ny);
                            if (y_end <= y_start) y_end = y_start + 1;
                            if (y_end > ctx.ny) y_end = ctx.ny;
                            for (uint32_t px = 0; px < preview_nx; ++px) {
                                uint32_t x_start = static_cast<uint32_t>(
                                    (static_cast<uint64_t>(px) * ctx.nx) / preview_nx);
                                uint32_t x_end = static_cast<uint32_t>(
                                    (static_cast<uint64_t>(px + 1) * ctx.nx) / preview_nx);
                                if (x_end <= x_start) x_end = x_start + 1;
                                if (x_end > ctx.nx) x_end = ctx.nx;

                                double profile_x = 0.0;
                                double profile_y = 0.0;
                                double profile_z = 0.0;
                                double active_count = 0.0;
                                double count = 0.0;
                                for (uint32_t z = z_start; z < z_end; ++z) {
                                    for (uint32_t y = y_start; y < y_end; ++y) {
                                        for (uint32_t x = x_start; x < x_end; ++x) {
                                            uint64_t index =
                                                (static_cast<uint64_t>(z) * ctx.ny + y) * ctx.nx + x;
                                            bool is_active =
                                                !ctx.has_active_mask || ctx.active_mask_host[index] != 0;
                                            if (is_active) {
                                                profile_x += static_cast<double>(hx[index]);
                                                profile_y += static_cast<double>(hy[index]);
                                                profile_z += static_cast<double>(hz[index]);
                                                active_count += 1.0;
                                            }
                                            count += 1.0;
                                        }
                                    }
                                }
                                uint64_t preview_index =
                                    (static_cast<uint64_t>(pz) * preview_ny + py) * preview_nx + px;
                                double active_scale = count > 0.0 ? active_count / count : 0.0;
                                out_xyz[preview_index * 3 + 0] = static_cast<HostScalar>(
                                    ctx.external_field[0] * active_scale + profile_x / (count > 0.0 ? count : 1.0));
                                out_xyz[preview_index * 3 + 1] = static_cast<HostScalar>(
                                    ctx.external_field[1] * active_scale + profile_y / (count > 0.0 ? count : 1.0));
                                out_xyz[preview_index * 3 + 2] = static_cast<HostScalar>(
                                    ctx.external_field[2] * active_scale + profile_z / (count > 0.0 ? count : 1.0));
                            }
                        }
                    }
                    return true;
                };
                if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                    return copy_profile_preview(double{0.0});
                }
                return copy_profile_preview(float{0.0f});
            }
            for (uint32_t pz = 0; pz < preview_nz; ++pz) {
                uint32_t z_start = z_origin + pz * z_stride;
                if (z_start >= ctx.nz) z_start = ctx.nz - 1;
                uint32_t z_end = z_origin + (pz + 1) * z_stride;
                if (z_end <= z_start) z_end = z_start + 1;
                if (z_end > ctx.nz) z_end = ctx.nz;
                for (uint32_t py = 0; py < preview_ny; ++py) {
                    uint32_t y_start = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py) * ctx.ny) / preview_ny);
                    uint32_t y_end = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py + 1) * ctx.ny) / preview_ny);
                    if (y_end <= y_start) y_end = y_start + 1;
                    if (y_end > ctx.ny) y_end = ctx.ny;
                    for (uint32_t px = 0; px < preview_nx; ++px) {
                        uint32_t x_start = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px) * ctx.nx) / preview_nx);
                        uint32_t x_end = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px + 1) * ctx.nx) / preview_nx);
                        if (x_end <= x_start) x_end = x_start + 1;
                        if (x_end > ctx.nx) x_end = ctx.nx;

                        double active_count = 0.0;
                        double count = 0.0;
                        for (uint32_t z = z_start; z < z_end; ++z) {
                            for (uint32_t y = y_start; y < y_end; ++y) {
                                for (uint32_t x = x_start; x < x_end; ++x) {
                                    uint64_t index =
                                        (static_cast<uint64_t>(z) * ctx.ny + y) * ctx.nx + x;
                                    bool is_active =
                                        !ctx.has_active_mask || ctx.active_mask_host[index] != 0;
                                    active_count += is_active ? 1.0 : 0.0;
                                    count += 1.0;
                                }
                            }
                        }

                        uint64_t preview_index =
                            (static_cast<uint64_t>(pz) * preview_ny + py) * preview_nx + px;
                        double scale =
                            (ctx.has_external_field && count > 0.0) ? (active_count / count) : 0.0;
                        out_xyz[preview_index * 3 + 0] =
                            static_cast<HostScalar>(ctx.external_field[0] * scale);
                        out_xyz[preview_index * 3 + 1] =
                            static_cast<HostScalar>(ctx.external_field[1] * scale);
                        out_xyz[preview_index * 3 + 2] =
                            static_cast<HostScalar>(ctx.external_field[2] * scale);
                    }
                }
            }
            return true;
        }
        default:
            return false;
    }

    if (!ensure_preview_download_scratch(ctx, preview_count * 3 * sizeof(HostScalar))) {
        return false;
    }
    auto *device_out = reinterpret_cast<HostScalar *>(ctx.preview_download_scratch);

    constexpr uint32_t threads_per_block = 256;
    uint32_t blocks =
        static_cast<uint32_t>((preview_count + threads_per_block - 1) / threads_per_block);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        downsample_field_preview_kernel<double, HostScalar><<<blocks, threads_per_block>>>(
            reinterpret_cast<const double *>(field->x),
            reinterpret_cast<const double *>(field->y),
            reinterpret_cast<const double *>(field->z),
            ctx.nx,
            ctx.ny,
            ctx.nz,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            device_out);
    } else {
        downsample_field_preview_kernel<float, HostScalar><<<blocks, threads_per_block>>>(
            reinterpret_cast<const float *>(field->x),
            reinterpret_cast<const float *>(field->y),
            reinterpret_cast<const float *>(field->z),
            ctx.nx,
            ctx.ny,
            ctx.nz,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            device_out);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "downsample_field_preview_kernel", err);
        return false;
    }
    err = cudaMemcpy(
        out_xyz,
        device_out,
        preview_count * 3 * sizeof(HostScalar),
        cudaMemcpyDeviceToHost);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(preview_out)", err);
        return false;
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_OE) {
        const double scale = oersted_field_scale(ctx, ctx.current_time);
        for (uint64_t i = 0; i < preview_count * 3u; ++i) {
            out_xyz[i] = static_cast<HostScalar>(static_cast<double>(out_xyz[i]) * scale);
        }
    }

    return true;
}

bool context_download_field_preview_f64(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    double *out_xyz,
    uint64_t out_len)
{
    return context_download_field_preview_impl(
        ctx,
        observable,
        preview_nx,
        preview_ny,
        preview_nz,
        z_origin,
        z_stride,
        out_xyz,
        out_len);
}

bool context_download_field_preview_f32(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    float *out_xyz,
    uint64_t out_len)
{
    return context_download_field_preview_impl(
        ctx,
        observable,
        preview_nx,
        preview_ny,
        preview_nz,
        z_origin,
        z_stride,
        out_xyz,
        out_len);
}

AsyncFieldSnapshot *context_begin_async_field_snapshot(
    Context &ctx,
    fullmag_fdm_observable observable)
{
    ++ctx.endpoint_field_cache.field_snapshot_request_count;
    auto *snapshot = new (std::nothrow) AsyncFieldSnapshot();
    if (snapshot == nullptr) {
        ctx.last_error = "failed to allocate async field snapshot";
        return nullptr;
    }
    snapshot->precision = ctx.precision;
    snapshot->cell_count = ctx.cell_count;
    snapshot->telemetry_cache = &ctx.endpoint_field_cache;
    snapshot->telemetry_started_ns = steady_clock_now_ns();
    const bool scalar_observable = is_energy_density_observable(observable);
    snapshot->component_count = scalar_observable ? 1u : 3u;
    snapshot->host_soa_len_bytes =
        ctx.cell_count * snapshot->component_count * scalar_size(ctx.precision);

    std::size_t pool_slot = kFdmAsyncFieldSnapshotPoolCapacity;
    std::string pool_error;
    if (!acquire_async_field_snapshot_pool_slot(ctx, pool_slot, pool_error)) {
        ctx.last_error = pool_error;
        delete snapshot;
        return nullptr;
    }
    snapshot->pool = ctx.async_field_snapshot_pool;
    snapshot->pool_slot = pool_slot;
    const auto &slot = snapshot->pool->slots[pool_slot];
    snapshot->staging = slot.staging;
    snapshot->host_soa = slot.host_soa;
    snapshot->stream = slot.stream;
    snapshot->ready_event = slot.ready_event;
    snapshot->staging_done_event = slot.staging_done_event;
    snapshot->done_event = slot.done_event;

    auto fail = [&](const char *label, cudaError_t err) -> AsyncFieldSnapshot * {
        ctx.last_error = std::string(label) + ": " + cudaGetErrorString(err);
        destroy_async_snapshot_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    auto fail_message = [&](const std::string &message) -> AsyncFieldSnapshot * {
        ctx.last_error = message;
        destroy_async_snapshot_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    const size_t component_bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaError_t err = cudaSuccess;
    cudaStream_t io_stream = reinterpret_cast<cudaStream_t>(snapshot->stream);
    cudaEvent_t ready_event = reinterpret_cast<cudaEvent_t>(snapshot->ready_event);
    cudaEvent_t staging_done_event = reinterpret_cast<cudaEvent_t>(snapshot->staging_done_event);
    cudaEvent_t done_event = reinterpret_cast<cudaEvent_t>(snapshot->done_event);

    const DeviceVectorField *field = nullptr;
    if (scalar_observable) {
        if (!context_refresh_energy_density_observable(ctx, observable)) {
            return fail_message(
                ctx.last_error.empty() ? "failed to refresh scalar snapshot" : ctx.last_error);
        }
    } else switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:
            field = &ctx.m;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            if (!context_ensure_observable_fields(
                    ctx, OBSERVABLE_ENDPOINT_H_EX)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_ex snapshot"
                                           : ctx.last_error);
            }
            field = &ctx.h_ex;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            if (!context_ensure_observable_fields(
                    ctx, OBSERVABLE_ENDPOINT_H_DEMAG)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_demag snapshot"
                                           : ctx.last_error);
            }
            if (ctx.h_demag_visual.x == nullptr || ctx.h_demag_visual.y == nullptr ||
                ctx.h_demag_visual.z == nullptr) {
                return fail_message("demag_visual_buffer_unavailable");
            }
            field = &ctx.h_demag_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            if (!context_ensure_observable_fields(
                    ctx, OBSERVABLE_ENDPOINT_H_ANI)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_ani snapshot"
                                           : ctx.last_error);
            }
            field = &ctx.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            if (!context_ensure_observable_fields(
                    ctx, OBSERVABLE_ENDPOINT_H_EFF_VISUAL)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_eff snapshot" : ctx.last_error);
            }
            field = &ctx.h_eff_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_OE:
            if (ctx.has_static_external_field_profile) {
                if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                    auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                    std::fill(host, host + (ctx.cell_count * 3u), 0.0);
                } else {
                    auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                    std::fill(host, host + (ctx.cell_count * 3u), 0.0f);
                }
                snapshot->needs_wait = false;
                return snapshot;
            }
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                if (!ctx.has_oersted_field) {
                    auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                    std::fill(host, host + (ctx.cell_count * 3u), 0.0);
                    snapshot->needs_wait = false;
                    return snapshot;
                }
                std::vector<double> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                err = cudaMemcpy(hx.data(), ctx.h_oe_static.x, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_x)", err);
                err = cudaMemcpy(hy.data(), ctx.h_oe_static.y, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_y)", err);
                err = cudaMemcpy(hz.data(), ctx.h_oe_static.z, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_z)", err);
                auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                const double scale = oersted_field_scale(ctx, ctx.current_time);
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_oersted_field && is_active) ? hx[i] * scale : 0.0;
                    host[ctx.cell_count + i] =
                        (ctx.has_oersted_field && is_active) ? hy[i] * scale : 0.0;
                    host[(ctx.cell_count * 2u) + i] =
                        (ctx.has_oersted_field && is_active) ? hz[i] * scale : 0.0;
                }
            } else {
                if (!ctx.has_oersted_field) {
                    auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                    std::fill(host, host + (ctx.cell_count * 3u), 0.0f);
                    snapshot->needs_wait = false;
                    return snapshot;
                }
                std::vector<float> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                err = cudaMemcpy(hx.data(), ctx.h_oe_static.x, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_x)", err);
                err = cudaMemcpy(hy.data(), ctx.h_oe_static.y, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_y)", err);
                err = cudaMemcpy(hz.data(), ctx.h_oe_static.z, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_z)", err);
                auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                const float scale = static_cast<float>(oersted_field_scale(ctx, ctx.current_time));
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_oersted_field && is_active) ? hx[i] * scale : 0.0f;
                    host[ctx.cell_count + i] =
                        (ctx.has_oersted_field && is_active) ? hy[i] * scale : 0.0f;
                    host[(ctx.cell_count * 2u) + i] =
                        (ctx.has_oersted_field && is_active) ? hz[i] * scale : 0.0f;
                }
            }
            snapshot->needs_wait = false;
            return snapshot;
        case FULLMAG_FDM_OBSERVABLE_H_EXT:
            if (ctx.has_static_external_field_profile) {
                if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                    std::vector<double> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                    err = cudaMemcpy(hx.data(), ctx.h_oe_static.x, component_bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_ext_profile_x)", err);
                    err = cudaMemcpy(hy.data(), ctx.h_oe_static.y, component_bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_ext_profile_y)", err);
                    err = cudaMemcpy(hz.data(), ctx.h_oe_static.z, component_bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_ext_profile_z)", err);
                    auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                    for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                        const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                        host[i] = is_active ? ctx.external_field[0] + hx[i] : 0.0;
                        host[ctx.cell_count + i] = is_active ? ctx.external_field[1] + hy[i] : 0.0;
                        host[(ctx.cell_count * 2u) + i] = is_active ? ctx.external_field[2] + hz[i] : 0.0;
                    }
                } else {
                    std::vector<float> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                    err = cudaMemcpy(hx.data(), ctx.h_oe_static.x, component_bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_ext_profile_x)", err);
                    err = cudaMemcpy(hy.data(), ctx.h_oe_static.y, component_bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_ext_profile_y)", err);
                    err = cudaMemcpy(hz.data(), ctx.h_oe_static.z, component_bytes, cudaMemcpyDeviceToHost);
                    if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_ext_profile_z)", err);
                    auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                    for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                        const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                        host[i] = is_active ? static_cast<float>(ctx.external_field[0]) + hx[i] : 0.0f;
                        host[ctx.cell_count + i] = is_active ? static_cast<float>(ctx.external_field[1]) + hy[i] : 0.0f;
                        host[(ctx.cell_count * 2u) + i] = is_active ? static_cast<float>(ctx.external_field[2]) + hz[i] : 0.0f;
                    }
                }
                snapshot->needs_wait = false;
                return snapshot;
            }
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_external_field && is_active) ? ctx.external_field[0] : 0.0;
                    host[ctx.cell_count + i] =
                        (ctx.has_external_field && is_active) ? ctx.external_field[1] : 0.0;
                    host[(ctx.cell_count * 2u) + i] =
                        (ctx.has_external_field && is_active) ? ctx.external_field[2] : 0.0;
                }
            } else {
                auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_external_field && is_active)
                        ? static_cast<float>(ctx.external_field[0])
                        : 0.0f;
                    host[ctx.cell_count + i] = (ctx.has_external_field && is_active)
                        ? static_cast<float>(ctx.external_field[1])
                        : 0.0f;
                    host[(ctx.cell_count * 2u) + i] = (ctx.has_external_field && is_active)
                        ? static_cast<float>(ctx.external_field[2])
                        : 0.0f;
                }
            }
            snapshot->needs_wait = false;
            return snapshot;
        default:
            return fail_message("unsupported async snapshot observable");
    }

    err = cudaEventRecord(ready_event, nullptr);
    if (err != cudaSuccess) return fail("cudaEventRecord(snapshot.ready_event)", err);
    // From this point onward the leased slot may have work in flight.  A
    // failure must retire it until the completion event is observable.
    snapshot->needs_wait = true;

    err = cudaStreamWaitEvent(io_stream, ready_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(snapshot.ready_event)", err);

    const void *source_x = scalar_observable
        ? ctx.energy_density
        : field->x;
    err = cudaMemcpyAsync(
        snapshot->staging.x, source_x, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.x)", err);
    if (!scalar_observable) {
        err = cudaMemcpyAsync(
            snapshot->staging.y, field->y, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
        if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.y)", err);
        err = cudaMemcpyAsync(
            snapshot->staging.z, field->z, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
        if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.z)", err);
    }

    err = cudaEventRecord(staging_done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(snapshot.staging_done_event)", err);

    auto *host_bytes = static_cast<unsigned char *>(snapshot->host_soa);
    err = cudaMemcpyAsync(
        host_bytes,
        snapshot->staging.x,
        component_bytes,
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.host_x)", err);
    if (!scalar_observable) {
        err = cudaMemcpyAsync(
            host_bytes + component_bytes,
            snapshot->staging.y,
            component_bytes,
            cudaMemcpyDeviceToHost,
            io_stream);
        if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.host_y)", err);
        err = cudaMemcpyAsync(
            host_bytes + (component_bytes * 2u),
            snapshot->staging.z,
            component_bytes,
            cudaMemcpyDeviceToHost,
            io_stream);
        if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.host_z)", err);
    }

    err = cudaEventRecord(done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(snapshot.done_event)", err);
    snapshot->done_event_recorded = true;
    snapshot->receipt_token = std::make_shared<AsyncTransferReceiptToken>(
        ctx.execution_receipt,
        false,
        snapshot->host_soa_len_bytes,
        ReceiptTransferCadence::Observation);

    return snapshot;
}

bool context_wait_async_field_snapshot(
    AsyncFieldSnapshot &snapshot,
    const void **out_data,
    uint64_t &out_len_bytes,
    fullmag_fdm_snapshot_desc &out_desc,
    std::string &error)
{
    if (out_data == nullptr) {
        error = "async snapshot output pointer is null";
        return false;
    }

    const bool completed_device_to_host = snapshot.needs_wait;
    if (snapshot.needs_wait) {
        cudaError_t err =
            cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        if (err != cudaSuccess) {
            error = std::string("cudaEventSynchronize(snapshot.done_event): ")
                + cudaGetErrorString(err);
            return false;
        }
        snapshot.needs_wait = false;
    }

    *out_data = snapshot.host_soa;
    out_len_bytes = static_cast<uint64_t>(snapshot.host_soa_len_bytes);
    if (snapshot.telemetry_cache != nullptr && snapshot.telemetry_started_ns != 0) {
        const uint64_t elapsed_ns = steady_clock_now_ns() - snapshot.telemetry_started_ns;
        auto &cache = *snapshot.telemetry_cache;
        cache.field_snapshot_latency_total_ns += elapsed_ns;
        cache.field_snapshot_latency_max_ns =
            std::max(cache.field_snapshot_latency_max_ns, elapsed_ns);
        snapshot.telemetry_started_ns = 0;
    }
    out_desc.cell_count = snapshot.cell_count;
    out_desc.component_count = snapshot.component_count;
    out_desc.scalar_bytes =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE ? 4u : 8u;
    out_desc.scalar_type =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE
            ? FULLMAG_FDM_SNAPSHOT_SCALAR_F32
            : FULLMAG_FDM_SNAPSHOT_SCALAR_F64;
    if (completed_device_to_host && snapshot.receipt_token) {
        (void)snapshot.receipt_token->complete();
    }
    return true;
}

void context_destroy_async_field_snapshot(AsyncFieldSnapshot *snapshot) {
    if (snapshot == nullptr) {
        return;
    }
    destroy_async_snapshot_resources(*snapshot);
    delete snapshot;
}

AsyncPreviewSnapshot *context_begin_async_preview_snapshot(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride)
{
    if (preview_nx == 0 || preview_ny == 0 || preview_nz == 0 || z_stride == 0 || z_origin >= ctx.nz) {
        ctx.last_error = "invalid preview snapshot dimensions";
        return nullptr;
    }

    auto *snapshot = new (std::nothrow) AsyncPreviewSnapshot();
    if (snapshot == nullptr) {
        ctx.last_error = "failed to allocate async preview snapshot";
        return nullptr;
    }
    snapshot->precision = ctx.precision;
    snapshot->preview_count = static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz;
    snapshot->host_xyz_len_bytes = snapshot->preview_count * 3u * scalar_size(ctx.precision);

    std::size_t pool_slot = kFdmAsyncPreviewSnapshotPoolCapacity;
    std::string pool_error;
    if (!acquire_async_preview_snapshot_pool_slot(
            ctx,
            snapshot->preview_count,
            pool_slot,
            pool_error)) {
        ctx.last_error = pool_error;
        delete snapshot;
        return nullptr;
    }
    snapshot->pool = ctx.async_preview_snapshot_pool;
    snapshot->pool_slot = pool_slot;
    const auto &slot = snapshot->pool->slots[pool_slot];
    snapshot->device_xyz = slot.device_xyz;
    snapshot->host_xyz = slot.host_xyz;
    snapshot->stream = slot.stream;
    snapshot->ready_event = slot.ready_event;
    snapshot->staging_done_event = slot.staging_done_event;
    snapshot->done_event = slot.done_event;

    auto fail = [&](const char *label, cudaError_t err) -> AsyncPreviewSnapshot * {
        ctx.last_error = std::string(label) + ": " + cudaGetErrorString(err);
        destroy_async_preview_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    auto fail_message = [&](const std::string &message) -> AsyncPreviewSnapshot * {
        ctx.last_error = message;
        destroy_async_preview_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    cudaError_t err = cudaSuccess;
    cudaStream_t io_stream = reinterpret_cast<cudaStream_t>(snapshot->stream);
    cudaEvent_t ready_event = reinterpret_cast<cudaEvent_t>(snapshot->ready_event);
    cudaEvent_t staging_done_event = reinterpret_cast<cudaEvent_t>(snapshot->staging_done_event);
    cudaEvent_t done_event = reinterpret_cast<cudaEvent_t>(snapshot->done_event);

    const DeviceVectorField *field = nullptr;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:
            field = &ctx.m;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            field = &ctx.h_ex;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            if (ctx.h_demag_visual.x == nullptr || ctx.h_demag_visual.y == nullptr ||
                ctx.h_demag_visual.z == nullptr) {
                return fail_message("demag_visual_buffer_unavailable");
            }
            field = &ctx.h_demag_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            if (!context_ensure_observable_fields(
                    ctx, OBSERVABLE_ENDPOINT_H_ANI)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_ani preview snapshot"
                                           : ctx.last_error);
            }
            field = &ctx.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            if (!context_ensure_observable_fields(
                    ctx, OBSERVABLE_ENDPOINT_H_EFF_VISUAL)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_eff preview snapshot" : ctx.last_error);
            }
            field = &ctx.h_eff_visual;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_OE:
            if (!ctx.has_oersted_field) {
                if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                    std::fill(
                        reinterpret_cast<double *>(snapshot->host_xyz),
                        reinterpret_cast<double *>(snapshot->host_xyz)
                            + (snapshot->preview_count * 3u),
                        0.0);
                } else {
                    std::fill(
                        reinterpret_cast<float *>(snapshot->host_xyz),
                        reinterpret_cast<float *>(snapshot->host_xyz)
                            + (snapshot->preview_count * 3u),
                        0.0f);
                }
                snapshot->needs_wait = false;
                return snapshot;
            }
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                if (!context_download_field_preview_f64(
                        ctx,
                        observable,
                        preview_nx,
                        preview_ny,
                        preview_nz,
                        z_origin,
                        z_stride,
                        reinterpret_cast<double *>(snapshot->host_xyz),
                        snapshot->preview_count * 3u))
                {
                    return fail_message(
                        ctx.last_error.empty() ? "failed to build async preview for H_OE"
                                               : ctx.last_error);
                }
            } else {
                if (!context_download_field_preview_f32(
                        ctx,
                        observable,
                        preview_nx,
                        preview_ny,
                        preview_nz,
                        z_origin,
                        z_stride,
                        reinterpret_cast<float *>(snapshot->host_xyz),
                        snapshot->preview_count * 3u))
                {
                    return fail_message(
                        ctx.last_error.empty() ? "failed to build async preview for H_OE"
                                               : ctx.last_error);
                }
            }
            snapshot->needs_wait = false;
            return snapshot;
        case FULLMAG_FDM_OBSERVABLE_H_EXT:
            break;
        default:
            return fail_message("unsupported async preview observable");
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_EXT) {
        if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            auto *out_xyz = reinterpret_cast<double *>(snapshot->host_xyz);
            for (uint32_t pz = 0; pz < preview_nz; ++pz) {
                uint32_t z_start = z_origin + pz * z_stride;
                if (z_start >= ctx.nz) z_start = ctx.nz - 1;
                uint32_t z_end = z_origin + (pz + 1) * z_stride;
                if (z_end <= z_start) z_end = z_start + 1;
                if (z_end > ctx.nz) z_end = ctx.nz;
                for (uint32_t py = 0; py < preview_ny; ++py) {
                    uint32_t y_start = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py) * ctx.ny) / preview_ny);
                    uint32_t y_end = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py + 1) * ctx.ny) / preview_ny);
                    if (y_end <= y_start) y_end = y_start + 1;
                    if (y_end > ctx.ny) y_end = ctx.ny;
                    for (uint32_t px = 0; px < preview_nx; ++px) {
                        uint32_t x_start = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px) * ctx.nx) / preview_nx);
                        uint32_t x_end = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px + 1) * ctx.nx) / preview_nx);
                        if (x_end <= x_start) x_end = x_start + 1;
                        if (x_end > ctx.nx) x_end = ctx.nx;

                        double active_count = 0.0;
                        double count = 0.0;
                        for (uint32_t z = z_start; z < z_end; ++z) {
                            for (uint32_t y = y_start; y < y_end; ++y) {
                                for (uint32_t x = x_start; x < x_end; ++x) {
                                    uint64_t index =
                                        (static_cast<uint64_t>(z) * ctx.ny + y) * ctx.nx + x;
                                    bool is_active =
                                        !ctx.has_active_mask || ctx.active_mask_host[index] != 0;
                                    active_count += is_active ? 1.0 : 0.0;
                                    count += 1.0;
                                }
                            }
                        }

                        uint64_t preview_index =
                            (static_cast<uint64_t>(pz) * preview_ny + py) * preview_nx + px;
                        double scale =
                            (ctx.has_external_field && count > 0.0) ? (active_count / count) : 0.0;
                        out_xyz[preview_index * 3 + 0] = ctx.external_field[0] * scale;
                        out_xyz[preview_index * 3 + 1] = ctx.external_field[1] * scale;
                        out_xyz[preview_index * 3 + 2] = ctx.external_field[2] * scale;
                    }
                }
            }
        } else {
            auto *out_xyz = reinterpret_cast<float *>(snapshot->host_xyz);
            for (uint32_t pz = 0; pz < preview_nz; ++pz) {
                uint32_t z_start = z_origin + pz * z_stride;
                if (z_start >= ctx.nz) z_start = ctx.nz - 1;
                uint32_t z_end = z_origin + (pz + 1) * z_stride;
                if (z_end <= z_start) z_end = z_start + 1;
                if (z_end > ctx.nz) z_end = ctx.nz;
                for (uint32_t py = 0; py < preview_ny; ++py) {
                    uint32_t y_start = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py) * ctx.ny) / preview_ny);
                    uint32_t y_end = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py + 1) * ctx.ny) / preview_ny);
                    if (y_end <= y_start) y_end = y_start + 1;
                    if (y_end > ctx.ny) y_end = ctx.ny;
                    for (uint32_t px = 0; px < preview_nx; ++px) {
                        uint32_t x_start = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px) * ctx.nx) / preview_nx);
                        uint32_t x_end = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px + 1) * ctx.nx) / preview_nx);
                        if (x_end <= x_start) x_end = x_start + 1;
                        if (x_end > ctx.nx) x_end = ctx.nx;

                        double active_count = 0.0;
                        double count = 0.0;
                        for (uint32_t z = z_start; z < z_end; ++z) {
                            for (uint32_t y = y_start; y < y_end; ++y) {
                                for (uint32_t x = x_start; x < x_end; ++x) {
                                    uint64_t index =
                                        (static_cast<uint64_t>(z) * ctx.ny + y) * ctx.nx + x;
                                    bool is_active =
                                        !ctx.has_active_mask || ctx.active_mask_host[index] != 0;
                                    active_count += is_active ? 1.0 : 0.0;
                                    count += 1.0;
                                }
                            }
                        }

                        uint64_t preview_index =
                            (static_cast<uint64_t>(pz) * preview_ny + py) * preview_nx + px;
                        double scale =
                            (ctx.has_external_field && count > 0.0) ? (active_count / count) : 0.0;
                        out_xyz[preview_index * 3 + 0] =
                            static_cast<float>(ctx.external_field[0] * scale);
                        out_xyz[preview_index * 3 + 1] =
                            static_cast<float>(ctx.external_field[1] * scale);
                        out_xyz[preview_index * 3 + 2] =
                            static_cast<float>(ctx.external_field[2] * scale);
                    }
                }
            }
        }
        snapshot->needs_wait = false;
        return snapshot;
    }

    err = cudaEventRecord(ready_event, nullptr);
    if (err != cudaSuccess) return fail("cudaEventRecord(preview_snapshot.ready_event)", err);
    snapshot->needs_wait = true;

    err = cudaStreamWaitEvent(io_stream, ready_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(preview_snapshot.ready_event)", err);

    constexpr uint32_t threads_per_block = 256;
    uint32_t blocks = static_cast<uint32_t>(
        (snapshot->preview_count + threads_per_block - 1) / threads_per_block);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        downsample_field_preview_kernel<double, double><<<blocks, threads_per_block, 0, io_stream>>>(
            reinterpret_cast<const double *>(field->x),
            reinterpret_cast<const double *>(field->y),
            reinterpret_cast<const double *>(field->z),
            ctx.nx,
            ctx.ny,
            ctx.nz,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            reinterpret_cast<double *>(snapshot->device_xyz));
    } else {
        downsample_field_preview_kernel<float, float><<<blocks, threads_per_block, 0, io_stream>>>(
            reinterpret_cast<const float *>(field->x),
            reinterpret_cast<const float *>(field->y),
            reinterpret_cast<const float *>(field->z),
            ctx.nx,
            ctx.ny,
            ctx.nz,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            reinterpret_cast<float *>(snapshot->device_xyz));
    }

    err = cudaGetLastError();
    if (err != cudaSuccess) {
        return fail("downsample_field_preview_kernel(async)", err);
    }

    err = cudaEventRecord(staging_done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(preview_snapshot.staging_done_event)", err);

    err = cudaMemcpyAsync(
        snapshot->host_xyz,
        snapshot->device_xyz,
        snapshot->host_xyz_len_bytes,
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(preview_snapshot.host_xyz)", err);

    err = cudaEventRecord(done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(preview_snapshot.done_event)", err);
    snapshot->done_event_recorded = true;
    snapshot->receipt_token = std::make_shared<AsyncTransferReceiptToken>(
        ctx.execution_receipt,
        false,
        snapshot->host_xyz_len_bytes,
        ReceiptTransferCadence::Observation);

    return snapshot;
}

bool context_wait_async_preview_snapshot(
    AsyncPreviewSnapshot &snapshot,
    const void **out_data,
    uint64_t &out_len_bytes,
    fullmag_fdm_snapshot_desc &out_desc,
    std::string &error)
{
    if (out_data == nullptr) {
        error = "async preview snapshot output pointer is null";
        return false;
    }

    const bool completed_device_to_host = snapshot.needs_wait;
    if (snapshot.needs_wait) {
        cudaError_t err =
            cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        if (err != cudaSuccess) {
            error = std::string("cudaEventSynchronize(preview_snapshot.done_event): ")
                + cudaGetErrorString(err);
            return false;
        }
        snapshot.needs_wait = false;
    }

    *out_data = snapshot.host_xyz;
    out_len_bytes = static_cast<uint64_t>(snapshot.host_xyz_len_bytes);
    out_desc.cell_count = snapshot.preview_count;
    out_desc.component_count = 3;
    out_desc.scalar_bytes =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE ? 4u : 8u;
    out_desc.scalar_type =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE
            ? FULLMAG_FDM_SNAPSHOT_SCALAR_F32
            : FULLMAG_FDM_SNAPSHOT_SCALAR_F64;
    if (completed_device_to_host && snapshot.receipt_token) {
        (void)snapshot.receipt_token->complete();
    }
    return true;
}

void context_destroy_async_preview_snapshot(AsyncPreviewSnapshot *snapshot) {
    if (snapshot == nullptr) {
        return;
    }
    destroy_async_preview_resources(*snapshot);
    delete snapshot;
}

bool context_query_device_info(Context &ctx) {
    int device;
    cudaError_t err = cudaGetDevice(&device);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaGetDevice", err);
        return false;
    }

    cudaDeviceProp props;
    err = cudaGetDeviceProperties(&props, device);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaGetDeviceProperties", err);
        return false;
    }

    std::memset(&ctx.device_info_cache, 0, sizeof(ctx.device_info_cache));
    std::strncpy(ctx.device_info_cache.name, props.name,
                 sizeof(ctx.device_info_cache.name) - 1);
    ctx.device_info_cache.compute_capability_major = props.major;
    ctx.device_info_cache.compute_capability_minor = props.minor;

    int driver_ver = 0, runtime_ver = 0;
    cudaDriverGetVersion(&driver_ver);
    cudaRuntimeGetVersion(&runtime_ver);
    ctx.device_info_cache.driver_version  = driver_ver;
    ctx.device_info_cache.runtime_version = runtime_ver;
    ctx.device_info_valid = true;

    return true;
}

bool context_refresh_observables(Context &ctx) {
    return context_ensure_observable_fields(ctx, OBSERVABLE_ENDPOINT_ALL_FIELDS);
}

bool context_ensure_observable_fields(Context &ctx, uint64_t required_mask) {
    auto &cache = ctx.endpoint_field_cache;
    ++cache.refresh_request_count;
    context_prepare_endpoint_cache_identity(ctx);
    const uint64_t supported_mask = OBSERVABLE_ENDPOINT_ALL_FIELDS;
    if ((required_mask & ~supported_mask) != 0) {
        ctx.last_error = "unsupported endpoint observable field mask";
        return false;
    }
    if (context_endpoint_fields_are_fresh(ctx, required_mask)) {
        ++cache.refresh_cache_hit_count;
        return true;
    }

    ++cache.refresh_execution_count;
    uint64_t expanded_mask = required_mask;
    if ((expanded_mask & (OBSERVABLE_ENDPOINT_H_EFF |
                          OBSERVABLE_ENDPOINT_H_EFF_VISUAL)) != 0) {
        expanded_mask |= OBSERVABLE_ENDPOINT_CORE_FIELDS;
    }
    const uint64_t needed = expanded_mask & ~cache.valid_field_mask;
    const double evaluation_time =
        ctx.accepted_step_pending ? ctx.pending_time : ctx.current_time;
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        if ((needed & OBSERVABLE_ENDPOINT_H_EX) != 0 && ctx.enable_exchange) {
            launch_exchange_field_fp64(ctx);
        }
        if ((needed & OBSERVABLE_ENDPOINT_H_DEMAG) != 0 && ctx.enable_demag) {
            launch_demag_field_fp64(ctx);
        }
        if ((needed & OBSERVABLE_ENDPOINT_H_ANI) != 0 &&
            !launch_anisotropy_observable(ctx)) return false;
        if ((needed & OBSERVABLE_ENDPOINT_H_EFF) != 0) {
            launch_effective_field_fp64(ctx, evaluation_time);
        }
    } else {
        if ((needed & OBSERVABLE_ENDPOINT_H_EX) != 0 && ctx.enable_exchange) {
            launch_exchange_field_fp32(ctx);
        }
        if ((needed & OBSERVABLE_ENDPOINT_H_DEMAG) != 0 && ctx.enable_demag) {
            launch_demag_field_fp32(ctx);
        }
        if ((needed & OBSERVABLE_ENDPOINT_H_ANI) != 0 &&
            !launch_anisotropy_observable(ctx)) return false;
        if ((needed & OBSERVABLE_ENDPOINT_H_EFF) != 0) {
            launch_effective_field_fp32(ctx, evaluation_time);
        }
    }
    if ((needed & OBSERVABLE_ENDPOINT_H_EFF_VISUAL) != 0 &&
        !context_refresh_effective_field_visual(ctx)) {
        return false;
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "context_refresh_observables", err);
        return false;
    }
    context_publish_endpoint_fields(ctx, needed);
    return true;
}

void context_invalidate_observables(Context &ctx) {
    context_clear_endpoint_cache(ctx);
}

bool context_refresh_demag_observable(Context &ctx) {
    return context_ensure_observable_fields(ctx, OBSERVABLE_ENDPOINT_H_DEMAG);
}

static bool launch_anisotropy_observable(Context &ctx) {
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        launch_anisotropy_field_fp64(ctx);
    } else {
        launch_anisotropy_field_fp32(ctx);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "launch_anisotropy_observable", err);
        return false;
    }
    return true;
}

bool context_refresh_energy_density_observable(
    Context &ctx,
    fullmag_fdm_observable observable)
{
    if (!is_energy_density_observable(observable)) {
        ctx.last_error = "unsupported energy density observable";
        return false;
    }

    ctx.last_error.clear();
    const bool wants_total = observable == FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL;
    const bool wants_exchange =
        wants_total || observable == FULLMAG_FDM_OBSERVABLE_EDEN_EX;
    const bool wants_demag =
        wants_total || observable == FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG;
    const bool wants_anisotropy =
        wants_total || observable == FULLMAG_FDM_OBSERVABLE_EDEN_ANI;

    if (wants_exchange && ctx.enable_exchange) {
        if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            launch_exchange_field_fp64(ctx);
        } else {
            launch_exchange_field_fp32(ctx);
        }
        if (!ctx.last_error.empty()) return false;
    }
    if (wants_demag && ctx.enable_demag) {
        if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            launch_demag_field_fp64(ctx);
        } else {
            launch_demag_field_fp32(ctx);
        }
        if (!ctx.last_error.empty()) return false;
    }
    if (wants_anisotropy &&
        (ctx.has_uniaxial_anisotropy || ctx.has_cubic_anisotropy)) {
        if (!context_ensure_observable_fields(
                ctx, OBSERVABLE_ENDPOINT_H_ANI)) return false;
        // The anisotropy kernels currently use the legacy default stream.
        // Synchronize it before the scalar kernel is queued on the compute
        // stream so the materialized value cannot observe stale H_ani data.
        const cudaError_t err = cudaStreamSynchronize(nullptr);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaStreamSynchronize(anisotropy)", err);
            return false;
        }
    }

    return launch_energy_density_observable(ctx, observable);
}

} // namespace fdm
} // namespace fullmag
