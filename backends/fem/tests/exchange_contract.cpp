/*
 * exchange_contract.cpp - native FEM exchange module contract tests.
 *
 * The full exchange operator requires MFEM assembly. The local non-MFEM
 * contract still pins module ownership for disabled behavior and explicit
 * environment errors when exchange is requested without the MFEM stack.
 */

#include "context.hpp"
#include "core/fem_material_runtime.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/exchange_mass_projection.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

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

std::filesystem::path repo_root() {
    return fem_source_root().parent_path().parent_path();
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
            exchange_header.find("mfem::CGSolver *consistent_mass_solver") != std::string::npos &&
            exchange_header.find("bool ready") != std::string::npos,
        "exchange MFEM runtime state must own forms, mass vectors, component buffers, consistent-mass solver, readiness, and consistent-mass policy");
    check(
        exchange_header.find("void *exchange_form") == std::string::npos &&
            exchange_header.find("void *mass_form") == std::string::npos &&
            exchange_header.find("void *mass_ones") == std::string::npos &&
            exchange_header.find("void *mass_lumped") == std::string::npos &&
            exchange_header.find("void *inv_lumped_mass") == std::string::npos &&
            exchange_header.find("void *tmp_vec") == std::string::npos &&
            exchange_header.find("void *out_vec") == std::string::npos &&
            exchange_header.find("void *consistent_mass_solver") == std::string::npos,
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
    const char *consistent_mass_marker = "consistent_mass_solver";

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
    check(
        mass_projection.find("new mfem::CGSolver()") != std::string::npos,
        "consistent-mass projection must allocate the reusable CG solver lazily");
    check(
        mass_projection.find("SetOperator(mass_form)") != std::string::npos,
        "consistent-mass projection must bind the mass operator once when creating the solver");
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
        mass_projection.find("including Ms scaling") != std::string::npos,
        "exchange mass-projection source file must document Ms scaling ownership");
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

#if FULLMAG_HAS_MFEM_STACK
class TestElementwiseScalarCoefficient final : public mfem::Coefficient {
public:
    explicit TestElementwiseScalarCoefficient(const std::vector<double> &values)
        : values_(values)
    {
    }

    double Eval(mfem::ElementTransformation &T, const mfem::IntegrationPoint &) override
    {
        const int element = T.ElementNo;
        check(
            element >= 0 && static_cast<size_t>(element) < values_.size(),
            "elementwise test coefficient element index must be in range");
        return values_[static_cast<size_t>(element)];
    }

private:
    const std::vector<double> &values_;
};

enum class AdapterCoefficientKind {
    ms,
    a,
};

class TestAdapterBackedElementwiseCoefficient final : public mfem::Coefficient {
public:
    TestAdapterBackedElementwiseCoefficient(
        const fullmag::fem::FemMaterialRuntimeAdapter &runtime,
        AdapterCoefficientKind kind)
        : runtime_(runtime), kind_(kind)
    {
    }

    double Eval(mfem::ElementTransformation &T, const mfem::IntegrationPoint &) override
    {
        const int element = T.ElementNo;
        check(element >= 0, "adapter-backed test coefficient requires an element ordinal");
        const std::size_t ordinal = static_cast<std::size_t>(element);
        const auto &realization = runtime_.realization();
        const auto &active = realization.active_element_ordinals();
        if (std::find(active.begin(), active.end(), ordinal) == active.end()) {
            return 0.0;
        }
        return kind_ == AdapterCoefficientKind::a
            ? realization.a_j_per_m(ordinal)
            : realization.ms_a_per_m(ordinal);
    }

private:
    const fullmag::fem::FemMaterialRuntimeAdapter &runtime_;
    AdapterCoefficientKind kind_;
};

double exchange_energy(
    mfem::BilinearForm &exchange_form,
    const mfem::GridFunction &magnetization)
{
    mfem::Vector residual(magnetization.Size());
    exchange_form.Mult(magnetization, residual);
    return magnetization * residual;
}

void check_close(double actual, double expected, double tolerance, const char *message)
{
    if (!std::isfinite(actual) || std::abs(actual - expected) > tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s (actual=%.17g expected=%.17g tolerance=%.17g)\n",
            message,
            actual,
            expected,
            tolerance);
        std::exit(1);
    }
}

mfem::Mesh single_exchange_cell(mfem::Geometry::Type geometry)
{
    if (geometry == mfem::Geometry::PRISM) {
        mfem::Mesh mesh(3, 6, 1, 0, 3);
        const double vertices[][3] = {
            {0, 0, 0}, {1, 0, 0}, {0, 1, 0},
            {0, 0, 1}, {1, 0, 1}, {0, 1, 1},
        };
        for (const auto &vertex : vertices) mesh.AddVertex(vertex);
        const int nodes[] = {0, 1, 2, 3, 4, 5};
        mesh.AddWedge(nodes, 7);
        mesh.FinalizeTopology();
        mesh.Finalize(false, true);
        return mesh;
    }
    if (geometry == mfem::Geometry::PYRAMID) {
        mfem::Mesh mesh(3, 5, 1, 0, 3);
        const double vertices[][3] = {
            {0, 0, 0}, {1, 0, 0}, {1, 1, 0}, {0, 1, 0}, {0.5, 0.5, 1},
        };
        for (const auto &vertex : vertices) mesh.AddVertex(vertex);
        const int nodes[] = {0, 1, 2, 3, 4};
        mesh.AddPyramid(nodes, 7);
        mesh.FinalizeTopology();
        mesh.Finalize(false, true);
        return mesh;
    }
    mfem::Mesh mesh(3, 4, 1, 0, 3);
    const double vertices[][3] = {
        {0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1},
    };
    for (const auto &vertex : vertices) mesh.AddVertex(vertex);
    const int nodes[] = {0, 1, 2, 3};
    mesh.AddTet(nodes, 7);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    return mesh;
}

mfem::Mesh conforming_exchange_prism_pyramid_tet()
{
    mfem::Mesh mesh(3, 8, 3, 0, 3);
    const double vertices[][3] = {
        {0, 0, 0}, {1, 0, 0}, {0, 1, 0},
        {0, 0, 1}, {1, 0, 1}, {0, 1, 1},
        {0.5, -1, 0.5}, {1.5, -1, 0.5},
    };
    for (const auto &vertex : vertices) mesh.AddVertex(vertex);
    const int prism[] = {0, 1, 2, 3, 4, 5};
    const int pyramid[] = {0, 1, 4, 3, 6};
    const int tet[] = {1, 4, 6, 7};
    mesh.AddWedge(prism, 7);
    mesh.AddPyramid(pyramid, 8);
    mesh.AddTet(tet, 8);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    return mesh;
}

mfem::Mesh independent_all_tet_prism_reference()
{
    mfem::Mesh mesh(3, 6, 3, 0, 3);
    const double vertices[][3] = {
        {0, 0, 0}, {1, 0, 0}, {0, 1, 0},
        {0, 0, 1}, {1, 0, 1}, {0, 1, 1},
    };
    for (const auto &vertex : vertices) mesh.AddVertex(vertex);
    const int tet0[] = {0, 1, 2, 3};
    const int tet1[] = {1, 2, 3, 4};
    const int tet2[] = {2, 3, 4, 5};
    mesh.AddTet(tet0, 7);
    mesh.AddTet(tet1, 7);
    mesh.AddTet(tet2, 7);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    return mesh;
}

void initialize_production_exchange(
    fullmag::fem::Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::Coefficient &a_coeff,
    mfem::Coefficient &ms_coeff,
    const std::vector<uint8_t> &magnetic_elements)
{
    ctx.exchange.enabled = true;
    ctx.mesh.magnetic_element_mask = magnetic_elements;
    std::string error;
    check(
        fullmag::fem::initialize_exchange_operator_mfem(
            ctx, mesh, fes, a_coeff, ms_coeff, error),
        error.c_str());
}

void check_production_csr_contract(
    mfem::BilinearForm &exchange_form,
    const char *constant_message,
    const char *symmetry_message,
    const char *psd_message)
{
    const int ndofs = exchange_form.FESpace()->GetNDofs();
    mfem::Vector constant(ndofs);
    mfem::Vector first(ndofs);
    mfem::Vector second(ndofs);
    mfem::Vector image(ndofs);
    constant = 1.0;
    for (int i = 0; i < ndofs; ++i) {
        first[i] = std::sin(static_cast<double>(i + 1));
        second[i] = 0.25 + 0.17 * static_cast<double>(i) - 0.03 * i * i;
    }
    exchange_form.Mult(constant, image);
    check(image.Norml2() < 1.0e-11, constant_message);

    mfem::Vector first_image(ndofs);
    mfem::Vector second_image(ndofs);
    exchange_form.Mult(first, first_image);
    exchange_form.Mult(second, second_image);
    check_close(first * second_image, second * first_image, 1.0e-11, symmetry_message);
    check(first * first_image >= -1.0e-11, psd_message);
    check(second * second_image >= -1.0e-11, psd_message);
}

void check_projection_contracts(
    fullmag::fem::Context &ctx,
    mfem::FiniteElementSpace &fes,
    mfem::BilinearForm &exchange_form,
    mfem::BilinearForm &ms_mass_form,
    mfem::GridFunction &ms_field,
    mfem::GridFunction &field,
    mfem::GridFunction &direction)
{
    constexpr double mu0 = 1.2566370614359172953850573533118e-6;
    constexpr double epsilon = 1.0e-6;
    mfem::GridFunction plus(field);
    mfem::GridFunction minus(field);
    plus.Add(epsilon, direction);
    minus.Add(-epsilon, direction);
    const double finite_difference =
        (exchange_energy(exchange_form, plus) - exchange_energy(exchange_form, minus)) /
        (2.0 * epsilon);

    for (bool consistent : {false, true}) {
        mfem::Vector tmp(fes.GetNDofs());
        mfem::Vector h_component(fes.GetNDofs());
        std::vector<double> h_host;
        double energy = 0.0;
        check(
            fullmag::fem::apply_exchange_component_mass_projection(
                &ctx,
                false,
                exchange_form,
                field,
                ms_field,
                *ctx.exchange.mfem.inv_lumped_mass,
                ms_mass_form,
                consistent,
                tmp,
                h_component,
                h_host,
                &energy),
            "production mixed-P1 exchange mass projection must succeed");
        for (double value : h_host) {
            check(std::isfinite(value), "production mixed-P1 exchange field must be finite");
        }
        if (consistent) {
            check(
                ctx.exchange.mfem.consistent_mass_solver != nullptr &&
                    ctx.exchange.mfem.consistent_mass_solver->GetConverged(),
                "production mixed-P1 consistent-mass projection must converge");
        }
        double field_derivative = 0.0;
        if (consistent) {
            mfem::Vector weighted_h(fes.GetNDofs());
            ms_mass_form.Mult(h_component, weighted_h);
            field_derivative = -mu0 * (direction * weighted_h);
        } else {
            const auto &weights = ctx.integration_weights.mfem_lumped_mass;
            for (int i = 0; i < fes.GetNDofs(); ++i) {
                field_derivative -= mu0 * direction[i] * ms_field[i] *
                    weights[static_cast<size_t>(i)] * h_component[i];
            }
        }
        const double scale = std::max(
            1.0,
            std::max(std::abs(finite_difference), std::abs(field_derivative)));
        check_close(
            field_derivative,
            finite_difference,
            1.0e-8 * scale,
            "production mixed-P1 exchange projection must satisfy the energy derivative");
        check_close(
            energy,
            exchange_energy(exchange_form, field),
            1.0e-11 * std::max(1.0, std::abs(energy)),
            "production mixed-P1 exchange projection must preserve energy");
    }
}

void production_exchange_supports_each_mixed_p1_cell_family()
{
    constexpr double a_value = 1.7;
    constexpr double ms_value = 4.0;
    struct Case {
        mfem::Geometry::Type geometry;
        double volume;
    };
    const Case cases[] = {
        {mfem::Geometry::PRISM, 0.5},
        {mfem::Geometry::PYRAMID, 1.0 / 3.0},
        {mfem::Geometry::TETRAHEDRON, 1.0 / 6.0},
    };
    for (const auto &item : cases) {
        mfem::Mesh mesh = single_exchange_cell(item.geometry);
        mfem::H1_FECollection fec(1, 3);
        mfem::FiniteElementSpace fes(&mesh, &fec);
        mfem::ConstantCoefficient a_coeff(a_value);
        mfem::ConstantCoefficient ms_coeff(ms_value);
        fullmag::fem::Context ctx;
        initialize_production_exchange(ctx, mesh, fes, a_coeff, ms_coeff, {1u});

        auto &exchange_form = *ctx.exchange.mfem.exchange_form;
        auto &mass_form = *ctx.exchange.mfem.mass_form;
        check_production_csr_contract(
            exchange_form,
            "production mixed-P1 exchange must keep the constant nullspace",
            "production mixed-P1 exchange CSR must remain symmetric after canonicalization",
            "production mixed-P1 exchange CSR must remain PSD after canonicalization");

        double mass_sum = 0.0;
        for (double mass : ctx.integration_weights.mfem_lumped_mass) {
            check(
                std::isfinite(mass) && mass >= 0.0,
                "production mixed-P1 magnetic mass row sums must be finite and nonnegative");
            mass_sum += mass;
        }
        check_close(
            mass_sum,
            item.volume,
            1.0e-12,
            "production mixed-P1 magnetic mass row sums must conserve cell volume");

        mfem::GridFunction field(&fes);
        mfem::GridFunction direction(&fes);
        mfem::GridFunction ms_field(&fes);
        mfem::FunctionCoefficient linear(
            [](const mfem::Vector &x) { return x[0] + 2.0 * x[1] - 3.0 * x[2]; });
        mfem::FunctionCoefficient probe(
            [](const mfem::Vector &x) { return 0.3 - 0.2 * x[0] + 0.4 * x[1] + 0.1 * x[2]; });
        field.ProjectCoefficient(linear);
        direction.ProjectCoefficient(probe);
        ms_field.ProjectCoefficient(ms_coeff);
        check_close(
            exchange_energy(exchange_form, field),
            a_value * 14.0 * item.volume,
            1.0e-10,
            "production mixed-P1 exchange must reproduce the analytic linear-field energy");
        check_projection_contracts(
            ctx, fes, exchange_form, mass_form, ms_field, field, direction);

        mfem::GridFunction constant(&fes);
        constant = 1.0;
        for (bool consistent : {false, true}) {
            mfem::Vector tmp(fes.GetNDofs());
            mfem::Vector h_component(fes.GetNDofs());
            std::vector<double> h_host;
            double constant_energy = -1.0;
            check(
                fullmag::fem::apply_exchange_component_mass_projection(
                    &ctx, false, exchange_form, constant, ms_field,
                    *ctx.exchange.mfem.inv_lumped_mass, mass_form, consistent,
                    tmp, h_component, h_host, &constant_energy),
                "constant production mixed-P1 exchange projection must succeed");
            check_close(
                constant_energy, 0.0, 1.0e-11, "constant P1 exchange energy must vanish");
            check(h_component.Norml2() < 1.0e-5, "constant P1 exchange field must vanish");
        }
        fullmag::fem::context_destroy_mfem(ctx);
    }
}

void production_exchange_masks_air_in_conforming_mixed_domain()
{
    constexpr double a_value = 1.7;
    constexpr double ms_value = 4.0;
    mfem::Mesh mixed_mesh = conforming_exchange_prism_pyramid_tet();
    mfem::Mesh prism_mesh = single_exchange_cell(mfem::Geometry::PRISM);
    mfem::H1_FECollection mixed_fec(1, 3);
    mfem::H1_FECollection prism_fec(1, 3);
    mfem::FiniteElementSpace mixed_fes(&mixed_mesh, &mixed_fec);
    mfem::FiniteElementSpace prism_fes(&prism_mesh, &prism_fec);
    mfem::ConstantCoefficient a_coeff(a_value);
    mfem::ConstantCoefficient ms_coeff(ms_value);
    fullmag::fem::Context mixed_ctx;
    fullmag::fem::Context prism_ctx;
    initialize_production_exchange(
        mixed_ctx, mixed_mesh, mixed_fes, a_coeff, ms_coeff, {1u, 0u, 0u});
    initialize_production_exchange(
        prism_ctx, prism_mesh, prism_fes, a_coeff, ms_coeff, {1u});

    mfem::GridFunction mixed_field(&mixed_fes);
    mfem::GridFunction prism_field(&prism_fes);
    mfem::GridFunction mixed_direction(&mixed_fes);
    mfem::GridFunction mixed_ms(&mixed_fes);
    mfem::FunctionCoefficient linear(
        [](const mfem::Vector &x) { return x[0] + 2.0 * x[1] - 3.0 * x[2]; });
    mfem::FunctionCoefficient probe(
        [](const mfem::Vector &x) { return 0.3 - 0.2 * x[0] + 0.4 * x[1] + 0.1 * x[2]; });
    mixed_field.ProjectCoefficient(linear);
    prism_field.ProjectCoefficient(linear);
    mixed_direction.ProjectCoefficient(probe);
    mixed_ms.ProjectCoefficient(ms_coeff);
    auto &mixed_exchange = *mixed_ctx.exchange.mfem.exchange_form;
    auto &prism_exchange = *prism_ctx.exchange.mfem.exchange_form;
    mfem::Vector mixed_residual(mixed_fes.GetNDofs());
    mfem::Vector prism_residual(prism_fes.GetNDofs());
    mixed_exchange.Mult(mixed_field, mixed_residual);
    prism_exchange.Mult(prism_field, prism_residual);
    check_close(
        exchange_energy(mixed_exchange, mixed_field),
        exchange_energy(prism_exchange, prism_field),
        1.0e-11,
        "air pyramid/tetrahedron must make no exchange-energy contribution");
    for (int vertex = 0; vertex < 6; ++vertex) {
        mfem::Array<int> mixed_dofs;
        mfem::Array<int> prism_dofs;
        mixed_fes.GetVertexDofs(vertex, mixed_dofs);
        prism_fes.GetVertexDofs(vertex, prism_dofs);
        check_close(
            mixed_residual[mixed_dofs[0]],
            prism_residual[prism_dofs[0]],
            1.0e-11,
            "mixed interface nodes must retain the magnetic prism exchange contribution");
        check_close(
            mixed_ctx.integration_weights.mfem_lumped_mass[static_cast<size_t>(mixed_dofs[0])],
            prism_ctx.integration_weights.mfem_lumped_mass[static_cast<size_t>(prism_dofs[0])],
            1.0e-12,
            "mixed interface nodes must retain the magnetic prism mass contribution");
    }
    for (int vertex : {6, 7}) {
        mfem::Array<int> dofs;
        mixed_fes.GetVertexDofs(vertex, dofs);
        check_close(
            mixed_residual[dofs[0]], 0.0, 1.0e-12,
            "air-only nodes must have zero exchange residual");
        check_close(
            mixed_ctx.integration_weights.mfem_lumped_mass[static_cast<size_t>(dofs[0])],
            0.0,
            1.0e-12,
            "air-only nodes must have zero magnetic mass");
    }
    check_projection_contracts(
        mixed_ctx,
        mixed_fes,
        mixed_exchange,
        *mixed_ctx.exchange.mfem.mass_form,
        mixed_ms,
        mixed_field,
        mixed_direction);
    for (bool consistent : {false, true}) {
        mfem::Vector mixed_tmp(mixed_fes.GetNDofs());
        mfem::Vector mixed_h(mixed_fes.GetNDofs());
        mfem::Vector prism_tmp(prism_fes.GetNDofs());
        mfem::Vector prism_h(prism_fes.GetNDofs());
        std::vector<double> mixed_h_host;
        std::vector<double> prism_h_host;
        check(
            fullmag::fem::apply_exchange_component_mass_projection(
                &mixed_ctx, false, mixed_exchange, mixed_field, mixed_ms,
                *mixed_ctx.exchange.mfem.inv_lumped_mass,
                *mixed_ctx.exchange.mfem.mass_form,
                consistent,
                mixed_tmp,
                mixed_h,
                mixed_h_host,
                nullptr),
            "conforming mixed-domain exchange projection must succeed");
        mfem::GridFunction prism_ms(&prism_fes);
        prism_ms.ProjectCoefficient(ms_coeff);
        check(
            fullmag::fem::apply_exchange_component_mass_projection(
                &prism_ctx, false, prism_exchange, prism_field, prism_ms,
                *prism_ctx.exchange.mfem.inv_lumped_mass,
                *prism_ctx.exchange.mfem.mass_form,
                consistent,
                prism_tmp,
                prism_h,
                prism_h_host,
                nullptr),
            "prism-only exchange reference projection must succeed");
        for (int vertex = 0; vertex < 6; ++vertex) {
            mfem::Array<int> mixed_dofs;
            mfem::Array<int> prism_dofs;
            mixed_fes.GetVertexDofs(vertex, mixed_dofs);
            prism_fes.GetVertexDofs(vertex, prism_dofs);
            check_close(
                mixed_h[mixed_dofs[0]],
                prism_h[prism_dofs[0]],
                1.0e-10 * std::max(1.0, std::abs(prism_h[prism_dofs[0]])),
                "shared mixed-domain nodes must retain the prism-only projected H");
        }
        for (int vertex : {6, 7}) {
            mfem::Array<int> dofs;
            mixed_fes.GetVertexDofs(vertex, dofs);
            check_close(
                mixed_h[dofs[0]],
                0.0,
                1.0e-12,
                "air-only mixed-domain nodes must have zero projected H");
        }
    }
    fullmag::fem::context_destroy_mfem(prism_ctx);
    fullmag::fem::context_destroy_mfem(mixed_ctx);
}

void production_prism_exchange_converges_with_independent_all_tet_reference()
{
    constexpr double a_value = 1.7;
    constexpr double exact_energy = a_value * (4.0 / 3.0);
    mfem::Mesh prism_mesh = single_exchange_cell(mfem::Geometry::PRISM);
    mfem::Mesh tet_mesh = independent_all_tet_prism_reference();
    double initial_prism_error = 0.0;
    double initial_tet_error = 0.0;
    double previous_prism_error = 0.0;
    double previous_tet_error = 0.0;
    double final_prism_energy = 0.0;
    double final_tet_energy = 0.0;
    for (int level = 0; level < 3; ++level) {
        mfem::H1_FECollection prism_fec(1, 3);
        mfem::H1_FECollection tet_fec(1, 3);
        mfem::FiniteElementSpace prism_fes(&prism_mesh, &prism_fec);
        mfem::FiniteElementSpace tet_fes(&tet_mesh, &tet_fec);
        mfem::ConstantCoefficient a_coeff(a_value);
        mfem::ConstantCoefficient ms_coeff(4.0);
        fullmag::fem::Context prism_ctx;
        fullmag::fem::Context tet_ctx;
        initialize_production_exchange(
            prism_ctx,
            prism_mesh,
            prism_fes,
            a_coeff,
            ms_coeff,
            std::vector<uint8_t>(static_cast<size_t>(prism_mesh.GetNE()), 1u));
        initialize_production_exchange(
            tet_ctx,
            tet_mesh,
            tet_fes,
            a_coeff,
            ms_coeff,
            std::vector<uint8_t>(static_cast<size_t>(tet_mesh.GetNE()), 1u));
        mfem::FunctionCoefficient quadratic([](const mfem::Vector &x) {
            return x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
        });
        mfem::GridFunction prism_field(&prism_fes);
        mfem::GridFunction tet_field(&tet_fes);
        prism_field.ProjectCoefficient(quadratic);
        tet_field.ProjectCoefficient(quadratic);
        const double prism_energy = exchange_energy(
            *prism_ctx.exchange.mfem.exchange_form, prism_field);
        const double tet_energy = exchange_energy(
            *tet_ctx.exchange.mfem.exchange_form, tet_field);
        final_prism_energy = prism_energy;
        final_tet_energy = tet_energy;
        const double prism_error = std::abs(prism_energy - exact_energy);
        const double tet_error = std::abs(tet_energy - exact_energy);
        if (level == 0) {
            initial_prism_error = prism_error;
            initial_tet_error = tet_error;
        } else {
            check(
                prism_error < previous_prism_error && tet_error < previous_tet_error,
                "production prism and independent all-tet exchange errors must converge monotonically");
        }
        previous_prism_error = prism_error;
        previous_tet_error = tet_error;
        fullmag::fem::context_destroy_mfem(tet_ctx);
        fullmag::fem::context_destroy_mfem(prism_ctx);
        if (level < 2) {
            prism_mesh.UniformRefinement();
            tet_mesh.UniformRefinement();
        }
    }
    check(
        previous_prism_error < 0.3 * initial_prism_error &&
            previous_tet_error < 0.3 * initial_tet_error,
        "production prism and independent all-tet exchange must show resolved refinement convergence");
    check(
        std::abs(final_prism_energy - final_tet_energy) <
            0.3 * std::max(initial_prism_error, initial_tet_error),
        "refined production prism exchange must agree with the independent all-tet reference");
}

void spatial_a_and_ms_exchange_pass_directional_derivative() {
    constexpr double mu0 = 1.2566370614359172953850573533118e-6;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);

    mfem::GridFunction a_field(&fes);
    mfem::GridFunction ms_field(&fes);
    mfem::GridFunction magnetization(&fes);
    mfem::GridFunction perturbation(&fes);
    mfem::FunctionCoefficient a_function(
        [](const mfem::Vector &x) { return 1.0e-11 * (1.0 + 0.4 * x[0]); });
    mfem::FunctionCoefficient ms_function(
        [](const mfem::Vector &x) { return 7.0e5 + 2.0e5 * x[1]; });
    mfem::FunctionCoefficient m_function(
        [](const mfem::Vector &x) { return 0.2 + 0.3 * x[0] - 0.1 * x[2]; });
    mfem::FunctionCoefficient direction_function(
        [](const mfem::Vector &x) { return -0.15 + 0.2 * x[1] + 0.05 * x[2]; });
    a_field.ProjectCoefficient(a_function);
    ms_field.ProjectCoefficient(ms_function);
    magnetization.ProjectCoefficient(m_function);
    perturbation.ProjectCoefficient(direction_function);

    mfem::GridFunctionCoefficient a_coeff(&a_field);
    mfem::GridFunctionCoefficient ms_coeff(&ms_field);
    mfem::BilinearForm exchange_form(&fes);
    exchange_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(a_coeff));
    exchange_form.Assemble();
    exchange_form.Finalize();
    mfem::BilinearForm volume_mass_form(&fes);
    volume_mass_form.AddDomainIntegrator(new mfem::MassIntegrator());
    volume_mass_form.Assemble();
    volume_mass_form.Finalize();
    mfem::BilinearForm ms_mass_form(&fes);
    ms_mass_form.AddDomainIntegrator(new mfem::MassIntegrator(ms_coeff));
    ms_mass_form.Assemble();
    ms_mass_form.Finalize();

    mfem::Vector ones;
    mfem::Vector lumped;
    mfem::Vector inv_lumped;
    std::vector<double> host_lumped;
    fullmag::fem::prepare_exchange_mass_lumping(
        volume_mass_form, ones, lumped, inv_lumped, host_lumped);
    mfem::Vector residual;
    mfem::Vector h_component;
    residual.SetSize(fes.GetNDofs());
    h_component.SetSize(fes.GetNDofs());
    std::vector<double> h_host;
    double energy = 0.0;
    check(
        fullmag::fem::apply_exchange_component_mass_projection(
            nullptr,
            false,
            exchange_form,
            magnetization,
            ms_field,
            inv_lumped,
            ms_mass_form,
            true,
            residual,
            h_component,
            h_host,
            &energy),
        "spatial A/Ms consistent-mass exchange projection must succeed");

    constexpr double epsilon = 1.0e-6;
    mfem::GridFunction plus(magnetization);
    mfem::GridFunction minus(magnetization);
    plus.Add(epsilon, perturbation);
    minus.Add(-epsilon, perturbation);
    const double finite_difference =
        (exchange_energy(exchange_form, plus) -
         exchange_energy(exchange_form, minus)) /
        (2.0 * epsilon);

    mfem::Vector weighted_h(h_component.Size());
    ms_mass_form.Mult(h_component, weighted_h);
    const double field_derivative = -mu0 * (perturbation * weighted_h);
    const double scale = std::max(
        1.0e-30,
        std::max(std::abs(finite_difference), std::abs(field_derivative)));
    check(
        std::abs(finite_difference - field_derivative) / scale < 1.0e-8,
        "spatial A/Ms exchange field must match exchange-energy directional derivative");
    check(
        std::abs(energy - exchange_energy(exchange_form, magnetization)) < 1.0e-24,
        "exchange projection must report the same spatial-A energy used by the field");
}

void exchange_mass_projection_header_documents_ms_weighted_consistent_projection() {
    const std::filesystem::path root = fem_source_root();
    const std::string mass_projection_header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "exchange_mass_projection.hpp");
    const std::string exchange_docs =
        read_text_file(repo_root() / "docs" / "physics" / "fem_exchange.md");

    check(
        mass_projection_header.find("Lumped projection applies pointwise 1/Ms_i scaling") !=
            std::string::npos,
        "exchange mass-projection header must document lumped 1/Ms_i scaling");
    check(
        mass_projection_header.find("Consistent projection solves with the Ms-weighted mass form") !=
            std::string::npos,
        "exchange mass-projection header must document Ms-weighted consistent projection");
    check(
        exchange_docs.find("M_Ms q = K_A m") != std::string::npos &&
            exchange_docs.find("H_ex = -2 q / mu0") != std::string::npos,
        "exchange physics note must document the Ms-weighted consistent-mass weak form");
}

mfem::Mesh two_tet_marker_mesh() {
    mfem::Mesh mesh(3, 5, 2, 0, 3);
    const double v0[] = {0.0, 0.0, 0.0};
    const double v1[] = {1.0, 0.0, 0.0};
    const double v2[] = {0.0, 1.0, 0.0};
    const double v3[] = {0.0, 0.0, 1.0};
    const double v4[] = {1.0, 1.0, 1.0};
    mesh.AddVertex(v0);
    mesh.AddVertex(v1);
    mesh.AddVertex(v2);
    mesh.AddVertex(v3);
    mesh.AddVertex(v4);
    const int tet0[] = {0, 1, 2, 3};
    const int tet1[] = {1, 2, 3, 4};
    mesh.AddTet(tet0, 1);
    mesh.AddTet(tet1, 2);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    return mesh;
}

void sharp_element_a_and_ms_exchange_pass_directional_derivative() {
    constexpr double mu0 = 1.2566370614359172953850573533118e-6;
    mfem::Mesh mesh = two_tet_marker_mesh();
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);

    std::vector<double> a_element = {13.0e-12, 5.0e-12};
    std::vector<double> ms_element = {800.0e3, 700.0e3};
    TestElementwiseScalarCoefficient a_coeff(a_element);
    TestElementwiseScalarCoefficient ms_coeff(ms_element);

    mfem::GridFunction ms_dummy(&fes);
    mfem::GridFunction magnetization(&fes);
    mfem::GridFunction perturbation(&fes);
    mfem::ConstantCoefficient ms_scalar(800.0e3);
    mfem::FunctionCoefficient m_function(
        [](const mfem::Vector &x) { return 0.2 + 0.25 * x[0] - 0.08 * x[1] + 0.12 * x[2]; });
    mfem::FunctionCoefficient direction_function(
        [](const mfem::Vector &x) { return -0.1 + 0.18 * x[0] + 0.07 * x[1] - 0.03 * x[2]; });
    ms_dummy.ProjectCoefficient(ms_scalar);
    magnetization.ProjectCoefficient(m_function);
    perturbation.ProjectCoefficient(direction_function);

    mfem::BilinearForm exchange_form(&fes);
    exchange_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(a_coeff));
    exchange_form.Assemble();
    exchange_form.Finalize();
    mfem::BilinearForm volume_mass_form(&fes);
    volume_mass_form.AddDomainIntegrator(new mfem::MassIntegrator());
    volume_mass_form.Assemble();
    volume_mass_form.Finalize();
    mfem::BilinearForm ms_mass_form(&fes);
    ms_mass_form.AddDomainIntegrator(new mfem::MassIntegrator(ms_coeff));
    ms_mass_form.Assemble();
    ms_mass_form.Finalize();

    mfem::Vector ones;
    mfem::Vector lumped;
    mfem::Vector inv_lumped;
    std::vector<double> host_lumped;
    fullmag::fem::prepare_exchange_mass_lumping(
        volume_mass_form, ones, lumped, inv_lumped, host_lumped);
    mfem::Vector residual;
    mfem::Vector h_component;
    residual.SetSize(fes.GetNDofs());
    h_component.SetSize(fes.GetNDofs());
    std::vector<double> h_host;
    double energy = 0.0;
    check(
        fullmag::fem::apply_exchange_component_mass_projection(
            nullptr,
            false,
            exchange_form,
            magnetization,
            ms_dummy,
            inv_lumped,
            ms_mass_form,
            true,
            residual,
            h_component,
            h_host,
            &energy),
        "sharp element A/Ms consistent-mass exchange projection must succeed");

    constexpr double epsilon = 1.0e-6;
    mfem::GridFunction plus(magnetization);
    mfem::GridFunction minus(magnetization);
    plus.Add(epsilon, perturbation);
    minus.Add(-epsilon, perturbation);
    const double finite_difference =
        (exchange_energy(exchange_form, plus) -
         exchange_energy(exchange_form, minus)) /
        (2.0 * epsilon);

    mfem::Vector weighted_h(h_component.Size());
    ms_mass_form.Mult(h_component, weighted_h);
    const double field_derivative = -mu0 * (perturbation * weighted_h);
    const double scale = std::max(
        1.0e-30,
        std::max(std::abs(finite_difference), std::abs(field_derivative)));
    check(
        std::abs(finite_difference - field_derivative) / scale < 1.0e-8,
        "sharp element A/Ms exchange field must match exchange-energy directional derivative");
    check(
        std::abs(energy - exchange_energy(exchange_form, magnetization)) < 1.0e-24,
        "sharp element exchange projection must report the same spatial-A energy used by the field");
}

mfem::Mesh two_active_plus_air_tet_mesh() {
    mfem::Mesh mesh(3, 12, 3, 0, 3);
    const double vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0},
        {2.0, 0.0, 0.0}, {3.0, 0.0, 0.0}, {2.0, 1.0, 0.0}, {2.0, 0.0, 1.0},
        {4.0, 0.0, 0.0}, {5.0, 0.0, 0.0}, {4.0, 1.0, 0.0}, {4.0, 0.0, 1.0},
    };
    for (const auto &vertex : vertices) {
        mesh.AddVertex(vertex);
    }
    const int tet0[] = {0, 1, 2, 3};
    const int tet1[] = {4, 5, 6, 7};
    const int air[] = {8, 9, 10, 11};
    mesh.AddTet(tet0, 1);
    mesh.AddTet(tet1, 1);
    mesh.AddTet(air, 1);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    return mesh;
}

void adapter_backed_sharp_material_exchange_excludes_air_and_preserves_identity() {
    constexpr double mu0 = 1.2566370614359172953850573533118e-6;
    mfem::Mesh mesh = two_active_plus_air_tet_mesh();
    check(
        mesh.GetAttribute(2) == mesh.GetAttribute(0),
        "air tetrahedron must share the active MFEM attribute so exclusion is ordinal-based");
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> topology = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{4, 5, 6, 7}}, 1.0 / 6.0},
        {{{8, 9, 10, 11}}, 1.0 / 6.0},
    };
    const fullmag::fem::FemMaterialRuntimeAdapter runtime(
        fullmag::fem::P1TetrahedralMaterialRealization(
            12u,
            topology,
            {0u, 1u},
            {fullmag::fem::MaterialCoefficientLocation::element_dg0, {8.0e5, 7.0e5, 9.0e5}},
            {fullmag::fem::MaterialCoefficientLocation::element_dg0, {13.0e-12, 5.0e-12, 101.0e-12}}));
    TestAdapterBackedElementwiseCoefficient a_coeff(runtime, AdapterCoefficientKind::a);
    TestAdapterBackedElementwiseCoefficient ms_coeff(runtime, AdapterCoefficientKind::ms);

    mfem::GridFunction ms_dummy(&fes);
    mfem::GridFunction magnetization(&fes);
    mfem::GridFunction perturbation(&fes);
    mfem::FunctionCoefficient ms_scalar([](const mfem::Vector &) { return 8.0e5; });
    mfem::FunctionCoefficient m_function(
        [](const mfem::Vector &x) { return 0.2 + 0.17 * x[0] - 0.08 * x[1] + 0.12 * x[2]; });
    mfem::FunctionCoefficient direction_function(
        [](const mfem::Vector &x) { return -0.1 + 0.13 * x[0] + 0.07 * x[1] - 0.03 * x[2]; });
    ms_dummy.ProjectCoefficient(ms_scalar);
    magnetization.ProjectCoefficient(m_function);
    perturbation.ProjectCoefficient(direction_function);

    mfem::BilinearForm exchange_form(&fes);
    exchange_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(a_coeff));
    exchange_form.Assemble();
    exchange_form.Finalize();
    mfem::BilinearForm volume_mass_form(&fes);
    volume_mass_form.AddDomainIntegrator(new mfem::MassIntegrator());
    volume_mass_form.Assemble();
    volume_mass_form.Finalize();
    mfem::BilinearForm ms_mass_form(&fes);
    ms_mass_form.AddDomainIntegrator(new mfem::MassIntegrator(ms_coeff));
    ms_mass_form.Assemble();
    ms_mass_form.Finalize();

    mfem::Vector ones;
    mfem::Vector lumped;
    mfem::Vector inv_lumped;
    std::vector<double> host_lumped;
    fullmag::fem::prepare_exchange_mass_lumping(
        volume_mass_form, ones, lumped, inv_lumped, host_lumped);
    mfem::Vector residual(fes.GetNDofs());
    mfem::Vector h_component(fes.GetNDofs());
    std::vector<double> h_host;
    double energy = 0.0;
    check(
        fullmag::fem::apply_exchange_component_mass_projection(
            nullptr, false, exchange_form, magnetization, ms_dummy, inv_lumped, ms_mass_form,
            true, residual, h_component, h_host, &energy),
        "adapter-backed sharp-material exchange projection must succeed");
    constexpr double epsilon = 1.0e-6;
    mfem::GridFunction plus(magnetization);
    mfem::GridFunction minus(magnetization);
    plus.Add(epsilon, perturbation);
    minus.Add(-epsilon, perturbation);
    const double finite_difference =
        (exchange_energy(exchange_form, plus) - exchange_energy(exchange_form, minus)) /
        (2.0 * epsilon);
    mfem::Vector weighted_h(h_component.Size());
    ms_mass_form.Mult(h_component, weighted_h);
    const double field_derivative = -mu0 * (perturbation * weighted_h);
    check(
        std::abs(finite_difference - field_derivative) /
                std::max(1.0e-30, std::max(std::abs(finite_difference), std::abs(field_derivative))) <
            1.0e-8,
        "adapter-backed DG0 A/Ms exchange field must match directional identity");

    const fullmag::fem::FemMaterialRuntimeAdapter all_element_runtime(
        fullmag::fem::P1TetrahedralMaterialRealization(
            12u,
            topology,
            {0u, 1u, 2u},
            {fullmag::fem::MaterialCoefficientLocation::element_dg0, {8.0e5, 7.0e5, 9.0e5}},
            {fullmag::fem::MaterialCoefficientLocation::element_dg0, {13.0e-12, 5.0e-12, 101.0e-12}}));
    TestAdapterBackedElementwiseCoefficient all_a_coeff(all_element_runtime, AdapterCoefficientKind::a);
    TestAdapterBackedElementwiseCoefficient all_ms_coeff(all_element_runtime, AdapterCoefficientKind::ms);
    mfem::BilinearForm all_exchange_form(&fes);
    all_exchange_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(all_a_coeff));
    all_exchange_form.Assemble();
    all_exchange_form.Finalize();
    check(
        std::abs(exchange_energy(all_exchange_form, magnetization) - energy) > 1.0e-16,
        "including air in DG0 exchange stiffness must be observably wrong");
    mfem::BilinearForm all_ms_mass_form(&fes);
    all_ms_mass_form.AddDomainIntegrator(new mfem::MassIntegrator(all_ms_coeff));
    all_ms_mass_form.Assemble();
    all_ms_mass_form.Finalize();
    mfem::Vector constant(fes.GetNDofs());
    constant = 1.0;
    mfem::Vector active_ms_mass(fes.GetNDofs());
    mfem::Vector all_ms_mass(fes.GetNDofs());
    ms_mass_form.Mult(constant, active_ms_mass);
    all_ms_mass_form.Mult(constant, all_ms_mass);
    all_ms_mass -= active_ms_mass;
    check(
        all_ms_mass.Norml2() > 1.0e-12,
        "including air in DG0 Ms mass must be observably wrong");
}
#endif

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
#if FULLMAG_HAS_MFEM_STACK
    production_exchange_supports_each_mixed_p1_cell_family();
    production_exchange_masks_air_in_conforming_mixed_domain();
    production_prism_exchange_converges_with_independent_all_tet_reference();
    spatial_a_and_ms_exchange_pass_directional_derivative();
    exchange_mass_projection_header_documents_ms_weighted_consistent_projection();
    sharp_element_a_and_ms_exchange_pass_directional_derivative();
    adapter_backed_sharp_material_exchange_excludes_air_and_preserves_identity();
#endif
#if !FULLMAG_HAS_MFEM_STACK
    disabled_exchange_is_zero_without_mfem_stack();
    active_exchange_reports_mfem_requirement_without_stack();
#endif
    return 0;
}
