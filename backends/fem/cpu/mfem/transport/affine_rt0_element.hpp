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
    using Point = std::array<double, 3>;
    using Face = std::array<Point, 3>;

    AffineRt0Element(const mfem::FiniteElementSpace &space, int element);
    AffineRt0Element(const mfem::GridFunction &field, int element);
    Point basis_value_at(const Point &physical_point, int local) const;
    Point current_at(const Point &physical_point) const;
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
