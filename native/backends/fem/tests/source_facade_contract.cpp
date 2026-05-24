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

std::string read_optional_text_file(const std::filesystem::path &path) {
    if (!std::filesystem::exists(path)) {
        return {};
    }
    return read_text_file(path);
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::filesystem::path repo_root() {
    return fem_source_root().parent_path().parent_path().parent_path();
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
    const std::string gpu_state_impl =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string transfer_impl =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_audit.cpp");
    const std::string transfer_header =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_audit.hpp");
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
            api.find("configure_transfer_audit_from_env(handle->context.transfer_audit.audit)") ==
                std::string::npos,
        "api source file must not own backend runtime initialization");
    check(
        api.find("fullmag::fem::initialize_backend_runtime(") != std::string::npos,
        "api source file must delegate backend runtime initialization to runtime module");
    check(
        api.find("gpu_state_destroy(handle->context.gpu_state.device)") == std::string::npos &&
            api.find("context_destroy_mfem(handle->context)") == std::string::npos,
        "api source file must not own backend runtime teardown");
    check(
        api.find("fullmag::fem::destroy_backend_runtime(") != std::string::npos,
        "api source file must delegate backend runtime teardown to runtime module");
    check(
        api.find("transfer_audit_snapshot(handle->context.transfer_audit.audit)") ==
            std::string::npos,
        "api source file must not read transfer-audit runtime state directly");
    check(
        api.find("fullmag::fem::transfer_audit_snapshot(handle->context)") !=
            std::string::npos,
        "api source file must delegate transfer-audit snapshot through owning module");
    check(
        api.find("gpu_state_info(handle->context.gpu_state.device)") == std::string::npos,
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
        gpu_state_impl.find("GPU CUDA state source contract") != std::string::npos,
        "GPU CUDA state module must document its source contract");
    check(
        !std::filesystem::exists(root / "include" / "gpu_state.hpp"),
        "GPU CUDA state header must not remain in root include");
    check(
        gpu_state_header.find("GPU CUDA state module header") != std::string::npos,
        "GPU CUDA state header must document its module ownership");
    check(
        gpu_state_impl.find("gpu_state_info(ctx.gpu_state.device)") != std::string::npos,
        "GPU CUDA state module must own Context-backed GPU info snapshot access");
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
        transfer_impl.find("GPU CUDA transfer-audit source contract") != std::string::npos,
        "GPU CUDA transfer-audit module must document its source contract");
    check(
        !std::filesystem::exists(root / "include" / "transfer_audit.hpp"),
        "GPU CUDA transfer-audit header must not remain in root include");
    check(
        transfer_header.find("GPU CUDA transfer-audit module header") !=
            std::string::npos,
        "GPU CUDA transfer-audit header must document its module ownership");
    check(
        transfer_impl.find("#include \"gpu/cuda/transfer/transfer_audit.hpp\"") !=
            std::string::npos,
        "GPU CUDA transfer-audit source must include its module-owned header");
    check(
        transfer_impl.find("transfer_audit_snapshot(ctx.transfer_audit.audit)") !=
            std::string::npos,
        "GPU CUDA transfer-audit module must own Context-backed snapshot access");
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
            backend_lifecycle.find("configure_transfer_audit_from_env(ctx.transfer_audit.audit)") !=
                std::string::npos,
        "backend lifecycle runtime source must own Context construction delegation and transfer-audit env import");
    check(
        backend_lifecycle.find("void destroy_backend_runtime(") != std::string::npos,
        "backend lifecycle runtime source must own runtime teardown helper");
    check(
        backend_lifecycle.find("gpu_state_destroy(ctx.gpu_state.device)") != std::string::npos &&
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

void legacy_gpu_placeholder_sources_are_removed() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");

    for (const char *path : {
             "src/gpu_exchange.cpp",
             "src/gpu_rk.cpp",
             "src/gpu_state.cpp",
             "src/transfer_audit.cpp",
         }) {
        check(
            cmake.find(path) == std::string::npos,
            "FEM CMake source list must not build legacy empty GPU placeholder sources");
        check(
            !std::filesystem::exists(root / path),
            "legacy empty GPU placeholder source must be removed from src");
    }
}

void gpu_exchange_planning_is_owned_by_cuda_exchange_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string header =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_plan.hpp");
    const std::string module =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_plan.cpp");

    check(
        cmake.find("gpu/cuda/exchange/exchange_plan.cpp") != std::string::npos,
        "FEM CMake source list must build GPU exchange planning from gpu/cuda/exchange");
    check(
        cmake.find("src/gpu_exchange.cpp") == std::string::npos,
        "FEM CMake source list must not build GPU exchange planning from legacy src path");
    check(
        !std::filesystem::exists(root / "include" / "gpu_exchange.hpp"),
        "GPU exchange planning header must not remain in root include");
    check(
        header.find("GPU CUDA exchange planning module header") != std::string::npos,
        "GPU CUDA exchange planning header must document its module ownership");
    check(
        header.find("GpuExchangePlan gpu_exchange_plan_stage_exchange(") !=
            std::string::npos,
        "GPU CUDA exchange planning header must declare gpu_exchange_plan_stage_exchange");
    check(
        module.find("#include \"gpu/cuda/exchange/exchange_plan.hpp\"") !=
            std::string::npos,
        "GPU CUDA exchange planning source must include its module-owned header");
    check(
        module.find("GPU CUDA exchange planning source contract") != std::string::npos,
        "GPU CUDA exchange planning module must document its source contract");
    check(
        module.find("GpuExchangePlan gpu_exchange_plan_stage_exchange(") !=
            std::string::npos,
        "GPU CUDA exchange planning module must own gpu_exchange_plan_stage_exchange");
    check(
        module.find("does not own Context construction, MFEM exchange assembly, CPU fallback exchange, integrator execution, or C ABI entrypoints") !=
            std::string::npos,
        "GPU CUDA exchange planning module must document its non-owning module boundary");
}

void gpu_exchange_kernels_are_owned_by_cuda_exchange_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string exchange_header =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_kernels.hpp");
    const std::string exchange_source =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_kernels.cu");

    check(
        cmake.find("gpu/cuda/exchange/exchange_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU exchange CUDA kernels from gpu/cuda/exchange");
    check(
        kernels_header.find("#include \"gpu/cuda/exchange/exchange_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the exchange kernel module");
    check(
        exchange_header.find("GPU CUDA exchange kernels module header") !=
                std::string::npos &&
            exchange_header.find("fullmag_cuda_legacy_sparse_exchange(") !=
                std::string::npos &&
            exchange_header.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA exchange kernels header must own legacy sparse exchange wrapper declarations");
    check(
        exchange_source.find("#include \"gpu/cuda/exchange/exchange_kernels.hpp\"") !=
                std::string::npos &&
            exchange_source.find("GPU CUDA exchange kernels source contract") !=
                std::string::npos,
        "GPU CUDA exchange kernels source must document and include its module header");
    check(
        exchange_source.find("legacy_sparse_exchange_kernel") !=
                std::string::npos &&
            exchange_source.find("legacy_sparse_exchange_energy_blocks_kernel") !=
                std::string::npos &&
            exchange_source.find("fullmag_cuda_legacy_sparse_exchange(") !=
                std::string::npos &&
            exchange_source.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA exchange kernels source must own legacy sparse exchange kernels and wrappers");
    check(
        exchange_source.find("gpu_exchange_plan_stage_exchange(") ==
            std::string::npos,
        "GPU CUDA exchange kernels source must not own exchange readiness planning");
    check(
        kernels_header.find("void fullmag_cuda_legacy_sparse_exchange(") ==
                std::string::npos &&
            kernels_header.find("void fullmag_cuda_legacy_sparse_exchange_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare exchange wrappers");
    check(
        kernels_source.find("legacy_sparse_exchange_kernel") ==
                std::string::npos &&
            kernels_source.find("legacy_sparse_exchange_energy_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_legacy_sparse_exchange(") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_legacy_sparse_exchange_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own exchange kernel implementations");
}

void gpu_rk_planning_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk.hpp");
    const std::string module =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_plan.cpp");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_plan.cpp") != std::string::npos,
        "FEM CMake source list must build GPU RK planning from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/rk/rk_plan.cpp") == std::string::npos,
        "FEM CMake source list must not build GPU RK planning from transitional gpu/cuda/rk path");
    check(
        cmake.find("src/gpu_rk.cpp") == std::string::npos,
        "FEM CMake source list must not build GPU RK planning from legacy src path");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "rk"),
        "GPU RK integrator module must not remain in transitional gpu/cuda/rk");
    check(
        !std::filesystem::exists(root / "include" / "gpu_rk.hpp"),
        "GPU RK header must not remain in root include");
    check(
        header.find("GPU CUDA RK module header") != std::string::npos,
        "GPU CUDA RK header must document its module ownership");
    check(
        header.find("GpuRkPlan gpu_rk_plan_device_resident(") !=
            std::string::npos &&
            header.find("bool gpu_rk_device_resident_step(") !=
                std::string::npos,
        "GPU CUDA RK header must declare planning and step entrypoints");
    check(
        module.find("#include \"gpu/cuda/integrators/rk/rk.hpp\"") != std::string::npos,
        "GPU CUDA RK planning source must include its module-owned header");
    check(
        module.find("GPU CUDA RK planning source contract") != std::string::npos,
        "GPU CUDA RK planning module must document its source contract");
    check(
        module.find("GpuRkPlan gpu_rk_plan_device_resident(") != std::string::npos,
        "GPU CUDA RK planning module must own gpu_rk_plan_device_resident");
    check(
        module.find("bool gpu_rk_finalize_step_stats(") == std::string::npos,
        "GPU CUDA RK planning module must not own final stats fallback implementation");
    check(
        module.find("bool gpu_rk_snapshot_current_state(") == std::string::npos,
        "GPU CUDA RK planning module must not own snapshot fallback implementation");
    check(
        module.find("double gpu_rk_resolve_slonczewski_thickness(") !=
            std::string::npos,
        "GPU CUDA RK planning module must own Slonczewski thickness fallback geometry");
    check(
        module.find("does not own Context construction, CPU explicit RK stages, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints") !=
            std::string::npos,
        "GPU CUDA RK planning module must document its non-owning module boundary");
}

void gpu_rk_step_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string module =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step.cu") != std::string::npos,
        "FEM CMake source list must build GPU RK CUDA step orchestration from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/rk/rk_step.cu") == std::string::npos,
        "FEM CMake source list must not build GPU RK CUDA step orchestration from transitional gpu/cuda/rk path");
    check(
        cmake.find("src/gpu_rk.cu") == std::string::npos,
        "FEM CMake source list must not build GPU RK CUDA step orchestration from legacy src path");
    check(
        module.find("GPU CUDA RK step source contract") != std::string::npos,
        "GPU CUDA RK step module must document its source contract");
    check(
        module.find("#include \"gpu/cuda/integrators/rk/rk.hpp\"") != std::string::npos,
        "GPU CUDA RK step source must include its module-owned header");
    check(
        module.find("bool gpu_rk_device_resident_step(") != std::string::npos,
        "GPU CUDA RK step module must own gpu_rk_device_resident_step");
    check(
        module.find("bool gpu_rk_finalize_step_stats(") == std::string::npos,
        "GPU CUDA RK step module must not own final stats publication");
    check(
        module.find("bool gpu_rk_snapshot_current_state(") == std::string::npos,
        "GPU CUDA RK step module must not own snapshot recomputation");
    check(
        module.find("GpuRkPlan gpu_rk_plan_device_resident(") == std::string::npos,
        "GPU CUDA RK step module must not own RK planning");
    check(
        module.find("does not own Context construction, GPU RK planning, CPU explicit RK stages, MFEM runtime lifecycle, RHS assembly, final statistics, snapshot recomputation, interaction physics, or C ABI entrypoints") !=
            std::string::npos,
        "GPU CUDA RK step module must document its non-owning module boundary");
}

void gpu_rk_snapshot_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string snapshot_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.hpp");
    const std::string snapshot_fallback =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.cpp");
    const std::string snapshot_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_snapshot.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK snapshot no-CUDA fallback from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_snapshot.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK snapshot recomputation from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_snapshot.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK snapshot module");
    check(
        snapshot_header.find("GPU CUDA RK snapshot module header") !=
                std::string::npos &&
            snapshot_header.find("gpu_rk_snapshot_current_state(") !=
                std::string::npos,
        "GPU CUDA RK snapshot header must own the snapshot declaration");
    check(
        snapshot_source.find("#include \"gpu/cuda/integrators/rk/rk_snapshot.hpp\"") !=
                std::string::npos &&
            snapshot_source.find("GPU CUDA RK snapshot source contract") !=
                std::string::npos,
        "GPU CUDA RK snapshot source must document and include its module header");
    check(
        snapshot_source.find("bool gpu_rk_snapshot_current_state(") !=
                std::string::npos &&
            snapshot_source.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos &&
            snapshot_source.find("gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)") !=
                std::string::npos &&
            snapshot_source.find("gpu_rk_finalize_step_stats(ctx, stats, reason)") !=
                std::string::npos,
        "GPU CUDA RK snapshot source must own RHS refresh, max-RHS reduction, and stats finalization for snapshots");
    check(
        snapshot_source.find("gpu_rk_device_resident_step(") == std::string::npos,
        "GPU CUDA RK snapshot source must not own RK step orchestration");
    check(
        snapshot_fallback.find("GPU CUDA RK snapshot fallback source contract") !=
                std::string::npos &&
            snapshot_fallback.find("bool gpu_rk_snapshot_current_state(") !=
                std::string::npos &&
            snapshot_fallback.find("#if !FULLMAG_HAS_CUDA_RUNTIME") !=
                std::string::npos,
        "GPU CUDA RK snapshot fallback source must own the no-CUDA snapshot implementation");
}

void gpu_rk_step_stats_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string stats_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.hpp");
    const std::string stats_fallback =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cpp");
    const std::string stats_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_stats.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final stats no-CUDA fallback from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_stats.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final stats helpers from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK final stats module");
    check(
        stats_header.find("GPU CUDA RK final step stats module header") !=
                std::string::npos &&
            stats_header.find("enum class GpuFinalScalarSlot") !=
                std::string::npos &&
            stats_header.find("gpu_rk_final_scalar_result(") !=
                std::string::npos &&
            stats_header.find("gpu_rk_finalize_step_stats(") !=
                std::string::npos,
        "GPU CUDA RK final stats header must own scalar slots, scalar result access, and final stats declaration");
    check(
        stats_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            stats_source.find("GPU CUDA RK final step stats source contract") !=
                std::string::npos,
        "GPU CUDA RK final stats source must document and include its module header");
    check(
        stats_source.find("gpu_rk_finalize_step_stats(") !=
                std::string::npos &&
            stats_source.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") !=
                std::string::npos &&
            stats_source.find("fullmag_cuda_magnetization_sum_blocks(") !=
                std::string::npos &&
            stats_source.find("gpu_rk_read_scalar_results(") !=
                std::string::npos &&
            stats_source.find("context_update_stage_completion_from_stats(ctx, stats)") !=
                std::string::npos,
        "GPU CUDA RK final stats source must own energy reductions, average magnetization, scalar readback, and stats publication");
    check(
        stats_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            stats_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK final stats source must not own RK step orchestration or RHS assembly");
    check(
        stats_fallback.find("GPU CUDA RK final step stats fallback source contract") !=
                std::string::npos &&
            stats_fallback.find("bool gpu_rk_finalize_step_stats(") !=
                std::string::npos &&
            stats_fallback.find("#if !FULLMAG_HAS_CUDA_RUNTIME") !=
                std::string::npos,
        "GPU CUDA RK final stats fallback source must own the no-CUDA final stats implementation");
}

void gpu_demag_poisson_is_owned_by_cuda_demag_poisson_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "poisson.hpp");
    const std::string operators_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "operators.hpp");
    const std::string hypre_solver_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.hpp");
    const std::string stage_compute_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.hpp");
    const std::string module =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "poisson.cpp");
    const std::string operators =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "operators.cpp");
    const std::string hypre_solver =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
    const std::string stage_compute =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");

    check(
        cmake.find("gpu/cuda/demag_poisson/poisson.cpp") != std::string::npos,
        "FEM CMake source list must build GPU Poisson demag from gpu/cuda/demag_poisson");
    check(
        cmake.find("gpu/cuda/demag_poisson/operators.cpp") != std::string::npos,
        "FEM CMake source list must build GPU Poisson demag operator setup separately");
    check(
        cmake.find("gpu/cuda/demag_poisson/hypre_device_solver.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU Poisson demag Hypre solver setup separately");
    check(
        cmake.find("gpu/cuda/demag_poisson/stage_compute.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU Poisson demag stage compute separately");
    check(
        cmake.find("gpu/cuda/demag/poisson.cpp") == std::string::npos,
        "FEM CMake source list must not build GPU Poisson demag from transitional gpu/cuda/demag path");
    check(
        cmake.find("src/gpu_demag_poisson.cpp") == std::string::npos,
        "FEM CMake source list must not build GPU Poisson demag from legacy src path");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "demag"),
        "GPU Poisson demag module must not remain in transitional gpu/cuda/demag");
    check(
        !std::filesystem::exists(root / "include" / "gpu_demag_poisson.hpp"),
        "GPU Poisson demag header must not remain in root include");
    check(
        header.find("GPU CUDA Poisson demag module header") != std::string::npos,
        "GPU CUDA Poisson demag header must document its module ownership");
    check(
        operators_header.find("GPU CUDA Poisson demag operator workspace header") !=
                std::string::npos &&
            operators_header.find("struct GpuDemagPoissonWorkspace") !=
                std::string::npos,
        "GPU CUDA Poisson demag operator workspace header must own workspace and CSR types");
    check(
        hypre_solver_header.find("GPU CUDA Poisson demag Hypre device solver header") !=
                std::string::npos &&
            hypre_solver_header.find("bool initialize_demag_poisson_hypre_device_solver(") !=
                std::string::npos,
        "GPU CUDA Poisson demag Hypre solver header must declare solver setup");
    check(
        stage_compute_header.find("GPU CUDA Poisson demag stage compute header") !=
                std::string::npos &&
            stage_compute_header.find("bool compute_device_demag_for_device_stage(") !=
                std::string::npos,
        "GPU CUDA Poisson demag stage compute header must declare stage compute");
    check(
        header.find("bool gpu_demag_poisson_initialize(") != std::string::npos &&
            header.find("bool compute_device_demag_for_device_stage(") ==
                std::string::npos,
        "GPU CUDA Poisson demag lifecycle header must not declare stage compute");
    check(
        module.find("#include \"gpu/cuda/demag_poisson/poisson.hpp\"") !=
            std::string::npos,
        "GPU CUDA Poisson demag source must include its module-owned header");
    check(
        module.find("#include \"gpu/cuda/demag_poisson/operators.hpp\"") !=
            std::string::npos,
        "GPU CUDA Poisson demag lifecycle source must use the operator workspace module");
    check(
        module.find("#include \"gpu/cuda/demag_poisson/hypre_device_solver.hpp\"") !=
            std::string::npos,
        "GPU CUDA Poisson demag lifecycle source must use the Hypre device solver module");
    check(
        module.find("GPU CUDA Poisson demag source contract") != std::string::npos,
        "GPU CUDA Poisson demag module must document its source contract");
    check(
        module.find("bool gpu_demag_poisson_initialize(") != std::string::npos &&
            module.find("bool compute_device_demag_for_device_stage(") ==
                std::string::npos,
        "GPU CUDA Poisson demag lifecycle source must not own stage compute");
    check(
        module.find("bool build_p1_demag_operators(") == std::string::npos &&
            module.find("bool upload_triple(") == std::string::npos &&
            module.find("void destroy_triple(") == std::string::npos,
        "GPU CUDA Poisson demag lifecycle source must not own CSR operator build/upload/destroy helpers");
    check(
        module.find("mfem::Hypre::Init()") == std::string::npos &&
            module.find("HypreBoomerAMG") == std::string::npos &&
            module.find("HyprePCG") == std::string::npos &&
            module.find("HypreGMRES") == std::string::npos,
        "GPU CUDA Poisson demag lifecycle source must not own Hypre solver policy/setup");
    check(
        operators.find("#include \"gpu/cuda/demag_poisson/operators.hpp\"") !=
                std::string::npos &&
            operators.find("GPU CUDA Poisson demag operator workspace source contract") !=
                std::string::npos,
        "GPU CUDA Poisson demag operators source must document and include its module header");
    check(
        operators.find("bool build_p1_demag_operators(") != std::string::npos &&
            operators.find("bool upload_demag_poisson_operators(") !=
                std::string::npos &&
            operators.find("void destroy_demag_poisson_operators(") !=
                std::string::npos,
        "GPU CUDA Poisson demag operators module must own P1 operator build/upload/destroy helpers");
    check(
        hypre_solver.find("#include \"gpu/cuda/demag_poisson/hypre_device_solver.hpp\"") !=
                std::string::npos &&
            hypre_solver.find("GPU CUDA Poisson demag Hypre device solver source contract") !=
                std::string::npos,
        "GPU CUDA Poisson demag Hypre solver source must document and include its module header");
    check(
        hypre_solver.find("bool initialize_demag_poisson_hypre_device_solver(") !=
                std::string::npos &&
            hypre_solver.find("void read_demag_poisson_hypre_solver_stats(") !=
                std::string::npos &&
            hypre_solver.find("HypreBoomerAMG") != std::string::npos,
        "GPU CUDA Poisson demag Hypre solver module must own solver policy setup and iteration stats");
    check(
        stage_compute.find("#include \"gpu/cuda/demag_poisson/stage_compute.hpp\"") !=
                std::string::npos &&
            stage_compute.find("GPU CUDA Poisson demag stage compute source contract") !=
                std::string::npos,
        "GPU CUDA Poisson demag stage compute source must document and include its module header");
    check(
        stage_compute.find("bool compute_device_demag_for_device_stage(") !=
                std::string::npos &&
            stage_compute.find("fullmag_cuda_demag_rhs_csr(") !=
                std::string::npos &&
            stage_compute.find("fullmag_cuda_demag_recovery_csr(") !=
                std::string::npos &&
            stage_compute.find("fullmag_cuda_demag_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA Poisson demag stage compute module must own RHS/solve/recovery/energy orchestration");
    check(
        module.find("does not own public DSL semantics, MFEM context construction, RK stage orchestration, exchange, local interaction kernels, or C ABI entrypoints") !=
            std::string::npos,
        "GPU CUDA Poisson demag module must document its non-owning module boundary");
}

void cuda_kernels_are_owned_by_cuda_kernels_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");

    check(
        cmake.find("src/kernels.cu") == std::string::npos,
        "FEM CMake source list must not build CUDA kernels from legacy src path");
    check(
        !std::filesystem::exists(root / "include" / "kernels.h"),
        "GPU CUDA kernels header must not remain in root include");
    check(
        header.find("GPU CUDA kernels module header") != std::string::npos,
        "GPU CUDA kernels header must document its module ownership");
    check(
        header.find("#include \"gpu/cuda/fields/vector_field_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the vector field kernel module");
    check(
        cmake.find("gpu/cuda/kernels/kernels.cu") == std::string::npos,
        "FEM CMake source list must not build an owning CUDA kernels umbrella source");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "kernels" / "kernels.cu"),
        "GPU CUDA kernels umbrella source must be removed after owner-module extraction");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "kernels" / "kernels.cu") ||
            kernels.find("fullmag_cuda_normalize_vectors(") == std::string::npos,
        "GPU CUDA kernels source must not own vector field kernels");
    check(
        header.find("fullmag_cuda_normalize_vectors(") == std::string::npos &&
            header.find("fullmag_cuda_accumulate_heff(") == std::string::npos &&
            header.find("fullmag_cuda_zero_indexed_values(") == std::string::npos &&
            header.find("fullmag_cuda_add_field_inplace(") == std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare vector field wrappers");
    check(
        header.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos &&
            kernels.find("llg_rhs_fused_kernel") == std::string::npos &&
            kernels.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos,
        "GPU CUDA shared kernels module must not own LLG RHS kernels");
    check(
        header.find("void fullmag_cuda_device_max(") == std::string::npos &&
            header.find("void fullmag_cuda_device_sum(") == std::string::npos &&
            kernels.find("void fullmag_cuda_device_max(") == std::string::npos &&
            kernels.find("void fullmag_cuda_device_sum(") == std::string::npos,
        "GPU CUDA shared kernels module must not own device-wide reductions");
    check(
        header.find("fullmag_cuda_upload_aos_to_soa(") == std::string::npos &&
            header.find("fullmag_cuda_download_soa_to_aos(") == std::string::npos &&
            kernels.find("fullmag_cuda_upload_aos_to_soa(") == std::string::npos &&
            kernels.find("fullmag_cuda_download_soa_to_aos(") == std::string::npos,
        "GPU CUDA shared kernels module must not own AoS/SoA transfer kernels");
    check(
        header.find("void fullmag_cuda_adaptive_error_norm_blocks(") ==
                std::string::npos &&
            kernels.find("adaptive_error_norm_blocks_kernel") ==
                std::string::npos &&
            kernels.find("void fullmag_cuda_adaptive_error_norm_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels module must not own RK adaptive-error kernels");
    check(
        header.find("compatibility umbrella header") != std::string::npos,
        "GPU CUDA kernels header must document that it is only a compatibility umbrella");
}

void gpu_cuda_vector_field_kernels_are_owned_by_cuda_fields_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string fields_header =
        read_text_file(root / "gpu" / "cuda" / "fields" / "vector_field_kernels.hpp");
    const std::string fields_source =
        read_text_file(root / "gpu" / "cuda" / "fields" / "vector_field_kernels.cu");

    check(
        cmake.find("gpu/cuda/fields/vector_field_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA vector field kernels from gpu/cuda/fields");
    check(
        kernels_header.find("#include \"gpu/cuda/fields/vector_field_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the vector field kernel module");
    check(
        fields_header.find("GPU CUDA vector field kernels module header") !=
                std::string::npos &&
            fields_header.find("fullmag_cuda_normalize_vectors(") !=
                std::string::npos &&
            fields_header.find("fullmag_cuda_accumulate_heff(") !=
                std::string::npos &&
            fields_header.find("fullmag_cuda_zero_indexed_values(") !=
                std::string::npos &&
            fields_header.find("fullmag_cuda_add_field_inplace(") !=
                std::string::npos,
        "GPU CUDA vector field kernels header must own vector field wrapper declarations");
    check(
        fields_source.find("#include \"gpu/cuda/fields/vector_field_kernels.hpp\"") !=
                std::string::npos &&
            fields_source.find("GPU CUDA vector field kernels source contract") !=
                std::string::npos,
        "GPU CUDA vector field kernels source must document and include its module header");
    check(
        fields_source.find("normalize_unit_vectors_kernel") !=
                std::string::npos &&
            fields_source.find("accumulate_heff_kernel") !=
                std::string::npos &&
            fields_source.find("zero_indexed_values_kernel") !=
                std::string::npos &&
            fields_source.find("add_field_inplace_kernel") !=
                std::string::npos,
        "GPU CUDA vector field kernels source must own normalize, accumulate, zero, and add kernels");
    check(
        fields_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            fields_source.find("cudaMemcpy2D") == std::string::npos &&
            fields_source.find("llg_rhs_fused_kernel") == std::string::npos,
        "GPU CUDA vector field kernels source must not own RK orchestration, transfer wrappers, or LLG RHS");
}

void gpu_cuda_transfer_kernels_are_owned_by_cuda_transfer_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string transfer_header =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_kernels.hpp");
    const std::string transfer_source =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_kernels.cu");

    check(
        cmake.find("gpu/cuda/transfer/transfer_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA transfer kernels from gpu/cuda/transfer");
    check(
        kernels_header.find("#include \"gpu/cuda/transfer/transfer_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the transfer kernel module");
    check(
        transfer_header.find("GPU CUDA transfer kernels module header") !=
                std::string::npos &&
            transfer_header.find("fullmag_cuda_upload_aos_to_soa(") !=
                std::string::npos &&
            transfer_header.find("fullmag_cuda_download_soa_to_aos(") !=
                std::string::npos,
        "GPU CUDA transfer kernels header must own AoS/SoA transfer declarations");
    check(
        transfer_source.find("#include \"gpu/cuda/transfer/transfer_kernels.hpp\"") !=
                std::string::npos &&
            transfer_source.find("GPU CUDA transfer kernels source contract") !=
                std::string::npos,
        "GPU CUDA transfer kernels source must document and include its module header");
    check(
        transfer_source.find("cudaMemcpy2D") !=
                std::string::npos &&
            transfer_source.find("cudaMemcpyHostToDevice") !=
                std::string::npos &&
            transfer_source.find("cudaMemcpyDeviceToHost") !=
                std::string::npos &&
            transfer_source.find("fullmag_cuda_upload_aos_to_soa(") !=
                std::string::npos &&
            transfer_source.find("fullmag_cuda_download_soa_to_aos(") !=
                std::string::npos,
        "GPU CUDA transfer kernels source must own AoS/SoA cudaMemcpy2D wrappers");
    check(
        transfer_source.find("llg_rhs_fused_kernel") == std::string::npos &&
            transfer_source.find("gpu_rk_device_resident_step(") ==
                std::string::npos,
        "GPU CUDA transfer kernels source must not own physics kernels or RK orchestration");
    check(
        kernels_header.find("fullmag_cuda_upload_aos_to_soa(") == std::string::npos &&
            kernels_header.find("fullmag_cuda_download_soa_to_aos(") == std::string::npos &&
            kernels_source.find("fullmag_cuda_upload_aos_to_soa(") == std::string::npos &&
            kernels_source.find("fullmag_cuda_download_soa_to_aos(") == std::string::npos,
        "GPU CUDA shared kernels module must not directly own transfer wrappers");
}

void gpu_cuda_llg_rhs_kernels_are_owned_by_cuda_llg_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string llg_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "llg" / "llg_rhs_kernels.hpp");
    const std::string llg_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "llg" / "llg_rhs_kernels.cu");

    check(
        cmake.find("gpu/cuda/integrators/llg/llg_rhs_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA LLG RHS kernels from gpu/cuda/integrators/llg");
    check(
        kernels_header.find("#include \"gpu/cuda/integrators/llg/llg_rhs_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the LLG RHS kernel module");
    check(
        llg_header.find("GPU CUDA LLG RHS kernels module header") !=
                std::string::npos &&
            llg_header.find("fullmag_cuda_llg_rhs_fused(") !=
                std::string::npos &&
            llg_header.find("bool precession_enabled") !=
                std::string::npos,
        "GPU CUDA LLG RHS kernels header must own fused LLG RHS declarations");
    check(
        llg_source.find("#include \"gpu/cuda/integrators/llg/llg_rhs_kernels.hpp\"") !=
                std::string::npos &&
            llg_source.find("GPU CUDA LLG RHS kernels source contract") !=
                std::string::npos,
        "GPU CUDA LLG RHS kernels source must document and include its module header");
    check(
        llg_source.find("llg_rhs_fused_kernel") !=
                std::string::npos &&
            llg_source.find("use_alpha_field ? alpha_field[i] : uniform_alpha") !=
                std::string::npos &&
            llg_source.find("const double precession_scale = precession_enabled ? 1.0 : 0.0") !=
                std::string::npos &&
            llg_source.find("BlockReduce<double, 256>") !=
                std::string::npos &&
            llg_source.find("fullmag_cuda_llg_rhs_fused(") !=
                std::string::npos,
        "GPU CUDA LLG RHS kernels source must own fused RHS and block max reduction");
    check(
        llg_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            llg_source.find("cudaMemcpy2D") == std::string::npos,
        "GPU CUDA LLG RHS kernels source must not own RK orchestration or transfer wrappers");
    check(
        kernels_header.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos &&
            kernels_source.find("llg_rhs_fused_kernel") == std::string::npos &&
            kernels_source.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos,
        "GPU CUDA shared kernels module must not directly own LLG RHS wrappers");
}

void gpu_cuda_reduction_kernels_are_owned_by_cuda_reductions_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string reductions_header =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_kernels.hpp");
    const std::string reductions_source =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_kernels.cu");

    check(
        cmake.find("gpu/cuda/reductions/reduction_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA reductions from gpu/cuda/reductions");
    check(
        kernels_header.find("#include \"gpu/cuda/reductions/reduction_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the reduction kernel module");
    check(
        reductions_header.find("GPU CUDA reduction kernels module header") !=
                std::string::npos &&
            reductions_header.find("fullmag_cuda_device_max(") !=
                std::string::npos &&
            reductions_header.find("fullmag_cuda_device_sum(") !=
                std::string::npos,
        "GPU CUDA reduction kernels header must own device-wide reduction declarations");
    check(
        reductions_source.find("#include \"gpu/cuda/reductions/reduction_kernels.hpp\"") !=
                std::string::npos &&
            reductions_source.find("GPU CUDA reduction kernels source contract") !=
                std::string::npos,
        "GPU CUDA reduction kernels source must document and include its module header");
    check(
        reductions_source.find("cub::DeviceReduce::Max") !=
                std::string::npos &&
            reductions_source.find("cub::DeviceReduce::Sum") !=
                std::string::npos &&
            reductions_source.find("fullmag_cuda_device_max(") !=
                std::string::npos &&
            reductions_source.find("fullmag_cuda_device_sum(") !=
                std::string::npos,
        "GPU CUDA reduction kernels source must own device-wide max and sum wrappers");
    check(
        reductions_source.find("llg_rhs_fused_kernel") == std::string::npos &&
            reductions_source.find("gpu_rk_device_resident_step(") ==
                std::string::npos,
        "GPU CUDA reduction kernels source must not own physics kernels or RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_device_max(") == std::string::npos &&
            kernels_header.find("void fullmag_cuda_device_sum(") == std::string::npos &&
            kernels_source.find("void fullmag_cuda_device_max(") == std::string::npos &&
            kernels_source.find("void fullmag_cuda_device_sum(") == std::string::npos,
        "GPU CUDA shared kernels module must not directly own reduction wrappers");
}

void gpu_rk_adaptive_error_kernels_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string rk_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "adaptive_error_kernels.hpp");
    const std::string rk_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "adaptive_error_kernels.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/adaptive_error_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive-error CUDA kernels from gpu/cuda/integrators/rk");
    check(
        kernels_header.find("#include \"gpu/cuda/integrators/rk/adaptive_error_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the RK adaptive-error kernel module");
    check(
        rk_header.find("GPU CUDA RK adaptive-error kernels module header") !=
                std::string::npos &&
            rk_header.find("fullmag_cuda_adaptive_error_norm_blocks(") !=
                std::string::npos,
        "GPU CUDA RK adaptive-error kernels header must own adaptive error wrapper declarations");
    check(
        rk_source.find("#include \"gpu/cuda/integrators/rk/adaptive_error_kernels.hpp\"") !=
                std::string::npos &&
            rk_source.find("GPU CUDA RK adaptive-error kernels source contract") !=
                std::string::npos,
        "GPU CUDA RK adaptive-error kernels source must document and include its module header");
    check(
        rk_source.find("adaptive_error_norm_blocks_kernel") !=
                std::string::npos &&
            rk_source.find("b_hi0") != std::string::npos &&
            rk_source.find("b_lo0") != std::string::npos &&
            rk_source.find("sqrt(err_x * err_x + err_y * err_y + err_z * err_z)") !=
                std::string::npos &&
            rk_source.find("BlockReduce<double, 256>") !=
                std::string::npos &&
            rk_source.find("fullmag_cuda_adaptive_error_norm_blocks(") !=
                std::string::npos,
        "GPU CUDA RK adaptive-error kernels source must own embedded error block reduction");
    check(
        rk_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            rk_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK adaptive-error kernels source must not own RK step orchestration");
    check(
        kernels_header.find("void fullmag_cuda_adaptive_error_norm_blocks(") ==
            std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare RK adaptive-error wrappers");
    check(
        kernels_source.find("adaptive_error_norm_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_adaptive_error_norm_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own RK adaptive-error kernel implementations");
}

void gpu_rk_stage_kernels_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string rk_stage_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_kernels.hpp");
    const std::string rk_stage_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_kernels.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_stage_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK stage CUDA kernels from gpu/cuda/integrators/rk");
    check(
        kernels_header.find("#include \"gpu/cuda/integrators/rk/rk_stage_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the RK stage kernel module");
    check(
        rk_stage_header.find("GPU CUDA RK stage kernels module header") !=
                std::string::npos &&
            rk_stage_header.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            rk_stage_header.find("fullmag_cuda_rk45_stage(") !=
                std::string::npos &&
            rk_stage_header.find("fullmag_cuda_heun_accept(") !=
                std::string::npos &&
            rk_stage_header.find("fullmag_cuda_rk4_accept(") !=
                std::string::npos &&
            rk_stage_header.find("fullmag_cuda_bs23_accept(") !=
                std::string::npos &&
            rk_stage_header.find("fullmag_cuda_dp54_accept(") !=
                std::string::npos,
        "GPU CUDA RK stage kernels header must own stage and accept wrapper declarations");
    check(
        rk_stage_source.find("#include \"gpu/cuda/integrators/rk/rk_stage_kernels.hpp\"") !=
                std::string::npos &&
            rk_stage_source.find("GPU CUDA RK stage kernels source contract") !=
                std::string::npos,
        "GPU CUDA RK stage kernels source must document and include its module header");
    check(
        rk_stage_source.find("euler_stage_kernel") !=
                std::string::npos &&
            rk_stage_source.find("rk45_stage_kernel") !=
                std::string::npos &&
            rk_stage_source.find("heun_accept_kernel") !=
                std::string::npos &&
            rk_stage_source.find("rk4_accept_kernel") !=
                std::string::npos &&
            rk_stage_source.find("bs23_accept_kernel") !=
                std::string::npos &&
            rk_stage_source.find("dp54_accept_kernel") !=
                std::string::npos,
        "GPU CUDA RK stage kernels source must own stage predictor and accept kernels");
    check(
        rk_stage_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            rk_stage_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK stage kernels source must not own RK orchestration or RHS assembly");
    check(
        rk_step.find("__global__ void euler_stage_kernel") == std::string::npos &&
            rk_step.find("__global__ void rk45_stage_kernel") == std::string::npos &&
            rk_step.find("__global__ void heun_accept_kernel") == std::string::npos &&
            rk_step.find("__global__ void rk4_accept_kernel") == std::string::npos &&
            rk_step.find("__global__ void bs23_accept_kernel") == std::string::npos &&
            rk_step.find("__global__ void dp54_accept_kernel") == std::string::npos,
        "GPU CUDA RK step orchestration source must not own RK stage kernel implementations");
}

void gpu_rk_device_io_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string io_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_device_io.hpp");
    const std::string io_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_device_io.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_device_io.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK device I/O helpers from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK device I/O module");
    check(
        io_header.find("GPU CUDA RK device I/O module header") !=
                std::string::npos &&
            io_header.find("gpu_rk_read_scalar_result(") !=
                std::string::npos &&
            io_header.find("gpu_rk_read_scalar_results(") !=
                std::string::npos &&
            io_header.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            io_header.find("gpu_rk_download_component_device_to_aos(") !=
                std::string::npos,
        "GPU CUDA RK device I/O header must own scalar read and component copy declarations");
    check(
        io_source.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") !=
                std::string::npos &&
            io_source.find("GPU CUDA RK device I/O source contract") !=
                std::string::npos,
        "GPU CUDA RK device I/O source must document and include its module header");
    check(
        io_source.find("cudaMemcpyAsync") !=
                std::string::npos &&
            io_source.find("cudaMemcpy2DAsync") !=
                std::string::npos &&
            io_source.find("cudaStreamSynchronize") !=
                std::string::npos &&
            io_source.find("record_device_to_host") !=
                std::string::npos,
        "GPU CUDA RK device I/O source must own scalar read, component copy, and audited device-to-host transfers");
    check(
        io_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            io_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK device I/O source must not own RK orchestration or RHS assembly");
    check(
        rk_step.find("bool read_scalar_result(") == std::string::npos &&
            rk_step.find("bool read_scalar_results(") == std::string::npos &&
            rk_step.find("bool copy_component_device(") == std::string::npos &&
            rk_step.find("bool download_component_device_to_aos(") == std::string::npos &&
            rk_step.find("cudaMemcpy2DAsync(") == std::string::npos,
        "GPU CUDA RK step source must not own low-level device I/O helper implementations");
}

void gpu_rk_adaptive_runtime_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string adaptive_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_runtime.hpp");
    const std::string adaptive_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_runtime.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_adaptive_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive runtime helpers from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK adaptive runtime module");
    check(
        adaptive_header.find("GPU CUDA RK adaptive runtime module header") !=
                std::string::npos &&
            adaptive_header.find("struct GpuAdaptiveResult") !=
                std::string::npos &&
            adaptive_header.find("gpu_rk_adaptive_pi_step(") !=
                std::string::npos &&
            adaptive_header.find("gpu_rk_restore_adaptive_reject_magnetization_device(") !=
                std::string::npos &&
            adaptive_header.find("gpu_rk_compute_adaptive_error_norm_device(") !=
                std::string::npos,
        "GPU CUDA RK adaptive runtime header must own adaptive result, PI step, reject restore, and error norm declarations");
    check(
        adaptive_source.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") !=
                std::string::npos &&
            adaptive_source.find("GPU CUDA RK adaptive runtime source contract") !=
                std::string::npos,
        "GPU CUDA RK adaptive runtime source must document and include its module header");
    check(
        adaptive_source.find("fullmag_cuda_adaptive_error_norm_blocks(") !=
                std::string::npos &&
            adaptive_source.find("gpu_rk_read_scalar_result(") !=
                std::string::npos &&
            adaptive_source.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            adaptive_source.find("ctx.adaptive_dt.prev_error_norm") !=
                std::string::npos,
        "GPU CUDA RK adaptive runtime source must own adaptive PI, reject restore, and device error norm helpers");
    check(
        adaptive_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            adaptive_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK adaptive runtime source must not own RK step orchestration or RHS assembly");
    check(
        rk_step.find("GpuAdaptiveResult gpu_adaptive_pi_step(") == std::string::npos &&
            rk_step.find("bool restore_adaptive_reject_magnetization_device(") ==
                std::string::npos &&
            rk_step.find("bool compute_adaptive_error_norm_device(") ==
                std::string::npos,
        "GPU CUDA RK step source must not own adaptive runtime helper implementations");
}

void gpu_rk_rhs_runtime_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string rhs_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.hpp");
    const std::string rhs_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_rhs_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK RHS runtime helpers from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_rhs_runtime.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK RHS runtime module");
    check(
        rhs_header.find("GPU CUDA RK RHS runtime module header") !=
                std::string::npos &&
            rhs_header.find("gpu_rk_rhs_allows_fsal_reuse(") !=
                std::string::npos &&
            rhs_header.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos,
        "GPU CUDA RK RHS runtime header must own FSAL gating and RHS declarations");
    check(
        rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_rhs_runtime.hpp\"") !=
                std::string::npos &&
            rhs_source.find("GPU CUDA RK RHS runtime source contract") !=
                std::string::npos,
        "GPU CUDA RK RHS runtime source must document and include its module header");
    check(
        rhs_source.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_legacy_sparse_exchange(") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_hybrid_cpu_demag_for_device_stage(") !=
                std::string::npos &&
            rhs_source.find("fullmag_cuda_llg_rhs_fused(") !=
                std::string::npos,
        "GPU CUDA RK RHS runtime source must own exchange, demag dispatch, local-field accumulation, and LLG RHS orchestration");
    check(
        rhs_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            rhs_source.find("gpu_rk_finalize_step_stats(") == std::string::npos,
        "GPU CUDA RK RHS runtime source must not own RK step orchestration or final stats");
    check(
        rk_step.find("bool compute_rhs_for_magnetization(") == std::string::npos &&
            rk_step.find("bool compute_legacy_sparse_exchange(") == std::string::npos &&
            rk_step.find("bool compute_hybrid_cpu_demag_for_device_stage(") ==
                std::string::npos,
        "GPU CUDA RK step source must not own RHS runtime helper implementations");
}

void gpu_dmi_kernels_are_owned_by_cuda_dmi_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string dmi_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.hpp");
    const std::string dmi_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/dmi/dmi_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU DMI CUDA kernels from gpu/cuda/interactions/dmi");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/dmi/dmi_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the DMI kernel module");
    check(
        dmi_header.find("GPU CUDA DMI kernels module header") !=
                std::string::npos &&
            dmi_header.find("fullmag_cuda_dmi_field_energy(") !=
                std::string::npos,
        "GPU CUDA DMI kernels header must own DMI wrapper declarations");
    check(
        dmi_source.find("#include \"gpu/cuda/interactions/dmi/dmi_kernels.hpp\"") !=
                std::string::npos &&
            dmi_source.find("GPU CUDA DMI kernels source contract") !=
                std::string::npos,
        "GPU CUDA DMI kernels source must document and include its module header");
    check(
        dmi_source.find("dmi_element_residual_kernel") != std::string::npos &&
            dmi_source.find("dmi_project_field_kernel") != std::string::npos &&
            dmi_source.find("fullmag_cuda_dmi_field_energy(") !=
                std::string::npos &&
            dmi_source.find("bulk_mode") != std::string::npos,
        "GPU CUDA DMI kernels source must own interfacial/bulk DMI kernels and wrapper");
    check(
        dmi_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            dmi_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA DMI kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_dmi_field_energy(") ==
            std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare DMI wrappers");
    check(
        kernels_source.find("dmi_element_residual_kernel") ==
                std::string::npos &&
            kernels_source.find("dmi_project_field_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_dmi_field_energy(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own DMI kernel implementations");
}

void gpu_stt_kernels_are_owned_by_cuda_stt_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string stt_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.hpp");
    const std::string stt_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/stt/stt_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU STT CUDA kernels from gpu/cuda/interactions/stt");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/stt/stt_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the STT kernel module");
    check(
        stt_header.find("GPU CUDA STT kernels module header") !=
                std::string::npos &&
            stt_header.find("fullmag_cuda_add_slonczewski_stt_rhs(") !=
                std::string::npos &&
            stt_header.find("fullmag_cuda_add_zhang_li_stt_rhs(") !=
                std::string::npos,
        "GPU CUDA STT kernels header must own Slonczewski and Zhang-Li wrapper declarations");
    check(
        stt_source.find("#include \"gpu/cuda/interactions/stt/stt_kernels.hpp\"") !=
                std::string::npos &&
            stt_source.find("GPU CUDA STT kernels source contract") !=
                std::string::npos,
        "GPU CUDA STT kernels source must document and include its module header");
    check(
        stt_source.find("slonczewski_stt_rhs_kernel") != std::string::npos &&
            stt_source.find("zhang_li_element_rhs_kernel") !=
                std::string::npos &&
            stt_source.find("zhang_li_normalize_add_rhs_kernel") !=
                std::string::npos &&
            stt_source.find("fullmag_cuda_add_slonczewski_stt_rhs(") !=
                std::string::npos &&
            stt_source.find("fullmag_cuda_add_zhang_li_stt_rhs(") !=
                std::string::npos,
        "GPU CUDA STT kernels source must own Slonczewski and Zhang-Li kernels and wrappers");
    check(
        stt_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            stt_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA STT kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_add_slonczewski_stt_rhs(") ==
                std::string::npos &&
            kernels_header.find("void fullmag_cuda_add_zhang_li_stt_rhs(") ==
                std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare STT wrappers");
    check(
        kernels_source.find("slonczewski_stt_rhs_kernel") ==
                std::string::npos &&
            kernels_source.find("zhang_li_element_rhs_kernel") ==
                std::string::npos &&
            kernels_source.find("zhang_li_normalize_add_rhs_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_add_slonczewski_stt_rhs(") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_add_zhang_li_stt_rhs(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own STT kernel implementations");
}

void gpu_thermal_kernels_are_owned_by_cuda_thermal_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string thermal_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "thermal" / "thermal_kernels.hpp");
    const std::string thermal_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "thermal" / "thermal_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/thermal/thermal_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU thermal CUDA kernels from gpu/cuda/interactions/thermal");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/thermal/thermal_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the thermal kernel module");
    check(
        thermal_header.find("GPU CUDA thermal kernels module header") !=
                std::string::npos &&
            thermal_header.find("fullmag_cuda_thermal_field_blocks(") !=
                std::string::npos,
        "GPU CUDA thermal kernels header must own Brown thermal wrapper declarations");
    check(
        thermal_source.find("#include \"gpu/cuda/interactions/thermal/thermal_kernels.hpp\"") !=
                std::string::npos &&
            thermal_source.find("GPU CUDA thermal kernels source contract") !=
                std::string::npos,
        "GPU CUDA thermal kernels source must document and include its module header");
    check(
        thermal_source.find("thermal_field_blocks_kernel") !=
                std::string::npos &&
            thermal_source.find("deterministic_normal") != std::string::npos &&
            thermal_source.find("splitmix64_next") != std::string::npos &&
            thermal_source.find("fullmag_cuda_thermal_field_blocks(") !=
                std::string::npos,
        "GPU CUDA thermal kernels source must own Brown thermal RNG, kernel, and wrapper");
    check(
        thermal_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            thermal_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA thermal kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_thermal_field_blocks(") ==
            std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare thermal wrappers");
    check(
        kernels_source.find("thermal_field_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("deterministic_normal") == std::string::npos &&
            kernels_source.find("splitmix64_next") == std::string::npos &&
            kernels_source.find("void fullmag_cuda_thermal_field_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own thermal kernel implementations");
}

void gpu_anisotropy_kernels_are_owned_by_cuda_anisotropy_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string anis_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "anisotropy" / "anisotropy_kernels.hpp");
    const std::string anis_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "anisotropy" / "anisotropy_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU anisotropy CUDA kernels from gpu/cuda/interactions/anisotropy");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the anisotropy kernel module");
    check(
        anis_header.find("GPU CUDA anisotropy kernels module header") !=
                std::string::npos &&
            anis_header.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            anis_header.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA anisotropy kernels header must own uniaxial and cubic wrapper declarations");
    check(
        anis_source.find("#include \"gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp\"") !=
                std::string::npos &&
            anis_source.find("GPU CUDA anisotropy kernels source contract") !=
                std::string::npos,
        "GPU CUDA anisotropy kernels source must document and include its module header");
    check(
        anis_source.find("uniaxial_anisotropy_field_energy_blocks_kernel") !=
                std::string::npos &&
            anis_source.find("cubic_anisotropy_field_energy_blocks_kernel") !=
                std::string::npos &&
            anis_source.find("2.0 * ku_i / (kMu0 * ms_i)") !=
                std::string::npos &&
            anis_source.find("const double pf1 = -2.0 * kc1_i * inv_mu0_ms") !=
                std::string::npos &&
            anis_source.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            anis_source.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA anisotropy kernels source must own uniaxial/cubic field, energy, and wrappers");
    check(
        anis_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            anis_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA anisotropy kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") ==
                std::string::npos &&
            kernels_header.find("void fullmag_cuda_cubic_anisotropy_field_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare anisotropy wrappers");
    check(
        kernels_source.find("uniaxial_anisotropy_field_energy_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("cubic_anisotropy_field_energy_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_cubic_anisotropy_field_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own anisotropy kernel implementations");
}

void gpu_zeeman_kernels_are_owned_by_cuda_zeeman_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string zeeman_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "zeeman" / "zeeman_kernels.hpp");
    const std::string zeeman_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "zeeman" / "zeeman_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/zeeman/zeeman_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU Zeeman CUDA kernels from gpu/cuda/interactions/zeeman");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/zeeman/zeeman_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the Zeeman kernel module");
    check(
        zeeman_header.find("GPU CUDA Zeeman kernels module header") !=
                std::string::npos &&
            zeeman_header.find("fullmag_cuda_external_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA Zeeman kernels header must own external-energy wrapper declarations");
    check(
        zeeman_source.find("#include \"gpu/cuda/interactions/zeeman/zeeman_kernels.hpp\"") !=
                std::string::npos &&
            zeeman_source.find("GPU CUDA Zeeman kernels source contract") !=
                std::string::npos,
        "GPU CUDA Zeeman kernels source must document and include its module header");
    check(
        zeeman_source.find("external_energy_blocks_kernel") !=
                std::string::npos &&
            zeeman_source.find("-kMu0 * ms[i] * mdoth * lumped_mass[i]") !=
                std::string::npos &&
            zeeman_source.find("fullmag_cuda_external_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA Zeeman kernels source must own external-field energy and wrapper");
    check(
        zeeman_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            zeeman_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA Zeeman kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_external_energy_blocks(") ==
            std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare Zeeman wrappers");
    check(
        kernels_source.find("external_energy_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_external_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own Zeeman kernel implementations");
}

void gpu_oersted_kernels_are_owned_by_cuda_oersted_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string oersted_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "oersted" / "oersted_kernels.hpp");
    const std::string oersted_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "oersted" / "oersted_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/oersted/oersted_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU Oersted CUDA kernels from gpu/cuda/interactions/oersted");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/oersted/oersted_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the Oersted kernel module");
    check(
        oersted_header.find("GPU CUDA Oersted kernels module header") !=
                std::string::npos &&
            oersted_header.find("fullmag_cuda_add_scaled_field_inplace(") !=
                std::string::npos,
        "GPU CUDA Oersted kernels header must own scaled field-add wrapper declarations");
    check(
        oersted_source.find("#include \"gpu/cuda/interactions/oersted/oersted_kernels.hpp\"") !=
                std::string::npos &&
            oersted_source.find("GPU CUDA Oersted kernels source contract") !=
                std::string::npos,
        "GPU CUDA Oersted kernels source must document and include its module header");
    check(
        oersted_source.find("add_scaled_field_inplace_kernel") !=
                std::string::npos &&
            oersted_source.find("scale * h_add[i]") !=
                std::string::npos &&
            oersted_source.find("fullmag_cuda_add_scaled_field_inplace(") !=
                std::string::npos,
        "GPU CUDA Oersted kernels source must own scaled H_oe field-add kernel and wrapper");
    check(
        oersted_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            oersted_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA Oersted kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_add_scaled_field_inplace(") ==
            std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare Oersted scaled field-add wrappers");
    check(
        kernels_source.find("add_scaled_field_inplace_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_add_scaled_field_inplace(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own Oersted scaled field-add kernel implementations");
}

void gpu_observable_kernels_are_owned_by_cuda_observables_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string observables_header =
        read_text_file(root / "gpu" / "cuda" / "observables" / "observable_kernels.hpp");
    const std::string observables_source =
        read_text_file(root / "gpu" / "cuda" / "observables" / "observable_kernels.cu");

    check(
        cmake.find("gpu/cuda/observables/observable_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU observable CUDA kernels from gpu/cuda/observables");
    check(
        kernels_header.find("#include \"gpu/cuda/observables/observable_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the observable kernel module");
    check(
        observables_header.find("GPU CUDA observable kernels module header") !=
                std::string::npos &&
            observables_header.find("fullmag_cuda_field_metric_blocks(") !=
                std::string::npos &&
            observables_header.find("fullmag_cuda_magnetization_sum_blocks(") !=
                std::string::npos,
        "GPU CUDA observable kernels header must own field and magnetization metric declarations");
    check(
        observables_source.find("#include \"gpu/cuda/observables/observable_kernels.hpp\"") !=
                std::string::npos &&
            observables_source.find("GPU CUDA observable kernels source contract") !=
                std::string::npos,
        "GPU CUDA observable kernels source must document and include its module header");
    check(
        observables_source.find("field_metric_blocks_kernel") !=
                std::string::npos &&
            observables_source.find("magnetization_sum_blocks_kernel") !=
                std::string::npos &&
            observables_source.find("torque_norm = sqrt(tx * tx + ty * ty + tz * tz)") !=
                std::string::npos &&
            observables_source.find("local_count = 1.0") !=
                std::string::npos &&
            observables_source.find("fullmag_cuda_field_metric_blocks(") !=
                std::string::npos &&
            observables_source.find("fullmag_cuda_magnetization_sum_blocks(") !=
                std::string::npos,
        "GPU CUDA observable kernels source must own step metric and average magnetization kernels");
    check(
        observables_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            observables_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA observable kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_field_metric_blocks(") ==
                std::string::npos &&
            kernels_header.find("void fullmag_cuda_magnetization_sum_blocks(") ==
                std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare observable wrappers");
    check(
        kernels_source.find("field_metric_blocks_kernel") == std::string::npos &&
            kernels_source.find("magnetization_sum_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_field_metric_blocks(") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_magnetization_sum_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own observable kernel implementations");
}

void gpu_magnetoelastic_kernels_are_owned_by_cuda_magnetoelastic_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string mel_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_kernels.hpp");
    const std::string mel_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU magnetoelastic CUDA kernels from gpu/cuda/interactions/magnetoelastic");
    check(
        kernels_header.find("#include \"gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the magnetoelastic kernel module");
    check(
        mel_header.find("GPU CUDA magnetoelastic kernels module header") !=
                std::string::npos &&
            mel_header.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA magnetoelastic kernels header must own prescribed-strain wrapper declarations");
    check(
        mel_source.find("#include \"gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp\"") !=
                std::string::npos &&
            mel_source.find("GPU CUDA magnetoelastic kernels source contract") !=
                std::string::npos,
        "GPU CUDA magnetoelastic kernels source must document and include its module header");
    check(
        mel_source.find("magnetoelastic_field_energy_blocks_kernel") !=
                std::string::npos &&
            mel_source.find("eps[3] * 0.5") != std::string::npos &&
            mel_source.find("2.0 * b1 * lmx * e11") != std::string::npos &&
            mel_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA magnetoelastic kernels source must own prescribed-strain field, energy, and wrapper");
    check(
        mel_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            mel_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA magnetoelastic kernels source must not own RK orchestration");
    check(
        kernels_header.find("void fullmag_cuda_magnetoelastic_field_energy_blocks(") ==
            std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare magnetoelastic wrappers");
    check(
        kernels_source.find("magnetoelastic_field_energy_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_magnetoelastic_field_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own magnetoelastic kernel implementations");
}

void cuda_demag_kernels_are_owned_by_cuda_demag_kernel_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string kernels_header =
        read_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.hpp");
    const std::string kernels_source =
        read_optional_text_file(root / "gpu" / "cuda" / "kernels" / "kernels.cu");
    const std::string demag_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "demag_kernels.hpp");
    const std::string demag_source =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "demag_kernels.cu");

    check(
        cmake.find("gpu/cuda/demag_poisson/demag_kernels.cu") != std::string::npos,
        "FEM CMake source list must build CUDA demag kernels from gpu/cuda/demag_poisson");
    check(
        cmake.find("gpu/cuda/kernels/demag_kernels.cu") == std::string::npos,
        "FEM CMake source list must not build demag kernels from generic gpu/cuda/kernels");
    check(
        kernels_header.find("#include \"gpu/cuda/demag_poisson/demag_kernels.hpp\"") !=
            std::string::npos,
        "GPU CUDA kernels umbrella header must include the demag kernel module");
    check(
        demag_header.find("GPU CUDA demag kernels module header") !=
                std::string::npos &&
            demag_header.find("fullmag_cuda_demag_rhs_csr(") !=
                std::string::npos &&
            demag_header.find("fullmag_cuda_demag_recovery_csr(") !=
                std::string::npos &&
            demag_header.find("fullmag_cuda_demag_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA demag kernels header must own demag kernel wrapper declarations");
    check(
        demag_source.find("#include \"gpu/cuda/demag_poisson/demag_kernels.hpp\"") !=
                std::string::npos &&
            demag_source.find("GPU CUDA demag kernels source contract") !=
                std::string::npos,
        "GPU CUDA demag kernels source must document and include its module header");
    check(
        demag_source.find("demag_rhs_csr_kernel") != std::string::npos &&
            demag_source.find("demag_recovery_csr_kernel") != std::string::npos &&
            demag_source.find("demag_energy_blocks_kernel") !=
                std::string::npos &&
            demag_source.find("fullmag_cuda_demag_rhs_csr(") !=
                std::string::npos &&
            demag_source.find("fullmag_cuda_demag_recovery_csr(") !=
                std::string::npos &&
            demag_source.find("fullmag_cuda_demag_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA demag kernels source must own demag kernels and exported wrappers");
    check(
        kernels_header.find("void fullmag_cuda_demag_rhs_csr(") ==
                std::string::npos &&
            kernels_header.find("void fullmag_cuda_demag_recovery_csr(") ==
                std::string::npos &&
            kernels_header.find("void fullmag_cuda_demag_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA kernels umbrella header must not directly declare demag wrappers");
    check(
        kernels_source.find("demag_rhs_csr_kernel") == std::string::npos &&
            kernels_source.find("demag_recovery_csr_kernel") == std::string::npos &&
            kernels_source.find("demag_energy_blocks_kernel") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_demag_rhs_csr(") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_demag_recovery_csr(") ==
                std::string::npos &&
            kernels_source.find("void fullmag_cuda_demag_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA shared kernels source must not own demag kernel implementations");
}

void managed_runtime_export_keeps_mfem_headers_linkable() {
    const std::string export_script =
        read_text_file(repo_root() / "scripts" / "export_fem_gpu_runtime.sh");

    check(
        export_script.find("${RUNTIME_ROOT}/include") != std::string::npos ||
            export_script.find(".fullmag/runtimes/fem-gpu-host/include") !=
                std::string::npos,
        "FEM runtime export must create a managed include directory");
    check(
        export_script.find("/opt/fullmag-deps/include") != std::string::npos,
        "FEM runtime export must copy MFEM/libCEED/Hypre headers from the container deps prefix");
    check(
        export_script.find("relocating MFEM CMake package metadata") !=
            std::string::npos,
        "FEM runtime export must rewrite MFEM CMake package metadata for host relocation");
    check(
        export_script.find("MFEMConfig.cmake") != std::string::npos &&
            export_script.find("MFEMTargets.cmake") != std::string::npos,
        "FEM runtime export must relocate both MFEMConfig and MFEMTargets metadata");
    check(
        export_script.find(R"(\\\${PACKAGE_PREFIX_DIR}/include)") !=
            std::string::npos &&
            export_script.find(R"(\\\${_IMPORT_PREFIX}/lib)") !=
                std::string::npos,
        "FEM runtime export must preserve CMake package variables through shell and Perl escaping");
    check(
        export_script.find("/usr/lib/x86_64-linux-gnu/openmpi/include") !=
            std::string::npos,
        "FEM runtime export must bundle OpenMPI headers referenced by MFEM package metadata");
    check(
        export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcurand.so") !=
            std::string::npos &&
            export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcublas.so") !=
                std::string::npos &&
            export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcusparse.so") !=
                std::string::npos,
        "FEM runtime export must bundle CUDA shared libraries referenced by MFEMTargets metadata");
    check(
        export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/include") !=
            std::string::npos,
        "FEM runtime export must bundle CUDA headers included by MFEM headers");
}

void progress_report_marks_device_runtime_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Wydzielic device/runtime z `mfem_bridge.cpp` | zrobione kontraktowo |") != std::string::npos,
        "progress report must mark the device/runtime split as contractually covered");
    check(
        progress.find("`fem_source_facade_contract`") != std::string::npos &&
            progress.find("`fem_mfem_context_contract`") != std::string::npos &&
            progress.find("`fem_mfem_device_contract`") != std::string::npos &&
            progress.find("`fem_gpu_state_runtime_contract`") != std::string::npos &&
            progress.find("`fem_state_io_contract`") != std::string::npos &&
            progress.find("`fem_cpu_threads_contract`") != std::string::npos,
        "progress report must cite the runtime split contract gates");
    check(
        progress.find("backend_lifecycle") != std::string::npos &&
            progress.find("backend_step") != std::string::npos &&
            progress.find("eigen_dense") != std::string::npos &&
            progress.find("interrupt") != std::string::npos &&
            progress.find("availability") != std::string::npos,
        "progress report must mention the runtime facade modules");
    check(
        progress.find("nie zamyka aktywnej kwalifikacji runtime MFEM/libCEED") !=
            std::string::npos,
        "progress report must keep active MFEM/libCEED runtime qualification open");
}

void progress_report_marks_context_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Rozbic `Context` na `FemMesh`, `FemState`, `FemFieldBuffers`, `FemWorkspace` itd. | zrobione kontraktowo |") != std::string::npos,
        "progress report must mark the Context split as contract-covered");
    check(
        progress.find("`fem_source_facade_contract`") != std::string::npos &&
            progress.find("`fem_plan_fields_contract`") != std::string::npos &&
            progress.find("`fem_mesh_contract`") != std::string::npos &&
            progress.find("`fem_state_contract`") != std::string::npos &&
            progress.find("`fem_material_fields_contract`") != std::string::npos &&
            progress.find("`fem_field_buffers_contract`") != std::string::npos,
        "progress report must cite core Context split contract gates");
    check(
        progress.find("`fem_rk_explicit_contract`") != std::string::npos &&
            progress.find("`fem_mfem_context_contract`") != std::string::npos &&
            progress.find("`fem_gpu_state_runtime_contract`") != std::string::npos &&
            progress.find("`fem_demag_contract`") != std::string::npos &&
            progress.find("`fem_demag_poisson_contract`") != std::string::npos &&
            progress.find("`fem_demag_fem_bem_contract`") != std::string::npos,
        "progress report must cite workspace/runtime owner contract gates");
    check(
        progress.find("Context pozostaje compatibility facade") != std::string::npos &&
            progress.find("nie jest juz wlascicielem plaskich pol core/runtime/interaction/workspace") !=
                std::string::npos,
        "progress report must describe Context as a facade rather than a flat owner");
}

} // namespace

int main() {
    source_facades_document_module_boundaries();
    common_fem_utilities_have_single_header();
    legacy_gpu_placeholder_sources_are_removed();
    gpu_exchange_planning_is_owned_by_cuda_exchange_module();
    gpu_exchange_kernels_are_owned_by_cuda_exchange_module();
    gpu_rk_planning_is_owned_by_cuda_rk_module();
    gpu_rk_step_is_owned_by_cuda_rk_module();
    gpu_rk_snapshot_is_owned_by_cuda_rk_module();
    gpu_rk_step_stats_is_owned_by_cuda_rk_module();
    gpu_demag_poisson_is_owned_by_cuda_demag_poisson_module();
    cuda_kernels_are_owned_by_cuda_kernels_module();
    gpu_cuda_vector_field_kernels_are_owned_by_cuda_fields_module();
    gpu_cuda_transfer_kernels_are_owned_by_cuda_transfer_module();
    gpu_cuda_llg_rhs_kernels_are_owned_by_cuda_llg_integrator_module();
    gpu_cuda_reduction_kernels_are_owned_by_cuda_reductions_module();
    gpu_rk_adaptive_error_kernels_are_owned_by_cuda_rk_module();
    gpu_rk_stage_kernels_are_owned_by_cuda_rk_module();
    gpu_rk_device_io_is_owned_by_cuda_rk_module();
    gpu_rk_adaptive_runtime_is_owned_by_cuda_rk_module();
    gpu_rk_rhs_runtime_is_owned_by_cuda_rk_module();
    gpu_dmi_kernels_are_owned_by_cuda_dmi_interaction_module();
    gpu_stt_kernels_are_owned_by_cuda_stt_interaction_module();
    gpu_thermal_kernels_are_owned_by_cuda_thermal_interaction_module();
    gpu_anisotropy_kernels_are_owned_by_cuda_anisotropy_interaction_module();
    gpu_zeeman_kernels_are_owned_by_cuda_zeeman_interaction_module();
    gpu_oersted_kernels_are_owned_by_cuda_oersted_interaction_module();
    gpu_observable_kernels_are_owned_by_cuda_observables_module();
    gpu_magnetoelastic_kernels_are_owned_by_cuda_magnetoelastic_interaction_module();
    cuda_demag_kernels_are_owned_by_cuda_demag_kernel_module();
    managed_runtime_export_keeps_mfem_headers_linkable();
    progress_report_marks_device_runtime_split_contract_covered();
    progress_report_marks_context_split_contract_covered();
    return 0;
}
