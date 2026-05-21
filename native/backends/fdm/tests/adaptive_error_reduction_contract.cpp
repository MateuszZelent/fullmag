/*
 * adaptive_error_reduction_contract.cpp - native FDM adaptive-step reduction contract.
 *
 * Adaptive RK23/DP45 kernels must not download the whole per-cell error buffer
 * to the host.  They may copy the final reduced scalar, but the max reduction
 * itself must stay on the device-side reduction path.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fdm_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void adaptive_error_reductions_stay_device_side() {
    const std::filesystem::path root = fdm_source_root();
    const std::string reductions = read_text_file(root / "src" / "reductions_fp64.cu");
    const std::string dp45_fp64 = read_text_file(root / "src" / "llg_dp45_fp64.cu");
    const std::string dp45_fp32 = read_text_file(root / "src" / "llg_dp45_fp32.cu");
    const std::string rk23_fp64 = read_text_file(root / "src" / "llg_rk23_fp64.cu");
    const std::string rk23_fp32 = read_text_file(root / "src" / "llg_rk23_fp32.cu");

    check(
        reductions.find("double reduce_max_scalar_sqrt(") != std::string::npos,
        "FDM reductions module must expose a shared device-side scalar max-sqrt reduction");

    const std::string adaptive_sources = dp45_fp64 + dp45_fp32 + rk23_fp64 + rk23_fp32;
    check(
        adaptive_sources.find("std::vector<double> host_err") == std::string::npos,
        "adaptive RK23/DP45 steps must not allocate host_err for per-cell errors");
    check(
        adaptive_sources.find("host_err.data()") == std::string::npos,
        "adaptive RK23/DP45 steps must not download the whole error buffer to host_err");
    check(
        adaptive_sources.find("reduce_max_scalar_sqrt(ctx, ctx.reduction_scratch") !=
            std::string::npos,
        "adaptive RK23/DP45 steps must call the shared device-side scalar error reduction");
}

} // namespace

int main() {
    adaptive_error_reductions_stay_device_side();
    std::printf("adaptive error reduction contract: PASS\n");
    return 0;
}
