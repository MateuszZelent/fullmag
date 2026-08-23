#include "context.hpp"

#include <cuda_runtime_api.h>

#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fdm {
namespace {

constexpr uint64_t kMagic0 = UINT64_C(0x464d4c4c47435031);
constexpr uint64_t kMagic1 = UINT64_C(0x465036344c4c4731);
constexpr uint32_t kArrayM = UINT32_C(1) << 0;
constexpr uint32_t kArrayFsal = UINT32_C(1) << 1;
constexpr uint32_t kArrayAbmFn = UINT32_C(1) << 2;
constexpr uint32_t kArrayAbmFn1 = UINT32_C(1) << 3;
constexpr uint32_t kArrayAbmFn2 = UINT32_C(1) << 4;

struct HeaderV1 {
    uint64_t magic0;
    uint64_t magic1;
    fullmag_fdm_llg_checkpoint_info_v1 info;
    uint64_t payload_checksum;
};

uint32_t array_mask(const Context &ctx) {
    uint32_t mask = kArrayM;
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23 ||
        ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45) {
        mask |= kArrayFsal;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_ABM3) {
        mask |= kArrayAbmFn | kArrayAbmFn1 | kArrayAbmFn2;
    }
    return mask;
}

bool required_bytes(
    const Context &ctx, uint64_t &required, uint32_t &mask)
{
    if (ctx.precision != FULLMAG_FDM_PRECISION_DOUBLE ||
        ctx.has_multilayer_plan_v2 || ctx.cell_count == 0) {
        return false;
    }
    mask = array_mask(ctx);
    const uint64_t arrays = UINT64_C(1) +
        ((mask & kArrayFsal) != 0 ? UINT64_C(1) : UINT64_C(0)) +
        ((mask & kArrayAbmFn) != 0 ? UINT64_C(3) : UINT64_C(0));
    constexpr uint64_t components = 3;
    if (ctx.cell_count >
        (std::numeric_limits<uint64_t>::max() - sizeof(HeaderV1)) /
            (arrays * components * sizeof(double))) {
        return false;
    }
    required = sizeof(HeaderV1) +
        arrays * components * ctx.cell_count * sizeof(double);
    return true;
}

fullmag_fdm_llg_checkpoint_info_v1 checkpoint_info(
    const Context &ctx, uint64_t payload_bytes, uint32_t mask)
{
    fullmag_fdm_llg_checkpoint_info_v1 info{};
    info.schema_version = FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V1;
    info.integrator = static_cast<uint32_t>(ctx.integrator);
    info.precision = static_cast<uint32_t>(ctx.precision);
    info.array_mask = mask;
    info.cell_count = ctx.cell_count;
    info.payload_bytes = payload_bytes;
    info.step_count = ctx.step_count;
    info.current_time = ctx.current_time;
    info.current_dt = ctx.current_dt;
    info.transport_attempt_generation = ctx.gpu_transport_attempt_generation;
    info.fsal_valid = ctx.fsal_valid ? 1U : 0U;
    info.abm_startup = ctx.abm_startup;
    info.abm_last_dt = ctx.abm_last_dt;
    info.adaptive_has_previous_error =
        ctx.adaptive_has_previous_error ? 1U : 0U;
    info.adaptive_previous_error = ctx.adaptive_previous_error;
    return info;
}

bool info_equal(
    const fullmag_fdm_llg_checkpoint_info_v1 &left,
    const fullmag_fdm_llg_checkpoint_info_v1 &right)
{
    return left.schema_version == right.schema_version &&
        left.integrator == right.integrator && left.precision == right.precision &&
        left.array_mask == right.array_mask && left.cell_count == right.cell_count &&
        left.payload_bytes == right.payload_bytes &&
        left.step_count == right.step_count && left.current_time == right.current_time &&
        left.current_dt == right.current_dt &&
        left.transport_attempt_generation == right.transport_attempt_generation &&
        left.fsal_valid == right.fsal_valid && left.abm_startup == right.abm_startup &&
        left.abm_last_dt == right.abm_last_dt &&
        left.adaptive_has_previous_error == right.adaptive_has_previous_error &&
        left.reserved0 == right.reserved0 &&
        left.adaptive_previous_error == right.adaptive_previous_error;
}

uint64_t checksum(const std::byte *bytes, uint64_t length) {
    uint64_t hash = UINT64_C(14695981039346656037);
    for (uint64_t index = 0; index < length; ++index) {
        hash ^= static_cast<uint64_t>(std::to_integer<uint8_t>(bytes[index]));
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

bool copy_device_to_host(
    Context &ctx, const DeviceVectorField &field,
    std::byte *payload, uint64_t &offset)
{
    const size_t component_bytes =
        static_cast<size_t>(ctx.cell_count) * sizeof(double);
    for (const void *component : {field.x, field.y, field.z}) {
        if (component == nullptr ||
            fullmag_fdm_receipt_cuda_memcpy(
                ctx, payload + offset, component, component_bytes,
                cudaMemcpyDeviceToHost) != cudaSuccess) {
            ctx.last_error = "failed to export LLG checkpoint device field";
            return false;
        }
        offset += component_bytes;
    }
    return true;
}

bool copy_host_to_device(
    Context &ctx, DeviceVectorField &field,
    const std::byte *payload, uint64_t &offset)
{
    const size_t component_bytes =
        static_cast<size_t>(ctx.cell_count) * sizeof(double);
    for (void *component : {field.x, field.y, field.z}) {
        if (component == nullptr ||
            fullmag_fdm_receipt_cuda_memcpy(
                ctx, component, payload + offset, component_bytes,
                cudaMemcpyHostToDevice) != cudaSuccess) {
            ctx.last_error = "failed to import LLG checkpoint device field";
            return false;
        }
        offset += component_bytes;
    }
    return true;
}

} // namespace

int context_llg_checkpoint_query_size_v1(
    Context &ctx, uint64_t &out_required_bytes)
{
    uint32_t mask = 0;
    if (!required_bytes(ctx, out_required_bytes, mask)) {
        ctx.last_error =
            "LLG checkpoint v1 requires a non-empty FP64 single-grid context";
        return FULLMAG_FDM_ERR_INVALID;
    }
    return FULLMAG_FDM_OK;
}

int context_llg_checkpoint_export_v1(
    Context &ctx,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v1 &out_info)
{
    uint64_t required = 0;
    uint32_t mask = 0;
    if (!destination || !required_bytes(ctx, required, mask) ||
        exact_capacity != required) {
        ctx.last_error = "LLG checkpoint export requires the exact queried capacity";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (ctx.gpu_transport_active_attempt_id != 0 ||
        ctx.gpu_transport_pre_step_m_valid) {
        ctx.last_error = "LLG checkpoint export requires an accepted step boundary";
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::vector<std::byte> payload(static_cast<size_t>(required), std::byte{0});
    HeaderV1 header{};
    header.magic0 = kMagic0;
    header.magic1 = kMagic1;
    header.info = checkpoint_info(ctx, required, mask);
    std::memcpy(payload.data(), &header, sizeof(header));
    uint64_t offset = sizeof(header);
    if (!copy_device_to_host(ctx, ctx.m, payload.data(), offset) ||
        ((mask & kArrayFsal) != 0 &&
         !copy_device_to_host(ctx, ctx.k_fsal, payload.data(), offset)) ||
        ((mask & kArrayAbmFn) != 0 &&
         (!copy_device_to_host(ctx, ctx.abm_f_n, payload.data(), offset) ||
          !copy_device_to_host(ctx, ctx.abm_f_n1, payload.data(), offset) ||
          !copy_device_to_host(ctx, ctx.abm_f_n2, payload.data(), offset)))) {
        return FULLMAG_FDM_ERR_CUDA;
    }
    if (offset != required) {
        ctx.last_error = "LLG checkpoint export internal size mismatch";
        return FULLMAG_FDM_ERR_INTERNAL;
    }
    header.payload_checksum = checksum(payload.data(), required);
    std::memcpy(payload.data(), &header, sizeof(header));
    std::memcpy(destination, payload.data(), static_cast<size_t>(required));
    out_info = header.info;
    return FULLMAG_FDM_OK;
}

int context_llg_checkpoint_import_v1(
    Context &ctx,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v1 &expected_info)
{
    uint64_t required = 0;
    uint32_t expected_mask = 0;
    if (!source || !required_bytes(ctx, required, expected_mask) ||
        exact_bytes != required || exact_bytes < sizeof(HeaderV1)) {
        ctx.last_error = "LLG checkpoint import size or context mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (ctx.step_count != 0 || ctx.current_time != 0.0 ||
        ctx.gpu_transport_attempt_generation != 0 ||
        ctx.gpu_transport_active_attempt_id != 0 ||
        ctx.gpu_transport_rhs.active || ctx.gpu_transport_pre_step_m_valid) {
        ctx.last_error = "LLG checkpoint import requires a fresh unbound context";
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::vector<std::byte> payload(static_cast<size_t>(exact_bytes));
    std::memcpy(payload.data(), source, static_cast<size_t>(exact_bytes));
    HeaderV1 header{};
    std::memcpy(&header, payload.data(), sizeof(header));
    const uint64_t stored_checksum = header.payload_checksum;
    header.payload_checksum = 0;
    std::memcpy(payload.data(), &header, sizeof(header));
    const uint64_t computed_checksum = checksum(payload.data(), exact_bytes);
    if (header.magic0 != kMagic0 || header.magic1 != kMagic1 ||
        stored_checksum != computed_checksum ||
        header.info.schema_version != FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V1 ||
        header.info.integrator != static_cast<uint32_t>(ctx.integrator) ||
        header.info.precision != static_cast<uint32_t>(ctx.precision) ||
        header.info.array_mask != expected_mask ||
        header.info.cell_count != ctx.cell_count ||
        header.info.payload_bytes != exact_bytes ||
        header.info.reserved0 != 0 || header.info.fsal_valid > 1 ||
        header.info.adaptive_has_previous_error > 1 ||
        header.info.abm_startup > 3 ||
        !std::isfinite(header.info.current_time) ||
        !std::isfinite(header.info.current_dt) || header.info.current_dt <= 0.0 ||
        !std::isfinite(header.info.abm_last_dt) ||
        !std::isfinite(header.info.adaptive_previous_error) ||
        !info_equal(header.info, expected_info)) {
        ctx.last_error = "LLG checkpoint integrity or identity mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }
    uint64_t offset = sizeof(header);
    if (!copy_host_to_device(ctx, ctx.m, payload.data(), offset) ||
        ((expected_mask & kArrayFsal) != 0 &&
         !copy_host_to_device(ctx, ctx.k_fsal, payload.data(), offset)) ||
        ((expected_mask & kArrayAbmFn) != 0 &&
         (!copy_host_to_device(ctx, ctx.abm_f_n, payload.data(), offset) ||
          !copy_host_to_device(ctx, ctx.abm_f_n1, payload.data(), offset) ||
          !copy_host_to_device(ctx, ctx.abm_f_n2, payload.data(), offset)))) {
        return FULLMAG_FDM_ERR_CUDA;
    }
    if (offset != exact_bytes) {
        ctx.last_error = "LLG checkpoint import internal size mismatch";
        return FULLMAG_FDM_ERR_INTERNAL;
    }
    ctx.step_count = header.info.step_count;
    ctx.current_time = header.info.current_time;
    ctx.current_dt = header.info.current_dt;
    ctx.gpu_transport_attempt_generation =
        header.info.transport_attempt_generation;
    ctx.fsal_valid = header.info.fsal_valid != 0;
    ctx.abm_startup = header.info.abm_startup;
    ctx.abm_last_dt = header.info.abm_last_dt;
    ctx.adaptive_has_previous_error =
        header.info.adaptive_has_previous_error != 0;
    ctx.adaptive_previous_error = header.info.adaptive_previous_error;
    context_invalidate_gpu_transport_pre_step_m(ctx);
    ctx.last_error.clear();
    return FULLMAG_FDM_OK;
}

} // namespace fullmag::fdm
