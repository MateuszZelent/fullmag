#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace fullmag::fem {

/*
 * Backend-neutral DG0-DG0 compatibility specialization over an ordered P1
 * tetrahedral topology.
 *
 * This pure contract owns no Context, MFEM state, CUDA state, or interaction.
 * It preserves sharp per-element material coefficients and supplies exact P1
 * material-weighted integration primitives to later CPU/GPU owners.
 */
struct P1TetrahedronMaterialTopology {
    std::array<std::uint64_t, 4> node_ids{};
    double volume_m3 = 0.0;
};

enum class MaterialCoefficientLocation : std::uint8_t {
    uniform = 0,
    nodal_p1 = 1,
    element_dg0 = 2,
};

struct MaterialCoefficientValues {
    MaterialCoefficientLocation location = MaterialCoefficientLocation::uniform;
    std::vector<double> values;
};

// Exact componentwise terms for an AoS-3 P1 mass bilinear.  The absolute sum
// is intentionally accumulated before component or element cancellation.
struct Aos3MassBilinearTermwiseResult {
    double value = 0.0;
    double absolute_term_sum = 0.0;
    std::size_t scalar_term_count = 0u;
};

/*
 * Pure parameter-local realization over one ordered P1 tetrahedral topology.
 *
 * Ms and A deliberately retain independent locations.  This owner stores
 * topology and active scope once, but never turns DG0 values into values on
 * shared nodes.  It is constructed by a later material/runtime adapter, not
 * by Context, MFEM, CUDA, planner, or interaction code.
 */
class P1TetrahedralMaterialRealization {
public:
    P1TetrahedralMaterialRealization(
        std::size_t node_count,
        std::vector<P1TetrahedronMaterialTopology> elements,
        std::vector<std::size_t> active_element_ordinals,
        MaterialCoefficientValues ms,
        MaterialCoefficientValues a);

    std::size_t node_count() const noexcept;
    std::size_t element_count() const noexcept;
    const std::vector<std::size_t> &active_element_ordinals() const noexcept;
    const P1TetrahedronMaterialTopology &element_topology(std::size_t element_ordinal) const;
    MaterialCoefficientLocation ms_location() const noexcept;
    MaterialCoefficientLocation a_location() const noexcept;
    const std::vector<double> &ms_values() const noexcept;
    const std::vector<double> &a_values() const noexcept;

    // Exact only for DG0 Ms.  Other Ms locations remain queryable but do not
    // acquire an implicit quadrature rule in this core task.
    double ms_weighted_mass_bilinear(
        const std::vector<double> &left_p1_nodal_values,
        const std::vector<double> &right_p1_nodal_values) const;

    // Exact componentwise P1 M_Ms bilinear for node-major AOS-3 fields.
    double ms_weighted_aos3_mass_bilinear(
        const std::vector<double> &left_aos3_nodal_values,
        const std::vector<double> &right_aos3_nodal_values) const;

    Aos3MassBilinearTermwiseResult ms_weighted_aos3_mass_bilinear_termwise(
        const std::vector<double> &left_aos3_nodal_values,
        const std::vector<double> &right_aos3_nodal_values) const;

    // Versioned digest of topology, active scope, location tags, and values.
    std::uint64_t material_realization_hash() const noexcept;

private:
    std::size_t node_count_ = 0;
    std::vector<P1TetrahedronMaterialTopology> elements_;
    std::vector<std::size_t> active_element_ordinals_;
    MaterialCoefficientValues ms_;
    MaterialCoefficientValues a_;
    std::uint64_t material_realization_hash_ = 0;
};

class ElementQuadratureMaterial {
public:
    ElementQuadratureMaterial(
        std::size_t node_count,
        std::vector<P1TetrahedronMaterialTopology> elements,
        std::vector<double> ms_a_per_m,
        std::vector<double> a_j_per_m);

    std::size_t node_count() const noexcept;
    std::size_t element_count() const noexcept;
    const P1TetrahedronMaterialTopology &element_topology(std::size_t element_ordinal) const;
    double ms_a_per_m(std::size_t element_ordinal) const;
    double a_j_per_m(std::size_t element_ordinal) const;

    // Exact for P1 scalar fields and DG0 Ms on each tetrahedron.
    double integrate_ms_p1(const std::vector<double> &p1_nodal_values) const;
    double ms_weighted_mass_bilinear(
        const std::vector<double> &left_p1_nodal_values,
        const std::vector<double> &right_p1_nodal_values) const;

    // Exact componentwise P1 mass bilinear for node-major AOS-3 vector fields.
    double ms_weighted_aos3_mass_bilinear(
        const std::vector<double> &left_aos3_nodal_values,
        const std::vector<double> &right_aos3_nodal_values) const;

    // Versioned digest of ordered topology, volumes, and DG0 material values.
    std::uint64_t element_map_hash() const noexcept;

private:
    std::size_t node_count_ = 0;
    std::vector<P1TetrahedronMaterialTopology> elements_;
    std::vector<double> ms_a_per_m_;
    std::vector<double> a_j_per_m_;
    std::uint64_t element_map_hash_ = 0;
};

} // namespace fullmag::fem
