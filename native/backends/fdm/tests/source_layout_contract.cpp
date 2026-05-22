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

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
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
        "cuda/runtime/device_info.cpp",
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
    old_flat_sources_are_gone();
    std::printf("native FDM source layout contract: PASS\n");
    return 0;
}
