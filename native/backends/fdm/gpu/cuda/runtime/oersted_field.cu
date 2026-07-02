/*
 * oersted_field.cu - FDM CUDA static Oersted field materialization and upload.
 */

#include "context_internal.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <vector>

namespace fullmag {
namespace fdm {

/* ── Oersted field precomputation (infinite cylinder, Ampère's law) ──
 *
 * For a z-axis cylinder carrying unit current I = 1 A:
 *   inside  (r < R):  H_phi = r / (2π R²)
 *   outside (r >= R):  H_phi = 1 / (2π r)
 *
 * H_x = -H_phi * sin(phi) = -H_phi * (y - cy) / r
 * H_y = +H_phi * cos(phi) = +H_phi * (x - cx) / r
 * H_z = 0
 *
 * For non-z axes we apply a rotation matrix.
 * The result is stored in h_oe_static for I=1A; at runtime it is scaled
 * by oersted_current * time_envelope(t).
 */
bool context_precompute_oersted_field(Context &ctx) {
    if (!ctx.has_oersted_cylinder) return true;

    uint64_t n = ctx.cell_count;
    double R = ctx.oersted_radius;
    double cx = ctx.oersted_center[0];
    double cy = ctx.oersted_center[1];
    // cz = ctx.oersted_center[2]; // unused for z-axis cylinder

    if (R <= 0.0) {
        ctx.last_error = "oersted_radius must be positive";
        return false;
    }

    double inv_2pi = 1.0 / (2.0 * M_PI);
    double R2 = R * R;

    // Compute on host in SoA layout
    std::vector<double> hx(n), hy(n), hz(n);

    for (uint64_t idx = 0; idx < n; ++idx) {
        uint64_t iz = idx / (ctx.ny * ctx.nx);
        uint64_t rem = idx - iz * ctx.ny * ctx.nx;
        uint64_t iy = rem / ctx.nx;
        uint64_t ix = rem - iy * ctx.nx;

        // Cell center coordinates
        double x = (ix + 0.5) * ctx.dx;
        double y = (iy + 0.5) * ctx.dy;

        double dx = x - cx;
        double dy = y - cy;
        double r = sqrt(dx * dx + dy * dy);

        double H_phi;
        if (r < 1e-30) {
            // At exact center, field is zero (by symmetry)
            H_phi = 0.0;
        } else if (r < R) {
            // Inside: H_phi = I * r / (2 * pi * R^2)  for I = 1 A
            H_phi = inv_2pi * r / R2;
        } else {
            // Outside: H_phi = I / (2 * pi * r)  for I = 1 A
            H_phi = inv_2pi / r;
        }

        // Convert azimuthal to Cartesian (phi-hat = (-sin(phi), cos(phi)))
        double sin_phi = dy / r;
        double cos_phi = dx / r;
        if (r < 1e-30) {
            sin_phi = 0.0;
            cos_phi = 0.0;
        }

        hx[idx] = -H_phi * sin_phi;
        hy[idx] =  H_phi * cos_phi;
        hz[idx] =  0.0;
    }

    // Upload to device
    size_t bytes = n * scalar_size(ctx.precision);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        cudaError_t err;
        err = cudaMemcpy(ctx.h_oe_static.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_z)", err); return false; }
    } else {
        // Convert to float and upload
        std::vector<float> hx_f(n), hy_f(n), hz_f(n);
        for (uint64_t i = 0; i < n; ++i) {
            hx_f[i] = static_cast<float>(hx[i]);
            hy_f[i] = static_cast<float>(hy[i]);
            hz_f[i] = static_cast<float>(hz[i]);
        }
        cudaError_t err;
        err = cudaMemcpy(ctx.h_oe_static.x, hx_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_z)", err); return false; }
    }

    return true;
}

bool context_upload_oersted_field(Context &ctx, const double *field_xyz, uint64_t len) {
    if (!ctx.has_oersted_field || field_xyz == nullptr) {
        return true;
    }
    if (len != ctx.cell_count * 3u) {
        ctx.last_error = "oersted_field_len mismatch";
        return false;
    }

    const uint64_t n = ctx.cell_count;
    std::vector<double> hx(n), hy(n), hz(n);
    for (uint64_t i = 0; i < n; ++i) {
        hx[i] = field_xyz[3u * i + 0];
        hy[i] = field_xyz[3u * i + 1];
        hz[i] = field_xyz[3u * i + 2];
    }

    const size_t bytes = n * scalar_size(ctx.precision);
    cudaError_t err;
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        err = cudaMemcpy(ctx.h_oe_static.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_z)", err); return false; }
    } else {
        std::vector<float> hx_f(n), hy_f(n), hz_f(n);
        for (uint64_t i = 0; i < n; ++i) {
            hx_f[i] = static_cast<float>(hx[i]);
            hy_f[i] = static_cast<float>(hy[i]);
            hz_f[i] = static_cast<float>(hz[i]);
        }
        err = cudaMemcpy(ctx.h_oe_static.x, hx_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_z)", err); return false; }
    }

    return true;
}

} // namespace fdm
} // namespace fullmag
