/* Source-level guard: every single-grid CUDA LLG RHS must freeze inactive cells. */

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

void check_rhs_mask(const std::filesystem::path &path, const char *zero_literal) {
    const std::string source = read_file(path);
    check(
        source.find("if (stt.active_mask && stt.active_mask[idx] == 0)") != std::string::npos,
        "LLG RHS must branch on the uploaded active mask");
    const std::string zero_assignments = std::string("out_x[idx] = ") + zero_literal
        + ";\n        out_y[idx] = " + zero_literal
        + ";\n        out_z[idx] = " + zero_literal + ";\n        return;";
    check(
        source.find(zero_assignments) != std::string::npos,
        "inactive LLG RHS must be exactly zero before torque contributions");
}

} // namespace

int main() {
    const std::filesystem::path this_file(__FILE__);
    const auto fdm_root = this_file.parent_path().parent_path();
    const std::string context = read_file(fdm_root / "include/context.hpp");
    check(
        context.find("const uint8_t *active_mask = nullptr;") != std::string::npos
            && context.find("p.active_mask = ctx.active_mask;") != std::string::npos,
        "Context active mask must be propagated into every CUDA LLG RHS launch");
    check_rhs_mask(fdm_root / "gpu/cuda/integrators/llg_fp64.cu", "0.0");
    check_rhs_mask(fdm_root / "gpu/cuda/integrators/llg_fp32.cu", "0.0f");
    std::printf("FDM inactive torque-mask contract: PASS\n");
    return 0;
}
