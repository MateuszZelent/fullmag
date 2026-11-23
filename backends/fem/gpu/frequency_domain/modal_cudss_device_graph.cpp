#include "gpu/frequency_domain/modal_cudss_device_graph.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain::gpu {
namespace {

struct GraphDefinition {
    cudaGraph_t graph = nullptr;
    ~GraphDefinition() { if (graph) cudaGraphDestroy(graph); }
};

struct GraphExecution {
    cudaGraphExec_t graph = nullptr;
    ~GraphExecution() { if (graph) cudaGraphExecDestroy(graph); }
};

struct DeviceAllocation {
    void *data = nullptr;
    ~DeviceAllocation() { if (data) cudaFree(data); }
};

bool local_device_pointer(const void *address, int device)
{
    cudaPointerAttributes attributes{};
    return address && cudaPointerGetAttributes(&attributes, address) == cudaSuccess &&
        attributes.type == cudaMemoryTypeDevice && attributes.device == device;
}

bool host_pointer(const void *address)
{
    cudaPointerAttributes attributes{};
    return address && cudaPointerGetAttributes(&attributes, address) == cudaSuccess &&
        (attributes.type == cudaMemoryTypeHost || attributes.type == cudaMemoryTypeUnregistered);
}

bool disjoint(const void *first, std::size_t first_bytes, const void *second, std::size_t second_bytes)
{
    const auto a = reinterpret_cast<std::uintptr_t>(first);
    const auto b = reinterpret_cast<std::uintptr_t>(second);
    return a <= b ? first_bytes <= b - a : second_bytes <= a - b;
}

constexpr std::size_t control_limit = 64;

struct CopyProbe {
    cudaGraphNode_t original_node = nullptr;
    void *destination = nullptr;
    std::size_t bytes = 0;
    std::size_t offset = 0;
};

bool graph_control_copies(cudaGraph_t graph, int device, const double2 *rhs, const double2 *solution,
                          std::size_t block_bytes, std::vector<CopyProbe> &copies, std::size_t &total)
{
    std::size_t count = 0;
    if (cudaGraphGetNodes(graph, nullptr, &count) != cudaSuccess || count == 0) {
        return false;
    }
    std::vector<cudaGraphNode_t> nodes(count);
    if (cudaGraphGetNodes(graph, nodes.data(), &count) != cudaSuccess || count != nodes.size()) {
        return false;
    }
    bool observed_kernel = false;
    for (const auto node : nodes) {
        cudaGraphNodeType type{};
        if (cudaGraphNodeGetType(node, &type) != cudaSuccess) {
            return false;
        }
        switch (type) {
        case cudaGraphNodeTypeKernel:
            observed_kernel = true;
            break;
        case cudaGraphNodeTypeEmpty:
            break;
        case cudaGraphNodeTypeMemset: {
            cudaMemsetParams params{};
            if (cudaGraphMemsetNodeGetParams(node, &params) != cudaSuccess ||
                !local_device_pointer(params.dst, device)) {
                return false;
            }
            break;
        }
        case cudaGraphNodeTypeMemcpy: {
            cudaMemcpy3DParms params{};
            if (cudaGraphMemcpyNodeGetParams(node, &params) != cudaSuccess ||
                params.srcArray || params.dstArray || !local_device_pointer(params.dstPtr.ptr, device)) {
                return false;
            }
            if (local_device_pointer(params.srcPtr.ptr, device)) {
                if (params.kind != cudaMemcpyDeviceToDevice && params.kind != cudaMemcpyDefault) {
                    return false;
                }
                break;
            }
            const auto bytes = params.extent.width;
            if (!host_pointer(params.srcPtr.ptr) ||
                (params.kind != cudaMemcpyHostToDevice && params.kind != cudaMemcpyDefault) ||
                params.extent.height != 1 || params.extent.depth != 1 ||
                params.srcPos.x || params.srcPos.y || params.srcPos.z ||
                params.dstPos.x || params.dstPos.y || params.dstPos.z ||
                bytes == 0 || bytes > control_limit - total ||
                !disjoint(params.dstPtr.ptr, bytes, rhs, block_bytes) ||
                !disjoint(params.dstPtr.ptr, bytes, solution, block_bytes)) {
                return false;
            }
            copies.push_back({node, params.dstPtr.ptr, bytes, total});
            total += bytes;
            break;
        }
        default:
            // A prepared solve can use only its existing device workspace. In
            // particular, the graph must have no host callbacks or allocations.
            return false;
        }
    }
    return observed_kernel;
}

bool attach_device_probe(cudaGraph_t graph, const CopyProbe &copy, std::byte *device_probe)
{
    std::size_t count = 0;
    if (cudaGraphNodeGetDependentNodes(copy.original_node, nullptr, &count) != cudaSuccess) {
        return false;
    }
    std::vector<cudaGraphNode_t> consumers(count);
    if (count != 0 &&
        (cudaGraphNodeGetDependentNodes(copy.original_node, consumers.data(), &count) != cudaSuccess ||
         count != consumers.size())) {
        return false;
    }
    cudaGraphNode_t node = nullptr;
    if (cudaGraphAddMemcpyNode1D(&node, graph, &copy.original_node, 1,
                                  device_probe + copy.offset, copy.destination, copy.bytes,
                                  cudaMemcpyDeviceToDevice) != cudaSuccess) {
        return false;
    }
    // Sample the value actually seen by CUDA. The pageable host address
    // returned in a capture is not itself a reliable source of those bytes.
    const std::vector<cudaGraphNode_t> predecessors(count, node);
    return count == 0 ||
        cudaGraphAddDependencies(graph, predecessors.data(), consumers.data(), count) == cudaSuccess;
}

constexpr std::size_t compare_chunk = 4096;

bool setup_rhs(double2 *rhs, std::size_t elements, unsigned seed, cudaStream_t stream)
{
    std::array<double2, compare_chunk> values{};
    for (std::size_t offset = 0; offset < elements; offset += values.size()) {
        const auto length = std::min(values.size(), elements - offset);
        for (std::size_t i = 0; i < length; ++i) {
            const auto entry = offset + i;
            values[i] = {
                (static_cast<double>((entry + 23 * seed) % 97) - 48.0) / 32.0,
                (static_cast<double>((entry + 17 * seed) % 113) - 56.0) / 64.0,
            };
        }
        if (cudaMemcpyAsync(rhs + offset, values.data(), length * sizeof(double2), cudaMemcpyHostToDevice,
                            stream) != cudaSuccess || cudaStreamSynchronize(stream) != cudaSuccess) {
            return false;
        }
    }
    return true;
}

bool setup_solutions_agree(const double2 *reference, const double2 *solution, std::size_t elements)
{
    // This setup-only comparison bounds host memory even for large blocks.
    std::array<double2, compare_chunk> a{}, b{};
    long double norm = 0.0, difference = 0.0;
    for (std::size_t offset = 0; offset < elements; offset += a.size()) {
        const auto length = std::min(a.size(), elements - offset);
        const auto bytes = length * sizeof(double2);
        if (cudaMemcpy(a.data(), reference + offset, bytes, cudaMemcpyDeviceToHost) != cudaSuccess ||
            cudaMemcpy(b.data(), solution + offset, bytes, cudaMemcpyDeviceToHost) != cudaSuccess) {
            return false;
        }
        for (std::size_t i = 0; i < length; ++i) {
            const long double ax = a[i].x, ay = a[i].y;
            const long double dx = ax - b[i].x, dy = ay - b[i].y;
            norm += ax * ax + ay * ay;
            difference += dx * dx + dy * dy;
        }
    }
    constexpr long double tolerance_squared = 1.0e-20L;
    return std::isfinite(difference) && std::isfinite(norm) && norm > 0.0L &&
        difference <= tolerance_squared * norm;
}

} // namespace

struct CudssDeviceGraph::State {
    std::size_t node_count = 0;
    // Release executable references before their constant memory.
    DeviceAllocation replay_control;
    GraphExecution execution;
};

CudssDeviceGraph::CudssDeviceGraph() : state_(std::make_unique<State>()) {}
CudssDeviceGraph::~CudssDeviceGraph() = default;

std::unique_ptr<CudssDeviceGraph> CudssDeviceGraph::prepare(
    cudaStream_t stream, double2 *rhs, const double2 *solution, std::size_t elements,
    const std::function<bool()> &enqueue_vendor_solve, const char **failure)
{
    if (!failure) {
        return nullptr;
    }
    const auto fail = [&](const char *message) -> std::unique_ptr<CudssDeviceGraph> {
        *failure = message;
        return nullptr;
    };
    *failure = nullptr;
    int device = -1;
    if (!stream || !rhs || !solution || elements == 0 ||
        elements > std::numeric_limits<std::size_t>::max() / sizeof(double2) ||
        cudaGetDevice(&device) != cudaSuccess) {
        return fail("cudss_replay_invalid_setup");
    }
    const auto block_bytes = elements * sizeof(double2);
    GraphDefinition original;
    if (cudaStreamBeginCapture(stream, cudaStreamCaptureModeThreadLocal) != cudaSuccess) {
        return fail("cudss_replay_capture_begin_failed");
    }
    const bool submitted = enqueue_vendor_solve();
    const auto capture_status = cudaStreamEndCapture(stream, &original.graph);
    if (!submitted || capture_status != cudaSuccess || !original.graph) {
        return fail("cudss_replay_capture_failed");
    }

    std::vector<CopyProbe> copies;
    std::size_t control_bytes = 0;
    if (!graph_control_copies(original.graph, device, rhs, solution, block_bytes, copies, control_bytes)) {
        return fail("cudss_replay_graph_contains_unqualified_nodes");
    }
    auto result = std::unique_ptr<CudssDeviceGraph>(new CudssDeviceGraph);
    if (cudaGraphGetNodes(original.graph, nullptr, &result->state_->node_count) != cudaSuccess ||
        result->state_->node_count == 0) {
        return fail("cudss_replay_graph_identity_missing");
    }
    if (copies.empty()) {
        if (cudaGraphInstantiate(&result->state_->execution.graph, original.graph, 0) != cudaSuccess) {
            return fail("cudss_replay_instantiation_failed");
        }
        return result;
    }

    GraphDefinition qualified;
    DeviceAllocation probe, reference_solution;
    GraphExecution original_with_probes;
    auto &device_control = result->state_->replay_control.data;
    if (cudaGraphClone(&qualified.graph, original.graph) != cudaSuccess ||
        cudaMalloc(&probe.data, control_bytes) != cudaSuccess ||
        cudaMalloc(&device_control, control_bytes) != cudaSuccess ||
        cudaMalloc(&reference_solution.data, block_bytes) != cudaSuccess) {
        return fail("cudss_replay_probe_setup_failed");
    }
    for (const auto &copy : copies) {
        if (!attach_device_probe(original.graph, copy, static_cast<std::byte *>(probe.data))) {
            return fail("cudss_replay_probe_dependencies_failed");
        }
    }
    std::array<std::byte, control_limit> observed{};
    if (cudaGraphInstantiate(&original_with_probes.graph, original.graph, 0) != cudaSuccess ||
        !setup_rhs(rhs, elements, 0, stream) ||
        cudaGraphLaunch(original_with_probes.graph, stream) != cudaSuccess ||
        cudaStreamSynchronize(stream) != cudaSuccess ||
        cudaMemcpy(observed.data(), probe.data, control_bytes, cudaMemcpyDeviceToHost) != cudaSuccess ||
        cudaMemcpy(device_control, observed.data(), control_bytes, cudaMemcpyHostToDevice) != cudaSuccess) {
        return fail("cudss_replay_probe_failed");
    }
    for (const auto &copy : copies) {
        cudaGraphNode_t candidate_node = nullptr;
        if (cudaGraphNodeFindInClone(&candidate_node, copy.original_node, qualified.graph) != cudaSuccess ||
            cudaGraphMemcpyNodeSetParams1D(candidate_node, copy.destination,
                static_cast<std::byte *>(device_control) + copy.offset, copy.bytes,
                cudaMemcpyDeviceToDevice) != cudaSuccess) {
            return fail("cudss_replay_rewrite_failed");
        }
    }
    std::vector<CopyProbe> remaining_copies;
    std::size_t remaining_control_bytes = 0;
    if (!graph_control_copies(qualified.graph, device, rhs, solution, block_bytes,
                              remaining_copies, remaining_control_bytes) || !remaining_copies.empty() ||
        remaining_control_bytes != 0 ||
        cudaGraphInstantiate(&result->state_->execution.graph, qualified.graph, 0) != cudaSuccess) {
        return fail("cudss_replay_device_graph_audit_failed");
    }
    // Compare the complete block for varied nonzero inputs before accepting
    // the rewritten graph. Vendor state and both graph executables are local.
    for (const unsigned seed : {1u, 2u}) {
        std::array<std::byte, control_limit> check{};
        if (!setup_rhs(rhs, elements, seed, stream) ||
            cudaGraphLaunch(original_with_probes.graph, stream) != cudaSuccess ||
            cudaMemcpyAsync(reference_solution.data, solution, block_bytes, cudaMemcpyDeviceToDevice,
                            stream) != cudaSuccess ||
            cudaMemcpyAsync(check.data(), probe.data, control_bytes, cudaMemcpyDeviceToHost, stream) != cudaSuccess ||
            !result->launch(stream) || cudaStreamSynchronize(stream) != cudaSuccess ||
            check != observed ||
            !setup_solutions_agree(static_cast<const double2 *>(reference_solution.data), solution, elements)) {
            return fail("cudss_replay_setup_comparison_failed");
        }
    }
    if (cudaMemsetAsync(rhs, 0, block_bytes, stream) != cudaSuccess || cudaStreamSynchronize(stream) != cudaSuccess) {
        return fail("cudss_replay_restore_rhs_failed");
    }
    return result;
}

bool CudssDeviceGraph::close() noexcept
{
    auto &execution = state_->execution.graph;
    auto &control = state_->replay_control.data;
    if (execution) {
        if (cudaGraphExecDestroy(execution) != cudaSuccess) {
            return false;
        }
        execution = nullptr;
    }
    if (control) {
        if (cudaFree(control) != cudaSuccess) {
            return false;
        }
        control = nullptr;
    }
    return true;
}

std::size_t CudssDeviceGraph::node_count() const noexcept { return state_->node_count; }

bool CudssDeviceGraph::launch(cudaStream_t stream) const noexcept
{
    return state_->execution.graph && cudaGraphLaunch(state_->execution.graph, stream) == cudaSuccess;
}

} // namespace fullmag::fem::frequency_domain::gpu
