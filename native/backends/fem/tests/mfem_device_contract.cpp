/*
 * mfem_device_contract.cpp - native FEM MFEM device selection contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg) {
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

void mfem_device_plan_import_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string mfem_device =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_device.cpp");
    const std::string mfem_device_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_device.hpp");

    check(
        context.find("ctx.mfem_device.gpu_device_index = plan.gpu_device_index;") == std::string::npos,
        "Context construction must not copy GPU device index directly");
    check(
        context.find("ctx.mfem_device.device_string_override = plan.mfem_device_string;") ==
            std::string::npos,
        "Context construction must not copy MFEM device string directly");
    check(
        mfem_device.find("void initialize_mfem_device_plan_fields(") != std::string::npos,
        "MFEM device plan import must be defined in mfem_device.cpp");
    check(
        context.find("void context_populate_device_info(") == std::string::npos,
        "Context must not define MFEM device-info population");
    check(
        context_header.find("configured_mfem_device_string") == std::string::npos,
        "MFEM device string declarations must not live in context.hpp");
    check(
        context_header.find("is_gpu_device_string") == std::string::npos,
        "MFEM GPU device classifier declaration must not live in context.hpp");
    check(
        context_header.find("mfem_device_requests_gpu") == std::string::npos,
        "MFEM GPU request declarations must not live in context.hpp");
    check(
        mfem_device.find("void context_populate_device_info(") != std::string::npos,
        "MFEM device-info population must be defined in mfem_device.cpp");
    check(
        api.find("*out_info = handle->context.mfem_device.device_info_cache;") == std::string::npos,
        "C ABI API must not read device-info cache directly");
    check(
        api.find("fullmag::fem::device_info_snapshot(") != std::string::npos,
        "C ABI API must use MFEM device-info snapshot helper");
    check(
        mfem_device_header.find("Initialize native FEM MFEM device plan fields") !=
            std::string::npos,
        "mfem_device header must document plan-field initialization ownership");
    check(
        mfem_device_header.find("Populate native FEM device-info cache") !=
            std::string::npos,
        "mfem_device header must document device-info cache ownership");
    check(
        mfem_device_header.find("Return the current native FEM device-info snapshot") !=
            std::string::npos,
        "mfem_device header must document device-info snapshot ownership");
    check(
        mfem_device_header.find("fullmag_fem_device_info device_info_snapshot(") !=
            std::string::npos,
        "mfem_device header must declare device-info snapshot helper");
    check(
        mfem_device_header.find("struct MfemDeviceRuntimeState") != std::string::npos,
        "mfem_device header must declare the runtime state owner");
    check(
        mfem_device_header.find("int32_t gpu_device_index") != std::string::npos &&
            mfem_device_header.find("std::string device_string_override") !=
                std::string::npos &&
            mfem_device_header.find("fullmag_fem_device_info device_info_cache") !=
                std::string::npos &&
            mfem_device_header.find("bool device_info_valid") != std::string::npos,
        "MFEM device runtime state must own plan selection and device-info cache");
    check(
        context_header.find("MfemDeviceRuntimeState mfem_device{}") != std::string::npos,
        "Context must store MFEM device runtime state under mfem_device");
    for (const char *flat_field : {
             "int32_t gpu_device_index",
             "std::string mfem_device_string_override",
             "fullmag_fem_device_info device_info_cache",
             "bool device_info_valid",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat MFEM device runtime fields");
    }
}

void mfem_device_plan_import_copies_and_clears_overrides() {
    fullmag::fem::Context ctx;
    ctx.mfem_device.gpu_device_index = 9;
    ctx.mfem_device.device_string_override = "stale";

    fullmag_fem_plan_desc plan{};
    plan.gpu_device_index = 2;
    plan.mfem_device_string = "ceed-cuda:/gpu/cuda/ref";

    fullmag::fem::initialize_mfem_device_plan_fields(ctx, plan);

    check(ctx.mfem_device.gpu_device_index == 2, "GPU device index copied");
    check(
        ctx.mfem_device.device_string_override == "ceed-cuda:/gpu/cuda/ref",
        "MFEM device override copied");
    check(
        fullmag::fem::mfem_device_requests_gpu(ctx),
        "explicit CUDA-like MFEM device requests GPU realization");

    plan.gpu_device_index = -1;
    plan.mfem_device_string = "";
    fullmag::fem::initialize_mfem_device_plan_fields(ctx, plan);

    check(ctx.mfem_device.gpu_device_index == -1, "GPU device index reset to plan default");
    check(ctx.mfem_device.device_string_override.empty(), "empty plan device clears stale override");
}

void device_info_population_sets_scaffold_metadata_without_mfem_stack() {
    fullmag::fem::Context ctx;
    ctx.mfem_device.device_info_cache.is_gpu_enabled = 99;
    ctx.mfem_device.device_info_valid = false;

    fullmag::fem::context_populate_device_info(ctx);

    check(ctx.mfem_device.device_info_valid, "device info marked valid");
    check(
        std::strcmp(ctx.mfem_device.device_info_cache.name, "native_fem_scaffold") == 0,
        "no-MFEM device info uses scaffold backend name");
    check(ctx.mfem_device.device_info_cache.is_gpu_enabled == 0, "no-MFEM device info reports CPU scaffold");
}

void device_info_snapshot_returns_public_cache() {
    fullmag::fem::Context ctx;
    ctx.mfem_device.device_info_valid = true;
    std::snprintf(
        ctx.mfem_device.device_info_cache.name,
        sizeof(ctx.mfem_device.device_info_cache.name),
        "%s",
        "mfem_cpu_exchange_ready");
    ctx.mfem_device.device_info_cache.is_gpu_enabled = 0;
    ctx.mfem_device.device_info_cache.compute_capability_major = 9;
    ctx.mfem_device.device_info_cache.compute_capability_minor = 1;

    const fullmag_fem_device_info snapshot =
        fullmag::fem::device_info_snapshot(ctx);

    check(
        std::strcmp(snapshot.name, "mfem_cpu_exchange_ready") == 0,
        "snapshot device name");
    check(snapshot.is_gpu_enabled == 0, "snapshot gpu flag");
    check(snapshot.compute_capability_major == 9, "snapshot compute capability major");
    check(snapshot.compute_capability_minor == 1, "snapshot compute capability minor");
}

} // namespace

int main() {
    mfem_device_plan_import_is_owned_by_runtime_module();
    mfem_device_plan_import_copies_and_clears_overrides();
    device_info_population_sets_scaffold_metadata_without_mfem_stack();
    device_info_snapshot_returns_public_cache();
    return 0;
}
