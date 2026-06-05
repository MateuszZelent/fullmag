/*
 * source_facade_contract.cpp - native FEM source-facade ownership docs.
 *
 * Split from source_facade_contract.cpp so each native FEM source-layout
 * contract has a narrow ownership surface and stays below the monolith limit.
 */

#include "source_facade_contract_utils.hpp"

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::fem_source_root;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

void backend_root_is_top_level_backends_tree() {
    const std::filesystem::path root = fem_source_root();
    check(
        root.filename() == "fem" && root.parent_path().filename() == "backends",
        "native FEM source root must be top-level backends/fem");
    check(
        !std::filesystem::exists(repo_root() / "native" / "backends" / "fem"),
        "native/backends/fem must not be recreated as an implementation root");
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
        api.find("fullmag_fem_backend_set_step_profile(") != std::string::npos &&
            api.find("fullmag::fem::set_gpu_step_profile(handle->context") !=
                std::string::npos,
        "api source file must delegate step-profile configuration through the GPU runtime module");
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
    const auto mask_init_pos = context_builder.find("initialize_magnetic_masks(ctx)");
    const auto state_init_pos =
        context_builder.find("initialize_state_plan_fields(ctx, plan, error)");
    check(
        mask_init_pos != std::string::npos &&
            state_init_pos != std::string::npos &&
            mask_init_pos < state_init_pos,
        "Context builder must initialize magnetic masks before state normalization");
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
    const std::string exchange_state_header =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_state.hpp");
    const std::string exchange_upload_header =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_upload.hpp");
    const std::string exchange_upload_source =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_upload.cpp");
    const std::string mesh_metrics_header =
        read_text_file(root / "gpu" / "cuda" / "mesh" / "mesh_metrics_state.hpp");
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");

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
        exchange_state_header.find("GPU CUDA legacy sparse exchange device-state module header") !=
                std::string::npos &&
            exchange_state_header.find("struct LegacyGpuExchangeDeviceState") !=
                std::string::npos &&
            exchange_state_header.find("lumped_mass") == std::string::npos &&
            exchange_state_header.find("inv_lumped_mass") == std::string::npos,
        "GPU CUDA exchange module must own legacy sparse exchange device-state metadata");
    check(
        exchange_upload_header.find("GPU CUDA legacy sparse exchange upload module header") !=
                std::string::npos &&
            exchange_upload_source.find("GPU CUDA legacy sparse exchange upload source contract") !=
                std::string::npos &&
            exchange_upload_header.find("bool gpu_exchange_upload_legacy_sparse(") !=
                std::string::npos &&
            exchange_upload_source.find("bool gpu_exchange_upload_legacy_sparse(") !=
                std::string::npos &&
            exchange_upload_header.find("void gpu_exchange_reset_legacy_sparse(") !=
                std::string::npos &&
            exchange_upload_source.find("void gpu_exchange_reset_legacy_sparse(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/exchange/exchange_upload.cpp") !=
                std::string::npos,
        "GPU CUDA exchange module must own legacy sparse exchange upload/allocation");
    check(
        mesh_metrics_header.find("GPU CUDA mesh metrics device-state module header") !=
                std::string::npos &&
            mesh_metrics_header.find("struct FemGpuMeshMetricsDeviceState") !=
                std::string::npos &&
            mesh_metrics_header.find("double *lumped_mass") != std::string::npos &&
            mesh_metrics_header.find("double *inv_lumped_mass") != std::string::npos,
        "GPU CUDA mesh module must own shared lumped-mass device metrics");
    check(
        gpu_state_header.find("#include \"gpu/cuda/exchange/exchange_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("#include \"gpu/cuda/mesh/mesh_metrics_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("LegacyGpuExchangeDeviceState legacy_exchange{}") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuMeshMetricsDeviceState mesh_metrics{}") !=
                std::string::npos &&
            gpu_state_header.find("bool exchange_legacy_sparse_uploaded") ==
                std::string::npos,
        "FemGpuState must store legacy sparse exchange and shared mesh-metric device buffers through explicit substates");
    check(
        gpu_state_source.find("gpu_exchange_upload_legacy_sparse(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_exchange_reset_legacy_sparse(") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle") != std::string::npos &&
            gpu_state_source.find("state.legacy_exchange") !=
                std::string::npos &&
            gpu_state_source.find("state.mesh_metrics") != std::string::npos &&
            exchange_upload_source.find("legacy_exchange.csr_row_offsets") !=
                std::string::npos &&
            exchange_upload_source.find("legacy_exchange.csr_col_indices") !=
                std::string::npos &&
            exchange_upload_source.find("legacy_exchange.csr_values") !=
                std::string::npos &&
            exchange_upload_source.find("mesh_metrics.lumped_mass") !=
                std::string::npos &&
            exchange_upload_source.find("mesh_metrics.inv_lumped_mass") !=
                std::string::npos &&
            exchange_upload_source.find("legacy_exchange.uploaded = true") !=
                std::string::npos &&
            exchange_upload_source.find("mesh_metrics.uploaded = true") !=
                std::string::npos &&
            exchange_upload_source.find("lifecycle.device_bytes -= previous_device_bytes") !=
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.legacy_exchange.csr_row_offsets") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.legacy_exchange.csr_col_indices") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.legacy_exchange.csr_values") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_metrics.lumped_mass") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_metrics.inv_lumped_mass") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_u32(state.legacy_exchange") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.legacy_exchange") ==
                std::string::npos,
        "GPU state must delegate legacy sparse exchange upload details to the exchange module");
    check(
        module.find("does not own Context construction, MFEM exchange assembly, CPU fallback exchange, integrator execution, or C ABI entrypoints") !=
            std::string::npos,
        "GPU CUDA exchange planning module must document its non-owning module boundary");
}


void gpu_runtime_coefficients_have_explicit_device_substates() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string component_transfer_source =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "component_transfer.cpp");
    const std::string runtime_coefficients_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "runtime_coefficients_state.hpp");
    const std::string runtime_coefficients_memory_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "runtime_coefficients_memory.hpp");
    const std::string runtime_coefficients_memory_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "runtime_coefficients_memory.cpp");
    const std::string runtime_coefficients_upload_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "runtime_coefficients_upload.hpp");
    const std::string runtime_coefficients_upload_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "runtime_coefficients_upload.cpp");
    const std::string material_state_header =
        read_text_file(root / "gpu" / "cuda" / "materials" / "material_state.hpp");
    const std::string mesh_metrics_header =
        read_text_file(root / "gpu" / "cuda" / "mesh" / "mesh_metrics_state.hpp");
    const std::string mesh_regions_header =
        read_text_file(root / "gpu" / "cuda" / "mesh" / "mesh_regions_state.hpp");
    const std::string llg_rhs_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_llg_rhs_dispatch.cu");
    const std::string thermal_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_thermal_field.cu");
    const std::string anisotropy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_anisotropy_field.cu");
    const std::string exchange_dispatch_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");
    const std::string exchange_plan_source =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_plan.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");

    check(
        runtime_coefficients_header.find("GPU CUDA runtime-coefficients readiness device-state module header") !=
                std::string::npos &&
            runtime_coefficients_header.find("struct FemGpuRuntimeCoefficientDeviceState") !=
                std::string::npos &&
            runtime_coefficients_header.find("bool uploaded = false") !=
                std::string::npos,
        "GPU CUDA state module must own runtime-coefficients readiness state");
    check(
        runtime_coefficients_upload_header.find("GPU CUDA runtime-coefficients upload module header") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("GPU CUDA runtime-coefficients upload source contract") !=
                std::string::npos &&
            runtime_coefficients_upload_header.find("bool gpu_runtime_coefficients_upload(") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("bool gpu_runtime_coefficients_upload(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/state/runtime_coefficients_upload.cpp") !=
                std::string::npos,
        "GPU CUDA state module must own runtime-coefficients upload/allocation boundary");
    check(
        runtime_coefficients_memory_header.find("GPU CUDA runtime-coefficients memory module header") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("GPU CUDA runtime-coefficients memory source contract") !=
                std::string::npos &&
            runtime_coefficients_memory_header.find("bool gpu_runtime_coefficients_allocate(") !=
                std::string::npos &&
            runtime_coefficients_memory_header.find("void gpu_runtime_coefficients_free(") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("bool gpu_runtime_coefficients_allocate(") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("void gpu_runtime_coefficients_free(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/state/runtime_coefficients_memory.cpp") !=
                std::string::npos,
        "GPU CUDA state module must own runtime-coefficients memory helpers");
    check(
        material_state_header.find("GPU CUDA material device-state module header") !=
                std::string::npos &&
            material_state_header.find("struct FemGpuMaterialDeviceState") !=
                std::string::npos &&
            material_state_header.find("double *ms") != std::string::npos &&
            material_state_header.find("double *alpha") != std::string::npos &&
            material_state_header.find("double *kc3") != std::string::npos,
        "GPU CUDA material module must own device-side material coefficients");
    check(
        mesh_metrics_header.find("double *node_volumes") != std::string::npos,
        "GPU CUDA mesh metrics module must own device-side node volumes");
    check(
        mesh_regions_header.find("GPU CUDA mesh region device-state module header") !=
                std::string::npos &&
            mesh_regions_header.find("struct FemGpuMeshRegionDeviceState") !=
                std::string::npos &&
            mesh_regions_header.find("uint8_t *magnetic_node_mask") !=
                std::string::npos &&
            mesh_regions_header.find("uint32_t *periodic_reduced_node") !=
                std::string::npos &&
            mesh_regions_header.find("uint32_t *periodic_representative_nodes") !=
                std::string::npos,
        "GPU CUDA mesh region module must own device-side magnetic masks and periodic maps");
    check(
        gpu_state_header.find("#include \"gpu/cuda/state/runtime_coefficients_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuRuntimeCoefficientDeviceState runtime_coefficients{}") !=
                std::string::npos &&
            gpu_state_header.find("bool runtime_coefficients_uploaded = false") ==
                std::string::npos &&
            gpu_state_header.find("#include \"gpu/cuda/materials/material_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("#include \"gpu/cuda/mesh/mesh_regions_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuMaterialDeviceState materials{}") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuMeshRegionDeviceState mesh_regions{}") !=
                std::string::npos &&
            gpu_state_header.find("double *ms = nullptr") == std::string::npos &&
            gpu_state_header.find("double *alpha = nullptr") == std::string::npos &&
            gpu_state_header.find("double *node_volumes = nullptr") == std::string::npos &&
            gpu_state_header.find("uint8_t *magnetic_node_mask = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("uint32_t *periodic_reduced_node = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("uint32_t *periodic_representative_nodes = nullptr") ==
                std::string::npos,
        "FemGpuState must store runtime coefficients and mesh region maps through explicit substates");
    check(
        gpu_state_source.find("gpu_runtime_coefficients_upload(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_runtime_coefficients_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_runtime_coefficients_free(") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle") != std::string::npos &&
            gpu_state_source.find("state.runtime_coefficients") !=
                std::string::npos &&
            gpu_state_source.find("state.materials") != std::string::npos &&
            gpu_state_source.find("state.mesh_metrics") != std::string::npos &&
            gpu_state_source.find("state.mesh_regions") != std::string::npos &&
            runtime_coefficients_upload_source.find("materials.ms") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("materials.alpha") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("mesh_metrics.node_volumes") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("mesh_regions.magnetic_node_mask") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("mesh_regions.periodic_reduced_node") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("mesh_regions.periodic_representative_nodes") !=
                std::string::npos &&
            runtime_coefficients_upload_source.find("runtime_coefficients.uploaded") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("mesh_metrics.node_volumes") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("materials.ms") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("materials.alpha") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("mesh_regions.magnetic_node_mask") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("mesh_regions.periodic_reduced_node") !=
                std::string::npos &&
            runtime_coefficients_memory_source.find("mesh_regions.periodic_representative_nodes") !=
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_metrics.node_volumes") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.materials.ms") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_regions.magnetic_node_mask") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.mesh_metrics.node_volumes") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.materials.ms") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.materials.alpha") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_u8(state.mesh_regions.magnetic_node_mask") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_u32(state.mesh_regions.periodic_reduced_node") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.mesh_metrics.node_volumes)") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.materials.ms)") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.materials.alpha)") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_u8(state.mesh_regions.magnetic_node_mask)") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_u32(state.mesh_regions.periodic_reduced_node)") ==
                std::string::npos &&
            gpu_state_source.find("state.runtime_coefficients_uploaded") ==
                std::string::npos &&
            gpu_state_source.find("state.ms") == std::string::npos &&
            gpu_state_source.find("state.node_volumes") == std::string::npos &&
            gpu_state_source.find("state.magnetic_node_mask") == std::string::npos,
        "GPU state upload/allocation must use material, mesh-metric, and mesh-region substates");
    check(
        exchange_plan_source.find("ctx.gpu_state.device.runtime_coefficients.uploaded") !=
                std::string::npos &&
            exchange_plan_source.find("ctx.gpu_state.device.runtime_coefficients_uploaded") ==
                std::string::npos,
        "GPU exchange readiness planning must use the runtime-coefficients readiness substate");
    check(
        llg_rhs_source.find("gpu.materials.alpha") != std::string::npos &&
            anisotropy_source.find("gpu.materials.ms") != std::string::npos &&
            thermal_source.find("gpu.mesh_metrics.node_volumes") != std::string::npos &&
            anisotropy_source.find("gpu.mesh_regions.magnetic_node_mask") !=
                std::string::npos &&
            thermal_source.find("gpu.mesh_regions.magnetic_node_mask") !=
                std::string::npos &&
            exchange_dispatch_source.find("gpu.mesh_regions.magnetic_node_mask") !=
                std::string::npos,
        "GPU RK dispatch must read runtime coefficients through material, mesh-metric, and mesh-region substates");
}


} // namespace

int main() {
    backend_root_is_top_level_backends_tree();
    source_facades_document_module_boundaries();
    common_fem_utilities_have_single_header();
    legacy_gpu_placeholder_sources_are_removed();
    gpu_exchange_planning_is_owned_by_cuda_exchange_module();
    gpu_runtime_coefficients_have_explicit_device_substates();
    return 0;
}
