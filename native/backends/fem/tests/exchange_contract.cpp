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
        context.find("ctx.enable_exchange = plan.enable_exchange != 0;") ==
            std::string::npos,
        "context_from_plan must delegate exchange enable import to exchange.cpp");
    check(
        context.find("plan.use_consistent_mass") == std::string::npos,
        "context_from_plan must delegate exchange consistent-mass import to exchange.cpp");
    check(
        context.find("consistent_mass_requested") == std::string::npos,
        "context_from_plan must not keep local exchange consistent-mass state");
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
        field_header.find("Compute the exchange field for a magnetization state") !=
            std::string::npos,
        "exchange field header must document its physical contract");
    check(
        runtime_header.find("Refresh the current Context exchange/effective-field buffers") !=
            std::string::npos,
        "exchange runtime header must document its contract");
    check(
        fallback_header.find("no-MFEM exchange fallback") != std::string::npos,
        "exchange fallback header must document its contract");
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

void exchange_plan_fields_are_imported_by_aggregate() {
    fullmag::fem::Context ctx;

    fullmag_fem_plan_desc plan{};
    plan.enable_exchange = 1;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(ctx.enable_exchange, "exchange plan import enables exchange");

    plan.enable_exchange = 0;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(!ctx.enable_exchange, "exchange plan import disables exchange");

#if FULLMAG_HAS_MFEM_STACK
    plan.use_consistent_mass = 1;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(ctx.use_consistent_mass, "exchange plan import enables consistent-mass projection");

    plan.use_consistent_mass = 0;
    fullmag::fem::initialize_exchange_plan_fields(ctx, plan);
    check(!ctx.use_consistent_mass, "exchange plan import disables consistent-mass projection");
#endif
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
    exchange_responsibilities_are_owned_by_separate_modules();
    exchange_mass_projection_is_owned_by_mass_module();
    exchange_legacy_gpu_upload_is_owned_by_upload_module();
    exchange_plan_fields_are_imported_by_aggregate();
#if !FULLMAG_HAS_MFEM_STACK
    disabled_exchange_is_zero_without_mfem_stack();
    active_exchange_reports_mfem_requirement_without_stack();
#endif
    return 0;
}
