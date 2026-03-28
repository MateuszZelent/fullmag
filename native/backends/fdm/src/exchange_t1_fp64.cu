/*
 * exchange_t1_fp64.cu — T1 boundary-corrected exchange (ECB/García stencil).
 *
 * This kernel modifies the finite-difference Laplacian operator at boundary cells
 * using intersection distances δ (distance from cell center to physical boundary).
 *
 * Standard interior stencil:
 *   ∂²m/∂x² ≈ (m_{i+1} - 2m_i + m_{i-1}) / Δx²
 *
 * Boundary-corrected stencil (boundary at distance δ from center toward +x):
 *   Neumann BC ∂m/∂n|_boundary = 0 → ghost value = m_i
 *   ∂²m/∂x² ≈ 2/(Δx + δ) × [ (m_{i-1} - m_i)/Δx + 0/δ ]
 *            = 2(m_{i-1} - m_i) / [Δx(Δx + δ)]
 *
 * The key difference from T0: the denominator changes from Δx² to Δx(Δx+δ),
 * which correctly accounts for the reduced available domain on the boundary side.
 *
 * References:
 *   [1] García-Cervera et al., J. Comput. Phys. 184, 37-52 (2003)
 *   [2] Parker, Cerjan, Hewett (ECB), OSTI.gov/12217 (1997)
 */

#include <cstdint>
#include <cfloat>

#ifdef FULLMAG_HAS_CUDA

extern "C" __global__ void
exchange_field_t1_fp64_kernel(
    double       *__restrict__ hx,
    double       *__restrict__ hy,
    double       *__restrict__ hz,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ volume_fraction,
    const double *__restrict__ d_delta_xp,
    const double *__restrict__ d_delta_xm,
    const double *__restrict__ d_delta_yp,
    const double *__restrict__ d_delta_ym,
    const double *__restrict__ d_delta_zp,
    const double *__restrict__ d_delta_zm,
    double Ms, double A,
    double dx, double dy, double dz,
    double delta_min,
    uint32_t nx, uint32_t ny, uint32_t nz)
{
    const uint32_t x = blockIdx.x * blockDim.x + threadIdx.x;
    const uint32_t y = blockIdx.y * blockDim.y + threadIdx.y;
    const uint32_t z = blockIdx.z * blockDim.z + threadIdx.z;
    if (x >= nx || y >= ny || z >= nz) return;

    const uint64_t idx = (uint64_t)z * ny * nx + y * nx + x;

    // Skip empty cells
    const double phi0 = volume_fraction[idx];
    if (phi0 <= 0.0) return;

    const double m0x = mx[idx];
    const double m0y = my[idx];
    const double m0z = mz[idx];
    if (m0x == 0.0 && m0y == 0.0 && m0z == 0.0) return;

    double bx = 0.0, by = 0.0, bz = 0.0;

    // ── X axis ──

    // Distance to boundary from center toward -x and +x
    const double dxm = fmax(d_delta_xm[idx], delta_min);
    const double dxp = fmax(d_delta_xp[idx], delta_min);

    // -x neighbor
    if (x > 0 && dxm > 0.0) {
        const uint64_t n_idx = idx - 1;
        const double mn_x = mx[n_idx], mn_y = my[n_idx], mn_z = mz[n_idx];
        if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
            // Interior neighbor: use modified stencil
            // ∂²m/∂x² contribution = 2(m_{j} - m_i) / [Δx(Δx + δ_{+x})]
            // The denominator uses δ from the OPPOSITE side (toward +x boundary)
            // because the non-uniform spacing is Δx on the -x side and δ_+x on +x side.
            const double denom_x = dx * (dx + dxp);
            const double coeff = 2.0 / denom_x;
            bx += coeff * (mn_x - m0x);
            by += coeff * (mn_y - m0y);
            bz += coeff * (mn_z - m0z);
        }
    } else if (dxm > 0.0) {
        // No interior neighbor (grid boundary): Neumann → ghost = m_i → contribution = 0
    }

    // +x neighbor
    if (x + 1 < nx && dxp > 0.0) {
        const uint64_t n_idx = idx + 1;
        const double mn_x = mx[n_idx], mn_y = my[n_idx], mn_z = mz[n_idx];
        if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
            const double denom_x = dx * (dx + dxm);
            const double coeff = 2.0 / denom_x;
            bx += coeff * (mn_x - m0x);
            by += coeff * (mn_y - m0y);
            bz += coeff * (mn_z - m0z);
        }
    }

    // ── Y axis ──

    const double dym = fmax(d_delta_ym[idx], delta_min);
    const double dyp = fmax(d_delta_yp[idx], delta_min);

    // -y neighbor
    if (y > 0 && dym > 0.0) {
        const uint64_t n_idx = idx - nx;
        const double mn_x = mx[n_idx], mn_y = my[n_idx], mn_z = mz[n_idx];
        if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
            const double denom_y = dy * (dy + dyp);
            const double coeff = 2.0 / denom_y;
            bx += coeff * (mn_x - m0x);
            by += coeff * (mn_y - m0y);
            bz += coeff * (mn_z - m0z);
        }
    }

    // +y neighbor
    if (y + 1 < ny && dyp > 0.0) {
        const uint64_t n_idx = idx + nx;
        const double mn_x = mx[n_idx], mn_y = my[n_idx], mn_z = mz[n_idx];
        if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
            const double denom_y = dy * (dy + dym);
            const double coeff = 2.0 / denom_y;
            bx += coeff * (mn_x - m0x);
            by += coeff * (mn_y - m0y);
            bz += coeff * (mn_z - m0z);
        }
    }

    // ── Z axis (3D only) ──

    if (nz > 1) {
        const double dzm = fmax(d_delta_zm[idx], delta_min);
        const double dzp = fmax(d_delta_zp[idx], delta_min);

        if (z > 0 && dzm > 0.0) {
            const uint64_t n_idx = idx - (uint64_t)ny * nx;
            const double mn_x = mx[n_idx], mn_y = my[n_idx], mn_z = mz[n_idx];
            if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
                const double denom_z = dz * (dz + dzp);
                const double coeff = 2.0 / denom_z;
                bx += coeff * (mn_x - m0x);
                by += coeff * (mn_y - m0y);
                bz += coeff * (mn_z - m0z);
            }
        }

        if (z + 1 < nz && dzp > 0.0) {
            const uint64_t n_idx = idx + (uint64_t)ny * nx;
            const double mn_x = mx[n_idx], mn_y = my[n_idx], mn_z = mz[n_idx];
            if (mn_x != 0.0 || mn_y != 0.0 || mn_z != 0.0) {
                const double denom_z = dz * (dz + dzm);
                const double coeff = 2.0 / denom_z;
                bx += coeff * (mn_x - m0x);
                by += coeff * (mn_y - m0y);
                bz += coeff * (mn_z - m0z);
            }
        }
    }

    // H_ex = (2A / (μ₀ Ms)) × Σ contributions
    // The stencil accumulates Σ 2/(Δx(Δx+δ)) × (m_j - m_i).
    // For interior cells (δ = Δx on both sides), this gives 1/Δx² per face → standard Laplacian.
    // So the prefactor must be the standard 2A/(μ₀ Ms) to match the reference kernel.
    const double MU0 = 4.0 * 3.14159265358979323846 * 1e-7;
    const double scale = 2.0 * A / (MU0 * Ms);
    hx[idx] = scale * bx;
    hy[idx] = scale * by;
    hz[idx] = scale * bz;
}

#endif // FULLMAG_HAS_CUDA
