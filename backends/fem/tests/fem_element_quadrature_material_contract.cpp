/*
 * Analytic two-tetra material oracle for FEM-TD-PHY-MAT-001.
 *
 * The tetrahedra share nodes 0, 1, and 2. Their distinct DG0 Ms values must
 * remain distinct in every element integral; no shared-node average can meet
 * this oracle for both volumes simultaneously.
 */

#include "core/fem_element_quadrature_material.hpp"

#include <array>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

constexpr double kMu0 = 1.25663706143591729538505735331180115367886775975e-6;

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool close_enough(double actual, double expected) {
    const double scale = std::max(std::abs(actual), std::abs(expected));
    return std::abs(actual - expected) <= 64.0 * std::numeric_limits<double>::epsilon() *
        std::max(1.0, scale);
}

template <typename Construct>
void expect_invalid_argument(Construct &&construct, const char *message) {
    try {
        construct();
    } catch (const std::invalid_argument &) {
        return;
    } catch (...) {
        check(false, message);
    }
    check(false, message);
}

double independent_ms_p1_integral(
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> &elements,
    const std::vector<double> &ms,
    const std::vector<double> &nodal)
{
    double integral = 0.0;
    for (std::size_t e = 0; e < elements.size(); ++e) {
        double node_sum = 0.0;
        for (const std::uint64_t node : elements[e].node_ids) {
            node_sum += nodal.at(static_cast<std::size_t>(node));
        }
        integral += ms.at(e) * elements[e].volume_m3 * node_sum / 4.0;
    }
    return integral;
}

double independent_mass_bilinear(
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> &elements,
    const std::vector<double> &ms,
    const std::vector<double> &left,
    const std::vector<double> &right)
{
    double result = 0.0;
    for (std::size_t e = 0; e < elements.size(); ++e) {
        double local = 0.0;
        for (std::size_t i = 0; i < 4; ++i) {
            for (std::size_t j = 0; j < 4; ++j) {
                const double coefficient = i == j ? 2.0 : 1.0;
                local += coefficient *
                    left.at(static_cast<std::size_t>(elements[e].node_ids[i])) *
                    right.at(static_cast<std::size_t>(elements[e].node_ids[j]));
            }
        }
        result += ms.at(e) * elements[e].volume_m3 * local / 20.0;
    }
    return result;
}

double independent_active_ms_mass_bilinear(
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> &elements,
    const std::vector<std::size_t> &active_elements,
    const std::vector<double> &ms,
    const std::vector<double> &left,
    const std::vector<double> &right)
{
    double result = 0.0;
    for (const std::size_t e : active_elements) {
        double local = 0.0;
        for (std::size_t i = 0; i < 4; ++i) {
            for (std::size_t j = 0; j < 4; ++j) {
                const double coefficient = i == j ? 2.0 : 1.0;
                local += coefficient *
                    left.at(static_cast<std::size_t>(elements.at(e).node_ids[i])) *
                    right.at(static_cast<std::size_t>(elements.at(e).node_ids[j]));
            }
        }
        result += ms.at(e) * elements.at(e).volume_m3 * local / 20.0;
    }
    return result;
}

void two_tetra_sharp_ms_is_integrated_by_element_not_shared_node() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const std::vector<double> ms = {0.7e6, 1.1e6};
    const std::vector<double> a = {8e-12, 13e-12};
    const std::vector<double> u = {1.0, 2.0, 3.0, 4.0, 5.0};
    const std::vector<double> v = {-2.0, 1.0, 0.5, 3.0, -1.0};
    const std::array<double, 2> h = {10.0, 20.0};

    const fullmag::fem::ElementQuadratureMaterial material(5, elements, ms, a);
    check(material.element_count() == 2, "two-tetra map must retain both element ordinals");
    check(material.ms_a_per_m(0) == ms[0] && material.ms_a_per_m(1) == ms[1],
          "DG0 Ms must be read by element ordinal, never from shared nodes");
    check(material.a_j_per_m(0) == a[0] && material.a_j_per_m(1) == a[1],
          "DG0 A must be read by element ordinal, never from shared nodes");

    const double expected_integral = independent_ms_p1_integral(elements, ms, u);
    check(close_enough(material.integrate_ms_p1(u), expected_integral),
          "DG0 Ms P1 integral must equal the independent element oracle");

    const double expected_mass = independent_mass_bilinear(elements, ms, u, v);
    check(close_enough(material.ms_weighted_mass_bilinear(u, v), expected_mass),
          "M_Ms bilinear must equal the exact P1 tetra mass oracle");

    const double expected_zeeman = -kMu0 * (
        ms[0] * elements[0].volume_m3 * h[0] * (u[0] + u[1] + u[2] + u[3]) / 4.0 +
        ms[1] * elements[1].volume_m3 * h[1] * (u[0] + u[1] + u[2] + u[4]) / 4.0);
    const double actual_zeeman = -kMu0 * (
        h[0] * material.ms_a_per_m(0) * elements[0].volume_m3 *
            (u[0] + u[1] + u[2] + u[3]) / 4.0 +
        h[1] * material.ms_a_per_m(1) * elements[1].volume_m3 *
            (u[0] + u[1] + u[2] + u[4]) / 4.0);
    check(close_enough(actual_zeeman, expected_zeeman),
          "two-tetra Zeeman energy must use the DG0 element Ms oracle");

    const fullmag::fem::ElementQuadratureMaterial same_map(5, elements, ms, a);
    check(material.element_map_hash() == same_map.element_map_hash(),
          "element-map digest must be deterministic");
    std::vector<double> changed_ms = ms;
    changed_ms[1] = 1.2e6;
    const fullmag::fem::ElementQuadratureMaterial changed_map(5, elements, changed_ms, a);
    check(material.element_map_hash() != changed_map.element_map_hash(),
          "element-map digest must bind DG0 material values");
}

void topology_and_digest_contract_is_canonical_and_complete() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const std::vector<double> ms = {0.7e6, 1.1e6};
    const std::vector<double> a = {8e-12, 13e-12};
    const fullmag::fem::ElementQuadratureMaterial baseline(5, elements, ms, a);

    std::vector<double> changed_a = a;
    changed_a[1] = 14e-12;
    check(
        baseline.element_map_hash() !=
            fullmag::fem::ElementQuadratureMaterial(5, elements, ms, changed_a).element_map_hash(),
        "element-map digest must bind DG0 A values");

    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> changed_volume = elements;
    changed_volume[1].volume_m3 = 0.25;
    check(
        baseline.element_map_hash() !=
            fullmag::fem::ElementQuadratureMaterial(5, changed_volume, ms, a).element_map_hash(),
        "element-map digest must bind physical tetra volumes");

    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> changed_node_ids = elements;
    changed_node_ids[1].node_ids = {{0, 1, 3, 4}};
    check(
        baseline.element_map_hash() !=
            fullmag::fem::ElementQuadratureMaterial(5, changed_node_ids, ms, a).element_map_hash(),
        "element-map digest must bind ordered global node IDs");

    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> reordered_elements = {
        elements[1], elements[0],
    };
    const std::vector<double> reordered_ms = {ms[1], ms[0]};
    const std::vector<double> reordered_a = {a[1], a[0]};
    check(
        baseline.element_map_hash() !=
            fullmag::fem::ElementQuadratureMaterial(
                5, reordered_elements, reordered_ms, reordered_a).element_map_hash(),
        "element-map digest must bind element ordinal and order");

    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> duplicate_node = elements;
    duplicate_node[0].node_ids = {{0, 0, 2, 3}};
    expect_invalid_argument(
        [&] { (void)fullmag::fem::ElementQuadratureMaterial(5, duplicate_node, ms, a); },
        "P1 tetrahedron with duplicate node IDs must be rejected");

    expect_invalid_argument(
        [&] { (void)fullmag::fem::ElementQuadratureMaterial(5, {}, {}, {}); },
        "empty tetrahedral material topology must be rejected");

    std::vector<double> negative_zero_a = a;
    negative_zero_a[0] = -0.0;
    const fullmag::fem::ElementQuadratureMaterial canonical_zero(5, elements, ms, negative_zero_a);
    const std::vector<double> positive_zero_a = {0.0, a[1]};
    const fullmag::fem::ElementQuadratureMaterial positive_zero(5, elements, ms, positive_zero_a);
    check(!std::signbit(canonical_zero.a_j_per_m(0)),
          "DG0 A signed zero must be normalized at the material boundary");
    check(canonical_zero.element_map_hash() == positive_zero.element_map_hash(),
          "element-map digest must canonicalize DG0 A signed zero");
}

void independent_locations_preserve_dg0_ms_without_shared_node_smearing() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const std::vector<double> ms = {0.7e6, 1.1e6};
    const std::vector<double> nodal_a = {8e-12, 9e-12, 10e-12, 11e-12, 12e-12};
    const std::vector<double> left = {1.0, -2.0, 3.0, 4.0, -5.0};
    const std::vector<double> right = {-1.0, 2.0, 0.5, 3.0, 6.0};

    const fullmag::fem::P1TetrahedralMaterialRealization material(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, ms},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_a});

    check(material.ms_location() == fullmag::fem::MaterialCoefficientLocation::element_dg0,
          "independent core must retain the Ms DG0 location tag");
    check(material.a_location() == fullmag::fem::MaterialCoefficientLocation::nodal_p1,
          "independent core must retain the A P1 location tag");
    check(material.ms_values() == ms && material.a_values() == nodal_a,
          "independent coefficient values must survive without a shared-node average");
    check(close_enough(
              material.ms_weighted_mass_bilinear(left, right),
              independent_mass_bilinear(elements, ms, left, right)),
          "DG0 Ms mass primitive must retain exact per-element two-tetra weights");
}

void active_scope_integrates_only_its_explicit_tetrahedral_subset() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const std::vector<std::size_t> active = {1u};
    const std::vector<double> ms = {0.7e6, 1.1e6};
    const std::vector<double> a = {8e-12, 13e-12};
    const std::vector<double> left = {1.0, -2.0, 3.0, 4.0, -5.0};
    const std::vector<double> right = {-1.0, 2.0, 0.5, 3.0, 6.0};

    const fullmag::fem::P1TetrahedralMaterialRealization material(
        5u,
        elements,
        active,
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, ms},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, a});

    const double expected = independent_active_ms_mass_bilinear(
        elements, active, ms, left, right);
    const double all_topology = independent_mass_bilinear(elements, ms, left, right);
    check(!close_enough(expected, all_topology),
          "two-tetra active-scope oracle must distinguish subset {1} from all topology");
    check(close_enough(material.ms_weighted_mass_bilinear(left, right), expected),
          "active scope {1} must integrate only tetrahedron 1");
}

void dg0_ms_allows_canonical_zero_only_on_inactive_air_elements() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
        {{{0u, 1u, 3u, 5u}}, 1.0 / 2.0},
    };
    const std::vector<std::size_t> active = {0u, 1u};
    const std::vector<double> ms_with_air = {0.7e6, 1.1e6, -0.0};
    const std::vector<double> a = {8e-12, 13e-12, 0.0};
    const std::vector<double> left = {1.0, -2.0, 3.0, 4.0, -5.0, 6.0};
    const std::vector<double> right = {-1.0, 2.0, 0.5, 3.0, 6.0, -4.0};

    const fullmag::fem::P1TetrahedralMaterialRealization with_air(
        6u,
        elements,
        active,
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, ms_with_air},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, a});
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> active_elements = {
        elements[0u], elements[1u]};
    const fullmag::fem::P1TetrahedralMaterialRealization without_air(
        6u,
        active_elements,
        active,
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.7e6, 1.1e6}},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {8e-12, 13e-12}});

    check(!std::signbit(with_air.ms_values().at(2u)),
          "inactive DG0 Ms signed zero must canonicalize before storage");
    check(close_enough(
              with_air.ms_weighted_mass_bilinear(left, right),
              without_air.ms_weighted_mass_bilinear(left, right)),
          "inactive zero-Ms air must not alter the active exact M_Ms bilinear");
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                6u,
                elements,
                active,
                {fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.0, 1.1e6, 0.0}},
                {fullmag::fem::MaterialCoefficientLocation::element_dg0, a});
        },
        "active DG0 Ms zero must reject");
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                6u,
                elements,
                active,
                {fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.7e6, 1.1e6, -1.0}},
                {fullmag::fem::MaterialCoefficientLocation::element_dg0, a});
        },
        "inactive DG0 Ms negative value must reject");
}

void reverse_independent_locations_and_digest_are_explicit() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const std::vector<double> nodal_ms = {0.7e6, 0.8e6, 0.9e6, 1.0e6, 1.1e6};
    const std::vector<double> dg0_a = {8e-12, 13e-12};
    const fullmag::fem::P1TetrahedralMaterialRealization baseline(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_ms},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, dg0_a});

    check(baseline.ms_location() == fullmag::fem::MaterialCoefficientLocation::nodal_p1 &&
              baseline.a_location() == fullmag::fem::MaterialCoefficientLocation::element_dg0,
          "reverse legal Ms-P1/A-DG0 combination must preserve both location tags");
    check(baseline.ms_values() == nodal_ms && baseline.a_values() == dg0_a,
          "reverse legal coefficient values must remain in their native representations");

    const fullmag::fem::P1TetrahedralMaterialRealization changed_scope(
        5u,
        elements,
        {1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_ms},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, dg0_a});
    const fullmag::fem::P1TetrahedralMaterialRealization changed_location(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::uniform, {0.7e6}},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, dg0_a});
    std::vector<double> changed_ms = nodal_ms;
    changed_ms[4] = 1.2e6;
    const fullmag::fem::P1TetrahedralMaterialRealization changed_values(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, changed_ms},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, dg0_a});
    std::vector<double> changed_a = dg0_a;
    changed_a[1] = 14e-12;
    const fullmag::fem::P1TetrahedralMaterialRealization changed_a_values(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_ms},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, changed_a});
    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> changed_topology = elements;
    changed_topology[1].volume_m3 = 0.25;
    const fullmag::fem::P1TetrahedralMaterialRealization changed_topology_digest(
        5u,
        changed_topology,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_ms},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, dg0_a});
    check(baseline.material_realization_hash() != changed_scope.material_realization_hash(),
          "material realization digest must bind ordered active-element scope");
    check(baseline.material_realization_hash() != changed_location.material_realization_hash(),
          "material realization digest must bind each coefficient location tag");
    check(baseline.material_realization_hash() != changed_values.material_realization_hash(),
          "material realization digest must bind each coefficient value");
    check(baseline.material_realization_hash() != changed_a_values.material_realization_hash(),
          "material realization digest must bind A values independently of Ms");
    check(baseline.material_realization_hash() != changed_topology_digest.material_realization_hash(),
          "material realization digest must bind positive physical topology volumes");
}

void p1_realization_canonicalizes_a_signed_zero_before_value_and_digest() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const std::vector<double> nodal_ms = {0.7e6, 0.8e6, 0.9e6, 1.0e6, 1.1e6};
    const std::vector<double> negative_zero_a = {-0.0, 9e-12, 10e-12, 11e-12, 12e-12};
    const std::vector<double> positive_zero_a = {0.0, 9e-12, 10e-12, 11e-12, 12e-12};
    const fullmag::fem::P1TetrahedralMaterialRealization negative_zero(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_ms},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, negative_zero_a});
    const fullmag::fem::P1TetrahedralMaterialRealization positive_zero(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, nodal_ms},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, positive_zero_a});

    check(!std::signbit(negative_zero.a_values().at(0u)),
          "P1 A signed zero must be normalized at the realization boundary");
    check(negative_zero.a_values() == positive_zero.a_values(),
          "P1 A signed-zero realization values must be canonicalized before storage");
    check(negative_zero.material_realization_hash() == positive_zero.material_realization_hash(),
          "P1 A signed-zero realization digest must be canonicalized before hashing");
}

void independent_realization_rejects_invalid_scope_and_location_extent() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const fullmag::fem::MaterialCoefficientValues ms = {
        fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.7e6, 1.1e6}};
    const fullmag::fem::MaterialCoefficientValues a = {
        fullmag::fem::MaterialCoefficientLocation::nodal_p1,
        {8e-12, 9e-12, 10e-12, 11e-12, 12e-12}};
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                5u, elements, {0u, 2u}, ms, a);
        },
        "active-element scope must reject ordinals outside ordered topology");
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                5u, elements, {0u, 0u}, ms, a);
        },
        "active-element scope must reject duplicate ordinals");
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                5u,
                elements,
                {0u, 1u},
                {fullmag::fem::MaterialCoefficientLocation::nodal_p1, {0.7e6}},
                a);
        },
        "P1 coefficient values must match node count exactly");
    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> negative_volume = elements;
    negative_volume[1].volume_m3 = -1.0;
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                5u, negative_volume, {0u, 1u}, ms, a);
        },
        "material realization must reject non-positive physical tetra volume");
    std::vector<fullmag::fem::P1TetrahedronMaterialTopology> duplicate_node = elements;
    duplicate_node[0].node_ids = {{0u, 0u, 2u, 3u}};
    expect_invalid_argument(
        [&] {
            (void)fullmag::fem::P1TetrahedralMaterialRealization(
                5u, duplicate_node, {0u, 1u}, ms, a);
        },
        "material realization must reject duplicate P1 tetra node IDs");
}

void dg0_checked_accessors_reject_wrong_location_and_out_of_range_ordinal() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> elements = {
        {{{0, 1, 2, 3}}, 1.0 / 6.0},
        {{{0, 1, 2, 4}}, 1.0 / 3.0},
    };
    const fullmag::fem::P1TetrahedralMaterialRealization dg0_ms_nodal_a(
        5u,
        elements,
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.7e6, 1.1e6}},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1,
         {8e-12, 9e-12, 10e-12, 11e-12, 12e-12}});
    check(dg0_ms_nodal_a.ms_a_per_m(1u) == 1.1e6,
          "DG0 Ms accessor must return the ordered element value");
    try {
        (void)dg0_ms_nodal_a.a_j_per_m(0u);
        check(false, "DG0 A accessor must reject a non-DG0 A realization");
    } catch (const std::logic_error &) {
    }
    try {
        (void)dg0_ms_nodal_a.ms_a_per_m(2u);
        check(false, "DG0 Ms accessor must reject an out-of-range element ordinal");
    } catch (const std::out_of_range &) {
    }
}

} // namespace

int main() {
    two_tetra_sharp_ms_is_integrated_by_element_not_shared_node();
    topology_and_digest_contract_is_canonical_and_complete();
    independent_locations_preserve_dg0_ms_without_shared_node_smearing();
    active_scope_integrates_only_its_explicit_tetrahedral_subset();
    dg0_ms_allows_canonical_zero_only_on_inactive_air_elements();
    reverse_independent_locations_and_digest_are_explicit();
    p1_realization_canonicalizes_a_signed_zero_before_value_and_digest();
    independent_realization_rejects_invalid_scope_and_location_extent();
    dg0_checked_accessors_reject_wrong_location_and_out_of_range_ordinal();
    std::puts("PASS: FEM element-quadrature material contract");
    return 0;
}
