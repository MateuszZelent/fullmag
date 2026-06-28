/*
 * snapshot_contract.cpp - native FEM runtime snapshot ownership contracts.
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

void snapshot_stats_are_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string snapshot =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.cpp");
    const std::string snapshot_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.hpp");

    check(
        bridge.find("bool context_snapshot_stats_mfem(") == std::string::npos,
        "MFEM snapshot stats must not be defined in mfem_bridge.cpp");
    check(
        context_header.find("bool context_snapshot_stats_mfem(") == std::string::npos,
        "MFEM snapshot stats declaration must not live in context.hpp");
    check(
        snapshot.find("bool context_snapshot_stats_mfem(") != std::string::npos,
        "MFEM snapshot stats must be defined in runtime/snapshot.cpp");
    check(
        snapshot_header.find("Capture native FEM scalar statistics") != std::string::npos,
        "snapshot header must document scalar snapshot ownership");
}

void demag_phi_snapshot_contract_is_declared() {
    const std::filesystem::path root = fem_source_root();
    const std::string header =
        read_text_file(root.parent_path().parent_path() / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");

    check(
        header.find("FULLMAG_FEM_OBSERVABLE_DEMAG_PHI") != std::string::npos,
        "C ABI must declare a demag scalar-potential observable");
    check(
        api.find("FULLMAG_FEM_OBSERVABLE_DEMAG_PHI") != std::string::npos &&
            api.find("component_count = 1") != std::string::npos,
        "native snapshot API must expose demag phi as a scalar component payload");
    check(
        state_io.find("copy_demag_phi_observable_f64") != std::string::npos &&
            state_io.find("gf_potential") != std::string::npos,
        "state I/O must copy demag phi from the MFEM scalar-potential grid function");
}

} // namespace

int main() {
    snapshot_stats_are_owned_by_runtime_module();
    demag_phi_snapshot_contract_is_declared();
    return 0;
}
