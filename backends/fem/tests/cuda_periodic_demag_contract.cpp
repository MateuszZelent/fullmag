/*
 * cuda_periodic_demag_contract.cpp - source contract for strict GPU
 * periodic Poisson demag enablement.
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
    const std::string gpu_operators =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "operators.cpp");
    const std::string gpu_hypre =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");

    check(
        gpu_operators.find("strict FEM GPU demag does not support periodic Poisson demag yet") ==
            std::string::npos,
        "strict GPU Poisson demag must not reject periodic_node_pairs");
    check(
        gpu_operators.find("periodic_scalar_row_count(ctx)") != std::string::npos &&
            gpu_operators.find("periodic_scalar_column(ctx, col)") != std::string::npos,
        "strict GPU Poisson demag CSR builders must reduce scalar potential rows/columns by periodic classes");
    check(
        gpu_operators.find("reduce_sparse_matrix_by_periodic_classes") != std::string::npos,
        "strict GPU Poisson-Robin boundary energy must use a periodic reduced boundary mass");
    check(
        gpu_hypre.find("ctx.poisson_demag.periodic_matrix") != std::string::npos &&
            gpu_hypre.find("demag_periodic_poisson_reduction_requested(ctx)") !=
                std::string::npos,
        "strict GPU Hypre demag solver must use the periodic reduced Poisson matrix for PBC");

    return 0;
}
