/* Source-level guard for H_bulk-DMI = -2D curl(m)/(mu0 Ms). */

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

void check_bulk_dmi_sign(const std::filesystem::path &path) {
    const std::string source = read_file(path);
    check(
        source.find("-= dmi_pf * D_bulk * (dmz_dy - dmy_dz)") != std::string::npos
            || source.find("-= dmi_pf * dmi_d_bulk * (dmz_dy - dmy_dz)")
                    != std::string::npos,
        "bulk-DMI x field must be negative curl(m)");
    check(
        source.find("-= dmi_pf * D_bulk * (dmx_dz - dmz_dx)") != std::string::npos
            || source.find("-= dmi_pf * dmi_d_bulk * (dmx_dz - dmz_dx)")
                    != std::string::npos,
        "bulk-DMI y field must be negative curl(m)");
    check(
        source.find("-= dmi_pf * D_bulk * (dmy_dx - dmx_dy)") != std::string::npos
            || source.find("-= dmi_pf * dmi_d_bulk * (dmy_dx - dmx_dy)")
                    != std::string::npos,
        "bulk-DMI z field must be negative curl(m)");
}

} // namespace

int main() {
    const std::filesystem::path this_file(__FILE__);
    const auto fdm_root = this_file.parent_path().parent_path();
    check_bulk_dmi_sign(fdm_root / "gpu/cuda/interactions/demag_fp64.cu");
    check_bulk_dmi_sign(fdm_root / "gpu/cuda/interactions/demag_fp32.cu");
    check_bulk_dmi_sign(fdm_root / "gpu/cuda/interactions/multilayer_dmi.cu");
    check_bulk_dmi_sign(fdm_root / "gpu/cuda/integrators/multilayer_heun.cu");
    check_bulk_dmi_sign(fdm_root / "gpu/cuda/integrators/multilayer_explicit_rk.cu");
    std::printf("FDM bulk-DMI sign contract: PASS\n");
    return 0;
}
