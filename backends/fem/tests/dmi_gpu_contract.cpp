/*
 * dmi_gpu_contract.cpp - source contract for typed GPU DMI evaluation,
 * diagnostics, and energy reduction ownership.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    if (!input) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
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
    const std::string kernels_header = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.hpp");
    const std::string kernels_source = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.cu");
    const std::string field_source = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_dmi_fields.cu");
    const std::string energy_source = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" /
        "rk_dmi_energy_reductions.cu");

    check(
        kernels_header.find("struct DmiApplyRequest") != std::string::npos &&
            kernels_header.find("bool field = false;") != std::string::npos &&
            kernels_header.find("bool energy = false;") != std::string::npos,
        "GPU DMI must expose a typed field/energy apply request");
    check(
        kernels_header.find("struct DmiDiagnostics") != std::string::npos &&
            kernels_header.find("degenerate_tet_count") != std::string::npos &&
            kernels_header.find("nonfinite_count") != std::string::npos,
        "GPU DMI must expose degenerate-tetrahedron and nonfinite counters");

    const std::size_t energy_gate = kernels_source.find("if (request.energy)");
    const std::size_t energy_formula = kernels_source.find("energy = elem_d *", energy_gate);
    check(
        energy_gate != std::string::npos && energy_formula != std::string::npos &&
            energy_gate < energy_formula,
        "GPU DMI energy arithmetic must be guarded by request.energy");
    check(
        kernels_source.find("dmi_atomic_add_double(energy_out") == std::string::npos &&
            kernels_source.find("energy_partials[blockIdx.x]") != std::string::npos,
        "GPU DMI energy must use block partials instead of a global energy atomic");
    check(
        kernels_source.find("dmi_pairwise_sum_in_place") != std::string::npos &&
            energy_source.find("deterministic_reduction") != std::string::npos &&
            energy_source.find("fullmag_cuda_dmi_pairwise_sum(") != std::string::npos,
        "GPU DMI qualification energy must use deterministic pairwise reduction");
    check(
        kernels_source.find("&diagnostics->degenerate_tet_count") !=
                std::string::npos &&
            kernels_source.find("&diagnostics->nonfinite_count") !=
                std::string::npos &&
            kernels_source.find("dmi_fail_closed_kernel") != std::string::npos,
        "GPU DMI invalid geometry and nonfinite results must be counted and fail closed");

    check(
        field_source.find("DmiApplyRequest{true, false}") != std::string::npos &&
            field_source.find("nullptr, // energy_out") != std::string::npos,
        "RK DMI stage evaluation must request field-only work and pass no energy output");
    check(
        energy_source.find("DmiApplyRequest{false, true}") != std::string::npos &&
            energy_source.find("fullmag_cuda_device_sum(") != std::string::npos &&
            energy_source.find("dmi_energy_partial_count") != std::string::npos,
        "RK final DMI energy must reduce persistent block partials through CUB");

    return 0;
}
