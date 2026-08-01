/* Source-level contract for conservative partial-cell energy reductions. */

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

std::string function_body(const std::string &source, const std::string &name) {
    const auto start = source.find(name);
    check(start != std::string::npos, name.c_str());
    const auto next = source.find("template <typename Scalar>", start + name.size());
    check(next != std::string::npos, "next CUDA reduction kernel must exist");
    return source.substr(start, next - start);
}

} // namespace

int main() {
    const std::filesystem::path this_file(__FILE__);
    const auto fdm_root = this_file.parent_path().parent_path();
    const std::string reductions =
        read_file(fdm_root / "gpu/cuda/runtime/reductions_fp64.cu");

    for (const auto *kernel : {
             "external_energy_blocks_kernel(",
             "uniaxial_anisotropy_energy_blocks_kernel(",
             "cubic_anisotropy_energy_blocks_kernel(",
         }) {
        const std::string body = function_body(reductions, kernel);
        check(body.find("const double *volume_fraction") != std::string::npos,
              "each conservative local-energy kernel must receive volume_fraction");
        check(body.find("phi_i") != std::string::npos,
              "each conservative local-energy kernel must derive a per-cell phi_i weight");
    }

    check(reductions.find("ctx.volume_fraction") != std::string::npos,
          "native reductions must pass the plan boundary volume fractions to local energies");

    std::puts("FDM partial-cell local-energy source contract: PASS");
    return 0;
}
