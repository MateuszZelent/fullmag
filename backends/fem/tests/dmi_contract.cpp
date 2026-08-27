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
        workspace_header.find("DmiRuntimeState::workspace") != std::string::npos,
        "DMI workspace header must document runtime-state workspace ownership");
    check(
        workspace_header.find("Context::mfem_dmi_workspace") == std::string::npos,
        "DMI workspace header must not document flat Context workspace ownership");
    check(
        workspace_impl.find(workspace_getter) != std::string::npos,
        "DMI workspace getter must be defined in dmi_workspace.cpp");
    check(
        workspace_impl.find(destroy_symbol) != std::string::npos,
        "DMI workspace destroy helper must be defined in dmi_workspace.cpp");
}

void dmi_plan_fields_are_owned_by_dmi_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string dmi =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.cpp");
    const std::string dmi_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.hpp");

    check(
        context.find("ctx.dmi.interfacial_enabled = plan.has_interfacial_dmi") == std::string::npos,
        "Context must not own DMI plan flag import");
    check(
        context.find("plan.dmi_interface_normal") == std::string::npos,
        "Context must not own DMI interface-normal normalization");
    check(
        dmi.find("void initialize_dmi_plan_fields(") != std::string::npos,
        "DMI plan import must be defined in dmi.cpp");
    check(
        dmi_header.find("Initialize DMI plan fields and normalize the interface normal") !=
            std::string::npos,
        "DMI aggregate header must document plan-field initialization ownership");
    check(
        dmi_header.find("owns ABI plan import, runtime output storage, and") !=
            std::string::npos,
        "DMI aggregate header must document runtime-output ownership");
    check(
        dmi_header.find("does not assemble interfacial or bulk") !=
                std::string::npos &&
            dmi_header.find("residuals, project H_DMI, compute DMI energy") !=
                std::string::npos &&
            dmi_header.find("own element-loop scratch") !=
            std::string::npos,
        "DMI aggregate header must document its non-owning residual/energy/workspace boundary");
    check(
        dmi_header.find("dmi_interfacial.*") != std::string::npos,
        "DMI aggregate header must name the interfacial owner");
    check(
        dmi_header.find("dmi_bulk.*") != std::string::npos,
        "DMI aggregate header must name the bulk owner");
    check(
        dmi_header.find("dmi_workspace.*") != std::string::npos,
        "DMI aggregate header must name the workspace owner");
}

void dmi_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string dmi =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.cpp");
    const std::string interfacial = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "dmi_interfacial.cpp");
    const std::string bulk =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_bulk.cpp");
    const std::string workspace =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_workspace.cpp");

    check(
        dmi.find("DMI aggregate source contract") != std::string::npos,
        "DMI aggregate source file must document its source contract");
    check(
        dmi.find("does not assemble interfacial or bulk residuals") != std::string::npos,
        "DMI aggregate source file must document its non-owning residual boundary");
    check(
        interfacial.find("Interfacial DMI source contract") != std::string::npos,
        "interfacial DMI source file must document its source contract");
    check(
        interfacial.find("does not own bulk DMI") != std::string::npos,
        "interfacial DMI source file must document its non-owning bulk boundary");
    check(
        bulk.find("Bulk DMI source contract") != std::string::npos,
        "bulk DMI source file must document its source contract");
    check(
        bulk.find("does not own interfacial DMI") != std::string::npos,
        "bulk DMI source file must document its non-owning interfacial boundary");
    check(
        workspace.find("DMI workspace source contract") != std::string::npos,
        "DMI workspace source file must document its source contract");
    check(
        workspace.find("does not choose DMI energy density") != std::string::npos,
        "DMI workspace source file must document its non-owning physics boundary");
}

void dmi_leaf_headers_document_non_owning_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string interfacial_header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "dmi_interfacial.hpp");
    const std::string bulk_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_bulk.hpp");
    const std::string workspace_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_workspace.hpp");

    check(
        interfacial_header.find("does not own bulk/Bloch residual assembly, shared DMI scratch allocation, direct torque scaling, or effective-field composition") !=
            std::string::npos,
        "interfacial DMI header must document its non-owning bulk/scratch/composition boundary");
    check(
        bulk_header.find("does not own interfacial boundary tilt, shared DMI scratch allocation, direct torque scaling, or effective-field composition") !=
            std::string::npos,
        "bulk DMI header must document its non-owning interfacial/scratch/composition boundary");
    check(
        workspace_header.find("does not own interfacial or bulk DMI physics, field projection, energy accumulation, or effective-field composition") !=
            std::string::npos,
        "DMI workspace header must document its non-owning physics/projection/composition boundary");
}

void dmi_element_loops_are_parallelized_with_thread_local_residuals() {
    const std::filesystem::path root = fem_source_root();
    const std::string interfacial = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "dmi_interfacial.cpp");
    const std::string bulk =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_bulk.cpp");
    const std::string workspace_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_workspace.hpp");

    check(
        workspace_header.find("residual_xyz_by_thread") != std::string::npos,
        "DMI workspace must own reusable per-thread residual buffers");
    for (const std::string *source : {&interfacial, &bulk}) {
        check(
            source->find("#pragma omp parallel") != std::string::npos,
            "DMI element residual assembly must use an OpenMP parallel region");
        check(
            source->find("residual_xyz_by_thread") != std::string::npos,
            "DMI element residual assembly must accumulate into per-thread residual buffers");
        check(
            source->find("#pragma omp for") != std::string::npos,
            "DMI element residual assembly must distribute element work across threads");
        check(
            source->find("thread_energy") != std::string::npos,
            "DMI energy accumulation must use thread-local reductions");
    }
}

void dmi_runtime_state_is_owned_by_aggregate_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string dmi_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.hpp");

    check(
        dmi_header.find("struct DmiRuntimeState") != std::string::npos,
        "DMI runtime state must be declared by dmi.hpp");
    check(
        dmi_header.find("std::vector<double> h_interfacial_xyz") != std::string::npos,
        "DMI runtime state must own the interfacial H_DMI field buffer");
    check(
        dmi_header.find("std::vector<double> h_bulk_xyz") != std::string::npos,
        "DMI runtime state must own the bulk H_DMI field buffer");
    check(
        dmi_header.find("double energy_joules") != std::string::npos,
        "DMI runtime state must own the combined DMI energy diagnostic");
    check(
        dmi_header.find("bool interfacial_enabled") != std::string::npos,
        "DMI runtime state must own the interfacial DMI enable flag");
    check(
        dmi_header.find("double interfacial_D") != std::string::npos,
        "DMI runtime state must own the interfacial DMI constant");
    check(
        dmi_header.find("std::array<double, 3> interface_normal") != std::string::npos,
        "DMI runtime state must own the normalized interfacial normal");
    check(
        dmi_header.find("bool bulk_enabled") != std::string::npos,
        "DMI runtime state must own the bulk DMI enable flag");
    check(
        dmi_header.find("double bulk_D") != std::string::npos,
        "DMI runtime state must own the bulk DMI constant");
    check(
        dmi_header.find("DmiElementWorkspace *workspace") != std::string::npos,
        "DMI runtime state must own reusable MFEM element-loop scratch");
    check(
        context_header.find("DmiRuntimeState dmi") != std::string::npos,
        "Context must store DMI runtime output through the DMI owner");
    check(
        context_header.find("h_dmi_xyz") == std::string::npos,
        "Context must not own a flat interfacial DMI field buffer");
    check(
        context_header.find("h_bulk_dmi_xyz") == std::string::npos,
        "Context must not own a flat bulk DMI field buffer");
    check(
        context_header.find("last_dmi_energy_joules") == std::string::npos,
        "Context must not own flat DMI energy state");
    check(
        context_header.find("mfem_dmi_workspace") == std::string::npos,
        "Context must not own flat DMI workspace scratch");
    check(
        context_header.find("bool enable_dmi") == std::string::npos,
        "Context must not own a flat interfacial DMI enable flag");
    check(
        context_header.find("double dmi_D") == std::string::npos,
        "Context must not own a flat interfacial DMI constant");
    check(
        context_header.find("std::array<double, 3> dmi_n_hat") == std::string::npos,
        "Context must not own a flat DMI interface normal");
    check(
        context_header.find("bool enable_bulk_dmi") == std::string::npos,
        "Context must not own a flat bulk DMI enable flag");
    check(
        context_header.find("double bulk_dmi_D") == std::string::npos,
        "Context must not own a flat bulk DMI constant");
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

void make_context(fullmag::fem::Context &ctx) {
    ctx.mesh.n_nodes = 2;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
}

void disabled_interfacial_dmi_is_zero() {
    fullmag::fem::Context ctx;
    make_context(ctx);
    ctx.dmi.interfacial_enabled = false;
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
    fullmag::fem::Context ctx;
    make_context(ctx);
    ctx.dmi.bulk_enabled = false;
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
    fullmag::fem::Context ctx;
    make_context(ctx);
    ctx.dmi.interfacial_enabled = true;
    ctx.dmi.interfacial_D = 1.0e-3;
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
    fullmag::fem::Context ctx;
    make_context(ctx);
    ctx.dmi.bulk_enabled = true;
    ctx.dmi.bulk_D = 1.0e-3;
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

void dmi_plan_import_normalizes_interface_normal_and_defaults_zero() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan{};
    plan.has_interfacial_dmi = 1;
    plan.dmi_constant = 1.25e-3;
    plan.dmi_interface_normal[0] = 0.0;
    plan.dmi_interface_normal[1] = 0.0;
    plan.dmi_interface_normal[2] = 4.0;
    plan.has_bulk_dmi = 1;
    plan.bulk_dmi_constant = 2.5e-3;

    fullmag::fem::initialize_dmi_plan_fields(ctx, plan);

    check(ctx.dmi.interfacial_enabled, "interfacial DMI flag copied");
    check(ctx.dmi.interfacial_D == 1.25e-3, "interfacial DMI constant copied");
    check(ctx.dmi.bulk_enabled, "bulk DMI flag copied");
    check(ctx.dmi.bulk_D == 2.5e-3, "bulk DMI constant copied");
    check(ctx.dmi.interface_normal[0] == 0.0, "DMI normal x normalized");
    check(ctx.dmi.interface_normal[1] == 0.0, "DMI normal y normalized");
    check(ctx.dmi.interface_normal[2] == 1.0, "DMI normal z normalized");

    fullmag_fem_plan_desc zero_normal_plan{};
    fullmag::fem::initialize_dmi_plan_fields(ctx, zero_normal_plan);
    check(ctx.dmi.interface_normal[0] == 0.0, "zero DMI normal defaults x");
    check(ctx.dmi.interface_normal[1] == 0.0, "zero DMI normal defaults y");
    check(ctx.dmi.interface_normal[2] == 1.0, "zero DMI normal defaults z");
}

} // namespace

int main() {
    dmi_workspace_is_owned_by_workspace_module();
    dmi_plan_fields_are_owned_by_dmi_module();
    dmi_source_files_document_module_boundaries();
    dmi_leaf_headers_document_non_owning_boundaries();
    dmi_element_loops_are_parallelized_with_thread_local_residuals();
    dmi_runtime_state_is_owned_by_aggregate_module();
    bulk_dmi_is_owned_by_bulk_module();
    interfacial_dmi_is_owned_by_interfacial_module();
    disabled_interfacial_dmi_is_zero();
    disabled_bulk_dmi_is_zero();
    active_dmi_reports_mfem_requirement_without_stack();
    active_bulk_dmi_reports_mfem_requirement_without_stack();
    dmi_plan_import_normalizes_interface_normal_and_defaults_zero();
    return 0;
}
