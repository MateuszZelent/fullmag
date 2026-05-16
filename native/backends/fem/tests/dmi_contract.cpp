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
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
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
    disabled_interfacial_dmi_is_zero();
    disabled_bulk_dmi_is_zero();
    active_dmi_reports_mfem_requirement_without_stack();
    active_bulk_dmi_reports_mfem_requirement_without_stack();
    return 0;
}
