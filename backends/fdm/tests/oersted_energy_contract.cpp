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

    std::puts("FDM Oersted external-energy source contract: PASS");
    return 0;
}
