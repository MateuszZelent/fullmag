 /*
 * source_facade_cuda_kernels_contract.cpp - native FEM source-facade ownership docs.
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

void cuda_kernels_are_owned_by_cuda_kernels_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");

    check(
        cmake.find("src/kernels.cu") == std::string::npos,
        "FEM CMake source list must not build CUDA kernels from legacy src path");
    check(
        !std::filesystem::exists(root / "include" / "kernels.h"),
        "GPU CUDA kernels header must not remain in root include");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "kernels" / "kernels.hpp"),
        "GPU CUDA kernels compatibility umbrella header must be removed after owner-module extraction");
    check(
        cmake.find("gpu/cuda/kernels/kernels.cu") == std::string::npos,
        "FEM CMake source list must not build an owning CUDA kernels umbrella source");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "kernels" / "kernels.cu"),
        "GPU CUDA kernels umbrella source must be removed after owner-module extraction");
}


void gpu_cuda_vector_field_kernels_are_owned_by_cuda_fields_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string fields_header =
        read_text_file(root / "gpu" / "cuda" / "fields" / "vector_field_kernels.hpp");
    const std::string fields_source =
        read_text_file(root / "gpu" / "cuda" / "fields" / "vector_field_kernels.cu");

    check(
        cmake.find("gpu/cuda/fields/vector_field_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA vector field kernels from gpu/cuda/fields");
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
    const std::string transfer_header =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_kernels.hpp");
    const std::string transfer_source =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_kernels.cu");

    check(
        cmake.find("gpu/cuda/transfer/transfer_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA transfer kernels from gpu/cuda/transfer");
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
}


void gpu_component_transfers_are_owned_by_cuda_transfer_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string field_buffer_upload_source =
        read_text_file(root / "gpu" / "cuda" / "fields" / "field_buffer_upload.cpp");
    const std::string component_header =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "component_transfer.hpp");
    const std::string component_source =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "component_transfer.cpp");

    check(
        cmake.find("gpu/cuda/transfer/component_transfer.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA component transfer helpers");
    check(
        component_header.find("GPU CUDA component-transfer module header") !=
                std::string::npos &&
            component_source.find("GPU CUDA component-transfer source contract") !=
                std::string::npos &&
            component_source.find("#include \"gpu/cuda/transfer/component_transfer.hpp\"") !=
                std::string::npos,
        "GPU CUDA component-transfer module must document and include its boundary");
    check(
        component_header.find("gpu_component_download_aos(") !=
                std::string::npos &&
            component_header.find("gpu_component_upload_aos(") !=
                std::string::npos &&
            component_header.find("gpu_component_zero_device(") !=
                std::string::npos &&
            component_header.find("gpu_component_upload_optional_aos(") !=
                std::string::npos,
        "GPU CUDA component-transfer header must own component transfer declarations");
    check(
        component_source.find("fullmag_cuda_upload_aos_to_soa(") !=
                std::string::npos &&
            component_source.find("fullmag_cuda_download_soa_to_aos(") !=
                std::string::npos &&
            component_source.find("cudaMemset") != std::string::npos &&
            component_source.find("record_host_to_device") !=
                std::string::npos &&
            component_source.find("record_device_to_host") != std::string::npos,
        "GPU CUDA component-transfer source must own component upload/download/zero helpers");
    check(
        gpu_state_source.find("gpu_component_download_aos(") !=
                std::string::npos &&
            (gpu_state_source.find("gpu_component_upload_aos(") !=
                 std::string::npos ||
             field_buffer_upload_source.find("gpu_component_upload_aos(") !=
                 std::string::npos) &&
            field_buffer_upload_source.find("gpu_component_upload_optional_aos(") !=
                std::string::npos,
        "GPU state implementation must delegate generic component transfers");
    check(
        gpu_state_source.find("bool gpu_state_upload_component_aos(") ==
                std::string::npos &&
            gpu_state_source.find("bool gpu_state_upload_optional_component_aos(") ==
                std::string::npos &&
            gpu_state_source.find("bool gpu_state_zero_component_device(") ==
                std::string::npos &&
            gpu_state_source.find("fullmag_cuda_upload_aos_to_soa(\n            xyz") ==
                std::string::npos &&
            gpu_state_source.find("fullmag_cuda_download_soa_to_aos(\n            field.x") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemset(field.x") == std::string::npos,
        "GPU state implementation must not own generic component transfer internals");
}


void gpu_cuda_llg_rhs_kernels_are_owned_by_cuda_llg_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string llg_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "llg" / "llg_rhs_kernels.hpp");
    const std::string llg_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "llg" / "llg_rhs_kernels.cu");

    check(
        cmake.find("gpu/cuda/integrators/llg/llg_rhs_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA LLG RHS kernels from gpu/cuda/integrators/llg");
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
}


void gpu_cuda_reduction_kernels_are_owned_by_cuda_reductions_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string reductions_header =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_kernels.hpp");
    const std::string reductions_source =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_kernels.cu");

    check(
        cmake.find("gpu/cuda/reductions/reduction_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU CUDA reductions from gpu/cuda/reductions");
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
}


void gpu_rk_adaptive_error_kernels_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "adaptive_error_kernels.hpp");
    const std::string rk_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "adaptive_error_kernels.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/adaptive_error_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive-error CUDA kernels from gpu/cuda/integrators/rk");
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
}


void gpu_rk_stage_kernels_are_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_step =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string predictor_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_predictor_kernels.hpp");
    const std::string predictor_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_predictor_kernels.cu");
    const std::string heun_accept_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_heun_accept_kernel.hpp");
    const std::string heun_accept_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_heun_accept_kernel.cu");
    const std::string rk4_accept_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rk4_accept_kernel.hpp");
    const std::string rk4_accept_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rk4_accept_kernel.cu");
    const std::string bs23_accept_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_bs23_accept_kernel.hpp");
    const std::string bs23_accept_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_bs23_accept_kernel.cu");
    const std::string dp54_accept_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dp54_accept_kernel.hpp");
    const std::string dp54_accept_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dp54_accept_kernel.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_stage_kernels.cu") ==
            std::string::npos,
        "FEM CMake source list must not build removed GPU RK stage compatibility kernels");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_stage_predictor_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK stage predictor CUDA kernels from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_stage_accept_kernels.cu") ==
            std::string::npos,
        "FEM CMake source list must not build removed GPU RK stage accept compatibility kernels");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_kernels.hpp") &&
            !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_kernels.cu") &&
            !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_accept_kernels.hpp") &&
            !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_stage_accept_kernels.cu"),
        "GPU CUDA RK stage compatibility kernel files must be removed after concrete owner modules exist");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_heun_accept_kernel.cu") !=
                std::string::npos &&
            cmake.find("gpu/cuda/integrators/rk/rk_rk4_accept_kernel.cu") !=
                std::string::npos &&
            cmake.find("gpu/cuda/integrators/rk/rk_bs23_accept_kernel.cu") !=
                std::string::npos &&
            cmake.find("gpu/cuda/integrators/rk/rk_dp54_accept_kernel.cu") !=
                std::string::npos,
        "FEM CMake source list must build per-integrator GPU RK accept kernels from gpu/cuda/integrators/rk");
    check(
        predictor_header.find("GPU CUDA RK stage predictor kernels module header") !=
                std::string::npos &&
            predictor_header.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            predictor_header.find("fullmag_cuda_rk45_stage(") !=
                std::string::npos,
        "GPU CUDA RK stage predictor kernels header must own predictor wrapper declarations");
    check(
        predictor_source.find("#include \"gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp\"") !=
                std::string::npos &&
            predictor_source.find("GPU CUDA RK stage predictor kernels source contract") !=
                std::string::npos &&
            predictor_source.find("euler_stage_kernel") !=
                std::string::npos &&
            predictor_source.find("rk45_stage_kernel") !=
                std::string::npos &&
            predictor_source.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            predictor_source.find("fullmag_cuda_rk45_stage(") !=
                std::string::npos,
        "GPU CUDA RK stage predictor kernels source must own predictor kernels");
    check(
        heun_accept_header.find("GPU CUDA RK Heun accept kernel module header") !=
                std::string::npos &&
            heun_accept_header.find("fullmag_cuda_heun_accept(") !=
                std::string::npos &&
            heun_accept_source.find("#include \"gpu/cuda/integrators/rk/rk_heun_accept_kernel.hpp\"") !=
                std::string::npos &&
            heun_accept_source.find("GPU CUDA RK Heun accept kernel source contract") !=
                std::string::npos &&
            heun_accept_source.find("heun_accept_kernel") !=
                std::string::npos &&
            heun_accept_source.find("fullmag_cuda_heun_accept(") !=
                std::string::npos,
        "GPU CUDA RK Heun accept module must own Heun accepted-state kernel");
    check(
        rk4_accept_header.find("GPU CUDA RK RK4 accept kernel module header") !=
                std::string::npos &&
            rk4_accept_header.find("fullmag_cuda_rk4_accept(") !=
                std::string::npos &&
            rk4_accept_source.find("#include \"gpu/cuda/integrators/rk/rk_rk4_accept_kernel.hpp\"") !=
                std::string::npos &&
            rk4_accept_source.find("GPU CUDA RK RK4 accept kernel source contract") !=
                std::string::npos &&
            rk4_accept_source.find("rk4_accept_kernel") !=
                std::string::npos &&
            rk4_accept_source.find("fullmag_cuda_rk4_accept(") !=
                std::string::npos,
        "GPU CUDA RK RK4 accept module must own RK4 accepted-state kernel");
    check(
        bs23_accept_header.find("GPU CUDA RK BS23 accept kernel module header") !=
                std::string::npos &&
            bs23_accept_header.find("fullmag_cuda_bs23_accept(") !=
                std::string::npos &&
            bs23_accept_source.find("#include \"gpu/cuda/integrators/rk/rk_bs23_accept_kernel.hpp\"") !=
                std::string::npos &&
            bs23_accept_source.find("GPU CUDA RK BS23 accept kernel source contract") !=
                std::string::npos &&
            bs23_accept_source.find("bs23_accept_kernel") !=
                std::string::npos &&
            bs23_accept_source.find("fullmag_cuda_bs23_accept(") !=
                std::string::npos,
        "GPU CUDA RK BS23 accept module must own BS23 accepted-state kernel");
    check(
        dp54_accept_header.find("GPU CUDA RK DP54 accept kernel module header") !=
                std::string::npos &&
            dp54_accept_header.find("fullmag_cuda_dp54_accept(") !=
                std::string::npos &&
            dp54_accept_source.find("#include \"gpu/cuda/integrators/rk/rk_dp54_accept_kernel.hpp\"") !=
                std::string::npos &&
            dp54_accept_source.find("GPU CUDA RK DP54 accept kernel source contract") !=
                std::string::npos &&
            dp54_accept_source.find("dp54_accept_kernel") !=
                std::string::npos &&
            dp54_accept_source.find("fullmag_cuda_dp54_accept(") !=
                std::string::npos,
        "GPU CUDA RK DP54 accept module must own DP54 accepted-state kernel");
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
    const std::string scalar_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_scalar_readback.hpp");
    const std::string scalar_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_scalar_readback.cu");
    const std::string component_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_component_copy.hpp");
    const std::string component_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_component_copy.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_device_io.cu") ==
            std::string::npos,
        "FEM CMake source list must not build removed GPU RK device I/O compatibility helpers");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_device_io.hpp") &&
            !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_device_io.cu"),
        "GPU CUDA RK device I/O compatibility files must be removed after concrete owner modules exist");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_scalar_readback.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK scalar readback helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_component_copy.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK component copy helpers from gpu/cuda/integrators/rk");
    check(
        final_refresh.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") ==
                std::string::npos &&
            attempt_setup.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") ==
                std::string::npos &&
            final_refresh.find("#include \"gpu/cuda/integrators/rk/rk_component_copy.hpp\"") !=
                std::string::npos &&
            attempt_setup.find("#include \"gpu/cuda/integrators/rk/rk_component_copy.hpp\"") !=
                std::string::npos,
        "GPU CUDA RK final refresh and attempt setup sources must include concrete component-copy helpers instead of the device I/O compatibility module");
    check(
        stage_schedule.find("#include \"gpu/cuda/integrators/rk/rk_device_io.hpp\"") ==
            std::string::npos,
        "GPU CUDA RK stage schedule source must not include the RK device I/O module directly");
    check(
        scalar_header.find("GPU CUDA RK scalar readback module header") !=
                std::string::npos &&
            scalar_header.find("gpu_rk_read_scalar_result(") !=
                std::string::npos &&
            scalar_header.find("gpu_rk_read_scalar_results(") !=
                std::string::npos,
        "GPU CUDA RK scalar readback header must own scalar read declarations");
    check(
        component_header.find("GPU CUDA RK component copy module header") !=
                std::string::npos &&
            component_header.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            component_header.find("gpu_rk_download_component_device_to_aos(") !=
                std::string::npos,
        "GPU CUDA RK component copy header must own component copy declarations");
    check(
        scalar_source.find("#include \"gpu/cuda/integrators/rk/rk_scalar_readback.hpp\"") !=
                std::string::npos &&
            scalar_source.find("GPU CUDA RK scalar readback source contract") !=
                std::string::npos &&
            scalar_source.find("gpu_rk_read_scalar_result(") !=
                std::string::npos &&
            scalar_source.find("gpu_rk_read_scalar_results(") !=
                std::string::npos &&
            scalar_source.find("cudaMemcpyAsync") !=
                std::string::npos &&
            scalar_source.find("cudaStreamSynchronize") !=
                std::string::npos &&
            scalar_source.find("record_device_to_host") !=
                std::string::npos,
        "GPU CUDA RK scalar readback source must own audited scalar device-to-host transfers");
    check(
        component_source.find("#include \"gpu/cuda/integrators/rk/rk_component_copy.hpp\"") !=
                std::string::npos &&
            component_source.find("GPU CUDA RK component copy source contract") !=
                std::string::npos &&
            component_source.find("gpu_rk_copy_component_device(") !=
                std::string::npos &&
            component_source.find("gpu_rk_download_component_device_to_aos(") !=
                std::string::npos &&
            component_source.find("cudaMemcpyAsync") !=
                std::string::npos &&
            component_source.find("cudaMemcpy2DAsync") !=
                std::string::npos &&
            component_source.find("record_device_to_host") !=
                std::string::npos,
        "GPU CUDA RK component copy source must own component device copies and audited AoS downloads");
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
    const std::string decision_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_decision_readback.hpp");
    const std::string decision_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_decision_readback.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_adaptive_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive runtime helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_error_norm_runtime.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive error-norm runtime helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK adaptive decision readback helpers from gpu/cuda/integrators/rk");
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
        attempt_loop.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp\"") !=
                std::string::npos &&
            rk_step.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp\"") ==
                std::string::npos,
        "GPU CUDA RK attempt loop source must include the RK adaptive decision readback module");
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
        "GPU CUDA RK adaptive runtime module must not own adaptive error-norm reductions or readback");
    check(
        error_norm_header.find("GPU CUDA RK adaptive error-norm runtime module header") !=
                std::string::npos &&
            error_norm_header.find("gpu_rk_reduce_adaptive_error_norm_device(") !=
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime header must own device error norm declarations");
    check(
        error_norm_source.find("#include \"gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp\"") !=
                std::string::npos &&
            error_norm_source.find("GPU CUDA RK adaptive error-norm runtime source contract") !=
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must document and include its module header");
    check(
        error_norm_source.find("gpu_rk_reduce_adaptive_error_norm_device(") !=
                std::string::npos &&
            error_norm_source.find("fullmag_cuda_adaptive_error_norm_blocks(") !=
                std::string::npos &&
            error_norm_source.find("fullmag_cuda_device_max(") !=
                std::string::npos &&
            error_norm_source.find("gpu.reductions.scalar_workspace") !=
                std::string::npos &&
            error_norm_source.find("gpu.reductions.temp_storage") !=
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must own device error norm reduction helpers");
    check(
        error_norm_source.find("gpu_rk_copy_component_device(") ==
                std::string::npos &&
            error_norm_source.find("gpu_rk_adaptive_pi_step(") ==
                std::string::npos &&
            error_norm_source.find("gpu_rk_read_scalar_result(") ==
                std::string::npos,
        "GPU CUDA RK adaptive error-norm runtime source must not own adaptive policy, readback, or reject restore helpers");
    check(
        decision_header.find("GPU CUDA RK adaptive decision readback module header") !=
                std::string::npos &&
            decision_header.find("struct GpuAdaptiveDecisionReadback") !=
                std::string::npos &&
            decision_header.find("gpu_rk_read_adaptive_error_norm_decision_host(") !=
                std::string::npos,
        "GPU CUDA RK adaptive decision readback header must document and declare the transitional host boundary");
    check(
        decision_source.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp\"") !=
                std::string::npos &&
            decision_source.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp\"") !=
                std::string::npos &&
            decision_source.find("#include \"gpu/cuda/integrators/rk/rk_scalar_readback.hpp\"") !=
                std::string::npos &&
            decision_source.find("GPU CUDA RK adaptive decision readback source contract") !=
                std::string::npos,
        "GPU CUDA RK adaptive decision readback source must document and include its module dependencies");
    check(
        decision_source.find("gpu_rk_read_scalar_result(") !=
                std::string::npos &&
            decision_source.find("gpu_rk_adaptive_pi_step(ctx, error_norm)") !=
                std::string::npos &&
            decision_source.find("cudaMemcpyAsync GPU RK adaptive decision scalar device->host") !=
                std::string::npos,
        "GPU CUDA RK adaptive decision readback source must own the transitional scalar readback and host PI handoff");
    check(
        decision_source.find("fullmag_cuda_adaptive_error_norm_blocks(") ==
                std::string::npos &&
            decision_source.find("fullmag_cuda_device_max(") ==
                std::string::npos &&
            decision_source.find("gpu_rk_copy_component_device(") ==
                std::string::npos,
        "GPU CUDA RK adaptive decision readback source must not own error-norm reductions or reject restore");
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
        decision_source.find("gpu_rk_device_resident_step(") == std::string::npos &&
            decision_source.find("compute_rhs_for_magnetization(") ==
                std::string::npos,
        "GPU CUDA RK adaptive decision readback source must not own RK step orchestration or RHS assembly");
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
            attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp\"") !=
                std::string::npos &&
            attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp\"") !=
                std::string::npos &&
            attempt_loop_source.find("#include \"gpu/cuda/integrators/rk/rk_stage_schedule.hpp\"") !=
                std::string::npos,
        "GPU CUDA RK attempt loop source must include adaptive policy, decision readback, error norm, and stage schedule modules");
    check(
        attempt_loop_source.find("gpu_rk_run_stage_attempt(") !=
                std::string::npos &&
            attempt_loop_source.find("gpu_rk_reduce_adaptive_error_norm_device(") !=
                std::string::npos &&
            attempt_loop_source.find("gpu_rk_read_adaptive_error_norm_decision_host(") !=
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
        attempt_loop_source.find("gpu_rk_adaptive_pi_step(ctx, error_estimate)") ==
            std::string::npos,
        "GPU CUDA RK attempt loop source must delegate host PI handoff through adaptive decision readback");
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
            rk_step.find("gpu_rk_reduce_adaptive_error_norm_device(") ==
                std::string::npos &&
            rk_step.find("gpu_rk_read_adaptive_error_norm_decision_host(") ==
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
    const std::string anisotropy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_anisotropy_field.hpp");
    const std::string anisotropy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_anisotropy_field.cu");
    const std::string magnetoelastic_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetoelastic_field.hpp");
    const std::string magnetoelastic_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetoelastic_field.cu");
    const std::string thermal_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_thermal_field.hpp");
    const std::string thermal_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_thermal_field.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_local_fields.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK local-field helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_anisotropy_field.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK anisotropy field helper from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK magnetoelastic field helper from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_thermal_field.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK thermal field helper from gpu/cuda/integrators/rk");
    check(
        local_header.find("GPU CUDA RK local field contributions module header") !=
                std::string::npos &&
            local_header.find("gpu_rk_compute_local_field_contributions(") !=
                std::string::npos,
        "GPU CUDA RK local-field header must document and declare local-field contribution generation");
    check(
        local_source.find("#include \"gpu/cuda/integrators/rk/rk_local_fields.hpp\"") !=
                std::string::npos &&
            local_source.find("#include \"gpu/cuda/integrators/rk/rk_anisotropy_field.hpp\"") !=
                std::string::npos &&
            local_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp\"") !=
                std::string::npos &&
            local_source.find("#include \"gpu/cuda/integrators/rk/rk_thermal_field.hpp\"") !=
                std::string::npos &&
            local_source.find("GPU CUDA RK local field contributions source contract") !=
                std::string::npos &&
            local_source.find("gpu_rk_compute_anisotropy_field_contributions(ctx, m, stream, n, reason)") !=
                std::string::npos &&
            local_source.find("gpu_rk_compute_magnetoelastic_field_contribution(ctx, m, stream, n, reason)") !=
                std::string::npos &&
            local_source.find("gpu_rk_compute_thermal_field_contribution(ctx, stream, n, reason)") !=
                std::string::npos,
        "GPU CUDA RK local-field source must document its module header and delegate specialized local field generation");
    check(
        anisotropy_header.find("GPU CUDA RK anisotropy local field module header") !=
                std::string::npos &&
            anisotropy_header.find("gpu_rk_compute_anisotropy_field_contributions(") !=
                std::string::npos,
        "GPU CUDA RK anisotropy field header must document and declare anisotropy field generation");
    check(
        anisotropy_source.find("#include \"gpu/cuda/integrators/rk/rk_anisotropy_field.hpp\"") !=
                std::string::npos &&
            anisotropy_source.find("#include \"gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp\"") !=
                std::string::npos &&
            anisotropy_source.find("GPU CUDA RK anisotropy local field source contract") !=
                std::string::npos,
        "GPU CUDA RK anisotropy field source must document and include its module and anisotropy kernel headers");
    check(
        magnetoelastic_header.find("GPU CUDA RK magnetoelastic local field module header") !=
                std::string::npos &&
            magnetoelastic_header.find("gpu_rk_compute_magnetoelastic_field_contribution(") !=
                std::string::npos,
        "GPU CUDA RK magnetoelastic field header must document and declare magnetoelastic field generation");
    check(
        magnetoelastic_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp\"") !=
                std::string::npos &&
            magnetoelastic_source.find("#include \"gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp\"") !=
                std::string::npos &&
            magnetoelastic_source.find("GPU CUDA RK magnetoelastic local field source contract") !=
                std::string::npos,
        "GPU CUDA RK magnetoelastic field source must document and include its module and magnetoelastic kernel headers");
    check(
        thermal_header.find("GPU CUDA RK thermal local field module header") !=
                std::string::npos &&
            thermal_header.find("gpu_rk_compute_thermal_field_contribution(") !=
                std::string::npos,
        "GPU CUDA RK thermal field header must document and declare thermal field generation");
    check(
        thermal_source.find("#include \"gpu/cuda/integrators/rk/rk_thermal_field.hpp\"") !=
                std::string::npos &&
            thermal_source.find("#include \"gpu/cuda/interactions/thermal/thermal_kernels.hpp\"") !=
                std::string::npos &&
            thermal_source.find("GPU CUDA RK thermal local field source contract") !=
                std::string::npos,
        "GPU CUDA RK thermal field source must document and include its module and thermal kernel headers");
    check(
        anisotropy_source.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") !=
                std::string::npos &&
            anisotropy_source.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA RK anisotropy field source must own anisotropy local field contribution generation");
    check(
        local_source.find("fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(") ==
                std::string::npos &&
            local_source.find("fullmag_cuda_cubic_anisotropy_field_energy_blocks(") ==
                std::string::npos &&
            local_source.find("launch GPU RK uniaxial anisotropy field") ==
                std::string::npos &&
            local_source.find("launch GPU RK cubic anisotropy field") ==
                std::string::npos,
        "GPU CUDA RK local-field source must delegate anisotropy field internals");
    check(
        magnetoelastic_source.find("ctx.magnetoelastic.enabled") !=
                std::string::npos &&
            magnetoelastic_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") !=
                std::string::npos &&
            magnetoelastic_source.find("use_per_node_strain ? gpu.magnetoelastic.strain_voigt : nullptr") !=
                std::string::npos &&
            magnetoelastic_source.find("launch GPU RK magnetoelastic field") !=
                std::string::npos &&
            magnetoelastic_source.find("GPU RK magnetoelastic field requires prescribed strain data") !=
                std::string::npos &&
            magnetoelastic_source.find("GPU RK magnetoelastic field requires 6 prescribed strain Voigt values per node") !=
                std::string::npos &&
            magnetoelastic_source.find("GPU RK magnetoelastic field requires device-resident per-node strain") !=
                std::string::npos &&
            magnetoelastic_source.find("GPU RK magnetoelastic field requires device-resident Ms, lumped mass, and H_mel buffers") !=
                std::string::npos,
        "GPU CUDA RK magnetoelastic field source must own prescribed-strain validation and launch");
    check(
        local_source.find("fullmag_cuda_magnetoelastic_field_energy_blocks(") ==
                std::string::npos &&
            local_source.find("launch GPU RK magnetoelastic field") ==
                std::string::npos &&
            local_source.find("GPU RK magnetoelastic field requires prescribed strain data") ==
                std::string::npos,
        "GPU CUDA RK local-field source must delegate magnetoelastic field internals");
    check(
        thermal_source.find("ctx.thermal_brown.temperature <= 0.0") !=
                std::string::npos &&
            thermal_source.find("ctx.thermal_brown.seed == 0") !=
                std::string::npos &&
            thermal_source.find("ctx.adaptive_dt.current_dt <= 0.0") !=
                std::string::npos &&
            thermal_source.find("fullmag_cuda_thermal_field_blocks(") !=
                std::string::npos &&
            thermal_source.find("launch GPU RK deterministic thermal field") !=
                std::string::npos,
        "GPU CUDA RK thermal field source must own deterministic Brown thermal validation and launch");
    check(
        local_source.find("fullmag_cuda_thermal_field_blocks(") == std::string::npos &&
            local_source.find("launch GPU RK deterministic thermal field") ==
                std::string::npos &&
            local_source.find("GPU RK thermal field requires deterministic thermal seed") ==
                std::string::npos,
        "GPU CUDA RK local-field source must delegate thermal field internals");
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
    const std::string oersted_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_oersted_field.hpp");
    const std::string oersted_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_oersted_field.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_effective_field.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK effective-field helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_oersted_field.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK Oersted field helper from gpu/cuda/integrators/rk");
    check(
        effective_header.find("GPU CUDA RK effective field accumulation module header") !=
                std::string::npos &&
            effective_header.find("gpu_rk_accumulate_effective_field(") !=
                std::string::npos,
        "GPU CUDA RK effective-field header must document and declare H_eff accumulation");
    check(
        effective_source.find("#include \"gpu/cuda/integrators/rk/rk_effective_field.hpp\"") !=
                std::string::npos &&
            effective_source.find("#include \"gpu/cuda/integrators/rk/rk_oersted_field.hpp\"") !=
                std::string::npos &&
            effective_source.find("GPU CUDA RK effective field accumulation source contract") !=
                std::string::npos,
        "GPU CUDA RK effective-field source must document and include its module header");
    check(
        effective_source.find("fullmag_cuda_accumulate_heff(") !=
                std::string::npos &&
            effective_source.find("fullmag_cuda_add_field_inplace(") !=
                std::string::npos &&
            effective_source.find("gpu_rk_accumulate_oersted_field(ctx, stream, n, reason)") !=
                std::string::npos,
        "GPU CUDA RK effective-field source must own base/local H_eff accumulation and delegate Oersted contribution");
    check(
        oersted_header.find("GPU CUDA RK Oersted field accumulation module header") !=
                std::string::npos &&
            oersted_header.find("gpu_rk_accumulate_oersted_field(") !=
                std::string::npos,
        "GPU CUDA RK Oersted field header must document and declare Oersted H_eff accumulation");
    check(
        oersted_source.find("#include \"gpu/cuda/integrators/rk/rk_oersted_field.hpp\"") !=
                std::string::npos &&
            oersted_source.find("#include \"gpu/cuda/interactions/oersted/oersted_kernels.hpp\"") !=
                std::string::npos &&
            oersted_source.find("GPU CUDA RK Oersted field accumulation source contract") !=
                std::string::npos &&
            oersted_source.find("double gpu_rk_oersted_scale(const Context &ctx)") !=
                std::string::npos &&
            oersted_source.find("ctx.oersted.time_dep_kind") !=
                std::string::npos &&
            oersted_source.find("fullmag_cuda_add_scaled_field_inplace(") !=
                std::string::npos &&
            oersted_source.find("launch GPU RK Oersted h_eff accumulation") !=
                std::string::npos,
        "GPU CUDA RK Oersted field source must own time-dependent scaling and scaled field addition");
    check(
        effective_source.find("fullmag_cuda_add_scaled_field_inplace(") ==
                std::string::npos &&
            effective_source.find("double gpu_rk_oersted_scale(const Context &ctx)") ==
                std::string::npos &&
            effective_source.find("launch GPU RK Oersted h_eff accumulation") ==
                std::string::npos,
        "GPU CUDA RK effective-field source must delegate Oersted internals");
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
    const std::string slonczewski_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_slonczewski_torque.hpp");
    const std::string slonczewski_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_slonczewski_torque.cu");
    const std::string zhang_li_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_zhang_li_torque.hpp");
    const std::string zhang_li_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_zhang_li_torque.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_direct_torques.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK direct-torque helpers from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_slonczewski_torque.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK Slonczewski torque helper from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_zhang_li_torque.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK Zhang-Li torque helper from gpu/cuda/integrators/rk");
    check(
        direct_header.find("GPU CUDA RK direct torque module header") !=
                std::string::npos &&
            direct_header.find("gpu_rk_add_direct_torques(") !=
                std::string::npos,
        "GPU CUDA RK direct-torque header must document and declare direct torque RHS additions");
    check(
        direct_source.find("#include \"gpu/cuda/integrators/rk/rk_direct_torques.hpp\"") !=
                std::string::npos &&
            direct_source.find("#include \"gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp\"") !=
                std::string::npos &&
            direct_source.find("#include \"gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp\"") !=
                std::string::npos &&
            direct_source.find("GPU CUDA RK direct torque source contract") !=
                std::string::npos,
        "GPU CUDA RK direct-torque source must document and include its module header");
    check(
        direct_source.find("gpu_rk_add_slonczewski_torque(ctx, m, rhs, stream, n, reason)") !=
                std::string::npos &&
            direct_source.find("gpu_rk_add_zhang_li_torque(ctx, m, rhs, stream, n, reason)") !=
                std::string::npos,
        "GPU CUDA RK direct-torque source must delegate Slonczewski and Zhang-Li RHS additions");
    check(
        slonczewski_header.find("GPU CUDA RK Slonczewski torque module header") !=
                std::string::npos &&
            slonczewski_header.find("gpu_rk_add_slonczewski_torque(") !=
                std::string::npos,
        "GPU CUDA RK Slonczewski torque header must document and declare Slonczewski RHS addition");
    check(
        slonczewski_source.find("#include \"gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp\"") !=
                std::string::npos &&
            slonczewski_source.find("#include \"gpu/cuda/interactions/stt/stt_kernels.hpp\"") !=
                std::string::npos &&
            slonczewski_source.find("GPU CUDA RK Slonczewski torque source contract") !=
                std::string::npos &&
            slonczewski_source.find("fullmag_cuda_add_slonczewski_stt_rhs(") !=
                std::string::npos &&
            slonczewski_source.find("gpu_rk_current_density_magnitude(ctx)") !=
                std::string::npos &&
            slonczewski_source.find("gpu_rk_resolve_slonczewski_thickness(ctx)") !=
                std::string::npos,
        "GPU CUDA RK Slonczewski torque source must own Slonczewski validation and launch");
    check(
        zhang_li_header.find("GPU CUDA RK Zhang-Li torque module header") !=
                std::string::npos &&
            zhang_li_header.find("gpu_rk_add_zhang_li_torque(") !=
                std::string::npos,
        "GPU CUDA RK Zhang-Li torque header must document and declare Zhang-Li RHS addition");
    check(
        zhang_li_source.find("#include \"gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp\"") !=
                std::string::npos &&
            zhang_li_source.find("#include \"gpu/cuda/interactions/stt/stt_kernels.hpp\"") !=
                std::string::npos &&
            zhang_li_source.find("GPU CUDA RK Zhang-Li torque source contract") !=
                std::string::npos &&
            zhang_li_source.find("fullmag_cuda_add_zhang_li_stt_rhs(") !=
                std::string::npos &&
            zhang_li_source.find("requires device-resident mesh geometry") !=
                std::string::npos,
        "GPU CUDA RK Zhang-Li torque source must own Zhang-Li validation and launch");
    check(
        direct_source.find("fullmag_cuda_add_slonczewski_stt_rhs(") ==
                std::string::npos &&
            direct_source.find("fullmag_cuda_add_zhang_li_stt_rhs(") ==
                std::string::npos &&
            direct_source.find("gpu_rk_current_density_magnitude(ctx)") ==
                std::string::npos &&
            direct_source.find("gpu_rk_resolve_slonczewski_thickness(ctx)") ==
                std::string::npos &&
            direct_source.find("requires device-resident mesh geometry") ==
                std::string::npos,
        "GPU CUDA RK direct-torque source must delegate specialized STT internals");
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
    const std::string dmi_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.hpp");
    const std::string dmi_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/dmi/dmi_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU DMI CUDA kernels from gpu/cuda/interactions/dmi");
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
}


void gpu_stt_kernels_are_owned_by_cuda_stt_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string stt_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.hpp");
    const std::string stt_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/stt/stt_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU STT CUDA kernels from gpu/cuda/interactions/stt");
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
}


void gpu_thermal_kernels_are_owned_by_cuda_thermal_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string thermal_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "thermal" / "thermal_kernels.hpp");
    const std::string thermal_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "thermal" / "thermal_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/thermal/thermal_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU thermal CUDA kernels from gpu/cuda/interactions/thermal");
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
}


void gpu_anisotropy_kernels_are_owned_by_cuda_anisotropy_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string anis_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "anisotropy" / "anisotropy_kernels.hpp");
    const std::string anis_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "anisotropy" / "anisotropy_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU anisotropy CUDA kernels from gpu/cuda/interactions/anisotropy");
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
}


void gpu_zeeman_kernels_are_owned_by_cuda_zeeman_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string zeeman_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "zeeman" / "zeeman_kernels.hpp");
    const std::string zeeman_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "zeeman" / "zeeman_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/zeeman/zeeman_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU Zeeman CUDA kernels from gpu/cuda/interactions/zeeman");
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
}


void gpu_oersted_kernels_are_owned_by_cuda_oersted_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string oersted_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "oersted" / "oersted_kernels.hpp");
    const std::string oersted_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "oersted" / "oersted_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/oersted/oersted_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU Oersted CUDA kernels from gpu/cuda/interactions/oersted");
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
}


void gpu_observable_kernels_are_owned_by_cuda_observables_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string observables_header =
        read_text_file(root / "gpu" / "cuda" / "observables" / "observable_kernels.hpp");
    const std::string observables_source =
        read_text_file(root / "gpu" / "cuda" / "observables" / "observable_kernels.cu");

    check(
        cmake.find("gpu/cuda/observables/observable_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU observable CUDA kernels from gpu/cuda/observables");
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
}


void gpu_magnetoelastic_kernels_are_owned_by_cuda_magnetoelastic_interaction_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string mel_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_kernels.hpp");
    const std::string mel_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_kernels.cu");

    check(
        cmake.find("gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU magnetoelastic CUDA kernels from gpu/cuda/interactions/magnetoelastic");
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
}


void cuda_demag_kernels_are_owned_by_cuda_demag_kernel_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
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
}


} // namespace

int main() {
    cuda_kernels_are_owned_by_cuda_kernels_module();
    gpu_cuda_vector_field_kernels_are_owned_by_cuda_fields_module();
    gpu_cuda_transfer_kernels_are_owned_by_cuda_transfer_module();
    gpu_component_transfers_are_owned_by_cuda_transfer_module();
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
    return 0;
}
