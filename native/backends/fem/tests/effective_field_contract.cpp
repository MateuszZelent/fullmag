/*
 * effective_field_contract.cpp - native FEM field/direct-torque gate contracts.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"

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

void effective_field_composition_is_owned_by_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string effective =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.cpp");

    check(
        bridge.find("compute_effective_fields_for_magnetization_impl(") == std::string::npos,
        "effective-field composition implementation must not be defined in mfem_bridge.cpp");
    check(
        effective.find("bool compute_effective_fields_for_magnetization(") != std::string::npos,
        "effective-field composition must be defined in effective_field.cpp");
}

void field_or_torque_gate_covers_all_runtime_terms() {
    fullmag::fem::Context ctx;
    ctx.enable_exchange = false;
    check(!fullmag::fem::has_any_field_or_direct_torque_term(ctx), "empty context has no RHS terms");

    ctx.enable_exchange = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "exchange counts as RHS term");
    ctx.enable_exchange = false;

    ctx.enable_demag = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "demag counts as RHS term");
    ctx.enable_demag = false;

    ctx.has_external_field = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Zeeman field counts as RHS term");
    ctx.has_external_field = false;

    ctx.enable_anisotropy = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "anisotropy counts as RHS term");
    ctx.enable_anisotropy = false;

    ctx.enable_cubic_anisotropy = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "cubic anisotropy counts as RHS term");
    ctx.enable_cubic_anisotropy = false;

    ctx.enable_dmi = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "interfacial DMI counts as RHS term");
    ctx.enable_dmi = false;

    ctx.enable_bulk_dmi = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "bulk DMI counts as RHS term");
    ctx.enable_bulk_dmi = false;

    ctx.has_oersted_cylinder = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Oersted cylinder counts as RHS term");
    ctx.has_oersted_cylinder = false;

    ctx.has_oersted_field = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Oersted nodal field counts as RHS term");
    ctx.has_oersted_field = false;

    ctx.enable_magnetoelastic = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "magnetoelastic counts as RHS term");
    ctx.enable_magnetoelastic = false;

    ctx.has_zhang_li_stt = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Zhang-Li STT counts as direct torque term");
    ctx.has_zhang_li_stt = false;

    ctx.has_slonczewski_stt = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Slonczewski STT counts as direct torque term");
    ctx.has_slonczewski_stt = false;

    ctx.temperature = 300.0;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "thermal field counts as RHS term");
    ctx.temperature = 0.0;

    check(!fullmag::fem::has_any_field_or_direct_torque_term(ctx), "cleared context has no RHS terms");
}

} // namespace

int main() {
    effective_field_composition_is_owned_by_interaction_module();
    field_or_torque_gate_covers_all_runtime_terms();
    return 0;
}
