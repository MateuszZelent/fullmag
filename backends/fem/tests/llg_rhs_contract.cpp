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
    std::string text = buffer.str();
    for (std::size_t offset = 0; (offset = text.find("\r\n", offset)) != std::string::npos;) {
        text.erase(offset, 1);
    }
    return text;
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::filesystem::path repo_root() {
    return fem_source_root().parent_path().parent_path();
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

    fullmag::fem::llg_rhs_aos(m, h, 10.0, 0.5, &alpha_field, true, rhs, max_rhs);

    check(rhs.size() == m.size(), "LLG RHS preserves AOS field size");
    check_near(rhs[0], 0.0, 1e-15, "node 0 rhs x");
    check_near(rhs[1], 20.0, 1e-15, "node 0 precession y");
    check_near(rhs[2], 0.0, 1e-15, "node 0 rhs z");
    check_near(rhs[3], -15.0, 1e-15, "node 1 damping x");
    check_near(rhs[4], 0.0, 1e-15, "node 1 rhs y");
    check_near(rhs[5], 15.0, 1e-15, "node 1 damping z");
    check_near(max_rhs, std::sqrt(450.0), 1e-14, "LLG RHS max norm");
}

double zeeman_like_energy(const std::vector<double> &m, const std::vector<double> &h) {
    double energy = 0.0;
    for (size_t i = 0; i < m.size(); i += 3u) {
        energy -= m[i + 0] * h[i + 0] + m[i + 1] * h[i + 1] + m[i + 2] * h[i + 2];
    }
    return energy;
}

void damping_only_macrospin_energy_decreases_under_relaxation() {
    std::vector<double> m = {1.0, 0.0, 0.0};
    const std::vector<double> h = {0.0, 0.0, 1.0};
    std::vector<double> rhs;
    double max_rhs = 0.0;

    const double initial_energy = zeeman_like_energy(m, h);
    fullmag::fem::llg_rhs_aos(m, h, 10.0, 0.5, nullptr, true, rhs, max_rhs);

    const double dt = 1.0e-3;
    for (size_t i = 0; i < m.size(); ++i) {
        m[i] += dt * rhs[i];
    }
    fullmag::fem::normalize_aos_field(m);
    const double relaxed_energy = zeeman_like_energy(m, h);

    check(
        relaxed_energy < initial_energy,
        "damping-only macrospin relaxation must decrease Zeeman-like energy");
    check(max_rhs > 0.0, "damping-only macrospin fixture must exercise LLG RHS");
}

void llg_rhs_can_disable_precession_for_overdamped_relaxation() {
    const std::vector<double> m = {1.0, 0.0, 0.0};
    const std::vector<double> h = {0.0, 0.0, 1.0};
    std::vector<double> precessional_rhs;
    std::vector<double> pure_damping_rhs;
    double precessional_max = 0.0;
    double pure_damping_max = 0.0;

    fullmag::fem::llg_rhs_aos(
        m,
        h,
        10.0,
        0.5,
        nullptr,
        true,
        precessional_rhs,
        precessional_max);
    fullmag::fem::llg_rhs_aos(
        m,
        h,
        10.0,
        0.5,
        nullptr,
        false,
        pure_damping_rhs,
        pure_damping_max);

    check_near(precessional_rhs[0], 0.0, 1e-15, "precessional rhs x");
    check_near(precessional_rhs[1], 8.0, 1e-15, "precessional rhs y");
    check_near(precessional_rhs[2], 4.0, 1e-15, "precessional rhs z");
    check_near(pure_damping_rhs[0], 0.0, 1e-15, "pure damping rhs x");
    check_near(pure_damping_rhs[1], 0.0, 1e-15, "pure damping disables precession y");
    check_near(pure_damping_rhs[2], 4.0, 1e-15, "pure damping keeps damping z");
    check_near(precessional_max, std::sqrt(80.0), 1e-14, "precessional max norm");
    check_near(pure_damping_max, 4.0, 1e-14, "pure damping max norm");
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

void gamma_mu0_convention_is_pinned_by_docs_and_material_validation() {
    const std::filesystem::path root = repo_root();
    const std::string units = read_text_file(root / "docs" / "physics" / "units.md");
    const std::string llg_docs =
        read_text_file(root / "docs" / "physics" / "llg_conventions.md");
    const std::string material_fields =
        read_text_file(fem_source_root() / "core" / "fem_material_fields.cpp");
    const std::string rhs_header =
        read_text_file(
            fem_source_root() / "cpu" / "mfem" / "integrators" / "llg_rhs.hpp");

    check(
        units.find("`gamma_mu0` | `gyromagnetic_ratio` in native FEM material descriptors | `m/(A s)` | reduced gyromagnetic constant already including `mu0`") !=
            std::string::npos,
        "units doc must identify legacy gyromagnetic_ratio as reduced gamma_mu0");
    check(
        units.find("It must not be the electron gyromagnetic ratio in\n`rad/(T s)`") !=
            std::string::npos,
        "units doc must reject electron gyromagnetic ratio units");
    check(
        llg_docs.find("`gyromagnetic_ratio` carries the reduced\n`gamma_mu0` in `m/(A s)`") !=
            std::string::npos,
        "LLG conventions doc must pin gyromagnetic_ratio to gamma_mu0");
    check(
        llg_docs.find("missing runtime\ninclude directory") == std::string::npos &&
            llg_docs.find(".fullmag/runtimes/fem-gpu-host/include") == std::string::npos,
        "LLG conventions doc must not carry the stale missing-runtime-include blocker");
    check(
        llg_docs.find("Full active MFEM-stack numerical fixture qualification remains separate") !=
            std::string::npos,
        "LLG conventions doc must keep active MFEM numerical fixture qualification separate");
    check(
        material_fields.find("native FEM expects gamma_mu0 in m/(A s), not gamma in rad/(T s)") !=
            std::string::npos,
        "material validation must report the gamma_mu0 convention in its error");
    check(
        rhs_header.find("configured `gamma_mu0`-style factor used by the native FEM runtime") !=
            std::string::npos,
        "LLG RHS header must document that the RHS consumes gamma_mu0-style scaling");
    check(
        llg_docs.find("`precession_enabled = false` selects pure\n"
                      "damping relaxation") != std::string::npos,
        "LLG conventions doc must document the native pure-damping relaxation mode");
    check(
        rhs_header.find("precession_enabled") != std::string::npos,
        "LLG RHS header must expose the native precession mode contract");
}

} // namespace

int main() {
    llg_rhs_is_owned_by_integrator_module();
    llg_rhs_uses_llg_gilbert_form_and_nodewise_damping();
    damping_only_macrospin_energy_decreases_under_relaxation();
    llg_rhs_can_disable_precession_for_overdamped_relaxation();
    aos_helpers_normalize_and_mask_nodes();
    gamma_mu0_convention_is_pinned_by_docs_and_material_validation();
    return 0;
}
