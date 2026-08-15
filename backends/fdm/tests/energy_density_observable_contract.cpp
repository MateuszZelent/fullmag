/* energy_density_observable_contract.cpp - scalar observable ABI contract. */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text(const std::filesystem::path &path) {
    std::ifstream input(path);
    check(input.good(), "source file must be readable");
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::filesystem::path source_root() {
    const std::filesystem::path this_file(__FILE__);
    return this_file.is_absolute()
        ? this_file.parent_path().parent_path()
        : std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void public_scalar_contract_is_explicit() {
    const auto root = source_root();
    const auto header = read_text(
        root.parent_path().parent_path() / "native" / "include" / "fullmag_fdm.h");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_EX") != std::string::npos,
          "ABI must expose exchange energy-density observable");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG") != std::string::npos,
          "ABI must expose demag energy-density observable");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_EXT") != std::string::npos,
          "ABI must expose external energy-density observable");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_DRIVE") != std::string::npos,
          "ABI must expose drive energy-density observable");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_ANI") != std::string::npos,
          "ABI must expose anisotropy energy-density observable");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_DMI") != std::string::npos,
          "ABI must expose DMI energy-density observable");
    check(header.find("FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL") != std::string::npos,
          "ABI must expose total energy-density observable");
    check(header.find("fullmag_fdm_backend_copy_scalar_field_f64") != std::string::npos,
          "ABI must expose f64 scalar field transfer");
    check(header.find("fullmag_fdm_backend_copy_scalar_field_f32") != std::string::npos,
          "ABI must expose f32 scalar field transfer");
    check(header.find("3 for vectors, 1 for scalar fields") != std::string::npos,
          "snapshot descriptor must distinguish vector and scalar payloads");
}

void cuda_materialization_contract_is_present() {
    const auto root = source_root();
    const auto context = read_text(root / "gpu" / "cuda" / "runtime" / "context.cu");
    const auto kernel = read_text(root / "gpu" / "cuda" / "interactions" / "energy_density_fp64.cu");
    check(context.find("context_download_scalar_f64") != std::string::npos,
          "context must provide f64 scalar materialization");
    check(context.find("context_begin_async_field_snapshot") != std::string::npos,
          "scalar observables must use the async snapshot path");
    check(kernel.find("launch_energy_density_observable") != std::string::npos,
          "CUDA energy-density launcher must be present");
    check(kernel.find("FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL") != std::string::npos,
          "CUDA materializer must define total energy density");
}

} // namespace

int main() {
    public_scalar_contract_is_explicit();
    cuda_materialization_contract_is_present();
    return 0;
}
