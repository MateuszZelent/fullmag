/* Source-level fail-closed guard for unqualified FP32 T0/T1 execution. */

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
    const std::string api = read_file(fdm_root / "api" / "c_api.cpp");

    check(
        api.find("plan->precision == FULLMAG_FDM_PRECISION_SINGLE") != std::string::npos
            && api.find("plan->boundary_correction != FULLMAG_FDM_BOUNDARY_NONE")
                    != std::string::npos,
        "native FDM ABI must reject FP32 T0/T1 before CUDA allocation");
    check(
        api.find("FDM FP32 sub-cell boundary correction is unavailable") != std::string::npos,
        "native FDM ABI rejection must explain the missing field/energy parity");
    std::printf("FDM FP32 sub-cell contract: PASS\n");
    return 0;
}
