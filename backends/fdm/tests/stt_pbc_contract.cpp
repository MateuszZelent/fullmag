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
    const std::string abi = read_file(
        fdm_root.parent_path().parent_path() / "native/include/fullmag_fdm.h");
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
    check(fp64.find("zhang_li_neighbor_index(x, nx, 1, idx, -1, stt.periodic_x)") != std::string::npos,
          "FP64 MuMax3 Zhang-Li stencil wraps or clamps the x seam");
    check(fp32.find("zhang_li_neighbor_index(x, nx, 1, idx, -1, stt.periodic_x)") != std::string::npos,
          "FP32 MuMax3 Zhang-Li stencil wraps or clamps the x seam");
    check(context.find("zhang_li_formula") != std::string::npos,
          "Context carries an explicit Zhang-Li formula discriminator");
    check(abi.find("FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1") != std::string::npos,
          "FDM ABI carries the versioned MuMax3 Zhang-Li discriminator");
    check(fp64.find("FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1") != std::string::npos,
          "FP64 kernel contains the versioned MuMax3 central realization");
    check(fp32.find("FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1") != std::string::npos,
          "FP32 kernel contains the versioned MuMax3 central realization");
    check(fp64.find("0.5 / stt.dx") != std::string::npos,
          "FP64 MuMax3 realization uses the centered derivative denominator");
    check(fp32.find("0.5f / static_cast<float>(stt.dx)") != std::string::npos,
          "FP32 MuMax3 realization uses the centered derivative denominator");

    std::printf("FDM Zhang-Li periodic-stencil contract: PASS\n");
    return 0;
}
