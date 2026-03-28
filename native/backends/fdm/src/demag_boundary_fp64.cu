/*
 * demag_boundary_fp64.cu — Sparse local demag boundary correction.
 *
 * Applies precomputed correction tensors ΔN to boundary cells after
 * the standard FFT demag field has been computed:
 *
 *   H_corr(i) = -Σ_j ΔN(i,j) · M_j
 *
 * where ΔN(i,j) = N_refined(i,j) - N_coarse(i,j) is the difference
 * between the sub-cell-refined near-field Newell interaction and the
 * coarse-grid interaction already captured by FFT convolution.
 *
 * The correction is sparse: only boundary shell cells are targets,
 * and sources are restricted to a local stencil (typically radius 1).
 *
 * Reference: Donahue–McMichael, H_demag = H_rough + H_corr
 */

#include <cstdint>

#ifdef FULLMAG_HAS_CUDA

extern "C" __global__ void
demag_boundary_correction_fp64_kernel(
    double       *__restrict__ hx,
    double       *__restrict__ hy,
    double       *__restrict__ hz,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ volume_fraction,
    const int32_t *__restrict__ target_idx,
    const int32_t *__restrict__ source_idx,
    const double  *__restrict__ correction_tensor,
    double Ms,
    uint32_t target_count,
    uint32_t stencil_size)
{
    const uint32_t t = blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= target_count) return;

    const int32_t ti = target_idx[t];
    if (ti < 0) return;

    double corr_hx = 0.0, corr_hy = 0.0, corr_hz = 0.0;

    for (uint32_t s = 0; s < stencil_size; s++) {
        const int32_t si = source_idx[t * stencil_size + s];
        if (si < 0) continue;

        // Correction tensor components: Nxx, Nxy, Nxz, Nyy, Nyz, Nzz
        const uint32_t base = (t * stencil_size + s) * 6;
        const double Nxx = correction_tensor[base + 0];
        const double Nxy = correction_tensor[base + 1];
        const double Nxz = correction_tensor[base + 2];
        const double Nyy = correction_tensor[base + 3];
        const double Nyz = correction_tensor[base + 4];
        const double Nzz = correction_tensor[base + 5];

        // Source magnetization: M = φ × Ms × m
        const double phi_s = volume_fraction[si];
        const double Mx = phi_s * Ms * mx[si];
        const double My = phi_s * Ms * my[si];
        const double Mz = phi_s * Ms * mz[si];

        // H_corr = -ΔN · M (symmetric tensor)
        corr_hx -= Nxx * Mx + Nxy * My + Nxz * Mz;
        corr_hy -= Nxy * Mx + Nyy * My + Nyz * Mz;
        corr_hz -= Nxz * Mx + Nyz * My + Nzz * Mz;
    }

    // Add correction to existing demag field (in-place)
    hx[ti] += corr_hx;
    hy[ti] += corr_hy;
    hz[ti] += corr_hz;
}

#endif // FULLMAG_HAS_CUDA
