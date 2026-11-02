/*
 * exchange_t0_fp64.cu — T0 boundary-corrected exchange (volume-weighted).
 *
 * Face-link-weighted exchange with φ-normalization:
 *   H_ex_i = (2 / μ₀Ms) × (1/φ_eff) × Σ_faces f_{i→j} × (A_ij/Δx²) × (m_j - m_i)
 *
 * φ_eff = max(φ_i, φ_floor) for stability clamping.
 *
 * This replaces the binary active_mask neighbor clamping with continuous
 * face link fractions. Interior cells (φ=1, f=1) should produce identical
 * results to the standard exchange kernel.
 *
 * Per-connection stiffness comes from exch_xp/yp/zp when present (note 0104,
 * material-fdm-connection-coefficient); otherwise the uniform A is used.
 */

#include <cstdint>
#include <cfloat>

#ifdef FULLMAG_HAS_CUDA

extern "C" __global__ void
exchange_field_t0_fp64_kernel(
    double       *__restrict__ hx,
    double       *__restrict__ hy,
    double       *__restrict__ hz,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ volume_fraction,
    const double *__restrict__ face_xp,
    const double *__restrict__ face_xm,
    const double *__restrict__ face_yp,
    const double *__restrict__ face_ym,
    const double *__restrict__ face_zp,
    const double *__restrict__ face_zm,
    const double *__restrict__ exch_xp,
    const double *__restrict__ exch_yp,
    const double *__restrict__ exch_zp,
    double Ms, double A,
    double inv_dx2, double inv_dy2, double inv_dz2,
    double phi_floor,
    uint32_t nx, uint32_t ny, uint32_t nz)
{
    const uint32_t x = blockIdx.x * blockDim.x + threadIdx.x;
    const uint32_t y = blockIdx.y * blockDim.y + threadIdx.y;
    const uint32_t z = blockIdx.z * blockDim.z + threadIdx.z;
    if (x >= nx || y >= ny || z >= nz) return;

    const uint64_t idx = (uint64_t)z * ny * nx + y * nx + x;

    // Skip empty cells
    const double phi0 = volume_fraction[idx];
    if (phi0 <= 0.0) {
        hx[idx] = 0.0;
        hy[idx] = 0.0;
        hz[idx] = 0.0;
        return;
    }

    const double m0x = mx[idx];
    const double m0y = my[idx];
    const double m0z = mz[idx];

    // Skip zero magnetization
    if (m0x == 0.0 && m0y == 0.0 && m0z == 0.0) {
        hx[idx] = 0.0;
        hy[idx] = 0.0;
        hz[idx] = 0.0;
        return;
    }

    // Effective volume for normalization (clamped for stability)
    const double phi_eff = (phi0 > phi_floor) ? phi0 : phi_floor;
    const double inv_phi = 1.0 / phi_eff;

    // Accumulate (A_ij × face × inv_Δx²) × (m_j - m_i)
    double bx = 0.0, by = 0.0, bz = 0.0;

    // -x neighbor
    {
        const double f = face_xm[idx];
        if (f > 0.0 && x > 0) {
            const uint64_t n_idx = idx - 1;
            const double A_ij = exch_xp ? exch_xp[n_idx] : A;
            bx += A_ij * f * inv_dx2 * (mx[n_idx] - m0x);
            by += A_ij * f * inv_dx2 * (my[n_idx] - m0y);
            bz += A_ij * f * inv_dx2 * (mz[n_idx] - m0z);
        }
    }
    // +x neighbor
    {
        const double f = face_xp[idx];
        if (f > 0.0 && x + 1 < nx) {
            const uint64_t n_idx = idx + 1;
            const double A_ij = exch_xp ? exch_xp[idx] : A;
            bx += A_ij * f * inv_dx2 * (mx[n_idx] - m0x);
            by += A_ij * f * inv_dx2 * (my[n_idx] - m0y);
            bz += A_ij * f * inv_dx2 * (mz[n_idx] - m0z);
        }
    }
    // -y neighbor
    {
        const double f = face_ym[idx];
        if (f > 0.0 && y > 0) {
            const uint64_t n_idx = idx - nx;
            const double A_ij = exch_yp ? exch_yp[n_idx] : A;
            bx += A_ij * f * inv_dy2 * (mx[n_idx] - m0x);
            by += A_ij * f * inv_dy2 * (my[n_idx] - m0y);
            bz += A_ij * f * inv_dy2 * (mz[n_idx] - m0z);
        }
    }
    // +y neighbor
    {
        const double f = face_yp[idx];
        if (f > 0.0 && y + 1 < ny) {
            const uint64_t n_idx = idx + nx;
            const double A_ij = exch_yp ? exch_yp[idx] : A;
            bx += A_ij * f * inv_dy2 * (mx[n_idx] - m0x);
            by += A_ij * f * inv_dy2 * (my[n_idx] - m0y);
            bz += A_ij * f * inv_dy2 * (mz[n_idx] - m0z);
        }
    }
    // -z neighbor (3D only)
    if (nz > 1) {
        const double f = face_zm[idx];
        if (f > 0.0 && z > 0) {
            const uint64_t n_idx = idx - (uint64_t)ny * nx;
            const double A_ij = exch_zp ? exch_zp[n_idx] : A;
            bx += A_ij * f * inv_dz2 * (mx[n_idx] - m0x);
            by += A_ij * f * inv_dz2 * (my[n_idx] - m0y);
            bz += A_ij * f * inv_dz2 * (mz[n_idx] - m0z);
        }
    }
    // +z neighbor
    if (nz > 1) {
        const double f = face_zp[idx];
        if (f > 0.0 && z + 1 < nz) {
            const uint64_t n_idx = idx + (uint64_t)ny * nx;
            const double A_ij = exch_zp ? exch_zp[idx] : A;
            bx += A_ij * f * inv_dz2 * (mx[n_idx] - m0x);
            by += A_ij * f * inv_dz2 * (my[n_idx] - m0y);
            bz += A_ij * f * inv_dz2 * (mz[n_idx] - m0z);
        }
    }

    // H_ex = (2 / (μ₀ Ms)) × (1/φ_eff) × Σ(A_ij × face × ∇²m)
    // Note: when A_ij comes from the LUT it already contains the exchange
    // stiffness value so the prefactor only carries 2/(μ₀ Ms).
    const double MU0 = 4.0 * 3.14159265358979323846 * 1e-7;
    const double scale = 2.0 / (MU0 * Ms) * inv_phi;
    hx[idx] = scale * bx;
    hy[idx] = scale * by;
    hz[idx] = scale * bz;
}

#endif // FULLMAG_HAS_CUDA
