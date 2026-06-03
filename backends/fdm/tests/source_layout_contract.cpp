/*
 * source_layout_contract.cpp - native FDM source ownership layout contract.
 *
 * Native FDM must not keep API glue, context allocation, CUDA runtime helpers,
 * interactions, integrators, and demag kernel generation in one flat src/
 * directory.  The layout mirrors the native FEM CPU/GPU modularization style
 * while preserving the existing C ABI and CUDA implementation.
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

void backend_root_is_top_level_backends_tree() {
    const std::filesystem::path root = fdm_source_root();
    check(
        root.filename() == "fdm" && root.parent_path().filename() == "backends",
        "native FDM source root must be top-level backends/fdm");

    const std::filesystem::path repo_root = root.parent_path().parent_path();
    check(
        !std::filesystem::exists(repo_root / "native" / "backends" / "fdm"),
        "native/backends/fdm must not be recreated as an implementation root");
}

void expected_owner_paths_exist() {
    const std::filesystem::path root = fdm_source_root();
    const char *expected[] = {
        "api/c_api.cpp",
        "api/error.cpp",
        "gpu/cuda/runtime/context.cu",
        "gpu/cuda/runtime/telemetry.cu",
        "gpu/cuda/runtime/device_info.cpp",
        "gpu/cuda/runtime/streams.cu",
        "gpu/cuda/runtime/reductions_fp64.cu",
        "gpu/cuda/interactions/exchange_fp64.cu",
        "gpu/cuda/interactions/exchange_fp32.cu",
        "gpu/cuda/interactions/multilayer_exchange.cu",
        "gpu/cuda/interactions/multilayer_dmi.cu",
        "gpu/cuda/interactions/multilayer_anisotropy.cu",
        "gpu/cuda/interactions/multilayer_effective_field.cu",
        "gpu/cuda/interactions/exchange_t0_fp64.cu",
        "gpu/cuda/interactions/exchange_t1_fp64.cu",
        "gpu/cuda/interactions/demag_fp64.cu",
        "gpu/cuda/interactions/demag_fp32.cu",
        "gpu/cuda/interactions/demag_boundary_fp64.cu",
        "gpu/cuda/integrators/llg_fp64.cu",
        "gpu/cuda/integrators/llg_fp32.cu",
        "gpu/cuda/integrators/llg_dp45_fp64.cu",
        "gpu/cuda/integrators/llg_dp45_fp32.cu",
        "gpu/cuda/integrators/llg_rk4_fp64.cu",
        "gpu/cuda/integrators/llg_rk4_fp32.cu",
        "gpu/cuda/integrators/llg_rk23_fp64.cu",
        "gpu/cuda/integrators/llg_rk23_fp32.cu",
        "gpu/cuda/integrators/llg_abm3_fp64.cu",
        "gpu/cuda/integrators/llg_abm3_fp32.cu",
        "gpu/cuda/integrators/multilayer_heun.cu",
        "gpu/cuda/integrators/multilayer_explicit_rk.cu",
        "gpu/cuda/demag/multilayer_convolution.cu",
        "gpu/cuda/demag/newell_gpu_fp64.cu",
        "gpu/cuda/demag/newell_gpu_fp32.cu",
    };

    for (const char *path : expected) {
        check(std::filesystem::exists(root / path), path);
    }
}

void telemetry_has_runtime_owner() {
    const std::filesystem::path root = fdm_source_root();
    const std::string telemetry = read_file(root / "gpu/cuda/runtime/telemetry.cu");
    check(
        telemetry.find("context_fill_current_stats") != std::string::npos,
        "gpu/cuda/runtime/telemetry.cu must own context_fill_current_stats");
    check(
        telemetry.find("launch_exchange_energy_fp64") != std::string::npos,
        "gpu/cuda/runtime/telemetry.cu must own energy-reduction wiring");

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
    const std::string streams = read_file(root / "gpu/cuda/runtime/streams.cu");
    check(
        streams.find("context_create_compute_stream") != std::string::npos,
        "gpu/cuda/runtime/streams.cu must own compute stream creation");
    check(
        streams.find("context_begin_compute_stream_work") != std::string::npos,
        "gpu/cuda/runtime/streams.cu must own compute stream handoff");

    const std::string context = read_file(root / "gpu/cuda/runtime/context.cu");
    check(
        context.find("static bool create_compute_stream") == std::string::npos,
        "gpu/cuda/runtime/context.cu must not own compute stream creation");
    check(
        context.find("bool context_begin_compute_stream_work") == std::string::npos,
        "gpu/cuda/runtime/context.cu must not own compute stream handoff");
}

void cmake_uses_gpu_runtime_owner_paths() {
    const std::filesystem::path root = fdm_source_root();
    const std::string cmake = read_file(root / "CMakeLists.txt");
    for (const char *path : {
             "gpu/cuda/runtime/context.cu",
             "gpu/cuda/runtime/telemetry.cu",
             "gpu/cuda/runtime/streams.cu",
             "gpu/cuda/interactions/multilayer_exchange.cu",
             "gpu/cuda/interactions/multilayer_dmi.cu",
             "gpu/cuda/interactions/multilayer_anisotropy.cu",
             "gpu/cuda/interactions/multilayer_effective_field.cu",
             "gpu/cuda/integrators/multilayer_heun.cu",
             "gpu/cuda/integrators/multilayer_explicit_rk.cu",
         }) {
        check(cmake.find(path) != std::string::npos, path);
    }
    for (const char *stale : {"core/context.cu", "core/telemetry.cu"}) {
        check(cmake.find(stale) == std::string::npos, stale);
    }
}

void old_flat_sources_are_gone() {
    const std::filesystem::path root = fdm_source_root();
    const char *legacy[] = {
        "src/api.cpp",
        "src/error.cpp",
        "src/context.cu",
        "core/context.cu",
        "core/telemetry.cu",
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
        "cuda/runtime/device_info.cpp",
        "cuda/runtime/streams.cu",
        "cuda/runtime/reductions_fp64.cu",
        "cuda/interactions/exchange_fp64.cu",
        "cuda/interactions/exchange_fp32.cu",
        "cuda/interactions/multilayer_exchange.cu",
        "cuda/interactions/multilayer_dmi.cu",
        "cuda/interactions/multilayer_anisotropy.cu",
        "cuda/interactions/multilayer_effective_field.cu",
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
        "cuda/integrators/multilayer_heun.cu",
        "cuda/integrators/multilayer_rk4.cu",
        "gpu/cuda/integrators/multilayer_rk4.cu",
        "cuda/demag/multilayer_convolution.cu",
        "cuda/demag/newell_gpu_fp64.cu",
        "cuda/demag/newell_gpu_fp32.cu",
    };

    for (const char *path : legacy) {
        check(!std::filesystem::exists(root / path), path);
    }
}

} // namespace

int main() {
    backend_root_is_top_level_backends_tree();
    expected_owner_paths_exist();
    telemetry_has_runtime_owner();
    streams_have_runtime_owner();
    cmake_uses_gpu_runtime_owner_paths();
    old_flat_sources_are_gone();
    std::printf("native FDM source layout contract: PASS\n");
    return 0;
}
