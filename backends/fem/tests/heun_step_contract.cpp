/*
 * heun_step_contract.cpp - native FEM Heun step removal contracts.
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

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void legacy_heun_stepper_is_removed() {
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.cpp");
    const std::filesystem::path heun_step_cpp =
        root / "cpu" / "mfem" / "integrators" / "heun_step.cpp";
    const std::filesystem::path heun_step_hpp =
        root / "cpu" / "mfem" / "integrators" / "heun_step.hpp";

    check(
        !std::filesystem::exists(heun_step_cpp),
        "legacy Heun step implementation file must be removed");
    check(
        !std::filesystem::exists(heun_step_hpp),
        "legacy Heun step header must be removed");
    check(
        api.find("heun_step.hpp") == std::string::npos &&
            api.find("context_step_exchange_heun_mfem") == std::string::npos,
        "C ABI facade must not include or call the legacy Heun stepper");
    check(
        cmake.find("heun_step.cpp") == std::string::npos,
        "legacy Heun step implementation must not be compiled");
    check(
        rk_explicit.find("case FULLMAG_FEM_INTEGRATOR_HEUN:      return heun_tableau();") !=
            std::string::npos,
        "Heun integrator must route through the generic explicit RK tableau");
}

} // namespace

int main() {
    legacy_heun_stepper_is_removed();
    return 0;
}
