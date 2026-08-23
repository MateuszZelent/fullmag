#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "context.hpp"
#include "fullmag_fdm.h"

namespace {
void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read(const std::filesystem::path &path) {
    std::ifstream input(path);
    check(static_cast<bool>(input), "required hot-loop source is readable");
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

std::filesystem::path repository_root() {
    auto path = std::filesystem::path(__FILE__);
    if (!path.is_absolute()) path = std::filesystem::absolute(path);
    return path.parent_path().parent_path().parent_path().parent_path();
}
}

extern "C" int fullmag_fdm_test_record_residency_violation_v1(
    fullmag_fdm_backend *handle,
    uint32_t violation_kind,
    uint64_t bytes);

int main() {
    const auto root = repository_root();
    for (const auto *relative : {
             "backends/fdm/gpu/cuda/integrators",
             "backends/fdm/gpu/cuda/interactions"}) {
        for (const auto &entry :
             std::filesystem::recursive_directory_iterator(root / relative)) {
            if (!entry.is_regular_file()) continue;
            const auto extension = entry.path().extension().string();
            if (extension != ".cu" && extension != ".cpp" && extension != ".hpp") {
                continue;
            }
            const auto source = read(entry.path());
            check(source.find("cudaMemcpyHostToDevice") == std::string::npos,
                  "active hot-loop sources contain no direct full-vector H2D");
            check(source.find("cudaMemcpyDeviceToHost") == std::string::npos,
                  "active hot-loop sources contain no direct full-vector D2H");
            check(source.find("context_upload_magnetization") == std::string::npos,
                  "active hot-loop sources contain no setup-upload bypass");
            check(source.find("context_copy_m_to_host") == std::string::npos,
                  "active hot-loop sources contain no magnetization readback bypass");
            check(source.find("context_copy_field_to_host") == std::string::npos,
                  "active hot-loop sources contain no field readback bypass");
            check(source.find("execute_reference_fdm") == std::string::npos,
                  "active hot-loop sources contain no CPU reference solve");
        }
    }
    const auto active_dispatch = read(root / "backends/fdm/api/c_api.cpp");
    check(active_dispatch.find("execute_reference_fdm") == std::string::npos,
          "active native dispatch contains no CPU reference fallback");
    static_assert(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 == 1u);
    static_assert(offsetof(fullmag_fdm_execution_receipt_v1, abi_version) == 0u);
    static_assert(offsetof(fullmag_fdm_execution_receipt_v1, struct_size) == 4u);

    fullmag_fdm_execution_receipt_v1 receipt{};
    receipt.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1;
    receipt.struct_size = sizeof(receipt);
    check(receipt.setup_full_vector_h2d_count == 0,
          "setup transfers start independently at zero");
    check(receipt.hot_loop_full_vector_h2d_count == 0,
          "hot-loop full-vector H2D starts at zero");
    check(receipt.hot_loop_full_vector_d2h_count == 0,
          "hot-loop full-vector D2H starts at zero");
    check(receipt.hot_loop_host_compute_count == 0,
          "hot-loop host compute starts at zero");
    check(receipt.hot_loop_control_scalar_d2h_bytes == 0,
          "scalar control is accounted separately");

#if FULLMAG_FDM_CONTRACT_HAS_CUDA
    double m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc_v2 plan{};
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    plan.struct_size = sizeof(plan);
    plan.base.grid = {1, 1, 1, 1e-9, 1e-9, 1e-9};
    plan.base.material = {8e5, 1.3e-11, 0.1, 2.211e5};
    plan.base.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.base.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.base.enable_exchange = 1;
    plan.base.initial_magnetization_xyz = m;
    plan.base.initial_magnetization_len = 3;
    plan.time_policy.adaptive_enabled = 0;

    fullmag_fdm_backend *handle = nullptr;
    const int create_status =
        fullmag_fdm_backend_create_time_policy_v2_checked(&plan, &handle);
    check(create_status == FULLMAG_FDM_OK && handle != nullptr,
          "managed CUDA fixture creates a native context");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "managed CUDA fixture creation has no deferred error");

    check(fullmag_fdm_backend_execution_receipt_v1(handle, &receipt) == FULLMAG_FDM_OK,
          "created Context publishes execution receipt");
    check(receipt.execution_class == FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT,
          "native context resolves device-resident execution");
    check(receipt.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM,
          "native context reports executed CUDA backend");
    check(receipt.precision == FULLMAG_FDM_PRECISION_DOUBLE,
          "native receipt preserves executed precision");
    check((receipt.required_operator_mask & FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR) != 0,
          "native receipt requires the LLG integrator");
    check((receipt.device_operator_mask & receipt.required_operator_mask) ==
              receipt.required_operator_mask,
          "every required operator is device resident");
    check(receipt.setup_full_vector_h2d_count > 0,
          "initial magnetization is reported as setup H2D");
    check(receipt.setup_full_vector_h2d_bytes == 3u * sizeof(double),
          "setup H2D bytes match one FP64 vector");

    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, 1e-15, &stats) == FULLMAG_FDM_OK,
          "managed CUDA fixture executes one GPU step");
    check(fullmag_fdm_backend_execution_receipt_v1(handle, &receipt) == FULLMAG_FDM_OK,
          "final receipt is queryable");
    check(receipt.hot_loop_full_vector_h2d_count == 0,
          "strict hot loop has zero full-vector H2D");
    check(receipt.hot_loop_full_vector_d2h_count == 0,
          "strict hot loop has zero full-vector D2H");
    check(receipt.hot_loop_host_compute_count == 0,
          "strict hot loop has zero host compute");
    check(receipt.fallback_count == 0,
          "strict native context has no fallback");
    check(receipt.hot_loop_control_scalar_d2h_bytes ==
              stats.hot_loop_control_scalar_d2h_bytes,
          "scalar control D2H remains separately accounted");

    if (const char *evidence_path =
            std::getenv("FULLMAG_FDM_GPU_RESIDENCY_EVIDENCE_PATH")) {
        std::ofstream evidence(evidence_path, std::ios::trunc);
        check(static_cast<bool>(evidence), "managed receipt evidence is writable");
        evidence
            << "{\n"
            << "  \"schema_version\": \"fdm_gpu_execution_receipt_evidence.v1\",\n"
            << "  \"validation_state\": \"unvalidated\",\n"
            << "  \"runtime_check\": \"passed\",\n"
            << "  \"requested\": \"device_resident\",\n"
            << "  \"resolved\": \"device_resident\",\n"
            << "  \"executed\": \"cuda_fdm\",\n"
            << "  \"device_ordinal\": " << receipt.device_ordinal << ",\n"
            << "  \"precision\": \"double\",\n"
            << "  \"required_operator_mask\": "
            << receipt.required_operator_mask << ",\n"
            << "  \"device_operator_mask\": "
            << receipt.device_operator_mask << ",\n"
            << "  \"fallback_count\": " << receipt.fallback_count << ",\n"
            << "  \"transfer_counts\": {\n"
            << "    \"setup_full_vector_h2d_count\": "
            << receipt.setup_full_vector_h2d_count << ",\n"
            << "    \"setup_full_vector_h2d_bytes\": "
            << receipt.setup_full_vector_h2d_bytes << ",\n"
            << "    \"hot_loop_full_vector_h2d_count\": "
            << receipt.hot_loop_full_vector_h2d_count << ",\n"
            << "    \"hot_loop_full_vector_h2d_bytes\": "
            << receipt.hot_loop_full_vector_h2d_bytes << ",\n"
            << "    \"hot_loop_full_vector_d2h_count\": "
            << receipt.hot_loop_full_vector_d2h_count << ",\n"
            << "    \"hot_loop_full_vector_d2h_bytes\": "
            << receipt.hot_loop_full_vector_d2h_bytes << ",\n"
            << "    \"hot_loop_host_compute_count\": "
            << receipt.hot_loop_host_compute_count << ",\n"
            << "    \"hot_loop_host_sync_count\": "
            << receipt.hot_loop_host_sync_count << ",\n"
            << "    \"hot_loop_control_scalar_d2h_bytes\": "
            << receipt.hot_loop_control_scalar_d2h_bytes << ",\n"
            << "    \"hot_loop_control_scalar_host_sync_count\": "
            << receipt.hot_loop_control_scalar_host_sync_count << "\n"
            << "  }\n"
            << "}\n";
        check(static_cast<bool>(evidence), "managed receipt evidence is complete");
    }

    check(fullmag_fdm_test_record_residency_violation_v1(handle, 1, 24) ==
              FULLMAG_FDM_OK,
          "fixture injects one full-vector H2D violation through central hook");
    check(fullmag_fdm_backend_execution_receipt_v1(handle, &receipt) == FULLMAG_FDM_OK &&
              receipt.hot_loop_full_vector_h2d_count == 1 &&
              receipt.hot_loop_full_vector_h2d_bytes == 24,
          "receipt exposes injected full-vector H2D violation");
    check(fullmag_fdm_test_record_residency_violation_v1(handle, 2, 24) ==
              FULLMAG_FDM_OK,
          "fixture injects one full-vector D2H violation through central hook");
    check(fullmag_fdm_backend_execution_receipt_v1(handle, &receipt) == FULLMAG_FDM_OK &&
              receipt.hot_loop_full_vector_d2h_count == 1 &&
              receipt.hot_loop_full_vector_d2h_bytes == 24,
          "receipt exposes injected full-vector D2H violation");
    check(fullmag_fdm_test_record_residency_violation_v1(handle, 3, 0) ==
              FULLMAG_FDM_OK,
          "fixture injects one host-compute violation through central hook");
    check(fullmag_fdm_backend_execution_receipt_v1(handle, &receipt) == FULLMAG_FDM_OK &&
              receipt.hot_loop_host_compute_count == 1,
          "receipt exposes injected host-compute violation");
    fullmag_fdm_backend_destroy(handle);
#else
    fullmag::fdm::Context instrumented{};
    instrumented.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    instrumented.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    instrumented.enable_exchange = true;
    instrumented.receipt_setup_full_vector_h2d_count = 1;
    instrumented.receipt_setup_full_vector_h2d_bytes = 24;
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented, 0);
    check(receipt.execution_class == FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT,
          "instrumented Context maps to device-resident receipt semantics");
    check(receipt.setup_full_vector_h2d_count == 1 &&
              receipt.setup_full_vector_h2d_bytes == 24,
          "instrumented setup transfer remains separate from the hot loop");

    fullmag::fdm::fullmag_fdm_record_hot_loop_full_vector_h2d(instrumented, 24);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented, 0);
    check(receipt.hot_loop_full_vector_h2d_count == 1 &&
              receipt.hot_loop_full_vector_h2d_bytes == 24,
          "host diagnostic exposes injected full-vector H2D violation");
    fullmag::fdm::fullmag_fdm_record_hot_loop_full_vector_d2h(instrumented, 24);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented, 0);
    check(receipt.hot_loop_full_vector_d2h_count == 1 &&
              receipt.hot_loop_full_vector_d2h_bytes == 24,
          "host diagnostic exposes injected full-vector D2H violation");
    fullmag::fdm::fullmag_fdm_record_hot_loop_host_compute(instrumented);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented, 0);
    check(receipt.hot_loop_host_compute_count == 1,
          "host diagnostic exposes injected host-compute violation");
#endif

    std::puts("FDM GPU device residency receipt contract: PASS");
    return 0;
}
