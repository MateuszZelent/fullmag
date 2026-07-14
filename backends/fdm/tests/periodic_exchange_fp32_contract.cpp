/* Source-level guard for FP32 periodic exchange parity. */

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {
void check(bool condition, const char *message) {
    if (!condition) std::abort();
}

std::string read_file(const std::filesystem::path &path) {
    std::ifstream input(path);
    std::ostringstream content;
    content << input.rdbuf();
    return content.str();
}

std::filesystem::path repo_root() {
    const std::filesystem::path file(__FILE__);
    return file.parent_path().parent_path().parent_path().parent_path();
}
}

int main() {
    const auto source = read_file(
        repo_root() / "backends" / "fdm" / "gpu" / "cuda" / "interactions" / "exchange_fp32.cu");
    check(source.find("pbc_neighbor_fp32") != std::string::npos,
          "FP32 exchange must have a periodic-aware neighbor helper");
    check(source.find("periodic_x") != std::string::npos &&
              source.find("periodic_y") != std::string::npos &&
              source.find("periodic_z") != std::string::npos,
          "FP32 exchange must consume all resolved periodic axes");
    check(source.find("ctx.periodic_x, ctx.periodic_y, ctx.periodic_z") != std::string::npos,
          "FP32 exchange launch must pass context periodic axes");
    return 0;
}
