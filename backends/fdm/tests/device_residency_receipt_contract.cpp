#include <cstddef>
#include <cstdint>
#include <cstring>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
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

}

extern "C" int fullmag_fdm_test_record_residency_violation_v1(
    fullmag_fdm_backend *handle,
    uint32_t violation_kind,
    uint64_t bytes);
extern "C" int fullmag_fdm_legacy_v1_client_query(
    void *handle,
    uint32_t *abi_version,
    uint32_t *struct_size,
    uint64_t *required_operator_mask,
    uint64_t *setup_h2d_count);

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
    const auto receipt_context = read(root / "backends/fdm/include/context.hpp");
    check(receipt_context.find("fullmag_fdm_note_effective_field_device_execution") ==
              std::string::npos,
          "operator execution has no grouped effective-field receipt hook");
    check(receipt_context.find("fullmag_fdm_note_integrator_device_execution") ==
              std::string::npos,
          "operator execution has no grouped integrator receipt hook");
    check(receipt_context.find("fullmag_fdm_commit_successful_step_operator_execution") ==
              std::string::npos,
          "operator execution has no central blanket step commit");
    for (const auto *torque_family : {
             "FULLMAG_FDM_OPERATOR_ZHANG_LI_STT",
             "FULLMAG_FDM_OPERATOR_SLONCZEWSKI_STT",
             "FULLMAG_FDM_OPERATOR_SOT"}) {
        check(active_dispatch.find(torque_family) == std::string::npos,
              "central dispatch flags never claim torque-family execution");
    }
    for (const auto *relative : {
             "backends/fdm/gpu/cuda/integrators/llg_fp32.cu",
             "backends/fdm/gpu/cuda/integrators/llg_fp64.cu",
             "backends/fdm/gpu/cuda/integrators/llg_rk4_fp32.cu",
             "backends/fdm/gpu/cuda/integrators/llg_rk4_fp64.cu",
             "backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu",
             "backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu",
             "backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu",
             "backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu",
             "backends/fdm/gpu/cuda/integrators/llg_abm3_fp32.cu",
             "backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu"}) {
        const auto source = read(root / relative);
        check(source.find("fullmag_fdm_note_llg_rhs_torque_device_launch") !=
                  std::string::npos,
              "every LLG workflow owns its torque-family launch receipt hook");
    }
    check(active_dispatch.find(
              "fullmag_fdm_accumulate_execution_receipt_audit(context_);") !=
              std::string::npos,
          "solver phase scope guard flushes receipt audit on every exit");
    check(active_dispatch.find("context_complete_solver_receipt_attempt") !=
              std::string::npos,
          "pending operator launches are completed before receipt commit");
    const auto runner_dispatch = read(root / "crates/fullmag-runner/src/dispatch.rs");
    const auto runner_preview = read(root / "crates/fullmag-runner/src/interactive_runtime.rs");
    check(runner_dispatch.find("finalize_after_outcome") != std::string::npos,
          "batch runner finalizes receipt for success and error outcomes");
    check(runner_preview.find("finalize_after_outcome") != std::string::npos,
          "both preview runners finalize receipt for success and error outcomes");
    static_assert(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 == 1u);
    static_assert(FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2 == 2u);
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
    static_assert(sizeof(fullmag_fdm_execution_receipt_v1) == 208u,
                  "legacy receipt ABI v1 remains byte-for-byte compatible");
#define FULLMAG_FDM_EXECUTION_RECEIPT_FIELD(type, name, offset) \
    static_assert(offsetof(fullmag_fdm_execution_receipt_v2, name) == offset);
#define FULLMAG_FDM_EXECUTION_RECEIPT_SIZE(size) \
    static_assert(sizeof(fullmag_fdm_execution_receipt_v2) == size);
#include "fullmag_fdm_execution_receipt_v2_layout.def"
#undef FULLMAG_FDM_EXECUTION_RECEIPT_SIZE
#undef FULLMAG_FDM_EXECUTION_RECEIPT_FIELD
    static_assert(sizeof(fullmag_fdm_execution_receipt_v2) == 240u);
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

    fullmag_fdm_execution_receipt_v2 invalid_v2{};
    std::memset(&invalid_v2, 0xa5, sizeof(invalid_v2));
    invalid_v2.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2 + 1;
    invalid_v2.struct_size = sizeof(invalid_v2);
    const auto unknown_v2 = invalid_v2;
    check(!fullmag::fdm::fullmag_fdm_execution_receipt_request_valid(invalid_v2),
          "unknown receipt ABI v2 version is rejected");
    check(std::memcmp(&invalid_v2, &unknown_v2, sizeof(invalid_v2)) == 0,
          "unknown v2 rejection leaves output byte-for-byte unchanged");
    invalid_v2.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
    invalid_v2.struct_size = sizeof(invalid_v2) - 1;
    const auto truncated_v2 = invalid_v2;
    check(!fullmag::fdm::fullmag_fdm_execution_receipt_request_valid(invalid_v2),
          "truncated receipt ABI v2 is rejected");
    check(std::memcmp(&invalid_v2, &truncated_v2, sizeof(invalid_v2)) == 0,
          "truncated v2 rejection leaves output byte-for-byte unchanged");
    invalid_v2.struct_size = sizeof(invalid_v2) + 1;
    const auto oversized_v2 = invalid_v2;
    check(!fullmag::fdm::fullmag_fdm_execution_receipt_request_valid(invalid_v2),
          "oversized receipt ABI v2 is rejected");
    check(std::memcmp(&invalid_v2, &oversized_v2, sizeof(invalid_v2)) == 0,
          "oversized v2 rejection leaves output byte-for-byte unchanged");

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

    struct RequiredFamilyFixture {
        uint64_t family;
        void (*configure)(fullmag::fdm::Context &);
    };
    const std::array<RequiredFamilyFixture, 19> required_family_fixtures{{
        {FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR, +[](fullmag::fdm::Context &) {}},
        {FULLMAG_FDM_OPERATOR_EXCHANGE, +[](fullmag::fdm::Context &ctx) { ctx.enable_exchange = true; }},
        {FULLMAG_FDM_OPERATOR_DEMAG, +[](fullmag::fdm::Context &ctx) { ctx.enable_demag = true; }},
        {FULLMAG_FDM_OPERATOR_DMI, +[](fullmag::fdm::Context &ctx) { ctx.has_interfacial_dmi = true; }},
        {FULLMAG_FDM_OPERATOR_ANISOTROPY, +[](fullmag::fdm::Context &ctx) { ctx.has_uniaxial_anisotropy = true; }},
        {FULLMAG_FDM_OPERATOR_REDUCTION, +[](fullmag::fdm::Context &) {}},
        {FULLMAG_FDM_OPERATOR_EXTERNAL_FIELD, +[](fullmag::fdm::Context &ctx) { ctx.has_external_field = true; }},
        {FULLMAG_FDM_OPERATOR_MASKS, +[](fullmag::fdm::Context &ctx) { ctx.has_active_mask = true; }},
        {FULLMAG_FDM_OPERATOR_MAGNETOELASTIC, +[](fullmag::fdm::Context &ctx) { ctx.has_magnetoelastic = true; }},
        {FULLMAG_FDM_OPERATOR_THERMAL, +[](fullmag::fdm::Context &ctx) { ctx.temperature = 300.0; }},
        {FULLMAG_FDM_OPERATOR_ZHANG_LI_STT, +[](fullmag::fdm::Context &ctx) { ctx.has_zhang_li_stt = true; }},
        {FULLMAG_FDM_OPERATOR_SLONCZEWSKI_STT, +[](fullmag::fdm::Context &ctx) { ctx.has_slonczewski_stt = true; }},
        {FULLMAG_FDM_OPERATOR_SOT, +[](fullmag::fdm::Context &ctx) { ctx.has_sot = true; }},
        {FULLMAG_FDM_OPERATOR_OERSTED, +[](fullmag::fdm::Context &ctx) { ctx.has_oersted_field = true; }},
        {FULLMAG_FDM_OPERATOR_BOUNDARY_CORRECTION, +[](fullmag::fdm::Context &ctx) { ctx.boundary_tier = 1; }},
        {FULLMAG_FDM_OPERATOR_MULTILAYER_TRANSFER, +[](fullmag::fdm::Context &ctx) {
             ctx.has_multilayer_plan_v2 = true;
             ctx.enable_demag = true;
             ctx.multilayer_kernels.emplace_back();
         }},
        {FULLMAG_FDM_OPERATOR_MULTILAYER_INTERACTIONS, +[](fullmag::fdm::Context &ctx) {
             ctx.has_multilayer_plan_v2 = true;
             ctx.multilayer_layers.emplace_back();
         }},
        {FULLMAG_FDM_OPERATOR_MULTILAYER_DEMAG, +[](fullmag::fdm::Context &ctx) {
             ctx.has_multilayer_plan_v2 = true;
             ctx.enable_demag = true;
             ctx.multilayer_kernels.emplace_back();
         }},
        {FULLMAG_FDM_OPERATOR_GPU_TRANSPORT, +[](fullmag::fdm::Context &ctx) { ctx.gpu_transport_rhs.active = true; }},
    }};
    for (const auto &fixture : required_family_fixtures) {
        fullmag::fdm::Context minimal{};
        minimal.enable_exchange = false;
        minimal.enable_demag = false;
        fixture.configure(minimal);
        check((fullmag::fdm::fullmag_fdm_required_operator_mask(minimal) &
               fixture.family) != 0,
              "each of 19 operator families has a minimal required configuration");
    }
    fullmag::fdm::Context demag_off_multilayer{};
    demag_off_multilayer.enable_exchange = false;
    demag_off_multilayer.enable_demag = false;
    demag_off_multilayer.has_multilayer_plan_v2 = true;
    demag_off_multilayer.multilayer_layers.emplace_back();
    demag_off_multilayer.multilayer_kernels.emplace_back();
    const auto demag_off_required =
        fullmag::fdm::fullmag_fdm_required_operator_mask(demag_off_multilayer);
    check((demag_off_required & FULLMAG_FDM_OPERATOR_MULTILAYER_TRANSFER) == 0 &&
              (demag_off_required & FULLMAG_FDM_OPERATOR_MULTILAYER_DEMAG) == 0,
          "demag-off multilayer has no spurious transfer/demag unknown family");

    fullmag::fdm::ExecutionReceiptState pending_family{};
    fullmag::fdm::fullmag_fdm_require_operator(
        pending_family, FULLMAG_FDM_OPERATOR_EXCHANGE);
    fullmag::fdm::fullmag_fdm_resolve_operator_device(
        pending_family, FULLMAG_FDM_OPERATOR_EXCHANGE);
    fullmag::fdm::fullmag_fdm_begin_operator_execution_attempt(pending_family);
    fullmag::fdm::fullmag_fdm_note_operator_device_launch(
        pending_family, FULLMAG_FDM_OPERATOR_EXCHANGE);
    check(fullmag::fdm::fullmag_fdm_executed_unknown_operator_mask(pending_family) ==
              FULLMAG_FDM_OPERATOR_EXCHANGE,
          "successful launch remains pending until work completion");
    fullmag::fdm::fullmag_fdm_discard_operator_execution_attempt(pending_family);
    check(fullmag::fdm::fullmag_fdm_executed_unknown_operator_mask(pending_family) ==
              FULLMAG_FDM_OPERATOR_EXCHANGE,
          "launch failure discards pending family without execution claim");
    fullmag::fdm::fullmag_fdm_begin_operator_execution_attempt(pending_family);
    fullmag::fdm::fullmag_fdm_note_operator_device_launch(
        pending_family, FULLMAG_FDM_OPERATOR_EXCHANGE);
    fullmag::fdm::fullmag_fdm_commit_operator_execution_attempt(pending_family);
    check(fullmag::fdm::fullmag_fdm_executed_unknown_operator_mask(pending_family) == 0,
          "completed work commits its family-specific pending hook");

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

    auto concurrent_receipt = std::make_shared<fullmag::fdm::ExecutionReceiptState>();
    fullmag::fdm::Context concurrent_context{};
    concurrent_context.execution_receipt = concurrent_receipt;
    concurrent_context.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    concurrent_context.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    fullmag::fdm::AsyncTransferReceiptToken concurrent_transfer(
        concurrent_receipt, false, 24,
        fullmag::fdm::ReceiptTransferCadence::Observation);
    std::atomic<bool> start{false};
    std::thread async_complete([&] {
        while (!start.load(std::memory_order_acquire)) {}
        check(concurrent_transfer.complete(), "parallel async completion succeeds once");
    });
    std::thread synchronous_accounting([&] {
        while (!start.load(std::memory_order_acquire)) {}
        fullmag::fdm::fullmag_fdm_record_setup_full_vector_h2d(concurrent_context, 24);
    });
    start.store(true, std::memory_order_release);
    for (int sample = 0; sample != 1000; ++sample) {
        const auto snapshot =
            fullmag::fdm::fullmag_fdm_make_execution_receipt_v2(concurrent_context);
        check(snapshot.observation_full_vector_d2h_count <= 1,
              "parallel receipt snapshots never double-count async completion");
        check((snapshot.setup_full_vector_h2d_count == 0 &&
               snapshot.setup_full_vector_h2d_bytes == 0) ||
              (snapshot.setup_full_vector_h2d_count == 1 &&
               snapshot.setup_full_vector_h2d_bytes == 24),
              "parallel receipt snapshot observes coherent sync accounting");
    }
    async_complete.join();
    synchronous_accounting.join();
    const auto concurrent_final =
        fullmag::fdm::fullmag_fdm_make_execution_receipt_v2(concurrent_context);
    check(concurrent_final.observation_full_vector_d2h_count == 1 &&
              concurrent_final.observation_full_vector_d2h_bytes == 24 &&
              concurrent_final.setup_full_vector_h2d_count == 1 &&
              concurrent_final.setup_full_vector_h2d_bytes == 24,
          "parallel async and sync receipt accounting commits exactly once");

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
    uint32_t legacy_abi = 0;
    uint32_t legacy_size = 0;
    uint64_t legacy_required = 0;
    uint64_t legacy_setup_h2d = 0;
    check(fullmag_fdm_legacy_v1_client_query(
              handle, &legacy_abi, &legacy_size, &legacy_required,
              &legacy_setup_h2d) == FULLMAG_FDM_OK &&
              legacy_abi == 1 && legacy_size == 208 &&
              legacy_required == receipt.required_operator_mask &&
              legacy_setup_h2d == receipt.setup_full_vector_h2d_count,
          "frozen old-client translation unit queries the restored v1 ABI");
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
    fullmag::fdm::fullmag_fdm_set_device_ordinal(
        *instrumented.execution_receipt, 3);
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
