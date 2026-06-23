/*
 * source_facade_gpu_rk_contract.cpp - native FEM source-facade ownership docs.
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

void gpu_rk_workspace_is_owned_by_cuda_rk_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
    const std::string workspace_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_workspace_state.hpp");
    const std::string workspace_memory_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_workspace_memory.hpp");
    const std::string workspace_memory_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_workspace_memory.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string attempt_setup_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_setup.cu");
    const std::string refresh_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");
    const std::string adaptive_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_runtime.cu");
    const std::string rk23_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk23_stage_sequence.cu");

    check(
        workspace_header.find("GPU CUDA RK workspace device-state module header") !=
                std::string::npos &&
            workspace_header.find("FEM_GPU_MAX_RK_STAGES") != std::string::npos &&
            workspace_header.find("struct FemGpuRkWorkspaceDeviceState") !=
                std::string::npos &&
            workspace_header.find("FemGpuComponentField m_backup") !=
                std::string::npos &&
            workspace_header.find("FemGpuComponentField m_stage") !=
                std::string::npos &&
            workspace_header.find("FemGpuComponentField error") !=
                std::string::npos &&
            workspace_header.find("std::array<FemGpuComponentField, FEM_GPU_MAX_RK_STAGES> k{}") !=
                std::string::npos &&
            workspace_header.find("bool fsal_valid = false") !=
                std::string::npos,
        "GPU CUDA RK module must own RK workspace device state");
    check(
        workspace_memory_header.find("GPU CUDA RK workspace memory module header") !=
                std::string::npos &&
            workspace_memory_source.find("GPU CUDA RK workspace memory source contract") !=
                std::string::npos &&
            cmake.find("gpu/cuda/integrators/rk/rk_workspace_memory.cpp") !=
                std::string::npos &&
            workspace_memory_header.find("bool gpu_rk_workspace_allocate(") !=
                std::string::npos &&
            workspace_memory_header.find("void gpu_rk_workspace_free(") !=
                std::string::npos &&
            workspace_memory_source.find("bool gpu_rk_workspace_allocate(") !=
                std::string::npos &&
            workspace_memory_source.find("void gpu_rk_workspace_free(") !=
                std::string::npos,
        "GPU CUDA RK module must own RK workspace memory helpers");
    check(
        gpu_state_header.find("#include \"gpu/cuda/integrators/rk/rk_workspace_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuRkWorkspaceDeviceState rk{}") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuComponentField m_backup") ==
                std::string::npos &&
            gpu_state_header.find("FemGpuComponentField m_stage") ==
                std::string::npos &&
            gpu_state_header.find("FemGpuComponentField error") ==
                std::string::npos &&
            gpu_state_header.find("std::array<FemGpuComponentField, FEM_GPU_MAX_RK_STAGES> k{}") ==
                std::string::npos &&
            gpu_state_header.find("bool fsal_valid = false") == std::string::npos,
        "FemGpuState must store RK scratch, stages, error, and FSAL state through the RK substate");
    check(
        gpu_state_source.find("state.rk") != std::string::npos &&
            gpu_state_source.find("state.rk.fsal_valid") != std::string::npos &&
            gpu_state_source.find("gpu_rk_workspace_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_rk_workspace_free(") !=
                std::string::npos &&
            workspace_memory_source.find("rk.m_backup") != std::string::npos &&
            workspace_memory_source.find("rk.m_stage") != std::string::npos &&
            workspace_memory_source.find("rk.error") != std::string::npos &&
            workspace_memory_source.find("rk.k") != std::string::npos &&
            gpu_state_source.find("gpu_device_allocate_component(state.rk") ==
                std::string::npos &&
            gpu_state_source.find("gpu_device_free_component(state.rk") ==
                std::string::npos,
        "GPU state allocation/reset/destroy must use the RK workspace substate");
    check(
        attempt_setup_source.find("gpu.rk.m_backup") != std::string::npos &&
            attempt_setup_source.find("gpu.rk.m_stage") != std::string::npos &&
            attempt_setup_source.find("gpu.rk.k") != std::string::npos &&
            attempt_setup_source.find("gpu.m_backup") == std::string::npos &&
            attempt_setup_source.find("gpu.m_stage") == std::string::npos &&
            attempt_setup_source.find("gpu.k[") == std::string::npos,
        "GPU RK attempt setup must use the RK workspace substate");
    check(
        refresh_source.find("gpu.rk.error") != std::string::npos &&
            refresh_source.find("gpu.rk.k[0]") != std::string::npos &&
            refresh_source.find("gpu.rk.fsal_valid") != std::string::npos &&
            refresh_source.find("gpu.error") == std::string::npos &&
            refresh_source.find("gpu.k[") == std::string::npos &&
            refresh_source.find("gpu.fsal_valid") == std::string::npos,
        "GPU RK final refresh must use the RK workspace substate");
    check(
        adaptive_source.find("gpu.rk.m_backup") != std::string::npos &&
            adaptive_source.find("gpu.rk.fsal_valid") != std::string::npos &&
            adaptive_source.find("gpu.m_backup") == std::string::npos &&
            adaptive_source.find("gpu.fsal_valid") == std::string::npos,
        "GPU RK adaptive restore must use the RK workspace substate");
    check(
        rk23_source.find("gpu.rk.m_stage") != std::string::npos &&
            rk23_source.find("gpu.rk.k") != std::string::npos &&
            rk23_source.find("gpu.rk.fsal_valid") != std::string::npos &&
            rk23_source.find("gpu.m_stage") == std::string::npos &&
            rk23_source.find("gpu.k[") == std::string::npos &&
            rk23_source.find("gpu.fsal_valid") == std::string::npos,
        "GPU RK stage sequences must use the RK workspace substate");
}


void gpu_exchange_kernels_are_owned_by_cuda_exchange_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string exchange_header =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_kernels.hpp");
    const std::string exchange_source =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_kernels.cu");

    check(
        cmake.find("gpu/cuda/exchange/exchange_kernels.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU exchange CUDA kernels from gpu/cuda/exchange");
    check(
        exchange_header.find("GPU CUDA exchange kernels module header") !=
                std::string::npos &&
            exchange_header.find("fullmag_cuda_legacy_sparse_exchange(") !=
                std::string::npos &&
            exchange_header.find("fullmag_cuda_legacy_sparse_exchange_energy_blocks(") !=
                std::string::npos,
        "GPU CUDA exchange kernels header must own legacy sparse exchange wrapper declarations");
    check(
        exchange_header.find("H_ex = -2 M_lumped^-1 K_A m / (mu0 Ms)") !=
                std::string::npos &&
            exchange_header.find("E_ex = sum_i m_i . (K_A m)_i") !=
                std::string::npos &&
            exchange_header.find("does not implement the CPU/MFEM consistent-mass projection policy") !=
                std::string::npos &&
            exchange_header.find("Nonmagnetic FEM nodes are skipped") !=
                std::string::npos,
        "GPU CUDA exchange kernels header must document field sign, energy convention, lumped projection, and masking");
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
    const std::string external_energy_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_external_energy_reductions.hpp");
    const std::string zeeman_kernel_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "zeeman" / "zeeman_kernels.hpp");
    const std::string exchange_dispatch_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.hpp");
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
    const std::string field_metric_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_field_metric_reductions.hpp");
    const std::string magnetization_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetization_reductions.hpp");
    const std::string stats_fallback =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cpp");
    const std::string stats_publication_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats_publication.hpp");
    const std::string stats_publication_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats_publication.cpp");
    const std::string stats_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");
    const std::string energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_energy_reductions.cu");
    const std::string exchange_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_energy_reductions.cu");
    const std::string external_energy_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_external_energy_reductions.cu");
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
    const std::string field_metric_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_field_metric_reductions.cu");
    const std::string magnetization_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_magnetization_reductions.cu");

    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_stats.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final stats no-CUDA fallback from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_step_stats_publication.cpp") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK final stats publication from gpu/cuda/integrators/rk");
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
        cmake.find("gpu/cuda/integrators/rk/rk_external_energy_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK external final energy reductions from gpu/cuda/integrators/rk");
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
        cmake.find("gpu/cuda/integrators/rk/rk_field_metric_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK field metric final reductions from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk_magnetization_reductions.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK magnetization final reductions from gpu/cuda/integrators/rk");
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
            stats_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats_publication.hpp\"") !=
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
            stats_source.find("gpu_rk_publish_final_step_stats(ctx, scalars, stats)") !=
                std::string::npos,
        "GPU CUDA RK final stats source must delegate reductions, own scalar readback, and delegate stats publication");
    check(
        stats_publication_header.find("GPU CUDA RK final step stats publication module header") !=
                std::string::npos &&
            stats_publication_header.find("gpu_rk_publish_final_step_stats(") !=
                std::string::npos,
        "GPU CUDA RK final stats publication header must document and declare stats publication");
    check(
        stats_publication_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats_publication.hpp\"") !=
                std::string::npos &&
            stats_publication_source.find("GPU CUDA RK final step stats publication source contract") !=
                std::string::npos &&
            stats_publication_source.find("stats.total_energy_joules =") !=
                std::string::npos &&
            stats_publication_source.find("stats.mx = mx_sum / magnetic_count") !=
                std::string::npos &&
            stats_publication_source.find("fill_demag_solver_stats(ctx, stats)") !=
                std::string::npos &&
            stats_publication_source.find("context_update_stage_completion_from_stats(ctx, stats)") !=
                std::string::npos,
        "GPU CUDA RK final stats publication source must own scalar-to-stats publication");
    check(
        stats_source.find("stats.total_energy_joules =") == std::string::npos &&
            stats_source.find("stats.mx = mx_sum / magnetic_count") ==
                std::string::npos &&
            stats_source.find("fill_demag_solver_stats(ctx, stats)") ==
                std::string::npos &&
            stats_source.find("context_update_stage_completion_from_stats(ctx, stats)") ==
                std::string::npos,
        "GPU CUDA RK final stats source must delegate scalar-to-stats publication");
    check(
        stats_publication_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos &&
            stats_publication_source.find("gpu_rk_reduce_final_energy_terms(") ==
                std::string::npos &&
            stats_publication_source.find("gpu_rk_reduce_final_observable_terms(") ==
                std::string::npos,
        "GPU CUDA RK final stats publication source must not own reductions or scalar readback");
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
        exchange_dispatch_header.find("assembled K_A operator") !=
                std::string::npos &&
            exchange_dispatch_header.find("inverse lumped volume mass") !=
                std::string::npos &&
            exchange_dispatch_header.find("same sign convention as CPU lumped exchange projection") !=
                std::string::npos,
        "GPU CUDA RK exchange dispatch header must document device inputs and CPU lumped sign convention");
    check(
        exchange_energy_header.find("E_ex = sum_i m_i . (K_A m)_i") !=
                std::string::npos &&
            exchange_energy_header.find("GPU RK planning requires exchange to be enabled") !=
                std::string::npos &&
            exchange_energy_header.find("does not own CSR upload") !=
                std::string::npos,
        "GPU CUDA RK exchange energy header must document energy convention and uploaded-CSR precondition");
    check(
        external_energy_header.find("GPU CUDA RK external final energy reductions module header") !=
                std::string::npos &&
            external_energy_header.find("gpu_rk_reduce_final_external_energy_terms(") !=
                std::string::npos,
        "GPU CUDA RK external final energy reductions header must document and declare external energy reductions");
    check(
        external_energy_header.find("E_Z = -mu0 sum_i Ms_i (m_i . H_ext_i) w_i") !=
                std::string::npos &&
            external_energy_header.find("The device H_ext buffer is in A/m") !=
                std::string::npos &&
            external_energy_header.find("does not import the plan field, upload H_ext") !=
                std::string::npos,
        "GPU CUDA RK external final energy reductions header must document Zeeman units, energy sign, and ownership boundary");
    check(
        zeeman_kernel_header.find("Device fields use H_ext in A/m and reduced magnetization m") !=
                std::string::npos &&
            zeeman_kernel_header.find("do not apply gamma_mu0, damping, or direct-torque semantics") !=
                std::string::npos &&
            zeeman_kernel_header.find("Nonmagnetic FEM nodes are skipped") !=
                std::string::npos,
        "GPU CUDA Zeeman kernel header must document H_ext units, no torque conversion, and magnetic-node masking");
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
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp\"") !=
                std::string::npos &&
            energy_source.find("GPU CUDA RK final energy reductions source contract") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_exchange_energy_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            energy_source.find("gpu_rk_reduce_final_external_energy_terms(ctx, stream, n, blocks, reason)") !=
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
        external_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp\"") !=
                std::string::npos &&
            external_energy_source.find("#include \"gpu/cuda/integrators/rk/rk_step_stats.hpp\"") !=
                std::string::npos &&
            external_energy_source.find("GPU CUDA RK external final energy reductions source contract") !=
                std::string::npos &&
            external_energy_source.find("ctx.zeeman.has_external_field") !=
                std::string::npos &&
            external_energy_source.find("fullmag_cuda_external_energy_blocks(") !=
                std::string::npos &&
            external_energy_source.find("GpuFinalScalarSlot::ExternalEnergy") !=
                std::string::npos &&
            external_energy_source.find("launch GPU RK external energy blocks") !=
                std::string::npos &&
            external_energy_source.find("launch GPU RK external energy reduction") !=
                std::string::npos &&
            external_energy_source.find("GPU RK external energy requires device-resident Ms, lumped mass, and H_ext") !=
                std::string::npos,
        "GPU CUDA RK external final energy reductions source must own external energy validation, launch, and scalar slot");
    check(
        energy_source.find("fullmag_cuda_external_energy_blocks(") ==
                std::string::npos &&
            energy_source.find("GpuFinalScalarSlot::ExternalEnergy") ==
                std::string::npos &&
            energy_source.find("launch GPU RK external energy blocks") ==
                std::string::npos &&
            energy_source.find("launch GPU RK external energy reduction") ==
                std::string::npos &&
            energy_source.find("GPU RK external energy requires device-resident Ms, lumped mass, and H_ext") ==
                std::string::npos,
        "GPU CUDA RK final energy reductions source must delegate external energy internals");
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
            anisotropy_energy_source.find("GPU RK uniaxial anisotropy energy requires device-resident Ms, Ku, Ku2, anisotropy axis, lumped mass, and H_ani buffers") !=
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
            magnetoelastic_energy_source.find("use_per_node_strain ? gpu.magnetoelastic.strain_voigt : nullptr") !=
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
        field_metric_header.find("GPU CUDA RK field metric final reductions module header") !=
                std::string::npos &&
            field_metric_header.find("gpu_rk_reduce_final_field_metric_terms(") !=
                std::string::npos,
        "GPU CUDA RK field metric reductions header must document and declare field metric reductions");
    check(
        magnetization_header.find("GPU CUDA RK magnetization final reductions module header") !=
                std::string::npos &&
            magnetization_header.find("gpu_rk_reduce_final_magnetization_terms(") !=
                std::string::npos,
        "GPU CUDA RK magnetization reductions header must document and declare magnetization reductions");
    check(
        observable_source.find("#include \"gpu/cuda/integrators/rk/rk_observable_reductions.hpp\"") !=
                std::string::npos &&
            observable_source.find("#include \"gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp\"") !=
                std::string::npos &&
            observable_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetization_reductions.hpp\"") !=
                std::string::npos &&
            observable_source.find("GPU CUDA RK final observable reductions source contract") !=
                std::string::npos &&
            observable_source.find("gpu_rk_reduce_final_field_metric_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos &&
            observable_source.find("gpu_rk_reduce_final_magnetization_terms(ctx, stream, n, blocks, reason)") !=
                std::string::npos,
        "GPU CUDA RK final observable reductions source must delegate field metrics and magnetization reductions");
    check(
        field_metric_source.find("#include \"gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp\"") !=
                std::string::npos &&
            field_metric_source.find("GPU CUDA RK field metric final reductions source contract") !=
                std::string::npos &&
            field_metric_source.find("fullmag_cuda_field_metric_blocks(") !=
                std::string::npos &&
            field_metric_source.find("GpuFinalScalarSlot::MaxHEff") !=
                std::string::npos &&
            field_metric_source.find("GpuFinalScalarSlot::MaxHDemag") !=
                std::string::npos &&
            field_metric_source.find("GpuFinalScalarSlot::MaxTorque") !=
                std::string::npos &&
            field_metric_source.find("launch GPU RK max H_eff reduction") !=
                std::string::npos &&
            field_metric_source.find("launch GPU RK max torque reduction") !=
                std::string::npos,
        "GPU CUDA RK field metric reductions source must own field and torque metric reductions");
    check(
        magnetization_source.find("#include \"gpu/cuda/integrators/rk/rk_magnetization_reductions.hpp\"") !=
                std::string::npos &&
            magnetization_source.find("GPU CUDA RK magnetization final reductions source contract") !=
                std::string::npos &&
            magnetization_source.find("fullmag_cuda_magnetization_sum_blocks(") !=
                std::string::npos &&
            magnetization_source.find("GpuFinalScalarSlot::MxSum") !=
                std::string::npos &&
            magnetization_source.find("GpuFinalScalarSlot::MySum") !=
                std::string::npos &&
            magnetization_source.find("GpuFinalScalarSlot::MzSum") !=
                std::string::npos &&
            magnetization_source.find("GpuFinalScalarSlot::MagneticCount") !=
                std::string::npos &&
            magnetization_source.find("launch GPU RK magnetic count reduction") !=
                std::string::npos,
        "GPU CUDA RK magnetization reductions source must own average magnetization reductions");
    check(
        observable_source.find("fullmag_cuda_field_metric_blocks(") == std::string::npos &&
            observable_source.find("fullmag_cuda_magnetization_sum_blocks(") ==
                std::string::npos &&
            observable_source.find("GpuFinalScalarSlot::MaxTorque") ==
                std::string::npos &&
            observable_source.find("GpuFinalScalarSlot::MagneticCount") ==
                std::string::npos &&
            observable_source.find("launch GPU RK max H_eff reduction") ==
                std::string::npos &&
            observable_source.find("launch GPU RK magnetic count reduction") ==
                std::string::npos,
        "GPU CUDA RK final observable reductions source must delegate observable reduction internals");
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
            refresh_source.find("gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH") !=
                std::string::npos &&
            refresh_source.find("gpu.residency.device_state = FemGpuSyncState::DeviceDirty") !=
                std::string::npos &&
            refresh_source.find("gpu.residency.host_state = FemGpuSyncState::HostStale") !=
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
    const std::string rk4_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk4_stage_sequence.hpp");
    const std::string rk4_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk4_stage_sequence.cu");
    const std::string rk23_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk23_stage_sequence.hpp");
    const std::string rk23_source =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk23_stage_sequence.cu");
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
        cmake.find("gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.cu") ==
            std::string::npos,
        "FEM CMake source list must not build removed GPU RK4/RK23 compatibility stage sequence");
    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk4_rk23_stage_sequence.hpp") &&
            !std::filesystem::exists(root / "gpu" / "cuda" / "integrators" / "rk" / "rk4_rk23_stage_sequence.cu"),
        "GPU CUDA RK4/RK23 compatibility files must be removed after per-integrator owners exist");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk4_stage_sequence.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK4 stage sequence from gpu/cuda/integrators/rk");
    check(
        cmake.find("gpu/cuda/integrators/rk/rk23_stage_sequence.cu") !=
            std::string::npos,
        "FEM CMake source list must build GPU RK23 stage sequence from gpu/cuda/integrators/rk");
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
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk4_stage_sequence.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_run_rk4_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)") !=
                std::string::npos &&
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk23_stage_sequence.hpp\"") !=
                std::string::npos &&
            schedule_source.find("gpu_rk_run_rk23_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)") !=
                std::string::npos &&
            schedule_source.find("#include \"gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.hpp\"") ==
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
            attempt_setup_source.find("fsal_reused = fsal_method && gpu.rk.fsal_valid") !=
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
        rk4_header.find("GPU CUDA RK4 stage sequence module header") !=
                std::string::npos &&
            rk4_header.find("gpu_rk_run_rk4_stage_sequence(") !=
                std::string::npos,
        "GPU CUDA RK4 stage sequence header must document and declare the RK4 sequence");
    check(
        rk4_source.find("#include \"gpu/cuda/integrators/rk/rk4_stage_sequence.hpp\"") !=
                std::string::npos &&
            rk4_source.find("GPU CUDA RK4 stage sequence source contract") !=
                std::string::npos &&
            rk4_source.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            rk4_source.find("fullmag_cuda_rk4_accept(") !=
                std::string::npos &&
            rk4_source.find("fullmag_cuda_bs23_accept(") ==
                std::string::npos &&
            rk4_source.find("launch GPU RK stage-2 h_eff accumulation") !=
                std::string::npos &&
            rk4_source.find("launch GPU RK stage-3 h_eff accumulation") !=
                std::string::npos &&
            rk4_source.find("stage_rhs_evaluations += 1") !=
                std::string::npos,
        "GPU CUDA RK4 stage sequence source must own RK4 predictors, RHS evaluations, and RK4 accept");
    check(
        rk23_header.find("GPU CUDA RK23 BS23 stage sequence module header") !=
                std::string::npos &&
            rk23_header.find("gpu_rk_run_rk23_stage_sequence(") !=
                std::string::npos,
        "GPU CUDA RK23 stage sequence header must document and declare the BS23 sequence");
    check(
        rk23_source.find("#include \"gpu/cuda/integrators/rk/rk23_stage_sequence.hpp\"") !=
                std::string::npos &&
            rk23_source.find("GPU CUDA RK23 BS23 stage sequence source contract") !=
                std::string::npos &&
            rk23_source.find("fullmag_cuda_euler_stage(") !=
                std::string::npos &&
            rk23_source.find("fullmag_cuda_bs23_accept(") !=
                std::string::npos &&
            rk23_source.find("fullmag_cuda_rk4_accept(") ==
                std::string::npos &&
            rk23_source.find("launch GPU RK stage-2 h_eff accumulation") !=
                std::string::npos &&
            rk23_source.find("stage_rhs_evaluations += 1") !=
                std::string::npos,
        "GPU CUDA RK23 stage sequence source must own BS23 predictor, RHS evaluation, and BS23 accept");
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
            schedule_source.find("fsal_reused = fsal_method && gpu.rk.fsal_valid") ==
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
        rk4_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            rk4_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            rk4_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            rk4_source.find("fullmag_cuda_bs23_accept(") == std::string::npos &&
            rk4_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            rk4_source.find("fullmag_cuda_dp54_accept(") == std::string::npos &&
            rk4_source.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            rk4_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos,
        "GPU CUDA RK4 stage sequence source must not own step orchestration, adaptive policy, accepted-step finalization, BS23, RK45, Heun, or BS23 adaptive k3 internals");
    check(
        rk23_source.find("bool gpu_rk_device_resident_step(") == std::string::npos &&
            rk23_source.find("gpu_rk_adaptive_pi_step(") == std::string::npos &&
            rk23_source.find("gpu_rk_finalize_accepted_step(") == std::string::npos &&
            rk23_source.find("fullmag_cuda_rk4_accept(") == std::string::npos &&
            rk23_source.find("fullmag_cuda_rk45_stage(") == std::string::npos &&
            rk23_source.find("fullmag_cuda_dp54_accept(") == std::string::npos &&
            rk23_source.find("fullmag_cuda_heun_accept(") == std::string::npos &&
            rk23_source.find("launch GPU RK23 BS23 k3 for adaptive error estimate") ==
                std::string::npos,
        "GPU CUDA RK23 stage sequence source must not own step orchestration, adaptive policy, accepted-step finalization, RK4, RK45, Heun, or BS23 adaptive k3 internals");
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
    const std::string demag_state_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "demag_state.hpp");
    const std::string gpu_state_header =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(root / "gpu" / "cuda" / "state" / "gpu_state.cpp");
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
        demag_state_header.find("GPU CUDA Poisson demag device-state module header") !=
                std::string::npos &&
            demag_state_header.find("struct FemGpuDemagPoissonDeviceState") !=
                std::string::npos &&
            demag_state_header.find("double *poisson_rhs") != std::string::npos &&
            demag_state_header.find("double *poisson_solution") !=
                std::string::npos &&
            demag_state_header.find("FemGpuComponentField poisson_gradient") !=
                std::string::npos &&
            demag_state_header.find("std::vector<double> hybrid_stage_m_xyz") !=
                std::string::npos &&
            demag_state_header.find("std::vector<double> hybrid_demag_xyz") !=
                std::string::npos &&
            demag_state_header.find("double hybrid_demag_energy_joules") !=
                std::string::npos,
        "GPU CUDA Poisson demag module must own device Poisson and hybrid compatibility state");
    check(
        gpu_state_header.find("#include \"gpu/cuda/demag_poisson/demag_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuDemagPoissonDeviceState demag_poisson{}") !=
                std::string::npos &&
            gpu_state_header.find("double *poisson_rhs = nullptr") ==
                std::string::npos &&
            gpu_state_header.find("std::vector<double> hybrid_demag_xyz") ==
                std::string::npos,
        "FemGpuState must store Poisson demag device state through an explicit demag substate");
    check(
        gpu_state_source.find("state.demag_poisson.poisson_rhs") !=
                std::string::npos &&
            gpu_state_source.find("state.demag_poisson.poisson_solution") !=
                std::string::npos &&
            gpu_state_source.find("state.demag_poisson.poisson_gradient") !=
                std::string::npos &&
            gpu_state_source.find("state.demag_poisson.hybrid_stage_m_xyz") !=
                std::string::npos &&
            gpu_state_source.find("state.demag_poisson.hybrid_demag_xyz") !=
                std::string::npos &&
            gpu_state_source.find("state.poisson_rhs") == std::string::npos &&
            gpu_state_source.find("state.hybrid_demag_xyz") == std::string::npos,
        "GPU state allocation, destroy, and metadata reset must use the Poisson demag substate");
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
        hypre_solver.find("HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE)") !=
                std::string::npos &&
            hypre_solver.find("HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE)") !=
                std::string::npos &&
            hypre_solver.find("HYPRE_SetSpTransUseVendor(1)") !=
                std::string::npos &&
            hypre_solver.find("HYPRE_SetSpMVUseVendor(1)") !=
                std::string::npos &&
            hypre_solver.find("HYPRE_SetSpGemmUseVendor(1)") !=
                std::string::npos &&
            hypre_solver.find("HYPRE_ClearAllErrors()") !=
                std::string::npos &&
            hypre_solver.find("HYPRE_SetSpGemmUseVendor(1) failed") ==
                std::string::npos,
        "GPU CUDA Poisson demag Hypre solver setup must best-effort enable public device vendor sparse kernels");
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
        stage_compute.find("gpu.demag_poisson.poisson_rhs") != std::string::npos &&
            stage_compute.find("gpu.demag_poisson.poisson_solution") !=
                std::string::npos &&
            stage_compute.find("gpu.poisson_rhs") == std::string::npos,
        "GPU CUDA Poisson demag stage compute must use the Poisson demag device substate");
    check(
        module.find("does not own public DSL semantics, MFEM context construction, RK stage orchestration, exchange, local interaction kernels, or C ABI entrypoints") !=
            std::string::npos,
        "GPU CUDA Poisson demag module must document its non-owning module boundary");
}


} // namespace

int main() {
    gpu_rk_workspace_is_owned_by_cuda_rk_module();
    gpu_exchange_kernels_are_owned_by_cuda_exchange_module();
    gpu_rk_planning_is_owned_by_cuda_rk_module();
    gpu_rk_step_is_owned_by_cuda_rk_module();
    gpu_rk_step_preflight_is_owned_by_cuda_rk_module();
    gpu_rk_snapshot_is_owned_by_cuda_rk_module();
    gpu_rk_step_stats_is_owned_by_cuda_rk_module();
    gpu_rk_final_refresh_is_owned_by_cuda_rk_module();
    gpu_rk_stage_schedule_is_owned_by_cuda_rk_module();
    gpu_demag_poisson_is_owned_by_cuda_demag_poisson_module();
    return 0;
}
