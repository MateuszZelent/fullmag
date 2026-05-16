/*
 * heun_step_contract.cpp - native FEM Heun step ownership contracts.
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

void heun_step_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string heun_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "heun_step.cpp");

    check(
        bridge.find("bool context_step_exchange_heun_mfem(") == std::string::npos,
        "Heun exchange step must not be defined in mfem_bridge.cpp");
    check(
        heun_step.find("bool context_step_exchange_heun_mfem(") != std::string::npos,
        "Heun exchange step must be defined in integrators/heun_step.cpp");
}

} // namespace

int main() {
    heun_step_is_owned_by_integrator_module();
    return 0;
}
