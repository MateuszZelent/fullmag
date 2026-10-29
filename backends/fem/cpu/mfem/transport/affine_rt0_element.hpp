#pragma once

#include <array>

namespace mfem {
class FiniteElementSpace;
class GridFunction;
} // namespace mfem

namespace fullmag::fem::transport {

// Mathematical generic MFEM RT0 basis on a straight tetrahedron. Geometry and
// local signed coefficients are frozen before assembly or field quadrature.
class AffineRt0Element {
public:
    static constexpr const char *operator_version = "fem_generic_affine_rt0.v1";
    using Point = std::array<double, 3>;
    using Face = std::array<Point, 3>;
    struct FrozenInput {
        std::array<Point, 4> vertices_m;
        // Generic basis coefficients in A, with the local DOF sign applied once.
        // These are not the physical integrated face currents.
        std::array<double, 4> signed_coefficients_a;
    };

    AffineRt0Element(const mfem::FiniteElementSpace &space, int element);
    AffineRt0Element(const mfem::GridFunction &field, int element);
    // Owned copy for field operators; no MFEM pointers or rounded determinant.
    FrozenInput frozen_input() const;
    Point basis_value_at(const Point &physical_point, int local) const;
    Point current_at(const Point &physical_point) const;
    // Exact frozen-binary64 reconstruction for the five retained snapshot samples.
    Point retained_current_at(const Point &physical_point) const;
    double face_moment(const Face &face_points) const;
    double signed_face_weight(const Face &face_points, int local) const;

private:
    std::array<Point, 4> vertices_{};
    std::array<int, 4> signed_dofs_{};
    std::array<double, 4> signed_coefficients_{};
    bool coefficients_frozen_ = false;
    long double determinant_m3_ = 0.0L;
};

} // namespace fullmag::fem::transport
