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
            module.find("does not own") != std::string::npos &&
            module.find("GPU RK planning") != std::string::npos &&
            module.find("step preflight") != std::string::npos &&
            module.find("per-integrator stage schedules") != std::string::npos &&
            module.find("RHS assembly") != std::string::npos &&
            module.find("final statistics") != std::string::npos &&
            module.find("snapshot recomputation") != std::string::npos &&
            module.find("C ABI entrypoints") != std::string::npos,
        "GPU CUDA RK step module must document its non-owning module boundary");
}

void gpu_rk_step_preflight_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string preflight_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_preflight.hpp");
    const std::string preflight_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_preflight.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_preflight.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK step preflight from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_step_preflight.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK step preflight module");
    check(
        preflight_header.find("GPU CUDA RK step preflight module header") !=
                std::string::npos &&
            preflight_header.find("struct GpuRkStepPreflight") !=
                std::string::npos &&
            preflight_header.find("gpu_rk_prepare_step_preflight(") !=
                std::string::npos,
        "GPU CUDA RK step preflight header must document and declare preflight state");
    check(
        preflight_source.find("#include \"gpu/cuda/integrators/rk/rk_step_preflight.hpp\"") !=
                std::string::npos &&
            preflight_source.find("#include \"gpu/cuda/integrators/rk/rk.hpp\"") !=
                std::string::npos &&
            preflight_source.find("#include \"gpu/cuda/integrators/rk/rk_fsal_policy.hpp\"") !=
                std::string::npos &&
            preflight_source.find("#include \"gpu/cuda/state/gpu_state.hpp\"") !=
                std::string::npos &&
            preflight_source.find("GPU CUDA RK step preflight source contract") !=
                std::string::npos,
        "GPU CUDA RK step preflight source must document and include its module, planner, FSAL policy, and GPU state headers");
    check(
        preflight_source.find("gpu_rk_plan_device_resident(ctx, reason)") !=
                std::string::npos &&
            preflight_source.find("FULLMAG_FEM_INTEGRATOR_HEUN") !=
                std::string::npos &&
            preflight_source.find("FULLMAG_FEM_INTEGRATOR_RK4") !=
                std::string::npos &&
            preflight_source.find("FULLMAG_FEM_INTEGRATOR_RK23_BS") !=
                std::string::npos &&
            preflight_source.find("FULLMAG_FEM_INTEGRATOR_RK45_DP54") !=
                std::string::npos &&
            preflight_source.find("GPU RK execution surface currently implements fixed-step Heun, RK4, RK23, and RK45 only") !=
                std::string::npos &&
            preflight_source.find("GPU RK device-resident step requires a positive dt") !=
                std::string::npos,
        "GPU CUDA RK step preflight source must own planner, supported-integrator, and dt validation");
    check(
        preflight_source.find("FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH") !=
                std::string::npos &&
            preflight_source.find("FemGpuSyncState::DeviceClean") !=
                std::string::npos &&
            preflight_source.find("FemGpuSyncState::HostClean") !=
                std::string::npos &&
            preflight_source.find("GPU RK device-resident step requires FemGpuState device source of truth") !=
                std::string::npos &&
            preflight_source.find("legacy_sparse_gpu") !=
                std::string::npos &&
            preflight_source.find("GPU RK device-resident step requires legacy_sparse_gpu exchange operator mode") !=
                std::string::npos,
        "GPU CUDA RK step preflight source must own source-of-truth and exchange-mode validation");
    check(
        preflight_source.find("reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream)") !=
                std::string::npos &&
            preflight_source.find("result.adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled") !=
                std::string::npos &&
            preflight_source.find("result.fsal_method = (result.is_rk23 || result.is_rk45) && gpu_rk_rhs_allows_fsal_reuse(ctx)") !=
                std::string::npos,
        "GPU CUDA RK step preflight source must own stream/block setup, adaptive flagging, and FSAL policy resolution");
    check(
        rk_step.find("gpu_rk_prepare_step_preflight(") !=
                std::string::npos &&
            rk_step.find("preflight.stream") != std::string::npos &&
            rk_step.find("preflight.n") != std::string::npos &&
            rk_step.find("preflight.blocks") != std::string::npos &&
            rk_step.find("preflight.is_heun") != std::string::npos &&
            rk_step.find("preflight.fsal_method") != std::string::npos,
        "GPU CUDA RK step source must delegate step preflight and consume prepared state");
    check(
        rk_step.find("gpu_rk_plan_device_resident(ctx, reason)") == std::string::npos &&
            rk_step.find("GPU RK device-resident step requires a positive dt") ==
                std::string::npos &&
            rk_step.find("FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH") ==
                std::string::npos &&
            rk_step.find("GPU RK device-resident step requires legacy_sparse_gpu exchange operator mode") ==
                std::string::npos &&
            rk_step.find("const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled") ==
                std::string::npos &&
            rk_step.find("const bool fsal_method = (is_rk23 || is_rk45) && gpu_rk_rhs_allows_fsal_reuse(ctx)") ==
                std::string::npos,
        "GPU CUDA RK step source must not own step preflight internals");
}

void gpu_rk_snapshot_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk.hpp");
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
        rk_header.find("#include \"gpu/cuda/integrators/rk/rk_snapshot.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK public header must include the RK snapshot module");
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
    const std::string refresh_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");
    const std::string stats_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.hpp");
    const std::string energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_energy_reductions.hpp");
    const std::string exchange_energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_energy_reductions.hpp");
    const std::string demag_energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_energy_reductions.hpp");
    const std::string anisotropy_energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_anisotropy_energy_reductions.hpp");
    const std::string dmi_energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_energy_reductions.hpp");
    const std::string magnetoelastic_energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetoelastic_energy_reductions.hpp");
    const std::string observable_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_observable_reductions.hpp");
    const std::string stats_fallback =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cpp");
    const std::string stats_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");
    const std::string energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_energy_reductions.cu");
    const std::string exchange_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_energy_reductions.cu");
    const std::string demag_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_energy_reductions.cu");
    const std::string anisotropy_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_anisotropy_energy_reductions.cu");
    const std::string dmi_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_energy_reductions.cu");
    const std::string magnetoelastic_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetoelastic_energy_reductions.cu");
    const std::string observable_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_observable_reductions.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_stats.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final stats no-CUDA fallback from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_stats.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final stats helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final energy reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_exchange_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK exchange final energy reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK demag final energy reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK anisotropy final energy reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK DMI final energy reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK magnetoelastic final energy reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_observable_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final observable reductions from gpu/cuda/integrators/rk");
    check(
        refresh_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK final refresh source must include the RK final stats module");
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
            stats_source.find("#include \"gpu/cuda/integrators/rk/rk_energy_reductions.hpp\"") !=
                std::string::npos &&
            stats_source.find("#include \"gpu/cuda/integrators/rk/rk_observable_reductions.hpp\"") !=
                std::string::npos &&
            stats_source.find("gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            stats_source.find("gpu_rk_reduce_final_observable_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            stats_source.find("gpu_rk_read_scalar_results(") !=
                std::string::npos &&
            stats_source.find("context_update_stage_completion_from_stats(ctx, stats)") !=
                std::string::npos,
        "GPU CUDA RK final stats source must delegate reductions and own scalar readback and stats publication");
    check(
        energy_header.find("GPU CUDA RK final energy reductions module header") !=
                std::string::npos &&
            energy_header.find("gpu_rk_reduce_final_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK final energy reductions header must document and declare final energy reductions");
    check(
        exchange_energy_header.find("GPU CUDA RK exchange final energy reductions module header") !=
                std::string::npos &&
            exchange_energy_header.find("gpu_rk_reduce_final_exchange_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK exchange final energy reductions header must document and declare exchange energy reductions");
    check(
        demag_energy_header.find("GPU CUDA RK demag final energy reductions module header") !=
                std::string::npos &&
            demag_energy_header.find("gpu_rk_reduce_final_demag_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK demag final energy reductions header must document and declare demag energy reductions");
    check(
        anisotropy_energy_header.find("GPU CUDA RK anisotropy final energy reductions module header") !=
                std::string::npos &&
            anisotropy_energy_header.find("gpu_rk_reduce_final_anisotropy_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK anisotropy final energy reductions header must document and declare anisotropy energy reductions");
    check(
        dmi_energy_header.find("GPU CUDA RK DMI final energy reductions module header") !=
                std::string::npos &&
            dmi_energy_header.find("gpu_rk_reduce_final_dmi_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK DMI final energy reductions header must document and declare DMI energy reductions");
    check(
        magnetoelastic_energy_header.find("GPU CUDA RK magnetoelastic final energy reductions module header") !=
                std::string::npos &&
            magnetoelastic_energy_header.find("gpu_rk_reduce_final_magnetoelastic_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK magnetoelastic final energy reductions header must document and declare magnetoelastic energy reductions");
    check(
        energy_source.find("#include \"gpu/cuda/integrators/rk/rk_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("GPU CUDA RK final energy reductions source contract") !=
                std::string::npos &&
            energy_source.find("fullmag_cuda_external_energy_blocks(") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_exchange_energy_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_demag_energy_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_anisotropy_energy_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_dmi_energy_terms(ctx, stream, n, reason)") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_magnetoelastic_energy_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos,
        "GPU CUDA RK final energy reductions source must own generic final energy orchestration and delegate specialized energy reductions");
    check(
        exchange_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp\"") !=
                std::string::npos &&
            exchange_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            exchange_energy_source.find("GPU CUDA RK exchange final energy reductions source contract") !=
                std::string::npos &&
            exchange_energy_source.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") !=
                std::string::npos &&
            exchange_energy_source.find("GpuFinalScalarSlot::ExchangeEnergy") !=
                std::string::npos &&
            exchange_energy_source.find("launch GPU RK exchange energy blocks") !=
                std::string::npos &&
            exchange_energy_source.find("launch GPU RK exchange energy reduction") !=
                std::string::npos,
        "GPU CUDA RK exchange final energy reductions source must own exchange energy launch and scalar slot");
    check(
        energy_source.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::ExchangeEnergy") ==
                std::string::npos &&
            energy_source.find("launch GPU RK exchange energy blocks") ==
                std::string::npos &&
            energy_source.find("launch GPU RK exchange energy reduction") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must delegate exchange energy internals");
    check(
        demag_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp\"") !=
                std::string::npos &&
            demag_energy_source.find("#include \"gpu/cuda/demag_poisson/stage_compute.hpp\"") !=
                std::string::npos &&
            demag_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            demag_energy_source.find("GPU CUDA RK demag final energy reductions source contract") !=
                std::string::npos &&
            demag_energy_source.find("fullmag_cuda_demag_energy_blocks(") !=
                std::string::npos &&
            demag_energy_source.find("ctx.demag.enabled") !=
                std::string::npos &&
            demag_energy_source.find("ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN") !=
                std::string::npos &&
            demag_energy_source.find("reduce_device_demag_robin_boundary_energy(") !=
                std::string::npos &&
            demag_energy_source.find("GpuFinalScalarSlot::DemagEnergy") !=
                std::string::npos &&
            demag_energy_source.find("GpuFinalScalarSlot::DemagRobinBoundaryEnergy") !=
                std::string::npos &&
            demag_energy_source.find("GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag") !=
                std::string::npos,
        "GPU CUDA RK demag final energy reductions source must own demag energy validation, Robin boundary reduction, kernel launch, and scalar slots");
    check(
        energy_source.find("fullmag_cuda_demag_energy_blocks(") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::DemagEnergy") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::DemagRobinBoundaryEnergy") ==
                std::string::npos &&
            energy_source.find("GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag") ==
                std::string::npos &&
            energy_source.find("reduce_device_demag_robin_boundary_energy(") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must delegate demag energy internals");
    check(
        anisotropy_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp\"") !=
                std::string::npos &&
            anisotropy_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            anisotropy_energy_source.find("GPU CUDA RK anisotropy final energy reductions source contract") !=
                std::string::npos &&
            anisotropy_energy_source.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            anisotropy_energy_source.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            anisotropy_energy_source.find("GPU RK uniaxial anisotropy energy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers") !=
                std::string::npos &&
            anisotropy_energy_source.find("GPU RK cubic anisotropy energy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers") !=
                std::string::npos &&
            anisotropy_energy_source.find("ctx.anisotropy.uniaxial_enabled") !=
                std::string::npos &&
            anisotropy_energy_source.find("ctx.anisotropy.cubic_enabled") !=
                std::string::npos &&
            anisotropy_energy_source.find("GpuFinalScalarSlot::AnisotropyEnergy") !=
                std::string::npos &&
            anisotropy_energy_source.find("GpuFinalScalarSlot::CubicAnisotropyEnergy") !=
                std::string::npos,
        "GPU CUDA RK anisotropy final energy reductions source must own anisotropy energy validation, kernel launch, and scalar slots");
    check(
        energy_source.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") ==
                std::string::npos &&
            energy_source.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::AnisotropyEnergy") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::CubicAnisotropyEnergy") ==
                std::string::npos &&
            energy_source.find("GPU RK uniaxial anisotropy energy requires device-resident") ==
                std::string::npos &&
            energy_source.find("GPU RK cubic anisotropy energy requires device-resident") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must delegate anisotropy energy internals");
    check(
        dmi_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp\"") !=
                std::string::npos &&
            dmi_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            dmi_energy_source.find("GPU CUDA RK DMI final energy reductions source contract") !=
                std::string::npos &&
            dmi_energy_source.find("fullmag_cuda_dmi_field_energy(") !=
                std::string::npos &&
            dmi_energy_source.find("GPU RK DMI energy requires device-resident mesh geometry, Ms, lumped mass, and residual buffers") !=
                std::string::npos &&
            dmi_energy_source.find("ctx.dmi.interfacial_enabled") !=
                std::string::npos &&
            dmi_energy_source.find("ctx.dmi.bulk_enabled") !=
                std::string::npos &&
            dmi_energy_source.find("GpuFinalScalarSlot::DmiEnergy") !=
                std::string::npos &&
            dmi_energy_source.find("GpuFinalScalarSlot::BulkDmiEnergy") !=
                std::string::npos,
        "GPU CUDA RK DMI final energy reductions source must own DMI energy validation, kernel launch, and scalar slots");
    check(
        energy_source.find("fullmag_cuda_dmi_field_energy(") == std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::DmiEnergy") == std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::BulkDmiEnergy") == std::string::npos &&
            energy_source.find("GPU RK DMI energy requires device-resident mesh geometry") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must delegate DMI energy internals");
    check(
        magnetoelastic_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp\"") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("GPU CUDA RK magnetoelastic final energy reductions source contract") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("ctx.magnetoelastic.enabled") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("use_per_node_strain ? gpu.mel_strain_voigt : nullptr") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("GpuFinalScalarSlot::MagnetoelasticEnergy") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("GPU RK magnetoelastic energy requires prescribed strain data") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("GPU RK magnetoelastic energy requires 6 prescribed strain Voigt values per node") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("GPU RK magnetoelastic energy requires device-resident per-node strain") !=
                std::string::npos &&
            magnetoelastic_energy_source.find("GPU RK magnetoelastic energy requires device-resident Ms, lumped mass, and H_mel buffers") !=
                std::string::npos,
        "GPU CUDA RK magnetoelastic final energy reductions source must own magnetoelastic energy validation, kernel launch, and scalar slot");
    check(
        energy_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::MagnetoelasticEnergy") ==
                std::string::npos &&
            energy_source.find("GPU RK magnetoelastic energy requires prescribed strain data") ==
                std::string::npos &&
            energy_source.find("GPU RK magnetoelastic energy requires device-resident per-node strain") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must delegate magnetoelastic energy internals");
    check(
        stats_source.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") ==
                std::string::npos &&
            stats_source.find("fullmag_cuda_external_energy_blocks(") ==
                std::string::npos &&
            stats_source.find("fullmag_cuda_dmi_field_energy(") ==
                std::string::npos &&
            stats_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") ==
                std::string::npos,
        "GPU CUDA RK final stats source must delegate final energy reductions to the energy reductions module");
    check(
        observable_header.find("GPU CUDA RK final observable reductions module header") !=
                std::string::npos &&
            observable_header.find("gpu_rk_reduce_final_observable_terms(") !=
                std::string::npos,
        "GPU CUDA RK final observable reductions header must document and declare final observable reductions");
    check(
        observable_source.find("#include \"gpu/cuda/integrators/rk/rk_observable_reductions.hpp\"") !=
                std::string::npos &&
            observable_source.find("GPU CUDA RK final observable reductions source contract") !=
                std::string::npos &&
            observable_source.find("fullmag_cuda_field_metric_blocks(") !=
                std::string::npos &&
            observable_source.find("fullmag_cuda_magnetization_sum_blocks(") !=
                std::string::npos &&
            observable_source.find("GpuFinalScalarSlot::MaxTorque") !=
                std::string::npos &&
            observable_source.find("GpuFinalScalarSlot::MagneticCount") !=
                std::string::npos,
        "GPU CUDA RK final observable reductions source must own field metrics, torque, and magnetization reductions");
    check(
        stats_source.find("fullmag_cuda_field_metric_blocks(") == std::string::npos &&
            stats_source.find("fullmag_cuda_magnetization_sum_blocks(") ==
                std::string::npos &&
            stats_source.find("launch GPU RK max H_eff reduction") ==
                std::string::npos &&
            stats_source.find("launch GPU RK magnetic count reduction") ==
                std::string::npos,
        "GPU CUDA RK final stats source must delegate final observable reductions to the observable reductions module");
    check(
        stats_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            stats_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK final stats source must not own RK step orchestration or RHS assembly");
    check(
        energy_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            energy_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            energy_source.find("context_update_stage_completion_from_stats(") ==
                std::string::npos &&
            energy_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must not own RK step orchestration, RHS assembly, stats publication, or scalar readback");
    check(
        observable_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            observable_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            observable_source.find("context_update_stage_completion_from_stats(") ==
                std::string::npos &&
            observable_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos,
        "GPU CUDA RK final observable reductions source must not own RK step orchestration, RHS assembly, stats publication, or scalar readback");
    check(
        stats_fallback.find("GPU CUDA RK final step stats fallback source contract") !=
                std::string::npos &&
            stats_fallback.find("bool gpu_rk_finalize_step_stats(") !=
                std::string::npos &&
            stats_fallback.find("#if !FULLMAG_HAS_CUDA_RUNTIME") !=
                std::string::npos,
        "GPU CUDA RK final stats fallback source must own the no-CUDA final stats implementation");
}

void gpu_rk_final_refresh_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string refresh_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.hpp");
    const std::string refresh_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_final_refresh.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final accepted-step refresh from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_final_refresh.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK final refresh module");
    check(
        refresh_header.find("GPU CUDA RK accepted-step final refresh module header") !=
                std::string::npos &&
            refresh_header.find("gpu_rk_finalize_accepted_step(") !=
                std::string::npos,
        "GPU CUDA RK final refresh header must own the accepted-step finalization declaration");
    check(
        refresh_source.find("#include \"gpu/cuda/integrators/rk/rk_final_refresh.hpp\"") !=
                std::string::npos &&
            refresh_source.find("GPU CUDA RK accepted-step final refresh source contract") !=
                std::string::npos,
        "GPU CUDA RK final refresh source must document and include its module header");
    check(
        refresh_source.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos &&
            refresh_source.find("launch GPU RK final h_eff accumulation") !=
                std::string::npos &&
            refresh_source.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            refresh_source.find("cudaMemcpyAsync GPU RK FSAL k0 device copy") !=
                std::string::npos &&
            refresh_source.find("fullmag_cuda_device_max(") !=
                std::string::npos &&
            refresh_source.find("gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)") !=
                std::string::npos,
        "GPU CUDA RK final refresh source must own final RHS refresh, FSAL copy, and max-RHS reduction");
    check(
        refresh_source.find("stats.rhs_evaluations = total_stage_rhs_evaluations + 1") !=
                std::string::npos &&
            refresh_source.find("stats.fsal_reused = fsal_reused ? 1 : 0") !=
                std::string::npos &&
            refresh_source.find("gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH") !=
                std::string::npos &&
            refresh_source.find("gpu.device_state = FemGpuSyncState::DeviceDirty") !=
                std::string::npos &&
            refresh_source.find("gpu.host_state = FemGpuSyncState::HostStale") !=
                std::string::npos,
        "GPU CUDA RK final refresh source must own accepted-step stats and GPU residency publication");
    check(
        refresh_source.find("bool gpu_rk_device_resident_step(") == std::string::npos,
        "GPU CUDA RK final refresh source must not own RK step orchestration");
    check(
        rk_step.find("launch GPU RK final h_eff accumulation") == std::string::npos &&
            rk_step.find("gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)") ==
                std::string::npos,
        "GPU CUDA RK step orchestration source must not own accepted-step final refresh internals");
}

void gpu_rk_stage_schedule_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string attempt_loop =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.cu");
    const std::string schedule_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_schedule.hpp");
    const std::string schedule_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_schedule.cu");
    const std::string rk45_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk45_stage_sequence.hpp");
    const std::string rk45_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk45_stage_sequence.cu");
    const std::string rk4_rk23_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk4_rk23_stage_sequence.hpp");
    const std::string rk4_rk23_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk4_rk23_stage_sequence.cu");
    const std::string heun_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "heun_stage_sequence.hpp");
    const std::string heun_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "heun_stage_sequence.cu");
    const std::string rk23_adaptive_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk23_adaptive_k3.hpp");
    const std::string rk23_adaptive_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk23_adaptive_k3.cu");
    const std::string attempt_setup_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_setup.hpp");
    const std::string attempt_setup_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_setup.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_stage_schedule.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK stage schedule from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk45_stage_sequence.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK45 stage sequence from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK4/RK23 stage sequence from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/heun_stage_sequence.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU Heun stage sequence from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk23_adaptive_k3.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK23 adaptive k3 helper from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_attempt_setup.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK attempt setup from gpu/cuda/integrators/rk");
    check(
        attempt_loop.find("#include \"gpu/cuda/integrators/rk/rk_stage_schedule.hpp\"") !=
                std::string::npos &&
            rk_step.find("#include \"gpu/cuda/integrators/rk/rk_stage_schedule.hpp\"") ==
                std::string::npos,
        "GPU CUDA RK attempt loop source must include the RK stage schedule module");
    check(
        schedule_header.find("GPU CUDA RK stage schedule module header") !=
                std::string::npos &&
            schedule_header.find("struct GpuRkStageAttemptResult") !=
                std::string::npos &&
            schedule_header.find("gpu_rk_run_stage_attempt(") !=
                std::string::npos,
        "GPU CUDA RK stage schedule header must own attempt-result and stage-attempt declarations");
    check(
        schedule_source.find("#include \"gpu/cuda/integrators/rk/rk_stage_schedule.hpp\"") !=
                std::string::npos &&
            schedule_source.find("GPU CUDA RK stage schedule source contract") !=
                std::string::npos,
        "GPU CUDA RK stage schedule source must document and include its module header");
    check(
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk_attempt_setup.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_prepare_stage_attempt(ctx, stream, n, is_heun, is_rk45, fsal_method, active_dt, stage_rhs_evaluations, fsal_reused, reason)") !=
                std::string::npos &&
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk45_stage_sequence.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_run_rk45_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)") !=
                std::string::npos &&
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_run_rk4_rk23_stage_sequence(ctx, stream, n, is_rk23, active_dt, stage_rhs_evaluations, reason)") !=
                std::string::npos &&
            schedule_source.find("#include \"gpu/cuda/integrators/rk/heun_stage_sequence.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_run_heun_stage_sequence(ctx, stream, n, active_dt)") !=
                std::string::npos &&
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_compute_rk23_adaptive_k3(ctx, stream, n, stage_rhs_evaluations, reason)") !=
                std::string::npos,
        "GPU CUDA RK stage schedule source must own attempt setup delegation, stage-sequence delegation, and adaptive RK23 k3 dispatch");
    check(
        attempt_setup_header.find("GPU CUDA RK attempt setup module header") !=
                std::string::npos &&
            attempt_setup_header.find("gpu_rk_prepare_stage_attempt(") !=
                std::string::npos,
        "GPU CUDA RK attempt setup header must document and declare the common attempt setup helper");
    check(
        attempt_setup_source.find("#include \"gpu/cuda/integrators/rk/rk_attempt_setup.hpp\"") !=
                std::string::npos &&
            attempt_setup_source.find("GPU CUDA RK attempt setup source contract") !=
                std::string::npos &&
            attempt_setup_source.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            attempt_setup_source.find("fsal_reused = fsal_method && gpu.fsal_valid") !=
                std::string::npos &&
            attempt_setup_source.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos &&
            attempt_setup_source.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            attempt_setup_source.find("launch GPU RK stage-0 h_eff accumulation") !=
                std::string::npos &&
            attempt_setup_source.find("launch GPU RK stage-1 h_eff accumulation") !=
                std::string::npos &&
            attempt_setup_source.find("stage_rhs_evaluations += 1") !=
                std::string::npos,
        "GPU CUDA RK attempt setup source must own backup, FSAL reuse, common predictor, stage-0/stage-1 RHS, and RHS accounting");
    check(
        heun_header.find("GPU CUDA Heun stage sequence module header") !=
                std::string::npos &&
            heun_header.find("gpu_rk_run_heun_stage_sequence(") !=
                std::string::npos,
        "GPU CUDA Heun stage sequence header must document and declare the Heun sequence");
    check(
        heun_source.find("#include \"gpu/cuda/integrators/rk/heun_stage_sequence.hpp\"") !=
                std::string::npos &&
            heun_source.find("GPU CUDA Heun stage sequence source contract") !=
                std::string::npos &&
            heun_source.find("fullmag_cuda_heun_accept(") !=
                std::string::npos,
        "GPU CUDA Heun stage sequence source must own Heun accept");
    check(
        rk45_header.find("GPU CUDA RK45 stage sequence module header") !=
                std::string::npos &&
            rk45_header.find("gpu_rk_run_rk45_stage_sequence(") !=
                std::string::npos,
        "GPU CUDA RK45 stage sequence header must document and declare the RK45 sequence");
    check(
        rk45_source.find("#include \"gpu/cuda/integrators/rk/rk45_stage_sequence.hpp\"") !=
                std::string::npos &&
            rk45_source.find("GPU CUDA RK45 stage sequence source contract") !=
                std::string::npos &&
            rk45_source.find("fullmag_cuda_rk45_stage(") !=
                std::string::npos &&
            rk45_source.find("fullmag_cuda_dp54_accept(") !=
                std::string::npos &&
            rk45_source.find("launch GPU RK45 stage-6 h_eff accumulation") !=
                std::string::npos &&
            rk45_source.find("stage_rhs_evaluations += 1") !=
                std::string::npos,
        "GPU CUDA RK45 stage sequence source must own Dormand-Prince stage kernels, RHS evaluations, and DP54 accept");
    check(
        rk4_rk23_header.find("GPU CUDA RK4/RK23 stage sequence module header") !=
                std::string::npos &&
            rk4_rk23_header.find("gpu_rk_run_rk4_rk23_stage_sequence(") !=
                std::string::npos,
        "GPU CUDA RK4/RK23 stage sequence header must document and declare the RK4/RK23 sequence");
    check(
        rk4_rk23_source.find("#include \"gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.hpp\"") !=
                std::string::npos &&
            rk4_rk23_source.find("GPU CUDA RK4/RK23 stage sequence source contract") !=
                std::string::npos &&
            rk4_rk23_source.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            rk4_rk23_source.find("fullmag_cuda_rk4_accept(") !=
                std::string::npos &&
            rk4_rk23_source.find("fullmag_cuda_bs23_accept(") !=
                std::string::npos &&
            rk4_rk23_source.find("launch GPU RK stage-2 h_eff accumulation") !=
                std::string::npos &&
            rk4_rk23_source.find("stage_rhs_evaluations += 1") !=
                std::string::npos,
        "GPU CUDA RK4/RK23 stage sequence source must own midpoint/endpoint predictors, RHS evaluations, and RK4/BS23 accepts");
    check(
        rk23_adaptive_header.find("GPU CUDA RK23 adaptive k3 module header") !=
                std::string::npos &&
            rk23_adaptive_header.find("gpu_rk_compute_rk23_adaptive_k3(") !=
                std::string::npos,
        "GPU CUDA RK23 adaptive k3 header must document and declare the post-accept k3 helper");
    check(
        rk23_adaptive_source.find("#include \"gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp\"") !=
                std::string::npos &&
            rk23_adaptive_source.find("GPU CUDA RK23 adaptive k3 source contract") !=
                std::string::npos &&
            rk23_adaptive_source.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos &&
            rk23_adaptive_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") !=
                std::string::npos &&
            rk23_adaptive_source.find("stage_rhs_evaluations += 1") !=
                std::string::npos,
        "GPU CUDA RK23 adaptive k3 source must own the post-accept RHS evaluation and RHS accounting");
    check(
        schedule_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            schedule_source.find("fullmag_cuda_dp54_accept(") == std::string::npos,
        "GPU CUDA RK stage schedule source must delegate RK45 sequence internals to the RK45 module");
    check(
        schedule_source.find("fullmag_cuda_rk4_accept(") == std::string::npos &&
            schedule_source.find("fullmag_cuda_bs23_accept(") == std::string::npos,
        "GPU CUDA RK stage schedule source must delegate RK4/RK23 sequence internals to the RK4/RK23 module");
    check(
        schedule_source.find("fullmag_cuda_heun_accept(") == std::string::npos,
        "GPU CUDA RK stage schedule source must delegate Heun sequence internals to the Heun module");
    check(
        schedule_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos &&
            schedule_source.find("gpu_rk_copy_component_device(") == std::string::npos &&
            schedule_source.find("fsal_reused = fsal_method && gpu.fsal_valid") ==
                std::string::npos &&
            schedule_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            schedule_source.find("fullmag_cuda_euler_stage(") == std::string::npos &&
            schedule_source.find("launch GPU RK stage-0 h_eff accumulation") ==
                std::string::npos &&
            schedule_source.find("launch GPU RK stage-1 h_eff accumulation") ==
                std::string::npos &&
            schedule_source.find("result.rhs_evaluations = stage_rhs_evaluations") !=
                std::string::npos,
        "GPU CUDA RK stage schedule source must delegate common setup and BS23 adaptive k3 internals while owning final stage RHS accounting");
    check(
        schedule_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            schedule_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            schedule_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos,
        "GPU CUDA RK stage schedule source must not own step orchestration, adaptive policy, or accepted-step finalization");
    check(
        rk45_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            rk45_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            rk45_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            rk45_source.find("fullmag_cuda_bs23_accept(") == std::string::npos &&
            rk45_source.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            rk45_source.find("fullmag_cuda_rk4_accept(") == std::string::npos,
        "GPU CUDA RK45 stage sequence source must not own step orchestration, adaptive policy, accepted-step finalization, or non-RK45 accepts");
    check(
        heun_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            heun_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            heun_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            heun_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            heun_source.find("fullmag_cuda_dp54_accept(") == std::string::npos &&
            heun_source.find("fullmag_cuda_rk4_accept(") == std::string::npos &&
            heun_source.find("fullmag_cuda_bs23_accept(") == std::string::npos &&
            heun_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos,
        "GPU CUDA Heun stage sequence source must not own step orchestration, adaptive policy, accepted-step finalization, RK45, RK4/RK23, or BS23 adaptive k3 internals");
    check(
        rk4_rk23_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            rk4_rk23_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            rk4_rk23_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            rk4_rk23_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            rk4_rk23_source.find("fullmag_cuda_dp54_accept(") == std::string::npos &&
            rk4_rk23_source.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            rk4_rk23_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos,
        "GPU CUDA RK4/RK23 stage sequence source must not own step orchestration, adaptive policy, accepted-step finalization, RK45, Heun, or BS23 adaptive k3 internals");
    check(
        rk23_adaptive_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            rk23_adaptive_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            rk23_adaptive_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            rk23_adaptive_source.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            rk23_adaptive_source.find("fullmag_cuda_rk4_accept(") == std::string::npos &&
            rk23_adaptive_source.find("fullmag_cuda_bs23_accept(") == std::string::npos &&
            rk23_adaptive_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            rk23_adaptive_source.find("fullmag_cuda_dp54_accept(") == std::string::npos,
        "GPU CUDA RK23 adaptive k3 source must not own step orchestration, adaptive policy, accepted-step finalization, or accept/stage kernels");
    check(
        attempt_setup_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            attempt_setup_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            attempt_setup_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            attempt_setup_source.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            attempt_setup_source.find("fullmag_cuda_rk4_accept(") == std::string::npos &&
            attempt_setup_source.find("fullmag_cuda_bs23_accept(") == std::string::npos &&
            attempt_setup_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            attempt_setup_source.find("fullmag_cuda_dp54_accept(") == std::string::npos &&
            attempt_setup_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos,
        "GPU CUDA RK attempt setup source must not own step orchestration, adaptive policy, accepted-step finalization, per-integrator stages, accepts, or RK23 adaptive k3 internals");
    check(
        rk_step.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            rk_step.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            rk_step.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos,
        "GPU CUDA RK step orchestration source must not own per-integrator stage schedule internals");
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
    const std::string final_refresh =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");
    const std::string attempt_setup =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_setup.cu");
    const std::string stage_schedule =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_schedule.cu");
    const std::string io_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_device_io.hpp");
    const std::string io_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_device_io.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_device_io.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK device I/O helpers from gpu/cuda/integrators/rk");
    check(
        final_refresh.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") !=
                std::string::npos &&
            attempt_setup.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") !=
                std::string::npos,
        "GPU CUDA RK final refresh and attempt setup sources must include the RK device I/O module");
    check(
        stage_schedule.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") ==
            std::string::npos,
        "GPU CUDA RK stage schedule source must not include the RK device I/O module directly");
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
    const std::string attempt_loop =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.cu");
    const std::string adaptive_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_runtime.hpp");
    const std::string adaptive_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_runtime.cu");
    const std::string error_norm_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_error_norm_runtime.hpp");
    const std::string error_norm_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_error_norm_runtime.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_adaptive_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive runtime helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_error_norm_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive error-norm runtime helpers from gpu/cuda/integrators/rk");
    check(
        attempt_loop.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") !=
                std::string::npos &&
            rk_step.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") ==
                std::string::npos,
        "GPU CUDA RK attempt loop source must include the RK adaptive runtime module");
    check(
        attempt_loop.find("#include \"gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp\"") !=
                std::string::npos &&
            rk_step.find("#include \"gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp\"") ==
                std::string::npos,
        "GPU CUDA RK attempt loop source must include the RK adaptive error-norm runtime module");
    check(
        adaptive_header.find("GPU CUDA RK adaptive runtime module header") !=
                std::string::npos &&
            adaptive_header.find("struct GpuAdaptiveResult") !=
                std::string::npos &&
            adaptive_header.find("gpu_rk_adaptive_pi_step(") !=
                std::string::npos &&
            adaptive_header.find("gpu_rk_restore_adaptive_reject_magnetization_device(") !=
                std::string::npos,
        "GPU CUDA RK adaptive runtime header must own adaptive result, PI step, and reject restore declarations");
    check(
        adaptive_source.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") !=
                std::string::npos &&
            adaptive_source.find("GPU CUDA RK adaptive runtime source contract") !=
                std::string::npos,
        "GPU CUDA RK adaptive runtime source must document and include its module header");
    check(
        adaptive_source.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            adaptive_source.find("ctx.adaptive_dt.prev_error_norm") !=
                std::string::npos,
        "GPU CUDA RK adaptive runtime source must own adaptive PI and reject restore helpers");
    check(
        adaptive_header.find("gpu_rk_compute_adaptive_error_norm_device(") ==
                std::string::npos &&
            adaptive_source.find("gpu_rk_compute_adaptive_error_norm_device(") ==
                std::string::npos &&
            adaptive_source.find("fullmag_cuda_adaptive_error_norm_blocks(") ==
                std::string::npos &&
            adaptive_source.find("fullmag_cuda_device_max(") ==
                std::string::npos &&
            adaptive_source.find("gpu_rk_read_scalar_result(") ==
                std::string::npos,
        "GPU CUDA RK adaptive runtime module must not own adaptive error-norm reductions");
    check(
        error_norm_header.find("GPU CUDA RK adaptive error-norm runtime module header") !=
                std::string::npos &&
            error_norm_header.find("gpu_rk_compute_adaptive_error_norm_device(") !=
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime header must own device error norm declarations");
    check(
        error_norm_source.find("#include \"gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp\"") !=
                std::string::npos &&
            error_norm_source.find("GPU CUDA RK adaptive error-norm runtime source contract") !=
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must document and include its module header");
    check(
        error_norm_source.find("gpu_rk_compute_adaptive_error_norm_device(") !=
                std::string::npos &&
            error_norm_source.find("fullmag_cuda_adaptive_error_norm_blocks(") !=
                std::string::npos &&
            error_norm_source.find("fullmag_cuda_device_max(") !=
                std::string::npos &&
            error_norm_source.find("gpu.scalar_reduce_workspace") !=
                std::string::npos &&
            error_norm_source.find("gpu.scalar_reduce_temp_storage") !=
                std::string::npos &&
            error_norm_source.find("gpu_rk_read_scalar_result(") !=
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must own device error norm reduction helpers");
    check(
        error_norm_source.find("gpu_rk_copy_component_device(") ==
                std::string::npos &&
            error_norm_source.find("gpu_rk_adaptive_pi_step(") ==
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must not own adaptive policy or reject restore helpers");
    check(
        adaptive_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            adaptive_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK adaptive runtime source must not own RK step orchestration or RHS assembly");
    check(
        error_norm_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            error_norm_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must not own RK step orchestration or RHS assembly");
    check(
        rk_step.find("GpuAdaptiveResult gpu_adaptive_pi_step(") == std::string::npos &&
            rk_step.find("bool restore_adaptive_reject_magnetization_device(") ==
                std::string::npos &&
            rk_step.find("bool compute_adaptive_error_norm_device(") ==
                std::string::npos,
        "GPU CUDA RK step source must not own adaptive runtime helper implementations");
}

void gpu_rk_attempt_loop_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string attempt_loop_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.hpp");
    const std::string attempt_loop_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_attempt_loop.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK attempt loop from gpu/cuda/integrators/rk");
    check(
        rk_step.find("#include \"gpu/cuda/integrators/rk/rk_attempt_loop.hpp\"") !=
            std::string::npos,
        "GPU CUDA RK step source must include the RK attempt loop module");
    check(
        attempt_loop_header.find("GPU CUDA RK attempt loop module header") !=
                std::string::npos &&
            attempt_loop_header.find("struct GpuRkAcceptedAttemptResult") !=
                std::string::npos &&
            attempt_loop_header.find("gpu_rk_run_accepted_attempt_loop(") !=
                std::string::npos,
        "GPU CUDA RK attempt loop header must document and declare the accepted-attempt loop");
    check(
        attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_attempt_loop.hpp\"") !=
                std::string::npos &&
            attempt_loop_source.find("GPU CUDA RK attempt loop source contract") !=
                std::string::npos,
        "GPU CUDA RK attempt loop source must document and include its module header");
    check(
        attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") !=
                std::string::npos &&
            attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp\"") !=
                std::string::npos &&
            attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_stage_schedule.hpp\"") !=
                std::string::npos,
        "GPU CUDA RK attempt loop source must include adaptive policy, error norm, and stage schedule modules");
    check(
        attempt_loop_source.find("gpu_rk_run_stage_attempt(") !=
                std::string::npos &&
            attempt_loop_source.find("gpu_rk_compute_adaptive_error_norm_device(") !=
                std::string::npos &&
            attempt_loop_source.find("gpu_rk_adaptive_pi_step(ctx, error_estimate)") !=
                std::string::npos &&
            attempt_loop_source.find("gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)") !=
                std::string::npos &&
            attempt_loop_source.find("for (;;) {") !=
                std::string::npos &&
            attempt_loop_source.find("rejected_attempts += 1") !=
                std::string::npos &&
            attempt_loop_source.find("ctx.adaptive_dt.max_reject") !=
                std::string::npos &&
            attempt_loop_source.find("adaptive_config.max_reject") !=
                std::string::npos &&
            attempt_loop_source.find("format_scientific(error_estimate)") !=
                std::string::npos,
        "GPU CUDA RK attempt loop source must own fixed/adaptive stage attempts and accept/reject retry handling");
    check(
        attempt_loop_source.find("result.active_dt = active_dt") !=
                std::string::npos &&
            attempt_loop_source.find("result.total_stage_rhs_evaluations = total_stage_rhs_evaluations") !=
                std::string::npos &&
            attempt_loop_source.find("result.fsal_reused = fsal_reused") !=
                std::string::npos,
        "GPU CUDA RK attempt loop source must publish accepted attempt results to rk_step");
    check(
        rk_step.find("gpu_rk_run_accepted_attempt_loop(") !=
                std::string::npos &&
            rk_step.find("for (;;) {") == std::string::npos &&
            rk_step.find("gpu_rk_compute_adaptive_error_norm_device(") ==
                std::string::npos &&
            rk_step.find("gpu_rk_restore_adaptive_reject_magnetization_device(") ==
                std::string::npos &&
            rk_step.find("adaptive_config.max_reject") ==
                std::string::npos &&
            rk_step.find("format_scientific(") == std::string::npos,
        "GPU CUDA RK step source must delegate adaptive attempt loop details");
    check(
        attempt_loop_source.find("gpu_rk_finalize_accepted_step(") ==
            std::string::npos,
        "GPU CUDA RK attempt loop source must not own accepted-step finalization");
}

void gpu_rk_rhs_runtime_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string preflight_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_preflight.cu");
    const std::string rhs_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.hpp");
    const std::string rhs_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.cu");
    const std::string fsal_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_fsal_policy.hpp");
    const std::string fsal_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_fsal_policy.cpp");
    const std::string exchange_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.hpp");
    const std::string exchange_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");
    const std::string demag_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_dispatch.hpp");
    const std::string demag_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_dispatch.cu");
    const std::string llg_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_llg_rhs_dispatch.hpp");
    const std::string llg_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_llg_rhs_dispatch.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_rhs_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK RHS runtime helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_fsal_policy.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK FSAL policy from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_exchange_dispatch.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK exchange dispatch from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_demag_dispatch.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK demag dispatch from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK LLG RHS dispatch from gpu/cuda/integrators/rk");
    check(
        preflight_source.find("#include \"gpu/cuda/integrators/rk/rk_fsal_policy.hpp\"") !=
                std::string::npos &&
            rk_step.find("#include \"gpu/cuda/integrators/rk/rk_fsal_policy.hpp\"") ==
                std::string::npos &&
            rk_step.find("#include \"gpu/cuda/integrators/rk/rk_rhs_runtime.hpp\"") ==
                std::string::npos,
        "GPU CUDA RK step preflight source must include the RK FSAL policy module from the RHS stack");
    check(
        rhs_header.find("GPU CUDA RK RHS runtime module header") !=
                std::string::npos &&
            rhs_header.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos,
        "GPU CUDA RK RHS runtime header must own RHS declarations");
    check(
        rhs_header.find("gpu_rk_rhs_allows_fsal_reuse(") == std::string::npos &&
            rhs_source.find("gpu_rk_rhs_allows_fsal_reuse(") == std::string::npos,
        "GPU CUDA RK RHS runtime module must not own FSAL reuse policy");
    check(
        fsal_header.find("GPU CUDA RK FSAL policy module header") !=
                std::string::npos &&
            fsal_header.find("gpu_rk_rhs_allows_fsal_reuse(") !=
                std::string::npos,
        "GPU CUDA RK FSAL policy header must own the autonomous-RHS reuse declaration");
    check(
        fsal_source.find("#include \"gpu/cuda/integrators/rk/rk_fsal_policy.hpp\"") !=
                std::string::npos &&
            fsal_source.find("GPU CUDA RK FSAL policy source contract") !=
                std::string::npos &&
            fsal_source.find("ctx.thermal_brown.temperature > 0.0") !=
                std::string::npos &&
            fsal_source.find("ctx.oersted.time_dep_kind != 0u") !=
                std::string::npos,
        "GPU CUDA RK FSAL policy source must reject stochastic Brown thermal and time-dependent Oersted RHS");
    check(
        rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_rhs_runtime.hpp\"") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp\"") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_demag_dispatch.hpp\"") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp\"") !=
                std::string::npos &&
            rhs_source.find("GPU CUDA RK RHS runtime source contract") !=
                std::string::npos,
        "GPU CUDA RK RHS runtime source must document and include its module and exchange/demag/LLG RHS dispatch headers");
    check(
        exchange_header.find("GPU CUDA RK exchange dispatch module header") !=
                std::string::npos &&
            exchange_header.find("gpu_rk_compute_legacy_sparse_exchange(") !=
                std::string::npos,
        "GPU CUDA RK exchange dispatch header must own the legacy sparse exchange declaration");
    check(
        exchange_source.find("#include \"gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp\"") !=
                std::string::npos &&
            exchange_source.find("GPU CUDA RK exchange dispatch source contract") !=
                std::string::npos &&
            exchange_source.find("fullmag_cuda_legacy_sparse_exchange(") !=
                std::string::npos &&
            exchange_source.find("GPU legacy sparse exchange requires uploaded CSR/mass device buffers") !=
                std::string::npos &&
            exchange_source.find("GPU legacy sparse exchange dimensions do not match RK node_count") !=
                std::string::npos,
        "GPU CUDA RK exchange dispatch source must own legacy sparse exchange validation and kernel dispatch");
    check(
        demag_header.find("GPU CUDA RK demag dispatch module header") !=
                std::string::npos &&
            demag_header.find("gpu_rk_compute_demag_for_device_stage(") !=
                std::string::npos,
        "GPU CUDA RK demag dispatch header must own the per-stage demag dispatch declaration");
    check(
        demag_source.find("#include \"gpu/cuda/integrators/rk/rk_demag_dispatch.hpp\"") !=
                std::string::npos &&
            demag_source.find("GPU CUDA RK demag dispatch source contract") !=
                std::string::npos &&
            demag_source.find("gpu_rk_compute_hybrid_cpu_demag_for_device_stage(") !=
                std::string::npos &&
            demag_source.find("compute_device_demag_for_device_stage(ctx, m, stream, reason)") !=
                std::string::npos &&
            demag_source.find("compute_demag_field_for_magnetization(") !=
                std::string::npos &&
            demag_source.find("gpu_state_upload_demag_field_aos(") !=
                std::string::npos &&
            demag_source.find("FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON") !=
                std::string::npos,
        "GPU CUDA RK demag dispatch source must own strict device and hybrid CPU Poisson demag dispatch");
    check(
        llg_header.find("GPU CUDA RK LLG RHS dispatch module header") !=
                std::string::npos &&
            llg_header.find("gpu_rk_compute_llg_rhs(") !=
                std::string::npos,
        "GPU CUDA RK LLG RHS dispatch header must own the fused LLG RHS dispatch declaration");
    check(
        llg_source.find("#include \"gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp\"") !=
                std::string::npos &&
            llg_source.find("GPU CUDA RK LLG RHS dispatch source contract") !=
                std::string::npos &&
            llg_source.find("fullmag_cuda_llg_rhs_fused(") !=
                std::string::npos &&
            llg_source.find("launch GPU RK RHS") !=
                std::string::npos &&
            llg_source.find("ctx.base_plan.precession_enabled") !=
                std::string::npos &&
            llg_source.find("ctx.material_fields.material.gyromagnetic_ratio") !=
                std::string::npos &&
            llg_source.find("ctx.material_fields.material.damping") !=
                std::string::npos,
        "GPU CUDA RK LLG RHS dispatch source must own fused LLG RHS launch and gamma/damping/precession arguments");
    check(
        rhs_source.find("gpu_rk_compute_rhs_for_magnetization(") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_legacy_sparse_exchange(") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_demag_for_device_stage(ctx, m, stream, reason)") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_dmi_fields.hpp\"") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_dmi_field_contributions(ctx, m, stream, n, reason)") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_local_fields.hpp\"") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_local_field_contributions(ctx, m, stream, n, reason)") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_effective_field.hpp\"") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_accumulate_effective_field(ctx, stream, n, label, reason)") !=
                std::string::npos &&
            rhs_source.find("#include \"gpu/cuda/integrators/rk/rk_direct_torques.hpp\"") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_add_direct_torques(ctx, m, rhs, stream, n, reason)") !=
                std::string::npos &&
            rhs_source.find("gpu_rk_compute_llg_rhs(ctx, m, rhs, stream, n, reason)") !=
                std::string::npos,
        "GPU CUDA RK RHS runtime source must own exchange, demag dispatch, local-field contribution dispatch, and LLG RHS orchestration");
    check(
        rhs_source.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos &&
            rhs_source.find("launch GPU RK RHS") == std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate fused LLG RHS launch");
    check(
        rhs_source.find("fullmag_cuda_legacy_sparse_exchange(") == std::string::npos &&
            rhs_source.find("GPU legacy sparse exchange requires uploaded CSR/mass device buffers") ==
                std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate legacy sparse exchange validation and kernel dispatch");
    check(
        rhs_source.find("gpu_rk_compute_hybrid_cpu_demag_for_device_stage(") ==
                std::string::npos &&
            rhs_source.find("compute_device_demag_for_device_stage(") ==
                std::string::npos &&
            rhs_source.find("compute_demag_field_for_magnetization(") ==
                std::string::npos &&
            rhs_source.find("gpu_state_upload_demag_field_aos(") ==
                std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate demag mode dispatch and hybrid CPU transfer path");
    check(
        rhs_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            rhs_source.find("gpu_rk_finalize_step_stats(") == std::string::npos,
        "GPU CUDA RK RHS runtime source must not own RK step orchestration or final stats");
    check(
        rhs_source.find("launch GPU RK uniaxial anisotropy field") == std::string::npos &&
            rhs_source.find("launch GPU RK cubic anisotropy field") == std::string::npos &&
            rhs_source.find("launch GPU RK magnetoelastic field") == std::string::npos &&
            rhs_source.find("launch GPU RK deterministic thermal field") ==
                std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate local-field generation to the local-field module");
    check(
        rhs_source.find("fullmag_cuda_accumulate_heff(") == std::string::npos &&
            rhs_source.find("fullmag_cuda_add_field_inplace(") == std::string::npos &&
            rhs_source.find("fullmag_cuda_add_scaled_field_inplace(") ==
                std::string::npos &&
            rhs_source.find("gpu_rk_oersted_scale(") == std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate H_eff accumulation to the effective-field module");
    check(
        rhs_source.find("fullmag_cuda_add_slonczewski_stt_rhs(") ==
                std::string::npos &&
            rhs_source.find("fullmag_cuda_add_zhang_li_stt_rhs(") ==
                std::string::npos &&
            rhs_source.find("gpu_rk_current_density_magnitude(") ==
                std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate direct torque RHS additions to the direct-torque module");
    check(
        rhs_source.find("fullmag_cuda_dmi_field_energy(") == std::string::npos &&
            rhs_source.find("auto compute_dmi_field") == std::string::npos &&
            rhs_source.find("launch GPU RK interfacial DMI field") ==
                std::string::npos &&
            rhs_source.find("launch GPU RK bulk DMI field") == std::string::npos,
        "GPU CUDA RK RHS runtime source must delegate DMI field generation to the DMI field module");
    check(
        rk_step.find("bool compute_rhs_for_magnetization(") == std::string::npos &&
            rk_step.find("bool compute_legacy_sparse_exchange(") == std::string::npos &&
            rk_step.find("bool compute_hybrid_cpu_demag_for_device_stage(") ==
                std::string::npos,
        "GPU CUDA RK step source must not own RHS runtime helper implementations");
}

void gpu_rk_local_fields_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string local_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_local_fields.hpp");
    const std::string local_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_local_fields.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_local_fields.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK local-field helpers from gpu/cuda/integrators/rk");
    check(
        local_header.find("GPU CUDA RK local field contributions module header") !=
                std::string::npos &&
            local_header.find("gpu_rk_compute_local_field_contributions(") !=
                std::string::npos,
        "GPU CUDA RK local-field header must document and declare local-field contribution generation");
    check(
        local_source.find("#include \"gpu/cuda/integrators/rk/rk_local_fields.hpp\"") !=
                std::string::npos &&
            local_source.find("GPU CUDA RK local field contributions source contract") !=
                std::string::npos,
        "GPU CUDA RK local-field source must document and include its module header");
    check(
        local_source.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            local_source.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            local_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") !=
                std::string::npos &&
            local_source.find("fullmag_cuda_thermal_field_blocks(") !=
                std::string::npos,
        "GPU CUDA RK local-field source must own local field contribution generation");
    check(
        local_source.find("gpu_rk_compute_rhs_for_magnetization(") == std::string::npos &&
            local_source.find("gpu_rk_compute_legacy_sparse_exchange(") ==
                std::string::npos &&
            local_source.find("compute_device_demag_for_device_stage(") ==
                std::string::npos &&
            local_source.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos,
        "GPU CUDA RK local-field source must not own RHS orchestration, exchange, demag, or LLG RHS");
}

void gpu_rk_effective_field_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string effective_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_effective_field.hpp");
    const std::string effective_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_effective_field.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_effective_field.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK effective-field helpers from gpu/cuda/integrators/rk");
    check(
        effective_header.find("GPU CUDA RK effective field accumulation module header") !=
                std::string::npos &&
            effective_header.find("gpu_rk_accumulate_effective_field(") !=
                std::string::npos,
        "GPU CUDA RK effective-field header must document and declare H_eff accumulation");
    check(
        effective_source.find("#include \"gpu/cuda/integrators/rk/rk_effective_field.hpp\"") !=
                std::string::npos &&
            effective_source.find("GPU CUDA RK effective field accumulation source contract") !=
                std::string::npos,
        "GPU CUDA RK effective-field source must document and include its module header");
    check(
        effective_source.find("fullmag_cuda_accumulate_heff(") !=
                std::string::npos &&
            effective_source.find("fullmag_cuda_add_field_inplace(") !=
                std::string::npos &&
            effective_source.find("fullmag_cuda_add_scaled_field_inplace(") !=
                std::string::npos &&
            effective_source.find("double gpu_rk_oersted_scale(const Context &ctx)") !=
                std::string::npos,
        "GPU CUDA RK effective-field source must own base, local, and Oersted H_eff accumulation");
    check(
        effective_source.find("gpu_rk_compute_rhs_for_magnetization(") == std::string::npos &&
            effective_source.find("gpu_rk_compute_local_field_contributions(") ==
                std::string::npos &&
            effective_source.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos &&
            effective_source.find("fullmag_cuda_add_slonczewski_stt_rhs(") ==
                std::string::npos,
        "GPU CUDA RK effective-field source must not own RHS orchestration, local field generation, LLG RHS, or direct torques");
}

void gpu_rk_direct_torques_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string direct_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_direct_torques.hpp");
    const std::string direct_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_direct_torques.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_direct_torques.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK direct-torque helpers from gpu/cuda/integrators/rk");
    check(
        direct_header.find("GPU CUDA RK direct torque module header") !=
                std::string::npos &&
            direct_header.find("gpu_rk_add_direct_torques(") !=
                std::string::npos,
        "GPU CUDA RK direct-torque header must document and declare direct torque RHS additions");
    check(
        direct_source.find("#include \"gpu/cuda/integrators/rk/rk_direct_torques.hpp\"") !=
                std::string::npos &&
            direct_source.find("GPU CUDA RK direct torque source contract") !=
                std::string::npos,
        "GPU CUDA RK direct-torque source must document and include its module header");
    check(
        direct_source.find("fullmag_cuda_add_slonczewski_stt_rhs(") !=
                std::string::npos &&
            direct_source.find("fullmag_cuda_add_zhang_li_stt_rhs(") !=
                std::string::npos &&
            direct_source.find("gpu_rk_current_density_magnitude(ctx)") !=
                std::string::npos &&
            direct_source.find("gpu_rk_resolve_slonczewski_thickness(ctx)") !=
                std::string::npos &&
            direct_source.find("requires device-resident mesh geometry") !=
                std::string::npos,
        "GPU CUDA RK direct-torque source must own Slonczewski and Zhang-Li RHS additions");
    check(
        direct_source.find("gpu_rk_compute_rhs_for_magnetization(") == std::string::npos &&
            direct_source.find("gpu_rk_accumulate_effective_field(") ==
                std::string::npos &&
            direct_source.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos &&
            direct_source.find("compute_device_demag_for_device_stage(") ==
                std::string::npos,
        "GPU CUDA RK direct-torque source must not own RHS orchestration, H_eff accumulation, LLG RHS, or demag dispatch");
}

void gpu_rk_dmi_fields_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string dmi_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_fields.hpp");
    const std::string dmi_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_fields.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_dmi_fields.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK DMI field helpers from gpu/cuda/integrators/rk");
    check(
        dmi_header.find("GPU CUDA RK DMI field contributions module header") !=
                std::string::npos &&
            dmi_header.find("gpu_rk_compute_dmi_field_contributions(") !=
                std::string::npos,
        "GPU CUDA RK DMI field header must document and declare DMI field generation");
    check(
        dmi_source.find("#include \"gpu/cuda/integrators/rk/rk_dmi_fields.hpp\"") !=
                std::string::npos &&
            dmi_source.find("GPU CUDA RK DMI field contributions source contract") !=
                std::string::npos,
        "GPU CUDA RK DMI field source must document and include its module header");
    check(
        dmi_source.find("fullmag_cuda_dmi_field_energy(") != std::string::npos &&
            dmi_source.find("launch GPU RK interfacial DMI field") !=
                std::string::npos &&
            dmi_source.find("launch GPU RK bulk DMI field") != std::string::npos &&
            dmi_source.find("requires device-resident mesh geometry") !=
                std::string::npos,
        "GPU CUDA RK DMI field source must own interfacial and bulk DMI field generation");
    check(
        dmi_source.find("gpu_rk_compute_rhs_for_magnetization(") == std::string::npos &&
            dmi_source.find("gpu_rk_accumulate_effective_field(") ==
                std::string::npos &&
            dmi_source.find("fullmag_cuda_llg_rhs_fused(") == std::string::npos &&
            dmi_source.find("compute_device_demag_for_device_stage(") ==
                std::string::npos &&
            dmi_source.find("gpu_rk_compute_legacy_sparse_exchange(") ==
                std::string::npos,
        "GPU CUDA RK DMI field source must not own RHS orchestration, H_eff accumulation, LLG RHS, demag, or exchange");
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
    gpu_rk_step_preflight_is_owned_by_cuda_rk_module();
    gpu_rk_snapshot_is_owned_by_cuda_rk_module();
    gpu_rk_step_stats_is_owned_by_cuda_rk_module();
    gpu_rk_final_refresh_is_owned_by_cuda_rk_module();
    gpu_rk_stage_schedule_is_owned_by_cuda_rk_module();
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
    gpu_rk_attempt_loop_is_owned_by_cuda_rk_module();
    gpu_rk_rhs_runtime_is_owned_by_cuda_rk_module();
    gpu_rk_local_fields_are_owned_by_cuda_rk_module();
    gpu_rk_effective_field_is_owned_by_cuda_rk_module();
    gpu_rk_direct_torques_are_owned_by_cuda_rk_module();
    gpu_rk_dmi_fields_are_owned_by_cuda_rk_module();
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
