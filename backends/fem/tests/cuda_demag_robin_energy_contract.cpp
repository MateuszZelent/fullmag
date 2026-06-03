/*
 * cuda_demag_robin_energy_contract.cpp - source contract for strict GPU
 * Poisson-Robin demag energy parity.
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
    const std::string cpu_recovery =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_recovery.cpp");
    const std::string gpu_rk_stats_publication =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step_stats_publication.cpp");

    check(
        cpu_recovery.find("ctx.demag.cached_robin_boundary_energy") != std::string::npos &&
            cpu_recovery.find("demag_energy += ctx.demag.cached_robin_boundary_energy") !=
                std::string::npos,
        "CPU Poisson-Robin demag energy must add the cached boundary correction");
    check(
        gpu_rk_stats_publication.find("ctx.demag.cached_robin_boundary_energy") !=
            std::string::npos,
        "strict GPU final demag energy must add the same Poisson-Robin boundary correction");
    check(
        gpu_rk_stats_publication.find("stats.demag_energy_joules = demag_energy") !=
            std::string::npos,
        "strict GPU final stats must publish the corrected demag energy variable");
    check(
        gpu_rk_stats_publication.find("exchange_energy + demag_energy + external_energy") !=
            std::string::npos,
        "strict GPU total energy must use the corrected demag energy variable");

    return 0;
}
