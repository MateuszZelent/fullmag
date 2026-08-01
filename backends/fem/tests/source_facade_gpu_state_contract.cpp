/*
 * source_facade_gpu_state_contract.cpp - native FEM source-facade ownership docs.
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

void gpu_mesh_geometry_is_owned_by_cuda_mesh_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string mesh_geometry_header =
        read_text_file(root / "gpu" / "cuda" / "mesh" / "mesh_geometry_state.hpp");
    const std::string mesh_geometry_upload_header =
        read_text_file(root / "gpu" / "cuda" / "mesh" / "mesh_geometry_upload.hpp");
    const std::string mesh_geometry_upload_source =
        read_text_file(root / "gpu" / "cuda" / "mesh" / "mesh_geometry_upload.cpp");
    const std::string gpu_state_runtime_header =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.hpp");
    const std::string gpu_state_runtime_source =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string dmi_field_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_fields.cu");
    const std::string dmi_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_energy_reductions.cu");
    const std::string zhang_li_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_zhang_li_torque.cu");
    const std::string rk_plan_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_plan.cpp");

    check(
        mesh_geometry_header.find("GPU CUDA mesh geometry device-state module header") !=
                std::string::npos &&
            mesh_geometry_header.find("struct FemGpuMeshGeometryDeviceState") !=
                std::string::npos &&
            mesh_geometry_header.find("double *nodes_xyz") != std::string::npos &&
            mesh_geometry_header.find("uint32_t *elements") != std::string::npos &&
            mesh_geometry_header.find("uint8_t *magnetic_element_mask") !=
                std::string::npos &&
            mesh_geometry_header.find("uint64_t element_count") !=
                std::string::npos &&
            mesh_geometry_header.find("bool uploaded") != std::string::npos,
        "GPU CUDA mesh module must own uploaded device-side mesh geometry");
    check(
        mesh_geometry_upload_header.find("GPU CUDA mesh geometry upload module header") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("GPU CUDA mesh geometry upload source contract") !=
                std::string::npos &&
            mesh_geometry_upload_header.find("bool gpu_mesh_geometry_upload(") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("bool gpu_mesh_geometry_upload(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/mesh/mesh_geometry_upload.cpp") !=
                std::string::npos,
        "GPU CUDA mesh module must own mesh geometry upload/allocation");
    check(
        gpu_state_header.find("#include \"gpu/cuda/mesh/mesh_geometry_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuMeshGeometryDeviceState mesh_geometry{}") !=
                std::string::npos &&
            gpu_state_header.find("double *nodes_xyz = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("uint64_t mesh_element_count = 0") ==
                std::string::npos &&
            gpu_state_header.find("bool mesh_geometry_uploaded = false") ==
                std::string::npos,
        "FemGpuState must store mesh geometry through an explicit mesh-geometry substate");
    check(
        gpu_state_source.find("gpu_mesh_geometry_upload(") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle") !=
                std::string::npos &&
            gpu_state_source.find("state.mesh_geometry") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("mesh_geometry.nodes_xyz") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("mesh_geometry.elements") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("mesh_geometry.magnetic_element_mask") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("mesh_geometry.element_count") !=
                std::string::npos &&
            mesh_geometry_upload_source.find("mesh_geometry.uploaded") !=
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_geometry.nodes_xyz") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_geometry.elements") ==
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.mesh_geometry.magnetic_element_mask") ==
                std::string::npos &&
            gpu_state_source.find("state.nodes_xyz") == std::string::npos &&
            gpu_state_source.find("state.mesh_element_count") == std::string::npos,
        "GPU mesh geometry upload must be delegated to the mesh-geometry upload module");
    for (const std::string *source : {&dmi_field_source, &dmi_energy_source, &zhang_li_source}) {
        check(
            source->find("gpu.mesh_geometry.uploaded") != std::string::npos &&
                source->find("gpu.mesh_geometry.element_count") !=
                    std::string::npos &&
                source->find("gpu.mesh_geometry.nodes_xyz") != std::string::npos &&
                source->find("gpu.mesh_geometry.elements") != std::string::npos &&
                source->find("gpu.mesh_geometry.magnetic_element_mask") !=
                    std::string::npos &&
                source->find("gpu.nodes_xyz") == std::string::npos &&
                source->find("gpu.mesh_element_count") == std::string::npos,
            "GPU RK DMI/STT geometry consumers must use the mesh-geometry substate");
    }
    check(
        rk_plan_source.find("ctx.gpu_state.device.mesh_geometry.uploaded") !=
                std::string::npos &&
            rk_plan_source.find("ctx.gpu_state.device.mesh_geometry.element_count") !=
                std::string::npos &&
            rk_plan_source.find("ctx.gpu_state.device.mesh_geometry_uploaded") ==
                std::string::npos,
        "GPU RK readiness planning must use the mesh-geometry substate");
    check(
        gpu_state_runtime_header.find(
            "bool gpu_state_requires_tetrahedral_mesh_geometry(const Context &ctx)") !=
                std::string::npos &&
            gpu_state_runtime_source.find(
                "gpu_state_requires_tetrahedral_mesh_geometry(ctx) &&") !=
                std::string::npos,
        "GPU-state bootstrap must gate tetrahedral geometry upload by actual consumers");
    check(
        gpu_state_runtime_source.find("ctx.dmi.interfacial_enabled") !=
                std::string::npos &&
            gpu_state_runtime_source.find("ctx.dmi.bulk_enabled") !=
                std::string::npos &&
            gpu_state_runtime_source.find("ctx.stt.zhang_li_enabled") !=
                std::string::npos,
        "DMI and Zhang-Li STT must remain the explicit tetrahedral geometry consumers");
    check(
        mesh_geometry_upload_source.find(
            "mesh geometry upload requires tetrahedral element connectivity") !=
            std::string::npos,
        "consumer-gated geometry upload must remain strict tetrahedral and fail closed");
}


void gpu_field_buffers_are_owned_by_cuda_fields_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string field_buffer_header =
        read_text_file(root / "gpu" / "cuda" / "fields" / "field_buffer_state.hpp");
    const std::string field_buffer_memory_header =
        read_text_file(root / "gpu" / "cuda" / "fields" / "field_buffer_memory.hpp");
    const std::string field_buffer_memory_source =
        read_text_file(root / "gpu" / "cuda" / "fields" / "field_buffer_memory.cpp");
    const std::string field_buffer_upload_header =
        read_text_file(root / "gpu" / "cuda" / "fields" / "field_buffer_upload.hpp");
    const std::string field_buffer_upload_source =
        read_text_file(root / "gpu" / "cuda" / "fields" / "field_buffer_upload.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string effective_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_effective_field.cu");
    const std::string demag_stage_source =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string exchange_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");
    const std::string llg_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_llg_rhs_dispatch.cu");
    const std::string oersted_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_oersted_field.cu");

    check(
        field_buffer_header.find("GPU CUDA field-buffer device-state module header") !=
                std::string::npos &&
            field_buffer_header.find("struct FemGpuFieldBufferDeviceState") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_ex") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_demag") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_ext") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_ani") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_cubic_ani") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_dmi") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_bulk_dmi") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_oe") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_therm") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_mel") !=
                std::string::npos &&
            field_buffer_header.find("FemGpuComponentField h_eff") !=
                std::string::npos,
        "GPU CUDA fields module must own device field-buffer state");
    check(
        field_buffer_memory_header.find("GPU CUDA field-buffer memory module header") !=
                std::string::npos &&
            field_buffer_memory_source.find("GPU CUDA field-buffer memory source contract") !=
                std::string::npos &&
            field_buffer_memory_header.find("bool gpu_field_buffers_allocate(") !=
                std::string::npos &&
            field_buffer_memory_header.find("void gpu_field_buffers_free(") !=
                std::string::npos &&
            field_buffer_memory_source.find("bool gpu_field_buffers_allocate(") !=
                std::string::npos &&
            field_buffer_memory_source.find("void gpu_field_buffers_free(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/fields/field_buffer_memory.cpp") !=
                std::string::npos,
        "GPU CUDA fields module must own field-buffer memory helpers");
    check(
        field_buffer_upload_header.find("GPU CUDA field-buffer upload module header") !=
                std::string::npos &&
            field_buffer_upload_source.find("GPU CUDA field-buffer upload source contract") !=
                std::string::npos &&
            field_buffer_upload_header.find("gpu_field_buffers_upload_effective_fields_aos(") !=
                std::string::npos &&
            field_buffer_upload_header.find("gpu_field_buffers_upload_demag_field_aos(") !=
                std::string::npos &&
            field_buffer_upload_header.find("gpu_field_buffers_upload_local_vector_fields_aos(") !=
                std::string::npos &&
            field_buffer_upload_source.find("gpu_field_buffers_upload_effective_fields_aos(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/fields/field_buffer_upload.cpp") !=
                std::string::npos,
        "GPU CUDA fields module must own field-buffer upload helpers");
    check(
        gpu_state_header.find("#include \"gpu/cuda/fields/field_buffer_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuFieldBufferDeviceState fields{}") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_ex") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_demag") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_ext") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_ani") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_cubic_ani") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_dmi") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_bulk_dmi") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_oe") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_therm") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_mel") == std::string::npos &&
            gpu_state_header.find("FemGpuComponentField h_eff") == std::string::npos,
        "FemGpuState must store field buffers through an explicit fields substate");
    check(
        gpu_state_source.find("state.fields") != std::string::npos &&
            gpu_state_source.find("gpu_field_buffers_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_field_buffers_free(") !=
                std::string::npos &&
            field_buffer_memory_source.find("fields.h_ex") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_demag") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_ext") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_ani") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_cubic_ani") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_dmi") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_bulk_dmi") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_oe") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_therm") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_mel") != std::string::npos &&
            field_buffer_memory_source.find("fields.h_eff") != std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_component(state.fields.") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_component(state.fields.") ==
                std::string::npos,
        "GPU state allocation/upload/destroy must use the fields substate");
    check(
        gpu_state_source.find("gpu_field_buffers_upload_effective_fields_aos(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_field_buffers_upload_demag_field_aos(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_field_buffers_upload_local_vector_fields_aos(") !=
                std::string::npos &&
            field_buffer_upload_source.find("fields.h_ex") != std::string::npos &&
            field_buffer_upload_source.find("fields.h_demag") != std::string::npos &&
            field_buffer_upload_source.find("fields.h_ext") != std::string::npos &&
            field_buffer_upload_source.find("fields.h_ani") != std::string::npos &&
            field_buffer_upload_source.find("fields.h_eff") != std::string::npos &&
            gpu_state_source.find("gpu_component_upload_aos(\n            state.lifecycle, state.fields") ==
                std::string::npos &&
            gpu_state_source.find("gpu_component_upload_optional_aos(\n            state.lifecycle, state.fields") ==
                std::string::npos,
        "GPU state must delegate field-buffer upload details to the fields module");
    for (const std::string *source : {&effective_source, &demag_stage_source, &exchange_source, &llg_source, &oersted_source}) {
        check(
            source->find("gpu.fields.") != std::string::npos &&
                source->find("gpu.h_") == std::string::npos,
            "GPU RK/demag field-buffer consumers must use the fields substate");
    }
}


void gpu_magnetization_state_is_owned_by_cuda_state_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string magnetization_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "magnetization_state.hpp");
    const std::string magnetization_memory_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "magnetization_memory.hpp");
    const std::string magnetization_memory_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "magnetization_memory.cpp");
    const std::string magnetization_transfer_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "magnetization_transfer.hpp");
    const std::string magnetization_transfer_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "magnetization_transfer.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string attempt_setup_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_setup.cu");
    const std::string refresh_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");
    const std::string snapshot_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.cu");
    const std::string magnetization_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetization_reductions.cu");

    check(
        magnetization_header.find("GPU CUDA magnetization device-state module header") !=
                std::string::npos &&
            magnetization_header.find("struct FemGpuMagnetizationDeviceState") !=
                std::string::npos &&
            magnetization_header.find("FemGpuComponentField m") !=
                std::string::npos,
        "GPU CUDA state module must own current magnetization device state");
    check(
        magnetization_memory_header.find("GPU CUDA magnetization memory module header") !=
                std::string::npos &&
            magnetization_memory_source.find("GPU CUDA magnetization memory source contract") !=
                std::string::npos &&
            cmake.find("gpu/cuda/state/magnetization_memory.cpp") !=
                std::string::npos &&
            magnetization_memory_header.find("bool gpu_magnetization_allocate(") !=
                std::string::npos &&
            magnetization_memory_header.find("void gpu_magnetization_free(") !=
                std::string::npos &&
            magnetization_memory_source.find("bool gpu_magnetization_allocate(") !=
                std::string::npos &&
            magnetization_memory_source.find("void gpu_magnetization_free(") !=
                std::string::npos,
        "GPU CUDA state module must own magnetization memory helpers");
    check(
        magnetization_transfer_header.find("GPU CUDA magnetization transfer module header") !=
                std::string::npos &&
            magnetization_transfer_source.find("GPU CUDA magnetization transfer source contract") !=
                std::string::npos &&
            cmake.find("gpu/cuda/state/magnetization_transfer.cpp") !=
                std::string::npos &&
            magnetization_transfer_header.find("bool gpu_magnetization_upload_aos(") !=
                std::string::npos &&
            magnetization_transfer_header.find("bool gpu_magnetization_download_aos(") !=
                std::string::npos &&
            magnetization_transfer_source.find("bool gpu_magnetization_upload_aos(") !=
                std::string::npos &&
            magnetization_transfer_source.find("bool gpu_magnetization_download_aos(") !=
                std::string::npos,
        "GPU CUDA state module must own magnetization transfer helpers");
    check(
        gpu_state_header.find("#include \"gpu/cuda/state/magnetization_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuMagnetizationDeviceState magnetization{}") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuComponentField m;") == std::string::npos,
        "FemGpuState must store current magnetization through an explicit magnetization substate");
    check(
        gpu_state_source.find("state.magnetization") != std::string::npos &&
            gpu_state_source.find("state.m.x") == std::string::npos &&
            gpu_state_source.find("gpu_magnetization_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_magnetization_free(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_magnetization_upload_aos(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_magnetization_download_aos(") !=
                std::string::npos &&
            magnetization_memory_source.find("magnetization.m") !=
                std::string::npos &&
            magnetization_memory_source.find("gpu_device_allocate_component(") !=
                std::string::npos &&
            magnetization_memory_source.find("gpu_device_free_component(") !=
                std::string::npos &&
            magnetization_transfer_source.find("magnetization.m") !=
                std::string::npos &&
            magnetization_transfer_source.find("gpu_component_upload_aos(") !=
                std::string::npos &&
            magnetization_transfer_source.find("gpu_component_download_aos(") !=
                std::string::npos &&
            gpu_state_source.find(
                "gpu_component_upload_aos(\n            state.lifecycle,\n            state.magnetization.m") ==
                std::string::npos &&
            gpu_state_source.find(
                "gpu_component_download_aos(\n            state.lifecycle,\n            state.magnetization.m") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_component(state.magnetization.m") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_component(state.magnetization.m") ==
                std::string::npos,
        "GPU state allocation/upload/download/destroy must use the magnetization substate and delegate transfer details");
    for (const std::string *source : {&attempt_setup_source, &refresh_source, &snapshot_source, &magnetization_source}) {
        check(
            source->find("gpu.magnetization.m") != std::string::npos &&
                source->find("gpu.m.x") == std::string::npos &&
                source->find("gpu.m,") == std::string::npos,
            "GPU RK current-magnetization consumers must use the magnetization substate");
    }
}


void gpu_residency_state_is_owned_by_cuda_state_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string residency_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "residency_state.hpp");
    const std::string preflight_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_preflight.cu");
    const std::string refresh_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");
    const std::string snapshot_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.cu");
    const std::string stats_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");

    check(
        residency_header.find("GPU CUDA residency device-state module header") !=
                std::string::npos &&
            residency_header.find("enum class FemGpuSyncState") !=
                std::string::npos &&
            residency_header.find("struct FemGpuResidencyDeviceState") !=
                std::string::npos &&
            residency_header.find("fullmag_fem_data_residency source_of_truth") !=
                std::string::npos &&
            residency_header.find("FemGpuSyncState host_state = FemGpuSyncState::HostClean") !=
                std::string::npos &&
            residency_header.find("FemGpuSyncState device_state = FemGpuSyncState::HostStale") !=
                std::string::npos,
        "GPU CUDA state module must own residency and host/device sync state");
    check(
        gpu_state_header.find("#include \"gpu/cuda/state/residency_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuResidencyDeviceState residency{}") !=
                std::string::npos &&
            gpu_state_header.find("fullmag_fem_data_residency source_of_truth") ==
                std::string::npos &&
            gpu_state_header.find("FemGpuSyncState host_state") == std::string::npos &&
            gpu_state_header.find("FemGpuSyncState device_state") == std::string::npos,
        "FemGpuState must store residency through an explicit residency substate");
    check(
        gpu_state_source.find("state.residency.source_of_truth") !=
                std::string::npos &&
            gpu_state_source.find("state.residency.host_state") !=
                std::string::npos &&
            gpu_state_source.find("state.residency.device_state") !=
                std::string::npos,
        "GPU state upload/download/info must use the residency substate");
    for (const std::string *source : {&preflight_source, &refresh_source, &snapshot_source, &stats_source}) {
        check(
            source->find("gpu.residency.") != std::string::npos &&
                source->find("gpu.source_of_truth") == std::string::npos &&
                source->find("gpu.host_state") == std::string::npos &&
                source->find("gpu.device_state") == std::string::npos,
            "GPU RK residency consumers must use the residency substate");
    }
}


void gpu_lifecycle_state_is_owned_by_cuda_state_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string lifecycle_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "lifecycle_state.hpp");
    const std::string preflight_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_preflight.cu");
    const std::string exchange_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");
    const std::string snapshot_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.cu");
    const std::string stats_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");

    check(
        lifecycle_header.find("GPU CUDA lifecycle device-state module header") !=
                std::string::npos &&
            lifecycle_header.find("struct FemGpuLifecycleDeviceState") !=
                std::string::npos &&
            lifecycle_header.find("bool initialized = false") !=
                std::string::npos &&
            lifecycle_header.find("bool allocated = false") !=
                std::string::npos &&
            lifecycle_header.find("uint64_t node_count = 0") !=
                std::string::npos &&
            lifecycle_header.find("uint64_t dof_len = 0") !=
                std::string::npos &&
            lifecycle_header.find("uint32_t stage_count = 0") !=
                std::string::npos &&
            lifecycle_header.find("uint64_t device_bytes = 0") !=
                std::string::npos &&
            lifecycle_header.find("uint64_t reduction_workspace_bytes = 0") !=
                std::string::npos,
        "GPU CUDA state module must own lifecycle and allocation metadata");
    check(
        gpu_state_header.find("#include \"gpu/cuda/state/lifecycle_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuLifecycleDeviceState lifecycle{}") !=
                std::string::npos &&
            gpu_state_header.find("bool initialized = false") == std::string::npos &&
            gpu_state_header.find("bool allocated = false") == std::string::npos &&
            gpu_state_header.find("uint64_t node_count = 0") == std::string::npos &&
            gpu_state_header.find("uint64_t dof_len = 0") == std::string::npos &&
            gpu_state_header.find("uint32_t stage_count = 0") == std::string::npos &&
            gpu_state_header.find("uint64_t device_bytes = 0") == std::string::npos &&
            gpu_state_header.find("uint64_t reduction_workspace_bytes = 0") ==
                std::string::npos,
        "FemGpuState must store lifecycle metadata through an explicit lifecycle substate");
    check(
        gpu_state_source.find("state.lifecycle.initialized") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle.allocated") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle.node_count") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle.dof_len") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle.stage_count") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle.device_bytes") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle.reduction_workspace_bytes") !=
                std::string::npos,
        "GPU state allocation/download/info must use the lifecycle substate");
    for (const std::string *source : {&preflight_source, &exchange_source, &snapshot_source, &stats_source}) {
        check(
            source->find("gpu.lifecycle.") != std::string::npos &&
                source->find("gpu.allocated") == std::string::npos &&
                source->find("gpu.node_count") == std::string::npos &&
                source->find("gpu.stage_count") == std::string::npos,
            "GPU RK lifecycle consumers must use the lifecycle substate");
    }
}


void gpu_device_memory_helpers_are_owned_by_cuda_state_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake =
        read_text_file(root / "CMakeLists.txt");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string component_transfer_source =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "component_transfer.cpp");
    const std::string device_memory_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "device_memory.hpp");
    const std::string device_memory_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "device_memory.cpp");

    check(
        device_memory_header.find("GPU CUDA device-memory helper module header") !=
                std::string::npos &&
            device_memory_source.find("GPU CUDA device-memory helper source contract") !=
                std::string::npos,
        "GPU CUDA device-memory helper module must document its ownership boundary");
    check(
        device_memory_header.find("bool gpu_device_checked_node_bytes(") !=
                std::string::npos &&
            device_memory_header.find("bool gpu_device_allocate_bytes(") !=
                std::string::npos &&
            device_memory_header.find("bool gpu_device_allocate_double(") !=
                std::string::npos &&
            device_memory_header.find("bool gpu_device_allocate_u8(") !=
                std::string::npos &&
            device_memory_header.find("bool gpu_device_allocate_u32(") !=
                std::string::npos &&
            device_memory_header.find("bool gpu_device_allocate_component(") !=
                std::string::npos &&
            device_memory_header.find("void gpu_device_free_double(") !=
                std::string::npos &&
            device_memory_header.find("void gpu_device_free_bytes(") !=
                std::string::npos &&
            device_memory_header.find("void gpu_device_free_u8(") !=
                std::string::npos &&
            device_memory_header.find("void gpu_device_free_u32(") !=
                std::string::npos &&
            device_memory_header.find("void gpu_device_free_component(") !=
                std::string::npos,
        "GPU CUDA device-memory module must own allocation/free helper declarations");
    check(
        device_memory_source.find("cudaMalloc") != std::string::npos &&
            device_memory_source.find("cudaFree") != std::string::npos,
        "GPU CUDA device-memory module must own cuda allocation/free calls");
    check(
        cmake.find("gpu/cuda/state/device_memory.cpp") != std::string::npos,
        "fullmag_fem build must compile the GPU CUDA device-memory helper module");
    check(
        gpu_state_source.find("#include \"gpu/cuda/state/device_memory.hpp\"") !=
                std::string::npos &&
            component_transfer_source.find("gpu_device_checked_node_bytes(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_component(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_component(") !=
                std::string::npos,
        "GPU state implementation must use the device-memory helper module");
    check(
        gpu_state_source.find("bool checked_node_bytes(") == std::string::npos &&
            gpu_state_source.find("bool allocate_bytes(") == std::string::npos &&
            gpu_state_source.find("bool allocate_double(") == std::string::npos &&
            gpu_state_source.find("bool allocate_u8(") == std::string::npos &&
            gpu_state_source.find("bool allocate_u32(") == std::string::npos &&
            gpu_state_source.find("bool allocate_component(") == std::string::npos &&
            gpu_state_source.find("void free_double(") == std::string::npos &&
            gpu_state_source.find("void free_bytes(") == std::string::npos &&
            gpu_state_source.find("void free_u8(") == std::string::npos &&
            gpu_state_source.find("void free_u32(") == std::string::npos &&
            gpu_state_source.find("void free_component(") == std::string::npos,
        "GPU state implementation must not keep local device-memory helper owners");
}


void gpu_scalar_reduction_workspace_is_owned_by_cuda_reductions_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string reduction_workspace_header =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_workspace_state.hpp");
    const std::string reduction_workspace_memory_header =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_workspace_memory.hpp");
    const std::string reduction_workspace_memory_source =
        read_text_file(root / "gpu" / "cuda" / "reductions" / "reduction_workspace_memory.cpp");
    const std::string error_norm_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_error_norm_runtime.cu");
    const std::string step_stats_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");
    const std::string demag_stage_source =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");

    check(
        reduction_workspace_header.find("GPU CUDA scalar reduction workspace device-state module header") !=
                std::string::npos &&
            reduction_workspace_header.find("FEM_GPU_SCALAR_RESULT_SLOTS") !=
                std::string::npos &&
            reduction_workspace_header.find("struct FemGpuReductionWorkspaceDeviceState") !=
                std::string::npos &&
            reduction_workspace_header.find("double *scalar_workspace") !=
                std::string::npos &&
            reduction_workspace_header.find("double *scalar_result") !=
                std::string::npos &&
            reduction_workspace_header.find("double *host_scalar_result") !=
                std::string::npos &&
            reduction_workspace_header.find("void *temp_storage") != std::string::npos &&
            reduction_workspace_header.find("uint64_t temp_storage_bytes") !=
                std::string::npos,
        "GPU CUDA reductions module must own scalar reduction workspace state");
    check(
        reduction_workspace_memory_header.find("GPU CUDA scalar reduction workspace memory module header") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("GPU CUDA scalar reduction workspace memory source contract") !=
                std::string::npos &&
            cmake.find("gpu/cuda/reductions/reduction_workspace_memory.cpp") !=
                std::string::npos &&
            reduction_workspace_memory_header.find("bool gpu_reduction_workspace_allocate(") !=
                std::string::npos &&
            reduction_workspace_memory_header.find("void gpu_reduction_workspace_free(") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("bool gpu_reduction_workspace_allocate(") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("void gpu_reduction_workspace_free(") !=
                std::string::npos,
        "GPU CUDA reductions module must own scalar reduction workspace memory helpers");
    check(
        gpu_state_header.find("#include \"gpu/cuda/reductions/reduction_workspace_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuReductionWorkspaceDeviceState reductions{}") !=
                std::string::npos &&
            gpu_state_header.find("double *scalar_reduce_workspace = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("double *scalar_reduce_result = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("void *scalar_reduce_temp_storage = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("uint64_t scalar_reduce_temp_storage_bytes = 0") ==
                std::string::npos,
        "FemGpuState must store scalar reduction buffers through an explicit reductions substate");
    check(
        gpu_state_source.find("#include \"gpu/cuda/reductions/reduction_workspace_memory.hpp\"") !=
                std::string::npos &&
            gpu_state_source.find("gpu_reduction_workspace_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_reduction_workspace_free(") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("reductions.scalar_workspace") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("reductions.scalar_result") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("reductions.host_scalar_result") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("cudaHostAlloc") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("cudaFreeHost") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("reductions.temp_storage") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("reductions.temp_storage_bytes") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("fullmag_cuda_device_max(") !=
                std::string::npos &&
            reduction_workspace_memory_source.find("fullmag_cuda_device_sum(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.reductions.scalar_workspace") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.reductions.scalar_result") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_bytes(\n            &state.reductions.temp_storage") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.reductions.scalar_workspace)") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.reductions.scalar_result)") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_bytes(state.reductions.temp_storage)") ==
                std::string::npos &&
            gpu_state_source.find("fullmag_cuda_device_max(") == std::string::npos &&
            gpu_state_source.find("fullmag_cuda_device_sum(") == std::string::npos,
        "GPU state lifecycle must delegate scalar reduction workspace memory to reductions module");
    for (const std::string *source : {&error_norm_source, &demag_stage_source}) {
        check(
            source->find("gpu.reductions.scalar_workspace") != std::string::npos &&
                source->find("gpu.reductions.scalar_result") != std::string::npos &&
                source->find("gpu.reductions.temp_storage") != std::string::npos &&
                source->find("gpu.reductions.temp_storage_bytes") != std::string::npos &&
                source->find("gpu.scalar_reduce_workspace") == std::string::npos &&
                source->find("gpu.scalar_reduce_result") == std::string::npos &&
                source->find("gpu.scalar_reduce_temp_storage") == std::string::npos,
            "GPU scalar reduction consumers must use the reductions substate");
    }
    check(
        step_stats_source.find("gpu.reductions.scalar_result") != std::string::npos &&
            step_stats_source.find("gpu.reductions.temp_storage") !=
                std::string::npos &&
            step_stats_source.find("gpu.scalar_reduce_result") == std::string::npos &&
            step_stats_source.find("gpu.scalar_reduce_temp_storage") == std::string::npos,
        "GPU final scalar stats must read scalar results through the reductions substate");
}


void gpu_magnetoelastic_strain_is_owned_by_cuda_magnetoelastic_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string magnetoelastic_state_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_state.hpp");
    const std::string magnetoelastic_memory_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_memory.hpp");
    const std::string magnetoelastic_memory_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_memory.cpp");
    const std::string magnetoelastic_upload_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_upload.hpp");
    const std::string magnetoelastic_upload_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_upload.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string rk_plan_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_plan.cpp");
    const std::string magnetoelastic_field_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetoelastic_field.cu");
    const std::string magnetoelastic_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetoelastic_energy_reductions.cu");

    check(
        magnetoelastic_state_header.find("GPU CUDA magnetoelastic device-state module header") !=
                std::string::npos &&
            magnetoelastic_state_header.find("struct FemGpuMagnetoelasticDeviceState") !=
                std::string::npos &&
            magnetoelastic_state_header.find("double *strain_voigt") !=
                std::string::npos &&
            magnetoelastic_state_header.find("uint64_t strain_voigt_len") !=
                std::string::npos &&
            magnetoelastic_state_header.find("bool strain_uploaded") !=
                std::string::npos,
        "GPU CUDA magnetoelastic module must own per-node prescribed strain device state");
    check(
        magnetoelastic_memory_header.find("GPU CUDA magnetoelastic memory module header") !=
                std::string::npos &&
            magnetoelastic_memory_source.find("GPU CUDA magnetoelastic memory source contract") !=
                std::string::npos &&
            magnetoelastic_memory_header.find("bool gpu_magnetoelastic_allocate(") !=
                std::string::npos &&
            magnetoelastic_memory_header.find("void gpu_magnetoelastic_free(") !=
                std::string::npos &&
            magnetoelastic_memory_source.find("bool gpu_magnetoelastic_allocate(") !=
                std::string::npos &&
            magnetoelastic_memory_source.find("void gpu_magnetoelastic_free(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/interactions/magnetoelastic/magnetoelastic_memory.cpp") !=
                std::string::npos,
        "GPU CUDA magnetoelastic module must own prescribed strain memory helpers");
    check(
        magnetoelastic_upload_header.find("GPU CUDA magnetoelastic upload module header") !=
                std::string::npos &&
            magnetoelastic_upload_source.find("GPU CUDA magnetoelastic upload source contract") !=
                std::string::npos &&
            magnetoelastic_upload_header.find("bool gpu_magnetoelastic_upload_strain(") !=
                std::string::npos &&
            magnetoelastic_upload_source.find("bool gpu_magnetoelastic_upload_strain(") !=
                std::string::npos &&
            cmake.find("gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp") !=
                std::string::npos,
        "GPU CUDA magnetoelastic module must own prescribed strain upload");
    check(
        gpu_state_header.find("#include \"gpu/cuda/interactions/magnetoelastic/magnetoelastic_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuMagnetoelasticDeviceState magnetoelastic{}") !=
                std::string::npos &&
            gpu_state_header.find("double *mel_strain_voigt = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("uint64_t mel_strain_voigt_len = 0") ==
                std::string::npos &&
            gpu_state_header.find("bool mel_strain_uploaded = false") ==
                std::string::npos,
        "FemGpuState must store magnetoelastic strain through an explicit magnetoelastic substate");
    check(
        gpu_state_source.find("gpu_magnetoelastic_upload_strain(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_magnetoelastic_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_magnetoelastic_free(") !=
                std::string::npos &&
            gpu_state_source.find("state.lifecycle") != std::string::npos &&
            gpu_state_source.find("state.magnetoelastic") != std::string::npos &&
            magnetoelastic_memory_source.find("magnetoelastic.strain_voigt") !=
                std::string::npos &&
            magnetoelastic_upload_source.find("magnetoelastic.strain_voigt") !=
                std::string::npos &&
            magnetoelastic_upload_source.find("magnetoelastic.strain_voigt_len") !=
                std::string::npos &&
            magnetoelastic_upload_source.find("magnetoelastic.strain_uploaded") !=
                std::string::npos &&
            gpu_state_source.find("cudaMemcpy(state.magnetoelastic.strain_voigt") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.magnetoelastic.strain_voigt") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.magnetoelastic.strain_voigt)") ==
                std::string::npos &&
            gpu_state_source.find("state.magnetoelastic.strain_voigt_len") !=
                std::string::npos &&
            gpu_state_source.find("state.magnetoelastic.strain_uploaded") !=
                std::string::npos &&
            gpu_state_source.find("state.mel_strain_voigt") == std::string::npos,
        "GPU state upload/allocation must use the magnetoelastic substate");
    check(
        rk_plan_source.find("ctx.gpu_state.device.magnetoelastic.strain_uploaded") !=
                std::string::npos &&
            rk_plan_source.find("ctx.gpu_state.device.magnetoelastic.strain_voigt_len") !=
                std::string::npos &&
            rk_plan_source.find("ctx.gpu_state.device.mel_strain_uploaded") ==
                std::string::npos,
        "GPU RK magnetoelastic planner must use the magnetoelastic substate");
    for (const std::string *source : {&magnetoelastic_field_source, &magnetoelastic_energy_source}) {
        check(
            source->find("gpu.magnetoelastic.strain_voigt") != std::string::npos &&
                source->find("gpu.magnetoelastic.strain_voigt_len") !=
                    std::string::npos &&
                source->find("gpu.magnetoelastic.strain_uploaded") !=
                    std::string::npos &&
                source->find("gpu.mel_strain_voigt") == std::string::npos &&
                source->find("gpu.mel_strain_uploaded") == std::string::npos,
        "GPU RK magnetoelastic plan, field, and energy paths must use the magnetoelastic substate");
    }
}


void gpu_local_interaction_workspace_is_owned_by_cuda_interactions_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string workspace_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "local_interaction_workspace_state.hpp");
    const std::string workspace_memory_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "local_interaction_workspace_memory.hpp");
    const std::string workspace_memory_source =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "local_interaction_workspace_memory.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string dmi_field_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_fields.cu");
    const std::string dmi_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_energy_reductions.cu");
    const std::string zhang_li_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_zhang_li_torque.cu");

    check(
        workspace_header.find("GPU CUDA local interaction workspace device-state module header") !=
                std::string::npos &&
            workspace_header.find("struct FemGpuLocalInteractionWorkspaceDeviceState") !=
                std::string::npos &&
            workspace_header.find("FemGpuComponentField vector") !=
                std::string::npos &&
            workspace_header.find("double *node_weight") != std::string::npos,
        "GPU CUDA interactions module must own shared local-interaction workspace state");
    check(
        workspace_memory_header.find("GPU CUDA local interaction workspace memory module header") !=
                std::string::npos &&
            workspace_memory_source.find("GPU CUDA local interaction workspace memory source contract") !=
                std::string::npos &&
            cmake.find("gpu/cuda/interactions/local_interaction_workspace_memory.cpp") !=
                std::string::npos &&
            workspace_memory_header.find("bool gpu_local_interaction_workspace_allocate(") !=
                std::string::npos &&
            workspace_memory_header.find("void gpu_local_interaction_workspace_free(") !=
                std::string::npos &&
            workspace_memory_source.find("bool gpu_local_interaction_workspace_allocate(") !=
                std::string::npos &&
            workspace_memory_source.find("void gpu_local_interaction_workspace_free(") !=
                std::string::npos,
        "GPU CUDA interactions module must own local-interaction workspace memory helpers");
    check(
        gpu_state_header.find("#include \"gpu/cuda/interactions/local_interaction_workspace_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuLocalInteractionWorkspaceDeviceState local_interactions{}") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuComponentField zhang_li_rhs") ==
                std::string::npos &&
            gpu_state_header.find("double *zhang_li_node_weight = nullptr") ==
                std::string::npos,
        "FemGpuState must store DMI/STT local workspace through an explicit local-interactions substate");
    check(
        gpu_state_source.find("state.local_interactions") !=
                std::string::npos &&
            gpu_state_source.find("gpu_local_interaction_workspace_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_local_interaction_workspace_free(") !=
                std::string::npos &&
            workspace_memory_source.find("local_interactions.vector") !=
                std::string::npos &&
            workspace_memory_source.find("local_interactions.node_weight") !=
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_component(state.local_interactions.vector") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_double(state.local_interactions.node_weight") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_component(state.local_interactions.vector") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_double(state.local_interactions.node_weight") ==
                std::string::npos &&
            gpu_state_source.find("state.zhang_li_rhs") == std::string::npos &&
            gpu_state_source.find("state.zhang_li_node_weight") == std::string::npos,
        "GPU state allocation/destroy must use the local-interactions substate");
    for (const std::string *source : {&dmi_field_source, &dmi_energy_source, &zhang_li_source}) {
        check(
            source->find("gpu.local_interactions.vector.x") != std::string::npos &&
                source->find("gpu.local_interactions.vector.y") !=
                    std::string::npos &&
                source->find("gpu.local_interactions.vector.z") !=
                    std::string::npos &&
                source->find("gpu.zhang_li_rhs") == std::string::npos,
            "GPU DMI and Zhang-Li consumers must use the local-interactions vector workspace");
    }
    check(
        zhang_li_source.find("gpu.local_interactions.node_weight") !=
                std::string::npos &&
            zhang_li_source.find("gpu.zhang_li_node_weight") == std::string::npos,
        "GPU Zhang-Li torque must use the local-interactions nodal weight workspace");
}


} // namespace

int main() {
    gpu_mesh_geometry_is_owned_by_cuda_mesh_module();
    gpu_field_buffers_are_owned_by_cuda_fields_module();
    gpu_magnetization_state_is_owned_by_cuda_state_module();
    gpu_residency_state_is_owned_by_cuda_state_module();
    gpu_lifecycle_state_is_owned_by_cuda_state_module();
    gpu_device_memory_helpers_are_owned_by_cuda_state_module();
    gpu_scalar_reduction_workspace_is_owned_by_cuda_reductions_module();
    gpu_magnetoelastic_strain_is_owned_by_cuda_magnetoelastic_module();
    gpu_local_interaction_workspace_is_owned_by_cuda_interactions_module();
    return 0;
}
