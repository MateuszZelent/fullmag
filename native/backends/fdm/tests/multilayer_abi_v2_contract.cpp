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

std::string slice_between(
    const std::string &haystack,
    const std::string &start,
    const std::string &end,
    const char *label)
{
    const std::size_t start_pos = haystack.find(start);
    if (start_pos == std::string::npos) {
        std::fprintf(stderr, "FAIL: unable to find %s start\n", label);
        std::exit(1);
    }
    const std::size_t end_pos = haystack.find(end, start_pos);
    if (end_pos == std::string::npos) {
        std::fprintf(stderr, "FAIL: unable to find %s end\n", label);
        std::exit(1);
    }
    return haystack.substr(start_pos, end_pos - start_pos + end.size());
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
        "gpu" / "cuda" / "native.rs";
}

std::filesystem::path runner_multilayer_cuda_source() {
    return repo_root() / "crates" / "fullmag-runner" / "src" / "fdm" /
        "gpu" / "cuda" / "multilayer.rs";
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
    check(
        header.find("Until native multilayer CUDA execution is\n"
                    " * implemented") == std::string::npos &&
            header.find("valid multilayer plan returns a handle carrying a clear\n"
                        " * last_error message") == std::string::npos,
        "C ABI create_v2 docs must not describe staged multilayer CUDA as an unimplemented placeholder");
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "demag" /
                       "multilayer_convolution.cu");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");

    check(
        context_header.find("context_prepare_multilayer_fft_workspace_v2") !=
                std::string::npos &&
            context_header.find("context_prepare_multilayer_fft_workspace_for_kernel") !=
                std::string::npos,
        "Context must expose initial and per-kernel v2 multilayer FFT workspace preparation");
    check(
        context_header.find("struct DeviceMultilayerFftWorkspace") !=
                std::string::npos &&
            context_header.find("std::vector<DeviceMultilayerFftWorkspace> multilayer_fft_workspaces") !=
                std::string::npos,
        "Context must own cached v2 multilayer FFT workspaces separately from the single-grid FFT workspace");
    check(
        context_source.find("ensure_multilayer_fft_workspace") !=
                std::string::npos &&
            context_source.find("bind_multilayer_fft_workspace(ctx") !=
                std::string::npos &&
            context_source.find("free_multilayer_fft_workspaces(ctx)") !=
                std::string::npos,
        "Context must cache and bind per-grid multilayer FFT workspaces instead of reallocating for every grid switch");
    check(
        context_source.find("bool context_prepare_multilayer_fft_workspace_for_kernel(") !=
                std::string::npos &&
            context_source.find("ensure_multilayer_fft_workspace(ctx, kernel.fft_grid") !=
                std::string::npos &&
            context_source.find("free_fft_workspace(ctx);\n    ctx.fft_nx = kernel.fft_grid.nx") ==
                std::string::npos &&
            context_source.find("cudaStreamSynchronize(multilayer_fft_replan)") ==
                std::string::npos,
        "Context must bind a cached cuFFT workspace for the active multilayer tensor-kernel grid");
    check(
        context_source.find("multilayer FFT workspace requires a shared fft_grid") ==
                std::string::npos &&
            context_source.find("push_pull transfer maps require a shared fft_grid") ==
                std::string::npos,
        "native v2 CUDA must allow heterogeneous FFT grids without a shared-grid upload gate");
    check(
        multilayer_source.find(
            "context_prepare_multilayer_fft_workspace_for_kernel(ctx, kernel") !=
                std::string::npos &&
            multilayer_source.find("workspace_matches_kernel") == std::string::npos &&
            multilayer_source.find("current FFT workspace does not match") ==
                std::string::npos,
        "multilayer demag launches must prepare per-kernel FFT workspace instead of rejecting grid changes");
    check(
        c_api.find("context_prepare_multilayer_fft_workspace_v2(*ctx)") !=
                std::string::npos &&
            c_api.find("prepared initial FFT workspace") != std::string::npos,
        "create_v2 must prepare the initial multilayer FFT workspace before reporting native timestep execution");
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "demag" /
                       "multilayer_convolution.cu");

    check(
        context_header.find("DeviceVectorField h_demag") != std::string::npos,
        "each staged multilayer layer must own a native-grid demag field buffer");
    check(
        kernels_header.find("launch_multilayer_demag_field_fp64") != std::string::npos &&
            kernels_header.find("launch_multilayer_demag_field_fp32") != std::string::npos,
        "kernel header must expose fp64/fp32 multilayer demag launch boundaries");
    check(
        cmake.find("gpu/cuda/demag/multilayer_convolution.cu") != std::string::npos,
        "CMake must compile the native multilayer convolution GPU/CUDA owner");
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "demag" /
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "demag" /
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "demag" /
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string multilayer_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "demag" /
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
            context_header.find("DeviceMultilayerPullMap dst_pull_map") !=
                std::string::npos,
        "staged multilayer layers must own grid-independent push maps and tensor kernels must own fft-grid-specific pull maps");
    check(
        context_source.find("build_and_upload_push_map") !=
                std::string::npos &&
            context_source.find("build_and_upload_kernel_pull_map") !=
                std::string::npos &&
            context_source.find("cudaMemcpy(multilayer_push_map_offsets)") !=
                std::string::npos &&
            context_source.find("cudaMemcpy(multilayer_pull_map_weights)") !=
                std::string::npos,
        "native v2 upload must build layer push maps and per-kernel pull maps for push_pull transfer");
    check(
        context_source.find("free_device_push_map") != std::string::npos &&
            context_source.find("free_device_pull_map(kernel.dst_pull_map)") !=
                std::string::npos,
        "Context cleanup must free staged layer push maps and per-kernel pull maps");
    check(
        multilayer_source.find("src.push_map.offsets") != std::string::npos &&
            multilayer_source.find("kernel.dst_pull_map.indices") != std::string::npos,
        "CUDA push_pull kernels must consume staged transfer maps");
    check(
        context_source.find("push_pull transfer maps require a shared fft_grid") ==
            std::string::npos,
        "push_pull transfer maps must not require one shared FFT grid after per-kernel pull-map staging");
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
        read_text_file(native_root() / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string multilayer_cuda_runner = read_text_file(runner_multilayer_cuda_source());
    const std::string heun_source =
        read_text_file(native_root() / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_heun.cu");
    const std::filesystem::path rk4_path =
        native_root() / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
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
        multilayer_cuda_runner.find("IntegratorChoice::Heun | IntegratorChoice::Rk4") !=
            std::string::npos,
        "public CUDA-assisted multilayer runner must not reject RK4 before native v2 dispatch");
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
        cmake.find("gpu/cuda/integrators/multilayer_heun.cu") != std::string::npos,
        "CMake must compile the native v2 multilayer Heun GPU/CUDA owner");
    check(
        cmake.find("gpu/cuda/integrators/multilayer_rk4.cu") != std::string::npos,
        "CMake must compile the native v2 multilayer RK4 GPU/CUDA owner");
    check(
        cmake.find("gpu/cuda/interactions/multilayer_exchange.cu") != std::string::npos,
        "CMake must compile the native v2 multilayer exchange GPU/CUDA owner");
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

void native_multilayer_v2_rhs_includes_uniform_external_field() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");
    const std::string heun_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_heun.cu");
    const std::string rk4_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_rk4.cu");
    const std::string c_v2_plan = slice_between(
        c_header,
        "typedef struct {\n    fullmag_fdm_plan_kind",
        "} fullmag_fdm_multilayer_plan_desc_v2;",
        "C ABI v2 multilayer plan descriptor");
    const std::string rust_v2_plan = slice_between(
        rust,
        "pub struct fullmag_fdm_multilayer_plan_desc_v2",
        "pub stats_stride: u32,\n}",
        "Rust FFI v2 multilayer plan descriptor");

    check(
        c_v2_plan.find("int                        enable_demag;\n"
                       "    int                        has_external_field") !=
                std::string::npos &&
            c_v2_plan.find("double                     external_field_am[3]") !=
                std::string::npos,
        "C ABI v2 multilayer plan must carry the requested uniform external field");
    check(
        rust_v2_plan.find("pub enable_demag: i32,\n"
                          "    pub has_external_field: i32") != std::string::npos &&
            rust_v2_plan.find("pub external_field_am: [f64; 3]") != std::string::npos,
        "Rust FFI v2 multilayer plan must mirror the uniform external field");
    check(
        rust_runner.find("has_external_field: if plan.external_field.is_some() { 1 } else { 0 }") !=
                std::string::npos &&
            rust_runner.find("external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0])") !=
                std::string::npos,
        "Rust native runner wrapper must pass FdmMultilayerPlanIR external_field into the v2 ABI");
    check(
        c_api.find("ctx->has_external_field = plan->has_external_field != 0") !=
                std::string::npos &&
            c_api.find("ctx->external_field[0] = plan->external_field_am[0]") !=
                std::string::npos,
        "create_v2 must stage the requested uniform external field on Context");
    check(
        heun_source.find("ctx.has_external_field ? 1 : 0") != std::string::npos &&
            heun_source.find("ctx.external_field[0]") != std::string::npos &&
            heun_source.find("h0 += has_external_field ? h_ext_x : 0.0") !=
                std::string::npos,
        "v2 multilayer Heun RHS must include the staged uniform external field");
    check(
        rk4_source.find("ctx.has_external_field ? 1 : 0") != std::string::npos &&
            rk4_source.find("ctx.external_field[0]") != std::string::npos &&
            rk4_source.find("h0 += has_external_field ? h_ext_x : 0.0") !=
                std::string::npos,
        "v2 multilayer RK4 RHS must include the staged uniform external field");
}

void native_multilayer_v2_rhs_includes_uniaxial_anisotropy() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string heun_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_heun.cu");
    const std::string rk4_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_rk4.cu");
    const std::string c_v2_layer = slice_between(
        c_header,
        "typedef struct {\n    fullmag_fdm_grid_desc      native_grid",
        "} fullmag_fdm_layer_desc_v2;",
        "C ABI v2 layer descriptor");
    const std::string rust_v2_layer = slice_between(
        rust,
        "pub struct fullmag_fdm_layer_desc_v2",
        "pub active_mask_len: u64,\n}",
        "Rust FFI v2 layer descriptor");

    check(
        c_v2_layer.find("int                        has_uniaxial_anisotropy") !=
                std::string::npos &&
            c_v2_layer.find("double                     uniaxial_anisotropy_constant") !=
                std::string::npos &&
            c_v2_layer.find("double                     uniaxial_anisotropy_k2") !=
                std::string::npos &&
            c_v2_layer.find("double                     anisotropy_axis[3]") !=
                std::string::npos,
        "C ABI v2 layer descriptor must carry per-layer uniaxial anisotropy");
    check(
        rust_v2_layer.find("pub has_uniaxial_anisotropy: i32") !=
                std::string::npos &&
            rust_v2_layer.find("pub uniaxial_anisotropy_constant: f64") !=
                std::string::npos &&
            rust_v2_layer.find("pub uniaxial_anisotropy_k2: f64") !=
                std::string::npos &&
            rust_v2_layer.find("pub anisotropy_axis: [f64; 3]") !=
                std::string::npos,
        "Rust FFI v2 layer descriptor must mirror per-layer uniaxial anisotropy");
    check(
        rust_runner.find("has_uniaxial_anisotropy: if layer.material.uniaxial_anisotropy_ku1.is_some()") !=
                std::string::npos &&
            rust_runner.find("uniaxial_anisotropy_constant: layer") !=
                std::string::npos &&
            rust_runner.find(".uniaxial_anisotropy_ku1") != std::string::npos &&
            rust_runner.find("uniaxial_anisotropy_k2: layer") !=
                std::string::npos &&
            rust_runner.find(".uniaxial_anisotropy_ku2") !=
                std::string::npos &&
            rust_runner.find("anisotropy_axis: layer.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0])") !=
                std::string::npos,
        "Rust native runner wrapper must pass per-layer uniaxial anisotropy into the v2 ABI");
    check(
        context_header.find("bool has_uniaxial_anisotropy") !=
                std::string::npos &&
            context_header.find("double Ku1") != std::string::npos &&
            context_header.find("double anisU[3]") != std::string::npos,
        "Context staged layer state must own per-layer uniaxial anisotropy parameters");
    check(
        context_source.find("dst.has_uniaxial_anisotropy = src.has_uniaxial_anisotropy != 0") !=
                std::string::npos &&
            context_source.find("dst.Ku1 = src.uniaxial_anisotropy_constant") !=
                std::string::npos &&
            context_source.find("dst.anisU[0] = src.anisotropy_axis[0]") !=
                std::string::npos,
        "native v2 upload must stage per-layer uniaxial anisotropy parameters");
    check(
        heun_source.find("has_uniaxial_anisotropy") != std::string::npos &&
            heun_source.find("ku1 * m_dot_u + 2.0 * ku2 * m_dot_u * m_dot_u * m_dot_u") !=
                std::string::npos &&
            heun_source.find("layer.has_uniaxial_anisotropy ? 1 : 0") !=
                std::string::npos,
        "v2 multilayer Heun RHS must include per-layer uniaxial anisotropy field");
    check(
        rk4_source.find("has_uniaxial_anisotropy") != std::string::npos &&
            rk4_source.find("ku1 * m_dot_u + 2.0 * ku2 * m_dot_u * m_dot_u * m_dot_u") !=
                std::string::npos &&
            rk4_source.find("layer.has_uniaxial_anisotropy ? 1 : 0") !=
                std::string::npos,
        "v2 multilayer RK4 RHS must include per-layer uniaxial anisotropy field");
}

void native_multilayer_v2_rhs_includes_cubic_anisotropy() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string heun_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_heun.cu");
    const std::string rk4_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_rk4.cu");
    const std::string c_v2_layer = slice_between(
        c_header,
        "typedef struct {\n    fullmag_fdm_grid_desc      native_grid",
        "} fullmag_fdm_layer_desc_v2;",
        "C ABI v2 layer descriptor");
    const std::string rust_v2_layer = slice_between(
        rust,
        "pub struct fullmag_fdm_layer_desc_v2",
        "pub active_mask_len: u64,\n}",
        "Rust FFI v2 layer descriptor");
    const std::string device_layer = slice_between(
        context_header,
        "struct DeviceMultilayerLayer {",
        "struct DeviceMultilayerTensorKernel",
        "DeviceMultilayerLayer");

    check(
        c_v2_layer.find("int                        has_cubic_anisotropy") !=
                std::string::npos &&
            c_v2_layer.find("double                     cubic_Kc1") !=
                std::string::npos &&
            c_v2_layer.find("double                     cubic_Kc2") !=
                std::string::npos &&
            c_v2_layer.find("double                     cubic_Kc3") !=
                std::string::npos &&
            c_v2_layer.find("double                     cubic_axis1[3]") !=
                std::string::npos &&
            c_v2_layer.find("double                     cubic_axis2[3]") !=
                std::string::npos,
        "C ABI v2 layer descriptor must carry per-layer cubic anisotropy");
    check(
        rust_v2_layer.find("pub has_cubic_anisotropy: i32") !=
                std::string::npos &&
            rust_v2_layer.find("pub cubic_kc1: f64") != std::string::npos &&
            rust_v2_layer.find("pub cubic_kc2: f64") != std::string::npos &&
            rust_v2_layer.find("pub cubic_kc3: f64") != std::string::npos &&
            rust_v2_layer.find("pub cubic_axis1: [f64; 3]") !=
                std::string::npos &&
            rust_v2_layer.find("pub cubic_axis2: [f64; 3]") !=
                std::string::npos,
        "Rust FFI v2 layer descriptor must mirror per-layer cubic anisotropy");
    check(
        rust_runner.find("has_cubic_anisotropy: if layer.material.cubic_anisotropy_kc1.is_some()") !=
                std::string::npos &&
            rust_runner.find(".cubic_anisotropy_kc2") != std::string::npos &&
            rust_runner.find(".cubic_anisotropy_kc3") != std::string::npos &&
            rust_runner.find("cubic_axis1: layer") != std::string::npos &&
            rust_runner.find(".cubic_anisotropy_axis1") != std::string::npos &&
            rust_runner.find("cubic_axis2: layer") != std::string::npos &&
            rust_runner.find(".cubic_anisotropy_axis2") != std::string::npos,
        "Rust native runner wrapper must pass per-layer cubic anisotropy into the v2 ABI");
    check(
        device_layer.find("bool has_cubic_anisotropy") != std::string::npos &&
            device_layer.find("double Kc1") != std::string::npos &&
            device_layer.find("double Kc2") != std::string::npos &&
            device_layer.find("double Kc3") != std::string::npos &&
            device_layer.find("double cubic_axis1[3]") != std::string::npos &&
            device_layer.find("double cubic_axis2[3]") != std::string::npos,
        "Context staged layer state must own per-layer cubic anisotropy parameters");
    check(
        context_source.find("dst.has_cubic_anisotropy = src.has_cubic_anisotropy != 0") !=
                std::string::npos &&
            context_source.find("dst.Kc1 = src.cubic_Kc1") != std::string::npos &&
            context_source.find("dst.Kc2 = src.cubic_Kc2") != std::string::npos &&
            context_source.find("dst.Kc3 = src.cubic_Kc3") != std::string::npos &&
            context_source.find("dst.cubic_axis1[0] = src.cubic_axis1[0]") !=
                std::string::npos &&
            context_source.find("dst.cubic_axis2[0] = src.cubic_axis2[0]") !=
                std::string::npos,
        "native v2 upload must stage per-layer cubic anisotropy parameters");
    check(
        heun_source.find("has_cubic_anisotropy") != std::string::npos &&
            heun_source.find("kc1 * mc1 * (m2sq + m3sq)") !=
                std::string::npos &&
            heun_source.find("kc3 * sigma * mc1 * (m2sq + m3sq)") !=
                std::string::npos &&
            heun_source.find("layer.has_cubic_anisotropy ? 1 : 0") !=
                std::string::npos,
        "v2 multilayer Heun RHS must include per-layer cubic anisotropy field");
    check(
        rk4_source.find("has_cubic_anisotropy") != std::string::npos &&
            rk4_source.find("kc1 * mc1 * (m2sq + m3sq)") !=
                std::string::npos &&
            rk4_source.find("kc3 * sigma * mc1 * (m2sq + m3sq)") !=
                std::string::npos &&
            rk4_source.find("layer.has_cubic_anisotropy ? 1 : 0") !=
                std::string::npos,
        "v2 multilayer RK4 RHS must include per-layer cubic anisotropy field");
}

void native_multilayer_v2_rhs_includes_dmi() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string heun_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_heun.cu");
    const std::string rk4_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "integrators" /
                       "multilayer_rk4.cu");
    const std::string c_v2_plan = slice_between(
        c_header,
        "typedef struct {\n    fullmag_fdm_plan_kind      kind",
        "} fullmag_fdm_multilayer_plan_desc_v2;",
        "C ABI v2 multilayer plan descriptor");
    const std::string rust_v2_plan = slice_between(
        rust,
        "pub struct fullmag_fdm_multilayer_plan_desc_v2",
        "pub stats_stride: u32,\n}",
        "Rust FFI v2 multilayer plan descriptor");

    check(
        c_v2_plan.find("int                        has_interfacial_dmi") !=
                std::string::npos &&
            c_v2_plan.find("double                     dmi_D_interfacial") !=
                std::string::npos &&
            c_v2_plan.find("int                        has_bulk_dmi") !=
                std::string::npos &&
            c_v2_plan.find("double                     dmi_D_bulk") !=
                std::string::npos,
        "C ABI v2 multilayer plan descriptor must carry DMI constants");
    check(
        rust_v2_plan.find("pub has_interfacial_dmi: i32") !=
                std::string::npos &&
            rust_v2_plan.find("pub dmi_d_interfacial: f64") !=
                std::string::npos &&
            rust_v2_plan.find("pub has_bulk_dmi: i32") !=
                std::string::npos &&
            rust_v2_plan.find("pub dmi_d_bulk: f64") != std::string::npos,
        "Rust FFI v2 multilayer plan descriptor must mirror DMI constants");
    check(
        rust_runner.find("has_interfacial_dmi: if plan.interfacial_dmi.is_some()") !=
                std::string::npos &&
            rust_runner.find("dmi_d_interfacial: plan.interfacial_dmi.unwrap_or(0.0)") !=
                std::string::npos &&
            rust_runner.find("has_bulk_dmi: if plan.bulk_dmi.is_some()") !=
                std::string::npos &&
            rust_runner.find("dmi_d_bulk: plan.bulk_dmi.unwrap_or(0.0)") !=
                std::string::npos,
        "Rust native runner wrapper must pass multilayer DMI constants into the v2 ABI");
    check(
        c_api.find("ctx->has_interfacial_dmi = plan->has_interfacial_dmi != 0") !=
                std::string::npos &&
            c_api.find("ctx->D_interfacial = plan->dmi_D_interfacial") !=
                std::string::npos &&
            c_api.find("ctx->has_bulk_dmi = plan->has_bulk_dmi != 0") !=
                std::string::npos &&
            c_api.find("ctx->D_bulk = plan->dmi_D_bulk") != std::string::npos,
        "create_v2 must stage DMI constants on Context");
    check(
        context_header.find("bool has_interfacial_dmi") != std::string::npos &&
            context_header.find("double D_interfacial") != std::string::npos &&
            context_header.find("bool has_bulk_dmi") != std::string::npos &&
            context_header.find("double D_bulk") != std::string::npos,
        "Context must own staged DMI constants for v2 multilayer RHS");
    check(
        heun_source.find("has_interfacial_dmi") != std::string::npos &&
            heun_source.find("dmz_dx") != std::string::npos &&
            heun_source.find("has_bulk_dmi") != std::string::npos &&
            heun_source.find("dmz_dy - dmy_dz") != std::string::npos &&
            heun_source.find("ctx.has_interfacial_dmi ? 1 : 0") !=
                std::string::npos,
        "v2 multilayer Heun RHS must include staged DMI field");
    check(
        rk4_source.find("has_interfacial_dmi") != std::string::npos &&
            rk4_source.find("dmz_dx") != std::string::npos &&
            rk4_source.find("has_bulk_dmi") != std::string::npos &&
            rk4_source.find("dmz_dy - dmy_dz") != std::string::npos &&
            rk4_source.find("ctx.has_interfacial_dmi ? 1 : 0") !=
                std::string::npos,
        "v2 multilayer RK4 RHS must include staged DMI field");
}

void native_sources_expose_multilayer_layer_field_copy() {
    const std::filesystem::path root = native_root();
    const std::string c_header = read_text_file(root / "include" / "fullmag_fdm.h");
    const std::string rust =
        read_text_file(repo_root() / "crates" / "fullmag-fdm-sys" / "src" / "lib.rs");
    const std::string rust_runner = read_text_file(runner_native_fdm_source());
    const std::string context_header =
        read_text_file(root / "backends" / "fdm" / "include" / "context.hpp");
    const std::string context_source =
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
    const std::string c_api =
        read_text_file(root / "backends" / "fdm" / "api" / "c_api.cpp");
    const std::string layer_download = slice_between(
        context_source,
        "static bool context_download_layer_field_impl",
        "bool context_download_layer_field_f64",
        "multilayer layer field download helper");

    check(
        c_header.find("fullmag_fdm_backend_copy_layer_field_f64") !=
                std::string::npos &&
            c_header.find("fullmag_fdm_backend_copy_layer_field_f32") !=
                std::string::npos &&
            c_header.find("FULLMAG_FDM_OBSERVABLE_H_DMI") != std::string::npos,
        "C ABI must expose per-layer H_DMI field copy entrypoints for v2 multilayer handles");
    check(
        rust.find("pub fn fullmag_fdm_backend_copy_layer_field_f64") !=
                std::string::npos &&
            rust.find("pub fn fullmag_fdm_backend_copy_layer_field_f32") !=
                std::string::npos &&
            rust.find("FULLMAG_FDM_OBSERVABLE_H_DMI") != std::string::npos,
        "Rust FFI must mirror per-layer H_DMI field copy entrypoints");
    check(
        rust_runner.find("pub fn copy_layer_h_ext(") != std::string::npos &&
            rust_runner.find("pub fn copy_layer_h_ext_f32(") != std::string::npos &&
            rust_runner.find("FULLMAG_FDM_OBSERVABLE_H_EXT") != std::string::npos,
        "Rust native wrapper must expose per-layer H_EXT field copies for staged v2 handles");
    check(
        rust_runner.find("pub fn copy_layer_h_ani(") != std::string::npos &&
            rust_runner.find("pub fn copy_layer_h_ani_f32(") != std::string::npos &&
            rust_runner.find("FULLMAG_FDM_OBSERVABLE_H_ANI") != std::string::npos,
        "Rust native wrapper must expose per-layer H_ANI field copies for staged v2 handles");
    check(
        rust_runner.find("pub fn copy_layer_h_eff(") != std::string::npos &&
            rust_runner.find("pub fn copy_layer_h_eff_f32(") != std::string::npos &&
            rust_runner.find("FULLMAG_FDM_OBSERVABLE_H_EFF") != std::string::npos,
        "Rust native wrapper must expose per-layer H_EFF field copies for staged v2 handles");
    check(
        rust_runner.find("native multilayer CUDA execution is not implemented") ==
            std::string::npos,
        "Rust native wrapper must not treat the old create_v2 unsupported placeholder as an accepted staged status");
    const std::string c_header_copy_f64 = slice_between(
        c_header,
        "Copy a v2 multilayer layer field observable from device to host as f64.",
        "int fullmag_fdm_backend_copy_layer_field_f64",
        "C ABI f64 layer-copy documentation");
    const std::string c_header_copy_f32 = slice_between(
        c_header,
        "Copy a v2 multilayer layer field observable from device to host as f32.",
        "int fullmag_fdm_backend_copy_layer_field_f32",
        "C ABI f32 layer-copy documentation");
    check(
        c_header_copy_f64.find("FULLMAG_FDM_OBSERVABLE_H_ANI") !=
                std::string::npos &&
            c_header_copy_f64.find("FULLMAG_FDM_OBSERVABLE_H_EFF") !=
                std::string::npos &&
            c_header_copy_f32.find("FULLMAG_FDM_OBSERVABLE_H_ANI") !=
                std::string::npos &&
            c_header_copy_f32.find("FULLMAG_FDM_OBSERVABLE_H_EFF") !=
                std::string::npos,
        "C ABI layer-copy docs must list H_ANI and H_EFF alongside the supported staged v2 observables");
    check(
        context_header.find("context_download_layer_field_f64") != std::string::npos &&
            context_header.find("context_download_layer_field_f32") != std::string::npos &&
            context_header.find("DeviceVectorField h_dmi;\n    DeviceVectorField h_ani;") !=
                std::string::npos &&
            context_header.find("DeviceVectorField tmp;") !=
                std::string::npos,
        "Context must expose per-layer H_DMI/H_ANI helpers and a scratch field for H_EFF downloads");
    check(
        context_source.find("context_download_layer_field_impl") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_DEMAG") != std::string::npos &&
            context_source.find("layer.h_demag") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_EX") != std::string::npos &&
            context_source.find("layer.h_ex") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_DMI") != std::string::npos &&
            context_source.find("layer.h_dmi") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_ANI") != std::string::npos &&
            context_source.find("layer.h_ani") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_EFF") != std::string::npos &&
            context_source.find("launch_multilayer_effective_field") != std::string::npos &&
            context_source.find("layer.tmp") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_H_EXT") != std::string::npos &&
            context_source.find("ctx.external_field[0]") != std::string::npos &&
            context_source.find("multilayer_layer_h_ext_active_mask") != std::string::npos &&
            context_source.find("FULLMAG_FDM_OBSERVABLE_M") != std::string::npos &&
            context_source.find("layer.m") != std::string::npos &&
            context_source.find("unsupported multilayer layer observable") !=
                std::string::npos,
        "Context layer downloads must support M, H_EX, H_DEMAG, H_DMI, H_ANI, H_EFF, and H_EXT and reject unsupported observables");
    check(
        context_source.find("static bool context_refresh_multilayer_exchange_observable") !=
                std::string::npos &&
            context_source.find("launch_multilayer_exchange_field_fp64") !=
                std::string::npos &&
            context_source.find("launch_multilayer_exchange_field_fp32") !=
                std::string::npos,
        "Context must provide a staged exchange refresh helper for layer observables");
    check(
        layer_download.find("observable == FULLMAG_FDM_OBSERVABLE_H_EX") !=
                std::string::npos &&
            layer_download.find("context_refresh_multilayer_exchange_observable(ctx)") !=
                std::string::npos,
        "Context layer H_EX downloads must refresh staged layer-local exchange before copying");
    const std::size_t h_eff_pos = layer_download.find("observable == FULLMAG_FDM_OBSERVABLE_H_EFF");
    const std::size_t h_eff_exchange_pos =
        layer_download.find("context_refresh_multilayer_exchange_observable(ctx)", h_eff_pos);
    const std::size_t h_eff_assembly_pos =
        layer_download.find("launch_multilayer_effective_field", h_eff_pos);
    check(
        h_eff_pos != std::string::npos &&
            h_eff_exchange_pos != std::string::npos &&
            h_eff_assembly_pos != std::string::npos &&
            h_eff_exchange_pos < h_eff_assembly_pos,
        "Context layer H_EFF downloads must refresh H_EX before scratch effective-field assembly");
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
        read_text_file(root / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu");
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
    native_multilayer_v2_rhs_includes_uniform_external_field();
    native_multilayer_v2_rhs_includes_uniaxial_anisotropy();
    native_multilayer_v2_rhs_includes_cubic_anisotropy();
    native_multilayer_v2_rhs_includes_dmi();
    native_sources_expose_multilayer_layer_field_copy();
    native_sources_expose_multilayer_layer_magnetization_upload();
    native_sources_expose_explicit_multilayer_demag_refresh();
    rust_runner_builds_multilayer_v2_plan_descriptor();
    std::printf("multilayer ABI v2 contract: PASS\n");
    return 0;
}
