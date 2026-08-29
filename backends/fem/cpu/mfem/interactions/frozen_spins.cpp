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

#include "context.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <utility>

namespace fullmag::fem {

namespace {

// Per-node reference length factor for a dense AoS-3 frozen descriptor.
constexpr std::size_t kReferenceLengthFactor = 3u;

} // namespace

FrozenSpins::FrozenSpins() = default;

bool initialize_frozen_spins_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    ctx.frozen_spins = FrozenSpins{};
    PeriodicNodeMapView map;
    if (!bind_periodic_node_map(ctx, map, error)) {
        error = "frozen_spins_periodic_map_invalid: " + error;
        return false;
    }
    if (!ctx.mesh.magnetic_node_mask.empty() &&
        ctx.mesh.magnetic_node_mask.size() != map.local_node_count) {
        error = "frozen_spins_magnetic_mask_length_mismatch";
        return false;
    }
    const std::size_t active_candidates = ctx.mesh.magnetic_node_mask.empty()
        ? map.local_node_count
        : static_cast<std::size_t>(std::count_if(
            ctx.mesh.magnetic_node_mask.begin(),
            ctx.mesh.magnetic_node_mask.end(),
            [](uint8_t active) { return active != 0u; }));
    FrozenSpins candidate;
    const std::string fingerprint =
        "mesh_p1_local_nodes_v1:periodic_revision=" + std::to_string(map.revision);
    if (!candidate.import_descriptor(
            plan.frozen_mask,
            static_cast<std::size_t>(plan.frozen_mask_len),
            plan.frozen_reference_xyz,
            static_cast<std::size_t>(plan.frozen_reference_len),
            map.local_node_count,
            active_candidates,
            fingerprint.c_str(),
            error)) {
        return false;
    }
    if (!candidate.enabled()) {
        ctx.frozen_spins = std::move(candidate);
        return true;
    }
    const auto &mask = candidate.mask();
    const auto &reference = candidate.reference();
    for (size_t node = 0; node < map.local_node_count; ++node) {
        if (mask[node] != 0u && !ctx.mesh.magnetic_node_mask.empty() &&
            ctx.mesh.magnetic_node_mask[node] == 0u) {
            error = "frozen_spins_inactive_node: local node " + std::to_string(node) +
                " is outside the magnetic state domain";
            return false;
        }
        if (!map.reduced()) {
            continue;
        }
        const size_t true_node = static_cast<size_t>(map.local_to_true[node]);
        const size_t representative =
            static_cast<size_t>(map.true_representatives[true_node]);
        if (mask[node] != mask[representative]) {
            error = "frozen_spins_periodic_class_membership_mismatch: local node " +
                std::to_string(node) + " disagrees with representative " +
                std::to_string(representative);
            return false;
        }
        if (mask[node] == 0u) {
            continue;
        }
        for (size_t component = 0; component < 3u; ++component) {
            if (reference[node * 3u + component] !=
                reference[representative * 3u + component]) {
                error = "frozen_spins_periodic_reference_mismatch: local node " +
                    std::to_string(node) + " disagrees with representative " +
                    std::to_string(representative);
                return false;
            }
        }
    }
    ctx.frozen_spins = std::move(candidate);
    return true;
}

bool FrozenSpins::import_descriptor(
    const uint8_t* frozen_mask,
    std::size_t frozen_mask_len,
    const double* frozen_reference_xyz,
    std::size_t frozen_reference_len,
    std::size_t local_node_count,
    std::size_t active_candidate_node_count,
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

    // The imported descriptor is dense over the live local state nodes. The
    // public plan adapter validates periodic true classes before this call.
    // Lengths are checked before any indexing so a short descriptor can never
    // be truncated into a valid-looking buffer.
    if (frozen_mask_len != local_node_count) {
        error = "frozen_spins_mask_length_mismatch: expected "
                + std::to_string(local_node_count)
                + " but observed " + std::to_string(frozen_mask_len);
        return false;
    }
    if (frozen_reference_len != kReferenceLengthFactor * local_node_count) {
        error = "frozen_spins_reference_length_mismatch: expected length "
                + std::to_string(kReferenceLengthFactor * local_node_count)
                + " but observed " + std::to_string(frozen_reference_len);
        return false;
    }

    // Reject a non-empty selection when the mesh exposes no active magnetic
    // candidate nodes. The public plan adapter performs the per-node domain
    // check before committing this candidate.
    for (std::size_t node = 0; node < frozen_mask_len; ++node) {
        if (frozen_mask[node] != 0) {
            if (active_candidate_node_count == 0) {
                error = "frozen_spins_active_candidate_mismatch: "
                        + std::to_string(active_candidate_node_count)
                        + " active candidate nodes but frozen_mask requires frozen nodes";
                return false;
            }
        }
    }

    // Validate pointer contents before committing storage.
    for (std::size_t index = 0; index < local_node_count; ++index) {
        const double r0 = frozen_reference_xyz[3 * index + 0];
        const double r1 = frozen_reference_xyz[3 * index + 1];
        const double r2 = frozen_reference_xyz[3 * index + 2];
        if (!std::isfinite(r0) || !std::isfinite(r1) || !std::isfinite(r2)) {
            error = "frozen_spins_reference_non_finite: frozen reference value at local "
                    "node " + std::to_string(index) + " is non-finite";
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
