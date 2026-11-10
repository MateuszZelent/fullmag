#include "gpu/cuda/reductions/object_average.hpp"
#include "context.hpp"
#include "gpu/cuda/reductions/object_average_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/state/device_memory.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace fullmag::fem {

void gpu_object_average_free(GpuObjectAverageState &state)
{
    for (auto &entry : state.entries) {
        gpu_device_free_bytes(entry.device_records);
        entry.valid = false;
        std::vector<GpuObjectAverageRecord>().swap(entry.records);
        entry.last_use = 0;
        entry.node_count = 0;
        entry.device_capacity = 0;
    }
    gpu_device_free_bytes(state.device_chunk);
    gpu_device_free_double(state.result);
    std::vector<GpuObjectAverageRecord>().swap(state.preparation);
    std::vector<GpuObjectAverageRecord>().swap(state.chunk);
    std::vector<uint32_t>().swap(state.membership);
    state.preparation_limit = state.chunk_limit = 0;
    state.device_bytes = 0;
    state.sequence = state.cache_hits = state.cache_misses = 0;
    state.allocated = false;
}

bool gpu_object_average_allocate(
    GpuObjectAverageState &state, uint64_t node_count,
    uint64_t &device_bytes, uint64_t &reduction_workspace_bytes, std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    try {
        state.preparation_limit = static_cast<size_t>(std::min<uint64_t>(node_count, kObjectAverageRecordLimit));
        state.chunk_limit = static_cast<size_t>(std::min<uint64_t>(
            std::max<uint64_t>(node_count, 256), kObjectAverageChunkRecords));
        state.preparation.reserve(state.preparation_limit);
        state.chunk.reserve(state.chunk_limit);
        state.membership.reserve(static_cast<size_t>(std::min<uint64_t>(node_count, kObjectAverageMembershipLimit)));
        // Small scratch is setup-owned. Ownership-cache payloads are prepared
        // on demand outside solver hot loops, rather than allocating four
        // maximum-size caches for every GPU context.
        if (!gpu_device_allocate_bytes(&state.device_chunk,
                state.chunk_limit * sizeof(GpuObjectAverageRecord), state.device_bytes, error) ||
            !gpu_device_allocate_double(state.result, 8, state.device_bytes, error)) {
            gpu_object_average_free(state);
            return false;
        }
        device_bytes += state.device_bytes;
        reduction_workspace_bytes += state.device_bytes;
        state.allocated = true;
        return true;
    } catch (const std::exception &exception) {
        gpu_object_average_free(state);
        error = std::string("GPU object average setup failed: ") + exception.what();
        return false;
    }
#else
    (void)state; (void)node_count; (void)device_bytes; (void)reduction_workspace_bytes;
    error = "GPU object average setup requires CUDA runtime support";
    return false;
#endif
}

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {
bool cuda_ok(cudaError_t status, const char *operation, std::string &error)
{
    if (status == cudaSuccess) { return true; }
    error = std::string(operation) + " failed: " + cudaGetErrorString(status);
    return false;
}


bool same_records(const std::vector<GpuObjectAverageRecord> &a,
                  const std::vector<GpuObjectAverageRecord> &b, bool compare_weights = true)
{
    if (a.size() != b.size()) { return false; }
    for (size_t i = 0; i < a.size(); ++i) {
        if (a[i].count != b[i].count || !std::equal(std::begin(a[i].nodes), std::end(a[i].nodes), std::begin(b[i].nodes)) || (compare_weights && a[i].weight != b[i].weight)) {
            return false;
        }
    }
    return true;
}

bool reduce_records(Context &ctx, const void *records, size_t count,
                    bool dg0, cudaStream_t stream, std::string &error)
{
    if (count == 0) { return true; }
    auto &gpu = ctx.gpu_state.device;
    auto &state = gpu.reductions.object_average;
    const int blocks = static_cast<int>(std::min<uint64_t>(
        (count + 255) / 256, (gpu.lifecycle.node_count + 255) / 256));
    for (int component = 0; component < 4; ++component) {
        gpu_object_average_component_blocks(
            static_cast<const GpuObjectAverageRecord *>(records), count,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            dg0, component, gpu.reductions.scalar_workspace, blocks, stream);
        if (!cuda_ok(cudaPeekAtLastError(), "GPU object average block reduction", error)) { return false; }
        size_t temporary_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        fullmag_cuda_device_sum(gpu.reductions.scalar_workspace, blocks,
            state.result + 4 + component, gpu.reductions.temp_storage, temporary_bytes, stream);
        if (!cuda_ok(cudaPeekAtLastError(), "GPU object average CUB reduction", error)) { return false; }
    }
    gpu_object_average_accumulate_chunk(state.result, stream);
    return cuda_ok(cudaPeekAtLastError(), "GPU object average chunk accumulation", error);
}
} // namespace
#endif

int gpu_object_average(Context &ctx, const uint32_t *indices, uint64_t count,
                       bool element_set, double *out_xyz, std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    try {
        auto &gpu = ctx.gpu_state.device;
        const auto &runtime = ctx.material_fields.runtime;
        const bool dg0 = runtime.has_value() && runtime->has_elementwise_ms();
        const char *prefix = element_set
            ? "fullmag_fem_backend_average_m_for_elements_f64"
            : "fullmag_fem_backend_average_m_for_nodes_f64";
        if (element_set && !dg0) {
            error = std::string(prefix) + " requires element-DG0 Ms";
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        const size_t nodes = ctx.state.m_xyz.size() / 3;
        if (!gpu.lifecycle.allocated || gpu.lifecycle.node_count != nodes || nodes == 0 ||
            gpu.magnetization.m.x == nullptr || gpu.magnetization.m.y == nullptr ||
            gpu.magnetization.m.z == nullptr || gpu.residency.device_state == FemGpuSyncState::HostStale) {
            error = std::string(prefix) + " requires current device-resident magnetization";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const auto &volume = !ctx.integration_weights.mfem_lumped_mass.empty()
            ? ctx.integration_weights.mfem_lumped_mass : ctx.mesh.node_volumes;
        if (!dg0 && volume.size() != nodes) {
            error = std::string(prefix) + " requires nodal integration weights";
            return FULLMAG_FEM_ERR_INVALID;
        }
        if (!dg0 && !ctx.material_fields.Ms_field.empty() && ctx.material_fields.Ms_field.size() != nodes) {
            error = std::string(prefix) + " has an invalid nodal Ms extent";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const size_t available = element_set ? runtime->realization().element_count() : nodes;
        for (uint64_t i = 0; i < count; ++i) {
            if (indices[i] >= available) {
                error = std::string(prefix) + (element_set ? " received element index out of range" : " received node index out of range");
                return FULLMAG_FEM_ERR_INVALID;
            }
        }
        if (dg0 && runtime->realization().node_count() != nodes) {
            error = std::string(prefix) + " has an invalid material node extent";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        if (count == 0) { out_xyz[0] = out_xyz[1] = out_xyz[2] = 0.0; return FULLMAG_FEM_OK; }
        auto &state = gpu.reductions.object_average;
        if (!state.allocated) {
            error = std::string(prefix) + " requires setup-owned object reduction scratch";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        // Membership scratch is bounded. Oversized selections retain exact
        // semantics with linear lookup: worst-case preparation is
        // O(active_elements * selected_indices). This is a capacity fallback,
        // not a throughput qualification for extremely large DG0 selections.
        state.membership.clear();
        const bool sorted_membership = dg0 && count <= state.membership.capacity();
        if (sorted_membership && count > 0) {
            state.membership.assign(indices, indices + static_cast<size_t>(count));
            std::sort(state.membership.begin(), state.membership.end());
        }
        auto member = [&](uint64_t index) {
            if (count == 0 || index > std::numeric_limits<uint32_t>::max()) { return false; }
            return sorted_membership
                ? std::binary_search(state.membership.begin(), state.membership.end(), index)
                : std::find(indices, indices + count, index) != indices + count;
        };
        auto each_record = [&](auto emit) {
            if (!dg0) {
                for (uint64_t i = 0; i < count; ++i) {
                    const auto node = indices[i];
                    const double ms = ctx.material_fields.Ms_field.empty()
                        ? ctx.material_fields.material.saturation_magnetisation : ctx.material_fields.Ms_field[node];
                    const double weight = ms * volume[node];
                    if (!std::isfinite(weight) || weight <= 0.0) { continue; }
                    GpuObjectAverageRecord record{};
                    record.nodes[0] = node;
                    record.count = 1;
                    record.weight = weight;
                    if (!emit(record)) { return false; }
                }
            } else {
                const auto &realization = runtime->realization();
                for (size_t element : realization.active_element_ordinals()) {
                    const auto &topology = realization.element_topology(element);
                    bool included = element_set ? member(element) : true;
                    if (!element_set) {
                        for (auto node : topology.node_ids) { included = included && member(node); }
                    }
                    if (!included) { continue; }
                    GpuObjectAverageRecord record{};
                    record.count = 4;
                    record.weight = realization.ms_a_per_m(element) * topology.volume_m3;
                    for (int local = 0; local < 4; ++local) { record.nodes[local] = static_cast<uint32_t>(topology.node_ids[local]); }
                    if (!emit(record)) { return false; }
                }
            }
            return true;
        };
        state.preparation.clear();
        uint64_t record_count = 0;
        each_record([&](const auto &record) {
            if (record_count < state.preparation_limit) { state.preparation.push_back(record); }
            ++record_count;
            return true;
        });
        if (record_count == 0) { out_xyz[0] = out_xyz[1] = out_xyz[2] = 0.0; return FULLMAG_FEM_OK; }
        if (gpu.reductions.scalar_workspace == nullptr || gpu.reductions.temp_storage == nullptr) {
            error = std::string(prefix) + " requires prepared device reduction workspace";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const auto stream = static_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
        struct PendingWorkFence {
            cudaStream_t stream;
            GpuObjectAverageState &state;
            bool complete = false;
            ~PendingWorkFence()
            {
                if (!complete) {
                    cudaStreamSynchronize(stream);
                    for (auto &entry : state.entries) { entry.valid = false; }
                }
            }
        } pending{stream, state};
        if (!cuda_ok(cudaMemsetAsync(state.result, 0, 4 * sizeof(double), stream), "GPU object average clear totals", error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        // A hot-loop miss uses prepared streaming scratch; no ownership-cache
        // vector or CUDA allocation is permitted there.
        auto hit = state.entries.end();
        if (record_count <= state.preparation_limit) {
            hit = std::find_if(state.entries.begin(), state.entries.end(), [&](const auto &entry) {
                return entry.valid && entry.dg0 == dg0 && entry.node_count == nodes && same_records(entry.records, state.preparation);
            });
        }
        const bool can_prepare_cache = ctx.transfer_audit.audit.hot_loop_depth == 0 &&
            record_count <= state.preparation_limit;
        if (hit != state.entries.end() || can_prepare_cache) {
            if (hit == state.entries.end()) {
                state.cache_misses += 1;
                hit = std::find_if(state.entries.begin(), state.entries.end(), [&](const auto &entry) {
                    return entry.node_count == nodes && entry.dg0 == dg0 &&
                        same_records(entry.records, state.preparation, false);
                });
                if (hit == state.entries.end()) {
                    hit = std::min_element(state.entries.begin(), state.entries.end(),
                        [](const auto &a, const auto &b) { return a.last_use < b.last_use; });
                }
                hit->valid = false;
                hit->records = state.preparation;
                if (hit->device_capacity < record_count) {
                    const uint64_t previous_bytes = hit->device_capacity * sizeof(GpuObjectAverageRecord);
                    gpu_device_free_bytes(hit->device_records);
                    state.device_bytes -= previous_bytes;
                    gpu.lifecycle.device_bytes -= previous_bytes;
                    gpu.lifecycle.reduction_workspace_bytes -= previous_bytes;
                    hit->device_capacity = 0;
                    uint64_t added_bytes = 0;
                    if (!gpu_device_allocate_bytes(&hit->device_records,
                            record_count * sizeof(GpuObjectAverageRecord), added_bytes, error)) {
                        return FULLMAG_FEM_ERR_INTERNAL;
                    }
                    hit->device_capacity = static_cast<size_t>(record_count);
                    state.device_bytes += added_bytes;
                    gpu.lifecycle.device_bytes += added_bytes;
                    gpu.lifecycle.reduction_workspace_bytes += added_bytes;
                }
                hit->dg0 = dg0;
                hit->node_count = nodes;
                const size_t bytes = record_count * sizeof(GpuObjectAverageRecord);
                if (!cuda_ok(cudaMemcpyAsync(hit->device_records, hit->records.data(), bytes,
                        cudaMemcpyHostToDevice, stream), "GPU object average ownership upload", error)) { return FULLMAG_FEM_ERR_INTERNAL; }
                record_host_to_device(ctx.transfer_audit.audit, bytes);
                hit->valid = true;
            } else { state.cache_hits += 1; }
            hit->last_use = ++state.sequence;
            if (!reduce_records(ctx, hit->device_records, record_count, dg0, stream, error)) { return FULLMAG_FEM_ERR_INTERNAL; }
        } else {
            // Oversized sets and hot-loop cache misses use the same GPU
            // reduction in prepared chunks, without growing ownership caches.
            state.chunk.clear();
            auto flush = [&] {
                const size_t bytes = state.chunk.size() * sizeof(GpuObjectAverageRecord);
                if (!cuda_ok(cudaMemcpyAsync(state.device_chunk, state.chunk.data(), bytes,
                        cudaMemcpyHostToDevice, stream), "GPU object average chunk upload", error)) { return false; }
                record_host_to_device(ctx.transfer_audit.audit, bytes);
                if (!reduce_records(ctx, state.device_chunk, state.chunk.size(), dg0, stream, error)) { return false; }
                // Pageable host staging cannot be reused until its copy has
                // completed. No field is transferred back to the host.
                if (!cuda_ok(cudaStreamSynchronize(stream), "GPU object average chunk staging fence", error)) { return false; }
                state.chunk.clear();
                return true;
            };
            if (!each_record([&](const auto &record) {
                    state.chunk.push_back(record);
                    return state.chunk.size() < state.chunk_limit || flush();
                }) || (!state.chunk.empty() && !flush())) { return FULLMAG_FEM_ERR_INTERNAL; }
        }
        std::array<double, 4> result{};
        if (!cuda_ok(cudaMemcpyAsync(result.data(), state.result, sizeof(result), cudaMemcpyDeviceToHost, stream),
                "GPU object average scalar readback", error) ||
            !cuda_ok(cudaStreamSynchronize(stream), "GPU object average scalar fence", error)) { return FULLMAG_FEM_ERR_INTERNAL; }
        pending.complete = true;
        record_device_control_scalar_to_host(ctx.transfer_audit.audit, sizeof(result));
        if (dg0 && std::isnan(result[3])) {
            error = std::string(prefix) + " element-Ms reduction failed: AOS-3 nodal values contain NaN/Inf";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const double inverse = std::isfinite(result[3]) && result[3] > 0.0 ? 1.0 / result[3] : 0.0;
        for (int component = 0; component < 3; ++component) {
            out_xyz[component] = inverse == 0.0 ? 0.0 : result[component] * inverse;
        }
        return FULLMAG_FEM_OK;
    } catch (const std::exception &exception) {
        error = std::string("GPU object average failed: ") + exception.what();
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    (void)ctx; (void)indices; (void)count; (void)element_set; (void)out_xyz;
    error = "GPU object average requires CUDA runtime support";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}
} // namespace fullmag::fem
