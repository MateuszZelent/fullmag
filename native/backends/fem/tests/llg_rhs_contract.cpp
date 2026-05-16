/*
 * llg_rhs_contract.cpp - native FEM LLG RHS and AOS field-operation contracts.
 */

#include "cpu/mfem/integrators/llg_rhs.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_near(double actual, double expected, double tol, const char *msg) {
    if (std::fabs(actual - expected) > tol) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g\n",
            msg,
            expected,
            actual);
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

void llg_rhs_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string llg =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.cpp");

    const char *symbols[] = {
        "void normalize_aos_field(",
        "void llg_rhs_aos(",
        "void zero_non_magnetic_nodes_aos(",
    };
    for (const char *symbol : symbols) {
        check(
            bridge.find(symbol) == std::string::npos,
            "LLG RHS/AOS field helper must not be defined in mfem_bridge.cpp");
        check(
            llg.find(symbol) != std::string::npos,
            "LLG RHS/AOS field helper must be defined in llg_rhs.cpp");
    }
}

void llg_rhs_uses_llg_gilbert_form_and_nodewise_damping() {
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    const std::vector<double> h = {
        0.0, 0.0, 2.0,
        0.0, 0.0, 3.0,
    };
    const std::vector<double> alpha_field = {0.0, 1.0};
    std::vector<double> rhs;
    double max_rhs = 0.0;

    fullmag::fem::llg_rhs_aos(m, h, 10.0, 0.5, &alpha_field, rhs, max_rhs);

    check(rhs.size() == m.size(), "LLG RHS preserves AOS field size");
    check_near(rhs[0], 0.0, 1e-15, "node 0 rhs x");
    check_near(rhs[1], 20.0, 1e-15, "node 0 precession y");
    check_near(rhs[2], 0.0, 1e-15, "node 0 rhs z");
    check_near(rhs[3], -15.0, 1e-15, "node 1 damping x");
    check_near(rhs[4], 0.0, 1e-15, "node 1 rhs y");
    check_near(rhs[5], 15.0, 1e-15, "node 1 damping z");
    check_near(max_rhs, std::sqrt(450.0), 1e-14, "LLG RHS max norm");
}

void aos_helpers_normalize_and_mask_nodes() {
    std::vector<double> m = {
        3.0, 4.0, 0.0,
        0.0, 0.0, 0.0,
    };
    fullmag::fem::normalize_aos_field(m);
    check_near(m[0], 0.6, 1e-15, "normalized x");
    check_near(m[1], 0.8, 1e-15, "normalized y");
    check_near(m[2], 0.0, 1e-15, "normalized z");
    check_near(m[3], 0.0, 1e-15, "zero vector x unchanged");

    std::vector<double> field = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    fullmag::fem::zero_non_magnetic_nodes_aos(field, {1u, 0u});
    check_near(field[0], 1.0, 1e-15, "magnetic node x remains");
    check_near(field[3], 0.0, 1e-15, "nonmagnetic node x zeroed");
    check_near(field[4], 0.0, 1e-15, "nonmagnetic node y zeroed");
    check_near(field[5], 0.0, 1e-15, "nonmagnetic node z zeroed");
}

} // namespace

int main() {
    llg_rhs_is_owned_by_integrator_module();
    llg_rhs_uses_llg_gilbert_form_and_nodewise_damping();
    aos_helpers_normalize_and_mask_nodes();
    return 0;
}
