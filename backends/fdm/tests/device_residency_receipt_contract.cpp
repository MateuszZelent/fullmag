#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <thread>

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

std::size_t occurrences(const std::string &text, const std::string &needle) {
    std::size_t count = 0;
    for (std::size_t offset = 0;
         (offset = text.find(needle, offset)) != std::string::npos;
         offset += needle.size()) {
        ++count;
    }
    return count;
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
    const std::map<std::string, std::pair<std::size_t, std::size_t>>
        approved_host_transfer_inventory{
            {"demag/newell_gpu_fp64.cu", {0, 6}},
            {"runtime/context.cu", {44, 36}},
            {"runtime/llg_checkpoint.cpp", {1, 1}},
            {"runtime/reductions_fp64.cu", {0, 5}},
            {"transport/charge/device_solver.cu", {0, 4}},
            {"transport/context.cu", {5, 12}},
            {"transport/spin/device_solver.cu", {5, 4}},
            {"transport/spin/sparse_solver.cu", {0, 3}},
        };
    std::map<std::string, std::pair<std::size_t, std::size_t>> observed_inventory;
    const auto cuda_root = root / "backends/fdm/gpu/cuda";
    for (const auto &entry : std::filesystem::recursive_directory_iterator(cuda_root)) {
        if (!entry.is_regular_file()) continue;
        const auto extension = entry.path().extension().string();
        if (extension != ".cu" && extension != ".cpp" && extension != ".hpp") continue;
        const auto source = read(entry.path());
        for (const auto *forbidden : {
                 "cudaMemcpyDefault", "cudaMemcpy2D", "cudaMemcpy3D",
                 "cudaMemcpyPeer", "cudaMemcpyToSymbol", "cudaMemcpyFromSymbol",
                 "cuMemcpy(", "cuMemcpyHtoD", "cuMemcpyDtoH", "hipMemcpy",
                 "thrust::copy"}) {
            check(source.find(forbidden) == std::string::npos,
                  "active graph contains no alternate unclassified host transfer wrapper");
        }
        const auto h2d = occurrences(source, "cudaMemcpyHostToDevice");
        const auto d2h = occurrences(source, "cudaMemcpyDeviceToHost");
        if (h2d != 0 || d2h != 0) {
            observed_inventory.emplace(
                entry.path().lexically_relative(cuda_root).generic_string(),
                std::make_pair(h2d, d2h));
        }
    }
    check(observed_inventory == approved_host_transfer_inventory,
          "full active CUDA graph host-transfer inventory is exact and fail-closed");
    check(active_dispatch.find(
              "fullmag_fdm_accumulate_execution_receipt_audit(context_);") !=
              std::string::npos,
          "solver phase scope guard flushes receipt audit on every exit");
    const auto runner_dispatch = read(root / "crates/fullmag-runner/src/dispatch.rs");
    const auto runner_preview = read(root / "crates/fullmag-runner/src/interactive_runtime.rs");
    check(runner_dispatch.find("finalize_after_outcome") != std::string::npos,
          "batch runner finalizes receipt for success and error outcomes");
    check(runner_preview.find("finalize_after_outcome") != std::string::npos,
          "both preview runners finalize receipt for success and error outcomes");
    static_assert(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 == 1u);
#define FULLMAG_FDM_EXECUTION_CLASS_VALUE(name, value) static_assert(name == value);
#define FULLMAG_FDM_EXECUTED_BACKEND_VALUE(name, value) static_assert(name == value);
#define FULLMAG_FDM_OPERATOR_LOCATION_VALUE(name, value) static_assert(name == value);
#define FULLMAG_FDM_OPERATOR_MASK_VALUE(name, value) static_assert(name == value);
#include "fullmag_fdm_execution_receipt_v1_values.def"
#undef FULLMAG_FDM_OPERATOR_MASK_VALUE
#undef FULLMAG_FDM_OPERATOR_LOCATION_VALUE
#undef FULLMAG_FDM_EXECUTED_BACKEND_VALUE
#undef FULLMAG_FDM_EXECUTION_CLASS_VALUE
    static_assert(offsetof(fullmag_fdm_execution_receipt_v1, abi_version) == 0u);
    static_assert(offsetof(fullmag_fdm_execution_receipt_v1, struct_size) == 4u);
#define FULLMAG_FDM_EXECUTION_RECEIPT_FIELD(type, name, offset) \
    static_assert(offsetof(fullmag_fdm_execution_receipt_v1, name) == offset);
#define FULLMAG_FDM_EXECUTION_RECEIPT_SIZE(size) \
    static_assert(sizeof(fullmag_fdm_execution_receipt_v1) == size);
#include "fullmag_fdm_execution_receipt_v1_layout.def"
#undef FULLMAG_FDM_EXECUTION_RECEIPT_SIZE
#undef FULLMAG_FDM_EXECUTION_RECEIPT_FIELD
    fullmag_fdm_execution_receipt_v1 invalid{};
    std::memset(&invalid, 0x5a, sizeof(invalid));
    invalid.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 + 1;
    invalid.struct_size = sizeof(invalid);
    const auto unknown_version = invalid;
    check(!fullmag::fdm::fullmag_fdm_execution_receipt_request_valid(invalid),
          "unknown receipt ABI version is rejected");
    check(std::memcmp(&invalid, &unknown_version, sizeof(invalid)) == 0,
          "unknown ABI rejection leaves output byte-for-byte unchanged");
    invalid.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1;
    invalid.struct_size = sizeof(invalid) - 1;
    const auto truncated = invalid;
    check(!fullmag::fdm::fullmag_fdm_execution_receipt_request_valid(invalid),
          "truncated receipt is rejected");
    check(std::memcmp(&invalid, &truncated, sizeof(invalid)) == 0,
          "truncated rejection leaves output byte-for-byte unchanged");
    invalid.struct_size = sizeof(invalid) + 1;
    const auto oversized = invalid;
    check(!fullmag::fdm::fullmag_fdm_execution_receipt_request_valid(invalid),
          "oversized receipt is rejected");
    check(std::memcmp(&invalid, &oversized, sizeof(invalid)) == 0,
          "oversized rejection leaves output byte-for-byte unchanged");

    uint64_t bytes = 0;
    check(fullmag::fdm::fullmag_fdm_checked_vector_bytes(1, sizeof(double), bytes) && bytes == 24,
          "checked setup byte multiplication accepts a small vector");
    check(!fullmag::fdm::fullmag_fdm_checked_vector_bytes(UINT64_MAX, sizeof(double), bytes),
          "checked setup byte multiplication rejects overflow");

    fullmag::fdm::ExecutionReceiptState family_state{};
    fullmag::fdm::fullmag_fdm_require_operator(
        family_state, FULLMAG_FDM_OPERATOR_GPU_TRANSPORT);
    check(fullmag::fdm::fullmag_fdm_resolved_unknown_operator_mask(family_state) ==
              FULLMAG_FDM_OPERATOR_GPU_TRANSPORT,
          "required operator is explicitly resolved-unknown before realization");
    fullmag::fdm::fullmag_fdm_resolve_operator_device(
        family_state, FULLMAG_FDM_OPERATOR_GPU_TRANSPORT);
    check(fullmag::fdm::fullmag_fdm_resolved_unknown_operator_mask(family_state) == 0 &&
              fullmag::fdm::fullmag_fdm_executed_unknown_operator_mask(family_state) ==
                  FULLMAG_FDM_OPERATOR_GPU_TRANSPORT,
          "transport bind resolves device but does not claim execution");
    fullmag::fdm::fullmag_fdm_commit_operator_device_execution(
        family_state, FULLMAG_FDM_OPERATOR_GPU_TRANSPORT);
    check(fullmag::fdm::fullmag_fdm_executed_unknown_operator_mask(family_state) == 0,
          "transport success commits actual device execution");

    auto shared_receipt = std::make_shared<fullmag::fdm::ExecutionReceiptState>();
    fullmag::fdm::AsyncTransferReceiptToken pending_transfer(
        shared_receipt, false, 24, fullmag::fdm::ReceiptTransferCadence::Observation);
    check(pending_transfer.complete() && !pending_transfer.complete(),
          "async transfer receipt commits exactly once");
    check(shared_receipt->observation_full_vector_d2h_count == 1,
          "completed async D2H is counted once");
    fullmag::fdm::AsyncTransferReceiptToken unresolved_transfer(
        shared_receipt, false, 24, fullmag::fdm::ReceiptTransferCadence::Observation);
    check(unresolved_transfer.invalidate() && !unresolved_transfer.complete(),
          "unresolved async transfer invalidates accounting exactly once");
    check(!shared_receipt->accounting_valid &&
              shared_receipt->observation_full_vector_d2h_count == 1,
          "unresolved async transfer is not counted without completion proof");

    auto telemetry = [](uint32_t direction, uint32_t reason, uint32_t flags) {
        fullmag_fdm_gpu_transport_telemetry_v1 record{};
        record.status = FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS;
        record.direction = direction;
        record.reason = reason;
        record.event_flags = flags;
        return record;
    };
    using Category = fullmag::fdm::TransportReceiptCategory;
    check(fullmag::fdm::fullmag_fdm_classify_transport_telemetry(telemetry(
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER)) == Category::SetupH2D,
          "static upload is setup H2D");
    check(fullmag::fdm::fullmag_fdm_classify_transport_telemetry(telemetry(
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER)) == Category::ScalarD2H,
          "scalar reduction is not a full-vector hot-loop readback");
    check(fullmag::fdm::fullmag_fdm_classify_transport_telemetry(telemetry(
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                  FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED)) ==
              Category::ObservationD2H,
          "cadence-authorized scalar checkpoint metadata is observation D2H");
    for (const auto reason : {
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H}) {
        check(fullmag::fdm::fullmag_fdm_classify_transport_telemetry(telemetry(
                  FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H, reason,
                  FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                      FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED)) ==
                  Category::ObservationD2H,
              "artifact/checkpoint export uses observation cadence");
    }
    check(fullmag::fdm::fullmag_fdm_classify_transport_telemetry(telemetry(
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                  FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED)) ==
              Category::ObservationH2D,
          "checkpoint import uses observation cadence");
    check(fullmag::fdm::fullmag_fdm_classify_transport_telemetry(telemetry(
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER)) == Category::Invalid,
          "artifact readback without authorized cadence fails closed");
    fullmag::fdm::ExecutionReceiptState sequence_state{};
    check(fullmag::fdm::fullmag_fdm_accept_transport_telemetry_sequence(
              sequence_state, 1),
          "first telemetry sequence is accepted");
    check(!fullmag::fdm::fullmag_fdm_accept_transport_telemetry_sequence(
              sequence_state, 3) && !sequence_state.accounting_valid,
          "transport telemetry sequence gap invalidates accounting");

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
    check(receipt.observation_full_vector_d2h_count == 0 &&
              receipt.observation_full_vector_h2d_count == 0,
          "observation transfers are independent from solver hot-loop counters");

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

    auto check_rejected_query_unchanged = [&](uint32_t abi_version,
                                               uint32_t struct_size,
                                               const char *message) {
        fullmag_fdm_execution_receipt_v1 rejected{};
        std::memset(&rejected, 0x5a, sizeof(rejected));
        rejected.abi_version = abi_version;
        rejected.struct_size = struct_size;
        const auto before = rejected;
        check(fullmag_fdm_backend_execution_receipt_v1(handle, &rejected) ==
                  FULLMAG_FDM_ERR_ABI,
              message);
        check(std::memcmp(&rejected, &before, sizeof(rejected)) == 0,
              "rejected native receipt query leaves output byte-for-byte unchanged");
    };
    check_rejected_query_unchanged(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 + 1,
                                   sizeof(receipt),
                                   "native query rejects an unknown ABI version");
    check_rejected_query_unchanged(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1,
                                   sizeof(receipt) - 1,
                                   "native query rejects a truncated receipt");
    check_rejected_query_unchanged(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1,
                                   sizeof(receipt) + 1,
                                   "native query rejects an oversized receipt");

    check(fullmag_fdm_backend_execution_receipt_v1(handle, &receipt) == FULLMAG_FDM_OK,
          "created Context publishes execution receipt");
    check(receipt.execution_class == FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT,
          "native context resolves device-resident execution");
    check(receipt.executed_backend == FULLMAG_FDM_EXECUTED_UNKNOWN &&
              receipt.executed_unknown_operator_mask == receipt.required_operator_mask,
          "native context does not claim execution before the first successful step");
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
    check(receipt.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM &&
              receipt.executed_device_operator_mask == receipt.required_operator_mask &&
              receipt.executed_unknown_operator_mask == 0,
          "successful step proves every required device operator family");
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
            << "  \"validation_state\": \"validated\",\n"
            << "  \"runtime_check\": \"passed\",\n"
            << "  \"requested\": \"gpu\",\n"
            << "  \"resolved\": \"device_resident\",\n"
            << "  \"executed\": \"cuda_fdm\",\n"
            << "  \"device_ordinal\": " << receipt.device_ordinal << ",\n"
            << "  \"precision\": \"double\",\n"
            << "  \"integrator\": \"heun\",\n"
            << "  \"required_operator_mask\": "
            << receipt.required_operator_mask << ",\n"
            << "  \"resolved_device_operator_mask\": "
            << receipt.device_operator_mask << ",\n"
            << "  \"resolved_host_operator_mask\": "
            << receipt.host_operator_mask << ",\n"
            << "  \"resolved_unknown_operator_mask\": "
            << receipt.resolved_unknown_operator_mask << ",\n"
            << "  \"executed_device_operator_mask\": "
            << receipt.executed_device_operator_mask << ",\n"
            << "  \"executed_host_operator_mask\": "
            << receipt.executed_host_operator_mask << ",\n"
            << "  \"executed_unknown_operator_mask\": "
            << receipt.executed_unknown_operator_mask << ",\n"
            << "  \"fallback_count\": " << receipt.fallback_count << ",\n"
            << "  \"accounting_valid\": "
            << (receipt.accounting_valid == 1 ? "true" : "false") << ",\n"
            << "  \"transfer_counts\": {\n"
            << "    \"setup_full_vector_h2d_count\": "
            << receipt.setup_full_vector_h2d_count << ",\n"
            << "    \"setup_full_vector_h2d_bytes\": "
            << receipt.setup_full_vector_h2d_bytes << ",\n"
            << "    \"setup_full_vector_d2h_count\": "
            << receipt.setup_full_vector_d2h_count << ",\n"
            << "    \"setup_full_vector_d2h_bytes\": "
            << receipt.setup_full_vector_d2h_bytes << ",\n"
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
            << receipt.hot_loop_control_scalar_host_sync_count << ",\n"
            << "    \"observation_full_vector_h2d_count\": "
            << receipt.observation_full_vector_h2d_count << ",\n"
            << "    \"observation_full_vector_h2d_bytes\": "
            << receipt.observation_full_vector_h2d_bytes << ",\n"
            << "    \"observation_full_vector_d2h_count\": "
            << receipt.observation_full_vector_d2h_count << ",\n"
            << "    \"observation_full_vector_d2h_bytes\": "
            << receipt.observation_full_vector_d2h_bytes << "\n"
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

    auto create_snapshot_fixture = [&]() {
        fullmag_fdm_backend *snapshot_handle = nullptr;
        check(fullmag_fdm_backend_create_time_policy_v2_checked(
                  &plan, &snapshot_handle) == FULLMAG_FDM_OK &&
                  snapshot_handle != nullptr,
              "managed CUDA fixture creates an async snapshot context");
        return snapshot_handle;
    };
    auto *resolved_handle = create_snapshot_fixture();
    auto *resolved_context = reinterpret_cast<fullmag::fdm::Context *>(resolved_handle);
    auto resolved_receipt = resolved_context->execution_receipt;
    auto *resolved_snapshot = fullmag_fdm_backend_begin_field_snapshot(
        resolved_handle, FULLMAG_FDM_OBSERVABLE_M);
    check(resolved_snapshot != nullptr,
          "async snapshot begins before backend destruction");
    fullmag_fdm_backend_destroy(resolved_handle);
    const void *resolved_data = nullptr;
    uint64_t resolved_bytes = 0;
    fullmag_fdm_snapshot_desc resolved_desc{};
    check(fullmag_fdm_field_snapshot_wait(
              resolved_snapshot, &resolved_data, &resolved_bytes,
              &resolved_desc) == FULLMAG_FDM_OK,
          "async snapshot resolves safely after backend destruction");
    check(resolved_receipt->observation_full_vector_d2h_count == 1 &&
              resolved_receipt->accounting_valid,
          "post-destroy async completion is counted exactly once");
    fullmag_fdm_field_snapshot_destroy(resolved_snapshot);

    auto *dropped_handle = create_snapshot_fixture();
    auto *dropped_context = reinterpret_cast<fullmag::fdm::Context *>(dropped_handle);
    auto dropped_receipt = dropped_context->execution_receipt;
    auto *dropped_snapshot = fullmag_fdm_backend_begin_field_snapshot(
        dropped_handle, FULLMAG_FDM_OBSERVABLE_M);
    check(dropped_snapshot != nullptr,
          "unresolved async snapshot begins before backend destruction");
    fullmag_fdm_backend_destroy(dropped_handle);
    fullmag_fdm_field_snapshot_destroy(dropped_snapshot);
    check(!dropped_receipt->accounting_valid &&
              dropped_receipt->observation_full_vector_d2h_count == 0,
          "post-destroy unresolved snapshot invalidates without false counting");
#else
    fullmag::fdm::Context instrumented{};
    instrumented.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    instrumented.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    instrumented.enable_exchange = true;
    instrumented.execution_receipt->device_ordinal = 3;
    fullmag::fdm::fullmag_fdm_record_setup_full_vector_h2d(instrumented, 24);
    fullmag::fdm::fullmag_fdm_commit_operator_residency(instrumented);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented);
    check(receipt.execution_class == FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT,
          "instrumented Context maps to device-resident receipt semantics");
    check(receipt.setup_full_vector_h2d_count == 1 &&
              receipt.setup_full_vector_h2d_bytes == 24,
          "instrumented setup transfer remains separate from the hot loop");

    check(receipt.device_ordinal == 3,
          "receipt uses the device ordinal captured by Context creation");
    fullmag::fdm::fullmag_fdm_record_hot_loop_full_vector_h2d(instrumented, 24);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented);
    check(receipt.hot_loop_full_vector_h2d_count == 1 &&
              receipt.hot_loop_full_vector_h2d_bytes == 24,
          "host diagnostic exposes injected full-vector H2D violation");
    fullmag::fdm::fullmag_fdm_record_hot_loop_full_vector_d2h(instrumented, 24);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented);
    check(receipt.hot_loop_full_vector_d2h_count == 1 &&
              receipt.hot_loop_full_vector_d2h_bytes == 24,
          "host diagnostic exposes injected full-vector D2H violation");
    fullmag::fdm::fullmag_fdm_record_hot_loop_host_compute(instrumented);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented);
    check(receipt.hot_loop_host_compute_count == 1,
          "host diagnostic exposes injected host-compute violation");
    fullmag::fdm::fullmag_fdm_record_observation_full_vector_d2h(instrumented, 24);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented);
    check(receipt.observation_full_vector_d2h_count == 1 &&
              receipt.hot_loop_full_vector_d2h_count == 1,
          "observation D2H is measured without contaminating hot-loop D2H");
    fullmag::fdm::fullmag_fdm_mark_actual_operator_host(
        instrumented, FULLMAG_FDM_OPERATOR_EXCHANGE);
    receipt = fullmag::fdm::fullmag_fdm_make_execution_receipt(instrumented);
    check(receipt.host_operator_mask != 0 && receipt.fallback_count == 1,
          "actual host execution increments fallback and fails closed");
#endif

    std::puts("FDM GPU device residency receipt contract: PASS");
    return 0;
}
