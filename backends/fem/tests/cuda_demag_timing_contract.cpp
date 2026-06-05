/*
 * cuda_demag_timing_contract.cpp - source contract for strict GPU Poisson
 * demag solver timing telemetry.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

} // namespace

int main()
{
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_stage =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string gpu_rk_stats_publication =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats_publication.cpp");
    const std::string gpu_rk_stats =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");
    const std::string gpu_runtime =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.hpp");
    const std::string gpu_rk_demag_energy =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_energy_reductions.cu");

    check(
        gpu_stage.find("ctx.poisson_demag.step_solver_apply_wall_time_ns += solver_apply_wall_time_ns") !=
            std::string::npos,
        "strict GPU demag stage must accumulate Hypre solver apply wall time for the step");
    check(
        gpu_stage.find("GPU Poisson demag assemble phase timing") != std::string::npos &&
            gpu_stage.find("timings.demag_assemble_events") != std::string::npos,
        "strict GPU demag stage must record device RHS assembly timing events");
    check(
        gpu_stage.find("GPU Poisson demag recover phase timing") != std::string::npos &&
            gpu_stage.find("timings.demag_recover_events") != std::string::npos,
        "strict GPU demag stage must record device recovery timing events");
    check(
        gpu_stage.find("GPU Poisson demag energy phase timing") != std::string::npos &&
            gpu_stage.find("timings.demag_energy_events") != std::string::npos,
        "strict GPU demag stage must record device energy timing events");
    check(
        gpu_stage.find("cudaEventSynchronize") == std::string::npos &&
            gpu_stage.find("cudaDeviceSynchronize") == std::string::npos,
        "strict GPU demag phase timing must not add hot-loop synchronization");
    check(
        gpu_stage.find("cudaEventRecord(workspace->compute_ready_event, stream)") !=
                std::string::npos &&
            gpu_stage.find("cudaStreamWaitEvent(nullptr, workspace->compute_ready_event, 0)") !=
                std::string::npos &&
            gpu_stage.find("workspace->solver->Mult(*workspace->b_par, *workspace->x_par)") !=
                std::string::npos &&
            gpu_stage.find("cudaEventRecord(workspace->hypre_done_event, nullptr)") !=
                std::string::npos &&
            gpu_stage.find("cudaStreamWaitEvent(stream, workspace->hypre_done_event, 0)") !=
                std::string::npos,
        "strict GPU demag Hypre boundary must remain an explicit event bridge between compute and MFEM/Hypre streams");
    check(
        gpu_stage.find("cudaStreamSynchronize") == std::string::npos,
        "strict GPU demag stage must not use host-blocking stream synchronization");
    check(
        gpu_runtime.find("demag_assemble_events") != std::string::npos &&
            gpu_runtime.find("demag_recover_events") != std::string::npos &&
            gpu_runtime.find("demag_energy_events") != std::string::npos,
        "GPU RK timing runtime must own prepared demag timing event pools");
    check(
        gpu_rk_stats.find("GPU RK demag assemble phase timing pool") != std::string::npos &&
            gpu_rk_stats.find("GPU RK demag recover phase timing pool") != std::string::npos &&
            gpu_rk_stats.find("GPU RK demag energy phase timing pool") != std::string::npos,
        "GPU RK timing preparation must allocate demag phase event pools before the hot loop");
    check(
        gpu_rk_stats.find("ctx.poisson_demag.step_assemble_wall_time_ns") != std::string::npos &&
            gpu_rk_stats.find("ctx.poisson_demag.step_recover_wall_time_ns") != std::string::npos &&
            gpu_rk_stats.find("ctx.poisson_demag.step_energy_wall_time_ns") != std::string::npos,
        "GPU RK timing collection must publish demag subphase timings to Poisson runtime state");
    check(
        gpu_rk_demag_energy.find("#include \"gpu/cuda/demag_poisson/stage_compute.hpp\"") !=
            std::string::npos,
        "strict GPU RK demag final energy reductions must include the demag stage compute declarations");
    check(
        gpu_rk_stats_publication.find("demag_timings.assemble_wall_time_ns = ctx.poisson_demag.step_assemble_wall_time_ns") !=
                std::string::npos &&
            gpu_rk_stats_publication.find("demag_timings.solver_apply_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns") !=
                std::string::npos &&
            gpu_rk_stats_publication.find("demag_timings.recover_wall_time_ns = ctx.poisson_demag.step_recover_wall_time_ns") !=
                std::string::npos &&
            gpu_rk_stats_publication.find("demag_timings.energy_wall_time_ns = ctx.poisson_demag.step_energy_wall_time_ns") !=
                std::string::npos,
        "strict GPU RK final stats must publish measured demag subphase wall times");
    check(
        gpu_rk_stats_publication.find(
            "demag_timings.assemble_wall_time_ns +\n                demag_timings.solve_wall_time_ns +\n                demag_timings.recover_wall_time_ns +\n                demag_timings.energy_wall_time_ns") !=
                std::string::npos,
        "strict GPU RK final stats must publish demag wall time as subphase sum");
    check(
        gpu_rk_stats_publication.find("fill_demag_poisson_phase_stats(demag_timings, stats)") !=
                std::string::npos,
        "strict GPU RK final stats must use the Poisson timing stats publisher");

    return 0;
}
