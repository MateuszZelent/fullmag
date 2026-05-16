/*
 * interaction_docs_contract.cpp - docs/physics coverage for native FEM interactions.
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

std::filesystem::path repo_root() {
    const std::filesystem::path this_file(__FILE__);
    const std::filesystem::path fem_root = this_file.is_absolute()
        ? this_file.parent_path().parent_path()
        : std::filesystem::current_path() / this_file.parent_path().parent_path();
    return fem_root.parent_path().parent_path().parent_path();
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: missing FEM docs file %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

void required_interaction_docs_exist_and_name_their_implementation() {
    const std::filesystem::path physics = repo_root() / "docs" / "physics";
    const char *docs[] = {
        "fem_exchange.md",
        "fem_demag_poisson.md",
        "fem_demag_fem_bem.md",
        "fem_dmi.md",
        "fem_thermal.md",
        "fem_thermal_brown.md",
        "fem_stt.md",
        "fem_oersted.md",
        "fem_magnetoelastic.md",
        "fem_zeeman.md",
        "fem_anisotropy_uniaxial.md",
        "fem_anisotropy_cubic.md",
    };

    for (const char *doc : docs) {
        const std::string text = read_text_file(physics / doc);
        check(text.find("Implementation:") != std::string::npos, "interaction doc names implementation path");
        check(text.find("Test:") != std::string::npos, "interaction doc names test path");
    }
}

void required_release_gate_docs_exist() {
    const std::filesystem::path root = repo_root();
    const char *docs[] = {
        "docs/physics/units.md",
        "docs/physics/llg_conventions.md",
        "docs/physics/fem_exchange.md",
        "docs/physics/fem_demag_poisson.md",
        "docs/physics/fem_dmi.md",
        "docs/physics/fem_thermal.md",
        "docs/physics/fem_stt.md",
        "docs/validation/fem_cpu_validation_matrix.md",
        "docs/performance/fem_cpu_baselines.md",
    };

    for (const char *doc : docs) {
        const std::string text = read_text_file(root / doc);
        check(!text.empty(), "release gate doc is not empty");
    }
}

} // namespace

int main() {
    required_interaction_docs_exist_and_name_their_implementation();
    required_release_gate_docs_exist();
    return 0;
}
