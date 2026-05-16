/*
 * mfem_context_contract.cpp - native FEM MFEM context lifecycle ownership.
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

void mfem_context_lifecycle_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string runtime =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.cpp");

    check(
        bridge.find("bool context_initialize_mfem(") == std::string::npos,
        "MFEM context initialization must not be defined in mfem_bridge.cpp");
    check(
        bridge.find("void context_destroy_mfem(") == std::string::npos,
        "MFEM context destruction must not be defined in mfem_bridge.cpp");
    check(
        bridge.find("bool context_upload_mfem_exchange_to_gpu_state(") == std::string::npos,
        "MFEM legacy sparse upload wrapper must not be defined in mfem_bridge.cpp");
    check(
        runtime.find("bool context_initialize_mfem(") != std::string::npos,
        "MFEM context initialization must be defined in runtime/mfem_context.cpp");
    check(
        runtime.find("void context_destroy_mfem(") != std::string::npos,
        "MFEM context destruction must be defined in runtime/mfem_context.cpp");
    check(
        runtime.find("bool context_upload_mfem_exchange_to_gpu_state(") != std::string::npos,
        "MFEM legacy sparse upload wrapper must be defined in runtime/mfem_context.cpp");
}

} // namespace

int main() {
    mfem_context_lifecycle_is_owned_by_runtime_module();
    return 0;
}
