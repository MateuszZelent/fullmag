#include "../gpu/cuda/runtime/adaptive_controller.cuh"

#include <cuda_runtime.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>

namespace {

using fullmag::fdm::ADAPTIVE_DEVICE_DECISION_ACCEPTED;
using fullmag::fdm::ADAPTIVE_DEVICE_DECISION_FAILED;
using fullmag::fdm::ADAPTIVE_DEVICE_DECISION_RETRY;
using fullmag::fdm::ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED;
using fullmag::fdm::ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR;
using fullmag::fdm::ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED;
using fullmag::fdm::AdaptiveDeviceControl;
using fullmag::fdm::evaluate_adaptive_error_policy_loop_device;

struct DeviceAllocation {
    void *value = nullptr;

    ~DeviceAllocation() {
        if (value != nullptr) cudaFree(value);
    }
};

bool cuda_ok(cudaError_t status, const char *operation) {
    if (status == cudaSuccess) return true;
    std::cerr << operation << ": " << cudaGetErrorString(status) << '\n';
    return false;
}

__global__ void initialize_controller_kernel(
    AdaptiveDeviceControl *control,
    double initial_dt,
    cudaGraphConditionalHandle loop_handle)
{
    *control = AdaptiveDeviceControl{};
    control->dt_candidate = initial_dt;
    control->decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    cudaGraphSetConditional(loop_handle, 1U);
}

__global__ void evaluate_attempt_kernel(
    const double *error_sq_by_attempt,
    uint32_t error_count,
    AdaptiveDeviceControl *control,
    fullmag_fdm_adaptive_attempt_v1 *trace,
    double dt_min,
    double dt_max,
    cudaGraphConditionalHandle loop_handle)
{
    const uint32_t attempt = control->next_rejected_attempts;
    const double error_sq = attempt < error_count
        ? error_sq_by_attempt[attempt]
        : CUDART_INF;
    evaluate_adaptive_error_policy_loop_device(
        error_sq,
        control,
        trace,
        dt_min,
        dt_max,
        0.8,
        2.0,
        0.2,
        1.0 / 3.0,
        2,
        1,
        0,
        loop_handle);
}

bool add_kernel_node(
    cudaGraphNode_t *node,
    cudaGraph_t graph,
    const cudaGraphNode_t *dependencies,
    size_t dependency_count,
    void *function,
    void **arguments)
{
    cudaKernelNodeParams params{};
    params.func = function;
    params.gridDim = dim3(1, 1, 1);
    params.blockDim = dim3(1, 1, 1);
    params.kernelParams = arguments;
    return cuda_ok(
        cudaGraphAddKernelNode(
            node, graph, dependencies, dependency_count, &params),
        "cudaGraphAddKernelNode");
}

bool run_case(
    const std::vector<double> &errors_sq,
    double initial_dt,
    double dt_min,
    uint32_t expected_decision,
    uint32_t expected_reason,
    uint32_t expected_attempt_count)
{
    DeviceAllocation errors_device;
    DeviceAllocation control_device;
    DeviceAllocation trace_device;
    if (!cuda_ok(cudaMalloc(&errors_device.value,
                            errors_sq.size() * sizeof(double)),
                 "cudaMalloc(errors)") ||
        !cuda_ok(cudaMalloc(&control_device.value,
                            sizeof(AdaptiveDeviceControl)),
                 "cudaMalloc(control)") ||
        !cuda_ok(cudaMalloc(&trace_device.value,
                            FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1 *
                                sizeof(fullmag_fdm_adaptive_attempt_v1)),
                 "cudaMalloc(trace)")) {
        return false;
    }
    if (!cuda_ok(cudaMemcpy(errors_device.value,
                            errors_sq.data(),
                            errors_sq.size() * sizeof(double),
                            cudaMemcpyHostToDevice),
                 "cudaMemcpy(errors H2D)")) {
        return false;
    }

    cudaGraph_t graph = nullptr;
    cudaGraphExec_t executable = nullptr;
    bool passed = cuda_ok(cudaGraphCreate(&graph, 0), "cudaGraphCreate");
    cudaGraphConditionalHandle loop_handle{};
    passed = passed && cuda_ok(
        cudaGraphConditionalHandleCreate(&loop_handle, graph, 0, 0),
        "cudaGraphConditionalHandleCreate");

    auto *control = static_cast<AdaptiveDeviceControl *>(control_device.value);
    auto *trace = static_cast<fullmag_fdm_adaptive_attempt_v1 *>(trace_device.value);
    cudaGraphNode_t initialize_node = nullptr;
    void *initialize_arguments[] = {&control, &initial_dt, &loop_handle};
    passed = passed && add_kernel_node(
        &initialize_node,
        graph,
        nullptr,
        0,
        reinterpret_cast<void *>(initialize_controller_kernel),
        initialize_arguments);

    cudaGraph_t *body_graphs = nullptr;
    cudaGraphNodeParams conditional_params{};
    conditional_params.type = cudaGraphNodeTypeConditional;
    conditional_params.conditional.handle = loop_handle;
    conditional_params.conditional.type = cudaGraphCondTypeWhile;
    conditional_params.conditional.size = 1;
    conditional_params.conditional.phGraph_out = body_graphs;
    cudaGraphNode_t conditional_node = nullptr;
    passed = passed && cuda_ok(
        cudaGraphAddNode(
            &conditional_node,
            graph,
            &initialize_node,
            1,
            &conditional_params),
        "cudaGraphAddNode(while)");
    body_graphs = conditional_params.conditional.phGraph_out;
    if (body_graphs == nullptr) {
        std::cerr << "conditional body graph was not created\n";
        passed = false;
    }

    const auto error_count = static_cast<uint32_t>(errors_sq.size());
    const double dt_max = 1.0e-9;
    auto *errors = static_cast<const double *>(errors_device.value);
    cudaGraphNode_t attempt_node = nullptr;
    void *attempt_arguments[] = {
        &errors,
        const_cast<uint32_t *>(&error_count),
        &control,
        &trace,
        &dt_min,
        const_cast<double *>(&dt_max),
        &loop_handle,
    };
    if (body_graphs != nullptr) {
        passed = passed && add_kernel_node(
            &attempt_node,
            body_graphs[0],
            nullptr,
            0,
            reinterpret_cast<void *>(evaluate_attempt_kernel),
            attempt_arguments);
    }
    passed = passed && cuda_ok(
        cudaGraphInstantiate(&executable, graph, 0),
        "cudaGraphInstantiate");
    passed = passed && cuda_ok(
        cudaGraphLaunch(executable, nullptr),
        "cudaGraphLaunch");
    passed = passed && cuda_ok(
        cudaStreamSynchronize(nullptr),
        "cudaStreamSynchronize(after complete adaptive graph)");

    AdaptiveDeviceControl observed{};
    std::array<fullmag_fdm_adaptive_attempt_v1,
               FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1> trace_batch{};
    if (passed) {
        passed = cuda_ok(
            cudaMemcpy(&observed,
                       control_device.value,
                       sizeof(observed),
                       cudaMemcpyDeviceToHost),
            "cudaMemcpy(one terminal control package D2H)");
    }
    if (passed) {
        passed = cuda_ok(
            cudaMemcpy(trace_batch.data(),
                       trace_device.value,
                       expected_attempt_count *
                           sizeof(fullmag_fdm_adaptive_attempt_v1),
                       cudaMemcpyDeviceToHost),
            "cudaMemcpy(one batched attempt trace D2H)");
    }

    if (executable != nullptr) cudaGraphExecDestroy(executable);
    if (graph != nullptr) cudaGraphDestroy(graph);

    if (!passed) return false;
    if (observed.decision != expected_decision ||
        observed.reason != expected_reason ||
        observed.attempt_index + 1 != expected_attempt_count) {
        std::cerr << "unexpected terminal control: decision="
                  << observed.decision << " reason=" << observed.reason
                  << " attempts=" << observed.attempt_index + 1 << '\n';
        return false;
    }
    for (uint32_t index = 0; index < expected_attempt_count; ++index) {
        if (trace_batch[index].attempt_index != index ||
            trace_batch[index].abi_version !=
                FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1) {
            std::cerr << "invalid trace record at attempt " << index << '\n';
            return false;
        }
    }
    return true;
}

} // namespace

int main() {
    bool passed = true;
    passed = run_case(
        {4.0, 0.25},
        1.0e-12,
        1.0e-18,
        ADAPTIVE_DEVICE_DECISION_ACCEPTED,
        fullmag::fdm::ADAPTIVE_DEVICE_REASON_WITHIN_TOLERANCE,
        2) && passed;
    passed = run_case(
        {std::numeric_limits<double>::quiet_NaN()},
        1.0e-12,
        1.0e-18,
        ADAPTIVE_DEVICE_DECISION_FAILED,
        ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR,
        1) && passed;
    passed = run_case(
        {4.0},
        1.0e-12,
        1.0e-12,
        ADAPTIVE_DEVICE_DECISION_FAILED,
        ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED,
        1) && passed;
    passed = run_case(
        std::vector<double>(FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1, 4.0),
        1.0e-12,
        1.0e-300,
        ADAPTIVE_DEVICE_DECISION_FAILED,
        ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED,
        FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1) && passed;
    if (!passed) return 1;
    std::cout << "FDM_ADAPTIVE_CONDITIONAL_GRAPH_PASS\n";
    return 0;
}
