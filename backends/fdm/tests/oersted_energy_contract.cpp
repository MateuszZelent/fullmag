/* Source-level guard for Oersted Zeeman energy in both native CUDA precisions. */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_file(const std::filesystem::path &path) {
    std::ifstream input(path);
    check(input.good(), path.string().c_str());
    std::ostringstream content;
    content << input.rdbuf();
    return content.str();
}

} // namespace

int main() {
    const std::filesystem::path this_file(__FILE__);
    const auto fdm_root = this_file.parent_path().parent_path();
    const std::string reductions =
        read_file(fdm_root / "gpu/cuda/runtime/reductions_fp64.cu");
    const std::string context =
        read_file(fdm_root / "gpu/cuda/runtime/context.cu");

    check(reductions.find("ctx.has_oersted_field") != std::string::npos,
          "external-energy reduction must recognize an Oersted source");
    check(reductions.find("oersted_field_scale(ctx, ctx.current_time)") !=
              std::string::npos,
          "external-energy reduction must use the time-dependent Oersted envelope");
    check(reductions.find("ctx.h_oe_static.x") != std::string::npos &&
              reductions.find("ctx.h_oe_static.y") != std::string::npos &&
              reductions.find("ctx.h_oe_static.z") != std::string::npos,
          "external-energy reduction must read every Oersted field component");
    check(reductions.find("reduce_external_energy_fp64") != std::string::npos &&
              reductions.find("reduce_external_energy_fp32") != std::string::npos,
          "both native precision reductions must share the Oersted contract");

    const std::size_t preflight_start = context.find(
        "bool context_preflight_single_grid_workspace(");
    const std::size_t preflight_end = context.find(
        "cudaError_t context_gpu_workspace_cuda_free(", preflight_start);
    check(
        preflight_start != std::string::npos &&
            preflight_end != std::string::npos &&
            preflight_end > preflight_start,
        "single-grid CUDA workspace preflight must remain a bounded source contract");
    const std::string preflight = context.substr(
        preflight_start, preflight_end - preflight_start);
    check(
        preflight.find("h_oe_static_vector_fields = 1") != std::string::npos &&
            preflight.find("vector_field_count += h_oe_static_vector_fields") !=
                std::string::npos &&
            preflight.find("late static external-field profile setter") !=
                std::string::npos &&
            preflight.find("if (ctx.has_oersted_field) ++vector_field_count") ==
                std::string::npos,
        "single-grid CUDA workspace preflight must reserve the shared h_oe_static slot for the late static external-field setter");

    std::puts("FDM Oersted external-energy source contract: PASS");
    return 0;
}
