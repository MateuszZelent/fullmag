/*
 * source_facade_contract.cpp - native FEM source-facade ownership docs.
 *
 * The module split leaves several top-level source files as compatibility
 * facades. This contract keeps those boundaries explicit and prevents
 * src/context.cpp or src/mfem_bridge.cpp from becoming undocumented owners of
 * core, runtime, interaction, or integrator responsibilities again.
 */

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

void source_facades_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string backend_handle_header =
        read_text_file(root / "include" / "backend_handle.hpp");
    const std::string context_builder =
        read_text_file(root / "core" / "fem_context_builder.cpp");
    const std::string context_builder_header =
        read_text_file(root / "core" / "fem_context_builder.hpp");
    const std::string dmi =
        read_text_file(root / "src" / "dmi_weak_residual.cpp");
    const std::string error = read_text_file(root / "src" / "error.cpp");
    const std::string gpu_exchange =
        read_text_file(root / "src" / "gpu_exchange.cpp");
    const std::string gpu_rk = read_text_file(root / "src" / "gpu_rk.cpp");
    const std::string gpu_state =
        read_text_file(root / "src" / "gpu_state.cpp");
    const std::string gpu_state_header =
        read_text_file(root / "include" / "gpu_state.hpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string transfer =
        read_text_file(root / "src" / "transfer_audit.cpp");
    const std::string transfer_header =
        read_text_file(root / "include" / "transfer_audit.hpp");
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string backend_step_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.hpp");
    const std::string backend_lifecycle =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_lifecycle.cpp");
    const std::string backend_lifecycle_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_lifecycle.hpp");
    const std::string eigen_dense =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "eigen_dense.cpp");
    const std::string eigen_dense_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "eigen_dense.hpp");

    check(
        api.find("FEM C ABI facade source contract") != std::string::npos,
        "api source file must document its source contract");
    check(
        api.find("does not own Context construction internals, MFEM runtime lifecycle, interaction physics, integrator stages, or transfer-audit policy") != std::string::npos,
        "api source file must document its non-owning module boundary");
    check(
        api.find("cusolverDnDsygvd") == std::string::npos &&
            api.find("cudaMalloc") == std::string::npos &&
            api.find("cudaMemcpy") == std::string::npos,
        "api source file must not own dense eigensolver CUDA/cuSolver implementation");
    check(
        api.find("return fullmag::fem::solve_dense_generalized_eigenproblem(desc);") !=
            std::string::npos,
        "api source file must delegate dense eigensolver implementation to runtime module");
    check(
        api.find("context_step_explicit_rk_mfem") == std::string::npos &&
            api.find("TransferAuditScope hot_loop") == std::string::npos &&
            api.find("gpu_rk_finalize_step_stats") == std::string::npos &&
            api.find("set_stage_completion(") == std::string::npos,
        "api source file must not own backend step runtime orchestration");
    check(
        api.find("fullmag::fem::run_backend_step(") != std::string::npos,
        "api source file must delegate backend step orchestration to runtime module");
    check(
        api.find("context_from_plan(handle->context") == std::string::npos &&
            api.find("configure_transfer_audit_from_env(handle->context.transfer_audit)") ==
                std::string::npos,
        "api source file must not own backend runtime initialization");
    check(
        api.find("fullmag::fem::initialize_backend_runtime(") != std::string::npos,
        "api source file must delegate backend runtime initialization to runtime module");
    check(
        api.find("gpu_state_destroy(handle->context.gpu_state)") == std::string::npos &&
            api.find("context_destroy_mfem(handle->context)") == std::string::npos,
        "api source file must not own backend runtime teardown");
    check(
        api.find("fullmag::fem::destroy_backend_runtime(") != std::string::npos,
        "api source file must delegate backend runtime teardown to runtime module");
    check(
        api.find("transfer_audit_snapshot(handle->context.transfer_audit)") ==
            std::string::npos,
        "api source file must not read transfer-audit runtime state directly");
    check(
        api.find("fullmag::fem::transfer_audit_snapshot(handle->context)") !=
            std::string::npos,
        "api source file must delegate transfer-audit snapshot through owning module");
    check(
        api.find("gpu_state_info(handle->context.gpu_state)") == std::string::npos,
        "api source file must not read GPU runtime state directly");
    check(
        api.find("fullmag::fem::gpu_state_info(handle->context)") != std::string::npos,
        "api source file must delegate GPU-state info through owning module");
    check(
        context.find("FEM Context facade source contract") != std::string::npos,
        "context source file must document its source contract");
    check(
        context.find("does not own base/core import helpers, runtime lifecycle, device policy, integrator stage mechanics, or interaction physics") != std::string::npos,
        "context source file must document its non-owning module boundary");
    check(
        context.find("return build_context_from_plan(ctx, plan, error);") !=
            std::string::npos,
        "context source file must delegate plan construction to Context builder");
    check(
        context.find("initialize_base_plan_fields(ctx, plan, error)") ==
            std::string::npos &&
            context.find("initialize_exchange_plan_fields(ctx, plan)") ==
                std::string::npos &&
            context.find("context_initialize_mfem(ctx, error)") == std::string::npos &&
            context.find("initialize_context_gpu_state(ctx, error)") == std::string::npos,
        "context source file must not own Context construction sequencing");
    check(
        context_builder_header.find("Build native FEM Context runtime state from a validated C ABI plan") !=
            std::string::npos,
        "Context builder header must document plan-construction ownership");
    check(
        context_builder.find("FEM Context builder source contract") != std::string::npos,
        "Context builder source file must document its source contract");
    check(
        context_builder.find("bool build_context_from_plan(") != std::string::npos,
        "Context builder source must own the plan-construction helper");
    check(
        context_builder.find("initialize_base_plan_fields(ctx, plan, error)") !=
            std::string::npos &&
            context_builder.find("initialize_exchange_plan_fields(ctx, plan)") !=
                std::string::npos &&
            context_builder.find("initialize_context_gpu_state(ctx, error)") !=
                std::string::npos,
        "Context builder source must own Context construction sequencing");
    check(
        context_header.find("struct fullmag_fem_backend") == std::string::npos,
        "Context header must not define the C ABI backend handle");
    check(
        backend_handle_header.find("Native FEM C ABI backend handle storage") !=
            std::string::npos,
        "backend handle header must document private C ABI handle storage ownership");
    check(
        backend_handle_header.find("struct fullmag_fem_backend") != std::string::npos &&
            backend_handle_header.find("fullmag::fem::Context context;") !=
                std::string::npos &&
            backend_handle_header.find("std::string last_error;") != std::string::npos,
        "backend handle header must own Context and last-error storage");
    check(
        dmi.find("DMI weak-residual facade source contract") != std::string::npos,
        "DMI weak-residual source file must document its source contract");
    check(
        dmi.find("does not own Context plan import, effective-field composition, demag solves, runtime state I/O, or integrator execution") != std::string::npos,
        "DMI weak-residual source file must document its non-owning module boundary");
    check(
        error.find("FEM error facade source contract") != std::string::npos,
        "error source file must document its source contract");
    check(
        error.find("does not own backend creation, Context construction, solver execution, availability policy, or transfer auditing") != std::string::npos,
        "error source file must document its non-owning module boundary");
    check(
        gpu_exchange.find("GPU exchange facade source contract") != std::string::npos,
        "GPU exchange source file must document its source contract");
    check(
        gpu_exchange.find("does not own Context construction, MFEM exchange assembly, CPU fallback exchange, integrator execution, or C ABI entrypoints") != std::string::npos,
        "GPU exchange source file must document its non-owning module boundary");
    check(
        gpu_rk.find("GPU RK facade source contract") != std::string::npos,
        "GPU RK source file must document its source contract");
    check(
        gpu_rk.find("does not own Context construction, CPU explicit RK stages, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints") != std::string::npos,
        "GPU RK source file must document its non-owning module boundary");
    check(
        gpu_state.find("GPU state facade source contract") != std::string::npos,
        "GPU state source file must document its source contract");
    check(
        gpu_state.find("does not own MFEM device selection, Context construction, exchange operator assembly, integrator execution, or C ABI entrypoints") != std::string::npos,
        "GPU state source file must document its non-owning module boundary");
    check(
        gpu_state.find("gpu_state_info(ctx.gpu_state)") != std::string::npos,
        "GPU state source file must own Context-backed GPU info snapshot access");
    check(
        gpu_state_header.find("fullmag_fem_gpu_state_info gpu_state_info(const Context &ctx);") !=
            std::string::npos,
        "GPU state header must declare Context-backed GPU info snapshot access");
    check(
        bridge.find("Legacy MFEM bridge facade source contract") != std::string::npos,
        "legacy MFEM bridge source file must document its source contract");
    check(
        bridge.find("does not own runtime lifecycle, interaction physics, integrators, field buffers, metrics, or CPU runtime policy") != std::string::npos,
        "legacy MFEM bridge source file must document its non-owning module boundary");
    check(
        transfer.find("Transfer-audit facade source contract") != std::string::npos,
        "transfer-audit source file must document its source contract");
    check(
        transfer.find("does not own C ABI calls, Context construction, MFEM device policy, interaction physics, or integrator execution") != std::string::npos,
        "transfer-audit source file must document its non-owning module boundary");
    check(
        transfer.find("transfer_audit_snapshot(ctx.transfer_audit)") !=
            std::string::npos,
        "transfer-audit source file must own Context-backed snapshot access");
    check(
        transfer_header.find("fullmag_fem_transfer_audit transfer_audit_snapshot(const Context &ctx);") !=
            std::string::npos,
        "transfer-audit header must declare Context-backed snapshot access");
    check(
        backend_step.find("FEM backend step runtime source contract") != std::string::npos,
        "backend step runtime source file must document its source contract");
    check(
        backend_step.find("int run_backend_step(") != std::string::npos,
        "backend step runtime source must own the runtime step helper");
    check(
        backend_step.find("context_step_explicit_rk_mfem") != std::string::npos &&
            backend_step.find("TransferAuditScope hot_loop") != std::string::npos &&
            backend_step.find("gpu_rk_finalize_step_stats") != std::string::npos,
        "backend step runtime source must own RK dispatch, transfer-audit scope, and GPU RK stats finalization");
    check(
        backend_step_header.find("Run one native FEM backend step behind the C ABI facade") !=
            std::string::npos,
        "backend step runtime header must document its contract");
    check(
        backend_step_header.find("does not own exported fullmag_fem_backend_step") !=
            std::string::npos,
        "backend step runtime header must document its non-owning C ABI boundary");
    check(
        backend_lifecycle.find("FEM backend lifecycle runtime source contract") !=
            std::string::npos,
        "backend lifecycle runtime source file must document its source contract");
    check(
        backend_lifecycle.find("bool initialize_backend_runtime(") != std::string::npos,
        "backend lifecycle runtime source must own runtime initialization helper");
    check(
        backend_lifecycle.find("context_from_plan(ctx, plan, error)") != std::string::npos &&
            backend_lifecycle.find("configure_transfer_audit_from_env(ctx.transfer_audit)") !=
                std::string::npos,
        "backend lifecycle runtime source must own Context construction delegation and transfer-audit env import");
    check(
        backend_lifecycle.find("void destroy_backend_runtime(") != std::string::npos,
        "backend lifecycle runtime source must own runtime teardown helper");
    check(
        backend_lifecycle.find("gpu_state_destroy(ctx.gpu_state)") != std::string::npos &&
            backend_lifecycle.find("context_destroy_mfem(ctx)") != std::string::npos,
        "backend lifecycle runtime source must own GPU and MFEM runtime teardown calls");
    check(
        backend_lifecycle_header.find("Destroy native FEM backend runtime resources behind the C ABI facade") !=
            std::string::npos,
        "backend lifecycle runtime header must document its contract");
    check(
        backend_lifecycle_header.find("Initialize native FEM backend runtime resources behind the C ABI facade") !=
            std::string::npos,
        "backend lifecycle runtime header must document its initialization contract");
    check(
        backend_lifecycle_header.find("does not own exported fullmag_fem_backend_destroy") !=
            std::string::npos,
        "backend lifecycle runtime header must document its non-owning C ABI boundary");
    check(
        eigen_dense.find("Dense generalized eigensolver runtime source contract") !=
            std::string::npos,
        "dense eigensolver runtime source file must document its source contract");
    check(
        eigen_dense.find("int solve_dense_generalized_eigenproblem(") != std::string::npos,
        "dense eigensolver runtime source must own the implementation helper");
    check(
        eigen_dense.find("cusolverDnDsygvd") != std::string::npos,
        "dense eigensolver runtime source must own cuSolver dispatch when available");
    check(
        eigen_dense_header.find("Solve the optional GPU dense generalized eigenproblem") !=
            std::string::npos,
        "dense eigensolver runtime header must document its contract");
    check(
        eigen_dense_header.find("does not own exported C ABI entrypoint plumbing") !=
            std::string::npos,
        "dense eigensolver runtime header must document its non-owning C ABI boundary");
}

void common_fem_utilities_have_single_header() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string common = read_text_file(root / "include" / "fem_common.hpp");
    const std::string llg =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.cpp");
    const std::string rk_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string thermal_sigma =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.cpp");
    const std::string demag_energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_energy.cpp");

    for (const char *symbol : {
             "kPi",
             "kMu0",
             "scalar_field_value",
             "vector_norm3",
             "elapsed_ns",
             "ScopedPhaseTimer",
         }) {
        check(
            common.find(symbol) != std::string::npos,
            "common FEM utility header must own shared scalar/timing/vector helpers");
    }
    for (const std::string *source : {&llg, &rk_step, &thermal_sigma, &demag_energy}) {
        check(
            source->find("#include \"fem_common.hpp\"") != std::string::npos,
            "duplicate FEM utility users must include fem_common.hpp");
    }
    check(
        llg.find("double scalar_field_value(") == std::string::npos &&
            llg.find("double vector_norm3(") == std::string::npos,
        "LLG RHS must use shared scalar/vector helpers instead of local copies");
    check(
        rk_step.find("class ScopedPhaseTimer") == std::string::npos,
        "RK stepper must use shared timing helper instead of a local timer class");
    check(
        thermal_sigma.find("constexpr double kMu0") == std::string::npos,
        "Brown sigma must use shared constants instead of local mu0 copy");
    check(
        demag_energy.find("double scalar_field_value(") == std::string::npos,
        "Demag energy must use shared scalar helper instead of local copy");
    check(
        cmake.find("heun_step.cpp") == std::string::npos,
        "FEM CMake source list must not reference removed Heun stepper files");
}

} // namespace

int main() {
    source_facades_document_module_boundaries();
    common_fem_utilities_have_single_header();
    return 0;
}
