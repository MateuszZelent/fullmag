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

void exchange_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.hpp");
    const std::string operator_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_operator.cpp");
    const std::string operator_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_operator.hpp");
    const std::string field_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_field.hpp");
    const std::string runtime_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_runtime.cpp");
    const std::string runtime_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_runtime.hpp");
    const std::string fallback_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_fallback.cpp");
    const std::string fallback_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_fallback.hpp");

    const char *plan_symbol = "void initialize_exchange_plan_fields(";
    const char *init_symbol = "bool initialize_exchange_operator_mfem(";
    const char *compute_symbol = "bool compute_exchange_for_magnetization(";
    const char *refresh_symbol = "bool context_refresh_exchange_field_mfem(";
    const char *fallback_error = "Native FEM exchange requires the MFEM stack";

    check(
        bridge.find(refresh_symbol) == std::string::npos,
        "exchange runtime wrapper must not be defined in mfem_bridge.cpp");
    check(
        aggregate.find(init_symbol) == std::string::npos,
        "exchange operator assembly must not be defined in exchange.cpp");
    check(
        aggregate.find(compute_symbol) == std::string::npos,
        "exchange field compute must not be defined in exchange.cpp");
    check(
        aggregate.find(refresh_symbol) == std::string::npos,
        "exchange runtime wrapper must not be defined in exchange.cpp");
    check(
        aggregate.find(fallback_error) == std::string::npos,
        "exchange no-MFEM fallback must not be defined in exchange.cpp");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "exchange plan import must be defined in exchange.cpp");
    check(
        aggregate_header.find("Initialize native FEM exchange plan fields") !=
            std::string::npos,
        "exchange aggregate header must document plan import ownership");
    check(
        aggregate_header.find("consistent-mass exchange projection policy") !=
            std::string::npos,
        "exchange aggregate header must document consistent-mass plan ownership");
    check(
        aggregate_header.find("does not assemble operators") != std::string::npos &&
            aggregate_header.find("compute") != std::string::npos &&
            aggregate_header.find("H_ex") != std::string::npos &&
            aggregate_header.find("refresh runtime fields") != std::string::npos &&
            aggregate_header.find("handle fallback") != std::string::npos &&
            aggregate_header.find("project mass") != std::string::npos &&
            aggregate_header.find("upload GPU") != std::string::npos &&
            aggregate_header.find("state") != std::string::npos,
        "exchange aggregate header must document its non-owning module boundary");
    check(
        aggregate_header.find("runtime output") != std::string::npos &&
            aggregate_header.find("storage") != std::string::npos,
        "exchange aggregate header must document runtime-output ownership");
    check(
        aggregate_header.find("exchange_operator.*") != std::string::npos,
        "exchange aggregate header must name the operator owner");
    check(
        aggregate_header.find("exchange_field.*") != std::string::npos,
        "exchange aggregate header must name the field owner");
    check(
        aggregate_header.find("exchange_runtime.*") != std::string::npos,
        "exchange aggregate header must name the runtime refresh owner");
    check(
        aggregate_header.find("exchange_mass_projection.*") != std::string::npos,
        "exchange aggregate header must name the mass-projection owner");
    check(
        aggregate_header.find("exchange_legacy_gpu_upload.*") != std::string::npos,
        "exchange aggregate header must name the legacy GPU upload owner");
    check(
        context.find("ctx.enable_exchange = plan.enable_exchange != 0;") ==
            std::string::npos &&
        context.find("ctx.exchange.enabled = plan.enable_exchange != 0;") ==
            std::string::npos,
        "context_from_plan must delegate exchange enable import to exchange.cpp");
    check(
        context.find("plan.use_consistent_mass") == std::string::npos,
        "context_from_plan must delegate exchange consistent-mass import to exchange.cpp");
    check(
        context.find("consistent_mass_requested") == std::string::npos,
        "context_from_plan must not keep local exchange consistent-mass state");
    check(
        aggregate.find("ctx.exchange.enabled = plan.enable_exchange != 0;") !=
            std::string::npos,
        "exchange plan import must own the exchange enable flag");
    check(
        aggregate.find("plan.use_consistent_mass") != std::string::npos,
        "exchange plan import must own the consistent-mass exchange projection flag");
    check(
        operator_module.find(init_symbol) != std::string::npos,
        "exchange operator assembly must be defined in exchange_operator.cpp");
    check(
        field_module.find(compute_symbol) != std::string::npos,
        "exchange field compute must be defined in exchange_field.cpp");
    check(
        runtime_module.find(refresh_symbol) != std::string::npos,
        "exchange runtime wrapper must be defined in exchange_runtime.cpp");
    check(
        context_header.find(refresh_symbol) == std::string::npos,
        "exchange runtime declaration must not live in context.hpp");
    check(
        fallback_module.find(fallback_error) != std::string::npos,
        "exchange no-MFEM fallback must be defined in exchange_fallback.cpp");
    check(
        operator_header.find("Initialize the native FEM exchange operator") !=
            std::string::npos,
        "exchange operator header must document its physical contract");
    check(
        operator_header.find("does not compute H_ex, project mass, refresh runtime fields, handle no-MFEM fallback, or upload GPU state") !=
            std::string::npos,
        "exchange operator header must document its non-owning field/runtime boundary");
    check(
        field_header.find("Compute the exchange field for a magnetization state") !=
            std::string::npos,
        "exchange field header must document its physical contract");
    check(
        runtime_header.find("Refresh the current Context exchange/effective-field buffers") !=
            std::string::npos,
        "exchange runtime header must document its contract");
    check(
        runtime_header.find("does not assemble exchange operators, project exchange mass, own no-MFEM fallback, or upload legacy GPU exchange state") !=
            std::string::npos,
        "exchange runtime header must document its non-owning operator/fallback/upload boundary");
    check(
        fallback_header.find("no-MFEM exchange fallback") != std::string::npos,
        "exchange fallback header must document its contract");
    check(
        fallback_header.find("does not assemble MFEM operators, compute H_ex, project mass, refresh runtime fields, or claim active exchange execution") !=
            std::string::npos,
        "exchange fallback header must document its non-owning active-MFEM boundary");
}

void exchange_runtime_state_is_owned_by_aggregate_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string exchange_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.hpp");

    check(
        exchange_header.find("struct ExchangeRuntimeState") != std::string::npos,
        "exchange runtime state must be declared by exchange.hpp");
    check(
        exchange_header.find("bool enabled") != std::string::npos,
        "exchange runtime state must own exchange enablement");
    check(
        exchange_header.find("std::vector<double> h_xyz") != std::string::npos,
        "exchange runtime state must own the H_ex field buffer");
    check(
        context_header.find("ExchangeRuntimeState exchange") != std::string::npos,
        "Context must store exchange runtime output through the exchange owner");
    check(
        context_header.find("std::vector<double> h_ex_xyz") == std::string::npos,
        "Context must not own a flat exchange field buffer");
    check(
        context_header.find("bool enable_exchange") == std::string::npos,
        "Context must not own flat exchange enablement");
    check(
        exchange_header.find("struct ExchangeMfemRuntimeState") != std::string::npos,
        "exchange runtime state must declare the MFEM exchange workspace owner");
    check(
        exchange_header.find("bool use_consistent_mass") != std::string::npos &&
            exchange_header.find("std::vector<double> h_x") != std::string::npos &&
            exchange_header.find("std::vector<double> h_y") != std::string::npos &&
            exchange_header.find("std::vector<double> h_z") != std::string::npos &&
            exchange_header.find("mfem::BilinearForm *exchange_form") != std::string::npos &&
            exchange_header.find("mfem::BilinearForm *mass_form") != std::string::npos &&
            exchange_header.find("mfem::Vector *mass_ones") != std::string::npos &&
            exchange_header.find("mfem::Vector *mass_lumped") != std::string::npos &&
            exchange_header.find("mfem::Vector *inv_lumped_mass") != std::string::npos &&
            exchange_header.find("mfem::Vector *tmp_vec") != std::string::npos &&
            exchange_header.find("mfem::Vector *out_vec") != std::string::npos &&
            exchange_header.find("bool ready") != std::string::npos,
        "exchange MFEM runtime state must own forms, mass vectors, component buffers, readiness, and consistent-mass policy");
    check(
        exchange_header.find("void *exchange_form") == std::string::npos &&
            exchange_header.find("void *mass_form") == std::string::npos &&
            exchange_header.find("void *mass_ones") == std::string::npos &&
            exchange_header.find("void *mass_lumped") == std::string::npos &&
            exchange_header.find("void *inv_lumped_mass") == std::string::npos &&
            exchange_header.find("void *tmp_vec") == std::string::npos &&
            exchange_header.find("void *out_vec") == std::string::npos,
        "exchange MFEM runtime state must use typed MFEM pointers, not void pointers");
    check(
        exchange_header.find("ExchangeMfemRuntimeState mfem{}") != std::string::npos,
        "exchange runtime state must store MFEM exchange workspace under exchange.mfem");
    for (const char *flat_exchange_field : {
             "std::vector<double> mfem_h_ex_x",
             "std::vector<double> mfem_h_ex_y",
             "std::vector<double> mfem_h_ex_z",
             "std::vector<double> mfem_exchange_tmp",
             "void *mfem_exchange_form",
             "void *mfem_mass_form",
             "void *mfem_mass_ones",
             "void *mfem_mass_lumped",
             "void *mfem_inv_lumped_mass",
             "void *mfem_exchange_tmp_vec",
             "void *mfem_exchange_out_vec",
             "bool mfem_exchange_ready",
             "bool use_consistent_mass",
         }) {
        check(
            context_header.find(flat_exchange_field) == std::string::npos,
            "Context must not own flat MFEM exchange runtime workspace fields");
    }
}

void exchange_mass_projection_is_owned_by_mass_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string exchange =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.cpp");
    const std::string mass_projection = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "exchange_mass_projection.cpp");

    const char *lumping_symbol = "void prepare_exchange_mass_lumping(";
    const char *projection_symbol = "bool apply_exchange_component_mass_projection(";
    const char *consistent_mass_marker = "mfem::CGSolver cg_solver";

    check(
        exchange.find(lumping_symbol) == std::string::npos,
        "exchange mass lumping must not be defined in exchange.cpp");
    check(
        exchange.find(projection_symbol) == std::string::npos,
        "exchange component mass projection must not be defined in exchange.cpp");
    check(
        exchange.find(consistent_mass_marker) == std::string::npos,
        "consistent-mass projection solve must not be defined in exchange.cpp");
    check(
        mass_projection.find(lumping_symbol) != std::string::npos,
        "exchange mass lumping must be defined in exchange_mass_projection.cpp");
    check(
        mass_projection.find(projection_symbol) != std::string::npos,
        "exchange component mass projection must be defined in exchange_mass_projection.cpp");
    check(
        mass_projection.find(consistent_mass_marker) != std::string::npos,
        "consistent-mass projection solve must be defined in exchange_mass_projection.cpp");
}

void exchange_legacy_gpu_upload_is_owned_by_upload_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string exchange =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.cpp");
    const std::string upload = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "exchange_legacy_gpu_upload.cpp");

    const char *upload_symbol = "bool upload_legacy_sparse_exchange_to_gpu_state(";
    const char *gpu_upload_call = "gpu_state_upload_exchange_legacy_sparse(";
    const char *csr_validation = "legacy sparse exchange CSR row offsets do not match nnz";

    check(
        exchange.find(upload_symbol) == std::string::npos,
        "legacy sparse exchange GPU upload must not be defined in exchange.cpp");
    check(
        exchange.find(gpu_upload_call) == std::string::npos,
        "legacy sparse exchange GPU upload call must not be in exchange.cpp");
    check(
        exchange.find(csr_validation) == std::string::npos,
        "legacy sparse exchange CSR validation must not be in exchange.cpp");
    check(
        upload.find(upload_symbol) != std::string::npos,
        "legacy sparse exchange GPU upload must be defined in exchange_legacy_gpu_upload.cpp");
    check(
        upload.find(gpu_upload_call) != std::string::npos,
        "legacy sparse exchange GPU upload call must be in exchange_legacy_gpu_upload.cpp");
    check(
        upload.find(csr_validation) != std::string::npos,
        "legacy sparse exchange CSR validation must be in exchange_legacy_gpu_upload.cpp");
}

void exchange_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.cpp");
    const std::string operator_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_operator.cpp");
    const std::string field_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_field.cpp");
    const std::string runtime_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_runtime.cpp");
    const std::string fallback_module =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_fallback.cpp");
    const std::string mass_projection =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange_mass_projection.cpp");
    const std::string gpu_upload = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "exchange_legacy_gpu_upload.cpp");

    check(
        aggregate.find("Exchange aggregate source contract") != std::string::npos,
        "exchange aggregate source file must document its source contract");
    check(
        aggregate.find("does not assemble operators, compute H_ex, refresh runtime fields, handle fallback, project mass, or upload GPU state") != std::string::npos,
        "exchange aggregate source file must document its non-owning module boundary");
    check(
        operator_module.find("Exchange operator source contract") != std::string::npos,
        "exchange operator source file must document its source contract");
    check(
        operator_module.find("does not compute H_ex, project mass, refresh runtime fields, or upload GPU state") != std::string::npos,
        "exchange operator source file must document its non-owning field/runtime boundary");
    check(
        field_module.find("Exchange field-compute source contract") != std::string::npos,
        "exchange field source file must document its source contract");
    check(
        field_module.find("does not assemble exchange operators or own runtime refresh") != std::string::npos,
        "exchange field source file must document its non-owning operator/runtime boundary");
    check(
        runtime_module.find("Exchange runtime refresh source contract") != std::string::npos,
        "exchange runtime source file must document its source contract");
    check(
        runtime_module.find("does not assemble operators or compute exchange components directly") != std::string::npos,
        "exchange runtime source file must document its non-owning compute boundary");
    check(
        fallback_module.find("Exchange no-MFEM fallback source contract") != std::string::npos,
        "exchange fallback source file must document its source contract");
    check(
        fallback_module.find("does not assemble MFEM operators or claim active exchange execution") != std::string::npos,
        "exchange fallback source file must document its non-owning active-MFEM boundary");
    check(
        mass_projection.find("Exchange mass-projection source contract") != std::string::npos,
        "exchange mass-projection source file must document its source contract");
    check(
        mass_projection.find("does not assemble exchange operators or upload GPU state") != std::string::npos,
        "exchange mass-projection source file must document its non-owning operator/upload boundary");
    check(
        gpu_upload.find("Exchange legacy GPU upload source contract") != std::string::npos,
        "exchange legacy GPU upload source file must document its source contract");
    check(
        gpu_upload.find("does not assemble exchange operators or compute H_ex") != std::string::npos,
        "exchange legacy GPU upload source file must document its non-owning operator/field boundary");
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
    ctx.mesh.n_nodes = 2;
    ctx.material_fields.material.exchange_stiffness = 1.3e-11;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    return ctx;
}

void exchange_plan_fields_are_imported_by_aggregate() {
    fullmag::fem::Context ctx;

    fullmag_fem_plan_desc plan{};
    plan.enable_exchange = 1;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(ctx.exchange.enabled, "exchange plan import enables exchange");

    plan.enable_exchange = 0;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(!ctx.exchange.enabled, "exchange plan import disables exchange");

#if FULLMAG_HAS_MFEM_STACK
    plan.use_consistent_mass = 1;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(
        ctx.exchange.mfem.use_consistent_mass,
        "exchange plan import enables consistent-mass projection");

    plan.use_consistent_mass = 0;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(
        !ctx.exchange.mfem.use_consistent_mass,
        "exchange plan import disables consistent-mass projection");
#endif
}

#if !FULLMAG_HAS_MFEM_STACK
void disabled_exchange_is_zero_without_mfem_stack() {
    auto ctx = make_context();
    ctx.exchange.enabled = false;
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
    ctx.exchange.enabled = true;
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
    exchange_responsibilities_are_owned_by_separate_modules();
    exchange_runtime_state_is_owned_by_aggregate_module();
    exchange_mass_projection_is_owned_by_mass_module();
    exchange_legacy_gpu_upload_is_owned_by_upload_module();
    exchange_source_files_document_module_boundaries();
    exchange_plan_fields_are_imported_by_aggregate();
#if !FULLMAG_HAS_MFEM_STACK
    disabled_exchange_is_zero_without_mfem_stack();
    active_exchange_reports_mfem_requirement_without_stack();
#endif
    return 0;
}
