#pragma once

#include <cstdint>

namespace mfem {
class Mesh;
}

namespace fullmag::fem {

struct Context;

/*
 * Immutable inputs that determine the assembled MFEM exchange operator.
 *
 * The revision values are content fingerprints captured during setup.  They
 * intentionally include geometry/topology, finite-element order, material
 * coefficient payloads, magnetic/periodic boundary data, and the selected
 * device realization.  Magnetization and source time are not part of this
 * key: changing either must remain a steady-state operator apply.
 */
struct OperatorDependencyKey {
    std::uint64_t mesh_topology_revision = 0;
    std::uint64_t mesh_geometry_revision = 0;
    std::uint32_t fe_order = 0;
    std::uint64_t material_coefficient_revision = 0;
    std::uint64_t boundary_revision = 0;
    std::uint64_t periodic_revision = 0;
    std::uint32_t device_mode = 0;
    std::int32_t device_index = -1;

    bool operator==(const OperatorDependencyKey &other) const noexcept
    {
        return mesh_topology_revision == other.mesh_topology_revision &&
            mesh_geometry_revision == other.mesh_geometry_revision &&
            fe_order == other.fe_order &&
            material_coefficient_revision == other.material_coefficient_revision &&
            boundary_revision == other.boundary_revision &&
            periodic_revision == other.periodic_revision &&
            device_mode == other.device_mode &&
            device_index == other.device_index;
    }

    bool operator!=(const OperatorDependencyKey &other) const noexcept
    {
        return !(*this == other);
    }
};

inline std::uint64_t operator_key_geometry_revision(
    const OperatorDependencyKey &key) noexcept
{
    return key.mesh_geometry_revision;
}

/*
 * Ownership boundary: the enclosing exchange-operator runtime owns this
 * value receipt together with its assembled forms, matrices, preconditioner,
 * and workspace.  The receipt itself owns only scalar counters and a copied
 * dependency key; it does not own MFEM objects, Context, Mesh, or device
 * storage.  A successful setup is published only after every owned runtime
 * resource is ready.  Applies then reuse that published state; an invalidated
 * key fails closed until a new setup is committed.  One runtime mutates its
 * receipt serially; callers must not share it across concurrent applies.
 */
struct OperatorLifecycleReceipt {
    OperatorDependencyKey active_key{};
    std::uint64_t setup_count = 0;
    std::uint64_t apply_count = 0;
    std::uint64_t reuse_count = 0;
    std::uint64_t invalidation_count = 0;
    std::uint64_t failed_setup_count = 0;
    bool setup_complete = false;
};

/*
 * Recompute the dependency key observed by the public MFEM runtime.  The
 * exchange field path uses this before every apply so mutations of an
 * operator input fail closed instead of silently reusing stale assembly.
 * This function only borrows Context and Mesh for the duration of the call;
 * it does not own, retain, mutate, or extend the lifetime of either object.
 */
OperatorDependencyKey make_exchange_operator_dependency_key(
    const Context &ctx,
    const mfem::Mesh &mesh,
    bool use_device);

} // namespace fullmag::fem
