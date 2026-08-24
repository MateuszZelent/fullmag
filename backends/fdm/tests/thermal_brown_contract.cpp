/* Source-level contract for the CUDA Brown thermal-field realization. */

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
    const auto repository_root = fdm_root.parent_path().parent_path();
    const std::string api = read_file(fdm_root / "api" / "c_api.cpp");
    const std::string context = read_file(fdm_root / "include" / "context.hpp");
    const std::string fp64 = read_file(fdm_root / "gpu/cuda/interactions/demag_fp64.cu");
    const std::string fp32 = read_file(fdm_root / "gpu/cuda/interactions/demag_fp32.cu");
    const std::string rk23 = read_file(fdm_root / "gpu/cuda/integrators/llg_rk23_fp64.cu");
    const std::string dp45 = read_file(fdm_root / "gpu/cuda/integrators/llg_dp45_fp64.cu");
    const std::string header = read_file(repository_root / "native/include/fullmag_fdm.h");

    check(header.find("thermal_seed") != std::string::npos,
          "native FDM plan ABI exposes the thermal seed");
    check(context.find("uint64_t thermal_seed") != std::string::npos,
          "CUDA Context retains the resolved thermal seed");
    check(api.find("ctx.trial_dt = dt_seconds") != std::string::npos,
          "every native attempt supplies its trial timestep to the thermal field");
    check(api.find("ctx->thermal_seed = plan->thermal_seed") != std::string::npos,
          "native plan seed is retained by the CUDA context");
    for (const auto *source : {&fp64, &fp32}) {
        check(source->find("double gamma0 = ctx.gamma * MU0") == std::string::npos,
              "Brown variance does not apply mu0 to gamma_mu0 twice");
        check(source->find("ctx.gamma * MU0 * ctx.Ms") != std::string::npos,
              "Brown variance uses gamma_mu0 * mu0 * Ms");
        check(source->find("curand_init(thermal_seed, idx, thermal_step") != std::string::npos,
              "Brown RNG key includes seed, accepted step, and cell");
    }
    for (const auto *source : {&rk23, &dp45}) {
        check(source->find("ctx.trial_dt = dt;") != std::string::npos,
              "adaptive attempts update Brown variance with their attempted timestep");
    }

    std::printf("FDM CUDA Brown thermal contract: PASS\n");
    return 0;
}
