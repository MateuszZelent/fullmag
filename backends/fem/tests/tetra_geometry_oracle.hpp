// Independent P1 geometry oracle shared by CPU and CUDA Zhang-Li contracts.
#pragma once

#include <array>
#include <cmath>

namespace fullmag::fem::test {

using Vec3 = std::array<double, 3>;

inline double dot(const Vec3 &a, const Vec3 &b)
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline Vec3 subtract(const Vec3 &a, const Vec3 &b)
{
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

inline Vec3 cross(const Vec3 &a, const Vec3 &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

// For x = p0 + J xi (J columns p1-p0, p2-p0, p3-p0), P1 gradients are rows of J^-1.
inline bool p1_tetra_gradients(
    const std::array<Vec3, 4> &points,
    std::array<Vec3, 4> &gradients)
{
    const Vec3 d1 = subtract(points[1], points[0]);
    const Vec3 d2 = subtract(points[2], points[0]);
    const Vec3 d3 = subtract(points[3], points[0]);
    const double det = dot(d1, cross(d2, d3));
    if (!(std::abs(det) > 1e-30) || !std::isfinite(det)) {
        return false;
    }
    const double inv_det = 1.0 / det;
    gradients[1] = cross(d2, d3);
    gradients[2] = cross(d3, d1);
    gradients[3] = cross(d1, d2);
    for (auto &gradient : gradients) {
        gradient[0] *= inv_det;
        gradient[1] *= inv_det;
        gradient[2] *= inv_det;
    }
    gradients[0] = {
        -(gradients[1][0] + gradients[2][0] + gradients[3][0]),
        -(gradients[1][1] + gradients[2][1] + gradients[3][1]),
        -(gradients[1][2] + gradients[2][2] + gradients[3][2]),
    };
    return true;
}

} // namespace fullmag::fem::test
