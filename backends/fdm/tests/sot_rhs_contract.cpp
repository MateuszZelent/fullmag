/* Source-level contract for SOT field-to-RHS conversion. */

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
    const auto integrators = fdm_root / "gpu/cuda/integrators";
    const std::string fp64 = read_file(integrators / "llg_fp64.cu");
    const std::string fp32 = read_file(integrators / "llg_fp32.cu");
    const std::string local_fp64 = read_file(integrators / "prescribed_spin_torques_fp64.cuh");
    const std::string fused_fp64 = read_file(
        fdm_root / "gpu/cuda/interactions/demag_fp64.cu");

    check(context.find("p.amp = prescribed_sot_rate_prefactor(") != std::string::npos,
          "canonical SOT supplies a signed rate prefactor");
    check(fp64.find("add_prescribed_spin_torques_fp64(") != std::string::npos &&
              fused_fp64.find("add_prescribed_spin_torques_fp64(") != std::string::npos,
          "fused and separate FP64 RHS use the same local torque implementation");
    for (const auto *implementation : {&local_fp64, &fp32}) {
        check(implementation->find("prescribed_sot_explicit_rhs(") != std::string::npos,
              "canonical SOT uses the shared Gilbert-form projection");
    }

    std::printf("FDM SOT RHS contract: PASS\n");
    return 0;
}
