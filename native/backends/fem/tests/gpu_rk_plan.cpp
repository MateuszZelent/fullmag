#include "context.hpp"
#include "gpu/cuda/exchange/exchange_plan.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

static void check(bool condition, const char *msg) {
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

void gpu_rk_audit04_demag_and_dmi_contracts_are_source_visible() {
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_rk_plan =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_plan.cpp");
    const std::string gpu_rk_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk.hpp");
    const std::string gpu_rk_snapshot =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_snapshot.cu");
    const std::string gpu_rk_rhs =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.cu");
    const std::string gpu_rk_demag_dispatch =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_dispatch.cu");
    const std::string gpu_rk_dmi_fields =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_fields.cu");
    const std::string gpu_rk_llg_rhs_dispatch =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_llg_rhs_dispatch.cu");
    const std::string llg_kernels =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "llg" / "llg_rhs_kernels.cu");
    const std::string llg_kernels_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "llg" / "llg_rhs_kernels.hpp");
    const std::string dmi_kernels =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.cu");
    const std::string dmi_kernels_header =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.hpp");
    const std::string snapshot =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.cpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");
    const std::string effective =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.cpp");

    check(
        !std::filesystem::exists(root / "gpu" / "cuda" / "kernels" / "kernels.hpp"),
        "legacy CUDA kernels compatibility umbrella must stay removed");
    check(
        gpu_rk_plan.find("does not support demag yet") == std::string::npos,
        "GPU RK plan must not hard-block demag now that hybrid CPU-demag upload is supported");
    check(
        gpu_rk_header.find("GpuRkPlan gpu_rk_plan_device_resident(") != std::string::npos,
        "GPU RK header must expose the device-resident planner name");
    check(
        gpu_rk_plan.find("GpuRkPlan gpu_rk_plan_device_resident(") != std::string::npos,
        "GPU RK source must define the device-resident planner name");
    check(
        gpu_rk_header.find("gpu_rk_plan_exchange_only") == std::string::npos &&
            gpu_rk_plan.find("gpu_rk_plan_exchange_only") == std::string::npos,
        "legacy exchange-only GPU RK planner wrapper must be removed from internal API");
    check(
        gpu_rk_demag_dispatch.find("compute_device_demag_for_device_stage") != std::string::npos,
        "GPU RK demag dispatch must compute strict demag through the device Hypre Poisson stage path");
    check(
        gpu_rk_snapshot.find("bool gpu_rk_snapshot_current_state(") != std::string::npos,
        "strict FEM GPU compute_fields/snapshot must reuse the device RHS/finalize path");
    check(
        snapshot.find("strict_gpu_snapshot_path(ctx)") != std::string::npos &&
            snapshot.find("gpu_rk_snapshot_current_state(ctx, stats, error)") != std::string::npos,
        "MFEM snapshot_stats must route strict FEM GPU snapshots through the GPU path");
    check(
        state_io.find("strict_gpu_demag_upload_path(ctx)") != std::string::npos,
        "strict FEM GPU magnetization upload must not refresh H_eff through the CPU Poisson path");
    check(
        effective.find("FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON") != std::string::npos,
        "strict FEM GPU startup must not refresh initial H_eff through the CPU Poisson path");
    check(
        gpu_rk_demag_dispatch.find("FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON") != std::string::npos,
        "hybrid CPU Poisson demag must remain an explicitly named compatibility mode");
    const auto rhs_pos = gpu_rk_rhs.find("bool gpu_rk_compute_rhs_for_magnetization");
    check(rhs_pos != std::string::npos, "GPU RK RHS runtime source must expose gpu_rk_compute_rhs_for_magnetization");
    const auto rhs_source = gpu_rk_rhs.substr(rhs_pos);
    check(
        rhs_source.find("gpu_rk_compute_demag_for_device_stage(ctx, m, stream, reason)") != std::string::npos &&
            gpu_rk_demag_dispatch.find("compute_device_demag_for_device_stage") != std::string::npos &&
            gpu_rk_demag_dispatch.find("gpu_rk_compute_hybrid_cpu_demag_for_device_stage") != std::string::npos,
        "RHS demag must delegate to a demag dispatch module that chooses strict device Poisson by default and reserves hybrid CPU Poisson for explicit compatibility mode");
    check(
        gpu_rk_dmi_fields.find("fullmag_cuda_dmi_field_energy(") != std::string::npos &&
            gpu_rk_dmi_fields.find("fullmag_cuda_dmi_field_energy_serial(") == std::string::npos,
        "GPU RK must call the parallel DMI kernel wrapper, not the serial placeholder");
    check(
        dmi_kernels_header.find("fullmag_cuda_dmi_field_energy(") != std::string::npos &&
            dmi_kernels_header.find("fullmag_cuda_dmi_field_energy_serial(") == std::string::npos,
        "CUDA DMI module headers must expose only the parallel DMI field/energy wrapper");
    check(
        dmi_kernels.find("dmi_field_energy_serial_kernel") == std::string::npos &&
            dmi_kernels.find("<<<1, 1") == std::string::npos,
        "CUDA DMI implementation must not contain the one-thread serial element-loop kernel");
    check(
        dmi_kernels.find("dmi_element_residual_kernel") != std::string::npos &&
            dmi_kernels.find("dmi_atomic_add_double(&residual_x") != std::string::npos,
        "CUDA DMI implementation must use per-element parallel residual accumulation with atomics");
    check(
        llg_kernels_header.find("bool precession_enabled") != std::string::npos &&
            llg_kernels.find("bool precession_enabled") != std::string::npos,
        "CUDA LLG RHS wrapper and kernel must expose the native precession mode contract");
    check(
        gpu_rk_rhs.find("gpu_rk_compute_llg_rhs(ctx, m, rhs, stream, n, reason)") != std::string::npos &&
            gpu_rk_llg_rhs_dispatch.find("ctx.base_plan.precession_enabled") != std::string::npos,
        "GPU RK RHS must delegate to LLG RHS dispatch that passes the imported native FEM precession mode into the CUDA kernel");
}

} // namespace

int main() {
    gpu_rk_audit04_demag_and_dmi_contracts_are_source_visible();

    {
        fullmag::fem::FemGpuState unallocated;
        fullmag::fem::TransferAudit audit;
        std::string sync_error;
        std::vector<double> unchanged{1.0};
        check(
            fullmag::fem::gpu_state_download_magnetization_aos(
                unallocated,
                unchanged,
                audit,
                sync_error),
            "unallocated FemGpuState magnetization readback should be a no-op");
        check(
            unchanged.size() == 1 && unchanged[0] == 1.0,
            "unallocated FemGpuState readback should not mutate the host vector");
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    {
        fullmag::fem::FemGpuState gpu;
        fullmag::fem::TransferAudit audit;
        std::string sync_error;
        const double initial_m[] = {
            1.0, 0.0, 0.0,
            0.0, 1.0, 0.0,
        };
        check(
            fullmag::fem::gpu_state_initialize(
                gpu,
                2,
                FULLMAG_FEM_INTEGRATOR_HEUN,
                true,
                false,
                initial_m,
                6,
                audit,
                sync_error),
            "FemGpuState test allocation failed");
        gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
        gpu.host_state = fullmag::fem::FemGpuSyncState::HostStale;
        gpu.device_state = fullmag::fem::FemGpuSyncState::DeviceDirty;

        std::vector<double> downloaded;
        check(
            fullmag::fem::gpu_state_download_magnetization_aos(
                gpu,
                downloaded,
                audit,
                sync_error),
            "device-source FemGpuState magnetization readback failed");
        check(downloaded.size() == 6, "downloaded magnetization length mismatch");
        for (size_t i = 0; i < downloaded.size(); ++i) {
            check(
                std::abs(downloaded[i] - initial_m[i]) < 1e-14,
                "downloaded magnetization component mismatch");
        }
        check(
            gpu.host_state == fullmag::fem::FemGpuSyncState::HostClean,
            "readback should mark host magnetization clean");
        check(
            gpu.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
            "readback must preserve device source of truth");
        fullmag::fem::gpu_state_destroy(gpu);
    }
#endif

    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 8;
    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    ctx.exchange.enabled = true;
    ctx.demag.enabled = false;
    ctx.gpu_state.device.initialized = true;
    ctx.gpu_state.device.node_count = 8;
    ctx.gpu_state.device.dof_len = 24;
    ctx.gpu_state.device.stage_count = 2;
    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = false;
    ctx.gpu_state.legacy_exchange.lumped_mass_ready = false;

    std::string reason;
    const auto no_allocation = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(!no_allocation.enabled, "GPU RK must not enable without allocated FemGpuState");
    check(reason.find("FemGpuState") != std::string::npos, "missing FemGpuState rejection reason");

    ctx.gpu_state.device.allocated = true;
    ctx.demag.enabled = true;
    reason.clear();
    const auto with_demag = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(!with_demag.enabled, "GPU RK with demag must remain blocked until exchange/demag prerequisites are ready");
    check(
        reason.find("does not support demag yet") == std::string::npos,
        "GPU RK must not reject demag as unsupported after hybrid CPU-demag upload support");

    ctx.demag.enabled = false;
    auto require_blocked = [&](const fullmag::fem::Context &blocked_ctx,
                               const char *reason_fragment,
                               const char *message) {
        reason.clear();
        auto ready_ctx = blocked_ctx;
        ready_ctx.gpu_state.device.initialized = true;
        ready_ctx.gpu_state.device.allocated = true;
        ready_ctx.gpu_state.device.node_count = ctx.mesh.n_nodes;
        ready_ctx.gpu_state.device.dof_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
        ready_ctx.gpu_state.device.stage_count = fullmag::fem::gpu_rk_stage_count(ready_ctx.base_plan.integrator);
        const auto blocked = fullmag::fem::gpu_rk_plan_device_resident(ready_ctx, reason);
        check(!blocked.enabled, message);
        if (reason.find(reason_fragment) == std::string::npos) {
            std::fprintf(
                stderr,
                "FAIL: missing expected block reason '%s' in '%s'\n",
                reason_fragment,
                reason.c_str());
            std::exit(1);
        }
    };

    {
        auto blocked = ctx;
        blocked.dmi.interfacial_enabled = true;
        require_blocked(
            blocked,
            "device-resident mesh geometry",
            "GPU RK device-resident path must reject DMI without device mesh geometry");
    }
    {
        auto blocked = ctx;
        blocked.dmi.interfacial_enabled = true;
        blocked.gpu_state.device.mesh_geometry_uploaded = true;
        blocked.gpu_state.device.mesh_element_count = ctx.mesh.n_elements;
        reason.clear();
        const auto dmi_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            dmi_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with device interfacial DMI");
        check(
            reason.find("DMI") == std::string::npos,
            "GPU RK device-resident path must not reject interfacial DMI after device residual support");
    }
    {
        auto blocked = ctx;
        blocked.dmi.bulk_enabled = true;
        blocked.gpu_state.device.mesh_geometry_uploaded = true;
        blocked.gpu_state.device.mesh_element_count = ctx.mesh.n_elements;
        reason.clear();
        const auto dmi_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            dmi_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with device bulk DMI");
        check(
            reason.find("bulk DMI") == std::string::npos,
            "GPU RK device-resident path must not reject bulk DMI after device residual support");
    }
    {
        auto blocked = ctx;
        blocked.zeeman.has_external_field = true;
        reason.clear();
        const auto external_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            external_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with external field");
        check(
            reason.find("external field") == std::string::npos,
            "GPU RK device-resident path must not reject uniform external field after device energy support");
    }
    {
        auto blocked = ctx;
        blocked.anisotropy.uniaxial_enabled = true;
        blocked.anisotropy.uniaxial_Ku = 1.0;
        reason.clear();
        const auto anisotropy_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            anisotropy_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with uniaxial anisotropy");
        check(
            reason.find("anisotropy") == std::string::npos,
            "GPU RK device-resident path must not reject uniaxial anisotropy after device field/energy support");
    }
    {
        auto blocked = ctx;
        blocked.anisotropy.cubic_enabled = true;
        blocked.anisotropy.cubic_Kc1 = 1.0;
        reason.clear();
        const auto cubic_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            cubic_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with cubic anisotropy");
        check(
            reason.find("cubic anisotropy") == std::string::npos,
            "GPU RK device-resident path must not reject cubic anisotropy after device field/energy support");
    }
    {
        auto blocked = ctx;
        blocked.stt.slonczewski_enabled = true;
        blocked.stt.current_density_am2 = {1.0e11, 0.0, 0.0};
        blocked.stt.spin_polarization = {0.0, 0.0, 1.0};
        blocked.mesh.nodes_xyz.assign({
            0.0, 0.0, 0.0,
            2.0e-9, 0.0, 0.0,
            0.0, 1.0e-9, 0.0,
            2.0e-9, 1.0e-9, 0.0,
            0.0, 0.0, 1.0e-9,
            2.0e-9, 0.0, 1.0e-9,
            0.0, 1.0e-9, 1.0e-9,
            2.0e-9, 1.0e-9, 1.0e-9,
        });
        blocked.base_plan.hmax = 0.5e-9;
        reason.clear();
        const auto geometric_slonczewski_plan =
            fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            geometric_slonczewski_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with geometry-derived Slonczewski thickness");
        check(
            reason.find("free-layer thickness") == std::string::npos,
            "GPU RK device-resident path must not reject geometry-derived Slonczewski free-layer thickness");
    }
    {
        auto blocked = ctx;
        blocked.stt.slonczewski_enabled = true;
        require_blocked(
            blocked,
            "free-layer thickness",
            "GPU RK device-resident path must reject Slonczewski STT without explicit or geometry-derived free-layer thickness");
    }
    {
        auto blocked = ctx;
        blocked.stt.slonczewski_enabled = true;
        blocked.stt.current_density_am2 = {1.0e11, 0.0, 0.0};
        blocked.stt.spin_polarization = {0.0, 0.0, 1.0};
        blocked.stt.free_layer_thickness = 1.0e-9;
        reason.clear();
        const auto slonczewski_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            slonczewski_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with explicit Slonczewski STT");
        check(
            reason.find("Slonczewski") == std::string::npos,
            "GPU RK device-resident path must not reject Slonczewski STT after device RHS support");
    }
    {
        auto blocked = ctx;
        blocked.stt.zhang_li_enabled = true;
        require_blocked(
            blocked,
            "device-resident mesh geometry",
            "GPU RK device-resident path must reject Zhang-Li STT without device mesh geometry");
    }
    {
        auto blocked = ctx;
        blocked.stt.zhang_li_enabled = true;
        blocked.gpu_state.device.mesh_geometry_uploaded = true;
        blocked.gpu_state.device.mesh_element_count = ctx.mesh.n_elements;
        reason.clear();
        const auto zhang_li_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            zhang_li_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with device Zhang-Li STT");
        check(
            reason.find("Zhang-Li") == std::string::npos,
            "GPU RK device-resident path must not reject Zhang-Li STT after device geometry support");
    }
    {
        auto blocked = ctx;
        blocked.oersted.has_explicit_field = true;
        require_blocked(blocked, "Oersted", "GPU RK device-resident path must reject Oersted field");
    }
    {
        auto blocked = ctx;
        blocked.oersted.has_explicit_field = true;
        blocked.oersted.h_xyz.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
        reason.clear();
        const auto oersted_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            oersted_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with precomputed Oersted field");
        check(
            reason.find("Oersted") == std::string::npos,
            "GPU RK device-resident path must not reject precomputed Oersted field after device accumulation support");
    }
    {
        auto blocked = ctx;
        blocked.magnetoelastic.enabled = true;
        blocked.magnetoelastic.uniform_strain = false;
        blocked.magnetoelastic.strain_voigt.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 6u, 0.0);
        require_blocked(
            blocked,
            "device-resident per-node magnetoelastic strain",
            "GPU RK device-resident path must reject per-node magnetoelastic strain without device upload");
    }
    {
        auto blocked = ctx;
        blocked.magnetoelastic.enabled = true;
        blocked.magnetoelastic.uniform_strain = false;
        blocked.magnetoelastic.strain_voigt.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 6u, 0.0);
        blocked.gpu_state.device.mel_strain_uploaded = true;
        blocked.gpu_state.device.mel_strain_voigt_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 6ull;
        reason.clear();
        const auto mel_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            mel_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with uploaded per-node magnetoelastic strain");
        check(
            reason.find("magnetoelastic") == std::string::npos,
            "GPU RK device-resident path must not reject uploaded per-node magnetoelastic strain after device support");
    }
    {
        auto blocked = ctx;
        blocked.magnetoelastic.enabled = true;
        blocked.magnetoelastic.uniform_strain = true;
        blocked.magnetoelastic.strain_voigt.assign(6u, 0.0);
        reason.clear();
        const auto mel_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            mel_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with uniform magnetoelastic strain");
        check(
            reason.find("magnetoelastic") == std::string::npos,
            "GPU RK device-resident path must not reject uniform magnetoelastic strain after device field/energy support");
    }
    {
        auto blocked = ctx;
        blocked.thermal_brown.temperature = 300.0;
        require_blocked(
            blocked,
            "thermal seed",
            "GPU RK device-resident path must reject thermal field without deterministic seed");
    }
    {
        auto blocked = ctx;
        blocked.thermal_brown.temperature = 300.0;
        blocked.thermal_brown.seed = 1234;
        reason.clear();
        const auto thermal_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            thermal_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with deterministic thermal field");
        check(
            reason.find("thermal") == std::string::npos,
            "GPU RK device-resident path must not reject deterministic thermal field after device RNG support");
    }
    {
        auto blocked = ctx;
        blocked.material_fields.alpha_field.assign(
            static_cast<size_t>(ctx.mesh.n_nodes),
            ctx.material_fields.material.damping);
        reason.clear();
        const auto damping_plan = fullmag::fem::gpu_rk_plan_device_resident(blocked, reason);
        check(
            damping_plan.stage_count == 2,
            "GPU RK device-resident path should preserve Heun stages with per-node damping");
        check(
            reason.find("per-node damping") == std::string::npos,
            "GPU RK device-resident path must not reject per-node damping after device alpha support");
    }
    {
        auto blocked = ctx;
        blocked.magnetoelastic.enabled = true;
        require_blocked(blocked, "magnetoelastic", "GPU RK device-resident path must reject magnetoelastic field");
    }
    {
        auto blocked = ctx;
        blocked.mesh.periodic_reduced_node.push_back(0);
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
        require_blocked(blocked, "periodic", "GPU RK device-resident path must reject PBC");
#else
        require_blocked(blocked, "CUDA", "non-CUDA smoke should reject before PBC operator planning");
#endif
    }
#if FULLMAG_HAS_MFEM_STACK
    {
        auto blocked = ctx;
        blocked.exchange.mfem.use_consistent_mass = true;
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
        require_blocked(blocked, "consistent-mass", "GPU RK device-resident path must reject consistent mass");
#else
        require_blocked(blocked, "CUDA", "non-CUDA smoke should reject before consistent-mass operator planning");
#endif
    }
#endif

    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_RK4;
    reason.clear();
    const auto rk4_plan = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(rk4_plan.stage_count == 4, "RK4 should request four GPU RK stages");
    check(
        reason.find("Heun only") == std::string::npos,
        "GPU RK plan must not reject RK4 as a Heun-only integrator");
    check(!rk4_plan.enabled, "RK4 GPU RK must stay blocked until device stage exchange is ready");

    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_RK23_BS;
    ctx.adaptive_dt.enabled = false;
    reason.clear();
    const auto rk23_plan = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(rk23_plan.stage_count == 4, "RK23 should request four GPU RK stages");
    check(
        reason.find("Heun only") == std::string::npos,
        "GPU RK plan must not reject RK23 as a Heun-only integrator");
    check(!rk23_plan.enabled, "fixed-step RK23 GPU RK must stay blocked until device stage exchange is ready");

    {
        auto adaptive = ctx;
        adaptive.adaptive_dt.enabled = true;
        reason.clear();
        const auto adaptive_rk23_plan = fullmag::fem::gpu_rk_plan_device_resident(adaptive, reason);
        check(adaptive_rk23_plan.stage_count == 4, "adaptive RK23 should keep four GPU RK stages");
        check(
            reason.find("adaptive RK23/RK45") == std::string::npos,
            "GPU RK plan must not reject adaptive RK23 once retry scaffold is device-resident");
        check(!adaptive_rk23_plan.enabled, "adaptive RK23 GPU RK must stay blocked until device stage exchange is ready");
    }

    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_RK45_DP54;
    ctx.adaptive_dt.enabled = true;
    reason.clear();
    const auto adaptive_rk45_plan = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(adaptive_rk45_plan.stage_count == 7, "adaptive RK45 should request seven GPU RK stages");
    check(
        reason.find("adaptive RK23/RK45") == std::string::npos,
        "GPU RK plan must not reject adaptive RK45 once retry scaffold is device-resident");
    check(!adaptive_rk45_plan.enabled, "adaptive RK45 GPU RK must stay blocked until device stage exchange is ready");

    ctx.adaptive_dt.enabled = false;
    reason.clear();
    const auto rk45_plan = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(rk45_plan.stage_count == 7, "RK45 should request seven GPU RK stages");
    check(
        reason.find("Heun only") == std::string::npos,
        "GPU RK plan must not reject fixed-step RK45 as a Heun-only integrator");
    check(!rk45_plan.enabled, "fixed-step RK45 GPU RK must stay blocked until device stage exchange is ready");

    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_RK4;
    ctx.adaptive_dt.enabled = false;
    const auto exchange_plan = fullmag::fem::gpu_exchange_plan_stage_exchange(ctx, reason);
    check(
        !exchange_plan.stage_exchange_device_resident,
        "stage exchange must stay blocked until device-resident H_ex is implemented");
    check(reason.find("stage H_ex") != std::string::npos, "missing stage H_ex exchange blocker");
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
    check(
        reason.find("legacy sparse exchange metadata") != std::string::npos,
        "MFEM+CUDA build must first require captured legacy sparse exchange metadata");

    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = true;
    ctx.gpu_state.legacy_exchange.legacy_sparse_rows = 8;
    ctx.gpu_state.legacy_exchange.legacy_sparse_cols = 8;
    ctx.gpu_state.legacy_exchange.legacy_sparse_nnz = 32;
    reason.clear();
    const auto missing_mass_plan = fullmag::fem::gpu_exchange_plan_stage_exchange(ctx, reason);
    check(
        !missing_mass_plan.stage_exchange_device_resident,
        "stage exchange must stay blocked without lumped mass metadata");
    check(
        reason.find("lumped mass") != std::string::npos,
        "MFEM+CUDA build must require lumped mass metadata before GPU exchange");

    ctx.gpu_state.legacy_exchange.lumped_mass_ready = true;
    reason.clear();
    const auto runtime_coefficients_blocked_plan =
        fullmag::fem::gpu_exchange_plan_stage_exchange(ctx, reason);
    check(
        !runtime_coefficients_blocked_plan.stage_exchange_device_resident,
        "stage exchange must stay blocked until runtime coefficients are uploaded");
    check(
        reason.find("runtime coefficients") != std::string::npos,
        "MFEM+CUDA build must require runtime coefficients before GPU exchange");

    ctx.gpu_state.device.runtime_coefficients_uploaded = true;
    reason.clear();
    const auto upload_blocked_plan = fullmag::fem::gpu_exchange_plan_stage_exchange(ctx, reason);
    check(
        !upload_blocked_plan.stage_exchange_device_resident,
        "stage exchange must stay blocked until CSR/mass upload is complete");
    check(
        reason.find("device-resident CSR/mass upload") != std::string::npos,
        "MFEM+CUDA build must expose device-resident CSR/mass upload blocker");

    ctx.gpu_state.device.legacy_exchange.uploaded = true;
    reason.clear();
    ctx.gpu_state.device.legacy_exchange.rows = 8;
    ctx.gpu_state.device.legacy_exchange.cols = 8;
    ctx.gpu_state.device.legacy_exchange.nnz = 32;
    const auto spmv_ready_plan = fullmag::fem::gpu_exchange_plan_stage_exchange(ctx, reason);
    check(
        spmv_ready_plan.stage_exchange_device_resident,
        "stage exchange must enable after device CSR/mass upload is complete");
    check(
        spmv_ready_plan.supports_legacy_sparse_gpu,
        "MFEM+CUDA build must expose legacy sparse GPU exchange support");
    check(
        std::string(spmv_ready_plan.operator_mode) == "legacy_sparse_gpu",
        "MFEM+CUDA build must expose legacy_sparse_gpu operator mode");
    reason.clear();
    const auto rk4_ready_plan = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
    check(rk4_ready_plan.enabled, "MFEM+CUDA build must enable RK4 GPU RK after device stage exchange is ready");
    check(rk4_ready_plan.stage_count == 4, "RK4 ready plan should keep four GPU RK stages");
#endif

    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    reason.clear();
    const auto maybe_supported = fullmag::fem::gpu_rk_plan_device_resident(ctx, reason);
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
    check(maybe_supported.enabled, "MFEM+CUDA build must enable GPU RK after device stage exchange is ready");
    check(maybe_supported.stage_count == 2, "Heun should request two GPU RK stages");
    check(maybe_supported.uses_cuda_kernels, "GPU RK plan must use CUDA kernels");
    check(
        maybe_supported.stage_exchange_device_resident,
        "GPU RK must report stage exchange as device-resident after legacy sparse exchange is ready");
    check(
        std::string(maybe_supported.exchange_operator_mode) == "legacy_sparse_gpu",
        "GPU RK must expose legacy_sparse_gpu exchange operator mode");
#elif FULLMAG_HAS_CUDA_RUNTIME
    check(!maybe_supported.enabled, "CUDA-only build must not enable GPU RK without MFEM stack");
    check(reason.find("MFEM") != std::string::npos, "missing MFEM stack rejection reason");
#else
    check(!maybe_supported.enabled, "no-CUDA build must reject GPU RK plan");
    check(reason.find("CUDA") != std::string::npos, "missing CUDA rejection reason");
#endif

    fullmag_fem_step_stats stats = {};
    reason.clear();
    fullmag::fem::ExplicitTableau tableau = {};
    tableau.stages = 2;
    tableau.b_hi[0] = 0.5;
    tableau.b_hi[1] = 0.5;
    const bool executed = fullmag::fem::gpu_rk_device_resident_step(
        ctx,
        tableau,
        1e-13,
        stats,
        reason);
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
    check(!executed, "MFEM+CUDA smoke lacks real device buffers/source-of-truth and must not execute");
    check(
        reason.find("source of truth") != std::string::npos ||
            reason.find("device buffers") != std::string::npos,
        "missing CUDA step device-state rejection reason");
#elif FULLMAG_HAS_CUDA_RUNTIME
    check(!executed, "CUDA-only build must not execute GPU RK without MFEM stack");
    check(reason.find("MFEM") != std::string::npos, "missing MFEM step rejection reason");
#else
    check(!executed, "no-CUDA build must not execute GPU RK device-resident step");
    check(reason.find("CUDA") != std::string::npos, "missing CUDA step rejection reason");
#endif

    std::printf("FEM gpu_rk_plan smoke PASS\n");
    return 0;
}
