#pragma once

/*
 * Device/host control packet shared by one GPU RK attempt.
 *
 * The packet is deliberately separate from the generic scalar reduction
 * slots: those slots are also owned by final observables and relaxation.
 * Device kernels only set flags and publish already-reduced diagnostics;
 * accept/reject arithmetic remains in the canonical host policy until a
 * qualified device-decision implementation exists.
 */

#include <cstdint>

namespace fullmag::fem {

enum GpuRkAttemptFlag : uint64_t {
    GpuRkAttemptFlagNone = 0,
    GpuRkAttemptFlagInvalidNormalization = 1ull << 0,
    GpuRkAttemptFlagNonFiniteError = 1ull << 1,
    GpuRkAttemptFlagRotationViolation = 1ull << 2,
    GpuRkAttemptFlagNormViolation = 1ull << 3,
};

struct GpuRkAttemptControlPacket {
    uint64_t flags = GpuRkAttemptFlagNone;
    double error_norm = 0.0;
    double max_norm_defect = 0.0;
    double max_spin_rotation = 0.0;
    double suggested_dt = 0.0;
    uint32_t decision = 0;
    uint32_t reason = 0;
};

struct GpuRkAttemptControlDeviceState {
    GpuRkAttemptControlPacket *device = nullptr;
    GpuRkAttemptControlPacket *host_pinned = nullptr;
    bool host_pinned_owned = false;
};

} // namespace fullmag::fem
