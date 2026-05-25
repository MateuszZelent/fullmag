/*
 * GPU CUDA runtime-coefficients upload source contract.
 *
 * Keeps runtime coefficient fallback expansion, periodic-map construction,
 * device upload, and readiness marking out of FemGpuState lifecycle code.
 */

#include "gpu/cuda/state/runtime_coefficients_upload.hpp"

#include <algorithm>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}
#endif

} // namespace

bool gpu_runtime_coefficients_upload(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuRuntimeCoefficientDeviceState &runtime_coefficients,
    FemGpuMaterialDeviceState &materials,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    FemGpuMeshRegionDeviceState &mesh_regions,
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
    if (!lifecycle.allocated) {
        return true;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    const size_t node_count = static_cast<size_t>(lifecycle.node_count);
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

    if (!cuda_ok(cudaMemcpy(mesh_metrics.node_volumes, node_volume_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState node_volumes host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.ms, ms_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ms host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.a, a_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState a host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.alpha, alpha_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState alpha host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.ku, ku_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ku host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.ku2, ku2_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ku2 host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.dind, dind_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState dind host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.dbulk, dbulk_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState dbulk host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.kc1, kc1_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc1 host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.kc2, kc2_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc2 host->device", error) ||
        !cuda_ok(cudaMemcpy(materials.kc3, kc3_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc3 host->device", error) ||
        !cuda_ok(cudaMemcpy(mesh_regions.magnetic_node_mask, magnetic_mask.data(), u8_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetic_node_mask host->device", error) ||
        !cuda_ok(cudaMemcpy(mesh_regions.periodic_reduced_node, reduced_node.data(), u32_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState periodic_reduced_node host->device", error) ||
        !cuda_ok(cudaMemcpy(mesh_regions.periodic_representative_nodes, representative_node.data(), u32_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState periodic_representative_nodes host->device", error)) {
        return false;
    }
    record_host_to_device(
        audit,
        static_cast<uint64_t>(double_bytes) * 11ull +
            static_cast<uint64_t>(u8_bytes) +
            static_cast<uint64_t>(u32_bytes) * 2ull);
    mesh_metrics.node_count = static_cast<uint64_t>(node_count);
    materials.node_count = static_cast<uint64_t>(node_count);
    mesh_regions.node_count = static_cast<uint64_t>(node_count);
    runtime_coefficients.uploaded = true;
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

} // namespace fullmag::fem
