#include "core/fem_element_quadrature_material.hpp"

#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>

namespace fullmag::fem {
namespace {

constexpr std::uint64_t kFnvOffsetBasis = 14695981039346656037ULL;
constexpr std::uint64_t kFnvPrime = 1099511628211ULL;
constexpr std::uint64_t kElementMapContractVersion = 1ULL;

void hash_byte(std::uint64_t &hash, std::uint8_t byte) noexcept {
    hash ^= byte;
    hash *= kFnvPrime;
}

void hash_u64(std::uint64_t &hash, std::uint64_t value) noexcept {
    for (unsigned shift = 0; shift != 64; shift += 8) {
        hash_byte(hash, static_cast<std::uint8_t>((value >> shift) & 0xffU));
    }
}

void hash_double(std::uint64_t &hash, double value) noexcept {
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value), "FEM map digest requires IEEE-754 double width");
    std::memcpy(&bits, &value, sizeof(bits));
    hash_u64(hash, bits);
}

void require_p1_extent(
    const std::vector<double> &values,
    std::size_t node_count,
    const char *name)
{
    if (values.size() != node_count) {
        throw std::invalid_argument(
            std::string(name) + " has length " + std::to_string(values.size()) +
            " but node_count=" + std::to_string(node_count));
    }
    for (std::size_t node = 0; node < values.size(); ++node) {
        if (!std::isfinite(values[node])) {
            throw std::invalid_argument(
                std::string(name) + " contains NaN/Inf at node " + std::to_string(node));
        }
    }
}

void require_aos3_extent(
    const std::vector<double> &values,
    std::size_t node_count,
    const char *name)
{
    const std::size_t expected = node_count * 3u;
    if (values.size() != expected) {
        throw std::invalid_argument(
            std::string(name) + " has length " + std::to_string(values.size()) +
            " but expected 3 * node_count=" + std::to_string(expected));
    }
    for (std::size_t value = 0; value < values.size(); ++value) {
        if (!std::isfinite(values[value])) {
            throw std::invalid_argument(
                std::string(name) + " contains NaN/Inf at AOS-3 value " +
                std::to_string(value));
        }
    }
}

} // namespace

ElementQuadratureMaterial::ElementQuadratureMaterial(
    std::size_t node_count,
    std::vector<P1TetrahedronMaterialTopology> elements,
    std::vector<double> ms_a_per_m,
    std::vector<double> a_j_per_m)
    : node_count_(node_count),
      elements_(std::move(elements)),
      ms_a_per_m_(std::move(ms_a_per_m)),
      a_j_per_m_(std::move(a_j_per_m))
{
    if (elements_.size() != ms_a_per_m_.size() || elements_.size() != a_j_per_m_.size()) {
        throw std::invalid_argument("DG0 material arrays must have one value per ordered tetrahedron");
    }
    if (elements_.empty()) {
        throw std::invalid_argument("element-quadrature material requires at least one P1 tetrahedron");
    }

    std::uint64_t digest = kFnvOffsetBasis;
    hash_u64(digest, kElementMapContractVersion);
    hash_u64(digest, static_cast<std::uint64_t>(node_count_));
    hash_u64(digest, static_cast<std::uint64_t>(elements_.size()));
    for (std::size_t element = 0; element < elements_.size(); ++element) {
        const P1TetrahedronMaterialTopology &topology = elements_[element];
        if (!std::isfinite(topology.volume_m3) || topology.volume_m3 <= 0.0) {
            throw std::invalid_argument(
                "P1 tetrahedron has non-positive/non-finite volume at element " +
                std::to_string(element));
        }
        if (!std::isfinite(ms_a_per_m_[element]) || ms_a_per_m_[element] <= 0.0) {
            throw std::invalid_argument(
                "DG0 Ms must be finite and > 0 at element " + std::to_string(element));
        }
        if (!std::isfinite(a_j_per_m_[element]) || a_j_per_m_[element] < 0.0) {
            throw std::invalid_argument(
                "DG0 A must be finite and >= 0 at element " + std::to_string(element));
        }
        // The physical contract identifies both IEEE-754 zero signs as A=0.
        if (a_j_per_m_[element] == 0.0) {
            a_j_per_m_[element] = 0.0;
        }
        hash_u64(digest, static_cast<std::uint64_t>(element));
        for (std::size_t local_node = 0; local_node < topology.node_ids.size(); ++local_node) {
            const std::uint64_t node = topology.node_ids[local_node];
            if (node >= node_count_) {
                throw std::invalid_argument(
                    "P1 tetrahedron references node outside node_count at element " +
                    std::to_string(element));
            }
            for (std::size_t prior_node = 0; prior_node < local_node; ++prior_node) {
                if (node == topology.node_ids[prior_node]) {
                    throw std::invalid_argument(
                        "P1 tetrahedron has duplicate node ID at element " +
                        std::to_string(element));
                }
            }
            hash_u64(digest, node);
        }
        hash_double(digest, topology.volume_m3);
        hash_double(digest, ms_a_per_m_[element]);
        hash_double(digest, a_j_per_m_[element]);
    }
    element_map_hash_ = digest;
}

std::size_t ElementQuadratureMaterial::node_count() const noexcept {
    return node_count_;
}

std::size_t ElementQuadratureMaterial::element_count() const noexcept {
    return elements_.size();
}

const P1TetrahedronMaterialTopology &ElementQuadratureMaterial::element_topology(
    std::size_t element_ordinal) const
{
    return elements_.at(element_ordinal);
}

double ElementQuadratureMaterial::ms_a_per_m(std::size_t element_ordinal) const {
    return ms_a_per_m_.at(element_ordinal);
}

double ElementQuadratureMaterial::a_j_per_m(std::size_t element_ordinal) const {
    return a_j_per_m_.at(element_ordinal);
}

double ElementQuadratureMaterial::integrate_ms_p1(
    const std::vector<double> &p1_nodal_values) const
{
    require_p1_extent(p1_nodal_values, node_count_, "P1 nodal values");
    double integral = 0.0;
    for (std::size_t element = 0; element < elements_.size(); ++element) {
        double node_sum = 0.0;
        for (const std::uint64_t node : elements_[element].node_ids) {
            node_sum += p1_nodal_values[static_cast<std::size_t>(node)];
        }
        integral += ms_a_per_m_[element] * elements_[element].volume_m3 * node_sum / 4.0;
    }
    return integral;
}

double ElementQuadratureMaterial::ms_weighted_mass_bilinear(
    const std::vector<double> &left_p1_nodal_values,
    const std::vector<double> &right_p1_nodal_values) const
{
    require_p1_extent(left_p1_nodal_values, node_count_, "left P1 nodal values");
    require_p1_extent(right_p1_nodal_values, node_count_, "right P1 nodal values");
    double result = 0.0;
    for (std::size_t element = 0; element < elements_.size(); ++element) {
        double local = 0.0;
        for (std::size_t i = 0; i < 4; ++i) {
            const double left = left_p1_nodal_values[
                static_cast<std::size_t>(elements_[element].node_ids[i])];
            for (std::size_t j = 0; j < 4; ++j) {
                const double right = right_p1_nodal_values[
                    static_cast<std::size_t>(elements_[element].node_ids[j])];
                local += (i == j ? 2.0 : 1.0) * left * right;
            }
        }
        result += ms_a_per_m_[element] * elements_[element].volume_m3 * local / 20.0;
    }
    return result;
}

double ElementQuadratureMaterial::ms_weighted_aos3_mass_bilinear(
    const std::vector<double> &left_aos3_nodal_values,
    const std::vector<double> &right_aos3_nodal_values) const
{
    require_aos3_extent(left_aos3_nodal_values, node_count_, "left AOS-3 nodal values");
    require_aos3_extent(right_aos3_nodal_values, node_count_, "right AOS-3 nodal values");
    double result = 0.0;
    for (std::size_t element = 0; element < elements_.size(); ++element) {
        double local = 0.0;
        for (std::size_t i = 0; i < 4; ++i) {
            const std::size_t left_base =
                static_cast<std::size_t>(elements_[element].node_ids[i]) * 3u;
            for (std::size_t j = 0; j < 4; ++j) {
                const std::size_t right_base =
                    static_cast<std::size_t>(elements_[element].node_ids[j]) * 3u;
                const double dot =
                    left_aos3_nodal_values[left_base + 0u] * right_aos3_nodal_values[right_base + 0u] +
                    left_aos3_nodal_values[left_base + 1u] * right_aos3_nodal_values[right_base + 1u] +
                    left_aos3_nodal_values[left_base + 2u] * right_aos3_nodal_values[right_base + 2u];
                local += (i == j ? 2.0 : 1.0) * dot;
            }
        }
        result += ms_a_per_m_[element] * elements_[element].volume_m3 * local / 20.0;
    }
    return result;
}

std::uint64_t ElementQuadratureMaterial::element_map_hash() const noexcept {
    return element_map_hash_;
}

} // namespace fullmag::fem
