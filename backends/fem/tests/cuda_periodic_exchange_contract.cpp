/*
 * cuda_periodic_exchange_contract.cpp - source contract for strict GPU
 * periodic lumped exchange projection.
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
    const std::string exchange_plan =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_plan.cpp");
    const std::string exchange_kernels =
        read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_kernels.cu");
    const std::string exchange_dispatch = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");

    check(
        exchange_plan.find("periodic reduced-node exchange yet") == std::string::npos,
        "strict GPU exchange planner must not reject periodic reduced-node maps");
    check(
        exchange_kernels.find("periodic_legacy_sparse_exchange_kernel") !=
                std::string::npos &&
            exchange_kernels.find("reduced_km += km") != std::string::npos &&
            exchange_kernels.find("reduced_mass += lumped_mass[source_row]") !=
                std::string::npos,
        "strict GPU exchange must implement CPU-style periodic lumped projection");
    check(
        exchange_dispatch.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            exchange_dispatch.find("fullmag_cuda_periodic_legacy_sparse_exchange") !=
                std::string::npos,
        "strict GPU RK exchange dispatch must select the periodic exchange kernel");

    return 0;
}
