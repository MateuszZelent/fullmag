/*
 * gpu_state_runtime_contract.cpp - native FEM GPU-state bootstrap contract.
 */

#include "context.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"

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

std::string extract_function_body(const std::string &source, const std::string &signature) {
    const size_t signature_pos = source.find(signature);
    check(signature_pos != std::string::npos, "function signature not found");

    const size_t body_start = source.find('{', signature_pos);
    check(body_start != std::string::npos, "function body start not found");

    int depth = 0;
    for (size_t i = body_start; i < source.size(); ++i) {
        if (source[i] == '{') {
            ++depth;
        } else if (source[i] == '}') {
            --depth;
            if (depth == 0) {
                return source.substr(body_start, i - body_start + 1);
            }
        }
    }
    check(false, "function body end not found");
    return {};
}

void tetrahedral_mesh_geometry_is_required_only_by_its_gpu_consumers() {
    fullmag::fem::Context ctx;
    ctx.exchange.enabled = true;
    ctx.demag.enabled = true;

    check(
        !fullmag::fem::gpu_state_requires_tetrahedral_mesh_geometry(ctx),
        "exchange+Poisson GPU bootstrap must not require flat tetrahedral geometry");

    ctx.dmi.interfacial_enabled = true;
    check(
        fullmag::fem::gpu_state_requires_tetrahedral_mesh_geometry(ctx),
        "interfacial DMI must require tetrahedral GPU geometry");
    ctx.dmi.interfacial_enabled = false;

    ctx.dmi.bulk_enabled = true;
    check(
        fullmag::fem::gpu_state_requires_tetrahedral_mesh_geometry(ctx),
        "bulk DMI must require tetrahedral GPU geometry");
    ctx.dmi.bulk_enabled = false;

    ctx.stt.zhang_li_enabled = true;
    check(
        fullmag::fem::gpu_state_requires_tetrahedral_mesh_geometry(ctx),
        "Zhang-Li STT must require tetrahedral GPU geometry");
}

void gpu_state_bootstrap_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_builder =
        read_text_file(root / "core" / "fem_context_builder.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string runtime =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.cpp");
    const std::string runtime_header =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.hpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string build_context_from_plan = extract_function_body(
        context_builder,
        "bool build_context_from_plan(");
    const std::string initialize_gpu_state = extract_function_body(
        runtime,
        "bool initialize_context_gpu_state(");
    const std::string bootstrap_failure = extract_function_body(
        runtime,
        "bool gpu_bootstrap_failed(");

    check(
        build_context_from_plan.find("initialize_context_gpu_state(ctx, error)") !=
            std::string::npos,
        "Context builder must delegate GPU-state bootstrap to gpu_state_runtime.cpp");
    check(
        build_context_from_plan.find("gpu_state_initialize(") == std::string::npos,
        "Context builder must not own GPU-state allocation");
    check(
        build_context_from_plan.find("gpu_state_upload_runtime_coefficients(") ==
            std::string::npos,
        "Context builder must not own runtime coefficient GPU upload");
    check(
        build_context_from_plan.find("gpu_state_upload_mesh_geometry(") == std::string::npos,
        "Context builder must not own mesh geometry GPU upload");
    check(
        build_context_from_plan.find("gpu_state_upload_effective_fields_aos(") ==
            std::string::npos,
        "Context builder must not own effective-field GPU upload");
    check(
        build_context_from_plan.find("gpu_state_upload_local_vector_fields_aos(") ==
            std::string::npos,
        "Context builder must not own local vector field GPU upload");
    check(
        runtime.find("bool initialize_context_gpu_state(") != std::string::npos,
        "GPU-state bootstrap must be defined in gpu_state_runtime.cpp");
    check(
        cmake.find("gpu/cuda/runtime/gpu_state_runtime.cpp") != std::string::npos,
        "FEM CMake source list must build GPU-state runtime bootstrap from gpu/cuda/runtime");
    check(
        cmake.find("cpu/mfem/runtime/gpu_state_runtime.cpp") == std::string::npos,
        "FEM CMake source list must not build GPU-state runtime bootstrap from cpu/mfem/runtime");
    check(
        !std::filesystem::exists(root / "cpu" / "mfem" / "runtime" / "gpu_state_runtime.cpp") &&
            !std::filesystem::exists(root / "cpu" / "mfem" / "runtime" / "gpu_state_runtime.hpp"),
        "GPU-state runtime bootstrap must not remain under cpu/mfem/runtime");
    check(
        runtime.find("#include \"gpu/cuda/runtime/gpu_state_runtime.hpp\"") !=
            std::string::npos,
        "GPU-state runtime source must include its GPU/CUDA runtime-owned header");
    check(
        runtime.find("GPU CUDA state-runtime source contract") != std::string::npos,
        "GPU-state runtime source must document its GPU/CUDA runtime ownership");
    check(
        runtime_header.find("GPU CUDA state-runtime module header") !=
            std::string::npos,
        "GPU-state runtime header must document its GPU/CUDA runtime ownership");
    check(
        runtime.find("gpu_state_upload_runtime_coefficients(") != std::string::npos,
        "gpu_state_runtime.cpp must upload runtime coefficients");
    check(
        runtime.find("gpu_state_upload_mesh_geometry(") != std::string::npos,
        "gpu_state_runtime.cpp must upload mesh geometry");
    check(
        runtime.find("gpu_state_upload_effective_fields_aos(") != std::string::npos,
        "gpu_state_runtime.cpp must upload effective fields");
    check(
        runtime.find("gpu_state_upload_local_vector_fields_aos(") != std::string::npos,
        "gpu_state_runtime.cpp must upload local vector fields");
    check(
        bootstrap_failure.find("gpu_state_destroy(ctx.gpu_state.device)") !=
                std::string::npos &&
            bootstrap_failure.find("context_destroy_mfem(ctx)") != std::string::npos,
        "GPU bootstrap rollback must centrally destroy FemGpuState and MFEM resources");
    check(
        initialize_gpu_state.find("context_destroy_mfem(ctx)") == std::string::npos,
        "GPU bootstrap exchange/Poisson failures must use the central rollback helper");
    check(
        runtime_header.find("Initialize and upload native FEM GPU state runtime buffers") !=
            std::string::npos,
        "gpu_state_runtime header must document GPU-state bootstrap ownership");
    check(
        runtime_header.find("struct GpuStateRuntimeState") != std::string::npos,
        "gpu_state_runtime header must declare the GPU-state object owner");
    check(
        runtime_header.find("FemGpuState device") != std::string::npos,
        "GPU-state runtime state must own the FemGpuState device buffers");
    check(
        context_header.find("GpuStateRuntimeState gpu_state{}") != std::string::npos,
        "Context must store FemGpuState through the GPU-state runtime owner");
    check(
        context_header.find("FemGpuState gpu_state") == std::string::npos,
        "Context must not own a flat FemGpuState field");
    check(
        runtime_header.find("struct LegacyGpuExchangeRuntimeState") != std::string::npos,
        "gpu_state_runtime header must declare the legacy GPU exchange metadata owner");
    check(
        runtime_header.find("LegacyGpuExchangeRuntimeState legacy_exchange") !=
            std::string::npos,
        "GPU-state runtime owner must store legacy exchange metadata");
    check(
        runtime_header.find("bool legacy_sparse_metadata_ready") != std::string::npos &&
            runtime_header.find("uint64_t legacy_sparse_rows") != std::string::npos &&
            runtime_header.find("uint64_t legacy_sparse_cols") != std::string::npos &&
            runtime_header.find("uint64_t legacy_sparse_nnz") != std::string::npos &&
            runtime_header.find("bool lumped_mass_ready") != std::string::npos,
        "legacy GPU exchange runtime state must own sparse metadata and lumped-mass readiness");
    check(
        context_header.find("LegacyGpuExchangeRuntimeState gpu_exchange") ==
            std::string::npos,
        "Context must not own a flat legacy GPU exchange metadata field");
    for (const char *flat_field : {
             "bool gpu_exchange_legacy_sparse_metadata_ready",
             "uint64_t gpu_exchange_legacy_sparse_rows",
             "uint64_t gpu_exchange_legacy_sparse_cols",
             "uint64_t gpu_exchange_legacy_sparse_nnz",
             "bool gpu_exchange_lumped_mass_ready",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat legacy GPU exchange metadata fields");
    }
    check(
        runtime_header.find("struct CudaRuntimeState") != std::string::npos,
        "gpu_state_runtime header must declare the CUDA stream/snapshot state owner");
    check(
        runtime_header.find("void *compute_stream") != std::string::npos &&
            runtime_header.find("void *io_stream") != std::string::npos &&
            runtime_header.find("void *compute_event") != std::string::npos &&
            runtime_header.find("std::shared_ptr<FemGpuSnapshotPoolState> snapshot_pool") !=
                std::string::npos,
        "CUDA runtime state must own streams, compute event, and the bounded snapshot pool");
    check(
        runtime_header.find("CudaRuntimeState cuda") != std::string::npos,
        "GPU-state runtime owner must store CUDA stream/snapshot state");
    check(
        context_header.find("CudaRuntimeState cuda_runtime") == std::string::npos,
        "Context must not own a flat CUDA stream/snapshot runtime field");
    for (const char *flat_cuda_field : {
             "void *compute_stream",
             "void *io_stream",
             "void *compute_event",
             "std::shared_ptr<FemGpuSnapshotPoolState> snapshot_pool",
         }) {
        check(
            context_header.find(flat_cuda_field) == std::string::npos,
            "Context must not own flat CUDA stream/snapshot fields");
    }
}

void gpu_state_audit04_memory_contracts_are_source_visible() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string runtime =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.cpp");
    const std::string transfer_kernels =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_kernels.cu");
    const std::string component_transfer =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "component_transfer.cpp");
    const std::string magnetization_transfer =
        read_text_file(root / "gpu" / "cuda" / "state" / "magnetization_transfer.cpp");

    const std::string initialize_body =
        extract_function_body(gpu_state, "bool gpu_state_initialize(");
    check(
        gpu_state_header.find("bool allocate_demag_workspace") != std::string::npos,
        "gpu_state_initialize must accept an explicit demag-workspace allocation flag");
    check(
        runtime.find("ctx.demag.enabled") != std::string::npos,
        "GPU-state runtime bootstrap must pass ctx.demag.enabled into gpu_state_initialize");
    check(
        runtime.find("ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON") !=
            std::string::npos,
        "GPU-state runtime must explicitly guard strict GPU Poisson demag bootstrap");
    check(
        runtime.find("!ctx.gpu_state.device.lifecycle.allocated") != std::string::npos,
        "strict GPU Poisson demag bootstrap must fail before using missing FemGpuState buffers");
    check(
        runtime.find("strict FEM GPU demag requires an MFEM GPU device") != std::string::npos,
        "strict GPU Poisson demag bootstrap failure must identify the MFEM device mismatch");
    check(
        initialize_body.find("if (allocate_demag_workspace") != std::string::npos,
        "GPU-state initialization must conditionally allocate dead demag Poisson buffers");

    const std::string upload_m_body =
        extract_function_body(gpu_state, "bool gpu_state_upload_magnetization_aos(");
    const std::string download_m_body =
        extract_function_body(gpu_state, "bool gpu_state_download_magnetization_aos(");
    const std::string upload_m_transfer_body =
        extract_function_body(magnetization_transfer, "bool gpu_magnetization_upload_aos(");
    const std::string download_m_transfer_body =
        extract_function_body(magnetization_transfer, "bool gpu_magnetization_download_aos(");
    const std::string upload_component_body =
        extract_function_body(component_transfer, "bool gpu_component_upload_aos(");
    const std::string upload_optional_component_body =
        extract_function_body(component_transfer, "bool gpu_component_upload_optional_aos(");
    const std::string download_component_body =
        extract_function_body(component_transfer, "bool gpu_component_download_aos(");
    const std::string zero_component_body =
        extract_function_body(component_transfer, "bool gpu_component_zero_device(");
    check(
        upload_m_body.find("std::vector<double> mx") == std::string::npos &&
            upload_m_body.find("std::vector<double> my") == std::string::npos &&
            upload_m_body.find("std::vector<double> mz") == std::string::npos,
        "GPU magnetization upload must not allocate host AoS-to-SoA component vectors");
    check(
        download_m_body.find("std::vector<double> mx") == std::string::npos &&
            download_m_body.find("std::vector<double> my") == std::string::npos &&
            download_m_body.find("std::vector<double> mz") == std::string::npos,
        "GPU magnetization download must not allocate host SoA-to-AoS component vectors");
    check(
        upload_m_body.find("gpu_magnetization_upload_aos(") != std::string::npos &&
            upload_m_body.find("state.lifecycle") !=
                std::string::npos &&
            upload_m_body.find("state.magnetization") !=
                std::string::npos &&
            upload_m_transfer_body.find("gpu_component_upload_aos(") != std::string::npos &&
            upload_m_transfer_body.find("magnetization.m") !=
                std::string::npos &&
            upload_m_body.find("fullmag_cuda_upload_aos_to_soa") == std::string::npos,
        "GPU magnetization upload must delegate generic AoS/SoA transfer to component-transfer module");
    check(
        download_m_body.find("gpu_magnetization_download_aos(") != std::string::npos &&
            download_m_body.find("state.lifecycle") !=
                std::string::npos &&
            download_m_body.find("state.magnetization") !=
                std::string::npos &&
            download_m_transfer_body.find("gpu_component_download_aos(") != std::string::npos &&
            download_m_transfer_body.find("magnetization.m") !=
                std::string::npos &&
            download_m_body.find("fullmag_cuda_download_soa_to_aos") == std::string::npos,
        "GPU magnetization download must delegate generic AoS/SoA transfer to component-transfer module");
    check(
        upload_component_body.find("std::vector<double> x") == std::string::npos &&
            upload_component_body.find("std::vector<double> y") == std::string::npos &&
            upload_component_body.find("std::vector<double> z") == std::string::npos,
        "GPU component upload must not allocate host AoS-to-SoA component vectors");
    check(
        upload_optional_component_body.find("std::vector<double> zeros") == std::string::npos,
        "GPU optional component upload must not heap-allocate host zero vectors");
    check(
        component_transfer.find("gpu_component_zero_device(") != std::string::npos &&
            upload_optional_component_body.find("gpu_component_zero_device(") !=
                std::string::npos,
        "GPU optional component upload must zero device components directly when the host field is absent");
    check(
        (upload_component_body.find("cudaMemcpy2D") != std::string::npos ||
                upload_component_body.find("fullmag_cuda_upload_aos_to_soa") != std::string::npos) &&
            (download_component_body.find("cudaMemcpy2D") != std::string::npos ||
                download_component_body.find("fullmag_cuda_download_soa_to_aos") != std::string::npos),
        "GPU component transfers must use cudaMemcpy2D or device-side AoS/SoA transpose helpers");
    check(
        transfer_kernels.find("cudaError_t fullmag_cuda_upload_aos_to_soa(") != std::string::npos &&
            transfer_kernels.find("cudaError_t fullmag_cuda_download_soa_to_aos(") !=
                std::string::npos,
        "AoS/SoA CUDA transfer helpers must return cudaError_t to avoid hidden sync-as-error-checking");
    check(
        transfer_kernels.find("cudaMemcpy2DAsync(") == std::string::npos,
        "AoS/SoA CUDA transfer helpers must not enqueue async host transfers that callers immediately synchronize");
    for (const std::string *body : {
             &upload_m_body,
             &download_m_body,
             &upload_component_body,
             &download_component_body,
             &zero_component_body,
         }) {
        check(
            body->find("cudaStreamSynchronize(nullptr)") == std::string::npos,
            "GPU-state host I/O helpers must not force a default-stream synchronization");
    }
}

void no_cuda_bootstrap_initializes_host_resident_gpu_metadata() {
#if FULLMAG_HAS_MFEM_STACK
    /*
     * In MFEM-stack builds initialize_context_gpu_state runs after MFEM context
     * and exchange operator initialization. The bare scaffold case below is the
     * no-MFEM/no-CUDA contract.
     */
    return;
#else
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_RK45_DP54;
    ctx.state.m_xyz = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    ctx.exchange.h_xyz.assign(12, 0.0);
    ctx.demag.h_xyz.assign(12, 0.0);
    ctx.zeeman.h_ext_xyz.assign(12, 0.0);
    ctx.effective_field.h_xyz.assign(12, 0.0);
    ctx.anisotropy.h_uniaxial_xyz.assign(12, 0.0);
    ctx.anisotropy.h_cubic_xyz.assign(12, 0.0);
    ctx.dmi.h_interfacial_xyz.assign(12, 0.0);
    ctx.dmi.h_bulk_xyz.assign(12, 0.0);
    ctx.oersted.h_xyz.assign(12, 0.0);
    ctx.thermal_brown.h_xyz.assign(12, 0.0);
    ctx.magnetoelastic.h_xyz.assign(12, 0.0);
    ctx.mesh.node_volumes.assign(4, 0.25);
    ctx.material_fields.Ms_field.assign(4, 800e3);
    ctx.material_fields.A_field.assign(4, 13e-12);
    ctx.material_fields.alpha_field.assign(4, 0.1);
    ctx.mesh.magnetic_node_mask.assign(4, 1);
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.mesh.cell_nodes = {0, 1, 2, 3};
    ctx.mesh.magnetic_element_mask.assign(1, 1);
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.material.exchange_stiffness = 13e-12;
    ctx.material_fields.material.damping = 0.1;
    ctx.mfem_device.device_info_cache.is_gpu_enabled = 0;
    ctx.mfem_device.device_info_valid = true;

    std::string error;
    check(
        fullmag::fem::initialize_context_gpu_state(ctx, error),
        "host-resident GPU-state bootstrap should succeed without CUDA allocation");
    check(ctx.gpu_state.device.lifecycle.initialized, "GPU-state metadata must be initialized");
    check(!ctx.gpu_state.device.lifecycle.allocated, "no-CUDA host bootstrap must not allocate device state");
    check(ctx.gpu_state.device.lifecycle.node_count == 4, "GPU-state node count mismatch");
    check(ctx.gpu_state.device.lifecycle.dof_len == 12, "GPU-state DOF length mismatch");
    check(ctx.gpu_state.device.lifecycle.stage_count == 7, "GPU-state stage count mismatch");
#endif
}

} // namespace

int main() {
    tetrahedral_mesh_geometry_is_required_only_by_its_gpu_consumers();
    gpu_state_bootstrap_is_owned_by_runtime_module();
    gpu_state_audit04_memory_contracts_are_source_visible();
    no_cuda_bootstrap_initializes_host_resident_gpu_metadata();
    return 0;
}
