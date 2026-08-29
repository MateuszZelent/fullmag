#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

enum class AosVectorFieldSpace : std::uint8_t {
    local_nodes = 0,
};

/*
 * Immutable typed map between the full local-node state space and the
 * periodic reduced (true-node) space. Empty periodic topology is represented
 * as an identity map with null index arrays and equal local/true extents.
 */
struct PeriodicNodeMapView {
    const std::uint32_t *local_to_true = nullptr;
    const std::uint32_t *true_representatives = nullptr;
    std::size_t local_node_count = 0;
    std::size_t true_node_count = 0;
    std::uint64_t revision = 0;

    bool reduced() const noexcept { return local_to_true != nullptr; }
};

/*
 * Typed boundary for a mutable AoS vector field.
 *
 * The view is only valid for the storage and map revision checked by
 * bind_local_node_aos_vector_field. It prevents a local-node buffer from
 * being passed as an unlabelled true-DOF field at the state boundary.
 */
struct AosVectorFieldView {
    double *data = nullptr;
    std::size_t node_count = 0;
    AosVectorFieldSpace space = AosVectorFieldSpace::local_nodes;
    std::uint64_t periodic_map_revision = 0;
};

struct ConstAosVectorFieldView {
    const double *data = nullptr;
    std::size_t node_count = 0;
    AosVectorFieldSpace space = AosVectorFieldSpace::local_nodes;
    PeriodicNodeMapView periodic_map{};
};

struct RepresentationAuditCounters {
    std::uint64_t representation_copy_count = 0;
    std::uint64_t gather_scatter_bytes = 0;
    std::uint64_t invalid_space_assertion_count = 0;
    std::uint64_t hot_loop_representation_copy_count = 0;
    std::uint64_t hot_loop_gather_scatter_bytes = 0;
};

struct RepresentationAuditRuntimeState {
    mutable RepresentationAuditCounters counters{};
};

bool bind_periodic_node_map(
    const Context &ctx,
    PeriodicNodeMapView &view,
    std::string &error);

bool bind_local_node_aos_vector_field(
    const Context &ctx,
    std::vector<double> &field_xyz,
    AosVectorFieldView &view,
    std::string &error);

bool bind_local_node_aos_vector_field(
    const Context &ctx,
    const std::vector<double> &field_xyz,
    ConstAosVectorFieldView &view,
    std::string &error);

#if FULLMAG_HAS_MFEM_STACK
/*
 * Canonical adapter between authoritative local-node AoS state and the three
 * scalar MFEM GridFunctions. The reverse direction performs an explicit
 * GridFunction local -> MFEM true DOF -> local -> AoS round-trip using
 * setup-owned workspaces. Both directions reject inconsistent periodic
 * classes before publishing a converted state.
 */
bool copy_local_node_aos_to_mfem_state(
    Context &ctx,
    const std::vector<double> &local_aos,
    std::string &error);

bool copy_mfem_state_to_local_node_aos(
    Context &ctx,
    std::vector<double> &local_aos,
    std::string &error);
#endif

/*
 * Split an AoS-3 vector field into component arrays.
 *
 * The input layout is `[x0,y0,z0,x1,y1,z1,...]`. Component buffers are resized
 * to the node count inferred from the input.
 */
void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z);

/*
 * Update existing component buffers from an AoS-3 vector field.
 *
 * When buffer sizes do not match the inferred node count, the function falls
 * back to the resizing unpack path. This preserves reusable MFEM host buffers
 * while keeping shape changes correct.
 */
void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z);

/*
 * Pack component arrays into an AoS-3 vector field.
 */
void pack_components_to_aos(
    const std::vector<double> &x,
    const std::vector<double> &y,
    const std::vector<double> &z,
    std::vector<double> &aos);

/*
 * Normalize active magnetic nodes in an AoS-3 reduced-magnetization field.
 *
 * Active nodes must be finite and have a normal (non-zero, non-subnormal)
 * vector norm. Empty masks are treated as fully magnetic. Nonmagnetic nodes
 * are checked for finite values but otherwise left unchanged.
 */
bool normalize_active_magnetization_aos(
    const Context &ctx,
    std::vector<double> &m_xyz,
    std::string &error);

/*
 * Project an AoS-3 local-node field onto static periodic node classes. It
 * validates the local-node shape and periodic map before changing the field,
 * and fails closed on mismatch.
 */
bool project_static_periodic_aos_checked(
    const Context &ctx,
    std::vector<double> &field_xyz,
    std::string &error);

RepresentationAuditCounters representation_audit_snapshot(const Context &ctx);

} // namespace fullmag::fem
