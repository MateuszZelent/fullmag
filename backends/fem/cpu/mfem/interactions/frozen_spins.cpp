/*
 * Native FEM Frozen Spins runtime-owner source contract.
 *
 * This source owns host storage (managed u8 mask + AoS-3 f64 reference) and the
 * pure AoS-3 projection math used by both the FEM CPU RK path and a future
 * device-resident lane. Mask/reference validation and the single-capture rule
 * are centralized here so no runtime caller can silently cast the constraint
 * onto the wrong domain.
 */
#include "cpu/mfem/interactions/frozen_spins.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>

namespace fullmag::fem {

namespace {

// Per-node reference length factor for a dense AoS-3 frozen descriptor.
constexpr std::size_t kReferenceLengthFactor = 3u;

} // namespace

FrozenSpins::FrozenSpins() = default;

bool FrozenSpins::import_descriptor(
    const uint8_t* frozen_mask,
    std::size_t frozen_mask_len,
    const double* frozen_reference_xyz,
    std::size_t frozen_reference_len,
    std::size_t true_dof_count,
    std::size_t active_candidate_dof_count,
    const char* fingerprint,
    std::string& error,
    uint64_t activation_epoch)
{
    // Reset to a clean disabled state before validating so a fresh fail-closed
    // path never leaves a stale descriptor behind.
    frozen_mask_.clear();
    references.clear();
    fingerprint_ = fingerprint ? std::string(fingerprint) : std::string();
    activation_epoch_ = activation_epoch > 0 ? activation_epoch : 1;

    const bool empty_descriptor =
        (frozen_mask == nullptr) && (frozen_reference_xyz == nullptr);
    if (empty_descriptor) {
        if (frozen_mask_len != 0 || frozen_reference_len != 0) {
            error = "frozen_spins_descriptor_invalid: null pointers given with non-zero length";
            return false;
        }
        enabled_ = false;
        return true;
    }

    // Both pointers must be set in one activation snapshot. A single pointer is
    // malformed and must never be silently coerced into a material attribute.
    if ((frozen_mask == nullptr) != (frozen_reference_xyz == nullptr)) {
        error = "frozen_spins_descriptor_invalid: frozen spins descriptor requires "
                "both frozen_mask and frozen_reference_xyz, only one was given";
        return false;
    }

    // The FEM descriptor is dense over the live true DOF. Lengths are checked
    // before any indexing so a short descriptor can never be truncated into a
    // valid-looking buffer.
    if (frozen_mask_len != true_dof_count) {
        error = "frozen_spins_mask_length_mismatch: expected "
                + std::to_string(true_dof_count)
                + " but observed " + std::to_string(frozen_mask_len);
        return false;
    }
    if (frozen_reference_len != kReferenceLengthFactor * true_dof_count) {
        error = "frozen_spins_reference_length_mismatch: expected length "
                + std::to_string(kReferenceLengthFactor * true_dof_count)
                + " but observed " + std::to_string(frozen_reference_len);
        return false;
    }

    // Reject a descriptor that names more frozen DOFs than the available active
    // candidate DOFs, so a stale or partial selection can never enter runtime
    // state.
    for (std::size_t node = 0; node < frozen_mask_len; ++node) {
        if (frozen_mask[node] != 0) {
            if (active_candidate_dof_count == 0) {
                error = "frozen_spins_active_candidate_mismatch: "
                        + std::to_string(active_candidate_dof_count)
                        + " active candidate DOFs but frozen_mask requires frozen DOFs";
                return false;
            }
        }
    }

    // Validate pointer contents before committing storage.
    for (std::size_t index = 0; index < true_dof_count; ++index) {
        const double r0 = frozen_reference_xyz[3 * index + 0];
        const double r1 = frozen_reference_xyz[3 * index + 1];
        const double r2 = frozen_reference_xyz[3 * index + 2];
        if (!std::isfinite(r0) || !std::isfinite(r1) || !std::isfinite(r2)) {
            error = "frozen_spins_reference_non_finite: frozen reference value at true "
                    "DOF " + std::to_string(index) + " is non-finite";
            return false;
        }
    }

    frozen_mask_.assign(frozen_mask, frozen_mask + frozen_mask_len);
    references.assign(
        frozen_reference_xyz, frozen_reference_xyz + frozen_reference_len);
    enabled_ = true;
    return true;
}

std::size_t FrozenSpins::frozen_count() const
{
    std::size_t frozen = 0;
    for (uint8_t bit : frozen_mask_) {
        if (bit != 0) ++frozen;
    }
    return frozen;
}

void FrozenSpins::project_onto_reference(std::vector<double>& m_xyz) const
{
    if (!enabled_) {
        return;
    }
    const std::size_t count = std::min(m_xyz.size() / 3u, frozen_mask_.size());
    for (std::size_t node = 0; node < count; ++node) {
        if (frozen_mask_[node] != 0) {
            const std::size_t base = 3u * node;
            m_xyz[base + 0] = references[base + 0];
            m_xyz[base + 1] = references[base + 1];
            m_xyz[base + 2] = references[base + 2];
        }
    }
}

void FrozenSpins::zero_frozen_rhs(std::vector<double>& rhs_xyz) const
{
    if (!enabled_) {
        return;
    }
    const std::size_t count = std::min(rhs_xyz.size() / 3u, frozen_mask_.size());
    for (std::size_t node = 0; node < count; ++node) {
        if (frozen_mask_[node] != 0) {
            const std::size_t base = 3u * node;
            rhs_xyz[base + 0] = 0.0;
            rhs_xyz[base + 1] = 0.0;
            rhs_xyz[base + 2] = 0.0;
        }
    }
}

} // namespace fullmag::fem
