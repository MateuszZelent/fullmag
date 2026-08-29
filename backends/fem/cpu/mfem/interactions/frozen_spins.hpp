#pragma once

#include "fullmag_fem.h"

#include <vector>
#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Import the public node-selection descriptor into the local AoS state space.
 * Periodic classes must have identical membership and frozen references, and
 * inactive Airbox nodes cannot be frozen.
 */
bool initialize_frozen_spins_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

/*
 * Native FEM Frozen Spins runtime owner.
 *
 * This module owns the frozen reference descriptor for the native FEM runtime.
 * The mask is indexed by FEM local grid node id, matching dense
 * `ctx.state.m_xyz`, so it has exactly one u8 per node and the reference holds
 * three f64 per node — mirroring dense ctx.state.m_xyz.
 *
 * Responsibilities:
 *   - length validation of the imported descriptor,
 *   - host-side storage of the mask (u8) and reference (AoS-3 f64),
 *   - single-capture-at-activation with an activation epoch,
 *   - host AoS-3 projection of state, RHS, and candidate magnetization onto
 *     the activation reference on every observed step, and
 *   - host RHS zero-on-frozen projection for each RK stage and the final step.
 *
 * It does not own CUDA device memory, GPU kernels, time integration, or the
 * accept/reject policy. The pure projector operates on a plain
 * AoS-3 vector so the same math is reused by a future device-resident lane.
 */
class FrozenSpins {
public:
    FrozenSpins();
    ~FrozenSpins() = default;

    FrozenSpins(const FrozenSpins&) = default;
    FrozenSpins& operator=(const FrozenSpins&) = default;
    FrozenSpins(FrozenSpins&&) noexcept = default;
    FrozenSpins& operator=(FrozenSpins&&) noexcept = default;

    /*
     * Validate the descriptor and import the mask/reference into managed host
     * storage.
     *
     * The descriptor is accepted when:
     *   - both pointers are null (no constraint requested), OR
     *   - both pointers are set, the mask length equals the local state-node
     *     count, and the reference length equals three times that count.
     *
     * Any other combination fails closed with a
     * frozen_spins_fem_unqualified error. The active candidate DOF count is
     * required so a malformed payload can never be silently cast onto the wrong
     * domain. On success the module becomes enabled; on failure it is left
     * disabled and storage stays empty. The returned error is clear only when
     * the module is non-empty on success.
     */
    bool import_descriptor(
        const uint8_t* frozen_mask,
        std::size_t frozen_mask_len,
        const double* frozen_reference_xyz,
        std::size_t frozen_reference_len,
        std::size_t local_node_count,
        std::size_t active_candidate_node_count,
        const char* fingerprint,
        std::string& error,
        uint64_t activation_epoch = 1);

    /*
     * Whether a constraint is active.
     *
     * True only for a successfully imported non-empty descriptor. An empty
     * descriptor (no constraint requested) is disabled, so every call site reads
     * this as a single guard instead of repeating the pointer-checks.
     */
    bool enabled() const { return enabled_; }

    /*
     * Pure AoS-3 state projection on the host.
     *
     * Stores the activation reference on every frozen node. Safe to call many
     * times and never reads past the descriptor contents.
     */
    void project_onto_reference(std::vector<double>& m_xyz) const;

    /*
     * Pure AoS-3 RHS zero-on-frozen projection on the host.
     *
     * Sets each input frozen triple to zero. Safe to call many times.
     */
    void zero_frozen_rhs(std::vector<double>& rhs_xyz) const;

    /*
     * Number of frozen local state nodes.
     */
    std::size_t frozen_count() const;

    /*
     * The mask (u8) as a vector indexed by local state node.
     */
    const std::vector<uint8_t>& mask() const { return frozen_mask_; }

    /*
     * The reference (m*) as an AoS-3 vector.
     */
    const std::vector<double>& reference() const { return references; }

    /*
     * Fingerprint of the topology the descriptor was imported against.
     */
    const std::string& fingerprint() const { return fingerprint_; }

    /*
     * Epoch at which the descriptor was imported.
     */
    uint64_t activation_epoch() const { return activation_epoch_; }

private:
    std::vector<uint8_t> frozen_mask_;
    std::vector<double> references;
    std::string fingerprint_;
    uint64_t activation_epoch_ = 0;
    bool enabled_ = false;
};

} // namespace fullmag::fem
