/*
 * availability_contract.cpp - native FEM runtime availability contracts.
 */

#include "fullmag_fem.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
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

void availability_query_is_owned_by_runtime_module()
{
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string availability_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "availability.hpp");
    const std::string availability =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "availability.cpp");

    const char *symbols[] = {
        "fullmag_fem_availability_info query_availability(",
        "void finalize_availability(",
        "std::optional<int> selected_cuda_device_from_env(",
        "bool mfem_device_request_needs_ceed(",
    };
    for (const char *symbol : symbols) {
        check(
            api.find(symbol) == std::string::npos,
            "C ABI API must not own native FEM availability policy helpers");
        check(
            availability.find(symbol) != std::string::npos,
            "runtime availability module must own native FEM availability policy helpers");
    }

    check(
        api.find("fullmag::fem::query_availability()") != std::string::npos,
        "C ABI API must delegate availability queries to runtime module");
    check(
        availability_header.find("Query native FEM CPU/GPU runtime availability") !=
            std::string::npos,
        "availability header must document runtime availability ownership");
    check(
        availability_header.find("fullmag_fem_availability_info query_availability();") !=
            std::string::npos,
        "availability header must declare query_availability");
}

void public_availability_api_preserves_lane_mirrors()
{
    fullmag_fem_availability_info availability{};
    check(
        fullmag_fem_get_availability_info(&availability) == FULLMAG_FEM_OK,
        "fullmag_fem_get_availability_info succeeds");
    check(
        availability.available_any == availability.available,
        "available_any mirrors legacy available");
    check(
        availability.available_cpu == availability.native_fem_cpu_available,
        "available_cpu mirrors native_fem_cpu_available");
    check(
        availability.available_gpu == availability.native_fem_gpu_available,
        "available_gpu mirrors native_fem_gpu_available");
    if (availability.native_fem_gpu_available == 0) {
        check(
            availability.gpu_memory_free_bytes == 0 && availability.gpu_memory_total_bytes == 0,
            "unavailable native FEM GPU reports zero VRAM capacity");
    } else {
        check(
            availability.gpu_memory_total_bytes > 0,
            "available native FEM GPU reports total VRAM capacity");
        check(
            availability.gpu_memory_free_bytes <= availability.gpu_memory_total_bytes,
            "available native FEM GPU reports bounded free VRAM");
    }
    check(
        std::strlen(availability.reason) > 0,
        "availability query reports aggregate reason");
}

} // namespace

int main()
{
    availability_query_is_owned_by_runtime_module();
    public_availability_api_preserves_lane_mirrors();
    return 0;
}
