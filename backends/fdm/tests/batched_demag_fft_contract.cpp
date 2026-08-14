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

#include "../include/multilayer_batch_contract.hpp"

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

void multilayer_demag_launches_use_one_forward_and_inverse_batch_per_refresh() {
    const std::filesystem::path root = fdm_source_root();
    const std::string fp64 = function_body(
        read_text_file(root / "gpu" / "cuda" / "demag" / "multilayer_convolution.cu"),
        "void launch_multilayer_demag_field_fp64_batched(Context &ctx)");
    const std::string fp32 = function_body(
        read_text_file(root / "gpu" / "cuda" / "demag" / "multilayer_convolution.cu"),
        "void launch_multilayer_demag_field_fp32_batched(Context &ctx)");

    check(
        fp64.find("cufftExecZ2Z(") != std::string::npos,
        "fp64 multilayer demag field launch must call cufftExecZ2Z");
    check(
        count_occurrences(fp64, "CUFFT_FORWARD") == 1 &&
            count_occurrences(fp64, "CUFFT_INVERSE") == 1,
        "fp64 multilayer demag field launch must use one forward and one inverse batch per refresh");
    check(
        fp32.find("cufftExecC2C(") != std::string::npos,
        "fp32 multilayer demag field launch must call cufftExecC2C");
    check(
        count_occurrences(fp32, "CUFFT_FORWARD") == 1 &&
            count_occurrences(fp32, "CUFFT_INVERSE") == 1,
        "fp32 multilayer demag field launch must use one forward and one inverse batch per refresh");
    check(
        fp64.find("for (const DeviceMultilayerTensorKernel &kernel") == std::string::npos &&
            fp32.find("for (const DeviceMultilayerTensorKernel &kernel") == std::string::npos,
        "batched multilayer path must not place FFT calls inside a pair-kernel loop");
    check(
        fp64.find("note_forward_fft") != std::string::npos &&
            fp64.find("note_inverse_fft") != std::string::npos &&
            fp64.find("note_pair_accumulation") != std::string::npos &&
            fp32.find("note_forward_fft") != std::string::npos &&
            fp32.find("note_inverse_fft") != std::string::npos &&
            fp32.find("note_pair_accumulation") != std::string::npos,
        "batched path must update the device-resident stage counter");
}

void multilayer_stage_counter_is_exact_without_a_gpu() {
    for (const uint64_t layer_count : {1u, 2u, 3u, 4u, 8u}) {
        const auto expected = fullmag::fdm::expected_multilayer_batch_counts(layer_count);
        check(expected.forward_fft_count == layer_count,
              "expected batched forward FFT count must equal L");
        check(expected.inverse_fft_count == layer_count,
              "expected batched inverse FFT count must equal L");
        check(expected.pair_accumulation_count == layer_count * layer_count,
              "expected batched pair accumulation count must equal L^2");
        check(expected.h2d_count == 0 && expected.d2h_count == 0,
              "warm device-resident refresh must not perform host transfers");

        fullmag::fdm::MultilayerDemagStageCounters actual;
        actual.begin_refresh(layer_count);
        for (uint64_t i = 0; i < layer_count; ++i) {
            actual.note_forward_fft();
        }
        for (uint64_t i = 0; i < layer_count * layer_count; ++i) {
            actual.note_pair_accumulation();
        }
        for (uint64_t i = 0; i < layer_count; ++i) {
            actual.note_inverse_fft();
        }
        check(actual.matches(expected),
              "stage counter must accept exactly L forward, L inverse and L^2 pairs");

        actual.refresh_count = 0;
        check(!actual.matches(expected),
              "stage counter must reject FFT/pair counts without one recorded refresh");
    }
}

void d07_batched_refresh_has_l_fft_stages_l_squared_pairs_and_zeroed_destinations() {
    const std::filesystem::path root = fdm_source_root();
    const std::string source =
        read_text_file(root / "gpu" / "cuda" / "demag" / "multilayer_convolution.cu");

    const auto check_precision = [&](const std::string &launch_signature,
                                     const std::string &fft_call,
                                     const char *precision) {
        const std::string launch = function_body(source, launch_signature);
        const std::string source_loop = function_body(
            launch, "for (uint32_t src_index = 0; src_index < layer_count; ++src_index)");
        const std::string destination_loop = function_body(
            launch, "for (uint32_t dst_index = 0; dst_index < layer_count; ++dst_index)");
        const std::string pair_loop = function_body(
            destination_loop, "for (uint32_t src_index = 0; src_index < layer_count; ++src_index)");

        check(
            count_occurrences(launch, fft_call) == 2,
            "D-07 batched refresh must issue exactly one forward and one inverse cuFFT call site");
        check(
            count_occurrences(source_loop, "CUFFT_FORWARD") == 1 &&
                source_loop.find("CUFFT_INVERSE") == std::string::npos &&
                count_occurrences(source_loop, "note_forward_fft();") == 1 &&
                count_occurrences(launch, "note_forward_fft();") == 1,
            "D-07 source-layer loop must account for exactly one forward FFT per layer");
        check(
            count_occurrences(destination_loop, "CUFFT_INVERSE") == 1 &&
                destination_loop.find("CUFFT_FORWARD") == std::string::npos &&
                count_occurrences(destination_loop, "note_inverse_fft();") == 1 &&
                count_occurrences(launch, "note_inverse_fft();") == 1,
            "D-07 destination-layer loop must account for exactly one inverse FFT per layer");
        check(
            count_occurrences(pair_loop, "accumulate_demag_tensor_kernel_") == 1 &&
                count_occurrences(pair_loop, "note_pair_accumulation();") == 1 &&
                count_occurrences(destination_loop, "note_pair_accumulation();") == 1 &&
                count_occurrences(launch, "note_pair_accumulation();") == 1 &&
                pair_loop.find("CUFFT_FORWARD") == std::string::npos &&
                pair_loop.find("CUFFT_INVERSE") == std::string::npos,
            "D-07 pair loop must perform one accumulation and no FFT per ordered pair");

        const std::size_t zero_x = destination_loop.find("cudaMemsetAsync(destination_x, 0, bytes, stream)");
        const std::size_t zero_y = destination_loop.find("cudaMemsetAsync(destination_y, 0, bytes, stream)");
        const std::size_t zero_z = destination_loop.find("cudaMemsetAsync(destination_z, 0, bytes, stream)");
        const std::size_t first_pair = destination_loop.find(
            "for (uint32_t src_index = 0; src_index < layer_count; ++src_index)");
        check(
            zero_x != std::string::npos && zero_y != std::string::npos &&
                zero_z != std::string::npos && first_pair != std::string::npos &&
                zero_x < first_pair && zero_y < first_pair && zero_z < first_pair,
            "D-07 must zero every destination spectrum before its L pair accumulations");
        check(
            launch.find("cudaMemcpy") == std::string::npos &&
                launch.find("_assisted") == std::string::npos,
            "D-07 batched refresh must not transfer spectra or invoke the assisted path");
        (void)precision;
    };

    check_precision(
        "void launch_multilayer_demag_field_fp64_batched(Context &ctx)",
        "cufftResult fft_err = cufftExecZ2Z(",
        "fp64");
    check_precision(
        "void launch_multilayer_demag_field_fp32_batched(Context &ctx)",
        "cufftResult fft_err = cufftExecC2C(",
        "fp32");
}

void d07_batch_selection_requires_complete_catalog_and_fails_closed() {
    const std::filesystem::path root = fdm_source_root();
    const std::string source =
        read_text_file(root / "gpu" / "cuda" / "demag" / "multilayer_convolution.cu");
    const std::string classification = function_body(
        source, "bool classify_multilayer_batch_plan(");
    const std::string fp64_dispatch = function_body(
        source, "void launch_multilayer_demag_field_fp64(Context &ctx)");
    const std::string fp32_dispatch = function_body(
        source, "void launch_multilayer_demag_field_fp32(Context &ctx)");

    check(
        classification.find("expected_kernel_count = layer_count * layer_count") !=
                std::string::npos &&
            classification.find("std::vector<uint8_t> seen(expected_kernel_count, 0)") !=
                std::string::npos &&
            classification.find("duplicate tensor pair") != std::string::npos &&
            classification.find("incomplete tensor pair catalog") != std::string::npos &&
            classification.find("use_batched = true") != std::string::npos,
        "D-07 selection must require and catalog every ordered L^2 tensor pair");
    check(
        classification.find("D-07 device-resident spectra were not prepared before refresh") !=
                std::string::npos &&
            classification.find("unsupported multilayer transfer kind; refusing native refresh") !=
                std::string::npos,
        "D-07 selection must reject missing resident workspace and unknown transfers");
    check(
        fp64_dispatch.find("if (!classify_multilayer_batch_plan(") != std::string::npos &&
            fp64_dispatch.find("if (use_batched)") != std::string::npos &&
            fp64_dispatch.find("launch_multilayer_demag_field_fp64_batched(ctx)") !=
                std::string::npos &&
            fp32_dispatch.find("if (!classify_multilayer_batch_plan(") != std::string::npos &&
            fp32_dispatch.find("if (use_batched)") != std::string::npos &&
            fp32_dispatch.find("launch_multilayer_demag_field_fp32_batched(ctx)") !=
                std::string::npos,
        "D-07 dispatch must stop on classification failure instead of silently selecting another lane");

    const std::string fp64_classification_failure = function_body(
        fp64_dispatch, "if (!classify_multilayer_batch_plan(");
    const std::string fp32_classification_failure = function_body(
        fp32_dispatch, "if (!classify_multilayer_batch_plan(");
    check(
        count_occurrences(fp64_classification_failure, "return;") == 1 &&
            fp64_classification_failure.find("_assisted") == std::string::npos &&
            fp64_classification_failure.find("launch_multilayer_demag_field_fp64_batched") ==
                std::string::npos &&
            count_occurrences(fp32_classification_failure, "return;") == 1 &&
            fp32_classification_failure.find("_assisted") == std::string::npos &&
            fp32_classification_failure.find("launch_multilayer_demag_field_fp32_batched") ==
                std::string::npos,
        "D-07 classification failure must return directly before either CUDA lane");
}

void d07_runner_selection_and_fail_closed_matrix_is_covered() {
    const std::filesystem::path repo_root = fdm_source_root().parent_path().parent_path();
    const std::string cuda_runner = read_text_file(
        repo_root / "crates" / "fullmag-runner" / "src" / "fdm" / "gpu" / "cuda" /
            "multilayer.rs");
    const std::string cpu_runner = read_text_file(
        repo_root / "crates" / "fullmag-runner" / "src" / "fdm" / "cpu" /
            "multilayer_reference.rs");
    const std::string selection = read_text_file(
        repo_root / "crates" / "fullmag-runner" / "src" / "solver_runtime" /
            "selection.rs");

    check(
        cuda_runner.find("cuda_multilayer_two_d_mode_fails_closed_before_d07_or_probe") !=
                std::string::npos &&
            cuda_runner.find("cuda_multilayer_rejects_forged_fingerprint_before_allocation") !=
                std::string::npos,
        "runner must fail closed on unqualified two_d_stack before D-07 or CUDA probing and reject forged fingerprints before allocation");
    check(
        cpu_runner.find("multilayer_runtime_rejects_push_pull_for_periodic_boundaries") !=
                std::string::npos &&
            cpu_runner.find("multilayer_runtime_rejects_unsupported_transfer_before_allocation") !=
                std::string::npos,
        "runner must test fail-closed PBC and unsupported-transfer gates");
    check(
        selection.find("script_forced_gpu_fails_closed_when_cuda_is_unavailable") !=
                std::string::npos &&
            selection.find("CUDA backend is not available") != std::string::npos,
        "runner must test missing CUDA without silently falling back for forced GPU");
}

void multilayer_batch_storage_matches_cufft_component_stride() {
    const std::filesystem::path root = fdm_source_root();
    const std::string context_header =
        read_text_file(root / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string multilayer_source =
        read_text_file(root / "gpu" / "cuda" / "demag" /
                       "multilayer_convolution.cu");

    check(
        context_header.find("multilayer_batch_layer_stride") != std::string::npos,
        "D-07 workspace must record the [layer][component][cell] stride");
    check(
        context_source.find("component_bytes * index") != std::string::npos &&
            context_source.find("ctx.multilayer_batch_layer_stride = layer_stride") !=
                std::string::npos,
        "D-07 workspace must allocate one contiguous three-component block per layer");
    check(
        multilayer_source.find("const uint64_t layer_stride") != std::string::npos &&
            multilayer_source.find("const uint64_t component_stride") !=
                std::string::npos &&
            multilayer_source.find("* layer_stride") != std::string::npos,
        "D-07 launch must distinguish layer stride from cuFFT component stride");
}

} // namespace

int main() {
    demag_fft_resources_are_batched();
    demag_fft_work_area_is_owned_by_context();
    demag_fft_runs_on_context_compute_stream();
    demag_launches_use_one_forward_and_inverse_batch();
    multilayer_demag_launches_use_one_forward_and_inverse_batch_per_refresh();
    multilayer_stage_counter_is_exact_without_a_gpu();
    d07_batched_refresh_has_l_fft_stages_l_squared_pairs_and_zeroed_destinations();
    d07_batch_selection_requires_complete_catalog_and_fails_closed();
    d07_runner_selection_and_fail_closed_matrix_is_covered();
    multilayer_batch_storage_matches_cufft_component_stride();
    std::printf("batched demag FFT contract: PASS\n");
    return 0;
}
