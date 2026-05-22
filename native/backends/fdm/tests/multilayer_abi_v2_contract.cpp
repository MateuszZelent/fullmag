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
            header.find("int32_t                    z_offset_cells") != std::string::npos,
        "layer descriptor must carry native grid, convolution grid, and z offset");
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
            c_api.find("native multilayer CUDA execution is not implemented") !=
                std::string::npos,
        "create_v2 must upload validated multilayer payload before reporting unsupported execution");
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

void native_c_api_keeps_v2_handles_out_of_legacy_step_path() {
    const std::string c_api =
        read_text_file(native_root() / "backends" / "fdm" / "api" / "c_api.cpp");
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
            c_api.find("launch_multilayer_demag_field_fp64(*ctx)") !=
                std::string::npos &&
            c_api.find("launch_multilayer_demag_field_fp32(*ctx)") !=
                std::string::npos &&
            c_api.find("native multilayer demag refreshed; native multilayer timestep execution is not implemented for fullmag_fdm_backend_step") !=
                std::string::npos,
        "step must refresh staged v2 multilayer demag before rejecting incomplete timestep execution");
}

} // namespace

int main() {
    c_header_exposes_multilayer_plan_shape();
    rust_ffi_mirrors_multilayer_plan_shape();
    native_sources_stage_multilayer_upload_path();
    native_sources_prepare_multilayer_fft_workspace();
    native_sources_expose_multilayer_cuda_demag_boundary();
    native_c_api_keeps_v2_handles_out_of_legacy_step_path();
    std::printf("multilayer ABI v2 contract: PASS\n");
    return 0;
}
