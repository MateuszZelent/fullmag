/*
 * dmi_contract.cpp - native FEM DMI module contract tests.
 *
 * Full iDMI and bulk DMI field recovery requires the MFEM element-loop stack.
 * The local non-MFEM contract still verifies module ownership of disabled
 * behavior and explicit error reporting when DMI is requested without MFEM.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/dmi.hpp"

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

void dmi_workspace_is_owned_by_workspace_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string dmi =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.cpp");
    const std::string workspace_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_workspace.hpp");
    const std::string workspace_impl =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_workspace.cpp");

    const char *workspace_type = "struct DmiElementWorkspace";
    const char *workspace_getter = "DmiElementWorkspace *dmi_element_workspace(";
    const char *destroy_symbol = "void destroy_dmi_workspace(";

    check(
        dmi.find(workspace_type) == std::string::npos,
        "DMI element workspace type must not be defined in dmi.cpp");
    check(
        dmi.find(workspace_getter) == std::string::npos,
        "DMI workspace getter must not be defined in dmi.cpp");
    check(
        dmi.find(destroy_symbol) == std::string::npos,
        "DMI workspace destroy helper must not be defined in dmi.cpp");
    check(
        workspace_header.find(workspace_type) != std::string::npos,
        "DMI element workspace type must be declared in dmi_workspace.hpp");
    check(
        workspace_impl.find(workspace_getter) != std::string::npos,
        "DMI workspace getter must be defined in dmi_workspace.cpp");
    check(
        workspace_impl.find(destroy_symbol) != std::string::npos,
        "DMI workspace destroy helper must be defined in dmi_workspace.cpp");
}

void bulk_dmi_is_owned_by_bulk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string dmi =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.cpp");
    const std::string bulk =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_bulk.cpp");
    const std::string bulk_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_bulk.hpp");

    const char *bulk_symbol = "bool compute_bulk_dmi_field(";
    const char *bulk_residual_call = "dmi_accumulate_bulk_residual(";
    const char *bulk_error = "Bulk DMI computation requires MFEM stack";

    check(
        dmi.find(bulk_symbol) == std::string::npos,
        "bulk DMI compute entry point must not be defined in dmi.cpp");
    check(
        dmi.find(bulk_residual_call) == std::string::npos,
        "bulk DMI residual assembly must not be defined in dmi.cpp");
    check(
        dmi.find(bulk_error) == std::string::npos,
        "bulk DMI no-MFEM fallback must not be defined in dmi.cpp");
    check(
        bulk.find(bulk_symbol) != std::string::npos,
        "bulk DMI compute entry point must be defined in dmi_bulk.cpp");
    check(
        bulk.find(bulk_residual_call) != std::string::npos,
        "bulk DMI residual assembly must be defined in dmi_bulk.cpp");
    check(
        bulk.find(bulk_error) != std::string::npos,
        "bulk DMI no-MFEM fallback must be defined in dmi_bulk.cpp");
    check(
        bulk_header.find("Compute bulk/Bloch DMI effective field") != std::string::npos,
        "bulk DMI module header must document its physical contract");
}

void interfacial_dmi_is_owned_by_interfacial_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string dmi =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.cpp");
    const std::string interfacial = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "dmi_interfacial.cpp");
    const std::string interfacial_header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "dmi_interfacial.hpp");

    const char *interfacial_symbol = "bool compute_interfacial_dmi_field(";
    const char *interfacial_residual_call = "dmi_accumulate_interfacial_residual(";
    const char *interfacial_error = "DMI computation requires MFEM stack";

    check(
        dmi.find(interfacial_symbol) == std::string::npos,
        "interfacial DMI compute entry point must not be defined in dmi.cpp");
    check(
        dmi.find(interfacial_residual_call) == std::string::npos,
        "interfacial DMI residual assembly must not be defined in dmi.cpp");
    check(
        dmi.find(interfacial_error) == std::string::npos,
        "interfacial DMI no-MFEM fallback must not be defined in dmi.cpp");
    check(
        interfacial.find(interfacial_symbol) != std::string::npos,
        "interfacial DMI compute entry point must be defined in dmi_interfacial.cpp");
    check(
        interfacial.find(interfacial_residual_call) != std::string::npos,
        "interfacial DMI residual assembly must be defined in dmi_interfacial.cpp");
    check(
        interfacial.find(interfacial_error) != std::string::npos,
        "interfacial DMI no-MFEM fallback must be defined in dmi_interfacial.cpp");
    check(
        interfacial_header.find("Compute interfacial DMI effective field") != std::string::npos,
        "interfacial DMI module header must document its physical contract");
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
    ctx.material.saturation_magnetisation = 800e3;
    return ctx;
}

void disabled_interfacial_dmi_is_zero() {
    auto ctx = make_context();
    ctx.enable_dmi = false;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::vector<double> h_dmi;
    double energy = 5.0;
    std::string error;

    check(
        fullmag::fem::compute_interfacial_dmi_field(ctx, m, h_dmi, &energy, error),
        "disabled interfacial DMI succeeds");
    check(h_dmi.size() == m.size(), "disabled interfacial DMI field size");
    check_zero_field(h_dmi, "disabled interfacial DMI field");
    check(energy == 0.0, "disabled interfacial DMI energy");
    check(error.empty(), "disabled interfacial DMI leaves error empty");
}

void disabled_bulk_dmi_is_zero() {
    auto ctx = make_context();
    ctx.enable_bulk_dmi = false;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::vector<double> h_dmi;
    double energy = 5.0;
    std::string error;

    check(
        fullmag::fem::compute_bulk_dmi_field(ctx, m, h_dmi, &energy, error),
        "disabled bulk DMI succeeds");
    check(h_dmi.size() == m.size(), "disabled bulk DMI field size");
    check_zero_field(h_dmi, "disabled bulk DMI field");
    check(energy == 0.0, "disabled bulk DMI energy");
    check(error.empty(), "disabled bulk DMI leaves error empty");
}

void active_dmi_reports_mfem_requirement_without_stack() {
    auto ctx = make_context();
    ctx.enable_dmi = true;
    ctx.dmi_D = 1.0e-3;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::vector<double> h_dmi;
    double energy = 0.0;
    std::string error;

#if FULLMAG_HAS_MFEM_STACK
    (void) ctx;
    (void) m;
    (void) h_dmi;
    (void) energy;
    (void) error;
#else
    check(
        !fullmag::fem::compute_interfacial_dmi_field(ctx, m, h_dmi, &energy, error),
        "active interfacial DMI requires MFEM");
    check(error.find("MFEM stack") != std::string::npos, "active interfacial DMI error");
#endif
}

void active_bulk_dmi_reports_mfem_requirement_without_stack() {
    auto ctx = make_context();
    ctx.enable_bulk_dmi = true;
    ctx.bulk_dmi_D = 1.0e-3;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::vector<double> h_dmi;
    double energy = 0.0;
    std::string error;

#if FULLMAG_HAS_MFEM_STACK
    (void) ctx;
    (void) m;
    (void) h_dmi;
    (void) energy;
    (void) error;
#else
    check(
        !fullmag::fem::compute_bulk_dmi_field(ctx, m, h_dmi, &energy, error),
        "active bulk DMI requires MFEM");
    check(error.find("MFEM stack") != std::string::npos, "active bulk DMI error");
#endif
}

} // namespace

int main() {
    dmi_workspace_is_owned_by_workspace_module();
    bulk_dmi_is_owned_by_bulk_module();
    interfacial_dmi_is_owned_by_interfacial_module();
    disabled_interfacial_dmi_is_zero();
    disabled_bulk_dmi_is_zero();
    active_dmi_reports_mfem_requirement_without_stack();
    active_bulk_dmi_reports_mfem_requirement_without_stack();
    return 0;
}
