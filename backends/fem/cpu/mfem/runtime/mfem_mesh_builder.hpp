#pragma once

#include <memory>
#include <string>

namespace mfem {
class Mesh;
class FiniteElementSpace;
}

namespace fullmag::fem {

struct FemMeshRuntimeState;

/*
 * Translate canonical Fullmag topology into an MFEM mesh.
 *
 * This module owns cell/facet type mappings, local permutations, MFEM
 * attributes, face ownership, and general mesh finalization. It does not own
 * physics capability, materials, operators, or runtime-device policy.
 * Builder acceptance therefore does not make a topology solver-executable.
 */
#if FULLMAG_HAS_MFEM_STACK
bool build_mfem_mesh(
    const FemMeshRuntimeState &source,
    std::unique_ptr<mfem::Mesh> &mesh,
    std::string &error);

// Check the actual scalar local DOF indices before any node-indexed field is
// uploaded. This does not certify MFEM true DOF or periodic-class numbering.
bool verify_mfem_local_node_ordering(
    const FemMeshRuntimeState &source,
    const mfem::FiniteElementSpace &space,
    std::string &error);
#endif

} // namespace fullmag::fem
