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
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string effective =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.cpp");
    const std::string effective_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.hpp");

    check(
        bridge.find("compute_effective_fields_for_magnetization_impl(") == std::string::npos,
        "effective-field composition implementation must not be defined in mfem_bridge.cpp");
    check(
        effective.find("bool compute_effective_fields_for_magnetization(") != std::string::npos,
        "effective-field composition must be defined in effective_field.cpp");
    check(
        context_header.find("bool compute_effective_fields_for_magnetization(") ==
            std::string::npos,
        "effective-field composition declaration must not live in context.hpp");
    check(
        effective_header.find("bool compute_effective_fields_for_magnetization(") !=
            std::string::npos,
        "effective-field composition declaration must live in effective_field.hpp");
    check(
        context.find("plan.eager_initial_effective_field") == std::string::npos,
        "context_from_plan must not own eager initial effective-field plan policy");
    check(
        context.find("context_refresh_exchange_field_mfem(ctx, error)") == std::string::npos,
        "context_from_plan must not call exchange refresh directly for eager initial fields");
    check(
        effective.find("bool refresh_initial_effective_field_from_plan(") != std::string::npos,
        "eager initial effective-field refresh policy must be defined in effective_field.cpp");
    check(
        effective.find("plan.eager_initial_effective_field") != std::string::npos,
        "effective_field.cpp must own the eager initial effective-field plan flag");
    check(
        effective.find("!ctx.exchange.enabled && !ctx.demag.enabled") == std::string::npos,
        "eager initial effective-field refresh must not skip local-only field terms");
    check(
        effective_header.find("Refresh initial native FEM effective-field buffers") !=
            std::string::npos,
        "effective_field header must document eager initial refresh ownership");
    check(
        effective_header.find("does not assemble exchange operators, implement demag solvers, define individual interaction physics, own state I/O, or publish step metrics") !=
            std::string::npos,
        "effective_field header must document its non-owning module boundary");
    check(
        effective_header.find("exchange") != std::string::npos &&
            effective_header.find("demag") != std::string::npos &&
            effective_header.find("Zeeman") != std::string::npos,
        "effective_field header must name representative interaction owners");
}

void effective_field_runtime_state_is_owned_by_composition_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string effective_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.hpp");

    check(
        effective_header.find("struct EffectiveFieldRuntimeState") != std::string::npos,
        "effective-field runtime state must be declared by effective_field.hpp");
    check(
        effective_header.find("std::vector<double> h_xyz") != std::string::npos,
        "effective-field runtime state must own the composed H_eff field buffer");
    check(
        effective_header.find("std::vector<double> h_visual_xyz") != std::string::npos,
        "effective-field runtime state must own the visual H_eff field buffer");
    check(
        context_header.find("EffectiveFieldRuntimeState effective_field") !=
            std::string::npos,
        "Context must store effective-field runtime output through the composition owner");
    check(
        context_header.find("std::vector<double> h_eff_xyz") == std::string::npos,
        "Context must not own a flat effective-field buffer");
    check(
        context_header.find("std::vector<double> h_eff_visual_xyz") == std::string::npos,
        "Context must not own a flat visual effective-field buffer");
}

void effective_field_source_file_documents_composition_boundary() {
    const std::filesystem::path root = fem_source_root();
    const std::string effective =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.cpp");

    check(
        effective.find("Effective-field composition source contract") != std::string::npos,
        "effective-field source file must document its source contract");
    check(
        effective.find("does not assemble exchange operators, implement demag solvers, define individual interaction physics, own state I/O, or publish step metrics") != std::string::npos,
        "effective-field source file must document its non-owning module boundary");
}

void field_or_torque_gate_covers_all_runtime_terms() {
    fullmag::fem::Context ctx;
    ctx.exchange.enabled = false;
    check(!fullmag::fem::has_any_field_or_direct_torque_term(ctx), "empty context has no RHS terms");

    ctx.exchange.enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "exchange counts as RHS term");
    ctx.exchange.enabled = false;

    ctx.demag.enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "demag counts as RHS term");
    ctx.demag.enabled = false;

    ctx.zeeman.has_external_field = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Zeeman field counts as RHS term");
    ctx.zeeman.has_external_field = false;

    ctx.anisotropy.uniaxial_enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "anisotropy counts as RHS term");
    ctx.anisotropy.uniaxial_enabled = false;

    ctx.anisotropy.cubic_enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "cubic anisotropy counts as RHS term");
    ctx.anisotropy.cubic_enabled = false;

    ctx.dmi.interfacial_enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "interfacial DMI counts as RHS term");
    ctx.dmi.interfacial_enabled = false;

    ctx.dmi.bulk_enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "bulk DMI counts as RHS term");
    ctx.dmi.bulk_enabled = false;

    ctx.oersted.has_cylinder = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Oersted cylinder counts as RHS term");
    ctx.oersted.has_cylinder = false;

    ctx.oersted.has_explicit_field = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Oersted nodal field counts as RHS term");
    ctx.oersted.has_explicit_field = false;

    ctx.magnetoelastic.enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "magnetoelastic counts as RHS term");
    ctx.magnetoelastic.enabled = false;

    ctx.stt.zhang_li_enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Zhang-Li STT counts as direct torque term");
    ctx.stt.zhang_li_enabled = false;

    ctx.stt.slonczewski_enabled = true;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "Slonczewski STT counts as direct torque term");
    ctx.stt.slonczewski_enabled = false;

    ctx.thermal_brown.temperature = 300.0;
    check(fullmag::fem::has_any_field_or_direct_torque_term(ctx), "thermal field counts as RHS term");
    ctx.thermal_brown.temperature = 0.0;

    check(!fullmag::fem::has_any_field_or_direct_torque_term(ctx), "cleared context has no RHS terms");
}

void disabled_local_field_buffers_are_zeroed_before_composition() {
    const std::filesystem::path root = fem_source_root();
    const std::string effective =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.cpp");

    check(
        effective.find("ctx.anisotropy.h_uniaxial_xyz.assign(m_xyz.size(), 0.0)") !=
            std::string::npos,
        "disabled uniaxial anisotropy buffer must be zeroed before H_eff composition");
    check(
        effective.find("ctx.dmi.h_interfacial_xyz.assign(m_xyz.size(), 0.0)") != std::string::npos,
        "disabled interfacial DMI buffer must be zeroed before H_eff composition");
    check(
        effective.find("ctx.anisotropy.h_cubic_xyz.assign(m_xyz.size(), 0.0)") != std::string::npos,
        "disabled cubic anisotropy buffer must be zeroed before H_eff composition");
    check(
        effective.find("ctx.dmi.h_bulk_xyz.assign(m_xyz.size(), 0.0)") != std::string::npos,
        "disabled bulk DMI buffer must be zeroed before readback/visual reuse");
}

} // namespace

int main() {
    effective_field_composition_is_owned_by_interaction_module();
    effective_field_runtime_state_is_owned_by_composition_module();
    effective_field_source_file_documents_composition_boundary();
    field_or_torque_gate_covers_all_runtime_terms();
    disabled_local_field_buffers_are_zeroed_before_composition();
    return 0;
}
