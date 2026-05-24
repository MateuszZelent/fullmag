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
    const std::string gpu_rk_stats =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats.cu");
    const std::string gpu_rk_demag_energy =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_energy_reductions.cu");

    check(
        gpu_stage.find("ctx.poisson_demag.step_solver_apply_wall_time_ns += solver_apply_wall_time_ns") !=
            std::string::npos,
        "strict GPU demag stage must accumulate Hypre solver apply wall time for the step");
    check(
        gpu_rk_demag_energy.find("#include \"gpu/cuda/demag_poisson/stage_compute.hpp\"") !=
            std::string::npos,
        "strict GPU RK demag final energy reductions must include the demag stage compute declarations");
    check(
        gpu_rk_stats.find("demag_timings.solver_apply_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns") !=
            std::string::npos,
        "strict GPU RK final stats must publish measured demag solver apply wall time");
    check(
        gpu_rk_stats.find("fill_demag_poisson_phase_stats(demag_timings, stats)") !=
            std::string::npos,
        "strict GPU RK final stats must use the Poisson timing stats publisher");

    return 0;
}
