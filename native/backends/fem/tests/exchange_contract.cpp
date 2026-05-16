/*
 * exchange_contract.cpp - native FEM exchange module contract tests.
 *
 * The full exchange operator requires MFEM assembly. The local non-MFEM
 * contract still pins module ownership for disabled behavior and explicit
 * environment errors when exchange is requested without the MFEM stack.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/exchange.hpp"

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

void exchange_runtime_wrapper_is_owned_by_exchange_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string exchange =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.cpp");
    const char *symbol = "bool context_refresh_exchange_field_mfem(";

    check(
        bridge.find(symbol) == std::string::npos,
        "exchange runtime wrapper must not be defined in mfem_bridge.cpp");
    check(
        exchange.find(symbol) != std::string::npos,
        "exchange runtime wrapper must be defined in exchange.cpp");
}

void check_zero_field(const std::vector<double> &field, const char *label) {
    for (double value : field) {
        if (value != 0.0) {
            std::fprintf(stderr, "FAIL: %s is not zero\n", label);
            std::exit(1);
        }
    }
}

fullmag::fem::Context make_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.material.exchange_stiffness = 1.3e-11;
    ctx.material.saturation_magnetisation = 800e3;
    return ctx;
}

#if !FULLMAG_HAS_MFEM_STACK
void disabled_exchange_is_zero_without_mfem_stack() {
    auto ctx = make_context();
    ctx.enable_exchange = false;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::vector<double> h_ex;
    std::vector<double> h_eff;
    double energy = 5.0;
    std::string error;

    check(
        fullmag::fem::compute_exchange_for_magnetization(
            ctx, m, h_ex, &h_eff, &energy, false, error),
        "disabled exchange succeeds without MFEM");
    check(h_ex.size() == m.size(), "disabled exchange field size");
    check(h_eff.size() == m.size(), "disabled exchange H_eff size");
    check_zero_field(h_ex, "disabled exchange field");
    check_zero_field(h_eff, "disabled exchange H_eff");
    check(energy == 0.0, "disabled exchange energy");
    check(error.empty(), "disabled exchange leaves error empty");
}

void active_exchange_reports_mfem_requirement_without_stack() {
    auto ctx = make_context();
    ctx.enable_exchange = true;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::vector<double> h_ex;
    double energy = 0.0;
    std::string error;

    check(
        !fullmag::fem::compute_exchange_for_magnetization(
            ctx, m, h_ex, nullptr, &energy, false, error),
        "active exchange requires MFEM");
    check(error.find("MFEM stack") != std::string::npos, "active exchange error");
}
#endif

} // namespace

int main() {
    exchange_runtime_wrapper_is_owned_by_exchange_module();
#if !FULLMAG_HAS_MFEM_STACK
    disabled_exchange_is_zero_without_mfem_stack();
    active_exchange_reports_mfem_requirement_without_stack();
#endif
    return 0;
}
