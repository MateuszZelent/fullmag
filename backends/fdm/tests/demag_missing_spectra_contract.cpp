/* Source-level fail-closed guard for native CUDA demag kernel ownership. */

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
        api.find("FDM CUDA demag requires validated Newell tensor spectra") != std::string::npos,
        "native FDM ABI must reject demag plans without validated spectra");
    std::printf("FDM demag missing-spectra contract: PASS\n");
    return 0;
}
