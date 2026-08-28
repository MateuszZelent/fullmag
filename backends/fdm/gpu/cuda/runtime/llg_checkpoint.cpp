#include "context.hpp"
#include "../integrators/fsal_policy.hpp"
#include "llg_checkpoint_policy.hpp"

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

struct HeaderV2 {
    uint64_t magic0;
    uint64_t magic1;
    fullmag_fdm_llg_checkpoint_info_v2 info;
    uint64_t payload_checksum;
};

struct HeaderV3 {
    uint64_t magic0;
    uint64_t magic1;
    fullmag_fdm_llg_checkpoint_info_v3 info;
    uint64_t payload_checksum;
};

bool checkpoint_identity_v3_valid(
    const Context &ctx,
    const fullmag_fdm_checkpoint_execution_identity_v3 &identity);

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

bool required_bytes_v2(
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
        (std::numeric_limits<uint64_t>::max() - sizeof(HeaderV2)) /
            (arrays * components * sizeof(double))) {
        return false;
    }
    required = sizeof(HeaderV2) +
        arrays * components * ctx.cell_count * sizeof(double);
    return true;
}

bool required_bytes_v3(
    const Context &ctx, uint64_t &required, uint32_t &mask)
{
    if (ctx.precision != FULLMAG_FDM_PRECISION_DOUBLE ||
        ctx.has_multilayer_plan_v2 || ctx.cell_count == 0 ||
        !ctx.checkpoint_execution_identity_v3_valid ||
        !checkpoint_identity_v3_valid(
            ctx, ctx.checkpoint_execution_identity_v3)) {
        return false;
    }
    mask = array_mask(ctx);
    const uint64_t arrays = UINT64_C(1) +
        ((mask & kArrayFsal) != 0 ? UINT64_C(1) : UINT64_C(0)) +
        ((mask & kArrayAbmFn) != 0 ? UINT64_C(3) : UINT64_C(0));
    constexpr uint64_t components = 3;
    if (ctx.cell_count >
        (std::numeric_limits<uint64_t>::max() - sizeof(HeaderV3)) /
            (arrays * components * sizeof(double))) {
        return false;
    }
    required = sizeof(HeaderV3) +
        arrays * components * ctx.cell_count * sizeof(double);
    return true;
}

int32_t checkpoint_device_ordinal(const Context &ctx) {
    const auto &receipt = *ctx.execution_receipt;
    std::lock_guard<std::mutex> lock(receipt.accounting_mutex);
    return receipt.device_ordinal;
}

fullmag_fdm_llg_checkpoint_info_v2 checkpoint_info_v2(
    const Context &ctx, uint64_t payload_bytes, uint32_t mask)
{
    fullmag_fdm_llg_checkpoint_info_v2 info{};
    info.schema_version = FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V2;
    info.struct_size = sizeof(info);
    info.integrator = static_cast<uint32_t>(ctx.integrator);
    info.precision = static_cast<uint32_t>(ctx.precision);
    info.requested_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    info.resolved_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    info.executed_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    info.requested_policy = FULLMAG_FDM_CHECKPOINT_POLICY_GPU_REQUIRED;
    info.resolved_policy = FULLMAG_FDM_CHECKPOINT_POLICY_GPU_REQUIRED;
    info.execution_realization = FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM;
    info.device_ordinal = checkpoint_device_ordinal(ctx);
    info.array_mask = mask;
    info.cell_count = ctx.cell_count;
    info.payload_bytes = payload_bytes;
    info.step_count = ctx.step_count;
    info.accepted_step_index = ctx.accepted_step_index;
    info.accepted_state_revision = ctx.accepted_state_revision;
    info.current_time = ctx.current_time;
    info.current_dt = ctx.current_dt;
    info.transport_attempt_generation = ctx.gpu_transport_attempt_generation;
    info.rhs_source_revision = ctx.rhs_source_revision;
    info.rhs_field_revision = ctx.rhs_field_revision;
    info.rhs_transport_revision = ctx.rhs_transport_revision;
    info.projection_policy_identity = ctx.projection_policy_identity;
    info.fsal_valid = ctx.fsal_valid ? 1U : 0U;
    info.abm_startup = ctx.abm_startup;
    info.abm_last_dt = ctx.abm_last_dt;
    info.adaptive_enabled = ctx.adaptive_enabled ? 1U : 0U;
    info.adaptive_has_previous_error =
        ctx.adaptive_has_previous_error ? 1U : 0U;
    info.adaptive_previous_error = ctx.adaptive_previous_error;
    info.fsal_accepted_state_revision = ctx.fsal_accepted_state_revision;
    info.fsal_accepted_time_bits = ctx.fsal_accepted_time_bits;
    info.fsal_accepted_dt_bits = ctx.fsal_accepted_dt_bits;
    info.fsal_source_revision = ctx.fsal_source_revision;
    info.fsal_field_revision = ctx.fsal_field_revision;
    info.fsal_transport_revision = ctx.fsal_transport_revision;
    info.fsal_transport_state_identity = ctx.fsal_transport_state_identity;
    info.fsal_projection_policy_identity = ctx.fsal_projection_policy_identity;
    info.fsal_integrator_identity = ctx.fsal_integrator_identity;
    info.fsal_precision_identity = ctx.fsal_precision_identity;
    return info;
}

bool info_equal_v2(
    const fullmag_fdm_llg_checkpoint_info_v2 &left,
    const fullmag_fdm_llg_checkpoint_info_v2 &right)
{
    return std::memcmp(&left, &right, sizeof(left)) == 0;
}

fullmag_fdm_llg_checkpoint_info_v3 checkpoint_info_v3(
    const Context &ctx, uint64_t payload_bytes, uint32_t mask)
{
    fullmag_fdm_llg_checkpoint_info_v3 info{};
    info.schema_version = FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3;
    info.struct_size = sizeof(info);
    info.execution_identity = ctx.checkpoint_execution_identity_v3;
    info.array_mask = mask;
    info.cell_count = ctx.cell_count;
    info.payload_bytes = payload_bytes;
    info.step_count = ctx.step_count;
    info.accepted_step_index = ctx.accepted_step_index;
    info.accepted_state_revision = ctx.accepted_state_revision;
    info.current_time = ctx.current_time;
    info.current_dt = ctx.current_dt;
    info.thermal_seed = ctx.thermal_seed;
    info.rng_algorithm = ctx.temperature > 0.0
        ? FULLMAG_FDM_CHECKPOINT_RNG_CURAND_PHILOX4X32_10
        : FULLMAG_FDM_CHECKPOINT_RNG_NONE;
    info.rng_realization = ctx.temperature <= 0.0
        ? FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_DISABLED
        : (ctx.precision == FULLMAG_FDM_PRECISION_SINGLE
            ? FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_CUDA_FP32
            : FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_CUDA_FP64);
    info.transport_attempt_generation = ctx.gpu_transport_attempt_generation;
    info.rhs_source_revision = ctx.rhs_source_revision;
    info.rhs_field_revision = ctx.rhs_field_revision;
    info.rhs_transport_revision = ctx.rhs_transport_revision;
    info.projection_policy_identity = ctx.projection_policy_identity;
    info.fsal_valid = ctx.fsal_valid ? 1U : 0U;
    info.abm_startup = ctx.abm_startup;
    info.abm_last_dt = ctx.abm_last_dt;
    info.adaptive_enabled = ctx.adaptive_enabled ? 1U : 0U;
    info.adaptive_has_previous_error =
        ctx.adaptive_has_previous_error ? 1U : 0U;
    info.adaptive_previous_error = ctx.adaptive_previous_error;
    info.fsal_accepted_state_revision = ctx.fsal_accepted_state_revision;
    info.fsal_accepted_time_bits = ctx.fsal_accepted_time_bits;
    info.fsal_accepted_dt_bits = ctx.fsal_accepted_dt_bits;
    info.fsal_source_revision = ctx.fsal_source_revision;
    info.fsal_field_revision = ctx.fsal_field_revision;
    info.fsal_transport_revision = ctx.fsal_transport_revision;
    info.fsal_transport_state_identity = ctx.fsal_transport_state_identity;
    info.fsal_projection_policy_identity = ctx.fsal_projection_policy_identity;
    info.fsal_integrator_identity = ctx.fsal_integrator_identity;
    info.fsal_precision_identity = ctx.fsal_precision_identity;
    return info;
}

bool checkpoint_identity_v3_valid(
    const Context &ctx,
    const fullmag_fdm_checkpoint_execution_identity_v3 &identity)
{
    const auto &receipt = *ctx.execution_receipt;
    std::lock_guard<std::mutex> lock(receipt.accounting_mutex);
    const auto precision = static_cast<uint32_t>(ctx.precision);
    const auto integrator = static_cast<uint32_t>(ctx.integrator);
    const bool policy_valid =
        identity.requested_policy == FULLMAG_FDM_CHECKPOINT_POLICY_STRICT ||
        identity.requested_policy == FULLMAG_FDM_CHECKPOINT_POLICY_EXTENDED;
    return identity.abi_version ==
               FULLMAG_FDM_CHECKPOINT_EXECUTION_IDENTITY_ABI_V3 &&
        identity.struct_size == sizeof(identity) && identity.reserved0 == 0 &&
        (identity.requested_backend == FULLMAG_FDM_CHECKPOINT_BACKEND_AUTO ||
         identity.requested_backend == FULLMAG_FDM_CHECKPOINT_BACKEND_FDM) &&
        identity.resolved_backend == FULLMAG_FDM_CHECKPOINT_BACKEND_FDM &&
        identity.executed_backend == FULLMAG_FDM_CHECKPOINT_BACKEND_FDM &&
        policy_valid && identity.resolved_policy == identity.requested_policy &&
        identity.executed_policy == identity.requested_policy &&
        (identity.requested_realization == 0 ||
         identity.requested_realization ==
             FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM) &&
        identity.resolved_realization ==
            FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM &&
        identity.executed_realization ==
            FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM &&
        (identity.requested_device == FULLMAG_FDM_CHECKPOINT_DEVICE_AUTO ||
         identity.requested_device == FULLMAG_FDM_CHECKPOINT_DEVICE_GPU) &&
        identity.resolved_device == FULLMAG_FDM_CHECKPOINT_DEVICE_GPU &&
        identity.executed_device == FULLMAG_FDM_CHECKPOINT_DEVICE_GPU &&
        identity.requested_precision == precision &&
        identity.resolved_precision == precision &&
        identity.executed_precision == precision &&
        identity.requested_integrator == integrator &&
        identity.resolved_integrator == integrator &&
        identity.executed_integrator == integrator &&
        identity.device_ordinal >= 0 &&
        identity.device_ordinal == receipt.device_ordinal &&
        receipt.accounting_valid && receipt.host_operator_mask == 0 &&
        receipt.executed_host_operator_mask == 0 &&
        fullmag_fdm_resolved_unknown_operator_mask_locked(receipt) == 0;
}

bool checkpoint_execution_receipt_v3_exportable(const Context &ctx)
{
    const auto &receipt = *ctx.execution_receipt;
    std::lock_guard<std::mutex> lock(receipt.accounting_mutex);
    const uint64_t required = receipt.required_operator_mask;
    return receipt.accounting_valid && required != 0 &&
        receipt.fallback_count == 0 && receipt.host_operator_mask == 0 &&
        receipt.executed_host_operator_mask == 0 &&
        fullmag_fdm_resolved_unknown_operator_mask_locked(receipt) == 0 &&
        fullmag_fdm_executed_unknown_operator_mask_locked(receipt) == 0 &&
        (receipt.device_operator_mask & required) == required &&
        (receipt.executed_device_operator_mask & required) == required;
}

bool info_equal_v3(
    const fullmag_fdm_llg_checkpoint_info_v3 &left,
    const fullmag_fdm_llg_checkpoint_info_v3 &right)
{
    return std::memcmp(&left, &right, sizeof(left)) == 0;
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
    (void)source;
    (void)exact_bytes;
    (void)expected_info;
    ctx.last_error =
        "legacy LLG checkpoint v1 import is unsupported: exact execution identity is unavailable; export and restore schema v2";
    return FULLMAG_FDM_ERR_ABI;
}

int context_llg_checkpoint_query_size_v2(
    Context &ctx, uint64_t &out_required_bytes)
{
    uint32_t mask = 0;
    if (!required_bytes_v2(ctx, out_required_bytes, mask)) {
        ctx.last_error =
            "LLG checkpoint v2 requires a non-empty FP64 single-grid context";
        return FULLMAG_FDM_ERR_INVALID;
    }
    return FULLMAG_FDM_OK;
}

int context_llg_checkpoint_export_v2(
    Context &ctx,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v2 &out_info)
{
    uint64_t required = 0;
    uint32_t mask = 0;
    if (!destination || !required_bytes_v2(ctx, required, mask) ||
        exact_capacity != required) {
        ctx.last_error = "LLG checkpoint v2 export requires the exact queried capacity";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (ctx.gpu_transport_active_attempt_id != 0 ||
        ctx.gpu_transport_pre_step_m_valid || ctx.accepted_step_pending) {
        ctx.last_error = "LLG checkpoint v2 export requires an accepted step boundary";
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::vector<std::byte> payload(static_cast<size_t>(required), std::byte{0});
    HeaderV2 header{};
    header.magic0 = kMagic0;
    header.magic1 = kMagic1;
    header.info = checkpoint_info_v2(ctx, required, mask);
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
        ctx.last_error = "LLG checkpoint v2 export internal size mismatch";
        return FULLMAG_FDM_ERR_INTERNAL;
    }
    header.payload_checksum = checksum(payload.data(), required);
    std::memcpy(payload.data(), &header, sizeof(header));
    std::memcpy(destination, payload.data(), static_cast<size_t>(required));
    out_info = header.info;
    return FULLMAG_FDM_OK;
}

int context_llg_checkpoint_import_v2(
    Context &ctx,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v2 &expected_info)
{
    (void)source;
    (void)exact_bytes;
    (void)expected_info;
    ctx.last_error =
        "legacy LLG checkpoint v2 import is unsupported: resolved RNG and complete execution identity are unavailable; export and restore schema v3";
    return FULLMAG_FDM_ERR_ABI;
}

bool context_set_checkpoint_execution_identity_v3(
    Context &ctx,
    const fullmag_fdm_checkpoint_execution_identity_v3 &identity)
{
    if (!checkpoint_identity_v3_valid(ctx, identity)) {
        ctx.last_error =
            "checkpoint execution identity v3 conflicts with the native context or execution receipt";
        return false;
    }
    ctx.checkpoint_execution_identity_v3 = identity;
    ctx.checkpoint_execution_identity_v3_valid = true;
    ctx.last_error.clear();
    return true;
}

int context_llg_checkpoint_query_size_v3(
    Context &ctx, uint64_t &out_required_bytes)
{
    uint32_t mask = 0;
    if (!required_bytes_v3(ctx, out_required_bytes, mask) ||
        !checkpoint_execution_receipt_v3_exportable(ctx)) {
        ctx.last_error =
            "LLG checkpoint v3 export requires exact executed CUDA receipt without fallback";
        return FULLMAG_FDM_ERR_ABI;
    }
    return FULLMAG_FDM_OK;
}

int context_llg_checkpoint_export_v3(
    Context &ctx,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v3 &out_info)
{
    uint64_t required = 0;
    uint32_t mask = 0;
    if (!destination || !required_bytes_v3(ctx, required, mask) ||
        !checkpoint_execution_receipt_v3_exportable(ctx) ||
        exact_capacity != required) {
        ctx.last_error =
            "LLG checkpoint v3 export requires exact executed CUDA receipt and queried capacity";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (ctx.gpu_transport_active_attempt_id != 0 ||
        ctx.gpu_transport_pre_step_m_valid || ctx.accepted_step_pending) {
        ctx.last_error = "LLG checkpoint v3 export requires an accepted step boundary";
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::vector<std::byte> payload(static_cast<size_t>(required), std::byte{0});
    HeaderV3 header{};
    header.magic0 = kMagic0;
    header.magic1 = kMagic1;
    header.info = checkpoint_info_v3(ctx, required, mask);
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
        ctx.last_error = "LLG checkpoint v3 export internal size mismatch";
        return FULLMAG_FDM_ERR_INTERNAL;
    }
    header.payload_checksum = checksum(payload.data(), required);
    std::memcpy(payload.data(), &header, sizeof(header));
    std::memcpy(destination, payload.data(), static_cast<size_t>(required));
    out_info = header.info;
    return FULLMAG_FDM_OK;
}

int context_llg_checkpoint_import_v3(
    Context &ctx,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v3 &expected_info)
{
    uint64_t required = 0;
    uint32_t expected_mask = 0;
    if (!source || !required_bytes_v3(ctx, required, expected_mask) ||
        exact_bytes != required || exact_bytes < sizeof(HeaderV3)) {
        ctx.last_error = "LLG checkpoint v3 size, identity, or context mismatch";
        return FULLMAG_FDM_ERR_ABI;
    }
    if (ctx.step_count != 0 || ctx.current_time != 0.0 ||
        ctx.gpu_transport_attempt_generation != 0 ||
        ctx.gpu_transport_active_attempt_id != 0 ||
        ctx.gpu_transport_rhs.active || ctx.gpu_transport_pre_step_m_valid ||
        ctx.gpu_transport_pre_step_abm_valid) {
        ctx.last_error = "LLG checkpoint v3 import requires a fresh unbound context";
        return FULLMAG_FDM_ERR_INVALID;
    }

    HeaderV3 raw_header{};
    std::memcpy(&raw_header, source, sizeof(raw_header));
    const auto local_identity = checkpoint_info_v3(ctx, exact_bytes, expected_mask);
    if (raw_header.magic0 != kMagic0 || raw_header.magic1 != kMagic1 ||
        raw_header.info.schema_version != FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3 ||
        raw_header.info.struct_size != sizeof(raw_header.info) ||
        std::memcmp(&raw_header.info.execution_identity,
                    &local_identity.execution_identity,
                    sizeof(raw_header.info.execution_identity)) != 0 ||
        raw_header.info.array_mask != expected_mask ||
        raw_header.info.cell_count != ctx.cell_count ||
        raw_header.info.payload_bytes != exact_bytes ||
        raw_header.info.thermal_seed != ctx.thermal_seed ||
        raw_header.info.rng_algorithm != local_identity.rng_algorithm ||
        raw_header.info.rng_realization != local_identity.rng_realization ||
        !info_equal_v3(raw_header.info, expected_info)) {
        ctx.last_error = "LLG checkpoint v3 execution or RNG identity mismatch";
        return FULLMAG_FDM_ERR_ABI;
    }

    std::vector<std::byte> payload(static_cast<size_t>(exact_bytes));
    std::memcpy(payload.data(), source, static_cast<size_t>(exact_bytes));
    HeaderV3 header{};
    std::memcpy(&header, payload.data(), sizeof(header));
    const uint64_t stored_checksum = header.payload_checksum;
    header.payload_checksum = 0;
    std::memcpy(payload.data(), &header, sizeof(header));
    if (stored_checksum != checksum(payload.data(), exact_bytes) ||
        header.info.fsal_valid > 1 || header.info.adaptive_enabled > 1 ||
        header.info.adaptive_has_previous_error > 1 ||
        header.info.abm_startup > 3 ||
        !std::isfinite(header.info.current_time) ||
        !std::isfinite(header.info.current_dt) || header.info.current_dt <= 0.0 ||
        !std::isfinite(header.info.abm_last_dt) ||
        !std::isfinite(header.info.adaptive_previous_error) ||
        header.info.accepted_step_index != header.info.step_count ||
        header.info.accepted_state_revision == 0 ||
        header.info.rhs_source_revision == 0 ||
        header.info.rhs_field_revision == 0 ||
        header.info.rhs_transport_revision == 0 ||
        header.info.projection_policy_identity == 0 ||
        (header.info.fsal_valid != 0 &&
         (header.info.fsal_accepted_state_revision !=
              header.info.accepted_state_revision ||
          header.info.fsal_accepted_time_bits !=
              fsal_double_bits(header.info.current_time) ||
          header.info.fsal_source_revision == 0 ||
          header.info.fsal_field_revision == 0 ||
          header.info.fsal_transport_revision == 0 ||
          header.info.fsal_transport_state_identity == 0 ||
          header.info.fsal_projection_policy_identity == 0 ||
          header.info.fsal_integrator_identity == 0 ||
          header.info.fsal_precision_identity == 0))) {
        ctx.last_error = "LLG checkpoint v3 integrity or state identity mismatch";
        return FULLMAG_FDM_ERR_ABI;
    }

    const bool include_fsal = (expected_mask & kArrayFsal) != 0;
    const bool include_abm_history = (expected_mask & kArrayAbmFn) != 0;
    if (!context_prepare_checkpoint_import_staging(
            ctx, include_fsal, include_abm_history)) {
        ctx.last_error = "failed to allocate atomic checkpoint import staging";
        return FULLMAG_FDM_ERR_CUDA;
    }
    uint64_t offset = sizeof(header);
    if (!copy_host_to_device(
            ctx, ctx.gpu_transport_pre_step_m, payload.data(), offset) ||
        (include_fsal &&
         !copy_host_to_device(
             ctx, ctx.gpu_transport_pre_step_abm_f_n, payload.data(), offset)) ||
        (include_abm_history &&
         (!copy_host_to_device(
              ctx, ctx.gpu_transport_pre_step_abm_f_n, payload.data(), offset) ||
          !copy_host_to_device(
              ctx, ctx.gpu_transport_pre_step_abm_f_n1, payload.data(), offset) ||
          !copy_host_to_device(
              ctx, ctx.gpu_transport_pre_step_abm_f_n2, payload.data(), offset)))) {
        return FULLMAG_FDM_ERR_CUDA;
    }
    if (offset != exact_bytes) {
        ctx.last_error = "LLG checkpoint v3 import internal size mismatch";
        return FULLMAG_FDM_ERR_INTERNAL;
    }
    context_commit_checkpoint_import_staging(
        ctx, include_fsal, include_abm_history);
    ctx.step_count = header.info.step_count;
    ctx.accepted_step_index = header.info.accepted_step_index;
    ctx.accepted_state_revision = header.info.accepted_state_revision;
    ctx.current_time = header.info.current_time;
    ctx.current_dt = header.info.current_dt;
    ctx.gpu_transport_attempt_generation = header.info.transport_attempt_generation;
    ctx.rhs_source_revision = header.info.rhs_source_revision;
    ctx.rhs_field_revision = header.info.rhs_field_revision;
    ctx.rhs_transport_revision = header.info.rhs_transport_revision;
    ctx.projection_policy_identity = header.info.projection_policy_identity;
    ctx.abm_startup = header.info.abm_startup;
    ctx.abm_last_dt = header.info.abm_last_dt;
    ctx.adaptive_enabled = header.info.adaptive_enabled != 0;
    ctx.adaptive_has_previous_error =
        header.info.adaptive_has_previous_error != 0;
    ctx.adaptive_previous_error = header.info.adaptive_previous_error;
    ctx.adaptive_rejected_attempts = 0;
    ctx.fsal_pending = false;
    ctx.fsal_accepted_state_revision = header.info.fsal_accepted_state_revision;
    ctx.fsal_accepted_time_bits = header.info.fsal_accepted_time_bits;
    ctx.fsal_accepted_dt_bits = header.info.fsal_accepted_dt_bits;
    ctx.fsal_source_revision = header.info.fsal_source_revision;
    ctx.fsal_field_revision = header.info.fsal_field_revision;
    ctx.fsal_transport_revision = header.info.fsal_transport_revision;
    ctx.fsal_transport_state_identity = header.info.fsal_transport_state_identity;
    ctx.fsal_projection_policy_identity =
        header.info.fsal_projection_policy_identity;
    ctx.fsal_integrator_identity = header.info.fsal_integrator_identity;
    ctx.fsal_precision_identity = header.info.fsal_precision_identity;
    context_invalidate_fsal_cache(
        ctx, FULLMAG_FDM_FSAL_INVALIDATION_CHECKPOINT_RESTORE);
    context_discard_pre_step_state(ctx);
    context_invalidate_observables(ctx);
    ctx.last_error.clear();
    return FULLMAG_FDM_OK;
}

} // namespace fullmag::fdm
