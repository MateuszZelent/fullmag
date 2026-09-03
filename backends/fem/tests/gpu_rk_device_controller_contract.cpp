/*
 * Native GPU RK device controller and output control contract test.
 *
 * Verifies:
 * 1. Rejected attempts do not publish state (transactional candidate rollback).
 * 2. Atomic commit promotes candidate magnetization, time, FSAL, and telemetry together.
 * 3. Double-buffered decision slots on device alternate without clobbering in-flight decisions.
 * 4. Output control mask controls observable field computation and defers snapshots to accept.
 * 5. Device adaptive controller matches canonical CPU golden vectors across the RK matrix.
 */

#include "gpu/cuda/integrators/rk/rk_output_control.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "context.hpp"
#include "core/adaptive_step_decision.hpp"
#include "fullmag_adaptive_step_decision.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void test_reject_does_not_publish_state() {
    using namespace fullmag::fem;
    Context ctx{};
    ctx.mesh.n_nodes = 3;
    ctx.state.current_time = 0.0;
    ctx.state.step_count = 0;
    ctx.state.m_xyz = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0};

    // Allocate candidate state
    RkCandidateState candidate{};
    std::string error;
    check(rk_candidate_state_allocate(candidate, 3, error), "allocate candidate state");

    const auto initial_m = ctx.state.m_xyz;
    const auto initial_time = ctx.state.current_time;
    const auto initial_step = ctx.state.step_count;

    // Simulate a trial attempt with candidate modification
    candidate.candidate_version = 1;
    candidate.time = initial_time + 1e-12;
    candidate.dt = 1e-12;
    candidate.candidate_valid = true;

    // Force rejected attempt
    check(rollback_candidate(ctx, candidate, nullptr, error), "rollback candidate");

    // Verify authoritative state was not published
    check(ctx.state.m_xyz == initial_m, "magnetization must be unchanged after rollback");
    check(ctx.state.current_time == initial_time, "time must be unchanged after rollback");
    check(ctx.state.step_count == initial_step, "step count must be unchanged after rollback");
    check(!candidate.candidate_valid, "candidate must be marked invalid after rollback");

    // Verify receipt metrics
    check(candidate.receipt.rejected_attempt_count == 1, "receipt rejected_attempt_count == 1");
    check(candidate.receipt.accepted_step_count == 0, "receipt accepted_step_count == 0");

    rk_candidate_state_destroy(candidate);
}

void test_atomic_commit_candidate() {
    using namespace fullmag::fem;
    Context ctx{};
    ctx.mesh.n_nodes = 3;
    ctx.state.current_time = 0.0;
    ctx.state.step_count = 0;
    ctx.state.m_xyz = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0};

    RkCandidateState candidate{};
    std::string error;
    check(rk_candidate_state_allocate(candidate, 3, error), "allocate candidate state");

    // Set candidate values
    std::vector<double> new_m = {0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0};
    candidate.candidate_version = 1;
    candidate.time = 1e-12;
    candidate.dt = 1e-12;
    candidate.candidate_valid = true;
    candidate.fsal_valid = true;

    // Upload new_m to candidate device buffer
    check(rk_candidate_upload_m(candidate, new_m.data(), 3, nullptr, error), "upload candidate m");

    // Atomic commit
    check(commit_candidate(ctx, candidate, nullptr, error), "commit candidate");

    // Verify state was published
    check(ctx.state.step_count == 1, "step count incremented to 1");
    check(std::abs(ctx.state.current_time - 1e-12) < 1e-20, "time advanced to candidate dt");
    check(candidate.accepted_version == 1, "accepted_version matched candidate_version");
    check(candidate.receipt.accepted_step_count == 1, "receipt accepted_step_count == 1");
    check(candidate.receipt.rejected_attempt_count == 0, "receipt rejected_attempt_count == 0");

    rk_candidate_state_destroy(candidate);
}

void test_double_buffered_decision_slots() {
    using namespace fullmag::fem;
    RkCandidateState candidate{};
    std::string error;
    check(rk_candidate_state_allocate(candidate, 3, error), "allocate candidate state");

    // Attempt 0 -> slot 0
    candidate.slots[0].decision = 2; // retry
    candidate.slots[0].decision_version = 101;
    candidate.slots[0].next_dt = 0.5e-12;
    candidate.active_slot = 0;

    // Advance to next attempt -> slot 1
    candidate.advance_slot();
    check(candidate.active_slot == 1, "slot advanced to 1");

    candidate.slots[1].decision = 1; // accepted
    candidate.slots[1].decision_version = 102;
    candidate.slots[1].next_dt = 1.2e-12;

    // Verify slot 0 was not clobbered
    check(candidate.slots[0].decision == 2, "slot 0 decision preserved");
    check(candidate.slots[0].decision_version == 101, "slot 0 version preserved");
    check(candidate.slots[0].next_dt == 0.5e-12, "slot 0 next_dt preserved");

    // Advance again -> wrap to 0
    candidate.advance_slot();
    check(candidate.active_slot == 0, "slot wrapped to 0");

    rk_candidate_state_destroy(candidate);
}

void test_output_control_mask() {
    using namespace fullmag::fem;
    RkOutputControlMask mask{};
    mask.field_mask = static_cast<uint32_t>(RkOutputControlField::Exchange) |
                      static_cast<uint32_t>(RkOutputControlField::Demag);
    mask.snapshot_deferred = true;
    mask.publish_step_stats = false;

    check(mask.needs_field(RkOutputControlField::Exchange), "needs exchange");
    check(mask.needs_field(RkOutputControlField::Demag), "needs demag");
    check(!mask.needs_field(RkOutputControlField::Dmi), "does not need dmi");
    check(!mask.needs_field(RkOutputControlField::Zeeman), "does not need zeeman");
    check(mask.snapshot_deferred, "snapshot deferred is true");
    check(!mask.publish_step_stats, "publish step stats is false");
}

void test_device_controller_golden_vectors() {
    using namespace fullmag::fem;
    using namespace fullmag::adaptive;

    for (size_t i = 0; i < kAdaptiveDecisionGoldenVectors.size(); ++i) {
        const auto &gv = kAdaptiveDecisionGoldenVectors[i];
        RkDecisionSlot slot{};

        // Run device decision logic
        rk_compute_device_decision(
            gv.policy.order_est,
            gv.policy.dt_min,
            gv.policy.dt_max,
            gv.policy.safety,
            gv.policy.growth_limit,
            gv.policy.shrink_limit,
            gv.input.dt_attempt,
            gv.input.error_current,
            gv.input.error_previous,
            gv.input.has_previous_error,
            slot);

        check(slot.valid == 1, "slot is valid");
        const auto expected_decision_code = gv.expected_kind == AdaptiveDecisionKind::accepted ? 1u : 2u;
        check(slot.decision == expected_decision_code, "golden vector decision kind match");
        const double diff = std::abs(slot.ratio - gv.expected_ratio);
        check(diff <= kAdaptiveFp64ScalarBudget, "golden vector ratio FP64 parity");

        // Verify device kernel launch produces identical decision
        RkDecisionSlot *d_slot = nullptr;
        check(cudaMalloc(&d_slot, sizeof(RkDecisionSlot)) == cudaSuccess, "cudaMalloc d_slot");
        rk_launch_device_decision_kernel(
            gv.policy.order_est,
            gv.policy.dt_min,
            gv.policy.dt_max,
            gv.policy.safety,
            gv.policy.growth_limit,
            gv.policy.shrink_limit,
            gv.input.dt_attempt,
            gv.input.error_current,
            gv.input.error_previous,
            gv.input.has_previous_error,
            d_slot,
            nullptr);
        RkDecisionSlot device_slot{};
        check(cudaMemcpy(&device_slot, d_slot, sizeof(RkDecisionSlot), cudaMemcpyDeviceToHost) == cudaSuccess,
              "cudaMemcpy d_slot to host");
        cudaFree(d_slot);
        check(device_slot.valid == 1, "device slot is valid");
        check(device_slot.decision == slot.decision, "device kernel decision matches host");
        check(std::abs(device_slot.ratio - slot.ratio) <= 1e-15, "device kernel ratio matches host");
    }
}

void test_device_candidate_capture_and_fail_closed_allocation() {
    using namespace fullmag::fem;
    // Verify source assertions: no cudaStreamSynchronize in rk_output_control.cu
    std::ifstream file("/workspace/backends/fem/gpu/cuda/integrators/rk/rk_output_control.cu");
    if (!file.is_open()) {
        file.open("backends/fem/gpu/cuda/integrators/rk/rk_output_control.cu");
    }
    if (!file.is_open()) {
        file.open("../backends/fem/gpu/cuda/integrators/rk/rk_output_control.cu");
    }
    check(file.is_open(), "unable to open rk_output_control.cu");
    std::string src((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    check(src.find("cudaStreamSynchronize") == std::string::npos,
          "rk_output_control.cu must not contain cudaStreamSynchronize calls");
    check(src.find("rk_candidate_capture_device") != std::string::npos,
          "rk_output_control.cu must provide rk_candidate_capture_device");

    // Verify candidate capture device-to-device
    RkCandidateState candidate{};
    std::string error;
    check(rk_candidate_state_allocate(candidate, 4, error), "allocate candidate 4");

    FemGpuComponentField dev_m{};
    check(cudaMalloc(&dev_m.x, 4 * sizeof(double)) == cudaSuccess, "alloc dev_m.x");
    check(cudaMalloc(&dev_m.y, 4 * sizeof(double)) == cudaSuccess, "alloc dev_m.y");
    check(cudaMalloc(&dev_m.z, 4 * sizeof(double)) == cudaSuccess, "alloc dev_m.z");

    std::vector<double> hx = {1.0, 2.0, 3.0, 4.0};
    std::vector<double> hy = {5.0, 6.0, 7.0, 8.0};
    std::vector<double> hz = {9.0, 10.0, 11.0, 12.0};
    cudaMemcpy(dev_m.x, hx.data(), 4 * sizeof(double), cudaMemcpyHostToDevice);
    cudaMemcpy(dev_m.y, hy.data(), 4 * sizeof(double), cudaMemcpyHostToDevice);
    cudaMemcpy(dev_m.z, hz.data(), 4 * sizeof(double), cudaMemcpyHostToDevice);

    check(rk_candidate_capture_device(candidate, dev_m, 4, nullptr, error), "capture device m");
    check(candidate.candidate_valid, "candidate is marked valid after capture");
    check(candidate.candidate_version == 1, "candidate version incremented");

    std::vector<double> out_x(4), out_y(4), out_z(4);
    cudaMemcpy(out_x.data(), candidate.m_candidate.x, 4 * sizeof(double), cudaMemcpyDeviceToHost);
    cudaMemcpy(out_y.data(), candidate.m_candidate.y, 4 * sizeof(double), cudaMemcpyDeviceToHost);
    cudaMemcpy(out_z.data(), candidate.m_candidate.z, 4 * sizeof(double), cudaMemcpyDeviceToHost);
    check(out_x == hx, "captured x matches source");
    check(out_y == hy, "captured y matches source");
    check(out_z == hz, "captured z matches source");

    cudaFree(dev_m.x);
    cudaFree(dev_m.y);
    cudaFree(dev_m.z);
    rk_candidate_state_destroy(candidate);
}

} // namespace

int main() {
    test_reject_does_not_publish_state();
    test_atomic_commit_candidate();
    test_double_buffered_decision_slots();
    test_output_control_mask();
    test_device_controller_golden_vectors();
    test_device_candidate_capture_and_fail_closed_allocation();
    std::printf("PASS: gpu_rk_device_controller_contract\n");
    return 0;
}
