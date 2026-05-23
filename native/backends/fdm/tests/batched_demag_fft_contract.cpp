/*
 * batched_demag_fft_contract.cpp - native FDM demag FFT batching contract.
 *
 * Demag field evaluation must transform the x/y/z magnetization components as
 * one contiguous three-transform cuFFT batch.  Separate component FFT launches
 * reintroduce avoidable launch overhead on the GPU demag hot path.
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

std::size_t count_occurrences(const std::string &text, const std::string &needle) {
    std::size_t count = 0;
    std::size_t pos = 0;
    while ((pos = text.find(needle, pos)) != std::string::npos) {
        ++count;
        pos += needle.size();
    }
    return count;
}

void demag_fft_resources_are_batched() {
    const std::filesystem::path root = fdm_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string context =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu");

    check(
        context_header.find("fft_components_share_allocation") != std::string::npos,
        "Context must record that demag FFT component buffers share one allocation");
    check(
        context_header.find("fft_component_stride") != std::string::npos,
        "Context must record the batched demag FFT component stride");
    check(
        context.find("cufftMakePlanMany") != std::string::npos,
        "demag FFT plan must be created with cufftMakePlanMany");
    check(
        context.find("cufftPlanMany(") == std::string::npos,
        "demag FFT plan must not use auto-allocating cufftPlanMany");
    check(
        context.find("cudaMalloc(&ctx.fft_y") == std::string::npos,
        "demag FFT y component must not use a separate allocation");
    check(
        context.find("cudaMalloc(&ctx.fft_z") == std::string::npos,
        "demag FFT z component must not use a separate allocation");
}

void demag_fft_work_area_is_owned_by_context() {
    const std::filesystem::path root = fdm_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string context =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu");

    check(
        context_header.find("fft_work_area") != std::string::npos,
        "Context must own the demag cuFFT work area pointer");
    check(
        context_header.find("fft_work_area_bytes") != std::string::npos,
        "Context must record demag cuFFT work area size");
    check(
        context.find("cufftSetAutoAllocation(ctx.fft_plan, 0)") != std::string::npos,
        "demag cuFFT plan must disable automatic work-area allocation");
    check(
        context.find("cufftMakePlanMany") != std::string::npos,
        "demag cuFFT plan must use cufftMakePlanMany to query work size");
    check(
        context.find("cufftSetWorkArea(ctx.fft_plan, ctx.fft_work_area)") != std::string::npos,
        "demag cuFFT plan must use the Context-owned work area");
}

void demag_fft_runs_on_context_compute_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string context =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string streams =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "streams.cu");
    const std::string fp64 = function_body(
        read_text_file(root / "gpu" / "cuda" / "interactions" / "demag_fp64.cu"),
        "void launch_demag_field_fp64(Context &ctx)");
    const std::string fp32 = function_body(
        read_text_file(root / "gpu" / "cuda" / "interactions" / "demag_fp32.cu"),
        "void launch_demag_field_fp32(Context &ctx)");

    check(
        context_header.find("compute_stream") != std::string::npos,
        "Context must own the backend compute stream");
    check(
        context_header.find("compute_ready_event") != std::string::npos &&
            context_header.find("compute_done_event") != std::string::npos,
        "Context must own stream handoff events for legacy-default ordering");
    check(
        streams.find("cudaStreamCreateWithFlags(&compute_stream, cudaStreamNonBlocking)") !=
            std::string::npos,
        "Context compute stream must be nonblocking for later overlap work");
    check(
        context.find("context_create_compute_stream(ctx)") != std::string::npos,
        "Context allocation must request stream lifecycle through the runtime stream owner");
    check(
        context.find("cufftSetStream(ctx.fft_plan, context_compute_stream(ctx))") !=
            std::string::npos,
        "demag cuFFT plan must be bound to the Context compute stream");
    check(
        fp64.find("context_begin_compute_stream_work(ctx, \"launch_demag_field_fp64\")") !=
                std::string::npos &&
            fp64.find("context_end_compute_stream_work(ctx, \"launch_demag_field_fp64\")") !=
                std::string::npos,
        "fp64 demag must hand off default-stream dependencies to the compute stream");
    check(
        fp32.find("context_begin_compute_stream_work(ctx, \"launch_demag_field_fp32\")") !=
                std::string::npos &&
            fp32.find("context_end_compute_stream_work(ctx, \"launch_demag_field_fp32\")") !=
                std::string::npos,
        "fp32 demag must hand off default-stream dependencies to the compute stream");
    check(
        fp64.find("<<<grid_padded, BLOCK_SIZE>>>") == std::string::npos &&
            fp64.find("<<<grid_physical, BLOCK_SIZE>>>") == std::string::npos &&
            fp64.find("<<<corr_grid, BLOCK_SIZE>>>") == std::string::npos,
        "fp64 demag kernels must launch on the Context compute stream");
    check(
        fp32.find("<<<grid_padded, BLOCK_SIZE>>>") == std::string::npos &&
            fp32.find("<<<grid_physical, BLOCK_SIZE>>>") == std::string::npos,
        "fp32 demag kernels must launch on the Context compute stream");
}

void demag_launches_use_one_forward_and_inverse_batch() {
    const std::filesystem::path root = fdm_source_root();
    const std::string fp64 = function_body(
        read_text_file(root / "gpu" / "cuda" / "interactions" / "demag_fp64.cu"),
        "void launch_demag_field_fp64(Context &ctx)");
    const std::string fp32 = function_body(
        read_text_file(root / "gpu" / "cuda" / "interactions" / "demag_fp32.cu"),
        "void launch_demag_field_fp32(Context &ctx)");

    check(
        fp64.find("cufftExecZ2Z(") != std::string::npos,
        "fp64 demag field launch must call cufftExecZ2Z");
    check(
        count_occurrences(fp64, "CUFFT_FORWARD") == 1 &&
            count_occurrences(fp64, "CUFFT_INVERSE") == 1,
        "fp64 demag field launch must use one forward and one inverse batch");
    check(
        fp32.find("cufftExecC2C(") != std::string::npos,
        "fp32 demag field launch must call cufftExecC2C");
    check(
        count_occurrences(fp32, "CUFFT_FORWARD") == 1 &&
            count_occurrences(fp32, "CUFFT_INVERSE") == 1,
        "fp32 demag field launch must use one forward and one inverse batch");
}

void multilayer_demag_launches_use_one_forward_and_inverse_batch_per_kernel() {
    const std::filesystem::path root = fdm_source_root();
    const std::string fp64 = function_body(
        read_text_file(root / "gpu" / "cuda" / "demag" / "multilayer_convolution.cu"),
        "void launch_multilayer_demag_field_fp64(Context &ctx)");
    const std::string fp32 = function_body(
        read_text_file(root / "gpu" / "cuda" / "demag" / "multilayer_convolution.cu"),
        "void launch_multilayer_demag_field_fp32(Context &ctx)");

    check(
        fp64.find("cufftExecZ2Z(") != std::string::npos,
        "fp64 multilayer demag field launch must call cufftExecZ2Z");
    check(
        count_occurrences(fp64, "CUFFT_FORWARD") == 1 &&
            count_occurrences(fp64, "CUFFT_INVERSE") == 1,
        "fp64 multilayer demag field launch must use one forward and one inverse batch per tensor kernel");
    check(
        fp32.find("cufftExecC2C(") != std::string::npos,
        "fp32 multilayer demag field launch must call cufftExecC2C");
    check(
        count_occurrences(fp32, "CUFFT_FORWARD") == 1 &&
            count_occurrences(fp32, "CUFFT_INVERSE") == 1,
        "fp32 multilayer demag field launch must use one forward and one inverse batch per tensor kernel");
}

} // namespace

int main() {
    demag_fft_resources_are_batched();
    demag_fft_work_area_is_owned_by_context();
    demag_fft_runs_on_context_compute_stream();
    demag_launches_use_one_forward_and_inverse_batch();
    multilayer_demag_launches_use_one_forward_and_inverse_batch_per_kernel();
    std::printf("batched demag FFT contract: PASS\n");
    return 0;
}
