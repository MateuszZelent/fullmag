/* Source-level contract for periodic Zhang-Li upwind stencils. */

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
    const std::string context = read_file(fdm_root / "include" / "context.hpp");
    const std::string fp64 = read_file(fdm_root / "gpu/cuda/integrators/llg_fp64.cu");
    const std::string fp32 = read_file(fdm_root / "gpu/cuda/integrators/llg_fp32.cu");

    for (const auto *axis : {"periodic_x", "periodic_y", "periodic_z"}) {
        check(context.find(axis) != std::string::npos,
              "Context-to-kernel STT parameters preserve every periodic axis");
        check(fp64.find(axis) != std::string::npos,
              "FP64 Zhang-Li stencil uses configured periodic axes");
        check(fp32.find(axis) != std::string::npos,
              "FP32 Zhang-Li stencil uses configured periodic axes");
    }
    check(fp64.find("idx + nx - 1") != std::string::npos,
          "FP64 Zhang-Li upwind stencil wraps the x seam");
    check(fp32.find("idx + nx - 1") != std::string::npos,
          "FP32 Zhang-Li upwind stencil wraps the x seam");

    std::printf("FDM Zhang-Li periodic-stencil contract: PASS\n");
    return 0;
}
