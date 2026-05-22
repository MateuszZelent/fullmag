/*
 * source_layout_contract.cpp - native FDM source ownership layout contract.
 *
 * Native FDM must not keep API glue, context allocation, CUDA runtime helpers,
 * interactions, integrators, and demag kernel generation in one flat src/
 * directory.  The layout mirrors the native FEM modularization style while
 * preserving the existing C ABI and CUDA implementation.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_file(const std::filesystem::path &path) {
    std::ifstream file(path);
    check(file.good(), path.string().c_str());
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

std::filesystem::path fdm_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void expected_owner_paths_exist() {
    const std::filesystem::path root = fdm_source_root();
    const char *expected[] = {
        "api/c_api.cpp",
        "api/error.cpp",
        "core/context.cu",
        "core/telemetry.cu",
        "cuda/runtime/device_info.cpp",
        "cuda/runtime/streams.cu",
        "cuda/runtime/reductions_fp64.cu",
        "cuda/interactions/exchange_fp64.cu",
        "cuda/interactions/exchange_fp32.cu",
        "cuda/interactions/exchange_t0_fp64.cu",
        "cuda/interactions/exchange_t1_fp64.cu",
        "cuda/interactions/demag_fp64.cu",
        "cuda/interactions/demag_fp32.cu",
        "cuda/interactions/demag_boundary_fp64.cu",
        "cuda/integrators/llg_fp64.cu",
        "cuda/integrators/llg_fp32.cu",
        "cuda/integrators/llg_dp45_fp64.cu",
        "cuda/integrators/llg_dp45_fp32.cu",
        "cuda/integrators/llg_rk4_fp64.cu",
        "cuda/integrators/llg_rk4_fp32.cu",
        "cuda/integrators/llg_rk23_fp64.cu",
        "cuda/integrators/llg_rk23_fp32.cu",
        "cuda/integrators/llg_abm3_fp64.cu",
        "cuda/integrators/llg_abm3_fp32.cu",
        "cuda/demag/multilayer_convolution.cu",
        "cuda/demag/newell_gpu_fp64.cu",
        "cuda/demag/newell_gpu_fp32.cu",
    };

    for (const char *path : expected) {
        check(std::filesystem::exists(root / path), path);
    }
}

void telemetry_has_core_owner() {
    const std::filesystem::path root = fdm_source_root();
    const std::string telemetry = read_file(root / "core/telemetry.cu");
    check(
        telemetry.find("context_fill_current_stats") != std::string::npos,
        "core/telemetry.cu must own context_fill_current_stats");
    check(
        telemetry.find("launch_exchange_energy_fp64") != std::string::npos,
        "core/telemetry.cu must own energy-reduction wiring");

    const std::string api = read_file(root / "api/c_api.cpp");
    check(
        api.find("bool fill_current_stats") == std::string::npos,
        "api/c_api.cpp must not own fill_current_stats");
    check(
        api.find("launch_exchange_energy_fp64") == std::string::npos,
        "api/c_api.cpp must not wire energy reductions directly");
}

void streams_have_runtime_owner() {
    const std::filesystem::path root = fdm_source_root();
    const std::string streams = read_file(root / "cuda/runtime/streams.cu");
    check(
        streams.find("context_create_compute_stream") != std::string::npos,
        "cuda/runtime/streams.cu must own compute stream creation");
    check(
        streams.find("context_begin_compute_stream_work") != std::string::npos,
        "cuda/runtime/streams.cu must own compute stream handoff");

    const std::string context = read_file(root / "core/context.cu");
    check(
        context.find("static bool create_compute_stream") == std::string::npos,
        "core/context.cu must not own compute stream creation");
    check(
        context.find("bool context_begin_compute_stream_work") == std::string::npos,
        "core/context.cu must not own compute stream handoff");
}

void old_flat_sources_are_gone() {
    const std::filesystem::path root = fdm_source_root();
    const char *legacy[] = {
        "src/api.cpp",
        "src/error.cpp",
        "src/context.cu",
        "src/device_info.cpp",
        "src/reductions_fp64.cu",
        "src/exchange_fp64.cu",
        "src/exchange_fp32.cu",
        "src/exchange_t0_fp64.cu",
        "src/exchange_t1_fp64.cu",
        "src/demag_fp64.cu",
        "src/demag_fp32.cu",
        "src/demag_boundary_fp64.cu",
        "src/llg_fp64.cu",
        "src/llg_fp32.cu",
        "src/llg_dp45_fp64.cu",
        "src/llg_dp45_fp32.cu",
        "src/llg_rk4_fp64.cu",
        "src/llg_rk4_fp32.cu",
        "src/llg_rk23_fp64.cu",
        "src/llg_rk23_fp32.cu",
        "src/llg_abm3_fp64.cu",
        "src/llg_abm3_fp32.cu",
        "src/newell_gpu_fp64.cu",
        "src/newell_gpu_fp32.cu",
    };

    for (const char *path : legacy) {
        check(!std::filesystem::exists(root / path), path);
    }
}

} // namespace

int main() {
    expected_owner_paths_exist();
    telemetry_has_core_owner();
    streams_have_runtime_owner();
    old_flat_sources_are_gone();
    std::printf("native FDM source layout contract: PASS\n");
    return 0;
}
