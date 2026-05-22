/*
 * multilayer_abi_v2_contract.cpp - native FDM multilayer ABI contract.
 *
 * Multilayer convolution cannot be smuggled through the legacy single-grid
 * plan.  The public C ABI and Rust FFI mirror must carry explicit layer,
 * convolution-grid, and precomputed tensor-kernel descriptors.
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

std::size_t count_occurrences(const std::string &haystack, const std::string &needle) {
    std::size_t count = 0;
    std::size_t pos = haystack.find(needle);
    while (pos != std::string::npos) {
        ++count;
        pos = haystack.find(needle, pos + needle.size());
    }
    return count;
}

std::filesystem::path native_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path().parent_path().parent_path();
    }
    return std::filesystem::current_path() /
        this_file.parent_path().parent_path().parent_path().parent_path();
}

std::filesystem::path repo_root() {
    return native_root().parent_path();
}

std::filesystem::path runner_native_fdm_source() {
    return repo_root() / "crates" / "fullmag-runner" / "src" / "fdm" /
        "native_cuda.rs";
}

void c_header_exposes_multilayer_plan_shape() {
    const std::string header = read_text_file(native_root() / "include" / "fullmag_fdm.h");

    check(
        header.find("typedef enum {\n    FULLMAG_FDM_PLAN_UNIFORM_GRID = 0") !=
            std::string::npos,
        "C ABI must expose fullmag_fdm_plan_kind with uniform-grid value 0");
    check(
        header.find("FULLMAG_FDM_PLAN_MULTILAYER_CONV = 1") != std::string::npos,
        "C ABI must expose multilayer convolution plan kind");
    check(
        header.find("typedef enum {\n    FULLMAG_FDM_TRANSFER_IDENTITY = 0") !=
                std::string::npos &&
            header.find("FULLMAG_FDM_TRANSFER_PUSH_PULL = 1") != std::string::npos,
        "C ABI must expose explicit multilayer transfer kinds");
    check(
        header.find("typedef struct {\n    double re;\n    double im;\n} fullmag_fdm_complex64;") !=
            std::string::npos,
        "C ABI must expose f64 complex values for precomputed tensor kernels");
    check(
        header.find("typedef struct {\n    float re;\n    float im;\n} fullmag_fdm_complex32;") !=
            std::string::npos,
        "C ABI must expose f32 complex values for precomputed tensor kernels");
    check(
        header.find("} fullmag_fdm_layer_desc_v2;") != std::string::npos,
        "C ABI must expose fullmag_fdm_layer_desc_v2");
    check(
            header.find("fullmag_fdm_grid_desc      native_grid") != std::string::npos &&
            header.find("fullmag_fdm_grid_desc      convolution_grid") != std::string::npos &&
            header.find("fullmag_fdm_transfer_kind  transfer_kind") != std::string::npos &&
            header.find("int32_t                    z_offset_cells") != std::string::npos,
        "layer descriptor must carry native grid, convolution grid, transfer kind, and z offset");
    check(
        header.find("const double              *initial_magnetization_xyz") !=
                std::string::npos &&
            header.find("uint64_t                   initial_magnetization_len") !=
                std::string::npos &&
            header.find("const uint8_t             *active_mask") != std::string::npos,
        "layer descriptor must carry initial magnetization and active mask payloads");
    check(
        header.find("} fullmag_fdm_tensor_kernel_desc_v2;") != std::string::npos,
        "C ABI must expose fullmag_fdm_tensor_kernel_desc_v2");
    check(
        header.find("uint32_t                   dst_layer") != std::string::npos &&
            header.find("uint32_t                   src_layer") != std::string::npos &&
            header.find("const fullmag_fdm_complex64 *kernel_xx") != std::string::npos &&
            header.find("const fullmag_fdm_complex64 *kernel_yy") != std::string::npos &&
            header.find("const fullmag_fdm_complex64 *kernel_zz") != std::string::npos &&
            header.find("const fullmag_fdm_complex64 *kernel_xy") != std::string::npos &&
            header.find("const fullmag_fdm_complex64 *kernel_xz") != std::string::npos &&
            header.find("const fullmag_fdm_complex64 *kernel_yz") != std::string::npos &&
            header.find("uint64_t                   kernel_len") != std::string::npos,
        "tensor-kernel descriptor must identify layer pair and six tensor spectra");
    check(
        header.find("} fullmag_fdm_multilayer_plan_desc_v2;") != std::string::npos,
        "C ABI must expose fullmag_fdm_multilayer_plan_desc_v2");
    check(
        header.find("fullmag_fdm_plan_kind      kind") != std::string::npos &&
            header.find("const fullmag_fdm_layer_desc_v2 *layers") != std::string::npos &&
            header.find("uint32_t                   layer_count") != std::string::npos &&
            header.find("const fullmag_fdm_tensor_kernel_desc_v2 *kernels") !=
                std::string::npos &&
            header.find("uint32_t                   kernel_count") != std::string::npos,
        "multilayer plan descriptor must carry explicit layers and kernel table");
}

void rust_ffi_mirrors_multilayer_plan_shape() {
    const std::string rust = read_text_file(
        repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");

    check(
        rust.find("pub enum fullmag_fdm_plan_kind") != std::string::npos &&
            rust.find("FULLMAG_FDM_PLAN_UNIFORM_GRID = 0") != std::string::npos &&
            rust.find("FULLMAG_FDM_PLAN_MULTILAYER_CONV = 1") != std::string::npos,
        "Rust FFI must mirror fullmag_fdm_plan_kind");
    check(
        rust.find("pub enum fullmag_fdm_transfer_kind") != std::string::npos &&
            rust.find("FULLMAG_FDM_TRANSFER_IDENTITY = 0") != std::string::npos &&
            rust.find("FULLMAG_FDM_TRANSFER_PUSH_PULL = 1") != std::string::npos,
        "Rust FFI must mirror fullmag_fdm_transfer_kind");
    check(
        rust.find("pub struct fullmag_fdm_complex64") != std::string::npos &&
            rust.find("pub re: f64") != std::string::npos &&
            rust.find("pub im: f64") != std::string::npos,
        "Rust FFI must mirror f64 complex values");
    check(
        rust.find("pub struct fullmag_fdm_complex32") != std::string::npos &&
            rust.find("pub re: f32") != std::string::npos &&
            rust.find("pub im: f32") != std::string::npos,
        "Rust FFI must mirror f32 complex values");
    check(
        rust.find("pub struct fullmag_fdm_layer_desc_v2") != std::string::npos &&
            rust.find("pub native_grid: fullmag_fdm_grid_desc") != std::string::npos &&
            rust.find("pub convolution_grid: fullmag_fdm_grid_desc") != std::string::npos &&
            rust.find("pub transfer_kind: fullmag_fdm_transfer_kind") != std::string::npos &&
            rust.find("pub z_offset_cells: i32") != std::string::npos &&
            rust.find("pub initial_magnetization_xyz: *const f64") != std::string::npos &&
            rust.find("pub active_mask: *const u8") != std::string::npos,
        "Rust FFI must mirror the layer descriptor payload");
    check(
        rust.find("pub struct fullmag_fdm_tensor_kernel_desc_v2") != std::string::npos &&
            rust.find("pub dst_layer: u32") != std::string::npos &&
            rust.find("pub src_layer: u32") != std::string::npos &&
            rust.find("pub kernel_xx: *const fullmag_fdm_complex64") != std::string::npos &&
            rust.find("pub kernel_yy: *const fullmag_fdm_complex64") != std::string::npos &&
            rust.find("pub kernel_zz: *const fullmag_fdm_complex64") != std::string::npos &&
            rust.find("pub kernel_xy: *const fullmag_fdm_complex64") != std::string::npos &&
            rust.find("pub kernel_xz: *const fullmag_fdm_complex64") != std::string::npos &&
            rust.find("pub kernel_yz: *const fullmag_fdm_complex64") != std::string::npos,
        "Rust FFI must mirror the tensor-kernel descriptor");
    check(
        rust.find("pub struct fullmag_fdm_multilayer_plan_desc_v2") != std::string::npos &&
            rust.find("pub kind: fullmag_fdm_plan_kind") != std::string::npos &&
            rust.find("pub layers: *const fullmag_fdm_layer_desc_v2") != std::string::npos &&
            rust.find("pub layer_count: u32") != std::string::npos &&
            rust.find("pub kernels: *const fullmag_fdm_tensor_kernel_desc_v2") !=
                std::string::npos &&
            rust.find("pub kernel_count: u32") != std::string::npos,
        "Rust FFI must mirror the multilayer plan descriptor");
}

void native_sources_stage_multilayer_upload_path() {
    const std::filesystem::path root = native_root();
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "core" / "context.cu");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");

    check(
        context_header.find("struct DeviceMultilayerLayer") != std::string::npos &&
            context_header.find("struct DeviceMultilayerTensorKernel") != std::string::npos,
        "Context must model uploaded multilayer layers and tensor kernels");
    check(
        context_header.find("std::vector<DeviceMultilayerLayer> multilayer_layers") !=
                std::string::npos &&
            context_header.find("std::vector<DeviceMultilayerTensorKernel> multilayer_kernels") !=
                std::string::npos,
        "Context must own staged multilayer layer and kernel device buffers");
    check(
        context_header.find("context_upload_multilayer_plan_v2") != std::string::npos,
        "Context must expose a native v2 multilayer upload function");
    check(
        context_source.find("bool context_upload_multilayer_plan_v2(") != std::string::npos,
        "context.cu must implement native v2 multilayer upload");
    check(
        context_source.find("alloc_vector_field_cells(ctx, dst.m") != std::string::npos &&
            context_source.find("upload_vector_field_aos_f64(") != std::string::npos,
        "native v2 upload must allocate and upload each layer magnetization");
    check(
        context_source.find("cudaMalloc(") != std::string::npos &&
            context_source.find("multilayer_active_mask") != std::string::npos,
        "native v2 upload must stage per-layer active masks on device");
    check(
        context_source.find("alloc_tensor_kernel_cells") != std::string::npos &&
            context_source.find("upload_tensor_kernel_component") != std::string::npos &&
            context_source.find("cudaMemcpy(multilayer_kernel_xx)") != std::string::npos &&
            context_source.find("cudaMemcpy(multilayer_kernel_yz)") != std::string::npos,
        "native v2 upload must allocate and upload six tensor-kernel spectra");
    check(
        context_source.find("free_multilayer_plan_v2(ctx)") != std::string::npos,
        "native v2 upload buffers must be freed by Context cleanup");
    check(
        c_api.find("context_upload_multilayer_plan_v2(*ctx, *plan)") != std::string::npos &&
            c_api.find("uploaded ") != std::string::npos &&
            c_api.find("native Heun/RK4 timestep with demag and layer-local exchange is available") !=
                std::string::npos,
        "create_v2 must upload validated multilayer payload before exposing native v2 timestep scope");
}

void native_sources_prepare_multilayer_fft_workspace() {
    const std::filesystem::path root = native_root();
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "core" / "context.cu");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");

    check(
        context_header.find("context_prepare_multilayer_fft_workspace_v2") !=
            std::string::npos,
        "Context must expose v2 multilayer FFT workspace preparation");
    check(
        context_source.find("bool context_prepare_multilayer_fft_workspace_v2(") !=
                std::string::npos &&
            context_source.find("kernel.fft_grid.nx") != std::string::npos &&
            context_source.find("multilayer FFT workspace requires a shared fft_grid") !=
                std::string::npos,
        "Context must validate one shared FFT grid before preparing v2 multilayer workspace");
    check(
        context_source.find("ctx.fft_nx = first.fft_grid.nx") != std::string::npos &&
            context_source.find("ctx.fft_ny = first.fft_grid.ny") != std::string::npos &&
            context_source.find("ctx.fft_nz = first.fft_grid.nz") != std::string::npos &&
            context_source.find("alloc_fft_workspace(ctx)") != std::string::npos,
        "Context must create the cuFFT workspace from the staged multilayer tensor grid");
    check(
        c_api.find("context_prepare_multilayer_fft_workspace_v2(*ctx)") !=
                std::string::npos &&
            c_api.find("prepared shared FFT workspace") != std::string::npos,
        "create_v2 must prepare the shared multilayer FFT workspace before reporting unsupported timestep execution");
}

void native_sources_expose_multilayer_cuda_demag_boundary() {
    const std::filesystem::path root = native_root();
    const std::string kernels_header =
        read_text_file(root / "backends" / "fdm" / "include" / "kernels.hpp");
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string cmake =
        read_text_file(root / "backends" / "fdm" / "CMakeLists.txt");
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "cuda" / "demag" /
                       "multilayer_convolution.cu");

    check(
        context_header.find("DeviceVectorField h_demag") != std::string::npos,
        "each staged multilayer layer must own a native-grid demag field buffer");
    check(
        kernels_header.find("launch_multilayer_demag_field_fp64") != std::string::npos &&
            kernels_header.find("launch_multilayer_demag_field_fp32") != std::string::npos,
        "kernel header must expose fp64/fp32 multilayer demag launch boundaries");
    check(
        cmake.find("cuda/demag/multilayer_convolution.cu") != std::string::npos,
        "CMake must compile the native multilayer convolution CUDA owner");
    check(
        multilayer_source.find("push_multilayer_m_identity_fp64_kernel") !=
                std::string::npos &&
            multilayer_source.find("push_multilayer_m_identity_fp32_kernel") !=
                std::string::npos,
        "multilayer CUDA owner must define fp64/fp32 push_m boundaries");
    check(
        multilayer_source.find("multiply_demag_tensor_kernel_fp64") != std::string::npos &&
            multilayer_source.find("multiply_demag_tensor_kernel_fp32") != std::string::npos,
        "multilayer CUDA owner must define fp64/fp32 tensor multiply boundaries");
    check(
        multilayer_source.find("pull_multilayer_h_identity_fp64_kernel") !=
                std::string::npos &&
            multilayer_source.find("pull_multilayer_h_identity_fp32_kernel") !=
                std::string::npos,
        "multilayer CUDA owner must define fp64/fp32 pull_h boundaries");
    check(
        multilayer_source.find("context_begin_compute_stream_work(ctx, \"launch_multilayer_demag_field_fp64\")") !=
                std::string::npos &&
            multilayer_source.find("context_begin_compute_stream_work(ctx, \"launch_multilayer_demag_field_fp32\")") !=
                std::string::npos,
        "multilayer demag launches must run on the Context compute stream boundary");
}

void native_multilayer_demag_transforms_all_vector_components() {
    const std::filesystem::path root = native_root();
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "cuda" / "demag" /
                       "multilayer_convolution.cu");

    for (const char *component : {"ctx.fft_x", "ctx.fft_y", "ctx.fft_z"}) {
        check(
            count_occurrences(
                multilayer_source,
                std::string("cufftExecZ2Z(\n            ctx.fft_plan,\n            static_cast<cufftDoubleComplex*>(") +
                component) >= 2,
            "fp64 multilayer demag must forward and inverse transform every vector component");
        check(
            count_occurrences(
                multilayer_source,
                std::string("cufftExecC2C(\n            ctx.fft_plan,\n            static_cast<cufftComplex*>(") +
                component) >= 2,
            "fp32 multilayer demag must forward and inverse transform every vector component");
    }
}

void native_multilayer_identity_transfer_accepts_padded_fft_grid() {
    const std::filesystem::path root = native_root();
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "cuda" / "demag" /
                       "multilayer_convolution.cu");

    check(
        multilayer_source.find("source native grid must match source convolution grid for identity transfer") !=
                std::string::npos &&
            multilayer_source.find("destination native grid must match destination convolution grid for identity transfer") !=
                std::string::npos,
        "identity transfer must validate native-grid/convolution-grid equality before using identity kernels");
    check(
        multilayer_source.find("identity transfer requires convolution grids to fit inside the FFT grid") !=
                std::string::npos,
        "identity transfer must allow padded FFT grids while rejecting undersized FFT grids");
    check(
        multilayer_source.find("source convolution grid must match tensor-kernel FFT grid") ==
            std::string::npos,
        "identity transfer must not require the convolution grid to equal the padded FFT grid");
}

void native_multilayer_push_pull_transfer_has_cuda_boundary() {
    const std::filesystem::path root = native_root();
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "core" / "context.cu");
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "cuda" / "demag" /
                       "multilayer_convolution.cu");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());

    check(
        context_header.find("fullmag_fdm_transfer_kind transfer_kind") !=
            std::string::npos,
        "Context layer staging must preserve the requested transfer kind");
    check(
        context_source.find("dst.transfer_kind = src.transfer_kind") !=
            std::string::npos,
        "native v2 upload must stage the layer transfer kind from the ABI descriptor");
    check(
        rust_runner.find("ffi_transfer_kind(&layer.transfer_kind)") !=
            std::string::npos,
        "Rust native runner wrapper must map ProblemIR transfer_kind into the C ABI");
    check(
        multilayer_source.find("push_multilayer_m_transfer_fp64_kernel") !=
                std::string::npos &&
            multilayer_source.find("push_multilayer_m_transfer_fp32_kernel") !=
                std::string::npos,
        "native demag refresh must define fp64/fp32 push_pull push_m kernels");
    check(
        multilayer_source.find("pull_multilayer_h_transfer_fp64_kernel") !=
                std::string::npos &&
            multilayer_source.find("pull_multilayer_h_transfer_fp32_kernel") !=
                std::string::npos,
        "native demag refresh must define fp64/fp32 push_pull pull_h kernels");
    check(
        multilayer_source.find("src.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL") !=
                std::string::npos &&
            multilayer_source.find("dst.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL") !=
                std::string::npos,
        "native demag refresh must route push_pull through explicit transfer kernels");
    check(
        multilayer_source.find("native multilayer transfer maps are not implemented") ==
            std::string::npos,
        "push_pull transfer must not remain a native unsupported placeholder");
}

void native_multilayer_push_pull_transfer_uses_staged_maps() {
    const std::filesystem::path root = native_root();
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "core" / "context.cu");
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "cuda" / "demag" /
                       "multilayer_convolution.cu");

    check(
        context_header.find("struct DeviceMultilayerPushMap") !=
                std::string::npos &&
            context_header.find("struct DeviceMultilayerPullMap") !=
                std::string::npos,
        "Context must model staged push/pull transfer maps");
    check(
        context_header.find("DeviceMultilayerPushMap push_map") !=
                std::string::npos &&
            context_header.find("DeviceMultilayerPullMap pull_map") !=
                std::string::npos,
        "each staged multilayer layer must own device transfer maps");
    check(
        context_source.find("build_and_upload_transfer_maps") !=
                std::string::npos &&
            context_source.find("cudaMemcpy(multilayer_push_map_offsets)") !=
                std::string::npos &&
            context_source.find("cudaMemcpy(multilayer_pull_map_weights)") !=
                std::string::npos,
        "native v2 upload must build and upload transfer maps for push_pull layers");
    check(
        context_source.find("free_device_transfer_maps") != std::string::npos,
        "Context cleanup must free staged transfer maps");
    check(
        multilayer_source.find("src.push_map.offsets") != std::string::npos &&
            multilayer_source.find("dst.pull_map.indices") != std::string::npos,
        "CUDA push_pull kernels must consume staged transfer maps");
    check(
        multilayer_source.find("floor(c_lo_x / ndx)") == std::string::npos,
        "CUDA push_pull kernels must not rebuild overlap maps inside the timestep launch");
}

void native_c_api_keeps_v2_handles_out_of_legacy_step_path() {
    const std::string c_api =
        read_text_file(native_root() / "backends" / "fdm" / "api" / "c_api.cpp");
    const std::string kernels_header =
        read_text_file(native_root() / "backends" / "fdm" / "include" / "kernels.hpp");
    const std::string cmake =
        read_text_file(native_root() / "backends" / "fdm" / "CMakeLists.txt");
    const std::string context_header =
        read_text_file(native_root() / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(native_root() / "backends" / "fdm" / "core" / "context.cu");
    const std::string heun_source =
        read_text_file(native_root() / "backends" / "fdm" / "cuda" / "integrators" /
                       "multilayer_heun.cu");
    const std::filesystem::path rk4_path =
        native_root() / "backends" / "fdm" / "cuda" / "integrators" /
        "multilayer_rk4.cu";
    const bool rk4_exists = std::filesystem::exists(rk4_path);
    const std::string rk4_source = rk4_exists ? read_text_file(rk4_path) : std::string();
    const std::size_t create_v2 = c_api.find("fullmag_fdm_backend_create_v2");
    const std::size_t select_in_v2 =
        c_api.find("select_cuda_device_if_requested(*ctx)", create_v2);
    const std::size_t upload_in_v2 =
        c_api.find("context_upload_multilayer_plan_v2(*ctx, *plan)", create_v2);

    check(
        create_v2 != std::string::npos &&
            select_in_v2 != std::string::npos &&
            upload_in_v2 != std::string::npos &&
            select_in_v2 < upload_in_v2,
        "create_v2 must honor the same explicit CUDA device selection as create");
    check(
        c_api.find("if (ctx->has_multilayer_plan_v2)") != std::string::npos &&
            c_api.find("launch_multilayer_heun_step_fp64(*ctx, dt_seconds, out_stats)") !=
                std::string::npos &&
            c_api.find("launch_multilayer_heun_step_fp32(*ctx, dt_seconds, out_stats)") !=
                std::string::npos &&
            c_api.find("launch_multilayer_rk4_step_fp64(*ctx, dt_seconds, out_stats)") !=
                std::string::npos &&
            c_api.find("launch_multilayer_rk4_step_fp32(*ctx, dt_seconds, out_stats)") !=
                std::string::npos,
        "step must route staged v2 multilayer handles through native timestep launchers");
    check(
        c_api.find("native multilayer timestep execution is not implemented for fullmag_fdm_backend_step") ==
            std::string::npos,
        "v2 multilayer step must not remain an unsupported timestep placeholder");
    check(
        c_api.find("native v2 multilayer Heun timestep currently requires enable_exchange = 0") ==
            std::string::npos,
        "v2 multilayer Heun step must not reject exchange-enabled staged plans");
    check(
        c_api.find("native v2 multilayer timestep currently supports only the Heun integrator") ==
            std::string::npos,
        "v2 multilayer step must not keep the Heun-only integrator gate");
    check(
        kernels_header.find("launch_multilayer_heun_step_fp64") != std::string::npos &&
            kernels_header.find("launch_multilayer_heun_step_fp32") != std::string::npos,
        "kernel header must expose native v2 multilayer Heun timestep launchers");
    check(
        kernels_header.find("launch_multilayer_rk4_step_fp64") != std::string::npos &&
            kernels_header.find("launch_multilayer_rk4_step_fp32") != std::string::npos,
        "kernel header must expose native v2 multilayer RK4 timestep launchers");
    check(
        kernels_header.find("launch_multilayer_exchange_field_fp64") != std::string::npos &&
            kernels_header.find("launch_multilayer_exchange_field_fp32") != std::string::npos,
        "kernel header must expose native v2 multilayer exchange field launchers");
    check(
        cmake.find("cuda/integrators/multilayer_heun.cu") != std::string::npos,
        "CMake must compile the native v2 multilayer Heun CUDA owner");
    check(
        cmake.find("cuda/integrators/multilayer_rk4.cu") != std::string::npos,
        "CMake must compile the native v2 multilayer RK4 CUDA owner");
    check(
        cmake.find("cuda/interactions/multilayer_exchange.cu") != std::string::npos,
        "CMake must compile the native v2 multilayer exchange CUDA owner");
    check(
        context_header.find("DeviceVectorField h_ex") != std::string::npos &&
            context_source.find("multilayer_h_ex") != std::string::npos &&
            context_source.find("multilayer_k3") != std::string::npos &&
            context_source.find("multilayer_k4") != std::string::npos,
        "each staged v2 multilayer layer must own allocated H_EX and RK stage storage");
    check(
        heun_source.find("launch_multilayer_exchange_field_fp64") !=
                std::string::npos &&
            heun_source.find("launch_multilayer_exchange_field_fp32") !=
                std::string::npos &&
            heun_source.find("layer.h_ex.x") != std::string::npos,
        "v2 multilayer Heun RHS must include per-layer exchange field when exchange is enabled");
    check(
        rk4_exists &&
            rk4_source.find("launch_multilayer_rk4_step_fp64") != std::string::npos &&
            rk4_source.find("launch_multilayer_exchange_field_fp64") !=
                std::string::npos &&
            rk4_source.find("layer.k4.x") != std::string::npos,
        "v2 multilayer RK4 must have a native owner with exchange-aware stage fields");
}

void native_sources_expose_multilayer_layer_field_copy() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "core" / "context.cu");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");

    check(
        c_header.find("fullmag_fdm_backend_copy_layer_field_f64") !=
                std::string::npos &&
            c_header.find("fullmag_fdm_backend_copy_layer_field_f32") !=
                std::string::npos,
        "C ABI must expose per-layer field copy entrypoints for v2 multilayer handles");
    check(
        rust.find("pub fn fullmag_fdm_backend_copy_layer_field_f64") !=
                std::string::npos &&
            rust.find("pub fn fullmag_fdm_backend_copy_layer_field_f32") !=
                std::string::npos,
        "Rust FFI must mirror per-layer field copy entrypoints");
    check(
        context_header.find("context_download_layer_field_f64") != std::string::npos &&
            context_header.find("context_download_layer_field_f32") != std::string::npos,
        "Context must expose per-layer field download helpers");
    check(
        context_source.find("context_download_layer_field_impl") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_DEMAG") != std::string::npos &&
            context_source.find("layer.h_demag") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_EX") != std::string::npos &&
            context_source.find("layer.h_ex") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_M") != std::string::npos &&
            context_source.find("layer.m") != std::string::npos &&
            context_source.find("unsupported multilayer layer observable") !=
                std::string::npos,
        "Context layer downloads must support M, H_EX, and H_DEMAG and reject unsupported observables");
    check(
        c_api.find("fullmag_fdm_backend_copy_layer_field_f64") != std::string::npos &&
            c_api.find("fullmag_fdm_backend_copy_layer_field_f32") != std::string::npos &&
            c_api.find("context_download_layer_field_f64(*ctx") != std::string::npos &&
            c_api.find("context_download_layer_field_f32(*ctx") != std::string::npos,
        "C API must route per-layer field copies through Context helpers");
}

void native_sources_expose_multilayer_layer_magnetization_upload() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "core" / "context.cu");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");

    check(
        c_header.find("fullmag_fdm_backend_upload_layer_magnetization_f64") !=
                std::string::npos &&
            c_header.find("fullmag_fdm_backend_upload_layer_magnetization_f32") !=
                std::string::npos,
        "C ABI must expose per-layer magnetization upload entrypoints for v2 multilayer handles");
    check(
        rust.find("pub fn fullmag_fdm_backend_upload_layer_magnetization_f64") !=
                std::string::npos &&
            rust.find("pub fn fullmag_fdm_backend_upload_layer_magnetization_f32") !=
                std::string::npos,
        "Rust FFI must mirror per-layer magnetization upload entrypoints");
    check(
        context_header.find("context_upload_layer_magnetization_f64") != std::string::npos &&
            context_header.find("context_upload_layer_magnetization_f32") != std::string::npos,
        "Context must expose per-layer magnetization upload helpers");
    check(
        context_source.find("context_upload_layer_magnetization_impl") !=
                std::string::npos &&
            context_source.find("layer.m") != std::string::npos &&
            context_source.find("per-layer magnetization upload requires a staged v2 multilayer plan") !=
                std::string::npos,
        "Context layer uploads must update staged layer.m and reject non-v2 handles");
    check(
        c_api.find("fullmag_fdm_backend_upload_layer_magnetization_f64") !=
                std::string::npos &&
            c_api.find("fullmag_fdm_backend_upload_layer_magnetization_f32") !=
                std::string::npos &&
            c_api.find("context_upload_layer_magnetization_f64(*ctx") !=
                std::string::npos &&
            c_api.find("context_upload_layer_magnetization_f32(*ctx") !=
                std::string::npos,
        "C API must route per-layer magnetization uploads through Context helpers");
    check(
        rust_runner.find("pub fn upload_layer_magnetization(") != std::string::npos &&
            rust_runner.find("pub fn upload_layer_magnetization_f32(") !=
                std::string::npos &&
            rust_runner.find("fullmag_fdm_backend_upload_layer_magnetization_f64") !=
                std::string::npos &&
            rust_runner.find("fullmag_fdm_backend_upload_layer_magnetization_f32") !=
                std::string::npos,
        "Rust native runner wrapper must expose safe per-layer magnetization upload methods");
}

void native_sources_expose_explicit_multilayer_demag_refresh() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());

    check(
        c_header.find("fullmag_fdm_backend_refresh_multilayer_demag") !=
            std::string::npos,
        "C ABI must expose an explicit v2 multilayer demag refresh entrypoint");
    check(
        rust.find("pub fn fullmag_fdm_backend_refresh_multilayer_demag") !=
            std::string::npos,
        "Rust FFI must mirror the explicit v2 multilayer demag refresh entrypoint");
    check(
        c_api.find("int fullmag_fdm_backend_refresh_multilayer_demag(") !=
                std::string::npos &&
            c_api.find("launch_multilayer_demag_field_fp64(ctx)") !=
                std::string::npos &&
            c_api.find("launch_multilayer_demag_field_fp32(ctx)") !=
                std::string::npos,
        "C API must refresh staged v2 multilayer demag without going through step()");
    check(
        rust_runner.find("fullmag_fdm_backend_refresh_multilayer_demag") !=
                std::string::npos &&
            rust_runner.find("fullmag_fdm_backend_step(self.handle, 0.0") ==
                std::string::npos,
        "Rust native runner wrapper must refresh multilayer demag through the explicit ABI, not step(0)");
}

void rust_runner_builds_multilayer_v2_plan_descriptor() {
    const std::string rust_runner = read_text_file(runner_native_fdm_source());

    check(
        rust_runner.find("pub fn create_multilayer_v2(") != std::string::npos &&
            rust_runner.find("fullmag_fdm_multilayer_plan_desc_v2") != std::string::npos &&
            rust_runner.find("fullmag_fdm_layer_desc_v2") != std::string::npos &&
            rust_runner.find("fullmag_fdm_tensor_kernel_desc_v2") != std::string::npos &&
            rust_runner.find("fullmag_fdm_backend_create_v2") != std::string::npos &&
            rust_runner.find("native Heun/RK4 timestep with demag and layer-local exchange is available") !=
                std::string::npos,
        "Rust native runner wrapper must build and submit v2 multilayer plan descriptors");
}

} // namespace

int main() {
    c_header_exposes_multilayer_plan_shape();
    rust_ffi_mirrors_multilayer_plan_shape();
    native_sources_stage_multilayer_upload_path();
    native_sources_prepare_multilayer_fft_workspace();
    native_sources_expose_multilayer_cuda_demag_boundary();
    native_multilayer_demag_transforms_all_vector_components();
    native_multilayer_identity_transfer_accepts_padded_fft_grid();
    native_multilayer_push_pull_transfer_has_cuda_boundary();
    native_multilayer_push_pull_transfer_uses_staged_maps();
    native_c_api_keeps_v2_handles_out_of_legacy_step_path();
    native_sources_expose_multilayer_layer_field_copy();
    native_sources_expose_multilayer_layer_magnetization_upload();
    native_sources_expose_explicit_multilayer_demag_refresh();
    rust_runner_builds_multilayer_v2_plan_descriptor();
    std::printf("multilayer ABI v2 contract: PASS\n");
    return 0;
}
