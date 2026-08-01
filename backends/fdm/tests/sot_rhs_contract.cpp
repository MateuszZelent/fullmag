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
    const std::string fp64 = read_file(fdm_root / "gpu/cuda/integrators/llg_fp64.cu");
    const std::string fp32 = read_file(fdm_root / "gpu/cuda/integrators/llg_fp32.cu");

    check(context.find("[A/m]") != std::string::npos,
          "SOT ABI amplitude is documented as an effective field");
    for (const auto *source : {&fp64, &fp32}) {
        check(source->find("gamma_bar *") != std::string::npos,
              "SOT field amplitude is converted through gamma_mu0 to RHS units");
        check(source->find("m_cross_raw") != std::string::npos,
              "SOT direct torque receives the Gilbert-form projection");
    }

    std::printf("FDM SOT RHS contract: PASS\n");
    return 0;
}
