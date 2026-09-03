#pragma once

#include "context.hpp"
#include "gpu/cuda/state/component_field.hpp"

#include <cuda_runtime.h>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

enum class RkOutputControlField : uint32_t {
    None = 0,
    Exchange = 1u << 0,
    Demag = 1u << 1,
    Zeeman = 1u << 2,
    Anisotropy = 1u << 3,
    Dmi = 1u << 4,
    Magnetoelastic = 1u << 5,
    Thermal = 1u << 6,
    Torque = 1u << 7,
    Energy = 1u << 8,
    All = 0xFFFFFFFFu
};

struct RkOutputControlMask {
    uint32_t field_mask = static_cast<uint32_t>(RkOutputControlField::All);
    bool snapshot_deferred = true;
    bool publish_step_stats = true;
    uint32_t output_stride = 1u;

    bool needs_field(RkOutputControlField field) const {
        return (field_mask & static_cast<uint32_t>(field)) != 0;
    }
};

struct RkDecisionSlot {
    uint32_t decision = 0; // 0 = pending, 1 = accepted, 2 = retry, 3 = failed
    uint32_t reason = 0;   // AdaptiveDecisionReason code
    double error_norm = 0.0;
    double max_norm_defect = 0.0;
    double max_spin_rotation = 0.0;
    double dt_attempt = 0.0;
    double next_dt = 0.0;
    double ratio = 1.0;
    uint64_t decision_version = 0;
    uint32_t valid = 0;
};

struct RkCandidateReceipt {
    uint64_t accepted_step_count = 0;
    uint64_t rejected_attempt_count = 0;
    uint64_t failed_attempt_count = 0;
};

struct RkCandidateState {
    FemGpuComponentField m_candidate{};
    std::vector<double> host_m{};
    uint64_t node_count = 0;
    uint64_t candidate_version = 0;
    uint64_t accepted_version = 0;
    bool candidate_valid = false;
    bool fsal_valid = false;
    double time = 0.0;
    double dt = 0.0;
    RkDecisionSlot slots[2]{};
    RkDecisionSlot *d_slots = nullptr;
    uint32_t active_slot = 0;
    RkOutputControlMask mask{};
    RkCandidateReceipt receipt{};

    void advance_slot() {
        active_slot = (active_slot + 1) % 2;
    }
};

bool rk_candidate_state_allocate(
    RkCandidateState &candidate,
    uint64_t node_count,
    std::string &error);

void rk_candidate_state_destroy(
    RkCandidateState &candidate);

bool rk_candidate_upload_m(
    RkCandidateState &candidate,
    const double *host_m,
    uint64_t node_count,
    cudaStream_t stream,
    std::string &error);

bool commit_candidate(
    Context &ctx,
    RkCandidateState &candidate,
    cudaStream_t stream,
    std::string &error);

bool rollback_candidate(
    Context &ctx,
    RkCandidateState &candidate,
    cudaStream_t stream,
    std::string &error);

void rk_compute_device_decision(
    int order_est,
    double dt_min,
    double dt_max,
    double safety,
    double growth_limit,
    double shrink_limit,
    double dt_attempt,
    double error_current,
    double error_previous,
    bool has_previous_error,
    RkDecisionSlot &out_slot,
    cudaStream_t stream = nullptr);

void rk_launch_device_decision_kernel(
    int order_est,
    double dt_min,
    double dt_max,
    double safety,
    double growth_limit,
    double shrink_limit,
    double dt_attempt,
    double error_current,
    double error_previous,
    bool has_previous_error,
    RkDecisionSlot *d_out_slot,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
