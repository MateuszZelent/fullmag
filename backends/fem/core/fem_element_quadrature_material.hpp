#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace fullmag::fem {

/*
 * Backend-neutral DG0 material map over an ordered P1 tetrahedral topology.
 *
 * This pure contract owns no Context, MFEM state, CUDA state, or interaction.
 * It preserves sharp per-element material coefficients and supplies exact P1
 * material-weighted integration primitives to later CPU/GPU owners.
 */
struct P1TetrahedronMaterialTopology {
    std::array<std::uint64_t, 4> node_ids{};
    double volume_m3 = 0.0;
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
