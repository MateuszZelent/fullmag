#pragma once

namespace fullmag {
namespace fdm {

struct DmiMissingFaces {
    bool xp;
    bool xm;
    bool yp;
    bool ym;
    bool zp;
    bool zm;
};

template <typename FieldScalar>
__device__ inline void add_interfacial_dmi_boundary_correction(
    double mx,
    double my,
    double mz,
    double dmi_prefactor,
    double d,
    double inv_2dx,
    double inv_2dy,
    const DmiMissingFaces &missing,
    FieldScalar &hx,
    FieldScalar &hy,
    FieldScalar &hz)
{
    const double qx = dmi_prefactor * d * inv_2dx;
    const double qy = dmi_prefactor * d * inv_2dy;
    if (missing.xp) {
        hx -= qx * mz;
        hz += qx * mx;
    }
    if (missing.xm) {
        hx += qx * mz;
        hz -= qx * mx;
    }
    if (missing.yp) {
        hy -= qy * mz;
        hz += qy * my;
    }
    if (missing.ym) {
        hy += qy * mz;
        hz -= qy * my;
    }
}

template <typename FieldScalar>
__device__ inline void add_bulk_dmi_boundary_correction(
    double mx,
    double my,
    double mz,
    double dmi_prefactor,
    double d,
    double inv_2dx,
    double inv_2dy,
    double inv_2dz,
    const DmiMissingFaces &missing,
    FieldScalar &hx,
    FieldScalar &hy,
    FieldScalar &hz)
{
    const double qx = dmi_prefactor * d * inv_2dx;
    const double qy = dmi_prefactor * d * inv_2dy;
    const double qz = dmi_prefactor * d * inv_2dz;
    if (missing.xp) {
        hy -= qx * mz;
        hz += qx * my;
    }
    if (missing.xm) {
        hy += qx * mz;
        hz -= qx * my;
    }
    if (missing.yp) {
        hx += qy * mz;
        hz -= qy * mx;
    }
    if (missing.ym) {
        hx -= qy * mz;
        hz += qy * mx;
    }
    if (missing.zp) {
        hx -= qz * my;
        hy += qz * mx;
    }
    if (missing.zm) {
        hx += qz * my;
        hy -= qz * mx;
    }
}

} // namespace fdm
} // namespace fullmag
