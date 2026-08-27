#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>
#include <unordered_set>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime mesh state owned by the FEM mesh core module.
 *
 * The scalar counts and buffers hold imported topology, optional boundary/
 * marker metadata, static-periodic reduction maps, magnetic masks, and P1
 * nodal dual volumes. They are geometry/topology data consumed by interactions
 * and runtimes, not interaction outputs or material overrides.
 */
struct FemMeshRuntimeState {
    uint32_t n_nodes = 0;
    uint32_t n_elements = 0;
    uint32_t n_boundary_faces = 0;
    std::vector<double> nodes_xyz;
    std::vector<uint32_t> cell_types;
    std::vector<uint32_t> cell_offsets;
    std::vector<uint32_t> cell_nodes;
    std::vector<uint64_t> cell_global_ordinals;
    std::vector<uint32_t> cell_markers;
    std::vector<uint32_t> facet_types;
    std::vector<uint32_t> facet_roles;
    std::vector<uint32_t> facet_offsets;
    std::vector<uint32_t> facet_nodes;
    std::vector<uint64_t> facet_global_ordinals;
    std::vector<uint32_t> facet_markers;
    std::vector<uint32_t> periodic_node_pairs;
    std::vector<uint32_t> periodic_reduced_node;
    std::vector<uint32_t> periodic_representative_nodes;
    uint32_t periodic_reduced_node_count = 0;
    // Stable content revision for the local-node periodic reduction map.
    uint64_t periodic_map_revision = 0;
    std::unordered_set<uint32_t> periodic_boundary_marker_set;
    std::vector<uint8_t> magnetic_element_mask;
    std::vector<uint8_t> magnetic_node_mask;
    std::vector<double> node_volumes;
};

struct LocalEntityTopology {
    const uint8_t *offsets = nullptr;
    const uint8_t *nodes = nullptr;
    uint8_t entity_count = 0;
    uint8_t node_count = 0;
};

struct ElementTopology {
    uint8_t arity = 0;
    LocalEntityTopology faces{};
    LocalEntityTopology edges{};
};

bool element_topology(uint32_t cell_type, ElementTopology &topology);

/*
 * Own FEM mesh topology helpers used while importing a native FEM plan.
 *
 * The module covers static periodic node-class reduction, per-periodic-class
 * scalar material validation, and P1 nodal dual-volume accumulation.
 *
 * It does not own base scalar plan fields, material fields, state
 * initialization, field buffers, runtime devices, or interaction physics.
 */
bool initialize_mesh_plan_fields(
    Context &ctx,
    const fullmag_fem_mesh_desc &mesh,
    std::string &error);

/*
 * Admit the legacy tet4/tri3 lane and the narrowly qualified explicit CPU/GPU
 * mixed-P1 operator tuple. All other mixed-topology plans fail closed before
 * backend operator construction.
 */
bool validate_supported_physics_topology(
    const Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

/*
 * Initialize magnetic element and node masks from imported FEM mesh markers.
 *
 * Missing element markers mean the whole mesh is magnetic. Explicit marker 0
 * means air, including an all-zero marker array. The node mask is the union of
 * magnetic elements.
 */
void initialize_magnetic_masks(Context &ctx);

bool validate_magnetic_mesh_has_active_region(const Context &ctx, std::string &error);

/*
 * Validate static-periodic native FEM plan compatibility.
 *
 * Periodic topology currently supports exchange, uniform Zeeman, local
 * anisotropy, DMI, and MFEM-stack demag through reduced Poisson operators.
 * This helper owns the unsupported-term gate plus per-periodic-class material
 * field equality checks used before MFEM operator initialization.
 */
bool validate_periodic_plan_compatibility(Context &ctx, std::string &error);

bool build_static_periodic_reduction(Context &ctx, std::string &error);

bool validate_periodic_scalar_field_classes(
    const Context &ctx,
    const std::vector<double> &field,
    const char *field_name,
    std::string &error);

void compute_node_volumes(Context &ctx);

} // namespace fullmag::fem
