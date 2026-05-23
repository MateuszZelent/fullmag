/*
 * GPU state facade source contract.
 *
 * This source owns FemGpuState allocation/free, host-device buffer transfers,
 * runtime coefficient uploads, mesh/material/stage storage, and CUDA/no-CUDA
 * fallback behavior for the native FEM GPU scaffold. It does not own MFEM device selection, Context construction, exchange operator assembly, integrator execution, or C ABI entrypoints.
 */

#include "gpu_state.hpp"

#include "context.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "kernels.h"
#endif

#include <algorithm>
#include <cstddef>
#include <limits>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr uint32_t kCudaBlockSize = 256;

bool checked_node_bytes(uint64_t node_count, size_t &bytes, std::string &error)
{
    if (node_count > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState node count is too large for device allocation";
        return false;
    }
    bytes = static_cast<size_t>(node_count) * sizeof(double);
    return true;
}

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool allocate_bytes(void **ptr, size_t bytes, uint64_t &device_bytes, std::string &error)
{
    if (bytes == 0) {
        *ptr = nullptr;
        return true;
    }
    if (!cuda_ok(cudaMalloc(ptr, bytes), "cudaMalloc", error)) {
        *ptr = nullptr;
        return false;
    }
    device_bytes += static_cast<uint64_t>(bytes);
    return true;
}

bool allocate_double(double *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error)
{
    if (count > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState double buffer is too large for device allocation";
        return false;
    }
    void *raw = nullptr;
    if (!allocate_bytes(&raw, static_cast<size_t>(count) * sizeof(double), device_bytes, error)) {
        return false;
    }
    ptr = static_cast<double *>(raw);
    return true;
}

bool allocate_u8(uint8_t *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error)
{
    void *raw = nullptr;
    if (!allocate_bytes(&raw, static_cast<size_t>(count), device_bytes, error)) {
        return false;
    }
    ptr = static_cast<uint8_t *>(raw);
    return true;
}

bool allocate_u32(uint32_t *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error)
{
    if (count > std::numeric_limits<size_t>::max() / sizeof(uint32_t)) {
        error = "FemGpuState u32 buffer is too large for device allocation";
        return false;
    }
    void *raw = nullptr;
    if (!allocate_bytes(&raw, static_cast<size_t>(count) * sizeof(uint32_t), device_bytes, error)) {
        return false;
    }
    ptr = static_cast<uint32_t *>(raw);
    return true;
}

bool allocate_component(
    FemGpuComponentField &field,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    return allocate_double(field.x, node_count, device_bytes, error) &&
           allocate_double(field.y, node_count, device_bytes, error) &&
           allocate_double(field.z, node_count, device_bytes, error);
}

void free_double(double *&ptr)
{
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
}

void free_bytes(void *&ptr)
{
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
}

void free_u8(uint8_t *&ptr)
{
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
}

void free_u32(uint32_t *&ptr)
{
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
}

void free_component(FemGpuComponentField &field)
{
    free_double(field.x);
    free_double(field.y);
    free_double(field.z);
}

void reset_exchange_legacy_sparse(FemGpuState &state)
{
    const uint64_t previous_device_bytes = state.exchange_legacy_sparse_device_bytes;
    free_u32(state.exchange_csr_row_offsets);
    free_u32(state.exchange_csr_col_indices);
    free_double(state.exchange_csr_values);
    free_double(state.exchange_lumped_mass);
    free_double(state.exchange_inv_lumped_mass);
    if (previous_device_bytes <= state.device_bytes) {
        state.device_bytes -= previous_device_bytes;
    } else {
        state.device_bytes = 0;
    }
    state.exchange_legacy_sparse_uploaded = false;
    state.exchange_legacy_sparse_rows = 0;
    state.exchange_legacy_sparse_cols = 0;
    state.exchange_legacy_sparse_nnz = 0;
    state.exchange_legacy_sparse_device_bytes = 0;
}
#endif

void reset_metadata(FemGpuState &state)
{
    state.initialized = false;
    state.allocated = false;
    state.node_count = 0;
    state.dof_len = 0;
    state.stage_count = 0;
    state.device_bytes = 0;
    state.reduction_workspace_bytes = 0;
    state.scalar_reduce_temp_storage_bytes = 0;
    state.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.host_state = FemGpuSyncState::HostClean;
    state.device_state = FemGpuSyncState::HostStale;
    state.runtime_coefficients_uploaded = false;
    state.fsal_valid = false;
    state.exchange_legacy_sparse_uploaded = false;
    state.exchange_legacy_sparse_rows = 0;
    state.exchange_legacy_sparse_cols = 0;
    state.exchange_legacy_sparse_nnz = 0;
    state.exchange_legacy_sparse_device_bytes = 0;
    state.mel_strain_voigt_len = 0;
    state.mel_strain_uploaded = false;
    state.mesh_element_count = 0;
    state.mesh_geometry_uploaded = false;
    state.hybrid_stage_m_xyz.clear();
    state.hybrid_demag_xyz.clear();
    state.hybrid_demag_energy_joules = 0.0;
}

} // namespace

uint32_t gpu_state_stage_count(fullmag_fem_integrator integrator)
{
    switch (integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:
            return 2;
        case FULLMAG_FEM_INTEGRATOR_RK4:
            return 4;
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:
            return 4;
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54:
            return 7;
        default:
            return 2;
    }
}

bool gpu_state_upload_magnetization_aos(
    FemGpuState &state,
    const double *m_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }
    if (m_xyz == nullptr) {
        error = "FemGpuState magnetization upload received a null pointer";
        return false;
    }
    if (len != state.dof_len) {
        error = "FemGpuState magnetization upload length mismatch";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    size_t component_bytes = 0;
    if (!checked_node_bytes(state.node_count, component_bytes, error)) {
        return false;
    }
    if (state.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "FemGpuState magnetization upload node count exceeds CUDA kernel range";
        return false;
    }

    fullmag_cuda_upload_aos_to_soa(
        m_xyz,
        state.m.x,
        state.m.y,
        state.m.z,
        static_cast<int>(state.node_count),
        nullptr);
    if (!cuda_ok(cudaStreamSynchronize(nullptr),
            "fullmag_cuda_upload_aos_to_soa FemGpuState m host->device", error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(component_bytes) * 3ull);
    state.device_state = FemGpuSyncState::DeviceClean;
    state.host_state = FemGpuSyncState::HostClean;
    state.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.fsal_valid = false;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_download_magnetization_aos(
    FemGpuState &state,
    std::vector<double> &out_m_xyz,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }
    if (state.m.x == nullptr || state.m.y == nullptr || state.m.z == nullptr) {
        error = "FemGpuState magnetization readback requires allocated device buffers";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    size_t component_bytes = 0;
    if (!checked_node_bytes(state.node_count, component_bytes, error)) {
        return false;
    }
    if (state.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "FemGpuState magnetization download node count exceeds CUDA kernel range";
        return false;
    }

    out_m_xyz.resize(static_cast<size_t>(state.dof_len));
    fullmag_cuda_download_soa_to_aos(
        state.m.x,
        state.m.y,
        state.m.z,
        out_m_xyz.data(),
        static_cast<int>(state.node_count),
        nullptr);
    if (!cuda_ok(cudaStreamSynchronize(nullptr),
            "fullmag_cuda_download_soa_to_aos FemGpuState m device->host", error)) {
        return false;
    }

    record_device_to_host(audit, static_cast<uint64_t>(component_bytes) * 3ull);
    state.host_state = FemGpuSyncState::HostClean;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_upload_component_aos(
    FemGpuState &state,
    FemGpuComponentField &field,
    const double *xyz,
    uint64_t len,
    const char *label,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }
    if (xyz == nullptr) {
        error = std::string("FemGpuState ") + label + " upload received a null pointer";
        return false;
    }
    if (len != state.dof_len) {
        error = std::string("FemGpuState ") + label + " upload length mismatch";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    size_t component_bytes = 0;
    if (!checked_node_bytes(state.node_count, component_bytes, error)) {
        return false;
    }
    if (state.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = std::string("FemGpuState ") + label +
            " upload node count exceeds CUDA kernel range";
        return false;
    }

    const std::string op_prefix = std::string("cudaMemcpy FemGpuState ") + label;
    fullmag_cuda_upload_aos_to_soa(
        xyz,
        field.x,
        field.y,
        field.z,
        static_cast<int>(state.node_count),
        nullptr);
    if (!cuda_ok(cudaStreamSynchronize(nullptr),
            (op_prefix + " fullmag_cuda_upload_aos_to_soa host->device").c_str(),
            error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(component_bytes) * 3ull);
    return true;
#else
    (void)field;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_zero_component_device(
    FemGpuState &state,
    FemGpuComponentField &field,
    const char *label,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    (void)audit;
    size_t component_bytes = 0;
    if (!checked_node_bytes(state.node_count, component_bytes, error)) {
        return false;
    }
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        error = std::string("FemGpuState ") + label + " zero fill received unallocated device components";
        return false;
    }

    const std::string op_prefix = std::string("cudaMemsetAsync FemGpuState ") + label;
    if (!cuda_ok(cudaMemsetAsync(field.x, 0, component_bytes, nullptr),
            (op_prefix + " x zero device").c_str(),
            error) ||
        !cuda_ok(cudaMemsetAsync(field.y, 0, component_bytes, nullptr),
            (op_prefix + " y zero device").c_str(),
            error) ||
        !cuda_ok(cudaMemsetAsync(field.z, 0, component_bytes, nullptr),
            (op_prefix + " z zero device").c_str(),
            error)) {
        return false;
    }
    return cuda_ok(cudaStreamSynchronize(nullptr),
        (op_prefix + " synchronize zero device").c_str(),
        error);
#else
    (void)field;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_upload_effective_fields_aos(
    FemGpuState &state,
    const double *h_ex_xyz,
    const double *h_demag_xyz,
    const double *h_ext_xyz,
    const double *h_eff_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }
    if (!gpu_state_upload_component_aos(
            state, state.h_ex, h_ex_xyz, len, "h_ex", audit, error) ||
        !gpu_state_upload_component_aos(
            state, state.h_demag, h_demag_xyz, len, "h_demag", audit, error) ||
        !gpu_state_upload_component_aos(
            state, state.h_ext, h_ext_xyz, len, "h_ext", audit, error) ||
        !gpu_state_upload_component_aos(
            state, state.h_eff, h_eff_xyz, len, "h_eff", audit, error)) {
        return false;
    }
    state.device_state = FemGpuSyncState::DeviceClean;
    return true;
}

bool gpu_state_upload_demag_field_aos(
    FemGpuState &state,
    const double *h_demag_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_state_upload_component_aos(
        state,
        state.h_demag,
        h_demag_xyz,
        len,
        "h_demag",
        audit,
        error);
}

bool gpu_state_upload_optional_component_aos(
    FemGpuState &state,
    FemGpuComponentField &field,
    const double *xyz,
    uint64_t len,
    const char *label,
    TransferAudit &audit,
    std::string &error)
{
    if (xyz == nullptr || len == 0) {
        return gpu_state_zero_component_device(state, field, label, audit, error);
    }
    return gpu_state_upload_component_aos(state, field, xyz, len, label, audit, error);
}

bool gpu_state_upload_local_vector_fields_aos(
    FemGpuState &state,
    const double *h_ani_xyz,
    const double *h_cubic_ani_xyz,
    const double *h_dmi_xyz,
    const double *h_bulk_dmi_xyz,
    const double *h_oe_xyz,
    const double *h_therm_xyz,
    const double *h_mel_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }
    if (!gpu_state_upload_optional_component_aos(
            state, state.h_ani, h_ani_xyz, len, "h_ani", audit, error) ||
        !gpu_state_upload_optional_component_aos(
            state, state.h_cubic_ani, h_cubic_ani_xyz, len, "h_cubic_ani", audit, error) ||
        !gpu_state_upload_optional_component_aos(
            state, state.h_dmi, h_dmi_xyz, len, "h_dmi", audit, error) ||
        !gpu_state_upload_optional_component_aos(
            state, state.h_bulk_dmi, h_bulk_dmi_xyz, len, "h_bulk_dmi", audit, error) ||
        !gpu_state_upload_optional_component_aos(
            state, state.h_oe, h_oe_xyz, len, "h_oe", audit, error) ||
        !gpu_state_upload_optional_component_aos(
            state, state.h_therm, h_therm_xyz, len, "h_therm", audit, error) ||
        !gpu_state_upload_optional_component_aos(
            state, state.h_mel, h_mel_xyz, len, "h_mel", audit, error)) {
        return false;
    }
    state.device_state = FemGpuSyncState::DeviceClean;
    return true;
}

bool gpu_state_upload_magnetoelastic_strain(
    FemGpuState &state,
    const double *strain_voigt,
    uint64_t strain_len,
    TransferAudit &audit,
    std::string &error)
{
    state.mel_strain_voigt_len = 0;
    state.mel_strain_uploaded = false;
    if (!state.allocated) {
        return true;
    }
    const uint64_t expected_len = state.node_count * 6ull;
    if (strain_voigt == nullptr || strain_len != expected_len) {
        error = "FemGpuState magnetoelastic strain upload requires 6 Voigt values per node";
        return false;
    }
    if (state.mel_strain_voigt == nullptr) {
        error = "FemGpuState magnetoelastic strain upload requires allocated device buffer";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    if (strain_len > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState magnetoelastic strain buffer is too large for upload";
        return false;
    }
    const size_t bytes = static_cast<size_t>(strain_len) * sizeof(double);
    if (!cuda_ok(cudaMemcpy(state.mel_strain_voigt, strain_voigt, bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState mel_strain_voigt host->device", error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(bytes));
    state.mel_strain_voigt_len = strain_len;
    state.mel_strain_uploaded = true;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_upload_mesh_geometry(
    FemGpuState &state,
    const double *nodes_xyz,
    uint64_t nodes_xyz_len,
    const uint32_t *elements,
    uint64_t elements_len,
    const uint8_t *magnetic_element_mask,
    uint64_t magnetic_element_mask_len,
    TransferAudit &audit,
    std::string &error)
{
    state.mesh_element_count = 0;
    state.mesh_geometry_uploaded = false;
    if (!state.allocated) {
        return true;
    }
    const uint64_t expected_nodes_len = state.node_count * 3ull;
    if (nodes_xyz == nullptr || nodes_xyz_len != expected_nodes_len) {
        error = "FemGpuState mesh geometry upload requires 3 coordinates per node";
        return false;
    }
    if (elements == nullptr || elements_len == 0 || elements_len % 4ull != 0) {
        error = "FemGpuState mesh geometry upload requires tetrahedral element connectivity";
        return false;
    }
    const uint64_t element_count = elements_len / 4ull;
    if (magnetic_element_mask != nullptr &&
        magnetic_element_mask_len != 0 &&
        magnetic_element_mask_len != element_count) {
        error = "FemGpuState mesh geometry upload received magnetic element mask length mismatch";
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (nodes_xyz_len > std::numeric_limits<size_t>::max() / sizeof(double) ||
        elements_len > std::numeric_limits<size_t>::max() / sizeof(uint32_t) ||
        element_count > std::numeric_limits<size_t>::max()) {
        error = "FemGpuState mesh geometry buffer is too large for upload";
        return false;
    }
    if (state.nodes_xyz == nullptr &&
        !allocate_double(state.nodes_xyz, expected_nodes_len, state.device_bytes, error)) {
        return false;
    }
    if (state.elements == nullptr &&
        !allocate_u32(state.elements, elements_len, state.device_bytes, error)) {
        return false;
    }
    if (state.magnetic_element_mask == nullptr &&
        !allocate_u8(state.magnetic_element_mask, element_count, state.device_bytes, error)) {
        return false;
    }
    const size_t nodes_bytes = static_cast<size_t>(nodes_xyz_len) * sizeof(double);
    const size_t elements_bytes = static_cast<size_t>(elements_len) * sizeof(uint32_t);
    std::vector<uint8_t> element_mask(static_cast<size_t>(element_count), 1u);
    if (magnetic_element_mask != nullptr && magnetic_element_mask_len == element_count) {
        std::copy(magnetic_element_mask, magnetic_element_mask + element_count, element_mask.begin());
    }
    const size_t mask_bytes = static_cast<size_t>(element_count) * sizeof(uint8_t);
    if (!cuda_ok(cudaMemcpy(state.nodes_xyz, nodes_xyz, nodes_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState nodes_xyz host->device", error) ||
        !cuda_ok(cudaMemcpy(state.elements, elements, elements_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState elements host->device", error) ||
        !cuda_ok(cudaMemcpy(state.magnetic_element_mask, element_mask.data(), mask_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetic_element_mask host->device", error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(nodes_bytes + elements_bytes + mask_bytes));
    state.mesh_element_count = element_count;
    state.mesh_geometry_uploaded = true;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_upload_runtime_coefficients(
    FemGpuState &state,
    const double *node_volumes,
    uint64_t node_volumes_len,
    const double *ms_field,
    uint64_t ms_field_len,
    double uniform_ms,
    const double *a_field,
    uint64_t a_field_len,
    double uniform_a,
    const double *alpha_field,
    uint64_t alpha_field_len,
    double uniform_alpha,
    const double *ku_field,
    uint64_t ku_field_len,
    const double *ku2_field,
    uint64_t ku2_field_len,
    const double *dind_field,
    uint64_t dind_field_len,
    const double *dbulk_field,
    uint64_t dbulk_field_len,
    const double *kc1_field,
    uint64_t kc1_field_len,
    const double *kc2_field,
    uint64_t kc2_field_len,
    const double *kc3_field,
    uint64_t kc3_field_len,
    const uint8_t *magnetic_node_mask,
    uint64_t magnetic_node_mask_len,
    const uint32_t *periodic_reduced_node,
    uint64_t periodic_reduced_node_len,
    const uint32_t *periodic_representative_nodes,
    uint64_t periodic_representative_nodes_len,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    const size_t node_count = static_cast<size_t>(state.node_count);
    const size_t double_bytes = node_count * sizeof(double);
    const size_t u8_bytes = node_count * sizeof(uint8_t);
    const size_t u32_bytes = node_count * sizeof(uint32_t);

    auto scalar_values = [node_count](const double *field, uint64_t len, double fallback) {
        std::vector<double> values(node_count, fallback);
        if (field != nullptr && len == static_cast<uint64_t>(node_count)) {
            std::copy(field, field + node_count, values.begin());
        }
        return values;
    };

    const auto node_volume_values = scalar_values(node_volumes, node_volumes_len, 0.0);
    const auto ms_values = scalar_values(ms_field, ms_field_len, uniform_ms);
    const auto a_values = scalar_values(a_field, a_field_len, uniform_a);
    const auto alpha_values = scalar_values(alpha_field, alpha_field_len, uniform_alpha);
    const auto ku_values = scalar_values(ku_field, ku_field_len, 0.0);
    const auto ku2_values = scalar_values(ku2_field, ku2_field_len, 0.0);
    const auto dind_values = scalar_values(dind_field, dind_field_len, 0.0);
    const auto dbulk_values = scalar_values(dbulk_field, dbulk_field_len, 0.0);
    const auto kc1_values = scalar_values(kc1_field, kc1_field_len, 0.0);
    const auto kc2_values = scalar_values(kc2_field, kc2_field_len, 0.0);
    const auto kc3_values = scalar_values(kc3_field, kc3_field_len, 0.0);

    std::vector<uint8_t> magnetic_mask(node_count, 1u);
    if (magnetic_node_mask != nullptr &&
        magnetic_node_mask_len == static_cast<uint64_t>(node_count)) {
        std::copy(magnetic_node_mask, magnetic_node_mask + node_count, magnetic_mask.begin());
    }

    std::vector<uint32_t> reduced_node(node_count);
    std::vector<uint32_t> representative_node(node_count);
    for (size_t node = 0; node < node_count; ++node) {
        reduced_node[node] = static_cast<uint32_t>(node);
        representative_node[node] = static_cast<uint32_t>(node);
    }
    if (periodic_reduced_node != nullptr &&
        periodic_reduced_node_len == static_cast<uint64_t>(node_count)) {
        std::copy(periodic_reduced_node, periodic_reduced_node + node_count, reduced_node.begin());
        if (periodic_representative_nodes != nullptr) {
            for (size_t node = 0; node < node_count; ++node) {
                const uint32_t reduced = reduced_node[node];
                if (reduced < periodic_representative_nodes_len) {
                    representative_node[node] =
                        periodic_representative_nodes[static_cast<size_t>(reduced)];
                }
            }
        }
    }

    if (!cuda_ok(cudaMemcpy(state.node_volumes, node_volume_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState node_volumes host->device", error) ||
        !cuda_ok(cudaMemcpy(state.ms, ms_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ms host->device", error) ||
        !cuda_ok(cudaMemcpy(state.a, a_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState a host->device", error) ||
        !cuda_ok(cudaMemcpy(state.alpha, alpha_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState alpha host->device", error) ||
        !cuda_ok(cudaMemcpy(state.ku, ku_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ku host->device", error) ||
        !cuda_ok(cudaMemcpy(state.ku2, ku2_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ku2 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.dind, dind_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState dind host->device", error) ||
        !cuda_ok(cudaMemcpy(state.dbulk, dbulk_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState dbulk host->device", error) ||
        !cuda_ok(cudaMemcpy(state.kc1, kc1_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc1 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.kc2, kc2_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc2 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.kc3, kc3_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc3 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.magnetic_node_mask, magnetic_mask.data(), u8_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetic_node_mask host->device", error) ||
        !cuda_ok(cudaMemcpy(state.periodic_reduced_node, reduced_node.data(), u32_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState periodic_reduced_node host->device", error) ||
        !cuda_ok(cudaMemcpy(state.periodic_representative_nodes, representative_node.data(), u32_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState periodic_representative_nodes host->device", error)) {
        return false;
    }
    record_host_to_device(
        audit,
        static_cast<uint64_t>(double_bytes) * 11ull +
            static_cast<uint64_t>(u8_bytes) +
            static_cast<uint64_t>(u32_bytes) * 2ull);
    state.runtime_coefficients_uploaded = true;
    return true;
#else
    (void)node_volumes;
    (void)node_volumes_len;
    (void)ms_field;
    (void)ms_field_len;
    (void)uniform_ms;
    (void)a_field;
    (void)a_field_len;
    (void)uniform_a;
    (void)alpha_field;
    (void)alpha_field_len;
    (void)uniform_alpha;
    (void)ku_field;
    (void)ku_field_len;
    (void)ku2_field;
    (void)ku2_field_len;
    (void)dind_field;
    (void)dind_field_len;
    (void)dbulk_field;
    (void)dbulk_field_len;
    (void)kc1_field;
    (void)kc1_field_len;
    (void)kc2_field;
    (void)kc2_field_len;
    (void)kc3_field;
    (void)kc3_field_len;
    (void)magnetic_node_mask;
    (void)magnetic_node_mask_len;
    (void)periodic_reduced_node;
    (void)periodic_reduced_node_len;
    (void)periodic_representative_nodes;
    (void)periodic_representative_nodes_len;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_state_upload_exchange_legacy_sparse(
    FemGpuState &state,
    uint64_t rows,
    uint64_t cols,
    const uint32_t *csr_row_offsets,
    uint64_t csr_row_offsets_len,
    const uint32_t *csr_col_indices,
    uint64_t csr_col_indices_len,
    const double *csr_values,
    uint64_t csr_values_len,
    const double *lumped_mass,
    uint64_t lumped_mass_len,
    const double *inv_lumped_mass,
    uint64_t inv_lumped_mass_len,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.allocated) {
        return true;
    }
    if (rows == 0 || cols == 0) {
        error = "FemGpuState exchange CSR upload requires non-empty dimensions";
        return false;
    }
    if (rows > std::numeric_limits<uint32_t>::max() ||
        cols > std::numeric_limits<uint32_t>::max()) {
        error = "FemGpuState exchange CSR dimensions exceed u32 device indexing";
        return false;
    }
    const uint64_t nnz = csr_values_len;
    if (csr_row_offsets == nullptr || csr_col_indices == nullptr || csr_values == nullptr ||
        lumped_mass == nullptr || inv_lumped_mass == nullptr) {
        error = "FemGpuState exchange CSR upload received a null pointer";
        return false;
    }
    if (csr_row_offsets_len != rows + 1ull ||
        csr_col_indices_len != nnz ||
        lumped_mass_len != rows ||
        inv_lumped_mass_len != rows) {
        error = "FemGpuState exchange CSR upload length mismatch";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    reset_exchange_legacy_sparse(state);

    uint64_t exchange_device_bytes = 0;
    if (!allocate_u32(state.exchange_csr_row_offsets, csr_row_offsets_len, exchange_device_bytes, error) ||
        !allocate_u32(state.exchange_csr_col_indices, csr_col_indices_len, exchange_device_bytes, error) ||
        !allocate_double(state.exchange_csr_values, nnz, exchange_device_bytes, error) ||
        !allocate_double(state.exchange_lumped_mass, rows, exchange_device_bytes, error) ||
        !allocate_double(state.exchange_inv_lumped_mass, rows, exchange_device_bytes, error)) {
        reset_exchange_legacy_sparse(state);
        return false;
    }

    const size_t row_offsets_bytes = static_cast<size_t>(csr_row_offsets_len) * sizeof(uint32_t);
    const size_t col_indices_bytes = static_cast<size_t>(csr_col_indices_len) * sizeof(uint32_t);
    const size_t values_bytes = static_cast<size_t>(nnz) * sizeof(double);
    const size_t mass_bytes = static_cast<size_t>(rows) * sizeof(double);
    if (!cuda_ok(cudaMemcpy(
                state.exchange_csr_row_offsets,
                csr_row_offsets,
                row_offsets_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange CSR row_offsets host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                state.exchange_csr_col_indices,
                csr_col_indices,
                col_indices_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange CSR col_indices host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                state.exchange_csr_values,
                csr_values,
                values_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange CSR values host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                state.exchange_lumped_mass,
                lumped_mass,
                mass_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange lumped_mass host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                state.exchange_inv_lumped_mass,
                inv_lumped_mass,
                mass_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange inv_lumped_mass host->device",
            error)) {
        reset_exchange_legacy_sparse(state);
        return false;
    }

    state.device_bytes += exchange_device_bytes;
    state.exchange_legacy_sparse_uploaded = true;
    state.exchange_legacy_sparse_rows = rows;
    state.exchange_legacy_sparse_cols = cols;
    state.exchange_legacy_sparse_nnz = nnz;
    state.exchange_legacy_sparse_device_bytes = exchange_device_bytes;
    record_host_to_device(
        audit,
        static_cast<uint64_t>(row_offsets_bytes + col_indices_bytes + values_bytes) +
            static_cast<uint64_t>(mass_bytes) * 2ull);
    return true;
#else
    (void)audit;
    error = "FemGpuState exchange CSR upload requires CUDA runtime support";
    return false;
#endif
}

bool gpu_state_initialize(
    FemGpuState &state,
    uint64_t node_count,
    fullmag_fem_integrator integrator,
    bool allocate_device,
    bool allocate_demag_workspace,
    const double *initial_magnetization_xyz,
    uint64_t initial_magnetization_len,
    TransferAudit &audit,
    std::string &error)
{
    gpu_state_destroy(state);
    if (node_count > std::numeric_limits<uint64_t>::max() / 3ull) {
        error = "FemGpuState node count is too large for vector DOF metadata";
        return false;
    }
    state.initialized = true;
    state.node_count = node_count;
    state.dof_len = node_count * 3ull;
    state.stage_count = gpu_state_stage_count(integrator);
    state.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.host_state = FemGpuSyncState::HostClean;
    state.device_state = FemGpuSyncState::HostStale;
    state.fsal_valid = false;

    if (!allocate_device || node_count == 0) {
        return true;
    }
    if (initial_magnetization_xyz == nullptr || initial_magnetization_len != state.dof_len) {
        error = "FemGpuState initial magnetization is missing or has invalid length";
        gpu_state_destroy(state);
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    uint64_t device_bytes = 0;
    if (!allocate_component(state.m, node_count, device_bytes, error) ||
        !allocate_component(state.h_ex, node_count, device_bytes, error) ||
        !allocate_component(state.h_demag, node_count, device_bytes, error) ||
        !allocate_component(state.h_ext, node_count, device_bytes, error) ||
        !allocate_component(state.h_ani, node_count, device_bytes, error) ||
        !allocate_component(state.h_cubic_ani, node_count, device_bytes, error) ||
        !allocate_component(state.h_dmi, node_count, device_bytes, error) ||
        !allocate_component(state.h_bulk_dmi, node_count, device_bytes, error) ||
        !allocate_component(state.h_oe, node_count, device_bytes, error) ||
        !allocate_component(state.h_therm, node_count, device_bytes, error) ||
        !allocate_component(state.h_mel, node_count, device_bytes, error) ||
        !allocate_component(state.h_eff, node_count, device_bytes, error) ||
        !allocate_component(state.m_backup, node_count, device_bytes, error) ||
        !allocate_component(state.m_stage, node_count, device_bytes, error) ||
        !allocate_component(state.error, node_count, device_bytes, error) ||
        !allocate_component(state.zhang_li_rhs, node_count, device_bytes, error)) {
        gpu_state_destroy(state);
        return false;
    }

    for (uint32_t stage = 0; stage < state.stage_count; ++stage) {
        if (!allocate_component(state.k[stage], node_count, device_bytes, error)) {
            gpu_state_destroy(state);
            return false;
        }
    }

    const uint64_t reduce_blocks = (node_count + kCudaBlockSize - 1ull) / kCudaBlockSize;
    if (node_count > std::numeric_limits<uint64_t>::max() / 6ull) {
        error = "FemGpuState node count is too large for magnetoelastic strain allocation";
        gpu_state_destroy(state);
        return false;
    }
    const uint64_t mel_strain_values = node_count * 6ull;
    if (!allocate_double(state.scalar_reduce_workspace, reduce_blocks, device_bytes, error) ||
        !allocate_double(state.scalar_reduce_result, 1, device_bytes, error) ||
        !allocate_double(state.zhang_li_node_weight, node_count, device_bytes, error) ||
        !allocate_double(state.node_volumes, node_count, device_bytes, error) ||
        !allocate_double(state.ms, node_count, device_bytes, error) ||
        !allocate_double(state.a, node_count, device_bytes, error) ||
        !allocate_double(state.alpha, node_count, device_bytes, error) ||
        !allocate_double(state.ku, node_count, device_bytes, error) ||
        !allocate_double(state.ku2, node_count, device_bytes, error) ||
        !allocate_double(state.dind, node_count, device_bytes, error) ||
        !allocate_double(state.dbulk, node_count, device_bytes, error) ||
        !allocate_double(state.kc1, node_count, device_bytes, error) ||
        !allocate_double(state.kc2, node_count, device_bytes, error) ||
        !allocate_double(state.kc3, node_count, device_bytes, error) ||
        !allocate_double(state.mel_strain_voigt, mel_strain_values, device_bytes, error) ||
        !allocate_u8(state.magnetic_node_mask, node_count, device_bytes, error) ||
        !allocate_u32(state.periodic_reduced_node, node_count, device_bytes, error) ||
        !allocate_u32(state.periodic_representative_nodes, node_count, device_bytes, error)) {
        gpu_state_destroy(state);
        return false;
    }

    if (allocate_demag_workspace &&
        (!allocate_double(state.poisson_rhs, node_count, device_bytes, error) ||
            !allocate_double(state.poisson_solution, node_count, device_bytes, error) ||
            !allocate_component(state.poisson_gradient, node_count, device_bytes, error))) {
        gpu_state_destroy(state);
        return false;
    }

    size_t reduce_temp_storage_bytes = 0;
    if (reduce_blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "FemGpuState reduction block count is too large for CUB device max";
        gpu_state_destroy(state);
        return false;
    }
    fullmag_cuda_device_max(
        state.scalar_reduce_workspace,
        static_cast<int>(reduce_blocks),
        state.scalar_reduce_result,
        nullptr,
        reduce_temp_storage_bytes,
        nullptr);
    size_t reduce_sum_temp_storage_bytes = 0;
    fullmag_cuda_device_sum(
        state.scalar_reduce_workspace,
        static_cast<int>(reduce_blocks),
        state.scalar_reduce_result,
        nullptr,
        reduce_sum_temp_storage_bytes,
        nullptr);
    reduce_temp_storage_bytes =
        std::max(reduce_temp_storage_bytes, reduce_sum_temp_storage_bytes);
    if (reduce_temp_storage_bytes > 0 &&
        !allocate_bytes(
            &state.scalar_reduce_temp_storage,
            reduce_temp_storage_bytes,
            device_bytes,
            error)) {
        gpu_state_destroy(state);
        return false;
    }

    state.allocated = true;
    state.device_bytes = device_bytes;
    state.scalar_reduce_temp_storage_bytes =
        static_cast<uint64_t>(reduce_temp_storage_bytes);
    state.reduction_workspace_bytes =
        (reduce_blocks + 1ull) * sizeof(double) +
        state.scalar_reduce_temp_storage_bytes;

    if (!gpu_state_upload_magnetization_aos(
            state,
            initial_magnetization_xyz,
            initial_magnetization_len,
            audit,
            error)) {
        gpu_state_destroy(state);
        return false;
    }
    return true;
#else
    (void)audit;
    error = "FemGpuState device allocation requested but fullmag_fem was built without CUDA runtime support";
    gpu_state_destroy(state);
    return false;
#endif
}

void gpu_state_destroy(FemGpuState &state)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    free_component(state.m);
    free_component(state.h_ex);
    free_component(state.h_demag);
    free_component(state.h_ext);
    free_component(state.h_ani);
    free_component(state.h_cubic_ani);
    free_component(state.h_dmi);
    free_component(state.h_bulk_dmi);
    free_component(state.h_oe);
    free_component(state.h_therm);
    free_component(state.h_mel);
    free_component(state.h_eff);
    free_component(state.m_backup);
    free_component(state.m_stage);
    free_component(state.error);
    free_component(state.zhang_li_rhs);
    for (auto &stage : state.k) {
        free_component(stage);
    }
    free_double(state.scalar_reduce_workspace);
    free_double(state.scalar_reduce_result);
    free_double(state.zhang_li_node_weight);
    free_bytes(state.scalar_reduce_temp_storage);
    free_double(state.node_volumes);
    free_double(state.ms);
    free_double(state.a);
    free_double(state.alpha);
    free_double(state.ku);
    free_double(state.ku2);
    free_double(state.dind);
    free_double(state.dbulk);
    free_double(state.kc1);
    free_double(state.kc2);
    free_double(state.kc3);
    free_double(state.mel_strain_voigt);
    free_u8(state.magnetic_node_mask);
    free_u32(state.periodic_reduced_node);
    free_u32(state.periodic_representative_nodes);
    free_double(state.nodes_xyz);
    free_u32(state.elements);
    free_u8(state.magnetic_element_mask);
    free_double(state.poisson_rhs);
    free_double(state.poisson_solution);
    free_component(state.poisson_gradient);
    reset_exchange_legacy_sparse(state);
#endif
    reset_metadata(state);
}

fullmag_fem_gpu_state_info gpu_state_info(const FemGpuState &state)
{
    fullmag_fem_gpu_state_info info{};
    info.allocated = state.allocated ? 1 : 0;
    info.node_count = state.node_count;
    info.dof_len = state.dof_len;
    info.stage_count = state.stage_count;
    info.device_bytes = state.device_bytes;
    info.reduction_workspace_bytes = state.reduction_workspace_bytes;
    info.source_of_truth = state.source_of_truth;
    return info;
}

fullmag_fem_gpu_state_info gpu_state_info(const Context &ctx)
{
    return gpu_state_info(ctx.gpu_state.device);
}

} // namespace fullmag::fem
