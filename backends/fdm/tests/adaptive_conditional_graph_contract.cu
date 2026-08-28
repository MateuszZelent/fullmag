#include "../gpu/cuda/runtime/adaptive_controller.cuh"
#include "fullmag_adaptive_step_decision.hpp"

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
using fullmag::fdm::AdaptiveDeviceBatchState;
using fullmag::fdm::Context;
using fullmag::fdm::context_attach_adaptive_step_graph_body;
using fullmag::fdm::context_begin_adaptive_step_graph_build;
using fullmag::fdm::context_destroy_adaptive_step_graph;
using fullmag::fdm::context_finish_adaptive_step_graph_build;
using fullmag::fdm::context_launch_adaptive_step_graph;
using fullmag::fdm::context_launch_adaptive_step_graph_batch;
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
    uint32_t expected_attempt_count,
    uint32_t expected_first_decision = std::numeric_limits<uint32_t>::max(),
    uint32_t expected_first_reason = std::numeric_limits<uint32_t>::max(),
    double expected_first_error = std::numeric_limits<double>::quiet_NaN())
{
    DeviceAllocation errors_device;
    DeviceAllocation control_device;
    DeviceAllocation batch_state_device;
    DeviceAllocation accepted_batch_device;
    DeviceAllocation trace_device;
    if (!cuda_ok(cudaMalloc(&errors_device.value,
                            errors_sq.size() * sizeof(double)),
                 "cudaMalloc(errors)") ||
        !cuda_ok(cudaMalloc(&control_device.value,
                            sizeof(AdaptiveDeviceControl)),
                 "cudaMalloc(control)") ||
        !cuda_ok(cudaMalloc(&batch_state_device.value,
                            sizeof(AdaptiveDeviceBatchState)),
                 "cudaMalloc(batch state)") ||
        !cuda_ok(cudaMalloc(&accepted_batch_device.value,
                            fullmag::fdm::ADAPTIVE_ACCEPTED_BATCH_CAPACITY *
                                sizeof(AdaptiveDeviceControl)),
                 "cudaMalloc(accepted batch)") ||
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

    Context ctx{};
    auto *control = static_cast<AdaptiveDeviceControl *>(control_device.value);
    auto *trace = static_cast<fullmag_fdm_adaptive_attempt_v1 *>(trace_device.value);
    ctx.adaptive_policy_scratch = control;
    ctx.adaptive_batch_state = static_cast<AdaptiveDeviceBatchState *>(
        batch_state_device.value);
    ctx.adaptive_accepted_batch = static_cast<AdaptiveDeviceControl *>(
        accepted_batch_device.value);
    ctx.adaptive_attempt_trace_device = trace;
    cudaGraph_t conditional_body = nullptr;
    bool passed = context_begin_adaptive_step_graph_build(
        ctx, conditional_body);
    if (!passed) std::cerr << ctx.last_error << '\n';

    const auto error_count = static_cast<uint32_t>(errors_sq.size());
    const double dt_max = 1.0e-9;
    auto *errors = static_cast<const double *>(errors_device.value);
    cudaGraph_t captured_body = nullptr;
    passed = passed && cuda_ok(
        cudaGraphCreate(&captured_body, 0),
        "cudaGraphCreate(captured attempt body)");
    cudaGraphNode_t attempt_node = nullptr;
    void *attempt_arguments[] = {
        &errors,
        const_cast<uint32_t *>(&error_count),
        &control,
        &trace,
        &dt_min,
        const_cast<double *>(&dt_max),
        &ctx.adaptive_loop_handle,
    };
    if (captured_body != nullptr) {
        passed = passed && add_kernel_node(
            &attempt_node,
            captured_body,
            nullptr,
            0,
            reinterpret_cast<void *>(evaluate_attempt_kernel),
            attempt_arguments);
    }
    passed = passed && context_attach_adaptive_step_graph_body(
        ctx, captured_body);
    if (captured_body != nullptr) cudaGraphDestroy(captured_body);
    passed = passed && context_finish_adaptive_step_graph_build(ctx);

    AdaptiveDeviceControl initial{};
    initial.dt_candidate = initial_dt;
    initial.decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    AdaptiveDeviceControl observed{};
    AdaptiveDeviceControl observed_replay{};
    uint32_t expected_graph_launches = 1;
    if (expected_decision == ADAPTIVE_DEVICE_DECISION_ACCEPTED) {
        std::array<AdaptiveDeviceControl, 2> accepted{};
        uint32_t accepted_count = 0;
        passed = passed && context_launch_adaptive_step_graph_batch(
            ctx,
            initial,
            0.0,
            1.0,
            2,
            accepted.data(),
            static_cast<uint32_t>(accepted.size()),
            accepted_count);
        passed = passed && accepted_count == 2;
        observed = accepted[0];
        observed_replay = accepted[1];
        expected_graph_launches = 2;
    } else {
        passed = passed && context_launch_adaptive_step_graph(
            ctx, initial, observed);
        observed_replay = observed;
    }
    std::array<fullmag_fdm_adaptive_attempt_v1,
               FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1> trace_batch{};
    if (passed) {
        passed = cuda_ok(
            cudaMemcpy(trace_batch.data(),
                       trace_device.value,
                       expected_attempt_count *
                           sizeof(fullmag_fdm_adaptive_attempt_v1),
                       cudaMemcpyDeviceToHost),
            "cudaMemcpy(one batched attempt trace D2H)");
    }
    passed = passed && ctx.adaptive_graph_build_count == 1 &&
        ctx.adaptive_graph_launch_count == expected_graph_launches &&
        ctx.adaptive_terminal_control_d2h_bytes ==
            sizeof(AdaptiveDeviceBatchState) +
                expected_graph_launches * sizeof(AdaptiveDeviceControl) &&
        ctx.adaptive_terminal_control_host_sync_count == 1;
    context_destroy_adaptive_step_graph(ctx);

    if (!passed) return false;
    if (observed.decision != expected_decision ||
        observed.reason != expected_reason ||
        observed.attempt_index + 1 != expected_attempt_count ||
        observed_replay.decision != expected_decision ||
        observed_replay.reason != expected_reason ||
        observed_replay.attempt_index + 1 != expected_attempt_count) {
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
    if (expected_first_decision != std::numeric_limits<uint32_t>::max() &&
        (trace_batch[0].decision != expected_first_decision ||
         trace_batch[0].reason != expected_first_reason ||
         !std::isfinite(trace_batch[0].normalized_error) ||
         std::abs(trace_batch[0].normalized_error - expected_first_error) >
             2.0e-15)) {
        std::cerr << "near-threshold CPU/device divergence: decision="
                  << trace_batch[0].decision << " reason="
                  << trace_batch[0].reason << " error="
                  << trace_batch[0].normalized_error << '\n';
        return false;
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
    const auto check_threshold = [&](double error) {
        const double error_sq = error * error;
        const double reduced_error = std::sqrt(error_sq);
        const auto cpu = fullmag::adaptive::decide_adaptive_step(
            {2, 1.0e-18, 1.0e-9, 0.8, 2.0, 0.2},
            {1.0e-12, reduced_error, 0.0, false});
        const bool accepted =
            cpu.kind == fullmag::adaptive::AdaptiveDecisionKind::accepted;
        const uint32_t first_decision = accepted
            ? ADAPTIVE_DEVICE_DECISION_ACCEPTED
            : ADAPTIVE_DEVICE_DECISION_RETRY;
        const uint32_t first_reason = accepted
            ? fullmag::fdm::ADAPTIVE_DEVICE_REASON_WITHIN_TOLERANCE
            : fullmag::fdm::ADAPTIVE_DEVICE_REASON_ERROR_ABOVE_TOLERANCE;
        const std::vector<double> device_errors = accepted
            ? std::vector<double>{error_sq}
            : std::vector<double>{error_sq, 0.25};
        return run_case(
            device_errors,
            1.0e-12,
            1.0e-18,
            ADAPTIVE_DEVICE_DECISION_ACCEPTED,
            fullmag::fdm::ADAPTIVE_DEVICE_REASON_WITHIN_TOLERANCE,
            accepted ? 1U : 2U,
            first_decision,
            first_reason,
            reduced_error);
    };
    passed = check_threshold(std::nextafter(1.0, 0.0)) && passed;
    passed = check_threshold(1.0) && passed;
    passed = check_threshold(std::nextafter(1.0, 2.0)) && passed;
    if (!passed) return 1;
    std::cout << "FDM_ADAPTIVE_CONDITIONAL_GRAPH_PASS\n";
    return 0;
}
