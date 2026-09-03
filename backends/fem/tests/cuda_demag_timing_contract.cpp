/*
 * cuda_demag_timing_contract.cpp - source contract for strict GPU Poisson
 * demag solver timing telemetry.
 */

#include <algorithm>
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
    std::string text = buffer.str();
    text.erase(std::remove(text.begin(), text.end(), '\r'), text.end());
    return text;
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
    const std::string hypre_stream_interop =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_stream_interop.cpp");
    const std::string hypre_stream_interop_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_stream_interop.hpp");
    const std::string hypre_validation_policy =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_validation_policy.cpp");
    const std::string gpu_fem_bem =
        read_text_file(root / "gpu" / "cuda" / "demag_fem_bem" / "fem_bem.cpp");
    const std::string gpu_rk_stats_publication =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats_publication.cpp");
    const std::string gpu_rk_stats =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");
    const std::string gpu_runtime =
        read_text_file(root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.hpp");
    const std::string gpu_rk_demag_energy =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_energy_reductions.cu");
    const std::string poisson_runtime = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_poisson_runtime.hpp");

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
        gpu_stage.find("hypre_wait_for_fullmag(") <
                gpu_stage.find("workspace->solver->Mult(*workspace->b_par, *workspace->x_par)") &&
            gpu_stage.find("fullmag_wait_for_hypre(") >
                gpu_stage.find("workspace->solver->Mult(*workspace->b_par, *workspace->x_par)"),
        "strict GPU demag stage must delegate producer/consumer ordering to the exact Hypre stream adapter");
    check(
        hypre_stream_interop.find("#include <mfem/config/_config.hpp>") <
            hypre_stream_interop.find("defined(MFEM_USE_MPI)"),
        "strict GPU demag stream adapter must load MFEM feature macros before testing MFEM_USE_MPI");
    check(
        hypre_stream_interop.find("HYPRE_RELEASE_NUMBER == 30100") !=
                std::string::npos &&
            hypre_stream_interop.find("MFEM_VERSION != 40900") !=
                std::string::npos &&
            hypre_stream_interop.find("cudaEventRecord(interop.fullmag_ready, fullmag_stream)") !=
                std::string::npos &&
            hypre_stream_interop.find("cudaStreamWaitEvent(interop.hypre_stream, interop.fullmag_ready, 0)") !=
                std::string::npos &&
            hypre_stream_interop.find("cudaEventRecord(interop.hypre_done, interop.hypre_stream)") !=
                std::string::npos &&
            hypre_stream_interop.find("cudaStreamWaitEvent(fullmag_stream, interop.hypre_done, 0)") !=
                std::string::npos,
        "strict GPU demag stream adapter must be version-pinned and order the exact Hypre stream with CUDA events");
    check(
        hypre_stream_interop_header.find("struct HypreStreamLease") !=
                std::string::npos &&
            hypre_stream_interop_header.find("fullmag_ready") !=
                std::string::npos &&
            hypre_stream_interop_header.find("hypre_done") !=
                std::string::npos &&
            hypre_stream_interop_header.find("hypre_validation_done") ==
                std::string::npos,
        "strict GPU demag stream interop must expose a typed lease with input and output events");
    check(
        hypre_stream_interop.find("cudaStreamWaitEvent(nullptr") ==
                std::string::npos &&
            hypre_stream_interop.find(
                "mfem_default_stream_wait_for_hypre_validation") ==
                std::string::npos,
        "strict GPU demag validation must not assume the CUDA default stream");
    check(
        hypre_stream_interop_header.find("HypreApplyTimingEventPair") !=
                std::string::npos &&
            hypre_stream_interop_header.find("apply_timing_events") !=
                std::string::npos &&
            hypre_stream_interop_header.find("apply_device_elapsed_time_ns") !=
                std::string::npos,
        "strict GPU demag stream adapter must own a separate prepared HYPRE apply device-timing pool");
    check(
        hypre_stream_interop.find("cudaEventRecord(event.start_event, interop.hypre_stream)") !=
                std::string::npos &&
            hypre_stream_interop.find("cudaEventRecord(event.stop_event, interop.hypre_stream)") !=
                std::string::npos &&
            hypre_stream_interop.find("cudaEventElapsedTime(") !=
                std::string::npos,
        "strict GPU demag stream adapter must measure HYPRE apply device elapsed time on the borrowed HYPRE stream");
    check(
        gpu_stage.find("begin_hypre_apply_device_timing(") <
                gpu_stage.find("workspace->solver->Mult(*workspace->b_par, *workspace->x_par)") &&
            gpu_stage.find("end_hypre_apply_device_timing(") >
                gpu_stage.find("workspace->solver->Mult(*workspace->b_par, *workspace->x_par)"),
        "strict GPU demag stage must bracket HYPRE Mult with device timing events");
    check(
        gpu_stage.find("fullmag.demag.wait_in_enqueue") != std::string::npos &&
            gpu_stage.find("fullmag.demag.hypre_mult_host") != std::string::npos &&
            gpu_stage.find("fullmag.demag.hypre_device") != std::string::npos &&
            gpu_stage.find("fullmag.demag.wait_out_enqueue") != std::string::npos,
        "strict GPU demag stage must expose disjoint HYPRE enqueue, host and device ranges");
    check(
        hypre_stream_interop.find("const bool measure_enqueue = interop.apply_timing_enabled") !=
                std::string::npos &&
            hypre_stream_interop.find(
                "interop.last_wait_in_enqueue_wall_time_ns = measure_enqueue") !=
                std::string::npos &&
            hypre_stream_interop.find(
                "interop.last_wait_out_enqueue_wall_time_ns = measure_enqueue") !=
                std::string::npos,
        "HYPRE dependency timing must measure CPU enqueue calls only when profiling is enabled");
    check(
        gpu_stage.find("cudaStreamSynchronize(hypre_stream)") == std::string::npos &&
            gpu_stage.find("cudaDeviceSynchronize") == std::string::npos &&
            hypre_stream_interop.find("cudaStreamSynchronize") == std::string::npos &&
            hypre_stream_interop.find("cudaDeviceSynchronize") == std::string::npos,
        "strict GPU demag solve and stream adapter must not use host-blocking HYPRE or device-wide synchronization");
    check(
        hypre_stream_interop.find("cudaEventSynchronize") == std::string::npos,
        "strict GPU demag HYPRE device timing must be collected only after the existing final stats synchronization boundary");
    check(
        gpu_fem_bem.find("cudaStreamSynchronize") == std::string::npos &&
            gpu_fem_bem.find("record_mfem_host_sync") == std::string::npos &&
            gpu_fem_bem.find("hypre_wait_for_fullmag(") <
                gpu_fem_bem.find("system.solver->Mult(*system.b_par, *system.x_par)") &&
            gpu_fem_bem.find("fullmag_wait_for_hypre(") !=
                std::string::npos &&
            gpu_fem_bem.find("close_hypre_dependency(true)") >
                gpu_fem_bem.find("system.solver->Mult(*system.b_par, *system.x_par)"),
        "FEM/BEM HYPRE solves must use bidirectional event dependencies without host fences");
    check(
        hypre_validation_policy.find("should_validate_independent_residual") !=
                std::string::npos &&
            gpu_fem_bem.find("should_validate_independent_residual(") !=
                std::string::npos &&
            gpu_fem_bem.find("HYPRE_ParVectorAxpy") !=
                std::string::npos &&
            gpu_fem_bem.find("HYPRE_ParVectorInnerProd") !=
                std::string::npos,
        "FEM/BEM must use conditional residual validation on the exact HYPRE stream");
    for (const char *field : {
             "step_hypre_wait_in_enqueue_wall_time_ns",
             "step_hypre_host_api_wall_time_ns",
             "step_solver_apply_device_wall_time_ns",
             "step_hypre_wait_out_enqueue_wall_time_ns",
             "step_hypre_event_wait_count",
             "step_hypre_timed_solve_count",
         }) {
        check(
            poisson_runtime.find(field) != std::string::npos,
            "Poisson runtime must own every separated HYPRE timing counter");
    }
    check(
        gpu_rk_stats.find("step_hypre_timed_solve_count = 0") != std::string::npos &&
            gpu_rk_stats.find("context_hypre_apply_timed_solve_count(ctx)") != std::string::npos,
        "profile-off reset and profile-on timed solve count must both be explicit");
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
            gpu_rk_stats.find("ctx.poisson_demag.step_solver_apply_device_wall_time_ns") != std::string::npos &&
            gpu_rk_stats.find("ctx.poisson_demag.step_recover_wall_time_ns") != std::string::npos &&
            gpu_rk_stats.find("ctx.poisson_demag.step_energy_wall_time_ns") != std::string::npos,
        "GPU RK timing collection must publish demag subphase timings to Poisson runtime state");
    check(
        gpu_rk_demag_energy.find("#include \"gpu/cuda/demag_poisson/demag_kernels.hpp\"") !=
                std::string::npos &&
            gpu_rk_demag_energy.find("#include \"gpu/cuda/demag_poisson/stage_compute.hpp\"") ==
                std::string::npos,
        "strict GPU RK demag energy reductions must depend on demag kernels without coupling to stage orchestration");
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
