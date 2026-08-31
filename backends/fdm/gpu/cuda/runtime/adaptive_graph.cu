#include "context.hpp"
#include "adaptive_controller.cuh"

#include <cuda_runtime.h>

#include <cmath>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

namespace {

static cudaError_t add_graph_node_compat(
    cudaGraphNode_t *graph_node,
    cudaGraph_t graph,
    const cudaGraphNode_t *dependencies,
    size_t dependency_count,
    cudaGraphNodeParams *params)
{
#if CUDART_VERSION >= 13000
    return cudaGraphAddNode(
        graph_node, graph, dependencies, nullptr, dependency_count, params);
#else
    return cudaGraphAddNode(
        graph_node, graph, dependencies, dependency_count, params);
#endif
}

__global__ void reset_adaptive_loop_condition_kernel(
    cudaGraphConditionalHandle loop_handle,
    AdaptiveDeviceControl *control,
    AdaptiveDeviceBatchState *batch)
{
    if (control == nullptr || batch == nullptr || batch->failed != 0 ||
        batch->accepted_count >= batch->max_steps ||
        !(batch->current_time < batch->target_time)) {
        if (batch != nullptr) batch->active_step = 0;
        cudaGraphSetConditional(loop_handle, 0U);
        return;
    }
    const double remaining = batch->target_time - batch->current_time;
    if (!(remaining > 0.0) || !isfinite(remaining) ||
        !(control->dt_candidate > 0.0) || !isfinite(control->dt_candidate)) {
        batch->failed = 1;
        batch->terminal_reason = ADAPTIVE_DEVICE_REASON_INVALID_TIMESTEP;
        batch->active_step = 0;
        cudaGraphSetConditional(loop_handle, 0U);
        return;
    }
    const double endpoint_scale = fmax(
        fabs(control->dt_candidate), fabs(remaining));
    const bool same_endpoint_within_roundoff =
        fabs(remaining - control->dt_candidate) <=
            endpoint_scale * ADAPTIVE_DT_MIN_ULP_FACTOR;
    if (!same_endpoint_within_roundoff) {
        control->dt_candidate = fmin(control->dt_candidate, remaining);
    }
    control->error = 0.0;
    control->ratio = 1.0;
    control->dt_attempt = 0.0;
    control->decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    control->reason = ADAPTIVE_DEVICE_REASON_ERROR_ABOVE_TOLERANCE;
    control->attempt_index = 0;
    control->next_rejected_attempts = 0;
    batch->active_step = 1;
    cudaGraphSetConditional(loop_handle, 1U);
}

__global__ void finalize_adaptive_accepted_step_kernel(
    AdaptiveDeviceControl *control,
    AdaptiveDeviceBatchState *batch,
    AdaptiveDeviceControl *accepted_steps)
{
    if (control == nullptr || batch == nullptr || accepted_steps == nullptr ||
        batch->active_step == 0) {
        return;
    }
    batch->active_step = 0;
    if (control->decision != ADAPTIVE_DEVICE_DECISION_ACCEPTED) {
        if (batch->accepted_count < batch->max_steps &&
            batch->accepted_count < ADAPTIVE_ACCEPTED_BATCH_CAPACITY) {
            accepted_steps[batch->accepted_count] = *control;
        }
        batch->failed = 1;
        batch->terminal_reason = control->reason;
        return;
    }
    const uint32_t index = batch->accepted_count;
    if (index >= batch->max_steps ||
        index >= ADAPTIVE_ACCEPTED_BATCH_CAPACITY) {
        batch->failed = 1;
        batch->terminal_reason = ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED;
        return;
    }
    accepted_steps[index] = *control;
    batch->current_time += control->dt_attempt;
    batch->accepted_count = index + 1;
}

bool graph_ok(Context &ctx, const char *operation, cudaError_t error) {
    if (error == cudaSuccess) return true;
    set_cuda_error(ctx, operation, error);
    return false;
}

} // namespace

void context_destroy_adaptive_step_graph(Context &ctx) {
    if (ctx.adaptive_step_graph_exec != nullptr) {
        cudaGraphExecDestroy(ctx.adaptive_step_graph_exec);
        ctx.adaptive_step_graph_exec = nullptr;
    }
    if (ctx.adaptive_step_graph != nullptr) {
        cudaGraphDestroy(ctx.adaptive_step_graph);
        ctx.adaptive_step_graph = nullptr;
    }
    if (ctx.adaptive_graph_capture_stream != nullptr) {
        cudaStreamDestroy(ctx.adaptive_graph_capture_stream);
        ctx.adaptive_graph_capture_stream = nullptr;
    }
    ctx.adaptive_graph_capture_active = false;
    ctx.adaptive_step_graph_body = nullptr;
    ctx.adaptive_loop_handle = {};
    ctx.adaptive_graph_integrator = 0;
    ctx.adaptive_graph_precision = 0;
    ctx.adaptive_graph_source_revision = 0;
    ctx.adaptive_graph_field_revision = 0;
    ctx.adaptive_graph_transport_revision = 0;
    ctx.adaptive_graph_projection_policy_identity = 0;
    ctx.adaptive_graph_build_is_recapture = false;
    context_clear_local_pipeline_graph_template(ctx);
}

bool context_begin_adaptive_step_graph_build(
    Context &ctx,
    cudaGraph_t &conditional_body)
{
    const bool is_recapture = ctx.adaptive_step_graph_exec != nullptr;
    context_destroy_adaptive_step_graph(ctx);
    ctx.adaptive_graph_build_is_recapture = is_recapture;
    if (!graph_ok(
            ctx,
            "cudaGraphCreate(adaptive_step)",
            cudaGraphCreate(&ctx.adaptive_step_graph, 0))) {
        return false;
    }
    if (!graph_ok(
            ctx,
            "cudaGraphConditionalHandleCreate(adaptive_step)",
            cudaGraphConditionalHandleCreate(
                &ctx.adaptive_loop_handle,
                ctx.adaptive_step_graph,
                0,
                0))) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }

    cudaKernelNodeParams reset_params{};
    void *reset_arguments[] = {
        &ctx.adaptive_loop_handle,
        &ctx.adaptive_policy_scratch,
        &ctx.adaptive_batch_state};
    reset_params.func = reinterpret_cast<void *>(
        reset_adaptive_loop_condition_kernel);
    reset_params.gridDim = dim3(1, 1, 1);
    reset_params.blockDim = dim3(1, 1, 1);
    reset_params.kernelParams = reset_arguments;
    cudaGraphNode_t reset_node = nullptr;
    if (!graph_ok(
            ctx,
            "cudaGraphAddKernelNode(adaptive_loop_reset)",
            cudaGraphAddKernelNode(
                &reset_node,
                ctx.adaptive_step_graph,
                nullptr,
                0,
                &reset_params))) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }

    cudaGraphNodeParams conditional_params{};
    conditional_params.type = cudaGraphNodeTypeConditional;
    conditional_params.conditional.handle = ctx.adaptive_loop_handle;
    conditional_params.conditional.type = cudaGraphCondTypeWhile;
    conditional_params.conditional.size = 1;
    cudaGraphNode_t conditional_node = nullptr;
    if (!graph_ok(
            ctx,
            "cudaGraphAddNode(adaptive_while)",
            add_graph_node_compat(
                &conditional_node,
                ctx.adaptive_step_graph,
                &reset_node,
                1,
                &conditional_params))) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    ctx.adaptive_step_graph_body =
        conditional_params.conditional.phGraph_out[0];
    conditional_body = ctx.adaptive_step_graph_body;
    cudaKernelNodeParams finalize_params{};
    void *finalize_arguments[] = {
        &ctx.adaptive_policy_scratch,
        &ctx.adaptive_batch_state,
        &ctx.adaptive_accepted_batch};
    finalize_params.func = reinterpret_cast<void *>(
        finalize_adaptive_accepted_step_kernel);
    finalize_params.gridDim = dim3(1, 1, 1);
    finalize_params.blockDim = dim3(1, 1, 1);
    finalize_params.kernelParams = finalize_arguments;
    cudaGraphNode_t finalize_node = nullptr;
    if (!graph_ok(
            ctx,
            "cudaGraphAddKernelNode(adaptive_step_finalize)",
            cudaGraphAddKernelNode(
                &finalize_node,
                ctx.adaptive_step_graph,
                &conditional_node,
                1,
                &finalize_params))) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    if (!graph_ok(
            ctx,
            "cudaStreamCreateWithFlags(adaptive_graph_capture)",
            cudaStreamCreateWithFlags(
                &ctx.adaptive_graph_capture_stream,
                cudaStreamNonBlocking))) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    return true;
}

bool context_adaptive_step_graph_key_matches(
    const Context &ctx,
    uint32_t integrator,
    uint32_t precision)
{
    return ctx.adaptive_step_graph_exec != nullptr &&
        ctx.adaptive_graph_integrator == integrator &&
        ctx.adaptive_graph_precision == precision &&
        ctx.adaptive_graph_source_revision == ctx.rhs_source_revision &&
        ctx.adaptive_graph_field_revision == ctx.rhs_field_revision &&
        ctx.adaptive_graph_transport_revision == ctx.rhs_transport_revision &&
        ctx.adaptive_graph_projection_policy_identity ==
            ctx.projection_policy_identity;
}

bool context_adaptive_step_graph_configuration_supported(Context &ctx) {
    if (ctx.temperature > 0.0) {
        ctx.last_error = "adaptive_device_loop_thermal_unsupported";
        return false;
    }
    if (ctx.has_oersted_field && ctx.oersted_time_dep_kind != 0) {
        ctx.last_error = "adaptive_device_loop_dynamic_oersted_unsupported";
        return false;
    }
    if (ctx.gpu_transport_rhs.active) {
        ctx.last_error = "adaptive_device_loop_gpu_transport_unsupported";
        return false;
    }
    if (ctx.gpu_transport_test_force_adaptive_retry) {
        ctx.last_error = "adaptive_device_loop_host_fault_injection_unsupported";
        return false;
    }
    return true;
}

bool context_begin_adaptive_step_graph_body_capture(
    Context &ctx,
    cudaStream_t &capture_stream)
{
    cudaGraph_t conditional_body = nullptr;
    if (!context_begin_adaptive_step_graph_build(ctx, conditional_body)) {
        return false;
    }
    capture_stream = ctx.adaptive_graph_capture_stream;
    const cudaError_t error = cudaStreamBeginCaptureToGraph(
        capture_stream,
        conditional_body,
        nullptr,
        nullptr,
        0,
        cudaStreamCaptureModeRelaxed);
    if (!graph_ok(
            ctx,
            "cudaStreamBeginCaptureToGraph(adaptive_step)",
            error)) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    context_begin_local_pipeline_graph_capture(ctx);
    ctx.adaptive_graph_capture_active = true;
    return true;
}

bool context_finish_adaptive_step_graph_body_capture(
    Context &ctx,
    cudaStream_t capture_stream,
    bool body_enqueued,
    uint32_t integrator,
    uint32_t precision)
{
    const cudaError_t error = cudaStreamEndCapture(capture_stream, nullptr);
    ctx.adaptive_graph_capture_active = false;
    if (error != cudaSuccess || !body_enqueued) {
        if (error != cudaSuccess) {
            set_cuda_error(ctx, "cudaStreamEndCapture(adaptive_step)", error);
        } else if (ctx.last_error.empty()) {
            ctx.last_error = "adaptive_step_graph_body_capture_failed";
        }
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    if (!context_finish_local_pipeline_graph_capture(ctx)) {
        if (ctx.last_error.empty()) {
            ctx.last_error = "adaptive_step_graph_local_pipeline_accounting_failed";
        }
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    if (!context_finish_adaptive_step_graph_build(ctx)) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    ctx.adaptive_graph_integrator = integrator;
    ctx.adaptive_graph_precision = precision;
    ctx.adaptive_graph_source_revision = ctx.rhs_source_revision;
    ctx.adaptive_graph_field_revision = ctx.rhs_field_revision;
    ctx.adaptive_graph_transport_revision = ctx.rhs_transport_revision;
    ctx.adaptive_graph_projection_policy_identity =
        ctx.projection_policy_identity;
    return true;
}

const char *adaptive_device_terminal_reason(uint32_t reason) {
    switch (reason) {
        case ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED:
            return "dt_min_exhausted";
        case ADAPTIVE_DEVICE_REASON_INVALID_TIMESTEP:
            return "invalid_timestep";
        case ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR:
            return "invalid_current_error";
        case ADAPTIVE_DEVICE_REASON_INVALID_PREVIOUS_ERROR:
            return "invalid_previous_error";
        case ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED:
            return "retry_limit_exhausted";
        default:
            return "invalid_adaptive_device_loop_terminal_reason";
    }
}

bool context_attach_adaptive_step_graph_body(
    Context &ctx,
    cudaGraph_t captured_body)
{
    if (ctx.adaptive_step_graph_body == nullptr || captured_body == nullptr) {
        ctx.last_error = "adaptive_step_graph_body_unavailable";
        return false;
    }
    cudaGraphNode_t child_node = nullptr;
    return graph_ok(
        ctx,
        "cudaGraphAddChildGraphNode(adaptive_attempt)",
        cudaGraphAddChildGraphNode(
            &child_node,
            ctx.adaptive_step_graph_body,
            nullptr,
            0,
            captured_body));
}

bool context_finish_adaptive_step_graph_build(Context &ctx) {
    if (ctx.adaptive_step_graph == nullptr) {
        ctx.last_error = "adaptive_step_graph_unavailable";
        return false;
    }
    if (!graph_ok(
            ctx,
            "cudaGraphInstantiate(adaptive_step)",
            cudaGraphInstantiate(
                &ctx.adaptive_step_graph_exec,
                ctx.adaptive_step_graph,
                0))) {
        context_destroy_adaptive_step_graph(ctx);
        return false;
    }
    context_record_adaptive_execution_counter(
        ctx, ctx.adaptive_graph_build_count);
    if (ctx.adaptive_graph_build_is_recapture) {
        context_record_adaptive_execution_counter(
            ctx, ctx.adaptive_graph_recapture_count);
    }
    context_commit_local_pipeline_graph_template(ctx);
    ctx.adaptive_graph_build_is_recapture = false;
    return true;
}

bool context_launch_adaptive_step_graph(
    Context &ctx,
    const AdaptiveDeviceControl &initial_control,
    AdaptiveDeviceControl &terminal_control)
{
    uint32_t accepted_step_count = 0;
    if (!context_launch_adaptive_step_graph_batch(
            ctx,
            initial_control,
            ctx.current_time,
            ctx.current_time + initial_control.dt_candidate,
            1,
            &terminal_control,
            1,
            accepted_step_count)) {
        return false;
    }
    if (accepted_step_count == 0 &&
        terminal_control.decision == ADAPTIVE_DEVICE_DECISION_FAILED) {
        return true;
    }
    if (accepted_step_count != 1) {
        ctx.last_error = "adaptive_step_graph_single_step_not_accepted";
        return false;
    }
    return true;
}

bool context_launch_adaptive_step_graph_batch(
    Context &ctx,
    const AdaptiveDeviceControl &initial_control,
    double current_time,
    double target_time,
    uint32_t max_steps,
    AdaptiveDeviceControl *accepted_steps,
    uint32_t accepted_steps_capacity,
    uint32_t &accepted_step_count)
{
    accepted_step_count = 0;
    if (ctx.adaptive_step_graph_exec == nullptr ||
        ctx.adaptive_policy_scratch == nullptr ||
        ctx.adaptive_batch_state == nullptr ||
        ctx.adaptive_accepted_batch == nullptr) {
        ctx.last_error = "adaptive_step_graph_not_ready";
        return false;
    }
    if (accepted_steps == nullptr || max_steps == 0 ||
        max_steps > ADAPTIVE_ACCEPTED_BATCH_CAPACITY ||
        accepted_steps_capacity < max_steps || !isfinite(current_time) ||
        !isfinite(target_time) || !(target_time > current_time)) {
        ctx.last_error = "adaptive_step_graph_batch_invalid";
        return false;
    }
    AdaptiveDeviceBatchState initial_batch{};
    initial_batch.current_time = current_time;
    initial_batch.target_time = target_time;
    initial_batch.max_steps = max_steps;
    cudaError_t error = cudaMemcpyAsync(
        ctx.adaptive_policy_scratch,
        &initial_control,
        sizeof(initial_control),
        cudaMemcpyHostToDevice,
        nullptr);
    if (!graph_ok(ctx, "cudaMemcpyAsync(adaptive_control H2D)", error)) {
        return false;
    }
    error = cudaMemcpyAsync(
        ctx.adaptive_batch_state,
        &initial_batch,
        sizeof(initial_batch),
        cudaMemcpyHostToDevice,
        nullptr);
    if (!graph_ok(ctx, "cudaMemcpyAsync(adaptive_batch H2D)", error)) {
        return false;
    }
    const bool has_snapshot = ctx.m.x != nullptr && ctx.m.y != nullptr &&
        ctx.m.z != nullptr && ctx.tmp.x != nullptr && ctx.tmp.y != nullptr &&
        ctx.tmp.z != nullptr && ctx.cell_count != 0;
    const size_t snapshot_bytes = static_cast<size_t>(ctx.cell_count) *
        (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? sizeof(double) : sizeof(float));
    for (uint32_t step = 0; step < max_steps; ++step) {
        if (has_snapshot) {
            error = cudaMemcpyAsync(
                ctx.tmp.x, ctx.m.x, snapshot_bytes,
                cudaMemcpyDeviceToDevice, nullptr);
            if (error == cudaSuccess) {
                error = cudaMemcpyAsync(
                    ctx.tmp.y, ctx.m.y, snapshot_bytes,
                    cudaMemcpyDeviceToDevice, nullptr);
            }
            if (error == cudaSuccess) {
                error = cudaMemcpyAsync(
                    ctx.tmp.z, ctx.m.z, snapshot_bytes,
                    cudaMemcpyDeviceToDevice, nullptr);
            }
            if (!graph_ok(
                    ctx,
                    "cudaMemcpyAsync(adaptive_batch_snapshot)",
                    error)) {
                return false;
            }
        }
        error = cudaGraphLaunch(ctx.adaptive_step_graph_exec, nullptr);
        if (!graph_ok(ctx, "cudaGraphLaunch(adaptive_step)", error)) {
            return false;
        }
        context_record_adaptive_execution_counter(
            ctx, ctx.adaptive_graph_launch_count);
    }
    AdaptiveDeviceBatchState terminal_batch{};
    error = cudaMemcpyAsync(
        &terminal_batch,
        ctx.adaptive_batch_state,
        sizeof(terminal_batch),
        cudaMemcpyDeviceToHost,
        nullptr);
    if (!graph_ok(ctx, "cudaMemcpyAsync(adaptive_batch_state D2H)", error)) {
        return false;
    }
    error = cudaMemcpyAsync(
        accepted_steps,
        ctx.adaptive_accepted_batch,
        max_steps * sizeof(AdaptiveDeviceControl),
        cudaMemcpyDeviceToHost,
        nullptr);
    if (!graph_ok(ctx, "cudaMemcpyAsync(adaptive_batch_records D2H)", error)) {
        return false;
    }
    error = cudaStreamSynchronize(nullptr);
    if (!graph_ok(ctx, "cudaStreamSynchronize(adaptive_step)", error)) {
        return false;
    }
    context_record_adaptive_execution_counter(
        ctx,
        ctx.adaptive_terminal_control_d2h_bytes,
        sizeof(terminal_batch) +
            max_steps * sizeof(AdaptiveDeviceControl));
    context_record_adaptive_execution_counter(
        ctx, ctx.adaptive_terminal_control_host_sync_count);
    if (ctx.stats_mode != FULLMAG_FDM_STATS_FULL) {
        context_record_adaptive_execution_counter(
            ctx, ctx.adaptive_stats_none_host_sync_count);
    }
    uint64_t graph_attempt_executions = 0;
    const uint64_t record_count =
        static_cast<uint64_t>(terminal_batch.accepted_count) +
        (terminal_batch.failed != 0 ? UINT64_C(1) : UINT64_C(0));
    if (record_count <= max_steps && record_count <= accepted_steps_capacity) {
        for (uint64_t index = 0; index < record_count; ++index) {
            const uint64_t attempts =
                static_cast<uint64_t>(accepted_steps[index].attempt_index) + 1;
            if (graph_attempt_executions > UINT64_MAX - attempts) {
                ctx.local_pipeline_accounting_valid = false;
                graph_attempt_executions = 0;
                break;
            }
            graph_attempt_executions += attempts;
        }
    } else {
        ctx.local_pipeline_accounting_valid = false;
    }
    if (graph_attempt_executions != 0) {
        context_record_local_pipeline_graph_attempts(
            ctx, graph_attempt_executions);
    }
    accepted_step_count = terminal_batch.accepted_count;
    if (terminal_batch.failed != 0) {
        ctx.last_error = adaptive_device_terminal_reason(
            terminal_batch.terminal_reason);
    }
    if (accepted_step_count > max_steps ||
        (accepted_step_count == 0 && terminal_batch.failed == 0)) {
        ctx.last_error = "adaptive_step_graph_batch_empty_or_overflow";
        return false;
    }
    return true;
}

} // namespace fdm
} // namespace fullmag
