/*
 * adaptive_error_reduction_contract.cpp - native FDM adaptive-step reduction contract.
 *
 * Adaptive RK23/DP45 kernels must not download the whole per-cell error buffer
 * to the host.  They may copy the final reduced scalar, but the max reduction
 * itself must stay on the device-side reduction path.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fdm_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string function_body(const std::string &source, const std::string &signature) {
    const std::size_t start = source.find(signature);
    check(start != std::string::npos, "expected function signature not found");

    const std::size_t body_start = source.find('{', start);
    check(body_start != std::string::npos, "expected function body not found");

    std::size_t depth = 0;
    for (std::size_t i = body_start; i < source.size(); ++i) {
        if (source[i] == '{') {
            ++depth;
        } else if (source[i] == '}') {
            --depth;
            if (depth == 0) {
                return source.substr(body_start, i - body_start + 1);
            }
        }
    }

    std::fprintf(stderr, "FAIL: unterminated function body for %s\n", signature.c_str());
    std::exit(1);
}

void adaptive_error_reductions_stay_device_side() {
    const std::filesystem::path root = fdm_source_root();
    const auto cuda = root / "gpu" / "cuda";
    const std::string reductions = read_text_file(cuda / "runtime" / "reductions_fp64.cu");
    const std::string controller = read_text_file(cuda / "runtime" / "adaptive_controller.cuh");
    const std::string dp45_fp64 = read_text_file(cuda / "integrators" / "llg_dp45_fp64.cu");
    const std::string dp45_fp32 = read_text_file(cuda / "integrators" / "llg_dp45_fp32.cu");
    const std::string rk23_fp64 = read_text_file(cuda / "integrators" / "llg_rk23_fp64.cu");
    const std::string rk23_fp32 = read_text_file(cuda / "integrators" / "llg_rk23_fp32.cu");

    check(
        reductions.find("double reduce_max_scalar_sqrt(") != std::string::npos,
        "FDM reductions module must expose a shared device-side scalar max-sqrt reduction");
    check(
        reductions.find("AdaptiveErrorPolicy reduce_adaptive_error_policy(") !=
            std::string::npos,
        "FDM reductions module must expose a shared device-side adaptive policy reduction");

    const std::string adaptive_sources = dp45_fp64 + dp45_fp32 + rk23_fp64 + rk23_fp32;
    check(
        adaptive_sources.find("std::vector<double> host_err") == std::string::npos,
        "adaptive RK23/DP45 steps must not allocate host_err for per-cell errors");
    check(
        adaptive_sources.find("host_err.data()") == std::string::npos,
        "adaptive RK23/DP45 steps must not download the whole error buffer to host_err");
    check(
        adaptive_sources.find("reduce_adaptive_error_policy(ctx, ctx.reduction_scratch") !=
            std::string::npos,
        "adaptive RK23/DP45 steps must call the shared device-side adaptive policy reduction");
    check(
        adaptive_sources.find("pow(ctx.adaptive_max_error / error") == std::string::npos,
        "adaptive RK23/DP45 steps must not compute dt policy with host-side pow()");

    for (const std::string *source : {&dp45_fp64, &dp45_fp32, &rk23_fp64, &rk23_fp32}) {
        check(
            source->find("const uint8_t * __restrict__ active_mask") != std::string::npos,
            "adaptive error kernels must receive the active-cell mask");
        check(
            source->find("const uint8_t * __restrict__ frozen_mask") != std::string::npos,
            "adaptive error kernels must receive the frozen-spin mask");
        check(
            source->find("has_active_mask && active_mask[idx] == 0") != std::string::npos,
            "adaptive error kernels must exclude inactive cells from the norm");
        check(
            source->find("has_frozen_mask && frozen_mask[idx] != 0") != std::string::npos,
            "adaptive error kernels must exclude frozen cells from the norm");
        check(
            source->find("ctx.active_mask, ctx.frozen_mask") != std::string::npos,
            "adaptive error launches must pass both canonical masks");
    }
    check(
        controller.find("const bool finite_max_sq = isfinite(max_error_sq)") !=
            std::string::npos,
        "device adaptive reduction must fail closed on non-finite max error");
    check(
        controller.find("ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR") !=
                std::string::npos &&
            reductions.find("adaptive_device_reason_id") != std::string::npos,
        "device adaptive reduction must publish a typed non-finite error reason");
    check(
        controller.find("ADAPTIVE_DT_MIN_ULP_FACTOR") != std::string::npos &&
            controller.find("fabs(dt - adaptive_dt_min)") != std::string::npos,
        "device adaptive policy must share the rounded dt_min exhaustion boundary");
}

void adaptive_error_scalar_reduction_uses_compute_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string reduction = function_body(
        read_text_file(root / "gpu" / "cuda" / "runtime" / "reductions_fp64.cu"),
        "double reduce_max_scalar_sqrt(Context &ctx, double *device_values, uint64_t n)");

    check(
        reduction.find("context_begin_compute_stream_work(ctx, \"reduce_max_scalar_sqrt\")") !=
            std::string::npos,
        "adaptive scalar error reduction must wait for default-stream error producers");
    check(
        reduction.find("cudaStream_t stream = context_compute_stream(ctx)") !=
            std::string::npos,
        "adaptive scalar error reduction must use the Context compute stream");
    check(
        reduction.find("reduce_max_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE, 0, stream>>>") !=
            std::string::npos,
        "adaptive scalar error reduction kernels must launch on the Context compute stream");
    check(
        reduction.find("cudaMemcpyAsync(&max_value, src, sizeof(double), cudaMemcpyDeviceToHost, stream)") !=
            std::string::npos,
        "adaptive scalar error reduction must asynchronously copy only the final scalar");
    check(
        reduction.find("cudaStreamSynchronize(stream)") != std::string::npos,
        "adaptive scalar error reduction must synchronize only the compute stream for the final scalar");
    check(
        reduction.find("context_end_compute_stream_work(ctx, \"reduce_max_scalar_sqrt\")") !=
            std::string::npos,
        "adaptive scalar error reduction must hand results back to legacy default-stream consumers");
}

void adaptive_policy_calculation_uses_compute_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string source = read_text_file(
        root / "gpu" / "cuda" / "runtime" / "reductions_fp64.cu");
    const std::string controller = read_text_file(
        root / "gpu" / "cuda" / "runtime" / "adaptive_controller.cuh");
    const std::string reduction = function_body(
        source,
        "AdaptiveErrorPolicy reduce_adaptive_error_policy(");

    check(
        reduction.find("context_begin_compute_stream_work(ctx, \"reduce_adaptive_error_policy\")") !=
            std::string::npos,
        "adaptive policy reduction must wait for default-stream error producers");
    check(
        reduction.find("adaptive_error_policy_kernel<<<1, 1, 0, stream>>>") !=
            std::string::npos,
        "adaptive policy reduction must compute sqrt, accept predicate, and dt candidate on the Context compute stream");
    check(
        reduction.find("adaptive::decide_adaptive_step") == std::string::npos &&
            reduction.find("fullmag_fdm_record_hot_loop_host_compute") == std::string::npos,
        "canonical PI decision and retry accounting must not execute on the host");
    check(
        reduction.find("ctx.adaptive_previous_error") != std::string::npos &&
            reduction.find("ctx.adaptive_rejected_attempts") != std::string::npos &&
            controller.find("ADAPTIVE_MAX_REJECTED_ATTEMPTS") != std::string::npos,
        "device policy must consume PI history and enforce the versioned retry budget");
    check(
        controller.find("ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED") !=
            std::string::npos,
        "device policy must publish a typed retry-limit terminal reason");
    check(
        controller.find("fullmag_fdm_adaptive_attempt_v1 *attempt_trace") !=
                std::string::npos &&
            controller.find("publish_adaptive_attempt(attempt_trace") !=
                std::string::npos,
        "device policy must append every decision to the preallocated attempt trace");
    check(
        reduction.find("cudaMemcpyAsync(\n        &host_control") != std::string::npos &&
            reduction.find("sizeof(host_control)") != std::string::npos,
        "adaptive policy reduction must asynchronously copy one typed control packet");
    check(
        reduction.find("context_end_compute_stream_work(ctx, \"reduce_adaptive_error_policy\")") !=
            std::string::npos,
        "adaptive policy reduction must hand policy results back to legacy default-stream consumers");
}

void adaptive_d2d_copies_use_compute_stream() {
    const std::filesystem::path root = fdm_source_root();
    const auto cuda = root / "gpu" / "cuda";
    const std::string dp45_fp64 = read_text_file(cuda / "integrators" / "llg_dp45_fp64.cu");
    const std::string dp45_fp32 = read_text_file(cuda / "integrators" / "llg_dp45_fp32.cu");
    const std::string rk23_fp64 = read_text_file(cuda / "integrators" / "llg_rk23_fp64.cu");
    const std::string rk23_fp32 = read_text_file(cuda / "integrators" / "llg_rk23_fp32.cu");
    const std::string adaptive_sources = dp45_fp64 + dp45_fp32 + rk23_fp64 + rk23_fp32;

    check(
        adaptive_sources.find("cudaMemcpy(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice)") ==
            std::string::npos,
        "adaptive RK23/DP45 D2D x-component copies must not use the legacy default stream");
    check(
        adaptive_sources.find("cudaMemcpy(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice)") ==
            std::string::npos,
        "adaptive RK23/DP45 D2D y-component copies must not use the legacy default stream");
    check(
        adaptive_sources.find("cudaMemcpy(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice)") ==
            std::string::npos,
        "adaptive RK23/DP45 D2D z-component copies must not use the legacy default stream");

    check(
        adaptive_sources.find("cudaMemcpyAsync(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice, stream)") !=
            std::string::npos,
        "adaptive RK23/DP45 D2D x-component copies must be bound to an explicit stream");
    check(
        adaptive_sources.find("cudaMemcpyAsync(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice, stream)") !=
            std::string::npos,
        "adaptive RK23/DP45 D2D y-component copies must be bound to an explicit stream");
    check(
        adaptive_sources.find("cudaMemcpyAsync(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice, stream)") !=
            std::string::npos,
        "adaptive RK23/DP45 D2D z-component copies must be bound to an explicit stream");

    check(
        adaptive_sources.find("copy_field_d2d(ctx.tmp, ctx.m, ctx.cell_count, context_compute_stream(ctx))") !=
            std::string::npos,
        "adaptive RK23/DP45 fp64 initial backup copies must use the Context compute stream");
    check(
        adaptive_sources.find("copy_field_d2d(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx))") !=
            std::string::npos,
        "adaptive RK23/DP45 fp64 reject restores must use the Context compute stream");
    check(
        adaptive_sources.find("copy_field_d2d(ctx.k1, ctx.k_fsal, ctx.cell_count, context_compute_stream(ctx))") !=
            std::string::npos,
        "adaptive RK23/DP45 fp64 FSAL reuse copies must use the Context compute stream");
    check(
        adaptive_sources.find("copy_field_d2d_fp32(ctx.tmp, ctx.m, ctx.cell_count, context_compute_stream(ctx))") !=
            std::string::npos,
        "adaptive RK23/DP45 fp32 initial backup copies must use the Context compute stream");
    check(
        adaptive_sources.find("copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx))") !=
            std::string::npos,
        "adaptive RK23/DP45 fp32 reject restores must use the Context compute stream");
    check(
        adaptive_sources.find("copy_field_d2d_fp32(ctx.k1, ctx.k_fsal, ctx.cell_count, context_compute_stream(ctx))") !=
            std::string::npos,
        "adaptive RK23/DP45 fp32 FSAL reuse copies must use the Context compute stream");
}

void adaptive_integrators_accept_device_owned_dt() {
    const std::filesystem::path root = fdm_source_root();
    const auto cuda = root / "gpu" / "cuda";
    const std::string graph_contract = read_text_file(
        root / "tests" / "adaptive_conditional_graph_contract.cu");
    check(
        graph_contract.find("cudaGraphCondTypeWhile") != std::string::npos &&
            graph_contract.find("cudaGraphSetConditional") != std::string::npos,
        "adaptive controller must execute through a device-controlled CUDA while node");

    for (const auto *path : {
             "llg_rk23_fp64.cu",
             "llg_rk23_fp32.cu",
             "llg_dp45_fp64.cu",
             "llg_dp45_fp32.cu",
         }) {
        const std::string source = read_text_file(cuda / "integrators" / path);
        check(
            source.find("const AdaptiveDeviceControl *adaptive_control") !=
                    std::string::npos &&
                source.find("adaptive_attempt_dt(adaptive_control, host_dt)") !=
                    std::string::npos,
            "every adaptive RK stage/error implementation must accept device-owned dt");
    }
}

} // namespace

int main() {
    adaptive_error_reductions_stay_device_side();
    adaptive_error_scalar_reduction_uses_compute_stream();
    adaptive_policy_calculation_uses_compute_stream();
    adaptive_d2d_copies_use_compute_stream();
    adaptive_integrators_accept_device_owned_dt();
    std::printf("adaptive error reduction contract: PASS\n");
    return 0;
}
